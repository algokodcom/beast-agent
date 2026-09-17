'use strict';

/* T3SFast computer use (computer_agent) testleri:
   - lineTargets: OCR satırları → indeksli tıklama hedefleri
   - operationSet: TYPE_TEXT yalnız odaklanmışken sunulur
   - run: CLICK → DONE ve CLICK → TYPE_TEXT → DONE akışları (sahte köprü) */

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const computeragent = require('../src/agent/computeragent');

const LINES = [
  { text: 'Dosya', x: 100, y: 20, confidence: 92 },
  { text: 'Arama kutusu', x: 200, y: 300, confidence: 88 },
];

function distribution(choice, keys) {
  const p = {};
  const rest = keys.filter((k) => k !== choice);
  const each = rest.length ? 0.1 / rest.length : 0;
  for (const k of rest) p[k] = each;
  p[choice] = 1 - each * rest.length;
  return p;
}

function answer(choice, keys) {
  return { type: 'choice', choice, probabilities: distribution(choice, keys), confidence: 0.9 };
}

function screen(extra) {
  return { ok: true, w: 1280, h: 720, text: 'Dosya\nArama kutusu', lines: LINES, ...(extra || {}) };
}

test('computeragent: lineTargets merkez koordinatlı hedefler üretir', () => {
  const targets = computeragent.lineTargets(LINES);
  assert.equal(targets['2'].label, 'Arama kutusu');
  assert.equal(targets['2'].x, 200);
  assert.equal(targets['2'].y, 300);
  assert.equal(targets['1'].kind, 'click');
});

test('computeragent: operationSet TYPE_TEXT yalnız odak varken sunar', () => {
  const base = computeragent.operationSet(computeragent.lineTargets(LINES), null);
  assert.ok(base.CLICK && base.PRESS_ENTER && base.SCROLL_DOWN);
  assert.equal(base.TYPE_TEXT, undefined);
  const focused = computeragent.operationSet(computeragent.lineTargets(LINES), 'Arama kutusu');
  assert.ok(focused.TYPE_TEXT);
});

test('computeragent: CLICK → DONE akışı koordinata tıklar', async () => {
  const calls = [];
  const keysNoFocus = Object.keys(computeragent.operationSet(computeragent.lineTargets(LINES), null));
  const keysFocused = Object.keys(computeragent.operationSet(computeragent.lineTargets(LINES), 'Arama kutusu'));
  const answers = [
    { model: 'jev-test', answers: { operation: answer('CLICK', keysNoFocus), click_target: answer('2', ['1', '2']) } },
    { model: 'jev-test', answers: { operation: answer('DONE', keysFocused) } },
  ];
  const result = await computeragent.run(
    {
      observe: async () => screen(),
      act: async (op, a) => {
        calls.push({ op, ...a });
        return { ok: true, changed: true };
      },
      wait: async () => ({ ok: true }),
      systemOne: async () => answers.shift(),
      textLlm: async () => '{"text": "x"}',
      emit: () => {},
    },
    { goal: 'aramaya tıkla' }
  );
  assert.equal(result.status, 'done');
  assert.deepEqual(calls, [{ op: 'click', x: 200, y: 300 }]);
  assert.equal(result.trace[0].action, 'Arama kutusu');
  assert.match(result.note, /KANIT DEĞİL/);
});

test('computeragent: CLICK → TYPE_TEXT → DONE akışı metni yazar', async () => {
  const calls = [];
  const keysNoFocus = Object.keys(computeragent.operationSet(computeragent.lineTargets(LINES), null));
  const keysFocused = Object.keys(computeragent.operationSet(computeragent.lineTargets(LINES), 'Arama kutusu'));
  const answers = [
    { model: 'jev-test', answers: { operation: answer('CLICK', keysNoFocus), click_target: answer('2', ['1', '2']) } },
    {
      model: 'jev-test',
      answers: { operation: answer('TYPE_TEXT', keysFocused), type_text_target: answer('1', ['1']) },
    },
    { model: 'jev-test', answers: { operation: answer('DONE', keysFocused) } },
  ];
  const result = await computeragent.run(
    {
      observe: async () => screen(),
      act: async (op, a) => {
        calls.push({ op, ...a });
        return { ok: true, changed: null };
      },
      wait: async () => ({ ok: true }),
      systemOne: async () => answers.shift(),
      textLlm: async (messages) => {
        assert.match(messages[0].content, /JSON object/);
        return '{"text": "Antalya"}';
      },
      emit: () => {},
    },
    { goal: 'aramaya Antalya yaz', max_steps: 5 }
  );
  assert.equal(result.status, 'done');
  assert.deepEqual(calls[0], { op: 'click', x: 200, y: 300 });
  assert.deepEqual(calls[1], { op: 'type', text: 'Antalya' });
  assert.equal(result.text_calls[0].value, 'Antalya');
  assert.equal(result.focused, 'Arama kutusu');
});

test('computeragent: OCR boşsa bloklanır, eylem yapılmaz', async () => {
  const result = await computeragent.run(
    {
      observe: async () => ({ ok: true, w: 1280, h: 720, text: '', lines: [] }),
      act: async () => ({ ok: true }),
      wait: async () => ({ ok: true }),
      systemOne: async () => {
        throw new Error('çağrılmamalı');
      },
      textLlm: async () => '',
      emit: () => {},
    },
    { goal: 'bir şey tıkla' }
  );
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /OCR/);
});

test('computeragent: eylem başarısız olursa ısrar etmez', async () => {
  const keysNoFocus = Object.keys(computeragent.operationSet(computeragent.lineTargets(LINES), null));
  const result = await computeragent.run(
    {
      observe: async () => screen(),
      act: async () => ({ ok: false, error: 'PowerShell hatası' }),
      wait: async () => ({ ok: true }),
      systemOne: async () => ({
        model: 'jev-test',
        answers: { operation: answer('CLICK', keysNoFocus), click_target: answer('1', ['1', '2']) },
      }),
      textLlm: async () => '',
      emit: () => {},
    },
    { goal: 'tıkla', max_steps: 5 }
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /başarısız/);
});
