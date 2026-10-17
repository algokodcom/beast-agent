'use strict';
/* ---------- kalıcı performans hafızası + karar günlüğü ----------
   Amaç: sabit (ezbere) kurallar yerine gerçekleşen veriden öğrenen bir katman.
   Kapanan her işlem R cinsinden normalize edilerek saklanır; böylece sembol,
   lot büyüklüğü ve para birimi fark etmeksizin karşılaştırılabilir olur.
   Yapay zekanın pozisyon üzerindeki kararları da kaydedilir; "AI mı kapattı,
   SL mi devirdi" karşılaştırması yapılarak karar kalitesi ÖLÇÜLÜR. */
const fs = require('fs');
const path = require('path');

const MAX_TRADES = 3000;
const MAX_ACTIONS = 4000;

let FILE = '';
let db = null;

function emptyDb() {
  return { trades: [], actions: [] };
}

function num(v, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def === undefined ? 0 : def;
  return n;
}

function optNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dayKey(ts) {
  const d = new Date(Number(ts) * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
}

function str(v, max) {
  return String(v == null ? '' : v).slice(0, max || 40);
}

function normTrade(t) {
  if (!t || typeof t !== 'object') return null;
  const ts = num(t.ts, 0);
  if (!(ts > 0)) return null;
  const sideIn = String(t.side == null ? '' : t.side).toLowerCase();
  return {
    ts,
    day: dayKey(ts),
    sym: str(t.sym || t.symbol, 32).toUpperCase(),
    tf: str(t.tf, 8).toUpperCase(),
    side: (sideIn === 'short' || sideIn === 'sell' || num(t.side, 0) === 1) ? 'short' : 'long',
    r: optNum(t.r),
    net: num(t.net != null ? t.net : t.profit),
    grade: str(t.grade, 4),
    p: Math.max(0, num(t.p)),
    rr: Math.max(0, num(t.rr)),
    exit: str(t.exit != null ? t.exit : t.reason, 16),
    ticket: str(t.ticket != null ? t.ticket : t.position_id, 24),
    mins: Math.max(0, num(t.mins)),
  };
}

function normAction(a) {
  if (!a || typeof a !== 'object') return null;
  const ts = num(a.ts, 0);
  if (!(ts > 0)) return null;
  return {
    ts,
    day: dayKey(ts),
    kind: str(a.kind, 20).toLowerCase(),      /* close | partial | be | trail | sltp | open | tp */
    src: str(a.src || 'ai', 10).toLowerCase(),/* ai | user | auto | typesafe */
    sym: str(a.sym || a.symbol, 32).toUpperCase(),
    tf: str(a.tf, 8).toUpperCase(),
    ticket: str(a.ticket, 24),
    rAt: optNum(a.rAt),                        /* karar anındaki R */
    netAt: num(a.netAt),                       /* karar anındaki para K/Z */
    blocked: a.blocked === true,               /* koruma katmanı reddetti mi */
    why: str(a.why, 80),
  };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyDb();
    return {
      trades: Array.isArray(raw.trades) ? raw.trades.map(normTrade).filter(Boolean).slice(-MAX_TRADES) : [],
      actions: Array.isArray(raw.actions) ? raw.actions.map(normAction).filter(Boolean).slice(-MAX_ACTIONS) : [],
    };
  } catch {}
  return emptyDb();
}

function save() {
  if (!FILE) return;
  try {
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('journal save hata:', (e && e.message) || e);
  }
}

function init(file) {
  FILE = file;
  if (!FILE) return;
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); } catch {}
  db = load();
}

/* ---------------- dışa açılan API ---------------- */

function appendTrade(t) {
  const rec = normTrade(t);
  if (!rec) return { ok: false, error: 'gecersiz islem kaydi' };
  if (!db) db = emptyDb();
  db.trades.push(rec);
  if (db.trades.length > MAX_TRADES) db.trades.splice(0, db.trades.length - MAX_TRADES);
  save();
  return { ok: true, n: db.trades.length };
}

function appendAction(a) {
  const rec = normAction(a);
  if (!rec) return { ok: false, error: 'gecersiz karar kaydi' };
  if (!db) db = emptyDb();
  db.actions.push(rec);
  if (db.actions.length > MAX_ACTIONS) db.actions.splice(0, db.actions.length - MAX_ACTIONS);
  save();
  return { ok: true, n: db.actions.length };
}

