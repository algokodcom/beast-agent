'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { spawn } = require('child_process');
const research = require('./research');

const MAX_CMD_OUTPUT = 16000;
const MAX_FILE_CHARS = 200000;

function truncateMiddle(s, cap) {
  if (s.length <= cap) return s;
  const half = Math.floor((cap - 32) / 2);
  return (
    s.slice(0, half) +
    `\n... [${s.length - cap} chars truncated] ...\n` +
    s.slice(s.length - half)
  );
}

function runCommand(command, cwd, timeoutMs = 90000, signal) {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let err = '';
    const finish = (code, killed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text =
        (out ? out.trim() : '') +
        (err ? (out ? '\n[stderr] ' : '') + err.trim() : '');
      resolve({
        ok: !killed && code === 0,
        output: truncateMiddle(text || '(no output)', MAX_CMD_OUTPUT),
        code,
      });
    };

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { cwd: cwd || process.cwd(), windowsHide: true, env: envWithPathPrefix() }
    );

    const timer = setTimeout(() => {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {}
      finish(null, true);
      // append notice
      err += '\n[beast] command timed out';
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) return finish(null, true);
      signal.addEventListener('abort', () => {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch {}
        finish(null, true);
      }, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > MAX_CMD_OUTPUT * 4) out = out.slice(-MAX_CMD_OUTPUT * 2);
    });
    child.stderr.on('data', (d) => {
      err += d;
      if (err.length > MAX_CMD_OUTPUT * 4) err = err.slice(-MAX_CMD_OUTPUT * 2);
    });
    child.on('error', (e) => finish(1, false) || void (err += String(e.message)));
    child.on('close', (code) => finish(code, false));
  });
}

function safeResolve(p, cwd) {
  const abs = path.isAbsolute(p) ? p : path.join(cwd || process.cwd(), p);
  return path.normalize(abs);
}

/* ---------- Python altyapısı (#18) ----------
   Sıra: BEAST_PYTHON env → sistem python/python3/py -3 → gömülü runtime
   (%APPDATA%\beast\py — yoksa TEK SEFERLİK kendisi indirip açar).
   Böylece ajanlar makinede Python kurulmasa bile python_run kullanabilir. */

const PYTHON_EMBED_URL = 'https://www.python.org/ftp/python/3.12.8/python-3.12.8-embed-amd64.zip';
const PY_PROBE_TIMEOUT = 6000;

function beastAppDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'beast');
}

function pythonScriptsDir() {
  const d = path.join(beastAppDir(), 'scripts');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function embeddedPythonExe() {
  return path.join(beastAppDir(), 'py', 'python.exe');
}

/* Gömülü runtime kuruluysa klasörünü PATH önüne koy: ajanın run_command'ında
   `python` / `python.exe` da çalışsın (makinede Python kurulmuş olmasa bile). */
function pythonPathPrefix() {
  try {
    const d = path.dirname(embeddedPythonExe());
    if (fs.existsSync(path.join(d, 'python.exe'))) return d + path.delimiter;
  } catch {}
  return '';
}

function envWithPathPrefix() {
  const base = { ...process.env };
  base.PATH = pythonPathPrefix() + (process.env.PATH || process.env.Path || '');
  return base;
}

/* paketlenmiş python scriptleri (src/agent/scripts) → kullanıcı scripts klasörüne tohumla */
function bundledScriptPath(name) {
  return path.join(__dirname, 'scripts', name);
}

function seedScript(name, force = false) {
  const src = bundledScriptPath(name);
  try {
    const dest = path.join(pythonScriptsDir(), name);
    /* force: paket içindeki güncel sürüm her zaman kazanır (sistem scripti) */
    if (fs.existsSync(src) && (force || !fs.existsSync(dest))) {
      fs.copyFileSync(src, dest);
    }
    return dest;
  } catch {
    return path.join(pythonScriptsDir(), name);
  }
}

/* #20 hızlı web arama: ddgs kütüphanesi varsa onu kullan; yoksa python çoklu-motor
   paralel; o da olmazsa JS fallback. Sonuç boş gelirse (CAPTCHA/engel) ddgs'yi
   TEK SEFERLİK arka planda kurup tekrar dener. */
function pyExec(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(exe, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) =>
        resolve({ err, out: String(stdout || '') + String(stderr || '') })
      );
    } catch (e) {
      resolve({ err: e, out: '' });
    }
  });
}

