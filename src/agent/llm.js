'use strict';

/* OpenAI-compatible streaming chat client with SSE parsing.
   Geçici sağlayıcı hatalarında (5xx/429/ağ) üstel beklemeyle otomatik retry. */

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

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

/* fn: denenecek istek. Ağ hataları ve RETRYABLE_STATUS durumlarında
   0.8s → 1.6s → 3.2s bekleyip tekrar dener. */
async function withRetries(fn, { signal, onRetry } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || (signal && signal.aborted));
      const status = e && e.status;
      const retriable =
        !aborted && (status === undefined || RETRYABLE_STATUS.has(status));
      if (!retriable || attempt >= MAX_RETRIES) throw e;
      attempt++;
      try {
        onRetry && onRetry(attempt, status);
      } catch {}
      await sleep(800 * Math.pow(2, attempt - 1), signal);
    }
  }
}

async function openChat(sel, body, { stream, signal, omitReasoning } = {}) {
  const payload = {
    model: sel.model,
    messages: body.messages,
    stream,
    ...(body.tools && body.tools.length ? { tools: body.tools } : {}),
    temperature: body.temperature ?? 0.6,
  };
  /* Düşünme (reasoning) seviyesi: OpenAI-style reasoning_effort —
     OpenRouter ve GPT-5 ailesi dahil uyumlu sağlayıcılar kabul eder. */
  if (body.reasoningEffort && !omitReasoning) {
    payload.reasoning_effort = String(body.reasoningEffort);
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

async function chatStream(sel, body, { signal, onDelta, onRetry } = {}) {
  try {
    return await streamOnce(sel, body, { signal, onDelta });
  } catch (e) {
    /* Model reasoning_effort'u desteklemiyorsa (400) parametreyi atlayıp
       TEK seferlik sessiz retry — kullanıcı hatayı görmez. */
    if (
      body.reasoningEffort &&
      e && e.status === 400 &&
      /reason|effort|thinking/i.test(String(e.message || ''))
    ) {
      return await streamOnce(sel, body, { signal, onDelta }, true);
    }
    throw e;
  }
}

async function streamOnce(sel, body, { signal, onDelta, onRetry } = {}, omitReasoning = false) {
  const res = await withRetries(
    async () => {
      const r = await openChat(sel, body, { stream: true, signal, omitReasoning });
      if (!r.ok) {
        let detail = '';
        try {
          detail = (await r.text()).slice(0, 300);
        } catch {}
        const err = new Error(friendlyError(r.status, r.statusText, detail));
        err.status = r.status;
        throw err;
      }
      return r;
    },
    { signal, onRetry }
  );

  let content = '';
  let reasoning = '';
  const toolCalls = [];
  let usage = null;
  let finishReason = null;
  let sawDone = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') { sawDone = true; continue; }

      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }

      if (json.usage) usage = json.usage;
      const ch = json.choices && json.choices[0];
      if (!ch) continue;
      if (ch.finish_reason) finishReason = ch.finish_reason;
      const d = ch.delta || {};
      if (d.content) {
        content += d.content;
        onDelta && onDelta(d.content, content);
      }
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (d.reasoning) reasoning += d.reasoning;
      for (const tc of d.tool_calls || []) {
        const i = typeof tc.index === 'number' ? tc.index : toolCalls.length;
        while (toolCalls.length <= i) {
          toolCalls.push({ id: '', type: 'function', function: { name: '', arguments: '' } });
        }
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function) {
          if (tc.function.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  }

  /* YARIDA KESİLEN AKIŞ: stream erişilmeyen bir yerde koptuysa reader sessizce
     done=true döner — yarım metni "tamamlanmış" sanmak yerine işaretle.
     ([DONE] geldi ama finish_reason yok = sağlayıcı tuhaflığı → kabul) */
  if (!finishReason && !sawDone) {
    if (toolCalls.length) {
      const e = new Error('cevap akışı yarıda kesildi (bağlantı koptu) — araç çağrısı tamamlanamadı, tekrar deneyin');
      e.partialStream = true;
      throw e;
    }
    if (content) {
      content += '\n\n⚠ _akış yarıda kesildi (bağlantı koptu) — devam etmesini istersen tekrar yaz._';
    }
  }

  return { content, reasoning, toolCalls, usage, finishReason };
}

async function chatOnce(sel, body, { signal, onRetry } = {}) {
  const res = await withRetries(
    async () => {
      const r = await openChat(sel, body, { stream: false, signal });
      if (!r.ok) {
        let detail = '';
        try {
          detail = (await r.text()).slice(0, 300);
        } catch {}
        const err = new Error(friendlyError(r.status, r.statusText, detail));
        err.status = r.status;
        throw err;
      }
      return r;
    },
    { signal, onRetry }
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

module.exports = { chatStream, chatOnce, withRetries, friendlyError };
