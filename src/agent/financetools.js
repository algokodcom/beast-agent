'use strict';

/* Beast Finance — MT5 ajan araçları.
   Handler'lar main süreçteki mt5bridge singleton'ına bağlanır; işlem açan
   araçlar settings.finance.allowTrading / maxLot / maxPositions ile sınırlanır.
   main tarafı setConfig/setNotify ile ayar ve bildirim kancasını enjekte eder. */

const mt5 = require('../mt5bridge');
const finindicators = require('./finindicators');
const finstats = require('./finstats');
const finrisk = require('./finrisk');

const NAMES = [
  'mt5_status',
  'mt5_account',
  'mt5_market',
  'mt5_rates',
  'mt5_indicators',
  'mt5_risksize',
  'mt5_positions',
  'mt5_orders',
  'mt5_history',
  'mt5_alerts',
  'mt5_note',
  'mt5_trade',
  'mt5_close',
  'mt5_modify',
  'mt5_pending',
  'mt5_cancel',
];

let getCfg = () => ({ allowTrading: false, maxLot: 0.1, maxPositions: 3, symbols: [] });
let notify = () => {};
/* alarm deposu main süreçte yaşar (dosyaya kalıcı) — buradan enjekte edilir */
let alertsApi = {
  list: () => [],
  set: () => null,
  remove: () => false,
};

function setConfig(fn) {
  if (typeof fn === 'function') getCfg = fn;
}

function setNotify(fn) {
  if (typeof fn === 'function') notify = fn;
}

function setAlerts(api) {
  if (api && typeof api === 'object') alertsApi = api;
}

async function bcall(method, params, timeoutMs) {
  const r = await mt5.call(method, params, timeoutMs);
  if (!r || r.ok !== true) throw new Error((r && r.error) || 'MT5 hatası');
  return r.data;
}

async function symInfoRow(symbol) {
  const data = await bcall('symbols', { symbols: [String(symbol || '').toUpperCase()] }, 10000);
  const row = data && data.symbols && data.symbols[0];
  return row && !row.missing ? row : null;
}

function tickPrice(row, side) {
  const p = side === 'buy' ? Number(row && row.ask) : Number(row && row.bid);
  if (isFinite(p) && p > 0) return p;
  return Number(row && row.bid) || Number(row && row.ask) || 0;
}

/* İşlem öncesi risk katmanı: stops_level + yoğunluk + marj kalkanı.
   Hata metni ya da null döner. positions çağıran tarafından verilir. */
async function preTradeCheck(cfg, side, symbol, info, price, volume, sl, tp, positions) {
  const closeErr = finrisk.stopsTooClose(info, price, sl, tp);
  if (closeErr) return closeErr;
  const expErr = finrisk.exposureCheck(positions || [], side, symbol, cfg.maxPerSymbol, cfg.maxSameSide);
  if (expErr) return expErr;
  const minLevel = Number(cfg.minMarginLevel) || 0;
  let account = null;
  let estMargin = 0;
  try {
    const a = await bcall('account', {}, 8000);
    account = a && a.account;
  } catch {}
  try {
    const m = await bcall('margin', { symbol, side, volume, price }, 8000);
    estMargin = Number(m && m.margin) || 0;
  } catch {}
  const mErr = finrisk.marginCheck(account, estMargin, minLevel);
  if (mErr && mErr.error) return mErr.error;
  return null;
}

function noteTrade(kind, data, ctx) {
  try { notify({ kind, data, at: Date.now(), sid: ctx && ctx.sessionId ? String(ctx.sessionId) : '' }); } catch {}
}

function notConnected() {
  return { ok: false, error: 'MT5 köprüsü bağlı değil — terminal açık mı? (panelde ⟳ ile yeniden bağlan)' };
}

