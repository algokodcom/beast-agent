'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const shot = require('../src/agent/defaulttools/mt5_shot/run.js');

test('mt5_shot: tek sembol + tek periyot → plan yok (tek çekim yolu)', () => {
  assert.deepEqual(shot.buildPlan({ symbol: 'GOLD', timeframe: 'M15' }), []);
});

test('mt5_shot: çoklu sembol → her sembolden bir kare', () => {
  const p = shot.buildPlan({ symbols: ['gold', 'EURUSD', 'BTCUSD', 'EURUSD'] });
  assert.deepEqual(p.map((x) => x.symbol), ['GOLD', 'EURUSD', 'BTCUSD']);
  assert.ok(p.every((x) => x.timeframe === null));
});

test('mt5_shot: symbols string + symbol birleşir, tekrarlar tekil', () => {
  assert.deepEqual(shot.normalizeSymbols({ symbol: 'GOLD', symbols: 'GOLD, EURUSD|BTCUSD' }), ['GOLD', 'EURUSD', 'BTCUSD']);
});

test('mt5_shot: symbols × timeframes ızgarası (sembol sırası korunur)', () => {
  const p = shot.buildPlan({ symbols: ['GOLD', 'EURUSD'], timeframes: ['M15', 'M5'] });
  assert.deepEqual(p, [
    { symbol: 'GOLD', timeframe: 'M15' },
    { symbol: 'GOLD', timeframe: 'M5' },
    { symbol: 'EURUSD', timeframe: 'M15' },
    { symbol: 'EURUSD', timeframe: 'M5' },
  ]);
});

test('mt5_shot: tek sembol + timeframes → eski çoklu periyot davranışı', () => {
  const p = shot.buildPlan({ symbol: 'GOLD', timeframes: ['M1', 'M15'] });
  assert.deepEqual(p, [
    { symbol: 'GOLD', timeframe: 'M1' },
    { symbol: 'GOLD', timeframe: 'M15' },
  ]);
});

test('mt5_shot: tf2 kısayolu → aktif grafik çoklu periyot planı', () => {
  const p = shot.buildPlan({ timeframe: 'M1', tf2: 'M15' });
  assert.deepEqual(p.map((x) => x.timeframe), ['M1', 'M15']);
  assert.ok(p.every((x) => x.symbol === null));
});

test('mt5_shot: panel tavanı 6 (watchdog bütçesi)', () => {
  const p = shot.buildPlan({ symbols: ['A', 'B', 'C'], timeframes: ['M1', 'M5', 'M15'] });
  assert.equal(p.length, 6);
  assert.deepEqual(p[5], { symbol: 'B', timeframe: 'M15' });
});

test('mt5_shot: sanitizeFile uzantı ekler ve yol kaçışını engeller', () => {
  assert.equal(shot.sanitizeFile('../../x/y', 'beast_shot_x.png'), 'y.png');
  assert.equal(shot.sanitizeFile('foo', 'f.png'), 'foo.png');
});
