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
  try { p.setPoll({ url, code, everySec: 60 }); } catch {}
}

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
    $('#scConn').textContent = joined ? 'bağlı ✓' : 'bağlı değil';
    $('#scVer').textContent = 'sürüm 1.0 · Beast Agent ile eşleşik';
  } catch {}
  paintPollSw();
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

function bubble(role, html) {
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

function sysNote(txt) {
  const s = document.createElement('div');
  s.className = 'sysb';
  s.textContent = txt;
  msgsEl.appendChild(s);
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

function toolChip(name, args) {
  const n = String(name || 'araç');
  const row = document.createElement('div');
  row.className = 'row';
  const b = document.createElement('div');
  b.className = 'toolbubble';
  let detail = '';
  try {
    const a = args || {};
    const t = a.command || a.path || a.file_path || a.filePath || a.url || a.pattern || a.query || a.name || a.title;
    if (t) detail = String(t).slice(0, 80);
  } catch {}
  b.innerHTML = '<b>⚙ ' + escHtml(n) + '</b>'
    + (TOOL_TR[n] ? '<span class="tl">' + escHtml(TOOL_TR[n]) + '</span>' : '')
    + (detail ? '<span class="td">' + escHtml(detail) + '</span>' : '');
  row.appendChild(b);
  /* araç balonu akış balonunun ÜSTÜNDE dursun (yoksa silinir) */
  if (streamEl && streamEl.parentElement) msgsEl.insertBefore(row, streamEl.parentElement);
  else msgsEl.appendChild(row);
  scroll();
}

/* ---------- DOSYA KARTI (ajan dosya gönderimi) ---------- */
function fileCard(ev) {
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
  setMega('bağlanılıyor…', 'busy');
  try { ws = new WebSocket(mode + '://' + host + ':' + port); } catch { showAuth('bağlantı kurulamadı'); return; }
  let did = localStorage.getItem('bmDid');
  if (!did) { did = 'bm-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('bmDid', did); }
  ws.onopen = () => {
    ws.send(JSON.stringify({
      t: 'auth', code, name: 'Beast Mobil', platform: (/iPhone|iPad|iOS/.test(navigator.userAgent) ? 'ios' : 'android'), did,
    }));
  };
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {
    busy = false; typingEl.classList.remove('on');
    if (appEl.style.display !== 'flex') {
      showAuth(errEl.textContent || 'bağlantı kurulamadı — adres/kod kontrol et');
      return;
    }
    if (joined) {
      setMega('bağlantı koptu — tekrar bağlanılıyor…', 'err');
      setTimeout(() => { try { connect(); } catch {} }, 2500);
    } else {
      showAuth(errEl.textContent || 'bağlantı kurulamadı — adres/kod kontrol et');
    }
  };
  ws.onerror = () => {};
}

function closeWs() { try { if (ws) { ws.onclose = null; ws.close(); } } catch {} ws = null; }

/* ---------- agent event akışı ---------- */
function handle(m) {
  const t = String(m.t || m.type || '');
  switch (t) {
    case 'auth-ok':
      joined = true;
      authEl.style.display = 'none';
      appEl.style.display = 'flex';
      setMega('bağlandı ✓');
      scroll();
      syncPoll();
      openSession(sid);
      break;
    case 'auth-bad':
      errEl.textContent = m.why || 'kod yanlış';
      setMega('kod reddedildi', 'err');
      showAuth();
      break;
    case 'sessions': {
      const list = Array.isArray(m.list) ? m.list : null;
      if (!list) break;
      sessEl.innerHTML = list.map((s) =>
        '<option value="' + escHtml(s.id) + '"' + (s.id === curSid(list, m) ? ' selected' : '') + '>' +
        escHtml(String(s.title || s.id).slice(0, 26)) + '</option>').join('');
      const cur = curSid(list, m);
      if (cur && cur !== sid) openSession(cur);
      else if (cur === sid) { try { sessEl.value = sid; } catch {} }
      else if (!msgsEl.children.length) sysNote('masaüstünde hiç sohbet yok — "＋" ile (sağ üst) yeni sohbet aç; yazarak da başlayabilirsin');
      break;
    }
    case 'session-switch':
      openSession(m.sessionId || '');
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
        setMega('geçmiş silindi · sıfırdan yazabilirsin');
      }
      break;
    case 'session':
      handleSessionSnapshot(m);
      break;
    case 'pong':
      break;
    default:
      break;
  }
}

function closeStream(keepAlive) {
  if (streamEl) {
    if (streamBuf.trim()) {
      streamEl.innerHTML = mdLite(streamBuf);
      lastFin = streamBuf.trim();
    } else {
      /* BOS AKIS BALONU: her zaman silinir — aksi halde ekranda bos baloncuk kalir */
      try { streamEl.parentElement.remove(); } catch {}
    }
  }
  streamEl = null; streamBuf = '';
  if (!keepAlive) typingEl.classList.remove('on');
  scroll();
}

/* ---------- komut gönderimleri ---------- */
function openSession(id) {
  const next = String(id || '');
  if (!next) return;
  sid = next;
  localStorage.setItem('bmSid', sid);
  try { sessEl.value = sid; } catch {}
  msgsEl.innerHTML = '';
  streamEl = null; streamBuf = '';
  lastFin = '';
  setMega('geçmiş yükleniyor…', 'busy');
  clearTimeout(snapT);
  snapT = setTimeout(() => {
    if (streamEl || msgsEl.children.length) return;
    sysNote('geçmiş yüklenemedi — masaüstü uygulaması güncel sürüm olsun (yeni sürümde otomatik)');
    setMega('geçmiş yok — yine de yazabilirsin');
  }, 4000);
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'open', sid: sid })); } catch {}
}

