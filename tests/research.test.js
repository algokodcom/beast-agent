'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');

const research = require('../src/agent/research');

test('normKey: scheme/www/slash/hash farklarını yok sayar', () => {
  assert.equal(research.normKey('http://www.Example.com/a/'), research.normKey('https://example.com/a#x'));
});

test('mergeResults: round-robin harman + tekilleştirme', () => {
  const a = [
    { title: 'A1', url: 'https://a.com/1' },
    { title: 'A2', url: 'https://a.com/2' },
  ];
  const b = [
    { title: 'B1', url: 'https://a.com/1/' }, // A1 ile aynı (slash)
    { title: 'B1x', url: 'http://www.b.com/x' },
  ];
  const merged = research.mergeResults([a, b], 10);
  assert.deepEqual(merged.map((r) => r.url), ['https://a.com/1', 'https://a.com/2', 'http://www.b.com/x']);
  assert.equal(merged[2].title, 'B1x'); // ilk gören kazanır, orijinal url korunur
});

test('normalizeRows: {results} veya dizi + alternatif anahtarlar', () => {
  const r1 = research.normalizeRows({ results: [{ name: 'X', href: 'https://x.com', body: 'b' }] });
  assert.equal(r1[0].title, 'X');
  assert.equal(r1[0].url, 'https://x.com');
  const r2 = research.normalizeRows([{ title: 'Y', link: 'https://y.com', description: 'd' }]);
  assert.equal(r2[0].url, 'https://y.com');
  assert.equal(research.normalizeRows(null).length, 0);
  assert.equal(research.normalizeRows([{ title: '', url: 'https://z.com' }]).length, 0); // başlıksız elenir
});

test('deepSearch: paralel sorgular harmanlanır, ilk N sayfa okunur', async () => {
  const searches = {
    'elma': [{ title: 'A', url: 'https://a.com' }, { title: 'B', url: 'https://b.com' }],
    'apple': [{ title: 'B2', url: 'https://b.com' }, { title: 'C', url: 'https://c.com' }],
  };
  const readCalls = [];
  const r = await research.deepSearch(
    { queries: ['elma', 'apple'], read_top: 2 },
    {
      search: async (q) => searches[q],
      readPage: async (u) => { readCalls.push(u); return { ok: true, url: u, title: 'T:' + u, content: 'icerik ' + u }; },
    }
  );
  assert.ok(r.ok);
  assert.deepEqual(r.queries, ['elma', 'apple']);
  assert.equal(r.results.length, 3); // b.com duplike düştü
  assert.deepEqual(readCalls, ['https://a.com', 'https://b.com']); // ilk 2 hedef
  assert.equal(r.pages.length, 2);
  assert.ok(r.pages[0].content.includes('https://a.com'));
  assert.match(r.note, /gizli tarayıcı/);
});

test('deepSearch: ikili dosya hedefleri okumadan atlanır', async () => {
  const readCalls = [];
  const r = await research.deepSearch(
    { queries: ['q'], read_top: 3 },
    {
      search: async () => [
        { title: 'PDF', url: 'https://x.com/doc.pdf' },
        { title: 'Sayfa', url: 'https://x.com/page' },
      ],
      readPage: async (u) => { readCalls.push(u); return { ok: true, url: u, content: 'c' }; },
    }
  );
  assert.deepEqual(readCalls, ['https://x.com/page']);
  assert.equal(r.pages.length, 1);
});

test('deepSearch: readPage yoksa yalnız sonuç listesiyle döner', async () => {
  const r = await research.deepSearch(
    { queries: ['q'] },
    { search: async () => [{ title: 'A', url: 'https://a.com' }] }
  );
  assert.ok(r.ok);
  assert.equal(r.results.length, 1);
  assert.equal(r.pages, undefined);
});

test('deepSearch: bir sorgu çökerse diğerleri kurtarır; boşsa ok:false', async () => {
  const r1 = await research.deepSearch(
    { queries: ['patlar', 'iyi'] },
    {
      search: async (q) => { if (q === 'patlar') throw new Error('boom'); return [{ title: 'A', url: 'https://a.com' }]; },
      readPage: async () => ({ ok: false }),
    }
  );
  assert.ok(r1.ok && r1.results.length === 1);
  const r2 = await research.deepSearch(
    { queries: ['yok1', 'yok2'] },
    { search: async () => [], readPage: async () => ({ ok: false }) }
  );
  assert.equal(r2.ok, false);
  assert.match(r2.error, /boş/);
});

test('deepSearch: sorgu yoksa net hata; queries string de kabul edilir', async () => {
  const bad = await research.deepSearch({}, { search: async () => [] });
  assert.equal(bad.ok, false);
  const r = await research.deepSearch(
    { queries: 'tek sorgu' },
    { search: async () => [{ title: 'A', url: 'https://a.com' }] }
  );
  assert.deepEqual(r.queries, ['tek sorgu']);
});

test('SKIP_FILE_RE: pdf/görsel/arşiv yakalanır, sayfa yakalanmaz', () => {
  assert.ok(research.SKIP_FILE_RE.test('https://x.com/a.pdf'));
  assert.ok(research.SKIP_FILE_RE.test('https://x.com/img.png?w=9'));
  assert.ok(!research.SKIP_FILE_RE.test('https://x.com/article'));
});
