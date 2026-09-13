'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const piper = require('../src/agent/piper');

/* piper: saf durum/liste mantığı — ağ veya indirme YOK */

test('piper: ses listesi + bilinmeyen ses varsayılana düşer', () => {
  assert.ok(piper.VOICES['tr_TR-fahrettin-medium']);
  assert.ok(piper.VOICES['tr_TR-fettah-medium']);
  assert.equal(piper.DEFAULT_VOICE, 'tr_TR-fahrettin-medium');

  const st = piper.status('yok-boyle-ses');
  assert.equal(st.voiceId, piper.DEFAULT_VOICE);
  assert.equal(st.installed, false);
  assert.equal(st.runtime, false);
  assert.equal(st.voice, false);
  assert.equal(st.installing, false);
});

test('piper: bilinen ses sorgusu durum döner (izole BEAST_DATA → kurulu değil)', () => {
  const st = piper.status('en_US-lessac-medium');
  assert.equal(st.voiceId, 'en_US-lessac-medium');
  assert.equal(typeof st.installing, 'boolean');
  assert.equal(piper.voiceInstalled('en_US-lessac-medium'), false);
  assert.equal(piper.runtimeInstalled(), false);
});

test('piper: tuningArgs hız/duraklama/ifadeyi CLI argümanına çevirir', () => {
  assert.deepEqual(piper.tuningArgs({ speed: 1 }), []);

  const a = piper.tuningArgs({ speed: 1.25, sentenceSilence: 0.1, noiseScale: 0.5 });
  const li = a.indexOf('--length_scale');
  assert.ok(li >= 0);
  assert.equal(Number(a[li + 1]), 0.8); // hız 1.25 → length 0.8 (ters oran)
  assert.ok(a.includes('--sentence_silence'));
  assert.ok(a.includes('--noise_scale'));

  /* kelepçe: aşırı hız 0.5-2 aralığına sıkışır (length 1/speed) */
  const b = piper.tuningArgs({ speed: 10 });
  assert.equal(Number(b[b.indexOf('--length_scale') + 1]), 0.5);
});
