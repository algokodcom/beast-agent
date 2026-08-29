'use strict';

/* SKILLS STORE: topluluk skill mağazası.
   - Yerel DB        : %APPDATA%\beast\store\skills.json   (yüklenen skill'ler, dosyalar gömülü)
   - İstatistik DB   : %APPDATA%\beast\store\stats.json    (installs/likes — makine başına)
   - Topluluk indeksi: GitHub repo /store/skills.json      (raw fetch + offline cache)
   - Kurulum hedefi  : %APPDATA%\beast\skills\<id>\        (skills.scan() otomatik görür)
   Trending/Stars sıralaması renderer'da skorla yapılır; burada ham veri döner.
   Beast Kodu ASLA paylaşılmaz — yalnız sha256 türevi parmak izi (beastId) kullanılır. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { beastRoot } = require('./memory');
const skills = require('./skills');

const COMMUNITY_URL = 'https://raw.githubusercontent.com/algokodcom/beast-agent/main/store/skills.json';
const MAX_FILES = 20;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const ALLOWED_EXT = new Set(['.md', '.py', '.js', '.ts', '.ps1', '.json', '.yaml', '.yml', '.txt', '.csv', '.sh', '.bat', '.cmd', '.html', '.css']);
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.drafts']);

function storeDir() {
  return path.join(beastRoot(), 'store');
}
function dbFile() {
  return path.join(storeDir(), 'skills.json');
}
function statsFile() {
  return path.join(storeDir(), 'stats.json');
}
function communityCacheFile() {
  return path.join(storeDir(), 'community.json');
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function loadLocal() {
  const db = readJson(dbFile(), { version: 1, skills: [] });
  if (!Array.isArray(db.skills)) db.skills = [];
  return db;
}

function saveLocal(db) {
  writeJson(dbFile(), db);
}

function loadStats() {
  const s = readJson(statsFile(), {});
  return s && typeof s === 'object' ? s : {};
}

function saveStats(s) {
  writeJson(statsFile(), s);
}

/* Beast Kodu → genel parmak izi (benzersiz kimlik; gerçek kod saklanmaz) */
function beastFingerprint(beastCode) {
  const h = crypto.createHash('sha256').update(String(beastCode || 'beast')).digest('hex');
  return 'BEAST-' + h.slice(0, 8).toUpperCase();
}

function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[çğıöşü]/g, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' }[c] || c))
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'skill'
  );
}

/* ---------- topluluk indeksi ---------- */

async function fetchCommunity(timeoutMs = 6000) {
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => {
      try {
        ctl && ctl.abort();
      } catch {}
    }, timeoutMs);
    const r = await fetch(COMMUNITY_URL, { signal: ctl ? ctl.signal : undefined });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j && Array.isArray(j.skills)) {
      try {
        writeJson(communityCacheFile(), j);
      } catch {}
      return j.skills;
    }
    return [];
  } catch {
    /* offline: son iyi kopyadan devam */
    const cached = readJson(communityCacheFile(), { skills: [] });
    return Array.isArray(cached.skills) ? cached.skills : [];
  }
}

function mergeStats(entry, stats) {
  const st = stats[entry.id] || {};
  return {
    ...entry,
    installs: (entry.installs || 0) + (st.installs || 0),
    likes: (entry.likes || 0) + (st.likes || 0),
    liked: !!st.liked,
    installedAt: st.installedAt || null,
  };
}

/* Birleşik liste: topluluk + yerel (aynı id'de yerel kazanır) */
async function list(beastCode) {
  const [community] = await Promise.all([fetchCommunity()]);
  const db = loadLocal();
  const stats = loadStats();
  const byId = new Map();
  for (const e of community) {
    if (e && e.id && e.files && e.files['SKILL.md']) byId.set(e.id, e);
  }
  for (const e of db.skills) if (e && e.id) byId.set(e.id, e);
  const entries = [...byId.values()].map((e) => mergeStats(e, stats));
  const installed = new Set(skills.scan().map((s) => path.basename(path.dirname(s.path))));
  return {
    ok: true,
    beastId: beastFingerprint(beastCode),
    entries,
    installed: [...installed],
  };
}

