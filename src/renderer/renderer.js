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
  termBtn: $('#termBtn'),
  termGBtn: $('#termGBtn'),
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

/* #19 sağ panel tercih durumu (tarayıcı açılmadan önceki) */
let railPrefBeforeBrowser = true;

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
    `<div class="td-head"><span>GÖREVLER</span><span class="td-count">${done}/${list.length}</span></div>` + rows;
  els.todoPanel.hidden = false;
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
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
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

/* ---------------- tool cards ---------------- */

function argSummary(name, args) {
  try {
    if (name === 'run_command') return String(args.command || '');
    if (name === 'read_file' || name === 'write_file') return String(args.path || '');
    if (name === 'list_dir') return String(args.path || '.');
    if (name === 'memory_write') return String(args.text || '').slice(0, 80);
    return JSON.stringify(args).slice(0, 100);
  } catch {
    return '';
  }
}

function addToolCard(callId, name, args) {
  streamEl = null;
  showEmpty(false);
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
  els.msgs.appendChild(card);
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
}

/* ---------------- sessions sidebar ---------------- */

async function renderSessions(list) {
  let waSet = new Set();
  try {
    waSet = new Set(await beast.waListSessions());
  } catch {}
  els.sessList.innerHTML = '';
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'sess' + (s.id === activeId ? ' active' : '');
    row.innerHTML =
      (waSet.has(s.id) ? '<span class="sess-wa" title="WhatsApp">W</span>' : '') +
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
      refreshSessions();
    });
    els.sessList.appendChild(row);
  }
}

