'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Tray, Menu, nativeImage, desktopCapturer, session, net: electronNet } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const dns = require('dns');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Engine, OBSERVE_MARK } = require('./agent/engine');
const { loadBeastConfig, beastDir } = require('./agent/config');
const bots = require('./agent/bots');
const mqueue = require('./agent/mqueue');
const memory = require('./agent/memory');
const skillsMod = require('./agent/skills');
const storeMod = require('./agent/store');
const { WhatsAppBridge } = require('./agent/whatsapp');
const { TelegramBridge } = require('./agent/telegram');
const { DiscordBridge } = require('./agent/discord');
const cron = require('./cron');
const watchers = require('./agent/watchers');
const usageMod = require('./agent/usage');
const bus = require('./agent/bus');
const computeruse = require('./agent/computeruse');
const log = require('./agent/logger');

/* #3 otomatik updater: sessiz — indirir, kapanışta kurar, kullanıcıya soru sormaz.
   Paketlenmemiş (npm start) modda devre dışı; Update sekmesi ve /update komutu kontrol eder. */
let autoUpdater = null;
try { if (app.isPackaged) autoUpdater = require('electron-updater').autoUpdater; } catch {}

const updateState = { checking: false, available: false, downloaded: false, version: null, progress: null, error: null };
const updateReplies = { sids: new Set(), jids: new Set() }; // /update isteyen hedefler — sonuç oraya gider

function isNpmMode() {
  return !app.isPackaged && /node_modules[\\/]beast-agent/i.test(String(app.getAppPath()));
}

/* npm registry'den en son sürüm (10 dk cache) — Update sekmesi + otomatik kontrol */
let npmLatestCache = { version: null, at: 0 };

function isNewerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

async function getNpmLatest(force) {
  const now = Date.now();
  if (!force && npmLatestCache.version && now - npmLatestCache.at < 10 * 60 * 1000) return npmLatestCache.version;
  try {
    const res = await fetch('https://registry.npmjs.org/beast-agent/latest', { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const j = await res.json();
      const v = String(j.version || '').trim();
      if (v) npmLatestCache = { version: v, at: now };
    }
  } catch {}
  return npmLatestCache.version;
}

function emitUpdateEvent() {
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:event', { type: 'update', ...updateState, current: app.getVersion() });
    }
  } catch {}
}

function replyUpdate(text) {
  try {
    for (const sid of updateReplies.sids) desktopEcho(sid, '/update', text);
    for (const jid of updateReplies.jids) sendWaSafe(jid, text).catch(() => {});
    updateReplies.sids.clear();
    updateReplies.jids.clear();
  } catch {}
}

function startAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  try {
    autoUpdater.autoDownload = settings.autoDownloadUpdate !== false;   // sessiz indir (toggle'lı)
    autoUpdater.autoInstallOnAppQuit = true;                            // kapanışta sessiz kur
    autoUpdater.logger = {
      info: (m) => waLog('[UPD] ' + m),
      warn: (m) => waLog('[UPD] ' + m),
      error: (m) => waLog('[UPD] ' + m),
      debug: () => {},
    };
    autoUpdater.on('checking-for-update', () => {
      updateState.checking = true; updateState.error = null; emitUpdateEvent();
    });
    autoUpdater.on('update-available', (i) => {
      updateState.checking = false; updateState.available = true;
      updateState.version = (i && i.version) || null;
      emitUpdateEvent();
      replyUpdate(`🔄 *Yeni sürüm bulundu:* v${updateState.version} (mevcut v${app.getVersion()}) — indiriliyor…`);
    });
    autoUpdater.on('update-not-available', () => {
      updateState.checking = false; updateState.available = false; updateState.version = null;
      emitUpdateEvent();
      replyUpdate(`✅ *Güncelsin* — v${app.getVersion()} en son sürüm.`);
    });
    autoUpdater.on('download-progress', (p) => {
      updateState.progress = {
        percent: Math.round(Number(p && p.percent) || 0),
        mbps: Math.round((Number(p && p.bytesPerSecond) || 0) / 1048576 * 10) / 10,
      };
      emitUpdateEvent();
    });
    autoUpdater.on('update-downloaded', (i) => {
      updateState.checking = false; updateState.downloaded = true;
      updateState.version = (i && i.version) || updateState.version;
      updateState.progress = null;
      emitUpdateEvent();
      waLog('[UPD] güncelleme indirildi — /update now veya kapanışta kurulacak');
      replyUpdate(`✅ *v${updateState.version} indirildi.* Kurmak için: \`/update now\` — ya da uygulama kapanınca otomatik kurulur.`);
    });
    autoUpdater.on('error', (e) => {
      updateState.checking = false; updateState.error = String((e && e.message) || e);
      emitUpdateEvent();
    });
    /* otomatik kontrol: açılışta + 6 saatte bir (Update sekmesinden kapatılabilir) */
    if (settings.autoCheckUpdate !== false) {
      const check = () => autoUpdater.checkForUpdates().catch(() => {});
      check();
      setInterval(check, 6 * 60 * 60 * 1000);
    }
  } catch {}
}

/* npm kurulumu için otomatik sürüm kontrolü (registry üzerinden, 6 saatte bir) */
function startNpmUpdateWatch() {
  if (!isNpmMode() || settings.autoCheckUpdate === false) return;
  const check = async () => {
    try {
      const v = await getNpmLatest();
      if (v && isNewerVersion(v, app.getVersion()) && !updateState.available) {
        updateState.available = true;
        updateState.version = v;
        emitUpdateEvent();
        log.info('main', `npm: yeni sürüm var ${v} (mevcut ${app.getVersion()})`);
      }
    } catch {}
  };
  check();
  setInterval(check, 6 * 60 * 60 * 1000);
}
const toolsMod = require('./agent/tools');
const { htmlToText, setSearchChain, setSearchObscuraEnabled, setTinyfishKey } = toolsMod;
const obscura = require('./agent/obscura');
/* OpenCode köprüsü KALDIRILDI: Beast Code artık tamamen BEAST motoruyla
   çalışır — opencode'in döngü mantığı (compaction, prune, cache disiplini,
   doom-loop, yetim onarım) engine.js'e native port edildi. */
const { waToolLine } = require('./agent/watext');

/* #3 merkezî log sistemine process-seviye hataları da düşsün */
process.on('uncaughtException', (e) => { try { log.error('main', 'uncaughtException: ' + ((e && e.stack) || e)); } catch {} });
process.on('unhandledRejection', (e) => { try { log.error('main', 'unhandledRejection: ' + ((e && e.stack) || e)); } catch {} });

/* #1 Splash /health — her zaman açık uç nokta: uygulamanın ayakta olduğunu bildirir */
function startHealthServer() {
  const port = Number(settings.healthPort) || 8788;
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url.startsWith('/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()), version: app.getVersion() }));
      return;
    }
    res.writeHead(404).end();
  });
  server.on('error', (e) => log.error('health', 'başlatılamadı: ' + ((e && e.message) || e)));
  server.listen(port, '127.0.0.1', () => log.info('health', `health endpoint hazır: http://127.0.0.1:${port}/health`));
}

/* WA tool-ping throttle: sid -> son bildirim zamanı */
const lastWaToolPing = new Map();

/* ilk QR eşlemesi sonrası otomatik restart bekleyeni (#v13) */
let waAwaitingRestart = false;

let ImapFlow = null;
let nodemailer = null;
/* imapflow yeni sürümlerde named export ({ ImapFlow }) verir, eskisi direkt
   class'tı — her iki şekli de (ve ESM default'unu) kapsayacak şekilde çöz */
try {
  const _if = require('imapflow');
  ImapFlow = (_if && (_if.ImapFlow || _if.default)) || (typeof _if === 'function' ? _if : null);
} catch {}
try { nodemailer = require('nodemailer'); } catch {}

const APP_DIR = path.join(app.getPath('appData'), 'beast');

/* ÖNCÜ SAĞLAYICILAR (BÖLÜM 9): endpoint bilmeye gerek yok — picker'dan seç,
   sadece API key gir, modeller otomatik çekilir. Hepsi OpenAI-uyumlu. */
