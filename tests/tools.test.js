'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const tools = require('../src/agent/tools');

/* ---------- SSRF guard ---------- */

test('public URL kabul edilir', () => {
  const u = tools.assertPublicHttpUrl('https://example.com/x?y=1');
  assert.ok(u.startsWith('https://example.com'));
});

test('localhost ve özel ağlar engellenir', () => {
  const bad = [
    'http://localhost/a',
    'http://127.0.0.1/',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://169.254.169.254/meta',
    'http://pc.local/',
    'file:///C:/Windows',
    'ftp://example.com',
    'http://[::1]/',
    'http://user:pass@example.com/',
  ];
  for (const u of bad) assert.throws(() => tools.assertPublicHttpUrl(u));
});

test('geçersiz URL atar', () => {
  assert.throws(() => tools.assertPublicHttpUrl('not a url'));
});

/* ---------- DDG parser ---------- */

test('parseDdgResults sonuçları ayrıştırır', () => {
  const html = `
  <div class="result results_links">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=abc">Örnek <b>Başlık</b></a>
    <a class="result__snippet" href="#">Açıklama &amp; özet</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://direct.com/b">Direkt</a>
    <a class="result__snippet">snpt</a>
  </div>`;
  const out = tools.parseDdgResults(html);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://example.com/a');
  assert.equal(out[0].title, 'Örnek Başlık');
  assert.ok(out[0].snippet.includes('özet'));
  assert.equal(out[1].url, 'https://direct.com/b');
});

test('parseDdgResults boş HTML\u0027de boş döner', () => {
  assert.deepEqual(tools.parseDdgResults('<html></html>'), []);
});

/* ---------- htmlToText ---------- */

test('htmlToText script/style temizler', () => {
  const t = tools.htmlToText('<head><style>p{color:red}</style><script>evil()</script></head><body><p>Merhaba</p> dünya</body>');
  assert.ok(t.includes('Merhaba'));
  assert.ok(!t.includes('evil'));
  assert.ok(!t.includes('color:red'));
});

/* ---------- dosya araçları ---------- */

const fs = require('fs');
const os = require('os');
const path = require('path');

test('exec write/read/list turu', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-tools-'));
  const w = JSON.parse(await tools.exec('write_file', { path: 'alt/dosya.txt', content: 'içerik' }, { cwd }));
  assert.ok(w.ok);
  const r = JSON.parse(await tools.exec('read_file', { path: 'alt/dosya.txt' }, { cwd }));
  /* opencode read.ts port: içerik satır numaralı döner (N: içerik) */
  assert.equal(r.content, '1: içerik');
  assert.equal(r.totalLines, 1);
  assert.ok(!r.truncated);
  const l = JSON.parse(await tools.exec('list_dir', {}, { cwd }));
  assert.ok(l.entries.split('\n')[0].includes('alt'));
});
