'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const ind = require('../src/agent/finindicators');
const watch = require('../src/agent/finwatch');
const stats = require('../src/agent/finstats');
const risk = require('../src/agent/finrisk');

/* ---------------- finindicators ---------------- */

test('göstergeler: SMA/EMA/RSI/ATR bilinen değerler', () => {
  const sma = ind.smaSeries([1, 2, 3, 4, 5], 3);
  assert.deepStrictEqual(sma.slice(2), [2, 3, 4]);
  const ema = ind.emaSeries([1, 2, 3, 4, 5], 3);
  assert.strictEqual(ema[2], 2);
  assert.strictEqual(ema[3], 3);
  assert.strictEqual(ema[4], 4);
  /* sürekli artan seri: RSI 100 */
  const up = ind.rsiSeries([1, 2, 3, 4, 5, 6, 7], 3);
  assert.strictEqual(up[up.length - 1], 100);
  /* sabit TR=2 → ATR=2 */
  const atr = ind.atrSeries([2, 2, 2], [0, 0, 0], [1, 1, 1], 3);
  assert.strictEqual(atr[2], 2);
});

test('göstergeler: parseSpec ve compute', () => {
  assert.deepStrictEqual(ind.parseSpec('EMA(50)'), { type: 'EMA', params: [50] });
  assert.deepStrictEqual(ind.parseSpec('macd(12,26,9)'), { type: 'MACD', params: [12, 26, 9] });
  assert.strictEqual(ind.parseSpec('bogus(5)'), null);
  const rates = [];
  for (let i = 0; i < 60; i++) {
    rates.push({ time: i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i });
  }
  const out = ind.compute(rates, ['EMA(5)', 'RSI(14)', 'ATR(14)']);
  assert.strictEqual(out.bars, 60);
  assert.strictEqual(out.close, 159);
  assert.ok(out.indicators['EMA(5)'].last.length >= 1);
  assert.ok(out.indicators['RSI(14)'].last[0] > 90);
  assert.ok(out.range20.high >= out.range20.low);
});

/* ---------------- finwatch ---------------- */

const META = {
  digits: 2,
  point: 0.01,
  trade_stops_level: 0,
  volume_min: 0.01,
  volume_max: 100,
  volume_step: 0.01,
};

function pos(over) {
  return Object.assign(
    {
      ticket: 1,
      symbol: 'EURUSD',
      type: 0,
      volume: 1,
      price_open: 100,
      price_current: 102,
      sl: 99,
      tp: 0,
    },
    over
  );
}

test('watchdog: +1R sonrası SL başabaşa/karara taşınır', () => {
  const out = watch.plan(pos(), META, { r: 0 }, { beOnR: 1, beOffsetR: 0.05, trailStartR: 1.5, trailR: 0.5, partialR: 0, partialPct: 50 });
  const mod = out.actions.find((a) => a.kind === 'modify');
  assert.ok(mod, 'modify bekleniyor');
  assert.ok(mod.sl >= 100, 'SL girişe veya üstüne çekilmeli');
  assert.strictEqual(out.r, 1);
});

test('watchdog: SL asla geriye taşınmaz', () => {
  const out = watch.plan(pos({ sl: 101 }), META, { r: 0 }, { beOnR: 1, beOffsetR: 0.05, trailStartR: 0, trailR: 0, partialR: 0, partialPct: 50 });
  assert.ok(!out.actions.some((a) => a.kind === 'modify'), 'daha kötü SL yazılmamalı');
});

test('watchdog: broker stop mesafesi kırpması geçersiz taşımayı engeller', () => {
  const meta = Object.assign({}, META, { trade_stops_level: 100 }); /* 100 point = 1.00 */
  const out = watch.plan(
    pos({ price_current: 100.6, sl: 99.7 }),
    meta,
    { r: 0 },
    { beOnR: 0.5, beOffsetR: 0.05, trailStartR: 0, trailR: 0, partialR: 0, partialPct: 50 }
  );
  assert.ok(!out.actions.some((a) => a.kind === 'modify'), 'stops_level ihlali engellenmeli');
});

