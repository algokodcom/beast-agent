'use strict';

/* Beast Computer Use v2 (cua-driver): Windows/macOS/Linux GUI otomasyonu.
   Hermes SKILL.md modeli: arka planda sür (cursor oynatmaz, focus çalmaz),
   önce capture (SOM → numaralı element index'i), element index'iyle tıkla,
   aksiyon sonrası capture_after ile doğrula; yalnız sürücünün döndüğü
   yapılandırılmış sinyale göre (effect/escalation) merdivenden çık.

   Sürücü: https://github.com/trycua/cua — `cua-driver mcp` stdio MCP sunucusu;
   el yazımı minimal JSON-RPC 2.0 client'ı (mcp.js ile aynı çerçeve).
   Binary yoksa eski PowerShell backend'ine düşer (yalnız koordinat + foreground).

   Kurulum (Windows): irm https://cua.ai/driver/install.ps1 | iex
   Override: BEAST_CUA_DRIVER_CMD ile sürücü yolu/başka binary verilebilir.

   Güvenlik: şüpheli shell yazma pattern'leri ve kilit/logout tuş kombinasyonları
   modül seviyesinde blokludur; onay kapısı engine tarafında çalışır. */

const { spawn, execFile } = require('child_process');
const log = require('./logger');
const { emitInstallProgress } = require('./progressbus');

/* ---------- durum ---------- */
const S = {
  proc: null,
  buf: '',
  nextId: 1,
  pending: new Map(),
  booted: false,
  tools: null,
  downUntil: 0,
  starting: null,
  target: null, /* son hedef: { pid, window_id, app_name, title } */
  snapshot: null, /* { id, pid, window_id, map:Map(element_index→element), at } */
  probe: null, /* { at, res } — 60 sn cache'li sürücü taraması */
};
const CALL_TIMEOUT = 120000; /* capture'ın AX yürüyüşü 20 sn'yi bulabilir */
const RETRY_COOLDOWN = 30000;

/* ---------- otomatik kurulum (Hermes installer deseni: best-effort, arka planda) ---------- */

const CUA_INSTALL_PS1 = 'https://cua.ai/driver/install.ps1';
const CUA_INSTALL_SH = 'https://cua.ai/driver/install.sh';
/* oturum başına tek otomatik kurulum; elle override edilen binary'ye dokunulmaz */
const INST = { running: null, done: false, failed: false, startedAt: 0, tick: null };

function autoInstallAllowed() {
  /* BEAST_CUA_DRIVER_CMD verildiyse kullanıcı sürücüyü kendisi yönetiyor —
     otomatik kurulum asla çalışmaz (tests dahil). */
  return !String(process.env.BEAST_CUA_DRIVER_CMD || '').trim();
}

/* cua-driver --version: kurulu mu? 60 sn cache'li (Kurulum sekmesi 4 sn'de tarar) */
function probe(force) {
  if (!force && S.probe && Date.now() - S.probe.at < 60000) return Promise.resolve(S.probe.res);
  return new Promise((resolve) => {
    execFile(driverCmd(), ['--version'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      const res = {
        installed: !err && !!String(stdout || '').trim(),
        version: String(stdout || '').trim().split('\n')[0] || '',
        installing: !!INST.running,
        failed: !!INST.failed,
      };
      S.probe = { at: Date.now(), res };
      resolve(res);
    });
  });
}

function runInstaller(cb) {
  if (process.platform === 'win32') {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `irm ${CUA_INSTALL_PS1} | iex`],
      { timeout: 15 * 60 * 1000, windowsHide: true },
      cb
    );
  } else {
    execFile('bash', ['-lc', `curl -fsSL ${CUA_INSTALL_SH} | bash`], { timeout: 15 * 60 * 1000 }, cb);
  }
}

/** cua-driver kurulumunu arka planda başlat (Hermes'in best-effort installer'ı gibi).
    Yüzde üretmeyen installer için Kurulum sekmesinde yavaş ilerleme çubuğu çizilir. */
