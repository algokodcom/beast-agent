'use strict';

/* SearXNG — yerel metasearch entegrasyonu (github.com/searxng/searxng)
   SearXNG resmi olarak Linux/Docker hedefler; Windows'ta `import pwd`
   yüzünden patlar. Bu modül Beast'ın GÖMÜLÜ Python'ına gerçek searxng'yi
   (GitHub master) kurar + pwd shim'i yazar + 127.0.0.1:8888'de arka planda
   çalıştırır. Arama zinciri 'searxng' motorunu yalnız AYAKTAYSA kullanır.

   CLI:  beast searxng          → gerekirse kur + başlat
         beast searxng status   → durum
         beast searxng stop     → kulla */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile, execSync } = require('child_process');

const REQS_URL = 'https://raw.githubusercontent.com/searxng/searxng/master/requirements.txt';
const PKG_URL = 'https://github.com/searxng/searxng/archive/refs/heads/master.zip';
const GETPIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const DEFAULT_URL = 'http://127.0.0.1:8888';

/* ---------- yollar ---------- */

function beastAppDir() {
  if (process.env.BEAST_DATA) return process.env.BEAST_DATA;
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, 'beast')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'beast');
}

function dir() {
  const d = path.join(beastAppDir(), 'searxng');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function settingsPath() { return path.join(dir(), 'settings.yml'); }
function runPyPath() { return path.join(dir(), 'run.py'); }
function pidPath() { return path.join(dir(), 'server.pid'); }
function pyExe() { return path.join(beastAppDir(), 'py', 'python.exe'); }

/* ---------- durum yoklama (cache'li) ---------- */

let _probe = { at: 0, up: false, url: '' };
const PROBE_UP_TTL = 5 * 60 * 1000;
const PROBE_DOWN_TTL = 2 * 60 * 1000;

function resetProbeCache() { _probe = { at: 0, up: false, url: '' }; }

async function isUp(baseUrl = DEFAULT_URL, { force = false } = {}) {
  const base = String(baseUrl || DEFAULT_URL).replace(/\/+$/, '');
  const ttl = _probe.up ? PROBE_UP_TTL : PROBE_DOWN_TTL;
  if (!force && _probe.url === base && Date.now() - _probe.at < ttl) return _probe.up;
  let up = false;
  try {
    const r = await fetch(`${base}/search?q=beast&format=json`, { signal: AbortSignal.timeout(1800) });
    if (r.ok) {
      const j = await r.json();
      up = j && Array.isArray(j.results);
    }
  } catch {}
  _probe = { at: Date.now(), up, url: base };
  return up;
}

/* ---------- arama (zincir motoru) ---------- */

async function search(query, { maxResults = 8, signal, baseUrl } = {}) {
  const base = String(baseUrl || process.env.BEAST_SEARXNG_URL || DEFAULT_URL).replace(/\/+$/, '');
  if (!(await isUp(base))) return null; // ayakta değil → zincir sıradaki motora geçer
  try {
    const sig =
      signal && typeof AbortSignal !== 'undefined' && AbortSignal.any
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000);
    const r = await fetch(
      `${base}/search?q=${encodeURIComponent(String(query || ''))}&format=json&safesearch=0`,
      { signal: sig }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const results = (j.results || [])
      .map((x) => ({
        title: String(x.title || ''),
        url: String(x.url || ''),
        snippet: String(x.content || '').replace(/\s+/g, ' ').slice(0, 400),
        engine: 'searxng',
      }))
      .filter((x) => x.url && x.title);
    if (!results.length) return null;
    return {
      ok: true,
      engine: 'searxng',
      query,
      results: results.slice(0, Math.max(1, Math.min(12, Number(maxResults) || 8))),
    };
  } catch {
    return null;
  }
}

/* ---------- kurulum ---------- */

function sh(exe, args, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const tail = String((stderr || stdout || err.message) || '').slice(-400);
        return reject(new Error(tail || String(err)));
      }
      resolve(String(stdout || ''));
    });
  });
}

