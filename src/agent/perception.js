'use strict';

/* Empati Loop — proaktif algı/event alt sistemi (ana sohbet motorundan bağımsız).
   Boru hattı: SİNYAL → NORMALİZE → DEDUP → UCUZ FİLTRE (LLM) → ÖNCELİK → KUYRUK
   Bu modül saf mantık + olay deposudur; LLM çağrıları (llmFilter) ve sinyal
   toplayıcıları (signals) main.js tarafından enjekte edilir.
   İlke: her sinyal event olmaz, her event büyük modele gitmez, her event
   kullanıcıya bildirilmez. Depo: %APPDATA%\beast\perception\events.json */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { beastRoot } = require('./memory');

const DEFAULTS = {
  enabled: false,
  intervalMin: 15,        // tarama aralığı (3-1440 dk)
  cooldownMin: 30,        // aynı konu için sessizlik (0-10080 dk)
  minNotifyPriority: 60,  // bu kompozit puanın altı yalnız depoya yazılır (0-100)
  maxNotifyPerCycle: 1,   // döngü başına en fazla bildirim (maliyet freni)
  notifyTarget: '',       // bildirim hedefi: '' = bağlı entegrasyonlar | whatsapp | telegram | discord
  filterModel: '',        // ucuz filtre modeli ('provider::model'); boşsa ana model
  interests: '',          // kullanıcı ilgi alanları (relevance ağırlığı)
  newsTopics: '',         // Google News RSS sorguları (virgülle)
  weights: { importance: 0.40, relevance: 0.25, urgency: 0.20, novelty: 0.15 },
};

const EVENT_CAP = 250;    // depo tavanı — eskiler düşer
const SEEN_CAP = 800;     // dedup parmakizi havuzu
const SEEN_TTL = 6 * 3600 * 1000; // aynı olay 6 saat içinde tekrar gelirse yut
const FILTER_MAX = 12;    // tek filtre çağrısında en fazla olay
const NEWS_MAX = 12;      // konu başına en fazla haber adayı

/* ---------- config ---------- */

function clampW(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : d;
}

function mergeCfg(raw) {
  const r = raw || {};
  const num = (v, min, max, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };
  const w = r.weights || {};
  return {
    enabled: r.enabled === true,
    intervalMin: num(r.intervalMin, 3, 1440, DEFAULTS.intervalMin),
    cooldownMin: num(r.cooldownMin, 0, 10080, DEFAULTS.cooldownMin),
    minNotifyPriority: num(r.minNotifyPriority, 0, 100, DEFAULTS.minNotifyPriority),
    maxNotifyPerCycle: num(r.maxNotifyPerCycle, 1, 5, DEFAULTS.maxNotifyPerCycle),
    notifyTarget: ['whatsapp', 'telegram', 'discord'].includes(String(r.notifyTarget || ''))
      ? String(r.notifyTarget)
      : '',
    filterModel: String(r.filterModel || '').trim(),
    interests: String(r.interests || '').slice(0, 400),
    newsTopics: String(r.newsTopics || '').slice(0, 400),
    weights: {
      importance: clampW(w.importance, DEFAULTS.weights.importance),
      relevance: clampW(w.relevance, DEFAULTS.weights.relevance),
      urgency: clampW(w.urgency, DEFAULTS.weights.urgency),
      novelty: clampW(w.novelty, DEFAULTS.weights.novelty),
    },
  };
}

/* ---------- depo ---------- */

function stateFile() {
  return path.join(beastRoot(), 'perception', 'events.json');
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return {
      events: Array.isArray(raw.events) ? raw.events : [],
      seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
      cooldowns: raw.cooldowns && typeof raw.cooldowns === 'object' ? raw.cooldowns : {},
      lastRunAt: raw.lastRunAt || null,
    };
  } catch {
    return { events: [], seen: {}, cooldowns: {}, lastRunAt: null };
  }
}

function saveState(st) {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(st, null, 2));
  } catch {}
}