/* Kullanıcı adı benzersizliği: aynı ad başka beastId'de kayıtlıysa alınmıştır */
function usernameTaken(username, beastId) {
  const want = String(username || '').toLowerCase();
  if (!want) return false;
  const db = loadLocal();
  for (const e of db.skills) {
    const a = e.author || {};
    if (String(a.username || '').toLowerCase() === want && a.beastId !== beastId) return true;
  }
  return false;
}

/* ---------- yükleme ---------- */

/* Klasör önizleme (commit etmeden önce): SKILL.md frontmatter'ı + dosya dökümü */
function preview(dirPath) {
  try {
    const p = String(dirPath || '');
    const skillMd = path.join(p, 'SKILL.md');
    if (!fs.existsSync(skillMd)) return { ok: false, error: 'SKILL.md bulunamadı — skill klasörü SKILL.md içermeli' };
    const text = fs.readFileSync(skillMd, 'utf8');
    const fm = skills.parseFrontmatter(text);
    const files = [];
    let total = 0;
    const walk = (d, depth) => {
      if (depth > 3) return;
      let rows;
      try {
        rows = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of rows) {
        if (files.length >= MAX_FILES) return;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (!ALLOWED_EXT.has(ext)) continue;
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {}
        if (size > MAX_FILE_BYTES) continue;
        total += size;
        files.push({ rel: path.relative(p, full).replace(/\\/g, '/'), size });
      }
    };
    walk(p, 0);
    if (!files.some((f) => f.rel === 'SKILL.md')) files.unshift({ rel: 'SKILL.md', size: Buffer.byteLength(text, 'utf8') });
    return {
      ok: true,
      path: p,
      folderName: path.basename(p),
      name: fm.name || path.basename(p),
      description: fm.description || '',
      version: fm.version || '1.0.0',
      files,
      totalBytes: total,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* Yüklemeyi yerel DB'ye işler; files utf8 metin olarak gömülür */
function commit({ dirPath, name, description, tags, author }) {
  try {
    const pv = preview(dirPath);
    if (!pv.ok) return pv;
    const nm = String(name || pv.name || '').trim().slice(0, 60);
    if (!nm) return { ok: false, error: 'skill adı gerekli' };
    const a = author || {};
    const username = String(a.username || '').trim();
    if (!/^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
      return { ok: false, error: 'kullanıcı adı 3-20 karakter (harf/rakam/_/-) olmalı' };
    }
    if (!a.avatar || String(a.avatar).length > 8) return { ok: false, error: 'avatar seç' };
    if (!a.beastId) return { ok: false, error: 'beast kimliği yok' };
    /* KAPAK RESMİ ZORUNLU: kare kırpılmış dataURL (renderer canvas ile üretir) */
    const img = String((a.image || '') || '');
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(img)) {
      return { ok: false, error: 'kapak resmi zorunlu — kare kırpılmış bir resim eklenmeli' };
    }
    if (img.length > 400 * 1024) return { ok: false, error: 'kapak resmi çok büyük (max ~300KB)' };
    if (usernameTaken(username, a.beastId)) {
      return { ok: false, error: `"${username}" kullanıcı adı başka bir Beast tarafından alınmış — başka ad seç` };
    }
    /* dosyaları oku */
    const files = {};
    let total = 0;
    for (const f of pv.files) {
      const raw = fs.readFileSync(path.join(dirPath, f.rel));
      if (total + raw.length > MAX_TOTAL_BYTES) return { ok: false, error: 'paket çok büyük (max 1MB)' };
      files[f.rel] = raw.toString('utf8');
      total += raw.length;
    }
    if (!files['SKILL.md']) return { ok: false, error: 'SKILL.md okunamadı' };
    const db = loadLocal();
    const id = slugify(nm);
    const now = new Date().toISOString();
    const existing = db.skills.find((e) => e.id === id);
    const entry = {
      id,
      name: nm,
      description: String(description || pv.description || '').trim().slice(0, 200),
      version: pv.version || '1.0.0',
      tags: (Array.isArray(tags) ? tags : []).map((t) => String(t).trim().toLowerCase().slice(0, 20)).filter(Boolean).slice(0, 4),
      author: { username, avatar: String(a.avatar), beastId: a.beastId },
      image: img,
      files,
      installs: existing ? existing.installs || 0 : 0,
      likes: existing ? existing.likes || 0 : 0,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    if (existing) db.skills.splice(db.skills.indexOf(existing), 1, entry);
    else db.skills.push(entry);
    saveLocal(db);
    return { ok: true, entry: { ...entry, files: undefined, fileCount: Object.keys(files).length } };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- kurulum ---------- */

async function install(id) {
  try {
    const key = String(id || '');
    if (!/^[a-z0-9_-]{1,40}$/i.test(key)) return { ok: false, error: 'geçersiz id' };
    const db = loadLocal();
    let entry = db.skills.find((e) => e.id === key);
    if (!entry) {
      const comm = await fetchCommunity();
      entry = (comm || []).find((e) => e && e.id === key && e.files && e.files['SKILL.md']);
    }
    if (!entry) return { ok: false, error: 'skill bulunamadı' };
    const dest = path.join(skills.dir(), key);
    const stats = loadStats();
    /* built-in koruması: store'dan hiç kurulmamış klasörün üstüne yazma */
    if (fs.existsSync(dest) && !stats[key]) {
      return { ok: false, error: 'aynı adda kurulu bir skill var — store kurulumu için ad farklı olmalı' };
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const [rel, content] of Object.entries(entry.files || {})) {
      const target = path.join(dest, rel);
      if (!target.startsWith(dest)) continue; // path traversal koruması
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(content ?? ''), 'utf8');
    }
    stats[key] = stats[key] || { installs: 0, likes: 0, liked: false };
    stats[key].installs = (stats[key].installs || 0) + 1;
    stats[key].installedAt = new Date().toISOString();
    saveStats(stats);
    /* yerel yüklemeyse DB'deki sayaç da artsın */
    const local = db.skills.find((e) => e.id === key);
    if (local) {
      local.installs = (local.installs || 0) + 1;
      saveLocal(db);
    }
    return { ok: true, id: key, folder: dest };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function toggleLike(id) {
  try {
    const key = String(id || '');
    if (!key) return { ok: false, error: 'id gerekli' };
    const stats = loadStats();
    stats[key] = stats[key] || { installs: 0, likes: 0, liked: false };
    const st = stats[key];
    if (st.liked) {
      st.liked = false;
      st.likes = Math.max(0, (st.likes || 0) - 1);
    } else {
      st.liked = true;
      st.likes = (st.likes || 0) + 1;
    }
    saveStats(stats);
    const db = loadLocal();
    const local = db.skills.find((e) => e.id === key);
    if (local) {
      local.likes = Math.max(0, (local.likes || 0) + (st.liked ? 1 : -1));
      saveLocal(db);
    }
    return { ok: true, liked: st.liked, likes: st.likes };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* kendi yüklediğini kaldırma (yalnız yerel kayıt + kendi beastId) */
function removeMine(id, beastId) {
  try {
    const db = loadLocal();
    const e = db.skills.find((x) => x.id === String(id || ''));
    if (!e) return { ok: false, error: 'yerel kayıt yok' };
    if (!beastId || (e.author || {}).beastId !== beastId) return { ok: false, error: 'bu skill senin değil' };
    db.skills.splice(db.skills.indexOf(e), 1);
    saveLocal(db);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/* Kendi paylaşımlarını GitHub'da paylaşmak için dışa aktarım (issue gövdesi) */
function exportEntry(id) {
  try {
    const db = loadLocal();
    const e = db.skills.find((x) => x.id === String(id || ''));
    if (!e) return { ok: false, error: 'yerel kayıt yok' };
    return { ok: true, json: JSON.stringify({ version: 1, skills: [e] }, null, 2) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = {
  beastFingerprint,
  list,
  preview,
  commit,
  install,
  toggleLike,
  removeMine,
  exportEntry,
  usernameTaken,
};
