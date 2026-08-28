'use strict';

/* Beast Agent — Dağıtım / Senkron Sistemi
   Tek komutla tam sürüm akışı:
     npm run release            → otomatik patch bump (0.15.0 → 0.15.1)
     npm run release -- minor   → 0.16.0
     npm release -- 0.17.0      → belirli sürüm

   Adımlar:
     1) package.json sürümü yükselt
     2) commit + tag + push (main + tag)
     3) npm run dist (NSIS setup + portable)
     4) GitHub Release + exe upload (gh CLI)
     5) npm publish (NPM_TOKEN env var ise; yoksa atlar ve uyarır)
     6) OneDrive yedek klasörüne kaynak kopyası (beast-v< sürüm >)
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
  return execSync(cmd, { cwd: ROOT, stdio: opts.inherit ? 'inherit' : 'pipe', encoding: 'utf8', ...opts }).trim();
}

function bump(version, kind) {
  const [ma, mi, pa] = version.split('.').map(Number);
  if (kind === 'major') return `${ma + 1}.0.0`;
  if (kind === 'minor') return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}

/* ---------- argümanlar ---------- */
const arg = process.argv[2] || 'patch';
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = pkg.version;
const next = ['major', 'minor', 'patch'].includes(arg) ? bump(current, arg) : arg.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(next)) fail('geçersiz sürüm: ' + next);
const tag = 'v' + next;

console.log(`\x1b[1mBeast Agent release: ${current} → ${next}\x1b[0m`);

/* ---------- 1) sürüm bump ---------- */
step('1/6 sürüm yükselt: ' + current + ' → ' + next);
pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
ok('package.json → ' + next);

/* ---------- 2) commit + push ---------- */
step('2/6 git: commit + tag + push');
try {
  run('git add -A');
  run(`git commit -m "v${next}"`);
} catch { warn('commit edilecek değişiklik yoktu'); }
try { run(`git tag ${tag} -f`); } catch {}
run('git push origin main');
run(`git push origin ${tag}`);
ok('pushed: main + ' + tag);

/* ---------- 3) build ---------- */
step('3/6 build: npm run dist (birkaç dakika)');
run('npm run dist', { inherit: true });
const setupExe = path.join(ROOT, 'dist', `BeastAgent-Setup-${next}.exe`);
const portableExe = path.join(ROOT, 'dist', 'BeastAgent.exe');
if (!fs.existsSync(setupExe)) fail('setup exe bulunamadı: ' + setupExe);
if (!fs.existsSync(portableExe)) fail('portable exe bulunamadı: ' + portableExe);
ok('dist hazır: Setup + Portable');

/* ---------- 4) GitHub release ---------- */
step('4/6 GitHub Release ' + tag);
const gh = process.env.GH || 'gh';
try {
  const notes = [
    `## Beast Agent ${tag}`,
    '',
    '- `BeastAgent-Setup-${next}.exe` — kurulumlu (önerilen)',
    '- \`BeastAgent.exe\` — portable',
    '- \`npm i -g beast-agent\` — npm üzerinden',
    '',
    'Tam değişiklik listesi: commit geçmişi.',
  ].join('\n');
  const notesFile = path.join(ROOT, 'dist', 'release-notes.md');
  fs.writeFileSync(notesFile, notes);
  const assets = [setupExe, setupExe + '.blockmap', portableExe, path.join(ROOT, 'dist', 'latest.yml')]
    .filter((f) => fs.existsSync(f))
    .map((f) => `"${f}"`)
    .join(' ');
  try { run(`${gh} release delete ${tag} --yes --cleanup-tag`); } catch {}
  run(`${gh} release create ${tag} ${assets} --title "Beast Agent ${tag}" --notes-file "${notesFile}"`, { inherit: true });
  ok('release yayında: https://github.com/algokodcom/beast-agent/releases/tag/' + tag);
} catch (e) {
  fail('GitHub release: ' + String(e));
}

/* ---------- 5) npm publish ---------- */
step('5/6 npm publish');
if (process.env.NPM_TOKEN) {
  try {
    run(`npm publish --//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}`, { inherit: true });
    ok('npm: beast-agent@' + next);
  } catch (e) {
    warn('npm publish başarısız (sürüm zaten var olabilir): ' + String(e).slice(0, 200));
  }
} else {
  warn('NPM_TOKEN env yok — npm adımı atlandı.');
  warn('Elle: set NPM_TOKEN=<token> && npm publish');
}

/* ---------- 6) OneDrive kaynak yedeği ---------- */
step('6/6 OneDrive yedek (beast-v' + next + ')');
try {
  const dest = path.join(ONE_DRIVE_DIR, 'beast-v' + next);
  fs.mkdirSync(dest, { recursive: true });
  run(`robocopy "${ROOT}" "${dest}" /E /XD node_modules dist "beast agent web" .git /NFL /NDL /NJH`);
  const info = path.join(dest, `YEDEK-BILGI-v${next}.txt`);
  fs.writeFileSync(info, `BEAST AGENT v${next} — ${new Date().toLocaleString('tr-TR')}\nKaynak: ${ROOT}\nGitHub: https://github.com/algokodcom/beast-agent/releases/tag/${tag}\nnpm: https://www.npmjs.com/package/beast-agent\n`);
  ok(dest);
} catch (e) {
  warn('OneDrive yedeği atlandı: ' + String(e).slice(0, 160));
}

console.log(`\n\x1b[1m\x1b[32m✓ v${next} dağıtımı tamam.\x1b[0m`);
console.log('  GitHub : https://github.com/algokodcom/beast-agent/releases/tag/' + tag);
console.log('  npm    : https://www.npmjs.com/package/beast-agent');
