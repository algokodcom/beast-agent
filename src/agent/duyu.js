'use strict';

/* Beast STT: Duyu-small (KaanAydinli/Duyu-small) — TEK ses→yazı motoru.
   int8 ONNX conformer, Türkçe+İngilizce, ~53MB model %APPDATA%\beast\duyu-small
   altına iner; çıkarım Python köprüsünde (python/duyu_server.py) koşar.
   Süreç sıcak tutulur (ilk yükleme ~2 sn), 15 dk boşta bellekten bırakılır. */

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

const HF_BASE = 'https://huggingface.co/KaanAydinli/Duyu-small/resolve/main';
const IDLE_UNLOAD_MS = 15 * 60 * 1000;
const READY_TIMEOUT_MS = 90000;
const REQ_TIMEOUT_MS = 120000;

/* model dosyaları: [göreli yol, asgari bayt] — int8 seti + motor + tokenizer */
const FILES = [
  ['config.json', 100],
  ['engine.json', 100],
  ['spm.model', 10000],
  ['fbank.npz', 10000],
  ['passes.npz', 1000],
  ['duyu_small/__init__.py', 100],
  ['duyu_small/audio.py', 500],
  ['duyu_small/cli.py', 500],
  ['duyu_small/decode.py', 500],
  ['duyu_small/features.py', 500],
  ['duyu_small/model.py', 1000],
  ['int8/encoder_pre.onnx', 500000],
  ['int8/encoder_pass.onnx', 20000000],
  ['int8/encoder_post.onnx', 100000],
  ['int8/decoder.onnx', 1000000],
];

function modelDir() {
  return path.join(beastRoot(), 'duyu-small');
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

/* ---------- indirme (yüzde akışlı, .part → atomik rename) ---------- */

async function download(url, dest, label) {
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
      emitInstallProgress('stt', {
        pct: total ? Math.round((loaded / total) * 100) : 0,
        loaded,
        total,
        file: label,
      });
    }
  });
  await pipeline(rs, fs.createWriteStream(tmp));
  const st = fs.statSync(tmp);
  if (st.size < 100) {
    fs.rmSync(tmp, { force: true });
    throw new Error('eksik indirme: ' + label);
  }
  fs.renameSync(tmp, dest);
  emitInstallProgress('stt', { pct: 100, loaded, total: total || loaded, file: label });
}

let modelPromise = null;
function ensureModel() {
  if (modelInstalled()) return Promise.resolve(true);
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    log.info('duyu', 'model indiriliyor (~53MB): ' + HF_BASE);
    for (const [f] of FILES) {
      const dest = filePath(f);
      if (bigEnough(dest, 1000)) continue;
      emitInstallProgress('stt', { pct: 0, file: f });
      await download(HF_BASE + '/' + f, dest, 'Duyu-small: ' + f);
    }
    if (!modelInstalled()) throw new Error('duyu-small model dosyaları eksik');
    log.info('duyu', 'model hazır: ' + modelDir());
    return true;
  })().catch((e) => {
    log.error('duyu', 'model indirme başarısız: ' + String((e && e.message) || e));
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
    log.info('duyu', 'boşta — motor bellekten bırakıldı');
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
  else job.reject(new Error(msg.error || 'duyu hatası'));
}

function spawnProc() {
  if (proc && ready) return Promise.resolve(true);
  if (spawnPromise) return spawnPromise;
  spawnPromise = (async () => {
    await ensureModel();
    const py = pyrt.resolve(['numpy', 'onnxruntime', 'sentencepiece']);
    if (!py.exe) throw new Error('python bulunamadı — Duyu-small kurulamaz');
    if (py.missing.length) {
      const r = pyrt.pipInstall(py.exe, 'numpy onnxruntime sentencepiece');
      if (!r.ok) throw new Error('python paketleri kurulamadı: ' + (r.error || '?'));
      const again = pyrt.resolve(['numpy', 'onnxruntime', 'sentencepiece']);
      if (again.missing.length) throw new Error('python paketleri eksik: ' + again.missing.join(', '));
    }
    const script = path.join(__dirname, 'python', 'duyu_server.py');
    stderrTail = [];
    const child = spawn(py.exe, [script, modelDir()], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    proc = child;
    readline.createInterface({ input: child.stdout }).on('line', onLine);
    /* stdin EPIPE: motor ölmüşken yazılırsa Node 'error' olayı fırlatır ve
       TÜM uygulamayı düşürür — yut, pending işleri exit zaten reddediyor */
    child.stdin.on('error', () => {});
    child.stderr.on('data', (c) => {
      const t = String(c).trim();
      if (!t) return;
      stderrTail.push(t);
      if (stderrTail.length > 20) stderrTail.shift();
    });
    child.on('exit', (code) => {
      const wasReady = ready;
      proc = null;
      ready = false;
      spawnPromise = null;
      for (const [, job] of pending) {
        clearTimeout(job.timer);
        job.reject(new Error('duyu süreci kapandı (' + code + ')'));
      }
      pending.clear();
      if (readyReject) { readyReject(new Error('duyu motoru başlatılamadı (' + code + ')')); readyResolve = readyReject = null; }
      if (wasReady) log.error('duyu', 'motor beklenmedik şekilde kapandı: ' + stderrTail.slice(-2).join(' | ').slice(0, 240));
    });
    await new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
      setTimeout(() => {
        if (!ready && proc === child) {
          readyReject = readyResolve = null;
          try { child.kill(); } catch {}
          reject(new Error('duyu motoru zaman aşımı' + (stderrTail.length ? ' — ' + stderrTail.slice(-2).join(' | ').slice(0, 200) : '')));
        }
      }, READY_TIMEOUT_MS).unref();
    });
    log.info('duyu', 'köprü hazır (python: ' + py.exe + ')');
    touchIdle();
    return true;
  })().catch((e) => {
    spawnPromise = null;
    log.error('duyu', 'başlatılamadı: ' + String((e && e.message) || e));
    throw e;
  });
  return spawnPromise;
}

