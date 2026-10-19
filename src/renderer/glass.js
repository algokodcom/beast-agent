'use strict';

/* BEAST — MASAÜSTÜ CAM SOHBET (glass.js)
   Ana uygulamanın CAM düğmesiyle açılan neon-glass sohbet.
   - Ana pencereyle AYNI preload'i kullanır (beast.send / onEvent / sessions)
   - Canlı akış: engine 'emit' olayları main'de buraya da relay edilir
   - Durdurma/onay kartları küçük rozetlerle gösterilir
   - TEMA: ⚙ menüsünden Mavi / Siyah / Beyaz cam (localStorage'ta hatırlanır) */

const $ = (s, r) => (r || document).querySelector(s);
const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* uzun metni SONUNA … koyarak kısaltır — uzun bildirimlerde üst çubuk
   şişip ✕ düğmesi sağa kayıp görünmez olmadan */
function shortTxt(t, n) {
  const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, Math.max(1, n - 1)).trimEnd() + '…' : s;
}

const gMsgs = $('#gMsgs');
const gInput = $('#gInput');
const gDot = $('#gDot');
const gStt = $('#gStt');
const gSess = $('#gSess');
const gThemePop = $('#gThemePop');
const gStop = $('#gStop');
const gVoice = $('#gVoice');
const gSlash = $('#gSlash');
const gAttach = $('#gAttach'); /* 📎 — resim/dosya ekleme butonu */
const gChips = $('#gChips'); /* gönderi öncesi ek çipleri satırı */
const gFile = $('#gFile'); /* gizli dosya seçici */

let sessions = [];
let sid = null;
let busy = false; updateStopVisible();
let streamBuf = '';
let streambubble = null;
let streamTimer = 0;
let replyAnchor = null; /* cevabın sorusunun sırası — mesaj saatine göre sıralama */
let turnHadLive = false; /* bu turda canlı akış eventleri gösterildi mi (uzlaşma kuralı) */
let approvalGone = false; // cevaplanan onay rozetleri refleği (sessiz durum bayrağı)

function setDot(cls, text) {
  gDot.className = 'g-dot' + (cls ? ' ' + cls : '');
  /* uzun bildirim … ile kısalır — tam metin imleç title'ında durur */
  gStt.textContent = shortTxt(text || 'hazır', 34);
  gStt.title = text || '';
}

/* DURDUR BUTONU GÖRÜNÜRLÜĞÜ: ajan çalışırken görünür, boşta GİZLİ */
function updateStopVisible() {
  if (gStop) gStop.classList.toggle('hid', !busy);
}

/* --- mini markdown: kalın + kod + satır atlama (ana ekranın md'sinin hafif kopya) --- */
function mdLite(t) {
  let out = escHtml(String(t || ''));
  out = out.replace(/```([\s\S]*?)```/g, (_m, code) => '<code>' + code.trim() + '</code>');
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return out;
}

/* ---------- PROAKTİF NOT GİZLEME (cam özel) ----------
   Empati Loop bildirimleri ('🫡 *Beast proaktif:*…') masaüstü chat UI'da ve
   seçilen kanalda (WA/TG/DC) görünür; oturum geçmişinde ajanın bağlamı için
   durur. CAM PANELE ÇİZİLMEZ: (1) tamamı proaktif olan mesaj tamamen süzülür,
   (2) son asistan cevabına BİRLEŞTİRİLMİŞ notun ucu sessizce kesilir. */
const G_PROAKTIF_RE = /^\s*🫡\s*\*{1,2}\s*Beast proaktif:/;
const G_PROAKTIF_TAIL_RE = /\n+🫡\s*\*{1,2}\s*Beast proaktif:/;

function cleanProactive(t) {
  const s = String(t || '');
  if (G_PROAKTIF_RE.test(s)) return ''; /* bildirim balonu camda görünmez */
  const m = s.match(G_PROAKTIF_TAIL_RE); /* birleşik: normal cevap + not ucu */
  return m ? s.slice(0, m.index).trimEnd() : s;
}

