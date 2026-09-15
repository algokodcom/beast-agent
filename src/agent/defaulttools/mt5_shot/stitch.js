'use strict';
/* mt5_shot yardımcı: birden çok PNG'yi TEK karede birleştirir (yan yana / alt alta).
   - @napi-rs/canvas uygulamanın node_modules'ından yüklenir; kişisel tool çocuk
     prosesi uygulama klasörü dışında koştuğu için yol BEAST_APP_DIR'den gelir
     (customtools env olarak verir; app.asar → app.asar.unpacked otomatik denenir).
   - Panel başına üst köşeye "SEMBOL · PERİYOT" etiketi çizilir: görsel ajan hangi
     tarafın hangi zaman dilimi olduğunu görüntüden de okur.
   - Toplam boyut sınırı aşılırsa paneller eşit oranda küçültülür. */

const path = require('path');

let cached = undefined;
function loadCanvas() {
  if (cached !== undefined) return cached || null;
  cached = null;
  const cands = [];
  const push = (base) => {
    const b = String(base || '').trim();
    if (!b) return;
    if (!cands.includes(b)) cands.push(b);
    const un = b.replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1');
    if (un !== b && !cands.includes(un)) cands.push(un);
  };
  push(process.env.BEAST_APP_DIR);
  push(path.join(process.env.BEAST_APP_DIR || '', '..'));
  for (const base of cands) {
    try {
      cached = require(path.join(base, 'node_modules', '@napi-rs', 'canvas'));
      if (cached && typeof cached.createCanvas === 'function') break;
    } catch (e) { cached = null; }
  }
  return cached || null;
}

const MAX_W = 4800;      /* birleşik tuval genişlik tavanı */
const MAX_H = 3000;      /* yükseklik tavanı */
const MAX_PX = 9 * 1e6;  /* toplam piksel tavanı (güvenlik) */
const GAP = 8;           /* paneller arası ayırıcı kalınlığı */
const LABEL_H = 30;      /* etiket şeridi yüksekliği */

function pickFont(size) {
  return 'bold ' + size + 'px "Segoe UI", Arial, sans-serif';
}

/* panels: [{ path, label }] · opts: { layout: 'h'|'v' }
   dönüş: { ok:true, buffer, width, height } | { ok:false, error } */
async function compose(panels, opts) {
  const cv = loadCanvas();
  if (!cv) return { ok: false, error: 'görüntü kütüphanesi bulunamadı (@napi-rs/canvas) — tek periyot çekimi kullanın' };
  const { createCanvas, loadImage } = cv;
  const list = (panels || []).filter((p) => p && p.path);
  if (list.length < 2) return { ok: false, error: 'birleştirme için en az 2 panel gerekli' };

  const imgs = [];
  for (const p of list) {
    const im = await loadImage(p.path);
    imgs.push({ img: im, label: String(p.label || ''), w: im.width, h: im.height });
  }

  const layout = String((opts && opts.layout) || 'h').toLowerCase() === 'v' ? 'v' : 'h';
  let cellW = 0, cellH = 0;
  if (layout === 'h') {
    cellW = Math.max(...imgs.map((i) => i.w));
    cellH = Math.max(...imgs.map((i) => i.h));
  } else {
    cellW = Math.max(...imgs.map((i) => i.w));
    cellH = Math.max(...imgs.map((i) => i.h));
  }
  const n = imgs.length;
  let W = layout === 'h' ? cellW * n + GAP * (n - 1) : cellW;
  let H = layout === 'h' ? cellH : cellH * n + GAP * (n - 1);

  /* boyut tavanları: eşit oranda küçült */
  let scale = 1;
  if (W > MAX_W) scale = Math.min(scale, MAX_W / W);
  if (H > MAX_H) scale = Math.min(scale, MAX_H / H);
  if (W * H * scale * scale > MAX_PX) scale = Math.min(scale, Math.sqrt(MAX_PX / (W * H)));
  if (scale < 1) {
    cellW = Math.max(320, Math.floor(cellW * scale));
    cellH = Math.max(200, Math.floor(cellH * scale));
    W = layout === 'h' ? cellW * n + GAP * (n - 1) : cellW;
    H = layout === 'h' ? cellH : cellH * n + GAP * (n - 1);
  }

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b0b0b';
  ctx.fillRect(0, 0, W, H);

  imgs.forEach((p, i) => {
    const x = layout === 'h' ? i * (cellW + GAP) : 0;
    const y = layout === 'h' ? 0 : i * (cellH + GAP);
    ctx.drawImage(p.img, x, y, cellW, cellH);
    /* ayırıcı çizgi */
    if (i > 0) {
      ctx.fillStyle = '#3a3a3a';
      if (layout === 'h') ctx.fillRect(x - GAP, 0, GAP, H);
      else ctx.fillRect(0, y - GAP, W, GAP);
    }
    /* etiket: sol üstte koyu şerit + parlak metin */
    if (p.label) {
      try {
        ctx.font = pickFont(20);
        const tw = Math.min(cellW - 24, Math.ceil(ctx.measureText(p.label).width) + 20);
        ctx.fillStyle = 'rgba(0,0,0,0.78)';
        ctx.fillRect(x + 6, y + 6, Math.max(60, tw), LABEL_H);
        ctx.fillStyle = '#00e676';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.label, x + 15, y + 6 + LABEL_H / 2 + 1);
      } catch (e) {}
    }
  });

  let buffer = null;
  try { buffer = canvas.toBuffer('image/png'); } catch (e) {
    return { ok: false, error: 'PNG kodlanamadı: ' + (e && e.message ? e.message : String(e)) };
  }
  return { ok: true, buffer, width: W, height: H };
}

function available() {
  return !!loadCanvas();
}

module.exports = { compose, available };
