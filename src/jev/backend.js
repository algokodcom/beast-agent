'use strict';
const { app, shell, Notification } = require('electron');
/* Beast gömülü mod: JevTrader bağımsız pencere açmaz; tüm IPC kanalları
   'jev:' önekiyle kaydedilir (Beast kanallarıyla çakışmaz). */
const jipc = require('./ipc');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const mt5bridge = require('./mt5bridge');
const cryptomod = require('./crypto');
const papermod = require('./paper');
const journalmod = require('./journal');
const apiserver = require('./api');
const { WhatsAppBridge } = require('./integrations/whatsapp');
const { TelegramBridge } = require('./integrations/telegram');
const { DiscordBridge } = require('./integrations/discord');

const APP_DIR = path.join(app.getPath('appData'), 'jevtrader');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const SETTINGS_BACKUP_FILE = path.join(APP_DIR, 'settings.backup.json');
const SKILLS_FILE = path.join(APP_DIR, 'skills.json');
fs.mkdirSync(APP_DIR, { recursive: true });
/* yerel deneme hesabı durumu (pozisyon/emir/geçmiş) bu dosyada tutulur */
papermod.init(path.join(APP_DIR, 'paper.json'));
/* kalıcı performans hafızası + karar günlüğü (öğrenme katmanı) */
journalmod.init(path.join(APP_DIR, 'journal.json'));

/* GÖMÜLÜ MOD: bağımsız pencere yok — Beast webview WebContents'ine bağlanan
   hafif shim. Olaylar (news/mt5/intg/chat) bu WebContents'e gönderilir. */
let win = null;
function makeWinShim(wc) {
  return {
    webContents: wc,
    isDestroyed: () => !wc || wc.isDestroyed(),
    isMaximized: () => false,
    minimize() {},
    maximize() {},
    unmaximize() {},
    flashFrame() {},
    close() {},
    show() {},
    focus() {},
  };
}
function setWebContents(wc) {
  win = wc ? makeWinShim(wc) : null;
}
const APP_VERSION = '0.1.0';
const VERSION_FILE = path.join(__dirname, 'version.json');

function loadCodeVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    return {
      version: String(v.version || APP_VERSION).slice(0, 24),
      build: Math.max(1, Math.round(Number(v.build) || 1)),
      updatedAt: String(v.updatedAt || ''),
      note: String(v.note || '').slice(0, 200),
    };
  } catch {}
  return { version: APP_VERSION, build: 1, updatedAt: '', note: '' };
}

let codeVersion = loadCodeVersion();

function bumpCodeVersion(note) {
  try {
    codeVersion = {
      version: codeVersion.version || APP_VERSION,
      build: (Number(codeVersion.build) || 1) + 1,
      updatedAt: new Date().toISOString(),
      note: String(note || '').slice(0, 200),
    };
    fs.writeFileSync(VERSION_FILE, JSON.stringify(codeVersion, null, 2), 'utf8');
  } catch (e) {
    console.error('bumpCodeVersion hata:', (e && e.message) || e);
  }
}

const USER_AGENT = 'JevTrader/' + APP_VERSION;
/* OpenCode Go icin zorunlu: sohbet basina sabit oturum kimligi (x-opencode-session) */
function openCodeHeaders(base, sessionId) {
  const sid = String(sessionId || '').replace(/[^\w.-]/g, '').slice(0, 64) || 'main';
  return { 'x-opencode-session': 'jevtrader-' + sid };
}
function isOpenCode(base) {
  return /opencode\.ai/i.test(String(base || ''));
}

/* ---------- ayarlar ---------- */
let settings = loadSettings();

/* entegrasyon izin listesi normalizasyonu: '*', {num|id, name} — bot/perm alanları atılır */
function normAllowList(list, key) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (e === '*') { out.push('*'); continue; }
    if (typeof e === 'string') {
      const v = String(e).replace(/^@/, '').trim();
      if (v) out.push({ [key]: v, name: '' });
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    const v = String(e[key] || '').trim();
    if (!v) continue;
    out.push({ [key]: v, name: String(e.name || '').trim().slice(0, 40) });
    if (out.length >= 200) break;
  }
  return out.slice(0, 200);
}

/* düşünme (reasoning) seviyesi: 0 kapalı … 5 max — Beast Agent ile aynı */
function clampThink(v) {
  return Math.min(5, Math.max(0, Math.round(Number(v) || 0)));
}

function parseSettingsText(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bozuk yapi');
  if (!Array.isArray(parsed.providers)) parsed.providers = [];
  for (const p of parsed.providers) {
    if (typeof p.id !== 'string' || !p.id) p.id = 'prov-' + Date.now().toString(36);
    if (typeof p.name !== 'string') p.name = 'Custom';
    if (typeof p.baseUrl !== 'string') p.baseUrl = '';
    if (typeof p.key !== 'string') p.key = '';
    if (!Array.isArray(p.models)) p.models = [];
  }
  if (!parsed.activeModel || typeof parsed.activeModel !== 'object') parsed.activeModel = null;
  /* düşünme (reasoning) seviyesi: 0 kapalı … 5 max */
  parsed.thinkLevel = clampThink(parsed.thinkLevel);
  if (!parsed.typesafe || typeof parsed.typesafe !== 'object') {
    parsed.typesafe = { apiKey: '', model: 'jev-latest', enabled: true };
  }
  if (typeof parsed.typesafe.model !== 'string' || !parsed.typesafe.model.trim()) parsed.typesafe.model = 'jev-latest';
  if (typeof parsed.typesafe.enabled !== 'boolean') parsed.typesafe.enabled = true;
  /* borsalar: MT5 / Binance / OKX — gerçek hesap anahtarları + yerel deneme hesabı ayarı.
     Deneme modunda API anahtarı gerekmez; yalnız başlangıç bakiyesi (demoBalance) tutulur. */
  if (!['mt5', 'binance', 'okx'].includes(parsed.exchange)) parsed.exchange = 'mt5';
  const pb = (parsed.binance && typeof parsed.binance === 'object') ? parsed.binance : {};
  parsed.binance = {
    key: String(pb.key || ''),
    secret: String(pb.secret || ''),
    demo: pb.demo === true,
    demoBalance: Number(pb.demoBalance) > 0 ? Number(pb.demoBalance) : 10000,
  };
  const po = (parsed.okx && typeof parsed.okx === 'object') ? parsed.okx : {};
  parsed.okx = {
    key: String(po.key || ''),
    secret: String(po.secret || ''),
    pass: String(po.pass || ''),
    demo: po.demo === true,
    demoBalance: Number(po.demoBalance) > 0 ? Number(po.demoBalance) : 10000,
  };
  /* chat LLM kod düzenleme (self-edit): varsayılan açık */
  if (typeof parsed.codeEdit !== 'boolean') parsed.codeEdit = true;
  /* entegrasyonlar (WhatsApp/Telegram/Discord — botsuz): yalnız izin listeleri,
     tokenlar ve WhatsApp grup modu tutulur; bot/perm/sahip alanları yok sayılır */
  const wg = (parsed.waGroups && typeof parsed.waGroups === 'object') ? parsed.waGroups : {};
  parsed.waGroups = {
    enabled: wg.enabled === true,
    mentionOnly: wg.mentionOnly !== false,
  };
  parsed.waAllow = normAllowList(parsed.waAllow, 'num');
  parsed.tgAllow = normAllowList(parsed.tgAllow, 'id');
  parsed.dcAllow = normAllowList(parsed.dcAllow, 'id');
  parsed.tgToken = String(parsed.tgToken || '');
  parsed.dcToken = String(parsed.dcToken || '');
  /* WhatsApp daha önce eşlendi mi? (açılışta otomatik bağlanma koşulu) */
  if (typeof parsed.waWasPaired !== 'boolean') parsed.waWasPaired = false;
  /* yerel HTTP API: dışarıdan API anahtarı ile sorgu — varsayılan kapalı */
  const pa = (parsed.api && typeof parsed.api === 'object') ? parsed.api : {};
  parsed.api = {
    enabled: pa.enabled === true,
    host: pa.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
    port: (Number(pa.port) >= 1 && Number(pa.port) <= 65535) ? Math.round(Number(pa.port)) : 8787,
    keys: (Array.isArray(pa.keys) ? pa.keys : [])
      .filter((k) => k && typeof k === 'object' && typeof k.key === 'string' && k.key.startsWith('jvt_'))
      .slice(0, 20)
      .map((k) => ({
        id: typeof k.id === 'string' && k.id ? k.id.slice(0, 40) : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: String(k.name || 'Anahtar').slice(0, 60),
        key: k.key.slice(0, 80),
        createdAt: String(k.createdAt || ''),
        lastUsedAt: String(k.lastUsedAt || ''),
        calls: Math.max(0, Math.round(Number(k.calls) || 0)),
      })),
  };
  /* para transferi (OKX): son işlemler + son kullanılan form değerleri */
  parsed.transferLog = (Array.isArray(parsed.transferLog) ? parsed.transferLog : [])
    .filter((x) => x && typeof x === 'object')
    .slice(0, 100)
    .map((x) => ({
      at: String(x.at || ''),
      kind: x.kind === 'withdraw' ? 'withdraw' : 'transfer',
      ex: 'okx',
      ccy: String(x.ccy || '').slice(0, 16),
      amt: Number(x.amt) || 0,
      fee: Number(x.fee) || 0,
      chain: String(x.chain || '').slice(0, 40),
      toAddr: String(x.toAddr || '').slice(0, 220),
      tag: String(x.tag || '').slice(0, 100),
      from: String(x.from || '').slice(0, 8),
      to: String(x.to || '').slice(0, 8),
      id: String(x.id || '').slice(0, 60),
      state: String(x.state || '').slice(0, 40),
      dest: String(x.dest || '').slice(0, 4),
    }));
  const tl = parsed.transferLast;
  parsed.transferLast = (tl && typeof tl === 'object')
    ? {
        kind: tl.kind === 'withdraw' ? 'withdraw' : 'transfer',
        ccy: String(tl.ccy || 'USDT').slice(0, 16),
        chain: String(tl.chain || '').slice(0, 40),
        toAddr: String(tl.toAddr || '').slice(0, 220),
        tag: String(tl.tag || '').slice(0, 100),
        from: String(tl.from || '6').slice(0, 8),
        to: String(tl.to || '18').slice(0, 8),
        amt: Number(tl.amt) || 0,
        dest: String(tl.dest || '4').slice(0, 4),
      }
    : null;
  return parsed;
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const out = parseSettingsText(raw);
    try { fs.copyFileSync(SETTINGS_FILE, SETTINGS_BACKUP_FILE); } catch {}
    return out;
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      try { fs.copyFileSync(SETTINGS_FILE, SETTINGS_FILE + '.corrupt'); } catch {}
    }
  }
  try {
    const out = parseSettingsText(fs.readFileSync(SETTINGS_BACKUP_FILE, 'utf8'));
    return out;
  } catch {}
  return {};
}

function saveSettings() {
  try {
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
    if (fs.existsSync(SETTINGS_FILE)) {
      try { fs.copyFileSync(SETTINGS_FILE, SETTINGS_BACKUP_FILE); } catch {}
    }
    fs.renameSync(tmp, SETTINGS_FILE);
    try { if (!fs.existsSync(SETTINGS_BACKUP_FILE)) fs.copyFileSync(SETTINGS_FILE, SETTINGS_BACKUP_FILE); } catch {}
  } catch (e) {
    console.error('saveSettings hata:', (e && e.message) || e);
  }
}

/* ---------- skills: sohbet LLM'ine baglanan ozel yetenek talimatlari ---------- */
const SKILL_LIMITS = { name: 80, desc: 400, content: 20000, count: 100 };
let skills = loadSkills();

function normSkill(s) {
  const o = s && typeof s === 'object' ? s : {};
  const name = String(o.name || '').trim().slice(0, SKILL_LIMITS.name);
  if (!name) return null;
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 80) : 'skill-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    desc: String(o.desc || '').trim().slice(0, SKILL_LIMITS.desc),
    content: String(o.content || '').slice(0, SKILL_LIMITS.content),
    enabled: o.enabled !== false,
  };
}

