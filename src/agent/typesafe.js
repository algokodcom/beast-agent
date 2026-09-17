'use strict';

/* ---------- TypeSafe / System One (Jev) adaptörü ----------
   TypeSafe'in System One API'si (docs.typesafe.ai) — state + tipli sorular
   gönderilir, metin ÜRETİLMEZ; noul/choice/score yanıtları olasılıklarıyla
   döner. Beast ajanları typesafe_decision aracıyla bu kararları doğrudan
   kod gibi tüketir (ör. "bu haber altını yukarı iter mi?" → 0.78).

   Uç: POST https://api.typesafe.ai/v1/systemone
   Auth: Authorization: Bearer <API_KEY>
   Zero npm bağımlılık — Node 18+ global fetch (supermemory.js deseni).

   Konfig main süreçten enjekte edilir: setConfig(fn) → { apiKey, model }. */

const BASE_URL = 'https://api.typesafe.ai';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 25000;

let getCfg = () => ({ apiKey: '', model: DEFAULT_MODEL });

function setConfig(fn) {
  if (typeof fn === 'function') getCfg = fn;
}

function cfg() {
  const c = getCfg() || {};
  return {
    apiKey: String(c.apiKey || '').trim(),
    model: String(c.model || '').trim() || DEFAULT_MODEL,
  };
}

function errorForStatus(status, bodyText) {
  const detail = String(bodyText || '').slice(0, 240);
  if (status === 401 || status === 403) return 'TypeSafe API anahtarı geçersiz (Ayarlar → TypeSafe sekmesinden kontrol et)' + (detail ? ' — ' + detail : '');
  if (status === 429) return 'TypeSafe hız limiti (429) — biraz bekleyip yeniden dene';
  if (status === 529) return 'TypeSafe geçici olarak yoğun (529) — biraz bekleyip yeniden dene';
  if (status === 422) return 'TypeSafe istek doğrulaması başarısız (422) — questions/state biçimini kontrol et' + (detail ? ' — ' + detail : '');
  return 'TypeSafe HTTP ' + status + (detail ? ': ' + detail : '');
}

/* Soru gövdelerini doğrula + normalleştir (id → {type, instructions, criteria}) */
function normalizeQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new Error('questions bir nesne olmalı: { id: {type, instructions, criteria} }');
  }
  const out = {};
  for (const [id, q] of Object.entries(questions)) {
    const key = String(id || '').trim();
    if (!key) continue;
    const o = q && typeof q === 'object' ? q : {};
    const type = String(o.type || '').toLowerCase();
    if (!['noul', 'choice', 'score'].includes(type)) {
      throw new Error(`soru "${key}": type noul|choice|score olmalı (gelen: ${o.type || 'boş'})`);
    }
    if (o.instructions == null || String(o.instructions).trim() === '') {
      throw new Error(`soru "${key}": instructions zorunlu`);
    }
    const item = { type, instructions: o.instructions };
    if (type === 'choice') {
      if (!o.criteria || typeof o.criteria !== 'object' || Array.isArray(o.criteria) || !Object.keys(o.criteria).length) {
        throw new Error(`soru "${key}": choice için criteria nesnesi zorunlu {seçenek: açıklama|null}`);
      }
      item.criteria = o.criteria;
    } else if (type === 'score') {
      if (!Array.isArray(o.criteria) || o.criteria.length < 2) {
        throw new Error(`soru "${key}": score için en az 2 seviyeli criteria dizisi zorunlu`);
      }
      item.criteria = o.criteria;
    } else if (o.criteria && typeof o.criteria === 'object') {
      item.criteria = o.criteria;
    }
    out[key] = item;
  }
  if (!Object.keys(out).length) throw new Error('questions boş — en az 1 soru gerekli');
  return out;
}

/* systemOne çağrısı: state + questions → answers */
async function systemOne({ state, questions, model, timeoutMs, signal } = {}) {
  const c = cfg();
  if (!c.apiKey) throw new Error('TypeSafe API anahtarı yok — Ayarlar → TypeSafe sekmesinden gir');
  if (state == null || (typeof state === 'string' && !state.trim())) {
    throw new Error('state boş — değerlendirilecek içerik gerekli (metin ya da JSON nesne/dizi)');
  }
  const qs = normalizeQuestions(questions);
  const body = { state, model: String(model || '').trim() || c.model, questions: qs };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(BASE_URL + '/v1/systemone', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(errorForStatus(res.status, txt));
    }
    const data = await res.json();
    return {
      model: String((data && data.model) || body.model),
      answers: (data && data.answers) || {},
      usage: (data && data.usage) || null,
    };
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      if (signal && signal.aborted) throw new Error('TypeSafe çağrısı iptal edildi');
      throw new Error('TypeSafe zaman aşımı — istek ' + Math.round((Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS) / 1000) + ' sn içinde yanıtlanmadı');
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
  }
}

/* Anahtar testi: tek soruluk ucuz systemOne çağrısı (bağlantı + auth doğrular) */
async function probe(apiKey, model) {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: 'API anahtarı boş' };
  const useModel = String(model || '').trim() || DEFAULT_MODEL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(BASE_URL + '/v1/systemone', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        state: 'ping',
        model: useModel,
        questions: { ok: { type: 'noul', instructions: 'Is this request working?' } },
      }),
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: errorForStatus(res.status, '') };
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, error: errorForStatus(res.status, txt) };
    }
    const data = await res.json().catch(() => null);
    return { ok: true, model: String((data && data.model) || useModel), answers: (data && data.answers) || {} };
  } catch (e) {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      return { ok: false, error: 'TypeSafe zaman aşımı — anahtar/İnternet kontrol et' };
    }
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Ajan aracı: typesafe_decision ---------- */

