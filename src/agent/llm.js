'use strict';

/* OpenAI-compatible streaming chat client with SSE parsing.
   Geçici sağlayıcı hatalarında (5xx/429) üstel beklemeyle retry; İNTERNET
   KOPMASINDA (fetch failed) çok daha sabırlı: 6 deneme + internet dönene
   dek bekleme (main'deki net izleyicisinden beslenir). Akış ortasında kopan
   bağlantıda: hiç veri akmadıysa sessiz baştan dener, kısmi metin geldiyse
   'length' gibi döner → chatStreamAuto kaldığı yerden DEVAM ETTİRİR.
   Model reddettiği parametre/seviyeleri (reasoning_effort, temperature,
   prompt_cache_key) 400'den otomatik öğrenir → model-caps.json'a kalıcı. */

const fs = require('fs');

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3; /* sağlayıcı geçici HTTP hataları */
const NET_MAX_RETRIES = 6; /* bağlantı kopması — daha sabırlı */
const NET_BACKOFF = [1000, 2000, 4000, 8000, 15000, 25000]; /* ≈55 sn toplam */
const NET_WAIT_CAP_MS = 120000; /* internet dönene dek bekleme üst sınırı */

/* main process'teki net izleyicisi besler: () => boolean | Promise<boolean> */
let _netProbe = null;
function setNetProbe(fn) {
  _netProbe = typeof fn === 'function' ? fn : null;
}

/* fetch failed / ENOTFOUND / ECONNRESET / socket hang up / terminated —
   HTTP yanıtı ALINAMADI demektir (status yok) */
function isNetworkError(e) {
  if (!e) return false;
  if (e.name === 'AbortError') return false;
  if (e.status !== undefined) return false;
  return true;
}

/* internet yoksa dönene kadar bekle (en fazla NET_WAIT_CAP_MS); probe yoksa
   ya da durum bilinmiyorsa hemen geç */
async function waitForNet(signal) {
  if (!_netProbe) return true;
  const t0 = Date.now();
  for (;;) {
    if (signal && signal.aborted) {
      const e = new Error('iptal');
      e.name = 'AbortError';
      throw e;
    }
    let online;
    try { online = await _netProbe(); } catch { online = null; }
    if (online !== false) return true; /* false DEĞİLSE devam (bilinmiyor = iyimser) */
    if (Date.now() - t0 > NET_WAIT_CAP_MS) return false;
    await sleep(2000, signal);
  }
}

const HINTS = {
  401: 'API anahtarı geçersiz',
  402: 'kredi/bakiye bitti',
  403: 'erişim reddedildi (anahtar yetkisi)',
  404: 'model adı ya da endpoint yanlış',
  429: 'hız limitine takıldın',
  500: 'sağlayıcı iç hatası',
  502: 'sağlayıcı upstream bağlantısı koptu',
  503: 'sağlayıcı şu an kullanılamıyor (aşırı yük veya kapalı)',
  504: 'sağlayıcı zaman aşımı',
};

function friendlyError(status, statusText, detail) {
  const hint = HINTS[status];
  let msg = `HTTP ${status} ${statusText}`;
  if (hint) msg += ` — ${hint}`;
  if (detail) msg += `\n${detail}`;
  if ([500, 502, 503, 504].includes(status)) {
    msg += '\n(geçici olabilir: birkaç saniye sonra tekrar dene ya da model seçiciyi açıp başka bir model dene)';
  }
  return msg;
}

/* opencode cache disiplini (provider/transform.ts:1262-1276 port): destekleyen
   sağlayıcılara oturum-sabit önbellek anahtarı gönderilir — aynı önek tekrar
   kullanıldığında girdi tokenleri cache'ten okunur (~%90 ucuz + hızlı TTFT) */
