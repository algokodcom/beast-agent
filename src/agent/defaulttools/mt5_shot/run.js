'use strict';
/* mt5_shot — MT5 grafiğinden GERÇEK PNG screenshot (BeastFinance EA "shot" komutu)
   stdin: JSON args  ->  stdout: SADECE JSON sonuç

   Girdi : {symbol?, timeframe?, width?, height?, file?, template?, timeoutSec?, outdir?, diag?, embed?}
   Çıktı : {ok:true, path, symbol, timeframe, ...}  |  {ok:false, err, error, cmdId, filesDir, ...}
   err kodları: no_terminal | ea_offline | cmd_write_fail | ea_no_ack | ea_error | png_yok | timeout

   Notlar:
   - beast_cmd.json'a {id, ts, cmd, params} yazılır (UTF-16 BOM; EA FILE_UNICODE okur).
   - Ack dosyası POLL edilir; PNG MQL5\Files altında belirene kadar beklenir.
   - EA v1.20 şu şablonu işler: {"id":"..","ts":..,"cmd":"shot","params":{file,width,height,symbol?,timeframe?,template?}}
     symbol/timeframe aktif grafikten farklıysa EA ChartOpen+ChartSetSymbolPeriod ile geçici grafik açar.
   - PNG, send_file'ın engellediği %APPDATA%\beast altından çıkarılıp kullanıcı klasörüne
     (varsayılan <home>\beast_shots) kopyalanır; dönen "path" doğrudan send_file'a verilebilir.
   - GÖRSEL ENJEKSİYONU: başarılı sonuçta PNG data URL olarak __injectImage alanına gömülür;
     engine bunu sonraki turda ajana gösterir (embed:false kapatır) — ajan grafiği görerek analiz eder.
   - Watchdog: araç hiçbir koşulda asılı kalmaz; 80 sn'de {ok:false, err:"timeout"} döner.
*/
const fs = require('fs');
const os = require('os');
const path = require('path');

const SHOT_DIR = path.join(__dirname, 'shots');                       // yedek kopya (Beast altı)
const PUB_DIR_DEFAULT = path.join(os.homedir(), 'beast_shots');       // send_file edilebilir kopya
const LOCK_FILE = path.join(__dirname, '.shot.lock');
const LOCK_STALE_MS = 45000;
const HARD_MS = 80000;
const DEFAULT_TIMEOUT_SEC = 20;

/* ---------------- temel yardımcılar ---------------- */
function syncSleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const t = Date.now(); while (Date.now() - t < ms) { /* busy wait */ } }
}

let CTX = { cmdId: null, filesDir: null, started: Date.now() };
let ARGS = {};

function out(o) {
  try { fs.writeSync(1, JSON.stringify(o) + '\n'); }
  catch (e) { try { console.log(JSON.stringify(o)); } catch (x) {} }
  try { clearTimeout(WATCHDOG); } catch (e) {}
  try { releaseLock(); } catch (e) {}
  process.exit(0);
}

// her hata yolu TEK yerden geçer: ok:false + err kodu + cmdId + filesDir
function fail(code, msg, extra) {
  const o = Object.assign({
    ok: false,
    err: code,
    error: msg,
    cmdId: CTX.cmdId,
    filesDir: CTX.filesDir,
    ms: Date.now() - CTX.started
  }, extra || {});
  console.error('[mt5_shot] ' + code + ': ' + msg);
  out(o);
}

/* ---------------- kilit (eşzamanlı çağrılar ack'i ezmesin) ---------------- */
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch (e) {} }

function acquireLock(waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try { fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' }); return true; }
    catch (e) {
      let st = null;
      try { st = fs.statSync(LOCK_FILE); } catch (x) {
        // kilit kayboldu/kilitli kaldı: kısa bekle, sonsuz döngüye girme
        if (Date.now() >= deadline) return false;
        syncSleep(200);
        continue;
      }
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {                 // ölü kilit: devral
        try { fs.unlinkSync(LOCK_FILE); } catch (x) {}
        continue;
      }
      if (Date.now() >= deadline) return false;
      syncSleep(400);
    }
  }
}

