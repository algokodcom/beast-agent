'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/jev/renderer/structure.js');

const T0 = 1700000000;

function mk(rows, step, start) {
  return rows.map((r, i) => ({
    time: (start == null ? T0 : start) + i * step,
    open: r[0],
    high: r[1],
    low: r[2],
    close: r[3],
  }));
}

function h1Compression() {
  const rows = [];
  for (let i = 0; i < 42; i++) {
    const up = i % 2 === 0;
    rows.push([up ? 1.1005 : 1.1015, 1.1020, 1.1000, up ? 1.1015 : 1.1005]);
  }
  return mk(rows, 3600);
}

function h1Breakout() {
  const rows = [];
  for (let i = 0; i < 39; i++) {
    const up = i % 2 === 0;
    rows.push([up ? 1.1002 : 1.1008, 1.1010, 1.1000, up ? 1.1008 : 1.1002]);
  }
  rows.push([1.1008, 1.1050, 1.1005, 1.1048]);
  return mk(rows, 3600);
}

function m5CompressionLong() {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const c = 1.1016 - i * 0.00005;
    rows.push([c + 0.00002, c + 0.00022, c - 0.00018, c]);
  }
  /* süpürme: kutu altının altına iner, üstünde kapanır */
  rows.push([1.1004, 1.1006, 1.0997, 1.1005]);
  /* CHoCH onayı */
  rows.push([1.1005, 1.1011, 1.1005, 1.1010]);
  rows.push([1.1010, 1.1010, 1.1007, 1.1008]);
  rows.push([1.1008, 1.1009, 1.1006, 1.1007]);
  rows.push([1.1007, 1.1008, 1.1005, 1.1006]);
  return mk(rows, 300, T0 + 100 * 3600);
}

function m5BreakoutLong() {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const c = 1.1030 - i * 0.0001;
    rows.push([c + 0.00002, c + 0.00020, c - 0.00012, c]);
  }
  /* kırılım mumunun low'unu süpür, üstünde kapan */
  rows.push([1.1010, 1.1013, 1.1002, 1.1011]);
  /* CHoCH onayı */
  rows.push([1.1011, 1.1019, 1.1010, 1.1018]);
  rows.push([1.1018, 1.1019, 1.1014, 1.1016]);
  rows.push([1.1016, 1.1017, 1.1013, 1.1015]);
  rows.push([1.1015, 1.1017, 1.1013, 1.1016]);
  return mk(rows, 300, T0 + 100 * 3600);
}

function m5CompressionShort() {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const c = 1.1004 + i * 0.00005;
    rows.push([c - 0.00002, c + 0.00018, c - 0.00022, c]);
  }
  /* kutunun üstünü süpür, altında kapan */
  rows.push([1.1016, 1.1023, 1.1010, 1.1012]);
  /* CHoCH onayı aşağı */
  rows.push([1.1012, 1.1013, 1.1007, 1.1008]);
  rows.push([1.1008, 1.1010, 1.1007, 1.1009]);
  rows.push([1.1009, 1.1012, 1.1008, 1.1010]);
  rows.push([1.1010, 1.1013, 1.1009, 1.1011]);
  return mk(rows, 300, T0 + 100 * 3600);
}

function h1BreakoutBear() {
  const rows = [];
  for (let i = 0; i < 39; i++) {
    const up = i % 2 === 0;
    rows.push([up ? 1.1002 : 1.1008, 1.1010, 1.1000, up ? 1.1008 : 1.1002]);
  }
  rows.push([1.1008, 1.1011, 1.0966, 1.0968]);
  return mk(rows, 3600);
}

function m5BreakoutShort() {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const c = 1.0982 + i * 0.0001;
    rows.push([c + 0.00002, c + 0.00020, c - 0.00012, c]);
  }
  /* kırılım mumunun high'ını süpür, altında kapan */
  rows.push([1.1004, 1.1015, 1.0999, 1.1002]);
  /* CHoCH onayı aşağı */
  rows.push([1.1002, 1.1003, 1.0992, 1.0994]);
  rows.push([1.0994, 1.0999, 1.0993, 1.0997]);
  rows.push([1.0997, 1.1001, 1.0996, 1.0999]);
  rows.push([1.0999, 1.1002, 1.0998, 1.1000]);
  return mk(rows, 300, T0 + 100 * 3600);
}

