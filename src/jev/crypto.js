'use strict';

/* JevTrader — Binance (USDT-M futures) ve OKX (swap) köprüsü.
   MT5 köprüsüyle aynı yanıt şemalarını üretir: {ok:true, data} | {ok:false, error}.
   Tüm ağ istekleri main süreçte yapılır; API anahtarları settings.json'da tutulur. */

const crypto = require('crypto');

const BINANCE_BASE = 'https://fapi.binance.com';
const OKX_BASE = 'https://www.okx.com';

const TF_BINANCE = { M1: '1m', M5: '5m', M15: '15m', M30: '30m', H1: '1h', H4: '4h', D1: '1d', W1: '1w' };
const TF_OKX = { M1: '1m', M5: '5m', M15: '15m', M30: '30m', H1: '1H', H4: '4H', D1: '1D', W1: '1W' };

let binanceTimeOffset = 0;
const infoCache = { binance: { at: 0, data: null }, okx: { at: 0, data: null } };
/* kripto pozisyonlar açılış zamanı vermez: ilk görülme anı kaydedilir */
const posSeen = { binance: {}, okx: {} };

const ok = (data) => ({ ok: true, data });
const err = (error) => ({ ok: false, error: String(error) });

async function jfetch(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch {} }, Math.max(2000, timeoutMs || 15000));
  try {
    const res = await fetch(url, { ...(opts || {}), signal: ctl.signal });
    const txt = await res.text();
    let json = null;
    try { json = JSON.parse(txt); } catch {}
    return { status: res.status, json, txt };
  } finally { clearTimeout(timer); }
}

function roundStep(v, step) {
  const s = Number(step) || 0;
  if (!(s > 0)) return v;
  const dec = Math.max(0, String(s).split('.')[1] ? String(s).split('.')[1].length : 0);
  return Number((Math.floor(v / s + 1e-9) * s).toFixed(dec));
}
function roundTick(v, tick) {
  const t = Number(tick) || 0;
  if (!(t > 0)) return v;
  const dec = Math.max(0, String(t).split('.')[1] ? String(t).split('.')[1].length : 0);
  return Number((Math.round(v / t) * t).toFixed(dec));
}

/* ---------------- Binance ---------------- */
function bSign(query, secret) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

async function bReq(method, path, params, signed, keys, timeoutMs) {
  const p = { ...(params || {}) };
  const base = BINANCE_BASE;
  let url = base + path;
  const opts = { method };
  if (signed) {
    const apiKey = (keys && keys.key) || '';
    const secret = (keys && keys.secret) || '';
    if (!apiKey || !secret) return err('Binance API anahtarları girilmemiş (Ayarlar > Binance API)');
    if (!binanceTimeOffset) {
      const t = await jfetch(base + '/fapi/v1/time', {}, 8000);
      if (t.json && t.json.serverTime) binanceTimeOffset = Number(t.json.serverTime) - Date.now();
    }
    p.timestamp = Date.now() + binanceTimeOffset;
    p.recvWindow = 5000;
    const q = new URLSearchParams(p).toString();
    url += '?' + q + '&signature=' + bSign(q, secret);
    opts.headers = { 'X-MBX-APIKEY': apiKey };
  } else {
    const q = new URLSearchParams(p).toString();
    if (q) url += '?' + q;
  }
  const r = await jfetch(url, opts, timeoutMs);
  if (r.status >= 400 || (r.json && r.json.code && Number(r.json.code) < 0)) {
    return err('Binance: ' + ((r.json && (r.json.msg || r.json.message)) || ('HTTP ' + r.status)));
  }
  return ok(r.json);
}

async function bInfo() {
  if (infoCache.binance.data && Date.now() - infoCache.binance.at < 300000) return infoCache.binance.data;
  const r = await bReq('GET', '/fapi/v1/exchangeInfo', {}, false);
  if (!r.ok) return null;
  infoCache.binance = { at: Date.now(), data: r.data };
  return r.data;
}

function bSymInfo(info, symbol) {
  const s = ((info && info.symbols) || []).find((x) => x.symbol === symbol);
  if (!s) return null;
  const filt = (t) => (s.filters || []).find((f) => f.filterType === t) || {};
  return {
    symbol: s.symbol,
    digits: Number(s.pricePrecision) || 2,
    tick: Number(filt('PRICE_FILTER').tickSize) || 0,
    qtyStep: Number(filt('LOT_SIZE').stepSize) || 0.001,
    qtyMin: Number(filt('LOT_SIZE').minQty) || 0,
    base: s.baseAsset || '',
  };
}

async function bRates(p) {
  const symbol = String(p.symbol || '').toUpperCase();
  if (!symbol) return err('symbol zorunlu');
  const interval = TF_BINANCE[String(p.timeframe || 'M15').toUpperCase()] || '15m';
  const limit = Math.max(1, Math.min(Number(p.count) || 300, 1500));
  const params = { symbol, interval, limit };
  /* geçmiş sayfalama: en eski mumdan öncesini getir */
  const before = Number(p.before_ts) || 0;
  if (before > 0) params.endTime = Math.floor(before * 1000) - 1;
  const r = await bReq('GET', '/fapi/v1/klines', params, false);
  if (!r.ok) return r;
  const rows = (r.data || []).map((k) => ({
    time: Math.floor(Number(k[0]) / 1000),
    open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
    tick_volume: Number(k[5]) || 0, spread: 0, real_volume: Number(k[7]) || 0,
  }));
  return ok({ symbol, timeframe: String(p.timeframe || 'M15').toUpperCase(), count: rows.length, rates: rows });
}

async function bTicks(p) {
  const symbol = String(p.symbol || '').toUpperCase();
  if (!symbol) return err('symbol zorunlu');
  const [bt, lp, info] = await Promise.all([
    bReq('GET', '/fapi/v1/ticker/bookTicker', { symbol }, false),
    bReq('GET', '/fapi/v1/ticker/price', { symbol }, false),
    bInfo(),
  ]);
  if (!bt.ok) return bt;
  const si = bSymInfo(info, symbol);
  const digits = si ? si.digits : 2;
  const point = Math.pow(10, -digits);
  const bid = Number(bt.data.bidPrice) || 0;
  const ask = Number(bt.data.askPrice) || 0;
  return ok({
    tick: { bid, ask, last: lp.ok ? Number(lp.data.price) || 0 : 0, time: Math.floor(Date.now() / 1000) },
    spread: point > 0 ? Math.round((ask - bid) / point) : 0,
    digits,
    point,
  });
}

async function bAccount(keys) {
  const r = await bReq('GET', '/fapi/v2/account', {}, true, keys);
  if (!r.ok) return r;
  const a = r.data || {};
  const margin = Number(a.totalPositionInitialMargin) || 0;
  const eq = Number(a.totalMarginBalance) || 0;
  return ok({ account: {
    login: 0, server: 'Binance Futures', currency: 'USDT',
    balance: Number(a.totalWalletBalance) || 0,
    equity: eq,
    margin,
    margin_free: Number(a.availableBalance) || 0,
    margin_level: margin > 0 ? (eq / margin) * 100 : 0,
    profit: Number(a.totalUnrealizedProfit) || 0,
  } });
}

/* ---- kaldıraç (Binance) ---- */
const levCache = { binance: { at: 0, data: null } };

async function bLeverageBrackets(keys) {
  if (levCache.binance.data && Date.now() - levCache.binance.at < 600000) return levCache.binance.data;
  const r = await bReq('GET', '/fapi/v1/leverageBracket', {}, true, keys, 15000);
  if (!r.ok) return null;
  levCache.binance = { at: Date.now(), data: r.data };
  return r.data;
}

