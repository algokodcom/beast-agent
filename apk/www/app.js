'use strict';

/* Beast Mobile — telefon tarafı istemci (browser test + Capacitor APK ortak)
   Protokol: src/agent/mobile.js ile birebir (t:'auth' / 'send' / ... ;
   agent eventleri 'type' alanıyla gelir). */

const $ = (s) => document.querySelector(s);
const authEl = $('#auth'), appEl = $('#app');
const hostEl = $('#host'), codeEl = $('#code'), errEl = $('#authErr'), btnJoin = $('#btnJoin');
const msgsEl = $('#msgs'), inputEl = $('#input'), sendEl = $('#send');
const sessEl = $('#sess'), hdot = $('#hdot'), hmega = $('#hmega'), hname = $('#hname');
const typingEl = $('#typing'), attwrapEl = $('#attwrap');
const exitEl = $('#exit');

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

/* ---------- küçük yardımcılar ---------- */
const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function setMega(txt, cls) {
  hmega.textContent = txt || 'hazır';
  hdot.style.background = cls === 'busy' ? '#f4c542' : (cls === 'err' ? '#ff6b6b' : '#00cf70');
}

function bubble(role, html) {
  const row = document.createElement('div');
  row.className = 'row' + (role === 'me' ? ' me' : '');
  const b = document.createElement('div');
  b.className = 'bub';
  b.innerHTML = html || '&nbsp;';
  row.appendChild(b);
  msgsEl.appendChild(row);
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

function scroll() { try { msgsEl.scrollTop = msgsEl.scrollHeight; } catch {} }

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
    out += isImg
      ? '<div class="fchip">▣ ' + escHtml(a.name || 'resim') + '</div><img src="' + escHtml(a.dataUrl) + '" alt="">'
      : '<div class="fchip">≡ ' + escHtml((a && a.name) || 'dosya') + '</div>';
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

function toolChip(name) {
  const el = document.createElement('span');
  el.className = 'toolchip';
  el.textContent = '⚙ ' + (name || 'araç');
  (streamEl || (streamEl = bubble('assistant', ''))).appendChild(el);
  scroll();
}

/* ---------- WS ---------- */
function connect() {
  closeWs();
  errEl.textContent = '';
  joined = false;
  /* host alanı "192.168.1.34" ya da "192.168.1.34:9123" kabul eder (port opsiyonel) */
  const hostRaw = String(hostEl.value || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const mPort = hostRaw.match(/:(\d+)$/);
  const port = mPort ? Math.max(1024, Math.min(65535, Number(mPort[1]))) : 8788;
  const host = hostRaw.replace(/:\d+$/, '');
  const code = String(codeEl.value || '').toUpperCase().trim();
  if (!host) { errEl.textContent = 'PC adresi boş — örn. 192.168.1.34'; return; }
  if (!/^BEAST-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(code)) { errEl.textContent = 'Kod biçimi: BEAST-XXXX-XXXX'; return; }
  localStorage.setItem('bmHost', host);
  localStorage.setItem('bmCode', code);
  setMega('bağlanılıyor…', 'busy');
  ws = new WebSocket('ws://' + host + ':' + port);
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
    if (appEl.style.display !== 'flex') return;
    if (joined) {
      setMega('bağlantı koptu — tekrar bağlanılıyor…', 'err');
      setTimeout(() => { try { connect(); } catch {} }, 2500);
    } else {
      /* kod reddedildi (auth-bad sonra sunucu kapattı) → bağlan ekranına dön */
      appEl.style.display = 'none';
      authEl.style.display = 'flex';
      if (!errEl.textContent) errEl.textContent = 'bağlantı kurulamadı — adres/kod kontrol et';
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
      hname.textContent = '· PC ' + String(m.device || '').replace(/^BEAST-/, '').slice(0, 4) + '·' + String(m.device || '').slice(-4);
      authEl.style.display = 'none';
      appEl.style.display = 'flex';
      setMega('bağlandı ✓');
      openSession(sid); /* varsa son açık oturum */
      break;
    case 'auth-bad':
      errEl.textContent = m.why || 'kod yanlış';
      setMega('kod reddedildi', 'err');
      break;
    case 'sessions': {
      const list = Array.isArray(m.list) ? m.list : null;
      if (!list) break; /* içi boş 'liste tazele' sinyali — masaüstü IPC doldurur; telefona dolu liste main'den gelir */
      sessEl.innerHTML = list.map((s) =>
        '<option value="' + escHtml(s.id) + '"' + (s.id === curSid(list, m) ? ' selected' : '') + '>' +
        escHtml(String(s.title || s.id).slice(0, 26)) + '</option>').join('');
      const cur = curSid(list, m);
      if (cur && cur !== sid) openSession(cur); /* ekranı SADECE oturum değişince yeniden yükle */
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
        closeStream(true); /* eğer açık yarım varsa kapanır */
        typingEl.classList.add('on');
        setMega('gönderildi — cevap bekleniyor…', 'busy');
        lastFin = ''; /* yeni user turu — önceki final echo harmi sıfır */
        bubble('me', renderContent(msg.content || '', msg.attachments));
      } else {
        const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
        const fin = contentText(msg.content);
        /* ÇİFT BALON KALKANI (3 kaynak):
           1) fin === lastFin          → token akışı zaten donduruldu, echo tekrar gelirse
           2) fin === streamBuf (AÇIK akış!) → final 'message', 'done'dan ÖNCE düşüyorsa
              balon hâlâ açık/komple metinli olur — dondur ve YENİ balon ekleme */
        if (fin && (fin === lastFin || (streamEl && streamBuf.trim() === fin))) {
          closeStream(false);
          if (!hasTools) {
            busy = false; typingEl.classList.remove('on');
            setMega('hazır');
          }
          break;
        }
        closeStream(false);
        const clean = String(typeof msg.content === 'string' ? msg.content : '').trim();
        if (!clean && !Array.isArray(msg.content)) break;
        bubble('assistant', renderContent(msg.content || '', msg.attachments));
        lastFin = fin;
        if (!hasTools) {
          busy = false; typingEl.classList.remove('on');
          setMega('hazır');
        }
      }
      break;
    }
    case 'token': {
      if (String(m.sessionId || '') !== sid) break;
      busy = true; typingEl.classList.remove('on');
      const delta = m.delta == null ? '' : String(m.delta);
      if (!streamEl) {
        streamEl = bubble('assistant', '');
        streamBuf = '';
      }
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
      if (String(m.sessionId || '') === sid) toolChip(String(m.name || m.tool || 'araç'));
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
        lastFin = ''; /* temiz ekran — harm sıfır */
        setMega('geçmiş silindi · sıfırdan yazabilirsin');
      }
      break;
    case 'session': /* geçmiş snapshot'ı (Faz A'da mobile.js'e tarafımıza yazılmamış olabilir — sessizce görmezden gelinmez) */
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
      /* yarım metin kalıcı balonya dönüşür (beast desktop gibi) */
      streamEl.innerHTML = mdLite(streamBuf);
      lastFin = streamBuf.trim(); /* final echo bundan sonra çifte düşmez */
    } else if (!keepAlive) {
      streamEl.parentElement.remove();
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
  try { sessEl.value = sid; } catch {} /* option yoksa sessizce kalır */
  msgsEl.innerHTML = '';
  streamEl = null; streamBuf = '';
  lastFin = ''; /* yeni oturum — final echo dedupesi sıfırdan */
  setMega('geçmiş yükleniyor…', 'busy');
  /* snapshot bekçisi: masaüstü 4 sn içinde {t:'session'} göndermezse uyarı */
  clearTimeout(snapT);
  snapT = setTimeout(() => {
    if (streamEl || msgsEl.children.length) return;
    sysNote('geçmiş yüklenemedi — masaüstü uygulaması güncel sürüm olsun (yeni sürümde otomatik)');
    setMega('geçmiş yok — yine de yazabilirsin');
  }, 4000);
  /* HER SEFERİNDE open: masaüstü cevap olarak {t:'session', sid, messages} yollar */
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'open', sid: sid })); } catch {}
}

