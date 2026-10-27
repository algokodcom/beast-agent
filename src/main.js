'use strict';

const { app, BrowserWindow, WebContentsView, webContents, ipcMain, shell, dialog, Tray, Menu, nativeImage, desktopCapturer, screen, session, net: electronNet, clipboard, Notification, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const dns = require('dns');
const crypto = require('crypto');
/* x-opencode-session: opencode (Zen/Go) isteklerinde beklenen oturum kimliği —
   kurulum/probe/model-liste istekleri için süreç-başına sabit değer; sohbet
   isteklerindeki konuşma-başına kimlik agent/llm.js'te üretilir */
const OPENCODE_SESSION = 'beast-' + crypto.randomUUID();
const { spawn } = require('child_process');
const { Engine, OBSERVE_MARK, stripAiDashes } = require('./agent/engine');
const { loadBeastConfig, parseEnvFile, beastDir } = require('./agent/config');
const { OpenCodeBridge, BRIDGE_PROVIDER_ID, DEFAULT_FREE_MODELS, findOpenCodeBin } = require('./agent/opencode-bridge');
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
const duyu = require('./agent/duyu');
const ema = require('./agent/ema');
const ahenk = require('./agent/ahenk'); // TTS motor 2: Ahenk Cep (ozgurguler/ahenk-cep-tr)
const edgetts = require('./agent/edgetts'); // TTS motor 3: Microsoft Edge — ücretsiz online sinir ağı (artık takılı)
const piper = require('./agent/piper'); // TTS motor 4: Piper — tamamen yerel, ~21MB, zayıf makine için
const supertonic = require('./agent/supertonic'); // TTS motor 5: Supertonic — yerel ONNX, 31 dil
const ttsstream = require('./agent/ttsstream'); // telefon TTS akışı — cevabı cümlelere böl
const fsguard = require('./agent/fsguard');
const device = require('./agent/device');
const mobileWs = require('./agent/mobile');
const mobileTunnel = require('./agent/mobileTunnel');
const os = require('os');
const log = require('./agent/logger');
const squeeze = require('./agent/squeeze');
const chansessions = require('./agent/channelsessions');
const typesafeMod = require('./agent/typesafe');
const tslearn = require('./agent/tslearn');
const customtools = require('./agent/customtools');
const QRCode = require('qrcode'); /* Expo Go QR (bc-expurl) — whatsapp ile aynı paket */

/* Renderer'a sır gönderirken kullanılan maske; kaydederken aynen geri gelirse
   gerçek değer korunur (anahtarlar UI'da düz metin dolaşmaz). */
const SECRET_MASK = '***';

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

/* /version ORTAK METNİ — tüm kanallar (desktop/WA/TG/DC): güncel sürüm +
   npm'deki en son sürüm (yeni varsa vurgulu; 10dk cache'li getNpmLatest). */
async function versionText(waStyle) {
  const cur = beastVersion();
  const latest = await getNpmLatest();
  const b = waStyle ? '*' : '**';
  if (latest && isNewerVersion(latest, cur)) {
    return (
      `${b}Beast Agent v${cur}${b} — ${b}yeni sürüm var: v${latest}${b}\n` +
      `Güncelleme: ${b}/update${b} (kontrol) · ${b}/update now${b} (hemen kur)`
    );
  }
  if (latest) {
    return `${b}Beast Agent v${cur}${b} — güncel ✓\nGüncelleme kontrolü: ${b}/update${b} · hemen kur: ${b}/update now${b}`;
  }
  return `${b}Beast Agent v${cur}${b}\nGüncelleme: ${b}/update${b} (yeni sürüm kontrolü) · ${b}/update now${b} (hemen kur)`;
}

/* SÜRÜM GÜNCELLEMESİ BİLGİSİ: sürüm değiştiyse İLK AÇILIŞTA kullanıcı'nın
   olduğu yere kısa bilgi düşer — en güncel oturum (desktop) + o oturuma
   BĞLI kanal (WA/TG/DC; hangisindeyse oraya). settings.lastRunVersion
   yazıldığı için sürüm başına YALNIZ BİR KEZ çalışır. */
function notifyVersionUpdate() {
  const cur = beastVersion();
  const prev = String(settings.lastRunVersion || '');
  settings.lastRunVersion = cur;
  saveSettings();
  if (!prev || prev === cur) return; /* ilk kurulum ya da sürüm değişmedi */
  const waStyleTxt =
    `🔄 *Beast Agent güncellendi:* v${prev} → *v${cur}*\n` +
    `Yenilikler: GitHub Releases · Sürüm: /version · Güncelleme: /update`;
  let sid = '';
  try { sid = reuseOrLatestSession(''); } catch {}
  /* desktop + cam aynı bilgi balonu — ("beast agent'ta görünüyor camda değil") sürüm duyurusu */
  try {
    if (sid) {
      const mdTxt = waStyleTxt.replace(/\*/g, '**');
      emitWaBoth({ sessionId: sid, type: 'message', message: { role: 'assistant', content: mdTxt } });
      emitWaBoth({ sessionId: sid, type: 'done', usage: null });
    }
  } catch {}
  /* kanallar: SAHİBE tek satır (kişi sohbetleri kanal oturumudur —
     sürüm duyurusu müşteri/kişi sohbetlerine KARIŞMAZ) */
  (async () => {
    try {
      if (wa && wa.connected) {
        const own = waOwnerNum();
        if (own) await sendWaSafe(own + '@s.whatsapp.net', waStyleTxt);
      }
    } catch {}
    try {
      if (tg && tg.connected) for (const id of tgOwnerIds()) await sendTgSafe(id, waStyleTxt);
    } catch {}
    try {
      if (dc && dc.connected) for (const id of dcOwnerIds()) await sendDcSafe(id, waStyleTxt);
    } catch {}
  })();
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
const mcpMod = require('./agent/mcp');
const { htmlToText, setSearchChain, setTinyfishKey } = toolsMod;
/* OpenCode köprüsü KALDIRILDI: Beast Code artık tamamen BEAST motoruyla
   çalışır — opencode'in döngü mantığı (compaction, prune, cache disiplini,
   doom-loop, yetim onarım) engine.js'e native port edildi. */
const { waToolLine } = require('./agent/watext');

/* #3 merkezî log sistemine process-seviye hataları da düşsün */
process.on('uncaughtException', (e) => { try { log.error('main', 'uncaughtException: ' + ((e && e.stack) || e)); } catch {} });
process.on('unhandledRejection', (e) => { try { log.error('main', 'unhandledRejection: ' + ((e && e.stack) || e)); } catch {} });

/* #1 Splash /health — her zaman açık uç nokta: uygulamanın ayakta olduğunu bildirir.
   NOT: eski default 8788 idi → MOBILE KÖPRÜ ile PM ÇAKIŞMASI yapardı (Windows iki
   server'ın aynı portu "başarıyla" bind etmesine izin verir); ngrok agent
   127.0.0.1'e dokununca köprüye değil HEALTH'e düşüyor, 404/3004 dönüyordu.
   Health artık ayrı portta (healthPort ayarı verilmediyse 8789). */
function startHealthServer() {
  const port = Number(settings.healthPort) || 8789;
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
/* Windows kimliği: görev çubuğu ikonu + toast bildirim adı/işareti için
   AppUserModelID ŞART. Özel AUMID, kayıtlı kısayol yoksa taskbar ikonunu
   electron.exe logosuna düşürür — bu yüzden atama, whenReady'de AUMID'li
   kısayollar (masaüstü + Başlat menüsü) hazırlandıktan SONRA yapılır. */
const BEAST_AUMID = 'com.quantumalgo.beastagent';
try { app.setName('Beast Agent'); } catch {}
function assignAppUserModelId() {
  try {
    const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Beast Agent.lnk');
    const desktop = path.join(app.getPath('desktop'), 'Beast Agent.lnk');
    if (app.isPackaged || fs.existsSync(startMenu) || fs.existsSync(desktop)) {
      app.setAppUserModelId(BEAST_AUMID);
    }
  } catch {}
}
/* mem0-native embedding modeli kendi cache'ini kullanır (src/agent/mem0.js okur) */
process.env.BEAST_MODELS_DIR = path.join(APP_DIR, 'models');

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
/* MASAÜSTÜ CAM SOHBET: ana uygulamanın sağ üst pencere butonlarındaki CAM
   düğmesiyle açılan neon-glass sohbet katmanı — uygulama "cam moduna" döner
   (ana pencere gizlidir, camdaki ✕/Return ile tekrar masaüstü moduna dönülür) */
let glassWin = null;
let engine = null;
/* Paralel ajan durum takibi: bitişte BİR kez toast bildirimi (spam yok) */
const bgNotifSeen = new Map(); // sid -> son görülen durum
let settings = loadSettings();
ensureBeastCode();
startHealthServer(); /* splash/boot aşamasından itibaren /health ayakta */
try { setSearchChain(settings.searchChain); } catch {}
try { setTinyfishKey(settings.tinyfishKey || null); } catch {}
/* TypeSafe (System One/Jev) köprüsü: ajan araçları ayarlardaki anahtarı canlı okur */
try {
  typesafeMod.setConfig(() => ({
    apiKey: settings.typesafe && settings.typesafe.apiKey,
    model: settings.typesafe && settings.typesafe.model,
    enabled: !(settings.typesafe && settings.typesafe.enabled === false),
  }));
} catch {}
let wa = null;
let waChats = new Map(); // jid (numara/grup) -> KENDİ oturumu: her sohbet AYRI (gizlilik)
let waCronSid = null; // WhatsApp CRON TABAN OTURUMU: otomatik işler; hiçbir kişiye bağlı DEĞİL
let waHistory = new Map(); // jid -> [sid,...] bu sohbete ait tüm oturumlar
let waBcMode = new Set(); // jid -> BeastCode modu AKTİF (WhatsApp'tan uzaktan kodlama)
let waJidPn = new Map(); // jid -> gerçek telefon numarası (LID fallback için)
let waLastActiveJid = ''; // en son mesaj gelen WA sohbeti — cevap/dosya hedefi önceliği
let desktopActiveSid = ''; // masaüstü UI'da AÇIK olan oturum — proaktif not buraya işlenir
const WA_HISTORY_CAP = 20;
let tg = null;
let tgChats = new Map(); // telegram chatId -> KENDİ oturumu: her sohbet AYRI (gizlilik)
let tgCronSid = null; // Telegram CRON TABAN OTURUMU: otomatik işler; hiçbir kişiye bağlı DEĞİL
let tgHistory = new Map(); // chatId -> [sid,...]
const TG_HISTORY_CAP = 20;
let tgLastActiveChatId = ''; // en son mesaj gelen TG sohbeti — cron yansıtma hedefi
/* Botun gördüğü Telegram GRUPLARI: chatId -> {title, at}. Ajan DM ↔ Telegram
   köprüsü kurulumunda grup seçimi bu listeden yapılır (BotFather'da gizlilik
   kapatılmalı ya da bot gruba admin olmalı ki mesajlar düşsün). */
let tgGroups = {};
try {
  const raw = settings.tgGroups;
  if (raw && typeof raw === 'object') {
    for (const [id, v] of Object.entries(raw)) {
      if (v && typeof v === 'object') tgGroups[String(id)] = { title: String(v.title || ''), at: Number(v.at) || 0 };
    }
  }
} catch {}
let dc = null;
let dcChats = new Map(); // discord channelId -> KENDİ oturumu: her kanal AYRI (gizlilik)
let dcCronSid = null; // Discord CRON TABAN OTURUMU: otomatik işler; hiçbir kişiye bağlı DEĞİL
let dcHistory = new Map(); // channelId -> [sid,...]
const DC_HISTORY_CAP = 20;
let dcLastActiveChannelId = ''; // en son mesaj gelen DC kanalı — cron yansıtma hedefi
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
    /* CRON TABAN OTURUMU: kişi sohbetlerinden tamamen bağımsız oturum */
    if (typeof raw.cron === 'string' && raw.cron) waCronSid = raw.cron;
    /* BeastCode modu: hangi sohbetler uzaktan kodlama yapıyor */
    if (Array.isArray(raw.bcMode)) {
      for (const j of raw.bcMode) if (typeof j === 'string') waBcMode.add(j);
    }
  }
} catch {}
/* GÖÇ: eski "tek oturum" düzeni → kişi başına oturum (sahip bağlamı korunur) */
try { waMigrateSharedSessions(); } catch {}

function saveWaChats() {
  try {
    fs.writeFileSync(
      WA_CHATS_FILE,
      JSON.stringify({
        chats: Object.fromEntries(waChats),
        history: Object.fromEntries([...waHistory.entries()].map(([j, a]) => [j, a.slice(-WA_HISTORY_CAP)])),
        bcMode: [...waBcMode],
        cron: waCronSid || '',
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

/* Oturum anahtarı: DM'lerde GERÇEK numara esas alınır — LID/cihaz eki aynı
   kişiyi iki oturuma bölmesin; gruplar kendi jid'iyle ayrı kalır. */
function waSessionKey(jid) {
  return chansessions.dmSessionKey(jid, waJidPn.get(String(jid || '')));
}

/* GÖÇ (tek oturum → kişi başına oturum): ortak oturum SAHİPTE kalır;
   diğer sohbetler ayrılır, o oturuma erişemez (geçmişten de düşürülür). */
function waMigrateSharedSessions() {
  return chansessions.migrateSharedSessions({
    chats: waChats,
    history: waHistory,
    ownerDigits: waOwnerNum(),
    historyCap: WA_HISTORY_CAP,
  });
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
  const key = waSessionKey(jid);
  if (waChats.get(key) !== s.id) {
    waChats.set(key, s.id);
    waRememberSession(key, s.id);
    saveWaChats();
    if (wa) wa.setWatchJids([...waChats.keys()]);
  }
  return s;
}

/* /beastagent: kişinin KENDİ sohbet oturumuna dön (Beast Code oturumundan çık).
   Geçmişteki en güncel yaşayan sohbet oturumu kullanılır; yoksa taze açılır. */
function waRestoreChatSession(jid) {
  const key = waSessionKey(jid);
  const bcSid = waChats.get(key);
  const hist = [...(waHistory.get(key) || [])].reverse();
  for (const h of hist) {
    if (!h || h === bcSid || !sessionFileAlive(h)) continue;
    try {
      const s = engine.cache.get(h) || engine._load(h);
      if (s && s.bcCode) continue; /* Beast Code oturumlarına dönülmez */
      waChats.set(key, h);
      saveWaChats();
      if (wa) wa.setWatchJids([...waChats.keys()]);
      return h;
    } catch {}
  }
  waChats.delete(key);
  return ensureWaSession(jid);
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
  /* Supermemory (lokal) DEFAULT AÇIK — sunucu ayaktayken daha akıllı bellek;
     ayakta değilken klasik hafıza sorunsuz çalışır (engine fallback) */
  if (!parsed.supermemory || typeof parsed.supermemory !== 'object') {
    parsed.supermemory = { enabled: true, baseUrl: 'http://localhost:6767', apiKey: '', containerTag: 'beast' };
  }
  /* TypeSafe (System One/Jev) — anahtar Ayarlar → TypeSafe sekmesinden girilir;
     boşken typesafe_decision aracı anlaşılır hata döner */
  if (!parsed.typesafe || typeof parsed.typesafe !== 'object') {
    parsed.typesafe = { apiKey: '', model: 'jev-latest', enabled: true };
  }
  if (typeof parsed.typesafe.model !== 'string' || !parsed.typesafe.model.trim()) parsed.typesafe.model = 'jev-latest';
  if (typeof parsed.typesafe.enabled !== 'boolean') parsed.typesafe.enabled = true;
  /* OpenCode Bridge yalnız kullanıcı tek tıkla kurduysa açık kalır. */
  if (typeof parsed.opencodeBridge !== 'boolean') parsed.opencodeBridge = false;
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

/* Gelen grup mesajından grubu hatırla — ajan DM köprüsü grup seçicisi bu
   listeden beslenir. Başlık değişmedikçe diske yazılmaz (yalnız tazeleme). */
function tgRememberGroup(chatId, title) {
  const id = String(chatId || '');
  if (!id) return;
  const cur = tgGroups[id];
  const t = String(title || '');
  const at = Date.now();
  if (cur && (cur.title === t || !t)) {
    cur.at = at;
    return;
  }
  tgGroups[id] = { title: t || (cur && cur.title) || id, at };
  settings.tgGroups = tgGroups;
  try { saveSettings(); } catch {}
}

function tgGroupsList() {
  return Object.entries(tgGroups)
    .map(([id, v]) => ({ id, title: String((v && v.title) || id), at: Number((v && v.at) || 0) }))
    .sort((a, b) => b.at - a.at);
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

/* ---------- STT: Duyu-small (yerel ONNX int8, TR+EN) — TEK motor ----------
   KaanAydinli/Duyu-small (conformer + CTC/attention); model
   %APPDATA%\beast\duyu-small, çıkarım src/agent/duyu.js python köprüsünde.
   Öncelik → mod: 0 önizleme (ctc greedy) · 1 canlı final (attention beam 2)
   · belirtilmemiş (WA sesli mesaj) attention beam 5 (en doğru). */

function sttEngineLabel() {
  return 'Duyu-small (yerel ONNX int8 · TR+EN)';
}

/* ---------- Kurulum yüzde göstergesi: agent modüllerinden gelen progress
   renderer'a 'install-progress' event'i olarak akıtılır (throttle'lı);
   installPctState'i install:status da okur (sekme sonradan açılırsa ilk
   çizimde yüzde zaten dolu gelir). ---------- */
const installPctState = {}; // id -> { pct, loaded, total, ts }
{
  const bus = require('./agent/progressbus');
  const lastSent = new Map(); // id -> { t, pct }
  bus.onInstallProgress((id, d) => {
    try {
      if (!id || !d || typeof d.pct !== 'number' || !isFinite(d.pct)) return;
      const cur = {
        pct: Math.max(0, Math.min(100, Math.round(d.pct))),
        loaded: d.loaded || 0,
        total: d.total || 0,
        ts: Date.now(),
      };
      installPctState[id] = cur;
      const now = Date.now();
      const prev = lastSent.get(id) || { t: 0, pct: -1 };
      /* aynı yüzde tekrarını ve <500ms'lik küçük sıçramaları yut (event fırtınası olmasın) */
      if (cur.pct === prev.pct && now - prev.t < 3000) return;
      if (now - prev.t < 500 && Math.abs(cur.pct - prev.pct) < 2) return;
      lastSent.set(id, { t: now, pct: cur.pct });
      if (win && !win.isDestroyed()) {
        win.webContents.send('agent:event', { type: 'install-progress', id, pct: cur.pct, loaded: cur.loaded, total: cur.total });
      }
    } catch {}
  });
}

/* ogg/opus/mp3 → mono 16kHz Float32 PCM (ffmpeg ile) */
/* Ses çöz: önce stdin pipe (hızlı); moov-sonda m4a gibi pipe'ta
   çözülemeyen dosyalarda GEÇİCİ DOSYA yolu (ffmpeg seek edebilir).
   ffmpeg 'error' olayları ve stdin EPIPE yutulur — süreç düşmez. */
function decodeAudioToPcm16k(buf) {
  const { resolveFfmpegPath } = require('./agent/ffmpegpath');
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) return Promise.reject(new Error('ffmpeg bulunamadı (ffmpeg-static eksik + PATH te yok)'));
  const { spawn } = require('child_process');
  const runFfmpeg = (input, outPcm) => new Promise((res, rej) => {
    let p;
    try {
      p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', input, '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1']);
    } catch (e) { return rej(e); }
    const chunks = [];
    let err = '';
    let done = false;
    /* 120 sn tavan: asılı ffmpeg, STT öncelikli sırasını sonsuza kadar kilitlemesin */
    const killTimer = setTimeout(() => {
      if (done) return;
      done = true;
      try { p.kill(); } catch {}
      rej(new Error('ffmpeg zaman aşımı'));
    }, 120000);
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => { err += c.toString(); });
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(killTimer); rej(e); } });
    p.stdin.on('error', () => {}); /* EPIPE: ffmpeg erken kapandı — yut */
    p.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      const pcm = Buffer.concat(chunks);
      if (code !== 0 && !pcm.length) return rej(new Error('ffmpeg ' + code + ': ' + err.slice(0, 200)));
      const f32 = new Float32Array(Math.floor(pcm.length / 2));
      for (let i = 0; i < f32.length; i++) f32[i] = pcm.readInt16LE(i * 2) / 32768;
      res(f32);
    });
    try { p.stdin.write(outPcm); p.stdin.end(); } catch (e) {
      try { p.kill(); } catch {}
      if (!done) { done = true; clearTimeout(killTimer); rej(e); }
    }
  });
  return (async () => {
    try {
      const f = await runFfmpeg('pipe:0', buf);
      if (f && f.length) return f;
    } catch {}
    /* PIPE ÇÖZEMEDİ (moov-sonda m4a: "partial file") → dosyadan dene */
    const dir = path.join(os.tmpdir(), 'beast-stt');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const tmp = path.join(dir, 'in_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.bin');
    fs.writeFileSync(tmp, buf);
    try {
      const f2 = await runFfmpeg(tmp, Buffer.alloc(0));
      if (f2 && f2.length) return f2;
      throw new Error('ses çözülemedi (boş PCM)');
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  })();
}

/* Enerji kapısı (Silero VAD muadili): konuşma enerjisi yoksa model HİÇ
   çağrılmaz — sessizlik/gürültüden transkript üretilmez. */
const STT_SILENCE_RMS = 200 / 32768; // int16 200 eşdeğeri
const STT_MIN_SPEECH_MS = 200; // bu kadar konuşma yoksa "sessiz" say

function hasSpeechEnergy(f32) {
  if (!f32 || !f32.length) return false;
  const win = 1600; // 100ms @ 16kHz
  let speechFrames = 0;
  for (let i = 0; i < f32.length; i += win) {
    let sum = 0;
    const end = Math.min(i + win, f32.length);
    for (let j = i; j < end; j++) sum += f32[j] * f32[j];
    const rms = Math.sqrt(sum / Math.max(1, end - i));
    if (rms >= STT_SILENCE_RMS) speechFrames++;
  }
  return speechFrames * 100 >= STT_MIN_SPEECH_MS;
}

/* ---------- STT ÖNCELİKLİ SIRASI: konuşanın final cevabı (öncelik 1) canlı
   önizleme işlerinin (0) önüne geçer; birikse bile sıra bozulmaz. ---------- */
const sttQ = [];
let sttRunning = false;
function enqueueSttTask(task, priority) {
  return new Promise((resolve, reject) => {
    sttQ.push({ task, priority: priority || 0, resolve, reject });
    if (!sttRunning) drainSttQ();
  });
}
async function drainSttQ() {
  sttRunning = true;
  while (sttQ.length) {
    let best = 0;
    for (let i = 1; i < sttQ.length; i++) {
      if ((sttQ[i].priority || 0) > (sttQ[best].priority || 0)) best = i;
    }
    const job = sttQ.splice(best, 1)[0];
    try { job.resolve(await job.task()); } catch (e) { job.reject(e); }
  }
  sttRunning = false;
}

async function transcribeAudio(buf, langOverride /* 'tr' | 'en' | 'auto' */, mimetype, priority) {
  return enqueueSttTask(() => transcribeAudioInner(buf, langOverride, priority), priority);
}

/* öncelik → Duyu modu: 0 önizleme (ctc greedy, en hızlı) · 1 canlı final
   (attention beam 2 — hız/doğruluk dengesi) · yok = WA sesli mesaj
   (attention beam 5 — en doğru) */
function sttDecodeOpts(priority) {
  if (priority === 0) return { mode: 'ctc', beam: 1 };
  if (priority === 1) return { mode: 'auto', beam: 2 };
  return { mode: 'auto', beam: 5 };
}

async function transcribeAudioInner(buf, langOverride /* 'tr' | 'en' | 'auto' */, priority) {
  try {
    let f32 = null;
    /* WAV HIZLI YOLU: eller-serbest segmentleri 16k mono WAV gelir —
       ffmpeg decode atlanır, doğrudan PCM okunur */
    if (buf.length > 44 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf.readUInt32LE(24) === 16000 && buf.readUInt16LE(22) === 1 && buf.readUInt16LE(34) === 16) {
      try {
        const dataLen = buf.readUInt32LE(40);
        const arr = new Float32Array(Math.floor(dataLen / 2));
        for (let i = 0; i < arr.length; i++) arr[i] = buf.readInt16LE(44 + i * 2) / 32768;
        if (arr.length) f32 = arr;
      } catch {}
    }
    if (!f32) f32 = await decodeAudioToPcm16k(buf);
    if (!f32 || !f32.length) return null;
    if (!hasSpeechEnergy(f32)) return null;

    /* dil: arayüz dili ile hizalı — TR ise Türkçe, EN ise İngilizce, auto serbest */
    const uiLang = langOverride || settings.sttLang || 'tr';
    const lang = uiLang === 'en' ? 'en' : uiLang === 'auto' ? 'auto' : 'tr';
    const topts = { lang, ...sttDecodeOpts(priority) };

    /* SÜRE LİMİTİ YOK — SESSİZ NOKTADAN BÖL: model ~30 sn üstünde güvenilir
       değil; tek istekte uzun ses 120 sn worker timeout'una takılıyordu.
       Sabit 9 sn kesim ise kelimeleri ortadan bölüyordu. Çözüm: ~24 sn'lik
       pencereler; kesim her sınırın ±4 sn içindeki EN SESSİZ noktadan
       (cümle/kelime arası) seçilir, parçalar sırayla çevrilip birleştirilir. */
    const SR = 16000;
    const PART_S = 24;
    const LIMIT_S = 28;
    const MAX_PARTS = 80; /* ~32 dk tavan — sonsuz kayıtta runaway olmasın */
    /* uzun seste hız: beam 5 → 2 (kalite farkı küçük, süre belirgin düşer) */
    if (f32.length > 30 * SR && topts.beam > 2) topts.beam = 2;
    const parts = splitSpeechWindows(f32, SR, PART_S, LIMIT_S, MAX_PARTS);
    const texts = [];
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      const sec = part.length / SR;
      /* worker timeout: parça süresiyle ölçekle — uzun parça inference'ı
         yarıda kesilmesin (eski sabit 120 sn 90+ sn seste patlıyordu) */
      const timeoutMs = Math.max(120000, Math.round(sec) * 12000);
      try {
        const t = String(await duyu.transcribe(part, { ...topts, timeoutMs }) || '').trim();
        if (t) texts.push(t);
      } catch (e) {
        waLog('stt parça ' + (pi + 1) + '/' + parts.length + ' hata (' + sec.toFixed(0) + ' sn): ' + String((e && e.message) || e));
      }
    }
    const text = joinTranscriptParts(texts);
    return text || null;
  } catch (e) {
    waLog('stt hata: ' + String((e && e.message) || e));
    return null;
  }
}

/* Uzun sesi SESSİZ NOKTALARDAN ~24 sn'lik pencerelere böl (model ≤30 sn
   utterance'lerde en iyi çalışır; sabit kesim kelimeyi ortadan böler, cümle
   arası kesim bölmez). Her 20 ms'lik karede RMS hesaplanır; kesim hedefin
   ±4 sn içindeki en düşük enerjili noktaya konur. */
function splitSpeechWindows(f32, sr, maxS, limitS, maxParts) {
  const n = f32.length;
  const limit = limitS * sr;
  const cap = Math.max(1, maxParts || 80);
  if (n <= limit) return [f32];
  const frame = Math.max(1, Math.round(sr / 50)); /* 20 ms */
  const nf = Math.ceil(n / frame);
  const rms = new Float32Array(nf);
  for (let i = 0; i < nf; i++) {
    const start = i * frame;
    const end = Math.min(start + frame, n);
    let sum = 0;
    for (let j = start; j < end; j++) sum += f32[j] * f32[j];
    rms[i] = Math.sqrt(sum / Math.max(1, end - start));
  }
  const out = [];
  let start = 0;
  while (n - start > limit && out.length < cap - 1) {
    const target = start + maxS * sr;
    const lo = Math.max(start + sr, target - 4 * sr);
    const hi = Math.min(n - sr, target + 4 * sr);
    let cut = target;
    if (hi > lo) {
      let best = Infinity;
      const i0 = Math.floor(lo / frame);
      const i1 = Math.min(nf, Math.ceil(hi / frame));
      for (let i = i0; i < i1; i++) {
        if (rms[i] < best) { best = rms[i]; cut = i * frame; }
      }
    }
    if (cut <= start) cut = Math.min(start + limit, n);
    out.push(f32.subarray(start, cut));
    start = cut;
  }
  out.push(f32.subarray(start));
  return out;
}

/* parça transkriptlerini birleştir: bitişik parçaların başı/sonu tekrar
   edebiliyordu — en fazla 3 kelimelik tekrarı teke düşür */
function joinTranscriptParts(parts) {
  const out = [];
  for (const p of parts) {
    const cur = String(p || '').trim();
    if (!cur) continue;
    if (out.length) {
      const prev = out[out.length - 1].split(/\s+/);
      const curt = cur.split(/\s+/);
      let k = 0;
      const maxK = Math.min(3, prev.length, curt.length);
      while (k < maxK && prev[prev.length - 1 - k].toLowerCase() === curt[k].toLowerCase()) k++;
      out.push(k ? curt.slice(k).join(' ') : cur);
    } else {
      out.push(cur);
    }
  }
  return out.join(' ').replace(/\s{2,}/g, ' ').trim();
}

/* TTS motoru seçimi: 'ema' (varsayılan) · 'ahenk' · 'edge' (ücretsiz online) ·
   'piper' (ultra hafif yerel, ~21MB) · 'supertonic' (yerel ONNX, 31 dil).
   Beş motor da takılı: seçilmeyenler ya yedek zincirinde ya da panelde kurulumla. */
const TTS_ENGINES = ['ema', 'ahenk', 'edge', 'piper', 'supertonic'];
function ttsEngineName() {
  const e = String((settings.waTts || {}).engine || '').toLowerCase();
  return TTS_ENGINES.includes(e) ? e : 'ema';
}
function ttsEngineLabel() {
  return {
    ema: 'eMa Lightning (yerel)',
    ahenk: 'Ahenk Cep (yerel)',
    edge: 'Edge TTS (online, ücretsiz)',
    piper: 'Piper (yerel, hafif)',
    supertonic: 'Supertonic (yerel, 31 dil)',
  }[ttsEngineName()] || 'eMa Lightning (yerel)';
}
function ttsModule() {
  const m = { ema, ahenk, edge: edgetts, piper, supertonic }[ttsEngineName()];
  return m || ema;
}

/* ses kimliği geçerli mi? motor başına liste farklı (id uzayları kesişmez) */
function validTtsVoice(engine, v) {
  const s = String(v || '').trim();
  if (!s) return false;
  const list = engine === 'edge' ? edgetts.EDGE_VOICES
    : engine === 'piper' ? piper.VOICES
    : engine === 'supertonic' ? supertonic.VOICES
    : null; // ema/ahenk: ses yok (motor modeliyle geliyor)
  if (!list) return false;
  if (Array.isArray(list)) return list.some((x) => x && x.id === s);
  return !!list[s];
}

/* TTS sentezi: 5 motor — eMa Lightning + Ahenk Cep (yerel PyTorch), Edge (online,
   ücretsiz, mp3), Piper (yerel CLI, ~22 kHz WAV), Supertonic (yerel ONNX, 31 dil).
   "SES ASLA SUSMASIN": seçili motor tutmazsa zincir düşer — yerel motorlar
   birbirine, sonra Edge (internet varsa). Dönen { audio: Buffer, mime } —
   WA sesli notu ffmpeg ile ogg/opus'a çevirir, oynatıcı mp3/wav'ı doğrudan çalar.
   cfgOverride: BEAST MOBILE kendi TTS ayarını ayrı tutar (settings.mobileTts) —
   masaüstü WA TTS'i kapalıyken bile telefonda seslendirme şart DEĞİL; opts.force
   ile enabled kapısı bypass. */
function ttsVoicePrefFor(engine, cfg) {
  const c = cfg || settings.waTts || {};
  return validTtsVoice(engine, c.voice) ? String(c.voice).trim() : undefined;
}
function ttsFallbackChain(engineName) {
  /* seçili + artan yedekler: yerelden yerele, son çevrimiçi. Edge seçiliyken
     önce yereller denenir (online kopukken ve ilk round-trip yavaşken kayıp olmasın) */
  const sel = TTS_ENGINES.includes(engineName) ? engineName : 'ema';
  const rest = sel === 'edge'
    ? ['ema', 'ahenk']
    : ['ema', 'ahenk', 'edge'];
  return [sel, ...rest.filter((e) => e !== sel)];
}
async function synthesizeSpeech(text, opts = {}, cfgOverride = null) {
  const cfg = cfgOverride || settings.waTts || {};
  if (!cfg.enabled && !opts.force) return null;
  try {
    const t = ttsCleanText(text);
    if (!t || t.length < 2) return null;
    let lastErr = '';
    for (const engine of ttsFallbackChain(String(cfg.engine || '') || ttsEngineName())) {
      try {
        let out = null;
        const voice = ttsVoicePrefFor(engine, cfg);
        if (engine === 'edge') {
          /* Edge: kurulum yok, doğrudan sentez — mp3 buffer döner */
          const buf = await edgetts.synthesize(t, { voice, rate: opts.edgeRate });
          out = buf && buf.length ? { audio: buf, mime: 'audio/mpeg' } : null;
        } else if (engine === 'piper') {
          if (!piper.status().installed) throw new Error('piper kurulu değil');
          out = await piper.synthesize(t, { voice, speed: cfg.speed, pad: opts.pad });
        } else if (engine === 'supertonic') {
          if (!supertonic.status().installed) throw new Error('supertonic kurulu değil');
          out = await supertonic.synthesize(t, { voice, speed: cfg.speed, pad: opts.pad });
        } else if (engine === 'ahenk') {
          if (!ahenk.status().pkg) throw new Error('ahenk kurulu değil');
          out = await ahenk.synthesize(t, { speed: cfg.speed, pad: opts.pad });
        } else {
          out = await ema.synthesize(t, { speed: cfg.speed, sampleRate: cfg.sampleRate, pad: opts.pad });
        }
        if (out && out.audio) {
          if (lastErr) waLog('tts: seçili motor düştü, yedek ' + engine + ' devraldı (' + lastErr.split('\n')[0] + ')');
          return out;
        }
      } catch (e) {
        lastErr = String((e && e.message) || e);
        waLog('tts ' + engine + ' hata: ' + lastErr.split('\n')[0]);
      }
    }
    return null;
  } catch (e) {
    waLog('tts hata: ' + String((e && e.message) || e));
    return null;
  }
}

/* TTS metin temizliği: emoji/simge ve markdown gürültüsü seslendirilmez
   (eMa emojiyi harf harf "unicode" gibi okuyor), URL'ler sessizce atılır,
   [metin](link) kalıbı yalnız metne indirgenir. */
function ttsCleanText(t) {
  let s = String(t || '');
  s = s.replace(/```[\s\S]*?```/g, ' Kod bloğu ekranda. ');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // [metin](link) → metin (URL'den ÖNCE)
  s = s.replace(/https?:\/\/\S+/gi, ' ');
  s = s.replace(/[\[\]]+/g, ' ');
  /* BMP simge blokları: oklar, teknik, çerçeveli, geometrik, dingbat, emoji-mücevher */
  s = s.replace(/[\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u25A0-\u25FF\u2600-\u27BF\u2900-\u297F\u2B00-\u2BFF]/g, ' ');
  /* astral düzlem (renkli emoji, bayraklar, ten tonu, semboller) */
  s = s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ' ');
  s = s.replace(/[\uFE00-\uFE0F\u200D\u20E3]/g, ''); // varyasyon seçici + ZWJ + keycap
  s = s.replace(/[\u00A9\u00AE\u2122]/g, ' '); // © ® ™
  s = s.replace(/[*_`~#>]+/g, ' ');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
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
    '• */stop* – koşan her şeyi ANINDA durdur + kilitle (kilit yalnız */start* ile açılır; yeni mesaj durdurulan işi devam ettirmez)',
    '• */start* – kilidi aç; yeni istekler normal işlenir',
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
    '• */model* – aktif modeli göster (*/model* <isim> ile değiştir · */model refresh* – modelleri yeniden çek)',
    '• */skills* – kurulu skill\u2019ler',
    '• */usage* – bugünkü kullanım',
    '• */backup* – tüm veriyi ŞİFRELİ yedekle (Beast Kodu imzalı, Masaüstü\\Beast-Backups)',
    '• */status* – bağlantı ve servis durumu',
    '• */autodel* – tüm otomatik hatırlatmaları (bayat/eski dahil) tek komutla sil · */autodel all*: cron görevleri dahil hepsi',
    '• */deltodo* – bu oturumun todo listesini temizle · */deltodo all*: tüm oturumların todoları',
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

/* /stop kilidini aç (YALNIZ /start ve açık "başlat" eylemleri çağırır;
   normal mesajlar kilidi AÇMAZ — durdurulan iş kendiliğinden devam etmez) */
function resumeServices() {
  if (!servicesPaused) {
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
      /* cam sohbet de onay rozetini alsın (aynı istek, aynı requestId) */
      try {
        if (glassWin && !glassWin.isDestroyed()) {
          glassWin.webContents.send('agent:event', {
            sessionId: String(sessionId || ''),
            type: 'approval',
            requestId: id,
            tool,
            argsPreview: approvalArgsSummary(args),
          });
        }
      } catch {}
      /* BEAST MOBILE: telefondaki APK'da da onay rozeti dursun */
      try {
        mobileWs.broadcast({
          sessionId: String(sessionId || ''),
          type: 'approval',
          requestId: id,
          tool,
          argsPreview: approvalArgsSummary(args),
        });
      } catch {}
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
  /* opencode permission (BC): önce opencode izin istekleri yanıtlanır —
     cevap 'once' | 'always' | 'reject' üçlüsüdür (permission/reply portu) */
  if (engine && typeof engine.replyPermission === 'function') {
    try {
      const pend = engine._perm && engine._perm.list ? engine._perm.list() : [];
      if (pend.length) {
        const action = ok ? (always ? 'always' : 'once') : 'reject';
        const r = engine.replyPermission(pend[0].id, action);
        if (r && r.ok) return { ok: true, tool: pend[0].permission };
      }
    } catch {}
  }
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
      /* /new: YALNIZ bu sohbetin oturumu kapatılır, bu sohbete taze oturum
         açılır — diğer numaraların/grupların oturumlarına DOKUNULMAZ */
      const key = waSessionKey(jid);
      const oldSid = waChats.get(key) || '';
      if (oldSid) {
        let olds = null;
        try { olds = engine.cache.get(oldSid) || null; } catch {}
        if (!olds || !olds.bcCode) {
          /* Beast Code panel oturumuysa dokunma — yalnız pointer taşınır */
          try { engine.deleteSession(oldSid); } catch {}
          const h = (waHistory.get(key) || []).filter((x) => x !== oldSid);
          if (h.length) waHistory.set(key, h);
          else waHistory.delete(key);
        }
      }
      const v = engine.createSession();
      waChats.set(key, v.id);
      waRememberSession(key, v.id);
      saveWaChats();
      wa.setWatchJids([...waChats.keys()]);
      out = `*Yeni oturum* \`${v.code}\` açıldı — bu sohbet artık buradan devam eder.\nGeçmiş: \`/sessions\` · Var olan oturuma geçiş: \`/open <kod>\``;
    } else if (cmd === 'open') {
      if (!arg) {
        out = 'Kullanım: `/open <kod>` — kodları görmek için /sessions';
      } else {
        const hit = engine.findByCode(arg);
        const key = waSessionKey(jid);
        /* GİZLİLİK: yalnız BU sohbetin kendi geçmişindeki oturuma geçilebilir */
        const own = new Set([...(waHistory.get(key) || []), waChats.get(key) || '']);
        if (!hit || !own.has(hit.id)) {
          out = `\`${arg.toUpperCase()}\` bu sohbete ait bir oturum değil. Listeyi görmek için /sessions`;
        } else {
          waChats.set(key, hit.id);
          waRememberSession(key, hit.id);
          saveWaChats();
          wa.setWatchJids([...waChats.keys()]);
          out = `*Geçildi:* \`${hit.code}\` — ${escapeWa(hit.title)}`;
        }
      }
    } else if (cmd === 'sessions') {
      const key = waSessionKey(jid);
      const h = [...new Set([...(waHistory.get(key) || []), ...(waChats.has(key) ? [waChats.get(key)] : [])])];
      const activeSid = waChats.get(key);
      const rows = [];
      for (const sid of h.slice(-8).reverse()) {
        try {
          if (!sessionFileAlive(sid)) continue;
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
      /* /stop: koşan her şey + KİLİT; kilit yalnız /start ile açılır */
      const stopped = stopEverything();
      out =
        `*Durdu* — ${stopped} koşan iş kesildi.\n` +
        `Sürüyen sorgular, akıştaki cevaplar ve ajan faaliyetleri ANINDA kesildi; ajan yeni sorgu da açamaz.\n` +
        `Bu kilit yalnız /start ile açılır — yeni mesaj yazmak durdurulan işi devam ettirmez.`;
    } else if (cmd === 'start') {
      const wasStopped = !!(engine && engine._stopped);
      resumeServices();
      out = wasStopped
        ? '*Devam* — kilit açıldı; yeni istekler normal işlenir.'
        : 'Zaten çalışıyor — durdurulmuş bir şey yok.';
    } else if (cmd === 'restart') {
      out = '*\u21BB Yeniden başlatılıyor…* Uygulama birkaç saniye içinde kapanıp açılacak.';
      setTimeout(() => {
        try { app.relaunch(); } catch {}
        try { app.exit(0); } catch {}
      }, 1500);
    } else if (cmd === 'change') {
      out = modelChangeText(arg);
    } else if (cmd === 'notes') {
      const sid = waChats.get(waSessionKey(jid));
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
      const sid = waChats.get(waSessionKey(jid));
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
      if (arg === 'refresh') {
        out = '*Modeller yeniden çekiliyor…* (tüm providerlar)';
        sendWaSafe(jid, out).catch(() => {});
        const st2 = await refreshModelsAll();
        out =
          `*Modeller tazelendi* — ${st2.models.length} model\n` +
          (st2.activeModel ? `Aktif: ${st2.activeModel.providerName} · ${st2.activeModel.model}` : 'Aktif model yok');
      } else {
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
    } else if (cmd === 'cron') {
      /* /cron list | /cron clear (hepsini sil) | /cron del <id> */
      const sub = String(arg || '').toLowerCase().trim();
      if (!sub || sub === 'list') {
        const all = cron.list();
        out = all.length
          ? '*Cron görevleri* (' + all.length + ')\n' +
            all.map((j, i) => `${i + 1}. ${escapeWa(j.name)} — \`${j.schedule}\`${j.enabled ? '' : ' (kapalı)'}`).join('\n')
          : 'Cron görevi yok.';
      } else if (sub === 'clear') {
        const r = cron.clearAll();
        cronEmit();
        out = r.ok
          ? `*Tüm cron görevleri silindi* (${r.count} adet). Zamanlayıcı durduruldu.`
          : 'Cron temizlenemedi.';
      } else if (sub.startsWith('del ')) {
        const id = sub.slice(4).trim();
        const r = cron.remove(id);
        cronEmit();
        out = r.ok ? '*Cron görevi silindi.*' : 'Görev bulunamadı.';
      } else {
        out = 'Kullanım: `/cron list` · `/cron clear` (hepsini sil) · `/cron del <id>`';
      }
    } else if (cmd === 'autodel') {
      /* /autodel [all] — TÜM otomatik hatırlatmaları tek komutla sil.
         Bayat/eski kayıtlar dahil: kind=reminder + eski isim/prompt önekleri eşleşir.
         /autodel all → cron görevleri dahil her şey (=/cron clear) */
      const sub = String(arg || '').toLowerCase().trim();
      if (sub === 'all' || sub === 'hepsi' || sub === 'hepsini') {
        const r = cron.clearAll();
        cronEmit();
        out = r.ok
          ? `*Tüm zamanlanmış görevler silindi* (${r.count} adet).`
          : 'Temizlenemedi.';
      } else {
        const r = cron.removeIf(isReminderJob);
        cronEmit();
        const left = cron.list().filter((j) => j.enabled).length;
        out = r.count
          ? `*${r.count} otomatik hatırlatma silindi.* Kalan aktif görev: ${left}`
          : 'Silinecek otomatik hatırlatma yok — zaten temiz.';
      }
    } else if (cmd === 'deltodo') {
      /* /deltodo [all] — todo listelerini temizler: arg=all → TÜM oturumlar;
         yoksa yalnız bu sohbetin oturumu. Panelden de düşsün diye 'todos'
         olayı emit edilir (engine.clearTodos). */
      const sub = String(arg || '').toLowerCase().trim();
      if (sub === 'all' || sub === 'hepsi' || sub === 'hepsini') {
        let n = 0;
        let items = 0;
        try {
          for (const v of engine.listSessions()) {
            const r = engine.clearTodos(v.id);
            if (r && r.ok) {
              n++;
              items += r.count || 0;
            }
          }
        } catch {}
        out = n
          ? `*Tüm oturumların todoları temizlendi* (${n} oturum, ${items} madde).`
          : 'Temizlenecek todo yok.';
      } else {
        const sid = waChats.get(waSessionKey(jid)) || '';
        if (!sid) {
          out = 'Bu sohbette açık oturum yok — todo listesi de yok.';
        } else {
          const r = engine.clearTodos(sid);
          out = r.ok
            ? (r.count
                ? `*${r.count} todo temizlendi.* (tüm oturumlar için: /deltodo all)`
                : 'Todo listesi zaten boş. (tüm oturumlar için: /deltodo all)')
            : 'Oturum bulunamadı — todo listesi yok.';
        }
      }
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
        const sid = waChats.get(waSessionKey(jid));
        if (sid && engine.isBusy(sid)) {
          try { engine.interrupt(sid, 'kullanıcı /beastagent ile sohbet moduna döndü'); } catch {}
        }
        waBcMode.delete(jid);
        /* KİŞİ BAŞINA OTURUM: kişinin kendi sohbet oturumuna dönülür */
        const chatSid = waRestoreChatSession(jid);
        const chatS = engine.cache.get(chatSid);
        saveWaChats();
        if (wa) wa.setWatchJids([...waChats.keys()]);
        emitWaEventSafe({ type: 'bc-screen', on: false });
        out =
          `*💬 Sohbet moduna dönüldü* — masaüstünde chat ekranı açıldı, sohbet oturumu \`${(chatS && chatS.code) || '?'}\`.\n` +
          `Kodlar duruyor: \`${waBcWorkspace()}\`\n` +
          `Tekrar kodlamak için: /beastcode`;
      }
    } else if (waBcMode.has(jid) && (cmd === 'plan' || cmd === 'build' || cmd === 'auto')) {
      /* opencode ajan değişimi (WA): /plan → plan ajanı (salt-okur),
         /build · /auto → build ajanı (varsayılan; auto opencode'da yoktur) */
      const sid = waChats.get(waSessionKey(jid));
      const s = sid ? engine.cache.get(sid) : null;
      if (s && s.bcCode) {
        const agent = engine.setBcAgent(s.id, cmd === 'plan' ? 'plan' : 'build');
        out = agent === 'plan'
          ? '*🔍 PLAN AJANI* (opencode plan) — salt-okur: dosyaları okur/inceler, kod YAZMAZ; adım adım uygulama planı verir. Uygulamak için /build yaz.'
          : cmd === 'build'
            ? '*🛠 BUILD AJANI* (opencode build) — bağlamı inceler, todowrite ile planlar, uygular, doğrular.'
            : '*⚡ BUILD AJANI* (opencode build) — kısa plan + hemen uygulama + doğrulama.';
      } else {
        out = 'Bu komut yalnız BeastCode modunda çalışır — önce /beastcode yaz.';
      }
    } else if (cmd === 'version') {
      /* npm'deki en son sürümü de göster */
      out = await versionText(true);
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

/* ---------- KİŞİ BAŞINA KANAL OTURUMU (WA/TG/DC) ----------
   Her numara/grup/sohbet KENDİ oturumunda konuşur — A'nın geçmişi B'ye
   bağlam olarak sızmaz. Oturum yalnızca o sohbet silinirse yenilenir;
   cron/otomatik işler ayrı "taban oturumlarında" koşar (bkz. cronBaseSession).
   Eski "tek oturum" düzeni açılışta güvenli biçimde göç ettirilir. */
function sessionFileAlive(sid) {
  try {
    return !!sid && fs.existsSync(path.join(engine.sessionsDir, String(sid) + '.jsonl'));
  } catch {
    return false;
  }
}
/* WA'dan gelen belge orijinallerini oturumun media klasörüne yazar;
   döner: media/<sid>/<dosya> (relatif yol — ajan read_file ile açabilir) */
function saveSessionMedia(sid, name, buf) {
  try {
    if (!buf || !buf.length) return null;
    const dir = path.join(engine.sessionsDir, 'media', String(sid || ''));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe = String(name || 'dosya').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    const file = stamp + '-' + safe;
    fs.writeFileSync(path.join(dir, file), buf);
    return 'media/' + String(sid || '') + '/' + file;
  } catch {
    return null;
  }
}

/* KİŞİ BAŞINA OTURUM: jid yoksa CRON TABAN OTURUMU döner (otomatik işler
   hiçbir kişinin sohbetine karışmaz); varsa o sohbetin kendi oturumu açılır. */
function ensureWaSession(jid) {
  if (jid == null || jid === '') return ensureWaCronSession();
  const key = waSessionKey(jid);
  const sid = waChats.get(key);
  if (sid && sessionFileAlive(sid)) return sid;
  const v = engine.createSession();
  waChats.set(key, v.id);
  waRememberSession(key, v.id);
  saveWaChats();
  if (wa) wa.setWatchJids([...waChats.keys()]);
  return v.id;
}

/* Cron/otomatik işlerin WhatsApp taban oturumu: hiçbir jid'e bağlı DEĞİL */
function ensureWaCronSession() {
  if (!waCronSid || !sessionFileAlive(waCronSid)) {
    waCronSid = engine.createSession().id;
    saveWaChats();
  }
  return waCronSid;
}

/* Cevap/dosya hedefi: oturuma bağlı sohbetler arasında EN SON mesaj gelen
   önceliklidir; o bilgi yoksa (restart vb.) bağlı sohbet kullanılır. */
function waReplyJid(sid) {
  const s = String(sid || '');
  try {
    const lastKey = waLastActiveJid ? waSessionKey(waLastActiveJid) : '';
    if (lastKey && String(waChats.get(lastKey) || '') === s) return lastKey;
  } catch {}
  for (const [j, v] of waChats) {
    if (String(v) === s) return j;
  }
  return null;
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

/* Hatırlatma job'ı mı? Yeni kayıtlarda kind='reminder' var; eski (bayat)
   kayıtlar isim/prompt önekinden tanınır — /autodel ve doğal dil silme
   bunu kullanır. */
function isReminderJob(j) {
  if (!j || typeof j !== 'object') return false;
  if (j.kind === 'reminder') return true;
  const n = String(j.name || '');
  const p = String(j.prompt || '');
  return (
    /^Hatırlatma:/.test(n) ||
    /^Tekrarlı hatırlatma:/.test(n) ||
    p.startsWith('[HATIRLATMA ZAMANI]') ||
    p.startsWith('[TEKRARLI HATIRLATMA]')
  );
}

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
        kind: 'reminder',
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
      kind: 'reminder',
      once: true,
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
    /* çekirdek: her botta konuşma + plan + hatırlatıcı + PDF üretimi */
    'todo_write', 'set_reminder', 'send_file', 'pdf_write',
    'tasks_list', 'task_status', 'task_cancel',
    'run_background', 'run_background_many', 'delegate_task',
    'event_list', 'event_subscribe', 'event_unsubscribe',
    'watcher_add', 'watcher_list', 'watcher_remove',
    'tool_request', /* CEPHANE: eksik aracı TOOL botuna yazdırma hakkı HER botta */
    'channel_send', /* İLK MESAJ: allow listteki kişilere kendiliğinden yazma hakkı HER botta */
    'agent_dm',     /* BOTLAR ARASI DM: botlar birbirine iş atar/cevap verir (ör. Beast → Tool) */
    'skill',        /* SKILL KATALOĞU: botlar SKILL.md gövdesini skill() ile okur (Tool botu: tool-yazma/mql5) */
  ]);
  if (s.web_search) { set.add('web_search'); set.add('http_fetch'); set.add('webfetch'); set.add('deep_search'); }
  if (s.browser) {
    for (const t of ['browser_open', 'browser_read', 'browser_screenshot', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_select', 'browser_wait', 'browser_agent', 'ocr_read', 'computer_look']) set.add(t);
  }
  if (s.email) { set.add('email_list'); set.add('email_read'); set.add('email_send'); }
  if (s.run_command) {
    for (const t of ['run_command', 'python_run', 'read_file', 'write_file', 'edit_file', 'grep', 'glob', 'list_dir', 'computer_look', 'computer_act',
      'git_commit', 'git_diff_review', 'git_pr_create', 'repo_map', 'repo_symbols', 'xlsx_read', 'xlsx_write', 'xlsx_edit']) set.add(t);
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
    /* LID → gerçek numara eşlemesi SLASH KOMUTLARINDAN ÖNCE kurulmalı:
       oturum anahtarı (/new, /sessions, /open) gerçek numaraya göre çalışır */
    if (!isGroup && senderNum) waJidPn.set(jid, String(senderNum));
    /* İzin listesi kaydı — grup kapıları ve doğal dil komutları bunu kullanır:
       izinli değilse yalnız sohbet; agentic iş yaptıramaz. */
    const senderHit = waFind(senderNum);

    /* slash komutları: DM'de her zaman; grupta sadece bot mention edildiyse.
       GRUP KAPISI: izin listesinde olmayan üye slash (agentic) komut kullanamaz —
       herkes sohbet eder ama işi yalnız izinli kişiler yaptırır. */
    const txt0 = String(payload.text || '').trim();
    if (txt0.startsWith('/') && !txt0.includes('\n') && (!isGroup || payload.mentioned)) {
      if (isGroup && !senderHit && !/^\/(help|version)\b/i.test(txt0)) {
        await sendWaSafe(
          jid,
          'Bu komutu yalnız izinli kişiler kullanabilir. Sohbet için beni @mention ile çağırabilirsin.'
        ).catch(() => {});
        return;
      }
      if (await tryWaSlash(jid, txt0, senderNum, payload)) return;
    }

    /* "hepsini sil" / "tüm cron" / "cronları temizle" gibi doğal dil → cron temizle.
       Yalnız İZİNLİ gönderen: misafir grup üyesi cron silemez.
       clearAll() bellekteki job'ları VE diski boşaltır, zamanlayıcıyı durdurur
       (sadece dosya silmek yetmezdi: çalışan proses belleği geri yazıyordu). */
    const lc = txt0.toLowerCase();
    if (
      senderHit &&
      ((lc.includes('cron') && /(sil|temizle|kaldır|hepsi|tüm|sıfırla)/.test(lc)) ||
        /^(hepsini|hepsını|tümünü|tümünü|hepsnı|hepsnı)\b.*(sil|sıl|temizle|kaldır)/.test(lc))
    ) {
      const r = cron.clearAll();
      cronEmit();
      await sendWaSafe(
        jid,
        r.ok
          ? `*Tüm cron görevleri silindi* (${r.count} adet). Zamanlayıcı durduruldu.`
          : 'Cron temizlenemedi.'
      ).catch(() => {});
      return;
    }

    /* "hatırlatmaları sil" / "alarm temizle" / "reminders kaldır" → yalnızca
       otomatik hatırlatmalar silinir (cron görevlerine dokunulmaz).
       Yalnız İZİNLİ gönderen tetikleyebilir. */
    if (
      senderHit &&
      /hat[iı]rlat|alarm|remind/.test(lc) &&
      /(sil|sıl|temizle|kaldır|iptal|sıfırla|kapat)/.test(lc)
    ) {
      const r = cron.removeIf(isReminderJob);
      cronEmit();
      await sendWaSafe(
        jid,
        r.count
          ? `*${r.count} otomatik hatırlatma silindi.* Zamanlanmış kalan görev: ${cron.list().filter((j) => j.enabled).length}`
          : 'Silinecek otomatik hatırlatma yok — zaten temiz.'
      ).catch(() => {});
      return;
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
    /* /stop kilidi normal mesajla AÇILMAZ — mesaj yine işlenir (engine userAction),
       ama durdurulan iş/kuyruk kendiliğinden devam etmez */
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
  /* GRUP: gönderen izin listesinde mi? İzinli → kendi yetki seviyesi;
     değilse 'chat' (sohbet serbest, araç YOK — agentic işi yalnız izinliler
     yaptırabilir). DM'de izinsiz gönderen buraya gelemez. */
  const hit = waFind(senderNum);
  if (!isGroup && !hit) {
    waLog(`skip flush: izinli eşleşme yok (sender=+${senderNum || '?'})`);
    return;
  }
  /* KİŞİ BAŞINA OTURUM: her numara/grup kendi oturumunda; oturum yoksa açılır */
  const sid = ensureWaSession(jid);
  waLastActiveJid = String(jid); // cevap/dosya hedefi: en son yazan sohbet
  // Cevap verilecek — karşı telefonda "yazıyor…" göstergesi (medya işlenene dek sürer)
  wa.setComposing(jid, true);
  // Kişi bazlı granül izin: all/web/read/chat — grup misafiri varsayılan 'chat'
  let perm = hit ? hit.perm || (hit.lockdown ? 'chat' : 'all') : 'chat';
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
     olarak tazele — restart sonrası bcCode/bcAgent/workspace bayrakları dosyadan
     yüklenmediği için masaüstü bcFlush disipliniyle her mesajda bindirilir */
  if (waBcMode.has(jid)) {
    const bs = engine.cache.get(sid);
    if (bs) {
      bcBindOc(bs, waBcWorkspace());
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
        /* ANLIK STT KÖPRÜSÜ: sesli not yazıya çevrilmeye başlayınca/ofsunca
           masaüstü + cam panel ANINDA bilinir — camda "STT mesajları
           görünmüyor" yerine "🎤 çevriliyor… → transkript konuşma balonunda" */
        const sttT0 = Date.now();
        emitWaBoth({
          sessionId: sid,
          type: 'wa-stt',
          state: 'transcribing',
          from: isGroup ? (groupSender || 'grup üyesi') : (hit && hit.name) || '+' + (senderNum || '?'),
        });
        /* mimetype langOverride olarak geçilemez — 3. parametre olarak medial türü gider */
        const tr = await transcribeAudio(md.buf, undefined, md.mimetype);
        emitWaBoth({ sessionId: sid, type: 'wa-stt', state: tr ? 'done' : 'fail', ms: Date.now() - sttT0 });
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
          /* BELGE KAYDI: orijinal dosya oturum media klasörüne yazılır —
             model yalnız metnini görür, orijinale ajan read_file ile ulaşabilir */
          const savedDoc = saveSessionMedia(sid, md.name, md.buf);
          const dt = documentToText(md);
          if (dt && dt.trim()) {
            attachments.push({ type: 'file', name: md.name, content: dt.slice(0, 20000) });
            text += `\n[belge alındı: ${md.name}${savedDoc ? ' · kaydedildi: ' + savedDoc : ''}]`;
          } else {
            text += `\n[belge alındı ama okunamadı: ${md.name}${savedDoc ? ' · kaydedildi: ' + savedDoc : ''}]`;
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

/* Olayı MASAÜSTÜ + CAM panele birlikte yolla:
   "beast agent'taki gibi camda da her şey görünsün" köprüsü.
   Slash komut yankıları (desktopEcho, stop/start, restart, sürüm duyurusu)
   da bunu kullanır — camda komut çalışsın VE cevabı görünsün */
function emitWaBoth(ev) {
  try { if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev); } catch {}
  try { if (glassWin && !glassWin.isDestroyed()) glassWin.webContents.send('agent:event', ev); } catch {}
  /* BEAST MOBILE: telefondaki APK ekranı da aynı canlı akışı alır (GUI'lerle
     aynı event şekli) — köprü kapalıyken sessizce yok sayılır */
  try { mobileWs.broadcast(ev); } catch {}
}

/* ---------- BEAST MOBILE KÖPRÜSÜ (Faz A) ----------
   settings.mobile = { enabled (default true), port (default 8788) }
   onSend/onOpen/onNew/onInterrupt/onSessions: engine bağlama noktaları.
   engine.inimitbirinde onPair device.json kaydını tutar. */
/* telefona oturum geçmişi snapshot'ı — masaüstündeki sessions:open IPC ile
   AYNI kaynaktan (engine.openSession) okur; telefon ekranındaki balonlara
   birebir MASAÜSTÜ sohbet formatı düşer. Boyut sigortası: 2MB üstünde arkadan kes */
function sendMobileHistory(sid, replyS) {
  if (!replyS) return;
  let raw = [];
  try {
    const snap = engine.openSession(sid);
    raw = Array.isArray(snap && snap.messages) ? snap.messages : [];
  } catch {}
  const cap = (s) => String(s == null ? '' : s).slice(0, 6000);
  const slimAtt = (a) => {
    if (a && a.type === 'image' && typeof a.dataUrl === 'string') {
      return a.dataUrl.length <= 260000 ? a : { type: 'image', name: a.name || 'resim' };
    }
    return a;
  };
  const slim = (content) => {
    if (Array.isArray(content)) {
      return content.map((p) => {
        if (p && p.type === 'text') return { ...p, text: cap(p.text) };
        if (p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string' && p.image_url.url.length > 300000) {
          return { type: 'text', text: '[büyük görsel — masaüstünde görmen gerekir]' };
        }
        return p;
      });
    }
    return cap(content);
  };
  /* ARAÇ İŞLEMLERİ DE GİTSİN: snapshot tool_calls'ı TAŞISIN — telefondan
     sohbete tekrar girişte web/read/ocr... işlerinin balonları WhatsApp gibi
     kaybolmasın (canlı akıştaki tool-start balonlarıyla aynı görüntü). */
  let payload = (raw || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => {
      const row = { role: m.role, content: slim(m.content), attachments: Array.isArray(m.attachments) ? m.attachments.map(slimAtt) : undefined };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        row.tool_calls = m.tool_calls.slice(0, 12).map((tc) => {
          const fn = (tc && tc.function) || {};
          const name = String(fn.name || (tc && tc.name) || 'arac').slice(0, 40);
          let args = typeof fn.arguments === 'string' ? fn.arguments : (fn.arguments ? JSON.stringify(fn.arguments) : '');
          if (args.length > 500) args = args.slice(0, 500) + '…';
          return { id: String((tc && tc.id) || '').slice(0, 64), function: { name, arguments: args } };
        });
      }
      return row;
    });
  while (payload.length > 1) {
    let bytes = 0;
    try { bytes = JSON.stringify({ t: 'session', messages: payload }).length; } catch { break; }
    if (bytes < 2 * 1024 * 1024) break;
    payload = payload.slice(20); /* en eskilerden 20 tanesini at */
  }
  try { replyS({ t: 'session', sid: String(sid || ''), messages: payload }); } catch {}
}

/* telefon konvertörlü sessions akışı — engine'in 'liste tazele' sinyali ({type:'sessions'},
   İÇİ BOŞ) telefona ham gitmez: DOLDURULMUŞ liste ({t:'sessions', list, activeSid}) gider */
/* KANAL HARİTASI (Beast Mobile): oturum id → WhatsApp/Telegram/Discord
   bağlantısı. Telefondaki sohbet seçicide oturum başlığının yanında kanal
   ikonu + etiketi görünür — o sohbetin WhatsApp'a mı Telegram'a mı bağlı
   olduğu anlaşılır. */
function mobileChannelMap() {
  const m = new Map();
  try { for (const [key, sid] of waChats) { if (sid && !m.has(String(sid))) m.set(String(sid), { chan: 'wa', label: waChatLabelFor(key) }); } } catch {}
  try { for (const [key, sid] of tgChats) { if (sid && !m.has(String(sid))) m.set(String(sid), { chan: 'tg', label: tgChatLabelFor(key) }); } } catch {}
  try { for (const [key, sid] of dcChats) { if (sid && !m.has(String(sid))) m.set(String(sid), { chan: 'dc', label: dcChatLabelFor(key) }); } } catch {}
  return m;
}

/* BEAST MOBILE — ELLER SERBEST TTS + İZLER
   1) Telefon 'talk' modunu açtığında bu oturumu işaret eder — tur bitince
      SON asistan metni, TELEFONUN KENDİ TTS AYARIYLA (settings.mobileTts —
      masaüstü WA TTS'İNDEN BAĞMSIZ) seslendirilip telefona OGG/AAC dataUrl
      olarak gelir.
   2) Telefonun dokunduğu oturumlar 'bm' rozetiyle listelenir — WhatsApp/
      Telegram/Discord rozetleriyle AYNI düzende (M) görünür. */
let phoneSessionMarks = new Map(); /* sid → son telefon dokunuşu (ts) — M rozeti */
/* SESLENDİRME AYRI HARİTA: telefonun "Cevabı seslendir" açıkken işaretlediği
   oturumlar. Bir metin/ses mesajı göndermek bu işareti KENDİLİĞİNDEN açmaz —
   ayar kapalıyken cevaplar seslendirilmesin (eski hata: onSend her seferinde
   aktivite penceresini tazeliyordu ve her cevap sesli gidiyordu). */
let phoneTalkMarks = new Map(); /* sid → son seslendirme faaliyeti (ts) */
function touchPhoneSession(sid) {
  try { phoneSessionMarks.set(String(sid || ''), Date.now()); } catch {}
}
/* yalnız ZATEN seslendirme modunda işaretli oturumun penceresini tazele */
function touchPhoneTalk(sid) {
  try {
    const id = String(sid || '');
    if (mobileTtsCfg().enabled && phoneTalkMarks.has(id)) phoneTalkMarks.set(id, Date.now());
  } catch {}
}
/* telefonda SEÇİLEBİLİR ses motorları — sadece yerel eMa + Ahenk */
const MOBILE_TTS_ENGINES = ['ema', 'ahenk'];
function mobileTtsCfg() {
  let c = settings.mobileTts || (settings.mobileTts = {});
  if (!c || typeof c !== 'object') c = settings.mobileTts = {};
  try { c.enabled = !!c.enabled; } catch {}
  try { c.engine = MOBILE_TTS_ENGINES.includes(String(c.engine || '')) ? String(c.engine) : 'ema'; } catch {}
  try {
    const sp = Number(c.speed);
    c.speed = Number.isFinite(sp) && sp >= 0.5 && sp <= 2 ? sp : 1;
  } catch {}
  try { c.voice = String(c.voice || '').trim(); } catch {}
  return c;
}
function mobileTalkActive(sid) {
  try {
    if (!mobileTtsCfg().enabled) return false; /* ayar kapalı → seslendirme YOK */
    const t = phoneTalkMarks.get(String(sid || '')) || 0;
    return !!(t && Date.now() - t < 15 * 60000); /* 15 dk faaliyet penceresi */
  } catch { return false; }
}

/* TELEFONA GİDECEK SES: seçili motorla sentez → mp3/aac zaten küçük;
   WAV/OGG çıkışlı motorları AAC'ye sıkıştır (fragmented MP4 — Android
   WebView'de ADTS'e göre daha güvenli; 48 kbps mono 24 kHz) */
function ffmpegToAacBuf(inBuf) {
  return new Promise((resolve) => {
    try {
      /* ffmpeg yolunu MERKEZİ çözücüden al: whatsapp.js getFfmpegPath'i export
         etmiyordu → burada hep '' dönüyor ve AAC dönüşümü sessizce atlanıyor,
         telefona 15-20 kat büyük WAV gidiyordu. */
      const { resolveFfmpegPath } = require('./agent/ffmpegpath');
      const ff = String(resolveFfmpegPath() || '');
      if (!ff) return resolve(null);
      const dir = path.join(os.tmpdir(), 'beast-mobile-tts');
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const srcAbs = path.join(dir, 'in_' + Date.now() + '.in');
      fs.writeFileSync(srcAbs, inBuf);
      const p2 = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', srcAbs, '-c:a', 'aac', '-b:a', '48k', '-ar', '24000', '-ac', '1', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov', 'pipe:1']);
      const chunks2 = [];
      let done2 = false;
      p2.stdout.on('data', (c) => chunks2.push(c));
      p2.on('error', () => { if (!done2) { done2 = true; resolve(null); } });
      p2.on('close', (code2) => {
        if (done2) return;
        done2 = true;
        try { fs.unlinkSync(srcAbs); } catch {}
        const buf2 = Buffer.concat(chunks2);
        resolve(code2 === 0 && buf2 && buf2.length ? buf2 : null);
      });
      p2.stdin.on('error', () => {});
    } catch {
      resolve(null);
    }
  });
}
async function phoneTtsAudio(txt) {
  try {
    const tSynth = Date.now();
    const out = await synthesizeSpeech(txt, { force: true, pad: 0.05 }, (() => {
      const c = { ...mobileTtsCfg() };
      c.enabled = true; /* telefon AÇIK istiyor — force zaten bunu bypass eder */
      return c;
    })());
    const synthMs = Date.now() - tSynth;
    if (!out || !out.audio) return null;
    const mime = String(out.mime || '');
    if (mime === 'audio/mpeg' || mime === 'audio/aac' || mime === 'audio/mp4') {
      return { ...out, synthMs, convMs: 0 };
    }
    const tConv = Date.now();
    const aac = await ffmpegToAacBuf(out.audio);
    const convMs = Date.now() - tConv;
    return aac
      ? { ...out, audio: aac, mime: 'audio/mp4', synthMs, convMs }
      : { ...out, synthMs, convMs };
  } catch { return null; }
}

/* TELEFON TTS ÖN-ISI: eMa/Ahenk 15 dk boşta bellekten düşüyor; ilk sentez
   soğukken ~10 sn model yükleme bekliyor. Telefon TTS'i açılınca / mesaj
   gönderilince / canlı mod başlayınca motoru arka planda ısıt — kullanıcı
   cevabı beklerken yükleme bitsin. */
let mobileTtsWarmP = null;
function mobileTtsWarm(force) {
  try {
    const c = mobileTtsCfg();
    if (!c.enabled) return;
    /* SEÇİLİ MOTOR + YEDEK: Ahenk seçili ama kurulu değilse eMa'yı ısıt —
       synthesizeSpeech zaten Ahenk'ten eMa'ya düşüyor, ısıtma da aynı
       zinciri izlemeli (yoksa yedek motor soğuk kalıyordu). */
    const order = c.engine === 'ahenk' ? [ahenk, ema] : [ema, ahenk];
    let m = null;
    let st = null;
    for (const cand of order) {
      try {
        const s = cand.status();
        if (s && s.installed) { m = cand; st = s; break; }
      } catch {}
    }
    if (!m || !st) return;
    if (st.running && !force) return;
    if (mobileTtsWarmP) return;
    const t0 = Date.now();
    const wasRunning = !!st.running;
    mobileTtsWarmP = Promise.resolve()
      .then(() => m.warm())
      .then(() => {
        try {
          log.info('mobile', 'tts ısıtma tamam: ' + (Date.now() - t0) + ' ms'
            + ' (' + (m === ema ? 'ema' : 'ahenk') + (wasRunning ? ', sıcak tutma' : ', soğuk başlangıç') + ')');
        } catch {}
      })
      .catch((e) => { try { waLog('telefon tts ısıtma: ' + String((e && e.message) || e)); } catch {} })
      .finally(() => { mobileTtsWarmP = null; });
  } catch {}
}
/* SICAK TUTMA: eMa/Ahenk 15 dk boşta bellekten düşüyor; telefon TTS'i son
   30 dk içinde kullanıldıysa 2 dk'da bir çok kısa sentez yaparak motoru
   hazır tut (maliyet ~0.3 sn / 2 dk) — sonraki cevap soğuk başlamasın. */
function mobileTtsHeartbeat() {
  try {
    if (!mobileTtsCfg().enabled) return;
    if (phoneTtsJobs.size) return; /* aktif akışın arasına girme */
    let last = 0;
    for (const t of phoneTalkMarks.values()) if (t > last) last = t;
    if (!last || Date.now() - last > 30 * 60000) return;
    mobileTtsWarm(true);
  } catch {}
}

/* AKTİF TELEFON TTS AKIŞLARI: her tur kendi token'ını alır; yeni tur,
   kullanıcı mesajı veya telefondan 'tts-stop' eski akışı iptal eder —
   gecikmiş parçalar yeni cevabın üstüne binmez. */
const phoneTtsJobs = new Map(); /* sid → token */
function phoneTtsCancel(sid) {
  try { phoneTtsJobs.delete(String(sid || '')); } catch {}
}

/* Cevabı cümle parçaları halinde sentezleyip telefona sırayla yolla.
   İlk parça kısa tutulur (hızlı ilk ses); telefon kuyruğa alıp kesintisiz
   çalar, biz de kalan parçaları o sırada sentezleriz. */
async function phoneTtsStream(sid, text) {
  const id = String(sid || '');
  if (!id || !mobileWs) return;
  const chunks = ttsstream.chunks(ttsCleanText(String(text || '')));
  if (!chunks.length) return;
  const token = { ts: Date.now() };
  phoneTtsJobs.set(id, token);
  const t0 = Date.now();
  let seq = 0;
  let firstMs = 0;
  let firstInfo = null;
  let lastSent = false;
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (phoneTtsJobs.get(id) !== token) return; /* yeni tur / iptal */
      if (!mobileTalkActive(id)) break;          /* seslendirme kapandı */
      const ph = await phoneTtsAudio(chunks[i]);
      if (phoneTtsJobs.get(id) !== token) return; /* bekleme sırasında iptal */
      if (!ph || !ph.audio || !ph.audio.length) continue;
      if (ph.audio.length > 6 * 1024 * 1024) continue; /* WS yük tavanı */
      const mime = String(ph.mime || 'audio/aac');
      const last = i === chunks.length - 1;
      try {
        mobileWs.broadcast({
          sessionId: id,
          type: 'phone-tts',
          seq,
          last,
          mime,
          dataUrl: 'data:' + mime + ';base64,' + ph.audio.toString('base64'),
        });
      } catch {}
      if (!firstMs) {
        firstMs = Date.now() - t0;
        firstInfo = {
          chars: chunks[i].length,
          synth: ph.synthMs || 0,   /* synthesizeSpeech duvar süresi */
          motor: ph.ms || 0,        /* Python'un saf sentez süresi */
          conv: ph.convMs || 0,     /* ffmpeg AAC dönüşümü */
          dur: ph.dur || 0,         /* ses süresi (sn) */
        };
      }
      seq++;
      lastSent = last;
    }
    /* son parça sentezlenemeden bittiyse telefona "akış bitti" sinyali —
       canlı moddaki ses kilidi beklemesin */
    if (seq > 0 && !lastSent) {
      try { mobileWs.broadcast({ sessionId: id, type: 'phone-tts-end', seq }); } catch {}
    }
    try {
      const d = firstInfo
        ? ' (sentez ' + firstInfo.synth + ' ms, motor ' + firstInfo.motor + ' ms, dönüşüm '
          + firstInfo.conv + ' ms, ses ' + firstInfo.dur + ' sn, metin ' + firstInfo.chars + ' kr)'
        : '';
      waLog('phone-tts: ' + seq + '/' + chunks.length + ' parça, ilk ses ' + firstMs + ' ms' + d);
    } catch {}
  } finally {
    if (phoneTtsJobs.get(id) === token) phoneTtsJobs.delete(id);
  }
}

function mobileSessionsList() {
  const ch = mobileChannelMap();
  return engine.listSessions().map((s) => {
    let c = ch.get(String(s.id)) || {};
    /* TELEFONUN DOKUNDUĞU oturum: kanal rozeti yoksa 'M' (Beast Mobile) —
       24 saat içinde telefon açma/gönderme yaptıysa işaretlenir */
    if (!c.chan && (Date.now() - (phoneSessionMarks.get(String(s.id)) || 0) < 24 * 3600000)) {
      c = { chan: 'bm', label: 'Beast Mobile (telefon)' };
    }
    return {
      id: s.id,
      title: String(s.title || s.lastAssistant || 'sohbet').slice(0, 60),
      updatedAt: s.updatedAt || s.ts || null,
      botId: s.botId || null,
      chan: c.chan || '',
      chanLabel: c.label ? String(c.label).slice(0, 60) : '',
    };
  });
}
function broadcastMobileSessions() {
  try { mobileWs.broadcast({ t: 'sessions', list: mobileSessionsList(), activeSid: desktopActiveSid || '' }); } catch {}
}

const mobileHandlers = {
  /* TELEFON SESLİ MESAJI → STT: WhatsApp'takiyle AYNI transkript köprüsü —
     ses dosyası Duyu whisper'la yazıya çevrilir, metin aja nın prompt'una
     AYNI kuralla gider ("[sesli mesaj transkripti]"). Yoksa ajan yalnız
     "[Sesli mesaj: 0:05]" notu görür ve ne dediğini anlayamaz. */
  onSend: async (sid, { text, attachments, live }) => {
    touchPhoneSession(sid); /* telefonun dokunduğu oturum — M rozeti */
    touchPhoneTalk(sid);    /* seslendirme AÇIKSA pencereyi tazele (kapalıysa dokunma) */
    phoneTtsCancel(sid);    /* yeni mesaj → önceki cevabın ses akışını kes */
    mobileTtsWarm();        /* cevap üretilirken motoru ısıt (soğuk başlangıcı gizle) */
    let finalText = String(text || '');
    try {
      const atts = Array.isArray(attachments) ? attachments : [];
      const auds = atts.filter((a) => a && a.type === 'audio' && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:'));
      const extra = [];
      for (const a of auds.slice(0, 3)) {
        try {
          /* dataUrl ayrıştırma: `data:audio/webm;codecs=opus;base64,...` gibi
             PARAMETRELİ tipleri de kabul et (eski regex `;codecs`te takılıp
             "sesli mesaj okunamadı" diyordu — canlı modun sesi hep böyle). */
          const sData = String(a.dataUrl);
          const ci = sData.indexOf(',');
          const head = ci > 5 ? sData.slice(0, ci) : '';
          const mm = head.match(/^data:([^;,]+)/i);
          const mimeA = (mm && mm[1]) || 'audio/mp4';
          const isB64 = /;base64$/i.test(head);
          if (ci < 6 || (!isB64 && !/^data:audio\//i.test(head))) {
            extra.push('[sesli mesaj okunamadı]');
            continue;
          }
          const buf = Buffer.from(sData.slice(ci + 1), isB64 ? 'base64' : 'utf8');
          if (!buf || !buf.length) { extra.push('[sesli mesaj okunamadı]'); continue; }
          const s2 = String(sid || '');
          const sttT0 = Date.now();
          try { emitWaBoth({ sessionId: s2, type: 'wa-stt', state: 'transcribing', from: 'telefon' }); } catch {}
          /* canlı konuşma parçaları: kısa gecikme için hızlı mod (beam 2) */
          const tr = await transcribeAudio(buf, undefined, mimeA, live ? 1 : undefined);
          try { emitWaBoth({ sessionId: s2, type: 'wa-stt', state: tr ? 'done' : 'fail', ms: Date.now() - sttT0 }); } catch {}
          extra.push(tr
            ? '[sesli mesaj transkripti]\n' + tr
            : '[sesli mesaj alındı ama transkripte çevrilemedi — masaüstünde STT modeli kurulu olmalı]');
        } catch (e) {
          extra.push('[sesli mesaj transkripti alınamadı: ' + String((e && e.message) || e) + ']');
        }
      }
      if (extra.length) finalText = (finalText ? finalText + '\n\n' : '') + extra.join('\n\n');
    } catch {}
    try {
      /* SLASH KOMUTLAR: masaüstüyle AYNI yönlendirici (/help, /new, /clear,
         /version, /model, /think ...) — ekler de korunur. */
      handleAgentSend(sid, {
        text: finalText.slice(0, 8000),
        attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined,
      });
    } catch {}
  },
  onOpen: (sid, replyS) => {
    try {
      touchPhoneSession(sid);
      if (mobileTtsCfg().enabled) mobileTtsWarm(); /* seslendirme açık → motor hazır olsun */
      if (!sid || !sessionFileAlive(sid)) {
        try { sendMobileHistory(sid, replyS); } catch {} /* boş snapshot döner */
        return;
      }
      desktopActiveSid = sid;
      sendMobileHistory(sid, replyS);
    } catch {}
  },
  onNew: (sendS) => {
    try {
      const v = createDesktopSession();
      switchDesktopSid(v.id); /* ana + cam da yeni oturuma taşınır */
      try { sendS({ t: 'session-switch', sessionId: v.id }); } catch {}
      desktopEcho(v.id, '/new', 'Yeni sohbet açıldı (telefondan) — sıfırdan konuşabilirsin. Eski sohbet listede duruyor.');
    } catch (e) {
      desktopEcho(desktopActiveSid || '', '/new', 'Yeni sohbet açılamadı: ' + String((e && e.message) || e));
    }
  },
  onInterrupt: (sid) => {
    try { engine.interrupt(sid, 'telefon dışından durdurma'); } catch {}
  },
  onSessions: (sendS) => {
    try {
      sendS({ t: 'sessions', list: mobileSessionsList(), activeSid: desktopActiveSid || '' });
    } catch {}
  },
  /* TELEFONDAN SİLME: chat seçicideki 🗑 → telefon bilgisayardaki oturumu da
     GERÇEKTEN siler (entegre). Çalışan tur varsa iptal edilir, masaüstü
     listesi de tazelenir; kanal (WA/TG/DC) eşlemesi ölü oturumda otomatik
     düşer — o numara/grup yeniden yazınca TAZE sohbet açılır. */
  onDelete: (sid, replyS) => {
    try {
      const id = String(sid || '');
      let ok = false;
      if (id && sessionFileAlive(id)) {
        try { engine.deleteSession(id); ok = true; } catch (e) { log.warn('mobile', 'oturum silinemedi: ' + String((e && e.message) || e)); }
      } else if (id) {
        /* dosyası zaten yok — hayalet kayıtları sil, tamam say */
        engine.deleteSession(id);
        ok = true;
      }
      if (String(desktopActiveSid || '') === id) desktopActiveSid = '';
      if (ok) broadcastMobileSessions();
      try { replyS({ t: 'session-del', sid: id, ok }); } catch {}
    } catch (e) {
      try { replyS({ t: 'session-del', sid: String(sid || ''), ok: false, why: String((e && e.message) || e) }); } catch {}
    }
  },
  /* ELLER SERBEST MOD: telefon konuşma döngüsünü açtığında/kapattığında
     oturumu 15 dk'lık faaliyet penceresiyle işaretler — tur 'done' olunca
     son cevap telefona sesli gönderilir (buradaki modele göre) */
  onTalk: (sid, on) => {
    try {
      touchPhoneSession(sid); /* M rozeti için dokunuş kaydı ayrı kalır */
      const id = String(sid || '');
      if (on && mobileTtsCfg().enabled) {
        phoneTalkMarks.set(id, Date.now());
        mobileTtsWarm(); /* canlı mod / eller serbest başladı → motoru ısıt */
      } else phoneTalkMarks.delete(id);
    } catch {}
  },
  /* TELEFONUN KENDİ TTS AYARI: masaüstü WA TTS'inden TAM BAĞIMSIZ —
     ayrı motor/şarlaj saklanır (settings.mobileTts), telefona anında devreye girer */
  onTtsCfg: (cfg) => {
    try {
      const c = mobileTtsCfg();
      if (cfg && typeof cfg === 'object') {
        c.enabled = !!cfg.enabled;
        if (MOBILE_TTS_ENGINES.includes(String(cfg.engine || ''))) c.engine = String(cfg.engine);
        const sp = Number(cfg.speed);
        if (Number.isFinite(sp) && sp >= 0.5 && sp <= 2) c.speed = sp;
        if (typeof cfg.voice === 'string') c.voice = cfg.voice.slice(0, 200);
        try { saveSettings(); } catch {}
        if (c.enabled) mobileTtsWarm();
        else { for (const k of [...phoneTtsJobs.keys()]) phoneTtsCancel(k); }
      }
    } catch {}
  },
  /* telefondan "sesi kes" (barge-in / yeni mesaj): akan parçaları durdur */
  onTtsStop: (sid) => {
    try { phoneTtsCancel(sid); } catch {}
  },
  onPair: (meta) => {
    try {
      device.upsertPhone({ id: meta.did, name: meta.name, platform: meta.platform });
    } catch {}
  },
};

let lastMobileStartError = '';

function mobileCfg() {
  try { return settings.mobile || (settings.mobile = { enabled: true, port: 8788, tunnel: { enabled: false, authtoken: '', domain: '' } }); } catch {}
  return { enabled: true, port: 8788, tunnel: { enabled: false, authtoken: '', domain: '' } };
}

/* mobile.tunnel alt configi: eski settings.json'larda alan yoktur → arza bakarız */
function mobileTunnelCfg() {
  const mc = mobileCfg();
  try { if (!mc.tunnel || typeof mc.tunnel !== 'object') mc.tunnel = { enabled: false, authtoken: '', domain: '' }; } catch {}
  try { mc.tunnel.enabled = !!mc.tunnel.enabled; } catch { mc.tunnel.enabled = false; }
  try { mc.tunnel.authtoken = String(mc.tunnel.authtoken || '').trim(); } catch { mc.tunnel.authtoken = ''; }
  try { mc.tunnel.domain = mobileTunnel.cleanDomain(mc.tunnel.domain); } catch { mc.tunnel.domain = ''; }
  return mc.tunnel;
}

/* LAN IPv4: telefondan bu PC'ye gitmek için adres (Wi-Fi/Ethernet ilk tercihi).
   169.254.* (APIPA/kablolu yok) ve docker/wsl farazidalleri elenir. */
function lanIp() {
  try {
    const ifs = os.networkInterfaces();
    const good = [];
    for (const name of Object.keys(ifs)) {
      for (const it of ifs[name] || []) {
        if (!it || it.internal || it.family !== 'IPv4') continue;
        const ip = String(it.address || '');
        if (!ip || ip.startsWith('169.254.') || ip.startsWith('127.')) continue;
        /* docker/wsl/hyper-v arayüzlerini arkaya al: öncelik puani */
        const low = name.toLowerCase();
        let prio = 5;
        if (/wi-fi|wlan|wl/.test(low)) prio = 1;
        else if (/ethernet|eth/.test(low)) prio = 2;
        if (/docker|vethernet|hyper-v|vmware|virtualbox|loopback/i.test(low)) prio = 9;
        good.push({ ip, prio });
      }
    }
    good.sort((a, b) => a.prio - b.prio);
    return good.length ? good[0].ip : '127.0.0.1';
  } catch { return '127.0.0.1'; }
}

/* listen() asynktir: renderer "kapalı" görmesin diye running/lastError oturasın —
   en çok 1 sn bekler (50ms x 20). enabled=false ise hemen döner. */
async function waitMobileSettled() {
  for (let i = 0; i < 20; i++) {
    if (!mobileCfg().enabled) break;
    const st = mobileWs.status();
    if (st.running || st.lastError) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return mobileWs.status();
}

function applyMobileServer() {
  try {
    const cfg = mobileCfg();
    if (cfg.enabled) {
      const r = mobileWs.start({
        port: Number(cfg.port) || 8788,
        getDeviceCode: () => device.getDevice().code,
        handlers: mobileHandlers,
        onStatus: () => {},
      });
      if (r && r.ok) {
        log.info('mobile', `WS köprüsü dinliyor: http://${lanIp()}:${Number(cfg.port) || 8788}`);
        /* WS ayağa kalktıysa tüneli (istendiyse) yeniden kur — dış adres de
           port değişince yenilenir; hata asla WS'i düşürmez */
        setTimeout(() => { applyMobileTunnel().catch(() => {}); }, 150);
      } else {
        lastMobileStartError = r && r.error ? String(r.error) : 'başlatılamadı';
        log.error('mobile', 'WS köprüsü başlatılamadı: ' + lastMobileStartError);
      }
    } else {
      mobileWs.stop();
      mobileTunnel.stopTunnel().catch(() => {});
    }
  } catch (e) {
    lastMobileStartError = String((e && e.message) || e);
    log.error('mobile', 'WS köprüsü başlatılamadı: ' + lastMobileStartError);
  }
}

/* ------------ INTERNET TÜNELİ (ngrok) ------------
   WS köprüsü yaşarken mobile.tunnel.enabled açıksa dışarı dial-out açar.
   Hata tünelde kalır — LAN köprüsü ve uygulama akışı etkilenmez. */
async function applyMobileTunnel() {
  const t = mobileTunnelCfg();
  try { await mobileTunnel.stopTunnel(); } catch {}
  if (!mobileCfg().enabled || !mobileWs.isRunning() || !t.enabled) {
    return { ok: false, error: '' };
  }
  const r = await mobileTunnel.startTunnel({
    port: Number(mobileCfg().port) || 8788,
    authtoken: t.authtoken,
    domain: t.domain,
  });
  if (r && r.ok) log.info('mobile', 'İnternet tüneli hazır: ' + r.url);
  else if (r && r.error) log.error('mobile', 'İnternet tüneli açılamadı: ' + r.error);
  return r;
}

/* ------------ BEAST MOBILE WATCHDOG (düzenli kontrol + otomatik onarım) ------------
   Köprü (WS sunucu) ve ngrok tüneli bazen SESSİZCE kopar: PC uykudan uyanınca
   listen alan port kapanmış olur, ISP/CNAT değişince ngrok agent'ı ölür, tek
   seferlik EADDRINUSE yakalanamaz... Kullanıcı elle "yeniden başlat"a kadar
   fark etmez. Bu bekçi düzenli aralıklarla UÇTAN UCA yoklar: /notif ucuna
   bilerek yanlış kodla istek atılır —403/200 dönüyorsa köprü (ve üzerinden
   geçiyorsa ngrok tüneli) gerçekten CANLI demektir. Cevap gelmezse önce tünel,
   sonra köprü yeniden kurulur; üst üste başarısızlıkta bekleme üstel artar
   (ngrok rate limit yemesin). Ayarlar → Beast Mobile panelinde canlı görünür. */
const MOBILE_WATCH_MS = 30 * 1000;            /* ne sıklıkla yoklanır */
const MOBILE_WATCH_RETRY_MS = 15 * 1000;      /* onarım sonrası kısa yerleşme payı */
const MOBILE_WATCH_BACKOFF_MAX = 10 * 60 * 1000;
const MOBILE_TUNNEL_PROBE_MS = 60 * 1000;     /* ngrok free: dışarı istek 60 sn'de birden fazla değil */
let mobileWatchTimer = null;
let mobileWatchBusy = false;
let mobileWatchFails = 0;    /* üst üste başarısız onarım (backoff sayacı) */
let mobileWatchNextAt = 0;   /* bu zamandan önce yeniden deneme yapılmaz */
let mobileWatchLastCheck = 0;
let mobileLastTunnelProbe = 0;
let mobileWatchLastFix = ''; /* panele gösterilen son otomatik işlem notu */

function mobileWatchNoteFix(note) {
  try { mobileWatchLastFix = new Date().toLocaleTimeString('tr-TR') + ' — ' + String(note || ''); } catch { mobileWatchLastFix = String(note || ''); }
}

/* UÇTAN UCA CANLILIK YOKLAMASI: /notif ucuna BİLEREK yanlış kod gönderilir.
   403 = köprü canlı (tunnel üzerinden geçiyorsa ngrok da dahil); 200 = cevap
   var sayılır; 404/502/503/504/bağlantı hatası = ölü. UA/Accept gönderilmez:
   ngrok free'ın tarayıcı-koruma ara sayfası tetiklenmesin. */
function mobileProbeAlive(urlBase, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (ok, note) => { if (!done) { done = true; resolve({ ok: !!ok, note: String(note || '') }); } };
    try {
      const u = String(urlBase || '').replace(/\/+$/, '') + '/notif?code=WATCHDOG-' + Date.now().toString(36);
      const mod = /^http:\/\//i.test(u) ? http : https;
      const req = mod.get(u, { timeout: timeoutMs || 6000 }, (res) => {
        try { res.resume(); } catch {}
        const s = Number(res.statusCode) || 0;
        fin(s === 403 || s === 200, 'http ' + s);
      });
      req.on('error', (e) => fin(false, String((e && e.code) || (e && e.message) || e)));
      req.on('timeout', () => { try { req.destroy(); } catch {} fin(false, 'timeout'); });
    } catch (e) { fin(false, String((e && e.message) || e)); }
  });
}

async function mobileWatchdogTick(force) {
  if (mobileWatchBusy) return;
  if (!force && Date.now() < mobileWatchNextAt) return;
  const cfg = mobileCfg();
  if (!cfg.enabled) { /* köprü kullanıcıca kapalı: kapalı olması normal */ mobileWatchFails = 0; return; }
  mobileWatchBusy = true;
  let restarted = false;
  try {
    mobileWatchLastCheck = Date.now();
    const port = Number(cfg.port) || 8788;
    const t = mobileTunnelCfg();

    /* 1) TÜNEL: köprü ayakta olsa bile ngrok koptuysa dışarıdan erişim biter */
    if (t.enabled) {
      const ts = mobileTunnel.status();
      if (!ts.running || !ts.url) {
        const r = await applyMobileTunnel();
        restarted = true;
        if (r && r.ok) { mobileWatchNoteFix('internet tüneli yeniden kuruldu'); log.info('mobile', 'watchdog: internet tüneli ayakta değildi — yeniden kuruldu'); }
      } else if (Date.now() - mobileLastTunnelProbe >= MOBILE_TUNNEL_PROBE_MS) {
        mobileLastTunnelProbe = Date.now();
        const p = await mobileProbeAlive(ts.url, 8000);
        if (!p.ok) {
          log.warn('mobile', 'watchdog: internet tüneli yanıt vermiyor (' + p.note + ') — yeniden kuruluyor');
          const r = await applyMobileTunnel();
          restarted = true;
          mobileWatchNoteFix(r && r.ok ? 'internet tüneli yeniden kuruldu (' + p.note + ')' : 'internet tüneli yeniden kurulamadı (' + p.note + ')');
        }
      }
    }

    /* 2) KÖPRÜ: WS sunucusu gerçekten dinliyor mu (uçtan uca) */
    const lp = await mobileProbeAlive('http://127.0.0.1:' + port, 5000);
    if (!lp.ok || !mobileWs.isRunning()) {
      log.warn('mobile', 'watchdog: WS köprüsü yanıt vermiyor (' + lp.note + ') — yeniden başlatılıyor');
      applyMobileServer(); /* WS + ardından 150ms içinde tünel otomatik */
      restarted = true;
      mobileWatchNoteFix('köprü yeniden başlatıldı (' + lp.note + ')');
      /* kurulum otursun diye kısa bir bekleme, ardından TÜNEL teyidi */
      await new Promise((r) => setTimeout(r, MOBILE_WATCH_RETRY_MS));
      if (t.enabled && !mobileTunnel.status().running) {
        const r2 = await applyMobileTunnel();
        if (r2 && r2.ok) mobileWatchNoteFix('köprü + internet tüneli yeniden kuruldu');
      }
    }

    /* SON DURUM: hâlâ kapalıysa üstel backoff, sağlıksa sayaçlar sıfırlanır */
    const stillDead = !mobileWs.isRunning() || (t.enabled && !mobileTunnel.status().running);
    if (stillDead) {
      mobileWatchFails = Math.min(mobileWatchFails + 1, 6);
      const wait = Math.max(MOBILE_WATCH_RETRY_MS, Math.min(MOBILE_WATCH_BACKOFF_MAX, MOBILE_WATCH_MS * Math.pow(2, mobileWatchFails)));
      mobileWatchNextAt = Date.now() + wait;
      log.warn('mobile', 'watchdog: hâlâ kapalı — ' + Math.round(wait / 1000) + ' sn sonra yeniden denenecek (' + mobileWatchFails + '. deneme)');
    } else if (restarted) {
      /* onarım İŞE YARADI: sayaç sıfırlanır, yalnız yerleşmesi için bir tur beklenir */
      mobileWatchFails = 0;
      mobileWatchNextAt = Date.now() + Math.max(MOBILE_WATCH_RETRY_MS, MOBILE_WATCH_MS);
    } else {
      mobileWatchFails = 0;
      mobileWatchNextAt = 0;
    }
  } catch (e) {
    try { log.warn('mobile', 'watchdog: ' + String((e && e.message) || e)); } catch {}
    mobileWatchFails = Math.min(mobileWatchFails + 1, 6);
    mobileWatchNextAt = Date.now() + Math.min(MOBILE_WATCH_BACKOFF_MAX, MOBILE_WATCH_MS * Math.pow(2, mobileWatchFails));
  } finally {
    mobileWatchBusy = false;
  }
}

function startMobileWatchdog() {
  if (mobileWatchTimer) return;
  mobileWatchTimer = setInterval(() => { mobileWatchdogTick().catch(() => {}); }, MOBILE_WATCH_MS);
  try { mobileWatchTimer.unref(); } catch {}
  /* ilk yoklama açılıştan hemen sonra: köprü/tünel geç oturmuş olabilir */
  setTimeout(() => { mobileWatchdogTick().catch(() => {}); }, 8000);
}
function stopMobileWatchdog() {
  try { if (mobileWatchTimer) clearInterval(mobileWatchTimer); } catch {}
  mobileWatchTimer = null;
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
    /* CRON TABAN OTURUMU: kişi sohbetlerinden tamamen bağımsız oturum */
    if (raw && typeof raw.cron === 'string' && raw.cron) tgCronSid = raw.cron;
    for (const [c, s] of tgChats.entries()) {
      const h = tgHistory.get(c) || [];
      if (!h.includes(s)) h.push(s);
      tgHistory.set(c, h.slice(-TG_HISTORY_CAP));
    }
  } catch {}
  /* GÖÇ: eski "tek oturum" düzeni → kişi başına oturum (sahip bağlamı korunur) */
  try {
    tgMigrateSharedSessions();
  } catch {}
})();

/* GÖÇ (Telegram): ortak oturum sahipte kalır; diğer sohbetler ayrılır. */
function tgMigrateSharedSessions() {
  const owners = tgOwnerIds();
  return chansessions.migrateSharedSessions({
    chats: tgChats,
    history: tgHistory,
    ownerDigits: (owners[0] || '').replace(/\D/g, ''),
    historyCap: TG_HISTORY_CAP,
  });
}

function saveTgChats() {
  try {
    fs.writeFileSync(
      TG_CHATS_FILE,
      JSON.stringify({
        chats: Object.fromEntries(tgChats),
        history: Object.fromEntries([...tgHistory.entries()].map(([c, a]) => [c, a.slice(-TG_HISTORY_CAP)])),
        cron: tgCronSid || '',
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
    /* GRUP: normal grup desteği kapalı — grup mesajları yalnız kaydedilir. */
    if (payload.isGroup) {
      tgRememberGroup(chatId, payload.chatTitle);
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
    /* /stop kilidi normal mesajla AÇILMAZ — mesaj yine işlenir (engine userAction),
       ama durdurulan iş/kuyruk kendiliğinden devam etmez */
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
  /* /version HER KANALDA: sürüm + npm'deki en son sürüm (izin kontrolü üstte) */
  const tgRaw = String((payload && payload.text) || '').trim();
  if (tgRaw === '/version' || tgRaw.startsWith('/version ')) {
    versionText(true)
      .then((txt) => sendTgSafe(chatId, txt))
      .catch(() => {});
    return;
  }
  /* KİŞİ BAŞINA OTURUM: her chatId kendi oturumunda; oturum yoksa açılır */
  const sid = ensureTgSession(chatId);
  tgLastActiveChatId = String(chatId);
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
    /* CRON TABAN OTURUMU: kişi sohbetlerinden tamamen bağımsız oturum */
    if (raw && typeof raw.cron === 'string' && raw.cron) dcCronSid = raw.cron;
    for (const [c, s] of dcChats.entries()) {
      const h = dcHistory.get(c) || [];
      if (!h.includes(s)) h.push(s);
      dcHistory.set(c, h.slice(-DC_HISTORY_CAP));
    }
  } catch {}
  /* GÖÇ: eski "tek oturum" düzeni → kişi başına oturum (sahip bağlamı korunur) */
  try {
    dcMigrateSharedSessions();
  } catch {}
})();

/* GÖÇ (Discord): ortak oturum sahipte kalır; diğer kanallar ayrılır. */
function dcMigrateSharedSessions() {
  const owners = dcOwnerIds();
  return chansessions.migrateSharedSessions({
    chats: dcChats,
    history: dcHistory,
    ownerDigits: (owners[0] || '').replace(/\D/g, ''),
    historyCap: DC_HISTORY_CAP,
  });
}

function saveDcChats() {
  try {
    fs.writeFileSync(
      DC_CHATS_FILE,
      JSON.stringify({
        chats: Object.fromEntries(dcChats),
        history: Object.fromEntries([...dcHistory.entries()].map(([c, a]) => [c, a.slice(-DC_HISTORY_CAP)])),
        cron: dcCronSid || '',
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
    /* /stop kilidi normal mesajla AÇILMAZ — mesaj yine işlenir (engine userAction),
       ama durdurulan iş/kuyruk kendiliğinden devam etmez */
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
  /* /version HER KANALDA: sürüm + npm'deki en son sürüm (izin kontrolü üstte) */
  const dcRaw = String((payload && payload.text) || '').trim();
  if (dcRaw === '/version' || dcRaw.startsWith('/version ')) {
    versionText(true)
      .then((txt) => sendDcSafe(channelId, txt))
      .catch(() => {});
    return;
  }
  /* KİŞİ BAŞINA OTURUM: her kanal kendi oturumunda; oturum yoksa açılır */
  const sid = ensureDcSession(channelId);
  dcLastActiveChannelId = String(channelId);
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
    /* mem0-native hafıza katmanı (semantik arama + konsolidasyon) — ayarlardan kapatılabilir */
    mem0: settings.mem0 !== false,
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
    /* GECE YANSIMASI: her gece hafıza sıkılaştırma + öğrenme journal'i */
    nightReflect: settings.nightReflect !== false,
    nightReflectAt: settings.nightReflectAt || null,
    approvals: settings.security && settings.security.approvals ? approvalsBridge : null,
    alwaysAllowTools: (settings.security && settings.security.alwaysAllow) || [],
    /* Supermemory (lokal) bellek katmanı — default açıktır (parseSettingsText);
       sunucu ayakta değilse engine klasik hafızaya düşer. Kapamak:
       settings.json → supermemory.enabled = false */
    supermemory: settings.supermemory || { enabled: true, baseUrl: 'http://localhost:6767', apiKey: '', containerTag: 'beast' },
    crashFile: FALLOUT_CRASH_FILE,
    notifyOwnerFail: settings.notifyOwnerFail !== false,
    /* tool yazım/doğrulama adımları → bağlı entegrasyonlara (WA/TG/Discord) */
    integrationNotify: integrationBroadcast,
    fileSend: deliverFile,
    channelSend: (args) => channelSendFromAgent(args),
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
      act: (op, args) => computerActScaled(op, args),
      observe: () => screenObserve(),
    },
    ocr: (o) => ocrRead(o),
    email: { list: emailList, read: emailRead, send: emailSend },
    browser: {
      openUrl: (u, s, ctx) => glassAwareNavigate(u, s, ctx),
      search: (q, s, ctx) => browserSearch(q, s, ctx),
      readText: (s) => browserRead(s),
      screenshot: (s) => browserScreenshot(s),
      snapshot: (s) => browserSnapshot(s),
      observe: (s) => browserObserve(s),
      act: (k, a, s) => browserAct(k, a, s),
      wait: (a, s) => browserWait(a, s),
    },
    research: {
      /* deep_search'ün "sayfayı GİZLİ tarayıcıda açıp oku" parçası (Electron-only).
         Arama zinciri engine._webSearchChain içinde web_search ile birebir aynı. */
      readPage: (u, s) => researchRead(u, s),
    },
    emit: (ev) => {
      if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev);
      /* CAM SOHBET relay: masaüstü glass panel canlı akışı da izler */
      try { if (glassWin && !glassWin.isDestroyed()) glassWin.webContents.send('agent:event', ev); } catch {}
      /* BEAST MOBILE: telefondaki APK/chat EKİ DE bu canlı pompa ile izler —
         (emitWaBoth yalnız WhatsApp kanalını taşır; masaüstü sohbet tokarak
         ana cam ekran gibi telefona da burada düşer) */
      try {
        if (ev && ev.type === 'sessions') broadcastMobileSessions(); /* boş sinyal → dolu liste */
        else mobileWs.broadcast(ev);
      } catch {}
      /* PARALEL AJAN BİTİŞİ: running → done/error/aborted geçişinde tek toast */
      if (ev.type === 'agents' && Array.isArray(ev.jobs)) {
        for (const j of ev.jobs) {
          const prev = bgNotifSeen.get(j.id);
          bgNotifSeen.set(j.id, j.status);
          if (prev === 'running' && j.status && j.status !== 'running' && j.status !== 'queued' && !j.continuous) {
            const durum = j.status === 'done' ? 'tamamlandı' : j.status === 'error' ? 'HATA ile bitti' : 'iptal edildi';
            toastNotify(`Ajan: ${j.title || j.code || 'görev'}`, durum, 'agents');
          }
        }
      }
      /* opencode permission (BC): ask kanalı UI'a zaten yukarıda düştü — WA
         sahibine de tek satır bildir gitsin (/approve · /approve always · /deny) */
      if (ev.type === 'permission.asked' && ev.request && wa && wa.connected) {
        try {
          const own = waOwnerNum();
          if (own) {
            const pats = Array.isArray(ev.request.patterns) ? ev.request.patterns.join(', ') : '*';
            sendWaSafe(
              own + '@s.whatsapp.net',
              '\u26A0\uFE0F *\u0130zin bekleniyor* \u2014 `' + String(ev.request.permission) + '`\n' +
                String(pats).slice(0, 160) + '\n\nOnayla: `/approve`\nBu desen i\u00e7in bir daha sorma: `/approve always`\nReddet: `/deny`'
            ).catch(() => {});
          }
        } catch {}
      }
      try { empatiRememberFromEvent(ev); } catch {} /* empati hafızası: sohbet → kayıt + ilgi öğrenme */
      empatiFlushInjectsOnDone(ev); /* tur ortasında kuyruğa düşen proaktif bildirimleri iş bitince geçmişe bas */
      flushDesktopOnDone(ev); /* biriken desktop mesajlarını sıraya bas */
      flushFileRecordsOnDone(ev); /* ajanın gonderdiği dosyaların KALICI kart kayıtları */
      bcFlushOnDone(ev); /* Beast Code kuyruğunu iş bitiminde boşalt */
      stFlushOnDone(ev); /* Beast Studio kuyruğunu iş bitiminde boşalt */
      sbFlushOnDone(ev); /* Sandbox kuyruğunu iş bitiminde boşalt */
      mcpChatFlushOnDone(ev); /* MCP sohbet kuyruğunu iş bitiminde boşalt */
      /* BC canlı önizleme: ajan bir dev server başlattıysa adresi yakala —
         preview butonu ve otomatik açılış DAİMA bu sunucuyu öncelikli kullanır */
      if (ev.type === 'bc-preview' && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?/i.test(String(ev.url || ''))) {
        /* klasör değiştiyse eski sunucu bayat: KAPAT, en yeniye geç */
        try {
          if (bcLastServerUrl && bcLastServerRoot && path.relative(bcLastServerRoot, ideRoot()) !== '') {
            bcKillServer(bcLastServerUrl);
          }
        } catch {}
        bcLastServerUrl = String(ev.url);
        try { bcLastServerRoot = ideRoot(); } catch { bcLastServerRoot = ''; }
      }
      /* Expo Go QR: ajanın dev sunucusu exp:// adresi yazdıysa QR üretip panele bas */
      if (ev.type === 'bc-expurl') {
        bcExpQrMake(String(ev.url || '')).catch(() => {});
      }
      /* WA canlı iş takibi: oturum bir WhatsApp sohbetine bağlıysa araç
         hareketlerini (terminal, web, dosya…) kısa satırla bildir.
         Spam olmasın: sohbet başına en az 7 sn'de bir tek satır. */
      if (ev.type === 'tool-start' && wa && wa.connected) {
        try {
          const pingJid = waReplyJid(ev.sessionId);
          if (pingJid) {
            const now = Date.now();
            const last = lastWaToolPing.get(ev.sessionId) || 0;
            if (now - last >= 7000) {
              lastWaToolPing.set(ev.sessionId, now);
              sendWaSafe(pingJid, '\u203A ' + String(waToolLine(ev.name, ev.args || {})).replace(/^\u203A /, '')).catch(() => {});
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
            const interJid = waReplyJid(ev.sessionId);
            if (interJid) sendWaSafe(interJid, mtxt).catch(() => {});
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
            promptTokens: ev.usage.prompt_tokens ?? ev.usage.input_tokens ?? 0,
            completionTokens: ev.usage.completion_tokens ?? ev.usage.output_tokens ?? 0,
            cacheReadTokens: ev.usage.cacheReadTokens || 0,
            cacheWriteTokens: ev.usage.cacheWriteTokens || 0,
            costIn: ev.meta ? ev.meta.costIn : null,
            costOut: ev.meta ? ev.meta.costOut : null,
          });
        } catch {}
      }
      /* CRON CEVABI AYRIMI: bu done/error cron işine aitse bekleme kaydını
         BURADA düş. Cron cevabı normal kanal akışından DEĞİL, aşağıdaki tek
         noktadan TÜM bağlı entegrasyonlara (WA base + TG + DC) yansıtılır —
         böylece ham cevap + önekli cevap çift gönderimi olmaz. */
      const cjob =
        ev.type === 'done' || ev.type === 'error' ? cronAnswerPendingTake(ev.sessionId) : null;
      /* cron turu bitti → kuyruktaki sıradaki işi başlat (tek tek koşarlar) */
      if (ev.type === 'done' || ev.type === 'error') cronJobFinished(ev.sessionId);
      // WhatsApp oturumlarının son cevabını geri gönder (metin + opsiyonel ses)
      if ((ev.type === 'done' || ev.type === 'error') && !cjob && wa && wa.connected) {
        const wajid = waReplyJid(ev.sessionId);
        if (wajid) {
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
                  if (voice && voice.audio) await wa.sendAudio(wajid, voice.audio).catch(() => {});
                }
              }
            } catch {}
            finally {
              try { await wa.setComposing(wajid, false); } catch {} // "yazıyor…" kapansın
            }
          })();
        }
      }
      /* BEAST MOBILE ELLER-SERBEST TTS: telefon bu oturumu talk modunda tutuyor
         (15 dk faaliyet penceresi) ise son asistan metni TELEFONUN KENDİ TTS
         motoruyla seslendirilir ve telefona dataUrl olarak gider — masaüstü
         WA TTS'inden TAMAMEN bağımsız, diğer istemciye yansımaz.
         AKIŞ: cevap cümlelere bölünür; ilk parça hemen, kalanı telefonda
         çalarken sentezlenir. Telefon parçaları kuyruğa alıp kesintisiz çalar. */
      if ((ev.type === 'done' || ev.type === 'error') && !cjob && mobileWs && mobileTalkActive(ev.sessionId)) {
        (async () => {
          try {
            const sidT = String(ev.sessionId || '');
            if (!sidT || !mobileTalkActive(sidT)) return;
            const sM = engine.openSession(sidT);
            if (!sM) return;
            const lastA2 = [...(sM.messages || [])].reverse().find((m) => m && m.role === 'assistant' && m.content);
            const ptxt = String(typeof (lastA2 && lastA2.content) === 'string' ? lastA2.content : '').trim();
            if (!ptxt || ptxt.length > 6000) return;
            await phoneTtsStream(sidT, ptxt);
          } catch {}
        })();
      }
      /* OPENCODE STEER ARA CEVABI: koşan tur sırasında gelen mesajın cevabı.
         'done' YOK (tur steer'le sürüyor) — bu yüzden done akışı YAZMAZ.
         Bağlı kanallara (WA/TG/DC) tek tek gider; SON cevap yine done'da. */
      if (ev.type === 'interim-final' && ev.message) {
        const txt = typeof ev.message.content === 'string' ? ev.message.content.trim() : '';
        if (txt) {
          (async () => {
            try {
              if (wa && wa.connected) {
                const jid = waReplyJid(ev.sessionId);
                if (jid) await sendWaSafe(jid, txt);
              }
            } catch {}
            try {
              if (tg && tg.connected) {
                const tgid = tgReplyChat(ev.sessionId);
                if (tgid) await sendTgSafe(tgid, txt);
              }
            } catch {}
            try {
              if (dc && dc.connected) {
                const dchid = dcReplyChannel(ev.sessionId);
                if (dchid) await sendDcSafe(dchid, txt);
              }
            } catch {}
          })();
        }
      }
      // Telegram oturumlarının son cevabını geri gönder (WA ile aynı akış)
      if ((ev.type === 'done' || ev.type === 'error') && !cjob && tg && tg.connected) {
        const tgid = tgReplyChat(ev.sessionId);
        if (tgid) {
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
      if ((ev.type === 'done' || ev.type === 'error') && !cjob && dc && dc.connected) {
        const dchid = dcReplyChannel(ev.sessionId);
        if (dchid) {
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
      /* CRON → TÜM BAĞLI ENTEGRASYONLAR: cron işi bittiğinde cevap (ya da
         hata) sahibe WhatsApp + Telegram + Discord'dan yansıtılır. Cron
         oturumu hiçbir kişi sohbetine bağlı olmadığı için ham cevap normal
         akıştan GİTMEZ — çift gönderim olmaz. Bayat (TTL aşımı) kayıt Take
         ile düşer, yansıtılmaz. */
      if (cjob && !ev.aborted) {
        (async () => {
          try {
            let txt = '';
            if (ev.type === 'error') {
              txt = '⚠️ [cronjob ' + String((cjob && cjob.id) || '?') + ']\nHata: ' + String(ev.error || '').slice(0, 200);
            } else {
              const s = engine.openSession(ev.sessionId);
              const lastA = [...s.messages].reverse().find((m) => m.role === 'assistant' && m.content);
              txt = typeof (lastA && lastA.content) === 'string' ? lastA.content : '';
              if (txt.trim()) txt = '⏰ [cronjob ' + String((cjob && cjob.id) || '?') + ']\n' + txt;
            }
            if (!txt.trim()) return;
            for (const m of cronMirrorTargets(String(ev.sessionId))) {
              try { await m.send(txt); } catch {}
            }
          } catch {}
        })();
      }
    },
  });
  /* PANEL RUN köprüsü: ajanın panel_run aracı → ÇALIŞTIR panelindeki yönetilen
     süreç koşucusu (sandbox:run IPC ile aynı makine). */
  engine.sbRunHook = sbRunStartManaged;
  /* SANDBOX KÖPRÜSÜ: ana sohbetteki ajanın sandbox_repo aracı → panel ile aynı
     makine (indir/kur/başlat/durdur); kullanıcı chatte repo linki bırakınca
     ajan kendisi indirip kurabilir. */
  engine.sbCloneHook = sbCloneRepo;
  engine.sbFolderHook = sbResolveFolder;
  engine.sbDetectHook = sbProjectInfoMerged;
  engine.sbInstallHook = sbInstallRepo;
  engine.sbStartHook = sbStartRepo;
  engine.sbStopHook = sbRunStopFolder;

  /* SQUEEZE (opsiyonel token sıkıştırma): varsayılan KAPALI; ayar açıksa
     her LLM isteğinin kopyası gönderimden önce sıkıştırılır. */
  squeeze.setEnabled(!!(settings.squeeze && settings.squeeze.enabled));
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
    /* KANAL İZOLASYONU: kişi sohbetleri özet dışıdır — özet masaüstü
       çalışmasından seçilir ve yanlış kişiye gönderilmez */
    const last = engine.lastWhereWasI(channelSessionIds());
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

  /* Kısayol yazıcı: masaüstü + Başlat menüsü kısayolları AUMID, ikon ve
     çalışma klasörüyle HER AÇILIŞTA tazelenir — eski kısayolda AUMID yoksa
     Windows görev çubuğunda/toast'ta electron.exe kimliğini gösteriyordu. */
function writeBeastShortcut(lnk) {
  const goodCwd = app.getPath('home');
  const base = {
    target: process.execPath,
    args: app.getAppPath(),
    cwd: goodCwd,
    description: 'Beast Agent — fast, light and resourceful',
    icon: path.join(__dirname, '..', 'assets', 'app.ico'),
    iconIndex: 0,
    appUserModelId: BEAST_AUMID,
  };
  if (fs.existsSync(lnk)) {
    /* mevcut kısayolu onar: AUMID + ikon + çalışma klasörü garantiye alınır */
    try {
      const cur = shell.readShortcutLink(lnk);
      return shell.writeShortcutLink(lnk, 'update', {
        ...cur,
        cwd: goodCwd,
        icon: base.icon,
        iconIndex: 0,
        appUserModelId: BEAST_AUMID,
      });
    } catch {}
  }
  return shell.writeShortcutLink(lnk, 'create', base);
}

/* npm (global) kurulumda masaüstü + Başlat menüsü kısayolları.
   (NSIS packaged modda kısayolları electron-builder zaten oluşturur.) */
function ensureShortcuts() {
  try {
    const desktopLnk = path.join(app.getPath('desktop'), 'Beast Agent.lnk');
    const okDesktop = writeBeastShortcut(desktopLnk);
    log.info('main', okDesktop ? 'Masaüstü kısayolu hazır (AUMID + ikon)' : 'Masaüstü kısayolu oluşturulamadı');
  } catch (e) {
    log.info('main', 'Masaüstü kısayol hatası: ' + String((e && e.message) || e));
  }
  try {
    /* Başlat menüsü kısayolu: Windows AUMID çözümünü (görev çubuğu ikonu +
       toast bildirim adı) öncelikle buradan okur */
    const startDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    fs.mkdirSync(startDir, { recursive: true });
    const okStart = writeBeastShortcut(path.join(startDir, 'Beast Agent.lnk'));
    log.info('main', okStart ? 'Başlat menüsü kısayolu hazır (AUMID + ikon)' : 'Başlat menüsü kısayolu oluşturulamadı');
  } catch (e) {
    log.info('main', 'Başlat menüsü kısayol hatası: ' + String((e && e.message) || e));
  }
}

/* TTS otomatik seslendirme: kullanıcı jesti olmadan Audio.play() çalışsın */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/* DAHİLİ TARAYICI CDP (HER AÇILIŞTA AÇIK): Jev (browser_agent) ve toollar
   (browser_js) daima DAHİLİ panelde çalışsın diye remote debug portu otomatik
   açılır — bat/argüman gerekmez. Chromium gerçek portu %APPDATA%\Beast Agent\
   DevToolsActivePort dosyasına yazar; browser_js önce o dosyayı okur, paneli
   bulamazsa zaten hata verir (yardımcı Chrome'a düşmez). Kullanıcı kendi
   --remote-debugging-port argümanını verdiyse ona dokunulmaz. */
try {
  const hasPort = process.argv.some((a) => /^--remote-debugging-port(=|$)/.test(String(a)));
  if (!hasPort) app.commandLine.appendSwitch('remote-debugging-port', '9234');
} catch {}

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
      ensureShortcuts();
    }
    /* AUMID ataması kısayollardan SONRA: görev çubuğu ve toast bildirimleri
       böylece Beast ikonunu/adını çözer (electron.exe kimliği ezilir) */
    assignAppUserModelId();
    reloadBackend();
    syncWhitelist(); // bot sistemi: whitelist.json aynası ilk açılışta garanti
    try { bots.ensureBotCodes(); } catch {} // her bota benzersiz 5 haneli kod garanti
    try { customtools.seedDefaults(); customtools.seedIfEmpty(); } catch {} // varsayılan toollar + kişisel toollar klasörü boşsa örnek tool kur
    createSplash();
    createWindow();
    log.info('main', 'Beast Agent başlatıldı');
    /* Daha önce kurulmuş OpenCode Bridge varsa sunucusunu erkenden ayağa
       kaldır; böylece kayıtlı provider portu/anahtarı tazelenir. */
    try {
      const bridgeWanted =
        settings.opencodeBridge === true ||
        (Array.isArray(settings.customProviders) &&
          settings.customProviders.some((p) => p && p.id === BRIDGE_PROVIDER_ID));
      if (bridgeWanted) {
        ensureOpenCodeBridge()
          .then(() => {
            try { win && !win.isDestroyed() && win.webContents.send('agent:event', { type: 'modelChanged' }); } catch {}
          })
          .catch((e) => log.error('main', 'OpenCode bridge başlatılamadı: ' + String((e && e.message) || e)));
      }
    } catch {}
    createTray();
    /* BEAST MOBILE: cihaz kodu garanti (yoksa üretilir, diskte kalıcı) +
       WS köprüsü WhatsApp/Telegram gibi AYNI süreçte otomatik başlar —
       ayrı program İSTİSNA GÖRULMEZ; ayar yerine Elektron açık kaldıkça canlı */
    try {
      device.ensureDevice();
      applyMobileServer();
      log.info('mobile', `cihaz kodu: ${device.deviceName()} · ${device.getDevice().code}`);
    } catch (e) { log.error('mobile', String((e && e.message) || e)); }
    /* BEAST MOBILE WATCHDOG: köprü + ngrok tüneli düzenli aralıklarla yoklanır,
       koparsa elle restart beklemeden kendiliğinden yeniden açılır */
    startMobileWatchdog();
    try {
      /* en sık kopma anı uyanmadır (port el çeker, ngrok agent'ı düşer):
         sistem uyanınca/ekran kilit çözülünce ilk yoklama hemen yapılır */
      powerMonitor.on('resume', () => { setTimeout(() => { mobileWatchdogTick(true).catch(() => {}); }, 3000); });
      powerMonitor.on('unlock-screen', () => { setTimeout(() => { mobileWatchdogTick().catch(() => {}); }, 5000); });
    } catch {}
    cron.init({ onFire: cronFire });
    watchers.start({ onTrigger: watcherFire });
    empatiKickoff(); // empati loop: açılış + 90 sn sonra ilk tarama, sonra cfg aralığı
    startEventBus();
    ideWatchStart(); // soldaki dosya ağacı canlı izlemede
    studioWatchStart(); // Beast Studio klasörü canlı izlemede
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

    // STT motoru: Duyu-small (yerel ONNX) — açılışta arka planda ısıtılır;
    // model eksikse burada sessizce iner (kullanıcı bekletilmez).
    if (settings.sttPrefetch !== false) {
      setTimeout(() => {
        duyu.warm()
          .then(() => waLog('STT hazır: ' + sttEngineLabel()))
          .catch((e) => waLog('STT prefetch atlandı: ' + String((e && e.message) || e)));
      }, 10000);
    }
    // TTS motoru: eMa Lightning (yerel) — AÇILIŞTA ısıtılır; TTS tercihi kapalı
    // olsa bile motor hazır bekler (soğuk ilk sentez ~9 sn geciktiriyordu).
    // Paket kurulu değilse sessizce atlanır — açılışta torch indirmesi başlamaz.
    setTimeout(() => {
      try {
        const m = ttsModule();
        const st = m.status();
        if (!st.pkg) {
          waLog('TTS prefetch atlandı: ' + ttsEngineLabel() + ' kurulu değil (pip paketi yok)');
          return;
        }
        m.warm()
          .then(() => waLog('TTS hazır: ' + ttsEngineLabel()))
          .catch((e) => waLog('TTS prefetch atlandı: ' + String((e && e.message) || e)));
      } catch {}
    }, 15000);
    /* TELEFON TTS SICAK TUTMA: telefon seslendirmesi son 30 dk içinde
       kullanıldıysa 2 dk'da bir kısa sentez — motor 15 dk boşta düşmeden
       hazır kalsın, sonraki cevap soğuk başlamasın. */
    setInterval(() => { try { mobileTtsHeartbeat(); } catch {} }, 120000).unref();

    /* EMBEDDING modeli (hafıza semantik arama) — açılışta otomatik indir */
    setTimeout(() => {
      try {
        require('./agent/mem0').search('beast', 'warmup')
          .then(() => waLog('embedding modeli hazır (all-MiniLM-L6-v2)'))
          .catch(() => {});
      } catch {}
    }, 20000);

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

    /* SÜRÜM GÜNCELLENDİYSE ilk açılışta bilgi: kanalların bağlanmasına 5 sn tanı,
       sonra kullanıcının olduğu yere (en güncel oturum + bağlı kanal) düşer */
    setTimeout(() => {
      try { notifyVersionUpdate(); } catch {}
    }, 5000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    app.on('before-quit', () => {
      app.isQuitting = true;
      flushBrowserStorage(); // x.com/google oturumları (cookies) diske yazılsın
      try { stopMobileWatchdog(); } catch {} // Beast Mobile bekçisi dur
      try { toolsMod.disposeShellSessions(); } catch {} // kalıcı shell oturumlarını kapat
      try { require('./agent/mcp').stopAll(); } catch {} // MCP server süreçlerini kapat
      try { stopOpenCodeBridge(); } catch {} // OpenCode bridge + alt sunucu
      try { if (jevMod) jevMod.backend.shutdown(); } catch {} // JevTrader köprüleri (MT5/api/wa/tg/dc)
    });

    if (process.argv.includes('--smoke')) {
      win.webContents.on('did-finish-load', () => setTimeout(() => app.exit(0), 1500));
      setTimeout(() => app.exit(1), 15000);
    }
  });
}

/* ---------- MASAÜSTÜ CAM SOHBET (neon glass panel) ----------
   Simge yanındaki İKİNCİ tray düğmesi (veya tray menüsü) tek tıkla açar/kapatır.
   Pencere: transparan + çerçevesiz + her zaman üstte. Boyut/konum settings.glass
   içinde hatırlanır; 'big' modu çalışma alanının %90'ını kaplar. */
/* ---------------- CAM MODU YARDIMCILARI ---------------- */
/* CAM MODU HARİCİ TARAYICI: cam modunda ana pencere gizli; ajanın
   browser_open ile açtığı sayfa ekranda görülemeyeceği için AYNI adres
   kullanıcının SİSTEM tarayıcısına da gönderilir. Ajanın içerik akışı
   (sayfa metni okuma vs.) gömülü tarayıcıyla aynen sürer. */
function isCamMode() {
  try { return !!(glassWin && !glassWin.isDestroyed() && glassWin.isVisible()); } catch { return false; }
}
async function glassAwareNavigate(raw, signal, ctx) {
  /* TARAYICI SEÇİMİ (cam özel): 'embedded' → yalnız panel içi;
     'external' (varsayılan) → aynı adres sistem tarayıcısında da açılır */
  if (isCamMode() && String((settings && settings.glassBrowser) || 'external') !== 'embedded') {
    try {
      const u = String(raw || '');
      if (/^https?:\/\//i.test(u)) shell.openExternal(u); /* fire & forget */
    } catch {}
  }
  return browserNavigate(raw, signal, ctx);
}

/* SON MOD HATIRLAMA: uygulama son hangi modda bırakıldıysa ('glass' | 'app')
   sonraki açılışta aynı modda başlar. */
function modeRemember(m) {
  try {
    if (settings.lastMode !== m) { settings.lastMode = m; saveSettings(); }
  } catch {}
}

function glassBounds() {
  try {
    const g = settings.glass || {};
    /* MİNİ BALON SIZINTISI KAYDININ TEMİZLİĞİ: kayıtta iki boyut da baloncuk
       ebadındaysa (≤120) bayat/bozuk kayıttır — merkezde varsayılan boyutla aç */
    if (Number(g.w) > 0 && Number(g.w) <= 120 && Number(g.h) > 0 && Number(g.h) <= 120) {
      const wd = screen.getPrimaryDisplay().workArea;
      return {
        x: Math.round(wd.x + (wd.width - 620) / 2),
        y: Math.round(wd.y + (wd.height - 700) / 2),
        width: 620, height: 700,
      };
    }
    /* ÇOKLU MONİTÖR: kayıtlı nokta hangi ekranın içindeyse o ekranın çalışma
       alanına göre ölçeklanır — ikinci monitörde bıraktıysa ORAYA açılır */
    let scr = screen.getPrimaryDisplay().workArea;
    if (Number.isFinite(g.x) && Number.isFinite(g.y)) {
      for (const d of screen.getAllDisplays()) {
        const wa = d.workArea;
        if (g.x >= wa.x - 40 && g.x < wa.x + wa.width && g.y >= wa.y - 40 && g.y < wa.y + wa.height) {
          scr = wa;
          break;
        }
      }
    }
    /* KULLANICININ SON BOYUT/KONUMU: settings.glass'ta saklanır — kullanıcı
       değiştirmediği sürece cam sohbet HEP AYNI şekilde açılır. Yalnızca
       değer ekran dışına düştüyse (monitör değişimi vb.) ekrana geri çakılır. */
    const w = Math.max(320, Math.min(Number(g.w) || 620, scr.width - 24));
    const h = Math.max(240, Math.min(Number(g.h) || 700, scr.height - 24));
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    const x = Number.isFinite(g.x)
      ? clamp(g.x, scr.x - w + 160, scr.x + scr.width - 160)
      : Math.round(scr.x + (scr.width - w) / 2);
    const y = Number.isFinite(g.y)
      ? clamp(g.y, scr.y, scr.y + scr.height - 160)
      : Math.round(scr.y + (scr.height - h) / 2);
    return { x, y, width: w, height: h };
  } catch {
    return { width: 620, height: 700 };
  }
}

/* taşımada her pikselde settings.json'a yazma — 800ms sakinleşince toplu yaz */
let glassRememberTimer = 0;
function glassRememberBounds() {
  try {
    if (glassMiniOn) return; /* mini balon boyutu ASLA kalıcı yazılmaz */
    clearTimeout(glassRememberTimer);
    glassRememberTimer = setTimeout(() => {
      try {
        /* İKİNCİL EMNİYET: mini baloncuk boyutu (84×84) asla kalıcı yazılmaz —
           mini geçiş sırasında tetiklenen olaylar sızıntı yapamaz */
        if (glassMiniOn || !glassWin || glassWin.isDestroyed()) return;
        const b = glassWin.getBounds();
        settings.glass = { ...(settings.glass || {}), x: b.x, y: b.y, w: b.width, h: b.height };
        saveSettings();
        glassAppbarEval(); /* taşınma/boyut sonrası dock durumunu yeniden değerlendir */
      } catch {}
    }, 800);
  } catch {}
}

/* CAM PANELINE masaüstünün AKTİF sohbetini bildir — cam, "beast-agent'taki
   chat"i gerçek zamanlı izler (WA sesli mesaj/transkript dahil her şey) */
function glassPushActiveSid() {
  try {
    if (glassWin && !glassWin.isDestroyed() && desktopActiveSid) {
      glassWin.webContents.send('agent:event', { type: 'glass-session', sessionId: desktopActiveSid });
    }
  } catch {}
}

/* ---------- CAM DOCK (APPBAR): sağ kenara yaslanan cam İÇİN ŞERİT REZERVİ ----------
   Windows appbar API (SHAppBarMessage) ile cam sağ kenara yaslanınca OS'a
   "bant" olarak bildirilir: diğer pencereler MAXIMIZE olunca o şeride GİRMEZ,
   camın YANINA büyür (fotodaki VS Code durumu). Cam kenardan çekilince rezerv
   kaldırılır → normal tam ekran davranışına döner. Mini balonda da kapalı. ---------- */

const glassAppbarPsPath = () => path.join(APP_DIR, 'glass-appbar.ps1');

let glassAppbarActive = false; /* appbar şu an kurulu mu (quit senkronu için) */
let glassAppbarTimer = 0;
let glassAppbarHwnd = 0; /* cam penceresinin gerçek Windows HWND'si (BigInt) */

/* betik bir kez APP_DIR'e (appData\beast) yazılır; her çağrı powershell -File */
function glassAppbarScript() {
  try {
    const ps = [
      "param([string]$Mode = 'remove', [long]$Hwnd = 0, [int]$Width = 0, [int]$X = 0, [int]$Y = 0)",
      "$ErrorActionPreference = 'SilentlyContinue'",
      "Add-Type -TypeDefinition @'",
      "using System;",
      "using System.Runtime.InteropServices;",
      "public class BeastAppBar {",
      "  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }",
      "  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }",
      "  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }",
      "  [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA { public int cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public int lParam; }",
      "  [DllImport(\"shell32.dll\")] public static extern uint SHAppBarMessage(uint msg, ref APPBARDATA d);",
      "  [DllImport(\"user32.dll\")] public static extern IntPtr MonitorFromPoint(POINT p, uint f);",
      "  [DllImport(\"user32.dll\")] public static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFO mi);",
      "}",
      "'@",
      "if ($Hwnd -le 0) { return }",
      "$cb = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'BeastAppBar+APPBARDATA')",
      "$d = New-Object 'BeastAppBar+APPBARDATA'",
      "$d.cbSize = $cb; $d.hWnd = [IntPtr]$Hwnd",
      "if ($Mode -eq 'remove') { [void][BeastAppBar]::SHAppBarMessage(1, [ref]$d); return }",
      "if ($Width -le 0) { [void][BeastAppBar]::SHAppBarMessage(1, [ref]$d); return }",
      "$pt = New-Object 'BeastAppBar+POINT'; $pt.X = $X; $pt.Y = $Y",
      "$hMon = [BeastAppBar]::MonitorFromPoint($pt, 2)",
      "$mi = New-Object 'BeastAppBar+MONITORINFO'",
      "$mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'BeastAppBar+MONITORINFO')",
      "[void][BeastAppBar]::GetMonitorInfo($hMon, [ref]$mi)",
      "$d.uCallbackMessage = 0x8000; $d.uEdge = 2",
      "$d.rc = $mi.rcMonitor",
      "$d.rc.L = $mi.rcMonitor.R - $Width",
      "[void][BeastAppBar]::SHAppBarMessage(0, [ref]$d)  # ABM_NEW",
      "[void][BeastAppBar]::SHAppBarMessage(2, [ref]$d)  # ABM_QUERYPOS",
      "[void][BeastAppBar]::SHAppBarMessage(3, [ref]$d)  # ABM_SETPOS",
    ].join('\r\n');
    fs.mkdirSync(APP_DIR, { recursive: true });
    const cur = (() => { try { return fs.readFileSync(glassAppbarPsPath(), 'utf8'); } catch { return ''; } })();
    if (cur !== ps) fs.writeFileSync(glassAppbarPsPath(), ps, 'utf8');
    return glassAppbarPsPath();
  } catch { return null; }
}

/* durum değerlendir: cam sağ kenara yaslıysa appbar kur; değilse kaldır */
function glassAppbarEval() {
  clearTimeout(glassAppbarTimer);
  glassAppbarTimer = setTimeout(() => {
    try {
      if (!fs || process.platform !== 'win32') return;
      if (!glassWin || glassWin.isDestroyed() || !glassWin.isVisible()) { glassAppbarApply('remove'); return; }
      const b = glassWin.getBounds();
      if (b.width < 150) { glassAppbarApply('remove'); return; } /* mini balon vs. */
      const disp = screen.getDisplayNearestPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      const db = disp.bounds;
      const flushRight = Math.abs((b.x + b.width) - (db.x + db.width)) <= 48;
      const inside = b.x >= db.x - 40 && b.y >= db.y - 40 && (b.y + b.height) <= (db.y + db.height) + 40;
      if (flushRight && inside && b.width < db.width * 0.6) {
        glassAppbarApply('set', Math.round(b.width * disp.scaleFactor), db.x + db.width / 2, db.y + db.height / 2);
      } else {
        glassAppbarApply('remove');
      }
    } catch { glassAppbarApply('remove'); }
  }, 350);
}

function glassAppbarApply(mode, width, hintX, hintY) {
  const script = glassAppbarScript();
  if (!script) return;
  const isSet = mode === 'set' && width > 0;
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Mode', isSet ? 'set' : 'remove',
    '-Hwnd', String(glassAppbarHwnd)];
  if (isSet) args.push('-Width', String(width), '-X', String(Math.round(hintX)), '-Y', String(Math.round(hintY)));
  try {
    spawn('powershell.exe', args, { windowsHide: true, detached: true, stdio: 'ignore' }).on('close', () => {
      glassAppbarActive = isSet;
    });
  } catch {}
}

/* çıkış emniyeti: appbar kuruluysa SENKRON kaldır (async spawn çıkışa yetişmez) */
function glassAppbarQuitSync() {
  try {
    if (!glassAppbarActive || process.platform !== 'win32') return;
    const script = glassAppbarScript();
    if (!script) return;
    const { execFileSync } = require('child_process');
    execFileSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Mode', 'remove', '-Hwnd', String(glassAppbarHwnd),
    ], { windowsHide: true, timeout: 4000, stdio: 'ignore' });
    glassAppbarActive = false;
  } catch {}
}

/* ---------- CAM DOCK SONU ---------- */

/* çıkışta rezerv düşer: cam kapalıyken diğer uygulamalar NORMAL tam ekran olur */
app.on('before-quit', () => {
  try { glassAppbarQuitSync(); } catch {}
});

function glassOpen(hideMain) {
  try {
    modeRemember('glass'); /* son mod = cam — sonraki açılışta cam modunda başlar */
    const b = glassBounds();
    if (!glassWin || glassWin.isDestroyed()) {
      glassWin = new BrowserWindow({
        x: b.x, y: b.y, width: b.width, height: b.height,
        frame: false, transparent: true, resizable: true, maximizable: false,
        alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: false,
          spellcheck: false,
          backgroundThrottling: false, /* odak dışındayken canlı akış kesilmesin */
        },
      });
      /* TOPMOST SEVİYESİ: cam 'screen-saver' katmanında — topmost'un en üst
         kademesi. Normal maximize/tam ekran pencereler (VS Code vb.) camın
         ÜSTÜNE GELEMEZ. (Oyunların exclusive fullscreen OS modu hariç — o modda
         Windows her şeyi kapatır, istisna.) */
      glassWin.setAlwaysOnTop(true, 'screen-saver');
      try {
        /* appbar kaydı için gerçek Windows HWND'si (8 byte buffer → BigInt) */
        glassAppbarHwnd = glassWin.getNativeWindowHandle().readBigUInt64LE(0);
      } catch { glassAppbarHwnd = 0; }
      glassWin.loadFile(path.join(__dirname, 'renderer', 'glass.html'));
      /* NOTE: setBackgroundMaterial('acrylic') DENEMEDİ — transparent pencerede
         DWM malzemesi pencere dikdörtgenini GRİ KUTU olarak boyuyor ve panelin
         dışta kalan kenarını "gri kare" yapar. Cam görünüm tamamen CSS'te. */
      glassWin.on('closed', () => { glassWin = null; glassAppbarHwnd = 0; glassAppbarActive = false; });
      /* taşınma/boyutlanma her koşulda yakalansın ('moved'/'resized' + 'move'/
         'resize' ikilisi) — debounce sayesinde 800ms'de bir Toplu yazım */
      glassWin.on('moved', () => glassRememberBounds());
      glassWin.on('resized', () => glassRememberBounds());
      glassWin.on('move', () => glassRememberBounds());
      glassWin.on('resize', () => glassRememberBounds());
      glassWin.on('ready-to-show', () => {
        try {
          glassWin.show();
          glassWin.focus();
          /* CAM AÇILIŞ SENKRONU: panel, masaüstünün AÇIK OLan sohbetini izlemeye
             başlar — cam moduna geçen kullanıcı "aynı sohbet burda da var" görür */
          try { glassPushActiveSid(); } catch {}
          glassAppbarEval(); /* sağ kenara yaslıysa dock rezervi hemen başlasın */
          /* CAM MODU: ana pencere cam panel AYAKLANINCA gizlenir — tek pencere
             görünür, kullanıcı "uygulama cam şekline dönüştü" hisseder */
          if (hideMain && win && !win.isDestroyed() && win.isVisible()) win.hide();
        } catch {}
      });
    } else {
      /* pencere zaten var: konum/boyut DOKUNULMAZ — kullanıcı bıraktığı yerde
         ve boyutta açılır (hatırlama kuralı) */
      if (glassMiniOn) glassMiniSet(false); /* mini durumdan indir, tam panel göster */
      if (hideMain && win && !win.isDestroyed() && win.isVisible()) win.hide();
      if (!glassWin.isVisible()) { glassWin.show(); glassWin.focus(); }
      try { glassPushActiveSid(); } catch {} /* tekrar açılışta da senkron */
      glassAppbarEval(); /* tekrar açılışta dock durumunu da yenile */
    }
    return true;
  } catch {
    return false;
  }
}

function glassHide() {
  try {
    if (glassWin && !glassWin.isDestroyed() && glassWin.isVisible()) {
      glassWin.hide();
      /* gizlerken SON boyut/konumu ANINDA kalıcı kıl (debounce beklemeden) —
         hemen ardından uygulama kapanırsa bile bir sonraki açılış aynı şeklide */
      if (!glassMiniOn) {
        try {
          const b = glassWin.getBounds();
          settings.glass = { ...(settings.glass || {}), x: b.x, y: b.y, w: b.width, h: b.height };
          saveSettings();
        } catch {}
      }
      glassAppbarApply('remove'); /* cam gizli → dock rezervi kalkar, normal tam ekran */
    }
  } catch {}
}

/* RESİM YAPAR (cam butonu çift yönlü): cam açık → ana uygulamaya dön;
   ana uygulama görünür → cam moduna geç */
function glassSwitch() {
  try {
    const glassUp = glassWin && !glassWin.isDestroyed() && glassWin.isVisible();
    if (glassUp) {
      glassHide();
      modeRemember('app'); /* son mod = uygulama */
      showWin(); /* masaüstü Beast Agent uygulamasına dönüş */
    } else {
      glassOpen(true); /* uygulama → cam modu */
    }
  } catch {}
}

/* MİNİ BALON (cam özel): panel 84px baloncuk gibi köşeye çekilir; baloncuk
   tıklanınca eski boyut/konum geri gelir. skipTaskbar pencere olduğu için
   klasik görev çubuğu simgesi GÖRÜNMEZ — bu yüzden mantık baloncuktur. */
let glassMiniOn = false;
let glassMiniSaved = null;
function glassMiniSet(on) {
  try {
    if (!glassWin || glassWin.isDestroyed()) return false;
    if (on) {
      if (!glassMiniOn) {
        const b = glassWin.getBounds();
        glassMiniSaved = { x: b.x, y: b.y, width: b.width, height: b.height };
        /* TAM boyutu ANINDA kalıcı yaz — küçülme olayları sıza sıza geçilemez */
        try {
          settings.glass = { ...(settings.glass || {}), x: b.x, y: b.y, w: b.width, h: b.height };
          saveSettings();
        } catch {}
      }
      const scr = screen.getPrimaryDisplay().workArea;
      glassWin.setBounds({ x: scr.x + scr.width - 96, y: scr.y + scr.height - 96, width: 84, height: 84 });
      glassMiniOn = true;
      glassAppbarApply('remove'); /* balon dock'a sığmaz — rezerv kalkar */
    } else {
      if (glassMiniSaved) {
        try { glassWin.setBounds(glassMiniSaved); } catch {}
      }
      glassMiniSaved = null;
      glassMiniOn = false;
    }
    try { glassWin.webContents.send('glass:mini', glassMiniOn); } catch {}
    if (!glassMiniOn) glassAppbarEval(); /* balondan çıktı → dock durumunu yenile */
    return true;
  } catch { return false; }
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
    /* CAM SOHBET butonu TRAY'DE DEĞİL — ana uygulamanın sağ üst pencere
       butonlarında (en soldaki cam düğmesi) yaşamaya geçti */
  } catch {}
}

function showWin() {
  if (!win || win.isDestroyed()) createWindow();
  else {
    win.show();
    win.focus();
  }
}

/* ---------- Windows toast bildirimi ----------
   watcher/cron/paralel ajan bitişinde sistem bildirimi; tıklanınca pencere
   açılır ve renderer'a notify-click eventi gider (ilgili panel açılır).
   Ayarlardan kapatılabilir: settings.notifyToast === false */
function toastNotify(title, body, target) {
  try {
    if (settings.notifyToast === false) return;
    if (typeof Notification === 'undefined' || !Notification.isSupported()) return;
    const n = new Notification({
      title: String(title || 'Beast Agent').slice(0, 120),
      body: String(body || '').slice(0, 240),
      icon: path.join(__dirname, '..', 'assets', 'logo.png'),
      silent: false,
    });
    n.on('click', () => {
      showWin();
      if (win && !win.isDestroyed()) {
        win.webContents.send('agent:event', { type: 'notify-click', target: String(target || '') });
      }
    });
    n.show();
  } catch {}
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
/* TELEFON SİLUETİ (mobil önizleme): WebContentsView'ı cihaz ekranı boyutuna
   küçültür, çerçeve DOM'da çizilir. Değerler renderer'daki PF_* sabitleriyle
   BİREBİR aynı olmalı (PF_BEZEL / PF_STATUS / PF_HOME). */
const PHONE_BEZEL = 12;   // cihaz çerçevesi kenar kalınlığı (üst/alt/yan hep aynı — halka çerçeve)
const PHONE_STATUS = 0;   // çentik/durum çubuğu KALDIRILDI — ekran tam görünür
const PHONE_HOME = 0;     // home çubuğu çerçeve halkasının içine taşındı (ekrandan yer almaz)
const DEV_PORTS = [8081, 19006, 5173, 3000, 5174, 19001, 4200, 4321];
const DEV_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|(?:192\.168|10\.\d+|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+):(\d{2,5})/;

/* CİHAZ KATALOĞU: gerçek CSS piksel ölçüleri (portrait). apple=true → çentik
   (Dynamic Island), değilse punch-hole kamera noktası çizilir. UA cihaz başına. */
const PHONE_DEVICES = {
  iphone15promax: { name: 'iPhone 15 Pro Max', w: 430, h: 932, apple: true },
  iphone15pro:    { name: 'iPhone 15 Pro',     w: 393, h: 852, apple: true },
  iphone14:       { name: 'iPhone 14',         w: 390, h: 844, apple: true },
  iphonese:       { name: 'iPhone SE',         w: 375, h: 667, apple: true },
  pixel8:         { name: 'Pixel 8',           w: 412, h: 915, apple: false },
  galaxys23:      { name: 'Galaxy S23',        w: 360, h: 780, apple: false },
  android:        { name: 'Android (genel)',   w: 360, h: 800, apple: false },
};
const PHONE_UA_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Version/17.5 Mobile/15E148 Safari/604.1';

function phoneDevice() {
  return PHONE_DEVICES[browser.deviceKey] || PHONE_DEVICES.iphone14;
}

function isDevServerUrl(url) {
  const m = DEV_URL_RE.exec(String(url || ''));
  if (!m) return false;
  const port = Number(m[1]);
  /* expo native/log portları web önizleme değildir */
  return port !== 19000 && port !== 19001 && port !== 19002;
}

/* Tarayıcı state: visible=false → ajanlar GİZLİ kullanır (headless);
   göz ikonuyla görünür mod açılır. open=view aktif, visible=panelde görünürlük */
const browser = { view: null, open: false, visible: false, width: 0, attached: false, started: false, phone: false, mobile: false, mobileRect: null, deviceKey: 'iphone14', bottomInset: 0, desktopUA: '' };
browser.mobile = false; // mobil önizleme (telefon silueti) şimdilik devre dışı
if (PHONE_DEVICES[settings.browserDevice]) browser.deviceKey = settings.browserDevice;

function browserEmit(payload) {
  /* phoneRect/device HER olayda taşınır — site değişse bile siluet bozulmaz */
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', {
    type: 'browser',
    visible: browser.visible,
    phone: browser.phone,
    mobile: browser.mobile,
    phoneRect: browser.mobileRect,
    device: browser.deviceKey,
    ...payload,
  });
}

function browserWidthFor(w) {
  return Math.max(380, Math.min(800, Math.floor(w * 0.46)));
}

/* emit'lerdeki genişlik HEP gösterilen genişlik olmalı (telefon modunda 430) —
   yoksa yüklenme bitince dock eski genişliğine döner, daralan solda boşluk bırakır */
function browserW() {
  try { return win.getContentSize()[0]; } catch { return 0; }
}

/* Tarayıcı gizleme ÖZELLİĞİ: Ayarlar → Web Arama'dan açılır, VARSAYILAN KAPALI.
   Kapalıyken tarayıcı her zaman görünür; açıkken göz ikonu gizle/göster yapar. */
function browserHideEnabled() { return settings.browserHide === true; }
function browserHeadlessPref() { return browserHideEnabled() && settings.browserHeadless === true; }

function browserShownWidth(w) {
  const avail = Math.max(320, w - 320);
  /* MOBİL ÖNİZLEME: siluet + çerçeve payı — siluet tam otursun (phone-mode'dan önce) */
  if (browser.mobile) return Math.min(470, avail);
  /* TELEFON MODU: dock KENDİSİ daralır (~430px) — sayfa mobil düzenle
     kenarlara tam oturur; kapatınca kullanıcı genişliği geri gelir */
  if (browser.phone) return Math.min(430, avail);
  return Math.min(browser.width, avail);
}

/* Telefon siluetinin EKRAN dikdörtgeni (WebContentsView buraya oturur;
   çerçeve/çentik/home bar DOM'da çizilir). ÖNCE cihazın GERÇEK ölçüsü denenir
   (ör. tam 393×844 — uygulama device-width'i gerçekten cihaz genişliği görür,
   mobile TAM uyum); sığmazsa orana göre küçültülür, tavan dock'un %80'i,
   dikeyde ortalanır. */
function browserPhoneRect(w, h) {
  const dev = phoneDevice();
  const shownWidth = browserShownWidth(w);
  const dockX = Math.max(0, w - shownWidth);
  const availH = Math.max(240, h - BROWSER_TOOLBAR_H - (browser.bottomInset || 0));
  const chromeH = PHONE_BEZEL * 2 + PHONE_STATUS + PHONE_HOME;
  const outerCap = Math.max(320, Math.round(availH * 0.8));
  let ph = Math.min(availH - chromeH, outerCap - chromeH);
  let pw;
  if (dev.h + chromeH <= availH && dev.w + PHONE_BEZEL * 2 + 8 <= shownWidth) {
    /* 1) doğal boyut: cihaz ekranı sığıyorsa BİREBİR o ölçü kullanılır */
    ph = dev.h;
    pw = dev.w;
  } else {
    /* 2) sığmıyor: yükseklik bütçesine göre orana küçült */
    pw = Math.round(ph * (dev.w / dev.h));
    const maxPw = shownWidth - PHONE_BEZEL * 2 - 8;
    if (pw > maxPw) {
      pw = Math.max(200, maxPw);
      ph = Math.round(pw * (dev.h / dev.w));
    }
  }
  const outerH = ph + chromeH;
  const y0 = BROWSER_TOOLBAR_H + Math.max(0, Math.round((availH - outerH) / 2));
  return {
    x: dockX + Math.round((shownWidth - pw) / 2),
    y: y0 + PHONE_BEZEL + PHONE_STATUS,
    width: pw,
    height: Math.max(240, ph),
  };
}

/* Mobil önizleme scrollbar'ı gizle: kaydırma yine de siluetin İÇİNDE çalışır,
   sadece masaüstü çubuğu görünmez (telefon hissi). Sayfa değişiminde yeniden enjekte edilir. */
const PHONE_SCROLL_CSS =
  '::-webkit-scrollbar{width:0!important;height:0!important}' +
  '::-webkit-scrollbar-thumb{background:transparent!important}' +
  'html{scrollbar-width:none!important} body{overscroll-behavior:contain}';

/* DOKUNMATİK SÜRÜKLE-KAYDIR: tut + aşağı çek = sayfa telefonda olduğu gibi
   akar (atalet/momentum dahil). Bağlantı/buton/giriş alanlarına dokunmaz —
   tıklamalar normal çalışır; 4px eşikini aşan sürükleme tıkı yutar. */
const PHONE_SCROLL_JS = `(function(){
  if (window.__beastTouchScroll) return; window.__beastTouchScroll = true;
  var S = null;
  var INTERACTIVE = 'a,button,input,textarea,select,label,summary,option,[contenteditable="true"],video,audio,iframe,canvas,svg,[draggable="true"]';
  function scrollableAt(x, y) {
    var el = document.elementFromPoint(x, y);
    while (el && el !== document.documentElement) {
      var cs = getComputedStyle(el);
      var oy = cs.overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 2) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }
  window.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || e.defaultPrevented) return;
    var t = e.target;
    if (t && t.closest && t.closest(INTERACTIVE)) return;
    var el = scrollableAt(e.clientX, e.clientY);
    if (!el) return;
    S = { el: el, y0: e.clientY, y: e.clientY, top: el.scrollTop, moved: false, vel: 0, lt: performance.now() };
  }, true);
  window.addEventListener('mousemove', function (e) {
    if (!S) return;
    var dy = e.clientY - S.y; S.y = e.clientY;
    if (!S.moved && Math.abs(e.clientY - S.y0) < 4) return;
    if (!S.moved) { S.moved = true; document.body.style.userSelect = 'none'; }
    var now = performance.now();
    var dt = Math.max(1, now - S.lt); S.lt = now;
    S.vel = 0.8 * (-dy / dt * 16.7) + 0.2 * S.vel;
    S.el.scrollTop = S.top - (e.clientY - S.y0);
    e.preventDefault(); e.stopPropagation();
  }, true);
  window.addEventListener('click', function (e) {
    if (S && S.moved) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.addEventListener('mouseup', function (e) {
    if (!S) return;
    var s = S; S = null;
    document.body.style.userSelect = '';
    if (!s.moved) return;
    e.preventDefault();
    var v = s.vel;
    (function step() {
      v *= 0.94;
      if (Math.abs(v) < 0.6) return;
      s.el.scrollTop -= v;
      requestAnimationFrame(step);
    })();
  }, true);
  var st = document.createElement('style');
  st.textContent = '*{touch-action:pan-y}';
  document.documentElement.appendChild(st);
})();`;

function injectPhoneScrollCss() {
  try {
    const wc = browser.view && browser.view.webContents;
    if (wc && browser.mobile) {
      wc.insertCSS(PHONE_SCROLL_CSS, { cssOrigin: 'user' }).catch(() => {});
      wc.executeJavaScript(PHONE_SCROLL_JS, false).catch(() => {});
    }
  } catch {}
}

/* GERÇEK TELEFON DOKUNMASI: Chromium dokunma emülasyonu — fare sürükleme gerçek
   dokunma olayına döner; sayfa NATİVE momentumla kayar (tut-aşağı-çek tam telefon
   gibi). RN web/Pressable da gerçek touch alır. CDP oturumu gezinmelerde kalıcıdır. */
async function applyPhoneTouchEmulation() {
  try {
    const wc = browser.view && browser.view.webContents;
    if (!wc || !browser.mobile) return;
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
  } catch (e) {
    waLog('telefon dokunma emülasyonu: ' + String((e && e.message) || e).slice(0, 120));
  }
}

function clearPhoneTouchEmulation() {
  try {
    const wc = browser.view && browser.view.webContents;
    if (!wc || !wc.debugger.isAttached()) return;
    wc.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', { enabled: false }).catch(() => {});
  } catch {}
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
    /* MOBİL ÖNİZLEME: view cihaz ekranı boyutuna küçülür — çerçeve DOM'da çizilir */
    let bounds = { x: Math.max(0, w - shownWidth), y: BROWSER_TOOLBAR_H, width: shownWidth, height: Math.max(0, h - BROWSER_TOOLBAR_H - (browser.bottomInset || 0)) };
    if (browser.mobile && browser.visible) {
      const r = browserPhoneRect(w, h);
      browser.mobileRect = r;
      bounds = r;
    } else {
      browser.mobileRect = null;
    }
    view.setBounds(bounds);
    view.setVisible(browser.open && browser.visible);
    /* pencere boyutu değişince (maximize/restore) dock genişliği clamp'lenir —
       renderer'a YENİ genişlik bildirilmezse DOM'un ayırdığı --bw alanı bayat
       kalır ve Beast Code chat native view'ın ALTINA girer (iç içe geçme bug'ı) */
    if (browser._lastEmittedW !== shownWidth) {
      browser._lastEmittedW = shownWidth;
      browserEmit({ open: true, width: shownWidth });
    }
    /* siluet çerçevesinin hizası için renderer'a ekran dikdörtgeni bildirilir */
    browserEmit({ mobile: browser.mobile, phoneRect: browser.mobileRect });
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
  /* JS DİYALOGLARI (alert/confirm/prompt/beforeunload): CDP ile OTOMATİK
     onaylanır/kapatılır — aksi halde renderer kilitlenir ve TÜM tarayıcı
     araçları askıda kalır (executeJavaScript diyalog kapanana dek dönmez). */
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    wc.debugger.sendCommand('Page.enable').catch(() => {});
    wc.debugger.on('message', (_ev, method, params) => {
      if (method === 'Page.javascriptDialogOpening') {
        browser.lastDialog = {
          type: String((params && params.type) || 'alert'),
          message: String((params && params.message) || ''),
          at: Date.now(),
        };
        try { wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); } catch {}
        blog('dialog', browser.lastDialog.type + ': ' + browser.lastDialog.message.slice(0, 80));
      }
    });
  } catch (e) {
    waLog('tarayıcı diyalog köprüsü kurulamadı: ' + String((e && e.message) || e).slice(0, 120));
  }
  // Tarayıcı kapalıyken olayların UI'ı geri açmamasını garantile
  const notify = (extra) => {
    if (browser.open && win && !win.isDestroyed()) {
      browserEmit({ open: true, width: browserShownWidth(browserW()), ...extra });
    }
  };
  wc.on('did-navigate', (_e, url) => {
    /* mobil önizleme: her sayfada scrollbar gizleme CSS'i yeniden enjekte edilir */
    injectPhoneScrollCss();
    notify({ url, loading: false });
  });
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

/* TARAYICI YENİDEN BAŞLATMA: takılan/kilitlenen sayfa için view + webContents
   tamamen kapatılır, aynı URL YENİ bir view'da açılır. persist:browser
   partition'ı silinmez → oturum/çerezler (Google, X vb.) korunur. */
function restartBrowser() {
  if (!win || win.isDestroyed()) return { ok: false, error: 'pencere yok' };
  const wasOpen = browser.open;
  let url = '';
  try {
    if (browser.view && browser.view.webContents && !browser.view.webContents.isDestroyed()) {
      url = browser.view.webContents.getURL();
    }
  } catch {}
  detachBrowser();
  try {
    const oldWc = browser.view && browser.view.webContents;
    if (oldWc && !oldWc.isDestroyed()) {
      try { oldWc.close(); } catch { try { oldWc.destroy(); } catch {} }
      /* takılı renderer süreci close()'u geciktirebilir — güvence: kısa süre
         sonra hâlâ duruyorsa zorla yok et (yeni view'ı asla kilitlemez) */
      setTimeout(() => { try { if (!oldWc.isDestroyed()) oldWc.destroy(); } catch {} }, 1500);
    }
  } catch {}
  browser.view = null;
  browser.started = false;
  browser.lastDialog = null;
  if (wasOpen) {
    ensureBrowser();
    browser.started = true;
    browser.view.webContents.loadURL(url || BROWSER_START_URL).catch(() => {});
    layoutBrowser();
    const [w] = win.getContentSize();
    browserEmit({ open: true, width: browserShownWidth(w), url: url || BROWSER_START_URL, restarted: true });
  }
  blog('restart', 'tarayıcı yeniden başlatıldı' + (url ? ' — ' + url.slice(0, 90) : ''));
  return { ok: true, url };
}

function setBrowserOpen(v, forceVisible) {
  if (!win || win.isDestroyed()) return;
  const want = !!v;

  // KAPATMA: bayrak desync olsa bile view'i zorla sök
  if (!want) {
    const wasOpen = browser.open;
    browser.open = false;
    browser.visible = false;
    browser.mobileRect = null; /* telefon silueti de kaybolur — bayat rect taşınmaz */
    /* mobil önizleme modu da KAPANIR — siluet + cihaz seçici + emülasyon temizlenir */
    if (browser.mobile) {
      browser.mobile = false;
      settings.browserMobile = false;
      saveSettings();
      clearPhoneTouchEmulation();
    }
    detachBrowser();
    browserEmit({ open: false });
    return;
  }

  // AÇMA — görünürlük: forceVisible true/false ise onu uygula;
  // belirtilmemişse kullanıcı tercihi belirler. Tarayıcı gizleme ÖZELLİĞİ
  // (settings.browserHide) kapalıysa tercih ne olursa olsun tarayıcı GÖRÜNÜR açılır.
  // AJAN gezinmeleri setBrowserOpenForAgent üzerinden gelir: gizleme özelliği
  // kapalıysa görünür, özellik + göz kapalıyken gizli çalışır (kullanıcı ekranı
  // rahatsız edilmez; tarayıcı düğmesi gizli paneli görünür kılar).
  browser.open = true;
  browser.visible =
    forceVisible === true ? true : forceVisible === false ? false : !browserHeadlessPref();
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
   GİZLEME ÖZELLİĞİ (Ayarlar → Web Arama) KAPALIYSA ajan tarayıcıyı GİZLİ açamaz —
   dahili panel GÖRÜNÜR açılır, kullanıcı aramayı canlı izler. Özellik açıksa göz
   durumuna bakılır: göz açık (headless tercihi kapalı) → görünür, göz kapalı →
   gizli. Mobil önizleme varsa siluet canlı kalsın diye her koşulda görünür.
   Zaten açıksa (kullanıcı paneli açık tutuyorsa) görünürlüğe dokunulmaz. */
function setBrowserOpenForAgent() {
  if (!browser.open) {
    setBrowserOpen(true, !browserHideEnabled() || !browserHeadlessPref() || browser.mobile);
  }
}

async function browserNavigate(raw, signal, ctx) {
  return browserGate(async () => {
    await browserTrafficWait();
    return browserNavigateNow(raw, signal, ctx);
  });
}

/* JS diyalogları (alert/confirm/prompt) CDP ile OTOMATİK yönetilir;
   bu yardımcı çağrı SIRASINDA oluşan diyaloğu yanıta ekler. */
function browserDialogNote(sinceAt) {
  const d = browser.lastDialog;
  if (!d || !d.at || d.at <= (sinceAt || 0)) return {};
  const verb = d.type === 'alert' || d.type === 'prompt' ? 'kapatıldı' : 'onaylandı';
  return {
    dialog: { type: d.type, message: d.message },
    dialogNote: 'JS diyaloğu otomatik ' + verb + ': "' + String(d.message || '').slice(0, 120) + '"',
  };
}

/* SPA/DOM oturması: readyState complete + içerik uzunluğu İKİ turdur sabitse
   dön (en çok maxMs). Böylece hidrasyon bitmeden snapshot/okuma yapılmaz.
   stepMs: hızlı yol 70 ms tarar (eski 300 ms sabiti tur başına ~600 ms
   ekliyordu); yavaş yol 300 ms'de kalır. */
async function browserSettle(wc, signal, maxMs = 4000, stepMs = 300) {
  const t0 = Date.now();
  let lastLen = -1;
  let stable = 0;
  while (Date.now() - t0 < maxMs) {
    if (signal && signal.aborted) return;
    let info = null;
    try {
      info = await wc.executeJavaScript(
        '({rs: document.readyState, len: (document.body ? ((document.body.innerText || "").trim().length) : 0)})',
        true
      );
    } catch {
      return;
    }
    if (!info) return;
    const rs = String(info.rs || '');
    const len = Number(info.len) || 0;
    if (rs === 'complete') {
      if (len > 0 && len === lastLen) stable++;
      else stable = 0;
      if (stable >= 2) return;
      /* boş/az metinli sayfa (canvas/SPA shell): yine de kısa bir hidrasyon penceresi bırak */
      if (len === 0 && Date.now() - t0 > 1500) return;
    }
    lastLen = len;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/* did-navigate sonrası yükleme bitişini bekle: sayfa hazırsa SIFIR bekleme;
   olay kaçarsa 90 ms poll isLoading false olunca çıkar (maxMs tavan). */
async function browserLoadWait(wc, signal, maxMs = 4000) {
  try {
    if (typeof wc.isLoading === 'function' && !wc.isLoading()) return;
  } catch {
    return;
  }
  await new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      clearInterval(p);
      try { wc.removeListener('did-stop-loading', fin); } catch {}
      resolve();
    };
    const t = setTimeout(fin, maxMs);
    const p = setInterval(() => { try { if (!wc.isLoading()) fin(); } catch { fin(); } }, 90);
    wc.on('did-stop-loading', fin);
  });
}

/* snapshot al (hatayı yut) — navigate/act yanıtlarına gömmek için */
async function browserSnapshotNow(wc) {
  try {
    const raw = await wc.executeJavaScript(BROWSER_SNAPSHOT_JS, true);
    const obj = JSON.parse(raw);
    return obj && typeof obj.count === 'number' ? obj : null;
  } catch {
    return null;
  }
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
  const dlgAt = browser.lastDialog ? browser.lastDialog.at : 0;
  let failInfo = null;
  let timedOut = false;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => { timedOut = true; finish(); }, 25000);
    /* did-fail-load: ANA kare hatasını YAKALA ve rapora koy. kod -3 (ABORTED)
       yönlendirme/SPA geçişlerinde normaldir; alt kare hataları sayılmaz. */
    const onFail = (_e, code, desc, validatedURL, isMainFrame) => {
      if (isMainFrame === false) return;
      if (code === -3) return;
      failInfo = { code, desc: String(desc || ''), url: String(validatedURL || url) };
      finish();
    };
    function cleanup() {
      clearTimeout(timer);
      wc.removeListener('did-finish-load', finish);
      wc.removeListener('did-fail-load', onFail);
    }
    wc.once('did-finish-load', finish);
    wc.on('did-fail-load', onFail);
    wc.loadURL(url).catch((e) => {
      failInfo = { code: null, desc: String((e && e.message) || e) };
      finish();
    });
  });
  let title = '';
  let finalUrl = url;
  try { title = wc.getTitle(); finalUrl = wc.getURL() || url; } catch {}
  browserEmit({ open: true, width: browserShownWidth(browserW()), url: finalUrl });
  flushBrowserStorage(); // oturum çerezleri diske — ani kapanışta kaybolmasın
  /* YÜKLEME HATASI: artık "açıldı" denmez — kod/açıklama + çözüm ipucu döner */
  if (failInfo) {
    const codeTxt = failInfo.code != null ? ' kod ' + failInfo.code : '';
    const hint = /ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/i.test(failInfo.desc)
      ? ' (DNS/ağ: internet bağlantısını ve adresi kontrol et)'
      : /ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_EMPTY_RESPONSE/i.test(failInfo.desc)
        ? ' (sunucu yanıt vermiyor — adres/port doğru mu?)'
        : '';
    return {
      ok: false,
      error: 'sayfa yüklenemedi' + codeTxt + ': ' + failInfo.desc + hint,
      url: failInfo.url || finalUrl,
      ...browserDialogNote(dlgAt),
    };
  }
  /* SPA hidrasyonu: içerik oturmadan snapshot alınmaz (timeout'ta bekleme yok) */
  await browserSettle(wc, signal, timedOut ? 0 : 4000);
  const snap = await browserSnapshotNow(wc);
  let stillLoading = false;
  try { stillLoading = wc.isLoading(); } catch {}
  return {
    ok: true,
    ...(timedOut
      ? { warning: 'yükleme 25 sn içinde tamamlanmadı — sayfa kısmen yüklü olabilir; browser_wait/browser_read ile kontrol et', loading: stillLoading }
      : {}),
    url: finalUrl,
    title,
    ...browserDialogNote(dlgAt),
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

/* Ajanın DERİN ARAŞTIRMADA okuduğu sayfalar gizli havuzda açılır (hız için);
   panel GÖRÜNÜR açıksa sayfa canlı izlensin diye aynı adres görünür view'e de
   yansıtılır. 500ms debounce + son adres kazanır: paralel okumalar paneli
   boğmaz, gizli modda (visible=false) hiçbir ek yük bindirmez. */
let __mirrorTimer = null;
let __mirrorUrl = '';
function browserMirror(url) {
  try {
    if (!browser.open || !browser.visible) return;
    if (!browser.view || browser.view.webContents.isDestroyed()) return;
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return;
    __mirrorUrl = u;
    if (__mirrorTimer) return;
    __mirrorTimer = setTimeout(() => {
      __mirrorTimer = null;
      const target = __mirrorUrl;
      if (!target || !browser.open || !browser.visible || !browser.view) return;
      const wc = browser.view.webContents;
      if (!wc || wc.isDestroyed()) return;
      let cur = '';
      try { cur = wc.getURL() || ''; } catch {}
      if (cur === target) return;
      try { wc.loadURL(target).catch(() => {}); } catch {}
    }, 500);
  } catch {}
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
      browserMirror(url); /* panel görünürse ajanın okuduğu sayfa canlı izlenir */
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
async function ocrRead({ image, lang = 'tur+eng', boxes = false } = {}) {
  try {
    if (!image) return { ok: false, error: 'görüntü yok' };
    const t = require('tesseract.js');
    const langKey = String(lang || 'tur+eng');
    let worker = _ocrWorkers.get(langKey);
    if (!worker) {
      const tessDir = path.join(APP_DIR, 'tessdata');
      fs.mkdirSync(tessDir, { recursive: true });
      const bus = require('./agent/progressbus');
      worker = await t.createWorker(langKey, 1, {
        cachePath: tessDir,
        logger: (m) => {
          try {
            /* dil verisi (.traineddata) inerken yüzde üret — OCR çalışma anını kirletme */
            if (m && /traineddata/i.test(String(m.status || '')) && typeof m.progress === 'number' && isFinite(m.progress)) {
              bus.emitInstallProgress('ocr', { pct: m.progress * 100 });
            }
          } catch {}
        },
      });
      _ocrWorkers.set(langKey, worker);
    }
    let input = image;
    if (typeof input === 'string' && input.startsWith('data:')) {
      input = Buffer.from(input.split(',')[1] || '', 'base64');
    }
    const { data } = boxes ? await worker.recognize(input, {}, { blocks: true, text: true }) : await worker.recognize(input);
    const text = String((data && data.text) || '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (boxes) {
      /* T3SFast bilgisayar döngüsü için satır kutuları: OCR koordinatları
         1280px görüntü uzayındadır; computer_act bu uzayı bekler. */
      const lines = [];
      for (const block of (data && data.blocks) || []) {
        for (const para of block.paragraphs || []) {
          for (const ln of para.lines || []) {
            const bb = (ln && ln.bbox) || {};
            const label = String((ln && ln.text) || '').replace(/\s+/g, ' ').trim();
            if (!label || bb.x1 == null) continue;
            const conf = Number(ln.confidence);
            if (Number.isFinite(conf) && conf < 45) continue;
            lines.push({
              text: label.slice(0, 120),
              x: Math.round((bb.x0 + bb.x1) / 2),
              y: Math.round((bb.y0 + bb.y1) / 2),
              x0: bb.x0,
              y0: bb.y0,
              x1: bb.x1,
              y1: bb.y1,
              confidence: Math.round(Number.isFinite(conf) ? conf : 0),
            });
          }
        }
      }
      return { ok: !!text, chars: text.length, text: text.slice(0, 8000), lines: lines.slice(0, 120), lang: langKey };
    }
    return { ok: !!text, chars: text.length, text: text.slice(0, 8000), lang: langKey };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* T3SFast bilgisayar gözlemi: ekranı yakala (1280px, lastScreenCapture
   güncellenir) → OCR satırları + metin. Dönen kutu merkezleri computer_act'in
   beklediği görüntü koordinatlarıdır.
   OCR ÖNBELLEĞİ: ekran karesi öncekiyle aynıysa (ince parmak izi) tesseract
   hiç çalıştırılmaz — Jev döngüsünün en pahalı adımı atlanır. */
const OCR_OBSERVE_CACHE_MS = 15000;
let lastScreenObserve = { key: '', at: 0, result: null };

function screenObserveKey(cells) {
  return Array.isArray(cells) ? cells.map((n) => Math.round(n)).join(',') : '';
}

async function screenObserve() {
  const frame = await captureScreenFrame();
  if (!frame) return { ok: false, error: 'ekran görüntüsü alınamadı' };
  const cap = lastScreenCapture || {};
  const key = screenObserveKey(imageSignature(frame.img));
  const now = Date.now();
  if (key && lastScreenObserve.key === key && lastScreenObserve.result && now - lastScreenObserve.at < OCR_OBSERVE_CACHE_MS) {
    return { ...lastScreenObserve.result, cached: true, sig: key };
  }
  const ocr = await ocrRead({ image: frame.data, boxes: true });
  if (!ocr.ok) return { ok: false, error: ocr.error || 'OCR başarısız' };
  const result = {
    ok: true,
    w: cap.imgW || 1280,
    h: cap.imgH || 720,
    text: ocr.text,
    lines: ocr.lines || [],
    sig: key,
  };
  lastScreenObserve = { key, at: now, result };
  return { ...result };
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
    /* İZLEME: fetch() sayfayı değiştirmediği için panel google.com ana sayfasında
       kalıyordu — görünür moddayken gerçek sonuç sayfasına geç ki kullanıcı ajanın
       ne aradığını canlı görsün (gizli modda ek yük yok; zaten sonuç sayfasındaysa
       fallback reload'u yapılmaz). */
    if (browser.visible) {
      let cur = '';
      try { cur = wc.getURL() || ''; } catch {}
      if (!cur.startsWith('https://www.google.com/search')) {
        try {
          wc.loadURL('https://www.google.com/search?q=' + encodeURIComponent(q) + '&num=10&hl=tr&pws=0&aep=1').catch(() => {});
        } catch {}
      }
    }
    flushBrowserStorage();
    const out = { ok: true, engine: 'browser-google', query: q, results };
    if (parsed.ai) out.ai = parsed.ai;
    return out;
  } catch {
    return null;
  }
}

/* Ekran görüntüsü üzerine ref numaralarını ÇİZ: vision modeli kutuları ve
   numaraları görür, koordinatı tahmin etmek yerine okur. Ref'ler snapshot ile
   AYNI numaralandırmayı kullanır (snapshot hemen önce alınır). */
async function annotateBrowserShot(img, snap) {
  const lib = canvasLib();
  if (!lib || !snap || !snap.boxes) return null;
  const im = await lib.loadImage(img.toPNG());
  const canvas = lib.createCanvas(im.width, im.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(im, 0, 0);
  const vw = Number(snap.vw) || im.width;
  const k = im.width / Math.max(1, vw);
  let drawn = 0;
  for (const [ref, b] of Object.entries(snap.boxes)) {
    const x = Number(b[0]) * k;
    const y = Number(b[1]) * k;
    const w = Number(b[2]) * k;
    const h = Number(b[3]) * k;
    if (!(w >= 6 && h >= 6)) continue;
    if (y > im.height || x > im.width || y + h < 0 || x + w < 0) continue;
    ctx.strokeStyle = 'rgba(0,190,255,0.95)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(2, w), Math.max(2, h));
    const label = String(ref);
    ctx.font = 'bold 13px Segoe UI, sans-serif';
    const tw = Math.ceil(ctx.measureText(label).width);
    const by = y - 16 < 0 ? y + 1 : y - 16;
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(x, by, tw + 8, 16);
    ctx.fillStyle = '#00d8ff';
    ctx.fillText(label, x + 4, by + 12.5);
    if (++drawn >= 90) break;
  }
  return canvas.toBuffer('image/jpeg', 78);
}

async function browserScreenshot(signal, opts) {
  if (!browser.view || !browser.open) return { ok: false, error: 'tarayıcı açık değil' };
  const wc = browser.view.webContents;
  const annotate = !(opts && opts.annotate === false);
  const dlgAt = browser.lastDialog ? browser.lastDialog.at : 0;
  try {
    /* ref numaraları görselle eşleşsin: önce taze snapshot */
    let snap = null;
    if (annotate) snap = await browserSnapshotNow(wc);
    const img = await wc.capturePage();
    let out = img;
    const sz = img.getSize();
    const maxW = 1000; // vision bütçesi için küçült
    if (sz.width > maxW) out = img.resize({ width: maxW });
    let jpeg = null;
    if (annotate) {
      try { jpeg = await annotateBrowserShot(out, snap); } catch {}
    }
    if (!jpeg || !jpeg.length) jpeg = out.toJPEG(72);
    if (!jpeg || !jpeg.length) return { ok: false, error: 'görüntü alınamadı' };
    return {
      ok: true,
      note: snap
        ? 'ekran görüntüsü bir sonraki adımda gösterilecek — üzerindeki numaralar snapshot ref\'leriyle AYNIDIR; tıklamak için o ref\'i kullan'
        : 'ekran görüntüsü bir sonraki adımda sana gösterilecek',
      __injectImage: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
      ...(snap ? { snapshot: snap.snapshot, refCount: snap.count } : {}),
      ...browserDialogNote(dlgAt),
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
  function __norm(s){
    return String(s==null?'':s).toLowerCase()
      .replace(/[ıİ]/g,'i').replace(/[şŞ]/g,'s').replace(/[ğĞ]/g,'g')
      .replace(/[üÜ]/g,'u').replace(/[öÖ]/g,'o').replace(/[çÇ]/g,'c')
      .replace(/\\s+/g,' ').trim();
  }
  /* Çerez onayı + promosyon/modal katmanlarını OTOMATİK kapatır — Jev bu
     katmanlar için adım harcamaz. Yalnız kapsamı belli kutulara dokunur:
     çerez/CMP konteynerleri ile promosyon/bülten/uygulama modal katmanları.
     Form içeren kritik diyaloglara (giriş/arama) dokunulmaz; aynı eleman
     ikinci kez tıklanmaz (WeakSet). Dönüş: kapatılanların listesi. */
  function __autoDismiss(){
    const out=[];
    const clicked=window.__beDismissed||(window.__beDismissed=new WeakSet());
    const clickEl=(e,what)=>{
      try{
        if(clicked.has(e)) return false;
        clicked.add(e);
        try{ e.scrollIntoView({block:'center'}); }catch(_){}
        if(typeof e.click==='function') e.click();
        out.push({what:what,label:String(__label(e)||'').slice(0,40)});
        return true;
      }catch(_){ return false; }
    };
    const VENDOR='#onetrust-accept-btn-handler,#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll,#didomi-notice-agree-button,#truste-consent-button,[data-testid="cookie-policy-manage-dialog-accept-button"]';
    const COOKIE='[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="gdpr" i],[class*="gdpr" i],[class*="onetrust" i],[class*="cookiebot" i],[class*="didomi" i],[class*="usercentrics" i],[class*="quantcast" i],[class*="truste" i],[class*="osano" i],[class*="iubenda" i],[class*="klaro" i],[class*="axeptio" i],[class*="complianz" i]';
    const PROMO='[role="dialog"],[aria-modal="true"],[class*="modal" i],[id*="modal" i],[class*="popup" i],[id*="popup" i],[class*="lightbox" i],[class*="newsletter" i],[class*="subscribe" i],[class*="promo" i],[class*="campaign" i],[class*="interstitial" i],[class*="smartbanner" i],[class*="app-banner" i],[id*="app-banner" i],[class*="app-download" i],[class*="overlay" i],[id*="overlay" i]';
    const PROMO_TEXT=['bulten','newsletter','abone','subscribe','indirim','kampanya','firsat','kupon','coupon','discount','promo','sale','special offer','mobil uygulama','uygulamamiz','app download','bildirim','notification','hediye','cekilis','anket','survey','feedback','puan kazan'];
    const ACCEPT=['accept all','allow all','accept cookies','accept all cookies','agree to all','agree and continue','consent to all','i accept','tumunu kabul','tum cerezleri kabul','tum cerezleri onayla','cerezleri kabul','kabul ediyorum','tumunu onayla','alle akzeptieren','alle cookies akzeptieren','zustimmen','tout accepter',"j'accepte",'accepter et continuer','aceptar todo','aceptar y continuar','aceitar todos','accetta tutti','accetta e continua','kabul et','onayla','accept','agree','allow','anladim','tamam','ok','okay'];
    const CLOSE=['close','kapat','dismiss','daha sonra','simdi degil','simdi olmaz','not now','maybe later','no thanks','hayir tesekkurler','skip','atla','gec','sonra','later','x','×','✕','✖','╳'];
    const btnSel='button,[role="button"],a,input[type="submit"],input[type="button"],[aria-label]';
    const accepts=(lbl)=>{
      for(const p of ACCEPT){
        if(lbl===p) return true;
        if(p.length>=6 && lbl.indexOf(p)>=0 && lbl.length<=p.length+24) return true;
      }
      return false;
    };
    const closes=(lbl)=>{
      for(const p of CLOSE){
        if(lbl===p) return true;
        if(p.length>=5 && lbl.indexOf(p)>=0 && lbl.length<=p.length+16) return true;
      }
      return false;
    };
    const controlIn=(s)=>{
      for(const c of [...s.querySelectorAll(btnSel)]){
        if(!__vis(c)) continue;
        const lbl=__norm(__label(c));
        if(accepts(lbl)||closes(lbl)) return c;
      }
      try{
        const byAttr=s.querySelector('[class*="close" i],[id*="close" i],[class*="dismiss" i],[id*="dismiss" i],[aria-label*="close" i],[aria-label*="kapat" i],[title*="close" i],[title*="kapat" i]');
        if(byAttr&&__vis(byAttr)) return byAttr;
      }catch(_){}
      return null;
    };
    /* 1) bilinen CMP düğmeleri */
    try{
      for(const sel of VENDOR.split(',')){
        const el=document.querySelector(sel);
        if(el&&__vis(el)){ clickEl(el,'cerez'); return out; }
      }
    }catch(_){}
    /* 2) çerez onay katmanları */
    for(const s of document.querySelectorAll(COOKIE)){
      if(!__vis(s)) continue;
      const c=controlIn(s);
      if(c&&clickEl(c,'cerez')) return out;
    }
    /* 3) promosyon/modal katmanları — form içeren kritik diyaloglara dokunma */
    let promoSeen=false;
    for(const s of document.querySelectorAll(PROMO)){
      if(!__vis(s)) continue;
      const r=s.getBoundingClientRect();
      if(r.width<150||r.height<80) continue;
      const txt=__norm(s.innerText||'').slice(0,600);
      const promo=txt&&PROMO_TEXT.some((k)=>txt.indexOf(k)>=0);
      if(!promo&&s.querySelector('input:not([type="hidden"]),textarea,select')) continue;
      promoSeen=true;
      const c=controlIn(s);
      if(c&&clickEl(c,'popup')) return out;
    }
    /* 4) kapatma yok ama promosyon katmanı var → tek Escape denemesi */
    if(promoSeen&&!out.length){
      try{
        const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.body;
        ['keydown','keyup'].forEach((type)=>t.dispatchEvent(new KeyboardEvent(type,{key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true})));
        out.push({what:'escape',label:'Escape'});
      }catch(_){}
    }
    return out;
  }
`;

const BROWSER_SNAPSHOT_JS = `(function(){
  ${BROWSER_JS_HELPERS}
  const autoDismissed=__autoDismiss();
  const sel='a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="tab"],[role="option"],[role="menuitem"],[role="gridcell"],[role="checkbox"],[role="switch"],[role="combobox"],[role="textbox"],[role="searchbox"],[contenteditable="true"],summary';
  /* açık popup/takvim/dialog varsa içindekiler ÖNCE listelenir (tarih seçici, özel dropdown vb.) */
  const popSel='[role="dialog"],dialog,[role="listbox"],[role="menu"],.flatpickr-calendar,.ui-datepicker,[class*="datepicker" i],[class*="calendar" i],[class*="dropdown" i],[class*="popup" i]';
  const pops=[...document.querySelectorAll(popSel)].filter(__vis);
  const inPop=new Set();
  for(const p of pops){[...p.querySelectorAll(sel)].forEach(e=>inPop.add(e));}
  window.__beMap={};
  const seen=new Set();
  const lines=[];
  const boxes={};
  let i=0;
  function add(e){
    if(!e||seen.has(e)) return;
    seen.add(e);
    if(!__vis(e)||e.disabled||e.getAttribute('aria-disabled')==='true') return;
    i++;
    window.__beMap[i]=e;
    const rb=e.getBoundingClientRect();
    boxes[i]=[Math.round(rb.left),Math.round(rb.top),Math.round(rb.width),Math.round(rb.height)];
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
  return JSON.stringify({count:i,title:document.title,url:location.href,snapshot:lines.join('\\n'),boxes:boxes,vw:window.innerWidth,vh:window.innerHeight,auto_dismissed:autoDismissed.length?autoDismissed:undefined});
})()`;

/* JEV ULTRAFAST GÖZLEMİ: yapılı element tablosu (kind: click/fill/select),
   rol/ad/değer/seçenek bilgileriyle. Refler window.__beMap'e yazılır — mevcut
   browser_click/browser_type/browser_select ref çözümüyle BİREBİR uyumludur.
   Yalnız görünür + viewport içi + enabled elemanlar; scroll/wait sentetik. */
const BROWSER_OBSERVE_JS = `(function(){
  ${BROWSER_JS_HELPERS}
  if(!document.body) return JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,text:'',scroll:{y:0,height:0},actions:[]});
  const autoDismissed=__autoDismiss();
  window.__beIds=window.__beIds||new WeakMap();
  window.__beNext=window.__beNext||0;
  window.__beMap={};
  const ids=window.__beIds;
  const identity=(e)=>{ if(!ids.has(e)) ids.set(e,++window.__beNext); const id=ids.get(e); window.__beMap[id]=e; return id; };
  const safe=(e)=>!['password','file','hidden'].includes(String(e.type||'').toLowerCase());
  const visible=(e)=>{ try{ return !e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}); }catch(err){ return false; } };
  const name=(e,seen=new Set())=>{
    if(!e||seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\\s+/).map((id)=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map((l)=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(String(e.type||'').toLowerCase()) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName==='INPUT' ? '' : [...e.childNodes].map((n)=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map((role)=>'[role="'+role+'"]').join(',');
  const role=(e)=>{
    const explicit=e.getAttribute('role');
    if(roles.includes(explicit)) return explicit;
    if(e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if(e.tagName==='A') return 'link';
    if(e.tagName==='SELECT') return 'combobox';
    if(e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if(e.tagName==='INPUT'){
      const t=String(e.type||'').toLowerCase();
      if(t==='checkbox'||t==='radio') return t;
      if(['button','submit','reset','image'].includes(t)) return 'button';
      if(t==='search') return 'searchbox';
      if(t==='number') return 'spinbutton';
      if(['text','email','url','tel','date','time','month','week','datetime-local'].includes(t)) return 'textbox';
    }
    return null;
  };
  const actions=[];
  const added=new WeakSet();
  for(const e of document.querySelectorAll(selector)){
    if(actions.length>=300) break;
    if(!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if(!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if(rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    added.add(e);
    const base={ref:identity(e),role:rname,label:name(e)||rname};
    const et=String(e.type||'').toLowerCase();
    if(et) base.input_type=et;
    for(const key of ['checked','selected','expanded']){
      const value=e.getAttribute('aria-'+key);
      if(value!==null) base[key]=value;
    }
    if(et==='checkbox'||et==='radio') base.checked=String(e.checked);
    if(e.tagName==='SELECT'){
      const current=[...e.selectedOptions].map((o)=>o.label).join(', ');
      for(const o of e.options){
        if(o.selected||o.disabled||o.closest('optgroup[disabled]')) continue;
        actions.push({...base,kind:'select',value:o.value,current_value:current,label:base.label+' → '+o.label});
      }
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? String(e.innerText||'').trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if(editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  /* İLAVE TIKLANABİLİRLER: <a>/<button> dışı gerçek hedef olan kategori/menü
     kutuları (li, custom div/span butonlar). Kısıtlı aday seti + cursor:pointer
     (ya da onclick) + metin + makul kutu şartı. İçinde gerçek link/buton olan
     kapsayıcılar atlanır (onlar zaten ana listede). */
  const extraSel='li,[onclick],[class*="categor" i],[class*="kategor" i],[class*="menu" i],[class*="nav" i],[class*="tab" i],[role="treeitem"],[role="menuitem"]';
  let extra=0;
  for(const e of document.querySelectorAll(extraSel)){
    if(extra>=80 || actions.length>=300) break;
    if(added.has(e) || e.closest('a[href],button,[role="button"]')) continue;
    if(e.querySelector('a[href],button,[role="button"]')) continue;
    if(!visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    let pointer=false;
    try{ pointer=getComputedStyle(e).cursor==='pointer'||e.hasAttribute('onclick'); }catch(err){}
    if(!pointer) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
    if(r.width<16||r.height<12||r.width>innerWidth*0.85||r.height>innerHeight*0.4) continue;
    if(x<0||y<0||x>=innerWidth||y>=innerHeight) continue;
    const label=String(name(e)||'').replace(/\\s+/g,' ').trim();
    if(!label||label.length>80) continue;
    added.add(e);
    actions.push({ref:identity(e),role:'button',label:label,kind:'click',value:''});
    extra++;
  }
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node, length=0;
  while((node=walker.nextNode()) && length<6000){
    const value=String(node.textContent||'').trim(), parent=node.parentElement;
    if(!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const tr=range.getBoundingClientRect();
    if(tr.width>0 && tr.height>0 && tr.bottom>0 && tr.top<innerHeight && tr.right>0 && tr.left<innerWidth){
      words.push(value); length+=value.length;
    }
  }
  const text=words.join('\\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const omitted=Math.max(0,actions.length-250);
  actions.splice(250);
  if(scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if(scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  return JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,text:text,
    scroll:{y:Math.round(scrollY),height:height},actions:actions,omitted_actions:omitted,
    auto_dismissed:autoDismissed.length?autoDismissed:undefined,
    rev:location.href+'|'+document.title+'|'+actions.length+'|'+text.length+'|'+Math.round(scrollY)+'|'+height});
})()`;

function browserActionJs(kind, args) {
  const sel = JSON.stringify(String(args.selector || ''));
  const ref = JSON.stringify(args.ref === undefined ? null : Number(args.ref));
  const expect = JSON.stringify(args.expect || null);

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
      const ex=${expect};
      if(ex&&ex.url&&location.href!==ex.url) return res(JSON.stringify({clicked:false,stale:true,reason:'sayfa degisti — karar bayat'}));
      const t=__target();
      if(!t) return res(JSON.stringify({clicked:false,reason:'eleman bulunamadi (ref eski olabilir - browser_snapshot al)'}));
      const how=t.how,el=t.el;
      el.scrollIntoView({block:'center'});
      setTimeout(()=>{try{
        const r=el.getBoundingClientRect(), cx=r.x+r.width/2, cy=r.y+r.height/2;
        const top=document.elementFromPoint(cx,cy);
        if(top&&top!==el&&!el.contains(top)&&!top.contains(el)&&!(top.labels&&[...top.labels].includes(el))){
          let cover='';try{cover=__label(top);}catch(e){}
          return res(JSON.stringify({clicked:false,covered:true,reason:'hedef katman altinda: <'+top.tagName.toLowerCase()+'> "'+cover+'"'}));
        }
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
      const ex=${expect};
      if(ex&&ex.url&&location.href!==ex.url) return res(JSON.stringify({typed:false,stale:true,reason:'sayfa degisti — karar bayat'}));
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
      const ex=${expect};
      if(ex&&ex.url&&location.href!==ex.url) return res(JSON.stringify({selected:false,stale:true,reason:'sayfa degisti — karar bayat'}));
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
  if (kind === 'hover') {
    return `(function(){${BROWSER_JS_HELPERS}${resolveTarget}
      try{
        const t=__target();
        if(!t) return JSON.stringify({hovered:false,reason:'eleman bulunamadi (ref eski olabilir)'});
        const el=t.el;
        el.scrollIntoView({block:'center'});
        const r=el.getBoundingClientRect(), x=Math.round(r.x+r.width/2), y=Math.round(r.y+r.height/2);
        const opt={bubbles:true,cancelable:true,clientX:x,clientY:y};
        ['pointerover','pointerenter','mouseover','mouseenter','mousemove'].forEach(function(type){
          try{ el.dispatchEvent(new MouseEvent(type,opt)); }catch(e){}
        });
        return JSON.stringify({hovered:true,target:t.how});
      }catch(e){return JSON.stringify({hovered:false,reason:String(e)});}
    })()`;
  }
  return `JSON.stringify({ok:false,error:'bilinmeyen eylem'})`;
}

/* GÜVENİLİR GİRDİ (trusted) için hedef koordinatı: renderer'a gönderilen
   gerçek fare/tuş olayları React/canvas/otocomplete widget'larında programatik
   click'ten güvenilirdir. Aynı zamanda katman (occlusion) kontrolü yapar. */
function browserPointJs(args) {
  const sel = JSON.stringify(String(args.selector || ''));
  const ref = JSON.stringify(args.ref === undefined ? null : Number(args.ref));
  return `(function(){${BROWSER_JS_HELPERS}
    try{
      let el=null,how='';
      if(${ref}!==null){el=__resolveRef(${ref});how='ref['+${ref}+']';}
      else{el=__resolve(${sel});how='selector';}
      if(!el) return JSON.stringify({ok:false,reason:'eleman bulunamadi (ref eski olabilir)'});
      el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
      if(r.width<=0||r.height<=0||x<0||y<0||x>=innerWidth||y>=innerHeight) return JSON.stringify({ok:false,reason:'ekran disi'});
      const top=document.elementFromPoint(x,y);
      if(top&&top!==el&&!el.contains(top)&&!top.contains(el)&&!(top.labels&&[...top.labels].includes(el))){
        let cover='';try{cover=__label(top);}catch(e){}
        return JSON.stringify({ok:false,covered:true,reason:'hedef katman altinda: <'+top.tagName.toLowerCase()+'> "'+cover+'"'});
      }
      const editable=!!(el.isContentEditable||el.tagName==='INPUT'||el.tagName==='TEXTAREA');
      return JSON.stringify({ok:true,how:how,x:Math.round(x),y:Math.round(y),editable:editable,
        input_type:String((el.getAttribute&&el.getAttribute('type'))||'').toLowerCase()});
    }catch(e){return JSON.stringify({ok:false,reason:String(e)});}
  })()`;
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

/* Jev döngüsü için yapılı gözlem: elementler (kind/rol/değer/seçenek) + sayfa
   metni + scroll bilgisi. window.__beMap tazelenir → dönen ref'ler mevcut
   browser_click/browser_type/browser_select tarafından aynen kullanılabilir. */
async function browserObserve(signal) {
  if (!browser.view || !browser.open) return { ok: false, error: 'tarayıcı açık değil' };
  const wc = browser.view.webContents;
  const dlgAt = browser.lastDialog ? browser.lastDialog.at : 0;
  try {
    /* yarım DOM'la Jev kararı verilmesin: sayfa hâlâ yükleniyorsa kısa bekle
       (sayfa hazırsa SIFIR gecikme — isLoading false anında döner) */
    try { if (wc.isLoading && wc.isLoading()) await browserLoadWait(wc, signal, 1200); } catch {}
    const raw = await wc.executeJavaScript(BROWSER_OBSERVE_JS, true);
    const obj = JSON.parse(raw);
    return { ok: true, ...obj, ...browserDialogNote(dlgAt) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function browserAct(kind, args, signal) {
  if (!browser.view || !browser.open) return { ok: false, error: 'tarayıcı açık değil' };
  const wc = browser.view.webContents;
  const a = args || {};
  const dlgAt = browser.lastDialog ? browser.lastDialog.at : 0;
  /* JEV HIZLI YOLU: TypeSafe ajanı her adımda zaten taze observe yapar —
     ağır imza + taze snapshot + uzun bekleme gereksizdir. */
  const fast = !!a.fast;
  const trusted = !!a.trusted && ['click', 'type', 'hover'].includes(kind) && browser.attached;
  /* DOĞRULAMA: eylem öncesi görsel parmak izi (yalnız anlamlı eylemlerde) */
  const verify = ['click', 'type', 'select', 'press'].includes(kind) && !fast && !(a.verify === false);
  const sigBefore = verify ? await pageSignature(wc) : null;
  try {
    let obj = {};
    if (trusted) {
      const pointRaw = await wc.executeJavaScript(browserPointJs(a), true);
      let point = {};
      try { point = JSON.parse(pointRaw); } catch { point = { ok: false, reason: 'koordinat alinamadi' }; }
      if (!point.ok) {
        obj = kind === 'click' ? { clicked: false, ...point }
          : kind === 'hover' ? { hovered: false, ...point }
          : { typed: false, ...point };
      } else if (kind === 'type' && /^(date|time|month|week|datetime-local)$/.test(String(point.input_type || ''))) {
        /* native tarih/saat alanı: gerçek klavye yerine programatik değer + event
           (tarayıcı segment segment yazmayı reddeder) */
        const raw = await wc.executeJavaScript(browserActionJs(kind, a), true);
        try { obj = JSON.parse(raw); } catch { obj = { result: String(raw).slice(0, 300) }; }
      } else if (kind === 'hover') {
        /* GERÇEK fare: yalnız mouseMove — tıklama YOK; kategori/mega menü
           hover ile açılır, sonraki gözlemde alt menü hedefleri görünür olur. */
        wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
        await new Promise((r) => setTimeout(r, 260));
        obj = { hovered: true, trusted: true, target: point.how };
      } else {
        wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
        wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
        if (kind === 'click') {
          obj = { clicked: true, trusted: true, target: point.how };
        } else {
          /* gerçek klavye: önce mevcut değeri seç, sonra yaz — otocomplete tetiklenir */
          await new Promise((r) => setTimeout(r, 40));
          try { wc.selectAll(); } catch {}
          wc.insertText(String(a.text == null ? '' : a.text));
          if (a.submit) {
            wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
            wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
          }
          obj = { typed: true, trusted: true, target: point.how, value: String(a.text == null ? '' : a.text) };
        }
      }
    } else {
      const raw = await wc.executeJavaScript(browserActionJs(kind, a), true);
      try { obj = JSON.parse(raw); } catch { obj = { result: String(raw).slice(0, 300) }; }
    }

    // tıklama/form gönderimi sonrası gezinme bekleme: olay ANINDA döner —
    // hızlı yolda gezinme yoksa yalnız 140 ms beklenir (eski 500 ms ölü süre).
    let navigated = false;
    if (kind === 'click' || (kind === 'type' && a.submit) || kind === 'press') {
      await new Promise((resolve) => {
        let done = false;
        const onNav = () => { navigated = true; fin(); };
        const fin = () => {
          if (done) return;
          done = true;
          clearTimeout(t);
          wc.removeListener('did-navigate', onNav);
          wc.removeListener('did-navigate-in-page', onNav);
          resolve();
        };
        const t = setTimeout(fin, fast ? 140 : 1800);
        wc.on('did-navigate', onNav);
        wc.on('did-navigate-in-page', onNav);
      });
    }
    /* SPA: sayfa değiştiyse yükleme bitişi + kısa DOM oturması (fast: 420 ms tavan) */
    if (navigated) {
      await browserLoadWait(wc, signal, fast ? 1200 : 4000);
      await browserSettle(wc, signal, fast ? 420 : 2500, fast ? 70 : 300);
    }

    /* DOĞRULAMA: eylem sonrası değişim oranı — "tıkladım ama bir şey olmadı" tuzağını yakalar */
    let changed = null;
    let changeRatio = null;
    if (sigBefore) {
      const sigAfter = await pageSignature(wc);
      const ratio = computeruse.signatureDiff(sigBefore, sigAfter);
      if (ratio != null) {
        changed = ratio >= 0.02;
        changeRatio = Number(ratio.toFixed(3));
      }
    }

    blog(
      kind,
      obj.clicked ? obj.target
        : obj.hovered ? ('üzerine gelindi ' + obj.target)
        : obj.typed ? ('"' + obj.value + '" → ' + obj.target)
        : obj.selected ? ('"' + obj.value + '" seçildi')
        : obj.pressed ? ('tuş ' + obj.pressed)
        : obj.scrolled ? ('kaydır y=' + obj.y)
        : (obj.reason || 'tamam')
    );

    /* HIZ: eylem cevabına taze snapshot göm — model ayrı browser_snapshot çağırmaz (tur sayısı yarıya iner).
       Jev hızlı yolunda snapshot gömülmez; döngü zaten observe eder. */
    const freshSnap = fast ? null : await browserSnapshotNow(wc);

    return {
      ok: true,
      action: kind,
      ...obj,
      url: wc.getURL(),
      title: wc.getTitle(),
      navigated,
      ...(fast ? { fast: true } : {}),
      ...(changed != null ? { changed, changeRatio } : {}),
      ...(changed === false && ['click', 'type', 'select'].includes(kind)
        ? {
            warning:
              'görünür değişiklik yok (changeRatio ' + changeRatio + ') — eylem etkisiz olabilir: ' +
              'ref bayat olabilir (browser_snapshot al ve güncel ref ile tekrar dene), öğe kapalı/gizli olabilir ' +
              'ya da tıklama sayfa tarafından engellenmiş olabilir. browser_wait ile kısa bekleme dene.',
          }
        : {}),
      ...browserDialogNote(dlgAt),
      ...(freshSnap ? { snapshot: freshSnap.snapshot, refCount: freshSnap.count } : {}),
      ...(fast
        ? {}
        : navigated
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

/* BEKLE: selector/text/ref görünene (gone:true ise kaybolana) kadar ya da ms
   kadar bekle. SPA'lar, gecikmeli açılan menüler ve ağ yavaşlığı için —
   körlemesine tekrar denemek yerine deterministik bekleme. */
async function browserWait(args, signal) {
  if (!browser.view || !browser.open) return { ok: false, error: 'tarayıcı açık değil' };
  const wc = browser.view.webContents;
  const a = args || {};
  const timeout = Math.max(200, Math.min(30000, Number(a.timeout_ms) || 10000));
  const ms = Math.max(0, Math.min(10000, Number(a.ms) || 0));
  const hasCond = a.selector != null || a.text != null || a.ref != null;
  if (!hasCond) {
    if (!ms) return { ok: false, error: 'selector, text, ref ya da ms ver' };
    await new Promise((r) => setTimeout(r, ms));
    return { ok: true, waited_ms: ms, url: wc.getURL(), title: wc.getTitle() };
  }
  const gone = !!a.gone;
  const t0 = Date.now();
  /* ms verildiyse koşul taramasından ÖNCE sabit bekleme (extra delay) */
  if (ms) await new Promise((r) => setTimeout(r, ms));
  const refJs = a.ref != null ? `!!__resolveRef(${JSON.stringify(Number(a.ref))})` : '';
  const selJs = a.selector != null ? `(function(){try{var el=document.querySelector(${JSON.stringify(String(a.selector))});return !!(el&&__vis(el));}catch(e){return false;}})()` : '';
  const txtJs = a.text != null ? `((document.body?document.body.innerText:'').toLowerCase().includes(${JSON.stringify(String(a.text).toLowerCase())}))` : '';
  const probe = `(function(){${BROWSER_JS_HELPERS};try{return !!(${refJs || selJs || txtJs});}catch(e){return false;}})()`;
  while (Date.now() - t0 < timeout) {
    if (signal && signal.aborted) return { ok: false, error: 'bekleme iptal edildi' };
    let found = false;
    try { found = !!(await wc.executeJavaScript(probe, true)); } catch { found = false; }
    if (gone ? !found : found) {
      return {
        ok: true,
        waited_ms: Date.now() - t0,
        ...(gone ? { gone: true } : { found: true }),
        ...(a.selector != null ? { selector: String(a.selector) } : {}),
        ...(a.text != null ? { text: String(a.text).slice(0, 60) } : {}),
        ...(a.ref != null ? { ref: Number(a.ref) } : {}),
        url: wc.getURL(),
        title: wc.getTitle(),
        note: 'koşul sağlandı — şimdi eyleme geç; ref lazımsa browser_snapshot ile güncel ref al',
      };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return {
    ok: false,
    error:
      'bekleme zaman aşımı (' + timeout + ' ms): ' +
      (a.selector != null ? 'selector bulunamadı: ' + String(a.selector).slice(0, 60)
        : a.text != null ? 'metin bulunamadı: ' + String(a.text).slice(0, 60)
          : 'ref mevcut değil: ' + Number(a.ref)) +
      (gone ? ' (hâlâ görünüyor)' : ''),
    url: wc.getURL(),
    title: wc.getTitle(),
  };
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
    let logoUri = '';
    try {
      logoUri = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo.png')).toString('base64');
    } catch {}
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
      .logo{width:96px;height:96px;display:flex;align-items:center;justify-content:center}
      .logo img{width:100%;height:100%;object-fit:contain;border-radius:22px}
      .logo-fb{width:84px;height:84px;border-radius:20px;background:${fg};color:${bg};display:flex;align-items:center;justify-content:center;font-weight:900;font-size:44px}
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
      ${logoUri ? `<div class="logo"><img src="${logoUri}" alt="Beast Agent"></div>` : '<div class="logo-fb">B</div>'}
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

/* ---------- JEV TRADER GÖMÜLÜ MOD ----------
   JevTrader arayüzü Beast penceresi içinde tam ekran bir webview'da açılır;
   arka uç (MT5 / Binance / OKX / paper / journal / entegrasyonlar) Beast ana
   sürecinde src/jev/backend.js ile koşar. Veriler %APPDATA%\jevtrader
   altında aynen korunur; IPC kanalları 'jev:' önekiyle kaydedilir. */
let jevMod = null;
/* JevTrader modu sinyali arka uç HENÜZ yüklenmeden gelebilir (renderer önce
   jev:mode, hemen ardından jev:start çağırır). İsteği kaybetmemek için son
   durum saklanır ve arka uç oluşturulunca uygulanır. */
let jevModeWanted = false;

function jevEnsure() {
  if (!jevMod) {
    const backend = require('./jev/backend');
    /* backend modül yüklenirken tüm 'jev:*' IPC kanallarını kaydeder */
    jevMod = { backend, wcId: 0, started: false };
    log.info('jev', 'JevTrader arka ucu yüklendi');
    if (jevModeWanted) {
      try { jevMod.backend.setJevMode(true); } catch {}
    }
  }
  return jevMod;
}

function jevFileUrl(rel) {
  return require('url').pathToFileURL(path.join(__dirname, rel)).href;
}

ipcMain.handle('jev:info', () => ({
  url: jevFileUrl(path.join('jev', 'renderer', 'index.html')),
  preload: jevFileUrl(path.join('jev', 'preload.js')),
}));

ipcMain.handle('jev:start', () => {
  const j = jevEnsure();
  if (!j.started) {
    try {
      j.backend.start();
      j.started = true;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  return { ok: true };
});

ipcMain.handle('jev:attach', (_e, id) => {
  const j = jevEnsure();
  const wc = webContents.fromId(Number(id) || 0);
  if (!wc) return { ok: false, error: 'webview bulunamadı' };
  j.wcId = wc.id;
  j.backend.setWebContents(wc);
  wc.once('destroyed', () => {
    try {
      if (j.wcId === wc.id) {
        j.backend.setWebContents(null);
        j.wcId = 0;
      }
    } catch {}
  });
  return { ok: true };
});

ipcMain.handle('jev:detach', () => {
  if (jevMod) {
    try {
      jevMod.backend.setWebContents(null);
      jevMod.wcId = 0;
    } catch {}
  }
  return { ok: true };
});

/* JevTrader modu açılıp kapanınca haber ver: mod kapalıyken MT5 köprüsü ve
   terminali hiç çalışmaz — MT5 yalnız JevTrader içinde bağlanır */
ipcMain.handle('jev:mode', (_e, on) => {
  jevModeWanted = !!on;
  if (!jevMod) return { ok: true };
  try {
    jevMod.backend.setJevMode(!!on);
  } catch {}
  return { ok: true };
});

/* webview pencereleri: dış bağlantılar varsayılan tarayıcıda açılır */
app.on('web-contents-created', (_ev, wc) => {
  try {
    if (wc.getType && wc.getType() === 'webview') {
      wc.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url)).catch(() => {});
        return { action: 'deny' };
      });
    }
  } catch {}
});

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
    /* pencere butonları (küçült/büyüt/kapat) renderer'da TRANSPARAN custom
       çizilir — native titleBarOverlay kendi arka planını dayattığı için
       kaldırıldı; kontroller 'window:ctrl' IPC'siyle yönetilir */
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webviewTag: true, /* JevTrader gömülü modu (src/jev) için */
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    closeSplash();
    /* HER AÇILIŞTA BÜYÜTÜLMÜŞ (ulanıcının tercihi): pencere komple açılır;
       başlangıçta gizli (startHidden) ise olduğunda da maximize kalır */
    try { win.maximize(); } catch {}
    /* SON MOD HATIRLAMA: uygulama CAM modunda kapatıldıysa bu kez doğrudan
       CAM SOHBET açılır; ana pencere gizlide bekler — kullanıcı kaldığı
       modda devam eder. Cam açılamazsa normal uygulamaya düş (emniyet). */
    if (!startHidden && String((settings && settings.lastMode) || 'app') === 'glass') {
      win.hide();
      setTimeout(() => {
        try {
          if (!glassOpen(true)) showWin();
        } catch { try { showWin(); } catch {} }
      }, 350);
      return;
    }
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
  /* maximize/fullscreen geçişlerinde dock hizası + görünürlük KESİN senkronlanır —
   aksi halde tam ekranda tarayıcı "kapanmış" gibi görünür */
function resyncBrowserUi() {
  try {
    if (browser.view) browser.view.setVisible(browser.open && browser.visible);
  } catch {}
  if (browser.open) {
    const wShown = browserShownWidth(browserW());
    browser._lastEmittedW = wShown;
    browserEmit({ open: true, width: wShown });
  } else {
    browserEmit({ open: false });
  }
}

  win.on('resize', () => {
    layoutBrowser();
    /* resize sürerken son boyutu yakala: maximize/restore bitiminde dock KESİN
       yeni pencere boyutuna otursun (BrowserView bayat bounds bırakmasın) */
    clearTimeout(win._bzRzT);
    win._bzRzT = setTimeout(() => { try { layoutBrowser(); } catch {} }, 120);
  });
  win.on('maximize', () => {
    layoutBrowser();
    resyncBrowserUi();
    setTimeout(() => { try { layoutBrowser(); resyncBrowserUi(); } catch {} }, 80);
    setTimeout(() => { try { layoutBrowser(); resyncBrowserUi(); } catch {} }, 300);
    try { if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'win-max', maximized: true }); } catch {}
  });
  win.on('unmaximize', () => {
    layoutBrowser();
    resyncBrowserUi();
    setTimeout(() => { try { layoutBrowser(); resyncBrowserUi(); } catch {} }, 80);
    setTimeout(() => { try { layoutBrowser(); resyncBrowserUi(); } catch {} }, 300);
    try { if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'win-max', maximized: false }); } catch {}
  });
  win.on('enter-full-screen', () => {
    layoutBrowser(); resyncBrowserUi();
    setTimeout(() => { try { layoutBrowser(); resyncBrowserUi(); } catch {} }, 80);
    setTimeout(() => { try { layoutBrowser(); resyncBrowserUi(); } catch {} }, 300);
  });
  win.on('leave-full-screen', () => {
    layoutBrowser(); resyncBrowserUi();
    setTimeout(() => { try { layoutBrowser(); resyncBrowserUi(); } catch {} }, 80);
    setTimeout(() => { try { layoutBrowser(); resyncBrowserUi(); } catch {} }, 300);
  });
  win.on('show', () => { layoutBrowser(); resyncBrowserUi(); });
  /* renderer her yeni yüklemede (açılış, reload, kurtarma) tarayıcı durumunu
     TAZE alır — açılışta kaçan 'browser' olayı dock'un ayrılmamasına yol açıyordu */
  win.webContents.on('did-finish-load', () => {
    try { resyncBrowserUi(); } catch {}
  });
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

/* ---------- CAM SOHBET IPC: panel içi düğmeler (kapat / boyut / durum) ---------- */
ipcMain.handle('glass:close', () => { glassHide(); modeRemember('app'); return { ok: true }; });
ipcMain.handle('glass:desktop', () => { glassHide(); modeRemember('app'); showWin(); return { ok: true }; });
ipcMain.handle('glass:mini', (_e, on) => { return { ok: glassMiniSet(!!on), on: glassMiniOn }; });

/* CAM ÖZEL tarayıcı seçimi: 'embedded' (yalnız panel içi) | 'external' (sistem tarayıcısı da açılır) */
ipcMain.handle('glass:browser:get', () => String(settings.glassBrowser || 'external'));
ipcMain.handle('glass:browser:set', (_e, v) => {
  settings.glassBrowser = v === 'embedded' ? 'embedded' : 'external';
  saveSettings();
  return settings.glassBrowser;
});
ipcMain.handle('glass:mode', (_e, big) => {
  try {
    settings.glass = { ...(settings.glass || {}), big: !!big };
    saveSettings();
  } catch {}
  try { if (glassWin && !glassWin.isDestroyed()) glassWin.setBounds(glassBounds()); } catch {}
  return { ok: true, big: !!(settings.glass && settings.glass.big) };
});
ipcMain.handle('glass:state', () => ({
  visible: !!(glassWin && !glassWin.isDestroyed() && glassWin.isVisible()),
  big: !!(settings.glass && settings.glass.big),
}));

ipcMain.handle('sessions:list', () => engine.listSessions());
/* DESKTOP YENİ SOHBET: masaüstü UI'daki "yeni sohbet" düğmesinin aynısı,
   /new komutu da BUNU kullanır — bot bağlama/izin/araç seti/model kayıtsız */
function createDesktopSession() {
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
}
/* İKİ PANELE OTURUM DEĞİŞTİR BİLDİRİMİ: ana ekran yeni 'session-switch' olayıyla,
   cam ekran var olan 'glass-session' olayıyla yeni oturumu açar */
function switchDesktopSid(newId) {
  const sidStr = String(newId || '');
  if (!sidStr) return;
  if (sessionFileAlive(sidStr)) desktopActiveSid = sidStr;
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:event', { type: 'session-switch', sessionId: sidStr });
    }
  } catch {}
  try {
    if (glassWin && !glassWin.isDestroyed()) {
      glassWin.webContents.send('agent:event', { type: 'glass-session', sessionId: sidStr });
    }
  } catch {}
  /* BEAST MOBILE: telefonda da aynı oturuma geç — snapshot istesin */
  try { mobileWs.broadcast({ type: 'session-switch', sessionId: sidStr }); } catch {}
  /* tüm panelin oturum listesi de tazelensin (yeni sohbet listeye düşer) */
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:event', { type: 'sessions', sessionId: sidStr });
    }
  } catch {}
}
ipcMain.handle('sessions:create', () => createDesktopSession());
/* ---------- BEAST MOBILE IPC (ayarlar paneli) ---------- */
ipcMain.handle('mobile:getState', () => {
  try {
    const st = mobileWs.status();
    const t = mobileTunnelCfg();
    const ts = mobileTunnel.status();
    return {
      code: device.getDevice().code,
      name: device.deviceName(),
      enabled: !!mobileCfg().enabled,
      port: Number(mobileCfg().port) || 8788,
      running: !!st.running,
      lastError: String(st.lastError || lastMobileStartError || ''),
      ip: lanIp(),
      clients: st.clients,
      phones: device.listPhones(),
      tunnel: {
        enabled: !!t.enabled,
        domain: t.domain,
        authtokenSet: !!t.authtoken,
        running: !!ts.running,
        url: ts.url,
        wss: ts.wss,
        error: String(ts.error || ''),
      },
      watchdog: {
        everySec: Math.round(MOBILE_WATCH_MS / 1000),
        lastCheck: mobileWatchLastCheck,
        lastFix: String(mobileWatchLastFix || ''),
        fails: Number(mobileWatchFails) || 0,
        nextInSec: Math.max(0, Math.round((mobileWatchNextAt - Date.now()) / 1000)),
      },
    };
  } catch (e) {
    return {
      code: '', name: 'Beast Agent', enabled: false, port: 8788, running: false,
      lastError: String(e), ip: '127.0.0.1', clients: [], phones: [],
      tunnel: { enabled: false, domain: '', authtokenSet: false, running: false, url: '', wss: '', error: '' },
      watchdog: { everySec: 30, lastCheck: 0, lastFix: '', fails: 0, nextInSec: 0 },
    };
  }
});
ipcMain.handle('mobile:setEnabled', async (_e, on) => {
  try {
    const cfg = mobileCfg();
    cfg.enabled = !!on;
    lastMobileStartError = '';
    saveSettings();
    applyMobileServer();
  } catch {}
  await waitMobileSettled(); /* listen otursun — renderer hemen doğru durumu görsün */
  return mobileWs.status();
});
ipcMain.handle('mobile:setPort', async (_e, p) => {
  try {
    const n = Math.max(1024, Math.min(65535, Number(p) || 8788));
    const cfg = mobileCfg();
    cfg.port = n;
    lastMobileStartError = '';
    saveSettings();
    applyMobileServer();
  } catch {}
  await waitMobileSettled();
  return mobileWs.status();
});
ipcMain.handle('mobile:regenCode', () => {
  try {
    device.regenCode();
    /* kod değişti — ESKİ İSTEMCİLER geçersiz: aktif tüm ws soketleri kesilir */
    try { mobileWs.stop(); applyMobileServer(); } catch {}
  } catch {}
  return { code: device.getDevice().code };
});
ipcMain.handle('mobile:setTunnel', async (_e, patch) => {
  try {
    const p = patch && typeof patch === 'object' ? patch : {};
    const t = mobileTunnelCfg();
    if (p.enabled !== undefined) t.enabled = !!p.enabled;
    /* token boş/yoksa mevcut korunur: panelde sadece domain oynatınca token silinmesin */
    const tok = p.authtoken === undefined ? '' : String(p.authtoken || '').trim();
    if (tok) t.authtoken = tok;
    if (p.domain !== undefined) t.domain = mobileTunnel.cleanDomain(p.domain);
    saveSettings();
  } catch {}
  /* köprü kapalıyken de token/domain kaydedilir; tünel WS açılınca otomatik kurulur */
  const r = await applyMobileTunnel();
  const t = mobileTunnelCfg();
  const ts = mobileTunnel.status();
  return {
    enabled: !!t.enabled,
    domain: t.domain,
    authtokenSet: !!t.authtoken,
    running: !!ts.running,
    url: ts.url,
    wss: ts.wss,
    error: String(ts.error || (r && r.error) || ''),
  };
});
ipcMain.handle('mobile:setName', (_e, name) => {
  try { device.setDeviceName(name); } catch {}
  return { name: device.deviceName() };
});
/* elle yeniden başlatma (paneldeki buton): köprü + ngrok tüneli baştan kurulur,
   bekçi de aynı yolu kullanır — elle/onomatik fark etmez, tek yol */
ipcMain.handle('mobile:restart', async () => {
  try {
    lastMobileStartError = '';
    applyMobileServer(); /* WS + ardından 150ms içinde applyMobileTunnel */
    mobileWatchNoteFix('elle yeniden başlatıldı');
  } catch (e) { lastMobileStartError = String((e && e.message) || e); }
  await waitMobileSettled();
  /* ngrok dial-out ~1-3 sn sürer: tünel de otursun diye kısa bekleme */
  for (let i = 0; i < 30; i++) {
    const t = mobileTunnelCfg();
    if (!t.enabled || !mobileCfg().enabled || mobileTunnel.status().running || mobileTunnel.status().error) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  /* bekçinin eski backoff'u taze onarımın önüne geçmesin */
  mobileWatchNextAt = 0;
  return mobileWs.status();
});
ipcMain.handle('mobile:kickPhone', (_e, id) => {
  try { device.kickPhone(id); return true; } catch { return false; }
});
ipcMain.handle('sessions:open', (_e, id) => engine.openSession(id));
ipcMain.handle('sessions:delete', (_e, id) => {
  const sid = String(id || '');
  if (sid && sid === desktopActiveSid) desktopActiveSid = '';
  return engine.deleteSession(id);
});
/* masaüstü UI hangi sohbeti AÇIK tutuyorsa main'e bildirir: empati loop
   proaktif notu rastgele bir oturuma değil, kullanıcının gördüğü sohbete
   işler; meşgulse enjeksiyon kuyruğa girer, tur bitince geçmişe düşer */
ipcMain.handle('sessions:active', (_e, id) => {
  const sid = String(id || '');
  if (!sid) {
    desktopActiveSid = '';
    return true;
  }
  try {
    if (sessionFileAlive(sid)) desktopActiveSid = sid;
  } catch {}
  /* CAM ↔ MASAÜSTÜ SENKRONU: masaüstü UI hangi sohbeti açtıysa cam panel ONU
     izler — cam modundaki chat "beast-agent'taki chatin" birebir aynısı olur:
     aynı geçmiş + WA/STS dahil TÜM canlı akış aynı anda iki panelde görünür */
  try {
    if (glassWin && !glassWin.isDestroyed() && desktopActiveSid) {
      glassWin.webContents.send('agent:event', { type: 'glass-session', sessionId: desktopActiveSid });
    }
  } catch {}
  return true;
});

/* SLASH KOMUT YÖNLENDİRİCİSİ — masaüstü IPC ve BEAST MOBILE aynı kapıdan
   geçer. Böylece telefondan da /help, /new, /clear, /version, /model ...
   komutları masaüstüyle BİREBİR aynı şekilde çalışır.
   (mobileHandlers.onSend → handleAgentSend) */
function handleAgentSend(sessionId, text) {
  const raw = text && typeof text === 'object' ? String(text.text || '') : String(text ?? '');
  const t = raw.trim();
  /* yazan sohbet = kullanıcının gördüğü sohbet: proaktif enjeksiyon hedefi */
  try {
    const asid = String(sessionId || '');
    if (asid && sessionFileAlive(asid)) desktopActiveSid = asid;
  } catch {}
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
    /* npm registry'den en son sürümü de göster (10dk cache'li) */
    versionText(false)
      .then((txt) => desktopEcho(sessionId, t, txt))
      .catch(() => desktopEcho(sessionId, t, `**Beast Agent v${beastVersion()}**`));
    return true;
  }
  if (t === '/help') {
    desktopEcho(sessionId, '/help', desktopSlashHelp());
    return true;
  }
  if (t === '/autodel' || t.startsWith('/autodel ')) {
    /* /autodel [all] — otomatik hatırlatmaları tek komutla sil (WA ile aynı davranış) */
    const arg = t.slice(8).trim().toLowerCase();
    if (arg === 'all' || arg === 'hepsi' || arg === 'hepsini') {
      const r = cron.clearAll();
      cronEmit();
      desktopEcho(sessionId, t, r.ok ? `**Tüm zamanlanmış görevler silindi** (${r.count} adet).` : 'Temizlenemedi.');
    } else {
      const r = cron.removeIf(isReminderJob);
      cronEmit();
      const left = cron.list().filter((j) => j.enabled).length;
      desktopEcho(
        sessionId,
        t,
        r.count
          ? `**${r.count} otomatik hatırlatma silindi.** Kalan aktif görev: ${left}`
          : 'Silinecek otomatik hatırlatma yok — zaten temiz.'
      );
    }
    return true;
  }
  if (t === '/deltodo' || t.startsWith('/deltodo ')) {
    /* /deltodo [all] — todo listelerini temizle (WA ile aynı davranış) */
    const arg = t.slice(8).trim().toLowerCase();
    if (arg === 'all' || arg === 'hepsi' || arg === 'hepsini') {
      let n = 0;
      let items = 0;
      try {
        for (const v of engine.listSessions()) {
          const r = engine.clearTodos(v.id);
          if (r && r.ok) {
            n++;
            items += r.count || 0;
          }
        }
      } catch {}
      desktopEcho(sessionId, t, n ? `**Tüm oturumların todoları temizlendi** (${n} oturum, ${items} madde).` : 'Temizlenecek todo yok.');
    } else {
      const r = engine.clearTodos(String(sessionId || ''));
      desktopEcho(
        sessionId,
        t,
        r.ok
          ? r.count
            ? `**${r.count} todo temizlendi.** (tüm oturumlar: /deltodo all)`
            : 'Todo listesi zaten boş. (tüm oturumlar: /deltodo all)'
          : 'Oturum bulunamadı — todo listesi yok.'
      );
    }
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
    if (arg === 'refresh') {
      /* tüm provider modellerini yeniden çek — sağ üstteki yenile düğmesiyle aynı */
      desktopEcho(sessionId, t, '**Modeller yeniden çekiliyor…** (tüm providerlar)');
      refreshModelsAll()
        .then((st) => {
          desktopEcho(
            sessionId,
            t,
            `**Modeller tazelendi** — ${st.models.length} model · ${st.activeModel ? `aktif: ${st.activeModel.providerName} · ${st.activeModel.model}` : 'aktif model yok'}`
          );
          if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'modelChanged', sessionId: String(sessionId || '') });
        })
        .catch((e) => desktopEcho(sessionId, t, 'Model yenileme başarısız: ' + String((e && e.message) || e)));
      return true;
    }
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
  if (t === '/new') {
    /* YENİ SOHBET: masaüstü "yeni sohbet" düğmesiyle aynı akış, komuttan:
       yeni oturum yaratılır + her iki panel (ana/cam) oraya taşınır;
       eski sohbet listede güvenle durur — geçmiş kaybolmaz */
    try {
      const created = createDesktopSession();
      switchDesktopSid(created.id);
      desktopEcho(created.id, '/new', 'Yeni sohbet açıldı — sıfırdan konuşabilirsin. (Eski sohbet listede duruyor.)');
    } catch (e) {
      desktopEcho(sessionId, '/new', 'Yeni sohbet açılamadı: ' + String((e && e.message) || e));
    }
    return true;
  }
  if (t === '/clear') {
    /* #25 artık GERÇEK silme: oturum dosyasındaki mesajlar + notlar silinir,
       kod/meta/todolar korunur. Ekran da temizlenir ('clear' olayı). */
    const ok = engine.clearMessages(String(sessionId || ''));
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:event', { sessionId: String(sessionId || ''), type: 'clear' });
    }
    /* CAM PANEL DE TEMİZLENİR: 'clear' olayı ana pencereyle BERABER cama da
       gönderilmezse camdaki eski geçmiş ekranda kalıyor (hata raporu) */
    try {
      if (glassWin && !glassWin.isDestroyed()) {
        glassWin.webContents.send('agent:event', { sessionId: String(sessionId || ''), type: 'clear' });
      }
    } catch {}
    /* BEAST MOBILE: telefondaki ekran da bu oturumu temizler */
    try { mobileWs.broadcast({ sessionId: String(sessionId || ''), type: 'clear' }); } catch {}
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
  /* /stop kilidi normal mesajla AÇILMAZ — mesaj yine işlenir (engine userAction),
     ama durdurulan iş/kuyruk kendiliğinden devam etmez */
  queueDesktopMessage(sessionId, text);
  return true;
}

ipcMain.handle('agent:send', (_e, { sessionId, text }) => handleAgentSend(sessionId, text));

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
    '**/new** – yeni sohbet aç (eski sohbet listede durur; ana ekran ve cam birlikte geçer)',
    '**/restart** – uygulamayı yeniden başlat',
    '**/stop** – koşan her şeyi durdur + kilitle · **/start** – kilidi aç',
    '**/change [n]** – modelleri listele · n. modele geç',
    '**/model [isim]** – aktif modeli göster / değiştir · **/model refresh** – tüm provider modellerini yeniden çek',
    '**/think 0-5** – düşünme seviyesi (0 kapalı · 5 max)',
    '**/agent [isim]** – özel ajan bağla / listele (%APPDATA%\\beast\\agents\\*.md)',
    '**/clear** – oturum geçmişini gerçekten sil (kod korunur)',
    '**/autodel** – tüm otomatik hatırlatmaları tek komutla sil · **/autodel all** – cron görevleri dahil hepsi',
    '**/deltodo** – bu oturumun todo listesini temizle · **/deltodo all** – tüm oturumların todoları',
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
/* SLASH YANKISI — KOMUT + CEVAP: masaüstü penceresi VE cam panel aynı
   event akışını alır ("camda komut çalışıyor ama cevabı göremiyorum" çözümü) */
function desktopEcho(sessionId, cmd, reply) {
  const sid = String(sessionId || '');
  emitWaBoth({ sessionId: sid, type: 'message', message: { role: 'user', content: cmd } });
  emitWaBoth({ sessionId: sid, type: 'message', message: { role: 'assistant', content: reply } });
  emitWaBoth({ sessionId: sid, type: 'done', usage: null });
  /* KALICI KAYIT: komut + cevap oturuma sessiz yazılır — telefondan/masadan
     sohbete tekrar girince komut konuşmaları WhatsApp gibi SİLİNMEZ
     (broadcast yukarıda yalnız canlı ekranlar içindir; emit etmeden kaydolur) */
  try {
    if (sid && sessionFileAlive(sid)) {
      engine.observe(sid, String(cmd || ''), { silent: true });
      engine.injectAssistant(sid, String(reply || ''), { silent: true });
    }
  } catch {}
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
  const sid = String(sessionId || '');
  /* kapanış balonu masaüstü + cam iki panel birden */
  emitWaBoth({ sessionId: sid, type: 'message', message: { role: 'user', content: '/restart' } });
  emitWaBoth({
    sessionId: sid,
    type: 'message',
    message: { role: 'assistant', content: '\u21BB **Yeniden başlatılıyor…** Birkaç saniye içinde pencere geri açılacak.' },
  });
  emitWaBoth({ sessionId: sid, type: 'done', usage: null });
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
      'Bu kilit yalnız `/start` ile açılır — yeni mesaj yazmak durdurulan işi devam ettirmez.';
  } else {
    const wasStopped = !!(engine && engine._stopped);
    resumeServices();
    reply = wasStopped
      ? '\u25B6 **Devam** — kilit açıldı; yeni istekler normal işlenir.'
      : 'Zaten çalışıyor — durdurulmuş bir şey yok.';
  }
  /* teyit balonu masaüstü + cam iki panel birden */
  emitWaBoth({ sessionId: sid, type: 'message', message: { role: 'user', content: cmd } });
  emitWaBoth({ sessionId: sid, type: 'message', message: { role: 'assistant', content: reply } });
  emitWaBoth({ sessionId: sid, type: 'done', usage: null });
}

ipcMain.handle('agent:interrupt', (_e, sessionId, reason) => {
  /* durdurma: bekleyen birleştirme kuyruğunu da boşalt (kullanıcı vazgeçti) */
  try {
    const q = desktopQueue.get(String(sessionId));
    if (q) {
      clearTimeout(q.timer);
      desktopQueue.delete(String(sessionId));
    }
  } catch {}
  return engine.interrupt(
    sessionId,
    String(reason || '').trim() || 'kullanıcı sohbetteki durdurma (■) düğmesiyle iptal etti'
  );
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
  /* OPENCODE STEER: koşan tur varken mesaj ANINDA konuşmaya eklenir —
     ajan sonraki istekte görür, eski cevap akışı bozulmaz. Kuyrukta beklemesine
     gerek yok; boşta debounce penceresi yine birleştirir. */
  if (engine.isBusy(sid)) {
    waLog(`desktop: oturum meşgul — mesaj steer olarak konuşmaya eklendi sid=${sid}`);
    engine.send(sid, hasAtts ? { text: t, attachments: text.attachments } : t, { userAction: true });
    return;
  }
  let q = desktopQueue.get(sid);
  if (!q) {
    q = { timer: null, msgs: [] };
    desktopQueue.set(sid, q);
  }
  q.msgs.push({ text: t, attachments: hasAtts ? text.attachments : undefined });

  /* agent boşta: kısa pencere — hızlı ikinci mesaj ilkine eklenir */
  clearTimeout(q.timer);
  q.timer = setTimeout(() => flushDesktop(sid).catch(() => {}), DESKTOP_DEBOUNCE_MS);
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
/* TELEFON/AJAN DOSYA KAYITLARI: tur DURURKEN oturuma yazmayalım — LLM tool
   zinciri bozulabilir. Kayıtlar kuyrukta bekler, tur 'done'/'error' olunca
   sessizce inject edilir (sohbet yeniden açıldığında kart WhatsApp gibi durur) */
const pendingFileRecords = new Map();
function queueFileRecord(sid, rec) {
  const key = String(sid || '');
  if (!key || !rec) return;
  try {
    const arr = pendingFileRecords.get(key) || [];
    arr.push(rec);
    pendingFileRecords.set(key, arr);
  } catch {}
}
function flushFileRecordsOnDone(ev) {
  try {
    if (!ev || (ev.type !== 'done' && ev.type !== 'error') || !ev.sessionId) return;
    const sid = String(ev.sessionId);
    /* paralel ajan işlerinin kayıtları da PARENT sohbete yazılır */
    const keys = [sid];
    try {
      for (const j of engine.listBgJobs()) {
        if (j && j.parentId && String(j.parentId) === sid && pendingFileRecords.has(String(j.id))) keys.push(String(j.id));
      }
    } catch {}
    for (const key of keys) {
      const arr = pendingFileRecords.get(key);
      if (!arr || !arr.length) { pendingFileRecords.delete(key); continue; }
      pendingFileRecords.delete(key);
      for (const r of arr) {
        try {
          engine.injectAssistant(sid, String(r.text || ''), {
            silent: true,
            forceNew: true,
            attachments: Array.isArray(r.attachments) ? r.attachments : undefined,
          });
        } catch {}
      }
    }
  } catch {}
}

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
ipcMain.handle('agents:cancel', (_e, id) => {
  const sid = String(id || '');
  return { ok: !!engine.interrupt(sid, 'kullanıcı Paralel Ajanlar panelinden (×) iptal etti') };
});
/* AJAN DM paneli: ajanlar arası mesaj arşivi */
ipcMain.handle('agent-dms:list', () => (engine ? engine.agentDmsList() : []));
ipcMain.handle('agent-dms:clear', () => (engine ? engine.agentDmsClear() : { ok: false }));
ipcMain.handle('agent-dms:delete-thread', (_e, key) => (engine ? engine.agentDmDeleteThread(key) : { ok: false }));

/* ---------- KİŞİSEL TOOLLAR (%APPDATA%\beast\tools\) ---------- */
ipcMain.handle('tools:list', () => customtools.list());
ipcMain.handle('tools:save', (_e, tool) => {
  const r = customtools.save(tool || {});
  /* panelden yayınlanan araç da entegrasyonlara duyurulur */
  if (r && r.ok) {
    try {
      integrationBroadcast(
        '🛠️ Araç yayında: tool__' + r.id + ' — ' + String((tool && tool.name) || r.id).slice(0, 60) + '\n(Beast TOOLS panelinden kaydedildi)'
      );
    } catch {}
  }
  return r;
});
ipcMain.handle('tools:delete', (_e, id) => customtools.remove(id));
ipcMain.handle('tools:run', async (_e, payload) => {
  const id = String((payload && payload.id) || '');
  const args = (payload && payload.args) || {};
  const r = await customtools.call('tool__' + id, args);
  return r;
});
ipcMain.handle('tools:openFolder', () => {
  try {
    const d = customtools.dir();
    fs.mkdirSync(d, { recursive: true });
    require('electron').shell.openPath(d);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
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

/* GECE YANSIMASI: elle tetikleme + son rapor/öğrenme günlükleri */
ipcMain.handle('reflect:run', async () => {
  if (!engine) return { ok: false, error: 'motor hazır değil' };
  const r = await engine.runNightReflection({ manual: true });
  if (r && r.ok) waLog(`gece yansıması (manuel): ${r.memory.before}→${r.memory.after} kayıt`);
  return r;
});
ipcMain.handle('reflect:last', () => {
  try {
    return JSON.parse(require('fs').readFileSync(require('path').join(memory.memDir(), 'reflections', 'last.json'), 'utf8'));
  } catch {
    return null;
  }
});
ipcMain.handle('reflect:reports', () => {
  try {
    const dir = require('path').join(memory.memDir(), 'reflections');
    return require('fs').readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f !== 'last.json')
      .sort()
      .reverse()
      .slice(0, 30)
      .map((f) => {
        try { return JSON.parse(require('fs').readFileSync(require('path').join(dir, f), 'utf8')); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
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
  if (out.email && out.email.pass) out.email.pass = SECRET_MASK;
  if (out.waTts && out.waTts.key) out.waTts.key = SECRET_MASK;
  if (out.supermemory && out.supermemory.apiKey) out.supermemory.apiKey = SECRET_MASK;
  if (out.typesafe && out.typesafe.apiKey) out.typesafe.apiKey = SECRET_MASK;
  if (out.fallout && Array.isArray(out.fallout.slots)) {
    for (const s of out.fallout.slots) if (s && s.key) s.key = SECRET_MASK;
  }
  if (Array.isArray(out.customProviders)) {
    for (const p of out.customProviders) if (p && p.key) p.key = SECRET_MASK;
  }
  return out;
});

/* ---------------- MCP IPC ---------------- */

/* UI'a giden raw JSON'da env sırlarını maskeler (düz metin anahtar sızmasın) */
function maskMcpRaw(raw) {
  try {
    const obj = JSON.parse(String(raw || ''));
    if (!obj || typeof obj !== 'object' || !obj.servers || typeof obj.servers !== 'object') return raw;
    for (const s of Object.values(obj.servers)) {
      if (s && typeof s === 'object' && s.env && typeof s.env === 'object') {
        for (const k of Object.keys(s.env)) if (String(s.env[k] || '')) s.env[k] = SECRET_MASK;
      }
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return raw;
  }
}

ipcMain.handle('mcp:status', () => {
  try { return mcpMod.status(); } catch { return { path: '', servers: [] }; }
});

ipcMain.handle('mcp:config:get', () => {
  try {
    const p = mcpMod.configPath();
    let raw = '';
    try { raw = require('fs').readFileSync(p, 'utf8'); } catch {}
    return { path: p, raw: maskMcpRaw(raw) };
  } catch { return { path: '', raw: '' }; }
});

ipcMain.handle('mcp:config:set', (_e, raw) => {
  try {
    const text = String(raw || '');
    const cfg = text.trim() ? JSON.parse(text) : { servers: {} };
    /* maskeli env sırlarını mevcut diskteki değerlerle geri koy */
    try { mcpMod.restoreMaskedSecrets(cfg); } catch {}
    mcpMod.saveConfig(cfg);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('mcp:refresh', async (_e, name) => {
  try {
    const ok = await mcpMod.refresh(String(name || ''));
    return { ok, status: mcpMod.status() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* ---------------- BEAST MCP SOHBETİ (MCP modu SAĞ panel) ----------------
   MCP moduna özel, ANA SOHBETTEN TAMAMEN AYRI oturum: bgTitle 'Beast MCP'
   (listSessions gizler, listMcpSessions listeler; geçmiş seçici eski
   oturumları açabilir). MCP sunucu araçları zaten tüm engine turlarına
   enjekte edilir; panel yalnız oturum yaşam döngüsünü yönetir.
   Gönderim main chat disiplininin aynısı: boşta kısa debounce (ard arda
   mesajlar birleşir), meşgulken steer (koşan tura anında eklenir). */
let mcpChatSid = ''; /* aktif MCP sohbet oturumu */
let mcpChatFresh = false; /* 'Yeni' istendi: eski sohbete DÖNME, taze aç */
const mcpChatQueue = new Map(); /* 'mcp' → { timer, msgs[] } */
const MCP_CHAT_DEBOUNCE_MS = 900;

function mcpChatCreate() {
  const s = engine._load(engine.createSession().id);
  s.messages = s.messages || [];
  s.bgTitle = 'Beast MCP'; /* _view.isBg → ana sohbet geçmişi listesinde gizli */
  try {
    fs.appendFileSync(
      engine._file(s.id),
      JSON.stringify({ t: 'meta2', bgOf: '', title: 'Beast MCP', at: new Date().toISOString() }) + '\n'
    );
  } catch {}
  engine.cache.set(s.id, s);
  mcpChatSid = s.id;
  mcpChatFresh = false;
  return s;
}

function mcpChatSession() {
  if (mcpChatSid) {
    try {
      const s = engine.cache.get(mcpChatSid) || engine._load(mcpChatSid);
      if (s && s.bgTitle === 'Beast MCP') return s;
    } catch {}
    mcpChatSid = '';
  }
  /* 'Yeni' istenmediyse son MCP sohbetine dön: uygulama yeniden açıldığında
     sohbet kaldığı yerden sürer (geçmiş seçiciden eski oturumlar açılabilir) */
  if (!mcpChatFresh) {
    try {
      const last = engine.listMcpSessions(50).find((it) => it.count > 0);
      if (last) {
        const s = engine._load(last.id);
        if (s && s.bgTitle === 'Beast MCP') {
          engine.cache.set(s.id, s);
          mcpChatSid = s.id;
          return s;
        }
      }
    } catch {}
  }
  return mcpChatCreate();
}

/* geçmiş yükü: yalnız metin mesajları (tool çağrıları panele basılmaz) */
function mcpChatMessages(s) {
  const msgs = [];
  for (const m of s.messages || []) {
    if (m.tool_calls) continue;
    const txt = bcMsgText(m);
    if (!txt) continue;
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', text: txt.slice(0, 4000) });
  }
  return msgs.slice(-200);
}

/* geçmiş listesi: boş oturumlar gizlenir (aktif olan daima görünür) */
function mcpChatHistory() {
  let items = [];
  try { items = engine.listMcpSessions(100); } catch {}
  return items.filter((it) => it.id === mcpChatSid || it.count > 0);
}

function mcpChatQueuePush(text, attachments) {
  let q = mcpChatQueue.get('mcp');
  if (!q) {
    q = { timer: null, msgs: [] };
    mcpChatQueue.set('mcp', q);
  }
  q.msgs.push({
    text,
    attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined,
  });
  return q;
}

function mcpChatFlush() {
  const q = mcpChatQueue.get('mcp');
  if (!q || !q.msgs.length) return;
  const s = mcpChatSession();
  if (engine.isBusy(s.id)) return; /* hâlâ çalışıyor — steer yolu mesajı zaten aldı */
  let merged = '';
  let mergedAtts = null;
  for (const m of q.msgs) {
    if (m.text) merged += (merged ? '\n' : '') + m.text;
    if (!mergedAtts && Array.isArray(m.attachments) && m.attachments.length) mergedAtts = m.attachments;
  }
  mcpChatQueue.delete('mcp');
  clearTimeout(q.timer);
  if (!merged.trim() && !mergedAtts) return;
  try {
    engine.send(s.id, mergedAtts ? { text: merged, attachments: mergedAtts } : merged, { userAction: true });
  } catch (e) {
    /* senkron patlama: panel busy'de kilitlenmesin — hata olayı düş */
    try {
      if (win && !win.isDestroyed()) {
        win.webContents.send('agent:event', { sessionId: s.id, type: 'error', error: String((e && e.message) || e) });
      }
    } catch {}
  }
}

function mcpChatFlushOnDone(ev) {
  if (!ev || (ev.type !== 'done' && ev.type !== 'error') || !ev.sessionId) return;
  if (mcpChatQueue.has('mcp') && String(ev.sessionId) === String(mcpChatSid)) {
    setTimeout(() => { try { mcpChatFlush(); } catch {} }, 150);
  }
}

ipcMain.handle('mcp:chat:open', async (_e, payload) => {
  if (!engine) return { ok: false, error: 'ajan hazır değil' };
  /* bekleyen debounce kuyruğu varsa ÖNCE eski oturuma teslim et (mesaj kaybolmaz) */
  try {
    if (mcpChatQueue.has('mcp') && mcpChatSid) mcpChatFlush();
  } catch {}
  const q = mcpChatQueue.get('mcp');
  if (q) {
    clearTimeout(q.timer);
    mcpChatQueue.delete('mcp');
  }
  const id = String((payload && payload.id) || '');
  let s;
  if (id) {
    try { s = engine._load(id); } catch { return { ok: false, error: 'oturum açılamadı' }; }
    if (s.bgTitle !== 'Beast MCP') return { ok: false, error: 'bu oturum MCP sohbeti değil' };
    mcpChatSid = id;
    mcpChatFresh = false;
  } else {
    s = mcpChatSession();
  }
  engine.cache.set(s.id, s);
  return {
    ok: true,
    sessionId: s.id,
    busy: !!engine.isBusy(s.id),
    messages: mcpChatMessages(s),
    items: mcpChatHistory(),
  };
});

ipcMain.handle('mcp:chat:send', async (_e, payload) => {
  const text = String((payload && payload.msg) || '').trim();
  const attachments = Array.isArray(payload && payload.attachments) ? payload.attachments : [];
  if (!text && !attachments.length) return { ok: false, error: 'boş mesaj' };
  if (!engine) return { ok: false, error: 'ajan hazır değil' };
  if (!engine.publicState().hasModel) return { ok: false, error: 'model yok — Ayarlar → Provider sekmesinden ekle' };
  const s = mcpChatSession();
  if (engine.isBusy(s.id)) {
    /* MAIN CHAT STEER: koşan tur varken mesaj ANINDA konuşmaya eklenir */
    engine.send(s.id, attachments.length ? { text, attachments } : text, { userAction: true });
    return { ok: true, sessionId: s.id, steered: true };
  }
  const q = mcpChatQueuePush(text, attachments);
  clearTimeout(q.timer);
  q.timer = setTimeout(() => { try { mcpChatFlush(); } catch {} }, MCP_CHAT_DEBOUNCE_MS);
  return { ok: true, sessionId: s.id, pending: true };
});

ipcMain.handle('mcp:chat:stop', async () => {
  const q = mcpChatQueue.get('mcp');
  if (q) {
    clearTimeout(q.timer);
    mcpChatQueue.delete('mcp');
  }
  const sid = mcpChatSid;
  const wasBusy = sid ? engine.isBusy(sid) : false;
  let r = false;
  if (wasBusy) {
    try { r = engine.interrupt(sid, 'kullanıcı MCP sohbet panelinden ■ ile durdurdu'); } catch {}
  }
  return { ok: true, wasBusy, interrupted: r };
});

ipcMain.handle('mcp:chat:new', async () => {
  if (!engine) return { ok: false, error: 'ajan hazır değil' };
  const sid = mcpChatSid;
  if (sid && engine.isBusy(sid)) return { ok: false, error: 'mesaj sürüyor — önce ■ ile durdur' };
  const q = mcpChatQueue.get('mcp');
  if (q) {
    clearTimeout(q.timer);
    mcpChatQueue.delete('mcp');
  }
  mcpChatSid = '';
  mcpChatFresh = true; /* sonraki oturum TAZE açılır; eski sohbet geçmişte kalır */
  return { ok: true, sessionId: '', messages: [], items: mcpChatHistory() };
});

ipcMain.handle('mcp:chat:history', async () => {
  try {
    return { ok: true, items: mcpChatHistory() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), items: [] };
  }
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
    for (let i = 0; i < Math.min(10, f.slots.length); i++) {
      const s = f.slots[i];
      /* kayıtlı anahtarlar UI'a maskeli gider */
      out.slots[i] = s && s.key ? { ...s, key: SECRET_MASK } : s || null;
    }
  }
  return out;
});

ipcMain.handle('fallout:set', (_e, cfg) => {
  const cur = settings.fallout || defaultFallout();
  const prevSlots = Array.isArray(cur.slots) ? cur.slots : [];
  const next = defaultFallout();
  next.enabled = !!(cfg && cfg.enabled);
  next.autoResume = !cfg || cfg.autoResume !== false;
  const slots = Array.isArray(cfg && cfg.slots) ? cfg.slots : [];
  for (let i = 0; i < Math.min(10, slots.length); i++) {
    const s = slots[i];
    if (!s || typeof s !== 'object' || !s.providerId || !s.model) continue;
    let key = String(s.key || '');
    /* maskeli/boş anahtar: aynı provider'ın önceki kayıtlı anahtarı korunur */
    if (key === SECRET_MASK || !key) {
      const prev = prevSlots[i];
      key = prev && prev.providerId === String(s.providerId) && prev.key ? String(prev.key) : '';
    }
    if (!key) continue;
    next.slots[i] = {
      providerId: String(s.providerId),
      providerName: String(s.providerName || s.providerId),
      model: String(s.model),
      key,
    };
  }
  settings.fallout = next;
  saveSettings();
  if (engine) engine.setFallout(next);
  const out = JSON.parse(JSON.stringify(next));
  for (const s of out.slots) if (s && s.key) s.key = SECRET_MASK;
  return out;
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
    /* BeastCode + Sandbox izin akışı CANLI güncellenir: kapalıyken hiç sorulmaz */
    if (typeof engine.setApprovals === 'function') engine.setApprovals(settings.security.approvals);
  }
  log.info('sec', `güvenlik: onay kapısı ${settings.security.approvals ? 'AÇIK' : 'KAPALI (her şey serbest)'}`);
  return { approvals: settings.security.approvals, alwaysAllow: settings.security.alwaysAllow };
});

/* Supermemory (lokal) ayarları: engine'e canlı yansıt + sağlık önbelleğini tazele */
ipcMain.handle('supermemory:set', (_e, cfg) => {
  try {
    const base = String((cfg && cfg.baseUrl) || '').trim() || 'http://localhost:6767';
    const incomingKey = String((cfg && cfg.apiKey) || '').trim();
    const prevKey = settings.supermemory && settings.supermemory.apiKey ? String(settings.supermemory.apiKey) : '';
    settings.supermemory = {
      enabled: !!(cfg && cfg.enabled),
      baseUrl: base.replace(/\/+$/, ''),
      /* maskeli anahtar geri gelirse mevcut korunur */
      apiKey: incomingKey === SECRET_MASK ? prevKey : incomingKey,
      containerTag: String((cfg && cfg.containerTag) || 'beast').trim() || 'beast',
    };
    saveSettings();
    if (engine) {
      engine.supermemory = settings.supermemory;
      engine._smUp = null;
      engine._smCheckedAt = 0;
      engine._smWarned = false;
    }
    return { ok: true, supermemory: { ...settings.supermemory, apiKey: settings.supermemory.apiKey ? SECRET_MASK : '' } };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.handle('supermemory:get', () => {
  const sm = settings.supermemory || {};
  return {
    enabled: sm.enabled !== false,
    baseUrl: sm.baseUrl || 'http://localhost:6767',
    apiKey: sm.apiKey ? SECRET_MASK : '',
    containerTag: sm.containerTag || 'beast',
    up: engine ? !!engine._smUp : null,
  };
});

/* TypeSafe (System One/Jev): anahtar masked döner; typesafe_decision aracı
   settings'ten CANLI okur (setConfig kancası) — kaydetmek yeterli. */
ipcMain.handle('typesafe:get', () => {
  const t = settings.typesafe || {};
  return { apiKey: t.apiKey ? SECRET_MASK : '', model: t.model || 'jev-latest', enabled: t.enabled !== false, set: !!t.apiKey };
});
ipcMain.handle('typesafe:set', (_e, cfg) => {
  try {
    const incomingKey = String((cfg && cfg.apiKey) || '').trim();
    const prevKey = settings.typesafe && settings.typesafe.apiKey ? String(settings.typesafe.apiKey) : '';
    const prevEnabled = !(settings.typesafe && settings.typesafe.enabled === false);
    settings.typesafe = {
      /* maskeli anahtar geri gelirse mevcut korunur */
      apiKey: incomingKey === SECRET_MASK ? prevKey : incomingKey,
      model: String((cfg && cfg.model) || 'jev-latest').trim() || 'jev-latest',
      enabled: cfg && typeof cfg.enabled === 'boolean' ? cfg.enabled : prevEnabled,
    };
    saveSettings();
    return {
      ok: true,
      typesafe: {
        apiKey: settings.typesafe.apiKey ? SECRET_MASK : '',
        model: settings.typesafe.model,
        enabled: settings.typesafe.enabled !== false,
        set: !!settings.typesafe.apiKey,
      },
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.handle('typesafe:test', async (_e, payload) => {
  try {
    const typed = String((payload && payload.apiKey) || '').trim();
    const key = !typed || typed === SECRET_MASK ? String((settings.typesafe && settings.typesafe.apiKey) || '') : typed;
    const model = String((payload && payload.model) || '').trim() || String((settings.typesafe && settings.typesafe.model) || '');
    return await typesafeMod.probe(key, model);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
  ipcMain.handle('approval:respond', (_e, { id, ok, always }) => resolveApproval(id, ok, always));
  /* opencode permission reply (BC): UI kartı üçlü cevap verir —
     'once' | 'always' | 'reject' (+ opsiyonel geri bildirim) */
  ipcMain.handle('permission:reply', (_e, payload) => {
    try {
      if (!engine || typeof engine.replyPermission !== 'function') return { ok: false, error: 'ajan hazır değil' };
      return engine.replyPermission(
        String((payload && payload.requestId) || ''),
        String((payload && payload.action) || 'once'),
        String((payload && payload.message) || '')
      );
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

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

/* #STT: sohbet mikrofonu — kaydı Duyu-small'a çevirir (webm/ogg/wav) */
ipcMain.handle('stt:transcribe', async (_e, b64, lang, priority) => {
  try {
    const buf = Buffer.from(String(b64 || '').split(',').pop() || '', 'base64');
    if (!buf.length) return { ok: false, error: 'boş ses kaydı' };
    const text = await transcribeAudio(buf, lang === 'en' || lang === 'auto' ? lang : undefined, 'audio/webm', priority === 1 ? 1 : 0);
    return text ? { ok: true, text } : { ok: false, error: 'konuşma algılanamadı' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('stt:lang:get', () => settings.sttLang || 'tr');

/* STT DURUMU: ayarlar ekranı için — TEK motor Duyu-small (yerel ONNX int8) */
ipcMain.handle('stt:status', () => {
  const s = duyu.statusSync();
  const state = duyu.readyNow() ? 'ready' : duyu.installing() ? 'loading' : s.state;
  return {
    provider: 'duyu',
    engineLabel: sttEngineLabel(),
    model: 'KaanAydinli/Duyu-small',
    pref: 'local',
    state,
    mb: s.mb,
    installed: s.installed,
  };
});

/* istenirse modeli şimdi indir/yükle (bloklamaz — arka planda) */
ipcMain.handle('stt:prefetch', () => {
  duyu.warm()
    .then(() => waLog('STT prefetch: hazır'))
    .catch((e) => waLog('STT prefetch hata: ' + String((e && e.message) || e)));
  return { ok: true, loading: true };
});

/* KURULUM SEKMESİ: gerekli bileşenlerin durum taraması */
ipcMain.handle('install:status', async () => {
  const rows = [];
  const pkgOk = (id) => { try { require.resolve(id); return true; } catch { return false; } };
  /* progress bus'tan canlı yüzde (10 dk taze ise güvenilir sayılır) */
  const pctOf = (id) => {
    const s = installPctState[id];
    return s && Date.now() - s.ts < 10 * 60 * 1000 ? s : null;
  };
  const pctFields = (id) => {
    const s = pctOf(id);
    if (!s) return {};
    return {
      pct: s.pct,
      loadedMb: s.loaded ? Math.round(s.loaded / 1048576) : undefined,
      totalMb: s.total ? Math.round(s.total / 1048576) : undefined,
    };
  };
  const scanModel = (rel) => {
    const dir = path.join(APP_DIR, 'models', ...rel.split('/'));
    let files = [];
    try {
      files = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => path.join(d.parentPath || d.path, d.name));
    } catch {}
    let bytes = 0, tmp = 0, onnx = 0, hasCfg = false;
    for (const p of files) {
      try {
        bytes += fs.statSync(p).size;
        if (/\.tmp/i.test(p)) tmp++;
        else if (/\.onnx$/i.test(p)) onnx++;
        else if (/config\.json$/i.test(p)) hasCfg = true;
      } catch {}
    }
    return { files, bytes, tmp, onnx, hasCfg };
  };

  /* 1) STT — Duyu-small (yerel ONNX, tek motor) */
  {
    const s = duyu.statusSync();
    const state = duyu.readyNow() ? 'ok' : duyu.installing() ? 'loading' : s.installed ? 'downloaded' : (s.mb ? 'partial' : 'missing');
    rows.push({
      id: 'stt',
      name: 'STT — Duyu-small (yerel, Türkçe+İngilizce)',
      state,
      detail: sttEngineLabel() + ' · ~54MB',
      mb: s.mb,
      ...(['missing', 'partial', 'loading'].includes(state) ? pctFields('stt') : {}),
    });
  }

  /* 2) Embedding modeli (hafıza semantik arama) */
  {
    const s = scanModel('Xenova/all-MiniLM-L6-v2');
    const state = s.hasCfg && s.onnx >= 1 && s.tmp === 0 ? 'ok' : (s.files.length ? 'partial' : 'missing');
    rows.push({
      id: 'emb',
      name: 'Embedding modeli — all-MiniLM-L6-v2',
      state,
      detail: 'hafıza semantik arama',
      mb: Math.round(s.bytes / 1048576),
      ...(['missing', 'partial', 'loading'].includes(state) ? pctFields('emb') : {}),
    });
  }

  /* 3) ffmpeg — ffmpeg-static eksikse sistem PATH fallback (ffmpegpath.js) */
  let ffOk = false;
  let ffNote = '';
  try {
    const fp = require('./agent/ffmpegpath');
    const st = fp.ffmpegStatus();
    ffOk = !!st.found;
    ffNote = ffOk ? (st.staticOk ? 'kurulu' : 'sistem ffmpeg kullanılıyor — kurulu') : 'bulunamadı (PATH te de yok)';
  } catch {}
  rows.push({ id: 'ffmpeg', name: 'ffmpeg — ses/video dönüşüm', state: ffOk ? 'ok' : 'missing', detail: ffNote || 'npm paketi eksik' });

  /* 4) çalışma zamanı npm paketleri */
  rows.push({ id: 'hf', name: 'Transformers.js — embedding çalışma zamanı', state: pkgOk('@huggingface/transformers') ? 'ok' : 'missing', detail: 'npm paketi (mem0 embedding)' });
  rows.push({ id: 'ort', name: 'ONNX Runtime — model motoru', state: pkgOk('onnxruntime-node') ? 'ok' : 'missing', detail: 'npm paketi' });

  /* 5) OCR */
  {
    const po = pctOf('ocr');
    const dl = pkgOk('tesseract.js') && po && po.pct < 100; // dil verisi şu an iniyor
    rows.push({
      id: 'ocr',
      name: 'OCR — Tesseract (ekran okuma)',
      state: dl ? 'loading' : (pkgOk('tesseract.js') ? 'ok' : 'missing'),
      detail: dl ? 'dil verisi iniyor — ilk OCR kullanımında' : (pkgOk('tesseract.js') ? 'kurulu — dil verisi ilk kullanımda iner' : 'npm paketi eksik'),
      ...(dl ? pctFields('ocr') : {}),
    });
  }

  /* 6) Python (opsiyonel — betikler) */
  let pyVer = '';
  for (const cmd of ['python -c "import sys;print(sys.version.split()[0])"', 'py -3 -c "import sys;print(sys.version.split()[0])"']) {
    try {
      pyVer = String(require('child_process').execSync(cmd, { timeout: 4000, stdio: 'pipe', encoding: 'utf8' })).trim();
      if (pyVer) break;
    } catch {}
  }
  if (!pyVer) {
    const ps = pctOf('python');
    if (ps && ps.pct < 100) { // gömülü python zip'i şu an iniyor
      rows.push({ id: 'python', name: 'Python — betikler / web arama', state: 'loading', detail: 'gömülü python indiriliyor', ...pctFields('python') });
    }
  }
  if (pyVer || !rows.some((r) => r.id === 'python')) {
    rows.push({ id: 'python', name: 'Python — betikler / web arama', state: pyVer ? 'ok' : 'optional', detail: pyVer ? 'v' + pyVer : 'sistemde bulunamadı — opsiyonel' });
  }

  /* 7) TTS — eMa Lightning (yerel, tek motor) */
  {
    const em = ema.status();
    const state = em.installed ? 'ok' : em.installing ? 'loading' : 'missing';
    rows.push({
      id: 'ema',
      name: 'TTS — eMa Lightning (yerel/offline, Türkçe)',
      state,
      detail: em.installed ? 'PyTorch CPU · ' + (em.python || 'python') : 'ilk kullanımda kurulur (pip: ema-lightning, ~34MB ağırlık)',
      ...(state === 'loading' ? pctFields('ema') : {}),
    });
  }

  return rows;
});

/* SQUEEZE (kendi token sıkıştırıcımız): aç/kapa + durum + istatistik */
ipcMain.handle('squeeze:toggle', (_e, on) => {
  settings.squeeze = { ...(settings.squeeze || {}), enabled: !!on };
  saveSettings();
  squeeze.setEnabled(!!on);
  return { ok: true, enabled: !!on };
});
ipcMain.handle('squeeze:status', () => ({ enabled: squeeze.isEnabled(), stats: squeeze.getStats() }));
ipcMain.handle('squeeze:reset', () => {
  squeeze.resetStats();
  return { ok: true, stats: squeeze.getStats() };
});

/* ANDROID EMÜLATÖR: kaldırıldı — mobil önizleme tunnel (telefon QR) yoluyla yapılır */

/* embedding modelini şimdi indir (mem0 arama yolu ısıtılır) */
ipcMain.handle('embed:prefetch', () => {
  try {
    const mem0 = require('./agent/mem0');
    mem0.search('beast', 'warmup')
      .then(() => waLog('embedding modeli hazır'))
      .catch(() => {});
  } catch {}
  return { ok: true, loading: true };
});
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
  /* native titleBarOverlay kaldırıldı — buton renkleri CSS değişkenleriyle
     otomatik uyar, main tarafında senkron gerekmez */
  return true;
});

/* custom pencere butonları (küçült/büyüt/kapat) — renderer'daki .win-controls */
ipcMain.handle('window:ctrl', (_e, action) => {
  if (!win || win.isDestroyed()) return { ok: false };
  try {
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === 'close') win.close(); /* close handler'ı tray'e gizleme kuralını işletir */
    else if (action === 'glass') glassSwitch(); /* CAM MODU: uygulama ↔ cam sohbet dönüşümü */
    else return { ok: false };
    return { ok: true, maximized: win.isMaximized() };
  } catch {
    return { ok: false };
  }
});

/* ---------------- cron IPC ---------------- */

function cronEmit() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('agent:event', { type: 'cron', jobs: cron.list() });
  }
}

/* Cron cevabı bekleme haritası: sid -> job. İş 'done' olunca cevap
   SAHİBİN bağlı olduğu TÜM AKTİF entegrasyonlara yansıtılır (kullanıcı
   hangi kanaldan ajanla iletişimde belli değil). Kayıtlar TTL'li —
   done/error hiç gelmezse bayat bekleme sonraki done'a yansıtılmaz. */
const cronAnswerPending = new Map();
const cronAnswerPendingAt = new Map();
const CRON_ANSWER_TTL_MS = 30 * 60 * 1000;

function cronAnswerPendingSet(sid, job) {
  cronAnswerPendingSweep();
  cronAnswerPending.set(String(sid), job);
  cronAnswerPendingAt.set(String(sid), Date.now());
}

function cronAnswerPendingDrop(sid) {
  cronAnswerPending.delete(String(sid));
  cronAnswerPendingAt.delete(String(sid));
}

/* Bayat kayıt (TTL aşımı) haritalardan temizlenir */
function cronAnswerPendingSweep() {
  const now = Date.now();
  for (const [k, at] of cronAnswerPendingAt) {
    if (now - at > CRON_ANSWER_TTL_MS) cronAnswerPendingDrop(k);
  }
}

/* Kaydı okuyup düşürür; bayat kayıt ise null döner (yansıtma yok) */
function cronAnswerPendingTake(sid) {
  const k = String(sid);
  const job = cronAnswerPending.get(k);
  const at = cronAnswerPendingAt.get(k) || 0;
  cronAnswerPendingDrop(k);
  if (!job || Date.now() - at > CRON_ANSWER_TTL_MS) return null;
  return job;
}

/* OTOMATİK YENİ SOHBET YOK: izleyici/fallout tetiklendiğinde oturum
   seçimi — kayıtlı id'nin DOSYASI hâlâ duruyorsa O, değilse EN GÜNCEL
   (meşgul olmayan) oturum kullanılır; hiç oturum yoksa (ilk kurulum) yeni
   açılır. Böylece soldaki sohbet geçmişine "+ Yeni Sohbet" olmadan hayalet
   sohbetler düşmez.
   DİKKAT: _load(id) silinmiş oturum için bile boş bir hayalet nesne
   üretip truthy döner — canlılık kontrolü MUTLAKA sessionFileAlive ile
   yapılır (ensureWa/Tg/DcSession ile aynı kural). Ayrıca meşgul oturuma
   send() mesajı DÜŞÜRÜR (false döner, cevap kaybolur) — o yüzden
   meşgul oturumlar da atlanır. */
/* Kanal (WA/TG/DC) kişi sohbetleri + kanal cron oturumları: otomatik işler
   (izleyici/fallout/proaktif) bu oturumlara ASLA enjekte edilmez. */
function channelSessionIds() {
  return chansessions.collectSessionIds(
    waChats,
    tgChats,
    dcChats,
    new Map([
      ['wa-cron', waCronSid],
      ['tg-cron', tgCronSid],
      ['dc-cron', dcCronSid],
    ])
  );
}

function reuseOrLatestSession(preferredId) {
  const sid = String(preferredId || '');
  const chan = channelSessionIds();
  if (sid && sessionFileAlive(sid) && !chan.has(sid)) {
    try {
      if (engine._load(sid) && !engine.isBusy(sid)) return sid;
    } catch {}
  }
  try {
    const list = engine.listSessions(); // updatedAt'e göre yeni→eski sıralı
    for (const v of list) {
      if (chan.has(String(v.id))) continue; /* kişi sohbetine otomatik iş düşmez */
      if (!engine.isBusy(v.id)) return String(v.id);
    }
  } catch {}
  return engine.createSession().id;
}

/* CRON TABAN OTURUMU: cron işleri hiçbir KİŞİ sohbetine/oturumuna BAĞLI DEĞİL.
   Her kanalın kendine ait ayrı cron oturumu vardır — sıra: WA → TG → DC →
   en güncel masaüstü oturumu. Cevap done olayında sahibe yansıtılır. */
function cronBaseSession() {
  try {
    if (wa && wa.connected) return ensureWaCronSession();
  } catch {}
  try {
    if (tg && tg.connected) return ensureTgCronSession();
  } catch {}
  try {
    if (dc && dc.connected) return ensureDcCronSession();
  } catch {}
  return reuseOrLatestSession('');
}

/* Yansıtma hedefleri: cron cevabı BAĞLI TÜM entegrasyonlara dağıtılır —
   WhatsApp (base) + Telegram + Discord. Her kanalın TEK oturumu vardır;
   hedef önce o oturuma bağlı sohbet, yoksa kayıtlı sahip/sahipleridir.
   Cron oturumunun KENDİ kanalına yansıtılmaz — cevabı zaten kendi normal
   akışından alır (çift gönderim olmaz). */
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
/* Cron cevabının gideceği yerler: kişi sohbetleri DEĞİL, sahip hedeflenir.
   (Cron oturumu hiçbir jid/chatId'ye bağlı değildir; ham cevap normal akıştan
   gitmez — yansıtma burada yapılır.) */
function cronMirrorTargets(cronSid) {
  const out = [];
  /* WHATSAPP: cron oturumu hiçbir kişiye bağlı değildir — cevap SAHİBE gider.
     Kişi sohbetlerine cron cevabı KARIŞMAZ. */
  try {
    if (wa && wa.connected) {
      const own = waOwnerNum();
      const jid = own ? own + '@s.whatsapp.net' : '';
      if (jid) out.push({ kind: 'wa', send: (t) => sendWaSafe(jid, t) });
    }
  } catch {}
  /* TELEGRAM: sahip kaydı hedeflenir; sahip tanımsızsa en son yazan sohbet */
  try {
    if (tg && tg.connected) {
      const ids = tgOwnerIds();
      const targets = ids.length ? ids : (tgLastActiveChatId ? [tgLastActiveChatId] : []);
      for (const id of targets) out.push({ kind: 'tg', send: (t) => sendTgSafe(id, t) });
    }
  } catch {}
  /* DISCORD: sahip kaydı hedeflenir; sahip tanımsızsa en son yazan kanal */
  try {
    if (dc && dc.connected) {
      const ids = dcOwnerIds();
      const targets = ids.length ? ids : (dcLastActiveChannelId ? [dcLastActiveChannelId] : []);
      for (const id of targets) out.push({ kind: 'dc', send: (t) => sendDcSafe(id, t) });
    }
  } catch {}
  return out;
}

/* ---------- CRON SIRASI (kuyruk) ----------
   Aynı dakikada birden fazla iş tetiklenebilir. İşler AYNI taban oturumda
   koştuğu için hepsini birden göndermek engine'in steer tamponunda birleşmeye
   ve cron cevap kaydının üst üste yazılmasına yol açıyordu. Artık işler
   sıraya girer: BİRİ bitmeden (done/error) diğeri gönderilmez; oturum
   kullanıcı turuyla meşgulse sıradaki iş bekler. */
const cronQueue = [];
let cronRunning = false;
let cronRunningSid = '';
let cronPumpTimer = null;
let cronWatchdog = null;

function cronPumpSoon(ms) {
  if (cronPumpTimer) return; // tek zamanlayıcı — üst üste birikmez
  cronPumpTimer = setTimeout(() => {
    cronPumpTimer = null;
    cronPump();
  }, ms);
}

/* Emniyet bekçisi: çalışıyor sanılan iş için done/error olayı kaçarsa
   (oturum artık meşgul değilse) kuyruğu açar; iş hâlâ koşuyorsa izler. */
function cronArmWatchdog() {
  if (cronWatchdog) clearTimeout(cronWatchdog);
  cronWatchdog = setTimeout(() => {
    cronWatchdog = null;
    if (!cronRunning) return;
    let busy = false;
    try { busy = !!cronRunningSid && engine.isBusy(cronRunningSid); } catch {}
    if (busy) { cronArmWatchdog(); return; }
    cronRunning = false;
    cronRunningSid = '';
    if (cronQueue.length) cronPumpSoon(50);
  }, 60000);
}

/* sıradaki cron işini (oturum boşsa) başlatır */
function cronPump() {
  if (cronRunning || !cronQueue.length) return;
  const job = cronQueue.shift();
  let sid = '';
  try { sid = cronBaseSession(); } catch {}
  if (!sid || !engine) {
    cronQueue.unshift(job); // oturum yok — sonra tekrar dene
    cronPumpSoon(5000);
    return;
  }
  if (engine.isBusy(sid)) {
    cronQueue.unshift(job); // kullanıcı/başka tur koşuyor — bekle
    cronPumpSoon(3000);
    return;
  }
  cronRunning = true;
  cronRunningSid = String(sid);
  cronAnswerPendingSet(sid, job);
  let sent = false;
  try {
    sent = engine.send(sid, {
      text: `[cronjob ${job.id}]\n${job.prompt}`,
    });
  } catch {}
  if (!sent) {
    /* gönderilemedi (ör. /stop kilidi) — kaydı bırakma, sıradakine geç */
    cronRunning = false;
    cronRunningSid = '';
    cronAnswerPendingDrop(sid);
    cronPumpSoon(1000);
    cronEmit();
    return;
  }
  toastNotify(
    `cronjob ${job.id}`,
    isReminderJob(job) ? 'Hatırlatma zamanı geldi' : String(job.prompt || '').slice(0, 160),
    'cron'
  );
  cronArmWatchdog();
  cronEmit();
}

/* iş turu bitti (done/error) — çalışan işi kapat, sıradakini başlat */
function cronJobFinished(sid) {
  if (cronRunning && String(sid) === cronRunningSid) {
    cronRunning = false;
    cronRunningSid = '';
  }
  if (cronQueue.length) cronPumpSoon(50); // ctrls temizlenmesini bekle
}

function cronFire(job) {
  /* OTURUMSUZ ÇALIŞTIRMA: taban oturum WA → TG → DC → masaüstü sırasıyla
     seçilir; işler kuyrukta TEK TEK koşar, cevap done olayında TÜM bağlı
     entegrasyonlara yansıtılır. */
  cronQueue.push(job);
  cronPump();
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
    toastNotify(`İzleyici: ${w.name}`, target, 'watchers');
    engine.send(sid, {
      text:
        `[IZLEYICI: ${w.name}] ${target}. ` +
        'Kullanıcıya bunu kısaca ve net biçimde haber ver; detay gerekirse http_fetch ile güncel durumu kontrol et.',
    });
  } catch {}
}

/* ---------- EMPATİ LOOP: proaktif algı/event alt sistemi ----------
   Ana sohbet motorundan bağımsız: sinyal topla → ucuz filtre modeliyle puanla →
   kompozit öncelik → değerliyse ANA modelle kısa proaktif mesaj üret →
   masaüstü + WA'ya bildir. Önemsiz olaylar yalnız depoya yazılır, rahatsız etmez. */

const empati = require('./agent/perception');
const empatiRuntime = { running: false, timer: null };

function empatiCfg() {
  return empati.mergeCfg(settings.empati || {});
}

/* EMPATİ HAFIZASI: sohbet akışını kaydet (ilgi çıkarımının ham verisi).
   - user/assistant mesajı → hafızaya yaz (konuşmanın iki yanı da kalsın)
   İlgi alanları burada MESAJ BAŞINA öğrenilmez — gece yansımasında
   (günde bir) LLM bu birikimden konu etiketleri çıkarır (nightref adım 3b).
   Beast Code/Studio iş mesajları, /komutlar ve bağlam enjeksiyonları kayda girmez. */
function empatiRememberFromEvent(ev) {
  if (!ev || ev.type !== 'message' || !ev.message || !ev.message.role) return;
  const m = ev.message;
  if (m.role !== 'user' && m.role !== 'assistant') return;
  const txt = typeof m.content === 'string' ? m.content : '';
  if (!txt.trim()) return;
  if (txt.startsWith((engine && engine.OBSERVE_MARK) || '[BAĞLAM')) return; /* sessiz bağlam — sohbet değil */
  if (txt.startsWith('🫡 *Beast proaktif:') || txt.startsWith('🫡 **Beast proaktif:')) return; /* proaktif not — döngü '[proaktif]' etiketiyle zaten hafızaya yazdı */
  if (m.role === 'user' && txt.startsWith('/')) return; /* slash komut gürültüsü */
  let bc = false;
  try {
    const s = engine && engine.cache && engine.cache.get(String(ev.sessionId || ''));
    bc = !!(s && (s.bcCode || s.bcMode));
  } catch {}
  if (bc) return; /* kod işi — ilgi alanını bulanıklaştırır */
  if (m.role === 'user') {
    empati.rememberConversation(txt, 'sohbet');
  } else {
    empati.rememberConversation(txt, 'beast');
  }
}

function empatiLog(line) {
  try { waLog('[EMPATİ] ' + line); } catch {}
}

/* tarama (filtre) modeli: sekmeden seçilmişse onu çöz; seçilmemişse ANA model */
function empatiFilterSel() {
  const fm = empatiCfg().filterModel;
  if (fm) {
    try {
      const r = engine._resolve(fm);
      if (r) return r;
    } catch {}
  }
  return engine.sel;
}

/* sinyal toplayıcılar — perception modülü saf kalır, engine/köprülerle burada konuşur */
async function empatiSignalSelf() {
  const out = [];
  try {
    const w = engine.lastWhereWasI();
    if (w && w.pendingTodos && w.pendingTodos.length) {
      out.push({
        type: 'todo',
        title: 'Yarım kalan görevler: ' + w.pendingTodos.map((t) => t.title).join(' · ').slice(0, 200),
        detail: 'oturum ' + (w.code || '') + ' · ' + w.pendingTodos.length + ' görev bekliyor',
      });
    }
  } catch {}
  return out;
}

async function empatiSignalNews() {
  /* haber konuları İlgi Alanları'ndan OTOMATİK türetilir — seçime gerek yok */
  const topics = String(empati.combinedInterests(empatiCfg()) || '')
    .split(',').map((s) => s.trim()).filter((s) => s.length > 2);
  if (!topics.length) return [];
  return empati.fetchNews(topics);
}

/* tek toplu filtre çağrısı (maliyet freni); model yok/çökerse boş → deterministik puan */
function empatiLlmFilter(prompt) {
  const sel = empatiFilterSel();
  if (!sel) return Promise.resolve('');
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), 45000);
  return require('./agent/llm')
    .chatOnce(sel, {
      messages: [
        { role: 'system', content: empati.FILTER_SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
    }, { signal: ctrl.signal })
    .then((r) => String(r.content || ''))
    .catch(() => '')
    .finally(() => clearTimeout(kill));
}

/* compose her zaman ANA model kullanır — filtre ucuz, anlamlandırma güçlü */
function empatiLlmCompose(prompt) {
  if (!engine.sel) return Promise.resolve('');
  const ctrl = new AbortController();
  const kill = setTimeout(() => ctrl.abort(), 60000);
  return require('./agent/llm')
    .chatOnce(engine.sel, {
      messages: [
        { role: 'system', content: empati.COMPOSE_SYSTEM },
        { role: 'user', content: prompt },
      ],
      temperature: 0.6,
    }, { signal: ctrl.signal })
    .then((r) => stripAiDashes(String(r.content || '').trim()).slice(0, 600))
    .catch(() => '')
    .finally(() => clearTimeout(kill));
}

/* PROAKTİF NOT → OTURUM BAĞLAMI: bildirim hangi kanala gittiyse AYNI metin
   o kanalın sohbet oturumuna asistan mesajı olarak da işlenir (yeni tur
   başlamaz). Böylece kullanıcı bildirime cevap verdiğinde model o mesajı
   KENDİSİNİN attığını bilir — aynı oturum, kesintisiz bağlam. */
const PROACTIVE_MARK = '🫡 *Beast proaktif:*';

/* bildirimin ALTINA YAZILAN KAYNAK — desktop chat + Discord için MARKDOWN
   başlık-linki: kullanıcı ham URL görmez, haber başlığına tıklayınca açılır.
   URL yoksa kaynak adı düz yazılır. TEK SATIR kuralı korunur. */
function empatiSourceLine(ev) {
  if (!ev) return '';
  const oneLine = (s) =>
    String(s || '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const ELLIPSIS = '...';
  const cap = (s, max) =>
    oneLine(s).length > max ? oneLine(s).slice(0, max - ELLIPSIS.length) + ELLIPSIS : oneLine(s);
  const url = oneLine(ev.url);
  if (/^https?:\/\//i.test(url)) {
    /* markdown linki bozmasın: başlıktaki köşeli parantezler silinir, URL'deki
       ')' kaçırılır (mdInline linki ilk ')'da keser) */
    const title =
      oneLine(ev.title || ev.source || '').replace(/[[\]]/g, ' ').replace(/\s{2,}/g, ' ').trim() || 'kaynak';
    return '🔗 [' + cap(title, 80) + '](' + url.replace(/\)/g, '%29') + ')';
  }
  const src = oneLine(ev.source);
  return src ? '🔗 kaynak: ' + cap(src, 80) : '';
}

/* WhatsApp/Telegram düz metin sürümü: bu kanallar [başlık](url) render etmez —
   link TIKLANABİLMEK İÇİN ham URL olmalı. Kısaltılan URL kırık link olur;
   o yüzden burada link tam uzunlukta tek satır gider. */
function empatiSourceLinePlain(ev) {
  if (!ev) return '';
  const oneLine = (s) =>
    String(s || '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const url = oneLine(ev.url);
  if (/^https?:\/\//i.test(url)) return '🔗 ' + url;
  const ELLIPSIS = '...';
  const cap = (s, max) =>
    oneLine(s).length > max ? oneLine(s).slice(0, max - ELLIPSIS.length) + ELLIPSIS : oneLine(s);
  const src = oneLine(ev.source);
  return src ? '🔗 kaynak: ' + cap(src, 80) : '';
}

/* WhatsApp: kullanıcı tercihi — ham URL GÖRÜNMEZ, haber başlığı gider.
   (WA düz metinde başlık-linki desteklemez; gerçek link yine de ajanın
   BAĞLAM bloğunda durur — "linki at" derse model oradan paylaşıır.) */
function empatiSourceLineWa(ev) {
  if (!ev) return '';
  const oneLine = (s) =>
    String(s || '').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const ELLIPSIS = '...';
  const cap = (s, max) =>
    oneLine(s).length > max ? oneLine(s).slice(0, max - ELLIPSIS.length) + ELLIPSIS : oneLine(s);
  const title = oneLine(ev.title || ev.source || '').trim();
  return title ? '🔗 ' + cap(title, 80) : '';
}

/* Enjeksiyon kuyruğu: oturum TUR ORTASINDAYKEN (ajan bir işle uğraşırken)
   gelen proaktif bildirimi sessizce DÜŞÜRME — eskisi tam olarak buydu:
   "bazen ajan konudan haber olmuyor". Metin kuyrukta bekler, oturumun
   işi bitince ('done'/'error') geçmişe asistan mesajı olarak yazılır;
   model bir sonraki turda "ben bu bildirimi attım" der, kullanıcı sorusuna
   hazırdır. */
const empatiInjectQueue = new Map(); // sid -> [text]
const EMPATI_INJECT_QUEUE_CAP = 20;

function empatiInjectToSession(sid, out) {
  const target = String(sid || '');
  const body = String(out || '');
  if (!target || !body.trim()) return;
  let busy = false;
  try { busy = engine.isBusy(target); } catch {}
  if (busy) {
    let q = empatiInjectQueue.get(target);
    if (!q) {
      q = [];
      empatiInjectQueue.set(target, q);
    }
    if (q.length < EMPATI_INJECT_QUEUE_CAP) {
      q.push(body);
      empatiLog(`bildirim enjeksiyonu kuyrukta (ajan tur sürüyor) sid=${target} bekleyen=${q.length}`);
    }
    return;
  }
  try { engine.injectAssistant(target, body); } catch {}
}

/* iş bitince (done/error) biriken proaktif enjeksiyonları geçmişe bas.
   'done' eventi isBusy temizlenmeden ÖNCE gelir (engine.js: ctrl delete
   finally bloğunda) — flushDesktopOnDone gibi macrotask'a ertele. */
function empatiFlushInjectsOnDone(ev) {
  if (!ev || !ev.sessionId || (ev.type !== 'done' && ev.type !== 'error')) return;
  const q = empatiInjectQueue.get(String(ev.sessionId));
  if (!q || !q.length) return;
  empatiInjectQueue.delete(String(ev.sessionId));
  setTimeout(() => {
    /* empatiInjectToSession üzerinden: arada yeni tur başladıysa yeniden kuyruğa düşer */
    for (const text of q) {
      try { empatiInjectToSession(String(ev.sessionId), text); } catch {}
    }
    empatiLog(`kuyrukta bekleyen ${q.length} proaktif bildirim geçmişe işlendi sid=${ev.sessionId}`);
  }, 250);
}

/* kanala giden metin + Beast'in İÇ bağlamı ayrıdır: kullanıcı linki silse bile
   model olayın başlığını, detayını ve linkini KENDİSİ görür — "bu neymiş?"
   sorusuna insansı cevap verebilir */
function empatiInjectText(ev, out) {
  if (!ev) return out;
  return (
    out + '\n\n[BAĞLAM — kullanıcı bu bildirimi sorarsa bununla cevapla]\n' +
    'Olay: ' + String(ev.title || '').slice(0, 200) + '\n' +
    (ev.detail ? 'Detay: ' + String(ev.detail).slice(0, 200) + '\n' : '') +
    (ev.url ? 'Link: ' + String(ev.url) + '\n' : '') +
    'Kaynak: ' + String(ev.source || '').slice(0, 80)
  );
}

/* KİŞİ BAŞINA OTURUM (Telegram): her chatId kendi oturumunda; chatId yoksa
   CRON TABAN OTURUMU döner (otomatik işler kişi sohbetlerine karışmaz). */
function ensureTgSession(chatId) {
  if (chatId == null || chatId === '') return ensureTgCronSession();
  const key = String(chatId);
  const sid = tgChats.get(key);
  if (sid && sessionFileAlive(sid)) return sid;
  const v = engine.createSession();
  tgChats.set(key, v.id);
  tgRememberSession(key, v.id);
  saveTgChats();
  return v.id;
}

/* Cron/otomatik işlerin Telegram taban oturumu: hiçbir sohbete bağlı DEĞİL */
function ensureTgCronSession() {
  if (!tgCronSid || !sessionFileAlive(tgCronSid)) {
    tgCronSid = engine.createSession().id;
    saveTgChats();
  }
  return tgCronSid;
}

/* Telegram cevap hedefi: oturuma bağlı sohbet (en son yazan öncelikli) */
function tgReplyChat(sid) {
  const s = String(sid || '');
  if (tgLastActiveChatId && String(tgChats.get(tgLastActiveChatId) || '') === s) return tgLastActiveChatId;
  for (const [c, v] of tgChats) {
    if (String(v) === s) return c;
  }
  return '';
}

/* KİŞİ BAŞINA OTURUM (Discord): her kanal kendi oturumunda; channelId yoksa
   CRON TABAN OTURUMU döner (otomatik işler kişi sohbetlerine karışmaz). */
function ensureDcSession(channelId) {
  if (channelId == null || channelId === '') return ensureDcCronSession();
  const key = String(channelId);
  const sid = dcChats.get(key);
  if (sid && sessionFileAlive(sid)) return sid;
  const v = engine.createSession();
  dcChats.set(key, v.id);
  dcRememberSession(key, v.id);
  saveDcChats();
  return v.id;
}

/* Cron/otomatik işlerin Discord taban oturumu: hiçbir kanala bağlı DEĞİL */
function ensureDcCronSession() {
  if (!dcCronSid || !sessionFileAlive(dcCronSid)) {
    dcCronSid = engine.createSession().id;
    saveDcChats();
  }
  return dcCronSid;
}

/* Discord cevap hedefi: oturuma bağlı kanal (en son yazan öncelikli) */
function dcReplyChannel(sid) {
  const s = String(sid || '');
  if (dcLastActiveChannelId && String(dcChats.get(dcLastActiveChannelId) || '') === s) return dcLastActiveChannelId;
  for (const [c, v] of dcChats) {
    if (String(v) === s) return c;
  }
  return '';
}

/* Masaüstü hedefi: kullanıcının AÇIK sohbeti önceliklidir — proaktif not
   nereye bakıyorsa oraya işlenir; meşgulse empatiInjectToSession kuyruğa alır.
   Açık sohbet bilinmiyorsa en güncel meşgul olmayan sohbet (kanal oturumları
   hariç — onlara kanal yoluyla zaten enjekte edildi); o da yoksa yeni oturum. */
function empatiDesktopSid(exclude) {
  const skip = exclude instanceof Set ? exclude : new Set();
  try {
    if (desktopActiveSid && sessionFileAlive(desktopActiveSid)) return String(desktopActiveSid);
  } catch {}
  try {
    const chan = channelSessionIds();
    for (const v of engine.listSessions()) {
      if (skip.has(String(v.id)) || chan.has(String(v.id))) continue;
      if (!engine.isBusy(v.id)) return String(v.id);
    }
  } catch {}
  return engine.createSession().id;
}

/* bildirim hedefi: sekmeden seçilen entegrasyon; seçilmemişse bağlı olanlar.
   Hiçbir entegrasyon yazılamazsa masaüstü chat UI (toast) kalır. */
function empatiNotify(text, ev) {
  const cfg = empatiCfg();
  /* desktop + Discord: başlık-linki (markdown); TG: ham URL (tıklanabilir
     olması için şart); WA: yalnız başlık (kullanıcı tercihi — ham URL yok) */
  const src = empatiSourceLine(ev);
  const srcPlain = empatiSourceLinePlain(ev);
  const srcWa = empatiSourceLineWa(ev);
  const out = PROACTIVE_MARK + '\n' + text + (src ? '\n' + src : '');
  const outPlain = PROACTIVE_MARK + '\n' + text + (srcPlain ? '\n' + srcPlain : '');
  const outWa = PROACTIVE_MARK + '\n' + text + (srcWa ? '\n' + srcWa : '');
  const inject = empatiInjectText(ev, out);
  const senders = [];
  const channelSids = new Set(); /* bu tur enjeksiyon ALAN kanal oturumları */
  const tryWa = () => {
    try {
      const own = waOwnerNum();
      if (own && wa && wa.connected) {
        const jid = own + '@s.whatsapp.net';
        const sid = ensureWaSession(jid);
        channelSids.add(String(sid));
        senders.push(() =>
          Promise.resolve(sendWaSafe(jid, outWa))
            .then(() => empatiInjectToSession(sid, inject))
            .catch(() => {})
        );
      }
    } catch {}
  };
  const tryTg = () => {
    try {
      if (tg && tg.connected) {
        for (const id of tgOwnerIds()) {
          const sid = ensureTgSession(String(id));
          channelSids.add(String(sid));
          senders.push(() =>
            Promise.resolve(sendTgSafe(id, outPlain))
              .then(() => empatiInjectToSession(sid, inject))
              .catch(() => {})
          );
        }
      }
    } catch {}
  };
  const tryDc = () => {
    try {
      if (dc && dc.connected) {
        const outDc = out.replace('🫡 *Beast proaktif:*', '🫡 **Beast proaktif:**');
        for (const id of dcOwnerIds()) {
          const sid = ensureDcSession(String(id));
          channelSids.add(String(sid));
          senders.push(() =>
            Promise.resolve(sendDcSafe(id, outDc))
              .then(() => empatiInjectToSession(sid, inject))
              .catch(() => {})
          );
        }
      }
    } catch {}
  };
  if (cfg.notifyTarget === 'whatsapp') tryWa();
  else if (cfg.notifyTarget === 'telegram') tryTg();
  else if (cfg.notifyTarget === 'discord') tryDc();
  else { tryWa(); tryTg(); tryDc(); } // auto: ekli/bağlı entegrasyonlar
  let sent = 0;
  for (const fn of senders) {
    try { fn(); sent++; } catch {}
  }
  /* MASAÜSTÜ CHAT UI: entegrasyon kullanılsa da kullanılmasa da proaktif mesaj
     sohbette MESAJ olarak görünür (asistan balonu) + toast çıkar. Ajan da
     desktop oturumu geçmişinde attığı bildirimi GÖRÜR — hangi kanala gittiğine
     bakmaksızın konudan haberdar olur. Kanal oturumlarına ise BAĞLAM'lı `inject`
     gider (kanal kullanıcısı ham BAĞLAM bloğunu görmez, ajan görür). */
  try {
    if (win && !win.isDestroyed()) {
      const dsid = String(empatiDesktopSid(channelSids) || '');
      /* aynı oturuma kanal yoluyla zaten enjekte edildiyse TEKRAR yazma */
      if (dsid && !channelSids.has(dsid)) empatiInjectToSession(dsid, out);
      win.webContents.send('agent:event', { type: 'proactive', sessionId: dsid, id: ev.id, level: ev.level, title: ev.title, text: out });
    }
  } catch {}
}

async function empatiCycle(manual) {
  if (empatiRuntime.running) return { ok: false, error: 'döngü zaten çalışıyor' };
  const cfg = empatiCfg();
  if (!cfg.enabled && !manual) return { ok: false, error: 'kapalı' };
  empatiRuntime.running = true;
  try {
    /* zaman aşımı emniyeti: sinyal/LLM takılırsa `running` bayrağı sonsuz kilitlenmesin
       (yoksa "Şimdi Tara" sürekli 'döngü zaten çalışıyor' der) */
    const r = await Promise.race([
      empati.runCycle({
        cfg,
        signals: { self: empatiSignalSelf, news: empatiSignalNews },
        llmFilter: empatiLlmFilter,
        now: new Date(),
        log: empatiLog,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('döngü zaman aşımı (2 dk)')), 120000).unref()),
    ]);
    let notified = 0;
    for (const a of r.actions) {
      let text = '';
      try { text = await empatiLlmCompose(empati.composePrompt(a.event, cfg)); } catch {}
      if (!text) text = empati.composeFallback(a.event);
      empatiNotify(text, a.event);
      empati.markNotified(a.event.id, a.level, text, cfg.cooldownMin);
      try { empati.rememberConversation('[proaktif] ' + text, 'empati'); } catch {}
      notified++;
    }
    if (notified && win && !win.isDestroyed()) {
      win.webContents.send('agent:event', { type: 'empati', notified });
    }
    return { ok: true, ...r.summary, notified };
  } finally {
    empatiRuntime.running = false;
  }
}

function empatiSchedule() {
  if (empatiRuntime.timer) clearTimeout(empatiRuntime.timer);
  empatiRuntime.timer = null;
  const cfg = empatiCfg();
  if (!cfg.enabled) return;
  empatiRuntime.timer = setTimeout(async () => {
    try { await empatiCycle(false); } catch {}
    empatiSchedule();
  }, cfg.intervalMin * 60000);
}

/* açılış + 90 sn: ilk tarama (başlangıç fırtınasını önle), sonra cfg aralığı */
function empatiKickoff() {
  setTimeout(() => {
    empatiCycle(false).catch(() => {});
    empatiSchedule();
  }, 90 * 1000);
}

ipcMain.handle('empati:get', () => ({ ...empatiCfg(), running: empatiRuntime.running, lastRunAt: empati.lastRunAt() }));
ipcMain.handle('empati:set', (_e, patch) => {
  const cfg = empati.mergeCfg({ ...empatiCfg(), ...(patch || {}) });
  settings.empati = cfg;
  saveSettings();
  empatiSchedule(); // aralık/model değişmiş olabilir
  return { ...cfg };
});
ipcMain.handle('empati:scan', async () => {
  try { return await empatiCycle(true); } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
});
ipcMain.handle('empati:events', () => empati.listEvents(80));
ipcMain.handle('empati:memory', () => empati.memSnapshot(40));
ipcMain.handle('empati:memclear', () => empati.memClear());

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
  /* UI'a anahtarlar DÜZ METİN gitmez — yalnız "kayıtlı var mı" bilgisi taşınır */
  const out = {};
  for (const [k, v] of Object.entries(map)) out[k] = String(v || '') ? SECRET_MASK : '';
  return out;
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
/* izleyici logları — ana depodan ayrı watcher-logs.json üzerinden */
ipcMain.handle('watchers:logs', () => watchers.logsAll());
ipcMain.handle('watchers:logsClear', (_e, id) => watchers.logClear(id ? String(id) : null));
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
/* Masaüstü (toast) bildirimleri aç/kapa */
ipcMain.handle('notify:get', () => ({ toast: settings.notifyToast !== false }));
ipcMain.handle('notify:set', (_e, on) => {
  settings.notifyToast = !!on;
  saveSettings();
  return { toast: settings.notifyToast };
});

/* ---------------- tarayıcı IPC ---------------- */
ipcMain.handle('browser:toggle', () => {
  /* gizli çalışan ajan paneli varsa düğme ONU GÖRÜNÜR yapar; değilse aç/kapa.
     (ajan gizleme özelliği + göz kapalıyken gizli çalışır — kullanıcı izlemek
     isterse buradan gösterir) */
  if (browser.open && !browser.visible) {
    setBrowserOpen(true, true);
    return { open: browser.open, visible: browser.visible };
  }
  setBrowserOpen(!browser.open, true);
  return { open: browser.open, visible: browser.visible };
});
/* göz ikonu: ajan tarayıcısını görünür/gizli yap — yalnızca gizleme özelliği
   (Ayarlar → Web Arama) açıkken etkilidir; özellik kapalıysa hep görünür */
ipcMain.handle('browser:shown:get', () => ({ shown: !browserHeadlessPref(), enabled: browserHideEnabled() }));
/* RENDERER AÇILIŞ SENKRONU: tarayıcı, renderer olayları dinlemeye başlamadan
   açılmış olabilir (açılışta oturum kurtarma/arka plan işi) — durum buradan
   PULL edilir; yoksa native view dock alanı ayrılmadan chat'in üzerinde kalır */
ipcMain.handle('browser:state:get', () => {
  let url = '';
  try { url = browser.view && browser.open && !browser.view.webContents.isDestroyed() ? browser.view.webContents.getURL() : ''; } catch {}
  return {
    open: browser.open,
    visible: browser.visible,
    width: browserShownWidth(browserW()),
    phone: browser.phone,
    mobile: browser.mobile,
    phoneRect: browser.mobileRect,
    device: browser.deviceKey,
    url,
  };
});
ipcMain.handle('browser:shown:set', (_e, v) => {
  if (!browserHideEnabled()) return { shown: true, enabled: false };
  settings.browserHeadless = !v;
  saveSettings();
  if (browser.open) {
    browser.visible = !!v;
    layoutBrowser();
    browserEmit({ open: true, width: browserShownWidth(browserW()) });
  }
  return { shown: !!v, enabled: true };
});
/* gizleme özelliği anahtarı: kapalıyken göz ikonu yok + tarayıcı zorla görünür */
ipcMain.handle('browser:hide:set', (_e, v) => {
  settings.browserHide = !!v;
  if (settings.browserHide) {
    /* özellik yeni açıldı → görünür başla, kullanıcı gözle istediğinde gizler */
    settings.browserHeadless = false;
  }
  saveSettings();
  if (!browserHideEnabled() && browser.open) {
    browser.visible = true;
    layoutBrowser();
    browserEmit({ open: true, width: browserShownWidth(browserW()) });
  }
  return { enabled: browserHideEnabled(), shown: !browserHeadlessPref() };
});
ipcMain.handle('browser:navigate', (_e, url) => browserNavigate(url));
ipcMain.handle('browser:ctrl', (_e, action) => {
  if (action === 'close') {
    setBrowserOpen(false);
    return { ok: true };
  }
  if (action === 'restart') return restartBrowser();
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

/* MOBİL ÖNİZLEME (telefon silueti): view cihaz ekranı boyutuna küçülür, çerçeve
   DOM'da çizilir; açıkken dev sunucu (Expo/Metro/Vite) aranır ve bulunursa
   doğrudan ona gidilir. Ajan bir dev sunucu başlattığında renderer tool
   çıktısından URL yakalayıp browserNavigate ile buraya yönlendirir. */
function setBrowserMobile(on) {
  const want = !!on;
  if (browser.mobile === want && (want ? browser.mobileRect : true)) return { ok: true, mobile: want };
  browser.mobile = want;
  settings.browserMobile = want;
  saveSettings();
  try {
    const wc = browser.view && browser.view.webContents;
    if (wc) wc.setUserAgent(want ? phoneDeviceUA() : browser.desktopUA || PHONE_UA);
  } catch {}
  if (want) setBrowserOpen(true, true); // tarayıcı kapalıysa görünür aç
  if (browser.open && win && !win.isDestroyed()) {
    layoutBrowser();
    const [w] = win.getContentSize();
    browserEmit({ open: true, width: browserShownWidth(w), mobile: browser.mobile, phoneRect: browser.mobileRect });
    if (want) {
      injectPhoneScrollCss();
      applyPhoneTouchEmulation();
    } else {
      clearPhoneTouchEmulation();
    }
  }
  if (want) {
    /* dev sunucu ara: canlı mobil uygulama önizlemesine git */
    devServerDetect()
      .then((url) => {
        if (!url || !browser.mobile || !win || win.isDestroyed()) return;
        let cur = '';
        try { cur = browser.view.webContents.getURL(); } catch {}
        if (!isDevServerUrl(cur)) browserNavigate(url).catch(() => {});
      })
      .catch(() => {});
  }
  return { ok: true, mobile: browser.mobile };
}
ipcMain.handle('browser:mobile', (_e, on) => setBrowserMobile(on));

/* CİHAZ SEÇİMİ: iPhone/Android ölçüleri — oran değişir, UA tazelenir */
function phoneDeviceUA() {
  const d = phoneDevice();
  return d.apple ? PHONE_UA_IOS : PHONE_UA;
}

function setBrowserDevice(key) {
  const k = String(key || '').trim();
  if (!PHONE_DEVICES[k]) return { ok: false, error: 'bilinmeyen cihaz' };
  if (browser.deviceKey === k) return { ok: true, device: k, mobile: browser.mobile };
  browser.deviceKey = k;
  settings.browserDevice = k;
  saveSettings();
  try {
    const wc = browser.view && browser.view.webContents;
    if (wc && browser.mobile) {
      wc.setUserAgent(phoneDeviceUA());
      let url = '';
      try { url = wc.getURL(); } catch {}
      /* UA değişimi için sayfa taze yüklenir (setBrowserPhone ile aynı mantık) */
      if (url && /^https?:/i.test(url)) wc.loadURL(url).catch(() => {});
    }
  } catch {}
  if (browser.open && win && !win.isDestroyed()) {
    layoutBrowser(); // yeni ekran oranı — siluet yeniden hizalanır
    const [w] = win.getContentSize();
    browserEmit({ open: true, width: browserShownWidth(w) });
  }
  return { ok: true, device: k, mobile: browser.mobile };
}
ipcMain.handle('browser:device', (_e, key) => setBrowserDevice(key));

async function probeDevUrl(url, timeoutMs = 1200) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function devServerDetect() {
  for (const port of DEV_PORTS) {
    const url = 'http://localhost:' + port + '/';
    /* eslint-disable-next-line no-await-in-loop */
    if (await probeDevUrl(url)) return url;
  }
  return null;
}
ipcMain.handle('devserver:detect', () => devServerDetect());

/* ALT TERMINAL PAYI: alt dock terminal açıkken view yüksekliğini kısar —
   DOM terminali native view'ın altında kalmaz */
ipcMain.handle('browser:bottomInset', (_e, px) => {
  /* terminal yüksekliği pencerenin %70'i olabildiğinden tavan 1200 */
  const v = Math.max(0, Math.min(Math.round(Number(px) || 0), 1200));
  if (browser.bottomInset === v) return { ok: true, inset: v };
  browser.bottomInset = v;
  layoutBrowser();
  return { ok: true, inset: v };
});
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

/* TERMİNAL ÇIKTI COALESCE: alt süreçten gelen data chunk'ları 80ms'de bir TEK
   'term-batch' IPC'sinde birleştirilir. Aksi halde saniyede yüzlerce IPC +
   renderer'da satır satır DOM/layout = "Yanıt vermiyor" donması. */
const TERM_BATCH_MS = 80;
const TERM_BATCH_BYTES = 48 * 1024;
const termBatches = new Map(); // id -> { timer, bytes, events: [{stream,text}] }

function termQueue(id, stream, text) {
  const key = String(id || termShellId || '');
  let b = termBatches.get(key);
  if (!b) {
    b = { timer: null, bytes: 0, events: [] };
    termBatches.set(key, b);
  }
  b.events.push({ stream, chunk: String(text) });
  b.bytes += String(text).length;
  if (b.bytes >= TERM_BATCH_BYTES) return termFlush(key); // tampon taştı — hemen boşalt
  if (!b.timer) b.timer = setTimeout(() => termFlush(key), TERM_BATCH_MS);
}

function termFlush(id) {
  const key = String(id || '');
  const b = termBatches.get(key);
  if (!b) return;
  if (b.timer) { clearTimeout(b.timer); b.timer = null; }
  termBatches.delete(key);
  if (!b.events.length) return;
  termSend({ type: 'term-batch', id: key, events: b.events });
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
        termFlush(termShellId);
        termSend({ type: 'term-out', id: termShellId, stream: 'out', chunk: '\n[beast] çıktı çok büyük — iletim durduruldu (komut sürüyor)\n' });
      }
      return;
    }
    termQueue(termShellId, 'out', String(d));
  });
  child.stderr.on('data', (d) => {
    termQueue(termShellId, 'err', String(d));
  });
  child.on('exit', () => {
    if (termChild === child) termChild = null;
  });
  /* UTF-8 kod sayfası: Türkçe karakterli klasörler/çıktılar bozulmadan akar.
     (cmd her stdin satırını bir komut işler — bu ilk satır chcp olur) */
  try { child.stdin.write('chcp 65001 > nul\r\n'); } catch {}
}

ipcMain.handle('terminal:toggle', () => {
  /* terminal artık tarayıcıyla AYNI alanı paylaşmıyor (Beast Code'da kod
     bölmesinde) — açılışı/kapanışı tarayıcıya DOKUNMAZ */
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
    termFlush(termShellId); // önceki komuttan kalan çıktı sırayı bozmasın
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
  child.stdout.on('data', (d) => termQueue(id, 'out', String(d)));
  child.stderr.on('data', (d) => termQueue(id, 'err', String(d)));
  child.on('error', (err) => {
    termFlush(id);
    termSend({ type: 'term-end', id, code: -1, error: String((err && err.message) || err) });
  });
  child.on('close', (code) => {
    termFlush(id);
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
  termFlush(termShellId);
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

/* opencode bayrak bindirme (bcCode disiplini): bcCode/bcAgent runtime
   bayrakları restart sonrası jsonl'den gelmez — her mesajda yeniden bindirilir.
   Ajan: 'plan' | 'build' | 'sandbox' (bcMode:'plan' oturumları geriye uyumlu
   plan'a düşer; Sandbox oturumları sandbox ajanına sabitlenir) */
function bcBindOc(s, folder, agent) {
  s.workspace = folder;
  s.bcCode = true;
  const known = s.bcAgent === 'plan' || s.bcAgent === 'build' || s.bcAgent === 'sandbox';
  if (agent) {
    s.bcAgent = agent;
  } else if (!known) {
    s.bcAgent = String(s.bcMode || '').toLowerCase() === 'plan' ? 'plan' : 'build';
  }
  engine.cache.set(s.id, s);
  return s;
}

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
  s.bcCode = true; /* opencode ajan sistemi: build/plan ajanları engine'de koşar */
  s.bcAgent = 'build'; /* opencode varsayılan ajanı (agent.ts:141) */
  try {
    fs.appendFileSync(
      engine._file(s.id),
      JSON.stringify({ t: 'meta2', bgOf: '', title: 'Beast Code', at: new Date().toISOString() }) + '\n'
    );
  } catch {}
  bcMarkWs(s, folder);
  engine.cache.set(s.id, s);
  bcSessions.set(folder, s.id);
  return s;
}

/* Beast Code oturumuna çalışma klasörünü işle: sohbet geçmişi listesinde
   hangi klasörde çalışıldığı görünür; oturum tekrar açılınca aynı klasöre
   bağlanır. Kayıt oturum dosyasına bcws satırı olarak YAZILIR. */
function bcMarkWs(s, folder) {
  try {
    if (s.bcWs === folder) return;
    s.bcWs = folder;
    fs.appendFileSync(engine._file(s.id), JSON.stringify({ t: 'bcws', ws: folder, at: new Date().toISOString() }) + '\n');
  } catch {}
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
  bcBindOc(s, folder);
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
  const s = bcBindOc(bcGetSession(ws), ws);
  const busy = engine.isBusy(s.id);
  if (modeM) {
    /* opencode ajan değişimi (agent.ts: plan/build primary ajanlar) — anında
       uygulanır, meşgulken de (yalnız ajan bayrağı; koşan tur çakışmaz) */
    const agent = engine.setBcAgent(s.id, modeM[1].toLowerCase() === 'plan' ? 'plan' : 'build');
    if (win && !win.isDestroyed()) {
      const body = agent === 'plan'
        ? 'PLAN AJANI (opencode plan) — salt-okur: dosyaları okur/inceler, KOD YAZMAZ; adım adım uygulama planı verir. Uygulamak için /build.'
        : 'BUILD AJANI (opencode build) — bağlamı inceler, todowrite ile planlar, uygular, doğrular.';
      win.webContents.send('agent:event', { sessionId: s.id, type: 'bc-agent', agent, body });
    }
    return { ok: true, sessionId: s.id, agent, mode: agent };
  }
  if (busy) {
    /* OPENCODE STEER: koşan tur varken mesaj kuyrukta BEKLEMEZ — engine.send
       konuşmaya ekler, koşan tur sonraki istekte görür (ana chat ile aynı) */
    engine.send(s.id, attachments.length ? { text, attachments } : text, { userAction: true });
    return { ok: true, sessionId: s.id, steered: true };
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

/* ---------------- Beast Code SOHBET GEÇMİŞİ ----------------
   Soldaki dosya panelinin alt yarısında eski Beast Code oturumları listelenir.
   Ana sohbet geçmişinden (bgTitle gizli oturumlar) ve Studio'dan TAMAMEN AYRIDIR.
   Oturuma tıklayınca panele açılır, kaldığı yerden devam edilir. */
ipcMain.handle('bc:history', async () => {
  try {
    return { ok: true, items: engine.listBcSessions(100) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), items: [] };
  }
});

function bcMsgText(m) {
  const t = Array.isArray(m && m.content)
    ? m.content.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('\n')
    : String((m && m.content) || '');
  return t.replace(/\s+/g, ' ').trim();
}

ipcMain.handle('bc:open', async (_e, payload) => {
  const id = String((payload && payload.id) || '');
  if (!engine) return { ok: false, error: 'ajan hazır değil' };
  if (!id) return { ok: false, error: 'oturum belirtilmedi' };
  let s;
  try { s = engine._load(id); } catch { return { ok: false, error: 'oturum açılamadı' }; }
  if (s.bgTitle && s.bgTitle !== 'Beast Code') return { ok: false, error: 'bu oturum Beast Code oturumu değil' };
  /* mevcut klasöre bağlan: sonraki mesajlar BU oturumda sürer */
  const ws = ideRoot();
  bcBindOc(s, ws);
  bcMarkWs(s, ws);
  engine.cache.set(s.id, s);
  bcSessions.set(ws, s.id);
  const msgs = [];
  for (const m of s.messages || []) {
    if (m.tool_calls) continue;
    const txt = bcMsgText(m);
    if (!txt) continue;
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', text: txt.slice(0, 4000) });
  }
  return {
    ok: true,
    sessionId: s.id,
    busy: !!engine.isBusy(s.id),
    agent: s.bcAgent || 'build',
    mode: s.bcAgent || 'build',
    messages: msgs.slice(-200),
  };
});

/* TEK oturum silme (soldaki geçmiş listesindeki × butonu) */
ipcMain.handle('bc:delete', async (_e, payload) => {
  const id = String((payload && payload.id) || '');
  if (!engine || !id) return { ok: false, error: 'oturum belirtilmedi' };
  let s;
  try { s = engine._load(id); } catch { return { ok: false, error: 'oturum açılamadı' }; }
  if (s.bgTitle && s.bgTitle !== 'Beast Code') return { ok: false, error: 'yalnız Beast Code oturumu silinir' };
  if (engine.isBusy(id)) return { ok: false, error: 'oturum çalışıyor — önce ■ ile durdur' };
  for (const [folder, sid] of [...bcSessions.entries()]) {
    if (String(sid) === id) bcSessions.delete(folder);
  }
  try { engine.deleteSession(id); } catch {}
  return { ok: true };
});

/* TÜM Beast Code oturumlarını sil — çalışanlar atlanır */
ipcMain.handle('bc:deleteAll', async () => {
  if (!engine) return { ok: false, error: 'ajan hazır değil' };
  let deleted = 0;
  let skipped = 0;
  for (const it of engine.listBcSessions(200)) {
    if (engine.isBusy(it.id)) { skipped++; continue; }
    for (const [folder, sid] of [...bcSessions.entries()]) {
      if (String(sid) === it.id) bcSessions.delete(folder);
    }
    try { engine.deleteSession(it.id); deleted++; } catch {}
  }
  return { ok: true, deleted, skipped };
});

/* ---------------- Beast Studio paneli (video yapma/düzenleme modu) ----------------
   Beast Code ile AYRI ve ÖZEL dünya: kendi çalışma klasörü (studioRoot), kendi
   gizli engine oturumları (klasör bazlı), kendi sohbet kuyruğu. Studio
   oturumları chat geçmişinde VE Beast Code panelinde ASLA görünmez; Beast Code
   oturumları da Studio'ya sızmaz. Ajan studio=true ile açılır → buildStudioSystem:
   klasör içeriğini video proje malzemesi olarak görür (ffmpeg/ffprobe farkında). */
const studioSessions = new Map(); /* klasör yolu → sessionId */

function studioRoot() {
  /* Studio'nun KENDİ klasörü — IDE'nin ideRoot'undan bağımsız.
     Ayar yoksa videolar klasörü (Windows Videos) makul başlangıçtır. */
  if (settings.studioRoot) return path.resolve(settings.studioRoot);
  let v = '';
  try { v = app.getPath('videos'); } catch {}
  return path.resolve(v || settings.workspace || app.getPath('home'));
}

function studioSafe(rel) {
  const root = studioRoot();
  const p = path.resolve(root, String(rel || ''));
  if (p !== root && !p.startsWith(root + path.sep)) return null;
  return p;
}

function studioGetSession(folder) {
  let sid = studioSessions.get(folder);
  if (sid) {
    try {
      const s = engine.cache.get(sid);
      if (s) return s;
    } catch {}
    studioSessions.delete(folder);
  }
  const s = engine._load(engine.createSession().id);
  s.messages = s.messages || [];
  s.bgTitle = 'Beast Studio'; /* _view.isBg → sohbet geçmişi listesinde gizli */
  s.bcCode = true; /* todo disiplini + hızlı iş kapanışı (engine) */
  s.studio = true; /* engine: buildStudioSystem — video yapma/düzenleme ajanı */
  try {
    fs.appendFileSync(
      engine._file(s.id),
      JSON.stringify({ t: 'meta2', bgOf: '', title: 'Beast Studio', at: new Date().toISOString() }) + '\n'
    );
  } catch {}
  engine.cache.set(s.id, s);
  studioSessions.set(folder, s.id);
  return s;
}

/* Studio mesaj kuyruğu: Beast Code kuyruğunun birebir karşılığı —
   ajan çalışırken mesajlar birikir, iş bitince TEK pakette gönderilir */
const ST_DEBOUNCE_MS = 900;
const stQueue = new Map(); /* klasör yolu → { timer, msgs[] } */

function stQueuePush(ws, text, attachments) {
  let q = stQueue.get(ws);
  if (!q) {
    q = { timer: null, msgs: [] };
    stQueue.set(ws, q);
  }
  q.msgs.push({
    text,
    attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined,
  });
  return q;
}

function stFlush(folder) {
  const q = stQueue.get(folder);
  if (!q || !q.msgs.length) return;
  const s = studioGetSession(folder);
  if (engine.isBusy(s.id)) return;
  let merged = '';
  let mergedAtts = null;
  for (const m of q.msgs) {
    if (m.text) merged += (merged ? '\n' : '') + m.text;
    if (!mergedAtts && Array.isArray(m.attachments) && m.attachments.length) mergedAtts = m.attachments;
  }
  if (!merged.trim() && !mergedAtts) {
    stQueue.delete(folder);
    clearTimeout(q.timer);
    return;
  }
  s.workspace = folder;
  s.bcCode = true;
  s.studio = true;
  engine.cache.set(s.id, s);
  const payload = mergedAtts ? { text: merged, attachments: mergedAtts } : merged;
  if (engine.send(s.id, payload, { userAction: true })) {
    stQueue.delete(folder);
    clearTimeout(q.timer);
  } else {
    q.retries = (q.retries || 0) + 1;
    if (q.retries > 5) {
      stQueue.delete(folder);
      clearTimeout(q.timer);
      try {
        if (win && !win.isDestroyed()) {
          win.webContents.send('agent:event', { sessionId: s.id, type: 'error', error: 'Beast Studio mesajı gönderilemedi — panele tekrar yaz' });
        }
      } catch {}
      return;
    }
    setTimeout(() => { try { stFlush(folder); } catch {} }, 800);
  }
}

function stFlushOnDone(ev) {
  if (!ev || (ev.type !== 'done' && ev.type !== 'error') || !ev.sessionId) return;
  for (const [folder, sid] of studioSessions) {
    if (String(sid) === String(ev.sessionId) && stQueue.has(folder)) {
      setTimeout(() => { try { stFlush(folder); } catch {} }, 150);
    }
  }
}

ipcMain.handle('studio:send', async (_e, payload) => {
  const text = String((payload && payload.msg) || '').trim();
  const attachments = Array.isArray(payload && payload.attachments) ? payload.attachments : [];
  if (!text && !attachments.length) return { ok: false, error: 'boş mesaj' };
  if (!engine) return { ok: false, error: 'ajan hazır değil' };
  const ws = studioRoot();
  const modeM = /^\/(plan|build|auto)\b/i.exec(text);

  if (!engine.publicState().hasModel) return { ok: false, error: 'model yok — Ayarlar → Provider sekmesinden ekle' };
  const s = studioGetSession(ws);
  s.workspace = ws;
  s.bcCode = true;
  s.studio = true;
  engine.cache.set(s.id, s);
  const busy = engine.isBusy(s.id);
  if (modeM) {
    s.bcMode = modeM[1].toLowerCase();
    if (win && !win.isDestroyed()) {
      const body = modeM[1].toLowerCase() === 'plan'
        ? 'PLAN MODU — malzemeyi inceler (list_dir/ffprobe), KOMUT ÇALIŞTIRMAZ; adım adım montaj planı verir.'
        : modeM[1].toLowerCase() === 'build'
          ? 'BUILD MODU — son montaj planını UYGULAR: ffmpeg işlerini çalıştırır, çıktıları doğrular.'
          : 'OTOMATİK MOD — önce kısa plan, sonra uygulama + doğrulama.';
      win.webContents.send('agent:event', { sessionId: s.id, type: 'st-mode', mode: s.bcMode, body });
    }
    return { ok: true, sessionId: s.id, mode: s.bcMode };
  }
  if (busy) {
    /* OPENCODE STEER: koşan tur varken mesaj kuyrukta beklemez — konuşmaya eklenir */
    engine.send(s.id, attachments.length ? { text, attachments } : text, { userAction: true });
    return { ok: true, sessionId: s.id, steered: true };
  }
  const q = stQueuePush(ws, text, attachments);
  clearTimeout(q.timer);
  q.timer = setTimeout(() => { try { stFlush(ws); } catch {} }, ST_DEBOUNCE_MS);
  return { ok: true, sessionId: s.id, pending: true };
});

ipcMain.handle('studio:stop', async () => {
  const ws = studioRoot();
  const sid = studioSessions.get(ws);
  const q = stQueue.get(ws);
  if (q) {
    clearTimeout(q.timer);
    stQueue.delete(ws);
  }
  const wasBusy = sid ? engine.isBusy(sid) : false;
  let r = false;
  if (wasBusy) {
    try { r = engine.interrupt(sid, 'kullanıcı Beast Studio panelinden ■ ile durdurdu'); } catch {}
  }
  return { ok: true, wasBusy, interrupted: r };
});

ipcMain.handle('studio:new', async () => {
  const ws = studioRoot();
  const sid = studioSessions.get(ws);
  if (sid && engine.isBusy(sid)) return { ok: false, error: 'mesaj sürüyor — önce ■ ile durdur' };
  const q = stQueue.get(ws);
  if (q) {
    clearTimeout(q.timer);
    stQueue.delete(ws);
  }
  if (sid) {
    try { engine.deleteSession(sid); } catch {}
    studioSessions.delete(ws);
  }
  return { ok: true };
});

ipcMain.handle('studio:setroot', async () => {
  try {
    const r = await dialog.showOpenDialog({
      title: 'Beast Studio klasörü seç — videolar ve malzemeler bu klasörde',
      defaultPath: studioRoot(),
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    settings.studioRoot = r.filePaths[0];
    saveSettings();
    studioWatchStart();
    return { ok: true, root: settings.studioRoot };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('studio:tree', (_e, rel) => {
  const p = studioSafe(rel);
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
    return { ok: true, workspace: studioRoot(), entries };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* Studio video seçici: video bölümündeki "Aç" düğmesi — medya dosyası seçilir,
   yol düz döner (renderer file:// ile oynatır) */
ipcMain.handle('studio:pickvideo', async () => {
  try {
    const r = await dialog.showOpenDialog({
      title: 'Video/ses dosyası seç',
      defaultPath: studioRoot(),
      properties: ['openFile'],
      filters: [
        { name: 'Medya', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'mpg', 'mpeg', 'wmv', 'flv', '3gp', 'ogv', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'] },
        { name: 'Tüm dosyalar', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, path: r.filePaths[0] };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* Studio ağaç canlı izleme: IDE izleyicisinin karşılığı — studioRoot kökü
   izlenir, değişim 'ide-tree-changed' ile düşer (renderFileTree moduna göre
   doğru ağacı tazeler). ffmpeg çıktısı da anında ağaca düşer. */
let studioWatcher = null;
let studioWatchTimer = null;
let studioWatchRoot = '';
function studioWatchStart() {
  const root = studioRoot();
  if (studioWatcher && studioWatchRoot === root) return;
  studioWatchStop();
  if (root === app.getPath('home')) return;
  try { fs.accessSync(root); } catch { return; }
  studioWatchRoot = root;
  try {
    studioWatcher = fs.watch(root, { recursive: true }, (_evType, fname) => {
      const f = String(fname || '').replace(/\\/g, '/');
      if (/^(node_modules|\.git|dist)(\/|$)/i.test(f)) return;
      if (studioWatchTimer) return;
      studioWatchTimer = setTimeout(() => {
        studioWatchTimer = null;
        try {
          if (win && !win.isDestroyed()) {
            win.webContents.send('agent:event', { type: 'ide-tree-changed' });
          }
        } catch {}
      }, 500);
    });
    studioWatcher.on('error', () => {
      studioWatchStop();
      setTimeout(() => { try { studioWatchStart(); } catch {} }, 3000);
    });
  } catch {}
}
function studioWatchStop() {
  if (studioWatcher) { try { studioWatcher.close(); } catch {} }
  studioWatcher = null;
  studioWatchRoot = '';
  if (studioWatchTimer) { clearTimeout(studioWatchTimer); studioWatchTimer = null; }
}



/* ENTEGRASYON BİLDİRİMİ (tool adımları): bağlı TÜM kanallara (WhatsApp/
   Telegram/Discord) düşer. Tool botu yazım/doğrulama raporları ve araç
   yayın duyuruları buradan gider. */
function integrationBroadcast(text) {
  const body = String(text || '').trim();
  if (!body) return;
  try {
    if (wa && wa.connected) {
      const own = waOwnerNum();
      if (own) Promise.resolve(sendWaSafe(own + '@s.whatsapp.net', body)).catch(() => {});
    }
  } catch {}
  try {
    if (tg && tg.connected) for (const id of tgOwnerIds()) Promise.resolve(sendTgSafe(id, body)).catch(() => {});
  } catch {}
  try {
    if (dc && dc.connected) for (const id of dcOwnerIds()) Promise.resolve(sendDcSafe(id, body)).catch(() => {});
  } catch {}
}

/* ---------- AJAN İLK MESAJI (channel_send) ----------
   Allow listteki kişilere WhatsApp/Telegram/Discord'dan SEN İLK MESAJI atar;
   karşıdan mesaj gelmesini beklemez. Güvenlik: yalnız allow listteki kişiler
   hedeflenir; müşteri botu (non-admin) yalnız KENDİ bot_id'sine bağlı
   kişilere yazabilir. */
async function channelSendFromAgent(input) {
  const a = input || {};
  const body = stripAiDashes(String(a.text || '').trim()).slice(0, 4000);
  if (!body) return { ok: false, error: 'text gerekli' };
  const want = String(a.channel || 'auto').toLowerCase();
  const q = String(a.to || '').trim();
  if (!q) return { ok: false, error: 'to gerekli (isim, numara, ID, @kullanıcı adı, "sahip" ya da "all")' };
  const ql = q.toLowerCase();
  const isAll = ['all', 'herkes', 'hepsi', 'tümü', 'tumu', 'everyone'].includes(ql);
  const isOwner = ['sahip', 'owner', 'patron'].includes(ql);

  /* oturumun botu: müşteri botuysa hedef kısıtı (izolasyon) */
  let botId = '';
  try {
    const s = engine.cache.get(String(a.sessionId || '')) || engine._load(String(a.sessionId || ''));
    botId = String((s && s.botId) || '');
  } catch {}
  const bot = botId ? bots.get(botId) : null;
  const unrestricted = !bot || !!bot.admin;
  const botOk = (e) => unrestricted || String((e && typeof e === 'object' && e.bot_id) || '') === botId;

  const targets = [];
  const notes = [];
  const known = [];

  /* WHATSAPP */
  if (want === 'auto' || want === 'whatsapp' || want === 'wa') {
    if (wa && wa.connected) {
      const own = waOwnerNum();
      const qd = q.replace(/\D/g, '');
      for (const e of settings.waAllow || []) {
        if (e === '*') continue;
        if (!botOk(e)) continue;
        const pn = waEntryDigits(e);
        if (!pn) continue;
        const name = typeof e === 'object' ? String(e.name || '') : '';
        if (name) known.push(name + ' (whatsapp)');
        const hit =
          isAll ||
          (isOwner && own && pn === own) ||
          (qd.length >= 6 && (pn === qd || pn.endsWith(qd))) ||
          (name && name.toLowerCase().includes(ql));
        if (hit) targets.push({ channel: 'whatsapp', id: pn + '@s.whatsapp.net', label: name || pn });
      }
    } else if (want !== 'auto') notes.push('whatsapp bağlı değil');
  }

  /* TELEGRAM */
  if (want === 'auto' || want === 'telegram' || want === 'tg') {
    if (tg && tg.connected) {
      const owners = tgOwnerIds();
      for (const e of settings.tgAllow || []) {
        if (e === '*') continue;
        if (!botOk(e)) continue;
        const id = typeof e === 'string' ? e.trim() : String((e && e.id) || '').trim();
        if (!id || id === '*') continue;
        const name = typeof e === 'object' ? String(e.name || '') : '';
        const owner = typeof e === 'object' && !!e.owner;
        if (name) known.push(name + ' (telegram)');
        const hit =
          isAll ||
          (isOwner && owner && owners.includes(id)) ||
          id === q ||
          id.toLowerCase() === ql ||
          (name && name.toLowerCase().includes(ql));
        if (hit) targets.push({ channel: 'telegram', id, label: name || id });
      }
    } else if (want !== 'auto') notes.push('telegram bağlı değil');
  }

  /* DISCORD */
  if (want === 'auto' || want === 'discord' || want === 'dc') {
    if (dc && dc.connected) {
      const owners = dcOwnerIds();
      for (const e of settings.dcAllow || []) {
        if (e === '*') continue;
        if (!botOk(e)) continue;
        const id = typeof e === 'string' ? e.trim() : String((e && e.id) || '').trim();
        if (!id || id === '*') continue;
        const name = typeof e === 'object' ? String(e.name || '') : '';
        const owner = typeof e === 'object' && !!e.owner;
        if (name) known.push(name + ' (discord)');
        const hit =
          isAll ||
          (isOwner && owner && owners.includes(id)) ||
          id === q ||
          id.toLowerCase() === ql ||
          (name && name.toLowerCase().includes(ql));
        if (hit) targets.push({ channel: 'discord', id, label: name || id });
      }
    } else if (want !== 'auto') notes.push('discord bağlı değil');
  }

  if (!targets.length) {
    return {
      ok: false,
      error:
        'allow listte eşleşen hedef yok: "' + q + '"' +
        (notes.length ? ' (' + notes.join('; ') + ')' : '') +
        (known.length ? ' — listedekiler: ' + [...new Set(known)].slice(0, 10).join(', ') : ''),
    };
  }
  /* aynı hedefe çift gönderim olmasın */
  const uniq = [];
  const seen = new Set();
  for (const t of targets) {
    const k = t.channel + '|' + t.id;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(t);
  }
  const sent = [];
  const failed = [];
  for (const t of uniq) {
    let ok = false;
    try {
      if (t.channel === 'whatsapp') ok = await sendWaSafe(t.id, body);
      else if (t.channel === 'telegram') ok = await sendTgSafe(t.id, body);
      else if (t.channel === 'discord') ok = await sendDcSafe(t.id, body);
    } catch {}
    if (ok) sent.push({ channel: t.channel, to: t.label });
    else failed.push({ channel: t.channel, to: t.label, error: 'gönderilemedi (bağlantı yok ya da kişi bota izin vermemiş olabilir)' });
  }
  return {
    ok: sent.length > 0,
    sent,
    failed,
    ...(notes.length ? { notes } : {}),
    note: sent.length
      ? 'İlk mesaj gönderildi: ' + sent.map((x) => x.to + ' (' + x.channel + ')').join(', ')
      : 'Hiçbir hedefe gönderilemedi' + (notes.length ? ' — ' + notes.join('; ') : ''),
  };
}



/* düşünme (reasoning) seviyesi */
ipcMain.handle('think:set', (_e, v) => {
  setThinkLevel(v);
  return engine.publicState();
});

/* ---------- PANO KÖPRÜSÜ (uygulama geneli sağ tık menüsü) ----------
   Chromium rendererdaki execCommand('paste') güvenilir değil; Kes/Kopyala/
   Yapıştır'ı pano köprüsüyle MANUEL yapıyoruz (imleç konumunda ekleme). */
ipcMain.handle('clip:read', () => {
  try { return clipboard.readText(); } catch { return ''; }
});
ipcMain.handle('clip:write', (_e, t) => {
  try { clipboard.writeText(String(t ?? '')); return { ok: true }; } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
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

/* opencode disiplini: editör TÜM kod altyapısını açar — web-only değil.
   İkili (binary) koruması uzantı listesiyle değil, okuma anındaki NUL-byte
   sniffing ile yapılır (ide:read). Liste yalnız bilinen metin türlerini
   hızlandırır; bilinmeyen uzantılar da denenir. */
const IDE_TEXT_EXT = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.mjs', '.cjs', '.ts',
  '.tsx', '.jsx', '.mts', '.cts', '.json', '.jsonc', '.json5', '.md', '.mdx', '.txt',
  '.csv', '.tsv', '.log', '.py', '.pyi', '.pyw', '.ps1', '.psm1', '.bat', '.cmd',
  '.sh', '.bash', '.zsh', '.yaml', '.yml', '.toml', '.xml', '.ini', '.cfg', '.conf',
  '.env', '.properties', '.svg', '.gitignore', '.gitattributes', '.editorconfig',
  '.npmrc', '.nvmrc', '.babelrc', '.prettierrc', '.eslintrc', '.go', '.mod', '.sum',
  '.rs', '.java', '.kt', '.kts', '.swift', '.rb', '.erb', '.php', '.cs', '.csproj',
  '.sln', '.vb', '.fs', '.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cxx', '.hxx',
  '.m', '.mm', '.sql', '.prisma', '.graphql', '.gql', '.proto', '.vue', '.svelte',
  '.astro', '.lua', '.pl', '.pm', '.r', '.R', '.jl', '.dart', '.scala', '.groovy',
  '.gradle', '.cmake', '.mk', '.make', '.dockerfile', '.terraform', '.tf', '.hcl',
  '.asm', '.s', '.vbs', '.reg', '.htaccess', '.lock', '.patch', '.diff', '.ipynb',
]);
const IDE_BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tiff',
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.mpg', '.mpeg', '.wmv', '.flv',
  '.3gp', '.ogv', '.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus', '.wma',
  '.zip', '.7z', '.rar', '.gz', '.tar', '.bz2', '.xz', '.exe', '.dll', '.so',
  '.dylib', '.bin', '.dat', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt',
  '.pptx', '.ttf', '.otf', '.woff', '.woff2', '.eot', '.db', '.sqlite', '.pyc',
  '.class', '.jar', '.wasm', '.psd', '.ai', '.prproj', '.aep', '.fcpxml',
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
    /* klasör değişti: eski klasörün dev server'ı bayat — kill + unut */
    try {
      if (bcLastServerUrl) {
        bcKillServer(bcLastServerUrl);
        bcLastServerUrl = '';
        bcLastServerRoot = '';
      }
    } catch {}
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
  if (ext && IDE_BINARY_EXT.has(ext)) return { ok: false, error: 'ikili (binary) dosya — düzenlenemez' };
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
  if (ext && IDE_BINARY_EXT.has(ext)) return { ok: false, error: 'ikili (binary) dosya — yazılamaz' };
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

/* Studio silme: IDE kökünden BAĞIMSIZ studioRoot üzerinde çalışır */
ipcMain.handle('studio:delete', async (_e, rel) => {
  const p = studioSafe(rel);
  if (!p || p === studioRoot()) return { ok: false, error: 'geçersiz yol' };
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
/* ---------- BEAST SANDBOX: GitHub repolarını indir & içinde çalış ----------
   Her repo KENDİ klasöründe (~/Beast-Sandbox/<ad>) ve KENDİ gizli oturumunda
   koşar (klasör bazlı, bcCode disiplinli — Beast Code motorunun aynısı; ajanın
   run_command/read/write araçları repo klasöründe çalışır). Ana sohbet VE
   Code/Studio panellerinden tamamen ayrıdır; ana chat solda yerinde kalır. */
const sbSessions = new Map(); /* klasör → sessionId */
let sbLastFolder = ''; /* panelde seçilen / son indirilen repo — ajan araçları boş repo alanında bunu kullanır */
const SB_DEBOUNCE_MS = 900;
const sbQueue = new Map(); /* klasör → { timer, msgs[] } */

function sandboxRoot() {
  const dir = path.join(app.getPath('home'), 'Beast-Sandbox');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function sbSessionFile() {
  return path.join(beastDir(), 'sandbox-sessions.json');
}

let sbMapLoaded = false;
function sbLoadMap() {
  if (sbMapLoaded) return;
  sbMapLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(sbSessionFile(), 'utf8'));
    for (const [k, v] of Object.entries(raw || {})) {
      if (k && typeof v === 'string') sbSessions.set(k, v);
    }
  } catch {}
}

function sbSaveMap() {
  try {
    fs.writeFileSync(sbSessionFile(), JSON.stringify(Object.fromEntries(sbSessions), null, 2));
  } catch {}
}

function sandboxGetSession(folder) {
  sbLoadMap();
  let sid = sbSessions.get(folder);
  if (sid) {
    try {
      const s = engine.cache.get(sid) || engine._load(sid);
      if (s) return s;
    } catch {}
    sbSessions.delete(folder);
  }
  const s = engine._load(engine.createSession().id);
  s.messages = s.messages || [];
  s.bgTitle = 'Beast Sandbox'; /* _view.isBg → sohbet geçmişinde gizli */
  s.bcCode = true; /* opencode ajan sistemi: sandbox ajanı engine'de koşar */
  s.sbSandbox = true; /* engine: 'sandbox' ajanı çözümlemesi */
  s.bcAgent = 'sandbox'; /* opencode custom-agent: repo disiplini + panel_run */
  try {
    fs.appendFileSync(
      engine._file(s.id),
      JSON.stringify({ t: 'meta2', bgOf: '', title: 'Beast Sandbox', at: new Date().toISOString() }) + '\n'
    );
  } catch {}
  bcMarkWs(s, folder); /* klasör bağı oturum dosyasına yazılır */
  engine.cache.set(s.id, s);
  sbSessions.set(folder, s.id);
  sbSaveMap();
  return s;
}

function sbQueuePush(ws, text, attachments) {
  let q = sbQueue.get(ws);
  if (!q) {
    q = { timer: null, msgs: [] };
    sbQueue.set(ws, q);
  }
  q.msgs.push({
    text,
    attachments: Array.isArray(attachments) && attachments.length ? attachments : undefined,
  });
  return q;
}

function sbFlush(folder) {
  const q = sbQueue.get(folder);
  if (!q || !q.msgs.length) return;
  const s = sandboxGetSession(folder);
  if (engine.isBusy(s.id)) return; /* steer sistemine rağmen kuyruğu koru */
  let merged = '';
  let mergedAtts = null;
  for (const m of q.msgs) {
    if (m.text) merged += (merged ? '\n' : '') + m.text;
    if (!mergedAtts && Array.isArray(m.attachments) && m.attachments.length) mergedAtts = m.attachments;
  }
  if (!merged.trim() && !mergedAtts) {
    sbQueue.delete(folder);
    clearTimeout(q.timer);
    return;
  }
  /* opencode mantığı: Sandbox da ajan sistemiyle koşar — 'sandbox' ajanı
     (repo disiplini + panel_run izni, opencode/agents.js'te tanımlı) */
  s.sbSandbox = true; /* engine: sandbox ajanı çözümlemesi + ÇALIŞTIR paneli köprüsü */
  bcBindOc(s, folder, 'sandbox');
  const payload = mergedAtts ? { text: merged, attachments: mergedAtts } : merged;
  engine.send(s.id, payload, { userAction: true });
  sbQueue.delete(folder);
  clearTimeout(q.timer);
}

function sbFlushOnDone(ev) {
  if (!ev || (ev.type !== 'done' && ev.type !== 'error') || !ev.sessionId) return;
  for (const [folder, sid] of sbSessions) {
    if (String(sid) === String(ev.sessionId) && sbQueue.has(folder)) {
      setTimeout(() => { try { sbFlush(folder); } catch {} }, 150);
    }
  }
}

/* repo adresten (url | owner/repo) normalize et */
function sbRepoFromInput(input) {
  let s = String(input || '').trim().replace(/\.git$/, '');
  if (!s) return null;
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i.exec(s);
  if (m) return { url: 'https://github.com/' + m[1] + '/' + m[2] + '.git', name: m[2] };
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) {
    const parts = s.split('/');
    return { url: 'https://github.com/' + parts[0] + '/' + parts[1] + '.git', name: parts[1] };
  }
  return null;
}

/* repo adres/klasör çözümleyici: hem panel hem ajan araçları (sandbox_repo)
   kullanır — tam yol, klasör adı, owner/repo ya da boş ("son repo") kabul eder */
function sbResolveFolder(input) {
  const root = sandboxRoot();
  const s = String(input || '').trim();
  if (!s) return sbLastFolder;
  try {
    if (fs.existsSync(s) && fs.statSync(s).isDirectory()) return path.resolve(s);
    const direct = path.join(root, s);
    if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
    const name = s.toLowerCase().replace(/[\\/]+$/, '').split(/[\\/]/).pop().replace(/\.git$/i, '');
    let partial = '';
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const n = e.name.toLowerCase();
      if (n === name) return path.join(root, e.name);
      if (!partial && n.startsWith(name + '-')) partial = path.join(root, e.name);
    }
    if (partial) return partial;
  } catch {}
  return sbLastFolder;
}

ipcMain.handle('sandbox:list', async () => {
  const root = sandboxRoot();
  const items = [];
  try {
    sbLoadMap();
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const folder = path.join(root, e.name);
      let sid = '';
      let busy = false;
      const known = sbSessions.get(folder);
      if (known) {
        sid = String(known);
        try { busy = engine.isBusy(known); } catch {}
      }
      const slot = sbProcs.get(folder);
      items.push({ name: e.name, folder, sid, busy, running: !!(slot && slot.proc), kind: slot ? slot.kind : '' });
    }
  } catch {}
  return { ok: true, root, items };
});

/* klonlama çekirdeği: hem Sandbox paneli IPC'si hem de ajanın sandbox_repo
   aracı buradan geçer (engine.sbCloneHook) */
function sbCloneRepo(input) {
  const repo = sbRepoFromInput(input);
  if (!repo) return Promise.resolve({ ok: false, error: 'github.com/owner/repo, owner/repo ya da tam .git adresi gir' });
  const root = sandboxRoot();
  const base = String(repo.name || 'repo').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'repo';
  let dest = path.join(root, base);
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(root, base + '-' + n++);
  const finalName = path.basename(dest);
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    let settled = false;
    let lastPct = -1;
    let lastEmit = 0;
    let errText = '';
    /* git ilerlemeyi stderr'a \r ile AYNI satıra yazar (Receiving objects: %34 …)
       — her karede yüzde yakalanır, panele canlı akar */
    const onChunk = (buf) => {
      const txt = String(buf);
      errText += txt;
      const frames = txt.split(/\r/);
      const cur = (frames[frames.length - 1] || '').trim();
      const m = /(\d{1,3})%/.exec(cur);
      const pct = m ? Math.min(99, Number(m[1])) : null;
      const now = Date.now();
      if (cur && (pct !== null ? pct !== lastPct : now - lastEmit > 400)) {
        lastPct = pct != null ? pct : lastPct;
        lastEmit = now;
        try {
          if (win && !win.isDestroyed()) {
            win.webContents.send('agent:event', { type: 'sb-clone', pct, text: cur.slice(0, 90) });
          }
        } catch {}
      }
    };
    let proc;
    try {
      proc = spawn('git', ['clone', '--progress', repo.url, dest], { windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: 'git başlatılamadı: ' + String((e && e.message) || e) });
    }
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', onChunk);
    const done = (err) => {
      if (settled) return;
      settled = true;
      try {
        if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'sb-clone', pct: null, done: !err });
      } catch {}
      if (err) {
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
        const estr = errText || String((err && err.message) || err);
        const msg = err && err.code === 'ENOENT'
          ? 'git kurulu değil — https://git-scm.com adresinden kur'
          : /not found|does not exist|Could not/i.test(estr)
            ? 'repo bulunamadı ya da erişilemedi (gizli repo mu?)'
            : /Authentication|403|Permission/i.test(estr)
              ? 'erişim reddedildi (gizli repo ya da ağ sorunu)'
              : (estr.split('\n').filter((l) => l.trim()).pop() || 'klonlama başarısız').slice(0, 200);
        resolve({ ok: false, error: msg });
        return;
      }
      log.info('main', 'sandbox: klonlandı ' + repo.url + ' → ' + finalName);
      sbLastFolder = dest;
      resolve({ ok: true, name: finalName, folder: dest });
    };
    proc.on('error', done);
    proc.on('close', (code) => done(code === 0 ? null : { code }));
    /* güvenlik tavanı: 10 dk */
    setTimeout(() => {
      if (!settled) {
        try { proc.kill(); } catch {}
        done(new Error('zaman aşımı'));
      }
    }, 600000);
  });
}

ipcMain.handle('sandbox:clone', async (_e, input) => sbCloneRepo(input));

ipcMain.handle('sandbox:send', async (_e, payload) => {
  const text = String((payload && payload.msg) || '').trim();
  const attachments = Array.isArray(payload && payload.attachments) ? payload.attachments : [];
  const folder = String((payload && payload.folder) || '');
  if (!folder) return { ok: false, error: 'repo seçilmedi' };
  if (!folder.startsWith(sandboxRoot() + path.sep)) return { ok: false, error: 'geçersiz klasör' };
  if (!text && !attachments.length) return { ok: false, error: 'boş mesaj' };
  if (!engine) return { ok: false, error: 'ajan hazır değil' };
  if (!engine.publicState().hasModel) return { ok: false, error: 'model yok — Ayarlar → Provider sekmesinden ekle' };
  const s = sandboxGetSession(folder);
  s.workspace = folder;
  s.bcCode = true;
  s.sbSandbox = true;
  engine.cache.set(s.id, s);
  const busy = engine.isBusy(s.id);
  const q = sbQueuePush(folder, text, attachments);
  if (busy) return { ok: true, queued: true, count: q.msgs.length, sessionId: s.id };
  clearTimeout(q.timer);
  q.timer = setTimeout(() => { try { sbFlush(folder); } catch {} }, SB_DEBOUNCE_MS);
  return { ok: true, sessionId: s.id, pending: true };
});

ipcMain.handle('sandbox:stop', async (_e, payload) => {
  const folder = String((payload && payload.folder) || '');
  sbLoadMap();
  const sid = sbSessions.get(folder);
  const q = sbQueue.get(folder);
  if (q) {
    clearTimeout(q.timer);
    sbQueue.delete(folder);
  }
  const wasBusy = sid ? engine.isBusy(sid) : false;
  let r = false;
  if (wasBusy) {
    try { r = engine.interrupt(sid, 'kullanıcı Sandbox panelinden ■ ile durdurdu'); } catch {}
  }
  return { ok: true, wasBusy, interrupted: r };
});

ipcMain.handle('sandbox:new', async (_e, payload) => {
  const folder = String((payload && payload.folder) || '');
  sbLoadMap();
  const sid = sbSessions.get(folder);
  if (sid && engine.isBusy(sid)) return { ok: false, error: 'mesaj sürüyor — önce ■ ile durdur' };
  const q = sbQueue.get(folder);
  if (q) {
    clearTimeout(q.timer);
    sbQueue.delete(folder);
  }
  if (sid) {
    try { engine.deleteSession(sid); } catch {}
    sbSessions.delete(folder);
    sbSaveMap();
  }
  return { ok: true };
});

/* repo klasörünü diskten sil (oturum kaydıyla birlikte temizlenir) */
ipcMain.handle('sandbox:remove', async (_e, payload) => {
  const folder = String((payload && payload.folder) || '');
  if (!folder.startsWith(sandboxRoot() + path.sep)) return { ok: false, error: 'geçersiz klasör' };
  sbLoadMap();
  const sid = sbSessions.get(folder);
  if (sid && engine.isBusy(sid)) return { ok: false, error: 'repo çalışıyor — önce ■ ile durdur' };
  const slot = sbProcs.get(folder);
  if (slot && slot.proc) return { ok: false, error: 'repoda süreç çalışıyor — önce ■ Durdur' };
  try { fs.rmSync(folder, { recursive: true, force: true }); } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (sid) {
    try { engine.deleteSession(sid); } catch {}
    sbSessions.delete(folder);
    sbSaveMap();
  }
  sbProcs.delete(folder);
  sbLoadCfg();
  if (sbCfg[folder]) {
    delete sbCfg[folder];
    sbSaveCfg();
  }
  try { fs.rmSync(path.join(beastDir(), 'sandbox-installed', path.basename(folder)), { force: true }); } catch {}
  return { ok: true };
});

ipcMain.handle('sandbox:reveal', async (_e, payload) => {
  const folder = String((payload && payload.folder) || '');
  if (!folder.startsWith(sandboxRoot() + path.sep)) return { ok: false, error: 'geçersiz klasör' };
  try { require('electron').shell.openPath(folder); return { ok: true }; } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* seçili reponun oturum geçmişini panele döndürür (yeni oturum yoksa oluşturur) */
ipcMain.handle('sandbox:open', async (_e, payload) => {
  const folder = String((payload && payload.folder) || '');
  if (!folder.startsWith(sandboxRoot() + path.sep)) return { ok: false, error: 'geçersiz klasör' };
  if (!engine) return { ok: false, error: 'ajan hazır değil' };
  sbLastFolder = folder;
  const s = sandboxGetSession(folder);
  s.workspace = folder;
  engine.cache.set(s.id, s);
  const msgs = [];
  for (const m of s.messages || []) {
    if (m.tool_calls) continue;
    const txt = bcMsgText(m);
    if (!txt) continue;
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', text: txt.slice(0, 4000) });
  }
  return {
    ok: true,
    sessionId: s.id,
    busy: !!engine.isBusy(s.id),
    messages: msgs.slice(-200),
  };
});

/* Sandbox dosya konsolu: seçili repo klasörünün ağacı (filePanel yeniden kullanılır) */
ipcMain.handle('sandbox:tree', (_e, payload) => {
  const folder = String((payload && payload.folder) || '');
  if (!folder.startsWith(sandboxRoot() + path.sep)) return { ok: false, error: 'geçersiz klasör' };
  const p = path.resolve(folder, String((payload && payload.rel) || ''));
  if (p !== folder && !p.startsWith(folder + path.sep)) return { ok: false, error: 'geçersiz yol' };
  try {
    const entries = fs.readdirSync(p, { withFileTypes: true })
      .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
      .map((e) => {
        let size = 0;
        if (!e.isDirectory()) {
          try { size = fs.statSync(path.join(p, e.name)).size; } catch {}
        }
        return { name: e.name, dir: e.isDirectory(), size };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { ok: true, workspace: folder, entries };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* Sandbox ÇALIŞTIRICI v2: repo başına YÖNETİLEN SÜREÇLER.
   Başlat/Dev/Durdur butonları artık deterministik: proje tipi algılanır
   (package.json, requirements.txt, pyproject.toml, Cargo.toml, go.mod,
   index.html) ve doğru komut DOĞRUDAN çalıştırılır. Her repo kendi süreç
   yuvasında koşar — birden çok repo aynı anda çalışabilir; çıktı tamponlanır,
   repo değiştirilince panel geçmişi yeniden basılır. Dev server adresi
   çıktıdan yakalanır → sağdaki dahili tarayıcıda açılır. Aynı fonksiyon
   engine.sbRunHook'tur: ajanın panel_run aracı da buradan geçer. */

const sbProcs = new Map(); /* klasör → { proc, kind, cmd, url, lines[], startedAt } */
const SB_LOG_CAP = 500; /* repo başına tamponlanan çıktı satırı */
const SB_CFG_FILE = 'sandbox-config.json';

function sbCfgPath() {
  return path.join(beastDir(), SB_CFG_FILE);
}

let sbCfgLoaded = false;
let sbCfg = {}; /* klasör → { install, run, dev } — kullanıcının kaydettiği özel komutlar */

function sbLoadCfg() {
  if (sbCfgLoaded) return sbCfg;
  sbCfgLoaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(sbCfgPath(), 'utf8'));
    if (raw && typeof raw === 'object') sbCfg = raw;
  } catch {}
  return sbCfg;
}

function sbSaveCfg() {
  try { fs.writeFileSync(sbCfgPath(), JSON.stringify(sbCfg, null, 2)); } catch {}
}

/* embedded python varsa onu kullan — PATH'te python olmasa bile çalışsın */
function sbPythonCmd() {
  const cands = [process.env.BEAST_PYTHON, path.join(beastDir(), 'py', 'python.exe')];
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return '"' + c + '"'; } catch {}
  }
  return 'python';
}

/* statik site üreticileri: hugo / jekyll / mkdocs — doküman repoları sık böyle;
   Başlat/Dev butonları bunları da tanısın (ör. docs/ altında hugo.yaml) */
function sbSiteGenInfo(folder) {
  for (const d of ['', 'docs', 'site', 'website']) {
    const base = d ? path.join(folder, d) : folder;
    const has = (f) => { try { return fs.existsSync(path.join(base, f)); } catch { return false; } };
    if (has('hugo.toml') || has('hugo.yaml') || has('hugo.json') || (has('config.toml') && (has('content') || has('themes')))) {
      return { kind: 'static', label: 'hugo', install: '', run: 'hugo server' + (d ? ' -s ' + d : '') };
    }
    if (has('_config.yml') && (has('Gemfile') || has('Gemfile.lock'))) {
      return { kind: 'ruby', label: 'jekyll', install: 'bundle install', run: 'bundle exec jekyll serve' + (d ? ' -s ' + d : '') };
    }
    if (has('mkdocs.yml') || has('mkdocs.yaml')) {
      return { kind: 'python', label: 'mkdocs', install: sbPythonCmd() + ' -m pip install mkdocs', run: sbPythonCmd() + ' -m mkdocs serve' };
    }
  }
  return null;
}

/* repo köküne bakıp proje tipini + kur/çalıştır komutlarını çıkarır */
function sbProjectInfo(folder) {
  const out = { kind: 'unknown', label: 'bilinmiyor', name: path.basename(folder), install: '', run: '', dev: '', build: '' };
  try {
    const pkgPath = path.join(folder, 'package.json');
    if (fs.existsSync(pkgPath)) {
      let pkg = {};
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch {}
      out.name = String(pkg.name || out.name);
      let pm = 'npm';
      if (fs.existsSync(path.join(folder, 'pnpm-lock.yaml'))) pm = 'pnpm';
      else if (fs.existsSync(path.join(folder, 'yarn.lock'))) pm = 'yarn';
      else if (fs.existsSync(path.join(folder, 'bun.lockb')) || fs.existsSync(path.join(folder, 'bun.lock'))) pm = 'bun';
      const s = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
      out.kind = 'node';
      out.label = pm;
      out.install = pm + ' install';
      out.dev = s.dev ? pm + ' run dev' : '';
      out.run = s.start ? pm + ' run start' : s.dev ? pm + ' run dev' : s.serve ? pm + ' run serve' : '';
      out.build = s.build ? pm + ' run build' : '';
      return out;
    }
    /* statik site üreticisi (hugo/jekyll/mkdocs) python paketinden ÖNCE gelir:
       docs/ altındaki hugo.yaml, kökteki requirements.txt'i gölgeleyebilsin */
    const site = sbSiteGenInfo(folder);
    if (site) {
      out.kind = site.kind;
      out.label = site.label;
      if (site.install) out.install = site.install;
      if (site.run) { out.run = site.run; out.dev = site.run; }
      if (!out.install) {
        const py = sbPythonCmd();
        if (fs.existsSync(path.join(folder, 'requirements.txt'))) out.install = py + ' -m pip install -r requirements.txt';
        else if (fs.existsSync(path.join(folder, 'pyproject.toml'))) out.install = py + ' -m pip install -e .';
      }
      return out;
    }
    const hasPy = ['pyproject.toml', 'requirements.txt', 'setup.py'].some((f) => fs.existsSync(path.join(folder, f)));
    if (hasPy) {
      const py = sbPythonCmd();
      out.kind = 'python';
      out.label = 'python';
      if (fs.existsSync(path.join(folder, 'uv.lock'))) out.install = 'uv sync';
      else if (fs.existsSync(path.join(folder, 'requirements.txt'))) out.install = py + ' -m pip install -r requirements.txt';
      else out.install = py + ' -m pip install -e .';
      if (fs.existsSync(path.join(folder, 'manage.py'))) out.run = py + ' manage.py runserver';
      else if (fs.existsSync(path.join(folder, 'main.py'))) out.run = py + ' main.py';
      else if (fs.existsSync(path.join(folder, 'app.py'))) out.run = py + ' app.py';
      else if (fs.existsSync(path.join(folder, 'run.py'))) out.run = py + ' run.py';
      else if (fs.existsSync(path.join(folder, 'bot.py'))) out.run = py + ' bot.py';
      out.dev = out.run;
      return out;
    }
    if (fs.existsSync(path.join(folder, 'Cargo.toml'))) {
      out.kind = 'rust';
      out.label = 'cargo';
      out.install = 'cargo fetch';
      out.run = 'cargo run';
      out.dev = 'cargo run';
      return out;
    }
    if (fs.existsSync(path.join(folder, 'go.mod'))) {
      out.kind = 'go';
      out.label = 'go';
      out.install = 'go mod download';
      out.run = 'go run .';
      out.dev = 'go run .';
      return out;
    }
    if (fs.existsSync(path.join(folder, 'index.html'))) {
      out.kind = 'static';
      out.label = 'statik';
      out.run = sbPythonCmd() + ' -m http.server 8123 --bind 127.0.0.1';
      out.dev = out.run;
      return out;
    }
  } catch {}
  return out;
}

/* algılanan komutlar + kullanıcının kaydettiği özel komutlar birleşir */
function sbProjectInfoMerged(folder) {
  const info = sbProjectInfo(folder);
  const c = sbLoadCfg()[folder];
  if (c && typeof c === 'object') {
    if (c.install) info.install = String(c.install);
    if (c.run) info.run = String(c.run);
    if (c.dev) info.dev = String(c.dev);
    if (c.install || c.run || c.dev) info.custom = true;
  }
  return info;
}

function sbRunEmit(folder, data, kind) {
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('agent:event', {
        type: 'sb-run',
        folder: String(folder || ''),
        kind: kind || 'run',
        data: String(data || ''),
      });
    }
  } catch {}
}

function sbSlotPush(slot, folder, text) {
  slot.lines.push(String(text || ''));
  if (slot.lines.length > SB_LOG_CAP) slot.lines.splice(0, slot.lines.length - SB_LOG_CAP);
  sbRunEmit(folder, text, slot.kind);
}

function sbRunStartManaged(folder, cmd, kind, opts) {
  folder = String(folder || '');
  cmd = String(cmd || '').trim();
  kind = kind === 'install' ? 'install' : 'run';
  if (!folder.startsWith(sandboxRoot() + path.sep)) return { ok: false, error: 'geçersiz klasör' };
  if (!cmd) return { ok: false, error: 'komut boş' };
  const cur = sbProcs.get(folder);
  if (cur && cur.proc) return { ok: false, error: 'Bu repoda zaten bir süreç çalışıyor — önce ■ Durdur' };
  const { spawn } = require('child_process');
  try {
    const proc = spawn('cmd.exe', ['/d', '/s', '/c', cmd], {
      cwd: folder,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const slot = { proc, kind, cmd, url: '', lines: [], startedAt: Date.now(), installCmd: (opts && opts.installCmd) || '' };
    sbProcs.set(folder, slot);
    const onLine = (buf) => {
      for (const piece of String(buf).split(/\r?\n/)) {
        if (!piece.trim()) continue;
        sbSlotPush(slot, folder, piece);
        if (kind !== 'run') continue;
        /* dev server adresi yakala (sadece localhost) */
        const m = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?[^\s'"<>]*/i.exec(piece);
        if (m && !slot.url) {
          slot.url = m[0].replace(/[)\].,;:'"]+$/, '');
          try {
            if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'sb-run-url', folder, url: slot.url });
          } catch {}
        }
      }
    };
    proc.stdout.on('data', onLine);
    proc.stderr.on('data', onLine);
    proc.on('close', (code) => {
      sbSlotPush(slot, folder, '[süreç bitti' + (code != null ? ' — kod ' + code : '') + ']');
      slot.proc = null;
      /* başarılı kurulum damgalanır: sonraki Başlat/Dev kurulumu tekrarlamaz */
      if (code === 0 && (slot.kind === 'install' || slot.installCmd)) sbMarkInstalled(folder);
      /* hızlı çöküş (10 sn içinde sıfırdan farklı çıkış): renderer bunu ajan
         devralması için işaret sayar — yanlış algılanan komut ajanla düzeltilir */
      const quickFail = code != null && Number(code) !== 0 && Date.now() - slot.startedAt < 10000;
      try {
        if (win && !win.isDestroyed()) {
          win.webContents.send('agent:event', {
            type: 'sb-run-end',
            folder,
            code: code == null ? null : Number(code),
            kind: slot.kind,
            quickFail,
          });
        }
      } catch {}
    });
    sbSlotPush(slot, folder, '▶ ' + cmd + '  (klasör: ' + path.basename(folder) + ')');
    return {
      ok: true,
      cmd,
      kind,
      note: 'süreç ÇALIŞTIR panelinde başlatıldı — çıktı orada canlı akar; durdurmak için paneldeki ■. Kullanıcıya adres varsa bildir.',
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function sbRunStopFolder(folder) {
  const slot = sbProcs.get(String(folder || ''));
  if (!slot || !slot.proc) return false;
  const p = slot.proc;
  slot.proc = null;
  try {
    /* cmd.exe /c zinciriyle çocuklar (node/vite) geride kalmasın — ağaç kesimi */
    if (process.platform === 'win32') {
      const { exec } = require('child_process');
      exec('taskkill /pid ' + p.pid + '/T /F', { windowsHide: true });
    } else p.kill('SIGTERM');
  } catch {}
  return true;
}

ipcMain.handle('sandbox:run', async (_e, payload) => {
  const folder = String((payload && payload.folder) || '');
  const cmd = String((payload && payload.cmd) || '').trim();
  return sbRunStartManaged(folder, cmd, (payload && payload.kind) || 'run');
});

/* proje tipi + önerilen komutlar (kullanıcı özel komutlarıyla birleşik) */
ipcMain.handle('sandbox:detect', async (_e, payload) => {
  const folder = String((payload && payload.folder) || '');
  if (!folder.startsWith(sandboxRoot() + path.sep)) return { ok: false, error: 'geçersiz klasör' };
  return { ok: true, info: sbProjectInfoMerged(folder) };
});

/* Kur: algılanan/kayıtlı kurulum komutunu doğrudan çalıştırır (panel + ajan ortak) */
function sbInstallRepo(folder) {
  folder = String(folder || '');
  if (!folder.startsWith(sandboxRoot() + path.sep)) return { ok: false, error: 'geçersiz klasör' };
  const info = sbProjectInfoMerged(folder);
  if (!info.install) return { ok: false, error: 'Bu repoda kurulum komutu algılanamadı — özel komutu kutuya yazıp ▶ ile çalıştır' };
  const r = sbRunStartManaged(folder, info.install, 'install');
  if (r.ok) r.cmd = info.install;
  return r;
}

ipcMain.handle('sandbox:install', async (_e, payload) => sbInstallRepo(String((payload && payload.folder) || '')));

/* bağımlılıklar eksik mi? — Başlat/Dev gerekirse ÖNCE kurar; kurulum bir kez
   yapıldıktan sonra damga dosyasıyla (node_modules var / %APPDATA% damgası)
   tekrarlanmaz */
function sbInstallNeeded(folder, info) {
  try {
    if (!info.install) return false;
    if (info.kind === 'node') {
      const nm = path.join(folder, 'node_modules');
      return !fs.existsSync(nm) || !fs.readdirSync(nm).length;
    }
    if (info.label === 'jekyll') return !fs.existsSync(path.join(folder, 'Gemfile.lock'));
    if (info.kind === 'python' || info.label === 'mkdocs') {
      if (fs.existsSync(path.join(folder, '.venv'))) return false;
      return !fs.existsSync(path.join(beastDir(), 'sandbox-installed', path.basename(folder)));
    }
  } catch {}
  return false;
}

function sbMarkInstalled(folder) {
  try {
    const dir = path.join(beastDir(), 'sandbox-installed');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, path.basename(folder)), new Date().toISOString());
  } catch {}
}

/* Başlat/Dev: algılanan çalıştırma komutunu başlatır; bağımlılıklar eksikse
   önce kurulum komutunu zincirler (npm install && npm run dev gibi) */
function sbStartRepo(folder, mode) {
  folder = String(folder || '');
  mode = String(mode || 'run') === 'dev' ? 'dev' : 'run';
  if (!folder.startsWith(sandboxRoot() + path.sep)) return { ok: false, error: 'geçersiz klasör' };
  const info = sbProjectInfoMerged(folder);
  const cmd = mode === 'dev' ? info.dev || info.run : info.run || info.dev;
  if (!cmd) return { ok: false, error: 'Bu repo için çalıştırma komutu algılanamadı — özel komutu kutuya yazıp ▶ ile çalıştır' };
  const pre = sbInstallNeeded(folder, info) ? info.install : '';
  const full = pre ? pre + ' && ' + cmd : cmd;
  const r = sbRunStartManaged(folder, full, 'run', pre ? { installCmd: pre } : null);
  if (r.ok) r.cmd = full;
  return r;
}

ipcMain.handle('sandbox:start', async (_e, payload) => {
  const folder = String((payload && payload.folder) || '');
  return sbStartRepo(folder, String((payload && payload.mode) || 'run'));
});

/* seçili repo paneli için: çalışıyor mu + tamponlanmış çıktı */
ipcMain.handle('sandbox:procstate', async (_e, payload) => {
  const folder = String((payload && payload.folder) || '');
  if (!folder.startsWith(sandboxRoot() + path.sep)) return { ok: false, error: 'geçersiz klasör' };
  const slot = sbProcs.get(folder);
  return {
    ok: true,
    running: !!(slot && slot.proc),
    kind: slot ? slot.kind : '',
    cmd: slot ? slot.cmd : '',
    url: slot ? slot.url : '',
    lines: slot ? slot.lines.slice() : [],
  };
});

/* özel komutları kalıcı kaydet (repo klasörü → install/run/dev) */
ipcMain.handle('sandbox:cfg:set', async (_e, payload) => {
  const folder = String((payload && payload.folder) || '');
  if (!folder.startsWith(sandboxRoot() + path.sep)) return { ok: false, error: 'geçersiz klasör' };
  sbLoadCfg();
  const cur = sbCfg[folder] && typeof sbCfg[folder] === 'object' ? sbCfg[folder] : {};
  const next = { ...cur };
  for (const k of ['install', 'run', 'dev']) {
    if (payload && payload[k] !== undefined) {
      const v = String(payload[k] || '').trim().slice(0, 500);
      if (v) next[k] = v;
      else delete next[k];
    }
  }
  if (Object.keys(next).length) sbCfg[folder] = next;
  else delete sbCfg[folder];
  sbSaveCfg();
  return { ok: true, cfg: sbCfg[folder] || {} };
});

ipcMain.handle('sandbox:runstop', async (_e, payload) => {
  const folder = String((payload && payload.folder) || '');
  if (folder) {
    if (!folder.startsWith(sandboxRoot() + path.sep)) return { ok: false, error: 'geçersiz klasör' };
    return { ok: true, wasRunning: sbRunStopFolder(folder) };
  }
  let any = false;
  for (const f of Array.from(sbProcs.keys())) {
    if (sbRunStopFolder(f)) any = true;
  }
  return { ok: true, wasRunning: any };
});

ipcMain.handle('sandbox:openurl', async (_e, url) => {
  const u = String(url || '').trim();
  if (!/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?(?:\/|$)/i.test(u)) return { ok: false, error: 'yalnız localhost adresleri açılabilir' };
  try {
    setBrowserOpen(true, true);
    browser.view.webContents.loadURL(u).catch(() => {});
    return { ok: true, url: u };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* ---------- SANDBOX PANEL İÇİ CANLI ÖNİZLEME (native WebContentsView) ----------
   ÇALIŞTIR bölümünde, çıktı günlüğünün yerine repo'nun çalışan hâlini gösterir.
   Tarayıcı dock'undan bağımsızdır: renderer host alanının DOM dikdörtgenini
   gönderir, view tam o alana oturur. Yalnız localhost adresleri yüklenir. */
const sbPreview = { view: null, attached: false, visible: false, url: '', bounds: null };

function ensureSbPreview() {
  if (sbPreview.view) return sbPreview.view;
  const view = new WebContentsView({
    webPreferences: {
      partition: 'persist:sandbox-preview',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  view.setBackgroundColor(settings.theme === 'dark' ? '#0d0d0f' : '#ffffff');
  const wc = view.webContents;
  try {
    const chromeUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
    wc.setUserAgent(chromeUA);
  } catch {}
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) wc.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  wc.on('render-process-gone', () => {
    if (win && !win.isDestroyed() && sbPreview.view) {
      try { win.contentView.removeChildView(sbPreview.view); } catch {}
    }
    sbPreview.view = null;
    sbPreview.attached = false;
    sbPreview.visible = false;
  });
  sbPreview.view = view;
  return view;
}

function sbPreviewDetach() {
  if (sbPreview.view && win && !win.isDestroyed()) {
    try { sbPreview.view.setVisible(false); } catch {}
    try { win.contentView.removeChildView(sbPreview.view); } catch {}
  }
  sbPreview.attached = false;
  sbPreview.visible = false;
}

function sbPreviewSet(payload) {
  if (!win || win.isDestroyed()) return { ok: false, error: 'pencere yok' };
  const p = payload || {};
  if (p.bounds && typeof p.bounds === 'object') {
    sbPreview.bounds = {
      x: Math.max(0, Math.round(Number(p.bounds.x) || 0)),
      y: Math.max(0, Math.round(Number(p.bounds.y) || 0)),
      width: Math.max(0, Math.round(Number(p.bounds.width) || 0)),
      height: Math.max(0, Math.round(Number(p.bounds.height) || 0)),
    };
  }
  if (p.url) {
    const u = String(p.url);
    if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{2,5})?(?:[/?#]|$)/i.test(u)) sbPreview.url = u;
  }
  const b = sbPreview.bounds;
  const want = p.visible !== false && !!sbPreview.url && !!b && b.width > 0 && b.height > 0;
  if (!want) {
    if (sbPreview.view) {
      try { sbPreview.view.setVisible(false); } catch {}
    }
    sbPreview.visible = false;
    return { ok: true, visible: false };
  }
  const view = ensureSbPreview();
  if (sbPreview.url) {
    let cur = '';
    try { cur = view.webContents.getURL(); } catch {}
    if (cur !== sbPreview.url) view.webContents.loadURL(sbPreview.url).catch(() => {});
  }
  if (!sbPreview.attached) {
    try { win.contentView.addChildView(view); sbPreview.attached = true; } catch {}
  }
  try {
    view.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    view.setVisible(true);
    sbPreview.visible = true;
  } catch {}
  return { ok: true, visible: true, url: sbPreview.url };
}

ipcMain.handle('sbpreview:set', async (_e, payload) => sbPreviewSet(payload || {}));

/* Sağ tık menüsü: HTML dosyasını dahili tarayıcıda GÖRÜNÜR aç */
/* ---------- BC DAHİLİ STATİK SUNUCU ----------
   Beast Code çıktısı ASLA file:// ile açılmaz: ES modülleri, fetch, ServiceWorker
   ve "clean URL" yolları file://'da çalışmaz. Her preview http://127.0.0.1 üzerinden
   servis edilir; ajan kendi dev sunucusunu başlattıysa o adres önceliklidir. */
let bcLastServerUrl = ''; /* ajanın başlattığı dev server adresi (bc-preview'dan yakalanır) */
let bcLastServerRoot = ''; /* adresin yakalandığı workspace kökü — klasör değişince bayat sayılır */

/* dev server'ı port'tan bulup süreç AĞACINI kapat (best-effort).
   Ajan arka planda başlattığı sunucular izlenmez — port üzerinden bulunur. */
function bcKillServer(url) {
  try {
    const m = /:(\d{2,5})(?:\/|$)/.exec(String(url || ''));
    if (!m) return false;
    const port = m[1];
    const { execSync } = require('child_process');
    const out = String(execSync(
      'netstat -ano | findstr ":' + port + '" | findstr LISTENING',
      { timeout: 6000, stdio: 'pipe', encoding: 'utf8', windowsHide: true }
    ));
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const p = /\s(\d+)\s*$/.exec(String(line).trim());
      if (p) pids.add(p[1]);
    }
    let killed = 0;
    for (const pid of pids) {
      if (Number(pid) === process.pid) continue; /* kendimize dokunma */
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        killed++;
      } catch {}
    }
    try { log.info('bc', 'bayat dev server kapatıldı (port ' + port + ', ' + killed + ' süreç)'); } catch {}
    return killed > 0;
  } catch {
    return false; /* port boş / netstat hata — yok say */
  }
}
const bcStatic = { server: null, root: '', base: '' };
/* MOBİL PROJE önizleme: npm run web (expo start --web) süreci + canlı adres */
const bcMobile = { proc: null, url: '', root: '' };

/* ---------- EXPO GO QR (yalnız Beast Code) ----------
   Ajan expo start çıktısında exp://<LAN-IP>:<port> yazınca QR'e çevrilir ve
   renderer'a { type:'bc-exp-qr', qr, url } düşer — telefonda Expo Go okutulur. */
let bcLastExpUrl = '';
let bcLastExpQr = '';

function bcExpQrMake(url) {
  if (!url || url === bcLastExpUrl) return Promise.resolve();
  bcLastExpUrl = url;
  return QRCode.toDataURL(url, { width: 240, margin: 1, errorCorrectionLevel: 'M' }).then((qr) => {
    bcLastExpQr = qr;
    if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'bc-exp-qr', qr, url });
  });
}

ipcMain.handle('ide:expqr', () => ({ ok: true, qr: bcLastExpQr, url: bcLastExpUrl }));

/* workspace bir MOBİL UYGULAMA projesi mi? (expo / react-native / app.json) */
function ideMobileProject(root) {
  try {
    const pkgPath = path.join(root, 'package.json');
    if (!fs.existsSync(pkgPath)) return { mobile: false };
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const isExpo = !!(deps.expo || deps['react-native'] || deps['react-native-web']);
    const hasAppJson = fs.existsSync(path.join(root, 'app.json')) || fs.existsSync(path.join(root, 'app.config.js'));
    const scripts = pkg.scripts || {};
    const hasReact = !!(deps.react || deps.next);
    const mobile = (isExpo || hasAppJson) && hasReact;
    let cmd = '';
    if (mobile) {
      if (scripts.web) cmd = 'npm run web';
      else if (deps.expo) cmd = 'npx expo start --web';
      else if (scripts.start) cmd = 'npm start';
    }
    return { mobile, cmd };
  } catch {
    return { mobile: false, cmd: '' };
  }
}

/* Beast Code PROJE TİPİ algılama: preview butonu ajana hangi talimatı vereceğini
   bununla seçer. kind: expo | react-native | web | static | unknown */
function ideProjectInfo(root) {
  const out = { kind: 'unknown', name: '', cmd: '' };
  try {
    const pkgPath = path.join(root, 'package.json');
    let pkg = null;
    try { if (fs.existsSync(pkgPath)) pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch {}
    if (!pkg) {
      out.kind = fs.existsSync(path.join(root, 'index.html')) ? 'static' : 'unknown';
      return out;
    }
    out.name = String(pkg.name || '');
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const scripts = pkg.scripts || {};
    const hasAppJson = fs.existsSync(path.join(root, 'app.json')) || fs.existsSync(path.join(root, 'app.config.js'));
    if (deps.expo || (hasAppJson && (deps['react-native'] || deps['react-dom']))) {
      out.kind = 'expo';
      out.cmd = scripts.web ? 'npm run web' : deps.expo ? 'npx expo start --web' : String(scripts.start || '');
    } else if (deps['react-native']) {
      out.kind = 'react-native';
      out.cmd = String(scripts.start || scripts.ios || '') || 'npx react-native start';
    } else if (deps.next) {
      out.kind = 'web';
      out.cmd = String(scripts.dev || scripts.start || '') || 'npx next dev';
    } else if (deps.vite || deps['react-scripts'] || deps['@angular/core'] || deps['vue']) {
      out.kind = 'web';
      out.cmd = String(scripts.dev || scripts.start || scripts.serve || '');
    } else if (scripts.dev) {
      out.kind = 'web';
      out.cmd = 'npm run dev';
    } else if (scripts.start) {
      out.kind = 'web';
      out.cmd = 'npm start';
    } else {
      out.kind = fs.existsSync(path.join(root, 'index.html')) ? 'static' : 'unknown';
    }
  } catch {}
  return out;
}

ipcMain.handle('ide:projinfo', () => ({ ok: true, ...ideProjectInfo(ideRoot()) }));

function killMobilePreview() {
  const p = bcMobile.proc;
  if (p) {
    try { spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }); } catch {}
    try { p.kill(); } catch {}
  }
  bcMobile.proc = null;
  bcMobile.url = '';
}

/* npm run web'i başlat; dev sunucu ayağa kalkınca adresi döner (çıktı taraması +
   port yoklaması çift kanal). Süreç UZUN ÖMÜRLÜDÜR — yeni preview onu öldürür. */
function mobilePreviewStart(root) {
  return new Promise((resolve) => {
    const info = ideMobileProject(root);
    if (!info.mobile || !info.cmd) return resolve({ ok: false, error: 'mobil web scripti yok — package.json scripts.web ekleyin' });
    /* zaten çalışıyor mu? */
    if (bcMobile.proc && bcMobile.url && bcMobile.root === root) {
      probeDevUrl(bcMobile.url, 800).then((alive) => {
        if (alive) resolve({ ok: true, url: bcMobile.url });
        else {
          killMobilePreview();
          mobilePreviewStart(root).then(resolve, () => resolve({ ok: false, error: 'başlatılamadı' }));
        }
      });
      return;
    }
    if (bcMobile.root !== root) killMobilePreview();
    bcMobile.url = '';
    bcMobile.root = root;
    let out = '';
    let settled = false;
    waLog('mobil önizleme başlatılıyor: ' + info.cmd + ' @ ' + root);
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', info.cmd], { cwd: root, windowsHide: true });
    bcMobile.proc = child;
    const scan = () => {
      const m = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/.exec(out);
      if (m && Number(m[1]) !== 19000 && Number(m[1]) !== 19001 && Number(m[1]) !== 19002) {
        bcMobile.url = m[0].replace(/\/+$/, '') + '/';
      }
    };
    child.stdout.on('data', (d) => { out += String(d); if (out.length > 60000) out = out.slice(-30000); scan(); });
    child.stderr.on('data', (d) => { out += String(d); if (out.length > 60000) out = out.slice(-30000); scan(); });
    child.on('exit', () => { if (bcMobile.proc === child) bcMobile.proc = null; });
    const t0 = Date.now();
    const timer = setInterval(async () => {
      scan();
      let url = bcMobile.url;
      if (!url) {
        for (const port of [8081, 19006, 5173]) {
          /* eslint-disable-next-line no-await-in-loop */
          if (await probeDevUrl('http://localhost:' + port + '/', 500)) { url = 'http://localhost:' + port + '/'; break; }
        }
      }
      if (url) {
        bcMobile.url = url;
        clearInterval(timer);
        settled = true;
        resolve({ ok: true, url });
      } else if (Date.now() - t0 > 120000) {
        clearInterval(timer);
        if (!settled) resolve({ ok: false, error: 'dev sunucu 120 sn içinde ayağa kalkmadı — çıktıyı terminalden kontrol et' });
      }
    }, 1200);
  });
}

/* ajana sessiz bilgi: dev sunucu zaten çalışıyor — ikinci sunucu başlatmasın */
function bcTellMobileServe(url) {
  try {
    const ws = ideRoot();
    const sid = bcSessions.get(ws);
    if (!sid) return;
    engine.observe(sid,
      '[PREVIEW] Kullanıcı mobil önizlemeyi açtı — `npm run web` dev sunucusu şu adreste ÇALIŞIYOR: ' + url + '\n' +
      'KENDİ dev sunucunu BAŞLATMA (port çakışır); uygulamayı bu adres üzerinden değerlendir,\n' +
      'kod düzenlemeleri hot-reload ile siluette canlı görünür.'
    );
  } catch {}
}
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
    /* MOBİL ÖNİZLEME kaldırıldı: mobil projeler de normal tarayıcı dock'unda
       açılır — ajanın dev sunucusu varsa o adres, yoksa dahili statik sunucu. */
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
    /* KLASÖR UYUŞMAZLIĞI: kayıtlı dev server ESKİ klasörün artıklarıysa
       kill et ve unut — yeni klasör kendi sunucusuyla başlasın */
    if (bcLastServerUrl && bcLastServerRoot && path.relative(bcLastServerRoot, root) !== '') {
      bcKillServer(bcLastServerUrl);
      bcLastServerUrl = '';
      bcLastServerRoot = '';
    }
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
    /* mobil önizleme otomatik telefon modu kaldırıldı — önizleme normal dockta açılır */
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
  const prev = Array.isArray(settings.customProviders) ? settings.customProviders : [];
  const byId = new Map(prev.filter((p) => p && p.id).map((p) => [p.id, p]));
  settings.customProviders = (Array.isArray(list) ? list : []).map((p) => {
    if (!p || typeof p !== 'object') return p;
    const item = { ...p };
    const old = byId.get(item.id);
    const k = String(item.key == null ? '' : item.key).trim();
    /* UI'dan maskeli/boş anahtar geldiyse aynı id'nin kayıtlı anahtarı korunur */
    if ((k === SECRET_MASK || !k) && old && old.key) item.key = String(old.key);
    return item;
  });
  const hadBridge = prev.some((p) => p && p.id === BRIDGE_PROVIDER_ID);
  const hasBridge = settings.customProviders.some((p) => p && p.id === BRIDGE_PROVIDER_ID);
  if (hadBridge && !hasBridge) {
    settings.opencodeBridge = false;
    try { stopOpenCodeBridge(); } catch {}
  } else if (hasBridge) {
    settings.opencodeBridge = true;
  }
  saveSettings();
  engine.setCustomProviders(settings.customProviders);
  return engine.publicState();
});

/* #Model refresh: taban zinciri tazele + kayıtlı tüm custom providerların
   modellerini yeniden çek (picker anında güncellenir). */
/* Tüm provider modellerini yeniden çek: taban zincir (config.yaml) + custom
   provider /models listeleri. UI düğmesi, /model refresh (chat + WhatsApp)
   aynı bu fonksiyonu kullanır. */
async function refreshModelsAll() {
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
      const h = { Authorization: 'Bearer ' + p.key, 'x-opencode-session': OPENCODE_SESSION };
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
}

ipcMain.handle('models:refresh', async () => refreshModelsAll());

ipcMain.handle('providers:builtin', () => BUILTIN_PROVIDERS);

/* ---------------- OPENCODE BRIDGE (FREE ZEN MODELS) ----------------
   Zen free modelleri doğrudan Beast'ten çağrılamıyor (FreeUsageLimitError).
   Bu köprü, gerçek OpenCode CLI'sini `opencode serve` ile çalıştırır ve
   Beast'in OpenAI uyumlu sohbet isteklerini OpenCode oturumlarına çevirir.
   Header taklidi YOK; ücretsiz kota gerçek OpenCode istemcisi üzerinden
   kullanılır. Provider, tek tıkla kurulur ve model listesine eklenir. */

const OPENCODE_BRIDGE_DEFAULT_PORT = 8646;
let opencodeBridge = null;
let opencodeBridgeStarting = null;

function hasOpencodeZenAuth() {
  for (const c of opencodeAuthCandidates()) {
    if (!c) continue;
    if (!String(c).toLowerCase().endsWith('auth.json')) {
      if (String(c).length > 8) return true; // OPENCODE_API_KEY env değeri
      continue;
    }
    try {
      const j = JSON.parse(fs.readFileSync(c, 'utf8'));
      if (j && j.opencode && typeof j.opencode.key === 'string' && j.opencode.key.length > 8) return true;
      if (findZenKeyDeep(j, /^opencode$/i)) return true;
    } catch {}
  }
  return false;
}

async function ensureOpenCodeBridgePrereqs() {
  if (!findOpenCodeBin()) {
    log.info('main', 'OpenCode CLI yok — npm install -g opencode-ai');
    const ins = await runNpmGlobalInstall();
    if (!ins.ok) throw new Error('OpenCode CLI kurulamadı (' + (ins.error || '?') + ') — npm kurulu mu?');
    if (!findOpenCodeBin()) throw new Error('OpenCode CLI kuruldu ama bulunamadı — terminali yeniden aç');
  }
  if (!hasOpencodeZenAuth()) {
    if (!openZenAuthWindow()) {
      throw new Error('OpenCode giriş penceresi açılamadı — terminalde `opencode auth login` çalıştır');
    }
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline && !hasOpencodeZenAuth()) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!hasOpencodeZenAuth()) {
      throw new Error('OpenCode girişi tamamlanmadı (3 dk) — giriş yapıp tekrar dene');
    }
  }
}

function applyOpenCodeBridgeProvider(info) {
  const entry = {
    id: BRIDGE_PROVIDER_ID,
    name: 'OpenCode Bridge (Free)',
    baseUrl: info.baseUrl,
    key: info.key,
    models: Array.isArray(info.models) ? info.models.slice() : [],
    bridge: true,
  };
  const list = Array.isArray(settings.customProviders)
    ? settings.customProviders.filter((p) => p && p.id !== BRIDGE_PROVIDER_ID)
    : [];
  list.unshift(entry);
  settings.customProviders = list;
  settings.opencodeBridge = true;
  saveSettings();
  if (engine) {
    engine.setCustomProviders(settings.customProviders);
    try { engine.setModelOverride(settings.modelOverride || null); } catch {}
  }
  return entry;
}

async function ensureOpenCodeBridge() {
  if (opencodeBridge && opencodeBridge.baseUrl) return opencodeBridge.info();
  if (opencodeBridgeStarting) return opencodeBridgeStarting;
  opencodeBridgeStarting = (async () => {
    let key = String(settings.opencodeBridgeKey || '').trim();
    if (key.length < 16) {
      key = 'beast-' + crypto.randomBytes(18).toString('hex');
      settings.opencodeBridgeKey = key;
      saveSettings();
    }
    const b = new OpenCodeBridge({
      dataDir: APP_DIR,
      log,
      models: DEFAULT_FREE_MODELS,
      key,
      port: Number(settings.opencodeBridgePort) || OPENCODE_BRIDGE_DEFAULT_PORT,
    });
    try {
      const info = await b.start();
      opencodeBridge = b;
      applyOpenCodeBridgeProvider(info);
      log.info('main', 'OpenCode bridge hazır: ' + info.baseUrl + ' · ' + info.models.length + ' model');
      return info;
    } catch (e) {
      try { await b.stop(); } catch {}
      throw e;
    }
  })().finally(() => { opencodeBridgeStarting = null; });
  return opencodeBridgeStarting;
}

async function stopOpenCodeBridge() {
  const b = opencodeBridge;
  opencodeBridge = null;
  if (b) {
    try { await b.stop(); } catch {}
  }
}

async function testOpenCodeBridgeModel(info, model) {
  try {
    const res = await fetch(info.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + info.key, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
        stream: false,
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(90000),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: (j && j.error && j.error.message) || ('HTTP ' + res.status),
      };
    }
    const ch = j && j.choices && j.choices[0];
    const msg = ch && ch.message;
    const ok = !!(msg && (typeof msg.content === 'string' || Array.isArray(msg.tool_calls)));
    return { ok, status: res.status, error: ok ? '' : 'boş yanıt' };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e) };
  }
}

ipcMain.handle('bridge:oneClick', async () => {
  try {
    await ensureOpenCodeBridgePrereqs();
    let info = await ensureOpenCodeBridge();
    if (opencodeBridge) {
      try {
        await opencodeBridge.refreshModels();
        info = opencodeBridge.info();
      } catch {}
    }
    const candidates = [];
    for (const m of ['big-pickle', 'beam-free', ...(info.models || [])]) {
      if (m && !candidates.includes(m)) candidates.push(m);
      if (candidates.length >= 4) break;
    }
    if (!candidates.length) return { ok: false, error: 'OpenCode free model listesi boş' };

    let chosen = '';
    let lastErr = '';
    let authFail = false;
    for (const model of candidates) {
      const r = await testOpenCodeBridgeModel(info, model);
      if (r.ok) {
        chosen = model;
        break;
      }
      if (r.status === 401 || r.status === 403) authFail = true;
      lastErr = model + ': ' + (r.error || ('HTTP ' + r.status));
      log.warn('main', 'OpenCode bridge test başarısız: ' + lastErr);
    }
    if (!chosen) {
      return {
        ok: false,
        error: authFail
          ? 'OpenCode Zen yetkisi yok/geçersiz — terminalde `opencode auth login` ile OpenCode hesabına giriş yap'
          : 'Hiçbir free model yanıt vermedi — ' + lastErr,
      };
    }

    const entry = applyOpenCodeBridgeProvider(info);
    const sel = 'custom:' + BRIDGE_PROVIDER_ID + '::' + chosen;
    settings.opencodeBridge = true;
    settings.modelOverride = sel;
    saveSettings();
    if (engine) {
      engine.setCustomProviders(settings.customProviders || []);
      engine.setModelOverride(sel);
    }
    try { win && !win.isDestroyed() && win.webContents.send('agent:event', { type: 'modelChanged' }); } catch {}
    log.info('main', `OpenCode bridge tek tık: ${chosen} seçildi (${info.models.length} model)`);
    return { ok: true, models: info.models, model: chosen, provider: entry.name, baseUrl: info.baseUrl };
  } catch (e) {
    log.error('main', 'bridge oneClick hata: ' + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
});

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
    const res = await fetch(ZEN_BASE + '/models', {
      headers: { 'x-opencode-session': OPENCODE_SESSION },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const j = await res.json();
      const ids = (j.data || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
      /* Zen'de ücretsizler: "-free" ekli modeller + big-pickle (gizli model, sınırlı süre ücretsiz) */
      const free = ids.filter((id) => /-free$/.test(id) || id === 'big-pickle');
      if (free.length) return free;
    }
  } catch {}
  /* API cevap vermezse bilinen free liste (09/2026 güncel — eski adlar düşürüldü) */
  return ['big-pickle', 'deepseek-v4-flash-free', 'mimo-v2.5-free', 'muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free', 'ling-3.0-flash-fin-free', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free'];
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
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
        'x-opencode-session': OPENCODE_SESSION,
      },
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

/* REASONING PROBU: model düşünüyor mu? reasoning_effort:'low' ile minik istek —
   200 → destekliyor (bir şey yapma), 400 → desteklemiyor (model-caps'e yazılır,
   kullanıcı düşünmeyi açsa bile o modelde parametre hiç gönderilmez).
   Diğer statuslar (429/5xx) kararsızdır — hüküm verilmez. */
async function testZenReasoning(key, model) {
  try {
    const res = await fetch(ZEN_BASE + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
        'x-opencode-session': OPENCODE_SESSION,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        stream: false,
        reasoning_effort: 'low',
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (res.ok) return true;
    if (res.status === 400) {
      try { await res.text(); } catch {}
      return false;
    }
    return null;
  } catch {
    return null;
  }
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
    /* reasoning probu: desteklemeyen free modelleri ÖNCEDEN model-caps.json'a
       yaz — kullanıcının düşünme seviyesi açıkken bile bu modellerde
       reasoning_effort hiç gönderilmez, ilk istekte 400 turu yaşanmaz */
    try {
      const llmMod = require('./agent/llm');
      llmMod.setCapsFile(path.join(beastDir(), 'model-caps.json'));
      const noReason = [];
      const RBATCH = 4;
      for (let i = 0; i < models.length; i += RBATCH) {
        const rs = await Promise.all(models.slice(i, i + RBATCH).map((m) => testZenReasoning(key, m)));
        rs.forEach((r, j) => { if (r === false) noReason.push(models[i + j]); });
      }
      for (const m of noReason) {
        llmMod.learnCaps({ providerId: 'custom:' + ZEN_PRESET_ID, model: m }, { noReasoning: true });
      }
      if (noReason.length) {
        log.info('main', 'zen: reasoning desteklemeyenler (caps yazıldı) → ' + noReason.join(', '));
      }
    } catch {}
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
    const headers = { 'x-opencode-session': OPENCODE_SESSION, ...(key ? { Authorization: 'Bearer ' + key } : {}) };
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

/* Sohbet geçmişi etiketi: soldaki listede oturumun HANGİ NUMARAYA/GRUBA ait
   olduğu görünür — DM'de "WhatsApp +905xx (Ad)", grupta "WhatsApp 1203… (grup)". */
function waChatLabelFor(key) {
  const k = String(key || '');
  const digits = chansessions.jidDigits(k);
  if (k.endsWith('@g.us')) return 'WhatsApp ' + digits + ' (grup)';
  const hit = waFind(digits);
  const name = hit && hit.name ? String(hit.name) : '';
  return 'WhatsApp +' + digits + (name ? ' (' + name + ')' : '');
}

ipcMain.handle('wa:sessions:info', () => {
  const out = [];
  for (const [key, sid] of waChats) {
    if (!sid) continue;
    out.push({ sid: String(sid), label: waChatLabelFor(key), group: String(key).endsWith('@g.us') });
  }
  return out;
});

/* TTS sayısal ayar kelepçesi: geçersiz/boş değerde varsayılana döner */
function clampTtsNum(v, lo, hi, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

/* wa:tts:get sanitize eder — renderer'a her zaman şema uyumlu değer döner.
   Varsayılan 48 kHz: WhatsApp sesli notları zaten Opus (native 48k) —
   yeniden örnekleme yok, daha temiz ses; eMa hızlı olduğu için bedava. */
ipcMain.handle('wa:tts:get', () => {
  const c = settings.waTts || {};
  return {
    enabled: !!c.enabled,
    engine: ttsEngineName(),
    speed: clampTtsNum(c.speed, 0.5, 2, 1),
    sampleRate: [48000, 24000, 16000, 8000].includes(Number(c.sampleRate)) ? Number(c.sampleRate) : 48000,
    chatAutoSpeak: !!c.chatAutoSpeak,
    voice: String(c.voice || ''),
    /* motor başına ses listesi — UI'daki çevirmeli seçici için */
    voices: {
      edge: edgetts.EDGE_VOICES.map((v) => ({ id: v.id, name: v.name })),
      piper: Object.entries(piper.VOICES).map(([id, v]) => ({ id, name: v.name })),
      supertonic: Object.entries(supertonic.VOICES).map(([id, v]) => ({ id, name: v.name })),
    },
  };
});
ipcMain.handle('wa:tts:set', (_e, cfg) => {
  const c = cfg || {};
  const eng = String(c.engine || '').toLowerCase();
  settings.waTts = {
    enabled: !!(cfg && cfg.enabled),
    /* BEŞ motor: eMa/Ahenk/Edge/Piper/Supertonic — geçersiz değerde varsayılan eMa */
    engine: TTS_ENGINES.includes(eng) ? eng : 'ema',
    /* ses tercihi motor uzayına göndermeden ÖNCE doğrulanır — motor değişse
       bile eski id diğer motora taşınmaz; kullanıcı yeniden seçer */
    voice: validTtsVoice(TTS_ENGINES.includes(eng) ? eng : 'ema', c.voice) ? String(c.voice).trim() : '',
    speed: clampTtsNum(cfg && cfg.speed, 0.5, 2, 1),
    sampleRate: [48000, 24000, 16000, 8000].includes(Number(cfg && cfg.sampleRate)) ? Number(cfg.sampleRate) : 48000,
    chatAutoSpeak: !!(cfg && cfg.chatAutoSpeak),
  };
  saveSettings();
  return settings.waTts;
});

/* eMa Lightning (yerel/offline TTS): durum + elle kurulum/ısıtma */
ipcMain.handle('ema:status', () => ema.status());
ipcMain.handle('ema:install', async () => {
  const r = await ema.install();
  return { ...r, status: ema.status() };
});
/* Ahenk Cep (yerel/offline TTS #2): durum + elle kurulum/ısıtma */
ipcMain.handle('ahenk:status', () => ahenk.status());
ipcMain.handle('ahenk:install', async () => {
  const r = await ahenk.install();
  return { ...r, status: ahenk.status() };
});
/* Piper (yerel/offline TTS #4): durum + elle kurulum — seçili ses tercihiyle */
ipcMain.handle('piper:status', () => piper.status());
ipcMain.handle('piper:install', async () => {
  const r = await piper.install(ttsVoicePrefFor('piper'));
  return { ...r, status: piper.status() };
});
/* Supertonic (yerel/offline TTS #5): durum + elle kurulum */
ipcMain.handle('supertonic:status', () => supertonic.status());
ipcMain.handle('supertonic:install', async () => {
  const r = await supertonic.install(ttsVoicePrefFor('supertonic'));
  return { ...r, status: supertonic.status() };
});
/* Edge TTS (online #3): kurulum yok — hızlı sahte durum (UI tek şekil okur) */
ipcMain.handle('edge:status', () => ({ ok: true, installed: true, running: true, installing: false, kind: 'online' }));
/* AKTİF TTS MOTORU durumu: seçili motor (eMa | Ahenk | Edge | Piper | Supertonic) */
ipcMain.handle('tts:status', () => {
  const eng = ttsEngineName();
  const st = eng === 'edge'
    ? { installed: true, running: true, installing: false }
    : { ...ttsModule().status() };
  return { engine: eng, engineLabel: ttsEngineLabel(), ...st };
});
/* TTS ÖN-ISI: seçili motora göre ısıtılır — yerel motorlar 10-15 dk boşta
   bellekten düşüyor ve soğuk ilk sentez uzuyor; ön-ısıtma bu yüklemeyi
   kullanıcı konuşurken gizler. Piper/Supertonic: eksik dosya varsa indirir. */
ipcMain.handle('ema:prefetch', async () => {
  if (!settings.waTts || !settings.waTts.enabled) return { ok: false, skipped: true };
  const eng = ttsEngineName();
  try {
    if (eng === 'edge') return { ok: true }; // servis motoru — ısıtma yok
    if (eng === 'piper') {
      const st = piper.status(ttsVoicePrefFor('piper'));
      if (!st.runtime || !st.voice) {
        const r = await piper.install(ttsVoicePrefFor('piper'));
        if (!r.ok) return { ok: false, error: r.error || 'piper kurulumu başarısız' };
      }
      return { ok: true };
    }
    if (eng === 'supertonic') {
      const st = supertonic.status(ttsVoicePrefFor('supertonic'));
      if (!st.model || !st.voice) {
        const r = await supertonic.install(ttsVoicePrefFor('supertonic'));
        if (!r.ok) return { ok: false, error: r.error || 'supertonic kurulumu başarısız' };
      }
      return { ok: true };
    }
    const m = ttsModule();
    const st = m.status();
    if (eng === 'ahenk' && !st.pkg) return { ok: false, error: 'Ahenk Cep kurulu değil' };
    if (eng === 'ema' && !st.pkg) return { ok: false, error: 'eMa kurulu değil' };
    if (eng === 'ahenk' && !st.weights) return { ok: false, error: 'Ahenk Cep ağırlıkları inmemiş — KUR düğmesiyle kur' };
    if (eng === 'ema' && !st.weights) return { ok: false, error: 'eMa ağırlıkları inmemiş — KUR düğmesiyle kur' };
    await m.warm();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/* CHAT TTS: masaüstü sohbetinde ajanın son yazısını seslendirir (base64 WAV).
   chatAutoSpeak açıkken renderer 'done' olayında bu kanalı çağırır. */
ipcMain.handle('tts:synthesize', async (_e, text) => {
  const cfg = settings.waTts || {};
  if (!cfg.enabled) return { ok: false, error: 'tts kapalı' };
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: 'boş metin' };
  /* SOHBET AKICILIK: baş/son dolgu kısa — cümleler boşluksuz peş peşe gelsin
     (varsayılan 300ms dolgu her cümle arasında ölü boşluk yaratıyordu) */
  const out = await synthesizeSpeech(t.slice(0, 4000), { pad: 0.05 });
  if (!out || !out.audio) {
    waLog('tts chat seslendirilemedi — motor: ' + ttsEngineLabel());
    return { ok: false, error: 'seslendirilemedi' };
  }
  waLog('tts chat ok: ' + out.audio.length + ' bayt, motor: ' + ttsEngineLabel());
  return { ok: true, audioB64: out.audio.toString('base64'), mime: out.mime || 'audio/wav' };
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

/* Sohbet geçmişi etiketi (Telegram): "Telegram <ad|chatId>" */
function tgChatLabelFor(key) {
  const k = String(key || '');
  let name = '';
  try {
    const hit = tgFind(k, '');
    name = hit && hit.name ? String(hit.name) : '';
  } catch {}
  return 'Telegram ' + (name || k);
}

ipcMain.handle('tg:sessions:info', () => {
  const out = [];
  for (const [key, sid] of tgChats) {
    if (!sid) continue;
    out.push({ sid: String(sid), label: tgChatLabelFor(key) });
  }
  return out;
});

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

/* Sohbet geçmişi etiketi (Discord): "Discord <ad|kanalId>" */
function dcChatLabelFor(key) {
  const k = String(key || '');
  let name = '';
  try {
    const hit = dcFind(k, '');
    name = hit && hit.name ? String(hit.name) : '';
  } catch {}
  return 'Discord ' + (name || k);
}

ipcMain.handle('dc:sessions:info', () => {
  const out = [];
  for (const [key, sid] of dcChats) {
    if (!sid) continue;
    out.push({ sid: String(sid), label: dcChatLabelFor(key) });
  }
  return out;
});

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
/* E-posta paneli: gelen kutusu + okuma + gönderim (engine köprüsüyle aynı fonksiyonlar) */
ipcMain.handle('email:list', (_e, opts) => emailList(opts || {}));
ipcMain.handle('email:read', (_e, uid) => emailRead(uid));
ipcMain.handle('email:send', (_e, msg) => emailSend(msg || {}));

/* ---------- ekran görüntüsü ---------- */

/* Son ekran görüntüsünün kaynak ekran sınırları + görüntü boyutu — computer_act
   koordinat dönüşümü buradan yapılır (görüntü 1280px'e ölçeklenir). */
let lastScreenCapture = null;

/* Canvas (görüntü üzerine çizim) — yoksa annotasyon sessizce atlanır */
let _canvasLib;
function canvasLib() {
  if (_canvasLib !== undefined) return _canvasLib;
  try {
    _canvasLib = require('@napi-rs/canvas');
  } catch {
    _canvasLib = null;
  }
  return _canvasLib;
}

/* Gerçek imleç konumu (400 ms önbellek) — computer_look işaretçisi için */
let _cursorCache = { at: 0, x: 0, y: 0 };
function cursorPosition() {
  return new Promise((resolve) => {
    if (Date.now() - _cursorCache.at < 400) return resolve({ x: _cursorCache.x, y: _cursorCache.y });
    let out = '';
    try {
      const p = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"'],
        { windowsHide: true }
      );
      const t = setTimeout(() => { try { p.kill(); } catch {} resolve(null); }, 4000);
      p.stdout.on('data', (d) => { out += String(d); });
      p.on('error', () => { clearTimeout(t); resolve(null); });
      p.on('close', () => {
        clearTimeout(t);
        const m = /(\d+)\s*,\s*(\d+)/.exec(out);
        if (m) {
          _cursorCache = { at: Date.now(), x: Number(m[1]), y: Number(m[2]) };
          resolve({ x: _cursorCache.x, y: _cursorCache.y });
        } else resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

/* Ekran görüntüsü üzerine 128px ızgara + imleç işareti çiz: model koordinatı
   görselden okuyabilir. Izgara çizgileri yarı saydam — içeriği boğmaz. */
async function annotateScreenShot(img) {
  const lib = canvasLib();
  if (!lib) return null;
  const im = await lib.loadImage(img.toPNG());
  const canvas = lib.createCanvas(im.width, im.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(im, 0, 0);
  const step = 128;
  ctx.lineWidth = 1;
  ctx.font = 'bold 12px Segoe UI, sans-serif';
  for (let x = step; x < im.width; x += step) {
    ctx.strokeStyle = 'rgba(0,200,255,0.28)';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, im.height);
    ctx.stroke();
    const t = String(x);
    const tw = ctx.measureText(t).width;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(x + 1, 1, tw + 7, 15);
    ctx.fillStyle = '#00d8ff';
    ctx.fillText(t, x + 4, 12.5);
  }
  for (let y = step; y < im.height; y += step) {
    ctx.strokeStyle = 'rgba(0,200,255,0.28)';
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(im.width, y + 0.5);
    ctx.stroke();
    const t = String(y);
    const tw = ctx.measureText(t).width;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(1, y + 1, tw + 7, 15);
    ctx.fillStyle = '#00d8ff';
    ctx.fillText(t, 4, y + 12.5);
  }
  try {
    /* imleç sorgusu en çok 1.5 sn bekletir — look hızlı kalmalı */
    const cur = await Promise.race([
      cursorPosition(),
      new Promise((r) => setTimeout(() => r(null), 1500)),
    ]);
    const cap = lastScreenCapture;
    if (cur && cap && cap.w > 0 && cap.h > 0) {
      const kx = cap.imgW / cap.w;
      const ky = cap.imgH / cap.h;
      const cx = (cur.x - cap.x) * kx;
      const cy = (cur.y - cap.y) * ky;
      if (cx >= -24 && cy >= -24 && cx <= im.width + 24 && cy <= im.height + 24) {
        ctx.strokeStyle = '#ff3b5c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - 22, cy);
        ctx.lineTo(cx + 22, cy);
        ctx.moveTo(cx, cy - 22);
        ctx.lineTo(cx, cy + 22);
        ctx.stroke();
        const label = 'imlec (' + Math.round(cx) + ',' + Math.round(cy) + ')';
        const tw = ctx.measureText(label).width;
        const bx = Math.min(Math.max(2, cx + 18), Math.max(2, im.width - tw - 12));
        const by = Math.min(Math.max(16, cy - 34), im.height - 6);
        ctx.fillStyle = 'rgba(0,0,0,0.78)';
        ctx.fillRect(bx - 3, by - 13, tw + 8, 16);
        ctx.fillStyle = '#ff8ba0';
        ctx.fillText(label, bx, by);
      }
    }
  } catch {}
  return canvas.toBuffer('image/jpeg', 78);
}

/* Ana ekrandan JPEG dataURL yakalar (computer_use ve screen:capture ortak).
   opts.annotate: ızgara + imleç işareti (yalnız ajan computer_look kullanır;
   OCR/komut yolları düz görüntü ister). */
async function captureScreenFrame(opts) {
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
    /* KAYNAK EKRAN SINIRLARI: ajan görüntüyü 1280px tabanlı okur; act çağrısı
       bu sınırlara göre gerçek ekran koordinatına çevrilir (çok monitörde ofset dahil) */
    try {
      const all = screen.getAllDisplays();
      const disp = all.find((d) => String(d.id) === String(best.display_id)) || screen.getPrimaryDisplay();
      const b = (disp && disp.bounds) || { x: 0, y: 0, width: 1280, height: 720 };
      const size = img.getSize();
      lastScreenCapture = { x: b.x, y: b.y, w: b.width, h: b.height, imgW: size.width, imgH: size.height };
    } catch {
      lastScreenCapture = null;
    }
    let jpeg = null;
    if (opts && opts.annotate) {
      try { jpeg = await annotateScreenShot(img); } catch {}
    }
    if (!jpeg || !jpeg.length) jpeg = img.toJPEG(72);
    if (!jpeg || !jpeg.length) return null;
    return { data: 'data:image/jpeg;base64,' + jpeg.toString('base64'), img };
  } catch {
    return null;
  }
}

async function captureScreenDataUrl(opts) {
  const frame = await captureScreenFrame(opts);
  return frame ? frame.data : null;
}

/* ---- görsel parmak izi: aksiyon "işe yaradı mı" (verify) ---- */
function imageSignature(img) {
  try {
    if (!img) return null;
    const small = img.getSize().width > 64 ? img.resize({ width: 64 }) : img;
    const sz = small.getSize();
    return computeruse.bitmapSignature(small.toBitmap(), sz.width, sz.height);
  } catch {
    return null;
  }
}

async function pageSignature(wc) {
  try {
    return imageSignature(await wc.capturePage());
  } catch {
    return null;
  }
}

/* Ekran değişim imzası — küçük thumbnail ile hızlı (computer_act verify) */
async function screenSignature() {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 128, height: 72 } });
    if (!sources.length) return null;
    let best = sources[0];
    for (const s of sources) {
      const a = s.thumbnail.getSize();
      const b = best.thumbnail.getSize();
      if (a.width * a.height > b.width * b.height) best = s;
    }
    return imageSignature(best.thumbnail);
  } catch {
    return null;
  }
}

const CU_VERIFY_OPS = new Set(['click', 'dblclick', 'rightclick', 'type', 'key', 'drag']);

/* computer_act köprüsü: model 1280px tabanlı görüntü koordinatı verir —
   gerçek ekran koordinatına ölçekle (1280'den geniş her ekranda tıklamalar
   yanlış yere gidiyordu). Aksiyon sonrası görsel değişimi de raporlar. */
async function computerActScaled(op, args) {
  const a = { ...(args || {}) };
  let cap = lastScreenCapture;
  if (!cap) {
    try {
      const b = screen.getPrimaryDisplay().bounds;
      const imgH = Math.max(1, Math.round((1280 * b.height) / b.width));
      cap = { x: b.x, y: b.y, w: b.width, h: b.height, imgW: 1280, imgH };
    } catch {
      cap = null;
    }
  }
  const opName = String(op || '').toLowerCase();
  const scaled = cap && cap.imgW > 0 ? computeruse.scaleArgs(a, cap) : a;
  /* JEV HIZLI YOLU: T3SFast döngüsü ekranı zaten observe ile izler — ağır
     imza + 350 ms bekleme gereksiz. */
  const fast = !!a.fast;
  const verify = CU_VERIFY_OPS.has(opName) && !fast && a.verify !== false;
  const before = verify ? await screenSignature() : null;
  let r;
  try {
    r = await computeruse.act(opName, scaled);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  if (before && r && r.ok) {
    await new Promise((res) => setTimeout(res, 350)); /* UI tepkisi otursun */
    const after = await screenSignature();
    const ratio = computeruse.signatureDiff(before, after);
    if (ratio != null) {
      r.changed = ratio >= 0.02;
      r.changeRatio = Number(ratio.toFixed(3));
      if (!r.changed && ['click', 'dblclick', 'rightclick', 'type'].includes(opName)) {
        r.warning =
          'ekranda görünür değişiklik yok — aksiyon etkisiz olabilir (yanlış pencere/hedef ya da odak kaybı). ' +
          'computer_look ile durumu kontrol et; focus ile pencereyi öne getirip tekrar dene.';
      }
    }
  }
  return r;
}

ipcMain.handle('screen:capture', async () => {
  const image = await captureScreenDataUrl();
  return image ? { ok: true, image } : { ok: false, error: 'ekran görüntüsü alınamadı' };
});

/* #26 ajanın send_file aracı: dosyayı doğru kanala (WA veya chat) ulaştırır.
   Paralel ajan işiyse parent sohbete, masaüstünde dosya kartı olarak düşer.
   WhatsApp hedefinde resim/video/ses → medya mesajı, PDF/belge → doğru
   mimetype ile belge mesajı olarak gider; LID adresi patlarsa gerçek numaraya
   (@s.whatsapp.net) tek kez düşülür, yine başarısızsa ajan'a HATA döner. */
const FILE_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const FILE_MIME = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
  '.apk': 'application/vnd.android.package-archive',
};
function mimeForFile(ext) {
  return FILE_MIME[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

async function deliverFile(sessionId, filePath, caption) {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(engine.workspace || process.cwd(), filePath);
    if (!fs.existsSync(abs)) return { ok: false, error: 'dosya bulunamadı: ' + abs };
    /* GÜVENLİK: sır/anahtar dosyaları dışa gönderilmez (settings.json,
       wa-auth, .ssh, .env, *.pem...). Ajan bunu kullanıcıya söylesin. */
    if (fsguard.isSensitiveSendPath(abs)) {
      log.warn('sec', `send_file engellendi (hassas yol): ${abs}`);
      return { ok: false, error: 'güvenlik: hassas dosya (sır/anahtar) dışa gönderilmedi: ' + path.basename(abs) };
    }
    const name = path.basename(abs);
    const ext = path.extname(abs).toLowerCase();
    let sid = String(sessionId || '');
    try {
      const job = engine.listBgJobs().find((j) => j.id === sid);
      if (job && job.parentId) sid = job.parentId; // paralel ajan → parent sohbet
    } catch {}
    /* BEAST MOBILE: dosyayı TELEFONA da gönder — ajanın attığı PDF/dosya
       telefonda görünür, kaydedilir ve açılabilir. (dataUrl ile; 3MB üstü
       sadece künye gider — WS yük sınırı) */
    try {
      const st = fs.statSync(abs);
      const mime = mimeForFile(ext);
      const ev = { sessionId: sid, type: 'file', name, mime, size: st.size, caption: caption || '', path: abs };
      if (st.size <= 3 * 1024 * 1024) {
        const buf = fs.readFileSync(abs);
        ev.dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      } else {
        ev.tooBig = true;
      }
      mobileWs.broadcast(ev);
    } catch {}
    /* KALICI KAYIT: dosya künyesi kuyrukta bekler; tur 'done' olunca oturuma
       sessiz yazılır (tur ortasında inject LLM tool zincirini bozar) —
       sohbete yeniden girince dosya kartı WhatsApp gibi KAYBOLMAZ */
    try {
      if (sid && sessionFileAlive(sid)) {
        queueFileRecord(sid, {
          text: '📄 ' + name + (caption ? ' — ' + caption : ''),
          attachments: [{ type: 'file', name, mime: mimeForFile(ext), size: (fs.statSync(abs) || {}).size || 0, caption: caption || '' }],
        });
      }
    } catch {}
    /* WhatsApp hedefi: bu oturum bir WA sohbetine bağlıysa oraya gönder.
       Birden çok sohbet aynı oturuma bağlıysa EN SON yazan kazanır. */
    const jid = waReplyJid(sid);
    if (jid && wa) {
      const buf = fs.readFileSync(abs);
      const sendMedia = async (target) =>
        FILE_IMAGE_EXT.has(ext)
          ? await wa.sendImage(target, buf, caption || name)
          : await wa.sendFile(target, buf, name, caption, mimeForFile(ext));
      let ok = false;
      try { ok = !!(await sendMedia(jid)); } catch {}
      if (!ok) {
        /* LID/adres fallback: bilinen gerçek numaraya (@s.whatsapp.net) dene */
        const pn = waJidPn.get(jid);
        const pnJid = pn ? `${pn}@s.whatsapp.net` : '';
        if (pnJid && pnJid !== jid) {
          try { ok = !!(await sendMedia(pnJid)); } catch {}
          if (ok) waLog(`dosya fallback → ${waPrettyJid(pnJid)} (lid/pn denemelerinden sonra)`);
        }
      }
      if (ok) return { ok: true, channel: 'whatsapp', name };
      /* WA hedefi var ama gönderim başarısız — sessizce "masaüstüne düştü"
         SANMA: ajan durumu bilsin, kullanıcıya söyleyip tekrar deneyebilsin */
      waLog(`dosya gönderim HATA → ${waPrettyJid(jid)} "${name}"`);
      return {
        ok: false,
        error: `whatsapp gönderimi başarısız: ${name} — bağlantı/medya hatası; biraz sonra tekrar dene ya da kullanıcıya söyle`,
      };
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