const BUILTIN_PROVIDERS = [
  { id: 'opencode-zen', name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/zen/v1', hint: 'Ücretsiz modeller var — anahtar: opencode.ai/auth' },
  { id: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', hint: 'Abonelik anahtarı' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', hint: 'openrouter.ai/keys' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', hint: 'platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', hint: 'console.anthropic.com' },
  { id: 'gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', hint: 'aistudio.google.com/apikey' },
  { id: 'zhipu', name: 'Zhipu AI', baseUrl: 'https://api.z.ai/api/paas/v4', hint: 'z.ai model konsolu' },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', hint: 'console.groq.com/keys' },
  { id: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1', hint: 'build.nvidia.com — ücretsiz kredi veriyor, talep yüksek' },
];
const SESSIONS_DIR = path.join(APP_DIR, 'sessions');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const SETTINGS_BACKUP_FILE = path.join(APP_DIR, 'settings.backup.json');
const WA_AUTH_DIR = path.join(APP_DIR, 'wa-auth');
const WA_CHATS_FILE = path.join(APP_DIR, 'wa-chats.json');
const FALLOUT_CRASH_FILE = path.join(APP_DIR, 'fallout-crash.json');
const CHAT_QUEUE_FILE = path.join(APP_DIR, 'chat_queue.json');
const TG_CHATS_FILE = path.join(APP_DIR, 'tg-chats.json');

for (const d of [APP_DIR, SESSIONS_DIR]) fs.mkdirSync(d, { recursive: true });

let win = null;
let engine = null;
let settings = loadSettings();
ensureBeastCode();
startHealthServer(); /* splash/boot aşamasından itibaren /health ayakta */
try { setSearchObscuraEnabled(settings.obscuraEnabled !== false); } catch {} /* Obscura varsayılan AKTİF */
try { setSearchChain(settings.searchChain); } catch {}
try { setTinyfishKey(settings.tinyfishKey || null); } catch {}
/* kurulumda Obscura da kurulsun: yoksa ARKA PLANDA otomatik indir (UI kilitlenmez);
   ilerleme Ayarlar → Web Arama'dan da izlenebilir */
setTimeout(() => {
  if (!obscura.obscuraInstalled()) startObscuraInstall();
}, 4000).unref?.();
let wa = null;
let waChats = new Map(); // jid -> aktif session id
let waHistory = new Map(); // jid -> [sid,...] bu sohbete ait tüm oturumlar
let waBcMode = new Set(); // jid -> BeastCode modu AKTİF (WhatsApp'tan uzaktan kodlama)
let waJidPn = new Map(); // jid -> gerçek telefon numarası (LID fallback için)
const WA_HISTORY_CAP = 20;
let tg = null;
let tgChats = new Map(); // telegram chatId -> aktif session id
let tgHistory = new Map(); // chatId -> [sid,...]
const TG_HISTORY_CAP = 20;
let dc = null;
let dcChats = new Map(); // discord channelId -> aktif session id
let dcHistory = new Map(); // channelId -> [sid,...]
const DC_HISTORY_CAP = 20;
const DC_CHATS_FILE = path.join(APP_DIR, 'dc-chats.json');
let tray = null;
app.isQuitting = false;

try {
  const raw = JSON.parse(fs.readFileSync(WA_CHATS_FILE, 'utf8'));
  /* yeni format {chats, history}; eski düz dizi de kabul edilir */
  if (Array.isArray(raw)) {
    for (const [j, s] of raw) {
      if (typeof j === 'string' && j.includes('@') && typeof s === 'string') {
        waChats.set(j, s);
        waHistory.set(j, [s]);
      }
    }
  } else if (raw && typeof raw === 'object') {
    if (raw.chats && typeof raw.chats === 'object') {
      for (const [j, s] of Object.entries(raw.chats)) {
        if (typeof s === 'string') waChats.set(j, s);
      }
    }
    if (raw.history && typeof raw.history === 'object') {
      for (const [j, arr] of Object.entries(raw.history)) {
        if (Array.isArray(arr)) {
          waHistory.set(
            j,
            arr.filter((x) => typeof x === 'string').slice(-WA_HISTORY_CAP)
          );
        }
      }
    }
    /* history'siz kalan chatler için geçmişe ekle */
    for (const [j, s] of waChats.entries()) {
      const h = waHistory.get(j) || [];
      if (!h.includes(s)) h.push(s);
      waHistory.set(j, h.slice(-WA_HISTORY_CAP));
    }
    /* BeastCode modu: hangi sohbetler uzaktan kodlama yapıyor */
    if (Array.isArray(raw.bcMode)) {
      for (const j of raw.bcMode) if (typeof j === 'string') waBcMode.add(j);
    }
  }
} catch {}

function saveWaChats() {
  try {
    fs.writeFileSync(
      WA_CHATS_FILE,
      JSON.stringify({
        chats: Object.fromEntries(waChats),
        history: Object.fromEntries([...waHistory.entries()].map(([j, a]) => [j, a.slice(-WA_HISTORY_CAP)])),
        bcMode: [...waBcMode],
      })
    );
  } catch {}
}

/* jid'in oturum geçmişine sid ekler (tekilleştirilmiş, kırpılmış) */
function waRememberSession(jid, sid) {
  const h = waHistory.get(jid) || [];
  if (!h.includes(sid)) h.push(sid);
  waHistory.set(jid, h.slice(-WA_HISTORY_CAP));
}

/* ---------- BEASTCODE MODU (WA'dan uzaktan kodlama) ----------
   /beastcode → sohbet BEAST CODE oturumuna döner: masaüstü IDE paneliyle
   AYNI motor (engine bcCode + buildBcSystem) — todo planı, edit_file/run_command
   disiplini, /plan /build /auto modları. Dosyalar Kullanıcı\BeastCode'a düşer.
   /beastagent → normal sohbet oturumuna geri dönülür. */

function waBcWorkspace() {
  /* masaüstü Beast Code paneliyle AYNI klasör — WhatsApp'tan yazınca
     panelde aynı dosyalar canlı görünür */
  const dir = ideRoot();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/* Sohbetin Beast Code oturumu: masaüstü paneliyle AYNI oturum (klasör bazlı
   bcGetSession) — WhatsApp'tan yazılan sohbet, masaüstü Beast Code panelinde
   canlı akar; panelde yazılan da WhatsApp'a düşer */
function waBcSession(jid) {
  const s = bcGetSession(waBcWorkspace());
  if (waChats.get(jid) !== s.id) {
    waChats.set(jid, s.id);
    waRememberSession(jid, s.id);
    saveWaChats();
    if (wa) wa.setWatchJids([...waChats.keys()]);
  }
  return s;
}

function settingsLog(line) {
  try {
    fs.appendFileSync(
      path.join(APP_DIR, 'settings-recovery.log'),
      `[${new Date().toISOString()}] ${line}\n`
    );
  } catch {}
}

function parseSettingsText(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bozuk yapı');
  if (!parsed.roleModels) parsed.roleModels = {};
  return parsed;
}

/* Öncelik: canlı dosya → yedek. Bozulma olursa log'a yaz, veri kaybı yaşanmaz. */
function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const out = parseSettingsText(raw);
    try { fs.copyFileSync(SETTINGS_FILE, SETTINGS_BACKUP_FILE); } catch {}
    return out;
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      settingsLog(`settings.json okunamadı (${String((e && e.message) || e)}) — yedek deneniyor`);
      try { fs.copyFileSync(SETTINGS_FILE, SETTINGS_FILE + '.corrupt'); } catch {}
    }
  }
  try {
    const out = parseSettingsText(fs.readFileSync(SETTINGS_BACKUP_FILE, 'utf8'));
    settingsLog('settings.json yedekten kurtarıldı');
    return out;
  } catch (e2) {
    if (e2 && e2.code !== 'ENOENT') settingsLog(`yedek da bozuk: ${String((e2 && e2.message) || e2)}`);
  }
  return {};
}

/* #her makineye özgü Beast Kodu (IMEI benzeri, 15 haneli sayı).
   İlk açılışta bir kez üretilir ve settings.json'a yazılır — sonra değişmez. */
function genBeastCode() {
  const b = crypto.randomBytes(7);
  let base = '';
  for (let i = 0; i < 14; i++) base += String(b[i] % 10);
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = base.charCodeAt(13 - i) - 48;
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return base + String(check);
}

function ensureBeastCode() {
  if (settings.beastCode && /^\d{15}$/.test(String(settings.beastCode))) return;
  settings.beastCode = genBeastCode();
  try { saveSettings(); } catch {}
}

function saveSettings() {
  try {
    /* Atomik yazım: yarım kalırsa mevcut dosya asla bozulmaz */
    const tmp = SETTINGS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
    if (fs.existsSync(SETTINGS_FILE)) {
      try { fs.copyFileSync(SETTINGS_FILE, SETTINGS_BACKUP_FILE); } catch {}
    }
    fs.renameSync(tmp, SETTINGS_FILE);
    /* ilk kayıtta da yedeği mutlaka oluştur */
    try { if (!fs.existsSync(SETTINGS_BACKUP_FILE)) fs.copyFileSync(SETTINGS_FILE, SETTINGS_BACKUP_FILE); } catch {}
  } catch (e) {
    settingsLog(`saveSettings hata: ${String((e && e.message) || e)}`);
  }
}

function waLog(line) {
  try {
    console.log(`[WA] ${line}`); // Terminal: tüm WA hareketleri buraya düşer
    fs.appendFileSync(path.join(APP_DIR, 'wa.log'), `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

function watcherLog(line) {
  try {
    console.log(`[WATCH] ${line}`);
    fs.appendFileSync(path.join(APP_DIR, 'watchers.log'), `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

/* ---------- Olay Merkezi (#4) ---------- */

const WEBHOOK_TOKEN_FILE = () => path.join(APP_DIR, 'webhook-token.txt');

function webhookToken() {
  try {
    let t = fs.readFileSync(WEBHOOK_TOKEN_FILE(), 'utf8').trim();
    if (!t) throw new Error('bos');
    return t;
  } catch {
    const t = crypto.randomBytes(16).toString('hex');
    try { fs.writeFileSync(WEBHOOK_TOKEN_FILE(), t); } catch {}
    return t;
  }
}

function startEventBus() {
  const e = settings.eventBus || {};
  if (!e.enabled) {
    bus.stopAll();
    return;
  }
  bus.start(
    {
      notify: (sub, text) => {
        try {
          waLog(`olay bildirimi → sid=${sub.sessionId} (${sub.type})`);
          engine.send(sub.sessionId, { text });
        } catch {}
      },
      log: (line) => {
        console.log(line);
        try { fs.appendFileSync(path.join(APP_DIR, 'bus.log'), `[${new Date().toISOString()}] ${line}\n`); } catch {}
      },
    },
    {
      mailIdle: !!e.mailIdle,
      getCfg: () => settings.email || {},
      fsWatch: !!e.fsWatch,
      workspace: settings.workspace || app.getPath('home'),
      webhookPort: e.webhookPort || 8787,
      webhookToken: webhookToken(),
      priceSymbol: e.priceSymbol || null,
    }
  );
}

/* WA tepki/presence köprüsü: whatsapp.js emit'lerinden bus'a */
function bridgeWaToBus(ev) {
  if (ev && ev.type === 'presence' && ev.presence === 'composing') {
    try {
      bus.emitEvent('wa:presence', { status: 'yazıyor', sender: ev.participant || '' }, Date.now());
    } catch {}
  }
}


function waPrettyJid(jid) {
  const n = String(jid || '').split('@')[0].split(':')[0];
  return /^\d+$/.test(n) ? '+' + n : String(jid || '?');
}

function waEntryDigits(e) {
  return typeof e === 'string' ? e.replace(/\D/g, '') : String((e && e.num) || '').replace(/\D/g, '');
}

/* Allow listesi: [{num:'905...', name:'Quantum Algo'}, '*'] formatı. Eski string
   kayıtlar da kabul görür. Eşlenen kaydı döndürür, yoksa null. */
function waFind(senderNum) {
  const list = settings.waAllow || [];
  if (!list.length) return null; // boş liste = kimseye cevap yok
  const num = String(senderNum || '');
  for (const e of list) {
    if (e === '*') return { num: '*', name: '' };
    const d = waEntryDigits(e);
    if (!d) continue;
    if (!num || !(num === d || num.endsWith(d))) continue;
    return typeof e === 'string' ? { num: d, name: '' } : e;
  }
  return null;
}

function isWaAllowed(senderNum) {
  return !!waFind(senderNum);
}

/* ---------- TELEGRAM (FEATURE 3): allow list — WA ile aynı mantık ----------
   Liste formatı: [{ id:'123456789' | '@kullanici_adi', name, perm, bot_id }, '*']
   Eşleşme: sayısal ID birebir, @username büyük/küçük harf duyarsız. */
function tgLog(line) {
  try { log.info('telegram', line); } catch {}
}

function tgFind(senderId, username) {
  const list = settings.tgAllow || [];
  if (!list.length) return null; // boş liste = kimseye cevap yok
  const id = String(senderId || '').trim();
  const uname = String(username || '').replace(/^@/, '').toLowerCase();
  for (const e of list) {
    if (e === '*') return { id: '*', name: '' };
    const eid = typeof e === 'string' ? e.trim() : String((e && e.id) || '').trim();
    if (!eid) continue;
    if (eid === '*') return { id: '*', name: '' };
    if (eid.startsWith('@')) {
      if (uname && eid.slice(1).toLowerCase() === uname) {
        return typeof e === 'string' ? { id: eid, name: '' } : e;
      }
    } else if (id && eid === id) {
      return typeof e === 'string' ? { id: eid, name: '' } : e;
    }
  }
  return null;
}

/* Sahip: owner işaretli kayıt; yoksa listedeki ilk kişi. /allow ve /block
   yalnızca sahip tarafından kullanılabilir (yabancı DM kendi kendini ekleyemesin). */
function waOwnerNum() {
  const list = settings.waAllow || [];
  for (const e of list) {
    if (e !== '*' && typeof e === 'object' && e.owner) return waEntryDigits(e);
  }
  const first = list.find((e) => e !== '*');
  return first ? waEntryDigits(first) : '';
}

function isOwnerSender(senderNum) {
  const own = waOwnerNum();
  if (!own) return true; // liste boşsa kurulum modu
  const num = String(senderNum || '');
  return !!num && (num === own || num.endsWith(own));
}

/* ---------- WA ses: ÜCRETSİZ yerel Whisper STT + opsiyonel TTS ---------- */

let sttPipeline = null;
let sttLoading = null;

async function ensureStt() {
  if (sttPipeline) return sttPipeline;
  if (!sttLoading) {
    sttLoading = (async () => {
      waLog('STT: yerel whisper modeli hazırlanıyor (ilk kullanımda indirilir)');
      const { pipeline, env } = require('@xenova/transformers');
      const modelsDir = path.join(APP_DIR, 'models');
      fs.mkdirSync(modelsDir, { recursive: true });
      env.cacheDir = modelsDir;
      env.allowLocalModels = false;
      sttPipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', { quantized: true });
      waLog('STT hazır');
      return sttPipeline;
    })().catch((e) => {
      sttLoading = null;
      throw e;
    });
  }
  return sttLoading;
}

/* ogg/opus/mp3 → mono 16kHz Float32 PCM (ffmpeg ile) */
function decodeAudioToPcm16k(buf) {
  return new Promise((resolve, reject) => {
    try {
      const ffmpegPath = require('ffmpeg-static');
      if (!ffmpegPath) return reject(new Error('ffmpeg bulunamadı'));
      const { spawn } = require('child_process');
      const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1']);
      const chunks = [];
      let err = '';
      p.stdout.on('data', (c) => chunks.push(c));
      p.stderr.on('data', (c) => { err += c.toString(); });
      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0) return reject(new Error('ffmpeg ' + code + ': ' + err.slice(0, 200)));
        const pcm = Buffer.concat(chunks);
        const f32 = new Float32Array(Math.floor(pcm.length / 2));
        for (let i = 0; i < f32.length; i++) f32[i] = pcm.readInt16LE(i * 2) / 32768;
        resolve(f32);
      });
      p.stdin.write(buf);
      p.stdin.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function transcribeAudio(buf, langOverride /* 'tr' | 'en' | 'auto' */) {
  try {
    const audio = await decodeAudioToPcm16k(buf);
    if (!audio || !audio.length) return null;
    const asr = await ensureStt();
    /* dil: arayüz diline bağlı — UI Türkçe ise Türkçe, İngilizce ise İngilizce algılar */
    const lang = langOverride || settings.sttLang || 'tr';
    const opts = { task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 };
    if (lang === 'en') opts.language = 'english';
    else if (lang === 'tr') opts.language = 'turkish';
    const out = await asr(audio, opts);
    return String((out && out.text) || '').trim() || null;
  } catch (e) {
    waLog('stt hata: ' + String((e && e.message) || e));
    return null;
  }
}

async function synthesizeSpeech(text) {
  const cfg = settings.waTts || {};
  if (!cfg.enabled || !cfg.baseUrl || !cfg.key) return null;  try {
    const url = String(cfg.baseUrl).replace(/\/+$/, '') + '/audio/speech';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify({
        model: cfg.model || 'tts-1',
        input: String(text).slice(0, 4000),
        voice: cfg.voice || 'alloy',
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) {
      waLog(`tts http ${res.status}`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    waLog('tts hata: ' + String((e && e.message) || e));
    return null;
  }
}

const TEXT_DOC_EXT = /\.(txt|md|markdown|csv|json|log|js|mjs|ts|py|ps1|bat|cmd|html|css|xml|yaml|yml|ini|cfg)$/i;

function emitWaEventSafe(ev) {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('wa:event', ev);
  } catch {}
}



/* sürüm: app.getVersion() + package.json yedeği (splash, /help, /version ortak) */
function beastVersion() {
  try {
    const v = app.getVersion();
    if (v && v !== '0.0.0') return v;
  } catch {}
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '?';
  } catch {
    return '?';
  }
}

function waSlashHelp() {
  return [
    '*Beast komutları*',
    '• */help* – bu liste',
    '• */version* – Beast Agent sürümünü göster',
    '• */new* – yeni oturum aç (kod verilir)',
    '• */open* <kod> – o koddaki oturuma geç',
    '• */sessions* – bu sohbetin oturumları',
    '• */beastcode* [görev] – ⚡ UZAKTAN KODLAMA: masaüstünde Beast Code paneli açılır, WhatsApp\u2019tan uygulama yazdır (örn: /beastcode hava durumu uygulaması yaz)',
    '• */beastagent* – kodlama modunu kapat, masaüstünde chat ekranına dön',
    '• */plan* · */build* · */auto* – BeastCode modunda çalışma modu (planla · uygula · otomatik)',
    '• */stop* – koşan işleri durdur (ajanlar+turlar; cron/izleyici/olay sürer)',
    '• */start* – durdurulan servisleri devam ettir',
    '• */restart* – uygulamayı yeniden başlat',
    '• */change* – modelleri listele (*/change 5* ile 5.modele geç)',
    '• */notes* – bu oturumun notlarını göster',
    '• */notify* on|off – hata mail bildirimini aç/kapa',
    '• */think* <0-5> – düşünme seviyesi (0 kapalı · 1 low · 2 medium · 3 high · 4 xhigh · 5 max)',
    '• */agent* [isim] – özel ajan bağla/listele (%APPDATA%\beast\agents)',
    '• */clear* – bu oturumun geçmişini temizle',
    '• */screenshot* – masaüstü ekran görüntüsünü gönder',
    '• */rule* <metin> – kalıcı kural ekle (*/rules*: liste)',
    '• */allow* <isim> <numara> – WhatsApp allow listesine kişi ekle (örn: /allow batu 905414178456)',
    '• */block* – allow listesini numaralarıyla listele (*/block 3*: 3. kişiyi çıkar; 1 = sahip, silinemez)',
    '• */approve* – bekleyen riskli işlemi onayla (*/approve always*: bir daha sorulmasın · */deny*: reddet)',
    '• */update* – yeni sürüm kontrolü (*/update now*: indirileni hemen kur)',
    '• */model* – aktif modeli göster (*/model* <isim> ile değiştir)',
    '• */skills* – kurulu skill\u2019ler',
    '• */usage* – bugünkü kullanım',
    '• */backup* – tüm veriyi ŞİFRELİ yedekle (Beast Kodu imzalı, Masaüstü\\Beast-Backups)',
    '• */status* – bağlantı ve servis durumu',
    '',
    'Gruplarda beni @mention ile çağır; ardışık mesajlarını tek cevapta birleştiririm.',
  ].join('\n');
}

function fmtNum(n) {
  n = Number(n) || 0;
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function escapeWa(t) {
  return String(t || '').replace(/[*_`~\[\]]/g, '');
}

/* ---------- #6 tek tık yedek: %APPDATA%\beast → ŞİFRELİ .beastbak ----------
   Format: [BEASTBAK1][beastCode:15][iv:16][AES-256-CBC(zip)]
   Anahtar Beast Kodu'ndan (scrypt) türetilir; dosya adında kod görünür —
   yedeğin hangi makineye ait olduğu belli olur, başka makinede geri yüklenemez. */

const BACKUP_MAGIC = 'BEASTBAK1';

function backupKey(beastCode) {
  return crypto.scryptSync(String(beastCode), 'beast-backup-v1', 32, { N: 32768, maxmem: 128 * 1024 * 1024 });
}

async function createBackup() {
  try {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const outDir = path.join(app.getPath('desktop'), 'Beast-Backups');
    fs.mkdirSync(outDir, { recursive: true });
    const code = String(settings.beastCode || '');
    const zipPath = path.join(outDir, `beast-${stamp}.zip`);
    /* zip yoksa PowerShell Compress-Archive ile */
    await new Promise((resolve, reject) => {
      const { execFile } = require('child_process');
      execFile(
        'powershell.exe',
        [
          '-NoProfile', '-Command',
          `Compress-Archive -Path '${APP_DIR}\\*' -DestinationPath '${zipPath}' -Force`,
        ],
        { timeout: 180000, windowsHide: true },
        (err) => (err ? reject(err) : resolve())
      );
    });
    /* zip → AES-256-CBC ile şifrele, Beast Kodu'nu başlığa yaz */
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', backupKey(code), iv);
    const enc = Buffer.concat([cipher.update(fs.readFileSync(zipPath)), cipher.final()]);
    fs.unlinkSync(zipPath);
    const outPath = path.join(outDir, `beast-yedek-${code}-${stamp}.beastbak`);
    const header = Buffer.concat([
      Buffer.from(BACKUP_MAGIC, 'utf8'),
      Buffer.from(code.padEnd(15, '0'), 'utf8'),
      iv,
    ]);
    fs.writeFileSync(outPath, Buffer.concat([header, enc]));
    const size = fs.statSync(outPath).size;
    waLog(`şifreli yedek alındı: ${outPath} (${Math.round(size / 1024)} KB) — Beast Kodu ${code}`);
    return { ok: true, path: outPath, size, code };
  } catch (e) {
    waLog('yedek hata: ' + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* Şifreli yedeği geri yükle: Beast Kodu bu makineye aitse çöz → aç → APP_DIR'e kopyala */
async function restoreBackup() {
  try {
    const r = await dialog.showOpenDialog(win, {
      title: 'Beast Yedeğini Geri Yükle',
      filters: [{ name: 'Beast Yedek', extensions: ['beastbak'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    const file = r.filePaths[0];
    const raw = fs.readFileSync(file);
    if (raw.length < 40 || raw.subarray(0, 9).toString('utf8') !== BACKUP_MAGIC) {
      return { ok: false, error: 'bu dosya geçerli bir Beast yedeği değil' };
    }
    const code = raw.subarray(9, 24).toString('utf8').replace(/0+$/, '').trim();
    const iv = raw.subarray(24, 40);
    const data = raw.subarray(40);
    if (!code || code !== String(settings.beastCode || '')) {
      waLog(`geri yükleme reddedildi: yedek ${code || '?'} kodlu Beast'e ait, bu makine ${settings.beastCode}`);
      return {
        ok: false,
        foreign: true,
        code: code || '?',
        error: `bu yedek başka bir Beast'e ait (${code || '?'}) — bu makinenin kodu: ${settings.beastCode}`,
      };
    }
    let zip;
    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', backupKey(code), iv);
      zip = Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
      return { ok: false, error: 'yedek çözülemedi — dosya bozuk olabilir' };
    }
    const tmp = path.join(app.getPath('temp'), `beast-restore-${Date.now()}`);
    const tmpZip = tmp + '.zip';
    fs.writeFileSync(tmpZip, zip);
    fs.mkdirSync(tmp, { recursive: true });
    await new Promise((resolve, reject) => {
      const { execFile } = require('child_process');
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', `Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmp}' -Force`],
        { timeout: 180000, windowsHide: true },
        (err) => (err ? reject(err) : resolve())
      );
    });
    /* açılan içeriği %APPDATA%\beast üzerine kopyala */
    const copyAll = (src, dest) => {
      fs.mkdirSync(dest, { recursive: true });
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name);
        const d = path.join(dest, e.name);
        if (e.isDirectory()) copyAll(s, d);
        else fs.copyFileSync(s, d);
      }
    };
    copyAll(tmp, APP_DIR);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(tmpZip); } catch {}
    waLog(`yedek geri yüklendi: ${file} — yeniden başlatma önerilir`);
    return { ok: true, restart: true };
  } catch (e) {
    waLog('geri yükleme hata: ' + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- global DURDUR (#16): /stop her şeyi keser ---------- */

let servicesPaused = false;

function stopEverything() {
  let n = 0;
  try { n = engine.stopAll(); } catch {}
  /* bekleyen masaüstü/WA birleştirme kuyrukları temizlenir */
  try { for (const [, q] of desktopQueue) clearTimeout(q.timer); } catch {}
  desktopQueue.clear();
  try { for (const [, q] of waQueue) clearTimeout(q.timer); } catch {}
  waQueue.clear();
  /* cron, izleyici ve olay merkezi ÇALIŞMAYA DEVAM EDER — /stop yalnızca
     koşan ajan/turları keser; servisleri durdurmak isteyen app'i kapatır. */
  return n;
}

function resumeServices() {
  if (!servicesPaused) {
    /* /stop kapısı burada da kalkar — /start VE kullanıcının kendi mesajı canlandırır */
    try { engine.clearStop(); } catch {}
    return;
  }
  try { cron.init({ onFire: cronFire }); } catch {}
  try { watchers.start({ onTrigger: watcherFire }); } catch {}
  try { startEventBus(); } catch {}
  try { engine.clearStop(); } catch {}
  servicesPaused = false;
}

/* ---------- #Güvenlik: riskli araç onay kapısı (varsayılan KAPALI — her şey serbest) ----------
   Ayarlar → Güvenlik'ten açılır. Açıksa run_command / write_file / python_run /
   email_send / watcher_add çalışmadan önce onay bekler (UI kartı + WA mesajı).
   Onay: /approve · bir daha sorulmasın: /approve always · Reddet: /deny */
const pendingApprovals = new Map(); // id -> { resolve, sessionId, tool, args, timer }
const approvalsBridge = { request: (r) => requestApproval(r) };

function approvalArgsSummary(args) {
  try {
    const s = JSON.stringify(args || {});
    return s.length > 260 ? s.slice(0, 260) + '…' : s;
  } catch {
    return '{}';
  }
}

function requestApproval({ sessionId, tool, args }) {
  return new Promise((resolve) => {
    try {
      const id = 'ap' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const entry = { sessionId, tool, args, resolve, timer: null };
      pendingApprovals.set(id, entry);
      /* 3 dk içinde onay gelmezse otomatik reddet */
      entry.timer = setTimeout(() => {
        if (pendingApprovals.delete(id)) {
          resolve(false);
          log.info('sec', `onay zaman aşımı: ${tool}`);
        }
      }, 180000);
      if (win && !win.isDestroyed()) {
        win.webContents.send('agent:event', {
          sessionId: String(sessionId || ''),
          type: 'approval',
          requestId: id,
          tool,
          argsPreview: approvalArgsSummary(args),
        });
      }
      const own = waOwnerNum();
      if (wa && own) {
        sendWaSafe(
          own + '@s.whatsapp.net',
          `\u26A0\uFE0F *Onay bekleniyor* — \`${tool}\`\n${approvalArgsSummary(args).slice(0, 180)}\n\nOnayla: \`/approve\`\nBu araç için bir daha sorma: \`/approve always\`\nReddet: \`/deny\``
        ).catch(() => {});
      }
      log.info('sec', `onay istendi: ${tool} (${id})`);
    } catch {
      resolve(false);
    }
  });
}

function resolveApproval(id, ok, always) {
  const key = String(id || '');
  const entry = pendingApprovals.get(key);
  if (!entry) return { ok: false, error: 'bekleyen onay yok' };
  pendingApprovals.delete(key);
  clearTimeout(entry.timer);
  if (ok && always) {
    const sec = settings.security || (settings.security = { approvals: false, alwaysAllow: [] });
    if (!Array.isArray(sec.alwaysAllow)) sec.alwaysAllow = [];
    if (!sec.alwaysAllow.includes(entry.tool)) sec.alwaysAllow.push(entry.tool);
    saveSettings();
    if (engine) engine.alwaysAllowTools = new Set(sec.alwaysAllow);
  }
  entry.resolve(!!ok);
  log.info('sec', `onay ${ok ? 'VERİLDİ' : 'reddedildi'}: ${entry.tool}${always ? ' (always)' : ''}`);
  return { ok: true, tool: entry.tool };
}

function resolveFirstApproval(ok, always) {
  const first = pendingApprovals.keys().next();
  if (first.done) return { ok: false, error: 'bekleyen onay yok' };
  return resolveApproval(first.value, ok, always);
}

/* true dönerse mesaj slash komutuydu ve cevap gönderildi */
async function tryWaSlash(jid, rawText, senderNum, payload0) {
  const t = String(rawText || '').trim();
  if (!t.startsWith('/') || t.includes('\n')) return false;
  const parts = t.slice(1).split(/\s+/);
  const cmd = String(parts[0] || '').toLowerCase();
  const arg = parts.slice(1).join(' ').trim();
  let out = '';
  try {
    if (cmd === 'help') {
      out = waSlashHelp();
    } else if (cmd === 'new') {
      const v = engine.createSession();
      waChats.set(jid, v.id);
      waRememberSession(jid, v.id);
      saveWaChats();
      wa.setWatchJids([...waChats.keys()]);
      out = `*Yeni oturum* \`${v.code}\` açıldı — anlatabilirsin.\nDiğer oturumlara geçiş: \`/open <kod>\``;
    } else if (cmd === 'open') {
      if (!arg) {
        out = 'Kullanım: `/open <kod>` — kodları görmek için /sessions';
      } else {
        const hit = engine.findByCode(arg);
        if (!hit) {
          out = `\`${arg.toUpperCase()}\` kodlu oturum bulunamadı. Listeyi görmek için /sessions`;
        } else {
          waChats.set(jid, hit.id);
          waRememberSession(jid, hit.id);
          saveWaChats();
          wa.setWatchJids([...waChats.keys()]);
          out = `*Geçildi:* \`${hit.code}\` — ${escapeWa(hit.title)}`;
        }
      }
    } else if (cmd === 'sessions') {
      const h = [...new Set([...(waHistory.get(jid) || []), ...(waChats.has(jid) ? [waChats.get(jid)] : [])])];
      const activeSid = waChats.get(jid);
      const rows = [];
      for (const sid of h.slice(-8).reverse()) {
        try {
          const s = engine.openSession(sid);
          rows.push(`${s.id === activeSid ? '\u2726' : '-'} \`${s.code || '?'}\` ${escapeWa(s.title).slice(0, 40)}${s.id === activeSid ? ' *(aktif)*' : ''}`);
        } catch {}
      }
      out = rows.length
        ? '*Bu sohbetin oturumları*\n' + rows.join('\n') + '\n\nGeçmek: `/open <kod>` · Yeni: /new'
        : 'Kayıtlı oturum yok.';
    } else if (cmd === 'rule') {
      if (!arg) {
        out = 'Kullanım:\n`/rule <kural metni>` — genel kural\n`/rule <skill-adı> <madde>` — o skill\u2019e madde';
      } else {
        const m = arg.match(/^([\w.-]+)\s+(.+)$/);
        const skTry = m ? skillsMod.appendRuleToSkill(m[1], m[2]) : { ok: false };
        if (skTry.ok) {
          out = `*Skill güncellendi:* ${skTry.skill}\n- ${m[2].slice(0, 120)}`;
        } else {
          const r = memory.addRule(arg);
          out = r.ok
            ? (r.duplicate ? 'Bu kural zaten kayıtlı.' : '*Kural kalıcıya eklendi* 🧷\n' + arg.slice(0, 150))
            : 'Hata: ' + (r.error || '?');
        }
      }
    } else if (cmd === 'rules') {
      const rules = memory.listRules();
      out = rules.length
        ? '*Kalıcı kurallar*\n' + rules.map((r, i) => `${i + 1}. ${escapeWa(r)}`).join('\n')
        : 'Henüz kural yok. Eklemek için: `/rule <metin>`';
    } else if (cmd === 'allow') {
      /* /allow <isim> <numara> — yalnız sahip ekleyebilir */
      if (!isOwnerSender(senderNum)) {
        out = 'Bu komutu yalnız *sahip* kullanabilir.';
      } else {
        const m = String(arg || '').trim().match(/^(.+?)\s+([\d+\s()-]{7,})$/);
        if (!m) {
          out = 'Kullanım: `/allow <isim> <numara>`\nÖrnek: `/allow batu 905414178456`';
        } else {
          const name = m[1].trim().slice(0, 40);
          const num = m[2].replace(/\D/g, '');
          if (num.length < 7) {
            out = 'Numara çok kısa/geçersiz — örnek: `/allow batu 905414178456`';
          } else {
            const list = settings.waAllow || [];
            if (list.some((e) => waEntryDigits(e) === num)) {
              out = `*+${num}* zaten allow listesinde.`;
            } else {
              settings.waAllow = [...list, { num, name, perm: 'all' }];
              saveSettings();
              emitWaEventSafe({ type: 'allow' });
              waLog(`slash /allow: +${num} (${name}) eklendi`);
              out = `*Allow\u2019a eklendi:* ${name} (+${num})\nListe: \`/block\``;
            }
          }
        }
      }
    } else if (cmd === 'block') {
      /* arg yok: listele · /block <no>: o kişiyi allowdan çıkar (1 = sahip, silinemez) */
      if (!isOwnerSender(senderNum)) {
        out = 'Bu komutu yalnız *sahip* kullanabilir.';
      } else {
        const list = settings.waAllow || [];
        const rows = list.filter((e) => e !== '*');
        if (!arg) {
          out = rows.length
            ? '*Allow listesi*\n' +
              rows
                .map((e, i) => {
                  const nm = typeof e === 'string' ? '' : String(e.name || '');
                  const own = typeof e === 'object' && !!e.owner;
                  return `${i + 1}. ${nm ? escapeWa(nm) + ' ' : ''}+${waEntryDigits(e)}${own ? ' 👑 *sahip*' : ''}`;
                })
                .join('\n') +
              '\n\nÇıkarmak için: `/block <no>` — *1. kişi sahip, asla silinemez*'
            : 'Allow listesi boş. Eklemek için: `/allow <isim> <numara>`';
        } else {
          const n = parseInt(String(arg).trim(), 10);
          if (!Number.isFinite(n) || n < 1 || n > rows.length) {
            out = `Kullanım: \`/block <no>\` (1-${rows.length}) — listeyi görmek için /block`;
          } else if (n === 1 || (typeof rows[n - 1] === 'object' && rows[n - 1].owner)) {
            out = '*Sahip allowdan çıkarılamaz.* 😤';
          } else {
            const victim = rows[n - 1];
            settings.waAllow = list.filter((e) => e !== victim);
            saveSettings();
            emitWaEventSafe({ type: 'allow' });
            const vName = typeof victim === 'string' ? '' : String(victim.name || '');
            waLog(`slash /block: +${waEntryDigits(victim)} (${vName}) çıkarıldı`);
            out = `*Allowdan çıkarıldı:* ${vName ? vName + ' ' : ''}+${waEntryDigits(victim)}`;
          }
        }
      }
    } else if (cmd === 'approve' || cmd === 'deny') {
      /* onay kapısı: /approve · /approve always · /deny */
      const a = String(arg || '').toLowerCase();
      const always = cmd === 'approve' && a === 'always';
      const r = resolveFirstApproval(cmd === 'approve', always);
      out = r.ok
        ? `*${cmd === 'deny' ? 'Reddedildi' : 'Onaylandı'}:* ${r.tool}${always ? ' — bu araç için bir daha sorulmayacak' : ''}`
        : 'Bekleyen onay yok.';
    } else if (cmd === 'update') {
      /* /update — sürüm kontrol; /update now — görünür cmd'de beast update */
      if (String(arg || '').toLowerCase() === 'now') {
        updateReplies.jids.add(jid);
        npmUpdateNow(async (text) => { out = text; });
      } else {
        updateReplies.jids.add(jid);
        await runUpdateCommand(async (text) => { out = text; });
      }
    } else if (cmd === 'think') {
      const r = arg ? applyThinkLevel(arg) : null;
      out = r && r.error ? r.error : r ? r.text : thinkStatusText();
    } else if (cmd === 'stop') {
      /* /stop: koşan paralel ajanlar + turlar + kuyruklar; cron/izleyici/olay SÜRER */
      const stopped = stopEverything();
      out =
        `*Durdu* — ${stopped} koşan iş kesildi.\n` +
        `Sürüyen sorgular, akıştaki cevaplar ve ajan faaliyetleri ANINDA kesildi; ajan yeni sorgu da açamaz.\n` +
        `Devam için bir şeyler yaz ya da /start`;
    } else if (cmd === 'start') {
      if (servicesPaused) {
        resumeServices();
        out = '*Devam* — tüm servisler ve zamanlayıcılar yeniden başladı.';
      } else {
        out = 'Zaten çalışıyor — durdurulmuş bir şey yok.';
      }
    } else if (cmd === 'restart') {
      out = '*\u21BB Yeniden başlatılıyor…* Uygulama birkaç saniye içinde kapanıp açılacak.';
      setTimeout(() => {
        try { app.relaunch(); } catch {}
        try { app.exit(0); } catch {}
      }, 1500);
    } else if (cmd === 'change') {
      out = modelChangeText(arg);
    } else if (cmd === 'notes') {
      const sid = waChats.get(jid);
      out = sid ? notesText(sid) : 'Bu sohbetin oturumu yok — önce bir şeyler yaz.';
    } else if (cmd === 'notify') {
      const a = String(arg || '').toLowerCase();
      if (a === 'on' || a === 'off') {
        settings.notifyOwnerFail = a === 'on';
        saveSettings();
        engine.notifyOwnerFail = settings.notifyOwnerFail;
      }
      out = `Hata mail bildirimi: ${settings.notifyOwnerFail !== false ? 'AÇIK' : 'KAPALI'} (değiştirmek için /notify on|off)`;
    } else if (cmd === 'clear') {
      const sid = waChats.get(jid);
      if (sid && engine.clearMessages(sid)) {
        out = '*Bu oturumun geçmişi temizlendi.* Aynı kodla sıfırdan devam edebilirsin.';
      } else {
        out = 'Temizlenecek oturum bulunamadı.';
      }
    } else if (cmd === 'screenshot') {
      const img = await captureScreenDataUrl();
      if (!img) {
        out = 'Ekran görüntüsü alınamadı.';
      } else {
        const buf = Buffer.from(String(img).split(',')[1] || '', 'base64');
        const sent = await wa.sendImage(jid, buf, 'Masaüstü ekran görüntüsü');
        out = sent ? '' : 'Görsel gönderilemedi.';
      }
    } else if (cmd === 'backup') {
      const r = await createBackup();
      out = r.ok
        ? `*Şifreli yedek alındı*\n${r.path}\n(${Math.round(r.size / 1024)} KB)\nBeast Kodu: \`${r.code}\``
        : 'Yedek hata: ' + (r.error || '?');
    } else if (cmd === 'model') {
      const st = engine.publicState();
      if (arg) {
        const hit = st.models.find((m) => m.sel === arg || m.model.toLowerCase().includes(arg.toLowerCase()));
        if (hit) {
          settings.modelOverride = hit.sel;
          saveSettings();
          engine.setModelOverride ? engine.setModelOverride(hit.sel) : null;
          const st2 = engine.publicState();
          out = st2.activeModel
            ? `*Model değişti:* ${st2.activeModel.providerName} · ${st2.activeModel.model}`
            : '*Model değişti.*';
        } else {
          out =
            'Eşleşen model yok. *Kurulu modeller:*\n' +
            st.models.slice(0, 10).map((m) => `- ${m.providerName} · ${m.model}`).join('\n');
        }
      } else if (st.activeModel) {
        out = `*Aktif model:* ${st.activeModel.providerName} · ${st.activeModel.model}\nDeğiştirmek için: /model <isim-parçası>`;
      } else {
        out = 'Model seçilmemiş.';
      }
    } else if (cmd === 'skills') {
      const sk = skillsMod.scan();
      out = sk.length
        ? '*Skill\u2019ler:*\n' + sk.map((s) => '- ' + s.name).join('\n')
        : 'Henüz skill yok — SKILL.md dosyası atarsan kurarım.';
    } else if (cmd === 'usage') {
      const rep = usageMod.report();
      const f = (r) =>
        `${r.calls} çağrı · ${fmtNum(r.pin)}+${fmtNum(r.pout)} token${r.cost ? ' · ~$' + r.cost.toFixed(4) : ''}`;
      out = `*Bugün:* ${f(rep.today.total)}\n*Bu ay:* ${f(rep.month.total)}\n\nDetay: Ayarlar → Maliyet`;
    } else if (cmd === 'status') {
      const wst = wa ? wa.snapshot() : { status: 'disconnected' };
      const jobs = cron.list().filter((j) => j.enabled).length;
      out =
        `*WA:* ${wst.status}${wst.user ? ' (' + wst.user + ')' : ''}\n` +
        `*İzleyici:* ${watchers.list().length} adet\n*Cron:* ${jobs} aktif görev`;
    } else if (cmd === 'beastcode') {
      /* /beastcode [görev] — WhatsApp'tan UZAKTAN KODLAMA modu:
         masaüstünde GERÇEK Beast Code paneli açılır (IDE ekranı), sohbet
         panel oturumuyla birleşir; yazılanlar panelde canlı akar */
      const s = waBcSession(jid);
      waBcMode.add(jid);
      saveWaChats();
      emitWaEventSafe({ type: 'bc-screen', on: true, sessionId: s.id, workspace: s.workspace || waBcWorkspace() });
      if (arg) {
        /* görev normal WA akışına verilir — meşgulse bekleme-kuyruğu devrede */
        waQueuePush(jid, { text: arg, isGroup: !!(payload0 && payload0.isGroup) }, senderNum);
        out =
          `*⚡ BEASTCODE MODU AÇILDI — görev alındı, yazıyorum.*\n` +
          `Bilgisayarda Beast Code paneli açıldı: \`${s.workspace || waBcWorkspace()}\`\n` +
          `Mod değiştir: \`/plan\` (sadece plan) · \`/build\` (uygula) · \`/auto\`\n` +
          `Sohbete dönmek için: /beastagent`;
      } else {
        out =
          `*⚡ BEASTCODE MODU AÇILDI*\n` +
          `Bilgisayarda Beast Code paneli açıldı — çalışma klasörü: \`${s.workspace || waBcWorkspace()}\`\n` +
          `Ne yazarsan UYGULAMA olarak yaparım: dosyalar yazar, komut çalıştırır, doğrular.\n` +
          `İlk görevi yaz — örn: "todo listesi uygulaması yaz"\n` +
          `Sohbete dönmek için: /beastagent`;
      }
    } else if (cmd === 'beastagent') {
      /* /beastagent — kodlama modundan normal sohbete dön; masaüstünde
         Beast Code paneli kapanır, chat ekranı geri gelir */
      if (!waBcMode.has(jid)) {
        out = 'Zaten sohbet modundasın — kodlamak için /beastcode yaz.';
      } else {
        const sid = waChats.get(jid);
        if (sid && engine.isBusy(sid)) {
          try { engine.interrupt(sid, 'kullanıcı /beastagent ile sohbet moduna döndü'); } catch {}
        }
        waBcMode.delete(jid);
        const v = engine.createSession();
        waChats.set(jid, v.id);
        waRememberSession(jid, v.id);
        saveWaChats();
        if (wa) wa.setWatchJids([...waChats.keys()]);
        emitWaEventSafe({ type: 'bc-screen', on: false });
        out =
          `*💬 Sohbet moduna dönüldü* — masaüstünde chat ekranı açıldı, yeni oturum \`${v.code}\`.\n` +
          `Kodlar duruyor: \`${waBcWorkspace()}\`\n` +
          `Tekrar kodlamak için: /beastcode`;
      }
    } else if (waBcMode.has(jid) && (cmd === 'plan' || cmd === 'build' || cmd === 'auto')) {
      /* BeastCode modunda çalışma modu: /plan · /build · /auto */
      const sid = waChats.get(jid);
      const s = sid ? engine.cache.get(sid) : null;
      if (s && s.bcCode) {
        s.bcMode = cmd;
        engine.cache.set(sid, s);
        out = cmd === 'plan'
          ? '*🔍 PLAN MODU* — dosyaları inceler, kod YAZMAZ; adım adım uygulama planı verir.'
          : cmd === 'build'
            ? '*🛠 BUILD MODU* — son planı uygular: dosyalar, komutlar, doğrulama.'
            : '*⚡ AUTO MOD* — kısa plan + uygulama + doğrulama.';
      } else {
        out = 'Bu komut yalnız BeastCode modunda çalışır — önce /beastcode yaz.';
      }
    } else if (cmd === 'version') {
      out = `*Beast Agent v${beastVersion()}*\nGüncelleme için: /update (kurulum hazır olunca /update now)`;
    } else {
      out = `Bilinmeyen komut: /${cmd}\nListe için /help yaz.`;
    }
  } catch (e) {
    out = 'Komut hatası: ' + String((e && e.message) || e);
  }
  if (out) await sendWaSafe(jid, out).catch(() => {});
  return true;
}

/* ---------- WA anti-spam birleştirme ----------
   Aynı sohbetten gelen ardışık mesajları WA_DEBOUNCE_MS boyunca toplar,
   tek pakette işler. Medya varsa ilk medya esastır; metinler birleşir. */

const WA_DEBOUNCE_MS = 4500;
const waQueue = new Map(); // jid -> { timer, payloads[] }

function waQueuePush(jid, payload, senderNum) {
  let q = waQueue.get(jid);
  if (!q) {
    q = { texts: [], payloads: [] };
    waQueue.set(jid, q);
  }
  q.payloads.push({ payload, senderNum });
  clearTimeout(q.timer);
  waLog(`queue: mesaj kuyruğa girdi jid=${waPrettyJid(jid)} toplam=${q.payloads.length} (4.5 sn birleştirme penceresi)`);
  q.timer = setTimeout(() => {
    waLog(`queue: birleştirme penceresi kapandı, flush başlıyor jid=${waPrettyJid(jid)}`);
    /* KUYRUĞU BURADA SİLME — waFlush içindeki veriyi alıp kendisi siliyor */
    waFlush(jid).catch((e) => {
      waLog(`flush KRASİ: ${String((e && e.stack) || e)}`);
    });
  }, WA_DEBOUNCE_MS);
}

async function waFlush(jid) {
  const q = waQueue.get(jid);
  waLog(`flush: çağrıldı jid=${waPrettyJid(jid)} kuyrukta=${q ? q.payloads.length : 0}`);
  if (!q) return;
  waQueue.delete(jid);
  const merged = { text: '', media: null, isGroup: false, participant: '', participantPn: '', participantUsername: '', mentioned: false };
  let senderNum = '';
  /* push tarafıyla AYNI alan adı: { payload, senderNum }.
     Gruplarda farklı kişilerden gelen mesajlar birleşirse, ilk kişi label'da
     adı geçer; DİĞER kişilerin mesajları metne [kim] etiketiyle eklenir. */
  let firstParticipant = '';
  for (const { payload, senderNum: sn } of q.payloads) {
    if (payload.text) {
      let txt = payload.text;
      if (payload.isGroup && payload.participant) {
        const pid = String(payload.participant);
        if (!firstParticipant) firstParticipant = pid;
        else if (pid !== firstParticipant) {
          const tagD = String(payload.participantPn || '').split('@')[0].split(':')[0] || pid.split('@')[0].split(':')[0];
          txt = `[+${tagD}]: ${txt}`;
        }
      }
      merged.text += (merged.text ? '\n' : '') + txt;
    }
    if (payload.media && !merged.media) merged.media = payload.media;
    if (payload.isGroup) merged.isGroup = true;
    /* ilk gönderen esas alınır — sonrakiler metne [kim] etiketiyle gelir */
    if (payload.participant && !merged.participant) merged.participant = payload.participant;
    if (payload.participantPn && !merged.participantPn) merged.participantPn = payload.participantPn;
    if (payload.participantUsername && !merged.participantUsername) merged.participantUsername = payload.participantUsername;
    if (payload.mentioned) merged.mentioned = true;
    if (!senderNum && sn) senderNum = sn;
  }
  try {
    await processWaMessage(jid, merged, senderNum);
  } catch (e) {
    waLog(`waFlush/processWaMessage hata: ${String((e && e.stack) || e)}`);
  }
}

/* Grup göndereninin kimlik etiketi + SAHİP olup olmadığı.
   Sıra: izin listesindeki isim → @kullanıcı adı → gerçek PN → LID base.
   hitP.owner → bu kişi izin listesinde SAHİP olarak işaretli. */
function waGroupSenderInfo(payload) {
  const pnDigits = String(payload.participantPn || '').split('@')[0].split(':')[0];
  const hitP = /^\d+$/.test(pnDigits) ? waFind(pnDigits) : null;
  const uname = String(payload.participantUsername || '').trim();
  let label;
  if (hitP && hitP.name) label = `${hitP.name} (+${pnDigits})`;
  else if (uname) label = `@${uname}${/^\d+$/.test(pnDigits) ? ' (+' + pnDigits + ')' : ''}`;
  else if (/^\d+$/.test(pnDigits)) label = '+' + pnDigits;
  else label = payload.participant ? '+' + String(payload.participant).split('@')[0].split(':')[0] : '';
  return { label, name: (hitP && hitP.name) || '', isOwner: !!(hitP && hitP.owner) };
}

/* Oturum yoksa oluştur (processWaMessage ile aynı kalıp) */
function ensureWaSession(jid) {
  let sid = waChats.get(jid);
  if (!sid) {
    const v = engine.createSession();
    sid = v.id;
    waChats.set(jid, sid);
    saveWaChats();
    if (wa) wa.setWatchJids([...waChats.keys()]);
  } else {
    waRememberSession(jid, sid);
  }
  return sid;
}

/* ---------- GRUP BAĞLAM AKIŞI (mentionOnly + seeAll) ----------
   Bot grubun tüm konuşmasını okur ama CEVAP ÜRETMEZ; mesajlar sessizce
   oturum geçmişine bağlam olarak düşer. @mention gelince bot tüm bu
   bağlamı görerek konuşur. Anti-spam: aynı birleştirme penceresi. */
const waCtxQueue = new Map(); // jid -> { timer, payloads[] }

function waGroupObserve(jid, payload, senderNum) {
  let q = waCtxQueue.get(jid);
  if (!q) {
    q = { payloads: [] };
    waCtxQueue.set(jid, q);
  }
  q.payloads.push({ payload, senderNum });
  clearTimeout(q.timer);
  waLog(`grup bağlam: kuyruğa girdi jid=${waPrettyJid(jid)} toplam=${q.payloads.length}`);
  q.timer = setTimeout(() => {
    waCtxFlush(jid).catch((e) => waLog(`ctx flush KRASİ: ${String((e && e.stack) || e)}`));
  }, WA_DEBOUNCE_MS);
}

async function waCtxFlush(jid) {
  const q = waCtxQueue.get(jid);
  if (!q) return;
  waCtxQueue.delete(jid);
  const sid = ensureWaSession(jid);
  /* her satır gönderen etiketli olur — ajan kimin ne yazdığını izleyebilsin */
  const lines = [];
  for (const { payload } of q.payloads) {
    if (!payload || !payload.text) continue;
    const gi = waGroupSenderInfo(payload);
    const who = gi.label || '?';
    lines.push(`${who}: ${String(payload.text).slice(0, 1500)}`);
  }
  if (!lines.length) return;
  const text = `${OBSERVE_MARK} — WhatsApp grup konuşması (cevap verme, sadece bilgi olarak sakla)]\n` + lines.join('\n').slice(0, 6000);
  engine.observe(sid, text);
  waLog(`grup bağlam: oturuma işlendi sid=${sid} satır=${lines.length}`);
}

/* ---------- WA'dan skill kurulumu ----------
   SKILL.md (veya *.skill.md) belgesi atılırsa skills altına kurulur. */

function installSkillFromDoc(media) {
  const name = String(media.name || '').trim();
  const isSkill = /^SKILL\.md$/i.test(name) || /\.skill\.md$/i.test(name);
  if (!isSkill) return null;
  try {
    const fm = skillsMod.parseFrontmatter(media.buf.toString('utf8'));
    const fname = String(fm.name || '').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') ||
      name.replace(/\.skill\.md$/i, '').replace(/[^a-z0-9_-]+/gi, '-') ||
      'yeni-skill';
    const dir = path.join(skillsMod.dir(), fname.toLowerCase());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), media.buf.toString('utf8'));
    return { folder: fname.toLowerCase() };
  } catch (e) {
    waLog('skill kurulum hata: ' + String((e && e.message) || e));
    return { error: true };
  }
}


/* ---------- E-posta köprüsü (IMAP/SMTP, Gmail uygulama şifresi) ---------- */

function emailCfg() {
  return settings.email || {};
}

async function emailList(opts = {}) {
  const cfg = emailCfg();
  if (!cfg.host || !cfg.user || !cfg.pass) return { ok: false, error: 'e-posta ayarlanmamış — Entegrasyonlar\u0027da gir' };
  if (!ImapFlow) return { ok: false, error: 'imap modülü yok' };
  const limit = Math.max(1, Math.min(Number(opts.limit) || 10, 30));
  const client = new ImapFlow({
    host: cfg.host,
    port: Number(cfg.port) || 993,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(opts.folder || 'INBOX');
    try {
      /* uid:true OPTIONS'ta (2. argüman değil) — UID SEARCH gerçek UID'leri döndürür */
      let uids = opts.unread
        ? await client.search({ seen: false }, { uid: true })
        : await client.search({ all: true }, { uid: true });
      uids = Array.isArray(uids) ? uids.slice(-limit) : [];
      if (!uids.length) return { ok: true, messages: [] };
      const messages = [];
      /* fetch'te de uid opsiyonu 3. argümanda — UID FETCH */
      for await (const m of client.fetch(uids.map(String).join(','), { envelope: true }, { uid: true })) {
        const from = (m.envelope.from || [])
          .map((a) => (a.name ? `${a.name} <${a.address}>` : a.address))
          .join(', ');
        messages.push({ uid: m.uid, from, subject: m.envelope.subject || '(konu yok)', date: m.envelope.date });
      }
      return { ok: true, messages: messages.reverse() };
    } finally {
      lock.release();
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    try { await client.logout(); } catch {}
  }
}

async function emailRead(uid) {
  const cfg = emailCfg();
  if (!cfg.host || !cfg.user || !cfg.pass) return { ok: false, error: 'e-posta ayarlanmamış' };
  if (!ImapFlow) return { ok: false, error: 'imap modülü yok' };
  /* engine aracı args OBJESİ geçirir ({ uid: 12 }), düz değer çağıranlar da var — ikisini de kabul et.
     (Bug: obje Number()'a çevrilince NaN → "Invalid sequence set value") */
  const u0 = uid && typeof uid === 'object' ? uid.uid : uid;
  const u = Math.floor(Number(u0));
  if (!Number.isSafeInteger(u) || u <= 0) return { ok: false, error: 'geçersiz uid: ' + JSON.stringify(u0) };
  const client = new ImapFlow({
    host: cfg.host,
    port: Number(cfg.port) || 993,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      /* uid opsiyonu 3. argümanda — 'UID FETCH <u>' (yoksa seq number fetch edilir, yanlış mail gelir) */
      for await (const m of client.fetch(String(u), { source: true }, { uid: true })) {
        const raw = m.source.toString('utf8');
        const bodyPart = raw.split(/\r?\n\r?\n/).slice(1).join('\n\n') || raw;
        const text = htmlToText(bodyPart);
        return { ok: true, uid: u, content: String(text || '').slice(0, 8000) };
      }
      return { ok: false, error: 'mail bulunamadı' };
    } finally {
      lock.release();
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    try { await client.logout(); } catch {}
  }
}

async function emailSend({ to, subject, body }) {
  const cfg = emailCfg();
  if (!cfg.smtpHost || !cfg.user || !cfg.pass) return { ok: false, error: 'gönderim ayarlanmamış (SMTP)' };
  if (!nodemailer) return { ok: false, error: 'mail modülü yok' };
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to))) return { ok: false, error: 'geçersiz alıcı' };
  try {
    const port = Number(cfg.smtpPort) || 465;
    const tr = nodemailer.createTransport({
      host: cfg.smtpHost,
      port,
      /* 465 = implicit TLS, 587 = STARTTLS (nodemailer otomatik yükseltir) */
      secure: port === 465,
      auth: { user: cfg.user, pass: cfg.pass },
    });
    await tr.sendMail({ from: cfg.user, to: String(to), subject: String(subject || '(konusuz)'), text: String(body || '') });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

const PDF_EXT = /\.pdf$/i;

function documentToText(media) {
  try {
    const mime = String(media.mimetype || '');
    const name = String(media.name || '');
    if (mime.startsWith('text/') || TEXT_DOC_EXT.test(name)) {
      return media.buf.toString('utf8');
    }
  } catch {}
  return null; // pdf gibi asenkron türler documentToTextAsync'e düşer
}

async function documentToTextAsync(media) {
  const dt = documentToText(media);
  if (dt) return dt;
  try {
    const mime = String(media.mimetype || '');
    const name = String(media.name || '');
    if (mime === 'application/pdf' || PDF_EXT.test(name)) {
      const r = await require('./agent/pdf').extract(media.buf);
      return String((r && r.text) || '');
    }
  } catch (e) {
    waLog('pdf okuma hata: ' + String((e && e.message) || e));
  }
  return null;
}

/* ---------- WA hatırlatıcı ---------- */

function scheduleReminder({ when, message, sessionId, repeat }) {
  try {
    const msg = String(message || '').trim();
    if (!msg) return { ok: false, error: 'hatırlatma metni boş' };
    const rep = String(repeat || '').trim();
    if (rep) {
      /* tekrarlı görev: cron.json'da kalıcı job (once değil) */
      const s = cron.reminderSchedule(when, rep);
      if (!s.ok) return s;
      const r = cron.add({
        name: 'Tekrarlı hatırlatma: ' + msg.slice(0, 40),
        schedule: s.schedule,
        prompt: `[TEKRARLI HATIRLATMA] Kullanıcıya şunu hatırlat: "${msg}". Kısaca ve nazikçe bildir.`,
        sessionId: sessionId || undefined,
      });
      if (!r.ok) return r;
      waLog(`tekrarlı hatırlatma kuruldu id=${r.job.id} schedule=${s.schedule} sid=${sessionId || '-'}`);
      return { ok: true, repeat: rep, schedule: s.schedule, message: msg };
    }
    const d = new Date(String(when || '').trim());
    if (isNaN(d.getTime())) return { ok: false, error: 'tarih anlaşılamadı — format YYYY-MM-DDTHH:mm' };
    if (d.getTime() <= Date.now()) return { ok: false, error: 'geçmiş bir zaman verildi' };
    const cronExpr = `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
    const r = cron.add({
      name: 'Hatırlatma: ' + msg.slice(0, 40),
      schedule: cronExpr,
      prompt: `[HATIRLATMA ZAMANI] Kullanıcıya şunu hatırlat: "${msg}". Kısaca ve nazikçe bildir.`,
      once: true,
      sessionId: sessionId || undefined,
    });
    if (!r.ok) return r;
    waLog(`reminder kuruldu id=${r.job.id} at=${d.toISOString()} sid=${sessionId || '-'}`);
    return { ok: true, at: d.toISOString(), message: msg };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* Giriş kapısı: slash komutlar hemen işlenir; DM allowlist'e bakar;
   grup sohbetleri mention-gated ayara göre kabul edilir. Uygun her mesaj
   anti-spam kuyruğuna düşürülür (WA_DEBOUNCE_MS birleştirme). */
/* ---------------- BOT SİSTEMİ yardımcıları ----------------
   Bot eşleştirme, izolasyon, whitelist.json aynası ve bot istatistikleri. */

/* İzin değerini araç kümesine çevirir; null = tüm araçlar ('all').
   'web' / ['web','read'] / 'web,read' biçimlerini kabul eder. */
function permToToolSet(p) {
  const { PERM_TOOL_SETS } = require('./agent/engine');
  const set = new Set();
  for (const raw of Array.isArray(p) ? p : String(p == null ? 'all' : p).split(',')) {
    const k = String(raw).trim() || 'all';
    if (k === 'all' || !PERM_TOOL_SETS[k]) return null;
    for (const t of PERM_TOOL_SETS[k]) set.add(t);
  }
  return set;
}

/* Hangi izin daha kısıtlıysa o kazanır. Dizi (çoklu bot izni) destekler:
   araç kümesi diğerinin alt kümesiyse o geçer; ikisi de alt küme değilse
   daha küçük küme kazanır (eşitse kişi yetkisi). */
function moreRestrictivePerm(a, b) {
  const sa = permToToolSet(a);
  const sb = permToToolSet(b);
  if (sa === null && sb === null) return 'all';
  if (sa === null) return b; // b kısıtlı
  if (sb === null) return a; // a kısıtlı
  const aSubB = [...sa].every((t) => sb.has(t));
  const bSubA = [...sb].every((t) => sa.has(t));
  if (aSubB && !bSubA) return a;
  if (bSubA && !aSubB) return b;
  return sa.size <= sb.size ? a : b;
}

function fmtPerm(p) {
  return Array.isArray(p) ? '[' + p.join('+') + ']' : String(p);
}

/* Bot skill checkbox'ları → oturumun görebileceği araç adları.
   null = kısıt yok (admin bot). */
function botToolSet(cfg) {
  const s = cfg && cfg.skills ? cfg.skills : {};
  const set = new Set([
    /* çekirdek: her botta konuşma + plan + hatırlatıcı */
    'todo_write', 'set_reminder', 'send_file',
    'tasks_list', 'task_status', 'task_cancel',
    'run_background', 'run_background_many', 'delegate_task',
    'event_list', 'event_subscribe', 'event_unsubscribe',
    'watcher_add', 'watcher_list', 'watcher_remove',
  ]);
  if (s.web_search) { set.add('web_search'); set.add('http_fetch'); set.add('deep_search'); }
  if (s.browser) {
    for (const t of ['browser_open', 'browser_read', 'browser_screenshot', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_select', 'ocr_read']) set.add(t);
  }
  if (s.email) { set.add('email_list'); set.add('email_read'); set.add('email_send'); }
  if (s.run_command) {
    for (const t of ['run_command', 'python_run', 'read_file', 'write_file', 'list_dir', 'computer_look', 'computer_act']) set.add(t);
  }
  if (s.memory) { set.add('memory_write'); set.add('user_write'); set.add('memory_search'); set.add('memory_hygiene'); }
  if (s.kb) { set.add('kb_search'); set.add('kb_add'); }
  return set;
}

/* Engine'a enjekte edilen çözümleyici: botId → persona bloğu verisi.
   Hafıza artık buildSystem içinde botun kendi SOUL/USER/MEMORY'sinden gelir. */
function botResolve(botId) {
  const b = bots.get(botId);
  if (!b) return null;
  const numbers = (settings.waAllow || [])
    .filter((e) => e && e !== '*' && e.bot_id === botId)
    .map((e) => '+' + e.num);
  return { ...b, numbers };
}

/* İzinli numaraların bot_id'sini düzelt + whitelist.json aynasını yaz */
function syncWhitelist() {
  try {
    let dirty = false;
    for (const e of settings.waAllow || []) {
      if (!e || e === '*') continue;
      if (e.bot_id && !bots.get(e.bot_id)) { delete e.bot_id; dirty = true; } // silinen bota bağlıysa botsuz yap
    }
    if (dirty) saveSettings();
    const map = {};
    for (const e of settings.waAllow || []) {
      if (e === '*') { map['*'] = { name: 'herkes', bot_id: 'beast', status: 'allowed' }; continue; }
      if (!e || !e.num) continue;
      map['+' + e.num] = {
        name: e.name || '',
        bot_id: bots.get(e.bot_id) ? e.bot_id : 'beast',
        status: e.owner ? 'admin' : 'allowed',
        perm: e.perm || 'all',
      };
    }
    fs.writeFileSync(path.join(beastDir(), 'whitelist.json'), JSON.stringify(map, null, 2));
  } catch {}
}

/* numara listesi → bot_id yeniden atama (bir numara tek bota bağlanır) */
function reassignBotNumbers(botId, numbers) {
  const wanted = new Set((Array.isArray(numbers) ? numbers : []).map((n) => String(n).replace(/\D/g, '')).filter((n) => n.length >= 6));
  for (const e of settings.waAllow || []) {
    if (!e || e === '*') continue;
    if (wanted.has(String(e.num))) e.bot_id = botId;
    else if (e.bot_id === botId) delete e.bot_id;
  }
  saveSettings();
}

function botListWithNumbers() {
  return bots.list().map((b) => ({
    ...b,
    numbers: (settings.waAllow || []).filter((e) => e && e !== '*' && e.bot_id === b.id).map((e) => ({ num: e.num, name: e.name || '' })),
  }));
}

function botStats() {
  const stats = {};
  for (const b of bots.list()) stats[b.id] = { id: b.id, name: b.name, icon: b.icon, admin: !!b.admin, numbers: 0, sessions: 0, msgs: 0, lastAt: null };
  try {
    for (const e of settings.waAllow || []) {
      if (e && e !== '*' && stats[e.bot_id || 'beast']) stats[e.bot_id || 'beast'].numbers++;
    }
  } catch {}
  try {
    for (const v of engine.listSessions()) {
      const bid = v.botId || 'beast';
      if (!stats[bid]) stats[bid] = { id: bid, name: bid, icon: '🤖', admin: false, numbers: 0, sessions: 0, msgs: 0, lastAt: null };
      stats[bid].sessions++;
      stats[bid].msgs += v.count || 0;
      if (!stats[bid].lastAt || String(v.updatedAt) > String(stats[bid].lastAt)) stats[bid].lastAt = v.updatedAt;
    }
  } catch {}
  return Object.values(stats);
}

async function handleWaIncoming(jid, payload, senderNum) {
  try {
    if (!engine) return;
    if (typeof payload === 'string') payload = { text: payload };
    const isGroup = !!payload.isGroup || jid.endsWith('@g.us');

    /* slash komutları: DM'de her zaman; grupta sadece bot mention edildiyse */
    const txt0 = String(payload.text || '').trim();
    if (txt0.startsWith('/') && !txt0.includes('\n') && (!isGroup || payload.mentioned)) {
      if (await tryWaSlash(jid, txt0, senderNum, payload)) return;
    }

    if (isGroup) {
      const g = settings.waGroups || {};
      if (!g.enabled) return;
      const mentionMode = g.mentionOnly !== false;
      /* MENTION MODU + seeAll: bot grubun TÜM konuşmasını BAĞLAM olarak görür
         ama yalnız @mention'da cevap üretir. seeAll VARSAYILAN KAPALI —
         mention'sız mesajlar tamamen yutulur (gizlilik). */
      if (mentionMode && !payload.mentioned && g.seeAll) {
        waGroupObserve(jid, payload, senderNum);
        return;
      }
      if (mentionMode && !payload.mentioned) return;
      waLog(`grup mesajı jid=${waPrettyJid(jid)} participant=+${senderNum || '?'} mention=${!!payload.mentioned}`);
    } else {
      const hit = waFind(senderNum);
      waLog(
        `incoming jid=${jid} sender=${senderNum || '?'} allowed=${!!hit}` +
          (hit && hit.name ? ' name=' + hit.name : '') +
          (hit && hit.lockdown ? ' locked=1' : '') +
          (payload && payload.media ? ' media=' + payload.media.kind : '')
      );
      if (!hit) return; // allowlist dışı yoksay
      // İsimsiz kayıt: güvenlik için cevap verme — kullanıcıyı ayarlara yönlendir
      if (hit.num !== '*' && !hit.name) {
        waLog(`skip: isimsiz kayıt (${hit.num}) — cevap verilmedi, Entegrasyonlar'da isim ekle`);
        return;
      }
      /* LID jidleri için gerçek PN'yi sakla — gönderim fallback'i buradan beslenir */
      if (senderNum) waJidPn.set(jid, String(senderNum));
    }
    waLog(`gate: kuyruğa geçiliyor jid=${waPrettyJid(jid)} sender=+${senderNum || '?'}`);
    resumeServices(); // pause durumunda gelen mesaj servisleri canlandırır
    waQueuePush(jid, { ...payload, isGroup }, senderNum);
  } catch (e) {
    waLog(`handleWaIncoming KRASİ: ${String((e && e.stack) || e)}`);
  }
}

/* Güvenli WA gönderimi: hedef adrese dener, LID gibi adresler patlarsa
   bilinen gerçek numaraya (@s.whatsapp.net) tek kez düşer. Hâlâ başarısızsa
   OFFLINE KUYRUĞA alınır — bağlantı gelince arka plan işçisi otomatik gönderir. */
async function sendWaSafe(jid, text) {
  let r = null;
  try {
    r = await wa.send(jid, text);
  } catch {}
  if (r) return true;
  const pn = waJidPn.get(jid);
  const pnJid = pn ? `${pn}@s.whatsapp.net` : '';
  if (pnJid && pnJid !== jid) {
    try {
      r = await wa.send(pnJid, text);
    } catch {}
    if (r) {
      waLog(`out fallback → ${waPrettyJid(pnJid)} (lid/pn denemelerinden sonra)`);
      return true;
    }
  }
  /* FEATURE 2: ağ yok / bağlantı koptu — mesajı kaybetme, kuyruğa al */
  if (wa) {
    const item = mqueue.add({ to: jid, body: String(text || '') });
    waLog(`out BAŞARISIZ jid=${jid} — mesaj kuyruğa alındı (id=${item.id}, bekleyen: ${mqueue.pendingCount()})`);
    mqueueEmit('Mesaj kuyruğa alındı — bağlantı gelince gönderilecek');
    return false;
  }
  waLog(`out BAŞARISIZ jid=${jid} — WhatsApp kurulu değil, kuyruğa alınmadı`);
  return false;
}

/* Kuyruk durumunu renderer'a bildir (toast + Entegrasyonlar'daki sayaç) */
function mqueueEmit(text) {
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('wa:event', { type: 'queue', ...mqueue.stats(), text: text || '' });
    }
  } catch {}
}