let _ddgsTried = null; // Promise<boolean> — oturum başına tek kurulum denemesi

function ddgsImportOk(probe) {
  /* hızlı yerel kontrol: kütüphane import edilebiliyor mu (ağ gerektirmez) */
  return pyExec(probe.exe, ['-c', 'import ddgs'], 15000).then((r) => !r.err);
}

/* pip ile TEK SEFERLİK kurulum dener; uzun sürebilir — await ETME, arka planda bırak */
function ensureDdgs(probe) {
  if (_ddgsTried) return _ddgsTried;
  _ddgsTried = (async () => {
    try {
      if (await ddgsImportOk(probe)) return true;
      const pip = await pyExec(probe.exe, ['-m', 'pip', '--version'], 15000);
      if (pip.err) return false; // gömülü python'da pip yok — sessizce vazgeç
      const inst = await pyExec(
        probe.exe,
        ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', 'ddgs'],
        120000
      );
      if (inst.err) return false;
      return await ddgsImportOk(probe);
    } catch {
      return false;
    }
  })();
  return _ddgsTried;
}

function parseWsOutput(output) {
  return String(output || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean)
    .map((x) => ({ title: String(x.title || ''), url: String(x.url || ''), snippet: String(x.snippet || ''), engine: String(x.engine || '') }));
}

async function webSearchFast(query, { maxResults = 8, signal } = {}) {
  try {
    const probe = await ensurePython({ allowDownload: true, signal });
    const script = seedScript('websearch.py', true);
    let r = await runPy(probe.exe, script, ['--json', '--limit', String(maxResults), query], process.cwd(), 20000, signal);
    let results = parseWsOutput(r.output);
    if (!results.length) {
      /* muhtemel CAPTCHA/engel — ddgs kuruluysa hemen onunla tekrar dene;
         kurulu değilse kurulumu arka plana bırak (bu çağrıyı bekletmez) */
      if (await ddgsImportOk(probe)) {
        r = await runPy(probe.exe, script, ['--json', '--limit', String(maxResults), query], process.cwd(), 20000, signal);
        results = parseWsOutput(r.output);
      } else {
        ensureDdgs(probe).catch(() => {});
      }
    } else if (!results.some((x) => x.engine === 'ddgs')) {
      /* arama çalışıyor ama ddgs henüz yok — arka planda sessiz kur, sonraki aramalar hızlanır */
      ensureDdgs(probe).catch(() => {});
    }
    if (results.length) {
      return { ok: true, engine: results.some((x) => x.engine === 'ddgs') ? 'ddgs' : 'python-multi', query, results };
    }
  } catch {}
  /* JS fallback (tek motor DDG) */
  return webSearch(query, { maxResults, signal });
}

let _pyProbe = null;

function probeInterpreter(exe, prefix) {
  return new Promise((resolve) => {
    try {
      execFile(exe, [...(prefix || []), '--version'], { timeout: PY_PROBE_TIMEOUT, windowsHide: true }, (err, stdout, stderr) => {
        if (err) return resolve(null);
        const v = String(stdout || stderr || '').trim();
        resolve(/Python\s*3/i.test(v) ? { exe, prefix: prefix || [], source: 'system', version: v } : null);
      });
    } catch {
      resolve(null);
    }
  });
}

async function findSystemPython() {
  if (process.env.BEAST_PYTHON && fs.existsSync(process.env.BEAST_PYTHON)) {
    return { exe: process.env.BEAST_PYTHON, prefix: [], source: 'env' };
  }
  for (const cand of [
    ['python.exe', []],
    ['python3.exe', []],
    ['py.exe', ['-3']],
  ]) {
    const r = await probeInterpreter(cand[0], cand[1]);
    if (r) return r;
  }
  return null;
}

