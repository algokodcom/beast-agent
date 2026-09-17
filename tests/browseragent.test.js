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
        operation: answer('CLICK', { CLICK: 0.9, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02 }, 0.9),
        click_target: answer('1', { 1: 1 }, 1),
      },
    },
    {
      model: 'jev-test',
      answers: {
        operation: answer('DONE', { CLICK: 0.02, WAIT: 0.03, DONE: 0.93, BLOCKED: 0.02 }, 0.93),
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
  assert.deepEqual(calls, [{ kind: 'click', ref: 1 }]);
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].operation, 'CLICK');
  assert.match(result.note, /KANIT DEĞİL/);
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
        operation: answer('TYPE_TEXT', { TYPE_TEXT: 0.85, CLICK: 0.05, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02 }, 0.85),
        type_text_target: answer('1', { 1: 1 }, 1),
      },
    },
    {
      model: 'jev-test',
      answers: { operation: answer('DONE', { CLICK: 0.02, WAIT: 0.03, DONE: 0.91, BLOCKED: 0.04 }, 0.91) },
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
  assert.deepEqual(calls[0], { kind: 'type', ref: 2, text: 'Antalya' });
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
          operation: answer('CLICK', { CLICK: 0.9, WAIT: 0.05, DONE: 0.03, BLOCKED: 0.02 }, 0.9),
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
