'use strict';

/* ---------- opencode v2.1.4 mantığı — Beast Code portu ----------
   Kaynak: opencode v2.1.4 packages/core + packages/schema

     agents.js        → plugin/agent.ts + plugin/plan.ts (build/plan/general/
                         explore/compaction/title/summary + Beast sandbox)
     permission.js    → core/permission.ts + schema/permission.ts
                         (kural şeması { action, resource, effect })
     askperm.js       → core/permission.ts Service (ask/assert/reply)
                         — Beast Code'da izin katmanı KAPALI, her şey serbest
     systemprompt.js  → session/system-prompt.ts + plugin/optimize.ts
                         + instructions/builtins.ts + skill/instructions.ts
                         + plugin/plan.ts hatırlatmaları
     toolmap.js       → tool/plugin/* (read/edit/write/shell/grep/glob/
                         webfetch/websearch/todowrite/subagent/skill)
     prompts/         → system.txt + model promptları (v2.1.4 birebir)

   Kullanım (engine, bcCode oturumlarında):
     opencode.agents.get(name, opts)          → Agent.Info
     opencode.systemprompt.system({...})      → model-bazlı ana prompt
     opencode.toolmap.definitions()           → modele sunulacak araç seti
     opencode.toolmap.execMap(name, args)     → Beast aracına çevirim
     opencode.Permission                      → kural motoru (allow-all)
     opencode.AskService                      → izin servisi (sormaz) */

const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, 'prompts');
function loadPrompt(name) {
  try {
    return fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8').replace(/\s+$/, '');
  } catch {
    return '';
  }
}

const agents = require('./agents');
const Permission = require('./permission');
const { AskService } = require('./askperm');
const systemprompt = require('./systemprompt');
const toolmap = require('./toolmap');

module.exports = {
  agents,
  Permission,
  AskService,
  systemprompt,
  toolmap,
  PROMPT_EXPLORE: agents.PROMPT_EXPLORE,
  MAX_STEPS_PROMPT: '', // v2.1.4'te ayrı max-steps promptu yok (steps → tool_choice)
  loadPrompt,
};
