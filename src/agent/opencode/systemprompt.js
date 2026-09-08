'use strict';

/* ---------- opencode session/system.ts + reminders.ts portu (birebir) ----------
   Beast Code (bcCode) oturumlarında system prompt artık TEK elle yazılmış
   metin değil, opencode birleşimidir (prompt.ts:1257-1269):

     system = [ ...environment(model),            → bu modül
                ...instructions(AGENTS.md),        → engine._projectInstructions
                ...(skills kataloğu),             → bu modül (skill/skill.ts fmt)
                ...ajan tanımının promptu ]       → agents.js (explore vb.)

   Ana prompt MODEL BAZLI seçilir (system.ts:27-49): gpt-4 ailesi, o1, o3 → beast.txt,
   gpt* → gpt.txt (codex* → codex.txt), gemini-* → gemini.txt, claude →
   anthropic.txt, kimi → kimi.txt, muse → meta.txt, trinity → trinity.txt,
   diğer → default.txt.

   Reminders (reminders.ts:15-90): plan ajanındaysa son user mesajına plan.txt
   synthetic part'ı; geçmişte plan koşmuşsa ve şimdi build'se build-switch.txt
   eklenir. Belleği kirletmemek için payload ÖNCESİ kopya mesajlara uygulanır
   (her tur taze — opencode her turda DB'den yeniden yükleyip uygular). */

const fs = require('fs');
const path = require('path');
const Permission = require('./permission');

const PROMPT_DIR = path.join(__dirname, 'prompts');
function loadPrompt(name) {
  try {
    let t = fs.readFileSync(path.join(PROMPT_DIR, name), 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // BOM-strip
    return t.replace(/\s+$/, '');
  } catch {
    return '';
  }
}

const PROMPTS = {
  beast: loadPrompt('beast.txt'),
  gpt: loadPrompt('gpt.txt'),
  codex: loadPrompt('codex.txt'),
  anthropic: loadPrompt('anthropic.txt'),
  gemini: loadPrompt('gemini.txt'),
  kimi: loadPrompt('kimi.txt'),
  meta: loadPrompt('meta.txt'),
  trinity: loadPrompt('trinity.txt'),
  default: loadPrompt('default.txt'),
  plan: loadPrompt('plan.txt'),
  buildSwitch: loadPrompt('build-switch.txt'),
  explore: loadPrompt('explore.txt'),
};

/* opencode system.ts:27-49 — model-bazlı prompt seçimi (birebir) */
function provider(modelId) {
  const id = String(modelId || '');
  if (id.includes('muse')) {
    const name = id.includes('muse-glimmer') ? 'Muse Glimmer' : 'Muse Spark';
    return [PROMPTS.meta.replaceAll('{{MODEL_NAME}}', name)];
  }
  if (id.includes('gpt-4') || id.includes('o1') || id.includes('o3')) return [PROMPTS.beast];
  if (id.includes('gpt')) {
    if (id.includes('codex')) return [PROMPTS.codex];
    return [PROMPTS.gpt];
  }
  if (id.includes('gemini-')) return [PROMPTS.gemini];
  if (id.includes('claude')) return [PROMPTS.anthropic];
  if (id.toLowerCase().includes('trinity')) return [PROMPTS.trinity];
  if (id.toLowerCase().includes('kimi')) return [PROMPTS.kimi];
  return [PROMPTS.default];
}

/* opencode SystemPrompt.environment — model kimliği + <env> bloğu */
function environment({ modelId, providerId, directory, worktree }) {
  const isGit = (() => {
    try {
      return fs.existsSync(path.join(String(directory || ''), '.git')) ? 'yes' : 'no';
    } catch {
      return 'no';
    }
  })();
  return [
    [
      `You are powered by the model named ${modelId}. The exact model ID is ${providerId}/${modelId}`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${directory}`,
      `  Workspace root folder: ${worktree}`,
      `  Is directory a git repo: ${isGit}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date().toDateString()}`,
      `</env>`,
    ].join('\n'),
  ];
}

/* opencode skill/skill.ts fmt (verbose) — skills.js scan() listesini
   opencode katalog biçimine basar */
function skillsCatalog(skills) {
  const described = (skills || []).filter((s) => s && s.description);
  if (!described.length) return undefined;
  return [
    'Skills provide specialized instructions and workflows for specific tasks.',
    'Use the skill tool to load a skill when a task matches its description.',
    '<available_skills>',
    ...described
      .slice()
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .flatMap((s) => [
        '  <skill>',
        `    <name>${s.name}</name>`,
        `    <description>${s.description}</description>`,
        `    <location>${s.path}</location>`,
        '  </skill>',
      ]),
    '</available_skills>',
  ].join('\n');
}

/* opencode SystemPrompt.skills — ajanın skill izni yoksa katalog gösterilmez */
function skills(ruleset, scanFn) {
  if (Permission.disabled(['skill'], ruleset).has('skill')) return undefined;
  try {
    return skillsCatalog(scanFn());
  } catch {
    return undefined;
  }
}

/* opencode SessionReminders.apply — synthetic part yerine son user mesajının
   KOPIASINA metin ekler; session.messages asla değişmez (her tur taze uygulanır).
   wasPlan: bu oturumda daha önce plan ajanı koştu mu (engine takip eder). */
function applyReminders(messages, agent, wasPlan) {
  const msgs = (messages || []).slice();
  const lastUserIdx = msgs.findLastIndex ? msgs.findLastIndex((m) => m.role === 'user') : -1;
  if (lastUserIdx < 0 || !agent) return msgs;
  const adds = [];
  if (agent.name === 'plan') adds.push(PROMPTS.plan);
  if (wasPlan && agent.name === 'build') adds.push(PROMPTS.buildSwitch);
  if (!adds.length) return msgs;
  const base = msgs[lastUserIdx];
  const baseText =
    typeof base.content === 'string' ? base.content : '';
  msgs[lastUserIdx] = {
    ...base,
    content: (baseText ? baseText + '\n\n' : '') + adds.join('\n\n'),
  };
  return msgs;
}

module.exports = {
  PROMPTS,
  provider,
  environment,
  skills,
  skillsCatalog,
  applyReminders,
  loadPrompt,
};