function bMaxLevOf(brackets, symbol, notional) {
  const row = (brackets || []).find((x) => x.symbol === symbol);
  const list = (row && row.brackets) || [];
  if (!list.length) return 0;
  /* pozisyon büyüklüğüne denk gelen kademenin kaldıraç tavanı */
  if (notional > 0) {
    for (const b of list) {
      if (notional <= (Number(b.notionalCap) || 0)) return Number(b.initialLeverage) || 0;
    }
    return Number(list[list.length - 1].initialLeverage) || 0;
  }
  return Number(list[0].initialLeverage) || 0;
}

async function bCurLev(symbol, keys) {
  const r = await bReq('GET', '/fapi/v2/positionRisk', { symbol }, true, keys, 12000);
  if (!r.ok) return 0;
  const row = (r.data || []).find((x) => x.symbol === symbol);
  return row ? Number(row.leverage) || 0 : 0;
}

async function bSetLev(symbol, lev, keys) {
  const r = await bReq('POST', '/fapi/v1/leverage', { symbol, leverage: lev }, true, keys, 15000);
  if (!r.ok) return r;
  return ok({ leverage: Number(r.data.leverage) || lev });
}

async function bLevPrice(symbol) {
  const t = await bReq('GET', '/fapi/v1/ticker/price', { symbol }, false, null, 8000);
  return t.ok ? Number(t.data.price) || 0 : 0;
}

async function bLevInfo(p, keys) {
  const symbol = String(p.symbol || '').toUpperCase();
  const info = await bInfo();
  const si = bSymInfo(info, symbol);
  if (!si) return err('Binance sembolü bulunamadı: ' + symbol);
  const max = bMaxLevOf(await bLeverageBrackets(keys), symbol) || 125;
  const cur = await bCurLev(symbol, keys);
  return ok({ symbol, leverage: cur, max });
}

/* istenen kaldıracı uygular; teminat yetmiyorsa sembol maksimumuna kadar yükseltir */
async function bEnsureLev(p, keys) {
  const symbol = String(p.symbol || '').toUpperCase();
  const info = await bInfo();
  const si = bSymInfo(info, symbol);
  if (!si) return err('Binance sembolü bulunamadı: ' + symbol);
  const cur = await bCurLev(symbol, keys);
  const wanted = Math.floor(Number(p.leverage) || 0);
  let required = 0;
  let notional = 0;
  const qty = roundStep(Number(p.volume) || 0, si.qtyStep);
  if (qty > 0) {
    let price = Number(p.price) || 0;
    if (!(price > 0)) price = await bLevPrice(symbol);
    if (price > 0) {
      notional = qty * price;
      const acc = await bAccount(keys);
      const free = acc.ok ? Number(acc.data.account.margin_free) || 0 : 0;
      if (free > 0) required = Math.max(1, Math.ceil(notional / free));
    }
  }
  const maxLev = bMaxLevOf(await bLeverageBrackets(keys), symbol, notional) || 125;
  let target = wanted > 0 ? Math.max(wanted, required) : Math.max(cur, required);
  if (!(target > 0)) target = cur || 20;
  target = Math.max(1, Math.min(maxLev, Math.round(target)));
  const insufficient = required > maxLev;
  let applied = cur;
  let warning = '';
  if (target !== cur) {
    const r = await bSetLev(symbol, target, keys);
    if (r.ok) applied = r.data.leverage;
    else if (target < cur) warning = 'Kaldıraç ' + target + 'x yapılamadı (' + r.error + ') — ' + cur + 'x ile devam';
    else return r;
  }
  if (insufficient) warning = 'Serbest teminat yetersiz: bu hacim ~' + required + 'x gerektiriyor, sembol maksimumu ' + maxLev + 'x';
  return ok({ symbol, leverage: applied, max: maxLev, required, changed: applied !== cur, insufficient, warning });
}

async function bOpenOrders(keys) {
  return bReq('GET', '/fapi/v1/openOrders', {}, true, keys, 12000);
}

async function bPositions(keys) {
  const [pr, or] = await Promise.all([
    bReq('GET', '/fapi/v2/positionRisk', {}, true, keys),
    bOpenOrders(keys),
  ]);
  if (!pr.ok) return pr;
  const orders = (or.ok && Array.isArray(or.data)) ? or.data : [];
  const now = Math.floor(Date.now() / 1000);
  const seen = posSeen.binance;
  const live = new Set();
  const rows = [];
  for (const x of (pr.data || [])) {
    const amt = Number(x.positionAmt) || 0;
    if (!amt) continue;
    const sym = x.symbol;
    live.add(sym);
    if (!seen[sym]) seen[sym] = now;
    const slO = orders.find((o) => o.symbol === sym && o.type === 'STOP_MARKET' && (o.closePosition === true || o.reduceOnly === true));
    const tpO = orders.find((o) => o.symbol === sym && o.type === 'TAKE_PROFIT_MARKET' && (o.closePosition === true || o.reduceOnly === true));
    rows.push({
      ticket: sym,
      symbol: sym,
      type: amt > 0 ? 0 : 1,
      volume: Math.abs(amt),
      price_open: Number(x.entryPrice) || 0,
      sl: slO ? Number(slO.stopPrice) || 0 : 0,
      tp: tpO ? Number(tpO.stopPrice) || 0 : 0,
      price_current: Number(x.markPrice) || 0,
      profit: Number(x.unRealizedProfit) || 0,
      swap: 0, commission: 0,
      time: seen[sym],
      magic: 0, comment: 'Binance', leverage: Number(x.leverage) || 0,
    });
  }
  for (const k of Object.keys(seen)) if (!live.has(k)) delete seen[k];
  return ok({ positions: rows });
}

async function bOrders(keys) {
  const r = await bOpenOrders(keys);
  if (!r.ok) return r;
  const map = { LIMIT: { BUY: 2, SELL: 3 }, STOP: { BUY: 4, SELL: 5 }, STOP_MARKET: { BUY: 4, SELL: 5 } };
  const rows = [];
  for (const o of (r.data || [])) {
    if (o.closePosition === true) continue;  /* SL/TP koşullu emirleri listeye girmez */
    const t = (map[o.type] || {})[o.side];
    if (!t) continue;
    rows.push({
      ticket: o.symbol + '|' + o.orderId,
      symbol: o.symbol,
      type: t,
      volume_current: Number(o.origQty) || 0,
      volume_initial: Number(o.origQty) || 0,
      price_open: Number(o.price) || Number(o.stopPrice) || 0,
      sl: 0, tp: 0,
      price_current: Number(o.stopPrice) || 0,
      time_setup: Math.floor((Number(o.time) || Date.now()) / 1000),
    });
  }
  return ok({ orders: rows });
}

async function bClosed(p, keys) {
  const symbol = String(p.symbol || '').toUpperCase();
  if (!symbol) return ok({ positions: [], count: 0 });
  const r = await bReq('GET', '/fapi/v1/userTrades', { symbol, limit: 500 }, true, keys, 20000);
  if (!r.ok) return r;
  const rows = (r.data || [])
    .filter((t) => Number(t.realizedPnl) !== 0 || Number(t.commission) !== 0)
    .map((t) => ({
      position_id: String(t.orderId),
      symbol: t.symbol,
      type: t.side === 'BUY' ? 1 : 0,
      volume: Number(t.qty) || 0,
      closed_volume: Number(t.qty) || 0,
      open_time: Math.floor(Number(t.time) / 1000),
      open_price: Number(t.price) || 0,
      sl: 0, tp: 0,
      close_time: Math.floor(Number(t.time) / 1000),
      close_price: Number(t.price) || 0,
      profit: Number(t.realizedPnl) || 0,
      swap: 0,
      commission: Number(t.commission) || 0,
      reason: -1,
    }))
    .sort((a, b) => b.close_time - a.close_time)
    .slice(0, 300);
  return ok({ positions: rows, count: rows.length });
}