/* ---------- empati hafızası: sohbet kaydı + öğrenilen ilgi alanları ----------
   Sohbet akışı (chat/WA/TG/DC) main tarafından buraya düşürülür; kullanıcı
   mesajlarından anlamlı kelimeler toplanır, sık geçenler "öğrenilen ilgi
   alanı" olur. Tarama filtresi ve bildirim mesajı bu hafızayla kişiselleşir:
   elle girilen ilgi alanları + öğrenilenler birlikte prompta girer. */

const CHAT_CAP = 120;    // son sohbet kaydı tavanı
const INTEREST_CAP = 24; // öğrenilen ilgi etiketi tavanı
const CHAT_SNIPPET = 220;

const TR_FOLD_MEM = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

function memFold(s) {
  return String(s || '').toLowerCase().replace(/[çğıöşüâîû]/g, (ch) => TR_FOLD_MEM[ch] || ch);
}

/* gereksiz kelimeler — ilgi alanı sayılmaz. Set FOLD'LU kurulur: kelimeler
   zaten memFold ile ASCII'ye indirgendikten sonra arandığı için 'bugün' gibi
   stopword'ler fold'lu haliyle ('bugun') listede olmalı. */
const MEM_STOP_RAW =
  'the and for with this that have from was are were been will would could should ' +
  'bir bu şu o ve ile için gibi ama fakat çok daha en ne mi mı mu mü de da ki ise ya ' +
  'veya yani bana bize sana ona beni bizi seni onun benim bizim senin onları var yok ' +
  'olur olan olarak nasıl neden niye şey şeyi her hem acaba lazım gerek evet hayır ' +
  'tamam tmm kanka abi hocam merhaba selam hey lütfen teşekkür sağol eyvallah bugün ' +
  'yarın dün şimdi sonra önce hala henüz yine tekrar biraz az kadar çünkü eğer ' +
  'yapabilir misin musun isterim istiyorum lazım gerekiyor beast asistan önemli ' +
  'hakkında üzerine konuştuk konuşuyoruz konuşmak kendi aynı başka diğer belki ' +
  'sanırım galiba gerekli olsun olmuyor oluyor bakalım biriyle hangi kim nerede';

const MEM_STOP = new Set(MEM_STOP_RAW.split(/\s+/).map((w) => memFold(w)).filter(Boolean));

function chatFile() {
  return path.join(beastRoot(), 'perception', 'chatmem.json');
}

function loadChatMem() {
  try {
    const r = JSON.parse(fs.readFileSync(chatFile(), 'utf8'));
    return {
      chats: Array.isArray(r.chats) ? r.chats : [],
      learned: r.learned && typeof r.learned === 'object' ? r.learned : {},
    };
  } catch {
    return { chats: [], learned: {} };
  }
}

function saveChatMem(cm) {
  try {
    fs.mkdirSync(path.dirname(chatFile()), { recursive: true });
    fs.writeFileSync(chatFile(), JSON.stringify(cm));
  } catch {}
}

/* Sohbet parçasını hafızaya yaz (kullanıcı + beast cevapları + proaktif mesajlar) */
function rememberConversation(text, channel) {
  try {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_SNIPPET);
    if (t.length < 4) return false;
    const cm = loadChatMem();
    /* birebir tekrar yut */
    if (cm.chats.length && cm.chats[cm.chats.length - 1].t === t) return false;
    cm.chats.push({ ts: new Date().toISOString(), ch: String(channel || 'sohbet').slice(0, 12), t });
    while (cm.chats.length > CHAT_CAP) cm.chats.shift();
    saveChatMem(cm);
    return true;
  } catch {
    return false;
  }
}

