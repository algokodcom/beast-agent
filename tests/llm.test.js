'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const { withRetries, friendlyError, sumUsage, chatStreamAuto } = require('../src/agent/llm');

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

test('sumUsage: sayısal alanları toplar (devam turu faturalaması)', () => {
  const u = sumUsage(
    { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }
  );
  assert.deepEqual(u, { prompt_tokens: 18, completion_tokens: 8, total_tokens: 26 });
  assert.equal(sumUsage(null, { total_tokens: 3 }).total_tokens, 3);
  assert.equal(sumUsage({ total_tokens: 7 }, null).total_tokens, 7);
});

/* SSE mock sunucusu: finish_reason=length → otomatik devam turu açılır */
function sseServer(script) {
  const http = require('node:http');
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push(JSON.parse(body).messages);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const ev of script(calls.length, calls[calls.length - 1])) res.write(ev);
      res.end();
    });
  });
  return { srv, calls };
}

test('chatStreamAuto: length kesintisinde kaldığı yerden devam eder', async () => {
  const { srv, calls } = sseServer((n) => {
    if (n === 1) {
      return [
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Merhaba dun' } }] }) + '\n\n',
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ya basladi' }, finish_reason: 'length' }] }) + '\n\n',
        'data: [DONE]\n\n',
      ];
    }
    return [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'yor devam' } }] }) + '\n\n',
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n',
      'data: [DONE]\n\n',
    ];
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const sel = { url: `http://127.0.0.1:${port}/v1/chat/completions`, key: 'k', model: 'm' };
    const deltas = [];
    const r = await chatStreamAuto(sel, { messages: [{ role: 'user', content: 'selam' }] }, { onDelta: (d) => deltas.push(d) });
    assert.equal(r.content, 'Merhaba dunya basladiyor devam');
    assert.equal(r.finishReason, 'stop');
    assert.equal(calls.length, 2);
    // 2. turda devam mesajları eklenmiş olmalı (orijinal dizi kopyalanır)
    const m2 = calls[1];
    assert.equal(m2[m2.length - 2].role, 'assistant');
    assert.equal(m2[m2.length - 1].role, 'user');
    assert.match(m2[m2.length - 1].content, /DEVAM/);
    // streaming kesintisiz: 3 delta
    assert.deepEqual(deltas.join(''), r.content);
  } finally {
    srv.close();
  }
});

test('chatStreamAuto: normal (stop) yanıtta hiç devam turu açılmaz', async () => {
  const { srv, calls } = sseServer(() => [
    'data: ' + JSON.stringify({ choices: [{ delta: { content: 'tam cevap' }, finish_reason: 'stop' }] }) + '\n\n',
    'data: [DONE]\n\n',
  ]);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const sel = { url: `http://127.0.0.1:${port}/v1/chat/completions`, key: 'k', model: 'm' };
    const r = await chatStreamAuto(sel, { messages: [{ role: 'user', content: 'selam' }] });
    assert.equal(r.content, 'tam cevap');
    assert.equal(calls.length, 1);
  } finally {
    srv.close();
  }
});