/* ---------------- MT5 köprüsü ---------------- */
function findTerminalData() {
  const base = path.join(process.env.APPDATA || '', 'MetaQuotes', 'Terminal');
  if (!fs.existsSync(base)) return null;
  let best = null;
  for (const d of fs.readdirSync(base)) {
    const files = path.join(base, d, 'MQL5', 'Files');
    let fresh = 0;
    for (const f of ['beast_ea.json', 'beast_cmd.json', 'beast_cmd_ack.json']) {
      try {
        const p = path.join(files, f);
        if (fs.existsSync(p)) fresh = Math.max(fresh, fs.statSync(p).mtimeMs);
      } catch (e) {}
    }
    if (!fresh) continue;
    if (!best || fresh > best.m) best = { dir: path.join(base, d), files, m: fresh };
  }
  return best;
}

function readMaybeUtf16(fp) {
  const buf = fs.readFileSync(fp);
  let s;
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) s = buf.slice(2).toString('utf16le');
  else s = buf.toString('utf8');
  return s.replace(/^\uFEFF/, '').replace(/\0/g, '');
}

// EA FILE_UNICODE ile okur -> BOM'lu UTF-16 yaz; rename EBUSY olursa doğrudan yaz
function writeUtf16(fp, str) {
  const buf = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(str, 'utf16le')]);
  const tmp = fp + '.tmp' + process.pid;
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, fp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (x) {}
    fs.writeFileSync(fp, buf);
  }
}

function readJson(fp) {
  try { return JSON.parse(readMaybeUtf16(fp)); } catch (e) { return null; }
}

function heartbeatAge(beatFile) {
  try { return Math.round((Date.now() - fs.statSync(beatFile).mtimeMs) / 1000); } catch (e) { return null; }
}

// MT5 period kodu -> okunabilir periyot adı (16385 = M15)
const TF_NAMES = { 1:'M1',2:'M2',3:'M3',4:'M4',5:'M5',6:'M6',10:'M10',12:'M12',15:'M15',20:'M20',30:'M30',
  16385:'H1',16386:'H2',16387:'H3',16388:'H4',16390:'H6',16392:'H8',16396:'H12',16408:'D1',32769:'W1',49153:'MN1' };
function tfName(p) {
  const n = Number(p);
  return TF_NAMES[n] || (TF_NAMES[Math.round(n)] || String(p == null ? '' : p));
}

/* ack yoksa: kanal sağlam mı? kısa bir ping ile ayırt et */
function eaPing(filesDir, budgetMs) {
  const id = 'P' + Date.now().toString(36);
  const cmdFile = path.join(filesDir, 'beast_cmd.json');
  const ackFile = path.join(filesDir, 'beast_cmd_ack.json');
  const t0 = Date.now();
  try { writeUtf16(cmdFile, JSON.stringify({ id, ts: Date.now(), cmd: 'ping' })); }
  catch (e) { return { ok: false, error: 'ping yazılamadı: ' + e.message }; }
  const dl = Date.now() + budgetMs;
  while (Date.now() < dl) {
    syncSleep(300);
    const a = readJson(ackFile);
    if (a && a.id === id) return { ok: true, ack: a, ms: Date.now() - t0 };
  }
  return { ok: false, error: 'ping yanıtı yok (' + Math.round((Date.now() - t0) / 1000) + ' sn)' };
}

