'use strict';

/* Hafif repo haritası / sembol arama — "hangi fonksiyon nerede" sorusuna
   LSP kurmadan cevap verir. Satır-bazlı regex çıkarımı: js/ts/jsx/tsx,
   python, go, rust, c/cpp, c#/java/kt, php, ruby, swift.
   Ağır klasörler (node_modules, .git, dist…) tools.js SKIP_DIRS ile aynı
   mantıkta burada da atlanır. */

const path = require('path');
const fs = require('fs');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.cache',
  'vendor', 'target', 'bin', 'obj', '.idea', '.vscode',
]);

const MAX_FILE_BYTES = 600 * 1024;

/* satır → { kind, name } listesi; kind: function | class | method */
const RULES = [
  {
    ext: /\.(m?js|cjs|jsx|tsx?|mts|cts)$/i,
    lines: [
      [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
      [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
      [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
      [/^\s+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/, 'method'],
    ],
    methodKw: /^(if|for|while|switch|catch|function|return|else|do|new|typeof|delete|void|await|yield|super|try)$/,
  },
  {
    ext: /\.py$/i,
    lines: [
      [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function'],
      [/^\s*class\s+([A-Za-z_]\w*)/, 'class'],
    ],
  },
  {
    ext: /\.go$/i,
    lines: [
      [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'function'],
      [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, 'class'],
    ],
  },
  {
    ext: /\.rs$/i,
    lines: [
      [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, 'function'],
      [/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/, 'class'],
    ],
  },
  {
    ext: /\.(c|h|cpp|hpp|cc|hh)$/i,
    lines: [
      [/^[A-Za-z_][\w\s\*&:<>]*?\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{\s*$/, 'function'],
      [/^\s*(?:class|struct)\s+([A-Za-z_]\w*)/, 'class'],
    ],
  },
  {
    ext: /\.(cs|java|kt|kts|swift|scala)$/i,
    lines: [
      [/^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|override|data|open|case)\s+)*(?:class|interface|enum|record|object)\s+([A-Za-z_]\w*)/, 'class'],
      [/^\s*(?:(?:public|private|protected|internal|static|async|override)\s+)+[\w<>\[\],\s]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/, 'method'],
    ],
  },
  {
    ext: /\.php$/i,
    lines: [
      [/^\s*(?:abstract\s+)?class\s+([A-Za-z_]\w*)/i, 'class'],
      [/^\s*(?:(?:public|private|protected|static)\s+)*function\s+([A-Za-z_]\w*)/i, 'function'],
    ],
  },
  {
    ext: /\.rb$/i,
    lines: [
      [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, 'function'],
      [/^\s*(?:class|module)\s+([A-Z]\w*)/, 'class'],
    ],
  },
];

function rulesFor(file) {
  for (const r of RULES) if (r.ext.test(file)) return r;
  return null;
}

/* tek dosyadan sembolleri çıkar: [{ line, kind, name }] */
function extractSymbols(file, src) {
  const rule = rulesFor(file);
  if (!rule) return [];
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length && i < 20000; i++) {
    const line = lines[i];
    if (line.length > 500) continue;
    for (const [re, kind] of rule.lines) {
      const m = line.match(re);
      if (!m) continue;
      const name = m[1];
      if (rule.methodKw && rule.methodKw.test(name)) break; /* if/for/while... yakalama */
      out.push({ line: i + 1, kind: kind === 'method' ? 'method' : kind, name });
      break;
    }
  }
  return out;
}

/* dizin yürüyüşü (kod dosyaları) — walkFiles'tan bağımsız: SKIP_DIRS +
   gizli klasör atlar, dosya sayısı tavanlı */
function walk(root, cb, state, depth = 0) {
  if (depth > 20) return;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (state.files >= state.maxFiles) return;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
      walk(full, cb, state, depth + 1);
    } else if (e.isFile()) {
      if (!rulesFor(e.name)) continue;
      state.files++;
      cb(full);
    }
  }
}

function readSymbols(full) {
  try {
    const st = fs.statSync(full);
    if (st.size > MAX_FILE_BYTES) return [];
    return extractSymbols(full, fs.readFileSync(full, 'utf8'));
  } catch {
    return [];
  }
}

