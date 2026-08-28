'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const { estTokens, estMsgTokens } = require('../src/agent/tokens');

test('estTokens boş metin 0', () => {
  assert.equal(estTokens(''), 0);
  assert.equal(estTokens(null), 0);
});

test('estTokens uzunlukla monoton artar', () => {
  const a = estTokens('hello world');
  const b = estTokens('hello world and more words here');
  assert.ok(a > 0 && b > a);
});

test('geniş karakterler (CJK/emoji) daha pahalı', () => {
  const ascii = estTokens('aaaa');
  const wide = estTokens('\u4e00\u4e01\u4e02\u4e03'); // 4 CJK karakter
  assert.ok(wide > ascii);
});

test('Türkçe karakterler ASCII\u0027den hafif pahalı', () => {
  assert.ok(estTokens('ğğğğ') >= estTokens('aaaa'));
});

test('estMsgTokens mesaj zarfı ekler', () => {
  const m = { role: 'user', content: 'selam' };
  assert.ok(estMsgTokens(m) > estTokens('selam'));
});

test('tool_calls içeren mesaj daha ağır', () => {
  const base = { role: 'assistant', content: 'x' };
  const withTools = {
    role: 'assistant',
    content: 'x',
    tool_calls: [{ id: '1', type: 'function', function: { name: 'run_command', arguments: '{"command":"dir"}' } }],
  };
  assert.ok(estMsgTokens(withTools) > estMsgTokens(base));
});
