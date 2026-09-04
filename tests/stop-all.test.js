'use strict';

/* GEÇİCİ REPRO: /stop (stopAll) akan LLM akışını gerçekten kesiyor mu? */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Engine } = require('../src/agent/engine');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-stop-'));
  const events = [];
  const eng = new Engine(
    { chain: [], defaultSelection: null },
    {
      sessionsDir: dir,
      emit: (ev) => events.push(ev),
    }
  );
  return { eng, events, dir };
}

function slowSseFetch(tokens, gapMs) {
  const realFetch = globalThis.fetch;
  let aborted = false;
  const fn = async (url, opts = {}) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(c) {
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            aborted = true;
            try { c.error(new Error('The operation was aborted')); } catch {}
          }, { once: true });
        }
        for (const t of tokens) {
          if (aborted) return;
          const chunk =
            'data: {"choices":[{"delta":{"content":' + JSON.stringify(t) + '}}]}\n\n';
          c.enqueue(enc.encode(chunk));
          await sleep(gapMs);
        }
        c.enqueue(enc.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        c.close();
      },
      cancel() { aborted = true; },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  fn.restore = () => { globalThis.fetch = realFetch; };
  fn.wasAborted = () => aborted;
  globalThis.fetch = fn;
  return fn;
}

test('stopAll: akan ana oturum turunu keser — token akışı durur', async () => {
  const { eng, events } = tmpEngine();
  eng.sel = { providerId: 'pA', providerName: 'ProvA', model: 'm1', sel: 'pA::m1', url: 'http://t/v1', key: 'k' };

  const fetchMock = slowSseFetch(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 200);
  try {
    const sess = eng.createSession();
    const ok = eng.send(sess.id, 'uzun bir cevap üret');
    assert.ok(ok, 'send başlamalı');

    /* sabit sleep yerine ilk token bekle — yüklü makinede 450ms yetmeyebiliyor */
    let tokensBefore = 0;
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      tokensBefore = events.filter((e) => e.type === 'token').length;
      if (tokensBefore >= 1) break;
    }
    assert.ok(tokensBefore >= 1, 'abort öncesi token gelmeli: ' + tokensBefore);

    const n = eng.stopAll();
    assert.ok(n >= 1, 'en az 1 iş kesilmeli: ' + n);

    /* abort sonrası akış bitmeli + finally ctrls'i temizlemeli — poll ile bekle */
    let ctrlsLeft = eng.ctrls.size;
    for (let i = 0; i < 50 && (ctrlsLeft = eng.ctrls.size) > 0; i++) await sleep(100);
    assert.ok(ctrlsLeft === 0, 'ctrls temizlenmeli, kaldı: ' + ctrlsLeft);
    const tokensAfter = events.filter((e) => e.type === 'token').length;
    const doneEv = events.find((e) => e.type === 'done');

    assert.ok(tokensAfter <= tokensBefore + 1, 'abort sonrası token AKMAMALI (before=' + tokensBefore + ' after=' + tokensAfter + ')');
    assert.ok(doneEv, 'done eventi gelmeli');
    assert.ok(doneEv.aborted, 'done aborted olmalı');
    await sleep(100);
  } finally {
    fetchMock.restore();
  }
});

test('stopAll: stop kapısı sistem gönderimlerini bloklar, kullanıcı mesajı açar', async () => {
  const { eng, events } = tmpEngine();
  eng.sel = { providerId: 'pA', providerName: 'ProvA', model: 'm1', sel: 'pA::m1', url: 'http://t/v1', key: 'k' };
  const sess = eng.createSession();

  eng.stopAll();
  assert.ok(eng._stopped, 'kapı kapalı');

  /* 1) sistem tetikli gönderim (iptal raporu gibi) AKMAZ */
  const blocked = eng.send(sess.id, { text: '[ARKA PLAN İPTAL: x] Sebep: /stop' });
  assert.strictEqual(blocked, false, 'sistem gönderimi engellenmeli');
  assert.ok(!events.some((e) => e.type === 'message'), 'engellenen mesaj olaylara düşmemeli');

  /* 2) pendingReports /stop'ta düşürülür — ebeveynde yeni tur başlamaz */
  eng._pendingReports = [{ parentId: sess.id, text: '[ARKA PLAN İPTAL: y] Sebep: /stop' }];
  eng.flushPendingReports(sess.id);
  assert.strictEqual(eng._pendingReports.length, 0, 'raporlar düşürülmeli');
  assert.ok(!eng.ctrls.has(sess.id), 'yeni tur açılmamalı');

  /* 3) gerçek kullanıcı mesajı kapıyı açar ve tur başlar */
  const fetchMock = slowSseFetch(['ok'], 50);
  try {
    const resumed = eng.send(sess.id, 'devam et', { userAction: true });
    assert.ok(resumed, 'kullanıcı mesajı turu başlatmalı');
    assert.ok(!eng._stopped, 'kapı açılmalı');
    await sleep(300);
  } finally {
    fetchMock.restore();
  }
});

test('stopAll: arka plan işi bitince ebeveyne İPTAL raporu sorgusu başlatmaz', async () => {
  const { eng, events } = tmpEngine();
  eng.sel = { providerId: 'pA', providerName: 'ProvA', model: 'm1', sel: 'pA::m1', url: 'http://t/v1', key: 'k' };
  const parent = eng.createSession();

  /* sahte koşan bg işi: ctrl + running kaydı */
  const bgId = 'bg-test-1';
  eng.ctrls.set(bgId, new AbortController());
  eng._bgJobs.set(bgId, {
    id: bgId, code: 'BG1', title: 'İş', task: 'görev', agent: null,
    parentId: parent.id, groupId: null, status: 'running', slot: true,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    lastNudgeAt: null, checks: 0, fixes: 0, endedAt: null, error: null, revive: false,
  });

  eng.stopAll();
  assert.ok(eng.ctrls.get(bgId).signal.aborted, 'bg ctrl abort edilmeli');

  /* abort → _run catch yolu _bgFinish('aborted') çağırır; rapor ebeveyne
     send() ile YENİ TUR açmadan düşmeli (kapı yüzünden zaten düşer) */
  eng._bgFinish(bgId, 'aborted', '/stop: kullanıcı durdurdu');
  await sleep(50);
  assert.strictEqual(eng._bgJobs.get(bgId).status, 'aborted', 'iş aborted olmalı');
  assert.ok(!eng.ctrls.has(parent.id), 'ebeveynde YENİ TUR AÇILMAMALI');
  assert.ok(
    !events.some((e) => e.sessionId === parent.id && e.type === 'message'),
    'ebeveyne sorgu mesajı düşmemeli'
  );
});
