'use strict';
/* mt5_shot — MT5 grafiğinden GERÇEK PNG screenshot (BeastFinance EA "shot" komutu)
   stdin: JSON args  ->  stdout: SADECE JSON sonuç

   Girdi : {symbol?, symbols?:["GOLD","EURUSD"], timeframe?, timeframes?:["M1","M15"], layout?:"h"|"v", width?, height?, file?, template?, timeoutSec?, outdir?, diag?, embed?}
   Çıktı : {ok:true, path, symbol, symbols, timeframe, timeframes, panels:[...], ...}  |  {ok:false, err, error, cmdId, filesDir, ...}
   err kodları: no_terminal | ea_offline | cmd_write_fail | ea_no_ack | ea_error | png_yok | timeout | stitch_fail | stitch_write_fail

   ÇOKLU SEMBOL: symbols:["GOLD","EURUSD","BTCUSD"] (2-4 sembol) verilirse her
   sembolden bir kare çekilir ve TEK PNG'de birleştirilir; timeframes ile
   birlikte verilirse sembol × periyot ızgarası kurulur (en fazla 6 kare).
   İzleme listesinin tamamı TEK görselde ekibe gönderilebilir.

   ÇOKLU PERİYOT: timeframes:["M1","M15"] (2-3 adet) verilirse her periyot ayrı
   çekilir ve TEK PNG'de birleştirilir (layout:"h" soldan sağa — varsayılan,
   "v" üstten alta). Panellerin SAĞ ÜSTüne "SEMBOL · PERİYOT" etiketi çizilir;
   sonuçta panels[{symbol, timeframe, position, path}] hangi tarafın hangi
   sembol/periyot olduğunu söyler. tf2:"M15" kısayolu da (timeframe + tf2) kabul edilir.

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
let WATCHDOG = null;

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

/* çoklu periyot listesi: ["M1","M15"] ya da "M1,M15"; tf2 kısayolu destekli */
function normalizeTfs(a) {
  let t = a.timeframes;
  if ((t == null || t === '') && a.tf2) t = [a.timeframe, a.tf2];
  if (typeof t === 'string') t = t.split(/[,\s|+/]+/);
  if (!Array.isArray(t)) return [];
  const out = [];
  for (const x of t) {
    const s = String(x == null ? '' : x).trim().toUpperCase();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 3);   /* 80 sn watchdog bütçesi: en fazla 3 panel */
}

/* çoklu sembol listesi: ["GOLD","EURUSD"] ya da "GOLD,EURUSD";
   symbol alanı da listeye katılır (symbol + symbols birlikte verilebilir) */
function normalizeSymbols(a) {
  const out = [];
  const add = (x) => {
    const s = String(x == null ? '' : x).trim().toUpperCase();
    if (s && !out.includes(s)) out.push(s);
  };
  add(a.symbol);
  let s = a.symbols;
  if (typeof s === 'string') s = s.split(/[,\s|+/]+/);
  if (Array.isArray(s)) for (const x of s) add(x);
  return out.slice(0, 4);
}

/* PANEL PLANI: symbols × timeframes çarpımı → sırayla çekilecek kareler.
   - symbols 2+ → her sembolden bir kare (timeframes da verilmişse her periyot)
   - tek sembol + timeframes 2+ → eski çoklu periyot davranışı
   - tek karelik işler plana girmez: [] döner (tek çekim yolu kullanılır)
   Dönüş: [{symbol, timeframe}] — en fazla MAX_PANELS kare (watchdog bütçesi) */
const MAX_PANELS = 6;
function buildPlan(a) {
  const A = a || ARGS;
  const symbols = normalizeSymbols(A);
  const tfs = normalizeTfs(A);
  const out = [];
  const push = (symbol, timeframe) => {
    if (out.length < MAX_PANELS) out.push({ symbol, timeframe });
  };
  if (symbols.length >= 2) {
    const per = tfs.length ? tfs : [null];
    for (const s of symbols) for (const tf of per) push(s, tf);
    return out;
  }
  if (tfs.length >= 2) for (const tf of tfs) push(symbols[0] || null, tf);
  return out;
}

function sanitizeFile(name, fallback) {
  let f = (name && String(name).trim()) ? path.basename(String(name).trim()) : fallback;
  if (!/\.(png|gif|bmp|jpg|jpeg)$/i.test(f)) f += '.png';
  return f;
}

