'use strict';

/* ---------- Obscura entegrasyonu ----------
   Obscura (github.com/h4ckf0r0day/obscura): Rust tabanlı stealth headless
   tarayıcı — anti-detect + V8 JS + gerçek rendering, Chromium'suz.
   Beast kullanımı:
   1) Kurulum: releases'taki Windows stealth zip'i %APPDATA%\beast\obscura'ya
      açılır (obscura.exe + obscura-worker.exe). İlk açılışta OTOMATİK kurulur.
   2) Arama: `obscura fetch https://html.duckduckgo.com/html/?q=...` çıktısı
      DDG sonuç ayrıştırıcısıyla results'a döner — web_search zincirinin
      sıralı bir motoru (Ayarlar → Web Arama'dan sıra değiştirilebilir). */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile, spawn } = require('child_process');

const RELEASE_BASE = 'https://github.com/h4ckf0r0day/obscura/releases/latest/download/';
const WINDOWS_ZIP = 'obscura-x86_64-windows-stealth.zip';
const MAX_ZIP_BYTES = 250 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 25000;
/* content-length gelmezse yüzde tahmini için yaklaşık boyut (stealth zip ≈74 MB) */
const EST_ZIP_BYTES = 74 * 1024 * 1024;

/* Beast Agent PAKETİNE gömülü zip (vendor/) — varsa HİÇ indirme yapılmaz */
function bundledZip() {
  const p = path.join(__dirname, '..', '..', 'vendor', 'obscura.zip');
  try { return fs.existsSync(p) ? p : null; } catch { return null; }
}

function obscuraDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'beast', 'obscura');
}

function obscuraExe() {
  return path.join(obscuraDir(), 'obscura.exe');
}

function obscuraInstalled() {
  try { return fs.existsSync(obscuraExe()); } catch { return false; }
}

/* kurulan varyant işareti: stealth zip'te --stealth bayrağı geçerli */
function markVariant(v) {
  try { fs.writeFileSync(path.join(obscuraDir(), 'variant.txt'), String(v || 'stealth') + '\n', 'utf8'); } catch {}
}

function readVariant() {
  try { return String(fs.readFileSync(path.join(obscuraDir(), 'variant.txt'), 'utf8')).trim() || 'stealth'; } catch { return 'stealth'; }
}

/* bina sağ mı: --help 10 sn içinde cevap veriyor mu (oturum başına tek deneme) */
let _okProbe = null;
function obscuraOk() {
  if (!obscuraInstalled()) return Promise.resolve(false);
  if (_okProbe) return _okProbe;
  _okProbe = new Promise((resolve) => {
    try {
      execFile(obscuraExe(), ['--help'], { timeout: 10000, windowsHide: true }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
  return _okProbe;
}

function httpsDownload(url, redirectsLeft = 5, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'BeastAgent/1.0 (+obscura bootstrap)' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(httpsDownload(new URL(res.headers.location, url).toString(), redirectsLeft - 1, signal, onProgress));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`indirme başarısız: HTTP ${res.statusCode}`));
      }
      const total = Number(res.headers['content-length']) || EST_ZIP_BYTES;
      const chunks = [];
      let size = 0;
      let lastPct = -1;
      const tick = () => {
        /* yüzdeyi INDIRME fazının %1-88 aralığına map et; %1'lik adımda bildir */
        const pct = 1 + Math.min(88, Math.floor((size / total) * 88));
        if (typeof onProgress === 'function' && pct !== lastPct) {
          lastPct = pct;
          try { onProgress({ pct, phase: 'indiriliyor', loaded: size, total }); } catch {}
        }
      };
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_ZIP_BYTES) {
          req.destroy(new Error('dosya çok büyük'));
          return;
        }
        chunks.push(c);
        tick();
      });
      res.on('end', () => {
        tick();
        resolve(Buffer.concat(chunks));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) return reject(new Error('iptal'));
      signal.addEventListener('abort', () => req.destroy(new Error('iptal')), { once: true });
    }
  });
}

