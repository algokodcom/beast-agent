'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/* Minimal indentation-based YAML parser, sufficient for Beast's config.yaml
   (nested maps, lists of scalars/maps, quoted/plain scalars, inline {} / []). */

function beastDir() {
  if (process.env.BEAST_DATA) return process.env.BEAST_DATA;
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, 'beast')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'beast');
}

function parseScalar(raw) {
  let s = String(raw).trim();
  if (s === '{}' || s === '[]') return s === '{}' ? {} : [];
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length > 1) ||
    (s.startsWith("'") && s.endsWith("'") && s.length > 1)
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function stripComment(line) {
  let out = '';
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += c;
  }
  return out.replace(/\s+$/, '');
}

function tokenize(text) {
  const recs = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    const line = stripComment(rawLine);
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    const content = line.trim();
    if (content.startsWith('- ') || content === '-') {
      recs.push({ indent, listItem: true, value: content === '-' ? '' : content.slice(2).trim() });
    } else {
      const m = content.match(/^([^:]+):\s*(.*)$/);
      if (!m) continue;
      recs.push({
        indent,
        listItem: false,
        key: m[1].trim().replace(/^["']|["']$/g, ''),
        value: m[2],
      });
    }
  }
  return recs;
}

function build(recs, startIdx, indent) {
  // Decide container kind from first record
  const first = recs[startIdx];
  if (!first) return [{}, startIdx];
  if (first.listItem) {
    const arr = [];
    let i = startIdx;
    while (i < recs.length && recs[i].indent >= indent && recs[i].listItem) {
      const r = recs[i];
      if (r.value === '') {
        // list of maps: subsequent deeper records belong to this item
        const deeper = [];
        let j = i + 1;
        while (j < recs.length && recs[j].indent > r.indent) {
          deeper.push(recs[j]);
          j++;
        }
        const [obj] = build(deeper, 0, deeper.length ? deeper[0].indent : 0);
        arr.push(obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {});
        i = j;
      } else if (/^([^:]+):\s*(.*)$/.test(r.value) && !/^https?:/.test(r.value)) {
        // inline "key: value" inside list item -> single-key map
        const m = r.value.match(/^([^:]+):\s*(.*)$/);
        const obj = { [m[1].trim().replace(/^["']|["']$/g, '')]: parseScalar(m[2]) };
        // absorb following deeper keys into same item
        let j = i + 1;
        while (j < recs.length && recs[j].indent > r.indent && !recs[j].listItem) {
          const rr = recs[j];
          obj[rr.key] = rr.value === '' ? null : parseScalar(rr.value);
          j++;
        }
        arr.push(obj);
        i = Math.max(i + 1, j);
      } else {
        arr.push(parseScalar(r.value));
        i++;
      }
    }
    return [arr, i];
  }

  const map = {};
  let i = startIdx;
  while (i < recs.length && recs[i].indent >= indent && !recs[i].listItem) {
    const r = recs[i];
    if (r.indent > indent) {
      i++; // stray deeper record, skip defensively
      continue;
    }
    if (r.value !== undefined && r.value.trim() !== '') {
      map[r.key] = parseScalar(r.value);
      i++;
    } else {
      // nested block: collect all deeper records
      const deeper = [];
      let j = i + 1;
      while (j < recs.length && recs[j].indent > r.indent) {
        deeper.push(recs[j]);
        j++;
      }
      if (deeper.length) {
        const [child, consumed] = build(deeper, 0, deeper[0].indent);
        map[r.key] = child;
        i = i + 1 + consumed;
      } else {
        map[r.key] = {};
        i++;
      }
    }
  }
  return [map, i - startIdx];
}

function parseYaml(text) {
  try {
    const recs = tokenize(text);
    const [out] = build(recs, 0, recs.length ? recs[0].indent : 0);
    return out || {};
  } catch {
    return {};
  }
}

function parseEnvFile(file) {
  const env = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      env[m[1]] = val;
    }
  } catch {}
  return env;
}

function chatCompletionsUrl(base) {
  let b = String(base).trim().replace(/\/+$/, '');
  if (/\/v\d+$/.test(b)) return b + '/chat/completions';
  return b + '/v1/chat/completions';
}

function resolveProviders(cfg, env) {
  const candidates = [];
  for (const [id, p] of Object.entries(cfg.providers || {})) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || !p.base_url) continue;
    let key = p.key_env ? env[p.key_env] : null;
    if (!key) key = env[`${id.toUpperCase().replace(/-/g, '_')}_API_KEY`];
    if (!key) continue;
    const models = new Set();
    if (p.model) models.add(p.model);
    for (const k of Object.keys(p.models || {})) models.add(k);
    if (models.size === 0 && cfg.model && cfg.model.default) models.add(cfg.model.default);
    candidates.push({
      id,
      name: p.name || id,
      baseUrl: p.base_url,
      url: chatCompletionsUrl(p.base_url),
      key,
      models: [...models],
      /* opsiyonel 1M-token fiyatları: maliyet sayacı için */
      costIn: Number(p.price_in) || null,
      costOut: Number(p.price_out) || null,
    });
  }
  return candidates;
}

const CFG_TEMPLATE = `# Beast Agent sağlayıcı yapılandırması
# Anahtarlar .env dosyasında (key_env ile eşleşir). Örnek:
#
# providers:
#   zhipu:
#     name: Zhipu AI
#     base_url: https://api.z.ai/api/paas/v4
#     key_env: ZHIPU_API_KEY
#     models:
#       glm-4.6: {}
#
# model:
#   provider: zhipu        # varsayılan provider id
#   default: glm-4.6       # varsayılan model

providers: {}
`;

const ENV_TEMPLATE = `# Beast Agent API anahtarları (Bu dosyayı kimseyle paylaşma!)
# Provider'ın key_env alanıyla eşleşmeli; yoksa <PROVIDER>_API_KEY denenir.
# Örnek:
# ZHIPU_API_KEY=xxxxx
# OPENAI_API_KEY=sk-xxx
`;

function loadBeastConfig() {
  const dataDir = beastDir();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch {}
  const cfgPath = path.join(dataDir, 'config.yaml');
  const envPath = path.join(dataDir, '.env');

  try {
    if (!fs.existsSync(cfgPath)) fs.writeFileSync(cfgPath, CFG_TEMPLATE);
    if (!fs.existsSync(envPath)) fs.writeFileSync(envPath, ENV_TEMPLATE);
  } catch {}

  let cfg = {};
  try {
    cfg = parseYaml(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}

  const env = { ...parseEnvFile(envPath) };
  for (const [k, v] of Object.entries(process.env)) {
    if (!(k in env) && typeof v === 'string') env[k] = v;
  }

  const providers = resolveProviders(cfg, env);
  const m = cfg.model || {};

  let active = m.provider ? providers.find((p) => p.id === m.provider) : null;
  if (!active && providers.length) active = providers[0];

  let activeSelection = null;
  if (active) {
    const keyOverride = m.key_env ? env[m.key_env] : null;
    activeSelection = {
      providerId: active.id,
      providerName: active.name,
      model: m.default || active.models[0],
      url: m.base_url ? chatCompletionsUrl(m.base_url) : active.url,
      key: keyOverride || active.key,
      costIn: active.costIn,
      costOut: active.costOut,
    };
  }

  const chain = [];
  if (activeSelection) chain.push(activeSelection);
  for (const p of providers) {
    if (active && p.id === active.id) continue;
    for (const model of p.models.slice(0, 3)) {
      chain.push({ providerId: p.id, providerName: p.name, model, url: p.url, key: p.key, costIn: p.costIn, costOut: p.costOut });
    }
  }

  return { dataDir, configPath: cfgPath, envPath, providers, chain, defaultSelection: activeSelection || chain[0] || null };
}

module.exports = { parseYaml, parseEnvFile, loadBeastConfig, beastDir, chatCompletionsUrl };
