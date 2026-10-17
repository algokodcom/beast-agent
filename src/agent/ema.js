'use strict';

/* Beast TTS: eMa Lightning (canberkkkkkk/ema-lightning) — TEK yazı→ses motoru.
   Yerel/offline PyTorch (CPU), Türkçe, 48kHz'e kadar çıkış; ağırlıklar ilk
   kullanımda HF'den iner (%APPDATA%\beast\hf önbelleğine). Çıkarım Python
   köprüsünde (python/ema_server.py) koşar; süreç 15 dk boşta bellekten bırakılır. */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { beastRoot } = require('./memory');
const log = require('./logger');
const pyrt = require('./pyrt');
const { emitInstallProgress } = require('./progressbus');

const IDLE_UNLOAD_MS = 15 * 60 * 1000;
const READY_TIMEOUT_MS = 10 * 60 * 1000; // ilk açılışta ağırlık indirme payı
const REQ_TIMEOUT_MS = 5 * 60 * 1000;

function markerFile() {
  return path.join(beastRoot(), 'ema', '.ready');
}

let pkgState = null; // { exe, ok, missing, ts }

function ensurePkg() {
  const need = ['torch', 'ema_lightning'];
  if (pkgState && pkgState.ok && Date.now() - pkgState.ts < 10 * 60 * 1000) {
    return Promise.resolve(pkgState);
  }
  const py = pyrt.resolve(need);
  if (!py.exe) return Promise.reject(new Error('python bulunamadı — eMa kurulamaz'));
  if (!py.missing.length) {
    pkgState = { exe: py.exe, ok: true, missing: [], ts: Date.now() };
    return Promise.resolve(pkgState);
  }
  /* eksikleri sırayla kur: torch (büyük) → ema-lightning */
  if (py.missing.includes('torch')) {
    const r = pyrt.pipInstall(py.exe, 'torch', { timeout: 2400000 });
    if (!r.ok) return Promise.reject(new Error('torch kurulamadı: ' + (r.error || '?')));
  }
  if (py.missing.includes('ema_lightning') || py.missing.includes('torch')) {
    const r = pyrt.pipInstall(py.exe, 'ema-lightning');
    if (!r.ok) return Promise.reject(new Error('ema-lightning kurulamadı: ' + (r.error || '?')));
  }
  const again = pyrt.resolve(need);
  if (again.missing.length) return Promise.reject(new Error('python paketleri eksik: ' + again.missing.join(', ')));
  pkgState = { exe: again.exe, ok: true, missing: [], ts: Date.now() };
  return Promise.resolve(pkgState);
}

/* ---------- python köprüsü (kalıcı süreç) ---------- */

let proc = null;
let ready = false;
let spawnPromise = null;
let readyResolve = null;
let readyReject = null;
let seq = 0;
const pending = new Map();
let idleTimer = null;
let stderrTail = [];

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size) return touchIdle();
    log.info('ema', 'boşta — motor bellekten bırakıldı');
    stopProc();
  }, IDLE_UNLOAD_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function stopProc() {
  const p = proc;
  proc = null;
  ready = false;
  if (p) {
    try { p.stdin.write(JSON.stringify({ op: 'exit' }) + '\n'); } catch {}
    setTimeout(() => { try { p.kill(); } catch {} }, 1500);
  }
}

function onLine(line) {
  const s = String(line || '').trim();
  if (!s) return;
  if (s === 'READY') {
    ready = true;
    try {
      fs.mkdirSync(path.dirname(markerFile()), { recursive: true });
      fs.writeFileSync(markerFile(), new Date().toISOString());
    } catch {}
    emitInstallProgress('ema', { pct: 100, file: 'model' });
    const res = readyResolve;
    readyResolve = readyReject = null;
    if (res) res(true);
    return;
  }
  let msg = null;
  try { msg = JSON.parse(s); } catch { return; }
  if (!msg || msg.id == null) return;
  const job = pending.get(msg.id);
  if (!job) return;
  pending.delete(msg.id);
  clearTimeout(job.timer);
  if (msg.ok) job.resolve(msg);
  else job.reject(new Error(msg.error || 'ema hatası'));
}