test('watchdog: trailing kârı kilitler ve kısmi TP lotu adımla yuvarlar', () => {
  const out = watch.plan(
    pos({ volume: 0.3 }),
    META,
    { r: 0 },
    { beOnR: 0, beOffsetR: 0, trailStartR: 1, trailR: 0.5, partialR: 1.5, partialPct: 50 }
  );
  const mod = out.actions.find((a) => a.kind === 'modify');
  assert.ok(mod && mod.sl > 100, 'trailing SL girişin üstünde olmalı');
  const part = out.actions.find((a) => a.kind === 'partial');
  assert.ok(part, 'kısmi TP bekleniyor');
  assert.strictEqual(part.volume, 0.15);
});

test('watchdog: SL yaklaşma ve SL’siz pozisyon uyarıları bir kez üretilir', () => {
  const near = watch.plan(pos({ sl: 100.49, price_current: 100.5 }), META, { r: 0, warnSL: false }, { beOnR: 0, trailStartR: 0, partialR: 0, partialPct: 50 });
  assert.ok(near.actions.some((a) => a.kind === 'warnSL'));
  const again = watch.plan(pos({ sl: 100.49, price_current: 100.5 }), META, { r: 0.49, warnSL: true }, { beOnR: 0, trailStartR: 0, partialR: 0, partialPct: 50 });
  assert.ok(!again.actions.some((a) => a.kind === 'warnSL'), 'bayrak varken tekrar üretilmemeli');
  const noSl = watch.plan(pos({ sl: 0 }), META, { r: 0, warnNoSL: false }, { beOnR: 1, trailStartR: 0, partialR: 0, partialPct: 50 });
  assert.ok(noSl.actions.some((a) => a.kind === 'warnNoSL'));
});

/* ---------------- finrisk ---------------- */

const RINFO = {
  digits: 2,
  point: 0.01,
  trade_tick_size: 0.01,
  trade_tick_value: 1,
  trade_contract_size: 100000,
  volume_min: 0.01,
  volume_max: 50,
  volume_step: 0.01,
  trade_stops_level: 0,
};

test('risk: lot broker adımına yuvarlanır, kullanıcı limiti aşılmaz', () => {
  const a = risk.normalizeVolume(RINFO, 0.156, 1);
  assert.strictEqual(a.volume, 0.15);
  const b = risk.normalizeVolume(RINFO, 0.5, 0.1);
  assert.strictEqual(b.volume, 0.1);
  assert.strictEqual(b.capped, true);
  const c = risk.normalizeVolume(RINFO, 0.001, 1);
  assert.ok(c.error, 'minimum altı lot reddedilmeli');
});

test('risk: %risk lotu SL mesafesi × tick değerinden hesaplanır', () => {
  /* 1 lot için 1.00 fiyat hareketi = 100 USD; 50 USD risk → 0.5 lot */
  const r = risk.calcRiskLot(RINFO, 100, 99, 50, 1);
  assert.strictEqual(r.volume, 0.5);
  assert.strictEqual(r.lossPerLot, 100);
  assert.strictEqual(r.riskAmount, 50);
  const capped = risk.calcRiskLot(RINFO, 100, 99, 50, 0.1);
  assert.strictEqual(capped.volume, 0.1);
  assert.strictEqual(capped.capped, true);
  /* tick bilgisi yoksa kontrat büyüklüğüne düşer */
  const fallback = risk.calcRiskLot({ volume_min: 0.01, volume_max: 100, volume_step: 0.01, trade_contract_size: 100000 }, 100, 99, 1000, 10);
  assert.strictEqual(fallback.volume, 0.01);
});

test('risk: stops_level ihlali yakalanır', () => {
  const info = Object.assign({}, RINFO, { trade_stops_level: 100 }); /* 1.00 mesafe */
  assert.ok(risk.stopsTooClose(info, 100, 99.5, 0), 'yakın SL hata vermeli');
  assert.ok(risk.stopsTooClose(info, 100, 0, 100.5), 'yakın TP hata vermeli');
  assert.strictEqual(risk.stopsTooClose(info, 100, 98.9, 101.2), null);
  assert.strictEqual(risk.stopsTooClose(RINFO, 100, 99.999, 0), null, 'stops_level 0 ise serbest');
});