async function refreshSessions() {
  await renderSessions(await beast.listSessions());
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
  renderMemoryPane();
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
    case 'memory': renderMemoryPane(); break;
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
  for (const p of ['provider', 'fallout', 'memory', 'skills', 'agents', 'tts', 'email', 'integrations', 'websearch', 'events', 'cron', 'usage', 'logs', 'dash', 'limits', 'sec', 'update']) {
    $('#tab-' + p).hidden = p !== name;
  }
  if (name === 'cron') openCron();
  if (name === 'usage') renderUsagePane();
  if (name === 'events') renderEventsPane();
  if (name === 'logs') renderLogPane();
  if (name === 'dash') renderDashboardPane();
  if (name === 'limits') renderLimitsPane();
  if (name === 'sec') renderSecurityPane();
  if (name === 'update') renderUpdatePane();
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

/* Web Arama sekmesi: TinyFish (zincirin başı) + Exa API anahtarı (maskeli) */
async function renderWebSearchPane() {
  const pane = $('#tab-websearch');
  if (!pane) return;
  const tf = await beast.tinyfishGet().catch(() => ({ set: false, masked: '' }));
  pane.innerHTML =
    '<h2>' + _t('tf_h2') + '</h2>' +
    '<div class="sub">' + _t('tf_sub') + '</div>' +
    '<div id="tfStatus" class="sub" style="text-align:left;margin-top:8px"></div>' +
    '<label class="mem-label">' + _t('tf_key_label') + '</label>' +
    '<input id="tfKeyInp" class="inp" type="password" placeholder="tf_..." autocomplete="new-password" spellcheck="false" />' +
    '<div class="form-grid" style="grid-template-columns:auto auto;gap:8px;margin-top:8px">' +
    '<button id="tfSave" class="btn">' + _t('ws_save') + '</button>' +
    '<button id="tfClear" class="btn ghost">' + _t('ws_clear') + '</button></div>' +
    '<div class="divider"></div>' +
    '<h2>' + _t('ws_h2') + '</h2>' +
    '<div class="sub">' + _t('ws_sub') + '</div>' +
    '<div id="exaStatus" class="sub" style="text-align:left;margin-top:10px"></div>' +
    '<label class="mem-label">' + _t('ws_exa_label') + '</label>' +
    '<input id="exaKeyInp" class="inp" type="password" placeholder="' + _t('ws_exa_ph') + '" autocomplete="new-password" spellcheck="false" />' +
    '<div class="form-grid" style="grid-template-columns:auto auto;gap:8px;margin-top:8px">' +
    '<button id="exaSave" class="btn">' + _t('ws_save') + '</button>' +
    '<button id="exaClear" class="btn ghost">' + _t('ws_clear') + '</button></div>' +
    '<div class="sub" style="margin-top:8px">' + _t('ws_note') + '</div>';
  const st = $('#exaStatus');
  const setExaSt = (r) => {
    st.textContent = r.set ? _t('ws_status_set') + r.masked : _t('ws_status_unset');
  };
  const tfSt = $('#tfStatus');
  const setTfSt = (r) => {
    tfSt.textContent = r.set ? _t('tf_status_set') + r.masked : _t('tf_status_unset');
  };
  setExaSt(await beast.exaGet().catch(() => ({ set: false, masked: '' })));
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
  $('#exaSave').addEventListener('click', async () => {
    const v = $('#exaKeyInp').value.trim();
    if (!v) { toast(_t('ws_empty_toast')); return; }
    const rr = await beast.exaSet(v).catch(() => null);
    $('#exaKeyInp').value = '';
    if (rr && rr.set) {
      setExaSt(rr);
      toast(_t('ws_saved_toast'));
    } else {
      toast(_t('ws_fail_toast'));
    }
  });
  $('#exaClear').addEventListener('click', async () => {
    await beast.exaClear().catch(() => {});
    $('#exaKeyInp').value = '';
    setExaSt({ set: false, masked: '' });
    toast(_t('ws_cleared_toast'));
  });
}

async function renderProviderPane() {
  const pane = $('#tab-provider');
  pane.innerHTML =
    '<h2>' + _t('p_h2') + '</h2><div class="sub">' + _t('p_sub') + '</div>';

  for (const m of state.models || []) {
    const row = document.createElement('div');
    row.className = 'prov-row' + (state.activeModel && state.activeModel.sel === m.sel ? ' active' : '');
    row.innerHTML =
      `<span class="prov-name">${escapeHtml(m.providerName)}</span>` +
      `<span class="prov-model">${escapeHtml(m.model)}</span>` +
      `<span class="check">✓</span>` +
      `<button class="prov-del" title="${_t('p_del_title')}">✕</button>`;
    row.addEventListener('click', async () => {
      state = await beast.setModel(m.sel);
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
    `<label class="mem-label">${_t('p_name_opt')}</label><input id="cpName" class="inp" placeholder="Örn: OrcaRouter">` +
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
    let name = $('#cpName').value.trim();
    try { name = name || new URL(url).hostname; } catch { name = 'Custom'; }
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name,
      baseUrl: url,
      key: $('#cpKey').value.trim(),
      models,
    };
    state = await beast.setCustomProviders([...customs, entry]);
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

function renderMemoryPane() {
  const pane = $('#tab-memory');
  beast.getMemory().then((mem) => {
    pane.innerHTML =
      '<h2>' + _t('mem_h2') + '</h2><div class="sub">' + _t('mem_sub') + '</div>' +
      `<label class="mem-label">${_t('mem_soul')}</label><textarea id="soulTa" class="mem-area soul-area"></textarea>` +
      `<label class="mem-label">${_t('mem_mem')}</label><textarea id="memTa" class="mem-area"></textarea>` +
      `<label class="mem-label">${_t('mem_user')}</label><textarea id="userTa" class="mem-area"></textarea>` +
      `<button id="memSave" class="btn">${_t('mem_save')}</button>`;
    $('#soulTa').value = mem.soul || '';
    $('#memTa').value = mem.memory || '';
    $('#userTa').value = mem.user || '';
    $('#memSave').addEventListener('click', async () => {
      await beast.saveMemory('SOUL.md', $('#soulTa').value);
      await beast.saveMemory('MEMORY.md', $('#memTa').value);
      await beast.saveMemory('USER.md', $('#userTa').value);
      toast('Memory kaydedildi — SOUL.md dahil');
    });
  });
}

async function renderSkillsPane() {
  const pane = $('#tab-skills');
  pane.innerHTML = '<h2>' + _t('sk_h2') + '</h2><div class="sub">' + _t('sk_sub') + '</div>';
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
  const g = await beast.waGetGroups().catch(() => ({ enabled: false, mentionOnly: true }));
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
      <label class="lock-row" style="${g.enabled ? '' : 'opacity:.45'}"><input type="checkbox" id="waGroupsAll" ${g.mentionOnly === false ? 'checked' : ''}/><span>${_t('it_groups_all')}</span></label>
      <div class="divider"></div>
      <label class="mem-label" style="margin-top:0">${_t('it_allow_label')}</label>
      <div id="waAllowChips" class="chips-inline"></div>
      <div class="form-grid" style="grid-template-columns:2fr 1fr auto;align-items:center">
        <input id="waAllowNameInp" class="inp" style="margin:6px 0 0" placeholder="${_t('it_name_ph')}" autocomplete="off" />
        <input id="waAllowInp" class="inp" style="margin:6px 0 0" placeholder="${_t('it_num_ph')}" autocomplete="off" />
        <button id="waAllowAdd" class="btn ghost" style="margin-top:6px">${_t('it_add')}</button>
      </div>
      <div class="sub" style="margin-top:8px">${_t('it_allow_note')}</div>
    </div>`;

  const waGroupsOn = $('#waGroupsOn');
  const waGroupsAll = $('#waGroupsAll');
  const saveGroups = async () => {
    const r = await beast.waSetGroups({ enabled: waGroupsOn.checked, mentionOnly: !waGroupsAll.checked });
    toast(r.enabled ? (r.mentionOnly ? 'Gruplar açık — @mention bekler' : 'Gruplar açık — tüm mesajlara karışır') : 'Gruplar kapalı');
  };
  waGroupsOn.addEventListener('change', async () => {
    waGroupsAll.parentElement.style.opacity = waGroupsOn.checked ? '' : '.45';
    await saveGroups();
  });
  waGroupsAll.addEventListener('change', saveGroups);

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

  await renderWaAllow();

  const snap = await beast.waStatus();
  waUI.status = snap.status || 'disconnected';
  if (snap.user) waUI.user = snap.user;
  updateWaPane();
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
  try { waSet = new Set(await beast.waListSessions()); } catch {}

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
  if (st.npm) status = _t('up_npm_mode');
  else   if (st.npm) status = '\u26A0\uFE0E ' + st.error;
  else if (st.downloaded) status = _t('up_downloaded') + ' (v' + (st.version || '?') + ')';
  else if (st.progress) status = _t('up_downloading') + ' %' + st.progress.percent;
  else if (st.checking) status = _t('up_checking');
  else if (st.available) status = _t('up_available') + ' (v' + (st.version || '?') + ')';
  else if (st.available === false) status = _t('up_uptodate');
  else status = '—';

  return `<div class="usage-stat" id="upStatusBox"><div class="us-label">${_t('up_status')}</div><div class="us-value" style="font-size:14px">${escapeHtml(status)}</div></div>`;
}

async function renderUpdatePane() {
  const pane = $('#tab-update');
  if (!pane) return;
  const st = await beast.updateStatus().catch(() => null);
  if (!st) return;
  clearInterval(updatePaneTimer);

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
    (st.npm
      ? `<div class="codeblock npm" style="margin-top:10px"><pre># uygulamayı kapat, sonra:
beast-agent update</pre></div>`
      : `<div class="form-grid" style="grid-template-columns:auto auto;gap:8px;margin-top:12px">
          <button id="upCheck" class="btn ghost">${_t('up_check_now')}</button>
          <button id="upInstall" class="btn ghost" ${st.downloaded ? '' : 'disabled style="opacity:.45;cursor:default"'}>${_t('up_install_now')}</button>
        </div>
        <div class="sub" style="margin-top:8px">${_t('up_note')}</div>`);

  const chk = pane.querySelector('#upAutoCheck');
  if (chk) chk.addEventListener('change', async (e) => { await beast.updateSetAuto({ autoCheck: e.target.checked }); });
  const dl = pane.querySelector('#upAutoDl');
  if (dl) dl.addEventListener('change', async (e) => { await beast.updateSetAuto({ autoDownload: e.target.checked }); });

  const btnCheck = pane.querySelector('#upCheck');
  if (btnCheck) btnCheck.addEventListener('click', async () => {
    btnCheck.disabled = true;
    const r = await beast.updateCheck().catch(() => ({ ok: false, error: 'ipc' }));
    if (!r.ok && r.error) toast(r.error);
  });
  const btnInstall = pane.querySelector('#upInstall');
  if (btnInstall) btnInstall.addEventListener('click', async () => {
    const r = await beast.updateInstall().catch(() => ({ ok: false, error: 'ipc' }));
    if (!r.ok && r.error) toast(r.error);
  });

  /* indirme ilerlemesi için sekme açıkken canlı tazele — YALNIZ durum kutusu */
  updatePaneTimer = setInterval(() => {
    if ($('#tab-update').hidden || els.settingsOverlay.hidden) { clearInterval(updatePaneTimer); return; }
    beast.updateStatus().then((s) => {
      if (!s) return;
      const box = pane.querySelector('#upStatusBox');
      if (box) box.outerHTML = renderUpdateStateHtml(s);
    }).catch(() => {});
  }, 1000);
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
    return (name ? name + ' ' : '') + (num ? '+' + num : '') + ownerTag;
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
        i === idx ? { num: uInp.value.trim(), name: nInp.value.trim().slice(0, 40), lockdown: lock0 } : e
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
  if (!add.dataset.bound) {
    add.dataset.bound = '1';
    const addNum = async () => {
      let v = inp.value.trim();
      if (!v) return;
      const name = nameInp.value.trim().slice(0, 40);
      if (!name) { toast('İsim zorunlu — kimin yazdığını bilmek için'); nameInp.focus(); return; }
      await beast.waSetAllow([...(await beast.waGetAllow()), { num: v, name }]);
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

/* ---------------- paralel ajanlar (#14 CEO) ---------------- */

const agentState = {
  jobs: [],
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
  updateAgentIds();
  renderAgentsPane();
  renderAgentRail();
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
       `<span class="rj-time">${j.status === 'running' ? when + ' · ' + _t('ag_working') : (agStText(j.status) === _t('ag_st_done') ? '\u2713' : (agStText(j.status) || j.status))}</span>` +
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
       `<span class="ag-st">${agStText(j.status) || j.status}</span>` +
      `<span class="ag-time">${when}${j.endedAt ? ` · ${fmtAgo(j.endedAt)}` : ''}</span>` +
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

  /* canlı süre sayacı */
  clearInterval(agentState.tick);
  agentState.tick = setInterval(() => {
    if (setTab !== 'agents') { clearInterval(agentState.tick); return; }
    for (const el of document.querySelectorAll('.agent-card.st-running .ag-time')) {
      /* sadece saati yenile */
      const t = el.textContent.split(' ')[0];
      el.textContent = `${t} · ${_t('ag_working')}…`;
    }
  }, 5000);
}

/* ---------------- events from engine ---------------- */

function onEvent(ev) {
  if (ev.type === 'sessions') { refreshSessions(); return; }
  if (ev.type === 'approval') {
    if (ev.sessionId && ev.sessionId !== activeId) return;
    showApprovalCard(ev);
    return;
  }
  if (ev.type === 'update') {
    if (ev.downloaded) toast(_t('up_downloaded') + ' (v' + (ev.version || '?') + ') — /update now');
    if (!els.settingsOverlay.hidden && setTab === 'update') renderUpdatePane();
    return;
  }
  if (ev.type === 'agents') {
    agentState.jobs = ev.jobs || [];
    updateAgentIds();
    scheduleAgentsRender();
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
      showEmpty(true);
      refreshSessions();
      break;
    case 'modelChanged':
      /* /change ile model değişince üstteki picker otomatik güncellenir */
      beast.getState().then((s) => { state = s; applyState(); }).catch(() => {});
      break;
    case 'message':
      if (ev.message.role === 'user') addUserBubble(ev.message.content);
      else if (ev.message.role === 'assistant') finalizeAssistant(ev.message.content);
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
      document.body.classList.toggle('browser-open', shown);
      if (shown && ev.width) document.body.style.setProperty('--bw', ev.width + 'px');
      els.browserBar.hidden = !shown;
      els.bbResize.hidden = !shown;
      /* terminal de sağ dock'u kullanır — tarayıcı açılınca yerini bırak */
      if (shown && termOpen) termSetOpen(false);
      /* #19 tarayıcı açılınca paralel ajan konsolu (sağ panel) yerini bırakır;
         kapanınca önceki durumuna döner — istenirse railBtn ile elle açılır */
      if (shown) {
        railPrefBeforeBrowser = !document.body.classList.contains('rail-hidden');
        toggleRail(true);
      } else {
        toggleRail(!railPrefBeforeBrowser);
      }
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
      setBusy(false);
      refreshSessions();
      els.input.focus();
      break;
    case 'error':
      setBusy(false);
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
let termShell = 'powershell';
const TERM_MAX_LINES = 800;

/* terminal kabukları: > PowerShell · G Git Bash · C CMD */
const TERM_SHELLS = {
  powershell: { label: 'PowerShell', prompt: 'PS>' },
  bash: { label: 'Git Bash', prompt: 'bash $' },
  cmd: { label: 'CMD', prompt: 'C>' },
};

function termSetShell(s) {
  if (!TERM_SHELLS[s]) s = 'powershell';
  const changed = termShell !== s;
  termShell = s;
  if (els.termPrompt) els.termPrompt.textContent = TERM_SHELLS[s].prompt;
  if (els.termBtn) els.termBtn.classList.toggle('on', termOpen && s === 'powershell');
  if (els.termGBtn) els.termGBtn.classList.toggle('on', termOpen && s === 'bash');
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
  termLine('t-dim', 'Komut yaz, Enter\'a bas — her komut workspace\'te ayrı süreçle çalışır. Üst bar: > PowerShell · G Git Bash · C CMD.', false);
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
  const want = TERM_SHELLS[shell] ? shell : 'powershell';
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
  termLine('t-cmd', 'PS> ' + cmd);
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

function applyState() {
  if (!state) return;
  els.modelBtnLabel.textContent = state.activeModel
    ? `${state.activeModel.providerName} · ${state.activeModel.model}`
    : 'Model seçilmedi';
  els.thinkBtnLabel.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v.55A3.5 3.5 0 0 0 4.5 8.5c0 .74.23 1.43.62 2A3.5 3.5 0 0 0 4 13.5 3.5 3.5 0 0 0 7 16.95v.55A2.5 2.5 0 0 0 9.5 20a2.5 2.5 0 0 0 2.5-2.5v-13A2.5 2.5 0 0 0 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 1 17 4.5v.55a3.5 3.5 0 0 1 2.5 3.45c0 .74-.23 1.43-.62 2a3.5 3.5 0 0 1 1.12 3 3.5 3.5 0 0 1-3 3.45v.55A2.5 2.5 0 0 1 14.5 20 2.5 2.5 0 0 1 12 17.5v-13A2.5 2.5 0 0 1 14.5 2z"/></svg>';
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
    item.className = 'dd-item' + (state.activeModel && state.activeModel.sel === m.sel ? ' active' : '');
    item.innerHTML =
      `<span class="dn">${escapeHtml(m.providerName)}</span>` +
      `<span class="dm">${escapeHtml(m.model)}</span>` +
      `<span class="ck">✓</span>`;
    item.addEventListener('click', async () => {
      state = await beast.setModel(m.sel);
      closeModelMenu();
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
        const r = await beast.sttTranscribe(b64).catch(() => ({ ok: false, error: 'ipc' }));
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
  if (els.termBtn) els.termBtn.addEventListener('click', () => termToggle('powershell'));
  if (els.termGBtn) els.termGBtn.addEventListener('click', () => termToggle('bash'));
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
