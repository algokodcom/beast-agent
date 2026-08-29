'use strict';

/* OFFLINE MESAJ KUYRUĞU (FEATURE 2)
   İnternet/elektrik kesintisinde WhatsApp mesajları kaybolmasın:
   - Gönderilemeyen mesaj dosyaya yazılır (%APPDATA%\beast\message_queue.json)
   - Bağlantı gelince sırayla gönderilir, gönderilenler kuyruktan silinir
   - Retry: 30sn → 1dk → 5dk → 15dk → 30dk backoff; 5 denemeden sonra "failed"
   - Dosya tabanlı olduğu için elektrik kesintisinde veri korunur */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_QUEUE = 100; // kuyruk üst sınırı — taşarsa eski (öncelikle işlenmiş) kayıtlar düşer
const MAX_RETRY = 5;
const BACKOFF_MS = [30e3, 60e3, 300e3, 900e3, 1800e3]; // 30sn, 1dk, 5dk, 15dk, 30dk

function root() {
  if (process.env.BEAST_DATA) return process.env.BEAST_DATA;
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, 'beast')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'beast');
}

function file() {
  return path.join(root(), 'message_queue.json');
}

let CACHE = null;

function load() {
  if (CACHE) return CACHE;
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    CACHE = Array.isArray(j.items) ? j.items : [];
  } catch {
    CACHE = [];
  }
  return CACHE;
}

function save() {
  try {
    fs.mkdirSync(root(), { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ items: CACHE }, null, 2));
    fs.renameSync(tmp, file()); // atomik yazım — yarı kalmış dosya kirliliği olmaz
  } catch {}
}

/* Gönderilemeyen mesajı kuyruğa al */
function add({ to, body }) {
  const list = load();
  const item = {
    id: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    to: String(to || ''),
    body: String(body || '').slice(0, 4000),
    status: 'pending',
    retry_count: 0,
    nextAt: 0, // hemen denenmeye hazır
  };
  list.push(item);
  /* taşma koruması: önce sent/failed kayıtlarını, sonra en eski pending'i düşür */
  while (list.length > MAX_QUEUE) {
    const idx = list.findIndex((x) => x.status === 'sent' || x.status === 'failed');
    if (idx >= 0) list.splice(idx, 1);
    else list.shift();
  }
  save();
  return item;
}

/* Şu an denenecek kuyruk öğeleri (backoff süresi dolmuş pending'ler, sırayla) */
function due() {
  const now = Date.now();
  return load()
    .filter((x) => x.status === 'pending' && (x.nextAt || 0) <= now)
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

/* Gönderildi → kuyruktan sil */
function markSent(id) {
  const list = load();
  const idx = list.findIndex((x) => x.id === id);
  if (idx >= 0) {
    list.splice(idx, 1);
    save();
  }
}

/* Deneme başarısız → backoff planla; 5 denemeden sonra "failed" (gonderilemedi) */
function bumpRetry(id) {
  const it = load().find((x) => x.id === id);
  if (!it) return;
  it.retry_count = (it.retry_count || 0) + 1;
  if (it.retry_count >= MAX_RETRY) {
    it.status = 'failed';
    it.failedAt = new Date().toISOString();
  } else {
    it.nextAt = Date.now() + BACKOFF_MS[it.retry_count - 1];
  }
  save();
}

function pendingCount() {
  return load().filter((x) => x.status === 'pending').length;
}

function stats() {
  const l = load();
  return {
    pending: l.filter((x) => x.status === 'pending').length,
    failed: l.filter((x) => x.status === 'failed').length,
    total: l.length,
  };
}

/* bağlantı geri gelince testler için */
function _reset() {
  CACHE = null;
}

module.exports = { MAX_QUEUE, MAX_RETRY, BACKOFF_MS, add, due, markSent, bumpRetry, pendingCount, stats, _reset, file };
