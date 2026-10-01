'use strict';

/* Beast Supertonic 3 TTS: tamamen YEREL/offline, 31 dil destekli neural
   seslendirme (Supertone/supertonic-3, ONNX Runtime CPU).
   - Model: %APPDATA%\beast\supertonic\onnx (toplam ~400MB, ilk kullanımda
     indirilir; tts.json + unicode_indexer.json + 4 ONNX oturumu).
   - Sesler: M1-M5 (erkek) / F1-F5 (kadın) voice style JSON'ları
     %APPDATA%\beast\supertonic\voice_styles altına iner.
   - Çıktı: 44.1kHz mono 16-bit WAV buffer — WhatsApp sesli not yolu ffmpeg
     ile ogg/opus'a çevirir, masaüstü oynatıcı WAV'ı doğrudan çalar.
   - Oturumlar ilk sentezde yüklenir ve 10 dk boşta kalınca bellekten
     bırakılır; indirmeler kilitli, ilerleme progressbus'a akar.
   - Implementasyon resmi nodejs örneğinin (helper.js) CommonJS portu. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { beastRoot } = require('./memory');
const log = require('./logger');
const { emitInstallProgress } = require('./progressbus');

const HF_BASE = 'https://huggingface.co/Supertone/supertonic-3/resolve/main';
const DEFAULT_VOICE = 'M1';
const DEFAULT_LANG = 'tr';
const DEFAULT_SPEED = 1.05;
const DEFAULT_STEPS = 8;
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

/* onnx/ klasörü: config + indexer + 4 model (sıra indirme sırası) */
const MODEL_FILES = [
  'tts.json',
  'unicode_indexer.json',
  'duration_predictor.onnx',
  'text_encoder.onnx',
  'vector_estimator.onnx',
  'vocoder.onnx',
];

const VOICES = {
  M1: { name: 'M1 — Erkek 1' },
  M2: { name: 'M2 — Erkek 2' },
  M3: { name: 'M3 — Erkek 3' },
  M4: { name: 'M4 — Erkek 4' },
  M5: { name: 'M5 — Erkek 5' },
  F1: { name: 'F1 — Kadın 1' },
  F2: { name: 'F2 — Kadın 2' },
  F3: { name: 'F3 — Kadın 3' },
  F4: { name: 'F4 — Kadın 4' },
  F5: { name: 'F5 — Kadın 5' },
};

/* Desteklenen 31 dil + na (bilinmeyen/dil bağımsız) — UI sıralaması önemli */
const LANGS = {
  tr: 'Türkçe',
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  ru: 'Русский',
  ar: 'العربية',
  ja: '日本語',
  ko: '한국어',
  pt: 'Português',
  nl: 'Nederlands',
  pl: 'Polski',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  vi: 'Tiếng Việt',
  uk: 'Українська',
  bg: 'Bulgarian',
  cs: 'Čeština',
  da: 'Dansk',
  el: 'Ελληνικά',
  et: 'Eesti',
  fi: 'Suomi',
  hr: 'Hrvatski',
  hu: 'Magyar',
  lt: 'Lietuvių',
  lv: 'Latviešu',
  ro: 'Română',
  sk: 'Slovenčina',
  sl: 'Slovenščina',
  sv: 'Svenska',
  na: 'Otomatik (dil bilinmiyor)',
};

/* ---------- yollar ---------- */

function rootDir() {
  return path.join(beastRoot(), 'supertonic');
}
function onnxDir() {
  return path.join(rootDir(), 'onnx');
}
function stylesDir() {
  return path.join(rootDir(), 'voice_styles');
}
function modelPath(name) {
  return path.join(onnxDir(), name);
}
function stylePath(id) {
  return path.join(stylesDir(), String(id) + '.json');
}

function resolveVoice(id) {
  const v = String(id || '').trim().toUpperCase();
  return VOICES[v] ? v : DEFAULT_VOICE;
}
function resolveLang(id) {
  const l = String(id || '').trim().toLowerCase();
  return LANGS[l] ? l : DEFAULT_LANG;
}
function clampNum(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
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
  return MODEL_FILES.every((f) => bigEnough(modelPath(f), 1000));
}
function voiceInstalled(id) {
  return !!VOICES[id] && bigEnough(stylePath(id), 1000);
}

/* ---------- indirme (yüzde akışlı, .part → atomik rename) ---------- */

