'use strict';

/* JevTrader — yerel HTTP API sunucusu (main süreç).
   Uygulama içinde REST endpoint'leri açar; dışarıdan X-API-Key ile sorgu ve emir.
   Tüm istekler uygulamanın borsa katmanına (exDispatch) yönlenir: MT5, Binance,
   OKX ve yerel DENEME hesapları (account=demo) dahil aynı yanıt şemaları geçerli.
   Varsayılan olarak yalnızca 127.0.0.1 dinlenir; port/anahtarlar Ayarlar > API'de. */

const http = require('http');

const APP = 'JevTrader';
const MAX_BODY = 1024 * 1024;
const NUM_FIELDS = ['sl', 'tp', 'price', 'volume', 'count', 'days', 'from_ts', 'before_ts', 'deviation', 'magic', 'leverage'];

/* endpoint tablosu: kind 'call' → dispatch, 'health'/'log' → yerel işleyici */
const ENDPOINTS = [
  { method: 'GET', path: '/api/v1/health', kind: 'health', time: 8000, desc: 'Durum: sürüm, aktif borsa, hesap türü, MT5 köprüsü, API bilgisi' },
  { method: 'GET', path: '/api/v1/account', kind: 'call', mt: 'account', params: [], time: 20000, desc: 'Hesap özeti: bakiye, equity, teminat' },
  { method: 'GET', path: '/api/v1/positions', kind: 'call', mt: 'positions', params: [], time: 20000, desc: 'Açık pozisyonlar' },
  { method: 'GET', path: '/api/v1/orders', kind: 'call', mt: 'orders', params: [], time: 20000, desc: 'Bekleyen emirler' },
  { method: 'GET', path: '/api/v1/closed', kind: 'call', mt: 'closed', params: ['days', 'symbol', 'from_ts'], time: 30000, desc: 'Kapanan işlemler (varsayılan son 7 gün)' },
  { method: 'GET', path: '/api/v1/symbols', kind: 'call', mt: 'all_symbols', params: [], time: 30000, desc: 'Tüm semboller (ad/açıklama listesi)' },
  { method: 'GET', path: '/api/v1/symbol-info', kind: 'symbols', params: ['symbols'], time: 25000, desc: 'Sembol detayı: digits, min hacim, adım, kaldıraç — symbols=A,B,C' },
  { method: 'GET', path: '/api/v1/rates', kind: 'call', mt: 'rates', params: ['symbol', 'timeframe', 'count', 'before_ts'], time: 25000, desc: 'OHLC mumlar: symbol + timeframe (M1..MN1) + count' },
  { method: 'GET', path: '/api/v1/ticks', kind: 'call', mt: 'ticks', params: ['symbol', 'count'], time: 15000, desc: 'Son tick: bid / ask / last' },
  { method: 'GET', path: '/api/v1/margin', kind: 'call', mt: 'margin', params: ['symbol', 'side', 'volume', 'price'], time: 25000, desc: 'Tahmini teminat (MT5)' },
  { method: 'GET', path: '/api/v1/leverage', kind: 'call', mt: 'leverage_info', params: ['symbol'], time: 25000, desc: 'Sembol kaldıracı (MT5 / yerel deneme)' },
  { method: 'GET', path: '/api/v1/log', kind: 'log', params: ['lines'], desc: 'Uygulama logları (son N satır, varsayılan 200)' },
  { method: 'POST', path: '/api/v1/market', kind: 'call', mt: 'market', params: ['symbol', 'side', 'volume', 'sl', 'tp', 'comment', 'deviation', 'magic', 'leverage'], time: 30000, desc: 'Piyasa emri: {symbol, side: buy|sell, volume, sl?, tp?}' },
  { method: 'POST', path: '/api/v1/pending', kind: 'call', mt: 'pending', params: ['symbol', 'type', 'price', 'volume', 'sl', 'tp', 'comment', 'deviation', 'magic', 'leverage'], time: 30000, desc: 'Bekleyen emir: {symbol, type: buy_limit|sell_limit|buy_stop|sell_stop, price, volume}' },
  { method: 'POST', path: '/api/v1/close', kind: 'call', mt: 'close', params: ['ticket', 'volume', 'deviation'], time: 30000, desc: 'Pozisyon kapat — ticket + isteğe bağlı kısmi volume' },
  { method: 'POST', path: '/api/v1/modify', kind: 'call', mt: 'modify', params: ['ticket', 'sl', 'tp'], time: 25000, desc: 'Pozisyon SL/TP değiştir: {ticket, sl?, tp?}' },
  { method: 'POST', path: '/api/v1/order/delete', kind: 'call', mt: 'order_delete', params: ['ticket'], time: 25000, desc: 'Bekleyen emri sil: {ticket}' },
  { method: 'POST', path: '/api/v1/order/modify', kind: 'call', mt: 'order_modify', params: ['ticket', 'price', 'sl', 'tp'], time: 30000, desc: 'Bekleyen emri değiştir: {ticket, price?, sl?, tp?}' },
];

