'use strict';

/* Sıfır bağımlılıklı .xlsx okuma/yazma — zip (store/deflate) + minimal OOXML.
   Okuma: EOCD → central directory → zlib.inflateRawSync → workbook/rels/
   sharedStrings/sheet XML ayrıştırma. Formüller önbellek değerleriyle okunur;
   yaygın tarih numFmt'leri tanınır ve ISO string'e çevrilir.
   Yazma: geçerli minimal paket üretir (inlineStr — sharedStrings yazmaz).
   Excel/Sheets/LibreOffice açar, sayfa kodlaması UTF-8.
   Not: zip64 yalnız temel seviyede desteklenir (xlsx'ler küçüktür). */

const fs = require('fs');
const zlib = require('zlib');

/* ---------- zip okuma ---------- */

function zipRead(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('xlsx: zip EOCD bulunamadı — dosya bozuk ya da eski .xls biçimi');

  let count = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);

  /* zip64: EOCD locator (eocd-20) → zip64 EOCD'den gerçek değerleri al */
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z64 = buf.readBigUInt64LE(eocd - 20 + 8);
    if (buf.readUInt32LE(Number(z64)) === 0x06064b50) {
      count = Number(buf.readBigUInt64LE(Number(z64) + 32));
      cdOff = Number(buf.readBigUInt64LE(Number(z64) + 48));
    }
  }

  const files = new Map();
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commLen;
    if (name.endsWith('/')) continue; /* dizin girişi */
    if (lho + 30 > buf.length) continue;
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + csize);
    files.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
  }
  if (!files.size) throw new Error('xlsx: zip girişi okunamadı');
  return files;
}

/* ---------- zip yazma ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function zipWrite(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((now.getSeconds() / 2) & 31);
  const dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const deflated = zlib.deflateRawSync(e.data);
    const method = deflated.length < e.data.length ? 8 : 0;
    const data = method === 8 ? deflated : e.data;
    const crc = crc32(e.data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));

    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

/* ---------- xml yardımcıları ---------- */

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

function unescXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ENT[e]);
}

function escText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;')
    .replace(/\n/g, '&#xA;')
    .replace(/\t/g, '&#x9;');
}

function escAttr(s) {
  return escText(s).replace(/"/g, '&quot;');
}

function colToName(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function refToCell(ref) {
  const m = /^([A-Z]+)(\d+)$/i.exec(String(ref || '').trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: parseInt(m[2], 10), col };
}

/* ---------- tarih: excel seri no → ISO string ---------- */

const DATE_BUILTIN = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function serialToString(n) {
  const days = Math.floor(n);
  const frac = n - days;
  /* 1900 sistemi: 1899-12-30 = seri 0 referansı; 60 = hayalet 1900-02-29 */
  if (days === 60) return '1900-02-29';
  const base = days >= 61 ? 25569 : 25568; /* <61'de hayalet gün kayması telafisi */
  const ms = (days - base) * 86400000 + Math.round(frac * 86400000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return String(n);
  const p2 = (x) => String(x).padStart(2, '0');
  const date = d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
  if (frac < 1e-6 && frac > -1e-6) return date;
  return date + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
}

function dateToDateSerial(d) {
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  let days = Math.round(t / 86400000) + 25569;
  /* 1900-03-01 öncesi hayalet gün kayması — pratikte nadir, yine de doğru yaz */
  const y = d.getUTCFullYear();
  if (y < 1900 || (y === 1900 && (d.getUTCMonth() < 2 || (d.getUTCMonth() === 2 && d.getUTCDate() < 1)))) days += 1;
  return days + (t % 86400000) / 86400000;
}

function parseStyles(files) {
  const xml = files.get('xl/styles.xml');
  const dateStyles = new Set();
  if (!xml) return dateStyles;
  const s = xml.toString('utf8');
  const custom = new Map();
  for (const m of s.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/?>/g)) {
    custom.set(Number(m[1]), unescXml(m[2]));
  }
  const isDateFmt = (id) => DATE_BUILTIN.has(id) || (custom.has(id) && /[yYmMdDhHsS]/.test(custom.get(id).replace(/"[^"]*"|\\./g, '')));
  const cx = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(s);
  if (cx) {
    let idx = 0;
    for (const m of cx[1].matchAll(/<xf\b[^>]*?(?:\/>|>)/g)) {
      const nf = /numFmtId="(\d+)"/.exec(m[0]);
      if (nf && isDateFmt(Number(nf[1]))) dateStyles.add(idx);
      idx++;
    }
  }
  return dateStyles;
}

function parseSharedStrings(files) {
  const xml = files.get('xl/sharedStrings.xml');
  if (!xml) return [];
  const out = [];
  const s = xml.toString('utf8');
  for (const m of s.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += unescXml(t[1]);
    if (!text && !/<t[\s>]/.test(m[1])) text = unescXml(m[1].replace(/<[^>]+>/g, ''));
    out.push(text);
  }
  return out;
}

function parseWorkbook(files) {
  const wb = files.get('xl/workbook.xml');
  if (!wb) throw new Error('xlsx: workbook.xml yok — geçerli bir xlsx değil');
  const rels = files.get('xl/_rels/workbook.xml.rels');
  const relMap = new Map();
  if (rels) {
    for (const m of rels.toString('utf8').matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = m[0];
      const id = /Id="([^"]*)"/.exec(tag);
      const target = /Target="([^"]*)"/.exec(tag);
      const ext = /TargetMode="External"/.test(tag);
      if (id && target && !ext) {
        let t = target[1];
        if (t.startsWith('/')) t = t.slice(1);
        else if (!/^(xl\/|\/)/.test(t)) t = 'xl/' + t;
        relMap.set(id[1], t);
      }
    }
  }
  const sheets = [];
  for (const m of wb.toString('utf8').matchAll(/<sheet\b[^>]*>/g)) {
    const tag = m[0];
    const name = /name="([^"]*)"/.exec(tag);
    const rid = /r:id="([^"]*)"/.exec(tag);
    const sid = /sheetId="([^"]*)"/.exec(tag);
    const target = rid && relMap.get(rid[1]);
    if (name && target && files.has(target)) {
      sheets.push({ name: unescXml(name[1]), path: target, ...(sid ? { sheetId: Number(sid[1]) } : {}) });
    }
  }
  if (!sheets.length) throw new Error('xlsx: çalışma sayfası bulunamadı');
  return sheets;
}

