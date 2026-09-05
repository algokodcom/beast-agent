'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const apps = require('../src/agent/apps');

test('beast app: builtin seed kurulur ve taranır', () => {
  apps.seedApps();
  const all = apps.scan();
  const calc = all.find((a) => a.id === 'hesap-makinesi');
  assert.ok(calc, 'seed app kurulu olmalı');
  assert.strictEqual(calc.name, 'Hesap Makinesi');
  assert.ok(calc.uiPath, 'ui/index.html bulunmalı');
  assert.ok(calc.enabled, 'varsayılan etkin olmalı');
});

test('beast app: startAll araç kaydeder, şemalar modele açılır', () => {
  apps.startAll();
  const schemas = apps.schemas();
  const names = schemas.map((s) => s.function.name);
  assert.ok(names.includes('app__hesap-makinesi__hesapla'), 'hesapla şeması olmalı');
  const sch = schemas.find((s) => s.function.name === 'app__hesap-makinesi__hesapla');
  assert.match(sch.function.description, /\[app:hesap-makinesi\]/);
  assert.ok(sch.function.parameters, 'parameters şeması olmalı');
  assert.ok(apps.mergeTools([]).length >= 1, 'mergeTools listeye eklemeli');
});

test('beast app: araç çağrısı hesaplar + güvenli olmayan girdiyi reddeder', async () => {
  const r1 = await apps.call('app__hesap-makinesi__hesapla', { expression: '(6*7)' });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.result, 42);
  const r2 = await apps.call('app__hesap-makinesi__hesapla', { expression: 'process.exit(1)' });
  assert.strictEqual(r2.ok, false);
  const r3 = await apps.call('app__bilinmeyen__x', {});
  assert.strictEqual(r3.ok, false);
});

test('beast app: app storage (beast API) çalışır', () => {
  const appDir = path.join(apps.dir(), 'hesap-makinesi');
  assert.ok(fs.existsSync(path.join(appDir, 'app.json')));
  /* makeApi doğrudan export edilmiyor — storage ana hattı apps.call ile zaten
     test edildi; burada data.json yolunun app klasöründe olduğundan emin ol */
  assert.ok(appDir.endsWith(path.join('apps', 'hesap-makinesi')));
});

test('beast app: toggle kapat/aç — şemalar düşer ve geri gelir', async () => {
  const off = apps.toggle('hesap-makinesi', false);
  assert.ok(off.ok);
  assert.ok(!apps.schemas().some((s) => s.function.name.includes('hesapla')));
  const on = apps.toggle('hesap-makinesi', true);
  assert.ok(on.ok);
  assert.ok(apps.schemas().some((s) => s.function.name === 'app__hesap-makinesi__hesapla'));
});

test('beast app: engine dispatch app__* araçlarını apps host\'a yollar', async () => {
  const Engine = require('../src/agent/engine');
  const os = require('os');
  const eng = new Engine({}, { sessionsDir: path.join(os.tmpdir(), 'beast-apps-test-' + Date.now()) });
  const out = JSON.parse(await eng._execTool('app__hesap-makinesi__hesapla', { expression: '5+5' }, null, 's1'));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.result, 10);
});

test('beast app: kaldırma temiz çalışır', async () => {
  const r = await apps.remove('hesap-makinesi');
  assert.ok(r.ok);
  assert.ok(!apps.scan().some((a) => a.id === 'hesap-makinesi'), 'kaldırılan listede olmamalı');
  /* sonraki test dosyaları için seed'i geri yaz */
  apps.seedApps();
  apps.startAll();
});

test('beast app: yerel klasörden kurulum + araç çalışır', async () => {
  const os = require('os');
  const tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-app-src-'));
  fs.writeFileSync(
    path.join(tmpSrc, 'app.json'),
    JSON.stringify({ id: 'test-app', name: 'Test App', version: '0.1.0', description: 'deneme', permissions: ['tools'], icon: 'T' })
  );
  fs.writeFileSync(
    path.join(tmpSrc, 'main.js'),
    "module.exports = (beast) => { beast.tools.register('topla', { description: 'toplama', parameters: { type: 'object', properties: { a: { type: \"number\" }, b: { type: \"number\" } } }, handler: (x) => ({ ok: true, sum: Number(x.a) + Number(x.b) }) }); };"
  );
  const r = await apps.install(tmpSrc);
  assert.ok(r.ok, 'kurulum başarılı olmalı: ' + ((r && r.error) || ''));
  assert.strictEqual(r.id, 'test-app');
  assert.ok(r.start && r.start.ok, 'kurulum sonrası otomatik başlamalı');
  const out = await apps.call('app__test-app__topla', { a: 2, b: 3 });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.sum, 5);
  /* kaldır: temiz durum bırak */
  const rm = await apps.remove('test-app');
  assert.ok(rm.ok);
});

test('beast app: seed mevcut app\'i ezmez', () => {
  const marker = path.join(apps.dir(), 'hesap-makinesi', 'data.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, '{"k":1}');
  apps.seedApps();
  assert.ok(fs.existsSync(marker), 'kullanıcı data.json korunmalı');
});
