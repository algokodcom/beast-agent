'use strict';

/* Merkezî log sistemi:
   - Günlük dosyalar: %APPDATA%\beast\logs\beast-YYYY-MM-DD.log
   - Bellekte ring buffer (UI'da hızlı gösterim için)
   - 14 günden eski günlük dosyaları saatlik temizlikle silinir
   Kullanım: const log = require('./logger'); log.info('wa', 'bağlandı'); */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = process.env.BEAST_DATA
  ? process.env.BEAST_DATA
  : process.env.APPDATA
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

/* ---------- LOG ZEKASI: desen analizi + zaman penceresi sayacı ---------- */

/* Satırı parçala: [ts] [LEVEL] [tag] msg — biçime uymayan satır null */
function parseLine(line) {
  const m = /^\[([^\]]+)\] \[([A-Za-z]+)\] \[([^\]]+)\] (.*)$/.exec(String(line || ''));
  if (!m) return null;
  const ts = Date.parse(m[1]);
  return { ts: Number.isFinite(ts) ? ts : null, level: m[2].toLowerCase(), tag: m[3], msg: m[4] };
}

/* Değişken kısımları maskele → aynı hatanın farklı örnekleri tek desene düşer */
function normalizeMsg(msg) {
  return String(msg || '')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/(["'`]).*?\1/g, '<q>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/* Tail'i tara → seviye sayıları, en çok tekrarlanan desenler, son kayıtlar.
   opts: { last, level: 'error'|'warn'|'info', query: regex } */
function analyze(opts = {}) {
  const last = Math.min(Math.max(Number(opts.last) || 1500, 1), 5000);
  const level = String(opts.level || '').toLowerCase();
  let query = null;
  if (opts.query !== undefined && opts.query !== null && String(opts.query).trim() !== '') {
    try {
      query = new RegExp(String(opts.query), 'i');
    } catch {
      return { ok: false, error: 'geçersiz regex (query)' };
    }
  }
  const counts = {};
  const groups = new Map();
  const recent = [];
  let scanned = 0;
  for (const raw of tail(last)) {
    const p = parseLine(raw);
    if (!p) continue;
    if ((level === 'error' || level === 'warn' || level === 'info') && p.level !== level) continue;
    if (query && !(query.test(p.msg) || query.test(p.tag))) continue;
    scanned++;
    counts[p.level] = (counts[p.level] || 0) + 1;
    const pattern = normalizeMsg(p.msg);
    const key = p.tag + ' :: ' + pattern;
    const g = groups.get(key);
    if (g) {
      g.count++;
      g.levels[p.level] = (g.levels[p.level] || 0) + 1;
      if (p.ts && (!g.firstTs || p.ts < g.firstTs)) g.firstTs = p.ts;
      if (p.ts && (!g.lastTs || p.ts > g.lastTs)) g.lastTs = p.ts;
    } else {
      groups.set(key, {
        pattern,
        tag: p.tag,
        count: 1,
        levels: { [p.level]: 1 },
        firstTs: p.ts,
        lastTs: p.ts,
        sample: p.msg.slice(0, 300),
      });
    }
    if (recent.length < 12) recent.push(p);
  }
  const top = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)
    .map((g) => ({
      pattern: g.pattern,
      tag: g.tag,
      count: g.count,
      levels: g.levels,
      first: g.firstTs ? new Date(g.firstTs).toISOString() : null,
      last: g.lastTs ? new Date(g.lastTs).toISOString() : null,
      sample: g.sample,
    }));
  return {
    ok: true,
    scanned,
    counts,
    top,
    recent: recent.map((p) => ({
      ts: p.ts ? new Date(p.ts).toISOString() : null,
      level: p.level,
      tag: p.tag,
      msg: p.msg.slice(0, 300),
    })),
  };
}

/* Son windowMin dakikadaki eşleşen kayıt sayısı (izleyici + hızlı kontrol için).
   opts: { windowMin, level: 'error'|'warn'|'info', re: regex } */
function countSince(opts = {}) {
  const windowMin = Math.min(Math.max(Number(opts.windowMin) || 10, 1), 720);
  const level = String(opts.level || 'error').toLowerCase();
  let re = null;
  if (opts.re !== undefined && opts.re !== null && String(opts.re).trim() !== '') {
    try {
      re = new RegExp(String(opts.re), 'i');
    } catch {
      re = null;
    }
  }
  const since = Date.now() - windowMin * 60000;
  let n = 0;
  for (const raw of tail(4000)) {
    const p = parseLine(raw);
    if (!p || p.ts === null || p.ts < since) continue;
    if ((level === 'error' || level === 'warn' || level === 'info') && p.level !== level) continue;
    if (re && !(re.test(p.msg) || re.test(p.tag))) continue;
    n++;
  }
  return n;
}

module.exports = {
  info,
  warn,
  error,
  tail,
  dir,
  recent,
  clear,
  analyze,
  countSince,
  parseLine,
  normalizeMsg,
  LOG_DIR,
};