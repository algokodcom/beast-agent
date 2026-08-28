'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* chatOnce'ı stub'la: engine yüklenmeden önce llm modülünü patch'le
   (engine destructure anında referansı alır) */
const llm = require('../src/agent/llm');
let stubResponse = 'Not: kullanıcı Beast Agent geliştiriyor. Karar: not sistemi çalışmalı.';
let stubCalls = 0;
llm.chatOnce = async () => {
  stubCalls++;
  return { content: stubResponse };
};

const { Engine } = require('../src/agent/engine');

function makeEngine(extra = {}) {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-sess-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-ws-'));
  const eng = new Engine({}, { sessionsDir, workspace, customProviders: [], emit: () => {}, ...extra });
  eng.sel = { provider: 'test', providerName: 'Test', model: 'test-model', sel: 'test::test-model' };
  return eng;
}

test('oturum notları: 14+ mesajda not üretilir ve listNotes görünür', async () => {
  const eng = makeEngine();
  const s = eng.createSession();
  const full = eng._load(s.id);
  for (let i = 0; i < 20; i++) {
    full.messages.push({ role: 'user', content: 'mesaj ' + i });
    full.messages.push({ role: 'assistant', content: 'cevap ' + i });
  }
  const r = await eng._updateSessionNotes(full, undefined);
  assert.equal(r.ok, true, 'not üretimi başarılı olmalı, hata: ' + (r && r.reason));
  assert.equal(stubCalls, 1);
  assert.ok(full.notes && full.notes.length, 'notes yazıldı');

  const list = eng.listNotes();
  assert.equal(list.length, 1, 'listNotes notu dönmeli');
  assert.equal(list[0].id, s.id);
  assert.ok(list[0].notes.includes('Not:'));

  /* diskte notes satırı da olmalı */
  const raw = fs.readFileSync(eng._file(s.id), 'utf8');
  assert.ok(raw.includes('"t":"notes"'), 'notes satırı dosyada');
});

test('oturum notları: eşiği doldurmayan oturum bekleme döner, hata değil', async () => {
  const eng = makeEngine();
  const s = eng.createSession();
  const full = eng._load(s.id);
  full.messages.push({ role: 'user', content: 'selam' });
  full.messages.push({ role: 'assistant', content: 'merhaba' });
  const r = await eng._updateSessionNotes(full, undefined);
  assert.equal(r.ok, false);
  assert.ok(/^bekleme/.test(r.reason));
  assert.equal(stubCalls, 1, 'stub çağrısı artmadı');
});
