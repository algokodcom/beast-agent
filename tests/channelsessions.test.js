'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const cs = require('../src/agent/channelsessions');

test('channelsessions: dmSessionKey LID/cihaz ekini gerçek numaraya indirger', () => {
  assert.strictEqual(cs.dmSessionKey('905551112233@lid', '905551112233'), '905551112233@s.whatsapp.net');
  assert.strictEqual(cs.dmSessionKey('905551112233:12@s.whatsapp.net', ''), '905551112233@s.whatsapp.net');
  assert.strictEqual(cs.dmSessionKey('905551112233@s.whatsapp.net', ''), '905551112233@s.whatsapp.net');
  assert.strictEqual(cs.dmSessionKey('120363000000@g.us', '905551112233'), '120363000000@g.us');
  assert.strictEqual(cs.dmSessionKey('', '123'), '');
});

test('channelsessions: göç — ortak oturum sahipte kalır, diğerleri ayrılır', () => {
  const chats = new Map([
    ['111@s.whatsapp.net', 'S1'],
    ['222@s.whatsapp.net', 'S1'],
    ['333@g.us', 'S1'],
    ['444@s.whatsapp.net', 'S2'],
  ]);
  const history = new Map([
    ['111@s.whatsapp.net', ['S1']],
    ['222@s.whatsapp.net', ['S1']],
    ['333@g.us', ['S1']],
    ['444@s.whatsapp.net', ['S2']],
  ]);
  const dirty = cs.migrateSharedSessions({ chats, history, ownerDigits: '222' });
  assert.strictEqual(dirty, true, 'değişiklik bildirildi');
  assert.strictEqual(chats.get('111@s.whatsapp.net'), undefined, 'ortak jid ayrıldı');
  assert.strictEqual(chats.get('333@g.us'), undefined, 'grup ayrıldı');
  assert.strictEqual(chats.get('222@s.whatsapp.net'), 'S1', 'sahip ortak oturumda kaldı');
  assert.strictEqual(chats.get('444@s.whatsapp.net'), 'S2', 'tek başına bağlı oturuma dokunulmadı');
  assert.deepStrictEqual(history.get('111@s.whatsapp.net'), undefined, 'ortak oturum geçmişten düştü');
  assert.deepStrictEqual(history.get('222@s.whatsapp.net'), ['S1'], 'sahibin geçmişi korunur');
});

test('channelsessions: göç — sahip bulunamazsa ilk jid bağlamı korur, idempotent', () => {
  const chats = new Map([
    ['111@s.whatsapp.net', 'S1'],
    ['222@s.whatsapp.net', 'S1'],
  ]);
  const history = new Map([
    ['111@s.whatsapp.net', ['S1']],
    ['222@s.whatsapp.net', ['S1']],
  ]);
  cs.migrateSharedSessions({ chats, history, ownerDigits: '999' });
  assert.strictEqual(chats.get('111@s.whatsapp.net'), 'S1');
  assert.strictEqual(chats.get('222@s.whatsapp.net'), undefined);
  /* ikinci kez çalıştırmak değişiklik üretmez */
  const again = cs.migrateSharedSessions({ chats, history, ownerDigits: '999' });
  assert.strictEqual(again, false, 'idempotent');
});

test('channelsessions: göç — sahip yokken LID yerine kanonik numara jid korunur', () => {
  const chats = new Map([
    ['555@lid', 'S1'],
    ['555@s.whatsapp.net', 'S1'],
  ]);
  const history = new Map([
    ['555@lid', ['S1']],
    ['555@s.whatsapp.net', ['S1']],
  ]);
  cs.migrateSharedSessions({ chats, history, ownerDigits: '' });
  assert.strictEqual(chats.get('555@s.whatsapp.net'), 'S1', 'kanonik numara jid kaldı');
  assert.strictEqual(chats.get('555@lid'), undefined, 'LID bağlantısı ayrıldı');
});

test('channelsessions: collectSessionIds kanal oturumlarını tek Set yapar', () => {
  const set = cs.collectSessionIds(
    new Map([['a', 'S1']]),
    new Map([['b', 'S2'], ['c', 'S1']]),
    new Map([['d', 'S3']])
  );
  assert.deepStrictEqual([...set].sort(), ['S1', 'S2', 'S3']);
});
