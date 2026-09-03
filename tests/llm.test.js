'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { withRetries, friendlyError, sumUsage, chatStreamAuto, setNetProbe, isNetworkError, chatStream, chatOnce, capsFor, resetCaps, setCapsFile } = require('../src/agent/llm');

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

/* ---------- ağ kopması dayanıklılığı (#retry) ---------- */

test('isNetworkError sınıflandırması', () => {
  const net = new Error('fetch failed');
  assert.equal(isNetworkError(net), true, 'status yok → ağ hatası');
  const http = new Error('HTTP 503');
  http.status = 503;
  assert.equal(isNetworkError(http), false, 'status var → HTTP hatası');
  const abort = new Error('iptal');
  abort.name = 'AbortError';
  assert.equal(isNetworkError(abort), false, 'abort ağ hatası sayılmaz');
  assert.equal(isNetworkError(null), false);
});

test('withRetries: internet kapalıyken probe bekler, dönünce başarır', async () => {
  let online = false;
  setNetProbe(() => online);
  setTimeout(() => { online = true; }, 30);
  let calls = 0;
  const t0 = Date.now();
  const r = await withRetries(async () => {
    calls++;
    if (calls === 1) throw new Error('fetch failed');
    return 'ok';
  });
  assert.equal(r, 'ok');
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 > 2000, 'probe çevrimdışı dediği için bekledi');
  setNetProbe(null);
});

test('akış ortasında bağlantı koparsa: kısmi metinle devam turu açılır (hata balonu yok)', async () => {
  const http = require('node:http');
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push(JSON.parse(body).messages);
      if (calls.length === 1) {
        /* birkaç delta yaz, sonra soketi ORTADAN kopar */
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Merhaba du' } }] }) + '\n\n');
        setTimeout(() => res.destroy(), 30);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'nya devam' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const sel = { url: `http://127.0.0.1:${port}/v1/chat/completions`, key: 'k', model: 'm' };
    const r = await chatStreamAuto(sel, { messages: [{ role: 'user', content: 'selam' }] });
    assert.equal(r.content, 'Merhaba dunya devam', 'kısmi + devam birleşti');
    assert.equal(r.finishReason, 'stop');
    assert.equal(calls.length, 2, 'devam turu açıldı');
    const m2 = calls[1];
    assert.equal(m2[m2.length - 2].role, 'assistant');
    assert.match(m2[m2.length - 1].content, /DEVAM/);
  } finally {
    srv.close();
  }
});

/* ---------- model yetenek keşfi: 400 → seviye/parametre otomatik uyum ---------- */

function capsServer(handler) {
  const http = require('node:http');
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      bodies.push(parsed);
      handler(parsed, res);
    });
  });
  return { srv, bodies };
}

function sseOk(res, content) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

function bad400(res, message) {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: '400', message, type: 'BadRequestError' } }));
}

