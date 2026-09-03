'use strict';

/* mem0-native: mem0 mimarisinin (github.com/mem0ai/mem0) Beast'e uyarlanmış
   Node çekirdeği. Python/mem0-ts BAĞIMLILIĞI YOK:
     - Vektör: @xenova/transformers (whisper için zaten var) → all-MiniLM-L6-v2 (384d)
     - Store: JSON dosya per scope → bot başına AYRI dosya = tam izolasyon
     - Konsolidasyon: mem0 klasik update prompt'u → ADD / UPDATE / DELETE / NONE
     - Audit: JSONL geçmiş (mem0 history.db karşılığı)
     - Hibrit arama: 0.65*semantic(cosine) + 0.35*keyword (mem0 semantic+BM25 felsefesi)
   Her fonksiyon degradasyonlu: embedding yoksa keyword, LLM yoksa hash+cos dedup.
   Scope: 'main' | 'bot:<botId>' — botlar arasında ASLA çapraz erişim yok. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CAP = 400; // scope başına maksimum kayıt (memory.js cap ile aynı)
const DIMS = 384; // all-MiniLM-L6-v2
const SEMANTIC_SKIP = 0.93; // add fast-path: bu cosine üstü aynı bilgi sayılır
const CAND_THRESHOLD = 0.3; // konsolidasyon adayı için min cosine
const CAND_K = 6; // fact başına çekilecek benzer aday
const SEARCH_SEM_W = 0.65; // hibrit skor: semantik ağırlık
const SEARCH_KW_W = 0.35; // hibrit skor: keyword ağırlık
const LOAD_TIMEOUT_MS = 10000; // embed modeli ilk yüklemeye bu süreyi bekler, sonra vektörsüz devam

/* ---------- yollar ---------- */

function beastRoot() {
  if (process.env.BEAST_DATA) return process.env.BEAST_DATA;
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, 'beast')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'beast');
}