async function bMarket(p, keys) {
  const symbol = String(p.symbol || '').toUpperCase();
  const side = String(p.side || '').toLowerCase() === 'sell' ? 'SELL' : 'BUY';
  const info = await bInfo();
  const si = bSymInfo(info, symbol);
  if (!si) return err('Binance sembolü bulunamadı: ' + symbol);
  const qty = roundStep(Number(p.volume) || 0, si.qtyStep);
  if (!(qty > 0)) return err('Geçersiz hacim');
  /* kaldıraç: istenen değeri uygula, teminat yetmezse max'a kadar yükselt */
  const lev = await bEnsureLev({ symbol, volume: qty, price: p.price, leverage: p.leverage }, keys);
  if (!lev.ok) return lev;
  const r = await bReq('POST', '/fapi/v1/order', { symbol, side, type: 'MARKET', quantity: qty }, true, keys, 20000);
  if (!r.ok) return r;
  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
  if (Number(p.sl) > 0) {
    await bReq('POST', '/fapi/v1/order', { symbol, side: closeSide, type: 'STOP_MARKET', stopPrice: roundTick(Number(p.sl), si.tick), closePosition: 'true', workingType: 'MARK_PRICE' }, true, keys, 15000);
  }
  if (Number(p.tp) > 0) {
    await bReq('POST', '/fapi/v1/order', { symbol, side: closeSide, type: 'TAKE_PROFIT_MARKET', stopPrice: roundTick(Number(p.tp), si.tick), closePosition: 'true', workingType: 'MARK_PRICE' }, true, keys, 15000);
  }
  const price = Number(r.data.avgPrice) || 0;
  return ok({ result: { retcode: 10009, order: r.data.orderId, volume: qty, price }, price, leverage: lev.data.leverage, leverage_warning: lev.data.warning || '' });
}

async function bPending(p, keys) {
  const symbol = String(p.symbol || '').toUpperCase();
  const side = String(p.side || '').toLowerCase() === 'sell' ? 'SELL' : 'BUY';
  const type = String(p.type || '').toLowerCase();
  const isStop = type.includes('stop');
  const info = await bInfo();
  const si = bSymInfo(info, symbol);
  if (!si) return err('Binance sembolü bulunamadı: ' + symbol);
  const qty = roundStep(Number(p.volume) || 0, si.qtyStep);
  const price = roundTick(Number(p.price) || 0, si.tick);
  if (!(qty > 0) || !(price > 0)) return err('Geçersiz hacim/fiyat');
  /* bekleyen emir: kaldıraç ayarı başarısız olsa da emir gönderilir */
  const lev = await bEnsureLev({ symbol, volume: qty, price, leverage: p.leverage }, keys);
  const params = { symbol, side, type: isStop ? 'STOP' : 'LIMIT', quantity: qty, timeInForce: 'GTC' };
  if (isStop) { params.stopPrice = price; params.price = price; } else { params.price = price; }
  const r = await bReq('POST', '/fapi/v1/order', params, true, keys, 20000);
  if (!r.ok) return r;
  const levWarn = lev.ok ? (lev.data.warning || '') : ('Kaldıraç ayarlanamadı: ' + lev.error);
  return ok({ result: { retcode: 10009, order: r.data.orderId }, type, price, leverage: lev.ok ? lev.data.leverage : 0, leverage_warning: levWarn });
}

async function bClose(p, keys) {
  const sym = String(p.ticket || '');
  const pr = await bPositions(keys);
  if (!pr.ok) return pr;
  const pos = (pr.data.positions || []).find((x) => x.symbol === sym);
  if (!pos) return err('Pozisyon bulunamadı: ' + sym);
  const info = await bInfo();
  const si = bSymInfo(info, sym);
  const qty = roundStep(Math.min(Number(p.volume) || pos.volume, pos.volume), si ? si.qtyStep : 0.001);
  if (!(qty > 0)) return err('Geçersiz hacim');
  const side = pos.type === 0 ? 'SELL' : 'BUY';
  const r = await bReq('POST', '/fapi/v1/order', { symbol: sym, side, type: 'MARKET', quantity: qty, reduceOnly: 'true' }, true, keys, 20000);
  if (!r.ok) return r;
  return ok({ result: { retcode: 10009, order: r.data.orderId, volume: qty } });
}

