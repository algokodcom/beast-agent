'use strict';

/* OPENCODE STEER PORTU: koşan tur sırasında gelen mesaj konuşmaya DAHİL edilir,
   koşan tur sonraki istekte görür ve cevaplar; eski cevap akışı bozulmaz. */

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Engine } = require('../src/agent/engine');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-steer-'));
  const events = [];
  const eng = new Engine(
    { chain: [], defaultSelection: null },
    {
      sessionsDir: dir,
      emit: (ev) => events.push(ev),
    }
  );
  eng.sel = { providerId: 'pA', providerName: 'ProvA', model: 'm1', sel: 'pA::m1', url: 'http://t/v1', key: 'k' };
  return { eng, events, dir };
}

function sseFetch(calls) {
  /* calls: her fetch çağrısında { tokens, gapMs } — sırayla tüketilir */
  const realFetch = globalThis.fetch;
  let i = 0;
  const fn = async (url, opts = {}) => {
    const plan = calls[Math.min(i, calls.length - 1)];
    i++;
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(c) {
        for (const t of plan.tokens) {
          const chunk =
            'data: {"choices":[{"delta":{"content":' + JSON.stringify(t) + '}}]}\n\n';
          c.enqueue(enc.encode(chunk));
          if (plan.gapMs) await sleep(plan.gapMs);
        }
        c.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  fn.restore = () => { globalThis.fetch = realFetch; };
  fn.count = () => i;
  globalThis.fetch = fn;
  return fn;
}

test('steer: meşgulken gelen mesaj konuşmaya eklenir ve koşan tur sonraki istekte görür', async () => {
  const { eng, events } = tmpEngine();
  /* 1. çağrı: YAVAŞ akış (tur ortasında steer penceresi) — 2. çağrı: hızlı cevap */
  const fetchMock = sseFetch([
    { tokens: ['a', 'b', 'c', 'd', 'e', 'f'], gapMs: 120 },
    { tokens: ['steer-cevabi'], gapMs: 0 },
  ]);
  try {
    const sess = eng.createSession();
    const ok1 = eng.send(sess.id, 'ilk iş');
    assert.ok(ok1, 'ilk send başlamalı');
    await sleep(260); /* tur 1 ortasında bekle */
    assert.ok(eng.isBusy(sess.id), 'tur hâlâ koşuyor olmalı');

    const ok2 = eng.send(sess.id, 'ikinci mesaj — bunu da yap');
    assert.ok(ok2, 'meşgulken send STEER olmalı (false değil)');

    /* işin bitmesini bekle */
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'done'); i++) await sleep(100);
    const dones = events.filter((e) => e.type === 'done');
    assert.equal(dones.length, 1, 'tek done — eski cevap akışı bölünmedi');

    const s = eng.openSession(sess.id);
    assert.equal(s.messages.length, 4, 'user1 + cevap1 + steer + cevap2');
    assert.equal(s.messages[0].role, 'user');
    assert.equal(s.messages[1].role, 'assistant');
    assert.equal(s.messages[2].role, 'user');
    assert.equal(s.messages[3].role, 'assistant');
    assert.ok(
      String(s.messages[3].content || '').includes('steer-cevabi'),
      'ikinci cevap steer mesajına gelmeli'
    );
    /* steer mesajı geçmişte kalıcı olmalı */
    assert.equal(
      s.messages[2].content,
      'ikinci mesaj — bunu da yap'
    );
  } finally {
    fetchMock.restore();
  }
});

test('steer: hızlı ardışık iki mesaj meşgulken TEK user mesajında birleşir', async () => {
  const { eng, events } = tmpEngine();
  const fetchMock = sseFetch([
    { tokens: ['x', 'y', 'z'], gapMs: 120 },
    { tokens: ['ok'], gapMs: 0 },
  ]);
  try {
    const sess = eng.createSession();
    eng.send(sess.id, 'uzun iş');
    await sleep(200);
    assert.ok(eng.isBusy(sess.id));
    eng.send(sess.id, 'ek-1');
    eng.send(sess.id, 'ek-2'); /* son user mesajı user olduğundan birleşir */

    for (let i = 0; i < 100 && !events.some((e) => e.type === 'done'); i++) await sleep(100);
    const s = eng.openSession(sess.id);
    const userMsgs = s.messages.filter((m) => m.role === 'user');
    assert.equal(userMsgs.length, 2, 'user1 + birleşmiş steer');
    assert.ok(
      String(userMsgs[1].content || '').includes('ek-1') &&
        String(userMsgs[1].content || '').includes('ek-2'),
      'iki steer tek mesajda birleşmeli'
    );
  } finally {
    fetchMock.restore();
  }
});
