'use strict';

/* JevTrader — yerel deneme (paper) hesabı.
   Borsa API anahtarı GEREKMEZ: emirler/pozisyonlar bu makinede simüle edilir,
   fiyat verisi gerçek borsanın halka açık uçlarından (crypto.js) alınır.
   crypto.js ile aynı yanıt şemaları: {ok:true, data} | {ok:false, error}.
   Hesap durumu paper.json'da saklanır; "Hesabı sıfırla" ile temizlenir. */

const fs = require('fs');
const cryptomod = require('./crypto');

/* komisyon oranları (VIP0/Regular): Binance USDT-M vadeli ve OKX swap aynı —
   maker %0.02 (limit giriş/TP), taker %0.05 (market/stop/SL). Oranlar notional üzerinden. */
const FEES = {
  binance: { maker: 0.0002, taker: 0.0005 },
  okx: { maker: 0.0002, taker: 0.0005 },
};
function feeRate(ex, maker) {
  const f = FEES[String(ex || '').toLowerCase()] || { maker: 0.0002, taker: 0.0005 };
  return maker ? f.maker : f.taker;
}
const DEFAULT_BALANCE = 10000;    /* varsayılan başlangıç bakiyesi (USDT) */
const MAX_CLOSED = 500;           /* saklanan kapanan işlem üst sınırı */

const ok = (data) => ({ ok: true, data });
const err = (error) => ({ ok: false, error: String(error) });

let stateFile = '';
let cache = null;
/* eşzamanlı istekler durumu bozmasın: tüm işlemler sırayla çalışır */
let chain = Promise.resolve();
function serialize(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

function init(file) {
  stateFile = String(file || '');
  cache = null;
}

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { cache = {}; }
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
  return cache;
}

function save() {
  if (!stateFile) return;
  try {
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, stateFile);
  } catch {}
}

function freshState(balance) {
  const b = Number(balance) > 0 ? Number(balance) : DEFAULT_BALANCE;
  return { balance: b, initial: b, positions: [], orders: [], closed: [], lev: {}, seq: 1 };
}

function stFor(ex, balance) {
  const c = load();
  let st = c[ex];
  if (!st || typeof st !== 'object') {
    st = freshState(balance);
    c[ex] = st;
    save();
    return st;
  }
  if (!Number.isFinite(Number(st.balance)) || Number(st.balance) < 0) {
    st.balance = Number(balance) > 0 ? Number(balance) : DEFAULT_BALANCE;
  }
  st.balance = Number(st.balance);
  if (!(Number(st.initial) > 0)) st.initial = st.balance;
  if (!Array.isArray(st.positions)) st.positions = [];
  if (!Array.isArray(st.orders)) st.orders = [];
  if (!Array.isArray(st.closed)) st.closed = [];
  if (!st.lev || typeof st.lev !== 'object') st.lev = {};
  if (!(Number(st.seq) > 0)) st.seq = 1;
  return st;
}

/* deneme hesabını sıfırla: tüm pozisyon/emir/geçmiş silinir, bakiye başa döner */
function reset(ex, balance) {
  const c = load();
  c[ex] = freshState(balance);
  save();
  return c[ex];
}

/* ---------------- fiyat / sembol bilgisi (gerçek piyasadan) ---------------- */
async function tickFor(ex, symbol, memo) {
  const sym = String(symbol || '').toUpperCase();
  if (memo && memo.has('tick:' + sym)) return memo.get('tick:' + sym);
  let px = { bid: 0, ask: 0, last: 0 };
  const r = await cryptomod.call(ex, 'ticks', { symbol: sym }, null);
  if (r && r.ok && r.data && r.data.tick) {
    const t = r.data.tick;
    px = { bid: Number(t.bid) || 0, ask: Number(t.ask) || 0, last: Number(t.last) || 0 };
  }
  if (!(px.last > 0)) px.last = px.bid || px.ask || 0;
  if (!(px.bid > 0)) px.bid = px.last;
  if (!(px.ask > 0)) px.ask = px.last;
  if (memo) memo.set('tick:' + sym, px);
  return px;
}

