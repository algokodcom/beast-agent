'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const tools = require('../src/agent/tools');
const repomap = require('../src/agent/repomap');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-map-'));
  fs.writeFileSync(
    path.join(dir, 'app.js'),
    [
      'const fast = (x) => x * 2;',
      'class Order {',
      '  constructor(id) { this.id = id; }',
      '  async ship(to) { return to; }',
      '}',
      'function createOrder(id) {',
      '  return new Order(id);',
      '}',
      'module.exports = { createOrder };',
    ].join('\n')
  );
  fs.mkdirSync(path.join(dir, 'svc'));
  fs.writeFileSync(
    path.join(dir, 'svc', 'auth.py'),
    ['class Auth:', '    def login(self, user):', '        return user', '', 'def logout():', '    pass'].join('\n')
  );
  fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n\nfunc main() {\n}\n\nfunc (s *Server) start() {}\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), 'function hidden() {}\n');
  return dir;
}

test('repomap: js/python/go sembol çıkarımı', () => {
  const dir = fixture();
  const syms = [];
  for (const f of ['app.js', path.join('svc', 'auth.py'), 'main.go']) {
    syms.push(...repomap.extractSymbols(path.join(dir, f), fs.readFileSync(path.join(dir, f), 'utf8')));
  }
  const names = syms.map((s) => s.name);
  assert.ok(names.includes('createOrder'), 'createOrder function olmalı');
  assert.ok(names.includes('Order'), 'Order class olmalı');
  assert.ok(names.includes('ship'), 'ship method olmalı');
  assert.ok(names.includes('Auth'), 'Auth class olmalı');
  assert.ok(names.includes('login'), 'login function olmalı');
  assert.ok(names.includes('main'), 'go main olmalı');
  assert.ok(names.includes('start'), 'go method start olmalı');
  /* satır numaraları 1-indexed ve doğru */
  const co = syms.find((s) => s.name === 'createOrder');
  assert.strictEqual(co.line, 6);
  const lg = syms.find((s) => s.name === 'login');
  assert.strictEqual(lg.line, 2);
});

test('repomap: repo_symbols query + kind filtresi + node_modules atlanır', async () => {
  const dir = fixture();
  const r = JSON.parse(await tools.exec('repo_symbols', { query: 'order' }, { cwd: dir }));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const names = r.results.map((x) => x.name);
  assert.ok(names.includes('createOrder'));
  assert.ok(names.includes('Order'));
  assert.ok(!names.includes('hidden'), 'node_modules taranmamalı');
  const hit = r.results.find((x) => x.name === 'createOrder');
  assert.strictEqual(hit.file, 'app.js');
  assert.strictEqual(hit.line, 6);

  const r2 = JSON.parse(await tools.exec('repo_symbols', { kind: 'class' }, { cwd: dir }));
  assert.ok(r2.results.every((x) => x.kind === 'class'));

  const r3 = JSON.parse(await tools.exec('repo_symbols', { query: '/^(ship|login)$/' }, { cwd: dir }));
  assert.deepStrictEqual(r3.results.map((x) => x.name).sort(), ['login', 'ship']);
});

test('repomap: repo_map dosya listesi + özet', async () => {
  const dir = fixture();
  const r = JSON.parse(await tools.exec('repo_map', {}, { cwd: dir }));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const files = r.files.map((f) => f.file.replace(/\\/g, '/'));
  assert.ok(files.includes('app.js'));
  assert.ok(files.includes('svc/auth.py'));
  assert.ok(files.includes('main.go'));
  const app = r.files.find((f) => f.file === 'app.js');
  assert.ok(app.symbols.some((s) => /class Order/.test(s)));
  assert.ok(app.symbols.some((s) => /createOrder\(\)/.test(s)));
});

test('repomap: olmayan yol hata döner', async () => {
  const dir = fixture();
  const r = JSON.parse(await tools.exec('repo_map', { path: 'yok-boyle-klasor' }, { cwd: dir }));
  assert.strictEqual(r.ok, false);
});
