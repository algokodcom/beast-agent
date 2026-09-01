'use strict';

/* Bot adı disiplini: İLK KARAKTER HARF ZORUNLU (ekleme + güncelleme) */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* BEAST_DATA modül yüklenmeden önce ayarlanmalı (REG cache'i tek dosyada) */
process.env.BEAST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-bots-name-'));
const bots = require('../src/agent/bots');

test('bot ekleme: ad harf ile başlamalı', () => {
  for (const bad of ['1Muhasebe', '9bot', '-abc', '_x', ' 3BoT']) {
    const r = bots.add({ name: bad, prompt: '' });
    assert.strictEqual(r.ok, false, bad + ' reddedilmeli');
    assert.ok(/harf ile başlamalı/.test(r.error), r.error);
  }
  const okNum = bots.add({ name: 'Muhasebe', prompt: '' });
  assert.ok(okNum.ok, 'harf ile başlayan ad kabul: ' + (okNum.error || ''));
  const okTr = bots.add({ name: 'Çağrı', prompt: '' });
  assert.ok(okTr.ok, 'Türkçe harf (Ç) kabul: ' + (okTr.error || ''));
});

test('bot güncelleme: geçersiz ad diğer alanlara dokunmadan reddedilir', () => {
  const created = bots.add({ name: 'Depo', prompt: 'eski' });
  assert.ok(created.ok);
  const id = created.bot.id;

  const bad = bots.update(id, { name: '3Depo', prompt: 'yeni' });
  assert.strictEqual(bad.ok, false, 'geçersiz ad reddedildi');
  const after = bots.get(id);
  assert.strictEqual(after.name, 'Depo', 'eski ad korundu');
  assert.strictEqual(after.prompt, 'eski', 'prompt değişmedi');

  const good = bots.update(id, { name: 'Anbar2', prompt: 'yeni' });
  assert.ok(good.ok, 'harf ile başlayan güncelleme kabul: ' + (good.error || ''));
  assert.strictEqual(bots.get(id).prompt, 'yeni');
  assert.strictEqual(bots.get(id).name, 'Anbar2');
});