test('otomatik reasoning: reddedilen seviyede bir alt seviye denenir ve KALICI öğrenilir (Mimo senaryosu)', async () => {
  resetCaps();
  const REJECT = new Set(['max', 'xhigh', 'high', 'medium']); /* Mimo 2.5: low çalışıyor */
  const { srv, bodies } = capsServer((parsed, res) => {
    const eff = parsed.reasoning_effort;
    if (eff && REJECT.has(eff)) return bad400(res, 'Invalid request parameters');
    sseOk(res, 'ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const sel = { url: `http://127.0.0.1:${port}/v1/chat/completions`, key: 'k', model: 'mimo-2.5', providerId: 'custom:mimo' };
    const downs = [];
    const r = await chatStream(
      sel,
      { messages: [{ role: 'user', content: 'selam' }], reasoningEffort: 'max' },
      { onEffortDowngrade: (f, t) => downs.push(f + '>' + t) }
    );
    assert.equal(r.content, 'ok');
    /* max → xhigh → high → medium → low merdiveni birer birer denendi */
    assert.deepEqual(bodies.map((b) => b.reasoning_effort), ['max', 'xhigh', 'high', 'medium', 'low']);
    assert.deepEqual(downs, ['max>xhigh', 'xhigh>high', 'high>medium', 'medium>low']);
    const caps = capsFor(sel);
    assert.deepEqual([...caps.failedEfforts].sort(), ['high', 'max', 'medium', 'xhigh']);
    assert.equal(caps.noReasoning, undefined, 'low çalıştığı için parametre bırakılmaz');
    /* İKİNCİ çağrı: 'max' seçili olsa bile otomatik 'low' gönderilir — tek istek */
    const r2 = await chatStream(sel, { messages: [{ role: 'user', content: 'selam' }], reasoningEffort: 'max' });
    assert.equal(r2.content, 'ok');
    assert.equal(bodies.length, 6);
    assert.equal(bodies[5].reasoning_effort, 'low');
  } finally {
    srv.close();
  }
});

test('reasoning_effort hiç desteklenmiyorsa (ipuçlu 400) parametre bırakılır ve kalıcı öğrenilir', async () => {
  resetCaps();
  const { srv, bodies } = capsServer((parsed, res) => {
    if (parsed.reasoning_effort) return bad400(res, "reasoning_effort is not supported by this model");
    sseOk(res, 'ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const sel = { url: `http://127.0.0.1:${port}/v1/chat/completions`, key: 'k', model: 'mimo-v1', providerId: 'custom:mimo' };
    const drops = [];
    const r = await chatStream(
      sel,
      { messages: [{ role: 'user', content: 'selam' }], reasoningEffort: 'high' },
      { onParamDrop: (p) => drops.push(p) }
    );
    assert.equal(r.content, 'ok');
    assert.deepEqual(drops, ['noReasoning']);
    assert.equal(capsFor(sel).noReasoning, true);
    /* sonraki çağrıda parametre hiç gönderilmez */
    await chatStream(sel, { messages: [{ role: 'user', content: 'selam' }], reasoningEffort: 'high' });
    assert.equal(bodies.length, 3);
    assert.equal('reasoning_effort' in bodies[2], false);
  } finally {
    srv.close();
  }
});

test('chatOnce: temperature reddedilirse atlanır ve kalıcı öğrenilir', async () => {
  resetCaps();
  const { srv, bodies } = capsServer((parsed, res) => {
    if ('temperature' in parsed) return bad400(res, "temperature is not supported with this model");
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'tamam' }, finish_reason: 'stop' }] }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const sel = { url: `http://127.0.0.1:${port}/v1/chat/completions`, key: 'k', model: 'gpt-5-benzeri', providerId: 'custom:x' };
    const drops = [];
    const r = await chatOnce(
      sel,
      { messages: [{ role: 'user', content: 'selam' }], temperature: 0.7 },
      { onParamDrop: (p) => drops.push(p) }
    );
    assert.equal(r.content, 'tamam');
    assert.deepEqual(drops, ['noTemperature']);
    assert.equal(capsFor(sel).noTemperature, true);
    await chatOnce(sel, { messages: [{ role: 'user', content: 'selam' }], temperature: 0.7 });
    assert.equal('temperature' in bodies[1], false);
  } finally {
    srv.close();
  }
});

test('ilgisiz 400 (context length) parametre düşülmeden aynen fırlatılır', async () => {
  resetCaps();
  const { srv, bodies } = capsServer((_parsed, res) => {
    bad400(res, "This model's maximum context length is 8192 tokens");
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    const sel = { url: `http://127.0.0.1:${port}/v1/chat/completions`, key: 'k', model: 'kucuk-baglam', providerId: 'custom:y' };
    await assert.rejects(
      () => chatStream(sel, { messages: [{ role: 'user', content: 'selam' }], reasoningEffort: 'high' }),
      /400/
    );
    assert.equal(bodies.length, 1, 'tek istek — sessiz retry YOK');
  } finally {
    srv.close();
  }
});

test('setCapsFile: öğrenilen yetenekler diske yazılır ve yeniden yüklenir', async () => {
  resetCaps();
  const os = require('node:os');
  const dir = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'beast-caps-'));
  const file = require('node:path').join(dir, 'model-caps.json');
  setCapsFile(file);
  try {
    const { srv } = capsServer((parsed, res) => {
      if (parsed.reasoning_effort) return bad400(res, 'reasoning_effort unsupported');
      sseOk(res, 'ok');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const port = srv.address().port;
      const sel = { url: `http://127.0.0.1:${port}/v1/chat/completions`, key: 'k', model: 'm', providerId: 'custom:z' };
      await chatStream(sel, { messages: [{ role: 'user', content: 'selam' }], reasoningEffort: 'low' });
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.models['custom:z::m'].noReasoning, true);
      /* taze yükleme: dosyadan geri okunur */
      resetCaps();
      setCapsFile(file);
      assert.equal(capsFor(sel).noReasoning, true);
    } finally {
      srv.close();
    }
  } finally {
    setCapsFile(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
