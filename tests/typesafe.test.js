'use strict';

/* TypeSafe (System One / Jev) adaptör testleri:
   - normalizeQuestions doğrulaması
   - anahtar yokken anlaşılır hata (systemOne + handler + tools.exec)
   - fetch sahtelenerek istek gövdesi ve yanıt normalizasyonu */

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const typesafe = require('../src/agent/typesafe');
const tools = require('../src/agent/tools');

test('typesafe: normalizeQuestions tipleri doğrular', () => {
  const q = typesafe.normalizeQuestions({
    is_urgent: { type: 'noul', instructions: 'Acil mi?' },
    route: { type: 'choice', instructions: 'Hangi kuyruk?', criteria: { a: null, b: 'B' } },
    kalite: { type: 'score', instructions: 'Kalite?', criteria: ['zayıf', 'iyi'] },
  });
  assert.deepEqual(Object.keys(q), ['is_urgent', 'route', 'kalite']);
  assert.equal(q.route.criteria.a, null);
  assert.throws(() => typesafe.normalizeQuestions({ x: { type: 'foo', instructions: '?' } }), /noul\|choice\|score/);
  assert.throws(() => typesafe.normalizeQuestions({ x: { type: 'score', instructions: '?', criteria: ['tek'] } }), /en az 2/);
  assert.throws(() => typesafe.normalizeQuestions({ x: { type: 'choice', instructions: '?', criteria: [] } }), /criteria/);
  assert.throws(() => typesafe.normalizeQuestions({}), /boş/);
});

test('typesafe: anahtar yokken systemOne ve handler anlaşılır hata verir', async () => {
  typesafe.setConfig(() => ({ apiKey: '', model: 'jev-latest' }));
  await assert.rejects(
    () => typesafe.systemOne({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } } }),
    /API anahtarı/
  );
  const r = await typesafe.handlers.typesafe_decision({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } } }, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /TypeSafe API anahtarı yok/);
});

test('typesafe: boş state/geçersiz questions handler hatası döner (anahtar varken)', async () => {
  typesafe.setConfig(() => ({ apiKey: 'k', model: 'jev-latest' }));
  try {
    const a = await typesafe.handlers.typesafe_decision({ state: '   ', questions: { q: { type: 'noul', instructions: '?' } } }, {});
    assert.equal(a.ok, false);
    assert.match(a.error, /state/);
    const b = await typesafe.handlers.typesafe_decision({ state: 'x', questions: {} }, {});
    assert.equal(b.ok, false);
    assert.match(b.error, /boş/);
  } finally {
    typesafe.setConfig(() => ({ apiKey: '', model: 'jev-latest' }));
  }
});

test('typesafe: tools.exec üzerinden handler çalışır + tanım kayıtlı', async () => {
  const names = tools.definitions.map((d) => d.function.name);
  assert.ok(names.includes('typesafe_decision'), 'typesafe_decision tanımı tools.definitions içinde olmalı');
  const raw = await tools.exec(
    'typesafe_decision',
    { state: 'x', questions: { q: { type: 'noul', instructions: '?' } } },
    { cwd: process.cwd() }
  );
  const r = JSON.parse(raw);
  assert.equal(r.ok, false);
  assert.match(r.error, /TypeSafe/);
});

test('typesafe: systemOne istek gövdesi + yanıt normalizasyonu (fetch sahtelenir)', async () => {
  const orig = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url: String(url), opts };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'jev-latest',
        answers: { q: { type: 'noul', noul: 0.72 } },
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    };
  };
  try {
    typesafe.setConfig(() => ({ apiKey: 'test-key', model: 'jev-1.13' }));
    const r = await typesafe.systemOne({ state: { x: 1 }, questions: { q: { type: 'noul', instructions: 'X mi?' } } });
    assert.equal(r.answers.q.noul, 0.72);
    assert.equal(r.usage.output_tokens, 2);
    assert.equal(captured.url, typesafe.BASE_URL + '/v1/systemone');
    assert.equal(captured.opts.headers.authorization, 'Bearer test-key');
    const body = JSON.parse(captured.opts.body);
    assert.equal(body.model, 'jev-1.13');
    assert.deepEqual(body.state, { x: 1 });
    assert.equal(body.questions.q.type, 'noul');
    /* model argümanı verilirse o kazanır */
    const r2 = await typesafe.systemOne({ state: 'y', questions: { q: { type: 'noul', instructions: '?' } }, model: 'jev-latest' });
    assert.equal(JSON.parse(captured.opts.body).model, 'jev-latest');
    assert.ok(r2.model);
  } finally {
    global.fetch = orig;
    typesafe.setConfig(() => ({ apiKey: '', model: 'jev-latest' }));
  }
});

test('typesafe: HTTP 401 hata metni anahtar yönlendirmesi içerir', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => 'unauthorized',
  });
  try {
    typesafe.setConfig(() => ({ apiKey: 'bad', model: 'jev-latest' }));
    await assert.rejects(
      () => typesafe.systemOne({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } } }),
      /anahtarı geçersiz/
    );
  } finally {
    global.fetch = orig;
    typesafe.setConfig(() => ({ apiKey: '', model: 'jev-latest' }));
  }
});
