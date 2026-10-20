'use strict';

/* Telefon TTS akışı — cümle parçalayıcı birim testleri.
   Amaç: ilk parça kısa (hızlı ilk ses), sonrakiler makul uzunlukta;
   cümle/kelime bütünlüğü bozulmasın, boş parça üretilmesin. */

const test = require('node:test');
const assert = require('node:assert');
const { chunks, sentenceParts } = require('../src/agent/ttsstream.js');

test('ttsstream: kısa cevap tek parça kalır', () => {
  const out = chunks('Merhaba! Nasılsın?');
  assert.deepStrictEqual(out, ['Merhaba! Nasılsın?']);
});

test('ttsstream: boş metin → boş dizi', () => {
  assert.deepStrictEqual(chunks(''), []);
  assert.deepStrictEqual(chunks('   \n\t '), []);
  assert.deepStrictEqual(chunks(null), []);
});

test('ttsstream: cümle sonları doğru ayrılır, ondalık sayı bölünmez', () => {
  const parts = sentenceParts('Saat 3.14 olabilir. Dr. Ahmet geldi! Gerçekten mi?');
  assert.deepStrictEqual(parts, ['Saat 3.14 olabilir.', 'Dr.', 'Ahmet geldi!', 'Gerçekten mi?']);
  /* chunks(): kısaltma "Dr." tek başına parça olarak kalmaz */
  const out = chunks('Saat 3.14 olabilir. Dr. Ahmet geldi! Gerçekten mi?');
  assert.ok(out.some((c) => c.includes('Dr. Ahmet geldi!')), JSON.stringify(out));
  assert.ok(!out.includes('Dr.'), JSON.stringify(out));
});

test('ttsstream: ilk parça kısa, sonrakiler sınırı aşmaz', () => {
  const text = [
    'Bugün hava çok güzel ve dışarıda uzun bir yürüyüş yapmayı düşünüyorum.',
    'Öğleden sonra toplantı var, akşama kadar sürecek.',
    'Yarın yağmur yağacakmış; şemsiyeni yanına almayı unutma.',
    'Hafta sonu için bir planın var mı?',
  ].join(' ');
  const out = chunks(text);
  assert.ok(out.length >= 2, 'uzun metin birden çok parçaya ayrılmalı: ' + JSON.stringify(out));
  assert.ok(out[0].length <= 70, 'ilk parça kısa olmalı: ' + out[0].length);
  for (const c of out) {
    assert.ok(c.trim().length > 0, 'boş parça olmamalı');
    assert.ok(c.length <= 210, 'parça çok uzun: ' + c.length + ' — ' + c);
  }
});

test('ttsstream: tek uzun cümlede ilk parça 60 karakteri aşmaz', () => {
  const text = 'Bugün hava gerçekten çok güzel ve dışarıda uzun bir yürüyüş yapmayı düşünüyorum ama önce kahvaltı hazırlayalım.';
  const out = chunks(text);
  assert.ok(out.length >= 2, JSON.stringify(out));
  assert.ok(out[0].length <= 60, 'ilk parça çok uzun: ' + out[0].length + ' — ' + out[0]);
  assert.ok(out.join(' ').replace(/\s+/g, ' ').trim() === text, 'metin kaybolmamalı');
});

test('ttsstream: noktalama olmayan uzun cümle kelime ortasından bölünmez', () => {
  const word = 'kelime';
  const text = Array.from({ length: 80 }, () => word).join(' ');
  const out = chunks(text);
  assert.ok(out.length > 1);
  for (const c of out) {
    assert.ok(!c.startsWith('elime'), 'kelime ortasından bölünmüş: ' + c);
    assert.ok(!c.endsWith('keli'), 'kelime ortasından bölünmüş: ' + c);
    assert.ok(c.length <= 210);
  }
});

test('ttsstream: çok kısa son parça öncekine yapışır', () => {
  const out = chunks('Bu bir deneme cümlesidir ve yeterince uzundur. Tamam.');
  assert.ok(out.length === 1, JSON.stringify(out));
});
