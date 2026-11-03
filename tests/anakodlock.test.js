'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lock = require('../src/agent/anakodlock');

/* Founder parolası — testlerde düz metin gerekir; modülde yalnız özet tutulur */
const PHRASE = 'batuhan bozoklu sana izin veriyor';

test('founder parolası kilidi açar', () => {
  lock.lock();
  assert.equal(lock.isUnlocked(), false);
  assert.equal(lock.noteUserText(PHRASE), true);
  assert.equal(lock.isUnlocked(), true);
  /* zaten açıkken tekrar true dönmez */
  assert.equal(lock.noteUserText(PHRASE), false);
  lock.lock();
});

test('büyük harf, noktalama ve Türkçe harfler normalize edilir', () => {
  lock.lock();
  assert.equal(lock.noteUserText('BATUHAN BOZOKLU SANA İZİN VERİYOR!'), true);
  lock.lock();
  assert.equal(lock.noteUserText('  Batuhan  Bozoklu, sana izin veriyor.  '), true);
  lock.lock();
});

test('yanlış parola kilidi açmaz', () => {
  lock.lock();
  assert.equal(lock.noteUserText('batuhan bozoklu'), false);
  assert.equal(lock.noteUserText('sana izin veriyor'), false);
  assert.equal(lock.noteUserText('batuhan bozoklu sana izin veriyorum'), false);
  assert.equal(lock.isUnlocked(), false);
});

test('parola cümle olarak söylenirse aynı mesajdaki istekle birlikte açılır', () => {
  lock.lock();
  assert.equal(lock.noteUserText('batuhan bozoklu sana izin veriyor, şimdi kodu düzelt'), true);
  lock.lock();
  assert.equal(lock.noteUserText('Selam.\nbatuhan bozoklu sana izin veriyor\nengine.js düzelt'), true);
  lock.lock();
});

test('parola cümlede geçebilir, eksik/yanlış sıralı kelimeler açmaz', () => {
  lock.lock();
  assert.equal(lock.noteUserText('lütfen batuhan bozoklu sana izin veriyor'), true);
  lock.lock();
  assert.equal(lock.noteUserText('batuhan bozoklu izin veriyor'), false);
  assert.equal(lock.noteUserText('bozoklu batuhan sana izin veriyor'), false);
  assert.equal(lock.isUnlocked(), false);
});

test('redact parolayı maskeler, metnin geri kalanını korur', () => {
  assert.equal(lock.redact(PHRASE), '[FOUNDER PAROLASI]');
  assert.equal(lock.redact('Şunu düzelt: ' + PHRASE + '. Teşekkürler'), 'Şunu düzelt: [FOUNDER PAROLASI]. Teşekkürler');
  assert.equal(lock.redact('alakasız metin'), 'alakasız metin');
});

test('parola kaynak dosyada düz metin olarak durmaz', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent', 'anakodlock.js'), 'utf8').toLowerCase();
  assert.equal(src.includes('bozoklu'), false);
  assert.equal(src.includes('izin veriyor'), false);
});

/* ---------- engine._guardTool: kilit açılınca korumalı bölge serbest ---------- */

const { Engine } = require('../src/agent/engine');

function makeEngine(extra = {}) {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-sess-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-ws-'));
  return new Engine({}, { sessionsDir, workspace, customProviders: [], emit: () => {}, ...extra });
}

test('kilitliyken korumalı bölgeye yazma engellenir, okuma serbest', () => {
  const protectedDir = path.join(os.tmpdir(), 'beast-app-locked');
  const e = makeEngine({ protectedDirs: [protectedDir] });
  const target = path.join(protectedDir, 'src', 'engine.js');
  lock.lock();

  const blocked = JSON.parse(e._guardTool('write_file', { path: target }));
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /ANA KOD KİLİDİ/);
  assert.equal(JSON.parse(e._guardTool('edit_file', { path: target })).ok, false);
  /* yol yazan diğer araçlar da kapalı */
  assert.equal(JSON.parse(e._guardTool('pdf_write', { path: target, content: 'x' })).ok, false);
  assert.equal(JSON.parse(e._guardTool('xlsx_write', { path: target, sheets: [] })).ok, false);
  assert.equal(e._guardTool('read_file', { path: target }), null);

  /* parola sonrası kilit açık: korumalı bölge serbest */
  lock.noteUserText(PHRASE);
  assert.equal(e._guardTool('write_file', { path: target }), null);
  assert.equal(e._guardTool('edit_file', { path: target }), null);
  lock.lock();
});

test('send(): parola mesajı kilidi açar, geçmişe maskeli ve sistem notlu yazılır', () => {
  const e = makeEngine({ protectedDirs: [path.join(os.tmpdir(), 'beast-app-locked')] });
  e._run = async () => {};
  const s = e.createSession();
  lock.lock();
  assert.equal(
    e.send(s.id, { text: 'batuhan bozoklu sana izin veriyor, engine.js düzelt' }, { userAction: true }),
    true
  );
  assert.equal(lock.isUnlocked(), true);
  const last = e._load(s.id).messages.slice(-1)[0];
  const text = typeof last.content === 'string' ? last.content : String(last.content[0].text || '');
  assert.match(text, /FOUNDER PAROLASI DOĞRULANDI/);
  assert.equal(text.includes('bozoklu'), false);
  lock.lock();
});

test('kilitliyken yıkıcı komut engellenir, salt-okur komut serbest', () => {
  const protectedDir = path.join(os.tmpdir(), 'beast-app-locked');
  const e = makeEngine({ protectedDirs: [protectedDir] });
  const target = path.join(protectedDir, 'src', 'engine.js');
  lock.lock();

  assert.equal(JSON.parse(e._guardTool('run_command', { command: `Set-Content -Path "${target}" -Value x` })).ok, false);
  assert.equal(JSON.parse(e._guardTool('panel_run', { command: `Set-Content -Path "${target}" -Value x` })).ok, false);
  assert.equal(
    JSON.parse(e._guardTool('python_run', { code: `open(r"${target}", "w").write("x")` })).ok,
    false
  );
  assert.equal(e._guardTool('run_command', { command: `Get-Content "${target}"` }), null);
  lock.lock();
});
