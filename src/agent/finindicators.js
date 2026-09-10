'use strict';

/* Beast Finance — teknik gösterge matematiği (saf JS, bağımlılıksız).
   mt5_rates'in döndürdüğü OHLC dizilerinden EMA/SMA/RSI/ATR/MACD/BB/Stoch
   hesaplar. UI veya köprü gerektirmez; birim testleri doğrudan bu modülü çağırır. */

function nums(arr) {
  return (Array.isArray(arr) ? arr : []).map((v) => {
    const n = Number(v);
    return isFinite(n) ? n : NaN;
  });
}

function smaSeries(values, period) {
  const v = nums(values);
  const out = new Array(v.length).fill(null);
  const p = Math.max(1, Math.round(Number(period) || 1));
  if (v.length < p) return out;
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i];
    if (i >= p) sum -= v[i - p];
    if (i >= p - 1) out[i] = sum / p;
  }
  return out;
}

function emaSeries(values, period) {
  const v = nums(values);
  const out = new Array(v.length).fill(null);
  const p = Math.max(1, Math.round(Number(period) || 1));
  if (v.length < p) return out;
  const k = 2 / (p + 1);
  let sum = 0;
  for (let i = 0; i < p; i++) sum += v[i];
  let prev = sum / p;
  out[p - 1] = prev;
  for (let i = p; i < v.length; i++) {
    prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/* Wilder RSI — ilk ortalama SMA, sonrası Wilder yumuşatması */
function rsiSeries(closes, period) {
  const c = nums(closes);
  const p = Math.max(2, Math.round(Number(period) || 14));
  const out = new Array(c.length).fill(null);
  if (c.length <= p) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = c[i] - c[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / p;
  let avgLoss = loss / p;
  out[p] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (p - 1) + g) / p;
    avgLoss = (avgLoss * (p - 1) + l) / p;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function trueRanges(highs, lows, closes) {
  const h = nums(highs);
  const l = nums(lows);
  const c = nums(closes);
  const out = new Array(c.length).fill(NaN);
  for (let i = 0; i < c.length; i++) {
    const prev = i > 0 ? c[i - 1] : c[i];
    out[i] = Math.max(h[i] - l[i], Math.abs(h[i] - prev), Math.abs(l[i] - prev));
  }
  return out;
}

/* Wilder ATR */
function atrSeries(highs, lows, closes, period) {
  const tr = trueRanges(highs, lows, closes);
  const p = Math.max(1, Math.round(Number(period) || 14));
  const out = new Array(tr.length).fill(null);
  if (tr.length < p) return out;
  let sum = 0;
  for (let i = 0; i < p; i++) sum += tr[i];
  let prev = sum / p;
  out[p - 1] = prev;
  for (let i = p; i < tr.length; i++) {
    prev = (prev * (p - 1) + tr[i]) / p;
    out[i] = prev;
  }
  return out;
}

function macdSeries(closes, fast, slow, signalPeriod) {
  const f = Math.max(1, Math.round(Number(fast) || 12));
  const s = Math.max(2, Math.round(Number(slow) || 26));
  const sig = Math.max(1, Math.round(Number(signalPeriod) || 9));
  const emaFast = emaSeries(closes, f);
  const emaSlow = emaSeries(closes, s);
  const macd = emaFast.map((v, i) => (v == null || emaSlow[i] == null ? null : v - emaSlow[i]));
  const start = macd.findIndex((v) => v != null);
  const compact = start >= 0 ? macd.slice(start) : [];
  const signalCompact = emaSeries(compact, sig);
  const signal = new Array(macd.length).fill(null);
  if (start >= 0) {
    for (let i = 0; i < signalCompact.length; i++) signal[start + i] = signalCompact[i];
  }
  const hist = macd.map((v, i) => (v == null || signal[i] == null ? null : v - signal[i]));
  return { macd, signal, hist };
}

function bollingerSeries(closes, period, mult) {
  const c = nums(closes);
  const p = Math.max(2, Math.round(Number(period) || 20));
  const m = Number(mult) > 0 ? Number(mult) : 2;
  const mid = smaSeries(c, p);
  const upper = new Array(c.length).fill(null);
  const lower = new Array(c.length).fill(null);
  for (let i = p - 1; i < c.length; i++) {
    let sum = 0;
    for (let j = i - p + 1; j <= i; j++) sum += Math.pow(c[j] - mid[i], 2);
    const sd = Math.sqrt(sum / p);
    upper[i] = mid[i] + m * sd;
    lower[i] = mid[i] - m * sd;
  }
  return { mid, upper, lower };
}

function stochSeries(highs, lows, closes, kPeriod, kSmooth, dPeriod) {
  const h = nums(highs);
  const l = nums(lows);
  const c = nums(closes);
  const kp = Math.max(1, Math.round(Number(kPeriod) || 14));
  const ks = Math.max(1, Math.round(Number(kSmooth) || 3));
  const dp = Math.max(1, Math.round(Number(dPeriod) || 3));
  const raw = new Array(c.length).fill(null);
  for (let i = kp - 1; i < c.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kp + 1; j <= i; j++) {
      if (h[j] > hh) hh = h[j];
      if (l[j] < ll) ll = l[j];
    }
    raw[i] = hh === ll ? 50 : ((c[i] - ll) / (hh - ll)) * 100;
  }
  const k = smaSeries(raw, ks);
  const d = smaSeries(k, dp);
  return { k, d };
}

/* "EMA(50)" | "ema50" | "RSI(14)" | "ATR(14)" | "MACD(12,26,9)" |
   "BB(20,2)" | "SMA(200)" | "STOCH(14,3,3)" → {type, params} */
function parseSpec(spec) {
  const s = String(spec || '').trim().toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z]+)\(?([0-9,.\s]*)\)?$/.exec(s);
  if (!m) return null;
  const type = m[1];
  const params = (m[2] ? m[2].split(',').map((x) => Number(x)) : []).filter((x) => isFinite(x));
  if (!['EMA', 'SMA', 'RSI', 'ATR', 'MACD', 'BB', 'STOCH'].includes(type)) return null;
  return { type, params };
}

