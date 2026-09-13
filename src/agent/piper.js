'use strict';

/* Beast Piper TTS: tamamen YEREL/offline neural seslendirme (rhasspy/piper).
   - Runtime: piper_windows_amd64.zip (~21MB) → %APPDATA%\beast\piper\bin
     (piper.exe + espeak-ng-data + onnxruntime dll'leri birlikte gelir)
   - Sesler: diffusionstudio/piper-voices aynası → %APPDATA%\beast\piper\voices
     (tr_TR fahrettin/fettah medium = CC0; en_US lessac/amy medium)
   - piper.exe stdin metin → stdout WAV (22.05kHz mono 16-bit). mp3/ogg
     dönüşümü gerekmez: WhatsApp sesli not yolu ffmpeg ile ogg/opus'a çevirir,
     masaüstü oynatıcı WAV'ı doğrudan çalar.
   - İndirmeler kilitli: aynı anda iki kez başlamaz; ilerleme progressbus
     üzerinden Kurulum/Ayarlar panesine akar. Hata olursa bir sonraki
     çağrıda yeniden denenir. */

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { beastRoot } = require('./memory');
const log = require('./logger');
const { emitInstallProgress } = require('./progressbus');

const PIPER_VERSION = '2023.11.14-2';
const RUNTIME_URL = `https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_windows_amd64.zip`;
const VOICE_BASE = 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main';
const DEFAULT_VOICE = 'tr_TR-fahrettin-medium';

/* UI'da listelenen sesler — indirme url'si VOICE_BASE + path + .onnx(.json) */
const VOICES = {
  'tr_TR-fahrettin-medium': { name: 'Fahrettin — Türkçe (erkek)', path: 'tr/tr_TR/fahrettin/medium/tr_TR-fahrettin-medium' },
  'tr_TR-fettah-medium': { name: 'Fettah — Türkçe (erkek)', path: 'tr/tr_TR/fettah/medium/tr_TR-fettah-medium' },
  'en_US-lessac-medium': { name: 'Lessac — English (male)', path: 'en/en_US/lessac/medium/en_US-lessac-medium' },
  'en_US-amy-medium': { name: 'Amy — English (female)', path: 'en/en_US/amy/medium/en_US-amy-medium' },
};

function rootDir() {
  return path.join(beastRoot(), 'piper');
}
function binDir() {
  return path.join(rootDir(), 'bin');
}
function voicesDir() {
  return path.join(rootDir(), 'voices');
}
function exePath() {
  return path.join(binDir(), 'piper.exe');
}
function voicePath(id) {
  return path.join(voicesDir(), String(id) + '.onnx');
}
function voiceJsonPath(id) {
  return voicePath(id) + '.json';
}

function resolveVoice(id) {
  const v = String(id || '').trim();
  return VOICES[v] ? v : DEFAULT_VOICE;
}

function runtimeInstalled() {
  try {
    return fs.existsSync(exePath());
  } catch {
    return false;
  }
}
function voiceInstalled(id) {
  try {
    return !!VOICES[id] && fs.existsSync(voicePath(id)) && fs.existsSync(voiceJsonPath(id));
  } catch {
    return false;
  }
}

/* ---------- indirme (yüzde akışlı, .part → atomik rename) ---------- */

async function download(url, dest, tag) {
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
      emitInstallProgress(tag, { pct: total ? Math.round((loaded / total) * 100) : 0, loaded, total });
    }
  });
  await pipeline(rs, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  emitInstallProgress(tag, { pct: 100, loaded, total: total || loaded });
}

