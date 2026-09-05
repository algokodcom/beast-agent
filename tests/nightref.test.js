'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const nr = require('../src/agent/nightref');
const memory = require('../src/agent/memory');

/* ---------- zamanlama: due() ---------- */

test('nightref due: hedef saat öncesi çalışmaz, sonra ve yeni günde çalışır', () => {
  const at = '03:30';
  // hedef saat öncesi
  const before = new Date('2026-09-04T02:00:00');
  assert.equal(nr.due({ now: before, lastAt: null, at }), false);
  // hedef saat sonrası, hiç çalışılmamış
  const after = new Date('2026-09-04T04:00:00');
  assert.equal(nr.due({ now: after, lastAt: null, at }), true);
  // dün çalışılmış → bugün tekrar
  assert.equal(nr.due({ now: after, lastAt: '2026-09-03T03:30:00', at }), true);
  // bugün çalışılmış → tekrar yok
  assert.equal(nr.due({ now: after, lastAt: '2026-09-04T03:31:00', at }), false);
  // geçersiz saat → varsayılan 03:30
  assert.equal(nr.due({ now: new Date('2026-09-04T03:00:00'), lastAt: null, at: 'kjr' }), false);
  assert.equal(nr.due({ now: new Date('2026-09-04T03:40:00'), lastAt: null, at: 'kjr' }), true);
});

test('nightref resolveAt + dayKey', () => {
  assert.deepEqual(nr.resolveAt('21:05'), { h: 21, m: 5 });
  assert.deepEqual(nr.resolveAt('garanti'), { h: 3, m: 30 });
  assert.deepEqual(nr.resolveAt('25:99'), { h: 3, m: 30 });
  assert.equal(nr.dayKey(new Date('2026-09-04T22:10:00')), '2026-09-04');
});

/* ---------- bellek cerrahisi: applyMemoryOps ---------- */

test('nightref applyMemoryOps: drop tavanı %40', () => {
  const lines = Array.from({ length: 10 }, (_, i) => 'kayit-' + i);
  const r = nr.applyMemoryOps(lines, { drop: [0, 1, 2, 3, 4, 5, 6] });
  // 10 kayıtta tavan 4 — eskiler (küçük index) düşer, yeniler kalır
  assert.equal(r.dropped, 4);
  assert.equal(r.dropSkipped, 3);
  assert.equal(r.lines.length, 6);
  assert.ok(!r.lines.includes('kayit-0'));
  assert.ok(r.lines.includes('kayit-6'));
  assert.ok(r.lines.includes('kayit-9'));
});

test('nightref applyMemoryOps: merge ilk kaynağın yerine yazılır, uydurma metin reddedilir', () => {
  const lines = ['Uzun bir hafıza kaydı alpha detaylarıyla', 'Uzun bir hafıza kaydı beta detaylarıyla', 'başka bir kayıt', 'Uzun bir hafıza kaydı gamma detaylarıyla'];
  // geçerli merge: metin kaynakların toplamından kısa
  const r = nr.applyMemoryOps(lines, { merge: [{ ids: [1, 3], text: 'kayit beta+gamma birlesik oz' }] });
  assert.equal(r.merged, 1);
  assert.deepEqual(r.lines, [lines[0], 'kayit beta+gamma birlesik oz', lines[2]]);
  // uydurma: kaynakların toplamından uzun metin reddedilir
  const bad = nr.applyMemoryOps(lines, { merge: [{ ids: [0, 1], text: 'bu metin iki uzun kaynak satirin toplamindan daha da uzundur ve uydurma kabul edilir' }] });
  assert.equal(bad.merged, 0);
  assert.deepEqual(bad.lines, lines);
});

test('nightref applyMemoryOps: merge önce bağlanır — merge\u2019li satır drop edilemez', () => {
  const lines = ['x1', 'x2-uzun', 'x3-uzun'];
  const r = nr.applyMemoryOps(lines, { drop: [1], merge: [{ ids: [1, 2], text: 'x2+x3 birlesik' }] });
  // merge önce: id1 'merged' → drop onu alamaz, hiçbir şey düşmez
  assert.equal(r.dropped, 0);
  assert.deepEqual(r.lines, ['x1', 'x2+x3 birlesik']);
  // merge reddedilirse (uydurma) drop serbest kalır
  const r2 = nr.applyMemoryOps(lines, { drop: [1], merge: [{ ids: [1, 2], text: 'bu metin kaynak toplamindan uzun' }] });
  assert.deepEqual(r2.lines, ['x1', 'x3-uzun']);
});

test('nightref applyMemoryOps: geçersiz id yok sayılır, karar verilmeyen satır korunur', () => {
  const lines = ['x1', 'x2', 'x3'];
  // 99/-1/'kirli' geçersiz → yok sayılır; geçerli tek drop: id 1
  // merge 'olmaz' kaynak toplamından uzun (4 char) → reddedilir, drop serbest kalır
  const r = nr.applyMemoryOps(lines, { drop: [99, -1, 'kirli', 1], merge: [{ ids: [1, 2], text: 'olmaz' }] });
  assert.deepEqual(r.lines, ['x1', 'x3']);
  assert.equal(r.dropped, 1);
});

