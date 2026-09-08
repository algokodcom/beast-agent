'use strict';

/* ---------- opencode mantığı — Beast Code portu (birleşim) ----------
   opencode-dev/packages/opencode/src çekirdek mimarisinin CommonJS portu:

     agents.js        → agent/agent.ts      (build/plan/general/explore + permission)
     permission.js    → permission/index.ts  (ruleset, evaluate findLast, fromConfig)
     askperm.js       → permission Service   (ask/reply: once|always|reject)
     systemprompt.js  → session/system.ts + reminders.ts
     toolmap.js       → tool/registry.ts builtin seti (read/edit/write/bash/...)
     prompts/         → session/prompt/*.txt + tool/*.txt (opencode-dev'den birebir)

   Kullanım (engine, bcCode oturumlarında):
     opencode.agents.get(name, {worktree})          → Agent.Info
     opencode.system.provider(modelId)             → model-bazlı ana prompt
     opencode.toolmap.definitions()                → modele sunulacak opencode araç seti
     opencode.toolmap.execMap(name, args)          → Beast aracına çevirim
     opencode.Permission                           → kural motoru
     opencode.AskService                           → izin isteme/yanıtlama servisi */

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

const MAX_STEPS_PROMPT = loadPrompt('max-steps.txt');
const PROMPT_EXPLORE = loadPrompt('explore.txt');

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
  MAX_STEPS_PROMPT,
  PROMPT_EXPLORE,
  loadPrompt,
};
