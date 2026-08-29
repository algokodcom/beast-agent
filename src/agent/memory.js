'use strict';

/* Beast memory: SOUL.md + MEMORY.md + USER.md under %APPDATA%\beast\memories.
   Tiny and append-only; the model writes via the memory_write tool.
   MEMORY.md is NOT dumped into the prompt anymore: buildSystem pulls only
   entries relevant to the current query (retrieval) and the agent can call
   memory_search to dig deeper on demand. */

const fs = require('fs');
const path = require('path');
const os = require('os');

function beastRoot() {
  if (process.env.BEAST_DATA) return process.env.BEAST_DATA; // test/taşınabilirlik
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, 'beast')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'beast');
}

function memDir() {
  return path.join(beastRoot(), 'memories');
}

function ensure() {
  fs.mkdirSync(memDir(), { recursive: true });
  const soulPath = path.join(memDir(), 'SOUL.md');
  if (!fs.existsSync(soulPath)) {
    /* SOUL.md = ajanın kişiliği. Kullanıcı Ayarlar → Memory'den düzenler;
       bu dosyanın tamamı her istekte sistem promptuna birebir girer. */
    const seed = [
      'Sen Beast Agent\u2019sın — kullanıcının Windows makinesinde yerel çalışan hızlı, hafif ve becerikli bir asistan.',
      '',
      'KİŞİLİK',
      '- Doğrudan ve netsin; lafı dolandırmazsın, gereksiz özür ve dolgu cümle kurmazsın.',
      '- Samimi ama işini ciddiye alırsın; kullanıcıya güven verirsin.',
      '- Proaktiftir: yapabildiğini yapar, mümkünse sormak yerine yapar.',
      '',
      'TON VE DAVRANIŞ',
      '- Kısa ve öz cevap ver; madde işaretlerinde "-" kullan.',
      '- Yaptığın işleri kısaca raporlarsın; hata olursa nasıl düzeltileceğini da söylersin.',
      '',
      '(Kişiliğini değiştirmek için bu dosyayı düzenle — yazdığın her şey ajanı tanımlar.)',
    ].join('\n');
    fs.writeFileSync(soulPath, seed);
  }
  for (const f of ['MEMORY.md', 'USER.md']) {
    const p = path.join(memDir(), f);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  }
}

function read(f) {
  try {
    return fs.readFileSync(path.join(memDir(), f), 'utf8').trim();
  } catch {
    return '';
  }
}

function loadAll() {
  ensure();
  return { soul: read('SOUL.md'), user: read('USER.md'), memory: read('MEMORY.md') };
}