async function downloadTo(url, dest) {
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error(`indirme başarısız: HTTP ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

function sitePackagesDir(py) {
  return sh(py, ['-c', 'import sysconfig;print(sysconfig.get_paths()["purelib"])']).then((s) => s.trim());
}

/* gömülü python'un ._pth dosyasında `import site` açık değilse pip/paketler görünmez */
function fixEmbeddedPth(py) {
  try {
    const dirPy = path.dirname(py);
    for (const f of fs.readdirSync(dirPy)) {
      if (/^python\d+\._pth$/.test(f)) {
        const p = path.join(dirPy, f);
        const cur = fs.readFileSync(p, 'utf8');
        if (!/^import site$/m.test(cur)) {
          fs.writeFileSync(p, cur.replace(/^#\s*import site/m, 'import site'), 'utf8');
        }
      }
    }
  } catch {}
}

async function ensurePip(py, onLog) {
  try {
    await sh(py, ['-m', 'pip', '--version'], 60000);
    return;
  } catch {}
  onLog('pip kuruluyor…');
  const gp = path.join(os.tmpdir(), 'beast-get-pip.py');
  await downloadTo(GETPIP_URL, gp);
  await sh(py, [gp, '--no-warn-script-location'], 300000);
  fixEmbeddedPth(py);
}

/** Tam kurulum — `beast searxng` komutunun yaptığı iş. */
async function install({ onLog } = {}) {
  const log = (m) => { try { (onLog || ((s) => console.log('  • ' + s)))(m); } catch {} };
  const tools = require('./tools');
  const probe = await tools.ensurePython();
  const py = probe.exe;
  log('python: ' + py);

  await ensurePip(py, log);
  log('setuptools/wheel/tzdata kuruluyor…');
  await sh(py, ['-m', 'pip', 'install', '--no-warn-script-location', 'setuptools', 'wheel', 'tzdata'], 600000);

  log('searxng bağımlılıkları indiriliyor (~40 MB)…');
  const reqs = path.join(os.tmpdir(), 'beast-searxng-requirements.txt');
  await downloadTo(REQS_URL, reqs);
  await sh(py, ['-m', 'pip', 'install', '--no-warn-script-location', '-r', reqs], 900000);

  log('searxng motoru kuruluyor…');
  await sh(py, ['-m', 'pip', 'install', '--no-warn-script-location', '--no-build-isolation', PKG_URL], 900000);

  /* pwd shim — searxng/valkeydb.py unix socket sahipliği için pwd import eder */
  const sp = (await sitePackagesDir(py)) || path.join(path.dirname(py), 'Lib', 'site-packages');
  const shim = [
    '"""Windows shim: SearXNG valkeydb.py yalnizca unix-socket sahipligi icin pwd',
    'kullanir; Windows\'ta valkey devre disi oldugundan donuk yanit yeterlidir."""',
    'import os',
    '',
    'class _Pw:',
    '    pw_name = "beast"',
    '    pw_uid = 0',
    '    pw_gid = 0',
    '    pw_dir = os.path.expanduser("~")',
    '    pw_shell = ""',
    '',
    'def getpwuid(uid):',
    '    return _Pw()',
    '',
    'def getpwnam(name):',
    '    return _Pw()',
    '',
    'def getgrgid(gid):',
    '    class _Gr:',
    '        gr_name = "beast"',
    '        gr_gid = 0',
    '    return _Gr()',
    '',
    'def getgrnam(name):',
    '    return getgrgid(0)',
  ].join('\n');
  fs.writeFileSync(path.join(sp, 'pwd.py'), shim, 'utf8');

  /* ayarlar + çalıştırıcı */
  const secret = 'beast-' + Math.random().toString(36).slice(2, 14);
  fs.writeFileSync(
    settingsPath(),
    [
      'use_default_settings: true',
      'server:',
      `  secret_key: "${secret}"`,
      '  port: 8888',
      '  bind_address: "127.0.0.1"',
      '  limiter: false',
      '  image_proxy: false',
      'search:',
      '  formats:',
      '    - html',
      '    - json',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(runPyPath(), 'from searx.webapp import run; run()', 'utf8');
  resetProbeCache();
  log('kurulum tamam');
  return { ok: true };
}

/* ---------- başlat / durdur / durum ---------- */

function readPid() {
  try {
    const s = fs.readFileSync(pidPath(), 'utf8').trim();
    return /^\d+$/.test(s) ? Number(s) : null;
  } catch {
    return null;
  }
}

async function start({ installIfMissing = true, onLog } = {}) {
  if (await isUp(DEFAULT_URL, { force: true })) return { ok: true, already: true, url: DEFAULT_URL };
  if (!fs.existsSync(settingsPath()) || !fs.existsSync(runPyPath())) {
    if (!installIfMissing) return { ok: false, error: 'kurulu değil — önce: beast searxng' };
    await install({ onLog });
  }
  const tools = require('./tools');
  const probe = await tools.ensurePython();
  const child = spawn(probe.exe, [runPyPath()], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, SEARXNG_SETTINGS_PATH: settingsPath(), PYTHONIOENCODING: 'utf-8' },
  });
  try { fs.writeFileSync(pidPath(), String(child.pid)); } catch {}
  child.unref();
  /* ayağa kalkmasını bekle (ilk açılış motor listesini derler — birkaç sn) */
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isUp(DEFAULT_URL, { force: true })) return { ok: true, url: DEFAULT_URL, pid: child.pid };
  }
  return { ok: false, error: 'searxng başlatılamadı (20 sn içinde yanıt yok)' };
}

function stop() {
  const pid = readPid();
  if (!pid) return { ok: true, note: 'çalışmıyor' };
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
  } catch {}
  try { fs.unlinkSync(pidPath()); } catch {}
  resetProbeCache();
  return { ok: true, stopped: pid };
}

async function status() {
  return {
    up: await isUp(DEFAULT_URL, { force: true }),
    url: DEFAULT_URL,
    pid: readPid(),
    installed: fs.existsSync(settingsPath()) && fs.existsSync(runPyPath()),
  };
}

/* ---------- CLI (bin/beast-agent.js → beast searxng) ---------- */

async function cli(argv) {
  const sub = String(argv[0] || 'start').toLowerCase();
  console.log('\u27F3 SearXNG (yerel arama motoru)');
  if (sub === 'stop') {
    const r = stop();
    console.log(r.ok ? '\u2713 durduruldu' : '\u2717 durdurulamadı');
    process.exit(r.ok ? 0 : 1);
  }
  if (sub === 'status') {
    const s = await status();
    console.log(`  kurulu : ${s.installed ? 'evet' : 'hayır'}`);
    console.log(`  çalışıyor: ${s.up ? 'evet (' + s.url + ')' : 'hayır'}`);
    process.exit(0);
  }
  /* start */
  const r = await start({ installIfMissing: true, onLog: (m) => console.log('  \u2022 ' + m) });
  if (r.ok) {
    console.log(r.already ? '\u2713 SearXNG zaten çalışıyor — ' + r.url : '\u2713 SearXNG başlatıldı — ' + r.url);
    console.log('\u2139 arama zincirinde kullanılmaya hazır (Ayarlar → Web Arama sırası)');
    process.exit(0);
  }
  console.error('\u2717 ' + (r.error || 'başlatılamadı'));
  process.exit(1);
}

module.exports = {
  search,
  isUp,
  resetProbeCache,
  install,
  start,
  stop,
  status,
  cli,
  settingsPath,
  DEFAULT_URL,
};
