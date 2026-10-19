'use strict';

/* Beast DocChat: yerel belge kütüphanesi + semantik arama (mini RAG).
   Kullanıcı bir klasör/dosya işaret eder, Beast TÜM metni verilerine
   ("kütüphane"ye) çeker; sonra "bu belgelerde X ne diyor?" sorusuna
   alıntılı cevaplar için parça parça aranır.

   - Kapsam: PDF (pdf-parse, SAYFA BAZLI) + metin ailesi (txt/md/csv/json/
     yaml/log/html/kod). node_modules/.git/hidden klasörler yok.
   - Chunking: her sayfa ~1400 karakter parçalara bölünür (%12 üst üste binme,
     ~350 token ≈ MiniLM sweet spot).
   - Embedding: mem0'ın paylaşımlı MiniLM embedder'ı (384d) — İKİNCİ model
     yüklenmez; embedder yoksa keyword-only moda düşer.
   - Arama: hibrit 0.65*cosine + 0.35*keyword (mem0 felsefesi). Alıntı:
     dosya + sayfa + skor.
   - Kalıcılık: %APPDATA%\beast\docchat\<library>.json (tek JSON; vektörler b64)
   - Değişiklik algısı: file size+mtime → değişmeyen dosya YENİDEN
     indekslenmez (hızlı inkremental).
   - Kapsam izolasyonu: library adına (projeler) ayrı kütüphane — karışma yok. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const mem0 = require('./mem0');

const DIMS = mem0.DIMS || 384;
const SEARCH_SEM_W = 0.65; // hibrit skor: semantik ağırlık (mem0 ile aynı)
const SEARCH_KW_W = 0.35; // hibrit skor: keyword ağırlık
const CHUNK_CHARS = 1400; // ~350 token
const CHUNK_OVERLAP = 170; // ~%12 üst üste binme — cümle ortası bölünmesin
const MAX_FILES = 600; // güvenlik tavanı (kütüphane kendi kendine şişmesin)
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB / dosya
const MAX_CHUNKS = 12000; // kütüphane tavanı (~600 dosya × 20 parça ortalama)
const EMBED_BATCH = 24; // tek seferde gömülecek parça sayısı
const K_DEFAULT = 5;

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|log|yaml|yml|xml|html|htm|ini|cfg|conf|nfo|srt|ts|js|jsx|mjs|cjs|py|ps1|psm1|bat|cmd|sql|css|c|cpp|h|hpp|cs|java|go|rs|rb|php)$/i;
const PDF_EXT = /\.pdf$/i;
const SKIP_DIR = /(node_modules|^\.git$|^\.svn$|dist$|build$|__pycache__|^\.|venv)/;
const TR_FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

/* ---------- yollar ---------- */

function beastRoot() {
  if (process.env.BEAST_DATA) return process.env.BEAST_DATA;
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, 'beast')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'beast');
}