async function bModify(p, keys) {
  const sym = String(p.ticket || '');
  const info = await bInfo();
  const si = bSymInfo(info, sym);
  if (!si) return err('Binance sembolü bulunamadı: ' + sym);
  const pr = await bPositions(keys);
  if (!pr.ok) return pr;
  const pos = (pr.data.positions || []).find((x) => x.symbol === sym);
  if (!pos) return err('Pozisyon bulunamadı: ' + sym);
  const or = await bOpenOrders(keys);
  for (const o of (or.ok && Array.isArray(or.data) ? or.data : [])) {
    if (o.symbol !== sym) continue;
    if ((o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET') && (o.closePosition === true || o.reduceOnly === true)) {
      await bReq('DELETE', '/fapi/v1/order', { symbol: sym, orderId: o.orderId }, true, keys, 12000);
    }
  }
  const closeSide = pos.type === 0 ? 'SELL' : 'BUY';
  if (Number(p.sl) > 0) {
    const r1 = await bReq('POST', '/fapi/v1/order', { symbol: sym, side: closeSide, type: 'STOP_MARKET', stopPrice: roundTick(Number(p.sl), si.tick), closePosition: 'true', workingType: 'MARK_PRICE' }, true, keys, 15000);
    if (!r1.ok) return r1;
  }
  if (Number(p.tp) > 0) {
    const r2 = await bReq('POST', '/fapi/v1/order', { symbol: sym, side: closeSide, type: 'TAKE_PROFIT_MARKET', stopPrice: roundTick(Number(p.tp), si.tick), closePosition: 'true', workingType: 'MARK_PRICE' }, true, keys, 15000);
    if (!r2.ok) return r2;
  }
  return ok({ result: { retcode: 10009 } });
}

async function bOrderDelete(p, keys) {
  const parts = String(p.ticket || '').split('|');
  if (parts.length !== 2) return err('Emir kimliği geçersiz');
  const r = await bReq('DELETE', '/fapi/v1/order', { symbol: parts[0], orderId: parts[1] }, true, keys, 15000);
  if (!r.ok) return r;
  return ok({ result: { retcode: 10009 } });
}

async function bOrderModify(p, keys) {
  const parts = String(p.ticket || '').split('|');
  if (parts.length !== 2) return err('Emir kimliği geçersiz');
  const info = await bInfo();
  const si = bSymInfo(info, parts[0]);
  const price = roundTick(Number(p.price) || 0, si ? si.tick : 0);
  if (!(price > 0)) return err('Geçersiz fiyat');
  const r = await bReq('PUT', '/fapi/v1/order', { symbol: parts[0], orderId: parts[1], price }, true, keys, 15000);
  if (!r.ok) return r;
  return ok({ result: { retcode: 10009 } });
}

async function bAllSymbols() {
  const info = await bInfo();
  if (!info) return err('Binance sembol listesi alınamadı (internet?)');
  const rows = (info.symbols || [])
    .filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING')
    .map((s) => ({ name: s.symbol, desc: s.baseAsset + ' Perp', visible: false }));
  return ok({ symbols: rows, count: rows.length, truncated: false });
}

async function bSymbols(p) {
  const info = await bInfo();
  if (!info) return err('Binance sembol bilgisi alınamadı');
  const out = [];
  for (const s of (p.symbols || [])) {
    const si = bSymInfo(info, String(s).toUpperCase());
    if (!si) { out.push({ symbol: s, missing: true }); continue; }
    out.push({
      symbol: si.symbol, digits: si.digits, point: si.tick,
      trade_tick_size: 1, trade_tick_value: 1,
      volume_min: si.qtyMin, volume_step: si.qtyStep, trade_stops_level: 0, spread: 0,
      leverage_max: 125,
    });
  }
  return ok({ symbols: out });
}

/* ---------------- OKX ---------------- */
function okxHeaders(method, pathWithQuery, body, keys) {
  const ts = new Date().toISOString();
  const sign = crypto.createHmac('sha256', keys.secret || '')
    .update(ts + method + pathWithQuery + (body || ''))
    .digest('base64');
  const h = {
    'OK-ACCESS-KEY': keys.key || '',
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': keys.pass || '',
    'Content-Type': 'application/json',
  };
  return h;
}

async function oReq(method, path, params, body, keys, timeoutMs) {
  const q = params ? new URLSearchParams(params).toString() : '';
  const pathQ = path + (q ? '?' + q : '');
  const opts = { method };
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  const signed = !!(keys && keys.key && keys.secret);
  if (signed) {
    /* GET istekleri de imza ister: body yoksa boş string ile imzalanır */
    opts.headers = okxHeaders(method, pathQ, bodyStr, keys);
    if (body !== undefined) opts.body = bodyStr;
  } else if (body !== undefined) {
    return err('OKX API anahtarları girilmemiş (Ayarlar > OKX API)');
  }
  const r = await jfetch(OKX_BASE + pathQ, opts, timeoutMs);
  if (!r.json) return err('OKX: HTTP ' + r.status + (r.txt ? ' · ' + String(r.txt).slice(0, 120) : ''));
  if (String(r.json.code) !== '0') {
    return err('OKX: ' + (r.json.msg || r.json.code) + ' (kod ' + r.json.code + ')');
  }
  return ok(r.json.data);
}

async function oInfo() {
  if (infoCache.okx.data && Date.now() - infoCache.okx.at < 300000) return infoCache.okx.data;
  const r = await oReq('GET', '/api/v5/public/instruments', { instType: 'SWAP' }, undefined, null, 15000);
  if (!r.ok) return null;
  infoCache.okx = { at: Date.now(), data: r.data };
  return r.data;
}

function oSymInfo(info, symbol) {
  const s = (info || []).find((x) => x.instId === symbol);
  if (!s) return null;
  return {
    symbol: s.instId,
    digits: (String(s.tickSz || '').split('.')[1] || '').length,
    tick: Number(s.tickSz) || 0,
    lot: Number(s.lotSz) || 1,
    min: Number(s.minSz) || 1,
    ctVal: Number(s.ctVal) || 1,
    maxLever: Number(s.lever) || 0,
  };
}

async function oRates(p) {
  const symbol = String(p.symbol || '').toUpperCase();
  if (!symbol) return err('symbol zorunlu');
  const bar = TF_OKX[String(p.timeframe || 'M15').toUpperCase()] || '15m';
  const before = Number(p.before_ts) || 0;
  let rows = [];
  if (before > 0) {
    /* geçmiş sayfalama: history-candles + after (eski mumlar), limit en fazla 100 */
    const limit = Math.max(1, Math.min(Number(p.count) || 100, 100));
    const r = await oReq('GET', '/api/v5/market/history-candles', { instId: symbol, bar, after: String(Math.floor(before * 1000)), limit }, undefined, null, 15000);
    if (!r.ok) return r;
    rows = (r.data || []).map((k) => ({
      time: Math.floor(Number(k[0]) / 1000),
      open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
      tick_volume: Number(k[5]) || 0, spread: 0, real_volume: Number(k[6]) || 0,
    })).filter((x) => x.time < before).reverse();
  } else {
    const limit = Math.max(1, Math.min(Number(p.count) || 300, 300));
    const r = await oReq('GET', '/api/v5/market/candles', { instId: symbol, bar, limit }, undefined, null, 15000);
    if (!r.ok) return r;
    rows = (r.data || []).map((k) => ({
      time: Math.floor(Number(k[0]) / 1000),
      open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]),
      tick_volume: Number(k[5]) || 0, spread: 0, real_volume: Number(k[6]) || 0,
    })).reverse();
  }
  return ok({ symbol, timeframe: String(p.timeframe || 'M15').toUpperCase(), count: rows.length, rates: rows });
}

async function oTicks(p) {
  const symbol = String(p.symbol || '').toUpperCase();
  if (!symbol) return err('symbol zorunlu');
  const [tr, info] = await Promise.all([
    oReq('GET', '/api/v5/market/ticker', { instId: symbol }, undefined, null, 10000),
    oInfo(),
  ]);
  if (!tr.ok) return tr;
  const t = (tr.data || [])[0] || {};
  const si = oSymInfo(info, symbol);
  const digits = si ? si.digits : 2;
  const point = Math.pow(10, -digits);
  const bid = Number(t.bidPx) || 0;
  const ask = Number(t.askPx) || 0;
  return ok({
    tick: { bid, ask, last: Number(t.last) || 0, time: Math.floor(Date.now() / 1000) },
    spread: point > 0 ? Math.round((ask - bid) / point) : 0,
    digits,
    point,
  });
}

async function oAccount(keys) {
  const r = await oReq('GET', '/api/v5/account/balance', {}, undefined, keys, 12000);
  if (!r.ok) return r;
  const d = (r.data || [])[0] || {};
  const det = (d.details || []).find((x) => x.ccy === 'USDT') || (d.details || [])[0] || {};
  const eq = Number(d.totalEq) || 0;
  const free = Number(det.availBal) || 0;
  return ok({ account: {
    login: 0, server: 'OKX Swap', currency: 'USDT',
    balance: Number(det.cashBal) || Number(det.eq) || eq,
    equity: eq,
    margin: Number(det.frozenBal) || 0,
    margin_free: free,
    margin_level: 0,
    profit: Number(det.upl) || 0,
  } });
}

/* ---- varlık: bakiye / ağlar / transfer / çekim (OKX) ----
   Para transferi YALNIZ gerçek hesapla yapılır (demo modda çağrılmaz). */
async function oFundingBalances(p, keys) {
  const ccy = String((p && p.ccy) || '').toUpperCase();
  const r = await oReq('GET', '/api/v5/asset/balances', ccy ? { ccy } : {}, undefined, keys, 12000);
  if (!r.ok) return r;
  const balances = (r.data || []).map((x) => ({
    ccy: x.ccy,
    avail: Number(x.availBal) || 0,
    frozen: Number(x.frozenBal) || 0,
    bal: Number(x.bal) || 0,
  }));
  return ok({ balances });
}

async function oTradeBalances(p, keys) {
  const ccy = String((p && p.ccy) || '').toUpperCase();
  const r = await oReq('GET', '/api/v5/account/balance', ccy ? { ccy } : {}, undefined, keys, 12000);
  if (!r.ok) return r;
  const d = (r.data || [])[0] || {};
  const balances = (d.details || [])
    .filter((x) => !ccy || x.ccy === ccy)
    .map((x) => ({
      ccy: x.ccy,
      avail: Number(x.availBal) || 0,
      frozen: Number(x.frozenBal) || 0,
      bal: Number(x.cashBal) || 0,
      eq: Number(x.eq) || 0,
    }));
  return ok({ balances });
}