const definitions = NAMES.map((name) => {
  const specs = {
    mt5_status: {
      description:
        'MT5 (MetaTrader 5) köprü durumunu döndürür: köprü çalışıyor mu, terminale bağlı mı, terminal/hesap özeti. Her finance turunda VEYA bağlantı sorunlarında ilk çağrı.',
      parameters: { type: 'object', properties: {} },
    },
    mt5_account: {
      description:
        'MT5 hesap özeti: bakiye, özkaynak (equity), yüzen kâr/zarar, marj, serbest marj, marj seviyesi, kaldıraç, para birimi, hesap no/sunucu.',
      parameters: { type: 'object', properties: {} },
    },
    mt5_market: {
      description:
        'Verilen semboller için canlı fiyat + TAM sembol sözleşme bilgisi: bid/ask, spread, digit, point, swap_long/short, komisyon, kontrat büyüklüğü, min/max/step lot, stops_level, işlem modu. symbols verilmezse izleme listesi (watchlist) kullanılır. Örn: ["EURUSD","XAUUSD"].',
      parameters: {
        type: 'object',
        properties: {
          symbols: { type: 'array', items: { type: 'string' }, description: 'Sembol listesi (boşsa watchlist)' },
        },
      },
    },
    mt5_rates: {
      description:
        'OHLC MUM VERİSİ: mt5_rates {symbol, timeframe:"M1|M5|M15|M30|H1|H4|D1|W1|MN1", count?}. Trend/yapı/destek-direnç analizinin HAM verisi. Varsayılan M15 × 200 mum. Formasyon/price-action için İDEAL: H1/H4 yapı + M15/M5 giriş zamanlaması.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Örn: XAUUSD' },
          timeframe: { type: 'string', description: 'M1|M5|M15|M30|H1|H4|D1|W1|MN1 (varsayılan M15)' },
          count: { type: 'number', description: 'Mum sayısı 1-1000 (varsayılan 200)' },
        },
        required: ['symbol'],
      },
    },
    mt5_indicators: {
      description:
        'TEKNİK GÖSTERGELER: mt5_indicators {symbol, timeframe, count?, indicators?}. indicators örn: ["EMA(50)","EMA(200)","RSI(14)","ATR(14)","MACD(12,26,9)","BB(20,2)","STOCH(14,3,3)","SMA(200)"]. Varsayılan: EMA20/EMA50/RSI14/ATR14/MACD. ATR ile SL mesafesi/lot, RSI ile aşırı alım-satım, EMA ile trend yönü oku.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          timeframe: { type: 'string', description: 'M1|M5|M15|M30|H1|H4|D1|W1|MN1 (varsayılan H1)' },
          count: { type: 'number', description: 'Hesaplamaya giren mum sayısı (varsayılan 300, en fazla 1000)' },
          indicators: {
            type: 'array',
            items: { type: 'string' },
            description: 'Gösterge listesi (boşsa varsayılan set)',
          },
        },
        required: ['symbol'],
      },
    },
    mt5_risksize: {
      description:
        'RİSK BAZLI LOT HESABI: mt5_risksize {symbol, sl?, entry?, side?, riskPct?, atrMult?, timeframe?}. Bakiyenin riskPct%’i kadar kayıp verecek lotu hesaplar (SL mesafesi × tick değeri). sl yoksa atrMult verilirse ATR(14) ile SL mesafesi önerir. riskPct boşsa ayardaki işlem riski (%) kullanılır. İŞLEM AÇMADAN ÖNCE çağır; çıkan lotu mt5_trade’e ver.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          sl: { type: 'number', description: 'Stop loss fiyatı' },
          entry: { type: 'number', description: 'Giriş fiyatı (boşsa güncel fiyat)' },
          side: { type: 'string', enum: ['buy', 'sell'], description: 'Yön (varsayılan buy)' },
          riskPct: { type: 'number', description: 'Hesap riski yüzdesi (boşsa ayar)' },
          atrMult: { type: 'number', description: 'SL yoksa: SL mesafesi = atrMult × ATR(14)' },
          timeframe: { type: 'string', description: 'ATR zaman dilimi (varsayılan H1)' },
        },
        required: ['symbol'],
      },
    },
    mt5_positions: {
      description: 'Açık pozisyonlar: ticket, sembol, yön, lot, açılış fiyatı, güncel fiyat, SL/TP, yüzen kâr/zarar, açılış zamanı.',
      parameters: { type: 'object', properties: {} },
    },
    mt5_orders: {
      description: 'Bekleyen emirler (pending orders): ticket, sembol, tip (limit/stop), lot, fiyat, SL/TP.',
      parameters: { type: 'object', properties: {} },
    },
    mt5_history: {
      description: 'Kapanmış işlemler (deals) özeti: son N günde kapanan pozisyonlar, kâr/zarar, komisyon, swap. days=1 → son 24 saat.',
      parameters: {
        type: 'object',
        properties: { days: { type: 'number', description: 'Kaç gün geriye bakılsın (varsayılan 1, en fazla 90)' } },
      },
    },
    mt5_alerts: {
      description:
        'FİYAT ALARMI: mt5_alerts {action:"list"|"set"|"remove"}. set: {symbol, price, direction:"above"|"below", note?}. Fiyat tetiklenince sahibine bildirim gider + alarm kapanır. Örn: XAUUSD 3400 üstü / 3280 altı kritik seviye bildirimi kur.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'set', 'remove'] },
          symbol: { type: 'string', description: 'set için sembol' },
          price: { type: 'number', description: 'set için tetik fiyatı' },
          direction: { type: 'string', enum: ['above', 'below'], description: 'above: fiyat ≥ price; below: fiyat ≤ price' },
          note: { type: 'string', description: 'Alarm notu (bildirimde görünür)' },
          id: { type: 'string', description: 'remove için alarm id' },
        },
        required: ['action'],
      },
    },
    mt5_note: {
      description:
        'İŞLEM GÜNLÜĞÜ NOTU: mt5_note {symbol, note, ticket?, side?}. Kararın GEREKÇESİNİ kalıcı günlüğe yaz (neden girdin/çıktın, tez, iptal koşulu). Haftalık performans raporu bu notları içerir — her önemli kararda kullan.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          note: { type: 'string', description: 'Gerekçe/tez (kısa, net)' },
          ticket: { type: 'number', description: 'İlgili pozisyon ticket no (varsa)' },
          side: { type: 'string', enum: ['buy', 'sell', 'wait'] },
        },
        required: ['symbol', 'note'],
      },
    },
    mt5_trade: {
      description:
        'PİYASA EMRİ AÇAR: mt5_trade {symbol, side:"buy"|"sell", volume, sl?, tp?, comment?}. Lot limiti ve max pozisyon sayısı sistem tarafından zorlanır. Otomatik işlem anahtarı kapalıysa reddedilir. SL/TP vermek ŞIDDETLİ önerilir.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Örn: EURUSD' },
          side: { type: 'string', enum: ['buy', 'sell'] },
          volume: { type: 'number', description: 'Lot (max lot sınırına tabi)' },
          sl: { type: 'number', description: 'Stop loss fiyatı (0 = yok)' },
          tp: { type: 'number', description: 'Take profit fiyatı (0 = yok)' },
          comment: { type: 'string', description: 'Kısa işlem notu' },
        },
        required: ['symbol', 'side', 'volume'],
      },
    },
    mt5_close: {
      description: 'Açık pozisyonu kapatır: mt5_close {ticket, volume?}. volume verilirse kısmi kapatır. Risk yönetimi için kullanılır.',
      parameters: {
        type: 'object',
        properties: {
          ticket: { type: 'number', description: 'Pozisyon ticket no' },
          volume: { type: 'number', description: 'Kapatılacak lot (boşsa tamamı)' },
        },
        required: ['ticket'],
      },
    },
    mt5_modify: {
      description: 'Pozisyonun SL/TP seviyelerini günceller: mt5_modify {ticket, sl, tp}. SL’siz pozisyon bırakmamak için kullan.',
      parameters: {
        type: 'object',
        properties: {
          ticket: { type: 'number' },
          sl: { type: 'number', description: 'Yeni SL (0 = kaldır)' },
          tp: { type: 'number', description: 'Yeni TP (0 = kaldır)' },
        },
        required: ['ticket'],
      },
    },
    mt5_pending: {
      description:
        'BEKLEYEN EMİR koyar: mt5_pending {symbol, type:"buy_limit"|"sell_limit"|"buy_stop"|"sell_stop", volume, price, sl?, tp?}. Otomatik işlem anahtarına tabidir.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          type: { type: 'string', enum: ['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop'] },
          volume: { type: 'number' },
          price: { type: 'number' },
          sl: { type: 'number' },
          tp: { type: 'number' },
        },
        required: ['symbol', 'type', 'volume', 'price'],
      },
    },
    mt5_cancel: {
      description: 'Bekleyen emri iptal eder: mt5_cancel {ticket}.',
      parameters: {
        type: 'object',
        properties: { ticket: { type: 'number' } },
        required: ['ticket'],
      },
    },
  };
  const s = specs[name];
  return { type: 'function', function: { name, ...s } };
});