test('risk: marj kalkanı serbest marj ve seviye kontrolü yapar', () => {
  const acc = { equity: 1000, margin: 500, margin_free: 500, margin_level: 200 };
  assert.ok(risk.marginCheck(acc, 200, 150), 'işlem sonrası seviye 142 < 150 olmalı → hata');
  assert.strictEqual(risk.marginCheck(acc, 0, 150), null);
  assert.ok(risk.marginCheck(acc, 600, 0), 'serbest marjı aşan gerekli marj reddedilmeli');
  assert.ok(risk.marginCheck({ equity: 1000, margin: 900, margin_free: 100, margin_level: 120 }, 0, 150), 'mevcut seviye düşükse reddet');
});

test('risk: yoğunluk kontrolü aynı yön ve sembol limitlerini uygular', () => {
  const list = [
    { symbol: 'EURUSD', type: 0 },
    { symbol: 'EURUSD', type: 0 },
    { symbol: 'XAUUSD', type: 1 },
  ];
  assert.ok(risk.exposureCheck(list, 'buy', 'GBPUSD', 5, 2), 'aynı yönde 2 buy varken max 2 → hata');
  assert.ok(risk.exposureCheck(list, 'buy', 'EURUSD', 1, 5), 'sembol başına limit → hata');
  assert.strictEqual(risk.exposureCheck(list, 'buy', 'GBPUSD', 1, 5), null);
  assert.strictEqual(risk.exposureCheck(list, 'sell', 'XAUUSD', 2, 3), null);
});

/* ---------------- finrisk: kodla disiplin ---------------- */

test('disiplin: günlük işlem limiti dolar ve yeni gün sıfırlanır', () => {
  const now = new Date('2026-09-11T14:00:00').getTime();
  const day = (h) => new Date('2026-09-11T' + h + ':00:00').getTime();
  const entries = [
    { kind: 'open', at: day('09'), symbol: 'GOLD' },
    { kind: 'open', at: day('10'), symbol: 'GOLD' },
    { kind: 'open', at: day('11'), symbol: 'EURUSD' },
  ];
  const cfg = { maxTradesPerDay: 3 };
  assert.ok(risk.disciplineError(entries, now, cfg, 'buy', 'GOLD', []), 'limit dolunca hata');
  assert.strictEqual(risk.disciplineError(entries.slice(0, 2), now, cfg, 'buy', 'GOLD', []), null);
  assert.strictEqual(risk.disciplineError(entries, now, {}, 'buy', 'GOLD', []), null, 'limit 0 = kapalı');
});

test('disiplin: ardışık kayıp serisi molası verir, süre dolunca açılır', () => {
  const now = new Date('2026-09-11T12:00:00').getTime();
  const at = (minAgo) => now - minAgo * 60000;
  const entries = [
    { kind: 'close', at: at(10), symbol: 'GOLD', net: -20 },
    { kind: 'close', at: at(40), symbol: 'EURUSD', net: -10 },
  ];
  const cfg = { lossStreakLimit: 2, lossStreakPauseMin: 30 };
  assert.ok(risk.disciplineError(entries, now, cfg, 'buy', 'GBPUSD', []), '2 kayıp + 10 dk önce → mola');
  assert.strictEqual(risk.disciplineError(entries, now - 40 * 60000, cfg, 'buy', 'GBPUSD', []), null, 'mola süresi geçmişse serbest');
  assert.strictEqual(risk.disciplineError([{ kind: 'close', at: at(5), symbol: 'GOLD', net: 5 }].concat(entries), now, cfg, 'buy', 'GBPUSD', []), null, 'son işlem kârlıysa seri kırılır');
});