async function infoFor(ex, symbol, memo) {
  const sym = String(symbol || '').toUpperCase();
  if (memo && memo.has('info:' + sym)) return memo.get('info:' + sym);
  let row = null;
  const r = await cryptomod.call(ex, 'symbols', { symbols: [sym] }, null);
  if (r && r.ok && r.data && Array.isArray(r.data.symbols)) row = r.data.symbols[0] || null;
  if (!row || row.missing) return null;
  const info = {
    symbol: row.symbol || sym,
    digits: Number(row.digits) || 2,
    tick: Number(row.point) || 0,
    step: Number(row.volume_step) > 0 ? Number(row.volume_step) : 0.001,
    min: Number(row.volume_min) > 0 ? Number(row.volume_min) : 0,
    ctVal: Number(row.trade_tick_value) > 0 ? Number(row.trade_tick_value) : 1,
    maxLev: Number(row.leverage_max) > 0 ? Number(row.leverage_max) : 125,
  };
  if (memo) memo.set('info:' + sym, info);
  return info;
}

function roundStep(v, step) {
  const s = Number(step) || 0;
  if (!(s > 0)) return v;
  const dec = Math.max(0, String(s).split('.')[1] ? String(s).split('.')[1].length : 0);
  return Number((Math.floor(v / s + 1e-9) * s).toFixed(dec));
}

/* ---------------- hesap matematiği ---------------- */
function notionalOf(info, vol, price) {
  return Number(vol) * info.ctVal * Number(price);
}
function marginOf(info, pos) {
  return notionalOf(info, pos.volume, pos.price_open) / Math.max(1, Number(pos.leverage) || 1);
}
function pnlOf(info, pos, price) {
  const dir = Number(pos.side) === 1 ? -1 : 1;
  return dir * (Number(price) - Number(pos.price_open)) * Number(pos.volume) * info.ctVal;
}

async function freeMargin(st, ex, memo) {
  let used = 0;
  for (const p of st.positions) {
    const pi = await infoFor(ex, p.symbol, memo);
    if (pi) used += marginOf(pi, p);
  }
  return st.balance - used;
}

/* kaldıraç seç: istenen değer; teminat yetmezse sembol maksimumuna kadar yükseltir */
async function pickLeverage(ex, st, symbol, vol, price, wanted, info, memo) {
  const maxLev = info.maxLev > 0 ? info.maxLev : 125;
  const cur = Number(st.lev[symbol]) || 0;
  const notional = notionalOf(info, vol, price);
  const free = await freeMargin(st, ex, memo);
  let required = 0;
  if (free > 0 && notional > 0) required = Math.max(1, Math.ceil(notional / free));
  let target = Math.floor(Number(wanted) || 0) > 0 ? Math.floor(Number(wanted)) : (cur || 20);
  if (required > target) target = required;
  target = Math.max(1, Math.min(maxLev, target));
  st.lev[symbol] = target;
  const insufficient = required > maxLev;
  const warning = insufficient
    ? 'Serbest teminat yetersiz: bu hacim ~' + required + 'x gerektiriyor, sembol maksimumu ' + maxLev + 'x'
    : '';
  return { leverage: target, required, insufficient, warning };
}

/* pozisyon aç / aynı sembolde varsa net modda birleştir */
function openPosition(st, symbol, side, vol, price, sl, tp, leverage, info, now, rate) {
  const fee = notionalOf(info, vol, price) * (Number(rate) > 0 ? Number(rate) : feeRate('', false));
  st.balance -= fee;
  const cur = st.positions.find((p) => p.symbol === symbol);
  if (cur) {
    const total = Number(cur.volume) + vol;
    cur.price_open = (Number(cur.price_open) * Number(cur.volume) + price * vol) / total;
    cur.volume = total;
    cur.leverage = leverage;
    cur.fee = Number(cur.fee) + fee;
    if (sl > 0) cur.sl = sl;
    if (tp > 0) cur.tp = tp;
    return cur;
  }
  const pos = { id: 'P' + st.seq++, symbol, side, volume: vol, price_open: price, sl, tp, leverage, time: now, fee };
  st.positions.push(pos);
  return pos;
}