/* ağ/coin listesi: min çekim, ağ ücreti aralığı, tag gereksinimi, tick adımı */
async function oCurrencies(p, keys) {
  const ccy = String((p && p.ccy) || '').toUpperCase();
  const r = await oReq('GET', '/api/v5/asset/currencies', ccy ? { ccy } : {}, undefined, keys, 15000);
  if (!r.ok) return r;
  const currencies = (r.data || []).map((x) => ({
    ccy: x.ccy,
    chain: x.chain,
    chainName: x.chainName || x.chain,
    canWd: x.canWd === true,
    canDep: x.canDep === true,
    needTag: x.needTag === true,
    mainChain: x.mainChain === true,
    minWd: Number(x.minWd) || 0,
    maxWd: Number(x.maxWd) || 0,
    minFee: Number(x.minFee) || 0,
    maxFee: Number(x.maxFee) || 0,
    wdTickSz: Number(x.wdTickSz) || 0,
    state: String(x.state || ''),
  }));
  return ok({ currencies });
}

/* hesaplar arası transfer: from/to 6=Funding, 18=Trading; type 0 = hesap içi */
async function oTransfer(p, keys) {
  const ccy = String((p && p.ccy) || 'USDT').toUpperCase();
  const amt = Number(p && p.amt);
  const from = String(p && p.from) === '18' ? '18' : '6';
  const to = String(p && p.to) === '18' ? '18' : '6';
  if (!ccy) return err('Birim (ccy) gerekli');
  if (!(amt > 0)) return err('Geçersiz tutar');
  if (from === to) return err('Kaynak ve hedef hesap aynı olamaz');
  const r = await oReq('POST', '/api/v5/asset/transfer', undefined, {
    ccy, amt: String(amt), from, to, type: '0',
  }, keys, 20000);
  if (!r.ok) return r;
  const d = (r.data || [])[0] || {};
  if (d.sCode && d.sCode !== '0') return err('OKX: ' + (d.sMsg || d.sCode));
  return ok({
    transfer: {
      transId: d.transId || '', ccy: d.ccy || ccy, amt: Number(d.amt) || amt,
      from: d.from || from, to: d.to || to,
    },
  });
}

/* çekim: dest 4=on-chain (chain+fee zorunlu), 3=OKX içi (e-posta/telefon) */
async function oWithdraw(p, keys) {
  const ccy = String((p && p.ccy) || '').toUpperCase();
  const amt = Number(p && p.amt);
  const dest = String(p && p.dest) === '3' ? '3' : '4';
  const toAddr = String((p && p.toAddr) || '').trim();
  const chain = String((p && p.chain) || '').trim();
  const fee = Number(p && p.fee);
  if (!ccy) return err('Birim (ccy) gerekli');
  if (!(amt > 0)) return err('Geçersiz tutar');
  if (!toAddr) return err('Adres gerekli');
  if (dest === '4' && !chain) return err('On-chain çekimde ağ (chain) seçilmeli');
  if (dest === '4' && !(fee >= 0)) return err('Geçersiz ağ ücreti');
  const body = {
    ccy,
    amt: String(amt),
    dest,
    toAddr,
    fee: dest === '3' ? '0' : String(fee),
  };
  if (dest === '4') body.chain = chain;
  /* OKX dokümanı: toAddrType 1 = adres/e-posta/telefon/hesap adı, 2 = UID (yalnız
     dest=3). UID ile iç transferde '2' gönderilmezse OKX sayısal toAddr'ı telefon
     sanar ve areaCode ister (50014). İç transfer burada YALNIZ UID'dir. */
  if (dest === '3') body.toAddrType = (p && p.toAddrType) === '1' ? '1' : '2';
  if (p && p.areaCode) body.areaCode = String(p.areaCode).slice(0, 10);
  if (p && p.clientId) body.clientId = String(p.clientId).slice(0, 40);
  const r = await oReq('POST', '/api/v5/asset/withdrawal', undefined, body, keys, 25000);
  if (!r.ok) return r;
  const d = (r.data || [])[0] || {};
  return ok({
    withdrawal: {
      wdId: d.wdId || '', ccy: d.ccy || ccy, amt: Number(d.amt) || amt,
      chain: d.chain || chain,
    },
  });
}

async function oWithdrawals(p, keys) {
  const params = { limit: String(Math.max(1, Math.min(Number((p && p.limit) || 20), 100))) };
  const ccy = String((p && p.ccy) || '').toUpperCase();
  if (ccy) params.ccy = ccy;
  const r = await oReq('GET', '/api/v5/asset/withdrawal-history', params, undefined, keys, 15000);
  if (!r.ok) return r;
  const withdrawals = (r.data || []).map((x) => ({
    wdId: x.wdId || '', ccy: x.ccy, chain: x.chain || '',
    amt: Number(x.amt) || 0, fee: Number(x.fee) || 0,
    toAddr: x.toAddr || x.to || '', tag: x.tag || '', txId: x.txId || '',
    state: String(x.state == null ? '' : x.state), ts: Number(x.ts) || 0,
  }));
  return ok({ withdrawals });
}

async function oTransfers(p, keys) {
  const params = { limit: String(Math.max(1, Math.min(Number((p && p.limit) || 20), 100))) };
  const ccy = String((p && p.ccy) || '').toUpperCase();
  if (ccy) params.ccy = ccy;
  const r = await oReq('GET', '/api/v5/asset/transfer-history', params, undefined, keys, 15000);
  if (!r.ok) return r;
  const transfers = (r.data || []).map((x) => ({
    transId: x.transId || '', ccy: x.ccy,
    amt: Number(x.amt) || 0, from: String(x.from || ''), to: String(x.to || ''),
    state: String(x.state || ''), ts: Number(x.ts) || 0, type: String(x.type || ''),
  }));
  return ok({ transfers });
}

/* ---- kaldıraç (OKX) ---- */
async function oCurLev(symbol, keys) {
  const r = await oReq('GET', '/api/v5/account/leverage-info', { instId: symbol, mgnMode: 'cross' }, undefined, keys, 12000);
  if (!r.ok) return 0;
  const row = (r.data || [])[0];
  return row ? Number(row.lever) || 0 : 0;
}

async function oSetLev(symbol, lev, keys) {
  const r = await oReq('POST', '/api/v5/account/set-leverage', undefined, { instId: symbol, lever: String(lev), mgnMode: 'cross' }, keys, 15000);
  if (!r.ok) return r;
  const d = (r.data || [])[0] || {};
  if (d.sCode && d.sCode !== '0') return err('OKX: ' + (d.sMsg || d.sCode));
  return ok({ leverage: Number(d.lever) || lev });
}

async function oLevPrice(symbol) {
  const t = await oReq('GET', '/api/v5/market/ticker', { instId: symbol }, undefined, null, 8000);
  if (!t.ok) return 0;
  const row = (t.data || [])[0] || {};
  return Number(row.last) || 0;
}

async function oLevInfo(p, keys) {
  const symbol = String(p.symbol || '').toUpperCase();
  const info = await oInfo();
  const si = oSymInfo(info, symbol);
  if (!si) return err('OKX sembolü bulunamadı: ' + symbol);
  const cur = await oCurLev(symbol, keys);
  return ok({ symbol, leverage: cur, max: si.maxLever || 0 });
}

