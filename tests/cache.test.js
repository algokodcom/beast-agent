'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const cache = require('../src/agent/cache');

const OR = {
  providerId: 'openrouter',
  model: 'anthropic/claude-3.5-sonnet',
  url: 'https://openrouter.ai/api/v1/chat/completions',
};

const messages = () => [
  { role: 'system', content: 'Beast system prompt' },
  { role: 'user', content: 'ilk soru' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'dosya içeriği' },
];

const tools = () => [
  { type: 'function', function: { name: 'read_file', description: 'oku', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'write_file', description: 'yaz', parameters: { type: 'object' } } },
];

test('cache: rota politikası OpenCode auto/qwen/none ayrımını izler', () => {
  assert.deepStrictEqual(cache.policyFor(OR), cache.AUTO);
  assert.deepStrictEqual(
    cache.policyFor({ ...OR, model: 'qwen/qwen3-coder' }),
    cache.QWEN
  );
  assert.deepStrictEqual(
    cache.policyFor({ ...OR, model: 'deepseek/deepseek-chat' }),
    cache.NONE
  );
  assert.deepStrictEqual(
    cache.policyFor({
      providerId: 'alibaba',
      model: 'qwen3-coder-plus',
      url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    }),
    cache.QWEN
  );
  assert.deepStrictEqual(
    cache.policyFor({
      providerId: 'alibaba',
      model: 'alibaba/qwen3-coder',
      url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
    }),
    cache.QWEN
  );
  assert.deepStrictEqual(
    cache.policyFor({
      providerId: 'opencode',
      model: 'alibaba/qwen3-coder',
      url: 'https://opencode.ai/zen/v1/chat/completions',
    }),
    cache.QWEN
  );
  assert.deepStrictEqual(
    cache.policyFor({
      providerId: 'opencode',
      model: 'glm-5.2',
      url: 'https://opencode.ai/zen/v1/chat/completions',
    }),
    cache.NONE
  );
  assert.deepStrictEqual(
    cache.policyFor({
      providerId: 'opencode',
      model: 'claude-sonnet-4-5',
      url: 'https://opencode.ai/zen/v1/chat/completions',
    }),
    cache.AUTO
  );
  assert.deepStrictEqual(
    cache.policyFor({ providerId: 'custom', model: 'gpt-4o', url: 'https://api.openai.com/v1/chat/completions' }),
    cache.NONE
  );
  assert.strictEqual(cache.wantsCacheControl(OR), true);
  assert.strictEqual(cache.wantsCacheControl({ ...OR, model: 'deepseek/deepseek-chat' }), false);
});

test('cache: auto son aracı, system sınırını ve konuşma kuyruğunu işaretler', () => {
  const msgs = messages();
  const tls = tools();
  const res = cache.applyCachePolicy(msgs, tls, OR);

  assert.strictEqual(res.applied, true);
  assert.strictEqual(res.route, 'openrouter');
  assert.strictEqual(res.markers, 3);

  /* son araç işaretli, önceki değil */
  assert.strictEqual(res.tools[0].cache_control, undefined);
  assert.deepStrictEqual(res.tools[1].cache_control, { type: 'ephemeral' });

  /* system string → text parçası + cache_control */
  assert.deepStrictEqual(res.messages[0].content, [
    { type: 'text', text: 'Beast system prompt', cache_control: { type: 'ephemeral' } },
  ]);

  /* yalnızca son mesaj (tool sonucu) kuyruk işareti alır */
  assert.strictEqual(typeof res.messages[1].content, 'string');
  assert.strictEqual(res.messages[2].content, null);
  assert.deepStrictEqual(res.messages[3].content, [
    { type: 'text', text: 'dosya içeriği', cache_control: { type: 'ephemeral' } },
  ]);
});

test('cache: uygulama girdileri mutasyona uğratmaz ve idempotenttir', () => {
  const msgs = messages();
  const tls = tools();
  const msgsBefore = JSON.parse(JSON.stringify(msgs));
  const tlsBefore = JSON.parse(JSON.stringify(tls));

  const one = cache.applyCachePolicy(msgs, tls, OR);
  assert.deepStrictEqual(msgs, msgsBefore, 'oturum mesajları değişmemeli');
  assert.deepStrictEqual(tls, tlsBefore, 'araç şemaları değişmemeli');

  const two = cache.applyCachePolicy(one.messages, one.tools, OR);
  assert.strictEqual(two.markers, 0);
  assert.strictEqual(cache.countMarkers(two.messages, two.tools), 3);
  assert.deepStrictEqual(two.messages, one.messages);
  assert.deepStrictEqual(two.tools, one.tools);
});

test('cache: kuyruğun son text parçası elle işaretliyse ikinci işaret eklenmez', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'ilk parça' },
        { type: 'text', text: 'son parça', cache_control: { type: 'ephemeral' } },
      ],
    },
  ];
  const res = cache.applyCachePolicy(msgs, [], {
    ...OR,
    cache: { system: false, tools: false, messages: { tail: 1 } },
  });
  assert.strictEqual(res.markers, 0);
  assert.deepStrictEqual(res.messages, msgs);
});

