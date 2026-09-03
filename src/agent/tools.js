'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { spawn } = require('child_process');
const research = require('./research');
const obscura = require('./obscura');

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

/* ---------- opencode port: truncate.ts ----------
   MAX_LINES 2000 / MAX_BYTES 50KB aşarsa TAM çıktı geçici dosyaya yazılır;
   modele sınırlı önizleme + dosya yolu döner (Model Tool Output bounding).
   Böylece hiçbir araç çıktısı KAYBOLMAZ — ajan read_file ile kalanını okur. */
const TRUNC_MAX_LINES = 2000;
const TRUNC_MAX_BYTES = 50 * 1024;
const TRUNC_PREVIEW_CHARS = 6000; /* engine'in 7200'lik dilimi içinde ipucu kalsın */

function toolOutputDir() {
  const d = path.join(os.tmpdir(), 'beast-tool-output');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function boundToolOutput(text) {
  const s = String(text || '');
  const bytes = Buffer.byteLength(s, 'utf8');
  const lines = s.split('\n').length;
  if (bytes <= TRUNC_MAX_BYTES && lines <= TRUNC_MAX_LINES) return { text: s };
  const file = path.join(
    toolOutputDir(),
    `tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}.txt`
  );
  try {
    fs.writeFileSync(file, s);
  } catch {
    return { text: s.slice(0, TRUNC_PREVIEW_CHARS) + '\n…[kırpıldı]' };
  }
  return {
    text:
      s.slice(0, TRUNC_PREVIEW_CHARS) +
      `\n\n[çıktı kırpıldı: ${lines} satır / ${bytes} byte — TAM ÇIKTI: ${file}\nread_file'ı offset/limit ile kullanarak kalan bölümleri oku]`,
    outputFile: file,
  };
}

/* ---------- opencode port: shell.ts + shell/prompt.ts ----------
   Workspace başına KALICI PowerShell oturumu: cd/env çağrılar arasında
   korunur, her çağrıda process spawn maliyeti yoktur. Komut bitişi benzersiz
   işaretle algılanır (prompt senkronizasyonu). Paralel çağrılar oturum
   başına sıraya girer (opencode ile aynı: oturum başına sıralı yürütme). */
const SHELL_QUEUE_CAP = 6; /* en fazla bu kadar ayrı workspace oturumu */
const SHELL_IDLE_MS = 10 * 60 * 1000; /* 10 dk boşta kalan oturum kapatılır */
const _shSessions = new Map(); // cwd → session

/* boşta reaper: unref'li zamanlayıcı — event loop'u tek başına tutmaz */
const _shellReaper = setInterval(() => {
  const now = Date.now();
  for (const [k, sess] of _shSessions) {
    if (!sess.busy && now - (sess.lastUsed || 0) > SHELL_IDLE_MS) {
      _shellDispose(sess);
      _shSessions.delete(k);
    }
  }
}, 60000);
if (_shellReaper.unref) _shellReaper.unref();

function _shellDispose(sess) {
  try {
    if (sess.proc && sess.proc.pid) {
      spawn('taskkill', ['/pid', String(sess.proc.pid), '/T', '/F'], { windowsHide: true });
    }
  } catch {}
  try { sess.proc && sess.proc.kill(); } catch {}
  sess.dead = true;
}

function disposeShellSessions() {
  for (const sess of _shSessions.values()) _shellDispose(sess);
  _shSessions.clear();
}

function _spawnShell(cwd) {
  const proc = spawn(
    'powershell.exe',
    ['-NoProfile', '-NoExit', '-Command', '-'],
    { cwd: cwd || process.cwd(), windowsHide: true, env: envWithPathPrefix() }
  );
  const sess = {
    proc,
    cwd,
    buf: '',
    err: '',
    seq: 0,
    busy: false,
    queue: [], // {command, resolve, timer, signal, onAbort}
    dead: false,
  };
  /* Node 22: child + stdio stream'leri event loop'a bağlanmaz — test/CLI'da
     bekleyen oturum sürecin çıkmasını ENGELLEMEZ; uygulama kapanışında
     disposeShellSessions() yine de temiz kapatır */
  try {
    proc.unref && proc.unref();
    proc.stdin.unref && proc.stdin.unref();
    proc.stdout.unref && proc.stdout.unref();
    proc.stderr.unref && proc.stderr.unref();
  } catch {}
  proc.stdin.on && proc.stdin.on('error', () => {}); // EPIPE yut — oturum ölünce yazma patlamasın
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    sess.buf += d;
    _shellPump(sess);
  });
  proc.stderr.on('data', (d) => {
    sess.err += d;
    if (sess.err.length > MAX_CMD_OUTPUT * 4) sess.err = sess.err.slice(-MAX_CMD_OUTPUT * 2);
  });
  proc.on('exit', () => {
    sess.dead = true;
    /* bekleyen komutları ölü oturumda düşür — yeni çağrı taze oturum açar */
    while (sess.queue.length) {
      const w = sess.queue.shift();
      clearTimeout(w.timer);
      w.resolve({ ok: false, code: null, output: sess.buf.slice(-2000) + '\n[beast] shell oturumu kapandı' });
    }
    sess.busy = false;
    if (_shSessions.get(cwd) === sess) _shSessions.delete(cwd);
  });
  proc.on('error', () => {
    sess.dead = true;
  });
  return sess;
}

function _shellPump(sess) {
  const w = sess.queue[0];
  if (!w || !w.dispatched) return;
  const marker = `${SHELL_MARKER_PREFIX}${w.n}_`;
  const mi = sess.buf.indexOf(marker);
  if (mi < 0) return;
  const lineEnd = sess.buf.indexOf('\n', mi);
  if (lineEnd < 0) return; /* işaret satırı tam gelmedi — daha fazla veri bekle */
  const markerLine = sess.buf.slice(mi, lineEnd).trim();
  let out = sess.buf.slice(0, mi);
  sess.buf = sess.buf.slice(lineEnd + 1);
  sess.queue.shift();
  sess.busy = sess.queue.length > 0;
  clearTimeout(w.timer);
  const codeM = /_(\-?\d+)\s*$/.exec(markerLine);
  const exitCode = codeM ? Number(codeM[1]) : null;
  if (out.length > MAX_CMD_OUTPUT * 4) out = out.slice(-MAX_CMD_OUTPUT * 2);
  const errPart = sess.err.trim();
  sess.err = '';
  w.resolve({
    ok: exitCode === 0,
    code: exitCode,
    output:
      (out.trim() || '') +
      (errPart ? (out.trim() ? '\n[stderr] ' : '') + errPart : ''),
  });
  sess.lastUsed = Date.now();
  if (sess.queue.length) _shellDispatch(sess);
}

const SHELL_MARKER_PREFIX = '__BEAST_DONE_';