/* hacmin bir kısmını (ya da tamamını) kapat */
function closeChunk(st, pos, vol, price, info, reason, when, rate) {
  const dir = Number(pos.side) === 1 ? -1 : 1;
  const pnl = dir * (price - Number(pos.price_open)) * vol * info.ctVal;
  const feeOpenShare = Number(pos.fee) > 0 ? Number(pos.fee) * (vol / Number(pos.volume)) : 0;
  const feeClose = vol * info.ctVal * price * (Number(rate) > 0 ? Number(rate) : feeRate('', false));
  st.balance += pnl - feeClose;
  pos.fee = Math.max(0, Number(pos.fee) - feeOpenShare);
  pos.volume = Number(pos.volume) - vol;
  st.closed.push({
    position_id: String(pos.id),
    symbol: pos.symbol,
    type: Number(pos.side) === 1 ? 1 : 0,
    volume: vol,
    closed_volume: vol,
    open_time: Number(pos.time) || when,
    open_price: Number(pos.price_open),
    sl: Number(pos.sl) || 0,
    tp: Number(pos.tp) || 0,
    close_time: when,
    close_price: price,
    profit: pnl,
    swap: 0,
    commission: -(feeOpenShare + feeClose),
    reason: Number(reason) || -1,
  });
  if (st.closed.length > MAX_CLOSED) st.closed = st.closed.slice(-MAX_CLOSED);
  if (!(Number(pos.volume) > 1e-12)) st.positions = st.positions.filter((x) => x !== pos);
}

/* ---------------- tetikler: bekleyen emirler + SL/TP ---------------- */
async function runTriggers(ex, st, memo) {
  let changed = false;
  const now = Math.floor(Date.now() / 1000);
  for (const o of st.orders.slice()) {
    const px = await tickFor(ex, o.symbol, memo);
    const last = px.last;
    if (!(last > 0)) continue;
    const hit = o.stop
      ? (Number(o.side) === 0 ? last >= Number(o.price) : last <= Number(o.price))
      : (Number(o.side) === 0 ? last <= Number(o.price) : last >= Number(o.price));
    if (!hit) continue;
    const info = await infoFor(ex, o.symbol, memo);
    st.orders = st.orders.filter((x) => x !== o);
    changed = true;
    if (!info) continue;
    /* stop emirleri market gibi (taker), limit emirler kendi fiyatından (maker) dolar */
    const fill = o.stop ? (Number(o.side) === 0 ? px.ask : px.bid) : Number(o.price);
    const price = fill > 0 ? fill : last;
    const lev = await pickLeverage(ex, st, o.symbol, o.volume, price, o.leverage, info, memo);
    if (lev.insufficient) continue;
    openPosition(st, o.symbol, Number(o.side), Number(o.volume), price, Number(o.sl) || 0, Number(o.tp) || 0, lev.leverage, info, now, feeRate(ex, !o.stop));
  }
  for (const pos of st.positions.slice()) {
    const px = await tickFor(ex, pos.symbol, memo);
    const last = px.last;
    if (!(last > 0)) continue;
    const sl = Number(pos.sl) || 0;
    const tp = Number(pos.tp) || 0;
    let exit = 0;
    let reason = -1;
    if (Number(pos.side) === 0) {
      if (sl > 0 && last <= sl) { exit = sl; reason = 4; }
      else if (tp > 0 && last >= tp) { exit = tp; reason = 5; }
    } else {
      if (sl > 0 && last >= sl) { exit = sl; reason = 4; }
      else if (tp > 0 && last <= tp) { exit = tp; reason = 5; }
    }
    if (!(exit > 0)) continue;
    const info = await infoFor(ex, pos.symbol, memo);
    if (!info) continue;
    /* SL market gibi (taker), TP limit gibi (maker) kapanır */
    closeChunk(st, pos, Number(pos.volume), exit, info, reason, now, feeRate(ex, reason === 5));
    changed = true;
  }
  if (changed) save();
}

