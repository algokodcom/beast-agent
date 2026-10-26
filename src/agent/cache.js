'use strict';

/* Beast prompt-cache policy — OpenCode v2.1.4 portu.
   Kaynak: packages/ai/src/cache-policy.ts + protocols/utils/cache.ts

   OpenCode'un "auto" politikası, isteğin önek-cache'e uygun dört sınırına
   `cache_control` işareti koyar:
     - son araç tanımı (araç şemaları öneki)
     - ilk ve son system parçası (ajan + proje talimatı öneki)
     - konuşma kuyruğu (son mesaj)
   En fazla 4 kırılım noktası vardır; elle konmuş işaretler bu bütçeden düşer.

   Beast yalnız OpenAI-uyumlu /chat/completions konuşur. Satır içi
   `cache_control` işaretlerini YALNIZCA bunu gerçekten kabul eden rotalara
   gönderiyoruz (OpenRouter Anthropic/Qwen, DigitalOcean, Alibaba Qwen).
   OpenAI/Gemini/DeepSeek/GLM/Kimi gibi sağlayıcılar önek cache'ini kendileri
   yönetir; onlara bilinmeyen alan göndermek 400'e yol açabilir. Onlar için
   llm.js'deki mevcut yol korunur: destekleyenlerde oturum-sabit
   `prompt_cache_key`, tümünde oturum affinite başlıkları.

   İşaretler her istekte mesajların KOPYASINA uygulanır; oturum geçmişi asla
   değişmez. Böylece aynı istek yeniden denendiğinde işaretler çoğalmaz. */

const BREAKPOINT_CAP = 4;

const AUTO = { tools: true, system: true, messages: { tail: 1 } };
const QWEN = { tools: false, system: true, messages: { tail: 1 } };
const NONE = { tools: false, system: false, messages: null };

function lower(v) {
  return String(v == null ? '' : v).toLowerCase();
}

function finiteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function hostOf(url) {
  try {
    return lower(new URL(String(url || '')).hostname);
  } catch {
    return '';
  }
}

function modelId(sel) {
  return lower(sel && sel.model).replace(/^~/, '').trim();
}

function gatewayPolicy(model) {
  const id = model.replace(/^~/, '');
  if (id.startsWith('anthropic/') || /(^|\/)claude[-.]/.test(id) || id === 'claude') return AUTO;
  if (id.startsWith('qwen/') || id.startsWith('alibaba/qwen')) return QWEN;
  return NONE;
}

function opencodePolicy(model) {
  /* Zen / Zen Go: Anthropic ailesi için işaretler destekleniyor; GLM, Kimi,
     DeepSeek ve MiniMax önek cache'ini kendiliğinden yönetiyor. */
  if (model.startsWith('anthropic/') || /(^|\/)claude[-.]/.test(model)) return AUTO;
  if (model.startsWith('qwen/') || model.startsWith('qwen') || model.startsWith('alibaba/qwen')) return QWEN;
  return NONE;
}

/* explicitPolicy: config.yaml'da provider bazlı `cache:` / `cache_format:`
   verilmişse rota tahminini ezer. Örnek:
     cache: anthropic       → tools + system + tail
     cache: alibaba         → system + tail, araçlar işaretsiz
     cache: none            → hiç işaret yok
     cache_format: anthropic
   Değer nesne de olabilir: { tools:true, system:true, messages:{tail:1}, ttlSeconds:3600 } */
function explicitPolicy(sel) {
  const raw = sel && (sel.cache ?? sel.cachePolicy);
  const format = lower(sel && (sel.cacheFormat ?? sel.cache_format));
  const rawText = lower(raw);
  if (raw === false || raw === 0 || rawText === 'false' || rawText === 'none' || rawText === 'off' || rawText === '0') {
    return NONE;
  }
  if (raw && typeof raw === 'object') {
    const o = raw;
    if (o.messages === undefined && !o.tools && !o.system) return NONE;
    return {
      tools: o.tools === true,
      system: o.system === true,
      messages: o.messages === true ? { tail: 1 } : o.messages === undefined ? null : o.messages,
      ttlSeconds: finiteNumber(o.ttlSeconds),
    };
  }
  if (raw === 'anthropic') return AUTO;
  if (raw === 'alibaba' || raw === 'qwen') return QWEN;
  if (raw === 'auto' || raw === true || rawText === 'auto' || rawText === 'true' || rawText === 'on') {
    return null; /* rota politikasına bırak */
  }
  if (format === 'anthropic') return AUTO;
  if (format === 'alibaba' || format === 'qwen') return QWEN;
  return null;
}

