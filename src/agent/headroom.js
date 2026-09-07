'use strict';

/* ---------- BEAST × HEADROOM (OPSİYONEL token sıkıştırma) ----------
   Ayarlardan (Kurulum sekmesi) açılıp kapanır; kapalıyken hiçbir şey yapmaz.
   Açıkken: LLM istekleri yerel headroom proxy'sinden geçer — araç çıktıları,
   loglar ve JSON yükleri modele gitmeden sıkıştırılır (testte %39-71 tasarruf).
   Kurulum: uv tool install "headroom-ai[proxy]" (uv yoksa hata bildirir).
   Her provider için AYRI proxy portu (base URL farkları için); llm.js
   providerId → port haritasıyla yönlendirir, kapatınca düz bağlanır. */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { emitInstallProgress } = require('./progressbus');

const PORT_BASE = 18787;
const MAX_PROXIES = 8;

const state = {
  enabled: false,
  installing: false,
  installFailed: false,
  installError: '',
  starting: false,
  proxies: new Map(), // providerId -> { proc, port, baseUrl, ready }
  providerGetter: null, // () => [{ id, name, baseUrl }]
  statusSink: null, // (probe) => void — main renderer'a akıtır
};

function _emit() {
  try { if (state.statusSink) state.statusSink(probe()); } catch {}
}

function headroomExe() {
  const local = path.join(os.homedir(), '.local', 'bin', 'headroom.exe');
  if (fs.existsSync(local)) return local;
  try {
    require('child_process').execSync('where headroom', { timeout: 5000, stdio: 'pipe' });
    return 'headroom';
  } catch {}
  return '';
}

function uvExe() {
  const local = path.join(os.homedir(), '.local', 'bin', 'uv.exe');
  if (fs.existsSync(local)) return local;
  try {
    require('child_process').execSync('where uv', { timeout: 5000, stdio: 'pipe' });
    return 'uv';
  } catch {}
  return '';
}

function probe() {
  return {
    installed: !!headroomExe(),
    installing: state.installing,
    failed: state.installFailed,
    error: state.installError,
    enabled: state.enabled,
    starting: state.starting,
    proxies: [...state.proxies.values()].map((p) => ({ port: p.port, baseUrl: p.baseUrl, ready: p.ready })),
  };
}

/* ---------- KURULUM (arka plan) ----------
   uv tool install headroom-ai[proxy] — kendi izole Python 3.13 ortamını kurar;
   sistemde Python gerekmez. uv yoksa pip fallback, o da yoksa elle yönlendirir. */
function autoInstall() {
  if (state.installing || headroomExe()) return;
  const uv = uvExe();
  if (!uv) {
    state.installFailed = true;
    state.installError = 'uv bulunamadı — kur: winget install astral-sh.uv';
    _emit();
    return;
  }
  state.installing = true;
  state.installFailed = false;
  state.installError = '';
  _emit();
  emitInstallProgress('headroom', { pct: 4 });
  const proc = spawn(uv, ['tool', 'install', '--python', '3.13', 'headroom-ai[proxy]'], { windowsHide: true });
  let buf = '';
  let stage = 4;
  const bump = () => {
    stage = Math.min(92, stage + 7);
    emitInstallProgress('headroom', { pct: stage });
  };
  const onData = (c) => {
    const s = String(c);
    if (/Download|Resolve|Installed|Prepared/i.test(s)) bump();
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('close', (code) => {
    state.installing = false;
    if (code === 0 && headroomExe()) {
      emitInstallProgress('headroom', { pct: 100 });
    } else {
      state.installFailed = true;
      state.installError = 'kurulum başarısız — elle: uv tool install "headroom-ai[proxy]"';
    }
    _emit();
    /* kurulum bitti ve açık kaldıysa proxy'leri hemen başlat */
    if (state.enabled && headroomExe()) start().catch(() => {});
  });
  proc.on('error', () => {
    state.installing = false;
    state.installFailed = true;
    state.installError = 'kurulum başlatılamadı (uv)';
    _emit();
  });
}

/* ---------- PROXY SÜREÇLERİ ----------
   Provider başına bir proxy; cache modunu BOZMAMAK için mode=token,
   Beast'in tanımadığı headroom_retrieve aracı enjekte EDİLMESİN diye
   no-ccr (geri-getirilemez sıkıştırma, en yüksek tasarruf) ve rate limit
   kapalı (Beast'in kendi istek patlamalarına takılmasın). Beacon kapalı. */
function nextPort() {
  const used = new Set([...state.proxies.values()].map((p) => p.port));
  for (let i = 0; i < MAX_PROXIES; i++) {
    const port = PORT_BASE + i;
    if (!used.has(port)) return port;
  }
  return 0;
}

function spawnFor(provider) {
  return new Promise((resolve) => {
    const exe = headroomExe();
    if (!exe) return resolve({ ok: false, error: 'headroom kurulu değil' });
    const port = nextPort();
    if (!port) return resolve({ ok: false, error: 'port kalmadı' });
    let proc;
    try {
      proc = spawn(exe, [
        'proxy', '--port', String(port), '--openai-api-url', provider.baseUrl,
        '--mode', 'token', '--no-ccr', '--no-rate-limit',
      ], {
        windowsHide: true,
        env: { ...process.env, HEADROOM_BEACON: 'off', DO_NOT_TRACK: '1' },
      });
    } catch (e) {
      return resolve({ ok: false, error: String((e && e.message) || e) });
    }
    const rec = { proc, port, baseUrl: provider.baseUrl, ready: false };
    state.proxies.set(provider.id, rec);
    _emit();
    proc.on('exit', () => {
      if (state.proxies.get(provider.id) === rec) state.proxies.delete(provider.id);
      _emit();
    });
    const t0 = Date.now();
    const poll = setInterval(async () => {
      let ready = false;
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(2000) });
        ready = !!r.ok;
      } catch {}
      if (ready) {
        clearInterval(poll);
        rec.ready = true;
        _emit();
        return resolve({ ok: true, port });
      }
      if (Date.now() - t0 > 90000) {
        clearInterval(poll);
        try { rec.proc.kill(); } catch {}
        state.proxies.delete(provider.id);
        _emit();
        resolve({ ok: false, error: 'proxy zaman aşımı (90sn)' });
      }
    }, 1200);
  });
}

