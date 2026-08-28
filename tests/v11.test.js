'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../src/agent/engine');

/* parseReflectionJson: düz / fence'li / gömülü JSON + bozuk girdi */
test('reflection JSON ayrıştırıcı', () => {
  const good = Engine.parseReflectionJson(
    '{"create": true, "name": "rapor-al", "description": "d", "body": "# Rapor\\n- adım"}'
  );
  assert.equal(good.create, true);
  assert.equal(good.name, 'rapor-al');

  const fenced = Engine.parseReflectionJson(
    'İşte öneri:\n```json\n{"create": false}\n```\nbitti'
  );
  assert.equal(fenced.create, false);

  const embedded = Engine.parseReflectionJson(
    'önce metin {"create": true, "name": "x", "description": "y", "body": "z"} sonra metin'
  );
  assert.equal(embedded.name, 'x');

  assert.equal(Engine.parseReflectionJson('JSON yok burada'), null);
  assert.equal(Engine.parseReflectionJson('{bozuk'), null);
});

/* skills taslak yaşam döngüsü */
test('skills draft: add → list → accept → scan\u2019de görünür', () => {
  const skills = require('../src/agent/skills');
  const r = skills.addDraft({
    name: 'Test Yetenek',
    description: 'deneme taslağı',
    body: '# Test Yetenek\n- adım bir',
  });
  assert.ok(r.ok);

  const drafts = skills.listDrafts();
  const d = drafts.find((x) => x.id === 'test-yetenek');
  assert.ok(d, 'taslak listede olmalı');

  // scan taslağı GÖRMEMELİ
  assert.ok(!skills.scan().some((s) => s.name === 'Test Yetenek'));

  // kabul → kurulur, taslak silinir
  const acc = skills.acceptDraft('test-yetenek');
  assert.ok(acc.ok);
  assert.ok(skills.scan().some((s) => s.name === 'Test Yetenek'));
  assert.ok(!skills.listDrafts().some((x) => x.id === 'test-yelenek' || x.id === 'test-yetenek'));

  // temizlik
  const folder = require('path').join(skills.dir(), 'test-yetenek');
  require('fs').rmSync(folder, { recursive: true, force: true });
});

/* kural hattı (#3) */
test('rules: ekle/liste/çıkar + skill\u2019e madde', () => {
  const memory = require('../src/agent/memory');
  const before = memory.listRules();
  const r = memory.addRule('Terminal çıktısını asla kısaltma');
  assert.ok(r.ok);
  const after = memory.listRules();
  assert.equal(after.length, before.length + 1);
  assert.ok(after.some((x) => x.includes('Terminal çıktısını')));

  // dup
  const dup = memory.addRule('Terminal çıktısını asla kısaltma');
  assert.ok(dup.duplicate);

  // kaldır
  const rm = memory.removeRule('Terminal çıktısını asla kısaltma');
  assert.ok(rm.ok);
  assert.ok(!memory.listRules().some((x) => x.includes('Terminal çıktısını')));
});
