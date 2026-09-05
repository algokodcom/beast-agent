'use strict';

/* Beast App: %APPDATA%\beast\apps\<id>\ — JS uygulama/extension çalıştırıcı.
   Her app: app.json (manifest) + main.js (arka uç, beast API'si) + ui/ (isteğe
   bağlı arayüz — Beast App panelinde webview olarak açılır).

   app main.js şablonu:
     module.exports = (beast) => {
       beast.tools.register('hesapla', { description, parameters, handler });
       beast.every(60000, () => { ... });
       beast.notify('hazır');
     };

   Araçlar modele `app__<id>__<tool>` adıyla açılır (engine app__* isimlerini
   buraya dispatch eder). Kurulum: `beast install github.com/u/r` / npm:paket. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { beastRoot } = require('./memory');
const log = require('./logger');

const TOOL_PREFIX = 'app__';
const MAX_TOOLS_TOTAL = 24; // tüm app'lerin toplam araç tavanı (prompt şişmesin)
const CALL_TIMEOUT_MS = 15000;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/* ---------- yollar + durum ---------- */

function dir() {
  return path.join(beastRoot(), 'apps');
}

function stateFile() {
  return path.join(beastRoot(), 'apps-state.json');
}

let state = null; // id -> { enabled, installedAt, source }

function loadState() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {};
  } catch {
    state = {};
  }
  return state;
}

function saveState() {
  try {
    fs.mkdirSync(beastRoot(), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state || {}, null, 2));
  } catch (e) {
    log.warn('apps', 'state yazılamadı: ' + String((e && e.message) || e));
  }
}

function isEnabled(id) {
  const st = loadState()[id];
  return !st || st.enabled !== false; // varsayılan: etkin
}

/* ---------- manifest ---------- */

function readManifest(appDir) {
  const m = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8'));
  const id = String(m.id || path.basename(appDir)).toLowerCase();
  if (!ID_RE.test(id)) throw new Error('geçersiz app id: ' + id);
  return {
    id,
    name: String(m.name || id).slice(0, 60),
    version: String(m.version || '0.0.0').slice(0, 16),
    description: String(m.description || '').slice(0, 300),
    author: String(m.author || '').slice(0, 60),
    icon: String(m.icon || '🧩').slice(0, 8),
    permissions: Array.isArray(m.permissions) ? m.permissions.map(String).slice(0, 8) : [],
    ui: m.ui && typeof m.ui === 'string' ? m.ui : null,
    main: m.main && typeof m.main === 'string' ? m.main : 'main.js',
    builtin: !!m.builtin,
  };
}

