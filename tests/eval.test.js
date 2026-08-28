'use strict';

/* #4 Eval düzeni: scenarios.json'daki senaryoları koşar.
   Yeni modül eklerken buraya senaryo düşür — regresyon kalkanı olur. */

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const SCEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios.json'), 'utf8'));
const cron = require('../src/cron');
const Engine = require('../src/agent/engine');
const memory = require('../src/agent/memory');
const kb = require('../src/agent/kb');
const bus = require('../src/agent/bus');
const usageMod = require('../src/agent/usage');

function scenario(id) {
  return SCEN.scenarios.find((s) => s.id === id);
}

test('eval: cron-invalid-rejected', () => {
  const s = scenario('cron-invalid-rejected');
  assert.equal(cron[s.call.fn](...s.call.args), null);
});

test('eval: reminder-daily-schedule', () => {
  const s = scenario('reminder-daily-schedule');
  const r = cron[s.call.fn](...s.call.args);
  assert.equal(r.schedule, s.expectEquals.schedule);
});

test('eval: kb-search-citation', () => {
  const s = scenario('kb-search-citation');
  kb.add('FxPro GOLD seansları', 'GOLD sembolünde seans 01:00-23:00 arası açıktır', { source: 'test' });
  const rows = kb.search('gold seans');
  assert.ok(rows.length >= 1);
  for (const r of rows) {
    assert.ok(r.citation && r.citation.includes('['), 'citation formatı');
    assert.ok(r.title && r.snippet !== undefined);
  }
});

test('eval: memory-hygiene-dedup', () => {
  const s = scenario('memory-hygiene-dedup');
  assert.equal(s.module, 'memory');
  memory.append('Kullanıcının adı Batuhan');
  memory.append('kullanıcının adı batuhan'); // dup (fold edilmiş)
  const r = memory.hygiene({ maxAgeDays: 0 }); // yalnız dedup, yaş silmesi yok
  assert.ok(r.ok);
  const kept = memory.entries().filter((l) => /batuhan/i.test(l));
  assert.ok(kept.length <= 1, 'duplike tekilleşmeli');
  // temizlik
  for (const l of memory.entries()) if (/batuhan/i.test(l)) memory.removeRule('__none__'); // no-op koruması
});

test('eval: system-prompt-has-local-time', () => {
  const os = require('os');
  const eng = new Engine({}, { sessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'beast-eval-')) });
  const sys = eng.buildSystem('x');
  assert.match(sys, new RegExp(scenario('system-prompt-has-local-time').regex));
});

test('eval: system-prompt-rules-injected', () => {
  const os = require('os');
  const eng = new Engine({}, { sessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'beast-eval2-')) });
  memory.addRule('Eval test kuralı ABCXYZ');
  const sys = eng.buildSystem('x');
  assert.match(sys, /KURALLAR/);
  assert.match(sys, /Eval test kuralı ABCXYZ/);
  memory.removeRule('Eval test kuralı ABCXYZ');
});

test('eval: usage-cost-math kısa doğrulama', () => {
  usageMod.reset();
  usageMod.record({ providerId: 'e', model: 'm', promptTokens: 1000000, completionTokens: 0, costIn: 1, costOut: 0 });
  assert.ok(Math.abs(usageMod.report().today.total.cost - 1) < 1e-6);
});

test('eval: bus-price-filter', () => {
  for (const s of bus.listSubs()) bus.removeSub(s.id);
  const r = bus.addSub({ type: 'price:tick', sessionId: 'evalsestest', op: 'gte', value: 100, cooldownMin: 0 });
  assert.ok(r.ok);
  const fired = bus.emitEvent('price:tick', { value: 150 }, Date.now());
  assert.equal(fired, 1); // sadece bu abonelik
  const notFired = bus.emitEvent('price:tick', { value: 50 }, Date.now());
  assert.equal(notFired, 0);
  for (const s of bus.listSubs()) bus.removeSub(s.id);
});
