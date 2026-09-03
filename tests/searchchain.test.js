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
