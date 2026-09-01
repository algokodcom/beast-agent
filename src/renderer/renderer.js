'use strict';

/* Beast renderer — vanilla JS, event-driven via window.beast IPC bridge. */

const $ = (s) => document.querySelector(s);
const _t = (k) => (window.I18N ? window.I18N.t(k) : k);
const _ti = (k, n) => (window.I18N ? window.I18N.t(k).replace('${n}', n) : k);

const els = {
  newChat: $('#newChat'),
  sessList: $('#sessList'),
  modelDD: $('#modelDD'),
  modelBtn: $('#modelBtn'),
  modelBtnLabel: $('#modelBtnLabel'),
  modelMenu: $('#modelMenu'),
  thinkDD: $('#thinkDD'),
  thinkBtn: $('#thinkBtn'),
  thinkBtnLabel: $('#thinkBtnLabel'),
  thinkMenu: $('#thinkMenu'),
  thinkList: $('#thinkList'),
  modelFilter: $('#modelFilter'),
  modelList: $('#modelList'),
  pickCfg: $('#pickCfg'),
  pickCfgBtn: $('#pickCfgBtn'),
  modelRefreshBtn: $('#modelRefreshBtn'),
  pickCfgMenu: $('#pickCfgMenu'),
  cfgAll: $('#cfgAll'),
  cfgNone: $('#cfgNone'),
  cfgList: $('#cfgList'),
  themeBtn: $('#themeBtn'),
  langBtn: $('#langBtn'),
  chatScroll: $('#chatScroll'),
  msgs: $('#msgs'),
  empty: $('#empty'),
  input: $('#input'),
  sendBtn: $('#sendBtn'),
  stopBtn: $('#stopBtn'),
  slashMenu: $('#slashMenu'),
  statusPill: $('#statusPill'),
  todoPanel: $('#todoPanel'),
  browserBtn: $('#browserBtn'),
  eyeBtn: $('#eyeBtn'),
  netDot: $('#netDot'),
  railBtn: $('#railBtn'),
  watchBtn: $('#watchBtn'),
  cronBtn: $('#cronBtn'),
  watchOverlay: $('#watchOverlay'),
  cronOverlay: $('#cronOverlay'),
  watchClose: $('#watchClose'),
  cronClose: $('#cronClose'),
  watchList: $('#watchList'),
  cronModalList: $('#cronModalList'),
  browserBar: $('#browserBar'),
  bbBack: $('#bbBack'),
  bbFwd: $('#bbFwd'),
  bbReload: $('#bbReload'),
  bbUrl: $('#bbUrl'),
  bbOpenExt: $('#bbOpenExt'),
  bbShot: $('#bbShot'),
  bbClose: $('#bbClose'),
  bbResize: $('#bbResize'),
  termCBtn: $('#termCBtn'),
  termPanel: $('#termPanel'),
  termCwd: $('#termCwd'),
  termBody: $('#termBody'),
  termOut: $('#termOut'),
  termInput: $('#termInput'),
  termStop: $('#termStop'),
  termClear: $('#termClear'),
  termClose: $('#termClose'),
  termResize: $('#termResize'),
  bcOut: $('#bcOut'),
  bcCwd: $('#bcCwd'),
  bcInput: $('#bcInput'),
  bcStop: $('#bcStop'),
  bcClear: $('#bcClear'),
  bcNew: $('#bcNew'),
  bcTodoWrap: $('#bcTodoWrap'),
  codeTabs: $('#codeTabs'),
  codeTa: $('#codeTa'),
  codePath: $('#codePath'),
  codeSave: $('#codeSave'),
  ideRow: $('#ideRow'),
  ideSplit: $('#ideSplit'),
  bcPanel: $('#bcPanel'),
  fileCtxMenu: $('#fileCtxMenu'),
  cronName: $('#cronName'),
  cronPreset: $('#cronPreset'),
  cronSchedule: $('#cronSchedule'),
  cronPrompt: $('#cronPrompt'),
  cronAddBtn: $('#cronAddBtn'),
  cronList: $('#cronList'),
  gearBtn: $('#gearBtn'),
  settingsOverlay: $('#settingsOverlay'),
  setClose: $('#setClose'),
  beastCode: $('#beastCode'),
  bcCopy: $('#bcCopy'),
  attachBtn: $('#attachBtn'),
  micBtn: $('#micBtn'),
  fileInput: $('#fileInput'),
  chips: $('#chips'),
  toast: $('#toast'),
  railList: $('#railList'),
};

let state = null;
let activeId = null;
let busy = false;
let pending = [];

/* current streaming bubble */
let streamEl = null;
let streamRaw = '';
let renderQueued = false;

/* #19 sağ panel tercih durumu (tarayıcı açılmadan önceki) — panel varsayılan KAPALI */
let railPrefBeforeBrowser = false;

function toggleRail(hide) {
  document.body.classList.toggle('rail-hidden', !!hide);
  if (els.railBtn) els.railBtn.classList.toggle('on', !hide);
}

/* ---------------- mini markdown ---------------- */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\*/g, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="#" data-url="$2">$1</a>');
}

function md(raw) {
  const blocks = [];
  let text = escapeHtml(String(raw || ''));

  text = text.replace(/```(\w*)\n([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });

  const lines = text.split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let para = [];

  const flushPara = () => {
    if (para.length) { out.push('<p>' + mdInline(para.join('<br>')) + '</p>'); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push(`<h${Math.min(3, h[1].length)}>${mdInline(h[2])}</h${Math.min(3, h[1].length)}>`); }
    else if (ul) { flushPara(); if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${mdInline(ul[1])}</li>`); }
    else if (ol) { flushPara(); if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${mdInline(ol[1])}</li>`); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();

  text = out.join('');
  text = text.replace(/\u0000B(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  return text;
}

/* ---------------- helpers ---------------- */

function nearBottom() {
  return els.chatScroll.scrollHeight - els.chatScroll.scrollTop - els.chatScroll.clientHeight < 120;
}
function scrollDown(force) {
  if (force || nearBottom()) els.chatScroll.scrollTop = els.chatScroll.scrollHeight;
}
function showEmpty(show) {
  els.empty.style.display = show ? 'flex' : 'none';
}
function setStatus(text) {
  if (!text) { els.statusPill.hidden = true; return; }
  els.statusPill.hidden = false;
  els.statusPill.textContent = text;
}

/* ---------------- OFFLINE MESAJ KUYRUĞU (chat) ----------------
   İnternet yokken gönderilen mesajlar main'deki diske yazılan kuyruğa düşer;
   burada ⏳ "kuyrukta" balonu gösterilir. Bağlantı gelince kuyruk otomatik
   boşaltılır ('netQueue flushed') ve balonlar gerçek mesajla değişir. */
let netOnline = true;
let netQueueCount = 0;
const netPending = []; // { key, el } — bekleyen mesaj balonları

/* wifi göstergesi: bağlı = yeşil, kopuk = kırmızı */
function paintNetDot() {
  if (!els.netDot) return;
  els.netDot.classList.toggle('net-on', netOnline);
  els.netDot.classList.toggle('net-off', !netOnline);
  els.netDot.title = _t(netOnline ? 'tip_net_online' : 'tip_net_offline');
}

function setNetBadge(el, text) {
  if (!el || !el.isConnected) return;
  let badge = el.querySelector('.q-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'q-badge';
    el.appendChild(badge);
  }
  badge.textContent = '⏳ ' + text;
}

function updateNetQueueUi() {
  if (busy) return;
  if (!netOnline) {
    setStatus(netQueueCount > 0 ? _ti('net_pill_offline', netQueueCount) : _t('net_pill_online'));
  } else if (!netQueueCount) {
    setStatus('');
  }
}

function onNetEvent(ev) {
  if (ev.type === 'net') {
    const was = netOnline;
    netOnline = ev.online !== false;
    paintNetDot();
    if (was !== netOnline) {
      if (netOnline) {
        toast(_t('net_online'));
        if (!netQueueCount) setStatus('');
      } else {
        toast(_t('net_offline'));
        updateNetQueueUi();
      }
    }
    return;
  }
  if (ev.type === 'netQueue') {
    netQueueCount = typeof ev.count === 'number' ? ev.count : netQueueCount;
    if (ev.queued) {
      if (ev.sessionId === activeId) {
        addUserBubble(ev.text || (ev.attCount ? `[${ev.attCount} ek]` : ''));
        const el = els.msgs.querySelector('.msg-user:last-of-type');
        if (el && ev.key) {
          setNetBadge(el, _t('q_pending'));
          netPending.push({ key: ev.key, el });
        }
      }
    } else if (ev.flushed) {
      /* kuyruk boşaltılıyor: ⏳ balonlarını kaldır — gerçek mesaj echo ile gelir */
      for (const p of netPending) {
        if (p.el && p.el.isConnected) p.el.remove();
      }
      netPending.length = 0;
      toast(_ti('q_flushed', ev.flushed));
    }
    updateNetQueueUi();
  }
}

const TODO_GLYPH = { done: '✓', active: '▸', pending: '○' };

function renderTodos(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) { els.todoPanel.hidden = true; els.todoPanel.innerHTML = ''; return; }
  const done = list.filter((t) => t.status === 'done').length;
  const rows = list
    .map((t) => {
      const st = TODO_GLYPH[t.status] ? t.status : 'pending';
      return `<div class="td-row ${st}"><span class="td-g">${TODO_GLYPH[st]}</span><span class="td-t">${escapeHtml(t.title)}</span></div>`;
    })
    .join('');
  els.todoPanel.innerHTML =
    `<div class="td-head"><span>GÖREVLER</span>` +
    `<span class="td-right"><span class="td-count">${done}/${list.length}</span>` +
    `<button class="td-x" title="${_t('td_hide')}">×</button></span></div>` + rows;
  els.todoPanel.hidden = false;
  /* X yalnız BU listeyi gizler — kalıcı kapanma yok: bir sonraki görev
     güncellemesi (yeni görev eklendi / görev yapıldı) paneli yeniden gösterir */
  const x = els.todoPanel.querySelector('.td-x');
  if (x) x.addEventListener('click', () => { els.todoPanel.hidden = true; });
}
function setBusy(b) {
  busy = b;
  /* gönder artık asla kilitlenmez: meşgulken gönderilenler main'deki
     birleştirme kuyruğuna düşer, iş bitince tek pakette gider */
  els.sendBtn.disabled = false;
  els.stopBtn.hidden = !b;
  if (!b) setStatus('');
}

let toastTimer = null;
let toastHideTimer = null;
function toast(msg) {
  /* akış içi balon: göster → fade-in, süre dolunca fade-out → tamamen gizle (yer kaplamasın) */
  els.toast.textContent = msg;
  els.toast.hidden = false;
  requestAnimationFrame(() => els.toast.classList.add('show'));
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    toastHideTimer = setTimeout(() => { els.toast.hidden = true; }, 260);
  }, 2200);
}

/* ---------------- messages ---------------- */

function addUserBubble(content) {
  showEmpty(false);
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.innerHTML = `<span class="who">Sen</span>`;

  let text = '';
  let nImg = 0;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (p.type === 'text') parts.push(String(p.text || ''));
      else if (p.type === 'image_url') nImg++;
    }
    text = parts.join('\n');
  } else {
    text = String(content);
  }
  div.appendChild(document.createTextNode(text));
  if (nImg) {
    const badge = document.createElement('div');
    badge.style.cssText = 'color:var(--accent);font-size:12px;margin-top:6px';
    badge.textContent = `[${nImg} resim]`;
    div.appendChild(badge);
  }
  els.msgs.appendChild(div);
  scrollDown(true);
}

function ensureStreamBubble() {
  if (streamEl) return streamEl;
  showEmpty(false);
  streamRaw = '';
  const div = document.createElement('div');
  div.className = 'msg msg-assistant';
  div.innerHTML = `<div class="md cursor-blink"></div>`;
  els.msgs.appendChild(div);
  streamEl = div.querySelector('.md');
  scrollDown(true);
  return streamEl;
}

function renderStream() {
  renderQueued = false;
  if (!streamEl) return;
  streamEl.classList.toggle('cursor-blink', !streamEl.dataset.done);
  streamEl.innerHTML = md(streamRaw);
  scrollDown();
}

function finalizeAssistant(content) {
  if (streamEl && content && streamRaw === content) {
    streamEl.dataset.done = '1';
    streamEl.classList.remove('cursor-blink');
    streamEl = null;
    return;
  }
  if (streamEl) {
    streamEl.dataset.done = '1';
    streamEl.classList.remove('cursor-blink');
    streamEl.innerHTML = md(content != null ? content : streamRaw);
    streamEl = null;
    scrollDown();
    return;
  }
  showEmpty(false);
  const div = document.createElement('div');
  div.className = 'msg msg-assistant';
  div.innerHTML = `<div class="md"></div>`;
  div.querySelector('.md').innerHTML = md(content || '');
  els.msgs.appendChild(div);
  scrollDown();
}

function addErrorBubble(text) {
  streamEl = null;
  showEmpty(false);
  const div = document.createElement('div');
  div.className = 'msg msg-error';
  div.textContent = 'Hata: ' + text;
  els.msgs.appendChild(div);
  scrollDown(true);
}

/* ajan durduruldu/iptal edildi — SEBEP zorunlu, sohbete sönük not olarak düşer */
function addStopNote(reason) {
  streamEl = null;
  showEmpty(false);
  const div = document.createElement('div');
  div.className = 'msg msg-sys';
  div.textContent = '\u23F9 Durduruldu — sebep: ' + String(reason || 'sebep belirtilmedi');
  els.msgs.appendChild(div);
  scrollDown(true);
}

/* ---------------- tool cards ---------------- */
/* Ard arda gelen araç kartları TEK kutuda toplanır (.tool-box): çalışırken
   lacivert outline döner, gövde max 420px scroll'lu. Grup; tool_calls İÇEREN
   iş turlarında açık kalır, saf metin cevapta (normal mesaj) kapanır. */
let chatToolGroup = null; /* { box, body } */

function closeChatToolGroup() {
  if (chatToolGroup) chatToolGroup.box.classList.remove('running');
  chatToolGroup = null;
}

function argSummary(name, args) {
  try {
    if (name === 'run_command') return String(args.command || '');
    if (name === 'read_file' || name === 'write_file') return String(args.path || '');
    if (name === 'list_dir') return String(args.path || '.');
    if (name === 'memory_write' || name === 'user_write') return String(args.text || '').slice(0, 80);
    return JSON.stringify(args).slice(0, 100);
  } catch {
    return '';
  }
}

function addToolCard(callId, name, args) {
  streamEl = null;
  showEmpty(false);
  /* grup yoksa / DOM temizlenmişse yeni kutu aç */
  if (!chatToolGroup || !els.msgs.contains(chatToolGroup.box)) {
    const box = document.createElement('div');
    box.className = 'tool-box running';
    const body = document.createElement('div');
    body.className = 'tool-boxbody';
    box.appendChild(body);
    els.msgs.appendChild(box);
    chatToolGroup = { box, body };
  } else {
    chatToolGroup.box.classList.add('running');
  }
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.callId = callId || '';
  card.innerHTML =
    `<div class="tool-head">` +
    `<span class="tool-icon">&#x2692;&#xFE0E;</span>` +
    `<span class="tool-name">${escapeHtml(name)}</span>` +
    `<span class="tool-arg">${escapeHtml(argSummary(name, args))}</span>` +
    `<span class="tool-state run">çalışıyor…</span></div>` +
    `<div class="tool-body"></div>`;
  card.querySelector('.tool-head').addEventListener('click', () => {
    card.querySelector('.tool-body').classList.toggle('open');
  });
  chatToolGroup.body.appendChild(card);
  chatToolGroup.body.scrollTop = chatToolGroup.body.scrollHeight;
  scrollDown(true);
  return card;
}

function finishToolCard(callId, ok, result) {
  const sel = callId
    ? `.tool-card[data-call-id="${CSS.escape(callId)}"]`
    : null;
  const card = (sel && els.msgs.querySelector(sel)) || els.msgs.querySelector('.tool-card:last-of-type');
  if (!card) return;
  const st = card.querySelector('.tool-state');
  st.classList.remove('run');
  st.classList.add(ok ? 'ok' : 'err');
  st.textContent = ok ? 'tamam' : 'hata';
  const body = card.querySelector('.tool-body');
  body.textContent = String(result || '(çıktı yok)').slice(0, 4000);
  if (String(result || '').length <= 300) body.classList.add('open');
  /* ring burada söndürülmez — iş bitene kadar (closeChatToolGroup) döner */
  if (chatToolGroup && chatToolGroup.body.contains(card)) {
    chatToolGroup.body.scrollTop = chatToolGroup.body.scrollHeight;
  }
}

/* ---------------- sessions sidebar ---------------- */

/* sol panel sohbet listesi: kullanıcı ELLE sıralayabilir (sürükle-bırak).
   sessionOrder: session id'lerinin tercih sırası — settings.json'da kalıcı.
   Listede olmayan oturumlar engine sırasıyla (son mesaja göre) arkada gelir. */
let sessionOrder = [];
let sessionOrderLoaded = null;
function loadSessionOrder() {
  if (!sessionOrderLoaded) {
    sessionOrderLoaded = beast
      .sessionsOrderGet()
      .then((r) => { sessionOrder = (r && Array.isArray(r.order) ? r.order : []).map(String); })
      .catch(() => {});
  }
  return sessionOrderLoaded;
}

function reorderSessions(dragId, targetId) {
  const idx = (id) => sessionOrder.indexOf(id);
  const dp = idx(dragId);
  const tp = idx(targetId);
  sessionOrder = sessionOrder.filter((x) => x !== dragId);
  const ti = sessionOrder.indexOf(targetId);
  if (ti === -1) {
    /* hedef hiç elle sıralanmamış: listeden görünür konumunu korumak mümkün değil — sona ekle */
    sessionOrder.push(targetId, dragId);
  } else if (dp !== -1 && dp < tp) {
    sessionOrder.splice(ti + 1, 0, dragId); /* aşağı sürüklendi → hedefin ALTINA */
  } else {
    sessionOrder.splice(ti, 0, dragId); /* yukarı sürüklendi → hedefin ÜSTÜNE */
  }
  beast.sessionsOrderSet(sessionOrder).catch(() => {});
  refreshSessions();
}

async function renderSessions(list) {
  await loadSessionOrder();
  let waSet = new Set();
  let tgSet = new Set();
  try {
    waSet = new Set(await beast.waListSessions());
  } catch {}
  try {
    tgSet = new Set(await beast.tgListSessions());
  } catch {}
  els.sessList.innerHTML = '';
  /* elle sıra: sessionOrder'daki id'ler önde (o sırayla), diğerleri engine sırasıyla arkada */
  const rank = new Map(sessionOrder.map((id, i) => [id, i]));
  const withRank = list.map((s, i) => ({ s, r: rank.has(s.id) ? rank.get(s.id) : 1e6 + i }));
  withRank.sort((a, b) => a.r - b.r);
  /* aktif botun oturumları — botlar arası geçişte liste de o bota göre değişir.
     KATI KURAL: her oturum yalnız BAĞLI OLDUĞU botun listesinde görünür;
     bot kaydı olmayan (eski) oturumlar Beast (varsayılan sahip) altında görünür. */
  for (const { s } of withRank) {
    if ((s.botId || 'beast') !== activeBotId) continue;
    const row = document.createElement('div');
    row.className = 'sess' + (s.id === activeId ? ' active' : '');
    row.title = _t('sess_drag');
    row.draggable = true;
    row.innerHTML =
      (waSet.has(s.id) ? '<span class="sess-wa" title="WhatsApp">W</span>' : '') +
      (tgSet.has(s.id) ? '<span class="sess-tg" title="Telegram">T</span>' : '') +
      `<span class="sess-title">${escapeHtml(s.title || 'Yeni Sohbet')}</span>` +
      `<span class="sess-code" title="Oturum kodu">${escapeHtml(s.code || '')}</span>` +
      `<button class="sess-del" title="Sil">×</button>`;
    row.addEventListener('click', () => openSession(s.id));
    row.querySelector('.sess-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await beast.deleteSession(s.id);
      if (s.id === activeId) {
        activeId = null;
        els.msgs.innerHTML = '';
        showEmpty(true);
        const created = await beast.createSession();
        await openSession(created.id);
      }
      sessionOrder = sessionOrder.filter((x) => x !== s.id);
      refreshSessions();
    });
    /* sürükle-bırak: yukarı/aşağı yer değiştirme */
    row.addEventListener('dragstart', (e) => {
      dragSid = s.id;
      row.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', s.id); } catch {}
    });
    row.addEventListener('dragend', () => {
      dragSid = null;
      row.classList.remove('dragging');
      els.sessList.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', (e) => {
      if (!dragSid || dragSid === s.id) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch {}
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (!dragSid || dragSid === s.id) return;
      reorderSessions(dragSid, s.id);
      dragSid = null;
    });
    els.sessList.appendChild(row);
  }
}

let dragSid = null;

async function refreshSessions() {
  await renderSessions(await beast.listSessions());
  renderBotCards(); // bot kartlarındaki numara/sayı etiketleri de tazelensin
}

async function openSession(id) {
  activeId = id;
  streamEl = null;
  const s = await beast.openSession(id);
  els.msgs.innerHTML = '';
  showEmpty(s.messages.length === 0);
  renderTodos(s.todos || []);

  for (let i = 0; i < s.messages.length; i++) {
    const m = s.messages[i];
    if (m.role === 'user') addUserBubble(m.content);
    else if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          addToolCard(tc.id, tc.function.name, args);
          const out = s.messages[i + 1];
          if (out && out.role === 'tool' && out.tool_call_id === tc.id) {
            finishToolCard(tc.id, true, out.content);
            i++;
          } else {
            finishToolCard(tc.id, false, '(sonuç yok)');
          }
        }
      }
      if (m.content) finalizeAssistant(m.content);
    }
  }
  refreshSessions();
  scrollDown(true);
  els.input.focus();
}

/* ---------------- attachments ---------------- */

const TEXT_EXT = /\.(txt|md|json|csv|log|js|ts|py|ps1|bat|cmd|html|css|yaml|yml|xml|ini)$/i;

function renderChips() {
  els.chips.innerHTML = '';
  els.chips.hidden = pending.length === 0;
  pending.forEach((a, i) => {
    const c = document.createElement('span');
    c.className = 'chip';
    const label = a.type === 'image' ? `\u25A3 ${a.name}` : `\u2261 ${a.name}`;
    c.appendChild(document.createTextNode(label));
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('click', () => {
      pending.splice(i, 1);
      renderChips();
    });
    c.appendChild(x);
    els.chips.appendChild(c);
  });
}

function addFiles(files) {
  for (const f of files) {
    if (f.size > 8 * 1024 * 1024) { toast('Çok büyük (max 8MB): ' + f.name); continue; }
    if (f.type.startsWith('image/')) {
      const r = new FileReader();
      r.onload = () => {
        if (pending.length >= 6) { toast('En fazla 6 ek'); return; }
        pending.push({ type: 'image', name: f.name, dataUrl: String(r.result) });
        renderChips();
      };
      r.readAsDataURL(f);
    } else if (TEXT_EXT.test(f.name)) {
      f.text().then((t) => {
        if (pending.length >= 6) { toast('En fazla 6 ek'); return; }
        pending.push({ type: 'file', name: f.name, content: t.slice(0, 200000) });
        renderChips();
      });
    } else {
      toast('Desteklenmeyen tür: ' + f.name);
    }
  }
}

/* ---------------- settings ---------------- */

let setTab = 'provider';

async function openSettings() {
  els.settingsOverlay.hidden = false;
  try {
    const s = await beast.getSettings();
    if (els.beastCode) els.beastCode.textContent = s.beastCode || '—';
  } catch {}
  await renderProviderPane();
  renderSkillsPane();
  renderTtsPane();
  renderEmailPane();
  renderIntegrationsPane();
  switchTab(setTab);
}

function closeSettings() {
  els.settingsOverlay.hidden = true;
}

/* Dil değişince ayarlar sekmesi içeriği de güncellenir */
async function renderActiveSettingsTab() {
  if (els.settingsOverlay.hidden) return;
  switch (setTab) {
    case 'provider': await renderProviderPane(); break;
    case 'fallout': await refreshFalloutPane(); break;
    case 'skills': await renderSkillsPane(); break;
    case 'tts': await renderTtsPane(); break;
    case 'email': await renderEmailPane(); break;
    case 'integrations': await renderIntegrationsPane(); break;
    case 'websearch': await renderWebSearchPane(); break;
    case 'events': await renderEventsPane(); break;
    case 'cron': await openCron(); break;
    case 'usage': await renderUsagePane(); break;
    case 'agents': await refreshAgentsPane(); break;
    case 'logs': await renderLogPane(); break;
    case 'dash': await renderDashboardPane(); break;
    case 'limits': await renderLimitsPane(); break;
    case 'sec': await renderSecurityPane(); break;
    case 'update': await renderUpdatePane(); break;
  }
}

function switchTab(name) {
  setTab = name;
  document.querySelectorAll('#setTabs .tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === name)
  );
  for (const p of ['provider', 'fallout', 'skills', 'agents', 'tts', 'email', 'integrations', 'websearch', 'events', 'cron', 'usage', 'logs', 'dash', 'limits', 'sec', 'update']) {
    const el = $('#tab-' + p);
    if (el) el.hidden = p !== name; // guard: eksik pane tüm sekmeleri kilitlemesin
  }
  if (name === 'cron') openCron();
  if (name === 'usage') renderUsagePane();
  if (name === 'events') renderEventsPane();
  if (name === 'logs') renderLogPane();
  if (name === 'dash') renderDashboardPane();
  if (name === 'limits') renderLimitsPane();
  if (name === 'sec') renderSecurityPane();
  if (name === 'update') renderUpdatePane(true);
  if (name === 'agents') refreshAgentsPane();
  if (name === 'websearch') renderWebSearchPane();
  /* Fallout: her açılışta güncel provider zincirini çek */
  if (name === 'fallout') refreshFalloutPane();
}

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

async function renderUsagePane() {
  const pane = $('#tab-usage');
  if (!pane) return;
  let rep;
  try {
    rep = await beast.getUsage();
  } catch {
    rep = { today: { total: {}, models: [] }, month: { total: {}, models: [] } };
  }
  const wwi = await beast.whereWasIGet().catch(() => ({ enabled: true }));
  const t = rep.today.total || {};
  const mo = rep.month.total || {};
  const card = (label, v) =>
    `<div class="usage-stat"><div class="us-label">${label}</div><div class="us-value">${v}</div></div>`;
  const rows = (models) =>
    models && models.length
      ? models
          .map(
            (m) =>
              `<div class="usage-row"><span class="ur-model">${escapeHtml(m.model)}</span>` +
               `<span class="ur-meta">${m.calls} ${_t('ws_calls')} · ${fmtTokens(m.pin)}/${fmtTokens(m.pout)} ${_t('ws_token')}</span>` +
              `<span class="ur-cost">${m.cost ? '$' + Number(m.cost).toFixed(4) : ''}</span></div>`
          )
          .join('')
      : '<div class="usage-empty">' + _t('us_no_records') + '</div>';
  pane.innerHTML =
    '<h2>' + _t('us_h2') + '</h2>' +
    '<div class="sub">' + _t('us_sub') + '</div>' +
    '<div class="usage-cards">' +
    card(_t('us_today_calls'), String(t.calls || 0)) +
    card(_t('us_today_tokens'), `${fmtTokens(t.pin || 0)} / ${fmtTokens(t.pout || 0)}`) +
    card(_t('us_today_cost'), t.cost ? '~$' + Number(t.cost).toFixed(4) : '—') +
    card(_t('us_month_cost'), mo.cost ? '~$' + Number(mo.cost).toFixed(4) : '—') +
    '</div>' +
    `<h3>${_t('us_models_today')}</h3>${rows(rep.today.models)}` +
    (rep.month.models && rep.month.models.length
      ? `<h3>${_t('us_models_month')}</h3>${rows(rep.month.models)}`
      : '') +
    '<button id="usReset" class="btn ghost" style="margin-top:14px">' + _t('us_reset') + '</button>' +
    '<div class="divider"></div><h2>' + _t('us_backup_h2') + '</h2>' +
    '<div class="sub">' + _t('us_backup_sub') + '</div>' +
    '<div class="form-grid" style="grid-template-columns:auto auto;gap:8px;margin-top:8px">' +
    '<button id="bkNow" class="btn ghost">' + _t('us_backup_now') + '</button>' +
    '<button id="bkRestore" class="btn ghost">' + _t('us_backup_restore') + '</button>' +
    '</div>' +
    '<div class="divider"></div><h2>' + _t('us_where_h2') + '</h2>' +
    '<div class="sub">' + _t('us_where_sub') + '</div>' +
    `<label class="lock-row" style="margin-top:6px"><input type="checkbox" id="wwiOn" ${wwi.enabled ? 'checked' : ''}/><span>${_t('us_where_on')}</span></label>`;
  $('#usReset').addEventListener('click', async () => {
    await beast.resetUsage();
    renderUsagePane();
    toast(_t('us_reset_toast'));
  });
  $('#bkNow').addEventListener('click', async () => {
    toast(_t('us_backup_ing'));
    const r = await beast.createBackup();
    toast(r.ok ? _t('us_backup_ok') + ' (' + (r.code || '') + ')' : _t('us_backup_err') + (r.error || '?'));
  });
  $('#bkRestore').addEventListener('click', async () => {
    toast(_t('us_restore_ing'));
    const r = await beast.restoreBackup().catch(() => ({ ok: false, error: 'ipc' }));
    if (r && r.ok) {
      toast(_t('us_restore_ok'));
    } else if (r && !r.canceled) {
      toast(_t('us_backup_err') + (r.error || '?'));
    }
  });
  $('#wwiOn').addEventListener('change', async (e) => {
    await beast.whereWasISet({ enabled: e.target.checked });
    toast(e.target.checked ? _t('us_where_on_toast') : _t('us_where_off_toast'));
  });
}

async function refreshFalloutPane() {
  try { state = await beast.getState(); } catch {}
  renderFalloutPane();
}

/* Obscura kurulum ilerlemesi: main process'te sürer — ayarlardan çıkılsa da
   kesilmez. Panel açıksa çubuk canlı güncellenir; bitişte tek kez toast atılır. */
let _obscuraWasRunning = false;
function paintObscuraState(st) {
  const ocSt = $('#ocStatus');
  const ocProg = $('#ocProg');
  const ocBtn = $('#ocInstall');
  if (!ocSt || !ocProg || !ocBtn || !st || !st.phase) return;
  const pct = Math.max(0, Math.min(100, Number(st.pct) || 0));
  const fill = ocProg.querySelector('.oc-prog-fill');
  const txt = ocProg.querySelector('.oc-prog-text');
  if (st.running) {
    ocBtn.disabled = true;
    ocBtn.textContent = _t('oc_install_running');
    ocProg.hidden = false;
    if (fill) fill.style.width = pct + '%';
    const phaseKey = ({ 'hazırlanıyor': 'prep', 'indiriliyor': 'download', 'kuruluyor': 'extract', 'doğrulanıyor': 'verify' })[st.phase];
    if (txt) txt.textContent = (phaseKey ? _t('oc_phase_' + phaseKey) : st.phase) + ' — ' + pct + '%';
    ocSt.textContent = _t('oc_bg_note');
  } else if (st.phase === 'tamamlandı' && pct >= 100) {
    ocBtn.disabled = false;
    ocBtn.textContent = _t('oc_install');
    ocProg.hidden = false;
    if (fill) fill.style.width = '100%';
    if (txt) txt.textContent = _t('oc_phase_done') + ' — 100%';
    ocSt.textContent = _t('oc_status_ok');
  } else if (st.phase === 'hata') {
    ocBtn.disabled = false;
    ocBtn.textContent = _t('oc_install');
    ocProg.hidden = true;
    ocSt.textContent = _t('oc_install_fail') + (st.error || '?');
  }
}

function onObscuraProgress(ev) {
  if (ev && ev.running) _obscuraWasRunning = true;
  paintObscuraState(ev);
  if (ev && !ev.running && _obscuraWasRunning) {
    _obscuraWasRunning = false;
    if (ev.phase === 'tamamlandı') toast(_t('oc_installed_toast'));
    else if (ev.phase === 'hata') toast(_t('oc_install_fail') + (ev.error || '?'));
  }
}