function _shellDispatch(sess) {
  const w = sess.queue[0];
  if (!w || w.dispatched) return;
  w.dispatched = true;
  w.n = ++sess.seq;
  const cmd = w.command;
  const marker = `${SHELL_MARKER_PREFIX}${w.n}_$LASTEXITCODE`;
  /* $LASTEXITCODE sıfırlanır: yalnız cmdlet koşan komutlar da ok:true dönsün;
     native exe hata verirse gerçek kod işaret satırına yazılır */
  sess.proc.stdin.write(`$global:LASTEXITCODE = 0\n${cmd}${cmd.endsWith('\n') ? '' : '\n'}Write-Output "${marker}"\n`);
  const finishTimeout = () => {
    _shellDispose(sess);
    if (_shSessions.get(sess.cwd) === sess) _shSessions.delete(sess.cwd);
    sess.busy = false;
    while (sess.queue.length) {
      const x = sess.queue.shift();
      clearTimeout(x.timer);
      x.resolve({ ok: false, code: null, output: '[beast] shell komutu zaman aşımı — oturum tazelendi' });
    }
  };
  w.timer = setTimeout(finishTimeout, w.timeoutMs);
  if (w.signal) {
    if (w.signal.aborted) return finishTimeout();
    w.signal.addEventListener('abort', finishTimeout, { once: true });
  }
}

function runShellCommand(command, cwd, timeoutMs = 90000, signal) {
  return new Promise((resolve) => {
    let sess = _shSessions.get(cwd);
    if (!sess || sess.dead) {
      try {
        sess = _spawnShell(cwd);
        _shSessions.set(cwd, sess);
        while (_shSessions.size > SHELL_QUEUE_CAP) {
          const [k, old] = _shSessions.entries().next().value;
          if (k === cwd) break;
          _shellDispose(old);
          _shSessions.delete(k);
        }
      } catch {
        /* kalıcı oturum açılamadı → tek seferlik klasik yol */
        return runCommand(command, cwd, timeoutMs, signal).then(resolve);
      }
    }
    sess.queue.push({ command, resolve, timeoutMs, signal, dispatched: false });
    sess.lastUsed = Date.now();
    if (!sess.busy) {
      sess.busy = true;
      _shellDispatch(sess);
    }
  });
}

/* --- core/shell.ts gitbash() port: Windows'ta bash çözümleme sırası --- */
function gitbash() {
  const cands = [];
  if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  if (process.env['ProgramFiles(x86)']) cands.push(path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));
  if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return 'bash'; /* PATH'te aranır; yoksa spawn ENOENT → net hata mesajı */
}

function runBashCommand(command, cwd, timeoutMs = 90000, signal) {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let err = '';
    const finish = (code, killed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = (out ? out.trim() : '') + (err ? (out ? '\n[stderr] ' : '') + err.trim() : '');
      resolve({ ok: !killed && code === 0, code, output: truncateMiddle(text || '(no output)', MAX_CMD_OUTPUT) });
    };
    let child;
    try {
      child = spawn(gitbash(), ['-lc', command], {
        cwd: cwd || process.cwd(),
        windowsHide: true,
        env: envWithPathPrefix(),
      });
    } catch {
      resolve({ ok: false, code: null, output: 'bash bulunamadı — Git for Windows kur ya da PowerShell kullan' });
      return;
    }
    const timer = setTimeout(() => {
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {}
      err += '\n[beast] command timed out';
      finish(null, true);
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
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      settled = true;
      const msg = String((e && e.message) || '');
      resolve({
        ok: false,
        code: null,
        output: /ENOENT/i.test(msg)
          ? 'bash bulunamadı — Git for Windows kur ya da PowerShell kullan'
          : msg,
      });
    });
    child.on('close', (code) => finish(code, false));
  });
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

/* ---------- opencode read.ts port: binary tespit + fuzzy öneri ----------
   opencode read.ts kuralı: uzantı kara listesi YA DA ilk 4KB'ta NUL byte YA DA
   %30+'ı yazdırılamaz karakter → dosya binary sayılır, okunmaz. */
const BINARY_EXT_RE =
  /\.(zip|tar|gz|tgz|bz2|xz|7z|rar|exe|dll|so|dylib|bin|iso|img|msi|apk|jar|class|pyc|pyo|o|obj|a|lib|woff2?|ttf|otf|eot|mp3|mp4|avi|mkv|mov|flac|ogg|wav|webm|psd|ai|sketch|db|sqlite3?|pdb|docx?|xlsx?|pptx?|odt|ods|odp|pgp|gpg|keystore|jks|p12|traineddata|idx)$/i;

function looksBinary(buf) {
  const sample = buf.length > 4096 ? buf.subarray(0, 4096) : buf;
  if (sample.includes(0)) return true;
  let nonPrintable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13) continue; // \t \n \r
    if (b < 32 || b === 127 || b >= 0x80) nonPrintable++; // 0x80+ UTF-8 devam byte'ı olabilir ama kaba tarama yeterli
  }
  return sample.length > 0 && nonPrintable / sample.length > 0.3;
}

/* opencode read.ts: dosya yoksa aynı klasörde isim ön-ek benzerliği olan 3 kardeş öner */
function fuzzySiblings(abs) {
  try {
    const dir = path.dirname(abs);
    const base = path.basename(abs).toLowerCase();
    const prefix = base.slice(0, 4);
    const score = (name) => {
      const n = name.toLowerCase();
      if (n === base) return -1;
      let s = 0;
      if (n.startsWith(prefix)) s += 2;
      for (let i = 0; i < Math.min(base.length, n.length); i++) if (base[i] === n[i]) s += 0.1;
      return s;
    };
    return fs
      .readdirSync(dir)
      .map((name) => ({ name, s: score(name) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map((x) => x.name);
  } catch {
    return [];
  }
}

/* ---------- opencode port: grep/glob altyapısı ----------
   ripgrep gitignore'u izler; Beast'te bağımlılık olmasın diye ağır klasörler
   statik atlanır (node_modules, .git, derleme çıktıları…). */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.cache',
]);

/* mini glob → regex: ** → her şey, * → / içermeyen her şey, ? → tek karakter */
function globToRegExp(glob) {
  const g = String(glob || '').trim();
  if (!g) return null;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*';
        i++;
        if (g[i + 1] === '/') i++; /* yıldız-yıldız-slash: üst klasörler opsiyonel */
      } else re += '[^/\\\\]*';
    } else if (c === '?') re += '[^/\\\\]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp('^' + re + '$', 'i');
  } catch {
    return null;
  }
}

/* Sıralı dosya yürüyüşü; cb true dönerse erken durur */
function walkFiles(dir, includeRe, cb, depth = 0) {
  if (depth > 24) return false;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.') && e.name !== '.opencode') continue;
      if (walkFiles(full, includeRe, cb, depth + 1)) return true;
    } else if (e.isFile()) {
      if (includeRe && !includeRe.test(e.name)) continue;
      if (cb(full)) return true;
    }
  }
  return false;
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

/* opencode webfetch.ts tarzı HTML→Markdown (hafif sürüm — Turndown bağımlılığı yok):
   başlıklar, linkler, kalık/italik, kod blokları, listeler korunur */
