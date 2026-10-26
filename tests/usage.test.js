'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const usageMod = require('../src/agent/usage');

test('usage: kayıt + bugün/ay raporu + maliyet hesabı', () => {
  usageMod.reset();

  /* maliyetsiz çağrı */
  usageMod.record({ providerId: 'p1', model: 'm1', promptTokens: 1000, completionTokens: 500 });
  /* fiyatlı çağrı: $2/M giriş, $8/M çıkış → (2000*2 + 1000*8)/1e6 = $0.012 */
  usageMod.record({
    providerId: 'p1',
    model: 'm2',
    promptTokens: 2000,
    completionTokens: 1000,
    costIn: 2,
    costOut: 8,
  });
  /* sıfır/eksik token — sayılmaz */
  usageMod.record({});
  usageMod.record({ providerId: 'pX', model: 'mY' });

  const rep = usageMod.report();
  assert.equal(rep.today.total.calls, 2);
  assert.equal(rep.today.total.pin, 3000);
  assert.equal(rep.today.total.pout, 1500);
  assert.ok(Math.abs(rep.today.total.cost - 0.012) < 1e-9);

  const byModel = Object.fromEntries(rep.today.models.map((m) => [m.model, m]));
  assert.equal(byModel['p1::m1'].calls, 1);
  assert.equal(byModel['p1::m1'].cost, 0);
  assert.equal(byModel['p1::m2'].calls, 1);

  /* ay raporu aynı günü kapsar */
  assert.equal(rep.month.total.calls, 2);

  /* reset gerçekten temizler */
  usageMod.reset();
  const rep2 = usageMod.report();
  assert.equal(rep2.today.total.calls, 0);
});

test('usage: cache read/write tokenları kalıcı sayaca eklenir', () => {
  usageMod.reset();
  usageMod.record({
    providerId: 'or',
    model: 'anthropic/claude',
    promptTokens: 1000,
    completionTokens: 100,
    cacheReadTokens: 800,
    cacheWriteTokens: 50,
  });
  const rep = usageMod.report();
  assert.equal(rep.today.total.calls, 1);
  assert.equal(rep.today.total.cread, 800);
  assert.equal(rep.today.total.cwrite, 50);
  const row = rep.today.models.find((m) => m.model === 'or::anthropic/claude');
  assert.equal(row.cread, 800);
  assert.equal(row.cwrite, 50);
  usageMod.reset();
});

test('usage: eski kayıtta cread/cwrite yoksa migration NaN üretmez', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { beastRoot } = require('../src/agent/memory');
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const file = path.join(beastRoot(), 'usage.json');
  fs.mkdirSync(beastRoot(), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      days: [
        {
          date,
          models: { 'p::m': { calls: 1, pin: 10, pout: 2, cost: 0 } },
        },
      ],
    })
  );

  /* modül önbelleğini atlayıp diskteki eski satırı taze yükle */
  const resolved = require.resolve('../src/agent/usage');
  delete require.cache[resolved];
  const fresh = require('../src/agent/usage');
  fresh.record({
    providerId: 'p',
    model: 'm',
    promptTokens: 5,
    cacheReadTokens: 3,
    cacheWriteTokens: 2,
  });
  const rep = fresh.report();
  assert.equal(rep.today.total.calls, 2);
  assert.equal(rep.today.total.pin, 15);
  assert.equal(rep.today.total.cread, 3);
  assert.equal(rep.today.total.cwrite, 2);
  assert.ok(Number.isFinite(rep.today.total.cost));

  usageMod.reset();
});