function contentText(c) {
  /* mesaj içeriği string YA DA parts dizisi olabilir (görsel/dosya ekli) */
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map((p) => {
      if (!p) return '';
      if (p.type === 'text') return p.text || '';
      if (p.type === 'image' || p.type === 'image_url') return '[görsel]';
      if ((p.type === 'file' || p.type === 'document') && p.name) return '[dosya: ' + p.name + ']';
      if (typeof p === 'string') return p;
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function scrollBottom() {
  /* HER MUTASYONDA en son mesaja in — kullanıcı yukarıyı görüntülüyor olsa bile
     yeni içerik gelince yine en sona kilitlensin (kullanıcının tercihi) */
  gMsgs.scrollTop = gMsgs.scrollHeight;
}

/* SIRA KURALLARI: cevap balonu KENDİ SORUSUNUN altına yerleşir; kullanıcı
   sonradan yeni mesaj yazsa bile cevap sorusunun yanında kalır — mesaj
   saatine göre sıra bozulmaz (soru → cevap → yeni soru → yeni cevap). */
function lastUserRow() {
  const rows = gMsgs.querySelectorAll('.g-row.me');
  return rows.length ? rows[rows.length - 1] : null;
}
/* bir soru sırasının "tur grubunun" sonuna ekler: soru + onu izleyen araç/onay
   rozetleri bitince cevap gelir; sonraki sorular cevabın ÜSTÜNE gelmez */
function insertAfterTurn(anchorRow, row) {
  if (!anchorRow || !anchorRow.isConnected || anchorRow.parentNode !== gMsgs) {
    gMsgs.appendChild(row);
    return;
  }
  let cur = anchorRow;
  while (cur.nextElementSibling &&
         cur.nextElementSibling.querySelector(':scope > .g-tool, :scope > .g-appr')) {
    cur = cur.nextElementSibling;
  }
  cur.insertAdjacentElement('afterend', row);
}

function bubble(role, html, cls, afterRow) {
  const row = document.createElement('div');
  row.className = 'g-row' + (role === 'user' ? ' me' : '');
  const b = document.createElement('div');
  b.className = 'g-bub' + (cls ? ' ' + cls : '');
  b.innerHTML = html;
  row.appendChild(b);
  /* kullanıcı mesajı daima dipte; cevap balonu sorusunun (afterRow) altına */
  if (role === 'user' || !afterRow) gMsgs.appendChild(row);
  else insertAfterTurn(afterRow, row);
  scrollBottom();
  lsTrim();
  return b;
}

/* Kullanıcı mesajından METİN + gorüntülenebilir görseller (dataUrl/http) çıkar:
   WA'dan gelen fotoğraf data: URL'iyle content'ta taşınır — camda da resim olsun */
function userPartsOf(content, atts) {
  const txts = [];
  const imgs = [];
  const imgPush = (u) => {
    u = String(u || '');
    if (/^(data:image\/|https?:\/\/)/i.test(u)) imgs.push(u);
  };
  if (Array.isArray(content)) {
    for (const p of content) {
      if (!p) continue;
      if (p.type === 'text') txts.push(String(p.text || ''));
      else if (p.type === 'image' || p.type === 'image_url') {
        imgPush(p.type === 'image_url' ? (p.image_url && p.image_url.url) : (p.dataUrl || p.url));
      } else if ((p.type === 'file' || p.type === 'document') && p.name) {
        txts.push('[dosya: ' + p.name + ']');
      } else if (typeof p === 'string') txts.push(p);
    }
  } else txts.push(String(content == null ? '' : content));
  for (const a of (Array.isArray(atts) ? atts : [])) {
    if (a && a.type === 'image') imgPush(a.dataUrl || a.url); /* ekteki resim → inline */
  }
  return { txt: txts.join('\n'), imgs };
}

/* USER BALONU — ZENGİN: metin (WA ses transkripti dahil) + gelen fotoğraflar
   + ek kartları. WhatsApp/Telegram/Discord'dan gelen HER ŞEY camda görünür —
   "beast agent'ta var, camda yok" sorunu biter. */
function userRichBubble(m) {
  const p = userPartsOf(m && m.content, m && m.attachments);
  let html = p.txt.trim() ? mdLite(p.txt) : '';
  for (const u of p.imgs) {
    html += '<img class="g-wimg" src="' + escHtml(u) + '" alt="görsel" loading="lazy">';
  }
  const atts = Array.isArray(m && m.attachments) ? m.attachments : [];
  const chips = atts
    .filter((a) => a && (a.type === 'image' || a.type === 'file' || a.type === 'document'))
    .map((a) =>
      '<span class="g-atchip">' + (a.type === 'image' ? '\u25A3' : '\u2261') + ' ' +
      escHtml(shortTxt(String(a.name || (a.type === 'image' ? 'resim' : 'dosya')), 28)) + '</span>')
    .join('');
  if (chips) html += '<div class="g-attwrap">' + chips + '</div>';
  bubble('user', html || '(boş mesaj)');
}

/* balon sayısı tavanı — glass panel hafif kalsın (600) */
function lsTrim() {
  while (gMsgs.children.length > 600) gMsgs.removeChild(gMsgs.firstChild);
}

function chipRow(elm) {
  const row = document.createElement('div');
  row.className = 'g-row';
  row.appendChild(elm);
  gMsgs.appendChild(row);
  scrollBottom();
  return row;
}

/* arac rozetleri — callId eşlenir; tool-end sonucuyla uygunlaştırılır */
const toolChips = new Map();
function toolChipStart(ev) {
  if (toolChips.has(ev.callId)) return;
  const el = document.createElement('div');
  el.className = 'g-tool spin';
  el.textContent = '🔧 ' + (ev.name || 'araç') + '…';
  const row = chipRow(el);
  toolChips.set(ev.callId, { el, row, name: ev.name || 'araç' });
}
function toolChipEnd(ev) {
  const st = toolChips.get(ev.callId);
  if (!st) return;
  st.el.classList.remove('spin');
  st.el.classList.add(ev.ok === false ? 'fail' : 'ok');
  st.el.textContent = (ev.ok === false ? '⚠ ' : '✓ ') + st.name + (ev.ok === false ? ' · hata' : '');
  toolChips.delete(ev.callId);
}

/* onay / izin rozetleri */
function approvalChip(ev) {
  if (ev.done || approvalGone) return;
  const el = document.createElement('div');
  el.className = 'g-appr';
  el.appendChild(Object.assign(document.createElement('span'), { textContent: '🛡️ Onay: ' + (ev.tool || '?') }));
  const mk = (label, fn) => {
    const btn = document.createElement('div');
    btn.className = 'gk';
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      try { await beast.approvalRespond(ev.requestId, fn.ok, fn.always); } catch {}
      el.remove();
      setDot('', 'onay işlendi');
    });
    el.appendChild(btn);
  };
  mk('Onayla', { ok: true, always: false });
  mk('Her zaman', { ok: true, always: true });
  mk('Reddet', { ok: false, always: false });
  chipRow(el);
}

function permissionChip(req) {
  if (!req || approvalGone) return; // opencode izin kartı
  const el = document.createElement('div');
  el.className = 'g-appr';
  el.appendChild(Object.assign(document.createElement('span'), { textContent: '🔐 İzin: ' + (req.permission || '?') }));
  const mk = (label, action) => {
    const btn = document.createElement('div');
    btn.className = 'gk';
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      try { await beast.permissionReply(req.id, action); } catch {}
      el.remove();
    });
    el.appendChild(btn);
  };
  mk('Bir kez', 'once');
  mk('Her zaman', 'always');
  mk('Ret', 'reject');
  chipRow(el);
}

/* ---------- akış ---------- */
function ensureStream() {
  if (!streambubble || !streambubble.isConnected) {
    streamBuf = '';
    /* yeni cevap balonu SORUSUNUN altına açılır (replyAnchor) — panel yeniden
       yüklenmiş olsa bile cevap doğru sırasına döner */
    streambubble = bubble('assistant', '', 'streaming', replyAnchor);
    replyAnchor = null;
  }
  return streambubble;
}

/* yarım kalan yazı balonu: hata/durdurma sonrası ya da motor sessizce
   kapandıysa kapat — eski kısmi metin yeni cevapla KARIŞMASIN */
function closeStaleStream() {
  if (streamTimer) { clearTimeout(streamTimer); streamTimer = 0; } /* 45ms sonraki render tur bitince patlamasın */
  if (streambubble && streambubble.isConnected) {
    if (String(streamBuf || '').trim()) streamFinalize(streamBuf);
    else {
      const r = streambubble.parentNode; /* .g-row */
      if (r && r.parentNode === gMsgs) r.remove();
      streambubble = null;
      streamBuf = '';
    }
  }
  replyAnchor = null;
}