function loadSkills() {
  try {
    const raw = JSON.parse(fs.readFileSync(SKILLS_FILE, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.map(normSkill).filter(Boolean).slice(0, SKILL_LIMITS.count);
  } catch {}
  return [];
}

function saveSkills() {
  try {
    const tmp = SKILLS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(skills, null, 2));
    fs.renameSync(tmp, SKILLS_FILE);
  } catch (e) {
    console.error('saveSkills hata:', (e && e.message) || e);
  }
}

/* ---------- kod düzenleme (chat LLM self-edit): yedek + sözdizimi/smoke test + otomatik yeniden başlatma ---------- */
const SRC_ROOT = __dirname;
const CODE_BACKUP_DIR = path.join(APP_DIR, 'codebackup');
const CODE_EXT = new Set(['.js', '.css', '.html']);
const CODE_MAX_FILE = 800 * 1024;
const CODE_MAX_OPS = 20;
const CODE_MAX_EDITS = 10;
const CODE_BACKUP_KEEP = 30;

function normCodePath(rel) {
  let raw = String(rel || '').trim().replace(/\\/g, '/');
  if (!raw || raw.includes('\0')) throw new Error('geçersiz dosya');
  raw = raw.replace(/^\.?\//, '');
  if (raw.toLowerCase().startsWith('src/')) raw = raw.slice(4);
  const root = path.resolve(SRC_ROOT);
  const abs = path.resolve(root, raw);
  if (!abs.startsWith(root + path.sep)) throw new Error('yalnız src/ altındaki dosyalar düzenlenebilir');
  if (!CODE_EXT.has(path.extname(abs).toLowerCase())) throw new Error('yalnız .js/.css/.html dosyaları düzenlenebilir');
  return { rel: path.relative(root, abs).replace(/\\/g, '/'), abs };
}

function applyCodeOps(text, ops) {
  let out = String(text || '');
  for (const op of ops) {
    const find = String((op && op.find) || '');
    const replace = String(op && op.replace != null ? op.replace : '');
    if (!find) return { ok: false, error: 'find boş' };
    const idx = out.indexOf(find);
    if (idx < 0) return { ok: false, error: 'find bulunamadı (birebir eşleşmeli)' };
    if (out.indexOf(find, idx + 1) >= 0) return { ok: false, error: 'find birden çok yerde eşleşiyor — daha fazla bağlam ver' };
    out = out.slice(0, idx) + replace + out.slice(idx + find.length);
  }
  return { ok: true, text: out };
}

function codeBackupFileName(rel) {
  return rel.replace(/[\\/]/g, '__');
}

function listCodeBackups() {
  try {
    const dirs = fs.readdirSync(CODE_BACKUP_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const out = [];
    for (const d of dirs) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(CODE_BACKUP_DIR, d, 'manifest.json'), 'utf8'));
        m.id = d;
        out.push(m);
      } catch {}
    }
    return out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 20);
  } catch { return []; }
}

function pruneCodeBackups() {
  try {
    const dirs = fs.readdirSync(CODE_BACKUP_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    while (dirs.length > CODE_BACKUP_KEEP) {
      const d = dirs.shift();
      try { fs.rmSync(path.join(CODE_BACKUP_DIR, d), { recursive: true, force: true }); } catch {}
    }
  } catch {}
}

function restoreCodeBatch(batchId) {
  const dir = path.join(CODE_BACKUP_DIR, String(batchId || ''));
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  for (const f of m.files || []) {
    const { abs } = normCodePath(f.rel);
    if (f.existed) {
      const bak = path.join(dir, codeBackupFileName(f.rel));
      fs.writeFileSync(abs, fs.readFileSync(bak, 'utf8'), 'utf8');
    } else {
      try { fs.unlinkSync(abs); } catch {}
    }
  }
  return m;
}

function checkSyntaxFiles(files) {
  for (const f of files) {
    if (path.extname(f.abs).toLowerCase() !== '.js') continue;
    const r = spawnSync(process.execPath, ['--check', f.abs], {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      const msg = String((r.stderr || r.stdout || '')).replace(/\s+/g, ' ').trim();
      return { ok: false, error: f.rel + ': ' + msg.slice(0, 300) };
    }
  }
  return { ok: true };
}

let codeRestartTimer = null;
function scheduleCodeRestart() {
  if (codeRestartTimer) return;
  codeRestartTimer = setTimeout(() => {
    try { app.relaunch(); } catch {}
    app.exit(0);
  }, 2500);
}

let codeApplyBusy = false;

jipc.handle('code:get', () => ({
  ok: true,
  enabled: settings.codeEdit !== false,
  packaged: app.isPackaged,
  busy: codeApplyBusy,
  backups: listCodeBackups(),
  version: codeVersion.version,
  build: codeVersion.build,
  updatedAt: codeVersion.updatedAt,
  note: codeVersion.note,
  backupDir: CODE_BACKUP_DIR,
}));

jipc.handle('code:openBackups', async () => {
  try {
    fs.mkdirSync(CODE_BACKUP_DIR, { recursive: true });
    const err = await shell.openPath(CODE_BACKUP_DIR);
    return err ? { ok: false, error: err } : { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

jipc.handle('code:set', (e, cfg) => {
  if (cfg && typeof cfg.enabled === 'boolean') {
    settings.codeEdit = cfg.enabled;
    saveSettings();
  }
  return { ok: true, enabled: settings.codeEdit !== false };
});

jipc.handle('code:apply', async (e, payload) => {
  if (app.isPackaged) return { ok: false, error: 'paketlenmiş sürümde kod düzenleme kapalı (geliştirme modunda çalışır)' };
  if (settings.codeEdit === false) return { ok: false, error: 'kod düzenleme kapalı — Ayarlar > Kod' };
  if (codeApplyBusy) return { ok: false, error: 'başka bir kod düzenlemesi sürüyor' };
  const edits = Array.isArray(payload && payload.edits) ? payload.edits.slice(0, CODE_MAX_EDITS).filter((x) => x && x.file) : [];
  if (!edits.length) return { ok: false, error: 'düzenleme yok' };
  const doSmoke = false; /* gömülü: ayrı smoke süreci yok */
  const doRestart = false; /* gömülü: yeniden başlatmayı Beast yönetir */
  codeApplyBusy = true;
  const at = new Date().toISOString();
  const batchId = at.replace(/[:.]/g, '-');
  const batchDir = path.join(CODE_BACKUP_DIR, batchId);
  const changed = [];
  const manifest = {
    at,
    why: String((payload && payload.why) || '').slice(0, 300),
    sessionId: String((payload && payload.sessionId) || ''),
    test: doSmoke ? 'syntax+smoke' : 'syntax',
    files: [],
  };
  try {
    fs.mkdirSync(batchDir, { recursive: true });
    for (const ed of edits) {
      const { rel, abs } = normCodePath(ed.file);
      const existed = fs.existsSync(abs);
      const original = existed ? fs.readFileSync(abs, 'utf8') : '';
      let next;
      if (Array.isArray(ed.ops) && ed.ops.length) {
        const r = applyCodeOps(original, ed.ops.slice(0, CODE_MAX_OPS));
        if (!r.ok) throw new Error(rel + ': ' + r.error);
        next = r.text;
      } else if (typeof ed.content === 'string') {
        next = ed.content;
      } else {
        throw new Error(rel + ': "ops" ya da "content" gerekli');
      }
      if (Buffer.byteLength(next, 'utf8') > CODE_MAX_FILE) throw new Error(rel + ': dosya çok büyük');
      const first = !changed.some((c) => c.rel === rel);
      if (first) {
        if (existed) fs.writeFileSync(path.join(batchDir, codeBackupFileName(rel)), original, 'utf8');
        manifest.files.push({ rel, existed });
        fs.writeFileSync(path.join(batchDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
      }
      const tmpFile = abs + '.jevtmp';
      fs.writeFileSync(tmpFile, next, 'utf8');
      fs.renameSync(tmpFile, abs);
      if (first) changed.push({ rel, abs });
    }
    const syntax = checkSyntaxFiles(changed);
    if (!syntax.ok) {
      try { restoreCodeBatch(batchId); } catch {}
      return { ok: false, rolledBack: true, error: 'sözdizimi hatası — değişiklikler geri alındı · ' + syntax.error };
    }
    if (doSmoke) {
      const smoke = await runSmokeTest();
      if (!smoke.ok) {
        try { restoreCodeBatch(batchId); } catch {}
        return { ok: false, rolledBack: true, error: 'smoke test başarısız — değişiklikler geri alındı · ' + smoke.error };
      }
    }
    pruneCodeBackups();
    bumpCodeVersion((manifest.why ? manifest.why + ' · ' : '') + changed.map((c) => c.rel).join(', '));
    if (doRestart) scheduleCodeRestart();
    return { ok: true, files: changed.map((c) => c.rel), backup: batchId, syntax: true, smoke: doSmoke, restarting: doRestart, build: codeVersion.build };
  } catch (err) {
    try { if (changed.length || fs.existsSync(path.join(batchDir, 'manifest.json'))) restoreCodeBatch(batchId); } catch {}
    return { ok: false, rolledBack: changed.length > 0, error: String((err && err.message) || err) };
  } finally {
    codeApplyBusy = false;
  }
});

jipc.handle('code:restore', (e, payload) => {
  if (app.isPackaged) return { ok: false, error: 'paketlenmiş sürümde kapalı' };
  if (codeApplyBusy) return { ok: false, error: 'başka bir kod işlemi sürüyor' };
  const id = String((payload && payload.id) || '');
  if (!id || /[\\/]/.test(id) || id.includes('..')) return { ok: false, error: 'geçersiz yedek' };
  codeApplyBusy = true;
  try {
    const m = restoreCodeBatch(id);
    const files = (m.files || []).map((f) => normCodePath(f.rel));
    const syntax = checkSyntaxFiles(files);
    if (!syntax.ok) return { ok: false, error: 'yedek geri yüklendi ama sözdizimi bozuk · ' + syntax.error };
    bumpCodeVersion('yedek geri yükleme · ' + id);
    const doRestart = false; /* gömülü: yeniden başlatmayı Beast yönetir */
    if (doRestart) scheduleCodeRestart();
    return { ok: true, files: files.map((f) => f.rel), restarting: doRestart, build: codeVersion.build };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  } finally {
    codeApplyBusy = false;
  }
});

/* ---------- internet: chat LLM web okuma (url / arama) ---------- */
const WEB_MAX_CHARS = 60000;
const WEB_TIMEOUT_MS = 20000;

function webHostBlocked(u) {
  try {
    const h = new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      const p = h.split('.').map(Number);
      if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
      if (p[0] === 192 && p[1] === 168) return true;
      if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
      if (p[0] === 169 && p[1] === 254) return true;
    }
    if (h === '::1') return true;
    return false;
  } catch { return true; }
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCharCode(Number(n)); } catch { return ' '; } });
  return s.replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

function htmlTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? htmlToText(m[1]).slice(0, 200) : '';
}

function decodeDdg(url) {
  try {
    const u = new URL(String(url).replace(/&amp;/g, '&'), 'https://duckduckgo.com');
    const t = u.searchParams.get('uddg');
    const out = t ? decodeURIComponent(t) : u.href;
    return /^https?:\/\//i.test(out) ? out : '';
  } catch { return ''; }
}

async function webFetchPage(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: 'yalnız http(s) URL verilebilir' };
  if (webHostBlocked(u)) return { ok: false, error: 'yerel/özel adresler engelli' };
  try {
    const res = await fetch(u, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JevTrader/' + APP_VERSION + ')',
        Accept: 'text/html,application/json,text/plain,*/*',
        'Accept-Language': 'tr,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
    });
    const body = await res.text();
    const ct = String(res.headers.get('content-type') || '');
    const text = /json|text\/plain/.test(ct) ? body : htmlToText(body);
    return {
      ok: true,
      data: {
        url: String(res.url || u).slice(0, 400),
        status: res.status,
        title: htmlTitle(body),
        content_type: ct.slice(0, 80),
        chars: text.length,
        truncated: text.length > WEB_MAX_CHARS,
        text: text.slice(0, WEB_MAX_CHARS),
      },
    };
  } catch (e) {
    return { ok: false, error: ('sayfa alınamadı: ' + String((e && e.message) || e)).slice(0, 300) };
  }
}

async function webSearch(q) {
  const query = String(q || '').trim().slice(0, 300);
  if (!query) return { ok: false, error: 'arama sorgusu boş' };
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JevTrader/' + APP_VERSION + ')',
        Accept: 'text/html',
        'Accept-Language': 'tr,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
    });
    const html = await res.text();
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 12) {
      const url = decodeDdg(m[1]);
      const title = htmlToText(m[2]);
      if (url && title) out.push({ title: title.slice(0, 200), url: url.slice(0, 400) });
    }
    return { ok: true, data: { query, count: out.length, results: out } };
  } catch (e) {
    return { ok: false, error: ('arama başarısız: ' + String((e && e.message) || e)).slice(0, 300) };
  }
}

