'use strict';

require('./setup');
const { test, after } = require('node:test');
const assert = require('node:assert');
const squeeze = require('../src/agent/squeeze');

after(() => squeeze.setEnabled(false));

const MARK = '[squeeze:';

function toolMsg(id, name, content) {
  return { role: 'tool', tool_call_id: id, name, content };
}

function callMsg(id, name, args) {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id, type: 'function', function: { name, arguments: JSON.stringify(args || {}) } },
    ],
  };
}

function big(label, n) {
  return label + '\n' + ('veri ' + label + ' satiri\n').repeat(Math.ceil(n / 12));
}

test('kapalıyken aynı referans döner', () => {
  squeeze.setEnabled(false);
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: big('u', 30000) }];
  assert.equal(squeeze.apply(msgs), msgs);
});

test('küçük bağlamda dokunmaz', () => {
  squeeze.setEnabled(true);
  squeeze.resetStats();
  const msgs = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'kısa soru' },
    { role: 'assistant', content: 'kısa cevap' },
  ];
  assert.equal(squeeze.apply(msgs), msgs);
});

test('aynı büyük blok bir kez gider, sonraki işaretçi olur', () => {
  squeeze.setEnabled(true);
  squeeze.resetStats();
  const text = big('json', 20000);
  const msgs = [
    { role: 'system', content: 's' },
    callMsg('1', 'http_fetch', { url: 'a' }),
    toolMsg('1', 'http_fetch', text),
    { role: 'user', content: 'devam' },
    callMsg('2', 'http_fetch', { url: 'a' }),
    toolMsg('2', 'http_fetch', text),
    { role: 'user', content: 'son soru' },
  ];
  const out = squeeze.apply(msgs);
  assert.equal(out[2].content, text);
  assert.ok(out[5].content.includes(MARK), 'ikinci kopya işaretçi olmalı');
  assert.ok(squeeze.getStats().deduped >= 1);
  assert.ok(squeeze.getStats().savedTokens > 0);
});

test('bağlam koparsa (ilk kopya düşerse) içerik yeniden tam gider', () => {
  squeeze.setEnabled(true);
  squeeze.resetStats();
  const text = big('json', 20000);
  const msgs = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'özet sonrası devam' },
    callMsg('2', 'http_fetch', { url: 'a' }),
    toolMsg('2', 'http_fetch', text),
    { role: 'user', content: 'son soru' },
  ];
  const out = squeeze.apply(msgs);
  assert.equal(out[3].content, text);
  assert.ok(!out[3].content.includes(MARK));
});

test('eski araç çıktıları başlık+önizlemeye iner, son araçlar korunur', () => {
  squeeze.setEnabled(true);
  squeeze.resetStats();
  const msgs = [{ role: 'system', content: 's' }];
  for (let i = 1; i <= 10; i++) {
    msgs.push(callMsg(String(i), 'run_command', { command: 'is' + i }));
    msgs.push(toolMsg(String(i), 'run_command', big('cikti' + i, 20000)));
  }
  msgs.push({ role: 'user', content: 'son' });
  const out = squeeze.apply(msgs);
  const tools = out.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 10);
  assert.ok(tools[0].content.includes(MARK), 'en eski çıktı sıkışmalı');
  assert.ok(tools[1].content.includes(MARK));
  assert.ok(tools[5].content.includes(MARK), 'pencere dışı çıktı sıkışmalı');
  assert.ok(!tools[7].content.includes(MARK), 'son 3 araç sonucu korunmalı');
  assert.ok(!tools[9].content.includes(MARK));
  assert.ok(squeeze.getStats().compactedTools >= 2);
});

