'use strict';

/* ---------- opencode v2.1.4 system prompt portu ----------
   Kaynak: packages/core/src/session/system-prompt.ts
           packages/core/src/plugin/optimize.ts
           packages/core/src/instructions/builtins.ts
           packages/core/src/skill/instructions.ts
           packages/core/src/plugin/plan.ts

   system = [ ajanın system metni VARSA o, yoksa model-bazlı şablon
              (gpt/gpt-astra/anthropic/kimi/trinity/meta) veya taban system.txt,
              talimatlar (tarih + <env> + AGENTS.md) ]

   Anthropic şablonu taban prompta EKLENİR; diğerleri tabanı EZER
   (optimize.ts: mode 'override' | 'append').

   Plan hatırlatmaları v2.1.4'te synthetic user mesajıdır:
   <system-reminder> ... </system-reminder> — son user mesajının ÖNÜNE girer. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Permission = require('./permission');

const PROMPT_DIR = path.join(__dirname, 'prompts');
function loadPrompt(name) {
  try {
    let t = fs.readFileSync(path.join(PROMPT_DIR, name), 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return t.replace(/\s+$/, '');
  } catch {
    return '';
  }
}

const PROMPTS = {
  system: loadPrompt('system.txt'),
  gpt: loadPrompt('gpt.txt'),
  gptAstra: loadPrompt('gpt-astra.txt'),
  anthropic: loadPrompt('anthropic.txt'),
  kimi: loadPrompt('kimi.txt'),
  meta: loadPrompt('meta.txt'),
  trinity: loadPrompt('trinity.txt'),
  todowrite: loadPrompt('todowrite.txt'),
};

/* opencode SessionSystemPrompt.render — araç listesine göre ipuçları */
function render(prompt, tools) {
  const names = Array.isArray(tools) ? tools : [];
  const instructions = [];
  if (names.includes('shell')) {
    instructions.push(
      '- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.',
      '- Do not chain shell commands with separators like `echo "====";` or `printf \'---\'`; the output becomes noisy in a way that makes the user\'s side of the conversation worse.'
    );
  }
  if (names.includes('write')) {
    instructions.push(
      '- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.'
    );
  }
  if (names.includes('edit')) {
    instructions.push(
      '- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.'
    );
  }
  return String(prompt || '').replace('${OPENCODE_TOOL_GUIDANCE}', instructions.join('\n'));
}

/* opencode plugin/optimize.ts — model-bazlı şablon seçimi */
function templateFor(modelId, modelName) {
  const id = String(modelId || '').toLowerCase();
  if (id.includes('gpt')) {
    return { text: id.includes('astra') ? PROMPTS.gptAstra : PROMPTS.gpt, mode: 'override' };
  }
  if (id.includes('claude')) return { text: PROMPTS.anthropic, mode: 'append' };
  if (id.includes('kimi')) return { text: PROMPTS.kimi, mode: 'override' };
  if (id.includes('trinity')) return { text: PROMPTS.trinity, mode: 'override' };
  if (id.includes('muse')) {
    return {
      text: PROMPTS.meta.replaceAll('{{MODEL_NAME}}', String(modelName || modelId || 'Muse')),
      mode: 'override',
    };
  }
  return null;
}

/* v2.1.4 model-request.ts: agent.system ? agent.system : base; optimizasyon
   ajanın kendi sistem metni varsa ATLANIR. */
function system({ modelId, modelName, tools, agentSystem } = {}) {
  if (agentSystem) return String(agentSystem);
  const template = templateFor(modelId, modelName);
  if (!template) return render(PROMPTS.system, tools);
  const rendered = render(template.text, tools);
  if (template.mode === 'append') return render(PROMPTS.system, tools) + '\n\n' + rendered;
  return rendered;
}

/* Geriye uyum: model-bazlı ana prompt dizisi */
function provider(modelId, modelName) {
  return [system({ modelId, modelName, tools: [] })];
}

/* opencode instructions/builtins.ts — tarih + <env> bloğu */
function environment({ directory, worktree, tmp } = {}) {
  const cwd = String(directory || worktree || '');
  const root = String(worktree || directory || '');
  let isGit = 'no';
  try {
    if (fs.existsSync(path.join(cwd, '.git'))) isGit = 'yes';
  } catch {}
  return [
    `Today's date: ${new Date().toDateString()}`,
    [
      'Here is some useful information about the environment you are running in:',
      '<env>',
      `  Working directory: ${cwd}`,
      `  Workspace root folder: ${root}`,
      `  Is directory a git repo: ${isGit}`,
      `  Platform: ${process.platform}`,
      `  Prefer ${tmp || os.tmpdir()} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
      '</env>',
    ].join('\n'),
  ];
}

/* opencode skill/instructions.ts — katalog biçimi */
function skillsCatalog(skills) {
  const list = (skills || [])
    .filter((s) => s && s.name && s.description)
    .slice()
    .sort((a, b) => String(a.id || a.name).localeCompare(String(b.id || b.name)));
  const entries = list.flatMap((s) => [
    '  <skill>',
    `    <id>${s.id || s.name}</id>`,
    `    <name>${s.name}</name>`,
    `    <description>${s.description}</description>`,
    '  </skill>',
  ]);
  return [
    'Skills provide specialized instructions and workflows for specific tasks.',
    'Use the skill tool to load a skill when a task matches its description.',
    'The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.',
    ...(list.length === 0 ? ['No skills are currently available.'] : ['<available_skills>', ...entries, '</available_skills>']),
  ].join('\n');
}

/* İzin katmanı kapalı — katalog daima gösterilir */
function skills(ruleset, scanFn) {
  try {
    return skillsCatalog(scanFn());
  } catch {
    return undefined;
  }
}

/* opencode plugin/plan.ts — plan modu hatırlatmaları */
function planReminders() {
  const directory = path.join(os.homedir(), '.opencode', 'plan');
  return {
    enter: `<system-reminder>
You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:
${directory}

Do not modify any other files or ask a subagent to do so.

You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.
</system-reminder>`,
    leave: `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`,
  };
}

function lastReminder(messages) {
  let found;
  for (const message of messages || []) {
    if (!message || message.role !== 'user') continue;
    const text = typeof message.content === 'string' ? message.content : '';
    if (text.includes('<system-reminder>') && (text.includes('You are in Plan mode') || text.includes('You are NO LONGER in Plan mode'))) {
      found = text;
    }
  }
  return found;
}

/* opencode plugin/plan.ts context hook — eksik/eskimiş hatırlatmayı ekler.
   Mesajlar KOPYALANIR; oturum geçmişi değişmez. */
function applyReminders(messages, agentId, wasPlan) {
  const msgs = (messages || []).slice();
  const id = typeof agentId === 'object' && agentId ? agentId.id : agentId;
  const { enter, leave } = planReminders();
  const previous = lastReminder(msgs);
  const missing = id === 'plan' && previous !== enter;
  const stale = id !== 'plan' && previous === enter;
  const text = missing ? enter : stale ? leave : undefined;
  if (!text) return msgs;
  const at = msgs.length && msgs[msgs.length - 1] && msgs[msgs.length - 1].role === 'user' ? msgs.length - 1 : msgs.length;
  msgs.splice(at, 0, { role: 'user', content: text });
  return msgs;
}

module.exports = {
  PROMPTS,
  render,
  system,
  provider,
  environment,
  skills,
  skillsCatalog,
  applyReminders,
  planReminders,
  loadPrompt,
};