jipc.handle('web:fetch', (e, p) => {
  const payload = p || {};
  if (payload.search) return webSearch(payload.search);
  return webFetchPage(payload.url);
});

/* ---------- günlük forex haberleri: her gün 08:30'da çekilir, dosyaya kaydedilir ---------- */
const NEWS_FILE = path.join(APP_DIR, 'forex-news.json');
const NEWS_HOUR = 8;
const NEWS_MIN = 30;
const NEWS_MAX = 50;
const NEWS_FEEDS = [
  { name: 'ForexLive', url: 'https://www.forexlive.com/feed/news' },
  { name: 'Investing.com', url: 'https://www.investing.com/rss/news_1.rss' },
  { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { name: 'ForexCrunch', url: 'https://www.forexcrunch.com/feed/' },
  { name: 'Bloomberg HT', url: 'https://www.bloomberght.com/rss' },
];
let newsCache = loadNews();

function newsDayKey(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}

function loadNews() {
  try {
    const raw = JSON.parse(fs.readFileSync(NEWS_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      return {
        date: String(raw.date || '').slice(0, 10),
        updatedAt: String(raw.updatedAt || '').slice(0, 40),
        items: (Array.isArray(raw.items) ? raw.items : []).slice(0, NEWS_MAX).map((it) => ({
          title: String((it && it.title) || '').slice(0, 300),
          link: String((it && it.link) || '').slice(0, 500),
          source: String((it && it.source) || '').slice(0, 40),
          at: String((it && it.at) || '').slice(0, 40),
        })).filter((it) => it.title),
        errors: [],
      };
    }
  } catch {}
  return { date: '', updatedAt: '', items: [], errors: [] };
}

function saveNews() {
  try {
    const tmp = NEWS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(newsCache, null, 2));
    fs.renameSync(tmp, NEWS_FILE);
  } catch (e) {
    console.error('saveNews hata:', (e && e.message) || e);
  }
}

/* RSS/Atom başlıklarını ayıkla: title + link + tarih + kaynak adı */
function parseRssItems(xml, sourceName) {
  const out = [];
  const text = String(xml || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const blocks = text.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) || [];
  for (const b of blocks.slice(0, 30)) {
    const tm = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(b);
    const title = htmlToText(tm ? tm[1] : '').slice(0, 300);
    if (!title) continue;
    let link = (/<link[^>]*>([\s\S]*?)<\/link>/i.exec(b) || [])[1] || '';
    if (!link) link = (/<link[^>]+href="([^"]+)"/i.exec(b) || [])[1] || '';
    link = htmlToText(link).slice(0, 500);
    const am = /<(?:pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated|dc:date)>/i.exec(b);
    const at = String(am ? am[1] : '').replace(/<!\[CDATA\[|\]\]>/g, '').trim().slice(0, 40);
    out.push({ title, link, source: sourceName, at });
  }
  return out;
}

async function fetchDailyNews(force) {
  const day = newsDayKey();
  if (!force && newsCache.date === day && newsCache.items.length) return newsCache;
  const items = [];
  const errors = [];
  await Promise.all(NEWS_FEEDS.map(async (f) => {
    try {
      const res = await fetch(f.url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*',
          'Accept-Language': 'tr,en;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(WEB_TIMEOUT_MS),
      });
      if (!res.ok) { errors.push(f.name + ' HTTP ' + res.status); return; }
      const xml = await res.text();
      items.push(...parseRssItems(xml, f.name));
    } catch (e) {
      errors.push(f.name + ': ' + String((e && e.message) || e).slice(0, 90));
    }
  }));
  /* başlığa göre tekrarları at */
  const seen = new Set();
  const uniq = [];
  for (const it of items) {
    const k = it.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(it);
  }
  newsCache = {
    date: day,
    updatedAt: new Date().toISOString(),
    items: uniq.slice(0, NEWS_MAX),
    errors: errors.slice(0, 8),
  };
  saveNews();
  try { if (win && !win.isDestroyed()) win.webContents.send('news:updated', newsCache); } catch {}
  console.log('[news] ' + uniq.length + ' haber kaydedildi (' + day + ')' + (errors.length ? ' · hata: ' + errors.join(' | ') : ''));
  return newsCache;
}

/* her gün 08:30'da bir sonraki çalışmayı planla */
function scheduleDailyNews() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), NEWS_HOUR, NEWS_MIN, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  const wait = Math.max(1000, Math.min(next.getTime() - now.getTime(), 2147483000));
  const t = setTimeout(async () => {
    try { await fetchDailyNews(true); } catch (e) { console.error('[news] hata:', (e && e.message) || e); }
    scheduleDailyNews();
  }, wait);
  if (t.unref) t.unref();
}

jipc.handle('news:get', () => ({ ok: true, news: newsCache }));
jipc.handle('news:refresh', async () => {
  const n = await fetchDailyNews(true).catch(() => newsCache);
  return { ok: true, news: n };
});

/* ---------- kaynak okuma: chat LLM kod görebilsin (src/ altı, salt-okunur) ---------- */
const SRC_READ_MAX = 200 * 1024;
const SRC_READ_EXTS = new Set(['.js', '.css', '.html', '.json', '.py', '.md', '.txt']);

function normReadPath(rel) {
  const r = normCodePathExt(rel, SRC_READ_EXTS, '.js/.css/.html/.json/.py/.md okunabilir');
  return r;
}

