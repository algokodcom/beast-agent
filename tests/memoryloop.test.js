'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const memory = require('../src/agent/memory');

test('#v13 memory döngüsü: append dedup + cap hygiene', () => {
  // temiz başlangıç
  const f = require('path').join(memory.memDir(), 'MEMORY.md');
  require('fs').rmSync(f, { force: true });

  const r1 = memory.append('Kullanıcının projeleri: Beast Agent, GOLD trading');
  assert.ok(r1.ok);
  // aynı bilgi farklı ifadeyle — dup yakalanmalı (fold+normalize)
  const r2 = memory.append('kullanıcının PROJELERİ: beast agent, gold trading!');
  assert.ok(r2.ok);
  assert.equal(r2.duplicate, true);

  const list = memory.entries().filter((l) => /beast agent/i.test(l));
  assert.equal(list.length, 1, 'dup tekilleşmeli');

  // hygiene çalışıyor mu
  const h = memory.hygiene({ maxAgeDays: 0 });
  assert.ok(h.ok);
});
