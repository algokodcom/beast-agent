'use strict';

/* Jev Ultrafast (browser_agent) testleri:
   - actionSpace: click/fill aynı elementte birleşir, SELECT seçenekleri hedef olur
   - validateChoice: olasılık dağılımı doğrulaması
   - parseTextJson: metin yardımcısı JSON ayrıştırma (kod bloğu/çöp girdi)
   - run: sahte köprü ile uçtan uca döngü (CLICK → DONE, TYPE_TEXT → metin)
   - TypeSafe aç/kapa kapısı (unavailable) */

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const browseragent = require('../src/agent/browseragent');
const typesafe = require('../src/agent/typesafe');

function clickPage() {
  return {
    ok: true,
    url: 'https://example.com',
    title: 'Example',
    text: 'Example page',
    actions: [
      { ref: 1, kind: 'click', role: 'button', label: 'More information' },
      { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
    ],
  };
}

function answer(choice, probabilities, confidence) {
  return { type: 'choice', choice, probabilities, confidence };
}

test('browseragent: actionSpace elementleri birleştirir, SELECT hedefleri üretir', () => {
  const { elements, targets, controls } = browseragent.actionSpace([
    { ref: 7, kind: 'click', role: 'link', label: 'Hakkında → link' },
    { ref: 9, kind: 'fill', role: 'textbox', label: 'Ara', value: '' },
    { ref: 9, kind: 'click', role: 'textbox', label: 'Open Ara', value: '' },
    {
      ref: 4,
      kind: 'select',
      role: 'combobox',
      label: 'Kabin → Economy',
      value: 'eco',
      current_value: 'Business',
    },
    { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 },
    { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
  ]);
  assert.equal(elements.length, 3);
  assert.deepEqual(elements[1].operations.sort(), ['CLICK', 'TYPE_TEXT']);
  assert.equal(elements[2].value, 'Business');
  assert.equal(elements[2].options[0].index, '3:1');
  assert.equal(targets.SELECT['3:1'].value, 'eco');
  assert.equal(targets.CLICK['1'].label, 'Hakkında → link');
  assert.ok(controls.SCROLL_DOWN && controls.WAIT);
});

test('browseragent: validateChoice dağılımı doğrular', () => {
  const ids = ['CLICK', 'WAIT', 'DONE', 'BLOCKED'];
  browseragent.validateChoice(answer('CLICK', { CLICK: 0.7, WAIT: 0.2, DONE: 0.05, BLOCKED: 0.05 }, 0.9), ids);
  assert.throws(
    () => browseragent.validateChoice(answer('CLICK', { CLICK: 0.4, WAIT: 0.2, DONE: 0.05, BLOCKED: 0.05 }, 0.9), ids),
    /geçersiz/
  );
  assert.throws(
    () => browseragent.validateChoice(answer('CLICK', { CLICK: 0.7, WAIT: 0.3, DONE: 0.5, BLOCKED: 0.05 }, 0.9), ids),
    /geçersiz/
  );
  assert.throws(() => browseragent.validateChoice(answer('NOPE', { NOPE: 1 }, 1), ids), /geçersiz/);
});

test('browseragent: parseTextJson kod bloğu ve çöp girdiyi güvenli işler', () => {
  assert.equal(browseragent.parseTextJson('{"text": "Zurich"}'), 'Zurich');
  assert.equal(browseragent.parseTextJson('```json\n{"text": "Antalya"}\n```'), 'Antalya');
  assert.equal(browseragent.parseTextJson('işte: {"text": "London"} umarım olur'), 'London');
  assert.equal(browseragent.parseTextJson('{"text": null}'), null);
  assert.equal(browseragent.parseTextJson('{"text": "   "}'), null);
  assert.equal(browseragent.parseTextJson('cevap yok'), null);
});

test('browseragent: run CLICK → DONE akışını uçtan uca yürütür', async () => {
  const calls = [];
  const answers = [
    {
      model: 'jev-test',
      answers: {
        operation: answer('CLICK', { CLICK: 0.86, HOVER: 0.02, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02, PRESS: 0.02 }, 0.9),
        click_target: answer('1', { 1: 1 }, 1),
      },
    },
    {
      model: 'jev-test',
      answers: {
        operation: answer('DONE', { CLICK: 0.02, HOVER: 0.02, WAIT: 0.03, DONE: 0.89, BLOCKED: 0.02, PRESS: 0.02 }, 0.93),
      },
    },
  ];
  const result = await browseragent.run(
    {
      observe: async () => clickPage(),
      act: async (kind, a) => {
        calls.push({ kind, ...a });
        return { ok: true, changed: true };
      },
      wait: async () => ({ ok: true }),
      systemOne: async () => answers.shift(),
      textLlm: async () => '{"text": "x"}',
      emit: () => {},
    },
    { goal: 'More information aç' }
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'click');
  assert.equal(calls[0].ref, 1);
  assert.equal(calls[0].fast, true, 'Jev hızlı yolu kullanılmalı');
  assert.equal(calls[0].trusted, true, 'gerçek girdi istenmeli');
  assert.deepEqual(calls[0].expect, { url: 'https://example.com' });
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].operation, 'CLICK');
  assert.match(result.note, /KANIT DEĞİL/);
});

