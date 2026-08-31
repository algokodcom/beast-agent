'use strict';

/* Beast Bot Sistemi (BÖLÜM 2 / 3 / 6 / 7)
   - İlk bot hep "Beast" (admin, silinemez). Toplam MAX 5 bot (1 admin + 4 müşteri).
   - Her bot izole klasörde yaşar: bots/<id>/
       config.json      → botun temel ayarı (ayna)
       memory.md        → botun KENDİ hafızası (diğer botlar göremez)
       yetkiler.json    → görebildiği botlar + skill/plugin/tarayıcı yetkileri
       logs/changes.log → yetki/ayar değişiklik günlüğü (her değişiklik loglanır)
       chat/ plugins/ watchers/  → botun izole çalışma alanları
   - WhatsApp numaraları bot_id ile eşlenir; registry bots.json'da durur.
     whitelist.json aynası main tarafında senkronlanır. */

const fs = require('fs');
const path = require('path');
const os = require('os');
const memory = require('./memory'); // tokenize/scoreEntry yeniden kullanılır (döngü yok)

const MAX_BOTS = 5;

const ICONS = ['🦁', '🚀', '💎', '⭐', '🔥', '🧮', '📊', '🤖', '🦊', '🐼', '🎯', '🛠️'];

/* Her botta varsayılan AÇIK gelen skill'ler (yetki sadece admin tarafından değişir) */
const DEFAULT_SKILLS = {
  email: true,
  browser: true, // dahili tarayıcı varsayılan TÜM botlarda aktif
  web_search: true,
  run_command: false,
  memory: true,
  kb: true,
};

const SKILL_LIST = [
  ['email', 'E-posta (okuma/gönderme)'],
  ['browser', 'Dahili tarayıcı (panel)'],
  ['web_search', 'Web arama + sayfa okuma'],
  ['run_command', 'Terminal / dosya / ekran'],
  ['memory', 'Kendi hafızası (yazma/arama)'],
  ['kb', 'Bilgi bankası (arama/ekleme)'],
];

const PLUGIN_LIST = ['fatura_okuyucu', 'crm_plugin', 'rapor_uretici', 'stok_takip', 'toplanti_ozet'];

function beastRoot() {
  if (process.env.BEAST_DATA) return process.env.BEAST_DATA;
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, 'beast')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'beast');
}

function registryFile() {
  return path.join(beastRoot(), 'bots.json');
}

function botDir(id) {
  return path.join(beastRoot(), 'bots', String(id || '').replace(/[^a-z0-9_-]/gi, ''));
}

function nowIso() {
  return new Date().toISOString();
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function foldTr(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[çğıöşüâîû]/g, (ch) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' }[ch] || ch));
}

function slugify(name) {
  const base = foldTr(String(name || 'bot'))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 18);
  return base || 'bot';
}

function adminBot() {
  return {
    id: 'beast',
    name: 'Beast',
    icon: '🦁',
    admin: true,
    code: '', // 5 haneli benzersiz bot kodu (ensureBotCodes atar)
    prompt: '',
    perm: 'all',
    vis: true, // sohbet görünürlüğü: ana sohbete davet edilebilir
    skills: { ...DEFAULT_SKILLS, run_command: true },
    seeBots: [], // admin her şeyi görür
    extBrowser: true, // dış tarayıcı yetkisi
    browserDefault: 'dahili',
    extCommand: '',
    plugins: [],
    createdAt: nowIso(),
  };
}

/* ---------- registry ---------- */

let REG = null;

function loadRegistry() {
  if (REG) return REG;
  try {
    REG = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
  } catch {
    REG = null;
  }
  if (!REG || !Array.isArray(REG.bots)) REG = { bots: [adminBot()] };
  /* beast her zaman ilk ve admin */
  const beast = REG.bots.find((b) => b && b.id === 'beast');
  if (!beast) REG.bots.unshift(adminBot());
  else Object.assign(beast, { ...adminBot(), ...beast, id: 'beast', admin: true, name: beast.name || 'Beast' });
  saveRegistry();
  ensureDirs();
  return REG;
}

function saveRegistry() {
  try {
    fs.mkdirSync(beastRoot(), { recursive: true });
    fs.writeFileSync(registryFile(), JSON.stringify(REG, null, 2));
  } catch {}
}

