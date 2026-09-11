'use strict';
// MT5 POZISYON BAZLI GECMIS — açılış+kapanış tek satırda birleşik.
// stdin: JSON args · stdout: JSON sonuç (SADECE JSON yaz!)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/* TAŞINABİLİR YOL ÇÖZÜMÜ: Beast gömülü python → sistem python'ları → PATH.
   Köprü dosyası %APPDATA%\beast\finance\mt5_bridge.py'den (veya BEAST_FINANCE_DIR)
   okunur; ortam değişkenleriyle geçersiz kılınabilir. */
function resolvePython() {
  const cands = [];
  if (process.env.BEAST_PYTHON) cands.push({ exe: String(process.env.BEAST_PYTHON), args: [] });
  if (process.env.APPDATA) cands.push({ exe: path.join(process.env.APPDATA, 'beast', 'py', 'python.exe'), args: [] });
  for (const v of ['314', '313', '312', '311', '310']) cands.push({ exe: 'C:\\Python' + v + '\\python.exe', args: [] });
  cands.push({ exe: 'python', args: [] }, { exe: 'py', args: ['-3'] });
  for (const c of cands) {
    if (c.exe === 'python' || c.exe === 'py') return c;
    try { if (fs.existsSync(c.exe)) return c; } catch (e) {}
  }
  return { exe: 'python', args: [] };
}
function resolveBridge() {
  const cands = [];
  if (process.env.BEAST_BRIDGE) cands.push(String(process.env.BEAST_BRIDGE));
  if (process.env.BEAST_FINANCE_DIR) cands.push(path.join(String(process.env.BEAST_FINANCE_DIR), 'mt5_bridge.py'));
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'beast', 'finance', 'mt5_bridge.py'));
  for (const p of cands) { try { if (p && fs.existsSync(p)) return p; } catch (e) {} }
  return cands[0] || '';
}
const PYSPEC = resolvePython();
const PY = PYSPEC.exe;
const PY_ARGS = PYSPEC.args;
const BRIDGE = resolveBridge();

const TIMEOUT = 35000;

function call(requests) {
  return new Promise((resolve) => {
    let py;
    try { py = spawn(PY, [...PY_ARGS, BRIDGE], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, error: 'python baslatilamadi: ' + e.message }); }
    const results = {};
    let buf = '';
    let errTail = '';
    let settled = false;
    const finish = (obj) => { if (!settled) { settled = true; clearTimeout(timer); try { py.kill(); } catch (e) {} resolve(obj); } };
    const timer = setTimeout(() => finish({ ok: false, error: 'zaman asimi: MT5 terminali acik ve yanit veriyor mu?' }), TIMEOUT);
    py.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let o = null;
        try { o = JSON.parse(line); } catch (e) { continue; }
        if (o && o.event) continue;
        if (o && typeof o.id === 'number' && Object.prototype.hasOwnProperty.call(o, 'ok')) {
          results[o.id] = o;
          if (Object.keys(results).length >= requests.length) {
            const arr = requests.map((_, k) => results[k + 1]);
            finish(arr.length === 1 ? arr[0] : { ok: true, results: arr });
          }
        }
      }
    });
    py.stderr.on('data', (d) => { errTail = (errTail + d.toString('utf8')).slice(-800); });
    py.on('error', (e) => finish({ ok: false, error: 'python baslatilamadi: ' + e.message }));
    py.on('close', (code) => { if (Object.keys(results).length < requests.length) finish({ ok: false, error: 'bridge erken cikti code=' + code + ' ' + errTail }); });
    requests.forEach((r, k) => py.stdin.write(JSON.stringify({ id: k + 1, method: r.method, params: r.params || {} }) + '\n'));
    py.stdin.end();
  });
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (t) => {
  if (!t) return '';
  const d = new Date(Number(t) * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};

(async function main() {
  let args = {};
  try { args = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (e) {}
  let days = Number(args.days || 1);
  if (!(days > 0)) days = 1;
  days = Math.min(days, 90);
  const r = await call([{ method: 'deals', params: { days: days } }]);
  if (!r.ok || !r.data) return console.log(JSON.stringify({ ok: false, error: r.error || 'gecmis alinamadi' }));

  const deals = r.data.deals || [];
  if (!deals.length) return console.log(JSON.stringify({ ok: true, count: 0, positions: [], summary: { net: 0, wins: 0, losses: 0 } }));

  // Ayni position_id -> tek pozisyon. INOUT (entry=2) deal'ler kendi basina pozisyon.
  const byPos = new Map();
  for (const dl of deals) {
    const pid = (dl.position_id != null && dl.position_id !== 0) ? dl.position_id : dl.ticket;
    if (!byPos.has(pid)) byPos.set(pid, []);
    byPos.get(pid).push(dl);
  }

  const positions = [];
  for (const [pid, arr] of byPos) {
    arr.sort((a, b) => (a.time || 0) - (b.time || 0));
    const first = arr[0];
    const entryDeal = arr.find((x) => x.entry === 0) || first;
    const exitDeal = arr.find((x) => x.entry === 1) || arr[arr.length - 1];
    let profit = 0, commission = 0, swap = 0;
    for (const x of arr) { profit += Number(x.profit) || 0; commission += Number(x.commission) || 0; swap += Number(x.swap) || 0; }
    positions.push({
      position_id: pid,
      symbol: first.symbol,
      side: Number(first.type) === 0 ? 'buy' : 'sell',
      volume: r2(first.volume),
      open_price: entryDeal.price,
      open_time: entryDeal.time,
      open_time_str: fmt(entryDeal.time),
      close_price: exitDeal.price,
      close_time: exitDeal.time,
      close_time_str: fmt(exitDeal.time),
      profit: r2(profit),
      commission: r2(commission),
      swap: r2(swap),
      net: r2(profit + commission + swap),
      deal_count: arr.length
    });
  }
  positions.sort((a, b) => (b.close_time || 0) - (a.close_time || 0));

  let net = 0, wins = 0, losses = 0;
  for (const p of positions) { net += p.net; if (p.net > 0) wins++; else if (p.net < 0) losses++; }

  console.log(JSON.stringify({
    ok: true,
    count: positions.length,
    positions: positions,
    summary: { net: r2(net), wins: wins, losses: losses }
  }));
})();

/* PATCH 2026-09-10b: electron app-mode cocuk prosesi kapanmiyordu (90sn timeout).
   stdout'un boruya bosalmasi icin kisa bekleme, sonra zorla cik. */
setTimeout(() => process.exit(0), 1500);
