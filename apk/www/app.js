'use strict';

/* Beast Mobile — telefon tarafı istemci (browser test + Capacitor APK ortak)
   Protokol: src/agent/mobile.js ile birebir (t:'auth' / 'send' / ... ;
   agent eventleri 'type' alanıyla gelir). */

const $ = (s) => document.querySelector(s);
const authEl = $('#auth'), appEl = $('#app');
const hostEl = $('#host'), codeEl = $('#code'), errEl = $('#authErr'), btnJoin = $('#btnJoin');
const authWait = $('#authWait');
const msgsEl = $('#msgs'), inputEl = $('#input'), sendEl = $('#send'), micEl = $('#mic');
const sessEl = $('#sess'), hdot = $('#hdot'), hstat = $('#hstat');
const sessTitleEl = $('#sessTitle'), sessSheet = $('#sessSheet'), sessListEl = $('#sessList');
const typingEl = $('#typing'), attwrapEl = $('#attwrap');
const exitEl = $('#exit'), slashEl = $('#slashMenu');
const setPage = $('#settingsPage'), setBack = $('#settingsBack'), segTheme = $('#segTheme');
const toastEl = $('#toast');

let ws = null;
let joined = false;
let sid = localStorage.getItem('bmSid') || '';
let busy = false;
/* canlı akış: tek balon birikir (token eventleri) */
let streamEl = null;
let streamBuf = '';
let snapT = 0; /* 'geçmiş yüklenemedi' bilgilendirme bekçisi */
let lastFin = ''; /* son dondurulmuş/token-akışı metni — final 'message' echo'sunun çift balon yapmasını önler */
let pending = []; /* ek çipleri: {type:'image'|'file', name, dataUrl|content} */
let selfEcho = 0; /* kendi gönderdiğimiz mesajın echo'su — bildirim yapılmasın */
let settingsOpen = false;

/* UYGULAMA GÖRÜNÜRLÜĞÜ: bildirim bastırma için iki sinyal birlikte kullanılır
   (document.hidden + Capacitor appStateChange — biri aksarsa diğeri tutar) */
let appActive = true;
try {
  const AppP = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (AppP && typeof AppP.addListener === 'function') {
    AppP.addListener('appStateChange', (s) => {
      try {
        appActive = !!(s && s.isActive);
        if (appActive) scroll();
      } catch {}
    });
  }
  if (document.hidden) appActive = false;
} catch {}
function appInForeground() {
  try { return !document.hidden && appActive; } catch { return true; }
}

/* ---------- SÜREKLİ BAĞLANTI (arka planda kopamayan WS) ---------- */
let quitIntent = false; /* kullanıcı Çıkış'a bastı → bağlan ekranı yalnız o anda gösterilir */
let reconnectT = null;
let retryCount = 0;
let pingT = null;
let lastPong = 0;
let outbox = []; /* bağlantı kesikken gönderilen mesajlar — bağlanınca sırayla gider */
let keepAliveOn = true; /* Android ön plan servisi: arka planda bağlantı canlı kalsın */
const KEEP_KEY = 'bmKeep';

/* ---------- SOHBET ÖNBELLEĞİ (WhatsApp gibi kalıcı gösterim) ---------- */
let chatArr = [];
let cacheDirty = false;
let cacheSuspend = false; /* önbellekten basarken tekrar kaydetme (çift kayıt olmasın) */

/* =================== TEMA (koyu / aydınlık / sistem) =================== */
const THEME_KEY = 'bmTheme';
const mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

function sysIsLight() { return !!(mqDark && mqDark.matches); }
function effTheme(pref) { return (pref === 'light' || pref === 'dark') ? pref : (sysIsLight() ? 'light' : 'dark'); }
function currentThemePref() {
  try { return localStorage.getItem(THEME_KEY) || 'dark'; } catch { return 'dark'; }
}

function applyTheme(pref, persist) {
  const p = (pref === 'light' || pref === 'dark' || pref === 'system') ? pref : 'dark';
  const eff = effTheme(p);
  document.body.dataset.theme = eff;
  try { document.documentElement.style.colorScheme = eff; } catch {}
  if (persist) { try { localStorage.setItem(THEME_KEY, p); } catch {} }
  try {
    segTheme.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === p));
  } catch {}
  syncSystemBars();
  return eff;
}

function syncSystemBars() {
  try {
    const cap = window.Capacitor;
    const sb = cap && cap.Plugins && cap.Plugins.SystemBars;
    if (sb && typeof sb.setStyle === 'function') sb.setStyle({ bar: 'StatusBar', style: 'DARK' });
  } catch {}
}

if (mqDark && typeof mqDark.addEventListener === 'function') {
  mqDark.addEventListener('change', () => {
    if (currentThemePref() === 'system') applyTheme('system', false);
  });
}

/* =================== ANDROID YEREL EKLENTİ (mikrofon/bildirim/dosya) =================== */
function nativePlugin() {
  try {
    const c = window.Capacitor;
    if (c && c.Plugins && c.Plugins.BeastNative) return c.Plugins.BeastNative;
  } catch {}
  try { if (window.BeastNative) return window.BeastNative; } catch {}
  return null;
}

/* =================== ARKA PLAN BİLDİRİM (uygulama kapalıyken) =================== */
const POLL_KEY = 'bmPoll';
function pollEnabled() { try { return localStorage.getItem(POLL_KEY) !== '0'; } catch { return true; } }
function pollUrl() {
  try {
    const raw = localStorage.getItem('bmHost') || '';
    const tgt = parseTarget(raw);
    if (!tgt) return '';
    const scheme = tgt.mode === 'wss' ? 'https' : 'http';
    return scheme + '://' + tgt.host + ':' + tgt.port + '/notif';
  } catch { return ''; }
}
/* Alarmı kur: uygulama tamamen kapalıyken de masaüstü /notif ucu yoklanır */
function syncPoll() {
  const p = nativePlugin();
  if (!p || typeof p.setPoll !== 'function') return;
  if (!pollEnabled()) { try { p.clearPoll(); } catch {} return; }
  const url = pollUrl();
  const code = localStorage.getItem('bmCode') || '';
  if (!url || !code) return;
  try { p.setPoll({ url, code, everySec: 20 }); } catch {} /* bildirim ANONDA gelsin: 20 sn yoklama */
}

/* ---------- SÜREKLİ BAĞLANTI: Android ön plan servisi ----------
   WhatsApp gibi: uygulama arka planda iken WebSocket bağlantısı düşürülmez
   (sessiz küçük ikon bağlantıyı canlı tutar). */
function keepEnabled() { try { return localStorage.getItem(KEEP_KEY) !== '0'; } catch { return true; } }
function syncKeep() {
  keepAliveOn = keepEnabled();
  const p = nativePlugin();
  if (!p || typeof p.keepAlive !== 'function') return;
  try {
    if (keepAliveOn && joined) p.keepAlive({ on: true });
    else p.keepAlive({ on: false });
  } catch {}
}
function paintKeepSw() { try { const el = $('#swKeep'); if (el) el.classList.toggle('on', keepEnabled()); } catch {} }
(function bindKeepSw() {
  const el = document.getElementById('swKeep');
  if (!el) return;
  el.addEventListener('click', () => {
    const on = !keepEnabled();
    try { localStorage.setItem(KEEP_KEY, on ? '1' : '0'); } catch {}
    paintKeepSw();
    syncKeep();
    toast(on ? 'Sürekli bağlantı açık — arka planda bağlı kalır' : 'Sürekli bağlantı kapalı');
  });
})();

/* =================== AYARLAR SAYFASI (tam ekran) =================== */
function openSettings() {
  if (settingsOpen) return;
  settingsOpen = true;
  setPage.hidden = false;
  fillSettings();
  try { history.pushState({ beast: 'settings' }, ''); } catch {}
  try { segTheme.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === currentThemePref())); } catch {}
}
function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  setPage.hidden = true;
  try { if (history.state && history.state.beast === 'settings') history.back(); } catch {}
}
window.addEventListener('popstate', () => {
  if (settingsOpen) { settingsOpen = false; setPage.hidden = true; }
});
function fillSettings() {
  try {
    const h = localStorage.getItem('bmHost') || '—';
    $('#scHost').textContent = h;
    $('#scConn').textContent = (joined && ws && ws.readyState === 1) ? 'bağlı ✓' : 'arka planda bağlanıyor…';
    $('#scVer').textContent = 'sürüm 1.1 · arka plan canlı + gürültü engelleme';
  } catch {}
  paintPollSw();
  paintKeepSw();
  paintNoiseSw();
}

/* ARKA PLAN BİLDİRİM AÇ/KAPA */
const swPoll = $('#swPoll');
function paintPollSw() { try { swPoll.classList.toggle('on', pollEnabled()); } catch {} }
swPoll.addEventListener('click', () => {
  const on = !pollEnabled();
  try { localStorage.setItem(POLL_KEY, on ? '1' : '0'); } catch {}
  paintPollSw();
  syncPoll();
  toast(on ? 'Arka plan bildirimi açık' : 'Arka plan bildirimi kapalı');
});

/* =================== ELLER SERBEST SES (TTS) — TELEFONA ÖZEL ===================
   Kullanıcı buradan motoru seçer; masaüstü sohbet bitince cevabı BU ayarda
   seslendirip telefona yollar. Masaüstü WhatsApp TTS'İNDEN HİÇ ETKİLENMEZ —
   orası kendi ayarını kullanır, burası kendi ayarını. */
const TTS_KEY = 'bmTts';
const TTS_ENGINES = { ema: 'eMa', ahenk: 'Ahenk' };
function phoneTtsRead() {
  let c = { on: false, engine: 'ema' };
  try { c = Object.assign(c, JSON.parse(localStorage.getItem(TTS_KEY) || '{}')); } catch {}
  if (!TTS_ENGINES[String(c.engine || '')]) c.engine = 'ema';
  return c;
}
function phoneTtsWrite(c) { try { localStorage.setItem(TTS_KEY, JSON.stringify({ on: !!c.on, engine: String(c.engine || 'ema') })); } catch {} }
function paintTtsSw() {
  const c = phoneTtsRead();
  try { const el = $('#swTts'); if (el) el.classList.toggle('on', !!c.on); } catch {}
  try {
    const seg = $('#segTts');
    if (seg) seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.e === c.engine));
  } catch {}
}
function phoneTtsSync() {
  const c = phoneTtsRead();
  paintTtsSw();
  if (!c.on && talkActive()) talkCancel(true); /* seslendirme kapatıldı → akan sesi kes */
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'tts-cfg', enabled: !!c.on, engine: TTS_ENGINES[c.engine] ? c.engine : 'ema' })); } catch {}
  talkArm();
}
(function bindTts() {
  const sw = document.getElementById('swTts');
  if (sw) sw.addEventListener('click', () => {
    const c = phoneTtsRead();
    c.on = !c.on;
    phoneTtsWrite(c);
    phoneTtsSync();
    toast(c.on ? 'Seslendirme açık — ' + (TTS_ENGINES[c.engine] || 'eMa') : 'Seslendirme kapalı');
  });
  const seg = document.getElementById('segTts');
  if (seg) seg.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!b || !TTS_ENGINES[b.dataset.e]) return;
    const c = phoneTtsRead();
    c.engine = b.dataset.e;
    phoneTtsWrite(c);
    phoneTtsSync();
    if (c.on) toast('Ses motoru: ' + (TTS_ENGINES[c.engine] || 'eMa'));
  });
  paintTtsSw();
})();

/* =================== CANLI MOD GÜRÜLTÜ ENGELLEME ===================
   Motor/rüzgar gibi düşük frekanslı gürültüyü high-pass + low-pass ve
   yumuşak kompresörle azaltır. Tarayıcı/Android'in kendi noiseSuppression
   constraint'i de açık kalır; bu zincir onun üstüne filtre ekler. */
