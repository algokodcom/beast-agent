'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const mcp = require('../src/agent/mcp');

test('MCP: satır sonu/NUL içeren komut/argüman reddedilir', () => {
  const ok = mcp.normalizeServer({ command: 'npx', args: ['-y', 'mcp-server-fetch'] });
  assert.equal(ok.command, 'npx');
  assert.deepEqual(ok.args, ['-y', 'mcp-server-fetch']);
  assert.equal(mcp.normalizeServer({}), null);
  assert.equal(mcp.normalizeServer(null), null);
  assert.throws(() => mcp.normalizeServer({ command: 'npx', args: ['a\nb'] }), /satır sonu/);
  assert.throws(() => mcp.normalizeServer({ command: 'npx', args: ['a\rb'] }), /satır sonu/);
  assert.throws(() => mcp.normalizeServer({ command: 'cmd\0.exe' }), /satır sonu/);
});

test("MCP: maskeli env sırları geri konur, '***' diske yazılmaz", () => {
  mcp.saveConfig({
    servers: {
      fetch: { command: 'uvx', args: ['mcp-server-fetch'], env: { TOKEN: 'gercek-sir' } },
    },
  });
  const incoming = {
    servers: {
      fetch: { command: 'uvx', args: ['mcp-server-fetch'], env: { TOKEN: '***' } },
    },
  };
  mcp.restoreMaskedSecrets(incoming);
  assert.equal(incoming.servers.fetch.env.TOKEN, 'gercek-sir');
  mcp.saveConfig(incoming);
  assert.equal(mcp.readConfig(true).servers.fetch.env.TOKEN, 'gercek-sir');
});

function collect(child) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => (err += String(e.message)));
    child.on('close', () => resolve(out + err));
  });
}

test('MCP: güvenli spawn — metakarakter enjeksiyonu inert', { skip: process.platform !== 'win32' }, async () => {
  const hackFile = path.resolve('HACKED.txt');
  try { fs.unlinkSync(hackFile); } catch {}
  const out = await collect(
    mcp._spawnServer({
      command: 'node',
      args: ['-e', 'console.log("SAFE")', 'x&echo HACKED', 'y|echo HACKED', 'z>HACKED.txt'],
    })
  );
  assert.match(out, /SAFE/);
  assert.doesNotMatch(out, /HACKED/);
  assert.equal(fs.existsSync(hackFile), false);
});

test('MCP: npm .cmd sarmalayıcısı güvenli spawn ile çalışır', { skip: process.platform !== 'win32' }, async () => {
  const out = await collect(mcp._spawnServer({ command: 'npm', args: ['--version'] }));
  assert.match(out, /\d+\.\d+\.\d+/);
});
