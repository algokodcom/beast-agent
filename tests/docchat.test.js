'use strict';

/* docchat testi: SAHTE embedder ile uçtan uca — index → search → list → remove.
   MiniLM'in gerçeği yüklenmez (mem0.setEmbedder enjeksiyonu) → hızlı ve offline.
   Sahte embedder 384d üretir; kelime bagli deterministik (hash tabanlı):
   aynı kelime aynı yön, farklı kelimeler farklı yön benzerliği simüle eder;
   jaccard benzerlik + uzunluk düzeltmesi ile try been similarity kaba ama test
   için yeterli: aynı cümleler → 1.0, alakasız → ~düşük. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const mem0 = require('../src/agent/mem0');

process.env.BEAST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-docchat-'));

const docchat = require('../src/agent/docchat');

/* sahte embedder: kelime kümesi kesişimi → 384d normalize vektör */
const WORDS = new Map();
function wordIdx(w) {
  if (!WORDS.has(w)) WORDS.set(w, WORDS.size % 384);
  return WORDS.get(w);
}
function fakeEmbed(text) {
  const v = new Float32Array(384);
  const words = String(text).toLowerCase().match(/[a-z0-9çğıöşü]+/g) || [];
  if (!words.length) return v;
  for (const w of words) v[wordIdx(w)] += 1;
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  for (let i = 0; i < 384; i++) v[i] /= n;
  return v;
}
mem0.setEmbedder(async (texts) => texts.map((t) => fakeEmbed(t)));

test('chunkify: uzun metin parçalanır + kısa metin tek parça', () => {
  const one = docchat.chunkify('kısa metin');
  assert.strictEqual(one.length, 1);
  const long = Array.from({ length: 120 }, (_, i) => 'Bu program ' + i + ' kelime dizisi test eder.').join(' ');
  const parts = docchat.chunkify(long);
  assert.ok(parts.length > 3, 'parçalar');
  for (const p of parts) assert.ok(p.length <= 1500);
});

test('doc_chat index + search + list + remove (sahte embedder)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docchat-docs-'));
  fs.writeFileSync(path.join(dir, 'notlar.md'), 'Kafka distribütör konuları: order.floor, order.celing ve partition konfigler.\nKatalogda fiyatlar enflasyonla güncellenir.');
  fs.writeFileSync(path.join(dir, 'insan.txt'), 'Ahmet Yılmaz 34 yaşında, İzmirde yazılımcı olarak çalışıyor. Kanka ile balık tutmayı seviyor.');
  fs.writeFileSync(path.join(dir, 'boş.docx'), 'desteklenmez');
  const pkg = path.join(dir, 'node_modules');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'gizli.txt'), 'bu klasör atlanmalı');

  const idx = await docchat.handlers.doc_chat({ action: 'index', path: dir, library: 'testlib' });
  assert.strictEqual(idx.ok, true);
  assert.strictEqual(idx.indexedFiles, 2, 'iki dosya (node_modules atlanır, .docx desteklenmez)');
  assert.ok(idx.newChunks > 0);

  const list = await docchat.handlers.doc_chat({ action: 'list', library: 'testlib' });
  assert.strictEqual(list.ok, true);
  assert.strictEqual(list.files, 2);
  assert.strictEqual(list.chunks, idx.newChunks);

  const sr = await docchat.handlers.doc_chat({
    action: 'search', query: 'partition konfig neyin üstünde ayarli', library: 'testlib',
  });
  assert.strictEqual(sr.ok, true);
  assert.ok(sr.results.length > 0, 'sonuç var');
  assert.ok(/notlar\.md/.test(sr.results[0].citation), 'alıntı dosya ' + JSON.stringify(sr.results.slice(0, 2).map((r) => r.citation)));
  assert.ok(/kafka|order|partition/i.test(sr.results[0].text));

  const rm = await docchat.handlers.doc_chat({ action: 'remove', path: path.join(dir, 'notlar.md'), library: 'testlib' });
  assert.strictEqual(rm.ok, true);
  const list2 = await docchat.handlers.doc_chat({ action: 'list', library: 'testlib' });
  assert.strictEqual(list2.files, 1);
});

test('inkremental index: değişmemiş dosya atlanır', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docchat-inc-'));
  const f = path.join(dir, 'a.md');
  fs.writeFileSync(f, 'algebra dalı logaritma örtük fonksiyonlarla ilgili.');
  const first = await docchat.handlers.doc_chat({ action: 'index', path: dir, library: 'inctest' });
  const second = await docchat.handlers.doc_chat({ action: 'index', path: dir, library: 'inctest' });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.skippedUnchanged, 1, 'aynı dosya (fingerprint değişmedi)');
  fs.writeFileSync(f, 'değiştirildi — artık farklı içerik var vektörler yenilenir.');
  const third = await docchat.handlers.doc_chat({ action: 'index', path: dir, library: 'inctest' });
  assert.strictEqual(third.indexedFiles, 1, 'fingerprint değişti → yeniden index');
});

test('clear: kütüphane sıfırlanır', async () => {
  await docchat.handlers.doc_chat({ action: 'clear', library: 'inctest' });
  const l = docchat.loadLib('inctest');
  assert.strictEqual(l.chunks.length, 0);
  assert.strictEqual(Object.keys(l.files).length, 0);
});

test('tools.js dokümanı tanıdı (tanım + handler zinciri)', async () => {
  const tools = require('../src/agent/tools');
  const def = tools.definitions.find((d) => d.function.name === 'doc_chat');
  assert.ok(def, 'tanım tools.definitions içinde');
  /* kötü action → zarif hata (tools.exec üzerinden) */
  const out = await tools.exec('doc_chat', { action: 'geçersiz' }, { cwd: os.tmpdir() });
  const j = JSON.parse(out);
  assert.strictEqual(j.ok, false);
  assert.ok(/bilinmeyen action/.test(j.error));
});
