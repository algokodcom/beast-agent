'use strict';

/* ---------- opencode permission/index.ts portu (birebir) ----------
   Kural şeması: { permission, pattern, action: 'allow' | 'deny' | 'ask' }
   Değerlendirme: kümeler düzleştirilir, SON eşleşen kural kazanır (findLast).
   Eşleşme yoksa varsayılan { action: 'ask', pattern: '*' }.

   fromConfig: { "*": "allow", read: { "*.env": "ask" }, bash: { "git push": "ask" } }
     → kural listesi (~/, $HOME genişletmesi dahil)
   merge: kümeleri sırayla birleştirir (sonraki öncekini gölgeler)
   disabled: ruleset'te pattern:'*' + deny olan ARAÇLARI bulur —
     opencode'da edit/write/apply_patch aynı "edit" iznine takılır,
     MCP resource araçları (list_mcp_resources vb.) "read" iznine. */

const os = require('os');

/* opencode core util/wildcard.ts portu — Windows'ta yolsayıç ayracı
   normalize edilir, * → .*, ? → ., " <-> sondaki " .*" opsiyonel grup */
function wildcardMatch(input, pattern) {
  const normalized = String(input).replaceAll('\\', '/');
  let escaped = String(pattern)
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?';
  return new RegExp('^' + escaped + '$', process.platform === 'win32' ? 'si' : 's').test(normalized);
}

/* opencode permission.evaluate — findLast: SON eşleşen kural kazanır */
function evaluate(permission, pattern, ...rulesets) {
  return (
    rulesets
      .flat()
      .findLast((rule) => wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern)) || {
      action: 'ask',
      permission,
      pattern: '*',
    }
  );
}

function expand(pattern) {
  if (pattern.startsWith('~/')) return os.homedir() + pattern.slice(1);
  if (pattern === '~') return os.homedir();
  if (pattern.startsWith('$HOME/')) return os.homedir() + pattern.slice(5);
  if (pattern.startsWith('$HOME')) return os.homedir() + pattern.slice(5);
  return pattern;
}

/* opencode permission.fromConfig — {"*":"allow"} veya {read:{"*.env":"ask"}} */
function fromConfig(permission) {
  const ruleset = [];
  if (!permission || typeof permission !== 'object') return ruleset;
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === 'string') {
      ruleset.push({ permission: key, action: value, pattern: '*' });
      continue;
    }
    if (value && typeof value === 'object') {
      for (const [pattern, action] of Object.entries(value)) {
        ruleset.push({ permission: key, pattern: expand(pattern), action: String(action) });
      }
    }
  }
  return ruleset;
}

/* opencode permission.merge — kümeleri sırayla birleştirir */
function merge(...rulesets) {
  return rulesets.flat();
}

/* opencode permission.disabled — ruleset'te * pattern ile deny edilmiş araç adları.
   edit/write/apply_patch "edit" iznine, MCP resource araçları "read" iznine indirgenir. */
function disabled(tools, ruleset) {
  const edits = ['edit', 'write', 'apply_patch'];
  const reads = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'];
  return new Set(
    (tools || []).filter((tool) => {
      const permission = edits.includes(tool) ? 'edit' : reads.includes(tool) ? 'read' : tool;
      const rule = (ruleset || []).findLast((r) => wildcardMatch(permission, r.permission));
      return rule && rule.pattern === '*' && rule.action === 'deny';
    })
  );
}

/* opencode permission.visibleTools — deny edilmişleri listeden düşürür */
function visibleTools(tools, ruleset) {
  const hidden = disabled(Object.keys(tools || {}), ruleset);
  return Object.fromEntries(Object.entries(tools || {}).filter(([name]) => !hidden.has(name)));
}

/* opencode v1/permission.ts hata metinleri — modele geri beslenir */
const MESSAGES = {
  rejected: 'The user rejected the permission request. Do not try this action again unless the user explicitly asks you to.',
  denied: 'Permission denied',
};

module.exports = {
  wildcardMatch,
  evaluate,
  fromConfig,
  merge,
  disabled,
  visibleTools,
  MESSAGES,
};
