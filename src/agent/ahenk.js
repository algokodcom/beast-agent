'use strict';

/* Beast TTS ikinci motor: Ahenk Cep (ozgurguler/ahenk-cep-tr) — eMa Lightning
   yanında ikinci seçenek. EMA Lightning mimarisi (kendi student modeli, ~8.6M
   param, ~34MB), CPU RTF ~0.2, sabit 48 kHz, tek Türkçe ses (trnorm yazı→okunuş
   normalizasyonu içi). Ağırlıklar ilk kurulumda HF'den %APPDATA%\beast\ahenk
   altına iner; çıkarım python/ahenk_server.py köprüsünde koşar; süreç 15 dk
   boşta bellekten bırakılır. trnorm PyPI'da yok → ahenk repo'sundan kurulur. */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { beastRoot } = require('./memory');
const log = require('./logger');
const pyrt = require('./pyrt');
const { emitInstallProgress } = require('./progressbus');

const HF_BASE = 'https://huggingface.co/ozgurguler/ahenk-cep-tr/resolve/main';
const TRNORM_SPEC = 'git+https://github.com/ozguradmin/ahenk-turkish-tts'; // trnorm paketi (ek bağımlılığı yok)
const IDLE_UNLOAD_MS = 15 * 60 * 1000;
const READY_TIMEOUT_MS = 10 * 60 * 1000; // ilk kurulumda trnorm + ağırlık indirme payı
const REQ_TIMEOUT_MS = 5 * 60 * 1000;

const NEED = ['torch', 'ema_lightning', 'trnorm'];

/* model dosyaları: [göreli yol, asgari bayt] — student.pt + decoder.pt ~34MB */
const FILES = [
  ['student.pt', 5000000],
  ['decoder.pt', 5000000],
  ['ahenk_cep.py', 4000],
];

function modelDir() {
  return path.join(beastRoot(), 'ahenk');
}
function filePath(rel) {
  return path.join(modelDir(), ...rel.split('/'));
}
function bigEnough(p, min) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size >= min;
  } catch {
    return false;
  }
}
function modelInstalled() {
  return FILES.every(([f, min]) => bigEnough(filePath(f), min));
}
function markerFile() {
  return path.join(modelDir(), '.ready');
}

/* ---------- python paketleri: torch (büyük) → ema-lightning → trnorm ---------- */

let pkgState = null; // { exe, ok, missing, ts }

function ensurePkg() {
  if (pkgState && pkgState.ok && Date.now() - pkgState.ts < 10 * 60 * 1000) {
    return Promise.resolve(pkgState);
  }
  const py = pyrt.resolve(NEED);
  if (!py.exe) return Promise.reject(new Error('python bulunamadı — Ahenk Cep kurulamaz'));
  if (!py.missing.length) {
    pkgState = { exe: py.exe, ok: true, missing: [], ts: Date.now() };
    return Promise.resolve(pkgState);
  }
  /* eMa ile aynı taban kuruluysa yalnızca trnorm eksik olur: git+pip (saf Python) */
  if (py.missing.includes('torch')) {
    const r = pyrt.pipInstall(py.exe, 'torch', { timeout: 2400000 });
    if (!r.ok) return Promise.reject(new Error('torch kurulamadı: ' + (r.error || '?')));
  }
  if (py.missing.includes('ema_lightning') || py.missing.includes('torch')) {
    const r = pyrt.pipInstall(py.exe, 'ema-lightning');
    if (!r.ok) return Promise.reject(new Error('ema-lightning kurulamadı: ' + (r.error || '?')));
  }
  if (py.missing.includes('trnorm')) {
    const r = pyrt.pipInstall(py.exe, TRNORM_SPEC, { timeout: 600000 });
    if (!r.ok) {
      /* git kurulumu başarısızsa (git yok vb.) düz PyPI adıyla son bir deneme */
      const r2 = pyrt.pipInstall(py.exe, 'trnorm', { timeout: 120000 });
      if (!r2.ok) return Promise.reject(new Error('trnorm kurulamadı (git+pip): ' + (r.error || '?')));
    }
  }
  const again = pyrt.resolve(NEED);
  if (again.missing.length) return Promise.reject(new Error('python paketleri eksik: ' + again.missing.join(', ')));
  pkgState = { exe: again.exe, ok: true, missing: [], ts: Date.now() };
  return Promise.resolve(pkgState);
}

/* ---------- indirme (yüzde akışlı, .part → atomik rename) ---------- */

async function download(url, dest, label, minBytes = 100) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error('indirilemedi (http ' + res.status + ')');
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  let loaded = 0;
  let last = 0;
  const rs = Readable.fromWeb(res.body);
  rs.on('data', (c) => {
    loaded += c.length;
    const now = Date.now();
    if (now - last > 400) {
      last = now;
      emitInstallProgress('ahenk', {
        pct: total ? Math.round((loaded / total) * 100) : 0,
        loaded,
        total,
        file: label,
      });
    }
  });
  await pipeline(rs, fs.createWriteStream(tmp));
  const st = fs.statSync(tmp);
  if (st.size < minBytes) {
    fs.rmSync(tmp, { force: true });
    throw new Error('eksik indirme: ' + label);
  }
  fs.renameSync(tmp, dest);
  emitInstallProgress('ahenk', { pct: 100, loaded, total: total || loaded, file: label });
}