/* EMNİYET TEMİZLİĞİ: tur bittiğine göre hâlâ 'streaming' sınıfı taşıyıp içinde
   içerik olmayan boş balon kaldıysa sök — boş imleç hazırda ASLA beklemez */
function purgeEmptyStreamBubbles() {
  for (const b of [...gMsgs.querySelectorAll('.g-bub.streaming')]) {
    if (!String(b.textContent || '').trim() && !b.querySelector('img')) {
      const r = b.parentNode;
      if (r && r.parentNode === gMsgs) r.remove();
    }
  }
}

/* --- ÇİFT GÖSTERİM KORUMASI: aynı metin 2 sn içinde ikinci kez gelirse
   (message + interim-final çifti) TEK balon bırakır --- */
let lastFinalText = '';
let lastFinalAt = 0;
function renderAssistantFinal(txt) {
  const key = String(txt || '').trim();
  if (!key) return;
  if (key === lastFinalText && (Date.now() - lastFinalAt) < 2000) return;
  lastFinalText = key;
  lastFinalAt = Date.now();
  streamFinalize(key);
  turnHadLive = true;
}

/* --- UZLAŞMA (done-reconcile): cevabı canlı akış HİÇ düşmediyse — kullanıcı
   "camda cevap görünmüyor, app modunda var" sorunsalı — turun SONUNDA oturum
   geçmişinden eksik mesajlar sessizce çekilir; görünen balonlara dokunulmaz --- */
let reconciling = false;
async function reconcile() {
  if (reconciling || !sid) return;
  reconciling = true;
  try {
    const v = await beast.openSession(sid);
    const list = Array.isArray(v && v.messages) ? v.messages : [];
    /* panelde ZATEN görünen metinler — çift ekleme koruması */
    const have = [...gMsgs.querySelectorAll('.g-bub')]
      .map((b) => (b.textContent || '').trim()).filter(Boolean);
    for (const m of list.slice(-80)) {
      if (!(m.role === 'user' || m.role === 'assistant')) continue;
      const raw = contentText(m && m.content).trim();
      if (!raw) continue;
      /* birebir aynı VEYA birbirinin uzun ön eki (yarım akış) ise atla */
      if (have.some((h) => h === raw ||
          (h.length > 30 && (raw.startsWith(h) || h.startsWith(raw))))) continue;
      if (m.role === 'user') userRichBubble(m); /* '[WhatsApp…' dahil — hiçbir şey gizlenmez */
      else {
        const ct = cleanProactive(raw); /* uzlaşmada da proaktif çizilmez */
        if (ct) bubble('assistant', mdLite(ct));
      }
    }
  } catch {}
  reconciling = false;
}

function streamRender() {
  /* YARIŞ KAPISI: 45ms bekleyen render, tur ('message'/'done') bitiminden sonra
     ateşlenirse BOŞ 'streaming' balon bırakıp hazırda yanıp sönen imleç kalıntısı
     yapıyordu — içerik yoksa balon hiç açılmaz */
  if (!String(streamBuf || '').trim()) return;
  const b = ensureStream();
  b.innerHTML = mdLite(streamBuf);
  b.classList.add('streaming');
  scrollBottom();
}

function streamQueued() {
  if (streamTimer) return;
  streamTimer = setTimeout(() => {
    streamTimer = 0;
    streamRender();
  }, 45);
}

function streamFinalize(text) {
  if (streamTimer) { clearTimeout(streamTimer); streamTimer = 0; } /* bekleyen boş render iptal */
  const b = ensureStream();
  b.innerHTML = mdLite(typeof text === 'string' ? text : streamBuf);
  b.classList.remove('streaming');
  streamBuf = '';
  streambubble = null;
  scrollBottom();
}

/* ---------- dünya ---------- */
async function loadSessions() {
  try { sessions = (await beast.listSessions()) || []; } catch { sessions = []; }
  const cur = gSess.value;
  gSess.innerHTML = sessions.slice(0, 30).map((s) => {
    const t = shortTxt(s.title || s.lastAssistant || 'sohbet', 24);
    return '<option value="' + escHtml(s.id) + '">' + escHtml(t || '(adsız)') + '</option>';
  }).join('');
  if (cur && sessions.some((s) => s.id === cur)) gSess.value = cur;
}

/* EŞZAMANLI YÜKLEME KORUMASI: main senkronu + kullanıcı seçimi aynı anda
   açık geçmişi DOLDURMAYA çalışırsa yalnız EN YENİ istek ekrana yazılır */
let loadSeq = 0;
async function openSid(id, force) {
  if (!force && sid === id) return;
  const mySeq = ++loadSeq;
  sid = String(id);
  try { localStorage.setItem('beastGlassSid', sid); } catch {}
  gMsgs.innerHTML = '';
  toolChips.clear();
  streambubble = null;
  streamBuf = '';
  replyAnchor = null;
  turnHadLive = false;
  try {
    const v = await beast.openSession(sid);
    if (mySeq !== loadSeq) return; /* araya yeni yükleme girdi — bu sonuç bayat */
    const list = Array.isArray(v && v.messages) ? v.messages : [];
    for (const m of list.slice(-80)) {
      const txt = contentText(m && m.content);
      if (!txt.trim()) continue;
      if (m.role === 'user') userRichBubble(m); /* WA geçmişi + görseller + ekler dahil */
      else if (m.role === 'assistant') {
        const ct = cleanProactive(txt); /* geçmiş yüklerken de proaktif gizli */
        if (ct) bubble('assistant', mdLite(ct));
      }
    }
  } catch { if (mySeq === loadSeq) bubble('assistant', '(geçmiş yüklenemedi — panele yazabilirsin)'); }
  if (mySeq === loadSeq) {
    if (sessions.some((s) => s.id === sid)) { try { gSess.value = sid; } catch {} }
    setDot('ok', 'hazır · ' + sid.slice(0, 8));
  }
}

function onEvent(ev) {
  /* TEK BOZUK EVENT tüm paneli sessizleştirmesin — hata konsola düşsün */
  try { onEventInner(ev); } catch (e) { console.error('glass event:', e); }
}