function ensureDirs() {
  for (const b of REG.bots) {
    const d = botDir(b.id);
    try {
      for (const sub of ['logs', 'chat', 'plugins', 'watchers']) fs.mkdirSync(path.join(d, sub), { recursive: true });
      const cfgP = path.join(d, 'config.json');
      if (!fs.existsSync(cfgP)) fs.writeFileSync(cfgP, JSON.stringify(botConfigOf(b), null, 2));
      const yetP = path.join(d, 'yetkiler.json');
      if (!fs.existsSync(yetP)) fs.writeFileSync(yetP, JSON.stringify(botPermsOf(b), null, 2));
      /* bot hafızası ayarlardaki yapıyla aynı: SOUL.md + MEMORY.md + USER.md
         (eski memory.md varsa içeriği MEMORY.md'ye taşınır) */
      const legacyP = path.join(d, 'memory.md');
      const legacy = fs.existsSync(legacyP) ? fs.readFileSync(legacyP, 'utf8') : '';
      const memP = path.join(d, 'MEMORY.md');
      if (!fs.existsSync(memP)) fs.writeFileSync(memP, legacy || '');
      for (const f of ['SOUL.md', 'USER.md']) {
        const p = path.join(d, f);
        if (!fs.existsSync(p)) fs.writeFileSync(p, '');
      }
    } catch {}
  }
}

function botConfigOf(b) {
  return {
    id: b.id,
    name: b.name,
    icon: b.icon,
    admin: !!b.admin,
    code: b.code || '',
    prompt: b.prompt || '',
    browser: { default: b.browserDefault || 'dahili', extCommand: b.extCommand || '' },
    plugins: b.plugins || [],
    createdAt: b.createdAt,
  };
}

function botPermsOf(b) {
  return {
    id: b.id,
    perm: b.perm || 'all',
    skills: { ...DEFAULT_SKILLS, ...(b.skills || {}) },
    seeBots: b.seeBots || [],
    extBrowser: b.extBrowser !== false,
  };
}

/* ---------- log ---------- */

