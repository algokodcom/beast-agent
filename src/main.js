'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, shell, dialog, Tray, Menu, nativeImage, desktopCapturer, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Engine = require('./agent/engine');
const { loadBeastConfig } = require('./agent/config');
const memory = require('./agent/memory');
const skillsMod = require('./agent/skills');
const { WhatsAppBridge } = require('./agent/whatsapp');
const cron = require('./cron');
const watchers = require('./agent/watchers');
const usageMod = require('./agent/usage');
const bus = require('./agent/bus');
const computeruse = require('./agent/computeruse');
const log = require('./agent/logger');

/* #3 otomatik updater: sessiz — indirir, kapanışta kurar, kullanıcıya soru sormaz.
   Paketlenmemiş (npm start) modda devre dışı. */
let autoUpdater = null;
try { if (app.isPackaged) autoUpdater = require('electron-updater').autoUpdater; } catch {}

function startAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  try {
    autoUpdater.autoDownload = true;          // sessiz indir
    autoUpdater.autoInstallOnAppQuit = true;  // kapanışta sessiz kur
    autoUpdater.logger = {
      info: (m) => waLog('[UPD] ' + m),
      warn: (m) => waLog('[UPD] ' + m),
      error: (m) => waLog('[UPD] ' + m),
      debug: () => {},
    };
    autoUpdater.on('update-downloaded', () => {
      try { fs.appendFileSync(path.join(APP_DIR, 'wa.log'), `[${new Date().toISOString()}] [UPD] güncelleme indirildi — kapanışta kurulacak\n`); } catch {}
    });
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    check();
    setInterval(check, 6 * 60 * 60 * 1000); // 6 saatte bir sessiz kontrol
  } catch {}
}
const { htmlToText, setExaKey, setTinyfishKey } = require('./agent/tools');
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
try { ImapFlow = require('imapflow'); } catch {}
try { nodemailer = require('nodemailer'); } catch {}

const APP_DIR = path.join(app.getPath('appData'), 'beast');
const SESSIONS_DIR = path.join(APP_DIR, 'sessions');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const SETTINGS_BACKUP_FILE = path.join(APP_DIR, 'settings.backup.json');
const WA_AUTH_DIR = path.join(APP_DIR, 'wa-auth');
const WA_CHATS_FILE = path.join(APP_DIR, 'wa-chats.json');
const FALLOUT_CRASH_FILE = path.join(APP_DIR, 'fallout-crash.json');

for (const d of [APP_DIR, SESSIONS_DIR]) fs.mkdirSync(d, { recursive: true });

let win = null;
let engine = null;
let settings = loadSettings();
ensureBeastCode();
startHealthServer(); /* splash/boot aşamasından itibaren /health ayakta */
try { setExaKey(settings.exaKey || null); } catch {}
try { setTinyfishKey(settings.tinyfishKey || null); } catch {}
let wa = null;
let waChats = new Map(); // jid -> aktif session id
let waHistory = new Map(); // jid -> [sid,...] bu sohbete ait tüm oturumlar
let waJidPn = new Map(); // jid -> gerçek telefon numarası (LID fallback için)
const WA_HISTORY_CAP = 20;
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
  }
} catch {}