function onEventInner(ev) {
  /* oturum filtresi — cama seçilen oturum düşer (masaüstü aktif sohbetiyle
     SENKRON: main 'glass-session' olayı bu sid'i camda güncel tutar) */
  if (ev.sessionId && sid && ev.sessionId !== sid) return;
  switch (ev.type) {
    case 'sessions':
      loadSessions();
      break;
    case 'glass-session':
      /* CAM ↔ MASAÜSTÜ SENKRONU: beast-agent ekranı hangi sohbeti açtıysa cam
         panel ONU açar — iki panelde de AYNI sohbet, AYNI canlı akış */
      if (ev.sessionId && ev.sessionId !== sid) openSid(ev.sessionId, true);
      break;
    case 'clear':
      /* /clear GERÇEK silme — cam ekranı da sıfırlanır (beast-agent ekranıyla
         aynı davranış): canlı akış balonu kapanır, geçmiş boşalır, koşan tur
         sürüyorsa sıradaki olaylar dupa sıfır ekrana düşer */
      gMsgs.innerHTML = '';
      toolChips.clear();
      streambubble = null;
      streamBuf = '';
      replyAnchor = null;
      turnHadLive = false;
      if (!busy) {
        setDot('ok', 'geçmiş silindi · sıfırdan yazabilirsin');
      } else {
        setDot('busy', 'geçmiş silindi — koşan tur bitince tam temiz');
      }
      try { gSess.value = sid; } catch {}
      break;
    case 'wa-stt':
      /* ANLIK STT KÖPRÜSÜ: WA sesli mesaj geldiğinde yazıya çevirme süreci
         camda da canlı görünür ("çevriliyor…" durum satırı) */
      if (ev.state === 'transcribing') setDot('busy', '🎤 WhatsApp sesli mesaj yazıya çevriliyor…');
      else if (ev.state === 'done') setDot('busy', '🎤 ses yazıya çevrildi — mesaj geldiğinde konuşmada görünür');
      else setDot('err', '🎤 ses yazıya çevrilemedi');
      break;
    case 'message': {
      const m = ev.message || {};
      const txt = contentText(m.content);
      if (!txt.trim() && String(m.role) !== 'user') break;
      if (m.role === 'user') {
        /* '[WhatsApp…' / '[sesli mesaj transkripti]…' dahil TÜM kullanıcı
           mesajları görünüyor — beast-agent chatteriyle birebir aynı */
        turnHadLive = false; /* YENİ TUR: canlı akış haritası sıfır */
        userRichBubble(m);
        setDot(busy ? 'busy' : 'ok', busy ? 'robot yapıyor…' : 'gönderildi');
      } else {
        const clean = cleanProactive(txt); /* proaktif not cam penceresinden süzülür */
        if (clean) {
          renderAssistantFinal(clean);
          /* araç çağrılı mesajsa tur SÜRÜYOR — meşgul lütfen bırakma (main gibi) */
          const hasTools = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
          if (!hasTools) { busy = false; updateStopVisible(); }
        }
      }
      break;
    }
    case 'interim-final': {
      /* steer'le SÜRÜKEN ara cevap: canlı akış balonu açıksa onu bitir; en
         sonda 'message' eşleniği zaten düştüyse çift koruması yakalar */
      const m = ev.message || {};
      const txt = cleanProactive(contentText(m.content)); /* proaktif süzüldü */
      if (streambubble && String(streamBuf || '').trim()) streamFinalize(streamBuf);
      else if (String(txt || '').trim()) renderAssistantFinal(txt);
      break;
    }
    case 'token':
      if ((!streambubble || !streambubble.isConnected) && !replyAnchor) {
        replyAnchor = lastUserRow(); /* yeni cevap → sorusunun sırası */
      }
      turnHadLive = true; /* canlı akış geldi — done'da uzlaşma gerekmez */
      streamBuf += String(ev.delta || '');
      streamQueued();
      setDot('busy', 'yazıyor…');
      busy = true; updateStopVisible();
      break;
    case 'status':
      busy = ev.status !== 'idle';
      updateStopVisible();
      setDot(busy ? 'busy' : 'ok', busy ? (String(ev.status || 'çalışıyor') + '…') : 'hazır');
      break;
    case 'tool-start':
      busy = true; updateStopVisible();
      toolChipStart(ev);
      setDot('busy', '🔧 ' + (ev.name || 'araç') + '…');
      break;
    case 'tool-end':
      toolChipEnd(ev);
      setDot('busy', 'düşünüyor…');
      break;
    case 'done':
      busy = false; updateStopVisible();
      closeStaleStream();
      purgeEmptyStreamBubbles(); /* boş imleç kalıntısı kapatılır */
      if (!turnHadLive) reconcile(); /* cevap canlı kaçtıysa geçmişten çek ✓ */
      turnHadLive = false;
      setDot('ok', 'hazır');
      /* KONUŞMA MODU: cevap bitti → son ajan yazısını bekleyen döngüye ver */
      if (vWaitRes) { const r = vWaitRes; vWaitRes = null; try { r(lastAssistantText() || ''); } catch {} }
      break;
    case 'error':
      busy = false; updateStopVisible();
      closeStaleStream();
      purgeEmptyStreamBubbles(); /* boş imleç kalıntısı kapatılır */
      turnHadLive = false;
      if (vWaitRes) { const r = vWaitRes; vWaitRes = null; try { r(''); } catch {} }
      bubble('assistant', '<b style="color:#ff8f9d">⚠ HATA:</b> ' + escHtml(ev.error || '')); // kırmızı rozet
      setDot('err', 'hata');
      break;
    case 'approval':
      approvalChip(ev);
      break;
    case 'permission.asked':
      permissionChip(ev.request);
      break;
    default:
      break;
  }
}

/* ---------- event eşleme ---------- */
/* INBOX OTOMATİK BÜYÜME: kutu 34px'de butonlarla dimdik başlar; satır
   eklendikçe içeriğine göre uzar, 140px tavanda kutu İÇİNDE kayma açılır */
const G_INPUT_MIN = 34;
const G_INPUT_MAX = 140;
function inputAutoFit() {
  try {
    gInput.style.height = 'auto';
    const h = Math.min(Math.max(gInput.scrollHeight, G_INPUT_MIN), G_INPUT_MAX);
    gInput.style.height = h + 'px';
    gInput.style.overflowY = gInput.scrollHeight > G_INPUT_MAX + 1 ? 'auto' : 'hidden';
  } catch {}
}
inputAutoFit();

