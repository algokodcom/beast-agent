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

test('customtools: çocuk süreç node modunda koşar (ELECTRON_RUN_AS_NODE — electron GUI asılması)', async () => {
  customtools.save({
    name: 'test_node_mode',
    description: 'electron node modu kontrolü',
    parameters: { type: 'object', properties: {} },
    code: "console.log(JSON.stringify({ ok: true, runAsNode: process.env.ELECTRON_RUN_AS_NODE || null }));",
  });
  const out = await customtools.call('tool__test_node_mode', {});
  assert.equal(out.ok, true);
  assert.equal(out.runAsNode, '1', 'çocuk sürece ELECTRON_RUN_AS_NODE=1 verilmeli');
  customtools.remove('test_node_mode');
});

test('customtools: trade hook başarılı çağrıda (id, args, sonuç, sid) ile tetiklenir', async () => {
  customtools.save({
    name: 'test_hook',
    description: 'hook toolu',
    parameters: { type: 'object', properties: {} },
    code: "const fs=require('fs');let r='';try{r=fs.readFileSync(0,'utf8')}catch{};console.log(JSON.stringify({ ok: true, args: JSON.parse(r||'{}') }));",
  });
  let seen = null;
  customtools.setTradeHook((id, args, res, sid) => { seen = { id, args, res, sid }; });
  try {
    const out = await customtools.call('tool__test_hook', { symbol: 'GOLD', volume: 0.1 }, 'sid-1');
    assert.equal(out.ok, true);
    assert.ok(seen, 'hook tetiklenmeli');
    assert.equal(seen.id, 'test_hook');
    assert.equal(seen.args.symbol, 'GOLD');
    assert.equal(seen.res.ok, true);
    assert.equal(seen.sid, 'sid-1');
  } finally {
    customtools.setTradeHook(null);
    customtools.remove('test_hook');
  }
});

test('customtools: seedDefaults sürüm güncellemesi yapar + düzenlenen dosyayı yedekler', () => {
  const fs = require('fs');
  const path = require('path');
  customtools.seedDefaults(); // temiz kurulum (test veri kökü izole)
  const dir = path.join(customtools.dir(), 'mt5_shot');
  const runPath = path.join(dir, 'run.js');
  const toolPath = path.join(dir, 'tool.json');
  assert.ok(fs.existsSync(runPath), 'mt5_shot kurulmalı');

  /* eski sürümü simüle et: defaultsVersion sil + kullanıcı düzenlemesi ekle */
  const j = JSON.parse(fs.readFileSync(toolPath, 'utf8'));
  delete j.defaultsVersion;
  fs.writeFileSync(toolPath, JSON.stringify(j, null, 2));
  fs.appendFileSync(runPath, '\n// KULLANICI DUZENLEMESI\n');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shots', 'x.png'), 'x');

  const n = customtools.seedDefaults();
  assert.equal(n, 1, 'yalnız mt5_shot güncellenmeli');
  const after = JSON.parse(fs.readFileSync(toolPath, 'utf8'));
  assert.ok(Number(after.defaultsVersion) >= 2, 'defaultsVersion yükselmeli');
  const runNew = fs.readFileSync(runPath, 'utf8');
  assert.ok(runNew.includes('runPanels') && runNew.includes('normalizeSymbols'), 'run.js yeni sürüm olmalı (çoklu sembol)');
  assert.ok(fs.existsSync(path.join(dir, 'stitch.js')), 'stitch.js kurulmalı');
  assert.ok(fs.existsSync(runPath + '.user-bak'), 'kullanıcı düzenlemesi yedeklenmeli');
  assert.ok(fs.readFileSync(runPath + '.user-bak', 'utf8').includes('KULLANICI DUZENLEMESI'), 'yedek eski içeriği taşımalı');
  assert.ok(fs.existsSync(path.join(dir, 'shots', 'x.png')), 'shots/ korunmalı');

  assert.equal(customtools.seedDefaults(), 0, 'güncel sürümde iş yapılmamalı');
});
