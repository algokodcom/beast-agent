'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const tools = require('../src/agent/tools');
const engine = require('../src/agent/xlsx');

function tmpfile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beast-xlsx-')), name);
}

test('xlsx: zip yaz/ok roundtrip + tüm değer türleri + Türkçe', async () => {
  const p = tmpfile('t1.xlsx');
  const d = new Date(Date.UTC(2024, 0, 15));
  const sheets = [
    {
      name: 'Rapor',
      rows: [
        ['Ürün', 'Adet', 'Fiyat', 'Aktif', 'Tarih'],
        ['Elma & Armut <taze>', 12, 7.5, true, d],
        ['Kiraz', 0, -3.25, false, ''],
      ],
    },
    { name: 'Boş', rows: [] },
  ];
  const w = JSON.parse(await tools.exec('xlsx_write', { path: p, sheets }, { cwd: os.tmpdir() }));
  assert.strictEqual(w.ok, true, JSON.stringify(w));
  assert.ok(w.bytes > 200);
  const r = JSON.parse(await tools.exec('xlsx_read', { path: p }, { cwd: os.tmpdir() }));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.sheet, 'Rapor');
  assert.deepStrictEqual(r.headers, ['Ürün', 'Adet', 'Fiyat', 'Aktif', 'Tarih']);
  assert.deepStrictEqual(r.rows[0], { Ürün: 'Elma & Armut <taze>', Adet: 12, Fiyat: 7.5, Aktif: true, Tarih: '2024-01-15' });
  assert.deepStrictEqual(r.rows[1], { Ürün: 'Kiraz', Adet: 0, Fiyat: -3.25, Aktif: false, Tarih: '' });
});

test('xlsx: obje satırları başlığa dönüşür + çok sayfa + sayfa adıyla okuma', async () => {
  const p = tmpfile('t2.xlsx');
  const sheets = [
    { name: 'Müşteriler', rows: [{ Ad: 'Ali', Yaş: 30 }, { Ad: 'Ayşe', Yaş: 25 }] },
    { name: 'Notlar & \u00d6zet', rows: [['a', 'b'], [1, 2]] },
  ];
  const w = JSON.parse(await tools.exec('xlsx_write', { path: p, sheets }, { cwd: os.tmpdir() }));
  assert.strictEqual(w.ok, true, JSON.stringify(w));
  const r1 = JSON.parse(await tools.exec('xlsx_read', { path: p }, { cwd: os.tmpdir() }));
  assert.strictEqual(r1.sheet, 'Müşteriler');
  assert.deepStrictEqual(r1.rows, [{ Ad: 'Ali', Yaş: 30 }, { Ad: 'Ayşe', Yaş: 25 }]);
  const r2 = JSON.parse(await tools.exec('xlsx_read', { path: p, sheet: 'Notlar & Özet', header_row: false }, { cwd: os.tmpdir() }));
  assert.deepStrictEqual(r2.rows, [['a', 'b'], [1, 2]]);
  const r3 = JSON.parse(await tools.exec('xlsx_read', { path: p, sheet: 2, header_row: false }, { cwd: os.tmpdir() }));
  assert.strictEqual(r3.sheet, 'Notlar & \u00d6zet');
});

test('xlsx: edit hücre güncelleme + satır ekleme + bozulmayan diğer sayfa', async () => {
  const p = tmpfile('t3.xlsx');
  const sheets = [
    { name: 'Data', rows: [['isim', 'puan'], ['ali', 10]] },
    { name: 'Diğer', rows: [['koru', 'beni'], ['x', 1]] },
  ];
  await tools.exec('xlsx_write', { path: p, sheets }, { cwd: os.tmpdir() });
  const e = JSON.parse(
    await tools.exec(
      'xlsx_edit',
      { path: p, sheet: 'Data', updates: [{ cell: 'B2', value: 99 }, { cell: 'C1', value: 'yeni kolon' }], append_rows: [['veli', 55]] },
      { cwd: os.tmpdir() }
    )
  );
  assert.strictEqual(e.ok, true, JSON.stringify(e));
  assert.strictEqual(e.changed, 3);
  const r = JSON.parse(await tools.exec('xlsx_read', { path: p, sheet: 'Data' }, { cwd: os.tmpdir() }));
  assert.deepStrictEqual(r.rows, [
    { isim: 'ali', puan: 99, 'yeni kolon': '' },
    { isim: 'veli', puan: 55, 'yeni kolon': '' },
  ]);
  const other = JSON.parse(await tools.exec('xlsx_read', { path: p, sheet: 'Diğer', header_row: false }, { cwd: os.tmpdir() }));
  assert.deepStrictEqual(other.rows, [['koru', 'beni'], ['x', 1]]);
});

test('xlsx: formül hücresi + kaçış karakterleri + sayfa yok hatası', async () => {
  const p = tmpfile('t4.xlsx');
  await tools.exec('xlsx_write', { path: p, sheets: [{ rows: [['=SUM(A1:A2)', 'a<b>&"\'\nson'], [1, 2]] }] }, { cwd: os.tmpdir() });
  const r = JSON.parse(await tools.exec('xlsx_read', { path: p, header_row: false }, { cwd: os.tmpdir() }));
  /* formül önbelleksiz yazılır → okuma boş döner (Excel açınca hesaplar) */
  assert.strictEqual(r.rows[0][0], '');
  assert.strictEqual(r.rows[0][1], 'a<b>&"\'\nson');

  const r2 = JSON.parse(await tools.exec('xlsx_read', { path: p, sheet: 'yok' }, { cwd: os.tmpdir() }));
  assert.strictEqual(r2.ok, false);
  assert.ok(Array.isArray(r2.sheets));
});

test('xlsx: motor düzeyinde tarih seri dönüşümü', () => {
  assert.strictEqual(engine.serialToString(45306), '2024-01-15'); /* 2024-01-15 */
  assert.strictEqual(engine.serialToString(1), '1900-01-01');
  assert.strictEqual(engine.refToCell('AA10').row, 10);
  assert.strictEqual(engine.refToCell('AA10').col, 27);
  assert.strictEqual(engine.colToName(27), 'AA');
  const buf = engine.write([{ name: 'D', rows: [['t', new Date(Date.UTC(2024, 0, 15))], ['v', 45306]] }]);
  const book = engine.read(buf);
  assert.strictEqual(book[0].rows[0][1], '2024-01-15');
  assert.strictEqual(book[0].rows[1][1], 45306);
});

test('xlsx: olmayan dosya + .xls reddi', async () => {
  const r1 = JSON.parse(await tools.exec('xlsx_read', { path: 'yok.xlsx' }, { cwd: os.tmpdir() }));
  assert.strictEqual(r1.ok, false);
  const r2 = JSON.parse(await tools.exec('xlsx_read', { path: 'eski.xls' }, { cwd: os.tmpdir() }));
  assert.strictEqual(r2.ok, false);
  const r3 = JSON.parse(await tools.exec('xlsx_write', { path: 'cikti.csv', sheets: [{ rows: [['a']] }] }, { cwd: os.tmpdir() }));
  assert.strictEqual(r3.ok, false);
});