$('#gSend').addEventListener('click', send);

/* İMLEÇ SESSİZ MODU: kutu hazırda beklerken imleç yanıp sönmesin — bir tuşa
   değince ya da yazarken görünür olur, 1.5 sn hareketsizlikte yeniden gizlenir */
let caretTimer = 0;
function caretOn() {
  gInput.classList.add('caret-on');
  if (caretTimer) clearTimeout(caretTimer);
  caretTimer = setTimeout(() => {
    caretTimer = 0;
    gInput.classList.remove('caret-on');
  }, 1500);
}
gInput.addEventListener('mousedown', caretOn);
gInput.addEventListener('keydown', caretOn);

/* ---------- SLASH KOMUT MENÜSÜ: "/" yazınca inbox üstünde filtreli liste
   açılır. Komutlar agent:send'de yine işlenir (camda da çalıyordu) — bu liste
   yalnız YARDIMCI: beast-agent ekranındaki slash menüsünün aynısı. ---------- */
const G_SLASH = [
  { cmd: '/help', desc: 'tüm komutları listele' },
  { cmd: '/version', desc: 'Beast Agent sürümünü göster' },
  { cmd: '/new', desc: 'yeni sohbet aç (eski sohbet listede kalır)' },
  { cmd: '/open ', desc: 'koddaki oturuma geç' },
  { cmd: '/sessions', desc: 'bu sohbetin oturumları' },
  { cmd: '/stop', desc: 'çalışan her şeyi durdur + kilitle — kilit yalnız /start ile açılır' },
  { cmd: '/restart', desc: 'uygulamayı yeniden başlat' },
  { cmd: '/change', desc: 'modelleri listele · /change 5 ile geç' },
  { cmd: '/screenshot', desc: 'ekran görüntüsünü sohbete ekle' },
  { cmd: '/notify', desc: 'hata maili aç/kapa · /notify on|off' },
  { cmd: '/think ', desc: 'düşünme seviyesi · /think 0-5 (0 kapalı)' },
  { cmd: '/clear', desc: 'oturum geçmişini GERÇEKTEN sil (kod korunur)' },
  { cmd: '/autodel', desc: 'tüm otomatik hatırlatmaları sil · /autodel all: cron dahil hepsi' },
  { cmd: '/deltodo', desc: 'todo listesini temizle · /deltodo all: tüm oturumlar' },
  { cmd: '/start', desc: 'kilidi aç; yeni istekler normal işlenir' },
  { cmd: '/rule ', desc: 'kalıcı kural ekle' },
  { cmd: '/rules', desc: 'kalıcı kuralları listele' },
  { cmd: '/model', desc: 'modeli göster/değiştir' },
  { cmd: '/skills', desc: 'kurulu skill\u2019ler' },
  { cmd: '/usage', desc: 'bugünkü kullanım' },
  { cmd: '/backup', desc: 'veriyi zip\u2019e yedekle' },
  { cmd: '/status', desc: 'bağlantı ve servis durumu' },
];

function gSlashHide() {
  if (gSlash) {
    gSlash.hidden = true;
    gSlash.innerHTML = '';
  }
}

/* seçili satırı işaretler + ekranda görünür kalır (↑↓ ile gezinirken) */
function gSlashMark(items, idx) {
  items.forEach((x, i) => x.classList.toggle('sel', i === idx));
  const cur = items[idx];
  if (cur && cur.scrollIntoView) { try { cur.scrollIntoView({ block: 'nearest' }); } catch {} }
}

function gSlashPick(cmd) {
  gSlashHide();
  gInput.value = cmd;
  gInput.focus();
  const L = gInput.value.length;
  try { gInput.setSelectionRange(L, L); } catch {}
  inputAutoFit();
  caretOn(); /* seçim sonrası argüman yazılır — imleç o an görünsün */
}

/* input'un başında "/" varsa (tek satırsa) filtreli komut listesini göster */
function gSlashUpdate() {
  if (!gSlash) return;
  const v = String(gInput.value || '');
  if (!v.startsWith('/') || v.includes('\n')) { gSlashHide(); return; }
  const q = v.slice(1).toLowerCase();
  const matches = G_SLASH.filter(
    (c) => !q || c.cmd.trim().toLowerCase().slice(1).startsWith(q) || c.desc.toLowerCase().includes(q)
  );
  if (!matches.length) { gSlashHide(); return; }
  gSlash.innerHTML =
    '<div class="gs-sub">Hazır komutlar — Enter ile seç</div>' +
    matches.map((c, i) =>
      '<div class="gs-item' + (i === 0 ? ' sel' : '') + '" data-cmd="' + escHtml(c.cmd) + '">' +
      '<span class="s-cmd">' + escHtml(c.cmd.trim()) + '</span>' +
      '<span class="s-desc">' + escHtml(c.desc) + '</span></div>'
    ).join('');
  gSlash.hidden = false;
  gSlash.scrollTop = 0;
  for (const item of gSlash.querySelectorAll('.gs-item')) {
    item.addEventListener('click', () => gSlashPick(item.dataset.cmd));
    item.addEventListener('mousemove', () => {
      if (item.classList.contains('sel')) return;
      const items = [...gSlash.querySelectorAll('.gs-item')];
      gSlashMark(items, items.indexOf(item));
    });
  }
}