let server = null;
let host = '127.0.0.1';
let port = 8787;
let lastError = '';
let startedAt = 0;
let hooks = {};

function init(h) {
  hooks = h || {};
}

function status() {
  return {
    running: !!server,
    listening: !!(server && server.listening),
    host,
    port,
    error: lastError,
    startedAt: startedAt ? new Date(startedAt).toISOString() : '',
    uptime_s: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
  };
}

function logLine(line) {
  try { if (hooks.log) hooks.log(line); } catch {}
}

function start(opts) {
  const h = String((opts && opts.host) || host || '127.0.0.1');
  const p = Math.max(1, Math.min(65535, Math.round(Number(opts && opts.port) || port || 8787)));
  if (server && host === h && port === p) return status();
  stop();
  host = h;
  port = p;
  lastError = '';
  const srv = http.createServer(onRequest);
  srv.on('error', (e) => {
    lastError = 'API sunucusu: ' + String((e && e.message) || e);
    try { srv.close(); } catch {}
    if (server === srv) server = null;
    logLine(new Date().toISOString() + ' [API] ' + lastError);
  });
  srv.listen(port, host, () => {
    startedAt = Date.now();
    lastError = '';
    logLine(new Date().toISOString() + ' [API] dinleniyor: http://' + host + ':' + port);
  });
  server = srv;
  return status();
}

function stop() {
  if (!server) return status();
  try { if (server.closeAllConnections) server.closeAllConnections(); } catch {}
  try { server.close(); } catch {}
  server = null;
  startedAt = 0;
  return status();
}

/* ---------------- istek işleme ---------------- */

function cors(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  }, extra || {});
}

function send(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, cors({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, cors({ 'Content-Type': 'text/html; charset=utf-8' }));
  res.end(html);
}

function pickKey(req, url) {
  const keys = (hooks.keys ? hooks.keys() : []) || [];
  const hdr = String(req.headers['x-api-key'] || '').trim();
  const auth = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const bearer = m ? m[1].trim() : '';
  const q = String((url && url.searchParams.get('api_key')) || '').trim();
  const token = hdr || bearer || q;
  if (!token) return null;
  return keys.find((k) => k && k.key === token) || null;
}

function readBody(req, cb) {
  if (req.method === 'GET' || req.method === 'HEAD') return cb(null, {});
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { cb('gövde çok büyük (max 1 MB)'); try { req.destroy(); } catch {} return; }
    chunks.push(c);
  });
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return cb(null, {});
    try {
      const j = JSON.parse(raw);
      if (!j || typeof j !== 'object' || Array.isArray(j)) return cb('gövde JSON nesnesi olmalı');
      cb(null, j);
    } catch { cb('gövde geçerli JSON değil'); }
  });
  req.on('error', () => cb('gövde okunamadı'));
}