/* tek kare: EA'ya shot komutu yaz → ack bekle → PNG'yi bekle */
function captureOne(o) {
  CTX.cmdId = o.id;
  const payload = { id: o.id, ts: Date.now(), cmd: 'shot', params: o.params };
  try { if (fs.existsSync(o.ackFile)) fs.unlinkSync(o.ackFile); } catch (e) {}
  try { writeUtf16(o.cmdFile, JSON.stringify(payload)); }
  catch (e) { return { ok: false, err: 'cmd_write_fail', error: 'beast_cmd.json yazılamadı: ' + e.message, extra: { sent: payload } }; }

  /* --- ack POLL (cmd dosyasının EA tarafından tüketilmesi de izlenir) --- */
  let ack = null, cmdConsumed = false;
  const ackDeadline = Date.now() + o.timeoutSec * 1000;
  while (Date.now() < ackDeadline) {
    syncSleep(250);
    const a = readJson(o.ackFile);
    if (a && a.id === o.id) { ack = a; break; }
    try {
      if (!fs.existsSync(o.cmdFile)) cmdConsumed = true;
      else {
        const c = readJson(o.cmdFile);
        if (c && c.id && c.id !== o.id) cmdConsumed = true;   // başka bir çağrı ezip geçti
      }
    } catch (e) {}
  }

  if (!ack) {
    const extra = {
      heartbeat_age_sec: heartbeatAge(o.beatFile),
      cmd_consumed: cmdConsumed,
      timeout_sec: o.timeoutSec,
      sent: payload
    };
    if (o.diag) {
      extra.diagnostic = cmdConsumed
        ? 'EA komutu aldı ama ack yazmadı (shot işleyicisi hata verdi / PNG üretimi bloke)'
        : 'EA komutu hiç almadı (zamanlayıcı durmuş ya da komut dosyası okunamadı)';
      extra.ping = eaPing(o.filesDir, 6000);
    }
    return { ok: false, err: 'ea_no_ack', error: 'EA ' + o.timeoutSec + ' sn içinde ack vermedi (id=' + o.id + ', heartbeat ' +
      (extra.heartbeat_age_sec === null ? '?' : extra.heartbeat_age_sec) + ' sn, cmd tüketildi=' + cmdConsumed + ')', extra };
  }

  if (ack.ok === false) {
    return { ok: false, err: 'ea_error', error: 'EA hata döndürdü: ' + (ack.error || 'bilinmeyen'), extra: { ack } };
  }

  /* --- PNG dosyasını bekle --- */
  const shotFile = (ack.result && ack.result.file) ? path.basename(String(ack.result.file)) : o.params.file;
  const src = path.join(o.filesDir, shotFile);
  let size = 0;
  const pngDeadline = Math.max(ackDeadline, Date.now() + 8000);
  for (;;) {
    try { if (fs.existsSync(src)) { size = fs.statSync(src).size; if (size > 1500) break; } } catch (e) {}
    if (Date.now() >= pngDeadline) break;
    syncSleep(250);
  }
  if (size <= 1500) {
    return { ok: false, err: 'png_yok', error: 'PNG oluşmadı ya da çok küçük (' + size + ' byte): ' + shotFile, extra: { ack, expected_file: shotFile, bytes: size } };
  }
  return { ok: true, src, shotFile, size, res: ack.result || {}, params: o.params, id: o.id };
}

/* --- kopyala: Beast altı yedek + send_file edilebilir kullanıcı klasörü --- */
function copyOut(src, shotFile, outdir) {
  const pubDir = (outdir && String(outdir).trim()) ? path.resolve(String(outdir).trim()) : PUB_DIR_DEFAULT;
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
  return { pubPath, beastPath, pubErr };
}

/* --- PNG data URL (engine __injectImage sözleşmesiyle ajana görsel enjekte eder) --- */
function embedData(src, size) {
  let dataUrl = null;
  try {
    if (ARGS.embed !== false && size > 0 && size <= 3500000) {
      dataUrl = 'data:image/png;base64,' + fs.readFileSync(src).toString('base64');
    }
  } catch (e) {}
  return dataUrl;
}

/* ---- ÇOKLU KARE: plan (sembol × periyot) sırayla çekilir ve TEK PNG'de
   birleştirilir — kilit zaten alınmış (ack çakışması yok); her panelin SAĞ
   ÜSTüne "SEMBOL · PERİYOT" etiketi çizilir; soldan sağa (layout:"v" ile
   üstten alta). plan: [{symbol, timeframe}] — boş alan = aktif grafik. */