/* masaüstünden gelen geçmiş snapshot'ı ({t:'session', sid, messages}) —
   masaüstünün .jsonl oturumundan okunur, cevabı sendMobileHistory yollar */
function handleSessionSnapshot(m) {
  clearTimeout(snapT);
  if (String(m.sid || '') !== sid) return;
  msgsEl.innerHTML = '';
  streamEl = null; streamBuf = '';
  lastFin = ''; /* snapshot taze — harman sıfır */
  const list = Array.isArray(m.messages) ? m.messages.slice(-80) : [];
  for (const msg of list) {
    const role = String(msg.role || 'assistant');
    const html = renderContent(msg.content || '', msg.attachments);
    if (role === 'user') { bubble('me', html); }
    else { bubble('assistant', html); }
  }
  if (!list.length) sysNote('bu sohbette henüz mesaj yok — yazabilirsin');
  setMega('hazır');
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
  inputEl.value = '';
  pending = [];
  renderAtt();
  setMega('gönderildi', 'busy');
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

/* resim ekle: galeri/kamera seçici */
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
      };
      r.readAsDataURL(f);
    }
  };
  inp.click();
}

/* ---------- başlatma ---------- */
btnJoin.addEventListener('click', connect);
codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
hostEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
sendEl.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
exitEl.addEventListener('click', () => {
  closeWs();
  appEl.style.display = 'none';
  authEl.style.display = 'flex';
  sysNoteInternal();
});
function sysNoteInternal() { sysNote('bağlantıyı kapattın'); }

sessEl.addEventListener('change', () => openSession(sessEl.value));

/* "＋" (sağ üst): masaüstünde yeni oturum açar → session-switch event'ini bizde açar */
$('#newsess').addEventListener('click', () => {
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'new' })); } catch {}
});

/* resim ekleme: footer'daki ataçma (📎) butonu ile — kamera/galeri seçici */
$('#attach').addEventListener('click', attachImage);

/* ilk yükleme: LuisCode host ve codu persist */
hostEl.value = localStorage.getItem('bmHost') || '';
codeEl.value = localStorage.getItem('bmCode') || '';

/* otomatik bağlan (hafıza tam ise): APK yeniden açılınca direkt chat */

if (localStorage.getItem('bmHost') && localStorage.getItem('bmCode')) {
  setTimeout(() => { try { connect(); } catch {} }, 300);
}
