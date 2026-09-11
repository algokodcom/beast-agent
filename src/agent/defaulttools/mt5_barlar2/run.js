'use strict';
/* mt5_barlar2 - KOPRUSUZ OHLC bari.
   Giris (stdin JSON): {"symbol":"GOLD","timeframe":"M1","count":60}
   Cikis (stdout JSON): {"ok":true,"symbol","timeframe","count","bars":[{t,ts,o,h,l,c,v}]}
   Yol: MT5 koprusune DOKUNMAZ; ayri bir python surecinde MetaTrader5 modulunu dogrudan cagirir.
   SALT-OKUNUR: emir / pending / close cagrisi YOK. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_SYMBOL = 'GOLD';
const DEFAULT_TF = 'M1';
const DEFAULT_COUNT = 60;
const TF_ALLOWED = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
const TERMINALS = [
  'C:\\Program Files\\FxPro - MetaTrader 5\\terminal64.exe',
  'C:\\Program Files\\MetaTrader 5\\terminal64.exe',
];

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(obj.ok ? 0 : 1);
}

/* ---------- args: stdin JSON (argv / env yedek) ---------- */
function readArgs() {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { process.stdin && process.stdin.pause(); } catch {}
      const a = process.argv.slice(2).find((x) => String(x).trim().startsWith('{'));
      if (!buf && a) return resolve({ raw: a, source: 'argv' });
      if (!buf && process.env.BEAST_TOOL_ARGS) return resolve({ raw: process.env.BEAST_TOOL_ARGS, source: 'env' });
      resolve({ raw: buf, source: buf ? 'stdin' : 'none' });
    };
    const timer = setTimeout(finish, 800);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { buf += c; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      process.stdin.resume();
    } catch { finish(); }
  });
}

function normSymbol(s) {
  const t = String(s || DEFAULT_SYMBOL).toUpperCase().replace(/[^A-Z0-9.]/g, '');
  if (!t) return DEFAULT_SYMBOL;
  if (t === 'XAUUSD') return 'GOLD';
  if (t === 'BTCUSD' || t === 'BTC') return 'BITCOIN';
  return t;
}
function normTf(v) {
  const t = String(v || DEFAULT_TF).toUpperCase();
  return TF_ALLOWED.includes(t) ? t : DEFAULT_TF;
}
function normCount(v) {
  let n = Math.round(Number(v));
  if (!isFinite(n) || n <= 0) n = DEFAULT_COUNT;
  return Math.max(1, Math.min(500, n));
}

function pythonCandidates() {
  return [
    'python', 'py', 'python3',
    (process.env.APPDATA || '') + '\\\\beast\\\\py\\\\python.exe',
    'C:\\Python314\\python.exe',
    'C:\\Python313\\python.exe', 'C:\\Python312\\python.exe',
    'C:\\Python311\\python.exe', 'C:\\Python310\\python.exe',
  ];
}

function buildPy(SYMBOL, TIMEFRAME, COUNT) {
  return `
import json, sys, datetime
try:
    import MetaTrader5 as mt5
except Exception as e:
    print("ERR_MODULE " + type(e).__name__ + ": " + str(e)); sys.exit(2)

SYMBOL = ${JSON.stringify(SYMBOL)}
TFNAME = ${JSON.stringify(TIMEFRAME)}
COUNT  = ${COUNT}
TF = {"M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15,
      "M30": mt5.TIMEFRAME_M30, "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4,
      "D1": mt5.TIMEFRAME_D1}[TFNAME]

if not mt5.initialize():
    for t in ${JSON.stringify(TERMINALS)}:
        if mt5.initialize(path=t):
            break
if mt5.terminal_info() is None:
    print("ERR_INITIALIZE " + str(mt5.last_error())); sys.exit(3)

info = mt5.symbol_info(SYMBOL)
if info is None:
    print("ERR_SYMBOL yok: " + SYMBOL); sys.exit(4)
if not info.visible:
    mt5.symbol_select(SYMBOL, True)

rates = mt5.copy_rates_from_pos(SYMBOL, TF, 0, COUNT)
if rates is None or len(rates) == 0:
    print("ERR_RATES " + str(mt5.last_error())); sys.exit(5)

bars = [{"t": int(r["time"]),
         "ts": datetime.datetime.utcfromtimestamp(int(r["time"])).strftime("%Y-%m-%d %H:%M"),
         "o": float(r["open"]), "h": float(r["high"]), "l": float(r["low"]),
         "c": float(r["close"]), "v": int(r["tick_volume"])} for r in rates]
tick = mt5.symbol_info_tick(SYMBOL)
print("###BARS###" + json.dumps({"bars": bars, "digits": int(info.digits),
      "bid": float(tick.bid) if tick else None, "ask": float(tick.ask) if tick else None}))
mt5.shutdown()
`;
}

(async () => {
  const received = await readArgs();
  let args = {};
  try { args = JSON.parse(String(received.raw || '').trim() || '{}'); } catch { args = {}; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};

  try {
    const log = path.join(__dirname, 'args.log');
    if (fs.existsSync(log) && fs.statSync(log).size > 20000) fs.rmSync(log);
    fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), source: received.source, raw: String(received.raw).slice(0, 200) }) + '\n');
  } catch {}

  const SYMBOL = normSymbol(args.symbol);
  const TIMEFRAME = normTf(args.timeframe);
  const COUNT = normCount(args.count);

  const scriptPath = path.join(os.tmpdir(), 'beast_mt5_barlar2_' + process.pid + '.py');
  try { fs.writeFileSync(scriptPath, buildPy(SYMBOL, TIMEFRAME, COUNT)); }
  catch (e) { return emit({ ok: false, error: 'script yazilamadi: ' + String(e && e.message) }); }

  let lastErr = '';
  const tried = [];
  for (const cmd of pythonCandidates()) {
    tried.push(cmd);
    let r;
    try { r = spawnSync(cmd, [scriptPath], { encoding: 'utf8', timeout: 60000, windowsHide: true }); }
    catch (e) { lastErr = cmd + ': ' + String(e && e.message); continue; }
    const text = String((r && r.stdout) || '');
    const err = String((r && r.stderr) || '');
    const idx = text.indexOf('###BARS###');
    if (idx >= 0) {
      let data = null;
      try { data = JSON.parse(text.slice(idx + 10).trim()); }
      catch (e) { lastErr = cmd + ' json: ' + String(e && e.message); continue; }
      return emit({
        ok: true,
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        count: data.bars.length,
        requested: COUNT,
        digits: data.digits,
        bid: data.bid,
        ask: data.ask,
        interpreter: cmd,
        route: 'BYPASS - dogrudan MetaTrader5 python (kopru kullanilmadi)',
        args_source: received.source,
        bars: data.bars,
      });
    }
    lastErr = (err || text || ('cikis kodu ' + (r && r.status))).trim().slice(0, 400);
  }

  emit({
    ok: false,
    error: 'python MetaTrader5 ile bar okunamadi',
    symbol: SYMBOL, timeframe: TIMEFRAME, count: COUNT,
    args_received: String(received.raw).slice(0, 200),
    args_source: received.source,
    tried,
    last_error: lastErr.slice(0, 600),
  });
})();

/* PATCH 2026-09-10b: electron app-mode cocuk prosesi kapanmiyordu (90sn timeout).
   stdout'un boruya bosalmasi icin kisa bekleme, sonra zorla cik. */
setTimeout(() => process.exit(0), 1500);
