'use strict';

/* OpenCode provider bridge.
 *
 * Beast chat speaks the OpenAI Chat Completions protocol. OpenCode Zen's free
 * models are only available through the real OpenCode client/server, so this
 * module runs `opencode serve` on localhost and exposes a tiny OpenAI-compatible
 * endpoint backed by OpenCode sessions.
 *
 * It intentionally does NOT spoof OpenCode headers or call Zen directly. The
 * child process is the official CLI, with a private config that installs a
 * text-only agent (no tools, one step). Beast tools are emulated through a JSON
 * protocol in the prompt and converted back to OpenAI tool_calls.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BRIDGE_PROVIDER_ID = 'preset-opencode-bridge';
const BRIDGE_AGENT_ID = 'beast-bridge';
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/* Current Zen free list (2026-10). The bridge refreshes this from /models when
 * possible; the static list is the offline fallback. */
const DEFAULT_FREE_MODELS = [
  'big-pickle',
  'beam-free',
  'flint-40b-free',
  'mimo-v2.6-flash-free',
  'nemotron-3.5-super-vl-free',
  'nemotron-3.5-lightning-free',
  'jev-1.13-free',
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
];

const BRIDGE_AGENT_SYSTEM = [
  'You are a text-only language model behind Beast Agent\'s OpenAI-compatible bridge.',
  'You do not have access to OpenCode tools. Never try to use a real tool.',
  'Follow the response protocol in the user message exactly. Answer the user directly.',
].join(' ');

function nowIso() {
  return new Date().toISOString();
}

function abortError() {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  e.code = 'ABORT_ERR';
  return e;
}

function isAbort(e) {
  return !!(e && (e.name === 'AbortError' || e.code === 'ABORT_ERR'));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, Number(ms) || 0));
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function makeAbort(signal, timeoutMs) {
  const ac = new AbortController();
  let timedOut = false;
  let timer = null;
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    if (timer.unref) timer.unref();
  }
  return {
    signal: ac.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

function truncate(value, max) {
  const s = String(value == null ? '' : value);
  const n = Number(max) || 0;
  if (n > 0 && s.length > n) return s.slice(0, n) + '\n[truncated]';
  return s;
}

function flattenContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (part.type === 'text') return String(part.text || '');
        if (part.type === 'image_url') return '[image omitted by OpenCode bridge]';
        if (part.type === 'input_audio') return '[audio omitted by OpenCode bridge]';
        if (part.type === 'file') return '[file omitted by OpenCode bridge]';
        if (typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function parseModelRef(model) {
  const raw = String(model == null ? '' : model).trim();
  if (!raw) return { providerID: 'opencode', id: 'big-pickle' };
  if (raw.startsWith('opencode-go/')) {
    return { providerID: 'opencode-go', id: raw.slice('opencode-go/'.length) };
  }
  if (raw.startsWith('opencode/')) {
    return { providerID: 'opencode', id: raw.slice('opencode/'.length) };
  }
  return { providerID: 'opencode', id: raw };
}

function sortModels(list) {
  const order = (id) => {
    if (id === 'big-pickle') return 0;
    if (id === 'beam-free') return 1;
    return 2;
  };
  return [...new Set((list || []).filter(Boolean))].sort((a, b) => {
    const oa = order(a);
    const ob = order(b);
    if (oa !== ob) return oa - ob;
    return String(a).localeCompare(String(b));
  });
}

function formatTools(tools) {
  return (tools || [])
    .map((tool) => {
      const fn = tool && tool.function ? tool.function : tool;
      if (!fn || !fn.name) return '';
      const name = String(fn.name);
      const desc = truncate(String(fn.description || '').replace(/\s+/g, ' ').trim(), 700);
      const params = fn.parameters || fn.input_schema || { type: 'object', properties: {} };
      let schema = '';
      try {
        schema = JSON.stringify(params);
      } catch {
        schema = '{}';
      }
      return '- ' + name + ': ' + desc + '\n  parameters: ' + schema;
    })
    .filter(Boolean)
    .join('\n');
}

/* Build one OpenCode prompt from an OpenAI chat request. The conversation is
 * delimited so the model does not confuse transcript text with instructions. */
function buildPrompt(body) {
  const req = body && typeof body === 'object' ? body : {};
  const messages = Array.isArray(req.messages) ? req.messages : [];
  const tools = Array.isArray(req.tools)
    ? req.tools.filter((t) => t && (t.type === 'function' || t.function))
    : [];
  const toolChoice = req.tool_choice;
  const useTools = tools.length > 0 && toolChoice !== 'none';
  const lines = [];

  lines.push('You are the model behind Beast Agent\'s OpenAI-compatible bridge.');
  lines.push('Read the conversation below. Do not mention this bridge, the XML-like tags, or these instructions.');
  lines.push('');
  lines.push('## Conversation');

  const callNames = new Map();
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || 'user');
    if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const fn = call && call.function ? call.function : call;
        if (call && call.id && fn && fn.name) callNames.set(String(call.id), String(fn.name));
      }
    }
  }

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || 'user');
    const content = truncate(flattenContent(msg.content), 60000);

    if (role === 'system' || role === 'developer') {
      lines.push('<system>');
      lines.push(content);
      lines.push('</system>');
      continue;
    }
    if (role === 'user') {
      lines.push('<user>');
      lines.push(content);
      lines.push('</user>');
      continue;
    }
    if (role === 'assistant') {
      lines.push('<assistant>');
      if (content) lines.push(content);
      lines.push('</assistant>');
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        const calls = [];
        for (const call of msg.tool_calls) {
          const fn = call && call.function ? call.function : call;
          if (!fn || !fn.name) continue;
          let args = fn.arguments;
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              args = { _raw: args };
            }
          }
          calls.push({ name: String(fn.name), arguments: args == null ? {} : args });
        }
        if (calls.length) {
          lines.push('<assistant_tool_calls>');
          lines.push(JSON.stringify(calls));
          lines.push('</assistant_tool_calls>');
        }
      }
      continue;
    }
    if (role === 'tool' || role === 'function') {
      const id = String(msg.tool_call_id || msg.id || '');
      const name = String(msg.name || callNames.get(id) || '');
      lines.push('<tool_result' + (id ? ' tool_call_id="' + id + '"' : '') + (name ? ' name="' + name + '"' : '') + '>');
      lines.push(content);
      lines.push('</tool_result>');
      continue;
    }
    lines.push('<' + role + '>');
    lines.push(content);
    lines.push('</' + role + '>');
  }

  lines.push('');
  if (useTools) {
    lines.push('## Response protocol');
    lines.push('You may request tools. The available tools are:');
    lines.push(formatTools(tools));
    lines.push('');
    lines.push('To call one or more tools, output ONLY a single JSON object in this exact shape:');
    lines.push('{"tool_calls":[{"name":"tool_name","arguments":{...}}]}');
    lines.push('Rules:');
    lines.push('- Use only the tool names listed above.');
    lines.push('- arguments must be a valid JSON object matching that tool\'s parameters.');
    lines.push('- Do not wrap the JSON in markdown fences. Do not add any other text.');
    lines.push('- If no tool is needed, answer normally in plain text.');
    if (toolChoice === 'required') lines.push('- You MUST call at least one tool.');
    if (toolChoice && typeof toolChoice === 'object' && toolChoice.function && toolChoice.function.name) {
      lines.push('- You MUST call the tool "' + String(toolChoice.function.name) + '".');
    }
  } else {
    lines.push('## Response protocol');
    lines.push('Answer normally in plain text. Do not output tool calls or JSON tool-call objects.');
  }
  if (req.response_format && req.response_format.type === 'json_object') {
    lines.push('Respond with a single valid JSON object and nothing else.');
  }
  lines.push('');
  lines.push('## Your response');
  lines.push('Respond now. Follow the response protocol above.');
  return lines.join('\n');
}

