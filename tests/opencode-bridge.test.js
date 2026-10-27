'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const {
  OpenCodeBridge,
  BRIDGE_PROVIDER_ID,
  DEFAULT_FREE_MODELS,
  buildPrompt,
  parseModelRef,
  extractToolCalls,
  mapUsage,
  classifyBridgeError,
  flattenContent,
  sortModels,
  stripCodeFences,
  getFreePort,
} = require('../src/agent/opencode-bridge');

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
};

test('opencode bridge: model ref ayrıştırma', () => {
  assert.deepStrictEqual(parseModelRef('opencode/big-pickle'), {
    providerID: 'opencode',
    id: 'big-pickle',
  });
  assert.deepStrictEqual(parseModelRef('opencode-go/beam-free'), {
    providerID: 'opencode-go',
    id: 'beam-free',
  });
  assert.deepStrictEqual(parseModelRef('big-pickle'), {
    providerID: 'opencode',
    id: 'big-pickle',
  });
  assert.deepStrictEqual(parseModelRef(''), {
    providerID: 'opencode',
    id: 'big-pickle',
  });
});

test('opencode bridge: free model sıralaması big-pickle/beam-free önde', () => {
  const out = sortModels(['z-free', 'beam-free', 'big-pickle', 'z-free', 'a-free']);
  assert.deepStrictEqual(out, ['big-pickle', 'beam-free', 'a-free', 'z-free']);
  assert.ok(DEFAULT_FREE_MODELS.includes('big-pickle'));
});

test('opencode bridge: flattenContent metin/dizi/nesne', () => {
  assert.equal(flattenContent('merhaba'), 'merhaba');
  assert.equal(
    flattenContent([
      { type: 'text', text: 'bir' },
      { type: 'image_url', image_url: { url: 'x' } },
      { type: 'text', text: 'iki' },
    ]),
    'bir\n[image omitted by OpenCode bridge]\niki'
  );
  assert.equal(flattenContent({ text: 'nesne' }), 'nesne');
  assert.equal(flattenContent(null), '');
});

test('opencode bridge: prompt konuşma + araç protokolü içerir', () => {
  const prompt = buildPrompt({
    messages: [
      { role: 'system', content: 'Sistem talimatı' },
      { role: 'user', content: 'İstanbul hava durumu?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Istanbul"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":22}' },
    ],
    tools: [weatherTool],
    tool_choice: 'auto',
  });
  assert.match(prompt, /<system>\nSistem talimatı\n<\/system>/);
  assert.match(prompt, /<user>\nİstanbul hava durumu\?\n<\/user>/);
  assert.match(prompt, /<assistant_tool_calls>/);
  assert.match(prompt, /get_weather/);
  assert.match(prompt, /<tool_result tool_call_id="call_1" name="get_weather">/);
  assert.match(prompt, /Response protocol/);
  assert.match(prompt, /"tool_calls":\[\{"name":"tool_name","arguments":\{\.\.\.\}\}\]/);
  assert.match(prompt, /Do not wrap the JSON in markdown fences/);
});

test('opencode bridge: araç yokken JSON tool call yasak', () => {
  const prompt = buildPrompt({
    messages: [{ role: 'user', content: 'selam' }],
  });
  assert.match(prompt, /Do not output tool calls or JSON tool-call objects/);
  assert.doesNotMatch(prompt, /"tool_calls":\[\{"name":"tool_name"/);
});

test('opencode bridge: tool_choice required ve json_object', () => {
  const prompt = buildPrompt({
    messages: [{ role: 'user', content: 'selam' }],
    tools: [weatherTool],
    tool_choice: 'required',
    response_format: { type: 'json_object' },
  });
  assert.match(prompt, /You MUST call at least one tool/);
  assert.match(prompt, /Respond with a single valid JSON object and nothing else/);
});

test('opencode bridge: kompakt tool call ayrıştırma', () => {
  const calls = extractToolCalls(
    '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Istanbul"}}]}',
    new Set(['get_weather'])
  );
  assert.ok(Array.isArray(calls));
  assert.equal(calls.length, 1);
  assert.match(calls[0].id, /^call_/);
  assert.equal(calls[0].type, 'function');
  assert.equal(calls[0].function.name, 'get_weather');
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { city: 'Istanbul' });
});

test('opencode bridge: OpenAI sarmalı ve code fence tool call', () => {
  const wrapped =
    '```json\n' +
    JSON.stringify({
      tool_calls: [
        {
          id: 'call_x',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Ankara"}' },
        },
      ],
    }) +
    '\n```';
  const calls = extractToolCalls(wrapped, new Set(['get_weather']));
  assert.ok(calls);
  assert.equal(calls[0].function.name, 'get_weather');
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { city: 'Ankara' });
});