function htmlToMarkdown(html) {
  let h = String(html || '');
  h = h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  h = h.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, c) => '\n```\n' + decodeEntities(c) + '\n```\n');
  h = h.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, c) => '`' + decodeEntities(c) + '`');
  h = h.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, c) => '\n' + '#'.repeat(Number(lvl)) + ' ' + decodeEntities(c.replace(/<[^>]+>/g, '')).trim() + '\n');
  h = h.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, c) => `[${decodeEntities(c.replace(/<[^>]+>/g, '')).trim()}](${href})`);
  h = h.replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, c) => `**${decodeEntities(c.replace(/<[^>]+>/g, '')).trim()}**`);
  h = h.replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, c) => `*${decodeEntities(c.replace(/<[^>]+>/g, '')).trim()}*`);
  h = h.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, c) => `\n- ${decodeEntities(c.replace(/<[^>]+>/g, '')).trim()}`);
  h = h.replace(/<hr\s*\/?>/gi, '\n---\n');
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<\/(p|div|section|article|tr|h[1-6])>/gi, '\n');
  h = h.replace(/<[^>]+>/g, '');
  h = decodeEntities(h);
  h = h.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return h.trim();
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
  let res;
  try {
    res = await fetchWithTimeout(
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
  } catch (e) {
    /* ağ hatası/rate-limit exception fırlatmasın — zincir devam edebilsin */
    return { ok: false, error: 'DDG erişilemedi: ' + String((e && e.message) || e) };
  }
  if (!res.ok) return { ok: false, error: `DDG HTTP ${res.status}` };
  const html = await res.text();
  const results = parseDdgResults(html, Math.min(Math.max(Number(maxResults) || 8, 1), 12));
  if (!results.length) {
    return { ok: true, query: q, results, note: 'sonuç yok ya da DDG yanıt biçimi değişti' };
  }
  return { ok: true, query: q, count: results.length, results };
}

const MAX_FETCH_CHARS = 9000;

async function httpFetch(url, { maxChars = MAX_FETCH_CHARS, format = 'text', timeoutMs = 30000, signal } = {}) {
  const safe = assertPublicHttpUrl(url);
  const t = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 120000); // opencode: default 30s, max 120s
  const res = await fetchWithTimeout(
    safe,
    { headers: { 'User-Agent': UA, Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' } },
    t,
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
  let content;
  if (/html/i.test(ctype)) {
    if (format === 'html') content = body;
    else if (format === 'markdown') content = htmlToMarkdown(body);
    else content = htmlToText(body);
  } else {
    content = body;
  }
  const truncated = content.length > maxChars;
  return {
    ok: true,
    url: safe,
    status: res.status,
    contentType: ctype,
    format,
    truncated,
    content: content.slice(0, Math.max(1000, Math.min(Number(maxChars) || MAX_FETCH_CHARS, 50000))),
  };
}

/* ================= opencode edit.ts BİREBİR PORT =================
   Kaynak: opencode-dev/packages/opencode/src/tool/edit.ts
   9 aşamalı replacer zinciri: Simple → LineTrimmed → BlockAnchor →
   WhitespaceNormalized → IndentationFlexible → EscapeNormalized →
   TrimmedBoundary → ContextAware → MultiOccurrence.
   Modelin old_string'i ufak girinti/boşluk farkıyla tutturamadığında zincir
   akıllı eşleşme bulur — "dosyayı baştan oku" döngüsü kökten kırılır. */

function normalizeLineEndings(text) {
  return text.replaceAll('\r\n', '\n');
}
function detectLineEnding(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
function convertToLineEnding(text, ending) {
  if (ending === '\n') return text;
  return text.replaceAll('\n', '\r\n');
}

/* blok-anchor fallback benzerlik eşikleri (edit.ts:220-221) */
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65;

function levenshtein(a, b) {
  if (a === '' || b === '') return Math.max(a.length, b.length);
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

const SimpleReplacer = function* (_content, find) {
  yield find;
};

const LineTrimmedReplacer = function* (content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');
  if (searchLines[searchLines.length - 1] === '') searchLines.pop();
  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }
    if (matches) {
      let matchStartIndex = 0;
      for (let k = 0; k < i; k++) matchStartIndex += originalLines[k].length + 1;
      let matchEndIndex = matchStartIndex;
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length;
        if (k < searchLines.length - 1) matchEndIndex += 1;
      }
      yield content.substring(matchStartIndex, matchEndIndex);
    }
  }
};

const BlockAnchorReplacer = function* (content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');
  if (searchLines.length < 3) return;
  if (searchLines[searchLines.length - 1] === '') searchLines.pop();
  const firstLineSearch = searchLines[0].trim();
  const lastLineSearch = searchLines[searchLines.length - 1].trim();
  const searchBlockSize = searchLines.length;
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25));
  const candidates = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) continue;
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1;
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j });
        }
        break;
      }
    }
  }
  if (candidates.length === 0) return;
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0];
    const actualBlockSize = endLine - startLine + 1;
    let similarity = 0;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim();
        const searchLine = searchLines[j].trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) continue;
        const distance = levenshtein(originalLine, searchLine);
        similarity += (1 - distance / maxLen) / linesToCheck;
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break;
      }
    } else {
      similarity = 1.0;
    }
    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0;
      for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1;
      let matchEndIndex = matchStartIndex;
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length;
        if (k < endLine) matchEndIndex += 1;
      }
      yield content.substring(matchStartIndex, matchEndIndex);
    }
    return;
  }
  let bestMatch = null;
  let maxSimilarity = -1;
  for (const candidate of candidates) {
    const { startLine, endLine } = candidate;
    const actualBlockSize = endLine - startLine + 1;
    let similarity = 0;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim();
        const searchLine = searchLines[j].trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) continue;
        const distance = levenshtein(originalLine, searchLine);
        similarity += 1 - distance / maxLen;
      }
      similarity /= linesToCheck;
    } else {
      similarity = 1.0;
    }
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      bestMatch = candidate;
    }
  }
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch;
    let matchStartIndex = 0;
    for (let k = 0; k < startLine; k++) matchStartIndex += originalLines[k].length + 1;
    let matchEndIndex = matchStartIndex;
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length;
      if (k < endLine) matchEndIndex += 1;
    }
    yield content.substring(matchStartIndex, matchEndIndex);
  }
};

const WhitespaceNormalizedReplacer = function* (content, find) {
  const normalizeWhitespace = (text) => text.replace(/\s+/g, ' ').trim();
  const normalizedFind = normalizeWhitespace(find);
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line;
    } else {
      const normalizedLine = normalizeWhitespace(line);
      if (normalizedLine.includes(normalizedFind)) {
        const words = find.trim().split(/\s+/);
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
          try {
            const regex = new RegExp(pattern);
            const match = line.match(regex);
            if (match) yield match[0];
          } catch {}
        }
      }
    }
  }
  const findLines = find.split('\n');
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length);
      if (normalizeWhitespace(block.join('\n')) === normalizedFind) {
        yield block.join('\n');
      }
    }
  }
};