function spawnProc() {
  if (proc && ready) return Promise.resolve(true);
  if (spawnPromise) return spawnPromise;
  spawnPromise = (async () => {
    const pkg = await ensurePkg();
    const script = path.join(__dirname, 'python', 'ema_server.py');
    stderrTail = [];
    emitInstallProgress('ema', { pct: 1, file: 'model' });
    const child = spawn(pkg.exe, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        HF_HOME: path.join(beastRoot(), 'hf'),
        HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
      },
    });
    proc = child;
    readline.createInterface({ input: child.stdout }).on('line', onLine);
    child.stderr.on('data', (c) => {
      const t = String(c).trim();
      if (!t) return;
      stderrTail.push(t);
      if (stderrTail.length > 30) stderrTail.shift();
    });
    child.on('exit', (code) => {
      const wasReady = ready;
      proc = null;
      ready = false;
      spawnPromise = null;
      for (const [, job] of pending) {
        clearTimeout(job.timer);
        job.reject(new Error('ema süreci kapandı (' + code + ')'));
      }
      pending.clear();
      if (readyReject) { readyReject(new Error('ema motoru başlatılamadı (' + code + ')')); readyResolve = readyReject = null; }
      if (wasReady) log.error('ema', 'motor beklenmedik şekilde kapandı: ' + stderrTail.slice(-2).join(' | ').slice(0, 240));
    });
    await new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
      setTimeout(() => {
        if (!ready && proc === child) {
          readyReject = readyResolve = null;
          try { child.kill(); } catch {}
          reject(new Error('ema motoru zaman aşımı' + (stderrTail.length ? ' — ' + stderrTail.slice(-2).join(' | ').slice(0, 200) : '')));
        }
      }, READY_TIMEOUT_MS).unref();
    });
    log.info('ema', 'köprü hazır (python: ' + pkg.exe + ')');
    touchIdle();
    return true;
  })().catch((e) => {
    spawnPromise = null;
    log.error('ema', 'başlatılamadı: ' + String((e && e.message) || e));
    throw e;
  });
  return spawnPromise;
}

function request(payload, timeoutMs) {
  return spawnProc().then(() => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      try { proc && proc.kill(); } catch {}
      reject(new Error('ema istek zaman aşımı'));
    }, timeoutMs || REQ_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
    touchIdle();
  }));
}

/* sentez kuyruğu: tek motor, istekler sırayla (uzun metin diğerini beklemesin diye
   çağıran taraf zaten cümle cümle besler) */
let chain = Promise.resolve();
function serialize(task) {
  const p = chain.then(task, task);
  chain = p.then(() => {}, () => {});
  return p;
}

/* ---------- dış API ---------- */

/* synthesize(text, { speed, sampleRate }) → { audio: WAV Buffer, mime } */
async function synthesize(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) throw new Error('boş metin');
  const sr = [48000, 24000, 16000, 8000].includes(Number(opts.sampleRate)) ? Number(opts.sampleRate) : 48000;
  const speed = Math.max(0.5, Math.min(2, Number(opts.speed) || 1));
  return serialize(async () => {
    const r = await request({ op: 'say', text: t.slice(0, 4000), sample_rate: sr, speed });
    const audio = Buffer.from(String(r.wav_b64 || ''), 'base64');
    if (!audio.length) throw new Error('ses üretilemedi');
    return { audio, mime: 'audio/wav' };
  });
}

async function warm() {
  await spawnProc();
  return request({ op: 'warm' }, 30000);
}

async function install() {
  try {
    await warm();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ayarlar/doctor ekranı için durum (paket yoklaması ucuz: find_spec) */
function status() {
  let pkg = false;
  let exe = '';
  let missing = [];
  try {
    const py = pyrt.resolve(['torch', 'ema_lightning']);
    exe = py.exe || '';
    missing = py.missing || [];
    pkg = !!py.exe && missing.length === 0;
  } catch {}
  const weights = fs.existsSync(markerFile());
  return {
    installed: pkg && weights,
    pkg,
    weights,
    python: exe,
    missing,
    running: !!(proc && ready),
    installing: !!spawnPromise || !!pkgState && !pkgState.ok,
  };
}

function readyNow() {
  return !!(proc && ready);
}
function installing() {
  return !!spawnPromise;
}

process.on('exit', () => {
  try { if (proc) proc.kill(); } catch {}
});

module.exports = { synthesize, warm, install, status, readyNow, installing };