/* FEATURE 2 arka plan işçisi: bağlantı varsa kuyruğu sırayla boşalt.
   30 sn'de bir çağrılır; ayrıca WhatsApp 'connected' olduğunda anında tetiklenir. */
let mqueueBusy = false;
async function mqueueTick() {
  if (mqueueBusy) return;
  if (!wa || !wa.connected) return; // bağlantı yok — dosyada beklesin
  const dueItems = mqueue.due();
  if (!dueItems.length) return;
  mqueueBusy = true;
  try {
    let sent = 0;
    for (const m of dueItems) {
      let ok = false;
      try {
        ok = !!(await wa.send(m.to, m.body));
      } catch {}
      if (!ok) {
        /* LID fallback: doğrudan numara adresiyle tekrar dene */
        const pn = waJidPn.get(m.to);
        const pnJid = pn ? `${pn}@s.whatsapp.net` : '';
        if (pnJid && pnJid !== m.to) {
          try {
            ok = !!(await wa.send(pnJid, m.body));
          } catch {}
        }
      }
      if (ok) {
        mqueue.markSent(m.id);
        sent++;
      } else {
        mqueue.bumpRetry(m.id); // 30sn→1dk→5dk→15dk→30dk backoff; 5. denemeden sonra failed
      }
    }
    if (sent) {
      const st = mqueue.stats();
      waLog(`kuyruk: ${sent} mesaj gönderildi (kalan bekleyen: ${st.pending}, başarısız: ${st.failed})`);
      mqueueEmit(`${sent} mesaj gönderildi`);
    }
  } finally {
    mqueueBusy = false;
  }
}

/* Kuyruktan tek paket halinde gelir: asıl işleme burada */

async function processWaMessage(jid, payload, senderNum, requeues = 0) {
  const isGroup = !!payload.isGroup;
  const hit = isGroup ? null : waFind(senderNum);
  if (!isGroup && !hit) {
    waLog(`skip flush: izinli eşleşme yok (sender=+${senderNum || '?'})`);
    return;
  }
  let sid = waChats.get(jid);
  if (sid && engine.isBusy(sid)) {
    /* oturum hâlâ önceki işle uğraşıyor — KAYBETME: sınırı kaldırdık,
       iş bitene dek her debounce turunda yeniden deneriz; kullanıcıya
       "işleyemedim" denmez, mesaj boşa gitmez. */
    if (requeues === 1) {
      waLog(`flush: oturum meşgul, mesaj kuyrukta bekliyor sid=${sid}`);
    }
    await new Promise((r) => setTimeout(r, WA_DEBOUNCE_MS));
    return processWaMessage(jid, payload, senderNum, requeues + 1);
  }
  if (!isGroup && requeues > 0) {
    // retry sonrası izin yeniden kontrol edilir (yukarıda hit zaten alınıyor)
  }
  if (!sid) {
    const v = engine.createSession();
    sid = v.id;
    waChats.set(jid, sid);
    waRememberSession(jid, sid);
    saveWaChats();
    if (wa) wa.setWatchJids([...waChats.keys()]);
  } else {
    waRememberSession(jid, sid);
  }
  // Cevap verilecek — karşı telefonda "yazıyor…" göstergesi (medya işlenene dek sürer)
  wa.setComposing(jid, true);
  // Kişi bazlı granül izin: all/web/read/chat
  let perm = isGroup ? 'all' : hit.perm || (hit.lockdown ? 'chat' : 'all');
  engine.setSessionPerm(sid, perm);

  /* BOT SİSTEMİ: numara → bot eşleştirme (izinli kayıtta bot_id yoksa beast'e düşer) */
  let botId = !isGroup && hit && hit.bot_id ? String(hit.bot_id) : 'beast';
  if (!bots.get(botId)) {
    if (botId !== 'beast') waLog(`bot="${botId}" yok — numara botsuz, beast (admin) botuna yönlendirildi`);
    botId = 'beast';
  }
  engine.setSessionBot(sid, botId);
  const botCfg = bots.get(botId);
  if (botCfg && !botCfg.admin) {
    /* bot yetkisi kişi yetkisinden daha kısıtlıysa o geçerli olur */
    const eff = moreRestrictivePerm(perm, botCfg.perm || 'all');
    if (eff !== perm) {
      perm = eff;
      engine.setSessionPerm(sid, eff);
    }
    engine.setSessionTools(sid, botToolSet(botCfg));
  } else {
    engine.setSessionTools(sid, null);
  }
  engine.setSessionModel(sid, botCfg && !botCfg.admin ? (botCfg.model || null) : null);
  /* BEASTCODE MODU: sohbet uzaktan kodlama modundaysa oturumu Beast Code
     olarak tazele — restart sonrası bcCode/workspace bayrakları dosyadan
     yüklenmediği için masaüstü bcFlush disipliniyle her mesajda bindirilir */
  if (waBcMode.has(jid)) {
    const bs = engine.cache.get(sid);
    if (bs) {
      bs.bcCode = true;
      bs.workspace = waBcWorkspace();
      engine.cache.set(sid, bs);
    }
  }
  waLog(`perm=${fmtPerm(perm)} bot=${botId} sid=${sid}${waBcMode.has(jid) ? ' beastcode=1' : ''}`);

  const participantName = payload.participant ? '+' + String(payload.participant).split('@')[0].split(':')[0] : '';
  /* GRUP GÖNDERENİ: LID çağında gerçek telefon participantAlt'ta gelir.
     Kimlik çözümleme sırası: izin listesindeki isim → @kullanıcı adı → gerçek PN → LID.
     Ajan böylece grubun içinde mesajın KİMDEN geldiğini görür. */
  let groupSender = '';
  let groupSenderOwner = false;
  if (isGroup) {
    const gi = waGroupSenderInfo(payload);
    groupSender = gi.label || participantName;
    groupSenderOwner = gi.isOwner;
  }
  /* #v13.1 rol: SAHİP vs MİSAFİR — ajan kime konuştuğunu net bilsin.
     GRUPLARDA DA: gönderen izin listesinde SAHİP olarak işaretliyse ajan
     bunu görür — sahibinin grup içi talepleri misafir sözünden önceliklidir. */
  const isOwner = !isGroup && !!hit.owner;
  const roleTag = isOwner || groupSenderOwner
    ? 'SAHİBİN (talepleri önceliklidir)'
    : 'MİSAFİR (izinli ama sahibin sözü önceliklidir)';
  const label = isGroup
    ? `Grup ${jid.split('@')[0]}${groupSender ? ` — gönderen: ${groupSender} — ${groupSenderOwner ? 'SAHİBİN' : 'MİSAFİR (grup üyesi)'}` : ''}`
    : hit.name
      ? `${hit.name} (+${senderNum || '?'}) — ${roleTag}`
      : `+${senderNum || '?'} — ${roleTag}`;
  let text = `[WhatsApp${isGroup ? ' grup' : ''} — gönderen: ${label}]`;
  if (!isGroup && !isOwner) {
    text += `\n[NOT: Bu kişi SAHİP DEĞİL, misafirdir. Sahibin ayarlarını/verilerini değiştirme; kalıcı hafızaya misafire özel bilgi yazma.]`;
  } else if (isGroup) {
    text += groupSenderOwner
      ? `\n[NOT: Grup mesajı ama gönderen SAHİBİN — talepleri önceliklidir, misafir gibi temkinli konuşmana gerek yok.]`
      : `\n[NOT: Grup mesajı — gönderen grubun üyesidir, izin listendeki kişi olmayabilir. Grup üyelerine karşı temkinli konuş.]`;
  }
  const attachments = [];

  // Medya işleme
  if (payload.media) {
    const md = payload.media;
    try {
      if (md.kind === 'image') {
        attachments.push({ type: 'image', dataUrl: `data:${md.mimetype};base64,${md.buf.toString('base64')}`, name: md.name });
        text += `\n[resim eki alındı]`;
      } else if (md.kind === 'audio') {
        const tr = await transcribeAudio(md.buf, md.mimetype);
        text += tr
          ? `\n[sesli mesaj transkripti]\n${tr}`
          : `\n[sesli mesaj alındı ama transkripte çevrilemedi — Entegrasyonlar'da sesli mesaj (STT) ayarı gerekli]`;
      } else if (md.kind === 'document') {
        /* SKILL.md atıldıysa skill olarak kurulur */
        const inst = installSkillFromDoc(md);
        if (inst && inst.folder) {
          await wa.send(
            jid,
            `*Skill kuruldu:* ${inst.folder}\nArtık kullanabilirim — /skills ile listeleyebilirsin.`
          ).catch(() => {});
          try { await wa.setComposing(jid, false); } catch {}
          return;
        }
        if (inst && inst.error) {
          text += `\n[SKILL.md alındı ama kaydedilemedi]`;
        } else {
          const dt = documentToText(md);
          if (dt && dt.trim()) {
            attachments.push({ type: 'file', name: md.name, content: dt.slice(0, 20000) });
            text += `\n[belge alındı: ${md.name}]`;
          } else {
            text += `\n[belge alındı ama okunamadı: ${md.name}]`;
          }
        }
      }
    } catch (e) {
      waLog(`medya hata: ${String((e && e.message) || e)}`);
      text += `\n[medya işlenemedi]`;
    }
  }

  if (payload.text) text += `\n${String(payload.text).slice(0, 6000)}`;
  /* BEASTCODE MODU: WA'dan gelen kullanıcı mesajını masaüstü panelde de göster.
     Ajan cevabı engine olaylarıyla zaten panele akar ama KULLANICI mesajı için
     engine olay üretmez (panel kendi input'undan "code>" satırı basar) — bu
     yüzden açıkça bildiriyoruz; yoksa WhatsApp'tan yazılanlar panelde görünmez. */
  if (waBcMode.has(jid) && win && !win.isDestroyed()) {
    const waEcho = [];
    if (payload.text) waEcho.push(String(payload.text).slice(0, 6000));
    if (attachments.length) {
      waEcho.push(
        '[' +
          attachments
            .map((a) => (a.type === 'image' ? 'resim' : 'dosya: ' + (a.name || '?')))
            .join(', ') +
          ']'
      );
    }
    win.webContents.send('agent:event', {
      sessionId: sid,
      type: 'wa-user',
      from: isGroup ? (groupSender || 'grup üyesi') : (hit && hit.name) || '+' + (senderNum || '?'),
      text: waEcho.join('\n'),
    });
  }
  engine.send(sid, { text: text.slice(0, 8000), attachments }, { userAction: true });
}

function ensureWa() {
  if (!wa) {
    wa = new WhatsAppBridge({
      authDir: WA_AUTH_DIR,
      emit: (ev) => {
        if (ev.type === 'status') {
          waLog(`status=${ev.status}${ev.user ? ' user=' + ev.user : ''}`);
          if (ev.status === 'qr') waAwaitingRestart = true; // eşleme süreci başladı
          /* #v13: ilk QR eşlemesi sonrası ilk bağlantı — temiz durum için
             otomatik restart (auth artık diskte, ikinci açılış sessiz bağlanır) */
          if (ev.status === 'connected' && waAwaitingRestart) {
            waAwaitingRestart = false;
            waLog('ilk eşleme tamam — uygulama 3 sn içinde otomatik yeniden başlatılıyor');
            if (win && !win.isDestroyed()) {
              win.webContents.send('wa:event', { type: 'status', status: 'restarting' });
            }
            setTimeout(() => {
              flushBrowserStorage(); // app.exit before-quit'i atlar — elle flush
              app.relaunch(); // aynı argümanlarla yeniden başlat
              app.exit(0);    // before-quit tetiklenmeden temiz çıkış
            }, 3000);
          }
          /* FEATURE 2: bağlantı geri geldi → bekleyen kuyruk mesajlarını hemen boşalt */
          if (ev.status === 'connected') {
            setTimeout(() => { mqueueTick().catch(() => {}); }, 2500);
          }
        } else if (ev.type === 'send') {
          waLog(`out → ${waPrettyJid(ev.jid)} "${ev.preview || ''}"`);
        } else if (ev.type === 'tick') {
          waLog(`tick ${ev.label} ← ${waPrettyJid(ev.jid)} "${ev.preview || ''}"`);
        } else if (ev.type === 'receipt') {
          waLog(`receipt ${ev.detail} ← "${ev.preview || ''}"`);
        } else if (ev.type === 'presence') {
          waLog(`presence ${ev.label || ev.presence} ← ${waPrettyJid(ev.jid)}`);
          bridgeWaToBus(ev);
        } else if (ev.type === 'send-error') {
          waLog(`SEND HATA → ${waPrettyJid(ev.jid)} "${ev.preview || ''}" sebep: ${ev.error}`);
        }
        if (win && !win.isDestroyed()) win.webContents.send('wa:event', ev);
      },
      onIncoming: handleWaIncoming,
    });
    wa.setWatchJids([...waChats.keys()]);
  }
  return wa;
}

/* ---------- TELEGRAM ENTEGRASYONU (FEATURE 3) ----------
   WhatsApp ile aynı akış: gelen mesaj → allow list kontrolü → oturuma bağla
   (bot eşleme + granül izin) → engine.send; cevap done/error olayında geri
   gider. Anti-spam: 4.5 sn birleştirme penceresi (WA ile aynı). */

(function tgChatsLoad() {
  try {
    const raw = JSON.parse(fs.readFileSync(TG_CHATS_FILE, 'utf8'));
    if (raw && typeof raw.chats === 'object') {
      for (const [c, s] of Object.entries(raw.chats)) {
        if (typeof s === 'string') tgChats.set(c, s);
      }
    }
    if (raw && typeof raw.history === 'object') {
      for (const [c, arr] of Object.entries(raw.history)) {
        if (Array.isArray(arr)) tgHistory.set(c, arr.filter((x) => typeof x === 'string').slice(-TG_HISTORY_CAP));
      }
    }
    for (const [c, s] of tgChats.entries()) {
      const h = tgHistory.get(c) || [];
      if (!h.includes(s)) h.push(s);
      tgHistory.set(c, h.slice(-TG_HISTORY_CAP));
    }
  } catch {}
})();

function saveTgChats() {
  try {
    fs.writeFileSync(
      TG_CHATS_FILE,
      JSON.stringify({
        chats: Object.fromEntries(tgChats),
        history: Object.fromEntries([...tgHistory.entries()].map(([c, a]) => [c, a.slice(-TG_HISTORY_CAP)])),
      })
    );
  } catch {}
}

function tgRememberSession(chatId, sid) {
  const h = tgHistory.get(chatId) || [];
  if (!h.includes(sid)) h.push(sid);
  tgHistory.set(chatId, h.slice(-TG_HISTORY_CAP));
}

const TG_DEBOUNCE_MS = 4500;
const tgQueue = new Map(); // chatId -> { timer, payloads[] }

function tgQueuePush(chatId, payload) {
  let q = tgQueue.get(chatId);
  if (!q) {
    q = { payloads: [] };
    tgQueue.set(chatId, q);
  }
  q.payloads.push(payload);
  clearTimeout(q.timer);
  tgLog(`queue: mesaj kuyruğa girdi chat=${chatId} toplam=${q.payloads.length} (4.5 sn birleştirme)`);
  q.timer = setTimeout(() => {
    tgFlush(chatId).catch((e) => tgLog(`flush KRASİ: ${String((e && e.stack) || e)}`));
  }, TG_DEBOUNCE_MS);
}

async function tgFlush(chatId) {
  const q = tgQueue.get(chatId);
  if (!q) return;
  tgQueue.delete(chatId);
  const merged = { text: '', senderId: '', username: '', senderName: '' };
  for (const p of q.payloads) {
    if (p.text) merged.text += (merged.text ? '\n' : '') + p.text;
    if (!merged.senderId && p.senderId) { merged.senderId = p.senderId; merged.username = p.username; merged.senderName = p.senderName; }
  }
  await processTgMessage(chatId, merged);
}

async function handleTgIncoming(chatId, payload) {
  try {
    if (!engine) return;
    /* v1: yalnız birebir sohbetler — grup davranışı WA'daki gibi ayrı toggle ile gelir */
    if (payload.isGroup) {
      tgLog(`skip: grup mesajı chat=${chatId} (grup desteği kapalı)`);
      return;
    }
    const hit = tgFind(payload.senderId, payload.username);
    tgLog(
      `incoming chat=${chatId} sender=${payload.senderId || '?'} user=${payload.username || '-'} allowed=${!!hit}` +
        (hit && hit.name ? ' name=' + hit.name : '')
    );
    if (!hit) return; // allowlist dışı yoksay
    /* İsimsiz kayıt: güvenlik için cevap verme — kullanıcıyı ayarlara yönlendir */
    if (hit.id !== '*' && !hit.name) {
      tgLog(`skip: isimsiz kayıt (${hit.id}) — cevap verilmedi, Entegrasyonlar'da isim ekle`);
      return;
    }
    resumeServices(); // pause durumunda gelen mesaj servisleri canlandırır
    tgQueuePush(String(chatId), payload);
  } catch (e) {
    tgLog(`handleTgIncoming KRASİ: ${String((e && e.stack) || e)}`);
  }
}

async function processTgMessage(chatId, payload, requeues = 0) {
  const hit = tgFind(payload.senderId, payload.username);
  if (!hit) {
    tgLog(`skip flush: izinli eşleşme yok (sender=${payload.senderId || '?'})`);
    return;
  }
  let sid = tgChats.get(chatId);
  if (sid && engine.isBusy(sid)) {
    /* oturum meşgul — WA ile aynı: kaybetme, iş bitene dek yeniden dene */
    await new Promise((r) => setTimeout(r, TG_DEBOUNCE_MS));
    return processTgMessage(chatId, payload, requeues + 1);
  }
  if (!sid) {
    const v = engine.createSession();
    sid = v.id;
    tgChats.set(chatId, sid);
    tgRememberSession(chatId, sid);
    saveTgChats();
  } else {
    tgRememberSession(chatId, sid);
  }
  /* Kişi bazlı granül izin: all/web/read/chat */
  let perm = hit.perm || (hit.lockdown ? 'chat' : 'all');
  engine.setSessionPerm(sid, perm);

  /* BOT SİSTEMİ: izinli kayıtta bot_id yoksa beast'e düşer (WA ile aynı) */
  let botId = hit && hit.bot_id ? String(hit.bot_id) : 'beast';
  if (!bots.get(botId)) {
    if (botId !== 'beast') tgLog(`bot="${botId}" yok — kayıt botsuz, beast (admin) botuna yönlendirildi`);
    botId = 'beast';
  }
  engine.setSessionBot(sid, botId);
  const botCfg = bots.get(botId);
  if (botCfg && !botCfg.admin) {
    const eff = moreRestrictivePerm(perm, botCfg.perm || 'all');
    if (eff !== perm) {
      perm = eff;
      engine.setSessionPerm(sid, eff);
    }
    engine.setSessionTools(sid, botToolSet(botCfg));
  } else {
    engine.setSessionTools(sid, null);
  }
  engine.setSessionModel(sid, botCfg && !botCfg.admin ? (botCfg.model || null) : null);
  tgLog(`perm=${fmtPerm(perm)} bot=${botId} sid=${sid}`);

  /* #v13.1 rol: SAHİP vs MİSAFİR — ajan kime konuştuğunu net bilsin */
  const isOwner = !!hit.owner;
  const roleTag = isOwner
    ? 'SAHİBİN (talepleri önceliklidir)'
    : 'MİSAFİR (izinli ama sahibin sözü önceliklidir)';
  const label =
    (hit.name || payload.senderName || '?') +
    (payload.username ? ` (@${payload.username})` : '') +
    ` — ${roleTag}`;
  let text = `[Telegram — gönderen: ${label}]`;
  if (!isOwner) {
    text += `\n[NOT: Bu kişi SAHİP DEĞİL, misafirdir. Sahibin ayarlarını/verilerini değiştirme; kalıcı hafızaya misafire özel bilgi yazma.]`;
  }
  text += `\n${String(payload.text || '').slice(0, 6000)}`;
  engine.send(sid, { text: text.slice(0, 8000), attachments: [] }, { userAction: true });
}

async function sendTgSafe(chatId, text) {
  if (!tg) return false;
  try {
    return !!(await tg.send(chatId, text));
  } catch (e) {
    tgLog(`send hata chat=${chatId}: ${String((e && e.message) || e)}`);
    return false;
  }
}

function ensureTg() {
  if (!tg) {
    tg = new TelegramBridge({
      token: settings.tgToken || '',
      emit: (ev) => {
        if (ev.type === 'status') tgLog(`status=${ev.status}${ev.user ? ' user=' + ev.user : ''}`);
        if (win && !win.isDestroyed()) win.webContents.send('tg:event', ev);
      },
      onIncoming: handleTgIncoming,
    });
  }
  return tg;
}

/* token değişimi / yeniden başlatma: eski köprüyü kapat, yenisini aç */
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
    tgLog(`start başarısız: ${String((e && e.message) || e)}`);
  }
}

/* ---------- DISCORD: allow list — WA/TG ile aynı mantık ----------
   Liste formatı: [{ id:'123456789' | '@kullanici_adi', name, perm, bot_id }, '*']
   Eşleşme: sayısal ID birebir, @username büyük/küçük harf duyarsız. */
function dcLog(line) {
  try { log.info('discord', line); } catch {}
}

function dcFind(senderId, username) {
  const list = settings.dcAllow || [];
  if (!list.length) return null; // boş liste = kimseye cevap yok
  const id = String(senderId || '').trim();
  const uname = String(username || '').replace(/^@/, '').toLowerCase();
  for (const e of list) {
    if (e === '*') return { id: '*', name: '' };
    const eid = typeof e === 'string' ? e.trim() : String((e && e.id) || '').trim();
    if (!eid) continue;
    if (eid === '*') return { id: '*', name: '' };
    if (eid.startsWith('@')) {
      if (uname && eid.slice(1).toLowerCase() === uname) {
        return typeof e === 'string' ? { id: eid, name: '' } : e;
      }
    } else if (id && eid === id) {
      return typeof e === 'string' ? { id: eid, name: '' } : e;
    }
  }
  return null;
}

(function dcChatsLoad() {
  try {
    const raw = JSON.parse(fs.readFileSync(DC_CHATS_FILE, 'utf8'));
    if (raw && typeof raw.chats === 'object') {
      for (const [c, s] of Object.entries(raw.chats)) {
        if (typeof s === 'string') dcChats.set(c, s);
      }
    }
    if (raw && typeof raw.history === 'object') {
      for (const [c, arr] of Object.entries(raw.history)) {
        if (Array.isArray(arr)) dcHistory.set(c, arr.filter((x) => typeof x === 'string').slice(-DC_HISTORY_CAP));
      }
    }
    for (const [c, s] of dcChats.entries()) {
      const h = dcHistory.get(c) || [];
      if (!h.includes(s)) h.push(s);
      dcHistory.set(c, h.slice(-DC_HISTORY_CAP));
    }
  } catch {}
})();

function saveDcChats() {
  try {
    fs.writeFileSync(
      DC_CHATS_FILE,
      JSON.stringify({
        chats: Object.fromEntries(dcChats),
        history: Object.fromEntries([...dcHistory.entries()].map(([c, a]) => [c, a.slice(-DC_HISTORY_CAP)])),
      })
    );
  } catch {}
}

function dcRememberSession(channelId, sid) {
  const h = dcHistory.get(channelId) || [];
  if (!h.includes(sid)) h.push(sid);
  dcHistory.set(channelId, h.slice(-DC_HISTORY_CAP));
}

const DC_DEBOUNCE_MS = 4500;
const dcQueue = new Map(); // channelId -> { payloads[] }

function dcQueuePush(channelId, payload) {
  let q = dcQueue.get(channelId);
  if (!q) {
    q = { payloads: [] };
    dcQueue.set(channelId, q);
  }
  q.payloads.push(payload);
  clearTimeout(q.timer);
  dcLog(`queue: mesaj kuyruğa girdi channel=${channelId} toplam=${q.payloads.length} (4.5 sn birleştirme)`);
  q.timer = setTimeout(() => {
    dcFlush(channelId).catch((e) => dcLog(`flush KRASİ: ${String((e && e.stack) || e)}`));
  }, DC_DEBOUNCE_MS);
}

async function dcFlush(channelId) {
  const q = dcQueue.get(channelId);
  if (!q) return;
  dcQueue.delete(channelId);
  const merged = { text: '', senderId: '', username: '', senderName: '' };
  for (const p of q.payloads) {
    if (p.text) merged.text += (merged.text ? '\n' : '') + p.text;
    if (!merged.senderId && p.senderId) { merged.senderId = p.senderId; merged.username = p.username; merged.senderName = p.senderName; }
  }
  await processDcMessage(channelId, merged);
}

async function handleDcIncoming(channelId, payload) {
  try {
    const hit = dcFind(payload.senderId, payload.username);
    dcLog(
      `incoming channel=${channelId} sender=${payload.senderId || '?'} user=${payload.username || '-'} allowed=${!!hit}` +
        (hit && hit.name ? ' name=' + hit.name : '')
    );
    if (!hit) return; // allowlist dışı yoksay
    /* İsimsiz kayıt: güvenlik için cevap verme — kullanıcıyı ayarlara yönlendir */
    if (hit.id !== '*' && !hit.name) {
      dcLog(`skip: isimsiz kayıt (${hit.id}) — cevap verilmedi, Entegrasyonlar'da isim ekle`);
      return;
    }
    resumeServices(); // pause durumunda gelen mesaj servisleri canlandırır
    dcQueuePush(String(channelId), payload);
  } catch (e) {
    dcLog(`handleDcIncoming KRASİ: ${String((e && e.stack) || e)}`);
  }
}

async function processDcMessage(channelId, payload) {
  const hit = dcFind(payload.senderId, payload.username);
  if (!hit) {
    dcLog(`skip flush: izinli eşleşme yok (sender=${payload.senderId || '?'})`);
    return;
  }
  let sid = dcChats.get(channelId);
  if (sid && engine.isBusy(sid)) {
    /* oturum meşgul — WA/TG ile aynı: kaybetme, iş bitene dek yeniden dene */
    await new Promise((r) => setTimeout(r, DC_DEBOUNCE_MS));
    return processDcMessage(channelId, payload, 1);
  }
  if (!sid) {
    const v = engine.createSession();
    sid = v.id;
    dcChats.set(channelId, sid);
    dcRememberSession(channelId, sid);
    saveDcChats();
  } else {
    dcRememberSession(channelId, sid);
  }
  /* Kişi bazlı granül izin: all/web/read/chat */
  let perm = hit.perm || (hit.lockdown ? 'chat' : 'all');
  engine.setSessionPerm(sid, perm);

  /* BOT SİSTEMİ: izinli kayıtta bot_id yoksa beast'e düşer (WA/TG ile aynı) */
  let botId = hit && hit.bot_id ? String(hit.bot_id) : 'beast';
  if (!bots.get(botId)) {
    if (botId !== 'beast') dcLog(`bot="${botId}" yok — kayıt botsuz, beast (admin) botuna yönlendirildi`);
    botId = 'beast';
  }
  engine.setSessionBot(sid, botId);
  const botCfg = bots.get(botId);
  if (botCfg && !botCfg.admin) {
    const eff = moreRestrictivePerm(perm, botCfg.perm || 'all');
    if (eff !== perm) {
      perm = eff;
      engine.setSessionPerm(sid, eff);
    }
    engine.setSessionTools(sid, botToolSet(botCfg));
  } else {
    engine.setSessionTools(sid, null);
  }
  engine.setSessionModel(sid, botCfg && !botCfg.admin ? (botCfg.model || null) : null);
  dcLog(`perm=${fmtPerm(perm)} bot=${botId} sid=${sid}`);

  /* #v13.1 rol: SAHİP vs MİSAFİR — ajan kime konuştuğunu net bilsin */
  const isOwner = !!hit.owner;
  const roleTag = isOwner
    ? 'SAHİBİN (talepleri önceliklidir)'
    : 'MİSAFİR (izinli ama sahibin sözü önceliklidir)';
  const label =
    (hit.name || payload.senderName || '?') +
    (payload.username ? ` (@${payload.username})` : '') +
    ` — ${roleTag}`;
  let text = `[Discord — gönderen: ${label}]`;
  if (!isOwner) {
    text += `\n[NOT: Bu kişi SAHİP DEĞİL, misafirdir. Sahibin ayarlarını/verilerini değiştirme; kalıcı hafızaya misafire özel bilgi yazma.]`;
  }
  text += `\n${String(payload.text || '').slice(0, 6000)}`;
  engine.send(sid, { text: text.slice(0, 8000), attachments: [] }, { userAction: true });
}

async function sendDcSafe(channelId, text) {
  if (!dc) return false;
  try {
    return !!(await dc.send(channelId, text));
  } catch (e) {
    dcLog(`send hata channel=${channelId}: ${String((e && e.message) || e)}`);
    return false;
  }
}

function ensureDc() {
  if (!dc) {
    dc = new DiscordBridge({
      token: settings.dcToken || '',
      emit: (ev) => {
        if (ev.type === 'status') dcLog(`status=${ev.status}${ev.user ? ' user=' + ev.user : ''}`);
        if (ev.type === 'warn') dcLog('⚠ ' + String(ev.text || ''));
        if (win && !win.isDestroyed()) win.webContents.send('dc:event', ev);
      },
      onIncoming: handleDcIncoming,
    });
  }
  return dc;
}

/* token değişimi / yeniden başlatma: eski köprüyü kapat, yenisini aç */
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
    dcLog(`start başarısız: ${String((e && e.message) || e)}`);
  }
}