function lastN(series, n) {
  const v = (Array.isArray(series) ? series : []).filter((x) => x != null);
  const size = Math.max(1, Math.min(20, Number(n) || 1));
  return v.slice(-size).map((x) => Math.round(x * 1e6) / 1e6);
}

/* Ham seriyi hesaplar; dönen değerler tam uzunlukta (warmup null). */
function seriesFor(spec, rates) {
  const closes = rates.map((r) => Number(r.close));
  const highs = rates.map((r) => Number(r.high));
  const lows = rates.map((r) => Number(r.low));
  const p = spec.params;
  switch (spec.type) {
    case 'EMA':
      return { name: 'EMA', params: [p[0] || 20], series: emaSeries(closes, p[0] || 20) };
    case 'SMA':
      return { name: 'SMA', params: [p[0] || 20], series: smaSeries(closes, p[0] || 20) };
    case 'RSI':
      return { name: 'RSI', params: [p[0] || 14], series: rsiSeries(closes, p[0] || 14) };
    case 'ATR':
      return { name: 'ATR', params: [p[0] || 14], series: atrSeries(highs, lows, closes, p[0] || 14) };
    case 'MACD': {
      const r = macdSeries(closes, p[0] || 12, p[1] || 26, p[2] || 9);
      return { name: 'MACD', params: [p[0] || 12, p[1] || 26, p[2] || 9], series: r.macd, extra: { signal: r.signal, hist: r.hist } };
    }
    case 'BB': {
      const r = bollingerSeries(closes, p[0] || 20, p[1] || 2);
      return { name: 'BB', params: [p[0] || 20, p[1] || 2], series: r.mid, extra: { upper: r.upper, lower: r.lower } };
    }
    case 'STOCH': {
      const r = stochSeries(highs, lows, closes, p[0] || 14, p[1] || 3, p[2] || 3);
      return { name: 'STOCH', params: [p[0] || 14, p[1] || 3, p[2] || 3], series: r.k, extra: { d: r.d } };
    }
    default:
      return null;
  }
}

const DEFAULT_SPECS = ['EMA(20)', 'EMA(50)', 'RSI(14)', 'ATR(14)', 'MACD(12,26,9)'];

/* rates: [{time, open, high, low, close, ...}] → ajan dostu özet.
   Her gösterge için son 3 değer + (varsa) ek seriler. */
function compute(rates, specs) {
  const rows = Array.isArray(rates) ? rates : [];
  const list = (Array.isArray(specs) && specs.length ? specs : DEFAULT_SPECS)
    .map((s) => (typeof s === 'string' ? parseSpec(s) : s))
    .filter(Boolean)
    .slice(0, 12);
  const close = rows.length ? Number(rows[rows.length - 1].close) : null;
  const out = { bars: rows.length, close, indicators: {} };
  for (const spec of list) {
    const r = seriesFor(spec, rows);
    if (!r) continue;
    const key = r.name + '(' + r.params.join(',') + ')';
    const entry = { last: lastN(r.series, 3) };
    if (r.extra) {
      entry.extra = {};
      for (const [k, v] of Object.entries(r.extra)) entry.extra[k] = lastN(v, 3);
    }
    out.indicators[key] = entry;
  }
  const highs = rows.map((x) => Number(x.high));
  const lows = rows.map((x) => Number(x.low));
  if (highs.length) {
    const window = Math.min(20, rows.length);
    out.range20 = {
      high: Math.max(...highs.slice(-window)),
      low: Math.min(...lows.slice(-window)),
    };
  }
  return out;
}

module.exports = {
  parseSpec,
  compute,
  smaSeries,
  emaSeries,
  rsiSeries,
  atrSeries,
  macdSeries,
  bollingerSeries,
  stochSeries,
  DEFAULT_SPECS,
};