let modelPromise = null;
function ensureModel() {
  if (modelInstalled()) return Promise.resolve(true);
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    log.info('ahenk', 'model indiriliyor (~34MB): ' + HF_BASE);
    for (const [f, min] of FILES) {
      const dest = filePath(f);
      if (bigEnough(dest, min)) continue;
      emitInstallProgress('ahenk', { pct: 0, file: f });
      await download(HF_BASE + '/' + f, dest, 'Ahenk Cep: ' + f, min);
    }
    if (!modelInstalled()) throw new Error('ahenk model dosyaları eksik');
    log.info('ahenk', 'model hazır: ' + modelDir());
    return true;
  })().catch((e) => {
    log.error('ahenk', 'model indirme başarısız: ' + String((e && e.message) || e));
    throw e;
  }).finally(() => {
    modelPromise = null;
  });
  return modelPromise;
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
    log.info('ahenk', 'boşta — motor bellekten bırakıldı');
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
    emitInstallProgress('ahenk', { pct: 100, file: 'model' });
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
  else job.reject(new Error(msg.error || 'ahenk hatası'));
}

function spawnProc() {
  if (proc && ready) return Promise.resolve(true);
  if (spawnPromise) return spawnPromise;
  spawnPromise = (async () => {
    const pkg = await ensurePkg();
    await ensureModel();
    const script = path.join(__dirname, 'python', 'ahenk_server.py');
    stderrTail = [];
    emitInstallProgress('ahenk', { pct: 1, file: 'model' });
    const child = spawn(pkg.exe, [script, modelDir()], {
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
        job.reject(new Error('ahenk süreci kapandı (' + code + ')'));
      }
      pending.clear();
      if (readyReject) { readyReject(new Error('ahenk motoru başlatılamadı (' + code + ')')); readyResolve = readyReject = null; }
      if (wasReady) log.error('ahenk', 'motor beklenmedik şekilde kapandı: ' + stderrTail.slice(-2).join(' | ').slice(0, 240));
    });
    await new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
      setTimeout(() => {
        if (!ready && proc === child) {
          readyReject = readyResolve = null;
          try { child.kill(); } catch {}
          reject(new Error('ahenk motoru zaman aşımı' + (stderrTail.length ? ' — ' + stderrTail.slice(-2).join(' | ').slice(0, 200) : '')));
        }
      }, READY_TIMEOUT_MS).unref();
    });
    log.info('ahenk', 'köprü hazır (python: ' + pkg.exe + ')');
    touchIdle();
    return true;
  })().catch((e) => {
    spawnPromise = null;
    log.error('ahenk', 'başlatılamadı: ' + String((e && e.message) || e));
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
      reject(new Error('ahenk istek zaman aşımı'));
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

/* sentez kuyruğu: TEK Ahenk motoru istekleri sırayla işler (serialize chain) */
let chain = Promise.resolve();
function serialize(task) {
  const p = chain.then(task, task);
  chain = p.then(() => {}, () => {});
  return p;
}

/* ---------- dış API ---------- */

/* synthesize(text, { speed, sampleRate, pad }) → { audio: WAV Buffer, mime }
   Not: Ahenk Cep sabit 48 kHz çıkarır; sampleRate arayüz uyumluluğu için alınır,
   sunucu tarafında uygulanmaz. */
async function synthesize(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) throw new Error('boş metin');
  const speed = Math.max(0.5, Math.min(2, Number(opts.speed) || 1));
  return serialize(async () => {
    const r = await request({
      op: 'say',
      text: t.slice(0, 4000),
      speed,
      /* baş/son sessizlik dolgusu: sohbet akıcılığı için kısa, WA için varsayılan */
      pad: opts.pad != null ? Number(opts.pad) : undefined,
    });
    const audio = Buffer.from(String(r.wav_b64 || ''), 'base64');
    if (!audio.length) throw new Error('ses üretilemedi');
    return { audio, mime: 'audio/wav', ms: Number(r.ms) || 0, dur: Number(r.dur) || 0 };
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
    const py = pyrt.resolve(NEED);
    exe = py.exe || '';
    missing = py.missing || [];
    pkg = !!py.exe && missing.length === 0;
  } catch {}
  const weights = modelInstalled();
  return {
    installed: pkg && weights,
    pkg,
    weights,
    python: exe,
    missing,
    running: !!(proc && ready),
    installing: !!(spawnPromise || modelPromise) || !!pkgState && !pkgState.ok,
  };
}

function readyNow() {
  return !!(proc && ready);
}
function installing() {
  return !!(spawnPromise || modelPromise);
}

process.on('exit', () => {
  try { if (proc) proc.kill(); } catch {}
});

module.exports = { synthesize, warm, install, status, readyNow, installing };
