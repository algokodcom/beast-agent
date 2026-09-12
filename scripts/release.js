'use strict';

/* Beast Agent — Release / Sync System
   Full release flow with a single command (NO EXE/INSTALLER — npm + source distribution):
     npm run release            → automatic patch bump (0.20.0 → 0.20.1)
     npm run release -- minor   → 0.21.0
     npm run release -- 0.22.0  → specific version

   Steps:
     1) bump the package.json version
     2) commit + tag + push (main + tag)
     3) GitHub Release (source only — no exe/asset upload)
     4) npm publish (only if NPM_TOKEN env var is set; otherwise skipped with a warning)
     5) source copy into the OneDrive backup folder (beast-v< version >)
*/

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ONE_DRIVE_DIR = process.env.BEAST_BACKUP_DIR
  || 'C:\\Users\\batuh\\OneDrive\\Masaüstü\\Beast Agent';

const step = (msg) => console.log('\n\x1b[1m▶ ' + msg + '\x1b[0m');
const ok = (msg) => console.log('  \x1b[32m✓\x1b[0m ' + msg);
const warn = (msg) => console.log('  \x1b[33m!\x1b[0m ' + msg);
const fail = (msg) => { console.error('  \x1b[31m✗ ' + msg + '\x1b[0m'); process.exit(1); };

function run(cmd, opts = {}) {
  /* with stdio:'inherit' execSync returns null — avoid crashing on trim */
  return String(execSync(cmd, { cwd: ROOT, stdio: opts.inherit ? 'inherit' : 'pipe', encoding: 'utf8', ...opts }) ?? '').trim();
}

function bump(version, kind) {
  const [ma, mi, pa] = version.split('.').map(Number);
  if (kind === 'major') return `${ma + 1}.0.0`;
  if (kind === 'minor') return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}

/* ---------- arguments ---------- */
const arg = process.argv[2] || 'patch';
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = pkg.version;
const next = ['major', 'minor', 'patch'].includes(arg) ? bump(current, arg) : arg.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(next)) fail('invalid version: ' + next);
const tag = 'v' + next;

console.log(`\x1b[1mBeast Agent release: ${current} → ${next}\x1b[0m`);

/* ---------- 1) version bump ---------- */
step('1/5 bump version: ' + current + ' → ' + next);
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
ok('package.json → ' + next);

/* ---------- 2) commit + push ---------- */
step('2/5 git: commit + tag + push');
try {
  run('git add -A');
  run(`git commit -m "v${next}"`);
} catch { warn('there were no changes to commit'); }
try { run(`git tag ${tag} -f`); } catch {}
run('git push origin main');
run(`git push origin ${tag}`);
ok('pushed: main + ' + tag);

/* ---------- 3) GitHub Release (source — no exe) ---------- */
step('3/5 GitHub Release ' + tag);
const gh = process.env.GH || 'gh';
let ghOk = false;
try {
  const notes = [
    `## Beast Agent ${tag}`,
    '',
    '- `npm i -g beast-agent@' + next + '`',
    '',
    'Distribution is done via npm — the exe/installer release has been removed.',
    'Full changelog: commit history.',
  ].join('\n');
  const notesFile = path.join(ROOT, 'dist', 'release-notes.md');
  fs.mkdirSync(path.dirname(notesFile), { recursive: true });
  fs.writeFileSync(notesFile, notes);
  try { run(`${gh} release delete ${tag} --yes --cleanup-tag`); } catch {}
  run(`${gh} release create ${tag} --title "Beast Agent ${tag}" --notes-file "${notesFile}"`, { inherit: true });
  ok('release published: https://github.com/algokodcom/beast-agent/releases/tag/' + tag);
  ghOk = true;
} catch (e) {
  /* gh missing / not logged in → skip the release, continue with npm */
  warn('GitHub release skipped (gh missing or error): ' + String(e).slice(0, 160));
}
if (!ghOk) {
  warn('GitHub Release can be created manually: https://github.com/algokodcom/beast-agent/releases/new?tag=' + tag);
}

/* ---------- 4) npm publish ---------- */
step('4/5 npm publish');
if (process.env.NPM_TOKEN) {
  try {
    run(`npm publish --//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}`, { inherit: true });
    ok('npm: beast-agent@' + next);
  } catch (e) {
    warn('npm publish failed (the version may already exist): ' + String(e).slice(0, 200));
  }
} else {
  warn('NPM_TOKEN env is missing — npm step skipped.');
  warn('Manually: set NPM_TOKEN=<token> && npm publish');
}

/* ---------- 5) OneDrive source backup ---------- */
step('5/5 OneDrive backup (beast-v' + next + ')');
try {
  const dest = path.join(ONE_DRIVE_DIR, 'beast-v' + next);
  fs.mkdirSync(dest, { recursive: true });
  /* every robocopy exit code 0-7 is a success (1 = files copied);
     execSync treats anything other than 0 as an error — swallow the code here, stop only on real failure (>7) */
  try {
    execSync(
      `robocopy "${ROOT}" "${dest}" /E /XD node_modules dist "beast agent web" .git /NFL /NDL /NJH`,
      { cwd: ROOT, stdio: 'pipe' }
    );
  } catch (e) {
    const code = e && e.status;
    if (!(typeof code === 'number' && code < 8)) throw e;
  }
  const info = path.join(dest, `BACKUP-INFO-v${next}.txt`);
  fs.writeFileSync(info, `BEAST AGENT v${next} — ${new Date().toLocaleString('en-US')}\nSource: ${ROOT}\nGitHub: https://github.com/algokodcom/beast-agent/releases/tag/${tag}\nnpm: https://www.npmjs.com/package/beast-agent\n`);
  ok(dest);
} catch (e) {
  warn('OneDrive backup skipped: ' + String(e).slice(0, 160));
}

console.log(`\n\x1b[1m\x1b[32m✓ v${next} release complete.\x1b[0m`);
console.log('  GitHub : https://github.com/algokodcom/beast-agent/releases/tag/' + tag);
console.log('  npm    : https://www.npmjs.com/package/beast-agent');