/* istenen kaldıracı uygular; teminat yetmiyorsa sembol maksimumuna kadar yükseltir */
async function oEnsureLev(p, keys) {
  const symbol = String(p.symbol || '').toUpperCase();
  const info = await oInfo();
  const si = oSymInfo(info, symbol);
  if (!si) return err('OKX sembolü bulunamadı: ' + symbol);
  const maxLev = si.maxLever || 0;
  const cur = await oCurLev(symbol, keys);
  const wanted = Math.floor(Number(p.leverage) || 0);
  let required = 0;
  const sz = Number(p.volume) || 0;
  if (sz > 0) {
    let price = Number(p.price) || 0;
    if (!(price > 0)) price = await oLevPrice(symbol);
    if (price > 0) {
      const acc = await oAccount(keys);
      const free = acc.ok ? Number(acc.data.account.margin_free) || 0 : 0;
      if (free > 0) required = Math.max(1, Math.ceil((sz * (si.ctVal || 1) * price) / free));
    }
  }
  let target = wanted > 0 ? Math.max(wanted, required) : Math.max(cur, required);
  if (!(target > 0)) target = cur || 20;
  if (maxLev > 0) target = Math.min(maxLev, target);
  target = Math.max(1, target);
  const insufficient = maxLev > 0 && required > maxLev;
  let applied = cur;
  let warning = '';
  if (target !== cur) {
    const r = await oSetLev(symbol, target, keys);
    if (r.ok) applied = r.data.leverage;
    else if (target < cur) warning = 'Kaldıraç ' + target + 'x yapılamadı (' + r.error + ') — ' + cur + 'x ile devam';
    else return r;
  }
  if (insufficient) warning = 'Serbest teminat yetersiz: bu hacim ~' + required + 'x gerektiriyor, sembol maksimumu ' + maxLev + 'x';
  return ok({ symbol, leverage: applied, max: maxLev, required, changed: applied !== cur, insufficient, warning });
}

/* bekleyen algo emirlerinden (TP/SL) kapatıcı taraf seviyeleri:
   OKX emre/algo'ya iliştirilen TP/SL'yi pozisyon kaydında göstermez.
   Not: OKX bu uçta ordType'ı zorunlu tutar; iliştirilen TP/SL "oco" gelir. */
async function oAlgoLevels(keys) {
  const all = {};
  const ro = {};
  const put = (dst, sym, side, sl, tp) => {
    const m = dst[sym] || (dst[sym] = { buy: { sl: 0, tp: 0 }, sell: { sl: 0, tp: 0 } });
    const b = m[side];
    if (sl > 0 && !(b.sl > 0)) b.sl = sl;
    if (tp > 0 && !(b.tp > 0)) b.tp = tp;
  };
  for (const ordType of ['oco', 'conditional']) {
    try {
      const r = await oReq('GET', '/api/v5/trade/orders-algo-pending', { instType: 'SWAP', ordType }, undefined, keys, 12000);
      if (!r.ok) continue;
      for (const a of (r.data || [])) {
        const state = String(a.state || 'live');
        if (state !== 'live' && state !== 'effective') continue;
        const side = String(a.side || '').toLowerCase();
        if (side !== 'buy' && side !== 'sell') continue;
        const sl = Number(a.slTriggerPx) || 0;
        const tp = Number(a.tpTriggerPx) || 0;
        if (!(sl > 0) && !(tp > 0)) continue;
        put(all, a.instId, side, sl, tp);
        /* reduceOnly olanlar pozisyonu kapatan emirlerdir: giriş emirlerine tercih edilir */
        if (String(a.reduceOnly) === 'true') put(ro, a.instId, side, sl, tp);
      }
    } catch {}
  }
  return { all, ro };
}

async function oPositions(keys) {
  const r = await oReq('GET', '/api/v5/account/positions', { instType: 'SWAP' }, undefined, keys, 12000);
  if (!r.ok) return r;
  const algo = await oAlgoLevels(keys);
  const now = Math.floor(Date.now() / 1000);
  const seen = posSeen.okx;
  const live = new Set();
  const rows = [];
  for (const x of (r.data || [])) {
    const pos = Number(x.pos) || 0;
    if (!pos) continue;
    const sym = x.instId;
    live.add(sym);
    if (!seen[sym]) seen[sym] = now;
    const upd = Number(x.uTime) ? Math.floor(Number(x.uTime) / 1000) : now;
    /* yön: long/short modunda posSide, net modda pos işareti belirler */
    const ps = String(x.posSide || '').toLowerCase();
    const isShort = ps === 'short' || (ps !== 'long' && pos < 0);
    /* pozisyon kaydında TP/SL boşsa (iliştirilen emirler) algo emirlerinden tamamla */
    const closeSide = isShort ? 'buy' : 'sell';
    const pRo = (algo.ro[sym] || {})[closeSide] || {};
    const pAll = (algo.all[sym] || {})[closeSide] || {};
    const lv = (pRo.sl > 0 || pRo.tp > 0) ? pRo : pAll;
    const sl = Number(x.slTriggerPx) > 0 ? Number(x.slTriggerPx) : (lv.sl || 0);
    const tp = Number(x.tpTriggerPx) > 0 ? Number(x.tpTriggerPx) : (lv.tp || 0);
    rows.push({
      ticket: x.posId || sym,
      symbol: sym,
      type: isShort ? 1 : 0,
      volume: Math.abs(pos),
      price_open: Number(x.avgPx) || 0,
      sl, tp,
      price_current: Number(x.markPx) || 0,
      profit: Number(x.upl) || 0,
      swap: 0,
      commission: 0,
      time: Math.min(seen[sym], upd),
      magic: 0, comment: 'OKX', leverage: Number(x.lever) || 0,
    });
  }
  for (const k of Object.keys(seen)) if (!live.has(k)) delete seen[k];
  return ok({ positions: rows });
}

async function oOrders(keys) {
  const r = await oReq('GET', '/api/v5/trade/orders-pending', { instType: 'SWAP' }, undefined, keys, 12000);
  if (!r.ok) return r;
  const rows = [];
  for (const o of (r.data || [])) {
    const t = o.ordType === 'limit' ? (o.side === 'buy' ? 2 : 3)
      : (o.ordType === 'conditional' || o.ordType === 'stop') ? (o.side === 'buy' ? 4 : 5) : 0;
    if (!t) continue;
    /* emre iliştirilen TP/SL (attachAlgoOrds) bekleyen emirde de gösterilir */
    const att = Array.isArray(o.attachAlgoOrds) && o.attachAlgoOrds[0] ? o.attachAlgoOrds[0] : null;
    rows.push({
      ticket: o.instId + '|' + o.ordId,
      symbol: o.instId,
      type: t,
      volume_current: Number(o.sz) || 0,
      volume_initial: Number(o.sz) || 0,
      price_open: Number(o.px) || Number(o.slTriggerPx) || 0,
      sl: att ? (Number(att.slTriggerPx) || 0) : 0,
      tp: att ? (Number(att.tpTriggerPx) || 0) : 0,
      price_current: Number(o.slTriggerPx) || 0,
      time_setup: Math.floor((Number(o.cTime) || Date.now()) / 1000),
    });
  }
  return ok({ orders: rows });
}

async function oClosed(p, keys) {
  const symbol = String(p.symbol || '').toUpperCase();
  if (!symbol) return ok({ positions: [], count: 0 });
  /* kapanan pozisyonlar: fills-history pnl vermez; positions-history realizedPnl/fee/funding verir */
  const r = await oReq('GET', '/api/v5/account/positions-history', { instType: 'SWAP', instId: symbol, limit: 100 }, undefined, keys, 20000);
  if (!r.ok) return r;
  const rows = (r.data || []).map((h) => ({
    position_id: h.posId || '',
    symbol: h.instId,
    type: String(h.direction || '').toLowerCase() === 'short' ? 1 : 0,
    volume: Number(h.closeTotalPos) || Number(h.openMaxPos) || 0,
    closed_volume: Number(h.closeTotalPos) || 0,
    open_time: Math.floor((Number(h.cTime) || Date.now()) / 1000),
    open_price: Number(h.openAvgPx) || 0,
    sl: 0, tp: 0,
    close_time: Math.floor((Number(h.uTime) || Date.now()) / 1000),
    close_price: Number(h.closeAvgPx) || 0,
    profit: Number(h.realizedPnl) || 0,
    swap: Number(h.fundingFee) || 0,
    commission: (Number(h.fee) || 0) + (Number(h.liqPenalty) || 0),
    reason: -1,
  })).sort((a, b) => b.close_time - a.close_time);
  return ok({ positions: rows, count: rows.length });
}