gInput.addEventListener('keydown', (e) => {
  if (gSlash && !gSlash.hidden) {
    const items = [...gSlash.querySelectorAll('.gs-item')];
    const idx = items.findIndex((x) => x.classList.contains('sel'));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) gSlashMark(items, (idx + 1) % items.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) gSlashMark(items, (idx - 1 + items.length) % items.length);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (items.length) items[Math.max(0, idx)].click();
      return;
    }
    if (e.key === 'Escape') {
      gSlashHide();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

gInput.addEventListener('input', () => {
  caretOn(); /* yazarken imleç görünür — boşta gizli kalır */
  gSlashUpdate();
  inputAutoFit();
});

/* ---------- EK SİSTEMİ (ATAÇ): resim/metin dosyası seçimi + Ctrl+V
   yapıştırma. beast-agent ekranındaki 'attachments' düzenesinin birebir cam
   kopyası — engine, {text, attachments} payload'ını WA/masaüstüyle aynı
   yoldan işler: resim → vision parçası (dataUrl), metin dosyası →
   attachments.content. Ek çipleri + resimler camda userRichBubble ile
   zaten çiziliyor. ---------- */
const G_TEXT_EXT = /\.(txt|md|json|csv|log|js|ts|py|ps1|bat|cmd|html|css|yaml|yml|xml|ini)$/i;
let gPending = [];

function gNudge(msg) {
  /* camda toast yok — durum satırı kısa uyarı verir; sonra hazıra döner */
  setDot('err', msg);
  setTimeout(() => { if (!busy) setDot('ok', 'hazır'); }, 2400);
}

function gRenderChips() {
  if (!gChips) return;
  gChips.innerHTML = '';
  gChips.hidden = gPending.length === 0;
  gPending.forEach((a, i) => {
    const c = document.createElement('span');
    c.className = 'g-pchip';
    c.title = 'Eki çıkarmak için tıkla';
    c.appendChild(document.createTextNode((a.type === 'image' ? '\u25A3 ' : '\u2261 ') + a.name));
    const x = document.createElement('span');
    x.className = 'px';
    x.textContent = '×';
    x.addEventListener('click', () => { gPending.splice(i, 1); gRenderChips(); });
    c.appendChild(x);
    gChips.appendChild(c);
  });
}

function gAddFiles(files) {
  for (const f of files) {
    if (!f) continue;
    if (f.size > 8 * 1024 * 1024) { gNudge('\u{1F4E5} Çok büyük (max 8MB): ' + f.name); continue; }
    if (f.type && String(f.type).startsWith('image/')) {
      const r = new FileReader();
      r.onload = () => {
        if (gPending.length >= 6) { gNudge('En fazla 6 ek'); return; }
        gPending.push({ type: 'image', name: f.name, dataUrl: String(r.result) });
        gRenderChips();
      };
      r.readAsDataURL(f);
    } else if (G_TEXT_EXT.test(String(f.name || ''))) {
      f.text().then((t) => {
        if (gPending.length >= 6) { gNudge('En fazla 6 ek'); return; }
        gPending.push({ type: 'file', name: f.name, content: t.slice(0, 200000) });
        gRenderChips();
      });
    } else {
      gNudge('Desteklenmeyen tür: ' + f.name + ' (resim ya da metin dosyası)');
    }
  }
}

if (gAttach) gAttach.addEventListener('click', () => {
  if (gFile) { gFile.value = ''; gFile.click(); }
  caretOn(); /* dosya penceresi kapanınca imleç görünür dursun */
});
if (gFile) gFile.addEventListener('change', () => { gAddFiles([...gFile.files]); gFile.value = ''; });

/* CTRL+V YAPIŞTIRMA: pano RESİM (ya da dosya) içeriyorken pano → ek çipi.
   Metin yapıştırmaları AYNEN default davranışta kalır (input'a yazılır).
   Yapıştırma olayı input'ta odaklıyken de pencerenin başka yerinde de
   yakalanır — DOM paste event'iyle gelir, ek API çağrısı gerekmez. */
/* panodan ek yapıştırmasının durum ışığı — art arda yapıştırmada zamanlayıcı yenilenir */
let pasteNotifyT = 0;

document.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items || !items.length) return;
  const files = [];
  let hasAtt = false;
  for (const it of items) {
    if (!it || it.kind !== 'file') continue;
    const f = it.getAsFile && it.getAsFile();
    if (!f) continue;
    files.push(f);
    if (!f.type || String(f.type).startsWith('image/') || G_TEXT_EXT.test(String(f.name || ''))) hasAtt = true;
  }
  if (!hasAtt || !files.length) return;
  e.preventDefault();
  gAddFiles(files);
  gInput.focus();
  /* KULLANICIYA GERİ BİLDİRİM: yapıştırılan resim/dosya ek olarak alındı */
  const pastedImg = files.every((f) => f.type && String(f.type).startsWith('image/'));
  setDot('ok', pastedImg ? '\u25A3 resim eklendi (Ctrl+V)' : '\u2261 dosya eklendi (Ctrl+V)');
  clearTimeout(pasteNotifyT);
  pasteNotifyT = setTimeout(() => { if (!busy) setDot('ok', 'hazır'); }, 2000);
});

async function send() {
  const text = String(gInput.value || '').trim();
  const atts = gPending.slice();
  if (!text && !atts.length) return;
  if (!sid) { setDot('err', 'önce sohbet seç'); return; }
  /* slash komutunda ekler anlamsız — komut her zaman düz metin gider */
  const attsOut = (atts.length && !text.startsWith('/')) ? atts : [];
  gInput.value = '';
  gPending = [];
  gRenderChips();
  inputAutoFit(); /* boş kutu 34px'e iner — aynı yükseklik */
  gSlashHide(); /* / listesi açıkken gönderildi → liste kapansın */
  if (!busy) closeStaleStream(); /* önceki yarım yazı balonu temizlenir */
  setDot('busy', 'gönderildi…');
  busy = true; updateStopVisible();
  try {
    await beast.send(sid,
      attsOut.length
        ? { text: text.slice(0, 8000), attachments: attsOut }
        : text.slice(0, 8000));
  } catch {
    /* gönderilemedi → metin + ekler GERİ gelsin, kaybolmasın */
    try { gInput.value = text; inputAutoFit(); } catch {}
    if (atts.length) { gPending = atts; gRenderChips(); }
    setDot('err', 'gönderilemedi (motor kapalı?)');
    busy = false; updateStopVisible();
  }
}

gSess.addEventListener('change', () => openSid(gSess.value, true));
$('#gStop').addEventListener('click', async () => {
  if (!sid) return;
  setDot('busy', 'durduruluyor…');
  try { await beast.interrupt(sid, 'cam panelden durdurma'); } catch {}
  busy = false; updateStopVisible();
  closeStaleStream(); /* yarım yazı balonu kapatılır — sıra bozulmasın */
  if (vWaitRes) { const r = vWaitRes; vWaitRes = null; try { r(''); } catch {} }
  if (vSpeak) { try { vSpeak.pause(); } catch {} vSpeak = null; }
  setDot('ok', 'durduruldu');
});

/* ---------- KONUŞMA MODU (cam STT + TTS) — EKRAN AYNI KALIR ----------
   🎤 bas: mikrofon açılır → konuşursun, ~1 sn sessizlik = cümle sonu →
   Duyu STT (yerel) transkript → oturuma gönderilir → cevap akmaya başlar →
   'done' olunca son ajan yazısı TTS (5 motor zinciri) ile SESLENDİRİLİR →
   tekrar dinlemeye döner. "dur dinleme / görüşürüz..." dersen mod kapanır. */