async function runPanels(plan, filesDir, cmdFile, ackFile, beatFile, timeoutSec, diag) {
  let compose = null;
  try { compose = require('./stitch.js').compose; } catch (e) {}
  if (!compose) return { err: 'stitch_fail', error: 'stitch.js bulunamadı (mt5_shot güncel kurulum gerekiyor)' };

  const n = plan.length;
  const baseId = 'S' + Date.now().toString(36);
  const fileArg = ARGS.file && String(ARGS.file).trim() ? String(ARGS.file).trim() : '';
  const uniqSym = [...new Set(plan.map((p) => p.symbol).filter(Boolean))];
  const base = fileArg
    ? fileArg.replace(/\.[a-z0-9]+$/i, '')
    : (uniqSym.length > 1 ? 'beast_symbols_' : 'beast_mtf_') + baseId;
  const perAck = Math.max(5, Math.min(15, Math.floor(45 / n)));
  const width = Number(ARGS.width) > 0 ? Math.min(10000, Math.round(Number(ARGS.width))) : 1600;
  const height = Number(ARGS.height) > 0 ? Math.min(10000, Math.round(Number(ARGS.height))) : 900;
  const layout = String(ARGS.layout || 'h').toLowerCase() === 'v' ? 'v' : 'h';

  const panels = [];
  const cmdIds = [];
  for (let i = 0; i < n; i++) {
    const spec = plan[i] || {};
    const symArg = spec.symbol ? String(spec.symbol).toUpperCase() : null;
    const tfArg = spec.timeframe ? String(spec.timeframe).toUpperCase() : null;
    const id = baseId + 'p' + (i + 1);
    const tag = [symArg, tfArg].filter(Boolean).join('_') || 'aktif';
    const params = { file: sanitizeFile(base + '_' + tag, 'beast_shot_' + id), width, height };
    if (tfArg) params.timeframe = tfArg;
    if (symArg) params.symbol = symArg;
    if (ARGS.template !== undefined) params.template = String(ARGS.template);
    cmdIds.push(id);
    const r = captureOne({ id, file: params.file, params, filesDir, cmdFile, ackFile, beatFile, timeoutSec: perAck, diag });
    if (!r.ok) {
      return {
        err: r.err,
        error: '[' + tag + '] ' + r.error,
        extra: Object.assign({ panel: tag, cmdId: id, requested: { symbol: symArg, timeframe: tfArg } }, r.extra || {})
      };
    }
    const cp = copyOut(r.src, r.shotFile, ARGS.outdir);
    const tfDone = (r.res && r.res.period ? tfName(r.res.period) : null) || tfArg || null;
    const symDone = (r.res && r.res.symbol ? String(r.res.symbol).toUpperCase() : null) || symArg || null;
    panels.push({ spec, sym: symDone, tf: tfDone, src: r.src, file: r.shotFile, size: r.size, res: r.res, pubPath: cp.pubPath, beastPath: cp.beastPath });
  }

  /* birleştir: etiketler çekimden SONRA gerçek sembol/periyotla kurulur */
  let composed = null;
  try {
    composed = await compose(
      panels.map((p) => ({ path: p.src, label: [p.sym, p.tf].filter(Boolean).join(' · ') || 'aktif grafik' })),
      { layout }
    );
  } catch (e) { composed = { ok: false, error: String((e && e.message) || e) }; }
  if (!composed || !composed.ok) {
    return { err: 'stitch_fail', error: 'görüntüler birleştirilemedi: ' + ((composed && composed.error) || 'bilinmeyen') };
  }

  const outFile = sanitizeFile(fileArg, base + '.png');
  const pathMt5 = path.join(filesDir, outFile);
  try { fs.writeFileSync(pathMt5, composed.buffer); }
  catch (e) { return { err: 'stitch_write_fail', error: 'birleşik PNG yazılamadı: ' + e.message }; }
  const size = composed.buffer.length;
  const cp = copyOut(pathMt5, outFile, ARGS.outdir);
  const dataUrl = embedData(pathMt5, size);
  const symDone = [...new Set(panels.map((p) => p.sym).filter(Boolean))];
  const tfList = [...new Set(plan.map((p) => p.timeframe).filter(Boolean))];

  return {
    ok: true,
    payload: {
      ok: true,
      path: cp.pubPath || cp.beastPath || pathMt5,   // send_file / agent_dm image:"<path>"
      path_mt5: pathMt5,
      path_beast: cp.beastPath,
      file: outFile,
      bytes: size,
      image_embedded: !!dataUrl,
      ...(dataUrl ? { __injectImage: dataUrl } : {}),
      cmdIds,
      filesDir,
      symbol: symDone.length === 1 ? symDone[0] : null,
      symbols: symDone,
      timeframes: tfList,
      layout,
      panels: panels.map((p, i) => ({
        symbol: p.sym,
        timeframe: p.tf,
        position: layout === 'h'
          ? (i === 0 ? 'left' : (i === n - 1 ? 'right' : 'middle'))
          : (i === 0 ? 'top' : (i === n - 1 ? 'bottom' : 'middle')),
        file: p.file,
        path: p.pubPath || p.beastPath || p.src,
        bytes: p.size,
        period: (p.res && p.res.period) || null
      })),
      width: composed.width,
      height: composed.height,
      requested: {
        symbol: ARGS.symbol ? String(ARGS.symbol).toUpperCase() : null,
        symbols: Array.isArray(ARGS.symbols) ? ARGS.symbols.map((s) => String(s).toUpperCase()) : (ARGS.symbols || null),
        timeframes: tfList,
        width, height, layout
      },
      heartbeat_age_sec: heartbeatAge(beatFile),
      ms: Date.now() - CTX.started,
      pubErr: cp.pubErr || undefined
    }
  };
}