const CACHE_KEY_PROVIDER_RE = /openai|azure|xai|deepseek|cerebras|deepinfra|mistral|venice/i;
const CACHE_KEY_MODEL_RE = /openai|gpt-|^o[134]|xai|grok|deepseek|cerebras|deepinfra|mistral|venice/i;
function wantsCacheKey(sel) {
  if (!sel) return false;
  return (
    CACHE_KEY_PROVIDER_RE.test(String(sel.providerId || '')) ||
    CACHE_KEY_MODEL_RE.test(String(sel.model || ''))
  );
}

/* ---------- model yetenek keşfi (opencode provider.metadata muadili) ----------
   Her model her parametreyi kabul etmez: Mimo gibi bazıları reasoning_effort'u,
   GPT-5/o1 ailesi temperature'ı reddeder. Sağlayıcı 400 "Invalid request
   parameters" diyorsa parametre TEK TEK atlanıp sessizce yeniden denenir;
   kabul edilen kombinasyon KALICI öğrenilir (model-caps.json) → sonraki
   isteklerde reddedilen parametre hiç gönderilmez. models.dev metadata'sına
   internet bağımlılığı olmadan çalışma-zamanında eşdeğer davranır. */

const CAPS_FLAGS = ['noReasoning', 'noTemperature', 'noCacheKey'];
const PARAM_LABELS = {
  noReasoning: 'reasoning_effort',
  noTemperature: 'temperature',
  noCacheKey: 'prompt_cache_key',
};

let _capsFile = null;
const _caps = new Map(); /* "providerId::model" -> { noReasoning?, noTemperature?, noCacheKey? } */

function capsKey(sel) {
  return String((sel && sel.providerId) || '') + '::' + String((sel && sel.model) || '');
}

function capsFor(sel) {
  return _caps.get(capsKey(sel)) || null;
}

function resetCaps() {
  _caps.clear();
}

/* caps dosyasını bağla: mevcut öğrenimler yüklenir; null → kapat */
function setCapsFile(p) {
  _caps.clear();
  _capsFile = typeof p === 'string' && p ? p : null;
  if (!_capsFile) return;
  try {
    const j = JSON.parse(fs.readFileSync(_capsFile, 'utf8'));
    for (const [k, v] of Object.entries(j.models || {})) {
      if (v && typeof v === 'object') _caps.set(k, { ...v });
    }
  } catch {}
}

function learnCaps(sel, drops) {
  const k = capsKey(sel);
  const prev = _caps.get(k) || {};
  const next = { ...prev };
  let changed = false;
  for (const f of CAPS_FLAGS) {
    if (drops[f] && !prev[f]) {
      next[f] = true;
      changed = true;
    }
  }
  /* reddedilen reasoning seviyeleri (["max","xhigh",...]) — seviye bazlı öğrenim */
  if (Array.isArray(drops.failedEfforts) && drops.failedEfforts.length) {
    const merged = [...(prev.failedEfforts || [])];
    for (const e of drops.failedEfforts) {
      if (!merged.includes(e)) merged.push(e);
    }
    if (merged.length !== (prev.failedEfforts || []).length) {
      next.failedEfforts = merged;
      changed = true;
    }
  }
  if (!changed) return;
  _caps.set(k, next);
  if (!_capsFile) return;
  try {
    const all = {};
    for (const [key, v] of _caps) all[key] = v;
    fs.writeFileSync(_capsFile, JSON.stringify({ version: 1, models: all }, null, 2));
  } catch {}
}

/* reasoning_effort merdiveni: reddedilen seviyede BİR ALT seviye denenir
   (Mimo 2.5: max/xhigh reddediyor, low çalışıyor). low'un altı yok → null. */
const EFFORT_LOWER = { max: 'xhigh', xhigh: 'high', high: 'medium', medium: 'low', low: null };

/* Hangi hata metni "geçersiz istek" dili (Mimo: "Invalid request parameters").
   friendlyError'ın kendi öneki ("HTTP 400 Bad Request") ile eşleşmemesine dikkat. */
const GENERIC_400_RE =
  /invalid request param|invalid_param|unsupported|not supported|unknown (param|field|argument)|unrecognized|unexpected/i;

