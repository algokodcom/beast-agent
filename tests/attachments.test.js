'use strict';

/* Dosya ekleri: içerik mesaj metnine GÖMÜLMEZ — attachments alanında taşınır,
   chat ekranı yalnız dosya kartı basar; içerik yalnız LLM payload'ına girer. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Engine } = require('../src/agent/engine');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-att-'));
  const events = [];
  const eng = new Engine({}, {
    sessionsDir: dir,
    emit: (ev) => events.push(ev),
  });
  return { eng, events, dir };
}

test('send: dosya eki metne gömülmez, msg.attachments içinde taşınır', async () => {
  const { eng } = tmpEngine();
  const sess = eng.createSession();
  eng.send(sess.id, {
    text: 'bu dosyaya bak',
    attachments: [{ type: 'file', name: 'veri.txt', content: 'GIZLI-ICERIK-123' }],
  });
  await sleep(150); // _run (model yok) sessizce ölür — mesaj zaten kayıtlı

  const s = eng.openSession(sess.id);
  const m = s.messages.find((x) => x.role === 'user');
  assert.ok(m, 'kullanıcı mesajı kaydedilmeli');
  assert.ok(!String(m.content).includes('GIZLI-ICERIK-123'), 'içerik mesaj metninde OLMAMALI: ' + m.content);
  assert.ok(Array.isArray(m.attachments) && m.attachments.length === 1, 'attachments alanı olmalı');
  assert.strictEqual(m.attachments[0].name, 'veri.txt');
  assert.ok(String(m.attachments[0].content).includes('GIZLI-ICERIK-123'), 'içerik attachments içinde saklanmalı');
});

test('_buildPayload: dosya içeriği yalnız payload\'a enjekte edilir, attachments alanı sıyrılır', () => {
  const { eng } = tmpEngine();
  const messages = [
    {
      role: 'user',
      content: 'bu dosyaya bak',
      attachments: [{ type: 'file', name: 'veri.txt', content: 'GIZLI-ICERIK-123' }],
    },
    {
      role: 'user',
      content: [{ type: 'text', text: 'resimli mesaj' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }],
      attachments: [{ type: 'image', name: 'ekran.png' }],
    },
  ];
  const payload = eng._buildPayload('sys', messages, null, 100000, null);
  const withFile = payload.find((m) => m.role === 'user' && String(JSON.stringify(m)).includes('veri.txt'));
  assert.ok(withFile, 'dosya mesajı payload\'da olmalı');
  assert.ok(String(withFile.content).includes('GIZLI-ICERIK-123'), 'içerik payload metnine enjekte edilmeli');
  assert.ok(String(withFile.content).includes('[Ek dosya: veri.txt]'), 'etiket korunmalı');
  for (const m of payload) {
    assert.ok(!('attachments' in m), 'payload mesajında attachments alanı OLMAMALI');
  }
});

test('send: metinsiz yalnız dosya ekleri de gönderilir', async () => {
  const { eng } = tmpEngine();
  const sess = eng.createSession();
  const ok = eng.send(sess.id, {
    text: '',
    attachments: [{ type: 'file', name: 'rapor.md', content: '# başlık' }],
  });
  assert.ok(ok, 'gönderim true dönmeli');
  const s = eng.openSession(sess.id);
  const m = s.messages.find((x) => x.role === 'user');
  assert.ok(m && Array.isArray(m.attachments), 'ek kayıtlı olmalı');
});
