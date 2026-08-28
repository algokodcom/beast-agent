'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Engine = require('../src/agent/engine');

function mkEng() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-code-'));
  return new Engine({}, { sessionsDir: dir });
}

test('oturum kodu: benzersiz, formatta, meta\u2019dan geri yüklenir', () => {
  const eng = mkEng();
  const a = eng.createSession();
  const b = eng.createSession();
  assert.match(a.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  assert.notEqual(a.code, b.code);

  // cache temizlenmiş gibi: yeni engine aynı dosyadan code okumalı
  const eng2 = new Engine({}, { sessionsDir: eng.sessionsDir });
  const view = eng2.listSessions().find((s) => s.id === a.id);
  assert.equal(view.code, a.code);
});

test('findByCode: kod ile oturumu bulur, hızlı indeks kullanır', async () => {
  const eng = mkEng();
  const v = eng.createSession();
  // gerçek bir mesaj yaz → dosya oluşsun
  eng.send(v.id, { text: 'merhaba' });
  await new Promise((r) => setTimeout(r, 30));
  const hit = eng.findByCode(v.code);
  assert.ok(hit);
  assert.equal(hit.id, v.id);
  assert.equal(eng.findByCode('ZZZZZZ'), null);
  assert.equal(eng.findByCode(v.code.toLowerCase()).id, v.id);
  fs.rmSync(eng.sessionsDir, { recursive: true, force: true });
});

test('ORTAM: yerel tarih/saat/dilim prompta girer', () => {
  const eng = mkEng();
  const sys = eng.buildSystem('test');
  assert.match(sys, /Yerel tarih:/);
  assert.match(sys, /Yerel saat:/);
  assert.match(sys, /UTC varsayma/);
  fs.rmSync(eng.sessionsDir, { recursive: true, force: true });
});