/* run(drops, body): verilen atlama seti + gövdeyle isteği çalıştırır.
   400 gelirse ve hata parametre reddine işaret ediyorsa:
   1) reasoning_effort önce SEVİYE düşürülerek denenir (max→xhigh→...→low),
      en düşük de reddedilirse parametre tamamen bırakılır (noReasoning);
   2) sonra temperature, prompt_cache_key atlanır;
   Kabul edilen kombinasyon bu model için KALICI öğrenilir → sonraki isteklerde
   reddedilen seviye/parametre hiç gönderilmez (otomatik reasoning uyumu). */
async function withParamFallbacks(sel, body0, run, { signal, onParamDrop, onEffortDowngrade } = {}) {
  const active = { ...(capsFor(sel) || {}) };
  for (;;) {
    /* seçilen seviyeyi öğrenilen redlere göre otomatik düşür */
    let eff = body0.reasoningEffort ? String(body0.reasoningEffort) : null;
    if (eff && !active.noReasoning) {
      const failed = active.failedEfforts || [];
      let guard = 0;
      while (eff && failed.includes(eff) && guard++ < 5) eff = EFFORT_LOWER[eff] || null;
    }
    if (active.noReasoning) eff = null;
    const body = eff && eff !== body0.reasoningEffort ? { ...body0, reasoningEffort: eff } : body0;
    let res;
    try {
      res = await run({ ...active }, body);
      learnCaps(sel, active);
      return res;
    } catch (e) {
      if (!e || e.status !== 400 || (signal && signal.aborted)) throw e;
      const msg = String(e.message || '');
      const generic = GENERIC_400_RE.test(msg);
      const reasonHint = /reason|effort|thinking/i.test(msg);
      const tempHint = /temperature/i.test(msg);

      /* denenecek atlamalar öncelik sırasıyla: önce reasoning merdiveni
         (seviye düşür — Mimo: max reddedilir, low çalışır), sonra diğerleri */
      const actions = [];
      if ((reasonHint || generic) && body0.reasoningEffort && !active.noReasoning) actions.push('reasoning');
      if ((generic || tempHint) && !active.noTemperature) actions.push('temperature');
      if ((generic || /cache/i.test(msg)) && body0.cacheKey && wantsCacheKey(sel) && !active.noCacheKey) {
        actions.push('cacheKey');
      }
      const act = actions[0];
      if (!act) throw e;

      if (act === 'reasoning') {
        const cur = eff;
        const lower = cur && cur in EFFORT_LOWER ? EFFORT_LOWER[cur] : null;
        /* merdiven: generic red (gerçek sebep bilinmiyor → seviyeleri dene)
           ya da red mesajı SEVİYE değerini zikrediyorsa ("effort 'max' invalid").
           Mesaj parametrenin kendisini reddediyorsa ("not supported") direkt bırak. */
        const valueQuoted = cur ? (msg.includes(`'${cur}'`) || msg.includes(`"${cur}"`)) : false;
        /* ipucu parametrenin kendisini reddediyorsa merdivene gerek yok */
        const ladder = valueQuoted || (generic && !reasonHint);
        if (cur && lower && ladder) {
          /* seviye reddedildi → bir alt seviyeye in, kalıcı öğren */
          if (!Array.isArray(active.failedEfforts)) active.failedEfforts = [];
          if (!active.failedEfforts.includes(cur)) {
            active.failedEfforts.push(cur);
            learnCaps(sel, active);
          }
          try {
            onEffortDowngrade && onEffortDowngrade(cur, lower);
          } catch {}
        } else {
          /* parametre tamamen reddedildi → bir daha gönderme */
          active.noReasoning = true;
          try {
            onParamDrop && onParamDrop('noReasoning');
          } catch {}
        }
      } else if (act === 'temperature') {
        active.noTemperature = true;
        try {
          onParamDrop && onParamDrop('noTemperature');
        } catch {}
      } else if (act === 'cacheKey') {
        active.noCacheKey = true;
        try {
          onParamDrop && onParamDrop('noCacheKey');
        } catch {}
      }
    }
  }
}