function cellValue(attrs, inner, shared, dateStyles) {
  const t = /t="([^"]*)"/.exec(attrs);
  const st = /s="([^"]*)"/.exec(attrs);
  const type = t ? t[1] : 'n';
  if (type === 'inlineStr') {
    let text = '';
    for (const m of inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += unescXml(m[1]);
    return text;
  }
  const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
  const raw = v ? unescXml(v[1]) : '';
  if (type === 's') return shared[Number(raw)] ?? '';
  if (type === 'b') return raw === '1' || /^(true|1)$/i.test(raw);
  if (type === 'e') return raw ? '#' + raw.replace(/^#/, '') : '#HATA';
  if (type === 'str') return raw;
  /* sayı (n) — tarih stiliyse ISO'ya çevir */
  if (raw === '') return '';
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  if (st && dateStyles.has(Number(st[1])) && num > 0) return serialToString(num);
  return num;
}

function parseSheetXml(xml, shared, dateStyles) {
  const rows = [];
  const filled = new Map(); /* rowIndex → { col: value } */
  let maxCol = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const attrs = rm[1] || rm[3] || '';
    const inner = rm[2] || '';
    const rAttr = /r="(\d+)"/.exec(attrs);
    const rowIdx = rAttr ? Number(rAttr[1]) : rows.length + 1;
    const rowMap = new Map();
    let posCol = 0;
    for (const cm of inner.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const cAttrs = cm[1] || '';
      const cInner = cm[2] || '';
      const ref = /r="([A-Z]+\d+)"/.exec(cAttrs);
      const cell = ref ? refToCell(ref[1]) : null;
      const colIdx = cell ? cell.col : posCol + 1;
      posCol = colIdx;
      const val = cellValue(cAttrs, cInner, shared, dateStyles);
      const isEmpty = val === '' || val === null || val === undefined;
      if (!isEmpty) {
        rowMap.set(colIdx, val);
        if (colIdx > maxCol) maxCol = colIdx;
      }
    }
    if (rowMap.size) filled.set(rowIdx, rowMap);
  }
  if (!filled.size) return [];
  const lastRow = Math.max(...filled.keys());
  for (let r = 1; r <= lastRow; r++) {
    const m = filled.get(r);
    const row = [];
    for (let c = 1; c <= maxCol; c++) row.push(m && m.has(c) ? m.get(c) : '');
    rows.push(row);
  }
  /* sondaki boş satır/sütunları kırp */
  while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop();
  let cols = maxCol;
  while (cols > 1 && rows.every((r) => r[cols - 1] === '')) cols--;
  return rows.map((r) => r.slice(0, cols));
}