test('cache: elle konmuş işaretler dört kırılım bütçesinden düşer', () => {
  const msgs = [
    {
      role: 'system',
      content: [
        { type: 'text', text: 'Base agent' },
        { type: 'text', text: 'Manual context', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'Project instructions' },
      ],
    },
    { role: 'user', content: 'hi' },
  ];
  const tls = [
    { type: 'function', function: { name: 'a', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'b', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'c', parameters: { type: 'object' } } },
  ];
  const res = cache.applyCachePolicy(msgs, tls, OR);
  assert.ok(cache.countMarkers(res.messages, res.tools) <= cache.BREAKPOINT_CAP);
  assert.strictEqual(cache.countMarkers(res.messages, res.tools), 4);
  /* manuel işaret korunur; system ilk/son sınırlarına eklenir, tail ve son araç girer */
  assert.deepStrictEqual(res.messages[0].content[1].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepStrictEqual(res.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.deepStrictEqual(res.messages[0].content[2].cache_control, { type: 'ephemeral' });
  /* dört sınır dolduğu için kuyruk işaretsiz kalır (OpenCode ile aynı) */
  assert.strictEqual(res.messages[1].content, 'hi');
  assert.deepStrictEqual(res.tools[2].cache_control, { type: 'ephemeral' });
});

test('cache: 1 saat TTL yalnızca cache_ttl_seconds >= 3600 iken gönderilir', () => {
  const short = cache.applyCachePolicy(messages(), tools(), { ...OR, cacheTtlSeconds: 300 });
  const long = cache.applyCachePolicy(messages(), tools(), { ...OR, cacheTtlSeconds: 3600 });
  assert.deepStrictEqual(short.tools[1].cache_control, { type: 'ephemeral' });
  assert.deepStrictEqual(long.tools[1].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('cache: provider config cache/cache_format ile rota tahminini ezer', () => {
  const openai = {
    providerId: 'custom',
    model: 'claude-3-5-sonnet',
    url: 'https://example.test/v1/chat/completions',
  };
  assert.deepStrictEqual(cache.policyFor(openai), cache.NONE);
  assert.deepStrictEqual(cache.policyFor({ ...openai, cache: 'anthropic' }), cache.AUTO);
  assert.deepStrictEqual(cache.policyFor({ ...openai, cache_format: 'anthropic' }), cache.AUTO);
  assert.deepStrictEqual(cache.policyFor({ ...openai, cache: 'alibaba' }), cache.QWEN);
  assert.deepStrictEqual(cache.policyFor({ ...OR, cache: 'none' }), cache.NONE);
  assert.deepStrictEqual(cache.policyFor({ ...OR, cache: 'false' }), cache.NONE);
  assert.deepStrictEqual(cache.policyFor({ ...openai, cache: 'auto' }), cache.NONE);
  const tailOnly = cache.policyFor({ ...openai, cache: { messages: true } });
  assert.strictEqual(tailOnly.tools, false);
  assert.strictEqual(tailOnly.system, false);
  assert.deepStrictEqual(tailOnly.messages, { tail: 1 });
  assert.strictEqual(
    cache.wantsCacheControl({ ...openai, cache: 'none' }),
    false
  );
});

test('cache: kullanım alanları OpenAI/DeepSeek/Anthropic/DigitalOcean biçimlerinden normalize edilir', () => {
  const openai = cache.normalizeUsage({
    prompt_tokens: 1000,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 800 },
  });
  assert.strictEqual(openai.cacheReadTokens, 800);
  assert.strictEqual(openai.cacheWriteTokens, 0);
  assert.strictEqual(openai.nonCachedInputTokens, 200);

  const deepseek = cache.normalizeUsage({
    prompt_tokens: 500,
    prompt_cache_hit_tokens: 300,
    prompt_cache_miss_tokens: 200,
  });
  assert.strictEqual(deepseek.cacheReadTokens, 300);
  assert.strictEqual(deepseek.nonCachedInputTokens, 200);

  const anthropic = cache.normalizeUsage({
    input_tokens: 100,
    cache_read_input_tokens: 400,
    cache_creation_input_tokens: 50,
  });
  assert.strictEqual(anthropic.cacheReadTokens, 400);
  assert.strictEqual(anthropic.cacheWriteTokens, 50);
  assert.strictEqual(anthropic.nonCachedInputTokens, 100);

  const digitalocean = cache.normalizeUsage({
    prompt_tokens: 100,
    cache_read_input_tokens: 20,
    cache_created_input_tokens: 10,
  });
  assert.strictEqual(digitalocean.cacheReadTokens, 20);
  assert.strictEqual(digitalocean.cacheWriteTokens, 10);

  assert.strictEqual(cache.normalizeUsage(null), null);
  assert.deepStrictEqual(cache.normalizeUsage({ prompt_tokens: 1 }), { prompt_tokens: 1 });
});
