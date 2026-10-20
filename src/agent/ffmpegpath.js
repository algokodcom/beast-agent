/* FFMPEG YOLU BULUCU — merkezi çözüm
   ffmpeg-static'in binary'si bazen .postinstall atlandığı için İNMEZ
   (npm --ignore-scripts, manuel kopyalama vs.). O durumda tüm ses işleri
   (WhatsApp/mobil STT transkripti, TTS → OGG/Opus, Beast Studio) çöker.
   Kapsamlı zincir: ffmpeg-static (varsa) → ortam değişkeni → sistem PATH.
   Sonuç önbelleklenir — spawnSync 'where' çağrısı pahalıdır. */
const fs = require('fs');

let cached = undefined; /* '' = hiçbiri yok */

function staticPath() {
  try {
    const p = String(require('ffmpeg-static') || '');
    return p && fs.existsSync(p) ? p : '';
  } catch {
    return '';
  }
}

function envPath() {
  for (const k of ['FFMPEG_PATH', 'FFMPEG_BINARY_PATH', 'FFMPEG_BIN']) {
    const v = String(process.env[k] || '').trim();
    if (v && fs.existsSync(v)) return v;
  }
  return '';
}

function pathSearch() {
  try {
    const cp = require('child_process');
    if (process.platform === 'win32') {
      const r = cp.spawnSync('where', ['ffmpeg'], { windowsHide: true, encoding: 'utf8' });
      const first = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l && l.toLowerCase().endsWith('.exe'));
      if (first && fs.existsSync(first)) return first;
    } else {
      const r = cp.spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
      const first = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (first && fs.existsSync(first)) return first;
    }
  } catch {}
  return '';
}

function resolveFfmpegPath() {
  if (cached !== undefined) return cached;
  cached = staticPath() || envPath() || pathSearch();
  return cached;
}

/* STT durum kartı / İntegrasyonlar paneli için: bulundu mu, hangi yol */
function ffmpegStatus() {
  const p = resolveFfmpegPath();
  return { found: !!p, path: p, staticOk: !!staticPath() };
}

module.exports = { resolveFfmpegPath, ffmpegStatus };
