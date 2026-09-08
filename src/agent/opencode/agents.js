'use strict';

/* ---------- opencode agent/agent.ts portu (birebir) ----------
   Beast Code (bcCode) oturumları artık "mod" değil AJAN koşar:
   build (varsayılan) · plan (salt-okur) · general/explore (task alt-ajanları).

   Agent.Info şeması (opencode):
     { name, description, mode: 'subagent'|'primary'|'all', hidden, temperature,
       permission: Ruleset, model?, prompt?, steps?, options }

   Permission birleşim sırası (opencode birebir): defaults → ajan özel → user.
   Son eşleşen kural kazanır (permission.evaluate findLast). */

const path = require('path');
const Permission = require('./permission');

/* opencode SystemPrompt.environment'daki gibi runtime klasörleri ajan
   kurallarına basar: plan ajanı workspace içindeki .opencode/plans/*.md'ye
   yazabilir (opencode: Global.Path.data/plans + .opencode/plans/*.md allow) */
function planRules(worktree) {
  const ws = String(worktree || '');
  return Permission.fromConfig({
    question: 'allow',
    plan_exit: 'allow',
    task: { general: 'deny' },
    external_directory: { '*': 'ask' },
    edit: {
      '*': 'deny',
      [path.join('.opencode', 'plans', '*.md')]: 'allow',
      ...(ws ? { [path.join(ws, '.opencode', 'plans', '*.md')]: 'allow' } : {}),
    },
  });
}

/* opencode agent.ts defaults (satır 119-136) — birebir.
   Beast'te "question" aracı yok; kural etkisiz kalır, dokunma.
   panel_run: Beast'e özgü (Sandbox ÇALIŞTIR paneli) — default DENY,
   yalnız sandbox ajanında allow edilir (opencode custom-agent deseni). */
function defaultRuleset() {
  return Permission.fromConfig({
    '*': 'allow',
    doom_loop: 'ask',
    external_directory: { '*': 'ask' },
    question: 'deny',
    plan_enter: 'deny',
    plan_exit: 'deny',
    panel_run: 'deny',
    // github/gitignore Node.gitignore desenine uygun .env koruması
    read: {
      '*': 'allow',
      '*.env': 'ask',
      '*.env.*': 'ask',
      '*.env.example': 'allow',
    },
  });
}

/* Yerleşik ajanlar — opencode agent.ts:140-265 birebir (promptlar
   opencode-dev'den kopyalandı: prompts/explore.txt) */
function build(opts = {}) {
  const defaults = defaultRuleset();
  const user = Permission.fromConfig(opts.user || {});
  return {
    build: {
      name: 'build',
      description: 'The default agent. Executes tools based on configured permissions.',
      options: {},
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({ question: 'allow', plan_enter: 'allow' }),
        user
      ),
      mode: 'primary',
      native: true,
    },
    plan: {
      name: 'plan',
      description: 'Plan mode. Disallows all edit tools.',
      options: {},
      permission: Permission.merge(defaults, planRules(opts.worktree), user),
      mode: 'primary',
      native: true,
    },
    general: {
      name: 'general',
      description:
        'General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.',
      permission: Permission.merge(defaults, Permission.fromConfig({ todowrite: 'deny' }), user),
      options: {},
      mode: 'subagent',
      native: true,
    },
    explore: {
      name: 'explore',
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          '*': 'deny',
          grep: 'allow',
          glob: 'allow',
          list: 'allow',
          bash: 'allow',
          webfetch: 'allow',
          websearch: 'allow',
          read: 'allow',
          external_directory: { '*': 'ask' },
        }),
        user
      ),
      description:
        'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.',
      prompt: opts.promptExplore || '',
      options: {},
      mode: 'subagent',
      native: true,
    },
    /* opencode custom-agent deseni (mode: 'all'): Beast Sandbox — GitHub'dan
       indirilmiş açık kaynak repo klasöründe koşan build ajanı. Repo disiplini
       + panel_run (ÇALIŞTIR paneli) izni buradan gelir */
    sandbox: {
      name: 'sandbox',
      description: 'Beast Sandbox agent. Works inside an open-source repo cloned from GitHub; follows the repo owner conventions.',
      options: {},
      permission: Permission.merge(
        defaults,
        Permission.fromConfig({
          question: 'allow',
          panel_run: { '*': 'allow' },
        }),
        user
      ),
      prompt: [
        'BEAST SANDBOX MODUNDASIN: GitHub\u2019dan indirilmi\u015f A\u00c7IK KAYNAK bir repo klas\u00f6r\u00fcndesin (Beast-Sandbox). Bu kodun sahibi de\u011filsin \u2014 hazir bir di\u015f proje; repo sahibinin konvansiyonlarina uy, gereksiz yeniden bi\u00e7imlendirme yapma.',
        '\u0130\u015fe README + paket bildirim dosyalar\u0131yla ba\u015fla (list/glob); ba\u011f\u0131ml\u0131l\u0131klar kurulu de\u011filse \u00f6nce kurulum komutunu \u00e7al\u0131\u015ft\u0131r (npm install vb.).',
        'UZUN S\u00dcREL\u0130 sunucu/s\u00fcre\u00e7 (npm start, npm run dev, python app.py vb.) bash ile ASLA ba\u015flatma \u2014 tur kilitlenir; kullan\u0131c\u0131 \u00e7al\u0131\u015ft\u0131rmak isterse panel_run arac\u0131yla \u00c7ALI\u015eTIR paneline b\u0131rak (\u00e7\u0131kt\u0131 orada canl\u0131 akar) ve adresi kullan\u0131c\u0131ya bildir. panel_run yaln\u0131z B\u0130R s\u00fcre\u00e7 \u00e7al\u0131\u015ft\u0131r\u0131r.',
      ].join('\n'),
      mode: 'all',
      native: false,
    },
  };
}

/* opencode Agent.get(name) — bilinmeyen isim null döner (çağıran hata basar) */
function get(name, opts = {}) {
  const agents = build(opts);
  return agents[name] || null;
}

/* opencode Agent.list() — alfabetik, build önce */
function list(opts = {}) {
  const agents = Object.values(build(opts));
  return agents.sort((a, b) => (a.name === 'build' ? -1 : b.name === 'build' ? 1 : a.name.localeCompare(b.name)));
}

/* opencode Agent.defaultInfo() — görünür primary ajan (build) */
function defaultInfo(opts = {}) {
  const agents = Object.values(build(opts));
  return agents.find((a) => a.mode !== 'subagent' && a.hidden !== true) || agents[0];
}

module.exports = { get, list, defaultInfo, build, defaultRuleset, planRules };