function reloadBackend() {
  if (engine && typeof engine.dispose === 'function') {
    try { engine.dispose(); } catch {}
  }
  const cfg = loadBeastConfig();
  engine = new Engine(cfg, {
    sessionsDir: SESSIONS_DIR,
    workspace: settings.workspace || app.getPath('home'),
    modelOverride: settings.modelOverride || null,
    customProviders: settings.customProviders || [],
    /* ANA KOD KİLİDİ: agent kaynak kod klasörüne dokunamaz (okuma serbest) */
    protectedDirs: [...new Set([app.getAppPath(), app.isPackaged ? path.dirname(process.execPath) : ''].filter(Boolean))],
    resolveBot: (botId) => botResolve(botId),
    /* bot oturumu hafızası: botun KENDİ SOUL/USER/MEMORY dosyaları */
    botMemory: {
      read: (id, f) => bots.readMem(id, f),
      append: (id, t) => bots.appendMem(id, t),
      appendUser: (id, t) => bots.appendUserMem(id, t),
      search: (id, q, l) => bots.searchMem(id, q, l),
      relevant: (id, q) => bots.relevantMem(id, q),
    },
    roleModels: settings.roleModels || {},
    deletedModels: settings.deletedModels || [],
    lockdown: !!settings.waLockdown,
    ceoMode: settings.ceoMode === true, // default KAPALI — ayarlardan açılır
    thinkLevel: settings.thinkLevel || 0,
    fallout: settings.fallout || null,
    limits: settings.limits || null,
    /* OTOMATİK SKİLL SİSTEMİ: ayarlardan kapatılmadıysa öğrenilen prosedürler
       otomatik skill olur, mevcutların daha iyisi bulunursa güncellenir */
    autoSkills: settings.autoSkills !== false,
    approvals: settings.security && settings.security.approvals ? approvalsBridge : null,
    alwaysAllowTools: (settings.security && settings.security.alwaysAllow) || [],
    crashFile: FALLOUT_CRASH_FILE,
    notifyOwnerFail: settings.notifyOwnerFail !== false,
    fileSend: deliverFile,
    reminders: { add: scheduleReminder },
    watchers: {
      list: () => watchers.list(),
      add: (input) => watchers.add(input),
      remove: (id) => watchers.remove(id),
    },
    bus: {
      list: () => bus.listSubs(),
      add: (i) => bus.addSub(i),
      remove: (id) => bus.removeSub(id),
    },
    computer: {
      look: captureScreenDataUrl,
      act: (op, args) => computeruse.act(op, args),
    },
    ocr: (o) => ocrRead(o),
    email: { list: emailList, read: emailRead, send: emailSend },
    browser: {
      openUrl: (u, s, ctx) => browserNavigate(u, s, ctx),
      search: (q, s, ctx) => browserSearch(q, s, ctx),
      readText: (s) => browserRead(s),
      screenshot: (s) => browserScreenshot(s),
      snapshot: (s) => browserSnapshot(s),
      act: (k, a, s) => browserAct(k, a, s),
    },
    research: {
      /* deep_search'ün "sayfayı GİZLİ tarayıcıda açıp oku" parçası (Electron-only).
         Arama zinciri engine._webSearchChain içinde web_search ile birebir aynı. */
      readPage: (u, s) => researchRead(u, s),
    },
    emit: (ev) => {
      if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev);
      flushDesktopOnDone(ev); /* biriken desktop mesajlarını sıraya bas */
      bcFlushOnDone(ev); /* Beast Code kuyruğunu iş bitiminde boşalt */
      /* BC canlı önizleme: ajan bir dev server başlattıysa adresi yakala —
         preview butonu ve otomatik açılış DAİMA bu sunucuyu öncelikli kullanır */
      if (ev.type === 'bc-preview' && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?/i.test(String(ev.url || ''))) {
        bcLastServerUrl = String(ev.url);
      }
      /* WA canlı iş takibi: oturum bir WhatsApp sohbetine bağlıysa araç
         hareketlerini (terminal, web, dosya…) kısa satırla bildir.
         Spam olmasın: sohbet başına en az 7 sn'de bir tek satır. */
      if (ev.type === 'tool-start' && wa && wa.connected) {
        try {
          const hit = [...waChats.entries()].find(([, s]) => s === ev.sessionId);
          if (hit) {
            const now = Date.now();
            const last = lastWaToolPing.get(ev.sessionId) || 0;
            if (now - last >= 7000) {
              lastWaToolPing.set(ev.sessionId, now);
              sendWaSafe(hit[0], '\u203A ' + String(waToolLine(ev.name, ev.args || {})).replace(/^\u203A /, '')).catch(() => {});
            }
          }
        } catch {}
      }
      /* WA ara yorumları: ajanın araç çağrıları ARASINDAKİ açıklama metinleri
         ("işe başlıyorum…" vb.) da WhatsApp'a gitsin. Son cevap 'done'da
         gönderildiği için burada yalnız tool_calls TAŞIYAN ara mesajlar alınır. */
      if (ev.type === 'message' && ev.message && ev.message.role === 'assistant' && wa && wa.connected) {
        const mtxt = typeof ev.message.content === 'string' ? ev.message.content.trim() : '';
        const isInterim = Array.isArray(ev.message.tool_calls) && ev.message.tool_calls.length > 0;
        if (mtxt && isInterim) {
          try {
            const hit = [...waChats.entries()].find(([, s]) => s === ev.sessionId);
            if (hit) sendWaSafe(hit[0], mtxt).catch(() => {});
          } catch {}
        }
      }
      /* #14 paralel ajan: arka plan oturumu bitince ana sohbete özet bas.
         aborted (öz-kurtarma/wrap-up kick) turları BİTİŞ değildir — rapor basma */
      if (ev.type === 'done' && ev.sessionId && !ev.aborted) {
        try { engine.reportBackgroundDone(ev.sessionId).catch(() => {}); } catch {}
      }
      /* maliyet sayacı: tamamlanan her turda gerçek usage'ı işle */
      if (ev.type === 'done' && ev.usage && !ev.aborted) {
        try {
          usageMod.record({
            providerId: ev.meta ? ev.meta.providerId : null,
            model: ev.meta ? ev.meta.model : null,
            promptTokens: ev.usage.prompt_tokens || 0,
            completionTokens: ev.usage.completion_tokens || 0,
            costIn: ev.meta ? ev.meta.costIn : null,
            costOut: ev.meta ? ev.meta.costOut : null,
          });
        } catch {}
      }
      // WhatsApp oturumlarının son cevabını geri gönder (metin + opsiyonel ses)
      if ((ev.type === 'done' || ev.type === 'error') && wa && wa.connected) {
        const hit = [...waChats.entries()].find(([, s]) => s === ev.sessionId);
        if (hit) {
          const wajid = hit[0];
          (async () => {
            try {
              if (ev.type === 'error') {
                await sendWaSafe(wajid, 'Bir aksilik oldu: ' + String(ev.error || '').slice(0, 200));
                return;
              }
              if (!ev.aborted) {
                const s = engine.openSession(ev.sessionId);
                const lastA = [...s.messages].reverse().find((m) => m.role === 'assistant' && m.content);
                const txt = typeof (lastA && lastA.content) === 'string' ? lastA.content : '';
                if (txt.trim()) {
                  const okOut = await sendWaSafe(wajid, txt);
                  if (!okOut) {
                    try { await wa.setComposing(wajid, false); } catch {}
                    return;
                  }
                  const voice = await synthesizeSpeech(txt);
                  if (voice) await wa.sendAudio(wajid, voice).catch(() => {});
                }
              }
            } catch {}
            finally {
              try { await wa.setComposing(wajid, false); } catch {} // "yazıyor…" kapansın
            }
          })();
        }
      }
      // Telegram oturumlarının son cevabını geri gönder (WA ile aynı akış)
      if ((ev.type === 'done' || ev.type === 'error') && tg && tg.connected) {
        const hitT = [...tgChats.entries()].find(([, s]) => s === ev.sessionId);
        if (hitT) {
          const tgid = hitT[0];
          (async () => {
            try {
              if (ev.type === 'error') {
                await sendTgSafe(tgid, 'Bir aksilik oldu: ' + String(ev.error || '').slice(0, 200));
                return;
              }
              if (!ev.aborted) {
                const s = engine.openSession(ev.sessionId);
                const lastA = [...s.messages].reverse().find((m) => m.role === 'assistant' && m.content);
                const txt = typeof (lastA && lastA.content) === 'string' ? lastA.content : '';
                if (txt.trim()) await sendTgSafe(tgid, txt);
              }
            } catch {}
          })();
        }
      }
      // Discord oturumlarının son cevabını geri gönder (TG ile aynı akış)
      if ((ev.type === 'done' || ev.type === 'error') && dc && dc.connected) {
        const hitD = [...dcChats.entries()].find(([, s]) => s === ev.sessionId);
        if (hitD) {
          const dchid = hitD[0];
          (async () => {
            try {
              if (ev.type === 'error') {
                await sendDcSafe(dchid, 'Bir aksilik oldu: ' + String(ev.error || '').slice(0, 200));
                return;
              }
              if (!ev.aborted) {
                const s = engine.openSession(ev.sessionId);
                const lastA = [...s.messages].reverse().find((m) => m.role === 'assistant' && m.content);
                const txt = typeof (lastA && lastA.content) === 'string' ? lastA.content : '';
                if (txt.trim()) await sendDcSafe(dchid, txt);
              }
            } catch {}
          })();
        }
      }
      /* CRON → TÜM AKTİF ENTEGRASYONLAR: cron işi bittiğinde cevap (ya da
         hata) sahibin bağlı olduğu her kanala yansıtılır — WA + Telegram +
         Discord. Aynı kanal hem cron oturumuna bağlıysa TEK cevap alır. */
      if ((ev.type === 'done' || ev.type === 'error') && cronAnswerPending.has(String(ev.sessionId))) {
        const cjob = cronAnswerPending.get(String(ev.sessionId));
        cronAnswerPending.delete(String(ev.sessionId));
        if (!ev.aborted) {
          (async () => {
            try {
              let txt = '';
              if (ev.type === 'error') {
                txt = '⚠️ [cron: ' + String((cjob && cjob.name) || 'görev') + ']\nHata: ' + String(ev.error || '').slice(0, 200);
              } else {
                const s = engine.openSession(ev.sessionId);
                const lastA = [...s.messages].reverse().find((m) => m.role === 'assistant' && m.content);
                txt = typeof (lastA && lastA.content) === 'string' ? lastA.content : '';
                if (txt.trim()) txt = '⏰ [cron: ' + String((cjob && cjob.name) || 'görev') + ']\n' + txt;
              }
              if (!txt.trim()) return;
              for (const m of cronMirrorTargets(String(ev.sessionId))) {
                try { await m.send(txt); } catch {}
              }
            } catch {}
          })();
        }
      }
    },
  });
  return engine.publicState();
}

const gotLock = app.requestSingleInstanceLock();

/* FALLOUT: çökme sonrası otomatik kurtarma — kayıtlı durumu bul,
   aynı oturuma "kaldığın yerden devam" görevi gönder. */
let falloutResumed = false;
function falloutResume() {
  if (falloutResumed) return;
  falloutResumed = true;
  try {
    const f = settings.fallout || {};
    if (!f.enabled || f.autoResume === false) return;
    const st = JSON.parse(fs.readFileSync(FALLOUT_CRASH_FILE, 'utf8'));
    if (!st || !st.sessionId) return;
    const sid = reuseOrLatestSession(st.sessionId);
    const when = st.at ? new Date(st.at).toLocaleString('tr-TR') : '?';
    setTimeout(() => {
      try {
        engine.send(sid, {
          text:
            `[FALLOUT KURTARMA] Önceki çalışma ${when}'de bir hata yüzünden yarıda kesildi ` +
            `(hata: ${String(st.error || '').slice(0, 160)}). ` +
            `Sohbet geçmişini incele ve kaldığın yerden devam et; yarım kalan işleri tamamla.`,
        });
      } catch {}
    }, 2500);
  } catch {}
}
/* "Nerede kaldım?" (#5): açılışta son oturumun durumu + yarım todolar.
   Ayarlardan kapatılabilir (settings.whereWasI.enabled). */
function whereWasISummary() {
  try {
    const last = engine.lastWhereWasI();
    if (!last) return null;
    const lines = [];
    lines.push(`Son oturum: \`${last.code}\` — ${last.title}`);
    lines.push(`Tarih: ${last.updatedAt} · ${last.msgCount} mesaj`);
    if (last.lastAssistant) lines.push(`Kalınan nokta: ${last.lastAssistant}`);
    if (last.pendingTodos.length) {
      lines.push('');
      lines.push('Yarım kalan görevler:');
      for (const t of last.pendingTodos) {
        const mark = t.status === 'active' ? '▶' : '·';
        lines.push(`${mark} ${t.title}`);
      }
      if (last.doneCount) lines.push(`(${last.doneCount} görev zaten tamamlanmış)`);
    } else {
      lines.push('Bekleyen görev yok.');
    }
    return { text: lines.join('\n'), sessionId: last.sessionId };
  } catch {
    return null;
  }
}

/* Açılış + 2 sn sonra: çıktı masaüstündeki o oturuma düşer (WA'ya sızmaz:
   done akışı yalnızca waChats'te eşleşen sid'lere gider ve bu yeni bir
   oturumsa eşleşmez; varsa da zararsız tekil özettir). */
function maybeRunWhereWasI() {
  try {
    const cfg = settings.whereWasI || {};
    /* DEFAULT KAPALI: yalnız Ayarlar → Maliyet · Limit'ten açıldıysa göster */
    if (cfg.enabled !== true) return;
    const sum = whereWasISummary();
    if (!sum) return;
    settingsLog(`nerede-kaldım: ${String(sum.text).split('\n')[0]}`);
    // kullanıcı görür diye konuya ek olarak sohbete de yansıt
    setTimeout(() => {
      try {
        engine.send(sum.sessionId, {
          text:
            `[NEREDE KALDIM ÖZETİ] Aşağıdaki özeti kullanıcıya kısaca göster:\n` +
            sum.text +
            `\n\n(Sadece bunu bildir; ek iş başlatma. Kullanıcı isterse kaldığın yerden devam et.)`,
        });
      } catch {}
    }, 2000);
  } catch {}
}
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    /* ikinci `beast-agent` çağrısı: tepside gizli olsa bile pencereyi öne getir */
    try { showWin(); } catch {}
  });

  /* npm (global) kurulumda masaüstü kısayolu — yoksa bir kez oluşturulur.
   (NSIS packaged modda kısayolu electron-builder zaten yapar.) */
function ensureDesktopShortcut() {
  try {
    const desktop = app.getPath('desktop');
    const lnk = path.join(desktop, 'Beast Agent.lnk');
    /* çalışma klasörü kullanıcı home'u olsun: paket klasöründe başlarsa güncelleme
       cmd'si orada açılır ve npm install -g klasör kilidi (EBUSY) yemek zorunda kalır */
    const goodCwd = app.getPath('home');
    if (fs.existsSync(lnk)) {
      /* eski kısayollar paket klasörünü çalışma klasörü olarak taşıyordu — onar */
      try {
        const cur = shell.readShortcutLink(lnk);
        if (cur && cur.cwd && /node_modules[\\/]beast-agent/i.test(cur.cwd)) {
          shell.writeShortcutLink(lnk, 'update', { ...cur, cwd: goodCwd });
          log.info('main', 'Masaüstü kısayolu çalışma klasörü home\u2019a taşındı');
        }
      } catch {}
      return;
    }
    const ok = shell.writeShortcutLink(lnk, 'create', {
      target: process.execPath,
      args: app.getAppPath(),
      cwd: goodCwd,
      description: 'Beast Agent — hızlı, hafif ve becerikli',
      icon: path.join(__dirname, '..', 'assets', 'app.ico'),
      iconIndex: 0,
    });
    log.info('main', ok ? 'Masaüstü kısayolu oluşturuldu (npm modu)' : 'Masaüstü kısayolu oluşturulamadı');
  } catch (e) {
    log.info('main', 'Kısayol hatası: ' + String((e && e.message) || e));
  }
}

app.whenReady().then(() => {
    // Tailscale modu: paketli uygulamada Windows ile otomatik başlat (sessiz, tepside)
    if (app.isPackaged) {
      /* DAĞITIM KARARI: EXE/portable kurulum desteklenmiyor — tek yol npm.
         EXE kendini startup'a YAZMAZ (eski portable kayıtları da temizlenir). */
      try {
        const k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
        spawn('reg.exe', ['delete', k, '/v', 'electron.app.Beast Agent', '/f'], { stdio: 'ignore', windowsHide: true }).unref();
        spawn('reg.exe', ['query', k, '/v', 'electron.app.Beast Agent'], { stdio: 'ignore', windowsHide: true }).on('exit', (code) => {
          if (code !== 0) log.info('main', 'EXE modunda çalışıyor — startup kaydı temizlendi (npm kurulumuna geçin)');
        });
      } catch {}
      log.info('main', '⚠ EXE/portable mod desteklenmiyor — tek dağıtım: npm i -g beast-agent');
    } else if (!app.isPackaged && /node_modules[\\/]beast-agent/i.test(String(app.getAppPath()))) {
      /* npm (global) kurulum modu: startup kaydı + masaüstü kısayolu */
      try {
        app.setLoginItemSettings({
          openAtLogin: true,
          path: process.execPath,
          args: [app.getAppPath(), '--hidden'],
        });
        log.info('main', 'Startup kaydı açık (npm modu): ' + app.getAppPath());
      } catch (e) {
        log.error('main', 'Startup kaydı (npm) başarısız: ' + String((e && e.message) || e));
      }
      ensureDesktopShortcut();
    }
    reloadBackend();
    syncWhitelist(); // bot sistemi: whitelist.json aynası ilk açılışta garanti
    try { bots.ensureBotCodes(); } catch {} // her bota benzersiz 5 haneli kod garanti
    createSplash();
    createWindow();
    log.info('main', 'Beast Agent başlatıldı');
    createTray();
    cron.init({ onFire: cronFire });
    watchers.start({ onTrigger: watcherFire });
    startEventBus();
    ideWatchStart(); // soldaki dosya ağacı canlı izlemede
    maybeRunWhereWasI();
    falloutResume();
    startAutoUpdater(); // #3 sessiz güncelleme
    startNpmUpdateWatch(); // npm kurulumunda registry üzerinden otomatik sürüm kontrolü
    /* FEATURE 2: offline kuyruk işçisi — 30 sn'de bir bağlantı kontrolü + kuyruk boşaltma */
    setInterval(() => { mqueueTick().catch(() => {}); }, 30000).unref();
    /* OFFLINE MESAJ KUYRUĞU: gerçek bağlantı yoklaması — 8 sn'de bir DNS probe.
       Bağlantı dönünce kuyruktaki chat mesajları otomatik gönderilir. */
    netCheck().catch(() => {});
    setInterval(() => { netCheck().catch(() => {}); }, NET_CHECK_MS).unref();

    // #12 STT prefetch: whisper modelini arka planda hazırla (ilk sesli mesajda bekleme olmasın)
    if (settings.sttPrefetch !== false) {
      setTimeout(() => {
        ensureStt()
          .then(() => waLog('STT prefetch tamam'))
          .catch((e) => waLog('STT prefetch atlandı: ' + String((e && e.message) || e)));
      }, 10000);
    }

    // WhatsApp köprüsünü otomatik başlat (eşleme varsa direkt bağlanır)
    ensureWa().start().catch((e) => waLog('autostart failed: ' + (e && e.message)));

    // Telegram köprüsünü otomatik başlat (token kayıtlıysa)
    if (settings.tgToken) {
      ensureTg().start().catch((e) => tgLog('autostart failed: ' + String((e && e.message) || e)));
    }

    // Discord köprüsünü otomatik başlat (token kayıtlıysa)
    if (settings.dcToken) {
      ensureDc().start().catch((e) => dcLog('autostart failed: ' + String((e && e.message) || e)));
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    app.on('before-quit', () => {
      app.isQuitting = true;
      flushBrowserStorage(); // x.com/google oturumları (cookies) diske yazılsın
      try { toolsMod.disposeShellSessions(); } catch {} // kalıcı shell oturumlarını kapat
    });

    if (process.argv.includes('--smoke')) {
      win.webContents.on('did-finish-load', () => setTimeout(() => app.exit(0), 1500));
      setTimeout(() => app.exit(1), 15000);
    }
  });
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
    tray = new Tray(icon);
    tray.setToolTip('Beast Agent — arka planda çalışıyor');
    const menu = Menu.buildFromTemplate([
      { label: 'Beast\'i Göster', click: () => showWin() },
      { type: 'separator' },
      {
        label: 'Tamamen Kapat',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    tray.on('double-click', () => showWin());
  } catch {}
}

function showWin() {
  if (!win || win.isDestroyed()) createWindow();
  else {
    win.show();
    win.focus();
  }
}

/* ---------------- dahili tarayıcı ---------------- */

const BROWSER_TOOLBAR_H = 46;
const BROWSER_START_URL = 'https://www.google.com/';
/* TELEFON MODU: mobil UA + dar dock → sitelerin mobil versiyonu canlı izlenir;
   Expo/Metro dev sunucularında otomatik devreye girer */
const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
  process.versions.chrome +
  ' Mobile Safari/537.36';
/* Tarayıcı state: visible=false → ajanlar GİZLİ kullanır (headless);
   göz ikonuyla görünür mod açılır. open=view aktif, visible=panelde görünürlük */
const browser = { view: null, open: false, visible: false, width: 0, attached: false, started: false, phone: false, desktopUA: '' };

function browserEmit(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'browser', visible: browser.visible, phone: browser.phone, ...payload });
}

function browserWidthFor(w) {
  return Math.max(380, Math.min(800, Math.floor(w * 0.46)));
}

/* emit'lerdeki genişlik HEP gösterilen genişlik olmalı (telefon modunda 430) —
   yoksa yüklenme bitince dock eski genişliğine döner, daralan solda boşluk bırakır */
function browserW() {
  try { return win.getContentSize()[0]; } catch { return 0; }
}

function browserShownWidth(w) {
  const avail = Math.max(320, w - 320);
  /* TELEFON MODU: dock KENDİSİ daralır (~430px) — sayfa mobil düzenle
     kenarlara tam oturur; kapatınca kullanıcı genişliği geri gelir */
  return browser.phone ? Math.min(430, avail) : Math.min(browser.width, avail);
}

function layoutBrowser() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  /* GENİŞLİĞİ KALICI OLARAK EZME: kullanıcı tercih edilen genişliği korunsun.
     Küçük pencerede sadece GÖRÜNÜM kırpılır; büyüyünce tercih geri gelir.
     Tercih settings.json'da saklanır — uygulama kapansın/açılsın kaybolmaz. */
  if (!browser.width) {
    const saved = Math.round(Number(settings.browserWidth) || 0);
    browser.width = saved >= 300 ? saved : browserWidthFor(w);
  }
  const shownWidth = browserShownWidth(w);
  if (!browser.view || !browser.open) return;
  const view = browser.view;
  if (!browser.attached) {
    try {
      win.contentView.addChildView(view);
      browser.attached = true;
    } catch {}
  }
  try {
    view.setBounds({ x: Math.max(0, w - shownWidth), y: BROWSER_TOOLBAR_H, width: shownWidth, height: Math.max(0, h - BROWSER_TOOLBAR_H) });
    view.setVisible(browser.open && browser.visible);
  } catch {}
}

function ensureBrowser() {
  if (browser.view) return browser.view;
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:browser',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false, // gizli (headless) kullanımda da tam hız
      preload: path.join(__dirname, 'renderer', 'browserPreload.js'),
    },
  });
  view.setBackgroundColor(settings.theme === 'dark' ? '#0d0d0f' : '#ffffff');
  const wc = view.webContents;
  /* Google (ve bazı siteler) Electron UA'sını "güvenli olmayan tarayıcı / bilinmeyen
     cihaz" diyerek girişi engeller. Motor zaten aynı Chromium — gerçek Chrome
     kimliği takınıyoruz; böylece Google/X oturum açma sorunsuz çalışır. */
  try {
    const chromeUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
    const bses = session.fromPartition('persist:browser');
    if (bses && bses.setUserAgent) bses.setUserAgent(chromeUA, 'tr-TR,tr;q=0.9,en;q=0.8');
    wc.setUserAgent(chromeUA);
    browser.desktopUA = chromeUA;
    if (browser.phone) wc.setUserAgent(PHONE_UA); // telefon modu açıkken mobil UA ile doğ
  } catch {}
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) wc.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  // Tarayıcı kapalıyken olayların UI'ı geri açmamasını garantile
  const notify = (extra) => {
    if (browser.open && win && !win.isDestroyed()) {
      browserEmit({ open: true, width: browserShownWidth(browserW()), ...extra });
    }
  };
  wc.on('did-navigate', (_e, url) => notify({ url, loading: false }));
  wc.on('did-navigate-in-page', (_e, url) => notify({ url, loading: false }));
  wc.on('did-start-loading', () => notify({ loading: true }));
  wc.on('did-stop-loading', () => {
    let url = '';
    try { url = wc.getURL(); } catch {}
    notify({ url, loading: false });
  });
  wc.on('render-process-gone', () => {
    detachBrowser();
    browser.view = null;
  });
  browser.view = view;
  return view;
}

/* View'i her koşulda sök — bayrak ne olursa olsun */
function detachBrowser() {
  const view = browser.view;
  if (view) {
    try { view.setVisible(false); } catch {}
    if (win && !win.isDestroyed()) {
      try { win.contentView.removeChildView(view); } catch {}
    }
  }
  browser.attached = false;
}

function setBrowserOpen(v, forceVisible) {
  if (!win || win.isDestroyed()) return;
  const want = !!v;

  // KAPATMA: bayrak desync olsa bile view'i zorla sök
  if (!want) {
    const wasOpen = browser.open;
    browser.open = false;
    browser.visible = false;
    detachBrowser();
    browserEmit({ open: false });
    return;
  }

  // AÇMA — görünürlük: forceVisible true/false ise onu uygula;
  // belirtilmemişse kullanıcı tercihi (settings.browserHeadless) belirler.
  // PARALEL AJANLAR (bg oturum) her zaman forceVisible=false ile çağırır →
  // tarayıcı gizli modda çalışır, kullanıcı ekranı ve ajan konsolu rahatsız edilmez.
  browser.open = true;
  browser.visible =
    forceVisible === true ? true : forceVisible === false ? false : settings.browserHeadless !== true;
  ensureBrowser();
  if (!browser.started) {
    browser.started = true;
    browser.view.webContents.loadURL(BROWSER_START_URL).catch(() => {});
  }
  layoutBrowser();
  let url = '';
  try { url = browser.view.webContents.getURL(); } catch {}
  browserEmit({ open: true, width: browserShownWidth(browserW()), url });
}

/* --- Paralel ajan trafik düzeni: ajanlar aynı saniyede sorgu atınca Google
   "olağandışı trafik" uyarısı veriyor. Gezinme/arama isteklerini tek kuyrukta
   sıraya alıp aralarına min 1.2 sn + rastgele 0-600 ms jitter koyuyoruz.
   Kuyruğu tutan işin İÇİNDEN yapılan gezinmeler kapıyı atlar (kilitlenme olmaz). --- */
const BROWSER_TRAFFIC_GAP = 1200;
let __trafficLast = 0;
let __trafficTail = Promise.resolve();
function browserTrafficWait() {
  const wait = Math.max(0, __trafficLast + BROWSER_TRAFFIC_GAP + Math.floor(Math.random() * 600) - Date.now());
  __trafficLast = Date.now() + wait;
  return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
}
function browserGate(job) {
  const p = __trafficTail.then(job, job);
  __trafficTail = p.catch(() => {});
  return p;
}
/* AJAN TARAYICI STRATEJİSİ — TÜM oturumlar (ana sohbet + WhatsApp botları + paralel ajanlar):
   ajan tarayıcıyı KENDİ açıyorsa hep GİZLİ açılır — panel ekrana fırlamaz,
   Paralel Ajan Konsolu kapanmaz. Kullanıcı izlemek isterse tarayıcı düğmesine
   basar (browser:toggle gizli paneli görünür kılar). Zaten açıksa (kullanıcı
   paneli açık tutuyorsa) görünürlüğe dokunulmaz. */
function setBrowserOpenForAgent() {
  if (!browser.open) setBrowserOpen(true, false);
}

async function browserNavigate(raw, signal, ctx) {
  return browserGate(async () => {
    await browserTrafficWait();
    return browserNavigateNow(raw, signal, ctx);
  });
}

async function browserNavigateNow(raw, signal, ctx) {
  let url = String(raw || '').trim();
  if (!url) return { ok: false, error: 'boş adres' };
  if (!/^https?:\/\//i.test(url)) {
    // kelime ise arama, alan adıysa doğrudan aç
    url = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(url)
      ? 'https://' + url
      : 'https://duckduckgo.com/?q=' + encodeURIComponent(url);
  }
  setBrowserOpenForAgent();
  const wc = browser.view.webContents;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => { settled = true; clearTimeout(timer); cleanup(); resolve(); };
    const timer = setTimeout(finish, 25000);
    const onFail = (_e, code, desc) => { if (code !== -3 && !settled) finish(); };
    function cleanup() {
      clearTimeout(timer);
      wc.removeListener('did-finish-load', finish);
      wc.removeListener('did-fail-load', onFail);
    }
    wc.once('did-finish-load', finish);
    wc.on('did-fail-load', onFail);
    wc.loadURL(url).catch(() => {});
  });
  let title = '';
  let finalUrl = url;
  try { title = wc.getTitle(); finalUrl = wc.getURL() || url; } catch {}
  browserEmit({ open: true, width: browserShownWidth(browserW()), url: finalUrl });
  flushBrowserStorage(); // oturum çerezleri diske — ani kapanışta kaybolmasın
  /* açılışta snapshot da göm — model ayrı snapshot çağırmadan ref'lere başlar */
  let snap = null;
  try {
    const sraw = await wc.executeJavaScript(BROWSER_SNAPSHOT_JS, true);
    const sobj = JSON.parse(sraw);
    if (sobj && typeof sobj.count === 'number') snap = sobj;
  } catch {}
  return {
    ok: true,
    url: finalUrl,
    title,
    ...(snap
      ? { snapshot: snap.snapshot, refCount: snap.count, note: 'sayfa acildi — güncel snapshot hazır (' + snap.count + ' ref); ref numarasıyla browser_click/browser_type ile devam et' }
      : { note: 'sayfa acildi — etkileşimli elemanlar için browser_snapshot al' }),
  };
}

async function browserRead(signal) {
  if (!browser.view || !browser.open) return { ok: false, error: 'tarayıcı açık değil' };
  const wc = browser.view.webContents;
  try {
    const txt = await wc.executeJavaScript('(document.body&&document.body.innerText)||""', true);
    const t = String(txt || '').replace(/\n{3,}/g, '\n\n').trim();
    const url = wc.getURL();
    if (!t) return { ok: false, error: 'sayfa metni boş', url };
    const cap = 9000;
    return { ok: true, url, title: wc.getTitle(), truncated: t.length > cap, content: t.slice(0, cap) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* Oturum kalıcılığı: persist:browser bölümü cookies/localStorage'i diske yazar;
   ani app.exit() yollarında flush atlanmasın diye elle tetiklenir */
function flushBrowserStorage() {
  try {
    const s = session.fromPartition('persist:browser');
    if (s && s.flushStorageData) s.flushStorageData();
  } catch {}
}

/* ---------- GİZLİ ARAŞTIRMA TARAYICISI (deep_search) ----------
   deep_search'ün "sayfayı açıp oku" adımı burada çalışır: WebContentsView
   HİÇbir pencereye eklenmez (kullanıcı hiçbir şey görmez) ama gerçek Chromium
   çalışır — JS/SPA sayfalar render olur, innerText okunur. Panel (browser.view)
   hiç meşgul edilmez. Görsel/font/media indirme hız için iptal edilir.
   2 slot = en fazla 2 sayfa aynı anda okunur (ayrı view, çakışma yok). */
const researchPool = { views: [null, null], queue: [], slots: [false, false] };
const RESEARCH_PAGE_TIMEOUT = 25000;
const RESEARCH_SETTLE_MS = 900;
const RESEARCH_CONTENT_CAP = 4500;

function researchAcquire() {
  return new Promise((resolve) => {
    researchPool.queue.push(resolve);
    researchPump();
  });
}

function researchRelease(idx) {
  researchPool.slots[idx] = false;
  researchPump();
}

function researchPump() {
  for (let i = 0; i < researchPool.slots.length; i++) {
    if (!researchPool.slots[i] && researchPool.queue.length) {
      researchPool.slots[i] = true;
      researchPool.queue.shift()(i);
    }
  }
}

function researchViewAt(idx) {
  let v = researchPool.views[idx];
  if (v && v.webContents && !v.webContents.isDestroyed()) return v;
  v = new WebContentsView({
    webPreferences: {
      partition: 'research', // kalıcı olmayan bölüm — çerez birikmez
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false, // gizli çalışırken zamanlayıcılar yavaşlamasın
    },
  });
  const wc = v.webContents;
  try {
    /* Google/bazı siteler Electron UA'yı reddeder — gerçek Chrome kimliği */
    const chromeUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
    wc.setUserAgent(chromeUA);
    const ses = session.fromPartition('research');
    if (ses && ses.setUserAgent) ses.setUserAgent(chromeUA, 'tr-TR,tr;q=0.9,en;q=0.8');
  } catch {}
  try { wc.setWindowOpenHandler(() => ({ action: 'deny' })); } catch {}
  try {
    session.fromPartition('research').setPermissionRequestHandler((_w, _p, cb) => cb(false));
  } catch {}
  try {
    /* hız: araştırma okuması için görsel/font/media gereksiz — iptal et */
    session.fromPartition('research').webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
      cb({ cancel: ['image', 'media', 'font'].includes(details.resourceType) });
    });
  } catch {}
  try {
    session.fromPartition('research').on('will-download', (_e, item) => { try { item.cancel(); } catch {} });
  } catch {}
  wc.on('render-process-gone', () => { researchPool.views[idx] = null; });
  researchPool.views[idx] = v;
  return v;
}

async function researchRead(rawUrl, signal) {
  const url = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, url, error: 'geçersiz adres' };
  if (signal && signal.aborted) return { ok: false, url, error: 'iptal edildi' };
  const idx = await researchAcquire();
  try {
    const view = researchViewAt(idx);
    if (!view) return { ok: false, url, error: 'araştırma tarayıcısı oluşturulamadı' };
    const wc = view.webContents;
    const loaded = await new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); wc.removeListener('did-finish-load', onDone); wc.removeListener('did-fail-load', onFail); resolve(v); } };
      const timer = setTimeout(() => finish(false), RESEARCH_PAGE_TIMEOUT);
      const onDone = () => finish(true);
      const onFail = (_e, code) => { if (code !== -3) finish(false); };
      wc.once('did-finish-load', onDone);
      wc.on('did-fail-load', onFail);
      wc.loadURL(url).catch(() => {});
    });
    /* SPA hidrasyonu için kısa settle; metin boşsa bir kez daha dene */
    await new Promise((r) => setTimeout(r, RESEARCH_SETTLE_MS));
    let title = '';
    let finalUrl = url;
    try { title = wc.getTitle() || ''; finalUrl = wc.getURL() || url; } catch {}
    const grab = async () => {
      try { return String((await wc.executeJavaScript('(document.body&&document.body.innerText)||""', true)) || ''); } catch { return ''; }
    };
    let text = (await grab()).replace(/\n{3,}/g, '\n\n').trim();
    if (!text) {
      await new Promise((r) => setTimeout(r, 1500));
      text = (await grab()).replace(/\n{3,}/g, '\n\n').trim();
    }
    if (!text) {
      return { ok: false, url: finalUrl, title, error: loaded ? 'sayfa metni boş (tam JS-görsel veya engelli sayfa olabilir)' : 'sayfa yüklenemedi (zaman aşımı/hata)' };
    }
    return { ok: true, url: finalUrl, title, truncated: text.length > RESEARCH_CONTENT_CAP, content: text.slice(0, RESEARCH_CONTENT_CAP) };
  } catch (e) {
    return { ok: false, url, error: String((e && e.message) || e) };
  } finally {
    researchRelease(idx);
  }
}

/* Dahili OCR: görsel desteklemeyen modeller için tesseract.js ile metin okuma.
   Dil verisi ilk kullanımda %APPDATA%\beast\tessdata'ya iner, sonra offline çalışır. */