test('nightref parseDecision + parseLearnings: fence\u2019li/gömülü JSON', () => {
  const d = nr.parseDecision('işte karar:\n```json\n{"drop":[2],"merge":[{"ids":[0,1],"text":"ö"}]}\n```');
  assert.deepEqual(d.drop, [2]);
  const l = nr.parseLearnings('önce metin {"learnings":["L1"],"facts":["F1"]} sonra metin');
  assert.deepEqual(l.learnings, ['L1']);
  assert.deepEqual(l.facts, ['F1']);
  assert.equal(nr.parseDecision('json yok'), null);
  assert.deepEqual(nr.parseLearnings('bozuk {'), { learnings: [], facts: [] });
});

/* ---------- orkestratör: run() uçtan uca (sahte llm) ---------- */

test('nightref run: journal + rapor yazar, MEMORY.md sıkılaşır, fact eklenir', async () => {
  const md = path.join(memory.memDir(), 'MEMORY.md');
  /* her satır ayrı KONU kelimesiyle ayırt edici — derin hijyen (yakın-kayıt
     dedup) bunları birleştirmesin, LLM sıkılaştırma akışı test edilsin */
  const topics = ['mcp', 'whatsapp', 'studio', 'cron', 'rail', 'tts', 'pdf', 'excel', 'gitara', 'mem0', 'searxng', 'oyun'];
  const seed = topics.map((t) => '- Gereksiz kayit ' + t).join('\n') + '\n';
  fs.mkdirSync(memory.memDir(), { recursive: true });
  fs.writeFileSync(md, seed);
  fs.rmSync(path.join(memory.memDir(), 'reflections'), { recursive: true, force: true });
  fs.rmSync(path.join(memory.memDir(), 'journal'), { recursive: true, force: true });

  const calls = [];
  const llm = async (prompt) => {
    calls.push(prompt);
    if (prompt.includes('"learnings"')) {
      return JSON.stringify({
        learnings: ['MCP entegrasyonu test edildi', 'Sıkılaştırma hattı çalışıyor'],
        facts: ['Kullanıcı GOLD trading ile ilgileniyor'],
      });
    }
    if (prompt.includes('drop')) {
      return JSON.stringify({ drop: [0], merge: [{ ids: [1, 2], text: 'Gereksiz kayit-1 ve 2 birlesik oz' }] });
    }
    return '{}';
  };

  const report = await nr.run({
    llm,
    memory,
    mem0Enabled: true,
    sessions: [{ id: 's1', title: 'Test oturumu', updatedAt: new Date().toISOString(), transcript: '[Kullanıcı] merhaba\n[Asistan] selam, bugün mcp kurdum ve çok şey öğrendik'.repeat(10) }],
    sinceIso: null,
    manual: true,
    now: new Date('2026-09-04T03:31:00'),
    log: () => {},
  });

  // öğrenme: 2 LLM çağrısı (learnings + consolidate)
  assert.equal(calls.length, 2);
  assert.ok(report.ok);
  assert.equal(report.learnings.length, 2);
  assert.equal(report.factsAdded, 1);
  assert.ok(report.journal && fs.existsSync(path.join(memory.memDir(), report.journal)), 'journal dosyası yazılmalı');
  const journal = fs.readFileSync(path.join(memory.memDir(), 'journal', '2026-09-04.md'), 'utf8');
  assert.ok(journal.includes('Bugün öğrendiklerim'));
  assert.ok(journal.includes('MCP entegrasyonu'));

  // sıkılaştırma: 12 seed + 1 fact = 13 → -1 drop -1 merge = 11
  assert.equal(report.memory.before, 12);
  assert.equal(report.memory.dropped, 1);
  assert.equal(report.memory.merged, 1);
  const entries = memory.entries();
  assert.equal(entries.length, 11);
  assert.ok(!entries.some((e) => e.includes('kayit-0')), 'drop edilen satır gitmeli');
  assert.ok(entries.some((e) => e.includes('birlesik oz')), 'merge satırı gelmeli');
  assert.ok(entries.some((e) => e.includes('GOLD trading')), 'kalıcı fact hafızada');

  // yedek + rapor + last state
  assert.ok(fs.existsSync(path.join(memory.memDir(), 'backups', 'MEMORY-2026-09-04.md')), 'yedek alınmalı');
  assert.ok(report.reportFile && fs.existsSync(path.join(memory.memDir(), report.reportFile)));
  const last = nr.readLast(memory.memDir());
  assert.equal(last.day, '2026-09-04');

  // due: bugün çalıştı → aynı gün tekrar tetiklenmez
  assert.equal(nr.due({ now: new Date('2026-09-04T05:00:00'), lastAt: last.at, at: nr.DEFAULT_AT }), false);
});

test('nightref run: llmsiz degradasyon — rapor yine yazılır', async () => {
  const report = await nr.run({
    memory,
    mem0Enabled: false,
    sessions: [],
    sinceIso: null,
    manual: true,
    now: new Date('2026-09-04T04:00:00'),
    log: () => {},
  });
  assert.ok(report.ok);
  assert.ok(report.errors.some((e) => e.includes('llm')));
  assert.ok(fs.existsSync(path.join(memory.memDir(), 'journal', '2026-09-04.md')));
});