function m5MicroLong() {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const c = 1.1006 + (i % 3 === 0 ? 0.0003 : i % 3 === 1 ? -0.0001 : 0.0001);
    rows.push([c, c + 0.00025, c - 0.00025, c]);
  }
  /* mikro range kırılımı */
  rows.push([1.1009, 1.1014, 1.1009, 1.1013]);
  /* retest: seviyeye değip üstünde kapandı */
  rows.push([1.1012, 1.1013, 1.1010, 1.1012]);
  rows.push([1.1012, 1.1015, 1.1012, 1.1014]);
  return mk(rows, 300, T0 + 100 * 3600);
}

function m5MicroShort() {
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const c = 1.1010 + (i % 3 === 0 ? -0.0003 : i % 3 === 1 ? 0.0001 : -0.0001);
    rows.push([c, c + 0.00025, c - 0.00025, c]);
  }
  /* mikro range kırılımı aşağı */
  rows.push([1.1007, 1.1008, 1.1002, 1.1003]);
  /* retest: seviyeye değip altında kapandı */
  rows.push([1.1005, 1.1007, 1.1004, 1.1005]);
  rows.push([1.1005, 1.1006, 1.1001, 1.1002]);
  return mk(rows, 300, T0 + 100 * 3600);
}

test('cleanBars sıralar, tekrarı ve bozuk satırı atar', () => {
  const out = S.cleanBars([
    { time: 20, open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: 10, open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: 20, open: 1, high: 3, low: 0.5, close: 2 },
    { time: 30, open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: 40, open: 1, high: 2, low: 0.5, close: 1.5 },
    { time: 30, open: 1, high: 1, low: 2, close: 1.5 },
    null,
  ]);
  assert.deepEqual(out.map((b) => b.time), [10, 20, 30, 40]);
  assert.equal(out.find((b) => b.time === 20).high, 3);
});

test('closedOnly son (oluşan) mumu atar', () => {
  const bars = mk([[1, 2, 0.5, 1.5], [1, 2, 0.5, 1.5], [1, 2, 0.5, 1.5]], 60);
  assert.equal(S.closedOnly(bars).length, 2);
  assert.equal(S.closedOnly(bars)[1].time, bars[1].time);
});

test('ATR14 bilinen seride doğru hesaplanır', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push([1.1000, 1.1010, 1.0990, 1.1005]);
  const bars = mk(rows, 3600);
  const a = S.atr(bars, 14);
  assert.ok(Math.abs(a - 0.0020) < 1e-9, 'ATR ' + a);
});

test('H1 sıkışma kutusu bulunur', () => {
  const r = S.detectH1Context(h1Compression());
  assert.equal(r.ok, true);
  assert.ok(r.compression, 'sıkışma kutusu yok');
  assert.ok(r.compression.bars >= 4);
  assert.ok(r.compression.touchesHigh >= 2);
  assert.ok(r.compression.touchesLow >= 2);
  assert.equal(r.compression.high, 1.1020);
  assert.equal(r.compression.low, 1.1000);
});

test('H1 kırılım mumu bulunur', () => {
  const r = S.detectH1Context(h1Breakout());
  assert.equal(r.ok, true);
  assert.ok(r.breakout, 'kırılım mumu yok');
  assert.equal(r.breakout.direction, 'bull');
  assert.equal(r.breakout.high, 1.1050);
  assert.equal(r.breakout.low, 1.1005);
  assert.ok(Math.abs(r.breakout.mid - (1.1008 + 1.1048) / 2) < 1e-12);
});

test('sıkışma + M5 süpürme/CHoCH long setup üretir', () => {
  const r = S.analyze(h1Compression(), m5CompressionLong());
  assert.equal(r.ok, true);
  assert.ok(r.context, 'bağlam yok');
  assert.equal(r.context.kind, 'compression');
  assert.ok(r.setup, 'setup yok: ' + r.reason);
  assert.equal(r.setup.side, 'long');
  assert.ok(r.setup.grade === 'A' || r.setup.grade === 'A+');
  assert.ok(r.setup.sl < r.setup.entry);
  assert.ok(r.setup.tp > r.setup.entry);
  assert.ok(r.setup.rr >= 1.5, 'RR ' + r.setup.rr);
  assert.ok(r.setup.riskAtrM5 <= 3.5);
});

