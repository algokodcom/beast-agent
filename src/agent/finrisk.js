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

/* ---------- DİSİPLİN (kodla zorlanan trader kuralları) ----------
   Prompt ricalarına güvenmeden uygulanır: günlük işlem limiti, ardışık kayıp
   molası, sembol re-entry beklemesi ve yönlü kur maruziyeti (korelasyon). */

const SYM_ALIAS = {
  XAU: 'XAU', GOLD: 'XAU', XAUT: 'XAU',
  XAG: 'XAG', SILV: 'XAG', SILVER: 'XAG',
  WTI: 'OIL', BREN: 'OIL', BRENT: 'OIL', USOI: 'OIL', UKOI: 'OIL',
  NATG: 'GAS', NGAS: 'GAS',
};

/* Sembolün para bacakları: EURUSD → [EUR,USD]; GOLD → [XAU,USD]; bilinmezse [] */
function symbolLegs(symbol) {
  const s = String(symbol || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (/^[A-Z]{6}$/.test(s)) return [s.slice(0, 3), s.slice(3)];
  const base = SYM_ALIAS[s.slice(0, 4)] || SYM_ALIAS[s.slice(0, 3)];
  if (base) return [base, 'USD'];
  if (/^USD[A-Z]{3}$/.test(s)) return ['USD', s.slice(3)];
  return [];
}

/* Yönlü kur maruziyeti: buy EURUSD = +EUR −USD. Limitsizse null. */
function currencyExposureError(positions, side, symbol, maxPerCurrency) {
  const max = num(maxPerCurrency, 0);
  if (!(max > 0)) return null;
  const legs = symbolLegs(symbol);
  if (!legs.length) return null;
  const dir = String(side).toLowerCase() === 'buy' ? 1 : -1;
  const exp = {};
  const add = (cur, d) => { if (cur) exp[cur] = (exp[cur] || 0) + d; };
  for (const p of (Array.isArray(positions) ? positions : [])) {
    const l = symbolLegs(p && p.symbol);
    if (!l.length) continue;
    const d = Number(p.type) === 0 ? 1 : -1;
    add(l[0], d);
    add(l[1], -d);
  }
  add(legs[0], dir);
  add(legs[1], -dir);
  for (const [cur, v] of Object.entries(exp)) {
    if (Math.abs(v) > max) {
      return `${cur} yönlü maruziyet ${v > 0 ? '+' : ''}${v} (max ±${max}) — korelasyon riski; farklı parite/yöne geç`;
    }
  }
  return null;
}

/* Zaman/geçmiş tabanlı disiplin. entries: journal kayıtları (at, kind, symbol, net).
   Sorun varsa Türkçe hata metni, yoksa null döner. Limit 0 = kural kapalı. */
function disciplineError(entries, now, cfg, side, symbol, positions) {
  const t = num(now, Date.now());
  /* gelecekteki kayıtlar (saat kayması) değerlendirmeye girmez */
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && Number.isFinite(Number(e.at)) && Number(e.at) <= t);
  const f = cfg || {};
  const dayStart = (() => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const maxDay = num(f.maxTradesPerDay, 0);
  if (maxDay > 0) {
    const opens = list.filter((e) => e.kind === 'open' && Number(e.at) >= dayStart).length;
    if (opens >= maxDay) {
      return `günlük işlem limiti dolu (${opens}/${maxDay}) — bugün yeni işlem açma`;
    }
  }
  const streakLimit = num(f.lossStreakLimit, 0);
  const pauseMin = num(f.lossStreakPauseMin, 0);
  if (streakLimit > 0 && pauseMin > 0) {
    const closes = list.filter((e) => e.kind === 'close').slice().sort((a, b) => num(b.at, 0) - num(a.at, 0));
    let streak = 0;
    let lastAt = 0;
    for (const c of closes) {
      if (num(c.net, 0) < 0) {
        streak++;
        if (!lastAt) lastAt = num(c.at, 0);
      } else break;
    }
    if (streak >= streakLimit && lastAt) {
      const elapsed = t - lastAt;
      if (elapsed < pauseMin * 60000) {
        const rem = Math.ceil((pauseMin * 60000 - elapsed) / 60000);
        return `${streak} ardışık kayıp — seri molası ${rem} dk daha (limit ${streakLimit} kayıp → ${pauseMin} dk mola)`;
      }
    }
  }
  const reMin = num(f.reentryCooldownMin, 0);
  if (reMin > 0) {
    const sym = String(symbol || '').toUpperCase();
    const last = list
      .filter((e) => e.kind === 'close' && String(e.symbol || '').toUpperCase() === sym)
      .sort((a, b) => num(b.at, 0) - num(a.at, 0))[0];
    if (last) {
      const elapsed = t - num(last.at, 0);
      if (elapsed < reMin * 60000) {
        const rem = Math.ceil((reMin * 60000 - elapsed) / 60000);
        return `${sym} son işlemi ${Math.max(1, Math.round(elapsed / 60000))} dk önce kapandı — re-entry için ${rem} dk bekle`;
      }
    }
  }
  return currencyExposureError(positions, side, symbol, f.maxPerCurrency);
}

module.exports = {
  normalizeVolume,
  lossPerLot,
  calcRiskLot,
  stopsTooClose,
  marginCheck,
  exposureCheck,
  symbolLegs,
  currencyExposureError,
  disciplineError,
};
