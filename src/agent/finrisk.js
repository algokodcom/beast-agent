'use strict';

/* Beast Finance — işlem öncesi risk katmanı (saf; köprü/IO yok).
   Lot normalizasyonu (broker min/max/step), %risk ile lot hesabı (SL mesafesi
   veya ATR), stops_level doğrulaması, marj kalkanı ve yoğunluk (net yön)
   kontrolü. financetools bu kararları uygular; birim testleri doğrudan çağırır. */

function num(v, def) {
  const n = Number(v);
  return isFinite(n) ? n : def;
}

function stepFloor(v, step) {
  const s = num(step, 0.01);
  if (!(s > 0)) return v;
  return Math.floor(v / s + 1e-9) * s;
}

/* info: MT5 symbol_info satırı. wanted: istenen lot. hardMax: kullanıcı limiti. */
function normalizeVolume(info, wanted, hardMax) {
  const vmin = num(info && info.volume_min, 0.01);
  const vmax = num(info && info.volume_max, 100);
  const step = num(info && info.volume_step, 0.01);
  let v = num(wanted, 0);
  if (!(v > 0)) return { error: 'volume gerekli (pozitif sayı)' };
  const cap = Math.min(vmax > 0 ? vmax : Infinity, num(hardMax, 0) > 0 ? num(hardMax, 0) : Infinity);
  let capped = false;
  if (v > cap) {
    v = stepFloor(cap, step);
    capped = true;
  }
  v = Math.round(stepFloor(v, step) * 1e8) / 1e8;
  if (!(v > 0) || v < vmin - 1e-9) {
    return { error: `hacim broker minimumunun altında (min ${vmin} lot)` };
  }
  return { volume: v, capped };
}

/* 1 lot için SL mesafesi kaybı (hesap para birimi): tick değeri, yoksa kontrat */
function lossPerLot(info, entry, sl) {
  const dist = Math.abs(num(entry, 0) - num(sl, 0));
  if (!(dist > 0)) return 0;
  const tickSize = num(info && info.trade_tick_size, 0) || num(info && info.point, 0);
  const tickValue = num(info && info.trade_tick_value, 0);
  if (tickSize > 0 && tickValue > 0) return (dist / tickSize) * tickValue;
  const contract = num(info && info.trade_contract_size, 0);
  if (contract > 0) return dist * contract;
  return 0;
}

/* riskAmount: hesap para birimi cinsinden kaybedilecek tutar */
function calcRiskLot(info, entry, sl, riskAmount, hardMax) {
  const lpl = lossPerLot(info, entry, sl);
  if (!(lpl > 0)) return { error: 'risk hesaplanamadı (tick değeri/kontrat bilgisi yok)' };
  const raw = num(riskAmount, 0) / lpl;
  const norm = normalizeVolume(info, raw, hardMax);
  if (norm.error) return { error: norm.error, raw, lossPerLot: lpl };
  return {
    volume: norm.volume,
    raw: Math.round(raw * 1e4) / 1e4,
    lossPerLot: Math.round(lpl * 100) / 100,
    riskAmount: Math.round(raw * lpl * 100) / 100,
    capped: !!norm.capped,
  };
}

/* stops_level ihlali: SL/TP fiyata çok yakın mı? (broker reddini önler)
   Yakınsa Türkçe hata metni, sorun yoksa null döner. */
function stopsTooClose(info, price, sl, tp) {
  const stops = num(info && info.trade_stops_level, 0);
  if (!(stops > 0)) return null;
  const point = num(info && info.point, 0);
  if (!(point > 0)) return null;
  const minDist = stops * point;
  const p = num(price, 0);
  const s = num(sl, 0);
  const t = num(tp, 0);
  if (p > 0 && s > 0 && Math.abs(p - s) < minDist - 1e-12) {
    return `SL fiyata çok yakın — broker en az ${minDist.toFixed(point < 0.01 ? 3 : 2)} mesafe istiyor`;
  }
  if (p > 0 && t > 0 && Math.abs(p - t) < minDist - 1e-12) {
    return `TP fiyata çok yakın — broker en az ${minDist.toFixed(point < 0.01 ? 3 : 2)} mesafe istiyor`;
  }
  return null;
}

/* Marj kalkanı: mevcut serbest marj + işlem sonrası tahmini marj seviyesi.
   Sorun varsa hata metni, yoksa null. */
function marginCheck(account, estMargin, minLevel) {
  const equity = num(account && account.equity, 0);
  const used = num(account && account.margin, 0);
  const free = num(account && account.margin_free, 0);
  const current = num(account && account.margin_level, 0);
  const m = num(estMargin, 0);
  const minL = num(minLevel, 0);
  if (m > 0 && free > 0 && m > free) {
    return { error: `yetersiz serbest marj (gerekli ~${m.toFixed(2)}, serbest ${free.toFixed(2)})` };
  }
  if (minL > 0 && current > 0 && current < minL) {
    return { error: `marj seviyesi kalkanı: mevcut %${current.toFixed(0)} < min %${minL}` };
  }
  if (minL > 0 && equity > 0 && (used > 0 || m > 0)) {
    const after = (equity / (used + m)) * 100;
    if (after < minL) {
      return { error: `marj seviyesi kalkanı: işlem sonrası tahmini %${after.toFixed(0)} < min %${minL}`, level: Math.round(after * 100) / 100 };
    }
  }
  return null;
}

/* Yoğunluk: aynı yöne birikme + sembol başına aynı yön limiti.
   Sorun varsa hata metni, yoksa null. 0 = ilgili kural kapalı. */
function exposureCheck(positions, side, symbol, maxPerSymbol, maxSameSide) {
  const list = Array.isArray(positions) ? positions : [];
  const isBuy = String(side).toLowerCase() === 'buy';
  const sym = String(symbol || '').toUpperCase();
  const maxSame = num(maxSameSide, 0);
  const maxSym = num(maxPerSymbol, 0);
  if (maxSame > 0) {
    const sameDir = list.filter((p) => (Number(p.type) === 0) === isBuy).length;
    if (sameDir >= maxSame) return `aynı yönde ${sameDir} pozisyon var (max ${maxSame}) — çeşitlendir`;
  }
  if (maxSym > 0) {
    const sameSym = list.filter(
      (p) => String(p.symbol || '').toUpperCase() === sym && (Number(p.type) === 0) === isBuy
    ).length;
    if (sameSym >= maxSym) return `${sym} ${isBuy ? 'BUY' : 'SELL'} için ${sameSym} pozisyon var (max ${maxSym})`;
  }
  return null;
}

module.exports = { normalizeVolume, lossPerLot, calcRiskLot, stopsTooClose, marginCheck, exposureCheck };