function append(text) {
  try {
    ensure();
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!t) return { ok: false, error: 'empty' };
    /* fold'lu dedup: aynı/near-same kayıt iki kez girmez */
    const key = fold(t).replace(/[^a-z0-9]+/g, ' ').trim();
    const list = entries();
    if (list.some((l) => fold(l).replace(/[^a-z0-9]+/g, ' ').trim() === key)) {
      return { ok: true, duplicate: true };
    }
    fs.appendFileSync(path.join(memDir(), 'MEMORY.md'), '- ' + t + '\n');
    /* cap koruması: 400 kaydı aşınca otomatik hijyen */
    if (list.length + 1 > 400) {
      try { hygiene({}); } catch {}
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* USER.md: kullanıcının PROİL dosyası (ad, hitap, tercihler, projeler).
   append'in satır-satıır dedup'ı burada da geçerli; kayıt sayısı sınırlı tutulur. */
const USER_CAP = 60;

function appendUser(text) {
  try {
    ensure();
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!t) return { ok: false, error: 'empty' };
    const lines = read('USER.md')
      .split('\n')
      .map((l) => l.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);
    /* profil anahtarı: "Konu: ..." satırlarında Konu — "Hitap: kanka" sonra
       "Hitap: Batuhan" gelirse satır eklenmez, eskisi GÜNCELLENİR */
    const topicOf = (s) => {
      const c = fold(s).indexOf(':');
      return (c > 0 ? fold(s).slice(0, c) : fold(s)).replace(/[^a-z0-9]+/g, ' ').trim();
    };
    const topic = topicOf(t);
    const idx = lines.findIndex((l) => topicOf(l) === topic);
    if (idx >= 0) {
      if (lines[idx] === t) return { ok: true, duplicate: true };
      lines[idx] = t;
    } else {
      lines.push(t);
    }
    while (lines.length > USER_CAP) lines.shift();
    fs.writeFileSync(path.join(memDir(), 'USER.md'), lines.map((l) => '- ' + l).join('\n') + '\n');
    return { ok: true, updated: idx >= 0 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

const ALLOWED_FILES = ['SOUL.md', 'MEMORY.md', 'USER.md'];

function save(file, content) {
  try {
    if (!ALLOWED_FILES.includes(file)) return { ok: false, error: 'bad file' };
    ensure();
    fs.writeFileSync(path.join(memDir(), file), String(content ?? ''), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- retrieval ---------- */

const TR_FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

function fold(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[çğıöşüâîû]/g, (ch) => TR_FOLD[ch] || ch);
}

function tokenize(q) {
  return (fold(q).match(/[a-z0-9_+#.]+/g) || []).filter((w) => w.length >= 3);
}

function entries() {
  return read('MEMORY.md')
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

function scoreEntry(entryText, qTokens) {
  if (!qTokens.length) return 0;
  const hay = fold(entryText);
  let hits = 0;
  for (const t of new Set(qTokens)) {
    if (hay.includes(t)) hits++;
  }
  return hits / Math.sqrt(qTokens.length);
}

/* Sorguyla ilgili en güçlü N kayıt + en son eklenen M kayıt (sıra korunur). */
function relevantFor(query, { maxRelevant = 6, maxRecent = 4, charCap = 2400 } = {}) {
  const list = entries();
  if (!list.length) return '';
  const qTokens = tokenize(query);
  const picked = new Set();
  if (qTokens.length) {
    const scored = list
      .map((text, i) => ({ i, text, score: scoreEntry(text, qTokens) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxRelevant);
    for (const r of scored) picked.add(r.i);
  }
  for (let i = list.length - 1; i >= 0 && picked.size < maxRelevant + maxRecent; i--) {
    picked.add(i);
  }
  let out = '';
  for (const i of [...picked].sort((a, b) => a - b)) {
    const line = '- ' + list[i];
    if (out.length + line.length > charCap) break;
    out += (out ? '\n' : '') + line;
  }
  return out;
}

function search(query, limit = 8) {
  const list = entries();
  const qTokens = tokenize(query);
  if (!list.length) return [];
  let rows;
  if (!qTokens.length) {
    rows = list.map((text, i) => ({ text, score: 0, i })).slice(-limit).reverse();
  } else {
    rows = list
      .map((text, i) => ({ text, score: Number(scoreEntry(text, qTokens).toFixed(3)), i }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  return rows.map(({ text, score }) => ({ score, text }));
}

/* ---------- kalıcı kurallar (#3 düzeltme hattı) ----------
   Kullanıcının agent'a söylediği "artık hep böyle yap" maddeleri.
   MEMORY.md'yi şişirmeden ayrı dosyada durur, her prompta girer. */

function rulesFile() {
  return path.join(beastRoot(), 'rules.md');
}

function listRules() {
  try {
    return fs
      .readFileSync(rulesFile(), 'utf8')
      .split('\n')
      .map((l) => l.replace(/^-\s*/, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function addRule(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!t) return { ok: false, error: 'kural metni boş' };
  if (listRules().some((r) => r.toLowerCase() === t.toLowerCase())) {
    return { ok: true, duplicate: true };
  }
  try {
    fs.mkdirSync(beastRoot(), { recursive: true });
    fs.appendFileSync(rulesFile(), '- ' + t + '\n');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function removeRule(textOrIndex) {
  const rules = listRules();
  let idx = -1;
  if (/^\d+$/.test(String(textOrIndex))) idx = Number(textOrIndex) - 1;
  else idx = rules.findIndex((r) => r.toLowerCase() === String(textOrIndex).trim().toLowerCase());
  if (idx < 0 || idx >= rules.length) return { ok: false, error: 'kural bulunamadı' };
  rules.splice(idx, 1);
  try {
    fs.writeFileSync(rulesFile(), rules.map((r) => '- ' + r).join('\n') + (rules.length ? '\n' : ''));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- bellek hijyeni (#5) ----------
   MEMORY.md: dedup + eskime; periyodik çağrıyla şişme engellenir. */

const MEMORY_CAP = 400; // maksimum kayıt sayısı
const MEMORY_MAX_AGE_DAYS = 120; // hiç skor üretmeyen kayıtların ömrü

/** Duplike + çok eski kayıtları temizler; silinen sayısını döner */
function hygiene({ maxAgeDays = MEMORY_MAX_AGE_DAYS, cap = MEMORY_CAP } = {}) {
  const list = entries();
  if (!list.length) return { ok: true, removed: 0, reason: 'boş' };
  const seen = new Set();
  const kept = [];
  let dupes = 0;
  for (const l of list) {
    const key = fold(l).replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key)) {
      dupes++;
      continue;
    }
    seen.add(key);
    kept.push(l);
  }
  let aged = 0;
  if (kept.length > cap || maxAgeDays > 0) {
    /* tarih etiketli olmayanlar en eski kabul edilir (append-only başlangıç) */
    const cut = Date.now() - maxAgeDays * 86400000;
    const filtered = [];
    /* kronolojik varsayım: dosya sırası = ekleme sırası */
    const overflow = Math.max(0, kept.length - cap);
    kept.forEach((l, idx) => {
      const m = l.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      const tooOld = m && new Date(m[1]).getTime() < cut;
      if (tooOld && idx < kept.length - 20) { // son 20 kayıt asla yaşla silinmez
        aged++;
        return;
      }
      if (overflow > 0 && idx < overflow) {
        // kap aşımı: en eskilerden düş ama yine de son 20 korunur
        if (idx < kept.length - 20) {
          aged++;
          return;
        }
      }
      filtered.push(l);
    });
    return writeKept(filtered, dupes + aged);
  }
  return writeKept(kept, dupes);
}

function writeKept(kept, removedCount) {
  try {
    fs.writeFileSync(
      path.join(memDir(), 'MEMORY.md'),
      kept.map((l) => '- ' + l).join('\n') + (kept.length ? '\n' : '')
    );
    return { ok: true, removed: removedCount, remaining: kept.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------- #12 kişilik kalibrasyonu ----------
   Kullanıcının konuşma tarzından üslup imzası çıkarır, SOUL.md'ye ekler.
   İlk hafta mesajlar birikince "dijital ikiz" ton yakalanır. */

function personaFile() {
  return path.join(memDir(), 'persona.json');
}

function loadPersona() {
  try {
    return JSON.parse(fs.readFileSync(personaFile(), 'utf8'));
  } catch {
    return { samples: [], calibrated: false };
  }
}

function savePersona(p) {
  try {
    fs.mkdirSync(memDir(), { recursive: true });
    fs.writeFileSync(personaFile(), JSON.stringify(p, null, 2));
  } catch {}
}

/** Kullanıcı mesajı → üslup örnek havuzuna ekle (max 40) */
function addStyleSample(text) {
  const t = String(text || '').trim();
  if (t.length < 8 || t.length > 300) return; // çok kısa/uzun örnek değmez
  if (/^(\/|http)/.test(t)) return; // komut/link değil
  const p = loadPersona();
  if (p.samples.some((s) => s.toLowerCase() === t.toLowerCase())) return;
  p.samples.push(t);
  if (p.samples.length > 40) p.samples = p.samples.slice(-40);
  savePersona(p);
}

const STYLE_HINTS = [
  ['emoji', /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u],
  ['kısa cümle', /^(.{1,60}(\.|$)){1,2}/],
  ['türkçe kısaltma', /\b(tmm|tamam|tamamsa|olur|olmz|yok|bşka|hemen|acele|asap)\b/i],
  ['seslenme', /\b(kanka|abi|abey|hocam|kanka)\b/i],
  ['üzgün ünlem', /!{1,}$/m],
  ['soru ağırlıklı', /\?/],
];

function analyzeStyle(samples) {
  const counts = {};
  for (const [, re] of STYLE_HINTS) {
    for (const s of samples) if (re.test(s)) counts[re.source] = (counts[re.source] || 0) + 1;
  }
  // basit: hangi hintler %35+ örnekte görünüyor
  const n = Math.max(1, samples.length);
  return STYLE_HINTS.filter(([, re]) => (counts[re.source] || 0) / n >= 0.35).map(([name]) => name);
}

/** Yeterli örnek biriktiyse SOUL.md'ye üslup paragrafı yaz/revize et */
function calibratePersona() {
  const p = loadPersona();
  if (p.samples.length < 20) return { ok: false, reason: 'yetersiz örnek', have: p.samples.length, need: 20 };
  const traits = analyzeStyle(p.samples);
  const style =
    '# KULLANICI ÜSLUBU (sohbetlerinden kalibre edildi — bu tonda konuş)\n' +
    (traits.length
      ? '- Gözlemlenen özellikler: ' + traits.join(', ') + '\n'
      : '- Nötr ve ölçülü bir üslup\n') +
    '- Örnek kullanıcı cümleleri:\n' +
    p.samples.slice(-6).map((s) => '  • "' + s.slice(0, 90) + '"').join('\n');
  try {
    const soulPath = path.join(memDir(), 'SOUL.md');
    let soul = fs.readFileSync(soulPath, 'utf8');
    soul = soul.replace(/# KULLANICI ÜSLUBU[\s\S]*?(?=\n# |\n*$)/g, '').trimEnd();
    fs.writeFileSync(soulPath, soul + '\n\n' + style + '\n');
    p.calibrated = true;
    p.calibratedAt = new Date().toISOString();
    savePersona(p);
    return { ok: true, traits };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  beastRoot,
  memDir,
  loadAll,
  append,
  appendUser,
  save,
  entries,
  relevantFor,
  search,
  tokenize,
  scoreEntry,
  listRules,
  addRule,
  removeRule,
  hygiene,
  addStyleSample,
  calibratePersona,
};
