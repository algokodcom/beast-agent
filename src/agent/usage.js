'use strict';

/* Beast kullanım sayacı: model çağrılarının token/çağrı/maliyet toplamları.
   Gün bazlı tutulur (%APPDATA%\beast\usage.json), ~70 gün saklanır.
   Maliyet USD: config.yaml providers.price_in / price_out (1M token başına)
   verildiyse hesaplanır; verilmiyorsa 0 kalır (token raporu yine doğru). */

const fs = require('fs');
const path = require('path');
const { beastRoot } = require('./memory');

function file() {
  return path.join(beastRoot(), 'usage.json');
}

let days = []; // [{ date:'YYYY-MM-DD', models:{ 'pid::model': {calls,pin,pout,cread,cwrite,cost} } }]
let loaded = false;

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    days = Array.isArray(raw.days) ? raw.days.slice(-70) : [];
  } catch {
    days = [];
  }
}

function save() {
  try {
    fs.mkdirSync(beastRoot(), { recursive: true });
    const tmp = file() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ days }, null, 2));
    fs.renameSync(tmp, file());
  } catch {}
}

function dayRow(date) {
  let row = days.find((d) => d.date === date);
  if (!row) {
    row = { date, models: {} };
    days.push(row);
    if (days.length > 70) days = days.slice(-70);
  }
  return row;
}

function keyOf(providerId, model) {
  return `${providerId || '?'}::${model || '?'}`;
}

/* Bir çağrının kullanımını işle. meta: {providerId, model, costIn, costOut}
   (1M token fiyatları, opsiyonel). Saf davranış + disk. */
function record({
  providerId,
  model,
  promptTokens = 0,
  completionTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  costIn = null,
  costOut = null,
} = {}) {
  load();
  const pin = Math.max(0, Math.round(Number(promptTokens) || 0));
  const pout = Math.max(0, Math.round(Number(completionTokens) || 0));
  const cread = Math.max(0, Math.round(Number(cacheReadTokens) || 0));
  const cwrite = Math.max(0, Math.round(Number(cacheWriteTokens) || 0));
  if (!pin && !pout && !cread && !cwrite) return;
  const row = dayRow(today());
  const k = keyOf(providerId, model);
  const m =
    row.models[k] ||
    (row.models[k] = { calls: 0, pin: 0, pout: 0, cread: 0, cwrite: 0, cost: 0 });
  /* eski usage.json satırlarında cread/cwrite yok — migration sırasında
     undefined + sayı = NaN olmasın */
  m.calls = (Number(m.calls) || 0) + 1;
  m.pin = (Number(m.pin) || 0) + pin;
  m.pout = (Number(m.pout) || 0) + pout;
  m.cread = (Number(m.cread) || 0) + cread;
  m.cwrite = (Number(m.cwrite) || 0) + cwrite;
  m.cost = Number(m.cost) || 0;
  if (Number.isFinite(costIn) && Number.isFinite(costOut)) {
    m.cost += (pin * costIn + pout * costOut) / 1000000;
  }
  save();
}

function sumRows(rows) {
  const out = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.models || {})) {
      const t = out[k] || (out[k] = { calls: 0, pin: 0, pout: 0, cread: 0, cwrite: 0, cost: 0 });
      t.calls += v.calls || 0;
      t.pin += v.pin || 0;
      t.pout += v.pout || 0;
      t.cread += v.cread || 0;
      t.cwrite += v.cwrite || 0;
      t.cost += v.cost || 0;
    }
  }
  return out;
}

function monthPrefix() {
  return today().slice(0, 7);
}

function report() {
  load();
  const t = today();
  const mp = monthPrefix();
  const todayModels = sumRows(days.filter((d) => d.date === t));
  const monthModels = sumRows(days.filter((d) => String(d.date || '').startsWith(mp)));
  const flatten = (models) =>
    Object.entries(models)
      .map(([k, v]) => ({ model: k, ...v }))
      .sort((a, b) => b.calls - a.calls);
  return {
    today: { date: t, total: totalOf(todayModels), models: flatten(todayModels) },
    month: { prefix: mp, total: totalOf(monthModels), models: flatten(monthModels) },
  };
}

function totalOf(models) {
  let calls = 0, pin = 0, pout = 0, cread = 0, cwrite = 0, cost = 0;
  for (const v of Object.values(models)) {
    calls += v.calls; pin += v.pin; pout += v.pout;
    cread += v.cread || 0; cwrite += v.cwrite || 0;
    cost += v.cost;
  }
  return { calls, pin, pout, cread, cwrite, cost: Math.round(cost * 10000) / 10000 };
}

function reset() {
  days = [];
  save();
}

module.exports = { record, report, reset, sumRows };