/* TP/SL'yi ayrı algo emri olarak kur (attachAlgoOrds desteklenmediğinde yedek yol) */
async function oPlaceAlgo(symbol, side, sz, slPx, tpPx, keys) {
  const both = slPx > 0 && tpPx > 0;
  const body = { instId: symbol, tdMode: 'cross', side, ordType: both ? 'oco' : 'conditional', sz: String(sz), reduceOnly: 'true' };
  if (slPx > 0) { body.slTriggerPx = String(slPx); body.slOrdPx = '-1'; }
  if (tpPx > 0) { body.tpTriggerPx = String(tpPx); body.tpOrdPx = '-1'; }
  if (!body.slTriggerPx && !body.tpTriggerPx) return ok({ algoId: '' });
  const r = await oReq('POST', '/api/v5/trade/order-algo', undefined, body, keys, 15000);
  if (!r.ok) return r;
  const d = (r.data || [])[0] || {};
  if (d.sCode && d.sCode !== '0') return err('OKX: ' + (d.sMsg || d.sCode));
  return ok({ algoId: d.algoId || '' });
}

async function oOrderDetail(symbol, ordId, keys) {
  const r = await oReq('GET', '/api/v5/trade/order', { instId: symbol, ordId: String(ordId) }, undefined, keys, 12000);
  if (!r.ok) return null;
  return (r.data || [])[0] || null;
}

/* TP/SL bilgisini emre iliştir; tick'e yuvarlanmış fiyatlarla */
function oAttachAlgo(slPx, tpPx) {
  if (!(slPx > 0) && !(tpPx > 0)) return null;
  const att = { attachAlgoClOrdId: 'jev' + Date.now().toString(36) };
  if (slPx > 0) { att.slTriggerPx = String(slPx); att.slOrdPx = '-1'; }
  if (tpPx > 0) { att.tpTriggerPx = String(tpPx); att.tpOrdPx = '-1'; }
  return att;
}

async function oMarket(p, keys) {
  const symbol = String(p.symbol || '').toUpperCase();
  const side = String(p.side || '').toLowerCase() === 'sell' ? 'sell' : 'buy';
  const info = await oInfo();
  const si = oSymInfo(info, symbol);
  if (!si) return err('OKX sembolü bulunamadı: ' + symbol);
  const sz = Math.max(si.min, Math.round((Number(p.volume) || 0) / si.lot) * si.lot);
  if (!(sz > 0)) return err('Geçersiz hacim');
  /* kaldıraç: istenen değeri uygula, teminat yetmezse max'a kadar yükselt */
  const lev = await oEnsureLev({ symbol, volume: sz, price: p.price, leverage: p.leverage }, keys);
  if (!lev.ok) return lev;
  /* tetik fiyatları sembolün tick adımına yuvarlanmalı (yoksa OKX iliştirileni reddeder) */
  const slPx = Number(p.sl) > 0 ? roundTick(Number(p.sl), si.tick) : 0;
  const tpPx = Number(p.tp) > 0 ? roundTick(Number(p.tp), si.tick) : 0;
  const body = { instId: symbol, tdMode: 'cross', side, ordType: 'market', sz: String(sz) };
  const att = oAttachAlgo(slPx, tpPx);
  if (att) body.attachAlgoOrds = [att];
  const r = await oReq('POST', '/api/v5/trade/order', undefined, body, keys, 20000);
  if (!r.ok) return r;
  const d = (r.data || [])[0] || {};
  if (d.sCode && d.sCode !== '0') return err('OKX: ' + (d.sMsg || d.sCode));
  /* iliştirilen TP/SL gerçekten oluştu mu? oluşmadıysa ayrı algo emriyle kur */
  let warning = '';
  if (att && d.ordId) {
    let det = null;
    let attached = false;
    /* dolum sonrası algo emri hemen görünmeyebilir: iki kez kontrol et (çift TP/SL riskine karşı) */
    for (let i = 0; i < 4; i++) {
      det = await oOrderDetail(symbol, d.ordId, keys);
      if (det) {
        const list = Array.isArray(det.attachAlgoOrds) ? det.attachAlgoOrds : [];
        attached = list.some((x) => x && x.attachAlgoId);
        if (attached) break;
        if (det.state === 'filled' && i >= 1) break;
      }
      await new Promise((res) => setTimeout(res, 350));
    }
    if (det && det.state === 'filled' && !attached) {
      const fillSz = Number(det.accFillSz) > 0 ? Number(det.accFillSz) : sz;
      const alt = await oPlaceAlgo(symbol, side === 'buy' ? 'sell' : 'buy', fillSz, slPx, tpPx, keys);
      if (!alt.ok) warning = 'TP/SL kurulamadı (' + alt.error + ') — pozisyon korumasız!';
    }
  }
  const price = Number(p.price) || 0;
  return ok({ result: { retcode: 10009, order: d.ordId, volume: sz, price }, price, leverage: lev.data.leverage, leverage_warning: lev.data.warning || '', warning });
}

async function oPending(p, keys) {
  const symbol = String(p.symbol || '').toUpperCase();
  const side = String(p.side || '').toLowerCase() === 'sell' ? 'sell' : 'buy';
  const isStop = String(p.type || '').toLowerCase().includes('stop');
  const info = await oInfo();
  const si = oSymInfo(info, symbol);
  if (!si) return err('OKX sembolü bulunamadı: ' + symbol);
  const sz = Math.max(si.min, Math.round((Number(p.volume) || 0) / si.lot) * si.lot);
  const px = Number(p.price) || 0;
  if (!(sz > 0) || !(px > 0)) return err('Geçersiz hacim/fiyat');
  /* bekleyen emir: kaldıraç ayarı başarısız olsa da emir gönderilir */
  const lev = await oEnsureLev({ symbol, volume: sz, price: px, leverage: p.leverage }, keys);
  const slPx = Number(p.sl) > 0 ? roundTick(Number(p.sl), si.tick) : 0;
  const tpPx = Number(p.tp) > 0 ? roundTick(Number(p.tp), si.tick) : 0;
  const body = isStop
    ? { instId: symbol, tdMode: 'cross', side, ordType: 'conditional', sz: String(sz), slTriggerPx: String(roundTick(px, si.tick)), slOrdPx: '-1' }
    : { instId: symbol, tdMode: 'cross', side, ordType: 'limit', sz: String(sz), px: String(roundTick(px, si.tick)) };
  /* limit/stop girişte de TP/SL iliştir (dolumda oluşur) */
  const att = oAttachAlgo(slPx, tpPx);
  if (att) body.attachAlgoOrds = [att];
  const r = await oReq('POST', '/api/v5/trade/order', undefined, body, keys, 20000);
  if (!r.ok) return r;
  const d = (r.data || [])[0] || {};
  if (d.sCode && d.sCode !== '0') return err('OKX: ' + (d.sMsg || d.sCode));
  const levWarn = lev.ok ? (lev.data.warning || '') : ('Kaldıraç ayarlanamadı: ' + lev.error);
  return ok({ result: { retcode: 10009, order: d.ordId }, type: String(p.type || ''), price: px, leverage: lev.ok ? lev.data.leverage : 0, leverage_warning: levWarn });
}

async function oClose(p, keys) {
  const pr = await oPositions(keys);
  if (!pr.ok) return pr;
  const pos = (pr.data.positions || []).find((x) => String(x.ticket) === String(p.ticket) || x.symbol === String(p.ticket));
  if (!pos) return err('Pozisyon bulunamadı: ' + p.ticket);
  const sz = Math.min(Number(p.volume) || pos.volume, pos.volume);
  const side = pos.type === 0 ? 'sell' : 'buy';
  const body = { instId: pos.symbol, tdMode: 'cross', side, ordType: 'market', sz: String(sz), reduceOnly: true };
  const r = await oReq('POST', '/api/v5/trade/order', undefined, body, keys, 20000);
  if (!r.ok) return r;
  const d = (r.data || [])[0] || {};
  if (d.sCode && d.sCode !== '0') return err('OKX: ' + (d.sMsg || d.sCode));
  return ok({ result: { retcode: 10009, order: d.ordId, volume: sz } });
}

