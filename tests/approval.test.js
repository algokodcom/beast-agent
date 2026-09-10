'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../src/agent/engine');

function mkEngine(approvals) {
  const path = require('path');
  const os = require('os');
  return new Engine(
    {},
    {
      sessionsDir: path.join(os.tmpdir(), 'beast-appr-test-' + Date.now()),
      approvals,
    }
  );
}

test('onay kapısı: güvenlik açıkken yalnızca SİLME işlemleri sorar', async () => {
  let asked = null;
  const eng = mkEngine({
    request: async (q) => {
      asked = q;
      return false; // reddet
    },
  });

  // güvenli araç kapıya takılmaz
  assert.ok(!Engine.RISKY_TOOLS.has('web_search'));

  // silme deseni tespiti
  assert.equal(eng._isDeleteOp('run_command', { command: 'echo hi' }), false);
  assert.equal(eng._isDeleteOp('run_command', { command: 'npm run build' }), false);
  assert.equal(eng._isDeleteOp('run_command', { command: 'rm -rf build' }), true);
  assert.equal(eng._isDeleteOp('run_command', { command: 'Remove-Item -Recurse -Force .\\tmp' }), true);
  assert.equal(eng._isDeleteOp('run_command', { command: 'del /q dosya.txt' }), true);
  assert.equal(eng._isDeleteOp('python_run', { code: 'shutil.rmtree("x")' }), true);
  assert.equal(eng._isDeleteOp('python_run', { code: 'print("x")' }), false);
  assert.equal(eng._isDeleteOp('mcp__filesystem__delete_file', {}), true);
  assert.equal(eng._isDeleteOp('write_file', { path: 'x.txt' }), false);

  // normal komut sorulmaz, doğrudan koşar
  await eng._execTool('run_command', { command: 'echo hi' }, null, 's1');
  assert.equal(asked, null);

  // silme sorulur; reddedilirse çalışmaz
  const out = await eng._execTool('run_command', { command: 'Remove-Item -Recurse -Force .\\yok-boyle-birsey' }, null, 's1');
  const obj = JSON.parse(out);
  assert.equal(obj.ok, false);
  assert.match(obj.error, /ONAYLAMADI/);
  assert.equal(asked.tool, 'run_command');
  assert.equal(asked.sessionId, 's1');

  // kapı hiç verilmediyse silme de serbest (varsayılan: tüm yetki ajanda)
  const eng3 = mkEngine(null);
  const out3 = await eng3._execTool('run_command', { command: 'Remove-Item .\\yok-boyle-birsey' }, null, 's3');
  assert.ok(out3.length > 0);
});

test('BeastCode/Sandbox: kapalıyken hiç sormaz, açıkken yalnız silme sorar', async () => {
  const os = require('os');

  // güvenlik KAPALI (varsayılan) — BeastCode/Sandbox dahil hiçbir ask olmaz
  const off = mkEngine(null);
  const events = [];
  off.emit = (ev) => events.push(ev);
  off.cache.set('bc1', { id: 'bc1', bcCode: true, workspace: os.tmpdir() });
  await off._execTool('bash', { command: 'echo merhaba' }, null, 'bc1');
  await off._execTool('bash', { command: 'Remove-Item -Recurse -Force yok-boyle-birsey' }, null, 'bc1');
  assert.equal(events.filter((e) => e.type === 'permission.asked').length, 0);
  assert.equal(off.bcAskApprovals, false);
  assert.equal(off._perm.autoAllow, true);

  // güvenlik AÇIK — silme sorusu gelir, normal komut gelmez
  const on = mkEngine({ request: async () => true });
  on.cache.set('bc2', { id: 'bc2', bcCode: true, workspace: os.tmpdir() });
  await on._execTool('bash', { command: 'echo x' }, null, 'bc2');
  assert.equal(on._perm.list().length, 0);

  const pend = on._execTool('bash', { command: 'rm -rf yok-boyle-birsey' }, null, 'bc2');
  await new Promise((r) => setImmediate(r));
  const list = on._perm.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].permission, 'delete');
  on.replyPermission(list[0].id, 'reject');
  const out = JSON.parse(await pend);
  assert.equal(out.ok, false);

  // canlı kapatma: setApprovals(false) → silme de artık sorulmaz
  on.setApprovals(false);
  assert.equal(on._perm.autoAllow, true);
  const pend2 = on._execTool('bash', { command: 'rm -rf yok-boyle-birsey' }, null, 'bc2');
  await new Promise((r) => setImmediate(r));
  assert.equal(on._perm.list().length, 0);
  assert.ok((await pend2).length > 0);
});