const _ocrWorkers = new Map(); // lang -> worker (her çağrıda yeniden init olmasın)
async function ocrRead({ image, lang = 'tur+eng' } = {}) {
  try {
    if (!image) return { ok: false, error: 'görüntü yok' };
    const t = require('tesseract.js');
    const langKey = String(lang || 'tur+eng');
    let worker = _ocrWorkers.get(langKey);
    if (!worker) {
      const tessDir = path.join(APP_DIR, 'tessdata');
      fs.mkdirSync(tessDir, { recursive: true });
      worker = await t.createWorker(langKey, 1, { cachePath: tessDir, logger: () => {} });
      _ocrWorkers.set(langKey, worker);
    }
    let input = image;
    if (typeof input === 'string' && input.startsWith('data:')) {
      input = Buffer.from(input.split(',')[1] || '', 'base64');
    }
    const { data } = await worker.recognize(input);
    const text = String((data && data.text) || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { ok: !!text, chars: text.length, text: text.slice(0, 8000), lang: langKey };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* Dahili tarayıcıyla arama (web_search'ün İLK adımı): gerçek Chromium +
   gerçek cookie'ler olduğu için Google bot koruması uygulamaz.
   aep=1 → AI Modu/AI Overview açık: Google cevabi hazırlanmış şekilde döner,
   hem AI metni ('ai' alanı) hem kaynak linkleri çekilir.
   Numara: view'i google.com'a bir kez açıp aramaları SAYFA İÇİ fetch() ile
   yapmak (kullanıcının console'da yaptığı gibi) — sayfa bile değişmeden
   DOMParser ile sonuç çekilir. Fetch olmazsa direk gezinme fallback'i var. */
async function browserSearch(query, signal, ctx) {
  /* paralel ajan sorguları trafik kapısından sırayla geçer */
  return browserGate(async () => {
    await browserTrafficWait();
    return browserSearchNow(query, signal, ctx);
  });
}

async function browserSearchNow(query, signal, ctx) {
  try {
    if (!win || win.isDestroyed()) return null;
    if (signal && signal.aborted) return null;
    const q = String(query || '').trim();
    if (!q) return null;
    setBrowserOpenForAgent();
    const wc = browser.view && browser.view.webContents;
    if (!wc) return null;

    /* fetch() same-origin olsun diye önce google.com kökü yüklü olsun */
    let cur = '';
    try { cur = wc.getURL() || ''; } catch {}
    if (!cur.startsWith('https://www.google.com')) {
      await browserNavigateNow('https://www.google.com/', signal);
    }
    if (!browser.view || !browser.open) return null;

    const fetchJs = `(async () => {
      const q = ${JSON.stringify(q)};
      const AI_SEL = ['#m-x-content', '[data-attrid="wa:/ai/action"]', 'div.WaaZC', '[data-mcpr]', 'div[data-iap]'];
      const squash = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
      const aiText = (doc) => {
        for (const s of AI_SEL) {
          const el = doc.querySelector(s);
          const t = squash(el && el.textContent);
          if (t.length > 80) return t.slice(0, 3500);
        }
        const first = doc.querySelector('#rso > div, #search > div');
        if (first && !first.querySelector('h3')) {
          const t = squash(first.textContent);
          if (t.length > 120) return t.slice(0, 3500);
        }
        return '';
      };
      const extract = (doc) => {
        const out = [];
        const seen = new Set();
        const nodes = doc.querySelectorAll('#search div.g, #rso > div, #search div[data-sokoban-container], div.g');
        for (const el of nodes) {
          if (out.length >= 10) break;
          const h3 = el.querySelector('a[href] h3');
          if (!h3 || !h3.parentElement) continue;
          const link = h3.parentElement;
          let url = link.getAttribute('href') || '';
          const title = (h3.textContent || '').trim();
          if (!title || !url) continue;
          try { url = new URL(url, 'https://www.google.com').toString(); } catch (e) { continue; }
          if (!url.startsWith('http')) continue;
          if (url.includes('google.com/url?')) {
            try { url = new URL(url).searchParams.get('q') || url; } catch (e) {}
          }
          const key = url.split('#')[0];
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const sn = el.querySelector('.VwiC3b, div[data-sncf], .IsZvec');
          out.push({ title, url, snippet: squash(sn && sn.textContent).slice(0, 300), engine: 'browser-google' });
        }
        return out;
      };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 3; i++) {
        try {
          const res = await fetch('/search?q=' + encodeURIComponent(q) + '&num=10&hl=tr&pws=0&aep=1', { credentials: 'include' });
          if (res.ok) {
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const rows = extract(doc);
            const ai = aiText(doc);
            if (rows.length || ai) return JSON.stringify({ ai, rows });
          }
        } catch (e) {}
        await sleep(600);
      }
      return JSON.stringify({ ai: '', rows: [] });
    })()`;
    let raw = '';
    try { raw = await wc.executeJavaScript(fetchJs, true); } catch {}
    let parsed = { ai: '', rows: [] };
    try { parsed = JSON.parse(raw || '{}'); } catch {}
    let results = parsed.rows || [];

    /* fallback: fetch yerine direk gezinme + DOM'dan çek */
    if (!results.length) {
      await browserNavigateNow(
        'https://www.google.com/search?q=' + encodeURIComponent(q) + '&num=10&hl=tr&pws=0&aep=1',
        signal
      );
      const navJs = `(async () => {
        const AI_SEL = ['#m-x-content', '[data-attrid="wa:/ai/action"]', 'div.WaaZC', '[data-mcpr]', 'div[data-iap]'];
        const squash = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
        const aiText = () => {
          for (const s of AI_SEL) {
            const el = document.querySelector(s);
            const t = squash(el && el.textContent);
            if (t.length > 80) return t.slice(0, 3500);
          }
          const first = document.querySelector('#rso > div, #search > div');
          if (first && !first.querySelector('h3')) {
            const t = squash(first.textContent);
            if (t.length > 120) return t.slice(0, 3500);
          }
          return '';
        };
        const extract = () => {
          const out = [];
          const seen = new Set();
          const nodes = document.querySelectorAll('#search div.g, #rso > div, #search div[data-sokoban-container], div.g');
          for (const el of nodes) {
            if (out.length >= 10) break;
            const h3 = el.querySelector('a[href^="http"] h3');
            if (!h3 || !h3.parentElement) continue;
            const link = h3.parentElement;
            let url = link.href || '';
            const title = (h3.textContent || '').trim();
            if (!title || !url.startsWith('http')) continue;
            if (url.includes('google.com/url?')) {
              try { url = new URL(url).searchParams.get('q') || url; } catch (e) {}
            }
            const key = url.split('#')[0];
            if (!key || seen.has(key)) continue;
            seen.add(key);
            const sn = el.querySelector('.VwiC3b, div[data-sncf], .IsZvec');
            out.push({ title, url, snippet: squash(sn && sn.textContent).slice(0, 300), engine: 'browser-google' });
          }
          return out;
        };
        for (let i = 0; i < 8; i++) {
          const rows = extract();
          const ai = aiText();
          if (rows.length || ai) return JSON.stringify({ ai, rows });
          await new Promise((res) => setTimeout(res, 700));
        }
        return JSON.stringify({ ai: '', rows: [] });
      })()`;
      try { raw = await wc.executeJavaScript(navJs, true); } catch {}
      try { parsed = JSON.parse(raw || '{}'); } catch {}
      results = parsed.rows || [];
    }

    if (!results.length && !parsed.ai) {
      /* CAPTCHA / olağandışı trafik sinyali — zincir TinyFish'e kaymalı */
      let blocked = false;
      try { blocked = /google\.com\/sorry/i.test(wc.getURL() || ''); } catch {}
      return blocked
        ? { ok: false, blocked: true, engine: 'browser-google', query: q, error: 'unusual traffic (CAPTCHA)' }
        : null;
    }
    flushBrowserStorage();
    const out = { ok: true, engine: 'browser-google', query: q, results };
    if (parsed.ai) out.ai = parsed.ai;
    return out;
  } catch {
    return null;
  }
}

async function browserScreenshot(signal) {
  if (!browser.view || !browser.open) return { ok: false, error: 'tarayıcı açık değil' };
  const wc = browser.view.webContents;
  try {
    const img = await wc.capturePage();
    let out = img;
    const sz = img.getSize();
    const maxW = 1000; // vision bütçesi için küçült
    if (sz.width > maxW) out = img.resize({ width: maxW });
    const jpeg = out.toJPEG(72);
    if (!jpeg || !jpeg.length) return { ok: false, error: 'görüntü alınamadı' };
    return {
      ok: true,
      note: 'ekran görüntüsü bir sonraki adımda sana gösterilecek',
      __injectImage: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
      url: wc.getURL(),
      title: wc.getTitle(),
      bytes: jpeg.length,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

const BROWSER_JS_HELPERS = `
  function __vis(el){const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';}
  function __label(e){
    const al=e.getAttribute&&(e.getAttribute('aria-label')||e.getAttribute('title')||e.getAttribute('placeholder'));
    const txt=(e.innerText||e.value||'').trim().replace(/\\s+/g,' ');
    return String(al||txt||'').slice(0,60);
  }
  function __resolve(sel){
    if(!sel) return null;
    if(sel.indexOf('text=')===0){
      const t=sel.slice(5).trim().toLowerCase();
      const els=[...document.querySelectorAll('a,button,[role="button"],input[type="submit"],input[type="button"],summary,label,li,td,th,span,div,p,h1,h2,h3,h4')];
      let el=els.find(e=>__vis(e)&&e.innerText&&e.innerText.trim().toLowerCase()===t)
           ||els.find(e=>__vis(e)&&e.innerText&&e.innerText.trim().toLowerCase().includes(t));
      if(el) el=el.closest('a,button,[role="button"],summary,label')||el;
      return el||null;
    }
    return document.querySelector(sel);
  }
  function __resolveRef(n){
    n=Number(n);
    const m=window.__beMap;
    if(!m||!m[n]) return null;
    const el=m[n];
    return (el&&el.isConnected)?el:null;
  }
`;

const BROWSER_SNAPSHOT_JS = `(function(){
  ${BROWSER_JS_HELPERS}
  const sel='a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="tab"],[role="option"],[role="menuitem"],[role="gridcell"],[role="checkbox"],[role="switch"],[role="combobox"],[role="textbox"],[role="searchbox"],[contenteditable="true"],summary';
  /* açık popup/takvim/dialog varsa içindekiler ÖNCE listelenir (tarih seçici, özel dropdown vb.) */
  const popSel='[role="dialog"],dialog,[role="listbox"],[role="menu"],.flatpickr-calendar,.ui-datepicker,[class*="datepicker" i],[class*="calendar" i],[class*="dropdown" i],[class*="popup" i]';
  const pops=[...document.querySelectorAll(popSel)].filter(__vis);
  const inPop=new Set();
  for(const p of pops){[...p.querySelectorAll(sel)].forEach(e=>inPop.add(e));}
  window.__beMap={};
  const seen=new Set();
  const lines=[];
  let i=0;
  function add(e){
    if(!e||seen.has(e)) return;
    seen.add(e);
    if(!__vis(e)||e.disabled||e.getAttribute('aria-disabled')==='true') return;
    i++;
    window.__beMap[i]=e;
    const tag=e.tagName.toLowerCase();
    const type=(e.getAttribute&&e.getAttribute('type'))||'';
    let s='['+i+'] <'+tag+(type?' type='+type:'')+'>';
    const l=__label(e);
    if(l) s+=' "'+l+'"';
    if(tag==='input'&&/^(text|email|password|search|tel|url|number|date|time|month|datetime-local)$/.test(type)&&e.value) s+=' deger="'+String(e.value).slice(0,30)+'"';
    if(tag==='select'){s+=' secenekler=['+[...e.options].slice(0,6).map(o=>o.text.trim()).filter(Boolean).join('|').slice(0,60)+']';}
    lines.push(s);
  }
  if(inPop.size){
    lines.push('--- ACIK POPUP/TAKVIM ICINDEKILER (once bunlari kullan) ---');
    for(const e of inPop){ add(e); if(i>=60) break; }
    lines.push('--- SAYFA ---');
  }
  for(const e of document.querySelectorAll(sel)){ if(i>=100) break; add(e); }
  return JSON.stringify({count:i,title:document.title,url:location.href,snapshot:lines.join('\\n')});
})()`;

function browserActionJs(kind, args) {
  const sel = JSON.stringify(String(args.selector || ''));
  const ref = JSON.stringify(args.ref === undefined ? null : Number(args.ref));

  const resolveTarget = `
    function __target(){
      if(${ref}!==null){
        const el=__resolveRef(${ref});
        return el?{el,how:'ref['+${ref}+']'}:null;
      }
      const el=__resolve(${sel});
      return el?{el,how:'selector'}:null;
    }`;

  if (kind === 'click') {
    return `(function(){${BROWSER_JS_HELPERS}${resolveTarget};return new Promise((res)=>{try{
      const t=__target();
      if(!t) return res(JSON.stringify({clicked:false,reason:'eleman bulunamadi (ref eski olabilir - browser_snapshot al)'}));
      const how=t.how,el=t.el;
      el.scrollIntoView({block:'center'});
      setTimeout(()=>{try{
        el.click();
        res(JSON.stringify({clicked:true,target:how+' <'+el.tagName.toLowerCase()+'> "'+__label(el)+'"'}));
      }catch(e){res(JSON.stringify({clicked:false,reason:String(e)}));}},80);
    }catch(e){res(JSON.stringify({clicked:false,reason:String(e)}));}});})()`;
  }
  if (kind === 'type') {
    const text = JSON.stringify(String(args.text ?? ''));
    const submit = args.submit ? 'true' : 'false';
    return `(function(){${BROWSER_JS_HELPERS}${resolveTarget}
      /*__DT_HELPERS_START__*/
      function __norm(s){return String(s).toLowerCase().split('').map(function(c){return {'ş':'s','ğ':'g','ü':'u','ı':'i','ö':'o','ç':'c','İ':'i'}[c]||c;}).join('');}
      function __parseDate(raw){
        raw=String(raw||'').trim(); if(!raw) return null;
        const MON={ocak:1,subat:2,mart:3,nisan:4,mayis:5,haziran:6,temmuz:7,agustos:8,eylul:9,ekim:10,kasim:11,aralik:12,jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,january:1,february:2,march:3,april:4,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
        let m=raw.match(/^(\\d{4})[\\-.\\/,](\\d{1,2})[\\-.\\/,](\\d{1,2})$/);
        if(m) return [+m[1],+m[2],+m[3]];
        m=raw.match(/^(\\d{1,2})[\\-.\\/ ](\\d{1,2})[\\-.\\/ ](\\d{2,4})$/);
        if(m){let d=+m[1],mo=+m[2],y=+m[3];if(y<100)y+=2000;if(mo>12&&d<=12){const t=d;d=mo;mo=t;}return [y,mo,d];}
        m=raw.match(/^(\\d{1,2})[\\-.\\/ ]+([a-zçğıöşü]+)[\\-.\\/ ]+(\\d{2,4})$/i);
        if(m){const mo=MON[__norm(m[2])];if(mo){let y=+m[3];if(y<100)y+=2000;return [y,mo,+m[1]];}}
        return null;
      }
      function __parseTime(raw){
        const m=String(raw||'').trim().match(/^(\\d{1,2})[:.h](\\d{2})/);
        if(!m) return null;
        return [Math.min(23,+m[1]),Math.min(59,+m[2])];
      }
      /*__DT_HELPERS_END__*/
      return new Promise((res)=>{try{
      const t=__target();
      if(!t) return res(JSON.stringify({typed:false,reason:'eleman bulunamadi (ref eski olabilir - browser_snapshot al)'}));
      const how=t.how,el=t.el;
      /* tarih/saat alanları: programatik değer + input/change event — native takvim popup'ı hiç açılmaz */
      const it=(el.tagName==='INPUT'?(el.type||'').toLowerCase():'');
      if(it==='date'||it==='month'||it==='time'||it==='datetime-local'){
        const RAW=${text};
        let v=null;
        if(it==='time'){
          const p=__parseTime(RAW); if(p) v=p.map(function(n){return String(n).padStart(2,'0');}).join(':');
        } else {
          const p=__parseDate(RAW);
          if(p&&p.every(Number.isFinite)&&p[1]>=1&&p[1]<=12&&p[2]>=1&&p[2]<=31){
            const pad=function(n){return String(n).padStart(2,'0');};
            const ymd=p[0]+'-'+pad(p[1])+'-'+pad(p[2]);
            v = it==='month' ? (p[0]+'-'+pad(p[1])) : it==='datetime-local' ? (ymd+'T'+((__parseTime(RAW)||[12,0])).map(pad).join(':')) : ymd;
          }
        }
        if(!v) return res(JSON.stringify({typed:false,inputType:it,reason:'tarih/saat alanı — metin anlaşılamadı. "2026-03-15", "15.03.2026" veya "15 Mart 2026" gibi gönder'}));
        const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
        setter.call(el,v);
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
        return res(JSON.stringify({typed:true,target:how+' <input type='+it+'>',value:v,note:'tarih/saat programatik ayarlandi — takvim tiklamak gerekmez'}));
      }
      el.scrollIntoView({block:'center'});el.focus();
      setTimeout(()=>{try{
        if(el.isContentEditable){el.textContent=${text};}
        else{
          const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
          const setter=Object.getOwnPropertyDescriptor(proto,'value').set;
          setter.call(el,${text});
          el.dispatchEvent(new Event('input',{bubbles:true}));
          el.dispatchEvent(new Event('change',{bubbles:true}));
        }
        const done=()=>res(JSON.stringify({typed:true,target:how+' <'+el.tagName.toLowerCase()+'>',value:${text}}));
        if(${submit}){
          el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true}));
          const form=el.closest('form');
          if(form&&typeof form.requestSubmit==='function'){setTimeout(()=>{try{form.requestSubmit();}catch(e){}done();},40);}
          else{setTimeout(done,40);}
        } else done();
      }catch(e){res(JSON.stringify({typed:false,reason:String(e)}));}},60);
    }catch(e){res(JSON.stringify({typed:false,reason:String(e)}));}});})()`;
  }
  if (kind === 'press') {
    const key = JSON.stringify(String(args.key || 'Enter'));
    const refFocus = JSON.stringify(args.ref === undefined ? null : Number(args.ref));
    return `(function(){${BROWSER_JS_HELPERS}
      const KEY=${key};
      const map={Enter:['Enter','Enter',13],Tab:['Tab','Tab',9],Escape:['Escape','Escape',27],ArrowDown:['ArrowDown','ArrowDown',40],ArrowUp:['ArrowUp','ArrowUp',38],PageDown:['PageDown','PageDown',34],PageUp:['PageUp','PageUp',33]};
      const m=map[KEY]||[KEY,KEY,(KEY.charCodeAt(0)||0)];
      let el=null;
      try{const r=${refFocus};if(r!==null&&window.__beMap&&window.__beMap[r])el=window.__beMap[r];}catch(e){}
      el=(el&&el.isConnected)?el:(document.activeElement||document.body);
      ['keydown','keypress','keyup'].forEach(t=>el.dispatchEvent(new KeyboardEvent(t,{key:m[0],code:m[1],keyCode:m[2],which:m[2],bubbles:true,cancelable:true})));
      return JSON.stringify({pressed:KEY,focused:(el.tagName||'').toLowerCase(),url:location.href});
    })()`;
  }
  if (kind === 'scroll') {
    const dir = args.direction === 'up' ? -1 : 1;
    const amount = JSON.stringify(Number(args.amount) || 0);
    return `(function(){
      const d=${dir};const a=${amount}||Math.round(window.innerHeight*0.9);
      window.scrollBy({top:d*a,behavior:'instant'});
      return JSON.stringify({scrolled:true,y:Math.round(window.scrollY),max:Math.round(document.documentElement.scrollHeight-window.innerHeight)});
    })()`;
  }
  if (kind === 'select') {
    const value = JSON.stringify(String(args.value ?? ''));
    return `(function(){${BROWSER_JS_HELPERS}${resolveTarget};return new Promise((res)=>{try{
      const t=__target();
      if(!t) return res(JSON.stringify({selected:false,reason:'eleman bulunamadi'}));
      const el=t.el;
      if(el.tagName!=='SELECT') return res(JSON.stringify({selected:false,reason:'bu eleman bir select degil: '+el.tagName}));
      const want=String(${value}).trim().toLowerCase();
      let opt=[...el.options].find(o=>o.value.toLowerCase()===want)||[...el.options].find(o=>o.text.trim().toLowerCase()===want)||[...el.options].find(o=>o.text.trim().toLowerCase().includes(want));
      if(!opt) return res(JSON.stringify({selected:false,reason:'secenek bulunamadi',options:[...el.options].map(o=>o.text.trim()).slice(0,20)}));
      el.value=opt.value;
      el.dispatchEvent(new Event('change',{bubbles:true}));
      res(JSON.stringify({selected:true,target:t.how,value:opt.text.trim()}));
    }catch(e){res(JSON.stringify({selected:false,reason:String(e)}));}});})()`;
  }
  return `JSON.stringify({ok:false,error:'bilinmeyen eylem'})`;
}

/* eylem günlüğü — her yanıtın sonuna son hamleler eklenir */
function blog(kind, detail) {
  if (!Array.isArray(browser.history)) browser.history = [];
  browser.history.push({
    t: new Date().toISOString().slice(11, 19),
    kind,
    detail: String(detail || '').slice(0, 120),
  });
  if (browser.history.length > 40) browser.history.shift();
}

function recentLog() {
  return Array.isArray(browser.history) ? browser.history.slice(-6) : [];
}

async function browserSnapshot(signal) {
  if (!browser.view || !browser.open) return { ok: false, error: 'tarayıcı açık değil' };
  const wc = browser.view.webContents;
  try {
    const raw = await wc.executeJavaScript(BROWSER_SNAPSHOT_JS, true);
    const obj = JSON.parse(raw);
    blog('snapshot', obj.title + ' — ' + obj.count + ' eleman');
    return {
      ok: true,
      url: obj.url,
      title: obj.title,
      count: obj.count,
      snapshot: obj.snapshot,
      note: 'eylemlerde ref numarasini kullan (orn: browser_click {ref:3})',
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function browserAct(kind, args, signal) {
  if (!browser.view || !browser.open) return { ok: false, error: 'tarayıcı açık değil' };
  const wc = browser.view.webContents;
  try {
    const raw = await wc.executeJavaScript(browserActionJs(kind, args || {}), true);
    let obj = {};
    try { obj = JSON.parse(raw); } catch { obj = { result: String(raw).slice(0, 300) }; }

    // tıklama/form gönderimi sonrası kısa gezinme bekleme
    let navigated = false;
    if (kind === 'click' || (kind === 'type' && args && args.submit) || kind === 'press') {
      await new Promise((resolve) => {
        let done = false;
        const onNav = () => { navigated = true; setTimeout(fin, 400); };
        const fin = () => { if (!done) { done = true; clearTimeout(t); wc.removeListener('did-navigate', onNav); resolve(); } };
        const t = setTimeout(fin, 1800);
        wc.on('did-navigate', onNav);
      });
    }

    blog(
      kind,
      obj.clicked ? obj.target
        : obj.typed ? ('"' + obj.value + '" → ' + obj.target)
        : obj.selected ? ('"' + obj.value + '" seçildi')
        : obj.pressed ? ('tuş ' + obj.pressed)
        : obj.scrolled ? ('kaydır y=' + obj.y)
        : (obj.reason || 'tamam')
    );

    /* HIZ: eylem cevabına taze snapshot göm — model ayrı browser_snapshot çağırmaz (tur sayısı yarıya iner) */
    let freshSnap = null;
    try {
      const sraw = await wc.executeJavaScript(BROWSER_SNAPSHOT_JS, true);
      const sobj = JSON.parse(sraw);
      if (sobj && typeof sobj.count === 'number') freshSnap = sobj;
    } catch {}

    return {
      ok: true,
      action: kind,
      ...obj,
      url: wc.getURL(),
      title: wc.getTitle(),
      navigated,
      ...(freshSnap ? { snapshot: freshSnap.snapshot, refCount: freshSnap.count } : {}),
      ...(navigated
        ? { note: 'sayfa degisti — yanıtta güncel snapshot var; refler eskiyse yeni browser_snapshot al' }
        : freshSnap
          ? { note: 'yanıtta güncel snapshot (' + freshSnap.count + ' ref) — sonraki hamlede bunları kullan, ayrıca snapshot alma' }
          : {}),
      recent: recentLog(),
    };
  } catch (e) {
    return { ok: false, action: kind, error: String((e && e.message) || e), recent: recentLog() };
  }
}

/* oturum açılışında --hidden ile başlarsa pencere gösterme, tepside yaşa */
const startHidden =
  process.argv.includes('--hidden') ||
  process.argv.includes('--silent') ||
  String(process.env.BEAST_HIDDEN || '') === '1';

/* Splash: npm/ portable başlangıcında logolu karşılama penceresi — ana pencere
   hazır olunca kapanır. */
let splash = null;

function createSplash() {
  try {
    const dark = settings.theme === 'dark';
    const bg = dark ? '#0d0d0f' : '#f7f7f8';
    const fg = dark ? '#f2f2f4' : '#17171a';
    const muted = dark ? '#9a9aa2' : '#707078';
    splash = new BrowserWindow({
      width: 420,
      height: 352,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      center: true,
      backgroundColor: bg,
      icon: path.join(__dirname, '..', 'assets', 'app.ico'),
    });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${bg};font-family:'Segoe UI',sans-serif;color:${fg}}
      .logo{width:84px;height:84px;border-radius:20px;background:${fg};color:${bg};display:flex;align-items:center;justify-content:center;font-weight:900;font-size:44px}
      .t{margin-top:16px;font-size:20px;color:${fg}}.t b{font-weight:900}
      .v{margin-top:8px;font-size:12.5px;font-weight:800;letter-spacing:.6px;color:${muted};background:${muted}22;padding:2px 12px;border-radius:9px}
      .s{margin-top:6px;font-size:12px;color:${muted}}
      .cmds{margin-top:14px;display:flex;flex-wrap:wrap;gap:6px;justify-content:center;max-width:360px}
      .cmds b{font-size:11.5px;font-weight:800;color:${fg};background:${muted}22;padding:2px 9px;border-radius:6px;letter-spacing:.3px}
      .cmds span{font-size:11.5px;color:${muted};align-self:center}
      .bar{margin-top:18px;width:180px;height:3px;background:${muted}44;border-radius:2px;overflow:hidden}
      .bar>i{display:block;height:100%;width:40%;background:${fg};border-radius:2px;animation:sw 1.1s ease-in-out infinite}
      @keyframes sw{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
    </style></head><body>
      <div class="logo">B</div>
      <div class="t"><b>BEAST</b> Agent</div>
      <div class="v">v${beastVersion()}</div>
      <div class="s">hızlı · hafif · becerikli</div>
      <div class="cmds">
        <b>/help</b><b>/version</b><b>/restart</b><b>/change</b><b>/think</b><b>/clear</b><b>/stop</b><b>/usage</b><b>/backup</b><b>/status</b><span>…</span>
      </div>
      <div class="bar"><i></i></div>
    </body></html>`;
    splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  } catch {}
}

function closeSplash() {
  try { if (splash) { splash.close(); splash = null; } } catch {}
}

function createWindow() {
  log.info('main', 'Pencere oluşturuluyor…');
  const dark = settings.theme === 'dark';
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 500,
    show: false,
    backgroundColor: dark ? '#0d0d0f' : '#f7f7f8',
    icon: path.join(__dirname, '..', 'assets', 'app.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      /* transparent Windows'ta beyaz buton arka planı veriyor — tema rengiyle başlat */
      color: dark ? '#0d0d0f' : '#f7f7f8',
      symbolColor: dark ? '#9a9aa2' : '#707078',
      height: 46,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    closeSplash();
    if (startHidden) win.hide();
    else {
      win.show();
      win.focus();
      /* emniyet: bazı başlatma yollarında ilk show yutulur — tekrar dene */
      setTimeout(() => {
        try { if (win && !win.isDestroyed() && !win.isVisible()) { win.show(); win.focus(); } } catch {}
      }, 1200);
    }
  });
  win.on('resize', layoutBrowser);
  win.on('maximize', layoutBrowser);
  win.on('unmaximize', layoutBrowser);
  win.on('show', layoutBrowser);
  // X'e basınca gizle — tepside yaşamaya devam, WhatsApp bağlantısı sürer
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

/* ---------------- IPC ---------------- */

ipcMain.handle('app:state', () => engine.publicState());
/* Ayarlar penceresi altında küçük sürüm etiketi (ör. v1.4.2) */
ipcMain.handle('app:version', () => beastVersion());

/* #3 log sistemi: ayarlar → Log sekmesinde görüntülenir */
ipcMain.handle('logs:get', () => {
  try { return { dir: log.dir(), lines: log.tail(600) }; } catch (e) { return { dir: '', lines: [], error: String(e && e.message || e) }; }
});
ipcMain.handle('logs:clear', () => {
  try { log.clear(); } catch {}
  return { ok: true };
});

ipcMain.handle('sessions:list', () => engine.listSessions());
ipcMain.handle('sessions:create', () => {
  const v = engine.createSession();
  /* aktif bota bağla — masaüstü UI'ı hangi bottaysa yeni sohbet o bota açılır */
  const bid = settings.activeBotId && bots.get(settings.activeBotId) ? settings.activeBotId : 'beast';
  engine.setSessionBot(v.id, bid);
  const b = bots.get(bid);
  if (b && !b.admin) {
    engine.setSessionPerm(v.id, b.perm || 'all');
    engine.setSessionTools(v.id, botToolSet(b));
  } else {
    engine.setSessionTools(v.id, null);
  }
  engine.setSessionModel(v.id, b && !b.admin ? (b.model || null) : null);
  return v;
});
ipcMain.handle('sessions:open', (_e, id) => engine.openSession(id));
ipcMain.handle('sessions:delete', (_e, id) => engine.deleteSession(id));

ipcMain.handle('agent:send', (_e, { sessionId, text }) => {
  const raw = text && typeof text === 'object' ? String(text.text || '') : String(text ?? '');
  const t = raw.trim();
  /* BOT HAFIZA GARANTİSİ: aktif bot bir MÜŞTERİ botuysa, botId'siz (eskiden
     kalma) oturumlar bu bota bağlanır — bot konuşması asla Beast'in global
     hafızasıyla (SOUL/USER/MEMORY) yürümez. Var olan botId asla üstüne yazılmaz. */
  try {
    const sid = String(sessionId || '');
    const actBot = settings.activeBotId ? bots.get(settings.activeBotId) : null;
    if (sid && actBot && !actBot.admin) {
      let sess = engine.cache.get(sid);
      if (!sess) {
        try { sess = engine._load(sid); } catch {}
      }
      if (sess && !sess.botId) {
        engine.setSessionBot(sid, actBot.id);
        /* tam bağlama: izin + araç seti + botun kendi modeli (sessions:create ile aynı) */
        engine.setSessionPerm(sid, actBot.perm || 'all');
        engine.setSessionTools(sid, botToolSet(actBot));
        engine.setSessionModel(sid, actBot.model || null);
      }
    }
  } catch {}
  if (t === '/stop' || t === '/start') {
    handleGlobalStopStart(sessionId, t);
    return true;
  }
  if (t === '/restart') {
    handleRestart(sessionId);
    return true;
  }
  if (t === '/version') {
    desktopEcho(sessionId, t, `**Beast Agent v${beastVersion()}**\nGüncelleme: **/update** (yeni sürüm kontrolü) · **/update now** (hemen kur)`);
    return true;
  }
  if (t === '/help') {
    desktopEcho(sessionId, '/help', desktopSlashHelp());
    return true;
  }
  if (t === '/rules') {
    const rs = memory.listRules();
    desktopEcho(sessionId, t, rs.length ? '**Kalıcı kurallar:**\n' + rs.map((r0, i) => `${i + 1}. ${r0}`).join('\n') : 'Kalıcı kural yok — ekle: **/rule <metin>**');
    return true;
  }
  if (t === '/rule' || t.startsWith('/rule ')) {
    const arg = t.slice(5).trim();
    if (!arg) {
      desktopEcho(sessionId, t, 'Kullanım: **/rule <metin>** — kalıcı kural ekler');
    } else {
      memory.addRule(arg);
      desktopEcho(sessionId, t, '**Kural eklendi:** ' + arg);
    }
    return true;
  }
  if (t === '/model' || t.startsWith('/model ')) {
    const arg = t.slice(6).trim();
    const st = engine.publicState();
    if (arg) {
      const hit = st.models.find(
        (m) => m.sel === arg || m.model.toLowerCase().includes(arg.toLowerCase()) || m.providerName.toLowerCase().includes(arg.toLowerCase())
      );
      if (hit) {
        settings.modelOverride = hit.sel;
        saveSettings();
        engine.setModelOverride(hit.sel);
        const st2 = engine.publicState();
        desktopEcho(sessionId, t, st2.activeModel ? `**Model değişti:** ${st2.activeModel.providerName} · ${st2.activeModel.model}` : '**Model değişti.**');
        if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'modelChanged', sessionId: String(sessionId || '') });
      } else {
        desktopEcho(sessionId, t, 'Eşleşen model yok — **/change** ile listeye bak.');
      }
    } else {
      desktopEcho(sessionId, t, st.activeModel ? `**Aktif model:** ${st.activeModel.providerName} · ${st.activeModel.model}\nDeğiştirmek için: **/model <isim-parçası>**` : 'Model seçilmemiş.');
    }
    return true;
  }
  if (t === '/usage') {
    const rep = usageMod.report();
    const f = (r) => `${r.calls} çağrı · ${fmtNum(r.pin)}+${fmtNum(r.pout)} token${r.cost ? ' · ~$' + r.cost.toFixed(4) : ''}`;
    desktopEcho(sessionId, t, `**Bugün:** ${f(rep.today.total)}\n**Bu ay:** ${f(rep.month.total)}\n\nDetay: Ayarlar → Maliyet`);
    return true;
  }
  if (t === '/backup') {
    desktopEcho(sessionId, t, '**Yedek alınıyor…** (şifreli .beastbak — Masaüstü\\Beast-Backups)');
    createBackup().then((r) => {
      desktopEcho(
        sessionId,
        '/backup',
        r.ok
          ? `**Şifreli yedek alındı**\n${r.path}\n(${Math.round(r.size / 1024)} KB)\nBeast Kodu: \`${r.code}\``
          : 'Yedek hata: ' + (r.error || '?')
      );
    });
    return true;
  }
  if (t === '/status') {
    const wst = wa ? wa.snapshot() : { status: 'disconnected' };
    const jobs = cron.list().filter((j) => j.enabled).length;
    desktopEcho(sessionId, t, `**WA:** ${wst.status}${wst.user ? ' (' + wst.user + ')' : ''}\n**İzleyici:** ${watchers.list().length} adet\n**Cron:** ${jobs} aktif görev`);
    return true;
  }
  if (t === '/think' || t.startsWith('/think ')) {
    const arg = t.slice(6).trim();
    const r = arg ? applyThinkLevel(arg) : null;
    desktopEcho(sessionId, t, r && r.error ? r.error : r ? r.text : thinkStatusText());
    return true;
  }
  if (t === '/agent' || t.startsWith('/agent ')) {
    /* opencode agent port: özel ajan tanımları (%APPDATA%\beast\agents\*.md) */
    const arg = t.slice(6).trim();
    if (!arg) {
      const list = engine.listAgents();
      desktopEcho(
        sessionId,
        t,
        list.length
          ? '**Özel ajanlar:**\n' + list.map((d) => `- **${d.name}**${d.model ? ' · ' + d.model : ''}${d.steps ? ' · ' + d.steps + ' tur' : ''}${d.tools ? ' · ' + d.tools.length + ' araç' : ''}`).join('\n') + '\n\nBağlamak için: **/agent <isim>** · ayırmak için: **/agent off**'
          : 'Özel ajan yok — `%APPDATA%\\beast\\agents\\` klasörüne `<isim>.md` tanımı koy (örnek dosya orada).'
      );
      return true;
    }
    const r = engine.setSessionAgent(sessionId, arg);
    desktopEcho(
      sessionId,
      t,
      r.ok
        ? r.agent
          ? `**Ajan bağlandı: ${r.agent}**${r.model ? ' · model: ' + r.model : ''}${r.steps ? ' · ' + r.steps + ' tur' : ''}${r.tools ? ' · araçlar: ' + r.tools.join(', ') : ''}`
          : '**Ajan bağlantısı kaldırıldı** — oturum normal akışa döndü.'
        : r.error
    );
    return true;
  }
  if (t === '/clear') {
    /* #25 artık GERÇEK silme: oturum dosyasındaki mesajlar + notlar silinir,
       kod/meta/todolar korunur. Ekran da temizlenir ('clear' olayı). */
    const ok = engine.clearMessages(String(sessionId || ''));
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:event', { sessionId: String(sessionId || ''), type: 'clear' });
    }
    desktopEcho(sessionId, '/clear', ok ? 'Sohbet geçmişi gerçekten silindi — bu oturumda sıfırdan devam ediyorsun.' : 'Oturum bulunamadı.');
    return true;
  }
  if (t === '/change' || t.startsWith('/change ')) {
    const arg = t.slice(7).trim();
    desktopEcho(sessionId, '/change' + (arg ? ' ' + arg : ''), modelChangeText(arg));
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:event', { type: 'modelChanged', sessionId: String(sessionId || '') });
    }
    return true;
  }
  if (t === '/notes') {
    desktopEcho(sessionId, '/notes', notesText(sessionId));
    return true;
  }
  if (t === '/notify' || t.startsWith('/notify ')) {
    const a = t.slice(7).trim().toLowerCase();
    if (a === 'on' || a === 'off') {
      settings.notifyOwnerFail = a === 'on';
      saveSettings();
      engine.notifyOwnerFail = settings.notifyOwnerFail;
    }
    desktopEcho(sessionId, t, `Hata mail bildirimi: ${settings.notifyOwnerFail !== false ? 'AÇIK' : 'KAPALI'} (değiştir: /notify on|off)`);
    return true;
  }
  if (t === '/approve' || t === '/deny' || t.startsWith('/approve ')) {
    const a = t.slice(8).trim().toLowerCase();
    const always = t !== '/deny' && a === 'always';
    const r = resolveFirstApproval(t !== '/deny', always);
    desktopEcho(
      sessionId,
      t,
      r.ok
        ? `*${t === '/deny' ? 'Reddedildi' : 'Onaylandı'}:* ${r.tool}${always ? ' — bu araç için bir daha sorulmayacak' : ''}`
        : 'Bekleyen onay yok.'
    );
    return true;
  }
  if (t === '/update' || t.startsWith('/update ')) {
    const a = t.slice(7).trim().toLowerCase();
    updateReplies.sids.add(String(sessionId || ''));
    if (a === 'now') {
      npmUpdateNow((text) => desktopEcho(sessionId, t, text));
    } else {
      runUpdateCommand((text) => desktopEcho(sessionId, t, text));
    }
    return true;
  }
  resumeServices(); // pause durumunda gerçek mesaj her şeyi canlandırır
  queueDesktopMessage(sessionId, text);
  return true;
});

/* #25 aktif oturumun notlarını düz metin döndürür (chat + WA) */
function notesText(sessionId) {
  try {
    const s = engine.openSession(String(sessionId || ''));
    if (s && s.notes) {
      return `Notlar (oturum ${s.code}):\n${s.notes}`;
    }
  } catch {}
  return 'Bu oturumda henüz not yok — her 14 mesajda otomatik oluşur/güncellenir.';
}

/* Masaüstü /help: komut adları **kalın** işaretlidir — renderer md() bunları
   kalın (light temada siyah) basar. */
function desktopSlashHelp() {
  return [
    '**Beast komutları**',
    '**/help** – bu liste',
    '**/version** – Beast Agent sürümünü göster',
    '**/restart** – uygulamayı yeniden başlat',
    '**/stop** – koşan işleri durdur · **/start** – devam ettir',
    '**/change [n]** – modelleri listele · n. modele geç',
    '**/model [isim]** – aktif modeli göster / değiştir',
    '**/think 0-5** – düşünme seviyesi (0 kapalı · 5 max)',
    '**/agent [isim]** – özel ajan bağla / listele (%APPDATA%\\beast\\agents\\*.md)',
    '**/clear** – oturum geçmişini gerçekten sil (kod korunur)',
    '**/notes** – bu oturumun notlarını göster',
    '**/rule <metin>** – kalıcı kural ekle · **/rules** – listele',
    '**/notify on|off** – hata mail bildirimini aç/kapa',
    '**/screenshot** – masaüstü ekran görüntüsünü sohbete ekle',
    '**/approve** – bekleyen riskli işlemi onayla (always: bir daha sorma) · **/deny** – reddet',
    '**/update** – yeni sürüm kontrolü · **/update now** – indirileni kur',
    '**/usage** – bugünkü kullanım',
    '**/backup** – tüm veriyi ŞİFRELİ yedekle (Masaüstü\\Beast-Backups)',
    '**/status** – bağlantı ve servis durumu',
    '',
    'Komutsuz her mesaj doğrudan agent\u2019a gider — normal konuşur gibi istek yaz.',
  ].join('\n');
}

/* masaüstünde komut → kullanıcı+asistan balonu olarak yansıt */
function desktopEcho(sessionId, cmd, reply) {
  const sid = String(sessionId || '');
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:event', { sessionId: sid, type: 'message', message: { role: 'user', content: cmd } });
    win.webContents.send('agent:event', { sessionId: sid, type: 'message', message: { role: 'assistant', content: reply } });
    win.webContents.send('agent:event', { sessionId: sid, type: 'done', usage: null });
  }
}

/* /change: kayıtlı modelleri numaralı listeler; /change <n> ile o modele geçer.
   Hem masaüstü hem WhatsApp aynı metni üretir. */
function modelChangeText(arg) {
  const st = engine.publicState();
  const models = st.models || [];
  if (!String(arg || '').trim()) {
    if (!models.length) return 'Kayıtlı model yok — Ayarlar → Provider.';
    const lines = models.map((m, i) => {
      const active = st.activeModel && st.activeModel.sel === m.sel;
      return `${i + 1}. ${m.providerName} · ${m.model}${active ? '  \u2190 aktif' : ''}`;
    });
    return '*Modeller:*\n' + lines.join('\n') + '\n\nGeçiş için: /change <numara>  (ör. /change 2)';
  }
  const idx = parseInt(String(arg).trim(), 10);
  if (!idx || idx < 1 || idx > models.length) {
    return `Geçersiz numara: ${arg} — 1..${models.length} arası olmalı. Liste: /change`;
  }
  const hit = models[idx - 1];
  settings.modelOverride = hit.sel;
  saveSettings();
  if (typeof engine.setModelOverride === 'function') engine.setModelOverride(hit.sel);
  const st2 = engine.publicState();
  return st2.activeModel
    ? `*Model değişti (#${idx}):* ${st2.activeModel.providerName} · ${st2.activeModel.model}`
    : `*Model değişti (#${idx}):* ${hit.sel}`;
}

/* /think: düşünme (reasoning) seviyesi — sağlayıcıların GERÇEK değerleri.
   0 Kapalı (param gönderilmez) · 1 low · 2 medium · 3 high · 4 xhigh · 5 max */
const THINK_LABELS = ['Kapalı', 'Low', 'Medium', 'High', 'X-High', 'Max'];
const THINK_EFFORTS = [null, 'low', 'medium', 'high', 'xhigh', 'max'];

function clampThink(v) {
  return Math.min(5, Math.max(0, Math.round(Number(v) || 0)));
}

function setThinkLevel(v) {
  settings.thinkLevel = clampThink(v);
  saveSettings();
  if (engine && typeof engine.setThinkLevel === 'function') engine.setThinkLevel(settings.thinkLevel);
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'think', level: settings.thinkLevel });
  return settings.thinkLevel;
}

function applyThinkLevel(arg) {
  const a = String(arg || '').trim().toLowerCase();
  let v = -1;
  if (/^[0-5]$/.test(a)) v = Number(a);
  else {
    const idx = THINK_LABELS.findIndex((l) => l.toLowerCase() === a);
    if (idx >= 0) v = idx;
  }
  if (v < 0) return { error: `Geçersiz seviye: ${a}\nKullanım: /think <0-5> — 0 Kapalı · 1 Low · 2 Medium · 3 High · 4 X-High · 5 Max` };
  const nv = setThinkLevel(v);
  return {
    level: nv,
    text:
      `Düşünme seviyesi: ${THINK_LABELS[nv]}` +
      (THINK_EFFORTS[nv] ? ` (reasoning_effort: ${THINK_EFFORTS[nv]})` : ' — parametre gönderilmez'),
  };
}

function thinkStatusText() {
  const v = engine && typeof engine.thinkLevel === 'number' ? engine.thinkLevel : clampThink(settings.thinkLevel);
  return (
    `Düşünme seviyesi: ${THINK_LABELS[v] || 'Kapalı'}\n` +
    `0 Kapalı · 1 Low · 2 Medium · 3 High · 4 X-High · 5 Max\n` +
    `Değiştirmek için: /think <0-5> (üst bardaki Düşünme menüsünden de seçilir)`
  );
}

/* /restart: uygulama kendini yeniden başlatır (relaunch + exit) */
function scheduleAppRestart(delayMs = 800) {
  setTimeout(() => {
    try { app.relaunch(); } catch {}
    try { app.exit(0); } catch {}
  }, delayMs);
}

function handleRestart(sessionId) {
  const sid = String(sessionId || '');  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:event', { sessionId: sid, type: 'message', message: { role: 'user', content: '/restart' } });
    win.webContents.send('agent:event', {
      sessionId: sid,
      type: 'message',
      message: { role: 'assistant', content: '\u21BB **Yeniden başlatılıyor…** Birkaç saniye içinde pencere geri açılacak.' },
    });
    win.webContents.send('agent:event', { sessionId: sid, type: 'done', usage: null });
  }
  scheduleAppRestart(800);
}

/* Masaüstünde /stop ve /start: engine'e gitmez; tüm sistemde etki eder ve
   sohbete görünür bir teyit düşer (kullanıcı + asistan balonu + done). */
function handleGlobalStopStart(sessionId, cmd) {
  const sid = String(sessionId || '');
  let reply = '';
  if (cmd === '/stop') {
    const n = stopEverything();
    reply =
      `\u25A0 **Durdu** — ${n} koşan iş kesildi.\n` +
      'Sürüyen sorgular, akıştaki cevaplar ve ajan faaliyetleri ANINDA kesildi; ajan yeni sorgu da açamaz.\n' +
      'Devam için bir şeyler yaz ya da `/start`';
  } else {
    const wasPaused = servicesPaused;
    resumeServices();
    reply = wasPaused ? '\u25B6 **Devam** — tüm servisler yeniden başladı.' : 'Zaten çalışıyor — durdurulmuş bir şey yok.';
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:event', { sessionId: sid, type: 'message', message: { role: 'user', content: cmd } });
    win.webContents.send('agent:event', { sessionId: sid, type: 'message', message: { role: 'assistant', content: reply } });
    win.webContents.send('agent:event', { sessionId: sid, type: 'done', usage: null });
  }
}

ipcMain.handle('agent:interrupt', (_e, sessionId) => {
  /* durdurma: bekleyen birleştirme kuyruğunu da boşalt (kullanıcı vazgeçti) */
  try {
    const q = desktopQueue.get(String(sessionId));
    if (q) {
      clearTimeout(q.timer);
      desktopQueue.delete(String(sessionId));
    }
  } catch {}
  return engine.interrupt(sessionId, 'kullanıcı sohbetteki durdurma (■) düğmesiyle iptal etti');
});

/* ---------- masaüstü sohbet birleştirme ----------
   WA'daki anti-spam'in desktop hali: hızlı ard arda gelen mesajlar
   DEBOUNCE_MS penceresinde toplanır, tek paket olarak engine'e gider.
   Arka arkaya yazımda cevap gecikmez; ancak agent ÇALIŞIYORKEN gelen
   yeni mesajlar pencereyle değil, mevcut iş bitene dek toplanır ve
   işin ardından TEK mesaj olarak sıradaki tura girer. */

const DESKTOP_DEBOUNCE_MS = 1200;
const desktopQueue = new Map(); // sid -> { timer, msgs[] }

/* payload: renderer'dan string YA DA {text, attachments} nesnesi gelir.
   Engine.send iki formu da kabul eder; birleştirme yalnızca metinlerde yapılır,
   ekler olduğu gibi korunur. */
function queueDesktopMessage(sessionId, text) {
  const sid = String(sessionId || '');
  const isObj = text && typeof text === 'object';
  const t = isObj ? String((text && text.text) || '') : String(text ?? '');
  const hasAtts = isObj && Array.isArray(text.attachments) && text.attachments.length > 0;
  if (!sid || (!t.trim() && !hasAtts)) return; // boş içerik kuyruğa girmez
  /* FEATURE: OFFLINE MESAJ KUYRUĞU — internet yokken gelen mesaj diskte bekler,
     bağlantı geri gelince otomatik gönderilir */
  if (!netOnline) {
    chatQueueOfflineAdd(sid, { text: t, attachments: hasAtts ? text.attachments : undefined });
    return;
  }
  let q = desktopQueue.get(sid);
  if (!q) {
    q = { timer: null, msgs: [] };
    desktopQueue.set(sid, q);
  }
  q.msgs.push({ text: t, attachments: hasAtts ? text.attachments : undefined });

  const busy = engine.isBusy(sid);
  if (!busy) {
    /* agent boşta: kısa pencere — hızlı ikinci mesaj ilkine eklenir */
    clearTimeout(q.timer);
    q.timer = setTimeout(() => flushDesktop(sid).catch(() => {}), DESKTOP_DEBOUNCE_MS);
  } else {
    /* agent çalışıyor: pencere yok, iş bitince hepsi birlikte gider.
       Bekleyen paket olduğunda 'done' olayı flushDesktop'u çağırır. */
    waLog(`desktop: oturum meşgul, mesaj beklemede (${q.msgs.length}) sid=${sid}`);
  }
}

async function flushDesktop(sessionId) {
  const sid = String(sessionId || '');
  const q = desktopQueue.get(sid);
  if (!q || !q.msgs.length) {
    desktopQueue.delete(sid);
    return;
  }
  if (engine.isBusy(sid)) return; // hâlâ çalışıyor — done eventini bekle
  /* debounce penceresinde internet koptuysa mesajlar offline kuyruğa düşer */
  if (!netOnline) {
    desktopQueue.delete(sid);
    clearTimeout(q.timer);
    for (const m of q.msgs) chatQueueOfflineAdd(sid, { text: m.text, attachments: m.attachments });
    return;
  }
  desktopQueue.delete(sid);
  clearTimeout(q.timer);

  /* çoklu paketi birleştir: metinler \n ile, ilk paketin ekleri esas alınır
     (aynı turda çift görsel enjeksiyonunu önlemek için) */
  let mergedText = '';
  let mergedAtts = null;
  for (const m of q.msgs) {
    if (m.text) mergedText += (mergedText ? '\n' : '') + m.text;
    if (!mergedAtts && Array.isArray(m.attachments)) mergedAtts = m.attachments;
  }
  if (!mergedText.trim() && !mergedAtts) return;
  engine.send(sid, mergedAtts ? { text: mergedText, attachments: mergedAtts } : mergedText, { userAction: true });
}

/* agent işi bitince biriken masaüstü mesajlarını göndere bastır.
   'error' bitişinde de boşaltılır — sıradaki mesaj boşa gitmesin. */
function flushDesktopOnDone(ev) {
  if (ev && (ev.type === 'done' || ev.type === 'error') && ev.sessionId) {
    const q = desktopQueue.get(String(ev.sessionId));
    if (q && q.msgs.length) {
      setTimeout(() => flushDesktop(ev.sessionId).catch(() => {}), 150);
    }
  }
}

/* ---------- OFFLINE MESAJ KUYRUĞU (masaüstü sohbet) ----------
   İnternet yokken/kopukken gönderilen chat mesajları kaybolmasın:
   - Mesaj diskteki kuyruğa yazılır (chat_queue.json — elektrik kesintisine dayanıklı)
   - Bağlantı geri gelince (DNS kontrolü) sırayla otomatik gönderilir
   - Renderer'a 'net' / 'netQueue' olayları gider: ⏳ kuyruk balonu + toast */
const NET_CHECK_HOSTS = ['one.one.one.one', 'dns.google'];
const NET_LOOKUP_HOSTS = ['www.google.com', 'www.microsoft.com'];
const NET_HTTP_PROBES = [
  'http://www.msftconnecttest.com/connecttest.txt',
  'http://cp.cloudflare.com/generate_204',
  'http://connectivitycheck.gstatic.com/generate_204',
];
const NET_CHECK_MS = 8000;
const NET_CHECK_TIMEOUT = 4000;
const NET_OFFLINE_STRIKES = 2; // üst üste bu kadar başarısız turda offline ilan edilir
const CHAT_QUEUE_MAX = 50; // kuyruk üst sınırı — taşarsa en eski düşer

let netOnline = true; // son bilinen bağlantı durumu (başlangıçta iyimser)
let netCheckedOnce = false;
let netCheckBusy = false;
let netFailStreak = 0;
let chatQueueFlushing = false;
const chatOfflineQueue = []; // { key, sessionId, text, attachments, at }

/* LLM retry'ı net izleyicisinden besler: internet kopmuşsa istek,
   bağlantı dönene kadar bekler — "fetch failed" ile görev ölmez */
try { require('./agent/llm').setNetProbe(() => netOnline); } catch {}

/* diskten yükle (app restart sonrası kuyruk korunur) */
(function chatQueueLoad() {
  try {
    const j = JSON.parse(fs.readFileSync(CHAT_QUEUE_FILE, 'utf8'));
    const items = Array.isArray(j.items) ? j.items : [];
    for (const it of items) {
      if (it && typeof it === 'object' && it.sessionId && (String(it.text || '').trim() || (Array.isArray(it.attachments) && it.attachments.length))) {
        chatOfflineQueue.push(it);
      }
    }
  } catch {}
})();

function chatQueueSave() {
  try {
    const tmp = CHAT_QUEUE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ items: chatOfflineQueue }, null, 2));
    fs.renameSync(tmp, CHAT_QUEUE_FILE); // atomik yazım — yarı kalmış dosya olmaz
  } catch {}
}