test('disiplin: aynı sembole re-entry beklemesi uygulanır', () => {
  const now = new Date('2026-09-11T12:00:00').getTime();
  const entries = [{ kind: 'close', at: now - 5 * 60000, symbol: 'gold', net: -3 }];
  const cfg = { reentryCooldownMin: 15 };
  const err = risk.disciplineError(entries, now, cfg, 'buy', 'GOLD', []);
  assert.ok(err && /re-entry/.test(err), '5 dk önce kapandı → bekle');
  assert.strictEqual(risk.disciplineError(entries, now, cfg, 'buy', 'EURUSD', []), null, 'başka sembol serbest');
});

test('disiplin: yönlü kur maruziyeti (korelasyon) limiti uygular', () => {
  const positions = [
    { symbol: 'EURUSD', type: 0 }, /* +EUR -USD */
    { symbol: 'GBPUSD', type: 0 }, /* +GBP -USD */
    { symbol: 'AUDUSD', type: 0 }, /* +AUD -USD */
  ];
  /* USD zaten -3; 4. USD short'u (buy XXXUSD) limiti aşar */
  const err = risk.currencyExposureError(positions, 'buy', 'NZDUSD', 3);
  assert.ok(err && /USD/.test(err), 'USD maruziyeti -4 olur → hata');
  assert.strictEqual(risk.currencyExposureError(positions, 'sell', 'NZDUSD', 3), null, 'ters yön maruziyeti dengeler');
  assert.strictEqual(risk.currencyExposureError(positions, 'buy', 'NZDUSD', 4), null, 'limit yükselince serbest');
  assert.deepStrictEqual(risk.symbolLegs('XAUUSD'), ['XAU', 'USD']);
  assert.deepStrictEqual(risk.symbolLegs('GOLD'), ['XAU', 'USD']);
  assert.deepStrictEqual(risk.symbolLegs('USDCAD'), ['USD', 'CAD']);
  assert.deepStrictEqual(risk.symbolLegs('VOLX'), []);
});

/* ---------------- finwatch: kapanış nedeni (SL/TP uyandırma) ---------------- */

test('kapanış nedeni: SL/TP/stop-out sınıflanır, manuel kapanış uyandırmaz', () => {
  assert.strictEqual(watch.closeKind(4), 'stop');
  assert.strictEqual(watch.closeKind(5), 'tp');
  assert.strictEqual(watch.closeKind(6), 'stopout');
  assert.strictEqual(watch.closeKind(0), '', 'manuel (client) kapanış → uyandırma yok');
  assert.strictEqual(watch.closeKind(3), '', 'EA kapanışı → uyandırma yok');
  assert.strictEqual(watch.closeKind(undefined), '');
  assert.strictEqual(watch.closeKind(null), '');
});

/* ---------------- finwatch: emir tipi çözümleme (6 tip) ---------------- */

test('emir tipi: 6 tip doğru çözülür (side/kind/type)', () => {
  assert.deepStrictEqual(watch.parseOrderType('buy'), { ok: true, side: 'buy', kind: 'market', type: 'buy_market' });
  assert.deepStrictEqual(watch.parseOrderType('sell'), { ok: true, side: 'sell', kind: 'market', type: 'sell_market' });
  assert.strictEqual(watch.parseOrderType('buy_market').type, 'buy_market');
  assert.strictEqual(watch.parseOrderType('sell_market').kind, 'market');
  assert.strictEqual(watch.parseOrderType('buy_limit').type, 'buy_limit');
  assert.strictEqual(watch.parseOrderType('sell_limit').kind, 'pending');
  assert.strictEqual(watch.parseOrderType('buy_stop').type, 'buy_stop');
  assert.strictEqual(watch.parseOrderType('sell_stop').type, 'sell_stop');
});

test('emir tipi: esnek yazım ve yön fallback', () => {
  assert.strictEqual(watch.parseOrderType('SELL LIMIT').type, 'sell_limit');
  assert.strictEqual(watch.parseOrderType('limit_buy').type, 'buy_limit');
  assert.strictEqual(watch.parseOrderType('market').ok, false, 'yönsüz tip reddedilir');
  assert.strictEqual(watch.parseOrderType('market', 'sell').type, 'sell_market');
  assert.strictEqual(watch.parseOrderType('limit', 'buy').type, 'buy_limit');
  assert.strictEqual(watch.parseOrderType('', '').ok, false);
  assert.strictEqual(watch.parseOrderType(undefined).ok, false);
});

