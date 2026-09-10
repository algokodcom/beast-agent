'use strict';

/* Beast MCP (Model Context Protocol) istemcisi — el yazımı minimal, sıfır bağımlılık.
   stdio transport: JSON-RPC 2.0, satır-bazlı (newline-delimited).

   %APPDATA%\beast\mcp.json:
   {
     "servers": {
       "fetch": { "command": "uvx", "args": ["mcp-server-fetch"], "enabled": true },
       "git":   { "command": "uvx", "args": ["mcp-server-git", "--repository", "C:/repo"],
                  "enabled": true, "tools": ["git_status", "git_log"], "timeoutMs": 60000 }
     }
   }

   Tool'lar modele `mcp__<server>__<tool>` adıyla açılır; çağrı tools/call'a gider.
   Server çökerse 3 dk cooldown'a girer, sonra otomatik yeniden denenir. */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { beastRoot } = require('./memory');
const log = require('./logger');

const INIT_TIMEOUT_MS = 15000;
const LIST_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 120000;
const COOLDOWN_MS = 3 * 60 * 1000;
const MAX_TOOLS_PER_SERVER = 40;
const MAX_TOOLS_TOTAL = 80;
const MAX_DESC_LEN = 220;

/* server adı → { cfg, proc, nextId, pending:Map, tools:[], status, lastError } */
const conns = new Map();
/* başarısız server adı → yeniden deneme zamanı */
const downUntil = new Map();

/* ---------- config ---------- */

function configPath() {
  return path.join(beastRoot(), 'mcp.json');
}

let cfgCache = { mtime: -1, cfg: { servers: {} } };

/* Sunucu kaydını normalize eder + token güvenliğini doğrular.
   Komut yoksa null döner; satır sonu/NUL varsa fırlatır (kayıt atlanır/reddedilir). */
function normalizeServer(s) {
  if (!s || typeof s !== 'object' || !s.command) return null;
  const command = String(s.command);
  assertSafeToken(command, 'MCP komutu');
  const args = (Array.isArray(s.args) ? s.args : []).map((a) => assertSafeToken(a, 'MCP argümanı'));
  return {
    command,
    args,
    env: s.env && typeof s.env === 'object' ? Object.fromEntries(Object.entries(s.env).map(([k, v]) => [String(k), String(v)])) : {},
    enabled: s.enabled !== false,
    tools: Array.isArray(s.tools) ? s.tools.map(String) : null,
    timeoutMs: Number(s.timeoutMs) > 1000 ? Math.min(Number(s.timeoutMs), 600000) : CALL_TIMEOUT_MS,
  };
}

function readConfig(force) {
  try {
    const p = configPath();
    const st = fs.statSync(p);
    if (!force && st.mtimeMs === cfgCache.mtime) return cfgCache.cfg;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const cfg = { servers: {} };
    if (parsed && typeof parsed.servers === 'object') {
      for (const [name, s] of Object.entries(parsed.servers)) {
        try {
          const srv = normalizeServer(s);
          if (srv) cfg.servers[sanitizeName(name)] = srv;
        } catch (e) {
          log.warn(`[mcp] '${name}' geçersiz, atlandı: ${String((e && e.message) || e)}`);
        }
      }
    }
    cfgCache = { mtime: st.mtimeMs, cfg };
    return cfg;
  } catch {
    /* dosya yok/bozuk → boş yapı (mtime -1 kalır; dosya oluşturulunca yeniden okunur) */
    try {
      const st = fs.statSync(configPath());
      cfgCache = { mtime: st.mtimeMs, cfg: { servers: {} } };
    } catch {}
    return { servers: {} };
  }
}

function saveConfig(cfg) {
  const p = configPath();
  /* DİSKE YAZMADAN doğrula: güvensiz/yapıbozuk kayıt asla mcp.json'a düşmez */
  const clean = { servers: {} };
  for (const [name, s] of Object.entries((cfg && cfg.servers) || {})) {
    const srv = normalizeServer(s);
    if (srv) clean.servers[sanitizeName(name)] = srv;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(clean, null, 2) + '\n');
  cfgCache = { mtime: -1, cfg: clean }; /* sonraki okuma diskten gelsin */
}

function sanitizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'server';
}

/* UI'a maskeli ('***') giden env sırlarını diskteki mevcut değerlerle geri koyar.
   Böylece kullanıcı formu kaydedince sırlar '***' ile ezilmez. */
