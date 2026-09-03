'use strict';

/* SearXNG motor testleri: sonuç ayrıştırma + ayakta-değilse zincir atlama */

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const searxng = require('../src/agent/searxng');
const tools = require('../src/agent/tools');

test('searxng search: ayaktaysa sonuçları ayrıştırır (content→snippet, boş elenir)', async () => {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('format=json')) {
      return {
        ok: true,
        json: async () => ({
          results: [
            { title: 'Ankara', url: 'https://ornek.com/ankara', content: 'başkent bilgisi' },
            { title: '', url: 'https://bos.com' },
            { title: 'İkinci', url: 'https://ornek.com/2', content: 'detay' },
          ],
        }),
      };
    }
    throw new Error('beklenmeyen url: ' + u);
  };
  try {
    searxng.resetProbeCache();
    const r = await searxng.search('ankara', { maxResults: 3 });
    assert.ok(r && r.ok);
    assert.equal(r.engine, 'searxng');
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].snippet, 'başkent bilgisi');
    assert.equal(r.results[0].url, 'https://ornek.com/ankara');
  } finally {
    global.fetch = orig;
    searxng.resetProbeCache();
  }
});

test('searxng search: ayakta değilse null döner (zincir sıradaki motora geçer)', async () => {
  const orig = global.fetch;
  global.fetch = async () => {
    throw new Error('down');
  };
  try {
    searxng.resetProbeCache();
    const r = await searxng.search('test', { maxResults: 3 });
    assert.equal(r, null);
  } finally {
    global.fetch = orig;
    searxng.resetProbeCache();
  }
});

test('arama zinciri searxng motorunu içerir', () => {
  assert.ok(tools.SEARCH_ENGINE_IDS.includes('searxng'));
  assert.ok(tools.getSearchChain().some((x) => x.id === 'searxng'));
});
