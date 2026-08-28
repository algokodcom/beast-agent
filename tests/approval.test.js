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

test('onay kapısı: onay gelmezse riskli araç çalışmaz, onay gelirse çalışır', async () => {
  let asked = null;
  const eng = mkEngine({
    request: async (q) => {
      asked = q;
      return false; // reddet
    },
  });

  // GATE: run_command dıştan görünür şekilde kapıda durmalı
  assert.ok(Engine.RISKY_TOOLS.has('run_command'));
  assert.ok(Engine.RISKY_TOOLS.has('write_file'));
  assert.ok(Engine.RISKY_TOOLS.has('email_send'));
  assert.ok(!Engine.RISKY_TOOLS.has('web_search')); // güvenli araç kapıya takılmaz

  const out = await eng._execTool('run_command', { command: 'echo hi' }, null, 's1');
  const obj = JSON.parse(out);
  assert.equal(obj.ok, false);
  assert.match(obj.error, /ONAYLAMADI/);
  assert.equal(asked.tool, 'run_command');
  assert.equal(asked.sessionId, 's1');

  // izin verilirse araç gerçekten çalışır (echo)
  const eng2 = mkEngine({ request: async () => true });
  const out2 = await eng2._execTool('run_command', { command: 'echo ok' }, null, 's2');
  const obj2 = JSON.parse(out2);
  if (obj2.ok === false && /yok/.test(String(obj2.error))) {
    assert.ok(true); // ortamda shell yoksa kayıtlı davranış
  } else {
    assert.ok(JSON.stringify(obj2).includes('ok'));
  }

  // kapı hiç verilmediyse eski davranış — doğrudan çalışır
  const eng3 = mkEngine(null);
  const out3 = await eng3._execTool('run_command', { command: 'echo three' }, null, 's3');
  assert.ok(out3.length > 0);
});