function handleSessionSnapshot(m) {
  clearTimeout(snapT);
  if (String(m.sid || '') !== sid) return;
  msgsEl.innerHTML = '';
  streamEl = null; streamBuf = '';
  lastFin = '';
  const list = Array.isArray(m.messages) ? m.messages.slice(-80) : [];
  for (const msg of list) {
    const role = String(msg.role || 'assistant');
    /* GEÇMİŞTEKİ ARAÇ KAYITLARI: tool_calls -> araç balonu (isim + detay).
       tool_calls olmayan canlı akışta 'tool-start' eventi zaten basıyor. */
    for (const tc of toolCallsOf(msg)) toolChip(tc.name, tc.args);
    const txt = contentText(msg.content);
    const hasAtt = Array.isArray(msg.attachments) && msg.attachments.length > 0;
    if (!txt && !hasAtt) continue; /* boş baloncuk basma */
    const html = renderContent(msg.content || '', msg.attachments);
    if (role === 'user') { bubble('me', html); }
    else { bubble('assistant', html); }
  }
  if (!list.length) sysNote('bu sohbette henüz mesaj yok — yazabilirsin');
  setMega('hazır');
  scroll();
}

function sendMessage() {
  const text = String(inputEl.value || '').trim();
  const atts = pending.slice();
  if (!text && !atts.length) return;
  if (!sid || !ws || ws.readyState !== 1) { setMega('bağlantı yok — bekley…', 'err'); return; }
  if (text.startsWith('/')) {
    ws.send(JSON.stringify({ t: 'send', sid, text }));
  } else {
    ws.send(JSON.stringify({ t: 'send', sid, text, attachments: atts.length ? atts : undefined }));
  }
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

function recUI(on) {
  const bar = $('#recbar');
  if (bar) bar.hidden = !on;
  inputEl.style.display = on ? 'none' : '';
  micEl.classList.toggle('rec', on);
  if (on) $('#recTime').textContent = '0:00';
}

async function toggleRec() {
  if (mediaRec) { stopRec(false); return; }
  const stream = await getMicStream();
  if (!stream) return;
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
  recChunks = [];
  recCancel = false;
  mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  mediaRec.onstop = onRecStopped;
  try { mediaRec.start(); } catch (e) { toast('Kayıt başlatılamadı'); return; }
  recStartTs = Date.now();
  recTimer = setInterval(() => {
    const s = Math.floor((Date.now() - recStartTs) / 1000);
    const t = $('#recTime');
    if (t) t.textContent = fmtDur(s);
    if (s >= 120) stopRec(false);
  }, 250);
  recUI(true);
  setMega('ses kaydediliyor…', 'busy');
}

/* Mikrofon akışı:
   1) Doğrudan getUserMedia — Capacitor'ın WebChromeClient'ı RECORD_AUDIO
      iznini kendi dialoguyla ister ve onaylar (en sorunsuz yol).
   2) Reddedilirse native izin isteyip TEKRAR dene (kısa timeout'lu —
      callback gelmezse takılmasın). */
async function getMicStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Tarayıcı mikrofonu engelliyor (güvenli bağlantı gerekli)');
    setMega('mikrofon kullanılamıyor', 'err');
    return null;
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    /* 2. deneme: native izin iste */
    const p = nativePlugin();
    if (p && typeof p.requestMic === 'function') {
      try {
        const r = await Promise.race([
          p.requestMic(),
          new Promise((res) => setTimeout(() => res(null), 8000)),
        ]);
        if (r && r.granted === false) {
          toast('Mikrofon izni verilmedi');
          setMega('mikrofon izni yok', 'err');
          return null;
        }
        return await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e2) {
        toast('Mikrofona erişilemedi');
        setMega('mikrofona erişilemedi', 'err');
        return null;
      }
    }
    toast('Mikrofona erişilemedi');
    setMega('mikrofona erişilemedi', 'err');
    return null;
  }
}