const V_STOPS = [
  'dur dinleme', 'dinlemeyi durdur', 'dinlemeyi bırak', 'boş ver artık',
  'iptal et', 'görüşürüz', 'gorusuruz', 'kapat konuşmayı', 'hoşça kal', 'hosca kal',
  'bay bay', 'stop', 'stop it', 'stop listening', 'stop please', 'goodbye', 'good bye',
];

const vsleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isVoiceStop(t) {
  const n = String(t || '').toLowerCase().replace(/[.,!?;:…]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n) return false;
  return V_STOPS.includes(n);
}

let voiceOn = false;
let vStream = null;
let vRec = null;
let vChunks = [];
let vAna = null;
let vBuf = null;
let vCtx = null;
let vTimer = 0;
let vWaitRes = null; /* cevabı bekleyen döngü çözücüsü ('done' çözer) */
let vSpeak = null;   /* çalan Audio elementi */
let vLoopTurn = false;
let vNoSpeech = 0;   /* üst üste boş tur sayacı — 10'da mod kapanır */

/* anlık mikrofon seviyesi (RMS) — sessizlik algısı */
function vLevel() {
  try {
    vAna.getFloatTimeDomainData(vBuf);
    let s = 0;
    for (let i = 0; i < vBuf.length; i++) s += vBuf[i] * vBuf[i];
    return Math.sqrt(s / vBuf.length);
  } catch { return 0; }
}

function voiceStop() {
  voiceOn = false;
  gVoice.classList.remove('on');
  gVoice.title = 'Konuşma modu (STT + TTS)';
  try { if (vRec && vRec.state !== 'inactive') { vRec.onstop = null; vRec.stop(); } } catch {}
  vRec = null;
  if (vTimer) { clearInterval(vTimer); vTimer = 0; }
  if (vWaitRes) { const r = vWaitRes; vWaitRes = null; try { r('__off__'); } catch {} }
  if (vSpeak) { try { vSpeak.pause(); } catch {} vSpeak = null; }
  if (vStream) { try { vStream.getTracks().forEach((t) => t.stop()); } catch {} vStream = null; }
  try { if (vCtx) vCtx.close(); } catch {}
  vCtx = null; vAna = null; vBuf = null;
  vLoopTurn = false;
  setDot('ok', 'konuşma modu kapandı');
}

async function voiceToggle() {
  if (voiceOn) { voiceStop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof window.MediaRecorder !== 'function') {
    setDot('err', 'm mikrofon desteklenmiyor');
    return;
  }
  try {
    vStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    setDot('err', 'mikrofon erişimi reddedildi');
    return;
  }
  voiceOn = true;
  vNoSpeech = 0;
  gVoice.classList.add('on');
  gVoice.title = 'Konuşma modunu kapat';
  try {
    vCtx = new (window.AudioContext || window.webkitAudioContext)();
    vAna = vCtx.createAnalyser();
    vAna.fftSize = 1024;
    vBuf = new Float32Array(vAna.fftSize);
    vCtx.createMediaStreamSource(vStream).connect(vAna);
  } catch { vAna = null; vBuf = null; }
  /* motor ön-ısıtma: STT yoklaması + TTS ilk cümle soğuk yükleme beklemesin */
  try { beast.sttPrefetchNow(); } catch {}
  try { beast.emaPrefetch(); } catch {}
  updateStopVisible(); /* raining açıkken ajan meşgul görünür */
  setDot('busy', '🎤 konuşma modu — dinliyormusun: konuş…');
  vLoopTurn = false;
  setTimeout(voiceLoop, 250);
}

function blobDataUrl(b) {
  return new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(b);
  });
}

/* TEK dinleme turu: sesi yakala; konuşma bitince (~1 sn sessizlik) blob döner */
function voiceListenOnce() {
  return new Promise((resolve) => {
    let heard = false;
    let silence = 0;
    let total = 0;
    let resolver = resolve;
    vChunks = [];
    let rec = null;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find((t) => window.MediaRecorder.isTypeSupported(t)) || '';
    try {
      rec = new MediaRecorder(vStream, mime ? { mimeType: mime } : undefined);
    } catch { vRec = null; resolve(null); return; }
    vRec = rec;
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) vChunks.push(ev.data); };
    rec.onstop = () => {
      const out = vChunks;
      vChunks = [];
      vRec = null;
      if (vTimer) { clearInterval(vTimer); vTimer = 0; }
      const r = resolver; resolver = null;
      r((heard && out.length) ? new Blob(out, { type: rec.mimeType || mime || 'audio/webm' }) : null);
    };
    try { rec.start(250); } catch { vRec = null; resolve(null); return; }
    if (vTimer) clearInterval(vTimer);
    vTimer = setInterval(() => {
      const lvl = vAna ? vLevel() : 0.05;
      if (lvl > 0.075) { heard = true; silence = 0; }
      else if (heard) silence += 90;
      total += 90;
      if (!voiceOn || (heard && silence >= 1050) || total >= 60000) {
        if (vTimer) { clearInterval(vTimer); vTimer = 0; }
        try { if (rec.state !== 'inactive') rec.stop(); } catch {}
        if (!voiceOn && resolver) { const r = resolver; resolver = null; r(null); }
      }
    }, 90);
  });
}

/* cevabın bitmesini bekle — 'done' son ajan yazısını çözer */
function voiceWaitReply() {
  return new Promise((resolve) => {
    if (!voiceOn) { resolve('__off__'); return; }
    vWaitRes = resolve;
    setTimeout(() => {
      if (vWaitRes === resolve) { vWaitRes = null; resolve('__timeout__'); }
    }, 240000);
  });
}

