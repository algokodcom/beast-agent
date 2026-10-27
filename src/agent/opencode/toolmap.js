'use strict';

/* ---------- opencode v2.1.4 tool seti → Beast araç köprüsü ----------
   Kaynak: packages/core/src/tool/plugin/*.ts (read/edit/write/shell/grep/glob/
           webfetch/websearch/todo/subagent/skill) + tool/todowrite.txt

   Model opencode v2.1.4 ARAÇ DİLİYLE konuşur:
     read · edit · write · shell · grep · glob · webfetch · websearch ·
     todowrite · subagent · skill
   (v2.1.4'te ayrı "list" aracı yoktur — read dizinleri de okur.)

   execMap() çağrıyı Beast'in yerleşik aracına çevirir — implementasyon
   değişmez, modelin gördüğü dünya opencode v2.1.4 olur. */

const fs = require('fs');
const path = require('path');

const PROMPT_DIR = path.join(__dirname, 'prompts');
function loadPrompt(name) {
  try {
    let t = fs.readFileSync(path.join(PROMPT_DIR, name), 'utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return t.replace(/\s+$/, '') + '\n';
  } catch {
    return '';
  }
}

const OS =
  process.platform === 'darwin'
    ? 'macOS'
    : process.platform === 'win32'
      ? 'Windows'
      : process.platform === 'linux'
        ? 'Linux'
        : process.platform;
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

/* opencode shell.ts description() — Windows/PowerShell */
function shellDescription() {
  return [
    'Execute a shell command and return its output.',
    `Commands run on ${OS} using Windows PowerShell.`,
    'Quote file paths containing spaces or special characters.',
    'Prefer dedicated tools over shell commands when possible.',
    'When output is large, the full result is saved to a file and a truncated preview is returned.',
    'Rely on automatic truncation unless filtering the output is more useful.',
    'Commands accept an optional timeout, background commands have no timeout by default.',
    'Background commands return immediately, and you will be notified when they complete.',
  ].join(' ');
}

const SUBAGENT_DESCRIPTION = [
  'Spawns an agent in a child session to work on the specified task.',
  'The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.',
  'New child sessions start with fresh context, so include all relevant context and instructions when you don\'t pass a sessionID.',
  'Foreground (default) runs the subagent to completion and returns its final response.',
  'Background mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.',
  'Use background only for independent work that can run while you continue elsewhere.',
].join('\n');

/* v2.1.4 tool şemaları — Schema.Struct karşılığı JSON Schema */
const DEFS = () => [
  {
    name: 'read',
    description:
      'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to read' },
        offset: { type: 'integer', description: 'The line or directory entry to start reading from (1-based)' },
        limit: { type: 'integer', description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit',
    description:
      'Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file\'s existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to edit' },
        oldString: { type: 'string', description: 'Exact text to find and replace' },
        newString: { type: 'string', description: 'Text to replace oldString with (must differ from oldString)' },
        replaceAll: {
          type: 'boolean',
          description:
            'Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false.',
        },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  {
    name: 'write',
    description:
      'Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write to' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'shell',
    description: shellDescription(),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        workdir: {
          type: 'string',
          description:
            'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.',
        },
        timeout: {
          type: 'integer',
          description: `Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to ${DEFAULT_TIMEOUT_MS} for foreground commands. Background commands have no timeout by default.`,
        },
        background: {
          type: 'boolean',
          description:
            "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'grep',
    description:
      "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression or literal text to match in file contents.' },
        path: { type: 'string', description: 'File or directory to search. Defaults to the current working directory.' },
        include: { type: 'string', description: 'Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")' },
        literal: { type: 'boolean', description: 'Treat `pattern` as exact text instead of a regular expression (default: false).' },
        caseSensitive: { type: 'boolean', description: 'Use case-sensitive matching (default: true).' },
        limit: { type: 'integer', description: 'Maximum number of matching lines to return (default: 100)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'glob',
    description: 'Search file paths using a glob pattern (examples: "**/*.ts", "src/**/*.tsx").',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files against' },
        path: { type: 'string', description: 'Directory to search. Defaults to the current working directory.' },
        hidden: { type: 'boolean', description: 'Include hidden files and directories (default: false).' },
        limit: { type: 'integer', description: 'Maximum number of matching files to return (default: 100)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'webfetch',
    description:
      'Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\n\nUse a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The HTTP or HTTPS URL to fetch content from' },
        format: { type: 'string', enum: ['text', 'markdown', 'html'], description: 'The format to return the content in. Defaults to markdown.' },
        timeout: { type: 'integer', description: 'Optional timeout in seconds (maximum: 120)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'websearch',
    description: `Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.\n\nThe current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Websearch query' },
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
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                description: 'Current status of the task: pending, in_progress, completed, cancelled',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'subagent',
    description: SUBAGENT_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description:
            'The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.',
        },
        description: { type: 'string', description: 'A short 3-5 word label for the task, displayed to the user' },
        prompt: { type: 'string', description: 'The task for the subagent to perform' },
        model: {
          type: 'string',
          description:
            'NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as "providerID/modelID", or "providerID/modelID#variant" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.',
        },
        sessionID: {
          type: 'string',
          description: 'Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.',
        },
        background: {
          type: 'boolean',
          description:
            'Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress.',
        },
      },
      required: ['agent', 'description', 'prompt'],
    },
  },
  {
    name: 'skill',
    description: [
      "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.",
      '',
      'The skill ID must match an available skill or a skill explicitly referenced by the user.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The ID of an available skill or a skill explicitly referenced by the user' },
      },
      required: ['id'],
    },
  },
  {
    /* Beast Sandbox'a özgü: UZUN SÜRELİ süreçleri ÇALIŞTIR paneline devreder */
    name: 'panel_run',
    description:
      'Run a LONG-RUNNING process (dev server, background service) in the managed RUN panel instead of the blocking shell. The turn does not wait for it to finish; output streams live in the panel and can be stopped by the user. Use this instead of starting servers with shell — a blocking shell call would stall the whole job. Only ONE process runs at a time.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run in the panel' },
      },
      required: ['command'],
    },
  },
];

function definitions() {
  return DEFS().map((d) => ({ type: 'function', function: d }));
}

function names() {
  return DEFS().map((d) => d.name);
}

const TO_BUILTIN = {
  read: 'read_file',
  edit: 'edit_file',
  write: 'write_file',
  shell: 'run_command',
  glob: 'glob',
  grep: 'grep',
  webfetch: 'webfetch',
  websearch: 'web_search',
  todowrite: 'todo_write',
  subagent: 'delegate_task',
  skill: 'skill',
  panel_run: 'panel_run',
  /* eski BC oturumları / geriye uyum */
  bash: 'run_command',
  list: 'read_file',
  task: 'delegate_task',
};

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function literalPattern(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* opencode parametreleri → Beast araç parametreleri */
function execMap(name, args) {
  const a = args || {};
  switch (name) {
    case 'read':
      return { name: 'read_file', args: { path: a.path, offset: a.offset, limit: a.limit } };
    case 'edit':
      return {
        name: 'edit_file',
        args: { path: a.path, old_string: a.oldString, new_string: a.newString, replace_all: a.replaceAll === true },
      };
    case 'write':
      return { name: 'write_file', args: { path: a.path, content: a.content } };
    case 'shell':
    case 'bash': {
      let command = String(a.command || '');
      if (a.workdir) {
        const dir = String(a.workdir);
        command = `Set-Location -LiteralPath ${shellQuote(path.isAbsolute(dir) ? dir : path.resolve(dir))}; ${command}`;
      }
      return { name: 'run_command', args: { command, timeout_ms: a.timeout } };
    }
    case 'grep': {
      const pattern = a.literal ? literalPattern(a.pattern) : String(a.pattern || '');
      return {
        name: 'grep',
        args: {
          pattern,
          path: a.path,
          include: a.include,
          ...(a.caseSensitive === false ? { case_insensitive: true } : {}),
          ...(a.limit !== undefined ? { limit: a.limit } : {}),
        },
      };
    }
    case 'glob':
      return {
        name: 'glob',
        args: {
          pattern: a.pattern,
          path: a.path,
          ...(a.hidden !== undefined ? { hidden: a.hidden } : {}),
          ...(a.limit !== undefined ? { limit: a.limit } : {}),
        },
      };
    case 'webfetch':
      return { name: 'webfetch', args: { url: a.url, format: a.format, timeout: a.timeout } };
    case 'websearch':
      return { name: 'web_search', args: { query: a.query, max_results: a.numResults || a.max_results } };
    case 'todowrite':
      return { name: 'todo_write', args: { items: (a.todos || []).map(opencodeTodoToItem) } };
    case 'subagent':
    case 'task':
      return {
        name: 'delegate_task',
        args: { task: a.prompt || a.description, context: a.description || '', subagent_type: a.agent || a.subagent_type },
      };
    case 'skill':
      return { name: 'skill', args: { name: a.id || a.name } };
    case 'panel_run':
      return { name: 'panel_run', args: { command: a.command } };
    default:
      return { name: TO_BUILTIN[name] || name, args: a };
  }
}

/* opencode Todo.Info {content, status} → Beast {title, status} */
const OC_TODO_STATUS = { pending: 'pending', in_progress: 'active', completed: 'done', cancelled: 'done' };
function opencodeTodoToItem(t) {
  const it = t || {};
  return {
    title: String(it.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    status: OC_TODO_STATUS[String(it.status || 'pending')] || 'pending',
  };
}

module.exports = { definitions, names, execMap, TO_BUILTIN, opencodeTodoToItem };
