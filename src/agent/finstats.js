'use strict';

/* Beast Finance — muhasebe matematiği (saf; köprü/IO yok).
   MT5 deals listesinden işlem istatistiği, equity serisinden drawdown ve
   haftalık rapor metni üretir. main süreç bu çıktıları dosyaya/panoya taşır. */

function num(v, def) {
  const n = Number(v);
  return isFinite(n) ? n : def;
}

function dayKey(ms) {
  const d = new Date(Number(ms) || 0);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function isOut(entry) {
  return entry === 1 || entry === '1' || String(entry) === '1';
}

function once(v, d) {
  const n = Number(v);
  return isFinite(n) ? n : d;
}

/* deals: [{position_id, entry, profit, swap, commission, symbol, time, volume}] */
function summarizeDeals(deals, opts) {
  const rows = Array.isArray(deals) ? deals : [];
  const since = opts && Number.isFinite(Number(opts.sinceMs)) ? Number(opts.sinceMs) : 0;
  const groups = new Map();
  for (const dl of rows) {
    const pid = String(dl.position_id != null ? dl.position_id : dl.ticket != null ? dl.ticket : '');
    if (!pid) continue;
    let g = groups.get(pid);
    if (!g) {
      g = { pid, symbol: String(dl.symbol || ''), net: 0, hasOut: false, openTime: Infinity, closeTime: 0, volume: 0 };
      groups.set(pid, g);
    }
    g.net += once(dl.profit, 0) + once(dl.swap, 0) + once(dl.commission, 0);
    const t = once(dl.time, 0) * (once(dl.time, 0) > 1e12 ? 1 : 1000);
    if (t > 0) {
      if (t < g.openTime) g.openTime = t;
      if (t > g.closeTime) g.closeTime = t;
    }
    if (isOut(dl.entry)) g.hasOut = true;
    if (!g.symbol && dl.symbol) g.symbol = String(dl.symbol);
    g.volume = Math.max(g.volume, once(dl.volume, 0));
  }
  const closed = [...groups.values()].filter((g) => g.hasOut && (!since || g.closeTime >= since));
  const total = closed.length;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let best = 0;
  let worst = 0;
  let bestSymbol = '';
  let worstSymbol = '';
  const bySymbol = {};
  const byDay = {};
  let lastTradeAt = 0;
  for (const g of closed) {
    const n = Math.round(g.net * 100) / 100;
    const k = dayKey(g.closeTime);
    byDay[k] = Math.round(((byDay[k] || 0) + n) * 100) / 100;
    if (!bySymbol[g.symbol]) bySymbol[g.symbol] = { net: 0, trades: 0, wins: 0, losses: 0 };
    const s = bySymbol[g.symbol];
    s.net = Math.round((s.net + n) * 100) / 100;
    s.trades++;
    if (n > 0) {
      wins++;
      s.wins++;
      grossProfit += n;
      if (n > best) {
        best = n;
        bestSymbol = g.symbol;
      }
    } else if (n < 0) {
      losses++;
      s.losses++;
      grossLoss += -n;
      if (n < worst) {
        worst = n;
        worstSymbol = g.symbol;
      }
    } else {
      breakeven++;
    }
    if (g.closeTime > lastTradeAt) lastTradeAt = g.closeTime;
  }
  const netProfit = Math.round((grossProfit - grossLoss) * 100) / 100;
  return {
    trades: total,
    wins,
    losses,
    breakeven,
    winRate: total ? Math.round((wins / total) * 1000) / 10 : 0,
    netProfit,
    grossProfit: Math.round(grossProfit * 100) / 100,
    grossLoss: Math.round(grossLoss * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? null : 0,
    avgWin: wins ? Math.round((grossProfit / wins) * 100) / 100 : 0,
    avgLoss: losses ? Math.round((grossLoss / losses) * 100) / 100 : 0,
    best: Math.round(best * 100) / 100,
    bestSymbol,
    worst: Math.round(worst * 100) / 100,
    worstSymbol,
    bySymbol,
    byDay,
    lastTradeAt: lastTradeAt || 0,
    at: Date.now(),
  };
}

/* points: [{at, equity}] — sırasız gelebilir; zamana göre sıralanır. */
function maxDrawdown(points) {
  const list = (Array.isArray(points) ? points : [])
    .map((p) => ({ at: num(p && p.at, 0), equity: num(p && p.equity, NaN) }))
    .filter((p) => isFinite(p.equity))
    .sort((a, b) => a.at - b.at);
  let peak = -Infinity;
  let peakAt = 0;
  let maxAbs = 0;
  let maxPct = 0;
  let troughAt = 0;
  for (const p of list) {
    if (p.equity > peak) {
      peak = p.equity;
      peakAt = p.at;
    }
    if (peak > 0) {
      const abs = peak - p.equity;
      const pct = (abs / peak) * 100;
      if (abs > maxAbs) {
        maxAbs = abs;
        maxPct = pct;
        troughAt = p.at;
      }
    }
  }
  return {
    maxAbs: Math.round(maxAbs * 100) / 100,
    maxPct: Math.round(maxPct * 100) / 100,
    peakAt,
    troughAt,
    samples: list.length,
  };
}

function money(v, cur) {
  const n = num(v, 0);
  const sign = n > 0 ? '+' : '';
  return sign + n.toFixed(2) + (cur ? ' ' + cur : '');
}

/* Haftalık rapor metni (markdown). review: ajan eleştirisi (opsiyonel). */
function buildWeeklyReport(ctx) {
  const c = ctx || {};
  const st = c.stats || {};
  const cur = (c.account && c.account.currency) || '';
  const L = [];
  const from = dayKey(c.fromTs || Date.now() - 7 * 86400000);
  const to = dayKey(c.toTs || Date.now());
  L.push('# Beast Finance — Haftalık Rapor');
  L.push('');
  L.push('Dönem: **' + from + ' → ' + to + '**');
  L.push('');
  if (c.account) {
    L.push('## Hesap');
    L.push('- Bakiye: **' + num(c.account.balance, 0).toFixed(2) + ' ' + cur + '** · Özkaynak: ' + num(c.account.equity, 0).toFixed(2) + ' ' + cur);
    L.push('- Kaldıraç: 1:' + num(c.account.leverage, 0) + ' · Para birimi: ' + (cur || '?'));
    L.push('');
  }
  L.push('## Performans');
  L.push('| Metrik | Değer |');
  L.push('| --- | --- |');
  L.push('| Kapanan işlem | ' + num(st.trades, 0) + ' |');
  L.push('| Kazanç / Kayıp | ' + num(st.wins, 0) + ' / ' + num(st.losses, 0) + ' |');
  L.push('| Win rate | %' + num(st.winRate, 0) + ' |');
  L.push('| Net K/Z | ' + money(st.netProfit, cur) + ' |');
  L.push('| Profit factor | ' + (st.profitFactor == null ? '∞' : st.profitFactor) + ' |');
  if (c.drawdown) L.push('| Max drawdown | ' + num(c.drawdown.maxAbs, 0).toFixed(2) + ' ' + cur + ' (%' + num(c.drawdown.maxPct, 0) + ') |');
  L.push('');
  const days = Object.entries(st.byDay || {}).sort((a, b) => a[0].localeCompare(b[0])).slice(-7);
  if (days.length) {
    L.push('## Günlük K/Z');
    for (const [d, v] of days) L.push('- ' + d + ': ' + money(v, cur));
    L.push('');
  }
  if (c.mfe && c.mfe.n) {
    L.push('## Kâr Yakalama (MFE/MAE)');
    if (c.mfe.capture != null) {
      L.push('- Kazanan işlemlerde ulaşılan maksimum kârın **%' + c.mfe.capture + '**\'i realize edildi (' + c.mfe.n + ' kapanış ölçüldü).');
    }
    if (c.mfe.avgMaeLoss != null) {
      L.push('- Kaybedenlerde ortalama MAE (en kötü seviye): **-' + c.mfe.avgMaeLoss + '** — SL mesafesi bu veriye göre ayarlanabilir.');
    }
    L.push('');
  }
  const syms = Object.entries(st.bySymbol || {})
    .map(([s, v]) => ({ symbol: s, ...v }))
    .sort((a, b) => b.net - a.net)
    .slice(0, 8);
  if (syms.length) {
    L.push('## Semboller');
    L.push('| Sembol | İşlem | W/L | Net |');
    L.push('| --- | --- | --- | --- |');
    for (const s of syms) L.push('| ' + s.symbol + ' | ' + s.trades + ' | ' + s.wins + '/' + s.losses + ' | ' + money(s.net, cur) + ' |');
    L.push('');
  }
  if (c.positions && c.positions.length) {
    L.push('## Açık Pozisyonlar');
    for (const p of c.positions.slice(0, 15)) {
      L.push('- ' + (p.symbol || '?') + ' ' + (Number(p.type) === 0 ? 'BUY' : 'SELL') + ' ' + num(p.volume, 0) + ' lot @ ' + num(p.price_open, 0) + ' → K/Z ' + money(p.profit, cur));
    }
    L.push('');
  }
  if (Array.isArray(c.journal) && c.journal.length) {
    L.push('## Son İşlem Günlüğü');
    for (const j of c.journal.slice(-15)) {
      const t = new Date(num(j.at, Date.now()));
      const hh = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
      L.push('- ' + hh + ' · ' + String(j.kind || '') + (j.symbol ? ' ' + j.symbol : '') + (j.side ? ' ' + j.side : '') + (j.volume ? ' ' + j.volume : '') + (j.reason ? ' — ' + String(j.reason).slice(0, 160) : ''));
    }
    L.push('');
  }
  if (c.review) {
    L.push('## Ajan Değerlendirmesi');
    L.push(String(c.review).trim());
    L.push('');
  }
  L.push('---');
  L.push('_Beast Finance tarafından otomatik üretildi · ' + new Date().toISOString() + '_');
  return L.join('\n');
}

module.exports = { summarizeDeals, maxDrawdown, buildWeeklyReport, dayKey, money };