/* metni 5 motor zinciri (ema/ahenk/edge/piper/supertonic) ile seslendir */
async function voiceSpeak(text) {
  try {
    setDot('busy', '🔊 seslendiriliyor…');
    const r = await beast.ttsSpeak(String(text || '').slice(0, 4000));
    if (!(r && r.ok && r.audioB64)) {
      setDot('err', 'TTS: ' + ((r && r.error) || 'kapalı'));
      return;
    }
    try { vCtx && vCtx.resume(); } catch {}
    vSpeak = new Audio('data:' + (r.mime || 'audio/wav') + ';base64,' + r.audioB64);
    await new Promise((res) => {
      vSpeak.onended = () => res();
      vSpeak.onerror = () => res();
      try { vSpeak.play(); } catch { res(); }
      /* takılsın da: 2 dk tavan — sonra sessizce kes ve dinlemeye dön */
      setTimeout(() => { if (vSpeak) { try { vSpeak.pause(); } catch {} vSpeak = null; res(); } }, 120000);
    });
    vSpeak = null;
  } catch { vSpeak = null; }
}

/* paneldeki SON ajan balonunun metni (seslendirilecek cevap) */
function lastAssistantText() {
  const rows = gMsgs.querySelectorAll('.g-row:not(.me) > .g-bub');
  const b = rows[rows.length - 1];
  return b ? (b.textContent || '').trim() : '';
}

async function voiceLoop() {
  if (!voiceOn || vLoopTurn) return;
  vLoopTurn = true;
  try {
    while (voiceOn) {
      /* ajan hâlâ çalışıyorsa (send kuyruğa girdiyse) sakin bekle */
      let waited = 0;
      while (voiceOn && busy && waited < 240000) { await vsleep(400); waited += 400; }
      if (!voiceOn) break;
      setDot('busy', '🎤 dinliyorum — konuşabilirsin…');
      const blob = await voiceListenOnce();
      if (!voiceOn) break;
      if (!blob) {
        vNoSpeech++;
        if (vNoSpeech >= 10) { voiceStop(); break; }
        continue;
      }
      vNoSpeech = 0;
      setDot('busy', 'sözün çözülüyor…');
      let text = '';
      try {
        const b64 = await blobDataUrl(blob);
        const r = await beast.sttTranscribe(b64, 'tr', 1);
        text = (r && r.ok && r.text) ? String(r.text).trim() : '';
      } catch {}
      if (!voiceOn) break;
      if (!text) { setDot('busy', 'anlaşılmadı — tekrar dinliyorum…'); continue; }
      if (isVoiceStop(text)) { voiceStop(); break; }
      /* duyduğun söz önce INPUT'TA görünür (kanıt), gönderince silinir */
      gInput.value = text;
      gSlashHide(); /* konuşma metni / ile başlasa bile eski liste ekranda kalmasın */
      inputAutoFit(); /* konuşma doldur ancak kutu düzgün boyuta otursun */
      setDot('busy', '📩 ' + text.slice(0, 60));
      turnHadLive = false;
      try {
        await beast.send(sid, text.slice(0, 4000));
      } catch {
        setDot('err', 'gönderilemedi (motor kapalı?)');
        break;
      }
      if (!voiceOn) break;
      const rep = await voiceWaitReply();
      if (rep === '__off__' || !voiceOn) break;
      if (typeof rep === 'string' && rep && rep !== '__timeout__') await voiceSpeak(rep);
      if (!voiceOn) break;
    }
  } catch (e) { console.error('voice loop:', e); }
  vLoopTurn = false;
}

gVoice.addEventListener('click', () => { voiceToggle(); });
$('#gClose').addEventListener('click', () => { beast.glassDesktop(); });

/* ---------- TEMA MENÜSÜ: mavi / siyah / beyaz cam ---------- */
function markTheme() {
  const t = document.body.dataset.theme || 'blue';
  gThemePop.querySelectorAll('.g-titem').forEach((el) => el.classList.toggle('sel', el.dataset.t === t));
}
$('#gTheme').addEventListener('click', (e) => {
  e.stopPropagation();
  gThemePop.hidden = !gThemePop.hidden;
  markTheme();
  markBrowser(); /* tarayıcı seçimi de pop her açıldığında GÜNCEL işaretlensin */
});
gThemePop.querySelectorAll('.g-titem[data-t]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    document.body.dataset.theme = el.dataset.t;
    try { localStorage.setItem('beastGlassTheme', el.dataset.t); } catch {}
    gThemePop.hidden = true;
  });
});
/* TARAYICI SEÇİMİ (cam özel): gömülü = panel içi; harici = sistem tarayıcısı */
async function markBrowser() {
  let v = 'external';
  try { v = String((await beast.glassBrowserGet()) || 'external'); } catch {}
  gThemePop.querySelectorAll('.g-bopt').forEach((el) => el.classList.toggle('sel', el.dataset.b === v));
}
gThemePop.querySelectorAll('.g-bopt').forEach((el) => {
  el.addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await beast.glassBrowserSet(el.dataset.b); } catch {}
    gThemePop.hidden = true;
    markBrowser();
  });
});
document.addEventListener('click', () => {
  if (gThemePop && !gThemePop.hidden) gThemePop.hidden = true;
  gSlashHide(); /* panel dışına tıklandı → komut listesi kapansın */
});

/* ---------- MİNİ BALON: − ekrandan çeker; baloncuk tıklanınca geri döner ---------- */
$('#gMini').addEventListener('click', () => {
  try { beast.glassMini(true); } catch {}
});
$('#gMiniBall').addEventListener('click', () => {
  try { beast.glassMini(false); } catch {}
});
try {
  beast.glassOnMini((on) => {
    document.body.classList.toggle('mini', !!on);
  });
} catch {}

/* Olay aboneliği EN BAŞTA: cam penceresi açıkken main'in senkron push'u
   (glass-session) açılış beklemeden yakalanır — bota geçerli sohbet gecikmez */
beast.onEvent(onEvent);

/* ---------- init ---------- */
(async function init() {
  /* kayıtlı tema geri yükle */
  try { document.body.dataset.theme = localStorage.getItem('beastGlassTheme') || 'blue'; } catch {}
  let savedSid = '';
  try { savedSid = localStorage.getItem('beastGlassSid') || ''; } catch {}
  await loadSessions();
  const pick = sessions.some((s) => s.id === savedSid) ? savedSid
    : (sessions[0] && sessions[0].id) || null;
  if (pick) {
    gSess.value = pick;
    await openSid(pick, true);
  } else {
    setDot('err', 'sohbet yok — ana pencereden başlat');
  }
  updateStopVisible(); /* boşta: durdur gizli başlar */
  markBrowser(); /* kayıtlı tarayıcı seçimi işaretlensin */
  setDot('ok', 'hazır');
})();