/* ---------------- ana akış ---------------- */
function run() {
  const timeoutSec = Number(ARGS.timeoutSec) > 0
    ? Math.max(5, Math.min(70, Math.round(Number(ARGS.timeoutSec))))
    : DEFAULT_TIMEOUT_SEC;
  const diag = ARGS.diag !== false;

  const term = findTerminalData();
  if (!term) return fail('no_terminal', 'MT5 terminal veri klasörü bulunamadı (beast_ea.json yok) — MT5 kurulu/çalışıyor mu?');
  const filesDir = term.files;
  CTX.filesDir = filesDir;

  const cmdFile = path.join(filesDir, 'beast_cmd.json');
  const ackFile = path.join(filesDir, 'beast_cmd_ack.json');
  const beatFile = path.join(filesDir, 'beast_ea.json');
  const beatAge = heartbeatAge(beatFile);
  if (beatAge !== null && beatAge > 60) {
    return fail('ea_offline', 'BeastFinance EA canlı değil (son heartbeat ' + beatAge + ' sn önce) — grafikte EA yüklü ve terminal açık mı?',
      { heartbeat_age_sec: beatAge });
  }

  const locked = acquireLock(Math.min(15000, timeoutSec * 500));
  if (!locked) console.error('[mt5_shot] uyarı: kilit alınamadı, yine de devam ediliyor');

  const id = 'S' + Date.now().toString(36);
  CTX.cmdId = id;

  let file = (ARGS.file && String(ARGS.file).trim()) ? String(ARGS.file).trim() : ('beast_shot_' + id + '.png');
  file = path.basename(file);                       // yol kaçışını engelle
  if (!/\.(png|gif|bmp|jpg|jpeg)$/i.test(file)) file += '.png';

  const params = { file };
  if (ARGS.timeframe) params.timeframe = String(ARGS.timeframe).toUpperCase();
  if (ARGS.symbol) params.symbol = String(ARGS.symbol).toUpperCase();
  if (ARGS.template !== undefined) params.template = String(ARGS.template);
  params.width = Number(ARGS.width) > 0 ? Math.min(10000, Math.round(Number(ARGS.width))) : 1600;
  params.height = Number(ARGS.height) > 0 ? Math.min(10000, Math.round(Number(ARGS.height))) : 900;

  const payload = { id, ts: Date.now(), cmd: 'shot', params };

  try { if (fs.existsSync(ackFile)) fs.unlinkSync(ackFile); } catch (e) {}
  try { writeUtf16(cmdFile, JSON.stringify(payload)); }
  catch (e) { return fail('cmd_write_fail', 'beast_cmd.json yazılamadı: ' + e.message, { sent: payload }); }

  /* --- ack POLL (cmd dosyasının EA tarafından tüketilmesi de izlenir) --- */
  let ack = null, cmdConsumed = false;
  const ackDeadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < ackDeadline) {
    syncSleep(250);
    const a = readJson(ackFile);
    if (a && a.id === id) { ack = a; break; }
    try {
      if (!fs.existsSync(cmdFile)) cmdConsumed = true;
      else {
        const c = readJson(cmdFile);
        if (c && c.id && c.id !== id) cmdConsumed = true;   // başka bir çağrı ezip geçti
      }
    } catch (e) {}
  }

  if (!ack) {
    const extra = {
      heartbeat_age_sec: heartbeatAge(beatFile),
      cmd_consumed: cmdConsumed,
      timeout_sec: timeoutSec,
      sent: payload
    };
    if (diag) {
      extra.diagnostic = cmdConsumed
        ? 'EA komutu aldı ama ack yazmadı (shot işleyicisi hata verdi / PNG üretimi bloke)'
        : 'EA komutu hiç almadı (zamanlayıcı durmuş ya da komut dosyası okunamadı)';
      extra.ping = eaPing(filesDir, 6000);
    }
    return fail('ea_no_ack', 'EA ' + timeoutSec + ' sn içinde ack vermedi (id=' + id + ', heartbeat ' +
      (extra.heartbeat_age_sec === null ? '?' : extra.heartbeat_age_sec) + ' sn, cmd tüketildi=' + cmdConsumed + ')', extra);
  }

  if (ack.ok === false) {
    return fail('ea_error', 'EA hata döndürdü: ' + (ack.error || 'bilinmeyen'), { ack });
  }

  /* --- PNG dosyasını bekle --- */
  const shotFile = (ack.result && ack.result.file) ? path.basename(String(ack.result.file)) : file;
  const src = path.join(filesDir, shotFile);
  let size = 0;
  const pngDeadline = Math.max(ackDeadline, Date.now() + 8000);
  for (;;) {
    try { if (fs.existsSync(src)) { size = fs.statSync(src).size; if (size > 1500) break; } } catch (e) {}
    if (Date.now() >= pngDeadline) break;
    syncSleep(250);
  }
  if (size <= 1500) {
    return fail('png_yok', 'PNG oluşmadı ya da çok küçük (' + size + ' byte): ' + shotFile,
      { ack, expected_file: shotFile, bytes: size });
  }

  /* --- kopyala: Beast altı yedek + send_file edilebilir kullanıcı klasörü --- */
  const pubDir = (ARGS.outdir && String(ARGS.outdir).trim()) ? path.resolve(String(ARGS.outdir).trim()) : PUB_DIR_DEFAULT;
  let pubPath = null, beastPath = null, pubErr = null;
  try {
    if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
    beastPath = path.join(SHOT_DIR, shotFile);
    fs.copyFileSync(src, beastPath);
  } catch (e) { /* yedek kopya zorunlu değil */ }
  try {
    if (!fs.existsSync(pubDir)) fs.mkdirSync(pubDir, { recursive: true });
    pubPath = path.join(pubDir, shotFile);
    fs.copyFileSync(src, pubPath);
  } catch (e) { pubErr = e.message; }

  const res = (ack.result || {});
  const tfTxt = (res.period ? tfName(res.period) : null) || params.timeframe || null;
  const wantSym = params.symbol || res.symbol || null;
  const mismatch = !!(params.symbol && res.symbol && String(res.symbol).toUpperCase() !== String(params.symbol).toUpperCase());

  /* --- GÖRSELİ ÇAĞIRAN AJANA GÖSTER: PNG data URL olarak sonuca gömülür;
     engine bunu __injectImage sözleşmesiyle sonraki turda vision mesajı yapar
     (ajan grafiği GERÇEKTEN görür). embed:false ile kapatılır; ~3.5MB üstü
     bağlam/dekont şişmesin diye gömülmez (path yine döner). --- */
  let dataUrl = null;
  try {
    if (ARGS.embed !== false && size > 0 && size <= 3500000) {
      dataUrl = 'data:image/png;base64,' + fs.readFileSync(src).toString('base64');
    }
  } catch (e) {}

  return out({
    ok: true,
    path: pubPath || beastPath || src,          // send_file'a verilecek yol
    path_mt5: src,
    path_beast: beastPath,
    file: shotFile,
    bytes: size,
    image_embedded: !!dataUrl,
    ...(dataUrl ? { __injectImage: dataUrl } : {}),
    cmdId: id,
    filesDir: filesDir,
    symbol: res.symbol || wantSym || null,
    timeframe: tfTxt,
    period: res.period || null,
    requested: { symbol: params.symbol || null, timeframe: params.timeframe || null },
    width: params.width,
    height: params.height,
    temp_chart: res.temp_chart === true,
    template_applied: res.template_applied === true,
    symbol_mismatch: mismatch,
    heartbeat_age_sec: heartbeatAge(beatFile),
    ms: Date.now() - CTX.started,
    pubErr: pubErr || undefined
  });
}

