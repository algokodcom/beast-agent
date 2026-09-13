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
