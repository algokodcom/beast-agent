'use strict';

/* ---------- Supermemory (lokal) adaptörü ----------
   Beast'in bellek katmanına supermemory (git.new/memory) köprüsü — mem0.js
   deseniyle TAKILABİLİR katman: sunucu (npx supermemory local → localhost:6767)
   ayaktayken daha akıllı bellek (graf motoru, otomatik unutma, çelişki
   çözümü, kullanıcı profili); ayakta değilken engine mevcut hafızaya sorunsuz
   düşer. Zero npm bağımlılık — Node 18+ global fetch.

   Uçlar (supermemory docs birebir):
     POST /v3/documents  { content, containerTag, customId?, metadata? }
     POST /v4/search     { q, containerTag, searchMode, limit, include? }
     POST /v4/profile    { containerTag, q? }
   Auth: Authorization: Bearer <apiKey> (local key ilk boot'ta basılır) */

const BASE_TIMEOUT_MS = 8000;
const PROBE_TIMEOUT_MS = 2500;
const HEALTH_COOLDOWN_MS = 60000; // kapalıya aynı dakikada 200 kez vurma

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

async function call(baseUrl, apiKey, path, body, timeoutMs) {
  const base = normalizeBase(baseUrl);
  if (!base) throw new Error('supermemory baseUrl boş');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || BASE_TIMEOUT_MS);
  try {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: 'Bearer ' + apiKey } : {}),
      },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + (txt ? ': ' + txt.slice(0, 180) : ''));
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* Sunucu ayakta mı? GET / ile ucuz sağlık kontrolü */
async function probe(baseUrl, apiKey) {
  const base = normalizeBase(baseUrl);
  if (!base) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(base, {
      method: 'GET',
      headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {},
      signal: ctrl.signal,
    });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* Konuşma/belgi yut — arka planda çağrılır (fire-and-forget desenine uygun) */
async function add(baseUrl, apiKey, { content, containerTag, customId, metadata }) {
  return call(baseUrl, apiKey, '/v3/documents', {
    content: String(content || ''),
    containerTag: String(containerTag || 'beast'),
    ...(customId ? { customId: String(customId) } : {}),
    ...(metadata && typeof metadata === 'object' ? { metadata } : {}),
  });
}

/* Hibrit arama → normalize: [{text, similarity}] — memories varsayılan;
   'hybrid' RAG + bellek tek sorguda */
async function search(baseUrl, apiKey, { q, containerTag, limit, mode }) {
  const r = await call(
    baseUrl,
    apiKey,
    '/v4/search',
    {
      q: String(q || ''),
      containerTag: String(containerTag || 'beast'),
      searchMode: mode === 'documents' || mode === 'hybrid' ? mode : 'memories',
      limit: Math.min(20, Math.max(1, Number(limit) || 5)),
    },
    12000
  );
  const out = [];
  for (const hit of (r && Array.isArray(r.results) ? r.results : []).slice(0, 10)) {
    if (hit && typeof hit.memory === 'string' && hit.memory.trim()) {
      out.push({ text: hit.memory.trim().slice(0, 600), similarity: Number(hit.similarity) || 0 });
    }
    /* hybrid mod: chunk'lar da gelir */
    for (const c of (hit && Array.isArray(hit.chunks) ? hit.chunks : []).slice(0, 3)) {
      const t = c && (c.content || c.text);
      if (typeof t === 'string' && t.trim()) {
        out.push({ text: t.trim().slice(0, 600), similarity: Number(c && c.similarity) || 0 });
      }
    }
  }
  return out.slice(0, Math.max(1, Number(limit) || 5));
}

/* Kullanıcı profili: { static: [], dynamic: [] } — her turda ucuz bağlam */
async function profile(baseUrl, apiKey, { containerTag, q }) {
  const r = await call(
    baseUrl,
    apiKey,
    '/v4/profile',
    {
      containerTag: String(containerTag || 'beast'),
      ...(q ? { q: String(q) } : {}),
    },
    12000
  );
  const p = (r && r.profile) || {};
  const arr = (x) =>
    Array.isArray(x)
      ? x.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 12)
      : typeof x === 'string' && x.trim()
        ? [x.trim().slice(0, 300)]
        : [];
  return { static: arr(p.static), dynamic: arr(p.dynamic) };
}

module.exports = { probe, add, search, profile, HEALTH_COOLDOWN_MS };
