'use strict';

/* Beast Finance — risk otomasyonu KARAR katmanı (saf; köprü/IO yok).
   Açık pozisyon + sembol meta verisi + pozisyon durumu (st) alır; uygulanacak
   aksiyonları döndürür:
     {kind:'modify', sl}        → SL'yi taşı (BE / trailing)
     {kind:'partial', volume}   → kısmi TP kapat
     {kind:'warnSL'}            → SL'ye yaklaşma uyarısı
     {kind:'warnNoSL'}          → SL'siz pozisyon uyarısı
   main süreç aksiyonları köprüye uygular; başarılı olanın bayrağını st'ye yazar. */

function num(v, def) {
  const n = Number(v);
  return isFinite(n) ? n : def;
}

function roundTo(v, digits) {
  const d = Math.max(0, Math.min(8, Math.round(Number(digits) || 0)));
  const p = Math.pow(10, d);
  return Math.round(v * p) / p;
}

function stepRound(v, step) {
  const s = num(step, 0.01);
  if (!(s > 0)) return v;
  const q = Math.floor(v / s + 1e-9);
  return q * s;
}

/* meta: { digits, point, trade_stops_level, volume_min, volume_max, volume_step } */
function plan(pos, meta, st, cfg) {
  const out = { actions: [], r: num(st && st.r, 0) };
  if (!pos || !meta) return out;
  const isBuy = Number(pos.type) === 0;
  const entry = num(pos.price_open, 0);
  const ref = num(pos.price_current, 0);
  const sl = num(pos.sl, 0);
  const volume = num(pos.volume, 0);
  const digits = num(meta.digits, 5);
  const point = num(meta.point, Math.pow(10, -digits));
  const stopsPoints = num(meta.trade_stops_level, 0);
  const minDist = stopsPoints > 0 ? (stopsPoints + 1) * point : point;
  if (!(entry > 0) || !(ref > 0) || !(volume > 0)) return out;

  /* R (ilk risk mesafesi) yalnızca pozisyon ilk görüldüğünde SL'den hesaplanır */
  let r = num(st && st.r, 0);
  if (!(r > 0) && sl > 0) r = Math.abs(entry - sl);
  out.r = r;

  const beOn = num(cfg && cfg.beOnR, 1);
  const beOff = num(cfg && cfg.beOffsetR, 0.05);
  const trailStart = num(cfg && cfg.trailStartR, 1.5);
  const trailDist = num(cfg && cfg.trailR, 0.5);
  const partialR = num(cfg && cfg.partialR, 0);
  const partialPct = num(cfg && cfg.partialPct, 50);

  const profit = isBuy ? ref - entry : entry - ref;

  /* ---- BE + trailing: hedef SL'yi birleştir, asla geriye taşıma ---- */
  if (r > 0) {
    let desired = sl > 0 ? sl : 0;
    let want = false;
    if (beOn > 0 && !(st && st.be) && profit >= beOn * r) {
      const beSl = isBuy ? entry + beOff * r : entry - beOff * r;
      if (!(desired > 0) || (isBuy ? beSl > desired : beSl < desired)) desired = beSl;
      want = true;
    }
    if (trailStart > 0 && trailDist > 0 && profit >= trailStart * r) {
      const trailSl = isBuy ? ref - trailDist * r : ref + trailDist * r;
      if (!(desired > 0) || (isBuy ? trailSl > desired : trailSl < desired)) desired = trailSl;
      want = true;
    }
    if (want && desired > 0) {
      /* broker stop mesafesi: SL fiyata çok yakınsa geçersiz — kırp */
      desired = isBuy ? Math.min(desired, ref - minDist) : Math.max(desired, ref + minDist);
      const improved = isBuy ? desired > sl + point * 0.5 : (sl === 0 || desired < sl - point * 0.5);
      if (improved && desired > 0) {
        out.actions.push({ kind: 'modify', sl: roundTo(desired, digits) });
      }
    }
  }

  /* ---- kısmi TP ---- */
  if (partialR > 0 && partialPct > 0 && partialPct < 100 && r > 0 && !(st && st.partial) && profit >= partialR * r) {
    const step = num(meta.volume_step, 0.01);
    const vmin = num(meta.volume_min, 0.01);
    const vmax = num(meta.volume_max, 100);
    let vol = stepRound((volume * partialPct) / 100, step);
    vol = Math.min(vol, vmax);
    const remain = volume - vol;
    if (vol >= vmin && remain >= vmin - 1e-9 && vol < volume) {
      out.actions.push({ kind: 'partial', volume: Math.round(vol * 1e8) / 1e8 });
    }
  }

  /* ---- uyarılar ---- */
  if (sl > 0) {
    if (r > 0) {
      const dist = isBuy ? ref - sl : sl - ref;
      const thr = Math.max(minDist * 3, 0.2 * r);
      if (dist > 0 && dist <= thr && !(st && st.warnSL)) out.actions.push({ kind: 'warnSL' });
      out.rearmSL = dist > thr * 1.6;
    }
  } else if (!(st && st.warnNoSL)) {
    out.actions.push({ kind: 'warnNoSL' });
  }
  return out;
}

module.exports = { plan, roundTo, stepRound };