async function start() {
  const exe = headroomExe();
  if (!exe) {
    autoInstall();
    return { ok: false, error: 'kuruluyor — birkaç dakika sonra hazır olur' };
  }
  state.starting = true;
  _emit();
  try {
    const providers = (state.providerGetter ? state.providerGetter() : []).slice(0, MAX_PROXIES);
    const routes = {};
    /* önce eskileri temizle: listeden çıkan provider'ın proxy'sini kapat */
    const keep = new Set(providers.map((p) => p.id));
    for (const [id, rec] of [...state.proxies.entries()]) {
      if (keep.has(id)) continue;
      try { rec.proc.kill(); } catch {}
      try { spawn('taskkill', ['/pid', String(rec.proc.pid), '/T', '/F'], { windowsHide: true }); } catch {}
      state.proxies.delete(id);
    }
    for (const p of providers) {
      if (!p.baseUrl || state.proxies.has(p.id)) continue;
      const r = await spawnFor(p);
      if (r.ok) routes[p.id] = r.port;
    }
    try { require('./llm').setHeadroomRoutes(routes); } catch {}
    state.enabled = true;
    return { ok: true, routes };
  } finally {
    state.starting = false;
    _emit();
  }
}

async function setEnabled(on) {
  if (on) {
    state.enabled = true;
    if (!headroomExe()) {
      autoInstall();
      return { ok: false, installing: true, error: 'headroom arka planda kuruluyor — birkaç dakika sonra hazır' };
    }
    return start();
  }
  state.enabled = false;
  stopAll();
  try { require('./llm').setHeadroomRoutes(null); } catch {}
  return { ok: true };
}

/* provider listesi değişti (eklendi/silindi) → proxy setini senkronla */
function syncProviders() {
  if (!state.enabled || !headroomExe()) return;
  start().catch(() => {});
}

function stopAll() {
  for (const rec of state.proxies.values()) {
    try { rec.proc.kill(); } catch {}
    try { spawn('taskkill', ['/pid', String(rec.proc.pid), '/T', '/F'], { windowsHide: true }); } catch {}
  }
  state.proxies.clear();
  _emit();
}

function setProviderGetter(fn) { state.providerGetter = typeof fn === 'function' ? fn : null; }
function setStatusSink(fn) { state.statusSink = typeof fn === 'function' ? fn : null; }

/* proxy /stats özeti (sağlık duvarı yok — hata.yakalanır) */
async function stats() {
  const rec = [...state.proxies.values()].find((p) => p.ready);
  if (!rec) return { ok: false, running: false };
  try {
    const r = await fetch('http://127.0.0.1:' + rec.port + '/stats', { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    const s = (j && (j.tokens || j.summary)) || {};
    return {
      ok: true,
      running: true,
      port: rec.port,
      input: Number(s.input) || 0,
      output: Number(s.output) || 0,
      saved: Number(s.saved) || 0,
      proxyCompressionSaved: Number(s.proxy_compression_saved) || 0,
      savingsPercent: Number(s.savings_percent) || 0,
      allLayersSaved: Number(s.all_layers_saved) || 0,
    };
  } catch {
    return { ok: false, running: true, port: rec.port };
  }
}

module.exports = {
  probe,
  autoInstall,
  setEnabled,
  syncProviders,
  stopAll,
  setProviderGetter,
  setStatusSink,
  stats,
};