test('browseragent: PRESS Escape ile modal/popup kapatır', async () => {
  const calls = [];
  const answers = [
    {
      model: 'jev-test',
      answers: {
        operation: answer('PRESS', { CLICK: 0.1, HOVER: 0.01, WAIT: 0.05, DONE: 0.02, BLOCKED: 0.03, PRESS: 0.79 }, 0.8),
      },
    },
    {
      model: 'jev-test',
      answers: {
        operation: answer('DONE', { CLICK: 0.02, HOVER: 0.01, WAIT: 0.03, DONE: 0.91, BLOCKED: 0.01, PRESS: 0.02 }, 0.92),
      },
    },
  ];
  const result = await browseragent.run(
    {
      observe: async () => clickPage(),
      act: async (kind, a) => {
        calls.push({ kind, ...a });
        return { ok: true, changed: false };
      },
      wait: async () => ({ ok: true }),
      systemOne: async () => answers.shift(),
      textLlm: async () => '',
      emit: () => {},
    },
    { goal: 'açık modalı kapat', max_steps: 4 }
  );
  assert.equal(result.status, 'done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'press');
  assert.equal(calls[0].key, 'Escape', 'PRESS varsayılanı Escape');
  assert.equal(calls[0].fast, true, 'Jev hızlı yolu kullanılmalı');
  assert.equal(result.trace[0].operation, 'PRESS');
});

test('browseragent: HOVER alt menüyü açar (tıklamaz), sonra CLICK eder', async () => {
  const calls = [];
  const answers = [
    {
      model: 'jev-test',
      answers: {
        operation: answer('HOVER', { CLICK: 0.1, HOVER: 0.8, WAIT: 0.05, DONE: 0.02, BLOCKED: 0.02, PRESS: 0.01 }, 0.8),
        hover_target: answer('1', { 1: 1 }, 1),
      },
    },
    {
      model: 'jev-test',
      answers: {
        operation: answer('CLICK', { CLICK: 0.86, HOVER: 0.02, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02, PRESS: 0.02 }, 0.86),
        click_target: answer('1', { 1: 1 }, 1),
      },
    },
    {
      model: 'jev-test',
      answers: {
        operation: answer('DONE', { CLICK: 0.02, HOVER: 0.02, WAIT: 0.03, DONE: 0.89, BLOCKED: 0.02, PRESS: 0.02 }, 0.89),
      },
    },
  ];
  const result = await browseragent.run(
    {
      observe: async () => clickPage(),
      act: async (kind, a) => {
        calls.push({ kind, ...a });
        return { ok: true, changed: true };
      },
      wait: async () => ({ ok: true }),
      systemOne: async () => answers.shift(),
      textLlm: async () => '',
      emit: () => {},
    },
    { goal: 'kategori menüsünü aç ve alt öğeye tıkla', max_steps: 5 }
  );
  assert.equal(result.status, 'done');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].kind, 'hover', 'önce hover');
  assert.equal(calls[0].ref, 1);
  assert.equal(calls[0].trusted, true);
  assert.equal(calls[1].kind, 'click', 'sonra alt öğeye tıkla');
  assert.equal(result.trace[0].operation, 'HOVER');
  assert.equal(result.trace[0].kind, 'hover');
});

