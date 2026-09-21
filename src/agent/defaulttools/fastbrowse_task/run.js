'use strict';
// FASTBROWSE KÖPRÜSÜ — stdin: JSON args · stdout: JSON sonuç
// fastbrowse (Python 3.13) uv ile izole ortamda çalışır; anahtar/kimlik bilgileri
// args'tan GEÇMEZ — köprü %APPDATA%\beast\settings.json'dan okur (model hiç görmez).
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function readArgs() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') || {}; } catch { return {}; }
}

/* uv bul: PATH'te yoksa uv'un resmi kurulum yerleri denenir */
function findUv() {
  const cands = [];
  if (process.env.UV) cands.push(String(process.env.UV));
  if (process.env.USERPROFILE) cands.push(path.join(process.env.USERPROFILE, '.local', 'bin', 'uv.exe'));
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'uv.exe'));
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  return 'uv';
}

/* Chrome bul (chrome modu yedeği; köprü FASTBROWSE_CHROME'u kullanır) */
function findChrome() {
  const cands = [];
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  cands.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  cands.push('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch {} }
  return '';
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const args = readArgs();
const uv = findUv();
const bridge = path.join(__dirname, 'fastbrowse_bridge.py');
if (!fs.existsSync(bridge)) {
  emit({ ok: false, status: 'error', error: 'köprü dosyası yok: ' + bridge, hint: 'Araç klasörünü yeniden kur (uygulamayı yeniden başlat).' });
  process.exit(0);
}

const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
if (!env.FASTBROWSE_CHROME) {
  const chrome = findChrome();
  if (chrome) env.FASTBROWSE_CHROME = chrome;
}

const UV_TIMEOUT_MS = 330000; /* customtools zaman aşımının (360 sn) altında kal */
let child = null;
let out = '';
let err = '';
let settled = false;
const finish = (obj) => {
  if (settled) return;
  settled = true;
  clearTimeout(killer);
  try { child && child.kill(); } catch {}
  emit(obj);
};

const killer = setTimeout(() => {
  finish({ ok: false, status: 'error', error: 'fastbrowse zaman aşımı (uv/Chrome yanıt vermedi)', stderr: String(err || '').slice(-500) });
}, UV_TIMEOUT_MS);

try {
  child = spawn(uv, ['run', '--python', '3.13', '--with', 'fastbrowse==0.4.2', 'python', bridge], {
    cwd: __dirname,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (e) {
  finish({
    ok: false,
    status: 'error',
    error: 'uv başlatılamadı: ' + String((e && e.message) || e),
    hint: 'uv kur: winget install astral-sh.uv  (ya da https://docs.astral.sh/uv/)',
  });
  process.exit(0);
}

child.stdout.on('data', (d) => { out += d.toString('utf8'); });
child.stderr.on('data', (d) => { err += d.toString('utf8'); if (err.length > 20000) err = err.slice(-12000); });
child.on('error', (e) => {
  finish({
    ok: false,
    status: 'error',
    error: 'uv çalıştırılamadı: ' + String((e && e.message) || e),
    hint: 'uv kur: winget install astral-sh.uv  (ya da https://docs.astral.sh/uv/)',
  });
});
child.on('close', (code) => {
  /* uv/python kendi log'larını stderr'e yazar; stdout'tan SON geçerli JSON satırını al */
  let result = null;
  for (const line of String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && typeof o.ok === 'boolean') result = o;
    } catch {}
  }
  if (!result) {
    result = {
      ok: false,
      status: 'error',
      error: 'fastbrowse sonuç üretemedi (çıkış kodu ' + code + ')',
      stderr: String(err || '').slice(-800),
    };
  }
  if (!result.ok && !result.hint && code !== 0) result.hint = String(err || '').slice(-200) || 'çıkış kodu ' + code;
  finish(result);
});

try {
  child.stdin.write(JSON.stringify(args));
  child.stdin.end();
} catch {}