/* ---------------- financetools: 6 emir tipi yönlendirmesi ---------------- */

test('emir tipleri: mt5_trade limit/stop tipini pending köprüsüne, mt5_pending market tipini anlık emre yönlendirir', async () => {
  const ftools = require('../src/agent/financetools');
  const bridge = require('../src/mt5bridge');
  const calls = [];
  const symbolsRow = {
    symbol: 'XAUUSD', digits: 2, point: 0.01, volume_min: 0.01, volume_max: 100, volume_step: 0.01,
    trade_stops_level: 0, bid: 2000, ask: 2000.5,
  };
  Object.defineProperty(bridge, 'running', { value: true, configurable: true, writable: true });
  bridge.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'symbols') return { ok: true, data: { symbols: [symbolsRow] } };
    if (method === 'pending') return { ok: true, data: { result: { retcode: 10009, order: 555 } } };
    if (method === 'market') return { ok: true, data: { result: { retcode: 10009, order: 777 }, price: 2000.5 } };
    if (method === 'positions') return { ok: true, data: { positions: [] } };
    if (method === 'account') return { ok: true, data: { account: { balance: 1000, equity: 1000, margin: 0, margin_free: 1000, margin_level: 0 } } };
    if (method === 'margin') return { ok: true, data: { margin: 10 } };
    return { ok: true, data: {} };
  };
  try {
    ftools.setConfig(() => ({ allowTrading: true, maxLot: 1, maxPositions: 5, shadowMode: false }));
    const r1 = await ftools.handlers.mt5_trade({ symbol: 'XAUUSD', type: 'sell_limit', volume: 0.1, price: 2010 });
    assert.strictEqual(r1.ok, true);
    assert.ok(calls.some((c) => c.method === 'pending' && c.params.type === 'sell_limit'), 'limit tipi bekleyen emre gider');
    calls.length = 0;
    const r2 = await ftools.handlers.mt5_pending({ symbol: 'XAUUSD', type: 'buy_market', volume: 0.1 });
    assert.strictEqual(r2.ok, true);
    assert.ok(calls.some((c) => c.method === 'market' && c.params.side === 'buy'), 'market tipi anlık emre gider');
    calls.length = 0;
    const r3 = await ftools.handlers.mt5_trade({ symbol: 'XAUUSD', side: 'sell', volume: 0.1 });
    assert.strictEqual(r3.ok, true);
    assert.ok(calls.some((c) => c.method === 'market' && c.params.side === 'sell'), 'side tek başına piyasa emridir');
  } finally {
    delete bridge.running;
    delete bridge.call;
  }
});

/* ---------------- financetools: alarm modu (kararı kuran ajan verir) ---------------- */

test('mt5_alerts: mode zorunlu — once/repeat seçimini ajan yapar', async () => {
  const ftools = require('../src/agent/financetools');
  const saved = [];
  ftools.setAlerts({
    list: () => [],
    set: (a) => { saved.push(a); return { id: 'test1', ...a }; },
    remove: () => false,
  });
  try {
    const r1 = await ftools.handlers.mt5_alerts({ action: 'set', symbol: 'XAUUSD', price: 3400, direction: 'above' });
    assert.strictEqual(r1.ok, false, 'mod seçilmeden alarm kurulamaz');
    assert.match(String(r1.error), /mode gerekli/);
    const r2 = await ftools.handlers.mt5_alerts({ action: 'set', symbol: 'XAUUSD', price: 3400, direction: 'above', mode: 'once' });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(saved[0].once, true, 'once → tek seferlik');
    const r3 = await ftools.handlers.mt5_alerts({ action: 'set', symbol: 'XAUUSD', price: 3400, direction: 'above', mode: 'repeat', cooldownMin: 15 });
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(saved[1].once, false, 'repeat → tekrarlı');
    assert.strictEqual(saved[1].cooldownMin, 15, 'soğuma ajan kararı');
    const r4 = await ftools.handlers.mt5_alerts({ action: 'set', symbol: 'XAUUSD', price: 3400, direction: 'above', once: true });
    assert.strictEqual(r4.ok, true, 'once kısa yolu (geriye uyum)');
    assert.strictEqual(saved[2].once, true);
  } finally {
    ftools.setAlerts({ list: () => [], set: () => null, remove: () => false });
  }
});

