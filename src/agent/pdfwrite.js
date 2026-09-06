'use strict';

/* Beast PDF ÜRETİCİ — tek çağrıda kusursuz, Türkçe-güvenli PDF.
   pdf-lib + @pdf-lib/fontkit ile Windows TTF gömer (ğ ş ı İ Ğ Ş İ Ö Ü garantili;
   Helvetica gibi standard fontlar bunları BASAMAZ). Markdown-lite ayrıştırır:
   # ## ### başlıklar, paragraf, -/* bullet, 1. numaralı liste, **bold**,
   `kod`, | tablo satırları |, > alıntı, ``` kod bloğu. Otomatik satır
   kaydırma + sayfa geçişi + sayfa numarası + başlık bloğu.
   Ajanın elle .js script yazıp font yolu/uğraşmasına GEREK YOK — pdf_write aracı bunu çağırır. */

const fs = require('fs');
const path = require('path');

/* Türkçe glifleri TAM kapsayan Windows sistem fontları — sırayla denenir.
   [normal, bold, mono] */
const FONT_SETS = [
  ['C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/segoeuib.ttf', 'C:/Windows/Fonts/consola.ttf'],
  ['C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/consola.ttf'],
  ['C:/Windows/Fonts/calibri.ttf', 'C:/Windows/Fonts/calibrib.ttf', 'C:/Windows/Fonts/consola.ttf'],
  ['C:/Windows/Fonts/tahoma.ttf', 'C:/Windows/Fonts/tahomabd.ttf', 'C:/Windows/Fonts/consola.ttf'],
];

function firstFont() {
  for (const set of FONT_SETS) {
    if (set.slice(0, 2).every((f) => fs.existsSync(f))) return set;
  }
  return null;
}

function hasFonts() {
  return !!firstFont();
}

const CONTENT_CAP = 300000;

/* ---------- markdown-lite → bloklar ---------- */

function parseBlocks(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i].replace(/\t/g, '    '));
        i++;
      }
      i++; // kapanış fence (ya da EOF)
      blocks.push({ type: 'code', lines: buf });
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      blocks.push({ type: 'h', level: m[1].length, text: m[2].replace(/\s*#+\s*$/, '') });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) {
      blocks.push({ type: 'quote', text: m[1] });
      i++;
      continue;
    }
    if ((m = line.match(/^[-*•]\s+(.*)$/))) {
      blocks.push({ type: 'li', marker: '\u2022', text: m[1] });
      i++;
      continue;
    }
    if ((m = line.match(/^(\d{1,3})[.)]\s+(.*)$/))) {
      blocks.push({ type: 'li', marker: m[1] + '.', text: m[2] });
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i]
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) rows.push(cells);
        i++;
      }
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }
    /* paragraf: özel blok başlatmayan ardışık satırlar birleşir */
    const para = [line];
    i++;
    while (i < lines.length) {
      const l2 = lines[i].trim();
      if (
        !l2 ||
        /^(#{1,3}\s|[-*•]\s|\d{1,3}[.)]\s|>|```|\|)/.test(l2) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(l2)
      )
        break;
      para.push(l2);
      i++;
    }
    blocks.push({ type: 'p', text: para.join(' ') });
  }
  return blocks;
}

/* ---------- inline: **bold** ve `mono` → span dizisi ---------- */

function toSpans(text) {
  const spans = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) spans.push({ t: text.slice(last, m.index), b: false });
    if (m[1]) spans.push({ t: m[2], b: true });
    else spans.push({ t: m[4], b: false, mono: true });
    last = re.lastIndex;
  }
  if (last < text.length) spans.push({ t: text.slice(last), b: false });
  return spans.length ? spans : [{ t: '', b: false }];
}

/* ---------- satır kaydırma: span'ler → [token] satırları ---------- */

