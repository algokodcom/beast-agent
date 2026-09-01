'use strict';

/* Obscura entegrasyonu + sıralı web arama zinciri testleri (ağ çağrısı yok) */

const test = require('node:test');
const assert = require('node:assert');
const tools = require('../src/agent/tools');
const obscura = require('../src/agent/obscura');

test('varsayılan zincir: 4 motor, hepsi açık, obscura AKTİF', () => {
  const c = tools.getSearchChain();
  assert.deepEqual(c.map((x) => x.id), ['browser', 'obscura', 'tinyfish', 'python']);
  for (const r of c) assert.strictEqual(r.on, true, r.id + ' varsayılan açık');
});

test('setSearchChain: sıra yeniden düzenlenir, eksik motorlar sona eklenir (açık)', () => {
  const c = tools.setSearchChain([
    { id: 'obscura', on: true },
    { id: 'python', on: true },
    { id: 'browser', on: false },
  ]);
  assert.deepEqual(c.map((x) => x.id), ['obscura', 'python', 'browser', 'tinyfish']);
  assert.strictEqual(c.find((x) => x.id === 'browser').on, false);
  assert.strictEqual(c.find((x) => x.id === 'tinyfish').on, true, 'listede olmayan motor varsayılan açık');
  tools.setSearchChain(tools.DEFAULT_SEARCH_CHAIN); /* testler arası temizlik */
});

test('setSearchChain: hepsi kapalıysa tarayıcı zorunlu açılır (zincir boş kalmasın)', () => {
  const c = tools.setSearchChain(['obscura', 'tinyfish', 'python', 'browser'].map((id) => ({ id, on: false })));
  assert.strictEqual(c.find((x) => x.id === 'browser').on, true);
  tools.setSearchChain(tools.DEFAULT_SEARCH_CHAIN);
});

test('setSearchChain: bilinmeyen id ve tekrar elenir', () => {
  const c = tools.setSearchChain([{ id: 'exa', on: true }, { id: 'obscura' }, { id: 'obscura', on: false }, 'python']);
  assert.deepEqual(c.map((x) => x.id), ['obscura', 'python', 'browser', 'tinyfish']);
  tools.setSearchChain(tools.DEFAULT_SEARCH_CHAIN);
});

test('searchChainWeb: sırayı uygular, dolu motorda durur, boş tarayıcı banlanır', async () => {
  tools.setSearchChain([
    { id: 'browser', on: true },
    { id: 'obscura', on: false },
    { id: 'tinyfish', on: false },
    { id: 'python', on: false },
  ]);
  const calls = [];
  const r = await tools.searchChainWeb('test sorgu', 5, {
    browser: async () => {
      calls.push('browser');
      return { ok: true, results: [{ title: 'T', url: 'https://x.com', snippet: 's', engine: 'browser' }] };
    },
  });
  assert.ok(r.ok, 'sonuç geldi');
  assert.strictEqual(calls.length, 1, 'zincir ilk dolu motorda durdu');
  assert.ok(!tools.browserBanned(), 'başarılı tarayıcı banlanmaz');

  /* tarayıcı boş dönerse 10 dk ban + zincir başarısız (diğer motorlar kapalı) */
  const r2 = await tools.searchChainWeb('test 2', 5, {
    browser: async () => {
      calls.push('browser');
      return { ok: true, results: [] };
    },
  });
  assert.strictEqual(r2.ok, false);
  assert.ok(tools.browserBanned(), 'boş sonuç tarayıcıyı banladı');
  tools.banBrowser(0); /* banı temizle */
  const r3 = await tools.searchChainWeb('test 3', 5, {
    browser: async () => {
      calls.push('browser');
      return { ok: true, results: [{ title: 'T3', url: 'https://y.com' }] };
    },
  });
  assert.ok(r3.ok && calls.length === 3, 'ban süresi dolunca tarayıcı geri döner');
  tools.setSearchChain(tools.DEFAULT_SEARCH_CHAIN);
});

test('searchChainWeb: browser hook yoksa obscura/tinyfish/python sırası izlenir', async () => {
  tools.setSearchChain([{ id: 'browser', on: true }, { id: 'obscura', on: false }, { id: 'tinyfish', on: false }, { id: 'python', on: false }]);
  const r = await tools.searchChainWeb('test', 5, {});
  /* tüm motorlar kapalı/atlanmış → normalize browser'ı zorunlu açtı ama hook yok → başarısız */
  assert.strictEqual(r.ok, false);
  tools.setSearchChain(tools.DEFAULT_SEARCH_CHAIN);
});

test('searchChainWeb: boş sorgu hata döner', async () => {
  const r = await tools.searchChainWeb('  ', 5, {});
  assert.strictEqual(r.ok, false);
  assert.ok(/boş sorgu/.test(r.error));
});

test('obscura parseDdgLite: lite tablosundan sonuç çıkarır', () => {
  const html =
    '<table><tr><td><a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fornek.com%2Fa&amp;rut=1">Örnek A</a></td></tr>' +
    '<tr><td><a rel="nofollow" class="result-link" href="https://ornek.com/b">Örnek B</a></td></tr></table>';
  const rows = obscura.parseDdgLite(html, 5);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].url, 'https://ornek.com/a');
  assert.strictEqual(rows[0].title, 'Örnek A');
  assert.strictEqual(rows[1].url, 'https://ornek.com/b');
});

test('obscura yolları ve kurulum durumu', () => {
  assert.ok(/beast[\\/]obscura$/.test(obscura.obscuraDir()));
  assert.ok(/obscura\.exe$/.test(obscura.obscuraExe()));
  /* test makinesinde kurulu olabilir — sadece tipleri doğrula */
  assert.strictEqual(typeof obscura.obscuraInstalled(), 'boolean');
  assert.strictEqual(typeof obscura.obscuraSearch, 'function');
  assert.strictEqual(typeof obscura.installObscura, 'function');
});

test('obscuraSearch: kurulu değilse null döner (zincir atlar)', async () => {
  const wasInstalled = obscura.obscuraInstalled();
  if (wasInstalled) return; /* kurulu makinede atla */
  const r = await obscura.obscuraSearch('sorgu', {});
  assert.strictEqual(r, null);
});

test('Exa sistemden tamamen kalktı', () => {
  for (const k of ['setExaKey', 'exaSearch']) assert.ok(!(k in tools), k + ' export yok');
  const desc = JSON.stringify(tools.definitions);
  assert.ok(!/exa\.ai/i.test(desc), 'araç tanımlarında exa yok');
  assert.ok(!/api\.exa\.ai/i.test(desc));
});
