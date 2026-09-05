'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const memory = require('../src/agent/memory');

function reset(lines) {
  memory.save('MEMORY.md', (lines || []).map((l) => '- ' + l).join('\n') + (lines && lines.length ? '\n' : ''));
}

test('hygiene: yeniden yazılmış aynı kayıt TEK satıra iner (son kopya kazanır)', () => {
  reset([
    'Kullanıcının adı: Batuhan Bozoklu. Hitap: "kanka".',
    'kullanıcı arayüz testleri yapıyor',
    'kullanıcı Batuhan Bozoklu, hitap \'kanka\'',
  ]);
  const r = memory.hygiene({ deep: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.removed, 1, JSON.stringify(r));
  assert.strictEqual(r.remaining, 2);
  const list = memory.entries();
  /* SON kopya korunur (en taze bilgi) — eski başlıklı satır düşer */
  assert.ok(list.some((l) => /hitap 'kanka'/.test(l)), JSON.stringify(list));
  assert.ok(!list.some((l) => /Kullanıcının adı: Batuhan/.test(l)), JSON.stringify(list));
  assert.ok(list.some((l) => /arayüz testleri/.test(l)), JSON.stringify(list));
});

test('hygiene: emekli araç beyanı eski indirme satırını düşürür', () => {
  reset([
    "kullanıcı MoneyPrinterTurbo'yu (AI ile otomatik kısa video üretim aracı) Masaüstü'ne indiriyor.",
    'kullanıcı MoneyPrinterTurbo reposunu indirdikten sonra sildi, bu araçla ilgilenmiyor.',
  ]);
  const r = memory.hygiene({ deep: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const list = memory.entries();
  assert.ok(list.some((l) => /indirdikten sonra sildi/.test(l)), 'beyan korunmalı: ' + JSON.stringify(list));
  assert.ok(!list.some((l) => /indiriyor/.test(l)), 'eski indirme satırı düşmeli: ' + JSON.stringify(list));
});

test('hygiene: repo indirme günlüğü gürültü sayılır, konu ilgisi korunur', () => {
  reset([
    'kullanıcı obra/superpowers reposunu Masaüstü klasörüne indirdi, masaüstünde duracak.',
    "kullanıcı pipecat (sesli AI ajan/pipeline framework'ü) ile ilgileniyor ve reposunu indirdi.",
    'kullanıcı blockchain, kripto ve finansal/algoritmik trading konularıyla ilgileniyor.',
    "kullanıcının TTS zinciri Edge TTS üzerinden Ahmet sesiyle çalışıyor.",
  ]);
  const r = memory.hygiene({ deep: true });
  const list = memory.entries();
  assert.ok(!list.some((l) => /superpowers reposunu/.test(l)), 'repo indirme gürültüsü düşmeli: ' + JSON.stringify(list));
  assert.ok(!list.some((l) => /pipecat/.test(l)), 'repo+ilgileniyor gürültüsü düşmeli: ' + JSON.stringify(list));
  assert.ok(list.some((l) => /blockchain, kripto/.test(l)), 'konu ilgisi KORUNMALI: ' + JSON.stringify(list));
  assert.ok(list.some((l) => /Edge TTS/.test(l)), 'teknik fact korunmalı: ' + JSON.stringify(list));
  assert.ok(r.removed >= 2, JSON.stringify(r));
});

test('hygiene: yedek yazılır ve dropped listesi döner', () => {
  reset(['aynı kayıt', 'aynı kayıt (tekrar)']);
  const r = memory.hygiene({ deep: true });
  assert.ok(r.dropped && r.dropped.length >= 1, JSON.stringify(r));
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(memory.memDir(), 'backups');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('MEMORY-hygiene-'));
  assert.ok(files.length >= 1, 'hijyen yedeği olmalı');
});

test('hygiene: derin temizlik kapalıyken (deep:false) yalnız birebir dedup', () => {
  reset([
    'kullanıcı A reposunu indirdi',
    'kullanıcı A reposunu indirdi',
  ]);
  const r = memory.hygiene({ deep: false });
  assert.strictEqual(r.removed, 1, JSON.stringify(r));
  assert.strictEqual(r.remaining, 1);
});