test('aynı dosyanın en son okuması korunur, eskisi sıkışır', () => {
  squeeze.setEnabled(true);
  squeeze.resetStats();
  const cfg = { config: { keepRecentTools: 1, keepRecentUnits: 1 } };
  const msgs = [
    { role: 'system', content: 's' },
    callMsg('a1', 'read_file', { file_path: 'C:/x/a.js' }),
    toolMsg('a1', 'read_file', big('dosya-a-eski', 12000)),
    callMsg('b1', 'grep', { pattern: 'x' }),
    toolMsg('b1', 'grep', big('grep', 12000)),
    callMsg('a2', 'read_file', { file_path: 'C:/x/a.js' }),
    toolMsg('a2', 'read_file', big('dosya-a-yeni', 12000)),
    { role: 'user', content: 'son soru' },
  ];
  const out = squeeze.apply(msgs, cfg);
  assert.ok(out[2].content.includes(MARK), 'eski okuma sıkışmalı');
  assert.equal(out[6].content, msgs[6].content, 'dosyanın son okuması tam kalmalı');
});

test('pencereden çıkmış eski okuma da sıkışır (dosya hafızası penceresi)', () => {
  squeeze.setEnabled(true);
  squeeze.resetStats();
  const cfg = { config: { keepRecentTools: 1, keepRecentUnits: 1, protectReadsWindow: 0 } };
  const msgs = [
    { role: 'system', content: 's' },
    callMsg('a1', 'read_file', { file_path: 'C:/x/a.js' }),
    toolMsg('a1', 'read_file', big('dosya-a', 12000)),
    callMsg('b1', 'run_command', { command: 'x' }),
    toolMsg('b1', 'run_command', big('komut', 12000)),
    { role: 'user', content: 'son soru' },
  ];
  const out = squeeze.apply(msgs, cfg);
  assert.ok(out[2].content.includes(MARK), 'eski okuma pencere dışında sıkışmalı');
});

test('skill gövdesi tekrarı stub olur, tek kopya tam kalır', () => {
  squeeze.setEnabled(true);
  squeeze.resetStats();
  const body = JSON.stringify({ ok: true, name: 'pdf', path: 'x', content: big('skill-govde', 12000) });
  const msgs = [
    { role: 'system', content: 's' },
    callMsg('s1', 'skill', { name: 'pdf' }),
    toolMsg('s1', 'skill', body),
    { role: 'user', content: 'devam' },
    callMsg('s2', 'skill', { name: 'pdf' }),
    toolMsg('s2', 'skill', body),
    { role: 'user', content: 'son' },
  ];
  const out = squeeze.apply(msgs);
  assert.equal(out[2].content, body);
  assert.ok(out[5].content.includes(MARK));
  assert.ok(squeeze.getStats().compactedSkills >= 1);
});

test('idempotans: ikinci uygulama yeni sıkıştırma yapmaz', () => {
  squeeze.setEnabled(true);
  squeeze.resetStats();
  const msgs = [
    { role: 'system', content: 's' },
    callMsg('1', 'run_command', { command: 'a' }),
    toolMsg('1', 'run_command', big('x', 20000)),
    { role: 'user', content: 'devam' },
    callMsg('2', 'run_command', { command: 'b' }),
    toolMsg('2', 'run_command', big('y', 20000)),
    { role: 'user', content: 'son' },
  ];
  const once = squeeze.apply(msgs, { config: { keepRecentTools: 1, keepRecentUnits: 1 } });
  const twice = squeeze.apply(once, { config: { keepRecentTools: 1, keepRecentUnits: 1 } });
  assert.equal(twice, once);
  assert.ok(!twice[5].content.includes(MARK + ' bu araç'), 'çift sıkıştırma yok');
});

test('system ve son mesaja dokunulmaz', () => {
  squeeze.setEnabled(true);
  squeeze.resetStats();
  const msgs = [
    { role: 'system', content: big('SISTEM', 12000) },
    callMsg('1', 'run_command', { command: 'a' }),
    toolMsg('1', 'run_command', big('x', 12000)),
    { role: 'user', content: big('SON-SORU', 12000) },
  ];
  const out = squeeze.apply(msgs);
  assert.equal(out[0], msgs[0]);
  assert.equal(out[3], msgs[3]);
});
