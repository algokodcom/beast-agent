'use strict';

/* Skills Store web sitesi — yerleşik skill vitrinini üretir.
   Kaynaklar:
     1) src/agent/skills.js  → SEEDS (help, email, pdf, tool-yazma, ...)
     2) src/agent/seeds altındaki SKILL.md dosyaları (Superpowers metodoloji paketi vb.)
   Çıktı:
     public/builtins.json  → site vitrini (varyant + gövde)
     public/community.json → store/skills.json'un deploy kopyası (offline fallback)
   Kullanım: node skillsweb/sync-builtins.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SKILLS_JS = path.join(ROOT, 'src', 'agent', 'skills.js');
const SEEDS_DIR = path.join(ROOT, 'src', 'agent', 'seeds');
const COMMUNITY_SRC = path.join(ROOT, 'store', 'skills.json');
const OUT_DIR = path.join(__dirname, 'public');

const ICONS = {
  help: 'compass',
  email: 'mail',
  'python-web-search': 'search',
  'gold-trading': 'trending',
  pdf: 'file-text',
  'tool-yazma': 'wrench',
  mql5: 'bar',
  'price-action': 'activity',
  'risk-yonetimi': 'shield',
  'haber-duygu': 'news',
  brainstorming: 'bulb',
  'writing-plans': 'clipboard',
  'executing-plans': 'play',
  'test-driven-development': 'flask',
  'subagent-driven-development': 'cpu',
  'dispatching-parallel-agents': 'zap',
  'systematic-debugging': 'bug',
  'verification-before-completion': 'check-circle',
  'writing-skills': 'book',
};

const TAGS = {
  help: ['sistem', 'harita'],
  email: ['e-posta', 'imap'],
  'python-web-search': ['web', 'arama'],
  'gold-trading': ['finans', 'trading'],
  pdf: ['pdf', 'belge', 'ocr'],
  'tool-yazma': ['araç', 'geliştirme'],
  mql5: ['finans', 'mql5'],
  'price-action': ['finans', 'teknik-analiz'],
  'risk-yonetimi': ['finans', 'risk'],
  'haber-duygu': ['haber', 'duygu-analizi'],
  brainstorming: ['metodoloji', 'fikir'],
  'writing-plans': ['metodoloji', 'planlama'],
  'executing-plans': ['metodoloji', 'uygulama'],
  'test-driven-development': ['metodoloji', 'test'],
  'subagent-driven-development': ['metodoloji', 'alt-ajan'],
  'dispatching-parallel-agents': ['metodoloji', 'paralel'],
  'systematic-debugging': ['metodoloji', 'debug'],
  'verification-before-completion': ['metodoloji', 'doğrulama'],
  'writing-skills': ['metodoloji', 'skill'],
};

function parseFrontmatter(text) {
  const m = String(text || '').replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (mm && !(mm[1] in out)) out[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function stripFrontmatter(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/* src/agent/skills.js içindeki `const SEEDS = [...]` bloğunu izole bir VM'de
   değerlendir — şablon literal kaçışlarını elle çözmeye gerek kalmaz. */
function readInlineSeeds() {
  const src = fs.readFileSync(SKILLS_JS, 'utf8');
  const start = src.indexOf('const SEEDS = [');
  const end = src.indexOf('function writeSeed');
  if (start < 0 || end < 0) return [];
  const slice = src.slice(start, end).replace(/;\s*$/, '');
  try {
    return vm.runInNewContext(slice + '\nSEEDS;', {}, { timeout: 5000 }) || [];
  } catch (e) {
    console.error('SEEDS okunamadı:', String((e && e.message) || e));
    return [];
  }
}

function readFileSeeds() {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(SEEDS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(SEEDS_DIR, e.name, 'SKILL.md');
    try {
      out.push({ folder: e.name, body: fs.readFileSync(file, 'utf8'), repoPath: `src/agent/seeds/${e.name}/SKILL.md` });
    } catch {}
  }
  return out;
}

function toEntry(seed) {
  const fm = parseFrontmatter(seed.body);
  const id = String(seed.folder || fm.name || 'skill');
  const body = stripFrontmatter(seed.body).trim();
  return {
    id,
    name: fm.name || id,
    description: fm.description || '',
    version: fm.version || '1.0.0',
    icon: ICONS[id] || '🧩',
    tags: TAGS[id] || [],
    author: { username: 'beast', avatar: '' },
    builtin: true,
    repoPath: seed.repoPath || 'src/agent/skills.js',
    files: { 'SKILL.md': seed.body },
    body,
    bytes: Buffer.byteLength(body, 'utf8'),
    lines: body.split(/\r?\n/).length,
  };
}

function main() {
  const seeds = readInlineSeeds().concat(readFileSeeds());
  const seen = new Set();
  const skills = [];
  for (const s of seeds) {
    if (!s || !s.body) continue;
    const entry = toEntry(s);
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    skills.push(entry);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'builtins.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), count: skills.length, skills }, null, 2)
  );

  try {
    const comm = JSON.parse(fs.readFileSync(COMMUNITY_SRC, 'utf8'));
    fs.writeFileSync(path.join(OUT_DIR, 'community.json'), JSON.stringify(comm, null, 2));
  } catch (e) {
    console.error('community.json kopyalanamadı:', String((e && e.message) || e));
  }

  console.log(`✓ ${skills.length} yerleşik skill yazıldı → public/builtins.json`);
  for (const s of skills) console.log(`   · ${s.icon} ${s.id} v${s.version}`);
}

main();
