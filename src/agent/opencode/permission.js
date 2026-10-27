'use strict';

/* ---------- opencode v2.1.4 permission portu ----------
   Kaynak: packages/core/src/permission.ts + packages/schema/src/permission.ts
           + packages/core/src/util/wildcard.ts

   Kural şeması (v2.1.4): { action, resource, effect: 'allow' | 'deny' | 'ask' }
   Değerlendirme: kümeler düzleştirilir, SON eşleşen kural kazanır (findLast).
   Eşleşme yoksa varsayılan { action, resource: '*', effect: 'ask' }.

   fromConfig: { "*": "allow", read: { "*.env": "ask" }, shell: { "git push": "ask" } }
     → kural listesi (~/, $HOME genişletmesi kaynakta read/load anında yapılır)
   merge: kümeleri sırayla birleştirir (sonraki öncekini gölgeler)
   whollyDisabled: bir aracın TAMAMEN kapalı olup olmadığı — eşleşen son kural
     resource:'*' + effect:'deny' ise araç istek listesinden düşer (opencode tool.ts:293). */

const os = require('os');

/* opencode util/wildcard.ts birebir */
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

/* opencode Permission.evaluate(action, resource, ...rulesets) */
function evaluate(action, resource, ...rulesets) {
  return (
    rulesets
      .flat()
      .findLast((rule) => rule && wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource)) || {
      action,
      resource: '*',
      effect: 'ask',
    }
  );
}

function merge(...rulesets) {
  return rulesets.filter(Boolean).flat();
}

function expand(resource) {
  if (resource.startsWith('~/')) return os.homedir() + resource.slice(1);
  if (resource === '~') return os.homedir();
  if (resource.startsWith('$HOME/')) return os.homedir() + resource.slice(5);
  if (resource.startsWith('$HOME')) return os.homedir() + resource.slice(5);
  return resource;
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const action = String(rule.action ?? '');
  const resource = String(rule.resource ?? '*');
  const effect = String(rule.effect ?? '');
  if (!action || !['allow', 'deny', 'ask'].includes(effect)) return null;
  return { action, resource, effect };
}

/* opencode config normalize: { "*": "allow" } veya { read: { "*.env": "ask" } }
   Native dizi ({action,resource,effect}[]) de kabul edilir. */
function fromConfig(permission) {
  if (Array.isArray(permission)) return permission.map(normalizeRule).filter(Boolean);
  if (!permission || typeof permission !== 'object') return [];
  const ruleset = [];
  for (const [action, value] of Object.entries(permission)) {
    if (typeof value === 'string') {
      ruleset.push({ action, resource: '*', effect: value });
      continue;
    }
    if (value && typeof value === 'object') {
      for (const [resource, effect] of Object.entries(value)) {
        ruleset.push({ action, resource: expand(resource), effect: String(effect) });
      }
    }
  }
  return ruleset;
}

/* opencode config migrate: write ve patch aynı "edit" iznine iner */
const TOOL_ACTION = { write: 'edit', patch: 'edit' };
function actionForTool(name) {
  return TOOL_ACTION[name] || String(name || '');
}

/* opencode tool.ts whollyDisabled(action, rules) */
function whollyDisabled(action, ruleset) {
  const rule = (ruleset || []).findLast((rule) => rule && wildcardMatch(action, rule.action));
  return !!(rule && rule.resource === '*' && rule.effect === 'deny');
}

/* opencode Tool.snapshot: araç adı veya options.permission ile tamamen kapalı */
function disabled(tools, ruleset) {
  return new Set((tools || []).filter((tool) => whollyDisabled(actionForTool(tool), ruleset)));
}

function visibleTools(tools, ruleset) {
  const hidden = disabled(Object.keys(tools || {}), ruleset);
  return Object.fromEntries(Object.entries(tools || {}).filter(([name]) => !hidden.has(name)));
}

/* opencode permission.ts hata metinleri (modele geri beslenir) */
const MESSAGES = {
  blocked: (action) => `Permission denied: ${action}`,
  declined: 'The user rejected the permission request.',
  corrected: (feedback) => String(feedback || ''),
};

module.exports = {
  wildcardMatch,
  evaluate,
  merge,
  fromConfig,
  actionForTool,
  whollyDisabled,
  disabled,
  visibleTools,
  MESSAGES,
};