/* Web Arama sekmesi: TinyFish anahtarı + Obscura (kurulum/aktiflik) + arama sırası */
async function renderWebSearchPane() {
  const pane = $('#tab-websearch');
  if (!pane) return;
  const tf = await beast.tinyfishGet().catch(() => ({ set: false, masked: '' }));
  pane.innerHTML =
    '<h2>' + _t('ws_h2') + '</h2>' +
    '<div class="sub">' + _t('ws_sub') + '</div>' +
    /* --- Obscura --- */
    '<div class="divider"></div>' +
    '<h2>' + _t('oc_h2') + '</h2>' +
    '<div class="sub">' + _t('oc_sub') + '</div>' +
    '<div id="ocStatus" class="sub" style="text-align:left;margin-top:8px"></div>' +
    '<label class="mem-label" style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
    '<input id="ocEnabled" type="checkbox" style="width:auto" /> <span>' + _t('oc_enabled') + '</span></label>' +
    '<div id="ocProg" class="oc-prog" hidden>' +
    '<div class="oc-prog-bar"><div class="oc-prog-fill" style="width:0%"></div></div>' +
    '<div class="oc-prog-text sub"></div></div>' +
    '<div style="display:flex;justify-content:center;margin-top:12px">' +
    '<button id="ocInstall" class="btn">' + _t('oc_install') + '</button></div>' +
    /* --- Arama sırası --- */
    '<div class="divider"></div>' +
    '<h2>' + _t('so_h2') + '</h2>' +
    '<div class="sub">' + _t('so_sub') + '</div>' +
    '<div id="soList" style="margin-top:10px"></div>' +
    /* --- TinyFish --- */
    '<div class="divider"></div>' +
    '<h2>' + _t('tf_h2') + '</h2>' +
    '<div class="sub">' + _t('tf_sub') + '</div>' +
    '<div id="tfStatus" class="sub" style="text-align:left;margin-top:8px"></div>' +
    '<label class="mem-label">' + _t('tf_key_label') + '</label>' +
    '<input id="tfKeyInp" class="inp" type="password" placeholder="tf_..." autocomplete="new-password" spellcheck="false" />' +
    '<div class="form-grid" style="grid-template-columns:auto auto;gap:8px;margin-top:8px">' +
    '<button id="tfSave" class="btn">' + _t('ws_save') + '</button>' +
    '<button id="tfClear" class="btn ghost">' + _t('ws_clear') + '</button></div>';

  /* --- Obscura durumu --- */
  const ocSt = $('#ocStatus');
  const ocChk = $('#ocEnabled');
  const ocBtn = $('#ocInstall');
  const oc = await beast.obscuraGet().catch(() => ({ installed: false, enabled: true, dir: '', install: null }));
  ocChk.checked = oc.enabled !== false;
  /* kurulum arka planda sürüyorsa durum panelde GERİ YÜKLENİR —
     ayarlardan çıkıp dönsen bile ilerleme kaybolmaz */
  const ocState = oc.install || (await beast.obscuraInstallState().catch(() => null));
  paintObscuraState(ocState);
  ocChk.addEventListener('change', async () => {
    await beast.obscuraSetEnabled(ocChk.checked).catch(() => {});
    toast(ocChk.checked ? _t('oc_on_toast') : _t('oc_off_toast'));
  });
  ocBtn.addEventListener('click', async () => {
    if (ocBtn.disabled) return;
    const r = await beast.obscuraInstall().catch(() => ({ ok: false, error: 'hata' }));
    if (r && (r.ok || r.started || r.busy)) paintObscuraState(await beast.obscuraInstallState().catch(() => null));
    else toast(_t('oc_install_fail') + ((r && r.error) || '?'));
  });

  /* --- Arama sırası --- */
  const soBox = $('#soList');
  let rows = [];
  const soRes = await beast.searchOrderGet().catch(() => ({ chain: [] }));
  rows = (soRes && Array.isArray(soRes.chain) && soRes.chain.length) ? soRes.chain.map((x) => ({ id: x.id, on: x.on !== false })) : [];
  const engName = (id) => _t('so_engine_' + id) || id;
  function renderRows() {
    soBox.innerHTML = '';
    rows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'so-row' + (row.on ? '' : ' off');
      el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px';
      el.innerHTML =
        '<span class="so-idx" style="min-width:18px;color:var(--muted);font-size:12px">' + (i + 1) + '.</span>' +
        '<input type="checkbox" class="so-chk" style="width:auto" ' + (row.on ? 'checked' : '') + ' />' +
        '<span style="flex:1">' + escapeHtml(engName(row.id)) + '</span>' +
        '<button class="so-up" title="Yukarı" style="width:auto;padding:2px 8px">↑</button>' +
        '<button class="so-down" title="Aşağı" style="width:auto;padding:2px 8px">↓</button>';
      el.querySelector('.so-chk').addEventListener('change', async (e) => {
        row.on = e.target.checked;
        el.classList.toggle('off', !row.on);
        await saveOrder();
      });
      el.querySelector('.so-up').addEventListener('click', async () => {
        if (i === 0) return;
        [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
        renderRows();
        await saveOrder();
      });
      el.querySelector('.so-down').addEventListener('click', async () => {
        if (i >= rows.length - 1) return;
        [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]];
        renderRows();
        await saveOrder();
      });
      soBox.appendChild(el);
    });
  }
  async function saveOrder() {
    const r = await beast.searchOrderSet(rows).catch(() => null);
    if (r && r.ok) toast(_t('so_saved_toast'));
    else toast(_t('ws_fail_toast'));
  }
  if (rows.length) renderRows();

  /* --- TinyFish --- */
  const tfSt = $('#tfStatus');
  const setTfSt = (r) => {
    tfSt.textContent = r.set ? _t('tf_status_set') + r.masked : _t('tf_status_unset');
  };
  setTfSt(tf);
  $('#tfSave').addEventListener('click', async () => {
    const v = $('#tfKeyInp').value.trim();
    if (!v) { toast(_t('tf_empty_toast')); return; }
    const rr = await beast.tinyfishSet(v).catch(() => null);
    $('#tfKeyInp').value = '';
    if (rr && rr.set) {
      setTfSt(rr);
      toast(_t('tf_saved_toast'));
    } else {
      toast(_t('ws_fail_toast'));
    }
  });
  $('#tfClear').addEventListener('click', async () => {
    await beast.tinyfishClear().catch(() => {});
    $('#tfKeyInp').value = '';
    setTfSt({ set: false, masked: '' });
    toast(_t('tf_cleared_toast'));
  });
}

async function renderProviderPane() {
  const pane = $('#tab-provider');
  pane.innerHTML =
    '<h2>' + _t('p_h2') + '</h2><div class="sub">' + _t('p_sub') + '</div>';

  for (const m of state.models || []) {
    const row = document.createElement('div');
    row.className = 'prov-row' + (effectiveModelSel() === m.sel ? ' active' : '');
    row.innerHTML =
      `<span class="prov-name">${escapeHtml(m.providerName)}</span>` +
      `<span class="prov-model">${escapeHtml(m.model)}</span>` +
      `<span class="check">✓</span>` +
      `<button class="prov-del" title="${_t('p_del_title')}">✕</button>`;
    row.addEventListener('click', async () => {
      state = await beast.setModel(m.sel);
      await refreshBots().catch(() => {});
      applyState();
      renderProviderPane();
      toast(_t('p_model_toast') + m.providerName + ' · ' + m.model);
    });
    row.querySelector('.prov-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      state = await beast.deleteModel(m.sel);
      applyState();
      renderProviderPane();
      toast(_t('p_del_toast') + m.model + ' — alttan geri getirebilirsin');
    });
    pane.appendChild(row);
  }
  if (!state.models || !state.models.length) {
    pane.insertAdjacentHTML(
      'beforeend',
      '<p class="sub">' + _t('p_no_model') + '</p>'
    );
  }

  /* --- silinen modeller --- */
  const deleted = state.deletedModels || [];
  if (deleted.length) {
    pane.insertAdjacentHTML('beforeend', '<div class="divider"></div>');
    pane.insertAdjacentHTML(
      'beforeend',
      `<h2>${_t('p_deleted_h2')}</h2><div class="sub">${_ti('p_deleted_sub', deleted.length)}</div>`
    );
    for (const sel of deleted) {
      const [, modelName] = String(sel).split('::');
      const row = document.createElement('div');
      row.className = 'prov-row';
      row.innerHTML =
        `<span class="prov-model" style="opacity:.7">${escapeHtml(modelName || sel)}</span>` +
        `<button class="btn ghost" style="padding:2px 10px;font-size:12px">${_t('p_restore')}</button>`;
      row.querySelector('button').addEventListener('click', async () => {
        state = await beast.restoreModel(sel);
        applyState();
        renderProviderPane();
        toast(_t('p_restore_toast') + (modelName || sel));
      });
      pane.appendChild(row);
    }
  }

  /* --- özel rol modelleri (multimodel) --- */
  const allModels = state.models || [];
  const roles = ['vision', 'terminal', 'coding', 'subagent'];
  const roleList = [
    { key: 'vision', label: 'Vision', desc: 'Görsel/karşılaştırma' },
    { key: 'terminal', label: 'Terminal', desc: 'Komut/work shell' },
    { key: 'coding', label: 'Coding', desc: 'Kod yazma' },
    { key: 'subagent', label: 'Subagent', desc: 'Alt-agent' },
  ];
  const roleMap = state.roleModels || {};

  pane.insertAdjacentHTML('beforeend', '<div class="divider"></div>');
  pane.insertAdjacentHTML(
    'beforeend',
    '<h2>' + _t('p_role_h2') + '</h2><div class="sub">' + _t('p_role_sub') + '</div>'
  );

  for (const r of roleList) {
    const row = document.createElement('div');
    row.className = 'role-row';
    row.innerHTML =
      `<label class="role-label" for="role-${r.key}" title="${r.desc}">${r.label}</label>` +
      `<select id="role-${r.key}" class="role-select"></select>`;
    const sel = row.querySelector('select');
    sel.innerHTML = '';
    const mainOpt = document.createElement('option');
    mainOpt.value = '';
    mainOpt.textContent = _t('p_role_main');
    sel.appendChild(mainOpt);
    for (const m of allModels) {
      const opt = document.createElement('option');
      opt.value = m.sel;
      opt.textContent = `${m.providerName} · ${m.model}`;
      if (roleMap[r.key] === m.sel) {
        opt.selected = true;
      }
      sel.appendChild(opt);
    }
    sel.addEventListener('change', async () => {
      const val = sel.value || null;
      const map = {};
      for (const rr of roleList) map[rr.key] = null;
      if (val) {
        const [p, model] = val.split('::');
        map[r.key] = { providerId: p, model };
      }
      state = await beast.setRoleModels(map);
      applyState();
      renderProviderPane();
      toast(`${r.label}: ${val ? `${val.split('::')[1]} kullanılacak` : 'ana model'}  — kaydedildi`);
    });
    pane.appendChild(row);
  }

  /* --- özel providerlar --- */
  const settings = await beast.getSettings();
  const customs = settings.customProviders || [];
  let presets = [];
  try { presets = (await beast.builtinProviders()) || []; } catch {}

  pane.insertAdjacentHTML('beforeend', '<div class="divider"></div>');
  pane.insertAdjacentHTML(
    'beforeend',
    '<h2>' + _t('p_custom_h2') + '</h2><div class="sub">' + _t('p_custom_sub') + '</div>'
  );

  for (const p of customs) {
    const row = document.createElement('div');
    row.className = 'skill-row';
    row.innerHTML =
      `<span class="skill-name">${escapeHtml(p.name || 'Custom')}</span>` +
      ` <button class="prov-del" title="${_t('p_custom_del')}">✕</button>` +
      `<div class="prov-url">${escapeHtml(p.baseUrl)} · ${(p.models || []).length} model</div>`;
    row.querySelector('.prov-del').addEventListener('click', async () => {
      state = await beast.setCustomProviders(customs.filter((x) => x.id !== p.id));
      applyState();
      renderProviderPane();
      toast(_t('p_prov_del_toast'));
    });
    pane.appendChild(row);
  }

  const form = document.createElement('div');
  form.innerHTML =
    /* TEK TİKLA MODEL (OpenCode Zen Free) */
    `<div class="zen-hero">` +
    `<button id="zenOneClick" class="btn"><span class="zen-load" hidden></span><span class="zen-label">⚡ ${_t('p_zen_btn')}</span></button>` +
    `<div class="sub" style="margin-top:6px">${_t('p_zen_hint')}</div>` +
    `</div>` +
    `<label class="mem-label">${_t('p_preset')}</label>` +
    `<select id="cpPreset" class="inp">` +
    `<option value="-1">${_t('p_preset_custom')}</option>` +
    presets.map((p, i) => `<option value="${i}">${escapeHtml(p.name)}</option>`).join('') +
    `</select>` +
    `<div id="cpPresetHint" class="sub" style="margin-top:4px">${_t('p_preset_hint')}</div>` +
    `<label class="mem-label" style="margin-top:8px">${_t('p_name_opt')}</label><input id="cpName" class="inp" placeholder="Örn: OrcaRouter">` +
    `<div class="form-grid">` +
    `<div><label class="mem-label">${_t('p_api_url')}</label><input id="cpUrl" class="inp" placeholder="https://api.ornek.com/v1"></div>` +
    `<div><label class="mem-label">${_t('p_api_key')}</label><input id="cpKey" class="inp" type="password" placeholder="sk-..."></div>` +
    `</div>` +
    `<button id="cpFetch" class="btn ghost">${_t('p_fetch')}</button>` +
    `<div id="cpPicks" class="model-picks" hidden></div>` +
    `<div id="cpManualWrap" hidden>` +
    `<label class="mem-label">${_t('p_models_manual')}</label>` +
    `<textarea id="cpManual" class="mem-area" rows="4" placeholder="model-adi-1&#10;model-adi-2"></textarea>` +
    `</div>` +
    `<button id="cpSave" class="btn" hidden>${_t('p_save')}</button>`;
  pane.appendChild(form);

  let discovered = [];
  let presetSel = -1;

  /* Hazır sağlayıcı seçilince URL otomatik dolar (endpoint bilmeye gerek yok) */
  const syncPreset = () => {
    presetSel = Number($('#cpPreset').value);
    const urlInp = $('#cpUrl');
    const hint = $('#cpPresetHint');
    if (presetSel >= 0 && presets[presetSel]) {
      const p = presets[presetSel];
      urlInp.value = p.baseUrl;
      urlInp.readOnly = true;
      urlInp.style.opacity = '0.75';
      $('#cpName').placeholder = p.name;
      hint.textContent = p.hint ? `${p.name} — ${p.hint} · sadece API key gir, modelleri çek` : `${p.name} — sadece API key gir, modelleri çek`;
    } else {
      urlInp.readOnly = false;
      urlInp.style.opacity = '';
      $('#cpName').placeholder = 'Örn: OrcaRouter';
      hint.textContent = _t('p_preset_hint');
    }
  };
  $('#cpPreset').addEventListener('change', syncPreset);

  /* TEK TİKLA MODEL: OpenCode Zen free kurulumu */
  $('#zenOneClick').addEventListener('click', async () => {
    const btn = $('#zenOneClick');
    const label = btn.querySelector('.zen-label');
    const spinner = btn.querySelector('.zen-load');
    const old = label.textContent;
    btn.disabled = true;
    btn.classList.add('loading');
    spinner.hidden = false;
    label.textContent = _t('p_zen_busy');
    let r;
    try { r = await beast.zenOneClick(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    btn.disabled = false;
    btn.classList.remove('loading');
    spinner.hidden = true;
    label.textContent = old;
    if (r && r.ok) {
      let msg = _ti('p_zen_ok', (r.models || []).length) + ' (OpenCode Zen)';
      if (r.failed && r.failed.length) msg += ' — ' + _ti('p_zen_skipped', r.failed.length);
      toast(msg);
      state = await beast.getState();
      applyState();
      renderProviderPane();
    } else {
      toast(_t('p_zen_fail') + (r && r.error ? ' — ' + r.error : ''));
    }
  });

  const collectedModels = () => {
    const picked = [...document.querySelectorAll('#cpPicks input:checked')].map((c) => c.value);
    if (picked.length) return picked;
    return ($('#cpManual').value || '')
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  };

  $('#cpFetch').addEventListener('click', async () => {
    const baseUrl = $('#cpUrl').value.trim();
    if (!/^https?:\/\//i.test(baseUrl)) { toast('Geçerli API adresi gir'); return; }
    const btn = $('#cpFetch');
    btn.disabled = true;
    btn.textContent = _t('p_fetching');
    let res;
    try {
      res = await beast.fetchModels({ baseUrl, key: $('#cpKey').value.trim() });
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }
    btn.disabled = false;
    btn.textContent = _t('p_fetch');
    discovered = res.ok ? res.models : [];
    const picks = $('#cpPicks');
    if (discovered.length) {
      $('#cpManualWrap').hidden = true;
      picks.hidden = false;
      picks.innerHTML = discovered
        .map((m) => `<label><input type="checkbox" value="${escapeHtml(m)}" checked> ${escapeHtml(m)}</label>`)
        .join('');
      $('#cpSave').hidden = false;
      toast(discovered.length + ' model bulundu');
    } else {
      picks.hidden = true;
      picks.innerHTML = '';
      $('#cpManualWrap').hidden = false;
      $('#cpSave').hidden = false;
      toast('Model çekilemedi (' + (res.error || 'boş') + ') — elle girebilirsin');
    }
  });

  $('#cpSave').addEventListener('click', async () => {
    const models = [...new Set(collectedModels())];
    const url = $('#cpUrl').value.trim();
    if (!/^https?:\/\//i.test(url)) { toast('Geçerli API adresi gir'); return; }
    if (!models.length) { toast('En az bir model gir ya da seç'); return; }
    const preset = presetSel >= 0 ? presets[presetSel] : null;
    let name = $('#cpName').value.trim();
    if (!name) {
      try { name = preset ? preset.name : new URL(url).hostname; } catch { name = preset ? 'Preset' : 'Custom'; }
    }
    /* hazır sağlayıcıda sabit id — tekrar kaydetmek üzerine yazar (kopya yok) */
    const entry = {
      id: preset ? 'preset-' + preset.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      baseUrl: url,
      key: $('#cpKey').value.trim(),
      models,
    };
    const existingIdx = customs.findIndex((x) => x.id === entry.id);
    const next = existingIdx >= 0 ? customs.map((x, i) => (i === existingIdx ? entry : x)) : [...customs, entry];
    state = await beast.setCustomProviders(next);
    applyState();
    renderProviderPane();
    toast(entry.name + ': ' + models.length + ' model kaydedildi');
  });
}

/* ---------------- ☢ Fallout: çökme sonrası otomatik kurtarma zinciri ---------------- */

/* Kayıtlı providerları grupla: providerId -> { name, models:[{sel, model}] } */
function falloutProviderGroups() {
  const groups = new Map();
  for (const m of state.models || []) {
    const pid = String(m.sel).split('::')[0];
    if (!groups.has(pid)) groups.set(pid, { name: m.providerName, models: [] });
    const g = groups.get(pid);
    g.models.push({ sel: m.sel, model: m.model });
  }
  return groups;
}

async function renderFalloutPane() {
  const pane = $('#tab-fallout');
  if (!pane) return;
  let cfg;
  try {
    cfg = await beast.getFallout();
  } catch {
    cfg = { enabled: false, autoResume: true, slots: Array.from({ length: 10 }, () => null) };
  }
  if (!Array.isArray(cfg.slots)) cfg.slots = Array.from({ length: 10 }, () => null);

  /* #23 provider → kayıtlı API key (config.yaml/.env + custom providerlar) */
  let keyMap = {};
  try { keyMap = (await beast.providerKeys()) || {}; } catch {}

  const savedCount = cfg.slots.filter(Boolean).length;
  pane.innerHTML =
    '<h2>' + _t('fo_h2') + '</h2>' +
    '<div class="sub">' + _t('fo_sub') + '</div>' +
    `<div class="fo-toggles">
      <label class="lock-row"><input type="checkbox" id="foEnabled" ${cfg.enabled ? 'checked' : ''}/><span>${_t('fo_enabled')}</span></label>
      <label class="lock-row"><input type="checkbox" id="foResume" ${cfg.autoResume !== false ? 'checked' : ''}/><span>${_t('fo_resume')}</span></label>
      <span class="fo-count">${_ti('fo_count', savedCount)}</span>
    </div>`;

  $('#foEnabled').addEventListener('change', async (e) => {
    cfg.enabled = e.target.checked;
    cfg = await beast.setFallout(cfg);
    toast(cfg.enabled ? 'Fallout devrede — zincir hazır' : 'Fallout kapalı');
  });
  $('#foResume').addEventListener('change', async (e) => {
    cfg.autoResume = e.target.checked;
    cfg = await beast.setFallout(cfg);
    toast(e.target.checked ? 'Çökme sonrası otomatik devam açık' : 'Otomatik devam kapalı');
  });

  const groups = falloutProviderGroups();
  const pids = [...groups.keys()];

  if (!pids.length) {
    pane.insertAdjacentHTML(
      'beforeend',
      '<p class="sub" style="margin-top:14px">Kayıtlı provider yok — önce Provider sekmesinden bir sağlayıcı ekle.</p>'
    );
    return;
  }

  for (let i = 0; i < 10; i++) {
    const slot = cfg.slots[i];
    const row = document.createElement('div');
    row.className = 'fo-slot' + (slot ? ' filled' : '');
    row.innerHTML =
      `<span class="fo-badge" title="${_t('fo_seq')}">${i + 1}</span>` +
      `<select class="inp fo-provider"></select>` +
      `<select class="inp fo-model"></select>` +
      `<input class="inp fo-key" type="password" placeholder="API Key (sk-…)" autocomplete="off" spellcheck="false"/>` +
      `<button class="btn ghost fo-save">${_t('fo_save')}</button>` +
      `<button class="prov-del fo-clear" title="${_t('fo_clear_title')}">&#x2715;</button>`;

    const provSel = row.querySelector('.fo-provider');
    const modelSel = row.querySelector('.fo-model');
    const keyInp = row.querySelector('.fo-key');

    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = _t('fo_provider_ph');
    provSel.appendChild(ph);
    for (const [pid, g] of groups) {
      const o = document.createElement('option');
      o.value = pid;
      o.textContent = g.name;
      provSel.appendChild(o);
    }

    const fillModels = (pid, wantModel) => {
      modelSel.innerHTML = '';
      const g = groups.get(pid);
      if (!g) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '—';
        modelSel.appendChild(o);
        return;
      }
      for (const m of g.models) {
        const o = document.createElement('option');
        o.value = m.model;
        o.textContent = m.model;
        if (wantModel && m.model === wantModel) o.selected = true;
        modelSel.appendChild(o);
      }
    };

    if (slot && groups.has(slot.providerId)) {
      provSel.value = slot.providerId;
      fillModels(slot.providerId, slot.model);
      keyInp.value = slot.key;
      if (!keyInp.value) autofillKey(); // kayıtsız key → kayıtlıdan doldur
    }
    /* #23 provider seçilince kayıtlı API key otomatik yüklenir;
       kullanıcı elle değiştirirse onun yazdığı esas alınır */
    const autofillKey = () => {
      keyInp.dataset.userEdited = '';
      keyInp.value = keyMap[provSel.value] || '';
      keyInp.placeholder = keyMap[provSel.value]
        ? 'API Key (kayıtlı olan yüklendi)'
        : 'API Key (sk-…) — bu provider için kayıtlı key yok';
    };
    provSel.addEventListener('change', () => {
      fillModels(provSel.value);
      autofillKey();
    });
    keyInp.addEventListener('input', () => { keyInp.dataset.userEdited = '1'; });

    row.querySelector('.fo-save').addEventListener('click', async () => {
      const pid = provSel.value;
      const model = modelSel.value;
      const key = keyInp.value.trim();
      if (!pid || !model || !key) {
        toast('#' + (i + 1) + ': provider, model ve key gerekli');
        return;
      }
      cfg.slots[i] = { providerId: pid, providerName: groups.get(pid).name, model, key };
      cfg = await beast.setFallout(cfg);
      renderFalloutPane();
      toast(`#${i + 1} kaydedildi: ${groups.get(pid).name} · ${model}`);
    });

    row.querySelector('.fo-clear').addEventListener('click', async () => {
      if (!cfg.slots[i]) return;
      cfg.slots[i] = null;
      cfg = await beast.setFallout(cfg);
      renderFalloutPane();
      toast(`#${i + 1} kaydı silindi`);
    });

    pane.appendChild(row);
  }

  pane.insertAdjacentHTML(
    'beforeend',
    '<div class="sub" style="margin-top:10px">' + _t('fo_note') + '</div>'
  );
}

async function renderSkillsPane() {
  const pane = $('#tab-skills');
  pane.innerHTML = '<h2>' + _t('sk_h2') + '</h2><div class="sub">' + _t('sk_sub') + '</div>';
  /* OTOMATİK SKİLL SİSTEMİ: öğrenilen prosedürler otomatik kurulur/güncellenir */
  const auto = await beast.skillsGetAuto().catch(() => true);
  pane.insertAdjacentHTML(
    'afterbegin',
    `<div class="fo-toggles" style="margin-bottom:12px"><label class="lock-row"><input type="checkbox" id="autoSkillsOn" ${auto ? 'checked' : ''}/><span>${_t('sk_auto')}</span></label></div>`
  );
  pane.querySelector('#autoSkillsOn').addEventListener('change', async (e) => {
    await beast.skillsSetAuto(e.target.checked);
    toast((e.target.checked ? 'Otomatik skill: AÇIK' : 'Otomatik skill: KAPALI'));
  });
  const list = await beast.listSkills();
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'skill-row';
    row.innerHTML =
      `<div class="skill-name">${escapeHtml(s.name)}</div>` +
      `<div class="skill-desc">${escapeHtml(s.description)}</div>` +
      `<div class="skill-path">${escapeHtml(s.path)}</div>`;
    pane.appendChild(row);
  }

  /* kurallar (#3) */
  const rules = await beast.rulesGet().catch(() => []);
  pane.insertAdjacentHTML('beforeend', '<div class="divider"></div><h2>' + _t('sk_rules_h2') + '</h2><div class="sub">' + _t('sk_rules_sub') + '</div>');
  const ruleWrap = document.createElement('div');
  for (const [i, r] of rules.entries()) {
    const rr = document.createElement('div');
    rr.className = 'usage-row';
    rr.innerHTML = `<span style="flex:1">${i + 1}. ${escapeHtml(r)}</span>`;
    const del = document.createElement('button');
    del.className = 'prov-del';
    del.textContent = '✕';
    del.addEventListener('click', async () => { await beast.ruleRemove(r); renderSkillsPane(); });
    rr.appendChild(del);
    ruleWrap.appendChild(rr);
  }
  if (!rules.length) ruleWrap.innerHTML = '<p class="sub">' + _t('sk_no_rule') + '</p>';
  pane.appendChild(ruleWrap);
  const addRuleRow = document.createElement('div');
  addRuleRow.className = 'form-grid';
  addRuleRow.style.cssText = 'grid-template-columns:1fr auto;align-items:center;margin-top:6px';
  addRuleRow.innerHTML = '<input id="ruleInp" class="inp" placeholder="' + _t('sk_rule_ph') + '" /><button id="ruleAdd" class="btn ghost">' + _t('sk_rule_add') + '</button>';
  pane.appendChild(addRuleRow);
  $('#ruleAdd').addEventListener('click', async () => {
    const v = $('#ruleInp').value.trim();
    if (!v) return;
    await beast.ruleAdd(v);
    renderSkillsPane();
    toast('Kural eklendi');
  });

  /* yansıma taslakları (#2) */
  const drafts = await beast.draftsList().catch(() => []);
  pane.insertAdjacentHTML('beforeend', '<div class="divider"></div><h2>' + _t('sk_drafts_h2') + '</h2><div class="sub">' + _t('sk_drafts_sub') + '</div>');
  if (!drafts.length) {
    pane.insertAdjacentHTML('beforeend', '<p class="sub">' + _t('sk_no_draft') + '</p>');
  }
  for (const d of drafts) {
    const card = document.createElement('div');
    card.className = 'skill-row';
    card.innerHTML =
      `<div class="skill-name">${escapeHtml(d.name)}</div>` +
      `<div class="skill-desc">${escapeHtml(d.description)}</div>` +
      `<div class="form-grid" style="grid-template-columns:auto auto;gap:8px;margin-top:6px">` +
      `<button class="btn dr-accept">${_t('sk_dr_accept')}</button>` +
      `<button class="btn ghost dr-drop">${_t('sk_dr_drop')}</button></div>`;
    card.querySelector('.dr-accept').addEventListener('click', async () => {
      await beast.draftAccept(d.id);
      toast('Skill kuruldu: ' + d.id);
      renderSkillsPane();
    });
    card.querySelector('.dr-drop').addEventListener('click', async () => {
      await beast.draftDrop(d.id);
      renderSkillsPane();
    });
    pane.appendChild(card);
  }

  const btn = document.createElement('button');
  btn.className = 'btn ghost';
  btn.style.marginTop = '10px';
  btn.textContent = _t('sk_open_folder');
  btn.addEventListener('click', () => beast.openSkillsFolder());
  pane.appendChild(btn);
}

/* ---------------- sesli yanıt (TTS) ---------------- */

async function renderTtsPane() {
  const pane = $('#tab-tts');
  if (!pane) return;
  pane.innerHTML =
    '<h2>' + _t('tts_h2') + '</h2><div class="sub">' + _t('tts_sub') + '</div>' +
    `<div class="form-grid" style="grid-template-columns:auto 1fr 1fr;align-items:center;margin-top:10px">
      <label class="lock-row"><input type="checkbox" id="ttsOn" /><span>${_t('tts_active')}</span></label>
      <input id="ttsUrl" class="inp" placeholder="https://api.openai.com/v1" autocomplete="off" />
      <input id="ttsKey" class="inp" type="password" placeholder="API Key" autocomplete="off" />
      <input id="ttsModel" class="inp" placeholder="tts-1" autocomplete="off" />
      <input id="ttsVoice" class="inp" placeholder="ses: alloy" autocomplete="off" />
      <button id="ttsSave" class="btn ghost">${_t('tts_save')}</button>
    </div>` +
    '<div class="sub" style="margin-top:8px">' + _t('tts_note') + '</div>';

  try {
    const tts = await beast.waGetTts();
    $('#ttsOn').checked = !!tts.enabled;
    $('#ttsUrl').value = tts.baseUrl || '';
    $('#ttsKey').value = tts.key || '';
    $('#ttsModel').value = tts.model || 'tts-1';
    $('#ttsVoice').value = tts.voice || 'alloy';
  } catch {}
  $('#ttsSave').addEventListener('click', async () => {
    await beast.waSetTts({
      enabled: $('#ttsOn').checked,
      baseUrl: $('#ttsUrl').value.trim(),
      key: $('#ttsKey').value.trim(),
      model: $('#ttsModel').value.trim(),
      voice: $('#ttsVoice').value.trim(),
    });
    toast($('#ttsOn').checked ? 'TTS açık — cevaplar sesli de gider' : 'TTS kapalı');
  });
}

/* ---------------- e-posta (Gmail) ---------------- */

async function renderEmailPane() {
  const pane = $('#tab-email');
  if (!pane) return;
  const PASS_MASK = '••••••••';
  let savedPass = '';
  let passChanged = false;
  pane.innerHTML =
    '<h2>' + _t('em_h2') + '</h2><div class="sub">' + _t('em_sub') + '</div>' +
    `<div class="form-grid" style="grid-template-columns:1fr 1fr;align-items:center;margin-top:10px">
      <input id="emHost" class="inp" placeholder="imap.gmail.com" autocomplete="off" />
      <input id="emUser" class="inp" placeholder="adres@gmail.com" autocomplete="off" />
      <input id="emPass" class="inp" type="password" placeholder="Uygulama Şifresi" autocomplete="off" />
      <input id="emSmtpHost" class="inp" placeholder="smtp.gmail.com" autocomplete="off" />
      <input id="emSmtpPort" class="inp" placeholder="465" autocomplete="off" />
      <button id="emSave" class="btn ghost">${_t('em_save')}</button>
    </div>` +
    '<div class="sub" style="margin-top:8px">' + _t('em_note') + '</div>';

  try {
    const em = await beast.getEmail();
    $('#emHost').value = em.host || 'imap.gmail.com';
    $('#emUser').value = em.user || '';
    $('#emSmtpHost').value = em.smtpHost || 'smtp.gmail.com';
    $('#emSmtpPort').value = em.smtpPort || 465;
    savedPass = em.pass || '';
  } catch {}
  const emPass = $('#emPass');
  if (savedPass) {
    /* kayıtlı şifre maskelenir; sadece kullanıcı değiştirirse yenisi gönderilir */
    emPass.value = PASS_MASK;
    emPass.placeholder = window.I18N ? window.I18N.t('em_pass_masked') : 'Mevcut şifre korunuyor — değiştirmek için yeniden gir';
  }
  emPass.addEventListener('focus', () => { if (emPass.value === PASS_MASK) emPass.value = ''; });
  emPass.addEventListener('input', () => { passChanged = true; });
  $('#emSave').addEventListener('click', async () => {
    const entered = emPass.value;
    const pass = passChanged ? entered : savedPass;
    await beast.setEmail({
      host: $('#emHost').value.trim() || 'imap.gmail.com',
      port: 993,
      user: $('#emUser').value.trim(),
      pass,
      smtpHost: $('#emSmtpHost').value.trim() || 'smtp.gmail.com',
      smtpPort: Number($('#emSmtpPort').value) || 465,
    });
    if (pass && pass !== PASS_MASK) { savedPass = pass; emPass.value = PASS_MASK; passChanged = false; }
    toast(_t('em_saved'));
  });
}

/* ---------------- integrations (WhatsApp) ---------------- */

const waUI = { status: 'disconnected', qr: null, user: null };

function onWaEvent(ev) {
  if (ev.type === 'allow') {
    /* WA'dan /allow veya /block ile liste değişti — Entegrasyonlar sekmesi açıksa tazele */
    if (!els.settingsOverlay.hidden && setTab === 'integrations') renderIntegrationsPane();
    return;
  }
  if (ev.type === 'queue') {
    /* FEATURE 2: offline kuyruk bildirimi — toast + paneldeki sayaç */
    if (ev.text) toast(ev.text);
    updateQueueInfo(ev);
    return;
  }
  if (ev.type !== 'status') return;
  waUI.status = ev.status;
  if (ev.qr) waUI.qr = ev.qr;
  if (ev.user) waUI.user = ev.user;
  updateWaPane();
}

const WA_STATUS_TEXT = {
  disconnected: 'Bağlı değil',
  connecting: 'Bağlanıyor…',
  reconnecting: 'Yeniden bağlanıyor…',
  qr: 'QR bekleniyor — telefonla okut',
  connected: 'Bağlı',
  'logged-out': 'Oturum kapatıldı, tekrar QR okut',
  error: 'Hata',
};

async function renderIntegrationsPane() {
  const pane = $('#tab-integrations');
  const g = await beast.waGetGroups().catch(() => ({ enabled: false, mentionOnly: true, seeAll: false }));
  pane.innerHTML =
    '<h2>' + _t('it_h2') + '</h2><div class="sub">' + _t('it_sub') + '</div>' +
    `<div class="wa-card">
      <div class="wa-head">
        <div class="wa-logo">W</div>
        <div>
          <div class="wa-title">WhatsApp</div>
          <div class="wa-sub">${_t('it_wa_sub')}</div>
        </div>
      </div>
      <div class="wa-status"><span id="waDot" class="wa-dot"></span><span id="waStatText">—</span></div>
      <div id="waQueueInfo" class="sub" style="margin-top:6px" hidden></div>
      <div id="waUser" class="wa-user" hidden></div>
      <div id="waQr" hidden>
        <img id="waQrImg" width="220" height="220" alt="QR">
        <div class="sub" style="margin-top:6px">WhatsApp → Bağlı Cihazlar → Cihaz Bağla ile okut</div>
      </div>
      <div class="wa-actions">
        <button id="waStartBtn" class="btn">${_t('it_connect')}</button>
        <button id="waStopBtn" class="btn ghost">${_t('it_disconnect')}</button>
        <button id="waResetBtn" class="btn ghost">${_t('it_reset_pair')}</button>
      </div>
      <div style="height:14px"></div>
      <label class="lock-row"><input type="checkbox" id="waGroupsOn" ${g.enabled ? 'checked' : ''}/><span>${_t('it_groups_on')}</span></label>
      <label class="lock-row" style="${g.enabled ? '' : 'opacity:.45'}"><input type="radio" name="waGroupMode" id="waGroupsMention" ${g.mentionOnly !== false ? 'checked' : ''}/><span>${_t('it_groups_mention')}</span></label>
      <label class="lock-row" style="${g.enabled ? '' : 'opacity:.45'}"><input type="radio" name="waGroupMode" id="waGroupsAll" ${g.mentionOnly === false ? 'checked' : ''}/><span>${_t('it_groups_all')}</span></label>
      <label class="lock-row" id="waSeeAllRow" style="${g.enabled && g.mentionOnly !== false ? '' : 'opacity:.45'}"><input type="checkbox" id="waGroupsSeeAll" ${g.seeAll ? 'checked' : ''}/><span>${_t('it_groups_seeall')}</span></label>
      <div class="divider"></div>
      <label class="mem-label" style="margin-top:0">${_t('it_allow_label')}</label>
      <div id="waAllowChips" class="chips-inline"></div>
      <div class="form-grid" style="grid-template-columns:1.2fr 1fr 1fr auto;align-items:center">
        <input id="waAllowNameInp" class="inp" style="margin:6px 0 0" placeholder="${_t('it_name_ph')}" autocomplete="off" />
        <input id="waAllowInp" class="inp" style="margin:6px 0 0" placeholder="${_t('it_num_ph')}" autocomplete="off" />
        <select id="waAllowBotSel" class="perm-select" style="margin:6px 0 0;min-width:105px" title="${_t('bot_bind_title')}"></select>
        <button id="waAllowAdd" class="btn ghost" style="margin-top:6px">${_t('it_add')}</button>
      </div>
      <div class="sub" style="margin-top:8px">${_t('it_allow_note')}</div>
    </div>

    <div class="wa-card" style="margin-top:14px">
      <div class="wa-head">
        <div class="wa-logo tg">T</div>
        <div>
          <div class="wa-title">Telegram</div>
          <div class="wa-sub">${_t('it_tg_sub')}</div>
        </div>
      </div>
      <div class="wa-status"><span id="tgDot" class="wa-dot"></span><span id="tgStatText">—</span></div>
      <div id="tgUser" class="wa-user" hidden></div>
      <div class="form-grid" style="grid-template-columns:1fr auto;align-items:center">
        <input id="tgTokenInp" class="inp" type="password" style="margin:6px 0 0" placeholder="${_t('it_tg_token_ph')}" autocomplete="off" />
        <button id="tgSaveBtn" class="btn" style="margin-top:6px">${_t('it_tg_save')}</button>
      </div>
      <div class="wa-actions" style="margin-top:6px">
        <button id="tgStopBtn" class="btn ghost">${_t('it_disconnect')}</button>
      </div>
      <div class="divider"></div>
      <label class="mem-label" style="margin-top:0">${_t('it_allow_label')} — Telegram</label>
      <div id="tgAllowChips" class="chips-inline"></div>
      <div class="form-grid" style="grid-template-columns:1.2fr 1fr 1fr auto;align-items:center">
        <input id="tgAllowNameInp" class="inp" style="margin:6px 0 0" placeholder="${_t('it_name_ph')}" autocomplete="off" />
        <input id="tgAllowIdInp" class="inp" style="margin:6px 0 0" placeholder="${_t('it_tg_id_ph')}" autocomplete="off" />
        <select id="tgAllowBotSel" class="perm-select" style="margin:6px 0 0;min-width:105px" title="${_t('bot_bind_title')}"></select>
        <button id="tgAllowAdd" class="btn ghost" style="margin-top:6px">${_t('it_add')}</button>
      </div>
      <div class="sub" style="margin-top:8px">${_t('it_tg_note')}</div>
    </div>

    <div class="wa-card" style="margin-top:14px">
      <div class="wa-head">
        <div class="wa-logo tg">D</div>
        <div>
          <div class="wa-title">Discord</div>
          <div class="wa-sub">${_t('it_dc_sub')}</div>
        </div>
      </div>
      <div class="wa-status"><span id="dcDot" class="wa-dot"></span><span id="dcStatText">—</span></div>
      <div id="dcUser" class="wa-user" hidden></div>
      <div class="form-grid" style="grid-template-columns:1fr auto;align-items:center">
        <input id="dcTokenInp" class="inp" type="password" style="margin:6px 0 0" placeholder="${_t('it_dc_token_ph')}" autocomplete="off" />
        <button id="dcSaveBtn" class="btn" style="margin-top:6px">${_t('it_tg_save')}</button>
      </div>
      <div class="wa-actions" style="margin-top:6px">
        <button id="dcStopBtn" class="btn ghost">${_t('it_disconnect')}</button>
      </div>
      <div class="sub" style="margin-top:6px">ⓘ ${_t('it_dc_vpn')}</div>
      <div class="divider"></div>
      <label class="mem-label" style="margin-top:0">${_t('it_allow_label')} — Discord</label>
      <div id="dcAllowChips" class="chips-inline"></div>
      <div class="form-grid" style="grid-template-columns:1.2fr 1fr 1fr auto;align-items:center">
        <input id="dcAllowNameInp" class="inp" style="margin:6px 0 0" placeholder="${_t('it_name_ph')}" autocomplete="off" />
        <input id="dcAllowIdInp" class="inp" style="margin:6px 0 0" placeholder="${_t('it_dc_id_ph')}" autocomplete="off" />
        <select id="dcAllowBotSel" class="perm-select" style="margin:6px 0 0;min-width:105px" title="${_t('bot_bind_title')}"></select>
        <button id="dcAllowAdd" class="btn ghost" style="margin-top:6px">${_t('it_add')}</button>
      </div>
      <div class="sub" style="margin-top:8px">${_t('it_dc_note')}</div>
    </div>`;

  const waGroupsOn = $('#waGroupsOn');
  const waGroupsMention = $('#waGroupsMention');
  const waGroupsAll = $('#waGroupsAll');
  const waGroupsSeeAll = $('#waGroupsSeeAll');
  const waSeeAllRow = $('#waSeeAllRow');
  /* iki mod BİRBİRİNE HARIÇTİR: ya @mention ya her mesaja karışma (radio)
     seeAll yalnız mention modunda anlamlı — o mod seçiliyken aktifleşir */
  const syncGroupMode = () => {
    const op = waGroupsOn.checked ? '' : '.45';
    if (waGroupsMention) waGroupsMention.parentElement.style.opacity = op;
    if (waGroupsAll) waGroupsAll.parentElement.style.opacity = op;
    if (waSeeAllRow) waSeeAllRow.style.opacity = waGroupsOn.checked && waGroupsMention && waGroupsMention.checked ? '' : '.45';
  };
  const saveGroups = async () => {
    const r = await beast.waSetGroups({ enabled: waGroupsOn.checked, mentionOnly: !waGroupsAll.checked, seeAll: !!(waGroupsSeeAll && waGroupsSeeAll.checked) });
    toast(
      r.enabled
        ? r.mentionOnly
          ? r.seeAll
            ? 'Gruplar açık — tüm konuşmalar bağlam olarak okunuyor, sadece @mention\'a cevap verir'
            : 'Gruplar açık — @mention bekler'
          : 'Gruplar açık — tüm mesajlara karışır'
        : 'Gruplar kapalı'
    );
  };
  waGroupsOn.addEventListener('change', async () => {
    syncGroupMode();
    await saveGroups();
  });
  waGroupsMention.addEventListener('change', () => {
    syncGroupMode();
    saveGroups();
  });
  waGroupsAll.addEventListener('change', () => {
    syncGroupMode();
    saveGroups();
  });
  if (waGroupsSeeAll) waGroupsSeeAll.addEventListener('change', saveGroups);
  syncGroupMode();

  $('#waStartBtn').addEventListener('click', async () => {
    toast('Bağlanıyor…');
    await beast.waStart();
  });
  $('#waStopBtn').addEventListener('click', async () => {
    await beast.waStop();
    toast('Kesildi');
  });
  $('#waResetBtn').addEventListener('click', async () => {
    await beast.waReset();
    toast('Eşleme sıfırlandı');
  });

  /* FEATURE 2: offline kuyruk durumu */
  try {
    const st = await beast.waQueueGet();
    updateQueueInfo(st);
  } catch {}

  await renderWaAllow();

  const snap = await beast.waStatus();
  waUI.status = snap.status || 'disconnected';
  if (snap.user) waUI.user = snap.user;
  updateWaPane();

  /* TELEGRAM (FEATURE 3): token + allow list + durum */
  $('#tgSaveBtn').addEventListener('click', async () => {
    const tok = $('#tgTokenInp').value.trim();
    if (!tok) { toast(_t('it_tg_token_ph')); return; }
    toast(_t('it_tg_connecting'));
    const r = await beast.tgSetToken(tok).catch((e) => ({ status: 'error', error: String(e) }));
    $('#tgTokenInp').value = '';
    updateTgPane();
    toast(r.status === 'connected' ? 'Telegram bağlı: ' + (r.user || '') : r.status === 'error' ? _t('it_tg_token_bad') : _t('it_tg_connecting'));
  });
  $('#tgStopBtn').addEventListener('click', async () => {
    await beast.tgStop().catch(() => {});
    updateTgPane();
    toast('Kesildi');
  });
  await renderTgAllow();
  try {
    const ts = await beast.tgGetStatus();
    tgUI.status = ts.status || 'disconnected';
    tgUI.user = ts.user || null;
    updateTgPane();
  } catch {}

  /* DISCORD: token + allow list + durum */
  $('#dcSaveBtn').addEventListener('click', async () => {
    const tok = $('#dcTokenInp').value.trim();
    if (!tok) { toast(_t('it_dc_token_ph')); return; }
    toast(_t('it_dc_connecting'));
    const r = await beast.dcSetToken(tok).catch((e) => ({ status: 'error', error: String(e) }));
    $('#dcTokenInp').value = '';
    updateDcPane();
    toast(r.status === 'connected' ? 'Discord bağlı: ' + (r.user || '') : r.status === 'error' ? _t('it_dc_token_bad') : _t('it_dc_connecting'));
  });
  $('#dcStopBtn').addEventListener('click', async () => {
    await beast.dcStop().catch(() => {});
    updateDcPane();
    toast('Kesildi');
  });
  await renderDcAllow();
  try {
    const ds = await beast.dcGetStatus();
    dcUI.status = ds.status || 'disconnected';
    dcUI.user = ds.user || null;
    updateDcPane();
  } catch {}
}

/* ---------------- Olay Merkezi (ayrı sekme) ---------------- */

async function renderLogPane() {
  const pane = $('#tab-logs');
  if (!pane) return;
  pane.innerHTML =
    '<h2 data-i18n="logs_h2">Loglar</h2>' +
    '<div class="sub" data-i18n="logs_sub">Uygulama olayları — son 600 satır.</div>' +
    '<div class="wa-actions" style="margin:10px 0">' +
    '  <button id="logRefresh" class="btn ghost" data-i18n="logs_refresh">Yenile</button>' +
    '  <button id="logClear" class="btn ghost" data-i18n="logs_clear">Logları Temizle</button>' +
    '</div>' +
    '<pre id="logOut" class="notes-body" style="white-space:pre-wrap;max-height:420px;overflow:auto"></pre>';
  if (window.I18N) window.I18N.apply(pane);
  const out = pane.querySelector('#logOut');
  const refresh = async () => {
    let data = {};
    try { data = await beast.logsGet(); } catch (e) { data = { error: String(e) }; }
    const lines = data.lines || [];
    out.textContent = lines.length
      ? lines.join('\n')
      : (window.I18N ? window.I18N.t('logs_empty') : 'Henüz log yok.');
  };
  pane.querySelector('#logRefresh').addEventListener('click', refresh);
  pane.querySelector('#logClear').addEventListener('click', async () => {
    try { await beast.logsClear(); } catch {}
    refresh();
    toast(window.I18N ? window.I18N.t('logs_clear') : 'Loglar temizlendi');
  });
  refresh();
}

/* ---------------- Dashboard: oturum geçmişi ---------------- */

async function renderDashboardPane() {
  const pane = $('#tab-dash');
  if (!pane) return;
  let sessions = [];
  try { sessions = (await beast.listSessions()) || []; } catch {}
  let waSet = new Set();
  let tgSet = new Set();
  try { waSet = new Set(await beast.waListSessions()); } catch {}
  try { tgSet = new Set(await beast.tgListSessions()); } catch {}

  const totalMsgs = sessions.reduce((a, s) => a + (Number(s.count) || 0), 0);
  const today = new Date().toDateString();
  const todayCount = sessions.filter((s) => s.updatedAt && new Date(s.updatedAt).toDateString() === today).length;
  const last = sessions.length ? sessions[0].updatedAt : null;
  const lastTxt = last ? new Date(last).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

  const stat = (label, v) =>
    `<div class="usage-stat"><div class="us-label">${label}</div><div class="us-value">${v}</div></div>`;

  pane.innerHTML =
    '<h2>' + _t('dash_h2') + '</h2>' +
    '<div class="sub">' + _t('dash_sub') + '</div>' +
    '<div class="usage-cards">' +
    stat(_t('dash_stat_sessions'), String(sessions.length)) +
    stat(_t('dash_stat_msgs'), String(totalMsgs)) +
    stat(_t('dash_stat_today'), String(todayCount)) +
    stat(_t('dash_stat_last'), lastTxt) +
    '</div>';

  if (!sessions.length) {
    pane.insertAdjacentHTML('beforeend', '<p class="sub">' + _t('dash_empty') + '</p>');
    return;
  }

  const list = document.createElement('div');
  list.style.marginTop = '10px';
  for (const s of sessions) {
    const when = s.updatedAt
      ? new Date(s.updatedAt).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '';
    const row = document.createElement('div');
    row.className = 'usage-row' + (s.id === activeId ? ' dash-active' : '');
    row.innerHTML =
      (waSet.has(s.id) ? '<span class="sess-wa" title="WhatsApp">W</span>' : '') +
      (tgSet.has(s.id) ? '<span class="sess-tg" title="Telegram">T</span>' : '') +
      `<span class="sess-code" title="Oturum kodu">${escapeHtml(s.code || '')}</span>` +
      `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">` +
      `${escapeHtml(s.title || 'Yeni Sohbet')}</span>` +
      `<span class="ur-meta">${when} · ${Number(s.count) || 0} ${_t('dash_stat_msgs').toLowerCase()}</span>` +
      `<button class="btn ghost" style="padding:2px 10px;font-size:12px">${_t('dash_open')}</button>`;
    row.querySelector('button').addEventListener('click', async () => {
      closeSettings();
      await openSession(s.id);
    });
    list.appendChild(row);
  }
  pane.appendChild(list);
}

/* ---------------- Limit: provider bazlı girdi limiti ---------------- */

async function renderLimitsPane() {
  const pane = $('#tab-limits');
  if (!pane) return;
  const cur = await beast.getLimits().catch(() => ({ enabled: false, compress: true, default: 0, perProvider: {} }));
  const provs = [...new Set((state.models || []).map((m) => m.providerName))].sort((a, b) => a.localeCompare(b));

  const provRows = provs.length
    ? provs
        .map((p) => {
          const v = cur.perProvider[p] || 0;
          return `<div class="usage-row" style="align-items:center">
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p)}</span>
            <input class="inp lim-prov" data-prov="${escapeHtml(p)}" type="number" min="0" step="1000"
              value="${v || ''}" placeholder="0 (${_t('lim_unlimited')})" style="width:130px;flex:none;margin:0" />
          </div>`;
        })
        .join('')
    : '<p class="sub">' + _t('p_no_model') + '</p>';

  pane.innerHTML =
    '<h2>' + _t('lim_h2') + '</h2>' +
    '<div class="sub">' + _t('lim_sub') + '</div>' +
    `<div class="fo-toggles" style="margin-top:10px">
      <label class="lock-row"><input type="checkbox" id="limOn" ${cur.enabled ? 'checked' : ''}/><span>${_t('lim_enabled')}</span></label>
    </div>
    <div id="limDetail" style="${cur.enabled ? '' : 'opacity:.45'}">
      <label class="lock-row"><input type="checkbox" id="limCompress" ${cur.compress ? 'checked' : ''}/><span>${_t('lim_compress')}</span></label>
      <div class="form-grid" style="grid-template-columns:1fr auto;align-items:center;margin-top:8px">
        <label class="mem-label" style="margin:0">${_t('lim_default')}</label>
        <input id="limDefault" class="inp" type="number" min="0" step="1000" value="${cur.default || ''}" placeholder="0" style="width:130px;flex:none;margin:0" />
      </div>
      <h2 style="margin-top:16px">${_t('lim_prov_h2')}</h2>
      <div class="sub">${_t('lim_prov_sub')}</div>
      <div style="margin-top:6px">${provRows}</div>
      <button id="limSave" class="btn ghost" style="margin-top:12px">${_t('lim_save')}</button>
    </div>`;

  const det = pane.querySelector('#limDetail');
  pane.querySelector('#limOn').addEventListener('change', (e) => {
    det.style.opacity = e.target.checked ? '' : '.45';
  });

  pane.querySelector('#limSave').addEventListener('click', async () => {
    const perProvider = {};
    for (const inp of pane.querySelectorAll('.lim-prov')) {
      const n = Math.round(Number(inp.value) || 0);
      if (n > 0) perProvider[inp.dataset.prov] = n;
    }
    await beast.setLimits({
      enabled: pane.querySelector('#limOn').checked,
      compress: pane.querySelector('#limCompress').checked,
      default: Math.round(Number(pane.querySelector('#limDefault').value) || 0),
      perProvider,
    });
    toast(_t('lim_saved_toast'));
  });
}

/* ---------------- Güvenlik: ajan onay davranışı ---------------- */

async function renderSecurityPane() {
  const pane = $('#tab-sec');
  if (!pane) return;
  const cur = await beast.secGet().catch(() => ({ approvals: false, alwaysAllow: [] }));

  const alwaysRows = (cur.alwaysAllow || []).length
    ? cur.alwaysAllow.map((t) => `<span class="chip" style="margin:0 6px 6px 0"><span class="chip-txt">${escapeHtml(t)}</span></span>`).join('')
    : '<p class="sub">' + _t('sec_always_empty') + '</p>';

  pane.innerHTML =
    '<h2>' + _t('security_h2') + '</h2>' +
    '<div class="sub">' + _t('sec_sub') + '</div>' +
    `<div class="fo-toggles" style="margin-top:10px">
      <label class="lock-row"><input type="checkbox" id="secOn" ${cur.approvals ? 'checked' : ''}/><span>${_t('sec_toggle')}</span></label>
    </div>` +
    '<div class="sub" style="margin-top:8px">' + _t('sec_note') + '</div>' +
    '<div class="divider"></div>' +
    `<h2>${_t('sec_always_h2')}</h2>` +
    `<div style="margin-top:6px">${alwaysRows}</div>` +
    ((cur.alwaysAllow || []).length
      ? `<button id="secClearAlways" class="btn ghost" style="margin-top:6px">${_t('sec_clear_always')}</button>`
      : '');

  pane.querySelector('#secOn').addEventListener('change', async (e) => {
    await beast.secSet({ approvals: e.target.checked });
    toast(e.target.checked ? _t('sec_on_toast') : _t('sec_off_toast'));
  });
  const clr = pane.querySelector('#secClearAlways');
  if (clr) {
    clr.addEventListener('click', async () => {
      await beast.secSet({ approvals: cur.approvals, alwaysAllow: [] });
      renderSecurityPane();
    });
  }
}

/* ---------------- Update: sürüm kontrol + otomatik güncelleme ---------------- */

let updatePaneTimer = null;

function renderUpdateStateHtml(st) {
  let status;
  if (st.error) status = '\u26A0\uFE0E ' + st.error;
  else if (st.downloaded) status = _t('up_downloaded') + ' (v' + (st.version || '?') + ')';
  else if (st.progress) status = _t('up_downloading') + ' %' + st.progress.percent;
  else if (st.checking) status = _t('up_checking');
  else if (st.available) status = _t('up_available') + ' (v' + (st.version || '?') + ')';
  else if (st.npm) status = _t('up_npm_mode');
  else if (st.available === false) status = _t('up_uptodate');
  else status = '—';

  return `<div class="usage-stat" id="upStatusBox"><div class="us-label">${_t('up_status')}</div><div class="us-value" style="font-size:14px">${escapeHtml(status)}</div></div>`;
}

async function renderUpdatePane(autoCheck) {
  const pane = $('#tab-update');
  if (!pane) return;
  const st = await beast.updateStatus().catch(() => null);
  if (!st) return;
  clearInterval(updatePaneTimer);

  /* mod bazlı butonlar: npm → kontrol + güncelle-butonu (görünür cmd açar),
     installer → kontrol + not, dev → sadece kontrol */
  const isDev = !st.packaged && !st.npm;
  let actions;
  if (st.npm) {
    actions = `<div class="form-grid" style="grid-template-columns:auto auto;gap:8px;margin-top:12px">
        <button id="upCheck" class="btn ghost">${_t('up_check_now')}</button>
        <button id="upInstall" class="btn"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:5px"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>${_t('up_install_now')}</button>
      </div>
      <div class="sub" style="margin-top:8px">${_t('up_npm_only')}</div>`;
  } else if (isDev) {
    actions = `<div class="form-grid" style="grid-template-columns:auto auto;gap:8px;margin-top:12px">
        <button id="upCheck" class="btn ghost">${_t('up_check_now')}</button>
      </div>
      <div class="sub" style="margin-top:8px">${_t('up_dev_note')}</div>`;
  } else {
    actions = `<div class="form-grid" style="grid-template-columns:auto auto;gap:8px;margin-top:12px">
        <button id="upCheck" class="btn ghost">${_t('up_check_now')}</button>
      </div>
      <div class="sub" style="margin-top:8px">${_t('up_npm_only')}</div>`;
  }

  pane.innerHTML =
    '<h2>' + _t('up_h2') + '</h2>' +
    '<div class="sub">' + _t('up_sub') + '</div>' +
    '<div class="usage-cards">' +
    `<div class="usage-stat"><div class="us-label">${_t('up_current')}</div><div class="us-value">v${escapeHtml(st.current)}</div></div>` +
    `<div class="usage-stat"><div class="us-label">${_t('up_latest')}</div><div class="us-value">${st.version ? 'v' + escapeHtml(st.version) : '—'}</div></div>` +
    '</div>' +
    renderUpdateStateHtml(st) +
    `<div class="fo-toggles" style="margin-top:12px">
      <label class="lock-row"><input type="checkbox" id="upAutoCheck" ${st.autoCheck ? 'checked' : ''}/><span>${_t('up_auto_check')}</span></label>
      <label class="lock-row"><input type="checkbox" id="upAutoDl" ${st.autoDownload ? 'checked' : ''}/><span>${_t('up_auto_dl')}</span></label>
    </div>` +
    actions;

  const chk = pane.querySelector('#upAutoCheck');
  if (chk) chk.addEventListener('change', async (e) => { await beast.updateSetAuto({ autoCheck: e.target.checked }); });
  const dl = pane.querySelector('#upAutoDl');
  if (dl) dl.addEventListener('change', async (e) => { await beast.updateSetAuto({ autoDownload: e.target.checked }); });

  const btnCheck = pane.querySelector('#upCheck');
  if (btnCheck) btnCheck.addEventListener('click', async () => {
    btnCheck.disabled = true;
    const r = await beast.updateCheck().catch(() => ({ ok: false, error: 'ipc' }));
    btnCheck.disabled = false;
    if (!r.ok && r.error) toast(r.error);
    renderUpdatePane();
  });
  const btnInstall = pane.querySelector('#upInstall');
  if (btnInstall) btnInstall.addEventListener('click', async () => {
    const r = await beast.updateInstall().catch(() => ({ ok: false, error: 'ipc' }));
    if (r.ok && r.npm) toast(_t('up_npm_started'));
    else if (!r.ok && r.error) toast(r.error);
  });
  /* #upInstall butonu kaldırıldı — tek dağıtım npm (buton geri gelirse çalışsın diye koruma duruyor) */

  /* indirme ilerlemesi için sekme açıkken canlı tazele — YALNIZ durum kutusu */
  updatePaneTimer = setInterval(() => {
    if ($('#tab-update').hidden || els.settingsOverlay.hidden) { clearInterval(updatePaneTimer); return; }
    beast.updateStatus().then((s) => {
      if (!s) return;
      const box = pane.querySelector('#upStatusBox');
      if (box) box.outerHTML = renderUpdateStateHtml(s);
    }).catch(() => {});
  }, 1000);

  /* sekme açılırken otomatik sürüm kontrolü */
  if (autoCheck) beast.updateCheck().catch(() => {});
}

/* Sohbete onay kartı düşürür — Onayla / Her zaman / Reddet */function showApprovalCard(ev) {
  streamEl = null;
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.innerHTML =
    `<div class="tool-head"><span class="tool-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>` +
    `<span class="tool-name">${escapeHtml(ev.tool || 'tool')}</span>` +
    `<span class="tool-arg">${escapeHtml(ev.argsPreview || '')}</span></div>` +
    `<div class="tool-body open" style="display:flex;gap:8px;align-items:center">` +
    `<button class="btn ap-ok">${_t('sec_ok')}</button>` +
    `<button class="btn ghost ap-always">${_t('sec_always')}</button>` +
    `<button class="btn ghost ap-no">${_t('sec_no')}</button>` +
    `</div>`;
  const done = (txt) => {
    card.querySelector('.tool-body').innerHTML = `<span class="sub">${escapeHtml(txt)}</span>`;
  };
  card.querySelector('.ap-ok').addEventListener('click', async () => { await beast.approvalRespond(ev.requestId, true, false); done(_t('sec_ok_done')); });
  card.querySelector('.ap-always').addEventListener('click', async () => { await beast.approvalRespond(ev.requestId, true, true); done(_t('sec_always_done')); });
  card.querySelector('.ap-no').addEventListener('click', async () => { await beast.approvalRespond(ev.requestId, false, false); done(_t('sec_no_done')); });
  els.msgs.appendChild(card);
  scrollDown(true);
}

async function renderEventsPane() {
  const pane = $('#tab-events');
  if (!pane) return;
  const ec = await beast.eventsGetConfig().catch(() => ({ enabled: false, mailIdle: false, fsWatch: false, port: 8787, token: '' }));
  let subs = [];
  try { subs = await beast.eventsSubs(); } catch {}

  pane.innerHTML =
    '<h2>' + _t('ev_h2') + '</h2>' +
    '<div class="sub">' + _t('ev_sub') + '</div>' +
    `<div class="fo-toggles" style="margin-top:10px">
      <label class="lock-row"><input type="checkbox" id="ebOn" ${ec.enabled ? 'checked' : ''}/><span>${_t('ev_on')}</span></label>
    </div>
    <div id="ebDetail" style="${ec.enabled ? '' : 'opacity:.45'}">
      <label class="lock-row"><input type="checkbox" id="ebMail" ${ec.mailIdle ? 'checked' : ''}/><span>${_t('ev_mail')}</span></label>
      <label class="lock-row"><input type="checkbox" id="ebFs" ${ec.fsWatch ? 'checked' : ''}/><span>${_t('ev_fs')}</span></label>
      <div class="form-grid" style="grid-template-columns:1fr auto;align-items:center;margin-top:6px">
        <input id="ebPrice" class="inp" placeholder="${_t('ev_price_ph')}" value="${escapeHtml(ec.priceSymbol || '')}" spellcheck="false" />
        <button id="ebSave" class="btn ghost">${_t('ev_save')}</button>
      </div>
      <div class="sub">${_t('ev_price_sub')}</div>
      <div class="sub" style="margin-top:8px">Webhook: <code>POST http://127.0.0.1:${ec.port || 8787}/beast-event</code><br>Header: <code>x-beast-token: …</code> <button id="ebTokenCopy" class="btn ghost" style="padding:2px 8px;margin-left:4px">${_t('ev_token_copy')}</button></div>
    </div>` +
    '<h3 style="margin-top:16px;color:var(--muted)">' + _t('ev_subs_h3') + '</h3>';
  const wrap = document.createElement('div');
  if (!subs.length) {
    wrap.innerHTML = '<p class="sub">' + _t('ev_no_sub') + '</p>';
  }
  for (const s of subs) {
    const row = document.createElement('div');
    row.className = 'usage-row';
    row.innerHTML =
      `<span style="font-weight:700">${escapeHtml(s.type)}</span>` +
      `<span class="ur-meta">${s.op && s.value !== null && s.value !== undefined ? `${s.op} ${s.value} · ` : ''}cooldown ${s.cooldownMin} dk</span>`;
    const del = document.createElement('button');
    del.className = 'prov-del';
    del.textContent = '✕';
    del.addEventListener('click', async () => {
      await beast.eventUnsub(s.id);
      renderEventsPane();
      toast('Abonelik silindi');
    });
    row.appendChild(del);
    wrap.appendChild(row);
  }
  pane.appendChild(wrap);

  const ebOn = $('#ebOn');
  const ebDetail = $('#ebDetail');
  const saveEb = async () => {
    const r = await beast.eventsSetConfig({
      enabled: ebOn.checked,
      mailIdle: $('#ebMail').checked,
      fsWatch: $('#ebFs').checked,
      priceSymbol: $('#ebPrice') ? $('#ebPrice').value.trim() : '',
      webhookPort: ec.port || 8787,
    });
    toast(r.enabled ? _t('ev_on_toast') : _t('ev_off_toast'));
  };
  ebOn.addEventListener('change', () => {
    ebDetail.style.opacity = ebOn.checked ? '' : '.45';
    saveEb();
  });
  $('#ebMail').addEventListener('change', saveEb);
  $('#ebFs').addEventListener('change', saveEb);
  $('#ebSave').addEventListener('click', saveEb);
  $('#ebTokenCopy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(ec.token || '').catch(() => {});
    toast('Webhook token kopyalandı');
  });
}