const handlers = {
  async mt5_status() {
    const st = mt5.status();
    return { ok: true, ...st };
  },
  async mt5_account() {
    if (!mt5.running) return notConnected();
    const data = await bcall('account', {}, 8000);
    return { ok: true, ...data };
  },
  async mt5_market(args) {
    if (!mt5.running) return notConnected();
    const cfg = getCfg();
    let syms = Array.isArray(args.symbols) ? args.symbols.map((s) => String(s).trim()).filter(Boolean) : [];
    if (!syms.length) syms = Array.isArray(cfg.symbols) ? cfg.symbols : [];
    const data = await bcall('symbols', { symbols: syms }, 10000);
    return { ok: true, symbols: data && data.symbols ? data.symbols : [] };
  },
  async mt5_rates(args) {
    if (!mt5.running) return notConnected();
    const symbol = String(args.symbol || '').trim().toUpperCase();
    if (!symbol) return { ok: false, error: 'symbol gerekli' };
    const timeframe = String(args.timeframe || 'M15').trim().toUpperCase();
    let count = Math.round(Number(args.count) || 200);
    count = Math.max(1, Math.min(1000, count));
    const data = await bcall('rates', { symbol, timeframe, count }, 15000);
    const rates = (data && data.rates) || [];
    return { ok: true, symbol, timeframe, count: rates.length, rates };
  },
  async mt5_indicators(args) {
    if (!mt5.running) return notConnected();
    const symbol = String(args.symbol || '').trim().toUpperCase();
    if (!symbol) return { ok: false, error: 'symbol gerekli' };
    const timeframe = String(args.timeframe || 'H1').trim().toUpperCase();
    let count = Math.round(Number(args.count) || 300);
    count = Math.max(30, Math.min(1000, count));
    const specs = Array.isArray(args.indicators) ? args.indicators.map((s) => String(s || '').trim()).filter(Boolean) : [];
    const data = await bcall('rates', { symbol, timeframe, count }, 15000);
    const rates = (data && data.rates) || [];
    if (!rates.length) return { ok: false, error: 'mum verisi yok: ' + symbol + ' ' + timeframe };
    const summary = finindicators.compute(rates, specs);
    return { ok: true, symbol, timeframe, ...summary };
  },
  async mt5_positions() {
    if (!mt5.running) return notConnected();
    const data = await bcall('positions', {}, 8000);
    const list = (data && data.positions) || [];
    return { ok: true, count: list.length, positions: list };
  },
  async mt5_orders() {
    if (!mt5.running) return notConnected();
    const data = await bcall('orders', {}, 8000);
    const list = (data && data.orders) || [];
    return { ok: true, count: list.length, orders: list };
  },
  async mt5_history(args) {
    if (!mt5.running) return notConnected();
    let days = Number(args.days);
    if (!isFinite(days) || days <= 0) days = 1;
    days = Math.min(days, 90);
    const data = await bcall('deals', { days }, 12000);
    const deals = (data && data.deals) || [];
    const stats = finstats.summarizeDeals(deals);
    return {
      ok: true,
      days,
      count: deals.length,
      netProfit: stats.netProfit,
      wins: stats.wins,
      losses: stats.losses,
      winRate: stats.winRate,
      profitFactor: stats.profitFactor,
      bySymbol: stats.bySymbol,
      deals: deals.slice(-60),
    };
  },
  async mt5_alerts(args) {
    const action = String(args.action || 'list').toLowerCase();
    if (action === 'list') {
      const list = alertsApi.list();
      return { ok: true, count: list.length, alerts: list };
    }
    if (action === 'remove') {
      const id = String(args.id || '').trim();
      if (!id) return { ok: false, error: 'id gerekli' };
      const removed = alertsApi.remove(id);
      return { ok: !!removed, removed: !!removed, id };
    }
    if (action === 'set') {
      const symbol = String(args.symbol || '').trim().toUpperCase();
      const price = Number(args.price);
      const direction = String(args.direction || 'above').toLowerCase();
      if (!symbol) return { ok: false, error: 'symbol gerekli' };
      if (!isFinite(price) || price <= 0) return { ok: false, error: 'price gerekli (pozitif sayı)' };
      if (direction !== 'above' && direction !== 'below') return { ok: false, error: "direction 'above' veya 'below' olmalı" };
      const alarm = alertsApi.set({ symbol, price, direction, note: String(args.note || '').slice(0, 200) });
      if (!alarm) return { ok: false, error: 'alarm kurulamadı' };
      noteTrade('alert-set', { symbol, price, direction, id: alarm.id, note: alarm.note }, {});
      return { ok: true, alert: alarm };
    }
    return { ok: false, error: "action: list|set|remove" };
  },
  async mt5_note(args, ctx) {
    const symbol = String(args.symbol || '').trim().toUpperCase();
    const note = String(args.note || '').trim();
    if (!symbol || !note) return { ok: false, error: 'symbol ve note gerekli' };
    noteTrade('note', {
      symbol,
      note: note.slice(0, 2000),
      ticket: Number(args.ticket) || 0,
      side: String(args.side || '').toLowerCase(),
    }, ctx || {});
    return { ok: true, saved: true };
  },
  async mt5_risksize(args) {
    if (!mt5.running) return notConnected();
    const cfg = getCfg();
    const symbol = String(args.symbol || '').trim().toUpperCase();
    if (!symbol) return { ok: false, error: 'symbol gerekli' };
    const info = await symInfoRow(symbol);
    if (!info) return { ok: false, error: 'sembol bulunamadı: ' + symbol + ' (MT5 Market Watch?)' };
    const side = String(args.side || 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy';
    const entry = Number(args.entry) || tickPrice(info, side);
    let sl = Number(args.sl) || 0;
    let atr = null;
    let timeframe = '';
    if (!(sl > 0) && Number(args.atrMult) > 0) {
      timeframe = String(args.timeframe || 'H1').trim().toUpperCase();
      const rd = await bcall('rates', { symbol, timeframe, count: 100 }, 15000);
      const rates = (rd && rd.rates) || [];
      if (rates.length >= 20) {
        const series = finindicators.atrSeries(
          rates.map((r) => r.high),
          rates.map((r) => r.low),
          rates.map((r) => r.close),
          14
        );
        atr = series[series.length - 1];
        if (atr > 0) {
          const d = atr * Number(args.atrMult);
          sl = side === 'buy' ? entry - d : entry + d;
        }
      }
    }
    if (!(sl > 0)) return { ok: false, error: 'sl ya da atrMult gerekli' };
    const riskPct = Number(args.riskPct) > 0 ? Number(args.riskPct) : Number(cfg.riskPerTradePct) || 0;
    if (!(riskPct > 0)) return { ok: false, error: 'riskPct gerekli (ayarlarda işlem riski %0)' };
    const acct = await bcall('account', {}, 8000);
    const balance = Number(acct && acct.account && acct.account.balance) || 0;
    if (!(balance > 0)) return { ok: false, error: 'bakiye okunamadı' };
    const riskAmount = (balance * riskPct) / 100;
    const res = finrisk.calcRiskLot(info, entry, sl, riskAmount, cfg.maxLot);
    if (res.error) return { ok: false, error: res.error, raw: res.raw, lossPerLot: res.lossPerLot, riskAmount: Math.round(riskAmount * 100) / 100 };
    const digits = Number(info.digits) || 5;
    const dist = Math.abs(entry - sl);
    const closeErr = finrisk.stopsTooClose(info, entry, sl, 0);
    return {
      ok: true,
      symbol,
      side,
      entry: Number(entry.toFixed(digits)),
      sl: Number(sl.toFixed(digits)),
      volume: res.volume,
      riskPct,
      riskAmount: Math.round(riskAmount * 100) / 100,
      lossPerLot: res.lossPerLot,
      distance: Number(dist.toFixed(digits)),
      atr: atr != null ? Math.round(atr * 1e6) / 1e6 : null,
      timeframe: timeframe || null,
      capped: !!res.capped,
      warning: closeErr || undefined,
      maxLot: Number(cfg.maxLot) || 0.1,
    };
  },
  async mt5_trade(args, ctx) {
    const cfg = getCfg();
    if (!cfg.allowTrading) {
      return { ok: false, error: 'Otomatik işlem KAPALI — analiz/öneri modundasın. İşlem önerisini yaz, açma.' };
    }
    if (!mt5.running) return notConnected();
    const side = String(args.side || '').toLowerCase();
    if (side !== 'buy' && side !== 'sell') return { ok: false, error: "side 'buy' veya 'sell' olmalı" };
    const symbol = String(args.symbol || '').trim().toUpperCase();
    if (!symbol) return { ok: false, error: 'symbol gerekli' };
    const maxLot = Number(cfg.maxLot) || 0.1;
    const sl = Number(args.sl) || 0;
    const tp = Number(args.tp) || 0;
    const info = await symInfoRow(symbol);
    if (!info) return { ok: false, error: 'sembol bulunamadı: ' + symbol + ' (MT5 Market Watch?)' };
    const price = tickPrice(info, side);
    /* LOT: riskPct verilirse (ya da volume yokken ayar riski açıksa) SL
       mesafesinden hesaplanır; aksi halde volume broker kuralına normalize edilir */
    const explicitRisk = Number(args.riskPct) > 0 ? Number(args.riskPct) : 0;
    const wantVolume = Number(args.volume);
    let vol = 0;
    let riskInfo = null;
    if (explicitRisk > 0 || (!(wantVolume > 0) && Number(cfg.riskPerTradePct) > 0)) {
      if (!(sl > 0)) return { ok: false, error: '%risk ile lot için sl zorunlu — sl ver ya da volume kullan' };
      const riskPct = explicitRisk > 0 ? explicitRisk : Number(cfg.riskPerTradePct);
      const acct = await bcall('account', {}, 8000);
      const balance = Number(acct && acct.account && acct.account.balance) || 0;
      const riskAmount = (balance * riskPct) / 100;
      const rr = finrisk.calcRiskLot(info, price, sl, riskAmount, maxLot);
      if (rr.error) return { ok: false, error: rr.error };
      vol = rr.volume;
      riskInfo = { riskPct, riskAmount: Math.round(riskAmount * 100) / 100, lossPerLot: rr.lossPerLot };
    } else {
      const norm = finrisk.normalizeVolume(info, wantVolume, maxLot);
      if (norm.error) return { ok: false, error: norm.error };
      vol = norm.volume;
    }
    const pos = await bcall('positions', {}, 8000);
    const list = (pos && pos.positions) || [];
    const maxPos = Number(cfg.maxPositions) || 3;
    if (list.length >= maxPos) {
      return { ok: false, error: `max eşzamanlı pozisyon dolu (${list.length}/${maxPos}) — önce bir pozisyon kapat` };
    }
    /* risk katmanı: stops_level + yoğunluk/net yön + marj kalkanı */
    const riskErr = await preTradeCheck(cfg, side, symbol, info, price, vol, sl, tp, list);
    if (riskErr) return { ok: false, error: riskErr };
    const data = await bcall('market', {
      symbol,
      side,
      volume: vol,
      sl,
      tp,
      deviation: 20,
      comment: String(args.comment || 'Beast').slice(0, 26),
    }, 20000);
    noteTrade('trade', { symbol, side, volume: vol, sl, tp, risk: riskInfo, comment: String(args.comment || ''), result: data && data.result }, ctx);
    return { ok: true, opened: { symbol, side, volume: vol, sl, tp }, risk: riskInfo, result: data && data.result };
  },
  async mt5_close(args, ctx) {
    const cfg = getCfg();
    if (!mt5.running) return notConnected();
    const ticket = Number(args.ticket);
    if (!ticket) return { ok: false, error: 'ticket gerekli' };
    let vol = Number(args.volume) || 0;
    if (vol > 0) {
      const maxLot = Number(cfg.maxLot) || 0.1;
      if (vol > maxLot) return { ok: false, error: `kısmi kapatma lotu limiti aşıyor (max ${maxLot})` };
    }
    const data = await bcall('close', { ticket, volume: vol || 0 }, 20000);
    noteTrade('close', { ticket, volume: vol || 'all', result: data && data.result }, ctx);
    return { ok: true, result: data && data.result };
  },
  async mt5_modify(args, ctx) {
    if (!mt5.running) return notConnected();
    const ticket = Number(args.ticket);
    if (!ticket) return { ok: false, error: 'ticket gerekli' };
    const data = await bcall('modify', {
      ticket,
      sl: Number(args.sl) || 0,
      tp: Number(args.tp) || 0,
    }, 20000);
    noteTrade('modify', { ticket, sl: Number(args.sl) || 0, tp: Number(args.tp) || 0 }, ctx);
    return { ok: true, result: data && data.result };
  },
  async mt5_pending(args, ctx) {
    const cfg = getCfg();
    if (!cfg.allowTrading) {
      return { ok: false, error: 'Otomatik işlem KAPALI — bekleyen emir de açılamaz. Öneriyi yaz.' };
    }
    if (!mt5.running) return notConnected();
    const symbol = String(args.symbol || '').trim().toUpperCase();
    if (!symbol) return { ok: false, error: 'symbol gerekli' };
    const info = await symInfoRow(symbol);
    if (!info) return { ok: false, error: 'sembol bulunamadı: ' + symbol + ' (MT5 Market Watch?)' };
    const norm = finrisk.normalizeVolume(info, args.volume, Number(cfg.maxLot) || 0.1);
    if (norm.error) return { ok: false, error: norm.error };
    const vol = norm.volume;
    const data = await bcall('pending', {
      symbol,
      type: String(args.type || '').toLowerCase(),
      volume: vol,
      price: Number(args.price) || 0,
      sl: Number(args.sl) || 0,
      tp: Number(args.tp) || 0,
      comment: String(args.comment || 'Beast').slice(0, 26),
    }, 20000);
    noteTrade('pending', { symbol, type: args.type, volume: vol }, ctx);
    return { ok: true, result: data && data.result };
  },
  async mt5_cancel(args, ctx) {
    if (!mt5.running) return notConnected();
    const ticket = Number(args.ticket);
    if (!ticket) return { ok: false, error: 'ticket gerekli' };
    const data = await bcall('cancel', { ticket }, 20000);
    noteTrade('cancel', { ticket }, ctx);
    return { ok: true, result: data && data.result };
  },
};

module.exports = { definitions, handlers, NAMES, setConfig, setNotify, setAlerts };
