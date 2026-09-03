'use strict';

/* Beast engine: sessions, frugal context, streaming tool loop.
   v2: token-bazlı bağlam bütçesi (kullanım kalibrasyonlu), paralel tool
   çağrıları, retrieval'lı memory, web araçları, alt-agent ve todo listesi. */

const fs = require('fs');
const path = require('path');
const { chatStream, chatStreamAuto, chatOnce } = require('./llm');
const { chatCompletionsUrl } = require('./config');
const tools = require('./tools');
const research = require('./research');
const agentdefs = require('./agentdefs');
const memory = require('./memory');
const mem0 = require('./mem0');
const skills = require('./skills');
const mcp = require('./mcp');
const { estTokens, estMsgTokens } = require('./tokens');
const log = require('./logger');

const MAX_TURNS = 40;
const SUB_MAX_TURNS = 8;
const HISTORY_TOKEN_BUDGET = 18000;
const TOOL_OUT_KEEP = 1200;
/* read_file sonuçları dosya HAFIZASI'dır: 7200 char'a kırpma modeli aynı
   dosyayı offset offset tekrar okuyor → tur limiti doluyordu. Son okuma
   oturum sonuna kadar tam tutulur (yaklaşık 48k char ≈ orta boy kaynak dosya). */
const READ_OUT_KEEP = 48000;
const USER_MAX = 8000;
/* observe() ile enjekte edilen bağlam mesajlarının öneki — ardışık bağlam
   mesajlarının tek mesajda birleşmesi bu işaretle anlaşılır */
const OBSERVE_MARK = '[BAĞLAM';

/* Oturum notları (geçici hafıza): eski mesajlar bütçeden düşülmeden önce
   önemli noktalar çıkarılır, sistem promptuna küçük blok olarak girer. */
const NOTES_TRIGGER = 14; // #24 son nottan bu yana bu kadar mesaj birikince not güncelle
const NOTES_KEEP_RECENT = 6; // son N mesaj her zaman birebir tutulur
const NOTES_MAX_UNITS = 12; // notlar varken birebir tutulan azami birim sayısı

/* Superyorizyon (#15): CEO paralel ajanları kendi başına bırakmaz.
   Supervisor döngüsü periyodik denetler: takılan/çok uzun süren işte
   ana oturuma [SUPERYORIZON] uyarısı düşer, CEO müdahale eder. */
const SUP_CHECK_MS = 60000; // denetim aralığı
const SUP_STUCK_START_MIN = 3; // en az bu kadar süredir koşuyor ve...
const SUP_IDLE_MIN = 2; // ...bu kadar süredir hiç aktivite yoksa TAKILDI
const SUP_LONG_MIN = 6; // bu kadar süredir koşuyorsa ara kontrol nödü
const SUP_NUDGE_COOLDOWN_MIN = 4; // aynı iş için iki uyarı arası min süre
const BG_FIX_MAX = 2; // paralel ajanın otomatik öz-kurtarma hakkı (bitince CEO devreye girer)
/* SÜRE SINIRI YOK: bg ajanlar dakika bazında kesilmez. Sonsuz döngü koruması
   üç katmanla sağlanır: 1) aktivite yoksa öz-kurtarma + CEO (stuck denetimi),
   2) MAX_TURNS sert tur tavanı, 3) tur limitine yaklaşınca zarif "raporu yaz"
   uyarısı (_run içinde). Dakika bazlı wrap-up KALDIRILDI (BG_WRAP_MIN). */
/* #5 hız: eşzamanlı arka plan LLM turu sınırı — rate-limit yemeden maksimum paralellik */
const BG_MAX_CONCURRENT_DEFAULT = 4;
/* #17 kalıcı başarısızlıkta owner'a anlık uyarı */
const OWNER_FAIL_EMAIL = 'info@algokod.com';
/* bu bayrak çalışma zamanında /notify on|off ile değiştirilir (main köprüsü) */

/* Düşünme (reasoning) seviyeleri — sağlayıcıların GERÇEK değerleri.
   OpenAI (reasoning.effort) ve OpenRouter (reasoning_effort) 2026 itibarıyla:
   none · minimal · low · medium · high · xhigh · max.
   0 (Kapalı) parametre göndermez; 1-5 API'ye reasoning_effort olarak gider.
   Model desteklemiyorsa llm.js tek seferlik parametresiz retry yapar. */
const THINK_LEVELS = [
  { v: 0, label: 'Kapalı', effort: null },
  { v: 1, label: 'Low', effort: 'low' },
  { v: 2, label: 'Medium', effort: 'medium' },
  { v: 3, label: 'High', effort: 'high' },
  { v: 4, label: 'X-High', effort: 'xhigh' },
  { v: 5, label: 'Max', effort: 'max' },
];

/* ---------- opencode motoru port: bağlam bütçesi + compaction + prune ----------
   Kaynak: opencode-dev/packages/opencode/src/session/{overflow,compaction}.ts
   Sabitler birebir alınmıştır (COMPACTION_BUFFER 20k, PRUNE_PROTECT 40k,
   PRUNE_MINIMUM 20k, DOOM_LOOP 3, özet çıktı kırpma 2000 karakter). */
const COMPACTION_BUFFER = 20000; // overflow.ts:8 — özet turu için ayrılan pay
const OUTPUT_TOKEN_MAX = 32000; // transform.ts:18 — çıktı tavanı (rezerv hesabı)
const PRUNE_PROTECT = 40000; // compaction.ts:29 — en yeni araç çıktısı koruması
const PRUNE_MINIMUM = 20000; // compaction.ts:28 — bu kadar kazanç yoksa dokunma
const SUMMARY_OUT_KEEP = 2000; // compaction.ts:30 — özetteki araç çıktısı kırpma
const MIN_PRESERVE_RECENT = 2000; // compaction.ts:32 — korunan kuyruk alt sınırı
const MAX_PRESERVE_RECENT = 15000; // compaction.ts:33 — korunan kuyruk üst sınırı
const DOOM_LOOP_THRESHOLD = 3; // processor.ts:29 — aynı araç+argüman sınırı
const HISTORY_BUDGET_MAX = 80000; // dinamik bütçe tavanı (cache'siz sağlayıcı koruması)

/* Bilinen model ailelerinin bağlam penceresi (models.dev değerleri).
   Eşleşmezse 128k varsayılır — asla gerçek limitin üstünü tahmin etme. */
const MODEL_CONTEXT_TABLE = [
  [/gemini-[23]/i, 1000000],
  [/gpt-5|gpt-4\.1|gpt-4o|o[134]-/i, 400000],
  [/glm-4\.[67]/i, 200000],
  [/claude/i, 200000],
  [/grok-[34]/i, 256000],
  [/kimi/i, 256000],
  [/qwen.*coder/i, 256000],
  [/deepseek|qwen|glm|llama|mistral|minimax/i, 131072],
];
function modelContextOf(sel) {
  const s = String((sel && sel.model) || '');
  for (const [re, ctx] of MODEL_CONTEXT_TABLE) if (re.test(s)) return ctx;
  return 131072;
}

/* Çıktı biçimi kuralı: # ve * karakteri yasak (tüm ajanlar için ortak metin) */
const FORMAT_RULES =
  'ÇIKTI BİÇİMİ (ZORUNLU):\n' +
  '- Yanıtlarında asla # karakteri kullanma (markdown başlık yok).\n' +
  '- Asla * karakteri kullanma (kalın/italik yıldız yok); madde işaretleri için - kullan.\n' +
  '- Renkli sembol/ikon kullanma (renkli kalp, daire vb. yok); normal sarı emoji kullanabilirsin.\n' +
  '- Kod bloklarında dil gereği # veya * gerekiyorsa kod içinde serbest.';

/* Kişi bazlı granül izin seviyeleri: hangi araçlara erişilebilir */
const PERM_TOOL_SETS = {
  all: null, // tüm araçlar (filtre yok)
  web: new Set([
    'web_search', 'http_fetch', 'webfetch', 'deep_search',
    'browser_open', 'browser_read', 'browser_snapshot', 'browser_screenshot',
    'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_select',
    'ocr_read',
  ]),
  read: new Set([
    'web_search', 'http_fetch', 'webfetch', 'deep_search',
    'browser_open', 'browser_read', 'browser_snapshot',
    'list_dir', 'read_file', 'grep', 'glob',
  ]),
  chat: new Set([]), // sadece sohbet
};
const PERM_LEVELS = ['all', 'web', 'read', 'chat'];

/* opencode plan agent portu: PLAN modu PROMPT düzeyinde değil GERÇEKten
   salt-okurdur — yazma/çalıştırma araçları setten düşer, sadece plan çıkar */
const PLAN_ALLOW_TOOLS = new Set([
  'read_file', 'list_dir', 'grep', 'glob',
  'web_search', 'http_fetch', 'webfetch', 'deep_search',
  'browser_open', 'browser_read', 'browser_snapshot',
  'todo_write', 'memory_search', 'kb_search', 'ocr_read',
]);

/* İzin değerini normalize eder: 'all' → ['all'], 'web' → ['web'],
   'web,read' / ['web','read'] → ['web','read'] (sıra PERM_LEVELS'e göre dizilir).
   Geçersiz değerler atılır; hiçbiri kalmazsa boş dizi döner. */
function normalizePerms(p) {
  const arr = Array.isArray(p) ? p.map(String) : String(p == null ? '' : p).split(',');
  const picked = arr.map((s) => s.trim()).filter((s) => PERM_LEVELS.includes(s));
  if (picked.includes('all')) return ['all'];
  return PERM_LEVELS.filter((k) => picked.includes(k));
}

/* CEO modu: ana (konuşma) oturumunun KULLANAMAYACAĞI uygulayıcı araçlar.
   Bunların hepsi run_background ile paralel ajana devredilir — CEO sadece
   konuşur, planlar, emir verir ve takip eder. */
const CEO_EXEC_TOOLS = new Set([
  'run_command', 'read_file', 'write_file', 'edit_file', 'list_dir',
  'python_run',
  'web_search', 'http_fetch', 'webfetch', 'deep_search',
  'browser_open', 'browser_read', 'browser_screenshot', 'browser_snapshot',
  'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_select',
  'computer_look', 'computer_act',
  'ocr_read',
  'delegate_task', // senkron bekler — CEO hep asenkron run_background kullanır
]);

/* Arka plan oturumunun görmemesi gerekenler: alt ajan daha fazla alt dal
   açmasın ve kendini iptal edemesin — işi bitirip rapor yazsın. */
const BG_HIDDEN_TOOLS = new Set(['run_background', 'tasks_list', 'task_status', 'task_cancel']);

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function nowIso() {
  return new Date().toISOString();
}
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/* İnsan-okur 6 haneli oturum kodu — karıştırılan harfler (0,O,1,I,L) yok */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function sessionCode() {
  let s = '';
  for (let i = 0; i < 6; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

/* Yansıma cevabından JSON çıkarımı: düz JSON, ```json fence'li veya
   metin arasına gömülü olabilir. Bozuk girişte null döner. */
function parseReflectionJson(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  /* son } itibarıyla dene, patlarsa kademeli kırp */
  for (let end = t.lastIndexOf('}'); end > start; end = t.lastIndexOf('}', end - 1)) {
    try {
      const obj = JSON.parse(t.slice(start, end + 1));
      if (obj && typeof obj === 'object' && typeof obj.create === 'boolean') return obj;
    } catch {}
  }
  return null;
}

/* ---------- todo yardımcıları ---------- */

function sanitizeTodoItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const it of items.slice(0, 20)) {
    const rawTitle = typeof it === 'string' ? it : it && it.title;
    const title = String(rawTitle ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const status = ['pending', 'active', 'done'].includes(it && it.status) ? it.status : 'pending';
    out.push({ title, status });
  }
  return out;
}


function customChain(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || !p.baseUrl || !p.key) continue;
    for (const m of p.models || []) {
      out.push({
        providerId: 'custom:' + p.id,
        providerName: p.name || 'Custom',
        model: m,
        url: chatCompletionsUrl(p.baseUrl),
        key: p.key,
        costIn: Number(p.priceIn ?? p.price_in) || null,
        costOut: Number(p.priceOut ?? p.price_out) || null,
      });
    }
  }
  return out;
}

class Engine {
  constructor(cfg, opts) {
    this.cfg = cfg || {};
    /* emit sarmalayıcı: paralel ajan olaylarını superyorizyon için izle */
    const userEmit = opts.emit || (() => {});
    this.emit = (ev) => {
      try { this._bgTrack(ev); } catch {}
      userEmit(ev);
    };
    this.sessionsDir = opts.sessionsDir;
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.workspace = opts.workspace || process.env.USERPROFILE || '.';
    this.cfg.baseChain = (this.cfg.chain || []).slice();
    this.cfg.chain = [...this.cfg.baseChain, ...customChain(opts.customProviders)];
    this.sel = this._resolve(opts.modelOverride) || this.cfg.defaultSelection || null;
    this.roleModels = opts.roleModels || {}; // { vision?, terminal?, coding?, subagent? } // providerId::model string
    this.lockdown = !!opts.lockdown; // varsayılan kısıt (oturum bazlı override edilmezse)
    this.sessionPerm = new Map(); // sessionId -> ['web'] | ['web','read'] | ['chat'] (kişi/bot bazlı izin)
    this.sessionTools = new Map(); // sessionId -> Set(araç adları) — bot skill kısıtı
    this.sessionModel = new Map(); // sessionId -> chain entry — bot bazlı model override (setSessionModel)
    this.resolveBot = opts.resolveBot || null; // botId -> bot bilgisi (main enjekte eder)
    /* bot oturumu hafıza köprüsü: botun kendi SOUL/USER/MEMORY dosyaları */
    this.botMemory = opts.botMemory || null;
    /* mem0-native hafıza katmanı: semantik arama + LLM konsolidasyonu (bot başına izole store).
       Ayarlardan kapatılabilir (mem0:false) — kapalıysa klasik keyword hafızası çalışır. */
    this.mem0Enabled = opts.mem0 !== false;
    /* ANA KOD KİLİDİ: agent kendi kaynak koduna dokunamaz (yazma/silme yok, okuma serbest) */
    this.protectedDirs = (opts.protectedDirs || [])
      .map((d) => String(d).replace(/[\\/]+$/, '').toLowerCase().replace(/\//g, '\\'))
      .filter(Boolean);
    this.deletedModels = new Set(opts.deletedModels || []); // kullanıcı tarafından listeden silinenler
    this.fallout = this._normalizeFallout(opts.fallout); // FALLOUT: yedek provider/model/key zinciri
    this.limits = this._normalizeLimits(opts.limits); // provider bazlı max input limiti + bağlam sıkıştırma
    this.crashFile = opts.crashFile || null; // çökme durumu buraya yazılır (kurtarma için)
    this._customProviders = opts.customProviders || [];
    this.cache = new Map();
    this.ctrls = new Map();
    /* /STOP KAPISI: stopAll sonrası SİSTEM tetikli gönderimler (rapor, kick,
       self-heal, cron, izleyici, olay merkezi, bg kuyruk) engellenir — ajan
       kendi kendine yeni sorgu açamaz. Gerçek kullanıcı mesajı (userAction)
       veya /start (clearStop) kapıyı açar. */
    this._stopped = false;
    this.todos = new Map(); // sessionId -> [{title,status}]
    this.tokRatio = 1; // gerçek prompt_tokens ile kalibre edilir
    this._codeIndex = new Map(); // kısa oturum kodu -> session id
    /* yansıma: oturumda 5+ yeni araç çağrısında skill taslağı denenir */
    this.reflection = { enabled: opts.reflection !== false, minTools: 3 };
    /* OTOMATİK SKİLL SİSTEMİ: öğrenilen prosedür taslak onayı beklemeden
       kurulu skill olur; mevcut skillin daha iyisi bulunursa üzerine günceller */
    this.autoSkills = opts.autoSkills !== false;
    this.historyTokenBudget = Number(opts.historyTokenBudget) || HISTORY_TOKEN_BUDGET;
    this.browser = opts.browser || null; // dahili tarayıcı kancaları
    this.fileSend = opts.fileSend || null; // #26 dosya gönderim köprüsü (chat/WA)
    this.notifyOwnerFail = opts.notifyOwnerFail !== false; // #25 hata mail bildirimi (runtime /notify)
    this.reminders = opts.reminders || null; // hatırlatıcı kancası (main enjekte eder)
    this.watchers = opts.watchers || null; // arka plan izleyici köprüsü (main enjekte eder)
    /* onay kapısı: riskli araç öncesi dış onay beklenir ({request} async) */
    this.approvals = opts.approvals || null;
    /* "bir daha sorma" onaylanan araçlar — bu setteki riskli araçlar sorulmaz */
    this.alwaysAllowTools = new Set(Array.isArray(opts.alwaysAllowTools) ? opts.alwaysAllowTools : []);
    /* olay merkezi köprüsü (#4): event_subscribe/list/unsubscribe */
    this.bus = opts.bus || null;
    /* computer use köprüsü (#4 v11): { look(), act(op,args) } — main enjekte eder */
    this.computer = opts.computer || null;
    /* dahili OCR köprüsü: { ocr({image, lang}) } — görsel desteklemeyen modeller için */
    this.ocr = opts.ocr || null;
    this.email = opts.email || null; // e-posta kancaları {list, read, send}
    /* CEO modu: konuşan ana ajan iş YAPMAZ — paralel ajana devreder (varsayılan KAPALI) */
    this.ceoMode = opts.ceoMode === true;
    /* Düşünme (reasoning) seviyesi: 0=Kapalı .. 5=Max (/think veya üst bardan seçilir) */
    this.thinkLevel = Math.min(5, Math.max(0, Math.round(Number(opts.thinkLevel) || 0)));
    /* paralel arka plan ajanları kaydı: bgSessionId -> job */
    this._bgJobs = new Map();
    this._kickTimers = new Map(); // sid -> bekleyen öz-kurtarma gönderim zamanlayıcısı
    /* #5 eşzamanlılık kuyruğu + #18 fan-out grupları */
    this._bgLimit = Math.max(1, Number(opts.bgLimit || process.env.BEAST_BG_LIMIT) || BG_MAX_CONCURRENT_DEFAULT);
    this._bgPendingStart = new Map(); // sid -> ilk görev metni (slot açılınca gönderilir)
    this._bgGroups = new Map(); // groupId -> {parentId,total,results,dead}
    /* silinen oturum işaretleri: rapor/zincir buraya gönderilmez (hayalet oturum yok) */
    this._deletedSessions = new Set();
    /* #17 kalıcı ajan geçmişi: restart sonrası işler + sohbetler kaybolmasın */
    this._bgJobsFile = path.join(this.sessionsDir, 'bg-jobs.json');
    this._loadBgJobsPersisted();
    /* superyorizyon döngüsü: takılan/uzun süren ajanı CEO'ya bildirir */
    this._supTimer = setInterval(() => {
      try { this._supervise(); } catch {}
    }, SUP_CHECK_MS);
    if (this._supTimer.unref) this._supTimer.unref();
    skills.seedIfEmpty();
    agentdefs.seedIfEmpty();
  }

  /* ---------- opencode agent.ts port: özel ajanlar ---------- */

  /* Oturumu bir özel ajana bağla (%APPDATA%\beast\agents\<isim>.md) —
     o oturumun prompt/model/araç/tur limiti ajan tanımından gelir */
  setSessionAgent(sessionId, name) {
    const sid = String(sessionId || '');
    if (!sid) return { ok: false, error: 'oturum yok' };
    const n = String(name || '').trim();
    let s;
    try { s = this._load(sid); } catch { return { ok: false, error: 'oturum açılamadı' }; }
    if (!n || n === 'off' || n === 'kapalı') {
      delete s.agentName;
      this.cache.set(sid, s);
      try {
        fs.appendFileSync(this._file(sid), JSON.stringify({ t: 'agent', name: null, at: nowIso() }) + '\n');
      } catch {}
      return { ok: true, agent: null };
    }
    const def = agentdefs.get(n);
    if (!def) {
      const have = agentdefs.list().map((d) => d.name).join(', ') || '(tanım yok)';
      return { ok: false, error: `ajan bulunamadı: ${n} — tanımlı: ${have}` };
    }
    s.agentName = def.name;
    this.cache.set(sid, s);
    try {
      fs.appendFileSync(this._file(sid), JSON.stringify({ t: 'agent', name: def.name, at: nowIso() }) + '\n');
    } catch {}
    return { ok: true, agent: def.name, model: def.model, tools: def.tools, steps: def.steps };
  }

  /* Oturumun (varsa) özel ajan tanımı — mode filtresiyle: chat oturumunda
     mode:bg ajanı kullanılmaz, bg oturumunda mode:chat kullanılmaz */
  _agentDefFor(session, forBg = false) {
    const n = session && session.agentName;
    if (!n) return null;
    const def = agentdefs.get(n);
    if (!def) return null;
    if (def.mode !== 'all' && def.mode !== (forBg ? 'bg' : 'chat')) return null;
    return def;
  }

  listAgents() {
    return agentdefs.list().map((d) => ({
      name: d.name,
      model: d.model,
      tools: d.tools,
      steps: d.steps,
      mode: d.mode,
    }));
  }

  /* Zinciri yeniden kur: base + custom, silinenleri ayıkla */
  _rebuildChain() {
    const full = [...(this.cfg.baseChain || []), ...customChain(this._customProviders)];
    const key = (c) => c.providerId + '::' + c.model;
    this.cfg.chain = full.filter((c) => !this.deletedModels.has(key(c)));
    // aktif model silindiyse varsayılana dön
    if (this.sel) {
      const k = this.sel.providerId + '::' + this.sel.model;
      const stillThere = full.some((c) => key(c) === k) && !this.deletedModels.has(k);
      if (!stillThere) {
        const defKey = this.cfg.defaultSelection
          ? this.cfg.defaultSelection.providerId + '::' + this.cfg.defaultSelection.model
          : null;
        this.sel =
          defKey && !this.deletedModels.has(defKey)
            ? this.cfg.defaultSelection
            : this.cfg.chain[0] || null;
      }
    }
  }

  setCustomProviders(list) {
    this._customProviders = list || [];
    this._rebuildChain();
  }

  setDeletedModels(list) {
    this.deletedModels = new Set(Array.isArray(list) ? list : []);
    this._rebuildChain();
  }

  setLockdown(v) {
    this.lockdown = !!v;
  }

  /* Kişi/bot bazlı granül izin — WhatsApp oturumları için.
     Tek seviye ('web') ya da çoklu (['web','read']) verilebilir; 'all' kaydı siler. */
  setSessionPerm(sessionId, perm) {
    const id = String(sessionId || '');
    if (!id) return;
    const arr = normalizePerms(perm);
    if (arr.length && !arr.includes('all')) this.sessionPerm.set(id, arr);
    else this.sessionPerm.delete(id);
  }

  /* BOT SİSTEMİ: oturumu bir bota bağla (kalıcı — session dosyasına yazılır) */
  setSessionBot(sessionId, botId) {
    const id = String(sessionId || '');
    if (!id) return;
    let s;
    try { s = this._load(id); } catch { return; }
    const bid = botId ? String(botId) : null;
    if ((s.botId || null) === bid) {
      if (bid) this.cache.get(id).botId = bid;
      return;
    }
    s.botId = bid;
    try {
      fs.appendFileSync(this._file(id), JSON.stringify({ t: 'bot', botId: bid, at: new Date().toISOString() }) + '\n');
    } catch {}
  }

  /* BOT SİSTEMİ: oturumun görabileceği araç seti (bot skill yetkileri) */
  setSessionTools(sessionId, names) {
    const id = String(sessionId || '');
    if (!id) return;
    if (names && names.size) this.sessionTools.set(id, new Set(names));
    else this.sessionTools.delete(id);
  }

  /* BOT MODEL OVERRIDE: her bot farklı model kullanabilir (sel boşsa global seçim).
     sel biçimi: 'providerId::model' — zincirde yoksa sessizce global'e düşer. */
  setSessionModel(sessionId, sel) {
    const id = String(sessionId || '');
    if (!id) return;
    const resolved = sel ? this._resolve(String(sel)) : null;
    if (resolved) this.sessionModel.set(id, resolved);
    else this.sessionModel.delete(id);
  }

  /* Oturumun bağlı olduğu MÜŞTERİ botu (admin/seasız → null → global hafıza) */
  _sessionBotCtx(session) {
    if (!session || !session.botId || typeof this.resolveBot !== 'function') return null;
    const b = this.resolveBot(session.botId);
    return b && !b.admin ? b : null;
  }

  /* Botun sistem promptuna eklenen kimlik/kişilik bloğu (yalnız kendi hafızası) */
  _botSystemBlock(session) {
    if (!session || !session.botId || typeof this.resolveBot !== 'function') return '';
    const bot = this.resolveBot(session.botId);
    if (!bot) return '';
    const isAdmin = !!bot.admin;
    if (isAdmin && !bot.prompt && !(bot.numbers || []).length) return ''; // admin + kişiselleştirme yoksa token harcama
    const lines = [];
    lines.push(`# BOT KİMLİĞİ`);
    lines.push(`Sen "${bot.name}" adlı bağımsız bir botsun (kimlik: ${bot.id})${isAdmin ? ' — yönetici bottasın' : ' — müşteri bottasın'}.`);
    if (bot.prompt) lines.push(`ROL VE GÖREV:\n${bot.prompt}`);
    if (bot.numbers && bot.numbers.length) {
      lines.push(`Sana bağlı WhatsApp numaraları: ${bot.numbers.join(', ')}`);
    }
    lines.push(`Diğer botların hafıza/log/veri/araçlarına erişimin yok; istemek de çalışmaz. Sadece kendi görev alanına odaklan.`);
    lines.push(`Dış tarayıcı yetkin: ${bot.extBrowser ? 'VAR (kullanıcı açıkça isterse kullanabilirsin)' : 'YOK (kullanıcı dış tarayıcı isterse kibarca reddet ve sonucu DAHİLİ tarayıcıda göster)'}.`);
    return lines.join('\n');
  }

  sessionPermFor(sessionId) {
    const p = this.sessionPerm.get(String(sessionId || ''));
    if (p && p.length) return p;
    return this.lockdown ? ['chat'] : ['all'];
  }

  setRoleModels(map) {
    this.roleModels = map || {};
  }

  setCeoMode(v) {
    this.ceoMode = !!v;
  }

  /* ---------- FALLOUT: çökme sonrası otomatik kurtarma zinciri ---------- */

  _normalizeFallout(f) {
    const out = { enabled: !!(f && f.enabled), chain: [] };
    const slots = Array.isArray(f && f.slots) ? f.slots : [];
    const valid = [];
    for (const s of slots) {
      if (!s || typeof s !== 'object') continue;
      const providerId = String(s.providerId || '').trim();
      const model = String(s.model || '').trim();
      const key = String(s.key || '').trim();
      if (!providerId || !model || !key) continue;
      valid.push({
        providerId,
        providerName: String(s.providerName || providerId),
        model,
        key,
      });
    }
    out.chain = valid.slice(0, 10);
    return out;
  }

  setFallout(cfg) {
    this.fallout = this._normalizeFallout(cfg);
  }

  /* ---------- provider bazlı girdi limiti + bağlam sıkıştırma ---------- */

  _normalizeLimits(l) {
    const out = { enabled: false, compress: true, default: 0, perProvider: {} };
    if (!l || typeof l !== 'object') return out;
    out.enabled = !!l.enabled;
    out.compress = l.compress !== false;
    out.default = Math.max(0, Math.round(Number(l.default) || 0));
    const per = l.perProvider && typeof l.perProvider === 'object' ? l.perProvider : {};
    for (const [k, v] of Object.entries(per)) {
      const n = Math.max(0, Math.round(Number(v) || 0));
      if (n > 0 && k) out.perProvider[String(k)] = n;
    }
    return out;
  }

  setLimits(l) {
    this.limits = this._normalizeLimits(l);
  }

  /* Seçili provider için girdi token limiti (0 = limitsiz) */
  _inputLimitFor(sel) {
    if (!this.limits || !this.limits.enabled || !sel) return 0;
    const per = this.limits.perProvider[sel.providerName];
    return per || this.limits.default || 0;
  }

  /* Tek mesajı token bütçesine göre kes: string/array içerik kırpılır,
     tool_calls korunur (araç zinciri bozulmasın) */
  _truncateMsgTokens(m, tokenBudget) {
    if (!m) return m;
    const cap = (txt) =>
      String(txt).slice(0, Math.max(200, tokenBudget * 4)) + '\n…[girdi limiti için kırpıldı]';
    if (typeof m.content === 'string') return { ...m, content: cap(m.content) };
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((p) =>
          p && p.type === 'text' ? { ...p, text: cap(p.text) } : p
        ),
      };
    }
    return m;
  }

  /* Payload limiti aşıyorsa SERT şekilde sıkıştır: system korunur, sondan
     bağlantı pencere alınır, en yeni mesaj tek başına bile taşarsa İÇERİĞİ
     kırpılarak tutulur, hâlâ taşarsa en eskiler atılır. Kullanıcının son
     mesajı asla sessizce düşürülmez. */
  _compressPayload(payload, maxTokens, withNote) {
    if (!Array.isArray(payload) || payload.length < 2) return payload;
    const sys = payload[0];
    const rest = payload.slice(1);
    const cost = (m) => Math.ceil(estMsgTokens(m) * this.tokRatio);
    const sysCost = cost(sys);
    const over = (arr) => arr.reduce((a, m) => a + cost(m), 0) + sysCost > maxTokens;
    if (!over(rest)) return payload;

    const budget = Math.max(0, maxTokens - sysCost - 48);

    /* 1) sondan geriye bağlantı pencere (kesintisiz — kronoloji korunur) */
    const picked = [];
    let used = 0;
    for (let i = rest.length - 1; i >= 0; i--) {
      const c = cost(rest[i]);
      if (used + c > budget) break;
      picked.unshift(rest[i]);
      used += c;
    }

    /* 2) hiçbir mesaj sığmadıysa: EN YENİ mesajı keserek tut */
    if (!picked.length && rest.length) {
      picked.push(this._truncateMsgTokens(rest[rest.length - 1], budget));
    }

    /* 3) kopuk tool yanıtıyla başlama — assistant/tool_calls grubu bozulmasın */
    while (picked.length && picked[0].role === 'tool') picked.shift();
    if (!picked.length) picked.push(this._truncateMsgTokens(rest[rest.length - 1], budget));

    /* 4) hâlâ limite taşıyorsa en eskilerini at */
    while (picked.length > 1) {
      const t = picked.reduce((a, m) => a + cost(m), 0) + sysCost + 48;
      if (t <= maxTokens) break;
      picked.shift();
    }

    if (picked.length >= rest.length && !over(rest)) return payload; // zaten sığıyordu
    if (withNote) {
      const dropped = rest.length - picked.length;
      picked.unshift({
        role: 'system',
        content: `[bağlam sıkıştırıldı: önceki ${dropped} mesaj, ${maxTokens} token girdi limiti nedeniyle çıkarıldı]`,
      });
    }
    return [sys, ...picked];
  }

