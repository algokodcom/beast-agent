'use strict';

/* ---------- TYPESAFE KARAR KALİBRASYONU (saf matematik) ----------
   main süreç tskarar.json'daki kapanmış TypeSafe kararlarını buraya verir;
   burada ampirik kazanç oranlarından EYLEM EŞİĞİ, RİSK ÇARPANI ve KURAL
   istatistikleri hesaplanır. Saf fonksiyonlar — test edilebilir, yan etkisiz. */

const DEFAULT_TH = { action: 0.6, margin: 0.12, confirm: 0.55, exit: 0.62 };

const BANDS = [
  { key: '0.50-0.60', min: 0.5, max: 0.6 },
  { key: '0.60-0.70', min: 0.6, max: 0.7 },
  { key: '0.70-0.80', min: 0.7, max: 0.8 },
  { key: '0.80-1.00', min: 0.8, max: 1.01 },
];

const RULES = [
  { key: 'trend_uyumlu', label: 'trend uyumlu', match: (x) => x.emaAlign === 1 },
  { key: 'trend_ters', label: 'trend ters', match: (x) => x.emaAlign === 0 },
  { key: 'londra', label: 'Londra (07-12)', match: (x) => x.hour >= 7 && x.hour < 12 },
  { key: 'newyork', label: 'New York (12-18)', match: (x) => x.hour >= 12 && x.hour < 18 },
  { key: 'asya', label: 'Asya (00-07)', match: (x) => x.hour < 7 },
  { key: 'p_070', label: 'p≥0.70', match: (x) => Number(x.p) >= 0.7 },
  { key: 'rsi_asiri', label: 'RSI aşırı (70+/30-)', match: (x) => x.rsi != null && (x.rsi > 70 || x.rsi < 30) },
];

function bandOf(p) {
  const v = Number(p) || 0;
  const b = BANDS.find((x) => v >= x.min && v < x.max);
  return b ? b.key : BANDS[0].key;
}

function closedRows(decisions, symbol) {
  const sym = String(symbol || '').toUpperCase();
  return (Array.isArray(decisions) ? decisions : []).filter((x) => x && x.closedAt && String(x.symbol || '').toUpperCase() === sym);
}

/* KALİBRASYON: tf verilirse ve o periyotta ≥8 kapalı karar varsa periyoda
   özel; yoksa sembol geneli. Eşik ancak ≥8 kapalı karar birikince oynar. */
function calibration(decisions, symbol, tf) {
  let rows = closedRows(decisions, symbol);
  let tfScoped = false;
  if (tf) {
    const tRows = rows.filter((x) => x.tf === tf);
    if (tRows.length >= 8) {
      rows = tRows;
      tfScoped = true;
    }
  }
  const bands = {};
  let n = 0;
  let wins = 0;
  let net = 0;
  for (const x of rows) {
    const v = Number(x.net) || 0;
    n += 1;
    net += v;
    if (v >= 0) wins += 1;
    const key = bandOf(x.p);
    if (!bands[key]) bands[key] = { n: 0, wins: 0, net: 0 };
    bands[key].n += 1;
    bands[key].net += v;
    if (v >= 0) bands[key].wins += 1;
  }
  /* EŞİK: kazanç oranı ≥ %50 olan en düşük p bandının alt sınırı; yeterli
     veri yoksa varsayılan; aralık 0.55-0.75. */
  let action = DEFAULT_TH.action;
  for (const band of BANDS) {
    const b = bands[band.key];
    if (!b || b.n < 5) continue;
    if (b.wins / b.n >= 0.5) {
      action = band.min;
      break;
    }
  }
  if (n < 8) action = DEFAULT_TH.action;
  action = Math.max(0.55, Math.min(0.75, action));
  /* RİSK ÇARPANI: üst üste kayıpta küçül, istikrarlı kazançta büyü */
  const last3 = rows.slice(-3);
  let riskMult = 1;
  if (last3.length >= 2 && last3.every((x) => (Number(x.net) || 0) < 0)) riskMult = 0.6;
  else if (n >= 8 && wins / n >= 0.6) riskMult = 1.2;
  riskMult = Math.max(0.5, Math.min(1.3, riskMult));
  return { n, wins, net: Math.round(net * 100) / 100, bands, action, riskMult, tfScoped };
}

/* KURAL MADENCİLİĞİ: hangi koşullarda kazanıyoruz (en az 4 örnek) */
function rules(decisions, symbol) {
  const rows = closedRows(decisions, symbol);
  const out = [];
  for (const r of RULES) {
    const set = rows.filter((x) => r.match(x));
    if (set.length < 4) continue;
    const wins = set.filter((x) => (Number(x.net) || 0) >= 0).length;
    out.push({
      key: r.key,
      label: r.label,
      n: set.length,
      wr: wins / set.length,
      net: Math.round(set.reduce((a, x) => a + (Number(x.net) || 0), 0) * 100) / 100,
    });
  }
  out.sort((a, b) => b.wr - a.wr || b.n - a.n);
  return out;
}

function rulesText(ruleRows) {
  const list = Array.isArray(ruleRows) ? ruleRows : [];
  if (!list.length) return '';
  const good = list.filter((r) => r.wr >= 0.55).slice(0, 2).map((r) => `${r.label} %${Math.round(r.wr * 100)} (n=${r.n})`);
  const bad = list.filter((r) => r.wr < 0.45).slice(-1).map((r) => `${r.label} %${Math.round(r.wr * 100)} (n=${r.n}) → kaçın`);
  const parts = [];
  if (good.length) parts.push('çalışan: ' + good.join(' · '));
  if (bad.length) parts.push('zayıf: ' + bad.join(' · '));
  return parts.join(' — ');
}

/* Digest satırı: kalibrasyon + kurallar (LLM'li ajanlar da görür) */
function calText(decisions, symbol, tf) {
  const c = calibration(decisions, symbol, tf);
  if (!c.n) return '';
  const wr = Math.round((c.wins / c.n) * 100);
  const bandTxt = Object.entries(c.bands)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([k, b]) => `${k}: %${Math.round((b.wins / b.n) * 100)} (n=${b.n})`)
    .slice(0, 3)
    .join(' · ');
  const f = calibration(decisions, symbol, null);
  const rt = rulesText(rules(decisions, symbol));
  return (
    `${symbol}: ${c.n} kapalı karar · %${wr} kazanç · risk ×${f.riskMult}` +
    (bandTxt ? ` · band ${bandTxt}` : '') +
    (rt ? ` · kural — ${rt}` : '')
  );
}

/* Tur state'i için kompakt satır (TypeSafe'e giren kalibrasyon) */
function calState(decisions, symbol, tf) {
  const c = calibration(decisions, symbol, tf);
  if (!c.n) return `${symbol}: kalibrasyon verisi yok (henüz kapanan TypeSafe işlemi yok)`;
  const wr = Math.round((c.wins / c.n) * 100);
  const rt = rulesText(rules(decisions, symbol));
  return `${symbol}: ${c.n} kapalı karar · %${wr} kazanç · eylem eşiği p≥${c.action.toFixed(2)} · risk ×${c.riskMult} (tf=${tf || '?'})` + (rt ? ` · ${rt}` : '');
}

module.exports = { DEFAULT_TH, BANDS, RULES, bandOf, calibration, rules, rulesText, calText, calState };