const NOISE_KEY = 'bmNoise';
function liveNoiseEnabled() {
  try { return localStorage.getItem(NOISE_KEY) !== '0'; } catch { return true; }
}
function paintNoiseSw() {
  try { const el = $('#swNoise'); if (el) el.classList.toggle('on', liveNoiseEnabled()); } catch {}
}
function applyLiveNoise() {
  const on = liveNoiseEnabled();
  try {
    if (liveHp && liveCtx) liveHp.frequency.setTargetAtTime(on ? 120 : 20, liveCtx.currentTime, 0.05);
    if (liveLp && liveCtx) liveLp.frequency.setTargetAtTime(on ? 7800 : 20000, liveCtx.currentTime, 0.05);
    if (liveComp && liveCtx) {
      /* kapalıyken kompresör nötr: eşik 0 dB, oran 1 */
      liveComp.threshold.setTargetAtTime(on ? -32 : 0, liveCtx.currentTime, 0.05);
      liveComp.ratio.setTargetAtTime(on ? 2.5 : 1, liveCtx.currentTime, 0.05);
    }
  } catch {}
  try {
    const track = liveStream && liveStream.getAudioTracks && liveStream.getAudioTracks()[0];
    if (track && track.applyConstraints) {
      track.applyConstraints({
        echoCancellation: true,
        noiseSuppression: on,
        autoGainControl: true,
        channelCount: 1,
      }).catch(() => {});
    }
  } catch {}
}
(function bindNoise() {
  const el = document.getElementById('swNoise');
  if (!el) return;
  el.addEventListener('click', () => {
    const on = !liveNoiseEnabled();
    try { localStorage.setItem(NOISE_KEY, on ? '1' : '0'); } catch {}
    paintNoiseSw();
    applyLiveNoise();
    toast(on ? 'Gürültü engelleme açık — motor/rüzgar sesi azaltılır' : 'Gürültü engelleme kapalı');
  });
  paintNoiseSw();
})();

/* sesli cevap oynatma — sohbetin KENDİ sesi.
   Masaüstü cevabı CÜMLE PARÇALARI halinde yollar; burada kuyruğa alınır ve
   kesintisiz çalınır. İlk parça hemen gelir, kalanı çalarken sentezlenir. */
let talkAud = null;
let talkQ = [];            /* [{ url, last }] — bekleyen ses parçaları */
let talkLast = false;      /* akışın son parçası geldi mi */
let talkStarted = false;   /* akışın ilk parçası geldi mi (12 sn TTS fallback'i için) */
let talkIgnoreOld = false; /* barge-in sonrası eski akışın gecikmiş parçalarını yoksay */

function talkActive() { return !!(talkAud || talkQ.length); }
function talkStopRemote() {
  try { if (ws && ws.readyState === 1 && sid) ws.send(JSON.stringify({ t: 'tts-stop', sid })); } catch {}
}
function talkStopAudio() {
  if (!talkAud) return;
  const a = talkAud;
  talkAud = null;
  try { a.onended = null; a.onerror = null; } catch {}
  try { a.pause(); } catch {}
}
/* canlı modda cevap bitti → otomatik dinlemeye dön */
function talkLiveListen() {
  if (!liveOn) return;
  liveBusy = false;
  liveWatchdogClear();
  liveSetLabel('dinliyorum…');
  liveOnsetMs = 0; liveBargeMs = 0; liveQuietSince = 0;
  liveSetMegaLive();
}
function talkDone() {
  talkQ = []; talkLast = false; talkStarted = false;
  setMega('hazır');
  talkLiveListen();
}
/* sesi kes: barge-in / yeni mesaj / canlı mod kapanışı */
function talkCancel(remote) {
  talkIgnoreOld = true;
  talkQ = []; talkLast = false; talkStarted = false;
  talkStopAudio();
  if (remote) talkStopRemote();
  talkLiveListen();
}
function talkPump() {
  if (talkAud) return; /* şu an bir parça çalıyor */
  if (!talkQ.length) {
    if (talkLast) talkDone(); /* son parça da bitti → dinlemeye dön */
    return;
  }
  const item = talkQ.shift();
  try {
    const a = new Audio(item.url);
    talkAud = a;
    liveSetLabel('konuşuyor…');
    setMega('🔊 sesli cevap çalıyor…', 'busy');
    const fin = () => {
      if (talkAud !== a) return; /* barge-in ile kesildi */
      talkAud = null;
      talkPump(); /* kuyrukta parça varsa hemen devam */
    };
    a.onended = fin;
    a.onerror = fin;
    a.play().catch(fin);
  } catch { talkPump(); }
}
/* canlı moda hazırlık: cevap çalarken yarım kalmış kaydı at (cevap öncelikli) */
function talkLivePrepare() {
  try {
    if (!liveOn) return;
    liveDoneClear();
    if (liveRec) { liveRec.onstop = null; try { liveRec.stop(); } catch {} liveRec = null; }
    liveChunks = [];
    liveOnsetMs = 0; liveBargeMs = 0; liveQuietSince = 0;
  } catch {}
}
/* tek parça / eski masaüstü sürümüyle uyum */
function talkPlay(url) {
  talkIgnoreOld = false;
  talkQ = []; talkLast = false; talkStarted = false;
  talkStopAudio();
  talkLivePrepare();
  talkStarted = true;
  talkQ.push({ url: String(url), last: true });
  talkPump();
}
/* akış parçası: seq 0 = yeni tur (eski kuyruğu temizle) */
function talkChunk(seq, url, last) {
  seq = Number(seq) || 0;
  if (seq === 0) {
    talkIgnoreOld = false;
    talkQ = []; talkLast = false; talkStarted = false;
    talkStopAudio();
    talkLivePrepare();
  } else if (talkIgnoreOld) {
    return; /* iptal edilen eski akışın gecikmiş parçası */
  }
  talkStarted = true;
  talkQ.push({ url: String(url), last: !!last });
  if (last) talkLast = true;
  talkPump();
}
/* akış bitti: kuyruk/çalan parça bitince dinlemeye dön */
function talkStreamEnd() {
  if (talkIgnoreOld) return;
  talkLast = true;
  talkPump();
}

/* =================== BİLDİRİM / TOAST =================== */
let toastT = 0;
function toast(txt) {
  try {
    toastEl.textContent = txt;
    toastEl.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove('on'), 3200);
  } catch {}
}

async function notifyIncoming(title, body) {
  /* UYGULAMAYI GÖRÜYORSAK BİLDİRİM YOK: ekrandaki chat açıkken sistem
     bildirimi gelmesin (WhatsApp davranışı — görünen sohbette zaten mesaj var) */
  try { if (appInForeground()) return; } catch {}
  try { if (navigator.vibrate) navigator.vibrate([40, 60, 40]); } catch {}
  const p = nativePlugin();
  if (p && typeof p.notify === 'function') {
    try { await p.notify({ title: title || 'Beast', body: String(body || '') }); return; } catch {}
  }
  toast(title + ': ' + body);
}

/* =================== OTURUM BİLGİSİ KAYDI =================== */
function saveCreds() {
  try {
    localStorage.setItem('bmHost', String(hostEl.value || '').trim());
    localStorage.setItem('bmCode', String(codeEl.value || '').trim().toUpperCase());
  } catch {}
}
function setAuthMode(mode) {
  const wait = (mode === 'wait');
  authEl.classList.toggle('remember', wait);
  authWait.style.display = wait ? 'flex' : 'none';
}
function showAuth(err) {
  appEl.style.display = 'none';
  authEl.style.display = 'flex';
  setAuthMode('form');
  if (err) errEl.textContent = err;
}
[hostEl, codeEl].forEach((el) => {
  el.addEventListener('input', () => {
    if (el === codeEl) el.value = el.value.toUpperCase();
    saveCreds();
  });
  el.addEventListener('change', saveCreds);
});

/* ======================= SLASH KOMUT MENÜSÜ ======================= */
const SLASH_CMDS = [
  { cmd: '/help', desc: 'tüm komutları listele' },
  { cmd: '/version', desc: 'Beast Agent sürümünü göster' },
  { cmd: '/new', desc: 'yeni sohbet aç (eski sohbet listede kalır)' },
  { cmd: '/open ', desc: 'koddaki oturuma geç' },
  { cmd: '/sessions', desc: 'bu sohbetin oturumları' },
  { cmd: '/stop', desc: 'çalışan her şeyi durdur + kilitle — kilit yalnız /start ile açılır' },
  { cmd: '/start', desc: 'kilidi aç; yeni istekler normal işlenir' },
  { cmd: '/restart', desc: 'uygulamayı yeniden başlat' },
  { cmd: '/change', desc: 'modelleri listele · /change 5 ile geç' },
  { cmd: '/model', desc: 'modeli göster/değiştir' },
  { cmd: '/think ', desc: 'düşünme seviyesi · /think 0-5 (0 kapalı)' },
  { cmd: '/clear', desc: 'oturum geçmişini GERÇEKTEN sil (kod korunur)' },
  { cmd: '/notes', desc: 'bu oturumun notlarını göster' },
  { cmd: '/autodel', desc: 'tüm otomatik hatırlatmaları sil · /autodel all: cron dahil hepsi' },
  { cmd: '/deltodo', desc: 'todo listesini temizle · /deltodo all: tüm oturumlar' },
  { cmd: '/rule ', desc: 'kalıcı kural ekle' },
  { cmd: '/rules', desc: 'kalıcı kuralları listele' },
  { cmd: '/agent ', desc: 'özel ajan bağla / listele' },
  { cmd: '/notify', desc: 'hata maili aç/kapa · /notify on|off' },
  { cmd: '/skills', desc: 'kurulu skill’ler' },
  { cmd: '/screenshot', desc: 'ekran görüntüsünü sohbete ekle' },
  { cmd: '/usage', desc: 'bugünkü kullanım' },
  { cmd: '/backup', desc: 'veriyi zip’e yedekle' },
  { cmd: '/status', desc: 'bağlantı ve servis durumu' },
  { cmd: '/update', desc: 'yeni sürüm kontrolü · /update now ile kur' },
];

function hideSlash() {
  if (!slashEl) return;
  slashEl.hidden = true;
  slashEl.innerHTML = '';
}
function slashMatches() {
  const v = String(inputEl.value || '');
  if (!v.startsWith('/') || v.includes('\n')) return null;
  const q = v.slice(1).toLowerCase().trim();
  return SLASH_CMDS.filter((c) =>
    !q
    || c.cmd.trim().toLowerCase().slice(1).startsWith(q)
    || c.desc.toLowerCase().includes(q));
}
function updateSlash() {
  if (!slashEl) return;
  const matches = slashMatches();
  if (!matches || !matches.length) { hideSlash(); return; }
  slashEl.innerHTML =
    '<div class="sm-sub">Hazır komutlar — dokun ya da Enter ile seç</div>' +
    matches.map((c, i) =>
      '<div class="sm-item' + (i === 0 ? ' sel' : '') + '" data-cmd="' + escHtml(c.cmd) + '">' +
      '<span class="sm-cmd">' + escHtml(c.cmd.trim()) + '</span>' +
      '<span class="sm-desc">' + escHtml(c.desc) + '</span></div>').join('');
  slashEl.hidden = false;
  slashEl.scrollTop = 0;
  for (const item of slashEl.querySelectorAll('.sm-item')) {
    item.addEventListener('click', () => pickSlash(item.dataset.cmd));
  }
  scroll();
}
function pickSlash(cmd) {
  hideSlash();
  inputEl.value = cmd;
  try { inputEl.focus({ preventScroll: true }); } catch { try { inputEl.focus(); } catch {} }
  const L = inputEl.value.length;
  try { inputEl.setSelectionRange(L, L); } catch {}
  keepKeyboard();
}

/* ---------- küçük yardımcılar ---------- */
const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (!b) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

