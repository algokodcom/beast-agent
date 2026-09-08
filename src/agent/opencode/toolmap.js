'use strict';

/* ---------- opencode tool seti → Beast araç köprüsü ----------
   Beast Code (bcCode) oturumlarında model opencode'un ARAÇ DİLİYLE konuşur:
   read · edit · write · bash · glob · grep · list · fetch · websearch ·
   todowrite · task · skill  (opencode builtin registry sırası)

   Tanımlar opencode-dev'den birebir: açıklama metinleri tool/*.txt,
   parametre şemaları opencode Schema.Struct karşılıkları (JSON Schema).
   execMap() çağrıyı Beast'in yerleşik aracına çevirir — implementasyon
   değişmez, modelin gördüğü dünya opencode olur. */

const fs = require('fs');
const path = require('path');

const PROMPT_DIR = path.join(__dirname, 'prompts');
function loadPrompt(name) {
  try {
    let t = fs.readFileSync(path.join(PROMPT_DIR, name), 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // BOM-strip
    return t.replace(/\s+$/, '') + '\n';
  } catch {
    return '';
  }
}

/* opencode tool/shell/prompt.ts Windows (PowerShell) açıklaması — Beast
   değerleriyle: varsayılan timeout 120s, 2000 satır / 50KB tavan, tam
   çıktı geçici dosyaya düşer (Beast run_command zaten bu disiplinde) */
function bashDescription() {
  const defaultTimeoutMs = 120000;
  const maxLines = 2000;
  const maxBytes = '50KB';
  return `Executes a given PowerShell command in a persistent shell session.

## Command Execution

Before executing the command, please follow these steps:
  1. If the command will create new directories or files, first use \`Test-Path -LiteralPath <parent>\` to verify the parent directory exists and is the correct location
  2. If the command will modify or delete files, first verify the paths are correct
  3. For commands expected to create new directories or files, verify the expected file/folder location is inside the working directory

After ensuring proper quoting, execute the command.
  - Capture the output of the command.

## Usage Notes

  - The command argument is required.
  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after ${defaultTimeoutMs}ms.
  - If the output exceeds ${maxLines} lines or ${maxBytes} bytes, it will be truncated and the full output will be written to a file. You can use Read with offset/limit to read specific sections or Grep to search the full content. Do NOT use \`Select-Object -First\`, \`Select-Object -Last\`, or other truncation commands to limit output; the full output will already be captured to a file for more precise searching.
  - Avoid using Shell with PowerShell file/content cmdlets unless explicitly instructed or when these cmdlets are truly necessary for the task. Instead, always prefer using the dedicated tools for reading, searching, and editing files:
    - Read: Reading and analyzing file contents (with line numbers)
    - Edit: Making targeted changes to specific sections of files
    - Write: Creating new files from scratch
    - Grep: Searching file contents with regex patterns
    - Glob: Finding files by patterns (e.g., "src/**/*.ts")
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple bash tool calls in a single message. For example, if you need to run "git status" and "git diff", send a single message with two bash tool calls in parallel.
    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail
    - If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell (5.1) does not support it. Use PowerShell conditionals such as \`cmd1; if ($?) { cmd2 }\` when later commands must depend on earlier success.
    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)
  - The shell is PERSISTENT: working directory and environment variables are preserved between calls.
  - Commands run in Windows PowerShell (5.1).`;
}

/* opencode tool şemaları — Schema.Struct karşılığı JSON Schema'lar */
const DEFS = () => [
  {
    name: 'bash',
    description: bashDescription(),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'integer', description: 'Optional timeout in milliseconds' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read',
    description: loadPrompt('read.txt'),
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'The absolute path to the file or directory to read' },
        offset: { type: 'integer', description: 'The line number to start reading from (1-indexed)' },
        limit: { type: 'integer', description: 'The maximum number of lines to read (defaults to 2000)' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'edit',
    description: loadPrompt('edit.txt'),
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'The absolute path to the file to modify' },
        oldString: { type: 'string', description: 'The text to replace' },
        newString: { type: 'string', description: 'The text to replace it with (must be different from oldString)' },
        replaceAll: { type: 'boolean', description: 'Replace all occurrences of oldString (default false)' },
      },
      required: ['filePath', 'oldString', 'newString'],
    },
  },
  {
    name: 'write',
    description: loadPrompt('write.txt'),
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'The absolute path to the file to write (will create the file if it does not exist, will overwrite if it does)' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'glob',
    description: loadPrompt('glob.txt'),
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern to match files against' },
        path: { type: 'string', description: 'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description: loadPrompt('grep.txt'),
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regex pattern to search for in file contents' },
        path: { type: 'string', description: 'The directory to search in. Defaults to the current working directory.' },
        include: { type: 'string', description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'list',
    description: 'List files and directories in a given path. Returns entries sorted by name (directories first, then files), with type indicator and size.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The directory path to list. Defaults to the current working directory.' },
      },
    },
  },
  {
    name: 'webfetch',
    description: loadPrompt('webfetch.txt'),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        format: { type: 'string', enum: ['text', 'markdown', 'html'], description: 'The format to return the content in (text, markdown, or html). Defaults to markdown.' },
        timeout: { type: 'integer', description: 'Optional timeout in seconds (max 120)' },
        max_chars: { type: 'integer', description: 'Optional maximum characters to return' },
      },
      required: ['url'],
    },
  },
  {
    name: 'websearch',
    description: loadPrompt('websearch.txt'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Websearch query' },
        numResults: { type: 'integer', description: 'Number of search results to return (default: 8)' },
        type: { type: 'string', enum: ['auto', 'fast', 'deep'], description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search" },
      },
      required: ['query'],
    },
  },
  {
    name: 'todowrite',
    description: loadPrompt('todowrite.txt'),
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The updated todo list',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Brief description of the task' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'], description: 'Current status of the task' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Priority level of the task' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'task',
    description: loadPrompt('task.txt'),
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'A short description of the task (max 80 chars)' },
        prompt: { type: 'string', description: 'The full task description for the subagent to execute' },
        subagent_type: { type: 'string', enum: ['general', 'explore'], description: 'Type of subagent to launch (options: explore, general)' },
      },
      required: ['description', 'prompt', 'subagent_type'],
    },
  },
  {
    name: 'skill',
    description: loadPrompt('skill.txt'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the skill from available_skills' },
      },
      required: ['name'],
    },
  },
  {
    /* Beast Sandbox'a özgü: UZUN SÜRELİ süreçleri (dev server vb.) ÇALIŞTIR
       paneline devreder — tur BLOKLAMAZ. panel_run izni yalnız sandbox
       ajanında allow edilir (agents.js); BC build/plan'da gizlidir. */
    name: 'panel_run',
    description:
      'Run a LONG-RUNNING process (dev server, background service) in the managed RUN panel instead of the blocking shell. The turn does not wait for it to finish; output streams live in the panel and can be stopped by the user. Use this instead of starting servers with bash — a blocking bash call would stall the whole job. Only ONE process runs at a time.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run in the panel' },
      },
      required: ['command'],
    },
  },
];