async function renderWaAllow() {
  const wrap = $('#waAllowChips');
  if (!wrap) return;
  const list = await beast.waGetAllow();
  let botChoices = [];
  try { botChoices = (await beast.botsList()) || []; } catch {}
  const botSelHtml = (cur) =>
    `<select class="perm-select" title="${_t('bot_bind_title')}">` +
    `<option value="">${_t('bot_sel_empty')}</option>` +
    botChoices
      .map((bb) => `<option value="${bb.id}" ${cur === bb.id ? 'selected' : ''}>${bb.icon} ${escapeHtml(bb.name)}</option>`)
      .join('') +
    `</select>`;
  wrap.innerHTML = '';
  if (!list.length) {
    wrap.innerHTML = '<span class="sub">— boş —</span>';
  }
  const waLabel = (e) => {
    if (e === '*') return '* herkes';
    if (typeof e === 'string') return '+' + e; // eski string kayıt
    const num = String((e && e.num) || '');
    const name = String((e && e.name) || '').trim();
    const ownerTag = e && e.owner ? ' 👑' : '';
    const bot = botChoices.find((bb) => bb.id === (e && e.bot_id));
    /* bağlı olduğu bot her koşulda etikette görünsün */
    const botTag = bot && e && e.bot_id ? ' → ' + bot.name : '';
    return (name ? name + ' ' : '') + (num ? '+' + num : '') + ownerTag + botTag;
  };
  const waNeedsName = (e) => e !== '*' && String((e && e.name) || '').trim() === '';

  /* Chip içeriğini mini forma çevirip isim/numara düzenlet */
  const startInlineEdit = (idx, chipEl) => {
    const cur = list[idx];
    const num0 = typeof cur === 'string' ? cur : String((cur && cur.num) || '');
    const name0 = typeof cur === 'string' ? '' : String((cur && cur.name) || '');
    const lock0 = typeof cur === 'object' && !!cur.lockdown;
    chipEl.innerHTML = '';
    chipEl.style.margin = '0 6px 6px 0';
    const nInp = document.createElement('input');
    nInp.className = 'inp';
    nInp.value = name0;
    nInp.placeholder = _t('wa_isim_ph');
    nInp.style.cssText = 'width:110px;padding:2px 6px;font-size:12px';
    const uInp = document.createElement('input');
    uInp.className = 'inp';
    uInp.value = num0;
    uInp.placeholder = _t('wa_numara_ph');
    uInp.style.cssText = 'width:120px;padding:2px 6px;font-size:12px';
    const ok = document.createElement('span');
    ok.className = 'lk';
    ok.textContent = _t('wa_kaydet');
    const cancel = document.createElement('span');
    cancel.className = 'x';
    cancel.textContent = '×';
    cancel.title = _t('wa_vazgec');
    const done = document.createElement('span');
    done.textContent = ' ';
    chipEl.append(nInp, uInp, ok, done, cancel);
    const save = async () => {
      const nextAll = (await beast.waGetAllow()).map((e, i) =>
        i === idx
          ? { ...(typeof e === 'object' && e ? e : {}), num: uInp.value.trim(), name: nInp.value.trim().slice(0, 40), lockdown: lock0 }
          : e
      );
      await beast.waSetAllow(nextAll);
      renderWaAllow();
      toast(_t('wa_updated'));
    };
    ok.addEventListener('click', save);
    uInp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } });
    nInp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } });
    cancel.addEventListener('click', () => renderWaAllow());
    nInp.focus();
  };

  list.forEach((entry, idx) => {
    const locked = typeof entry === 'object' && !!entry.lockdown;
    const curPerm = (typeof entry === 'object' && entry.perm) || (locked ? 'chat' : 'all');
    const needsName = waNeedsName(entry);
    const c = document.createElement('span');
    c.className = 'chip' + (locked ? ' chip-locked' : '') + (needsName ? ' chip-noname' : '');
    c.style.margin = '0 6px 6px 0';
    // etikete tıkla → yerinde düzenle (isimsizleri düzeltmek için)
    const txt = document.createElement('span');
    txt.className = 'chip-txt';
    txt.textContent = waLabel(entry) + (needsName ? ' — isimsiz!' : '');
    txt.title = needsName ? _t('wa_no_name_title') : _t('wa_edit_title');
    txt.addEventListener('click', () => startInlineEdit(idx, c));
    c.appendChild(txt);
    // kişi bazlı granül izin: serbest/web/okuma/kısıtlı + sahip rolü
    if (entry !== '*') {
      const isOwnerEntry = typeof entry === 'object' && !!entry.owner;
      const selP = document.createElement('select');
      selP.className = 'perm-select';
      selP.title = _t('wa_perm_title');
      const PERMS = [
        ['all', _t('wa_perm_all')],
        ['web', 'web'],
        ['read', _t('wa_perm_read')],
        ['chat', _t('wa_perm_chat')],
      ];
      for (const [v, lbl] of PERMS) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = lbl;
        if (curPerm === v) o.selected = true;
        selP.appendChild(o);
      }
      selP.addEventListener('change', async () => {
        const cur = await beast.waGetAllow();
        const next = cur.map((e, i) => {
          if (i !== idx) return e;
          if (typeof e === 'string') return { num: e.replace(/\D/g, ''), name: '', perm: selP.value };
          return { ...e, lockdown: selP.value === 'chat', perm: selP.value };
        });
        await beast.waSetAllow(next);
        renderWaAllow();
        toast(waLabel(entry) + ': ' + selP.selectedOptions[0].textContent);
      });
      c.appendChild(selP);

      /* BOT SİSTEMİ: bağlı olduğu bot chip'te seçili gelir — buradan değiştirilebilir */
      if (botChoices.length) {
        const selB = document.createElement('span');
        selB.innerHTML = botSelHtml(typeof entry === 'object' ? entry.bot_id : undefined);
        const sel = selB.firstChild;
        sel.addEventListener('change', async () => {
          const cur = await beast.waGetAllow();
          const next = cur.map((e, i) => {
            if (i !== idx) return e;
            const base = typeof e === 'object' && e ? e : { num: String(e).replace(/\D/g, ''), name: '' };
            return { ...base, bot_id: sel.value || undefined };
          });
          await beast.waSetAllow(next);
          renderWaAllow();
          const bt = botChoices.find((bb) => bb.id === sel.value);
          toast(waLabel(entry) + ' → ' + (bt ? bt.name : '?'));
        });
        c.appendChild(sel);
      }

      /* #v13.1: SAHİP rolü — yalnız biri olabilir */
      const ownerBtn = document.createElement('span');
      ownerBtn.className = 'lk';
      ownerBtn.style.cssText = 'font-size:11px;padding:1px 6px;' + (isOwnerEntry ? 'color:#c9a227;font-weight:800' : '');
      ownerBtn.title = isOwnerEntry
        ? _t('wa_owner_title_on')
        : _t('wa_owner_title_off');
      ownerBtn.textContent = isOwnerEntry ? _t('wa_owner_on') : _t('wa_owner_off');
      ownerBtn.addEventListener('click', async () => {
        if (isOwnerEntry) return; // sahibi tekrar tıklamayla alma; önce başkasına ver
        const cur = await beast.waGetAllow();
        // mevcut sahibin bayrağını kaldır, role new
        const next = cur.map((e, i) => {
          const obj = typeof e === 'string' ? { num: e.replace(/\D/g, ''), name: '' } : { ...e };
          if (typeof obj.owner !== 'undefined' || i === idx) {
            if (typeof e === 'string') { delete obj.owner; } else { obj.owner = false; }
          }
          return obj;
        });
        // hedefe owner ver
        const tgt = next[idx];
        if (tgt && typeof tgt === 'object') tgt.owner = true;
        await beast.waSetAllow(next);
        renderWaAllow();
        toast('Sahip: ' + waLabel(tgt));
      });
      c.appendChild(ownerBtn);
    }
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('click', async () => {
      const next = (await beast.waGetAllow()).filter((_v, i) => i !== idx);
      await beast.waSetAllow(next);
      renderWaAllow();
      toast('Kaldırıldı: ' + waLabel(entry));
    });
    c.appendChild(x);
    wrap.appendChild(c);
  });
  const inp = $('#waAllowInp');
  const nameInp = $('#waAllowNameInp');
  const add = $('#waAllowAdd');
  /* BOT SİSTEMİ: ekleme formundaki bot seçici — boş seçenek = botsuz (beast'e düşer) */
  const botSel = $('#waAllowBotSel');
  if (botSel) {
    const prev = botSel.value;
    botSel.innerHTML =
      `<option value="">${_t('bot_sel_empty')}</option>` +
      botChoices
        .map((bb) => `<option value="${bb.id}">${bb.icon} ${escapeHtml(bb.name)}${bb.admin ? ' (admin)' : ''}</option>`)
        .join('');
    if (prev) botSel.value = prev; // render'lar arası seçim korunur
  }
  if (!add.dataset.bound) {
    add.dataset.bound = '1';
    const addNum = async () => {
      let v = inp.value.trim();
      if (!v) return;
      const name = nameInp.value.trim().slice(0, 40);
      if (!name) { toast('İsim zorunlu — kimin yazdığını bilmek için'); nameInp.focus(); return; }
      const botId = botSel && botSel.value ? { bot_id: botSel.value } : {};
      await beast.waSetAllow([...(await beast.waGetAllow()), { num: v, name, ...botId }]);
      inp.value = '';
      nameInp.value = '';
      renderWaAllow();
      toast('Eklendi: ' + name);
    };
    add.addEventListener('click', addNum);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addNum(); }
    });
    nameInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addNum(); }
    });
  }
}