function httpsGetBuffer(url, redirectsLeft = 4, signal) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'BeastAgent/1.0 (+python bootstrap)' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(httpsGetBuffer(new URL(res.headers.location, url).toString(), redirectsLeft - 1, signal));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`indirme başarısız: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 80 * 1024 * 1024) {
          req.destroy(new Error('dosya çok büyük'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) return reject(new Error('iptal'));
      signal.addEventListener('abort', () => req.destroy(new Error('iptal')), { once: true });
    }
  });
}

async function installEmbeddedPython(signal) {
  const dest = path.join(beastAppDir(), 'py');
  fs.mkdirSync(dest, { recursive: true });
  const zipPath = path.join(os.tmpdir(), 'beast-py-embed.zip');
  const buf = await httpsGetBuffer(PYTHON_EMBED_URL, 4, signal);
  fs.writeFileSync(zipPath, buf);
  const r = await runCommand(
    `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${dest}" -Force`,
    null,
    180000
  );
  try { fs.unlinkSync(zipPath); } catch {}
  if (!r.ok || !fs.existsSync(embeddedPythonExe())) {
    throw new Error('gömülü python kurulamadı: ' + String(r.output || '').slice(0, 200));
  }
  /* site-packages yolunu aç — pip ile kurulabilen paketler için ön hazırlık */
  try {
    const pth = path.join(dest, 'python312._pth');
    if (fs.existsSync(pth)) {
      const cur = fs.readFileSync(pth, 'utf8');
      if (!/import site/.test(cur)) fs.writeFileSync(pth, cur.replace(/\n*$/, '\nimport site\n'), 'utf8');
    }
  } catch {}
  return { exe: embeddedPythonExe(), prefix: [], source: 'embedded', version: '3.12.8 (gömülü)' };
}

async function ensurePython({ allowDownload = true, signal } = {}) {
  if (_pyProbe) {
    try { fs.accessSync(_pyProbe.exe); return _pyProbe; } catch { _pyProbe = null; }
  }
  const emb = embeddedPythonExe();
  if (fs.existsSync(emb)) {
    _pyProbe = { exe: emb, prefix: [], source: 'embedded' };
    return _pyProbe;
  }
  const sys = await findSystemPython();
  if (sys) {
    _pyProbe = sys;
    return sys;
  }
  if (!allowDownload) throw new Error('python bulunamadı ve otomatik kurulum kapalı');
  _pyProbe = await installEmbeddedPython(signal);
  return _pyProbe;
}

function runPy(exe, scriptPath, cliArgs, cwd, timeoutMs = 120000, signal) {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let err = '';
    const startedAt = Date.now();
    const finish = (code, killed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text =
        (out ? out.trim() : '') +
        (err ? (out ? '\n[stderr] ' : '') + err.trim() : '');
      resolve({
        ok: !killed && code === 0,
        code,
        ms: Date.now() - startedAt,
        output: truncateMiddle(text || '(no output)', MAX_CMD_OUTPUT),
      });
    };

    let child;
    try {
      child = spawn(exe, [scriptPath, ...cliArgs], {
        cwd: cwd || process.cwd(),
        windowsHide: true,
        env: { ...envWithPathPrefix(), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
    } catch (e) {
      err += String(e.message);
      return finish(1, false);
    }

    const timer = setTimeout(() => {
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
      finish(null, true);
      err += '\n[beast] python timed out';
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) return finish(null, true);
      signal.addEventListener('abort', () => {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
        finish(null, true);
      }, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > MAX_CMD_OUTPUT * 4) out = out.slice(-MAX_CMD_OUTPUT * 2);
    });
    child.stderr.on('data', (d) => {
      err += d;
      if (err.length > MAX_CMD_OUTPUT * 4) err = err.slice(-MAX_CMD_OUTPUT * 2);
    });
    child.on('error', (e) => { err += String(e.message); finish(1, false); });
    child.on('close', (code) => finish(code, false));
  });
}

/* ---------- web araçları ---------- */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 BeastAgent/0.2';

const PRIVATE_HOST_RE =
  /^(localhost|.*\.local|127\.|10\.|192\.168\.|169\.254\.|0\.|::1|\[::1\]|f[cd][0-9a-f]{2}:)/i;

function assertPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || ''));
  } catch {
    throw new Error('geçersiz URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('yalnızca http/https desteklenir');
  }
  const host = u.hostname;
  if (PRIVATE_HOST_RE.test(host)) {
    throw new Error('yerel/ağ içi adreslere erişim engellendi');
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error('yerel/ağ içi adreslere erişim engellendi');
  }
  if ((u.username || u.password)) {
    throw new Error('URL içinde kullanıcı bilgisi desteklenmez');
  }
  return u.toString();
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
  hellip: '…', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d',
};

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_m, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    })
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function htmlToText(html) {
  let t = String(html || '');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  t = t.replace(/[ \t\f\v]+/g, ' ');
  t = t.replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/* DuckDuckGo HTML sonuç ayrıştırıcı — test edilebilir saf fonksiyon */
function parseDdgResults(html, limit = 8) {
  const out = [];
  const re =
    /<a\s+([^>]*\bresult__a\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\s+[^>]*\bresult__a\b|$)/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const attrs = m[1] || '';
    const hrefM = attrs.match(/href="([^"]+)"/) || attrs.match(/href='([^']+)'/);
    let href = hrefM ? hrefM[1] : '';
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      href = uddg ? decodeURIComponent(uddg) : u.toString();
    } catch {}
    const title = decodeEntities(m[2] || '').replace(/<[^>]+>/g, '').trim();
    const seg = m[3] || '';
    const snM = seg.match(/<a\s+[^>]*result__snippet[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snM ? decodeEntities(snM[1]).replace(/<[^>]+>/g, '').trim() : '';
    if (!title || !/^https?:\/\//i.test(href)) continue;
    if (out.some((r) => r.url === href)) continue;
    out.push({ title, url: href, snippet });
  }
  return out;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('zaman aşımı')), timeoutMs);
  const onAbort = () => ctrl.abort(new Error('iptal'));
  if (signal) {
    if (signal.aborted) return Promise.reject(new Error('iptal'));
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function webSearch(query, { maxResults = 8, signal } = {}) {
  const q = String(query || '').trim().slice(0, 400);
  if (!q) return { ok: false, error: 'boş sorgu' };
  const res = await fetchWithTimeout(
    'https://html.duckduckgo.com/html/',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Accept: 'text/html',
      },
      body: new URLSearchParams({ q }).toString(),
    },
    20000,
    signal
  );
  if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
  const html = await res.text();
  const results = parseDdgResults(html, Math.min(Math.max(Number(maxResults) || 8, 1), 12));
  if (!results.length) {
    return { ok: true, query: q, results, note: 'sonuç yok ya da DDG yanıt biçimi değişti' };
  }
  return { ok: true, query: q, count: results.length, results };
}

const MAX_FETCH_CHARS = 9000;

async function httpFetch(url, { maxChars = MAX_FETCH_CHARS, signal } = {}) {
  const safe = assertPublicHttpUrl(url);
  const res = await fetchWithTimeout(
    safe,
    { headers: { 'User-Agent': UA, Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } },
    20000,
    signal
  );
  const ctype = String(res.headers.get('content-type') || '');
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const isTexty =
    /text\/|json|xml|javascript/i.test(ctype) || ctype === '';
  if (!isTexty) {
    return { ok: true, url: safe, status: res.status, contentType: ctype, note: 'ikili/metin olmayan içerik indirilmedi' };
  }
  const cap = 400000;
  let body = await res.text();
  if (body.length > cap) body = body.slice(0, cap);
  const text = /html/i.test(ctype) ? htmlToText(body) : body;
  const truncated = text.length > maxChars;
  return {
    ok: true,
    url: safe,
    status: res.status,
    contentType: ctype,
    truncated,
    content: text.slice(0, Math.max(1000, Math.min(Number(maxChars) || MAX_FETCH_CHARS, 50000))),
  };
}

