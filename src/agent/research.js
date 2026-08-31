'use strict';

/* BEAST — deep_search: agentic araştırma katmanı.
   web_search snippet'te kalır; bu katman derine iner:
     1) 1-4 sorgu varyantını PARALEL aratır (toplam süre ≈ tek arama)
     2) Sonuçları URL bazlı tekilleştirip round-robin harmanlar (kaynak çeşitliliği)
     3) İlk N sonucu GİZLİ gerçek tarayıcıda açıp tam metin okur
        (deps.readPage verilmişse; yoksa yalnız sonuç listesi döner)
   Saf modüldür: search/readPage enjekte edilir — test edilebilir. */

/* İçerik okumada anlamsız/ikili dosyalar — tarayıcıda açmanın anlamı yok */
const SKIP_FILE_RE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|exe|dmg|apk|mp[34]|m4a|avi|mkv|webm|jpe?g|png|gif|webp|svg|ico|csv)([?#]|$)/i;

/* URL anahtarı: scheme/www/slash/hash farklarını yok sayar — tekilleştirme için */
function normKey(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    let s = x.toString();
    s = s.replace(/^http:\/\//i, 'https://');
    s = s.replace(/^https:\/\/www\./i, 'https://');
    return s.replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(u || '').toLowerCase();
  }
}

/* search() geri dönüşünü normalize eder: dizi YA DA {results:[...]} kabul;
   satır anahtarları title/url/snippet VEYA name/href/link/body/description olabilir */
function normalizeRows(out) {
  if (!out) return [];
  const rows = Array.isArray(out) ? out : Array.isArray(out.results) ? out.results : [];
  return rows
    .map((r) => ({
      title: String((r && (r.title || r.name)) || '').replace(/\s+/g, ' ').trim(),
      url: String((r && (r.url || r.href || r.link)) || '').trim(),
      snippet: String((r && (r.snippet || r.body || r.description)) || '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((r) => r.url && /^https?:\/\//i.test(r.url) && r.title);
}

/* Liste harmanı: her listenin i. elemanı sırayla alınır (round-robin) —
   tek motorun sonuçları öne çökmez, kaynak çeşitliliği korunur */
function mergeResults(lists, limit) {
  const seen = new Set();
  const out = [];
  const max = lists.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < max && out.length < limit; i++) {
    for (const list of lists) {
      if (out.length >= limit) break;
      const r = list[i];
      if (!r) continue;
      const key = normKey(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

/* Eşzamanlılığı sınırlı paralel map — hata tek elemanı bozar, diziyi bozmaz */
function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = { ok: false, url: items[idx] && items[idx].url, error: String((e && e.message) || e) };
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker);
  return Promise.all(workers).then(() => out);
}

async function deepSearch(args, deps, signal) {
  const a = args || {};
  let queries = a.queries;
  if (typeof queries === 'string') queries = [queries];
  if (!Array.isArray(queries) || !queries.length) {
    const q = String(a.query || '').trim();
    if (q) queries = [q];
  }
  queries = [...new Set((queries || []).map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 4);
  if (!queries.length) return { ok: false, error: 'sorgu yok — queries: ["...", "..."] ver' };
  if (signal && signal.aborted) return { ok: false, error: 'iptal edildi', queries };

  const maxResults = Math.max(5, Math.min(25, Number(a.max_results) || 16));
  const readTop = Math.max(0, Math.min(6, Number(a.read_top != null ? a.read_top : (a.readTop != null ? a.readTop : 3))));
  const search = deps && typeof deps.search === 'function' ? deps.search : null;
  if (!search) return { ok: false, error: 'arama altyapısı yok', queries };

  /* 1) paralel arama — bir sorgu çökse diğerleri devam eder */
  const lists = await Promise.all(
    queries.map((q) =>
      Promise.resolve()
        .then(() => search(q))
        .then(normalizeRows)
        .catch(() => [])
    )
  );
  const results = mergeResults(lists, maxResults);

  /* 2) ilk N sonucu gizli tarayıcıda açıp oku (ikili dosyaları atla) */
  let pages = [];
  if (readTop && results.length && deps && typeof deps.readPage === 'function') {
    const targets = results.filter((r) => !SKIP_FILE_RE.test(r.url)).slice(0, readTop);
    if (targets.length) {
      pages = (await mapLimit(targets, 2, (r) => deps.readPage(r.url))).filter(Boolean);
    }
  }
  const anyPage = pages.some((p) => p && p.ok);

  return {
    ok: !!(results.length || anyPage),
    queries,
    results,
    ...(pages.length ? { pages } : {}),
    ...(results.length || anyPage
      ? {
          note: anyPage
            ? 'sayfalar gizli tarayıcıda açılıp okundu — excerpt\u2019ler pages içinde; bir sayfayı kullanıcıya da göstermek istersen browser_open ile panelde aç'
            : 'sonuç listesi hazır — tam metin okuma kapalı/başarısız; URL\u2019leri http_fetch ile okuyabilirsin',
        }
      : { error: 'tüm motorlar boş döndü — sorguları farklı ifade etmeyi dene' }),
  };
}

module.exports = { deepSearch, mergeResults, normalizeRows, normKey, mapLimit, SKIP_FILE_RE };