/* FEATURE 2: kuyruk satırını güncelle (pending/failed sayısı) */
function updateQueueInfo(st) {
  const el = $('#waQueueInfo');
  if (!el) return;
  const pending = Number(st && st.pending) || 0;
  const failed = Number(st && st.failed) || 0;
  if (!pending && !failed) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = _ti('wa_queue_info', pending) + (failed ? ' · ' + _ti('wa_queue_failed', failed) : '');
}

function updateWaPane() {
  const pane = $('#tab-integrations');
  const dot = pane && pane.querySelector('#waDot');
  if (!dot) return;

  dot.className = 'wa-dot' + (waUI.status === 'connected' ? ' on' : waUI.status === 'qr' ? ' qr' : '');
  pane.querySelector('#waStatText').textContent = WA_STATUS_TEXT[waUI.status] || waUI.status;

  const qrWrap = pane.querySelector('#waQr');
  if (waUI.status === 'qr' && waUI.qr) {
    qrWrap.hidden = false;
    pane.querySelector('#waQrImg').src = waUI.qr;
  } else {
    qrWrap.hidden = true;
  }

  const u = pane.querySelector('#waUser');
  u.hidden = !(waUI.status === 'connected' && waUI.user);
  u.textContent = waUI.user ? '👤 ' + waUI.user : '';
}

/* ---------------- integrations (Telegram — FEATURE 3) ---------------- */

const tgUI = { status: 'disconnected', user: null };
const TG_STATUS_TEXT = {
  disconnected: 'Bağlı değil',
  connecting: 'Bağlanıyor…',
  connected: 'Bağlı',
  error: 'Hata — tokenı kontrol et',
};

function onTgEvent(ev) {
  if (ev.type !== 'status') return;
  tgUI.status = ev.status;
  if (ev.user) tgUI.user = ev.user;
  updateTgPane();
}

function updateTgPane() {
  const pane = $('#tab-integrations');
  const dot = pane && pane.querySelector('#tgDot');
  if (!dot) return;
  dot.className = 'wa-dot' + (tgUI.status === 'connected' ? ' on' : tgUI.status === 'error' ? ' qr' : '');
  pane.querySelector('#tgStatText').textContent = TG_STATUS_TEXT[tgUI.status] || tgUI.status;
  const u = pane.querySelector('#tgUser');
  u.hidden = !(tgUI.status === 'connected' && tgUI.user);
  u.textContent = tgUI.user ? '🤖 ' + tgUI.user : '';
}

/* Telegram izin listesi — WA ile aynı mantık: isim zorunlu, kişi bazlı izin,
   bot eşleme. Chip × ile silinir; düzenlemek için silip yeniden ekle. */
async function renderTgAllow() {
  const wrap = $('#tgAllowChips');
  if (!wrap) return;
  const list = await beast.tgGetAllow();
  let botChoices = [];
  try { botChoices = (await beast.botsList()) || []; } catch {}
  const tgLabel = (e) => {
    if (e === '*') return '* herkes';
    if (typeof e === 'string') return e;
    const name = String((e && e.name) || '').trim();
    const id = String((e && e.id) || '');
    /* bağlı olduğu bot her koşulda etikette görünsün */
    const bot = e && e.bot_id ? botChoices.find((bb) => bb.id === e.bot_id) : null;
    return (name ? name + ' ' : '') + id + (bot ? ' → ' + bot.name : '');
  };
  wrap.innerHTML = '';
  if (!list.length) wrap.innerHTML = '<span class="sub">— boş —</span>';
  list.forEach((entry, idx) => {
    const curPerm = (typeof entry === 'object' && entry.perm) || (entry && entry.lockdown ? 'chat' : 'all');
    const c = document.createElement('span');
    c.className = 'chip';
    c.style.margin = '0 6px 6px 0';
    const txt = document.createElement('span');
    txt.className = 'chip-txt';
    txt.textContent = tgLabel(entry);
    c.appendChild(txt);
    if (entry !== '*') {
      /* kişi bazlı granül izin: serbest/web/okuma/kısıtlı (WA ile aynı) */
      const selP = document.createElement('select');
      selP.className = 'perm-select';
      selP.title = _t('wa_perm_title');
      const PERMS = [
        ['all', _t('wa_perm_all')],
        ['web', 'web'],
        ['read', _t('wa_perm_read')],
        ['chat', _t('wa_perm_chat')],
      ];
      for (const [v, lbl] of PERMS) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = lbl;
        if (curPerm === v) o.selected = true;
        selP.appendChild(o);
      }
      selP.addEventListener('change', async () => {
        const cur = await beast.tgGetAllow();
        const next = cur.map((e, i) => {
          if (i !== idx) return e;
          const base = typeof e === 'string' ? { id: e, name: '' } : { ...e };
          base.lockdown = selP.value === 'chat';
          base.perm = selP.value;
          return base;
        });
        await beast.tgSetAllow(next);
        renderTgAllow();
        toast(tgLabel(entry) + ': ' + selP.selectedOptions[0].textContent);
      });
      c.appendChild(selP);

      /* BOT SİSTEMİ: bağlı olduğu bot chip'te seçili gelir — buradan değiştirilebilir */
      if (botChoices.length) {
        const sel = document.createElement('select');
        sel.className = 'perm-select';
        sel.title = _t('bot_bind_title');
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = _t('bot_sel_empty');
        sel.appendChild(empty);
        for (const bb of botChoices) {
          const o = document.createElement('option');
          o.value = bb.id;
          o.textContent = `${bb.icon} ${bb.name}`;
          if ((typeof entry === 'object' && entry.bot_id) === bb.id) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener('change', async () => {
          const cur = await beast.tgGetAllow();
          const next = cur.map((e, i) => {
            if (i !== idx) return e;
            const base = typeof e === 'string' ? { id: e, name: '' } : { ...e };
            base.bot_id = sel.value || undefined;
            return base;
          });
          await beast.tgSetAllow(next);
          renderTgAllow();
          const bt = botChoices.find((bb) => bb.id === sel.value);
          toast(tgLabel(entry) + ' → ' + (bt ? bt.name : '?'));
        });
        c.appendChild(sel);
      }

      /* SAHİP rolü — yalnız biri olabilir (WA ile aynı): tıkla → sahiplik devret */
      const isOwnerEntry = typeof entry === 'object' && !!entry.owner;
      const ownerBtn = document.createElement('span');
      ownerBtn.className = 'lk';
      ownerBtn.style.cssText = 'font-size:11px;padding:1px 6px;' + (isOwnerEntry ? 'color:#c9a227;font-weight:800' : '');
      ownerBtn.title = isOwnerEntry ? _t('wa_owner_title_on') : _t('wa_owner_title_off');
      ownerBtn.textContent = isOwnerEntry ? _t('wa_owner_on') : _t('wa_owner_off');
      ownerBtn.addEventListener('click', async () => {
        if (isOwnerEntry) return; // sahibi tekrar tıklamayla alma; önce başkasına devret
        const cur = await beast.tgGetAllow();
        const next = cur.map((e, i) => {
          if (typeof e === 'object' && e && e.owner) return { ...e, owner: false };
          if (i === idx) {
            const obj = typeof e === 'string' ? { id: e, name: '' } : { ...e };
            obj.owner = true;
            return obj;
          }
          return e;
        });
        const tgt = next[idx];
        await beast.tgSetAllow(next);
        renderTgAllow();
        toast('Sahip: ' + tgLabel(tgt));
      });
      c.appendChild(ownerBtn);
    }
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('click', async () => {
      const next = (await beast.tgGetAllow()).filter((_v, i) => i !== idx);
      await beast.tgSetAllow(next);
      renderTgAllow();
      toast('Kaldırıldı: ' + tgLabel(entry));
    });
    c.appendChild(x);
    wrap.appendChild(c);
  });

  /* ekleme formu: isim + (ID veya @username) + bot seçici */
  const inp = $('#tgAllowIdInp');
  const nameInp = $('#tgAllowNameInp');
  const add = $('#tgAllowAdd');
  const botSel = $('#tgAllowBotSel');
  if (botSel) {
    const prev = botSel.value;
    botSel.innerHTML =
      `<option value="">${_t('bot_sel_empty')}</option>` +
      botChoices
        .map((bb) => `<option value="${bb.id}">${bb.icon} ${escapeHtml(bb.name)}${bb.admin ? ' (admin)' : ''}</option>`)
        .join('');
    if (prev) botSel.value = prev;
  }
  if (!add.dataset.bound) {
    add.dataset.bound = '1';
    const addEntry = async () => {
      let v = inp.value.trim();
      if (!v) return;
      const name = nameInp.value.trim().slice(0, 40);
      if (!name) { toast('İsim zorunlu — kimin yazdığını bilmek için'); nameInp.focus(); return; }
      /* @username olduğu gibi; sayısal ID'den boşluk/nokta temizle */
      v = v.startsWith('@') ? '@' + v.slice(1).replace(/[^\w]/g, '') : v.replace(/[^\d]/g, '');
      if (!v) { toast(_t('it_tg_id_ph')); return; }
      const botId = botSel && botSel.value ? { bot_id: botSel.value } : {};
      const next = [...(await beast.tgGetAllow()), { id: v, name, ...botId }];
      /* İLK EKLENEN KİŞİ OTOMATİK SAHİP — listede sahip yoksa en eski kayıt atanır
         (sahiplik sonradan chip'teki 'sahip yap' butonundan devredilebilir) */
      if (!next.some((e) => e && typeof e === 'object' && e.owner)) {
        if (next.length && typeof next[0] === 'object') next[0].owner = true;
      }
      await beast.tgSetAllow(next);
      inp.value = '';
      nameInp.value = '';
      renderTgAllow();
      toast('Eklendi: ' + name);
    };
    add.addEventListener('click', addEntry);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addEntry(); } });
    nameInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addEntry(); } });
  }
}

/* ---------------- Discord izin listesi + durum — TG ile aynı mantık ---------------- */

const dcUI = { status: 'disconnected', user: null };
const DC_STATUS_TEXT = {
  disconnected: 'Bağlı değil',
  connecting: 'Bağlanıyor…',
  connected: 'Bağlı',
  error: 'Hata — tokenı kontrol et',
};

function onDcEvent(ev) {
  if (ev.type !== 'status') return;
  dcUI.status = ev.status;
  if (ev.user) dcUI.user = ev.user;
  updateDcPane();
}

function updateDcPane() {
  const pane = $('#tab-integrations');
  const dot = pane && pane.querySelector('#dcDot');
  if (!dot) return;
  dot.className = 'wa-dot' + (dcUI.status === 'connected' ? ' on' : dcUI.status === 'error' ? ' qr' : '');
  pane.querySelector('#dcStatText').textContent = DC_STATUS_TEXT[dcUI.status] || dcUI.status;
  const u = pane.querySelector('#dcUser');
  u.hidden = !(dcUI.status === 'connected' && dcUI.user);
  u.textContent = dcUI.user ? '🤖 ' + dcUI.user : '';
}

async function renderDcAllow() {
  const wrap = $('#dcAllowChips');
  if (!wrap) return;
  const list = await beast.dcGetAllow();
  let botChoices = [];
  try { botChoices = (await beast.botsList()) || []; } catch {}
  const dcLabel = (e) => {
    if (e === '*') return '* herkes';
    if (typeof e === 'string') return e;
    const name = String((e && e.name) || '').trim();
    const id = String((e && e.id) || '');
    const bot = e && e.bot_id ? botChoices.find((bb) => bb.id === e.bot_id) : null;
    return (name ? name + ' ' : '') + id + (bot ? ' → ' + bot.name : '');
  };
  wrap.innerHTML = '';
  if (!list.length) wrap.innerHTML = '<span class="sub">— boş —</span>';
  list.forEach((entry, idx) => {
    const curPerm = (typeof entry === 'object' && entry.perm) || (entry && entry.lockdown ? 'chat' : 'all');
    const c = document.createElement('span');
    c.className = 'chip';
    c.style.margin = '0 6px 6px 0';
    const txt = document.createElement('span');
    txt.className = 'chip-txt';
    txt.textContent = dcLabel(entry);
    c.appendChild(txt);
    if (entry !== '*') {
      const selP = document.createElement('select');
      selP.className = 'perm-select';
      selP.title = _t('wa_perm_title');
      const PERMS = [
        ['all', _t('wa_perm_all')],
        ['web', 'web'],
        ['read', _t('wa_perm_read')],
        ['chat', _t('wa_perm_chat')],
      ];
      for (const [v, lbl] of PERMS) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = lbl;
        if (curPerm === v) o.selected = true;
        selP.appendChild(o);
      }
      selP.addEventListener('change', async () => {
        const cur = await beast.dcGetAllow();
        const next = cur.map((e, i) => {
          if (i !== idx) return e;
          const base = typeof e === 'string' ? { id: e, name: '' } : { ...e };
          base.lockdown = selP.value === 'chat';
          base.perm = selP.value;
          return base;
        });
        await beast.dcSetAllow(next);
        renderDcAllow();
        toast(dcLabel(entry) + ': ' + selP.selectedOptions[0].textContent);
      });
      c.appendChild(selP);

      if (botChoices.length) {
        const sel = document.createElement('select');
        sel.className = 'perm-select';
        sel.title = _t('bot_bind_title');
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = _t('bot_sel_empty');
        sel.appendChild(empty);
        for (const bb of botChoices) {
          const o = document.createElement('option');
          o.value = bb.id;
          o.textContent = `${bb.icon} ${bb.name}`;
          if ((typeof entry === 'object' && entry.bot_id) === bb.id) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener('change', async () => {
          const cur = await beast.dcGetAllow();
          const next = cur.map((e, i) => {
            if (i !== idx) return e;
            const base = typeof e === 'string' ? { id: e, name: '' } : { ...e };
            base.bot_id = sel.value || undefined;
            return base;
          });
          await beast.dcSetAllow(next);
          renderDcAllow();
          const bt = botChoices.find((bb) => bb.id === sel.value);
          toast(dcLabel(entry) + ' → ' + (bt ? bt.name : '?'));
        });
        c.appendChild(sel);
      }

      const isOwnerEntry = typeof entry === 'object' && !!entry.owner;
      const ownerBtn = document.createElement('span');
      ownerBtn.className = 'lk';
      ownerBtn.style.cssText = 'font-size:11px;padding:1px 6px;' + (isOwnerEntry ? 'color:#c9a227;font-weight:800' : '');
      ownerBtn.title = isOwnerEntry ? _t('wa_owner_title_on') : _t('wa_owner_title_off');
      ownerBtn.textContent = isOwnerEntry ? _t('wa_owner_on') : _t('wa_owner_off');
      ownerBtn.addEventListener('click', async () => {
        if (isOwnerEntry) return;
        const cur = await beast.dcGetAllow();
        const next = cur.map((e, i) => {
          if (typeof e === 'object' && e && e.owner) return { ...e, owner: false };
          if (i === idx) {
            const obj = typeof e === 'string' ? { id: e, name: '' } : { ...e };
            obj.owner = true;
            return obj;
          }
          return e;
        });
        const tgt = next[idx];
        await beast.dcSetAllow(next);
        renderDcAllow();
        toast('Sahip: ' + dcLabel(tgt));
      });
      c.appendChild(ownerBtn);
    }
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('click', async () => {
      const next = (await beast.dcGetAllow()).filter((_v, i) => i !== idx);
      await beast.dcSetAllow(next);
      renderDcAllow();
      toast('Kaldırıldı: ' + dcLabel(entry));
    });
    c.appendChild(x);
    wrap.appendChild(c);
  });

  const inp = $('#dcAllowIdInp');
  const nameInp = $('#dcAllowNameInp');
  const add = $('#dcAllowAdd');
  const botSel = $('#dcAllowBotSel');
  if (botSel) {
    const prev = botSel.value;
    botSel.innerHTML =
      `<option value="">${_t('bot_sel_empty')}</option>` +
      botChoices
        .map((bb) => `<option value="${bb.id}">${bb.icon} ${escapeHtml(bb.name)}${bb.admin ? ' (admin)' : ''}</option>`)
        .join('');
    if (prev) botSel.value = prev;
  }
  if (!add.dataset.bound) {
    add.dataset.bound = '1';
    const addEntry = async () => {
      let v = inp.value.trim();
      if (!v) return;
      const name = nameInp.value.trim().slice(0, 40);
      if (!name) { toast('İsim zorunlu — kimin yazdığını bilmek için'); nameInp.focus(); return; }
      v = v.startsWith('@') ? '@' + v.slice(1).replace(/[^\w]/g, '') : v.replace(/[^\d]/g, '');
      if (!v) { toast(_t('it_dc_id_ph')); return; }
      const botId = botSel && botSel.value ? { bot_id: botSel.value } : {};
      const next = [...(await beast.dcGetAllow()), { id: v, name, ...botId }];
      if (!next.some((e) => e && typeof e === 'object' && e.owner)) {
        if (next.length && typeof next[0] === 'object') next[0].owner = true;
      }
      await beast.dcSetAllow(next);
      inp.value = '';
      nameInp.value = '';
      renderDcAllow();
      toast('Eklendi: ' + name);
    };
    add.addEventListener('click', addEntry);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addEntry(); } });
    nameInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addEntry(); } });
  }
}

/* ---------------- BOT SİSTEMİ (BÖLÜM 2-3-4) ----------------
   Sol panel altında bot kartları; her bot için sohbet geçmişi + sekmeli yönetim.
   İlk bot hep Beast (admin, silinemez). Max 5 bot. */

const BOT_ICONS = ['🦁', '🚀', '💎', '⭐', '🔥', '🧮', '📊', '🤖', '🦊', '🐼', '🎯', '🛠️'];
const BOT_SKILLS = [
  ['email', 'E-posta'],
  ['browser', 'Dahili tarayıcı'],
  ['web_search', 'Web arama'],
  ['run_command', 'Terminal/dosya'],
  ['memory', 'Kendi hafızası'],
  ['kb', 'Bilgi bankası'],
];
const BOT_PROMPT_TEMPLATES = [
  ['', 'bot_tpl_none'],
  ['Sen bir Muhasebe Botusun. Fatura, ödeme, borç-alacak ve tahsilat konularında yardımcı olursun. Cevaplarında tutar, tarih ve vade bilgisini net verirsin. Hassas finansal veriyi kimseyle paylaşmazsın.', 'bot_tpl_acc'],
  ['Sen bir Satış Botusun. Ürün fiyatı, kampanya, sipariş durumu sorularını yanıtlarsın; sıcak ve ikna edici ama abartısız bir dille konuşursun. Fiyat dışında indirim vaadi vermezsin.', 'bot_tpl_sales'],
  ['Sen bir Destek Botusun. Teknik sorunları adım adım çözersin; sabırlı, anlaşılır ve çözüm odaklısın. Çözemezsen sorunu kayıt altına alıp yönetime bildirirsin.', 'bot_tpl_support'],
  ['Sen bir Proje Yönetimi Botusun. Görev takibi, teslim tarihleri ve ekip koordinasyonu konusunda yardımcı olursun; kısa durum özetleri ve net aksiyonlar verirsin.', 'bot_tpl_pm'],
];

let botsCache = [];
let botPageId = null; // null = genel bakış (Tüm Botlar)
let botPageStats = [];
let activeBotId = 'beast'; // masaüstü UI'ının şu an hangi botta olduğu (varsayılan: ilk bot/Beast)

async function refreshBots() {
  try {
    botsCache = (await beast.botsList()) || [];
  } catch { botsCache = []; }
  try { botPageStats = (await beast.botsStats()) || []; } catch { botPageStats = []; }
  renderBotCards();
  /* BOT PICKER SENKRONU: liste her yenilendiğinde üstteki rozet de aktif bota
     ayarlanır — startup yarışında (liste boşken çizilen) eski rozet düzelir */
  updateBotChip();
  /* model picker da aktif botun kendi modelini göstersin */
  if (state) applyState();
  if (!$('#botOverlay').hidden) renderBotPage();
}

/* sol panel altındaki bot kartları */
function renderBotCards() {
  const wrap = $('#botList');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const b of botsCache) {
    const row = document.createElement('div');
    row.className = 'bot-card' + (b.id === activeBotId ? ' active' : '');
    row.title = _t('bot_switch_hint');
    row.innerHTML =
      `<span class="bot-ico">${b.icon || '🤖'}</span>` +
      `<span class="bot-nm">${escapeHtml(b.name)}</span>` +
      `<span class="bot-gear" title="${_t('bot_manage')}">⚙</span>` +
      `<span class="bot-tag">${b.admin ? 'ADMIN' : 'BOT'}</span>` +
      (b.code ? `<span class="bot-code" title="${_t('bot_code_title')}">${escapeHtml(b.code)}</span>` : '');
    /* tıkla → UI o bota geçer; ⚙ → yönetim sayfası */
    row.addEventListener('click', () => switchBot(b.id));
    row.querySelector('.bot-gear').addEventListener('click', (e) => {
      e.stopPropagation();
      openBotPage(b.id);
    });
    wrap.appendChild(row);
  }
}

/* üst bardaki aktif bot rozeti */
function updateBotChip() {
  const chip = $('#botChip');
  if (!chip) return;
  const b = botsCache.find((x) => x.id === activeBotId) || { icon: '🦁', name: 'Beast' };
  chip.textContent = (b.icon || '🤖') + ' ' + b.name;
}

/* BOTLAR ARASI GEÇİŞ: kart tıklaması SADECE aktif botu değiştirir —
   yönetim sayfası (Ayarlar/Memory/Log/Watcher/İstatistik) bot satırındaki ⚙
   butonundan veya üstteki bot rozetinden (botChip) açılır. */
async function switchBot(id) {
  const b = botsCache.find((x) => x.id === id);
  if (!b) return;
  if (id === activeBotId) return;
  /* UI hemen dönsün: rozet + kartlar IPC beklemeden aktif bota geçer */
  activeBotId = id;
  updateBotChip();
  renderBotCards();
  try {
    const r = await beast.botsActivate(id);
    /* main'inkiyle eşleş: normalizasyon ('beast' fallback) varsa düzelt */
    if (r && r.activeBotId && r.activeBotId !== activeBotId) {
      activeBotId = r.activeBotId;
      updateBotChip();
      renderBotCards();
    }
  } catch {}
  try { localStorage.setItem('beast.activeBot', id); } catch {}
  /* o botun en son oturumuna geç; hiç yoksa o bot için yeni sohbet aç */
  try {
    const list = (await beast.listSessions()).filter((s) => (s.botId || 'beast') === id);
    if (list.length) await openSession(list[0].id);
    else { const v = await beast.createSession(); await openSession(v.id); }
  } catch {}
  /* picker, aktif botun kendi modelini göstersin */
  applyState();
  toast((b.icon || '🤖') + ' ' + b.name + (b.admin ? '' : ' — ' + _t('bot_switched')));
}

function botOverlaySetOpen(open) {
  $('#botOverlay').hidden = !open;
  if (!open) botPageId = null;
}

async function openBotPage(id) {
  botPageId = id || null;
  $('#botOverlay').hidden = false;
  $('#botOverviewBack').hidden = !id; // bot sayfasındaysa "Tüm Botlar"a dönüş görünür
  document.querySelectorAll('.btab').forEach((b) => b.classList.toggle('active', id ? b.dataset.btab === 'settings' : false));
  await refreshBots();
  renderBotPage();
}

function renderBotPage() {
  const head = $('#botHead');
  const pane = $('#botPane');
  const chatsCol = $('#botChatsCol');
  const tabs = $('#botTabs');
  if (botPageId === '__add') {
    /* --- YENİ BOT ekleme formu (Electron'da prompt() çalışmadığı için sayfa) --- */
    head.querySelector('#botHeadIcon').textContent = '＋';
    head.querySelector('#botHeadName').textContent = _t('bot_add');
    $('#botHeadTag').textContent = '';
    chatsCol.style.display = 'none';
    tabs.style.display = 'none';
    renderBotAdd(pane);
    return;
  }
  chatsCol.style.display = '';
  tabs.style.display = '';
  if (!botPageId) {
    /* --- TÜM BOTLAR genel bakışı --- */
    head.querySelector('#botHeadIcon').textContent = '≡';
    head.querySelector('#botHeadName').textContent = _t('bot_overview');
    $('#botHeadTag').textContent = '';
    renderBotOverview(pane);
    return;
  }
  const b = botsCache.find((x) => x.id === botPageId);
  if (!b) { botPageId = null; renderBotPage(); return; }
  head.querySelector('#botHeadIcon').textContent = b.icon || '🤖';
  head.querySelector('#botHeadName').textContent = b.name;
  $('#botHeadTag').textContent = b.admin ? 'ADMIN' : 'BOT';
  /* DM Log sekmesi yalnız admin botta görünür — botlar arası tüm trafiği o izler */
  const dmTab = document.querySelector('.btab[data-btab="dmlog"]');
  if (dmTab) dmTab.hidden = !b.admin;
  const active = document.querySelector('.btab.active');
  const tab = active ? active.dataset.btab : 'settings';
  if (tab === 'settings') renderBotSettings(pane, b);
  else if (tab === 'memory') renderBotMemory(pane, b);
  else if (tab === 'log') renderBotLog(pane, b);
  else if (tab === 'watcher') renderBotWatcher(pane, b);
  else if (tab === 'stats') renderBotStats(pane, b);
  else if (tab === 'notes') renderBotNotes(pane, b);
  else if (tab === 'dmlog') renderBotDmLog(pane, b);
  renderBotChats(b);
}

/* --- DM Log sekmesi (yalnız admin): botlar arası TÜM özel mesaj trafiği.
    Botlar birbirini göremez; admin her çiftin konuşmasını burada okur. --- */
async function renderBotDmLog(pane, b) {
  pane.innerHTML = `<h2>Bot DM Log</h2><div class="sub">Botlar arası tüm özel mesaj trafiği — hangi bot kiminle, ne zaman, ne konuştu. Bu ekranı yalnız yönetici görür.</div>`;
  const list = await beast.botsDmList().catch(() => []);
  if (!list.length) {
    pane.insertAdjacentHTML('beforeend', '<p class="sub">Henüz botlar arası DM yok — admin botda bot_dm aracını kullanın.</p>');
    return;
  }
  for (const d of list) {
    const row = document.createElement('div');
    row.className = 'skill-row';
    row.innerHTML =
      `<div class="skill-name">${escapeHtml(d.aName)} (${escapeHtml(d.aCode)}) ⇄ ${escapeHtml(d.bName)} (${escapeHtml(d.bCode)})</div>` +
      `<div class="skill-desc">${d.count} mesaj · son: ${new Date(d.updatedAt).toLocaleString('tr-TR')}</div>` +
      `<button class="btn ghost" style="margin-top:6px;padding:3px 12px;font-size:12px">Dökümü aç/kapat</button>`;
    row.querySelector('button').addEventListener('click', async () => {
      const old = row.nextElementSibling;
      if (old && old.dataset && old.dataset.dmread === d.id) { old.remove(); return; }
      const r = await beast.botsDmRead(d.id).catch(() => ({ ok: false, error: 'ipc' }));
      const pre = document.createElement('pre');
      pre.dataset.dmread = d.id;
      pre.className = 'notes-body';
      pre.style.cssText = 'white-space:pre-wrap;max-height:340px;overflow:auto;margin-top:8px;border:1px solid var(--border);border-radius:8px;padding:10px';
      pre.textContent = r.ok
        ? r.messages.map((m) => `[${m.role === 'user' ? '→ hedef bot' : m.role === 'assistant' ? '← hedef bot' : m.role}] ${m.content}`).join('\n\n')
        : (r.error || 'okunamadı');
      row.after(pre);
    });
    pane.appendChild(row);
  }
}

/* --- Notlar sekmesi: oturum notları — konuşma kodu, başlık, tarih ve özet metni.
    Admin bot (beast) tüm oturumları görür; müşteri botu yalnız kendi oturumlarını. --- */
async function renderBotNotes(pane, b) {
  pane.innerHTML = `<h2>${_t('notes_h2')}</h2><div class="sub">${_t('notes_sub')}</div>`;
  let all = [];
  try { all = await beast.listNotes(); } catch {}
  const list = (b.admin ? all : all.filter((n) => (n.botId || 'beast') === b.id))
    .slice()
    .sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
  if (!list.length) {
    pane.insertAdjacentHTML('beforeend', `<div class="mini-empty">${_t('notes_empty')}</div>`);
    return;
  }
  const f = document.createElement('div');
  f.className = 'bot-form';
  for (const n of list) {
    const when = n.updatedAt ? new Date(n.updatedAt).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const card = document.createElement('div');
    card.className = 'notes-card';
    card.innerHTML =
      `<div class="notes-head"><div class="skill-name">${escapeHtml((b.icon || '') + ' ' + (n.code || '?'))} — ${escapeHtml(n.title || '')}</div>` +
      `<div class="notes-meta">${escapeHtml(when)} · ${n.count || 0} ${_t('bot_stat_msgs')}</div></div>` +
      `<div class="notes-body">${escapeHtml(String(n.notes || '').slice(0, 4000))}</div>` +
      `<div style="margin-top:8px"><button class="btn ghost notes-del">${_t('notes_del')}</button></div>`;
    card.querySelector('.notes-del').addEventListener('click', async () => {
      await beast.clearNotes(n.id).catch(() => {});
      toast(_t('deleted'));
      renderBotNotes(pane, b);
    });
    f.appendChild(card);
  }
  pane.appendChild(f);
}