const definitions = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a PowerShell command on the user\'s Windows machine in the workspace directory and return combined stdout/stderr. Use for shell tasks, builds, git, installs, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'PowerShell command line to execute' },
          timeout_ms: { type: 'number', description: 'Optional timeout in ms (default 90000)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file. Returns its content (truncated if huge).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write (or overwrite) a text file with content. Creates parent directories.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List entries of a directory with sizes and types.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Defaults to workspace root' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'FAST web search with an automatic chain: built-in browser first (real Chromium searching GOOGLE directly with AI Mode — no bot protection; the response may include an `ai` field holding Google\'s own AI answer, ideal for "who/what is X" questions), then TinyFish API (if a key is configured, used IMMEDIATELY whenever the browser hits CAPTCHA/unusual traffic — the browser is then skipped for 10 minutes), then Python multi-engine (ddgs / DuckDuckGo+Bing+Mojeek parallel), then Exa API as last resort if a key is configured (Ayarlar → Web Arama). Returns {ai?, results[{title,url,snippet}]}. Use when fresh or external info is needed; skip for things you already know.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          max_results: { type: 'number', description: '1-12, default 8' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_fetch',
      description:
        'Fetch one URL and return its text content (HTML converted to plain text, JSON as-is). Local/private network addresses are blocked.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri' },
          max_chars: { type: 'number', description: 'default 9000' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deep_search',
      description:
        'AGENTIC DEEP RESEARCH — use when web_search is not enough or the answer was NOT found on the first try. Runs 1-4 query variants IN PARALLEL (rephrase, synonyms, Turkish + English spellings of the same question), merges + dedupes results, then AUTOMATICALLY opens and reads the top pages with a HIDDEN real-Chromium browser (JS/SPA pages work; the visible panel is NOT touched) and returns full-text excerpts. Ideal for: multi-angle questions (price comparison, reviews, specs, "find everything about X"), Turkish queries that miss results, pages that need JS rendering. Returns {queries, results[{title,url,snippet}], pages[{url,title,content}]}.',
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            maxItems: 4,
            items: { type: 'string' },
            description: '1-4 query variants; e.g. ["iphone 16 fiyat", "iphone 16 price turkey", "iphone 16 technosa"]',
          },
          max_results: { type: 'number', description: 'merged result cap, default 16' },
          read_top: { type: 'number', description: 'how many top results to auto-read fully (0-6, default 3); 0 = results only' },
        },
        required: ['queries'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'python_run',
      description:
        "Run Python (system interpreter, or Beast auto-installs a portable embedded runtime on first use). Either pass inline `code`, or `script` = filename inside the Beast scripts library (%APPDATA%\\beast\\scripts — e.g. news.py haber toplayıcı) or an absolute path. Use for scraping, RSS/haber toplama, veri analizi, regex/parsing işleri. stdout+stderr returned; scripts should print results.",
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Inline Python source (use this OR script)' },
          script: { type: 'string', description: 'Script name in beast scripts dir or absolute path' },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'CLI arguments passed to the script, e.g. ["--limit","5","--json"]',
          },
          timeout_ms: { type: 'number', description: 'default 120000' },
        },
      },
    },
  },
];

