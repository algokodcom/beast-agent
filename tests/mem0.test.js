'use strict';

/* mem0-native çekirdek testleri: store, dedup, konsolidasyon (mock LLM),
   hibrit arama (mock embedder), bot izolasyonu, ayna senkronu, audit. */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* her test dosyası kendi tmp kökünde — mem0 testleri scope başına FRESH dir ister */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-mem0-test-'));

const test = require('node:test');
const assert = require('node:assert');
const mem0 = require('../src/agent/mem0');

/* ---------- mock embedder ----------
   Konsept grupları → aynı boyut: anlam köprüsünü (eşanlı kelime) simüle eder.
   Diğer kelimeler hash ile dağıtılır. L2 normalize. */
const GROUPS = [
  ['maaş', 'bordro', 'ücret', 'para', 'zam'],
  ['hava', 'yağmur', 'sıcaklık', 'fırtına'],
  ['python', 'kod', 'yazılım', 'script'],
  ['çay', 'kahve', 'yemek', 'kahvaltı'],
];
function fakeVec(text) {
  const v = new Float32Array(mem0.DIMS);
  const t = String(text).toLowerCase();
  GROUPS.forEach((words, gi) => {
    if (words.some((w) => t.includes(w))) v[gi] = 1;
  });
  for (const m of t.matchAll(/[a-z0-9çğıöşü]{3,}/g)) {
    let h = 0;
    for (const ch of m[0]) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[16 + (h % (mem0.DIMS - 16))] += 0.5;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}
mem0.setEmbedder(async (texts) => texts.map(fakeVec));

function freshScope(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  process.env.BEAST_DATA = dir;
  return 'main';
}

function storeItems(scope) {
  const safe = String(scope || 'main').replace(/[^a-zA-Z0-9._-]+/g, '-');
  const raw = fs.readFileSync(path.join(process.env.BEAST_DATA, 'memories', 'mem0', safe + '.json'), 'utf8');
  return JSON.parse(raw).items;
}

/* ---------- testler ---------- */

test('add + hash dedup: aynı metin ikinci kez eklenmez', async () => {
  const s = freshScope('dedup');
  const r1 = await mem0.add(s, ['kullanıcı FxPro MT5 kullanıyor']);
  assert.equal(r1.ok, true);
  assert.equal(r1.added, 1);
  const r2 = await mem0.add(s, ['kullanıcı FxPro MT5 kullanıyor']);
  assert.equal(r2.added, 0);
  assert.equal(r2.skipped, 1);
  assert.equal(storeItems(s).length, 1);
});

test('semantic skip: aynı kelimeler farklı sırayla — tekrar eklenmez', async () => {
  const s = freshScope('semskip');
  await mem0.add(s, ['kullanıcı python ile kod yazıyor']);
  const r = await mem0.add(s, ['kod yazıyor kullanıcı python ile']);
  assert.equal(r.added, 0);
  assert.equal(storeItems(s).length, 1);
});

test('mock LLM konsolidasyon: UPDATE ve DELETE uygulanır', async () => {
  const s = freshScope('llmcons');
  await mem0.add(s, ['kullanıcı kahve içiyor']);
  assert.equal(storeItems(s).length, 1);
  const calls = [];
  const llm = async (sys, user) => {
    calls.push({ sys, user });
    return JSON.stringify({ events: [{ event: 'UPDATE', id: '0', text: 'kullanıcı çay içiyor (kahveyi bıraktı)' }] });
  };
  const r = await mem0.add(s, ['kullanıcı çay içiyor kahveyi bıraktı'], { llm });
  assert.equal(r.ok, true);
  assert.equal(r.llm, true);
  assert.equal(r.updated, 1);
  const items = storeItems(s);
  assert.equal(items.length, 1); // eski kayıt SİLİNMEDİ, GÜNCELLENDİ
  assert.ok(items[0].text.includes('çay'));
  assert.equal(items[0].text, 'kullanıcı çay içiyor (kahveyi bıraktı)');
  /* audit: UPDATE kaydı düşmeli */
  const hist = mem0.history(s, 20);
  assert.ok(hist.some((h) => h.event === 'UPDATE' && h.text === 'kullanıcı çay içiyor (kahveyi bıraktı)'));
});

test('mock LLM DELETE: çelişen kayıt silinir ve yenisi eklenir', async () => {
  const s = freshScope('llmdel');
  await mem0.add(s, ['kullanıcı İzmirde oturuyor']);
  const llm = async () =>
    JSON.stringify({ events: [{ event: 'DELETE', id: '0' }, { event: 'ADD', text: 'kullanıcı Ankarada oturuyor' }] });
  const r = await mem0.add(s, ['kullanıcı Ankaraya taşındı, İzmir bilgisi yanlış'], { llm });
  assert.equal(r.deleted, 1);
  assert.equal(r.added, 1);
  const texts = storeItems(s).map((it) => it.text);
  assert.deepEqual(texts, ['kullanıcı Ankarada oturuyor']);
});

test('llm patlarsa fast-path fallback: veri kaybolmaz', async () => {
  const s = freshScope('llmfail');
  const llm = async () => { throw new Error('llm yok'); };
  const r = await mem0.add(s, ['kullanıcı perşembe günleri squash oynuyor'], { llm });
  assert.equal(r.ok, true);
  assert.equal(r.llm, false);
  assert.equal(r.added, 1);
});

test('hibrit arama: eşanlı kelime vektör köprüsüyle bulunur (keyword bulamaz)', async () => {
  const s = freshScope('semsearch');
  await mem0.add(s, ['kullanıcı bordro sistemi kuruyor']); // "maaş" geçmiyor
  await mem0.add(s, ['kullanıcı hava durumunu takip ediyor']);
  const hits = await mem0.search(s, 'maaş hesabı nasıl', { limit: 3 });
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].text.includes('bordro'));
});

