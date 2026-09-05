'use strict';

/* Yerleşik git araçları — ajan commit/diff/PR işlerini kabuk komutu yazmadan
   yapar. execFile arg-dizisiyle çağrılır (quoting/enjeksiyon riski yok).
   gh CLI yoksa git_pr_create net yönlendirmeyle hata döner.
   Bildirim: tüm sonuçlar JSON'a çevrilerek tools.exec'ten döner. */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const MAX_DIFF_CHARS = 30000;
const GIT_TIMEOUT = 60000;
const NET_TIMEOUT = 120000;

/* git/gh çağrısı: { ok, code, out, err, missing } döner — missing = binary yok */
function run(bin, args, cwd, timeoutMs = GIT_TIMEOUT) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd: cwd || process.cwd(),
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: process.env,
      },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          resolve({ ok: false, code: null, out: '', err: '', missing: true });
          return;
        }
        const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
        const killed = !!(err && err.killed);
        resolve({
          ok: !err,
          code,
          killed,
          out: String(stdout || ''),
          err: String(stderr || (err && err.message) || ''),
        });
      }
    );
  });
}

async function insideWorkTree(cwd) {
  const r = await run('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  return r.ok && r.out.trim() === 'true';
}

async function branchName(cwd) {
  const r = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return r.ok ? r.out.trim() : '';
}

function cleanRef(ref) {
  return /^[\w./\-~^+]{1,120}$/.test(String(ref || '')) ? String(ref) : null;
}

/* ---------- git_commit ---------- */
async function gitCommit(args, ctx) {
  const cwd = ctx && ctx.cwd;
  if (!(await insideWorkTree(cwd))) {
    return { ok: false, error: 'git deposu değil: ' + (cwd || '.') };
  }
  const message = String(args.message || '').trim();
  if (!message) return { ok: false, error: 'commit mesajı boş olamaz' };
  if (message.length > 2000) return { ok: false, error: 'commit mesajı çok uzun (max 2000 karakter)' };

  /* 1) stage: paths > add_all > (yoksa mevcut staged hali commit'lenir) */
  let staged = false;
  if (Array.isArray(args.paths) && args.paths.length) {
    const paths = args.paths.map((p) => path.resolve(String(cwd || '.'), String(p))).slice(0, 100);
    const r = await run('git', ['add', '--', ...paths], cwd);
    if (!r.ok) return { ok: false, error: 'git add başarısız: ' + (r.err || r.out).trim() };
    staged = true;
  } else if (args.add_all) {
    const r = await run('git', ['add', '-A'], cwd);
    if (!r.ok) return { ok: false, error: 'git add -A başarısız: ' + (r.err || r.out).trim() };
    staged = true;
  }

  /* 2) staged değişiklik var mı? (diff --cached --quiet: 0=yok, 1=var) */
  const q = await run('git', ['diff', '--cached', '--quiet'], cwd);
  if (q.ok) {
    return { ok: false, error: 'commit\'lenecek değişiklik yok — paths/add_all ver ya da önce değişiklik yap' };
  }

  /* 3) commit */
  const c = await run('git', ['commit', '-m', message], cwd);
  if (!c.ok) {
    return { ok: false, error: ('git commit başarısız: ' + (c.err || c.out)).trim() };
  }
  const hash = (await run('git', ['rev-parse', 'HEAD'], cwd)).out.trim();
  const branch = await branchName(cwd);
  const stat = (await run('git', ['show', '--stat', '--oneline', '-s'], cwd)).out.trim();

  /* 4) opsiyonel push */
  let pushResult = null;
  if (args.push) {
    const p = await run('git', ['push'], cwd, NET_TIMEOUT);
    if (!p.ok) {
      const p2 = await run('git', ['push', '-u', 'origin', branch || 'HEAD'], cwd, NET_TIMEOUT);
      pushResult = p2.ok
        ? { ok: true, note: 'upstream ayarlanarak push edildi' }
        : { ok: false, error: (p2.err || p2.out).trim() };
    } else pushResult = { ok: true };
  }

  return { ok: true, hash, branch, stat, ...(pushResult ? { push: pushResult } : {}) };
}

/* ---------- git_diff_review ---------- */
async function gitDiffReview(args, ctx) {
  const cwd = ctx && ctx.cwd;
  if (!(await insideWorkTree(cwd))) {
    return { ok: false, error: 'git deposu değil: ' + (cwd || '.') };
  }
  const staged = !!args.staged;
  const ref = args.ref ? cleanRef(args.ref) : null;
  if (args.ref && !ref) return { ok: false, error: 'geçersiz ref: ' + String(args.ref).slice(0, 60) };
  const ctxN = Math.min(20, Math.max(0, Math.floor(Number(args.context) || 3)));
  const maxChars = Math.min(60000, Math.max(500, Math.floor(Number(args.max_chars) || MAX_DIFF_CHARS)));

  const branch = await branchName(cwd);
  const status = (await run('git', ['status', '--porcelain=v1'], cwd)).out
    .split('\n')
    .filter(Boolean)
    .slice(0, 60);

  const statArgs = ['diff', '--stat'];
  const diffArgs = ['diff', '--unified=' + ctxN];
  if (staged) {
    statArgs.splice(1, 0, '--staged');
    diffArgs.splice(1, 0, '--staged');
  }
  if (ref) {
    statArgs.push(ref);
    diffArgs.push(ref);
  }
  const stat = (await run('git', statArgs, cwd)).out.trim();
  const dr = await run('git', diffArgs, cwd);
  let diff = (dr.out || '').trim();
  let truncated = false;
  if (diff.length > maxChars) {
    diff = diff.slice(0, maxChars);
    truncated = true;
  }
  return {
    ok: true,
    branch,
    staged,
    ...(ref ? { ref } : {}),
    status,
    stat: stat || '(fark yok)',
    diff: diff || '(fark yok)',
    ...(truncated ? { truncated: true, note: `çıktı ${maxChars} karakterde kesildi — max_chars'i artır ya da ref daralt` } : {}),
  };
}

/* ---------- git_pr_create ---------- */
async function gitPrCreate(args, ctx) {
  const cwd = ctx && ctx.cwd;
  if (!(await insideWorkTree(cwd))) {
    return { ok: false, error: 'git deposu değil: ' + (cwd || '.') };
  }
  const title = String(args.title || '').trim();
  if (!title) return { ok: false, error: 'PR başlığı boş olamaz' };
  const branch = await branchName(cwd);
  if (!branch || branch === 'HEAD') {
    return { ok: false, error: 'dal okunamadı — depo boş olabilir (önce bir commit yap)' };
  }
  if (/^(main|master)$/i.test(branch)) {
    return { ok: false, error: `şu an '${branch}' dalındasın — önce bir özellik dalı aç (git switch -c feature/...), sonra PR oluştur` };
  }
  const base = args.base ? cleanRef(args.base) : null;
  if (args.base && !base) return { ok: false, error: 'geçersiz base: ' + String(args.base).slice(0, 60) };

  /* gh var mı? */
  const v = await run('gh', ['--version'], cwd, 15000);
  if (v.missing) {
    return { ok: false, error: 'gh CLI bulunamadı — kur: winget install GitHub.cli (sonra: gh auth login)' };
  }

  /* dal uzakta yoksa push et — PR için şart */
  const push = await run('git', ['push', '-u', 'origin', branch], cwd, NET_TIMEOUT);
  if (!push.ok && !/up.to.date|everything.up.to.date/i.test(push.err + push.out)) {
    return { ok: false, error: 'dal push edilemedi: ' + (push.err || push.out).trim() };
  }

  const prArgs = ['pr', 'create', '--title', title.slice(0, 300), '--body', String(args.body || '').slice(0, 8000)];
  if (base) prArgs.push('--base', base);
  if (args.draft) prArgs.push('--draft');
  const r = await run('gh', prArgs, cwd, NET_TIMEOUT);
  if (!r.ok) {
    const e = (r.err || r.out).trim();
    if (/already exists/i.test(e)) return { ok: false, error: 'bu dal için PR zaten açık: ' + e };
    return { ok: false, error: 'gh pr create başarısız: ' + e };
  }
  const url = (r.out.match(/https?:\/\/\S+/) || [null])[0];
  return { ok: true, branch, ...(url ? { url } : { output: r.out.trim() }) };
}

const definitions = [
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description:
        'Commit staged or specified changes to the local git repository. Optionally pushes. Returns commit hash, branch and a stat summary. Prefer this over raw `git` shell commands. Usage:\n' +
        '- Provide `message` (required). Stage with `paths` (array of files) or `add_all: true` (everything, including untracked); if neither is given, whatever is already staged is committed.\n' +
        '- The tool refuses when there is nothing staged to commit.\n' +
        '- Set `push: true` to push the branch after committing.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message (concise, matches repo style)' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Specific files/dirs to stage before committing' },
          add_all: { type: 'boolean', description: 'Stage all changes (git add -A) before committing' },
          push: { type: 'boolean', description: 'Push the branch to its remote after committing' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff_review',
      description:
        'Review git changes: returns status, --stat summary and the unified diff of unstaged, staged (--staged) or ref-compared (ref: "HEAD~1", "main...", "a..b") changes. Use to self-review edits before committing or to summarize what changed.',
      parameters: {
        type: 'object',
        properties: {
          staged: { type: 'boolean', description: 'Diff the index (staged) instead of the working tree' },
          ref: { type: 'string', description: 'Compare against a ref, e.g. "HEAD~1", "main", "v1.2.0"' },
          context: { type: 'number', description: 'Unified context lines (default 3, max 20)' },
          max_chars: { type: 'number', description: 'Cap diff output length (default 30000)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_pr_create',
      description:
        'Create a GitHub pull request from the current branch via the gh CLI. Pushes the branch first (git push -u origin <branch>). Refuses on main/master — switch to a feature branch first. Returns the PR URL.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'PR title' },
          body: { type: 'string', description: 'PR description (markdown)' },
          base: { type: 'string', description: 'Target branch (default: repo default branch)' },
          draft: { type: 'boolean', description: 'Create as draft PR' },
        },
        required: ['title'],
      },
    },
  },
];

module.exports = {
  definitions,
  handlers: {
    git_commit: gitCommit,
    git_diff_review: gitDiffReview,
    git_pr_create: gitPrCreate,
  },
  /* test + dış kullanım */
  run,
  insideWorkTree,
  branchName,
};