/* Not: aynı pozisyonun parçalı kapanışları AYRI kayıt olarak yazılır (her biri
   kendi realize R'sini taşır); tekilleştirme journalSyncClosed içindeki
   "seen" anahtarıyla yapılır. Tekilleştirme burada yapılırsa parçalı kapanışlar
   ya kaybolur ya da R'lar toplanıp şişer. */

function getAll() {
  if (!db) db = emptyDb();
  return { trades: db.trades.slice(), actions: db.actions.slice() };
}

function clear() {
  db = emptyDb();
  save();
  return { ok: true };
}

/* ---------------- istatistik ---------------- */

function agg(rows) {
  let win = 0, loss = 0, gw = 0, gl = 0, sumR = 0, nR = 0, sumNet = 0;
  for (const r of rows) {
    sumNet += r.net;
    if (r.net > 0) { win++; gw += r.net; }
    else if (r.net < 0) { loss++; gl += -r.net; }
    if (r.r != null && Number.isFinite(r.r)) { sumR += r.r; nR++; }
  }
  const n = rows.length;
  const avgWin = win > 0 ? gw / win : 0;
  const avgLoss = loss > 0 ? gl / loss : 0;
  return {
    n, win, loss,
    wr: n > 0 ? win / n : 0,
    avgWin, avgLoss,
    pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
    pBe: avgWin > 0 && avgLoss > 0 ? avgLoss / (avgWin + avgLoss) : 0,
    sumNet: Math.round(sumNet * 100) / 100,
    nR, sumR,
    avgR: nR > 0 ? sumR / nR : 0,
  };
}

/* serileştirilmiş hâlden JSON güvenli değer üret (Infinity -> null) */
function jnum(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}

function jagg(a) {
  return {
    n: a.n, win: a.win, loss: a.loss,
    wr: jnum(a.wr), pf: jnum(a.pf), pBe: jnum(a.pBe),
    avgWin: jnum(a.avgWin), avgLoss: jnum(a.avgLoss),
    avgR: jnum(a.avgR), sumR: jnum(a.sumR), nR: a.nR, sumNet: jnum(a.sumNet),
  };
}

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r) || '?';
    let arr = m.get(k);
    if (!arr) { arr = []; m.set(k, arr); }
    arr.push(r);
  }
  return m;
}

function inWindow(rows, days, nowSec) {
  if (!(days > 0)) return rows;
  const from = nowSec - days * 86400;
  return rows.filter((r) => r.ts >= from);
}

function streaks(rows) {
  /* en yeni eskiye sırala; ardışık kayıp serisini say */
  const s = rows.slice().sort((a, b) => b.ts - a.ts);
  let cur = 0;
  for (const r of s) { if (r.net < 0) cur++; else break; }
  let worst = 0, run = 0;
  for (const r of s) { if (r.net < 0) { run++; if (run > worst) worst = run; } else run = 0; }
  return { currentLoss: cur, worstLoss: worst };
}

/* p kovası kalibrasyonu: AI'nin verdiği olasılık gerçekte tutuyor mu? */
function calibration(rows) {
  const buckets = [
    { key: '0-40', lo: 0, hi: 0.4 },
    { key: '40-50', lo: 0.4, hi: 0.5 },
    { key: '50-60', lo: 0.5, hi: 0.6 },
    { key: '60-70', lo: 0.6, hi: 0.7 },
    { key: '70-100', lo: 0.7, hi: 1.01 },
  ];
  const out = [];
  for (const b of buckets) {
    const sel = rows.filter((r) => r.p >= b.lo && r.p < b.hi);
    if (!sel.length) continue;
    const a = agg(sel);
    out.push({ bucket: b.key, n: a.n, wr: jnum(a.wr), avgR: jnum(a.avgR), pf: jnum(a.pf) });
  }
  return out;
}

/* Yapay zekanın pozisyon müdahalelerinin etkinliği.
   Kullanıcının şikâyet ettiği "zararda erken kapatma" davranışının sayısı
   burada ölçülür: blockedPartialLoss > 0 ise koruma katmanı devreye girmiştir. */