function unzip(zip, dest) {
  return new Promise((resolve, reject) => {
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(dest)} -Force`],
      { timeout: 5 * 60 * 1000, windowsHide: true },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

/* ---------- kurulum (kilitli) ---------- */

let runtimePromise = null;
const voicePromises = new Map();

function ensureRuntime() {
  if (runtimeInstalled()) return Promise.resolve(true);
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const zip = path.join(rootDir(), 'piper-' + PIPER_VERSION + '.zip');
    log.info('piper', 'runtime indiriliyor: ' + RUNTIME_URL);
    await download(RUNTIME_URL, zip, 'piper-runtime');
    const tmp = path.join(rootDir(), '.extract');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    await unzip(zip, tmp);
    const inner = path.join(tmp, 'piper');
    const src = fs.existsSync(path.join(inner, 'piper.exe')) ? inner : tmp;
    fs.mkdirSync(binDir(), { recursive: true });
    for (const e of fs.readdirSync(src)) {
      const from = path.join(src, e);
      const to = path.join(binDir(), e);
      fs.rmSync(to, { recursive: true, force: true });
      fs.renameSync(from, to);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    try { fs.unlinkSync(zip); } catch {}
    if (!runtimeInstalled()) throw new Error('piper.exe çıkarılamadı');
    log.info('piper', 'runtime hazır: ' + exePath());
    return true;
  })().catch((e) => {
    log.error('piper', 'runtime kurulumu başarısız: ' + String((e && e.message) || e));
    throw e;
  }).finally(() => {
    runtimePromise = null; // kilit çözülür; kuruluysa yukarıdaki kısa yol devrede
  });
  return runtimePromise;
}

function ensureVoice(id) {
  const vid = resolveVoice(id);
  if (voiceInstalled(vid)) return Promise.resolve(true);
  if (voicePromises.has(vid)) return voicePromises.get(vid);
  const p = (async () => {
    const base = VOICE_BASE + '/' + VOICES[vid].path;
    log.info('piper', 'ses modeli indiriliyor: ' + vid);
    await download(base + '.onnx', voicePath(vid), 'piper-voice');
    await download(base + '.onnx.json', voiceJsonPath(vid), 'piper-voice');
    if (!voiceInstalled(vid)) throw new Error('ses modeli indirilemedi: ' + vid);
    log.info('piper', 'ses hazır: ' + vid);
    return true;
  })().catch((e) => {
    log.error('piper', 'ses indirme başarısız (' + vid + '): ' + String((e && e.message) || e));
    throw e;
  }).finally(() => {
    voicePromises.delete(vid); // kilit çözülür; kuruluysa yukarıdaki kısa yol devrede
  });
  voicePromises.set(vid, p);
  return p;
}

/* UI/Kurulum için durum: { installed, runtime, voice, voiceId, installing } */
function status(voiceId) {
  const vid = resolveVoice(voiceId);
  return {
    installed: runtimeInstalled() && voiceInstalled(vid),
    runtime: runtimeInstalled(),
    voice: voiceInstalled(vid),
    voiceId: vid,
    installing: !!runtimePromise || voicePromises.has(vid),
  };
}

/* elle/otomatik kurulum: runtime + ses (hata fırlatmaz, {ok} döner) */
async function install(voiceId) {
  const vid = resolveVoice(voiceId);
  try {
    await ensureRuntime();
    await ensureVoice(vid);
    return { ok: true, voice: vid };
  } catch (e) {
    return { ok: false, voice: vid, error: String((e && e.message) || e) };
  }
}

/* ---------- sentez: metin → { audio: WAV buffer, mime } ---------- */

function synthesize(text, opts = {}) {
  const vid = resolveVoice(opts.voice);
  return (async () => {
    await ensureRuntime();
    await ensureVoice(vid);
    return new Promise((resolve, reject) => {
      const args = [
        '--model', voicePath(vid),
        '--config', voiceJsonPath(vid),
        '--output_file', '-',
        '-q',
      ];
      const p = spawn(exePath(), args, { windowsHide: true, cwd: binDir() });
      const chunks = [];
      let err = '';
      const timer = setTimeout(() => {
        try { p.kill(); } catch {}
        reject(new Error('piper zaman aşımı'));
      }, 120000);
      p.stdout.on('data', (d) => chunks.push(d));
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
      p.on('close', (code) => {
        clearTimeout(timer);
        const buf = Buffer.concat(chunks);
        if (code !== 0 || buf.length < 44) {
          return reject(new Error('piper başarısız (kod ' + code + '): ' + err.slice(0, 140)));
        }
        resolve({ audio: buf, mime: 'audio/wav' });
      });
      p.stdin.write(String(text).slice(0, 4000));
      p.stdin.end();
    });
  })();
}

module.exports = {
  VOICES,
  DEFAULT_VOICE,
  synthesize,
  install,
  status,
  ensureRuntime,
  ensureVoice,
  runtimeInstalled,
  voiceInstalled,
};
