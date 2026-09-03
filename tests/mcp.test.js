'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const mcp = require('../src/agent/mcp');

const DATA = process.env.BEAST_DATA;

function writeCfg(obj) {
  const p = mcp.configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

const fakeServer = path.join(__dirname, 'fixtures', 'fake-mcp-server.js');

/* ---------- saf fonksiyonlar ---------- */

test('sanitizeName: türkçe/özel karakterler temizlenir', () => {
  assert.strictEqual(mcp.sanitizeName('Git Server'), 'git-server');
  assert.strictEqual(mcp.sanitizeName('  FETCH!!  '), 'fetch');
  assert.strictEqual(mcp.sanitizeName(''), 'server');
  assert.strictEqual(mcp.sanitizeName('a_b-c9'), 'a_b-c9');
});

test('parseFullName: mcp__server__tool biçimi', () => {
  assert.deepStrictEqual(mcp.parseFullName('mcp__git__status'), { server: 'git', tool: 'status' });
  assert.deepStrictEqual(mcp.parseFullName('mcp__fs-server__read_file.v2'), { server: 'fs-server', tool: 'read_file.v2' });
  assert.strictEqual(mcp.parseFullName('read_file'), null);
  assert.strictEqual(mcp.parseFullName('mcp__only_server'), null);
  assert.strictEqual(mcp.parseFullName('mcp__BU__tool'), null); /* server adı küçük harf zorunlu */
});

test('extractText: content parçaları birleşir', () => {
  const t = mcp.extractText({ content: [{ type: 'text', text: 'bir' }, { type: 'text', text: 'iki' }] });
  assert.strictEqual(t, 'bir\niki');
  assert.strictEqual(mcp.extractText(null), '');
  assert.strictEqual(mcp.extractText({ content: [] }), '');
  const r = mcp.extractText({ content: [{ type: 'resource', resource: { uri: 'file:///x' } }] });
  assert.ok(r.includes('file:///x'));
});

test('readConfig: dosya yoksa boş yapı, bozuk JSON patlamaz', () => {
  fs.rmSync(mcp.configPath(), { force: true });
  const cfg = mcp.readConfig(true);
  assert.deepStrictEqual(cfg.servers, {});
  fs.mkdirSync(path.dirname(mcp.configPath()), { recursive: true });
  fs.writeFileSync(mcp.configPath(), '{ bozuk');
  assert.deepStrictEqual(mcp.readConfig(true).servers, {});
});

test('saveConfig + readConfig döngüsü: normalizasyon uygulanır', () => {
  mcp.saveConfig({
    servers: {
      'Git Server': { command: 'uvx', args: ['mcp-server-git'], enabled: true, timeoutMs: 999999999 },
      kapalı: { command: 'x', enabled: false },
    },
  });
  const cfg = mcp.readConfig(true);
  assert.ok(cfg.servers['git-server']);
  assert.strictEqual(cfg.servers['git-server'].timeoutMs, 600000); /* tavan uygulanır */
  assert.strictEqual(cfg.servers['kapal'].enabled, false); /* ad slug'lanır (ı→ yok) */
});

/* ---------- uçtan uca: sahte stdio server ---------- */

test('sahte MCP server: bağlan, şema al, çağır', async () => {
  mcp._reset();
  writeCfg({
    servers: {
      fake: { command: process.execPath, args: [fakeServer], enabled: true },
    },
  });
  const toolsList = await mcp.mergeTools([]);
  const names = toolsList.map((t) => t.function.name);
  assert.ok(names.includes('mcp__fake__echo'), 'echo şeması gelmeli: ' + names.join(','));
  assert.ok(names.includes('mcp__fake__add'));
  const echo = toolsList.find((t) => t.function.name === 'mcp__fake__echo');
  assert.ok(echo.function.description.startsWith('[mcp:fake]'));
  assert.strictEqual(echo.function.parameters.type, 'object');

  const r = await mcp.call('mcp__fake__echo', { text: 'selam' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result, 'ECHO:selam');

  const r2 = await mcp.call('mcp__fake__add', { a: 2, b: 3 });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.result, 'SUM:5');
});

test('yetkili liste (tools): şema ve çağrı filtrelenir', async () => {
  mcp._reset();
  writeCfg({
    servers: {
      fake: { command: process.execPath, args: [fakeServer], enabled: true, tools: ['add'] },
    },
  });
  await mcp.refresh('fake');
  const schemas = mcp.toolSchemas().map((t) => t.function.name);
  assert.ok(schemas.includes('mcp__fake__add'));
  assert.ok(!schemas.includes('mcp__fake__echo'), 'echo listede yok — şemada olmamalı');
  const r = await mcp.call('mcp__fake__echo', { text: 'x' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('yetkili listede değil'));
  const r2 = await mcp.call('mcp__fake__add', { a: 1, b: 1 });
  assert.strictEqual(r2.ok, true);
});

test('kapalı server: şema yok, çağrı reddedilir', async () => {
  mcp._reset();
  writeCfg({ servers: { fake: { command: process.execPath, args: [fakeServer], enabled: false } } });
  const toolsList = await mcp.mergeTools([]);
  assert.strictEqual(toolsList.length, 0);
  const r = await mcp.call('mcp__fake__echo', { text: 'x' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('kapalı'));
});

test('çöken server: cooldown + status down', async () => {
  mcp._reset();
  writeCfg({ servers: { kirik: { command: process.execPath, args: ['-e', 'process.exit(1)'], enabled: true } } });
  const toolsList = await mcp.mergeTools([]);
  assert.strictEqual(toolsList.length, 0);
  const r = await mcp.call('mcp__kirik__echo', {});
  assert.strictEqual(r.ok, false);
  const st = mcp.status().servers.find((s) => s.name === 'kirik');
  assert.ok(st);
  assert.ok(['down', 'idle'].includes(st.state), 'state down/idle olmalı: ' + st.state);
});

test('status: server özeti döner', async () => {
  writeCfg({
    servers: { fake: { command: process.execPath, args: [fakeServer], enabled: true } },
  });
  await mcp.refresh('fake');
  const st = mcp.status();
  assert.ok(st.path.endsWith('mcp.json'));
  const s = st.servers.find((x) => x.name === 'fake');
  assert.strictEqual(s.state, 'up');
  assert.strictEqual(s.toolCount, 2);
  assert.deepStrictEqual(s.toolNames.sort(), ['add', 'echo']);
  mcp.stopAll();
});