function autoInstall() {
  if (!autoInstallAllowed()) {
    return { ok: false, disabled: true, error: 'BEAST_CUA_DRIVER_CMD elle verilmiş — otomatik kurulum atlandı' };
  }
  if (INST.running) return { ok: true, installing: true };
  if (INST.done) return { ok: true, installing: false, done: true };
  if (INST.failed) return { ok: false, error: 'önceki kurulum denemesi başarısız — elle kur: irm ' + CUA_INSTALL_PS1 + ' | iex' };
  INST.startedAt = Date.now();
  log.info('computeruse', 'cua-driver kurulumu arka planda başlıyor (cua.ai installer)');
  INST.tick = setInterval(() => {
    /* yüzdeleri üretmeyen installer: 10 sn'de bir yumuşak ilerleme, tavan %95 */
    const el = (Date.now() - INST.startedAt) / 1000;
    emitInstallProgress('cua-driver', { pct: Math.min(95, 3 + el / 4), loaded: 0, total: 0 });
  }, 10000);
  INST.running = new Promise((resolve) => {
    runInstaller((err, stdout, stderr) => {
      if (INST.tick) { clearInterval(INST.tick); INST.tick = null; }
      INST.running = null;
      S.probe = null;
      if (err) {
        INST.failed = true;
        log.error('computeruse', 'cua-driver kurulumu başarısız: ' + String((stderr || err.message) || '').slice(0, 200));
        resolve({ ok: false, error: 'kurulum başarısız — elle kur: irm ' + CUA_INSTALL_PS1 + ' | iex' });
      } else {
        INST.done = true;
        S.downUntil = 0; /* sonraki computer_use çağrısı taze boot dener */
        log.info('computeruse', 'cua-driver kuruldu — sonraki computer_use çağrısında devreye girer');
        emitInstallProgress('cua-driver', { pct: 100, loaded: 1, total: 1 });
        resolve({ ok: true, done: true });
      }
    });
  });
  return { ok: true, installing: true };
}

/* sürücü yoksa sessizce tetikle (oturum başına bir kez) */
function maybeAutoInstall() {
  if (INST.running || INST.done || INST.failed) return;
  if (!autoInstallAllowed()) return;
  probe(true).then((st) => {
    if (!st.installed) autoInstall();
  }).catch(() => {});
}

function driverCmd() {
  const v = String(process.env.BEAST_CUA_DRIVER_CMD || '').trim();
  return v || 'cua-driver';
}

/* ---------- MCP stdio istemcisi ---------- */

function teardown(reason) {
  if (S.proc) {
    try { S.proc.kill(); } catch {}
    S.proc = null;
  }
  S.booted = false;
  S.tools = null;
  for (const [, p] of S.pending) {
    try { p.reject(new Error(reason || 'cua-driver bağlantısı kapandı')); } catch {}
  }
  S.pending.clear();
}

function boot() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (!ok) {
        S.downUntil = Date.now() + RETRY_COOLDOWN;
        maybeAutoInstall(); /* sürücü yoksa arka planda kurulum başlat */
      }
      resolve(ok);
    };
    let proc;
    try {
      proc = spawn(driverCmd(), ['mcp'], {
        windowsHide: true,
        env: { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: '0' },
      });
    } catch {
      return finish(false);
    }
    S.proc = proc;
    proc.on('error', () => { teardown(); finish(false); });
    proc.on('exit', () => { teardown(); finish(false); });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      S.buf += d;
      let i;
      while ((i = S.buf.indexOf('\n')) >= 0) {
        const line = S.buf.slice(0, i).trim();
        S.buf = S.buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && S.pending.has(m.id)) {
          const p = S.pending.get(m.id);
          S.pending.delete(m.id);
          if (m.error) p.reject(new Error(String((m.error && m.error.message) || 'MCP hatası')));
          else p.resolve(m.result);
        }
        /* bildirimler (agent cursor vb.) yok sayılır */
      }
    });
    /* initialize → initialized → tools/list */
    (async () => {
      try {
        await rpc('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'beast-agent', version: '1.0.0' },
        }, 15000);
        writeLine({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const list = await rpc('tools/list', {}, 15000);
        S.tools = new Set(((list && list.tools) || []).map((t) => t.name));
        S.booted = true;
        finish(true);
      } catch {
        teardown();
        finish(false);
      }
    })();
  });
}

