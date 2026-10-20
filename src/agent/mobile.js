'use strict';

/* Beast Agent — MOBILE KÖPRÜSÜ (Faz A): Android APK / diğer makine istemcileri
   için WebSocket santrali. WhatsApp/Telegram/Discord köprülerinin aynısı gibi:
   Electron ana sürecinde çalışır — ayrı program/pencere yok.

   Genel çerçeve:
   - ws sunucu Electronlu ve okuma-an明的; port settings.mobile.port (default 8788)
   - auth: yalnızca device.json'daki BEAST-XXXX-XXXX kodunu hatırlar
   - engine agent:event akışı aynı anda_broadcast — APK ekranı canlı akış

   PROTOCOL v1 (text json):
   client→ {t:'auth', code, name, platform, did}
   client→ {t:'send', sid, text, attachments?}
   client→ {t:'open', sid} | {t:'new'} | {t:'interrupt', sid} | {t:'sessions'} | {t:'ping'}
   server→ {t:'auth-ok', device, name} | {t:'auth-bad', why}
   server→ {t:'sessions', list, activeSid}
   server→ agent eventleri aynen ({sessionId, type, ...} — mobile composer UI'da
           aynı mesaj/token/done/status akışı WhatsApp kartı gibi gösterir)
*/

const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

/* adam adres servisi: apk/www klasöründen dosyalar — yol kaçışı (../) engelli */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
function serveStatic(req, res, wwwDir) {
  try {
    if ((req.method || 'GET') !== 'GET' && (req.method || '') !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const raw = decodeURIComponent(String((req.url || '/').split('?')[0]));
    let rel = raw === '/' ? '/index.html' : raw;
    while (rel.endsWith('/')) rel = rel.slice(0, -1);
    if (rel.includes('..')) { res.writeHead(403).end(); return; }
    let file = path.join(wwwDir, rel);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(wwwDir, 'index.html'); /* tek sayfa uygulama fallback */
    }
    if (!fs.existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('apk/www yok — mobil arayüz kurulmadı'); return; }
    let buf;
    try { buf = fs.readFileSync(file); } catch { res.writeHead(500).end(); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  } catch {
    try { res.writeHead(500).end(); } catch {}
  }
}

let wss = null;
let httpServer = null;
let running = false;
let desiredPort = 0;
let lastError = '';

const clients = new Set();
let handlers = {
  onSend: null,
  onOpen: null,
  onNew: null,
  onInterrupt: null,
  onSessions: null,
  onDelete: null, /* telefondan oturum silme — bilgisayarla entegre */
  onTalk: null, /* eller-serbest mod bayrağı — telefon konuşma döngüsünü açar/kapatır */
  onTtsCfg: null, /* telefondan TTS motor seçimi */
  onPair: null,
};

function setHandlers(h) {
  handlers = { ...handlers, ...(h || {}) };
}

function status() {
  return {
    running,
    port: desiredPort,
    lastError,
    clients: [...clients].map((c) => ({
      did: c.meta.did,
      name: c.meta.name,
      platform: c.meta.platform,
      ip: c.meta.ip,
      since: c.meta.since,
    })),
  };
}

/* SON BİLDİRİMLER: uygulama kapalıyken alarm ile yoklanır — "since"ten beri
   YENİ OLAN BÜTÜN mesajlar döner (WhatsApp gibi; yalnız son mesaj değil).
   Her kayda benzersiz nid verilir: telefonda bildirimler birbirini EZMEZ. */
let lastNotices = []; /* {ts, nid, title, body} */
let noticeSeq = 0;
function pushNotice(title, body) {
  try {
    lastNotices.push({
      ts: Date.now(),
      nid: 4711 + ((noticeSeq++) % 200),
      title: String(title || 'Beast'),
      body: String(body || '').slice(0, 300),
    });
    if (lastNotices.length > 20) lastNotices = lastNotices.slice(-20);
  } catch {}
}

/* YAYIN: agent eventlerini tüm bağlı istemcilere gönder.
   Büyük olay gövdelerinden (uzun ek dataUrl) korunmak için 8MB tavan. */
function broadcast(ev) {
  /* bildirim metni güncelle (asan mesajlar) */
  try {
    if (ev && ev.type === 'message' && ev.message && String(ev.message.role || '') === 'assistant') {
      const c = ev.message.content;
      let txt = '';
      if (typeof c === 'string') txt = c;
      else if (Array.isArray(c)) txt = c.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join(' ');
      txt = String(txt || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      if (txt) pushNotice('Beast', txt);
    }
  } catch {}
  if (!clients.size) return;
  let payload;
  try { payload = JSON.stringify(ev); } catch { return; }
  if (payload.length > 8 * 1024 * 1024) return;
  for (const c of clients) {
    try {
      /* clients set'ine DOĞRUDAN soket konur (meta socket.meta'da) */
      if (c.readyState === 1) c.send(payload);
    } catch {}
  }
}

function dropClient(socket) {
  if (!socket) return;
  clients.delete(socket);
}

/* Yaneze: kod güncellensin/restart: yeni bağlantıya meta ekler */
function attachMeta(socket, req) {
  socket.meta = {
    did: '',
    name: 'Telefon',
    platform: 'android',
    ip: (req && req.socket && req.socket.remoteAddress) || '?',
    since: new Date().toISOString(),
  };
}

function start(opts) {
  stop();
  desiredPort = Number(opts && opts.port) || 8788;
  handlers = { ...handlers, ...((opts && opts.handlers) || {}) };
  const getDeviceCode = opts && opts.getDeviceCode ? opts.getDeviceCode : () => '';
  const onStatus = (opts && opts.onStatus) || null;
  /* telefon tarafı chat arayüzü (test + Capacitor webDir aynı klasör) */
  const wwwDir = (opts && opts.wwwDir)
    || path.join(__dirname, '..', '..', 'apk', 'www');
  lastError = '';

  httpServer = http.createServer((req, res) => {
    /* BİLDİRİM YOKLAMA UCU: uygulama tamamen kapalıyken alarm ile buraya
       sorulur — "since" sonrası yeni mesaj varsa bildirim metni döner.
       Güvenlik: cihaz kodu (device.json) ile doğrulanır. */
    const rawUrl = String((req && req.url) || '');
    if (rawUrl.indexOf('/notif') === 0) {
      try {
        const q = rawUrl.split('?')[1] || '';
        const params = {};
        for (const kv of q.split('&')) {
          const i = kv.indexOf('=');
          if (i < 0) continue;
          params[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
        }
        const given = String(params.code || '').toUpperCase().trim();
        const want = String(getDeviceCode() || '').toUpperCase().trim();
        if (!want || given !== want) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' }).end('{"ok":0}');
          return;
        }
        const since = Number(params.since || 0) || 0;
        /* SINCE'TEN BERİ BÜTÜN YENİ MESAJLAR — tek tek, birbirini ezmeden
           bildirilmek üzere nid'li liste olarak döner */
        const items = lastNotices.filter((n) => n.ts > since);
        const last = lastNotices.length ? lastNotices[lastNotices.length - 1] : null;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({
          ok: 1,
          ts: last ? last.ts : since,
          title: last ? last.title : 'Beast',
          body: items.length ? (last ? last.body : '') : '',
          items,
        }));
      } catch {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"ok":0}');
      }
      return;
    }
    serveStatic(req, res, wwwDir);
  });
  try {
    wss = new WebSocketServer({
      server: httpServer,
      maxPayload: 24 * 1024 * 1024,
    });
  } catch (e) {
    lastError = String((e && e.message) || e);
    httpServer = null;
    return { ok: false, error: lastError };
  }

  wss.on('connection', (socket, req) => {
    attachMeta(socket, req);
    let authed = false;
    const sendS = (o) => { try { socket.send(JSON.stringify(o)); } catch {} };
    const forceClose = (code, why) => { try { socket.close(code, why); } catch {} };

    socket.on('message', (buf) => {
      let m;
      try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
      if (!m || typeof m !== 'object') return;
      const t = String(m.t || '');

      if (!authed) {
        if (t !== 'auth') { forceClose(4001, 'önce auth'); return; }
        const given = String(m.code || '').toUpperCase().trim();
        const want = String(getDeviceCode() || '').toUpperCase().trim();
        if (!want || given !== want) {
          sendS({ t: 'auth-bad', why: 'kod yanlış ya da değişti — Ayarlar → Beast Mobile kodunu tekrar al' });
          forceClose(4003, 'kod yanlış');
          return;
        }
        socket.meta.did = String(m.did || Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 64);
        socket.meta.name = String(m.name || 'Telefon').slice(0, 40);
        socket.meta.platform = String(m.platform || 'android').slice(0, 20);
        authed = true;
        try {
          clients.add(socket);
        } catch {}
        sendS({ t: 'auth-ok', device: want, name: socket.meta.name });
        try { if (handlers.onPair) handlers.onPair(socket.meta); } catch {}
        try { if (handlers.onSessions) { handlers.onSessions(sendS); } } catch {}
        return;
      }

      try {
        if (t === 'ping') { sendS({ t: 'pong', ts: Date.now() }); return; }
        if (t === 'sessions') {
          if (handlers.onSessions) { handlers.onSessions(sendS); }
          return;
        }
        if (t === 'send') {
          if (handlers.onSend) {
            handlers.onSend(String(m.sid || ''), {
              text: String(m.text || ''),
              attachments: Array.isArray(m.attachments) ? m.attachments : [],
              live: !!m.live, /* canlı konuşma parçası → hızlı STT önceliği */
            });
          }
          return;
        }
        if (t === 'open') {
          /* 2. arg sendS: masaüstü o sokete geçmiş snapshot'ı ({t:'session'}) yollar */
          if (handlers.onOpen) { handlers.onOpen(String(m.sid || ''), sendS); }
          return;
        }
        if (t === 'new') {
          if (handlers.onNew) { handlers.onNew(sendS); }
          return;
        }
        if (t === 'del') {
          /* 2. arg sendS: masaüstü o sokete {t:'session-del', ok} yollar;
             silinen oturum tüm istemcilere broadcast sessions ile düşer */
          if (handlers.onDelete) { handlers.onDelete(String(m.sid || ''), sendS); }
          return;
        }
        if (t === 'talk') {
          /* telefon eller-serbest modu açıyor/kapıyor — o oturum 'talk'
             penceresine girer; tur bittiğinde telefon sesli cevap alır */
          if (handlers.onTalk) { handlers.onTalk(String(m.sid || ''), !!m.on); }
          return;
        }
        if (t === 'tts-cfg') {
          /* telefona ÖZEL TTS ayarı (masaüstü WA TTS'inden bağımsız) */
          if (handlers.onTtsCfg) { handlers.onTtsCfg(m); }
          return;
        }
        if (t === 'interrupt') {
          if (handlers.onInterrupt) { handlers.onInterrupt(String(m.sid || '')); }
          return;
        }
      } catch (e) {
        sendS({ t: 'status', status: 'mobile istek hatası: ' + String((e && e.message) || e) });
      }
    });

    socket.on('close', () => dropClient(socket));
    socket.on('error', () => dropClient(socket));
  });

  try {
    httpServer.on('error', (e) => {
      lastError = String((e && e.code) || e.message || e);
      running = false;
      try { if (onStatus) onStatus(status()); } catch {}
    });
    httpServer.listen(desiredPort, '0.0.0.0', () => {
      running = true;
      try { if (onStatus) onStatus(status()); } catch {}
    });
  } catch (e) {
    lastError = String((e && e.message) || e);
    stop();
    return { ok: false, error: lastError };
  }
  return { ok: true, port: desiredPort };
}

/* TÜM istemcileri kapatarak sunucuyu kapat (kapatma settings + testler) */
function stop() {
  try {
    if (wss) { wss.clients.forEach((c) => { try { c.close(1001, 'kapandı'); } catch {} }); wss.close(); }
  } catch {}
  wss = null;
  try { if (httpServer) httpServer.close(); } catch {}
  httpServer = null;
  clients.clear();
  running = false;
}

/* TEST KÖPRÜSÜ: aktif istemci soketlerini test'te elde etme */
function testClients() {
  return [...clients].map((c) => c);
}

module.exports = {
  start,
  stop,
  status,
  broadcast,
  setHandlers,
  isRunning: () => running,
  clientCount: () => clients.size,
  resetForTests: () => { stop(); handlers = {}; lastError = ''; },
};