function decisionQuality(rows, actions) {
  const closeActions = actions.filter((a) => a.kind === 'close' && !a.blocked);
  const aiCloses = closeActions.filter((a) => a.src === 'ai' || a.src === 'typesafe');
  const byTicket = new Map();
  for (const a of aiCloses) if (a.ticket) byTicket.set(a.sym + '#' + a.ticket, a);

  /* aynı pozisyon birden çok parçada kapanmış olabilir → ticket başına R toplanır,
     aksi halde kısmi kapanışlar birden çok "işlem" gibi sayılırdı */
  const perTicket = new Map();
  for (const t of rows) {
    const k = t.sym + '#' + t.ticket;
    let e = perTicket.get(k);
    if (!e) { e = { key: k, r: 0, hasR: false }; perTicket.set(k, e); }
    if (t.r != null) { e.r += t.r; e.hasR = true; }
  }

  /* AI'ın erken kapattığı işlemlerin GERÇEKLEŞEN sonucu (SL devretti mi diye bak) */
  let aiR = 0, aiRN = 0, aiClosedInLoss = 0;
  const matchedKeys = new Set();
  for (const e of perTicket.values()) {
    const a = byTicket.get(e.key);
    if (!a) continue;
    matchedKeys.add(e.key);
    if (a.rAt != null && a.rAt < 0) aiClosedInLoss++;
    if (e.hasR) { aiR += e.r; aiRN++; }
  }
  /* AI olmadan kapanmış (SL/TP) işlemler karşılaştırma tabanı */
  let refR = 0, refRN = 0;
  for (const e of perTicket.values()) {
    if (matchedKeys.has(e.key)) continue;
    if (e.hasR) { refR += e.r; refRN++; }
  }
  const aiAvgR = aiRN ? aiR / aiRN : null;
  const refAvgR = refRN ? refR / refRN : null;

  const count = (fn) => actions.filter(fn).length;

  return {
    aiCloseN: aiCloses.length,
    aiCloseInLoss: aiClosedInLoss,
    aiCloseAvgR: jnum(aiAvgR),
    aiCloseR: aiRN,
    refAvgR: jnum(refAvgR),
    refR: refRN,
    /* AI erken kapatınca ortalama sonuç, kendi halinde bırakılsaydıkinden
       daha kötüyse bu sayı negatiftir → "erken kapatma değer yaratmıyor" */
    earlyCloseEdge: aiAvgR != null && refAvgR != null ? jnum(aiAvgR - refAvgR) : null,
    partialInLoss: count((a) => a.kind === 'partial' && !a.blocked && a.rAt != null && a.rAt < 0),
    slWiden: count((a) => (a.kind === 'sltp' || a.kind === 'be') && !a.blocked && a.rAt != null && a.rAt < 0 && /genis|widen|geri/i.test(a.why || '')),
    beApplied: count((a) => a.kind === 'be' && !a.blocked),
    trailOn: count((a) => a.kind === 'trail' && !a.blocked),
    blocked: actions.filter((a) => a.blocked).length,
    blockedByKind: {
      partial: count((a) => a.blocked && a.kind === 'partial'),
      close: count((a) => a.blocked && a.kind === 'close'),
      sltp: count((a) => a.blocked && a.kind === 'sltp'),
    },
  };
}