function routeFor(sel) {
  const host = hostOf(sel && sel.url);
  const pid = lower(sel && sel.providerId);
  const model = modelId(sel);

  if (/openrouter/.test(pid) || /(^|\.)openrouter\.ai$/.test(host)) {
    return { id: 'openrouter', policy: gatewayPolicy(model) };
  }
  if (/alibaba|dashscope|qwen/.test(pid) || /dashscope|aliyuncs\.com/.test(host)) {
    return { id: 'alibaba', policy: model.startsWith('qwen') || /(^|\/)qwen/.test(model) ? QWEN : NONE };
  }
  if (/digitalocean/.test(pid) || /digitalocean/.test(host)) {
    return { id: 'digitalocean', policy: AUTO };
  }
  if (/opencode/.test(pid) || /(^|\.)opencode\.ai$/.test(host)) {
    return { id: 'opencode', policy: opencodePolicy(model) };
  }
  if (/vercel/.test(pid) || /(^|\.)vercel\.sh$/.test(host)) {
    /* Beast burada /chat/completions kullanır; Vercel'in Anthropic-messages
       cache biçimini garanti edemeyiz. Yalnızca açık cache_format ile. */
    return { id: 'vercel', policy: NONE };
  }
  return { id: 'openai-compatible', policy: NONE };
}

function policyFor(sel) {
  const explicit = explicitPolicy(sel);
  if (explicit) return explicit;
  return routeFor(sel).policy;
}

function ttlFor(sel, policy) {
  const raw =
    (policy && finiteNumber(policy.ttlSeconds)) ??
    finiteNumber(sel && (sel.cacheTtlSeconds ?? sel.cache_ttl_seconds));
  return raw;
}

function makeHint(ttlSeconds) {
  const hint = { type: 'ephemeral' };
  if (ttlSeconds !== undefined && ttlSeconds >= 3600) hint.ttl = '1h';
  return hint;
}

function isMarker(v) {
  return !!(v && typeof v === 'object' && v.type === 'ephemeral');
}

function countToolMarkers(tools) {
  if (!Array.isArray(tools)) return 0;
  let n = 0;
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    if (isMarker(t.cache_control)) n++;
    if (Array.isArray(t.tools)) n += countToolMarkers(t.tools);
  }
  return n;
}

function countContentMarkers(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p && isMarker(p.cache_control)) n++;
    }
  }
  return n;
}

function countMarkers(messages, tools) {
  return countToolMarkers(tools) + countContentMarkers(messages);
}

function markLastTool(tools, hint, budget) {
  if (!Array.isArray(tools) || tools.length === 0 || budget.remaining <= 0) return tools;
  const i = tools.length - 1;
  const target = tools[i];
  if (!target || typeof target !== 'object') return tools;
  if (Array.isArray(target.tools)) {
    const nested = markLastTool(target.tools, hint, budget);
    if (nested === target.tools) return tools;
    const out = tools.slice();
    out[i] = { ...target, tools: nested };
    return out;
  }
  if (isMarker(target.cache_control)) return tools;
  budget.remaining--;
  const out = tools.slice();
  out[i] = { ...target, cache_control: hint };
  return out;
}

function markPart(part, hint) {
  if (!part || typeof part !== 'object' || isMarker(part.cache_control)) return part;
  return { ...part, cache_control: hint };
}

function contentParts(m) {
  if (typeof m.content === 'string') {
    return [{ type: 'text', text: m.content }];
  }
  if (Array.isArray(m.content)) return m.content;
  return null;
}

function withParts(m, parts) {
  return { ...m, content: parts };
}

function markSystem(messages, hint, budget) {
  if (!Array.isArray(messages) || budget.remaining <= 0) return messages;
  /* OpenCode auto politikası system'in İLK ve SON metin parçasını işaretler
     (birden çok system mesajı olsa bile yalnızca iki sınır). Tek parçalı
     system'da ilk = son olduğu için tek işaret kalır. */
  const all = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'system') continue;
    const parts = contentParts(m);
    if (!parts) continue;
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j];
      if (p && p.type === 'text') all.push({ mi: i, pi: j });
    }
  }
  if (all.length === 0) return messages;

  const first = all[0];
  const last = all[all.length - 1];
  const targets = first.mi === last.mi && first.pi === last.pi ? [first] : [first, last];
  const out = messages.slice();
  const seen = new Map();

  for (const target of targets) {
    if (budget.remaining <= 0) break;
    const key = target.mi;
    let parts = seen.get(key);
    if (!parts) {
      parts = contentParts(out[target.mi]).slice();
      seen.set(key, parts);
    }
    if (isMarker(parts[target.pi] && parts[target.pi].cache_control)) continue;
    parts[target.pi] = markPart(parts[target.pi], hint);
    budget.remaining--;
  }

  let changed = false;
  for (const [mi, parts] of seen) {
    const m = out[mi];
    if (!m) continue;
    out[mi] = withParts(m, parts);
    changed = true;
  }
  return changed ? out : messages;
}

function markMessageAt(messages, index, hint, budget) {
  if (!Array.isArray(messages) || budget.remaining <= 0) return messages;
  const m = messages[index];
  if (!m || m.role === 'system') return messages;
  const parts = contentParts(m);
  if (!parts || parts.length === 0) return messages;

  let pi = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p && p.type === 'text') {
      pi = i;
      break;
    }
  }
  /* Anthropic mesajlarında cache_control text parçasına konur. Görsel/medya
     parçasına işaret koymuyoruz (bazı uyumlu sağlayıcılar reddeder).
     Son text parçası elle işaretliyse dokunma — OpenCode markMessageAt gibi. */
  if (pi < 0 || isMarker(parts[pi].cache_control)) return messages;
  const next = parts.slice();
  next[pi] = markPart(next[pi], hint);
  budget.remaining--;
  const out = messages.slice();
  out[index] = withParts(m, next);
  return out;
}