/* Kullanıcı mesajından ilgi alanı öğren: fold + stopword temizliği, sayaca yaz */
function learnInterests(text) {
  try {
    const toks = (memFold(text).match(/[a-z0-9_+#.]{3,}/g) || [])
      .filter((w) => !MEM_STOP.has(w) && !/^\d+$/.test(w))
      .slice(0, 12);
    if (!toks.length) return false;
    const cm = loadChatMem();
    const now = Date.now();
    for (const w of toks) {
      const cur = cm.learned[w] || { c: 0, at: 0 };
      cur.c++;
      cur.at = now;
      cm.learned[w] = cur;
    }
    /* tavana in: en sık + en taze etiketler kalır */
    const keys = Object.keys(cm.learned);
    if (keys.length > INTEREST_CAP) {
      keys.sort((a, b) => (cm.learned[b].c - cm.learned[a].c) || (cm.learned[b].at - cm.learned[a].at));
      for (const k of keys.slice(INTEREST_CAP)) delete cm.learned[k];
    }
    saveChatMem(cm);
    return true;
  } catch {
    return false;
  }
}

/* Elle girilen + öğrenilen ilgi alanları birleşik (promptlar bunu kullanır) */
function combinedInterests(cfg) {
  const manual = String((cfg && cfg.interests) || '').trim();
  try {
    const cm = loadChatMem();
    const learned = Object.keys(cm.learned)
      .sort((a, b) => cm.learned[b].c - cm.learned[a].c)
      .slice(0, 12);
    return [manual, learned.join(', ')].filter(Boolean).join(', ');
  } catch {
    return manual;
  }
}

/* Son konuşma satırları — compose/filtre promptuna bağlam olarak girer */
function chatContextLine(max = 8) {
  try {
    const cm = loadChatMem();
    const items = cm.chats.slice(-Math.max(1, Number(max) || 8));
    if (!items.length) return '';
    const when = (iso) => {
      try {
        const d = new Date(iso);
        return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2);
      } catch { return ''; }
    };
    return (
      'SON KONUŞMALAR (kullanıcıyla yakın zamanda konuşulanlar):\n' +
      items.map((c) => '- [' + when(c.ts) + ' ' + (c.ch || 'sohbet') + '] ' + c.t).join('\n')
    );
  } catch {
    return '';
  }
}

/* UI için hafıza görünümü: öğrenilen etiketler + son konuşmalar */
function memSnapshot(limit = 40) {
  const cm = loadChatMem();
  const learned = Object.keys(cm.learned)
    .sort((a, b) => (cm.learned[b].c - cm.learned[a].c) || (cm.learned[b].at - cm.learned[a].at))
    .slice(0, 30)
    .map((w) => ({ w, c: cm.learned[w].c || 0 }));
  const n = Math.max(1, Math.min(80, Number(limit) || 40));
  return { learned, chats: cm.chats.slice(-n).reverse(), total: cm.chats.length };
}

function memClear() {
  try {
    fs.rmSync(chatFile(), { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- normalize / dedup ---------- */

function normTitle(t) {
  const base = String(t || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return base.split(' ').slice(0, 12).join(' ');
}

function fingerprint(type, title) {
  return crypto.createHash('sha1').update(normTitle(type + '|' + title)).digest('hex').slice(0, 14);
}

/* cooldown anahtarı: konunun ilk 5 kelimesi — varyasyonlar aynı kovaya düşer */
function topicKey(type, title) {
  return normTitle(type + ' ' + title).split(' ').slice(0, 5).join(' ');
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function normalizeRaw(item) {
  const title = String((item && item.title) || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!title) return null;
  const type = String((item && item.type) || 'news').slice(0, 24);
  return {
    id: uid(),
    ts: item.ts || new Date().toISOString(),
    source: String((item && item.source) || type).slice(0, 40),
    type,
    title,
    detail: String((item && item.detail) || '').slice(0, 300),
    sources: [(item && item.source) || type],
    scores: {},
    priority: 0,
    reason: '',
    status: 'new',
    level: '',
    text: '',
    notifiedAt: null,
  };
}

/* ---------- haber kaynağı (Google News RSS — anahtar gerektirmez,
   Reuters/BBC/AP gibi kaynakları zaten tek beslemede harmanlar) ---------- */

async function fetchNews(topics) {
  const out = [];
  for (const q of (topics || []).slice(0, 4)) {
    try {
      const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=tr&gl=TR&ceid=TR:tr';
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const xml = await res.text();
      const re = /<item>[\s\S]*?<\/item>/g;
      let m;
      let count = 0;
      while ((m = re.exec(xml)) && count < NEWS_MAX) {
        const t = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(m[0]);
        const title = t ? String(t[1]).replace(/\s+/g, ' ').trim() : '';
        if (!title) continue;
        count++;
        out.push({ type: 'news', title, detail: 'Google News · ' + q, source: 'news:' + q });
      }
    } catch {}
  }
  return out;
}

/* ---------- ucuz deterministik puanlayıcı (LLM yoksa/çökerse fallback) ---------- */

const URGENT_RE = /acil|critical|son dakika|outage|arıza|crash|down|kesinti|kapatıldı|breach|güvenlik|saldırı|risk/i;

function heuristicScores(ev, cfg) {
  const t = normTitle(ev.title);
  const URGENT = URGENT_RE.test(t);
  let importance = ev.type === 'news' ? 40 : 65;
  if (URGENT) importance += 20;
  /* ilgi kelimeleri fold'lanır (öğrenilen etiketler zaten fold'lu) */
  const words = String(cfg.interests || '').split(/[,\s]+/).map((w) => memFold(w).trim()).filter((w) => w.length > 2);
  let hits = 0;
  const hay = memFold(t);
  for (const w of words) if (hay.includes(w)) hits++;
  const relevance = hits ? Math.min(100, 55 + hits * 15) : (ev.type === 'news' ? 30 : 60);
  const urgency = URGENT ? 75 : (ev.type === 'news' ? 35 : 45);
  const novelty = ev.type === 'news' ? 80 : 60;
  return { importance, relevance, urgency, novelty };
}

function compositePriority(scores, cfg) {
  const w = cfg.weights;
  const s = (x) => Math.max(0, Math.min(100, Number(x) || 0));
  const sum = w.importance + w.relevance + w.urgency + w.novelty || 1;
  return Math.round(
    (s(scores.importance) * w.importance +
      s(scores.relevance) * w.relevance +
      s(scores.urgency) * w.urgency +
      s(scores.novelty) * w.novelty) / sum
  );
}

/* ---------- LLM filtre promptu / ayrıştırıcı ---------- */

const FILTER_SYSTEM =
  'Sen bir bilgi filtresisin; sohbet etmezsin. Sana verilen olayları değerlendirip YALNIZCA JSON döndürürsün. ' +
  'Skorlar 0-100 arası tamsayı. "relevant": kullanıcının ilgi alanlarıyla alakalı mı. ' +
  '"notify": kullanıcıya bildirmeye gerçekten değer mi (önemsiz/spam/klasik haberlerde false). ' +
  '"reason": en fazla 60 karakter kısa gerekçe.';

function filterPrompt(events, interests, chatCtx) {
  const list = events.map((e) => ({
    id: e.id,
    type: e.type,
    title: e.title,
    detail: e.detail,
  }));
  return (
    'KULLANICI İLGİLERİ: ' + (String(interests || '').trim() || '(belirtilmemiş)') + '\n' +
    (String(chatCtx || '').trim() ? String(chatCtx).trim() + '\n' : '') +
    'OLAYLAR:\n' + JSON.stringify(list) + '\n\n' +
    'Her olay için {"id","relevant","importance","urgency","novelty","notify","reason"} içeren ' +
    'TEK bir JSON dizisi döndür. Sadece JSON, başka metin yok.'
  );
}

function parseFilterJson(text) {
  try {
    let s = String(text || '').replace(/```(?:json)?/gi, '');
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    if (a < 0 || b <= a) return [];
    const arr = JSON.parse(s.slice(a, b + 1));
    if (!Array.isArray(arr)) return [];
    const map = new Map();
    for (const it of arr) {
      if (it && it.id !== undefined) map.set(String(it.id).toLowerCase(), it);
    }
    return map;
  } catch {
    return [];
  }
}

/* ---------- ana LLM compose promptu / fallback ---------- */

const COMPOSE_SYSTEM =
  'Beast adlı yerel yardımcı için proaktif bildirim metni yazarsın. Türkçe, samimi "kanka" tonunda, ' +
  'EN FAZLA 2 kısa cümle: ne olduğunu soyutla, neden önemli olabileceğini söyle, istersen tek kısa soru sor. ' +
  'Alarm spam\'i yok; başlık/emoji/Markdown ekleme, yalnız düz metin yaz.';

function composePrompt(ev, cfg) {
  const ctx = chatContextLine(5);
  return (
    'OLAY: ' + ev.title + '\n' +
    (ev.detail ? 'DETAY: ' + ev.detail + '\n' : '') +
    'KAYNAK: ' + ev.source + '\n' +
    'ÖNCELİK: ' + ev.priority + '/100 · ' + (ev.reason || '') + '\n' +
    'KULLANICI İLGİLERİ: ' + (combinedInterests(cfg) || '(belirtilmemiş)') + '\n' +
    (ctx ? ctx + '\n' : '') +
    '\nBu olay için kullanıcıya gönderilecek proaktif kısa mesajı yaz.'
  );
}

function composeFallback(ev) {
  return ev.title + (ev.detail ? ' — ' + ev.detail : '');
}

/* ---------- döngü ---------- */

/* signals: { self: async()=>[raw], news: async()=>[raw] } — her biri bağımsız;
   biri çökerse diğerleri çalışmaya devam eder. llmFilter: async(prompt)=>text. */
async function runCycle({ cfg, signals, llmFilter, now = new Date(), log = () => {} }) {
  const t0 = Date.now();
  log('cycle başladı');
  const st = loadState();
  const raws = [];
  const srcStats = {};
  for (const [name, fn] of Object.entries(signals || {})) {
    if (typeof fn !== 'function') continue;
    try {
      const items = (await fn()) || [];
      srcStats[name] = items.length;
      for (const it of items) {
        const ev = normalizeRaw(it);
        if (ev) raws.push(ev);
      }
    } catch (e) {
      srcStats[name] = 'hata: ' + String((e && e.message) || e).slice(0, 60);
    }
  }
  log('sinyaller: ' + JSON.stringify(srcStats));

  /* dedup: havuzda taze parmakizi varsa yut; toplu içinde tekrar varsa birleştir */
  const pending = [];
  let dups = 0;
  for (const ev of raws) {
    const fp = fingerprint(ev.type, ev.title);
    const seenAt = st.seen[fp];
    if (seenAt && now.getTime() - seenAt < SEEN_TTL) {
      dups++;
      continue;
    }
    st.seen[fp] = now.getTime();
    const same = pending.find((p) => p._fp === fp);
    if (same) {
      if (!same.sources.includes(ev.source)) same.sources.push(ev.source);
      dups++;
      continue;
    }
    ev._fp = fp;
    pending.push(ev);
  }
  /* parmakizi havuzu tavanı — en eskiyi düşür */
  const seenKeys = Object.keys(st.seen);
  if (seenKeys.length > SEEN_CAP) {
    seenKeys.sort((a, b) => st.seen[a] - st.seen[b]);
    for (const k of seenKeys.slice(0, seenKeys.length - SEEN_CAP)) delete st.seen[k];
  }

  /* UCUZ FİLTRE: tüm adaylar TEK toplu çağrıda (maliyet freni). Çökerse deterministik.
     İlgi alanları: elle girilen + sohbetlerden öğrenilenler; son konuşmalar bağlam. */
  const interests = combinedInterests(cfg);
  const chatCtx = chatContextLine(8);
  let graded = null;
  if (typeof llmFilter === 'function' && pending.length) {
    try {
      const out = await llmFilter(filterPrompt(pending.slice(0, FILTER_MAX), interests, chatCtx));
      graded = parseFilterJson(out);
      if (graded.size) log('filtre: LLM ' + graded.size + ' olayı puanladı');
    } catch {
      graded = null;
    }
  }
  if (!graded || !graded.size) log('filtre: deterministik puanlama');

  const counts = { ignored: 0, stored: 0, queued: 0, dup: dups, raw: raws.length };
  const actions = [];
  for (const ev of pending) {
    const g = graded && graded.get(String(ev.id).toLowerCase());
    ev.scores = g
      ? {
          importance: Math.max(0, Math.min(100, Math.round(Number(g.importance) || 0))),
          relevance: Math.max(0, Math.min(100, Math.round(Number(g.relevance) || 0))),
          urgency: Math.max(0, Math.min(100, Math.round(Number(g.urgency) || 0))),
          novelty: Math.max(0, Math.min(100, Math.round(Number(g.novelty) || 0))),
        }
      : heuristicScores(ev, { ...cfg, interests });
    ev.priority = compositePriority(ev.scores, cfg);
    ev.reason = g ? String(g.reason || '').slice(0, 80) : 'deterministik puan';
    if (g && g.notify === false && ev.priority < cfg.minNotifyPriority) {
      ev.status = 'ignored';
      counts.ignored++;
    } else if (ev.priority < 30) {
      ev.status = 'ignored';
      counts.ignored++;
    } else {
      const key = topicKey(ev.type, ev.title);
      const cd = st.cooldowns[key];
      if (cd && now.getTime() < cd.until && ev.priority < (cd.lastPriority || 0) + 15) {
        ev.status = 'stored';
        ev.reason = (ev.reason || '') + ' · sessizlik penceresi';
        counts.stored++;
      } else if (ev.priority < cfg.minNotifyPriority) {
        ev.status = 'stored';
        counts.stored++;
      } else {
        ev.status = 'queued';
        counts.queued++;
        actions.push({
          event: ev,
          level: ev.priority >= 80 ? 'high' : 'medium',
        });
      }
    }
    st.events.push(ev);
  }

  /* kuyruğu önceliğe göre kes — döngü başına en fazla maxNotifyPerCycle bildirim */
  actions.sort((a, b) => b.event.priority - a.event.priority);
  const kept = actions.slice(0, cfg.maxNotifyPerCycle);
  const dropped = actions.slice(cfg.maxNotifyPerCycle);
  for (const a of dropped) {
    a.event.status = 'stored';
    a.event.reason += ' · kuyruk tavanı';
    counts.stored++;
  }
  counts.queued = kept.length;

  /* depo tavanı */
  if (st.events.length > EVENT_CAP) st.events = st.events.slice(st.events.length - EVENT_CAP);

  st.lastRunAt = now.toISOString();
  saveState(st);
  log(
    'cycle tamam: raw=' + counts.raw + ' dup=' + dups +
    ' ignored=' + counts.ignored + ' stored=' + counts.stored + ' queued=' + counts.queued +
    ' (' + (Date.now() - t0) + 'ms)'
  );
  return { summary: counts, actions: kept };
}

function markNotified(id, level, text, cooldownMin) {
  const st = loadState();
  const ev = st.events.find((e) => e.id === id);
  if (ev) {
    ev.status = 'notified';
    ev.level = level || 'medium';
    ev.text = String(text || '').slice(0, 600);
    ev.notifiedAt = new Date().toISOString();
    const key = topicKey(ev.type, ev.title);
    st.cooldowns[key] = {
      until: Date.now() + Math.max(0, Number(cooldownMin) || 0) * 60000,
      lastPriority: ev.priority,
      notifiedAt: ev.notifiedAt,
    };
    saveState(st);
  }
}

function listEvents(limit) {
  const st = loadState();
  const n = Math.max(1, Math.min(200, Number(limit) || 60));
  return st.events.slice(-n).reverse().map((e) => ({
    id: e.id,
    ts: e.ts,
    source: e.source,
    type: e.type,
    title: e.title,
    detail: e.detail,
    priority: e.priority,
    scores: e.scores || {},
    reason: e.reason,
    status: e.status,
    level: e.level,
    text: e.text,
  }));
}

function lastRunAt() {
  return loadState().lastRunAt;
}

module.exports = {
  DEFAULTS,
  mergeCfg,
  fetchNews,
  runCycle,
  markNotified,
  listEvents,
  lastRunAt,
  rememberConversation,
  learnInterests,
  combinedInterests,
  chatContextLine,
  memSnapshot,
  memClear,
  FILTER_SYSTEM,
  COMPOSE_SYSTEM,
  filterPrompt,
  composePrompt,
  composeFallback,
  fingerprint,
};