/* ---------------- stdin / argv (asılmaya karşı sigortalı + çok kanallı) ---------------- */
function parseArgs(s) {
  const t = String(s || '').trim();
  if (!t) return {};
  try { return JSON.parse(t) || {}; } catch (e) {}
  const m = t.match(/\{[\s\S]*\}/);                     // kesik/gürültülü girişten kurtar
  if (m) { try { return JSON.parse(m[0]) || {}; } catch (e) {} }
  return {};
}

// {args:{...}} / {parameters:{...}} gibi sarmalayıcıları düzleştir (her durumda flat args'a in)
function unwrap(o) {
  let x = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  const WRAP = ['args', 'arguments', 'params', 'parameters', 'input'];
  for (let i = 0; i < 3; i++) {
    const inner = WRAP.map((k) => x[k]).find((v) => v && typeof v === 'object' && !Array.isArray(v));
    if (!inner) break;
    x = Object.assign({}, x, inner);
    for (const k of WRAP) delete x[k];
  }
  if (x.args && typeof x.args === 'object') x = Object.assign({}, x, x.args);
  delete x.args;
  return x;
}

function argsFromArgv() {
  const av = process.argv.slice(2);
  const joined = av.join(' ').trim();
  if (joined) {
    const j = parseArgs(joined);
    if (Object.keys(j).length) return j;
  }
  const kv = {};
  for (const a of av) {
    const m = /^--?([a-zA-Z_][a-zA-Z0-9_]*)=(.+)$/.exec(a);
    if (m) {
      const v = m[2];
      kv[m[1]] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : (v === 'true' ? true : (v === 'false' ? false : v));
    }
  }
  return kv;
}