function stats(q) {
  if (!db) db = emptyDb();
  const query = q && typeof q === 'object' ? q : {};
  const now = num(query.now, Math.floor(Date.now() / 1000)) || Math.floor(Date.now() / 1000);
  const days = num(query.days, 30) > 0 ? num(query.days, 30) : 30;
  const sym = query.symbol ? String(query.symbol).toUpperCase() : '';
  const all = db.trades;
  const winRows = inWindow(all, days, now).filter((r) => !sym || r.sym === sym);
  const actions = inWindow(db.actions, days, now).filter((a) => !sym || !a.sym || a.sym === sym);

  const todayKey = dayKey(now);
  const today = all.filter((r) => r.day === todayKey && (!sym || r.sym === sym));

  const w7 = inWindow(all, 7, now).filter((r) => !sym || r.sym === sym);
  const w30 = inWindow(all, 30, now).filter((r) => !sym || r.sym === sym);

  const bySym = [...groupBy(winRows, (r) => r.sym).entries()]
    .map(([k, rows]) => Object.assign({ key: k }, jagg(agg(rows))))
    .filter((e) => e.n > 0)
    .sort((a, b) => b.n - a.n);

  const byTf = [...groupBy(winRows, (r) => r.tf).entries()]
    .map(([k, rows]) => Object.assign({ key: k }, jagg(agg(rows))))
    .filter((e) => e.n > 0)
    .sort((a, b) => b.n - a.n);

  const byGrade = [...groupBy(winRows.filter((r) => r.grade), (r) => r.grade).entries()]
    .map(([k, rows]) => Object.assign({ key: k }, jagg(agg(rows))))
    .sort((a, b) => b.n - a.n);

  const byExit = [...groupBy(winRows, (r) => r.exit || '-').entries()]
    .map(([k, rows]) => Object.assign({ key: k }, jagg(agg(rows))))
    .sort((a, b) => b.n - a.n);

  /* R dağılımı: kazanç/kayıp ayrımı ve uç değerler */
  const rRows = winRows.filter((r) => r.r != null);
  const rSorted = rRows.map((r) => r.r).sort((a, b) => a - b);
  const pct = (q2) => (rSorted.length ? rSorted[Math.min(rSorted.length - 1, Math.max(0, Math.round((rSorted.length - 1) * q2)))] : null);
  const best = rSorted.length ? rSorted[rSorted.length - 1] : null;
  const worst = rSorted.length ? rSorted[0] : null;
  const top2 = rSorted.slice(-2).reduce((s, v) => s + v, 0);
  const grossGain = rSorted.filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const grossLoss = rSorted.filter((v) => v < 0).reduce((s, v) => s - v, 0);
  const totalR = rSorted.reduce((s, v) => s + v, 0);
  /* "büyük kazançları kırpmadan bırakmak" kâr faktörünü sınırlar; pay-off verisi */
  const edgeOfLargest = grossGain > 0 ? Math.max(0, top2 - totalR) : 0;

  return {
    ok: true,
    days,
    total: all.length,
    today: jagg(agg(today)),
    w7: jagg(agg(w7)),
    w30: jagg(agg(w30)),
    all: jagg(agg(sym ? all.filter((r) => r.sym === sym) : all)),
    streaks: streaks(sym ? all.filter((r) => r.sym === sym) : all),
    bySym: bySym.slice(0, 12),
    byTf: byTf.slice(0, 12),
    byGrade,
    byExit: byExit.slice(0, 12),
    calibration: calibration(winRows),
    recent: winRows.slice(-12).reverse().map((r) => ({
      day: r.day, sym: r.sym, tf: r.tf, side: r.side,
      r: jnum(r.r), net: jnum(r.net), grade: r.grade, exit: r.exit,
    })),
    rDist: {
      n: rSorted.length,
      p10: jnum(pct(0.1)), p25: jnum(pct(0.25)), median: jnum(pct(0.5)),
      p75: jnum(pct(0.75)), p90: jnum(pct(0.9)),
      best: jnum(best), worst: jnum(worst),
      totalR: jnum(totalR),
      pfR: grossLoss > 0 ? jnum(grossGain / grossLoss) : null,
      edgeOfLargest: jnum(edgeOfLargest),
    },
    decisions: decisionQuality(winRows, actions),
  };
}