function chatQueueEmit(extra = {}) {
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:event', {
        type: 'netQueue',
        online: netOnline,
        count: chatOfflineQueue.length,
        ...extra,
      });
    }
  } catch {}
}

/* gönderilemeyen mesajı kuyruğa al */
function chatQueueOfflineAdd(sessionId, { text, attachments }) {
  const item = {
    key: 'oq' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    sessionId: String(sessionId || ''),
    text: String(text || '').slice(0, 100000),
    attachments: Array.isArray(attachments) ? attachments.slice(0, 5) : undefined,
    at: new Date().toISOString(),
  };
  chatOfflineQueue.push(item);
  while (chatOfflineQueue.length > CHAT_QUEUE_MAX) chatOfflineQueue.shift();
  chatQueueSave();
  log.info('main', `offline kuyruk: mesaj eklendi (${chatOfflineQueue.length} bekliyor) sid=${item.sessionId}`);
  chatQueueEmit({
    queued: true,
    key: item.key,
    sessionId: item.sessionId,
    text: item.text,
    attCount: item.attachments ? item.attachments.length : 0,
  });
}

/* kuyruğu normal akışa (debounce → engine) verir */
async function flushChatQueue() {
  if (chatQueueFlushing) return;
  if (!chatOfflineQueue.length) return;
  if (!netOnline) return;
  chatQueueFlushing = true;
  try {
    const keys = [];
    while (chatOfflineQueue.length) {
      const it = chatOfflineQueue.shift();
      keys.push(it.key);
      const payload = it.attachments && it.attachments.length ? { text: it.text, attachments: it.attachments } : it.text;
      queueDesktopMessage(it.sessionId, payload);
    }
    chatQueueSave();
    if (keys.length) {
      log.info('main', `offline kuyruk boşaltıldı: ${keys.length} mesaj gönderiliyor`);
      chatQueueEmit({ flushed: keys.length, keys });
    }
  } finally {
    chatQueueFlushing = false;
  }
}

/* gerçek internet kontrolü — TEK yöntem yanıltıcı olabilir:
   dns.resolve (c-ares) sistem çözümleyicisini atlar; mobil ağ/hotspot/VPN ve
   ISS DNS engellemelerinde (ör. 1.1.1.1, dns.google) internet VARken bile
   başarısız çıkar. Bu yüzden katmanlı deniyoruz; HERHANGİ bir katman başarılıysa
   internet VAR sayılır:
     1) HTTP connectivity endpoint'leri (http modülü dns.lookup = OS çözümleyicisi
        kullanır — tarayıcı gibi; captive portal/proxy/mobil ağ hepsinde çalışır)
     2) dns.lookup (Windows sistem çözümleyicisi — hosts dosyası/VPN/NRPT dahil)
        + dns.resolve (doğrudan DNS sunucusu)
     3) OS'in kendi bağlantı durumu (Electron net.isOnline — Windows NCSI)
   Ayrıca tek başarısız tur offline ilan etmez (2 üst üste başarısız tur gerekir):
   geçici DNS gecikmesi mesajları gereksiz kuyruğa atmaz. */
function httpProbe(url) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = http.get(url, { timeout: NET_CHECK_TIMEOUT }, (res) => {
        res.resume(); // gövdeyi tüket — soket serbest kalsın
        const ok = !!res.statusCode && res.statusCode < 500;
        try { res.destroy(); } catch {}
        fin(ok);
      });
      req.on('timeout', () => { try { req.destroy(); } catch {} fin(false); });
      req.on('error', () => fin(false));
    } catch { fin(false); }
  });
}

function lookupProbe(host) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), NET_CHECK_TIMEOUT);
    dns.lookup(host, (err) => { clearTimeout(t); resolve(!err); });
  });
}

function dnsProbe(host) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), NET_CHECK_TIMEOUT);
    dns.resolve(host, 'A', (err) => {
      clearTimeout(t);
      resolve(!err);
    });
  });
}

async function netCheck() {
  if (netCheckBusy) return;
  netCheckBusy = true;
  try {
    let ok = (await Promise.all(NET_HTTP_PROBES.map(httpProbe))).some(Boolean);
    if (!ok) {
      const lookups = [
        ...NET_LOOKUP_HOSTS.map(lookupProbe),
        ...NET_CHECK_HOSTS.map(dnsProbe),
      ];
      ok = (await Promise.all(lookups)).some(Boolean);
    }
    if (!ok) {
      try { ok = electronNet.isOnline() === true; } catch {}
    }
    const first = !netCheckedOnce;
    const was = netOnline;
    netCheckedOnce = true;
    if (ok) {
      netFailStreak = 0;
      netOnline = true;
    } else {
      netFailStreak++;
      if (!was || netFailStreak >= NET_OFFLINE_STRIKES) netOnline = false;
    }
    if (netOnline !== was || first) {
      try {
        if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'net', online: netOnline });
      } catch {}
      if (netOnline) {
        log.info('main', 'bağlantı geri geldi — offline kuyruk kontrol ediliyor');
        chatQueueEmit(); // renderer: pill/toast güncellensin
        flushChatQueue().catch(() => {});
      } else {
        log.info('main', `internet bağlantısı yok — mesajlar kuyruğa alınacak (streak=${netFailStreak})`);
        chatQueueEmit();
      }
    }
  } catch {} finally {
    netCheckBusy = false;
  }
}

ipcMain.handle('model:set', (_e, sel) => {
  /* MÜŞTERİ botu aktifken picker seçimi O BOTUN modelini değiştirir;
     Beast (admin) aktifken global seçim değişir. */
  const act = settings.activeBotId ? bots.get(settings.activeBotId) : null;
  if (act && !act.admin) {
    try { bots.update(act.id, { model: String(sel || '') }); } catch {}
    try {
      for (const v of engine.listSessions()) {
        if (v.botId === act.id) engine.setSessionModel(v.id, sel || null);
      }
    } catch {}
  } else {
    settings.modelOverride = sel;
    saveSettings();
    engine.setModelOverride(sel);
  }
  /* IDE/Beast Code dahil tüm paneller anlık haberdar olsun — picker +
     durum etiketleri kapatıp açmadan güncellenir */
  try { win && !win.isDestroyed() && win.webContents.send('agent:event', { type: 'modelChanged' }); } catch {}
  return engine.publicState();
});

/* Paralel ajan geçmişini TOPLUCA sil (rail başlığındaki çöp ikonu) */
ipcMain.handle('agents:clearAll', () => {
    try {
      const removed = engine.clearAllBgJobs();
      return { ok: true, removed };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

ipcMain.handle('model:role', (_e, map) => {
  const roleModels = {};
  const allowed = {};
  for (const k of ['vision', 'terminal', 'coding', 'subagent']) {
    const v = map && map[k];
    if (v && typeof v === 'object' && v.providerId && v.model) {
      roleModels[k] = v.providerId + '::' + v.model;
    } else if (v === null || v === undefined) {
      roleModels[k] = null; // default to main
    }
  }
  settings.roleModels = roleModels;
  saveSettings();
  engine.setRoleModels(roleModels);
  return engine.publicState();
});

ipcMain.handle('wa:lockdown:set', (_e, v) => {
  settings.waLockdown = !!v;
  saveSettings();
  if (engine) engine.setLockdown(settings.waLockdown);
  return { waLockdown: settings.waLockdown };
});

ipcMain.handle('model:delete', (_e, sel) => {
  const list = new Set(settings.deletedModels || []);
  if (typeof sel === 'string' && sel.includes('::')) list.add(sel);
  settings.deletedModels = [...list];
  saveSettings();
  engine.setDeletedModels(settings.deletedModels);
  return engine.publicState();
});

ipcMain.handle('model:restore', (_e, sel) => {
  settings.deletedModels = (settings.deletedModels || []).filter((s) => s !== sel);
  saveSettings();
  engine.setDeletedModels(settings.deletedModels);
  return engine.publicState();
});

ipcMain.handle('cwd:set', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    defaultPath: engine.workspace,
    title: 'Beast çalışma klasörü seç',
  });
  if (res.canceled || !res.filePaths[0]) return engine.publicState();
  settings.workspace = res.filePaths[0];
  saveSettings();
  engine.setWorkspace(res.filePaths[0]);
  return engine.publicState();
});

ipcMain.on('open-external', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});

/* ---------------- settings IPC ---------------- */

ipcMain.handle('memory:get', () => memory.loadAll());

/* paralel ajanlar: canlı izleme (#14) */
ipcMain.handle('agents:list', () => engine.listBgJobs());
ipcMain.handle('agents:detail', (_e, id) => engine.bgDetail(id));
ipcMain.handle('agents:cancel', (_e, id) => ({
  ok: engine.interrupt(String(id || ''), 'kullanıcı Paralel Ajanlar panelinden (×) iptal etti'),
}));
ipcMain.handle('ceo:get', () => !!engine.ceoMode);
ipcMain.handle('ceo:set', (_e, v) => {
  settings.ceoMode = !!v;
  saveSettings();
  if (engine) engine.setCeoMode(!!v);
  return true;
});

ipcMain.handle('notes:list', () => engine.listNotes());
ipcMain.handle('notes:clear', (_e, id) => engine.clearNotes(id));

ipcMain.handle('memory:save', (_e, { file, content }) => memory.save(file, content));

ipcMain.handle('skills:list', () => skillsMod.scan());

/* OTOMATİK SKİLL SİSTEMİ: açıkken öğrenilen prosedürler direkt kurulur,
   mevcut skillin daha iyisi bulunursa güncellenir */
ipcMain.handle('skills:auto:get', () => settings.autoSkills !== false);
ipcMain.handle('skills:auto:set', (_e, v) => {
  settings.autoSkills = !!v;
  saveSettings();
  if (engine) engine.autoSkills = !!v;
  return settings.autoSkills;
});

/* taslak skill'ler (#2 yansıma ürünleri) */
ipcMain.handle('skills:drafts:list', () => skillsMod.listDrafts());
ipcMain.handle('skills:drafts:accept', (_e, id) => {
  const r = skillsMod.acceptDraft(id);
  if (r.ok) waLog(`skill taslağı kabul edildi: ${id}`);
  return r;
});
ipcMain.handle('skills:drafts:drop', (_e, id) => skillsMod.dropDraft(id));

/* kalıcı kurallar (#3) */
ipcMain.handle('rules:get', () => memory.listRules());
ipcMain.handle('rules:add', (_e, text) => memory.addRule(text));
ipcMain.handle('rules:remove', (_e, idOrText) => memory.removeRule(idOrText));

/* olay merkezi ayarları (#4) */
function normEventBus(e) {
  const cur = settings.eventBus || {};
  return {
    enabled: !!(e && e.enabled),
    mailIdle: !!(e ? e.mailIdle : cur.mailIdle),
    fsWatch: !!(e ? e.fsWatch : cur.fsWatch),
    webhookPort: Number((e && e.webhookPort) || cur.webhookPort || 8787),
    priceSymbol: String((e && e.priceSymbol) || cur.priceSymbol || '').trim() || null,
  };
}
ipcMain.handle('events:config:get', () => {
  const e = normEventBus(null);
  return { ...e, enabled: !!(settings.eventBus && settings.eventBus.enabled), token: webhookToken(), port: e.webhookPort };
});
ipcMain.handle('events:config:set', (_e, cfg) => {
  settings.eventBus = normEventBus(cfg);
  saveSettings();
  startEventBus();
  return { ...settings.eventBus, token: webhookToken() };
});
ipcMain.handle('events:subs:list', () => bus.listSubs());
ipcMain.handle('events:subs:remove', (_e, id) => bus.removeSub(id));

ipcMain.handle('skills:openFolder', () => {
  shell.openPath(skillsMod.dir());
  return true;
});

/* ---------------- kullanım/maliyet IPC ---------------- */

ipcMain.handle('usage:get', () => usageMod.report());
ipcMain.handle('usage:reset', () => {
  usageMod.reset();
  return usageMod.report();
});

/* #6 yedekleme */
ipcMain.handle('backup:create', async () => createBackup());
ipcMain.handle('backup:restore', async () => restoreBackup());

/* ---------------- #2 kurulum sihirbazı ---------------- */

ipcMain.handle('setup:status', () => {
  try {
    const st = engine.publicState();
    return {
      done: !!settings.setupDone,
      hasModel: !!st.hasModel || (st.models || []).length > 0,
      waConnected: !!(wa && wa.connected),
      customCount: (settings.customProviders || []).length,
    };
  } catch {
    return { done: false, hasModel: false, waConnected: false, customCount: 0 };
  }
});

