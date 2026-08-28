'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Engine = require('../src/agent/engine');

test('#5 nerede kaldım: son oturum + yarım todo döner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-wwi-'));
  const eng = new Engine({}, { sessionsDir: dir });

  // iki oturum: eskisi bugün çalışsın, yenisi en son kalan olsun
  const old1 = eng.createSession();
  const act = eng.createSession();

  eng.send(act.id, { text: 'rapor hazırla ve maili kontrol et' });
  await new Promise((r) => setTimeout(r, 80)); // _run başlasın bitmesin önemli değil
  eng.interrupt(act.id);
  await new Promise((r) => setTimeout(r, 60));

  // todo yaz (doğrudan araç yolu yerine state enjeksiyonu)
  eng._execTool('todo_write', { items: [
    { title: 'raporu toparla', status: 'done' },
    { title: 'mail taslağı hazırla', status: 'active' },
    { title: 'tabloyu güncelle', status: 'pending' },
  ] }, null, act.id);

  const w = eng.lastWhereWasI();
  assert.ok(w, 'özet gelmeli');
  assert.equal(w.sessionId, act.id); // en yeni oturum
  assert.ok(w.code && w.code.length === 6);
  assert.ok(w.pendingTodos.length >= 2, 'yarım todolar listelenmeli');
  assert.equal(w.doneCount, 1);
  assert.ok(w.lastUser.includes('rapor'));

  fs.rmSync(dir, { recursive: true, force: true });
});