/* ---------------- finwatch: fiyat alarmı soğuması ---------------- */

test('alarm soğuması: tekrarlı alarm cooldown dolmadan tekrar tetiklenmez', () => {
  const a = { cooldownMin: 5, lastFiredAt: 0, once: false };
  assert.strictEqual(watch.alertCooldownActive(a, 1000000), false, 'ilk tetikleme serbest');
  a.lastFiredAt = 1000000;
  assert.strictEqual(watch.alertCooldownActive(a, 1000000 + 4 * 60000), true, 'soğuma sürüyor');
  assert.strictEqual(watch.alertCooldownActive(a, 1000000 + 5 * 60000), false, 'soğuma doldu');
  assert.strictEqual(watch.alertCooldownActive({ ...a, once: true }, 1000000 + 1), false, 'tek seferlikte soğuma yok');
  assert.strictEqual(watch.alertCooldownActive({ ...a, cooldownMin: 0 }, 1000000 + 1), false, '0 = sınırsız tekrar');
  assert.strictEqual(watch.alertCooldownActive(null, 1), false);
});

/* ---------------- finwatch: bekleyen emir aktivasyonu ---------------- */

function ord(over) {
  return Object.assign(
    { ticket: 500, symbol: 'XAUUSD', type: 2, volume_current: 0.1, price_open: 2000, sl: 1990, tp: 2020, magic: 20260908 },
    over
  );
}

test('bekleyen emir: listeden düşen emir yeni pozisyonla eşleşirse aktifleşir', () => {
  const p = { ticket: 900, symbol: 'XAUUSD', type: 0, volume: 0.1, price_open: 2000.5, sl: 1990, tp: 2020, magic: 20260908 };
  const d = watch.matchPendingDelta([ord()], [p]);
  assert.strictEqual(d.activated.length, 1);
  assert.strictEqual(d.canceled.length, 0);
  assert.strictEqual(d.activated[0].position.ticket, 900);
  assert.strictEqual(d.activated[0].order.ticket, 500);
});

test('bekleyen emir: yön uyuşmazsa eşleşmez (iptal sayılır)', () => {
  const sell = { ticket: 901, symbol: 'XAUUSD', type: 1, volume: 0.1, price_open: 2000, magic: 20260908 };
  const d = watch.matchPendingDelta([ord()], [sell]);
  assert.strictEqual(d.activated.length, 0);
  assert.strictEqual(d.canceled.length, 1);
});

test('bekleyen emir: yeni pozisyon yoksa iptal/süre doldu', () => {
  const d = watch.matchPendingDelta([ord()], []);
  assert.strictEqual(d.activated.length, 0);
  assert.strictEqual(d.canceled.length, 1);
});

test('bekleyen emir: sembol/hacim eşleşir, en yakın fiyat ve aynı magic tercih edilir', () => {
  const other = { ticket: 902, symbol: 'XAUUSD', type: 0, volume: 0.5, price_open: 1950, magic: 111 };
  const sameMagic = { ticket: 903, symbol: 'XAUUSD', type: 0, volume: 0.1, price_open: 2001.2, magic: 20260908 };
  const d = watch.matchPendingDelta([ord()], [other, sameMagic]);
  assert.strictEqual(d.activated.length, 1);
  assert.strictEqual(d.activated[0].position.ticket, 903, 'magic + fiyat yakınlığı ile doğru pozisyon');
});

