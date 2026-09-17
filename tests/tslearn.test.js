'use strict';

/* tslearn: TypeSafe karar kalibrasyonu (saf matematik) testleri.
   Sistem öğrendikçe eylem eşiği + risk çarpanı + kurallar buradan çıkar. */

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const tslearn = require('../src/agent/tslearn');

function dec(o) {
  return {
    at: Date.now(),
    symbol: 'XAUUSD',
    tf: 'M15',
    action: 'buy',
    p: 0.65,
    hour: 10,
    emaAlign: 1,
    rsi: 50,
    closedAt: Date.now(),
    net: 10,
    ...o,
  };
}

test('tslearn: bandOf p değerini doğru banda yerleştirir', () => {
  assert.equal(tslearn.bandOf(0.55), '0.50-0.60');
  assert.equal(tslearn.bandOf(0.6), '0.60-0.70');
  assert.equal(tslearn.bandOf(0.79), '0.70-0.80');
  assert.equal(tslearn.bandOf(0.95), '0.80-1.00');
});

test('tslearn: az veride eşik ve risk varsayılanda kalır', () => {
  const rows = [dec({ p: 0.75, net: 10 }), dec({ p: 0.75, net: -5 })];
  const c = tslearn.calibration(rows, 'XAUUSD', 'M15');
  assert.equal(c.n, 2);
  assert.equal(c.action, tslearn.DEFAULT_TH.action, '8 karar altında eşik oynatmaz');
  assert.equal(c.riskMult, 1);
});

test('tslearn: kazanan p bandı eşiği yükseltir, istikrar riski büyütür', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(dec({ p: 0.75, net: 12, atrPct: 0.004 }));
  for (let i = 0; i < 2; i++) rows.push(dec({ p: 0.55, net: -6 }));
  const c = tslearn.calibration(rows, 'XAUUSD', 'M15');
  assert.equal(c.n, 8);
  assert.equal(c.wins, 6);
  assert.equal(c.action, 0.7, 'kazanan bandın alt sınırı eşik olur');
  assert.equal(c.riskMult, 1.2, 'kazanç oranı ≥ %60 → risk büyür');
});

test('tslearn: üst üste kayıpta risk küçülür (×0.6)', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(dec({ p: 0.7, net: 10 }));
  for (let i = 0; i < 3; i++) rows.push(dec({ p: 0.56, net: -4 }));
  const c = tslearn.calibration(rows, 'XAUUSD', 'M15');
  assert.equal(c.riskMult, 0.6);
});

test('tslearn: periyot yeterli veriye sahipse kalibrasyon tf bazlı olur', () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(dec({ p: 0.72, net: 8, tf: 'M15' }));
  for (let i = 0; i < 4; i++) rows.push(dec({ p: 0.8, net: -9, tf: 'H1' }));
  const m15 = tslearn.calibration(rows, 'XAUUSD', 'M15');
  assert.equal(m15.tfScoped, true);
  assert.equal(m15.n, 8);
  const all = tslearn.calibration(rows, 'XAUUSD', null);
  assert.equal(all.n, 12, 'tf verilmezse sembol geneli');
});

test('tslearn: kural madenciliği kazandıran/kaybettiren koşulları ayırır', () => {
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(dec({ emaAlign: 1, hour: 10, p: 0.72, net: 9 }));
  for (let i = 0; i < 4; i++) rows.push(dec({ emaAlign: 0, hour: 20, p: 0.6, net: -7 }));
  const r = tslearn.rules(rows, 'XAUUSD');
  const trendUp = r.find((x) => x.key === 'trend_uyumlu');
  const trendDown = r.find((x) => x.key === 'trend_ters');
  assert.ok(trendUp && trendUp.n === 5 && trendUp.wr === 1);
  assert.ok(trendDown && trendDown.n === 4 && trendDown.wr === 0);
  const txt = tslearn.rulesText(r);
  assert.match(txt, /trend uyumlu/);
  assert.match(txt, /kaçın/);
});

test('tslearn: calText/calState özet satırları bilgi taşır', () => {
  const rows = [];
  for (let i = 0; i < 9; i++) rows.push(dec({ p: 0.75, net: 5 }));
  const t = tslearn.calText(rows, 'XAUUSD', 'M15');
  assert.match(t, /XAUUSD: 9 kapalı karar/);
  assert.match(t, /risk ×1\.2/);
  assert.match(t, /band 0\.70-0\.80/);
  const s = tslearn.calState(rows, 'XAUUSD', 'M15');
  assert.match(s, /eylem eşiği p≥0\.70/);
  const empty = tslearn.calState([], 'EURUSD', 'M15');
  assert.match(empty, /kalibrasyon verisi yok/);
});
