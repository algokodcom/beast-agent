'use strict';

/* Beast Olay Merkezi (#4 EventBus proaktif mod)
   Cron'suz olay mimarisi: kaynaklar olay üretir, abonelikler bildirim alır.

   Kaynaklar:
     mail:new       — IMAP IDLE (ayarlı hesapta yeni mail)
     fs:changed     — workspace fs.watch (dosya/klasör değişimi)
     webhook        — 127.0.0.1 POST /beast-event <token> {type,data}
     price:tick     — Binance miniTicker WebSocket (sembol ayarlı)
     wa:presence    — WhatsApp karşı taraf yazıyor/kaydediyor köprüsü

   Abonelik: { id, type, sessionId, op?, value?, cooldownMin?, path? }
   Eşleşme: type birebir; varsa sayısal op/value filtresi event.value üzerinde.
   Bildirim teslimi main'e devredilir (engine.send) — bus saf kalır. */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { beastRoot } = require('./memory');

function subsFile() {
  return path.join(beastRoot(), 'subscriptions.json');
}

let subs = []; // aktif abonelikler
let loaded = false;
let hooks = {}; // { notify(sub, event), log(line) }
let running = {};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(subsFile(), 'utf8'));
    subs = Array.isArray(raw.subscriptions) ? raw.subscriptions : [];
  } catch {
    subs = [];
  }
}

function save() {
  try {
    fs.mkdirSync(beastRoot(), { recursive: true });
    const tmp = subsFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ subscriptions: subs }, null, 2));
    fs.renameSync(tmp, subsFile());
  } catch {}
}

function log(line) {
  if (typeof hooks.log === 'function') hooks.log(`[BUS] ${line}`);
}

/* ---------- abonelik CRUD ---------- */

function listSubs() {
  load();
  return subs.map((s) => ({ ...s }));
}

function addSub({ type, sessionId, op, value, cooldownMin }) {
  load();
  const t = String(type || '').trim();
  if (!t) return { ok: false, error: 'type gerekli' };
  if (!sessionId) return { ok: false, error: 'sessionId gerekli' };
  const KNOWN = ['mail:new', 'fs:changed', 'webhook', 'price:tick', 'wa:presence'];
  if (!KNOWN.includes(t)) return { ok: false, error: `bilinmeyen olay tipi: ${t} (${KNOWN.join(', ')})` };
  const sub = {
    id: uid(),
    type: t,
    sessionId,
    op: ['lt', 'lte', 'gt', 'gte', 'eq'].includes(op) ? op : null,
    value: Number.isFinite(Number(value)) ? Number(value) : null,
    cooldownMin: Math.max(0, Math.min(Math.round(Number(cooldownMin ?? 10)) || 10, 1440)),
    createdAt: new Date().toISOString(),
    lastNotifiedAt: 0,
  };
  if ((t === 'price:tick') && sub.op && sub.value === null) {
    return { ok: false, error: 'fiyat aboneliğinde op verildiyse value de gerekli' };
  }
  subs.push(sub);
  save();
  log(`abonelik eklendi ${t} sid=${sessionId}`);
  return { ok: true, subscription: { ...sub } };
}

function removeSub(id) {
  load();
  const before = subs.length;
  subs = subs.filter((s) => s.id !== String(id));
  save();
  return { ok: subs.length < before };
}

/* ---------- eşleştirme + cooldown (saf, test edilebilir) ---------- */

function compareOp(op, a, b) {
  switch (op) {
    case 'lt': return a < b;
    case 'lte': return a <= b;
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'eq': return a === b;
    default: return false;
  }
}

/** Olay bu aboneliği tetikler mi + cooldown'a takıldı mı döner */
function decide(sub, event, now) {
  if (sub.type !== event.type) return { hit: false };
  if (sub.op !== null && sub.value !== null) {
    const v = Number(event.value);
    if (!Number.isFinite(v) || !compareOp(sub.op, v, sub.value)) return { hit: false };
  }
  const cd = (sub.cooldownMin || 0) * 60000;
  if (cd && now - (sub.lastNotifiedAt || 0) < cd) return { hit: true, cooled: true };
  return { hit: true, cooled: false };
}