test('bekleyen emir: satış limiti satış pozisyonuyla eşleşir, tip etiketleri doğru', () => {
  const o = ord({ type: 1, price_open: 2005 });
  const p = { ticket: 904, symbol: 'XAUUSD', type: 1, volume: 0.1, price_open: 2005, magic: 20260908 };
  assert.strictEqual(watch.orderSide(o), 'sell');
  assert.strictEqual(watch.orderTypeLabel(o), 'SELL LIMIT');
  assert.strictEqual(watch.orderTypeLabel(ord({ type: 2 })), 'BUY STOP');
  assert.strictEqual(watch.orderVolume(o), 0.1);
  const d = watch.matchPendingDelta([o], [p]);
  assert.strictEqual(d.activated.length, 1);
});

/* ---------------- finstats ---------------- */

test('istatistik: deals pozisyon bazında gruplanır, K/Z ve win rate doğru', () => {
  const deals = [
    { position_id: 1, entry: 0, profit: 0, swap: 0, commission: -1, symbol: 'EURUSD', time: 1700000000, volume: 0.1 },
    { position_id: 1, entry: 1, profit: 10, swap: -0.5, commission: -0.5, symbol: 'EURUSD', time: 1700003600, volume: 0.1 },
    { position_id: 2, entry: 0, profit: 0, swap: 0, commission: -1, symbol: 'XAUUSD', time: 1700007200, volume: 0.1 },
    { position_id: 2, entry: 1, profit: -5, swap: 0, commission: 0, symbol: 'XAUUSD', time: 1700010800, volume: 0.1 },
  ];
  const s = stats.summarizeDeals(deals);
  assert.strictEqual(s.trades, 2);
  assert.strictEqual(s.wins, 1);
  assert.strictEqual(s.losses, 1);
  assert.strictEqual(s.netProfit, 2);
  assert.strictEqual(s.grossProfit, 8);
  assert.strictEqual(s.grossLoss, 6);
  assert.strictEqual(s.winRate, 50);
  assert.strictEqual(s.bySymbol.EURUSD.net, 8);
  assert.strictEqual(s.bySymbol.XAUUSD.net, -6);
  assert.ok(Object.keys(s.byDay).length >= 1);
});

test('istatistik: maxDrawdown zirveden çukura yüzdeyi bulur', () => {
  const dd = stats.maxDrawdown([
    { at: 1, equity: 100 },
    { at: 2, equity: 120 },
    { at: 3, equity: 90 },
    { at: 4, equity: 110 },
  ]);
  assert.strictEqual(dd.maxAbs, 30);
  assert.strictEqual(dd.maxPct, 25);
});

test('rapor: haftalık metin istatistik ve günlüğü içerir', () => {
  const md = stats.buildWeeklyReport({
    stats: { trades: 2, wins: 1, losses: 1, winRate: 50, netProfit: 2, profitFactor: 1.33, byDay: { '2023-11-14': 2 }, bySymbol: { EURUSD: { net: 8, trades: 1, wins: 1, losses: 0 } } },
    drawdown: { maxAbs: 30, maxPct: 25 },
    journal: [{ at: Date.now(), kind: 'trade', symbol: 'EURUSD', side: 'buy', volume: 0.1, reason: 'trend kırılımı' }],
    account: { balance: 1000, equity: 1002, currency: 'USD', leverage: 100 },
    review: 'Disiplin iyiydi.',
  });
  assert.ok(md.includes('# Beast Finance'));
  assert.ok(md.includes('Win rate'));
  assert.ok(md.includes('trend kırılımı'));
  assert.ok(md.includes('Disiplin iyiydi.'));
});

/* ---------------- financetools: mt5_ea (BeastFinance EA köprüsü) ---------------- */

test('financetools: mt5_ea tanımı ve handler kayıtlı (EA entegrasyon kanalı)', () => {
  const ftools = require('../src/agent/financetools');
  assert.ok(ftools.NAMES.includes('mt5_ea'), 'mt5_ea NAMES listesinde olmalı');
  const def = ftools.definitions.find((d) => d.function.name === 'mt5_ea');
  assert.ok(def, 'mt5_ea tanımı üretilmeli');
  assert.match(def.function.description, /BEASTFINANCE EA/i);
  assert.equal(def.function.parameters.properties.action.type, 'string');
  assert.equal(typeof ftools.handlers.mt5_ea, 'function');
});