function libDir() {
  const d = path.join(beastRoot(), 'docchat');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

/* library adı → güvenli dosya adı */
function libSafe(name) {
  const s = String(name || 'main').trim().toLowerCase()
    .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'main';
}

function libPath(name) {
  return path.join(libDir(), libSafe(name) + '.json');
}

/* ---------- yardımcılar ---------- */

function fold(s) {
  return String(s || '').toLowerCase().replace(/[çğıöşüâîû]/g, (ch) => TR_FOLD[ch] || ch);
}

function tokenize(q) {
  return (fold(q).match(/[a-z0-9_+#.]+/g) || []).filter((w) => w.length >= 3);
}

function md5(s) {
  return crypto.createHash('md5').update(String(s || ''), 'utf8').digest('hex');
}

/* vektör cos: BOTH normalize (mem0 normalize=true) → dot = cosine */
function cos(a, b) {
  if (!a || !b) return 0;
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i++) dot += a[i] * b[i];
  return dot; // normalize edilmiş → dot = cosine
}

function vecToB64(v) {
  if (!v) return null;
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

function b64ToVec(s) {
  if (!s) return null;
  try {
    const buf = Buffer.from(String(s), 'base64');
    if (buf.length !== DIMS * 4) return null;
    return new Float32Array(buf.buffer, buf.byteOffset, DIMS);
  } catch {
    return null;
  }
}

/* metin → parçalar (kelime sınırına saygılı bölme + üst üste binme) */
function chunkify(text) {
  const t = String(text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ');
  if (!t.trim()) return [];
  if (t.length <= CHUNK_CHARS) return [t.trim()];
  const chunks = [];
  let i = 0;
  while (i < t.length && chunks.length < MAX_CHUNKS) {
    const end = Math.min(t.length, i + CHUNK_CHARS);
    /* kelime ortasında bölmemek için geriye son boşluk ara (min %60 doluluk) */
    let cut = end;
    if (end < t.length) {
      const ws = t.lastIndexOf(' ', end);
      if (ws > i + CHUNK_CHARS * 0.6) cut = ws;
    }
    const piece = t.slice(i, cut).trim();
    if (piece) chunks.push(piece);
    if (end >= t.length) break;
    i = Math.max(i + 1, cut - CHUNK_OVERLAP);
  }
  return chunks;
}

/* PDF sayfa metinleri — pdf-parse v2 TextResult.pages (num + text) */
async function pdfPages(buf) {
  const { extract } = require('./pdf');
  const r = await extract(buf);
  const pages = Array.isArray(r && r.pages) && r.pages.length
    ? r.pages.map((p) => ({ num: p.num || 0, text: String(p.text || '') }))
    : [{ num: 0, text: String((r && r.text) || '') }];
  return pages.filter((p) => String(p.text).trim());
}

/* ---------- kütüphane ---------- */

function loadLib(name) {
  try {
    const j = JSON.parse(fs.readFileSync(libPath(name), 'utf8'));
    if (!j || !Array.isArray(j.chunks)) throw new Error('şema');
    return j;
  } catch {
    return { files: {}, chunks: [] };
  }
}

function saveLib(name, lib) {
  try {
    fs.writeFileSync(libPath(name), JSON.stringify(lib));
    return true;
  } catch {
    return false;
  }
}

/* klasör/dosya adayları: PDF + metin ailesi */
function walkCandidates(root) {
  const out = [];
  const stack = [{ p: root, depth: 0 }];
  while (stack.length && out.length <= MAX_FILES * 2) {
    const { p, depth } = stack.pop();
    let st = null;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isFile()) {
      if ((PDF_EXT.test(p) || TEXT_EXT.test(p)) && st.size <= MAX_FILE_BYTES) out.push(p);
      continue;
    }
    if (!st.isDirectory() || depth > 6) continue;
    let entries = [];
    try { entries = fs.readdirSync(p); } catch { continue; }
    for (const e of entries) {
      if (e.startsWith('.') || SKIP_DIR.test(e)) continue;
      stack.push({ p: path.join(p, e), depth: depth + 1 });
    }
  }
  return out.slice(0, MAX_FILES);
}

/* tek dosyayı kütüphaneye koy (inkremental: değişmemişse atla) */
async function indexOne(libName, lib, abs, opts = {}) {
  const rel = path.basename(abs);
  const dir = path.dirname(abs);
  if (!(PDF_EXT.test(abs) || TEXT_EXT.test(abs))) {
    return { file: abs, ok: false, error: 'desteklenmeyen tür' };
  }
  let st = null;
  try { st = fs.statSync(abs); } catch { return { file: abs, ok: false, error: 'dosya yok' }; }
  const fingerprint = st.size + ':' + Math.floor((st.mtimeMs || 0) / 1000);
  if (lib.files[abs] && lib.files[abs].fp === fingerprint && !opts.force) {
    return { file: abs, ok: true, skipped: true };
  }
  /* önce eski parçaları sil */
  lib.chunks = lib.chunks.filter((c) => c.file !== abs);

  let pieces = []; // { page, text }
  try {
    if (PDF_EXT.test(abs)) {
      pieces = await pdfPages(fs.readFileSync(abs));
      for (const p of pieces) p.text = String(p.text || '').trim();
      pieces = pieces.filter((p) => p.text);
    } else {
      const txt = fs.readFileSync(abs, 'utf8');
      if (txt.trim()) pieces = [{ page: 0, text: txt }];
    }
  } catch (e) {
    return { file: abs, ok: false, error: 'okuma hatası: ' + String((e && e.message) || e).slice(0, 120) };
  }

  /* sayfa metnini parçala + göm (küçük küçük, embedder yoksa null vektör) */
  const rawChunks = [];
  for (const p of pieces) {
    for (const piece of chunkify(p.text)) rawChunks.push({ page: p.page, text: piece });
  }
  const batches = [];
  for (let i = 0; i < rawChunks.length; i += EMBED_BATCH) batches.push(rawChunks.slice(i, i + EMBED_BATCH));
  let added = 0;
  let embedded = 0;
  for (const batch of batches) {
    const vecs = await mem0.embed(batch.map((c) => c.text));
    for (let i = 0; i < batch.length; i++) {
      if (lib.chunks.length >= MAX_CHUNKS) break;
      const v = vecs && vecs[i];
      if (v) embedded++;
      lib.chunks.push({
        id: md5(libName + abs + batch[i].page + batch[i].text).slice(0, 16),
        file: abs,
        name: rel,
        dir,
        page: batch[i].page || 0,
        text: batch[i].text.slice(0, 8000),
        vec: vecToB64(v || null),
      });
      added++;
    }
  }
  lib.files[abs] = { fp: fingerprint, chunks: added, pages: pieces.length, at: Date.now() };
  return { file: abs, ok: added > 0, chunks: added, embedded };
}

/* ---------- HİBRİT ARAMA ---------- */

async function searchLib(lib, query, k) {
  const qTokens = tokenize(query);
  let qVec = null;
  try {
    const vs = await mem0.embed([String(query)]);
    qVec = vs && vs[0] ? vs[0] : null;
  } catch { qVec = null; }

  const scored = [];
  for (const c of lib.chunks) {
    let score = 0;
    if (qVec) {
      const v = b64ToVec(c.vec);
      score += SEARCH_SEM_W * Math.max(0, cos(qVec, v));
    }
    if (qTokens.length) {
      const hay = fold(c.text);
      let hits = 0;
      for (const t of qTokens) if (hay.includes(t)) hits++;
      score += SEARCH_KW_W * (hits / Math.sqrt(qTokens.length));
    }
    if (score > 0.01) scored.push({ score, chunk: c });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k || K_DEFAULT);
}

/* ~ ve %USERPROFILE% hint'li yol → mutlak yol */
function resolveUserPath(p) {
  let s = String(p || '').trim();
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(os.homedir(), s.slice(2).replace(/^[\\/]+/, ''));
  }
  return path.resolve(s.replace(/%USERPROFILE%/gi, os.homedir()));
}

/* ---------- TOOL ARAYÜZÜ ---------- */

async function handler(args) {
  const action = String(args.action || 'search').toLowerCase();
  const libName = String(args.library || 'main');
  const lib = loadLib(libName);

  if (action === 'index') {
    const p = String(args.path || '').trim();
    if (!p) return { ok: false, error: 'path gerekli — indeklenecek dosya/klasör' };
    const abs = resolveUserPath(p);
    let st = null;
    try { st = fs.statSync(abs); } catch { return { ok: false, error: 'yol bulunamadı: ' + abs }; }
    const targets = st.isDirectory() ? walkCandidates(abs) : [abs];
    if (!targets.length) return { ok: true, library: libName, indexed: 0, skipped: 0, note: 'PDF/metin dosyası bulunamadı' };
    let done = 0;
    let skipped = 0;
    let fail = 0;
    let chunks = 0;
    for (const t of targets) {
      const r = await indexOne(libName, lib, t, { force: !!args.force });
      if (r.ok && r.skipped) skipped++;
      else if (r.ok) { done++; chunks += r.chunks || 0; }
      else fail++;
    }
    if (!saveLib(libName, lib)) {
      /* JSON yazılamadı → bellekteki index hâlâ bu tur için kullanılabilir */
      return { ok: true, persisted: false, library: libName, files: done, skipped, failed: fail, chunks, note: 'index disk yazılamadı (bellekte çalışmaya devam eder)' };
    }
    return {
      ok: true,
      library: libName,
      indexedFiles: done,
      skippedUnchanged: skipped,
      failed: fail,
      newChunks: chunks,
      totalChunks: lib.chunks.length,
      note: done + ' dosya indeklendi. Şimdi "search" ile alıntı alabilirsin.',
    };
  }

  if (action === 'search') {
    const q = String(args.query || '').trim();
    if (!q) return { ok: false, error: 'query gerekli' };
    if (!lib.chunks.length) {
      return { ok: false, error: 'kütüphane boş — önce action:index ile dosya/klasör indexe' };
    }
    const hits = await searchLib(lib, q, Math.min(15, Math.max(1, Number(args.k) || K_DEFAULT)));
    return {
      ok: true,
      library: libName,
      query: q,
      totalChunks: lib.chunks.length,
      results: hits.map((h) => ({
        citation: (h.chunk.name || h.chunk.file) + (h.chunk.page ? ' (s.' + h.chunk.page + ')' : ''),
        file: h.chunk.file,
        page: h.chunk.page || undefined,
        score: Math.round(h.score * 1000) / 1000,
        text: h.chunk.text.slice(0, 1200),
      })),
    };
  }

  if (action === 'list') {
    const files = Object.entries(lib.files).map(([f, meta]) => ({
      file: f,
      chunks: meta.chunks,
      pages: meta.pages || undefined,
      indexedAt: meta.at,
    }));
    return { ok: true, library: libName, files: files.length, chunks: lib.chunks.length, index: files };
  }

  if (action === 'remove') {
    const abs = args.path ? resolveUserPath(args.path) : '';
    if (!abs) return { ok: false, error: 'path gerekli (remove)' };
    const before = lib.chunks.length;
    lib.chunks = lib.chunks.filter((c) => c.file !== abs && c.name !== path.basename(abs));
    let removed = 0;
    if (lib.files[abs]) {
      removed = lib.files[abs].chunks || 0;
      delete lib.files[abs];
    }
    removed += before - lib.chunks.length;
    saveLib(libName, lib);
    return { ok: true, library: libName, removed, remainingFiles: Object.keys(lib.files).length, remainingChunks: lib.chunks.length };
  }

  if (action === 'clear') {
    saveLib(libName, { files: {}, chunks: [] });
    return { ok: true, library: libName, cleared: true };
  }

  return { ok: false, error: 'bilinmeyen action: ' + action + ' (index | search | list | remove | clear)' };
}

/* ---------- TOOL TANIMLARI (gittools deseninde) ---------- */

const definitions = [
  {
    type: 'function',
    function: {
      name: 'doc_chat',
      description:
        'Search a LOCAL document library built from user-chosen folders/files (mini RAG with citations).\n' +
        'Actions:\n' +
        '- `index` { path: folder-or-file, library?, force? } → walks the folder for PDF + text/code files, extracts per-page text, chunks it and embeds locally (MiniLM). Unchanged files are skipped automatically (incremental).\n' +
        '- `search` { query, library?, k? } → hybrid semantic+keyword answer chunks WITH citations (file + page + score). Call after indexing; use the cited snippets to answer questions about the documents.\n' +
        '- `list` { library? } → indexed files and chunk counts.\n' +
        '- `remove` { path, library? } / `clear` { library? } → drop one file or the whole library.\n' +
        'ALL processing is local — no cloud. If the user says "bu klasördeki PDFlerde ara", index that folder first, then search with their question.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'index | search | list | remove | clear (default search)' },
          path: { type: 'string', description: 'Folder or file to index / remove (supports ~ and %USERPROFILE%)' },
          query: { type: 'string', description: 'Natural-language question for search' },
          library: { type: 'string', description: 'Library name to scope the index (default "main")' },
          k: { type: 'number', description: 'Top-K results (default 5, max 15)' },
          force: { type: 'boolean', description: 'Re-index unchanged files too (default: incremental)' },
        },
        required: ['action'],
      },
    },
  },
];

module.exports = {
  definitions,
  handlers: {
    doc_chat: handler,
  },
  /* test + dış kullanım */
  chunkify,
  tokenize,
  walkCandidates,
  searchLib,
  indexOne,
  loadLib,
  saveLib,
  libPath,
  cos,
};