const IndentationFlexibleReplacer = function* (content, find) {
  const removeIndentation = (text) => {
    const lines = text.split('\n');
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) return text;
    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/);
        return match ? match[1].length : 0;
      })
    );
    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join('\n');
  };
  const normalizedFind = removeIndentation(find);
  const contentLines = content.split('\n');
  const findLines = find.split('\n');
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n');
    if (removeIndentation(block) === normalizedFind) yield block;
  }
};

const EscapeNormalizedReplacer = function* (content, find) {
  const unescapeString = (str) =>
    str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case "'": return "'";
        case '"': return '"';
        case '`': return '`';
        case '\\': return '\\';
        case '\n': return '\n';
        case '$': return '$';
        default: return match;
      }
    });
  const unescapedFind = unescapeString(find);
  if (content.includes(unescapedFind)) yield unescapedFind;
  const lines = content.split('\n');
  const findLines = unescapedFind.split('\n');
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n');
    if (unescapeString(block) === unescapedFind) yield block;
  }
};

const MultiOccurrenceReplacer = function* (content, find) {
  let startIndex = 0;
  while (true) {
    const index = content.indexOf(find, startIndex);
    if (index === -1) break;
    yield find;
    startIndex = index + find.length;
  }
};

const TrimmedBoundaryReplacer = function* (content, find) {
  const trimmedFind = find.trim();
  if (trimmedFind === find) return;
  if (content.includes(trimmedFind)) yield trimmedFind;
  const lines = content.split('\n');
  const findLines = find.split('\n');
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n');
    if (block.trim() === trimmedFind) yield block;
  }
};

const ContextAwareReplacer = function* (content, find) {
  const findLines = find.split('\n');
  if (findLines.length < 3) return;
  if (findLines[findLines.length - 1] === '') findLines.pop();
  const contentLines = content.split('\n');
  const firstLine = findLines[0].trim();
  const lastLine = findLines[findLines.length - 1].trim();
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue;
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        const blockLines = contentLines.slice(i, j + 1);
        const block = blockLines.join('\n');
        if (blockLines.length === findLines.length) {
          let matchingLines = 0;
          let totalNonEmptyLines = 0;
          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim();
            const findLine = findLines[k].trim();
            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++;
              if (blockLine === findLine) matchingLines++;
            }
          }
          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block;
            break;
          }
        }
        break;
      }
    }
  }
};

function isDisproportionateMatch(search, oldString) {
  const oldLines = oldString.split('\n').length;
  const searchLines = search.split('\n').length;
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (oldLines === 1) return false;
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4);
}

/* edit.ts:682-729 replace() — zinciri sırayla dener; tek eşleşme şart,
   replaceAll'de tümünü değiştirir; hata mesajları BİREBİR opencode */
function ocReplace(content, oldString, newString, replaceAll = false) {
  if (oldString === newString) {
    throw new Error('No changes to apply: oldString and newString are identical.');
  }
  if (oldString === '') {
    throw new Error(
      'oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write_file for an intentional full-file replacement.'
    );
  }
  let notFound = true;
  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search);
      if (index === -1) continue;
      notFound = false;
      if (isDisproportionateMatch(search, oldString)) {
        throw new Error(
          'Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.'
        );
      }
      if (replaceAll) {
        return { result: content.replaceAll(search, newString), replacements: content.split(search).length - 1 };
      }
      const lastIndex = content.lastIndexOf(search);
      if (index !== lastIndex) continue;
      return { result: content.substring(0, index) + newString + content.substring(index + search.length), replacements: 1 };
    }
  }
  if (notFound) {
    throw new Error(
      'Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.'
    );
  }
  throw new Error('Found multiple matches for oldString. Provide more surrounding context to make the match unique.');
}

/* ---------- opencode diff portu (npm "diff" paketinin diffLines karşılığı) ----------
   LCS tabanlı satır diff'i: additions/deletions sayımı (edit.ts:175-180) ve
   UI split-diff görünümü için kırpılmış bölge (trimDiff mantığı). */
function diffLineCounts(aText, bText) {
  /* bos metin = 0 satir (opencode npm diffLines davranisi) */
  const a = aText ? String(aText).split('\n') : [];
  const b = bText ? String(bText).split('\n') : [];
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= p && eb >= p && a[ea] === b[eb]) { ea--; eb--; }
  const midA = a.slice(p, ea + 1);
  const midB = b.slice(p, eb + 1);
  const n = midA.length;
  const m = midB.length;
  if (!n && !m) return { additions: 0, deletions: 0 };
  if (n * m > 400000 || n > 1500 || m > 1500) return { additions: m, deletions: n };
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        midA[i] === midB[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const matched = dp[0];
  return { additions: m - matched, deletions: n - matched };
}

const DIFF_REGION_CTX = 3; /* değişiklik etrafında kaç bağlam satırı gösterilir */
const DIFF_REGION_CAP = 3500; /* UI'ye giden bölge başına karakter tavanı */

function capDiffText(s) {
  const t = String(s || '');
  return t.length > DIFF_REGION_CAP ? t.slice(0, DIFF_REGION_CAP) + '\n…' : t;
}

/* Değişen bölgeyi ±DIFF_REGION_CTX bağlam satırıyla kırpar (opencode trimDiff
   mantığı — tüm dosya yerine yalnız değişen kısım UI'ye gider). */
function diffRegion(before, after) {
  const a = String(before || '').split('\n');
  const b = String(after || '').split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= p && eb >= p && a[ea] === b[eb]) { ea--; eb--; }
  const start = Math.max(0, p - DIFF_REGION_CTX);
  const beforeRegion = a.slice(start, Math.min(a.length, ea + 1 + DIFF_REGION_CTX)).join('\n');
  const afterRegion = b.slice(start, Math.min(b.length, eb + 1 + DIFF_REGION_CTX)).join('\n');
  return { before: capDiffText(beforeRegion), after: capDiffText(afterRegion), startLine: start + 1 };
}

/* ---------- read_file disk-cache (opencode file-state portu) ----------
   mtime+size değişmemişse dosya yeniden diskten OKUNMAZ — cache'ten döner.
   edit_file/write_file kendi yazdıklarından sonra cache'i düşürür; böylece
   sonraki okuma daima güncel içerik verir. */
const _readCache = new Map(); /* abs → { mtimeMs, size, raw } */

function readCacheGet(abs, st) {
  const hit = _readCache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.raw;
  const raw = fs.readFileSync(abs, 'utf8');
  if (_readCache.size > 200) _readCache.delete(_readCache.keys().next().value);
  _readCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, raw });
  return raw;
}

function readCacheDrop(abs) {
  _readCache.delete(abs);
}