function saveWaChats() {
  try {
    fs.writeFileSync(
      WA_CHATS_FILE,
      JSON.stringify({
        chats: Object.fromEntries(waChats),
        history: Object.fromEntries([...waHistory.entries()].map(([j, a]) => [j, a.slice(-WA_HISTORY_CAP)])),
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

async function transcribeAudio(buf /* , mimetype */) {
  try {
    const audio = await decodeAudioToPcm16k(buf);
    if (!audio || !audio.length) return null;
    const asr = await ensureStt();
    const out = await asr(audio, { language: 'turkish', task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
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



function waSlashHelp() {
  return [
    '*Beast komutları*',
    '• /help – bu liste',
    '• /new – yeni oturum aç (kod verilir)',
    '• /open <kod> – o koddaki oturuma geç',
    '• /sessions – bu sohbetin oturumları',
    '• /stop – koşan işleri durdur (ajanlar+turlar; cron/izleyici/olay sürer)',
    '• /start – durdurulan servisleri devam ettir',
    '• /restart – uygulamayı yeniden başlat',
    '• /change – modelleri listele (/change 5 ile 5.modele geç)',
    '• /notes – bu oturumun notlarını göster',
    '• /notify on|off – hata mail bildirimini aç/kapa',
    '• /think <0-5> – düşünme seviyesi (0 kapalı · 1 low · 2 medium · 3 high · 4 xhigh · 5 max)',
    '• /clear – bu oturumun geçmişini temizle',
    '• /screenshot – masaüstü ekran görüntüsünü gönder',
    '• /rule <metin> – kalıcı kural ekle (/rules: liste)',
    '• /allow <isim> <numara> – WhatsApp allow listesine kişi ekle (örn: /allow batu 905414178456)',
    '• /block – allow listesini numaralarıyla listele (/block 3: 3. kişiyi çıkar; 1 = sahip, silinemez)',
    '• /approve – bekleyen riskli işlemi onayla (/approve always: bir daha sorulmasın · /deny: reddet)',
    '• /model – aktif modeli göster (/model <isim> ile değiştir)',
    '• /skills – kurulu skill\u2019ler',
    '• /usage – bugünkü kullanım',
    '• /backup – tüm veriyi ŞİFRELİ yedekle (Beast Kodu imzalı, Masaüstü\\Beast-Backups)',
    '• /status – bağlantı ve servis durumu',
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
  if (!servicesPaused) return;
  try { cron.init({ onFire: cronFire }); } catch {}
  try { watchers.start({ onTrigger: watcherFire }); } catch {}
  try { startEventBus(); } catch {}
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
async function tryWaSlash(jid, rawText, senderNum) {
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
    } else if (cmd === 'think') {
      const r = arg ? applyThinkLevel(arg) : null;
      out = r && r.error ? r.error : r ? r.text : thinkStatusText();
    } else if (cmd === 'stop') {
      /* /stop: koşan paralel ajanlar + turlar + kuyruklar; cron/izleyici/olay SÜRER */
      const stopped = stopEverything();
      out =
        `*Durdu* — ${stopped} koşan iş kesildi.\n` +
        `Paralel ajanlar ve bekleyen kuyruklar temizlendi. Cron, izleyici ve olay merkezi çalışmaya devam ediyor.\n` +
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
    } else {
      out = `Bilinmeyen komut: /${cmd}\nListe için /help yaz.`;
    }
  } catch (e) {
    out = 'Komut hatası: ' + String((e && e.message) || e);
  }
  if (out) await wa.send(jid, out).catch(() => {});
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
  const merged = { text: '', media: null, isGroup: false, participant: '', mentioned: false };
  let senderNum = '';
  /* push tarafıyla AYNI alan adı: { payload, senderNum } */
  for (const { payload, senderNum: sn } of q.payloads) {
    if (payload.text) merged.text += (merged.text ? '\n' : '') + payload.text;
    if (payload.media && !merged.media) merged.media = payload.media;
    if (payload.isGroup) merged.isGroup = true;
    if (payload.participant) merged.participant = payload.participant;
    if (payload.mentioned) merged.mentioned = true;
    if (!senderNum && sn) senderNum = sn;
  }
  try {
    await processWaMessage(jid, merged, senderNum);
  } catch (e) {
    waLog(`waFlush/processWaMessage hata: ${String((e && e.stack) || e)}`);
  }
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
      let uids = opts.unread ? await client.search({ seen: false }) : await client.search({ all: true });
      uids = Array.isArray(uids) ? uids.slice(-limit) : [];
      const messages = [];
      for await (const m of client.fetch(uids, { uid: true, envelope: true })) {
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
      for await (const m of client.fetch([Number(uid)], { uid: true, source: true })) {
        const raw = m.source.toString('utf8');
        const bodyPart = raw.split(/\r?\n\r?\n/).slice(1).join('\n\n') || raw;
        const text = htmlToText(bodyPart);
        return { ok: true, uid: Number(uid), content: String(text || '').slice(0, 8000) };
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
async function handleWaIncoming(jid, payload, senderNum) {
  try {
    if (!engine) return;
    if (typeof payload === 'string') payload = { text: payload };
    const isGroup = !!payload.isGroup || jid.endsWith('@g.us');

    /* slash komutları: DM'de her zaman; grupta sadece bot mention edildiyse */
    const txt0 = String(payload.text || '').trim();
    if (txt0.startsWith('/') && !txt0.includes('\n') && (!isGroup || payload.mentioned)) {
      if (await tryWaSlash(jid, txt0, senderNum)) return;
    }

    if (isGroup) {
      const g = settings.waGroups || {};
      if (!g.enabled) return;
      if (g.mentionOnly !== false && !payload.mentioned) return;
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
   bilinen gerçek numaraya (@s.whatsapp.net) tek kez düşer. Sonucu loglar. */
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
  waLog(`out BAŞARISIZ jid=${jid} — send-error loguna bak`);
  return false;
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
  const perm = isGroup ? 'all' : hit.perm || (hit.lockdown ? 'chat' : 'all');
  engine.setSessionPerm(sid, perm);
  waLog(`perm=${perm} sid=${sid}`);

  const participantName = payload.participant ? '+' + String(payload.participant).split('@')[0].split(':')[0] : '';
  /* #v13.1 rol: SAHİP vs MİSAFİR — ajan kime konuştuğunu net bilsin */
  const isOwner = !isGroup && !!hit.owner;
  const roleTag = isOwner
    ? 'SAHİBİN (talepleri önceliklidir)'
    : 'MİSAFİR (izinli ama sahibin sözü önceliklidir)';
  const label = isGroup
    ? `Grup ${jid.split('@')[0]}${participantName ? ' · ' + participantName : ''}`
    : hit.name
      ? `${hit.name} (+${senderNum || '?'}) — ${roleTag}`
      : `+${senderNum || '?'} — ${roleTag}`;
  let text = `[WhatsApp${isGroup ? ' grup' : ''} — gönderen: ${label}]`;
  if (!isGroup && !isOwner) {
    text += `\n[NOT: Bu kişi SAHİP DEĞİL, misafirdir. Sahibin ayarlarını/verilerini değiştirme; kalıcı hafızaya misafire özel bilgi yazma.]`;
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
  engine.send(sid, { text: text.slice(0, 8000), attachments });
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
    roleModels: settings.roleModels || {},
    deletedModels: settings.deletedModels || [],
    lockdown: !!settings.waLockdown,
    ceoMode: settings.ceoMode !== false,
    thinkLevel: settings.thinkLevel || 0,
    fallout: settings.fallout || null,
    limits: settings.limits || null,
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
      openUrl: (u, s) => browserNavigate(u, s),
      search: (q, s) => browserSearch(q, s),
      readText: (s) => browserRead(s),
      screenshot: (s) => browserScreenshot(s),
      snapshot: (s) => browserSnapshot(s),
      act: (k, a, s) => browserAct(k, a, s),
    },
    emit: (ev) => {
      if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev);
      flushDesktopOnDone(ev); /* biriken desktop mesajlarını sıraya bas */
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
    const exists = engine.listSessions().some((s) => s.id === st.sessionId);
    const sid = exists ? st.sessionId : engine.createSession().id;
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
    if (cfg.enabled === false) return;
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
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  /* npm (global) kurulumda masaüstü kısayolu — yoksa bir kez oluşturulur.
   (NSIS packaged modda kısayolu electron-builder zaten yapar.) */
function ensureDesktopShortcut() {
  try {
    const desktop = app.getPath('desktop');
    const lnk = path.join(desktop, 'Beast Agent.lnk');
    if (fs.existsSync(lnk)) return;
    const ok = shell.writeShortcutLink(lnk, 'create', {
      target: process.execPath,
      args: app.getAppPath(),
      cwd: app.getAppPath(),
      description: 'Beast Agent — hızlı, hafif ve becerikli',
      icon: process.execPath,
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
      try {
        // portable exe Temp'e açılır; gerçek yolu PORTABLE_EXECUTABLE_FILE verir
        const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
        app.setLoginItemSettings({
          openAtLogin: true,
          path: exe,
          args: ['--hidden'],
        });
        log.info('main', `Startup kaydı açık: ${exe} (--hidden, açılışta tepside)`);
      } catch (e) {
        log.error('main', 'Startup kaydı başarısız: ' + String((e && e.message) || e));
      }
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
    createWindow();
    log.info('main', 'Beast Agent başlatıldı');
    createTray();
    cron.init({ onFire: cronFire });
    watchers.start({ onTrigger: watcherFire });
    startEventBus();
    maybeRunWhereWasI();
    falloutResume();
    startAutoUpdater(); // #3 sessiz güncelleme

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

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    app.on('before-quit', () => {
      app.isQuitting = true;
      flushBrowserStorage(); // x.com/google oturumları (cookies) diske yazılsın
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
/* Tarayıcı state: visible=false → ajanlar GİZLİ kullanır (headless);
   göz ikonuyla görünür mod açılır. open=view aktif, visible=panelde görünürlük */
const browser = { view: null, open: false, visible: false, width: 0, attached: false, started: false };

function browserEmit(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', { type: 'browser', visible: browser.visible, ...payload });
}

function browserWidthFor(w) {
  return Math.max(380, Math.min(800, Math.floor(w * 0.46)));
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
  const shownWidth = Math.min(browser.width, Math.max(320, w - 320));
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
  } catch {}
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) wc.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  // Tarayıcı kapalıyken olayların UI'ı geri açmamasını garantile
  const notify = (extra) => {
    if (browser.open && win && !win.isDestroyed()) {
      browserEmit({ open: true, width: browser.width, ...extra });
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

  // AÇMA — görünürlük: kullanıcı kendi açtıysa (forceVisible) MUTLAKA görünür;
  // ajan açtıysa göz ikonu tercihine bak (varsayılan: GİZLİ/headless)
  browser.open = true;
  browser.visible = forceVisible === true ? true : settings.browserHeadless === false;
  ensureBrowser();
  if (!browser.started) {
    browser.started = true;
    browser.view.webContents.loadURL(BROWSER_START_URL).catch(() => {});
  }
  layoutBrowser();
  let url = '';
  try { url = browser.view.webContents.getURL(); } catch {}
  browserEmit({ open: true, width: browser.width, url });
}

async function browserNavigate(raw, signal) {
  let url = String(raw || '').trim();
  if (!url) return { ok: false, error: 'boş adres' };
  if (!/^https?:\/\//i.test(url)) {
    // kelime ise arama, alan adıysa doğrudan aç
    url = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(url)
      ? 'https://' + url
      : 'https://duckduckgo.com/?q=' + encodeURIComponent(url);
  }
  setBrowserOpen(true);
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
  browserEmit({ open: true, width: browser.width, url: finalUrl });
  flushBrowserStorage(); // oturum çerezleri diske — ani kapanışta kaybolmasın
  return { ok: true, url: finalUrl, title };
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
async function browserSearch(query, signal) {
  try {
    if (!win || win.isDestroyed()) return null;
    if (signal && signal.aborted) return null;
    const q = String(query || '').trim();
    if (!q) return null;
    setBrowserOpen(true);
    const wc = browser.view && browser.view.webContents;
    if (!wc) return null;

    /* fetch() same-origin olsun diye önce google.com kökü yüklü olsun */
    let cur = '';
    try { cur = wc.getURL() || ''; } catch {}
    if (!cur.startsWith('https://www.google.com')) {
      await browserNavigate('https://www.google.com/', signal);
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
      await browserNavigate(
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

    if (!results.length && !parsed.ai) return null;
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
  const sel='a[href],button,input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="tab"],[contenteditable="true"],summary';
  const els=[...document.querySelectorAll(sel)];
  window.__beMap={};
  const lines=[];
  let i=0;
  for(const e of els){
    if(!__vis(e)) continue;
    if(e.disabled||e.getAttribute('aria-disabled')==='true') continue;
    i++;
    window.__beMap[i]=e;
    const tag=e.tagName.toLowerCase();
    const type=e.getAttribute('type');
    let s='['+i+'] <'+tag+(type?' type='+type:'')+'>';
    const l=__label(e);
    if(l) s+=' "'+l+'"';
    if(tag==='input'&&(type==='text'||type==='email'||type==='password'||type==='search'||type==='tel'||type==='url'||type==='number')&&e.value) s+=' deger="'+String(e.value).slice(0,30)+'"';
    if(tag==='select'){s+=' secenekler=['+[...e.options].slice(0,6).map(o=>o.text.trim()).filter(Boolean).join('|').slice(0,60)+']';}
    lines.push(s);
    if(i>=100) break;
  }
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
    return `(function(){${BROWSER_JS_HELPERS}${resolveTarget};return new Promise((res)=>{try{
      const t=__target();
      if(!t) return res(JSON.stringify({typed:false,reason:'eleman bulunamadi (ref eski olabilir - browser_snapshot al)'}));
      const how=t.how,el=t.el;
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

    return {
      ok: true,
      action: kind,
      ...obj,
      url: wc.getURL(),
      title: wc.getTitle(),
      navigated,
      ...(navigated ? { note: 'sayfa degisti — gerekirse yeni browser_snapshot al' } : {}),
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
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: 'transparent',
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
    if (startHidden) win.hide();
    else win.show();
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

/* #3 log sistemi: ayarlar → Log sekmesinde görüntülenir */
ipcMain.handle('logs:get', () => {
  try { return { dir: log.dir(), lines: log.tail(600) }; } catch (e) { return { dir: '', lines: [], error: String(e && e.message || e) }; }
});
ipcMain.handle('logs:clear', () => {
  try { log.clear(); } catch {}
  return { ok: true };
});

ipcMain.handle('sessions:list', () => engine.listSessions());
ipcMain.handle('sessions:create', () => engine.createSession());
ipcMain.handle('sessions:open', (_e, id) => engine.openSession(id));
ipcMain.handle('sessions:delete', (_e, id) => engine.deleteSession(id));

ipcMain.handle('agent:send', (_e, { sessionId, text }) => {
  const raw = text && typeof text === 'object' ? String(text.text || '') : String(text ?? '');
  const t = raw.trim();
  if (t === '/stop' || t === '/start') {
    handleGlobalStopStart(sessionId, t);
    return true;
  }
  if (t === '/restart') {
    handleRestart(sessionId);
    return true;
  }
  if (t === '/think' || t.startsWith('/think ')) {
    const arg = t.slice(6).trim();
    const r = arg ? applyThinkLevel(arg) : null;
    desktopEcho(sessionId, t, r && r.error ? r.error : r ? r.text : thinkStatusText());
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
  setTimeout(() => {
    try { app.relaunch(); } catch {}
    try { app.exit(0); } catch {}
  }, 800);
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
      'Paralel ajanlar ve bekleyen kuyruklar temizlendi. Cron, izleyici ve olay merkezi çalışmaya devam ediyor.\n' +
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
  return engine.interrupt(sessionId);
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
  engine.send(sid, mergedAtts ? { text: mergedText, attachments: mergedAtts } : mergedText);
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

ipcMain.handle('model:set', (_e, sel) => {
  settings.modelOverride = sel;
  saveSettings();
  engine.setModelOverride(sel);
  return engine.publicState();
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
ipcMain.handle('agents:cancel', (_e, id) => ({ ok: engine.interrupt(String(id || '')) }));
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

/* #5 "nerede kaldım" */
ipcMain.handle('wherewasi:get', () => whereWasISummary());
ipcMain.handle('wherewasi:set', (_e, cfg) => {
  settings.whereWasI = { enabled: !!(cfg && cfg.enabled) };
  saveSettings();
  return settings.whereWasI;
});

/* WhatsApp grup ayarı: { enabled, mentionOnly } */
ipcMain.handle('wa:groups:get', () => settings.waGroups || { enabled: false, mentionOnly: true });
ipcMain.handle('wa:groups:set', (_e, cfg) => {
  settings.waGroups = {
    enabled: !!(cfg && cfg.enabled),
    mentionOnly: !(cfg && cfg.mentionOnly === false),
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

/* #STT: sohbet mikrofonu — MediaRecorder sesini (webm/opus) yerel whisper'a çevir */
ipcMain.handle('stt:transcribe', async (_e, b64) => {
  try {
    const buf = Buffer.from(String(b64 || '').split(',').pop() || '', 'base64');
    if (!buf.length) return { ok: false, error: 'boş ses kaydı' };
    const text = await transcribeAudio(buf);
    return text ? { ok: true, text } : { ok: false, error: 'konuşma algılanamadı' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
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

function cronFire(job) {
  try {
    let sid = job.sessionId;
    const exists = sid && engine.listSessions().some((s) => s.id === sid);
    if (!exists) {
      const s = engine.createSession();
      sid = s.id;
      cron.update(job.id, { sessionId: sid });
    }
    engine.send(sid, {
      text: `[cron: ${job.name}]\n${job.prompt}`,
    });
  } catch {}
  cronEmit();
}

/* İzleyici tetiklendiğinde ilgili sohbete kullanıcı mesajı gibi düşer */
function watcherFire(w, value) {
  try {
    watcherLog(`tetiklendi id=${w.id} name="${w.name}" kind=${w.kind} op=${w.op} value=${value}`);
    let sid = w.sessionId;
    const exists = sid && engine.listSessions().some((s) => s.id === sid);
    if (!exists) {
      sid = engine.createSession().id;
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
  /* kullanıcı kendi açıyor → mutlaka görünür */
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
    browserEmit({ open: true, width: browser.width });
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
  browserEmit({ open: true, width: browser.width });
  return { ok: true, width: browser.width };
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
let termChild = null;
const TERM_FWD_CAP = 1024 * 1024; /* iletilecek çıktı üst sınırı (1 MB) */

function termSend(ev) {
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev);
}

ipcMain.handle('terminal:toggle', () => {
  if (browser.open) setBrowserOpen(false);
  return { ok: true, cwd: (engine && engine.workspace) || settings.workspace || app.getPath('home') };
});

/* Git Bash kuruluysa yolunu bulur; yoksa null döner */
function findGitBash() {
  const cands = [];
  if (process.env['ProgramFiles']) cands.push(path.join(process.env['ProgramFiles'], 'Git', 'bin', 'bash.exe'));
  if (process.env['ProgramFiles(x86)']) cands.push(path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));
  if (process.env['LocalAppData']) cands.push(path.join(process.env['LocalAppData'], 'Programs', 'Git', 'bin', 'bash.exe'));
  cands.push('C:\\Program Files\\Git\\bin\\bash.exe');
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

ipcMain.handle('terminal:run', (_e, payload) => {
  const cmd = String((payload && payload.cmd) || '').trim();
  const shell = String((payload && payload.shell) || 'powershell');
  if (!cmd) return { ok: false, error: 'boş komut' };
  if (termChild) return { ok: false, error: 'önceki komut sürüyor — ■ ile durdurabilirsin' };
  const cwd = (engine && engine.workspace) || settings.workspace || app.getPath('home');
  const id = 't' + Date.now().toString(36);
  let file, args;
  if (shell === 'cmd') {
    file = 'cmd.exe';
    args = ['/d', '/s', '/c', cmd];
  } else if (shell === 'bash') {
    const bash = findGitBash();
    if (!bash) return { ok: false, error: 'Git Bash bulunamadı — Git for Windows kurulu mu? (https://git-scm.com)' };
    file = bash;
    args = ['-c', cmd];
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
  termChild = child;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let forwarded = 0;
  let capNotified = false;
  const push = (stream, d) => {
    if (forwarded > TERM_FWD_CAP) {
      if (!capNotified) {
        capNotified = true;
        termSend({ type: 'term-out', id, stream, chunk: '\n[beast] çıktı çok büyük — iletim durduruldu (komut sürüyor)\n' });
      }
      return;
    }
    forwarded += String(d).length;
    termSend({ type: 'term-out', id, stream, chunk: String(d) });
  };
  child.stdout.on('data', (d) => push('out', d));
  child.stderr.on('data', (d) => push('err', d));
  child.on('error', (err) => {
    if (termChild === child) termChild = null;
    termSend({ type: 'term-end', id, code: -1, error: String((err && err.message) || err) });
  });
  child.on('close', (code) => {
    if (termChild === child) termChild = null;
    termSend({ type: 'term-end', id, code: code == null ? -1 : code });
  });
  return { ok: true, id };
});

ipcMain.handle('terminal:stop', () => {
  if (!termChild) return { ok: false };
  try { spawn('taskkill', ['/pid', String(termChild.pid), '/T', '/F'], { windowsHide: true }); } catch {}
  return { ok: true };
});

/* düşünme (reasoning) seviyesi */
ipcMain.handle('think:set', (_e, v) => {
  setThinkLevel(v);
  return engine.publicState();
});

/* Exa web arama anahtarı (Ayarlar → Web Arama) */
ipcMain.handle('exa:get', () => {
  const k = settings.exaKey || '';
  return { set: !!k, masked: k ? '••••••••' + k.slice(-4) : '' };
});
ipcMain.handle('exa:set', (_e, key) => {
  const v = String(key || '').trim();
  if (v) {
    settings.exaKey = v;
    saveSettings();
    setExaKey(settings.exaKey);
  }
  const k = settings.exaKey || '';
  return { ok: true, set: !!k, masked: k ? '••••••••' + k.slice(-4) : '' };
});
ipcMain.handle('exa:clear', () => {
  settings.exaKey = '';
  saveSettings();
  setExaKey(null);
  return { ok: true, set: false, masked: '' };
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
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + p.key },
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

ipcMain.handle('custom:fetchModels', async (_e, { baseUrl, key }) => {
  try {
    let b = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(b)) return { ok: false, error: 'URL http(s) ile başlamalı' };
    const url = /\/v\d+$/.test(b) ? b + '/models' : b + '/v1/models';
    const res = await fetch(url, {
      headers: key ? { Authorization: 'Bearer ' + key } : {},
      signal: AbortSignal.timeout(15000),
    });
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
      out.push({ num: d, name, lockdown: perm === 'chat', perm, owner: isOwner });
    }
  }
  /* tek izinli kişi varsa MECBURİ sahip (kimseye seçtirmeden) */
  const nonStar = out.filter((o) => o !== '*');
  if (nonStar.length === 1 && !nonStar[0].owner) {
    nonStar[0].owner = true;
  }
  settings.waAllow = out;
  saveSettings();
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
