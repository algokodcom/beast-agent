'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const customtools = require('../src/agent/customtools');

test('customtools: kaydet → tanım → çağır → sil döngüsü', async () => {
  const r = customtools.save({
    name: 'test_toolu',
    description: 'deneme toolu',
    parameters: { type: 'object', properties: {} },
    code: "console.log(JSON.stringify({ ok: true, k: 2 * 3 }));",
  });
  assert.equal(r.ok, true);
  assert.equal(r.id, 'test_toolu');

  const defs = customtools.definitions();
  const def = defs.find((d) => d.function.name === 'tool__test_toolu');
  assert.ok(def, 'tanım listede olmalı');
  assert.equal(def.function.description, 'deneme toolu (kişisel tool — args stdin JSON, sonuç stdout JSON)');

  const out = await customtools.call('tool__test_toolu', { a: 1 });
  assert.equal(out.ok, true);
  assert.equal(out.k, 6);

  assert.equal(customtools.remove('test_toolu').ok, true);
  assert.ok(!customtools.definitions().some((d) => d.function.name === 'tool__test_toolu'));
});

test('customtools: bozuk çıkış → ok:false, hata taşıyıcı', async () => {
  customtools.save({
    name: 'test_hata',
    description: 'hata toolu',
    parameters: { type: 'object', properties: {} },
    code: "console.error('patladı'); process.exit(1);",
  });
  const out = await customtools.call('tool__test_hata', {});
  assert.equal(out.ok, false);
  assert.ok(String(out.error || '').length > 0);
  customtools.remove('test_hata');
});

test('customtools: bozuk JSON çıktı metne sarılır', async () => {
  customtools.save({
    name: 'test_raw',
    description: 'raw çıktı',
    parameters: { type: 'object', properties: {} },
    code: "console.log('merhaba dünya');",
  });
  const out = await customtools.call('tool__test_raw', {});
  assert.equal(out.ok, true);
  assert.equal(out.result, 'merhaba dünya');
  customtools.remove('test_raw');
});

test('customtools: tool KENDİ klasöründe koşar (cwd = tools/<slug>)', async () => {
  customtools.save({
    name: 'test_cwd',
    description: 'cwd kontrolü',
    parameters: { type: 'object', properties: {} },
    code: "console.log(JSON.stringify({ ok: true, cwd: process.cwd() }));",
  });
  const out = await customtools.call('tool__test_cwd', {});
  assert.equal(out.ok, true);
  assert.ok(
    String(out.cwd || '').replace(/\\/g, '/').toLowerCase().endsWith('/tools/test_cwd'),
    'beklenen cwd tools/test_cwd, gelen: ' + out.cwd
  );
  customtools.remove('test_cwd');
});