const definitions = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Executes a given PowerShell command on the user\'s Windows machine in the workspace directory and returns combined stdout/stderr. Use this tool for terminal operations like builds, git, npm installs, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead: read_file, write_file, edit_file, grep, glob.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'PowerShell command line to execute' },
          timeout_ms: { type: 'number', description: 'Optional timeout in ms (default 120000)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      /* opencode read.txt BİREBİR port (parametre adı path olarak kaldı) */
      description:
        'Read a file or directory from the local filesystem. If the path does not exist, an error is returned.\n\n' +
        'Usage:\n' +
        '- By default, this tool returns up to 2000 lines from the start of the file.\n' +
        '- The offset parameter is the line number to start reading from (1-indexed).\n' +
        '- To read later sections, call this tool again with a larger offset — NEVER re-read from the start of the file.\n' +
        '- Use the grep tool to find specific content in large files or files with long lines.\n' +
        '- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.\n' +
        '- Contents are returned with each line prefixed by its line number as `<line>: <content>`. For example, if a file has contents "foo\\n", you will receive "1: foo\\n".\n' +
        '- Any line longer than 2000 characters is truncated.\n' +
        '- Call this tool in parallel when you know there are multiple files you want to read.\n' +
        '- Avoid tiny repeated slices (30 line chunks). If you need more context, read a larger window.\n' +
        '- File contents you read STAY in your context for the WHOLE session. Do NOT re-read a file you already read: chain edits from your previous read plus your own edit_file/write_file results. Re-reading the same file (same or overlapping range) wastes turns and is forbidden unless the file actually changed on disk outside your own edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The path to the file to read' },
          offset: { type: 'number', description: 'The line number to start reading from (1-indexed)' },
          limit: { type: 'number', description: 'The maximum number of lines to read (defaults to 2000)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      /* opencode write.txt BİREBİR port */
      description:
        'Writes a file to the local filesystem.\n\n' +
        'Usage:\n' +
        '- This tool will overwrite the existing file if there is one at the provided path.\n' +
        '- If this is an existing file, you MUST use the read_file tool first to read the file\'s contents. This tool will fail if you did not read the file first.\n' +
        '- ALWAYS prefer editing existing files in the codebase with edit_file. NEVER write new files unless explicitly required.\n' +
        '- The result includes additions/deletions counts — the change is APPLIED to disk immediately; do NOT read the file again to verify.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The path to the file to write' },
          content: { type: 'string', description: 'The content to write to the file' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      /* opencode edit.txt BİREBİR port (parametre adları snake_case kaldı) */
      description:
        'Performs exact string replacements in files.\n\n' +
        'Usage:\n' +
        '- You must use your read_file tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.\n' +
        '- When editing text from read_file output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + colon + space (e.g., `1: `). Everything after that space is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.\n' +
        '- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n' +
        '- The edit will FAIL if `old_string` is not found in the file with an error "oldString not found in content".\n' +
        '- The edit will FAIL if `old_string` is found multiple times in the file with an error "Found multiple matches for oldString. Provide more surrounding lines in old_string to identify the correct match." Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.\n' +
        '- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.\n' +
        '- The result includes additions/deletions counts — the change is APPLIED to disk immediately; do NOT read the file again to verify.\n' +
        '- Chain follow-up edits from what you already read plus your own previous edits — do NOT re-read the file between edits. Multiple edit_file calls to different files can be issued in PARALLEL in one turn.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'The path to the file to modify' },
          old_string: { type: 'string', description: 'The text to replace' },
          new_string: { type: 'string', description: 'The text to replace it with (must be different from old_string)' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string (default false)' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Fast content search tool that works with any codebase size. Searches file contents using regular expressions (case-SENSITIVE by default — pass case_insensitive:true to ignore case); supports full regex syntax (eg. "log.*Error", "function\\s+\\w+"). Filter files by pattern with include (eg. "*.js", "*.{ts,tsx}"). Returns grouped matches as `<path>:` + `  Line N: text`, capped at 100 matches. node_modules/.git and similar dirs are skipped. Use this to find where functions/symbols/errors live before editing.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression' },
          path: { type: 'string', description: 'File or directory to search; defaults to workspace root' },
          include: { type: 'string', description: 'Glob filter like "*.js" or "*.{ts,tsx}"' },
          case_insensitive: { type: 'boolean', description: 'Ignore case (default false — search is case-sensitive)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Fast file pattern matching tool that works with any codebase size. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths (max 100; more specific pattern/path if truncated). Use when you need to find files by name patterns; batch multiple speculative searches in one turn.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' },
          path: { type: 'string', description: 'Directory to search; defaults to workspace root' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List entries of a directory (localeCompare sorted, directories suffixed with `/`, max 500 entries) with sizes and types.',
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
      name: 'webfetch',
      description:
        '- Fetches content from a specified URL\n' +
        '- Takes a URL and optional format as input\n' +
        '- Fetches the URL content, converts to requested format (markdown by default)\n' +
        '- Returns the content in the specified format\n' +
        '- Use this tool when you need to retrieve and analyze web content\n' +
        '- IMPORTANT: if another tool is present that offers better web fetching capabilities, is more targeted to the task, or has fewer restrictions, prefer using that tool instead of this one.\n' +
        '- The URL must be a fully-formed valid URL\n' +
        '- HTTP URLs will be automatically upgraded to HTTPS\n' +
        '- Format options: "text" (default), "markdown", or "html"\n' +
        '- Local/private network addresses are blocked; timeout default 30s (max 120s)',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri', description: 'The URL to fetch content from' },
          format: { type: 'string', enum: ['text', 'markdown', 'html'], description: 'The format to return the content in (defaults to text)' },
          timeout: { type: 'number', description: 'Optional timeout in seconds (max 120)' },
          max_chars: { type: 'number', description: 'Output character cap (default 9000, max 50000)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'FAST web search with an automatic chain (order is configurable in Ayarlar → Web Arama): built-in browser (real Chromium searching GOOGLE directly with AI Mode — no bot protection; the response may include an `ai` field holding Google\'s own AI answer), Obscura stealth headless browser (anti-detect; searches DuckDuckGo, installed automatically and ACTIVE by default), TinyFish API (only if a key is configured), then Python multi-engine (ddgs / DuckDuckGo+Bing+Mojeek). If the browser hits CAPTCHA/unusual traffic it is skipped for 10 minutes and the next engine takes over. Returns {ai?, results[{title,url,snippet}]}. Use when fresh or external info is needed; skip for things you already know.',
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
        /* opencode shell.ts kuralları: default 120s, negatif timeout reddi */
        const tRaw = Number(args.timeout_ms);
        if (Number.isFinite(tRaw) && args.timeout_ms != null && tRaw <= 0) {
          return JSON.stringify({ ok: false, error: `Invalid timeout value: ${tRaw}. Timeout must be a positive number.` });
        }
        const t = Number.isFinite(tRaw) && tRaw > 0 ? tRaw : 120000;
        const shell = String(args.shell || 'powershell').toLowerCase();
        const r =
          shell === 'bash' || shell === 'sh'
            ? await runBashCommand(String(args.command || ''), cwd, t, ctx.signal)
            : await runShellCommand(String(args.command || ''), cwd, t, ctx.signal);
        const b = boundToolOutput((r && r.output) || '');
        return JSON.stringify({
          ok: !!(r && r.ok),
          code: r && r.code,
          output: b.text || '(no output)',
          ...(b.outputFile ? { outputFile: b.outputFile } : {}),
        });
      }
      case 'edit_file': {
        /* opencode edit.ts execute BİREBİR port — replacer zinciri + satır sonu
           normalizasyonu + diff metadata (additions/deletions + UI diffView) */
        const filePath = safeResolve(String(args.path || args.filePath || ''), cwd);
        const oldS = String(args.old_string ?? args.oldString ?? '');
        const newS = String(args.new_string ?? args.newString ?? '');
        try {
          if (oldS === newS) {
            throw new Error('No changes to apply: oldString and newString are identical.');
          }
          /* boş oldString = YENİ dosya oluşturma yolu (edit.ts:90-121) */
          if (oldS === '') {
            if (fs.existsSync(filePath)) {
              throw new Error(
                'oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write_file for an intentional full-file replacement.'
              );
            }
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, newS, 'utf8');
            readCacheDrop(filePath);
            const counts = diffLineCounts('', newS);
            const out = { ok: true, path: filePath, note: 'Edit applied successfully.', replacements: 1, ...counts };
            if (ctx.wantDiff) out.diffView = { path: filePath, before: '', after: capDiffText(newS), startLine: 1, ...counts };
            return JSON.stringify(out);
          }
          if (!fs.existsSync(filePath)) throw new Error(`File ${filePath} not found`);
          if (fs.statSync(filePath).isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`);
          const contentOld = fs.readFileSync(filePath, 'utf8');
          /* satır sonu stili dosyadan alınır, old/new buna çevrilir (edit.ts:129-131) */
          const ending = detectLineEnding(contentOld);
          const oldN = convertToLineEnding(normalizeLineEndings(oldS), ending);
          const newN = convertToLineEnding(normalizeLineEndings(newS), ending);
          const rep = ocReplace(contentOld, oldN, newN, !!(args.replace_all || args.replaceAll));
          const contentNew = rep.result;
          fs.writeFileSync(filePath, contentNew, 'utf8');
          readCacheDrop(filePath); /* sonraki read_file taze içerik okusun */
          const counts = diffLineCounts(contentOld, contentNew);
          const out = {
            ok: true,
            path: filePath,
            note: 'Edit applied successfully.',
            replacements: rep.replacements,
            ...counts,
          };
          if (ctx.wantDiff) {
            out.diffView = { path: filePath, ...diffRegion(contentOld, contentNew), ...counts };
          }
          return JSON.stringify(out);
        } catch (e) {
          return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
        }
      }
      case 'read_file': {
        /* opencode read.ts BİREBİR port: fuzzy not-found, binary tespiti,
           dizin okuma, `N: içerik` formatı, 2000 satır / 2000 karakter /
           50KB tavanları + opencode devam footer'ları */
        const abs = safeResolve(String(args.path || ''), cwd);
        if (!fs.existsSync(abs)) {
          const sibs = fuzzySiblings(abs);
          const hint = sibs.length ? '\nDid you mean one of these?\n' + sibs.map((s) => `- ${path.join(path.dirname(abs), s)}`).join('\n') : '';
          return JSON.stringify({ ok: false, error: `File not found: ${abs}${hint}` });
        }
        const st = fs.statSync(abs);
        /* DİZİN OKUMA (opencode read.ts dizin modu): localeCompare sıralı,
           klasörler `/` ile, offset/limit sayfalı */
        if (st.isDirectory()) {
          let names = fs
            .readdirSync(abs)
            .sort((a, b) => a.localeCompare(b))
            .map((name) => {
              let isDir = false;
              try { isDir = fs.statSync(path.join(abs, name)).isDirectory(); } catch {}
              return isDir ? name + '/' : name;
            });
          const total = names.length;
          const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
          const limit = Math.min(2000, Math.max(1, Math.floor(Number(args.limit) || 2000)));
          names = names.slice(offset - 1, offset - 1 + limit);
          const note =
            names.length < total
              ? `(Showing ${names.length} of ${total} entries. Use offset parameter to paginate.)`
              : `(End of directory - total ${total} entries)`;
          return JSON.stringify({
            ok: true,
            path: abs,
            type: 'directory',
            totalEntries: total,
            offset,
            truncated: offset - 1 + names.length < total,
            note,
            content: names.join('\n'),
          });
        }
        if (st.size > MAX_FILE_CHARS * 2) {
          return JSON.stringify({ ok: false, error: `file too large (${st.size} bytes)` });
        }
        /* binary tespiti uzantıdan — PDF'e dokunma (Beast'in pdf hattı var) */
        if (BINARY_EXT_RE.test(abs)) {
          return JSON.stringify({ ok: false, error: `Cannot read binary file: ${abs}` });
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
        /* binary tespiti: ilk 4KB'ta NUL / %30+ yazdırılamaz karakter (opencode kuralı) */
        try {
          const fd = fs.openSync(abs, 'r');
          let probe;
          try {
            probe = Buffer.alloc(Math.min(4096, st.size));
            fs.readSync(fd, probe, 0, probe.length, 0);
          } finally {
            fs.closeSync(fd);
          }
          if (looksBinary(probe)) {
            return JSON.stringify({ ok: false, error: `Cannot read binary file: ${abs}` });
          }
        } catch (eProbe) {
          if (eProbe && /Cannot read binary/.test(String(eProbe.message || ''))) throw eProbe;
        }
        let raw;
        try {
          raw = readCacheGet(abs, st);
        } catch {
          raw = fs.readFileSync(abs, 'utf8');
        }
        /* opencode read.ts port: satır numaralı çıktı (`N: içerik`), offset/limit
           penceresi (1-indexed), 2000 satır varsayılan, uzun satır kırpma */
        const allLines = raw.split('\n');
        const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
        const limit = Math.min(2000, Math.max(1, Math.floor(Number(args.limit) || 2000)));
        let slice = allLines
          .slice(offset - 1, offset - 1 + limit)
          .map((l, i) => {
            const line = l.length > 2000 ? l.slice(0, 2000) + '... (line truncated to 2000 chars)' : l;
            return `${offset + i}: ${line}`;
          });
        let truncated = offset - 1 + limit < allLines.length;
        let content = slice.join('\n');
        /* opencode 50KB byte tavanı: aşarsa satır bazında kes + özel footer */
        const MAX_BYTES = 50 * 1024;
        let byteCapped = false;
        if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
          const keep = [];
          let used = 0;
          for (const l of slice) {
            const need = Buffer.byteLength(l, 'utf8') + 1;
            if (used + need > MAX_BYTES) break;
            keep.push(l);
            used += need;
          }
          slice = keep;
          content = keep.join('\n');
          truncated = true;
          byteCapped = keep.length < allLines.length;
        }
        /* opencode read.ts footer'ları: byte-kesme → offset devam; satır-kesme →
           offset devam; aksi → dosya sonu. Model BAŞTAN okuma döngüsüne girmez. */
        let note;
        if (byteCapped && slice.length) {
          note = `(Output capped at 50 KB. Showing lines ${offset}-${offset + slice.length - 1}. Use offset=${offset + slice.length} to continue.)`;
        } else if (truncated && slice.length) {
          note = `(Showing lines ${offset}-${offset + slice.length - 1} of ${allLines.length}. Use offset=${offset + slice.length} to continue.)`;
        } else {
          note = `(End of file - total ${allLines.length} lines)`;
        }
        return JSON.stringify({
          ok: true,
          path: abs,
          totalLines: allLines.length,
          offset,
          truncated,
          note,
          content,
        });
      }
      case 'write_file': {
        /* opencode write.ts port: üzerine yazmadan önce eski içerik alınır,
           sonuçta additions/deletions + UI diffView döner */
        const abs = safeResolve(String(args.path || ''), cwd);
        const content = String(args.content ?? '');
        const existed = fs.existsSync(abs);
        const before = existed && !fs.statSync(abs).isDirectory() ? fs.readFileSync(abs, 'utf8') : '';
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        readCacheDrop(abs); /* sonraki read_file taze içerik okusun */
        const counts = diffLineCounts(before, content);
        const out = { ok: true, path: abs, bytes: Buffer.byteLength(content), ...counts };
        if (ctx.wantDiff) {
          out.diffView = existed
            ? { path: abs, ...diffRegion(before, content), ...counts }
            : { path: abs, before: '', after: capDiffText(content), startLine: 1, ...counts };
        }
        return JSON.stringify(out);
      }
      case 'list_dir': {
        /* opencode read.ts dizin modu kuralı: localeCompare sıralı, klasörler
           `/` ile, 500 giriş tavanı + pagination notu */
        const abs = args.path ? safeResolve(String(args.path), cwd) : cwd;
        if (!fs.existsSync(abs)) return JSON.stringify({ ok: false, error: `File not found: ${abs}` });
        if (!fs.statSync(abs).isDirectory()) return JSON.stringify({ ok: false, error: `Path is a file, not a directory: ${abs}` });
        const all = fs.readdirSync(abs, { withFileTypes: true });
        const total = all.length;
        const entries = all.slice(0, 500);
        const rows = entries.map((e) => {
          try {
            const st = fs.statSync(path.join(abs, e.name));
            return `${e.isDirectory() ? 'd' : '-'} ${String(st.size).padStart(10)} ${e.isDirectory() ? e.name + '/' : e.name}`;
          } catch {
            return `-          ? ${e.name}`;
          }
        });
        rows.sort((a, b) => a.slice(13).localeCompare(b.slice(13)));
        return JSON.stringify({
          ok: true,
          path: abs,
          count: rows.length,
          ...(total > 500 ? { note: `(Showing 500 of ${total} entries. Use read_file with offset to paginate.)` } : {}),
          entries: rows.join('\n'),
        });
      }
      case 'grep': {
        /* opencode grep.ts BİREBİR port: case-sensitive default (rg kuralı),
           100 match limit, gruplu çıktı `<abs>:` + `  Line N: text`,
           2000 karakter satır tavanı + truncation notu */
        const pattern = String(args.pattern || '');
        let re;
        try {
          re = new RegExp(pattern, args.case_insensitive || args.caseInsensitive ? 'i' : '');
        } catch (e) {
          return JSON.stringify({ ok: false, error: 'geçersiz regex: ' + String((e && e.message) || e) });
        }
        const root = args.path ? safeResolve(String(args.path), cwd) : cwd;
        if (!fs.existsSync(root)) return JSON.stringify({ ok: false, error: 'yol bulunamadı: ' + root });
        const incRe = globToRegExp(String(args.include || ''));
        const hits = []; // { file, line, text }
        const MAX_MATCHES = 100;
        walkFiles(root, incRe, (file) => {
          if (hits.length >= MAX_MATCHES) return true; // dur
          let text = '';
          try {
            const st = fs.statSync(file);
            if (st.size > 2 * 1024 * 1024) return false; // dev dosyayı atla
            text = fs.readFileSync(file, 'utf8');
          } catch {
            return false;
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
            if (re.test(lines[i])) {
              const t = lines[i].slice(0, 2000) + (lines[i].length > 2000 ? '...' : '');
              hits.push({ file, line: i + 1, text: t });
            }
          }
          return false;
        });
        /* opencode çıktı formatı: başlık + dosya gruplama + `  Line N: text` */
        const groups = new Map();
        for (const h of hits) {
          if (!groups.has(h.file)) groups.set(h.file, []);
          groups.get(h.file).push(`  Line ${h.line}: ${h.text}`);
        }
        const out = hits.length
          ? `Found ${hits.length} matches` +
            (hits.length >= MAX_MATCHES ? ' (more matches available)' : '') +
            '\n\n' +
            [...groups.entries()].map(([f, rows]) => `${f}:\n${rows.join('\n')}`).join('\n\n')
          : 'No files found';
        return JSON.stringify({
          ok: true,
          pattern,
          count: hits.length,
          capped: hits.length >= MAX_MATCHES,
          ...(hits.length >= MAX_MATCHES ? { note: '(Results truncated. Consider using a more specific path or pattern.)' } : {}),
          matches: out,
        });
      }
      case 'glob': {
        /* opencode glob.ts BİREBİR port: 100 sonuç limiti + truncation notu,
           "No files found", path-dosya hatası */
        const pat = String(args.pattern || '');
        if (!pat.trim()) return JSON.stringify({ ok: false, error: 'pattern boş olamaz' });
        const root = args.path ? safeResolve(String(args.path), cwd) : cwd;
        if (!fs.existsSync(root)) return JSON.stringify({ ok: false, error: 'yol bulunamadı: ' + root });
        if (fs.statSync(root).isFile()) {
          return JSON.stringify({ ok: false, error: `glob path must be a directory: ${root}` });
        }
        const re = globToRegExp(pat);
        const LIMIT = 100;
        const out = [];
        walkFiles(root, null, (file) => {
          const rel = path.relative(root, file).split(path.sep).join('/');
          if (re.test(rel) || re.test(path.basename(file))) {
            out.push(path.join(root, rel));
          }
          return out.length >= LIMIT; // dur
        });
        if (!out.length) return JSON.stringify({ ok: true, pattern: pat, count: 0, files: [], note: 'No files found' });
        return JSON.stringify({
          ok: true,
          pattern: pat,
          count: out.length,
          files: out,
          ...(out.length >= LIMIT ? { note: '(Results are truncated: showing first 100 results. Consider using a more specific path or pattern.)' } : {}),
        });
      }
      case 'web_search': {
        const q = String(args.query || '');
        const n = Number(args.max_results) || 8;
        /* sıralı zincir (obscura/tinyfish/python — dahili tarayıcı engine
           tarafındaki hook'tan gelir); Exa KALDIRILDI */
        const r = await searchChainWeb(q, n, { signal: ctx.signal });
        return JSON.stringify(r);
      }
      case 'deep_search': {
        /* hook'suz bağlamda bile çalışsın: yalnız arama zinciri (sayfa okuma yok).
           Gizli tarayıcı okuması engine.research hook'undan gelir (main process). */
        const r = await research.deepSearch(
          args,
          { search: (q) => searchChainWeb(q, 10, { signal: ctx.signal }) },
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
      case 'http_fetch':
      case 'webfetch': {
        /* opencode webfetch.ts port: format (text|markdown|html) + timeout
           (default 30s, max 120s) — SSRF koruması Beast'te kalır */
        const format = String(args.format || 'text').toLowerCase();
        if (!['text', 'markdown', 'html'].includes(format)) {
          return JSON.stringify({ ok: false, error: 'format: text | markdown | html' });
        }
        const timeoutRaw = Number(args.timeout);
        if (args.timeout != null && (!Number.isFinite(timeoutRaw) || timeoutRaw <= 0)) {
          return JSON.stringify({ ok: false, error: `Invalid timeout value: ${args.timeout}. Timeout must be a positive number.` });
        }
        /* opencode saniye cinsinden bekler; ms gelirse de tolere et */
        let timeoutMs = 30000;
        if (Number.isFinite(timeoutRaw) && timeoutRaw > 0) {
          timeoutMs = Math.min(timeoutRaw <= 120 ? timeoutRaw * 1000 : timeoutRaw, 120000);
        }
        const r = await httpFetch(String(args.url || ''), {
          maxChars: Number(args.max_chars) || MAX_FETCH_CHARS,
          format,
          timeoutMs,
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

/* ---------- Sıralı arama zinciri (Ayarlar → Web Arama'dan değiştirilir) ----------
   Motorlar: browser (dahili Chromium → Google) · obscura (stealth headless →
   DuckDuckGo) · tinyfish (API, anahtar gerekir) · python (ddgs/DDG+Bing+Mojeek).
   Sıra + aç/kapa ayarı settings.json'da (searchChain) saklanır; Obscura
   varsayılan AKTİF. Tarayıcı CAPTCHA/trafik verirse 10 dk atlanır. */
const SEARCH_ENGINE_IDS = ['browser', 'obscura', 'tinyfish', 'python'];
const DEFAULT_SEARCH_CHAIN = SEARCH_ENGINE_IDS.map((id) => ({ id, on: true }));

let _searchChain = DEFAULT_SEARCH_CHAIN.map((x) => ({ ...x }));
let _obscuraEnabled = true; /* Obscura varsayılan AKTİF */
let _browserBanUntil = 0;

function normalizeSearchChain(list) {
  const arr = Array.isArray(list) ? list : [];
  const rows = [];
  const seen = new Set();
  for (const item of arr) {
    const id = String((item && item.id) || item || '').trim();
    if (!SEARCH_ENGINE_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, on: !(item && item.on === false) });
  }
  for (const id of SEARCH_ENGINE_IDS) {
    if (!seen.has(id)) rows.push({ id, on: true }); /* listede eksik motor varsayılan AÇIK */
  }
  /* obscura varsayılan AKTİF; zincir boş kalmasın: hepsi kapalıysa browser'ı aç */
  if (!rows.some((r) => r.on)) {
    const b = rows.find((r) => r.id === 'browser');
    if (b) b.on = true;
  }
  return rows;
}

function setSearchChain(list) {
  _searchChain = normalizeSearchChain(list);
  return _searchChain;
}

function setSearchObscuraEnabled(v) {
  _obscuraEnabled = v !== false;
}

function getSearchChain() {
  return _searchChain.map((x) => ({ ...x }));
}

function browserBanned() {
  return Date.now() < _browserBanUntil;
}

function banBrowser(minutes = 10) {
  _browserBanUntil = Date.now() + minutes * 60 * 1000;
}

/* Zinciri sırayla koştur: her motor boş/hata dönerse sıradakine geç.
   browser motoru yalnız engine'den gelir (hook); araç-bağımsız çağrılarda atlanır. */
async function searchChainWeb(query, maxResults, { signal, browser } = {}) {
  const q = String(query || '').trim().slice(0, 400);
  if (!q) return { ok: false, error: 'boş sorgu' };
  const cap = Math.max(1, Math.min(12, Number(maxResults) || 8));
  let out = null;
  const banned = browserBanned();
  for (const row of _searchChain) {
    if (out && out.ok && (out.results || []).length) break;
    if (!row.on) continue;
    try {
      if (row.id === 'browser') {
        if (typeof browser !== 'function' || banned) continue;
        out = await browser();
        if (!out || !out.ok || !(out.results || []).length) {
          banBrowser(); /* tarayıcı sorunlu — 10 dk atla, alternatifler devrede */
          out = null;
        }
      } else if (row.id === 'obscura') {
        if (!_obscuraEnabled) continue;
        out = await obscura.obscuraSearch(q, { maxResults: cap, signal });
      } else if (row.id === 'tinyfish') {
        out = await tinyfishSearch(q, cap, signal);
      } else if (row.id === 'python') {
        out = await webSearchFast(q, { maxResults: cap, signal });
      }
    } catch {
      out = null;
    }
    if (out && out.ok && !(out.results || []).length) out = null; /* boş → sıradaki motor */
  }
  if (out && out.ok && banned && (out.results || []).length) {
    out.note = 'dahili tarayıcı 10 dk askıda (CAPTCHA/trafik) — alternatif motor kullanıldı';
  }
  return out || { ok: false, error: 'web arama başarısız — tüm motorlar boş döndü' };
}

/* ---------- TinyFish (anahtar girilirse zincirdeki kendi sırasında) ----------
   GET https://api.search.tinyfish.ai?query=...  ·  Header: X-API-Key
   Anahtar yoksa bu motor otomatik atlanır; sıradaki motor devreye girer. */
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
  /* opencode edit.ts portu (test + dış kullanım) */
  ocReplace,
  diffLineCounts,
  diffRegion,
  ocReplacers: {
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  },
  runCommand,
  runShellCommand,
  runBashCommand,
  gitbash,
  disposeShellSessions,
  boundToolOutput,
  globToRegExp,
  walkFiles,
  assertPublicHttpUrl,
  parseDdgResults,
  htmlToText,
  webSearch,
  httpFetch,
  webSearchFast,
  seedScript,
  bundledScriptPath,
  /* arama zinciri (sıra + aç/kapa Ayarlar → Web Arama'dan) */
  SEARCH_ENGINE_IDS,
  DEFAULT_SEARCH_CHAIN,
  setSearchChain,
  setSearchObscuraEnabled,
  getSearchChain,
  searchChainWeb,
  browserBanned,
  banBrowser,
  setTinyfishKey,
  tinyfishSearch,
  /* obscura geçişi */
  obscura,
  /* python altyapısı */
  ensurePython,
  findSystemPython,
  installEmbeddedPython,
  pythonScriptsDir,
  embeddedPythonExe,
  runPy,
};