function logChange(id, text) {
  try {
    const d = botDir(id);
    fs.mkdirSync(path.join(d, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(d, 'logs', 'changes.log'), `[${new Date().toISOString()}] ${text}\n`);
  } catch {}
}

/* ---------- public API ---------- */

function list() {
  loadRegistry();
  return REG.bots.map((b) => ({ ...b, skills: { ...DEFAULT_SKILLS, ...(b.skills || {}) } }));
}

function get(id) {
  loadRegistry();
  return REG.bots.find((b) => b.id === String(id || '')) || null;
}

function add({ name, icon, prompt }) {
  loadRegistry();
  const n = String(name || '').trim().slice(0, 40);
  if (!n) return { ok: false, error: 'bot adı zorunlu' };
  if (REG.bots.length >= MAX_BOTS) return { ok: false, error: `en fazla ${MAX_BOTS} bot olabilir (1 admin + ${MAX_BOTS - 1} müşteri)` };
  let id = slugify(n);
  while (get(id)) id = slugify(n) + '-' + uid().slice(-4);
  const bot = {
    id,
    name: n,
    icon: ICONS.includes(icon) ? icon : '🤖',
    admin: false,
    code: '', // ensureBotCodes hemen altında benzersiz 5 hane atar
    prompt: String(prompt || '').slice(0, 4000),
    perm: 'all',
    vis: true, // sohbet görünürlüğü (admin matristen kapatır)
    skills: { ...DEFAULT_SKILLS },
    seeBots: [], // varsayılan: hiçbir bot baka botu göremez
    extBrowser: false, // dış tarayıcı sadece yetkilide
    browserDefault: 'dahili',
    extCommand: '',
    plugins: [],
    createdAt: nowIso(),
  };
  REG.bots.push(bot);
  ensureBotCodes();
  saveRegistry();
  ensureDirs();
  logChange(id, `bot oluşturuldu (name="${n}", icon=${bot.icon}, code=${bot.code})`);
  return { ok: true, bot: { ...bot } };
}

/* ---------- 5 HANELİ BENZERSİZ BOT KODU ----------
   Her bot oluşurken 10000-99999 arası rastgele kod alır; duplicate kontrolü
   zorunlu (tüm botlara karşı). Açılışta kodu eksik/çakışık botlara da atanır. */
function ensureBotCodes() {
  loadRegistry();
  let dirty = false;
  const used = () => new Set(REG.bots.map((b) => String(b.code || '')).filter((c) => /^\d{5}$/.test(c)));
  const seen = new Set();
  for (const b of REG.bots) {
    const cur = String(b.code || '');
    if (/^\d{5}$/.test(cur) && !seen.has(cur)) { seen.add(cur); continue; }
    const u = used();
    let c;
    do { c = String(10000 + Math.floor(Math.random() * 90000)); } while (u.has(c));
    logChange(b.id, `bot kodu atandı: ${c}${cur ? ` (eskisi geçersizdi: ${cur})` : ''}`);
    b.code = c;
    seen.add(c);
    dirty = true;
  }
  if (dirty) saveRegistry();
  return dirty;
}

function byCode(code) {
  const c = String(code || '').replace(/\D/g, '');
  if (!/^\d{5}$/.test(c)) return null;
  loadRegistry();
  return REG.bots.find((b) => String(b.code || '') === c) || null;
}

function update(id, patch) {
  loadRegistry();
  const b = get(id);
  if (!b) return { ok: false, error: 'bot yok' };
  const changes = [];
  if (patch && typeof patch === 'object') {
    if (typeof patch.name === 'string' && patch.name.trim() && patch.name.trim() !== b.name) {
      changes.push(`name: "${b.name}" → "${patch.name.trim().slice(0, 40)}"`);
      b.name = patch.name.trim().slice(0, 40);
    }
    if (typeof patch.icon === 'string' && ICONS.includes(patch.icon) && patch.icon !== b.icon) {
      changes.push(`icon: ${b.icon} → ${patch.icon}`);
      b.icon = patch.icon;
    }
    if (typeof patch.prompt === 'string' && patch.prompt !== b.prompt) {
      changes.push('prompt güncellendi');
      b.prompt = String(patch.prompt).slice(0, 4000);
    }
    if (patch.perm !== undefined) {
      /* 'all' tek başına tüm araçları verir; web/read/chat çoklu seçilebilir
         (['web','read'] gibi dizi ya da 'web,read' gibi string kabul edilir) */
      const PERMS_ALL = ['all', 'web', 'read', 'chat'];
      let nextPerm = null;
      if (Array.isArray(patch.perm)) {
        const picked = [...new Set(patch.perm.map((x) => String(x).trim()).filter((x) => PERMS_ALL.includes(x)))];
        nextPerm = picked.includes('all') ? 'all' : (picked.length ? picked : 'chat');
      } else if (typeof patch.perm === 'string') {
        const arr = patch.perm.split(',').map((x) => x.trim()).filter((x) => PERMS_ALL.includes(x));
        if (arr.length) nextPerm = arr.includes('all') ? 'all' : (arr.length === 1 ? arr[0] : arr);
      }
      if (nextPerm !== null && JSON.stringify(nextPerm) !== JSON.stringify(b.perm)) {
        const fp = (p) => (Array.isArray(p) ? '[' + p.join('+') + ']' : String(p));
        changes.push(`perm: ${fp(b.perm)} → ${fp(nextPerm)}`);
        b.perm = nextPerm;
      }
    }
    if (patch.skills && typeof patch.skills === 'object') {
      const merged = { ...DEFAULT_SKILLS, ...(b.skills || {}) };
      for (const k of Object.keys(DEFAULT_SKILLS)) {
        if (typeof patch.skills[k] === 'boolean' && patch.skills[k] !== merged[k]) {
          changes.push(`skill ${k}: ${merged[k]} → ${patch.skills[k]}`);
          merged[k] = patch.skills[k];
        }
      }
      b.skills = merged;
    }
    if (Array.isArray(patch.seeBots)) {
      const valid = patch.seeBots.map(String).filter((x) => x !== b.id && get(x));
      const next = [...new Set(valid)];
      if (JSON.stringify(next) !== JSON.stringify(b.seeBots || [])) {
        changes.push(`görebilir: [${(b.seeBots || []).join(', ') || '—'}] → [${next.join(', ') || '—'}]`);
        b.seeBots = next;
      }
    }
    if (typeof patch.extBrowser === 'boolean' && patch.extBrowser !== b.extBrowser) {
      changes.push(`dış tarayıcı yetkisi: ${b.extBrowser} → ${patch.extBrowser}`);
      b.extBrowser = patch.extBrowser;
    }
    if (typeof patch.vis === 'boolean' && patch.vis !== (b.vis !== false)) {
      changes.push(`sohbet görünürlüğü: ${b.vis !== false} → ${patch.vis}`);
      b.vis = patch.vis;
    }
    if (['dahili', 'dis'].includes(patch.browserDefault) && patch.browserDefault !== b.browserDefault) {
      changes.push(`varsayılan tarayıcı: ${b.browserDefault} → ${patch.browserDefault}`);
      b.browserDefault = patch.browserDefault;
    }
    if (typeof patch.extCommand === 'string' && patch.extCommand !== b.extCommand) {
      changes.push('dış tarayıcı komutu güncellendi');
      b.extCommand = String(patch.extCommand).slice(0, 200);
    }
    if (Array.isArray(patch.plugins)) {
      const next = [...new Set(patch.plugins.map((p) => String(p).slice(0, 40)).filter((p) => PLUGIN_LIST.includes(p)))];
      if (JSON.stringify(next) !== JSON.stringify(b.plugins || [])) {
        changes.push(`pluginler: [${(b.plugins || []).join(', ') || '—'}] → [${next.join(', ') || '—'}]`);
        b.plugins = next;
      }
    }
  }
  saveRegistry();
  ensureDirs();
  try {
    const d = botDir(b.id);
    fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify(botConfigOf(b), null, 2));
    fs.writeFileSync(path.join(d, 'yetkiler.json'), JSON.stringify(botPermsOf(b), null, 2));
  } catch {}
  for (const c of changes) logChange(b.id, `yetki/ayar değişikliği (admin): ${c}`);
  return { ok: true, bot: { ...b }, changed: changes.length };
}