  /* Fallout kayıtlarını mevcut zincirdeki URL'lerle eşleştir.
     Aynı provider+model farklı key ile birden fazla kez gelebilir. */
  _falloutSelections(exclude) {
    if (!this.fallout.enabled) return [];
    const chain = this.cfg.chain || [];
    const exKey = exclude ? exclude.providerId + '::' + exclude.model + '::' + exclude.key : null;
    const out = [];
    for (const e of this.fallout.chain) {
      const base =
        chain.find((c) => c.providerId === e.providerId && c.model === e.model) ||
        chain.find((c) => c.providerId === e.providerId);
      if (!base) continue; // provider artık kayıtlı değil, atla
      const sel = {
        providerId: base.providerId,
        providerName: base.providerName,
        model: e.model,
        url: base.url,
        key: e.key,
      };
      const k = sel.providerId + '::' + sel.model + '::' + sel.key;
      if (k === exKey) continue; // aktif seçimle birebir aynıysa anlamsız
      out.push(sel);
    }
    return out;
  }

  /* Çökme durumunu diske yaz — hata yakala → durumu kaydet adımı */
  _saveCrash(sessionId, err, phase) {
    if (!this.crashFile) return;
    try {
      fs.writeFileSync(
        this.crashFile,
        JSON.stringify(
          {
            sessionId,
            at: nowIso(),
            phase: phase || 'chat',
            error: String((err && err.message) || err).slice(0, 500),
            model: this.sel ? this.sel.providerId + '::' + this.sel.model : null,
          },
          null,
          2
        )
      );
    } catch {}
  }

  _clearCrash() {
    if (!this.crashFile) return;
    try { fs.unlinkSync(this.crashFile); } catch {}
  }

  /* Bir tur için denenecek seçim listesi: [aktif, ...fallout zinciri] */
  _chatCandidates(sel, wasVision) {
    const list = [];
    const seen = new Set();
    const push = (s) => {
      if (!s || !s.url) return;
      const k = s.providerId + '::' + s.model + '::' + s.key;
      if (!seen.has(k)) { seen.add(k); list.push(s); }
    };
    push(sel);
    if (wasVision) push(this.sel || this.modelFor(null)); // resimsiz modele geri düş
    for (const f of this._falloutSelections(sel)) push(f);
    return list;
  }