/* ---------------- yöntemler ---------------- */
async function pAccount(ex, ctx) {
  const st = stFor(ex, ctx && ctx.balance);
  const memo = new Map();
  let unrealized = 0;
  let margin = 0;
  for (const pos of st.positions) {
    const info = await infoFor(ex, pos.symbol, memo);
    if (!info) continue;
    const px = await tickFor(ex, pos.symbol, memo);
    const cur = Number(pos.side) === 1 ? px.ask : px.bid;
    unrealized += pnlOf(info, pos, cur || px.last);
    margin += marginOf(info, pos);
  }
  const eq = st.balance + unrealized;
  return ok({ account: {
    login: 0,
    server: (ex === 'binance' ? 'Binance' : 'OKX') + ' Demo (yerel)',
    currency: 'USDT',
    balance: st.balance,
    equity: eq,
    margin,
    margin_free: eq - margin,
    margin_level: margin > 0 ? (eq / margin) * 100 : 0,
    profit: unrealized,
  } });
}

async function pPositions(ex, ctx) {
  const st = stFor(ex, ctx && ctx.balance);
  const memo = new Map();
  await runTriggers(ex, st, memo);
  const rows = [];
  for (const pos of st.positions) {
    const info = await infoFor(ex, pos.symbol, memo);
    if (!info) continue;
    const px = await tickFor(ex, pos.symbol, memo);
    const cur = Number(pos.side) === 1 ? px.ask : px.bid;
    rows.push({
      ticket: String(pos.id),
      symbol: pos.symbol,
      type: Number(pos.side) === 1 ? 1 : 0,
      volume: Number(pos.volume),
      price_open: Number(pos.price_open),
      sl: Number(pos.sl) || 0,
      tp: Number(pos.tp) || 0,
      price_current: cur || px.last,
      profit: pnlOf(info, pos, cur || px.last),
      swap: 0,
      commission: -(Number(pos.fee) || 0),
      time: Number(pos.time) || Math.floor(Date.now() / 1000),
      magic: 0,
      comment: 'Demo (yerel)',
      leverage: Number(pos.leverage) || 0,
    });
  }
  return ok({ positions: rows });
}

async function pOrders(ex, ctx) {
  const st = stFor(ex, ctx && ctx.balance);
  const memo = new Map();
  await runTriggers(ex, st, memo);
  const rows = [];
  for (const o of st.orders) {
    const px = await tickFor(ex, o.symbol, memo);
    const type = Number(o.side) === 0 ? (o.stop ? 4 : 2) : (o.stop ? 5 : 3);
    rows.push({
      ticket: o.symbol + '|' + o.id,
      symbol: o.symbol,
      type,
      volume_current: Number(o.volume),
      volume_initial: Number(o.volume),
      price_open: Number(o.price),
      sl: Number(o.sl) || 0,
      tp: Number(o.tp) || 0,
      price_current: px.last || Number(o.price),
      time_setup: Number(o.time) || Math.floor(Date.now() / 1000),
    });
  }
  return ok({ orders: rows });
}

async function pClosed(ex, p, ctx) {
  const st = stFor(ex, ctx && ctx.balance);
  const symbol = String(p.symbol || '').toUpperCase();
  const from = Number(p.from_ts) || 0;
  let rows = st.closed.slice().sort((a, b) => b.close_time - a.close_time);
  if (symbol) rows = rows.filter((r) => r.symbol === symbol);
  if (from > 0) rows = rows.filter((r) => Number(r.close_time) >= from);
  return ok({ positions: rows.slice(0, 300), count: rows.length });
}