let starting = null;
async function ensure() {
  if (S.proc && S.booted) return true;
  if (Date.now() < S.downUntil) {
    maybeAutoInstall(); /* cooldown'da da kurulum eksikse başlatılsın */
    return false;
  }
  if (!starting) {
    starting = boot().finally(() => { starting = null; });
  }
  return starting;
}

function writeLine(obj) {
  if (!S.proc || !S.proc.stdin.writable) return;
  try { S.proc.stdin.write(JSON.stringify(obj) + '\n'); } catch {}
}

function rpc(method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = S.nextId++;
    const timer = setTimeout(() => {
      S.pending.delete(id);
      reject(new Error('cua-driver zaman aşımı: ' + method));
    }, timeoutMs || 30000);
    S.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    writeLine({ jsonrpc: '2.0', id, method, params: params || {} });
  });
}

/* MCP CallTool zarfını { isError, text, structured, image } biçimine indirger */
function readResult(res) {
  let text = '';
  let image = null;
  for (const c of Array.isArray(res && res.content) ? res.content : []) {
    if (c && c.type === 'text') text += (text ? '\n' : '') + String(c.text || '');
    else if (c && c.type === 'image') image = 'data:' + (c.mimeType || 'image/png') + ';base64,' + c.data;
  }
  text = text.replace(/^\u2705+\s*/, '').trim();
  return { isError: !!res.isError, text, structured: (res && res.structuredContent) || null, image };
}

function hasTool(name) {
  return !S.tools || S.tools.has(name); /* tools/list boş döndüyse geç */
}

async function call(tool, args, timeoutMs) {
  if (!(await ensure())) throw new Error('cua-driver yok');
  if (!hasTool(tool)) throw new Error('cua-driver bu aksiyonu desteklemiyor: ' + tool);
  const res = await rpc('tools/call', { name: tool, arguments: args || {} }, timeoutMs || CALL_TIMEOUT);
  return readResult(res);
}

/* structuredContent + metin fallback'ından satır dizisi çıkarır */
function rowsOf(r) {
  const s = r && r.structured;
  if (Array.isArray(s)) return s;
  if (s && Array.isArray(s.windows)) return s.windows;
  if (s && Array.isArray(s.elements)) return s.elements;
  if (s && Array.isArray(s.apps)) return s.apps;
  if (r && r.text) {
    try {
      const m = r.text.match(/\[[\s\S]*\]/);
      if (m) return JSON.parse(m[0]);
    } catch {}
  }
  return [];
}

/* ---------- hedef seçimi ---------- */

async function findTarget(app) {
  const r = await call('list_windows', { on_screen_only: true });
  let cands = rowsOf(r).filter((w) => w && w.pid != null && w.window_id != null);
  if (app) {
    const q = String(app).toLowerCase();
    cands = cands.filter((w) =>
      String(w.app_name || '').toLowerCase().includes(q) ||
      String(w.title || '').toLowerCase().includes(q));
  }
  if (!cands.length) return null;
  cands.sort((a, b) => (Number(b.z_index) || 0) - (Number(a.z_index) || 0));
  return {
    pid: Number(cands[0].pid),
    window_id: Number(cands[0].window_id),
    app_name: String(cands[0].app_name || ''),
    title: String(cands[0].title || ''),
  };
}