function remove(id) {
  loadRegistry();
  const b = get(id);
  if (!b) return { ok: false, error: 'bot yok' };
  if (b.admin) return { ok: false, error: 'admin bot silinemez' };
  REG.bots = REG.bots.filter((x) => x.id !== b.id);
  saveRegistry();
  logChange(b.id, `bot SİLİNDİ — bağlı numaralar botsuz duruma düştü (beast'e yönlendirilir)`);
  /* klasör arşivlenir — veri kaybı olmasın */
  try {
    const d = botDir(b.id);
    if (fs.existsSync(d)) fs.renameSync(d, d + '-arsiv-' + Date.now().toString(36));
  } catch {}
  return { ok: true };
}

/* viewer botun target botu görüp göremeyeceği */
function canSee(viewerId, targetId) {
  const v = get(viewerId);
  if (!v) return false;
  if (v.admin) return true; // admin her şeyi görür
  if (viewerId === targetId) return true;
  return (v.seeBots || []).includes(String(targetId));
}

/* botun hafıza dosyaları — ayarlardaki SOUL/USER/MEMORY üçlüsünün bot izole hali */
const BOT_MEM_FILES = ['SOUL.md', 'MEMORY.md', 'USER.md'];

/* botun MEMORY.md'si (persona bloğuna giden kısım) */
function readMemory(id, cap = 2000) {
  try {
    return fs.readFileSync(path.join(botDir(id), 'MEMORY.md'), 'utf8').slice(0, cap).trim();
  } catch {
    return '';
  }
}

function readMemoryFiles(id) {
  const d = botDir(id);
  const out = { soul: '', memory: '', user: '' };
  try { out.soul = fs.readFileSync(path.join(d, 'SOUL.md'), 'utf8'); } catch {}
  try { out.memory = fs.readFileSync(path.join(d, 'MEMORY.md'), 'utf8'); } catch {}
  try { out.user = fs.readFileSync(path.join(d, 'USER.md'), 'utf8'); } catch {}
  return out;
}