async function pMarket(ex, p, ctx) {
  const st = stFor(ex, ctx && ctx.balance);
  const memo = new Map();
  const symbol = String(p.symbol || '').toUpperCase();
  const side = String(p.side || '').toLowerCase() === 'sell' ? 1 : 0;
  const info = await infoFor(ex, symbol, memo);
  if (!info) return err('Sembol bulunamadı: ' + symbol);
  let vol = roundStep(Number(p.volume) || 0, info.step);
  if (info.min > 0 && vol < info.min) vol = info.min;
  if (!(vol > 0)) return err('Geçersiz hacim');
  const px = await tickFor(ex, symbol, memo);
  const price = side === 0 ? px.ask : px.bid;
  if (!(price > 0)) return err('Fiyat alınamadı: ' + symbol);
  const lev = await pickLeverage(ex, st, symbol, vol, price, p.leverage, info, memo);
  if (lev.insufficient) return err(lev.warning + ' — hacmi düşür ya da bakiyeyi artır');
  const pos = openPosition(st, symbol, side, vol, price, Number(p.sl) || 0, Number(p.tp) || 0, lev.leverage, info, Math.floor(Date.now() / 1000), feeRate(ex, false));
  save();
  return ok({
    result: { retcode: 10009, order: pos.id, volume: vol, price },
    price,
    leverage: lev.leverage,
    leverage_warning: lev.warning || '',
  });
}

async function pPending(ex, p, ctx) {
  const st = stFor(ex, ctx && ctx.balance);
  const memo = new Map();
  const symbol = String(p.symbol || '').toUpperCase();
  const type = String(p.type || '').toLowerCase();
  const isStop = type.includes('stop');
  const side = type.includes('sell') || String(p.side || '').toLowerCase() === 'sell' ? 1 : 0;
  const info = await infoFor(ex, symbol, memo);
  if (!info) return err('Sembol bulunamadı: ' + symbol);
  let vol = roundStep(Number(p.volume) || 0, info.step);
  if (info.min > 0 && vol < info.min) vol = info.min;
  const price = Number(p.price) || 0;
  if (!(vol > 0) || !(price > 0)) return err('Geçersiz hacim/fiyat');
  const lev = await pickLeverage(ex, st, symbol, vol, price, p.leverage, info, memo);
  if (lev.insufficient) return err(lev.warning + ' — hacmi düşür ya da bakiyeyi artır');
  const o = {
    id: 'O' + st.seq++,
    symbol,
    side,
    stop: isStop,
    price,
    volume: vol,
    sl: Number(p.sl) || 0,
    tp: Number(p.tp) || 0,
    leverage: lev.leverage,
    time: Math.floor(Date.now() / 1000),
  };
  st.orders.push(o);
  save();
  return ok({
    result: { retcode: 10009, order: o.id },
    type: String(p.type || ''),
    price,
    leverage: lev.leverage,
    leverage_warning: lev.warning || '',
  });
}

async function pClose(ex, p, ctx) {
  const st = stFor(ex, ctx && ctx.balance);
  const memo = new Map();
  const key = String(p.ticket || '');
  const pos = st.positions.find((x) => String(x.id) === key || x.symbol === key);
  if (!pos) return err('Pozisyon bulunamadı: ' + key);
  const info = await infoFor(ex, pos.symbol, memo);
  if (!info) return err('Sembol bilgisi alınamadı: ' + pos.symbol);
  const px = await tickFor(ex, pos.symbol, memo);
  const price = Number(pos.side) === 1 ? px.ask : px.bid;
  if (!(price > 0)) return err('Fiyat alınamadı: ' + pos.symbol);
  const cur = Number(pos.volume);
  let vol = Math.min(roundStep(Number(p.volume) || cur, info.step), cur);
  /* kalan hacim min lotun altında kalıyorsa tamamı kapatılır */
  if (!(vol > 0) || (info.min > 0 && cur - vol < info.min - 1e-9)) vol = cur;
  closeChunk(st, pos, vol, price, info, -1, Math.floor(Date.now() / 1000), feeRate(ex, false));
  save();
  return ok({ result: { retcode: 10009, order: pos.id, volume: vol, price } });
}

