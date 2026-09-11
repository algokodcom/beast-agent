'use strict';
/* mt5_m15_m5 - PARAMETRE ALMAZ (argumansiz yedek yol).
   C:\Python314\python.exe ile yanindaki m15m5.py dosyasini calistirir,
   stdout'a TEK satir JSON basar. SALT-OKUNUR: hicbir islem/pending/close cagrisi yok.
   Cikti alanlari: ok, server_time, bid, ask, spread, m15[12], m5[12] -> [epoch,o,h,l,c]
   stdout sert sinir: 2000 bayt. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
function resolvePython() {
  const cands = [];
  if (process.env.BEAST_PYTHON) cands.push({ exe: String(process.env.BEAST_PYTHON), args: [] });
  if (process.env.APPDATA) cands.push({ exe: require('path').join(process.env.APPDATA, 'beast', 'py', 'python.exe'), args: [] });
  for (const v of ['314', '313', '312', '311', '310']) cands.push({ exe: 'C:\\Python' + v + '\\python.exe', args: [] });
  cands.push({ exe: 'python', args: [] }, { exe: 'py', args: ['-3'] });
  for (const c of cands) {
    if (c.exe === 'python' || c.exe === 'py') return c;
    try { if (fs.existsSync(c.exe)) return c; } catch (e) {}
  }
  return { exe: 'python', args: [] };
}
const PYSPEC = resolvePython();
const PY = PYSPEC.exe;
const PY_ARGS = PYSPEC.args;

const SCRIPT = path.join(__dirname, 'm15m5.py');
const LIMIT = 2000;

function emit(o, code) {
  process.stdout.write(JSON.stringify(o));
  process.exit(code || 0);
}

(function main() {
  // parametre almaz: stdin'i beklemeden sessizce yut, araclar arasi kalmasin
  try {
    process.stdin.on('error', () => {});
    process.stdin.on('data', () => {});
    process.stdin.resume();
  } catch { }

  if (!fs.existsSync(SCRIPT)) return emit({ ok: false, error: 'm15m5.py yok: ' + SCRIPT }, 1);

  let r;
  try {
    r = spawnSync(PY, [...PY_ARGS, SCRIPT], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  } catch (e) {
    return emit({ ok: false, error: 'python baslatilamadi: ' + String((e && e.message) || e).slice(0, 140) }, 1);
  }

  const out = String((r && r.stdout) || '').trim();
  if (out) {
    let parsed = null;
    try { parsed = JSON.parse(out); } catch { }
    if (parsed && typeof parsed === 'object') {
      const packed = JSON.stringify(parsed);
      const bytes = Buffer.byteLength(packed, 'utf8');
      if (bytes > LIMIT) return emit({ ok: false, error: 'cikti siniri asildi', bytes: bytes, limit: LIMIT }, 1);
      return emit(parsed, parsed.ok ? 0 : 1);
    }
  }

  emit({
    ok: false,
    error: 'python cikti yok/kirik',
    exit_code: r && r.status,
    stderr: String((r && r.stderr) || '').trim().slice(0, 300),
  }, 1);
})();

/* PATCH 2026-09-10b: electron app-mode cocuk prosesi kapanmiyordu (90sn timeout).
   stdout'un boruya bosalmasi icin kisa bekleme, sonra zorla cik. */
setTimeout(() => process.exit(0), 1500);