/* Retry-After başlığı: saniye ("2"), milisaniye ("120ms" / retry-after-ms)
   ya da HTTP-tarih olabilir (opencode session/retry.ts port) */
function parseRetryAfter(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const ms = /^(\d+)\s*ms$/i.exec(s);
  if (ms) return Number(ms[1]);
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;
  const d = Date.parse(s);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return null;
}

const RETRY_AFTER_CAP_MS = 30000; /* opencode retry.ts:39 — headersız bekleme tavanı */
function clampMs(v) {
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, Number(v) || 0));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          const e = new Error('iptal');
          e.name = 'AbortError';
          reject(e);
        },
        { once: true }
      );
    }
  });
}

/* fn: denenecek istek. Sağlayıcı geçici HTTP hatalarında 0.8s→1.6s→3.2s;
   İNTERNET KOPMASINDA (status yok) 6 denemeye kadar 1s→2s→4s→8s→15s→25s ve
   net izleyicisi "çevrimdışı" diyorsa internet dönene kadar bekler. */
async function withRetries(fn, { signal, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || (signal && signal.aborted));
      const status = e && e.status;
      const netErr = !aborted && status === undefined;
      const retriable = !aborted && (status === undefined || RETRYABLE_STATUS.has(status));
      if (!retriable) throw e;
      const cap = netErr ? NET_MAX_RETRIES : MAX_RETRIES;
      if (attempt >= cap) throw e;
      if (netErr && _netProbe) {
        /* internet kopmuş: dönene kadar bekle — kısa kopmalarda görev ölmez */
        await waitForNet(signal);
      }
      attempt++;
      try {
        onRetry && onRetry(attempt, status);
      } catch {}
      /* sağlayıcı retry-after dediye: backoff yerine ona uy (30 sn tavan);
         opencode session/retry.ts:26-31 ile aynı politika */
      let wait;
      if (e.retryAfterMs) wait = clampMs(e.retryAfterMs);
      else
        wait = netErr
          ? NET_BACKOFF[Math.min(attempt - 1, NET_BACKOFF.length - 1)]
          : 800 * Math.pow(2, attempt - 1);
      await sleep(wait, signal);
    }
  }
}

