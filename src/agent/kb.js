'use strict';

/* Beast knowledge store (#3 derin öğrenme katmanı)
   sqlite-vec yerine sıfır bağımlılık: JSON deposu + TF-IDF benzerlik.
   Kayıtlar kaynak taşır → kb_search sonucu citation'lı döner.

   Depo: %APPDATA%\beast\knowledge.json
   { items: [{ id, title, source, tags[], text, createdAt }] }  */

const fs = require('fs');
const path = require('path');
const { beastRoot } = require('./memory');

function file() {
  return path.join(beastRoot(), 'knowledge.json');
}

let items = null;

function load() {
  if (items) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    items = Array.isArray(raw.items) ? raw.items : [];
  } catch {
    items = [];
  }
}

function save() {
  try {
    fs.mkdirSync(beastRoot(), { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2));
    fs.renameSync(tmp, file());
  } catch {}
}

const KB_CAP = 2000;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* memory.js ile aynı Türkçe duyarsız tokenleştirme */
const TR_FOLD = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
function fold(s) {
  return String(s || '').toLowerCase().replace(/[çğıöşüâîû]/g, (ch) => TR_FOLD[ch] || ch);
}
function tokenize(q) {
  return (fold(q).match(/[a-z0-9_+#.]+/g) || []).filter((w) => w.length >= 3);
}

/** add(title, text, {source, tags}) → { ok, id } */
function add(title, text, meta = {}) {
  load();
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: 'metin boş' };
  if (items.length >= KB_CAP) items.splice(0, items.length - KB_CAP + 1); // en eskiyi düşür
  const it = {
    id: uid(),
    title: String(title || '').trim().slice(0, 120) || t.slice(0, 60),
    source: String(meta.source || '').trim().slice(0, 300) || 'agent',
    tags: Array.isArray(meta.tags) ? meta.tags.map((x) => String(x).slice(0, 40)).slice(0, 8) : [],
    text: t.slice(0, 20000),
    createdAt: new Date().toISOString(),
  };
  items.push(it);
  save();
  return { ok: true, id: it.id };
}

function get(id) {
  load();
  return items.find((x) => x.id === id) ? { ...items.find((x) => x.id === id) } : null;
}

function count() {
  load();
  return items.length;
}

/** TF-IDF benzerlik araması; sonuçlar citation alanıyla döner */
function search(query, limit = 5) {
  load();
  const qTokens = tokenize(query);
  if (!qTokens.length || !items.length) return [];
  const N = items.length;
  const docs = items.map((it) => tokenize(it.title + ' ' + it.text));
  /* df */
  const df = new Map();
  for (const toks of docs) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  const scored = [];
  for (let i = 0; i < N; i++) {
    const toks = docs[i];
    if (!toks.length) continue;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of qTokens) {
      const f = tf.get(q) || 0;
      if (!f) continue;
      const idf = Math.log(1 + N / (1 + (df.get(q) || 0)));
      score += (f / toks.length) * idf;
    }
    /* tag/başlık eşleşmesine bonus */
    const hayT = fold(items[i].title + ' ' + (items[i].tags || []).join(' '));
    for (const q of qTokens) if (hayT.includes(q)) score += 0.35;
    if (score > 0) scored.push({ i, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(limit, 10))).map(({ i, score }) => ({
    id: items[i].id,
    title: items[i].title,
    snippet: items[i].text.slice(0, 400),
    score: Number(score.toFixed(3)),
    citation: `[${items[i].title}] (${items[i].source}, ${String(items[i].createdAt).slice(0, 10)})`,
  }));
}

module.exports = { add, get, search, count, tokenize };