async function download(url, dest, tag, label) {
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
    if (now - last > 500) {
      last = now;
      emitInstallProgress(tag, {
        pct: total ? Math.round((loaded / total) * 100) : 0,
        loaded,
        total,
        file: label,
      });
    }
  });
  await pipeline(rs, fs.createWriteStream(tmp));
  const st = fs.statSync(tmp);
  if (st.size < 1000) {
    fs.rmSync(tmp, { force: true });
    throw new Error('eksik indirme: ' + label);
  }
  fs.renameSync(tmp, dest);
  emitInstallProgress(tag, { pct: 100, loaded, total: total || loaded, file: label });
}

/* ---------- kurulum (kilitli) ---------- */

let modelPromise = null;
const voicePromises = new Map();

function ensureModel() {
  if (modelInstalled()) return Promise.resolve(true);
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    log.info('supertonic', 'model indiriliyor (~400MB): ' + HF_BASE);
    for (const f of MODEL_FILES) {
      const dest = modelPath(f);
      if (bigEnough(dest, 1000)) continue;
      emitInstallProgress('supertonic', { pct: 0, file: f });
      await download(HF_BASE + '/onnx/' + f, dest, 'supertonic', f);
    }
    if (!modelInstalled()) throw new Error('supertonic model dosyaları eksik');
    log.info('supertonic', 'model hazır: ' + onnxDir());
    return true;
  })().catch((e) => {
    log.error('supertonic', 'model indirme başarısız: ' + String((e && e.message) || e));
    throw e;
  }).finally(() => {
    modelPromise = null; // kilit çözülür; kuruluysa yukarıdaki kısa yol devrede
  });
  return modelPromise;
}

function ensureVoice(id) {
  const vid = resolveVoice(id);
  if (voiceInstalled(vid)) return Promise.resolve(true);
  if (voicePromises.has(vid)) return voicePromises.get(vid);
  const p = (async () => {
    log.info('supertonic', 'ses stili indiriliyor: ' + vid);
    await download(HF_BASE + '/voice_styles/' + vid + '.json', stylePath(vid), 'supertonic-voice', vid + '.json');
    if (!voiceInstalled(vid)) throw new Error('ses stili indirilemedi: ' + vid);
    log.info('supertonic', 'ses hazır: ' + vid);
    return true;
  })().catch((e) => {
    log.error('supertonic', 'ses indirme başarısız (' + vid + '): ' + String((e && e.message) || e));
    throw e;
  }).finally(() => {
    voicePromises.delete(vid);
  });
  voicePromises.set(vid, p);
  return p;
}

/* UI için durum: { installed, model, voice, voiceId, installing } */
function status(voiceId) {
  const vid = resolveVoice(voiceId);
  return {
    installed: modelInstalled() && voiceInstalled(vid),
    model: modelInstalled(),
    voice: voiceInstalled(vid),
    voiceId: vid,
    installing: !!modelPromise || voicePromises.has(vid),
  };
}

/* elle/otomatik kurulum: model + ses (hata fırlatmaz, {ok} döner) */
async function install(voiceId) {
  const vid = resolveVoice(voiceId);
  try {
    await ensureModel();
    await ensureVoice(vid);
    return { ok: true, voice: vid };
  } catch (e) {
    return { ok: false, voice: vid, error: String((e && e.message) || e) };
  }
}

/* ---------- ONNX motoru (lazy yükleme + boşta bellek bırakma) ---------- */