/* ---------- genel API ---------- */

/* read(bufOrPath) → [{ name, rows }] */
function read(src) {
  const buf = Buffer.isBuffer(src) ? src : fs.readFileSync(src);
  const files = zipRead(buf);
  const shared = parseSharedStrings(files);
  const dateStyles = parseStyles(files);
  const sheets = parseWorkbook(files);
  return sheets.map((sh) => ({ name: sh.name, rows: parseSheetXml(files.get(sh.path).toString('utf8'), shared, dateStyles) }));
}

/* ---------- yazma ---------- */

function sanitizeSheetName(name, i) {
  let n = String(name == null ? '' : name).replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 31);
  return n || 'Sheet' + (i + 1);
}

function cellXml(val, col, row) {
  const ref = colToName(col) + row;
  if (val === null || val === undefined || val === '') return '';
  if (typeof val === 'number' && Number.isFinite(val)) return `<c r="${ref}"><v>${val}</v></c>`;
  if (typeof val === 'boolean') return `<c r="${ref}" t="b"><v>${val ? 1 : 0}</v></c>`;
  if (val instanceof Date && !isNaN(val.getTime())) {
    return `<c r="${ref}" s="1"><v>${dateToDateSerial(val)}</v></c>`;
  }
  let s = String(val);
  if (/^=/.test(s)) {
    /* formül: önbelleksiz — Excel açınca hesaplar; t="str" değil f düğümü */
    return `<c r="${ref}"><f>${escText(s.slice(1))}</f></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escText(s)}</t></is></c>`;
}

function sheetXml(rows) {
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
  const nRows = Math.min(rows.length, 1048576);
  for (let r = 0; r < nRows; r++) {
    const row = rows[r] || [];
    const nCols = Math.min(row.length, 16384);
    let cells = '';
    for (let c = 0; c < nCols; c++) cells += cellXml(row[c], c + 1, r + 1);
    if (cells) out.push(`<row r="${r + 1}">${cells}</row>`);
  }
  out.push('</sheetData></worksheet>');
  return out.join('');
}

/* rows: dizi-dizisi YA DA obje-dizisi (obje modunda anahtarlar başlık olur) */
function normalizeRows(rows) {
  if (!Array.isArray(rows)) throw new Error('rows bir dizi olmalı');
  const isObjects = rows.length && rows.every((r) => r && typeof r === 'object' && !Array.isArray(r) && !(r instanceof Date));
  if (!isObjects) return rows.map((r) => (Array.isArray(r) ? r : [r]));
  const keys = [];
  for (const o of rows) for (const k of Object.keys(o)) if (!keys.includes(k)) keys.push(k);
  return [keys, ...rows.map((o) => keys.map((k) => (o[k] == null ? '' : o[k])))];
}

/* write(sheets) → Buffer ; sheets: [{ name, rows }] */
function write(sheets) {
  const list = (Array.isArray(sheets) ? sheets : [sheets]).map((s, i) => ({
    name: sanitizeSheetName(s && s.name, i),
    rows: normalizeRows(s && s.rows ? s.rows : []),
  }));
  if (!list.length) throw new Error('en az bir sayfa gerekli');

  const entries = [];
  const xmlDecl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

  entries.push({
    name: '[Content_Types].xml',
    data: Buffer.from(
      xmlDecl +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>'
    ),
  });
  entries.push({
    name: '_rels/.rels',
    data: Buffer.from(
      xmlDecl +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'
    ),
  });
  entries.push({
    name: 'xl/workbook.xml',
    data: Buffer.from(
      xmlDecl +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        list.map((s, i) => `<sheet name="${escAttr(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>'
    ),
  });
  entries.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: Buffer.from(
      xmlDecl +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>'
    ),
  });
  entries.push({
    name: 'xl/styles.xml',
    data: Buffer.from(
      xmlDecl +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border/></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>'
    ),
  });
  list.forEach((s, i) => {
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s.rows)) });
  });

  return zipWrite(entries);
}

module.exports = { read, write, zipRead, zipWrite, refToCell, colToName, serialToString, dateToDateSerial, normalizeRows };