/* Tüm kurulu app'ler — UI'ın beklediği düz liste */
function scan() {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir(), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const appDir = path.join(dir(), e.name);
    try {
      const m = readManifest(appDir);
      const inst = registry.get(m.id);
      const st = loadState()[m.id];
      out.push({
        ...m,
        dir: appDir,
        uiPath: m.ui && fs.existsSync(path.join(appDir, m.ui)) ? m.ui : null,
        enabled: isEnabled(m.id),
        loaded: !!inst,
        tools: inst ? [...inst.tools.keys()] : [],
        error: (inst && inst.error) || null,
        installedAt: (st && st.installedAt) || null,
      });
    } catch (er) {
      out.push({
        id: e.name,
        name: e.name,
        version: '?',
        description: '',
        author: '',
        icon: '⚠️',
        permissions: [],
        ui: null,
        main: 'main.js',
        builtin: false,
        dir: appDir,
        uiPath: null,
        enabled: isEnabled(e.name),
        loaded: false,
        tools: [],
        error: 'manifest hatası: ' + String((er && er.message) || er),
        installedAt: null,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------- çalışma zamanı (host) ---------- */

/* id -> { api, tools: Map(name → def), timers: [], error } */
const registry = new Map();

/* main.js'ten gelir: bildirim + log köprüsü */
let bridges = { notify: null };

function init(bridgeOverrides) {
  bridges = { ...bridges, ...(bridgeOverrides || {}) };
}

function storageFile(id) {
  return path.join(dir(), id, 'data.json');
}

function makeApi(id) {
  const tools = new Map();
  const timers = [];
  const api = {
    id,
    tools: {
      register(name, def) {
        const nm = String(name || '');
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(nm)) throw new Error('geçersiz araç adı: ' + nm);
        if (typeof (def && def.handler) !== 'function') throw new Error("'" + nm + "' için handler fonksiyonu gerekli");
        tools.set(nm, {
          name: nm,
          description: String(def.description || nm).slice(0, 300),
          parameters: def.parameters && typeof def.parameters === 'object' ? def.parameters : { type: 'object', properties: {} },
          handler: def.handler,
        });
        return true;
      },
      list() {
        return [...tools.keys()];
      },
    },
    storage: {
      get(key, dflt) {
        try {
          const data = JSON.parse(fs.readFileSync(storageFile(id), 'utf8'));
          return key in data ? data[key] : dflt;
        } catch {
          return dflt;
        }
      },
      set(key, value) {
        try {
          let data = {};
          try {
            data = JSON.parse(fs.readFileSync(storageFile(id), 'utf8'));
          } catch {}
          data[key] = value;
          fs.mkdirSync(path.dirname(storageFile(id)), { recursive: true });
          fs.writeFileSync(storageFile(id), JSON.stringify(data));
          return true;
        } catch (e) {
          log.warn('apps:' + id, 'storage yazılamadı: ' + String((e && e.message) || e));
          return false;
        }
      },
      all() {
        try {
          return JSON.parse(fs.readFileSync(storageFile(id), 'utf8'));
        } catch {
          return {};
        }
      },
    },
    notify(text) {
      const t = String(text || '').slice(0, 300);
      log.info('apps:' + id, 'bildirim: ' + t);
      try {
        if (typeof bridges.notify === 'function') bridges.notify(id, t);
      } catch {}
      return true;
    },
    log(...args) {
      log.info(
        'apps:' + id,
        args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 500)
      );
    },
    every(ms, fn) {
      const iv = setInterval(() => {
        try {
          fn();
        } catch (e) {
          log.warn('apps:' + id, 'interval hatası: ' + String((e && e.message) || e));
        }
      }, Math.max(1000, Number(ms) || 60000));
      timers.push(iv);
      return iv;
    },
  };
  return { api, tools, timers, error: null };
}

function startApp(id) {
  const appDir = path.join(dir(), id);
  let m;
  try {
    m = readManifest(appDir);
  } catch (e) {
    return { ok: false, error: 'manifest okunamadı: ' + String((e && e.message) || e) };
  }
  stopApp(id);
  const mainPath = path.join(appDir, m.main);
  if (!fs.existsSync(mainPath)) return { ok: false, error: m.main + ' bulunamadı' };
  let inst;
  try {
    delete require.cache[require.resolve(mainPath)];
    const mod = require(mainPath);
    inst = makeApi(id);
    const fn = typeof mod === 'function' ? mod : mod && (mod.activate || mod.default);
    if (typeof fn !== 'function') throw new Error('main.js bir fonksiyon export etmeli: module.exports = (beast) => {...}');
    fn(inst.api);
  } catch (e) {
    if (inst) for (const t of inst.timers) clearInterval(t);
    return { ok: false, error: 'yüklenemedi: ' + String((e && e.message) || e) };
  }
  registry.set(id, inst);
  log.info('apps', "'" + id + "' yüklendi — araçlar: " + ([...inst.tools.keys()].join(', ') || '(yok)'));
  return { ok: true, tools: [...inst.tools.keys()] };
}

function stopApp(id) {
  const inst = registry.get(id);
  if (inst) {
    for (const t of inst.timers) clearInterval(t);
    registry.delete(id);
  }
  try {
    const appDir = path.join(dir(), id);
    const m = readManifest(appDir);
    delete require.cache[require.resolve(path.join(appDir, m.main))];
  } catch {}
  if (inst) log.info('apps', "'" + id + "' durduruldu");
  return { ok: true };
}

function startAll() {
  const results = {};
  for (const app of scan()) {
    if (!app.enabled || app.error) continue;
    const r = startApp(app.id);
    if (!r.ok) {
      results[app.id] = r.error;
      log.warn('apps', "'" + app.id + "' yüklenemedi: " + r.error);
    }
  }
  return results;
}

function stopAll() {
  for (const id of [...registry.keys()]) stopApp(id);
}

function reloadAll() {
  stopAll();
  return startAll();
}

/* ---------- engine köprüsü (MCP deseni) ---------- */

function schemas() {
  const out = [];
  for (const [id, inst] of registry) {
    for (const t of inst.tools.values()) {
      out.push({
        type: 'function',
        function: {
          name: TOOL_PREFIX + id + '__' + t.name,
          description: '[app:' + id + '] ' + t.description,
          parameters: t.parameters,
        },
      });
    }
  }
  return out.slice(0, MAX_TOOLS_TOTAL);
}

function mergeTools(toolsList) {
  const extra = schemas();
  return extra.length ? toolsList.concat(extra) : toolsList;
}

function parseFullName(fullName) {
  const m = String(fullName || '').match(/^app__([a-z0-9][a-z0-9_-]{0,31})__([A-Za-z0-9_-]{1,40})$/);
  return m ? { id: m[1], tool: m[2] } : null;
}

async function call(fullName, args, signal) {
  const parsed = parseFullName(fullName);
  if (!parsed) return { ok: false, error: 'geçersiz app araç adı: ' + fullName };
  let inst = registry.get(parsed.id);
  if (!inst) {
    const appDir = path.join(dir(), parsed.id);
    if (fs.existsSync(path.join(appDir, 'app.json')) && isEnabled(parsed.id)) {
      const r = startApp(parsed.id);
      if (r.ok) inst = registry.get(parsed.id);
      else return { ok: false, error: "app '" + parsed.id + "' başlatılamadı: " + r.error };
    } else {
      return { ok: false, error: "app '" + parsed.id + "' yüklü değil" };
    }
  }
  const def = inst.tools.get(parsed.tool);
  if (!def) return { ok: false, error: "araç '" + parsed.tool + "' app '" + parsed.id + "' içinde kayıtlı değil" };
  try {
    const res = await Promise.race([
      Promise.resolve(def.handler(args || {})),
      new Promise((_, rej) => {
        const timer = setTimeout(() => rej(new Error('zaman aşımı (' + CALL_TIMEOUT_MS / 1000 + 's)')), CALL_TIMEOUT_MS);
        if (signal)
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              rej(new Error('iptal edildi'));
            },
            { once: true }
          );
      }),
    ]);
    if (res && typeof res === 'object' && 'ok' in res) return res;
    return { ok: true, result: typeof res === 'string' ? res : JSON.stringify(res) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- kurulum (github / npm / yerel klasör) ---------- */

function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[çğıöşü]/g, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' }[c] || c))
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'app'
  );
}

function sh(cmd, args, opts) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const p = spawn(cmd, args, { windowsHide: true, ...(opts || {}) });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ ok: false, out, err: String(e.message || e) }));
    p.on('close', (code) => resolve({ ok: code === 0, out, err, code }));
  });
}

