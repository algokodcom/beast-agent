'use strict';

/* Excel araç katmanı: xlsx_read / xlsx_write / xlsx_edit.
   Motor: src/agent/xlsx.js (sıfır bağımlılık — zip + minimal OOXML).
   edit akışı tüm çalışma kitabını okuyup değiştirerek yeniden YAZAR;
   formüller önbellek değerlerine dönüşür (araç açıklamasında belirtilir). */

const fs = require('fs');
const path = require('path');
const engine = require('./xlsx');

const MAX_OUT_ROWS = 500;
const MAX_OUT_CHARS = 120000;

function asRows(v) {
  if (!Array.isArray(v)) return null;
  return v;
}

/* ---------- xlsx_read ---------- */
async function xlsxRead(args, ctx) {
  const p = path.resolve(String((ctx && ctx.cwd) || '.'), String(args.path || ''));
  if (!fs.existsSync(p)) return { ok: false, error: 'dosya bulunamadı: ' + p };
  if (!/\.xlsx$/i.test(p)) return { ok: false, error: 'yalnızca .xlsx okunur — .xls (eski biçim) değil' };
  let book;
  try {
    book = engine.read(p);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  const sheetArg = args.sheet == null ? null : String(args.sheet);
  let sheet = sheetArg == null ? book[0] : book.find((s) => s.name.toLowerCase() === sheetArg.toLowerCase());
  if (!sheet && sheetArg != null && /^\d+$/.test(sheetArg)) sheet = book[Number(sheetArg) - 1];
  if (!sheet) return { ok: false, error: 'sayfa yok: ' + sheetArg, sheets: book.map((s) => s.name) };

  let rows = sheet.rows;
  const total = rows.length;
  const offset = Math.max(1, Math.floor(Number(args.offset) || 1));

  /* header_row: true → 1. satır anahtar; satırlar objeye çevrilir.
     offset sayfa satırına karşılık gelir (1 = başlık satırı dahil başlangıç). */
  if (args.header_row !== false && total > 0) {
    const headRaw = sheet.rows[0] || [];
    const head = headRaw.map((h, i) => (String(h == null ? '' : h).trim() || 'kolon' + (i + 1)));
    const start = Math.max(2, offset); /* veri 2. satırdan başlar */
    const body = sheet.rows.slice(start - 1, start - 1 + Math.min(MAX_OUT_ROWS, Math.max(1, Math.floor(Number(args.limit) || MAX_OUT_ROWS))));
    const outRows = body.map((r) => {
      const o = {};
      head.forEach((h, i) => {
        o[h] = r[i] === undefined ? '' : r[i];
      });
      return o;
    });
    const endRow = start - 1 + body.length;
    return {
      ok: true,
      sheet: sheet.name,
      totalRows: total,
      offset: start,
      headers: head,
      rows: outRows,
      ...(endRow < total ? { note: `satır ${endRow + 1}-${total} için offset=${endRow + 1} ile devam et` } : {}),
    };
  }

  const limit = Math.min(MAX_OUT_ROWS, Math.max(1, Math.floor(Number(args.limit) || MAX_OUT_ROWS)));
  rows = rows.slice(offset - 1, offset - 1 + limit);
  const text = JSON.stringify(rows);
  return {
    ok: true,
    sheet: sheet.name,
    totalRows: total,
    offset,
    rows,
    ...(total > offset - 1 + rows.length ? { note: `satır ${offset + rows.length}+ için offset ile devam et` } : {}),
    ...(text.length > MAX_OUT_CHARS ? { warning: 'çıktı büyük — limit/offset ile parçala' } : {}),
  };
}

/* ---------- xlsx_write ---------- */
async function xlsxWrite(args, ctx) {
  const p = path.resolve(String((ctx && ctx.cwd) || '.'), String(args.path || ''));
  if (!/\.xlsx$/i.test(p)) return { ok: false, error: 'dosya adı .xlsx ile bitmeli' };
  const sheets = Array.isArray(args.sheets) ? args.sheets : null;
  if (!sheets || !sheets.length) return { ok: false, error: 'sheets gerekli: [{ name, rows }] — rows dizi-dizisi ya da obje-dizisi olabilir' };
  let buf;
  try {
    buf = engine.write(sheets);
  } catch (e) {
    return { ok: false, error: 'xlsx üretilemedi: ' + String((e && e.message) || e) };
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p) && args.overwrite === false) return { ok: false, error: 'dosya zaten var ve overwrite:false' };
  fs.writeFileSync(p, buf);
  return {
    ok: true,
    path: p,
    bytes: buf.length,
    sheets: sheets.map((s, i) => ({ name: (s && s.name) || 'Sheet' + (i + 1), rows: Array.isArray(s && s.rows) ? s.rows.length : 0 })),
  };
}