async function openChat(sel, body, { stream, signal, drops } = {}) {
  const d = drops || {};
  const payload = {
    model: sel.model,
    messages: body.messages,
    stream,
    ...(body.tools && body.tools.length ? { tools: body.tools } : {}),
  };
  if (!d.noTemperature) {
    payload.temperature = body.temperature ?? 0.6;
  }
  /* Düşünme (reasoning) seviyesi: OpenAI-style reasoning_effort —
     OpenRouter ve GPT-5 ailesi dahil uyumlu sağlayıcılar kabul eder.
     Kabul etmeyenlerde (Mimo vb.): 400 → parametre atlanır + KALICI öğrenilir. */
  if (body.reasoningEffort && !d.noReasoning) {
    payload.reasoning_effort = String(body.reasoningEffort);
  }
  /* prompt cache anahtarı: oturum başına sabit → sağlayıcı önek önbelleği tutar */
  if (body.cacheKey && wantsCacheKey(sel) && !d.noCacheKey) {
    payload.prompt_cache_key = String(body.cacheKey);
  }
  return fetch(sel.url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sel.key}`,
      'HTTP-Referer': 'https://localhost/beast',
      'X-Title': 'Beast Agent',
    },
    body: JSON.stringify(payload),
  });
}

async function chatStream(sel, body, { signal, onDelta, onRetry, onParamDrop, onEffortDowngrade } = {}) {
  /* 400 parametre/seviye reddinde: otomatik uyum (seviye düşür → parametre atla),
     başarılı set kalıcı öğrenilir */
  return withParamFallbacks(
    sel,
    body,
    (drops, b) => streamOnce(sel, b, { signal, onDelta }, drops),
    { signal, onParamDrop, onEffortDowngrade }
  );
}

async function streamOnce(sel, body, { signal, onDelta, onRetry } = {}, drops = {}) {
  /* akış durumu dışarıda tutulur: gövde okunurken bağlantı koparsa
     ne kadarı geldiğine bakılır (kısmi metin → devam; boş/araç → baştan) */
  const state = { content: '', reasoning: '', toolCalls: [], usage: null, finishReason: null };
  let dropAttempt = 0;

  for (;;) {
    const res = await withRetries(
      async () => {
        const r = await openChat(sel, body, { stream: true, signal, drops });
        if (!r.ok) {
          let detail = '';
          try {
            detail = (await r.text()).slice(0, 300);
          } catch {}
          const err = new Error(friendlyError(r.status, r.statusText, detail));
          err.status = r.status;
          err.retryAfterMs = parseRetryAfter(
            r.headers && (r.headers.get('retry-after-ms') || r.headers.get('retry-after'))
          );
          throw err;
        }
        return r;
      },
      { signal, onRetry }
    );

    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      /* SERT İPTAL: abort gelirse gövdeyi fiziksel kapat (reader.cancel) —
         sağlayıcı/fetch abort'u gövdeye taşımasa bile okuma döngüsü ANINDA
         biter, token akışı kesilir */
      let onAbort = null;
      if (signal) {
        onAbort = () => {
          try {
            const p = reader.cancel();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch {}
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        /* tek satır SSE olayını işle — hem okuma döngüsü hem SON FLUSH kullanır */
        const handleLine = (line) => {
          line = line.trim();
          if (!line.startsWith('data:')) return;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') return;

          let json;
          try {
            json = JSON.parse(data);
          } catch {
            return;
          }

          if (json.usage) state.usage = json.usage;
          const ch = json.choices && json.choices[0];
          if (!ch) return;
          if (ch.finish_reason) state.finishReason = ch.finish_reason;
          const d = ch.delta || {};
          if (d.content) {
            state.content += d.content;
            onDelta && onDelta(d.content, state.content);
          }
          if (d.reasoning_content) state.reasoning += d.reasoning_content;
          if (d.reasoning) state.reasoning += d.reasoning;
          for (const tc of d.tool_calls || []) {
            const i = typeof tc.index === 'number' ? tc.index : state.toolCalls.length;
            while (state.toolCalls.length <= i) {
              state.toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
            }
            if (tc.id) state.toolCalls[i].id = tc.id;
            if (tc.function) {
              if (tc.function.name) state.toolCalls[i].function.name += tc.function.name;
              if (tc.function.arguments) state.toolCalls[i].function.arguments += tc.function.arguments;
            }
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (signal && signal.aborted) {
            const e = new Error('iptal');
            e.name = 'AbortError';
            throw e;
          }
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            handleLine(line);
          }
        }

        /* SON FLUSH — KRİTİK: akış son parçası '\n' ile bitmeyebilir.
           Okuma bitince kalan buf'u Decoder'dan boşaltıp işlemezsek
           cevabın SON kelimesi/cümlesi kaybolur (SSE sonu öyle gelir). */
        buf += decoder.decode();
        if (buf.trim()) handleLine(buf);

        return { ...state };
      } finally {
        if (signal && onAbort) {
          try { signal.removeEventListener('abort', onAbort); } catch {}
        }
      }
    } catch (e) {
      /* okuma sırasında bağlantı koptu */
      const aborted = e && (e.name === 'AbortError' || (signal && signal.aborted));
      if (!aborted && isNetworkError(e)) {
        if (state.content && !state.toolCalls.length) {
          /* kısmi metin geldi, araç çağrısı yok → hata balonu YOK:
             'length' gibi dön, chatStreamAuto CONTINUE_PROMPT ile kaldığı
             yerden sürdürür ve metni birleştirir */
          return { ...state, finishReason: 'length' };
        }
        /* hiç veri akmadı YA DA araç çağrısı yarım kaldı → BAŞTAN dene */
        if (dropAttempt >= NET_MAX_RETRIES) throw e;
        dropAttempt++;
        try { onRetry && onRetry(dropAttempt, undefined); } catch {}
        if (_netProbe) await waitForNet(signal);
        await sleep(NET_BACKOFF[Math.min(dropAttempt - 1, NET_BACKOFF.length - 1)], signal);
        continue; /* yeni stream — UI'daki kısmi token'lar nihai mesajla ezilir */
      }
      throw e;
    }
  }
}

/* usage toplama: devam turları gerçek faturalamayı yansıtsın (prompt yeniden sayılır) */
function sumUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (typeof a[k] === 'number' && typeof b[k] === 'number') out[k] = a[k] + b[k];
    else out[k] = b[k] !== undefined ? b[k] : a[k];
  }
  return out;
}

/* OTOMATİK DEVAM: model cevabı çıkış limiti (finish_reason='length') yüzünden
   kelime ortasında kesilirse — özellikle free modellerin düşük varsayılan
   limitlerinde olur — yarım cümle kullanıcıya gitmesin. Kaldığı yerden devam
   istenip metin birleştirilir (en fazla 2 devam turu). Araç çağrılı yanıtlarda
   ve içerik hiç gelmediyse devreye girmez; orijinal mesaj dizisi DEĞİŞTİRİLMEZ. */
const CONTINUE_PROMPT =
  'Yanıtın çıkış limiti nedeniyle ortadan kesildi. Kaldığın yerden DEVAM ET — baştan başlama, özetleme, açıklama yapma; yalnızca kesilen kısmın DEVAMINI yaz.';

async function chatStreamAuto(sel, body, opts = {}) {
  const first = await chatStream(sel, body, opts);
  if (first.finishReason !== 'length' || !first.content || (first.toolCalls && first.toolCalls.length)) {
    return first;
  }
  let full = first.content;
  let last = first;
  for (let i = 0; i < 2; i++) {
    const msgs2 = body.messages.slice();
    msgs2.push({ role: 'assistant', content: full });
    msgs2.push({ role: 'user', content: CONTINUE_PROMPT });
    let cont;
    try {
      cont = await chatStream(sel, { ...body, messages: msgs2 }, opts);
    } catch {
      break; // devam turu patlarsa elimizdeki kısmi yanıtla döneriz
    }
    if (!cont.content || (cont.toolCalls && cont.toolCalls.length)) break;
    full += cont.content;
    last = { ...cont, content: full, usage: sumUsage(first.usage, cont.usage) };
    if (cont.finishReason !== 'length') break;
  }
  return last;
}

async function chatOnce(sel, body, { signal, onRetry, onParamDrop, onEffortDowngrade } = {}) {
  const res = await withParamFallbacks(
    sel,
    body,
    (drops, b) =>
      withRetries(
        async () => {
          const r = await openChat(sel, b, { stream: false, signal, drops });
          if (!r.ok) {
            let detail = '';
            try {
              detail = (await r.text()).slice(0, 300);
            } catch {}
            const err = new Error(friendlyError(r.status, r.statusText, detail));
            err.status = r.status;
            err.retryAfterMs = parseRetryAfter(
              r.headers && (r.headers.get('retry-after-ms') || r.headers.get('retry-after'))
            );
            throw err;
          }
          return r;
        },
        { signal, onRetry }
      ),
    { signal, onParamDrop, onEffortDowngrade }
  );
  const json = await res.json();
  const msg = json.choices?.[0]?.message || {};
  return {
    content: msg.content || '',
    reasoning: msg.reasoning_content || msg.reasoning || '',
    toolCalls: msg.tool_calls || [],
    usage: json.usage || null,
    finishReason: json.choices?.[0]?.finish_reason,
  };
}

module.exports = {
  chatStream,
  chatStreamAuto,
  chatOnce,
  withRetries,
  withParamFallbacks,
  friendlyError,
  sumUsage,
  setNetProbe,
  setCapsFile,
  capsFor,
  resetCaps,
  learnCaps,
  PARAM_LABELS,
  isNetworkError,
  wantsCacheKey,
  parseRetryAfter,
};