async function exec(name, args, ctx) {
  const cwd = ctx.cwd;
  try {
    switch (name) {
      case 'run_command': {
        const t = Number(args.timeout_ms) || 90000;
        const r = await runCommand(String(args.command || ''), cwd, t, ctx.signal);
        return JSON.stringify(r);
      }
      case 'read_file': {
        const abs = safeResolve(String(args.path || ''), cwd);
        const st = fs.statSync(abs);
        if (st.size > MAX_FILE_CHARS * 2) {
          return JSON.stringify({ ok: false, error: `file too large (${st.size} bytes)` });
        }
        /* PDF: pdf-parse varsa metin çıkar (v2 class API — bkz. src/agent/pdf.js) */
        if (/\.pdf$/i.test(abs)) {
          let extract = null;
          try { extract = require('./pdf').extract; } catch {}
          if (!extract) return JSON.stringify({ ok: false, error: 'pdf okuma yok — npm i pdf-parse' });
          try {
            const r = await extract(fs.readFileSync(abs));
            let content = String((r && r.text) || '').trim();
            const pages = (r && r.total) || '?';
            const truncated = content.length > MAX_FILE_CHARS;
            if (truncated) content = content.slice(0, MAX_FILE_CHARS);
            if (!content.trim()) return JSON.stringify({ ok: false, error: 'pdf metni çıkarılamadı (taranmış görsel olabilir)' });
            return JSON.stringify({ ok: true, path: abs, pages, truncated, content });
          } catch (e2) {
            return JSON.stringify({ ok: false, error: 'pdf okuma hata: ' + String((e2 && e2.message) || e2) });
          }
        }
        let content = fs.readFileSync(abs, 'utf8');
        const truncated = content.length > MAX_FILE_CHARS;
        if (truncated) content = content.slice(0, MAX_FILE_CHARS);
        return JSON.stringify({ ok: true, path: abs, truncated, content });
      }
      case 'write_file': {
        const abs = safeResolve(String(args.path || ''), cwd);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(args.content ?? ''), 'utf8');
        return JSON.stringify({ ok: true, path: abs, bytes: Buffer.byteLength(String(args.content ?? '')) });
      }
      case 'list_dir': {
        const abs = args.path ? safeResolve(String(args.path), cwd) : cwd;
        const entries = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 500);
        const rows = entries.map((e) => {
          try {
            const st = fs.statSync(path.join(abs, e.name));
            return `${e.isDirectory() ? 'd' : '-'} ${String(st.size).padStart(10)} ${e.name}`;
          } catch {
            return `-          ? ${e.name}`;
          }
        });
        return JSON.stringify({ ok: true, path: abs, count: rows.length, entries: rows.join('\n') });
      }
      case 'web_search': {
        const q = String(args.query || '');
        const n = Number(args.max_results) || 8;
        /* önce ücretsiz python çoklu-motor; Exa SON ÇARE (dahili tarayıcı zincirin
           üstünde engine._execTool'da çalışır) */
        let r = await webSearchFast(q, { maxResults: n, signal: ctx.signal });
        if (!r || !r.ok || !(r.results || []).length) {
          const exa = await exaSearch(q, n, ctx.signal);
          if (exa) return JSON.stringify(exa);
        }
        return JSON.stringify(r);
      }
      case 'deep_search': {
        /* hook'suz bağlamda bile çalışsın: yalnız arama zinciri (sayfa okuma yok).
           Gizli tarayıcı okuması engine.research hook'undan gelir (main process). */
        const r = await research.deepSearch(
          args,
          { search: (q) => webSearchFast(q, { maxResults: 10, signal: ctx.signal }) },
          ctx.signal
        );
        return JSON.stringify(r);
      }
      case 'python_run': {
        const t0 = Date.now();
        /* önce parametreler — interpreter araması gerektirmeyen hatalar erken dönsün */
        const cliArgs = Array.isArray(args.args)
          ? args.args.map(String)
          : args.args
            ? [String(args.args)]
            : [];
        let scriptPath;
        let madeTemp = false;
        if (String(args.code || '').trim()) {
          scriptPath = path.join(
            os.tmpdir(),
            `beast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}.py`
          );
          fs.writeFileSync(scriptPath, String(args.code), 'utf8');
          madeTemp = true;
        } else if (String(args.script || '').trim()) {
          const raw = String(args.script);
          scriptPath = path.isAbsolute(raw) ? raw : path.join(pythonScriptsDir(), raw);
        } else {
          return JSON.stringify({ ok: false, error: 'code ya da script parametresi gerekli' });
        }
        if (!fs.existsSync(scriptPath)) {
          return JSON.stringify({
            ok: false,
            error: `script bulunamadı: ${scriptPath}`,
            hint: `scripts klasörü: ${pythonScriptsDir()}`,
          });
        }
        let probe;
        try {
          probe = await ensurePython({ allowDownload: ctx.allowDownload !== false, signal: ctx.signal });
        } catch (e) {
          return JSON.stringify({
            ok: false,
            error: String((e && e.message) || e),
            hint: 'BEAST_PYTHON env ile interpreter yolu verilebilir; ya da python.org kur',
          });
        }
        const r = await runPy(probe.exe, scriptPath, cliArgs, cwd, Number(args.timeout_ms) || 120000, ctx.signal);
        if (madeTemp) { try { fs.unlinkSync(scriptPath); } catch {} }
        return JSON.stringify({ ok: r.ok, python: probe.source, exitCode: r.code, ms: Date.now() - t0, output: r.output });
      }
      case 'http_fetch': {
        const r = await httpFetch(String(args.url || ''), {
          maxChars: Number(args.max_chars) || MAX_FETCH_CHARS,
          signal: ctx.signal,
        });
        return JSON.stringify(r);
      }
      default:
        return JSON.stringify({ ok: false, error: `unknown tool ${name}` });
    }
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