/** Bir olayı tüm aboneliklere dağıt; tetiklenenleri döndürür */
function emitEvent(type, data = {}, now = Date.now()) {
  load();
  const event = { type, data, value: Number(data.value), at: now };
  const fired = [];
  for (const s of subs.slice()) {
    const d = decide(s, event, now);
    if (!d.hit || d.cooled) continue;
    s.lastNotifiedAt = now;
    fired.push(s);
    if (typeof hooks.notify === 'function') {
      try {
        hooks.notify({ ...s }, summarize(type, data));
      } catch {}
    }
  }
  if (fired.length) save();
  return fired.length;
}

function summarize(type, data) {
  switch (type) {
    case 'mail:new':
      return `[OLAY] Yeni e-posta geldi${data.from ? ': ' + data.from : ''}${data.subject ? ' — ' + data.subject : ''}. Kullanıcıya kısaca haber ver; email_read ile gövdeyi isteyebilir.`;
    case 'fs:changed':
      return `[OLAY] Workspace'te dosya değişimi: ${data.path || '?'}. Kullanıcıya kısaca haber ver.`;
    case 'webhook':
      return `[OLAY] Webhook: ${JSON.stringify(data).slice(0, 300)}. Kullanıcıya anlamlı biçimde raporla.`;
    case 'price:tick':
      return `[OLAY] Fiyat güncellemesi ${data.symbol || '?'}: ${data.price} (koşul sağlandı). Kullanıcıya hemen haber ver.`;
    case 'wa:presence':
      return `[OLAY] WhatsApp durum değişimi: ${data.status} (+${data.sender || '?'}). Kısa not düş.`;
    default:
      return `[OLAY] ${type}: ${JSON.stringify(data).slice(0, 200)}`;
  }
}

/* ---------- kaynaklar ---------- */

/* IMAP IDLE: yeni mailleri anında yakalar. Koparsa 60 sn sonra yeniden. */
async function startMailIdle(getCfg) {
  if (running.mailIdle) return;
  running.mailIdle = true;
  const attempt = async () => {
    while (running.mailIdle) {
      let ImapFlow = null;
      try {
        /* imapflow yeni sürümlerde named export ({ ImapFlow }) — her şekli çöz */
        const _if = require('imapflow');
        ImapFlow = (_if && (_if.ImapFlow || _if.default)) || (typeof _if === 'function' ? _if : null);
      } catch {
        ImapFlow = null;
      }
      if (!ImapFlow) {
        log('imapflow yok — mail:new kapalı');
        return;
      }
      const cfg = getCfg() || {};
      if (!cfg.host || !cfg.user || !cfg.pass) {
        log('mail credential yok — IDLE beklemeye çekildi');
        await sleep(120000);
        continue;
      }
      let client = null;
      try {
        client = new ImapFlow({
          host: cfg.host,
          port: Number(cfg.port) || 993,
          secure: true,
          auth: { user: cfg.user, pass: cfg.pass },
          logger: false,
        });
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        log('IMAP IDLE bağlı');
        /* IDLE akışı: EXISTS görünce kısa IDLE'dan çık, olay üret, tekrar gir */
        for (;;) {
          if (!running.mailIdle) break;
          const lockPromise = new Promise((resolve) => client.once && client.once('exists', resolve));
          // imapflow otomatik IDLE yapar; event tabanlı bekleme + periyodik nocop uyanma
          await Promise.race([lockPromise, sleep(5 * 60000)]);
          if (!running.mailIdle) break;
          emitEvent('mail:new', {}, Date.now());
        }
        try { lock.release(); } catch {}
        try { await client.logout(); } catch {}
      } catch (e) {
        log(`IDLE koptu: ${String((e && e.message) || e)} — 60 sn sonra yeniden`);
        try { if (client) await client.logout(); } catch {}
        await sleep(60000);
      }
    }
  };
  attempt().catch(() => {});
}