/* NOT: fs.cpSync Node v22.20.0 + Windows'ta process'i çökertiyor (0xC0000409)
   — burada VEYA başka yerde KULLANMA. Kopyalama daima bu yardımcıyla: */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function fetchZip(gitUrl, destDir) {
  /* git yoksa codeload zip fallback (main → master) */
  const m = String(gitUrl).match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const zipPath = path.join(destDir, 'repo.zip');
  for (const branch of ['main', 'master']) {
    try {
      const res = await fetch('https://codeload.github.com/' + m[1] + '/' + m[2] + '/zip/refs/heads/' + branch, {
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) continue;
      fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
      const r = await sh('powershell', [
        '-NoProfile',
        '-Command',
        "Expand-Archive -LiteralPath '" + zipPath + "' -DestinationPath '" + path.join(destDir, 'unzipped') + "' -Force",
      ]);
      if (r.ok) {
        const un = path.join(destDir, 'unzipped');
        const subs = fs.readdirSync(un, { withFileTypes: true }).filter((e) => e.isDirectory());
        return subs.length === 1 ? path.join(un, subs[0].name) : un;
      }
    } catch {}
  }
  return null;
}

/* source: github URL/kısaltma | npm:<paket> | yerel klasör yolu | npm paket adı */
async function install(source) {
  const raw = String(source || '').trim();
  if (!raw) return { ok: false, error: 'kaynak boş — örnek: github.com/kullanici/repo' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-app-'));
  let srcDir = null;
  try {
    const isShorthand = /^[\w.-]+\/[\w.-]+$/.test(raw);
    const isUrl = /^https?:\/\//i.test(raw) || /^github\.com/i.test(raw) || isShorthand;
    const isNpm = /^npm:/i.test(raw);
    if (isNpm || (!isUrl && !fs.existsSync(raw))) {
      /* npm paketi: npm pack + tar çıkarımı (Win10+ bsdtar) */
      const pkg = raw.replace(/^npm:/i, '').split(/\s+/)[0];
      if (!/^[@a-zA-Z0-9][@a-zA-Z0-9._/-]*$/.test(pkg)) return { ok: false, error: 'geçersiz paket adı: ' + pkg };
      const pr = await sh('npm', ['pack', pkg, '--pack-destination', tmp], { cwd: tmp });
      const tgz = (pr.out || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.endsWith('.tgz'))
        .pop();
      if (!pr.ok || !tgz) return { ok: false, error: 'npm pack başarısız: ' + ((pr.err || pr.out || '').slice(-300) || pkg) };
      const xr = await sh('tar', ['-xzf', tgz, '-C', tmp]);
      if (!xr.ok) return { ok: false, error: 'paket açılamadı: ' + (xr.err || '').slice(-300) };
      srcDir = path.join(tmp, 'package');
    } else if (isUrl) {
      const url = isShorthand ? 'https://github.com/' + raw : raw;
      const gr = await sh('git', ['clone', '--depth', '1', url, path.join(tmp, 'repo')], { cwd: tmp });
      if (gr.ok) srcDir = path.join(tmp, 'repo');
      else {
        const un = await fetchZip(url, tmp);
        if (!un) return { ok: false, error: 'repo indirilemedi (git yok ve zip erişilemedi): ' + ((gr.err || '').slice(-200)) };
        srcDir = un;
      }
    } else {
      srcDir = path.resolve(raw);
    }
    /* app.json hangi derinlikte? (kök veya tek alt klasör) */
    let appDir = null;
    const candidates = [srcDir];
    try {
      for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
        if (e.isDirectory()) candidates.push(path.join(srcDir, e.name));
      }
    } catch {}
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, 'app.json'))) {
        appDir = c;
        break;
      }
    }
    if (!appDir) return { ok: false, error: 'repoda app.json bulunamadı — bu klasör Beast App manifesti içermiyor' };
    const m = readManifest(appDir);
    const dest = path.join(dir(), m.id);
    if (fs.existsSync(dest)) stopApp(m.id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyDir(appDir, dest);
    loadState()[m.id] = { enabled: true, installedAt: new Date().toISOString(), source: raw.slice(0, 200) };
    saveState();
    const r = startApp(m.id);
    log.info('apps', 'kuruldu: ' + m.id + ' v' + m.version + ' (' + raw + ')');
    return { ok: true, id: m.id, name: m.name, version: m.version, start: r };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

async function remove(id) {
  const appDir = path.join(dir(), String(id || ''));
  if (!fs.existsSync(path.join(appDir, 'app.json'))) return { ok: false, error: 'app bulunamadı: ' + id };
  stopApp(id);
  try {
    fs.rmSync(appDir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  delete loadState()[id];
  saveState();
  return { ok: true };
}

function toggle(id, enabled) {
  const st = loadState();
  st[id] = { ...(st[id] || { installedAt: new Date().toISOString() }), enabled: !!enabled };
  saveState();
  if (enabled) return startApp(id);
  stopApp(id);
  return { ok: true, disabled: true };
}

/* ---------- slash komut çıktıları ---------- */

function listText() {
  const all = scan();
  if (!all.length) return 'Kurulu app yok — Beast App panelinden veya `/install github.com/kullanici/repo` ile kur.';
  const lines = ['*Beast App — kurulu uygulamalar*'];
  for (const a of all) {
    const st = a.error ? ' ⚠️ ' + a.error : a.enabled ? (a.loaded ? ' ✅' : ' (etkin)') : ' ⏸ kapalı';
    lines.push('• *' + a.icon + ' ' + a.name + '* v' + a.version + ' — ' + (a.description || 'açıklama yok') + st);
    if (a.tools.length) lines.push('  araçlar: ' + a.tools.map((t) => '`app__' + a.id + '__' + t + '`').join(', '));
  }
  lines.push('', 'Kurulum: `/install github.com/kullanici/repo` · panel: sol altta 🧊 Beast App');
  return lines.join('\n');
}

/* ---------- builtin seed app'ler ---------- */

function seedAppsDir() {
  return path.join(__dirname, 'seed-apps');
}

function seedApps() {
  let entries;
  try {
    entries = fs.readdirSync(seedAppsDir(), { withFileTypes: true });
  } catch {
    return;
  }
  fs.mkdirSync(dir(), { recursive: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dest = path.join(dir(), e.name);
    if (fs.existsSync(path.join(dest, 'app.json'))) continue; // kullanıcı app'i korunur
    try {
      copyDir(path.join(seedAppsDir(), e.name), dest);
      log.info('apps', 'seed kuruldu: ' + e.name);
    } catch (er) {
      log.warn('apps', 'seed kurulamadı ' + e.name + ': ' + String((er && er.message) || er));
    }
  }
}

module.exports = {
  dir,
  init,
  scan,
  seedApps,
  startAll,
  stopAll,
  reloadAll,
  startApp,
  stopApp,
  schemas,
  mergeTools,
  call,
  install,
  remove,
  toggle,
  listText,
  isEnabled,
  TOOL_PREFIX,
};
