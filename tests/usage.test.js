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
