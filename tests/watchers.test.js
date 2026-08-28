'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const watchers = require('../src/agent/watchers');

const T0 = new Date('2026-08-26T12:00:00Z').getTime();

test('normalize: web izleyicisi minimal alanlarla kurulur', () => {
  const r = watchers.normalize({ name: 'BTC', kind: 'web', url: 'https://api.x.com/p', value: 100000 });
  assert.ok(!r.error);
  assert.equal(r.watcher.kind, 'web');
  assert.equal(r.watcher.op, 'lte'); // varsayılan
  assert.equal(r.watcher.everyMin, 15);
  assert.equal(r.watcher.enabled, true);
  assert.equal(r.watcher.armed, true);
});

test('normalize: battery için url gerekmez, web için zorunlu', () => {
  const b = watchers.normalize({ name: 'Pil', kind: 'battery', value: 20 });
  assert.ok(!b.error);
  const w = watchers.normalize({ name: 'X', kind: 'web', value: 1 });
  assert.ok(w.error);
});

test('normalize: geçersiz kind / regex / eksik eşik reddedilir', () => {
  assert.ok(watchers.normalize({ name: 'x', kind: 'uzay' }).error);
  assert.ok(watchers.normalize({ name: 'x', kind: 'web', url: 'https://a.b', re: '[' }).error);
  assert.ok(watchers.normalize({ name: 'x', kind: 'web', url: 'https://a.b', op: 'lt' }).error); // value yok
  assert.ok(watchers.normalize({ kind: 'battery', value: 1 }).error); // isim yok
  assert.ok(watchers.normalize({ name: 'x', kind: 'web', url: 'ftp://a.b' }).error);
});

test('normalize: changed opsiyonu value olmadan çalışır, aralık kelepçelenir', () => {
  const r = watchers.normalize({ name: 'sayfa', kind: 'web', url: 'https://a.b', op: 'changed', everyMin: 1, cooldownMin: 99999 });
  assert.ok(!r.error);
  assert.equal(r.watcher.everyMin, 1); // #22: 1 dakika artık geçerli
  assert.equal(r.watcher.cooldownMin, 10080);
  /* saniye aralığı: everySec esas alınır, everyMin uyumluluk için türetilir */
  const s = watchers.normalize({ name: 'sn', kind: 'web', url: 'https://a.b', op: 'changed', everySec: 30 });
  assert.ok(!s.error);
  assert.equal(s.watcher.everySec, 30);
  assert.equal(s.watcher.everyMin, 1);
  const s2 = watchers.normalize({ name: 'sn2', kind: 'web', url: 'https://a.b', op: 'changed', everySec: 3 });
  assert.equal(s2.watcher.everySec, 10); // min 10 sn
});

test('compare: sayısal zorlama ve değişmez karşılaştırma', () => {
  assert.ok(watchers.compare('lte', '19.9', 20));
  assert.ok(watchers.compare('gt', 30, 29));
  assert.ok(watchers.compare('eq', 100, '100'));
  assert.ok(watchers.compare('neq', 5, 6));
  assert.ok(!watchers.compare('lt', 'abc', 10)); // sayıya dönmez
  assert.ok(watchers.compare('changed', 'yeni', 'eski'));
  assert.ok(!watchers.compare('changed', 'aynı', 'aynı'));
});

test('applyCheck: kenar tetiklemeli — bir kez ateşlenir, normale dönünce yeniden kurulur', () => {
  const w = { op: 'lte', value: 20, armed: true, lastTriggeredAt: null };
  const a = watchers.applyCheck(w, 18, T0);
  assert.ok(a.triggered);
  assert.equal(a.patch.armed, false);
  // koşul hâlâ doğru ama armed=false → tekrar ateşlemez
  const b = watchers.applyCheck({ ...w, ...a.patch }, 19, T0 + 1);
  assert.ok(!b.triggered);
  // normale döndü → armed=true
  const c = watchers.applyCheck({ ...w, ...a.patch }, 55, T0 + 2);
  assert.ok(!c.triggered);
  assert.equal(c.patch.armed, true);
  // tekrar eşik altına indi → yine ateşler
  const d = watchers.applyCheck({ ...w, ...c.patch }, 10, T0 + 3);
  assert.ok(d.triggered);
});

test('isDue: hiç kontrol edilmemişse vakti geldi, yeni kontrol edildiyse gelmedi', () => {
  const fresh = { enabled: true, everyMin: 15, lastCheckAt: null };
  assert.ok(watchers.isDue(fresh, T0));
  const recent = { enabled: true, everyMin: 15, lastCheckAt: new Date(T0 - 5 * 60000).toISOString() };
  assert.ok(!watchers.isDue(recent, T0));
  const old = { enabled: true, everyMin: 15, lastCheckAt: new Date(T0 - 16 * 60000).toISOString() };
  assert.ok(watchers.isDue(old, T0));
  assert.ok(!watchers.isDue({ ...fresh, enabled: false }, T0));
  /* #22 saniye aralığı */
  const sn = { enabled: true, everySec: 30, lastCheckAt: new Date(T0 - 20000).toISOString() };
  assert.ok(!watchers.isDue(sn, T0));
  assert.ok(watchers.isDue({ ...sn, lastCheckAt: new Date(T0 - 31000).toISOString() }, T0));
});