/* ---------- xlsx_edit ---------- */
async function xlsxEdit(args, ctx) {
  const p = path.resolve(String((ctx && ctx.cwd) || '.'), String(args.path || ''));
  if (!fs.existsSync(p)) return { ok: false, error: 'dosya bulunamadı: ' + p };
  if (!/\.xlsx$/i.test(p)) return { ok: false, error: 'yalnızca .xlsx düzenlenir' };
  const hasUpdates = Array.isArray(args.updates) && args.updates.length > 0;
  const hasAppend = Array.isArray(args.append_rows) && args.append_rows.length > 0;
  if (!hasUpdates && !hasAppend) return { ok: false, error: 'updates ([{cell, value}]) ya da append_rows ([[...],...]) gerekli' };

  let book;
  try {
    book = engine.read(p);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  const sheetArg = args.sheet == null ? null : String(args.sheet);
  let sheet = sheetArg == null ? book[0] : book.find((s) => s.name.toLowerCase() === sheetArg.toLowerCase());
  if (!sheet && sheetArg != null && /^\d+$/.test(sheetArg)) sheet = book[Number(sheetArg) - 1];
  if (!sheet) return { ok: false, error: 'sayfa yok: ' + sheetArg, sheets: book.map((s) => s.name) };

  const rows = sheet.rows;
  let changed = 0;

  if (hasUpdates) {
    for (const u of args.updates.slice(0, 2000)) {
      let r = null;
      if (u && typeof u.cell === 'string') r = engine.refToCell(u.cell);
      if (!r && u && Number.isFinite(u.row) && Number.isFinite(u.col)) r = { row: Math.floor(u.row), col: Math.floor(u.col) };
      if (!r || r.row < 1 || r.col < 1) return { ok: false, error: 'geçersiz hücre: ' + JSON.stringify(u).slice(0, 60) };
      while (rows.length < r.row) rows.push([]);
      const row = rows[r.row - 1];
      while (row.length < r.col) row.push('');
      row[r.col - 1] = u.value === undefined ? '' : u.value;
      changed++;
    }
  }
  if (hasAppend) {
    const head = (rows[0] || []).map((h) => String(h == null ? '' : h).trim());
    for (const r of args.append_rows.slice(0, 2000)) {
      if (r && typeof r === 'object' && !Array.isArray(r) && !(r instanceof Date)) {
        /* obje satırı: ilk satırdaki başlıklara göre sütunlanır */
        rows.push(head.map((h) => (h && r[h] !== undefined ? r[h] : '')));
      } else {
        rows.push(Array.isArray(r) ? r : [r]);
      }
      changed++;
    }
  }

  const buf = engine.write(book.map((s) => ({ name: s.name, rows: s.rows })));
  fs.writeFileSync(p, buf);
  return { ok: true, path: p, sheet: sheet.name, changed, totalRows: rows.length };
}

const definitions = [
  {
    type: 'function',
    function: {
      name: 'xlsx_read',
      description:
        'Read an .xlsx workbook: returns sheet rows as JSON. Default: first sheet, first row treated as headers (rows become objects). Use `sheet` (name or 1-based index) for other sheets, `header_row: false` for raw arrays, `offset`/`limit` to paginate big sheets. Dates come back as ISO strings.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the .xlsx file' },
          sheet: { type: 'string', description: 'Sheet name or 1-based index (default: first sheet)' },
          header_row: { type: 'boolean', description: 'Treat first row as headers (default true)' },
          offset: { type: 'number', description: '1-based start row (default 1)' },
          limit: { type: 'number', description: 'Max rows returned (default 500)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xlsx_write',
      description:
        'Create or overwrite an .xlsx file. sheets: [{ name, rows }] where rows is an array of arrays (mixed primitives; Date → date cell) OR an array of objects (keys become the header row). Returns file path and size.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Target .xlsx path' },
          sheets: {
            type: 'array',
            description: 'Sheets to write',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                rows: { type: 'array', description: 'Array of arrays or array of objects' },
              },
              required: ['rows'],
            },
          },
        },
        required: ['path', 'sheets'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'xlsx_edit',
      description:
        'Edit an existing .xlsx in place: update cells (updates: [{cell: "B2", value}]) and/or append rows (append_rows: [[...], ...]) to a sheet, rewriting the file with all sheets intact. NOTE: formulas are replaced by their cached values (recalculate by opening in Excel).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the .xlsx file' },
          sheet: { type: 'string', description: 'Sheet name or 1-based index (default: first sheet)' },
          updates: {
            type: 'array',
            description: 'Cell updates',
            items: {
              type: 'object',
              properties: {
                cell: { type: 'string', description: 'Cell ref like "B2"' },
                value: { description: 'New value (string/number/boolean)' },
              },
              required: ['cell'],
            },
          },
          append_rows: { type: 'array', description: 'Rows to append at the end' },
        },
        required: ['path'],
      },
    },
  },
];

module.exports = { definitions, handlers: { xlsx_read: xlsxRead, xlsx_write: xlsxWrite, xlsx_edit: xlsxEdit } };