function renderBotOverview(pane) {
  pane.innerHTML = `<h2>${_t('bot_overview')}</h2><div class="sub">${_t('bot_overview_sub')}</div>`;
  const totals = { numbers: 0, sessions: 0, msgs: 0 };
  for (const s of botPageStats) { totals.numbers += s.numbers || 0; totals.sessions += s.sessions || 0; totals.msgs += s.msgs || 0; }
  for (const b of botsCache) {
    const st = botPageStats.find((s) => s.id === b.id) || {};
    const row = document.createElement('div');
    row.className = 'bot-ov-row';
    row.innerHTML =
      `<span class="ico">${b.icon || '🤖'}</span>` +
      `<span class="nm">${escapeHtml(b.name)}${b.admin ? ' <span class="bot-tag">ADMIN</span>' : ''}</span>` +
      `<span class="m">${_t('bot_stat_numbers')}: ${st.numbers || 0}</span>` +
      `<span class="m">${_t('bot_stat_sessions')}: ${st.sessions || 0}</span>` +
      `<span class="m">${_t('bot_stat_msgs')}: ${st.msgs || 0}</span>`;
    row.addEventListener('click', () => openBotPage(b.id));
    pane.appendChild(row);
  }
  pane.insertAdjacentHTML('beforeend',
    `<div class="bot-ov-total"><span><b>${_t('bot_total')}</b></span><span>${_t('bot_stat_numbers')}: ${totals.numbers}</span><span>${_t('bot_stat_sessions')}: ${totals.sessions}</span><span>${_t('bot_stat_msgs')}: ${totals.msgs}</span></div>`);
}

/* --- sol yarı: o botun WhatsApp sohbetleri (salt-okunur admin görünümü) --- */
async function renderBotChats(b) {
  const list = $('#botChatList');
  const box = $('#botChatMsgs');
  box.innerHTML = '';
  let waSet = new Set();
  let tgSet = new Set();
  try { waSet = new Set(await beast.waListSessions()); } catch {}
  try { tgSet = new Set(await beast.tgListSessions()); } catch {}
  const sessions = [];
  try {
    for (const s of await beast.listSessions()) {
      if ((s.botId || 'beast') === b.id) sessions.push(s);
    }
  } catch {}
  sessions.sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
  list.innerHTML = '';
  if (!sessions.length) {
    list.innerHTML = `<div class="mini-empty">${_t('bot_no_chats')}</div>`;
    return;
  }
  let selected = null;
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'bot-chat-row';
    row.innerHTML =
      (waSet.has(s.id)
        ? '<span class="sess-wa" title="WhatsApp">W</span>'
        : tgSet.has(s.id)
          ? '<span class="sess-tg" title="Telegram">T</span>'
          : '<span class="sess-wa" style="opacity:.35">D</span>') +
      `<span class="bt">${escapeHtml(s.title || 'Yeni Sohbet')}</span>` +
      `<span class="sess-code">${escapeHtml(s.code || '')}</span>`;
    row.addEventListener('click', async () => {
      list.querySelectorAll('.bot-chat-row').forEach((r) => r.classList.remove('active'));
      row.classList.add('active');
      selected = s.id;
      try {
        const full = await beast.openSession(s.id);
        box.innerHTML = '';
        for (const m of full.messages || []) {
          if (m.role !== 'user' && m.role !== 'assistant') continue;
          if (m.tool_calls) continue;
          const div = document.createElement('div');
          div.className = 'bot-msg ' + (m.role === 'user' ? 'user' : 'asst');
          const who = m.role === 'user' ? _t('bot_msg_user') : b.name;
          const when = m.at ? new Date(m.at).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
          div.innerHTML = `<span class="who">${escapeHtml(who)}${when ? ' · ' + when : ''}</span>`;
          div.appendChild(document.createTextNode(typeof m.content === 'string' ? m.content.slice(0, 2000) : '(ek)'));
          box.appendChild(div);
        }
        box.scrollTop = box.scrollHeight;
      } catch {}
    });
    list.appendChild(row);
  }
}

/* --- Ayarlar sekmesi --- */
function renderBotSettings(pane, b) {
  pane.innerHTML = '';
  const f = document.createElement('div');
  f.className = 'bot-form';
  const iconBtns = BOT_ICONS.map((ic) => `<button type="button" data-ic="${ic}" class="${ic === b.icon ? 'on' : ''}">${ic}</button>`).join('');
  const otherBots = botsCache.filter((x) => x.id !== b.id);
  const seeChecks = otherBots
    .map((x) => `<label><input type="checkbox" data-see="${x.id}" ${((b.seeBots || []).includes(x.id)) ? 'checked' : ''}/> ${x.icon} ${escapeHtml(x.name)}</label>`)
    .join('') || `<span class="sub">${_t('bot_no_other')}</span>`;
  const skillChecks = BOT_SKILLS
    .map(([k, lbl]) => `<label><input type="checkbox" data-skill="${k}" ${(b.skills || {})[k] ? 'checked' : ''}/> ${lbl}</label>`)
    .join('');
  /* Yetki: 'all' tek başına tüm araçları verir (özel); web/read/chat çoklu seçilebilir */
  const PERM_OPTS = [['all', _t('wa_perm_all')], ['web', 'Web'], ['read', _t('wa_perm_read')], ['chat', _t('wa_perm_chat')]];
  const curPerms = Array.isArray(b.perm) ? b.perm : [b.perm || 'all'];
  const permChecks = PERM_OPTS
    .map(([k, lbl]) => `<label><input type="checkbox" data-perm="${k}" ${curPerms.includes(k) ? 'checked' : ''}/> ${lbl}</label>`)
    .join('');
  const numRows = (b.numbers || [])
    .map((n) => `<div class="bot-num-row" data-num="${n.num}"><span class="n">+${escapeHtml(n.num)}${n.name ? ' · ' + escapeHtml(n.name) : ''}</span><span class="x" title="${_t('bot_num_del')}">×</span></div>`)
    .join('');
  /* bot bazlı model seçenekleri: ana picker'daki listeyle aynı (state.models) */
  const modelOpts = ['<option value="">' + escapeHtml(_t('bot_model_global')) + '</option>']
    .concat(
      (state.models || []).map((m) => {
        const s = m.sel || (m.providerId || '') + '::' + (m.model || '');
        return `<option value="${escapeHtml(s)}" ${b.model === s ? 'selected' : ''}>${escapeHtml(m.providerName || m.providerId || '')} · ${escapeHtml(m.model || '')}</option>`;
      })
    )
    .join('');
  /* Numara ekleme KALDIRILDI — girişler yalnız Ayarlar → Entegrasyonlar (WhatsApp
     izin listesi) üzerinden yapılır. Bu bölüm salt-okunur bağlı-numara listesidir. */
  f.innerHTML = `
    <div class="form-grid">
      <div><label class="mem-label">${_t('bot_name')}</label><input id="bName" class="inp" value="${escapeHtml(b.name)}" maxlength="40"/></div>
      <div><label class="mem-label">${_t('bot_icon')}</label><div class="icon-pick" id="bIconPick">${iconBtns}</div></div>
    </div>
    <div class="sub" style="margin:2px 0 6px">BOT KODU: <b style="letter-spacing:2px">${escapeHtml(b.code || '—')}</b> — botlar arası DM adresi</div>
    <label class="mem-label">${_t('bot_prompt')}</label>
    <textarea id="bPrompt" class="mem-area" rows="5" placeholder="${_t('bot_prompt_ph')}">${escapeHtml(b.prompt || '')}</textarea>
    <div class="sub" style="margin-top:4px">${_t('bot_tpl_hint')}</div>
    <select id="bTpl" class="inp" style="margin-top:6px">${BOT_PROMPT_TEMPLATES.map((t, i) => `<option value="${i}">${escapeHtml(_t(t[1]))}</option>`).join('')}</select>
    <label class="mem-label">${_t('bot_numbers')}</label>
    <div id="bNums">${numRows || `<div class="sub">${_t('bot_no_numbers')}</div>`}</div>
    <div class="sub" style="margin-top:4px">${_t('bot_num_ro_hint')}</div>
    <label class="mem-label">${_t('bot_see')}</label>
    <div class="bot-checks" id="bSee">${seeChecks}</div>
    ${b.admin ? '' : `
    <label class="mem-label">${_t('bot_perm')}</label>
    <div class="bot-checks" id="bPerm">${permChecks}</div>
    <div class="sub" style="margin-top:4px">${_t('bot_perm_note')}</div>
    <label class="mem-label">${_t('bot_skills')}</label>
    <div class="bot-checks" id="bSkills">${skillChecks}</div>
    <label class="mem-label">${_t('bot_model')}</label>
    <select id="bModel" class="inp">${modelOpts}</select>
    <div class="sub" style="margin-top:4px">${_t('bot_model_note')}</div>`}
    <label class="mem-label">${_t('bot_browser')}</label>
    <div class="bot-checks" style="margin-bottom:6px">
      <label><input type="checkbox" id="bExtBrowser" ${b.extBrowser ? 'checked' : ''}/> ${_t('bot_ext_browser')}</label>
    </div>
    <div class="form-grid">
      <div>
        <label class="mem-label" style="margin-top:0">${_t('bot_def_browser')}</label>
        <select id="bBrDef" class="inp">
          <option value="dahili" ${b.browserDefault !== 'dis' ? 'selected' : ''}>${_t('bot_br_dahili')}</option>
          <option value="dis" ${b.browserDefault === 'dis' ? 'selected' : ''}>${_t('bot_br_dis')}</option>
        </select>
      </div>
      <div>
        <label class="mem-label" style="margin-top:0">${_t('bot_ext_cmd')}</label>
        <input id="bBrCmd" class="inp" value="${escapeHtml(b.extCommand || '')}" placeholder="chrome / msedge / firefox"/>
      </div>
    </div>
    <div class="sub" style="margin-top:6px">${_t('bot_browser_note')}</div>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button id="bSave" class="btn">${_t('bot_save')}</button>
      ${b.admin ? '' : `<button id="bDel" class="btn ghost">${_t('bot_delete')}</button>`}
    </div>`;
  pane.appendChild(f);

  f.querySelectorAll('#bIconPick button').forEach((btn) =>
    btn.addEventListener('click', () => {
      f.querySelectorAll('#bIconPick button').forEach((x) => x.classList.remove('on'));
      btn.classList.add('on');
    })
  );
  $('#bTpl').addEventListener('change', () => {
    const t = BOT_PROMPT_TEMPLATES[Number($('#bTpl').value) || 0];
    if (t && t[0]) { $('#bPrompt').value = t[0]; toast(_t('bot_tpl_applied')); }
  });
  f.querySelectorAll('#bNums .x').forEach((x) =>
    x.addEventListener('click', async () => {
      const num = x.parentElement.dataset.num;
      const cur = await beast.waGetAllow();
      await beast.waSetAllow(cur.filter((e) => e === '*' || !e || String(e.num) !== String(num)));
      toast(_t('bot_num_removed'));
      await refreshBots();
      const bb = botsCache.find((x2) => x2.id === b.id);
      if (bb) renderBotSettings(pane, bb);
    })
  );
  /* 'all' hariç diğer izinler çoklu seçilebilir; 'all' işaretlenince diğerleri kapanır */
  f.querySelectorAll('#bPerm input').forEach((c) =>
    c.addEventListener('change', () => {
      if (c.dataset.perm === 'all' && c.checked) {
        f.querySelectorAll('#bPerm input').forEach((x) => { if (x !== c) x.checked = false; });
      } else if (c.checked) {
        const all = f.querySelector('#bPerm input[data-perm="all"]');
        if (all) all.checked = false;
      }
      if (![...f.querySelectorAll('#bPerm input')].some((x) => x.checked)) c.checked = true; // en az biri seçili kalsın
    })
  );
  $('#bSave').addEventListener('click', async () => {
    const newName = $('#bName').value.trim();
    /* İLK HARF ZORUNLU: ad değiştirilirken de harf karakteriyle başlamalı */
    if (newName && !/^\p{L}/u.test(newName)) { toast(_t('bot_name_letter')); $('#bName').focus(); return; }
    const patch = {
      name: newName,
      icon: (f.querySelector('#bIconPick button.on') || {}).dataset?.ic || b.icon,
      prompt: $('#bPrompt').value,
      seeBots: [...f.querySelectorAll('#bSee input:checked')].map((c) => c.dataset.see),
      extBrowser: $('#bExtBrowser').checked,
      browserDefault: $('#bBrDef').value,
      extCommand: $('#bBrCmd').value.trim(),
      numbers: (b.numbers || []).map((n) => n.num),
    };
    if (!b.admin) {
      const selPerms = [...f.querySelectorAll('#bPerm input:checked')].map((c) => c.dataset.perm);
      patch.perm = selPerms.includes('all') ? 'all' : selPerms;
      const sk = {};
      f.querySelectorAll('#bSkills input').forEach((c) => { sk[c.dataset.skill] = c.checked; });
      patch.skills = sk;
      const bm = $('#bModel');
      if (bm) patch.model = bm.value;
    }
    const r = await beast.botsUpdate(b.id, patch);
    if (r.ok) { toast(_t('bot_saved')); await refreshBots(); renderBotPage(); }
    else toast(r.error || _t('bot_save_fail'));
  });
  const delBtn = $('#bDel');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm(_ti('bot_confirm_del', b.name))) return;
    const r = await beast.botsRemove(b.id);
    if (r.ok) {
      /* bot silme sonrası main otomatik restart atar — yeniden çizmeye kalkışma */
      toast(r.restarting ? _t('bot_deleted_restart') : _t('bot_deleted'));
      botPageId = null;
      if (!r.restarting) { await refreshBots(); renderBotPage(); }
    } else toast(r.error || _t('bot_save_fail'));
  });
  /* (numara ekleme alanı kaldırıldı — Entegrasyonlar üzerinden yapılır) */
}

/* --- Memory sekmesi: botun KENDİ hafızası — ayarlardaki SOUL/USER/MEMORY mantığı, bot izole.
   Beast (admin) için GLOBAL hafıza gösterilir: agent tam bu dosyalara yazıyor. --- */
async function renderBotMemory(pane, b) {
  const subKey = b.admin ? 'bot_mem_admin_sub' : 'bot_mem_sub';
  pane.innerHTML = `<h2>${_t('bot_tab_memory')}</h2><div class="sub">${_t(subKey)}</div>`;
  const f = document.createElement('div');
  f.className = 'bot-form';
  f.innerHTML = `
    <label class="mem-label">${_t('mem_soul')}</label><textarea id="bSoulTa" class="mem-area soul-area"></textarea>
    <label class="mem-label">${_t('mem_mem')}</label><textarea id="bMemTa" class="mem-area"></textarea>
    <label class="mem-label">${_t('mem_user')}</label><textarea id="bUserTa" class="mem-area"></textarea>
    <button id="bMemSave" class="btn" style="margin-top:8px">${_t('mem_save')}</button>`;
  pane.appendChild(f);
  try {
    const r = await beast.botsMemGet(b.id);
    $('#bSoulTa').value = (r && r.soul) || '';
    $('#bMemTa').value = (r && r.memory) || '';
    $('#bUserTa').value = (r && r.user) || '';
  } catch {}
  $('#bMemSave').addEventListener('click', async () => {
    await beast.botsMemSet(b.id, 'SOUL.md', $('#bSoulTa').value);
    await beast.botsMemSet(b.id, 'MEMORY.md', $('#bMemTa').value);
    await beast.botsMemSet(b.id, 'USER.md', $('#bUserTa').value);
    toast(_t('bot_mem_saved'));
  });
}

/* --- Log sekmesi: yetki/ayar değişiklik günlüğü --- */
async function renderBotLog(pane, b) {
  pane.innerHTML = `<h2>${_t('bot_tab_log')}</h2><div class="sub">${_t('bot_log_sub')}</div>`;
  let txt = '';
  try { txt = (await beast.botsLogGet(b.id)).content || ''; } catch {}
  pane.insertAdjacentHTML('beforeend', `<div class="bot-log">${escapeHtml(txt || '—')}</div>`);
}

/* --- Watcher sekmesi: bu botun oturumlarına bağlı izleyiciler --- */
async function renderBotWatcher(pane, b) {
  pane.innerHTML = `<h2>${_t('bot_tab_watcher')}</h2><div class="sub">${_t('bot_watcher_sub')}</div>`;
  let items = [];
  try { items = (await beast.watchersList()) || []; } catch {}
  let botSessions = new Set();
  try {
    for (const s of await beast.listSessions()) if ((s.botId || 'beast') === b.id) botSessions.add(s.id);
  } catch {}
  const mine = items.filter((w) => botSessions.has(w.sessionId));
  if (!mine.length) {
    pane.insertAdjacentHTML('beforeend', `<div class="mini-empty">${_t('bot_no_watchers')}</div>`);
    return;
  }
  for (const w of mine) {
    pane.insertAdjacentHTML('beforeend',
      `<div class="bot-ov-row" style="cursor:default"><span class="nm">${escapeHtml(w.name || w.id)}</span><span class="m">${escapeHtml(w.kind || '')} ${w.enabled ? '' : '· ' + _t('bot_paused')}</span></div>`);
  }
}

/* --- İstatistik sekmesi --- */
function renderBotStats(pane, b) {
  const st = botPageStats.find((s) => s.id === b.id) || {};
  pane.innerHTML = `<h2>${_t('bot_tab_stats')}</h2><div class="sub">${_t('bot_stats_sub')}</div>`;
  const when = st.lastAt ? new Date(st.lastAt).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  pane.insertAdjacentHTML('beforeend',
    `<div class="bot-stat-grid">
      <div class="bot-stat"><div class="v">${st.numbers || 0}</div><div class="k">${_t('bot_stat_numbers')}</div></div>
      <div class="bot-stat"><div class="v">${st.sessions || 0}</div><div class="k">${_t('bot_stat_sessions')}</div></div>
      <div class="bot-stat"><div class="v">${st.msgs || 0}</div><div class="k">${_t('bot_stat_msgs')}</div></div>
      <div class="bot-stat"><div class="v" style="font-size:13px;padding-top:6px">${when}</div><div class="k">${_t('bot_stat_last')}</div></div>
    </div>`);
}

/* --- Yeni Bot akışı: overlay içinde ekleme sayfası aç (prompt() Electron'ta çalışmaz) --- */
function botAddClick() {
  if (botsCache.length >= 5) { toast(_ti('bot_max_toast', 5)); return; }
  botPageId = '__add';
  $('#botOverlay').hidden = false;
  $('#botOverviewBack').hidden = false;
  document.querySelectorAll('.btab').forEach((b) => b.classList.remove('active'));
  refreshBots().then(() => renderBotPage());
}

/* --- Yeni Bot ekleme formu (overlay içinde — prompt() Electron'ta yok) --- */
function renderBotAdd(pane) {
  pane.innerHTML = '';
  const f = document.createElement('div');
  f.className = 'bot-form';
  const iconBtns = BOT_ICONS.map((ic, i) => `<button type="button" data-ic="${ic}" class="${i === 7 ? 'on' : ''}">${ic}</button>`).join('');
  f.innerHTML = `
    <label class="mem-label">${_t('bot_name')}</label>
    <input id="bAddName" class="inp" placeholder="${_t('bot_name_ph')}" maxlength="40"/>
    <label class="mem-label">${_t('bot_icon')}</label>
    <div class="icon-pick" id="bAddIconPick">${iconBtns}</div>
    <label class="mem-label">${_t('bot_prompt')}</label>
    <textarea id="bAddPrompt" class="mem-area" rows="6" placeholder="${_t('bot_prompt_ph')}"></textarea>
    <div class="sub" style="margin-top:4px">${_t('bot_tpl_hint')}</div>
    <select id="bAddTpl" class="inp" style="margin-top:6px">
      ${BOT_PROMPT_TEMPLATES.map((t, i) => `<option value="${i}">${escapeHtml(_t(t[1]))}</option>`).join('')}
    </select>
    <div class="sub" style="margin-top:10px">${_t('bot_add_note')}</div>
    <div style="display:flex;gap:8px;margin-top:14px;justify-content:center">
      <button id="bAddCreate" class="btn">${_t('bot_create')}</button>
      <button id="bAddCancel" class="btn ghost">${_t('bot_cancel')}</button>
    </div>`;
  pane.appendChild(f);

  f.querySelectorAll('#bAddIconPick button').forEach((btn) =>
    btn.addEventListener('click', () => {
      f.querySelectorAll('#bAddIconPick button').forEach((x) => x.classList.remove('on'));
      btn.classList.add('on');
    })
  );
  $('#bAddTpl').addEventListener('change', () => {
    const t = BOT_PROMPT_TEMPLATES[Number($('#bAddTpl').value) || 0];
    if (t && t[0]) { $('#bAddPrompt').value = t[0]; toast(_t('bot_tpl_applied')); }
  });
  $('#bAddCancel').addEventListener('click', () => openBotPage(null));
  $('#bAddCreate').addEventListener('click', async () => {
    const name = $('#bAddName').value.trim();
    if (!name) { toast(_t('bot_name_req')); $('#bAddName').focus(); return; }
    /* İLK HARF ZORUNLU: bot adı harf karakteriyle başlamalı */
    if (!/^\p{L}/u.test(name)) { toast(_t('bot_name_letter')); $('#bAddName').focus(); return; }
    const icon = (f.querySelector('#bAddIconPick button.on') || {}).dataset?.ic || '🤖';
    const r = await beast.botsAdd({ name, icon, prompt: $('#bAddPrompt').value });
    if (r.ok) {
      toast(_t('bot_created') + ' ' + r.bot.name);
      await refreshBots();
      openBotPage(r.bot.id);
    } else {
      toast(r.error || _t('bot_save_fail'));
    }
  });
}

/* ---------------- paralel ajanlar (#14 CEO) ---------------- */

const agentState = {
  jobs: [],
  autoOpened: false, // konsol bu turda otomatik açıldı mı (boştan-çalışıyor geçişi)
  last: new Map(), // bgSessionId -> son aktivite metni
  runningIds: new Set(),
  expanded: new Set(), // detayı açık kartlar
  chatOpen: new Set(), // sohbet dökümü açık rail satırları
  chatCache: new Map(), // bgSessionId -> son sohbet dökümü metni
  chatLoadedAt: new Map(), // bgSessionId -> son yükleme zamanı (throttle)
  tick: null,
};

function updateAgentIds() {
  agentState.runningIds = new Set(
    agentState.jobs.filter((j) => j.status === 'running').map((j) => j.id)
  );
}

let agentsRenderTimer = null;
function scheduleAgentsRender() {
  if (agentsRenderTimer) return;
  agentsRenderTimer = setTimeout(() => {
    agentsRenderTimer = null;
    renderAgentRail();
    if (setTab === 'agents') renderAgentsPane();
  }, 400);
}

async function refreshAgentsPane() {
  try { agentState.jobs = (await beast.agentsList()) || []; } catch {}
  /* açılışta ajanlar zaten çalışıyorsa konsolu otomatik aç */
  maybeAutoOpenRail();
  updateAgentIds();
  renderAgentsPane();
  renderAgentRail();
}

/* ajanlar çalışmaya başladığında sağdaki Paralel Ajan konsolu otomatik açılır
   (yalnız boştan-çalışıyor geçişinde; kullanıcı çalışırken elle kapatırsa ezilmez,
   dahili tarayıcı açıkken de karışılmaz) */
function maybeAutoOpenRail() {
  const hasRunning = agentState.jobs.some((j) => j.status === 'running');
  if (hasRunning && !agentState.autoOpened && document.body.classList.contains('rail-hidden') &&
      !document.body.classList.contains('browser-open')) {
    toggleRail(false);
    railPrefBeforeBrowser = true;
  }
  agentState.autoOpened = hasRunning;
}

function ingestAgentActivity(ev) {
  const id = ev.sessionId;
  let label = agentState.last.get(id) || '';
  if (ev.type === 'status') {
    if (ev.status && ev.status !== 'idle') label = String(ev.status);
  } else if (ev.type === 'tool-start') {
    label = _t('ag_tool_start') + ev.name + '…';
  } else if (ev.type === 'message' && ev.message && ev.message.role === 'assistant') {
    const txt = typeof ev.message.content === 'string' ? ev.message.content : '';
    if (txt.trim()) label = txt.replace(/\s+/g, ' ').slice(0, 160);
  } else if (ev.type === 'token') {
    label = ((label || '') + ev.delta).replace(/\s+/g, ' ').slice(-160);
  }
  agentState.last.set(id, label);
  scheduleAgentsRender();
}

function agStText(s) {
  return ({ running: _t('ag_st_running'), queued: _t('ag_st_queued'), done: _t('ag_st_done'), error: _t('ag_st_error'), aborted: _t('ag_st_aborted') })[s] || s;
}

function fmtAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  return s >= 60 ? Math.floor(s / 60) + 'dk' : s + 'sn';
}

/* canlı süre sayacı: 0:43 · 2:05 · 1:02:15 biçimi (koşan ajan kartlarında) */
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

/* koşan ajanların ⏱ sayaçları — saniyede bir yalnızca sayaç span'leri güncellenir
   (tüm rail yeniden çizilmez). Koşan kart kalmayınca interval kapanır. */
let agentTimerInt = null;
function ensureAgentTimers() {
  const any = !!document.querySelector('.agent-timer[data-start]');
  if (any && !agentTimerInt) {
    agentTimerInt = setInterval(() => {
      document.querySelectorAll('.agent-timer[data-start]').forEach((el) => {
        const t0 = Date.parse(el.dataset.start || '');
        if (t0) el.textContent = fmtElapsed(Date.now() - t0);
      });
    }, 1000);
  } else if (!any && agentTimerInt) {
    clearInterval(agentTimerInt);
    agentTimerInt = null;
  }
}
function agentTimerHtml(startedAt) {
  const t0 = Date.parse(startedAt || '');
  const val = t0 ? fmtElapsed(Date.now() - t0) : '0:00';
  return `<span class="agent-timer" data-start="${escapeHtml(startedAt || '')}">⏱ ${val}</span>`;
}

/* sağ panel — paralel ajanların arka plan işleri */
function renderAgentRail() {
  const list = els.railList;
  if (!list) return;
  const jobs = [...agentState.jobs].sort((a, b) => {
    const ra = a.status === 'running' ? 0 : 1;
    const rb = b.status === 'running' ? 0 : 1;
    return ra - rb || new Date(b.startedAt || 0) - new Date(a.startedAt || 0);
  });
  list.innerHTML = '';
  if (!jobs.length) {
    const e = document.createElement('div');
    e.className = 'rail-empty';
    e.textContent = _t('ag_empty');
    list.appendChild(e);
    return;
  }
  for (const j of jobs) {
    const open = agentState.expanded.has(j.id);
    const row = document.createElement('div');
    row.className = 'rj st-' + j.status + (open ? ' open' : '');
    row.dataset.jobId = j.id;
    const when = j.startedAt
      ? new Date(j.startedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
      : '';
    row.innerHTML =
      `<div class="rj-head">` +
      `<span class="ag-dot"></span>` +
      `<span class="sess-title">${escapeHtml(j.title)}</span>` +
      (j.code ? `<span class="sess-code" title="Oturum kodu">${escapeHtml(j.code)}</span>` : ``) +
       `<span class="rj-time">${j.status === 'running' ? when + ' · ' + agentTimerHtml(j.startedAt) + ' · ' + _t('ag_working') : (agStText(j.status) === _t('ag_st_done') ? '\u2713' : (agStText(j.status) || j.status) + (j.status === 'aborted' && j.error ? ' — ' + escapeHtml(String(j.error).slice(0, 70)) : ''))}</span>` +
       (j.status === 'running'
         ? `<button class="rj-cancel" title="${_t('ag_cancel')}">×</button>`
         : `<button class="rj-cancel" title="${_t('ag_delete')}"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg></button>`) +
      `</div>` +
      (j.status === 'running' && agentState.last.get(j.id)
        ? `<div class="rj-last" title="${escapeHtml(agentState.last.get(j.id))}">${escapeHtml(agentState.last.get(j.id))}</div>`
        : '') +
      (open
        ? `<div class="rj-body">` +
          `<div>${escapeHtml(String(j.task || '').slice(0, 400))}</div>` +
          (j.error ? `<div class="ag-err">${escapeHtml(j.error)}</div>` : '') +
          `<pre class="rj-chat" ${agentState.chatOpen.has(j.id) ? '' : 'hidden'}></pre>` +
          `</div>`
        : '');
    row.addEventListener('click', async (e) => {
      if (e.target.closest('.rj-cancel')) return;
      if (open) {
        agentState.expanded.delete(j.id);
        agentState.chatOpen.delete(j.id);
      } else {
        agentState.expanded.add(j.id);
        agentState.chatOpen.add(j.id);
      }
      renderAgentRail();
      if (!open) await loadRailChat(j.id);
    });
    const cancelBtn = row.querySelector('.rj-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (j.status === 'running') {
        await beast.agentsCancel(j.id);
        refreshAgentsPane();
      } else {
        await beast.deleteSession(j.id);
        agentState.expanded.delete(j.id);
        agentState.chatOpen.delete(j.id);
        agentState.chatCache.delete(j.id);
        refreshAgentsPane();
      }
    });
    list.appendChild(row);
    /* açık sohbet dökümünü re-render sonrası GERİ GETİR (kapanma bug'ının fix'i) */
    if (open && agentState.chatOpen.has(j.id)) maybeLoadRailChat(j.id);
  }
  ensureAgentTimers();
}

/* re-render storm'da IPC fırtınası olmasın: döküm 2 sn'de bir tazelenir */
function maybeLoadRailChat(id) {
  const cached = agentState.chatCache.get(id);
  const last = agentState.chatLoadedAt.get(id) || 0;
  if (cached != null && Date.now() - last < 2000) {
    const pre = els.railList.querySelector(`.rj[data-job-id="${CSS.escape(id)}"] .rj-chat`);
    if (pre) {
      pre.textContent = cached;
      pre.hidden = false;
      pre.scrollTop = pre.scrollHeight;
    }
    return;
  }
  loadRailChat(id);
}

/* sağ panelde ajan sohbetinin TAM dökümü */
async function loadRailChat(id) {
  agentState.chatLoadedAt.set(id, Date.now());
  try {
    const s = await beast.openSession(id);
    const lines = [];
    for (const m of s.messages || []) {
      if (m.role === 'user') lines.push('GÖREV: ' + (typeof m.content === 'string' ? m.content : '(ek)'));
      else if (m.role === 'assistant') {
        if (m.tool_calls && m.tool_calls.length) {
          lines.push('ARAÇ → ' + m.tool_calls.map((t) => (t.function && t.function.name) || '?').join(', '));
        }
        if (m.content) lines.push('AJAN: ' + m.content);
      } else if (m.role === 'tool') {
        lines.push('  ↳ ' + String(m.content || '').replace(/\s+/g, ' ').slice(0, 200));
      }
    }
    const text = lines.join('\n\n').slice(-12000) || '(boş)';
    agentState.chatCache.set(id, text);
    const pre = els.railList.querySelector(`.rj[data-job-id="${CSS.escape(id)}"] .rj-chat`);
    if (!pre) return;
    pre.textContent = text;
    pre.hidden = false;
    pre.scrollTop = pre.scrollHeight;
  } catch {
    const pre = els.railList.querySelector(`.rj[data-job-id="${CSS.escape(id)}"] .rj-chat`);
    if (!pre) return;
    pre.hidden = false;
    pre.textContent = '(sohbet okunamadı)';
  }
}

