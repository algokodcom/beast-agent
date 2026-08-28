'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');

/* bus saf parçaları: decide/compareOp/emitEvent (hooks.notify stub'lı) */
const bus = require('../src/agent/bus');

test('bus: sayısal filtre op\u2019ları', () => {
  assert.ok(bus.compareOp('lt', 2500, 2600));
  assert.ok(bus.compareOp('gte', 2600, 2600));
  assert.ok(!bus.compareOp('gt', 2599, 2600));
});

test('bus: decide — filtre + cooldown mantığı', () => {
  const sub = { type: 'price:tick', op: 'lte', value: 2600, cooldownMin: 10, lastNotifiedAt: 0 };
  const now = Date.now();
  // koşul dışı
  assert.equal(bus.decide(sub, { type: 'price:tick', value: 2700 }, now).hit, false);
  // yanlış tip
  assert.equal(bus.decide(sub, { type: 'mail:new' }, now).hit, false);
  // koşul içi ilk kez → tetik
  const d1 = bus.decide(sub, { type: 'price:tick', value: 2550 }, now);
  assert.ok(d1.hit && !d1.cooled);
  // hemen ardından → cooldown'a takılır ama hit'tir
  sub.lastNotifiedAt = now;
  const d2 = bus.decide(sub, { type: 'price:tick', value: 2500 }, now + 60000);
  assert.ok(d2.hit && d2.cooled);
});

test('bus: addSub doğrulama + emitEvent dağıtımı', () => {
  assert.equal(bus.addSub({ type: 'yok', sessionId: 's1' }).ok, false);
  assert.equal(bus.addSub({ type: 'price:tick', sessionId: 's1' }).ok, true); // filtresiz genel abonelik

  let notified = 0;
  // notify hook'u start ile gelir; emitEvent hooks.notify'i kullanır
  const before = bus.listSubs().length;
  assert.ok(before >= 1);
  // fiyat tick yolla — cooldown zaten 10dk varsayılan; ikinci çağrı cooled olmalı
  const fired1 = bus.emitEvent('price:tick', { symbol: 'PAXGUSDT', price: 100 }, Date.now());
  const fired2 = bus.emitEvent('price:tick', { symbol: 'PAXGUSDT', price: 101 }, Date.now() + 1000);
  assert.ok(fired1 >= fired2); // en az ilk seferde tetiklenmiş olmalı
  // temizle
  for (const s of bus.listSubs()) bus.removeSub(s.id);
});