function stopRec(cancel) {
  recCancel = !!cancel;
  const r = mediaRec;
  if (r && r.state !== 'inactive') {
    try { r.stop(); } catch {}
  } else {
    clearInterval(recTimer); recTimer = null;
    recUI(false);
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

function sendAudio(dataUrl, name, duration) {
  if (!sid || !ws || ws.readyState !== 1) { setMega('bağlantı yok — bekley…', 'err'); return; }
  ws.send(JSON.stringify({
    t: 'send', sid, text: '',
    attachments: [{ type: 'audio', name, duration, dataUrl }],
  }));
  selfEcho++;
  setMega('sesli mesaj gönderildi', 'busy');
  keepKeyboard();
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
btnJoin.addEventListener('click', connect);
codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
hostEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
sendEl.addEventListener('click', () => { sendMessage(); });
micEl.addEventListener('click', () => { toggleRec(); });
$('#recCancel').addEventListener('click', () => stopRec(true));
$('#recSend').addEventListener('click', () => stopRec(false));

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
['send', 'attach', 'mic', 'newsess', 'settings', 'exit', 'recCancel', 'recSend'].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('mousedown', (e) => e.preventDefault());
});

exitEl.addEventListener('click', () => {
  closeWs();
  showAuth();
  sysNote('bağlantıyı kapattın');
});
function sysNoteInternal() { sysNote('bağlantıyı kapattın'); }

sessEl.addEventListener('change', () => openSession(sessEl.value));

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
document.addEventListener('visibilitychange', () => { if (!document.hidden) scroll(); });

/* ---------- ilk yükleme ---------- */
applyTheme(currentThemePref(), false);
syncSystemBars();

hostEl.value = localStorage.getItem('bmHost') || '';
codeEl.value = localStorage.getItem('bmCode') || '';

/* bildirim izni (Android 13+) — bir kez iste */
try {
  const p = nativePlugin();
  if (p && typeof p.requestNotify === 'function') setTimeout(() => { try { p.requestNotify(); } catch {} }, 1200);
} catch {}

/* KAYITLI BİLGİLERLE DİREKT SON OTRUM: login ekranı hiç gösterilmez */
if (localStorage.getItem('bmHost') && localStorage.getItem('bmCode')) {
  authEl.style.display = 'none';
  appEl.style.display = 'flex';
  setMega('bağlanılıyor…', 'busy');
  setTimeout(() => { try { connect(); } catch {} }, 80);
}