function renderAgentsPane() {
  const pane = $('#tab-agents');
  if (!pane) return;
  pane.innerHTML =
    '<h2>' + _t('ag_h2') + '</h2>' +
    '<div class="sub">' + _t('ag_sub') + '</div>' +
    '<div class="agent-ceo-row"><label><input type="checkbox" id="ceoChk" /> ' + _t('ag_ceo_label') + '</label></div>' +
    '<div id="agentList"></div>';
  beast.getCeoMode().then((v) => {
    const chk = $('#ceoChk');
    if (chk) chk.checked = !!v;
  });
  $('#ceoChk').addEventListener('change', async (e) => {
    await beast.setCeoMode(e.target.checked);
    toast(e.target.checked ? _t('ag_ceo_on') : _t('ag_ceo_off'));
  });

  const list = $('#agentList');
  const running = agentState.jobs.filter((j) => j.status === 'running').length;
  list.insertAdjacentHTML('beforeend',
    `<div class="sub" style="margin-top:-6px">${agentState.jobs.length
      ? `${running} ${_t('ag_working')} · ${agentState.jobs.length} ${_t('ag_records')}`
      : _t('ag_no_jobs')}</div>`);

  for (const j of agentState.jobs) {
    const card = document.createElement('div');
    card.className = 'agent-card st-' + j.status;
    const when = j.startedAt
      ? new Date(j.startedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
      : '';
    card.innerHTML =
      `<div class="ag-head">` +
      `<span class="ag-dot"></span>` +
      `<span class="ag-title">${escapeHtml(j.title)}</span>` +
       `<span class="ag-st" title="${j.error ? escapeHtml(String(j.error)) : ''}">${agStText(j.status) || j.status}</span>` +
      `<span class="ag-time">${when}${j.status === 'running' ? ' · ' + agentTimerHtml(j.startedAt) : j.endedAt ? ` · ${fmtAgo(j.endedAt)}` : ''}</span>` +
      (j.status === 'running'
         ? `<button class="ag-btn cancel" title="${_t('ag_cancel')}">${_t('ag_cancel')}</button>`
         : ``) +
      `</div>` +
      `<div class="ag-task">${escapeHtml(String(j.task || '').slice(0, 220))}</div>` +
      (j.error ? `<div class="ag-err">${escapeHtml(j.error)}</div>` : '') +
      (j.status === 'running' && agentState.last.get(j.id)
        ? `<div class="ag-last">${escapeHtml(agentState.last.get(j.id))}</div>`
        : '') +
       (j.status !== 'running'
         ? `<button class="ag-btn detail">${_t('ag_detail')} ${agentState.expanded.has(j.id) ? _t('ag_hide') : _t('ag_show')}</button>`
         : `<button class="ag-btn detail live">${_t('ag_live')}</button>`) +
      `<pre class="ag-log" ${agentState.expanded.has(j.id) ? '' : 'hidden'}></pre>`;
    const cancelBtn = card.querySelector('.ag-btn.cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', async () => {
      await beast.agentsCancel(j.id);
      refreshAgentsPane();
    });
    const detailBtn = card.querySelector('.ag-btn.detail');
    const preEl = card.querySelector('.ag-log');
    if (detailBtn) detailBtn.addEventListener('click', async () => {
      const open = !preEl.hidden;
      preEl.hidden = open;
      if (open) agentState.expanded.delete(j.id);
      else agentState.expanded.add(j.id);
      detailBtn.textContent = _t('ag_detail') + ' ' + (open ? _t('ag_show') : _t('ag_hide'));
      if (!open) {
        try {
          const d = await beast.agentsDetail(j.id);
          preEl.textContent = (d.ok ? d.messages.join('\n') : d.error) || '(boş)';
          preEl.scrollTop = preEl.scrollHeight;
        } catch { preEl.textContent = '(detay alınamadı)'; }
      }
    });
    list.appendChild(card);
  }

  /* canlı süre sayacı — saniyede bir yalnız ⏱ sayaç span'leri güncellenir */
  ensureAgentTimers();
}

/* ---------------- events from engine ---------------- */

function onEvent(ev) {
  if (ev.type === 'sessions') { refreshSessions(); return; }
  if (ev.type === 'approval') {
    /* Beast Code oturumunun onayı: panelde ipucu + kart sohbete düşer */
    if (bcSessionId && ev.sessionId === bcSessionId) {
      showApprovalCard(ev);
      bcLine('t-dim', '⏳ onay bekleniyor: ' + (ev.tool || '?') + ' — IDE modundan çıkıp sohbetteki kartı onayla');
      return;
    }
    if (ev.sessionId && ev.sessionId !== activeId) return;
    showApprovalCard(ev);
    return;
  }
  if (ev.type === 'update') {
    if (ev.downloaded) toast(_t('up_downloaded') + ' (v' + (ev.version || '?') + ') — /update now');
    else if (ev.available && ev.version && ev.version !== ev.current) toast(_t('up_available') + ' (v' + ev.version + ')');
    if (!els.settingsOverlay.hidden && setTab === 'update') renderUpdatePane();
    return;
  }
  if (ev.type === 'agents') {
    agentState.jobs = ev.jobs || [];
    maybeAutoOpenRail();
    updateAgentIds();
    scheduleAgentsRender();
    return;
  }
  /* OFFLINE MESAJ KUYRUĞU: bağlantı + kuyruk olayları (sessionId filtresinden önce) */
  if (ev.type === 'net' || ev.type === 'netQueue') { onNetEvent(ev); return; }
  /* Obscura kurulum ilerlemesi — ayarlardan çıkıp dönülsen de main'de sürer */
  if (ev.type === 'obscura-progress') { onObscuraProgress(ev); return; }
  /* Beast Code oturumu (IDE modu ortasındaki panel): olayları panele akıt,
     ana sohbeti kirletme */
  if (bcSessionId && ev.sessionId === bcSessionId) {
    bcIngest(ev);
    return;
  }

  if (ev.sessionId && ev.sessionId !== activeId) {
    /* paralel ajan canlı akışı: sohbeti kirletme, sekmede göster */
    if (agentState.runningIds.has(ev.sessionId)) {
      ingestAgentActivity(ev);
      return;
    }
    if (ev.type === 'done' || ev.type === 'error') refreshSessions();
    return;
  }

  switch (ev.type) {
    case 'clear':
      /* /clear gerçek silme — ekran da sıfırlanır */
      els.msgs.innerHTML = '';
      streamEl = null;
      streamRaw = '';
      closeChatToolGroup();
      showEmpty(true);
      refreshSessions();
      break;
    case 'modelChanged':
      /* /change ile model değişince üstteki picker otomatik güncellenir */
      beast.getState().then((s) => { state = s; applyState(); }).catch(() => {});
      break;
    case 'message':
      if (ev.message.role === 'user') addUserBubble(ev.message.content);
      else if (ev.message.role === 'assistant') {
        finalizeAssistant(ev.message.content);
        /* tool_calls'lı iş turu grupları açık tutar; saf metin (normal cevap) kapatır */
        const hasTools = Array.isArray(ev.message.tool_calls) && ev.message.tool_calls.length > 0;
        if (!hasTools) closeChatToolGroup();
      }
      break;
    case 'token':
      ensureStreamBubble();
      streamRaw += ev.delta;
      if (!renderQueued) { renderQueued = true; setTimeout(renderStream, 50); }
      break;
    case 'tool-start':
      addToolCard(ev.callId, ev.name, ev.args);
      setStatus(ev.name + '…');
      termAgentEvent(ev);
      break;
    case 'tool-end':
      finishToolCard(ev.callId, ev.ok, ev.result);
      setStatus('düşünüyor…');
      termAgentEvent(ev);
      break;
    case 'todos':
      renderTodos(ev.todos);
      break;
    case 'cron':
      if (setTab === 'cron') renderCronList(ev.jobs || []);
      if (els.cronOverlay && !els.cronOverlay.hidden) renderCronModal();
      break;
    case 'file':
      addFileCard(ev);
      break;
    case 'browser': {
      /* visible=false → ajan tarayıcıyı GİZLİ kullanıyor: UI yer açmaz */
      const shown = !!ev.open && ev.visible !== false;
      const wasShown = document.body.classList.contains('browser-open');
      document.body.classList.toggle('browser-open', shown);
      if (shown && ev.width) document.body.style.setProperty('--bw', ev.width + 'px');
      els.browserBar.hidden = !shown;
      els.bbResize.hidden = !shown;
      /* terminal de sağ dock'u kullanır — tarayıcı açılınca yerini bırak */
      if (shown && termOpen) termSetOpen(false);
      /* #19 tarayıcı açılınca paralel ajan konsolu (sağ panel) yerini bırakır;
         kapanınca önceki durumuna döner — istenirse railBtn ile elle açılır.
         GİZLİ ajan gezinmeleri (shown=false, wasShown=false) rail'e DOKUNMAZ —
         aksi halde paralel ajan konsolu kendi kendine kapanırdı */
      if (shown) {
        railPrefBeforeBrowser = !document.body.classList.contains('rail-hidden');
        toggleRail(true);
      } else if (wasShown) {
        toggleRail(!railPrefBeforeBrowser);
      }
      /* IDE modunda tarayıcı açılır/kapanır/genişlik değişirse row yeniden bölünür —
         editör + Beast Code ORTAK kırpılıp ORTAK açılır (kullanıcı payı korunur) */
      if (ideModeOn()) ideSplitApplyFrac();
      if (shown) {
        els.browserBtn.classList.add('on');
        if (ev.url && document.activeElement !== els.bbUrl) {
          els.bbUrl.value = ev.url.startsWith('https://duckduckgo.com/?q=') ? decodeURIComponent(ev.url.split('q=')[1] || '') : ev.url;
        }
      } else {
        els.browserBtn.classList.remove('on');
      }
      break;
    }
    case 'status':
      if (!busy) break;
      setStatus(ev.status === 'idle' ? (busy ? 'düşünüyor…' : '') : ev.status === 'thinking' ? 'düşünüyor…' : ev.status + '…');
      break;
    case 'term-out':
      termLine(ev.stream === 'err' ? 't-err' : 't-out', ev.chunk, false);
      break;
    case 'term-end':
      termCmdDone(ev);
      break;
    case 'think':
      if (state) state.thinkLevel = ev.level;
      applyState();
      break;
    case 'done':
      closeChatToolGroup();
      /* iptal/durdurma sebebini SOHBETE yaz — sebepsiz durdurma yok */
      if (ev.aborted) addStopNote(ev.reason);
      setBusy(false);
      setStatus(''); /* son durum balonu ("düşünüyor…" vb.) yapışmasın */
      /* cevabın SONU görünsün: markdown son render sonrası iki kez en alta kilitle */
      scrollDown(true);
      setTimeout(() => scrollDown(true), 80);
      setTimeout(() => scrollDown(true), 260);
      refreshSessions();
      els.input.focus();
      break;
    case 'error':
      closeChatToolGroup();
      setBusy(false);
      setStatus('');
      addErrorBubble(ev.error);
      refreshSessions();
      break;
  }
}

/* #26 ajanın gönderdiği dosya kartı (send_file) */
function addFileCard(ev) {
  if (ev.sessionId && ev.sessionId !== activeId) return;
  showEmpty(false);
  const wrap = document.createElement('div');
  wrap.className = 'file-card';
  wrap.innerHTML =
    `<div class="fc-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></div>` +
    `<div class="fc-main">` +
    `<div class="fc-name">${escapeHtml(ev.name || 'dosya')}</div>` +
    (ev.caption ? `<div class="fc-cap">${escapeHtml(ev.caption)}</div>` : '') +
    `</div>`;
  const btns = document.createElement('div');
  btns.className = 'fc-btns';
  const open = document.createElement('button');
  open.className = 'mr-btn';
  open.textContent = 'Aç';
  open.addEventListener('click', () => beast.openPath(ev.path));
  const folder = document.createElement('button');
  folder.className = 'mr-btn';
  folder.textContent = 'Klasör';
  folder.addEventListener('click', () => beast.showItemInFolder(ev.path));
  btns.append(open, folder);
  wrap.appendChild(btns);
  els.msgs.appendChild(wrap);
  scrollDown(true);
}

/* ---------------- terminal paneli (sağ dock) ---------------- */

let termOpen = false;
let termBannerDone = false;
let termRunning = false;
let termHist = [];
let termHistIdx = -1;
let termShell = 'cmd';
const TERM_MAX_LINES = 800;

/* terminal kabuğu: yalnız CMD (PowerShell/Git Bash kaldırıldı) */
const TERM_SHELLS = {
  cmd: { label: 'CMD', prompt: 'CMD>' },
};

function termSetShell(s) {
  if (!TERM_SHELLS[s]) s = 'cmd';
  const changed = termShell !== s;
  termShell = s;
  if (els.termPrompt) els.termPrompt.textContent = TERM_SHELLS[s].prompt;
  if (els.termCBtn) els.termCBtn.classList.toggle('on', termOpen && s === 'cmd');
  if (changed && termOpen && termBannerDone) termLine('t-sys', 'Kabuk: ' + TERM_SHELLS[s].label);
}

function termSetWidth(w) {
  document.body.style.setProperty('--tw', Math.round(w) + 'px');
  try { localStorage.setItem('beast.termW', String(Math.round(w))); } catch {}
}

function termSetOpen(v) {
  termOpen = !!v;
  els.termPanel.hidden = !v;
  els.termResize.hidden = !v;
  document.body.classList.toggle('term-open', v);
  termSetShell(termShell);
  if (v) {
    els.termInput.focus();
    termScroll(true);
  }
}

function termScroll(force) {
  const b = els.termBody;
  const near = b.scrollHeight - b.scrollTop - b.clientHeight < 140;
  if (force || near) b.scrollTop = b.scrollHeight;
}

function termLine(cls, text, time = true) {
  const el = document.createElement('div');
  el.className = 't-line ' + (cls || '');
  const ts = time ? '<span class="t-time">' + new Date().toTimeString().slice(0, 8) + '</span> ' : '';
  el.innerHTML = ts + escapeHtml(String(text ?? ''));
  els.termOut.appendChild(el);
  while (els.termOut.childElementCount > TERM_MAX_LINES) els.termOut.removeChild(els.termOut.firstChild);
  termScroll();
}

function termBanner(cwd) {
  if (termBannerDone) return;
  termBannerDone = true;
  els.termCwd.textContent = cwd || '';
  els.termCwd.title = cwd || '';
  termLine('t-sys', 'Beast Terminal — çalışma klasörü: ' + (cwd || '?'));
  termLine('t-sys', 'Kabuk: ' + TERM_SHELLS[termShell].label + ' · Ajanlar çalışırken araç çağrıları ve çıktıları burada canlı akar.', false);
  termLine('t-dim', 'Komut yaz, Enter\'a bas — her komut workspace\'te ayrı süreçle çalışır. Kabuk: CMD.', false);
}

function termShortTool(name, args) {
  const a = args || {};
  if (a.command) return String(a.command).slice(0, 300);
  try {
    const s = JSON.stringify(a);
    return s === '{}' ? '' : (s.length > 300 ? s.slice(0, 300) + '…' : s);
  } catch { return ''; }
}

/* ajan araç etkinliğini terminale akıt (tüm oturumlar: ana sohbet + paralel ajanlar + cron) */
function termAgentEvent(ev) {
  if (ev.type === 'tool-start') {
    const sid = ev.sessionId ? '[' + String(ev.sessionId).slice(-4) + '] ' : '';
    const args = termShortTool(ev.name, ev.args);
    termLine('t-agent', sid + '▸ ' + ev.name + (args ? ': ' + args : ''));
  } else if (ev.type === 'tool-end') {
    const shellish = /bash|shell|powershell|cmd|command|script|terminal/i.test(String(ev.name || ''));
    const out = String(ev.result || '').replace(/\s+$/, '');
    const cap = shellish ? 1600 : 240;
    if (out) termLine(ev.ok ? 't-out' : 't-err', out.length > cap ? out.slice(0, cap) + ' …(kesildi)' : out, false);
    else if (!ev.ok) termLine('t-err', '(hata)', false);
  }
}

function termCmdDone(ev) {
  termRunning = false;
  els.termStop.hidden = true;
  if (ev.error) termLine('t-err', '[hata] ' + ev.error, false);
  else termLine('t-dim', '(çıkış kodu: ' + ev.code + ')' + (ev.code ? ' — başarısız' : ''), false);
}

async function termToggle(shell) {
  const want = TERM_SHELLS[shell] ? shell : 'cmd';
  /* aynı kabuk butonuna tekrar basıldıysa paneli kapat */
  if (termOpen && termShell === want) {
    termSetOpen(false);
    return;
  }
  const needBanner = !termOpen;
  let cwd = null;
  if (!termOpen) {
    try {
      const r = await beast.terminalToggle();
      if (r && r.cwd) cwd = r.cwd;
    } catch {}
  }
  termSetShell(want);
  if (needBanner) termBanner(cwd);
  termSetOpen(true);
}

function termRunCurrent() {
  const cmd = els.termInput.value.trim();
  if (!cmd) return;
  if (termRunning) { toast('Komut sürüyor — önce ■ ile durdur'); return; }
  els.termInput.value = '';
  termHist.push(cmd);
  if (termHist.length > 100) termHist.shift();
  termHistIdx = termHist.length;
  termLine('t-cmd', TERM_SHELLS[termShell].prompt + ' ' + cmd);
  termRunning = true;
  els.termStop.hidden = false;
  beast.terminalRun(cmd, termShell).then((r) => {
    if (!r || !r.ok) {
      termRunning = false;
      els.termStop.hidden = true;
      termLine('t-err', (r && r.error) || 'çalıştırılamadı');
    }
  }).catch((e) => {
    termRunning = false;
    els.termStop.hidden = true;
    termLine('t-err', String((e && e.message) || e));
  });
}

/* ---------------- #22 izleyici/cron mini modalları ---------------- */

function fmtEvery(w) {
  if (w.everySec) return w.everySec < 60 ? `${w.everySec} sn` : `${Math.round(w.everySec / 60)} dk`;
  return `${w.everyMin || 15} dk`;
}

function opText(w) {
  if (w.op === 'changed') return 'değişim';
  const sym = { lt: '<', lte: '\u2264', gt: '>', gte: '\u2265', eq: '=', neq: '\u2260' }[w.op] || w.op;
  return `${sym} ${w.value ?? '?'}`;
}

async function renderWatchersModal() {
  let rows = [];
  try { rows = (await beast.watchersList()) || []; } catch {}
  els.watchList.innerHTML = '';
  if (!rows.length) {
    els.watchList.innerHTML = '<div class="mini-empty">' + _t('w_empty') + '</div>';
    return;
  }
  for (const w of rows) {
    const row = document.createElement('div');
    row.className = 'mini-row' + (w.enabled ? '' : ' off');
    const target = w.kind === 'battery' ? 'pil yüzdesi' : (w.path ? w.path : (w.re ? '/' + w.re + '/' : w.url));
    row.innerHTML =
      `<span class="mr-dot"></span>` +
      `<div class="mr-main">` +
      `<div class="mr-name">${escapeHtml(w.name)}</div>` +
      `<div class="mr-meta">[${w.kind}] ${escapeHtml(String(target).slice(0, 60))} · <b>${opText(w)}</b> · her <b>${fmtEvery(w)}</b> · cd ${w.cooldownMin}dk` +
      (w.lastValue !== null && w.lastValue !== undefined ? ` · son: <b>${escapeHtml(String(w.lastValue).slice(0, 20))}</b>` : '') +
      (w.lastError ? ` · <span style="color:var(--err)">${escapeHtml(w.lastError.slice(0, 40))}</span>` : '') +
      `</div></div>`;
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;flex:none';
    const t = document.createElement('button');
    t.className = 'mr-btn';
    t.textContent = w.enabled ? '❚❚' : '▶';
    t.title = w.enabled ? _t('cr_toggle_pause') : _t('cr_start');
    t.addEventListener('click', async () => { await beast.watchersToggle(w.id); renderWatchersModal(); });
    const d = document.createElement('button');
    d.className = 'mr-btn del';
    d.textContent = '×';
    d.title = _t('cr_del');
    d.addEventListener('click', async () => { await beast.watchersRemove(w.id); renderWatchersModal(); });
    btns.append(t, d);
    row.appendChild(btns);
    els.watchList.appendChild(row);
  }
}

async function renderCronModal() {
  let jobs = [];
  try { jobs = (await beast.cronList()) || []; } catch {}
  els.cronModalList.innerHTML = '';
  if (!jobs.length) {
    els.cronModalList.innerHTML = '<div class="mini-empty">' + _t('cr_modal_empty') + '</div>';
    return;
  }
  for (const j of jobs) {
    const row = document.createElement('div');
    row.className = 'mini-row' + (j.enabled ? '' : ' off');
    row.innerHTML =
      `<span class="mr-dot"></span>` +
      `<div class="mr-main">` +
      `<div class="mr-name">${escapeHtml(j.name || j.id)}</div>` +
      `<div class="mr-meta"><b>${escapeHtml(j.schedule)}</b> · ${escapeHtml(String(j.prompt || '').slice(0, 70))}</div>` +
      `</div>`;
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;flex:none';
    const run = document.createElement('button');
    run.className = 'mr-btn';
    run.textContent = '▶';
    run.title = _t('cr_run');
    run.addEventListener('click', async () => { await beast.cronRunNow(j.id); toast(_t('cr_ran')); });
    const t = document.createElement('button');
    t.className = 'mr-btn';
    t.textContent = j.enabled ? '❚❚' : '▶';
    t.title = j.enabled ? _t('cr_toggle_pause') : _t('cr_start');
    t.addEventListener('click', async () => { await beast.cronToggle(j.id); renderCronModal(); });
    const d = document.createElement('button');
    d.className = 'mr-btn del';
    d.textContent = '×';
    d.title = _t('cr_del');
    d.addEventListener('click', async () => { await beast.cronDelete(j.id); renderCronModal(); });
    btns.append(run, t, d);
    row.appendChild(btns);
    els.cronModalList.appendChild(row);
  }
}

function toggleMini(overlay, hide) {
  if (!overlay) return;
  overlay.hidden = !!hide;
}

async function openWatchModal() {
  toggleMini(els.watchOverlay, false);
  await renderWatchersModal();
}

async function openCronModal() {
  toggleMini(els.cronOverlay, false);
  await renderCronModal();
}

/* ---------------- state / controls ---------------- */

/* AKTİF BOTUN etkili model seçimi: müşteri botun kendi modeli varsa o,
   yoksa (ve admin bot daysa) global picker seçimi. */
function effectiveModelSel() {
  const b = botsCache.find((x) => x.id === activeBotId);
  return b && !b.admin && b.model ? b.model : (state.activeModel && state.activeModel.sel) || '';
}

function applyState() {
  if (!state) return;
  const botSel = activeBotId && botsCache.length ? effectiveModelSel() : (state.activeModel && state.activeModel.sel);
  const bm = botSel ? (state.models || []).find((x) => x.sel === botSel) : null;
  els.modelBtnLabel.textContent = bm
    ? `${bm.providerName} · ${bm.model}`
    : state.activeModel
      ? `${state.activeModel.providerName} · ${state.activeModel.model}`
      : 'Model seçilmedi';
  els.thinkBtnLabel.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v.55A3.5 3.5 0 0 0 4.5 8.5c0 .74.23 1.43.62 2A3.5 3.5 0 0 0 4 13.5 3.5 3.5 0 0 0 7 16.95v.55A2.5 2.5 0 0 0 9.5 20a2.5 2.5 0 0 0 2.5-2.5v-13A2.5 2.5 0 0 0 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 1 17 4.5v.55a3.5 3.5 0 0 1 2.5 3.45c0 .74-.23 1.43-.62 2a3.5 3.5 0 0 1-1.12 3 3.5 3.5 0 0 1-3 3.45v.55A2.5 2.5 0 0 1 14.5 20 2.5 2.5 0 0 1 12 17.5v-13A2.5 2.5 0 0 1 14.5 2z"/></svg>';
  renderModelMenu();
}

/* düşünme (reasoning) seviyesi picker — gerçek API değerleri */
const THINK_UI_LEVELS = [
  { v: 0, label: 'Kapalı', desc: 'param gönderilmez' },
  { v: 1, label: 'Low', desc: 'reasoning_effort: low' },
  { v: 2, label: 'Medium', desc: 'reasoning_effort: medium' },
  { v: 3, label: 'High', desc: 'reasoning_effort: high' },
  { v: 4, label: 'X-High', desc: 'reasoning_effort: xhigh' },
  { v: 5, label: 'Max', desc: 'reasoning_effort: max' },
];

function renderThinkMenu() {
  if (!els.thinkList || els.thinkMenu.hidden) return;
  const cur = state && Number.isFinite(state.thinkLevel) ? state.thinkLevel : 0;
  els.thinkList.innerHTML = '';
  for (const lv of THINK_UI_LEVELS) {
    const item = document.createElement('div');
    item.className = 'dd-item' + (cur === lv.v ? ' active' : '');
    item.innerHTML =
      `<span class="think-lv">` +
      `<span class="tv">${lv.v}</span>` +
      `<span class="tl">${escapeHtml(lv.label)}</span>` +
      `<span class="td">${escapeHtml(lv.desc)}</span>` +
      `</span>`;
    item.addEventListener('click', async () => {
      state = await beast.thinkSet(lv.v);
      els.thinkMenu.hidden = true;
      applyState();
      toast('Düşünme seviyesi: ' + lv.label);
    });
    els.thinkList.appendChild(item);
  }
}

function closeThinkMenu() {
  if (els.thinkMenu) els.thinkMenu.hidden = true;
}

/* dropdown model picker */
let visibleModels = null; // null = hepsi, [] = hiçbiri

function pickerModels() {
  const all = state.models || [];
  if (visibleModels === null) return all;
  return all.filter((m) => visibleModels.includes(m.sel));
}

function renderModelMenu() {
  if (els.modelMenu.hidden) return;
  const q = els.modelFilter.value.trim().toLowerCase();
  const list = pickerModels().filter(
    (m) => !q || m.providerName.toLowerCase().includes(q) || m.model.toLowerCase().includes(q)
  );
  els.modelList.innerHTML = '';
  for (const m of list) {
    const item = document.createElement('div');
    item.className = 'dd-item' + (effectiveModelSel() && effectiveModelSel() === m.sel ? ' active' : '');
    item.innerHTML =
      `<span class="dn">${escapeHtml(m.providerName)}</span>` +
      `<span class="dm">${escapeHtml(m.model)}</span>` +
      `<span class="ck">✓</span>`;
    item.addEventListener('click', async () => {
      state = await beast.setModel(m.sel);
      closeModelMenu();
      await refreshBots().catch(() => {}); // bot modeli değiştiyse botsCache tazelensin
      applyState();
    });
    els.modelList.appendChild(item);
  }
  if (!list.length) {
    els.modelList.innerHTML =
      '<div class="dd-empty">' +
      ((state.models || []).length ? 'Eşleşen model yok' : 'Model yok — yanındaki ⚙ ile seç') +
      '</div>';
  }
}

function openModelMenu() {
  els.modelMenu.hidden = false;
  els.modelFilter.value = '';
  renderModelMenu();
  setTimeout(() => els.modelFilter.focus(), 0);
}

function closeModelMenu() {
  els.modelMenu.hidden = true;
}

/* picker yapılandırma popover */
function renderCfgList() {
  if (!els.cfgList) return;
  const all = state.models || [];
  const vis = new Set(visibleModels === null ? all.map((m) => m.sel) : visibleModels);
  els.cfgList.innerHTML = '';
  for (const m of all) {
    const row = document.createElement('label');
    row.className = 'cfg-item';
    row.innerHTML =
      `<input type="checkbox" ${vis.has(m.sel) ? 'checked' : ''}>` +
      `<span class="cn">${escapeHtml(m.providerName)}</span>` +
      `<span class="cm">${escapeHtml(m.model)}</span>`;
    row.querySelector('input').addEventListener('change', (e) => {
      if (visibleModels === null) visibleModels = all.map((x) => x.sel);
      if (e.target.checked) visibleModels.push(m.sel);
      else visibleModels = visibleModels.filter((s) => s !== m.sel);
      beast.setVisibleModels([...visibleModels]);
      applyState();
    });
    els.cfgList.appendChild(row);
  }
  if (!all.length) els.cfgList.innerHTML = '<div class="dd-empty">Model yok</div>';
}

async function saveVisible(v) {
  visibleModels = v;
  await beast.setVisibleModels(visibleModels === null ? null : [...visibleModels]);
  renderCfgList();
  applyState();
}

async function sendCurrent() {
  const text = els.input.value.trim();
  if ((!text && !pending.length) || !activeId) return;
  /* #25 /clear artık main'e gider: oturum kayıtları GERÇEKTEN silinir
     (engine.clearMessages) ve 'clear' olayıyla ekran da temizlenir */
  if (text === '/screenshot') {
    els.input.value = '';
    captureScreenShot();
    return;
  }
  const atts = pending.slice();
  pending = [];
  renderChips();
  els.input.value = '';
  autosize();
  if (!busy) {
    setBusy(true);
  } else {
    /* agent çalışıyor — mesaj kuyruğa alınır, iş bitince otomatik gönderilir */
    setStatus('kuyruğa eklendi — iş bitince gider');
  }
  beast.send(activeId, { text, attachments: atts });
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 180) + 'px';
}

/* ---------------- slash komut menüsü (#15) ---------------- */

const SLASH_COMMANDS = [
  { cmd: '/help', desc: 'tüm komutları listele' },
  { cmd: '/version', desc: 'Beast Agent sürümünü göster' },
  { cmd: '/new', desc: 'yeni oturum aç (kod verilir)' },
  { cmd: '/open ', desc: 'koddaki oturuma geç' },
  { cmd: '/sessions', desc: 'bu sohbetin oturumları' },
  { cmd: '/stop', desc: 'çalışan tüm işleri durdur' },
  { cmd: '/restart', desc: 'uygulamayı yeniden başlat' },
  { cmd: '/change', desc: 'modelleri listele · /change 5 ile geç' },
  { cmd: '/screenshot', desc: 'ekran görüntüsünü sohbete ekle' },
  { cmd: '/notify', desc: 'hata maili aç/kapa · /notify on|off' },
  { cmd: '/think ', desc: 'düşünme seviyesi · /think 0-5 (0 kapalı)' },
  { cmd: '/clear', desc: 'oturum geçmişini GERÇEKTEN sil (kod korunur)' },
  { cmd: '/start', desc: 'durdurulan servisleri devam ettir' },
  { cmd: '/rule ', desc: 'kalıcı kural ekle' },
  { cmd: '/rules', desc: 'kalıcı kuralları listele' },
  { cmd: '/model', desc: 'modeli göster/değiştir' },
  { cmd: '/skills', desc: 'kurulu skill\u2019ler' },
  { cmd: '/usage', desc: 'bugünkü kullanım' },
  { cmd: '/backup', desc: 'veriyi zip\u2019e yedekle' },
  { cmd: '/status', desc: 'bağlantı ve servis durumu' },
];

let slashSel = 0;

function hideSlashMenu() {
  if (!els.slashMenu) return;
  els.slashMenu.hidden = true;
  els.slashMenu.innerHTML = '';
}

function selectSlashItem(items, idx) {
  items.forEach((x, i) => x.classList.toggle('sel', i === idx));
  slashSel = idx;
}

function applySlashPick(cmd) {
  hideSlashMenu();
  els.input.value = cmd;
  els.input.focus();
  const L = els.input.value.length;
  els.input.setSelectionRange(L, L);
}

/* input'un başında "/" varsa filtreli komut listesini göster */
function updateSlashMenu() {
  if (!els.slashMenu) return;
  const v = String(els.input.value || '');
  if (!v.startsWith('/') || v.includes('\n')) {
    hideSlashMenu();
    return;
  }
  const q = v.slice(1).toLowerCase();
  const matches = SLASH_COMMANDS.filter(
    (c) => !q || c.cmd.trim().toLowerCase().slice(1).startsWith(q) || c.desc.toLowerCase().includes(q)
  );
  if (!matches.length) {
    hideSlashMenu();
    return;
  }
  slashSel = 0;
  els.slashMenu.innerHTML =
    '<div class="sub" style="padding:4px 10px">Hazır komutlar — Enter ile seç</div>' +
    matches
      .map(
        (c, i) =>
          `<div class="slash-item${i === 0 ? ' sel' : ''}" data-cmd="${escapeHtml(c.cmd)}">` +
          `<span class="s-cmd">${escapeHtml(c.cmd.trim())}</span>` +
          `<span class="s-desc">${escapeHtml(c.desc)}</span></div>`
      )
      .join('');
  els.slashMenu.hidden = false;
  for (const item of els.slashMenu.querySelectorAll('.slash-item')) {
    item.addEventListener('click', () => applySlashPick(item.dataset.cmd));
    item.addEventListener('mousemove', () => {
      const items = [...els.slashMenu.querySelectorAll('.slash-item')];
      selectSlashItem(items, items.indexOf(item));
    });
  }
}

/* ---------------- cron modülü ---------------- */

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function refreshCron() {
  const jobs = await beast.cronList();
  renderCronList(jobs);
}

function renderCronList(jobs) {
  els.cronList.innerHTML = '';
  if (!jobs.length) {
    const empty = document.createElement('div');
    empty.className = 'cron-empty';
    empty.textContent = _t('cr_empty');
    els.cronList.appendChild(empty);
    return;
  }
  for (const j of jobs) {
    const row = document.createElement('div');
    row.className = 'cron-job' + (j.enabled ? '' : ' off');
    const info = document.createElement('div');
    info.className = 'cj-main';
    const dot = document.createElement('span');
    dot.className = 'cj-dot';
    dot.title = j.enabled ? _t('cr_dot_on') : _t('cr_dot_off');
    const infoDiv = document.createElement('div');
    infoDiv.className = 'cj-info';
    const name = document.createElement('div');
    name.className = 'cj-name';
    name.textContent = j.name;
    const meta = document.createElement('div');
    meta.className = 'cj-meta';
    const code = document.createElement('code');
    code.textContent = j.schedule;
    meta.appendChild(code);
    meta.appendChild(document.createTextNode(
      ' · ' + _t('cr_next') + fmtTime(j.nextRunAt) + (j.lastRunAt ? _t('cr_last') + fmtTime(j.lastRunAt) : '')
    ));
    infoDiv.appendChild(name);
    infoDiv.appendChild(meta);
    info.appendChild(dot);
    info.appendChild(infoDiv);
    row.appendChild(info);
    const btns = document.createElement('div');
    btns.className = 'cj-btns';
    const mkBtn = (txt, title, fn) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    btns.appendChild(mkBtn('▶', _t('cr_run'), async () => { await beast.cronRunNow(j.id); refreshCron(); }));
    btns.appendChild(mkBtn(j.enabled ? '❚❚' : '▶', j.enabled ? _t('cr_pause') : _t('cr_start'), async () => { await beast.cronToggle(j.id); refreshCron(); }));
    btns.appendChild(mkBtn('×', _t('cr_del'), async () => { await beast.cronDelete(j.id); refreshCron(); }));
    row.appendChild(btns);
    dot.addEventListener('click', () => {
      els.cronName.value = j.name;
      els.cronPreset.value = '__custom';
      els.cronSchedule.value = j.schedule;
      els.cronPrompt.value = j.prompt;
    });
    els.cronList.appendChild(row);
  }
}

function openCron() { refreshCron(); }

/* ---------------- boot ---------------- */