async function run() {
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

  /* ÇOKLU KARE: symbols:["GOLD","EURUSD"] ve/veya timeframes:["M1","M15"]
     → sırayla çekilip tek PNG'de etiketli birleştirilir */
  const plan = buildPlan();
  if (plan.length >= 2) {
    const r = await runPanels(plan, filesDir, cmdFile, ackFile, beatFile, timeoutSec, diag);
    if (!r.ok) return fail(r.err, r.error, r.extra);
    return out(r.payload);
  }

  const id = 'S' + Date.now().toString(36);
  CTX.cmdId = id;

  const file = sanitizeFile(ARGS.file, 'beast_shot_' + id + '.png');

  const params = { file };
  if (ARGS.timeframe) params.timeframe = String(ARGS.timeframe).toUpperCase();
  if (ARGS.symbol) params.symbol = String(ARGS.symbol).toUpperCase();
  if (ARGS.template !== undefined) params.template = String(ARGS.template);
  params.width = Number(ARGS.width) > 0 ? Math.min(10000, Math.round(Number(ARGS.width))) : 1600;
  params.height = Number(ARGS.height) > 0 ? Math.min(10000, Math.round(Number(ARGS.height))) : 900;

  const cap = captureOne({ id, file, params, filesDir, cmdFile, ackFile, beatFile, timeoutSec, diag });
  if (!cap.ok) return fail(cap.err, cap.error, cap.extra);

  const cp = copyOut(cap.src, cap.shotFile, ARGS.outdir);
  const res = cap.res;
  const tfTxt = (res.period ? tfName(res.period) : null) || params.timeframe || null;
  const wantSym = params.symbol || res.symbol || null;
  const mismatch = !!(params.symbol && res.symbol && String(res.symbol).toUpperCase() !== String(params.symbol).toUpperCase());
  const dataUrl = embedData(cap.src, cap.size);

  return out({
    ok: true,
    path: cp.pubPath || cp.beastPath || cap.src,   // send_file'a verilecek yol
    path_mt5: cap.src,
    path_beast: cp.beastPath,
    file: cap.shotFile,
    bytes: cap.size,
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
    pubErr: cp.pubErr || undefined
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
  Promise.resolve()
    .then(run)
    .catch((e) => fail('timeout', 'beklenmeyen hata: ' + (e && e.message ? e.message : String(e))));
}

function main() {
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
  WATCHDOG = setTimeout(() => {
    fail('timeout', 'mt5_shot ' + Math.round((Date.now() - CTX.started) / 1000) + ' sn içinde tamamlanamadı (watchdog) — ack/PNG beklemesi aşıldı');
  }, HARD_MS);
}

/* saf yardımcılar test için dışa açılır; runner yalnız doğrudan çalıştırılınca başlar */
module.exports = { normalizeTfs, normalizeSymbols, buildPlan, sanitizeFile };

if (require.main === module) main();
