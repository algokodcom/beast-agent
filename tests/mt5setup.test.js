'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const mt5setup = require('../src/agent/mt5setup');

test('mt5setup: common.ini [Experts] bölümü açılır ve idempotent', () => {
  const a = mt5setup.patchExpertsIni('[Common]\nMaxBars=100000\n');
  assert.equal(a.changed, true);
  assert.match(a.text, /\[Experts\]/);
  assert.match(a.text, /AllowLiveTrading=1/);
  assert.match(a.text, /AllowDllImport=1/);
  assert.match(a.text, /Enabled=1/);
  assert.match(a.text, /Api=0/);
  const b = mt5setup.patchExpertsIni(a.text);
  assert.equal(b.changed, false, 'ikinci uygulama değişiklik üretmemeli');
});

test('mt5setup: mevcut [Experts] değerleri güncellenir, diğer bölümler korunur', () => {
  const src = '[Common]\nMaxBars=100000\n[Experts]\nAllowDllImport=0\nEnabled=0\n[Tester]\nAllowDllImport=1\n';
  const r = mt5setup.patchExpertsIni(src);
  assert.equal(r.changed, true);
  /* eksper bölümü değerleri */
  assert.match(r.text, /Enabled=1/);
  assert.match(r.text, /AllowDllImport=1/);
  assert.match(r.text, /AllowLiveTrading=1/);
  assert.match(r.text, /Api=0/);
  /* diğer bölüm dokunulmamış */
  assert.match(r.text, /\[Common\]\r\nMaxBars=100000/);
  assert.match(r.text, /\[Tester\]\r\nAllowDllImport=1/);
  /* okuma yardımcısı */
  assert.equal(mt5setup.readIniValue(r.text, 'Charts', 'ProfileLast'), '');
  assert.equal(mt5setup.readIniValue('[Charts]\nProfileLast=Default\n', 'Charts', 'ProfileLast'), 'Default');
});

test('mt5setup: gerçek MT5 <expert> formatı eklenir (window öncesi), idempotent', () => {
  const chr = '<chart>\r\nid=1\r\nsymbol=EURUSD\r\nwindows_total=1\r\n\r\n<window>\r\nheight=1\r\n</window>\r\n</chart>\r\n';
  const a = mt5setup.injectExpertBlock(chr, 'Beast\\BeastFinance');
  assert.equal(a.changed, true);
  assert.match(a.text, /<expert>/);
  assert.match(a.text, /name=BeastFinance/);
  assert.match(a.text, /path=Experts\\Beast\\BeastFinance\.ex5/);
  assert.match(a.text, /expertmode=5/);
  assert.ok(a.text.indexOf('<expert>') < a.text.indexOf('<window>'), 'blok <window> ÖNCESİNE girmeli');
  const b = mt5setup.injectExpertBlock(a.text, 'Beast\\BeastFinance');
  assert.equal(b.changed, false, 'ikinci uygulama değişiklik üretmemeli');
  assert.equal(b.ours, true);
});

test('mt5setup: eski yanlış formattaki bizim blok düzeltilir', () => {
  const old = '<chart>\r\nid=1\r\nwindows_total=1\r\n\r\n<window>\r\nheight=1\r\n</window>\r\n<expert>\nname=Beast\\BeastFinance\nflags=343\nwindow_num=0\n</expert>\n</chart>\r\n';
  const r = mt5setup.injectExpertBlock(old, 'Beast\\BeastFinance');
  assert.equal(r.changed, true);
  assert.equal((r.text.match(/<expert>/gi) || []).length, 1, 'tek expert bloğu kalmalı');
  assert.ok(r.text.indexOf('<expert>') < r.text.indexOf('<window>'), 'blok window öncesine taşınmalı');
  assert.match(r.text, /expertmode=5/);
  assert.ok(!/flags=343/.test(r.text));
});

test('mt5setup: başka EA varsa grafiğe DOKUNULMAZ', () => {
  const chr = '<chart>\n<expert>\nname=Examples\\MACD Sample\nflags=339\nwindow_num=0\n</expert>\n</chart>\n';
  const r = mt5setup.injectExpertBlock(chr, 'Beast\\BeastFinance');
  assert.equal(r.changed, false);
  assert.equal(r.existing, true);
  assert.equal(r.ours, false);
  assert.equal(r.text, chr);
});