function normCodePathExt(rel, exts, extErr) {
  let raw = String(rel || '').trim().replace(/\\/g, '/');
  if (!raw || raw.includes('\0')) throw new Error('geçersiz dosya');
  raw = raw.replace(/^\.?\//, '');
  if (raw.toLowerCase().startsWith('src/')) raw = raw.slice(4);
  const root = path.resolve(SRC_ROOT);
  const abs = path.resolve(root, raw);
  if (!abs.startsWith(root + path.sep)) throw new Error('yalnız src/ altındaki dosyalara erişilebilir');
  if (!exts.has(path.extname(abs).toLowerCase())) throw new Error(extErr);
  return { rel: path.relative(root, abs).replace(/\\/g, '/'), abs };
}

function listSrcFiles() {
  const root = path.resolve(SRC_ROOT);
  const skip = new Set(['node_modules', '.git', '__pycache__', 'codebackup']);
  const out = [];
  const walk = (dir) => {
    if (out.length >= 500) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (skip.has(d.name)) continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) { walk(abs); continue; }
      let size = 0;
      try { size = fs.statSync(abs).size; } catch {}
      out.push({ rel: path.relative(root, abs).replace(/\\/g, '/'), size });
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

jipc.handle('src:list', () => ({ ok: true, data: { files: listSrcFiles() } }));

jipc.handle('src:read', (e, p) => {
  try {
    const { rel, abs } = normReadPath(p && p.file);
    if (!fs.existsSync(abs)) return { ok: false, error: 'dosya yok: ' + rel };
    if (fs.statSync(abs).size > SRC_READ_MAX * 4) return { ok: false, error: 'dosya çok büyük (salt-okuma sınırı)' };
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    const total = lines.length;
    const maxLines = Math.max(20, Math.min(2000, Math.round(Number(p && p.maxLines) || 600)));
    const grep = String((p && p.grep) || '').trim();
    if (grep) {
      const ctx = Math.max(0, Math.min(20, Math.round(Number(p && p.ctx) || 3)));
      let re;
      try { re = new RegExp(grep, 'i'); } catch (err) { return { ok: false, error: 'geçersiz grep: ' + String((err && err.message) || err) }; }
      const keep = new Set();
      for (let i = 0; i < total; i++) {
        if (re.test(lines[i])) for (let j = Math.max(0, i - ctx); j <= Math.min(total - 1, i + ctx); j++) keep.add(j);
      }
      const idx = Array.from(keep).sort((a, b) => a - b).slice(0, maxLines);
      const chunks = [];
      let last = -2;
      for (const i of idx) {
        if (i !== last + 1) chunks.push('...');
        chunks.push((i + 1) + '| ' + lines[i]);
        last = i;
      }
      return { ok: true, data: { rel, totalLines: total, mode: 'grep', matches: idx.length, text: chunks.join('\n').slice(0, SRC_READ_MAX) } };
    }
    let from = Math.max(1, Math.round(Number(p && p.from) || 1));
    let to = Math.round(Number(p && p.to) || 0) || total;
    if (to < from) to = from;
    const slice = lines.slice(from - 1, Math.min(to, from - 1 + maxLines));
    const end = from - 1 + slice.length;
    return {
      ok: true,
      data: {
        rel, totalLines: total, from, to: end,
        truncated: end < total,
        text: slice.map((l, i) => (from + i) + '| ' + l).join('\n').slice(0, SRC_READ_MAX),
      },
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* ---------- araçlar: chat LLM'in toolbox'a eklediği özel araçlar ---------- */
const TOOLS_FILE = path.join(APP_DIR, 'tools.json');
const TOOL_LIMITS = { name: 60, desc: 300, content: 24000, count: 60 };
let customTools = loadTools();

function normTool(t) {
  const o = t && typeof t === 'object' ? t : {};
  const name = String(o.name || '').trim().slice(0, TOOL_LIMITS.name);
  if (!name) return null;
  return {
    id: typeof o.id === 'string' && o.id ? o.id.slice(0, 80) : 'tool-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    desc: String(o.desc || o.description || '').trim().slice(0, TOOL_LIMITS.desc),
    icon: String(o.icon || '').trim().slice(0, 8),
    content: String(o.content || o.code || '').slice(0, TOOL_LIMITS.content),
    enabled: o.enabled !== false,
  };
}

function loadTools() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.map(normTool).filter(Boolean).slice(0, TOOL_LIMITS.count);
  } catch {}
  return [];
}

function saveTools() {
  try {
    const tmp = TOOLS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(customTools, null, 2));
    fs.renameSync(tmp, TOOLS_FILE);
  } catch (e) {
    console.error('saveTools hata:', (e && e.message) || e);
  }
}

jipc.handle('tools:get', () => ({ ok: true, tools: customTools }));

jipc.handle('tools:set', (e, list) => {
  try {
    const clean = [];
    for (const t of Array.isArray(list) ? list : []) {
      const n = normTool(t);
      if (!n) continue;
      clean.push(n);
      if (clean.length >= TOOL_LIMITS.count) break;
    }
    customTools = clean;
    saveTools();
    return { ok: true, tools: customTools };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* ---------- hazir saglayicilar (hepsi OpenAI uyumlu) ---------- */
const BUILTIN_PROVIDERS = [
  { id: 'opencode-zen', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', hint: 'Ucretsiz modeller var — anahtar: opencode.ai/auth' },
  { id: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', hint: 'Abonelik anahtari' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', hint: 'openrouter.ai/keys' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', hint: 'platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', hint: 'console.anthropic.com' },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', hint: 'aistudio.google.com/apikey' },
  { id: 'zhipu', name: 'Zhipu AI', baseUrl: 'https://api.z.ai/api/paas/v4', hint: 'z.ai model konsolu' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', hint: 'console.groq.com/keys' },
  { id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', hint: 'build.nvidia.com — ucretsiz kredi' },
];

/* ---------- TypeSafe (System One / Jev) ---------- */
const SECRET_MASK = '********';
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';

function typesafePublic() {
  const t = settings.typesafe;
  return {
    set: !!t.apiKey,
    apiKey: t.apiKey ? SECRET_MASK : '',
    model: t.model || 'jev-latest',
    enabled: t.enabled !== false,
  };
}

async function typesafeTest(apiKey, model) {
  const key = apiKey || (settings.typesafe && settings.typesafe.apiKey) || '';
  if (!key) return { ok: false, error: 'API anahtari bos' };
  try {
    const res = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: 'Saglik kontrolu: baglanti testi.',
        model: model || 'jev-latest',
        questions: { ok: { type: 'noul', instructions: 'Bu bir baglanti testi mi?' } },
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ok: false, error: res.status + ': ' + String(await res.text()).slice(0, 180) };
    const data = await res.json();
    return { ok: true, model: model || 'jev-latest', answer: data && data.answers ? 'yanit alindi' : '' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* TypeSafe System One (Jev) analizi: tipli sorulara yapilandirilmis cevap */
async function typesafeAnalyze(state, questions) {
  const t = settings.typesafe || {};
  if (!t.apiKey) return { ok: false, error: 'TypeSafe anahtari yok (Ayarlar > TypeSafe API)' };
  if (t.enabled === false) return { ok: false, error: 'TypeSafe kapali (Ayarlar > TypeSafe API)' };
  try {
    const res = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: t.model || 'jev-latest', questions }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { ok: false, error: res.status + ': ' + String(await res.text()).slice(0, 180) };
    const data = await res.json();
    return { ok: true, answers: (data && data.answers) || {} };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
jipc.handle('typesafe:analyze', (e, p) => typesafeAnalyze(p && p.state, (p && p.questions) || {}));

/* ---------- chat: aktif provider uzerinden OpenAI-uyumlu /chat/completions ---------- */
const activeChats = new Map(); // requestId -> AbortController

/* Düşünme (reasoning) seviyeleri — Beast Agent ile aynı gerçek API değerleri.
   0 parametre göndermez; 1-5 reasoning_effort olarak gider. Model seviyeyi
   reddederse bir alt seviye denenir, parametreyi hiç desteklemiyorsa bırakılır
   ve bu model için oturum boyunca bir daha gönderilmez. */
const THINK_EFFORTS = [null, 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LOWER = { max: 'xhigh', xhigh: 'high', high: 'medium', medium: 'low', low: null };
const REASON_PARAM_RE = /invalid request param|invalid_param|unsupported|not supported|unknown (param|field|argument)|unrecognized|unexpected/i;
const reasoningOff = new Set();
const reasoningFailed = new Map(); // modelKey -> reddedilen seviyeler

function thinkModelKey(am) {
  return String((am && am.providerId) || '') + '::' + String((am && am.model) || '');
}

function thinkEffortFor(key) {
  let eff = THINK_EFFORTS[clampThink(settings.thinkLevel)] || null;
  if (!eff || reasoningOff.has(key)) return null;
  const failed = reasoningFailed.get(key);
  let guard = 0;
  while (eff && failed && failed.has(eff) && guard++ < 5) eff = EFFORT_LOWER[eff] || null;
  return eff;
}

function findProvider(id) {
  return (settings.providers || []).find((p) => p.id === id) || null;
}

/* içerik alanı metin ya da parça dizisi olabilir (bazı sağlayıcılar dizi döndürür) */
function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .join('');
  }
  return '';
}

/* SSE/JSON parçasından metin çıkar (delta ya da message içeriği) */
function streamPiece(j) {
  const c = j && j.choices && j.choices[0];
  const d = c && (c.delta || c.message);
  return d ? contentText(d.content) : '';
}

/* görselli isteği metne indirger: sağlayıcı boş yanıt verirse görselleri atıp yeniden denemek için */
function stripImageParts(messages) {
  let changed = false;
  const out = (messages || []).map((m) => {
    if (!m || !Array.isArray(m.content)) return m;
    const parts = m.content.filter((p) => !(p && (p.type === 'image_url' || p.image_url)));
    if (parts.length === m.content.length) return m;
    changed = true;
    const text = parts
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
    return { ...m, content: text };
  });
  return changed ? out : null;
}

async function chatComplete(payload, sender) {
  const requestId = String(payload.requestId || '');
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const am = settings.activeModel;
  const provider = am && findProvider(am.providerId);
  if (!provider || !am.model) {
    return { ok: false, error: 'Aktif model yok — Ayarlar > Provider sekmesinden model ekle/sectir.' };
  }
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const hardTimer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 150000);
  if (requestId) activeChats.set(requestId, ctrl);
  const sendDelta = (piece) => {
    if (!piece || !sender || sender.isDestroyed()) return;
    try { sender.send('chat:delta', { requestId, text: piece }); } catch {}
  };
  try {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (provider.key || ''),
      'User-Agent': USER_AGENT,
    };
    if (isOpenCode(base)) Object.assign(headers, openCodeHeaders(base, payload.sessionId));
    /* düşünme seviyesi: reasoning_effort gönder; model reddederse kademeli
       olarak düşür (max → xhigh → high → medium → low), desteklemiyorsa bırak */
    const key = thinkModelKey(am);
    let effort = thinkEffortFor(key);
    let res = null;
    for (let attempt = 0; ; attempt++) {
      const body = { model: am.model, messages, stream: true };
      if (effort) body.reasoning_effort = effort;
      res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.ok) break;
      const errText = String(await res.text()).slice(0, 300);
      if (!effort || attempt >= 5 || (res.status !== 400 && res.status !== 422)) {
        return { ok: false, error: res.status + ': ' + errText };
      }
      const reasonHint = /reason|effort|thinking/i.test(errText);
      const generic = REASON_PARAM_RE.test(errText);
      const valueQuoted = errText.includes("'" + effort + "'") || errText.includes('"' + effort + '"');
      if (!reasonHint && !generic && !valueQuoted) {
        return { ok: false, error: res.status + ': ' + errText };
      }
      const lower = EFFORT_LOWER[effort] || null;
      if (lower && (valueQuoted || (generic && !reasonHint))) {
        /* seviye reddedildi → bir alt seviyeyi dene */
        if (!reasoningFailed.has(key)) reasoningFailed.set(key, new Set());
        reasoningFailed.get(key).add(effort);
        effort = lower;
      } else {
        /* parametre hiç desteklenmiyor → bu modelde bir daha gönderme */
        reasoningOff.add(key);
        effort = null;
      }
    }
    const ctype = String(res.headers.get('content-type') || '');
    /* akış (SSE): parçalar geldikçe renderer'a gönderilir */
    if (res.body && /text\/event-stream/i.test(ctype)) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let all = '';
      let text = '';
      let done = false;
      while (!done) {
        const r = await reader.read();
        if (r.done) break;
        const chunk = dec.decode(r.value, { stream: true });
        all += chunk;
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') { done = true; break; }
          let j = null;
          try { j = JSON.parse(data); } catch {}
          const piece = streamPiece(j);
          if (piece) { text += piece; sendDelta(piece); }
        }
      }
      try { await reader.cancel(); } catch {}
      /* SSE ama içerik gelmediyse: sağlayıcı stream'i yok sayıp JSON döndürmüş olabilir */
      if (!text) {
        try {
          const j = JSON.parse(all.trim());
          text = streamPiece(j) || ((j && j.choices && j.choices[0] && j.choices[0].message) ? contentText(j.choices[0].message.content) : '');
        } catch {}
      }
      return { ok: true, text };
    }
    /* sağlayıcı stream'i yok saydı: tek JSON yanıtı */
    const data = await res.json();
    const text = streamPiece(data) ||
      ((data && data.choices && data.choices[0] && data.choices[0].message) ? contentText(data.choices[0].message.content) : '');
    sendDelta(text);
    return { ok: true, text };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, aborted: true, error: 'iptal' };
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(hardTimer);
    if (requestId) activeChats.delete(requestId);
  }
}

/* ---------- IPC ---------- */
jipc.handle('app:version', () => ({ version: codeVersion.version, build: codeVersion.build, updatedAt: codeVersion.updatedAt }));

jipc.handle('settings:get', () => ({
  providers: settings.providers || [],
  activeModel: settings.activeModel || null,
  thinkLevel: clampThink(settings.thinkLevel),
}));

jipc.handle('builtinProviders', () => BUILTIN_PROVIDERS);

jipc.handle('providers:set', (e, list) => {
  if (!Array.isArray(list)) return { ok: false };
  const clean = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const prev = findProvider(String(p.id || ''));
    const key = typeof p.key === 'string' && p.key ? p.key : (prev ? prev.key : '');
    clean.push({
      id: String(p.id || 'prov-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      name: String(p.name || 'Custom'),
      baseUrl: String(p.baseUrl || ''),
      key,
      models: Array.isArray(p.models) ? p.models.map(String).filter(Boolean) : [],
    });
  }
  /* silinen providere bagli aktif model dusuyorsa temizle */
  if (settings.activeModel) {
    const still = clean.find((p) => p.id === settings.activeModel.providerId);
    if (!still || !still.models.includes(settings.activeModel.model)) settings.activeModel = null;
  }
  settings.providers = clean;
  saveSettings();
  return { ok: true };
});

jipc.handle('model:set', (e, sel) => {
  const [providerId, model] = String(sel || '').split('::');
  const provider = findProvider(providerId);
  if (!provider || !provider.models.includes(model)) return { ok: false };
  settings.activeModel = { providerId, model };
  saveSettings();
  return { ok: true, activeModel: settings.activeModel };
});

/* düşünme seviyesi: 0 kapalı … 5 max — tüm sohbet isteklerine uygulanır */
jipc.handle('think:set', (e, v) => {
  settings.thinkLevel = clampThink(v);
  saveSettings();
  return { ok: true, thinkLevel: settings.thinkLevel };
});

jipc.handle('skills:get', () => ({ ok: true, skills }));

jipc.handle('skills:set', (e, list) => {
  if (!Array.isArray(list)) return { ok: false, error: 'gecersiz liste' };
  const clean = [];
  const seen = new Set();
  for (const s of list) {
    const n = normSkill(s);
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    clean.push(n);
    if (clean.length >= SKILL_LIMITS.count) break;
  }
  skills = clean;
  saveSkills();
  return { ok: true, skills };
});

/* ---------- kalıcı performans hafızası + karar günlüğü ---------- */
jipc.handle('journal:get', (e, q) => journalmod.stats(q || {}));

jipc.handle('journal:summary', (e, q) => journalmod.summaryLines(q || {}));

jipc.handle('journal:trade', (e, t) => journalmod.appendTrade(t || {}));

jipc.handle('journal:action', (e, a) => journalmod.appendAction(a || {}));

jipc.handle('journal:clear', () => journalmod.clear());

jipc.handle('models:fetch', async (e, { baseUrl, key }) => {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'gecersiz adres' };
  try {
    const headers = { 'User-Agent': USER_AGENT };
    if (key) headers.Authorization = 'Bearer ' + key;
    if (isOpenCode(base)) Object.assign(headers, openCodeHeaders(base, 'models'));
    const res = await fetch(base + '/models', {
      headers,
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return { ok: false, error: res.status + ': ' + String(await res.text()).slice(0, 180) };
    const data = await res.json();
    const arr =
      (data && Array.isArray(data.data) && data.data.map((m) => m.id)) ||
      (data && Array.isArray(data.models) && data.models.map((m) => m.id || m.name)) ||
      [];
    return { ok: true, models: arr.filter(Boolean).map(String).sort() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

jipc.handle('typesafe:get', () => typesafePublic());

jipc.handle('typesafe:set', (e, cfg) => {
  cfg = cfg || {};
  const t = settings.typesafe;
  /* anahtar maskeli geliyorsa (ac/kapa degisikligi) mevcut anahtar korunur */
  const incoming = String(cfg.apiKey || '');
  if (incoming && incoming !== SECRET_MASK) t.apiKey = incoming;
  else if (incoming === '' && cfg.clearKey === true) t.apiKey = '';
  if (typeof cfg.model === 'string' && cfg.model.trim()) t.model = cfg.model.trim() || 'jev-latest';
  if (typeof cfg.enabled === 'boolean') t.enabled = cfg.enabled;
  saveSettings();
  return { ok: true, typesafe: typesafePublic() };
});

jipc.handle('typesafe:test', async (e, { apiKey, model }) => {
  const key = apiKey === SECRET_MASK ? '' : apiKey || '';
  return typesafeTest(key, model);
});

/* boş yanıt koruması: sağlayıcı ok dönüp boş gövde verdiyse (özellikle görselli
   isteklerde) görselleri atıp, görselsiz istekte aynı istekle bir kez daha dene;
   yine boşsa çağıran taraf mevcut boş-yanıt akışını işler */
jipc.handle('chat:send', async (e, payload) => {
  const p = payload || {};
  let res = await chatComplete(p, e.sender);
  if (res && res.ok && !res.aborted && !String(res.text || '').trim()) {
    const noImg = stripImageParts(p.messages);
    res = await chatComplete(noImg ? { ...p, messages: noImg } : p, e.sender);
  }
  return res;
});
jipc.handle('chat:stop', (e, requestId) => {
  const ctrl = activeChats.get(String(requestId || ''));
  if (ctrl) { try { ctrl.abort(); } catch {} }
  return { ok: true };
});

/* ---------- MT5 kopru ---------- */
function mt5Candidates() {
  const list = [];
  const push = (p) => { const v = String(p || '').trim(); if (v && !list.includes(v)) list.push(v); };
  push(process.env.JEV_PYTHON);
  const own = path.join(APP_DIR, 'py', 'python.exe');
  if (fs.existsSync(own)) push(own);
  /* Beast'in gomulu python'u makinede hazir (MetaTrader5 paketi kurulu) —
     kendi runtime'imiz yoksa pratik fallback */
  const beastPy = path.join(app.getPath('appData'), 'beast', 'py', 'python.exe');
  if (fs.existsSync(beastPy)) push(beastPy);
  push('python');
  push('py -3');
  return list;
}

/* opts.launch=false → terminal kapalıysa bağlanmaz, MT5 açılmaz */
function startMt5(opts = {}) {
  if (mt5bridge.running) return;
  mt5bridge.start({
    candidates: mt5Candidates(),
    terminal: (settings.mt5 && settings.mt5.terminalPath) || '',
    launch: opts.launch !== false && mt5LaunchAllowed(),
  });
}

/* MT5 terminalini AÇMA izni: YALNIZ JevTrader modu açıkken VE borsa MT5
   seçiliyken verilir. Diğer tüm durumlarda köprü sessiz başlatılır ve
   terminal kapalıysa asla kendiliğinden açılmaz. */
let jevModeActive = false;
function mt5LaunchAllowed() {
  return jevModeActive === true && exActive() === 'mt5';
}

/* MT5 borsası seçiliyken köprüyü hazırla: çalışmıyorsa başlat,
   terminal açma izni yoksa (sessiz başlatılmışsa) izin varsa yeniden başlat */
function ensureMt5() {
  if (!mt5bridge.running) { startMt5(); return; }
  if (!mt5bridge.launchAllowed && mt5LaunchAllowed()) {
    try { mt5bridge.stop(); } catch {}
    startMt5();
  }
}

/* JevTrader modu açılıp kapanınca çağrılır: kapanınca MT5 köprüsü de kapanır,
   böylece JevTrader dışında hiçbir arka plan döngüsü MT5'e dokunmaz */
function setJevMode(on) {
  jevModeActive = !!on;
  if (!on) {
    try { mt5bridge.stop(); } catch {}
    logWrite(new Date().toISOString() + ' MT5 JevTrader modu kapandı — köprü durduruldu (otomatik açılış yok)');
  } else if (exActive() === 'mt5') {
    ensureMt5();
  }
}

/* MT5 köprü ayarları: terminal yolu. "Otomatik aç" ayarı kaldırıldı —
   terminal yalnız JevTrader modu + MT5 borsası seçiliyken açılır. */
jipc.handle('mt5:cfgGet', () => {
  const m = settings.mt5 || {};
  return { ok: true, terminalPath: String(m.terminalPath || ''), autoLaunch: false };
});
jipc.handle('mt5:cfgSet', (e, p) => {
  const m = settings.mt5 || (settings.mt5 = {});
  m.autoLaunch = false;
  if (p && typeof p.terminalPath === 'string') m.terminalPath = String(p.terminalPath).trim().slice(0, 400);
  saveSettings();
  return { ok: true, terminalPath: String(m.terminalPath || ''), autoLaunch: false };
});

mt5bridge.on('bridge', (ev) => {
  logWrite(new Date().toISOString() + ' MT5 ' + (ev && ev.connected ? 'bağlandı' : 'bağlantı yok') + (ev && ev.error ? ' · ' + ev.error : ''));
  if (win && !win.isDestroyed()) win.webContents.send('mt5:event', { ...ev, status: mt5bridge.status() });
});
mt5bridge.on('log', (ev) => {
  if (ev && ev.level === 'error') {
    console.error('[MT5]', ev.line);
    logWrite(new Date().toISOString() + ' [MT5] ' + ev.line);
  }
});

jipc.handle('mt5:status', () => mt5bridge.status());
/* MT5 terminali yalnız JevTrader modu açıkken VE MT5 borsası seçiliyken açılır;
   diğer tüm durumlarda bu düğme sessiz (terminal açmayan) başlatma yapar */
jipc.handle('mt5:start', () => {
  if (exActive() === 'mt5') startMt5();
  else startMt5({ launch: false });
  return { ok: true, status: mt5bridge.status() };
});
jipc.handle('mt5:ping', () => mt5bridge.call('ping', {}, 20000));
jipc.handle('mt5:account', () => mt5bridge.call('account', {}, 10000));
jipc.handle('mt5:rates', (e, p) => mt5bridge.call('rates', p || {}, 15000));
jipc.handle('mt5:ticks', (e, p) => mt5bridge.call('ticks', p || {}, 10000));
jipc.handle('mt5:allSymbols', (e, p) => mt5bridge.call('all_symbols', p || {}, 20000));
jipc.handle('mt5:symbols', (e, p) => mt5bridge.call('symbols', p || {}, 15000));
jipc.handle('mt5:positions', () => mt5bridge.call('positions', {}, 10000));
jipc.handle('mt5:orders', () => mt5bridge.call('orders', {}, 10000));
jipc.handle('mt5:closed', (e, p) => mt5bridge.call('closed', p || {}, 25000));
jipc.handle('mt5:orderDelete', (e, p) => mt5bridge.call('order_delete', p || {}, 15000));
jipc.handle('mt5:orderModify', (e, p) => mt5bridge.call('order_modify', p || {}, 20000));
jipc.handle('mt5:market', (e, p) => mt5bridge.call('market', p || {}, 20000));
jipc.handle('mt5:pending', (e, p) => mt5bridge.call('pending', p || {}, 20000));
jipc.handle('mt5:closePosition', (e, p) => mt5bridge.call('close', p || {}, 20000));
jipc.handle('mt5:modify', (e, p) => mt5bridge.call('modify', p || {}, 20000));

/* ---------- kalıcı log ---------- */
const LOG_MAX_BYTES = 2 * 1024 * 1024;
function logFile() {
  return path.join(app.getPath('userData'), 'logs', 'jevtrader.log');
}

function logWrite(line) {
  const LOG_FILE = logFile();
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    /* boyut sınırı: dosya büyürse son 2000 satıra indir */
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > LOG_MAX_BYTES) {
        const txt = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = txt.split('\n');
        fs.writeFileSync(LOG_FILE, lines.slice(-2000).join('\n'));
      }
    } catch {}
    fs.appendFileSync(LOG_FILE, String(line) + '\n');
  } catch {}
}

jipc.handle('log:append', (e, line) => { logWrite(line); return { ok: true }; });
jipc.handle('log:read', (e, maxLines) => {
  const LOG_FILE = logFile();
  try {
    const txt = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = txt.split('\n').filter((l) => l.length);
    return { ok: true, lines: lines.slice(-(Math.max(1, Number(maxLines) || 400))), path: LOG_FILE };
  } catch {
    return { ok: true, lines: [], path: LOG_FILE };
  }
});
jipc.handle('log:clear', () => { try { fs.writeFileSync(logFile(), ''); } catch {} return { ok: true }; });
jipc.handle('log:open', () => { try { shell.showItemInFolder(logFile()); } catch {} return { ok: true }; });

/* ---------- entegrasyonlar: WhatsApp / Telegram / Discord (botsuz) ----------
   Beast Agent mantığı: her kanal bir köprüyle bağlanır; izin listesindeki
   kişilerin mesajları Jev sohbetine (renderer) iletilir, Jev'in cevabı aynı
   kanaldan geri gönderilir. Bot/perm/sahip kavramları yoktur; her kişi kendi
   oturumunda konuşur (renderer tarafında intKey ile ayrılır). */
const WA_AUTH_DIR = path.join(APP_DIR, 'wa-auth');
const INT_DEBOUNCE_MS = 4500; // ardışık mesajları tek istekte birleştirme penceresi
const INT_REPLY_TIMEOUT_MS = 180000; // cevap gelmezse "yazıyor…" kapatılır

let wa = null;
let tg = null;
let dc = null;
const intQueues = new Map(); // 'kanal:chat' -> { timer, payloads[] }
const intPending = new Map(); // reqId -> { channel, chatId, threadId }
const waJidPn = new Map(); // LID jid -> gerçek telefon (gönderim yedek yolu)

function intLog(line) {
  logWrite(new Date().toISOString() + ' [ENT] ' + line);
}

function intEmit(channel, ev) {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('intg:event', { channel, ...ev }); } catch {}
  }
}

/* izin listesi eşleşmesi: sayısal ID birebir, @kullanıcı adı harf duyarsız */
function intFind(list, senderId, username) {
  if (!Array.isArray(list) || !list.length) return null; // boş liste = kimseye cevap yok
  const id = String(senderId || '').trim();
  const uname = String(username || '').replace(/^@/, '').toLowerCase();
  for (const e of list) {
    if (e === '*') return { id: '*', name: '' };
    const eid = String((e && e.id) || '').trim();
    if (!eid) continue;
    if (eid === '*') return { id: '*', name: '' };
    if (eid.startsWith('@')) {
      if (uname && eid.slice(1).toLowerCase() === uname) return e;
    } else if (id && eid === id) {
      return e;
    }
  }
  return null;
}

function waFind(num) {
  const list = settings.waAllow || [];
  if (!list.length) return null;
  const n = String(num || '').replace(/\D/g, '');
  for (const e of list) {
    if (e === '*') return { num: '*', name: '' };
    const en = String((e && e.num) || '').replace(/\D/g, '');
    if (!en) continue;
    if (en === '*' || (n && en === n)) return e;
  }
  return null;
}

function tgFind(senderId, username) {
  return intFind(settings.tgAllow || [], senderId, username);
}

function dcFind(senderId, username) {
  return intFind(settings.dcAllow || [], senderId, username);
}

/* 4.5 sn birleştirme: aynı sohbetten art arda gelen mesajlar tek istek olur */
function intQueuePush(channel, chatId, payload) {
  const key = channel + ':' + chatId;
  let q = intQueues.get(key);
  if (!q) {
    q = { payloads: [] };
    intQueues.set(key, q);
  }
  q.payloads.push(payload);
  clearTimeout(q.timer);
  q.timer = setTimeout(() => {
    intFlush(key).catch((e) => intLog('flush hata: ' + String((e && e.message) || e)));
  }, INT_DEBOUNCE_MS);
}

async function intFlush(key) {
  const q = intQueues.get(key);
  if (!q) return;
  intQueues.delete(key);
  const first = q.payloads[0] || {};
  const merged = {
    text: '',
    senderId: first.senderId || '',
    username: first.username || '',
    senderName: first.senderName || '?',
    isGroup: !!first.isGroup,
    chatTitle: first.chatTitle || '',
    threadId: first.threadId || null,
    label: first.label || '',
  };
  for (const p of q.payloads) {
    if (p.text) merged.text += (merged.text ? '\n' : '') + p.text;
  }
  if (!merged.text.trim()) return;
  const channel = first.channel;
  const chatId = first.chatId;
  const reqId = 'int-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  intPending.set(reqId, { channel, chatId, threadId: merged.threadId, at: Date.now() });
  setTimeout(() => {
    if (!intPending.has(reqId)) return;
    intPending.delete(reqId);
    if (channel === 'wa' && wa) wa.setComposing(chatId, false).catch(() => {});
    intLog('cevap zaman aşımı: ' + channel + ' ' + chatId);
  }, INT_REPLY_TIMEOUT_MS);
  if (channel === 'wa' && wa) wa.setComposing(chatId, true).catch(() => {});
  intLog('incoming ' + channel + ' chat=' + chatId + ' sender=' + (merged.senderName || merged.senderId) + (merged.isGroup ? ' (grup)' : ''));
  if (win && !win.isDestroyed()) {
    win.webContents.send('intg:incoming', {
      reqId,
      channel,
      chatId,
      senderName: merged.senderName || merged.senderId || '?',
      senderId: merged.senderId || '',
      username: merged.username || '',
      threadId: merged.threadId || null,
      isGroup: merged.isGroup,
      chatTitle: merged.chatTitle || '',
      text: merged.label + '\n' + merged.text,
      raw: merged.text,
    });
  } else {
    intPending.delete(reqId);
    if (channel === 'wa' && wa) wa.setComposing(chatId, false).catch(() => {});
  }
}

/* renderer'dan gelen cevabı ilgili kanaldan gönder */
async function intReplySend(p) {
  const reqId = String((p && p.reqId) || '');
  const text = String((p && p.text) || '');
  const pend = intPending.get(reqId);
  intPending.delete(reqId);
  const channel = (p && p.channel) || (pend && pend.channel);
  const chatId = (p && p.chatId) || (pend && pend.chatId);
  const threadId = (pend && pend.threadId) || (p && p.threadId);
  if (!channel || !chatId) return { ok: false, error: 'hedef yok' };
  if (!text.trim()) {
    if (channel === 'wa' && wa) wa.setComposing(chatId, false).catch(() => {});
    return { ok: false, error: 'boş cevap' };
  }
  let ok = false;
  try {
    if (channel === 'wa' && wa) {
      ok = !!(await wa.send(chatId, text));
      if (!ok) {
        /* LID adresi patlarsa bilinen gerçek numaraya tek kez düş */
        const pn = waJidPn.get(chatId);
        const pnJid = pn ? pn + '@s.whatsapp.net' : '';
        if (pnJid && pnJid !== chatId) ok = !!(await wa.send(pnJid, text));
      }
      try { await wa.setComposing(chatId, false); } catch {}
    } else if (channel === 'tg' && tg) {
      ok = !!(await tg.send(chatId, text, threadId));
    } else if (channel === 'dc' && dc) {
      ok = !!(await dc.send(chatId, text));
    }
  } catch (e) {
    intLog('cevap gönderilemedi ' + channel + ' → ' + chatId + ' · ' + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
  intLog((ok ? 'out ' : 'out BAŞARISIZ ') + channel + ' → ' + chatId + ' · ' + text.replace(/\s+/g, ' ').slice(0, 120));
  return { ok };
}
jipc.handle('intg:reply', (e, p) => intReplySend(p || {}));

/* kendiliğinden gönderim (otomatik analiz / alarm / işlem bildirimi):
   kişi hâlâ izin listesinde mi ve kanal bağlı mı — değilse sessizce atla */
function intPushAllowed(channel, chatId, senderId, username) {
  let hit = null;
  if (channel === 'wa') {
    if (String(chatId).endsWith('@g.us') && !(settings.waGroups && settings.waGroups.enabled)) return false;
    hit = waFind(senderId);
    return !!hit && (hit.num === '*' || !!hit.name);
  }
  if (channel === 'tg') hit = tgFind(senderId, username);
  else if (channel === 'dc') hit = dcFind(senderId, username);
  return !!hit && (hit.id === '*' || !!hit.name);
}

jipc.handle('intg:push', async (e, p) => {
  p = p || {};
  const channel = String(p.channel || '');
  const chatId = String(p.chatId || '');
  const text = String(p.text || '');
  if (!channel || !chatId || !text.trim()) return { ok: false, error: 'eksik' };
  const bridge = channel === 'wa' ? wa : channel === 'tg' ? tg : channel === 'dc' ? dc : null;
  if (!bridge || !bridge.connected) return { ok: false, skipped: 'bağlı değil' };
  if (!intPushAllowed(channel, chatId, p.senderId, p.username)) return { ok: false, skipped: 'izin listesinde değil' };
  return intReplySend({ channel, chatId, threadId: p.threadId || null, text });
});

/* ---- WhatsApp ---- */
async function handleWaIncoming(jid, payload, senderNum) {
  try {
    if (typeof payload === 'string') payload = { text: payload };
    const isGroup = !!payload.isGroup || jid.endsWith('@g.us');
    if (!isGroup && senderNum) waJidPn.set(jid, String(senderNum));
    const hit = waFind(senderNum);
    if (isGroup) {
      const g = settings.waGroups || {};
      if (!g.enabled) return;
      const mentionMode = g.mentionOnly !== false;
      if (mentionMode && !payload.mentioned) return;
      /* botsuz: grup mesajı da izin listesindeki kişiden gelmeli */
      if (!hit) return;
      if (hit.num !== '*' && !hit.name) return;
      const name = hit.name || payload.participantPn || senderNum || 'grup üyesi';
      intQueuePush('wa', jid, {
        channel: 'wa',
        chatId: jid,
        senderId: senderNum || '',
        senderName: name,
        isGroup: true,
        label: '[WhatsApp grup — gönderen: ' + name + (senderNum ? ' (+' + senderNum + ')' : '') + ']',
        text: payload.text,
      });
      return;
    }
    if (!hit) return;
    if (hit.num !== '*' && !hit.name) return;
    const name = hit.name || (senderNum ? '+' + senderNum : '?');
    intQueuePush('wa', jid, {
      channel: 'wa',
      chatId: jid,
      senderId: senderNum || '',
      senderName: name,
      isGroup: false,
      label: '[WhatsApp — gönderen: ' + name + ']',
      text: payload.text,
    });
  } catch (e) {
    intLog('WA gelen hata: ' + String((e && e.message) || e));
  }
}

function ensureWa() {
  if (!wa) {
    wa = new WhatsAppBridge({
      authDir: WA_AUTH_DIR,
      emit: (ev) => {
        if (ev.type === 'status') {
          intLog('wa status=' + ev.status + (ev.user ? ' user=' + ev.user : ''));
          /* eşleme tamamlandı — sonraki açılışlarda otomatik bağlan */
          if (ev.status === 'connected' && settings.waWasPaired !== true) {
            settings.waWasPaired = true;
            saveSettings();
          }
        }
        intEmit('wa', ev);
      },
      onIncoming: handleWaIncoming,
    });
  }
  return wa;
}

async function restartWa() {
  const b = ensureWa();
  if (b.sock) return b.snapshot();
  try {
    await b.start();
  } catch (e) {
    intLog('wa start hata: ' + String((e && e.message) || e));
  }
  return b.snapshot();
}

async function stopWa() {
  if (wa) {
    try { await wa.stop(); } catch {}
  }
}

async function resetWa() {
  const b = ensureWa();
  try { await b.resetAuth(); } catch {}
}

/* ---- Telegram ---- */
function handleTgIncoming(chatId, payload) {
  try {
    const hit = tgFind(payload.senderId, payload.username);
    if (!hit) return;
    if (hit.id !== '*' && !hit.name) return;
    const name = hit.name || payload.senderName || '?';
    const label = '[Telegram — gönderen: ' + name + (payload.username ? ' (@' + payload.username + ')' : '') + ']';
    intQueuePush('tg', chatId, {
      channel: 'tg',
      chatId,
      senderId: payload.senderId || '',
      username: payload.username || '',
      senderName: name,
      isGroup: !!payload.isGroup,
      chatTitle: payload.chatTitle || '',
      threadId: payload.messageThreadId || null,
      label,
      text: payload.text,
    });
  } catch (e) {
    intLog('TG gelen hata: ' + String((e && e.message) || e));
  }
}

function ensureTg() {
  if (!tg) {
    tg = new TelegramBridge({
      token: settings.tgToken || '',
      emit: (ev) => {
        if (ev.type === 'status') intLog('tg status=' + ev.status + (ev.user ? ' user=' + ev.user : ''));
        intEmit('tg', ev);
      },
      onIncoming: handleTgIncoming,
    });
  }
  return tg;
}

async function restartTg() {
  if (tg) {
    try { await tg.stop(); } catch {}
    tg = null;
  }
  if (!settings.tgToken) return;
  const b = ensureTg();
  try {
    await b.start();
  } catch (e) {
    intLog('tg start hata: ' + String((e && e.message) || e));
  }
}

/* ---- Discord ---- */
function handleDcIncoming(channelId, payload) {
  try {
    const hit = dcFind(payload.senderId, payload.username);
    if (!hit) return;
    if (hit.id !== '*' && !hit.name) return;
    const name = hit.name || payload.senderName || '?';
    const label = '[Discord — gönderen: ' + name + (payload.username ? ' (@' + payload.username + ')' : '') + ']';
    intQueuePush('dc', channelId, {
      channel: 'dc',
      chatId: channelId,
      senderId: payload.senderId || '',
      username: payload.username || '',
      senderName: name,
      isGroup: !!payload.isGroup,
      label,
      text: payload.text,
    });
  } catch (e) {
    intLog('DC gelen hata: ' + String((e && e.message) || e));
  }
}

function ensureDc() {
  if (!dc) {
    dc = new DiscordBridge({
      token: settings.dcToken || '',
      emit: (ev) => {
        if (ev.type === 'status') intLog('dc status=' + ev.status + (ev.user ? ' user=' + ev.user : ''));
        if (ev.type === 'warn') intLog('⚠ ' + String(ev.text || ''));
        intEmit('dc', ev);
      },
      onIncoming: handleDcIncoming,
    });
  }
  return dc;
}

async function restartDc() {
  if (dc) {
    try { await dc.stop(); } catch {}
    dc = null;
  }
  if (!settings.dcToken) return;
  const b = ensureDc();
  try {
    await b.start();
  } catch (e) {
    intLog('dc start hata: ' + String((e && e.message) || e));
  }
}

/* ---- durum + IPC ---- */
function intState() {
  const g = settings.waGroups || {};
  return {
    ok: true,
    wa: wa ? wa.snapshot() : { status: 'disconnected', user: null, available: true },
    waPaired: fs.existsSync(path.join(WA_AUTH_DIR, 'creds.json')),
    waGroups: { enabled: g.enabled === true, mentionOnly: g.mentionOnly !== false },
    waAllow: settings.waAllow || [],
    tg: tg ? tg.snapshot() : { status: 'disconnected', user: null },
    tgTokenSet: !!settings.tgToken,
    tgAllow: settings.tgAllow || [],
    dc: dc ? dc.snapshot() : { status: 'disconnected', user: null },
    dcTokenSet: !!settings.dcToken,
    dcAllow: settings.dcAllow || [],
  };
}

jipc.handle('intg:get', () => intState());

jipc.handle('wa:start', async () => { await restartWa(); return intState(); });
jipc.handle('wa:stop', async () => { await stopWa(); return intState(); });
jipc.handle('wa:reset', async () => { await resetWa(); return intState(); });
jipc.handle('wa:groups:set', (e, cfg) => {
  const g = settings.waGroups || (settings.waGroups = { enabled: false, mentionOnly: true });
  cfg = cfg || {};
  if (typeof cfg.enabled === 'boolean') g.enabled = cfg.enabled;
  if (typeof cfg.mentionOnly === 'boolean') g.mentionOnly = cfg.mentionOnly;
  saveSettings();
  return { ok: true, enabled: g.enabled === true, mentionOnly: g.mentionOnly !== false };
});
jipc.handle('wa:allow:get', () => settings.waAllow || []);
jipc.handle('wa:allow:set', (e, list) => {
  settings.waAllow = normAllowList(list, 'num');
  saveSettings();
  return settings.waAllow;
});
jipc.handle('tg:set', async (e, token) => {
  settings.tgToken = String(token || '').trim();
  saveSettings();
  await restartTg();
  return intState();
});
jipc.handle('tg:stop', async () => {
  if (tg) {
    try { await tg.stop(); } catch {}
  }
  return intState();
});
jipc.handle('tg:allow:get', () => settings.tgAllow || []);
jipc.handle('tg:allow:set', (e, list) => {
  settings.tgAllow = normAllowList(list, 'id');
  saveSettings();
  return settings.tgAllow;
});
jipc.handle('dc:set', async (e, token) => {
  settings.dcToken = String(token || '').trim();
  saveSettings();
  await restartDc();
  return intState();
});
jipc.handle('dc:stop', async () => {
  if (dc) {
    try { await dc.stop(); } catch {}
  }
  return intState();
});
jipc.handle('dc:allow:get', () => settings.dcAllow || []);
jipc.handle('dc:allow:set', (e, list) => {
  settings.dcAllow = normAllowList(list, 'id');
  saveSettings();
  return settings.dcAllow;
});

/* ---------- borsa yönlendirme (MT5 / Binance / OKX) ---------- */
function exActive() {
  return ['mt5', 'binance', 'okx'].includes(settings.exchange) ? settings.exchange : 'mt5';
}
function exLabelName(name) {
  return name === 'binance' ? 'Binance' : 'OKX';
}
function exDemoBalance(name) {
  const b = Number((settings[name] || {}).demoBalance);
  return b > 0 ? b : papermod.DEFAULT_BALANCE;
}
/* demo modu açıksa tüm işlemler yerel deneme (paper) hesabında simüle edilir;
   kapalıysa gerçek hesap anahtarlarıyla borsaya gidilir.
   exOverride / modeOverride: yerel HTTP API'nin (api.js) borsa ve hesap türü seçimi. */
function exDispatch(method, params, timeoutMs, exOverride, modeOverride) {
  const ex = ['mt5', 'binance', 'okx'].includes(exOverride) ? exOverride : exActive();
  if (ex === 'mt5') {
    /* MT5 ile iş yapılacaksa köprüyü tembel başlat — ama YALNIZCA MT5 borsası
       seçiliyken: başka borsada (OKX/Binance) MT5 terminali kendiliğinden açılmaz.
       Köprü her zaman SESSİZ başlatılır: terminal kapalıysa yalnız bağlanmaz,
       asla kendiliğinden MT5 açmaz (JevTrader dışında hiç açılmaz). */
    if (!mt5bridge.running && exActive() === 'mt5') startMt5({ launch: false });
    return mt5bridge.call(method, params, timeoutMs);
  }
  const s = settings[ex] || {};
  const demo = modeOverride === 'demo' ? true : modeOverride === 'real' ? false : s.demo === true;
  if (demo) return papermod.call(ex, method, params, { balance: exDemoBalance(ex) });
  return cryptomod.call(ex, method, params, { key: s.key || '', secret: s.secret || '', pass: s.pass || '' });
}

jipc.handle('ex:get', () => ({ ok: true, exchange: exActive() }));
jipc.handle('ex:set', (e, name) => {
  const v = ['mt5', 'binance', 'okx'].includes(name) ? name : 'mt5';
  const prev = exActive();
  settings.exchange = v;
  saveSettings();
  if (v === 'mt5') {
    /* MT5 moduna geçildiyse köprü açılsın — terminal yalnız JevTrader modu
       açıkken başlatılır, aksi hâlde sessiz başlatılır */
    ensureMt5();
  } else if (prev === 'mt5') {
    /* başka borsaya geçildi: MT5 köprüsü kapatılır, terminal artık açılmaz */
    try { mt5bridge.stop(); } catch {}
  }
  return { ok: true, exchange: v };
});
jipc.handle('ex:keysGet', (e, name) => {
  const k = settings[name] || {};
  return {
    ok: true,
    key: k.key || '', secret: k.secret || '', pass: k.pass || '',
    demo: k.demo === true,
    demoBalance: exDemoBalance(name),
  };
});
/* kaydet: mode 'real' → API anahtarları, mode 'demo' → yerel deneme başlangıç bakiyesi;
   demo alanı verilirse aktif hesap türü de ayarlanır */
jipc.handle('ex:keysSet', (e, p) => {
  const name = p && p.name;
  if (name !== 'binance' && name !== 'okx') return { ok: false, error: 'geçersiz borsa' };
  const mode = (p && p.mode) === 'demo' ? 'demo' : 'real';
  const cur = settings[name] || (settings[name] = {});
  if (mode === 'demo') {
    const bal = Number(p && p.balance);
    if (Number.isFinite(bal) && bal > 0) cur.demoBalance = bal;
  } else {
    cur.key = String((p && p.key) || '').trim();
    cur.secret = String((p && p.secret) || '').trim();
    if (name === 'okx') cur.pass = String((p && p.pass) || '').trim();
  }
  if (p && typeof p.demo === 'boolean') cur.demo = p.demo;
  saveSettings();
  return { ok: true, demo: cur.demo === true, demoBalance: exDemoBalance(name) };
});
/* yerel deneme hesabını sıfırla: pozisyon/emir/geçmiş silinir, bakiye başa döner */
jipc.handle('ex:demoReset', (e, p) => {
  const name = p && p.name;
  if (name !== 'binance' && name !== 'okx') return { ok: false, error: 'geçersiz borsa' };
  const cur = settings[name] || (settings[name] = {});
  const bal = Number(p && p.balance);
  if (Number.isFinite(bal) && bal > 0) {
    cur.demoBalance = bal;
    saveSettings();
  }
  const used = exDemoBalance(name);
  papermod.reset(name, used);
  return { ok: true, balance: used };
});
jipc.handle('ex:test', async (e, name) => {
  if (name === 'mt5') {
    /* bağlantı denemesi: terminali açmadan dene (kullanıcı elle açmalı) */
    if (!mt5bridge.running) startMt5({ launch: false });
    const r = await mt5bridge.call('ping', {}, 15000);
    return r && r.ok ? { ok: true, summary: 'MT5 köprüsü çalışıyor' } : { ok: false, error: (r && r.error) || 'MT5 yanıt vermedi' };
  }
  const s = settings[name] || {};
  const demo = s.demo === true;
  const r = demo
    ? await papermod.call(name, 'account', {}, { balance: exDemoBalance(name) })
    : await cryptomod.call(name, 'account', {}, { key: s.key || '', secret: s.secret || '', pass: s.pass || '' });
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'bağlantı hatası' };
  const a = r.data.account || {};
  return { ok: true, summary: exLabelName(name) + (demo ? ' Demo (yerel)' : '') + ' · Bakiye ' + Number(a.balance || 0).toFixed(2) + ' ' + (a.currency || 'USDT') + ' · Serbest ' + Number(a.margin_free || 0).toFixed(2) };
});

/* ---------- para transferi / çekim (yalnız OKX GERÇEK hesap) ----------
   Transferler simüle edilmez; okx.demo açık olsa bile bu bölüm gerçek hesabın
   API anahtarlarıyla çalışır ve işlem geçmişi settings.json'a kaydedilir. */
function okxRealKeys() {
  const s = settings.okx || {};
  return { key: String(s.key || ''), secret: String(s.secret || ''), pass: String(s.pass || '') };
}
function okxKeysReady() {
  const k = okxRealKeys();
  return !!(k.key && k.secret && k.pass);
}
function addTransferLog(rec) {
  const list = Array.isArray(settings.transferLog) ? settings.transferLog : (settings.transferLog = []);
  list.unshift({ at: new Date().toISOString(), ex: 'okx', ...rec });
  settings.transferLog = list.slice(0, 100);
  saveSettings();
}

jipc.handle('ex:transferInfo', async (e, p) => {
  const ccy = String((p && p.ccy) || 'USDT').toUpperCase().slice(0, 16);
  const base = {
    ok: true,
    ccy,
    keysReady: okxKeysReady(),
    demoMode: (settings.okx || {}).demo === true,
    active: exActive(),
    last: settings.transferLast || null,
    log: (settings.transferLog || []).slice(0, 30),
  };
  if (!base.keysReady) return base;
  const k = okxRealKeys();
  const [cur, fund, trade] = await Promise.all([
    cryptomod.call('okx', 'currencies', { ccy }, k),
    cryptomod.call('okx', 'asset_balances', { ccy }, k),
    cryptomod.call('okx', 'trade_balances', { ccy }, k),
  ]);
  base.currencies = cur.ok ? cur.data.currencies : [];
  base.currenciesError = cur.ok ? '' : cur.error;
  base.funding = fund.ok ? fund.data.balances : [];
  base.fundingError = fund.ok ? '' : fund.error;
  base.trading = trade.ok ? trade.data.balances : [];
  base.tradingError = trade.ok ? '' : trade.error;
  return base;
});

jipc.handle('ex:transfer', async (e, p) => {
  if (!okxKeysReady()) return { ok: false, error: 'OKX gerçek hesap anahtarları yok — Ayarlar > OKX API', needKeys: true };
  const k = okxRealKeys();
  const r = await cryptomod.call('okx', 'transfer', {
    ccy: (p && p.ccy) || 'USDT',
    amt: p && p.amt,
    from: p && p.from,
    to: p && p.to,
  }, k);
  if (r && r.ok) {
    const t = r.data.transfer || {};
    addTransferLog({ kind: 'transfer', ccy: t.ccy, amt: t.amt, from: t.from, to: t.to, id: t.transId, state: 'success' });
    settings.transferLast = { kind: 'transfer', ccy: t.ccy, amt: t.amt, from: t.from, to: t.to };
    saveSettings();
  }
  return r;
});

jipc.handle('ex:withdraw', async (e, p) => {
  if (!okxKeysReady()) return { ok: false, error: 'OKX gerçek hesap anahtarları yok — Ayarlar > OKX API', needKeys: true };
  const k = okxRealKeys();
  const r = await cryptomod.call('okx', 'withdraw', {
    ccy: p && p.ccy,
    amt: p && p.amt,
    dest: p && p.dest,
    toAddr: p && p.toAddr,
    chain: p && p.chain,
    fee: p && p.fee,
    toAddrType: p && p.toAddrType,
    areaCode: p && p.areaCode,
  }, k);
  if (r && r.ok) {
    const w = r.data.withdrawal || {};
    addTransferLog({
      kind: 'withdraw', ccy: w.ccy, amt: w.amt, fee: Number(p && p.fee) || 0,
      chain: w.chain, toAddr: String((p && p.toAddr) || ''),
      tag: String((p && p.tag) || ''), id: w.wdId, state: 'pending',
      dest: String((p && p.dest) || '4'),
    });
    settings.transferLast = {
      kind: 'withdraw', ccy: w.ccy, chain: w.chain,
      toAddr: String((p && p.toAddr) || ''), tag: String((p && p.tag) || ''),
      dest: String((p && p.dest) || '4'), amt: w.amt,
    };
    saveSettings();
  }
  return r;
});

jipc.handle('ex:transferHistory', async (e, p) => {
  const log = (settings.transferLog || []).slice(0, 30);
  if (!okxKeysReady()) return { ok: false, error: 'OKX gerçek hesap anahtarları yok — Ayarlar > OKX API', log };
  const k = okxRealKeys();
  const ccy = String((p && p.ccy) || '').toUpperCase();
  const [w, t] = await Promise.all([
    cryptomod.call('okx', 'withdrawals', { ccy, limit: 20 }, k),
    cryptomod.call('okx', 'transfers', { ccy, limit: 20 }, k),
  ]);
  return {
    ok: true,
    withdrawals: w.ok ? w.data.withdrawals : [],
    withdrawalsError: w.ok ? '' : w.error,
    transfers: t.ok ? t.data.transfers : [],
    transfersError: t.ok ? '' : t.error,
    log,
  };
});

jipc.handle('ex:rates', (e, p) => exDispatch('rates', p || {}, 15000));
/* arka plan alarmları: aktif borsa değişse bile İSTENEN borsadan fiyat çekilebilir.
   İstenen borsa MT5 ise ve uygulama başka borsada seçiliyse terminal bir daha
   açılmaz: köprü çalışmıyorsa boş fiyat döner (o alarm o borsada tetiklenmez) */
jipc.handle('ex:ratesAt', (e, p) => {
  const ex = p && ['mt5', 'binance', 'okx'].includes(p.exchange) ? p.exchange : exActive();
  if (ex === 'mt5' && exActive() !== 'mt5' && !mt5bridge.running) return { ok: true, data: { rates: [] } };
  return exDispatch('rates', { symbol: p && p.symbol, timeframe: (p && p.timeframe) || 'M1', count: (p && p.count) || 1 }, 15000, ex);
});
jipc.handle('ex:ticks', (e, p) => exDispatch('ticks', p || {}, 10000));
jipc.handle('ex:allSymbols', (e, p) => exDispatch('all_symbols', p || {}, 25000));
jipc.handle('ex:symbols', (e, p) => exDispatch('symbols', p || {}, 15000));
jipc.handle('ex:account', () => exDispatch('account', {}, 12000));
jipc.handle('ex:positions', () => exDispatch('positions', {}, 12000));
jipc.handle('ex:orders', () => exDispatch('orders', {}, 12000));
jipc.handle('ex:closed', (e, p) => exDispatch('closed', p || {}, 25000));
jipc.handle('ex:market', (e, p) => exDispatch('market', p || {}, 20000));
jipc.handle('ex:pending', (e, p) => exDispatch('pending', p || {}, 20000));
jipc.handle('ex:close', (e, p) => exDispatch('close', p || {}, 20000));
jipc.handle('ex:modify', (e, p) => exDispatch('modify', p || {}, 20000));
jipc.handle('ex:orderDelete', (e, p) => exDispatch('order_delete', p || {}, 15000));
jipc.handle('ex:orderModify', (e, p) => exDispatch('order_modify', p || {}, 20000));
jipc.handle('ex:leverageInfo', (e, p) => exDispatch('leverage_info', p || {}, 20000));

/* ---------- yerel HTTP API (dışarıdan API anahtarı ile sorgu) ---------- */
function apiCfg() {
  if (!settings.api || typeof settings.api !== 'object') {
    settings.api = { enabled: false, host: '127.0.0.1', port: 8787, keys: [] };
  }
  if (!Array.isArray(settings.api.keys)) settings.api.keys = [];
  return settings.api;
}

/* hesap türü: MT5 canlı; Binance/OKX uygulamadaki gerçek/deneme seçimine göre */
function apiAccountMode(ex) {
  return ex === 'mt5' ? 'real' : ((settings[ex] || {}).demo === true ? 'demo' : 'real');
}

function apiState() {
  const a = apiCfg();
  const st = apiserver.status();
  const urlHost = a.host === '0.0.0.0' ? '127.0.0.1' : (a.host || '127.0.0.1');
  return {
    ok: true,
    enabled: a.enabled === true,
    host: a.host || '127.0.0.1',
    port: Number(a.port) || 8787,
    running: st.running === true,
    error: st.error || '',
    uptime_s: st.uptime_s || 0,
    baseUrl: 'http://' + urlHost + ':' + (Number(a.port) || 8787),
    exchange: exActive(),
    account: apiAccountMode(exActive()),
    version: codeVersion.version,
    build: codeVersion.build,
    keys: (a.keys || []).map((k) => ({
      id: k.id,
      name: k.name,
      key: k.key,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      calls: Number(k.calls) || 0,
    })),
  };
}

function apiSync() {
  const a = apiCfg();
  if (a.enabled === true) apiserver.start({ host: a.host || '127.0.0.1', port: Number(a.port) || 8787 });
  else apiserver.stop();
}

let apiStatsTimer = null;
function apiKeyUsed(id) {
  const a = apiCfg();
  const k = (a.keys || []).find((x) => x.id === id);
  if (!k) return;
  k.calls = (Number(k.calls) || 0) + 1;
  k.lastUsedAt = new Date().toISOString();
  if (!apiStatsTimer) apiStatsTimer = setTimeout(() => { apiStatsTimer = null; saveSettings(); }, 15000);
}

apiserver.init({
  keys: () => apiCfg().keys,
  activeExchange: () => exActive(),
  exchangeMode: (ex) => apiAccountMode(ex),
  dispatch: (ex, method, params, timeout, account) => exDispatch(method, params, timeout, ex, account),
  keyUsed: (id) => apiKeyUsed(id),
  log: (line) => logWrite(line),
  logRead: (n) => {
    const LOG_FILE = logFile();
    try {
      const txt = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = txt.split('\n').filter((l) => l.length);
      return { ok: true, lines: lines.slice(-(Math.max(1, Number(n) || 200))), path: LOG_FILE };
    } catch {
      return { ok: true, lines: [], path: LOG_FILE };
    }
  },
  health: () => ({
    app: 'JevTrader',
    version: codeVersion.version,
    build: codeVersion.build,
    exchange: exActive(),
    account: apiAccountMode(exActive()),
    mt5: mt5bridge.status(),
    exchanges: {
      mt5: { demo: false, ready: mt5bridge.status().connected },
      binance: { demo: (settings.binance || {}).demo === true, keys: !!((settings.binance || {}).key && (settings.binance || {}).secret) },
      okx: { demo: (settings.okx || {}).demo === true, keys: !!((settings.okx || {}).key && (settings.okx || {}).secret && (settings.okx || {}).pass) },
    },
  }),
});

jipc.handle('api:get', () => apiState());

jipc.handle('api:set', (e, cfg) => {
  const a = apiCfg();
  cfg = cfg || {};
  if (typeof cfg.enabled === 'boolean') a.enabled = cfg.enabled;
  if (cfg.host === '0.0.0.0' || cfg.host === '127.0.0.1') a.host = cfg.host;
  if (cfg.port != null) {
    const n = Number(cfg.port);
    if (Number.isFinite(n) && n >= 1 && n <= 65535) a.port = Math.round(n);
  }
  saveSettings();
  apiSync();
  logWrite(new Date().toISOString() + ' [API] ayar: ' + (a.enabled === true ? 'açık' : 'kapalı') + ' · ' + a.host + ':' + a.port);
  return apiState();
});

jipc.handle('api:keyCreate', (e, p) => {
  const a = apiCfg();
  if ((a.keys || []).length >= 20) return { ok: false, error: 'en fazla 20 anahtar oluşturulabilir' };
  const name = String((p && p.name) || '').trim().slice(0, 60) || ('Anahtar ' + ((a.keys || []).length + 1));
  const row = {
    id: 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    key: 'jvt_' + crypto.randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
    lastUsedAt: '',
    calls: 0,
  };
  a.keys.push(row);
  saveSettings();
  logWrite(new Date().toISOString() + ' [API] anahtar oluşturuldu: ' + name);
  return { ok: true, key: row, api: apiState() };
});

jipc.handle('api:keyRevoke', (e, id) => {
  const a = apiCfg();
  const before = a.keys.length;
  a.keys = a.keys.filter((k) => String(k.id) !== String(id || ''));
  if (a.keys.length === before) return { ok: false, error: 'anahtar bulunamadı' };
  saveSettings();
  logWrite(new Date().toISOString() + ' [API] anahtar silindi');
  return { ok: true, api: apiState() };
});

/* uygulamanın kendi API'sine istek atarak uçtan uca doğrula */
jipc.handle('api:selftest', async () => {
  const a = apiCfg();
  if (a.enabled !== true) return { ok: false, error: 'API kapalı — önce aç' };
  const key = (a.keys || [])[0];
  if (!key) return { ok: false, error: 'anahtar yok — önce anahtar oluştur' };
  const host = a.host === '0.0.0.0' ? '127.0.0.1' : (a.host || '127.0.0.1');
  const url = 'http://' + host + ':' + (Number(a.port) || 8787) + '/api/v1/health';
  try {
    const res = await fetch(url, { headers: { 'x-api-key': key.key }, signal: AbortSignal.timeout(8000) });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      return { ok: false, error: (data && data.error) || ('HTTP ' + res.status) };
    }
    const d = data.data || {};
    return { ok: true, summary: 'HTTP ' + res.status + ' · borsa ' + (d.exchange || '?') + ' · ' + (d.account || '?') };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* ---------- pencere ---------- */
jipc.handle('win:min', () => { if (win) win.minimize(); });
jipc.handle('win:max', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
jipc.handle('win:close', () => { if (win) win.close(); });
jipc.handle('shell:openExternal', (e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
});

/* masaüstü bildirimi (alarmlar) */
jipc.handle('app:notify', (e, p) => {
  try {
    const title = String((p && p.title) || 'JevTrader').slice(0, 80);
    const body = String((p && p.body) || '').slice(0, 200);
    if (Notification.isSupported()) new Notification({ title, body, silent: true }).show();
    if (win && !win.isDestroyed()) {
      try { win.flashFrame(true); } catch {}
    }
  } catch {}
  return { ok: true };
});

function start() {
  /* günlük forex haberleri: her gün 08:30'da otomatik çekilir; açılışta bugünün
     haberleri eksikse (ya da ilk kez çalışıyorsa) bir kez hemen çekilir */
  scheduleDailyNews();
  setTimeout(() => {
    const now = new Date();
    const after830 = now.getHours() > NEWS_HOUR || (now.getHours() === NEWS_HOUR && now.getMinutes() >= NEWS_MIN);
    if (!newsCache.items.length || (newsCache.date !== newsDayKey(now) && after830)) {
      fetchDailyNews(!newsCache.items.length).catch(() => {});
    }
  }, 6000);
  /* MT5 terminali kendiliğinden AÇILMAZ: köprü sessiz başlatılır (terminal
     kapalıysa yalnız bağlanmaz). Terminal yalnız JevTrader modu açıkken VE
     MT5 borsası seçiliyken başlatılır. */
  if (exActive() === 'mt5') startMt5({ launch: false });
  apiSync();
  /* entegrasyonlar: kayıtlı token/eşleme varsa köprüleri otomatik başlat */
  try { if (settings.tgToken) restartTg(); } catch {}
  try { if (settings.dcToken) restartDc(); } catch {}
  try {
    if (settings.waWasPaired && fs.existsSync(path.join(WA_AUTH_DIR, 'creds.json'))) restartWa();
  } catch {}
}

function shutdown() {
  try { mt5bridge.stop(); } catch {}
  try { apiserver.stop(); } catch {}
  try { if (wa) wa.stop(); } catch {}
  try { if (tg) tg.stop(); } catch {}
  try { if (dc) dc.stop(); } catch {}
}

module.exports = { start, shutdown, setWebContents, setJevMode };