/* capture → snapshot cache + Hermes tarzı numaralı index (+ opsiyonel görsel) */
async function doCapture(args = {}) {
  const t = args.app || !S.target ? await findTarget(args.app) : S.target;
  if (!t) {
    return { ok: false, error: 'hedef pencere bulunamadı' + (args.app ? ': ' + args.app : '') };
  }
  S.target = t;
  const mode = args.mode === 'vision' || args.mode === 'ax' ? args.mode : 'som';
  const wargs = { pid: t.pid, window_id: t.window_id };
  if (mode === 'vision') wargs.include_accessibility_tree = false;
  if (mode === 'ax') wargs.include_screenshot = false;
  const r = await call('get_window_state', wargs);
  if (r.isError) return { ok: false, error: (r.text || 'capture başarısız').slice(0, 300) };
  const s = r.structured || {};
  const elements = Array.isArray(s.elements) ? s.elements : [];
  S.snapshot = {
    id: String(s.snapshot_id || s.snapshotId || ''),
    pid: t.pid,
    window_id: t.window_id,
    map: new Map(),
    at: Date.now(),
  };
  for (const el of elements) {
    if (el && el.element_index != null) S.snapshot.map.set(Number(el.element_index), el);
  }
  const out = {
    ok: true,
    op: 'capture',
    app: t.app_name,
    window: { pid: t.pid, window_id: t.window_id, title: t.title },
    elements: elements.length,
    index: elements.slice(0, 200).map((el) => {
      const f = el.frame || {};
      const val = el.value != null && String(el.value).length ? " = '" + String(el.value).slice(0, 40) + "'" : '';
      return `#${el.element_index} ${el.role || 'Element'} '${String(el.label || '').slice(0, 60)}'${val} @ (${f.x ?? 0}, ${f.y ?? 0}, ${f.w ?? 0}, ${f.h ?? 0})`;
    }).join('\n'),
    note: 'element index ile hedefle: {op:"click", element:N}; element bayatlarsa yeniden capture',
  };
  if (mode !== 'ax' && r.image) out.__injectImage = r.image;
  return out;
}

/* snapshot element çözümü — bayat/bilinmeyen index açık hata verir */
function resolveEl(args) {
  const idx = Number(args && args.element);
  if (!idx) return {};
  const snap = S.snapshot;
  if (!snap || !snap.map.has(idx)) {
    return { error: `element #${idx} bulunamadı/bayatladı — önce capture`, stale: true };
  }
  return { el: snap.map.get(idx) };
}

/* aksiyon argümanlarını cua-driver hedef biçimine çevirir */
function address(args, t) {
  const r = resolveEl(args);
  if (r.error) return r;
  const out = {};
  if (r.el) {
    out.pid = t.pid;
    const tk = r.el.element_token || r.el.token;
    if (tk) out.element_token = tk;
    else {
      out.element_index = Number(r.el.element_index);
      out.snapshot_id = S.snapshot.id;
      out.window_id = S.snapshot.window_id;
    }
    return { out };
  }
  if (args.x != null || args.y != null) {
    out.pid = t.pid;
    out.x = Number(args.x) || 0;
    out.y = Number(args.y) || 0;
    return { out };
  }
  /* hedef yok: yalnız uygulama hedefli (focused element) */
  if (args.app) out.pid = t.pid;
  return { out };
}

function verdict(r) {
  if (r.isError) return { ok: false, error: (r.text || 'cua-driver hatası').slice(0, 300) };
  const s = r.structured || {};
  const out = { ok: true, effect: s.effect, verified: s.verified, path: s.path, code: s.code };
  if (s.escalation) out.escalation = s.escalation;
  if (r.text) out.note = r.text.slice(0, 300);
  return out;
}

/* ---------- güvenlik (Hermes SKILL.md sert kuralları) ---------- */