/* prompt'a gömülecek kompakt özet (token tasarrufu için kısa tutulur) */
function summaryLines(q) {
  const s = stats(q);
  const out = [];
  const pctTxt = (v) => (v == null ? '—' : '%' + Math.round(v * 100));
  const rTxt = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(2) + 'R');

  if (s.total === 0) {
    out.push('Henüz kalıcı işlem geçmişi yok. İstatistik yapamazsın; tahminlerini "tahmin" diye işaretle ve örneklem büyüyünce kalibre ol.');
    return { ok: true, text: out.join('\n'), stats: s };
  }

  const w = s.days >= 30 ? s.w30 : (s.days >= 7 ? s.w7 : s.all);
  out.push('HAFIZA · son ' + (s.days >= 30 ? '30 gün' : (s.days >= 7 ? '7 gün' : 'tüm zaman')) +
    ' · ' + w.n + ' işlem · isabet ' + pctTxt(w.wr) + ' · ort sonuç ' + rTxt(w.avgR) +
    ' · toplam ' + rTxt(w.sumR) + ' · kâr faktörü ' + (w.pf == null ? '—' : w.pf.toFixed(2)) +
    ' · başabaş isabet ' + pctTxt(w.pBe));

  if (s.today.n) {
    out.push('  Bugün: ' + s.today.n + ' işlem · net ' + (s.today.sumNet >= 0 ? '+' : '') + s.today.sumNet + ' · ort ' + rTxt(s.today.avgR));
  }
  if (s.streaks.currentLoss >= 2) {
    out.push('  ⚠ Üst üste ' + s.streaks.currentLoss + ' kayıp (en kötü seri ' + s.streaks.worstLoss + '). Seri kayıpta riski düşür, sıklığı azalt.');
  }
  if (s.byTf.length >= 2) {
    out.push('  TF performansı: ' + s.byTf.map((e) => e.key + ' ' + e.n + ' işlem · isabet ' + pctTxt(e.wr) + ' · ort ' + rTxt(e.avgR)).join(' | '));
  }
  if (s.byGrade.length >= 2) {
    out.push('  Not (grade) kalibrasyonu: ' + s.byGrade.map((e) => e.key + ' ' + e.n + ' işlem · isabet ' + pctTxt(e.wr) + ' · ort ' + rTxt(e.avgR)).join(' | '));
  }
  if (s.byExit.length >= 2) {
    out.push('  Çıkış biçimi: ' + s.byExit.map((e) => (e.key === '-' ? 'bilinmiyor' : e.key) + ' ' + e.n + ' · ort ' + rTxt(e.avgR)).join(' | '));
  }
  if (s.calibration.length >= 2) {
    out.push('  p kalibrasyonu (verdiğin olasılık → gerçekleşen): ' + s.calibration
      .map((c) => '%' + c.bucket + '→' + pctTxt(c.wr) + ' (n=' + c.n + ')').join(' | '));
  }
  if (s.rDist.n >= 4) {
    out.push('  R dağılımı: medyan ' + rTxt(s.rDist.median) + ' · en iyi ' + rTxt(s.rDist.best) + ' · en kötü ' + rTxt(s.rDist.worst) +
      ' · en büyük 2 işlemin toplam R içindeki payı ' + pctTxt(s.rDist.edgeOfLargest / Math.max(0.0001, Math.abs(s.rDist.totalR))));
  }

  const d = s.decisions;
  if (d.aiCloseN > 0) {
    let line = '  Pozisyon kararı: AI ' + d.aiCloseN + ' pozisyonu erken kapattı';
    if (d.aiCloseAvgR != null) line += ' · o işlemlerin gerçekleşen sonucu ' + rTxt(d.aiCloseAvgR);
    if (d.refAvgR != null) line += ' · kendi halinde bırakılsa ' + rTxt(d.refAvgR);
    if (d.earlyCloseEdge != null) {
      line += d.earlyCloseEdge < 0
        ? ' ⇒ ERKEN KAPATMA DEĞER YARATMIYOR (' + rTxt(d.earlyCloseEdge) + ' fark), zararda erken kapatma'
        : ' ⇒ erken kapatma faydalı (' + rTxt(d.earlyCloseEdge) + ' fark)';
    }
    out.push(line);
  }
  if (d.partialInLoss > 0) {
    out.push('  ⚠ Zararda kısmi kapatma ' + d.partialInLoss + ' kez yapılmış — bu disiplin ihlalidir, tekrarlama.');
  }
  if (d.blocked > 0) {
    out.push('  Koruma katmanı ' + d.blocked + ' kararı reddetti (kısmi:' + d.blockedByKind.partial + ' · kapat:' + d.blockedByKind.close + ' · SL/TP:' + d.blockedByKind.sltp + ').');
  }
  return { ok: true, text: out.join('\n'), stats: s };
}

module.exports = { init, appendTrade, appendAction, getAll, clear, stats, summaryLines };
