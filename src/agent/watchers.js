'use strict';

/* Beast izleyiciler (watchers): arka planda periyodik kontrol.
   kind=web   → URL periyodik çekilir, değer çıkarılır (json path / regex), koşul karşılaştırılır
   kind=battery → yerel pil yüzdesi izlenir
   Koşul sağlanınca ilgili oturuma mesaj düşer (WA köprüsüne de otomatik akar).
   Depo: %APPDATA%\beast\watchers.json */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { beastRoot } = require('./memory');

function file() {
  return path.join(beastRoot(), 'watchers.json');
}

let items = [];

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    items = Array.isArray(raw.watchers) ? raw.watchers : [];
  } catch {
    items = [];
  }
}

function save() {
  try {
    fs.mkdirSync(beastRoot(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ watchers: items }, null, 2));
  } catch {}
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const OPS = ['lt', 'lte', 'gt', 'gte', 'eq', 'neq', 'changed'];

/* Girdiyi doğrula/normalleştir — saf fonksiyon */
function normalize(input) {
  const i = input || {};
  const name = String(i.name || '').trim().slice(0, 80);
  const kind = String(i.kind || '').trim().toLowerCase();
  if (!name) return { error: 'isim gerekli' };
  if (kind !== 'web' && kind !== 'battery') return { error: "kind 'web' ya da 'battery' olmalı" };
  let url = '';
  if (kind === 'web') {
    url = String(i.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return { error: 'web izleyicisi için geçerli http(s) url gerekli' };
    if (url.length > 2000) return { error: 'url çok uzun' };
  }
  const op = OPS.includes(String(i.op || '').toLowerCase()) ? String(i.op).toLowerCase() : 'lte';
  const value = i.value === undefined || i.value === null || i.value === '' ? null : i.value;
  if (op !== 'changed' && value === null) return { error: 'bu op için value (eşik) gerekli' };
  let re = '';
  if (i.re !== undefined && i.re !== null && String(i.re).trim() !== '') {
    try {
      new RegExp(String(i.re));
      re = String(i.re);
    } catch {
      return { error: 'geçersiz regex (re)' };
    }
  }
  /* #22 aralık: saniye (10-3600) YA DA dakika (1-1440). everySec verilirse o esas. */
  let everySec = 0;
  const rawSec = Number(i.everySec ?? i.every_sec);
  const rawMin = Number(i.everyMin ?? i.every_min ?? 15);
  if (Number.isFinite(rawSec) && rawSec > 0) {
    everySec = Math.min(Math.max(Math.round(rawSec), 10), 86400);
  } else {
    const everyMin = Math.min(Math.max(Math.round(rawMin) || 15, 1), 1440);
    everySec = everyMin * 60;
  }
  /* 0 geçerlidir (cooldown yok); sadece sayılamayan değerler varsayılana döner */
  const cdRaw = Number(i.cooldownMin ?? i.cooldown_min ?? 60);
  const cooldownMin = Number.isFinite(cdRaw) ? Math.min(Math.max(Math.round(cdRaw), 0), 10080) : 60;
  const prompt = String(i.prompt || '').trim().slice(0, 2000);
  const jpath = String(i.path || '').trim().slice(0, 300);
  return {
    watcher: {
      id: uid(),
      name,
      kind,
      url,
      path: jpath,
      re,
      op,
      value,
      everyMin: Math.max(1, Math.round(everySec / 60)), // geriye dönük uyum
      everySec,
      cooldownMin,
      prompt,
      sessionId: i.sessionId || null,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastCheckAt: null,
      lastValue: null,
      lastTriggeredAt: null,
      lastError: '',
      armed: true,
    },
  };
}

/* Koşul karşılaştırması — sayısal op'lar Number'a zorlar, dönemezse false */
function compare(op, current, target) {
  if (op === 'changed') return String(current ?? '') !== String(target ?? '');
  const c = Number(current);
  const t = Number(target);
  if (!Number.isFinite(c) || !Number.isFinite(t)) return false;
  switch (op) {
    case 'lt': return c < t;
    case 'lte': return c <= t;
    case 'gt': return c > t;
    case 'gte': return c >= t;
    case 'eq': return c === t;
    case 'neq': return c !== t;
    default: return false;
  }
}

/* Tek kontrol uygula — saf: tetik kararı + kaydedilecek yama.
   Kenar-tetiklemeli: koşul doğruyken tek kez ateşlenir, koşul normale
   dönünce yeniden kurulur (armed). */
function applyCheck(w, value, now) {
  const cond = compare(w.op, value, w.value);
  const triggered = cond && w.armed;
  const patch = {
    lastCheckAt: new Date(now).toISOString(),
    lastValue: value === undefined ? null : value,
    armed: !cond,
  };
  if (triggered) patch.lastTriggeredAt = new Date(now).toISOString();
  return { triggered, patch };
}

/* Kontrol zamanı geldi mi — everySec varsa saniye bazlı, yoksa dakika */
function isDue(w, now) {
  if (!w.enabled) return false;
  if (!w.lastCheckAt) return true;
  const ms = w.everySec ? w.everySec * 1000 : (w.everyMin || 15) * 60000;
  return now - new Date(w.lastCheckAt).getTime() >= ms;
}

/* Son bildirimden beri cooldown sürüyor mu */
function cooldownActive(w, now) {
  if (!w.lastTriggeredAt || !w.cooldownMin) return false;
  return now - new Date(w.lastTriggeredAt).getTime() < w.cooldownMin * 60000;
}

/* ---------- CRUD ---------- */

function list() {
  return items.map((w) => ({ ...w }));
}

function get(id) {
  const w = items.find((x) => x.id === id);
  return w ? { ...w } : null;
}

function add(input) {
  const n = normalize(input);
  if (n.error) return { ok: false, error: n.error };
  items.push(n.watcher);
  save();
  return { ok: true, watcher: { ...n.watcher } };
}

function remove(id) {
  const before = items.length;
  items = items.filter((w) => w.id !== id);
  save();
  return { ok: items.length < before };
}

function patch(id, p) {
  const w = items.find((x) => x.id === id);
  if (!w) return false;
  Object.assign(w, p || {});
  save();
  return true;
}

/* ---------- arka plan izleyici ---------- */

let timer = null;
let hooks = {};

/* JSON dot-path ("price.usd", "data.0.close") ya da regex ile değer çıkarımı — saf */
function extractValue(text, w) {
  const body = String(text ?? '');
  if (w.path) {
    let j;
    try {
      j = JSON.parse(body);
    } catch {
      throw new Error('yanıt JSON olmadığı için path uygulanamadı (re kullan)');
    }
    let cur = j;
    for (const part of String(w.path).split('.')) {
      if (cur !== null && cur !== undefined && typeof cur === 'object' && part in cur) cur = cur[part];
      else return null;
    }
    return cur;
  }
  if (w.re) {
    const m = body.match(new RegExp(w.re));
    if (!m) return null;
    return m.length > 1 && m[1] !== undefined ? m[1] : m[0];
  }
  throw new Error('web izleyicisi için path (JSON) veya re (regex) gerekli');
}

async function webValue(w, fetchImpl) {
  const f = fetchImpl || global.fetch;
  const res = await f(w.url, {
    signal: AbortSignal.timeout(20000),
    headers: { 'user-agent': 'BeastAgent/0.1 (+watcher)', accept: '*/*' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return extractValue((await res.text()).slice(0, 2000000), w);
}

/* Windows yerel pil yüzdesi; pil yoksa hata fırlatır */
function batteryLevel() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', '(Get-CimInstance Win32_Battery).EstimatedChargeRemaining'],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        const n = Number((String(stdout).match(/\d+/) || [])[0]);
        if (!Number.isFinite(n)) return reject(new Error('pil bilgisi bulunamadı'));
        resolve(n);
      }
    );
  });
}

