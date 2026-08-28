'use strict';

/* Merkezî log sistemi:
   - Günlük dosyalar: %APPDATA%\beast\logs\beast-YYYY-MM-DD.log
   - Bellekte ring buffer (UI'da hızlı gösterim için)
   - 14 günden eski günlük dosyaları saatlik temizlikle silinir
   Kullanım: const log = require('./logger'); log.info('wa', 'bağlandı'); */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'beast')
  : path.join(os.homedir(), 'AppData', 'Roaming', 'beast');
const LOG_DIR = path.join(ROOT, 'logs');
const KEEP_DAYS = 14;
const RING_MAX = 1000;

const ring = [];
let lastCleanup = 0;

function fileFor(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return path.join(LOG_DIR, `beast-${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}.log`);
}

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < 60 * 60 * 1000) return;
  lastCleanup = now;
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      const m = /^beast-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(f);
      if (!m) continue;
      const age = (now - Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) / 86400000;
      if (age > KEEP_DAYS) { try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch {} }
    }
  } catch {}
}

function write(level, tag, msg) {
  const line =
    `[${new Date().toISOString()}] [${String(level).toUpperCase()}] [${tag}] ` +
    String(msg == null ? '' : msg).replace(/\r?\n/g, ' | ').slice(0, 4000);
  ring.push(line);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    cleanup();
    fs.appendFileSync(fileFor(), line + '\n');
  } catch {}
  return line;
}

const info = (tag, msg) => write('info', tag, msg);
const warn = (tag, msg) => write('warn', tag, msg);
const error = (tag, msg) => write('error', tag, msg);

/* Bugün + dünün son n satırı (UI ve hata raporları için) */
function tail(n = 300) {
  const lines = [];
  try { lines.push(...fs.readFileSync(fileFor(new Date(Date.now() - 86400000)), 'utf8').split('\n')); } catch {}
  try { lines.push(...fs.readFileSync(fileFor(), 'utf8').split('\n')); } catch {}
  return lines.filter((l) => l.trim()).slice(-Math.max(1, Number(n) || 300));
}

function dir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  return LOG_DIR;
}

function recent() {
  return ring.slice(-200);
}

function clear() {
  try { ring.length = 0; } catch {}
  /* tail() bugün + dünün dosyasını okur; ikisini de boşalt ki
     UI'daki "Logları Temizle" gerçekten temizlesin */
  try {
    for (const d of [new Date(), new Date(Date.now() - 86400000)]) {
      try { fs.writeFileSync(fileFor(d), ''); } catch {}
    }
  } catch {}
  return true;
}

module.exports = { info, warn, error, tail, dir, recent, clear, LOG_DIR };
