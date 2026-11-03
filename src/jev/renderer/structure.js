/*
 * JEV — H1 Range İçi yapı motoru
 * --------------------------------
 * Deterministik, saf JS (UMD). LLM yorumu yok; yalnız kapanmış mumlardan
 * H1 kırılım/sıkışma bağlamını ve M5 giriş tetiğini üretir.
 *
 * Bu modül emir AÇMAZ. Yalnız öneri + çizim verisi üretir.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JEVStructure = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  const DEFAULTS = Object.freeze({
    h1AtrPeriod: 14,
    m5AtrPeriod: 14,
    minBoxBars: 4,
    maxBoxBars: 24,
    minBoxHeightAtr: 0.35,
    maxBoxHeightAtr: 1.5,
    touchTolAtr: 0.18,
    minTouches: 2,
    breakoutLookback: 12,
    breakoutMaxAgeBars: 3,
    breakoutBodyRatio: 0.55,
    breakoutBodyAtr: 1.2,
    breakoutClosePos: 0.75,
    minRR: 1.5,
    minGradeScore: 62,
    aPlusScore: 82,
    maxRiskAtrM5: 3.5,
    maxTriggerAgeBars: 3,
    setupTtlBarsM5: 24,
  });

  function num(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function normalizeOpts(o) {
    const src = o && typeof o === 'object' ? o : {};
    const d = DEFAULTS;
    const out = {
      h1AtrPeriod: Math.round(clamp(num(src.h1AtrPeriod, d.h1AtrPeriod), 5, 60)),
      m5AtrPeriod: Math.round(clamp(num(src.m5AtrPeriod, d.m5AtrPeriod), 5, 60)),
      minBoxBars: Math.round(clamp(num(src.minBoxBars, d.minBoxBars), 3, 12)),
      maxBoxBars: Math.round(clamp(num(src.maxBoxBars, d.maxBoxBars), 6, 60)),
      minBoxHeightAtr: clamp(num(src.minBoxHeightAtr, d.minBoxHeightAtr), 0.05, 3),
      maxBoxHeightAtr: clamp(num(src.maxBoxHeightAtr, d.maxBoxHeightAtr), 0.3, 4),
      touchTolAtr: clamp(num(src.touchTolAtr, d.touchTolAtr), 0.05, 0.5),
      minTouches: Math.round(clamp(num(src.minTouches, d.minTouches), 1, 6)),
      breakoutLookback: Math.round(clamp(num(src.breakoutLookback, d.breakoutLookback), 4, 30)),
      breakoutMaxAgeBars: Math.round(clamp(num(src.breakoutMaxAgeBars, d.breakoutMaxAgeBars), 0, 10)),
      breakoutBodyRatio: clamp(num(src.breakoutBodyRatio, d.breakoutBodyRatio), 0.3, 1),
      breakoutBodyAtr: clamp(num(src.breakoutBodyAtr, d.breakoutBodyAtr), 0.5, 4),
      breakoutClosePos: clamp(num(src.breakoutClosePos, d.breakoutClosePos), 0.5, 0.98),
      minRR: clamp(num(src.minRR, d.minRR), 1, 5),
      minGradeScore: clamp(num(src.minGradeScore, d.minGradeScore), 0, 100),
      aPlusScore: clamp(num(src.aPlusScore, d.aPlusScore), 0, 100),
      maxRiskAtrM5: clamp(num(src.maxRiskAtrM5, d.maxRiskAtrM5), 0.5, 8),
      maxTriggerAgeBars: Math.round(clamp(num(src.maxTriggerAgeBars, d.maxTriggerAgeBars), 0, 12)),
      setupTtlBarsM5: Math.round(clamp(num(src.setupTtlBarsM5, d.setupTtlBarsM5), 3, 200)),
      point: Math.max(0, num(src.point, 0)),
    };
    if (out.maxBoxBars < out.minBoxBars) out.maxBoxBars = out.minBoxBars;
    if (out.aPlusScore < out.minGradeScore) out.aPlusScore = out.minGradeScore;
    return out;
  }

  function cleanBars(bars) {
    const out = [];
    const seen = new Map();
    for (const raw of Array.isArray(bars) ? bars : []) {
      if (!raw || typeof raw !== 'object') continue;
      const time = Number(raw.time);
      const open = Number(raw.open);
      const high = Number(raw.high);
      const low = Number(raw.low);
      const close = Number(raw.close);
      if (![time, open, high, low, close].every(Number.isFinite)) continue;
      if (!(time > 0) || !(high > 0) || !(low > 0) || !(close > 0)) continue;
      if (high < low) continue;
      seen.set(time, { time, open, high, low, close });
    }
    for (const b of seen.values()) out.push(b);
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  /* MT5/Binance son elemanı oluşmakta olan mumdur; karar için onu at. */
  function closedOnly(rates) {
    const a = cleanBars(rates);
    return a.length ? a.slice(0, -1) : a;
  }

  function trueRangeAt(bars, i) {
    const b = bars[i];
    if (!b) return 0;
    const prev = i > 0 ? bars[i - 1] : b;
    const pc = Number(prev.close);
    return Math.max(
      Number(b.high) - Number(b.low),
      Math.abs(Number(b.high) - pc),
      Math.abs(Number(b.low) - pc)
    );
  }

  /* end: kaçıncı elemana kadar (hariç). Varsayılan tüm seri. */
  function atr(bars, period, end) {
    const a = Array.isArray(bars) ? bars : [];
    const n = a.length;
    const last = end == null ? n : Math.min(n, Math.max(1, Math.round(Number(end))));
    const k = Math.min(Math.max(2, Math.round(Number(period) || 14)), last - 1);
    if (!(k > 0)) return 0;
    let sum = 0;
    for (let i = last - k; i < last; i++) sum += trueRangeAt(a, i);
    return sum / k;
  }

  function epsOf(atrVal, point) {
    return Math.max(Number(atrVal) * 0.02, Number(point) * 0.5, 1e-9);
  }

  function fmt(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    const d = a >= 1000 ? 2 : a >= 10 ? 3 : 5;
    return n.toFixed(d);
  }

  function contextId(kind, startTime, endTime, high, low) {
    return kind + '-' + Math.round(startTime) + '-' + Math.round(endTime) + '-' + Number(high).toFixed(8) + '-' + Number(low).toFixed(8);
  }

  /* ------------------------------------------------------------------ */
  /* H1 bağlamı: çok mumlu sıkışma kutusu                                */
  /* ------------------------------------------------------------------ */
  function detectCompressionBox(h1, h1Atr, o) {
    const n = h1.length;
    if (!(h1Atr > 0) || n < o.minBoxBars + 2) return null;
    const maxLen = Math.min(o.maxBoxBars, n - 1);
    let best = null;

    for (let len = maxLen; len >= o.minBoxBars; len--) {
      const start = n - len;
      const win = h1.slice(start);
      let high = -Infinity;
      let low = Infinity;
      for (const b of win) {
        if (b.high > high) high = b.high;
        if (b.low < low) low = b.low;
      }
      const height = high - low;
      if (!(height > 0)) continue;
      const heightAtr = height / h1Atr;
      if (heightAtr > o.maxBoxHeightAtr || heightAtr < o.minBoxHeightAtr) continue;

      const tol = o.touchTolAtr * h1Atr;
      let touchesHigh = 0;
      let touchesLow = 0;
      for (const b of win) {
        if (b.high >= high - tol) touchesHigh++;
        if (b.low <= low + tol) touchesLow++;
      }
      if (touchesHigh < o.minTouches || touchesLow < o.minTouches) continue;

      const last = win[win.length - 1];
      if (last.close < low - tol * 0.5 || last.close > high + tol * 0.5) continue;

      const balance = 1 - Math.abs(touchesHigh - touchesLow) / Math.max(1, Math.max(touchesHigh, touchesLow));
      const compact = 1 - Math.min(1, Math.abs(heightAtr - 0.8) / 0.8);
      const touchScore = Math.min(1, (touchesHigh + touchesLow) / 8);
      const score = 48 + 12 * touchScore + 10 * balance + 10 * compact + (len >= 6 ? 6 : 2) + (len <= 18 ? 4 : 0);

      const ctx = {
        id: contextId('comp', win[0].time, last.time, high, low),
        kind: 'compression',
        label: 'H1 SIKIŞMA',
        direction: 'neutral',
        startTime: win[0].time,
        endTime: last.time,
        bars: len,
        high,
        low,
        mid: (high + low) / 2,
        height,
        atr: h1Atr,
        heightAtr,
        touchesHigh,
        touchesLow,
        lastClose: last.close,
        lastTime: last.time,
        score,
      };
      if (!best || ctx.score > best.score || (ctx.score === best.score && ctx.bars < best.bars)) best = ctx;
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* H1 bağlamı: güçlü kırılım mumu                                      */
  /* ------------------------------------------------------------------ */
  function detectBreakoutCandle(h1, h1Atr, o) {
    const n = h1.length;
    if (!(h1Atr > 0) || n < 16) return null;
    let best = null;

    for (let age = 0; age <= o.breakoutMaxAgeBars; age++) {
      const i = n - 1 - age;
      if (i < 12) continue;
      const b = h1[i];
      const range = b.high - b.low;
      if (!(range > 0)) continue;
      const body = Math.abs(b.close - b.open);
      const bodyRatio = body / range;
      const bodyAtr = body / h1Atr;
      if (bodyRatio < o.breakoutBodyRatio || bodyAtr < o.breakoutBodyAtr) continue;

      const bull = b.close > b.open;
      const closePos = bull ? (b.close - b.low) / range : (b.high - b.close) / range;
      if (closePos < o.breakoutClosePos) continue;

      const look = Math.min(o.breakoutLookback, i);
      const prior = h1.slice(i - look, i);
      if (prior.length < 4) continue;
      let priorHigh = -Infinity;
      let priorLow = Infinity;
      for (const x of prior) {
        if (x.high > priorHigh) priorHigh = x.high;
        if (x.low < priorLow) priorLow = x.low;
      }
      const breakEps = Math.max(h1Atr * 0.05, epsOf(h1Atr, o.point));
      const broke = bull
        ? b.close > priorHigh + breakEps
        : b.close < priorLow - breakEps;
      if (!broke) continue;

      /* İşlem içinde kalınacak mum: son H1 kapanışı mumun dışına taşmamalı. */
      const last = h1[n - 1];
      const insideTol = h1Atr * 0.08;
      if (last.close < b.low - insideTol || last.close > b.high + insideTol) continue;
      if (range > h1Atr * 4.5) continue;

      const bodyMid = (b.open + b.close) / 2;
      const freshness = age === 0 ? 10 : age === 1 ? 7 : age === 2 ? 4 : 1;
      const score = 56 + 10 * Math.min(1, bodyRatio) + 8 * Math.min(1, bodyAtr / 1.8) +
        8 * closePos + freshness + (bull || !bull ? 2 : 0);

      const ctx = {
        id: contextId('brk', b.time, b.time, b.high, b.low),
        kind: 'breakout',
        label: bull ? 'H1 KIRILIM MUMU ↑' : 'H1 KIRILIM MUMU ↓',
        direction: bull ? 'bull' : 'bear',
        startTime: b.time,
        endTime: b.time,
        bars: 1,
        high: b.high,
        low: b.low,
        mid: bodyMid,
        bodyMid,
        open: b.open,
        close: b.close,
        height: range,
        atr: h1Atr,
        heightAtr: range / h1Atr,
        bodyRatio,
        bodyAtr,
        closePos,
        priorLevel: bull ? priorHigh : priorLow,
        ageBars: age,
        lastClose: last.close,
        lastTime: last.time,
        score,
      };
      if (!best || ctx.score > best.score || (ctx.score === best.score && ctx.ageBars < best.ageBars)) best = ctx;
    }
    return best;
  }

  function detectH1Context(h1Bars, opts) {
    const o = normalizeOpts(opts);
    const h1 = cleanBars(h1Bars);
    if (h1.length < 30) {
      return { ok: false, reason: 'H1 verisi yetersiz (en az 30 kapanmış mum gerekli)', h1, atr: 0, compression: null, breakout: null, contexts: [], primary: null };
    }
    const h1Atr = atr(h1, o.h1AtrPeriod);
    if (!(h1Atr > 0)) {
      return { ok: false, reason: 'H1 ATR hesaplanamadı', h1, atr: 0, compression: null, breakout: null, contexts: [], primary: null };
    }
    const compression = detectCompressionBox(h1, h1Atr, o);
    const breakout = detectBreakoutCandle(h1, h1Atr, o);
    const contexts = [compression, breakout].filter(Boolean).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.kind === 'breakout' ? 1 : 0) - (a.kind === 'breakout' ? 1 : 0);
    });
    return {
      ok: true,
      reason: contexts.length ? 'H1 bağlamı bulundu' : 'Uygun H1 kırılım/sıkışma yok',
      h1,
      atr: h1Atr,
      compression,
      breakout,
      contexts,
      primary: contexts[0] || null,
      asOf: h1[h1.length - 1].time,
    };
  }

  /* ------------------------------------------------------------------ */
  /* M5 tetikleri                                                        */
  /* ------------------------------------------------------------------ */
  function isBullEngulf(a, b) {
    return !!a && !!b && a.close < a.open && b.close > b.open && b.open <= a.close && b.close >= a.open;
  }

  function isBearEngulf(a, b) {
    return !!a && !!b && a.close > a.open && b.close < b.open && b.open >= a.close && b.close <= a.open;
  }

  function isBullPin(b) {
    if (!b) return false;
    const rng = b.high - b.low;
    if (!(rng > 0)) return false;
    const body = Math.abs(b.close - b.open);
    const lower = Math.min(b.open, b.close) - b.low;
    return lower >= Math.max(body * 1.5, rng * 0.4) && (b.close - b.low) / rng >= 0.6;
  }

  function isBearPin(b) {
    if (!b) return false;
    const rng = b.high - b.low;
    if (!(rng > 0)) return false;
    const body = Math.abs(b.close - b.open);
    const upper = b.high - Math.max(b.open, b.close);
    return upper >= Math.max(body * 1.5, rng * 0.4) && (b.high - b.close) / rng >= 0.6;
  }

  function alignmentScore(ctx, side) {
    if (!ctx || ctx.kind !== 'breakout') return 0;
    const aligned = (ctx.direction === 'bull' && side === 'long') || (ctx.direction === 'bear' && side === 'short');
    return aligned ? 9 : -14;
  }

  function touchBonus(ctx) {
    if (!ctx || ctx.kind !== 'compression') return 0;
    return Math.min(7, Math.round((ctx.touchesHigh + ctx.touchesLow) * 1.4));
  }

  function targetFor(ctx, side, entry, risk, o) {
    const height = ctx.height;
    const candidates = [];
    const add = (price, label) => {
      const p = Number(price);
      if (Number.isFinite(p) && p > 0) candidates.push({ price: p, label });
    };
    if (side === 'long') {
      if (ctx.kind === 'compression') {
        add(ctx.mid, 'H1 EQ (%50)');
        add(ctx.high, 'H1 üst bant');
        add(ctx.high + height * 0.35, 'H1 üst uzantı');
        add(ctx.high + height * 0.5, 'H1 üst uzantı');
        add(ctx.high + height, 'H1 measured move');
      } else {
        add(ctx.high, 'H1 kırılım mumu high');
        add(ctx.high + height * 0.5, 'H1 measured move');
        add(ctx.high + height, 'H1 uzantı');
      }
    } else {
      if (ctx.kind === 'compression') {
        add(ctx.mid, 'H1 EQ (%50)');
        add(ctx.low, 'H1 alt bant');
        add(ctx.low - height * 0.35, 'H1 alt uzantı');
        add(ctx.low - height * 0.5, 'H1 alt uzantı');
        add(ctx.low - height, 'H1 measured move');
      } else {
        add(ctx.low, 'H1 kırılım mumu low');
        add(ctx.low - height * 0.5, 'H1 measured move');
        add(ctx.low - height, 'H1 uzantı');
      }
    }
    for (const c of candidates) {
      const dist = side === 'long' ? c.price - entry : entry - c.price;
      if (!(dist > 0)) continue;
      const rr = dist / risk;
      if (rr + 1e-9 >= o.minRR) return { ...c, rr };
    }
    return null;
  }

  function gradeFor(score, o) {
    if (score >= o.aPlusScore) return 'A+';
    if (score >= o.minGradeScore) return 'A';
    return 'B';
  }

  function setupBase(ctx, side, triggerType, entry, sl, target, score, o, extra) {
    const risk = Math.abs(entry - sl);
    if (!(risk > 0) || !(target && target.price > 0)) return null;
    const grade = gradeFor(score, o);
    if (grade !== 'A' && grade !== 'A+') return null;
    return {
      id: [ctx.id, side, triggerType, extra.triggerTime, extra.entryTime].join('|'),
      contextId: ctx.id,
      side,
      grade,
      score: Math.round(score * 10) / 10,
      triggerType,
      entry,
      sl,
      tp: target.price,
      rr: target.rr,
      risk,
      targetLabel: target.label,
      riskAtrM5: extra.riskAtrM5,
      triggerTime: extra.triggerTime,
      entryTime: extra.entryTime,
      expiresAt: extra.entryTime + o.setupTtlBarsM5 * 300,
      reasons: extra.reasons || [],
      invalidation: extra.invalidation || null,
      meta: extra.meta || {},
    };
  }

  function edgeReversal(ctx, m5, m5Atr, o) {
    const n = m5.length;
    if (n < 12) return null;
    const last = m5[n - 1];
    const height = ctx.height;
    const edgeTol = Math.max(0.25 * m5Atr, 0.04 * height);
    const eps = epsOf(m5Atr, o.point);
    let best = null;

    for (const side of ['long', 'short']) {
      if (ctx.kind === 'breakout') {
        const aligned = (ctx.direction === 'bull' && side === 'long') || (ctx.direction === 'bear' && side === 'short');
        /* Kırılım mumunda yalnız kırılım yönünde işlem aranır. */
        if (!aligned) continue;
      }
      if (last.close < ctx.low - edgeTol * 0.35 || last.close > ctx.high + edgeTol * 0.35) continue;
      if (side === 'long' && last.close > ctx.low + height * 0.58) continue;
      if (side === 'short' && last.close < ctx.high - height * 0.58) continue;

      for (let i = n - 2; i >= Math.max(1, n - 9); i--) {
        const b = m5[i];
        const prior = m5.slice(Math.max(0, i - 6), i);
        if (prior.length < 3) continue;
        let priorLow = Infinity;
        let priorHigh = -Infinity;
        for (const x of prior) {
          if (x.low < priorLow) priorLow = x.low;
          if (x.high > priorHigh) priorHigh = x.high;
        }

        let confirmIdx = -1;
        let refHigh = -Infinity;
        let refLow = Infinity;
        let swept = false;
        let sweptBox = false;
        let sweptSwing = false;
        let ref = 0;

        if (side === 'long') {
          sweptBox = b.low <= ctx.low - eps;
          sweptSwing = b.low <= priorLow - eps;
          if (!sweptBox && !sweptSwing) continue;
          if (b.low > ctx.low + edgeTol) continue;
          ref = Math.max(ctx.low, priorLow);
          if (b.close < ref + eps) continue;
          swept = true;
          for (let k = Math.max(0, i - 2); k <= i; k++) if (m5[k].high > refHigh) refHigh = m5[k].high;
          for (let j = i + 1; j <= Math.min(n - 1, i + 4); j++) {
            if (m5[j].close > refHigh + eps) { confirmIdx = j; break; }
          }
        } else {
          sweptBox = b.high >= ctx.high + eps;
          sweptSwing = b.high >= priorHigh + eps;
          if (!sweptBox && !sweptSwing) continue;
          if (b.high < ctx.high - edgeTol) continue;
          ref = Math.min(ctx.high, priorHigh);
          if (b.close > ref - eps) continue;
          swept = true;
          for (let k = Math.max(0, i - 2); k <= i; k++) if (m5[k].low < refLow) refLow = m5[k].low;
          for (let j = i + 1; j <= Math.min(n - 1, i + 4); j++) {
            if (m5[j].close < refLow - eps) { confirmIdx = j; break; }
          }
        }
        if (!swept || confirmIdx < 0) continue;
        if (n - 1 - confirmIdx > o.maxTriggerAgeBars) continue;

        const confirmBar = m5[confirmIdx];
        const engulf = side === 'long' ? isBullEngulf(m5[confirmIdx - 1], confirmBar) : isBearEngulf(m5[confirmIdx - 1], confirmBar);
        const pin = side === 'long' ? isBullPin(confirmBar) : isBearPin(confirmBar);

        let slBase = side === 'long' ? Infinity : -Infinity;
        for (let k = i; k < n; k++) {
          if (side === 'long' && m5[k].low < slBase) slBase = m5[k].low;
          if (side === 'short' && m5[k].high > slBase) slBase = m5[k].high;
        }
        if (!Number.isFinite(slBase)) continue;
        const buffer = Math.max(0.2 * m5Atr, o.point * 2);
        const entry = last.close;
        const sl = side === 'long' ? slBase - buffer : slBase + buffer;
        const risk = Math.abs(entry - sl);
        if (!(risk > 0)) continue;
        const riskAtrM5 = risk / m5Atr;
        if (riskAtrM5 > o.maxRiskAtrM5) continue;
        const target = targetFor(ctx, side, entry, risk, o);
        if (!target) continue;

        const freshness = n - 1 - confirmIdx <= 1 ? 6 : n - 1 - confirmIdx <= 2 ? 4 : 2;
        let score = 35 + 18 + 10 + freshness + touchBonus(ctx) + alignmentScore(ctx, side);
        if (target.rr >= 2) score += 8;
        else if (target.rr >= o.minRR) score += 4;
        if (engulf) score += 4;
        else if (pin) score += 3;
        if (ctx.kind === 'compression') score += 3;

        const reasons = [];
        reasons.push('M5 likidite süpürme');
        reasons.push('M5 CHoCH onayı');
        if (engulf) reasons.push('engulfing teyidi');
        else if (pin) reasons.push('pin bar teyidi');
        if (ctx.kind === 'compression') reasons.push('H1 sıkışma kenarı');
        else reasons.push(ctx.direction === 'bull' ? 'H1 kırılım yönü' : 'H1 kırılım yönü');
        reasons.push('RR ' + target.rr.toFixed(2));

        const invalidation = side === 'long'
          ? { price: ctx.low - ctx.atr * 0.15, text: 'H1 kapanışı ' + fmt(ctx.low - ctx.atr * 0.15) + ' altına inerse' }
          : { price: ctx.high + ctx.atr * 0.15, text: 'H1 kapanışı ' + fmt(ctx.high + ctx.atr * 0.15) + ' üstüne çıkarsa' };

        const cand = setupBase(ctx, side, 'edge_reversal', entry, sl, target, score, o, {
          triggerTime: confirmBar.time,
          entryTime: last.time,
          riskAtrM5,
          reasons,
          invalidation,
          meta: { sweepTime: b.time, confirmTime: confirmBar.time, sweptBox, sweptSwing, engulf, pin },
        });
        if (cand && (!best || cand.score > best.score)) best = cand;
      }
    }
    return best;
  }

  function microBreakoutRetest(ctx, m5, m5Atr, o) {
    const n = m5.length;
    if (n < 14) return null;
    const last = m5[n - 1];
    const height = ctx.height;
    const eps = epsOf(m5Atr, o.point);
    const maxMicroWidth = Math.max(1.2 * m5Atr, Math.min(0.5 * height, 0.9 * ctx.atr));
    const retestTol = Math.max(0.25 * m5Atr, 0.03 * height);
    let best = null;

    for (let i = n - 3; i >= Math.max(8, n - 10); i--) {
      const b = m5[i];
      const prior = m5.slice(Math.max(0, i - 6), i);
      if (prior.length < 4) continue;
      let mHigh = -Infinity;
      let mLow = Infinity;
      for (const x of prior) {
        if (x.high > mHigh) mHigh = x.high;
        if (x.low < mLow) mLow = x.low;
      }
      const mWidth = mHigh - mLow;
      if (!(mWidth > 0) || mWidth > maxMicroWidth) continue;
      const range = b.high - b.low;
      if (!(range > 0)) continue;
      const body = Math.abs(b.close - b.open);
      const bodyRatio = body / range;
      if (bodyRatio < 0.5) continue;

      let side = '';
      let level = 0;
      if (b.close > b.open && b.close > mHigh + eps) { side = 'long'; level = mHigh; }
      else if (b.close < b.open && b.close < mLow - eps) { side = 'short'; level = mLow; }
      else continue;

      if (level <= ctx.low + height * 0.04 || level >= ctx.high - height * 0.04) continue;
      if (ctx.kind === 'breakout') {
        const aligned = (ctx.direction === 'bull' && side === 'long') || (ctx.direction === 'bear' && side === 'short');
        if (!aligned) continue;
      }

      let retestIdx = -1;
      for (let j = i + 1; j < n; j++) {
        const x = m5[j];
        if (side === 'long') {
          if (x.low <= level + retestTol && x.close >= level - eps && x.close >= x.open) retestIdx = j;
        } else {
          if (x.high >= level - retestTol && x.close <= level + eps && x.close <= x.open) retestIdx = j;
        }
      }
      if (retestIdx < 0) continue;
      if (n - 1 - retestIdx > o.maxTriggerAgeBars) continue;

      if (side === 'long' && last.close <= level + eps) continue;
      if (side === 'short' && last.close >= level - eps) continue;
      if (last.close < ctx.low || last.close > ctx.high) continue;

      let slBase = side === 'long' ? Infinity : -Infinity;
      for (let k = i; k < n; k++) {
        if (side === 'long' && m5[k].low < slBase) slBase = m5[k].low;
        if (side === 'short' && m5[k].high > slBase) slBase = m5[k].high;
      }
      if (!Number.isFinite(slBase)) continue;
      const buffer = Math.max(0.2 * m5Atr, o.point * 2);
      const entry = last.close;
      const sl = side === 'long' ? slBase - buffer : slBase + buffer;
      const risk = Math.abs(entry - sl);
      if (!(risk > 0)) continue;
      const riskAtrM5 = risk / m5Atr;
      if (riskAtrM5 > o.maxRiskAtrM5) continue;
      const target = targetFor(ctx, side, entry, risk, o);
      if (!target) continue;

      const freshness = n - 1 - retestIdx <= 1 ? 6 : n - 1 - retestIdx <= 2 ? 4 : 2;
      let score = 35 + 16 + 10 + freshness + alignmentScore(ctx, side) + touchBonus(ctx);
      if (target.rr >= 2) score += 8;
      else if (target.rr >= o.minRR) score += 4;
      if (bodyRatio >= 0.65) score += 4;
      if (ctx.kind === 'compression') score += 2;

      const reasons = [];
      reasons.push('M5 mikro range kırılımı');
      reasons.push('M5 retest korundu');
      if (ctx.kind === 'compression') reasons.push('H1 sıkışma içi');
      else reasons.push(ctx.direction === 'bull' ? 'H1 kırılım yönü' : 'H1 kırılım yönü');
      reasons.push('RR ' + target.rr.toFixed(2));

      const invalidation = side === 'long'
        ? { price: ctx.low - ctx.atr * 0.15, text: 'H1 kapanışı ' + fmt(ctx.low - ctx.atr * 0.15) + ' altına inerse' }
        : { price: ctx.high + ctx.atr * 0.15, text: 'H1 kapanışı ' + fmt(ctx.high + ctx.atr * 0.15) + ' üstüne çıkarsa' };

      const cand = setupBase(ctx, side, 'micro_breakout_retest', entry, sl, target, score, o, {
        triggerTime: m5[retestIdx].time,
        entryTime: last.time,
        riskAtrM5,
        reasons,
        invalidation,
        meta: { microHigh: mHigh, microLow: mLow, level, breakoutTime: b.time, retestTime: m5[retestIdx].time, bodyRatio },
      });
      if (cand && (!best || cand.score > best.score)) best = cand;
    }
    return best;
  }

  function evaluateM5Setup(context, m5Bars, opts) {
    const o = normalizeOpts(opts);
    const ctx = context && context.kind ? context : null;
    if (!ctx) return null;
    const m5 = cleanBars(m5Bars);
    if (m5.length < 18) return null;
    const m5Atr = atr(m5, o.m5AtrPeriod);
    if (!(m5Atr > 0)) return null;
    const edge = edgeReversal(ctx, m5, m5Atr, o);
    const micro = microBreakoutRetest(ctx, m5, m5Atr, o);
    if (!edge && !micro) return null;
    if (edge && micro) return micro.score > edge.score ? micro : edge;
    return edge || micro;
  }

  /* ------------------------------------------------------------------ */
  /* Birleşik analiz                                                     */
  /* ------------------------------------------------------------------ */
  function analyze(h1Bars, m5Bars, opts) {
    const o = normalizeOpts(opts);
    const h1 = cleanBars(h1Bars);
    const m5 = cleanBars(m5Bars);
    const h1ctx = detectH1Context(h1, o);
    if (!h1ctx.ok) {
      return {
        ok: false,
        reason: h1ctx.reason,
        h1: { atr: h1ctx.atr, compression: null, breakout: null, contexts: [], primary: null, last: h1.length ? h1[h1.length - 1] : null },
        m5: { atr: 0, last: m5.length ? m5[m5.length - 1] : null },
        context: null,
        contexts: [],
        setup: null,
        asOf: h1.length ? h1[h1.length - 1].time : 0,
      };
    }
    if (!h1ctx.contexts.length) {
      return {
        ok: true,
        reason: 'Uygun H1 kırılım/sıkışma yok',
        h1: { ...h1ctx, last: h1[h1.length - 1] },
        m5: { atr: atr(m5, o.m5AtrPeriod), last: m5.length ? m5[m5.length - 1] : null },
        context: null,
        contexts: [],
        setup: null,
        asOf: Math.max(h1ctx.asOf || 0, m5.length ? m5[m5.length - 1].time : 0),
      };
    }

    const m5Atr = atr(m5, o.m5AtrPeriod);
    let best = null;
    let bestCtx = null;
    for (const ctx of h1ctx.contexts) {
      const cand = evaluateM5Setup(ctx, m5, o);
      if (cand && (!best || cand.score > best.score)) {
        best = cand;
        bestCtx = ctx;
      }
    }
    return {
      ok: true,
      reason: best ? 'A/A+ setup hazır' : 'H1 bağlam var, M5 tetik/onay bekleniyor',
      h1: { ...h1ctx, last: h1[h1.length - 1] },
      m5: { atr: m5Atr, last: m5.length ? m5[m5.length - 1] : null },
      context: bestCtx || h1ctx.primary,
      contexts: h1ctx.contexts,
      setup: best,
      asOf: Math.max(h1ctx.asOf || 0, m5.length ? m5[m5.length - 1].time : 0),
    };
  }

  /* Aktif öneriyi her turda yeniden üretmek yerine, geçerliliğini ölç. */
  function setupStillValid(setup, context, lastM5, lastH1, nowSec) {
    if (!setup || !context || !lastM5 || !(Number(lastM5.close) > 0)) return false;
    const p = Number(lastM5.close);
    /* bar zamanı sunucu saatidir: TTL'i bar saatiyle ölç (yerel saat kayması yok) */
    const now = Number(nowSec) || (Number(lastM5.time) > 0 ? Number(lastM5.time) + 300 : 0);
    if (setup.expiresAt && now > setup.expiresAt) return false;
    const h1p = lastH1 && Number(lastH1.close) > 0 ? Number(lastH1.close) : null;
    if (h1p != null) {
      const pad = Number(context.atr) * 0.15;
      if (h1p < context.low - pad || h1p > context.high + pad) return false;
    }
    if (setup.side === 'long') {
      if (p <= Number(setup.sl)) return false;
      if (p >= Number(setup.tp)) return false;
      if (p < context.low - Number(context.atr) * 0.25) return false;
    } else {
      if (p >= Number(setup.sl)) return false;
      if (p <= Number(setup.tp)) return false;
      if (p > context.high + Number(context.atr) * 0.25) return false;
    }
    return true;
  }

  return {
    VERSION,
    DEFAULTS,
    cleanBars,
    closedOnly,
    atr,
    trueRangeAt,
    detectCompressionBox,
    detectBreakoutCandle,
    detectH1Context,
    evaluateM5Setup,
    analyze,
    setupStillValid,
  };
});