test('kırılım mumu + M5 geri çekilme long setup üretir', () => {
  const r = S.analyze(h1Breakout(), m5BreakoutLong());
  assert.equal(r.ok, true);
  assert.ok(r.context, 'bağlam yok');
  assert.equal(r.context.kind, 'breakout');
  assert.equal(r.context.direction, 'bull');
  assert.ok(r.setup, 'setup yok: ' + r.reason);
  assert.equal(r.setup.side, 'long');
  assert.ok(r.setup.rr >= 1.5, 'RR ' + r.setup.rr);
  assert.ok(r.setup.sl < r.setup.entry && r.setup.tp > r.setup.entry);
});

test('sıkışma + M5 üst süpürme short setup üretir (aynalı)', () => {
  const r = S.analyze(h1Compression(), m5CompressionShort());
  assert.equal(r.ok, true);
  assert.ok(r.context && r.context.kind === 'compression');
  assert.ok(r.setup, 'short setup yok: ' + r.reason);
  assert.equal(r.setup.side, 'short');
  assert.ok(r.setup.sl > r.setup.entry, 'SL girişin üstünde olmalı');
  assert.ok(r.setup.tp < r.setup.entry, 'TP girişin altında olmalı');
  assert.ok(r.setup.rr >= 1.5, 'RR ' + r.setup.rr);
});

test('bearish kırılım mumu + M5 short setup üretir', () => {
  const r = S.analyze(h1BreakoutBear(), m5BreakoutShort());
  assert.equal(r.ok, true);
  assert.ok(r.context && r.context.kind === 'breakout');
  assert.equal(r.context.direction, 'bear');
  assert.ok(r.setup, 'short setup yok: ' + r.reason);
  assert.equal(r.setup.side, 'short');
  assert.ok(r.setup.sl > r.setup.entry && r.setup.tp < r.setup.entry);
  assert.ok(r.setup.rr >= 1.5, 'RR ' + r.setup.rr);
});

test('M5 mikro range kırılımı + retest tetiği çalışır', () => {
  const r = S.analyze(h1Compression(), m5MicroLong());
  assert.equal(r.ok, true);
  assert.ok(r.setup, 'mikro setup yok: ' + r.reason);
  assert.equal(r.setup.triggerType, 'micro_breakout_retest');
  assert.equal(r.setup.side, 'long');
  assert.ok(r.setup.rr >= 1.5, 'RR ' + r.setup.rr);
});

test('M5 mikro range kırılımı short retest tetiği çalışır (aynalı)', () => {
  const r = S.analyze(h1Compression(), m5MicroShort());
  assert.equal(r.ok, true);
  assert.ok(r.setup, 'mikro short setup yok: ' + r.reason);
  assert.equal(r.setup.triggerType, 'micro_breakout_retest');
  assert.equal(r.setup.side, 'short');
  assert.ok(r.setup.sl > r.setup.entry && r.setup.tp < r.setup.entry);
  assert.ok(r.setup.rr >= 1.5, 'RR ' + r.setup.rr);
});

test('setupStillValid süre, SL ve TP sınırlarını uygular', () => {
  const h1 = h1Compression();
  const m5 = m5CompressionLong();
  const r = S.analyze(h1, m5);
  assert.ok(r.setup && r.context);
  const lastM5 = m5[m5.length - 1];
  const lastH1 = h1[h1.length - 1];
  assert.equal(S.setupStillValid(r.setup, r.context, lastM5, lastH1, r.setup.entryTime + 30), true);
  assert.equal(S.setupStillValid(r.setup, r.context, { close: r.setup.sl - 0.00001 }, lastH1, r.setup.entryTime + 30), false);
  assert.equal(S.setupStillValid(r.setup, r.context, { close: r.setup.tp + 0.00001 }, lastH1, r.setup.entryTime + 30), false);
  assert.equal(S.setupStillValid(r.setup, r.context, lastM5, lastH1, r.setup.expiresAt + 1), false);
});

test('H1 verisi yetersizse analiz nazikçe reddeder', () => {
  const r = S.analyze(h1Compression().slice(0, 10), m5CompressionLong());
  assert.equal(r.ok, false);
  assert.equal(r.setup, null);
  assert.match(r.reason, /yetersiz/i);
});

test('uygun yapı yoksa setup üretilmez', () => {
  /* çok geniş ve düzensiz H1: ne kutu ne kırılım mumu */
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const b = 1.10 + (i % 7) * 0.002;
    rows.push([b, b + 0.004, b - 0.004, b + 0.001]);
  }
  const r = S.analyze(mk(rows, 3600), m5CompressionLong());
  assert.equal(r.ok, true);
  assert.equal(r.context, null);
  assert.equal(r.setup, null);
});
