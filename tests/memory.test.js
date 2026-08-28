'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const memory = require('../src/agent/memory');

test('append + entries turu', () => {
  memory.append('Kullanıcı FxPro MT5 kullanıyor');
  memory.append('Beast hızlı olmalı, gereksiz sormaz');
  const list = memory.entries();
  assert.ok(list.length >= 2);
  assert.ok(list.some((l) => l.includes('FxPro')));
});

test('search ilgili kaydı bulur (Türkçe büyük/küçük + diakritik duyarsız)', () => {
  memory.append('Kullanıcının favori editörü VS Code');
  const hits = memory.search('favori editör nedir?');
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].text.toLowerCase().includes('editör') || hits[0].text.toLowerCase().includes('edıtor'));
});

test('relevantFor alakasız sorguda bile son kayıtları döndürür', () => {
  const out = memory.relevantFor('zzz bilinmeyen kelime xyzq');
  assert.ok(out.length > 0);
  assert.ok(out.startsWith('- '));
});

test('relevantFor charCap\u0027e uyar', () => {
  for (let i = 0; i < 30; i++) memory.append('uzun kayıt numara ' + i + ' ' + 'x'.repeat(200));
  const out = memory.relevantFor('kayıt');
  assert.ok(out.length <= 2600);
});
