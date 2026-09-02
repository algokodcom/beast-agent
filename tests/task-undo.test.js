'use strict';

/* BC görev listesi ID'leri + TEK TUŞ GERİ ALMA (kod tabanına dönüş) testleri */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Engine } = require('../src/agent/engine');

function tmpEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-undo-sess-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-undo-ws-'));
  const events = [];
  const eng = new Engine({}, {
    sessionsDir: dir,
    workspace: ws,
    emit: (ev) => events.push(ev),
  });
  return { eng, events, ws };
}

test('todo_write: maddeler kalıcı ID alır, aynı başlık ID korur', () => {
  const { eng } = tmpEngine();
  const sid = 's1';
  const items = eng._tagTodoIds(sid, [
    { title: 'sunucu kur', status: 'active' },
    { title: 'sayfa yaz', status: 'pending' },
  ]);
  assert.strictEqual(items[0].id, 'T1');
  assert.strictEqual(items[1].id, 'T2');
  /* liste yeniden yazıldığında aynı başlık → aynı ID; yeni madde → yeni ID */
  const again = eng._tagTodoIds(sid, [
    { title: 'sunucu kur', status: 'done' },
    { title: 'sayfa yaz', status: 'active' },
    { title: 'test et', status: 'pending' },
  ]);
  assert.strictEqual(again[0].id, 'T1');
  assert.strictEqual(again[2].id, 'T3');
});

test('undoTodo: madde sırasında yazılan dosyalar önceki tabana döner', async () => {
  const { eng, events } = tmpEngine();
  const sid = 's2';
  const f1 = path.join(eng.workspace, 'a.html');
  fs.writeFileSync(f1, 'ESKI IÇERIK');

  eng.todos.set(sid, [{ id: 'T1', title: 'sayfa yaz', status: 'active' }]);

  /* ajan var olan dosyayı YAZAR (önceki içerik günlüğe düşer) */
  eng._journalBefore(sid, 'write_file', { path: 'a.html' });
  fs.writeFileSync(f1, 'AJAN YAZDI YENI');

  /* ajan YENİ dosya yaratır (before=null) */
  eng._journalBefore(sid, 'write_file', { path: 'b.js' });
  fs.writeFileSync(path.join(eng.workspace, 'b.js'), 'yeni dosya');

  const info = eng.todoUndoInfo(sid);
  assert.strictEqual(info.undo[0].files, 2, 'iki dosya geri alınabilir olmalı');
  assert.strictEqual(info.lastTodoId, 'T1');

  const r = eng.undoTodo(sid, 'T1');
  assert.ok(r.ok, 'undo ok: ' + (r.error || ''));
  assert.strictEqual(r.reverted, 2);
  assert.strictEqual(fs.readFileSync(f1, 'utf8'), 'ESKI IÇERIK', 'eski tabana dönüldü');
  assert.ok(!fs.existsSync(path.join(eng.workspace, 'b.js')), 'yaratılan dosya silindi');
  assert.ok(!eng.todoUndoInfo(sid).lastTodoId, 'günlük boşaldı');

  /* done madde geri alınınca pending'e döner + todos eventi düşürür:
     ajan maddeyi done yapar, kullanıcı geri alır → madde yeniden ele alınmak üzere pending olur */
  eng.todos.set(sid, [{ id: 'T1', title: 'sayfa yaz', status: 'active' }]);
  eng._journalBefore(sid, 'write_file', { path: 'a.html' });
  fs.writeFileSync(f1, 'AJAN YENIDEN YAZDI');
  eng.todos.set(sid, [{ id: 'T1', title: 'sayfa yaz', status: 'done' }]);
  const r2 = eng.undoTodo(sid, 'T1');
  assert.ok(r2.ok);
  assert.strictEqual(eng.todos.get(sid)[0].status, 'pending');
  assert.ok(events.some((e) => e.type === 'todos'));
});

test('undoLastTodo: son kayıtlı madde tek tuşla geri alınır; çalışan ajan engellenir', async () => {
  const { eng } = tmpEngine();
  const sid = 's3';
  eng.todos.set(sid, [
    { id: 'T1', title: 'bir', status: 'done' },
    { id: 'T2', title: 'iki', status: 'active' },
  ]);
  const f = path.join(eng.workspace, 'x.txt');
  /* dosya YOKKEN ilk yazım: before=null → tam geri almada dosya YOK OLUR
     (görev başlamadan önceki taban = dosya yok) */
  eng._journalBefore(sid, 'write_file', { path: 'x.txt' });
  fs.writeFileSync(f, 'V1');
  eng._journalBefore(sid, 'write_file', { path: 'x.txt' });
  fs.writeFileSync(f, 'V2');

  /* çalışan ajan varsa geri alma REDDEDİLİR */
  const fakeCtrl = new (require('events').EventEmitter)();
  fakeCtrl.abort = () => {};
  eng.ctrls.set(sid, fakeCtrl);
  const blocked = eng.undoTodo(sid, 'T1');
  assert.strictEqual(blocked.ok, false);
  assert.ok(/çalışıyor/.test(blocked.error));
  eng.ctrls.delete(sid);

  const r = eng.undoLastTodo(sid);
  assert.ok(r.ok);
  assert.strictEqual(r.todoId, 'T2');
  /* T2'nün TÜM yazımları geri sarılır → görev başlamadan önceki taban (dosya yok) */
  assert.ok(!fs.existsSync(f), 'dosya görev öncesi yoktu — geri alınınca yine yok');
});