function mem0Dir() {
  const d = path.join(beastRoot(), 'memories', 'mem0');
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

/* scope → güvenli dosya adı ('bot:ahmet-42' → 'bot-ahmet-42') */
function fileSafe(scope) {
  return String(scope || 'main').replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function storePath(scope) {
  return path.join(mem0Dir(), fileSafe(scope) + '.json');
}

function logPath(scope) {
  return path.join(mem0Dir(), fileSafe(scope) + '.log');
}

/* ---------- metin skorlama (memory.js ile aynı klasikler — öz-bağımsız) ---------- */

const TR_FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

function fold(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[çğıöşüâîû]/g, (ch) => TR_FOLD[ch] || ch);
}

function tokenize(q) {
  return (fold(q).match(/[a-z0-9_+#.]+/g) || []).filter((w) => w.length >= 3);
}

function normText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function md5(s) {
  return crypto.createHash('md5').update(String(s || ''), 'utf8').digest('hex');
}

function scoreEntry(entryText, qTokens) {
  if (!qTokens.length) return 0;
  const hay = fold(entryText);
  let hits = 0;
  for (const t of new Set(qTokens)) if (hay.includes(t)) hits++;
  return hits / Math.sqrt(qTokens.length);
}

/* ---------- vektör sağlayıcı ---------- */

let _embedFn = null; // test enjeksiyonu
let _pipe = null;
let _pipeLoading = null;
let _pipeBroken = false;

/** Test/ar-ge: harici embedder tak (async (texts) => Float32Array[] | null) */
function setEmbedder(fn) {
  _embedFn = typeof fn === 'function' ? fn : null;
}

function loadPipeline() {
  if (_pipe) return Promise.resolve(_pipe);
  if (_pipeLoading) return _pipeLoading;
  if (_pipeBroken) return Promise.resolve(null);
  _pipeLoading = (async () => {
    try {
      const { pipeline, env } = require('@xenova/transformers');
      const modelsDir = process.env.BEAST_MODELS_DIR || path.join(beastRoot(), 'models');
      fs.mkdirSync(modelsDir, { recursive: true });
      env.cacheDir = modelsDir;
      env.allowLocalModels = false;
      const p = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
      _pipe = async (texts) => {
        const out = [];
        for (const t of texts) {
          const tensor = await p(t, { pooling: 'mean', normalize: true });
          const arr = new Float32Array(DIMS);
          const data = tensor.data;
          for (let i = 0; i < DIMS && i < data.length; i++) arr[i] = data[i];
          out.push(arr);
        }
        return out;
      };
      return _pipe;
    } catch {
      _pipeBroken = true; // bir daha deneme — keyword-only moda düş
      return null;
    } finally {
      _pipeLoading = null;
    }
  })();
  return _pipeLoading;
}

/* embedder hazırsa döner; ilk yükleme LOAD_TIMEOUT_MS'ı geçerse null (vektörsüz devam) */
async function getEmbedder() {
  if (_embedFn) return _embedFn;
  const p = loadPipeline();
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res(null), LOAD_TIMEOUT_MS); });
  const loaded = await Promise.race([p, timeout]).catch(() => null);
  clearTimeout(timer);
  return loaded || null;
}

async function embed(texts) {
  const fn = await getEmbedder();
  if (!fn) return texts.map(() => null);
  try {
    const vecs = await fn(texts);
    if (!Array.isArray(vecs) || vecs.length !== texts.length) return texts.map(() => null);
    return vecs.map((v) => (v instanceof Float32Array && v.length === DIMS ? v : null));
  } catch {
    return texts.map(() => null);
  }
}

function cos(a, b) {
  if (!a || !b) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // normalize vektörler → dot = cosine
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

/* ---------- store ---------- */

/* mevcut ayna dosyasından satırlar (MEMORY.md) — boot import + admin düzenleme sonrası */
function mirrorLines(scope) {
  try {
    let p = null;
    if (scope === 'main') p = path.join(beastRoot(), 'memories', 'MEMORY.md');
    else if (scope.startsWith('bot:')) {
      const bots = require('./bots');
      p = bots.memPath(scope.slice(4));
    }
    if (!p) return [];
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => l.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function loadStore(scope) {
  try {
    const raw = fs.readFileSync(storePath(scope), 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.items)) return data;
  } catch {}
  /* store dosyası yok → mevcut MEMORY.md satırlarından import (vektörsüz, backfill sonra) */
  const items = mirrorLines(scope).map((text) => ({
    id: crypto.randomUUID(),
    text: normText(text),
    hash: md5(normText(text)),
    vec: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
  return { version: 1, items };
}

function saveStore(scope, store) {
  try {
    fs.writeFileSync(storePath(scope), JSON.stringify(store), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/* audit günlüğü (mem0 history.db karşılığı — JSONL) */
function audit(scope, entry) {
  try {
    fs.appendFileSync(logPath(scope), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

function history(scope, limit = 50) {
  try {
    const rows = fs
      .readFileSync(logPath(scope), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
    return rows.slice(-limit).reverse();
  } catch {
    return [];
  }
}

/* MEMORY.md aynasını store'dan yeniden yaz (store = doğruluk kaynağı) */
function syncMirror(scope) {
  try {
    const store = loadStore(scope);
    const body = store.items.map((it) => '- ' + it.text).join('\n') + (store.items.length ? '\n' : '');
    let p = null;
    if (scope === 'main') {
      const memory = require('./memory');
      p = path.join(memory.memDir(), 'MEMORY.md');
    } else if (scope.startsWith('bot:')) {
      const bots = require('./bots');
      p = bots.memPath(scope.slice(4));
    }
    if (!p) return false;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/* admin/UI MEMORY.md'yi elle değiştirdiyse store'u satırlardan yeniden kur */
function reindexFromLines(scope, lines) {
  const items = (Array.isArray(lines) ? lines : [])
    .map((t) => normText(t))
    .filter(Boolean)
    .map((text) => ({
      id: crypto.randomUUID(),
      text,
      hash: md5(text),
      vec: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
  const store = { version: 1, items };
  saveStore(scope, store);
  audit(scope, { event: 'IMPORT', count: items.length });
  scheduleBackfill(scope);
  return { ok: true, count: items.length };
}

/* ---------- arka plan vektör doldurma ---------- */

const _backfillRunning = new Set();

function scheduleBackfill(scope) {
  if (_backfillRunning.has(scope)) return;
  _backfillRunning.add(scope);
  setTimeout(() => {
    _backfill(scope)
      .catch(() => {})
      .finally(() => _backfillRunning.delete(scope));
  }, 1200).unref();
}

async function _backfill(scope) {
  const fn = await getEmbedder();
  if (!fn) return;
  const store = loadStore(scope);
  const todo = store.items.filter((it) => !it.vec).slice(0, 64);
  if (!todo.length) return;
  const texts = todo.map((it) => it.text);
  const vecs = await embed(texts);
  todo.forEach((it, i) => {
    if (vecs[i]) it.vec = vecToB64(vecs[i]);
  });
  saveStore(scope, store);
  if (store.items.some((it) => !it.vec)) scheduleBackfill(scope);
}

/* ---------- mem0 klasik konsolidasyon ---------- */

/* mem0 update prompt'u: yeni fact + benzer mevcut kayıtlar → tek LLM karar çağrısı.
   ID'ler indeks ("0","1",...) — LLM'in UUID halüsinasyonuna karşı (mem0 anti-hallucination). */
function buildUpdatePrompt(facts, candidates) {
  const sys =
    'Sen bir uzun vadeli hafıza yöneticisisin. Yeni bilgi (fact) ile mevcut kayıtları karşılaştırıp ' +
    'her fact için TEK karar ver. KURALLAR:\n' +
    '1. ADD: hafızada olmayan yeni bilgi → {"event":"ADD","text":"<fact>"}\n' +
    '2. UPDATE: mevcut kayıtla AYNI konu ama bilgi değişmiş/güncellenmiş → ' +
    '{"event":"UPDATE","id":"<kayıt-no>","text":"<en kapsamlı güncel hali>"}\n' +
    '3. DELETE: fact mevcut kayıtla ÇELİŞİYOR ve kayıt artık yanlışsa → {"event":"DELETE","id":"<kayıt-no>"}\n' +
    '4. NONE: fact zaten mevcut kayıtta var (anlamca aynı) → {"event":"NONE"}\n' +
    'Sadece kalıcı değeri olan bilgiler; geçici detay için NONE yerine ADD yapma — ' +
    'gereksizse {"event":"DROP"} dön. Çıktı: SADECE JSON {"events":[...]} — fact sırasıyla.';
  const candList = candidates
    .map((c, i) => `{"id":"${i}","text":${JSON.stringify(c.item.text)}}`)
    .join('\n');
  const factList = facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
  const user =
    'MEVCUT KAYITLAR:\n' + (candList || '(boş)') + '\n\n' +
    'YENİ BİLGİLER:\n' + factList + '\n\n' +
    'Her yeni bilgi için sırayla karar ver. SADECE JSON dön: {"events":[{"event":"ADD","text":"..."},{"event":"UPDATE","id":"3","text":"..."},{"event":"DELETE","id":"2"},{"event":"NONE"},{"event":"DROP"}]}';
  return { sys, user };
}

function parseEvents(raw, candidateCount, factCount) {
  try {
    const parsed = JSON.parse(String(raw || '').replace(/```(?:json)?|```/g, '').trim());
    const events = Array.isArray(parsed.events) ? parsed.events : [];
    /* fact başına 1 karar kuralı; ama DELETE+ADD "değiştirme" ikilisi meşru — pay bırak */
    return events.slice(0, factCount + 2).filter((e) => e && typeof e === 'object');
  } catch {
    return null; // parse edilemedi → fast-path fallback
  }
}

/* idx ("3") → gerçek item id (anti-hallucination: harici eşleme) */
function resolveCandidate(candidates, idStr) {
  const n = Number(String(idStr).replace(/[^0-9]/g, ''));
  if (!Number.isInteger(n) || n < 0 || n >= candidates.length) return null;
  return candidates[n];
}

/* ---------- public API ---------- */

/** Kayıt ekleme (mem0 add). llm verilirse klasik konsolidasyon, yoksa hash+cos dedup. */
async function add(scope, texts, { llm } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts])
    .map((t) => normText(t))
    .filter(Boolean)
    .slice(0, 8);
  if (!list.length) return { ok: false, error: 'empty' };
  const store = loadStore(scope);
  const newVecs = await embed(list);

  const findCandidates = () => {
    /* tüm yeni fact'lerin adaylarının birleşimi (mem0: per-fact retrieval → tek karar çağrısı) */
    const best = new Map(); // item.id → { item, score }
    for (const t of list) {
      const tokens = tokenize(t);
      for (let i = 0; i < list.length; i++) {
        const qvec = newVecs[i];
        for (const item of store.items) {
          const ivec = b64ToVec(item.vec);
          const sem = qvec && ivec ? cos(qvec, ivec) : 0;
          const kw = scoreEntry(item.text, tokens);
          const score = Math.max(sem, kw);
          if (score < CAND_THRESHOLD) continue;
          const prev = best.get(item.id);
          if (!prev || prev.score < score) best.set(item.id, { item, score });
        }
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, CAND_K * list.length);
  };

  const applyAdd = (text, vec) => {
    const now = new Date().toISOString();
    store.items.push({
      id: crypto.randomUUID(),
      text,
      hash: md5(text),
      vec: vec ? vecToB64(vec) : null,
      created_at: now,
      updated_at: now,
    });
    audit(scope, { event: 'ADD', text });
    return { event: 'ADD', text };
  };
  const applyUpdate = (item, text, vec) => {
    const old = item.text;
    item.text = text;
    item.hash = md5(text);
    if (vec) item.vec = vecToB64(vec);
    else item.vec = null;
    item.updated_at = new Date().toISOString();
    audit(scope, { event: 'UPDATE', id: item.id, old_text: old, text });
    return { event: 'UPDATE', id: item.id, text };
  };
  const applyDelete = (item) => {
    store.items = store.items.filter((it) => it.id !== item.id);
    audit(scope, { event: 'DELETE', id: item.id, old_text: item.text });
    return { event: 'DELETE', id: item.id };
  };

  const applied = [];
  let usedLlm = false;

  if (typeof llm === 'function') {
    try {
      const candidates = findCandidates();
      const { sys, user } = buildUpdatePrompt(list, candidates);
      const raw = await llm(sys, user);
      const events = parseEvents(raw, candidates.length, list.length);
      if (events) {
        usedLlm = true;
        for (const ev of events) {
          const evName = String(ev.event || '').toUpperCase();
          const cand = ev.id != null ? resolveCandidate(candidates, ev.id) : null;
          if (evName === 'ADD' && ev.text) {
            const t = normText(ev.text);
            if (store.items.some((it) => it.hash === md5(t))) continue;
            applied.push(applyAdd(t, null)); /* vektör backfill'de */
          } else if (evName === 'UPDATE' && cand && ev.text) {
            applied.push(applyUpdate(cand.item, normText(ev.text), null));
          } else if (evName === 'DELETE' && cand) {
            applied.push(applyDelete(cand.item));
          } else if (evName === 'NONE' || evName === 'DROP') {
            applied.push({ event: evName === 'DROP' ? 'DROP' : 'NONE' });
          }
        }
      }
    } catch {}
  }

  if (!usedLlm) {
    /* fast-path: hash dup → skip; SEMANTIC_SKIP üstü cosine → skip; yoksa ADD */
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const vec = newVecs[i];
      if (store.items.some((it) => it.hash === md5(t))) {
        applied.push({ event: 'NONE', text: t });
        continue;
      }
      let twin = false;
      if (vec) {
        for (const it of store.items) {
          const ivec = b64ToVec(it.vec);
          if (ivec && cos(vec, ivec) >= SEMANTIC_SKIP) { twin = true; break; }
        }
      }
      if (twin) {
        applied.push({ event: 'NONE', text: t });
        continue;
      }
      applied.push(applyAdd(t, vec));
    }
  }

  /* cap aşımı: en eskilerden düş */
  if (store.items.length > CAP) {
    const overflow = store.items.length - CAP;
    const dropped = store.items.splice(0, overflow);
    for (const d of dropped) audit(scope, { event: 'CAP_DROP', id: d.id, old_text: d.text });
  }

  saveStore(scope, store);
  scheduleBackfill(scope);
  return {
    ok: true,
    llm: usedLlm,
    added: applied.filter((e) => e.event === 'ADD').length,
    updated: applied.filter((e) => e.event === 'UPDATE').length,
    deleted: applied.filter((e) => e.event === 'DELETE').length,
    skipped: applied.filter((e) => e.event === 'NONE' || e.event === 'DROP').length,
    events: applied,
  };
}

/** Hibrit arama: 0.65*cosine + 0.35*keyword; vektör yoksa pure keyword (degradasyon). */
async function search(scope, query, { limit = 8, threshold = 0.05 } = {}) {
  const q = String(query || '').trim();
  const store = loadStore(scope);
  if (!store.items.length || !q) return [];
  const qTokens = tokenize(q);
  const qvec = (await embed([q]))[0];
  const rows = store.items.map((item) => {
    const ivec = b64ToVec(item.vec);
    const sem = qvec && ivec ? Math.max(0, cos(qvec, ivec)) : 0;
    const kw = scoreEntry(item.text, qTokens);
    const score = qvec && ivec
      ? SEARCH_SEM_W * sem + SEARCH_KW_W * kw
      : kw;
    return { id: item.id, text: item.text, score: Number(score.toFixed(3)), updated_at: item.updated_at };
  });
  return rows
    .filter((r) => r.score > threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Prompt için ilgili kayıtlar ('- ' satırları; memory.relevantFor uyumlu çıktı). */
async function relevant(scope, query, { maxRelevant = 6, maxRecent = 4, charCap = 2400 } = {}) {
  const store = loadStore(scope);
  if (!store.items.length) return '';
  const picked = new Set();
  try {
    const hits = await search(scope, query, { limit: maxRelevant, threshold: 0.05 });
    for (const h of hits) picked.add(h.id);
  } catch {}
  /* en yeniler de daima girer (memory.relevantFor davranışı) */
  for (let i = store.items.length - 1; i >= 0 && picked.size < maxRelevant + maxRecent; i--) {
    picked.add(store.items[i].id);
  }
  /* çıktı: insertion sırası korunur (ayna dosyasıyla tutarlı) */
  let out = '';
  for (const it of store.items) {
    if (!picked.has(it.id)) continue;
    const line = '- ' + it.text;
    if (out.length + line.length > charCap) break;
    out += (out ? '\n' : '') + line;
  }
  return out;
}

function recentTexts(scope, n = 30) {
  try {
    return loadStore(scope).items.slice(-n).map((it) => it.text);
  } catch {
    return [];
  }
}

function stats(scope) {
  const store = loadStore(scope);
  return {
    scope: String(scope),
    items: store.items.length,
    withVec: store.items.filter((it) => it.vec).length,
    cap: CAP,
  };
}

/** mem0 FACT_RETRIEVAL (TR uyarlaması): sohbetten kalıcı fact'ler çıkarır. */
async function extractFacts(llm, transcript, existing, { max = 3 } = {}) {
  if (typeof llm !== 'function') return [];
  const sys =
    'Aşağıdaki konuşma parçasından UZUN VADELİ hatırlanmaya değer bilgileri çıkar ' +
    '(kullanıcının kalıcı tercihleri, projeleri/işleri, isimler, rutinler, düzeltmeler).\n' +
    'KURALLAR:\n' +
    `- Sadece haftalar sonra bile işe yarayacak şeyler; geçici detay asla\n` +
    `- En fazla ${max} madde, her biri max 120 karakter, "kullanıcı ..." diye başla\n` +
    '- ZATEN KAYITLI olanlarla anlamca aynıysa tekrar ekleme\n' +
    '- Değerli bilgi yoksa boş dizi\n' +
    'SADECE JSON dön: {"memories": ["...", "..."]} veya {"memories": []}';
  const user =
    'ZATEN KAYITLI olanlar (tekrar ekleme):\n' + (existing || '(boş)') + '\n\n' +
    '# SOHBET\n' + transcript;
  try {
    const raw = await llm(sys, user);
    const parsed = JSON.parse(String(raw || '').replace(/```(?:json)?|```/g, '').trim());
    const arr = parsed && Array.isArray(parsed.memories) ? parsed.memories : [];
    return arr.map((m) => normText(m)).filter(Boolean).slice(0, max);
  } catch {
    return [];
  }
}

module.exports = {
  add,
  search,
  relevant,
  recentTexts,
  extractFacts,
  syncMirror,
  reindexFromLines,
  history,
  stats,
  setEmbedder,
  mirrorLines,
  CAP,
  DIMS,
  SEMANTIC_SKIP,
  CAND_THRESHOLD,
};