function request(payload, timeoutMs) {
  return spawnProc().then(() => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      try { proc && proc.kill(); } catch {} // takılan motor: sıfırdan kurulsun
      reject(new Error('duyu istek zaman aşımı'));
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

/* ---------- metin onarımı ----------
   Duyu bazen kelimeyi iki parçaya böler ("kalkın" → "kal"+"kın",
   "kolyeler" → "kol"+"ye"+"ler") ya da cümle sonunda yarım parça bırakır
   ("…sohbetlere kal"). Yanlış birleştirme riskine karşı: birleşik hâli yalnız
   bilinen Türkçe kelime listesindeyse yapıştırılır; fragment tek kelimeyse atılır. */
function foldTr(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[çğıöşüâîû]/g, (ch) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' }[ch] || ch))
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}
const MERGE_FOLDED = new Set([
  'kalkın', 'kalkin', 'kalkıp', 'kalkip', 'kalktı', 'kalkti', 'kalkar', 'kalkmak', 'kalmak', 'kaldık', 'kaldik', 'kaldın', 'kaldin', 'kalış', 'kalis', 'kalkış', 'kalkis',
  'kulak', 'kulaklar', 'kulaklık', 'kulaklıklar', 'kulağım', 'kulaklığım', 'kulağa', 'kulağı',
  'kelime', 'kelimeler', 'kelimeleri', 'kelimesi', 'kilim', 'kilit', 'kilitli', 'kılıç', 'kilic', 'kılık', 'kilik', 'kilise', 'kiliseler',
  'koltuk', 'koltuklar', 'kolye', 'kolyeler', 'kolyeleri', 'kolyenin', 'kolon', 'koloni', 'kulis', 'kulisler', 'kulüp', 'kulup', 'kültür', 'kultur', 'kültürel', 'kulturel',
  'kalite', 'kaliteli', 'kalitesi', 'kalitesiz', 'kalibre',
  'gelin', 'gelir', 'gelirler', 'geliş', 'gelis', 'gelişme', 'gelişmeler', 'geliyor', 'geliyorum', 'geldim', 'geldin', 'gelince',
  'gülün', 'gulun', 'gülümseme', 'bilgi', 'bilgiler', 'bildik', 'bilek', 'bileklik', 'bilet', 'biletler', 'bölüm', 'bolum', 'bölümler', 'bölge', 'bolge', 'bölgeler',
  'sabır', 'sabir', 'salgın', 'salgin', 'salim', 'merhaba', 'merhabalar',
].map((w) => foldTr(w)));
const PLAIN_WORD_RE = /^[A-Za-zÇĞİÖŞÜçğıöşü]+$/;
const DANGLE_RE = /(^|[\s.,!?;:)\]"'“”‘’]+)(kal|kul|kol|kıl|kil|kel)([\s.,!?;:)\]"'“”‘’]*)$/i;

function fixTranscript(text) {
  let s = String(text || '').trim();
  if (!s) return s;
  const words = s.split(/\s+/);
  const out = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (prev && PLAIN_WORD_RE.test(prev) && PLAIN_WORD_RE.test(w) && MERGE_FOLDED.has(foldTr(prev + w))) {
      out[out.length - 1] = prev + w;
      continue;
    }
    out.push(w);
  }
  s = out.join(' ');
  s = s.replace(DANGLE_RE, '$1');
  s = s.replace(/[\s"'“”‘’]+$/, '');
  return s.trim();
}

/* ---------- dış API ---------- */

/* transc. transcribe(Float32Array 16kHz, { lang: 'tr'|'en'|'mix'|'auto', mode: 'auto'|'ctc', beam: n, timeoutMs })
   timeoutMs: uzun parçalarda worker zaman aşımını parça süresine göre büyütmek için */
async function transcribe(pcm, opts = {}) {
  if (!pcm || !pcm.length) throw new Error('boş ses');
  const b64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
  const r = await request({
    op: 'transcribe',
    pcm_b64: b64,
    lang: opts.lang || 'mix',
    mode: opts.mode || 'auto',
    beam: opts.beam || 0,
  }, opts.timeoutMs);
  return fixTranscript(String(r.text || ''));
}

async function warm() {
  await spawnProc();
  return request({ op: 'warm' }, 30000);
}

async function install() {
  try {
    await ensureModel();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ayarlar ekranı için senkron durum (dosya taraması) */
function statusSync() {
  let bytes = 0;
  let have = 0;
  const missing = [];
  for (const [f, min] of FILES) {
    const p = filePath(f);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size >= min) { have++; bytes += st.size; continue; }
      bytes += st.size;
    } catch {}
    missing.push(f);
  }
  const installed = have === FILES.length;
  const state = installed ? 'downloaded' : (have || bytes ? 'partial' : 'missing');
  return { installed, missing, state, mb: Math.round(bytes / (1024 * 1024)), dir: modelDir() };
}

function readyNow() {
  return !!(proc && ready);
}
function installing() {
  return !!modelPromise || !!spawnPromise;
}

process.on('exit', () => {
  try { if (proc) proc.kill(); } catch {}
});

module.exports = {
  modelDir,
  modelInstalled,
  ensureModel,
  transcribe,
  warm,
  install,
  statusSync,
  readyNow,
  installing,
};