function stopMailIdle() {
  running.mailIdle = false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* fs.watch: workspace kökünde hafif izleme */
function startFsWatch(watchPath) {
  if (running.fsWatch) return;
  try {
    running.fsWatch = fs.watch(
      watchPath,
      { recursive: true },
      debounceEmit((eventType, filename) => {
        emitEvent('fs:changed', { eventType, path: String(filename || '') }, Date.now());
      }, 5000)
    );
    log(`fs.watch açık: ${watchPath}`);
  } catch (e) {
    log(`fs.watch hata: ${String((e && e.message) || e)}`);
  }
}

function stopFsWatch() {
  if (running.fsWatch) {
    try { running.fsWatch.close(); } catch {}
    running.fsWatch = null;
    log('fs.watch kapandı');
  }
}

/* aynı anda onlarca olayı tek bildirime indirger */
function debounceEmit(fn, ms) {
  let t = null;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    clearTimeout(t);
    t = setTimeout(() => {
      fn(...lastArgs);
      lastArgs = null;
    }, ms);
  };
}

/* local webhook: 127.0.0.1 bind, token doğrulaması zorunlu */
function startWebhook(port, token) {
  if (running.webhookServer) return;
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/beast-event')) {
      res.writeHead(404).end();
      return;
    }
    if (!token || req.headers['x-beast-token'] !== token) {
      res.writeHead(401).end('bad token');
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 100000) req.destroy();
    });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        emitEvent(String(j.type || 'webhook'), j.data ?? j, Date.now());
        res.writeHead(200).end('ok');
      } catch {
        res.writeHead(400).end('bad json');
      }
    });
  });
  try {
    server.listen(port, '127.0.0.1', () => log(`webhook dinliyor: 127.0.0.1:${port}/beast-event`));
    running.webhookServer = server;
  } catch (e) {
    log(`webhook başlatılamadı: ${String((e && e.message) || e)}`);
  }
}

function stopWebhook() {
  if (running.webhookServer) {
    try { running.webhookServer.close(); } catch {}
    running.webhookServer = null;
  }
}

/* fiyat feed'i: Binance miniTicker WS (örn PAXGUSDT ≈ altın peg'i) */
function startPriceFeed(symbol = 'PAXGUSDT') {
  if (running.priceWs) stopPriceFeed();
  let Ws;
  try {
    Ws = require('ws');
  } catch {
    log('ws modülü yok — fiyat feed kapalı');
    return;
  }
  const sym = String(symbol).toLowerCase();
  try {
    const ws = new Ws(`wss://stream.binance.com:9443/ws/${sym}@miniTicker`);
    ws.on('open', () => log(`fiyat WS açık: ${symbol}`));
    ws.on('message', (buf) => {
      try {
        const m = JSON.parse(buf.toString());
        const close = Number(m.c);
        if (Number.isFinite(close)) {
          emitEvent('price:tick', { symbol, price: close, value: close }, Date.now());
        }
      } catch {}
    });
    ws.on('error', (e) => log(`fiyat WS hata: ${String((e && e.message) || e)}`));
    ws.on('close', () => {
      if (running.priceWs === ws) {
        running.priceWs = null;
        if (running.priceWanted) setTimeout(() => startPriceFeed(symbol), 15000);
      }
    });
    running.priceWanted = true;
    running.priceSymbol = symbol;
    running.priceWs = ws;
  } catch (e) {
    log(`fiyat WS kurulamadı: ${String((e && e.message) || e)}`);
  }
}

function stopPriceFeed() {
  running.priceWanted = false;
  if (running.priceWs) {
    try { running.priceWs.close(); } catch {}
    running.priceWs = null;
  }
}

/* ---------- master ---------- */

function start(hooksIn, opts = {}) {
  hooks = { ...hooks, ...(hooksIn || {}) };
  load();
  const o = opts || {};
  if (o.mailIdle) startMailIdle(o.getCfg || (() => null));
  else stopMailIdle();
  if (o.fsWatch && o.workspace) startFsWatch(o.workspace);
  else stopFsWatch();
  if (o.webhookPort && o.webhookToken) startWebhook(o.webhookPort, o.webhookToken);
  else stopWebhook();
  if (o.priceSymbol) startPriceFeed(o.priceSymbol);
  else stopPriceFeed();
}

function stopAll() {
  stopMailIdle();
  stopFsWatch();
  stopWebhook();
  stopPriceFeed();
}

module.exports = {
  start,
  stopAll,
  listSubs,
  addSub,
  removeSub,
  emitEvent,
  decide,
  compareOp,
};