function coerce(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (k === 'ticket' || k === 'symbol' || k === 'side' || k === 'type' || k === 'timeframe' || k === 'comment' || k === 'symbols') {
      out[k] = v;
      continue;
    }
    if (NUM_FIELDS.includes(k) && v !== '' && v != null && Number.isFinite(Number(v))) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

function endpointArgs(ep, params) {
  const allow = new Set(['exchange', 'account'].concat(ep.params || []));
  const keep = {};
  for (const k of allow) {
    if (k === 'exchange' || k === 'account') continue;
    if (params[k] != null && params[k] !== '') keep[k] = params[k];
  }
  return coerce(keep);
}

function resolveEx(params) {
  const v = String(params.exchange || '').toLowerCase();
  if (['mt5', 'binance', 'okx'].includes(v)) return v;
  return String((hooks.activeExchange && hooks.activeExchange()) || 'mt5');
}

function resolveAccount(params, ex) {
  const v = String(params.account || '').toLowerCase();
  if (v === 'demo' || v === 'real') return v;
  return String((hooks.exchangeMode && hooks.exchangeMode(ex)) || 'real');
}

function health() {
  const base = (hooks.health && hooks.health()) || {};
  return Object.assign({}, base, {
    api: status(),
    time: new Date().toISOString(),
  });
}

async function run(res, req, url, keyRow, ex, account, method, args, time) {
  const t0 = Date.now();
  let r;
  try {
    r = await hooks.dispatch(ex, method, args, time || 20000, account);
  } catch (e) {
    r = { ok: false, error: String((e && e.message) || e) };
  }
  const ms = Date.now() - t0;
  try { if (hooks.keyUsed) hooks.keyUsed(keyRow.id); } catch {}
  logLine(new Date().toISOString() + ' [API] ' + req.method + ' ' + url.pathname + ' · ' + keyRow.name + ' · ' +
    (r && r.ok === true ? 'ok' : 'HATA: ' + ((r && r.error) || '?')) + ' · ' + ms + 'ms');
  if (!r || r.ok !== true) {
    return send(res, 400, { ok: false, error: (r && r.error) || 'bilinmeyen hata', exchange: ex, account });
  }
  return send(res, 200, {
    ok: true,
    exchange: ex,
    account,
    elapsed_ms: ms,
    data: r.data !== undefined ? r.data : r,
  });
}

async function route(req, res, url, body, keyRow) {
  const ep = ENDPOINTS.find((x) => x.method === req.method && x.path === url.pathname);
  if (!ep) return send(res, 404, { ok: false, error: 'uç nokta yok: ' + req.method + ' ' + url.pathname });

  const params = {};
  for (const [k, v] of url.searchParams) if (!(k in params)) params[k] = v;
  for (const [k, v] of Object.entries(body || {})) params[k] = v;
  /* exchange/account burada korunur (yönlendirme için); dispatch'e giden args
     endpointArgs() içinde bu anahtarlar ayıklanarak hazırlanır */

  if (ep.kind === 'health') {
    if (hooks.keyUsed) { try { hooks.keyUsed(keyRow.id); } catch {} }
    logLine(new Date().toISOString() + ' [API] GET ' + url.pathname + ' · ' + keyRow.name + ' · ok');
    return send(res, 200, { ok: true, data: health() });
  }

  if (ep.kind === 'log') {
    if (hooks.keyUsed) { try { hooks.keyUsed(keyRow.id); } catch {} }
    const n = Math.max(1, Math.min(2000, Math.round(Number(params.lines) || 200)));
    const r = (hooks.logRead && hooks.logRead(n)) || { ok: true, lines: [], path: '' };
    return send(res, 200, { ok: true, data: { lines: r.lines || [], path: r.path || '', count: (r.lines || []).length } });
  }

  const ex = resolveEx(params);
  const account = resolveAccount(params, ex);
  if (ex === 'mt5' && account === 'demo') {
    return send(res, 400, { ok: false, error: 'MT5 canlı terminaldir; account=demo yalnızca binance/okx ile kullanılır' });
  }

  if (ep.kind === 'symbols') {
    const list = String(params.symbols || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (!list.length) return send(res, 400, { ok: false, error: 'symbols zorunlu — ör. symbols=XAUUSD,EURUSD' });
    return run(res, req, url, keyRow, ex, account, 'symbols', { symbols: list }, ep.time);
  }

  return run(res, req, url, keyRow, ex, account, ep.mt, endpointArgs(ep, params), ep.time);
}

function onRequest(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + port);
  } catch {
    return send(res, 400, { ok: false, error: 'geçersiz istek' });
  }

  if (req.method === 'OPTIONS') { res.writeHead(204, cors({})); return res.end(); }
  if (req.method === 'GET' && url.pathname === '/') return sendHtml(res, docsPage(url));
  if (req.method === 'GET' && (url.pathname === '/api' || url.pathname === '/api/')) {
    return send(res, 200, {
      ok: true,
      app: APP,
      endpoints: ENDPOINTS.map((e) => ({ method: e.method, path: e.path, desc: e.desc })),
    });
  }

  const keyRow = pickKey(req, url);
  if (!keyRow) {
    logLine(new Date().toISOString() + ' [API] 401 ' + req.method + ' ' + url.pathname + ' · geçersiz anahtar');
    return send(res, 401, { ok: false, error: 'geçersiz ya da eksik API anahtarı — X-API-Key başlığı gerekli' });
  }

  readBody(req, (err, body) => {
    if (err) return send(res, 400, { ok: false, error: err });
    route(req, res, url, body, keyRow).catch((e) => {
      try { send(res, 500, { ok: false, error: String((e && e.message) || e) }); } catch {}
    });
  });
}