  /* Adayları sırayla dene. Hata olursa durumu kaydet, zincirdeki sonrakine geç.
     413/TPM "Requested N" hatası → gerçek token sayısı öğrenilir, tahmin
     kalibre edilir ve aynı model BİR KEZ daha sıkı sıkıştırmayla denenir. */
  async _streamWithFallbacks(session, payload, activeTools, signal, onDelta, sel, wasVision) {
    const cands = this._chatCandidates(sel, wasVision);
    let lastErr = null;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      let retried413 = false;
      try {
        /* provider bazlı girdi limiti: payload aşıyorsa sıkıştırılıp öyle gönderilir.
           Tahmin: mesajlar + TOOLS şemaları (sağlayıcı onları da sayar) + %30 pay.
           Hedef %15 tamponlu — katı sağlayıcılar (TPM/413) için limit aşılmasın */
        let msgs = payload;
        const lim = this._inputLimitFor(c);
        const toolsCost =
          activeTools && activeTools.length
            ? Math.ceil(estTokens(JSON.stringify(activeTools)) * 1.1)
            : 0;
        const rawNow = payload.reduce((a, m) => a + estMsgTokens(m), 0) + toolsCost;
        if (lim > 0) {
          const est = Math.ceil(rawNow * this.tokRatio * 1.3);
          if (est > lim) {
            const before = msgs.length;
            const target = Math.max(600, Math.round(lim * 0.85) - toolsCost);
            msgs = this._compressPayload(payload, target, this.limits.compress);
            if (i === 0) {
              emitSafe(this, session.id, {
                type: 'status',
                status: `bağlam sıkıştırıldı: ~${est} token → limit ${lim} (${c.providerName}, ${before}→${msgs.length} mesaj)`,
              });
            }
            /* system + araçlar tek başına limiti aşıyorsa kullanıcıya net söyle */
            const floor = Math.ceil(
              (estMsgTokens(msgs[0]) + toolsCost) * this.tokRatio
            );
            if (floor > lim) {
              emitSafe(this, session.id, {
                type: 'status',
                status: `⚠ girdi limiti (${lim}) çok düşük: system + araç tanımları tek başına ~${floor} token — limiti en az ${Math.ceil(floor * 1.15)} yap`,
              });
            }
          }
        }
        const res = await chatStreamAuto(
          c,
          {
            messages: msgs,
            tools: activeTools,
            reasoningEffort: this._thinkEffortFor(session),
            /* opencode cache disiplini (transform.ts:1270): oturum-sabit
               önbellek anahtarı — destekleyen sağlayıcıda önek cache'i tutar */
            cacheKey: String(session.id || ''),
          },
          {
            signal,
            onDelta,
            onRetry: (attempt, st) =>
              emitSafe(this, session.id, {
                type: 'status',
                status:
                  st === undefined || st === null
                    ? `bağlantı sorunu — internet dönünce ya da yeniden denemeyle sürer (${attempt}/6)`
                    : `sağlayıcı yanıtsız — tekrar deniyor (${attempt}/3)`,
              }),
          }
        );
        if (i > 0) {
          emitSafe(this, session.id, {
            type: 'status',
            status: `\u2622 FALLOUT devrede: ${c.providerName} · ${c.model} (#${i + 1})`,
          });
        }
        /* maliyet sayacı için hangi adayın cevapladığı taşınır */
        res.meta = {
          providerId: c.providerId,
          providerName: c.providerName,
          model: c.model,
          costIn: Number(c.costIn) || null,
          costOut: Number(c.costOut) || null,
        };
        return res;
      } catch (e) {
        if (e && (e.name === 'AbortError' || (signal && signal.aborted))) throw e;
        lastErr = e;
        const msgStr = String((e && e.message) || '');
        /* 413 TPM: sağlayıcı gerçek istek boyutunu söylüyor → kalibre et,
           aynı modeli yeniden sıkıştırıp BİR KEZ daha dene */
        const m413 = /Requested\s+([\d,]+)/i.exec(msgStr) || (e && e.status === 413 ? [, 0] : null);
        if (m413 && !retried413) {
          retried413 = true;
          const real = Number(String(m413[1] || '0').replace(/,/g, ''));
          if (real > 0) {
            const r = clamp(real / Math.max(1, rawNow), 0.75, 3);
            if (r > this.tokRatio) this.tokRatio = r; /* tahmin yukarı kilitlenir */
            emitSafe(this, session.id, {
              type: 'status',
              status: `⇩ 413 kalibrasyonu: gerçek ${real} token — daha sıkı sıkıştırıp yeniden deneniyor`,
            });
          }
          i--; /* aynı adayı tekrar dene */
          continue;
        }
        const imgIssue =
          wasVision &&
          ([400, 404, 422].includes(e.status) ||
            /\bno endpoints\b/i.test(msgStr) ||
            /\bimage input\b/i.test(msgStr));
        const next = cands[i + 1];
        if (!next) break; // zincir bitti — hatayı yukarı fırlat
        if (imgIssue) {
          emitSafe(this, session.id, {
            type: 'status',
            status: `vision rolünde uyuldu (${c.providerName} · ${c.model}) — resimsiz modeller devre dışı, sıradakiyle devam`,
          });
          continue;
        }
        if (!this.fallout.enabled) break;
        // FALLOUT: hata yakalandı → durumu kaydet → sıradaki adaya geç
        this._saveCrash(session.id, e, 'provider');
        emitSafe(this, session.id, {
          type: 'status',
          status: `\u2622 FALLOUT: ${c.providerName} · ${c.model} çöktü (${e.status || 'ağ'}) → ${next.providerName} · ${next.model} geçiliyor`,
        });
      }
    }
    throw lastErr;
  }

  /* ---------- model selection ---------- */

  _resolve(input) {
    if (!input) return null;
    const chain = this.cfg.chain || [];
    if (typeof input === 'string') {
      const [p, m] = input.split('::');
      return chain.find((c) => c.providerId === p && c.model === m) || null;
    }
    if (input.providerId && input.model) {
      return chain.find((c) => c.providerId === input.providerId && c.model === input.model) || null;
    }
    return null;
  }

  _resolveRole(input) {
    if (!input) return null;
    const chain = this.cfg.chain || [];
    if (typeof input === 'string') {
      const [p, m] = input.split('::');
      return chain.find((c) => c.providerId === p && c.model === m) || null;
    }
    if (input.providerId && input.model) {
      return chain.find((c) => c.providerId === input.providerId && c.model === input.model) || null;
    }
    return null;
  }

  _lastUserHasImage(session) {
    const m = session.messages[session.messages.length - 1];
    if (!m || m.role !== 'user') return false;
    if (!Array.isArray(m.content)) return false;
    return m.content.some((p) => p && p.type === 'image_url');
  }

  modelFor(role) {
    const map = this.roleModels || {};
    const sel = map[role];
    if (!sel) return this.sel;
    return this._resolveRole(sel) || this.sel;
  }

  setModelOverride(sel) {
    this.sel = this._resolve(sel) || this.cfg.defaultSelection || null;
  }

  /* Model refresh: config.yaml'dan gelen taban zinciri tazeler; aktif seçim
     hâlâ mevcutsa korunur, değilse varsayılana döner. */
  refreshBaseChain(cfg) {
    const c = cfg || {};
    this.cfg.baseChain = (c.chain || []).slice();
    if (c.defaultSelection) this.cfg.defaultSelection = c.defaultSelection;
    this._rebuildChain();
    const cur = this.sel ? this.sel.providerId + '::' + this.sel.model : null;
    this.sel = (cur && this._resolve(cur)) || this.cfg.defaultSelection || this.sel || null;
  }

  setWorkspace(dir) {
    this.workspace = dir;
  }

  /* Oturum bazlı çalışma klasörü — Beast Code gibi özel oturumlar sol paneldeki
     klasörde çalışabilsin diye (sess.workspace yoksa global workspace) */
  _sessionWorkspace(sessionId) {
    const s = sessionId ? this.cache.get(String(sessionId)) : null;
    return (s && s.workspace) || this.workspace;
  }

  setThinkLevel(v) {
    this.thinkLevel = Math.min(5, Math.max(0, Math.round(Number(v) || 0)));
    return this.thinkLevel;
  }

  _thinkEffort() {
    const lv = THINK_LEVELS[this.thinkLevel] || THINK_LEVELS[0];
    return lv.effort || null;
  }

  /* Oturum bazlı düşünme çabası: Beast Code hız modunda en fazla 'low' */
  _thinkEffortFor(session) {
    const e = this._thinkEffort();
    if (!session || !session.bcCode) return e;
    return e ? 'low' : null;
  }

  _thinkLabel() {
    const lv = THINK_LEVELS[this.thinkLevel] || THINK_LEVELS[0];
    return lv.label;
  }

  publicState() {
    return {
      workspace: this.workspace,
      workspaceName: path.basename(this.workspace) || this.workspace,
      hasModel: !!this.sel,
      activeModel: this.sel
        ? { sel: this.sel.providerId + '::' + this.sel.model, providerName: this.sel.providerName, model: this.sel.model }
        : null,
      models: (this.cfg.chain || []).map((c) => ({
        sel: c.providerId + '::' + c.model,
        providerName: c.providerName,
        model: c.model,
      })),
      roleModels: this.roleModels || {},
      deletedModels: [...this.deletedModels],
      busy: [...this.ctrls.keys()],
      thinkLevel: this.thinkLevel,
    };
  }

  /* #23 Fallout: providerId -> çözülmüş API key (chain zaten .env/custom'dan
     anahtarları çözmüş durumda — tek doğruluk kaynağı budur) */
  providerKeyMap() {
    const map = {};
    for (const c of this.cfg.chain || []) {
      if (c && c.providerId && c.key && !map[c.providerId]) map[c.providerId] = c.key;
    }
    return map;
  }

  /* ---------- sessions ---------- */

  _file(id) {
    if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error('bad session id');
    return path.join(this.sessionsDir, id + '.jsonl');
  }

  _append(session, msg) {
    fs.appendFileSync(this._file(session.id), JSON.stringify({ t: 'msg', ...msg }) + '\n');
    session.updatedAt = nowIso();
    if (session.code) this._codeIndex.set(session.code, session.id);
  }

  /* Oturum dosyasındaki son 'msg' satırını (user) güncel içerikle değiştir —
     yanıtsız kalmış user mesajıyla yeni mesaj birleştirildiğinde kullanılır */
  _rewriteLastMsg(id, content, attachments) {
    try {
      const file = this._file(String(id));
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        let r;
        try { r = JSON.parse(lines[i]); } catch { continue; }
        if (r.t === 'msg' && r.role === 'user') {
          const out = { t: 'msg', role: 'user', content: String(content || '') };
          if (Array.isArray(attachments) && attachments.length) out.attachments = attachments;
          lines[i] = JSON.stringify(out);
          break;
        }
      }
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, lines.join('\n'));
      fs.renameSync(tmp, file);
    } catch {}
  }

  /* GÖRSEL DÖNGÜSÜ KORUMASI: görüntü desteklemeyen modele görsel ulaşırsa
     sağlayıcı 400/404 döndürür; görsel oturum geçmişinde kaldığı için sonraki
     HER mesaj aynı hatayla ölür (sonsuz hata döngüsü). Bu metod geçmişteki tüm
     image_url parçalarını metin notuyla değiştirir — hem bellekte hem jsonl'de.
     Döndürür: kaldırılan görsel sayısı */
  _sanitizeSessionImages(session) {
    const NOTE = '[görsel gösterilemedi — bu model görüntü girişini desteklemiyor]';
    const hasImg = (c) => Array.isArray(c) && c.some((p) => p && p.type === 'image_url');
    const clean = (content) => {
      const parts = [];
      for (const p of content) {
        if (p && p.type === 'image_url') continue;
        parts.push(p);
      }
      if (!parts.some((p) => p && p.type === 'text' && String(p.text || '').trim())) {
        parts.push({ type: 'text', text: NOTE });
      }
      return parts;
    };
    let removed = 0;
    for (const m of session.messages) {
      if (hasImg(m.content)) {
        removed += m.content.filter((p) => p && p.type === 'image_url').length;
        m.content = clean(m.content);
      }
    }
    if (!removed) return 0;
    try {
      const file = this._file(session.id);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        let r;
        try { r = JSON.parse(lines[i]); } catch { continue; }
        if (r.t === 'msg' && r.role === 'user' && hasImg(r.content)) {
          lines[i] = JSON.stringify({ t: 'msg', role: 'user', content: clean(r.content) });
        }
      }
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, lines.join('\n'));
      fs.renameSync(tmp, file);
    } catch {}
    return removed;
  }

  _load(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const file = this._file(id);
    const session = { id, messages: [], createdAt: nowIso(), updatedAt: nowIso() };
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.t === 'meta') {
            session.createdAt = rec.createdAt || session.createdAt;
            session.code = rec.code || session.code;
          } else if (rec.t === 'meta2') {
            /* #17 paralel ajan oturumu: temiz başlık + işaret */
            session.bgTitle = String(rec.title || '');
            session.bgOf = String(rec.bgOf || '');
          } else if (rec.t === 'bot') {
            /* bot sistemi: oturum hangi bota bağlı */
            session.botId = rec.botId || null;
          } else if (rec.t === 'todo') {
            session.todos = sanitizeTodoItems(rec.items);
          } else if (rec.t === 'notes') {
            session.notes = String(rec.text || '');
            session.notesAt = Number(rec.at) || 0;
          } else if (rec.t === 'summary') {
            /* opencode compaction: konuşma özeti — birebir geçmişin yerine geçmez,
               payload'da system'den sonra sabit user mesajı olarak girer */
            if (rec.text) session.summary = String(rec.text);
          } else if (rec.t === 'agent') {
            /* opencode agent port: oturumun bağlı olduğu özel ajan */
            if (rec.name) session.agentName = String(rec.name);
          } else if (rec.t === 'botdm') {
            /* botlar arası DM oturumu — admin izleyebilir, sidebar'da görünmez */
            session.isBotDm = true;
            session.dmA = String(rec.a || '');
            session.dmB = String(rec.b || '');
          } else if (rec.t === 'msg') {
            delete rec.t;
            session.messages.push(rec);
          }
        } catch {}
      }
    } catch {}
    if (!session.code) session.code = sessionCode();
    this._codeIndex.set(session.code, id);
    if (session.todos && session.todos.length) this.todos.set(id, session.todos);
    this.cache.set(id, session);
    return session;
  }

  /* Kısa okunabilir oturum kodu → benzersiz çakışmasız üretim */
  _newCode() {
    for (;;) {
      const c = sessionCode();
      if (!this._codeIndex.has(c)) return c;
    }
  }

  findByCode(code) {
    const k = String(code || '').trim().toUpperCase();
    if (!k) return null;
    let id = this._codeIndex.get(k) || null;
    if (id && this.cache.has(id)) return this._view(this.cache.get(id));
    /* hızlı yol bulamadıysa dosyaları tara */
    for (const v of this.listSessions()) {
      if (v.code === k) return v;
    }
    return null;
  }

  _appendNotes(session) {
    fs.appendFileSync(
      this._file(session.id),
      JSON.stringify({ t: 'notes', text: session.notes || '', at: session.notesAt || 0 }) + '\n'
    );
  }

  /* Oturum dosyası birikince sıkıştırır: meta + son mesajlar + en güncel
     not + todos kalır, eski satırlar düşer. Atomik yazım. */
  _maybeCompact(id) {
    try {
      const file = this._file(String(id));
      const st = fs.statSync(file);
      if (st.size < 512 * 1024) return; // 512 KB altında dokunma
      const s = this._load(String(id));
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      const keepFrom = Math.max(0, s.messages.length - NOTES_KEEP_RECENT * 3);
      const lastNotesLine =
        [...lines].reverse().find((l) => {
          try { return JSON.parse(l).t === 'notes'; } catch { return false; }
        }) || '';
      const out = [];
      for (const l of lines) {
        let r;
        try { r = JSON.parse(l); } catch { continue; }
        if (r.t === 'meta') out.push(JSON.stringify({ t: 'meta', id: s.id, code: s.code, createdAt: s.createdAt }));
        else if (r.t === 'meta2' || r.t === 'bot' || r.t === 'todo') out.push(l);
      }
      if (lastNotesLine) out.push(lastNotesLine);
      /* korunan pencere: son N mesaj */
      const msgLines = lines.filter((l) => {
        try { return JSON.parse(l).t === 'msg'; } catch { return false; }
      });
      out.push(...msgLines.slice(keepFrom));
      out.push(JSON.stringify({ t: 'compacted', at: nowIso(), droppedBefore: keepFrom }));
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, out.join('\n') + '\n');
      fs.renameSync(tmp, file);
    } catch {}
  }

  /* Not tutan oturumları listele (ayarlar ekranı için) — oturum koduyla eşli */
  listNotes() {
    const out = [];
    for (const v of this.listSessions()) {
      const s = this._load(v.id);
      if (s && s.notes && String(s.notes).trim()) {
        out.push({ id: s.id, code: s.code || '', title: v.title, updatedAt: v.updatedAt, count: v.count, notes: String(s.notes), botId: s.botId || '' });
      }
    }
    return out;
  }

  /* Bir oturumun notlarını sil — dosyadaki notes satırları temizlenir */
  clearNotes(id) {
    const sid = String(id || '');
    let s;
    try { s = this._load(sid); } catch { return false; }
    if (!s || !s.notes) return false;
    delete s.notes;
    delete s.notesAt;
    try {
      const file = this._file(sid);
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      const kept = lines.filter((l) => {
        try { return JSON.parse(l).t !== 'notes'; } catch { return true; }
      });
      fs.writeFileSync(file, kept.join('\n') + '\n');
    } catch {}
    return true;
  }

  _view(s) {
    const firstUser = s.messages.find((m) => m.role === 'user');
    const isBg = !!s.bgTitle;
    const job = isBg ? this._bgJobs.get(String(s.id)) : null;
    /* Başlık: ilk user mesajının METNİ. Ekli mesajlarda content dizidir —
       String() doğrudan "[object Object]" üretir; text parçaları birleştirilir.
       WhatsApp/Telegram transport etiketi ([WhatsApp — gönderen: ...]) başlıkta
       gürültüdür — kırpılır, gerçek konuşma metni kalsın. */
    let title = '';
    if (!isBg && firstUser) {
      let t = Array.isArray(firstUser.content)
        ? firstUser.content.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join(' ')
        : String(firstUser.content || '');
      t = t
        .replace(/^\s*\[(WhatsApp|Telegram)[^\]]*\]\s*/i, '')
        .replace(/\[görsel gösterilemedi[^\]]*\]/gi, '')
        .replace(/\[(resim eki alındı|belge alındı[^\]]*|sesli mesaj[^\]]*)\]/gi, '')
        .trim();
      title = (t.split('\n')[0] || '').replace(/\s+/g, ' ').trim().slice(0, 48);
    }
    return {
      id: s.id,
      code: s.code || '',
      botId: s.botId || null,
      title: (isBg ? s.bgTitle : title) || 'Yeni Sohbet',
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      count: s.messages.length,
      isBg,
      isBotDm: !!s.isBotDm,
      bgStatus: isBg ? (job ? job.status : null) : null,
    };
  }

  /* #17 paralel ajan oturumları sol sohbet listesine KARIŞMAZ;
     geçmişleri sağdaki Paralel Ajanlar panelinde izlenir */
  listSessions() {
    let files = [];
    try {
      files = fs.readdirSync(this.sessionsDir).filter((f) => f.endsWith('.jsonl'));
    } catch {}
    const out = [];
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, '');
      const v = this._view(this._load(id));
      if (v.isBg) continue;
      if (v.isBotDm) continue; // botlar arası DM — yalnız admin DM Log ekranında
      out.push(v);
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out.slice(0, 100);
  }

  createSession() {
    const id = uid();
    const code = this._newCode();
    const session = { id, code, messages: [], createdAt: nowIso(), updatedAt: nowIso() };
    fs.writeFileSync(
      this._file(id),
      JSON.stringify({ t: 'meta', id, code, createdAt: session.createdAt }) + '\n'
    );
    this._codeIndex.set(code, id);
    this.cache.set(id, session);
    return this._view(session);
  }

  /* #25 /clear: oturumun mesaj geçmişini temizler; kod/meta/todolar korunur.
     Notlar da sıfırlanır — taze başlangıç. */
  clearMessages(id) {
    const sid = String(id || '');
    let s;
    try { s = this._load(sid); } catch { return false; }
    if (!s) return false;
    try {
      const file = this._file(sid);
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      const kept = lines.filter((l) => {
        try {
          const r = JSON.parse(l);
          return r.t === 'meta' || r.t === 'meta2' || r.t === 'bot' || r.t === 'todo';
        } catch { return false; }
      });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, kept.join('\n') + '\n');
      fs.renameSync(tmp, file);
    } catch {}
    s.messages = [];
    delete s.notes;
    delete s.notesAt;
    delete s.summary; // özet de sıfırlanır — taze başlangıç
    this.todos.set(sid, []);
    this.emit({ type: 'sessions' });
    return true;
  }

  /* "Nerede kaldım?" (#5): en son aktif oturumun özeti + yarım kalan todolar.
     Saf toplama — gönderim/otomatik-devam main'e aittir. */  lastWhereWasI() {
    let latest = null;
    for (const v of this.listSessions()) {
      if (!latest || String(v.updatedAt) > String(latest.updatedAt)) latest = v;
    }
    if (!latest) return null;
    const s = this._load(latest.id);
    const todos = s.todos || this.todos.get(s.id) || [];
    /* son kullanıcı mesajı + son asistan cevabı */
    let lastUser = '';
    let lastAssistant = '';
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const m = s.messages[i];
      if (!lastUser && m.role === 'user') {
        lastUser = typeof m.content === 'string' ? m.content : '(görsel/ek)';
      }
      if (!lastAssistant && m.role === 'assistant' && m.content && !m.tool_calls) {
        lastAssistant = typeof m.content === 'string' ? m.content : '';
      }
      if (lastUser && lastAssistant) break;
    }
    const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '?';
    return {
      sessionId: s.id,
      code: s.code || '',
      title: latest.title,
      updatedAt: when,
      msgCount: s.messages.length,
      lastUser: String(lastUser).slice(0, 160),
      lastAssistant: String(lastAssistant).replace(/\s+/g, ' ').slice(0, 200),
      pendingTodos: todos.filter((t) => t.status !== 'done').slice(0, 8),
      doneCount: todos.filter((t) => t.status === 'done').length,
    };
  }

  openSession(id) {
    const s = this._load(String(id));
    return { ...this._view(s), messages: s.messages, todos: s.todos || this.todos.get(s.id) || [] };
  }

  deleteSession(id) {
    const sid = String(id || '');
    try {
      const c = this.ctrls.get(sid);
      if (c) {
        this._abortReasons = this._abortReasons || new Map();
        this._abortReasons.set(sid, 'oturum silindiği için tur iptal edildi');
        c.abort();
        this.ctrls.delete(sid);
      }
      /* #17 silinecek ajanın bekleyen öz-kurtarma zamanlayıcısını iptal et —
         yoksa send() oturum dosyasını yeniden yaratıp işi diriltir */
      if (this._bgJobs.has(String(id))) {
        const j = this._bgJobs.get(String(id));
        j.revive = false;
        j.status = 'aborted';
        j.error = j.error || 'oturum silindi — paralel ajan iptal edildi';
        this._clearKicks(id);
      }
      fs.unlinkSync(this._file(String(id)));
    } catch {}
    try { fs.rmSync(this._file(String(id)) + '.tmp', { force: true }); } catch {}
    const cached = this.cache.get(String(id));
    if (cached && cached.code) this._codeIndex.delete(cached.code);
    this.cache.delete(String(id));
    this.todos.delete(String(id));
    this.sessionPerm.delete(String(id));
    this.sessionTools.delete(String(id));
    this._errCount && this._errCount.delete(String(id));
    /* paralel ajan oturumuysa iş kaydını da düşür — hayalet kayıt kalmasın */
    if (this._bgJobs.has(String(id))) {
      this._bgJobs.delete(String(id));
      this._saveBgJobs();
      this._bgEmit();
    }
    /* silinme işareti: bekleyen raporlar/rapor zinciri bu oturuma ASLA düşmez */
    if (this._deletedSessions) {
      this._deletedSessions.add(sid);
      if (this._deletedSessions.size > 300) {
        const first = this._deletedSessions.values().next().value;
        if (first !== undefined) this._deletedSessions.delete(first);
      }
    }
    this.emit({ type: 'sessions' });
    return true;
  }

  /* ---------- prompt assembly (the frugal part) ---------- */

  /* opencode instruction.ts port: workspace'teki proje talimatları (AGENTS.md,
     CLAUDE.md, CONTEXT.md) Beast Code system promptuna girer. Oturum başına
     BİR KEZ okunup session'da saklanır — system promptu epoch boyunca sabit
     kalır, önek cache bozulmaz (dosya sonradan değişse bile). */
  _projectInstructions(session) {
    if (!session) return '';
    if (session._projCtx !== undefined) return session._projCtx;
    let out = '';
    try {
      const ws = (session && session.workspace) || this.workspace;
      for (const name of ['AGENTS.md', 'CLAUDE.md', 'CONTEXT.md']) {
        let txt = '';
        try { txt = fs.readFileSync(path.join(ws, name), 'utf8'); } catch {}
        txt = String(txt || '').trim();
        if (!txt) continue;
        out += (out ? '\n\n' : '') + `--- ${name} ---\n` + txt.slice(0, 6000);
        if (out.length >= 8000) break;
      }
    } catch {}
    out = out.slice(0, 9000);
    session._projCtx = out;
    return out;
  }

  /* Beast Code (IDE paneli): VS Code hızında çalışsın diye SECMET prompt.
     OpenCode kodlama disiplini gömülü: bağlam → plan → küçük diff → doğrula.
     GENEL AMAÇLI kodlama ajanı — web/mobil gibi tek stack'e zorlanmaz; stack'i
     projenin kendi dosyaları belirler. Hafıza embedding araması, skills
     taraması, kişilik/kural blokları YOK — prompt kısa kalır → ilk token
     hızlı, tur maliyeti düşük. */
  buildBcSystem(session) {
    const nowD = new Date();
    const localDate = nowD.toLocaleDateString('tr-TR');
    /* önek-cache disiplini (opencode Context Epoch): dakika yerine saat —
       system prompt her dakika değişse sağlayıcı önbelleği sürekli bozulur */
    const localTime = String(nowD.getHours()).padStart(2, '0') + ':00';
    const mode = String((session && session.bcMode) || 'auto').toLowerCase();
    const modeBlock =
      mode === 'plan'
        ? 'ÇALIŞMA MODU: PLAN 🔍 — dosyaları oku/incele (read_file, list_dir), KOD YAZMA; mevcut yapıyı özetle ve adım adım UYGULAMA PLANI ver (hangi dosya, ne değişecek, nasıl doğrulanır). Kullanıcı /build deyince plan uygulanır.'
        : mode === 'build'
          ? 'ÇALIŞMA MODU: BUILD 🛠 — son planı SOHBETTEKİ bağlamdan al ve UYGULA: dosyaları düzenle, komutları çalıştır, doğrula. Yeni plan açma; en fazla 1 cümlelik yön gösterimi + uygulama.'
          : 'ÇALIŞMA MODU: OTOMATİK ⚡ — önce 2-4 satırlık mini plan (todo_write), sonra hemen uygula + doğrula.';
    const proj = this._projectInstructions(session);
    return (
      'Sen BEAST CODE\u2019sun — IDE panelinde çalışan, OpenCode disiplinli hızlı bir kodlama ajanı. VS Code gibi çevik ol.\n' +
      'GENEL AMAÇLI KODLAMA AJANISIN — tek bir proje türüne sınırlı değilsin: web, backend/API, mobil, masaüstü, CLI, kütüphane, script, oyun, veri, DevOps, gömülü… İstenen neyse o. İstenmeyen şeyi (ör. site değilken site) kendiliğinden ÜRETME.\n' +
      `Çalışma klasörü: ${(session && session.workspace) || this.workspace}\n` +
      `Yerel zaman: ${localDate} ${localTime}\n` +
      `${modeBlock}\n` +
      'STACK TESPİTİ: işe başlarken workspace\u2019i tanı — package.json, go.mod, Cargo.toml, requirements.txt/pyproject.toml, pom.xml/build.gradle, *.csproj, pubspec.yaml, Gemfile, composer.json vb. işaret dosyalarına bak (list_dir + glob). Dili, framework\u2019ü, konvansiyonları ve build/test/run komutlarını PROJE belirler; her işte aynı teknolojiye itme, mevcut stack\u2019e uy.\n' +
      (proj
        ? '# PROJE TALİMATLARI (workspace AGENTS/CLAUDE/CONTEXT dosyalarından — daima uy)\n' + proj + '\n'
        : '') +
      'WORKFLOW (her işte bu sıra):\n' +
      '1) BAĞLAM: değiştirmeden önce ilgili dosyaları OKU — read_file satır numaralı döner (N: içerik); büyük dosyada devamını offset parametresiyle oku, ASLA baştan okuma; bir dosyayı aynı oturumda BİR KEZ okumak yeter — okuduğun içerik oturum SONUNA KADAR bağlamda KALIR, edit yaptıktan sonra dosyayı yeniden okuma YASAK (güncel durum = son okuma + kendi editlerin). İçerik araması için grep (regex), dosya adı için glob kullan; varsayım yapma, mevcut stili/konvansiyonu takip et.\n' +
      '2) PLAN: 2+ adımlı işlerde İLK EYLEM todo_write olsun (2-6 madde); her adım bitince status:"done" ile GÜNCELLE — liste bitene kadar iş bitmiş sayılmaz.\n' +
      '3) EDİT: VAR OLAN dosyada önce edit_file kullan (old_string/new_string ile yalnız ilgili bölümü değiştir; birden çok eşleşme varsa bağlam ekle ya da replace_all); write_file yalnız YENİ dosya ya da tam yeniden yazım için. Dosya işlemleri için ÖZEL ARAÇLARI kullan (edit_file/write_file/read_file/grep/glob); run_command terminal işlerindir (build, git, kurulum, paket) — dosya düzenlemeyi komut/scripte yedirme, edit_file ile yap. İlgisiz yeniden biçimleme/kayıp boşluk değişikliği YAPMA. edit_file/write_file sonucu additions/deletions döner ve değişiklik diske ANINDA uygulanır — doğrulamak için dosyayı TEKRAR OKUMA YASAK; sonraki editi önceki okuduğun içerik + kendi değişikliklerin üzerinden zincirle.\n' +
      '4) DOĞRULA: edit sonrası projenin KENDİ komutlarıyla derle/test/lint çalıştır (run_command: npm test, go test ./..., cargo test, pytest, mvn test vb. — hangisi geçerliyse); hata varsa DÜZELT ve TEKRAR dene (en fazla 2 doğrulama turu) — kırmızı bırakma. Doğrulama read_file ile DEĞİL run_command ile yapılır.\n' +
      '5) RAPOR: 1-3 satır — ne değişti + doğrulama sonucu (ör. "npm test ✓ 154/154"). Uzun açıklama yok.\n' +
      'ÖNİZLEME: panel Preview\u2019da dahili statik sunucuyu KENDİSİ yönetir — statik HTML işinde sunucu başlatma (python -m http.server vs. GEREKMEZ); index.html\u2019i hazır bırak, kullanıcı Preview\u2019a basınca canlı açılır. Yalnız gerçek dev-server gerektiren projelerde (React/Vite/Next/Expo vb.) kendi sunucunu BLOKLAMADAN arka planda başlat ve çalışan adresi (http://localhost:PORT) raporda yaz. file:// protokolü ASLA kullanılmaz.\n' +
      'HIZ KURALLARI:\n' +
      '- VAR OLAN dosyayı edit_file ile değiştir, YENİ dosyayı write_file ile yarat; basit dosya oluşturma/düzenleme için Python scripti yazma; python_run yalnız gerçek hesap/veri işleme gerekiyorsa.\n' +
      '- Bağımsız araç çağrılarını AYNI TURDA paralel ver (birden çok read_file tek turda).\n' +
      '- Dosyayı kullanıcı söylememişse list_dir ile yapıyı görüp kendin karar ver.\n' +
      '- Run_command PowerShell ortamında çalışır (Windows): KALICI oturum — cd ve $env değişkenleri çağrılar arasında korunur; büyük çıktıda tam çıktı geçici dosyaya düşer, read_file ile oku. shell:"bash" verirsen git-bash ile bash sözdizimi koşar.\n' +
      '- Soru sorma, sohbet etme; uygulayıp özetle. Kullanıcı /plan /build /auto ile modu değiştirir.\n' +
      FORMAT_RULES
    );
  }

  /* Beast Studio (video paneli): video YAPMA ve DÜZENLEME ajanı. Workspace'teki
     her şey video proje malzemesi olarak görülür (ham görüntü, ses, görsel,
     altyazı, çıktı). Medya işi ffprobe + ffmpeg ile yürütür; ikisi de app ile
     birlikte gelir (ffmpeg-static). Beast Code disiplini korunur: plan →
     uygula → doğrula. */
  buildStudioSystem(session) {
    const nowD = new Date();
    const localDate = nowD.toLocaleDateString('tr-TR');
    const localTime = String(nowD.getHours()).padStart(2, '0') + ':00';
    const mode = String((session && session.bcMode) || 'auto').toLowerCase();
    const modeBlock =
      mode === 'plan'
        ? 'ÇALIŞMA MODU: PLAN 🔍 — malzemeyi İNCELE (list_dir + ffprobe), KOMUT ÇALIŞTIRMA; adım adım MONTAJ PLANI ver (hangi dosya, hangi işlem, çıktı adı, nasıl doğrulanır). Kullanıcı /build deyince plan uygulanır.'
        : mode === 'build'
          ? 'ÇALIŞMA MODU: BUILD 🛠 — son montaj planını SOHBETTEKİ bağlamdan al ve UYGULA: ffmpeg işlerini çalıştır, çıktıları doğrula. Yeni plan açma; en fazla 1 cümlelik yön gösterimi + uygulama.'
          : 'ÇALIŞMA MODU: OTOMATİK ⚡ — önce 2-4 satırlık mini plan (todo_write), sonra hemen uygula + doğrula.';
    let ffPath = '';
    try { ffPath = String(require('ffmpeg-static') || ''); } catch {}
    let ffprobeHint = '';
    if (ffPath) {
      const ffDir = path.dirname(ffPath);
      ffprobeHint =
        `Medya araçları KURULU, kurmaya ÇALIŞMA:\n` +
        `- ffmpeg: "${ffPath}"\n` +
        `- ffprobe: "${path.join(ffDir, 'ffprobe' + (process.platform === 'win32' ? '.exe' : ''))}" (yoksa ffmpeg -i de meta verir)\n` +
        `Bunları run_command ile TAM YOLLA çağır (PATH'te değiller). Boşluklu yolları tırnakla.\n`;
    }
    const proj = this._projectInstructions(session);
    return (
      'Sen BEAST STUDIO\u2019sun — video YAPMA ve DÜZENLEME ajanı. Sol paneldeki klasör senin stüdyondur.\n' +
      'GÖREV ALANI: video üretme ve düzenleme — kesme/birleştirme (montaj), trim, crop, ölçek, döndürme, hız (slowmo/timelapse), geçiş efektleri, filtre/renk, altyazı basma (srt/ass burn-in), ses ekleme/değiştirme/ses seviyesi/ses temizleme, GIF, thumbnail, format dönüşümü — kısaca kullanıcının istediği HER türlü video/ses işi. Kod yazma projesi DEĞİLDİR — kod istenirse kullanıcı Beast Code\u2019a yönlendirilir.\n' +
      `Stüdyo klasörü: ${(session && session.workspace) || this.workspace}\n` +
      `Yerel zaman: ${localDate} ${localTime}\n` +
      `${modeBlock}\n` +
      'KLASÖR FARKINDALIĞI: çalışma klasöründeki HER DOSYA video proje MALZEMESİDİR — ham görüntüler, sesler, müzikler, görseller, altyazılar, önceki çıktılar. İşe başlarken list_dir ile malzemeyi gör; isimden tür UYDURMA, ffprobe ile doğrula. Yeni klasör seçilirse (panelde Klasör seç) yeni proje başlar — oradaki malzemeye göre çalış.\n' +
      ffprobeHint +
      'MEDYA ANALİZİ: video/ses dosyalarını read_file ile OKUMA (ikili dosya) — ffprobe ile süre, codec, çözünürlük, fps, ses kanalı, bit hızı bilgisini al: ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate,channels -of default=noprint_wrappers=1 "dosya"\n' +
      'FFMPEG KURALLARI:\n' +
      '- Çıktıya HER ZAMAN -y ekle (üstüne yaz). Uzun işlerde stderr büyük olur; gerekiyorsa çıktıyı dosyaya düşürüp son 20 satırı oku.\n' +
      '- Varsayılan kodlama: video libx264 + crf 20, ses aac 192k, mp4 kapsayıcı; kullanıcı kalite belirtirse crf 16-18.\n' +
      '- Kesme: -ss BAŞ -to BİT (girişten önce hızlı arama için -ss\u2019yi -i\u2019den ÖNCE koy, yeniden kodlamalı kesin işlerde sonra da olur) -i girdi -t SÜRE.\n' +
      '- Birleştirme: uyumsuz kaynaklarda concat demuxer yerine filtre (concat=n=...:v=1:a=1) kullan veya önce hepsini aynı çözünürlük/fps/codece normalize et.\n' +
      '- Altyazı: subtitles="dosya.srt":force_style\u2026 (Windows yolunda escaping: C\\:/…); ses: -i ses -map 0:v -map 1:a -c:v copy -shortest.\n' +
      'ÇIKTI DİSİPLİNİ: üretilen her dosyayı çalışma klasörü içindeki "output" klasörüne yaz (önce mkdir); dosya adları ASCII, boşluksuz ve anlamlı olsun (ör. output\/kesme-01.mp4). Ara dosyaları da output\/tmp altında tut, iş bitince temizle.\n' +
      'WORKFLOW (her işte bu sıra):\n' +
      '1) BAĞLAM: list_dir + ffprobe ile malzeme envanteri (paralel çağrılar TEK turda).\n' +
      '2) PLAN: 2+ adımlı işlerde İLK EYLEM todo_write olsun (2-6 madde); her adım bitince status:"done" ile GÜNCELLE.\n' +
      '3) UYGULA: her ffmpeg işini run_command ile adım adım çalıştır; büyük işi tek dev komuta gömme — kırıp zincirle.\n' +
      '4) DOĞRULA: her adımda çıktı gerçekten oluştu mu — ffprobe ile süre/codec kontrolü ETMEDEN "tamam" DEME; hata varsa komutu düzeltip en fazla 2 kez TEKRAR DENE.\n' +
      '5) RAPOR: 1-3 satır — üretilen dosya(lar) + süre/boyut + ne yapıldı. Dosya yolunu MUTLAKA yaz (kullanıcı panelde oynatır).\n' +
      'HIZ KURALLARI:\n' +
      '- Bağımsız ffprobe/ffmpeg çağrılarını AYNI TURDA paralel ver.\n' +
      '- run_command PowerShell ortamında çalışır (Windows): KALICI oturum — cd korunur.\n' +
      '- Görüntü üretimi/thumbnail: ffmpeg -ss ortası -i girdi -frames:v 1.\n' +
      '- Soru sorma; malzemeden emin olamadığında ffprobe\u2019la kendin çöz. Kullanıcı /plan /build /auto ile modu değiştirir.\n' +
      (proj ? '# PROJE TALİMATLARI (workspace AGENTS/CLAUDE/CONTEXT dosyalarından — daima uy)\n' + proj + '\n' : '') +
      FORMAT_RULES
    );
  }

  async buildSystem(queryText, session) {
    /* BOT OTURUMU: non-admin bota bağlıysa global Beast hafızası HIÇ girmez —
       o botun kendi SOUL/USER/MEMORY dosyaları kullanılır (tam izolasyon) */
    const bctx = this._sessionBotCtx(session);
    let mem, relevantMemory, rules;
    if (bctx && this.botMemory) {
      mem = {
        soul: this.botMemory.read(bctx.id, 'SOUL.md'),
        user: this.botMemory.read(bctx.id, 'USER.md'),
        memory: this.botMemory.read(bctx.id, 'MEMORY.md'),
      };
      relevantMemory = this.mem0Enabled
        ? await mem0.relevant('bot:' + bctx.id, String(queryText || ''))
        : this.botMemory.relevant(bctx.id, String(queryText || ''));
      rules = []; // global kurallar Beast'e özeldir — müşteri botuna karışmaz
    } else {
      mem = memory.loadAll();
      relevantMemory = this.mem0Enabled
        ? await mem0.relevant('main', String(queryText || ''))
        : memory.relevantFor(String(queryText || ''), {});
      rules = memory.listRules();
    }
    const sk = skills.scan().map((s) => `- ${s.name}: ${s.description} [${s.path}]`);
    const parts = [mem.soul, FORMAT_RULES];
    if (mem.user) parts.push('# USER\n' + mem.user);
    if (rules.length) parts.push('# KURALLAR (kullanıcının kalıcı talimatları — daima uy)\n' + rules.map((r) => '- ' + r).join('\n'));
    if (relevantMemory) parts.push('# İLGİLİ HAFIZA\n' + relevantMemory);
    /* #v13.2 tanışma modu: hafıza tamamen boşsa ajan sahibini tanımaya çalışır;
       ilk bilgiler geldikçe soru sormayı bırakır (yazmaya devam eder) */
    const sparse = !bctx && !mem.soul.includes('SAHİBİ') && memory.entries().length < 1 && !mem.user;
    if (sparse) {
      parts.push(
        '# TANIŞMA MODU (hafıza henüz boş)\n' +
          'Bu kullanıcıyı henüz tanımıyorsun. Sohbette doğal bir anda KISA sorarak ' +
          'adını/hitap şeklini öğren ve öğrendiğin an HEMEN user_write ile USER.md\u2019ye, ' +
          'diğer kalıcı bilgileri memory_write ile kaydet. ' +
          'İlk kayıt düştükten sonra soru sormayı bırak; sonraki bilgiler sohbet akışında kendiliğinden not edilir.'
      );
    }
    if (sk.length) {
      parts.push(
        '# SKILLS\nKullanmadan önce ilgili SKILL.md dosyasını read_file ile oku.\n' + sk.join('\n')
      );
    }
    /* opencode instruction port (ajan modu): workspace AGENTS/CLAUDE/CONTEXT
       talimatları — oturum başına bir kez okunur, epoch boyunca sabit */
    const projChat = this._projectInstructions(session);
    if (projChat) {
      parts.push('# PROJE TALİMATLARI (workspace AGENTS/CLAUDE/CONTEXT dosyalarından — daima uy)\n' + projChat);
    }
    /* Beast Code (bcCode) oturumları buildBcSystem kullanır — buraya düşmez */
    const nowD = new Date();
    const localDate = nowD.toLocaleDateString('tr-TR');
    /* önek-cache disiplini (opencode Context Epoch): dakika yerine saat —
       system prompt her dakika değişse sağlayıcı önbelleği sürekli bozulur */
    const localTime = String(nowD.getHours()).padStart(2, '0') + ':00';
    let tz = '';
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {}
    parts.push(
      `# ORTAM\nWindows + PowerShell. Çalışma klasörü: ${(session && session.workspace) || this.workspace}\n` +
        `Yerel tarih: ${localDate} (${['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'][nowD.getDay()]})\n` +
        `Yerel saat: ${localTime}${tz ? ` (saat dilimi: ${tz})` : ''}\n` +
        'Tarih/saat gerektiren her işte bu YEREL zamanı esas al; UTC varsayma, kendin dönüşüm yapma. Bu satırlar her mesajda güncellenir.\n' +
        'Kısa ve net cevap ver. Konuşmaya özgü geçici detayları hafızaya yazma — oturum kayıtları zaten saklar. Sadece kalıcı/genel bilgileri kaydet.'
    );
    parts.push(
      '# KULLANICI TAKİBİ (SIKI — zorunlu disiplin)\n' +
        [
          'Kullanıcı hakkında KALICI bir şey öğrendiğin AN (ad, lakap/hitap, meslek, dil, beğeni/nefret, çalışma saatleri, devam eden proje, aile/arkadaş isimleri) hemen ilgili aracı çağır, sohbet bitmesini BEKLEME.',
          'Kullanıcı profili bilgisi (ad, hitap, tercih, proje) → user_write (USER.md). Genel kalıcı olgu/tercih/düzeltme → memory_write (MEMORY.md). İkisi de tek kısa satır yazar; aynı konuyu tekrar yazarsan eski satır güncellenir.',
          'ÖRNEK: kullanıcı "beni Batuhan diye bil, soyadım Bozoklu" dedi → user_write: "Adı: Batuhan Bozoklu. Hitap: Batuhan/kanka".',
          '"Kaydettim" demeden ÖNCE aracın {"ok":true} döndüğünü gör; araç çağrısı yapmadan asla kayıt iddiasında bulunma. Araç duplicate döndüyse "zaten kayıtlıydı" de.',
          'Kullanıcı hafıza sorarsa ("beni tanıyor musun", "ne biliyorsun benden") USER.md içeriğini ve memory_search sonuçlarını esas al; uydurma.',
        ].join('\n')
    );
    parts.push(
      '# ARAÇ KURALLARI\n' +
        [
          'Basit soruları araç kullanmadan doğrudan cevapla — hız önceliklidir.',
          'Kod/dosya işlerinde: içerik araması grep (regex), dosya adı araması glob, VAR OLAN dosyayı değiştirme edit_file (write_file yalnız yeni dosya/tam yeniden yazım). read_file satır numaralı döner; büyük dosyada devamını offset parametresiyle oku, ASLA baştan okuma; bir dosyayı aynı oturumda BİR KEZ okumak yeter — okunan içerik oturum sonuna kadar bağlamda kalır, dosyayı tekrar okuma. Dosya işlemlerinde özel araçları kullan (edit_file/write_file/read_file/grep/glob); run_command terminal işlerindir (build, git, kurulum, paket) — dosya düzenlemeyi komutla değil edit_file ile yap. edit_file/write_file sonucu additions/deletions döner ve değişiklik diske ANINDA uygulanır — doğrulamak için dosyayı TEKRAR OKUMA; önceki okuduğun içerik + kendi değişikliklerin üzerinden devam et.',
          'Kullanıcı bir tarihte/saatte hatırlatılmasını isterse set_reminder kullan; when değerini ORTAMdaki bugüne göre hesapla (yerel saat). "Her sabah/gün/hafta" gibi tekrarlı isteklerde repeat alanını da ver (daily/weekly/monthly/weekdays veya cron).',
                    'Kullanıcı kalıcı bir arka plan takibi isterse (fiyat eşiği, pil seviyesi, sayfa değişikliği) watcher_add ile izleyici kur; kurduktan sonra watcher_list ile doğrula ve kullanıcıya koşulu + kontrol sıklığını kısaca bildir.',
          'Anlık olay takipleri için (yeni mail, fiyat eşiği, dosya değişimi, webhook) event_subscribe kullan — cron/polling gerekmez; listeyi event_list ile göster, vazgeçirirse event_unsubscribe.',
        'Kullanıcı "artık hep böyle yap / bunu unutma" tarzı kalıcı talimat verirse kural olarak kaydet: sohbette /rule <metin> kullanmasını söyle VEYA kullanıcı isterse event_subscribe ile olaya bağlan (mail/fiyat/dosya/webhook).',
          'Kullanıcının mesajında 2+ ayrı iş/hedef varsa (örn "X yap ve sonra Y\u2019i kontrol et") KODLAMAYA/İŞE BAŞLAMADAN önce todo_write ile plan çıkar ve sırayla yürüt; her adımı tamamlarken güncelle. LİSTE DİSİPLİNİ: her adım bittiği AN status:"done" yap; son cevabını vermeden önce tüm maddeler done olmalı — yapılmayacaksa listeden düş. Listeyi yarım bırakma.',
          'HIZ KURALI: Bağımsız işleri AYNI turda birden çok tool_calls ile PARALEL ver. Küçük işleri tek tek çağırma — her ayrı araç turu 5-15 sn LLM gecikmesidir: 3+ küçük komutu TEK run_command\u2019te `;` ile zincirle (örn `git status; node -v; dir`), döngülü/çoklu işleri TEK python_run betiğinde topla, çok dosyalık değişikliği TEK script ile DEĞİL AYNI turda PARALEL edit_file çağrılarıyla yap (dosya düzenlemeyi komut/scripte yedirme). Her küçük işlem için ayrı araç çağrısı açmak yavaşlığın 1 numaralı sebebidir.',
          this.ceoMode
            ? 'Bağımsız alt-işleri run_background ile PARALEL ajana devret; işi KENDİN YÜRÜTME — emri ver, takip et, raporla.'
            : 'Bağımsız alt-işleri delegate_task ile devret; kendi başına halledebileceğin işleri devretme.',
          'Güncel/dış bilgi gerekiyorsa web_search kullan (zincir DAHİLİ tarayıcıyla başlar — gerçek Chromium ile Google); hızlı ham metin okuması için webfetch (veya http_fetch) kullan.',
          'DERİN ARAŞTIRMA: web_search\u2019in sonucu yetersizse/istenen bilgi listede YOKSA aramayı tekrar tekrar deneme yerine deep_search kullan — 1-4 sorgu varyantını (eş anlamlı, Türkçe+İngilizce yazımlar) PARALEL aratır ve ilk sayfaları GİZLİ gerçek Chromium\u2019da açıp tam metin okur (paneli açmaz, kullanıcıyı rahatsız etmez; JS/SPA sayfalar çalışır). Fiyat karşılaştırma, çok kaynaklı araştırma, "her şeyi bul" işleri ve Türkçe sorgularda sonuç zayıfsa doğrudan deep_search seç. read_top=0 verirsen yalnız harmanlanmış sonuç listesi döner.',
          'ARAMA-DİSİPLİN: bir bilgiyi 2-3 denemede bulamazsan TAKILMA — farklı bir açıya/sorguya geç, yine yoksa bulabildiğin kısmi bilgiyle cevap ver ve neyi bulamadığını açıkça söyle. Kapalı/gizli içerik (private profil, login arkası veri) peşinde KOŞMA — bulunamayacağı belliyse hemen vazgeç.',
          'TARAYICI VARSAYILANI (ZORUNLU): kullanıcı "şu siteyi aç", "bunu ara / google\u2019da ara", "şu sayfaya git" gibi bir web isteği verdiğinde HEP DAHİLİ TARAYICIYI KULLAN (browser_open ile aç → açılış yanıtında hazır snapshot gelir → ref numaralarıyla browser_click/browser_type/browser_select ile hareket et; HER eylem yanıtında taze snapshot döner — ayrıca browser_snapshot çağırma, yanıttaki refleri kullan; browser_read ile metin oku; sadece görsel yerleşim/grafik gerekiyorsa browser_screenshot çek). Tarih/saat alanlarını (type=date/time) browser_type ile DÜZ METİN yaz ("15.03.2026", "2026-03-15") — takvimden tıklamaya çalışma, alan programatik ayarlanır. Panel ekranın sağında açılır ve kullanıcı da sayfayı anında görür; JS/login/SPA/dinamik içerik için idealdir. Bu kural TÜM oturumları kapsar — masaüstü sohbeti ve çok kullanıcılı botlar (WhatsApp vb.) dahil.' +
            ' DIŞ TARAYICI İSTİSNASI: kullanıcı AÇIKÇA "chrome\u2019da aç", "firefox\u2019ta aç", "başka tarayıcıda aç", "normal tarayıcıda aç", "kendi tarayıcımda aç" derse O ZAMAN run_command ile `start "" <url>` çalıştır — sistem varsayılan (dış) tarayıcısında açılır. Kullanıcı dış tarayıcı istemedikçe ASLA dış tarayıcı açma.' +
            ' Görselleri GÖREMEMİYORSAN (metin-model) görüntüdeki metni okumak için ocr_read kullan: source:"browser" ile tarayıcı sayfasını, "screen" ile masaüstünü OCR\u2019la okursun (captcha/canvas/görsel metin dahil).' +
            (this.ceoMode ? ' (CEO: bu araçları KENDİN ÇAĞIRMA — içinde tarayıcı geçen işi run_background ile paralel ajana devret.)' : ''),
          'Tarayıcı eylemlerinin yanıtındaki recent günlüğü ve navigated bilgisini takip et; eylem yanıtları zaten taze snapshot içerir — refler tutarsız görünürse yeni snapshot al.',
          'CONUŞMA ODAĞI SENDE KALSIN: kullanıcı seninle konuşurken iş çıkmışsa — uzun da olsa UFACIK da (tek komutluk dizin listesi, tek dosya okuma, tek arama…) — run_background ile PARALEL ajana devret; ana sohbet hiçbir işi beklemez; bittiğinde özet otomatik düşer.',
          'Python işleri için python_run kullan: küçük betikler inline code ile; tekrarlayan işler %APPDATA%\\beast\\scripts klasöründeki dosyalarla (ör. news.py = RSS haber toplayıcı: args ["--limit","8","--json"]). Python kurulu olmasa bile ilk çağrıda taşınabilir gömülü runtime otomatik iner.',
            'PYTHON DURUMU: makinede sistem Python\'u görünmese bile ŞAŞIRMA ve "python yok" DEME — python_run aracı kendi taşınabilir runtime\'ını (%APPDATA%\\beast\\py\\python.exe) otomatik indirir/kullanır ve bu klasör run_command PATH\'inde önceliklidir; yani run_command içinde de `python` çalışır. Ham Google/Bing scrape yerine önce web_search aracını kullan (SearXNG + stealth TLS + TinyFish + Python çoklu-motor destekli), script gerektiğinde python_run yaz.',
          'PDF ÇIKTI KURALI: PDF üretirken pip\u2019ten pdf paketi (fpdf, fpdf2, markdown-pdf, weasyprint, reportlab vb.) KURMA/KULLANMA — bunlar Türkçe karakterleri bozar. Doğru kit Node tarafında ZATEN kurulu: `pdf-lib` + `@pdf-lib/fontkit` (Türkçe font gömme) ve `pdfkit`. python_run ile DEĞİL; write_file ile .js script yazıp run_command ile `node script.js` çalıştır. md→pdf çevirici YOKTUR ve kurulmaz: kullanıcıya rapor/özet/belge çıktısı vereceksen .md dosyası gönderme — aynı içeriği DOĞRUDAN pdf-lib/pdfkit ile PDF olarak üret ve send_file ile o PDF\u2019i gönder. Ayrıntılı örnekler: pdf skill\u2019i (SKILL.md).',
          'Eski bir hafıza kaydına ihtiyacın olursa memory_search ile ara; kalıcı bilgi/birikim için kb_search kullan, yeni bilgi öğrenirsen kb_add ile kaynak belirt.',
          'Bir oturumda 3+ kez memory_write yaptıysan iş bitince memory_hygiene çağır (duplike/eskime temizliği).',
          'BEAST KAYNAK KORUMASI: Beast\u2019in kendi kurulum/kaynak kod klasörü KİLİTLİDİR — oraya dosya yazamaz, silamaz, komut/betikle değiştiremezsin; okumak serbest. Kullanıcı kodu ancak kendi eliyle dışarıdan değiştirir; böyle bir istek gelirse yapamayacağını söyle ve kullanıcının elle yapması için yol göster.',
        ].join('\n')
    );
    if (this.ceoMode) {
      parts.push(
        '# CEO MODU (yönetici rolü)\n' +
          [
            'Sen yürütücü DEĞİL yöneticisin (CEO): sohbet etmek, anlamak, planlamak, karar vermek ve EMİR VERMEK senin işin; uygulamak değil.',
            'Konuşma harici HER somut işi KENDİN YAPMA — UFUĞU YOK: komut çalıştırma, dosya okuma/yazma, web araştırması, tarayıcıda gezinme, ekran kontrolü, analiz. "Masaüstünde hangi dosyalar var?" gibi tek adımlık minik görevler bile run_background ile PARALEL ajana devredilir; sen asla çalıştırmazsın.',
            'Devrettikten sonra o konuda elinden geleni yapmışsın gibi DAVRANMA; sonuç gelene kadar beklemedigini bil ve kullanıcıyı yanlış bilgilendirme. Ara durumlarda task_status ile bak.',
            'SUPERYORIZON GÖREVİN: devrettiğin her işi SAHİPLEN — ajanı kendi başına BIRAKMA. tasks_list/task_status ile düzenli kontrol et; bitti raporu geldiğinde sonucu DOĞRULA (görevle eşleşiyor mu? eksik var mı?), eksik/yanlışsa tamamlama veya düzeltme görevi için yeni run_background aç.',
            'Sistem sana [SUPERYORIZON] uyarısı düşürürse (takılma / uzun süre) bu bir emirdir: hemen task_status ile dökümü oku, gerekirse task_cancel + düzeltilmiş yeni run_background, ve kullanıcıya tek cümleyle durumu bildir. Uyarıyı asla cevapsız bırak.',
            'Görev tanımı kendi başına YETERLİ olsun: tüm bağlam, dosya/URL yolları, kısıtlar ve beklenen çıktı görev metnine yazılır — paralel ajan senin bağlamını göremez.',
            'Birden fazla bağımsız iş varsa hepsini aynı anda ayrı run_background çağrılarıyla devret (paralel çalışsınlar).',
            'HIZ FAN-OUT: aynı işin farklı adımlarını run_background_many ile TEK SEFERDE paralel aç (örnek: haber taraması → TR / Dünya / Ekonomi ayrı ajan; araştırma+veri çekme+analiz ayrı ajan). Hepsi bitince sana TEK birleşik rapor düşer — hız dramatik artar. Bağımsız 2+ adım görürsen bunu tercih et.',
            'Takip araçları: tasks_list (genel tablo), task_status (tek ajanın canlı dökümü), task_cancel (iptal — reason ZORUNLU). Kullanıcı ilerleme sorarsa buradan raporla.',
            'İPTAL DİSİPLİNİ: bir paralel ajanı task_cancel ile iptal edersen ya da bir işi yarıda bırakırsan, kullanıcıya TEK CÜMLEyle MUTLAKA SEBEBİNİ yaz (neden iptal ettin, ne kayboldu, yerine ne yapacaksın). Sebepsiz iptal YASAK.',
            'Bilgi sorularını, sohbeti, planlamayı, hafıza/hatırlatıcı/izleyici kurulumunu YİNE SEN yaparsın — bunlar "iş" değildir.',
          ].join('\n')
      );
    }
    return parts.filter(Boolean).join('\n\n');
  }

  _payloadTokens(payload) {
    let t = 0;
    for (const m of payload) t += estMsgTokens(m);
    return Math.ceil(t * this.tokRatio);
  }

  _contentLen(m) {
    if (typeof m.content === 'string') return m.content.length;
    if (Array.isArray(m.content)) {
      return m.content.reduce(
        (a, p) => a + (p.type === 'text' ? String(p.text || '').length : (String(p.image_url && p.image_url.url || '').length * 0.25)),
        0
      );
    }
    return 0;
  }

  /* ---------- opencode port: bağlam matematiği (overflow.ts) ---------- */

  /* Seçili model için özet payı düşülmüş kullanılabilir girdi alanı */
  _usableContext(sel) {
    const ctx = modelContextOf(sel);
    if (!ctx) return 0;
    /* overflow.ts:14-19: reserved = min(COMPACTION_BUFFER, maxOutput) */
    const reserved = Math.min(COMPACTION_BUFFER, OUTPUT_TOKEN_MAX);
    return Math.max(0, ctx - reserved);
  }

  /* Dinamik geçmiş bütçesi: model bağlamı genişse 18k sabitinin ÜSTÜNE çıkar
     (asla altına inmez); cache'siz sağlayıcılarda şişmeyi HISTORY_BUDGET_MAX sınırlar */
  _historyBudget(sel) {
    const usable = this._usableContext(sel);
    if (!usable) return this.historyTokenBudget;
    return Math.max(this.historyTokenBudget, Math.min(Math.floor(usable * 0.85), HISTORY_BUDGET_MAX));
  }

  /* Geçmiş + sistem + araç şemaları için kaba toplam token tahmini */
  _contextEstimate(session, sel) {
    const msgs = session.messages.reduce((a, m) => a + estMsgTokens(m), 0);
    const toolsCost = TOOLS.length ? estTokens(JSON.stringify(TOOLS)) : 0;
    return Math.ceil((msgs + toolsCost + 3500) * this.tokRatio); // 3500 ≈ system payı
  }

  /* assistant(tool_calls) + sonuç tool mesajlarını BÖLMEYEN birimler */
  _msgUnits(messages) {
    const units = [];
    let i = 0;
    while (i < messages.length) {
      const m = messages[i];
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
        const grp = [m];
        i++;
        while (i < messages.length && messages[i].role === 'tool') grp.push(messages[i++]);
        units.push(grp);
      } else {
        units.push([m]);
        i++;
      }
    }
    return units;
  }

  _buildPayload(system, messages, notes, budget, summary) {
    /* DOSYA EK ENJEKSİYONU (payload-only): kullanıcı mesajlarındaki dosya
       ekleri SADECE burada, LLM isteğine metin olarak eklenir. Oturum
       mesajı/ekran temiz kalır — chat'te yalnız dosya kartı görünür. */
    let payloadSrc = messages;
    const withFiles = messages.map((m) => {
      if (!m || m.role !== 'user' || !Array.isArray(m.attachments)) return m;
      const docs = m.attachments.filter((a) => a && a.type === 'file' && a.content);
      if (!docs.length) return m;
      const extra = docs
        .map((f) => `[Ek dosya: ${f.name}]\n${String(f.content || '')}`)
        .join('\n\n');
      const { attachments: _drop, ...rest } = m;
      if (typeof rest.content === 'string') {
        rest.content = (rest.content + (rest.content ? '\n\n' : '') + extra).trim();
      } else if (Array.isArray(rest.content)) {
        let hit = false;
        rest.content = rest.content.map((p) => {
          if (p && p.type === 'text' && !hit) {
            hit = true;
            return { ...p, text: ((p.text || '') + (p.text ? '\n\n' : '') + extra).trim() };
          }
          return p;
        });
        if (!hit) rest.content = [...rest.content, { type: 'text', text: extra }];
      } else {
        rest.content = extra;
      }
      return rest;
    });
    payloadSrc = withFiles;
    const units = this._msgUnits(payloadSrc);
    const B = Math.max(2000, Number(budget) || this.historyTokenBudget);
    const maxUnits = notes ? NOTES_MAX_UNITS : units.length; // notlar varken pencereyi sıkılaştır
    const picked = [];
    let used = 0;
    for (let u = units.length - 1; u >= 0; u--) {
      if (picked.length >= maxUnits) break;
      const cost = units[u].reduce(
        (a, m) => a + clamp(Math.ceil(estMsgTokens(m) * this.tokRatio), 1, B),
        0
      );
      if (picked.length && used + cost > B) break;
      picked.unshift(units[u]);
      used += cost;
    }
    // Eski kullanıcı mesajlarındaki görselleri metne indir (token tasarrufu)
    const flat = picked.flat().map((m, idx, arr) => {
      if (
        m.role === 'user' &&
        Array.isArray(m.content) &&
        idx < arr.length - 2
      ) {
        const txt = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        return { ...m, content: txt + '\n[resimler bağlam dışı bırakıldı]' };
      }
      return m;
    });
    /* opencode file-state portu: read_file sonuçları bağlamda YAŞAR —
       kırpma modeli "unuttu" diye tekrar tekrar okumaya zorluyordu.
       opencode'ta araç çıktıları tam tutulur; eski okumalar stub'a inmez —
       bütçe dolunca en eski birimler doğal olarak pencere dışı kalır
       (opencode prune mantığıyla aynı). Okumalar READ_OUT_KEEP ile sınırlı. */
    const READ_KEEP = READ_OUT_KEEP; /* depolama tavanıyla hizalı */
    for (let k = 0; k < flat.length; k++) {
      const m = flat[k];
      if (m.role !== 'tool') continue;
      const len = String(m.content || '').length;
      let content;
      if (m.name === 'read_file') {
        content = len > READ_KEEP ? String(m.content).slice(0, READ_KEEP) + '\n…[kırpıldı — devam için offset ile oku]' : null; /* TAM KORUNUR */
      } else {
        content = len > TOOL_OUT_KEEP * 2 ? String(m.content).slice(0, TOOL_OUT_KEEP) + '\n…[kırpıldı]' : null;
      }
      /* diffView UI-only metadata'dır — sağlayıcıya GİTMEZ */
      if (content !== null || m.diffView) {
        const rest = { ...m };
        delete rest.diffView;
        if (content !== null) rest.content = content;
        flat[k] = rest;
      }
    }
    /* opencode compaction replay (message-v2.ts:521-572): özet, system'den
       HEMEN sonra sabit user mesajı olarak girer → önek cache'e uygun
       (compaction sonrası yalnız eklemeli büyür, system bir daha değişmez) */
    const head = [];
    if (summary) {
      head.push({
        role: 'user',
        content:
          '[ÖNCEKİ KONUŞMANIN ÖZETİ — birebir geçmişi buradan hatırla]\n' +
          summary +
          '\n[Konuşma aşağıdaki mesajlarla DEVAM EDİYOR]',
      });
    }
    /* emniyet: sağlayıcıya GİDEN hiçbir mesajda `attachments` alanı olmasın */
    for (let k = 0; k < flat.length; k++) {
      if (flat[k] && flat[k].attachments) {
        const { attachments: _drop, ...rest } = flat[k];
        flat[k] = rest;
      }
    }
    return [{ role: 'system', content: system }, ...head, ...flat];
  }

  _lastUserText(session) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string') return m.content;
      return m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    }
    return '';
  }

  /* ---------- oturum notları ---------- */

  _plainText(m) {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.filter((p) => p.type === 'text').map((p) => p.text || '').join(' ');
    }
    return '';
  }

  _renderTranscript(msgs) {
    const lines = [];
    for (const m of msgs) {
      if (m.role === 'user') lines.push('[Kullanıcı] ' + this._plainText(m).slice(0, 1500));
      else if (m.role === 'assistant' && String(m.content || '').trim()) lines.push('[Asistan] ' + this._plainText(m).slice(0, 1200));
      else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
        lines.push('[Araç çağrısı] ' + m.tool_calls.map((t) => t.function && t.function.name).filter(Boolean).join(', '));
      } else if (m.role === 'tool') lines.push('[Araç sonucu] ' + String(m.content || '').slice(0, 400));
    }
    return lines.filter(Boolean).join('\n');
  }

  /* Not üretimi sonrası: notlara dönüştürülen [0..cut) aralığı diskten düşer;
     meta+notes+todos+son NOTES_KEEP_RECENT*2 mesaj kalır. notesAt=0 sıfırlanır.
     Atomik — başarısız olursa mevcut dosya sağlam kalır. */
  _compactToNotes(session, cut) {
    try {
      const file = this._file(session.id);
      /* korunan pencere cut'tan sonra başlar — özetlenen bölgeyle ÇAKIŞMAZ */
      const keepFrom = cut;
      const out = [];
      out.push(JSON.stringify({ t: 'meta', id: session.id, code: session.code, createdAt: session.createdAt }));
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (r.t === 'todo') out.push(line); // en güncel todo satırı kalır (append-only, sonuncusu kazanır)
      }
      out.push(JSON.stringify({ t: 'notes', text: session.notes || '', at: 0 }));
      /* korunan pencere */
      let seen = 0;
      const msgLines = [];
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (r.t !== 'msg') continue;
        if (seen++ >= keepFrom) msgLines.push(line);
      }
      out.push(...msgLines);
      out.push(JSON.stringify({ t: 'summary', text: session.summary || '', at: 0 }));
      out.push(JSON.stringify({ t: 'compacted', at: nowIso(), droppedBefore: keepFrom, noteBased: true }));
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, out.join('\n') + '\n');
      fs.renameSync(tmp, file);
    } catch {}
  }

  /* ---------- opencode port: gerçek compaction + prune (compaction.ts) ---------- */

  /* Head bölgesini düz metne serileştirir (compaction.ts:54-85 port).
     Araç çıktıları SUMMARY_OUT_KEEP ile kırpılır — özet çağrısı küçük kalır. */
  _serializeHead(msgs) {
    const lines = [];
    for (const m of msgs) {
      if (m.role === 'user') {
        lines.push('[Kullanıcı]: ' + this._plainText(m).slice(0, 1500));
      } else if (m.role === 'assistant') {
        const txt = this._plainText(m).trim();
        if (txt) lines.push('[Asistan]: ' + txt.slice(0, 1200));
        for (const tc of m.tool_calls || []) {
          let args = '';
          try {
            args = JSON.stringify(JSON.parse((tc.function && tc.function.arguments) || '{}'));
          } catch {
            args = String((tc.function && tc.function.arguments) || '');
          }
          lines.push(`[Araç çağrısı]: ${tc.function && tc.function.name}(${args.slice(0, 800)})`);
        }
      } else if (m.role === 'tool') {
        const out = String(m.content || '');
        lines.push(
          '[Araç sonucu]: ' + (out.length <= SUMMARY_OUT_KEEP ? out : out.slice(0, SUMMARY_OUT_KEEP) + '\n[kırpıldı]')
        );
      }
    }
    return lines.filter(Boolean).join('\n');
  }

  /* compaction.ts:319-557 port. Bağlam taşarsa: kuyruk (son ~%25) birebir
     korunur, baş metne serileştirilip TEK küçük model çağrısıyla özetlenir,
     geçmiş [özet + kuyruk] olarak yeniden yazılır. Döndürür: compact oldu mu */
  async _compactHistory(session, sel, signal) {
    try {
      const usable = this._usableContext(sel) || this.historyTokenBudget * 2;
      const budget = clamp(Math.floor(usable * 0.25), MIN_PRESERVE_RECENT, MAX_PRESERVE_RECENT);
      const units = this._msgUnits(session.messages);
      if (units.length < 3) return false;
      let keepIdx = 0;
      let used = 0;
      for (let u = units.length - 1; u >= 0; u--) {
        const cost = units[u].reduce((a, m) => a + Math.ceil(estMsgTokens(m) * this.tokRatio), 0);
        if (used + cost > budget) break;
        keepIdx = u;
        used += cost;
      }
      if (keepIdx <= 0) return false; // özetlenecek head yok
      const headMsgs = units.slice(0, keepIdx).flat();
      const transcript = this._serializeHead(headMsgs);
      if (!transcript.trim()) return false;

      /* core/session/compaction.ts:16-56 şablonu (Türkçe başlıklarla) */
      const prev = session.summary
        ? `<önceki-özet>\n${session.summary}\n</önceki-özet>\n\n` +
          'önceki-özet, konuşmadan önceki her şeyi özetler: ikisini BİRLEŞTİREREK yeni özet çıkar. ' +
          'önceki-özet bu birleşimden sonra atılır — yeni özete taşımadığın her şey KAYBOLUR. ' +
          'Konuşma daha yenidir; çelişkide konuşma kazanır. Biten işleri "Aktif"ten "Tamamlanan"a taşı.\n\n'
        : '';
      const prompt =
        'Aşağıdaki <konuşma> etiketindeki sohbet geçmişinden, işe başka bir ajan devam edecek şekilde özet çıkar.\n' +
        'Tam olarak <şablon> içindeki Markdown yapısını koru; şablon etiketlerini yanıtına yazma.\n' +
        '<şablon>\n' +
        '## Amaç\n- [kullanıcının ne yapmaya çalıştığı, 1-2 cümle]\n\n' +
        '## Önemli Detaylar\n- [kısıtlar, kararlar ve gerekçeleri, önemli olgular, kesin yollar/sayılar; yoksa "(yok)"]\n\n' +
        '## İş Durumu\n### Tamamlanan\n- [biten işler, doğrulanan olgular; yoksa "(yok)"]\n\n' +
        '### Aktif\n- [sürüyen işler, yarım değişiklikler; yoksa "(yok)"]\n\n' +
        '### Engelli\n- [hatalar, bilinmeyenler; yoksa "(yok)"]\n\n' +
        '## Sonraki Adım\n1. [somut ilk eylem; yoksa "(yok)"]\n\n' +
        '## İlgili Dosyalar\n- [dosya/klasör yolu: neden önemli; yoksa "(yok)"]\n' +
        '</şablon>\n\n' +
        'Kurallar:\n- Boş olsa bile her bölümü koru.\n- Kısa madde maddeler yaz, paragraf kurma.\n' +
        '- Dosya yollarını, komutları, hata metinlerini, URL\u2019leri BİREBİR aktar.\n' +
        '- Özetleme yaptığını asla belirtme.\n\n' +
        prev +
        `<konuşma>\n${transcript}\n</konuşma>`;

      emitSafe(this, session.id, {
        type: 'status',
        status: `⇩ bağlam doldu — opencode tarzı özetleme devrede (head ${headMsgs.length} mesaj, kuyruk ${session.messages.length - headMsgs.length} korunuyor)`,
      });
      const small = this.modelFor('subagent') || sel || this.sel;
      const res = await chatOnce(
        small,
        { messages: [{ role: 'user', content: prompt }], temperature: 0.2 },
        { signal }
      );
      const text = String(res.content || '').replace(/```(?:markdown)?/gi, '').trim();
      if (!text) return false;
      session.summary = text.slice(0, 12000);
      const tail = units.slice(keepIdx).flat();
      session.messages = tail;
      session.notesAt = clamp(session.notesAt || 0, 0, tail.length);
      this._persistCompaction(session);
      emitSafe(this, session.id, {
        type: 'status',
        status: `✓ bağlam özeti yazıldı — geçmiş ${headMsgs.length + tail.length} → ${tail.length} mesaj, önek cache tazelendi`,
      });
      return true;
    } catch {
      return false; // compaction asla sohbeti bozmasın
    }
  }

  /* Compaction sonrası disk yeniden yazımı: meta/bot/todo/notes/summary +
     kuyruk mesajları. Atomik — patlarsa eski dosya sağlam kalır. */
  _persistCompaction(session) {
    try {
      const file = this._file(session.id);
      let meta = null, meta2 = null, bot = null, todo = null;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let r;
        try { r = JSON.parse(line); } catch { continue; }
        if (r.t === 'meta') meta = line;
        else if (r.t === 'meta2') meta2 = line;
        else if (r.t === 'bot') bot = line;
        else if (r.t === 'todo') todo = line; // append-only: son satır kazanır
      }
      const out = [];
      if (meta) out.push(meta);
      else out.push(JSON.stringify({ t: 'meta', id: session.id, code: session.code, createdAt: session.createdAt }));
      if (meta2) out.push(meta2);
      if (bot) out.push(bot);
      if (todo) out.push(todo);
      out.push(JSON.stringify({ t: 'notes', text: session.notes || '', at: session.notesAt || 0 }));
      out.push(JSON.stringify({ t: 'summary', text: session.summary || '', at: nowIso() }));
      for (const m of session.messages) out.push(JSON.stringify({ t: 'msg', ...m }));
      out.push(JSON.stringify({ t: 'compacted', at: nowIso(), summary: true }));
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, out.join('\n') + '\n');
      fs.renameSync(tmp, file);
    } catch {}
  }

  /* Taşma kontrolü (overflow.ts:22-34): gerçek usage varsa onu esas al,
     yoksa tahmini kullan. usable'ın %95'i dolunca compaction tetiklenir. */
  _overContext(session, sel, lastUsageTotal) {
    const usable = this._usableContext(sel);
    if (!usable) return false;
    const total =
      lastUsageTotal ||
      session.messages.reduce((a, m) => a + estMsgTokens(m), 0) * this.tokRatio + 6000;
    return total >= usable * 0.95;
  }

  /* compaction.ts:273-317 prune port: sondan geriye yürür, en yeni kullanıcı
     turunu korur; PRUNE_PROTECT (40k) aşan eski araç çıktılarını temizler.
     En az PRUNE_MINIMUM (20k) kazanç yoksa hiç dokunmaz. tool_call_id çiftleri
     korunur — sadece içerik temizlenir, önek cache bozulmaz. Döndürür: kazanılan token */
  _pruneSession(session) {
    try {
      if (this.ctrls.has(session.id)) return 0;
      const msgs = session.messages;
      let total = 0, pruned = 0, turns = 0;
      const targets = [];
      /* her dosyanın EN SON read_file sonucu asla prune edilmez — dosya
         hafızası oturum sonuna kadar yaşar; eski okumalar serbest */
      const readPathOf = (m) => {
        const s = String(m.content || '');
        const mm = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(s.slice(0, 600));
        return mm ? mm[1] : null;
      };
      const lastReadId = new Map();
      for (const m of msgs) {
        if (m.role === 'tool' && m.name === 'read_file' && m.tool_call_id) {
          const p = readPathOf(m);
          if (p) lastReadId.set(p, m.tool_call_id);
        }
      }
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'user') turns++;
        if (turns < 2) continue; // en yeni tur dokunulmaz
        if (
          m.role === 'tool' && m.name === 'read_file' && m.tool_call_id &&
          readPathOf(m) && lastReadId.get(readPathOf(m)) === m.tool_call_id
        ) continue; // son dosya okuması korumalı
        if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 400) {
          const est = Math.ceil(estTokens(m.content) * this.tokRatio);
          total += est;
          if (total > PRUNE_PROTECT) {
            pruned += est;
            targets.push(m);
          }
        }
      }
      if (pruned <= PRUNE_MINIMUM) return 0;
      const marker = '[eski araç çıktısı temizlendi — özet ve son çıktılar yeterli]';
      const ids = new Map(targets.map((m) => [m.tool_call_id, marker]));
      for (const m of targets) {
        m.content = marker;
        delete m.diffView; /* prune edilen çıktının UI diff'i de düşer */
      }
      try {
        const file = this._file(session.id);
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          let r;
          try { r = JSON.parse(lines[i]); } catch { continue; }
          if (r.t === 'msg' && r.role === 'tool' && ids.has(r.tool_call_id)) {
            r.content = marker;
            delete r.diffView;
            lines[i] = JSON.stringify({ t: 'msg', ...r });
          }
        }
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, lines.join('\n'));
        fs.renameSync(tmp, file);
      } catch {}
      return pruned;
    } catch {
      return 0;
    }
  }

  /* Cevap verildikten sonra çağrılır: son not update'ten bu yana NOTES_EVERY
     (14) mesaj biriktiginde özet çıkarıp oturum notlarını günceller.
     Notlar oturum dosyasına (code ile eşli) yazılır ve _chatTurn'da aynı
     oturuma enjekte edilir. */
  async _updateSessionNotes(session, signal) {
    try {
      if (!this.sel) return { ok: false, reason: 'model yok' };
      const msgs = session.messages;
      const mark = clamp(Number(session.notesAt) || 0, 0, msgs.length);
      /* #24 KESİN tetik: son nottan bu yana >= NOTES_EVERY mesaj biriktiyse */
      const pending = msgs.length - mark;
      if (pending < NOTES_TRIGGER) return { ok: false, reason: `bekleme: ${pending}/${NOTES_TRIGGER}` };
      const cut = Math.max(mark, msgs.length - NOTES_KEEP_RECENT);
      if (cut <= mark) return { ok: false, reason: 'aralık boş' };
      const transcript = this._renderTranscript(msgs.slice(mark, cut)); // son nottan bu yana özetlenecek aralık
      if (!transcript.trim()) {
        session.notesAt = cut;
        return { ok: false, reason: 'özetlenecek metin yok' };
      }
      const prev = session.notes ? `Önceki notlar (koru ve birleştir):\n${session.notes}\n\n` : '';
      const prompt =
        `OTURUM KODU: ${session.code || '?'} — üretilen not bu oturuma aittir.\n` +
        `${prev}Aşağıdaki sohbet parçasının ÖNEMLİ noktalarını çıkar. Şunları yakala:\n` +
        `- kullanıcının hedefleri ve net talepleri\n` +
        `- alınan kararlar, önemli bilgi parçaları (isim, sayı, dosya/klasör yolu, hata ve çözümü)\n` +
        `- tamamlanan işler ve sonuçları\n` +
        `Madde madde yaz, en fazla 120 kelime, başlık/selamlama yok. Alakasız ayrıntıyı at.\n\n` +
        `# SOHBET PARÇASI\n${transcript}`;
      const res = await chatOnce(
        this.sel,
        { messages: [{ role: 'user', content: prompt }], temperature: 0.2 },
        { signal }
      );
      const txt = String(res.content || '').trim();
      if (!txt) return { ok: false, reason: 'model boş döndü' };
      session.notes = txt.slice(0, 4000);
      session.notesAt = cut;
      try { this._appendNotes(session); } catch {}
      /* #6 bağlam sıkıştırma: öze dönüşen eski mesajlar bellekten VE diskten
         düşer (compacted işaretiyle); notlar + son pencere her zaman kalır.
         Böylece notesAt=0'dan yeniden başlar, uzun sohbette şişme olmaz. */
      /* YARIŞ KORUMASI: bu bakım artık done SONRASI arka planda koşuyor —
         yeni tur başladıysa dosya sıkıştırmayı ERTENELE (not satırı append ile
         zaten kayıtlı; sıkıştırma sonraki bakımda yapılır, append kaybı olmaz) */
      if (this.ctrls.has(session.id)) return { ok: true, deferred: true };
      this._compactToNotes(session, cut);
      /* bellek kopyasını da eşele: özetlenen bölge [0..cut) atılır */
      session.messages = session.messages.slice(cut);
      session.notesAt = 0;
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e).slice(0, 120) }; // not üretimi asla sohbeti bozmasın
    }
  }

  /* Cevap done SONRASI arka planda koşan ev işleri (kullanıcıyı BEKLETMEZ,
     DURUM BALONUNU DA MEŞGUL ETMEZ — tamamen sessizdir):
     oturum notları → otomatik memory → skill yansıtma → kişilik kalibrasyonu.
     Aynı oturum için per-session zincirle sıralanır. */
  _postRunHousekeeping(session, prevSignal) {
    const sid = session.id;
    if (session.bgJob || session.bcCode || session.isBotDm) return;
    if (prevSignal && prevSignal.aborted) return;
    /* /stop kapısı: not/memory/yansıma bakımı YENİ LLM SORGUSU açmaz */
    if (this._stopped) return;
    if (!this._housekeepingTail) this._housekeepingTail = new Map();
    const job = this._housekeepingTail.get(sid) || Promise.resolve();
    const next = job.catch(() => {}).then(async () => {
      const ctl = new AbortController();
      try { await this._updateSessionNotes(session, ctl.signal); } catch {}
      if (ctl.signal.aborted || this._stopped || this.ctrls.has(sid)) return;
      try { await this._autoMemory(session, ctl.signal); } catch {}
      if (this.reflection.enabled && !ctl.signal.aborted && !this._stopped && !this.ctrls.has(sid)) {
        try { await this._maybeReflectSkill(session); } catch {}
      }
      try { memory.calibratePersona(); } catch {}
    });
    this._housekeepingTail.set(sid, next);
  }

  /* ---------- agent loop ---------- */

  send(sessionId, payload, opts = {}) {
    const userAction = !!(opts && opts.userAction);
    /* /stop kapısı: sistem tetikli gönderim durdurulur; kullanıcının kendi
       mesajı (userAction) kapıyı kaldırır — "devam için bir şeyler yaz" */
    if (this._stopped && !userAction) return false;
    if (userAction) this._stopped = false;
    const s = this._load(String(sessionId));
    if (!s || this.ctrls.has(s.id)) return false;

    let msg;
    if (typeof payload === 'string') {
      msg = { role: 'user', content: payload.slice(0, USER_MAX) };
    } else {
      const text = String((payload && payload.text) || '').slice(0, USER_MAX);
      const atts = Array.isArray(payload && payload.attachments) ? payload.attachments : [];
      const imgs = atts.filter((a) => a.type === 'image' && a.dataUrl).slice(0, 4);
      /* DOSYA EKLERİ İÇERİĞE GÖMÜLMEZ: mesajda `attachments` alanında taşınır —
         chat ekranında DOSYA KARTI olarak görünür, içerik ekrana yazılmaz.
         İçeriği yalnızca _buildPayload LLM isteğine enjekte eder. */
      const files = atts
        .filter((a) => a.type === 'file')
        .map((a) => ({ name: String(a.name || 'dosya'), content: String(a.content || '').slice(0, 20000) }));
      const body = (text.trim() || (files.length || imgs.length ? '[dosya ekleri]' : '(ek)')).slice(0, USER_MAX);
      if (imgs.length) {
        const parts = [{ type: 'text', text: body }];
        for (const im of imgs) parts.push({ type: 'image_url', image_url: { url: im.dataUrl } });
        msg = { role: 'user', content: parts };
      } else {
        msg = { role: 'user', content: body };
      }
      if (imgs.length || files.length) {
        /* UI dosya kartları + payload enjeksiyonu buradan beslenir:
           dosyalar İÇERİKLE birlikte `attachments`ta yaşar (görüntüler yalnız
           ad taşır — veri content parçalarındadır). Chat ekranı yalnız ADI basar. */
        msg.attachments = [
          ...imgs.map((im) => ({ type: 'image', name: String(im.name || 'resim') })),
          ...files,
        ];
      }
    }

    if (!String(typeof msg.content === 'string' ? msg.content : msg.content[0].text || '').trim()) return false;
    /* #12 kişilik kalibrasyonu: kullanıcı cümlelerini örnek havuzuna düşür (Beast Code hariç — hız) */
    if (!s.bcCode) {
      try { memory.addStyleSample(this._plainText(msg)); } catch {}
    }

    /* Önceki tur yanıtlanmadan kaldıysa (hata/durdurma sonrası artık user mesajı)
       katı sağlayıcılar art arda user mesajını reddeder: "messages illegal" (400).
       Yeni metni o mesajla BİRLEŞTİR — dosyadaki son satır da güncellenir. */
    const lastMsg = s.messages[s.messages.length - 1];
    if (
      lastMsg && lastMsg.role === 'user' &&
      typeof lastMsg.content === 'string' &&
      typeof msg.content === 'string'
    ) {
      lastMsg.content = lastMsg.content + '\n' + msg.content;
      if (msg.attachments || lastMsg.attachments) {
        lastMsg.attachments = [...(lastMsg.attachments || []), ...(msg.attachments || [])];
      }
      msg = lastMsg;
      this._rewriteLastMsg(s.id, lastMsg.content, lastMsg.attachments);
    } else {
      s.messages.push(msg);
      try {
        this._append(s, msg);
      } catch {}
    }
    this.emit({ type: 'message', sessionId: s.id, message: msg });
    this.emit({ type: 'sessions' });
    this._run(s).catch(() => {});
    return true;
  }

  /* SESSİZ BAĞLAM ENJEKSİYONU: metin oturum geçmişine düşer ama _run()
     TETİKLENMEZ — ajan "görür", cevap ÜRETMEZ. WhatsApp gruplarında
     @mention moduyla kullanılır: grubun tüm konuşması bağlam olarak
     birikir, bot yalnız mention gelince konuşur. Ardışık bağlam
     mesajları işaret önekli tek user mesajında birleşir (bazı sağlayıcılar
     art arda user mesajını reddettiği için). */
  observe(sessionId, text) {
    const s = this._load(String(sessionId));
    if (!s) return false;
    const body = String(text || '').slice(0, USER_MAX);
    if (!body.trim()) return false;
    const lastMsg = s.messages[s.messages.length - 1];
    if (
      lastMsg && lastMsg.role === 'user' &&
      typeof lastMsg.content === 'string' &&
      lastMsg.content.startsWith(OBSERVE_MARK)
    ) {
      /* önceki bağlam mesajının devamı — tek mesajda birleştir */
      lastMsg.content = (lastMsg.content + '\n' + body).slice(0, USER_MAX);
      this._rewriteLastMsg(s.id, lastMsg.content);
    } else {
      const msg = { role: 'user', content: body };
      s.messages.push(msg);
      try {
        this._append(s, msg);
      } catch {}
    }
    this.emit({ type: 'observe', sessionId: s.id });
    this.emit({ type: 'sessions' });
    return true;
  }

  /* Paralel ajan GEÇMİŞİNİ topluca sil: çalışanlar/ bekleyenler iptal edilir,
     tüm bg oturum dosyaları + kalıcı kayıt temizlenir. Döndürür: silinen iş sayısı */
  clearAllBgJobs() {
    let n = 0;
    for (const id of [...this._bgJobs.keys()]) {
      try {
        const j = this._bgJobs.get(id);
        if (j && (j.status === 'running' || j.status === 'queued')) {
          this._abortReasons = this._abortReasons || new Map();
          this._abortReasons.set(id, 'paralel ajan geçmişi topluca temizlendi');
          const c = this.ctrls.get(id);
          if (c) c.abort();
        }
        if (this.deleteSession(id)) n++;
      } catch {}
    }
    try { fs.unlinkSync(this._bgJobsFile); } catch {}
    this._bgEmit();
    return n;
  }

  /* #14 paralel ajanlar: ANA oturumu hiç bloklamayan arka plan çalıştırıcı.
     Ayrı gizli oturum açar, işi orada koşturur; bitince özet bildirim
     istenen sohbete düşer. Birden fazla iş aynı anda paralel koşabilir —
     her biri _bgJobs kaydına düşer ve UI'da canlı izlenir. */
  runBackground(parentSessionId, task, title, opts = {}) {
    const t = String(task || '').trim();
    if (!t) return { ok: false, error: 'görev boş' };
    /* /stop kapısı: durdurulmuş sistemde yeni arka plan işi başlamaz */
    if (this._stopped) return { ok: false, error: '/stop aktif — arka plan işi başlatılamadı' };
    const parent = String(parentSessionId || '');
    /* createSession() view döndürür (messages yok) — tam oturumu cache'ten al.
       Aksi halde send() s.messages.push'da sessizce patlardı ve iş koşmazdı. */
    const bg = this._load(this.createSession().id);
    bg.messages = bg.messages || [];
    bg.bgJob = true; // arka plan oturumu: auto-memory/kalibrasyon kapalı
    /* opencode agent port: iş özel ajana bağlıysa prompt/model/araç/steps ondan */
    if (opts.agent) {
      const adef = agentdefs.get(String(opts.agent));
      if (adef && (adef.mode === 'bg' || adef.mode === 'all')) bg.agentName = adef.name;
    }
    this.cache.set(bg.id, bg);
    const ttl = String(title || t).replace(/\s+/g, ' ').trim().slice(0, 80) || 'arka plan görevi';
    /* #17 cache'teki nesneye de işaret koy — listSessions temiz başlık göstersin */
    bg.bgTitle = ttl;
    bg.bgOf = parent;
    try {
      // arka plan oturumunu sakla — listSessions'a karışmasın diye isimlendirme:
      fs.appendFileSync(
        this._file(bg.id),
        JSON.stringify({ t: 'meta2', bgOf: parent, title: ttl, at: new Date().toISOString() }) + '\n'
      );
      if (bg.agentName) {
        fs.appendFileSync(this._file(bg.id), JSON.stringify({ t: 'agent', name: bg.agentName, at: nowIso() }) + '\n');
      }
    } catch {}
    this._bgJobs.set(bg.id, {
      id: bg.id,
      code: bg.code,
      title: ttl,
      task: t.slice(0, 500),
      agent: bg.agentName || null,
      parentId: parent,
      groupId: opts.groupId || null,
      status: 'running', // queued | running | done | error | aborted
      slot: false, // #5 gerçekten bir eşzamanlı LLM slotu işgal ediyor mu (admit'te true)
      startedAt: nowIso(),
      lastActivityAt: nowIso(), // superyorizyon: son hareket zamanı
      lastNudgeAt: null, // son [SUPERYORIZON] uyarısı
      checks: 0,
      fixes: 0, // öz-kurtarma denemeleri (BG_FIX_MAX'a kadar; bitince CEO)
      endedAt: null,
      error: null,
    });
    this._bgMeta = this._bgMeta || new Map();
    this._bgMeta.set(bg.id, { parentId: parent, title: ttl });
    this._bgEmit();
    setTimeout(() => this._bgAdmit(bg.id, t), 60);
    return { ok: true, backgroundId: bg.id, code: bg.code };
  }

  /* ---------- #5 eşzamanlılık kuyruğu ----------
     Slot doluysa iş 'queued' görünür; bir iş bitince FIFO sıradaki başlar. */

  _runningBgCount() {
    let n = 0;
    for (const j of this._bgJobs.values()) if (j.status === 'running' && j.slot) n++;
    return n;
  }

  _bgAdmit(sid, fullTask) {
    try {
      /* /stop kapısı: kuyruğa alma ve başlatma durdurulur */
      if (this._stopped) return;
      const j = this._bgJobs.get(String(sid));
      if (!j || j.status !== 'running' || j.slot) return;
      if (this._runningBgCount() >= this._bgLimit) {
        j.status = 'queued';
        this._bgPendingStart.set(String(sid), fullTask || j.task);
        this._bgEmit();
        return;
      }
      j.slot = true;
      this.send(sid, {
        text:
          `[ARKA PLAN GÖREV] Aşağıdaki işi baştan sona bitir. Ara sonuçları not et; ` +
          `en sonda SADECE 3-5 satırlık net bir sonuç raporu yaz.\n\n${fullTask}`,
      });
    } catch {}
  }

  _bgResumeQueue() {
    /* /stop kapısı: sıradaki iş BAŞLATILMAZ (status mutate edilmeden dönülür —
       hayalet 'running' kaydı oluşmasın) */
    if (this._stopped) return;
    while (this._runningBgCount() < this._bgLimit) {
      let next = null;
      for (const j of this._bgJobs.values()) {
        if (j.status !== 'queued') continue;
        if (!next || String(j.startedAt).localeCompare(String(next.startedAt)) < 0) next = j;
      }
      if (!next) break;
      next.status = 'running';
      next.slot = true;
      const text = this._bgPendingStart.get(String(next.id)) || next.task;
      this._bgPendingStart.delete(String(next.id));
      this._bgEmit();
      try {
        this.send(next.id, {
          text:
            `[ARKA PLAN GÖREV] Aşağıdaki işi baştan sona bitir. Ara sonuçları not et; ` +
            `en sonda SADECE 3-5 satırlık net bir sonuç raporu yaz.\n\n${text}`,
        });
      } catch {}
    }
  }

  /* #18 aynı işin farklı adımları için paralel fan-out.
     Her adım AYRI ajan koşar; hepsi bitince TEK birleşik rapor düşer —
     örnek: haber toplama → TR / Dünya / Ekonomi üç ajan paralel. */
  runBackgroundMany(parentSessionId, tasks, groupTitle) {
    const list = Array.isArray(tasks) ? tasks : [];
    if (!list.length) return { ok: false, error: 'tasks boş' };
    const parent = String(parentSessionId || '');
    const groupId = uid();
    this._bgGroups.set(groupId, { parentId: parent, total: list.length, results: [], dead: false });
    const ids = [];
    let n = 0;
    for (const item of list) {
      const task = String((item && item.task) || item || '').trim();
      if (!task) continue;
      const r = this.runBackground(parent, task, (item && item.title) || `${groupTitle || 'grup'} #${++n}`, {
        groupId,
        agent: (item && item.agent) || null,
      });
      if (r.ok) ids.push(r.backgroundId);
    }
    if (!ids.length) {
      this._bgGroups.delete(groupId);
      return { ok: false, error: 'geçerli görev yok' };
    }
    const g = this._bgGroups.get(groupId);
    g.total = ids.length;
    return { ok: true, groupId, ids, total: ids.length };
  }

  /* #17 kalıcı arka plan hatası → owner'a tek seferlik uyarı maili (fire-and-forget) */
  _notifyOwnerTaskFailed(job, msg) {
    if (this._stopped) return; /* /stop: durdurulan iş için mail UYANDIRMA */
    if (this.notifyOwnerFail === false) return;
    if (!this.email || typeof this.email.send !== 'function') return;
    if (job._mailed) return;
    job._mailed = true;
    Promise.resolve(
      this.email.send({
        to: OWNER_FAIL_EMAIL,
        subject: `[Beast] Paralel ajan başarısız: ${job.title}`,
        body:
          `Görev: ${job.title}\nKod: ${job.code || '?'}\nDurum: öz-kurtarma hakları tükendi\n\n` +
          `Hata:\n${String(msg || 'bilinmeyen hata').slice(0, 800)}\n\n` +
          `Sohbet geçmişi sağ paneldeki Paralel Ajanlar bölümünde.`,
      })
    ).catch(() => {});
  }

  /* grup üyesi kapandığında sonuç yazılır; sonuncuysa birleşik rapor basılır */
  _bgGroupRecord(title, status, summary) {
    for (const [gid, g] of this._bgGroups) {
      if (g.dead) continue;
      /* üst oturum silinmişse grup ölü sayılır — hayalet oturuma yazma */
      if (this._deletedSessions && this._deletedSessions.has(g.parentId)) {
        g.dead = true;
        continue;
      }
      g.results.push({ title, status, summary: String(summary || '').slice(0, 900) });
      if (g.results.length >= g.total) {
        this._bgGroups.delete(gid);
        const okN = g.results.filter((r) => r.status === 'done').length;
        const body = g.results
          .map((r) => (r.status === 'done' ? `\u2713 ${r.title}\n${r.summary}` : `\u2718 ${r.title} (${r.status})\n${r.summary || ''}`))
          .join('\n\n')
          .slice(0, 4000);
        const text =
          `[ARKA PLAN GRUP BİTTİ: ${okN}/${g.total}]\n${body}\n\n` +
          `(Supervizyon: parçaları görevle karşılaştır — eksik varsa tamamlama görevi aç.)`;
        emitSafe(this, g.parentId, { type: 'status', status: 'paralel grup tamamlandı' });
        if (!this.isBusy(g.parentId)) {
          this.send(g.parentId, { text });
        } else {
          this._pendingReports = this._pendingReports || [];
          this._pendingReports.push({ parentId: g.parentId, text });
        }
        return true;
      }
      return true; // henüz bekleyen üye var — bireysel rapor bastırılır
    }
    return false; // grup bulunamadı → eski bireysel akış
  }

  /* ---------- paralel ajan kaydı (UI + CEO takip araçları) ---------- */

  /* #17 iş kayıtlarını diske yaz — uygulama kapansa da geçmiş dursun.
     Oturum dosyası silinmiş işler (elle silinmiş) geri yazılmaz. */
  _saveBgJobs() {
    try {
      const jobs = [];
      for (const j of this.listBgJobs().slice(0, 200)) {
        try { fs.accessSync(this._file(j.id)); } catch { continue; }
        const c = { ...j };
        delete c._persisted;
        jobs.push(c);
      }
      fs.writeFileSync(this._bgJobsFile, JSON.stringify({ v: 1, jobs }) + '\n');
    } catch {}
  }

  _loadBgJobsPersisted() {
    let migrated = false;
    try {
      if (!fs.existsSync(this._bgJobsFile)) return;
      const data = JSON.parse(fs.readFileSync(this._bgJobsFile, 'utf8'));
      for (const j of Array.isArray(data.jobs) ? data.jobs : []) {
        if (!j || !j.id) continue;
        /* eski süreçte koşuyor/kuyrukta idi → kimse koşturmuyor: kesildi say */
        if (j.status === 'running' || j.status === 'queued') {
          j.status = 'aborted';
          j.endedAt = new Date().toISOString();
          j.error = String(j.error || '') || 'uygulama kapatıldı — paralel ajan yarıda kesildi';
          migrated = true;
        }
        j._persisted = true;
        this._bgJobs.set(String(j.id), j);
      }
    } catch {}
    if (migrated) this._saveBgJobs();
  }

  _bgEmit() {
    this._saveBgJobs();
    try { this.emit({ type: 'agents', jobs: this.listBgJobs() }); } catch {}
  }

  listBgJobs() {
    return [...this._bgJobs.values()].sort((a, b) =>
      String(b.startedAt).localeCompare(String(a.startedAt))
    );
  }

  /* Tek ajanın detayı: durum + mesaj dökümünün kısa kuyruğu */
  bgDetail(idOrCode) {
    const key = String(idOrCode || '').trim();
    let job = this._bgJobs.get(key);
    if (!job) job = this.listBgJobs().find((j) => j.code === key.toUpperCase()) || null;
    if (!job) return { ok: false, error: 'ajan bulunamadı: ' + key };
    const s = this._load(job.id);
    const brief = (m) => {
      const who = m.role === 'user' ? 'GÖREV' : m.role === 'assistant' ? 'AJAN' : m.role === 'tool' ? 'ARAÇ' : m.role;
      const body = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (p.type === 'text' ? p.text : '[görsel]')).join(' ')
          : '';
      return `${who}: ${String(body || '').replace(/\s+/g, ' ').trim().slice(0, 300)}`;
    };
    const tail = [];
    for (const m of s.messages) {
      if (m.tool_calls && m.tool_calls.length) {
        tail.push(`ARAÇ ÇAĞRISI: ${m.tool_calls.map((t) => (t.function && t.function.name) || '?').join(', ')}`);
        continue;
      }
      const line = brief(m);
      if (line.trim()) tail.push(line);
    }
    return { ok: true, job, messages: tail.slice(-30) };
  }

  /* İş bitişi kaydı: status=done|error|aborted. Hata olursa üst sohbete haber gider. */
  _bgFinish(sid, status, errorMsg) {
    const job = this._bgJobs.get(String(sid));
    if (!job || job.status !== 'running') return;
    job.status = status;
    job.revive = false;
    job.endedAt = nowIso();
    if (errorMsg) job.error = String(errorMsg).slice(0, 400);
    this._bgEmit();
    this._bgResumeQueue(); // #5 slot boşaldı — sıradaki iş başlar
    /* grup üyeliği geçersizse bireysel akışa dön */
    let grouped = false;
    if (job.groupId) {
      const g = this._bgGroups.get(job.groupId);
      if (!g || g.dead) job.groupId = null;
      else grouped = true;
    }
    if (status === 'error') {
      const msg = String(errorMsg || '');
      const cfgIssue = /Model yapılandır|config/i.test(msg);
      /* #16 hatadan sonra otomatik toparlama: aynı oturumda devam hakkı varsa
         CEO'ya hata bildirmeden önce kendini düzeltmeyi dene */
      if (!cfgIssue && (job.fixes || 0) < BG_FIX_MAX) {
        job.fixes = (job.fixes || 0) + 1;
        const quick = /tur limiti/i.test(msg);
        const text = quick
          ? `[ÖZ-DÜZELTME] Tur limiti doldu — araç çağrısı YAPMA, elindeki bulgularla 3-5 satırlık final raporunu yaz ve bitir.`
          : `[HATA SONRASI ÖZ-DÜZELTME ${job.fixes}/${BG_FIX_MAX}] Görev sırasında hata oluştu:\n${msg.slice(0, 220)}\n\nKALDIĞIN YERDEN DEVAM ET: hatayı telafi et (farklı yöntem/araç/parametre); tam yol yoksa elindekiyle EN İYİ KISMİ SONUCU raporla ve bitir.`;
        this._bgKick(job, text);
        return;
      }
      /* #17 öz-kurtarma hakları tükendi → owner'a anlık altyapı uyarısı */
      this._notifyOwnerTaskFailed(job, msg);
      if (grouped) {
        /* #18 hatalı üye de gruba yazılır — birleşik raporda görünecek */
        this._bgGroupRecord(job.title, 'error', 'HATA: ' + msg.slice(0, 300));
        return;
      }
      const text =
        `[ARKA PLAN HATA: ${job.title}]\n${msg || 'bilinmeyen hata'}\n` +
        `(tasks_list / task_status ile detaya bakabilirsin.)`;
      this._pendingReports = this._pendingReports || [];
      this._pendingReports.push({ parentId: job.parentId, text });
      this.flushPendingReports(job.parentId);
    } else if (status === 'aborted') {
      /* İPTAL SEBEBİ ZORUNLU: sebebi kayda yaz ve üst sohbete/gruba bildir */
      const why = String(errorMsg || job.error || 'sebep belirtilmedi').slice(0, 300);
      if (grouped) {
        /* iptal edilen üye gruptan düşmüş sayılır — birleşik raporda SEBEPİYLE görünür */
        this._bgGroupRecord(job.title, 'aborted', 'İPTAL: ' + why);
      } else {
        const text = `[ARKA PLAN İPTAL: ${job.title}]\nSebep: ${why}`;
        this._pendingReports = this._pendingReports || [];
        this._pendingReports.push({ parentId: job.parentId, text });
        this.flushPendingReports(job.parentId);
      }
    }
  }

  /* ---------- superyorizyon: CEO ajanları SAHİPLENİR (#15) ---------- */

  /* Ajan olaylarında son aktivite zamanını güncelle (emit sarmalayıcıdan çağrılır) */
  _bgTrack(ev) {
    if (!ev || !ev.sessionId || !this._bgJobs) return;
    const job = this._bgJobs.get(String(ev.sessionId));
    if (!job || job.status !== 'running') return;
    if (!['status', 'message', 'token', 'tool-start', 'tool-end'].includes(ev.type)) return;
    if (ev.type === 'status' && ev.status === 'idle') return;
    job.lastActivityAt = nowIso();
  }

  /* Saf sınıflandırma (test edilebilir): null | 'stuck' | 'long' */
  static superviseReason(job, nowMs) {
    if (!job || job.status !== 'running') return null;
    const started = Date.parse(job.startedAt || '') || nowMs;
    const lastAct = Date.parse(job.lastActivityAt || '') || started;
    const runMin = (nowMs - started) / 60000;
    const idleMin = (nowMs - lastAct) / 60000;
    const nudgedMin = job.lastNudgeAt
      ? (nowMs - (Date.parse(job.lastNudgeAt) || 0)) / 60000
      : Infinity;
    if (nudgedMin < SUP_NUDGE_COOLDOWN_MIN) return null; // yeni uyardık — boğmayalım
    if (runMin >= SUP_STUCK_START_MIN && idleMin >= SUP_IDLE_MIN) return 'stuck';
    if (runMin >= SUP_LONG_MIN) return 'long';
    return null;
  }

  /* Periyodik denetim: uygun iş varsa önce ajanın KENDİNİ düzeltmesine izin ver,
     haklar biterse ana oturuma (CEO) müdahale emri düşür */
  _supervise() {
    const now = Date.now();
    for (const job of this._bgJobs.values()) {
      const reason = Engine.superviseReason(job, now);
      if (!reason) continue;
      /* #16 öz-kurtarma: takılan ajan CEO'yu meşgul etmeden kendini toparlar */
      if (reason === 'stuck') {
        if ((job.fixes || 0) < BG_FIX_MAX) {
          this._bgSelfHeal(job, now);
        } else {
          /* öz-kurtarma hakları tükendi + hâlâ takılı → ZORLA KAPAT:
             ajan sonsuza dek 'running' kalırsa fan-out grubu ASLA tamamlanmaz
             ve birleşik rapor hiç düşmez — CEO "uyuyor" kalır */
          this._bgForceClose(
            job,
            `superyorizon: ajan ${Math.round((now - Date.parse(job.startedAt)) / 60000)} dk'dır takılı, öz-kurtarma hakları tükendi`
          );
        }
        continue;
      }
      job.lastNudgeAt = nowIso();
      job.checks = (job.checks || 0) + 1;
      const det = this.bgDetail(job.id);
      const tail = det.ok && det.messages.length ? det.messages.slice(-5).join('\n') : '(henüz çıktı yok)';
      const runMin = Math.max(0, Math.round((now - Date.parse(job.startedAt)) / 60000));
      const idleMin = Math.max(0, Math.round((now - (Date.parse(job.lastActivityAt) || now)) / 60000));
      const text =
        reason === 'stuck'
          ? `[SUPERYORIZON] "${job.title}" paralel ajanı ${runMin} dk'dır koşuyor ama son ${idleMin} dk'dır HİÇ hareket yok — büyük olasılıkla TAKILDI.\nSon çıktı:\n${tail}\n\nYAPILACAKLAR: task_status id=${job.id} ile dökümü oku → sorun netse task_cancel id=${job.id} ve düzeltilmiş görevle YENİ run_background aç → kullanıcıya TEK cümleyle durumu bildir. Bu uyarıyı ASLA görmezden gelme.`
          : `[SUPERYORIZON] "${job.title}" paralel ajanı ${runMin} dk'dır koşuyor (aktivite sürüyor).\nSon çıktı:\n${tail}\n\nARA KONTROL yap: hedefe gidiyor mu? Sapma varsa müdahale et (iptal + yeniden görevlendir); yolundaysa beklemeye devam — kullanıcıya gereksiz gürültü çıkarma.`;
      if (!this.isBusy(job.parentId)) {
        this.send(job.parentId, { text });
      } else {
        this._pendingReports = this._pendingReports || [];
        this._pendingReports.push({ parentId: job.parentId, text });
      }
    }
  }

  /* #16 takılan paralel ajanın KENDİ kendini düzeltmesi: asılı tur kesilir,
     aynı oturuma öz-kurtarma emri düşer — CEO sadece haklar bitince devreye girer */
  _bgSelfHeal(job, now) {
    job.lastNudgeAt = nowIso();
    job.checks = (job.checks || 0) + 1;
    job.fixes = (job.fixes || 0) + 1;
    const fixNo = job.fixes;
    const det = this.bgDetail(job.id);
    const tail = det.ok && det.messages.length ? det.messages.slice(-3).join('\n') : '(henüz çıktı yok)';
    const idleMin = Math.max(1, Math.round((now - (Date.parse(job.lastActivityAt) || now)) / 60000));
    const text =
      `[ÖZ-KURTARMA ${fixNo}/${BG_FIX_MAX}] "${job.title}" görevinde son ~${idleMin} dk'dır hiç hareket yok — muhtemelen TAKILDIN.\nSon çıktı:\n${tail}\n\n` +
      `ŞİMDİ KENDİNİ DÜZELT (bunu tartışma, doğrudan uygula):\n` +
      `1) Takılan aracı/adımı bırak, FARKLI bir yöntemle devam et (farklı komut, daha kısa yol, farklı kaynak).\n` +
      `2) Gerekirse görevi küçült: en kritik sonucu üretecek kısma odaklan.\n` +
      `3) Her yolla çıkılmıyorsa engeli TEK cümlede açıkla ve şu ana kadarki EN İYİ KISMİ SONUCU rapor olarak yazıp bitir.`;
    this._bgKick(job, text);
  }

  /* Takılı işi ZORLA sonlandır: tur abort edilir, iş kaydı SEBEPİYLE kapanır,
     grup üyesiyse 'aborted' olarak gruba yazılır → birleşik rapor AKAR,
     CEO "uyumak" yerine hemen sonucu kullanıcıya aktarır. */
  _bgForceClose(job, reason) {
    const sid = String(job.id);
    job.revive = false; /* kick-in-flight guard'ı devre dışı — bu gerçek bir bitiş */
    this._clearKicks(sid);
    this._abortReasons = this._abortReasons || new Map();
    this._abortReasons.set(sid, this._abortReason(reason));
    const ctrl = this.ctrls.get(sid);
    if (ctrl) {
      try { ctrl.abort(); } catch {}
      /* _run catch'i sebebi okuyup _bgFinish('aborted') yapacak */
    } else {
      /* tur zaten yok — kaydı doğrudan kapat */
      this._bgFinish(sid, 'aborted', reason);
    }
    try { log.info('bg', `iş zorla kapatıldı: ${job.title} — ${reason}`); } catch {}
  }

  /* Arka plan oturumuna müdahale: asılı turu kes (ctrl.abort), sonra
      kurtarma mesajını bas. abort → eski _run sonlanır → send yeni tur açar.
      revive bayrağı: /stop veya silme sonrası bekleyen müdahaleler patlamasın. */
  _bgKick(job, text) {
    const sid = String(job.id);
    job.revive = true;
    const ctrl = this.ctrls.get(sid);
    if (ctrl) {
      try { ctrl.abort(); } catch {}
      if (!this._kickTimers) this._kickTimers = new Map();
      clearTimeout(this._kickTimers.get(sid));
      this._kickTimers.set(sid, setTimeout(() => {
        this._kickTimers.delete(sid);
        this._bgKickSend(sid, text);
      }, 1200));
    } else {
      this._bgKickSend(sid, text);
    }
  }

  _clearKicks(sid) {
    if (this._kickTimers && this._kickTimers.has(String(sid))) {
      clearTimeout(this._kickTimers.get(String(sid)));
      this._kickTimers.delete(String(sid));
    }
  }

  _bgKickSend(sid, text) {
    try {
      /* /stop kapısı: durdurulan işe kurtarma kick'i GİTMEZ */
      if (this._stopped) return;
      const j = this._bgJobs.get(String(sid));
      /* silinmiş/durdurulmuş işe geri dönüş yok — hayalet dosya yaratma */
      if (!j || j.revive !== true) return;
      j.revive = false;
      if (!this._load(sid)) return;
      if (j.status !== 'running') { j.status = 'running'; j.endedAt = null; }
      this.send(sid, { text });
      this._bgEmit();
    } catch {}
  }

  /* Eski motor örneğini kapat (reloadBackend) — supervisor zamanlayıcısı durur */
  dispose() {
    if (this._supTimer) {
      clearInterval(this._supTimer);
      this._supTimer = null;
    }
  }

  /* Arka plan oturumu 'done' olduğunda ana sohbete özet basar (main çağırır) */
  async reportBackgroundDone(bgSessionId) {
    try {
      const meta = this._bgMeta && this._bgMeta.get(String(bgSessionId));
      if (!meta) return false;
      /* üst oturum silinmişse rapor düşer — hayalet oturum yaratma */
      if (this._deletedSessions && this._deletedSessions.has(meta.parentId)) {
        this._bgMeta.delete(String(bgSessionId));
        return false;
      }
      /* Öz-kurtarma/wrap-up kick'i bekliyorsa bu bir ABORT turudur — gerçek
         bitiş DEĞİL; erken "ARKA PLAN BİTTİ (sonuca ulaşmadan)" ilanı basma */
      const pendingKick = this._bgJobs.get(String(bgSessionId));
      if (pendingKick && pendingKick.revive === true) return false;
      /* #18 grup üyesiyse bireysel rapor yok — birleşik rapor için sonucu yaz */
      const jobRec = this._bgJobs.get(String(bgSessionId));
      const inGroup = !!(jobRec && jobRec.groupId);
      this._bgFinish(bgSessionId, 'done');
      const s = this._load(String(bgSessionId));
      let lastA = '';
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const m = s.messages[i];
        if (m.role === 'assistant' && m.content && !m.tool_calls) {
          lastA = typeof m.content === 'string' ? m.content : '';
          break;
        }
      }
      const summary = lastA.slice(0, 900) || '(arka plan görevi sonuca ulaşmadan bitti)';
      if (inGroup) {
        this._bgGroupRecord(meta.title, 'done', summary);
        this._bgMeta.delete(String(bgSessionId));
        return true;
      }
      emitSafe(this, meta.parentId, { type: 'status', status: 'arka plan görevi tamamlandı' });
      const text =
        `[ARKA PLAN BİTTİ: ${meta.title}]\n${summary}\n` +
        `(Supervizyon: raporu görevle karşılaştır — EKSİK/YANLIŞ varsa hemen tamamlama görevi aç; "arka plan raporunu göster" dersen tam dökümü incelersin.)`;
      if (!this.isBusy(meta.parentId)) {
        this.send(meta.parentId, { text });
      } else {
        // ana oturum meşgulse sessizce bekle: kullanıcı mesajıyla birlikte akar
        this._pendingReports = this._pendingReports || [];
        this._pendingReports.push({ parentId: meta.parentId, text });
      }
      this._bgMeta.delete(String(bgSessionId));
      return true;
    } catch {
      return false;
    }
  }

  /* Ana oturum işini bitirince bekleyen arka plan raporlarını boşalt.
     Güvenli: oturum SİLİNMİŞSE rapor düşer (hayalet oturum yaratılmaz);
     send başarısızsa (aniden meşgul oldu) rapor sırada kalır, sonra denenir. */
  flushPendingReports(sessionId) {
    if (!this._pendingReports || !this._pendingReports.length) return;
    /* /stop kapısı: abort edilen işlerin iptal raporları ebeveynde YENİ SORGU
       başlatmasın — bekleyen raporlar düşürülür */
    if (this._stopped) {
      this._pendingReports = [];
      return;
    }
    const rest = [];
    for (const r of this._pendingReports) {
      if (r.parentId !== sessionId) { rest.push(r); continue; }
      if (this._deletedSessions && this._deletedSessions.has(sessionId)) continue;
      if (this.isBusy(sessionId)) { rest.push(r); continue; }
      let sent = false;
      try { sent = !!this.send(sessionId, { text: r.text }); } catch {}
      if (!sent) rest.push(r);
    }
    this._pendingReports = rest;
  }

  /* #21 arka plan ajanı İNCE sistem promptu: dev CEO/hafıza/skill blokları yok
     → her turda çok daha az prompt tokeni = hızlı ön-bellek + düşük maliyet */
  buildBgSystem(session) {
    const job = (session && this._bgJobs.get(String(session.id))) || {};
    /* opencode instruction port (bg ajanlar): workspace talimatları + genel ajan disiplini */
    const proj = this._projectInstructions(session);
    return (
      `Sen odaklı bir ARKA PLAN ajanısın. Tek görevini baştan sona bitir.\n` +
      (job.task ? `GÖREV: ${job.task}\n` : '') +
      `Ortam: Windows + PowerShell; çalışma klasörü: ${this.workspace}\n` +
      `GENEL AJAN DİSİPLİNİ: görevi A'dan Z'ye yürüt — bağlam topla, uygula, DOĞRULA; yarım bırakma; doğrulama sonucunu rapora yaz.\n` +
      `DOSYA KURALI: dosya işlemlerinde özel araçları kullan — VAR OLAN dosyayı edit_file ile düzenle, yeniyi write_file ile yaz, okuma/arama read_file/grep/glob; run_command terminal işlerindir (build, git, kurulum). Bir dosyayı BİR KEZ oku — içerik bağlamda kalır, tekrar okuma.\n` +
      (proj ? `PROJE TALİMATLARI (workspace AGENTS/CLAUDE/CONTEXT — daima uy):\n${proj}\n` : '') +
      `HIZ KURALLARI:\n` +
      `- Döngülü işleri (çok URL/dosya/sayfa, tekrarlı parse-hesap) TEK python_run betiğinde topluca bitir.\n` +
      `- Web için web_search kullan (zincir dahili tarayıcıyla başlar — gerçek Chromium ile Google); tek aramada bulunamazsa veya çok kaynaklı derin araştırma gerekiyorsa deep_search kullan (çoklu sorgu paralel + gizli tarayıcıda tam sayfa okuma). Sayfa açma/göstermenin VARSAYILANI DAHİLİ tarayıcıdır: browser_open → browser_snapshot → browser_click/type/read. Kullanıcı açıkça dış tarayıcı (chrome/firefox/başka/normal/kendi tarayıcım) istediyse run_command ile \`start "" <url>\` çalıştır. Görseli göremiyorsan metni ocr_read ile oku (source:"browser").\n` +
      `- Bağımsız araç çağrılarını aynı turda PARALEL ver.\n` +
      `- PDF gerekirse pip\u2019ten paket kurma (Türkçe bozar); Node\u2019un kurulu \`pdf-lib\`+fontkit\u2019iyle .js script yazıp \`node\` ile çalıştır. md→pdf çevirme: belge çıktısını doğrudan PDF olarak üret.\n` +
      `- ARAŞTIRMA SINIRI: 3-5 kaynak yeter; süre hedefi ~3 dakika. 2-3 denemede bulunamayan bilgiyi BIRAK — bulabildiğin kısmi sonucu raporla ve neyi bulamadığını yaz. Kapalı/gizli içerik peşinde koşma.\n` +
      FORMAT_RULES + '\n' +
      `SON ÇIKTI: 3-5 satırlık net sonuç raporu, madde madde. Soru sorma, sohbet etme.`
    );
  }

  /* uzun bg işlerinde geçmiş şişer → payload büyür, hız düşer. Son N mesaj kalsın
     (+ asıl görev mesajı); kopuk tool çifti sınırı hizalanır */
  static BG_KEEP_MSGS = 48;
  _bgTrim(session) {
    const max = Engine.BG_KEEP_MSGS;
    const msgs = session.messages;
    /* bg işleri + Beast Code: uzun geçmiş payload'ı şişirip yavaşlatır */
    if ((!session.bgJob && !session.bcCode) || msgs.length <= max) return;
    let keep = msgs.slice(-max);
    /* GÜVENLİ SINIR: kesim bir assistant(tool_calls) + tool sonuç çiftini BÖLMESİN.
       Yetim 'tool' mesajı ya da sonuçları pencere dışında kalan tool_calls'lı
       asistan mesajı sağlayıcıda "messages parameter is illegal" (HTTP 400) verir. */
    while (keep.length) {
      const f = keep[0];
      if (f.role === 'tool') { keep.shift(); continue; }
      if (f.role === 'assistant' && Array.isArray(f.tool_calls) && f.tool_calls.length) {
        const need = f.tool_calls.length;
        let got = 0;
        for (let i = 1; i < keep.length && keep[i].role === 'tool' && got < need; i++) got++;
        if (got < need) { keep.shift(); continue; }
      }
      break;
    }
    const firstUser = msgs.find((m) => m.role === 'user');
    if (firstUser && !keep.includes(firstUser)) keep.unshift(firstUser);
    session.messages = keep;
  }

  async _chatTurn(session, signal, onDelta, toolsList = TOOLS) {
    /* MCP: %APPDATA%\beast\mcp.json'daki etkin serverların araçlarını şema listesine ekle
       (bağlı değilse lazy bağlanır; kapalıysa liste değişmez; Beast Code paneli hızlı
       ilk-token sözü için MCP'siz kalır) */
    if (!session || !session.bcCode) toolsList = await mcp.mergeTools(toolsList);
    /* opencode agent.ts port: özel ajan tanımı — prompt/model/araç/steps */
    const adef = this._agentDefFor(session, !!session.bgJob);
    /* Beast Code: todo_write açıklaması "3+ adım" kısıtı içerir ve model küçük
       işlerde atlar — bcCode oturumunda HER işte İLK araç olacak şekilde değiştir */
    if (session && session.bcCode) {
      toolsList = toolsList.map((t) =>
        t && t.function && t.function.name === 'todo_write'
          ? {
              ...t,
              function: {
                ...t.function,
                description:
                  'Replace the visible task checklist for this chat. Beast Code session: ALWAYS call this tool as your VERY FIRST action for EVERY job (even tiny 1-step jobs) BEFORE any text or other tool, then update statuses (status:"done") as you complete each step. Keep titles short, verb-first.',
              },
            }
          : t
      );
    }
    const promptText = this._lastUserText(session);
    let system = session.bgJob
      ? this.buildBgSystem(session)
      : session.studio
        ? this.buildStudioSystem(session)
        : session.bcCode
          ? this.buildBcSystem(session)
          : await this.buildSystem(promptText, session);
    // Granül izin: oturumun yetki seviyesine göre araç seti daraltılır.
    // Çoklu izin (ör. web+read) seçiliyse kümeler BİRLEŞİR — hepsinin araçları açık olur.
    const perms = this.sessionPermFor(session.id);
    let allowedSet = null;
    if (!perms.includes('all')) {
      allowedSet = new Set();
      for (const p of perms) for (const t of PERM_TOOL_SETS[p] || []) allowedSet.add(t);
    }
    let activeTools = allowedSet ? toolsList.filter((t) => allowedSet.has(t.function.name)) : toolsList;
    /* bot skill kısıtı: bota verilen yetkiye göre araç seti daraltılır */
    const toolLimit = this.sessionTools.get(String(session.id));
    if (toolLimit) activeTools = activeTools.filter((t) => toolLimit.has(t.function.name));
    /* DM oturumlarında bot_dm KAPALI — botlar botlara DM açıp döngü kuramaz */
    if (session.isBotDm) activeTools = activeTools.filter((t) => t.function.name !== 'bot_dm');
    if (session.bgJob) {
      /* arka plan ajanı: yönetim araçlarını görmez — işini bitirsin */
      activeTools = activeTools.filter((t) => !BG_HIDDEN_TOOLS.has(t.function.name));
    } else if (this.ceoMode) {
      /* CEO: uygulayıcı araçlar kapalı — her şey paralel ajana devredilir */
      activeTools = activeTools.filter((t) => !CEO_EXEC_TOOLS.has(t.function.name));
    }
    if (session.bcCode && session.bcMode === 'plan') {
      /* opencode plan agent: salt-okur zorlaması — araç seti GERÇEKten daralır */
      activeTools = activeTools.filter((t) => PLAN_ALLOW_TOOLS.has(t.function.name));
    }
    if (adef && adef.tools) {
      /* özel ajan araç beyaz listesi — tanımda olmayan araç görünmez */
      const allow = new Set(adef.tools);
      activeTools = activeTools.filter((t) => allow.has(t.function.name));
    }
    if (perms.length === 1 && perms[0] === 'chat') {
      system +=
        '\n\n# KISITLI MOD\nTüm araçların (komut, dosya, web, tarayıcı, hafıza) kapalı. Sadece yazarak cevap ver. ' +
        'Bilgisayarla ilgili bir işlem istenirse bu modda yapamayacağını kibarca söyle.';
    } else if (!perms.includes('all')) {
      const bits = [];
      if (perms.includes('web')) bits.push('web ve tarayıcı araçlarına erişimin var');
      if (perms.includes('read')) bits.push('bilgisayarı SADECE OKUYABİLİRSİN (klasör listeleme, dosya okuma) + web/tarayıcı');
      system +=
        '\n\n# SINIRLI YETKİ\n' + bits.join('; ') + '. ' +
        'Dosya yazma, silme ve komut çalıştırma YOK; istenirse yapamayacağını söyle.';
    }
    /* bot kimliği: bota bağlı oturumlarda kişilik + izolasyon kuralları */
    const botBlock = this._botSystemBlock(session);
    if (botBlock) system += '\n\n' + botBlock;
    if (session.notes) {
      system +=
        `\n\n# OTURUM NOTLARI (oturum ${session.code || '?'} — bu oturumun önceki konuşma özeti; birebir geçmişi buradan hatırla)\n` +
        session.notes;
    }
    if (adef && adef.prompt) {
      system += `\n\n# AJAN: ${adef.name}\n${adef.prompt}`;
    }
    /* önek-cache disiplini (opencode request.ts:184): araç sırası oturum
       boyunca sabit olmalı — alfabetik sıralama sağlayıcı önbelleğini bozmaz */
    activeTools = [...activeTools].sort((a, b) =>
      String(a.function.name).localeCompare(String(b.function.name))
    );
    /* opencode port: model bağlamına göre dinamik bütçe + compaction özeti */
    const selEarly = this.sessionModel.get(String(session.id)) || this.modelFor(null) || this.sel;
    const dynBudget = this._historyBudget(selEarly);
    let payload = this._buildPayload(system, session.messages, session.notes, dynBudget, session.summary);
    // Vision model sadece mesajda görsel varsa devreye girer; terminal ise prompt'un
    // shell/command işi olduğunda. Aksi halde ana model kullanılır.
    let role = this._lastUserHasImage(session) ? 'vision' : null;
    if (!role && /^(?:bash|sh|powershell|cmd|run_command|powershell script|terminal)\b/i.test(String(promptText || '').trim())) {
      role = 'terminal';
    }
    let sel = this.modelFor(role);
    /* bot model override: rol modeli (vision/terminal) yoksa botun kendi seçimi kazanır */
    if (!role) {
      const ssel = this.sessionModel.get(String(session.id));
      if (ssel) sel = ssel;
    }
    /* özel ajan model override — en son söz ajan tanımının */
    if (adef && adef.model) {
      const am = this._resolveRole(String(adef.model));
      if (am) sel = am;
    }
    if (role && this.roleModels[role]) {
      emitSafe(this, session.id, { type: 'status', status: `rol: ${role} → ${sel.providerName} · ${sel.model}` });
    }
    let res;
    try {
      // FALLOUT destekli çağrı: hata olursa zincirdeki sıradaki sağlayıcıya geç
      res = await this._streamWithFallbacks(
        session,
        payload,
        activeTools,
        signal,
        onDelta,
        sel,
        role === 'vision'
      );
    } catch (e) {
      /* GÖRSEL DÖNGÜSÜ KORUMASI: görüntü desteklemeyen model hata verirse görsel
         geçmişte kalır ve sonraki HER mesaj aynı hatayla ölür. Oturumu görsellerden
         arındırıp turu BİR KEZ görüntüsüz dener. */
      const msgStr = String((e && e.message) || '');
      const aborted = signal && signal.aborted;
      const imgish =
        !aborted &&
        /image|vision|multimodal|no endpoints/i.test(msgStr);
      const hasImg =
        !aborted &&
        session.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p && p.type === 'image_url'));
      if (!imgish || !hasImg) throw e;
      const removed = this._sanitizeSessionImages(session);
      if (!removed) throw e;
      emitSafe(this, session.id, {
        type: 'status',
        status: `\u{1F5BC} bu model görüntü girişini desteklemiyor — sohbetten ${removed} görsel kaldırıldı, mesaj görüntüsüz yanıtlanıyor (/change ile görsel destekli modele geçebilirsin)`,
      });
      payload = this._buildPayload(system, session.messages, session.notes, dynBudget, session.summary);
      res = await this._streamWithFallbacks(
        session,
        payload,
        activeTools,
        signal,
        onDelta,
        sel,
        false
      );
    }
    // Gerçek kullanım ile tahmini bütçeyi kalibre et
    const actual = res.usage && res.usage.prompt_tokens;
    if (actual > 0) {
      const predicted = this._payloadTokens(payload);
      if (predicted > 50) {
        const r = clamp(actual / predicted, 0.75, 3);
        this.tokRatio = clamp(this.tokRatio * 0.7 + r * 0.3, 0.75, 3);
      }
    }
    return res;
  }

  /* opencode port (prompt.ts:96-100 + processor cleanup): önceki tur yarıda
     kesildiyse (abort/hata), sonucu gelmeyen tool çağrılarına sentetik hata
     yanıtı yazılır — katı sağlayıcıdaki "messages illegal" (400) önlenir */
  _repairOrphanTools(session) {
    try {
      const msgs = session.messages;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'user') return; // temiz sınır — sorun yok
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          const answered = new Set();
          for (let j = i + 1; j < msgs.length; j++) {
            if (msgs[j].role === 'tool') answered.add(msgs[j].tool_call_id);
          }
          for (const tc of m.tool_calls) {
            if (!tc || !tc.id || answered.has(tc.id)) continue;
            const toolMsg = {
              role: 'tool',
              tool_call_id: tc.id,
              name: (tc.function && tc.function.name) || '',
              content:
                '[araç çalıştırması kesildi — tur iptal/kesinti nedeniyle tamamlanamadı; gerekiyorsa yeniden çağır]',
            };
            msgs.push(toolMsg);
            try { this._append(session, toolMsg); } catch {}
          }
          return;
        }
      }
    } catch {}
  }

  async _run(session) {
    const ctrl = new AbortController();
    this.ctrls.set(session.id, ctrl);
    const sid = session.id;
    const emit = (ev) => this.emit({ ...ev, sessionId: sid });
    try {
      if (!this.sel && !this.sessionModel.get(String(session.id))) throw new Error('Model yapılandırılmadı — %APPDATA%\\beast\\config.yaml ve .env kontrol et');

      /* opencode port: yetim tool_calls onarımı — önceki tur iptal/kesintiye
         uğradıysa sonuç bekleyen araç çağrılarına sentetik hata yanıtı yazılır;
         yoksa katı sağlayıcılar sonraki istekte 400 verir */
      this._repairOrphanTools(session);

      let nudged = false; // görev listesi disiplini: run başına en fazla 1 hatırlatma
      let wrapNudged = false; // tur limitine yaklaşınca zarif kapanış (bg ajanlar)
      let usageTotal = 0; // en yüksek görülen total_tokens — compaction tetiği
      let lastCompactTurn = -99; // opencode: compaction run başına 1 DEĞİL — her taşmada tekrar eder
      /* opencode agent.steps port: özel ajanın kendi tur limiti (2-60).
         ANA OTURUMDA SERT TUR LİMİTİ YOK (opencode birebir): bağlam dolunca
         compaction özetler ve işin ORTASINDA devam eder; sonsuz döngüyü
         doom-loop koruması + kullanıcı ■ kırar. bg ajanlarda kapanış
         disiplini için tavan kalır. */
      const runDef = this._agentDefFor(session, !!session.bgJob);
      const maxTurns = session.bgJob
        ? Math.max(2, Math.min(60, (runDef && runDef.steps) || MAX_TURNS))
        : Infinity;
      const recentSigs = []; // doom-loop dedektörü: son araç imzaları
      /* Beast Code canlı önizleme: run boyunca üretilen eserleri topla —
         iş bitince dahili tarayıcıda CANLI açılır (site/dev server/HTML) */
      const bcArtifacts = session.bcCode ? { html: [], serverUrl: null } : null;
      for (let turn = 0; turn < maxTurns; turn++) {
        /* /STOP: abort edilmişse yeni tur/araç döngüsü AÇILMAZ — hemen
           AbortError fırlat, catch bloğu done(aborted) basar */
        if (ctrl.signal.aborted) {
          const e = new Error('iptal');
          e.name = 'AbortError';
          throw e;
        }
        /* SÜRE SINIRI YOK. Ana oturum sınırsız tur koşar (opencode birebir);
           yalnız bg ajan son 3 tura gelirken "raporu yaz ve bitir" uyarısı alır. */
        if (session.bgJob && turn === maxTurns - 3 && !wrapNudged) {
          wrapNudged = true;
          const wmsg = {
            role: 'user',
            content:
              '[TUR LİMİTİ YAKLAŞIYOR] Kalın son turlar: yeni araştırma/iş AÇMA — şu ana kadarki bulgularınla SON RAPORU yaz ve bitir. Yapılamayanları açıkça "bulunamadı" diye belirt.',
          };
          session.messages.push(wmsg);
          try {
            this._append(session, wmsg);
          } catch {}
          emit({ type: 'message', message: wmsg });
        }
        /* opencode port (prompt.ts:1161 + overflow.ts + processor.ts "compact"):
           bağlam dolduysa compaction — kuyruk korunur, baş özetlenir ve işin
           ORTASINDA devam edilir. Run içinde TEKRAR EDELİR; taze compaction'dan
           hemen sonra hâlâ taşarsa opencode ContextOverflowError gibi güvenli dur. */
        const selNow = this.sessionModel.get(String(sid)) || this.modelFor(null) || this.sel;
        if (this._overContext(session, selNow, usageTotal)) {
          if (turn - lastCompactTurn < 4) {
            throw new Error('ContextOverflow: compaction sonrası bağlam hâlâ model limitinin üstünde — oturum çok büyük');
          }
          lastCompactTurn = turn;
          await this._compactHistory(session, selNow, ctrl.signal);
        }
        this._bgTrim(session); // #21 bg geçmişini olabildiğince ince tut
        emit({ type: 'status', status: 'thinking' });
        const res = await this._chatTurn(session, ctrl.signal, (delta) =>
          emit({ type: 'token', delta })
        );
        /* opencode port (processor.ts:477-482): step-finish usage'ı compaction
           tetiğine besle — gerçek toplam biliniyorsa tahmine gerek kalmaz */
        const uTot =
          res.usage &&
          (res.usage.total_tokens ||
            (res.usage.prompt_tokens || 0) + (res.usage.completion_tokens || 0));
        if (uTot > usageTotal) usageTotal = uTot;

        const assistant = { role: 'assistant', content: res.content || '' };
        if (res.toolCalls && res.toolCalls.length) assistant.tool_calls = res.toolCalls;
        session.messages.push(assistant);
        try {
          this._append(session, assistant);
        } catch {}
        emit({ type: 'message', message: assistant });

        if (!res.toolCalls || !res.toolCalls.length) {
          /* GÖREV LİSTESİ DİSİPLİNİ: ajan işi bitti sanıyor ama listede hâlâ
             bekleyen/aktif madde varsa BİR KEZ hatırlat ve tura devam et —
             liste ya tamamlanmalı ya kalan maddeler listeden düşürülmeli. */
          const todos = session.todos || this.todos.get(sid) || [];
          const pending = todos.filter((t) => t && t.status !== 'done');
          if (pending.length && !nudged) {
            nudged = true;
            const nudge = {
              role: 'user',
              content:
                '[OTOMATİK HATIRLATMA] Görev listende hâlâ tamamlanmamış maddeler var: ' +
                pending.map((t) => '"' + t.title + '"').join(', ') +
                '. Görevi yarım bırakma: eksik adımları ŞİMDİ tamamla; gerçekten yapılmayacaksa listeden düş. todo_write ile listeyi güncelle (status:"done") ve işi kapat.',
            };
            session.messages.push(nudge);
            try {
              this._append(session, nudge);
            } catch {}
            emit({ type: 'message', message: nudge });
            continue;
          }
          /* cevap tamam → done HEMEN: kullanıcı beklemeden yeni iş yazabilsin.
             Not/memory/skill bakımı artık arka planda (_postRunHousekeeping). */
          this._clearCrash();
          this._maybeCompact(sid);
          this._pruneSession(session); // opencode port: eski araç çıktıları temizlenir (fork edilen prune)
          /* Beast Code canlı önizleme: iş bitince üretilen site/app dahili
             tarayıcıda otomatik açılır (dev server öncelikli, sonra HTML) */
          if (bcArtifacts && (bcArtifacts.serverUrl || bcArtifacts.html.length)) {
            const url =
              bcArtifacts.serverUrl ||
              'file:///' +
                path
                  .resolve(
                    this._sessionWorkspace(sid),
                    bcArtifacts.html[bcArtifacts.html.length - 1]
                  )
                  .replace(/\\/g, '/');
            emit({ type: 'bc-preview', url });
          }
          emit({ type: 'done', usage: res.usage || null, meta: res.meta || null });
          this._bgFinish(sid, 'done');
          this.flushPendingReports(sid);
          this._postRunHousekeeping(session, ctrl.signal);
          return;
        }

        // Paralel yürütme — bağımsız çağrılar beklemesin
        session.toolsSinceReflect = (session.toolsSinceReflect || 0) + res.toolCalls.length;
        if (!this._knownToolNames) this._knownToolNames = new Set(TOOLS.map((t) => t.function.name));
        await Promise.all(
          res.toolCalls.map(async (tc) => {
            let name = tc.function && tc.function.name;
            /* opencode port (llm.ts:296-312 repairToolCall): model aracı adını
               yanlış yazdıysa büyük/küçük harf normalizasyonuyle onar — tur kaybı yok */
            if (name && !this._knownToolNames.has(name)) {
              const fixed = TOOLS.find((t) => t.function.name.toLowerCase() === String(name).trim().toLowerCase());
              if (fixed) {
                emitSafe(this, sid, {
                  type: 'status',
                  status: `🔧 araç adı düzeltildi: ${name} → ${fixed.function.name}`,
                });
                name = fixed.function.name;
              }
            }
            let args = {};
            try {
              args = JSON.parse((tc.function && tc.function.arguments) || '{}');
            } catch {}
            emit({ type: 'tool-start', callId: tc.id, name, args });
            emit({ type: 'status', status: name });
            /* opencode port (processor.ts:29 + 356-380): aynı araç + birebir
               aynı argüman 3 kez koştuysa 4.'yü çalıştırma — döngüye para/hız
               akıtma; modele hata bildirimiyle yol göster */
            const sig = name + '\u0000' + String((tc.function && tc.function.arguments) || '');
            const dups = recentSigs.reduce((a, s) => a + (s === sig ? 1 : 0), 0);
            recentSigs.push(sig);
            let out;
            if (dups >= DOOM_LOOP_THRESHOLD) {
              out = JSON.stringify({
                error:
                  `doom-loop: ${name} aynı argümanlarla ${DOOM_LOOP_THRESHOLD} kez çalıştı ve hep aynı sonucu verdi. ` +
                  'Aynı çağrıyı tekrarlamak işe yaramaz — farklı bir yöntem/argüman dene ya da eldeki bilgilerle nihai cevabı ver.',
              });
              emitSafe(this, sid, { type: 'status', status: `⛔ doom-loop: ${name} tekrarı engellendi` });
            } else {
              out = await this._execTool(name, args, ctrl.signal, sid);
            }
            /* Beast Code eser takibi: yazılan HTML + başlatılan dev server */
            if (bcArtifacts) {
              try {
                if (
                  (name === 'write_file' || name === 'edit_file') &&
                  args && args.path && /\.html?$/i.test(String(args.path))
                ) {
                  bcArtifacts.html.push(String(args.path));
                }
                if (name === 'run_command') {
                  const cmdStr = String((args && args.command) || '');
                  const hay = cmdStr + '\n' + String(out || '').slice(0, 6000);
                  const m = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?[^\s'"<>]*/i.exec(hay);
                  if (m) {
                    bcArtifacts.serverUrl = m[0].replace(/[)\].,;:'"]+$/, '');
                  } else {
                    let port = 0;
                    const hs = /python\s+-m\s+http\.server(?:[^\n]*?(\d{2,5}))?/i.exec(cmdStr);
                    if (hs) port = Number(hs[1]) || 8000;
                    else if (/\bvite\b/i.test(cmdStr)) port = 5173;
                    else if (/\bnext dev\b/i.test(cmdStr)) port = 3000;
                    else if (/\bng serve\b/i.test(cmdStr)) port = 4200;
                    else if (/\b(npm (run )?(dev|start)|npx serve|live-server)\b/i.test(cmdStr)) port = 3000;
                    if (port) bcArtifacts.serverUrl = 'http://localhost:' + port;
                  }
                }
              } catch {}
            }
            // Ekran görüntüsü gibi araçlar görseli sonraki tura enjekte eder
            let injectedImage = null;
            /* opencode ctx.metadata portu: edit/write sonucundaki diffView, LLM
               bağlamından AYRI tutulur — yalnız UI'ye gider (kırmızı/yeşil diff) */
            let diffView = null;
            try {
              const obj = JSON.parse(out);
              if (obj && obj.__injectImage) {
                injectedImage = String(obj.__injectImage);
                delete obj.__injectImage;
              }
              if (obj && obj.diffView) {
                diffView = obj.diffView;
                delete obj.diffView;
              }
              if (injectedImage || diffView) out = JSON.stringify(obj);
            } catch {}
            const toolMsg = { role: 'tool', tool_call_id: tc.id, name, content: out.slice(0, name === 'read_file' ? READ_OUT_KEEP : TOOL_OUT_KEEP * 6) };
            if (diffView) toolMsg.diffView = diffView; /* oturum dosyasına da düşer — geçmiş açılınca diff yeniden çizilir */
            session.messages.push(toolMsg);
            try {
              this._append(session, toolMsg);
            } catch {}
            emit({ type: 'tool-end', callId: tc.id, ok: !/"error"/.test(out.slice(0, 200)), result: out.slice(0, 4000), diff: diffView });
            if (injectedImage) {
              const imgMsg = {
                role: 'user',
                content: [
                  { type: 'text', text: '[tarayıcı ekran görüntüsü — bu kareyi analiz et ve devam et]' },
                  { type: 'image_url', image_url: { url: injectedImage } },
                ],
              };
              session.messages.push(imgMsg);
              try { this._append(session, imgMsg); } catch {}
              emit({ type: 'message', message: imgMsg });
            }
          })
        );
      }
      /* yalnız bg ajanlar tavanla buraya düşebilir — ana oturum sınırsız koşar */
      emit({ type: 'done', usage: null });
      this._bgFinish(sid, 'error', 'bg görevi tur limitine ulaştı (maxTurns)');
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || ctrl.signal.aborted);
      if (aborted) {
        this._clearCrash(); // kullanıcı durdurdu — kurtarma yok
        /* öz-kurtarma/superyorizon kick'i bekliyorsa bu tur BİTİŞ değildir —
           işi aborted KAPATMA, kick mesajı yeni turu açar */
        const kickJob = this._bgJobs && this._bgJobs.get(sid);
        if (kickJob && kickJob.revive === true) {
          emit({ type: 'done', aborted: true });
        } else {
          /* İPTAL SEBEBİ ZORUNLU: interrupt() tarafından kaydedilir */
          const why =
            (this._abortReasons && this._abortReasons.get(sid)) ||
            (kickJob && kickJob.error) ||
            'kullanıcı talebiyle iptal edildi';
          if (this._abortReasons) this._abortReasons.delete(sid);
          emit({ type: 'done', aborted: true, reason: why });
          this._bgFinish(sid, 'aborted', why);
        }
      } else {
        // FALLOUT: tüm zincir tükendi — durumu kaydet, açılışta kaldığı yerden devam edilir
        this._saveCrash(sid, e, 'chain-exhausted');
        emit({ type: 'error', error: String((e && e.message) || e) });
        this._bgFinish(sid, 'error', e.message);
        /* #11 self-heal: aynı oturumda 2. hatada log okuyup teşhis başlat */
        this._maybeSelfHeal(sid, e);
      }
    } finally {
      this.ctrls.delete(sid);
      emit({ type: 'status', status: 'idle' });
      /* bekleyen paralel-ajan raporları HER bitiş yolunda boşaltılır —
         hata/durdurma/tur-limiti sonrası bile sonuç raporu kullanıcıya ulaşır.
         DİKKAT: buradan flush'u DOĞRUDAN çağırma! send → _run senkron-hata
         yolunda (model-yok gibi) await'siz zincirlenir → stack taşması.
         Macrotask'a ertele: her hop taze stack alır, pop-gönder sırası bozulmaz. */
      const fl = () => { try { this.flushPendingReports(sid); } catch {} };
      const t = setTimeout(fl, 0);
      if (t.unref) t.unref();
    }
  }

  /* ---------- yansıma: deneyimden skill taslağı (#2) ---------- */

  /* #11 kendini tamir: aynı oturumda 2. hatada son log satırlarını okuyup
     teşhis görevini AYNI oturuma düşürür; agent kendi hatasını analiz eder. */
  _maybeSelfHeal(sid, err) {
    try {
      /* /stop kapısı: durdurulan oturuma teşhis sorgusu AÇILMAZ */
      if (this._stopped) return;
      const key = String(sid);
      this._errCount = this._errCount || new Map();
      const n = (this._errCount.get(key) || 0) + 1;
      this._errCount.set(key, n);
      if (n < 2) return;

      /* tekrar döngüsüne girmesin: sayaç sıfırla, teşhis tek sefer */
      this._errCount.set(key, 0);

      let tail = '';
      try {
        const logfile = path.join(this.sessionsDir, '..', 'wa.log');
        tail = fs.readFileSync(logfile, 'utf8').split('\n').slice(-30).join('\n');
      } catch {}
      if (!tail.trim()) {
        // app log yoksa oturum kaydının son satırlarıyla idare et
        try {
          const raw = fs.readFileSync(this._file(sid), 'utf8').split('\n').filter(Boolean);
          tail = raw.slice(-10).join('\n');
        } catch {}
      }

      const msg =
        `[SELF-HEAL] Bu oturumda art arda 2 hata oluştu. Son hata: ` +
        `${String((err && err.message) || err).slice(0, 200)}\n` +
        `Son günlük satırları:\n${tail.slice(-2500)}\n\n` +
        `Günlüğü incele: sorunun kök nedenini TEK cümleyle teşhis et ve kullanıcıya ` +
        `sadece teşhis + önerilen çözümü bildir. Yeni iş başlatma.`;

      setTimeout(() => {
        try {
          if (!this.isBusy(sid)) {
            emitSafe(this, sid, { type: 'status', status: 'self-heal: teşhis yapılıyor' });
            this.send(sid, { text: msg });
          }
        } catch {}
      }, 1200);
    } catch {}
  }

  /* Oturumda son yansımadan bu yana kaç araç çağrısı biriktiğini sayar.
     Mesajları yeniden taramak yerine imza tutarız: session.toolsSinceReflect */
  /* ---------- otomatik memory döngüsü ----------
     Sohbetten kalıcı değerli bilgiyi (isim, tercih, proje, alışkanlık)
     yakalayıp hafızaya düşürür. mem0-native açıkken: scope bazlı store +
     mem0 FACT_RETRIEVAL + ADD/UPDATE/DELETE konsolidasyonu (bot oturumu
     kendi store'una gider — eskiden yanlışlıkla global hafızaya yazılıyordu).
     Şişmeyi engelleme: her turda DEĞİL, NOTES_TRIGGER mesajda bir; kısa madde;
     dedup (hash + semantic). */
  async _autoMemory(session, signal) {
    try {
      if (!this.sel) return;
      const msgs = session.messages;
      if (msgs.length < 4) return;
      /* son taramadan beri yeterli yeni içerik var mı */
      const since = Number(session.memScanAt ?? -6);
      if (msgs.length - since < 4) return;
      session.memScanAt = msgs.length;

      const slice = msgs.slice(Math.max(0, msgs.length - 10));
      const transcript = this._renderTranscript(slice);
      if (transcript.trim().length < 200) return;

      const llm = async (sys, user) => {
        const res = await chatOnce(
          this.sel,
          { messages: [{ role: 'user', content: sys + '\n\n' + user }], temperature: 0.1 },
          { signal }
        );
        return String(res.content || '');
      };

      /* mem0-native yol */
      if (this.mem0Enabled) {
        const bctx = this._sessionBotCtx(session);
        const scope = bctx ? 'bot:' + bctx.id : 'main';
        const existing = mem0.recentTexts(scope, 30).join('\n');
        const facts = await mem0.extractFacts(llm, transcript.slice(0, 4000), existing, { max: 3 });
        if (!facts.length) return;
        const r = await mem0.add(scope, facts, { llm });
        if (r.ok && (r.added || r.updated || r.deleted)) {
          emitSafe(this, session.id, { type: 'status', status: 'hafıza güncellendi' });
        }
        mem0.syncMirror(scope);
        return;
      }

      /* klasik yol (mem0 kapalı): tek LLM extraction + append */
      const existing = memory.entries().slice(-30).join('\n');
      const prompt =
        'Aşağıdaki konuşma parçasından UZUN VADELİ hatırlanmaya değer bilgileri çıkar ' +
        '(kullanıcının kalıcı tercihleri, projeleri/işleri, isimler, rutinleri).\n' +
        'KURALLAR:\n' +
        '- Sadece haftalar sonra bile işe yarayacak şeyler; geçici detay asla\n' +
        '- En fazla 3 madde, her biri max 120 karakter, "kullanıcı ..." diye başla\n' +
        '- Değerli bilgi yoksa boş dizi\n' +
        `ZATEN KAYITLI olanlar (tekrar ekleme):\n${existing || '(boş)'}\n\n` +
        '# SOHBET\n' + transcript.slice(0, 4000) +
        '\n\nSADECE JSON dön: {"memories": ["...", "..."]} veya {"memories": []}';

      const res = await chatOnce(
        this.sel,
        { messages: [{ role: 'user', content: prompt }], temperature: 0.1 },
        { signal }
      );
      let parsed = null;
      try { parsed = JSON.parse(String(res.content || '').replace(/```(?:json)?|```/g, '').trim()); } catch {}
      const mems = parsed && Array.isArray(parsed.memories) ? parsed.memories : [];
      for (const m of mems.slice(0, 3)) {
        const t = String(m || '').trim().slice(0, 200);
        if (!t) continue;
        const r = memory.append(t);
        if (r.ok && !r.duplicate) emitSafe(this, session.id, { type: 'status', status: 'hafıza güncellendi' });
      }
      /* şişme kontrolü: kayıt sayısı cap'a yaklaşınca hijyen koş */
      if (memory.entries().length > 320) {
        try { memory.hygiene({}); } catch {}
      }
    } catch {}
  }

  async _maybeReflectSkill(session) {
    const since = (session.toolsSinceReflect || 0);
    if (since < this.reflection.minTools) return null;
    if (!this.sel) return null;
    /* derin döngülerde tekrar tetiklenmesin: hemen sıfırla */
    session.toolsSinceReflect = 0;

    const transcript = this._renderTranscript(
      session.messages.filter((m) => m.role !== 'tool').slice(-40)
    );
    if (transcript.length < 400) return null; // çok kısa deneyim değmez

    /* OTOMATİK SKİLL SİSTEMİ: kurulu skill listesi de prompta girer —
       ajan "eski skillden daha kolay/better yol buldum" diyebilmesin, KARAR VERİP
       skilli GÜNCELLESİN. action: create (yeni) | update (mevcutu iyileştir) | none */
const skills = require('./skills');
    const existing = skills
      .scan()
      .map((s) => `- ${s.name}: ${(s.description || '').slice(0, 100)}`)
      .join('\n');

    const prompt =
      'Aşağıdaki agent oturumunda TEKRARLANABİLİR, yeniden kullanılabilir bir prosedür/bilgi birikti mi?\n' +
      'Bir kurulu skill, bu oturumda öğrenilen DAHA KOLAY/DAHA İYİ yöntemle güncellenmeyi hak ediyor mu?\n' +
      'Kullanıcıya özel geçici detaylar (tarih, şehir, numara gibi) skill\u2019e YAZILMAZ — genel yöntem yazılır.\n\n' +
      '# KURULU SKİLLER\n' + (existing || '(yok)') + '\n\n' +
      'SADECE şu JSON formatında cevap ver, başka metin yok:\n' +
      '{"action": "none" | "create" | "update", "name": "kisa-kebab-ad", "description": "tek cümle ne işe yarar", "body": "# Başlık\\n\\nmaddeler halinde adım adım prosedür"}\n\n' +
      'action=create → yeni skill (body: baştan sona tam prosedür)\n' +
      'action=update → "name" MEVCUT skillin adı; body o skillin GÜNCELLENMİŞ TAM HALI (eskiden iyi olan adımları koru, yeni kolaylığı işle)\n' +
      'action=none → değerlenecek bir şey yok\n\n' +
      '# OTURUM ÖZETİ\n' + transcript.slice(0, 6000);

    const res = await chatOnce(
      this.sel,
      { messages: [{ role: 'user', content: prompt }], temperature: 0.2 },
      {}
    );
    const draft = parseReflectionJson(res.content || '');
    if (!draft || !draft.name || !draft.body) return null;

    const action = String(draft.action || (draft.create ? 'create' : 'none')).toLowerCase();
    if (action !== 'create' && action !== 'update') return null;

    if (action === 'update') {
      /* mevcut skillin GÜNCELLENMİŞ hali — doğrudan üzerine (eski hali .bak) */
      const r = skills.upsertSkill({
        name: String(draft.name),
        description: String(draft.description || ''),
        body: String(draft.body),
      });
      return r.ok ? skills.slugify(draft.name) + ' (güncellendi)' : null;
    }

    /* create: otomatik skill modu AÇIKSA taslak beklemeden direkt kur */
    if (this.autoSkills) {
      const r = skills.upsertSkill({
        name: String(draft.name),
        description: String(draft.description || ''),
        body: String(draft.body),
      });
      return r.ok ? skills.slugify(draft.name) : null;
    }
    const r = skills.addDraft({
      name: String(draft.name),
      description: String(draft.description || ''),
      body: String(draft.body),
    });
    return r.ok ? skills.slugify(draft.name) : null;
  }

  /* ---------- BOTLAR ARASI DM (FEATURE) ----------
     Admin bot, 5 haneli kodla başka bota özel mesaj atar; hedef botun cevabı
     senkron döner. İzolasyon: DM turları gizli pair oturumunda yürür, bot_dm
     DM oturumlarında KAPALI (döngü koruması). Tüm trafik admin DM Log'ta. */
  async _botDm(args, sessionId, signal) {
    const bots = require('./bots');
    const code = String((args && args.to) || '').replace(/\D/g, '');
    const message = String((args && args.message) || '').slice(0, 6000);
    if (!/^\d{5}$/.test(code)) return { ok: false, error: 'geçersiz kod — 5 haneli bot kodu gir' };
    if (!message.trim()) return { ok: false, error: 'mesaj boş' };

    const session = this.cache.get(String(sessionId)) || this._load(String(sessionId));
    const senderBotId = (session && session.botId) || 'beast';
    const senderBot = (typeof this.resolveBot === 'function' && senderBotId) ? this.resolveBot(senderBotId) : null;
    const senderIsAdmin = !session.botId || !!(senderBot && senderBot.admin);
    if (!senderIsAdmin) {
      return { ok: false, error: 'yetki yok — botlar arası DM yalnız yönetici (admin) bot tarafından açılabilir' };
    }

    const target = bots.byCode(code);
    if (!target) return { ok: false, error: `bu kotta bot yok: ${code}` };
    if (target.id === senderBotId) return { ok: false, error: 'kendine DM atılamaz' };

    /* deterministik pair oturumu: dm + (küçük kod + büyük kod) — aynı çift aynı oturum */
    const codes = [String(senderBot ? senderBot.code || '' : ''), String(target.code || '')]
      .map((c) => (/^\d{5}$/.test(c) ? c : '00000'))
      .sort();
    const pairId = 'dm' + codes[0] + codes[1];

    let pair = this.cache.get(pairId) || this._load(pairId);
    const fresh = !pair.isBotDm && !pair.messages.length;
    if (!pair.isBotDm) {
      try {
        fs.appendFileSync(this._file(pairId), JSON.stringify({ t: 'botdm', a: senderBotId, b: target.id, at: nowIso() }) + '\n');
      } catch {}
      pair.isBotDm = true;
      pair.dmA = senderBotId;
      pair.dmB = target.id;
    }
    /* hedef botun kimliğiyle çalışsın; izolasyon _botSystemBlock'tan gelir */
    this.setSessionBot(pairId, target.id);
    this.setSessionPerm(pairId, target.perm || 'all');

    const senderName = senderBot ? senderBot.name : 'Beast';
    const senderCode = senderBot && /^\d{5}$/.test(String(senderBot.code || '')) ? senderBot.code : codes[0];
    const prefix = `[BOT DM — gönderen bot: ${senderName} (kod ${senderCode}) — cevabını kısa ve net ver, araç kullanman gerekmiyorsa kullanma]`;
    const before = pair.messages.length;
    const sent = this.send(pairId, { text: prefix + '\n' + message });
    if (!sent) return { ok: false, error: 'DM oturumu başlatılamadı' };

    /* tur bitene kadar bekle (ctrl kaydı düşer), en fazla 120 sn */
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      if (signal && signal.aborted) return { ok: false, error: 'iptal edildi' };
      await new Promise((r) => setTimeout(r, 400));
      if (!this.ctrls.has(pairId)) break;
    }
    if (this.ctrls.has(pairId)) {
      try { this.interrupt(pairId, 'bot DM zaman aşımına uğradı (120 sn) — tur kesildi'); } catch {}
      return { ok: false, error: 'hedef bot zaman aşımına uğradı (120 sn)' };
    }
    const after = this.cache.get(pairId) || pair;
    const newMsgs = after.messages.slice(before);
    const lastA = [...newMsgs].reverse().find((m) => m.role === 'assistant' && m.content && !(m.tool_calls && m.tool_calls.length));
    const reply = lastA ? String(typeof lastA.content === 'string' ? lastA.content : '(medya içerikli cevap)').slice(0, 12000) : '';
    if (!reply.trim()) return { ok: false, error: 'hedef bot cevap vermedi' };
    return { ok: true, from: target.name, code: target.code, reply };
  }

  /* ADMIN İZLEME: tüm botlar arası DM oturumlarının listesi */
  listBotDmSessions() {
    const bots = require('./bots');
    let files = [];
    try {
      files = fs.readdirSync(this.sessionsDir).filter((f) => f.startsWith('dm') && f.endsWith('.jsonl'));
    } catch {}
    const out = [];
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, '');
      const s = this._load(id);
      if (!s.isBotDm || !s.messages.length) continue;
      const a = bots.get(s.dmA);
      const b = bots.get(s.dmB);
      out.push({
        id,
        a: s.dmA,
        b: s.dmB,
        aName: a ? a.name : s.dmA,
        bName: b ? b.name : s.dmB,
        aCode: (a && a.code) || '—',
        bCode: (b && b.code) || '—',
        count: s.messages.length,
        updatedAt: s.updatedAt,
      });
    }
    out.sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
    return out;
  }

  /* ADMIN İZLEME: bir DM oturumunun tam dökümü */
  readBotDm(id) {
    const s = this._load(String(id || ''));
    if (!s || !s.isBotDm) return { ok: false, error: 'DM oturumu yok' };
    return {
      ok: true,
      id: s.id,
      messages: s.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : '[ek/medya]',
      })),
    };
  }

  /* ---------- alt-agent ---------- */

  async _subagent(task, context, parentSignal, sessionId) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (parentSignal) {
      if (parentSignal.aborted) throw new Error('iptal edildi');
      parentSignal.addEventListener('abort', onAbort, { once: true });
    }
    const subTools = TOOLS.filter(
      (t) =>
        t.function.name !== 'delegate_task' &&
        t.function.name !== 'set_reminder' &&
        !t.function.name.startsWith('email_')
    ).sort((a, b) => String(a.function.name).localeCompare(String(b.function.name))); // önek-cache: sabit sıra
    const role = 'subagent';
    const sel = this.modelFor(role) || this.sel;
    if (this.roleModels[role]) {
      emitSafe(this, sessionId, { type: 'status', status: `rol: ${role} → ${sel.providerName} · ${sel.model}` });
    }
    const system =
      `Sen odaklı bir alt-agentsın. Ana ajansın verdiği TEK görevi bitir ve sadece nihai sonucu döndür.\n` +
      `Windows + PowerShell, çalışma klasörü: ${this.workspace}\n` +
      `HIZ KURALI: döngü gerektiren işleri (çok sayfa okuma, çok URL çekme, tekrarlı hesap/parse) TEK python_run betiğinde topluca yap — her adım için ayrı araç turu harcama; 10 fetch = 1 betik = çok daha hızlı görev.\n` +
      `ARAŞTIRMA SINIRI: 3-5 kaynak yeter; 2-3 denemede bulamazsan kısmi sonucu getir, takılma.\n` +
      `Kısa çalış, gereksiz soru sorma, sonucu madde madde raporla.\n` +
      FORMAT_RULES;
    const user = context ? `${task}\n\n# BAĞLAM\n${context}` : task;
    const msgs = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    try {
      for (let turn = 0; turn < SUB_MAX_TURNS; turn++) {
        const res = await chatStreamAuto(
          sel,
          {
            messages: [{ role: 'system', content: system }, ...msgs.slice(1)],
            tools: subTools,
            reasoningEffort: this._thinkEffort(),
            cacheKey: String(sessionId || 'subagent'),
          },
          { signal: ctrl.signal }
        );
        const assistant = { role: 'assistant', content: res.content || '' };
        if (res.toolCalls && res.toolCalls.length) assistant.tool_calls = res.toolCalls;
        msgs.push(assistant);
        if (!res.toolCalls || !res.toolCalls.length) return res.content || '(alt-agent boş döndü)';
        for (const tc of res.toolCalls) {
          let args = {};
          try {
            args = JSON.parse((tc.function && tc.function.arguments) || '{}');
          } catch {}
          const out = await this._subExecTool(tc.function.name, args, ctrl.signal);
          msgs.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: out });
        }
      }
      const last = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content);
      return (last && last.content) || '(tur limiti doldu)';
    } finally {
      if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
    }
  }

  /* web_search zinciri — web_search VE deep_search aynı zinciri kullanır.
     Sıra + aç/kapa Ayarlar → Web Arama'dan değiştirilir (tools.searchChainWeb):
     varsayılan: 1) SearXNG (yerel, ayaktaysa otomatik öne alınır) 2) stealth
     (curl_cffi Chrome TLS taklidi → DDG html) 3) dahili tarayıcı (DİREK
     GOOGLE) 4) TinyFish (anahtar girildiyse) 5) python çoklu-motor. Tarayıcı
     CAPTCHA/trafik verirse 10 dk atlanır — sıradaki motor hemen devreye girer. */
  _webSearchChain(q, n, sessionId, signal) {
    const browserUsable = this.browser && typeof this.browser.search === 'function';
    return tools.searchChainWeb(q, n, {
      signal,
      browser: browserUsable ? () => this.browser.search(q, signal, { sessionId }) : null,
    });
  }

  /* Dahili OCR aracı: görüntüden metin çıkarır (görsel desteklemeyen modeller için).
     Kaynak: 'browser' (dahili tarayıcı görüntüsü, varsayılan) | 'screen' (masaüstü) | dosya yolu. */
  async _ocrRead(args, signal, sessionId) {
    if (!this.ocr) return { ok: false, error: 'OCR kullanılamıyor' };
    const src = String((args && args.source) || 'browser');
    let image = null;
    let via = 'file';
    try {
      if (src === 'browser') {
        via = 'browser';
        if (!this.browser || typeof this.browser.screenshot !== 'function') {
          return { ok: false, error: 'dahili tarayıcı kullanılamıyor' };
        }
        const shot = await this.browser.screenshot(signal, { sessionId });
        if (!shot || !shot.ok) return { ok: false, error: (shot && shot.error) || 'görüntü alınamadı' };
        image = shot.__injectImage || shot.image || null;
      } else if (src === 'screen') {
        via = 'screen';
        if (!this.computer || typeof this.computer.look !== 'function') {
          return { ok: false, error: 'ekran erişimi yok' };
        }
        const shot = await this.computer.look();
        image = typeof shot === 'string' ? shot : (shot && (shot.image || shot.dataUrl)) || null;
      } else {
        const abs = path.isAbsolute(src) ? src : path.join(this.workspace, src);
        if (!fs.existsSync(abs)) return { ok: false, error: 'görsel bulunamadı: ' + src };
        image = abs;
      }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    const r = await this.ocr({ image, lang: String((args && args.lang) || 'tur+eng') });
    return { ...r, via };
  }

  async _subExecTool(name, args, signal) {
    try {
      const blocked = this._guardTool(name, args);
      if (blocked) return blocked;
      if (name === 'memory_write') return JSON.stringify(memory.append(args.text));
      if (name === 'user_write') return JSON.stringify(memory.appendUser(args.text));
      if (name === 'memory_search') {
        return JSON.stringify({
          ok: true,
          query: String(args.query || ''),
          results: memory.search(String(args.query || ''), clamp(Number(args.limit) || 5, 1, 15)),
        });
      }
      if (name === 'ocr_read') return JSON.stringify(await this._ocrRead(args || {}, signal));
      /* opencode general-agent portu: alt-ajan da edit/grep/glob kullanır */
      if (!(name === 'run_command' || name === 'read_file' || name === 'write_file' || name === 'edit_file' ||
            name === 'list_dir' || name === 'grep' || name === 'glob' ||
            name === 'web_search' || name === 'http_fetch' || name === 'webfetch' || name === 'python_run')) {
        return JSON.stringify({ ok: false, error: `unknown tool ${name}` });
      }
      return await tools.exec(name, args, { cwd: this.workspace, signal });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
    }
  }

  /* ---------- tool dispatch ---------- */

  /* Onay gerektiren araçlar — tepkiyle onay kapısına takılır.
     opencode'da edit+write aynı "edit" iznine takılır — burada da ikisi birlikte */
  static RISKY_TOOLS = new Set(['run_command', 'write_file', 'edit_file', 'python_run', 'email_send', 'watcher_add']);

  /* ANA KOD KİLİDİ: yıkıcı işlem desenleri (korumalı yol + bu desen = engel) */
  static DESTRUCTIVE_RE =
    /(remove-item|\bri\s|\bdel\s|\bdel\b|\brd\b|\brmdir\b|\berase\b|set-content|out-file|add-content|new-item|clear-content|move-item|rename-item|\bren\s|\bcopy-item|\bmove\b|\bmv\s|\bcp\s|>>|[^|]>\s|\bicacls|\btakeown|\bformat\b|\bfsutil|\breg\s+(add|delete)|schtasks|stop-process|\btaskkill|\bkill\b|\brm\s|\bunlink|shutil|os\.remove|os\.unlink|open\([^)]*['"][wa]['"]\)|write_text|to_csv\(|savefig\(|\.write\()/i;

  _isProtectedPath(p) {
    try {
      if (!p || !this.protectedDirs.length) return false;
      const raw = String(p).trim();
      const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(this.workspace, raw);
      const norm = abs.replace(/[\\/]+$/, '').toLowerCase().replace(/\//g, '\\');
      return this.protectedDirs.some((d) => norm === d || norm.startsWith(d + '\\'));
    } catch {
      return false;
    }
  }

  /* Komut metni korumalı bölgeye değiyorsa VE yıkıcı bir desen varsa true */
  _cmdTouchesProtected(cmd) {
    if (!cmd || !this.protectedDirs.length) return false;
    const c = String(cmd).toLowerCase().replace(/\//g, '\\');
    return this.protectedDirs.some((d) => c.includes(d)) && Engine.DESTRUCTIVE_RE.test(c);
  }

  /* Engelleyici: korumalı bölgeye müdahaleyi kırar; null = serbest */
  _guardTool(name, args) {
    if (!args || !this.protectedDirs.length) return null;
    const deny = (what) =>
      JSON.stringify({
        ok: false,
        error:
          `ANA KOD KİLİDİ: Beast kendi kaynak koduna ${what} izni yok (korumalı bölge). ` +
          'Okumak serbesttir; kod yalnızca kullanıcının kendi eliyle, dışarıdan değiştirilebilir.',
      });
    if (name === 'write_file' && this._isProtectedPath(args.path)) return deny('yazma');
    if (name === 'edit_file' && this._isProtectedPath(args.path)) return deny('düzenleme');
    if (name === 'run_command' && this._cmdTouchesProtected(String(args.command || ''))) return deny('komutla değiştirme');
    if (name === 'python_run' && this._cmdTouchesProtected(String(args.code || ''))) return deny('betikle değiştirme');
    return null;
  }

  async _execTool(name, args, signal, sessionId) {
    try {
      /* ANA KOD KİLİDİ: korumalı bölgeye yazma/silme girişimi daha kapıdan geçmez */
      const blocked = this._guardTool(name, args);
      if (blocked) return blocked;
      /* onay kapısı: riskli araçta dış onay bekle; reddedilirse araç çalışmaz.
         "always" onaylı araçlar doğrudan geçer. */
      if (
        (Engine.RISKY_TOOLS.has(name) || String(name).startsWith('mcp__')) &&
        !this.alwaysAllowTools.has(name) &&
        this.approvals && typeof this.approvals.request === 'function'
      ) {
        emitSafe(this, sessionId, { type: 'status', status: `onay bekleniyor: ${name}` });
        let ok = false;
        try {
          ok = !!(await this.approvals.request({ sessionId, tool: name, args: args || {} }));
        } catch {}
        if (!ok) {
          return JSON.stringify({
            ok: false,
            error:
              'kullanıcı bu işlemi ONAYLAMADI (iptal edildi veya zaman aşımı). İşlemi yeniden deneme; kullanıcıya sormadan alternatif öner.',
          });
        }
      }
      /* GERİ ALMA GÜNLÜĞÜ: dosya yazımından ÖNCE eski içerik kayda geçer */
      this._journalBefore(sessionId, name, args);
      /* MCP: dış server araçları (mcp__<server>__<tool>) — tools/call'a köprülenir */
      if (String(name).startsWith('mcp__')) {
        return JSON.stringify(await mcp.call(name, args, signal));
      }
      if (name === 'memory_write') {
        /* bot oturumu → botun KENDİ hafıza store'una yaz (global Beast hafızasına değil).
           mem0 açıkken: hash+semantic dedup'lı store'a gider, MEMORY.md aynası güncellenir. */
        const bctx = this._sessionBotCtx(sessionId ? this.cache.get(String(sessionId)) : null);
        if (bctx && this.botMemory) {
          if (this.mem0Enabled) {
            const r = await mem0.add('bot:' + bctx.id, [args.text]).catch(() => null);
            if (r && r.ok) {
              mem0.syncMirror('bot:' + bctx.id);
              return JSON.stringify({ ok: true, duplicate: r.skipped > 0, event: r.events[0] && r.events[0].event });
            }
          }
          return JSON.stringify(this.botMemory.append(bctx.id, args.text));
        }
        if (this.mem0Enabled) {
          const r = await mem0.add('main', [args.text]).catch(() => null);
          if (r && r.ok) {
            mem0.syncMirror('main');
            return JSON.stringify({ ok: true, duplicate: r.skipped > 0, event: r.events[0] && r.events[0].event });
          }
        }
        return JSON.stringify(memory.append(args.text));
      }
      if (name === 'user_write') {
        /* kullanıcı profili (ad/hitap/tercih) → USER.md (bot oturumunda botun kendi USER.md'si) */
        const bctx = this._sessionBotCtx(sessionId ? this.cache.get(String(sessionId)) : null);
        const r =
          bctx && this.botMemory && this.botMemory.appendUser
            ? this.botMemory.appendUser(bctx.id, args.text)
            : memory.appendUser(args.text);
        return JSON.stringify(r);
      }
      if (name === 'memory_search') {
        const bctx = this._sessionBotCtx(sessionId ? this.cache.get(String(sessionId)) : null);
        const q = String(args.query || '');
        const limit = clamp(Number(args.limit) || 5, 1, 15);
        if (bctx && this.botMemory) {
          const rows = this.mem0Enabled
            ? await mem0.search('bot:' + bctx.id, q, { limit }).catch(() => [])
            : [];
          return JSON.stringify({
            ok: true,
            query: q,
            results: rows.length ? rows : this.botMemory.search(bctx.id, q, limit),
          });
        }
        const rows = this.mem0Enabled ? await mem0.search('main', q, { limit }).catch(() => []) : [];
        return JSON.stringify({
          ok: true,
          query: q,
          results: rows.length ? rows : memory.search(q, limit),
        });
      }
      if (name === 'todo_write') {
        const items = sanitizeTodoItems(args.items);
        this._tagTodoIds(sessionId, items); /* her madde kalıcı ID taşır — geri alma buna bağlanır */
        this.todos.set(sessionId, items);
        try {
          fs.appendFileSync(
            this._file(sessionId),
            JSON.stringify({ t: 'todo', items }) + '\n'
          );
        } catch {}
        this.emit({ type: 'todos', sessionId, todos: items });
        const done = items.filter((t) => t.status === 'done').length;
        return JSON.stringify({ ok: true, total: items.length, done, note: 'kullanıcıya gösterildi; her adımda güncelle' });
      }
      if (name === 'delegate_task') {
        const task = String(args.task || '').trim();
        if (!task) return JSON.stringify({ ok: false, error: 'task gerekli' });
        emitSafe(this, sessionId, { type: 'status', status: 'delegate_task' });
        const result = await this._subagent(task, String(args.context || ''), signal, sessionId);
        return JSON.stringify({ ok: true, task, result: String(result).slice(0, 12000) });
      }
      if (name === 'bot_dm') {
        const dmS = this.cache.get(String(sessionId));
        if (dmS && dmS.isBotDm) {
          return JSON.stringify({ ok: false, error: 'DM oturumunda bot_dm kullanılamaz (döngü koruması)' });
        }
        const r = await this._botDm(args, sessionId, signal);
        return JSON.stringify(r);
      }
      if (name === 'send_file') {
        if (typeof this.fileSend !== 'function') {
          return JSON.stringify({ ok: false, error: 'dosya gönderim köprüsü yok' });
        }
        const p = String((args && args.path) || '').trim();
        if (!p) return JSON.stringify({ ok: false, error: 'path gerekli' });
        const r = await this.fileSend(sessionId, p, String((args && args.caption) || ''));
        return JSON.stringify(r);
      }
      if (name === 'run_background') {
        if (args.agent && !agentdefs.get(String(args.agent))) {
          return JSON.stringify({
            ok: false,
            error:
              `ajan tanımı bulunamadı: ${args.agent} — tanımlı ajanlar: ` +
              (agentdefs.list().map((d) => d.name).join(', ') || '(yok)'),
          });
        }
        const r = this.runBackground(sessionId, args.task, args.title, { agent: args.agent ? String(args.agent) : null });
        return JSON.stringify({
          ...r,
          note: 'paralel ajan başladı — ana sohbet açık; bittiğinde özet otomatik gelir',
        });
      }
      if (name === 'run_background_many') {
        const rawList = Array.isArray(args.tasks) ? args.tasks : [];
        const tasks = rawList
          .map((t) => ({ title: String((t && t.title) || ''), task: String((t && t.task) || t || ''), agent: (t && t.agent) ? String(t.agent) : null }))
          .filter((t) => t.task.trim());
        const r = tasks.length
          ? this.runBackgroundMany(sessionId, tasks, String(args.title || ''))
          : { ok: false, error: 'tasks boş' };
        return JSON.stringify({
          ...r,
          note: 'fan-out başladı — eşzamanlılık kuyruğuna girer; hepsi bitince TEK birleşik rapor gelir',
        });
      }
      if (name === 'tasks_list') {
        const jobs = this.listBgJobs();
        return JSON.stringify({ ok: true, jobs });
      }
      if (name === 'task_status') {
        return JSON.stringify(this.bgDetail(String(args.id || args.code || '')));
      }
      if (name === 'task_cancel') {
        const id = String(args.id || '');
        const why = String(args.reason || '').trim() || 'ana ajan (CEO) bu ajanı task_cancel ile iptal etti';
        const ok = this.interrupt(id, why);
        return JSON.stringify(ok
          ? { ok: true, id, reason: why, note: 'Ajan iptal edildi — kullanıcıya MUTLAKA iptal sebebini tek cümleyle açıkla: ' + why }
          : { ok: false, error: 'çalışan ajan yok: ' + id });
      }
      if (name === 'set_reminder') {
        if (!this.reminders || typeof this.reminders.add !== 'function') {
          return JSON.stringify({ ok: false, error: 'hatırlatıcı kullanılamıyor' });
        }
        const r = await this.reminders.add({
          when: args.when,
          message: args.message,
          repeat: args.repeat,
          sessionId,
        });
        return JSON.stringify(r);
      }
      if (name === 'watcher_add' || name === 'watcher_list' || name === 'watcher_remove') {
        if (!this.watchers) {
          return JSON.stringify({ ok: false, error: 'izleyici servisi kullanılamıyor' });
        }
        if (name === 'watcher_list') {
          const rows = this.watchers.list().map((w) => ({
            id: w.id,
            name: w.name,
            kind: w.kind,
            url: w.url || undefined,
            op: w.op,
            value: w.value,
            everyMin: w.everyMin,
            enabled: w.enabled,
            lastValue: w.lastValue,
            lastError: w.lastError || undefined,
          }));
          return JSON.stringify({ ok: true, watchers: rows });
        }
        if (name === 'watcher_add') {
          return JSON.stringify(this.watchers.add({ ...(args || {}), sessionId }));
        }
        return JSON.stringify(this.watchers.remove(String((args && args.id) || '')));
      }
      if (name === 'kb_add' || name === 'kb_search') {
        const kb = require('./kb');
        if (name === 'kb_add') {
          return JSON.stringify(
            kb.add(String(args.title || ''), String(args.text || ''), {
              source: args.source || `oturum:${sessionId}`,
              tags: args.tags,
            })
          );
        }
        const rows = kb.search(String(args.query || ''), clamp(Number(args.limit) || 5, 1, 10));
        return JSON.stringify({
          ok: true,
          query: String(args.query || ''),
          results: rows,
          note: rows.length ? 'kaynakları (citation) cevabında aynen belirt' : 'eşleşme yok',
        });
      }
      if (name === 'memory_hygiene') {
        /* bot hafızası admin tarafından yönetilir — global hijyen dokunmaz */
        const bctx = this._sessionBotCtx(sessionId ? this.cache.get(String(sessionId)) : null);
        if (bctx) {
          return JSON.stringify({ ok: true, removed: 0, remaining: 0, note: 'bot hafızası izoledir — hijyen admin sekmesinden yapılır' });
        }
        const r = memory.hygiene({ maxAgeDays: Number(args.maxAgeDays) || undefined });
        return JSON.stringify(r);
      }
      if (name === 'event_subscribe' || name === 'event_list' || name === 'event_unsubscribe') {
        if (!this.bus) {
          return JSON.stringify({ ok: false, error: 'olay merkezi kapalı — Ayarlar > Entegrasyonlar' });
        }
        if (name === 'event_list') {
          const rows = this.bus.listSubs().filter((s) => s.sessionId === sessionId);
          return JSON.stringify({ ok: true, subscriptions: rows });
        }
        if (name === 'event_subscribe') {
          const r = this.bus.addSub({
            type: args && args.type,
            sessionId,
            op: args && args.op,
            value: args && args.value,
            cooldownMin: args && args.cooldownMin,
          });
          if (r.ok) {
            emitSafe(this, sessionId, { type: 'status', status: `olay aboneliği: ${args.type}` });
          }
          return JSON.stringify(r);
        }
        return JSON.stringify(this.bus.removeSub(String((args && args.id) || '')));
      }
      if (name === 'email_list' || name === 'email_read' || name === 'email_send') {
        if (!this.email || typeof this.email[name === 'email_list' ? 'list' : name === 'email_read' ? 'read' : 'send'] !== 'function') {
          return JSON.stringify({ ok: false, error: 'e-posta kullanılamıyor — Entegrasyonlar\u0027da ayarla' });
        }
        if (name === 'email_list') return JSON.stringify(await this.email.list(args || {}));
        if (name === 'email_read') return JSON.stringify(await this.email.read(args || {}));
        return JSON.stringify(await this.email.send(args || {}));
      }
      if (name === 'computer_look') {
        if (!this.computer || typeof this.computer.look !== 'function') {
          return JSON.stringify({ ok: false, error: 'ekran erişimi yok' });
        }
        emitSafe(this, sessionId, { type: 'status', status: 'ekrana bakıyor' });
        const shot = await this.computer.look();
        if (!shot) return JSON.stringify({ ok: false, error: 'ekran görüntüsü alınamadı' });
        /* görsel sonraki tura vision mesajı olarak enjekte edilir */
        return JSON.stringify({
          ok: true,
          note: 'ekran görüntüsü alındı — görsel aşağıda; koordinatlar 1280x720 tabanlı',
          __injectImage: shot,
        });
      }
      if (name === 'computer_act') {
        if (!this.computer || typeof this.computer.act !== 'function') {
          return JSON.stringify({ ok: false, error: 'fare/klavye erişimi yok' });
        }
        const op = String(args.op || '');
        /* type ve key güvenlik: RISKY davranır ama onay kapısı kapalı; hız sınırı module içinde */
        emitSafe(this, sessionId, { type: 'status', status: `bilgisayar: ${op}` });
        const r = await this.computer.act(op, args || {});
        return JSON.stringify(r);
      }
      if (name === 'deep_search') {
        /* agentic derin araştırma: çoklu sorgu + gizli tarayıcıda sayfa okuma.
           ARAMA zinciri web_search ile BİREBİR AYNI — sıralı zincir
           (SearXNG → stealth → tarayıcı → TinyFish → python; Ayarlar'dan değiştirilir).. */
        try {
          emitSafe(this, sessionId, { type: 'status', status: 'derin araştırma: çoklu sorgu + gizli sayfa okuma' });
        } catch {}
        const deps = {
          search: (q) => this._webSearchChain(q, 10, sessionId, signal),
        };
        if (this.research && typeof this.research.readPage === 'function') {
          deps.readPage = (u) => this.research.readPage(u, signal);
        }
        return JSON.stringify(await research.deepSearch(args || {}, deps, signal));
      }
      if (name === 'web_search') {
        const q = String((args && args.query) || '');
        const n = Number((args && args.max_results) || 8);
        return JSON.stringify(await this._webSearchChain(q, n, sessionId, signal));
      }
      if (name === 'ocr_read') {
        return JSON.stringify(await this._ocrRead(args || {}, signal, sessionId));
      }
      if (name === 'browser_open') {
        if (!this.browser || typeof this.browser.openUrl !== 'function') {
          return JSON.stringify({ ok: false, error: 'dahili tarayıcı kullanılamıyor' });
        }
        const r = await this.browser.openUrl(String(args.url || ''), signal, { sessionId });
        return JSON.stringify(r);
      }
      if (name === 'browser_read') {
        if (!this.browser || typeof this.browser.readText !== 'function') {
          return JSON.stringify({ ok: false, error: 'dahili tarayıcı kullanılamıyor' });
        }
        const r = await this.browser.readText(signal, { sessionId });
        return JSON.stringify(r);
      }
      if (name === 'browser_screenshot') {
        if (!this.browser || typeof this.browser.screenshot !== 'function') {
          return JSON.stringify({ ok: false, error: 'dahili tarayıcı kullanılamıyor' });
        }
        const r = await this.browser.screenshot(signal, { sessionId });
        return JSON.stringify(r);
      }
      if (name === 'browser_snapshot') {
        if (!this.browser || typeof this.browser.snapshot !== 'function') {
          return JSON.stringify({ ok: false, error: 'dahili tarayıcı kullanılamıyor' });
        }
        const r = await this.browser.snapshot(signal, { sessionId });
        return JSON.stringify(r);
      }
      if (name === 'browser_click' || name === 'browser_type' || name === 'browser_press' || name === 'browser_scroll' || name === 'browser_select') {
        if (!this.browser || typeof this.browser.act !== 'function') {
          return JSON.stringify({ ok: false, error: 'dahili tarayıcı kullanılamıyor' });
        }
        const r = await this.browser.act(name.slice(8), args, signal, { sessionId });
        return JSON.stringify(r);
      }
      /* opencode tool registry portu: edit_file/grep/glob ana ajanın da araçları —
         bunlar olmadan model write_file + tam dosya okuma döngüsüne düşer */
      if (!(name === 'run_command' || name === 'read_file' || name === 'write_file' || name === 'edit_file' ||
            name === 'list_dir' || name === 'grep' || name === 'glob' ||
            name === 'web_search' || name === 'http_fetch' || name === 'webfetch' || name === 'python_run')) {
        return JSON.stringify({ ok: false, error: `unknown tool ${name}` });
      }
      return await tools.exec(name, args, { cwd: this._sessionWorkspace(sessionId), signal, wantDiff: true });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
    }
  }

  /* İptal SEBEBİ zorunlu: abort edilen her tur/_bgFinish bu haritadan sebebini
     okur; ajan neden durdurulduğunu kullanıcıya MUTLAKA bildirir. */
  _abortReason(reason) {
    const r = String(reason || '').trim();
    return (r || 'sebep belirtilmedi — iptal talebi').slice(0, 400);
  }

  interrupt(sessionId, reason) {
    const sid = String(sessionId || '');
    const why = this._abortReason(reason);
    const c = this.ctrls.get(sid);
    if (!c) {
      /* koşan tur yok — kuyrukta bekleyen / öz-kurtarma kick'i bekleyen
         paralel ajanı da SEBEPİYLE kes */
      const j = this._bgJobs && this._bgJobs.get(sid);
      if (j && (j.status === 'queued' || j.revive === true)) {
        j.status = 'aborted';
        j.revive = false;
        j.endedAt = nowIso();
        j.error = why;
        this._clearKicks(sid);
        this._bgEmit();
        return true;
      }
      return false;
    }
    this._abortReasons = this._abortReasons || new Map();
    this._abortReasons.set(sid, why);
    c.abort();
    return true;
  }

  /* /stop anahtarı: koşan HER ŞEYİ kes — tüm oturum turları (masaüstü + WA +
     paralel ajanlar) ve bekleyen rapor kuyruğu. Cron/izleyici/olay merkezi
     main katmanında BAĞIMSIZ yaşar — /stop onlara dokunmaz. */
  stopAll() {
    let aborted = 0;
    const why = '/stop: kullanıcı tüm ajanları ve turları durdurdu';
    /* STOP KAPISI: abort sonrası rapor/kick/kurtarma zincirleri YENİ SORGU
       AÇAMAZ — kullanıcı gerçek bir mesaj yazana ya da /start deyinceye dek
       ajan faaliyeti tamamen durur */
    this._stopped = true;
    /* fan-out gruplarını kapat — yarım grup artık birleşik rapor beklemesin */
    if (this._bgGroups) {
      for (const g of this._bgGroups.values()) g.dead = true;
    }
    if (this._bgPendingStart) this._bgPendingStart.clear();
    this._abortReasons = this._abortReasons || new Map();
    for (const [sid, c] of this.ctrls) {
      try { this._abortReasons.set(sid, why); c.abort(); aborted++; } catch {}
      /* abort sonrası _run finally bloğu temizler; paralel ajan kaydını biz işaretleyelim */
      if (this._bgJobs.has(sid)) {
        const job = this._bgJobs.get(sid);
        if (job.status === 'running' || job.status === 'queued') {
          job.status = 'aborted';
          job.endedAt = nowIso();
          job.error = job.error || why;
        }
        job.revive = false; // bekleyen öz-kurtarma gönderimini de öldür
        this._clearKicks(sid);
      }
    }
    /* kuyrukta bekleyenleri de kes */
    for (const j of this._bgJobs.values()) {
      if (j.status === 'queued') {
        j.status = 'aborted';
        j.endedAt = nowIso();
        j.error = j.error || why;
        aborted++;
      }
    }
    if (this._pendingReports && this._pendingReports.length) {
      this._pendingReports = [];
    }
    this._bgEmit();
    return aborted;
  }

  /* /stop kapısını kaldır (/start ya da gerçek kullanıcı mesajıyla) */
  clearStop() {
    this._stopped = false;
  }

  isBusy(sessionId) {
    return this.ctrls.has(String(sessionId));
  }
}

function emitSafe(engine, sessionId, ev) {
  engine.emit({ ...ev, sessionId });
}

const TOOLS = [
  ...tools.definitions,
  {
    type: 'function',
    function: {
      name: 'memory_write',
      description:
        'Append one permanent fact/preference/correction to long-term memory. Use for important user info worth remembering in future chats.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'One concise line to remember forever' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'user_write',
      description:
        'Save or update a fact about the USER in USER.md (name, nickname, language, preferences, ongoing projects, relationships). Call it the moment you learn something durable about the user — even mid-conversation. One concise line per call; same topic overwrites the old line.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'One concise line about the user, e.g. "Adı: Batuhan Bozoklu. Hitap: kanka"' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description:
        'Search long-term memory by keywords. Use when you suspect an old stored fact/preference is relevant but was not included in context.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', description: 'default 5' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description:
        'Replace the visible task checklist for this chat. Use ONLY for multi-step work (3+ steps); do not use for simple questions. Keep titles short; update statuses as you progress; clear the list when done. DISCIPLINE: mark each step done THE MOMENT it is completed; NEVER end your reply while items are still pending/active — the system bounces unfinished lists back.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'active', 'done'] },
              },
              required: ['title'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delegate_task',
      description:
        'Spawn a fresh sub-agent that independently works on ONE self-contained sub-task (with the same tools except delegation) and returns only its final answer. Use for heavy/isolated research or multi-file jobs you want kept off the main context.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Clear, self-contained instructions for the sub-agent' },
          context: { type: 'string', description: 'Optional data/notes the sub-agent needs' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bot_dm',
      description:
        'Send a direct message to ANOTHER BOT by its 5-digit code and receive its answer. Use when the user asks another bot something, invites bots into this chat, or a specialist bot should weigh in. Admin bot only.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: "Target bot's 5-digit code, e.g. 48213" },
          message: { type: 'string', description: 'Message to send to that bot' },
        },
        required: ['to', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description:
        'Schedule a reminder for the user. Without repeat: one-time at the given date+time (compute exact local datetime from ORTAM). With repeat: recurring task — time-of-day comes from `when` and it fires forever at that cadence ("her sabah 09:00" => when=<next 09:00>, repeat=daily). Delivered back to this chat.',
      parameters: {
        type: 'object',
        properties: {
          when: {
            type: 'string',
            description:
              'Local datetime, format YYYY-MM-DDTHH:mm (24h), e.g. 2026-08-27T09:00. For recurring reminders this fixes the hour/minute (and weekday/day-of-month).',
          },
          message: { type: 'string', description: 'What to remind, short and clear' },
          repeat: {
            type: 'string',
            description:
              "Omit for one-time. Recurring presets: 'daily' | 'weekdays' | 'weekly' | 'monthly'; or a raw 5-field cron expression like '0 9 * * *' or '*/30 * * * *'.",
          },
        },
        required: ['when', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'watcher_add',
      description:
        'Create a background watcher that periodically checks something and notifies THIS chat when a condition becomes true (edge-triggered: fires once per crossing; cooldown limits repeats). Use for price alarms ("X altına düşerse haber ver"), battery levels, page change detection.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short label, e.g. "GOLD 2300 alarmı"' },
          kind: { type: 'string', enum: ['web', 'battery'], description: 'web: fetch URL and extract value; battery: local battery percent' },
          url: { type: 'string', description: 'http(s) URL to poll (kind=web, required)' },
          path: {
            type: 'string',
            description:
              "If response is JSON: dot-path to watched value, e.g. 'price.usd' or 'data.0.close' (recommended over re)",
          },
          re: { type: 'string', description: 'If response is HTML/text: regex; first capture group becomes the value' },
          op: {
            type: 'string',
            enum: ['lt', 'lte', 'gt', 'gte', 'eq', 'neq', 'changed'],
            description: "Comparison vs value. Use 'changed' with no value for page-change alerts.",
          },
          value: { type: 'number', description: 'Threshold for numeric ops (not needed for changed)' },
          everyMin: { type: 'number', description: 'Check interval in minutes (default 15, min 1, max 1440)' },
          everySec: { type: 'number', description: 'Check interval in SECONDS (10-8640) — overrides everyMin for fast watchers (e.g. 30 = every 30s)' },
          cooldownMin: { type: 'number', description: 'Min minutes between notifications (default 60)' },
        },
        required: ['name', 'kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'watcher_list',
      description: 'List configured background watchers with their last values and errors.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'watcher_remove',
      description: 'Delete a background watcher by its id (from watcher_list).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kb_add',
      description:
        'Store a durable piece of knowledge (learned fact, procedure, domain insight) into the knowledge base for future sessions. Do NOT store transient chat details. Always set source (where this came from).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title, e.g. "FxPro GOLD seans saatleri"' },
          text: { type: 'string', description: 'The knowledge itself, self-contained, max ~2000 chars.' },
          source: { type: 'string', description: 'Origin: url, file path, or conversation.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Up to 8 short tags.' },
        },
        required: ['title', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kb_search',
      description:
        'Search the knowledge base with TF-IDF ranking. Results come with citations — quote them verbatim when you use a result.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', description: 'default 5, max 10' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_hygiene',
      description:
        'Run memory cleanup: dedupe near-identical MEMORY.md entries and drop very old ones. Run it when the user asks to clean memory, or after many memory_write calls in one session.',
      parameters: {
        type: 'object',
        properties: {
          maxAgeDays: { type: 'number', description: 'Age cutoff in days (default 120).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'event_subscribe',
      description:
        'Subscribe this chat to a live event source (no polling/cron needed). Types: mail:new (incoming email), price:tick (price feed with optional op/value filter e.g. alert when gold-pegged PAXG drops below 2600), fs:changed (workspace file changes), webhook (custom POST events), wa:presence. Notifies THIS chat when the event fires; cooldownMin limits repeats.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['mail:new', 'price:tick', 'fs:changed', 'webhook', 'wa:presence'],
            description: 'Event source to subscribe to.',
          },
          op: { type: 'string', enum: ['lt', 'lte', 'gt', 'gte', 'eq'], description: 'Optional numeric filter on event value (mainly price:tick).' },
          value: { type: 'number', description: 'Threshold for the numeric filter.' },
          cooldownMin: { type: 'number', description: 'Minimum minutes between notifications (default 10).' },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'event_list',
      description: 'List this chat\u2019s active event subscriptions.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'event_unsubscribe',
      description: 'Cancel an event subscription by its id (from event_list).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_background',
      description:
        'Spawn a PARALLEL background agent for a self-contained subtask (e.g. "read this terminal output", "research X", "monitor and summarize"). The main chat is NOT blocked; multiple agents can run at once; when each finishes, its summary report is delivered to this chat automatically. In CEO mode EVERY concrete task goes through here — you never execute work yourself. Keep research SHALLOW: 3-5 sources, ~3 minutes target; if info cannot be found after 2-3 attempts, finish with partial findings and clearly state what was not found — never get stuck.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Self-contained task description with ALL needed context (paths, URLs, constraints, expected output) — the agent cannot see your context.' },
          title: { type: 'string', description: 'Short label shown in the agents tab and notification.' },
          agent: { type: 'string', description: 'Optional custom agent name (defined in %APPDATA%\\beast\\agents\\*.md) — that agent\u2019s prompt/model/tools/step-limit apply.' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tasks_list',
      description:
        'List parallel background agents with status (queued/running/done/error/aborted), titles and timings. Use to report overall progress.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_background_many',
      description:
        "Fan-out: spawn MULTIPLE parallel background agents at once for different steps of the SAME job (e.g. news collection → TR / World / Economy agents in parallel; or research A + scrape B + analyze C). They run concurrently; when ALL finish you get ONE merged report instead of N separate pings. Each task must be self-contained. Use this over repeated run_background when steps are independent.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Group label (e.g. "Haber Taraması")' },
          tasks: {
            type: 'array',
            description: '2-6 independent sub-tasks',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Short label of this step' },
                task: { type: 'string', description: 'Self-contained instruction with all context' },
                agent: { type: 'string', description: 'Optional custom agent name for this step (%APPDATA%\\beast\\agents\\*.md)' },
              },
              required: ['task'],
            },
          },
        },
        required: ['tasks'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_status',
      description:
        'Get one background agent\u2019s live detail by id/code: current status plus a tail of its working transcript. Use when the user asks what an agent found or whether it finished.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'job id or session code from tasks_list' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_file',
      description:
        "Deliver a local file to the user in THIS chat (desktop shows a file card; if this session is a WhatsApp chat the file is sent there as image/document). Use when the user asks for a produced report/PDF/image/export, e.g. 'raporu bana gönder', 'grafik dosyasını at'. path = absolute or workspace-relative.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to workspace)' },
          caption: { type: 'string', description: 'Optional short caption' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_cancel',
      description:
        'Cancel a running background agent by id (from tasks_list). ALWAYS pass reason: a short sentence explaining WHY you are cancelling — it is recorded on the job and you must report it to the user.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reason: { type: 'string', description: 'REQUIRED: why you are cancelling this agent (one short sentence)' },
        },
        required: ['id', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_look',
      description:
        'Take a screenshot of the user\u2019s screen and receive it as an image. Use before computer_act to see the GUI; coordinates are on a 1280x720 basis.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_act',
      description:
        'Control mouse/keyboard on the user\u2019s Windows desktop (GUI automation). Ops: click{x,y}, dblclick{x,y}, rightclick{x,y}, move{x,y}, type{text}, key{combo e.g. "ctrl+s","enter","alt+tab"}, scroll{x,y,dy}. Look first with computer_look, act step by step, look again after acting.',
      parameters: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['click', 'dblclick', 'rightclick', 'move', 'type', 'key', 'scroll'],
          },
          x: { type: 'number' },
          y: { type: 'number' },
          text: { type: 'string', description: 'for op=type (max 2000 chars)' },
          combo: { type: 'string', description: 'for op=key: "enter", "ctrl+s", "alt+tab", "win"' },
          dy: { type: 'number', description: 'for op=scroll: positive = down (-10..10)' },
        },
        required: ['op'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'email_list',
      description:
        'List recent emails from the configured inbox (newest first). Use when the user asks about incoming mail / inbox summary. Returns uid, from, subject, date.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'default 10, max 30' },
          unread: { type: 'boolean', description: 'only unseen mails' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'email_read',
      description: 'Read one email\u0027s full body text by its uid (from email_list).',
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'number' },
        },
        required: ['uid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'email_send',
      description: 'Send an email from the configured account.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'recipient address' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'plain text body' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description:
        'Open a URL in the built-in visible browser panel (JS-rendered pages work). This is the DEFAULT for every "open this site / search this / go to page" request — the user watches the page live in the side panel; ideal for login, SPA and dynamic content. The response ALREADY includes a fresh snapshot with numbered refs — act directly with browser_click/browser_type/browser_select; no separate browser_snapshot needed. Open the OS default (external) browser ONLY when the user explicitly asks for chrome/firefox/another/normal/my-own browser — in that case use run_command with `start "" <url>` instead of this tool.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_read',
      description:
        'Read the visible text of the page currently open in the built-in browser panel.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description:
        'Take a screenshot of the built-in browser panel; the image is shown to you on the next step. Use to visually inspect layouts/charts/captchas-ish pages before acting.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description:
        'List all interactive elements of the built-in browser page as numbered refs: [3] <button> "Gönder". NOTE: every browser action response already includes a fresh snapshot — call this separately only when refs seem stale or you need a re-scan (e.g. after an action whose response had no snapshot). Open popups/calendars/datepickers are listed FIRST. Much more reliable than CSS selectors.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ocr_read',
      description:
        'Built-in OCR (Tesseract) — extract TEXT from an image. Essential for text-only models that cannot see images: instead of browser_screenshot, call this with source="browser" to READ the current built-in browser page (captchas, canvas text, images). source: "browser" (default, current browser page) | "screen" (full desktop) | image file path. lang default "tur+eng". Returns {text}.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '"browser" (default) | "screen" | image file path' },
          lang: { type: 'string', description: 'OCR language, default "tur+eng"' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description:
        'Click an element in the built-in browser. Prefer ref from the latest snapshot (e.g. {"ref":3}); CSS selector or text=X also accepted. The response includes a FRESH snapshot with new refs — continue with those directly instead of calling browser_snapshot again.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'number', description: 'element number from browser_snapshot' },
          selector: { type: 'string', description: 'CSS selector or text=X alternative' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description:
        'Type text into an input/textarea/contenteditable in the built-in browser (prefer ref). Set submit=true to press Enter afterwards. Date/time fields (input type=date/time/month/datetime-local) are set PROGRAMMATICALLY — just send the date as text in any common format ("2026-03-15", "15.03.2026", "15 Mart 2026"); do NOT click the calendar popup. The response includes a FRESH snapshot with new refs.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'number' },
          selector: { type: 'string' },
          text: { type: 'string' },
          submit: { type: 'boolean' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_press',
      description:
        'Press a key (Enter, Tab, Escape, ArrowDown…) on the focused element in the built-in browser; optionally focus a ref first. The response includes a FRESH snapshot with new refs.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          ref: { type: 'number', description: 'optional element to focus first' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description:
        'Scroll the built-in browser page. direction: up | down. The response includes a FRESH snapshot with newly visible refs.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'number', description: 'pixels, default ~0.9x viewport' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_select',
      description:
        'Pick an <option> of a dropdown (<select>) in the built-in browser by value/text (prefer ref). The response includes a FRESH snapshot with new refs. For CUSTOM (JS) dropdowns that are not <select>, click the trigger, then click the [role=option] ref from the snapshot (popups are listed first).',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'number' },
          selector: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['value'],
      },
    },
  },
];

/* ---------- GÖREV (TODO) ID + GERİ ALMA SİSTEMİ ----------
   todo_write maddelerine kalıcı ID (T1, T2…) atanır; write_file/edit_file
   ÖNCESİ dosyanın eski içeriği günlüğe yazılır. Panel bir maddenin
   değişikliklerini TEK TUŞLA önceki kod tabanına döndürebilir. */

Engine.prototype._tagTodoIds = function (sid, items) {
  const key = String(sid || '');
  this._todoSeq = this._todoSeq || new Map();
  this._todoIds = this._todoIds || new Map();
  const map = this._todoIds.get(key) || new Map();
  let seq = this._todoSeq.get(key) || 0;
  for (const it of items || []) {
    const t = String((it && it.title) || '').trim();
    if (!t) continue;
    if (!map.has(t)) map.set(t, 'T' + (++seq));
    it.id = map.get(t);
  }
  this._todoIds.set(key, map);
  this._todoSeq.set(key, seq);
  return items;
};

Engine.prototype._journalBefore = function (sid, name, args) {
  try {
    if (name !== 'write_file' && name !== 'edit_file') return;
    const rel = String((args && args.path) || '').trim();
    if (!rel) return;
    const ws = this._sessionWorkspace(String(sid || ''));
    const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(ws, rel);
    let before = null;
    try { before = fs.readFileSync(abs, 'utf8'); } catch {}
    const todos = this.todos.get(String(sid || '')) || [];
    const cur = todos.find((t) => t && t.status !== 'done') || null;
    const key = String(sid || '');
    this._undoJournal = this._undoJournal || new Map();
    const j = this._undoJournal.get(key) || [];
    j.push({
      todoId: (cur && cur.id) || 'T0',
      title: (cur && cur.title) || '(görev listesi dışı)',
      path: abs,
      before,
      at: nowIso(),
    });
    while (j.length > 120) j.shift();
    this._undoJournal.set(key, j);
  } catch {}
};

Engine.prototype.todoUndoInfo = function (sid) {
  const key = String(sid || '');
  this._undoJournal = this._undoJournal || new Map();
  const todos = this.todos.get(key) || [];
  const j = this._undoJournal.get(key) || [];
  const counts = new Map();
  for (const e of j) counts.set(e.todoId, (counts.get(e.todoId) || 0) + 1);
  return {
    ok: true,
    sessionId: key,
    todos,
    undo: todos.map((t) => ({ id: t.id, files: counts.get(t.id) || 0 })),
    lastTodoId: j.length ? j[j.length - 1].todoId : null,
    busy: this.ctrls.has(key),
  };
};

Engine.prototype.undoTodo = function (sid, todoId) {
  const key = String(sid || '');
  const id = String(todoId || '');
  if (this.ctrls.has(key)) {
    return { ok: false, error: 'ajan şu an çalışıyor — önce ■ ile durdur, sonra geri al' };
  }
  this._undoJournal = this._undoJournal || new Map();
  const j = this._undoJournal.get(key) || [];
  if (!j.some((e) => e.todoId === id)) {
    return { ok: false, error: 'bu görev için kayıtlı değişiklik yok' };
  }
  const done = [];
  /* sondan başa geri sar — en son yazım önce restore edilir */
  for (let i = j.length - 1; i >= 0; i--) {
    const e = j[i];
    if (e.todoId !== id) continue;
    try {
      if (e.before === null) {
        fs.rmSync(e.path, { force: true }); /* madde bu dosyayı YARATMIŞ → sil */
      } else {
        fs.mkdirSync(path.dirname(e.path), { recursive: true });
        fs.writeFileSync(e.path, e.before);
      }
      done.push(e.path);
      j.splice(i, 1);
    } catch {}
  }
  /* madde listede 'pending' kalır — ajan yeniden ele alabilir */
  const todos = this.todos.get(key) || [];
  for (const t of todos) {
    if (t && t.id === id && t.status === 'done') t.status = 'pending';
  }
  this.todos.set(key, todos);
  try {
    fs.appendFileSync(this._file(key), JSON.stringify({ t: 'todo', items: todos }) + '\n');
  } catch {}
  emitSafe(this, key, { type: 'todos', sessionId: key, todos });
  return {
    ok: true,
    todoId: id,
    reverted: done.length,
    paths: [...new Set(done)],
    note: done.length
      ? 'görev geri alındı — dosyalar önceki kod tabanına döndü'
      : 'geri alınacak dosya yok',
  };
};

Engine.prototype.undoLastTodo = function (sid) {
  this._undoJournal = this._undoJournal || new Map();
  const j = this._undoJournal.get(String(sid || '')) || [];
  if (!j.length) return { ok: false, error: 'geri alınacak değişiklik yok' };
  return this.undoTodo(sid, j[j.length - 1].todoId);
};

module.exports = Engine;
module.exports.Engine = Engine;
module.exports.sanitizeTodoItems = sanitizeTodoItems;
module.exports.parseReflectionJson = parseReflectionJson;
module.exports.CEO_EXEC_TOOLS = CEO_EXEC_TOOLS;
module.exports.BG_HIDDEN_TOOLS = BG_HIDDEN_TOOLS;
module.exports.PERM_TOOL_SETS = PERM_TOOL_SETS;
module.exports.PERM_LEVELS = PERM_LEVELS;
module.exports.normalizePerms = normalizePerms;
module.exports.OBSERVE_MARK = OBSERVE_MARK;