/* durum yazısı "Beast"in YANINDA (yer yoksa ... ile kısaltılır) —
   nokta: yeşil=hazır, sarı=çalışıyor, kırmızı=hata */
function setMega(txt, cls) {
  if (hstat) hstat.textContent = txt || '';
  hdot.style.background = cls === 'busy' ? '#f4c542' : (cls === 'err' ? '#ff6b6b' : '#00cf70');
}

/* HER ZAMAN en son mesaja (aşağı) kaydır */
function scroll() {
  try { msgsEl.scrollTop = msgsEl.scrollHeight; } catch {}
  try {
    requestAnimationFrame(() => {
      try { msgsEl.scrollTop = msgsEl.scrollHeight; } catch {}
    });
  } catch {}
}

function bubbleRaw(role, html) {
  const row = document.createElement('div');
  row.className = 'row' + (role === 'me' ? ' me' : '');
  const b = document.createElement('div');
  b.className = 'bub';
  b.innerHTML = html || '&nbsp;';
  row.appendChild(b);
  msgsEl.appendChild(row);
  b.querySelectorAll('img').forEach((im) => { im.addEventListener('load', scroll); im.addEventListener('error', scroll); });
  scroll();
  return b;
}
function bubble(role, html) {
  const b = bubbleRaw(role, html);
  cacheRec({ r: role === 'me' ? 'me' : 'as', h: html || '&nbsp;' });
  return b;
}

function sysNote(txt) {
  const s = document.createElement('div');
  s.className = 'sysb';
  s.textContent = txt;
  msgsEl.appendChild(s);
  cacheRec({ r: 'sys', t: String(txt || '') });
  scroll();
}

/* ---------- ARAÇ (komut) BALONU ---------- */
/* araç adları → Türkçe karşılık (masaüstündeki isimlerle aynı) */
const TOOL_TR = {
  bash: 'komut çalıştır', run_command: 'komut çalıştır', shell: 'komut çalıştır',
  python_run: 'python çalıştır', python: 'python çalıştır',
  read: 'dosya oku', read_file: 'dosya oku',
  write: 'dosya yaz', write_file: 'dosya yaz',
  edit: 'dosya düzenle', edit_file: 'dosya düzenle',
  list: 'listele', list_dir: 'listele',
  glob: 'glob', grep: 'ara (grep)',
  webfetch: 'web getir', http_fetch: 'web getir',
  websearch: 'web ara', web_search: 'web ara',
  browser_open: 'tarayıcı aç', browser_read: 'tarayıcı oku', browser: 'tarayıcı',
  todowrite: 'todo yaz', task: 'alt ajan', skill: 'skill çalıştır',
  panel_run: 'panel çalıştır', send_file: 'dosya gönder', pdf_write: 'pdf yaz',
  memory: 'bellek', screenshot: 'ekran görüntüsü', file_send: 'dosya gönder',
};

/* Bir mesajdaki araç çağrıları (tool_calls) → [{name, args}] */
function toolCallsOf(msg) {
  const out = [];
  try {
    for (const tc of (Array.isArray(msg && msg.tool_calls) ? msg.tool_calls : [])) {
      if (!tc) continue;
      const name = (tc.function && tc.function.name) || tc.name || 'araç';
      let args = null;
      try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch {}
      out.push({ name, args });
    }
  } catch {}
  return out;
}

function toolDetailOf(args) {
  try {
    const a = args || {};
    const t = a.command || a.path || a.file_path || a.filePath || a.url || a.pattern || a.query || a.name || a.title;
    return t ? String(t).slice(0, 80) : '';
  } catch { return ''; }
}
function toolChipRow(name, detail) {
  const n = String(name || 'araç');
  const row = document.createElement('div');
  row.className = 'row';
  const b = document.createElement('div');
  b.className = 'toolbubble';
  b.innerHTML = '<b>⚙ ' + escHtml(n) + '</b>'
    + (TOOL_TR[n] ? '<span class="tl">' + escHtml(TOOL_TR[n]) + '</span>' : '')
    + (detail ? '<span class="td">' + escHtml(detail) + '</span>' : '');
  row.appendChild(b);
  /* araç balonu akış balonunun ÜSTÜNDE dursun (yoksa silinir) */
  if (streamEl && streamEl.parentElement) msgsEl.insertBefore(row, streamEl.parentElement);
  else msgsEl.appendChild(row);
  scroll();
  return row;
}
function toolChip(name, args) {
  const detail = toolDetailOf(args);
  toolChipRow(name, detail);
  cacheRec({ r: 'tool', n: String(name || 'araç'), d: detail });
}

/* ---------- DOSYA KARTI (ajan dosya gönderimi) ---------- */
function fileCard(ev) {
  ev = ev || {};
  const name = String(ev.name || 'dosya');
  const mime = String(ev.mime || '');
  const isImg = mime.indexOf('image/') === 0;
  const row = document.createElement('div');
  row.className = 'row';
  const b = document.createElement('div');
  b.className = 'filecard';
  b.innerHTML =
    '<div class="fc-top"><div class="fc-ico">' + (isImg ? '🖼' : '📄') + '</div><div style="min-width:0">' +
    '<div class="fc-name">' + escHtml(name) + '</div>' +
    '<div class="fc-sub">' + escHtml(fmtSize(ev.size)) +
    (ev.caption ? ' · ' + escHtml(String(ev.caption).slice(0, 90)) : '') + '</div></div></div>';
  if (isImg && ev.dataUrl) {
    const im = document.createElement('img');
    im.src = ev.dataUrl; im.alt = name;
    b.appendChild(im);
  }
  const btns = document.createElement('div');
  btns.className = 'fc-btns';
  const dl = document.createElement('button');
  dl.className = 'fcbtn'; dl.textContent = '💾 Kaydet';
  dl.addEventListener('click', () => saveFile(ev, name));
  const op = document.createElement('button');
  op.className = 'fcbtn'; op.textContent = '📂 Aç';
  op.addEventListener('click', () => openFile(ev, name));
  btns.append(dl, op);
  b.appendChild(btns);
  row.appendChild(b);
  msgsEl.appendChild(row);
  /* ÖNBELLEK: büyük dosyaların içeriği HARİÇ (ad/bayıt kaydıyla) saklanır */
  cacheRec({
    r: 'file',
    f: {
      name, mime,
      size: Number(ev.size) || 0,
      caption: String(ev.caption || ''),
      dataUrl: (!isImg || !ev.dataUrl || ev.dataUrl.length <= 160000) ? String(ev.dataUrl || '') : '',
    },
  });
  scroll();
}

async function saveFile(ev, name) {
  if (!ev.dataUrl) { toast('Dosya çok büyük — bilgisayarda açabilirsin'); return null; }
  const b64 = String(ev.dataUrl).split(',')[1] || '';
  const p = nativePlugin();
  if (p && typeof p.saveFile === 'function') {
    try {
      const r = await p.saveFile({ name, base64: b64, mime: ev.mime || 'application/octet-stream' });
      if (r && r.ok) { toast('Kaydedildi: ' + r.path); return r; }
      toast('Kaydedilemedi: ' + ((r && r.error) || '?'));
      return null;
    } catch { toast('Kaydedilemedi'); return null; }
  }
  try {
    const a = document.createElement('a');
    a.href = ev.dataUrl; a.download = name; a.click();
    toast('İndiriliyor: ' + name);
  } catch { toast('Kaydedilemedi'); }
  return null;
}

async function openFile(ev, name) {
  if (!ev.dataUrl) { toast('Dosya çok büyük — bilgisayarda açabilirsin'); return; }
  const b64 = String(ev.dataUrl).split(',')[1] || '';
  const p = nativePlugin();
  if (p && p.saveFile && p.openFile) {
    try {
      const r = await p.saveFile({ name, base64: b64, mime: ev.mime || 'application/octet-stream' });
      if (r && r.ok) {
        const o = await p.openFile({ path: r.path || '', uri: r.uri || '' });
        if (o && o.ok) { toast('Açılıyor: ' + name); return; }
        toast('Açılamadı — dosya galeride: ' + (r.path || name));
        return;
      }
    } catch {}
  }
  toast('Açılamadı');
}

/* content (string | parça dizisi) → düz metin — dedupe karşılaştırması için */
function contentText(c) {
  if (typeof c === 'string') return String(c).trim();
  if (Array.isArray(c)) return c.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('\n').trim();
  return '';
}

/* oturum seçici: kayıtlı sid listede varsa o, yoksa masaüstü aktifi, sonra ilk —
   böylece her bağlanışta 'open' gider ve snapshot döner */
function curSid(list, m) {
  if (sid && (list || []).some((s) => s && s.id === sid)) return sid;
  if (m && m.activeSid) return m.activeSid;
  const first = (list && list[0] && list[0].id) || '';
  return first;
}

/* ---------- SOHBET SEÇİCİ SHEET (telefondan seç + SİL) ---------- */
/* Masaüstüyle ENTEGRE: 🗑 basınca bilgisayardaki oturum da KALICI silinir
   (engine.deleteSession). WhatsApp/Telegram/Discord'a bağlı sohbetler ikon
   taşır — W / T / D rozetli; yerli sohbetler B rozetli. */
let lastSess = [];
const TRASH_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg>';
function chanIcon(s) {
  const c = String((s && s.chan) || '');
  if (c === 'wa') return { cls: 'wa', ch: 'W', title: (s && s.chanLabel) || 'WhatsApp bağlı' };
  if (c === 'tg') return { cls: 'tg', ch: 'T', title: (s && s.chanLabel) || 'Telegram bağlı' };
  if (c === 'dc') return { cls: 'dc', ch: 'D', title: (s && s.chanLabel) || 'Discord bağlı' };
  if (c === 'bm') return { cls: 'bm', ch: 'M', title: (s && s.chanLabel) || 'Beast Mobile (telefon)' };
  return { cls: 'lo', ch: 'B', title: 'bilgisayar sohbeti' };
}
function updSessTitle(curId, list) {
  try {
    const it = (list || []).find((s) => s && s.id === curId) || {};
    const label = String(it.chan === 'wa' ? 'W · ' : it.chan === 'tg' ? 'T · ' : it.chan === 'dc' ? 'D · ' : '') +
      String(it.title || curId || 'sohbet');
    if (sessTitleEl) sessTitleEl.textContent = label.slice(0, 24);
  } catch {}
}
function renderSessSheet(curSel) {
  if (!sessListEl) return;
  const rows = lastSess.map((s) => {
    const ic = chanIcon(s);
    return '<div class="ssrow' + (s.id === curSel ? ' cur' : '') + '" data-open="' + escHtml(s.id) + '">' +
      '<div class="chan ' + ic.cls + '">' + escHtml(ic.ch) + '</div>' +
      '<div class="b"><div class="t">' + escHtml(String(s.title || s.id).slice(0, 64)) + '</div>' +
      '<div class="d">' + escHtml((s.id === curSel ? 'açık · ' : '') + ic.title) + '</div></div>' +
      '<button class="del" data-del="' + escHtml(s.id) + '" aria-label="Sil">' + TRASH_SVG + '</button>' +
      '</div>';
  });
  sessListEl.innerHTML = rows.join('') ||
    '<div class="ssrow"><div class="b"><div class="t">hiç sohbet yok</div><div class="d">"＋" ile yenisi açılır</div></div></div>';
}
function openSessSheet() {
  try {
    renderSessSheet(sid);
    /* DROPDOWN KONUMU: her açılışta başlığın TAM ALTINA hizala (safe-area/
       klavye durumuna göre header yüksekliği oynar) */
    const panel = sessSheet.querySelector('.sspanel');
    if (panel) {
      const hdr = document.getElementsByTagName('header')[0];
      const top = (hdr ? hdr.getBoundingClientRect().bottom : 0) + 6;
      panel.style.top = Math.max(top, 40) + 'px';
    }
    sessSheet.hidden = false;
    /* taze liste: silme sırasında bilgisayar tarafı güncel olsun */
    try { if (wsReady()) ws.send(JSON.stringify({ t: 'sessions' })); else queueSend({ t: 'sessions' }); } catch {}
  } catch {}
}
function confirmAndDel(ssid) {
  const id = String(ssid || '');
  if (!id) return;
  const it = lastSess.find((s) => s && s.id === id) || {};
  const ic = chanIcon(it);
  let what = 'Bu sohbet telefonda ve BİLGİSAYARDA KALICI olarak silinsin mi?';
  if (ic.cls !== 'lo') what += ' (' + ic.title + ')';
  if (!window.confirm(what)) return;
  try {
    if (wsReady()) ws.send(JSON.stringify({ t: 'del', sid: id }));
    else { toast('bağlanınca silinecek'); queueSend({ t: 'del', sid: id }); }
  } catch { toast('bağlantı yok — silinemedi'); }
}