/* ---------- Exa (opsiyonel ücretli arama) ----------
   Ayarlar → Web Arama'dan anahtar girilirse web_search ÖNCE Exa'yı dener;
   hata/sonuç yoksa ücretsiz python çoklu-motor devreye girer. */
let _exaKey = null;

function setExaKey(key) {
  _exaKey = String(key || '').trim() || null;
}

async function exaSearch(query, maxResults, signal) {
  if (!_exaKey) return null;
  try {
    const sig =
      signal && typeof AbortSignal !== 'undefined' && AbortSignal.any
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000);
    const r = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': _exaKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        numResults: Math.max(1, Math.min(12, Number(maxResults) || 8)),
        contents: { text: { maxCharacters: 1200 } },
      }),
      signal: sig,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const results = (j.results || [])
      .map((x) => ({
        title: String(x.title || ''),
        url: String(x.url || ''),
        snippet: String(x.text || '').replace(/\s+/g, ' ').slice(0, 400),
        engine: 'exa',
      }))
      .filter((x) => x.url && x.title);
    if (!results.length) return null;
    return { ok: true, engine: 'exa', query, results };
  } catch {
    return null;
  }
}

/* ---------- TinyFish (ücretsiz arama; anahtar girilirse ZİNCİRİN BAŞI) ----------
   GET https://api.search.tinyfish.ai?query=...  ·  Header: X-API-Key
   Ayarlar → Web Arama'dan anahtar girilirse web_search ÖNCE TinyFish'i dener;
   hata/sonuç yoksa eski zincir (tarayıcı → python çoklu-motor → Exa) devam eder. */
let _tinyfishKey = null;

function setTinyfishKey(key) {
  _tinyfishKey = String(key || '').trim() || null;
}

async function tinyfishSearch(query, maxResults, signal) {
  if (!_tinyfishKey) return null;
  try {
    const sig =
      signal && typeof AbortSignal !== 'undefined' && AbortSignal.any
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000);
    const r = await fetch(
      `https://api.search.tinyfish.ai?query=${encodeURIComponent(String(query || ''))}`,
      {
        headers: {
          'X-API-Key': _tinyfishKey,
          'X-TF-Request-Origin': 'api',
          'X-TF-Client-Name': 'tinyfish-api-key-page',
        },
        signal: sig,
      }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const results = (j.results || [])
      .map((x) => ({
        title: String(x.title || ''),
        url: String(x.url || ''),
        snippet: String(x.snippet || '').replace(/\s+/g, ' ').slice(0, 400),
        engine: 'tinyfish',
      }))
      .filter((x) => x.url && x.title);
    if (!results.length) return null;
    return { ok: true, engine: 'tinyfish', query, results: results.slice(0, Math.max(1, Math.min(12, Number(maxResults) || 8))) };
  } catch {
    return null;
  }
}

module.exports = {
  definitions,
  exec,
  runCommand,
  assertPublicHttpUrl,
  parseDdgResults,
  htmlToText,
  webSearch,
  httpFetch,
  webSearchFast,
  seedScript,
  bundledScriptPath,
  setExaKey,
  exaSearch,
  setTinyfishKey,
  tinyfishSearch,
  /* python altyapısı */
  ensurePython,
  findSystemPython,
  installEmbeddedPython,
  pythonScriptsDir,
  embeddedPythonExe,
  runPy,
};