test('cooldownActive: süre dolmadan aktif', () => {
  const w = { cooldownMin: 60, lastTriggeredAt: new Date(T0 - 30 * 60000).toISOString() };
  assert.ok(watchers.cooldownActive(w, T0));
  const expired = { cooldownMin: 60, lastTriggeredAt: new Date(T0 - 61 * 60000).toISOString() };
  assert.ok(!watchers.cooldownActive(expired, T0));
  assert.ok(!watchers.cooldownActive({ cooldownMin: 60, lastTriggeredAt: null }, T0));
});

/* ---------- arka plan tick ---------- */

const { extractValue } = watchers;

test('extractValue: JSON path ve regex yolu', () => {
  const w1 = { path: 'data.0.price.usd' };
  assert.equal(extractValue('{"data":[{"price":{"usd":2377.5}}]}', w1), 2377.5);
  assert.equal(extractValue('{"data":[]}', { path: 'data.0.price' }), null);

  const w2 = { re: '<span id="p">([\\d.]+)</span>' };
  assert.equal(extractValue('x<span id="p">99.9</span>y', w2), '99.9');

  assert.throws(() => extractValue('{"a":1}', { kind: 'web' }), /path/);
});

test('tickOnce: kenar tetikleme + hata disiplini + changed semantiği', async () => {
  // depoyu temizle
  for (const w of watchers.list()) watchers.remove(w.id);

  let fakeValue = 100;
  let throws = false;

  const r = watchers.add({
    name: 'fiyat alarımı',
    kind: 'web',
    url: 'https://api.example.com/x',
    path: 'price',
    op: 'lte',
    value: 90,
    everyMin: 15,
    cooldownMin: 0, // akışı gerçek zamanla bağımsız kılmak için kapalı
  });
  assert.ok(r.ok);

  const deps = {
    check: async () => {
      if (throws) throw new Error('ağ koptu');
      return fakeValue;
    },
  };
  const rewDue = () =>
    watchers.patch(r.watcher.id, { lastCheckAt: new Date(Date.now() - 16 * 60000).toISOString() });

  // 1) eşik üstü → tetik yok
  assert.equal((await watchers.tickOnce(deps)).length, 0);
  assert.equal(watchers.list()[0].lastValue, 100);

  // 2) henüz due değil (az önce kontrol edildi)
  assert.equal((await watchers.tickOnce(deps)).length, 0);

  // 3) eşiğe iner → bir kez tetik
  fakeValue = 85;
  rewDue();
  const hit = await watchers.tickOnce(deps);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].value, 85);

  // 4) armed=false — koşul doğruyken tekrar tetiklemez
  rewDue();
  assert.equal((await watchers.tickOnce(deps)).length, 0);

  // 5) normale döner (re-arm) ama hata modunda lastError yazılır
  fakeValue = 120;
  throws = true;
  rewDue();
  assert.equal((await watchers.tickOnce(deps)).length, 0);
  assert.match(watchers.list()[0].lastError, /ağ koptu/);

  // 6) hata düzelir → lastError temizlenir
  throws = false;
  rewDue();
  assert.equal((await watchers.tickOnce(deps)).length, 0);
  assert.equal(watchers.list()[0].lastError, '');

  /* --- changed: sayfa değişikliği izleme --- */
  const r2 = watchers.add({
    name: 'sayfa değişimi',
    kind: 'web',
    url: 'https://a.b/c',
    op: 'changed',
    everyMin: 2,
    cooldownMin: 0,
  });
  assert.ok(r2.ok, JSON.stringify(r2));
  let html = '';
  const deps2 = { check: async () => html };

  // kuruluştaki referans boş — ilk kontrolde içerik görünür → tetik
  html = '<h1>v1</h1>';
  let evs = await watchers.tickOnce(deps2);
  assert.equal(evs.length, 1);

  // içerik sabitken tekrar tetiklenmez
  await watchers.patch(r2.watcher.id, { lastCheckAt: new Date(Date.now() - 5 * 60000).toISOString() });
  assert.equal((await watchers.tickOnce(deps2)).length, 0);

  // içeriği eski haline getir (referans değerine dön) → re-arm
  html = '';
  await watchers.patch(r2.watcher.id, { lastCheckAt: new Date(Date.now() - 5 * 60000).toISOString() });
  await watchers.tickOnce(deps2);

  // tekrar değişir → yeniden tetik
  html = '<h1>v2</h1>';
  await watchers.patch(r2.watcher.id, { lastCheckAt: new Date(Date.now() - 5 * 60000).toISOString() });
  evs = await watchers.tickOnce(deps2);
  assert.equal(evs.length, 1);

  for (const id of watchers.list().map((w) => w.id)) watchers.remove(id);
});