async function pModify(ex, p, ctx) {
  const st = stFor(ex, ctx && ctx.balance);
  const key = String(p.ticket || '');
  const pos = st.positions.find((x) => String(x.id) === key || x.symbol === key);
  if (!pos) return err('Pozisyon bulunamadı: ' + key);
  pos.sl = Number(p.sl) || 0;
  pos.tp = Number(p.tp) || 0;
  save();
  return ok({ result: { retcode: 10009 } });
}

function splitTicket(t) {
  const parts = String(t || '').split('|');
  return parts.length === 2 ? parts : null;
}

async function pOrderDelete(ex, p, ctx) {
  const st = stFor(ex, ctx && ctx.balance);
  const parts = splitTicket(p.ticket);
  if (!parts) return err('Emir kimliği geçersiz');
  const before = st.orders.length;
  st.orders = st.orders.filter((o) => !(o.symbol === parts[0] && String(o.id) === parts[1]));
  if (st.orders.length === before) return err('Emir bulunamadı: ' + p.ticket);
  save();
  return ok({ result: { retcode: 10009 } });
}

async function pOrderModify(ex, p, ctx) {
  const st = stFor(ex, ctx && ctx.balance);
  const parts = splitTicket(p.ticket);
  if (!parts) return err('Emir kimliği geçersiz');
  const o = st.orders.find((x) => x.symbol === parts[0] && String(x.id) === parts[1]);
  if (!o) return err('Emir bulunamadı: ' + p.ticket);
  const price = Number(p.price) || 0;
  if (price > 0) o.price = price;
  if (p.sl != null) o.sl = Number(p.sl) || 0;
  if (p.tp != null) o.tp = Number(p.tp) || 0;
  save();
  return ok({ result: { retcode: 10009 } });
}

async function pLevInfo(ex, p, ctx) {
  const st = stFor(ex, ctx && ctx.balance);
  const memo = new Map();
  const symbol = String(p.symbol || '').toUpperCase();
  const info = await infoFor(ex, symbol, memo);
  if (!info) return err('Sembol bulunamadı: ' + symbol);
  return ok({ symbol, leverage: Number(st.lev[symbol]) || 0, max: info.maxLev });
}

/* ---------------- yönlendirme ---------------- */
async function call(exchange, method, params, ctx) {
  const p = params || {};
  const c = ctx || {};
  try {
    switch (method) {
      /* piyasa verisi gerçek borsadan gelir */
      case 'rates':
      case 'ticks':
      case 'all_symbols':
      case 'symbols':
      case 'margin':
        return await cryptomod.call(exchange, method, p, null);
      case 'account': return await serialize(() => pAccount(exchange, c));
      case 'positions': return await serialize(() => pPositions(exchange, c));
      case 'orders': return await serialize(() => pOrders(exchange, c));
      case 'closed': return await serialize(() => pClosed(exchange, p, c));
      case 'market': return await serialize(() => pMarket(exchange, p, c));
      case 'pending': return await serialize(() => pPending(exchange, p, c));
      case 'close': return await serialize(() => pClose(exchange, p, c));
      case 'modify': return await serialize(() => pModify(exchange, p, c));
      case 'order_delete': return await serialize(() => pOrderDelete(exchange, p, c));
      case 'order_modify': return await serialize(() => pOrderModify(exchange, p, c));
      case 'leverage_info': return await serialize(() => pLevInfo(exchange, p, c));
      default: return err('Yerel deneme hesabı: desteklenmeyen yöntem ' + method);
    }
  } catch (e) {
    return err((exchange || '') + ' (deneme): ' + String((e && e.message) || e));
  }
}

module.exports = { call, init, reset, DEFAULT_BALANCE };