const BLOCKED_TYPE_PATTERNS = [
  /\b(?:curl|wget|irm|iwr|invoke-webrequest)\b[^|\n]*\|\s*(?:&\s*)?(?:bash|sh|zsh|powershell|pwsh|iex|invoke-expression)\b/i,
  /\bsudo\s+rm\s+-rf\b/i,
  /\brm\s+-rf\s+(?:\/|~)/,
  /:\(\)\s*\{[^}]*\}\s*;\s*:/,
];
const BLOCKED_KEYS = [/^win\+l$/, /^ctrl\+alt\+del(?:ete)?$/, /^alt\+ctrl\+del(?:ete)?$/];

const KEY_ALIASES = {
  enter: 'return', esc: 'escape', del: 'delete', pgup: 'pageup', pgdn: 'pagedown',
  win: 'cmd', option: 'alt', control: 'ctrl',
};
const KEY_MODS = new Set(['ctrl', 'alt', 'shift', 'cmd', 'fn']);

function guard(op, args) {
  if (op === 'type') {
    const text = String(args.text ?? '');
    if (!text.trim()) return { ok: false, error: 'boş metin' };
    for (const re of BLOCKED_TYPE_PATTERNS) {
      if (re.test(text)) return { ok: false, error: 'şüpheli shell pattern bloklu', blocked: true };
    }
  }
  if (op === 'key') {
    const combo = String(args.keys || args.combo || '').trim().toLowerCase();
    if (!combo) return { ok: false, error: 'tuş gerekli' };
    const norm = combo.replace(/\s+/g, '');
    for (const re of BLOCKED_KEYS) {
      if (re.test(norm)) return { ok: false, error: 'kilit/logout kombinasyonu bloklu: ' + combo, blocked: true };
    }
  }
  return null;
}

/* ---------- cua-driver aksiyonları ---------- */

async function targetFor(args) {
  if (!args || (!args.app && S.target)) return S.target || (await findTarget(null));
  return findTarget(args && args.app);
}

function keyParts(combo) {
  const parts = String(combo).toLowerCase().split('+').map((p) => p.trim()).filter(Boolean);
  const mods = [];
  let key = '';
  for (const p of parts) {
    const k = KEY_ALIASES[p] || p;
    if (KEY_MODS.has(k)) mods.push(k);
    else key = k;
  }
  return { mods, key };
}