/* content (string ya da parça dizisi) → HTML */
function renderContent(content, attachments) {
  let out = '';
  if (typeof content === 'string') {
    out = mdLite(content);
  } else if (Array.isArray(content)) {
    for (const p of content) {
      if (p && p.type === 'text') out += mdLite(p.text || '');
      else if (p && p.type === 'image_url' && p.image_url && p.image_url.url) {
        out += '<img loading="lazy" src="' + escHtml(p.image_url.url) + '" alt="resim">';
      }
    }
  }
  for (const a of (attachments || [])) {
    const isImg = a && a.type === 'image' && a.dataUrl;
    const isAud = a && a.type === 'audio' && a.dataUrl;
    if (isAud) {
      out += '<audio controls preload="metadata" src="' + escHtml(a.dataUrl) + '"></audio>';
      if (a.duration) out += '<div class="fchip">🎤 ' + escHtml(fmtDur(a.duration)) + '</div>';
    } else if (isImg) {
      out += '<div class="fchip">▣ ' + escHtml(a.name || 'resim') + '</div><img src="' + escHtml(a.dataUrl) + '" alt="">';
    } else if (a && a.type === 'file') {
      out += '<div class="fchip">≡ ' + escHtml((a && a.name) || 'dosya') + '</div>';
    }
  }
  return out || '&nbsp;';
}

