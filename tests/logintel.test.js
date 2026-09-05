'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const logger = require('../src/agent/logger');
const watchers = require('../src/agent/watchers');

const pad = (n) => String(n).padStart(2, '0');
const dayFile = (d) => `beast-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`;

test('parseLine/normalizeMsg: biçim çözümü ve maskeleme', () => {
  const p = logger.parseLine('[2026-01-02T03:04:05.678Z] [ERROR] [wa] gönderim başarısız id=42');
  assert.ok(p);
  assert.equal(p.level, 'error');
  assert.equal(p.tag, 'wa');
  assert.match(p.msg, /gönderim başarısız/);
  assert.ok(logger.parseLine('bozuk satır') === null);
  const n = logger.normalizeMsg('Hata 42: https://a.b/c "tik" 0xff 11112222-3333-4444-5555-666677778888');
  assert.equal(n, 'Hata N: <url> <q> <hex> <guid>');
});

test('analyze: aynı hatanın örnekleri TEK desende toplanır, filtreler çalışır', () => {
  logger.clear();
  for (let i = 0; i < 3; i++) logger.error('wa', 'gönderim başarısız id=' + i + ' jid=' + i * 7);
  logger.warn('bus', 'webhook yavaş');
  const r = logger.analyze();
  assert.ok(r.ok);
  assert.equal(r.counts.error, 3);
  assert.equal(r.counts.warn, 1);
  const top = r.top[0];
  assert.equal(top.count, 3);
  assert.match(top.pattern, /gönderim başarısız id=N/);
  assert.ok(!/\d/.test(top.pattern.replace(/<[^>]*>/g, ''))); // sayılar maskelendi
  assert.match(top.sample, /id=0/); // örnek ham mesaj
  /* seviye filtresi */
  const onlyWarn = logger.analyze({ level: 'warn' });
  assert.ok(!onlyWarn.counts.error);
  assert.equal(onlyWarn.counts.warn, 1);
  /* regex filtre */
  const q = logger.analyze({ query: 'webhook' });
  assert.equal(q.scanned, 1);
  assert.ok(logger.analyze({ query: '[' }).ok === false); // bozuk regex reddedilir
});

test('countSince: pencere dışındaki kayıt sayılmaz, regex süzer', () => {
  logger.clear();
  logger.error('test', 'taze hata');
  /* 3 saat önceki eski kayıt — dünün dosyasına elle yazılır */
  const y = new Date(Date.now() - 86400000);
  fs.writeFileSync(
    path.join(logger.LOG_DIR, dayFile(y)),
    `[${new Date(Date.now() - 3 * 3600000).toISOString()}] [ERROR] [test] eski hata\n`
  );
  assert.equal(logger.countSince({ windowMin: 10, level: 'error' }), 1);
  assert.equal(logger.countSince({ windowMin: 300, level: 'error' }), 2);
  assert.equal(logger.countSince({ windowMin: 300, level: 'error', re: 'eski' }), 1);
  assert.equal(logger.countSince({ windowMin: 300, level: 'error', re: 'yokboyle' }), 0);
  assert.equal(logger.countSince({ windowMin: 300, level: 'warn' }), 0);
});

/* ---------- watcher: logs türü ---------- */

test('watchers normalize: logs türü varsayılanları ve kelepçeler', () => {
  const n = watchers.normalize({ name: 'hata nöbeti', kind: 'logs' });
  assert.ok(!n.error);
  assert.equal(n.watcher.kind, 'logs');
  assert.equal(n.watcher.level, 'error'); // varsayılan
  assert.equal(n.watcher.windowMin, 10);
  assert.equal(n.watcher.op, 'gt'); // logs için varsayılan
  assert.equal(n.watcher.value, 0); // 0'dan çoksa = 1+ kayıt
  assert.ok(!n.watcher.url);
  /* geçersiz seviye → varsayılana döner; pencere kelepçelenir */
  assert.equal(watchers.normalize({ name: 'x', kind: 'logs', level: 'diger' }).watcher.level, 'error');
  assert.equal(watchers.normalize({ name: 'x', kind: 'logs', windowMin: 9999 }).watcher.windowMin, 720);
  assert.equal(watchers.normalize({ name: 'x', kind: 'logs', windowMin: 0 }).watcher.windowMin, 1);
  /* değer verilirse dokunulmaz */
  const v = watchers.normalize({ name: 'x', kind: 'logs', op: 'gte', value: 3 });
  assert.equal(v.watcher.value, 3);
});

test('watchers tick: logs türü injected sayaçla kenar tetiklemeli çalışır', async () => {
  for (const w of watchers.list()) watchers.remove(w.id);
  const r = watchers.add({
    name: 'hata nöbeti',
    kind: 'logs',
    op: 'gte',
    value: 2,
    everyMin: 1,
    cooldownMin: 0,
    level: 'error',
    windowMin: 10,
  });
  assert.ok(r.ok);
  let cnt = 0;
  const deps = { logs: async () => cnt };
  const rewDue = () =>
    watchers.patch(r.watcher.id, { lastCheckAt: new Date(Date.now() - 5 * 60000).toISOString() });

  assert.equal((await watchers.tickOnce(deps)).length, 0); // 0 hata → sessiz
  cnt = 2;
  rewDue();
  const hit = await watchers.tickOnce(deps);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].value, 2);
  rewDue();
  assert.equal((await watchers.tickOnce(deps)).length, 0); // armed=false → tekrar yok
  for (const id of watchers.list().map((w) => w.id)) watchers.remove(id);
});

test('watchers tick: logs türü GERÇEK logger ile sayar', async () => {
  logger.clear();
  logger.error('x', 'hata A 1');
  logger.error('x', 'hata B 2');
  logger.info('x', 'bilgi — sayılmaz');
  for (const w of watchers.list()) watchers.remove(w.id);
  const r = watchers.add({
    name: 'gerçek sayım',
    kind: 'logs',
    op: 'gte',
    value: 2,
    everyMin: 1,
    cooldownMin: 0,
    level: 'error',
    windowMin: 10,
  });
  assert.ok(r.ok);
  const evs = await watchers.tickOnce({});
  const mine = evs.find((e) => e.name === 'gerçek sayım');
  assert.ok(mine, JSON.stringify(evs));
  assert.equal(mine.value, 2);
  for (const id of watchers.list().map((w) => w.id)) watchers.remove(id);
});