async function defaultCheck(w, deps = {}) {
  /* tek noktadan taklit (testler / özel köprüler) */
  if (typeof deps.check === 'function') return deps.check({ ...w });
  if (w.kind === 'battery') return deps.battery ? deps.battery() : batteryLevel();
  return deps.web ? deps.web({ ...w }) : webValue(w, deps.fetch);
}

/* Tek tur kontrol: vakti gelen + cooldown'u bitmiş izleyicileri denetler.
   Kenar-tetiklemeli: tetiklenenler onTrigger(watcherCopy, value) ile bildirilir.
   Testlerde check/web/battery/fetch enjekte edilebilir. */
async function tickOnce(deps = {}) {
  const now = Date.now();
  const events = [];
  for (const w of items.slice()) {
    if (!isDue(w, now) || cooldownActive(w, now)) continue;
    try {
      const value = await defaultCheck(w, deps);
      const r = applyCheck(w, value, now);
      Object.assign(w, r.patch);
      w.lastError = '';
      if (r.triggered) {
        if (typeof hooks.onTrigger === 'function') hooks.onTrigger({ ...w }, value);
        events.push({ id: w.id, name: w.name, value });
      }
    } catch (e) {
      w.lastCheckAt = new Date(now).toISOString();
      w.lastError = String((e && e.message) || e).slice(0, 300);
    }
  }
  save();
  return events;
}

function start(h) {
  hooks = h || hooks;
  load();
  if (timer) return;
  timer = setInterval(() => {
    tickOnce().catch(() => {});
  }, 5 * 1000); // #22 saniyelik aralıklar için ince tick
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function init() {
  load();
}

module.exports = {
  init,
  start,
  stop,
  tickOnce,
  extractValue,
  list,
  get,
  add,
  remove,
  patch,
  normalize,
  compare,
  applyCheck,
  isDue,
  cooldownActive,
};