function psExpand(zipPath, destDir) {
  return new Promise((resolve) => {
    const cmd = `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { windowsHide: true }
    );
    let err = '';
    const finish = (ok) => {
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
      finish(false);
    }, 180000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0 && !/Expand-Archive :/i.test(err)));
  });
}

/* Obscura'yı kur / güncelle. SIRA: pakete gömülü vendor zip'i (network YOK,
     anında) → yoksa GitHub'dan indir. onProgress({pct, phase}). */
async function installObscura(signal, onProgress) {
  const tick = (pct, phase) => {
    if (typeof onProgress === 'function') {
      try { onProgress({ pct, phase: phase || 'indiriliyor' }); } catch {}
    }
  };
  try {
    tick(0, 'hazırlanıyor');
    const dest = obscuraDir();
    fs.mkdirSync(dest, { recursive: true });
    const bundled = bundledZip();
    let ok = false;
    if (bundled) {
      /* PAKET İÇİ kurulum — indirme yok, saniyeler sürer */
      tick(30, 'kuruluyor');
      ok = await psExpand(bundled, dest);
      tick(97, 'doğrulanıyor');
    } else {
      const zipPath = path.join(os.tmpdir(), 'beast-obscura.zip');
      const buf = await httpsDownload(RELEASE_BASE + WINDOWS_ZIP, 5, signal, onProgress);
      tick(89, 'kuruluyor');
      fs.writeFileSync(zipPath, buf);
      tick(90, 'kuruluyor');
      ok = await psExpand(zipPath, dest);
      try { fs.unlinkSync(zipPath); } catch {}
      tick(97, 'doğrulanıyor');
    }
    if (!ok || !obscuraInstalled()) {
      return { ok: false, error: 'obscura kurulumu başarısız (zip açılamadı)' };
    }
    markVariant('stealth');
    _okProbe = null; /* yeniden doğrula */
    const good = await obscuraOk();
    tick(good ? 100 : 98, good ? 'tamamlandı' : 'doğrulanıyor');
    return { ok: good, dir: dest, error: good ? null : 'obscura.exe doğrulanamadı' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* obscura fetch — sayfa HTML'i (abort ile süreç kesilir) */
function obscuraFetchHtml(url, signal, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const args = ['fetch', url, '--dump', 'html', '--quiet', '--timeout', '20'];
    if (readVariant() === 'stealth') args.push('--stealth');
    let settled = false;
    const finish = (err, html) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      err ? reject(err) : resolve(String(html || ''));
    };
    let child = null;
    const onAbort = () => {
      try {
        if (child && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {}
      finish(new Error('obscura fetch iptal edildi'));
    };
    const timer = setTimeout(() => {
      try {
        if (child && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {}
      finish(new Error('obscura fetch zaman aşımı'));
    }, timeoutMs);
    if (signal) {
      if (signal.aborted) return finish(new Error('iptal'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      child = execFile(
        obscuraExe(),
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => finish(err, stdout)
      );
    } catch (e) {
      finish(e);
    }
  });
}

/* lite.duckduckgo sonuç ayrıştırıcı (tablo düzeni, result-link çıpaları) */
function parseDdgLite(html, limit = 8) {
  const out = [];
  const re = /<a\s+[^>]*class="[^"]*result-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(String(html || ''))) && out.length < limit) {
    let href = m[1] || '';
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      href = uddg ? decodeURIComponent(uddg) : u.toString();
    } catch {}
    const title = String(m[2] || '').replace(/<[^>]+>/g, '').trim();
    if (!title || !/^https?:\/\//i.test(href)) continue;
    if (out.some((r) => r.url === href)) continue;
    out.push({ title, url: href, snippet: '' });
  }
  return out;
}

/* Obscura arama motoru: DDG html (önce) → DDG lite (yedek), stealth ile.
   Döndüremiyorsa null — zincir sıradaki motora geçer. */
async function obscuraSearch(query, { maxResults = 8, signal } = {}) {
  const q = String(query || '').trim().slice(0, 400);
  if (!q || !obscuraInstalled()) return null;
  const cap = Math.max(1, Math.min(12, Number(maxResults) || 8));
  const targets = [
    'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q),
    'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(q),
  ];
  for (const url of targets) {
    let html = '';
    try {
      html = await obscuraFetchHtml(url, signal);
    } catch {
      continue;
    }
    if (!html) continue;
    let results = [];
    const { parseDdgResults } = require('./tools'); /* döngüsel require — çağrı anında */
    if (/result__a/.test(html)) results = parseDdgResults(html, cap);
    if (!results.length) results = parseDdgLite(html, cap);
    if (results.length) {
      return {
        ok: true,
        engine: 'obscura',
        query: q,
        count: results.length,
        results: results.map((r) => ({ ...r, engine: 'obscura' })),
      };
    }
  }
  return null;
}

module.exports = {
  ENGINE: 'obscura',
  RELEASE_BASE,
  WINDOWS_ZIP,
  bundledZip,
  obscuraDir,
  obscuraExe,
  obscuraInstalled,
  obscuraOk,
  installObscura,
  obscuraFetchHtml,
  obscuraSearch,
  parseDdgLite,
};
