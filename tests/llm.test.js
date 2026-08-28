'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const { withRetries, friendlyError } = require('../src/agent/llm');

test('withRetries: 503 sonrası başarılı isteği tekrarlar', async () => {
  let calls = 0;
  const r = await withRetries(
    async () => {
      calls++;
      if (calls < 3) {
        const e = new Error('HTTP 503');
        e.status = 503;
        throw e;
      }
      return 'ok';
    },
    { onRetry: () => {} }
  );
  assert.equal(r, 'ok');
  assert.equal(calls, 3);
});

test('withRetries: 400 gibi kalıcı hata beklemeksizin fırlatır', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetries(async () => {
        calls++;
        const e = new Error('HTTP 400');
        e.status = 400;
        throw e;
      }),
    /400/
  );
  assert.equal(calls, 1);
});

test('withRetries: ağ hatası (status yok) tekrarlanır', async () => {
  let calls = 0;
  const r = await withRetries(async () => {
    calls++;
    if (calls === 1) throw new Error('fetch failed');
    return 'ok';
  });
  assert.equal(r, 'ok');
  assert.equal(calls, 2);
});

test('friendlyError ipuçları içerir', () => {
  const m = friendlyError(503, 'Service Unavailable', '{"error":"x"}');
  assert.match(m, /kullanılamıyor/);
  assert.match(m, /model seçici/);
});