/* OpenAI function-call formatına çevirir (engine TOOLS formatı) */
function definitions() {
  return DEFS().map((d) => ({ type: 'function', function: d }));
}

const TO_BUILTIN = {
  bash: 'run_command',
  read: 'read_file',
  edit: 'edit_file',
  write: 'write_file',
  glob: 'glob',
  grep: 'grep',
  list: 'list_dir',
  webfetch: 'webfetch',
  websearch: 'web_search',
  todowrite: 'todo_write',
  task: 'delegate_task',
  panel_run: 'panel_run',
};

/* opencode parametreleri → Beast araç parametreleri */
function execMap(name, args) {
  const a = args || {};
  switch (name) {
    case 'read':
      return { name: 'read_file', args: { path: a.filePath, offset: a.offset, limit: a.limit } };
    case 'edit':
      return {
        name: 'edit_file',
        args: { path: a.filePath, old_string: a.oldString, new_string: a.newString, replace_all: a.replaceAll === true },
      };
    case 'write':
      return { name: 'write_file', args: { path: a.filePath, content: a.content } };
    case 'bash':
      return { name: 'run_command', args: { command: a.command, timeout_ms: a.timeout } };
    case 'list':
      return { name: 'list_dir', args: { path: a.path } };
    case 'webfetch':
      return { name: 'webfetch', args: { url: a.url, format: a.format, timeout: a.timeout, max_chars: a.max_chars } };
    case 'websearch':
      return { name: 'web_search', args: { query: a.query, max_results: a.numResults || a.max_results } };
    case 'todowrite':
      return { name: 'todo_write', args: { items: (a.todos || []).map(opencodeTodoToItem) } };
    case 'task':
      return {
        name: 'delegate_task',
        args: { task: a.prompt || a.description, context: a.description || '', subagent_type: a.subagent_type },
      };
    default:
      return { name: TO_BUILTIN[name] || name, args: a };
  }
}

/* opencode Todo.Info {content, status, priority} → Beast iç depo {title, status}
   opencode durum makinesi: pending → in_progress → completed | cancelled
   Beast iç durumu: pending | active | done */
const OC_TODO_STATUS = { pending: 'pending', in_progress: 'active', completed: 'done', cancelled: 'done' };
function opencodeTodoToItem(t) {
  const it = t || {};
  return {
    title: String(it.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    status: OC_TODO_STATUS[String(it.status || 'pending')] || 'pending',
  };
}

/* BC oturumunda modele sunulan opencode araç adları (permission filtresinden
   önce tam set — opencode registry builtin sırası) */
function names() {
  return DEFS().map((d) => d.name);
}

module.exports = { definitions, names, execMap, TO_BUILTIN, opencodeTodoToItem };