test('embedder yoksa keyword-only degradasyon çalışır', async () => {
  mem0.setEmbedder(null); // pipeline da yok (test ortamı) → keyword modu
  const s = freshScope('kwonly');
  await mem0.add(s, ['kullanıcının favori editörü VS Code']);
  const hits = await mem0.search(s, 'favori editör', { limit: 3 });
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].text.includes('editör'));
  mem0.setEmbedder(async (texts) => texts.map(fakeVec)); // geri aç
});

test('bot izolasyonu: aynı isimli scope\u2019lar birbirini GÖRMEZ', async () => {
  const dirA = path.join(ROOT, 'iso');
  fs.mkdirSync(dirA, { recursive: true });
  process.env.BEAST_DATA = dirA;
  await mem0.add('bot:a', ['bot-a sırrı: şifre 1234']);
  /* bot:b için ayrı fresh data dir */
  const dirB = path.join(ROOT, 'iso-b');
  fs.mkdirSync(dirB, { recursive: true });
  process.env.BEAST_DATA = dirB;
  const hitsB = await mem0.search('bot:b', 'şifre', { limit: 5 });
  assert.equal(hitsB.length, 0); // bot:b boş
  process.env.BEAST_DATA = dirA;
  const hitsA = await mem0.search('bot:a', 'şifre', { limit: 5 });
  assert.equal(hitsA.length, 1);
  /* dosya bazlı izolasyon: store dosyaları farklı */
  const mem0DirA = path.join(dirA, 'memories', 'mem0');
  assert.ok(fs.existsSync(path.join(mem0DirA, 'bot-a.json')));
  assert.ok(!fs.existsSync(path.join(mem0DirA, 'bot-b.json')));
});

test('reindexFromLines + syncMirror roundtrip (bot scope)', async () => {
  const dir = path.join(ROOT, 'mirror');
  fs.mkdirSync(dir, { recursive: true });
  process.env.BEAST_DATA = dir;
  fs.mkdirSync(path.join(dir, 'bots', 'ahmet'), { recursive: true });
  const memFile = path.join(dir, 'bots', 'ahmet', 'MEMORY.md');
  fs.writeFileSync(memFile, '- eski kayıt bir\n- eski kayıt iki\n');
  const scope = 'bot:ahmet';
  const r = mem0.reindexFromLines(scope, ['eski kayıt bir', 'eski kayıt iki']);
  assert.equal(r.count, 2);
  assert.equal(storeItems(scope).length, 2);
  await mem0.add(scope, ['yeni kayıt üç']);
  await mem0.syncMirror(scope);
  const mirrored = fs.readFileSync(memFile, 'utf8').split('\n').filter(Boolean);
  assert.equal(mirrored.length, 3);
  assert.ok(mirrored.some((l) => l.includes('yeni kayıt üç')));
  assert.ok(mirrored.every((l) => l.startsWith('- ')));
});

test('relevant: format ve charCap uyumu', async () => {
  const s = freshScope('relevant');
  await mem0.add(s, ['kullanıcı projede redis kullanıyor', 'kullanıcı sabah erken başlıyor', 'kullanıcı çay içiyor']);
  const out = await mem0.relevant(s, 'redis projesi', { maxRelevant: 2, maxRecent: 2 });
  assert.ok(out.startsWith('- '));
  assert.ok(out.split('\n').length >= 2);
  const capped = await mem0.relevant(s, 'redis', { charCap: 30 });
  assert.ok(capped.length <= 32);
});

test('extractFacts: mock LLM JSON parse + bozuk JSON güvenliği', async () => {
  const s = freshScope('extract');
  const llmOk = async () => JSON.stringify({ memories: ['kullanıcı Türkçe konuşmayı tercih ediyor', '', 'kullanıcı haftada 3 gün koşuyor'] });
  const facts = await mem0.extractFacts(llmOk, '# SOHBET\nkullanıcı: türkçe konuşalım', '', { max: 3 });
  assert.equal(facts.length, 2); // boş string elenir
  assert.equal(facts[0], 'kullanıcı Türkçe konuşmayı tercih ediyor');
  const llmBad = async () => 'bu JSON değil';
  assert.deepEqual(await mem0.extractFacts(llmBad, 'x', ''), []);
  assert.deepEqual(await mem0.extractFacts(null, 'x', ''), []); // llm yoksa []
});

test('audit history: tüm eventler sıralı döner', async () => {
  const s = freshScope('audit');
  await mem0.add(s, ['kullanıcı kayıt alfa tutuyor']);
  await mem0.add(s, ['kullanıcı kayıt beta tutuyor']);
  const hist = mem0.history(s, 10);
  assert.ok(hist.length >= 2);
  assert.ok(hist.every((h) => h.at && h.event === 'ADD'));
  /* en yeni en önce (reverse) */
  assert.ok(hist[0].text.includes('beta') || hist[hist.length - 1].text.includes('alfa'));
});

test('stats: kayıt ve vektör sayımı', async () => {
  const s = freshScope('stats');
  await mem0.add(s, ['kullanıcı maaşını yükseltti', 'kullanıcı yazılım projesi başlattı']);
  const st = mem0.stats(s);
  assert.equal(st.items, 2);
  assert.equal(st.withVec, 2); // mock embedder anında vektör verdi
  assert.equal(st.cap, mem0.CAP);
});