function markTail(messages, strategy, hint, budget) {
  if (!Array.isArray(messages) || budget.remaining <= 0) return messages;
  if (strategy === 'latest-user-message') {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user') return markMessageAt(messages, i, hint, budget);
    }
    return messages;
  }
  if (strategy === 'latest-assistant') {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'assistant') return markMessageAt(messages, i, hint, budget);
    }
    return messages;
  }
  const tail = Math.max(0, Math.min(16, Number(strategy && strategy.tail) || 0));
  if (tail <= 0) return messages;
  let next = messages;
  let start = messages.length;
  let remaining = tail;
  while (remaining > 0 && start > 0) {
    start--;
    if (messages[start] && messages[start].role !== 'system') remaining--;
  }
  for (let i = start; i < messages.length && budget.remaining > 0; i++) {
    next = markMessageAt(next, i, hint, budget);
  }
  return next;
}

function applyCachePolicy(messages, tools, sel, opts = {}) {
  const route = routeFor(sel || {});
  const policy = opts.policy || policyFor(sel || {});
  let msgs = Array.isArray(messages) ? messages : [];
  const toolList = tools;

  if (
    opts.disabled ||
    !policy ||
    (policy.tools !== true && policy.system !== true && !policy.messages)
  ) {
    return {
      messages,
      tools,
      applied: false,
      route: route.id,
      policy: policy || NONE,
      markers: 0,
    };
  }

  const hint = makeHint(opts.ttlSeconds !== undefined ? opts.ttlSeconds : ttlFor(sel, policy));
  const budget = { remaining: Math.max(0, BREAKPOINT_CAP - countMarkers(msgs, toolList)) };
  const before = budget.remaining;
  const nextTools = policy.tools ? markLastTool(toolList, hint, budget) : toolList;
  const withSystem = policy.system ? markSystem(msgs, hint, budget) : msgs;
  const nextMessages = policy.messages ? markTail(withSystem, policy.messages, hint, budget) : withSystem;
  const markers = before - budget.remaining;

  return {
    messages: nextMessages,
    tools: nextTools,
    applied: markers > 0,
    route: route.id,
    policy,
    markers,
  };
}

function wantsCacheControl(sel) {
  const p = policyFor(sel || {});
  return !!(p && (p.tools === true || p.system === true || !!p.messages));
}

/* Cache kullanım alanlarını tek biçime indirger. Sağlayıcılar farklı yerlerde
   bildirir: OpenAI prompt_tokens_details.cached_tokens, DeepSeek
   prompt_cache_hit_tokens, Zai cached_tokens, Anthropic/OpenRouter
   cache_read_input_tokens + cache_creation_input_tokens. */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return usage || null;
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
  const cached =
    finiteNumber(details.cached_tokens) ??
    finiteNumber(usage.prompt_cache_hit_tokens) ??
    finiteNumber(usage.cached_tokens) ??
    finiteNumber(usage.cache_read_input_tokens) ??
    finiteNumber(usage.cache_read_tokens);
  const written =
    finiteNumber(details.cache_write_tokens) ??
    finiteNumber(usage.cache_creation_input_tokens) ??
    finiteNumber(usage.cache_created_input_tokens) ??
    finiteNumber(usage.cache_write_tokens);

  if (cached === undefined && written === undefined) return usage;

  const out = { ...usage };
  out.cacheReadTokens = cached ?? 0;
  out.cacheWriteTokens = written ?? 0;
  const prompt = finiteNumber(usage.prompt_tokens);
  const input = finiteNumber(usage.input_tokens);
  if (prompt !== undefined) {
    /* OpenAI/DeepSeek/DigitalOcean: prompt_tokens toplam girdidir; cache
       okuma/yazma bunun alt kümesidir. */
    out.nonCachedInputTokens = Math.max(0, prompt - out.cacheReadTokens - out.cacheWriteTokens);
  } else if (input !== undefined) {
    /* Anthropic: input_tokens cache DIŞI girdidir; cache_read/creation ayrı
       raporlanır. Diğer input_tokens kullanımlarında toplam kabul et. */
    const anthropicStyle =
      usage.cache_read_input_tokens !== undefined ||
      usage.cache_creation_input_tokens !== undefined;
    out.nonCachedInputTokens = anthropicStyle
      ? Math.max(0, input)
      : Math.max(0, input - out.cacheReadTokens - out.cacheWriteTokens);
  }
  return out;
}

module.exports = {
  BREAKPOINT_CAP,
  AUTO,
  QWEN,
  NONE,
  policyFor,
  routeFor,
  wantsCacheControl,
  applyCachePolicy,
  normalizeUsage,
  makeHint,
  countMarkers,
};
