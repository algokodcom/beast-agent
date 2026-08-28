'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Engine } = require('../src/agent/engine');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* pA::m1 tek sağlayıcı + çökme kayıt dosyası olan motor */
function makeFalloutEngine({ fallout, emitEvents } = {}) {
  const sessionsDir = tmpDir('beast-fall-sess-');
  const workspace = tmpDir('beast-fall-ws-');
  const crashFile = path.join(tmpDir('beast-fall-crash-'), 'fallout-crash.json');
  const chainEntry = {
    providerId: 'pA',
    providerName: 'ProvA',
    model: 'm1',
    url: 'https://a.test/v1/chat/completions',
    key: 'keyA',
  };
  const cfg = { chain: [chainEntry], defaultSelection: { ...chainEntry } };
  const events = [];
  const eng = new Engine(cfg, {
    sessionsDir,
    workspace,
    crashFile,
    modelOverride: 'pA::m1',
    fallout,
    emit: (ev) => events.push(ev),
  });
  if (emitEvents) emitEvents(events);
  return { eng, crashFile, events };
}

test('fallout: bozuk slotlar elenir, en fazla 10 kalır', () => {
  const eng = makeFalloutEngine().eng;
  const norm = eng._normalizeFallout({
    enabled: true,
    slots: [
      null,
      { providerId: '', model: 'x', key: 'k' },
      { providerId: 'p', model: '', key: 'k' },
      { providerId: 'p', model: 'm', key: '' },
      { providerId: 'pA', providerName: 'ProvA', model: 'm1', key: 'k1' },
      ...Array.from({ length: 12 }, (_, i) => ({
        providerId: 'p' + i,
        providerName: 'P' + i,
        model: 'm',
        key: 'k',
      })),
    ],
  });
  assert.equal(norm.enabled, true);
  assert.equal(norm.chain.length, 10); // 1 geçerli + 11 aday ama sınır 10
  assert.deepEqual(norm.chain[0], { providerId: 'pA', providerName: 'ProvA', model: 'm1', key: 'k1' });
});

test('fallout: kapalıyken zincir boş döner', () => {
  const { eng } = makeFalloutEngine({
    fallout: { enabled: false, slots: [{ providerId: 'pA', model: 'm1', key: 'other' }] },
  });
  assert.deepEqual(eng._falloutSelections(eng.sel), []);
});

test('fallout: aynı provider+model farklı key ile listelenir, birebir aynı olan atlanır', () => {
  const { eng } = makeFalloutEngine({
    fallout: {
      enabled: true,
      slots: [
        { providerId: 'pA', providerName: 'ProvA', model: 'm1', key: 'keyA' }, // aktif ile aynı -> atla
        { providerId: 'pA', providerName: 'ProvA', model: 'm1', key: 'keyA2' }, // farklı key -> kalsın
        { providerId: 'yok', model: 'm9', key: 'k' }, // kayıtlı değil -> atla
      ],
    },
  });
  const sels = eng._falloutSelections(eng.sel);
  assert.equal(sels.length, 1);
  assert.equal(sels[0].url, 'https://a.test/v1/chat/completions'); // URL zincirden gelir
  assert.equal(sels[0].key, 'keyA2');
});

test('fallout: çökme kaydı yazılır ve silinir', () => {
  const { eng, crashFile } = makeFalloutEngine({});
  eng._saveCrash('sess1', new Error('patladı'), 'provider');
  assert.ok(fs.existsSync(crashFile));
  const st = JSON.parse(fs.readFileSync(crashFile, 'utf8'));
  assert.equal(st.sessionId, 'sess1');
  assert.match(st.error, /patladı/);
  assert.equal(st.phase, 'provider');
  eng._clearCrash();
  assert.ok(!fs.existsSync(crashFile));
});

function sseResponse(sseText) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(sseText));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const SSE_OK =
  'data: {"choices":[{"delta":{"content":"merhaba"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: [DONE]\n\n';

test('fallout: ilk sağlayıcı 401 çöker → zincirdeki sıradaki key ile devam eder', async () => {
  const { eng, crashFile, events } = makeFalloutEngine({
    fallout: {
      enabled: true,
      slots: [{ providerId: 'pA', providerName: 'ProvA', model: 'm1', key: 'keyYedek' }],
    },
  });

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), auth: opts.headers && opts.headers.Authorization });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'bad key' } }), {
        status: 401,
        statusText: 'Unauthorized',
      });
    }
    return sseResponse(SSE_OK);
  };
  try {
    const res = await eng._streamWithFallbacks(
      { id: 's1', messages: [{ role: 'user', content: 'selam' }] },
      [{ role: 'user', content: 'selam' }],
      [],
      null,
      () => {},
      eng.sel,
      false
    );
    assert.equal(res.content, 'merhaba');
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(calls.length, 2);
  assert.match(calls[0].auth, /keyA$/);
  assert.match(calls[1].auth, /keyYedek$/);
  // durumu kaydet adımı çalıştı
  assert.ok(fs.existsSync(crashFile), 'çökme kaydı yazılmalı');
  // durum mesajı Fallout geçişini haber verdi
  const st = events.find((e) => e.type === 'status' && /FALLOUT/.test(e.status));
  assert.ok(st, 'FALLOUT durum mesajı beklenirdi');
});

test('fallout: kapalıysa tek denemede hatayı fırlatır', async () => {
  const { eng } = makeFalloutEngine({ fallout: { enabled: false, slots: [] } });
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return new Response('{}', { status: 401, statusText: 'Unauthorized' });
  };
  try {
    await assert.rejects(
      () =>
        eng._streamWithFallbacks(
          { id: 's1', messages: [] },
          [{ role: 'user', content: 'x' }],
          [],
          null,
          () => {},
          eng.sel,
          false
        ),
      /HTTP 401/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(n, 1);
});
