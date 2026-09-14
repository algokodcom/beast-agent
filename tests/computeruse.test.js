'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const cu = require('../src/agent/computeruse');

test('computer use: scaleArgs 1280 tabanlı görüntü koordinatını gerçek ekrana çevirir', () => {
  const cap = { x: 0, y: 0, w: 1920, h: 1080, imgW: 1280, imgH: 720 };
  assert.deepEqual(cu.scaleArgs({ x: 640, y: 360 }, cap), { x: 960, y: 540 });
  assert.deepEqual(cu.scaleArgs({ x: 0, y: 0 }, cap), { x: 0, y: 0 });
  assert.deepEqual(cu.scaleArgs({ x: 1280, y: 720 }, cap), { x: 1920, y: 1080 });
});

test('computer use: scaleArgs çok monitör ofsetini ve drag (x2/y2) hedefini çevirir', () => {
  const cap = { x: 1920, y: -200, w: 1280, h: 720, imgW: 1280, imgH: 720 };
  assert.deepEqual(
    cu.scaleArgs({ x: 100, y: 50, x2: 300, y2: 150 }, cap),
    { x: 2020, y: -150, x2: 2220, y2: -50 }
  );
});

test('computer use: scaleArgs cap yoksa/eksikse koordinatlara dokunmaz', () => {
  assert.deepEqual(cu.scaleArgs({ x: 5 }, null), { x: 5 });
  const cap = { x: 0, y: 0, w: 1920, h: 1080, imgW: 1280, imgH: 720 };
  assert.deepEqual(cu.scaleArgs({ dy: 3 }, cap), { dy: 3 });
});

test('computer use: bilinmeyen op ve eksik parametreler fare oynatmadan hata döner', async () => {
  assert.equal((await cu.act('bilinmeyen-op', {})).ok, false);
  assert.equal((await cu.act('focus', {})).ok, false);
  assert.equal((await cu.act('drag', { x: 1, y: 2 })).ok, false);
  assert.equal((await cu.act('type', {})).ok, false);
  assert.equal((await cu.act('scroll', { dy: 0 })).ok, false);
});

test('computer use: screenSize pozitif çözünürlük döner', async () => {
  const s = await cu.screenSize();
  assert.ok(s.w > 0 && s.h > 0, JSON.stringify(s));
});

test('computer use: bitmapSignature + signatureDiff görsel değişimi doğru ölçer', () => {
  const w = 64;
  const h = 36;
  const bmp = Buffer.alloc(w * h * 4, 30);
  const a = cu.bitmapSignature(bmp, w, h);
  assert.ok(Array.isArray(a) && a.length === 48, '8x6=48 hücre');
  assert.equal(cu.signatureDiff(a, a), 0, 'aynı imza = değişim yok');

  /* üst yarıyı aydınlat → değişim ~%50 olmalı */
  const bmp2 = Buffer.from(bmp);
  for (let y = 0; y < h / 2; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      bmp2[o] = 230;
      bmp2[o + 1] = 230;
      bmp2[o + 2] = 230;
    }
  }
  const b = cu.bitmapSignature(bmp2, w, h);
  const ratio = cu.signatureDiff(a, b);
  assert.ok(ratio !== null && ratio > 0.4 && ratio <= 1, 'üst yarı değişti: ' + ratio);

  /* bozuk girdiler güvenli */
  assert.equal(cu.bitmapSignature(null, w, h), null);
  assert.equal(cu.signatureDiff(a, null), null);
  assert.equal(cu.signatureDiff(a, [1, 2]), null);
});