function writeMemoryFile(id, file, content) {
  const b = get(id);
  if (!b) return { ok: false, error: 'bot yok' };
  if (!BOT_MEM_FILES.includes(file)) return { ok: false, error: 'geçersiz dosya' };
  try {
    const d = botDir(id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, file), String(content ?? ''), 'utf8');
    logChange(id, `${file} admin tarafından güncellendi`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- BOT OTURUMU hafıza operasyonları ----------
   Bot oturumlarında memory_write/memory_search GLOBAL Beast hafızasına DEĞİL,
   botun kendi SOUL/USER/MEMORY dosyalarına gider (tam izolasyon). */

function readMem(id, f) {
  if (!BOT_MEM_FILES.includes(f)) return '';
  try {
    return fs.readFileSync(path.join(botDir(id), f), 'utf8');
  } catch {
    return '';
  }
}

function memEntries(id) {
  return readMem(id, 'MEMORY.md')
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function appendMem(id, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!t) return { ok: false, error: 'empty' };
  const list = memEntries(id);
  const key = foldTr(t).replace(/[^a-z0-9]+/g, ' ').trim();
  if (list.some((l) => foldTr(l).replace(/[^a-z0-9]+/g, ' ').trim() === key)) {
    return { ok: true, duplicate: true };
  }
  try {
    fs.mkdirSync(botDir(id), { recursive: true });
    fs.appendFileSync(path.join(botDir(id), 'MEMORY.md'), '- ' + t + '\n');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* botun USER.md'si: bota özel kullanıcı profili (aynı dedup/yenile mantığı) */
function appendUserMem(id, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!t) return { ok: false, error: 'empty' };
  try {
    const p = path.join(botDir(id), 'USER.md');
    fs.mkdirSync(botDir(id), { recursive: true });
    const lines = readMem(id, 'USER.md')
      .split('\n')
      .map((l) => l.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);
    /* profil anahtarı: "Konu: ..." satırlarında Konu — değişiklikte güncelle */
    const topicOf = (s) => {
      const c = foldTr(s).indexOf(':');
      return (c > 0 ? foldTr(s).slice(0, c) : foldTr(s)).replace(/[^a-z0-9]+/g, ' ').trim();
    };
    const topic = topicOf(t);
    const idx = lines.findIndex((l) => topicOf(l) === topic);
    if (idx >= 0) {
      if (lines[idx] === t) return { ok: true, duplicate: true };
      lines[idx] = t;
    } else {
      lines.push(t);
    }
    while (lines.length > 60) lines.shift();
    fs.writeFileSync(p, lines.map((l) => '- ' + l).join('\n') + '\n');
    return { ok: true, updated: idx >= 0 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function searchMem(id, query, limit = 8) {
  const list = memEntries(id);
  if (!list.length) return [];
  const qTokens = memory.tokenize(query);
  let rows;
  if (!qTokens.length) {
    rows = list.map((text, i) => ({ text, score: 0, i })).slice(-limit).reverse();
  } else {
    rows = list
      .map((text, i) => ({ text, i, score: Number(memory.scoreEntry(text, qTokens).toFixed(3)) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  return rows.map(({ text, score }) => ({ score, text }));
}

function relevantMem(id, query, { maxRelevant = 6, maxRecent = 4, charCap = 2400 } = {}) {
  const list = memEntries(id);
  if (!list.length) return '';
  const qTokens = memory.tokenize(query);
  const picked = new Set();
  if (qTokens.length) {
    list
      .map((text, i) => ({ i, score: memory.scoreEntry(text, qTokens) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxRelevant)
      .forEach((r) => picked.add(r.i));
  }
  for (let i = list.length - 1; i >= 0 && picked.size < maxRelevant + maxRecent; i--) picked.add(i);
  let out = '';
  for (const i of [...picked].sort((a, b) => a - b)) {
    const line = '- ' + list[i];
    if (out.length + line.length > charCap) break;
    out += (out ? '\n' : '') + line;
  }
  return out;
}

function readLog(id, cap = 20000) {
  try {
    return fs.readFileSync(path.join(botDir(id), 'logs', 'changes.log'), 'utf8').slice(-cap);
  } catch {
    return '';
  }
}

module.exports = {
  MAX_BOTS,
  ICONS,
  SKILL_LIST,
  PLUGIN_LIST,
  beastRoot,
  botDir,
  list,
  get,
  add,
  update,
  remove,
  canSee,
  ensureBotCodes,
  byCode,
  readMemory,
  readMemoryFiles,
  writeMemoryFile,
  readMem,
  appendMem,
  appendUserMem,
  searchMem,
  relevantMem,
  readLog,
};
