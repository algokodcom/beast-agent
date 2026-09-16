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
  /* KÂR KORUMA (erken trailing): kâr protectStartR'ye ulaşınca SL, GÖRÜLEN EN
     İYİ kârın protectDistR gerisine kilitlenir — spike dönüşlerinde kâr
     eksiye dönmez (0 = kapalı; varsayılan main finCfg'de verilir). */
  const protectStart = num(cfg && cfg.protectStartR, 0);
  const protectDist = num(cfg && cfg.protectDistR, 0);

  const profit = isBuy ? ref - entry : entry - ref;
  /* en iyi kâr: tick'ler arası spike'lar kaybolmasın — main st.bestProfit yazar */
  const bestProfit = Math.max(profit, num(st && st.bestProfit, profit));

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
    /* kâr kilidi: ulaşılan EN İYİ kârın bir kısmı garantiye alınır */
    if (protectStart > 0 && protectDist > 0 && bestProfit >= protectStart * r) {
      const locked = bestProfit - protectDist * r;
      const lockSl = isBuy ? entry + locked : entry - locked;
      if (locked > 0 && (!(desired > 0) || (isBuy ? lockSl > desired : lockSl < desired))) desired = lockSl;
      want = true;
    }
    if (want && desired > 0) {
      /* broker stop mesafesi: SL fiyata çok yakınsa geçersiz — kırp */
      desired = isBuy ? Math.min(desired, ref - minDist) : Math.max(desired, ref + minDist);
      /* KIRPMA KİLİDİ BOZDU: fiyat geri çekildi, hedef SL girişin kaybına
         indi — kâr kilidini kaybı kilitleyen SL'e çevirme; hiç yazma
         (fiyat toparlayınca kilit yeniden uygulanır). */
      const lockBroken = isBuy ? desired < entry : desired > entry;
      const improved = !lockBroken && (isBuy ? desired > sl + point * 0.5 : (sl === 0 || desired < sl - point * 0.5));
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

/* ---- kapanış nedeni (MT5 deal reason) ----
   İşlem SL/TP ile mi kapandı? Saf sınıflandırma: 4 = stop-loss,
   5 = take-profit, 6 = stop-out (teminat). Diğerleri (manuel/EA/broker)
   BOŞ döner — bu olaylarda ajan uyandırılmaz. */
function closeKind(reason) {
  const n = Number(reason);
  if (n === 4) return 'stop';
  if (n === 5) return 'tp';
  if (n === 6) return 'stopout';
  return '';
}

/* ---- emir tipi çözümleme (6 tip) ----
   "buy"/"sell" → piyasa (market); buy_market/sell_market → piyasa;
   buy_limit/sell_limit/buy_stop/sell_stop → bekleyen (pending).
   Esnek yazım: "sell limit", "limit_buy", "MARKET BUY", "anlık" aynı sonuca iner.
   fallbackSide: tip yön taşımıyorsa (ör. yalnız "market"/"limit") kullanılır.
   Dönüş: { ok, side:'buy'|'sell', kind:'market'|'pending', type:'buy_market'|... } */
function parseOrderType(raw, fallbackSide) {
  const s = String(raw || '').toLowerCase().replace(/[\s-]+/g, '_');
  const fb = String(fallbackSide || '').toLowerCase().trim();
  const side = /(^|_)sell(_|$)/.test(s)
    ? 'sell'
    : /(^|_)buy(_|$)/.test(s)
      ? 'buy'
      : fb === 'sell'
        ? 'sell'
        : fb === 'buy'
          ? 'buy'
          : '';
  if (!side) return { ok: false };
  const hasLimit = /limit/.test(s);
  const hasStop = /stop/.test(s);
  const hasMarket = /market|instant|piyasa|anl[ıi]k/.test(s);
  if ((hasLimit || hasStop) && !hasMarket) {
    return { ok: true, side, kind: 'pending', type: side + '_' + (hasLimit ? 'limit' : 'stop') };
  }
  return { ok: true, side, kind: 'market', type: side + '_market' };
}

/* ---- fiyat alarmı soğuması ----
   Tekrarlı alarm (once=false): aynı koşul sürdükçe en fazla cooldownMin
   dakikada bir tetiklenir. once=true alarmda soğuma uygulanmaz (ilk
   tetiklemede kapanır). */
function alertCooldownActive(a, now) {
  if (!a || a.once) return false;
  const cd = (Number(a.cooldownMin) || 0) * 60000;
  if (!(cd > 0)) return false;
  const last = Number(a.lastFiredAt) || 0;
  return last > 0 && Number(now) - last < cd;
}

/* ---- alarm temizliği (ajan kendi kurduğu gereksiz alarmı siler) ----
   opts:
     ids    → yalnız bu id'ler (açıkça verilenler sahiplikten bağımsız silinir)
     sid    → alarmı kuran ajan oturumu; scope varsayılanı "kendi alarmlarım"
     symbol → yalnız bu sembole daralt
     all    → sahiplik filtresini kaldır (tüm finance alarmları)
   Dönüş: silinecek alarm id listesi (saf; IO yok). */
function pickAlarms(alerts, opts) {
  const o = opts || {};
  const ids = Array.isArray(o.ids) ? o.ids.map((x) => String(x || '')).filter(Boolean) : [];
  const sid = String(o.sid || '');
  const symbol = String(o.symbol || '').toUpperCase();
  const all = !!o.all;
  const out = [];
  for (const a of Array.isArray(alerts) ? alerts : []) {
    if (!a || !a.id) continue;
    if (ids.length) {
      if (ids.includes(String(a.id))) out.push(String(a.id));
      continue;
    }
    if (symbol && String(a.symbol || '').toUpperCase() !== symbol) continue;
    if (all) {
      out.push(String(a.id));
      continue;
    }
    /* sid varsa YALNIZ kendi alarmları; sid yoksa (işçi oturumu) sahipsizler */
    const owner = String(a.sid || '');
    if (sid ? owner === sid : !owner) out.push(String(a.id));
  }
  return out;
}

/* ---- trade saatleri (makinenin YEREL saati) ----
   th: { on, start:'HH:MM', end:'HH:MM' }. on değilse 7/24 açık (true).
   Açıkken yalnız [start,end) aralığında true döner; gece aralığı desteklenir
   (ör. 22:00 → 06:00). start === end → 24 saat. Saf; IO yok. */
function parseHM(v, defMin) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v || '').trim());
  if (!m) return defMin;
  return Number(m[1]) * 60 + Number(m[2]);
}
function tradeHoursOpen(th, now) {
  if (!th || !th.on) return true;
  const s = parseHM(th.start, 9 * 60);
  const e = parseHM(th.end, 22 * 60);
  if (s === e) return true;
  const d = now instanceof Date ? now : new Date(Number(now) || Date.now());
  const cur = d.getHours() * 60 + d.getMinutes();
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/* ---- bekleyen emir (pending) → pozisyon eşleştirme ----
   Watchdog turu emir listesini karşılaştırır: listeden DÜŞEN emir için aynı
   turda YENİ açılan (ya da netting hesapta hacmi artan) eşleşen bir pozisyon
   varsa emir AKTİFLEŞTİ (tetiklendi); eşleşme yoksa İPTAL/süresi doldu.
   Saf karar katmanı: IO ve ajan uyarısı main süreçte yapılır. */

const ORDER_TYPE_LABELS = {
  0: 'BUY LIMIT',
  1: 'SELL LIMIT',
  2: 'BUY STOP',
  3: 'SELL STOP',
  4: 'BUY STOP LIMIT',
  5: 'SELL STOP LIMIT',
};

/* MT5 emir tipleri: çift = alış, tek = satış */
function orderSide(o) {
  return Number(o && o.type) % 2 === 1 ? 'sell' : 'buy';
}

function orderTypeLabel(o) {
  const n = Number(o && o.type);
  return ORDER_TYPE_LABELS[n] || 'TIP ' + (isFinite(n) ? n : '?');
}

function orderVolume(o) {
  return num(o && (o.volume_current != null ? o.volume_current : o.volume_initial != null ? o.volume_initial : o.volume), 0);
}

/* goneOrders: önceki turda var olup şimdi listede OLMAYAN emirler
   freshPositions: bu tur yeni açılan / hacmi artan pozisyonlar
   Dönüş: { activated:[{order,position}], canceled:[order] } */
function matchPendingDelta(goneOrders, freshPositions) {
  const out = { activated: [], canceled: [] };
  const free = (Array.isArray(freshPositions) ? freshPositions : []).filter(Boolean);
  for (const o of Array.isArray(goneOrders) ? goneOrders : []) {
    if (!o) continue;
    const side = orderSide(o);
    const symbol = String(o.symbol || '').toUpperCase();
    const ovol = orderVolume(o);
    const oprice = num(o.price_open, 0);
    const omagic = Number(o.magic) || 0;
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < free.length; i++) {
      const p = free[i];
      if (!p) continue;
      if (String(p.symbol || '').toUpperCase() !== symbol) continue;
      if ((num(p.type, -1) === 0 ? 'buy' : 'sell') !== side) continue;
      /* fiyat yakınlığı + hacim yakınlığı; aynı magic KESİN öncelik */
      let score = Math.abs(num(p.price_open, 0) - oprice);
      const pvol = num(p.volume, 0);
      if (ovol > 0 && pvol > 0) score += Math.abs(pvol - ovol) * 0.01;
      if (omagic !== 0 && (Number(p.magic) || 0) === omagic) score -= 1e9;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0) {
      out.activated.push({ order: o, position: free[best] });
      free.splice(best, 1);
    } else {
      out.canceled.push(o);
    }
  }
  return out;
}

module.exports = { plan, roundTo, stepRound, closeKind, parseOrderType, alertCooldownActive, pickAlarms, parseHM, tradeHoursOpen, orderSide, orderTypeLabel, orderVolume, matchPendingDelta };