/* ---------- repo_symbols ---------- */
async function repoSymbols(args, ctx) {
  const root = path.resolve(String((ctx && ctx.cwd) || '.'), String(args.path || '.'));
  if (!fs.existsSync(root)) return { ok: false, error: 'yol bulunamadı: ' + root };
  const query = String(args.query || '').trim();
  let re = null;
  if (/^\/.+\/[a-z]*$/i.test(query)) {
    try { re = new RegExp(query.slice(1, query.lastIndexOf('/')), query.slice(query.lastIndexOf('/') + 1)); } catch {}
  }
  const needle = query.toLowerCase();
  const kindF = ['function', 'class', 'method'].includes(String(args.kind)) ? String(args.kind) : null;
  const limit = Math.min(500, Math.max(1, Math.floor(Number(args.limit) || 100)));

  const state = { files: 0, maxFiles: 4000 };
  const hits = [];
  let scanned = 0;
  walk(root, (full) => {
    scanned++;
    const syms = readSymbols(full);
    for (const s of syms) {
      if (kindF && s.kind !== kindF) continue;
      if (query) {
        const match = re ? re.test(s.name) : s.name.toLowerCase().includes(needle);
        if (!match) continue;
      }
      hits.push({ file: path.relative(root, full).replace(/\\/g, '/'), line: s.line, kind: s.kind, name: s.name });
    }
  }, state);
  hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return {
    ok: true,
    ...(query ? { query } : {}),
    root: path.basename(root) || root,
    scannedFiles: scanned,
    total: hits.length,
    results: hits.slice(0, limit),
    ...(hits.length > limit ? { note: `ilk ${limit} sonuç — limit'i artır ya da query daralt` } : {}),
    ...(!hits.length && !query ? { note: 'query ver: fonksiyon/sınıf adı, "login" gibi ya da /regex/ biçiminde' } : {}),
  };
}

/* ---------- repo_map ---------- */
async function repoMap(args, ctx) {
  const root = path.resolve(String((ctx && ctx.cwd) || '.'), String(args.path || '.'));
  if (!fs.existsSync(root)) return { ok: false, error: 'yol bulunamadı: ' + root };
  const maxFiles = Math.min(2000, Math.max(10, Math.floor(Number(args.max_files) || 300)));
  const perFile = Math.min(30, Math.max(1, Math.floor(Number(args.max_symbols_per_file) || 10)));

  const state = { files: 0, maxFiles };
  const entries = [];
  let truncated = false;
  walk(root, (full) => {
    if (entries.length >= maxFiles) {
      truncated = true;
      return;
    }
    const syms = readSymbols(full);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (!syms.length) {
      entries.push({ file: rel, symbols: [] });
      return;
    }
    const groups = { class: [], function: [], method: [] };
    for (const s of syms) {
      if (groups[s.kind] && groups[s.kind].length < perFile) groups[s.kind].push(s.name);
    }
    entries.push({
      file: rel,
      symbols: [
        ...groups.class.map((n) => 'class ' + n),
        ...groups.function.map((n) => n + '()'),
        ...(groups.method.length ? [groups.method.length + ' method'] : []),
      ],
      ...(syms.length > perFile * 2 ? { more: syms.length - perFile } : {}),
    });
  }, state);
  entries.sort((a, b) => (a.file < b.file ? -1 : 1));
  return {
    ok: true,
    root: path.basename(root) || root,
    totalFiles: entries.length,
    ...(truncated ? { truncated: true, note: `max_files=${maxFiles} — daha büyük harita için artır` } : {}),
    files: entries,
  };
}

const definitions = [
  {
    type: 'function',
    function: {
      name: 'repo_map',
      description:
        'Lightweight repo overview (no LSP): walks code files and lists each file with its top-level symbols (classes, functions). Use to orient yourself in an unfamiliar project or to pick the right file before reading it. Heavy dirs (node_modules, dist, .git…) are skipped.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo/subdirectory root (default: workspace)' },
          max_files: { type: 'number', description: 'Max files in the map (default 300, max 2000)' },
          max_symbols_per_file: { type: 'number', description: 'Max symbols listed per file (default 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'repo_symbols',
      description:
        'Find where a function/class/method is DEFINED across the repo (lightweight LSP). Query matches symbol names case-insensitively; "/regex/" form is also accepted. Returns file:line locations. Much cheaper than grep when looking for definitions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Symbol name substring, or /regex/ — empty lists everything (capped)' },
          kind: { type: 'string', enum: ['function', 'class', 'method'], description: 'Filter by symbol kind' },
          path: { type: 'string', description: 'Repo/subdirectory root (default: workspace)' },
          limit: { type: 'number', description: 'Max results (default 100, max 500)' },
        },
      },
    },
  },
];

module.exports = { definitions, handlers: { repo_map: repoMap, repo_symbols: repoSymbols }, extractSymbols, rulesFor };
