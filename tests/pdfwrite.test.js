'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const pdfwrite = require('../src/agent/pdfwrite');

test('parseBlocks: başlık/paragraf/liste/tablo/kod/alıntı ayrıştırma', () => {
  const blocks = pdfwrite.parseBlocks(
    [
      '# H1',
      '',
      'paragraf satır 1',
      'devam satırı',
      '## H2',
      '- madde',
      '2. numaralı',
      '> alıntı',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '```',
      'kod satırı',
      '```',
      '---',
    ].join('\n')
  );
  const types = blocks.map((b) => b.type);
  assert.deepEqual(types, ['h', 'p', 'h', 'li', 'li', 'quote', 'table', 'code', 'hr']);
  assert.equal(blocks[1].text, 'paragraf satır 1 devam satırı'); // ardışık satırlar birleşir
  assert.equal(blocks[3].marker, '\u2022');
  assert.equal(blocks[4].marker, '2.');
  assert.deepEqual(blocks[6].rows, [['A', 'B'], ['1', '2']]); // ayraç satırı atılır
  assert.deepEqual(blocks[7].lines, ['kod satırı']);
});

test('toSpans: **kalın** ve `mono` span\'lere bölünür', () => {
  const s = pdfwrite.toSpans('a **k** b `c` d');
  assert.deepEqual(
    s.map((x) => ({ t: x.t, b: !!x.b, mono: !!x.mono })),
    [
      { t: 'a ', b: false, mono: false },
      { t: 'k', b: true, mono: false },
      { t: ' b ', b: false, mono: false },
      { t: 'c', b: false, mono: true },
      { t: ' d', b: false, mono: false },
    ]
  );
});

test('writePdf: tek çağrıda Türkçe karakterli PDF üretir, metin extract edilebilir', async () => {
  if (!pdfwrite.hasFonts()) return; // Windows fontu yoksa (CI) atla
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-pdf-'));
  const r = await pdfwrite.write({
    outPath: path.join(dir, 'rapor.pdf'),
    title: 'Deneme Raporu ĞÜŞİÖÇ',
    subtitle: 'iç test',
    content:
      '# Başlık ğüşiöç\n\nBu paragrafta **kalın** ve `kod` var.\n- madde bir\n- madde iki\n\n1. adım\n2. adım\n\n| Kolon A | Kolon B |\n|---|---|\n| ğar | şik |\n\n> alıntı satırı ğüş\n\n```\nkod bloğu satırı\n```\n\n---\n\nson paragraf Ğ',
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.pages >= 1);
  assert.ok(fs.existsSync(r.path));
  const buf = fs.readFileSync(r.path);
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');

  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const txt = await parser.getText();
    const body = String((txt && txt.text) || '');
    assert.ok(body.includes('kalın'), 'kalın kelimesi PDF metninde olmalı');
    assert.ok(body.includes('ğ'), 'Türkçe ğ karakteri PDF metninde olmalı');
  } finally {
    await parser.destroy();
  }
});

test('writePdf: .pdf uzantısı eksikse eklenir; boş içerik hata döner', async () => {
  if (!pdfwrite.hasFonts()) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-pdf-'));
  const r = await pdfwrite.write({ outPath: path.join(dir, 'cikti'), content: 'merhaba ğ dünya' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(/\.pdf$/i.test(r.path));
  const e = await pdfwrite.write({ outPath: path.join(dir, 'x.pdf'), content: '   ' });
  assert.equal(e.ok, false);
  assert.ok(String(e.error).includes('content'));
});