function stripCodeFences(text) {
  const s = String(text == null ? '' : text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  return s;
}

function findBalancedJson(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : '';
  if (!close) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function jsonCandidates(text) {
  const t = stripCodeFences(text);
  const out = [];
  if (!t) return out;
  try {
    out.push(JSON.parse(t));
  } catch {}
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '{' && t[i] !== '[') continue;
    const slice = findBalancedJson(t, i);
    if (!slice) continue;
    try {
      const parsed = JSON.parse(slice);
      if (!out.some((x) => JSON.stringify(x) === JSON.stringify(parsed))) out.push(parsed);
    } catch {}
  }
  return out;
}

function normalizeCall(call) {
  if (!call || typeof call !== 'object') return null;
  const fn = call.function && typeof call.function === 'object' ? call.function : call;
  const name = String(fn.name || call.name || '').trim();
  if (!name) return null;
  let args = fn.arguments !== undefined ? fn.arguments : call.arguments;
  if (args === undefined || args === null || args === '') args = {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  return { name, arguments: args };
}

/* Parse a prompt-emulated tool call. Accepts OpenAI's wrapped shape as well as
 * the compact shape the bridge asks the model to emit. */
function extractToolCalls(text, allowedNames) {
  const allowed =
    allowedNames instanceof Set ? allowedNames : new Set(Array.isArray(allowedNames) ? allowedNames : []);
  let whole = null;
  try {
    whole = JSON.parse(stripCodeFences(text));
  } catch {}
  for (const obj of jsonCandidates(text)) {
    if (!obj) continue;
    let raw = null;
    if (Array.isArray(obj)) raw = obj;
    else if (Array.isArray(obj.tool_calls)) raw = obj.tool_calls;
    else if (Array.isArray(obj.toolCalls)) raw = obj.toolCalls;
    else if (obj.function_call) raw = [obj.function_call];
    else if (obj.function && typeof obj.function === 'object' && obj.function.name) raw = [obj];
    else if (obj.name && obj.arguments !== undefined) {
      /* A bare {name, arguments} is only a tool call when it is the whole
         response (or a fenced block). Avoid treating arbitrary JSON in prose
         as a tool request. */
      let same = false;
      try { same = !!whole && JSON.stringify(obj) === JSON.stringify(whole); } catch {}
      if (!same) continue;
      raw = [obj];
    }
    if (!raw || !raw.length) continue;
    const calls = [];
    for (const item of raw) {
      const call = normalizeCall(item);
      if (!call) continue;
      if (allowed.size && !allowed.has(call.name)) continue;
      calls.push({
        id: 'call_' + crypto.randomBytes(12).toString('hex'),
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      });
    }
    if (calls.length) return calls;
  }
  return null;
}

function mapUsage(tokens, cost) {
  if (!tokens || typeof tokens !== 'object') return null;
  const input = Number(tokens.input) || 0;
  const output = Number(tokens.output) || 0;
  const reasoning = Number(tokens.reasoning) || 0;
  const cacheRead = Number(tokens.cache && tokens.cache.read) || 0;
  const cacheWrite = Number(tokens.cache && tokens.cache.write) || 0;
  const usage = {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  };
  if (cacheRead || cacheWrite) {
    usage.prompt_tokens_details = { cached_tokens: cacheRead, cache_write_tokens: cacheWrite };
  }
  if (reasoning) usage.completion_tokens_details = { reasoning_tokens: reasoning };
  const c = Number(cost);
  if (Number.isFinite(c) && c > 0) usage.cost = c;
  return usage;
}

function classifyBridgeError(err) {
  let status = Number(err && err.status) || 0;
  let message = String((err && err.message) || err || 'OpenCode bridge error');
  let raw = '';
  if (err && err.response) {
    if (typeof err.response === 'string') raw += ' ' + err.response;
    else if (typeof err.response === 'object') {
      try {
        raw += ' ' + JSON.stringify(err.response);
      } catch {}
      const body = err.response.body;
      if (typeof body === 'string') raw += ' ' + body;
    }
  }
  if (err && err.opencode) {
    try {
      raw += ' ' + JSON.stringify(err.opencode);
    } catch {}
  }
  raw += ' ' + message;

  if (!status) {
    if (/FreeUsageLimitError|free usage limit|usage[_ ]?limit/i.test(raw)) status = 429;
    else if (/insufficient[_ ]?fund|402|payment required/i.test(raw)) status = 402;
    else if (/active OpenCode Go subscription|403|forbidden/i.test(raw)) status = 403;
    else if (/invalid credential|401|unauthor/i.test(raw)) status = 401;
    else if (/model is unavailable|unknown model|model.*not found/i.test(raw)) status = 400;
    else status = 502;
  }

  let type = 'upstream_error';
  let code = '';
  if (status === 429) {
    type = 'rate_limit_error';
    code = 'free_usage_limit';
  } else if (status === 402) {
    type = 'insufficient_quota';
    code = 'insufficient_funds';
  } else if (status === 403) {
    type = 'permission_error';
    code = 'forbidden';
  } else if (status === 401) {
    type = 'authentication_error';
    code = 'invalid_api_key';
  } else if (status === 400) {
    type = 'invalid_request_error';
    code = 'model_unavailable';
  } else if (status === 404) {
    type = 'invalid_request_error';
    code = 'not_found';
  } else if (status === 504) {
    type = 'timeout_error';
    code = 'timeout';
  }

  if (err && err.response) {
    let parsed = null;
    if (typeof err.response === 'string') {
      try { parsed = JSON.parse(err.response); } catch {}
    } else if (typeof err.response === 'object') {
      const body = err.response.body;
      if (typeof body === 'string') {
        try { parsed = JSON.parse(body); } catch {}
      } else if (body && typeof body === 'object') {
        parsed = body;
      } else {
        parsed = err.response;
      }
    }
    const m = parsed && ((parsed.error && parsed.error.message) || parsed.message);
    if (m) message = String(m);
  }
  if (err && err.opencode && typeof err.opencode === 'object' && err.opencode.message) {
    message = String(err.opencode.message);
  }
  return { status, type, code, message: truncate(message, 1200) };
}

function findOpenCodeBin() {
  const env = String(process.env.OPENCODE_BIN || '').trim();
  if (env) return env;

  const exe = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const r = spawnSync(exe, ['opencode'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (r && r.status === 0 && r.stdout) {
      const lines = r.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const cmd = lines.find((p) => /\.cmd$/i.test(p)) || lines.find((p) => /\.exe$/i.test(p)) || lines[0];
      if (cmd && fs.existsSync(cmd)) return cmd;
    }
  } catch {}

  const home = process.env.USERPROFILE || process.env.HOME || '';
  const appdata = process.env.APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : '');
  const local = process.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '');
  const candidates = [
    appdata && path.join(appdata, 'npm', 'opencode.cmd'),
    appdata && path.join(appdata, 'npm', 'opencode'),
    local && path.join(local, 'npm', 'opencode.cmd'),
    home && path.join(home, '.local', 'bin', 'opencode'),
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function bridgeConfig() {
  return {
    $schema: 'https://opencode.ai/config.json',
    agent: {
      [BRIDGE_AGENT_ID]: {
        mode: 'primary',
        description: 'Text-only agent used by the Beast OpenAI-compatible bridge.',
        system: BRIDGE_AGENT_SYSTEM,
        steps: 1,
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
      },
    },
  };
}

class OpenCodeBridge {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || process.cwd();
    this.log = opts.log || console;
    this.opencodeBin = opts.opencodeBin || null;
    this.models = sortModels(Array.isArray(opts.models) && opts.models.length ? opts.models : DEFAULT_FREE_MODELS);
    this.timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
    this.workspace = path.join(this.dataDir, 'opencode-bridge', 'workspace');
    this.logFile = path.join(this.dataDir, 'opencode-bridge.log');
    this.server = null;
    this.port = 0;
    this.key = String(opts.key || '').trim() || 'beast-' + crypto.randomBytes(18).toString('hex');
    this.preferredPort = Number(opts.port) || 0;
    this.baseUrl = '';
    this.opencode = null;
    this.opencodePort = 0;
    this.opencodePassword = crypto.randomBytes(24).toString('base64url');
    this.opencodeBase = '';
    this._starting = null;
    this._stopping = false;
    this._logTail = [];
    this._stdoutBuf = '';
    this._stderrBuf = '';
  }

  info() {
    return {
      baseUrl: this.baseUrl,
      key: this.key,
      models: this.models.slice(),
      port: this.port,
      providerID: BRIDGE_PROVIDER_ID,
    };
  }

  _log(message, level) {
    const line = String(message == null ? '' : message);
    try {
      const fn = level === 'error' ? this.log.error : level === 'warn' ? this.log.warn : this.log.info;
      if (typeof fn === 'function') fn.call(this.log, 'opencode-bridge', line);
    } catch {}
    this._writeLog(level || 'info', line);
  }

  _writeLog(level, line) {
    try {
      fs.appendFile(
        this.logFile,
        '[' + nowIso() + '] [' + (level || 'info') + '] ' + String(line) + '\n',
        () => {}
      );
    } catch {}
  }

  _tail() {
    return this._logTail.slice(-6).join(' | ');
  }

  _capture(chunk, stream) {
    const key = stream === 'stderr' ? '_stderrBuf' : '_stdoutBuf';
    this[key] += String(chunk == null ? '' : chunk);
    const parts = this[key].split(/\r?\n/);
    this[key] = parts.pop() || '';
    for (const raw of parts) {
      const line = raw.trim();
      if (!line) continue;
      const safe = line
        .replace(/server password\s+\S+/gi, 'server password <redacted>')
        .replace(/password[=:]\s*\S+/gi, 'password=<redacted>');
      this._logTail.push(safe.slice(0, 2000));
      if (this._logTail.length > 80) this._logTail.shift();
      this._writeLog(stream === 'stderr' ? 'warn' : 'info', 'opencode: ' + safe.slice(0, 1000));
      if (/error|failed|fatal|listening|ready/i.test(safe)) {
        this._log('opencode: ' + safe.slice(0, 600), /error|failed|fatal/i.test(safe) ? 'warn' : 'info');
      }
    }
  }

  async start() {
    if (this.server && this.port) return this.info();
    try {
      await fs.promises.mkdir(this.workspace, { recursive: true });
    } catch {}

    const server = http.createServer((req, res) => {
      this._onRequest(req, res).catch((e) => {
        this._log('request handler error: ' + ((e && e.stack) || e), 'error');
        if (!res.headersSent) {
          try {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Bridge internal error', type: 'server_error' } }));
          } catch {}
        } else {
          try { res.end(); } catch {}
        }
      });
    });
    server.on('clientError', (err, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
    });
    const listen = (port) =>
      new Promise((resolve, reject) => {
        const onError = (e) => {
          server.off('listening', onListening);
          reject(e);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });

    try {
      await listen(this.preferredPort);
    } catch (e) {
      if (e && e.code === 'EADDRINUSE' && this.preferredPort) {
        this._log('bridge port ' + this.preferredPort + ' dolu — rastgele porta geçiliyor', 'warn');
        await listen(0);
      } else {
        throw e;
      }
    }
    this.server = server;
    this.port = server.address().port;
    this.baseUrl = 'http://127.0.0.1:' + this.port + '/v1';
    this._log('bridge listening on ' + this.baseUrl);

    /* HTTP server is already accepting; model refresh can take a few seconds
       and must not block a previously registered provider from working. */
    try {
      await this.refreshModels();
    } catch {}
    return this.info();
  }

  async stop() {
    this._stopping = true;
    /* Start the taskkill immediately; Electron may quit before the HTTP server
       close callback runs, and the child must not be left orphaned. */
    const killed = this._killOpenCode();
    if (this.server) {
      const server = this.server;
      this.server = null;
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      } catch {}
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
    await killed;
    this.port = 0;
    this.baseUrl = '';
    this._stopping = false;
  }

  async refreshModels() {
    try {
      const ab = makeAbort(null, 15000);
      let res;
      try {
        res = await fetch('https://opencode.ai/zen/v1/models', {
          /* Public model catalog only. Chat requests go through the real
             OpenCode server; no client-identity headers are forged here. */
          headers: { authorization: 'Bearer public' },
          signal: ab.signal,
        });
      } finally {
        ab.cleanup();
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const ids = (json && Array.isArray(json.data) ? json.data : [])
        .map((m) => (typeof m === 'string' ? m : m && m.id))
        .filter(Boolean);
      const free = ids.filter(
        (id) => /-free$/i.test(id) || id === 'big-pickle' || id === 'beam-free'
      );
      if (free.length) {
        this.models = sortModels(free);
        this._log('models refreshed: ' + this.models.length + ' free models');
      }
    } catch (e) {
      this._log('model refresh failed: ' + String((e && e.message) || e), 'warn');
    }
    return this.models.slice();
  }

  async ensureOpenCode() {
    if (this.opencode && this.opencodeBase) {
      try {
        await this._oc('GET', '/api/info', undefined, { timeoutMs: 5000 });
        return { baseUrl: this.opencodeBase, port: this.opencodePort };
      } catch {
        await this._killOpenCode();
      }
    }
    if (!this._starting) {
      this._starting = this._startOpenCode().finally(() => {
        this._starting = null;
      });
    }
    return this._starting;
  }

  _spawnOpenCode(bin, args, env) {
    const opts = {
      cwd: this.workspace,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
      const cmd = process.env.ComSpec || 'cmd.exe';
      const quote = (a) => {
        const s = String(a);
        return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const line = '"' + bin + '" ' + args.map(quote).join(' ');
      return spawn(cmd, ['/d', '/s', '/c', line], {
        ...opts,
        windowsVerbatimArguments: true,
      });
    }
    return spawn(bin, args, opts);
  }

  async _startOpenCode() {
    const bin = this.opencodeBin || findOpenCodeBin();
    if (!bin) {
      throw new Error('OpenCode CLI bulunamadı. Kurulum: npm install -g opencode-ai');
    }
    this.opencodeBin = bin;
    try {
      await fs.promises.mkdir(this.workspace, { recursive: true });
    } catch {}

    const env = { ...process.env };
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_DISABLE_FREE_MODELS;
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(bridgeConfig());
    env.OPENCODE_PASSWORD = this.opencodePassword;
    /* Use the CLI build's own artifact name. Forcing OPENCODE_CLIENT changes the
       User-Agent / x-opencode-client identity and free-model quota is tied to the
       official client identity. */
    delete env.OPENCODE_CLIENT;

    const port = await getFreePort();
    const args = ['serve', '--hostname', '127.0.0.1', '--port', String(port)];
    this._log('starting opencode: ' + bin + ' ' + args.join(' '));
    const child = this._spawnOpenCode(bin, args, env);
    this.opencode = child;
    this.opencodePort = port;
    this.opencodeBase = 'http://127.0.0.1:' + port;
    this._stdoutBuf = '';
    this._stderrBuf = '';
    if (child.stdout) child.stdout.on('data', (d) => this._capture(d, 'stdout'));
    if (child.stderr) child.stderr.on('data', (d) => this._capture(d, 'stderr'));
    child.on('error', (e) => {
      this._log('opencode spawn error: ' + String((e && e.message) || e), 'error');
      if (this.opencode === child) this.opencode = null;
    });
    child.on('exit', (code, signal) => {
      this._log('opencode exited code=' + code + ' signal=' + signal, code === 0 ? 'info' : 'warn');
      if (this.opencode === child) this.opencode = null;
    });

    try {
      await this._waitForOpenCode();
    } catch (e) {
      await this._killOpenCode();
      throw e;
    }
    this._log('opencode ready on ' + this.opencodeBase);
    return { baseUrl: this.opencodeBase, port: this.opencodePort };
  }

  async _waitForOpenCode() {
    const deadline = Date.now() + 30000;
    let lastErr = null;
    while (Date.now() < deadline) {
      if (!this.opencode) {
        throw new Error('OpenCode sunucusu başlamadan kapandı' + (this._tail() ? ': ' + this._tail() : ''));
      }
      try {
        const ab = makeAbort(null, 2500);
        let res;
        try {
          res = await fetch(this.opencodeBase + '/api/info', {
            headers: { authorization: this._basicAuth() },
            signal: ab.signal,
          });
        } finally {
          ab.cleanup();
        }
        if (res.ok) return;
        lastErr = new Error('HTTP ' + res.status);
      } catch (e) {
        lastErr = e;
      }
      await sleep(300);
    }
    throw new Error(
      'OpenCode sunucusu açılmadı: ' +
        String((lastErr && lastErr.message) || 'zaman aşımı') +
        (this._tail() ? ' — ' + this._tail() : '')
    );
  }

  async _killOpenCode() {
    const child = this.opencode;
    this.opencode = null;
    this.opencodeBase = '';
    this.opencodePort = 0;
    if (!child || !child.pid) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 2000).unref?.();
      }
    } catch {}
    await sleep(150);
  }

  _basicAuth() {
    return 'Basic ' + Buffer.from('opencode:' + this.opencodePassword).toString('base64');
  }

  async _oc(method, endpoint, body, opts = {}) {
    if (!this.opencodeBase) await this.ensureOpenCode();
    const ab = makeAbort(opts.signal, opts.timeoutMs || 30000);
    const headers = { authorization: this._basicAuth() };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      const res = await fetch(this.opencodeBase + endpoint, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ab.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch {}
        const msg =
          (parsed && parsed.error && parsed.error.message) ||
          (parsed && parsed.message) ||
          truncate(text, 500) ||
          'HTTP ' + res.status;
        const err = new Error(msg);
        err.status = res.status;
        err.response = parsed || text;
        throw err;
      }
      if (!text) return null;
      try { return JSON.parse(text); } catch { return text; }
    } catch (e) {
      if (ab.timedOut()) {
        const err = new Error('OpenCode isteği zaman aşımına uğradı');
        err.status = 504;
        throw err;
      }
      throw e;
    } finally {
      ab.cleanup();
    }
  }

  async createSession(modelRef, opts = {}) {
    const out = await this._oc(
      'POST',
      '/api/session',
      {
        agent: BRIDGE_AGENT_ID,
        model: modelRef,
        title: 'Beast bridge ' + nowIso(),
        location: { directory: this.workspace },
      },
      { signal: opts.signal, timeoutMs: 30000 }
    );
    const id = out && out.data && out.data.id;
    if (!id) throw new Error('OpenCode oturum kimliği alınamadı');
    return String(id);
  }

  async deleteSession(sessionID) {
    if (!sessionID) return;
    try {
      await this._oc('DELETE', '/api/session/' + encodeURIComponent(sessionID), undefined, {
        timeoutMs: 10000,
      });
    } catch {}
  }

  async _consumeEvents(reader, sessionID, opts = {}) {
    const decoder = new TextDecoder();
    let buf = '';
    let terminal = false;
    let text = '';
    let reasoning = '';
    let usage = null;
    let finishReason = null;
    let error = null;
    const parts = new Map();

    const handle = (ev) => {
      if (!ev || typeof ev !== 'object') return;
      const data = ev.data;
      if (!data || data.sessionID !== sessionID) return;
      switch (ev.type) {
        case 'session.text.delta': {
          const delta = String(data.delta || '');
          const key = String(data.assistantMessageID || '') + ':' + String(data.ordinal == null ? 0 : data.ordinal);
          parts.set(key, (parts.get(key) || '') + delta);
          text += delta;
          if (delta && opts.onText) opts.onText(delta);
          break;
        }
        case 'session.text.ended': {
          const full = String(data.text || '');
          const key = String(data.assistantMessageID || '') + ':' + String(data.ordinal == null ? 0 : data.ordinal);
          if (!parts.get(key) && full) {
            parts.set(key, full);
            text += full;
            if (opts.onText) opts.onText(full);
          }
          break;
        }
        case 'session.reasoning.delta': {
          const delta = String(data.delta || '');
          reasoning += delta;
          if (delta && opts.onReasoning) opts.onReasoning(delta);
          break;
        }
        case 'session.usage.updated': {
          usage = mapUsage(data.tokens, data.cost) || usage;
          break;
        }
        case 'session.step.ended': {
          if (data.tokens) usage = mapUsage(data.tokens, data.cost) || usage;
          if (data.finish) finishReason = String(data.finish);
          break;
        }
        case 'session.step.failed': {
          if (data.tokens) usage = mapUsage(data.tokens, data.cost) || usage;
          if (data.error) error = data.error;
          terminal = true;
          break;
        }
        case 'session.execution.failed': {
          if (data.error) error = data.error;
          terminal = true;
          break;
        }
        case 'session.execution.interrupted': {
          error = { type: 'interrupted', message: 'OpenCode isteği kesildi' };
          terminal = true;
          break;
        }
        case 'session.execution.succeeded': {
          terminal = true;
          break;
        }
        case 'session.status': {
          if (data.status && data.status.type === 'idle') terminal = true;
          break;
        }
        case 'session.idle': {
          terminal = true;
          break;
        }
        default:
          break;
      }
    };

    try {
      while (!terminal) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try { handle(JSON.parse(payload)); } catch {}
        }
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return { text, reasoning, usage, finishReason, error };
  }

  async _runPrompt(modelRef, prompt, opts = {}) {
    const external = opts.signal;
    let sentText = false;
    const wrapped = {
      ...opts,
      onText: (d) => {
        if (!opts.onText) return;
        sentText = true;
        opts.onText(d);
      },
    };
    const attempts = opts.retry === false ? 1 : 2;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (external && external.aborted) throw abortError();
      let sessionID = null;
      let reader = null;
      const ab = makeAbort(external, this.timeoutMs);
      try {
        sessionID = await this.createSession(modelRef, { signal: ab.signal });

        const evRes = await fetch(this.opencodeBase + '/api/event', {
          headers: { authorization: this._basicAuth() },
          signal: ab.signal,
        });
        if (!evRes.ok) {
          const body = await evRes.text().catch(() => '');
          const err = new Error(
            'OpenCode event akışı açılamadı (HTTP ' + evRes.status + ')' + (body ? ': ' + truncate(body, 300) : '')
          );
          err.status = evRes.status;
          throw err;
        }
        reader = evRes.body.getReader();

        await this._oc(
          'POST',
          '/api/session/' + encodeURIComponent(sessionID) + '/prompt',
          { text: prompt },
          { signal: ab.signal, timeoutMs: 30000 }
        );

        const result = await this._consumeEvents(reader, sessionID, wrapped);
        reader = null;
        if (result.error) {
          const err = new Error(result.error.message || 'OpenCode error');
          err.status = result.error.status;
          err.response = result.error.response;
          err.opencode = result.error;
          throw err;
        }
        return result;
      } catch (e) {
        if (ab.timedOut()) {
          const err = new Error('OpenCode isteği zaman aşımına uğradı (' + Math.round(this.timeoutMs / 1000) + ' sn)');
          err.status = 504;
          lastError = err;
        } else if (isAbort(e)) {
          if (external && external.aborted) throw e;
          lastError = e;
        } else {
          lastError = e;
        }
        const classified = classifyBridgeError(lastError);
        const retryable =
          !sentText &&
          attempt < attempts &&
          (classified.status === 429 || classified.status >= 500);
        if (!retryable) throw lastError;
        this._log(
          'prompt retry ' + attempt + '/' + attempts + ' after ' + classified.status + ': ' + classified.message.slice(0, 240),
          'warn'
        );
        await sleep(1500 * attempt, external);
      } finally {
        ab.cleanup();
        if (reader) {
          try { await reader.cancel(); } catch {}
        }
        if (sessionID) this.deleteSession(sessionID);
      }
    }
    throw lastError || new Error('OpenCode bridge error');
  }

  _writeSSE(res, obj) {
    if (res.writableEnded || res.destroyed) return false;
    try {
      res.write('data: ' + JSON.stringify(obj) + '\n\n');
      return true;
    } catch {
      return false;
    }
  }

  _sseHeaders(res) {
    if (res.headersSent) return;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
  }

  _sendError(res, status, message, type, code) {
    if (res.headersSent || res.writableEnded) return;
    const body = {
      error: {
        message: String(message || 'OpenCode bridge error'),
        type: type || 'upstream_error',
        code: code || undefined,
      },
    };
    try {
      res.writeHead(status || 502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    } catch {}
  }

  _writeAuth(res, status, message) {
    if (res.headersSent || res.writableEnded) return;
    try {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': 'Bearer',
      });
      res.end(JSON.stringify({ error: { message, type: 'authentication_error' } }));
    } catch {}
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let done = false;
      const fail = (e) => {
        if (done) return;
        done = true;
        reject(e);
      };
      req.on('data', (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          const e = new Error('Request body too large');
          e.status = 413;
          fail(e);
          try { req.destroy(); } catch {}
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) return resolve({});
        try {
          resolve(JSON.parse(text));
        } catch {
          const e = new Error('Invalid JSON body');
          e.status = 400;
          reject(e);
        }
      });
      req.on('error', fail);
      req.on('aborted', () => fail(abortError()));
    });
  }

  async _handleChat(req, res, body) {
    const modelRef = parseModelRef(body.model);
    const stream = body.stream === true;
    const tools = Array.isArray(body.tools)
      ? body.tools.filter((t) => t && (t.type === 'function' || t.function))
      : [];
    const useTools = tools.length > 0 && body.tool_choice !== 'none';
    const allowed = new Set(
      tools.map((t) => String((t.function && t.function.name) || t.name || '')).filter(Boolean)
    );
    const prompt = buildPrompt(body);
    const requestID = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
    const created = Math.floor(Date.now() / 1000);
    const modelName = String(body.model || modelRef.id);

    const clientAbort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) clientAbort.abort();
    };
    res.on('close', onClose);

    let headersSent = false;
    let roleSent = false;
    let sentText = '';
    const startSSE = () => {
      if (headersSent) return;
      headersSent = true;
      this._sseHeaders(res);
      roleSent = true;
      this._writeSSE(res, {
        id: requestID,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      });
    };
    const sendContent = (delta) => {
      if (!stream || !delta) return;
      startSSE();
      sentText += delta;
      this._writeSSE(res, {
        id: requestID,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      });
    };
    const sendReasoning = (delta) => {
      if (!stream || !delta) return;
      startSSE();
      this._writeSSE(res, {
        id: requestID,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }],
      });
    };
    const sendToolCalls = (calls) => {
      startSSE();
      this._writeSSE(res, {
        id: requestID,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: calls.map((c, i) => ({
                index: i,
                id: c.id,
                type: 'function',
                function: c.function,
              })),
            },
            finish_reason: null,
          },
        ],
      });
    };
    const finish = (finishReason, usage) => {
      if (!stream) return;
      startSSE();
      this._writeSSE(res, {
        id: requestID,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason || 'stop' }],
        ...(usage ? { usage } : {}),
      });
      try {
        if (!res.writableEnded && !res.destroyed) res.write('data: [DONE]\n\n');
      } catch {}
      try { res.end(); } catch {}
    };

    try {
      const result = await this._runPrompt(modelRef, prompt, {
        signal: clientAbort.signal,
        onText: useTools ? null : sendContent,
        onReasoning: sendReasoning,
      });

      const calls = useTools ? extractToolCalls(result.text, allowed) : null;
      const finishReason = calls
        ? 'tool_calls'
        : result.finishReason === 'length'
          ? 'length'
          : result.finishReason === 'content-filter'
            ? 'content_filter'
            : 'stop';

      if (stream) {
        if (calls) {
          sendToolCalls(calls);
        } else if (useTools && result.text && !sentText) {
          sendContent(result.text);
        }
        finish(finishReason, result.usage);
      } else {
        const message = { role: 'assistant', content: calls ? null : result.text || '' };
        if (calls) message.tool_calls = calls;
        if (result.reasoning) message.reasoning_content = result.reasoning;
        const payload = {
          id: requestID,
          object: 'chat.completion',
          created,
          model: modelName,
          choices: [{ index: 0, message, finish_reason: finishReason }],
        };
        if (result.usage) payload.usage = result.usage;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      }
    } catch (e) {
      const classified = classifyBridgeError(e);
      if (isAbort(e) && clientAbort.signal.aborted) {
        try { res.end(); } catch {}
        return;
      }
      if (!stream || !headersSent) {
        this._sendError(res, classified.status, classified.message, classified.type, classified.code);
        return;
      }
      /* Headers already went out; surface the error as visible text instead of
         leaving the client with a silently truncated stream. */
      sendContent('\n\n[OpenCode error] ' + classified.message);
      finish('stop', null);
    } finally {
      res.removeListener('close', onClose);
    }
  }

  async _onRequest(req, res) {
    let url;
    try {
      url = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      this._sendError(res, 400, 'Bad request URL', 'invalid_request_error');
      return;
    }
    const pathname = url.pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }
    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          bridge: true,
          opencode: !!this.opencode,
          models: this.models.length,
        })
      );
      return;
    }

    const auth = String(req.headers.authorization || '');
    if (auth !== 'Bearer ' + this.key) {
      this._writeAuth(res, 401, 'Invalid bridge key');
      return;
    }

    if (pathname === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: this.models.map((id) => ({
            id,
            object: 'model',
            created: 0,
            owned_by: 'opencode',
          })),
        })
      );
      return;
    }

    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      let body;
      try {
        body = await this._readBody(req);
      } catch (e) {
        this._sendError(res, e.status || 400, e.message || 'Invalid request', 'invalid_request_error');
        return;
      }
      if (!body || typeof body !== 'object') {
        this._sendError(res, 400, 'JSON object body required', 'invalid_request_error');
        return;
      }
      await this._handleChat(req, res, body);
      return;
    }

    this._sendError(res, 404, 'Not found', 'invalid_request_error', 'not_found');
  }
}

module.exports = {
  OpenCodeBridge,
  BRIDGE_PROVIDER_ID,
  BRIDGE_AGENT_ID,
  DEFAULT_FREE_MODELS,
  BRIDGE_AGENT_SYSTEM,
  buildPrompt,
  parseModelRef,
  extractToolCalls,
  mapUsage,
  classifyBridgeError,
  flattenContent,
  findOpenCodeBin,
  getFreePort,
  sortModels,
  stripCodeFences,
};
