'use strict';

/* Beast cron: zamanlanmış görevler (%APPDATA%\beast\cron.json).
   5 alanlı cron ifadeleri: dakika saat ayGunu ay haftaGunu
   Desteklenen sözdizimi: * , - / sayılar.  Saat geldiğinde onFire tetiklenir. */

const fs = require('fs');
const path = require('path');
const { beastRoot } = require('./agent/memory');

function file() {
  return path.join(beastRoot(), 'cron.json');
}

let jobs = [];
let timer = null;
let onFire = null;

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    jobs = Array.isArray(raw.jobs) ? raw.jobs : [];
  } catch {
    jobs = [];
  }
}

function save() {
  try {
    fs.mkdirSync(beastRoot(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ jobs }, null, 2));
  } catch {}
}

/* ---------- cron ayrıştırıcı ---------- */

function parseField(field, min, max) {
  const allowed = new Set();
  for (const partRaw of String(field).split(',')) {
    const part = partRaw.trim();
    if (!part) return null;
    const [rangeRaw, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo = min;
    let hi = max;
    if (rangeRaw !== '*') {
      const m = rangeRaw.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) return null;
      lo = Number(m[1]);
      hi = m[2] === undefined ? lo : Number(m[2]);
      if (lo < min || hi > max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return allowed;
}

/* {min,h,dow,mon} alan eşleşmesini Date üzerinde kontrol eder */
function cronMatches(fields, d) {
  return (
    fields.min.has(d.getMinutes()) &&
    fields.hour.has(d.getHours()) &&
    fields.dom.has(d.getDate()) &&
    fields.mon.has(d.getMonth() + 1) &&
    (fields.dow.has(d.getDay()) || (fields.dow.has(7) && d.getDay() === 0))
  );
}

function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = {
    min: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    mon: parseField(parts[3], 1, 12),
    dow: parseField(parts[4], 0, 7),
  };
  if (Object.values(fields).some((f) => !f)) return null;
  return fields;
}

/* Verilen zamandan sonraki ilk uyarın anı (ms) — en fazla 400 gün tarar */
function nextRunFrom(expr, fromDate) {
  const fields = parseCron(expr);
  if (!fields) return null;
  const d = new Date(fromDate.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 400 * 24 * 60; i++) {
    if (cronMatches(fields, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

function isValidSchedule(expr) {
  return nextRunFrom(expr, new Date()) !== null;
}

/* Tekrarlı hatırlatma ("her sabah 09:00" tarzı): when'in saat/dakikası +
   repeat frekansından 5 alanlı cron üretir. repeat için presetler YA DA
   doğrudan geçerli bir cron ifadesi kabul edilir. Saf fonksiyon. */
function reminderSchedule(when, repeat) {
  const r = String(repeat || '').trim().toLowerCase();
  if (!r) return { ok: false, error: 'repeat gerekli: daily/weekly/monthly/weekdays veya 5 alanlı cron' };
  /* doğrudan cron verilmişse (5 boşlukla ayrılmış alan) aynen doğrula */
  if (/^(\S+\s+){4}\S+$/.test(r)) {
    if (isValidSchedule(r)) return { ok: true, schedule: r };
    return { ok: false, error: 'geçersiz cron ifadesi (örn: */15 * * * *)' };
  }
  const d = new Date(String(when || '').trim());
  if (isNaN(d.getTime())) return { ok: false, error: 'tekrarlı hatırlatma için geçerli when (saat bilgisiyle) gerekli' };
  const map = {
    daily: `${d.getMinutes()} ${d.getHours()} * * *`,
    weekdays: `${d.getMinutes()} ${d.getHours()} * * 1-5`,
    weekly: `${d.getMinutes()} ${d.getHours()} * * ${d.getDay()}`,
    monthly: `${d.getMinutes()} ${d.getHours()} ${d.getDate()} * *`,
  };
  const schedule = map[r];
  if (!schedule) {
    return { ok: false, error: 'bilinmeyen repeat — daily/weekly/monthly/weekdays kullan ya da 5 alanlı cron ver' };
  }
  if (!isValidSchedule(schedule)) return { ok: false, error: 'oluşan takvim hiç tetiklenmiyor — when/repeat uyumsuz' };
  return { ok: true, schedule };
}

/* ---------- CRUD ---------- */

function list() {
  return jobs.map((j) => ({ ...j }));
}

function add({ name, schedule, prompt, once, sessionId }) {
  const n = String(name || '').trim().slice(0, 80) || 'Görev';
  const s = String(schedule || '').trim();
  const p = String(prompt || '').trim().slice(0, 4000);
  if (!isValidSchedule(s)) return { ok: false, error: 'geçersiz cron ifadesi (örn: */15 * * * *)' };
  if (!p) return { ok: false, error: 'görev metni boş olamaz' };
  const job = {
    id: uid(),
    name: n,
    schedule: s,
    prompt: p,
    sessionId: sessionId || null,
    once: !!once,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    nextRunAt: nextRunFrom(s, new Date()),
  };
  jobs.push(job);
  save();
  return { ok: true, job: { ...job } };
}

function update(id, patch) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return { ok: false, error: 'görev bulunamadı' };
  if (patch.sessionId !== undefined) job.sessionId = patch.sessionId;
  if (patch.name !== undefined) job.name = String(patch.name).trim().slice(0, 80) || job.name;
  if (patch.prompt !== undefined) {
    const p = String(patch.prompt).trim().slice(0, 4000);
    if (!p) return { ok: false, error: 'görev metni boş olamaz' };
    job.prompt = p;
  }
  if (patch.schedule !== undefined) {
    const s = String(patch.schedule).trim();
    if (!isValidSchedule(s)) return { ok: false, error: 'geçersiz cron ifadesi' };
    job.schedule = s;
    job.nextRunAt = nextRunFrom(s, new Date());
  }
  save();
  return { ok: true, job: { ...job } };
}

function remove(id) {
  const before = jobs.length;
  jobs = jobs.filter((j) => j.id !== id);
  save();
  return { ok: jobs.length < before };
}

function toggle(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return { ok: false, error: 'görev bulunamadı' };
  job.enabled = !job.enabled;
  job.nextRunAt = job.enabled ? nextRunFrom(job.schedule, new Date()) : null;
  save();
  return { ok: true, job: { ...job } };
}

function runNow(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return { ok: false, error: 'görev bulunamadı' };
  fire(job);
  return { ok: true };
}

/* ---------- zamanlayıcı ---------- */

function fire(job) {
  job.lastRunAt = new Date().toISOString();
  if (!job.once) job.nextRunAt = nextRunFrom(job.schedule, new Date());
  if (job.once) {
    // tek seferlik (hatırlatma): uyarınca kendini sil
    jobs = jobs.filter((j) => j.id !== job.id);
  }
  save();
  if (onFire) onFire({ ...job });
}

function tick() {
  const now = Date.now();
  for (const job of jobs.slice()) {
    if (!job.enabled || !job.nextRunAt) continue;
    if (new Date(job.nextRunAt).getTime() <= now) fire(job);
  }
}

function init(hooks) {
  onFire = (hooks && hooks.onFire) || null;
  load();
  for (const job of jobs) {
    if (job.enabled && (!job.nextRunAt || new Date(job.nextRunAt).getTime() <= Date.now())) {
      job.nextRunAt = nextRunFrom(job.schedule, new Date());
    }
  }
  save();
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 20 * 1000);
}

/* /stop: zamanlayıcıyı durdur (init ile geri başlar) */
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { init, stop, list, add, update, remove, toggle, runNow, parseCron, nextRunFrom, isValidSchedule, reminderSchedule };