test('browseragent: katman altında kalan tıklamalar sayacı artırmaz (erken blocked yok)', async () => {
  const clickAnswer = {
    model: 'jev-test',
    answers: {
      operation: answer('CLICK', { CLICK: 0.86, HOVER: 0.02, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02, PRESS: 0.02 }, 0.88),
      click_target: answer('1', { 1: 1 }, 1),
    },
  };
  const result = await browseragent.run(
    {
      observe: async () => clickPage(),
      act: async () => ({ ok: true, clicked: false, covered: true, changed: false, reason: 'hedef katman altinda' }),
      wait: async () => ({ ok: true }),
      systemOne: async () => clickAnswer,
      textLlm: async () => '',
      emit: () => {},
    },
    { goal: 'katman kapat', max_steps: 5 }
  );
  assert.equal(result.status, 'max_steps', 'covered tıklamalar erken blocked tetiklemez');
  assert.equal(result.steps, 5);
  assert.ok(result.trace.every((t) => t.covered === true && t.failed === false));
});

test('browseragent: TYPE_TEXT küçük LLM metnini yazar ve raporlar', async () => {
  const calls = [];
  const pages = [
    {
      ok: true,
      url: 'https://x.test',
      title: 'X',
      text: '',
      actions: [
        { ref: 2, kind: 'fill', role: 'textbox', label: 'Where from?', value: '' },
        { ref: 2, kind: 'click', role: 'textbox', label: 'Open Where from?', value: '' },
        { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
      ],
    },
    clickPage(),
  ];
  const answers = [
    {
      model: 'jev-test',
      answers: {
        operation: answer('TYPE_TEXT', { TYPE_TEXT: 0.82, CLICK: 0.05, HOVER: 0.01, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02, PRESS: 0.02 }, 0.85),
        type_text_target: answer('1', { 1: 1 }, 1),
      },
    },
    {
      model: 'jev-test',
      answers: { operation: answer('DONE', { CLICK: 0.02, HOVER: 0.01, WAIT: 0.03, DONE: 0.89, BLOCKED: 0.04, PRESS: 0.01 }, 0.91) },
    },
  ];
  let observeCount = 0;
  const result = await browseragent.run(
    {
      observe: async () => pages[Math.min(observeCount++, pages.length - 1)],
      act: async (kind, a) => {
        calls.push({ kind, ...a });
        return { ok: true, changed: true };
      },
      wait: async () => ({ ok: true }),
      systemOne: async () => answers.shift(),
      textLlm: async (messages) => {
        assert.match(messages[0].content, /JSON object/);
        return '{"text": "Antalya"}';
      },
      emit: () => {},
    },
    { goal: 'Antalya yaz', max_steps: 4 }
  );
  assert.equal(result.status, 'done');
  assert.equal(calls[0].kind, 'type');
  assert.equal(calls[0].ref, 2);
  assert.equal(calls[0].text, 'Antalya');
  assert.equal(result.text_calls[0].value, 'Antalya');
  assert.equal(result.trace[0].text, 'Antalya');
});

test('browseragent: eylem başarısız olursa ısrar etmez, hata döner', async () => {
  const result = await browseragent.run(
    {
      observe: async () => clickPage(),
      act: async () => ({ ok: true, clicked: false, reason: 'ref eski' }),
      wait: async () => ({ ok: true }),
      systemOne: async () => ({
        model: 'jev-test',
        answers: {
          operation: answer('CLICK', { CLICK: 0.86, HOVER: 0.02, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02, PRESS: 0.02 }, 0.9),
          click_target: answer('1', { 1: 1 }, 1),
        },
      }),
      textLlm: async () => '',
      emit: () => {},
    },
    { goal: 'tıkla', max_steps: 5 }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /başarısız/);
});

test('browseragent: DONE, aynı istekteki noul doğrulaması düşükse reddedilir', async () => {
  const answers = [
    {
      model: 'jev-test',
      answers: {
        operation: answer('DONE', { CLICK: 0.02, HOVER: 0.02, WAIT: 0.03, DONE: 0.89, BLOCKED: 0.02, PRESS: 0.02 }, 0.93),
        verification: { type: 'noul', noul: 0.2 },
      },
    },
    {
      model: 'jev-test',
      answers: {
        operation: answer('DONE', { CLICK: 0.01, HOVER: 0.01, WAIT: 0.02, DONE: 0.93, BLOCKED: 0.02, PRESS: 0.01 }, 0.95),
        verification: { type: 'noul', noul: 0.95 },
      },
    },
  ];
  const result = await browseragent.run(
    {
      observe: async () => clickPage(),
      act: async () => ({ ok: true }),
      wait: async () => ({ ok: true }),
      systemOne: async () => answers.shift(),
      textLlm: async () => '',
      emit: () => {},
    },
    { goal: 'bitir', max_steps: 4 }
  );
  assert.equal(result.status, 'done');
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].operation, 'VERIFY');
  assert.ok(Math.abs(result.verification - 0.95) < 1e-9);
});

