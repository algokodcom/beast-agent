'use strict';

/* Python çalışma zamanı bulucu: Beast'in yerel motorları (Duyu-small STT,
   eMa Lightning TTS) Python gerektirir. Bu modül makinedeki en uygun
   yorumlayıcıyı bulur (probe = find_spec, import etmeden hızlı kontrol),
   eksik paketleri pip ile kurar. Sonuç önbelleklenir. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const log = require('./logger');

let cached = null;

/* py launcher'ın listelediği yorumlayıcılar (yol + sürüm) */
function listPyLauncher() {
  const out = [];
  try {
    const txt = String(execFileSync('py', ['-0p'], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/-V:(\d+\.\d+)[^A-Za-z]*([A-Za-z]:\\[^\s]+python\.exe)/i);
      if (m) out.push({ ver: m[1], exe: m[2].trim() });
    }
  } catch {}
  return out;
}

function embeddedPython() {
  const p = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'beast', 'py', 'python.exe');
  return fs.existsSync(p) ? p : null;
}

function commonPaths() {
  const out = [];
  const bases = ['C:\\', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python')];
  for (let v = 14; v >= 10; v--) {
    for (const b of bases) {
      if (!b) continue;
      const p = path.join(b, 'Python3' + v, 'python.exe');
      if (fs.existsSync(p)) out.push({ ver: '3.' + v, exe: p });
    }
  }
  return out;
}

function verNum(v) {
  const p = String(v).split('.').map((x) => parseInt(x, 10) || 0);
  return (p[0] || 0) * 1000 + (p[1] || 0);
}

/* adaylar: env → gömülü → py launcher (yeniden eskiye) → bilinen yollar */
function candidates() {
  const seen = new Set();
  const out = [];
  const push = (exe, ver, src) => {
    if (!exe) return;
    const key = exe.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (/WindowsApps/i.test(exe)) return; // Store taklidi python: çalıştırılamaz
    out.push({ exe, ver: ver || '', src });
  };
  push(String(process.env.BEAST_PYTHON || '').trim(), '', 'env');
  push(embeddedPython(), '', 'embedded');
  for (const c of listPyLauncher().sort((a, b) => verNum(b.ver) - verNum(a.ver))) push(c.exe, c.ver, 'py');
  for (const c of commonPaths()) push(c.exe, c.ver, 'common');
  return out;
}

/* modüller KURULU mu — find_spec ile (import etmeden, hızlı). */
function probe(exe, mods) {
  const code =
    'import importlib.util as u\n' +
    'miss=[]\n' +
    'for m in ' + JSON.stringify(mods) + ':\n' +
    '    try:\n' +
    "        if u.find_spec(m) is None: miss.append(m)\n" +
    '    except Exception: miss.append(m)\n' +
    "print('|'.join(miss))";
  const txt = String(execFileSync(exe, ['-c', code], { timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
  return txt ? txt.split('|') : [];
}

/* need: gerekli modül adları (örn. ['torch','ema_lightning'])
   → { exe, ver, missing[] } — eksiksiz aday öncelikli; yoksa en az eksiği olan. */
function resolve(need) {
  const want = need || [];
  const cacheKey = want.join(',');
  if (cached && cached.key === cacheKey && Date.now() - cached.ts < 10 * 60 * 1000) return cached.val;
  let best = null;
  for (const c of candidates()) {
    let missing;
    try {
      missing = probe(c.exe, want);
    } catch {
      continue; // çalıştırılamayan aday (bozuk kurulum)
    }
    const score = missing.length;
    if (!best || score < best.missing.length) best = { exe: c.exe, ver: c.ver, missing };
    if (!score) break;
  }
  if (!best) best = { exe: null, ver: '', missing: want.slice() };
  if (best.exe && best.missing.length === 0) log.info('pyrt', 'python: ' + best.exe + (best.ver ? ' (v' + best.ver + ')' : ''));
  cached = { key: cacheKey, ts: Date.now(), val: best };
  return best;
}

/* pip install (uzun: torch gibi büyük paketler için 20 dk tavan) */
function pipInstall(exe, spec, { timeout = 1200000 } = {}) {
  try {
    log.info('pyrt', 'pip kuruluyor: ' + spec);
    execFileSync(exe, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '-q', spec], {
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    cached = null; // probe önbelleği geçersiz
    return { ok: true };
  } catch (e) {
    const tail = String((e && (e.stderr || e.stdout || e.message)) || e).trim().split(/\r?\n/).slice(-3).join(' | ');
    log.error('pyrt', 'pip hata (' + spec + '): ' + tail.slice(0, 300));
    return { ok: false, error: tail.slice(0, 300) };
  }
}

module.exports = { resolve, pipInstall, candidates, probe };
