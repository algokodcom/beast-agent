'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const perception = require('../src/agent/perception');
const { beastRoot } = require('../src/agent/memory');

function gradeFromPrompt(prompt, patch) {
  const m = /"id":"([^"]+)"/.exec(prompt);
  const id = m ? m[1] : 'x';
  return JSON.stringify([{ id, notify: false, relevant: 0, importance: 5, urgency: 5, novelty: 5, reason: 'test' }, ...[]].map((g) => ({ ...g, ...patch })));
}

test('empati: yok sayılan (ignored) olaylar depoda TUTULMAZ', async () => {
  const cfg = perception.mergeCfg({});
  const r = await perception.runCycle({
    cfg,
    signals: {
      self: async () => [{ type: 'self', source: 'test', title: 'önemsiz olay abc', detail: 'x' }],
    },
    llmFilter: async (prompt) => gradeFromPrompt(prompt), /* hepsi düşük puan + notify:false */
    now: new Date(),
  });
  assert.ok(r.summary.ignored >= 1, 'ignored sayılmalı: ' + JSON.stringify(r.summary));
  const ids = perception.listEvents(100).map((e) => e.status);
  assert.ok(!ids.includes('ignored'), 'ignored olay listede olmamalı: ' + JSON.stringify(ids));
  /* dosyada da olmamalı */
  const raw = JSON.parse(fs.readFileSync(path.join(beastRoot(), 'perception', 'events.json'), 'utf8'));
  assert.ok(!raw.events.some((e) => e.status === 'ignored'), 'events.json içinde ignored kalmamalı');
});

test('empati: yüksek puanlı olay queued kalır + depoda durur', async () => {
  const cfg = perception.mergeCfg({});
  const r = await perception.runCycle({
    cfg,
    signals: {
      self: async () => [{ type: 'self', source: 'test', title: 'çok kritik gelişme xyz', detail: 'önemli' }],
    },
    llmFilter: async (prompt) =>
      gradeFromPrompt(prompt, { notify: true, relevant: 90, importance: 90, urgency: 70, novelty: 70, reason: 'kritik' }),
    now: new Date(),
  });
  assert.ok(r.summary.queued >= 1, 'queued olmalı: ' + JSON.stringify(r.summary));
  const evs = perception.listEvents(100);
  const hit = evs.find((e) => /çok kritik gelişme/.test(e.title));
  assert.ok(hit, 'queued olay listede olmalı');
  assert.strictEqual(hit.status, 'queued');
});

test('empati: eski depodaki ignored kalıntıları sonraki döngüde temizlenir', async () => {
  /* kalıntı ignored olay elle depoya yazılır */
  const stFile = path.join(beastRoot(), 'perception', 'events.json');
  const st = JSON.parse(fs.readFileSync(stFile, 'utf8'));
  st.events.push({
    id: 'eski-kalinti-1', ts: new Date().toISOString(), source: 'test', type: 'self',
    title: 'eski yok-sayılmış olay', detail: '', url: '', sources: ['test'],
    scores: {}, priority: 10, reason: 'eski', status: 'ignored', level: '', text: '', notifiedAt: null,
  });
  fs.writeFileSync(stFile, JSON.stringify(st));
  await perception.runCycle({ cfg: perception.mergeCfg({}), signals: {}, now: new Date() });
  assert.ok(!perception.listEvents(200).some((e) => e.id === 'eski-kalinti-1'), 'kalıntı temizlenmeli');
});