async function init() {
  beast.onEvent(onEvent);
  toggleRail(true); /* Paralel Ajanlar paneli varsayılan KAPALI — railBtn ile açılır */

  state = await beast.getState();
  try {
    const s = await beast.getSettings();
    visibleModels = s.visibleModels === undefined ? null : s.visibleModels;
    if (s.theme === 'dark') {
      document.body.classList.add('dark');
      els.themeBtn.textContent = '\u2600\uFE0E';
      els.themeBtn.title = _t('tip_light');
    }
  } catch {}
  applyState();

  const sessions = await beast.listSessions();
  if (sessions.length) await openSession(sessions[0].id);
  else {
    const created = await beast.createSession();
    await openSession(created.id);
  }

  els.newChat.addEventListener('click', async () => {
    const created = await beast.createSession();
    await openSession(created.id);
    els.input.focus();
  });

  /* sağ panel — ayar/tema solda; burada yalnızca görev listesi */

  const syncThemeBtns = (dark) => {
    for (const b of [els.themeBtn]) {
      if (!b) continue;
      b.textContent = dark ? '\u2600\uFE0E' : '\u263E';
      b.title = dark ? _t('tip_light') : _t('tip_dark');
    }
  };

  const syncLangBtn = () => {
    if (!els.langBtn) return;
    els.langBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.6 2.6 15.4 0 18M12 3c-2.6 2.6-2.6 15.4 0 18"/></svg>';
  };

  refreshAgentsPane();

  els.sendBtn.addEventListener('click', sendCurrent);
  els.stopBtn.addEventListener('click', () => activeId && beast.interrupt(activeId));

  els.input.addEventListener('keydown', (e) => {
    if (!els.slashMenu.hidden) {
      const items = [...els.slashMenu.querySelectorAll('.slash-item')];
      const selIdx = items.findIndex((x) => x.classList.contains('sel'));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (items.length) selectSlashItem(items, (selIdx + 1) % items.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (items.length) selectSlashItem(items, (selIdx - 1 + items.length) % items.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (items.length) items[Math.max(0, selIdx)].click();
        return;
      }
      if (e.key === 'Escape') {
        hideSlashMenu();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrent(); }
  });

  els.input.addEventListener('input', () => updateSlashMenu());
  els.input.addEventListener('input', autosize);

  els.modelBtn.addEventListener('click', () => {
    els.modelMenu.hidden ? openModelMenu() : closeModelMenu();
  });
  if (els.thinkBtn) {
    els.thinkBtn.addEventListener('click', () => {
      if (els.thinkMenu.hidden) {
        els.thinkMenu.hidden = false;
        renderThinkMenu();
      } else {
        els.thinkMenu.hidden = true;
      }
    });
  }
  els.modelFilter.addEventListener('input', renderModelMenu);
  els.modelFilter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = els.modelList.querySelector('.dd-item');
      if (first) first.click();
    }
  });
  document.addEventListener('click', (e) => {
    if (!els.modelDD.contains(e.target)) closeModelMenu();
    if (els.thinkDD && !els.thinkDD.contains(e.target)) closeThinkMenu();
    if (!els.pickCfg.contains(e.target)) els.pickCfgMenu.hidden = true;
  });

  els.pickCfgBtn.addEventListener('click', () => {
    if (els.pickCfgMenu.hidden) {
      els.pickCfgMenu.hidden = false;
      renderCfgList();
    } else {
      els.pickCfgMenu.hidden = true;
    }
  });
  els.cfgAll.addEventListener('click', () => saveVisible(null));
  els.cfgNone.addEventListener('click', () => saveVisible([]));

  if (els.modelRefreshBtn) {
    els.modelRefreshBtn.addEventListener('click', async () => {
      els.modelRefreshBtn.classList.add('spin');
      try {
        state = await beast.refreshModels();
        applyState();
        toast(_t('mr_done'));
      } catch {
        toast(_t('ws_fail_toast'));
      } finally {
        els.modelRefreshBtn.classList.remove('spin');
      }
    });
  }

  els.themeBtn.addEventListener('click', async () => {
    const dark = document.body.classList.toggle('dark');
    syncThemeBtns(dark);
    await beast.setTheme(dark ? 'dark' : 'light');
  });

  if (els.langBtn) {
    syncLangBtn();
    els.langBtn.addEventListener('click', () => {
      const next = (window.I18N && window.I18N.lang) === 'en' ? 'tr' : 'en';
      window.I18N.setLang(next);
      syncLangBtn();
    });
    document.addEventListener('langchange', syncLangBtn);
    document.addEventListener('langchange', renderActiveSettingsTab);
    /* Whisper STT dili arayüz dilini izler (WA sesli notları da) */
    const syncSttLang = () => { try { beast.sttLangSet((window.I18N && window.I18N.lang) || 'tr'); } catch {} };
    syncSttLang();
    document.addEventListener('langchange', syncSttLang);
  }

  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    addFiles([...els.fileInput.files]);
    els.fileInput.value = '';
  });

  /* ---- Sesli komut (yerel Whisper): kayıt → yazıya çevir → input'a koy ---- */
  if (els.micBtn) {
    let micRec = null;
    let micChunks = [];
    let micStream = null;
    const blobToDataUrl = (b) =>
      new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(b);
      });
    els.micBtn.addEventListener('click', async () => {
      if (micRec && micRec.state === 'recording') {
        micRec.stop();
        return;
      }
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        toast(_t('mic_denied'));
        return;
      }
      micChunks = [];
      micRec = new MediaRecorder(micStream);
      micRec.ondataavailable = (e) => { if (e.data && e.data.size) micChunks.push(e.data); };
      micRec.onstop = async () => {
        try { micStream.getTracks().forEach((t) => t.stop()); } catch {}
        els.micBtn.classList.remove('rec');
        const blob = new Blob(micChunks, { type: micRec.mimeType || 'audio/webm' });
        if (!blob.size) return;
        toast(_t('mic_transcribing'));
        const b64 = await blobToDataUrl(blob);
        /* arayüz dili = Whisper dili: TR ise Türkçe, EN ise İngilizce algılar */
        const uiLang = (window.I18N && window.I18N.lang) || 'tr';
        const r = await beast.sttTranscribe(b64, uiLang).catch(() => ({ ok: false, error: 'ipc' }));
        if (r && r.ok && r.text) {
          els.input.value = (els.input.value ? els.input.value.replace(/\s+$/, '') + ' ' : '') + r.text;
          els.input.focus();
          els.input.dispatchEvent(new Event('input'));
        } else {
          toast(_t('mic_fail'));
        }
      };
      micRec.start();
      els.micBtn.classList.add('rec');
      toast(_t('mic_listening'));
    });
  }

  beast.onWaEvent(onWaEvent);
  beast.onTgEvent(onTgEvent);
  beast.onDcEvent(onDcEvent);

  els.gearBtn.addEventListener('click', openSettings);
  els.setClose.addEventListener('click', closeSettings);
  if (els.bcCopy) {
    els.bcCopy.addEventListener('click', async () => {
      const code = (els.beastCode && els.beastCode.textContent) || '';
      if (!code || code === '—') return;
      try {
        await navigator.clipboard.writeText(code);
        toast(_t('bc_copied'));
      } catch {}
    });
  }

  /* dahili tarayıcı çubuğu */
  els.browserBtn.addEventListener('click', () => beast.toggleBrowser());
  if (els.eyeBtn) {
    beast.browserShownGet().then((r) => els.eyeBtn.classList.toggle('on', !!(r && r.shown))).catch(() => {});
    els.eyeBtn.addEventListener('click', async () => {
      const next = !els.eyeBtn.classList.contains('on');
      try {
        const r = await beast.browserShownSet(next);
        els.eyeBtn.classList.toggle('on', !!(r && r.shown));
        toast(r && r.shown ? 'Tarayıcı GÖRÜNÜR — ajan aramaları panelde izlenir' : 'Tarayıcı GİZLİ — ajan arka planda çalışır');
      } catch {}
    });
  }
  if (els.railBtn) els.railBtn.addEventListener('click', () => {
    toggleRail(!document.body.classList.contains('rail-hidden'));
    railPrefBeforeBrowser = !document.body.classList.contains('rail-hidden');
  });
  els.bbBack.addEventListener('click', () => beast.browserCtrl('back'));
  els.bbFwd.addEventListener('click', () => beast.browserCtrl('forward'));
  els.bbReload.addEventListener('click', () => beast.browserCtrl('reload'));
  els.bbClose.addEventListener('click', () => {
    document.body.classList.remove('browser-open');
    els.browserBar.hidden = true;
    els.bbResize.hidden = true;
    els.browserBtn.classList.remove('on');
    beast.browserCtrl('close');
  });
  els.bbOpenExt.addEventListener('click', () => {
    const u = els.bbUrl.value.trim();
    if (/^https?:\/\//i.test(u)) beast.openExternal(u);
  });
  els.bbShot.addEventListener('click', async () => {
    try {
      setStatus('ekran görüntüsü alınıyor…');
      const r = await beast.browserScreenshot();
      setStatus('');
      if (r && r.ok) {
        pending.push({
          type: 'image',
          name: 'screenshot-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.jpg',
          dataUrl: r.image,
        });
        renderChips();
        scrollDown();
        toast('Görüntü eklendi — mesajına iliştirilecek');
      } else {
        toast((r && r.error) || 'Ekran görüntüsü alınamadı');
      }
    } catch (e) {
      setStatus('');
      toast(String((e && e.message) || e));
    }
  });
  els.bbUrl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const v = els.bbUrl.value.trim();
      if (v) { els.bbUrl.blur(); beast.browserNavigate(v); }
    }
  });

  /* sürükle-boyutlandır */
  let rz = null;
  let rzLastSent = 0;
  const bwNow = () => parseInt(getComputedStyle(document.body).getPropertyValue('--bw')) || 480;
  const bwSet = (w) => document.body.style.setProperty('--bw', Math.round(w) + 'px');
  els.bbResize.addEventListener('mousedown', (e) => {
    e.preventDefault();
    rz = { sx: e.clientX, sw: bwNow() };
    document.body.classList.add('bb-dragging');
    beast.browserSetIgnoreMouse(true);
  });

  /* cron modülü — olay bağlama */
  if (els.watchBtn) els.watchBtn.addEventListener('click', openWatchModal);
  if (els.cronBtn) els.cronBtn.addEventListener('click', openCronModal);
  if (els.watchClose) els.watchClose.addEventListener('click', () => toggleMini(els.watchOverlay, true));
  if (els.cronClose) els.cronClose.addEventListener('click', () => toggleMini(els.cronOverlay, true));
  if (els.watchOverlay) els.watchOverlay.addEventListener('click', (e) => {
    if (e.target === els.watchOverlay) toggleMini(els.watchOverlay, true);
  });
  if (els.cronOverlay) els.cronOverlay.addEventListener('click', (e) => {
    if (e.target === els.cronOverlay) toggleMini(els.cronOverlay, true);
  });
  els.cronPreset.addEventListener('change', () => {
    if (els.cronPreset.value !== '__custom') els.cronSchedule.value = els.cronPreset.value;
    else els.cronSchedule.focus();
  });
  els.cronAddBtn.addEventListener('click', async () => {
    const name = els.cronName.value.trim();
    const schedule = els.cronSchedule.value.trim();
    const prompt = els.cronPrompt.value.trim();
    if (!schedule || !prompt) { toast('Cron ifadesi ve görev metni gerekli'); return; }
    const r = await beast.cronAdd({ name, schedule, prompt });
    if (!r.ok) { toast(r.error || 'Eklenemedi'); return; }
    els.cronName.value = ''; els.cronSchedule.value = ''; els.cronPrompt.value = '';
    toast('Görev eklendi');
    refreshCron();
  });
  document.addEventListener('mousemove', (e) => {
    if (!rz) return;
    const w = Math.max(300, Math.min(rz.sw - (e.clientX - rz.sx), window.innerWidth - 340));
    bwSet(w);
    const now = Date.now();
    if (now - rzLastSent > 80) { rzLastSent = now; beast.browserSetWidth(w); }
  });
  document.addEventListener('mouseup', () => {
    if (!rz) return;
    rz = null;
    document.body.classList.remove('bb-dragging');
    beast.browserSetWidth(bwNow());
    beast.browserSetIgnoreMouse(false);
  });

  /* terminal paneli — olay bağlama */
  try { termSetWidth(parseInt(localStorage.getItem('beast.termW')) || 520); } catch {}
  if (els.termCBtn) els.termCBtn.addEventListener('click', () => termToggle('cmd'));
  if (els.termClose) els.termClose.addEventListener('click', () => termSetOpen(false));
  if (els.termClear) els.termClear.addEventListener('click', () => { els.termOut.innerHTML = ''; });
  if (els.termStop) els.termStop.addEventListener('click', () => beast.terminalStop().catch(() => {}));
  if (els.termInput) els.termInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      termRunCurrent();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (termHist.length) {
        termHistIdx = Math.max(0, termHistIdx - 1);
        els.termInput.value = termHist[termHistIdx] || '';
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (termHist.length) {
        termHistIdx = Math.min(termHist.length, termHistIdx + 1);
        els.termInput.value = termHist[termHistIdx] || '';
      }
    }
  });
  /* terminal sürükle-boyutlandır */
  let trz = null;
  const twNow = () => parseInt(getComputedStyle(document.body).getPropertyValue('--tw')) || 520;
  if (els.termResize) els.termResize.addEventListener('mousedown', (e) => {
    e.preventDefault();
    trz = { sx: e.clientX, sw: twNow() };
    document.body.classList.add('term-dragging');
  });
  document.addEventListener('mousemove', (e) => {
    if (!trz) return;
    const w = Math.max(340, Math.min(trz.sw - (e.clientX - trz.sx), window.innerWidth - 340));
    termSetWidth(w);
  });
  document.addEventListener('mouseup', () => {
    if (!trz) return;
    trz = null;
    document.body.classList.remove('term-dragging');
  });

  els.settingsOverlay.addEventListener('click', (e) => {
    if (e.target === els.settingsOverlay) closeSettings();
  });
  document.querySelectorAll('#setTabs .tab').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab))
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('#botOverlay') && !$('#botOverlay').hidden) { botOverlaySetOpen(false); return; }
      if (els.watchOverlay && !els.watchOverlay.hidden) { toggleMini(els.watchOverlay, true); return; }
      if (els.cronOverlay && !els.cronOverlay.hidden) { toggleMini(els.cronOverlay, true); return; }
      if (!els.settingsOverlay.hidden) closeSettings();
    }
    // Ctrl+Shift+S: ekran görüntüsü al → vision'a gönderilmek üzere ekle
    if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      captureScreenShot();
    }
  });

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-url]');
    if (a) { e.preventDefault(); beast.openExternal(a.dataset.url); }
  });

  /* BOT SİSTEMİ bağlama */
  if ($('#botAddBtn')) $('#botAddBtn').addEventListener('click', botAddClick);
  if ($('#botOverviewBtn')) $('#botOverviewBtn').addEventListener('click', () => openBotPage(null));
  if ($('#botClose')) $('#botClose').addEventListener('click', () => botOverlaySetOpen(false));
  if ($('#botOverviewBack')) $('#botOverviewBack').addEventListener('click', () => openBotPage(null));
  if ($('#botChip')) $('#botChip').addEventListener('click', () => openBotPage(activeBotId));
  /* kalıcı aktif bot: restart sonrası aynı botun UI'ı açılır */
  beast.botsActiveGet().then((r) => { activeBotId = (r && r.id) || 'beast'; updateBotChip(); renderBotCards(); applyState(); }).catch(() => {});
  document.querySelectorAll('.btab').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.btab').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      renderBotPage();
    })
  );
  $('#botOverlay').addEventListener('click', (e) => {
    if (e.target === $('#botOverlay')) botOverlaySetOpen(false);
  });
  refreshBots().catch(() => {});
  els.input.focus();
}

/* /screenshot + Ctrl+Shift+S: ekranı yakalayıp ek olarak sohbete ekler */
async function captureScreenShot() {
  try {
    toast('Ekran görüntüsü alınıyor…');
    const r = await beast.captureScreen();
    if (r && r.ok) {
      if (pending.length >= 6) { toast('En fazla 6 ek'); return; }
      pending.push({
        type: 'image',
        name: 'ekran-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.jpg',
        dataUrl: r.image,
      });
      renderChips();
      scrollDown();
      els.input.focus();
      toast('Ekran eklendi — sorunu yaz ve gönder');
    } else {
      toast((r && r.error) || 'Ekran görüntüsü alınamadı');
    }
  } catch (err) {
    toast(String((err && err.message) || err));
  }
}

init();

/* ================= SKILLS STORE =================
   Sol alt buton → %70 modal · 3 sekme (Trending / Stars / Upload).
   Trending: kurulum+beğeni hareketi / yaş (yükselenler).
   Stars: uzun süre popülerler (14+ gün yaş, tüm zaman toplamı).
   Upload: kimlik (benzersiz kullanıcı adı + avatar) + KARE kapak resmi (zorunlu,
   otomatik kırpma) + SKILL.md içeren klasör. Yüklemeler yerel listelenir. */

const storeState = {
  tab: 'trending',
  entries: [],
  installed: new Set(),
  beastId: '',
  identity: { username: '', avatar: '' },
  editIdentity: false, // kayıtlı ad varken "Değiştir" ile açılır
  picked: null,      // store:pick önizlemesi
  pendingImage: '',  // kare kırpılmış dataURL
  offline: false,
};

function storeAgeDays(iso) {
  const t = new Date(iso || 0).getTime();
  return Number.isFinite(t) ? Math.max(0, (Date.now() - t) / 86400000) : 0;
}

function storeTrendingScore(e) {
  const heat = (e.installs || 0) + (e.likes || 0) * 2;
  return heat / Math.pow(1 + storeAgeDays(e.updatedAt || e.createdAt), 0.5);
}

function storeStarsScore(e) {
  const total = (e.installs || 0) + (e.likes || 0) * 3;
  return storeAgeDays(e.createdAt) >= 14 ? total : total * 0.2;
}

async function openStore() {
  $('#storeOverlay').hidden = false;
  storeState.tab = 'trending';
  document.querySelectorAll('.stab').forEach((b) => b.classList.toggle('active', b.dataset.stab === 'trending'));
  $('#storePane').innerHTML = `<div class="store-empty">…</div>`;
  await loadStore();
  renderStorePane();
}

async function loadStore() {
  try {
    const r = await beast.storeList();
    storeState.entries = (r && r.entries) || [];
    storeState.installed = new Set((r && r.installed) || []);
    storeState.beastId = (r && r.beastId) || '';
    storeState.identity = (r && r.identity) || { username: '', avatar: '' };
    storeState.offline = false;
  } catch {
    storeState.entries = [];
    storeState.offline = true;
  }
}

function closeStore() {
  $('#storeOverlay').hidden = true;
}

