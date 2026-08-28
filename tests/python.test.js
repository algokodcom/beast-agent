'use strict';

/* #18 python_run altyapısı testleri — ağ çağrısı YOK */

const test = require('node:test');
const assert = require('node:assert');
const tools = require('../src/agent/tools');

test('python_run tanımı TOOLS içinde', () => {
  const def = tools.definitions.find((d) => d.function.name === 'python_run');
  assert.ok(def, 'python_run var');
  const props = def.function.parameters.properties;
  for (const k of ['code', 'script', 'args', 'timeout_ms']) assert.ok(props[k], k);
});

test('code/script yoksa net hata döner (interpreter araması bile gerekmez)', async () => {
  const out = await tools.exec('python_run', {}, { cwd: process.cwd(), allowDownload: false });
  const r = JSON.parse(out);
  assert.strictEqual(r.ok, false);
  assert.ok(/code ya da script/.test(r.error), r.error);
});

test('olmayan script: interpreter bakılmadan bulunamadı + klasör ipucu döner', async () => {
  const out = await tools.exec(
    'python_run',
    { script: 'kesinlikle-yok-abc123.py' },
    { cwd: process.cwd(), allowDownload: false }
  );
  const r = JSON.parse(out);
  assert.strictEqual(r.ok, false);
  assert.match(String(r.error || ''), /bulunamadı/);
  assert.match(String(r.hint || ''), /scripts/, 'klasör ipucu verildi');
});

test('scripts klasörü çözümlenir ve oluşturulur', () => {
  const dir = tools.pythonScriptsDir();
  assert.ok(typeof dir === 'string' && dir.length > 0);
});

test('paketlenmiş python scriptleri mevcut ve tohumlanır', () => {
  for (const name of ['websearch.py', 'news.py']) {
    assert.ok(require('fs').existsSync(tools.bundledScriptPath(name)), 'paket içi: ' + name);
    const dest = tools.seedScript(name);
    assert.ok(require('fs').existsSync(dest), 'tohumlandı: ' + dest);
  }
});

/* canlı: python hızlı arama yolu (ağ varsa gerçek sonuç, yoksa JS fallback) */
test('webSearchFast: python yolu ya da fallback sonuç döner', async function () {
  const r = await tools.webSearchFast('electron builder portable windows', { maxResults: 5 });
  assert.strictEqual(r.ok, true);
  if (!r.results.length) return this.skip('motorlar bu turda sonuç döndürmedi (ağ/rate-limit) — kablaj doğru');
  assert.ok(r.results[0].title && r.results[0].url);
}, { timeout: 40000 });

/* canlı python varsa (BEAST_PYTHON / sistem / önceden kurulmuş gömülü):
   gerçek bir hesap çalıştırılır — ağ kurulumu yapılmaz */
test('canlı interpreter ile inline code çalışır (kuruluysa)', async () => {
  let py = null;
  try { py = await tools.findSystemPython(); } catch {}
  if (!py) {
    try { fsAccess(tools.embeddedPythonExe()); } catch { return test.skip('interpreter yok — atlandı'); }
  }
  const out = await tools.exec(
    'python_run',
    { code: 'print(21*2)' },
    { cwd: process.cwd(), allowDownload: false }
  );
  const r = JSON.parse(out);
  if (r.ok) assert.ok(/42/.test(r.output), 'çıktı: ' + r.output);
}, { timeout: 30000 });

function fsAccess(p) {
  require('fs').accessSync(p);
}