async function oModify(p, keys) {
  const pr = await oPositions(keys);
  if (!pr.ok) return pr;
  const pos = (pr.data.positions || []).find((x) => String(x.ticket) === String(p.ticket) || x.symbol === String(p.ticket));
  if (!pos) return err('Pozisyon bulunamadı: ' + p.ticket);
  /* yalnız pozisyonu kapatan taraftaki TP/SL algo emirlerini iptal et
     (aynı yöndeki bekleyen giriş emirleri korunur; OKX ordType'ı zorunlu tutar) */
  const side = pos.type === 0 ? 'sell' : 'buy';
  const cancelList = [];
  for (const ordType of ['oco', 'conditional']) {
    const pend = await oReq('GET', '/api/v5/trade/orders-algo-pending', { instType: 'SWAP', instId: pos.symbol, ordType }, undefined, keys, 12000);
    for (const a of ((pend.ok ? pend.data : []) || [])) {
      const st = String(a.state || 'live');
      if (st !== 'live' && st !== 'effective') continue;
      if (String(a.side || '').toLowerCase() !== side) continue;
      if (!(Number(a.slTriggerPx) > 0 || Number(a.tpTriggerPx) > 0)) continue;
      cancelList.push({ instId: pos.symbol, algoId: a.algoId });
    }
  }
  if (cancelList.length) {
    await oReq('POST', '/api/v5/trade/cancel-algos', undefined, cancelList, keys, 12000);
  }
  const info = await oInfo();
  const si = oSymInfo(info, pos.symbol);
  const tick = si ? si.tick : 0;
  const slPx = Number(p.sl) > 0 ? roundTick(Number(p.sl), tick) : 0;
  const tpPx = Number(p.tp) > 0 ? roundTick(Number(p.tp), tick) : 0;
  const body = { instId: pos.symbol, tdMode: 'cross', side, ordType: (slPx > 0 && tpPx > 0) ? 'oco' : 'conditional', sz: String(pos.volume), reduceOnly: 'true' };
  if (slPx > 0) { body.slTriggerPx = String(slPx); body.slOrdPx = '-1'; }
  if (tpPx > 0) { body.tpTriggerPx = String(tpPx); body.tpOrdPx = '-1'; }
  if (!body.slTriggerPx && !body.tpTriggerPx) return ok({ result: { retcode: 10009 } });
  const r = await oReq('POST', '/api/v5/trade/order-algo', undefined, body, keys, 15000);
  if (!r.ok) return r;
  const d = (r.data || [])[0] || {};
  if (d.sCode && d.sCode !== '0') return err('OKX: ' + (d.sMsg || d.sCode));
  return ok({ result: { retcode: 10009 } });
}

async function oOrderDelete(p, keys) {
  const parts = String(p.ticket || '').split('|');
  if (parts.length !== 2) return err('Emir kimliği geçersiz');
  const r = await oReq('POST', '/api/v5/trade/cancel-order', undefined, { instId: parts[0], ordId: parts[1] }, keys, 15000);
  if (!r.ok) return r;
  return ok({ result: { retcode: 10009 } });
}

async function oOrderModify(p, keys) {
  const parts = String(p.ticket || '').split('|');
  if (parts.length !== 2) return err('Emir kimliği geçersiz');
  const price = Number(p.price) || 0;
  if (!(price > 0)) return err('Geçersiz fiyat');
  const r = await oReq('POST', '/api/v5/trade/amend-order', undefined, { instId: parts[0], ordId: parts[1], newPx: String(price) }, keys, 15000);
  if (!r.ok) return r;
  return ok({ result: { retcode: 10009 } });
}

async function oAllSymbols() {
  const info = await oInfo();
  if (!info) return err('OKX sembol listesi alınamadı (internet?)');
  const rows = (info || [])
    .filter((s) => s.state === 'live' && String(s.instId).endsWith('-USDT-SWAP'))
    .map((s) => ({ name: s.instId, desc: s.instId.replace('-USDT-SWAP', '') + ' Swap', visible: false }));
  return ok({ symbols: rows, count: rows.length, truncated: false });
}

async function oSymbols(p) {
  const info = await oInfo();
  if (!info) return err('OKX sembol bilgisi alınamadı');
  const out = [];
  for (const s of (p.symbols || [])) {
    const si = oSymInfo(info, String(s).toUpperCase());
    if (!si) { out.push({ symbol: s, missing: true }); continue; }
    out.push({
      symbol: si.symbol, digits: si.digits, point: si.tick,
      trade_tick_size: 1, trade_tick_value: si.ctVal,
      volume_min: si.min, volume_step: si.lot, trade_stops_level: 0, spread: 0,
      leverage_max: si.maxLever || 0,
    });
  }
  return ok({ symbols: out });
}

/* ---------------- yönlendirme ---------------- */
async function call(exchange, method, params, keys) {
  const p = params || {};
  const k = keys || {};
  try {
    if (exchange === 'binance') {
      switch (method) {
        case 'account': return await bAccount(k);
        case 'rates': return await bRates(p);
        case 'ticks': return await bTicks(p);
        case 'all_symbols': return await bAllSymbols();
        case 'symbols': return await bSymbols(p);
        case 'positions': return await bPositions(k);
        case 'orders': return await bOrders(k);
        case 'closed': return await bClosed(p, k);
        case 'market': return await bMarket(p, k);
        case 'pending': return await bPending(p, k);
        case 'close': return await bClose(p, k);
        case 'modify': return await bModify(p, k);
        case 'order_delete': return await bOrderDelete(p, k);
        case 'order_modify': return await bOrderModify(p, k);
        case 'leverage_info': return await bLevInfo(p, k);
        case 'margin': return ok({ margin: null, price: Number(p.price) || 0 });
        default: return err('Binance: desteklenmeyen yöntem ' + method);
      }
    }
    if (exchange === 'okx') {
      switch (method) {
        case 'account': return await oAccount(k);
        case 'rates': return await oRates(p);
        case 'ticks': return await oTicks(p);
        case 'all_symbols': return await oAllSymbols();
        case 'symbols': return await oSymbols(p);
        case 'positions': return await oPositions(k);
        case 'orders': return await oOrders(k);
        case 'closed': return await oClosed(p, k);
        case 'market': return await oMarket(p, k);
        case 'pending': return await oPending(p, k);
        case 'close': return await oClose(p, k);
        case 'modify': return await oModify(p, k);
        case 'order_delete': return await oOrderDelete(p, k);
        case 'order_modify': return await oOrderModify(p, k);
        case 'leverage_info': return await oLevInfo(p, k);
        case 'margin': return ok({ margin: null, price: Number(p.price) || 0 });
        /* varlık / para transferi (OKX) — yalnız gerçek hesap */
        case 'asset_balances': return await oFundingBalances(p, k);
        case 'trade_balances': return await oTradeBalances(p, k);
        case 'currencies': return await oCurrencies(p, k);
        case 'transfer': return await oTransfer(p, k);
        case 'withdraw': return await oWithdraw(p, k);
        case 'withdrawals': return await oWithdrawals(p, k);
        case 'transfers': return await oTransfers(p, k);
        default: return err('OKX: desteklenmeyen yöntem ' + method);
      }
    }
    return err('Bilinmeyen borsa: ' + exchange);
  } catch (e) {
    return err((exchange || '') + ': ' + String((e && e.message) || e));
  }
}

module.exports = { call };
