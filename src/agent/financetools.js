'use strict';

/* Beast Finance — MT5 ajan araçları.
   Handler'lar main süreçteki mt5bridge singleton'ına bağlanır; işlem açan
   araçlar settings.finance.allowTrading / maxLot / maxPositions ile sınırlanır.
   main tarafı setConfig/setNotify ile ayar ve bildirim kancasını enjekte eder. */

const mt5 = require('../mt5bridge');

const NAMES = [
  'mt5_status',
  'mt5_account',
  'mt5_market',
  'mt5_positions',
  'mt5_orders',
  'mt5_history',
  'mt5_trade',
  'mt5_close',
  'mt5_modify',
  'mt5_pending',
  'mt5_cancel',
];

let getCfg = () => ({ allowTrading: false, maxLot: 0.1, maxPositions: 3, symbols: [] });
let notify = () => {};

function setConfig(fn) {
  if (typeof fn === 'function') getCfg = fn;
}

function setNotify(fn) {
  if (typeof fn === 'function') notify = fn;
}

function clampLot(v, maxLot) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.min(n, maxLot);
}

async function bcall(method, params, timeoutMs) {
  const r = await mt5.call(method, params, timeoutMs);
  if (!r || r.ok !== true) throw new Error((r && r.error) || 'MT5 hatası');
  return r.data;
}

function noteTrade(kind, data) {
  try { notify({ kind, data, at: Date.now() }); } catch {}
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
        'Verilen semboller için canlı fiyat: bid/ask, spread, digit, point. symbols verilmezse izleme listesi (watchlist) kullanılır. Örn: ["EURUSD","XAUUSD"].',
      parameters: {
        type: 'object',
        properties: {
          symbols: { type: 'array', items: { type: 'string' }, description: 'Sembol listesi (boşsa watchlist)' },
        },
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
    /* hızlı özet: giriş/çıkış eşleşmesi yapmadan net realized P/L */
    let profit = 0;
    let wins = 0;
    let losses = 0;
    for (const dl of deals) {
      const p = Number(dl.profit) || 0;
      if (String(dl.entry) === '1' || dl.entry === 1 || p !== 0) {
        profit += p + (Number(dl.swap) || 0) + (Number(dl.commission) || 0);
        if (p > 0) wins++;
        else if (p < 0) losses++;
      }
    }
    return {
      ok: true,
      days,
      count: deals.length,
      netProfit: Math.round(profit * 100) / 100,
      wins,
      losses,
      deals: deals.slice(-60),
    };
  },
  async mt5_trade(args) {
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
    const vol = clampLot(args.volume, maxLot);
    if (!vol) return { ok: false, error: 'volume gerekli (pozitif sayı)' };
    const pos = await bcall('positions', {}, 8000);
    const maxPos = Number(cfg.maxPositions) || 3;
    const openCount = ((pos && pos.positions) || []).length;
    if (openCount >= maxPos) {
      return { ok: false, error: `max eşzamanlı pozisyon dolu (${openCount}/${maxPos}) — önce bir pozisyon kapat` };
    }
    const data = await bcall('market', {
      symbol,
      side,
      volume: vol,
      sl: Number(args.sl) || 0,
      tp: Number(args.tp) || 0,
      deviation: 20,
      comment: String(args.comment || 'Beast').slice(0, 26),
    }, 20000);
    noteTrade('trade', { symbol, side, volume: vol, result: data && data.result });
    return { ok: true, opened: { symbol, side, volume: vol, sl: Number(args.sl) || 0, tp: Number(args.tp) || 0 }, result: data && data.result };
  },
  async mt5_close(args) {
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
    noteTrade('close', { ticket, volume: vol || 'all', result: data && data.result });
    return { ok: true, result: data && data.result };
  },
  async mt5_modify(args) {
    if (!mt5.running) return notConnected();
    const ticket = Number(args.ticket);
    if (!ticket) return { ok: false, error: 'ticket gerekli' };
    const data = await bcall('modify', {
      ticket,
      sl: Number(args.sl) || 0,
      tp: Number(args.tp) || 0,
    }, 20000);
    noteTrade('modify', { ticket, sl: Number(args.sl) || 0, tp: Number(args.tp) || 0 });
    return { ok: true, result: data && data.result };
  },
  async mt5_pending(args) {
    const cfg = getCfg();
    if (!cfg.allowTrading) {
      return { ok: false, error: 'Otomatik işlem KAPALI — bekleyen emir de açılamaz. Öneriyi yaz.' };
    }
    if (!mt5.running) return notConnected();
    const maxLot = Number(cfg.maxLot) || 0.1;
    const vol = clampLot(args.volume, maxLot);
    if (!vol) return { ok: false, error: 'volume gerekli' };
    const data = await bcall('pending', {
      symbol: String(args.symbol || '').trim().toUpperCase(),
      type: String(args.type || '').toLowerCase(),
      volume: vol,
      price: Number(args.price) || 0,
      sl: Number(args.sl) || 0,
      tp: Number(args.tp) || 0,
      comment: String(args.comment || 'Beast').slice(0, 26),
    }, 20000);
    noteTrade('pending', { symbol: args.symbol, type: args.type, volume: vol });
    return { ok: true, result: data && data.result };
  },
  async mt5_cancel(args) {
    if (!mt5.running) return notConnected();
    const ticket = Number(args.ticket);
    if (!ticket) return { ok: false, error: 'ticket gerekli' };
    const data = await bcall('cancel', { ticket }, 20000);
    noteTrade('cancel', { ticket });
    return { ok: true, result: data && data.result };
  },
};

module.exports = { definitions, handlers, NAMES, setConfig, setNotify };
