'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Engine = require('../src/agent/engine');

/* computeruse: modül surface + koordinat/girdi kırpma (network'süz) */
test('#4 computer use: op doğrulama ve sınırlar', async () => {
  const cu = require('../src/agent/computeruse');
  const r1 = await cu.act('yokboyleop', {});
  assert.equal(r1.ok, false);
  const r2 = await cu.act('type', { text: '' });
  assert.equal(r2.ok, false);
  const r3 = await cu.act('key', { combo: '' });
  assert.equal(r3.ok, false);
  const r4 = await cu.act('scroll', { dy: 0 });
  assert.equal(r4.ok, false);
  /* bilinmeyen op dışındaki gerçek aksiyonlar PowerShell ister; çağrılmaz */
});

/* #6 bağlam sıkıştırma: notlar öze dönüşünce eski mesajlar diskten de düşer */
test('#6 compaction: _compactToNotes dosyayı metaya+notlara+son pencereye indirger', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-cx-'));
  const eng = new Engine({}, { sessionsDir: dir });
  const s = eng.createSession();
  /* createSession bir meta satırı yazdı; cache'i atla — ham dosyaya mesaj ekleyip
     YENİ engine ile yüklüyoruz (cache trick yok) */
  const file = path.join(dir, s.id + '.jsonl');
  const lines = [JSON.stringify({ t: 'meta', id: s.id, code: 'ABC234', createdAt: new Date().toISOString() })];
  for (let i = 0; i < 20; i++) {
    lines.push(JSON.stringify({ t: 'msg', role: i % 2 ? 'assistant' : 'user', content: 'mesaj-' + i }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');

  const eng2 = new Engine({}, { sessionsDir: dir }); // taze cache — dosyadan okur
  const sess = eng2._load(s.id);
  assert.equal(sess.messages.length, 20);
  sess.notes = 'eski önemli noktalar:\n- karar A\n- karar B';
  sess.code = sess.code || 'ABC234';
  eng2._compactToNotes(sess, 14);

  // dosyayı yeniden oku
  const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const metas = raw.filter((r) => r.t === 'meta');
  const notesRows = raw.filter((r) => r.t === 'notes');
  const msgRows = raw.filter((r) => r.t === 'msg');
  const compacted = raw.filter((r) => r.t === 'compacted');
  assert.equal(metas.length, 1);
  assert.ok(metas[0].code, 'kod korunmalı');
  assert.equal(notesRows.length, 1);
  assert.match(notesRows[0].text, /karar A/);
  assert.equal(notesRows[0].at, 0); // notesAt sıfırlandı
  assert.ok(msgRows.length <= 6, `korunan pencere ≤6=KEEP_RECENT*2 (gerçek ${msgRows.length})`);
  assert.ok(msgRows.every((m) => Number(m.content.split('-')[1]) >= 14), 'yalnız cut sonrası kaldı');
  assert.equal(compacted.length, 1);

  // yeniden yükleme tutarlı
  const reloaded = new Engine({}, { sessionsDir: dir });
  const again = reloaded._load(s.id);
  assert.equal(again.code, 'ABC234');
  assert.ok(again.messages.length <= 12);
  assert.match(String(again.notes || ''), /karar A/);

  fs.rmSync(dir, { recursive: true, force: true });
});