let engine = null;
let enginePromise = null;
let busy = 0;
let idleTimer = null;

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(releaseEngine, IDLE_UNLOAD_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function releaseEngine() {
  if (busy > 0 || !engine) {
    if (engine) touchIdle();
    return;
  }
  for (const s of [engine.dp, engine.textEnc, engine.vectorEst, engine.vocoder]) {
    try { s.release(); } catch {}
  }
  engine = null;
  log.info('supertonic', 'model boşta — bellekten bırakıldı');
}

/* onnxruntime-node'un EN YENİ kopyasını seç: kökteki eski sürüm (1.14)
   Windows'ta delay-load hatasıyla süreci çökertebiliyor; @huggingface/
   transformers kendi yeni kopyasını (1.21+) nested taşır. */
function ortVersion(dir) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '0');
  } catch {
    return '0';
  }
}
function verNum(v) {
  const p = String(v).split('.').map((x) => parseInt(x, 10) || 0);
  return (p[0] || 0) * 1000000 + (p[1] || 0) * 1000 + (p[2] || 0);
}
function loadOrt() {
  const candidates = [];
  try {
    let dir = path.dirname(require.resolve('@huggingface/transformers'));
    while (dir && dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) break;
      dir = path.dirname(dir);
    }
    if (dir) candidates.push(path.join(dir, 'node_modules', 'onnxruntime-node'));
  } catch {}
  try {
    candidates.push(path.dirname(require.resolve('onnxruntime-node/package.json')));
  } catch {}
  const found = candidates
    .filter((c) => fs.existsSync(path.join(c, 'package.json')))
    .map((c) => ({ dir: c, v: ortVersion(c) }))
    .sort((a, b) => verNum(b.v) - verNum(a.v));
  for (const c of found) {
    try {
      const m = require(c.dir);
      if (m && typeof m.InferenceSession === 'function') {
        log.info('supertonic', 'onnxruntime-node ' + c.v + ' kullanılıyor');
        return m;
      }
    } catch (e) {
      log.info('supertonic', 'onnxruntime adayı yüklenemedi (' + c.v + '): ' + String((e && e.message) || e));
    }
  }
  return require('onnxruntime-node');
}

async function doLoadEngine() {
  await ensureModel();
  const ort = loadOrt();
  const cfg = JSON.parse(fs.readFileSync(modelPath('tts.json'), 'utf8'));
  const indexer = JSON.parse(fs.readFileSync(modelPath('unicode_indexer.json'), 'utf8'));
  const threads = Math.max(1, Math.min(4, (os.cpus() && os.cpus().length || 2) - 1));
  const opts = { intraOpNumThreads: threads, interOpNumThreads: 1, executionProviders: ['cpu'] };
  log.info('supertonic', 'model yükleniyor (cpu, ' + threads + ' iş parçacığı)…');
  const [dp, textEnc, vectorEst, vocoder] = await Promise.all([
    ort.InferenceSession.create(modelPath('duration_predictor.onnx'), opts),
    ort.InferenceSession.create(modelPath('text_encoder.onnx'), opts),
    ort.InferenceSession.create(modelPath('vector_estimator.onnx'), opts),
    ort.InferenceSession.create(modelPath('vocoder.onnx'), opts),
  ]);
  log.info('supertonic', 'model yüklendi');
  return {
    ort,
    cfg,
    indexer,
    dp,
    textEnc,
    vectorEst,
    vocoder,
    styles: new Map(),
    sampleRate: cfg.ae.sample_rate,
    baseChunkSize: cfg.ae.base_chunk_size,
    chunkCompressFactor: cfg.ttl.chunk_compress_factor,
    ldim: cfg.ttl.latent_dim,
  };
}

function loadEngine() {
  if (engine) return Promise.resolve(engine);
  if (!enginePromise) {
    enginePromise = doLoadEngine().then(
      (e) => { engine = e; enginePromise = null; return e; },
      (e) => { enginePromise = null; throw e; }
    );
  }
  return enginePromise;
}

/* ses stili JSON → { ttl, dp } tensorları (motor başına önbellek) */
function loadStyle(eng, id) {
  const cached = eng.styles.get(id);
  if (cached) return cached;
  const raw = JSON.parse(fs.readFileSync(stylePath(id), 'utf8'));
  const ttl = new eng.ort.Tensor('float32', Float32Array.from(raw.style_ttl.data.flat(Infinity)), raw.style_ttl.dims);
  const dp = new eng.ort.Tensor('float32', Float32Array.from(raw.style_dp.data.flat(Infinity)), raw.style_dp.dims);
  const style = { ttl, dp };
  eng.styles.set(id, style);
  return style;
}

/* ---------- metin ön işleme (resmi helper.js portu) ---------- */

function preprocessText(text, lang) {
  let t = String(text || '').normalize('NFKD');
  t = t.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');
  const replacements = {
    '–': '-', '‑': '-', '—': '-', _: ' ',
    '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'",
    '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ',
  };
  for (const [k, v] of Object.entries(replacements)) t = t.split(k).join(v);
  t = t.replace(/[♥☆♡©\\]/g, '');
  t = t.replace(/@/g, ' at ').replace(/e\.g\.,/g, 'for example, ').replace(/i\.e\.,/g, 'that is, ');
  t = t.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!').replace(/ \?/g, '?').replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");
  while (t.includes('""')) t = t.replace('""', '"');
  while (t.includes("''")) t = t.replace("''", "'");
  while (t.includes('``')) t = t.replace('``', '`');
  t = t.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'\"')\]}…。」』】〉》›»]$/.test(t)) t += '.';
  return '<' + lang + '>' + t + '</' + lang + '>';
}