/* hafif markdown: kod blokları + kalın + link + satır sonu */
function mdLite(t) {
  const raw = String(t || '');
  if (!raw.trim()) return '';
  const parts = raw.split(/```/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const line1 = parts[i].indexOf('\n');
      const body = line1 >= 0 ? parts[i].slice(line1 + 1) : parts[i];
      parts[i] = '<code style="display:block;white-space:pre-wrap">' + escHtml(body) + '</code>';
      continue;
    }
    parts[i] = escHtml(parts[i])
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/\n/g, '<br>');
  }
  return parts.join('');
}

/* ---------- WS ---------- */
const TUNNEL_SUFFIXES = ['.ngrok-free.app', '.ngrok.io', '.ngrok-fe.app', '.trycloudflare.com', '.loca.lt', '.localtunnel.app'];

function parseTarget(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;
  let mode = '';
  const sm = v.match(/^(wss?|https?):\/\//i);
  if (sm) {
    mode = sm[1].toLowerCase() === 'https' ? 'wss' : sm[1].toLowerCase();
    v = v.slice(sm[0].length);
  }
  v = v.split('/')[0].trim();
  v = v.replace(/^www\./i, '');
  const pm = v.match(/:(\d+)$/);
  const port = pm ? Math.max(1, Math.min(65535, Number(pm[1]) || 0)) : 0;
  let host = pm ? v.slice(0, -pm[0].length) : v;
  host = host.replace(/^https?:\/\//, '');
  if (!host) return null;
  if (!mode) {
    const low = host.toLowerCase();
    mode = TUNNEL_SUFFIXES.some((sfx) => low.endsWith(sfx)) ? 'wss' : 'ws';
  }
  const eff = port || (mode === 'wss' ? 443 : 8788);
  return { host, port: eff, mode };
}

function connect() {
  closeWs();
  stopHeartbeat();
  clearTimeout(reconnectT);
  reconnectT = null;
  /* Çıkış yoluyla bağlan ekranındaysak kendiliğinden bağlanmayız —
     denenmeye devam etmemesi için sessizce çıkılır (bağlan butonu tekrar açar) */
  if (quitIntent) return;
  errEl.textContent = '';
  joined = false;
  const rawHost = String(hostEl.value || '').trim();
  const tgt = parseTarget(rawHost);
  if (!tgt) { errEl.textContent = 'PC adresi boş — örn. 192.168.1.34 ya da abc.ngrok-free.app'; showAuth(); return; }
  const { host, port, mode } = tgt;
  const cm = String(codeEl.value || '').toUpperCase().match(/BEAST-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}/);
  const code = cm ? cm[0] : '';
  if (!code) { errEl.textContent = 'Kod biçimi: BEAST-XXXX-XXXX'; showAuth(); return; }
  saveCreds();
  setMega(retryCount ? ('bağlanılıyor… · ' + (retryCount + 1) + '. deneme') : 'bağlanılıyor…', 'busy');
  try { ws = new WebSocket(mode + '://' + host + ':' + port); } catch { scheduleReconnect(); return; }
  let did = localStorage.getItem('bmDid');
  if (!did) { did = 'bm-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('bmDid', did); }
  ws.onopen = () => {
    ws.send(JSON.stringify({
      t: 'auth', code, name: 'Beast Mobil', platform: (/iPhone|iPad|iOS/.test(navigator.userAgent) ? 'ios' : 'android'), did,
    }));
  };
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    /* ARKA PLANDA SÜREKLİ BAĞLI KAL: BAĞLAN EKRANINA GERİ DÜŞME
       — sadece o an görünen yerde durumu yaz, sessizce yeniden bağlan */
    ws = null;
    stopHeartbeat();
    busy = false; typingEl.classList.remove('on');
    if (quitIntent || authEl.style.display === 'flex') return;
    if (joined || retryCount > 0 || appEl.style.display === 'flex') {
      setMega('bağlantı koptu — otomatik yeniden bağlanılıyor…', 'err');
    }
    scheduleReconnect();
  };
  ws.onerror = () => {};
}

/* yeniden bağlanma: artan gecikme (0.8s → en çok 12s), sonsuza kadar dener */
function scheduleReconnect() {
  if (quitIntent || authEl.style.display === 'flex') return;
  if (reconnectT) return;
  retryCount++;
  const d = Math.min(12000, Math.round(800 * Math.pow(1.6, Math.min(6, retryCount))));
  reconnectT = setTimeout(() => {
    reconnectT = null;
    connect();
  }, d);
}

/* ---------- KALP ATIŞI: kopukluğu KENDİMİZ anlayalım ----------
   25 sn'de bir ping; 70 sn pong yoksa soket canlı görünse bile KAPATILIR →
   onclose akçı yeniden bağlanır (mesajların sessizce yitip geçmediği emin olur) */
function startHeartbeat() {
  stopHeartbeat();
  lastPong = Date.now();
  pingT = setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ t: 'ping' })); } catch {}
    if (Date.now() - lastPong > 70000) {
      try { ws.close(); } catch {}
      try { if (ws) ws.onclose = null; } catch {}
      ws = null;
      stopHeartbeat();
      if (joined || appEl.style.display === 'flex') setMega('bağlantı hafif — yenileniyor…', 'err');
      scheduleReconnect();
    }
  }, 25000);
}
function stopHeartbeat() {
  if (pingT) { clearInterval(pingT); pingT = null; }
}
function wsDead() {
  try { return !ws || ws.readyState !== 1 || !joined || (lastPong && Date.now() - lastPong > 60000); } catch { return true; }
}

function closeWs() { try { if (ws) { ws.onclose = null; ws.close(); } } catch {} ws = null; }

/* ---------- GÖNDERİM KUYRUĞU: kopuklukta yazılan mesaj KAYBOLMAZ ----------
   Bağlantı yok ya da soket bayat (pong gelmiyor) ise mesaj kuyruğa düşer;
   bağlantı duyulduğunda sırayla gider — kullanıcının yazdığı yerde durur. */
function wsStale() { try { return lastPong > 0 && (Date.now() - lastPong > 65000); } catch { return false; } }
function wsReady() { try { return !!(ws && ws.readyState === 1 && joined && !wsStale()); } catch { return false; } }
function queueSend(obj) {
  outbox.push(obj);
  try { if (outbox.length > 12) outbox.shift(); } catch {}
  setMega('bağlantı yenileniyor — mesajın kuyrukta, bağlanınca gider', 'err');
}
function flushOutbox() {
  while (outbox.length && ws && ws.readyState === 1) {
    const o = outbox.shift();
    try { ws.send(JSON.stringify(o)); if (o && o.t === 'send') selfEcho++; } catch { break; }
  }
}

/* ---------- agent event akışı ---------- */
function handle(m) {
  const t = String(m.t || m.type || '');
  switch (t) {
    case 'auth-ok':
      joined = true;
      retryCount = 0;
      authEl.style.display = 'none';
      appEl.style.display = 'flex';
      setMega('bağlandı ✓');
      scroll();
      startHeartbeat();
      flushOutbox();
      syncPoll();
      syncKeep();
      phoneTtsSync(); /* telefonun ses motoru seçimini masaüstüne bildir */
      openSession(sid);
      break;
    case 'auth-bad':
      quitIntent = true; /* kod yanlış — sonsuza kadar deneme yapma, ekran açılsın */
      clearTimeout(reconnectT);
      stopHeartbeat();
      errEl.textContent = m.why || 'kod yanlış';
      setMega('kod reddedildi', 'err');
      showAuth();
      break;
    case 'sessions': {
      const list = Array.isArray(m.list) ? m.list : null;
      if (!list) break;
      lastSess = list; /* seçici sheet'in kaynağı — telefondan sil + ikonlar */
      const cur = curSid(list, m);
      updSessTitle(cur, list);
      renderSessSheet(cur);
      if (cur && cur !== sid) openSession(cur);
      else if (!cur && !msgsEl.children.length) sysNote('bilgisayarda hiç sohbet kalmadı — "＋" ile (sağ üst) yeni sohbet aç; yazarak da başlayabilirsin');
      break;
    }
    case 'session-del': {
      const dSid = String(m.sid || '');
      if (m.ok) {
        toast('sohbet silindi ✓ — bilgisayarından da kaldırıldı');
        try { sessSheet.hidden = true; } catch {}
        if (dSid === sid) {
          /* O AN AÇIK olanı sildik: ekranı temizle; 'sessions' yayınında
             en güncel diğer sohbe te otomatik geçilir */
          msgsEl.innerHTML = '';
          streamEl = null; streamBuf = ''; lastFin = '';
          chatArr = []; chatFlush();
          sysNote('bu sohbet silindi — en güncel sohbete geçiliyor…');
          setMega('sohbet silindi', '');
        }
      } else {
        toast('silinemedi: ' + String(m.why || 'hata'));
      }
      break;
    }
    case 'session-switch':
      openSession(m.sessionId || '');
      break;
    case 'phone-tts':
      /* ELLER SERBEST: masaüstü cevabı telefonun SEÇTİĞİ motorla seslendirdi —
         yalnız bunu açık tutan telefonda çalar, masaüstü TTS'iyle ilişiği yok.
         AKIŞ: seq 0 ilk parça; last son parça; telefon kuyruğa alıp çalar. */
      if (String(m.sessionId || '') !== sid || !m.dataUrl) break;
      /* ÇİFT KİLİT: ayar kapalıysa (ve canlı mod değilse) gelen sesi ÇALMA */
      if (!phoneTtsRead().on && !liveOn) break;
      if (m.seq != null) talkChunk(m.seq, String(m.dataUrl), !!m.last);
      else talkPlay(String(m.dataUrl));
      break;
    case 'phone-tts-end':
      /* sentez yarıda kaldı ama parçalar çaldı — kilit beklemesin */
      if (String(m.sessionId || '') !== sid) break;
      if (!phoneTtsRead().on && !liveOn) break;
      talkStreamEnd();
      break;
    case 'message': {
      if (String(m.sessionId || '') !== sid) break;
      const msg = m.message || {};
      const role = String(msg.role || 'assistant');
      if (role === 'user') {
        closeStream(true);
        typingEl.classList.add('on');
        setMega('gönderildi — cevap bekleniyor…', 'busy');
        lastFin = '';
        bubble('me', renderContent(msg.content || '', msg.attachments));
        if (selfEcho > 0) { selfEcho--; }
        else { notifyIncoming('Beast', 'Yeni mesaj'); }
      } else {
        const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
        const fin = contentText(msg.content);
        if (fin && (fin === lastFin || (streamEl && streamBuf.trim() === fin))) {
          closeStream(false);
          if (!hasTools) { busy = false; typingEl.classList.remove('on'); setMega('hazır'); }
          break;
        }
        closeStream(false);
        const clean = String(typeof msg.content === 'string' ? msg.content : '').trim();
        if (!clean && !Array.isArray(msg.content)) break;
        bubble('assistant', renderContent(msg.content || '', msg.attachments));
        lastFin = fin;
        if (!hasTools) { busy = false; typingEl.classList.remove('on'); setMega('hazır'); }
        /* AJAN CEVABI: arka plandayken bildirim gönder */
        if (clean) {
          notifyIncoming('Beast', clean.slice(0, 110));
        }
      }
      break;
    }
    case 'token': {
      if (String(m.sessionId || '') !== sid) break;
      busy = true; typingEl.classList.remove('on');
      const delta = m.delta == null ? '' : String(m.delta);
      if (!streamEl) { streamEl = bubble('assistant', ''); streamBuf = ''; }
      streamBuf += delta;
      streamEl.innerHTML = mdLite(streamBuf);
      scroll();
      break;
    }
    case 'status': {
      if (String(m.sessionId || '') !== sid) break;
      setMega(String(m.status || 'çalışıyor…'), 'busy');
      break;
    }
    case 'tool-start':
      if (String(m.sessionId || '') === sid) toolChip(String(m.name || m.tool || 'araç'), m.args);
      break;
    case 'file':
      if (String(m.sessionId || '') === sid) fileCard(m);
      break;
    case 'done':
      closeStream(false);
      busy = false; typingEl.classList.remove('on');
      setMega('hazır');
      liveOnDone(); /* canlı mod: TTS gecikirse dinlemeye dön */
      break;
    case 'error':
      closeStream(false);
      busy = false; typingEl.classList.remove('on');
      setMega('hata: ' + String((m.error || m.message || 'bilinmiyor')).slice(0, 90), 'err');
      break;
    case 'clear':
      if (String(m.sessionId || '') === sid) {
        msgsEl.innerHTML = '';
        streamEl = null; streamBuf = '';
        lastFin = '';
        chatArr = []; cacheDirty = false;
        try { localStorage.removeItem('bmChat:' + sid); } catch {}
        setMega('geçmiş silindi · sıfırdan yazabilirsin');
      }
      break;
    case 'session':
      handleSessionSnapshot(m);
      break;
    case 'pong':
      lastPong = Date.now();
      break;
    default:
      break;
  }
}

function closeStream(keepAlive) {
  if (streamEl) {
    if (streamBuf.trim()) {
      const html = mdLite(streamBuf);
      streamEl.innerHTML = html;
      lastFin = streamBuf.trim();
      /* AKIŞ DONAR → ÖNBELLEK: canlı token akışı bitince sohbete kaydedilir */
      if (!cacheSuspend) cacheRec({ r: 'as', h: html });
    } else {
      /* BOS AKIS BALONU: her zaman silinir — aksi halde ekranda bos baloncuk kalir */
      try { streamEl.parentElement.remove(); } catch {}
    }
  }
  streamEl = null; streamBuf = '';
  if (!keepAlive) typingEl.classList.remove('on');
  if (cacheDirty) chatFlush();
  scroll();
}

/* ---------- komut gönderimleri ---------- */
/* ---------- SOHBET ÖNBELLEĞİ (WhatsApp gibi kalıcı gösterim) ----------
   KAYIT: her balon/araç satırı bir kayıttır — {r:'me'|'as'|'tool'|'sys'|'file', ...}.
   Önbellekte bizzat üretilmiş HTML saklanır (bize ait içerik); boyut ~1MB'i
   geçerse arkadan (en eskilerden) kırpılır. */
function chatLoad(s) {
  try { const v = JSON.parse(localStorage.getItem('bmChat:' + s) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function chatFlush() {
  if (!sid || !cacheDirty) return;
  cacheDirty = false;
  let keep = chatArr;
  try {
    while (keep.length > 4) {
      const bytes = JSON.stringify(keep).length;
      if (bytes < 950000) break;
      keep = keep.slice(20); /* arkadan 20 kayıt at (en eski) */
    }
    if (keep.length > 160) keep = keep.slice(-160);
    localStorage.setItem('bmChat:' + sid, JSON.stringify(keep));
  } catch {}
}
function cacheRec(rec) {
  if (cacheSuspend || !sid) return;
  chatArr.push(rec);
  cacheDirty = true;
  if (chatArr.length > 200) { chatArr = chatArr.slice(-200); }
}
function cacheBegin() { chatArr = []; cacheDirty = true; }
function cacheEnd() { chatFlush(); }
/* önbellekteki kayıtları ekrana bas: app açılışında / oturuma geri dönüşte */
function chatRender() {
  cacheSuspend = true;
  try {
    msgsEl.innerHTML = '';
    for (const rec of chatArr) {
      try {
        if (rec.r === 'me' || rec.r === 'as') bubbleRaw(rec.r === 'me' ? 'me' : 'assistant', rec.h);
        else if (rec.r === 'tool') toolChipRow(rec.n, rec.d || '');
        else if (rec.r === 'file') fileCard(rec.f || {});
        else if (rec.r === 'sys') sysNote(rec.t || '');
      } catch {}
    }
  } finally { cacheSuspend = false; }
}

function openSession(id) {
  const next = String(id || '');
  if (!next) return;
  const prev = String(sid || '');
  if (prev && prev !== next) talkCancel(true); /* eski oturumun sesi/akışı bitsin */
  sid = next;
  localStorage.setItem('bmSid', sid);
  updSessTitle(sid, lastSess);
  msgsEl.innerHTML = '';
  streamEl = null; streamBuf = '';
  lastFin = '';
  /* ÖNBELLEK İLE AÇ: sohbetten çıkıp geri girişte / app açılışında geçmiş
     ANINDA ekranda — masaüstü snapshotı gelince tazelenecek */
  chatArr = chatLoad(next);
  cacheDirty = false;
  chatRender();
  setMega(chatArr.length ? 'hazır' : 'geçmiş yükleniyor…', chatArr.length ? '' : 'busy');
  clearTimeout(snapT);
  if (!chatArr.length) {
    snapT = setTimeout(() => {
      if (streamEl || msgsEl.children.length) return;
      sysNote('geçmiş yüklenemedi — masaüstü uygulaması güncel sürüm olsun (yeni sürümde otomatik)');
      setMega('geçmiş yok — yine de yazabilirsin');
    }, 4000);
  }
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'open', sid: sid })); } catch {}
  talkArm(); /* seslendirme açıksa bu oturumu masaüstüne yeniden işaretle */
}

/* ELLER SERBEST BİLDİRİM: "Cevabı seslendir" açıkken açık oturum her
   turda masaüstü tarafında seslendirme penceresinde kalsın (15 dk faaliyet) */
function talkArm() {
  try {
    const on = !!phoneTtsRead().on;
    if (ws && ws.readyState === 1 && sid) ws.send(JSON.stringify({ t: 'talk', sid, on }));
  } catch {}
}

function handleSessionSnapshot(m) {
  clearTimeout(snapT);
  if (String(m.sid || '') !== sid) return;
  /* ESKİ MASAÜSTÜ KALKANI: sunucu snapshot'ı tool_calls/dosya kaydı
     TAŞIMIYORSA (eski sürüm) canlı ekrandaki SON araç balonları + dosya
     kartları silinmesin — önbelleğin sonundakiler sona geri eklenir */
  const oldArr = chatArr.slice();
  const list = Array.isArray(m.messages) ? m.messages.slice(-80) : [];
  let serverHasExtras = false;
  for (const msg of list) {
    if (!serverHasExtras && toolCallsOf(msg).length) serverHasExtras = true;
    if (!serverHasExtras && (Array.isArray(msg.attachments) ? msg.attachments : []).some((a) => a && a.type === 'file')) serverHasExtras = true;
    if (serverHasExtras) break;
  }
  msgsEl.innerHTML = '';
  streamEl = null; streamBuf = '';
  lastFin = '';
  cacheBegin(); /* önbellek tazele: sunucu snapshotlarına birebir ayarlı */
  for (const msg of list) {
    const role = String(msg.role || 'assistant');
    /* GEÇMİŞTEKİ ARAÇ KAYITLARI: tool_calls -> araç balonu (isim + detay).
       tool_calls olmayan canlı akışta 'tool-start' eventi zaten basıyor. */
    for (const tc of toolCallsOf(msg)) toolChip(tc.name, tc.args);
    const files = (Array.isArray(msg.attachments) ? msg.attachments : []).filter((a) => a && a.type === 'file');
    const txt = contentText(msg.content);
    if (files.length && /^📄/.test(txt)) {
      /* KALICI DOSYA KARTI: künye balonu yerine gerçek kart yeniden basılır —
         PDF/dosya WhatsApp gibi sohbette KALIR */
      for (const f of files) fileCard({ name: f.name, mime: f.mime || '', size: Number(f.size) || 0, caption: f.caption || '' });
      continue;
    }
    const hasAtt = Array.isArray(msg.attachments) && msg.attachments.length > 0;
    if (!txt && !hasAtt) continue; /* boş baloncuk basma */
    const html = renderContent(msg.content || '', msg.attachments);
    if (role === 'user') { bubble('me', html); }
    else { bubble('assistant', html); }
  }
  if (!serverHasExtras) {
    for (let i = oldArr.length - 1; i >= 0; i--) {
      const rec = oldArr[i];
      if (!rec) continue;
      if (rec.r === 'me' || rec.r === 'as') break;
      if (rec.r === 'tool' || rec.r === 'file') cacheRec(rec);
    }
  }
  if (!list.length) sysNote('bu sohbette henüz mesaj yok — yazabilirsin');
  cacheEnd();
  setMega('hazır');
  scroll();
}

function sendMessage() {
  const text = String(inputEl.value || '').trim();
  const atts = pending.slice();
  if (!text && !atts.length) return;
  if (!sid) { setMega('oturum açılıyor — bekley…', 'err'); return; }
  if (talkActive()) talkCancel(true); /* yeni mesaj → eski cevabın sesi kesilsin */
  const isCmd = text.startsWith('/');
  const payload = { t: 'send', sid, text };
  if (atts.length && !isCmd) payload.attachments = atts;
  /* KOPUKLUK SIGORTASI: bağlantı yok ya da soket bayat ise mesaj KUYRUĞA
     düşer — KAYBOLMAZ; bağlantı gelince kendiliğinden gider (yazdığın yerde
     durur, WhatsApp'taki 'gönderiliyor' gibi) */
  if (!wsReady()) {
    queueSend(payload);
    toast(isCmd ? 'bağlantı bekleniyor — komut kuyrukta' : 'bağlantı bekleniyor — mesaj kuyrukta');
    return;
  }
  try { ws.send(JSON.stringify(payload)); } catch { queueSend(payload); return; }
  selfEcho++;
  inputEl.value = '';
  pending = [];
  renderAtt();
  hideSlash();
  setMega('gönderildi', 'busy');
  keepKeyboard();
  scroll();
}

/* klavye kapanmasın: input odağını koru */
function keepKeyboard() {
  try { inputEl.focus({ preventScroll: true }); } catch { try { inputEl.focus(); } catch {} }
  scroll();
}

/* ---------- SESLİ MESAJ (kayıt) ---------- */
let mediaRec = null, recChunks = [], recTimer = null, recStartTs = 0, recStream = null, recCancel = false;
let recMode = 'web'; /* 'web' = WebView getUserMedia, 'native' = Android MediaRecorder */
let micSettingsTold = false; /* izin kalıcı kapalıysa ayar ekranına yönlendirme bir kez */

function recUI(on) {
  const bar = $('#recbar');
  if (bar) {
    bar.hidden = !on;
    /* KAYIT SIRASINDA gönder tuşları EN SAĞDA: recbar'ı sona al, içini sıkıştır */
    bar.style.flex = on ? '0 0 auto' : '';
    bar.style.order = on ? '2' : '';
  }
  /* KLAVYE KAPANMASIN: kutu yerinde kalır, yalnız yazma kilitli
     (eskiden input display:none yapılıyordu → klavye kapanıyordu) */
  inputEl.readOnly = on;
  try { $('#attach').style.display = on ? 'none' : ''; } catch {}
  try { $('#send').style.display = on ? 'none' : ''; } catch {}
  try { $('#live').style.display = on ? 'none' : ''; } catch {}
  /* PTT: mikrofon görünür KALIR — parmak altında; bırakınca gönderir */
  micEl.classList.toggle('rec', on);
  const hint = $('#recHint');
  if (hint) hint.style.display = 'none';
  if (on) $('#recTime').textContent = '0:00';
}

/* Mikrofon açılışı — PTT HIZI KRİTİK:
   1) ANDROID İZNİ: yerel istem (RECORD_AUDIO) istenir — onaylıysa anında döner.
   2) YEREL KAYIT DOĞRUDAN: WebView getUserMedia turu YOK — parmak kalkmadan
      kayıt başlar (AAC/m4a, native MediaRecorder). Eskiden önce WebView akışı
      deneniyordu; izin köprüsü gecikince ilk basış boşa gidiyordu.
   3) WebView akışı yalnız masaüstü tarayıcıda / plugin yoksa yedek. */
async function getMicStream() {
  const p = nativePlugin();
  /* 1) Android iznini garanti et */
  if (p && typeof p.requestMic === 'function') {
    try {
      const r = await Promise.race([
        p.requestMic(),
        new Promise((res) => setTimeout(() => res(null), 12000)), /* diyalog takılırsa da geçme */
      ]);
      if (r && r.granted === false) {
        toast('Mikrofon izni kapalı — ayarlardan aç: Uygulamalar → Beast Mobile → İzinler');
        setMega('mikrofon izni yok — ayarlardan aç', 'err');
        if (!micSettingsTold && typeof p.openAppSettings === 'function') {
          micSettingsTold = true;
          try { await p.openAppSettings(); } catch {}
        }
        return null;
      }
    } catch {}
  }
  /* 2) YEREL KAYIT ÖNCE — anında başlasın */
  if (p && typeof p.startRec === 'function') {
    try {
      const r = await p.startRec({ maxSec: 120, noise: liveNoiseEnabled() });
      if (r && r.ok) return { native: true };
    } catch {}
  }
  /* 3) masaüstü tarayıcı / plugin yok: WebView akışı */
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      const noise = liveNoiseEnabled();
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: noise,
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch {}
  }
  toast('Mikrofona erişilemedi — izni ayarlardan açmayı dene');
  setMega('mikrofona erişilemedi', 'err');
  return null;
}

/* PTT: kullanıcı akış çözülmeden BIRAKTIYSA kararı burada uygula */
function pttPendingApply() {
  if (!pttPendingEnd) return false;
  const act = pttPendingEnd;
  pttPendingEnd = '';
  if (act === 'cancel') { stopRec(true); return true; }
  if (act === 'short') { stopRec(true); toast('çok kısa — basılı tutarak konuş'); return true; }
  /* 'slow': açılış bırakmadan sonra tamamlandı — konuşma kaçtı; yanlış
     "çok kısa" yerine dürüst uyarı */
  stopRec(true);
  toast('mikrofon geç açıldı — tekrar basılı tut');
  return true;
}

let micOpening = false; /* tek uçuş: izin/açılış sürerken ikinci toggleRec yok */
async function toggleRec() {
  if (mediaRec) { stopRec(false); return; }
  if (micOpening) return;
  micOpening = true;
  try {
    const stream = await getMicStream();
    if (!stream) return;
    recChunks = [];
    recCancel = false;
    recStartTs = Date.now();
    if (stream.native) {
    /* YEREL KAYIT: Android MediaRecorder çalışıyor — WebView ile iş yok */
    recMode = 'native';
    mediaRec = { native: true, state: 'recording' };
    recTimer = setInterval(() => {
      const s = Math.floor((Date.now() - recStartTs) / 1000);
      const t = $('#recTime');
      if (t) t.textContent = fmtDur(s);
      if (s >= 118) stopRec(false);
    }, 250);
    recUI(true);
    setMega('ses kaydediliyor…', 'busy');
    if (pttPendingApply()) return;
    return;
  }
  recMode = 'web';
  recStream = stream;
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  let mime = '';
  for (const t of types) {
    try { if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) { mime = t; break; } } catch {}
  }
  try {
    mediaRec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (e) {
    try { mediaRec = new MediaRecorder(stream); } catch (e2) { toast('Kayıt başlatılamadı'); return; }
  }
  mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  mediaRec.onstop = onRecStopped;
  try { mediaRec.start(); } catch (e) { toast('Kayıt başlatılamadı'); return; }
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStartTs) / 1000);
    const t = $('#recTime');
    if (t) t.textContent = fmtDur(s);
    if (s >= 118) stopRec(false);
  }, 250);
  recUI(true);
  setMega('ses kaydediliyor…', 'busy');
  if (pttPendingApply()) return;
  } finally {
    micOpening = false;
  }
}

function stopRec(cancel) {
  recCancel = !!cancel;
  if (recMode === 'native' && mediaRec) {
    /* native kayıt: durdurma sonucu stopRec() native metodundan gelir */
    mediaRec = null;
    clearInterval(recTimer); recTimer = null;
    recUI(false);
    nativeRecordFinish();
    return;
  }
  const r = mediaRec;
  if (r && r.state !== 'inactive') {
    try { r.stop(); } catch {}
  } else {
    clearInterval(recTimer); recTimer = null;
    recUI(false);
  }
}

/* YEREL KAYIT BİTİŞİ: dosya Android'e yazılır, base64 dataUrl döner → sohbete ek */
async function nativeRecordFinish() {
  const p = nativePlugin();
  if (!p || typeof p.stopRec !== 'function') { setMega('hazır'); return; }
  try {
    if (recCancel) {
      try { await p.cancelRec(); } catch {}
      setMega('hazır');
      return;
    }
    const r = await Promise.race([
      p.stopRec(),
      new Promise((res) => setTimeout(() => res(null), 10000)),
    ]);
    if (!r || !r.ok || !r.dataUrl) {
      toast('Kayıt alınamadı' + (r && r.error ? ': ' + r.error : ''));
      setMega('hazır');
      return;
    }
    const dur = Math.round((Date.now() - recStartTs) / 1000);
    const mime = String(r.mime || 'audio/mp4');
    const ext = mime.indexOf('mp4') >= 0 ? 'm4a' : (mime.indexOf('ogg') >= 0 ? 'ogg' : 'webm');
    sendAudio(String(r.dataUrl), 'sesli mesaj.' + ext, dur);
  } catch (e) {
    try { await p.cancelRec(); } catch {}
    toast('Kayıt gönderilemedi');
    setMega('hazır');
  }
}

async function onRecStopped() {
  try { if (recStream) recStream.getTracks().forEach((t) => t.stop()); } catch {}
  const mr = mediaRec;
  mediaRec = null; recStream = null;
  clearInterval(recTimer); recTimer = null;
  recUI(false);
  if (recCancel || !mr) { setMega('hazır'); return; }
  const dur = Math.round((Date.now() - recStartTs) / 1000);
  const mt = String(mr.mimeType || 'audio/webm');
  let blob;
  try { blob = new Blob(recChunks, { type: mt }); } catch { blob = null; }
  recChunks = [];
  if (!blob || !blob.size) { setMega('hazır'); return; }
  const dataUrl = await blobToDataUrl(blob);
  const ext = mt.indexOf('mp4') >= 0 ? 'm4a' : (mt.indexOf('ogg') >= 0 ? 'ogg' : 'webm');
  sendAudio(dataUrl, 'sesli mesaj.' + ext, dur);
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    try {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => resolve('');
      r.readAsDataURL(blob);
    } catch { resolve(''); }
  });
}

function sendAudio(dataUrl, name, duration, live) {
  if (!sid || !dataUrl) { setMega('oturum açılıyor — bekley…', 'err'); return; }
  if (talkActive()) talkCancel(true); /* yeni sesli mesaj → eski cevabın sesi kesilsin */
  const payload = {
    t: 'send', sid, text: '', live: !!live,
    attachments: [{ type: 'audio', name, duration, dataUrl }],
  };
  if (!wsReady()) {
    queueSend(payload);
    toast('bağlantı bekleniyor — ses kaydı kuyrukta');
    return;
  }
  try { ws.send(JSON.stringify(payload)); } catch { queueSend(payload); return; }
  selfEcho++;
  setMega(live ? 'canlı — gönderildi' : 'sesli mesaj gönderildi', 'busy');
  if (live) { liveSetLabel('düşünüyor…'); } else keepKeyboard();
  scroll();
}

/* ---------- ek ekleme (kamera/galeri) ---------- */
function renderAtt() {
  if (!pending.length) { attwrapEl.style.display = 'none'; attwrapEl.innerHTML = ''; return; }
  attwrapEl.style.display = 'flex';
  attwrapEl.innerHTML = '';
  pending.forEach((a, i) => {
    const c = document.createElement('span');
    c.className = 'c';
    const label = document.createTextNode((a.type === 'image' ? '▣ ' : '≡ ') + (a && a.name || 'dosya'));
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('click', () => { pending.splice(i, 1); renderAtt(); });
    c.appendChild(label);
    c.appendChild(x);
    attwrapEl.appendChild(c);
  });
}

function attachImage() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.multiple = true;
  inp.onchange = () => {
    for (const f of [...inp.files]) {
      if (f.size > 8 * 1024 * 1024) { sysNote('çok büyük (max 8MB): ' + f.name); continue; }
      if (!String(f.type).startsWith('image/')) { sysNote('şimdilik sadece resim: ' + f.name); continue; }
      if (pending.length >= 6) { sysNote('en fazla 6 ek'); break; }
      const r = new FileReader();
      r.onload = () => {
        pending.push({ type: 'image', name: f.name, dataUrl: String(r.result) });
        renderAtt();
        keepKeyboard();
      };
      r.readAsDataURL(f);
    }
    keepKeyboard();
  };
  inp.click();
}

/* ---------- başlatma ---------- */
function manualConnect() {
  quitIntent = false; /* kullanıcı kendisi Bağlan'a bastı → arka plan otomatik moda geri döner */
  retryCount = 0;
  connect();
}
btnJoin.addEventListener('click', manualConnect);
codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') manualConnect(); });
hostEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') manualConnect(); });
sendEl.addEventListener('click', () => { sendMessage(); });

/* ---------- BASKILI KONUŞMA (PTT, WhatsApp tarzı) ----------
   parmak BASTIĞINDA kayıt başlar; BIRAKINCA otomatik GÖNDERilir.
   Çok kısa dokunuş (<600ms) → iptal + uyarı.
   Sola sürükleyip bırakma → kayıt SİLİNİR (WhatsApp'taki gibi). */
let micDown = false, micDownAt = 0, micDownX = 0, micDragX = 0, pttPendingEnd = '';
function pttDragVisual(dragging) {
  micEl.classList.toggle('delstate', !!dragging);
  const hint = $('#recHint');
  if (hint) {
    hint.style.display = dragging ? '' : 'none';
    hint.textContent = '⬄ bırak — kayıt silinir';
  }
}
micEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  try { micEl.setPointerCapture(e.pointerId); } catch {}
  if (micDown) return;
  micDown = true;
  micDownAt = Date.now();
  micDownX = e.clientX;
  micDragX = 0;
  pttPendingEnd = '';
  if (!mediaRec) toggleRec(); /* açılış tek uçuşlu — toggleRec kendi kilitler */
  pttDragVisual(false);
});
micEl.addEventListener('pointermove', (e) => {
  if (!micDown) return;
  micDragX = e.clientX - micDownX;
  pttDragVisual(micDragX < -70);
});
function pttUp() {
  if (!micDown) return;
  micDown = false;
  pttDragVisual(false);
  const held = Date.now() - (micDownAt || Date.now());
  if (!mediaRec) {
    /* KAYIT henüz başlamadı (izin/açılış turu sürüyor) — karar SÜREYE göre:
       kısa dokunuş → iptal; uzun basış → açılış gecikti (toggleRec sonunda ele alınır) */
    pttPendingEnd = micDragX < -70 ? 'cancel' : (held < 600 ? 'short' : 'slow');
    return;
  }
  if (micDragX < -70) stopRec(true); /* sola sürükle → sil */
  else if (held < 600) { stopRec(true); toast('çok kısa — basılı tutarak konuş'); }
  else stopRec(false); /* bırak → otomatik GÖNDER */
}
/* parmak butonun dışında kalkarsa da yakala (pointer capture kaybolursa) */
window.addEventListener('pointerup', () => { pttUp(); }, true);
micEl.addEventListener('pointerup', () => { pttUp(); });
micEl.addEventListener('pointercancel', () => {
  /* sistem dokunuşu iptal etti (klavye/dialog) — GÖNDERME, kaydı sil */
  if (!micDown) return;
  micDragX = -999;
  pttUp();
});
/* Uygulama arka plana gidince PTT kaydı iptal edilir; CANLI MOD İSE DEVAM EDER.
   Mikrofonlu ön plan servisi (KeepService/microphone FGS) sayesinde Android
   WebView'i arka planda mikrofon akışını sürdürebilir. AudioContext ara sıra
   askıya alınırsa uyanık tut. */
document.addEventListener('visibilitychange', () => {
  if (liveOn) {
    try { if (liveCtx && liveCtx.state === 'suspended') liveCtx.resume().catch(() => {}); } catch {}
    if (!document.hidden) scroll();
    return;
  }
  if (!document.hidden) return;
  if (!mediaRec && !micDown) return;
  micDown = false;
  pttPendingEnd = '';
  if (mediaRec) stopRec(true);
});
$('#recCancel').addEventListener('click', () => stopRec(true));
$('#recSend').addEventListener('click', () => stopRec(false));

/* =================== CANLI KONUŞMA (ELLER SERBEST) ===================
   Telefon mikrofonu sürekli dinler (Web Audio VAD). Konuşma başlayınca
   kaydeder; ~0.9 sn sessizlikte parçayı masaüstüne yollar. Masaüstü
   STT → ajan → TTS yapar, ses telefona döner. Ses bitince otomatik
   dinlemeye döner. Cevap çalarken konuşursan sesi keser (barge-in). */
let liveOn = false, liveStream = null, liveCtx = null, liveAnalyser = null, liveTD = null;
let liveProcStream = null, liveHp = null, liveLp = null, liveComp = null;
let liveBuf = null, liveRec = null, liveChunks = [], liveRecStart = 0, liveResumeAt = 0;
let liveOnsetMs = 0, liveBargeMs = 0, liveQuietSince = 0, liveBusy = false;
let liveWatchT = 0, liveDoneT = 0, liveTtsWasOn = false, liveStarting = false;
const LIVE_RMS = 0.014;    /* konuşma eşiği (0-1 RMS) */
const LIVE_SIL_MS = 900;   /* bu kadar sessizlik → parçayı gönder */
const LIVE_MIN_MS = 420;   /* daha kısa blipleri yolla değil */
const LIVE_MAX_MS = 20000; /* uzun konuşmayı 20 sn'de böl */
function liveSetLabel(t) { try { const el = $('#liveTxt'); if (el && t) el.textContent = t; } catch {} }
function liveSetMegaLive() { setMega('canlı — dinliyorum…', 'busy'); }
function liveWatchdogClear() { clearTimeout(liveWatchT); liveWatchT = 0; }
function liveDoneClear() { clearTimeout(liveDoneT); liveDoneT = 0; }
/* Android mikrofonlu ön plan servisi: canlı mod arka planda da mikrofon
   kullanabilsin. Web/browser testinde setLiveMode yoktur — sessizce atlanır. */
function liveNativeMode(on) {
  try {
    const p = nativePlugin();
    if (p && typeof p.setLiveMode === 'function') {
      const r = p.setLiveMode({ on: !!on, keep: keepEnabled() });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    }
  } catch {}
}
/* cevap metni gelip TTS gecikirse: 12 sn içinde ses gelmezse dinlemeye dön */
function liveOnDone() {
  if (!liveOn || !liveBusy || talkAud) return;
  /* akış BAŞLADIYSA 12 sn fallback'i devreye girmesin; parçalar arasındaki
     kısa sentez boşluğunda liveBusy yanlışlıkla sıfırlanmasın */
  if (talkStarted) return;
  liveDoneClear();
  liveDoneT = setTimeout(() => {
    if (liveOn && liveBusy && !talkAud && !talkStarted) {
      liveBusy = false;
      liveSetLabel('dinliyorum…');
      liveSetMegaLive();
    }
  }, 12000);
}
/* cevap hiç gelmezse 60 sn sonra kilidi aç */
function liveWatchdog() {
  liveWatchdogClear();
  liveWatchT = setTimeout(() => {
    if (!liveOn) return;
    if (liveBusy && !talkAud) {
      liveBusy = false;
      liveSetLabel('dinliyorum…');
      liveSetMegaLive();
    }
  }, 60000);
}
function liveUI(on) {
  try { $('#live').classList.toggle('on', !!on); } catch {}
  try { $('#livebar').hidden = !on; } catch {}
  try { $('#input').style.display = on ? 'none' : ''; } catch {}
  try { $('#attach').style.display = on ? 'none' : ''; } catch {}
  try { $('#send').style.display = on ? 'none' : ''; } catch {}
  try { $('#mic').style.display = on ? 'none' : ''; } catch {}
  if (on) { try { inputEl.blur(); } catch {} }
}
async function startLive() {
  if (liveOn || liveStarting) return;
  liveStarting = true;
  try {
  if (!wsReady()) { toast('bağlantı yok — canlı mod için masaüstüne bağlan'); return; }
  if (!sid) { toast('önce bir sohbet aç'); return; }
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    toast('bu cihazda canlı mikrofon akışı yok'); return;
  }
  if (mediaRec) stopRec(true);
  /* seslendirme kapalıysa canlı mod için aç (çıkışta geri kapatılır) */
  const c = phoneTtsRead();
  liveTtsWasOn = !!c.on;
  if (!c.on) { c.on = true; phoneTtsWrite(c); phoneTtsSync(); } else talkArm();
  /* Android izni önce yerel köprüden al — WebView turunda diyalog beklemesin */
  try {
    const p = nativePlugin();
    if (p && typeof p.requestMic === 'function') {
      const r = await Promise.race([p.requestMic(), new Promise((res) => setTimeout(() => res(null), 12000))]);
      if (r && r.granted === false) {
        if (!liveTtsWasOn) { const c2 = phoneTtsRead(); c2.on = false; phoneTtsWrite(c2); phoneTtsSync(); }
        toast('mikrofon izni kapalı — ayarlardan aç');
        return;
      }
    }
  } catch {}
  /* Mikrofonlu ön plan servisini ŞİMDİ başlat: uygulama görünürken başlatmak
     Android 14+ kuralıdır; kullanıcı başka uygulamaya geçince mikrofon devam eder. */
  liveNativeMode(true);
  const noiseOn = liveNoiseEnabled();
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: noiseOn,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000,
      },
    });
    try {
      const track = liveStream.getAudioTracks && liveStream.getAudioTracks()[0];
      if (track && track.applyConstraints) {
        await track.applyConstraints({
          echoCancellation: true,
          noiseSuppression: noiseOn,
          autoGainControl: true,
          channelCount: 1,
        });
      }
    } catch {}
  } catch {
    liveNativeMode(false);
    if (!liveTtsWasOn) { const c2 = phoneTtsRead(); c2.on = false; phoneTtsWrite(c2); phoneTtsSync(); }
    toast('mikrofon akışı açılamadı — izni kontrol et');
    return;
  }
  try {
    liveCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (liveCtx.state === 'suspended') { try { await liveCtx.resume(); } catch {} }
    const src = liveCtx.createMediaStreamSource(liveStream);
    liveAnalyser = liveCtx.createAnalyser();
    liveAnalyser.fftSize = 1024;
    liveAnalyser.smoothingTimeConstant = 0.35;
    /* GÜRÜLTÜ ZİNCİRİ: motor/rüzgar için high-pass, tiz hışırtı için low-pass,
       ani gürültüyü törpüleyen yumuşak kompresör. Analyser bu temiz sinyali görür. */
    liveHp = liveCtx.createBiquadFilter();
    liveHp.type = 'highpass';
    liveHp.frequency.value = noiseOn ? 120 : 20;
    liveHp.Q.value = 0.7;
    liveLp = liveCtx.createBiquadFilter();
    liveLp.type = 'lowpass';
    liveLp.frequency.value = noiseOn ? 7800 : 20000;
    liveLp.Q.value = 0.7;
    liveComp = liveCtx.createDynamicsCompressor();
    liveComp.threshold.value = noiseOn ? -32 : 0;
    liveComp.knee.value = noiseOn ? 18 : 0;
    liveComp.ratio.value = noiseOn ? 2.5 : 1;
    liveComp.attack.value = 0.005;
    liveComp.release.value = 0.25;
    const dest = liveCtx.createMediaStreamDestination();
    liveProcStream = dest.stream;
    src.connect(liveHp);
    liveHp.connect(liveLp);
    liveLp.connect(liveComp);
    liveComp.connect(dest);
    liveComp.connect(liveAnalyser);
    /* grafik işlensin diye sıfır kazançla çıkışa bağla — hoparlöre ses GİTMEZ */
    const zg = liveCtx.createGain();
    zg.gain.value = 0;
    liveComp.connect(zg);
    zg.connect(liveCtx.destination);
    liveBuf = new Float32Array(liveAnalyser.fftSize);
  } catch {
    liveNativeMode(false);
    try { if (liveProcStream) liveProcStream.getTracks().forEach((t) => t.stop()); } catch {}
    liveProcStream = null;
    try { if (liveStream) liveStream.getTracks().forEach((t) => t.stop()); } catch {}
    liveStream = null;
    try { if (liveCtx) liveCtx.close(); } catch {}
    liveCtx = null; liveAnalyser = null; liveHp = null; liveLp = null; liveComp = null;
    toast('canlı mod başlatılamadı');
    return;
  }
  liveOn = true;
  liveBusy = false; liveOnsetMs = 0; liveBargeMs = 0; liveQuietSince = 0; liveResumeAt = 0;
  liveUI(true);
  liveSetLabel('dinliyorum…');
  liveSetMegaLive();
  liveTD = setInterval(liveTick, 80);
  toast('canlı mod açık — konuş, cevap sesli gelsin');
  } finally { liveStarting = false; }
}
function stopLive(msg) {
  if (!liveOn) return;
  talkCancel(true); /* çalan/kuyruktaki sesi kes + masaüstü akışını iptal et */
  liveOn = false;
  liveNativeMode(false); /* mikrofonlu ön plan servisini kapat */
  liveWatchdogClear();
  liveDoneClear();
  try { clearInterval(liveTD); } catch {}
  liveTD = null;
  try { if (liveRec) { liveRec.onstop = null; if (liveRec.state !== 'inactive') liveRec.stop(); } } catch {}
  liveRec = null; liveChunks = [];
  try { if (liveProcStream) liveProcStream.getTracks().forEach((t) => t.stop()); } catch {}
  liveProcStream = null;
  try { if (liveStream) liveStream.getTracks().forEach((t) => t.stop()); } catch {}
  liveStream = null;
  try { if (liveCtx) liveCtx.close(); } catch {}
  liveCtx = null; liveAnalyser = null; liveHp = null; liveLp = null; liveComp = null;
  liveBusy = false; liveOnsetMs = 0; liveBargeMs = 0;
  liveUI(false);
  if (!liveTtsWasOn) { const c = phoneTtsRead(); c.on = false; phoneTtsWrite(c); phoneTtsSync(); }
  else talkArm();
  setMega('hazır');
  if (msg) toast(msg);
}
function liveTick() {
  if (!liveOn || !liveAnalyser) return;
  /* Arka planda Android AudioContext'i askıya alabilir; sessizce geri aç.
     Saniyede onlarca resume çağrısı birikmesin diye 2 sn'de bir dene. */
  if (liveCtx && liveCtx.state === 'suspended' && Date.now() - liveResumeAt > 2000) {
    liveResumeAt = Date.now();
    try { liveCtx.resume().catch(() => {}); } catch {}
  }
  try { liveAnalyser.getFloatTimeDomainData(liveBuf); } catch { return; }
  let sum = 0;
  for (let i = 0; i < liveBuf.length; i++) { const v = liveBuf[i]; sum += v * v; }
  const rms = Math.sqrt(sum / liveBuf.length);
  const loud = rms > LIVE_RMS;
  /* BARGE-IN: cevap sesi çalarken kullanıcı konuşursa sesi kes.
     Eşik yüksek: hoparlörden sızan kendi sesi (AEC artığı) tetiklemesin. */
  if (talkAud && !talkAud.paused) {
    if (rms > Math.max(0.05, LIVE_RMS * 3)) {
      liveBargeMs += 80;
      if (liveBargeMs >= 400) {
        /* sesi + kuyruğu kes, masaüstüne de "akan sesi bırak" de */
        talkCancel(true);
        liveBargeMs = 0;
      }
    } else liveBargeMs = 0;
    return;
  }
  liveBargeMs = 0;
  if (liveBusy) return;
  if (loud) {
    liveQuietSince = 0;
    liveOnsetMs += 80;
    if (!liveRec && liveOnsetMs >= 160) liveRecStartNow();
  } else {
    liveOnsetMs = 0;
    if (liveRec) {
      if (!liveQuietSince) liveQuietSince = Date.now();
      else if (Date.now() - liveQuietSince >= LIVE_SIL_MS) liveRecStopNow();
    }
  }
  if (liveRec && Date.now() - liveRecStart >= LIVE_MAX_MS) liveRecStopNow();
}
function liveRecStartNow() {
  if (!liveStream || liveRec) return;
  liveChunks = [];
  try {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    let mime = '';
    for (const t of types) {
      try { if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) { mime = t; break; } } catch {}
    }
    const srcStream = liveProcStream || liveStream;
    liveRec = mime ? new MediaRecorder(srcStream, { mimeType: mime }) : new MediaRecorder(srcStream);
    liveRec.ondataavailable = (e) => { if (e.data && e.data.size) liveChunks.push(e.data); };
    liveRec.onstop = liveRecDone;
    liveRec.start();
    liveRecStart = Date.now();
    liveQuietSince = 0;
  } catch { liveRec = null; }
}
function liveRecStopNow() {
  const r = liveRec;
  if (!r) return;
  liveRec = null;
  liveBusy = true; /* işlenene kadar yeni kayıt başlamasın */
  liveSetLabel('işleniyor…');
  try {
    if (r.state !== 'inactive') r.stop();
    else liveRecDone({ target: r });
  } catch { liveBusy = false; if (liveOn) liveSetLabel('dinliyorum…'); }
}
async function liveRecDone(ev) {
  const rec = ev && ev.target ? ev.target : null;
  const dur = Date.now() - liveRecStart;
  const chunks = liveChunks;
  liveChunks = [];
  liveOnsetMs = 0; liveQuietSince = 0;
  const mt = String((rec && rec.mimeType) || (chunks[0] && chunks[0].type) || 'audio/webm');
  if (dur < LIVE_MIN_MS || !chunks.length) { liveBusy = false; if (liveOn) liveSetLabel('dinliyorum…'); return; }
  let blob = null;
  try { blob = new Blob(chunks, { type: mt }); } catch {}
  if (!blob || !blob.size) { liveBusy = false; if (liveOn) liveSetLabel('dinliyorum…'); return; }
  const dataUrl = await blobToDataUrl(blob);
  if (!liveOn) return;
  if (!dataUrl) { liveBusy = false; liveSetLabel('dinliyorum…'); return; }
  const ext = mt.indexOf('mp4') >= 0 ? 'm4a' : (mt.indexOf('ogg') >= 0 ? 'ogg' : 'webm');
  liveWatchdog();
  sendAudio(dataUrl, 'sesli mesaj.' + ext, Math.max(1, Math.round(dur / 1000)), true);
}
$('#live').addEventListener('click', () => { if (liveOn) stopLive('canlı mod kapandı'); else startLive(); });
$('#liveStop').addEventListener('click', () => stopLive('canlı mod kapandı'));

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideSlash(); return; }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (slashEl && !slashEl.hidden) {
      const items = [...slashEl.querySelectorAll('.sm-item')];
      const idx = items.findIndex((x) => x.classList.contains('sel'));
      if (items.length) { items[Math.max(0, idx)].click(); return; }
    }
    sendMessage();
  }
});
inputEl.addEventListener('input', () => { updateSlash(); });

/* butonlar odağı input'tan çekmesin → klavye kapanmaz */
['send', 'attach', 'mic', 'live', 'newsess', 'settings', 'exit', 'recCancel', 'recSend', 'liveStop'].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('mousedown', (e) => e.preventDefault());
});

/* ÇIKIŞ: bağlan ekranını TEKRAR göstert — tel allak balak bağlantı tamamen kapatılır */
exitEl.addEventListener('click', () => {
  quitIntent = true;
  /* Çıkışta canlı modu kapat: mikrofon servisi ve ses akışı arkada kalmasın. */
  if (liveOn) stopLive();
  stopHeartbeat();
  clearTimeout(reconnectT);
  closeWs();
  joined = false;
  try {
    const p = nativePlugin();
    if (p && typeof p.keepAlive === 'function') p.keepAlive({ on: false });
  } catch {}
  try { chatFlush(); } catch {}
  showAuth();
});

/* SOHBET SEÇİCİ: üstteki buton sheet'i açar — seç / sil (bilgisayarla entegre) */
sessEl.addEventListener('click', () => { openSessSheet(); });
sessEl.addEventListener('mousedown', (e) => e.preventDefault()); /* klavye kapanmasın */
if (sessSheet) {
  const back = sessSheet.querySelector('.ssb');
  if (back) back.addEventListener('click', () => { sessSheet.hidden = true; });
  const closeBtn = sessSheet.querySelector('#sessClose');
  if (closeBtn) closeBtn.addEventListener('click', () => { sessSheet.hidden = true; });
  if (sessListEl) {
    sessListEl.addEventListener('click', (ev) => {
      const delBtn = ev.target && ev.target.closest ? ev.target.closest('[data-del]') : null;
      if (delBtn) { ev.stopPropagation(); confirmAndDel(delBtn.getAttribute('data-del') || ''); return; }
      const row = ev.target && ev.target.closest ? ev.target.closest('[data-open]') : null;
      if (row) { sessSheet.hidden = true; openSession(row.getAttribute('data-open') || ''); }
    });
  }
}

/* "＋" (sağ üst): masaüstünde yeni oturum açar */
$('#newsess').addEventListener('click', () => {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'new' })); } catch {}
  keepKeyboard();
});

/* ayarlar sayfası */
$('#settings').addEventListener('click', openSettings);
setBack.addEventListener('click', closeSettings);
segTheme.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !b.dataset.t) return;
  applyTheme(b.dataset.t, true);
});

/* resim ekleme */
$('#attach').addEventListener('click', attachImage);

/* ---------- kaydırma / klavye olayları ---------- */
window.addEventListener('resize', () => { scroll(); });
window.addEventListener('orientationchange', () => { setTimeout(scroll, 250); });
if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
  window.visualViewport.addEventListener('resize', () => { scroll(); });
}
/* UYGULAMA ÖN PLANA GELDİĞİ OTURUM: koptu/bayat soket varsa ANINDA sessiz
   değnetlimi bağlan — kullanıcı "mesajım gitmedi" dedirtmez */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  scroll();
  if (quitIntent || authEl.style.display === 'flex') return;
  try { if (!localStorage.getItem('bmCode') || !localStorage.getItem('bmHost')) return; } catch { return; }
  const dead = !ws || ws.readyState !== 1 || (lastPong && Date.now() - lastPong > 45000);
  if (dead) {
    clearTimeout(reconnectT);
    reconnectT = null;
    closeWs();
    setMega('bağlantı yenileniyor…', 'busy');
    setTimeout(() => { try { connect(); } catch {} }, 120);
  } else {
    flushOutbox();
    syncKeep();
  }
  chatFlush();
});
/* önbellek kuykurtucu: ekranı kuran kayıtlar 4 sn de bir diske yazılır */
setInterval(() => { try { if (cacheDirty && sid) chatFlush(); } catch {} }, 4000);

/* ---------- ilk yükleme ---------- */
applyTheme(currentThemePref(), false);
syncSystemBars();

hostEl.value = localStorage.getItem('bmHost') || '';
codeEl.value = localStorage.getItem('bmCode') || '';

/* bildirim izni (Android 13+) - bir kez iste */
try {
  const p = nativePlugin();
  if (p && typeof p.requestNotify === 'function') setTimeout(() => { try { p.requestNotify(); } catch {} }, 1200);
} catch {}
/* MİKROFON İZNİ ÖN ISITMA: ilk PTT basışı izin diyalogunda beklemesin —
   izin bir kez burada istenir; sonraki basışlar anında kayda girer */
try {
  const p = nativePlugin();
  if (p && typeof p.requestMic === 'function') setTimeout(() => { try { Promise.resolve(p.requestMic()).catch(() => {}); } catch {} }, 2200);
} catch {}

/* KAYITLI BİLGİLERLE DİREKT SON OTURUM: login ekranı HİÇ gösterilmez.
   Bağlantı arka planda kurulur — kopukluk olsa bile chat + önbellek ekranda
   kalır, başlıkta durum görünür; "bağlan ekranı yalnız Çıkış'ta" kuralı. */
if (localStorage.getItem('bmHost') && localStorage.getItem('bmCode')) {
  authEl.style.display = 'none';
  appEl.style.display = 'flex';
  setMega('bağlanılıyor…', 'busy');
  try {
    sid = localStorage.getItem('bmSid') || '';
    if (sid) { chatArr = chatLoad(sid); cacheDirty = false; chatRender(); }
  } catch {}
  paintKeepSw();
  setTimeout(() => { try { connect(); } catch {} }, 80);
} else {
  paintKeepSw();
}