function restoreMaskedSecrets(cfg) {
  let cur;
  try { cur = readConfig(true); } catch { return cfg; }
  for (const [name, s] of Object.entries((cfg && cfg.servers) || {})) {
    if (!s || typeof s !== 'object' || !s.env || typeof s.env !== 'object') continue;
    const old = cur.servers[sanitizeName(name)];
    if (!old || !old.env) continue;
    for (const [k, v] of Object.entries(s.env)) {
      if (String(v) === '***' && old.env[k] !== undefined) s.env[k] = old.env[k];
    }
  }
  return cfg;
}

/* ---------- süreç yaşam döngüsü ---------- */

/* Token doğrulama: satır sonu/NUL her platformda enjeksiyon vektörüdür */
function assertSafeToken(t, what) {
  const s = String(t == null ? '' : t);
  if (/[\0\r\n]/.test(s)) throw new Error(what + ' içinde satır sonu/NUL karakteri olamaz');
  return s;
}

const CMD_META_RE = /[\s"&|<>^()]/;

/* KOMUT token'ı: yalnız gerekiyorsa tırnaklanır — aksi halde npm/npx gibi
   .cmd sarmalayıcılarının %~dp0 çözümü bozulur. %/! reddedilir. */
function quoteCmdCommand(t) {
  const s = assertSafeToken(t, 'MCP komutu');
  if (/[%!]/.test(s)) throw new Error('MCP komutunda % veya ! kullanılamaz (güvenlik)');
  if (!CMD_META_RE.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/* ARGÜMAN token'ı: HER ZAMAN tırnak içinde → & | < > gibi metakarakterler
   komut ayıramaz. %/! genişletilebildiği için reddedilir; kapanış tırnağı
   öncesi ters bölü CRT kuralı gereği çiftlenir. */
function quoteCmdArg(t) {
  const s = assertSafeToken(t, 'MCP argümanı');
  if (/[%!]/.test(s)) throw new Error('MCP argümanında % veya ! kullanılamaz (güvenlik)');
  const out = s.replace(/"/g, '""').replace(/(\\+)$/, '$1$1');
  return '"' + out + '"';
}

function spawnServer(cfg) {
  const cmd = assertSafeToken(cfg.command, 'MCP komutu');
  if (!cmd.trim()) throw new Error('MCP komutu boş');
  const args = (Array.isArray(cfg.args) ? cfg.args : []).map((a) => assertSafeToken(a, 'MCP argümanı'));
  const opts = {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(cfg.env || {}) },
  };
  if (process.platform !== 'win32') {
    /* POSIX: shell YOK — & | ; $() gibi metakarakterler enjekte edilemez */
    return spawn(cmd, args, { ...opts, shell: false });
  }
  /* Windows: npx/uvx .cmd sarmalayıcıları düz spawn edilemez — cmd.exe'ye
     tırnaklı/tırnaksız DOĞRU komut satırı elle kurulur; shell KAPALI,
     windowsVerbatimArguments ile libuv müdahalesi kapatılır. */
  const first = quoteCmdCommand(cmd);
  const line = [first, ...args.map(quoteCmdArg)].join(' ');
  /* İlk token tırnaklıysa cmd /s ilk ve son tırnağı KIRPAR — dış sarmal şart */
  const full = first.startsWith('"') ? '"' + line + '"' : line;
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', full], {
    ...opts,
    shell: false,
    windowsVerbatimArguments: true,
  });
}

function connFor(name) {
  return conns.get(name);
}

function killConn(name) {
  const c = conns.get(name);
  if (!c) return;
  conns.delete(name);
  try {
    if (c.timer) clearTimeout(c.timer);
    for (const [, p] of c.pending) {
      try { p.reject(new Error('MCP server kapatıldı')); } catch {}
    }
    c.pending.clear();
    try { c.proc.stdin.end(); } catch {}
    try { c.proc.kill(); } catch {}
  } catch {}
}

function request(conn, method, params, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const id = conn.nextId++;
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`MCP ${method} zaman aşımı (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      conn.pending.delete(id);
      reject(new Error('iptal edildi'));
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    conn.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); resolve(v); },
      reject: (e) => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); reject(e); },
    });
    try {
      conn.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      conn.pending.delete(id);
      reject(e);
    }
  });
}

function handleLine(conn, line) {
  if (!line || !line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && msg.id !== null && conn.pending.has(msg.id)) {
    const p = conn.pending.get(msg.id);
    conn.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(String(msg.error.message || JSON.stringify(msg.error)).slice(0, 300)));
    else p.resolve(msg.result);
    return;
  }
  /* bildirimler (id'siz) — şimdilik yok sayılır */
}

function startServer(name, cfg) {
  killConn(name);
  const conn = {
    cfg,
    proc: null,
    nextId: 1,
    pending: new Map(),
    tools: [],
    status: 'starting',
    lastError: '',
    stdout: '',
  };
  conns.set(name, conn);
  try {
    conn.proc = spawnServer(cfg);
  } catch (e) {
    conn.status = 'down';
    conn.lastError = String((e && e.message) || e).slice(0, 200);
    downUntil.set(name, Date.now() + COOLDOWN_MS);
    return Promise.resolve(false);
  }
  conn.proc.stdout.setEncoding('utf8');
  conn.proc.stdout.on('data', (chunk) => {
    conn.stdout += chunk;
    let idx;
    while ((idx = conn.stdout.indexOf('\n')) >= 0) {
      const line = conn.stdout.slice(0, idx);
      conn.stdout = conn.stdout.slice(idx + 1);
      try { handleLine(conn, line); } catch {}
    }
  });
  conn.proc.stderr.setEncoding('utf8');
  conn.proc.stderr.on('data', () => {}); /* server logları — yok sayılır */
  const fail = (err) => {
    conn.status = 'down';
    conn.lastError = String((err && err.message) || err).slice(0, 200);
    conn.tools = [];
    downUntil.set(name, Date.now() + COOLDOWN_MS);
    for (const [, p] of conn.pending) { try { p.reject(new Error(conn.lastError)); } catch {} }
    conn.pending.clear();
    try { conn.proc.kill(); } catch {}
  };
  conn.proc.on('error', fail);
  conn.proc.on('exit', (code) => {
    if (conn.status === 'up') {
      fail(new Error(`MCP server '${name}' beklenmedik çıkış yaptı (kod ${code})`));
    } else if (conn.status === 'starting') {
      fail(new Error(`MCP server '${name}' başlamadan kapandı (kod ${code})`));
    }
  });
  return (async () => {
    try {
      await request(conn, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'beast-agent', version: '1.9.0' },
      }, INIT_TIMEOUT_MS);
      try {
        conn.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      } catch {}
      const listed = await request(conn, 'tools/list', {}, LIST_TIMEOUT_MS);
      const tools = Array.isArray(listed && listed.tools) ? listed.tools : [];
      conn.tools = tools.slice(0, MAX_TOOLS_PER_SERVER).map((t) => ({
        name: String(t.name || ''),
        description: String(t.description || '').slice(0, MAX_DESC_LEN),
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
      }));
      conn.status = 'up';
      downUntil.delete(name);
      log.info(`[mcp] '${name}' bağlı — ${conn.tools.length} araç`);
      return true;
    } catch (e) {
      fail(e);
      log.warn(`[mcp] '${name}' bağlanamadı: ${conn.lastError}`);
      return false;
    }
  })();
}

/* Tüm etkin serverlara bağlan (zaten bağlılar hariç; cooldown'dakiler atlanır).
   Toplam `waitMs`'ten uzun beklemez — hangisi hazır değilse bu turda öyle kalır. */
async function ensureAll(waitMs = 8000) {
  const cfg = readConfig();
  const kicks = [];
  for (const [name, s] of Object.entries(cfg.servers)) {
    if (!s.enabled) continue;
    if (conns.has(name) || (downUntil.get(name) || 0) > Date.now()) continue;
    kicks.push(startServer(name, s));
  }
  if (!kicks.length) return;
  await Promise.race([
    Promise.allSettled(kicks),
    new Promise((r) => setTimeout(r, waitMs)),
  ]);
}

/* ---------- şemalar ---------- */

function toolFullNames(cfg, serverName, tools) {
  let list = tools;
  if (cfg.tools && cfg.tools.length) {
    const allow = new Set(cfg.tools);
    list = tools.filter((t) => allow.has(t.name));
  }
  return list;
}

function toolSchemas() {
  const cfg = readConfig();
  const out = [];
  for (const [name, conn] of conns) {
    if (conn.status !== 'up' || !conn.tools.length) continue;
    const s = cfg.servers[name] || {};
    const list = toolFullNames(s, name, conn.tools);
    for (const t of list) {
      out.push({
        type: 'function',
        function: {
          name: `mcp__${name}__${t.name}`,
          description: `[mcp:${name}] ${t.description}`.trim(),
          parameters: t.inputSchema,
        },
      });
    }
  }
  return out.slice(0, MAX_TOOLS_TOTAL);
}

/* engine._chatTurn başında çağrılır: MCP araç şemalarını listeye ekler */
async function mergeTools(toolsList) {
  try {
    if (!readConfig().servers || !Object.keys(readConfig().servers).length) return toolsList;
    if (toolsList.some((t) => t && t.function && String(t.function.name).startsWith('mcp__'))) return toolsList;
    await ensureAll();
    const extra = toolSchemas();
    return extra.length ? toolsList.concat(extra) : toolsList;
  } catch {
    return toolsList;
  }
}

/* ---------- çağrı ---------- */

function parseFullName(fullName) {
  const m = String(fullName || '').match(/^mcp__([a-z0-9_-]{1,32})__([A-Za-z0-9_.-]{1,64})$/);
  return m ? { server: m[1], tool: m[2] } : null;
}

function extractText(result) {
  if (!result) return '';
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'resource') parts.push(JSON.stringify(c.resource || {}).slice(0, 4000));
    else parts.push(JSON.stringify(c).slice(0, 2000));
  }
  return parts.join('\n').slice(0, 60000);
}

async function call(fullName, args, signal) {
  const parsed = parseFullName(fullName);
  if (!parsed) return { ok: false, error: `geçersiz MCP araç adı: ${fullName}` };
  const { server, tool } = parsed;
  const cfg = readConfig();
  const scfg = cfg.servers[server];
  if (!scfg || !scfg.enabled) return { ok: false, error: `MCP server '${server}' kapalı` };
  let conn = conns.get(server);
  if (!conn || conn.status !== 'up') {
    if ((downUntil.get(server) || 0) > Date.now()) {
      return { ok: false, error: `MCP server '${server}' şu an erişilemiyor (${conn ? conn.lastError : 'cooldown'}) — az sonra yeniden dene` };
    }
    await ensureAll(15000);
    conn = conns.get(server);
  }
  if (!conn || conn.status !== 'up') {
    return { ok: false, error: `MCP server '${server}' bağlı değil` };
  }
  if (scfg.tools && scfg.tools.length && !scfg.tools.includes(tool)) {
    return { ok: false, error: `araç '${tool}' server '${server}' için yetkili listede değil` };
  }
  try {
    const result = await request(conn, 'tools/call', { name: tool, arguments: args || {} }, scfg.timeoutMs || CALL_TIMEOUT_MS, signal);
    const text = extractText(result);
    if (result && result.isError) return { ok: false, error: text.slice(0, 4000) || 'MCP araç hatası' };
    return { ok: true, result: text };
  } catch (e) {
    const msg = String((e && e.message) || e);
    /* ölü süreç → sonraki turda yeniden doğsun */
    if (conn.status !== 'up') killConn(server);
    return { ok: false, error: `MCP çağrısı başarısız: ${msg.slice(0, 300)}` };
  }
}

/* ---------- yönetim (settings UI) ---------- */

function status() {
  const cfg = readConfig(true);
  const now = Date.now();
  const servers = [];
  for (const [name, s] of Object.entries(cfg.servers)) {
    const conn = conns.get(name);
    const down = (downUntil.get(name) || 0) > now;
    servers.push({
      name,
      command: s.command,
      args: s.args,
      enabled: !!s.enabled,
      tools: s.tools || null,
      timeoutMs: s.timeoutMs,
      state: !s.enabled ? 'disabled' : conn ? conn.status : down ? 'down' : 'idle',
      toolCount: conn ? conn.tools.length : 0,
      toolNames: conn ? conn.tools.map((t) => t.name) : [],
      lastError: conn ? conn.lastError : '',
    });
  }
  return { path: configPath(), servers };
}

/* Tek serverı yeniden başlat (settings "yenile" düğmesi) */
async function refresh(name) {
  const cfg = readConfig(true);
  const s = cfg.servers[sanitizeName(name)];
  if (!s || !s.enabled) return false;
  downUntil.delete(name);
  await startServer(sanitizeName(name), s);
  return true;
}

function stopAll() {
  for (const name of Array.from(conns.keys())) killConn(name);
}

/* test/ayalar: tüm bağlantı ve cooldown durumunu sıfırla */
function _reset() {
  stopAll();
  downUntil.clear();
}

process.on('exit', stopAll);

module.exports = {
  configPath,
  readConfig,
  saveConfig,
  restoreMaskedSecrets,
  normalizeServer,
  _spawnServer: spawnServer,
  mergeTools,
  toolSchemas,
  call,
  status,
  refresh,
  stopAll,
  _reset,
  parseFullName,
  extractText,
  sanitizeName,
};