function wrapSpans(spans, fontFor, size, maxW) {
  const tokens = [];
  for (const s of spans) {
    const parts = s.t.split(/(\s+)/);
    for (const w of parts) {
      if (!w) continue;
      tokens.push({ w, b: !!s.b, mono: !!s.mono, space: /^\s+$/.test(w) });
    }
  }
  const widthOf = (tk) => {
    try {
      return fontFor(tk).widthOfTextAtSize(tk.w, size);
    } catch {
      return tk.w.length * size * 0.6;
    }
  };
  const lines = [];
  let cur = [];
  let curW = 0;
  const flush = () => {
    while (cur.length && cur[cur.length - 1].space) cur.pop();
    if (cur.length) lines.push(cur);
    cur = [];
    curW = 0;
  };
  for (const tk of tokens) {
    if (tk.space) {
      if (cur.length) {
        cur.push(tk);
        curW += widthOf(tk);
      }
      continue;
    }
    let w = widthOf(tk);
    /* tek kelime satırdan genişse karakter karakter böl (uzun URL/link emniyeti) */
    if (w > maxW) {
      flush();
      let chunk = '';
      let chunkW = 0;
      for (const ch of tk.w) {
        const cw = (() => {
          try {
            return fontFor(tk).widthOfTextAtSize(ch, size);
          } catch {
            return size * 0.6;
          }
        })();
        if (chunk && chunkW + cw > maxW) {
          lines.push([{ w: chunk, b: tk.b, mono: tk.mono, space: false, hard: true }]);
          chunk = ch;
          chunkW = cw;
        } else {
          chunk += ch;
          chunkW += cw;
        }
      }
      if (chunk) {
        cur = [{ w: chunk, b: tk.b, mono: tk.mono, space: false }];
        curW = chunkW;
      }
      continue;
    }
    if (curW + w > maxW) flush();
    cur.push(tk);
    curW += w;
  }
  flush();
  return lines;
}

/* drawTextSpan'lı satır: token dizisini çizer, son x döner */
function drawTokenLine(page, line, x, y, fontFor, size, color) {
  let cx = x;
  for (const tk of line) {
    if (tk.space) {
      try {
        cx += fontFor(tk).widthOfTextAtSize(tk.w, size);
      } catch {
        cx += tk.w.length * size * 0.6;
      }
      continue;
    }
    try {
      page.drawText(tk.w, { x: cx, y, size, font: fontFor(tk), color });
      cx += fontFor(tk).widthOfTextAtSize(tk.w, size);
    } catch {
      cx += tk.w.length * size * 0.6;
    }
  }
  return cx;
}

function lineCount(lines) {
  return Math.max(1, lines.length);
}

/* ---------- ana üretici ---------- */