async function driverAct(op, args) {
  const t = await targetFor(args);
  if (!t && op !== 'list_apps') {
    return { ok: false, error: 'hedef pencere bulunamadı' + (args.app ? ': ' + args.app : '') };
  }
  switch (op) {
    case 'click':
    case 'dblclick':
    case 'rightclick': {
      const a = address(args, t);
      if (a.error) return a;
      if (!a.out.element_token && a.out.element_index == null && a.out.x == null) {
        return { ok: false, error: 'element veya x/y gerekli' };
      }
      const p = a.out;
      if (op === 'click') {
        p.button = ['left', 'right', 'middle'].includes(args.button) ? args.button : 'left';
        return verdict(await call('click', p));
      }
      if (op === 'dblclick') return verdict(await call('double_click', p));
      return verdict(await call('right_click', p));
    }
    case 'type': {
      const text = String(args.text ?? '').slice(0, 2000);
      const a = address(args, t);
      if (a.error) return a;
      return verdict(await call('type_text', { text, ...a.out }));
    }
    case 'key': {
      const combo = String(args.keys || args.combo || '').trim().toLowerCase();
      const { mods, key } = keyParts(combo);
      if (!key && !mods.length) return { ok: false, error: 'tuş gerekli' };
      const a = address(args, t);
      if (a.error) return a;
      if (mods.length) {
        return verdict(await call('hotkey', { keys: [...mods, key || ''], ...a.out }));
      }
      return verdict(await call('press_key', { key: key || 'return', ...a.out }));
    }
    case 'scroll': {
      const direction = ['up', 'down', 'left', 'right'].includes(args.direction) ? args.direction : null;
      if (!direction) return { ok: false, error: 'direction gerekli (up/down/left/right)' };
      const amount = Math.max(1, Math.min(50, Math.round(Number(args.amount) || 3)));
      const a = address(args, t);
      if (a.error) return a;
      return verdict(await call('scroll', { direction, amount, ...a.out }));
    }
    case 'drag': {
      const pt = async (elIdx, ax, ay) => {
        const r = elIdx ? resolveEl({ element: elIdx }) : {};
        if (r.error) return r;
        if (r.el && r.el.frame) {
          return { x: r.el.frame.x + r.el.frame.w / 2, y: r.el.frame.y + r.el.frame.h / 2 };
        }
        if (ax != null && ay != null) return { x: Number(ax), y: Number(ay) };
        return { error: 'drag: from/to (element veya x/y) gerekli' };
      };
      const from = await pt(args.from_element, args.from_x, args.from_y);
      if (from.error) return from;
      const to = await pt(args.to_element, args.to_x, args.to_y);
      if (to.error) return to;
      const p = { from_x: from.x, from_y: from.y, to_x: to.x, to_y: to.y };
      if (args.duration_ms) p.duration_ms = Math.max(0, Math.min(10000, Math.round(Number(args.duration_ms))));
      if (args.steps) p.steps = Math.max(1, Math.min(200, Math.round(Number(args.steps))));
      return verdict(await call('drag', p));
    }
    case 'list_apps': {
      const r = await call('list_apps');
      if (r.isError) return { ok: false, error: (r.text || 'list_apps başarısız').slice(0, 300) };
      const rows = rowsOf(r).slice(0, 40).map((a) => ({
        name: a.name || a.app_name || a.bundle_id || String(a).slice(0, 40),
        pid: a.pid || null,
        running: a.running !== false,
      }));
      return { ok: true, op: 'list_apps', apps: rows, note: 'hedeflemek için op argümanlarında app=<ad> kullan' };
    }
    case 'focus_app': {
      S.target = t;
      if (args.raise_window) {
        const r = await call('bring_to_front', { pid: t.pid });
        if (r.isError) return { ok: false, error: (r.text || 'focus başarısız').slice(0, 300) };
      }
      return {
        ok: true,
        op: 'focus_app',
        app: t.app_name,
        window: { pid: t.pid, window_id: t.window_id, title: t.title },
        note: 'hedef seçildi — girdiler artık bu uygulamaya yönelir (raise_window olmadan odak çalınmaz)',
      };
    }
    default:
      return null; /* move vb. → legacy */
  }
}

/* capture_after: aksiyon sonrası aynı hedefte doğrulama görüntüsü */
async function attachCapture(out) {
  try {
    const c = await doCapture({});
    if (c && c.__injectImage) {
      out.__injectImage = c.__injectImage;
      delete c.__injectImage;
    }
    out.capture = { ok: !!c.ok, elements: c.elements, index: c.index || undefined, error: c.error };
  } catch (e) {
    out.capture = { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- legacy PowerShell backend (fallback) ---------- */

let lastActionAt = 0;
function pace() {
  const wait = 120 - (Date.now() - lastActionAt);
  lastActionAt = Date.now();
  if (wait > 0) return new Promise((r) => setTimeout(r, wait));
  return Promise.resolve();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ps(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || '').trim()))
    );
  });
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

async function legacyScreenSize() {
  const out = await ps(
    'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width.ToString() + "x" + [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height'
  );
  const m = out.match(/(\d+)x(\d+)/);
  if (!m) throw new Error('çözünürlük alınamadı');
  return { w: Number(m[1]), h: Number(m[2]) };
}

const MOUSE_MOVE_TPL = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BM {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
}
"@
[BM]::SetCursorPos(%%X%%, %%Y%%) | Out-Null
`;

const WHEEL_TPL = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BW {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
[BW]::mouse_event(0x0800, 0, 0, %%DELTA%%, [UIntPtr]::Zero)
`;

/* Unicode güvenli yazım: pano + Ctrl+V en sağlamı (tek seferlik, panoyu geri yüklemez) */
function buildTyperScript(text) {
  const b64 = Buffer.from(text, 'utf16le').toString('base64');
  return `
$t = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("${b64}"))
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText($t)
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait("^v")
`;
}