test('mt5setup: UTF-16 .chr çöz/kodla turu bozulmaz', () => {
  const text = '<chart>\r\nid=1\r\nsymbol=XAUUSD\r\n\r\n<window>\r\nheight=1\r\n</window>\r\n</chart>\r\n';
  const buf = mt5setup.encodeText(text, true);
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xfe);
  const dec = mt5setup.decodeText(buf);
  assert.equal(dec.utf16, true);
  assert.equal(dec.text, text);
  const inj = mt5setup.injectExpertBlock(dec.text, 'Beast\\BeastFinance');
  const buf2 = mt5setup.encodeText(inj.text, dec.utf16);
  assert.match(mt5setup.decodeText(buf2).text, /path=Experts\\Beast\\BeastFinance\.ex5/);
});

test('mt5setup: common.ini UTF-16 çöz/kodla + bozuk dosya onarımı', () => {
  const text = '[Common]\r\nLogin=123\r\n[Experts]\r\nAllowLiveTrading=1\r\nAllowDllImport=1\r\nEnabled=1\r\nApi=0\r\n';
  const buf = Buffer.from('\uFEFF' + text, 'utf16le');
  const dec = mt5setup.decodeIni(buf);
  assert.equal(dec.utf16, true);
  assert.match(dec.text, /\[Common\]/);
  assert.match(dec.text, /Login=123/);
  const re = mt5setup.encodeIni(dec.text, dec.utf16);
  assert.equal(re[0], 0xff);
  assert.equal(re[1], 0xfe);
  /* bozuk (UTF-8 sanılıp yazılmış) dosya: baştaki BOM kaybı + her satır sonuna
     girmiş fazladan 0D baytı + ASCII ek → onarılmalı */
  const clean = Buffer.from(text, 'utf16le'); /* BOM'suz gövde */
  const bozuk = [];
  for (let i = 0; i < clean.length; i++) {
    if (
      i + 3 < clean.length &&
      clean[i] === 0x0d && clean[i + 1] === 0x00 && clean[i + 2] === 0x0a && clean[i + 3] === 0x00
    ) {
      bozuk.push(0x0d, 0x00, 0x0d, 0x0a, 0x00);
      i += 3;
      continue;
    }
    bozuk.push(clean[i]);
  }
  const corrupt = Buffer.concat([
    Buffer.from([0xef, 0xbf, 0xbd, 0xef, 0xbf, 0xbd]),
    Buffer.from(bozuk),
    Buffer.from('\r\n[BozukEk]\r\nGarbage=1\r\n', 'utf8'),
  ]);
  const fix = mt5setup.decodeIni(corrupt);
  assert.match(fix.text, /\[Common\]/);
  assert.match(fix.text, /Login=123/);
  assert.match(fix.text, /\[Experts\]/);
  assert.ok(!/\uFFFD/.test(fix.text), 'bozuk karakter kalmamalı');
  assert.ok(!/[^\x00-\x7F]/.test(fix.text.replace(/\r|\n/g, '')), 'CJK çöp satırları temizlenmeli');
  const patched = mt5setup.patchExpertsIni(fix.text);
  assert.equal(patched.changed, false, 'UTF-16 gövdede [Experts] vardı');
});

test('mt5setup: gömülü EA kaynağı geçerli iskelet', () => {
  const src = mt5setup.eaSource();
  assert.ok(src.length > 1500, 'EA kaynağı okunmalı');
  assert.match(src, /OnInit\(\)/);
  assert.match(src, /OnTimer\(\)/);
  assert.match(src, /beast_ea\.json/);
  /* entegrasyon + screenshot katmanı: komut köprüsü, ack, grafik panosu */
  assert.match(src, /beast_cmd\.json/);
  assert.match(src, /beast_cmd_ack\.json/);
  assert.match(src, /beast_note\.json/);
  assert.match(src, /terminal_trade_allowed/);
  assert.match(src, /Comment\(/);
  assert.match(src, /OBJ_HLINE/);
  /* MQL5'te FILE_UTF8 YOK — derleme hatası: FILE_UNICODE kullanılmalı */
  assert.ok(!/FILE_UTF8/.test(src), 'FILE_UTF8 MQL5\'te tanımsız');
  assert.match(src, /FILE_UNICODE/);
});