async function writePdf({ outPath, title, subtitle, content, workspace }) {
  try {
    const raw = String((content == null ? '' : content) || '');
    if (!raw.trim()) return { ok: false, error: 'content gerekli' };
    const outRaw = String(outPath || '').trim();
    if (!outRaw) return { ok: false, error: 'path gerekli' };
    let abs = path.isAbsolute(outRaw) ? outRaw : path.join(String(workspace || process.cwd()), outRaw);
    if (!/\.pdf$/i.test(abs)) abs += '.pdf';

    const fonts = firstFont();
    if (!fonts) {
      return {
        ok: false,
        error:
          'Türkçe destekli Windows TTF bulunamadı (Segoe UI/Arial/Calibri/Tahoma) — pdf skill\u2019indeki elle şablonu kullan',
      };
    }

    const { PDFDocument, rgb } = require('pdf-lib');
    const fontkit = require('@pdf-lib/fontkit');
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const [fReg, fBold, fMono] = fonts;
    const reg = await doc.embedFont(fs.readFileSync(fReg), { subset: true });
    let bold = reg;
    try {
      if (fs.existsSync(fBold)) bold = await doc.embedFont(fs.readFileSync(fBold), { subset: true });
    } catch {}
    let mono = reg;
    try {
      if (fMono && fs.existsSync(fMono)) mono = await doc.embedFont(fs.readFileSync(fMono), { subset: true });
    } catch {}

    const PAGE_W = 595.28;
    const PAGE_H = 841.89;
    const MX = 56;
    const MT = 64;
    const MB = 76;
    const availW = PAGE_W - 2 * MX;
    const textC = rgb(0.13, 0.13, 0.16);
    const mutedC = rgb(0.42, 0.45, 0.5);
    const accentC = rgb(0.15, 0.35, 0.6);
    const codeBgC = rgb(0.95, 0.96, 0.97);
    const rowBgC = rgb(0.96, 0.96, 0.98);

    let page = doc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MT;

    const newPage = () => {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MT;
    };
    const ensure = (h) => {
      if (y - h < MB) newPage();
    };

    const fontFor = (tk) => (tk.mono ? mono : tk.b ? bold : reg);
    const H_SIZES = { 1: 20, 2: 15.5, 3: 13 };

    /* başlık bloğu */
    const titleText = String(title || '').trim();
    if (titleText) {
      const tSpans = [{ t: titleText, b: true }];
      const tLines = wrapSpans(tSpans, fontFor, 22, availW);
      for (const ln of tLines) {
        ensure(30);
        drawTokenLine(page, ln, MX, y - 22, fontFor, 22, textC);
        y -= 30;
      }
      const sub = String(subtitle || '').trim();
      if (sub) {
        const sLines = wrapSpans(toSpans(sub), fontFor, 10.5, availW);
        for (const ln of sLines) {
          ensure(16);
          drawTokenLine(page, ln, MX, y - 10, fontFor, 10.5, mutedC);
          y -= 16;
        }
      }
      y -= 6;
      page.drawLine({
        start: { x: MX, y },
        end: { x: PAGE_W - MX, y },
        thickness: 1,
        color: accentC,
      });
      y -= 22;
    }

    const blocks = parseBlocks(raw.slice(0, CONTENT_CAP));

    /* title verildiyse içeriğin başındaki AYNI H1'i at (çift başlık olmasın) */
    if (titleText && blocks.length && blocks[0].type === 'h' && blocks[0].level === 1) {
      const norm = (s) =>
        String(s || '')
          .toLocaleLowerCase('tr')
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .trim();
      if (norm(blocks[0].text) === norm(titleText)) blocks.shift();
    }

    const BODY = 10.5;
    const LINE = BODY * 1.42;

    for (const b of blocks) {
      if (b.type === 'h') {
        const size = H_SIZES[b.level] || 13;
        const above = b.level === 1 ? 16 : b.level === 2 ? 13 : 10;
        const below = b.level === 1 ? 10 : 6;
        y -= above;
        ensure(size * 1.4 + below);
        const lines = wrapSpans(toSpans(b.text), fontFor, size, availW);
        for (const ln of lines) {
          ensure(size * 1.45);
          drawTokenLine(page, ln, MX, y - size, fontFor, size, textC);
          y -= size * 1.45;
        }
        if (b.level === 1) {
          y -= 4;
          page.drawLine({
            start: { x: MX, y },
            end: { x: MX + 42, y },
            thickness: 1.4,
            color: accentC,
          });
        }
        y -= below;
      } else if (b.type === 'p') {
        const lines = wrapSpans(toSpans(b.text), fontFor, BODY, availW);
        for (const ln of lines) {
          ensure(LINE);
          drawTokenLine(page, ln, MX, y - BODY, fontFor, BODY, textC);
          y -= LINE;
        }
        y -= LINE * 0.55;
      } else if (b.type === 'li') {
        const lines = wrapSpans(toSpans(b.text), fontFor, BODY, availW - 24);
        const mW = (() => {
          try {
            return bold.widthOfTextAtSize(b.marker, BODY);
          } catch {
            return 12;
          }
        })();
        lines.forEach((ln, idx) => {
          ensure(LINE);
          if (idx === 0) {
            try {
              page.drawText(b.marker, { x: MX + 2, y: y - BODY, size: BODY, font: bold, color: accentC });
            } catch {}
          }
          drawTokenLine(page, ln, MX + 24, y - BODY, fontFor, BODY, textC);
          y -= LINE;
        });
        y -= LINE * 0.28;
      } else if (b.type === 'quote') {
        const lines = wrapSpans(toSpans(b.text), fontFor, BODY, availW - 18);
        y -= 3;
        ensure(LINE * lineCount(lines) + 6);
        const top = y + LINE * 0.2;
        page.drawLine({
          start: { x: MX + 4, y: top - LINE * lineCount(lines) },
          end: { x: MX + 4, y: top },
          thickness: 2,
          color: accentC,
        });
        for (const ln of lines) {
          drawTokenLine(page, ln, MX + 18, y - BODY, fontFor, BODY, mutedC);
          y -= LINE;
        }
        y -= LINE * 0.55;
      } else if (b.type === 'code') {
        const CS = 9.5;
        const CL = CS * 1.4;
        /* kod satırları: mono genişliğine göre SERT böl (wrapSpans değil —
           boşluk korunsun, sekme 4 boşluk) */
        b._wrapped = b.lines
          .map((l) => {
            const out = [];
            let cur = l;
            while (cur.length) {
              let cut = cur.length;
              try {
                while (cut > 0 && mono.widthOfTextAtSize(cur.slice(0, cut), CS) > availW - 24) cut = Math.floor(cut * 0.92);
              } catch {
                cut = Math.min(cur.length, 90);
              }
              if (cut <= 0) cut = 1;
              out.push(cur.slice(0, cut));
              cur = cur.slice(cut);
            }
            return out.length ? out : [''];
          })
          .flat();
        const nLines = Math.max(1, b._wrapped.length);
        ensure(CL * nLines + 14);
        const top = y + 8;
        const boxH = CL * nLines + 10;
        page.drawRectangle({
          x: MX - 4,
          y: top - boxH,
          width: availW + 8,
          height: boxH,
          color: codeBgC,
        });
        for (const cl of b._wrapped) {
          try {
            page.drawText(cl, { x: MX + 6, y: y - CS, size: CS, font: mono, color: textC });
          } catch {}
          y -= CL;
        }
        y -= 10;
      } else if (b.type === 'hr') {
        ensure(18);
        y -= 8;
        page.drawLine({
          start: { x: MX, y },
          end: { x: PAGE_W - MX, y },
          thickness: 0.7,
          color: rgb(0.85, 0.86, 0.9),
        });
        y -= 14;
      } else if (b.type === 'table') {
        const TS = 9.5;
        const TL = TS * 1.38;
        const rows = b.rows;
        const nCol = Math.max(...rows.map((r) => r.length));
        if (nCol <= 0 || nCol > 12) continue;
        const gap = 6;
        const colW = (availW - gap * (nCol - 1)) / nCol;
        const cellLines = (text) => wrapSpans(toSpans(String(text || '')), fontFor, TS, colW - 8);
        const rendered = rows.map((r) => {
          const cells = [];
          for (let c = 0; c < nCol; c++) cells.push(cellLines(r[c] || ''));
          return cells;
        });
        for (let r = 0; r < rendered.length; r++) {
          const isHead = r === 0;
          const nLines = Math.max(...rendered[r].map((cl) => cl.length), 1);
          const rowH = TL * nLines + 8;
          ensure(rowH + 2);
          if (isHead) {
            page.drawRectangle({
              x: MX - 4,
              y: y - rowH + 4,
              width: availW + 8,
              height: rowH,
              color: rowBgC,
            });
          }
          for (let c = 0; c < nCol; c++) {
            let cy = y;
            for (const ln of rendered[r][c]) {
              const spans = isHead ? ln.map((t) => ({ ...t, b: true })) : ln;
              drawTokenLine(page, spans, MX + c * (colW + gap) + 4, cy - TS, fontFor, TS, textC);
              cy -= TL;
            }
          }
          y -= rowH;
        }
        y -= 10;
      }
    }

    /* sayfa numaraları: toplam sayı üretilince ikinci geçişte basılır */
    const docTitle = String(title || '').slice(0, 60);
    const pages = doc.getPages();
    pages.forEach((pg, idx) => {
      const label = `Sayfa ${idx + 1} / ${pages.length}`;
      try {
        const w = reg.widthOfTextAtSize(label, 8);
        pg.drawText(label, { x: PAGE_W - MX - w, y: 30, size: 8, font: reg, color: mutedC });
        if (docTitle) pg.drawText(docTitle, { x: MX, y: 30, size: 8, font: reg, color: mutedC });
      } catch {}
    });

    const bytes = await doc.save();
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(bytes));
    return {
      ok: true,
      path: abs,
      name: path.basename(abs),
      pages: pages.length,
      bytes: bytes.length,
      note: 'PDF üretildi (Türkçe font gömülü) — kullanıcıya ulaşmak için send_file çağır',
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = { writePdf, write: writePdf, parseBlocks, toSpans, firstFont, hasFonts };