function storeCard(e, opts = {}) {
  const installed = storeState.installed.has(e.id);
  const hasUpdate = installed && e.updatedAt && e.installedAt && String(e.updatedAt) > String(e.installedAt);
  const img = e.image
    ? `<span class="store-avatar"><img src="${e.image}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:8px"/></span>`
    : `<span class="store-avatar">${e.author && e.author.avatar ? escapeHtml(e.author.avatar) : '🧩'}</span>`;
  const author = e.author || {};
  const btnLabel = !installed ? _t('store_install') : hasUpdate ? _t('store_update') : _t('store_installed');
  const btnDone = installed && !hasUpdate;
  return `
    <div class="store-card" data-id="${escapeHtml(e.id)}">
      <div class="store-card-top">
        ${img}
        <div style="min-width:0;flex:1">
          <div class="store-name" title="${escapeHtml(e.name)}">${escapeHtml(e.name)} <span class="store-ver">v${escapeHtml(e.version || '1.0.0')}</span></div>
          <div class="store-author">
            <span class="sa-avatar">${author.avatar ? escapeHtml(author.avatar) : '👤'}</span>
            <span class="sa-name">${escapeHtml(author.username || '—')}</span>
            ${author.beastId ? `<span class="sa-beast">${escapeHtml(author.beastId)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="store-desc">${escapeHtml(e.description || '')}</div>
      ${(e.tags || []).length ? `<div class="store-tags">${e.tags.map((t) => `<span class="store-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      <div class="store-card-foot">
        <span class="store-stats"><span>⬇ ${e.installs || 0} ${_t('store_installs')}</span><span>♥ ${e.likes || 0} ${_t('store_likes')}</span></span>
        <button class="store-like ${e.liked ? 'liked' : ''}" data-like="${escapeHtml(e.id)}">♥</button>
        <button class="store-install ${btnDone ? 'done' : ''}" data-install="${escapeHtml(e.id)}">${btnLabel}</button>
      </div>
    </div>`;
}

function bindStoreCardActions(pane) {
  pane.querySelectorAll('[data-install]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const id = btn.dataset.install;
      btn.disabled = true;
      const r = await beast.storeInstall(id).catch(() => null);
      if (r && r.ok) {
        storeState.installed.add(id);
        toast(_t('store_install_ok'));
      } else {
        toast((r && r.error) || _t('store_install_fail'));
      }
      renderStorePane();
    })
  );
  pane.querySelectorAll('[data-like]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const r = await beast.storeLike(btn.dataset.like).catch(() => null);
      if (r && r.ok) {
        const e = storeState.entries.find((x) => x.id === btn.dataset.like);
        if (e) { e.liked = r.liked; e.likes = Math.max(0, (e.likes || 0) + (r.liked ? 1 : -1)); }
        toast(_t('store_like_ok'));
        renderStorePane();
      }
    })
  );
}

function renderStoreList(mode) {
  const pane = $('#storePane');
  const list = storeState.entries
    .filter((e) => (mode === 'stars' ? storeAgeDays(e.createdAt) >= 14 && storeStarsScore(e) > 0 : true))
    .sort((a, b) => (mode === 'stars' ? storeStarsScore(b) - storeStarsScore(a) : storeTrendingScore(b) - storeTrendingScore(a)))
    .slice(0, 30);
  pane.innerHTML =
    (storeState.offline ? `<div class="store-sub">${_t('store_offline')}</div>` : '') +
    (list.length
      ? `<div class="store-grid">${list.map((e) => storeCard(e)).join('')}</div>`
      : `<div class="store-empty">${_t(mode === 'stars' ? 'store_empty_stars' : 'store_empty_trending')}</div>`);
  bindStoreCardActions(pane);
}

/* resim → kare kırpma (256×256, merkez) → dataURL */
function storeCropSquare(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const size = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - size) / 2;
        const sy = (img.naturalHeight - size) / 2;
        const c = document.createElement('canvas');
        c.width = 256;
        c.height = 256;
        c.getContext('2d').drawImage(img, sx, sy, size, size, 0, 0, 256, 256);
        resolve(c.toDataURL('image/jpeg', 0.85));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error('resim okunamadı'));
    img.src = dataUrl;
  });
}

function renderStoreUpload() {
  const pane = $('#storePane');
  const id = storeState.identity;
  const p = storeState.picked;
  /* kullanıcı adı bir kez kaydedilir → sonra hep otomatik kullanılır;
     yalnız "Değiştir"e basılınca düzenleme açılır */
  const editingIdentity = storeState.editIdentity || !id.username;
  const mine = storeState.entries
    .filter((e) => e.author && e.author.beastId === storeState.beastId)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  pane.innerHTML = `
    <div class="store-sub">${_t('store_sub_upload')}</div>
    <div class="store-form">
      <div class="store-box">
        <h3>${_t('store_id_label')} — <span id="stBeastId">${escapeHtml(storeState.beastId || '—')}</span></h3>
        ${editingIdentity ? `
        <div class="store-row">
          <input id="stUser" class="store-input" placeholder="${_t('store_user_ph')}" value="${escapeHtml(id.username || '')}" maxlength="20"/>
          <button id="stIdSave" class="store-btn">${_t('store_id_save')}</button>
        </div>` : `
        <div class="store-row">
          <span class="store-saved-user">✓ @${escapeHtml(id.username)}</span>
          <button id="stIdEdit" class="store-btn">${_t('store_user_change')}</button>
        </div>
        <div class="sub" style="margin:0">${_t('store_user_saved_note')}</div>`}
        ${editingIdentity ? `<div class="sub" style="margin:0">${_t('store_login_note')}</div>` : ''}
      </div>
      <div class="store-box">
        <h3>${_t('store_img_label')}</h3>
        <div class="store-row">
          <span class="store-avatar" id="stImgPrev" style="width:56px;height:56px;font-size:26px">${storeState.pendingImage ? `<img src="${storeState.pendingImage}" style="width:100%;height:100%;object-fit:cover;border-radius:8px"/>` : '🖼️'}</span>
          <button id="stImgBtn" class="store-btn">${storeState.pendingImage ? _t('store_img_change') : _t('store_img_pick')}</button>
        </div>
        <div class="sub" style="margin:0">${_t('store_img_auto')}</div>
      </div>
      <div class="store-box">
        <h3>${_t('store_skill_folder')}</h3>
        <button id="stPick" class="store-btn">${_t('store_pick_btn')}</button>
        <div class="store-picked" id="stPickInfo">${p
          ? `${escapeHtml(p.name)} — ${p.files.length} ${_t('store_files_label').toLowerCase()} · v${escapeHtml(p.version || '1.0.0')}`
          : _t('store_none_picked')}</div>
        ${p ? `
        <label class="mem-label" style="margin:0">${_t('store_name_label')}</label>
        <input id="stName" class="store-input" value="${escapeHtml(p.name || '')}" maxlength="60"/>
        <label class="mem-label" style="margin:0">${_t('store_desc_label')}</label>
        <textarea id="stDesc" class="store-input" rows="2" maxlength="200">${escapeHtml(p.description || '')}</textarea>
        <label class="mem-label" style="margin:0">${_t('store_tags_label')}</label>
        <input id="stTags" class="store-input" placeholder="${_t('store_tags_ph')}" maxlength="80"/>
        <button id="stCommit" class="store-btn primary">${_t('store_commit')}</button>` : ''}
      </div>
      <div class="store-box">
        <h3>${_t('store_mine')}</h3>
        <div class="store-mine">${mine.length
          ? mine.map((e) => `
            <div class="store-mine-row" data-mine="${escapeHtml(e.id)}">
              <span class="store-avatar" style="width:26px;height:26px;font-size:14px">${e.image ? `<img src="${e.image}" style="width:100%;height:100%;object-fit:cover;border-radius:6px"/>` : '🧩'}</span>
              <span class="sm-n">${escapeHtml(e.name)}</span>
              <span class="sm-m">⬇ ${e.installs || 0} · ♥ ${e.likes || 0}</span>
              <button data-share="${escapeHtml(e.id)}">${_t('store_share')}</button>
              <button class="sm-del" data-del="${escapeHtml(e.id)}">${_t('store_remove')}</button>
            </div>`).join('')
          : `<div class="sub" style="margin:0">${_t('store_mine_empty')}</div>`}</div>
      </div>
    </div>`;

  /* kimlik (kullanıcı adı yeterli — avatar yok) */
  const editBtn = $('#stIdEdit');
  if (editBtn)
    editBtn.addEventListener('click', () => {
      storeState.editIdentity = true;
      renderStorePane();
    });
  const saveBtn = $('#stIdSave');
  if (saveBtn)
    saveBtn.addEventListener('click', async () => {
      const username = $('#stUser').value.trim();
      const r = await beast.storeSetIdentity({ username });
      if (r && r.ok) {
        storeState.identity = { username, avatar: '🧩' };
        storeState.editIdentity = false; // kaydedildi → kilitli moda dön
        toast(_t('store_identity_saved'));
        renderStorePane();
      } else {
        toast((r && r.error) || 'hata');
      }
    });

  /* kapak resmi: dosya seç → kare kırp */
  $('#stImgBtn').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const raw = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = () => rej(new Error('okunamadı'));
          fr.readAsDataURL(f);
        });
        storeState.pendingImage = await storeCropSquare(raw);
        renderStorePane();
      } catch (e) {
        toast(String((e && e.message) || e));
      }
    });
    inp.click();
  });

  /* klasör seç */
  $('#stPick').addEventListener('click', async () => {
    const r = await beast.storePick().catch(() => null);
    if (r && r.ok) {
      storeState.picked = r;
      renderStorePane();
    } else if (r && !r.canceled && r.error) {
      toast(r.error);
    }
  });

  /* yükle */
  const commitBtn = $('#stCommit');
  if (commitBtn)
    commitBtn.addEventListener('click', async () => {
      if (!storeState.identity.username) {
        toast(_t('store_identity_first'));
        return;
      }
      if (!storeState.pendingImage) {
        toast(_t('store_img_required'));
        return;
      }
      if (!storeState.picked) {
        toast(_t('store_pick_first'));
        return;
      }
      const r = await beast.storeCommit({
        path: storeState.picked.path,
        name: $('#stName').value.trim(),
        description: $('#stDesc').value.trim(),
        tags: $('#stTags').value.split(',').map((t) => t.trim()).filter(Boolean),
        image: storeState.pendingImage,
      }).catch(() => null);
      if (r && r.ok) {
        toast(_t('store_commit_ok'));
        storeState.picked = null;
        storeState.pendingImage = '';
        await loadStore();
        renderStorePane();
      } else {
        toast((r && r.error) || 'hata');
      }
    });

  /* kendi yüklemeleri: paylaş / kaldır */
  pane.querySelectorAll('[data-share]').forEach((b) =>
    b.addEventListener('click', async () => {
      const r = await beast.storeExport(b.dataset.share).catch(() => null);
      if (r && r.ok) {
        try {
          await navigator.clipboard.writeText(r.json);
          beast.openExternal('https://github.com/algokodcom/beast-agent/issues/new?title=Skills%20Store%20g%C3%B6nderisi&body=' + encodeURIComponent('Aşağıya kopyalanan JSON\u2019u yapıştır:\n'));
          toast(_t('store_share_ok'));
        } catch {}
      }
    })
  );
  pane.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const r = await beast.storeRemove(b.dataset.del).catch(() => null);
      if (r && r.ok) {
        toast(_t('store_removed'));
        await loadStore();
        renderStorePane();
      } else if (r && r.error) {
        toast(r.error);
      }
    })
  );
}

function renderStorePane() {
  if (storeState.tab === 'upload') renderStoreUpload();
  else renderStoreList(storeState.tab);
  const bid = $('#storeBeastId');
  if (bid) bid.textContent = storeState.beastId || '';
}

$('#storeBtn').addEventListener('click', openStore);
$('#storeClose').addEventListener('click', closeStore);
$('#storeOverlay').addEventListener('click', (e) => {
  if (e.target === $('#storeOverlay')) closeStore();
});
document.querySelectorAll('.stab').forEach((b) =>
  b.addEventListener('click', () => {
    storeState.tab = b.dataset.stab;
    document.querySelectorAll('.stab').forEach((x) => x.classList.toggle('active', x === b));
    renderStorePane();
  })
);


/* ================= GITHUB TRENDING =================
   Skills Store'un sağındaki buton → %70 modal (store ile aynı tasarım).
   SOL: son 14 günün yıldız yükselenleri (GitHub Search API).
   SAĞ: favoriler (localStorage'da kalıcı). Her kartta:
   ★ favori · Chate at (ajana araştırma mesajı) · Kopyala · repoya git. */

const ghState = { items: [], err: '', range: '2w', sort: 'desc', q: '', ghTab: 'trend', allQ: '', allSort: 'best' };
const GH_FAV_KEY = 'beast.github.favs';
const GH_RANGE_LABEL = {
  all: '— tüm zamanların en yıldızlıları',
  '6m': '— son 6 ayın yıldız yükselenleri',
  '1m': '— son 1 ayın yıldız yükselenleri',
  '2w': '— son 2 haftanın yıldız yükselenleri',
  '1w': '— son 1 haftanın yıldız yükselenleri',
};
const GH_ALL_SORT_LABEL = { best: '⭐ En İyi', desc: '↓ Yıldız', asc: '↑ Yıldız' };

function ghFavs() {
  try { return JSON.parse(localStorage.getItem(GH_FAV_KEY) || '[]'); } catch { return []; }
}
function ghSaveFavs(list) {
  try { localStorage.setItem(GH_FAV_KEY, JSON.stringify(list.slice(0, 100))); } catch {}
}
function ghIsFav(fullName) {
  return ghFavs().some((f) => f.full_name === fullName);
}

async function openGit() {
  $('#ghOverlay').hidden = false;
  renderGhFavs();
  updateGhSortBtn();
  updateGhAllSortBtn();
  updateGhSub();
  loadGhTrend();
}

async function loadGhTrend() {
  const box = $('#ghTrendList');
  /* tüm repolar sekmesinde boş arama = API'yi boşa yorma, ipucu göster */
  if (ghState.ghTab === 'all' && !ghState.allQ) {
    box.innerHTML = '<div class="gh-empty">Depo adı, konu veya anahtar kelime yazıp Enter\u2019a bas — yıldız sayısına bakılmaksızın tüm GitHub aranır.</div>';
    return;
  }
  box.innerHTML = '<div class="gh-empty">Yükleniyor…</div>';
  const params = ghState.ghTab === 'all'
    ? { mode: 'all', q: ghState.allQ, allSort: ghState.allSort, order: ghState.allSort === 'desc' ? 'desc' : 'asc' }
    : { mode: 'trend', range: ghState.range, sort: ghState.sort, q: ghState.q };
  const r = await beast.githubTrending(params).catch(() => ({ ok: false, error: 'ipc' }));
  if (r && r.ok) {
    ghState.items = r.items || [];
    ghState.err = '';
  } else {
    ghState.items = [];
    ghState.err = (r && r.error) || 'GitHub\u2019a ulaşılamadı';
  }
  renderGhTrend();
}

function updateGhSortBtn() {
  const btn = $('#ghSortBtn');
  if (btn) {
    btn.textContent = ghState.sort === 'desc' ? '↓ Yıldız' : '↑ Yıldız';
    btn.title = ghState.sort === 'desc' ? 'Yıldız sırası: azalan — artana çevir' : 'Yıldız sırası: artan — azalana çevir';
  }
}

function updateGhSub() {
  const sub = $('#ghTrendSub');
  if (!sub) return;
  if (ghState.ghTab === 'all') {
    const sortTxt = ghState.allSort === 'best' ? 'en iyi eşleşme' : ghState.allSort === 'desc' ? 'yıldız azalan' : 'yıldız artan';
    sub.textContent = ghState.allQ ? `— "${ghState.allQ}" araması · ${sortTxt}` : '— tüm GitHub: ada, konuya, açıklamaya göre arama';
  } else {
    sub.textContent = ghState.q ? `— "${ghState.q}" araması · tüm zamanlar` : GH_RANGE_LABEL[ghState.range] || '';
  }
}

function updateGhAllSortBtn() {
  const btn = $('#ghAllSortBtn');
  if (btn) btn.textContent = GH_ALL_SORT_LABEL[ghState.allSort] || '⭐ En İyi';
}

function closeGit() {
  $('#ghOverlay').hidden = true;
}

/* chate at: ajana araştırma komutu gider (oturum yoksa input'a bırakılır) */
function ghSendToChat(url, name) {
  const msg = `GitHub\u2019da şu repoyu araştır: ${url}${name ? ' (' + name + ')' : ''} — ne işe yarıyor, öne çıkan özellikleri neler, aktif mi? Kısa özet ver.`;
  if (!activeId) {
    els.input.value = msg;
    toast('Aktif oturum yok — mesaj kutusuna bırakıldı');
    return;
  }
  els.input.value = msg;
  sendCurrent();
}

function ghCard(repo, isFav) {
  const stars = repo.stars >= 1000 ? (repo.stars / 1000).toFixed(1).replace('.0', '') + 'k' : String(repo.stars);
  const lang = repo.language ? `<span class="gh-lang">${escapeHtml(repo.language)}</span>` : '';
  return `
    <div class="gh-card" data-repo="${escapeHtml(repo.full_name)}">
      <div class="gh-card-top">
        <span class="gh-name" data-url="${escapeHtml(repo.html_url)}" title="${escapeHtml(repo.html_url)}">${escapeHtml(repo.full_name)}</span>
        <span class="gh-stars">★ ${stars}</span>
        ${lang}
      </div>
      ${repo.description ? `<div class="gh-desc" title="${escapeHtml(repo.description)}">${escapeHtml(repo.description)}</div>` : ''}
      <div class="gh-actions">
        <button class="gh-fav ${isFav ? 'on' : ''}" data-act="fav">${isFav ? '★ Favori' : '☆ Favorile'}</button>
        <button data-act="chat"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:4px"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>Chate at</button>
        <button data-act="copy">⧉ Kopyala</button>
      </div>
    </div>`;
}

function wireGhCards(container, list, isFavPane) {
  container.querySelectorAll('.gh-card').forEach((card) => {
    const repo = list.find((x) => x.full_name === card.dataset.repo);
    if (!repo) return;
    card.querySelector('.gh-name').addEventListener('click', () => beast.openExternal(repo.html_url).catch(() => {}));
    card.querySelector('[data-act="chat"]').addEventListener('click', () => {
      ghSendToChat(repo.html_url, repo.full_name);
      /* mesaj chate gitti — cevap chatten geleceği için modal kapanır */
      closeGit();
    });
    card.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(repo.html_url); toast('Link kopyalandı'); } catch {}
    });
    card.querySelector('[data-act="fav"]').addEventListener('click', () => {
      const favs = ghFavs();
      if (ghIsFav(repo.full_name)) {
        ghSaveFavs(favs.filter((f) => f.full_name !== repo.full_name));
        toast('Favoriden çıkarıldı: ' + repo.full_name);
      } else {
        favs.unshift({ ...repo, addedAt: new Date().toISOString() });
        ghSaveFavs(favs);
        toast('Favorilere eklendi: ' + repo.full_name);
      }
      renderGhTrend();
      renderGhFavs();
    });
  });
}

function renderGhTrend() {
  const box = $('#ghTrendList');
  if (!box) return;
  if (ghState.err) {
    box.innerHTML = `<div class="gh-err">⚠ ${escapeHtml(ghState.err)}</div>`;
    return;
  }
  if (!ghState.items.length) {
    box.innerHTML = '<div class="gh-empty">Son 14 günde öne çıkan repo bulunamadı.</div>';
    return;
  }
  box.innerHTML = ghState.items.map((r) => ghCard(r, ghIsFav(r.full_name))).join('');
  wireGhCards(box, ghState.items, false);
}

function renderGhFavs() {
  const box = $('#ghFavList');
  if (!box) return;
  const favs = ghFavs();
  if (!favs.length) {
    box.innerHTML = '<div class="gh-empty">Henüz favori yok — trendden ☆ ile ekle.</div>';
    return;
  }
  box.innerHTML = favs.map((r) => ghCard(r, true)).join('');
  wireGhCards(box, favs, true);
}

$('#gitBtn').addEventListener('click', openGit);
$('#ghClose').addEventListener('click', closeGit);
$('#ghOverlay').addEventListener('click', (e) => {
  if (e.target === $('#ghOverlay')) closeGit();
});
/* aralık filtreleri: Tümü / 6 Ay / 1 Ay / 2 Hafta / 1 Hafta */
document.querySelectorAll('#ghRanges button').forEach((b) =>
  b.addEventListener('click', () => {
    ghState.range = b.dataset.range;
    document.querySelectorAll('#ghRanges button').forEach((x) => x.classList.toggle('on', x === b));
    loadGhTrend();
    updateGhSub();
  })
);
/* yıldız sırası: azalan ⇄ artan */
$('#ghSortBtn').addEventListener('click', () => {
  ghState.sort = ghState.sort === 'desc' ? 'asc' : 'desc';
  updateGhSortBtn();
  loadGhTrend();
});
/* repo arama: Enter ile; boş Enter → trend moduna döner */
$('#ghSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  ghState.q = $('#ghSearch').value.trim();
  updateGhSub();
  loadGhTrend();
});
/* sol sekme: Trend Repolar ⇄ Tüm Repolar (eşit bölünmüş, ortalanmış) */
document.querySelectorAll('.gh-tab').forEach((b) =>
  b.addEventListener('click', () => {
    ghState.ghTab = b.dataset.ghtab;
    document.querySelectorAll('.gh-tab').forEach((x) => x.classList.toggle('on', x === b));
    $('#ghTrendTools').hidden = ghState.ghTab !== 'trend';
    $('#ghAllTools').hidden = ghState.ghTab !== 'all';
    updateGhSub();
    loadGhTrend();
  })
);
/* tüm repolar arama + üçlü sıralama: en iyi eşleşme → azalan → artan */
$('#ghAllSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  ghState.allQ = $('#ghAllSearch').value.trim();
  updateGhSub();
  loadGhTrend();
});
$('#ghAllSortBtn').addEventListener('click', () => {
  ghState.allSort = ghState.allSort === 'best' ? 'desc' : ghState.allSort === 'desc' ? 'asc' : 'best';
  updateGhAllSortBtn();
  updateGhSub();
  loadGhTrend();
});
/* ⟳ sıfırla + yenile: ilgili sekmenin filtrelerini başa alır, modal ilk açıldığı gibi yüklenir */
$('#ghTrendRefresh').addEventListener('click', () => {
  ghState.range = '2w';
  ghState.sort = 'desc';
  ghState.q = '';
  $('#ghSearch').value = '';
  document.querySelectorAll('#ghRanges button').forEach((x) => x.classList.toggle('on', x.dataset.range === '2w'));
  updateGhSortBtn();
  updateGhSub();
  loadGhTrend();
});
$('#ghAllRefresh').addEventListener('click', () => {
  ghState.allQ = '';
  ghState.allSort = 'best';
  $('#ghAllSearch').value = '';
  updateGhAllSortBtn();
  updateGhSub();
  loadGhTrend();
});


/* ================= IDE MODU =================
   Tek tuş (#ideBtn): sol → dosya gezgini, orta → chat, sağ → dahili tarayıcı (preview).
   Preview: workspace kökündeki index.html (yoksa ilk *.html) sağdaki tarayıcıda açılır.
   Dosyaya tıkla → editör; klasöre tıkla → aç/kapa. */

const IDE_ICONS = {
  '.html': '🌐', '.htm': '🌐', '.css': '🎨', '.js': '📜', '.mjs': '📜', '.cjs': '📜',
  '.ts': '📜', '.jsx': '📜', '.tsx': '📜', '.json': '🧾', '.md': '📝', '.txt': '📄',
  '.py': '🐍', '.ps1': '⚙️', '.bat': '⚙️', '.cmd': '⚙️', '.sh': '⚙️', '.yaml': '🧾',
  '.yml': '🧾', '.png': '🖼️', '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.svg': '🖼️',
  '.pdf': '📕',
};

const ideState = {
  cache: new Map(), // rel -> entries[]
  open: new Set(['']),
  path: '',
};

function ideModeOn() {
  return document.body.classList.contains('ide-mode');
}

async function setIdeMode(on) {
  document.body.classList.toggle('ide-mode', !!on);
  /* IDE modu oturumluk: uygulama HER AÇILIŞTA agent (chat) modunda başlar */
  toggleRail(!!on);
  /* IDE'den çıkış: açık tarayıcı da kapansın — her şey default haline dönsün */
  if (!on && document.body.classList.contains('browser-open')) {
    try { beast.toggleBrowser(); } catch {}
  }
  if (on) {
    ideSplitRestore();
    await loadIdeTree();
    bcBanner();
  }
}

/* ---------- editor/chat ayırıcı (VS Code gibi sürükle-bırak) ----------
   Orantılı model: kaydedilen, Beast Code'un ideRow içindeki PAYI'dır (0-1).
   Tarayıcı açılınca/kapanınca/genişlik değişince row yeniden bölünür — editör
   ve Beast Code ORTAK kırpılıp ORTAK açılır (oranlar korunur).
   Kayıt yoksa default: tarayıcı açıkken 3 eşit parça, kapalıyken 2 eşit parça. */
let ideSplitFrac = 0; /* 0 = kayıt yok → 0.5 default */

function ideSplitApplyFrac() {
  if (!ideSplitFrac) ideSplitFrac = 0.5;
  ideSplitFrac = Math.max(0.2, Math.min(ideSplitFrac, 0.8));
  const rowW = els.ideRow && els.ideRow.clientWidth ? els.ideRow.clientWidth : window.innerWidth - 250;
  const w = Math.max(280, Math.min(Math.round(rowW * ideSplitFrac), Math.max(320, rowW - 300)));
  document.body.style.setProperty('--ideSplit', w + 'px');
}

function ideSplitSave() {
  try { localStorage.setItem('beast.ideSplit', String(ideSplitFrac)); } catch {}
}

function ideSplitRestore() {
  let saved = 0;
  try { saved = parseFloat(localStorage.getItem('beast.ideSplit')) || 0; } catch {}
  const hasUserSetting = saved > 0.05 && saved < 0.95;
  ideSplitFrac = hasUserSetting ? saved : 0;
  ideSplitApplyFrac();
  /* tarayıcı açıksa ve kullanıcı hiç ayar yapmadıysa üç parçayı eşitle */
  const browserOpen = document.body.classList.contains('browser-open');
  if (browserOpen && !hasUserSetting) {
    beast.browserSetWidth(Math.round((window.innerWidth - 250) / 3)).catch(() => {});
  }
}

if (els.ideSplit) {
  els.ideSplit.addEventListener('mousedown', (e) => {
    e.preventDefault();
    els.ideSplit.classList.add('dragging');
    /* tarayıcı dock'u drag sırasında sabit — sağ kenar referansı mousedown anında */
    const rightEdge = els.bcPanel ? els.bcPanel.getBoundingClientRect().right : window.innerWidth;
    const rowW = Math.max(600, els.ideRow && els.ideRow.clientWidth ? els.ideRow.clientWidth : window.innerWidth - 250);
    const move = (ev) => {
      const w = Math.max(280, Math.min(rightEdge - ev.clientX, rowW - 300));
      ideSplitFrac = Math.max(0.2, Math.min(w / rowW, 0.8));
      document.body.style.setProperty('--ideSplit', Math.round(w) + 'px');
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      els.ideSplit.classList.remove('dragging');
      ideSplitSave();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  window.addEventListener('resize', () => {
    if (ideModeOn()) ideSplitApplyFrac();
  });
}

async function loadIdeTree() {
  ideState.cache.clear();
  await renderFileTree();
}

function fmtFileSize(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'M';
  if (n >= 1024) return Math.round(n / 1024) + 'K';
  return n ? n + 'B' : '';
}

async function renderFileTree() {
  const tree = $('#fileTree');
  if (!tree) return;
  tree.innerHTML = '';
  const wsLabel = $('#filePanelPath');
  const build = async (rel, depth, container) => {
    let entries = ideState.cache.get(rel);
    if (!entries) {
      const r = await beast.ideTree(rel).catch(() => null);
      if (!r || !r.ok) {
        if (!rel) container.innerHTML = `<div class="file-empty">${escapeHtml((r && r.error) || 'okunamadı')}</div>`;
        return;
      }
      entries = r.entries;
      ideState.cache.set(rel, entries);
      if (r.workspace) {
        ideState.path = r.workspace;
        if (wsLabel) { wsLabel.textContent = r.workspace; wsLabel.title = r.workspace; }
        if (els.bcCwd) { els.bcCwd.textContent = r.workspace; els.bcCwd.title = r.workspace; }
        bcOnFolderChanged(r.workspace);
      }
    }
    for (const e of entries) {
      const child = rel ? rel + '/' + e.name : e.name;
      const row = document.createElement('div');
      row.className = 'file-row';
      row.style.paddingLeft = 6 + depth * 14 + 'px';
      const ico = e.dir ? (ideState.open.has(child) ? '📂' : '📁') : IDE_ICONS[e.name.slice(e.name.lastIndexOf('.')).toLowerCase()] || '📄';
      row.innerHTML =
        `<span class="f-ico">${ico}</span>` +
        `<span class="f-nm" title="${escapeHtml(e.name)}">${escapeHtml(e.name)}</span>` +
        (e.dir ? '' : `<span class="f-sz">${fmtFileSize(e.size)}</span>`);
      row.addEventListener('click', () => {
        if (e.dir) {
          if (ideState.open.has(child)) ideState.open.delete(child);
          else ideState.open.add(child);
          renderFileTree();
        } else {
          codeOpen(child);
        }
      });
      row.dataset.rel = child;
      row.dataset.dir = e.dir ? '1' : '0';
      container.appendChild(row);
      if (e.dir && ideState.open.has(child)) {
        const box = document.createElement('div');
        container.appendChild(box);
        await build(child, depth + 1, box);
      }
    }
  };
  await build('', 0, tree);
}

/* ---------- sekmeli kod editörü (VS Code düzeni) ----------
   Dosya tıklaması MODAL değil, codePane içinde SEKME açar.
   Yanında Beast Code chat'i, onun sağındaki preview tarayıcı durur. */

const codeTabs = []; /* { rel, content, dirty } */
let codeActive = -1;

function codeRenderTabs() {
  const bar = els.codeTabs;
  if (!bar) return;
  bar.innerHTML = '';
  codeTabs.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'code-tab' + (i === codeActive ? ' active' : '') + (t.dirty ? ' dirty' : '');
    el.title = t.rel;
    el.innerHTML =
      '<span class="code-tab-name"></span>' +
      '<button class="code-tab-x" title="Sekmeyi kapat">\u00D7</button>';
    el.querySelector('.code-tab-name').textContent = t.rel;
    el.addEventListener('click', () => codeActivate(i));
    el.querySelector('.code-tab-x').addEventListener('click', (e) => {
      e.stopPropagation();
      codeClose(i);
    });
    bar.appendChild(el);
  });
}

function codeFlushActive() {
  if (codeActive >= 0 && codeTabs[codeActive]) {
    codeTabs[codeActive].content = els.codeTa.value;
  }
}

function codeActivate(i) {
  codeFlushActive();
  if (i < 0 || i >= codeTabs.length) {
    codeActive = -1;
    els.codeTa.value = '';
    els.codePath.textContent = '\u2014';
    codeRenderTabs();
    return;
  }
  codeActive = i;
  const t = codeTabs[i];
  els.codeTa.value = t.content;
  els.codePath.textContent = t.rel;
  els.codePath.title = (ideState.path || '') + '\\' + t.rel.replace(/\//g, '\\');
  codeRenderTabs();
}

async function codeOpen(rel) {
  const idx = codeTabs.findIndex((t) => t.rel === rel);
  if (idx >= 0) {
    codeActivate(idx);
    return;
  }
  const r = await beast.ideRead(rel).catch(() => null);
  if (!r || !r.ok) {
    toast((r && r.error) || 'okunamad\u0131');
    return;
  }
  codeTabs.push({ rel, content: r.content || '', dirty: false });
  codeActivate(codeTabs.length - 1);
  els.codeTa.focus();
}

function codeClose(i) {
  if (i < 0 || i >= codeTabs.length) return;
  codeFlushActive();
  const oldActive = codeActive;
  const wasActive = i === oldActive;
  codeTabs.splice(i, 1);
  if (codeTabs.length === 0) {
    codeActive = -1;
    els.codeTa.value = '';
    els.codePath.textContent = '\u2014';
    codeRenderTabs();
    return;
  }
  let next = oldActive;
  if (wasActive) next = Math.min(i, codeTabs.length - 1);
  else if (i < oldActive) next = oldActive - 1;
  codeActive = -1; /* activate içindeki flush, eski içerikle yeni sekmeyi ezmesin */
  codeActivate(next);
}

async function codeSave() {
  if (codeActive < 0 || !codeTabs[codeActive]) return;
  codeFlushActive();
  const t = codeTabs[codeActive];
  const r = await beast.ideWrite(t.rel, t.content).catch(() => null);
  if (r && r.ok) {
    t.dirty = false;
    codeRenderTabs();
    toast(_t('ide_saved'));
  } else {
    toast((r && r.error) || 'kaydedilemedi');
  }
}

$('#ideBtn').addEventListener('click', () => setIdeMode(!ideModeOn()));
$('#filePick').addEventListener('click', async () => {
  const r = await beast.ideSetRoot().catch(() => null);
  if (r && r.ok) {
    ideState.open = new Set(['']);
    await loadIdeTree();
  } else if (r && !r.canceled && r.error) {
    toast(r.error);
  }
});
$('#fileRefresh').addEventListener('click', () => loadIdeTree());
$('#filePreview').addEventListener('click', async () => {
  const r = await beast.idePreview().catch(() => null);
  if (r && r.ok) {
    if (ideModeOn() === false) setIdeMode(true);
  } else {
    toast((r && r.error) || 'preview açılamadı');
  }
});
if (els.codeSave) els.codeSave.addEventListener('click', codeSave);
if (els.codeTa) {
  els.codeTa.addEventListener('input', () => {
    if (codeActive < 0) return;
    codeTabs[codeActive].dirty = true;
    const el = els.codeTabs.children[codeActive];
    if (el) el.classList.add('dirty');
  });
  els.codeTa.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      codeSave();
    }
  });
}

/* ---------- dosya ağacı sağ tık menüsü (Sil / Aç / Preview) ---------- */

function fileCtxHide() {
  if (els.fileCtxMenu) els.fileCtxMenu.hidden = true;
}

function fileCtxShow(e, rel, isDir) {
  const menu = els.fileCtxMenu;
  if (!menu || !rel) return;
  e.preventDefault();
  const isHtml = /\.html?$/i.test(rel);
  const items = [];
  if (isDir) {
    items.push({
      label: ideState.open.has(rel) ? 'Kapat' : 'Aç',
      fn: () => {
        if (ideState.open.has(rel)) ideState.open.delete(rel);
        else ideState.open.add(rel);
        renderFileTree();
      },
    });
  } else {
    items.push({ label: 'Aç', fn: () => codeOpen(rel) });
    if (isHtml) {
      items.push({
        label: 'Preview',
        fn: async () => {
          const r = await beast.idePreviewFile(rel).catch(() => null);
          if (!r || !r.ok) toast((r && r.error) || 'preview açılamadı');
        },
      });
    }
  }
  items.push({
    label: 'Sil',
    danger: true,
    fn: async () => {
      const r = await beast.ideDelete(rel).catch(() => null);
      if (r && r.ok) {
        /* silinen dosya/klasörün açık sekmelerini kapat */
        for (let i = codeTabs.length - 1; i >= 0; i--) {
          if (codeTabs[i].rel === rel || codeTabs[i].rel.startsWith(rel + '/')) codeClose(i);
        }
        await loadIdeTree();
      } else if (r && !r.canceled && r.error) {
        toast(r.error);
      }
    },
  });

  menu.innerHTML = '';
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'ctx-item' + (it.danger ? ' danger' : '');
    el.textContent = it.label;
    el.addEventListener('click', () => {
      fileCtxHide();
      it.fn();
    });
    menu.appendChild(el);
  }
  menu.hidden = false;
  const mh = items.length * 33 + 8;
  menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - 170)) + 'px';
  menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - mh)) + 'px';
}

if (els.fileCtxMenu) {
  document.addEventListener('click', fileCtxHide);
  window.addEventListener('blur', fileCtxHide);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') fileCtxHide();
  });
}
$('#fileTree').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.file-row');
  if (!row || !row.dataset.rel) {
    fileCtxHide();
    return;
  }
  fileCtxShow(e, row.dataset.rel, row.dataset.dir === '1');
});

/* ---------- IDE modu ortası: BEAST CODE paneli ----------
   Sohbet yerine Beast'in kendi ajanı (varsayılan model) çalışır;
   soldaki dosya panelindeki klasörü workspace olarak kullanır.
   Gizli engine oturumu → olaylar onEvent içinde panele yönlendirilir. */

const BC_MAX_LINES = 1200;
let bcSessionId = null;
let bcRunning = false;
let bcBannerDone = false;
let bcStreamEl = null;
let bcStreamRaw = '';

function bcScroll(force) {
  const b = els.bcOut;
  if (!b) return;
  /* her yeni içerikte son mesaja doğru otomatik kaydır */
  b.scrollTop = b.scrollHeight;
}

/* kutu içi gövdeyi (bc-toolbody) de son bölüme kaydır */
function bcBodyScroll(el) {
  const b = el && el.closest ? el.closest('.bc-toolbody') : null;
  if (b) b.scrollTop = b.scrollHeight;
}

function bcLine(cls, text, time = false) {
  if (!els.bcOut) return;
  const el = document.createElement('div');
  el.className = 't-line ' + (cls || '');
  const ts = time ? '<span class="t-time">' + new Date().toTimeString().slice(0, 8) + '</span> ' : '';
  el.innerHTML = ts + escapeHtml(String(text ?? ''));
  els.bcOut.appendChild(el);
  while (els.bcOut.childElementCount > BC_MAX_LINES) els.bcOut.removeChild(els.bcOut.firstChild);
  bcScroll();
}

function bcBanner() {
  if (bcBannerDone) return;
  bcBannerDone = true;
  const cwd = ideState.path || '';
  if (els.bcCwd && cwd) { els.bcCwd.textContent = cwd; els.bcCwd.title = cwd; }
  bcLine('t-sys', 'BEAST CODE — çalışma klasörü: ' + (cwd || '?'));
  bcLine('t-dim', 'Beast\u2019in varsayılan modeliyle kod yazar; yazışma bu klasöre bağlıdır. ＋ yeni oturum · Temizle çıktıyı siler.', false);
}

/* Klasör değişimi (Klasör seç / kök değişti) → panel taze başlar;
   oturumlar main tarafında klasör bazlı tutulur (klasöre dönüşte aynı sohbet sürer).
   bcSessionId kasıtlı sıfırlanmaz: klasör değişse bile çalışan işin done/idle
   sinyali panele ulaşıp kilidi açar. */
let bcWsPath = '';

function bcOnFolderChanged(p) {
  if (!p || bcWsPath === p) return;
  const first = !bcWsPath;
  bcWsPath = p;
  if (first) return; /* ilk yükleme — panel zaten boş, banner setIdeMode'da basılır */
  if (els.bcOut) els.bcOut.innerHTML = '';
  bcTools.clear();
  bcCloseToolGroup();
  bcHideTodos();
  bcStreamEl = null;
  bcStreamRaw = '';
  bcBannerDone = false;
  bcBanner();
}

function bcSetBusy(v) {
  bcRunning = !!v;
  if (els.bcStop) els.bcStop.hidden = !v;
}

function bcFlushStream() {
  bcStreamEl = null;
  bcStreamRaw = '';
}

function bcStreamDelta(delta) {
  if (!bcStreamEl) {
    bcStreamEl = document.createElement('div');
    bcStreamEl.className = 't-line t-out';
    els.bcOut.appendChild(bcStreamEl);
  }
  bcStreamRaw += String(delta || '');
  bcStreamEl.textContent = bcStreamRaw.slice(-4000);
  bcScroll(true);
}

/* İş bitti → preview açık ve IDE modundaysa workspace sayfasını otomatik yenile */
let bcPrevAt = 0;

function bcRefreshPreview() {
  const now = Date.now();
  if (now - bcPrevAt < 1500) return; /* done + idle çift tetiklemesin */
  bcPrevAt = now;
  if (!ideModeOn() || !document.body.classList.contains('browser-open')) return;
  beast.idePreview().catch(() => {});
}

/* ---------- Beast Code araç kutuları ----------
   Ard arda gelen araç çağrıları TEK kutuda toplanır. Kural: engine mesajı
   tool_calls İÇERİYORSA (iş turu) grup AÇIK kalır — aradaki ara yazılar kutu
   içine not olarak akar; tool_calls İÇERMEYEN saf metin (normal mesaj) gelirse
   grup kapanır, sonraki çağrılar YENİ kutu açar.
   Kutu çalışırken etrafında fosforlu açık mavi outline döner; her çağrı kutu
   içinde bir bölüm, çıktı max 180px scroll'lu. */
const bcTools = new Map(); /* callId → { box, sec } */
let bcCurBox = null;       /* açık araç grubu — ard arda çağrılar buraya eklenir */
let bcNoteEl = null;       /* grup içindeki ara yazı notu */
let bcNoteRaw = '';

function bcNoteDetach() {
  bcNoteEl = null;
  bcNoteRaw = '';
}

function bcCloseToolGroup() {
  /* grup kapanınca (normal mesaj / iş bitti) ring durur */
  if (bcCurBox) bcCurBox.classList.remove('running');
  bcCurBox = null;
  bcNoteDetach();
}

function bcToolGroupNew() {
  const box = document.createElement('div');
  box.className = 'bc-toolbox';
  const body = document.createElement('div');
  body.className = 'bc-toolbody';
  box.appendChild(body);
  els.bcOut.appendChild(box);
  while (els.bcOut.childElementCount > BC_MAX_LINES) els.bcOut.removeChild(els.bcOut.firstChild);
  return box;
}

function bcToolBoxStart(callId, name, args) {
  bcFlushStream();
  if (!bcCurBox) bcCurBox = bcToolGroupNew();
  const sec = document.createElement('div');
  sec.className = 'bc-toolsection';
  const short = termShortTool(name, args);
  sec.innerHTML =
    '<div class="bc-toolhead">' +
      '<span class="bc-toolspin"></span>' +
      '<span class="bc-toolname">▸ ' + escapeHtml(String(name || 'araç')) + '</span>' +
      (short ? '<span class="bc-toolar" title="' + escapeHtml(short) + '">' + escapeHtml(short) + '</span>' : '') +
    '</div>' +
    '<div class="bc-toolout" hidden></div>';
  /* ring: iş bitene / grup kapanana kadar bu kutuda dönmeye devam eder */
  bcCurBox.classList.add('running');
  const body = bcCurBox.querySelector('.bc-toolbody') || bcCurBox;
  body.appendChild(sec);
  if (callId) bcTools.set(callId, { box: bcCurBox, sec });
  bcScroll();
  bcBodyScroll(body);
}

function bcToolBoxEnd(callId, ok, result) {
  bcFlushStream();
  const t = (callId && bcTools.get(callId)) || null;
  if (callId) bcTools.delete(callId);
  const out = String(result || '').replace(/\s+$/, '');
  if (t) {
    const { sec } = t;
    /* ring burada SÖNDÜRÜLMEZ — iş bitene kadar (bcCloseToolGroup) döner */
    sec.classList.add('done');
    if (!ok) sec.classList.add('failed');
    const pre = sec.querySelector('.bc-toolout');
    if (out) {
      pre.hidden = false;
      pre.textContent = out.length > 4000 ? out.slice(0, 4000) + '\n… (kesildi)' : out;
    } else {
      pre.remove();
    }
    bcBodyScroll(sec);
  } else if (out || !ok) {
    /* başlangıcı kaçmış çağrı — düz satır olarak düş */
    bcLine(ok ? 't-out' : 't-err', out ? (out.length > 400 ? out.slice(0, 400) + ' …(kesildi)' : out) : '(hata)');
  }
  bcScroll();
}

/* ---------- Beast Code todo kartı ----------
   Inputun (chat) hemen üstünde ortalı kompakt kutu; #bcTodoWrap içinde yaşar,
   scroll'lu çıktı akışını kirletmez. */
function bcRenderTodos(todos) {
  const list = Array.isArray(todos) ? todos : [];
  if (!els.bcTodoWrap) return;
  bcFlushStream();
  if (!list.length) {
    bcHideTodos();
    return;
  }
  els.bcTodoWrap.hidden = false;
  els.bcTodoWrap.innerHTML =
    '<div class="bc-todobox">' +
      '<div class="bc-todotitle"><span>GÖREVLER</span><span class="bc-todocount"></span></div>' +
      '<div class="bc-todoitems"></div>';
  const done = list.filter((t) => t.status === 'done').length;
  els.bcTodoWrap.querySelector('.bc-todocount').textContent = done + '/' + list.length;
  const wrap = els.bcTodoWrap.querySelector('.bc-todoitems');
  wrap.innerHTML = '';
  for (const t of list) {
    const st = TODO_GLYPH[t.status] ? t.status : 'pending';
    const row = document.createElement('div');
    row.className = 'bc-todoitem ' + st;
    row.innerHTML =
      '<span class="bc-todocheck">' + TODO_GLYPH[st] + '</span>' +
      '<span class="bc-todotext"></span>';
    row.querySelector('.bc-todotext').textContent = String(t.title || '');
    wrap.appendChild(row);
  }
}

function bcHideTodos() {
  if (els.bcTodoWrap) {
    els.bcTodoWrap.hidden = true;
    els.bcTodoWrap.innerHTML = '';
  }
}

/* Ara yazı → açık grup varsa kutu İÇİNE not olarak akar (kronoloji korunur) */
function bcNoteStream(delta) {
  if (!bcCurBox) return false;
  if (!bcNoteEl) {
    bcNoteEl = document.createElement('div');
    bcNoteEl.className = 'bc-toolnote';
    const body = bcCurBox.querySelector('.bc-toolbody') || bcCurBox;
    body.appendChild(bcNoteEl);
  }
  bcNoteRaw += String(delta || '');
  bcNoteEl.textContent = bcNoteRaw.slice(-2000);
  bcScroll(true);
  bcBodyScroll(bcNoteEl);
  return true;
}

/* Beast Code oturumunun engine olayları → panel çıktısı */
function bcIngest(ev) {
  switch (ev.type) {
    case 'token':
      /* grup açıksa ara not (kutu içi); değilse normal akış */
      if (bcNoteStream(ev.delta)) break;
      bcStreamDelta(ev.delta);
      break;
    case 'message':
      if (ev.message && ev.message.role === 'assistant') {
        const content = typeof ev.message.content === 'string' ? ev.message.content : '';
        const hasTools = Array.isArray(ev.message.tool_calls) && ev.message.tool_calls.length > 0;
        if (hasTools) {
          /* iş turu: grup AÇIK kalır — ard arda araçlar aynı kutuda sürer.
             Kutu içine akmış ara not kalıcı olur, işaretçileri bırak */
          bcNoteDetach();
          bcFlushStream();
          break;
        }
        /* NORMAL MESAJ: kutu içine düşen taslak notu çıkar, cevabı düz metin bas */
        if (bcNoteEl) { bcNoteEl.remove(); bcNoteDetach(); }
        if (content && !bcStreamRaw.trim()) bcLine('t-out', content);
        bcCloseToolGroup();
        bcFlushStream();
      }
      break;
    case 'todos':
      bcRenderTodos(ev.todos);
      break;
    case 'tool-start':
      bcToolBoxStart(ev.callId, ev.name, ev.args);
      break;
    case 'tool-end':
      bcToolBoxEnd(ev.callId, ev.ok, ev.result);
      break;
    case 'bc-mode':
      /* OpenCode disiplini çalışma modu: başlıkta rozet + panelde bilgi satırı */
      if (els.bcTitle) {
        els.bcTitle.textContent =
          ev.mode === 'plan' ? 'BEAST CODE · PLAN' :
          ev.mode === 'build' ? 'BEAST CODE · BUILD' : 'BEAST CODE';
      }
      bcLine('t-dim', '[' + (ev.body || ev.mode || 'mod değişti') + ']');
      break;
    case 'done':
      bcFlushStream();
      bcCloseToolGroup();
      bcSetBusy(false);
      /* iptal/durdurma SEBEBİ panelde de görünür */
      bcLine(ev.aborted ? 't-err' : 't-dim', ev.aborted ? '[durduruldu — sebep: ' + (ev.reason || 'sebep belirtilmedi') + ']' : '(tamamlandı)');
      bcRefreshPreview();
      if (ideModeOn() && els.bcInput) els.bcInput.focus();
      break;
    case 'error':
      bcFlushStream();
      bcCloseToolGroup();
      bcSetBusy(false);
      bcLine('t-err', '[hata] ' + (ev.error || ''));
      break;
    case 'status':
      /* 'idle' = engine oturumu GERÇEKTEN bıraktı (finally bloğu, her yolda gelir) —
         done kaçsa bile panel kilitli kalmaz, ■ otomatik kalkar, ring durur */
      if (ev.status === 'idle') {
        bcCloseToolGroup();
        bcSetBusy(false);
        bcRefreshPreview();
      }
      break;
  }
}

function bcRunCurrent() {
  const msg = els.bcInput.value.trim();
  if (!msg) return;
  els.bcInput.value = '';
  bcLine('t-cmd', 'code> ' + msg);
  bcHideTodos(); /* yeni sorgu = eski todo list temizlenir; agent yeniden basacak */
  bcSetBusy(true);
  /* sürüyor/serbest kararını main'deki gerçek engine.isBusy verir —
     panel bayat kilitli kaldıysa ilk mesajla kendini düzeltir */
  beast.beastcodeSend(msg).then((r) => {
    if (r && r.ok && r.mode) {
      /* /plan · /build · /auto: mod değişimi — tur AÇILMAZ, kilit anında açılır
         (bilgi satırı bc-mode olayıyla düşer, başlık rozeti güncellenir) */
      bcSessionId = r.sessionId;
      bcSetBusy(false);
    } else if (r && r.ok) {
      bcSessionId = r.sessionId;
    } else if (r && r.busy) {
      /* iş gerçekten sürüyor — kilit açılmaz, bilgi satırı düşer */
      bcLine('t-dim', (r && r.error) || 'mesaj sürüyor');
    } else {
      bcSetBusy(false);
      bcLine('t-err', (r && r.error) || 'gönderilemedi');
    }
  }).catch((e) => {
    bcSetBusy(false);
    bcLine('t-err', String((e && e.message) || e));
  });
}

if (els.bcInput) els.bcInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); bcRunCurrent(); }
});
if (els.bcStop) els.bcStop.addEventListener('click', () => beast.beastcodeStop().catch(() => {}));
if (els.bcClear) els.bcClear.addEventListener('click', () => {
  els.bcOut.innerHTML = '';
  bcTools.clear();
  bcCloseToolGroup();
  bcHideTodos();
  bcFlushStream();
});
if (els.bcNew) els.bcNew.addEventListener('click', async () => {
  if (bcRunning) { toast('Mesaj sürüyor — önce ■ ile durdur'); return; }
  const r = await beast.beastcodeNew().catch(() => null);
  if (r && r.ok) {
    bcSessionId = null;
    bcTools.clear();
    bcCloseToolGroup();
    bcHideTodos();
    bcFlushStream();
    if (els.bcTitle) els.bcTitle.textContent = 'BEAST CODE';
    bcLine('t-sys', 'yeni oturum — sonraki mesaj taze başlar');
  }
});
/* Uygulama her açılışta agent (chat) modunda başlar — IDE modu yalnız
   kullanıcı butona basınca girilir (oturumluk). */