/* ---------------- doküman sayfası (tarayıcıda http://127.0.0.1:PORT/) ---------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function docsPage(url) {
  const base = 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + port;
  const wantPrint = !!(url && url.searchParams && url.searchParams.get('print'));
  const rows = ENDPOINTS.map((e) =>
    '<tr><td><span class="m ' + (e.method === 'GET' ? 'g' : 'p') + '">' + e.method + '</span></td>' +
    '<td><code>' + esc(e.path) + '</code></td><td>' + esc(e.desc) + '</td></tr>').join('');
  return '<!doctype html><html lang="tr"><head><meta charset="utf-8" />' +
    '<title>' + APP + ' API</title><style>' +
    'body{background:#0d0d0f;color:#e6e6ea;font:14px/1.6 Segoe UI,Arial,sans-serif;margin:0;padding:32px;max-width:980px}' +
    'h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:26px 0 8px;color:#9aa0ae}' +
    'table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #23232a;padding:7px 10px 7px 0;text-align:left;vertical-align:top;font-size:13px}' +
    'code,pre{font-family:Consolas,monospace;font-size:12.5px;background:#15151a;border:1px solid #23232a;border-radius:8px}' +
    'code{padding:1px 6px}pre{padding:12px 14px;overflow:auto;white-space:pre-wrap}' +
    '.m{font-weight:800;font-size:11px;border-radius:6px;padding:2px 7px}.g{background:#123a24;color:#57d38c}.p{background:#3a2212;color:#e8a04a}' +
    '.sub{color:#9aa0ae}a{color:#6cb6ff}' +
    '.tools{display:flex;gap:10px;align-items:center;margin:0 0 14px}' +
    '.tools button{background:#1d1d24;color:#e6e6ea;border:1px solid #33333d;border-radius:8px;padding:8px 14px;font:600 13px Segoe UI,Arial,sans-serif;cursor:pointer}' +
    '.tools button:hover{background:#26262e}' +
    '@media print{body{background:#fff;color:#111;max-width:none;padding:0}h2{color:#333}.sub{color:#444}code,pre{background:#f4f4f6;border-color:#ddd;color:#111}.m{background:#eee!important;color:#111!important}.tools{display:none}a{color:#0645ad}}' +
    '</style></head><body>' +
    '<div class="tools"><button onclick="window.print()">Yazdır / PDF olarak kaydet</button>' +
    '<span class="sub">PDF için yazdır penceresinde hedef olarak "PDF olarak kaydet" seç.</span></div>' +
    '<h1>' + APP + ' API</h1>' +
    '<div class="sub">Yerel HTTP API — uygulama açıkken çalışır. Temel adres: <code>' + esc(base) + '</code></div>' +
    '<h2>Kimlik doğrulama</h2>' +
    '<pre>X-API-Key: jvt_...</pre>' +
    '<div class="sub">Anahtarı uygulamada <b>Ayarlar &gt; API</b> sekmesinden oluştur. Alternatif: <code>Authorization: Bearer jvt_...</code> ya da <code>?api_key=</code>.</div>' +
    '<h2>Deneme hesapları</h2>' +
    '<div class="sub">Uygulamada Binance/OKX için Deneme Hesabı seçiliyse API de o hesaba bağlanır. Uygulama ayarından bağımsız kullanmak için: <code>?exchange=binance&amp;account=demo</code>. Gerçek hesap: <code>account=real</code>. MT5 canlı terminaldir.</div>' +
    '<h2>Uç noktalar</h2><table><tr><th>Yöntem</th><th>Yol</th><th>Açıklama</th></tr>' + rows + '</table>' +
    '<h2>Örnek</h2>' +
    '<pre>curl -H "X-API-Key: jvt_..." "' + esc(base) + '/api/v1/account?exchange=binance&amp;account=demo"\n\n' +
    'curl -X POST -H "X-API-Key: jvt_..." -H "Content-Type: application/json" \\\n  -d \'{"symbol":"BTCUSDT","side":"buy","volume":0.01}\' \\\n  "' + esc(base) + '/api/v1/market?exchange=binance&amp;account=demo"</pre>' +
    '<h2>Yanıt biçimi</h2>' +
    '<pre>{"ok": true, "exchange": "binance", "account": "demo", "elapsed_ms": 512, "data": { ... }}</pre>' +
    '<div class="sub">Hata: <code>{"ok": false, "error": "..."}</code> · HTTP 400 işlem hatası, 401 anahtar hatası, 404 yol yok.</div>' +
    (wantPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},400)});</script>' : '') +
    '</body></html>';
}

module.exports = { init, start, stop, status, ENDPOINTS };