/* Tuş kombosu: enter/tab/esc/f1-12, ctrl/alt/shift+x, win vb. */
function buildKeyScript(combo) {
  const map = {
    enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
    backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}',
    home: '{HOME}', end: '{END}', pgup: '{PGUP}', pgdn: '{PGDN}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    space: ' ', win: '^({ESC})',
  };
  let out = '';
  const parts = String(combo).toLowerCase().split('+').map((p) => p.trim());
  let mods = '';
  for (const p of parts) {
    if (p === 'ctrl') mods += '^';
    else if (p === 'alt') mods += '%';
    else if (p === 'shift') mods += '+';
    else if (p === 'win') out += '';
    else if (/^f\d{1,2}$/.test(p)) out += '{' + p.toUpperCase() + '}';
    else if (map[p]) out += map[p];
    else out += p.slice(0, 1).toUpperCase();
  }
  const seq = mods && out ? mods + '(' + out + ')' : mods + out;
  const b64 = Buffer.from(seq, 'utf16le').toString('base64');
  return `
$s = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("${b64}"))
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait($s)
`;
}

async function mouseMove(x, y) {
  await ps(MOUSE_MOVE_TPL.replace(/%%X%%/g, String(x)).replace(/%%Y%%/g, String(y)));
}

async function clickSimple(button) {
  const down = button === 'right' ? 0x0008 : 0x0002;
  const up = button === 'right' ? 0x0010 : 0x0004;
  await ps(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BC2 {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
[BC2]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 45
[BC2]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)
`);
}

async function wheel(dir) {
  const delta = dir < 0 ? -240 : 240;
  await ps(WHEEL_TPL.replace(/%%DELTA%%/g, String(delta)));
}

/* legacy op yüzeyi: koordinat tabanlı eski aksiyonlar (cua-driver'sız mod) */
async function legacyAct(op, args) {
  op = String(op || '').trim().toLowerCase();
  const noDriver = (what) => ({
    ok: false,
    error: `${what} için cua-driver gerekli — kurulum: irm ${CUA_INSTALL_PS1} | iex` +
      (INST.running ? ' (kurulum arka planda sürüyor — birkaç dakika sonra tekrar dene)' : '') +
      (INST.failed ? ' (önceki otomatik kurulum başarısız oldu)' : ''),
  });
  switch (op) {
    case 'capture':
    case 'list_apps':
    case 'focus_app':
      return noDriver('capture/list_apps/focus_app');
    case 'drag':
      return noDriver('drag');
    case 'click':
    case 'dblclick':
    case 'rightclick':
    case 'type': {
      if (args.element != null) return noDriver('element tıklama');
      break;
    }
    default:
      break;
  }
  if (op === 'screen_size') {
    const s = await legacyScreenSize();
    return { ok: true, ...s };
  }
  await pace();
  const x = Math.max(0, Math.round(Number(args.x) || 0));
  const y = Math.max(0, Math.round(Number(args.y) || 0));
  switch (op) {
    case 'move':
      await mouseMove(x, y);
      return { ok: true };
    case 'click':
      if (args.x == null && args.y == null) return { ok: false, error: 'x/y gerekli' };
      await mouseMove(x, y);
      await clickSimple('left');
      return { ok: true, at: { x, y } };
    case 'dblclick':
      if (args.x == null && args.y == null) return { ok: false, error: 'x/y gerekli' };
      await mouseMove(x, y);
      await clickSimple('left');
      await sleep(70);
      await clickSimple('left');
      return { ok: true, at: { x, y } };
    case 'rightclick':
      if (args.x == null && args.y == null) return { ok: false, error: 'x/y gerekli' };
      await mouseMove(x, y);
      await clickSimple('right');
      return { ok: true, at: { x, y } };
    case 'type': {
      const text = String(args.text ?? '').slice(0, 2000);
      if (!text) return { ok: false, error: 'boş metin' };
      await ps(buildTyperScript(text));
      return { ok: true, chars: text.length };
    }
    case 'key': {
      const combo = String(args.keys || args.combo || '').trim().slice(0, 40);
      if (!combo) return { ok: false, error: 'tuş gerekli' };
      await ps(buildKeyScript(combo));
      return { ok: true, key: combo };
    }
    case 'scroll': {
      if (args.direction) {
        const dy = args.direction === 'down' ? Number(args.amount) || 3 : args.direction === 'up' ? -(Number(args.amount) || 3) : 0;
        if (!dy) return { ok: false, error: 'dikey scroll için up/down gerekli' };
        await mouseMove(x || 640, y || 360);
        const clicks = Math.abs(dy) * 3;
        for (let i = 0; i < clicks; i++) await wheel(dy > 0 ? 1 : -1);
        return { ok: true, direction: args.direction, amount: Math.abs(dy) };
      }
      const dy = clamp(Math.round(Number(args.dy) || 0), -10, 10);
      if (!dy) return { ok: false, error: 'direction veya dy gerekli (-10..10)' };
      await mouseMove(x || 640, y || 360);
      const clicks = Math.abs(dy) * 3;
      for (let i = 0; i < clicks; i++) {
        await wheel(dy > 0 ? 1 : -1);
      }
      return { ok: true, dy };
    }
    default:
      return { ok: false, error: `bilinmeyen op: ${op}` };
  }
}

/* ---------- genel giriş ---------- */

/**
 * Hermes-SKILL.md aksiyon kümesi:
 *  capture     mode=som|vision|ax  app=…   → numaralı element index'i (+görsel)
 *  click       element=N | x,y     button=left|right|middle
 *  dblclick / rightclick  element=N | x,y
 *  type        text="…"            element=N | x,y
 *  key         keys="ctrl+s" | "enter"
 *  scroll      direction=up|down|left|right  amount=1..50  element=N | x,y
 *  drag        from_element/to_element | from_x/y → to_x/y
 *  wait        seconds=0.5
 *  list_apps   (argüman yok)
 *  focus_app   app=…  [raise_window=true]
 *  move        x,y  (yalnız legacy — gerçek cursor'u oynatır)
 * State-changing aksiyonlarda capture_after=true → aynı hedefte doğrulama
 * capture'ı tek çağrıda döndürür.
 */
async function act(op, args = {}) {
  op = String(op || '').trim().toLowerCase();
  args = args || {};
  if (op === 'wait') {
    const ms = clamp(
      args.seconds != null ? Number(args.seconds) * 1000 : args.ms != null ? Number(args.ms) : 500,
      0, 30000
    );
    await sleep(ms);
    return { ok: true, op: 'wait', waited: Math.round(ms) };
  }
  const g = guard(op, args);
  if (g) return g;
  const stateChanging = ['click', 'dblclick', 'rightclick', 'type', 'key', 'scroll', 'drag'];
  try {
    if (await ensure()) {
      const r = await driverAct(op, args);
      if (r !== null) {
        if (stateChanging.includes(op) && args.capture_after) await attachCapture(r);
        return r;
      }
    }
  } catch (e) {
    teardown(String((e && e.message) || e));
    S.downUntil = Date.now() + RETRY_COOLDOWN;
    /* sürücü koptu → legacy devam */
  }
  return legacyAct(op, args);
}

/* Çözünürlük: sürücü varsa driver (logical points), yoksa PowerShell (piksel) */
async function screenSize() {
  try {
    if (await ensure()) {
      const r = await call('get_screen_size', {}, 10000);
      const s = r.structured || {};
      const w = Number(s.width || s.w || 0);
      const h = Number(s.height || s.h || 0);
      if (w && h) return { w, h };
    }
  } catch {}
  return legacyScreenSize();
}

module.exports = { act, screenSize, clickSimple, mouseMove, probe, autoInstall };