function loadArgs(rawStdin) {
  const cands = [rawStdin];
  try { cands.push(process.env.BEAST_TOOL_ARGS, process.env.TOOL_ARGS, process.env.TOOL_ARGUMENTS); } catch (e) {}
  const av = argsFromArgv();
  let src = 'none', parsed = {};
  for (const c of cands) {
    if (!c) continue;
    const o = parseArgs(c);
    if (o && Object.keys(o).length) { parsed = o; src = 'stdin/env'; break; }
  }
  if (!src || src === 'none') {
    if (av && Object.keys(av).length) { parsed = av; src = 'argv'; }
  }
  const final = unwrap(parsed);
  // teşhis izi: argüman nereden geldi / hiç geldi mi (asla dışarı gönderilmez)
  try {
    let f0 = null, pcmd = null;
    try {
      const st = fs.fstatSync(0);
      f0 = { isFIFO: st.isFIFO(), isCharacterDevice: st.isCharacterDevice(), isFile: st.isFile(), size: st.size };
    } catch (e) { f0 = { error: String(e && e.message) }; }
    try {
      const { execSync } = require('child_process');
      pcmd = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=' +
        process.ppid + '\\").CommandLine"', { timeout: 5000 }).toString().trim();
    } catch (e) { pcmd = 'okunamadı: ' + String(e && e.message).slice(0, 120); }
    const envJson = {};
    for (const k of Object.keys(process.env)) {
      if (/key|token|secret|pass|auth|credential/i.test(k)) continue;
      const v = String(process.env[k] || '');
      if (/tool|beast|arg|param|call|json/i.test(k) || v.trim().startsWith('{')) envJson[k] = v.slice(0, 300);
    }
    fs.writeFileSync(path.join(__dirname, 'last-args.json'), JSON.stringify({
      at: new Date().toISOString(), source: src,
      stdin_raw: String(rawStdin || '').slice(0, 1500),
      stdin_fd0: f0, ppid: process.ppid, parent_cmd: pcmd,
      argv: process.argv.slice(2), env_json: envJson, parsed, final
    }, null, 1));
  } catch (e) {}
  if (src === 'none' || !Object.keys(final).length) {
    console.error('[mt5_shot] uyarı: çağrı argümanı alınamadı (stdin/argv boş) — varsayılanlar kullanılıyor');
  }
  return final;
}

let raw = '', resolved = false, silenceTimer = null;
function begin(resolve) { if (resolved) return; resolved = true; resolve(); }
function finish() {
  ARGS = loadArgs(raw);
  try { run(); }
  catch (e) { fail('timeout', 'beklenmeyen hata: ' + (e && e.message ? e.message : String(e))); }
}
try {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    raw += d;
    if (silenceTimer) clearTimeout(silenceTimer);
    // JSON tamamlandıysa EOF beklemeden başla; değilse kısa bir sessizlik penceresi daha bekle
    const o = parseArgs(raw);
    if (raw.trim() && Object.keys(o).length) return begin(finish);
    silenceTimer = setTimeout(() => begin(finish), 1200);
  });
  process.stdin.on('end', () => begin(finish));
  process.stdin.on('error', () => begin(finish));
  process.stdin.on('close', () => begin(finish));
  process.stdin.resume();
  setTimeout(() => begin(finish), 2500);        // stdin hiç açılmaz/kapanmazsa da devam et (asılmaya izin yok)
} catch (e) { begin(finish); }

/* watchdog: hiçbir koşulda 80 sn üzeri asılı kalma */
const WATCHDOG = setTimeout(() => {
  fail('timeout', 'mt5_shot ' + Math.round((Date.now() - CTX.started) / 1000) + ' sn içinde tamamlanamadı (watchdog) — ack/PNG beklemesi aşıldı');
}, HARD_MS);