test('opencode bridge: doğrudan nesne ve bilinmeyen araç reddi', () => {
  const direct = extractToolCalls(
    '{"name":"get_weather","arguments":{"city":"Izmir"}}',
    new Set(['get_weather'])
  );
  assert.ok(direct);
  assert.equal(direct[0].function.name, 'get_weather');

  const unknown = extractToolCalls(
    '{"tool_calls":[{"name":"delete_everything","arguments":{}}]}',
    new Set(['get_weather'])
  );
  assert.equal(unknown, null);
});

test('opencode bridge: bozuk/boş tool call null döner', () => {
  assert.equal(extractToolCalls('', new Set(['get_weather'])), null);
  assert.equal(extractToolCalls('düz metin cevap', new Set(['get_weather'])), null);
  assert.equal(
    extractToolCalls('{"tool_calls":[{"name":"get_weather","arguments":"bozuk"}]}', new Set(['get_weather'])),
    null
  );
  assert.equal(stripCodeFences('```json\n{"a":1}\n```'), '{"a":1}');
});

test('opencode bridge: usage eşleme', () => {
  const usage = mapUsage(
    {
      input: 10,
      output: 5,
      reasoning: 2,
      cache: { read: 3, write: 4 },
    },
    0.01
  );
  assert.deepStrictEqual(usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 2 },
    cost: 0.01,
  });
  assert.equal(mapUsage(null, 0), null);
});

test('opencode bridge: hata sınıflandırma', () => {
  const e429 = new Error('Free usage limit reached');
  e429.status = 429;
  assert.equal(classifyBridgeError(e429).type, 'rate_limit_error');
  assert.equal(classifyBridgeError(e429).code, 'free_usage_limit');

  const e402 = new Error('insufficient funds');
  e402.status = 402;
  assert.equal(classifyBridgeError(e402).type, 'insufficient_quota');

  const e403 = new Error('active OpenCode Go subscription required');
  e403.status = 403;
  assert.equal(classifyBridgeError(e403).type, 'permission_error');

  const e401 = new Error('invalid credential');
  e401.status = 401;
  assert.equal(classifyBridgeError(e401).type, 'authentication_error');

  assert.equal(classifyBridgeError(new Error('FreeUsageLimitError')).status, 429);
  assert.equal(classifyBridgeError(new Error('random failure')).status, 502);
});

test('opencode bridge: hata gövdesinden mesaj çıkarır', () => {
  const e = new Error('HTTP 429');
  e.status = 429;
  e.response = { error: { message: 'Free usage limit reached. Reset soon.' } };
  const out = classifyBridgeError(e);
  assert.equal(out.status, 429);
  assert.equal(out.message, 'Free usage limit reached. Reset soon.');
});

test('opencode bridge: constructor key/port/models seçenekleri', () => {
  const b = new OpenCodeBridge({
    dataDir: process.cwd(),
    key: 'stable-bridge-key-123456',
    port: 18646,
    models: ['z-free', 'big-pickle'],
    log: { info() {}, warn() {}, error() {} },
  });
  const info = b.info();
  assert.equal(info.key, 'stable-bridge-key-123456');
  assert.equal(info.providerID, BRIDGE_PROVIDER_ID);
  assert.equal(info.port, 0);
  assert.equal(b.preferredPort, 18646);
  assert.deepStrictEqual(info.models, ['big-pickle', 'z-free']);
});

test('opencode bridge: boş port bulunur', async () => {
  const port = await getFreePort();
  assert.ok(Number.isInteger(port));
  assert.ok(port > 0);
});

test('opencode bridge: HTTP server key/auth ve port fallback', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-bridge-test-'));
  const preferred = await getFreePort();
  const quiet = { info() {}, warn() {}, error() {} };
  const b1 = new OpenCodeBridge({
    dataDir: dir,
    key: 'stable-key-for-test-123456',
    port: preferred,
    log: quiet,
  });
  b1.refreshModels = async () => b1.models;
  const b2 = new OpenCodeBridge({
    dataDir: dir,
    key: 'second-key-for-test-123456',
    port: preferred,
    log: quiet,
  });
  b2.refreshModels = async () => b2.models;
  try {
    const info1 = await b1.start();
    assert.equal(info1.port, preferred);
    assert.equal(info1.key, 'stable-key-for-test-123456');

    const health = await fetch('http://127.0.0.1:' + info1.port + '/health');
    assert.equal(health.status, 200);
    const denied = await fetch(info1.baseUrl + '/models');
    assert.equal(denied.status, 401);
    const ok = await fetch(info1.baseUrl + '/models', {
      headers: { authorization: 'Bearer ' + info1.key },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.some((m) => m.id === 'big-pickle'));

    const info2 = await b2.start();
    assert.notEqual(info2.port, preferred);
    assert.ok(info2.port > 0);
  } finally {
    await b1.stop();
    await b2.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