function chunkText(text, maxLen) {
  const paragraphs = String(text).trim().split(/\n\s*\n+/).filter((p) => p.trim());
  const chunks = [];
  for (let paragraph of paragraphs) {
    paragraph = paragraph.trim();
    if (!paragraph) continue;
    const sentences = paragraph.split(/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/);
    let current = '';
    for (const sentence of sentences) {
      if (current.length + sentence.length + 1 <= maxLen) current += (current ? ' ' : '') + sentence;
      else {
        if (current) chunks.push(current.trim());
        current = sentence;
      }
    }
    if (current) chunks.push(current.trim());
  }
  return chunks.length ? chunks : [String(text).trim()];
}

/* ---------- tensör yardımcıları ---------- */

function lengthToMask(lengths, maxLen) {
  maxLen = maxLen || Math.max(...lengths);
  const mask = [];
  for (let i = 0; i < lengths.length; i++) {
    const row = [];
    for (let j = 0; j < maxLen; j++) row.push(j < lengths[i] ? 1.0 : 0.0);
    mask.push([row]);
  }
  return mask;
}

function getLatentMask(wavLengths, baseChunkSize, chunkCompressFactor) {
  const latentSize = baseChunkSize * chunkCompressFactor;
  return lengthToMask(wavLengths.map((len) => Math.floor((len + latentSize - 1) / latentSize)));
}

function arrayToTensor(ort, array, dims) {
  return new ort.Tensor('float32', Float32Array.from(array.flat(Infinity)), dims);
}

function intArrayToTensor(ort, array, dims) {
  return new ort.Tensor('int64', BigInt64Array.from(array.flat(Infinity).map((x) => BigInt(x))), dims);
}

/* ---------- çıkarım ---------- */

function sampleNoisyLatent(eng, duration) {
  const wavLenMax = Math.max(...duration) * eng.sampleRate;
  const wavLengths = duration.map((d) => Math.floor(d * eng.sampleRate));
  const chunkSize = eng.baseChunkSize * eng.chunkCompressFactor;
  const latentLen = Math.floor((wavLenMax + chunkSize - 1) / chunkSize);
  const latentDim = eng.ldim * eng.chunkCompressFactor;

  const noisyLatent = [];
  for (let b = 0; b < duration.length; b++) {
    const batch = [];
    for (let d = 0; d < latentDim; d++) {
      const row = [];
      for (let t = 0; t < latentLen; t++) {
        const eps = 1e-10;
        const u1 = Math.max(eps, Math.random());
        const u2 = Math.random();
        row.push(Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2)); // Box-Muller
      }
      batch.push(row);
    }
    noisyLatent.push(batch);
  }

  const latentMask = getLatentMask(wavLengths, eng.baseChunkSize, eng.chunkCompressFactor);
  for (let b = 0; b < noisyLatent.length; b++) {
    for (let d = 0; d < noisyLatent[b].length; d++) {
      for (let t = 0; t < noisyLatent[b][d].length; t++) {
        noisyLatent[b][d][t] *= latentMask[b][0][t];
      }
    }
  }
  return { noisyLatent, latentMask };
}