test('browseragent: bayat karar yenilenir, metin isteği cache\'den yeniden kullanılır', async () => {
  const fillPage = {
    ok: true,
    url: 'https://x.test',
    title: 'X',
    text: '',
    actions: [
      { ref: 2, kind: 'fill', role: 'textbox', label: 'Where from?', value: '' },
      { ref: 2, kind: 'click', role: 'textbox', label: 'Open Where from?', value: '' },
      { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
    ],
  };
  let observeCount = 0;
  let actCount = 0;
  let textCalls = 0;
  const typeAnswer = {
    model: 'jev-test',
    answers: {
      operation: answer('TYPE_TEXT', { TYPE_TEXT: 0.87, CLICK: 0.03, HOVER: 0.01, WAIT: 0.03, DONE: 0.02, BLOCKED: 0.02, PRESS: 0.02 }, 0.9),
      type_text_target: answer('1', { 1: 1 }, 1),
    },
  };
  const answers = [
    typeAnswer,
    typeAnswer,
    {
      model: 'jev-test',
      answers: { operation: answer('DONE', { CLICK: 0.02, HOVER: 0.02, WAIT: 0.03, DONE: 0.89, BLOCKED: 0.02, PRESS: 0.02 }, 0.93) },
    },
  ];
  const result = await browseragent.run(
    {
      observe: async () => (observeCount++ < 2 ? fillPage : clickPage()),
      act: async () => {
        actCount++;
        if (actCount === 1) return { ok: true, typed: false, stale: true, reason: 'sayfa degisti' };
        return { ok: true, typed: true };
      },
      wait: async () => ({ ok: true }),
      systemOne: async () => answers.shift(),
      textLlm: async () => {
        textCalls++;
        return '{"text": "Zurich"}';
      },
      emit: () => {},
    },
    { goal: 'Zurich yaz', max_steps: 5 }
  );
  assert.equal(result.status, 'done');
  assert.equal(textCalls, 1, 'bayat denemede metin LLM ikinci kez çağrılmamalı');
  assert.equal(actCount, 2);
  assert.equal(result.trace.filter((t) => t.kind === 'verify').length, 0);
  assert.equal(result.text_calls.filter((t) => t.cached).length, 1);
});

test('typesafe: 429 sonrası backoff ile yeniden dener', async () => {
  typesafe.setConfig(() => ({ apiKey: 'k', model: 'jev-latest', enabled: true }));
  const origFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, text: async () => 'rate limited' };
    return {
      ok: true,
      status: 200,
      json: async () => ({ model: 'jev-latest', answers: { q: { type: 'noul', noul: 0.8 } } }),
    };
  };
  try {
    const r = await typesafe.systemOne({ state: 'x', questions: { q: { type: 'noul', instructions: '?' } } });
    assert.equal(calls, 2);
    assert.equal(r.answers.q.noul, 0.8);
  } finally {
    global.fetch = origFetch;
    typesafe.setConfig(() => ({ apiKey: '', model: 'jev-latest' }));
  }
});

test('typesafe: aç/kapa kapısı anahtar varken de kapatır', async () => {
  typesafe.setConfig(() => ({ apiKey: 'k', model: 'jev-latest', enabled: false }));
  try {
    assert.match(typesafe.unavailable(), /kapalı/);
    const r = await typesafe.handlers.typesafe_decision(
      { state: 'x', questions: { q: { type: 'noul', instructions: '?' } } },
      {}
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /kapalı/);
  } finally {
    typesafe.setConfig(() => ({ apiKey: '', model: 'jev-latest' }));
  }
});