/* Sihirbazdan gelen key+baseUrl'i kalıcı custom provider olarak kaydet */
ipcMain.handle('setup:saveProvider', (_e, { name, baseUrl, key }) => {
  try {
    const id = 'setup-' + Date.now().toString(36);
    const list = settings.customProviders || [];
    list.push({
      id,
      name: String(name || '').trim().slice(0, 40) || 'Sağlayıcı',
      baseUrl: String(baseUrl || '').trim(),
      key: String(key || '').trim(),
      models: [],
    });
    settings.customProviders = list;
    saveSettings();
    if (engine) engine.setCustomProviders(settings.customProviders);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* Model seçimi + sihirbazı bitir */
ipcMain.handle('setup:complete', (_e, { sel }) => {
  try {
    if (sel) {
      settings.modelOverride = String(sel);
      saveSettings();
      if (engine) engine.setModelOverride(settings.modelOverride);
    }
    settings.setupDone = true;
    saveSettings();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.handle('setup:skip', () => {
  settings.setupDone = true; // bir daha açılmasın
  saveSettings();
  return { ok: true };
});

/* #5 "nerede kaldım": get → gerçek ayar durumu (checkbox doğru görünsün) */
ipcMain.handle('wherewasi:get', () => {
  const cfg = settings.whereWasI || {};
  const sum = whereWasISummary();
  return { enabled: cfg.enabled === true, ...(sum || {}) };
});
ipcMain.handle('wherewasi:set', (_e, cfg) => {
  settings.whereWasI = { enabled: !!(cfg && cfg.enabled) };
  saveSettings();
  return settings.whereWasI;
});

/* WhatsApp grup ayarı: { enabled, mentionOnly, seeAll }
   seeAll: yalnız mentionOnly modunda anlamlı — bot grubun TÜM konuşmasını
   bağlam olarak okur ama yine SADECE @mention'da cevap verir.
   VARSAYILAN KAPALI: herkesin konuşmasını görmesi istenmeyebilir. */
ipcMain.handle('wa:groups:get', () => settings.waGroups || { enabled: false, mentionOnly: true, seeAll: false });
ipcMain.handle('wa:groups:set', (_e, cfg) => {
  settings.waGroups = {
    enabled: !!(cfg && cfg.enabled),
    mentionOnly: !(cfg && cfg.mentionOnly === false),
    seeAll: !!(cfg && cfg.seeAll),
  };
  saveSettings();
  return settings.waGroups;
});

ipcMain.handle('settings:get', () => {
  const out = JSON.parse(JSON.stringify(settings));
  /* Sırların renderera düz metin gitmesini engelle */
  if (out.email && out.email.pass) out.email.pass = '***';
  if (out.waTts && out.waTts.key) out.waTts.key = '***';
  return out;
});

/* ---------------- FALLOUT IPC ---------------- */

function defaultFallout() {
  return { enabled: false, autoResume: true, slots: Array.from({ length: 10 }, () => null) };
}

ipcMain.handle('fallout:get', () => {
  const f = settings.fallout || {};
  const out = defaultFallout();
  out.enabled = !!f.enabled;
  out.autoResume = f.autoResume !== false;
  if (Array.isArray(f.slots)) {
    for (let i = 0; i < Math.min(10, f.slots.length); i++) out.slots[i] = f.slots[i] || null;
  }
  return out;
});

ipcMain.handle('fallout:set', (_e, cfg) => {
  const cur = settings.fallout || defaultFallout();
  const next = defaultFallout();
  next.enabled = !!(cfg && cfg.enabled);
  next.autoResume = !cfg || cfg.autoResume !== false;
  const slots = Array.isArray(cfg && cfg.slots) ? cfg.slots : [];
  for (let i = 0; i < Math.min(10, slots.length); i++) {
    const s = slots[i];
    if (!s || typeof s !== 'object' || !s.providerId || !s.model || !s.key) continue;
    next.slots[i] = {
      providerId: String(s.providerId),
      providerName: String(s.providerName || s.providerId),
      model: String(s.model),
      key: String(s.key),
    };
  }
  settings.fallout = next;
  saveSettings();
  if (engine) engine.setFallout(next);
  return JSON.parse(JSON.stringify(next));
});

/* #Limit: provider bazlı max input token limiti + bağlam sıkıştırma */
/* #Güvenlik IPC */
ipcMain.handle('sec:get', () => ({
  approvals: !!(settings.security && settings.security.approvals),
  alwaysAllow: (settings.security && Array.isArray(settings.security.alwaysAllow) ? settings.security.alwaysAllow : []),
}));
ipcMain.handle('sec:set', (_e, cfg) => {
  const prevAlways = settings.security && Array.isArray(settings.security.alwaysAllow) ? settings.security.alwaysAllow : [];
  settings.security = {
    approvals: !!(cfg && cfg.approvals),
    alwaysAllow: cfg && Array.isArray(cfg.alwaysAllow) ? cfg.alwaysAllow : prevAlways,
  };
  saveSettings();
  if (engine) {
    engine.approvals = settings.security.approvals ? approvalsBridge : null;
    engine.alwaysAllowTools = new Set(settings.security.alwaysAllow);
  }
  log.info('sec', `güvenlik: onay kapısı ${settings.security.approvals ? 'AÇIK' : 'KAPALI (her şey serbest)'}`);
  return { approvals: settings.security.approvals, alwaysAllow: settings.security.alwaysAllow };
});
ipcMain.handle('approval:respond', (_e, { id, ok, always }) => resolveApproval(id, ok, always));

/* ---------------- #Update IPC ---------------- */
ipcMain.handle('update:status', async () => {
  const st = {
    current: app.getVersion(),
    packaged: app.isPackaged,
    npm: isNpmMode(),
    ...updateState,
    autoCheck: settings.autoCheckUpdate !== false,
    autoDownload: settings.autoDownloadUpdate !== false,
  };
  try {
    /* npm registry'den güncel sürüm — updater ne yaparsa yapsın "En son sürüm" kartı dolu olsun */
    const v = await getNpmLatest();
    if (v) {
      st.npmLatest = v;
      if (!st.version) st.version = v;
      if (isNewerVersion(v, app.getVersion())) st.available = true;
    }
  } catch {}
  return st;
});

ipcMain.handle('update:check', async () => {
  const current = app.getVersion();
  /* her modda npm registry'den taze kontrol (cache bypass) */
  const v = await getNpmLatest(true);
  const out = { ok: true, npm: isNpmMode(), version: v || undefined, available: v ? isNewerVersion(v, current) : false };
  if (v) {
    if (!updateState.version || isNewerVersion(v, updateState.version)) updateState.version = v;
    if (isNewerVersion(v, current)) updateState.available = true;
  }
  /* packaged + updater: GitHub Releases kontrolü de çalışsın */
  if (!isNpmMode() && autoUpdater) {
    try {
      const r = await autoUpdater.checkForUpdates();
      const uv = r && r.update && r.update.version;
      if (uv) { out.version = uv; out.available = uv !== current; }
    } catch (e) {
      if (!v) return { ok: false, error: String((e && e.message) || e) };
    }
  }
  emitUpdateEvent();
  return out;
});

/* TEK DAĞITIM POLİTİKASI: uygulama içi self-update KALDIRILDI (v0.24.0).
   Güncelleme yalnız: uygulamayı kapat → "npm i -g beast-agent@latest" → tekrar aç. */

ipcMain.handle('update:install', () => {
  /* TEK DAĞITIM npm: buton → görünür cmd'de "beast update" → kapan → kur → aç */
  if (!isNpmMode()) return { ok: false, error: NPM_ONLY_TEXT };
  npmUpdateViaCmd();
  return { ok: true, npm: true };
});

ipcMain.handle('update:setAuto', (_e, cfg) => {
  if (cfg && typeof cfg.autoCheck === 'boolean') settings.autoCheckUpdate = cfg.autoCheck;
  if (cfg && typeof cfg.autoDownload === 'boolean') {
    settings.autoDownloadUpdate = cfg.autoDownload;
    if (autoUpdater) autoUpdater.autoDownload = cfg.autoDownload;
  }
  saveSettings();
  return { autoCheck: settings.autoCheckUpdate !== false, autoDownload: settings.autoDownloadUpdate !== false };
});

/* /update komutu (masaüstü + WA): hedefi kaydet, kontrol başlat */
/* npm modunda güncelle-şimdi: sürüm kontrolü + numaralarıyla bildir + kendi kendini güncelle */
/* TEK DAĞITIM POLİTİKASI: exe/installer YOK.
   Güncelleme akışı: buton → görünür CMD penceresi açılır → "beast update"
   (npm install çıktısı ekranda akar) → uygulama kapanır → kurulum bitince
   uygulama kendiliğinden yeniden açılır. */
const NPM_ONLY_TEXT =
  'Tek dağıtım npm\u2019dir. Güncellemek için:\n1) Uygulamayı kapat\n2) Terminalde: npm i -g beast-agent@latest\n3) Tekrar aç';

/* buton akışı: görünür cmd + "beast update" + uygulama kapanışı */
function npmUpdateViaCmd() {
  try {
    /* cmd KULLANICININ kendi klasöründe açılır (cd /d %USERPROFILE%): Electron kısayoldan
       paket klasörü (node_modules\beast-agent) içinde başlatıldıysa cmd orada açılır ve
       npm install -g değiştirmeye çalıştığı paketi KİLİTLER (EBUSY) — 5 denemede de
       patlar. Home'da açılınca kurulum sorunsuz akar; "beast" PATH'te %APPDATA%\npm'de.
       NOT: spawn argümanlarında ÇİFT TIRNAK kullanma — node \" olarak escape'ler ve cmd bozar. */
    spawn(
      'cmd.exe',
      ['/c', 'start', 'Beast Guncelleme', 'cmd', '/k', 'cd /d %USERPROFILE% && beast update'],
      { detached: true, stdio: 'ignore', windowsHide: false }
    ).unref();
  } catch {}
  setTimeout(() => { try { app.quit(); } catch {} }, 600);
}

function npmUpdateNow(reply /* fn(text) */) {
  const current = app.getVersion();
  getNpmLatest(true).then((v) => {
    if (v && isNewerVersion(v, current)) {
      updateState.available = true;
      updateState.version = v;
      reply(`🔄 *Yeni sürüm var*\nMevcut: v${current}\nYeni: v${v}\nGüncelleme başlatıldı — cmd penceresinden takip et.`);
      npmUpdateViaCmd();
    } else {
      reply(`✅ *Güncelsin* — v${current} zaten en son sürüm.`);
    }
  }).catch(() => reply('Sürüm kontrol edilemedi — bağlantıyı kontrol et.'));
}

async function runUpdateCommand(reply /* fn(text) */) {
  /* yalnız KONTROL + yol gösterme — kendiliğinden kurulum yapmaz */
  return npmUpdateNow(reply);
}

/* #STT: sohbet mikrofonu — MediaRecorder sesini (webm/opus) yerel whisper'a çevir */
/* #STT: sohbet mikrofonu — MediaRecorder sesini (webm/opus) yerel whisper'a çevir */
ipcMain.handle('stt:transcribe', async (_e, b64, lang) => {
  try {
    const buf = Buffer.from(String(b64 || '').split(',').pop() || '', 'base64');
    if (!buf.length) return { ok: false, error: 'boş ses kaydı' };
    const text = await transcribeAudio(buf, lang === 'en' || lang === 'auto' ? lang : undefined);
    return text ? { ok: true, text } : { ok: false, error: 'konuşma algılanamadı' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('stt:lang:get', () => settings.sttLang || 'tr');
ipcMain.handle('stt:lang:set', (_e, lang) => {
  const v = ['auto', 'tr', 'en'].includes(String(lang)) ? String(lang) : 'tr';
  settings.sttLang = v;
  saveSettings();
  return v;
});

ipcMain.handle('limits:get', () => {
  const l = settings.limits || {};
  return {
    enabled: !!l.enabled,
    compress: l.compress !== false,
    default: Math.max(0, Math.round(Number(l.default) || 0)),
    perProvider: l.perProvider && typeof l.perProvider === 'object' ? { ...l.perProvider } : {},
  };
});

ipcMain.handle('limits:set', (_e, cfg) => {
  const per = {};
  const raw = cfg && typeof cfg.perProvider === 'object' && cfg.perProvider ? cfg.perProvider : {};
  for (const [k, v] of Object.entries(raw)) {
    const n = Math.max(0, Math.round(Number(v) || 0));
    if (n > 0 && k) per[String(k).slice(0, 80)] = n;
  }
  const next = {
    enabled: !!(cfg && cfg.enabled),
    compress: !cfg || cfg.compress !== false,
    default: Math.max(0, Math.round(Number(cfg && cfg.default) || 0)),
    perProvider: per,
  };
  settings.limits = next;
  saveSettings();
  if (engine) engine.setLimits(next);
  return JSON.parse(JSON.stringify(next));
});

ipcMain.handle('visible-models:set', (_e, list) => {
  settings.visibleModels = Array.isArray(list) ? list : null;
  saveSettings();
  return true;
});

ipcMain.handle('theme:set', (_e, t) => {
  settings.theme = t === 'dark' ? 'dark' : 'light';
  saveSettings();
  if (win && !win.isDestroyed() && typeof win.setTitleBarOverlay === 'function') {
    try {
      win.setTitleBarOverlay(
        settings.theme === 'dark'
          ? { color: '#0d0d0f', symbolColor: '#9a9aa2' }
          : { color: '#f7f7f8', symbolColor: '#707078' }
      );
    } catch {}
  }
  return true;
});

/* ---------------- cron IPC ---------------- */

function cronEmit() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:event', { type: 'cron', jobs: cron.list() });
  }
}

/* Cron cevabı bekleme haritası: sid -> job. İş 'done' olunca cevap
   SAHİBİN bağlı olduğu TÜM AKTİF entegrasyonlara yansıtılır (kullanıcı
   hangi kanaldan ajanla iletişimde belli değil). */
const cronAnswerPending = new Map();

/* OTOMATİK YENİ SOHBET YOK: cron/izleyici/fallout tetiklendiğinde oturum
   seçimi — kayıtlı id geçerliyse O, değilse EN GÜNCEL oturum kullanılır.
   Hiç oturum yoksa (ilk kurulum) yeni açılır. Böylece soldaki sohbet
   geçmişine "+ Yeni Sohbet" olmadan hayalet sohbetler düşmez. */
function reuseOrLatestSession(preferredId) {
  const sid = String(preferredId || '');
  if (sid) {
    try {
      if (engine._load(sid)) return sid;
    } catch {}
  }
  try {
    const list = engine.listSessions(); // updatedAt'e göre yeni→eski sıralı
    if (list.length) return String(list[0].id);
  } catch {}
  return engine.createSession().id;
}

/* Yansıtma hedefleri: bağlı WA (owner numarası), Telegram ve Discord
   (owner işaretli kayıt; tek kayıt varsa o). Cron oturumunun KENDİ
   kanalına yansıtmayız — cevabı zaten kendi akışından alır (çift yok). */
function tgOwnerIds() {
  const list = settings.tgAllow || [];
  const objs = list.filter((e) => e && typeof e === 'object' && e.id && e.id !== '*');
  const owner = objs.find((e) => e.owner) || (objs.length === 1 ? objs[0] : null);
  return owner ? [String(owner.id)] : [];
}
function dcOwnerIds() {
  const list = settings.dcAllow || [];
  const objs = list.filter((e) => e && typeof e === 'object' && e.id && e.id !== '*');
  const owner = objs.find((e) => e.owner) || (objs.length === 1 ? objs[0] : null);
  return owner ? [String(owner.id)] : [];
}
function cronMirrorTargets(cronSid) {
  const out = [];
  try {
    if (wa && wa.connected) {
      const own = waOwnerNum();
      if (own) {
        const jid = own + '@s.whatsapp.net';
        const bound = [...waChats.entries()].some(([j, s]) => j === jid && String(s) === String(cronSid));
        if (!bound) out.push({ kind: 'wa', send: (t) => sendWaSafe(jid, t) });
      }
    }
  } catch {}
  try {
    if (tg && tg.connected) {
      for (const id of tgOwnerIds()) {
        const bound = [...tgChats.entries()].some(([c, s]) => String(c) === String(id) && String(s) === String(cronSid));
        if (!bound) out.push({ kind: 'tg', send: (t) => sendTgSafe(id, t) });
      }
    }
  } catch {}
  try {
    if (dc && dc.connected) {
      for (const id of dcOwnerIds()) {
        const bound = [...dcChats.entries()].some(([c, s]) => String(c) === String(id) && String(s) === String(cronSid));
        if (!bound) out.push({ kind: 'dc', send: (t) => sendDcSafe(id, t) });
      }
    }
  } catch {}
  return out;
}

function cronFire(job) {
  try {
    const sid = reuseOrLatestSession(job.sessionId);
    if (sid !== String(job.sessionId || '')) {
      cron.update(job.id, { sessionId: sid });
    }
    cronAnswerPending.set(String(sid), job);
    const sent = engine.send(sid, {
      text: `[cron: ${job.name}]\n${job.prompt}`,
    });
    if (!sent) cronAnswerPending.delete(String(sid)); // gönderilemedi — bayat bekleme bırakma
  } catch {}
  cronEmit();
}

/* İzleyici tetiklendiğinde ilgili sohbete kullanıcı mesajı gibi düşer */
function watcherFire(w, value) {
  try {
    watcherLog(`tetiklendi id=${w.id} name="${w.name}" kind=${w.kind} op=${w.op} value=${value}`);
    const sid = reuseOrLatestSession(w.sessionId);
    if (sid !== String(w.sessionId || '')) {
      watchers.patch(w.id, { sessionId: sid });
    }
    const target =
      w.op === 'changed'
        ? 'izlenen değer değişti'
        : `kural sağlandı (son değer ${value}, koşul ${w.op} ${w.value ?? ''})`;
    engine.send(sid, {
      text:
        `[IZLEYICI: ${w.name}] ${target}. ` +
        'Kullanıcıya bunu kısaca ve net biçimde haber ver; detay gerekirse http_fetch ile güncel durumu kontrol et.',
    });
  } catch {}
}

ipcMain.handle('cron:list', () => cron.list());
/* #23 Fallout: provider → kayıtlı API key haritası.
   Birincil kaynak: engine chain (config+custom+env çözülmüş).
   Yedek: config.yaml/.env + settings.customProviders. */
ipcMain.handle('providers:keys', () => {
  const map = {};
  try {
    Object.assign(map, engine.providerKeyMap ? engine.providerKeyMap() : {});
  } catch {}
  if (!Object.keys(map).length) {
    try {
      for (const p of loadBeastConfig().providers || []) {
        if (p.id && p.key) map[p.id] = p.key;
      }
    } catch {}
    try {
      for (const p of settings.customProviders || []) {
        if (p.id && p.key) map['custom:' + p.id] = p.key;
      }
    } catch {}
  }
  return map;
});
/* #22 izleyici paneli IPC */
ipcMain.handle('watchers:list', () => watchers.list());
ipcMain.handle('watchers:add', (_e, input) => watchers.add(input || {}));
ipcMain.handle('watchers:remove', (_e, id) => watchers.remove(String(id || '')));
ipcMain.handle('watchers:toggle', (_e, id) => {
  const w = watchers.get(String(id || ''));
  if (!w) return { ok: false, error: 'izleyici yok' };
  watchers.patch(String(id), { enabled: !w.enabled });
  return { ok: true, watcher: watchers.get(String(id)) };
});
ipcMain.handle('cron:add', (_e, job) => {
  const r = cron.add(job || {});
  cronEmit();
  return r;
});
ipcMain.handle('cron:update', (_e, { id, patch }) => {
  const r = cron.update(id, patch || {});
  cronEmit();
  return r;
});
ipcMain.handle('cron:delete', (_e, id) => {
  const r = cron.remove(id);
  cronEmit();
  return r;
});
ipcMain.handle('cron:toggle', (_e, id) => {
  const r = cron.toggle(id);
  cronEmit();
  return r;
});
ipcMain.handle('cron:runNow', (_e, id) => {
  const r = cron.runNow(id);
  cronEmit();
  return r;
});

/* ---------------- tarayıcı IPC ---------------- */
ipcMain.handle('browser:toggle', () => {
  /* gizli çalışan ajan paneli varsa düğme ONU GÖRÜNÜR yapar; değilse aç/kapa.
     (ajanlar tarayıcıyı hep gizli açar — kullanıcı izlemek isterse buradan gösterir) */
  if (browser.open && !browser.visible) {
    setBrowserOpen(true, true);
    return { open: browser.open, visible: browser.visible };
  }
  setBrowserOpen(!browser.open, true);
  return { open: browser.open, visible: browser.visible };
});
/* göz ikonu: ajan tarayıcısını görünür/gizli yap */
ipcMain.handle('browser:shown:get', () => ({ shown: settings.browserHeadless === false }));
ipcMain.handle('browser:shown:set', (_e, v) => {
  settings.browserHeadless = !v;
  saveSettings();
  if (browser.open) {
    browser.visible = !!v;
    layoutBrowser();
    browserEmit({ open: true, width: browserShownWidth(browserW()) });
  }
  return { shown: !!v };
});
ipcMain.handle('browser:navigate', (_e, url) => browserNavigate(url));
ipcMain.handle('browser:ctrl', (_e, action) => {
  if (action === 'close') {
    setBrowserOpen(false);
    return { ok: true };
  }
  const wc = browser.view && browser.view.webContents;
  if (!wc) return { ok: false };
  try {
    if (action === 'back') wc.goBack();
    else if (action === 'forward') wc.goForward();
    else if (action === 'reload') wc.reload();
    return { ok: true };
  } catch {
    return { ok: false };
  }
});
ipcMain.handle('browser:setIgnoreMouse', (_e, flag) => {
  try {
    if (browser.view && browser.open) browser.view.webContents.setIgnoreMouseEvents(!!flag);
    return { ok: true };
  } catch {
    return { ok: false };
  }
});
ipcMain.handle('browser:setWidth', (_e, wpx) => {
  if (!win || win.isDestroyed()) return { ok: false };
  const [w] = win.getContentSize();
  /* kullanıcı sürükleyerek gerçek tercihini belirler — kalıcı saklanır */
  browser.width = Math.max(300, Math.min(Number(wpx) || 480, Math.max(340, w - 320)));
  settings.browserWidth = browser.width;
  saveSettings();
  layoutBrowser();
  browserEmit({ open: true, width: browserShownWidth(w) });
  return { ok: true, width: browser.width };
});

/* TELEFON MODU: mobil UA + dar dock (≈430px) → aynı sitenin mobil versiyonu.
   Kapatınca masaüstü UA + kayıtlı genişlik geri gelir. UA değişimi için sayfa
   taze yüklenir. Expo/Metro dev sunucularında otomatik açılır. */
function setBrowserPhone(on) {
  const want = !!on;
  if (browser.phone === want) return { ok: true, phone: want };
  browser.phone = want;
  try {
    const wc = browser.view && browser.view.webContents;
    if (wc) {
      wc.setUserAgent(browser.phone ? PHONE_UA : browser.desktopUA || PHONE_UA);
      let url = '';
      try { url = wc.getURL(); } catch {}
      if (url && /^https?:/i.test(url)) wc.loadURL(url).catch(() => {});
    }
  } catch {}
  /* dock daralır/genişler — layout + renderer --bw tazelenir */
  if (browser.open && win && !win.isDestroyed()) {
    layoutBrowser();
    const [w] = win.getContentSize();
    browserEmit({ open: true, width: browserShownWidth(w) });
  }
  return { ok: true, phone: browser.phone };
}
ipcMain.handle('browser:phone', (_e, on) => setBrowserPhone(on));
ipcMain.handle('browser:screenshot', async () => {
  const r = await browserScreenshot();
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, image: r.__injectImage, url: r.url, title: r.title };
});

/* ---------------- terminal panel IPC ----------------
   Sağ dock paneli renderer'da; main sadece PowerShell komutlarını
   çalıştırır ve çıktıyı canlı akıtır. Terminal ile tarayıcı aynı
   dock'u paylaştığı için ikisi aynı anda açık kalamaz. */
let termChild = null; /* KALICI CMD oturumu — cd/set değişkenleri komutlar arasında KORUNUR */
let termShellCwd = ''; /* izlenen çalışma klasörü (komut sonundaki marker'dan) */
let termShellId = null;
let termShellSeq = 0;
let termForwarded = 0;
let termCapNotified = false;
const TERM_FWD_CAP = 1024 * 1024; /* iletilecek çıktı üst sınırı (1 MB) */
const TERM_MARKER = '__BEAST_EOF__';

function termSend(ev) {
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev);
}

/* Kalıcı kabuğu başlat: cmd /q /k — girdi pipe'ından satır satır okur,
   prompt yazmaz. chcp 65001 → Türkçe yollar (Masaüstü vb.) doğru çözülür. */
function termShellSpawn() {
  const cwd =
    termShellCwd ||
    (engine && engine.workspace) ||
    settings.workspace ||
    app.getPath('home');
  const child = spawn('cmd.exe', ['/q', '/k'], {
    cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  termShellCwd = cwd;
  termChild = child;
  termForwarded = 0;
  termCapNotified = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    termForwarded += String(d).length;
    if (termForwarded > TERM_FWD_CAP) {
      if (!termCapNotified) {
        termCapNotified = true;
        termSend({ type: 'term-out', id: termShellId, stream: 'out', chunk: '\n[beast] çıktı çok büyük — iletim durduruldu (komut sürüyor)\n' });
      }
      return;
    }
    termSend({ type: 'term-out', id: termShellId, stream: 'out', chunk: String(d) });
  });
  child.stderr.on('data', (d) => {
    termSend({ type: 'term-out', id: termShellId, stream: 'err', chunk: String(d) });
  });
  child.on('exit', () => {
    if (termChild === child) termChild = null;
  });
  /* UTF-8 kod sayfası: Türkçe karakterli klasörler/çıktılar bozulmadan akar.
     (cmd her stdin satırını bir komut işler — bu ilk satır chcp olur) */
  try { child.stdin.write('chcp 65001 > nul\r\n'); } catch {}
}

ipcMain.handle('terminal:toggle', () => {
  if (browser.open) setBrowserOpen(false);
  return { ok: true, cwd: termShellCwd || (engine && engine.workspace) || settings.workspace || app.getPath('home') };
});

ipcMain.handle('terminal:run', (_e, payload) => {
  const cmd = String((payload && payload.cmd) || '').trim();
  const shell = String((payload && payload.shell) || 'cmd');
  if (!cmd) return { ok: false, error: 'boş komut' };
  /* kalıcı CMD: komut AYNI kabuğa yazılır → cd/set kalıcıdır; komutlar sıraya girer */
  if (shell === 'cmd') {
    if (!termChild || !termChild.stdin.writable) termShellSpawn();
    if (!termChild) return { ok: false, error: 'kabuk başlatılamadı' };
    const id = 't' + Date.now().toString(36) + ++termShellSeq;
    termShellId = id;
    termForwarded = 0;
    termCapNotified = false;
    try {
      /* İKİ AYRI satır: cmd her satırı SIRAYLA işler — ikinci satırdaki %CD%
         ancak ilk komut BİTİNCE okunur/genişletilir → doğru (yeni) klasör gelir.
         Aynı satıra & echo yazsaydık %CD% eski klasörü verirdi. */
      termChild.stdin.write(cmd + '\r\n' + 'echo ' + TERM_MARKER + '%CD%' + TERM_MARKER + '\r\n');
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    return { ok: true, id };
  }
  /* geriye dönük uyumluluk — UI artık yalnız CMD gönderir */
  const cwd = termShellCwd || (engine && engine.workspace) || settings.workspace || app.getPath('home');
  const id = 't' + Date.now().toString(36);
  let file, args;
  if (shell === 'cmd') {
    file = 'cmd.exe';
    args = ['/d', '/s', '/c', cmd];
  } else {
    file = 'powershell.exe';
    args = ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd];
  }
  let child;
  try {
    child = spawn(file, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => termSend({ type: 'term-out', id, stream: 'out', chunk: String(d) }));
  child.stderr.on('data', (d) => termSend({ type: 'term-out', id, stream: 'err', chunk: String(d) }));
  child.on('error', (err) => {
    termSend({ type: 'term-end', id, code: -1, error: String((err && err.message) || err) });
  });
  child.on('close', (code) => {
    termSend({ type: 'term-end', id, code: code == null ? -1 : code });
  });
  return { ok: true, id };
});

ipcMain.handle('terminal:stop', () => {
  /* ■: süren komutu (tüm alt süreçleriyle) kes; KALICI kabuk yenilenir —
     son bilinen klasör korunur, cd geçmişi kaybolmaz */
  if (termChild) {
    try { spawn('taskkill', ['/pid', String(termChild.pid), '/T', '/F'], { windowsHide: true }); } catch {}
    try { termChild.kill(); } catch {}
    termChild = null;
  }
  termSend({ type: 'term-end', id: termShellId, code: 130, error: 'komut durduruldu — kalıcı CMD yeniden hazır' });
  termShellId = null;
  return { ok: true };
});

/* ---------------- Beast Code paneli (IDE modu ortası) ----------------
   IDE modunda ortadaki sohbet yerine Beast'in KENDİ ajanı çalışır:
   varsayılan model zinciri + soldaki dosya panelindeki klasör.
   Yazışma SOLDAKİ KLASÖRE BAĞLIDIR: her klasörün kendi gizli engine
   oturumu vardır (klasör değişince sohbet de değişir); sohbet geçmişi
   listesine karışmaz. Olayları renderer zaten agent:event ile alır,
   panele orada akıtılır. */
const bcSessions = new Map(); /* klasör yolu → sessionId */

function bcGetSession(folder) {
  let sid = bcSessions.get(folder);
  if (sid) {
    try {
      const s = engine.cache.get(sid);
      if (s) return s;
    } catch {}
    bcSessions.delete(folder);
  }
  const s = engine._load(engine.createSession().id);
  s.messages = s.messages || [];
  s.bgTitle = 'Beast Code'; /* _view.isBg → sohbet geçmişi listesinde gizli */
  s.bcCode = true; /* engine: her işte todo planı çıkar (BEAST CODE MODU bloğu) */
  try {
    fs.appendFileSync(
      engine._file(s.id),
      JSON.stringify({ t: 'meta2', bgOf: '', title: 'Beast Code', at: new Date().toISOString() }) + '\n'
    );
  } catch {}
  engine.cache.set(s.id, s);
  bcSessions.set(folder, s.id);
  return s;
}

/* Beast Code motoru: TAMAMEN BEAST MOTORU — opencode'in döngü mantığı
   (compaction, prune, prompt-cache, doom-loop, yetim onarım, proje
   talimatları) engine.js'e native port edildi; köprü/alt süreç yok. */

function bcPanelEvent(sid, ev) {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('agent:event', { sessionId: sid, ...ev });
  } catch {}
}

/* Beast Code mesaj kuyruğu: ajan çalışırken gelen mesajlar birikir, iş bitince
   TEK pakette (metinler \n ile birleşik) gönderilir. Boştayken de kısa pencere
   (debounce) vardır — ard arda hızlı mesajlar tek işte birleşir. */
const BC_DEBOUNCE_MS = 900;
const bcQueue = new Map(); /* klasör yolu → { timer, msgs[] } */

function bcQueuePush(ws, text, attachments) {
  let q = bcQueue.get(ws);
  if (!q) {
    q = { timer: null, msgs: [] };
    bcQueue.set(ws, q);
  }
  q.msgs.push({
    text,
    attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined,
  });
  return q;
}

function bcFlush(folder) {
  const q = bcQueue.get(folder);
  if (!q || !q.msgs.length) return;
  const s = bcGetSession(folder); /* oturum yoksa oluşturur */
  if (engine.isBusy(s.id)) return; /* hâlâ çalışıyor — done/error eventini bekle */
  let merged = '';
  let mergedAtts = null;
  for (const m of q.msgs) {
    if (m.text) merged += (merged ? '\n' : '') + m.text;
    if (!mergedAtts && Array.isArray(m.attachments) && m.attachments.length) mergedAtts = m.attachments;
  }
  if (!merged.trim() && !mergedAtts) {
    bcQueue.delete(folder);
    clearTimeout(q.timer);
    return;
  }
  s.workspace = folder;
  s.bcCode = true;
  engine.cache.set(s.id, s);
  const payload = mergedAtts ? { text: merged, attachments: mergedAtts } : merged;
  if (engine.send(s.id, payload, { userAction: true })) {
    bcQueue.delete(folder);
    clearTimeout(q.timer);
  } else {
    /* yarış: az önce meşgul oldu — kuyruk korunur, kısa süre sonra tekrar denenir */
    q.retries = (q.retries || 0) + 1;
    if (q.retries > 5) {
      bcQueue.delete(folder);
      clearTimeout(q.timer);
      try {
        if (win && !win.isDestroyed()) {
          win.webContents.send('agent:event', { sessionId: s.id, type: 'error', error: 'Beast Code mesajı gönderilemedi — panele tekrar yaz' });
        }
      } catch {}
      return;
    }
    setTimeout(() => { try { bcFlush(folder); } catch {} }, 800);
  }
}

function bcFlushOnDone(ev) {
  if (!ev || (ev.type !== 'done' && ev.type !== 'error') || !ev.sessionId) return;
  for (const [folder, sid] of bcSessions) {
    if (String(sid) === String(ev.sessionId) && bcQueue.has(folder)) {
      setTimeout(() => { try { bcFlush(folder); } catch {} }, 150);
    }
  }
}

ipcMain.handle('beastcode:send', async (_e, payload) => {
  const text = String((payload && payload.msg) || '').trim();
  const attachments = Array.isArray(payload && payload.attachments) ? payload.attachments : [];
  if (!text && !attachments.length) return { ok: false, error: 'boş mesaj' };
  if (!engine) return { ok: false, error: 'ajan hazır değil' };
  const ws = ideRoot();
  const modeM = /^\/(plan|build|auto)\b/i.exec(text);

  if (!engine.publicState().hasModel) return { ok: false, error: 'model yok — Ayarlar → Provider sekmesinden ekle' };
  /* oturumu HEMEN aç: cevap daima gerçek sessionId taşır — renderer paneli bu id ile
     eşler; boşta/kuyrukta olsa bile id yoksa panel olayları eşleyemez ve ölü kalır */
  const s = bcGetSession(ws);
  s.workspace = ws; /* soldaki klasörde çalış */
  s.bcCode = true; /* todo disiplini + iş sonu hızlı kapanış (engine) */
  engine.cache.set(s.id, s);
  const busy = engine.isBusy(s.id);
  if (modeM) {
    /* mod değişimi anında uygulanır — meşgulken de (yalnız bayrak; engine çakışmaz) */
    s.bcMode = modeM[1].toLowerCase();
    if (win && !win.isDestroyed()) {
      const body = modeM[1].toLowerCase() === 'plan'
        ? 'PLAN MODU — dosyaları okuyup inceler, KOD YAZMAZ; adım adım uygulama planı verir.'
        : modeM[1].toLowerCase() === 'build'
          ? 'BUILD MODU — son planı UYGULAR: dosyaları düzenler, komutları çalıştırır, doğrular.'
          : 'OTOMATİK MOD — önce kısa plan, sonra uygulama + doğrulama (OpenCode disiplini).';
      win.webContents.send('agent:event', { sessionId: s.id, type: 'bc-mode', mode: s.bcMode, body });
    }
    return { ok: true, sessionId: s.id, mode: s.bcMode };
  }
  if (busy) {
    /* ajan çalışıyor → kuyruğa al; iş bitince (done/error) toplu gider */
    const q = bcQueuePush(ws, text, attachments);
    return { ok: true, queued: true, count: q.msgs.length, sessionId: s.id };
  }
  /* boşta: kısa pencere — hızlı ard arda mesajlar tek işte birleşir */
  const q = bcQueuePush(ws, text, attachments);
  clearTimeout(q.timer);
  q.timer = setTimeout(() => { try { bcFlush(ws); } catch {} }, BC_DEBOUNCE_MS);
  return { ok: true, sessionId: s.id, pending: true };
});

/* BC görev listesi (ID'li) + TEK TUŞ GERİ ALMA: bir görev maddesinin
   değişiklikleri, madde başlamadan önceki kod tabanına döndürülür */
ipcMain.handle('bc:todos', (_e, payload) => {
  try {
    return engine.todoUndoInfo(String((payload && payload.sessionId) || ''));
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.handle('bc:undo', (_e, payload) => {
  try {
    const sid = String((payload && payload.sessionId) || '');
    const todoId = String((payload && payload.todoId) || '');
    return todoId === 'last' ? engine.undoLastTodo(sid) : engine.undoTodo(sid, todoId);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('beastcode:stop', async () => {  const ws = ideRoot();
  const sid = bcSessions.get(ws);
  /* durdurma: bekleyen kuyruğu da boşalt (kullanıcı vazgeçti) */
  const q = bcQueue.get(ws);
  if (q) {
    clearTimeout(q.timer);
    bcQueue.delete(ws);
  }
  const wasBusy = sid ? engine.isBusy(sid) : false;
  let r = false;
  if (wasBusy) {
    try { r = engine.interrupt(sid, 'kullanıcı Beast Code panelinden ■ ile durdurdu'); } catch {}
  }
  return { ok: true, wasBusy, interrupted: r };
});

ipcMain.handle('beastcode:new', async () => {
  const ws = ideRoot();
  const sid = bcSessions.get(ws);
  if (sid && engine.isBusy(sid)) return { ok: false, error: 'mesaj sürüyor — önce ■ ile durdur' };
  const q = bcQueue.get(ws);
  if (q) {
    clearTimeout(q.timer);
    bcQueue.delete(ws);
  }
  if (sid) {
    try { engine.deleteSession(sid); } catch {}
    bcLastServerUrl = ''; /* yeni oturum — eski dev server adresi geçersiz */
    bcSessions.delete(ws);
  }
  return { ok: true };
});

/* düşünme (reasoning) seviyesi */
ipcMain.handle('think:set', (_e, v) => {
  setThinkLevel(v);
  return engine.publicState();
});

/* Obscura stealth headless tarayıcı (Ayarlar → Web Arama) */

/* kurulum durumu: ayarlardan çıkılıp dönülsa da main process'te sürer;
   ilerleme agent:event ile panele, obscura:installState ile sekme açılışına taşınır */
let obscuraInstallState = { running: false, pct: 0, phase: '', error: null };

function pushObscuraProgress() {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'obscura-progress', ...obscuraInstallState });
  } catch {}
}

function startObscuraInstall() {
  if (obscuraInstallState.running) return { ok: false, busy: true, ...obscuraInstallState };
  obscuraInstallState = { running: true, pct: 0, phase: 'hazırlanıyor', error: null };
  pushObscuraProgress();
  obscura
    .installObscura(null, (p) => {
      obscuraInstallState.pct = Math.max(0, Math.min(100, Math.round(Number(p && p.pct) || 0)));
      obscuraInstallState.phase = String((p && p.phase) || obscuraInstallState.phase || '');
      pushObscuraProgress();
    })
    .then((r) => {
      obscuraInstallState = r && r.ok
        ? { running: false, pct: 100, phase: 'tamamlandı', error: null }
        : { running: false, pct: 0, phase: 'hata', error: String((r && r.error) || 'bilinmeyen hata') };
      pushObscuraProgress();
      console.log('[obscura]', r && r.ok ? 'kuruldu: ' + r.dir : 'kurulamadı: ' + ((r && r.error) || '?'));
    })
    .catch((e) => {
      obscuraInstallState = { running: false, pct: 0, phase: 'hata', error: String((e && e.message) || e) };
      pushObscuraProgress();
      console.log('[obscura] kurulamadı:', String((e && e.message) || e));
    });
  return { ok: true, started: true, ...obscuraInstallState };
}

ipcMain.handle('obscura:get', () => ({
  installed: obscura.obscuraInstalled(),
  dir: obscura.obscuraDir(),
  enabled: settings.obscuraEnabled !== false,
  install: { ...obscuraInstallState },
}));
ipcMain.handle('obscura:install', () => startObscuraInstall());
ipcMain.handle('obscura:installState', () => ({ ...obscuraInstallState }));
ipcMain.handle('obscura:setEnabled', (_e, v) => {
  settings.obscuraEnabled = v !== false;
  saveSettings();
  try { setSearchObscuraEnabled(settings.obscuraEnabled); } catch {}
  return { ok: true, enabled: settings.obscuraEnabled };
});

/* Arama zinciri sırası (Ayarlar → Web Arama'dan değiştirilir) */
ipcMain.handle('searchorder:get', () => ({ chain: toolsMod.getSearchChain() }));
ipcMain.handle('searchorder:set', (_e, chain) => {
  try {
    const rows = setSearchChain(chain);
    settings.searchChain = rows;
    saveSettings();
    return { ok: true, chain: rows };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* Sohbet listesi ELLE sıralama (sol panelde sürükle-bırak) */
ipcMain.handle('sessions:order:get', () => ({
  order: Array.isArray(settings.sessionOrder) ? settings.sessionOrder : [],
}));
ipcMain.handle('sessions:order:set', (_e, order) => {
  const arr = Array.isArray(order) ? order.map(String).filter(Boolean).slice(0, 500) : [];
  settings.sessionOrder = arr;
  saveSettings();
  return { ok: true };
});

/* #TinyFish: anahtar girilirse web_search zincirinin BAŞINDA kullanılır */
ipcMain.handle('tinyfish:get', () => {
  const k = settings.tinyfishKey || '';
  return { set: !!k, masked: k ? '••••••••' + k.slice(-4) : '' };
});
ipcMain.handle('tinyfish:set', (_e, key) => {
  const v = String(key || '').trim();
  if (v) {
    settings.tinyfishKey = v;
    saveSettings();
    setTinyfishKey(settings.tinyfishKey);
  }
  const k = settings.tinyfishKey || '';
  return { ok: true, set: !!k, masked: k ? '••••••••' + k.slice(-4) : '' };
});
ipcMain.handle('tinyfish:clear', () => {
  settings.tinyfishKey = '';
  saveSettings();
  setTinyfishKey(null);
  return { ok: true, set: false, masked: '' };
});

/* ---------- SKILLS STORE (sol alt 🧩 butonu → topluluk mağazası) ---------- */

function storeIdentity() {
  return settings.storeUser || { username: '', avatar: '' };
}

ipcMain.handle('store:list', () => {
  const r = storeIdentity();
  return storeMod.list(settings.beastCode || '').then((out) => ({
    ...out,
    identity: { username: r.username || '', avatar: r.avatar || '' },
  }));
});

ipcMain.handle('store:identity:set', (_e, p) => {
  const username = String((p && p.username) || '').trim();
  if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
    return { ok: false, error: 'kullanıcı adı 3-20 karakter (harf/rakam/_/-) olmalı' };
  }
  const beastId = storeMod.beastFingerprint(settings.beastCode || '');
  if (storeMod.usernameTaken(username, beastId)) {
    return { ok: false, error: `"${username}" başka bir Beast tarafından alınmış — başka ad seç` };
  }
  /* avatar kaldırıldı — sabit varsayılan (kartlarda kapak resmi/🧩 gösterilir) */
  settings.storeUser = { username, avatar: (settings.storeUser && settings.storeUser.avatar) || '🧩' };
  saveSettings();
  return { ok: true, identity: { username, avatar: settings.storeUser.avatar, beastId } };
});

ipcMain.handle('store:pick', async () => {
  try {
    const r = await dialog.showOpenDialog({
      title: 'Skill klasörü seç (SKILL.md içermeli)',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    return storeMod.preview(r.filePaths[0]);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('store:commit', (_e, p) => {
  return storeMod.commit({
    dirPath: p && p.path,
    name: p && p.name,
    description: p && p.description,
    tags: p && p.tags,
    author: {
      username: storeIdentity().username,
      avatar: storeIdentity().avatar,
      beastId: storeMod.beastFingerprint(settings.beastCode || ''),
      image: (p && p.image) || '',
    },
  });
});

ipcMain.handle('store:install', (_e, id) => storeMod.install(id));

ipcMain.handle('store:like', (_e, id) => storeMod.toggleLike(id));

ipcMain.handle('store:remove', (_e, id) =>
  storeMod.removeMine(id, storeMod.beastFingerprint(settings.beastCode || ''))
);

ipcMain.handle('store:export', (_e, id) => storeMod.exportEntry(id));

/* ---------- IDE MODU (sol: dosya gezgini · orta: chat · sağ: preview) ---------- */

const IDE_TEXT_EXT = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.json',
  '.md', '.txt', '.csv', '.py', '.ps1', '.bat', '.cmd', '.sh', '.yaml', '.yml',
  '.xml', '.ini', '.svg', '.gitignore',
]);
const IDE_MAX_BYTES = 400 * 1024;

function ideRoot() {
  /* kullanıcı panelde başka klasör seçtiyse o kök alınır; yoksa agent workspace'i */
  return path.resolve(settings.ideRoot || settings.workspace || app.getPath('home'));
}

ipcMain.handle('ide:setroot', async () => {
  try {
    const r = await dialog.showOpenDialog({
      title: 'Klasör seç — dosya paneli ve preview bu klasörü kullanır',
      defaultPath: ideRoot(),
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    settings.ideRoot = r.filePaths[0];
    saveSettings();
    ideWatchStart(); // yeni kökte izleme yeniden kurulur
    return { ok: true, root: settings.ideRoot };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* rel yol → workspace içinde kal (path traversal kilidi) */
function ideSafe(rel) {
  const root = ideRoot();
  const p = path.resolve(root, String(rel || ''));
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  return p;
}

/* ---------- IDE DOSYA AĞACI CANLI İZLEME ----------
   Soldaki klasör paneli ELLE yenilemeden güncellensin: workspace kökü
   fs.watch (recursive) ile izlenir; node_modules/.git gürültüsü elenir,
   500ms debounce ile renderer'a 'ide-tree-changed' düşer. Ajan dışında
   (kullanıcı kaydı, git, harici program) değişen dosyalar da yakalanır. */
let ideWatcher = null;
let ideWatchTimer = null;
let ideWatchRoot = '';
function ideWatchStart() {
  const root = ideRoot();
  if (ideWatcher && ideWatchRoot === root) return;
  ideWatchStop();
  /* ev dizininin KÖKÜNÜ izlemek AppData gürültüsü yüzünden paneli sürekli
     yeniler — özel klasör seçiliyken (ideRoot/workspace) izleme aktiftir */
  if (root === app.getPath('home')) return;
  try {
    fs.accessSync(root); // kök yoksa izleme kurma
  } catch {
    return;
  }
  ideWatchRoot = root;
  try {
    ideWatcher = fs.watch(root, { recursive: true }, (_evType, fname) => {
      const f = String(fname || '').replace(/\\/g, '/');
      if (/^(node_modules|\.git|dist|\.next|\.nuxt)(\/|$)/i.test(f)) return;
      if (ideWatchTimer) return;
      ideWatchTimer = setTimeout(() => {
        ideWatchTimer = null;
        try {
          if (win && !win.isDestroyed()) {
            win.webContents.send('agent:event', { type: 'ide-tree-changed' });
          }
        } catch {}
      }, 500);
    });
    ideWatcher.on('error', () => {
      ideWatchStop();
      /* kök klasör silinip yeniden yaratıldıysa kısa süre sonra tekrar dene */
      setTimeout(() => { try { ideWatchStart(); } catch {} }, 3000);
    });
    try { log.info('ide', 'ağaç izleme açık: ' + root); } catch {}
  } catch {}
}
function ideWatchStop() {
  if (ideWatcher) { try { ideWatcher.close(); } catch {} }
  ideWatcher = null;
  ideWatchRoot = '';
  if (ideWatchTimer) { clearTimeout(ideWatchTimer); ideWatchTimer = null; }
}

ipcMain.handle('ide:tree', (_e, rel) => {
  const p = ideSafe(rel);
  if (!p) return { ok: false, error: 'geçersiz yol' };
  try {
    const entries = fs.readdirSync(p, { withFileTypes: true })
      .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
      .map((e) => {
        let size = 0;
        try { if (e.isFile()) size = fs.statSync(path.join(p, e.name)).size; } catch {}
        return { name: e.name, dir: e.isDirectory(), size };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { ok: true, workspace: ideRoot(), entries };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('ide:read', (_e, rel) => {
  const p = ideSafe(rel);
  if (!p) return { ok: false, error: 'geçersiz yol' };
  const ext = path.extname(p).toLowerCase();
  if (ext && !IDE_TEXT_EXT.has(ext)) return { ok: false, error: 'metin dosyası değil — düzenlenemez' };
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) return { ok: false, error: 'klasör' };
    if (st.size > IDE_MAX_BYTES) return { ok: false, error: 'dosya çok büyük (max 400KB)' };
    const buf = fs.readFileSync(p);
    if (buf.slice(0, 4096).includes(0)) return { ok: false, error: 'ikili (binary) dosya' };
    return { ok: true, content: buf.toString('utf8') };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('ide:write', (_e, p) => {
  const target = ideSafe(p && p.rel);
  if (!target) return { ok: false, error: 'geçersiz yol' };
  const ext = path.extname(target).toLowerCase();
  if (ext && !IDE_TEXT_EXT.has(ext)) return { ok: false, error: 'metin dosyası değil — yazılamaz' };
  try {
    const body = String((p && p.content) ?? '');
    if (Buffer.byteLength(body, 'utf8') > IDE_MAX_BYTES) return { ok: false, error: 'içerik çok büyük (max 400KB)' };
    fs.writeFileSync(target, body, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* Sağ tık menüsü: dosya/klasör sil (onay diyaloglu) */
ipcMain.handle('ide:delete', async (_e, rel) => {
  const p = ideSafe(rel);
  if (!p || p === ideRoot()) return { ok: false, error: 'geçersiz yol' };
  try {
    const st = fs.statSync(p);
    const isDir = st.isDirectory();
    const owner = win && !win.isDestroyed() ? win : undefined;
    const r = owner
      ? await dialog.showMessageBox(owner, {
          type: 'warning',
          title: 'Sil',
          message: `"${rel}" ${isDir ? 'klasörünü (içi dahil)' : 'dosyasını'} silmek istiyor musun?`,
          buttons: ['Sil', 'Vazgeç'],
          defaultId: 1,
          cancelId: 1,
        })
      : { response: 1 };
    if (r.response !== 0) return { ok: false, canceled: true };
    fs.rmSync(p, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* Sağ tık menüsü: HTML dosyasını dahili tarayıcıda GÖRÜNÜR aç */
/* ---------- BC DAHİLİ STATİK SUNUCU ----------
   Beast Code çıktısı ASLA file:// ile açılmaz: ES modülleri, fetch, ServiceWorker
   ve "clean URL" yolları file://'da çalışmaz. Her preview http://127.0.0.1 üzerinden
   servis edilir; ajan kendi dev sunucusunu başlattıysa o adres önceliklidir. */
let bcLastServerUrl = ''; /* ajanın başlattığı dev server adresi (bc-preview'dan yakalanır) */
const bcStatic = { server: null, root: '', base: '' };
const BC_MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.xml': 'application/xml', '.csv': 'text/csv',
};
function bcStaticHandler(req, res) {
  try {
    let rel = decodeURIComponent(String((req && req.url) || '/').split('?')[0]);
    rel = rel.replace(/^\/+/, '');
    const fp = path.resolve(bcStatic.root, rel);
    if (fp !== bcStatic.root && !fp.startsWith(bcStatic.root + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    const isFile = (p) => { try { return fs.statSync(p).isFile() ? p : null; } catch { return null; } };
    let hit = isFile(fp);
    if (!hit) hit = isFile(path.join(fp, 'index.html')); /* dizin → index.html */
    if (!hit) hit = isFile(fp + '.html');                /* clean URL: /hakkinda → hakkinda.html */
    if (!hit) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 — /' + rel); return; }
    const ext = path.extname(hit).toLowerCase();
    res.writeHead(200, { 'Content-Type': BC_MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(hit).pipe(res);
  } catch (e) {
    try { res.writeHead(500); res.end('server error'); } catch {}
  }
}
function bcStaticStart(root) {
  return new Promise((resolve) => {
    const r = path.resolve(String(root || ''));
    if (bcStatic.server && bcStatic.root === r) { resolve(bcStatic.base); return; }
    if (bcStatic.server) { try { bcStatic.server.close(); } catch {} bcStatic.server = null; }
    const srv = http.createServer(bcStaticHandler);
    srv.on('error', () => resolve(''));
    srv.listen(0, '127.0.0.1', () => {
      bcStatic.server = srv;
      bcStatic.root = r;
      bcStatic.base = 'http://127.0.0.1:' + srv.address().port;
      try { log.info('bc', 'statik sunucu: ' + bcStatic.base + ' → ' + r); } catch {}
      resolve(bcStatic.base);
    });
  });
}
/* Preview'a basılınca BC oturumuna SESSİZ bağlam enjeksiyonu (observe — tur
   AÇMAZ, maliyet yok): ajan dahili sunucunun çalıştığını bilir ve statik
   dosyalar için kendi sunucusunu başlatma denemez → çakışma biter */
function bcTellServe(staticBase) {
  try {
    const ws = ideRoot();
    const sid = bcSessions.get(ws);
    if (!sid) return;
    engine.observe(sid,
      '[PREVIEW] Kullanıcı önizlemeyi açtı — DAHİLİ STATİK SUNUCU şu adreste ÇALIŞIYOR: ' + staticBase + '\n' +
      'Statik dosyalar için KENDİ sunucunu BAŞLATMA; üretilen siteyi bu adres üzerinden değerlendir.\n' +
      'Yalnızca gerçek dev-server/build gerekiyorsa (React/Vite/Next/Expo: npm run dev, expo start) ' +
      'kendi sunucunu BLOKLAMADAN arka planda başlat ve çalışan adresi yaz.'
    );
  } catch {}
}

ipcMain.handle('ide:previewFile', async (_e, rel) => {
  try {
    const p = ideSafe(rel);
    if (!p) return { ok: false, error: 'geçersiz yol' };
    if (!/\.html?$/i.test(p)) return { ok: false, error: 'önizleme yalnız .html/.htm dosyaları için' };
    const base = await bcStaticStart(ideRoot());
    if (!base) return { ok: false, error: 'statik sunucu başlatılamadı' };
    const root = ideRoot();
    const relPath = path.relative(root, p).replace(/\\/g, '/');
    const url = base + '/' + relPath;
    setBrowserOpen(true, true);
    browser.view.webContents.loadURL(url).catch(() => {});
    browserEmit({ open: true, width: browserShownWidth(browserW()), url });
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* PREVIEW: workspace kökündeki siteyi DAİMA sunucudan aç —
   1) ajan bir dev server başlattıysa onun adresi, 2) yoksa dahili statik sunucu.
   file:// ASLA kullanılmaz (JS/clean URL kırılmaları). Ayrıca ajana SUNUCU
   komutu düşer: uygulama sunucu istiyorsa kendisi başlatıp adresi yazar. */
ipcMain.handle('ide:preview', async () => {
  try {
    const root = ideRoot();
    const pick = (name) => {
      const p = path.join(root, name);
      try { return fs.existsSync(p) ? p : null; } catch { return null; }
    };
    let entry = pick('index.html');
    if (!entry) {
      const htmls = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
        .map((e) => e.name);
      entry = htmls.length ? path.join(root, htmls.sort()[0]) : null;
    }
    if (!entry) return { ok: false, error: 'workspace kökünde index.html yok — önce agent\'a siteyi yazdır' };
    /* forceVisible: preview'a basınca tarayıcı ikonuna basmaya gerek kalmasın */
    setBrowserOpen(true, true);
    let url = '';
    if (bcLastServerUrl) {
      url = bcLastServerUrl; /* ajanın kendi dev sunucusu öncelikli */
    } else {
      const base = await bcStaticStart(root);
      if (!base) return { ok: false, error: 'statik sunucu başlatılamadı' };
      url = base + '/';
    }
    browser.view.webContents.loadURL(url).catch(() => {});
    browserEmit({ open: true, width: browserShownWidth(browserW()), url });
    if (!bcLastServerUrl) bcTellServe(url.replace(/\/$/, ''));
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* BEAST CODE otomatik canlı önizleme: iş bitince üretilen site/app dahili
   tarayıcıda GÖRÜNÜR açılır. Yalnız localhost kabul edilir; file:// gelen
   eser adresi DAHİLİ STATİK SUNUCUYA çevrilir — dosyadan ASLA açılmaz. */
ipcMain.handle('ide:previewUrl', async (_e, url) => {
  try {
    const u = String(url || '');
    let target = '';
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?(?:\/|$)/i.test(u)) {
      target = u;
    } else if (/^file:\/\/\//i.test(u)) {
      const raw = decodeURIComponent(u.replace(/^file:\/\/\//, '')).replace(/\/$/, '');
      const fp = path.resolve(raw);
      const root = ideRoot();
      const rel = path.relative(root, fp).replace(/\\/g, '/');
      let base;
      if (rel && !rel.startsWith('..')) {
        base = await bcStaticStart(root);
        if (!base) return { ok: false, error: 'statik sunucu başlatılamadı' };
        target = base + '/' + rel;
      } else {
        /* workspace dışı eser — dosyanın kendi klasörü kök alınır */
        base = await bcStaticStart(path.dirname(fp));
        if (!base) return { ok: false, error: 'statik sunucu başlatılamadı' };
        target = base + '/' + path.basename(fp);
      }
    } else {
      return { ok: false, error: 'yalnız localhost adresleri önizlenebilir' };
    }
    /* Expo/Metro dev sunucusu → telefon modu OTOMATİK (mobil uygulama canlı önizleme) */
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1):(8081|19000|19001|19002|3000|5173)\//i.test(target)) {
      if (!browser.phone) setBrowserPhone(true);
    }
    /* forceVisible: otomatik ve GÖRÜNÜR açılır */
    setBrowserOpen(true, true);
    browser.view.webContents.loadURL(target).catch(() => {});
    let wNow = 0;
    try { wNow = win.getContentSize()[0]; } catch {}
    browserEmit({ open: true, width: browserShownWidth(wNow), url: target });
    return { ok: true, url: target };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('custom:set', (_e, list) => {
  settings.customProviders = Array.isArray(list) ? list : [];
  saveSettings();
  engine.setCustomProviders(settings.customProviders);
  return engine.publicState();
});

/* #Model refresh: taban zinciri tazele + kayıtlı tüm custom providerların
   modellerini yeniden çek (picker anında güncellenir). */
ipcMain.handle('models:refresh', async () => {
  try {
    const cfg = loadBeastConfig();
    if (cfg && engine.refreshBaseChain) engine.refreshBaseChain(cfg);
  } catch (e) {
    log.error('main', 'model refresh (base): ' + String((e && e.message) || e));
  }
  let updated = 0;
  const list = Array.isArray(settings.customProviders) ? settings.customProviders : [];
  for (const p of list) {
    if (!p || !p.baseUrl || !p.key) continue;
    try {
      const b = String(p.baseUrl).trim().replace(/\/+$/, '');
      const url = /\/v\d+$/.test(b) ? b + '/models' : b + '/v1/models';
      const h = { Authorization: 'Bearer ' + p.key };
      try {
        if (new URL(url).hostname === 'api.anthropic.com') {
          h['x-api-key'] = p.key;
          h['anthropic-version'] = '2023-06-01';
        }
      } catch {}
      const res = await fetch(url, {
        headers: h,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const models = (json.data || json.models || [])
        .map((m) => (typeof m === 'string' ? m : m.id || m.name))
        .filter(Boolean);
      const uniq = [...new Set(models)].sort();
      if (uniq.length && JSON.stringify(uniq) !== JSON.stringify(p.models || [])) {
        p.models = uniq;
        updated++;
      }
    } catch {}
  }
  if (updated) {
    settings.customProviders = list;
    saveSettings();
    engine.setCustomProviders(list);
  }
  log.info('main', `model refresh: taban tazelendi, ${updated} custom provider güncellendi`);
  return engine.publicState();
});

ipcMain.handle('providers:builtin', () => BUILTIN_PROVIDERS);

/* ---------------- FEATURE 1: TEK TIKLA MODEL (OpenCode Zen Free) ----------------
   Akış: token var mı (env / opencode auth.json) → yoksa CLI kur (npm) →
   auth login penceresi aç → token çıkana dek bekle → free modelleri çek →
   customProviders'a işle → .env'e de yaz. Hata olursa anlaşılır mesaj döner. */

const ZEN_BASE = 'https://opencode.ai/zen/v1';
const ZEN_ENV_KEY = 'OPENCODE_API_KEY';
const ZEN_PRESET_ID = 'preset-opencode-zen';

function opencodeAuthCandidates() {
  const h = app.getPath('home');
  const appdata = process.env.APPDATA || path.join(h, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(h, 'AppData', 'Local');
  return [
    process.env.OPENCODE_API_KEY || '',
    path.join(h, '.local', 'share', 'opencode', 'auth.json'),
    path.join(h, '.config', 'opencode', 'auth.json'),
    path.join(appdata, 'opencode', 'auth.json'),
    path.join(local, 'opencode', 'auth.json'),
  ];
}

/* auth.json'daki { key: "..." } girdilerini derin tara; opencode/zen girdisini yeğle */
function findZenKeyDeep(node, prefer) {
  const found = [];
  const walk = (n, parentKey) => {
    if (!n || typeof n !== 'object') return;
    if (typeof n.key === 'string' && n.key.length > 8) found.push({ parentKey, key: n.key });
    for (const [k, v] of Object.entries(n)) {
      if (v && typeof v === 'object') walk(v, typeof k === 'string' ? k : parentKey);
    }
  };
  walk(node, '');
  if (prefer) {
    const hit = found.find((f) => prefer.test(f.parentKey));
    if (hit) return hit.key;
  }
  return found.length ? found[0].key : '';
}

function findZenToken() {
  for (const c of opencodeAuthCandidates()) {
    if (!c) continue;
    if (!c.toLowerCase().endsWith('auth.json')) {
      if (String(c).length > 8) return String(c); // env değeri
      continue;
    }
    try {
      const j = JSON.parse(fs.readFileSync(c, 'utf8'));
      const key = findZenKeyDeep(j, /opencode|zen/i);
      if (key) {
        log.info('main', 'zen token bulundu: ' + c);
        return key;
      }
    } catch {}
  }
  return '';
}

async function fetchZenFreeModels() {
  try {
    const res = await fetch(ZEN_BASE + '/models', { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const j = await res.json();
      const ids = (j.data || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
      /* Zen'de ücretsizler: "-free" ekli modeller + big-pickle (gizli model, sınırlı süre ücretsiz) */
      const free = ids.filter((id) => /-free$/.test(id) || id === 'big-pickle');
      if (free.length) return free;
    }
  } catch {}
  /* API cevap vermezse bilinen free liste */
  return ['big-pickle', 'deepseek-v4-flash-free', 'mimo-v2.5-free', 'hy3-free', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'laguna-s-2.1-free'];
}

function upsertZenEnv(token) {
  try {
    const envPath = path.join(beastDir(), '.env');
    let text = '';
    try { text = fs.readFileSync(envPath, 'utf8'); } catch {}
    const line = ZEN_ENV_KEY + '=' + token;
    const re = new RegExp('^' + ZEN_ENV_KEY + '=.*$', 'm');
    if (re.test(text)) text = text.replace(re, line);
    else text = (text.trim() ? text.trimEnd() + '\n' : '') + line + '\n';
    fs.writeFileSync(envPath, text);
  } catch {}
}

function applyZenProvider(key, models) {
  const entry = { id: ZEN_PRESET_ID, name: 'OpenCode Zen', baseUrl: ZEN_BASE, key, models };
  const list = Array.isArray(settings.customProviders)
    ? settings.customProviders.filter((p) => p.id !== ZEN_PRESET_ID)
    : [];
  list.unshift(entry);
  settings.customProviders = list;
  saveSettings();
  upsertZenEnv(key); // token beast config'e (.env) kaydedilir — her açılışta kullanılır
  if (engine) engine.setCustomProviders(settings.customProviders);
  return entry;
}

async function hasOpencodeCli() {
  return new Promise((resolve) => {
    try {
      const { execFile } = require('child_process');
      execFile('where.exe', ['opencode'], { windowsHide: true }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

function runNpmGlobalInstall() {
  return new Promise((resolve) => {
    try {
      const { execFile } = require('child_process');
      execFile('cmd.exe', ['/c', 'npm install -g opencode-ai'], { windowsHide: true, timeout: 300000 }, (err) => {
        resolve(err ? { ok: false, error: String((err && err.message) || err) } : { ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

/* auth login etkileşimlidir (tarayıcı açar) — kullanıcı görsün diye ayrı pencere.
   -ExecutionPolicy Bypass: SADECE bu pencere için — Windows varsayılan "Restricted"
   politikası npm'in opencode.ps1 shim'ini bloklar ("running scripts is disabled")
   → taze makinede tek tık kurulum patlamasın; sistem politikası DEĞİŞMEZ. */
function openZenAuthWindow() {
  try {
    spawn(
      'cmd.exe',
      ['/c', 'start', '', 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', 'opencode auth login'],
      { detached: true, windowsHide: false, stdio: 'ignore' }
    ).unref();
    return true;
  } catch {
    return false;
  }
}

/* auth.json belirleyene dek bekle (kullanıcı tarayıcıda giriş yapıyor) */
function pollZenToken(ms = 180000) {
  const step = 3000;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const key = findZenToken();
      if (key) return resolve(key);
      if (Date.now() - t0 >= ms) return resolve('');
      setTimeout(tick, step);
    };
    tick();
  });
}

/* TEK MODEL CANLILIK TESTİ: minik chat isteği — 200 + choices dönerse model çalışıyor */
async function testZenModel(key, model) {
  try {
    const res = await fetch(ZEN_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        stream: false,
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return { model, ok: false, status: res.status };
    const j = await res.json().catch(() => null);
    const ch = j && j.choices && j.choices[0];
    const ok = !!(ch && ch.message && typeof ch.message.content === 'string');
    return { model, ok, status: res.status };
  } catch (e) {
    return { model, ok: false, status: 0, error: String((e && e.message) || e) };
  }
}

/* Modelleri 4'lü gruplar halinde paralel test et (hesap geneli hız limitini zorlamamak için) */
async function testZenModels(key, models) {
  const results = [];
  const BATCH = 4;
  for (let i = 0; i < models.length; i += BATCH) {
    const slice = models.slice(i, i + BATCH);
    const rs = await Promise.all(slice.map((m) => testZenModel(key, m)));
    results.push(...rs);
  }
  return results;
}

ipcMain.handle('zen:oneClick', async () => {
  try {
    /* 1) token zaten var mı? (env / auth.json) */
    let key = findZenToken();
    if (!key) {
      /* 2) OpenCode CLI yoksa npm'den kur */
      if (!(await hasOpencodeCli())) {
        log.info('main', 'OpenCode CLI yok — npm install -g opencode-ai');
        const ins = await runNpmGlobalInstall();
        if (!ins.ok) {
          return { ok: false, error: 'OpenCode CLI kurulamadı (' + (ins.error || '?') + ') — npm kurulu mu?' };
        }
      }
      /* 3) giriş penceresi aç, auth.json çıkana dek bekle */
      if (!openZenAuthWindow()) return { ok: false, error: 'giriş penceresi açılamadı — Provider sekmesinden anahtarı elle girebilirsin' };
      key = await pollZenToken(180000);
      if (!key) {
        return { ok: false, error: 'giriş tamamlanmadı (3 dk) — açılan pencerede giriş yapıp tekrar bas' };
      }
    }
    /* 4) free adayları çek → HER MODELİ CANLI TEST ET → sadece çalışanları ekle */
    const candidates = await fetchZenFreeModels();
    const results = await testZenModels(key, candidates);
    const models = results.filter((r) => r.ok).map((r) => r.model);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      log.info('main', 'zen test: yanıt vermeyenler → ' + failed.map((f) => f.model + (f.status ? ' (' + f.status + ')' : '')).join(', '));
    }
    if (!models.length) {
      const authFail = failed.some((f) => f.status === 401 || f.status === 403);
      return {
        ok: false,
        error: authFail
          ? 'API anahtarı geçersiz ya da yetkisiz (HTTP 401/403)'
          : 'hiçbir free model şu an yanıt vermedi (' +
            failed.map((f) => f.model + (f.status ? ' · ' + f.status : '')).join(', ') +
            ')',
      };
    }
    const entry = applyZenProvider(key, models);
    /* hiç model seçili değilse ilk ÇALIŞAN modeli varsayılan yap */
    try {
      if (!engine.publicState().activeModel) {
        const sel = 'custom:' + ZEN_PRESET_ID + '::' + models[0];
        settings.modelOverride = sel;
        saveSettings();
        engine.setModelOverride(sel);
      }
    } catch {}
    log.info('main', `OpenCode Zen tek tık kurulum: ${models.length}/${candidates.length} model testi geçti, eklendi (${entry.name})`);
    return {
      ok: true,
      models,
      tested: candidates.length,
      failed: failed.map((f) => f.model + (f.status ? ' (' + f.status + ')' : '')),
      provider: entry.name,
    };
  } catch (e) {
    log.error('main', 'zen oneClick hata: ' + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('custom:fetchModels', async (_e, { baseUrl, key }) => {
  try {
    let b = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(b)) return { ok: false, error: 'URL http(s) ile başlamalı' };
    const url = /\/v\d+$/.test(b) ? b + '/models' : b + '/v1/models';
    const headers = key ? { Authorization: 'Bearer ' + key } : {};
    /* Anthropic: /v1/models yerel API — x-api-key + versiyon başlığı ister */
    try {
      if (new URL(url).hostname === 'api.anthropic.com') {
        if (key) headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
      }
    } catch {}
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const json = await res.json();
    const models = (json.data || json.models || [])
      .map((m) => (typeof m === 'string' ? m : m.id || m.name))
      .filter(Boolean);
    return { ok: true, models: [...new Set(models)].sort() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* ---------------- WhatsApp IPC ---------------- */

ipcMain.handle('wa:start', () => {
  ensureWa().start().catch(() => {});
  return wa.snapshot();
});

ipcMain.handle('wa:stop', async () => {
  if (wa) await wa.stop();
  return { status: 'disconnected' };
});

ipcMain.handle('wa:reset', async () => {
  if (!wa) ensureWa();
  await wa.resetAuth();
  return { status: 'disconnected' };
});

ipcMain.handle('wa:status', () => (wa ? wa.snapshot() : { status: 'disconnected', available: true }));

ipcMain.handle('wa:allow:get', () => settings.waAllow || []);

/* FEATURE 2: kuyruk durumu (Entegrasyonlar panelinde gösterilir) */
ipcMain.handle('wa:queue:get', () => mqueue.stats());

ipcMain.handle('wa:sessions', () => [...waChats.values()]);

ipcMain.handle('wa:tts:get', () => settings.waTts || {});
ipcMain.handle('wa:tts:set', (_e, cfg) => {
  settings.waTts = {
    enabled: !!(cfg && cfg.enabled),
    baseUrl: String((cfg && cfg.baseUrl) || '').trim(),
    key: String((cfg && cfg.key) || '').trim(),
    model: String((cfg && cfg.model) || '').trim(),
    voice: String((cfg && cfg.voice) || '').trim(),
  };
  saveSettings();
  return settings.waTts;
});

/* ---------- Telegram IPC (FEATURE 3) ---------- */

ipcMain.handle('tg:status:get', () => {
  if (!tg) return { configured: !!settings.tgToken, status: 'disconnected', user: null, connected: false };
  return { configured: true, ...tg.snapshot() };
});

/* token kaydet + köprüyü (yeniden) başlat */
ipcMain.handle('tg:set', async (_e, token) => {
  const t = String(token || '').trim();
  if (t) settings.tgToken = t;
  saveSettings();
  await restartTg();
  return { configured: !!settings.tgToken, ...(tg ? tg.snapshot() : { status: 'disconnected', user: null }) };
});

ipcMain.handle('tg:start', async () => {
  if (!settings.tgToken) return { ok: false, error: 'token yok — önce bot tokenı gir' };
  await restartTg();
  return { ok: true, ...(tg ? tg.snapshot() : {}) };
});

ipcMain.handle('tg:stop', async () => {
  if (tg) {
    try { await tg.stop(); } catch {}
  }
  return { ok: true };
});

ipcMain.handle('tg:allow:get', () => settings.tgAllow || []);
ipcMain.handle('tg:allow:set', (_e, list) => {
  settings.tgAllow = Array.isArray(list) ? list : [];
  saveSettings();
  return settings.tgAllow;
});
ipcMain.handle('tg:sessions', () => [...tgChats.values()]);

/* ---------- Discord IPC ---------- */
ipcMain.handle('dc:status:get', () => {
  if (!dc) return { configured: !!settings.dcToken, status: 'disconnected', user: null, connected: false };
  return { configured: true, ...dc.snapshot() };
});

/* token kaydet + köprüyü (yeniden) başlat */
ipcMain.handle('dc:set', async (_e, token) => {
  const t = String(token || '').trim();
  if (t) settings.dcToken = t;
  saveSettings();
  await restartDc();
  return { configured: !!settings.dcToken, ...(dc ? dc.snapshot() : { status: 'disconnected', user: null }) };
});

ipcMain.handle('dc:start', async () => {
  if (!settings.dcToken) return { ok: false, error: 'token yok — önce bot tokenı gir' };
  await restartDc();
  return { ok: true, ...(dc ? dc.snapshot() : {}) };
});

ipcMain.handle('dc:stop', async () => {
  if (dc) {
    try { await dc.stop(); } catch {}
  }
  return { ok: true };
});

ipcMain.handle('dc:allow:get', () => settings.dcAllow || []);
ipcMain.handle('dc:allow:set', (_e, list) => {
  settings.dcAllow = Array.isArray(list) ? list : [];
  saveSettings();
  return settings.dcAllow;
});
ipcMain.handle('dc:sessions', () => [...dcChats.values()]);

/* ---------- e-posta IPC ---------- */

ipcMain.handle('email:get', () => {
  const cfg = { ...emailCfg() };
  /* Şifreyi renderera düz metin sızdırma; boş alan = değişmedi anlamında */
  if (cfg.pass) cfg.pass = '***';
  return cfg;
});
ipcMain.handle('email:set', (_e, cfg) => {
  const cur = settings.email || {};
  const newPass = String((cfg && cfg.pass) ?? '').trim();
  settings.email = {
    host: String((cfg && cfg.host) || '').trim() || 'imap.gmail.com',
    port: Number(cfg && cfg.port) || 993,
    user: String((cfg && cfg.user) || '').trim(),
    /* Boş veya maskeli gelen şifre = mevcut anahtarı koru */
    pass: newPass && newPass !== '***' ? newPass : String(cur.pass || ''),
    smtpHost: String((cfg && cfg.smtpHost) || '').trim() || 'smtp.gmail.com',
    smtpPort: Number(cfg && cfg.smtpPort) || 465,
  };
  saveSettings();
  return { ...settings.email, pass: settings.email.pass ? '***' : '' };
});

/* ---------- ekran görüntüsü ---------- */

/* Ana ekrandan JPEG dataURL yakalar (computer_use ve screen:capture ortak) */
async function captureScreenDataUrl() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1600, height: 900 },
    });
    if (!sources.length) return null;
    let best = sources[0];
    for (const s of sources) {
      const a = s.thumbnail.getSize();
      const b = best.thumbnail.getSize();
      if (a.width * a.height > b.width * b.height) best = s;
    }
    const img = best.thumbnail.resize({ width: 1280 });
    const jpeg = img.toJPEG(72);
    if (!jpeg || !jpeg.length) return null;
    return 'data:image/jpeg;base64,' + jpeg.toString('base64');
  } catch {
    return null;
  }
}

ipcMain.handle('screen:capture', async () => {
  const image = await captureScreenDataUrl();
  return image ? { ok: true, image } : { ok: false, error: 'ekran görüntüsü alınamadı' };
});

/* #26 ajanın send_file aracı: dosyayı doğru kanala (WA veya chat) ulaştırır.
   Paralel ajan işiyse parent sohbete, masaüstünde dosya kartı olarak düşer. */
const FILE_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
async function deliverFile(sessionId, filePath, caption) {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(engine.workspace || process.cwd(), filePath);
    if (!fs.existsSync(abs)) return { ok: false, error: 'dosya bulunamadı: ' + abs };
    const name = path.basename(abs);
    const ext = path.extname(abs).toLowerCase();
    let sid = String(sessionId || '');
    try {
      const job = engine.listBgJobs().find((j) => j.id === sid);
      if (job && job.parentId) sid = job.parentId; // paralel ajan → parent sohbet
    } catch {}
    /* WhatsApp hedefi: bu oturum bir WA sohbetine bağlıysa oraya gönder */
    let jid = null;
    for (const [j, s] of waChats) {
      if (s === sid) { jid = j; break; }
    }
    if (jid && wa) {
      const buf = fs.readFileSync(abs);
      const ok = FILE_IMAGE_EXT.has(ext)
        ? await wa.sendImage(jid, buf, caption || name)
        : await wa.sendFile(jid, buf, name, caption);
      if (ok) return { ok: true, channel: 'whatsapp', name };
    }
    /* masaüstü: sohbete dosya kartı bas */
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:event', { sessionId: sid, type: 'file', path: abs, name, caption: caption || '' });
      return { ok: true, channel: 'chat', name };
    }
    return { ok: false, error: 'gönderim hedefi bulunamadı (WA kapalı, pencere gizli)' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(String(p || '')));
ipcMain.handle('shell:showItem', (_e, p) => {
  shell.showItemInFolder(String(p || ''));
  return true;
});

ipcMain.handle('wa:allow:set', (_e, list) => {
  const before = JSON.stringify(settings.waAllow || []);
  const out = [];
  let ownerCount = 0;
  for (const item of Array.isArray(list) ? list : []) {
    // '*' herkese açık bayrağı
    if (item === '*' || (item && item.num === '*')) { out.push('*'); continue; }
    const rawNum = typeof item === 'string' ? item : String((item && item.num) || '');
    const name = typeof item === 'string' ? '' : String((item && item.name) || '').trim().slice(0, 40);
    const permRaw = typeof item === 'object' && item.perm;
    const perm = ['all', 'web', 'read', 'chat'].includes(permRaw)
      ? permRaw
      : typeof item === 'object' && item.lockdown ? 'chat' : 'all';
    /* #v13.1: owner bayrağı — yalnız BİR kişi sahip olabilir */
    const wantsOwner = typeof item === 'object' && !!item.owner;
    const d = rawNum.replace(/\D/g, '');
    if (d.length >= 6) {
      const isOwner = wantsOwner && ownerCount === 0;
      if (isOwner) ownerCount++;
      out.push({
        num: d,
        name,
        lockdown: perm === 'chat',
        perm,
        owner: isOwner,
        bot_id: typeof item === 'object' && item.bot_id && bots.get(item.bot_id) ? item.bot_id : undefined,
      });
    }
  }
  /* tek izinli kişi varsa MECBURİ sahip (kimseye seçtirmeden) */
  const nonStar = out.filter((o) => o !== '*');
  if (nonStar.length === 1 && !nonStar[0].owner) {
    nonStar[0].owner = true;
  }
  settings.waAllow = out;
  saveSettings();
  syncWhitelist(); // whitelist.json aynası + silinen bota bağlı numaraları temizle
  /* sahibi MEMORY.md + USER.md'ye işle (ajan kiminle konuştuğunu bilsin) */
  try {
    const owner = out.find((o) => o !== '*' && o.owner);
    if (owner) {
      memory.addRule(`Beast'in SAHİBİ ${owner.name} (+${owner.num}). Onun talepleri önceliklidir.`);
      memory.save('USER.md', `${owner.name} (WhatsApp: +${owner.num}) — Beast'in sahibi.\nDiğer izinli numaralar MISAFİRDİR; sahibiyle çelişirse sahibin sözü geçer.`);
    }
  } catch {}
  /* #v13: izinli listeye YENİ numara eklendiyse temiz durum için otomatik restart */
  if (!before.includes(JSON.stringify(out)) ) {
    const addedNew = out.some((o) => {
      if (o === '*') return !JSON.parse(before).includes('*');
      return !JSON.parse(before).some((b) => b && b.num === o.num);
    });
    if (addedNew) {
      waLog('yeni izinli kişi eklendi — uygulama 3 sn içinde otomatik yeniden başlatılıyor');
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 3000);
    }
  }
  return settings.waAllow;
});

/* ---------------- BOT SİSTEMİ IPC ---------------- */

ipcMain.handle('bots:list', () => botListWithNumbers());

ipcMain.handle('bots:add', (_e, input) => {
  const r = bots.add(input || {});
  if (r.ok) {
    log.info('main', `yeni bot: ${r.bot.name} (${r.bot.id}) kod=${r.bot.code}`);
    /* BOT KODU MAİL BİLDİRİMİ: bot oluşur oluşmez sahibine mail atılır */
    try {
      const cfg = emailCfg();
      if (cfg.host && cfg.user && cfg.pass) {
        emailSend({
          to: cfg.user,
          subject: `Beast Agent — yeni bot kuruldu: ${r.bot.name} (kod ${r.bot.code})`,
          body:
            `Yeni bot oluşturuldu.\n\n` +
            `Ad: ${r.bot.name}\n` +
            `Bot kodu: ${r.bot.code}\n` +
            `Zaman: ${new Date().toLocaleString('tr-TR')}\n\n` +
            `Bu 5 haneli kod botlar arası DM adresidir — bot_dm aracında 'to' olarak kullanılır.\n` +
            `Sol alttaki bot listesinde de görüntülenir.`,
        }).catch(() => {});
      }
    } catch {}
  }
  return { ...r, list: r.ok ? botListWithNumbers() : null };
});

/* Botlar arası DM izleme (admin) */
ipcMain.handle('bots:dm:list', () => engine.listBotDmSessions());
ipcMain.handle('bots:dm:read', (_e, id) => engine.readBotDm(id));

/* GITHUB MODALI → Trending / Tüm Repolar: GitHub Search API.
   opts.mode: 'trend' (varsayılan) | 'all' (tüm repolar — yıldız tabanı yok)
   opts.range: all | 6m | 1m | 2w | 1w  (tüm zamanlar / 6 ay / 1 ay / 2 hafta / 1 hafta)
   opts.order: desc (azalan) | asc (artan) — yıldız sırası
   opts.q: arama terimi (trend modunda tarih filtresi UYGULANMAZ — her zaman tüm zamanlar)
   Kimliksiz 60 istek/saat limiti var — 403'te UI bilgi gösterir. */
ipcMain.handle('github:trending', async (_e, opts) => {
  const o = opts && typeof opts === 'object' ? opts : {};
  const mode = o.mode === 'all' ? 'all' : 'trend';
  const range = ['all', '6m', '1m', '2w', '1w'].includes(o.range) ? o.range : '2w';
  const order = o.order === 'asc' ? 'asc' : 'desc';
  const q = String(o.q || '').trim().slice(0, 120);
  const days = { all: 0, '6m': 180, '1m': 30, '2w': 14, '1w': 7 }[range];
  const since = days ? new Date(Date.now() - days * 86400000).toISOString().slice(0, 10) : '';
  /* aralık başına yıldız tabanı: listeler anlamlı kalsın diye */
  const floor = { all: 5000, '6m': 200, '1m': 50, '2w': 20, '1w': 10 }[range];
  let query;
  let useSort = true; /* 'all' + best eşleşmede sort param gönderilmez */
  if (mode === 'all') {
    if (!q) return { ok: true, items: [] };
    query = q; /* yıldız tabanı YOK — 0 yıldızlı dahil tüm repolar bulunur */
    if (o.allSort === 'best') useSort = false;
  } else if (q) {
    /* arama modu: tarih filtresi YOK — her zaman tüm zamanlar içinde arar,
       yıldız sırasına göre döner (küçük taban: çöp listelenmesin diye) */
    query = q + ' stars:>=10';
  } else if (range === 'all') {
    query = 'stars:>=' + floor;
  } else {
    query = 'created:>=' + since + ' stars:>=' + floor;
  }
  let url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(query).replace(/%20/g, '+') + '&per_page=20';
  if (useSort) url += '&sort=stars&order=' + order;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'beast-agent' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 403 || res.status === 429) {
      return { ok: false, error: 'GitHub API limiti doldu (403) — bir saat sonra tekrar dene' };
    }
    if (!res.ok) return { ok: false, error: 'GitHub API ' + res.status };
    const data = await res.json();
    const items = (data.items || []).map((r) => ({
      full_name: r.full_name,
      html_url: r.html_url,
      description: String(r.description || '').slice(0, 240),
      language: r.language || '',
      stars: r.stargazers_count || 0,
      pushed_at: r.pushed_at || '',
    }));
    return { ok: true, items };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('bots:update', (_e, { id, patch }) => {
  const p = patch || {};
  if (Array.isArray(p.numbers)) reassignBotNumbers(String(id || ''), p.numbers);
  const r = bots.update(String(id || ''), p);
  syncWhitelist();
  if (engine) {
    /* yetki değişen botun aktif oturumlarını tazele (araç seti + persona) */
    try {
      for (const v of engine.listSessions()) {
        if ((v.botId || 'beast') === String(id || '')) {
          const cfg = bots.get(String(id));
          engine.setSessionTools(v.id, cfg && !cfg.admin ? botToolSet(cfg) : null);
          engine.setSessionModel(v.id, cfg && !cfg.admin ? (cfg.model || null) : null);
        }
      }
    } catch {}
  }
  return { ...r, list: r.ok ? botListWithNumbers() : null };
});

ipcMain.handle('bots:remove', (_e, id) => {
  const r = bots.remove(String(id || ''));
  if (r.ok) {
    /* bağlı numaraları botsuz yap (beast'e düşer) */
    for (const e of settings.waAllow || []) {
      if (e && e !== '*' && e.bot_id === String(id || '')) delete e.bot_id;
    }
    saveSettings();
    syncWhitelist();
    log.info('main', `bot silindi: ${id} — bağlı numaralar botsuz (beast'e düşer)`);
    /* bot silme sonrası sistem KİTLENİYOR (oturum/DM/servis referansları) →
       güvenli yol: bot kaydı silindikten sonra uygulamayı temiz yeniden başlat */
    if (String(id || '') !== 'beast') scheduleAppRestart(1200);
  }
  return { ...r, list: r.ok ? botListWithNumbers() : null, restarting: r.ok && String(id || '') !== 'beast' };
});

ipcMain.handle('bots:stats', () => botStats());

/* Botlar arası geçiş: masaüstü UI'ı hangi botun kimliğiyle çalışsın */
ipcMain.handle('bots:active:get', () => ({
  id: settings.activeBotId && bots.get(settings.activeBotId) ? settings.activeBotId : 'beast',
}));

ipcMain.handle('bots:activate', (_e, id) => {
  const b = bots.get(String(id || ''));
  settings.activeBotId = b ? b.id : 'beast';
  saveSettings();
  log.info('main', `aktif bot: ${settings.activeBotId}`);
  return { ok: true, activeBotId: settings.activeBotId };
});

/* BEAST (admin) botun "kendi" hafızası = GLOBAL Beast hafızasıdır.
   Agent konuşmalarda GLOBAL memories/ klasörüne yazar; bot sekmesi de orayı
   gösterir ki "kaydettim" dediği kayıtları kullanıcı GERÇEKTEN görsün. */
ipcMain.handle('bots:memory:get', (_e, id) => {
  const bid = String(id || '');
  if (bid === 'beast') return { ok: true, ...memory.loadAll() };
  return { ok: true, ...bots.readMemoryFiles(bid) };
});

ipcMain.handle('bots:memory:set', (_e, { id, file, content }) => {
  const bid = String(id || '');
  if (bid === 'beast') return memory.save(String(file || ''), content);
  return bots.writeMemoryFile(bid, file, content);
});

ipcMain.handle('bots:log:get', (_e, id) => ({ ok: true, content: bots.readLog(String(id || '')) }));