async function inferOne(eng, text, lang, style, steps, speed) {
  const ort = eng.ort;
  const processed = preprocessText(text, lang);
  const textIdsLen = processed.length;
  const textIdsRow = new Array(textIdsLen).fill(0);
  const unicodeVals = Array.from(processed).map((c) => c.charCodeAt(0));
  for (let j = 0; j < unicodeVals.length; j++) {
    const idx = eng.indexer[unicodeVals[j]];
    textIdsRow[j] = Number.isFinite(idx) ? idx : -1;
  }
  const textIds = [textIdsRow];
  const textMask = lengthToMask([textIdsLen]);
  const textIdsShape = [1, textIdsLen];
  const textMaskShape = [1, 1, textMask[0][0].length];

  const textMaskTensor = arrayToTensor(ort, textMask, textMaskShape);

  const dpResult = await eng.dp.run({
    text_ids: intArrayToTensor(ort, textIds, textIdsShape),
    style_dp: style.dp,
    text_mask: textMaskTensor,
  });
  const durOnnx = Array.from(dpResult.duration.data);
  for (let i = 0; i < durOnnx.length; i++) durOnnx[i] /= speed;

  const textEncResult = await eng.textEnc.run({
    text_ids: intArrayToTensor(ort, textIds, textIdsShape),
    style_ttl: style.ttl,
    text_mask: textMaskTensor,
  });
  const textEmbTensor = textEncResult.text_emb;

  const { noisyLatent, latentMask } = sampleNoisyLatent(eng, durOnnx);
  const latentShape = [1, noisyLatent[0].length, noisyLatent[0][0].length];
  const latentMaskShape = [1, 1, latentMask[0][0].length];
  const latentMaskTensor = arrayToTensor(ort, latentMask, latentMaskShape);

  const totalStepArray = new Array(1).fill(steps);
  const scalarShape = [1];
  const totalStepTensor = arrayToTensor(ort, totalStepArray, scalarShape);

  for (let step = 0; step < steps; step++) {
    const currentStepArray = new Array(1).fill(step);
    const vectorEstResult = await eng.vectorEst.run({
      noisy_latent: arrayToTensor(ort, noisyLatent, latentShape),
      text_emb: textEmbTensor,
      style_ttl: style.ttl,
      text_mask: textMaskTensor,
      latent_mask: latentMaskTensor,
      total_step: totalStepTensor,
      current_step: arrayToTensor(ort, currentStepArray, scalarShape),
    });
    const denoised = vectorEstResult.denoised_latent.data;
    let idx = 0;
    for (let b = 0; b < noisyLatent.length; b++) {
      for (let d = 0; d < noisyLatent[b].length; d++) {
        for (let t = 0; t < noisyLatent[b][d].length; t++) {
          noisyLatent[b][d][t] = denoised[idx++];
        }
      }
    }
  }

  const vocoderResult = await eng.vocoder.run({
    latent: arrayToTensor(ort, noisyLatent, latentShape),
  });
  const wavAll = vocoderResult.wav_tts.data;
  const wavLen = Math.floor(durOnnx[0] * eng.sampleRate);
  return wavAll.slice(0, wavLen);
}

async function runInference(eng, text, lang, style, steps, speed) {
  const maxLen = lang === 'ko' || lang === 'ja' ? 120 : 300;
  const chunks = chunkText(text, maxLen);
  let wav = null;
  const silenceLen = Math.floor(0.3 * eng.sampleRate);
  for (const chunk of chunks) {
    const part = await inferOne(eng, chunk, lang, style, steps, speed);
    if (!wav) {
      wav = part;
    } else if (part.length) {
      const merged = new Float32Array(wav.length + silenceLen + part.length);
      merged.set(wav, 0);
      merged.set(part, wav.length + silenceLen);
      wav = merged;
    }
  }
  return wav || new Float32Array(0);
}

/* ---------- WAV (16-bit PCM mono) ---------- */

function encodeWav(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.floor(s * 32767), 44 + i * 2);
  }
  return buf;
}

/* ---------- sentez: metin → { audio: WAV buffer, mime } ---------- */

async function synthesize(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) throw new Error('boş metin');
  const vid = resolveVoice(opts.voice);
  const lang = resolveLang(opts.lang);
  const speed = clampNum(Number(opts.speed) || DEFAULT_SPEED, 0.7, 2);
  const steps = Math.round(clampNum(Number(opts.steps) || DEFAULT_STEPS, 5, 12));
  await ensureModel();
  await ensureVoice(vid);
  const eng = await loadEngine();
  const style = loadStyle(eng, vid);
  busy++;
  try {
    const pcm = await runInference(eng, t.slice(0, 4000), lang, style, steps, speed);
    if (!pcm.length) throw new Error('ses üretilemedi');
    return { audio: encodeWav(pcm, eng.sampleRate), mime: 'audio/wav' };
  } finally {
    busy--;
    if (busy <= 0) touchIdle();
  }
}

module.exports = {
  VOICES,
  LANGS,
  DEFAULT_VOICE,
  DEFAULT_LANG,
  DEFAULT_SPEED,
  DEFAULT_STEPS,
  synthesize,
  install,
  status,
  ensureModel,
  ensureVoice,
  modelInstalled,
  voiceInstalled,
};
