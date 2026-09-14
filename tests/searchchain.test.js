'use strict';

/* Arama zinciri testleri (eski obscura.test.js'in zincir kısmı — obscura kaldırıldı,
   zincir: searxng → stealth → browser → tinyfish → python) */

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const tools = require('../src/agent/tools');

test('varsayılan zincir: 5 motor, hepsi açık, searxng İLK SIRADA', () => {
  const c = tools.getSearchChain();
  assert.deepEqual(c.map((x) => x.id), ['searxng', 'stealth', 'browser', 'tinyfish', 'python']);
  for (const r of c) assert.strictEqual(r.on, true, r.id + ' varsayılan açık');
});

test('setSearchChain: sıra yeniden düzenlenir, eksik motorlar sona eklenir (açık)', () => {
  const c = tools.setSearchChain([
    { id: 'browser', on: true },
    { id: 'python', on: true },
    { id: 'tinyfish', on: false },
  ]);
  assert.deepEqual(c.map((x) => x.id), ['browser', 'python', 'tinyfish', 'searxng', 'stealth']);
  assert.strictEqual(c.find((x) => x.id === 'tinyfish').on, false);
  assert.strictEqual(c.find((x) => x.id === 'searxng').on, true, 'listede olmayan motor varsayılan açık');
  tools.setSearchChain(tools.DEFAULT_SEARCH_CHAIN); /* testler arası temizlik */
});

test('setSearchChain: hepsi kapalıysa tarayıcı zorunlu açılır (zincir boş kalmasın)', () => {
  const c = tools.setSearchChain(['searxng', 'stealth', 'tinyfish', 'python', 'browser'].map((id) => ({ id, on: false })));
  assert.strictEqual(c.find((x) => x.id === 'browser').on, true);
  tools.setSearchChain(tools.DEFAULT_SEARCH_CHAIN);
});

test('setSearchChain: bilinmeyen id (eski obscura dahil) elenir', () => {
  const c = tools.setSearchChain([
    { id: 'exa', on: true },
    { id: 'obscura' }, /* kaldırılan motor — sessizce düşmeli */
    { id: 'browser', on: false },
    'python',
  ]);
  assert.deepEqual(c.map((x) => x.id), ['browser', 'python', 'searxng', 'stealth', 'tinyfish']);
  tools.setSearchChain(tools.DEFAULT_SEARCH_CHAIN);
});

test('arama zinciri: tarayıcı geçici hatada 1 dk, gerçek CAPTCHA engelinde 10 dk askıya alınır', async () => {
  const only = [
    { id: 'browser', on: true },
    { id: 'searxng', on: false },
    { id: 'stealth', on: false },
    { id: 'tinyfish', on: false },
    { id: 'python', on: false },
  ];
  tools.setSearchChain(only);

  /* geçici hata: null dönüş — uzun ban OLMAMALI */
  tools.banBrowser(0);
  await tools.searchChainWeb('test-sorgu', 3, { browser: async () => null });
  const transient = tools.browserBanRemainingMs();
  assert.ok(transient > 0 && transient <= 61000, 'geçici hata kısa askı: ' + transient + ' ms');

  /* GERÇEK engel: blocked:true — 10 dk ban */
  tools.banBrowser(0);
  await tools.searchChainWeb('test-sorgu', 3, { browser: async () => ({ ok: false, blocked: true }) });
  const blocked = tools.browserBanRemainingMs();
  assert.ok(blocked > 5 * 60 * 1000, 'CAPTCHA uzun askı: ' + blocked + ' ms');

  tools.banBrowser(0);
  tools.setSearchChain(tools.DEFAULT_SEARCH_CHAIN);
});