const definitions = [
  {
    type: 'function',
    function: {
      name: 'typesafe_decision',
      description:
        'TypeSafe System One (Jev) ile TİPLİ KARAR: state + sorular gönderir, metin üretmeden olasılıklı yanıt alır (noul: 0-1 evet olasılığı; choice: seçenek + dağılım; score: ağırlıklı puan + dağılım). ' +
        'Şüpheli/semantik yargılar için chat modeli gibi cevap yazdırıp JSON ayrıştırmak yerine BUNU kullan — hızlı, kalibre olasılıklı, doğrudan kod gibi tüketilir. ' +
        'Örnekler: "bu haber X sembolünü yukarı iter mi?" (noul), "hangi seans/setup?" (choice), "setup kalitesi" (score). ' +
        'questions: { id: {type:"noul"|"choice"|"score", instructions, criteria} }; noul criteria {true,false} (ops.), choice criteria {seçenek:açıklama|null}, score criteria [seviye...] (en az 2). ' +
        'Aynı state üzerindeki bağımsız soruları TEK çağrıda birlikte sor. Yanıtları olasılık değerleriyle raporla.',
      parameters: {
        type: 'object',
        properties: {
          state: {
            description: 'Değerlendirilecek içerik: serbest metin, ya da JSON nesne/dizi (ör. {haber, fiyat, pozisyon}). Tüm bağlamı ver — model yalnız bunu görür.',
          },
          questions: {
            type: 'object',
            description:
              'Soru haritası: anahtar = kısa soru id (kod için; modele gitmez), değer = {type:"noul"|"choice"|"score", instructions, criteria}. ' +
              'noul: evet/hayır sorusu; choice: criteria {seçenek: açıklama|null}; score: criteria ["seviye1","seviye2",...].',
            additionalProperties: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['noul', 'choice', 'score'] },
                instructions: { description: 'Karar sorusu (metin ya da JSON yapı)' },
                criteria: { description: 'choice → nesne; score → dizi; noul → {true,false} (opsiyonel)' },
              },
              required: ['type', 'instructions'],
            },
          },
          model: { type: 'string', description: 'TypeSafe modeli (varsayılan jev-latest)' },
        },
        required: ['state', 'questions'],
      },
    },
  },
];

/* Yanıtı ajan için insan-okur özete çevir (kod yine ham `answers` alanını okur) */
function summarize(answers) {
  const lines = [];
  for (const [id, a] of Object.entries(answers || {})) {
    const o = a && typeof a === 'object' ? a : {};
    if (o.type === 'noul') {
      lines.push(`- ${id}: noul=${Number(o.noul).toFixed(3)} (evet olasılığı)`);
    } else if (o.type === 'choice') {
      const probs = o.probabilities && typeof o.probabilities === 'object'
        ? Object.entries(o.probabilities).map(([k, v]) => `${k}=${Number(v).toFixed(3)}`).join(', ')
        : '';
      lines.push(`- ${id}: choice=${o.choice} · confidence=${Number(o.confidence).toFixed(3)}${probs ? ' · ' + probs : ''}`);
    } else if (o.type === 'score') {
      const probs = o.probabilities && typeof o.probabilities === 'object'
        ? Object.entries(o.probabilities).map(([k, v]) => `${k}=${Number(v).toFixed(3)}`).join(', ')
        : '';
      lines.push(`- ${id}: score=${o.score} · confidence=${Number(o.confidence).toFixed(3)}${probs ? ' · ' + probs : ''}`);
    } else {
      lines.push(`- ${id}: ${JSON.stringify(o).slice(0, 200)}`);
    }
  }
  return lines.join('\n');
}

async function handler(args, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  const c = cfg();
  if (!c.apiKey) {
    return { ok: false, error: 'TypeSafe API anahtarı yok — Ayarlar → TypeSafe sekmesinden gir (kullanıcıya bunu söyle)' };
  }
  let state = a.state;
  if (typeof state === 'string') {
    const s = state.trim();
    if (!s) return { ok: false, error: 'state boş' };
    state = s;
  } else if (state && typeof state === 'object') {
    /* olduğu gibi bırak */
  } else {
    return { ok: false, error: 'state gerekli (metin ya da JSON nesne/dizi)' };
  }
  let qs;
  try {
    qs = normalizeQuestions(a.questions);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  try {
    const r = await systemOne({
      state,
      questions: qs,
      model: a.model,
      timeoutMs: Number(a.timeout_ms) > 0 ? Number(a.timeout_ms) : DEFAULT_TIMEOUT_MS,
      signal: ctx && ctx.signal,
    });
    return {
      ok: true,
      model: r.model,
      answers: r.answers,
      summary: summarize(r.answers),
      usage: r.usage,
      hint: 'Olasılıkları karar eşiklerinle (ör. >0.65 aksiyon, 0.35-0.65 belirsiz→insana sor) birlikte yorumla.',
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

const handlers = { typesafe_decision: handler };

module.exports = {
  definitions,
  handlers,
  systemOne,
  probe,
  setConfig,
  cfg,
  normalizeQuestions,
  BASE_URL,
  DEFAULT_MODEL,
};
