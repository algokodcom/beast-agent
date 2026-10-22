'use strict';

/* ---------- yardimcilar ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const escapeHtml = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* panoya kopyala (Electron/file bağlamında güvenli geri düşüş ile) */
async function copyText(txt) {
  const s = String(txt == null ? '' : txt);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/* ---------- MT5 işlem kilidi: işlem bitene kadar butonlar kilitli ----------
   İşlem sürerken .mt5-act butonları tıklanamaz; üst üste emir gönderilmez. */
let mt5Busy = 0;
function mt5Begin() {
  mt5Busy++;
  document.body.classList.add('mt5-busy');
}
function mt5End() {
  mt5Busy = Math.max(0, mt5Busy - 1);
  if (!mt5Busy) document.body.classList.remove('mt5-busy');
}
document.addEventListener('click', (e) => {
  if (mt5Busy <= 0) return;
  const btn = e.target && e.target.closest ? e.target.closest('button.mt5-act') : null;
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

/* ---------- durum ---------- */
let state = { providers: [], activeModel: null, thinkLevel: 0 };
/* düşünme (reasoning) seviyeleri — Beast Agent ile aynı gerçek API değerleri */
const THINK_LEVELS = [
  { v: 0, label: 'Kapalı', desc: 'param gönderilmez' },
  { v: 1, label: 'Low', desc: 'reasoning_effort: low' },
  { v: 2, label: 'Medium', desc: 'reasoning_effort: medium' },
  { v: 3, label: 'High', desc: 'reasoning_effort: high' },
  { v: 4, label: 'X-High', desc: 'reasoning_effort: xhigh' },
  { v: 5, label: 'Max', desc: 'reasoning_effort: max' },
];
let sessions = [];            // {id, title, messages:[{role, content}]}
let activeSid = '';
let pendingChatId = '';       // aktif istek id
let jevChatStartedAt = 0;     // aktif isteğin başlangıcı (takılı istek sıfırlama)
let builtinProviders = [];
let theme = localStorage.getItem('jev.theme') || 'dark';
/* seçili borsa: mt5 | binance | okx */
let exName = 'mt5';
/* borsa değişim sayacı: uçuştaki eski yanıtlar yok sayılır */
let exSeq = 0;
/* TF/sembol değişim sayacı: geçmiş yükleme ve uçuştaki istekler eski TF'te kalmasın */
let tfSeq = 0;
/* Binance/OKX için aktif hesap türü: gerçek hesap mı deneme (demo/testnet) hesabı mı */
let exDemoMode = { binance: false, okx: false };

function exLabel(name) {
  const n = name || exName;
  const base = n === 'binance' ? 'Binance' : n === 'okx' ? 'OKX' : 'MT5';
  return exDemoMode[n] ? base + ' Demo' : base;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- oturumlar (localStorage) ---------- */
function loadSessions() {
  try {
    const raw = JSON.parse(localStorage.getItem('jev.sessions') || '[]');
    if (Array.isArray(raw)) sessions = raw;
  } catch { sessions = []; }
  if (!Array.isArray(sessions)) sessions = [];
}
function saveSessions() {
  try { localStorage.setItem('jev.sessions', JSON.stringify(sessions.slice(-120))); } catch {}
}

function ensureSession() {
  let s = sessions.find((x) => x.id === activeSid);
  if (s && (sessionTabId(s) !== activeTabId || !sessionExOk(s))) s = null;
  if (!s) {
    s = { id: newId(), title: 'Yeni Sohbet', messages: [], tabId: activeTabId, ex: exName };
    sessions.unshift(s);
    activeSid = s.id;
  }
  return s;
}

function activeSession() {
  const s = sessions.find((x) => x.id === activeSid) || null;
  if (s && (sessionTabId(s) !== activeTabId || !sessionExOk(s))) return null;
  return s;
}

/* sohbet borsaya bağlıdır: her borsanın sohbeti ayrı (eski kayıtlar aktif borsaya atanır) */
function sessionExOk(s) {
  return !s || !s.ex || s.ex === exName;
}

/* ---------- grafik sekmeleri (her sekmenin ayrı grafiği + ayrı sohbeti) ---------- */
const TABS_KEY = 'jev.tabs';
const ACTIVE_TAB_KEY = 'jev.activeTab';
let chartTabs = [];
let activeTabId = '';

/* otomasyon ayarları (sekmeye özel): trailing + R bazlı kısmi TP */
function normAuto(a) {
  const o = a && typeof a === 'object' ? a : {};
  const n = (v) => (Number(v) > 0 ? Number(v) : 0);
  return {
    on: o.on === true,
    trailOn: o.trailOn === true,
    trailDistR: n(o.trailDistR),
    trailStepR: n(o.trailStepR),
    trailStartR: n(o.trailStartR),
    trailLockR: n(o.trailLockR),
    tp1R: n(o.tp1R),
    tp1Pct: Math.min(99, n(o.tp1Pct)),
    tp2R: n(o.tp2R),
    tp2Pct: Math.min(99, n(o.tp2Pct)),
    beAfterTp1: o.beAfterTp1 === true,
  };
}

function autoCfg(tab) {
  return normAuto(tab && tab.auto);
}

function loadTabs() {
  let raw = null;
  try {
    raw = JSON.parse(localStorage.getItem(tabsKey()) || 'null');
    /* MT5: eski tek anahtardan bir kez taşı */
    if (!Array.isArray(raw) && exName === 'mt5') raw = JSON.parse(localStorage.getItem(TABS_KEY) || 'null');
  } catch {}
  chartTabs = [];
  if (Array.isArray(raw)) {
    chartTabs = raw.filter((t) => t && typeof t === 'object' && t.id).map((t) => ({
      id: String(t.id),
      symbol: String(t.symbol || exDefaultSymbol()).toUpperCase(),
      tf: TFS.includes(String(t.tf || '').toUpperCase()) ? String(t.tf).toUpperCase() : 'M15',
      showLevels: t.showLevels !== false,
      showOrdLevels: t.showOrdLevels !== false,
      showAlertLevels: t.showAlertLevels !== false,
      showVolume: t.showVolume === true,
      risk: Number(t.risk) > 0 ? Number(t.risk) : 0,
      rr: Number(t.rr) > 0 ? Number(t.rr) : 0,
      maxSpread: Number(t.maxSpread) > 0 ? Number(t.maxSpread) : 0,
      evMin: Number(t.evMin) >= 0 && Number.isFinite(Number(t.evMin)) ? Number(t.evMin) : 0.05,
      evEnforce: t.evEnforce !== false,
      evProb: Number(t.evProb) > 0 && Number(t.evProb) <= 100 ? Number(t.evProb) : 50,
      skills: Array.isArray(t.skills) ? t.skills.map(String).filter(Boolean) : [],
      analyzeMin: Number.isFinite(Number(t.analyzeMin)) && Number(t.analyzeMin) >= 0 && Number(t.analyzeMin) <= 1440 ? Number(t.analyzeMin) : null,
      anaTf: t.anaTf && typeof t.anaTf === 'object' ? {
        mode: t.anaTf.mode === 'fixed' ? 'fixed' : 'auto',
        htf: tfNorm(t.anaTf.htf),
        etf: tfNorm(t.anaTf.etf),
        /* grafik TF'i otomatik değiştirilmez: sync her zaman kapalı */
        sync: false,
        dual: t.anaTf.dual === true,
      } : null,
      auto: normAuto(t.auto),
      /* sekmeye özel chat LLM: kapalıyken sohbet sütunu gizli + zamansal analiz çalışmaz */
      chatOff: t.chatOff === true,
    }));
  }
  if (!chartTabs.length) {
    chartTabs = [{
      id: 'tab-' + newId(),
      symbol: exDefaultSymbol(),
      tf: (TFS.includes(String(localStorage.getItem('jev.tf') || '').toUpperCase()) ? String(localStorage.getItem('jev.tf')).toUpperCase() : 'M15'),
      showLevels: localStorage.getItem('jev.showLevels') !== '0',
      showPosBox: localStorage.getItem('jev.showPosBox') === '1',
      showOrdLevels: localStorage.getItem('jev.showOrdLevels') !== '0',
      showAlertLevels: localStorage.getItem('jev.showAlertLevels') !== '0',
      showVolume: localStorage.getItem('jev.showVolume') === '1',
      risk: Number(String(localStorage.getItem('jev.risk') || '').replace(',', '.')) > 0 ? Number(String(localStorage.getItem('jev.risk') || '').replace(',', '.')) : 0,
      rr: 0,
      evMin: 0.05,
      evEnforce: true,
      evProb: 50,
      skills: [],
    }];
  }
  migrateBaseRisk2(chartTabs);
  activeTabId = localStorage.getItem(activeTabKey()) || '';
  if (!chartTabs.some((t) => t.id === activeTabId)) activeTabId = chartTabs[0].id;
  saveTabs();
}

/* eski taban risk varsayılanı %1 idi; %2 tabanına tek seferlik taşıma */
function migrateBaseRisk2(tabs) {
  try {
    if (localStorage.getItem('jev.risk.base2') === '1') return;
    localStorage.setItem('jev.risk.base2', '1');
    const v = Number(String(localStorage.getItem('jev.risk') || '').replace(',', '.'));
    if (v > 0 && v <= 1) localStorage.setItem('jev.risk', '2');
    for (const t of (tabs || [])) {
      const rv = Number(t && t.risk) || 0;
      if (rv > 0 && rv <= 1) t.risk = 2;
    }
  } catch {}
}

function tabsKey() { return TABS_KEY + '.' + exName; }
function activeTabKey() { return ACTIVE_TAB_KEY + '.' + exName; }
function exDefaultSymbol() {
  if (exName === 'binance') return 'BTCUSDT';
  if (exName === 'okx') return 'BTC-USDT-SWAP';
  return (localStorage.getItem('jev.symbol.mt5') || localStorage.getItem('jev.symbol') || 'EURUSD').toUpperCase();
}

function saveTabs() {
  try {
    const out = chartTabs.map((t) => ({
      id: t.id,
      symbol: t.symbol,
      tf: t.tf,
      showLevels: t.showLevels !== false,
      showOrdLevels: t.showOrdLevels !== false,
      showAlertLevels: t.showAlertLevels !== false,
      showVolume: t.showVolume === true,
      risk: Number(t.risk) > 0 ? Number(t.risk) : 0,
      rr: Number(t.rr) > 0 ? Number(t.rr) : 0,
      maxSpread: Number(t.maxSpread) > 0 ? Number(t.maxSpread) : 0,
      evMin: Number(t.evMin) >= 0 && Number.isFinite(Number(t.evMin)) ? Number(t.evMin) : 0.05,
      evEnforce: t.evEnforce !== false,
      evProb: Number(t.evProb) > 0 && Number(t.evProb) <= 100 ? Number(t.evProb) : 50,
      skills: Array.isArray(t.skills) ? t.skills.map(String).filter(Boolean) : [],
      /* sekmeye özel zamansal analiz sıklığı kalıcıydı ama serialize edilmiyordu
         → yeniden açılışta global varsayılana düşüyordu */
      analyzeMin: Number.isFinite(Number(t.analyzeMin)) && Number(t.analyzeMin) >= 0 && Number(t.analyzeMin) <= 1440 ? Number(t.analyzeMin) : null,
      /* sekmeye özel analiz zaman dilimi (üst → giriş, auto|fixed) */
      anaTf: t.anaTf && typeof t.anaTf === 'object' ? {
        mode: t.anaTf.mode === 'fixed' ? 'fixed' : 'auto',
        htf: tfNorm(t.anaTf.htf),
        etf: tfNorm(t.anaTf.etf),
        /* grafik TF'i otomatik değiştirilmez: sync her zaman kapalı */
        sync: false,
        dual: t.anaTf.dual === true,
      } : null,
      auto: normAuto(t.auto),
      /* sekmeye özel chat LLM: kapalıyken sohbet sütunu gizli + zamansal analiz çalışmaz */
      chatOff: t.chatOff === true,
    }));
    localStorage.setItem(tabsKey(), JSON.stringify(out));
    localStorage.setItem(activeTabKey(), activeTabId);
  } catch {}
}

function activeTab() {
  return chartTabs.find((t) => t.id === activeTabId) || chartTabs[0];
}

function sessionTabId(s) {
  const id = s && s.tabId ? String(s.tabId) : '';
  return chartTabs.some((t) => t.id === id) ? id : (chartTabs[0] ? chartTabs[0].id : '');
}

function tabSessions(tabId) {
  return sessions.filter((s) => sessionExOk(s) && sessionTabId(s) === tabId);
}

function updateActiveTabChart() {
  const t = activeTab();
  if (!t || !chartState.symbol) return;
  t.symbol = chartState.symbol;
  t.tf = chartState.tf;
  saveTabs();
}

function renderChartTabs() {
  const bar = $('#tabsBar');
  if (!bar) return;
  bar.innerHTML = '';
  for (const t of chartTabs) {
    const el = document.createElement('div');
    el.className = 'tab-item' + (t.id === activeTabId ? ' active' : '') + (tabChatOff(t) ? ' chat-off' : '');
    const skn = Array.isArray(t.skills) ? t.skills.length : 0;
    el.title = t.symbol + ' · ' + t.tf + ' — ' + tabSessions(t.id).length + ' sohbet' + (skn ? ' · ' + skn + ' skill' : '') + (tabChatOff(t) ? ' · chat LLM KAPALI' : '');
    el.innerHTML =
      '<span class="tab-sym">' + escapeHtml(t.symbol) + '</span>' +
      '<span class="tab-tf">' + escapeHtml(t.tf) + '</span>' +
      '<button class="tab-chat' + (tabChatOff(t) ? ' off' : '') + '" title="' + (tabChatOff(t) ? 'Chat LLM KAPALI — zamansal analiz çalışmaz (açmak için bas)' : 'Chat LLM açık (kapatmak için bas)') + '">' + TAB_CHAT_SVG + '</button>' +
      '<button class="tab-close" title="Sekmeyi kapat">✕</button>';
    el.addEventListener('click', () => switchChartTab(t.id));
    const cb = el.querySelector('.tab-chat');
    if (cb) {
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleTabChat(t.id);
      });
    }
    const x = el.querySelector('.tab-close');
    let armed = false;
    let armTimer = null;
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = tabSessions(t.id).length;
      if (!armed && n > 0 && chartTabs.length > 1) {
        armed = true;
        el.classList.add('arming');
        x.title = 'Tekrar bas: sekme ve ' + n + ' sohbet silinecek';
        toast('Sekmeyi ve ' + n + ' sohbeti silmek için ✕ e tekrar bas');
        clearTimeout(armTimer);
        armTimer = setTimeout(() => {
          armed = false;
          el.classList.remove('arming');
          x.title = 'Sekmeyi kapat';
        }, 3000);
        return;
      }
      closeChartTab(t.id);
    });
    bar.appendChild(el);
  }
  const add = document.createElement('button');
  add.id = 'tabAdd';
  add.title = 'Yeni grafik sekmesi';
  add.textContent = '+';
  add.addEventListener('click', addChartTab);
  bar.appendChild(add);
}

function applyTabToChart(t) {
  /* yeni sekmenin sembolünün kayıtlı görünümü gelsin */
  chartState.rates = [];
  chartState.symbol = t.symbol;
  chartState.tick = null;
  chartState.tickSpread = 0;
  chartState.tickPoint = 0;
  $('#chartSymbol').value = t.symbol;
  try { localStorage.setItem('jev.symbol', t.symbol); } catch {}
  try { localStorage.setItem('jev.symbol.' + exName, t.symbol); } catch {}
  chartState.tf = t.tf;
  try { localStorage.setItem('jev.tf', t.tf); } catch {}
  /* sekmeye özel ayarlar */
  chartState.showLevels = t.showLevels !== false;
  chartState.showOrdLevels = t.showOrdLevels !== false;
  chartState.showAlertLevels = t.showAlertLevels !== false;
  chartState.showVolume = t.showVolume === true;
  const lvb = $('#levelsBtn');
  if (lvb) lvb.classList.toggle('active', chartState.showLevels);
  const olvb = $('#ordLevelsBtn');
  if (olvb) olvb.classList.toggle('active', chartState.showOrdLevels);
  const alvb = $('#alertLevelsBtn');
  if (alvb) alvb.classList.toggle('active', chartState.showAlertLevels);
  const vvb = $('#volBtn');
  if (vvb) vvb.classList.toggle('active', chartState.showVolume);
  buildTfRow();
  loadDrawings();
  selectedPlanId = '';
  applyPlanButtons();
  loadRates();
  ctxCache.clear();
}

function switchChartTab(id) {
  if (!id || id === activeTabId) return;
  /* eski sekmenin görünümünü kaydet */
  saveViewState();
  updateActiveTabChart();
  activeTabId = id;
  const t = activeTab();
  saveTabs();
  applyTabToChart(t);
  applyTabChat();
  applyJevTimers();
  const list = tabSessions(id);
  activeSid = list.length ? list[list.length - 1].id : '';
  renderChartTabs();
  renderSessions();
  renderMsgs();
  toast('Sekme: ' + t.symbol + ' ' + t.tf);
}

function addChartTab() {
  updateActiveTabChart();
  const t = { id: 'tab-' + newId(), symbol: chartState.symbol, tf: chartState.tf };
  chartTabs.push(t);
  saveTabs();
  switchChartTab(t.id);
}

function closeChartTab(id) {
  if (chartTabs.length <= 1) { toast('En az bir sekme kalmalı'); return; }
  /* önce oturumları belirle (sekme listeden çıkmadan) */
  const removeIds = sessions.filter((s) => sessionTabId(s) === id).map((s) => s.id);
  const n = removeIds.length;
  chartTabs = chartTabs.filter((t) => t.id !== id);
  sessions = sessions.filter((s) => !removeIds.includes(s.id));
  saveSessions();
  if (activeSid && removeIds.includes(activeSid)) activeSid = '';
  if (activeTabId === id) {
    activeTabId = chartTabs[0].id;
    applyTabToChart(activeTab());
    applyTabChat();
    const list = tabSessions(activeTabId);
    activeSid = list.length ? list[list.length - 1].id : '';
    applyJevTimers();
  }
  saveTabs();
  renderChartTabs();
  renderSessions();
  renderMsgs();
  toast(n ? 'Sekme kapatıldı (' + n + ' sohbet silindi)' : 'Sekme kapatıldı');
}

/* ---------- render ---------- */
function renderSessions() {
  const list = $('#sessList');
  list.innerHTML = '';
  for (const s of tabSessions(activeTabId)) {
    const row = document.createElement('div');
    row.className = 'sess-row' + (s.id === activeSid ? ' active' : '');
    row.title = s.title;
    const initial = (String(s.title || '').trim().charAt(0) || '•').toUpperCase();
    row.innerHTML =
      '<span class="sess-avatar">' + escapeHtml(initial) + '</span>' +
      '<span class="sess-title">' + escapeHtml(s.title) + '</span>' +
      '<button class="sess-del" title="Sil">✕</button>';
    row.addEventListener('click', () => { activeSid = s.id; renderSessions(); renderMsgs(); });
    row.querySelector('.sess-del').addEventListener('click', (e) => {
      e.stopPropagation();
      sessions = sessions.filter((x) => x.id !== s.id);
      if (activeSid === s.id) activeSid = '';
      saveSessions();
      renderSessions();
      renderMsgs();
    });
    list.appendChild(row);
  }
  renderChartTabs();
}

function renderMsgs() {
  const s = activeSession();
  $('#empty').style.display = s && s.messages.length ? 'none' : '';
  const wrap = $('#msgs');
  wrap.innerHTML = '';
  if (!s) return;
  for (const m of s.messages) {
    const isEvent = m.role === 'user' && /^\[(OTOMATİK|ZAMANSAL ANALİZ)/.test(String(m.content || ''));
    wrap.appendChild(msgEl(isEvent ? 'event' : m.role, m.content, false, m.t));
  }
  $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;
}

/* ---------- sol panel daralt/geri aç ---------- */
function applySidebarCollapsed() {
  const c = localStorage.getItem('jev.sideCollapsed') === '1';
  $('#sidebar').classList.toggle('collapsed', c);
  $('#sideCollapse').title = c ? 'Sohbet geçmişini genişlet' : 'Sohbet geçmişini daralt';
}

/* ---------- sohbet panelini gizle (tam grafik) ---------- */
function applyChatCollapsed() {
  const c = localStorage.getItem('jev.chatHidden') === '1';
  $('#split').classList.toggle('chatCollapsed', c);
  $('#chatCollapseBtn').classList.toggle('active', c);
  $('#chatCollapseBtn').title = c ? 'Sohbet panelini göster' : 'Sohbet panelini gizle (tam grafik)';
  drawChart();
}

/* ---------- sekmeye özel chat LLM ----------
   Her grafik sekmesinde chat LLM ayrı açılıp kapatılabilir (sekmelerin
   sohbetleri zaten ayrıdır). Kapalıyken: sohbet sütunu tamamen gizlenir ve
   ZAMANSAL ANALİZ (sohbet LLM zamanlayıcısı) o sekmede çalışmaz. */
const TAB_CHAT_SVG = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

function tabChatOff(t) {
  return !!(t && t.chatOff === true);
}

function applyTabChat() {
  const off = tabChatOff(activeTab());
  const split = $('#split');
  if (split) split.classList.toggle('chatTabOff', off);
  const btn = $('#chatCollapseBtn');
  if (btn) {
    btn.disabled = off;
    btn.title = off ? 'Bu sekmede chat LLM kapalı — sekmedeki 💬 ile aç' : 'Sohbet panelini gizle (tam grafik)';
  }
  drawChart();
}

function toggleTabChat(id) {
  const t = chartTabs.find((x) => x.id === id);
  if (!t) return;
  t.chatOff = !tabChatOff(t);
  saveTabs();
  if (t.id === activeTabId) {
    applyJevTimers(); /* zamansal analiz zamanlayıcısı yeni duruma göre kurulur */
    applyTabChat();
    renderJevLog();
  }
  renderChartTabs();
  toast('Sekme chat LLM ' + (tabChatOff(t) ? 'KAPALI — zamansal analiz çalışmaz' : 'AÇIK'));
}

function fmtMsgTime(ms) {
  const d = new Date(Number(ms) || Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  return p2(d.getHours()) + ':' + p2(d.getMinutes());
}

function fmtMsgTimeFull(ms) {
  const d = new Date(Number(ms) || Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

function msgEl(role, content, isError, t) {
  const div = document.createElement('div');
  const kind = role === 'event' ? 'event' : role === 'user' ? 'user' : 'assistant';
  div.className = 'msg ' + kind;
  const timeHtml = t ? '<span class="msg-time" title="' + fmtMsgTimeFull(t) + '">' + fmtMsgTime(t) + '</span>' : '';
  div.innerHTML =
    '<span class="msg-role">' + (role === 'event' ? 'Otomatik' : role === 'user' ? 'Sen' : 'LLM') + '</span>' +
    '<div class="msg-body' + (isError ? ' error' : '') + '">' + escapeHtml(content) + '</div>' +
    timeHtml;
  return div;
}

function applyState() {
  const am = state.activeModel;
  $('#modelBtnLabel').textContent = am ? am.model : 'Model seç';
  const lv = THINK_LEVELS[Number(state.thinkLevel) || 0] || THINK_LEVELS[0];
  const thinkBtn = $('#thinkBtn');
  if (thinkBtn) {
    $('#thinkBtnLabel').textContent = lv.label;
    thinkBtn.title = 'Düşünme (reasoning) seviyesi: ' + lv.label + ' — ' + lv.desc;
  }
}

function effectiveModelSel() {
  return state.activeModel ? state.activeModel.providerId + '::' + state.activeModel.model : '';
}

/* ---------- borsa bazlı sohbet LLM'i: her borsa kendi modelini hatırlar ---------- */
function exModelKey(name) {
  return 'jev.model.' + String(name || exName);
}

function saveExModel(name) {
  const am = state.activeModel;
  if (!am || !am.providerId || !am.model) return;
  try { localStorage.setItem(exModelKey(name), am.providerId + '::' + am.model); } catch {}
}

async function applyExModel(name) {
  let sel = '';
  try { sel = localStorage.getItem(exModelKey(name)) || ''; } catch {}
  if (!sel) return;
  const res = await jev.setModel(sel).catch(() => null);
  if (res && res.ok) {
    state.activeModel = res.activeModel;
    applyState();
  }
}

/* ---------- model dropdown ---------- */
function renderModelMenu(filter) {
  const list = $('#modelList');
  list.innerHTML = '';
  const f = String(filter || '').toLowerCase();
  const rows = [];
  for (const p of state.providers || []) {
    for (const m of p.models || []) {
      if (f && !(m.toLowerCase().includes(f) || p.name.toLowerCase().includes(f))) continue;
      rows.push({ sel: p.id + '::' + m, label: p.name + ' · ' + m, prov: p.name, model: m });
    }
  }
  if (!rows.length) {
    list.innerHTML = '<div class="dd-empty">Model yok — Ayarlar → Provider sekmesinden ekle</div>';
    return;
  }
  const cur = effectiveModelSel();
  for (const r of rows) {
    const btn = document.createElement('button');
    btn.className = 'dd-item' + (r.sel === cur ? ' active' : '');
    btn.title = r.label;
    btn.innerHTML =
      '<span class="dd-prov">' + escapeHtml(r.prov) + '</span>' +
      '<span class="dd-model">' + escapeHtml(r.model) + '</span>';
    btn.addEventListener('click', async () => {
      const res = await jev.setModel(r.sel);
      if (res && res.ok) {
        state.activeModel = res.activeModel;
        applyState();
        saveExModel();
        toast('Model: ' + r.label);
      }
      $('#modelMenu').hidden = true;
    });
    list.appendChild(btn);
  }
}

/* ---------- düşünme (reasoning) seviyesi dropdown ---------- */
function renderThinkMenu() {
  const list = $('#thinkList');
  if (!list) return;
  const cur = Number.isFinite(Number(state.thinkLevel)) ? Number(state.thinkLevel) : 0;
  list.innerHTML = '';
  for (const lv of THINK_LEVELS) {
    const btn = document.createElement('button');
    btn.className = 'dd-item' + (cur === lv.v ? ' active' : '');
    btn.title = lv.label + ' — ' + lv.desc;
    btn.innerHTML =
      '<span class="think-lv">' +
      '<span class="tv">' + lv.v + '</span>' +
      '<span class="tl">' + escapeHtml(lv.label) + '</span>' +
      '<span class="td">' + escapeHtml(lv.desc) + '</span>' +
      '</span>';
    btn.addEventListener('click', async () => {
      const res = await jev.setThinkLevel(lv.v).catch(() => null);
      if (res && res.ok) {
        state.thinkLevel = Number(res.thinkLevel) || 0;
        applyState();
        toast('Düşünme seviyesi: ' + lv.label);
      }
      $('#thinkMenu').hidden = true;
    });
    list.appendChild(btn);
  }
}

/* picker'ın yanındaki ⟳: her sağlayıcının /models ucundan güncel listeyi
   yeniden çeker. Elle eklenmiş/kayıtlı modeller korunur, yeni gelenler eklenir. */
let modelRefreshBusy = false;

async function refreshModelList() {
  if (modelRefreshBusy) return;
  const provs = (state.providers || []).filter((p) => p && p.baseUrl);
  if (!provs.length) {
    toast('Provider yok — Ayarlar → Provider sekmesinden ekle');
    return;
  }
  modelRefreshBusy = true;
  const btn = $('#modelRefreshBtn');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('spin');
    btn.title = 'Güncel modeller çekiliyor…';
  }
  try {
    const results = await Promise.all(provs.map(async (p) => {
      const r = await jev.fetchModels({ baseUrl: p.baseUrl, key: p.key || '' }).catch(() => null);
      return { p, r };
    }));
    let added = 0;
    let okCount = 0;
    let firstErr = '';
    for (const { p, r } of results) {
      if (!r || !r.ok) {
        if (!firstErr) firstErr = (r && r.error) || 'yanıt yok';
        continue;
      }
      okCount++;
      const set = new Set((p.models || []).map(String));
      for (const m of r.models || []) {
        const v = String(m || '').trim();
        if (v && !set.has(v)) { set.add(v); added++; }
      }
      p.models = [...set].sort((a, b) => a.localeCompare(b));
    }
    if (!okCount) {
      toast('Model listesi alınamadı — ' + (firstErr || 'bilinmeyen hata'));
      return;
    }
    await jev.setProviders(state.providers).catch(() => null);
    state = await jev.getSettings().catch(() => state);
    applyState();
    if (!$('#modelMenu').hidden) renderModelMenu($('#modelFilter').value || '');
    const failN = provs.length - okCount;
    toast(
      (added ? added + ' yeni model eklendi' : 'Modeller güncel') +
      ' · ' + okCount + '/' + provs.length + ' sağlayıcı' +
      (failN ? ' · ' + failN + ' sağlayıcıya ulaşılamadı' : '')
    );
  } finally {
    modelRefreshBusy = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('spin');
      btn.title = 'Güncel modelleri sağlayıcılardan yeniden çek';
    }
  }
}

/* ---------- chat ---------- */
function setBusy(b) {
  $('#sendBtn').hidden = b;
  $('#stopBtn').hidden = !b;
  document.querySelectorAll('.quick-msg').forEach((el) => { el.disabled = b; });
}

/* akışlı yanıt: main'den gelen parçalar aktif mesaj balonuna anında yazılır */
const chatStreams = new Map(); /* requestId -> { raw, body } */

/* akış sırasında komut blokları gizlenir (tamamlanınca applyJevCommands temizler) */
function streamDisplayText(raw) {
  let t = String(raw || '').replace(/<<[A-Z_]+[\s\S]*?>>/g, '');
  const i = t.lastIndexOf('<<');
  if (i >= 0 && t.indexOf('>>', i) < 0) t = t.slice(0, i);
  return t;
}

function chatStreamDelta(d) {
  const st = d && chatStreams.get(String(d.requestId || ''));
  if (!st) return;
  st.raw += String(d.text || '');
  const el = st.body;
  if (!el) return;
  el.textContent = streamDisplayText(st.raw) || '▊';
  const sc = $('#chatScroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
}

/* ---------- slash komutları (sohbet kutusu) ---------- */
function openSlashHelp() {
  const el = $('#slashOverlay');
  if (el) el.hidden = false;
}

function closeSlashHelp() {
  const el = $('#slashOverlay');
  if (el) el.hidden = true;
}

function newChatSession() {
  const s = { id: newId(), title: 'Yeni Sohbet', messages: [], tabId: activeTabId, ex: exName };
  sessions.unshift(s);
  activeSid = s.id;
  saveSessions();
  renderSessions();
  renderMsgs();
  return s;
}

/* /clear: TÜM sohbet geçmişini siler (tüm sekmeler/borsalar) */
function clearAllChats() {
  if (pendingChatId) { try { jev.chatStop(pendingChatId); } catch {} }
  sessions = [];
  activeSid = '';
  saveSessions();
  renderSessions();
  renderMsgs();
  toast('Tüm sohbet geçmişi silindi');
  jevLogAdd('SOHBET · /clear · tüm sohbet geçmişi silindi', 'cmd');
}

function handleSlashCommand(raw) {
  const cmd = String(raw || '').trim().toLowerCase().split(/\s+/)[0];
  if (cmd === '/help' || cmd === '/yardim' || cmd === '/yardım' || cmd === '/?') { openSlashHelp(); return; }
  if (cmd === '/clear' || cmd === '/temizle') { clearAllChats(); return; }
  if (cmd === '/new' || cmd === '/yeni') { newChatSession(); toast('Yeni sohbet açıldı'); return; }
  if (cmd === '/stop' || cmd === '/durdur') {
    if (pendingChatId) { try { jev.chatStop(pendingChatId); } catch {} toast('İstek durduruluyor…'); }
    else toast('Süren istek yok');
    return;
  }
  toast('Bilinmeyen komut: ' + cmd + ' — /help yaz');
}

/* ---------- bağlam sıkıştırma (opencode tarzı): eski mesajlar özetlenir, geçmiş unutulmaz ----------
   Geçmiş append-only tutulur (cache dostu); tetikleyici boyut aşılınca eski mesajlar tek bir
   özete indirilir ve özet system bloğuna eklenir. Böylece bağlam şişmez, prefix cache korunur. */
const CHAT_COMPACT_TRIGGER_CHARS = 60000;  /* özet dışı geçmiş bu boyutu aşınca sıkıştır */
const CHAT_COMPACT_KEEP_CHARS = 28000;     /* özet sonrası son mesajlardan korunacak metin */
const CHAT_COMPACT_MIN_KEEP = 8;           /* en az korunacak mesaj sayısı */
const CHAT_COMPACT_MAX_KEEP = 40;          /* en çok korunacak mesaj sayısı */
const CHAT_HIST_FALLBACK = 30;             /* sıkıştırma başarısızsa gönderilecek son mesaj sayısı */
const CHAT_COMPACT_HEAD_MAX = 60;          /* tek seferde özetlenecek en fazla mesaj — daha eskiler bağlama alınmaz */
const CHAT_COMPACT_HEAD_CHARS = 120000;    /* özetleme girdisi üst sınırı (çok eski mesajlar atlanır) */
const CHAT_KEEP_MS = 24 * 60 * 60 * 1000;  /* her sekmedeki sohbette tutulacak geçmiş: yalnız son 24 saat */
const compactingSessions = new Set();

const CHAT_COMPACT_PROMPT = [
  'Sen JevTrader sohbet asistanının bağlam sıkıştırıcısısın.',
  'Aşağıdaki konuşma geçmişini (ve varsa önceki özeti) TEK bir özet halinde birleştir.',
  'Yanıtın yalnızca şu Markdown bölümlerinden oluşsun (hepsi zorunlu):',
  '## Amaç ve Strateji',
  '## Kullanıcı Tercihleri ve Kurallar',
  '## Kararlar ve Analizler (sembol, zaman dilimi, sonuç)',
  '## Seviyeler (destek/direnç, giriş/SL/TP, alarmlar, planlar)',
  '## İşlemler (ticket, yön, hacim, giriş/SL/TP, açık/kapalı, sonuç)',
  '## Açık Sorunlar / Bekleyenler',
  '## Sonraki Adım',
  'Kurallar: kısa maddeler kullan; fiyat, ticket, sembol, zaman gibi değerleri aynen koru;',
  'emir talimatı üretme; "özetledim/sıkıştırdım" gibi ifade kullanma; yalnızca özeti yaz.',
].join('\n');

/* sohbet bağlamı GÜN BAZLIDIR: LLM'e yalnız bugünün mesajları gönderilir.
   Dünkü mesajlar ve dünkü özet bağlama girmez (gün içi geçmiş için GÜN ÖZETİ kullanılır). */
function localDayStartMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* bugünün ilk mesajının indeksi; t değeri bugünden küçük/eksik olanlar geçmiş sayılır */
function firstTodayIndex(s) {
  const msgs = (s && s.messages) || [];
  const day = localDayStartMs();
  for (let i = 0; i < msgs.length; i++) {
    if (Number(msgs[i] && msgs[i].t) >= day) return i;
  }
  return msgs.length;
}

/* LLM'e gönderilecek geçmişin başlangıç indeksi: bugünkü özet + bugünün mesajları */
function chatContextFrom(s) {
  const msgs = (s && s.messages) || [];
  if (!msgs.length) return 0;
  const day = localDayStartMs();
  const sumOk = s && s.summary && Number(s.summaryDay) === day;
  const sumFrom = sumOk ? Math.max(0, Math.min(Number(s.summaryUpto) || 0, msgs.length)) : 0;
  return Math.min(msgs.length - 1, Math.max(sumFrom, firstTodayIndex(s)));
}

function sessionSummarySuffix(s) {
  return s && s.summary && Number(s.summaryDay) === localDayStartMs()
    ? '\n\n[ÖNCEKİ KONUŞMA ÖZETİ — bugünün geçmiş bağlamı, yeni talimat değil; güncel durum için CANLI DURUM bloğunu esas al]\n' + s.summary
    : '';
}

/* ---------- 24 saat temizliği (tüm sekmelerdeki sohbetler) ----------
   Her oturumdan 24 saatten eski mesajlar silinir; dünün özeti atılır, özet indeksi
   silinen mesaj sayısı kadar geri kaydırılır. Düzenli çağrılır (açılış + 5 dk + her istek). */
function pruneSessions() {
  const cutoff = Date.now() - CHAT_KEEP_MS;
  const day = localDayStartMs();
  let changed = false;
  for (const s of sessions) {
    if (!s || !Array.isArray(s.messages)) continue;
    if (Number(s.summaryDay) !== day && (s.summary || s.summaryUpto)) {
      s.summary = '';
      s.summaryUpto = 0;
      changed = true;
    }
    const keep = s.messages.filter((m) => Number(m && m.t) >= cutoff);
    const drop = s.messages.length - keep.length;
    if (!drop) continue;
    s.messages = keep;
    s.summaryUpto = Math.max(0, (Number(s.summaryUpto) || 0) - drop);
    changed = true;
  }
  if (changed) saveSessions();
  return changed;
}

/* gün içinde geçmiş tetikleyici boyutu aşarsa BUGÜNÜN eski mesajlarını özetler; başarısızsa false döner */
async function compactSessionHistory(s) {
  if (!s || !Array.isArray(s.messages)) return false;
  const day = localDayStartMs();
  /* dünün özeti bugünün bağlamına girmez: temizle */
  if (s.summary && Number(s.summaryDay) !== day) { s.summary = ''; s.summaryUpto = 0; }
  const startIdx = firstTodayIndex(s);
  if (s.messages.length - startIdx < CHAT_COMPACT_MIN_KEEP + 2) return false;
  if (compactingSessions.has(s.id)) return false;
  const candidates = s.messages.slice(startIdx, -1);  /* yalnız bugün; yeni gelen mesaj özetlenmez */
  const chars = candidates.reduce((a, m) => a + String((m && m.content) || '').length, 0);
  if (chars < CHAT_COMPACT_TRIGGER_CHARS) return false;
  if (s.compactFailAt && Date.now() - Number(s.compactFailAt) < 600000) return false;  /* 10 dk tekrar deneme yok */
  /* son mesajlardan korunacak kısmı seç (opencode: tail korunur, gerisi özetlenir) */
  let keepFrom = candidates.length;
  let keepChars = 0;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const len = String((candidates[i] && candidates[i].content) || '').length;
    const kept = candidates.length - i;
    if (kept > CHAT_COMPACT_MAX_KEEP) break;
    if (keepChars + len > CHAT_COMPACT_KEEP_CHARS && kept > CHAT_COMPACT_MIN_KEEP) break;
    keepChars += len;
    keepFrom = i;
  }
  const head = candidates.slice(0, keepFrom);
  if (!head.length) return false;
  /* ÜST SINIR: tek seferde en fazla CHAT_COMPACT_HEAD_MAX mesaj özetlenir;
     daha eski mesajlar bağlama/özetlemeye ALINMAZ (yalnız not düşülür). */
  const skippedOld = Math.max(0, head.length - CHAT_COMPACT_HEAD_MAX);
  const headUse = skippedOld ? head.slice(-CHAT_COMPACT_HEAD_MAX) : head;
  let conv = headUse
    .map((m) => (m.role === 'assistant' ? '[Asistan]: ' : '[Kullanıcı]: ') + String((m && m.content) || '').slice(0, 2000))
    .join('\n');
  if (conv.length > CHAT_COMPACT_HEAD_CHARS) conv = '[...daha eski mesajlar atlandı...]\n' + conv.slice(-CHAT_COMPACT_HEAD_CHARS);
  if (skippedOld) conv = '[...' + skippedOld + ' çok eski mesaj atlandı — bağlama alınmadı...]\n' + conv;
  const userPrompt = CHAT_COMPACT_PROMPT +
    (s.summary ? '\n\n<onceki-ozet>\n' + s.summary + '\n</onceki-ozet>' : '') +
    '\n\n<konusma>\n' + conv + '\n</konusma>';
  compactingSessions.add(s.id);
  toast('Bağlam sıkıştırılıyor… (' + headUse.length + ' eski mesaj özetleniyor' + (skippedOld ? ' · ' + skippedOld + ' çok eski mesaj atlandı' : '') + ')');
  jevLogAdd('BAĞLAM SIKIŞTIRMA · istek · ' + headUse.length + ' mesaj' + (skippedOld ? ' (' + skippedOld + ' çok eski atlandı)' : '') + ' · ~' + Math.round(chars / 1000) + 'k karakter', 'req');
  let res = null;
  try {
    res = await jev.chatSend({
      requestId: 'compact-' + s.id + '-' + Date.now(),
      sessionId: s.id,
      messages: [
        { role: 'system', content: 'Sen bir bağlam sıkıştırma aracısısın. Yalnızca istenen Markdown özetini üretirsin.' },
        { role: 'user', content: userPrompt },
      ],
    });
  } catch { res = null; } finally {
    compactingSessions.delete(s.id);
  }
  const text = res && res.ok ? String(res.text || '').trim() : '';
  if (!text) {
    s.compactFailAt = Date.now();
    jevLogAdd('BAĞLAM SIKIŞTIRMA · başarısız' + ((res && res.error) ? ' · ' + res.error : '') + ' — son ' + CHAT_HIST_FALLBACK + ' mesaj gönderilecek', 'err');
    return false;
  }
  s.summary = text.slice(0, 8000);
  s.summaryUpto = startIdx + keepFrom;
  s.summaryDay = day;
  s.compactFailAt = 0;
  saveSessions();
  jevLogAdd('BAĞLAM SIKIŞTIRMA · ' + headUse.length + ' mesaj özetlendi' + (skippedOld ? ' (' + skippedOld + ' çok eski atlandı)' : '') + ' · özet ' + s.summary.length + ' karakter · son ' + (s.messages.length - s.summaryUpto) + ' mesaj aynen', 'cmd');
  return true;
}

/* Bağlam kurulmadan önce işlem durumunu tazele: açık pozisyonlar, bekleyen emirler ve
   kapanan işlemler borsadan yeniden çekilir; LLM eski/yanlış durumu görmez. */
async function refreshTradeStateForContext() {
  /* paralel: ilk yanıt gecikmesini kısaltır (biri yavaşsa diğerleri beklemez) */
  await Promise.all([
    refreshPositions().catch(() => {}),
    refreshOrders().catch(() => {}),
    refreshClosed().catch(() => {}),
  ]);
}

/* Jev'e giden isteği hazırla: sistem promptu + canlı grafik bağlamı + opsiyonel ekran görüntüsü */
async function buildChatPayload(s) {
  pruneSessions();
  await compactSessionHistory(s).catch(() => false);
  await refreshTradeStateForContext();
  /* analiz zaman dilimi çifti önce çözülür: prompt, mum verisi, ekran görüntüsü
     ve çizimler TEK bir TF çiftinde hizalanır */
  const ana = await resolveAnaTfs().catch(() => null);
  const ctx = await buildChartContext(ana).catch(() => 'grafik bağlamı alınamadı');
  const guard = posGuardPromptBlock();
  const dayg = dayGuardPromptBlock(await dayGuardState().catch(() => null));
  const sys = JEV_SYSTEM_PROMPT + anaTfPromptBlock(ana) + guard + dayg + scalpPromptBlock() +
    tradeHoursPromptBlock() + skillsPromptBlock() +
    '\n\n[GRAFİK BAĞLAMI]\n' + ctx + sessionSummarySuffix(s);
  /* yalnız BUGÜNÜN mesajları + bugünün özeti gönderilir; dün ve öncesi bağlama girmez.
     güvenlik tavanı: sıkıştırma başarısız olursa aşırı büyümeyi engelle */
  const from = chatContextFrom(s);
  let histMsgs = s.messages.slice(from, -1);
  if (histMsgs.length > CHAT_HIST_FALLBACK * 2) histMsgs = histMsgs.slice(-CHAT_HIST_FALLBACK);
  const history = histMsgs.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 4000),
  }));
  const lastText = String((s.messages[s.messages.length - 1] || {}).content || '');
  const messagesNoShot = [{ role: 'system', content: sys }, ...history, { role: 'user', content: lastText }];
  /* ekran görüntüsü + arka plan çoklu TF görüntüleri (görünür grafik bozulmadan) */
  const shots = [];
  if (attachShotOn()) {
    const vis = captureChartShot();
    if (vis) shots.push({ tf: chartState.tf, symbol: chartState.symbol, data: vis, label: 'ekran · çizimler dahil' });
    const multi = await captureMultiTfShots(ana, vis ? [chartState.tf] : []).catch(() => []);
    for (const x of multi) shots.push(x);
  }
  if (!shots.length) {
    return { requestId: pendingChatId, sessionId: s.id, messages: messagesNoShot, messagesNoShot, usedShot: false };
  }
  const labels = shots.map((x, i) => (i + 1) + ') ' + x.symbol + ' ' + x.tf +
    (x.label ? ' (' + x.label + ')' : ' (arka plan)')).join(' | ');
  const messages = [{ role: 'system', content: sys }, ...history, {
    role: 'user',
    content: [
      { type: 'text', text: lastText + '\n\n[GRAFİK GÖRÜNTÜLERİ] ' + labels },
      ...shots.map((x) => ({ type: 'image_url', image_url: { url: x.data } })),
    ],
  }];
  return { requestId: pendingChatId, sessionId: s.id, messages, messagesNoShot, usedShot: true };
}

async function sendMessage(textArg, origin) {
  const fromInput = typeof textArg !== 'string';
  const autoKind = origin === 'timed' ? 'ZAMANSAL' : origin === 'alert' ? 'ALARM' : origin === 'trade' ? 'İŞLEM' : origin === 'evolve' ? 'GELİŞİM' : '';
  const input = $('#input');
  const text = (fromInput ? input.value : textArg).trim();
  if (!text) return;
  /* slash komutları (/help, /clear, ...): LLM'e gönderilmez */
  if (fromInput && text.startsWith('/')) {
    input.value = '';
    autoGrow(input);
    handleSlashCommand(text);
    return;
  }
  if (!state.activeModel) {
    toast('Önce model seç — sol üstteki Model düğmesi ya da Ayarlar → Provider');
    return;
  }
  const s = ensureSession();
  if (s.title === 'Yeni Sohbet') {
    s.title = text.slice(0, 40);
    renderSessions();
  }
  s.messages.push({ role: 'user', content: text, t: Date.now() });
  if (fromInput) {
    input.value = '';
    autoGrow(input);
  }
  renderMsgs();
  saveSessions();

  const holder = msgEl('assistant', '');
  const body = holder.querySelector('.msg-body');
  body.innerHTML = '<span class="cursor">▊</span>';
  $('#msgs').appendChild(holder);
  $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;

  pendingChatId = newId();
  const streamKey = pendingChatId;
  chatStreams.set(streamKey, { raw: '', body });
  jevChatStartedAt = Date.now();
  setBusy(true);
  const payload = await buildChatPayload(s);
  if (autoKind) {
    jevLogAdd('LLM ANALİZ İSTEĞİ · ' + (autoKind === 'ZAMANSAL' ? jevAnalyzeMin() + ' dk periyot' : autoKind.toLowerCase()) + (payload.usedShot ? ' (görselli)' : ''), 'req');
  } else {
    jevLogAdd('İSTEK' + (payload.usedShot ? ' (grafik görüntülü)' : '') + ' · ' + text.replace(/\s+/g, ' ').slice(0, 220), 'req');
  }
  let res = await jev.chatSend(payload);
  if (res && !res.ok && !res.aborted && payload.usedShot) {
    toast('Görüntü gönderilemedi — metin bağlamıyla yeniden deneniyor');
    const st = chatStreams.get(streamKey);
    if (st) st.raw = '';
    res = await jev.chatSend({ requestId: streamKey, sessionId: s.id, messages: payload.messagesNoShot });
  }
  chatStreams.delete(streamKey);
  setBusy(false);
  pendingChatId = '';

  if (res && res.ok) {
    /* otomatik akışın zincir (LOOK/WEB/FILE) cevapları da entegrasyonlara gitsin */
    const outKind = autoKind || (intgMirrorDeskOn() ? 'MASAÜSTÜ' : '');
    let outText = '';
    chainAutoKind = outKind;
    try {
      outText = await applyJevCommands(res.text || '');
    } finally {
      chainAutoKind = '';
    }
    body.textContent = outText || '(boş yanıt)';
    const tNow = Date.now();
    s.messages.push({ role: 'assistant', content: outText, t: tNow });
    /* entegrasyon sohbetlerine dağıt (zamansal analiz / alarm / işlem / gelişim) */
    intgDeliverSessionOutput(s, outKind, outKind === 'MASAÜSTÜ' ? '❓ ' + text + '\n\n' + (outText || '(boş yanıt)') : outText);
    const tEl = document.createElement('span');
    tEl.className = 'msg-time';
    tEl.title = fmtMsgTimeFull(tNow);
    tEl.textContent = fmtMsgTime(tNow);
    holder.appendChild(tEl);
    if (autoKind) {
      jevLogAdd('LLM ANALİZ (' + autoKind.toLowerCase() + ') · ' + (outText || '(boş yanıt)').replace(/\s+/g, ' ').slice(0, 600), 'analiz');
    } else {
      jevLogAdd('YANIT · ' + (outText || '(boş yanıt)').replace(/\s+/g, ' ').slice(0, 260), 'res');
    }
  } else if (res && res.aborted) {
    body.textContent = '(durduruldu)';
    jevLogAdd('İSTEK DURDURULDU', 'err');
  } else {
    body.textContent = 'HATA: ' + ((res && res.error) || 'bilinmeyen');
    body.classList.add('error');
    jevLogAdd('HATA · ' + ((res && res.error) || 'bilinmeyen'), 'err');
  }
  saveSessions();
  $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;
  /* sohbet boşaldı: kuyrukta bekleyen otomatik bildirimleri sırayla gönder */
  jevAlertScheduleFlush(800);
  const q = jevTradePending;
  if (q && !jevTradeBusy) {
    jevTradePending = null;
    setTimeout(() => jevNotifyTrade(q.kind, q.lines), 1500);
  }
}

/* ---------- ayarlar: provider ---------- */
async function renderProviderPane() {
  const pane = $('#tab-provider');
  state = await jev.getSettings();
  applyState();

  pane.innerHTML = '<h2>Provider</h2><div class="sub">API sağlayıcıları ekle, modelleri çek, aktif modeli seç. Hepsi OpenAI-uyumlu.</div>';

  for (const p of state.providers || []) {
    for (const m of p.models || []) {
      const row = document.createElement('div');
      row.className = 'prov-row' + (effectiveModelSel() === p.id + '::' + m ? ' active' : '');
      row.innerHTML =
        '<span class="prov-name">' + escapeHtml(p.name) + '</span>' +
        '<span class="prov-model">' + escapeHtml(m) + '</span>' +
        '<span class="check">✓</span>' +
        '<button class="prov-del" title="Modeli kaldır">✕</button>';
      row.addEventListener('click', async () => {
        const res = await jev.setModel(p.id + '::' + m);
        if (res && res.ok) {
          state.activeModel = res.activeModel;
          applyState();
          saveExModel();
          renderProviderPane();
          toast('Model: ' + p.name + ' · ' + m);
        }
      });
      row.querySelector('.prov-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        p.models = p.models.filter((x) => x !== m);
        await jev.setProviders(state.providers);
        renderProviderPane();
        toast(m + ' kaldırıldı');
      });
      pane.appendChild(row);
    }
  }
  if (!state.providers || !state.providers.length) {
    pane.insertAdjacentHTML('beforeend', '<p class="sub">Henüz provider yok — aşağıdan ekle.</p>');
  }

  pane.insertAdjacentHTML('beforeend', '<div class="divider"></div><h2>Provider Ekle</h2><div class="sub">Hazır sağlayıcı seç — sadece API key gir, modelleri çek.</div>');

  const form = document.createElement('div');
  form.innerHTML =
    '<label class="mem-label">Hazır sağlayıcı</label>' +
    '<select id="cpPreset" class="inp">' +
    '<option value="-1">Özel…</option>' +
    builtinProviders.map((p, i) => '<option value="' + i + '">' + escapeHtml(p.name) + '</option>').join('') +
    '</select>' +
    '<div id="cpPresetHint" class="sub" style="margin-top:4px">Özel sağlayıcı için API adresini elle gir.</div>' +
    '<label class="mem-label">Ad (opsiyonel)</label><input id="cpName" class="inp" placeholder="Örn: OrcaRouter">' +
    '<div class="form-grid">' +
    '<div><label class="mem-label">API adresi</label><input id="cpUrl" class="inp" placeholder="https://api.ornek.com/v1"></div>' +
    '<div><label class="mem-label">API key</label><input id="cpKey" class="inp" type="password" placeholder="sk-..."></div>' +
    '</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px">' +
    '<button id="cpFetch" class="btn ghost">Modelleri Çek</button>' +
    '<button id="cpSave" class="btn">Kaydet</button>' +
    '</div>' +
    '<div id="cpPicks" class="model-picks" hidden></div>';
  pane.appendChild(form);

  let discovered = [];
  let presetSel = -1;

  const syncPreset = () => {
    presetSel = Number($('#cpPreset').value);
    const urlInp = $('#cpUrl');
    const hint = $('#cpPresetHint');
    if (presetSel >= 0 && builtinProviders[presetSel]) {
      const p = builtinProviders[presetSel];
      urlInp.value = p.baseUrl;
      urlInp.readOnly = true;
      urlInp.style.opacity = '0.75';
      $('#cpName').placeholder = p.name;
      hint.textContent = p.name + ' — ' + p.hint + ' · sadece API key gir, modelleri çek';
    } else {
      urlInp.readOnly = false;
      urlInp.style.opacity = '';
      $('#cpName').placeholder = 'Örn: OrcaRouter';
      hint.textContent = 'Özel sağlayıcı için API adresini elle gir.';
    }
  };
  $('#cpPreset').addEventListener('change', syncPreset);

  $('#cpFetch').addEventListener('click', async () => {
    const baseUrl = $('#cpUrl').value.trim();
    if (!/^https?:\/\//i.test(baseUrl)) { toast('Geçerli API adresi gir'); return; }
    const btn = $('#cpFetch');
    btn.disabled = true;
    btn.textContent = 'Çekiliyor…';
    const res = await jev.fetchModels({ baseUrl, key: $('#cpKey').value.trim() }).catch(() => null);
    btn.disabled = false;
    btn.textContent = 'Modelleri Çek';
    discovered = res && res.ok ? res.models : [];
    const picks = $('#cpPicks');
    if (discovered.length) {
      picks.hidden = false;
      picks.innerHTML = discovered
        .map((m) => '<label><input type="checkbox" value="' + escapeHtml(m) + '" checked> ' + escapeHtml(m) + '</label>')
        .join('');
      toast(discovered.length + ' model bulundu — listeden seç ya da elle ekle');
    } else {
      picks.hidden = true;
      picks.innerHTML = '';
      toast('Model çekilemedi (' + ((res && res.error) || 'boş') + ') — elle ekleyebilirsin');
    }
  });

  $('#cpSave').addEventListener('click', async () => {
    const url = $('#cpUrl').value.trim();
    if (!/^https?:\/\//i.test(url)) { toast('Geçerli API adresi gir'); return; }
    const picked = $$('#cpPicks input:checked').map((c) => c.value);
    const manual = ($('#cpManual') ? $('#cpManual').value : '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
    const models = [...new Set([...picked, ...manual])];
    if (!models.length) { toast('En az bir model gir ya da seç'); return; }
    const preset = presetSel >= 0 ? builtinProviders[presetSel] : null;
    let name = $('#cpName').value.trim();
    if (!name) {
      try { name = preset ? preset.name : new URL(url).hostname; } catch { name = preset ? 'Preset' : 'Custom'; }
    }
    const entry = {
      id: preset ? 'preset-' + preset.id : newId(),
      name,
      baseUrl: url,
      key: $('#cpKey').value.trim(),
      models,
    };
    const idx = state.providers.findIndex((x) => x.id === entry.id);
    if (idx >= 0) state.providers[idx] = entry;
    else state.providers.push(entry);
    await jev.setProviders(state.providers);
    renderProviderPane();
    toast(entry.name + ': ' + models.length + ' model kaydedildi');
  });
}

/* ---------- ayarlar: skills (sohbet LLM'ine bağlanan özel yetenekler) ---------- */
let skillsCache = [];
let skillEditId = '';

async function loadSkillsCache() {
  const r = await jev.skillsGet().catch(() => null);
  skillsCache = r && r.ok && Array.isArray(r.skills) ? r.skills : [];
  return skillsCache;
}

function skillById(id) {
  return skillsCache.find((s) => s.id === id) || null;
}

function activeSkillIds() {
  const t = activeTab();
  return t && Array.isArray(t.skills) ? t.skills.map(String) : [];
}

/* grafik sekmesine bağlı skill'lerin talimatlarını sistem promptu bloğuna çevir */
const SKILLS_PROMPT_MAX_CHARS = 24000;
function skillsPromptBlock() {
  const ids = activeSkillIds();
  if (!ids.length || !skillsCache.length) return '';
  const parts = [];
  for (const id of ids) {
    const sk = skillById(id);
    if (!sk || sk.enabled === false) continue;
    const body = String(sk.content || '').trim();
    if (!body) continue;
    parts.push('## Skill: ' + sk.name + (sk.desc ? ' — ' + sk.desc : '') + '\n' + body);
  }
  if (!parts.length) return '';
  let block = parts.join('\n\n');
  if (block.length > SKILLS_PROMPT_MAX_CHARS) block = block.slice(0, SKILLS_PROMPT_MAX_CHARS) + '\n[...skill içeriği kısaltıldı...]';
  return '\n\n[AKTİF SKILL\'LER — kullanıcı bu sohbet için bağladı; talimatlarına uy]\n' + block;
}

function skillBoundTabCount(id) {
  return chartTabs.filter((t) => Array.isArray(t.skills) && t.skills.includes(id)).length;
}

async function persistSkills() {
  const r = await jev.skillsSet(skillsCache).catch(() => null);
  if (!r || !r.ok) { toast('Skill kaydedilemedi'); return false; }
  skillsCache = Array.isArray(r.skills) ? r.skills : skillsCache;
  return true;
}

async function deleteSkill(id) {
  const sk = skillById(id);
  if (!sk) return;
  skillsCache = skillsCache.filter((s) => s.id !== id);
  if (!(await persistSkills())) { await loadSkillsCache(); renderSkillsPane(); return; }
  let dropped = 0;
  for (const t of chartTabs) {
    if (Array.isArray(t.skills) && t.skills.includes(id)) {
      t.skills = t.skills.filter((x) => x !== id);
      dropped++;
    }
  }
  if (dropped) saveTabs();
  if (skillEditId === id) skillEditId = '';
  renderSkillsPane();
  toast('Skill silindi: ' + sk.name + (dropped ? ' · ' + dropped + ' sekmeden çıkarıldı' : ''));
  jevLogAdd('AYAR · skill silindi: ' + sk.name, 'info');
}

function resetSkillForm() {
  skillEditId = '';
  const n = $('#skillName');
  const d = $('#skillDesc');
  const c = $('#skillContent');
  if (n) n.value = '';
  if (d) d.value = '';
  if (c) c.value = '';
  const t = $('#skillFormTitle');
  if (t) t.textContent = 'YENİ SKILL';
  const s = $('#skillSave');
  if (s) s.textContent = 'Skill Ekle';
  const r = $('#skillReset');
  if (r) r.hidden = true;
  const m = $('#skillMsg');
  if (m) m.textContent = '';
}

function editSkill(id) {
  const sk = skillById(id);
  if (!sk) return;
  skillEditId = id;
  $('#skillName').value = sk.name || '';
  $('#skillDesc').value = sk.desc || '';
  $('#skillContent').value = sk.content || '';
  $('#skillFormTitle').textContent = 'DÜZENLE: ' + sk.name;
  $('#skillSave').textContent = 'Güncelle';
  $('#skillReset').hidden = false;
  $('#skillMsg').textContent = skillBoundTabCount(id) + ' sekmeye bağlı';
}

async function renderSkillsPane() {
  const pane = $('#tab-skills');
  if (!pane) return;
  await loadSkillsCache();
  const esc = escapeHtml;
  let list = '';
  if (!skillsCache.length) {
    list = '<div class="sub" style="margin:0">Henüz skill yok — aşağıdan ilkini oluştur.</div>';
  } else {
    for (const sk of skillsCache) {
      const desc = sk.desc || String(sk.content || '').replace(/\s+/g, ' ').trim().slice(0, 110);
      list +=
        '<div class="prov-row skill-row" data-id="' + esc(sk.id) + '">' +
        '<span class="skill-dot' + (sk.enabled !== false ? ' on' : '') + '" title="' + (sk.enabled !== false ? 'Aktif — kapatmak için tıkla' : 'Kapalı — açmak için tıkla') + '">●</span>' +
        '<span class="prov-name">' + esc(sk.name) + '</span>' +
        '<span class="prov-model">' + esc(desc) + '</span>' +
        '<button class="skill-edit" title="Düzenle">✎</button>' +
        '<button class="prov-del" title="Sil">✕</button>' +
        '</div>';
    }
  }
  pane.innerHTML =
    '<h2>Skills</h2>' +
    '<div class="sub">Özel yetenek talimatları. Skill oluştur → sohbet ayarlarından (💬) bir grafik sekmesinin sohbetine bağla; bağlı skill talimatları her istekte LLM sistem promptuna eklenir. Aynı sohbete birden çok skill bağlanabilir.</div>' +
    '<div id="skillList">' + list + '</div>' +
    '<div class="divider"></div>' +
    '<div class="color-sec" id="skillFormTitle">YENİ SKILL</div>' +
    '<label class="mem-label">Ad</label>' +
    '<input id="skillName" class="inp" type="text" maxlength="80" placeholder="örn. Risk Kuralları" />' +
    '<label class="mem-label">Kısa açıklama</label>' +
    '<input id="skillDesc" class="inp" type="text" maxlength="400" placeholder="örn. İşlem başına risk ve lot kuralları" />' +
    '<label class="mem-label">Talimat metni (LLM\'e aynen eklenir)</label>' +
    '<textarea id="skillContent" class="mem-area" rows="9" spellcheck="false" placeholder="1) İşlem başına risk %1&#39;i geçmesin&#10;2) ..."></textarea>' +
    '<div style="display:flex;gap:8px;margin-top:12px">' +
    '<button id="skillSave" class="btn">Skill Ekle</button>' +
    '<button id="skillReset" class="btn ghost" hidden>Vazgeç</button>' +
    '</div>' +
    '<div id="skillMsg" class="sub" style="text-align:left;margin-top:10px"></div>' +
    '<div class="divider"></div>' +
    '<div class="color-sec">TOOLBOX ARAÇLARI (LLM YAZAR)</div>' +
    '<div class="sub">Chat LLM ihtiyaç doğrultusunda toolbox\'a yeni araç yazar (&lt;&lt;TOOL&gt;&gt;); araçlar grafik araç çubuğunda buton olarak görünür ve tıklayınca çalışır (Shift+tık: sil).</div>' +
    '<div id="toolList">' + toolsListHtml() + '</div>';

  for (const row of $$('#skillList .skill-row')) {
    const id = row.dataset.id;
    row.addEventListener('click', () => editSkill(id));
    row.querySelector('.skill-edit').addEventListener('click', (e) => { e.stopPropagation(); editSkill(id); });
    row.querySelector('.prov-del').addEventListener('click', (e) => { e.stopPropagation(); deleteSkill(id); });
    row.querySelector('.skill-dot').addEventListener('click', async (e) => {
      e.stopPropagation();
      const sk = skillById(id);
      if (!sk) return;
      sk.enabled = sk.enabled === false;
      if (!(await persistSkills())) { await loadSkillsCache(); renderSkillsPane(); return; }
      renderSkillsPane();
      toast('Skill ' + (sk.enabled !== false ? 'aktif' : 'kapalı') + ': ' + sk.name);
    });
  }

  for (const row of $$('#toolList .tool-row')) {
    const id = row.dataset.id;
    row.querySelector('.tool-run').addEventListener('click', (e) => {
      e.stopPropagation();
      const t = findToolById(id);
      if (t) runCustomTool(t);
    });
    row.querySelector('.prov-del').addEventListener('click', (e) => { e.stopPropagation(); deleteCustomTool(id); });
    row.querySelector('.skill-dot').addEventListener('click', async (e) => {
      e.stopPropagation();
      const t = findToolById(id);
      if (!t) return;
      t.enabled = t.enabled === false;
      if (!(await persistTools())) { await loadToolsCache(); renderSkillsPane(); return; }
      renderCustomToolButtons();
      renderSkillsPane();
      toast('Araç ' + (t.enabled !== false ? 'aktif' : 'kapalı') + ': ' + t.name);
    });
  }

  $('#skillSave').addEventListener('click', async () => {
    const name = $('#skillName').value.trim();
    const desc = $('#skillDesc').value.trim();
    const content = $('#skillContent').value.trim();
    if (!name) { toast('Skill adı gerekli'); return; }
    if (!content) { toast('Talimat metni gerekli'); return; }
    const idx = skillsCache.findIndex((s) => s.id === skillEditId);
    const prev = idx >= 0 ? skillsCache[idx] : null;
    const entry = {
      id: prev ? prev.id : 'skill-' + newId(),
      name,
      desc,
      content,
      enabled: prev ? prev.enabled !== false : true,
    };
    if (idx >= 0) skillsCache[idx] = entry;
    else skillsCache.push(entry);
    if (!(await persistSkills())) return;
    resetSkillForm();
    renderSkillsPane();
    toast((prev ? 'Skill güncellendi: ' : 'Skill eklendi: ') + name);
    jevLogAdd('AYAR · skill ' + (prev ? 'güncellendi' : 'eklendi') + ': ' + name, 'info');
  });

  $('#skillReset').addEventListener('click', resetSkillForm);
}

/* ---------- özel toolbox araçları: chat LLM yazar, tıklayınca çalışır ---------- */
let toolsCache = [];

async function loadToolsCache() {
  const r = await jev.toolsGet().catch(() => null);
  toolsCache = r && r.ok && Array.isArray(r.tools) ? r.tools : [];
  return toolsCache;
}

function findToolById(id) {
  return toolsCache.find((t) => String(t.id) === String(id)) || null;
}

function findToolByName(name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return null;
  return toolsCache.find((t) => String(t.id).toLowerCase() === raw)
    || toolsCache.find((t) => String(t.name || '').trim().toLowerCase() === raw)
    || null;
}

async function persistTools() {
  const r = await jev.toolsSet(toolsCache).catch(() => null);
  if (!r || !r.ok) { toast('Araç kaydedilemedi'); return false; }
  toolsCache = Array.isArray(r.tools) ? r.tools : toolsCache;
  return true;
}

function toolsListHtml() {
  if (!toolsCache.length) return '<div class="sub" style="margin:0">Henüz özel araç yok — sohbetten LLM\'e "düşeni araç olarak yaz" dediğinde burada listelenir.</div>';
  let html = '';
  for (const t of toolsCache) {
    const desc = t.desc || String(t.content || '').replace(/\s+/g, ' ').trim().slice(0, 110);
    html +=
      '<div class="prov-row tool-row" data-id="' + escapeHtml(t.id) + '">' +
      '<span class="skill-dot' + (t.enabled !== false ? ' on' : '') + '" title="' + (t.enabled !== false ? 'Aktif — kapatmak için tıkla' : 'Kapalı — açmak için tıkla') + '">●</span>' +
      '<span class="prov-name">' + escapeHtml((t.icon ? t.icon + ' ' : '') + t.name) + '</span>' +
      '<span class="prov-model">' + escapeHtml(desc) + '</span>' +
      '<button class="tool-run btn ghost" style="padding:3px 10px;font-size:11.5px" title="Çalıştır">Çalıştır</button>' +
      '<button class="prov-del" title="Sil">✕</button>' +
      '</div>';
  }
  return html;
}

/* araç kodu bu api üzerinden çizim/plan/alarm üretir; new Function ile izole çalışır */
function customToolApi(tool) {
  return {
    tool: { id: tool.id, name: tool.name },
    symbol: () => chartState.symbol,
    tf: () => chartState.tf,
    digits: () => chartState.digits,
    price: () => { const r = chartState.rates || []; return r.length ? Number(r[r.length - 1].close) : 0; },
    rates: () => (chartState.rates || []).map((r) => ({ t: r.time, o: r.open, h: r.high, l: r.low, c: r.close })),
    draw: (d) => { const ok = jevDraw(d); if (ok) { saveDrawings(); drawChart(); } return ok; },
    plan: (d) => { const ok = jevPlan(d); if (ok) { savePlans(); applyPlanButtons(); drawChart(); } return ok; },
    alert: (d) => { const ok = jevAlert(d); if (ok) { saveAlerts(); renderAlertSide(); drawChart(); } return ok; },
    clear: (sel) => { const n = jevClear(sel); if (n) { saveDrawings(); savePlans(); saveAlerts(); drawChart(); renderAlertSide(); } return n; },
    toast: (m) => toast(String(m || '')),
    log: (m) => jevLogAdd('ARAÇ · ' + tool.name + ' · ' + String(m || ''), 'cmd'),
  };
}

function runCustomTool(tool) {
  if (!tool) return false;
  if (tool.enabled === false) { toast('Araç kapalı: ' + tool.name); return false; }
  try {
    const fn = new Function('api', '"use strict";\n' + String(tool.content || ''));
    fn(customToolApi(tool));
    toast('Araç çalıştı: ' + tool.name);
    jevLogAdd('ARAÇ ÇALIŞTI · ' + tool.name, 'cmd');
    return true;
  } catch (e) {
    toast('Araç hatası (' + tool.name + '): ' + String((e && e.message) || e));
    jevLogAdd('ARAÇ HATASI · ' + tool.name + ' · ' + String((e && e.message) || e), 'err');
    return false;
  }
}

/* özel araçları grafik araç çubuklarına buton olarak ekle */
function renderCustomToolButtons() {
  for (const boxId of ['toolbox', 'toolbox2']) {
    const tb = document.getElementById(boxId);
    if (!tb) continue;
    for (const b of Array.from(tb.querySelectorAll('button.cust-tool'))) b.remove();
    for (const t of toolsCache) {
      if (t.enabled === false) continue;
      const b = document.createElement('button');
      b.className = 'cust-tool';
      b.dataset.toolId = t.id;
      b.title = (t.desc || t.name) + ' — tıkla: çalıştır · Shift+tık: sil';
      b.innerHTML = t.icon
        ? escapeHtml(t.icon)
        : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17v3h3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.1-2.1z"/></svg>';
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const cur = findToolById(t.id);
        if (!cur) return;
        if (ev.shiftKey) { deleteCustomTool(t.id); return; }
        runCustomTool(cur);
      });
      tb.appendChild(b);
    }
  }
}

async function deleteCustomTool(id) {
  const t = findToolById(id);
  if (!t) return;
  toolsCache = toolsCache.filter((x) => x.id !== id);
  if (!(await persistTools())) { await loadToolsCache(); renderCustomToolButtons(); return; }
  renderCustomToolButtons();
  if ($('#toolList')) renderSkillsPane();
  toast('Araç silindi: ' + t.name);
  jevLogAdd('ARAÇ SİLİNDİ · ' + t.name, 'info');
}

/* <<TOOL {action,save|run|delete|enable|list,...}>>: LLM toolbox'a araç yazar/kullanır */
async function jevToolCommand(d) {
  if (!d || typeof d !== 'object') return false;
  const action = String(d.action || d.op || 'save').toLowerCase();
  if (action === 'list') {
    const txt = toolsCache.length
      ? toolsCache.map((t) => '· ' + t.name + (t.enabled === false ? ' (kapalı)' : '') + (t.desc ? ' — ' + t.desc : '')).join('\n')
      : 'özel araç yok';
    jevLogAdd('ARAÇ LİSTESİ · ' + toolsCache.length + ' araç · ' + txt.replace(/\n/g, ' | ').slice(0, 300), 'cmd');
    toast('Toolbox araçları: ' + toolsCache.length);
    return true;
  }
  if (action === 'run') {
    const t = findToolByName(d.name || d.id);
    if (!t) { jevLogAdd('ARAÇ ÇALIŞTIRILAMADI · bulunamadı: ' + String(d.name || d.id || ''), 'err'); return false; }
    return runCustomTool(t);
  }
  if (action === 'delete' || action === 'remove') {
    const t = findToolByName(d.name || d.id);
    if (!t) { jevLogAdd('ARAÇ SİLİNEMEDİ · bulunamadı: ' + String(d.name || d.id || ''), 'err'); return false; }
    await deleteCustomTool(t.id);
    return true;
  }
  if (action === 'enable' || action === 'disable') {
    const t = findToolByName(d.name || d.id);
    if (!t) return false;
    t.enabled = action === 'enable';
    if (!(await persistTools())) return false;
    renderCustomToolButtons();
    toast('Araç ' + (t.enabled ? 'aktif' : 'kapalı') + ': ' + t.name);
    return true;
  }
  if (action === 'save' || action === 'add' || action === 'create' || action === 'update') {
    const name = String(d.name || '').trim().slice(0, 60);
    const content = String(d.content || d.code || '').trim();
    if (!name || !content) {
      jevLogAdd('ARAÇ KAYDEDİLEMEDİ · ad ve content (kod) gerekli', 'err');
      toast('Araç kaydedilemedi: ad ve kod gerekli');
      return false;
    }
    try {
      new Function('api', '"use strict";\n' + content);
    } catch (e) {
      jevLogAdd('ARAÇ KAYDEDİLEMEDİ · sözdizimi hatası · ' + String((e && e.message) || e), 'err');
      toast('Araç kodu sözdizimi hatalı: ' + String((e && e.message) || e));
      return false;
    }
    const entryId = String(d.id || '').trim();
    let idx = entryId ? toolsCache.findIndex((t) => t.id === entryId) : -1;
    if (idx < 0) {
      const byName = findToolByName(name);
      if (byName) idx = toolsCache.findIndex((t) => t.id === byName.id);
    }
    const prev = idx >= 0 ? toolsCache[idx] : null;
    const entry = {
      id: prev ? prev.id : (entryId || 'tool-' + newId()),
      name,
      desc: String(d.desc || d.description || '').trim().slice(0, 300),
      icon: String(d.icon || '').trim().slice(0, 8),
      content: content.slice(0, 24000),
      enabled: prev ? prev.enabled !== false : d.enabled !== false,
    };
    if (idx >= 0) toolsCache[idx] = entry;
    else toolsCache.push(entry);
    if (!(await persistTools())) return false;
    renderCustomToolButtons();
    if ($('#toolList')) renderSkillsPane();
    const msg = 'Toolbox aracı ' + (prev ? 'güncellendi' : 'eklendi') + ': ' + name;
    toast(msg);
    jevLogAdd(msg + (entry.desc ? ' · ' + entry.desc : ''), 'cmd');
    return true;
  }
  jevLogAdd('ARAÇ komutu anlaşılamadı · action: ' + action, 'err');
  return false;
}

/* ---------- <<SKILL>>: LLM skill yazar/düzenler ve istediği sekmenin sohbetine bağlar ---------- */
function findTabsBySelector(sel) {
  const raw = String(sel == null ? '' : sel).trim();
  if (!raw || /^(aktif|active|bu|this|current)$/i.test(raw)) {
    const t = activeTab();
    return t ? [t] : [];
  }
  const byId = chartTabs.filter((t) => t.id === raw);
  if (byId.length) return byId;
  const parts = raw.toUpperCase().split(/\s+/);
  const sym = parts[0];
  const tf = parts[1] && TFS.includes(parts[1]) ? parts[1] : '';
  let list = chartTabs.filter((t) => String(t.symbol || '').toUpperCase() === sym && (!tf || t.tf === tf));
  if (!list.length && !tf) list = chartTabs.filter((t) => String(t.symbol || '').toUpperCase().includes(sym));
  return list;
}

function findSkillByName(name) {
  const raw = String(name || '').trim().toLowerCase();
  if (!raw) return null;
  return skillsCache.find((s) => String(s.id).toLowerCase() === raw)
    || skillsCache.find((s) => String(s.name || '').trim().toLowerCase() === raw)
    || null;
}

async function jevSkillCommand(d) {
  if (!d || typeof d !== 'object') return false;
  const action = String(d.action || d.op || 'save').toLowerCase();
  const label = d.name ? '"' + String(d.name) + '"' : (d.id ? '#' + d.id : '');
  if (action === 'save' || action === 'add' || action === 'create' || action === 'update') {
    const name = String(d.name || '').trim().slice(0, 80);
    const content = String(d.content || d.text || '').trim();
    if (!name || !content) {
      jevLogAdd('SKILL KAYDEDİLEMEDİ · ad ve content gerekli', 'err');
      toast('Skill kaydedilemedi: ad ve content gerekli');
      return false;
    }
    const entryId = String(d.id || '').trim();
    let idx = entryId ? skillsCache.findIndex((s) => s.id === entryId) : -1;
    if (idx < 0) {
      const byName = findSkillByName(name);
      if (byName) idx = skillsCache.findIndex((s) => s.id === byName.id);
    }
    const prev = idx >= 0 ? skillsCache[idx] : null;
    const entry = {
      id: prev ? prev.id : (entryId || 'skill-' + newId()),
      name,
      desc: String(d.desc || d.description || '').trim().slice(0, 400),
      content: content.slice(0, 20000),
      enabled: prev ? prev.enabled !== false : d.enabled !== false,
    };
    if (idx >= 0) skillsCache[idx] = entry;
    else skillsCache.push(entry);
    if (!(await persistSkills())) return false;
    const msg = 'Skill ' + (prev ? 'güncellendi' : 'yazıldı') + ': ' + name;
    toast(msg);
    jevLogAdd(msg + (entry.desc ? ' · ' + entry.desc : ''), 'cmd');
    return true;
  }
  if (action === 'delete' || action === 'remove') {
    const sk = findSkillByName(d.id || d.name);
    if (!sk) {
      jevLogAdd('SKILL SİLİNEMEDİ · bulunamadı ' + label, 'err');
      toast('Skill bulunamadı: ' + label);
      return false;
    }
    await deleteSkill(sk.id);
    return true;
  }
  if (action === 'bind' || action === 'unbind') {
    const tabSel = d.tab != null ? d.tab : (d.tabs != null ? d.tabs : 'aktif');
    const sels = Array.isArray(tabSel) ? tabSel : [tabSel];
    const tabs = [];
    for (const s of sels) {
      for (const t of findTabsBySelector(s)) if (!tabs.includes(t)) tabs.push(t);
    }
    if (!tabs.length) {
      jevLogAdd('SKILL ' + (action === 'bind' ? 'BAĞLANAMADI' : 'ÇÖZÜLEMEDİ') + ' · sekme bulunamadı: ' + sels.join(', '), 'err');
      toast('Skill: sekme bulunamadı (' + sels.join(', ') + ')');
      return false;
    }
    const names = Array.isArray(d.skills) ? d.skills : (d.skill != null ? [d.skill] : []);
    const ids = [];
    for (const n of names) {
      const sk = findSkillByName(n);
      if (!sk) {
        jevLogAdd('SKILL ' + (action === 'bind' ? 'BAĞLANAMADI' : 'ÇÖZÜLEMEDİ') + ' · skill yok: ' + String(n), 'err');
        toast('Skill bulunamadı: ' + String(n));
        return false;
      }
      ids.push(sk.id);
    }
    const replace = d.replace === true;
    let changed = 0;
    for (const t of tabs) {
      const cur = Array.isArray(t.skills) ? t.skills.map(String) : [];
      const next = action === 'bind'
        ? (replace ? ids.slice() : Array.from(new Set(cur.concat(ids))))
        : (ids.length ? cur.filter((x) => !ids.includes(x)) : []);
      if (next.length !== cur.length || next.some((x, i) => x !== cur[i])) {
        t.skills = next;
        changed++;
      }
    }
    saveTabs();
    if (activeTab() && tabs.includes(activeTab()) && !$('#chatSetOverlay').hidden) renderChatSetSkills();
    const tabTxt = tabs.map((t) => t.symbol + ' ' + t.tf).join(', ');
    const nameTxt = action === 'unbind' && !ids.length
      ? 'tüm skill\'ler'
      : ids.map((id) => (skillById(id) || {}).name || id).join(', ');
    const msg = 'Skill ' + (action === 'bind' ? 'bağlandı' : 'çözüldü') + ' · ' + tabTxt + ' · ' + nameTxt + (changed ? '' : ' (değişiklik yok)');
    toast('Jev: ' + msg);
    jevLogAdd(msg, 'cmd');
    return true;
  }
  jevLogAdd('SKILL komutu anlaşılamadı · action: ' + action, 'err');
  return false;
}

/* ---------- kod (chat LLM self-edit): test + otomatik yeniden başlatma ---------- */
function jevCodeEdit(d) {
  if (!d || typeof d !== 'object') return null;
  const file = String(d.file || '').trim();
  if (!file) return null;
  const why = String(d.why || d.note || '').slice(0, 200);
  if (Array.isArray(d.ops) && d.ops.length) {
    const ops = d.ops
      .slice(0, 20)
      .map((o) => ({ find: String((o && o.find) || ''), replace: String(o && o.replace != null ? o.replace : '') }))
      .filter((o) => o.find);
    if (!ops.length) return null;
    return { file, why, ops };
  }
  if (typeof d.content === 'string') return { file, why, content: d.content };
  return null;
}

async function applyCodeEdits(edits) {
  const why = edits.map((e) => e.why).filter(Boolean).join(' | ');
  const files = edits.map((e) => e.file).join(', ');
  jevLogAdd('KOD · ' + edits.length + ' düzenleme uygulanıyor · ' + files + (why ? ' · ' + why : ''), 'req');
  toast('Kod güncelleniyor — sözdizimi + smoke test çalışıyor (~25 sn)…');
  const r = await jev.codeApply({ edits, why, sessionId: activeSid }).catch(() => null);
  if (r && r.ok) {
    jevLogAdd('KOD · test OK · ' + (r.files || []).join(', ') + ' · yedek ' + (r.backup || '') + (r.build ? ' · build ' + r.build : '') + (r.restarting ? ' — yeniden başlatılıyor' : ''), 'cmd');
    toast(r.restarting ? 'Kod güncellendi, test OK — uygulama yeniden başlatılıyor…' : 'Kod güncellendi ve test edildi ✓');
  } else if (r && r.rolledBack) {
    jevLogAdd('KOD · test başarısız, geri alındı · ' + ((r && r.error) || ''), 'err');
    toast('Kod testi başarısız — değişiklikler geri alındı: ' + ((r && r.error) || 'hata'));
  } else {
    jevLogAdd('KOD · uygulanamadı · ' + ((r && r.error) || 'yanıt yok'), 'err');
    toast('Kod güncellenemedi: ' + ((r && r.error) || 'yanıt yok'));
  }
}

async function renderCodePane() {
  const pane = $('#tab-code');
  if (!pane) return;
  const r = await jev.codeGet().catch(() => null);
  const enabled = !!(r && r.ok && r.enabled);
  const packaged = !!(r && r.packaged);
  const backups = (r && r.backups) || [];
  let bl = '';
  if (!backups.length) {
    bl = '<div class="sub" style="margin:0">Henüz kod yedeği yok. LLM kod değiştirdiğinde burada listelenir.</div>';
  } else {
    for (const b of backups) {
      const dt = String(b.at || '').replace('T', ' ').slice(0, 19);
      const fl = (b.files || []).map((f) => 'src/' + String(f.rel || '')).join(', ');
      bl +=
        '<div class="prov-row" data-id="' + escapeHtml(b.id || '') + '">' +
        '<span class="prov-name">' + escapeHtml(dt) + '</span>' +
        '<span class="prov-model">' + escapeHtml(fl + (b.why ? ' · ' + b.why : '')) + '</span>' +
        '<button class="skill-restore btn ghost" style="padding:3px 10px;font-size:11.5px" title="Bu yedeği geri yükle (uygulama yeniden başlar)">Geri yükle</button>' +
        '</div>';
    }
  }
  pane.innerHTML =
    '<h2>Kod</h2>' +
    '<div class="sub">Chat LLM, sen istediğinde uygulamanın kendi kaynak kodunu (src/ altındaki .js/.css/.html) düzenleyebilir; önce &lt;&lt;FILE&gt;&gt; komutuyla kodun istediği bölümünü okuyabilir, yeni dosya da oluşturabilir. Her düzenlemede dosyalar yedeklenir, <b>node --check</b> + görünmez <b>smoke test</b> çalıştırılır; test geçerse uygulama otomatik yeniden başlar, hata olursa değişiklikler geri alınır.</div>' +
    (packaged ? '<div class="sub" style="color:var(--err)">Paketlenmiş (asar) sürümde kod düzenleme kapalıdır; geliştirme modunda (npm start) çalışır.</div>' : '') +
    '<label class="mem-label" style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="codeEnabled"' + (enabled ? ' checked' : '') + (packaged ? ' disabled' : '') + ' /> Chat LLM kodu düzenleyebilsin</label>' +
    '<div class="range-val" style="margin-top:-2px">Kod komutu: &lt;&lt;CODE {"file":"src/renderer/renderer.js","ops":[{"find":"eski","replace":"yeni"}],"why":"açıklama"}&gt;&gt; — her "find" dosyada birebir ve tek kez eşleşmeli.</div>' +
    '<div class="range-val" style="margin-top:6px">Sürüm: v' + escapeHtml(String(r.version || '—')) + ' · build ' + escapeHtml(String(r.build || '—')) +
    (r.updatedAt ? ' · son değişim: ' + escapeHtml(String(r.updatedAt)).replace('T', ' ').slice(0, 19) + (r.note ? ' · ' + escapeHtml(String(r.note).slice(0, 140)) : '') : '') + '</div>' +
    '<div class="range-val">Yedek klasörü: ' + escapeHtml(r.backupDir || '—') + '</div>' +
    '<div style="display:flex;gap:8px;margin-top:8px"><button id="codeOpenBackups" class="btn ghost">Yedek klasörünü aç</button></div>' +
    '<div class="divider"></div>' +
    '<div class="color-sec">YEDEKLER (son 20)</div>' +
    bl;

  const ob = $('#codeOpenBackups');
  if (ob) {
    ob.addEventListener('click', async () => {
      const rr = await jev.codeOpenBackups().catch(() => null);
      if (!rr || !rr.ok) toast('Klasör açılamadı: ' + ((rr && rr.error) || 'hata'));
    });
  }
  const cb = $('#codeEnabled');
  if (cb) {
    cb.addEventListener('change', async () => {
      const rr = await jev.codeSet({ enabled: cb.checked }).catch(() => null);
      if (rr && rr.ok) toast(cb.checked ? 'LLM kod düzenleme açık' : 'LLM kod düzenleme kapalı');
      else toast('Ayar kaydedilemedi');
    });
  }
  for (const row of $$('#tab-code .prov-row')) {
    const btn = row.querySelector('.skill-restore');
    const id = row.dataset.id;
    if (!btn || !id) continue;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Yükleniyor…';
      toast('Yedek geri yükleniyor…');
      const rr = await jev.codeRestore({ id }).catch(() => null);
      if (rr && rr.ok) {
        jevLogAdd('KOD · yedek geri yüklendi · ' + id + (rr.restarting ? ' — yeniden başlatılıyor' : ''), 'cmd');
        toast('Yedek geri yüklendi — uygulama yeniden başlatılıyor…');
      } else {
        btn.disabled = false;
        btn.textContent = 'Geri yükle';
        toast('Yedek yüklenemedi: ' + ((rr && rr.error) || 'hata'));
      }
    });
  }
}

/* ---------- ayarlar: typesafe ---------- */
async function renderTypesafePane() {
  const pane = $('#tab-typesafe');
  const ts = await jev.typesafeGet().catch(() => ({ set: false, apiKey: '', model: 'jev-latest', enabled: true }));
  pane.innerHTML =
    '<h2>TypeSafe API</h2>' +
    '<div class="sub">System One (Jev) — tipli kararlar: Noul / Choice / Score. Jev-ONLY akışlar bu anahtarla çalışır.</div>' +
    '<div id="tsStatus" class="sub" style="text-align:left"></div>' +
    '<label class="mem-label">API anahtarı</label>' +
    '<input id="tsKeyInp" class="inp" type="password" placeholder="ts_..." autocomplete="new-password" spellcheck="false" />' +
    '<label class="mem-label">Model</label>' +
    '<input id="tsModelInp" class="inp" type="text" placeholder="jev-latest" spellcheck="false" />' +
    '<label class="mem-label" style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
    '<input id="tsEnabled" type="checkbox" /> Aktif — Jev karar motoruna izin ver</label>' +
    '<div style="display:flex;gap:8px;margin-top:12px">' +
    '<button id="tsSave" class="btn">Kaydet</button>' +
    '<button id="tsTest" class="btn ghost">Bağlantı Testi</button>' +
    '<button id="tsClear" class="btn ghost">Anahtarı Sil</button></div>' +
    '<div class="sub" style="margin-top:12px">Anahtar yalnızca bu bilgisayarda (%APPDATA%\\jevtrader\\settings.json) saklanır.</div>';

  const tsSt = $('#tsStatus');
  const tsModel = $('#tsModelInp');
  const tsEnabled = $('#tsEnabled');
  tsModel.value = ts.model || 'jev-latest';
  tsEnabled.checked = ts.enabled !== false;
  const setTsSt = (r) => {
    if (!r.set) { tsSt.textContent = 'Anahtar girilmedi — Jev karar akışları kapalı.'; tsSt.className = 'sub ts-status-warn'; }
    else if (r.enabled === false) { tsSt.textContent = 'Anahtar kayıtlı ama kapalı (' + r.model + ').'; tsSt.className = 'sub ts-status-warn'; }
    else { tsSt.textContent = 'Aktif — model: ' + r.model; tsSt.className = 'sub ts-status-ok'; }
  };
  setTsSt(ts);

  $('#tsTest').addEventListener('click', async () => {
    const btn = $('#tsTest');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = 'Test ediliyor…';
    const r = await jev.typesafeTest({ apiKey: $('#tsKeyInp').value.trim(), model: tsModel.value.trim() }).catch(() => null);
    btn.disabled = false;
    btn.textContent = old;
    if (r && r.ok) toast('TypeSafe bağlantısı OK — ' + (r.model || ''));
    else toast('TypeSafe testi başarısız: ' + ((r && r.error) || '?'));
  });

  $('#tsSave').addEventListener('click', async () => {
    const v = $('#tsKeyInp').value.trim();
    if (!v) { toast('Anahtar boş — gir ya da Anhtarı Sil kullan'); return; }
    const rr = await jev.typesafeSet({ apiKey: v, model: tsModel.value.trim(), enabled: tsEnabled.checked }).catch(() => null);
    $('#tsKeyInp').value = '';
    if (rr && rr.ok) { setTsSt(rr.typesafe || {}); toast('TypeSafe kaydedildi'); }
    else toast('TypeSafe kaydedilemedi');
  });

  /* anahtar zaten kayıtlıyken aç/kapa: anahtar korunur */
  tsEnabled.addEventListener('change', async () => {
    const rr = await jev.typesafeSet({ apiKey: ts.apiKey || '', model: tsModel.value.trim(), enabled: tsEnabled.checked }).catch(() => null);
    if (rr && rr.ok) { setTsSt(rr.typesafe || {}); toast('TypeSafe ayarı kaydedildi'); }
    else toast('TypeSafe ayarı kaydedilemedi');
  });

  $('#tsClear').addEventListener('click', async () => {
    await jev.typesafeSet({ apiKey: '', clearKey: true, model: tsModel.value.trim(), enabled: tsEnabled.checked }).catch(() => {});
    $('#tsKeyInp').value = '';
    setTsSt({ set: false, model: tsModel.value.trim() || 'jev-latest' });
    toast('Anahtar silindi');
  });
}

/* ---------- ayarlar: yerel HTTP API ---------- */
async function renderApiPane() {
  const pane = $('#tab-api');
  if (!pane) return;
  const r = await jev.apiGet().catch(() => null);
  const a = (r && r.ok)
    ? r
    : { enabled: false, running: false, host: '127.0.0.1', port: 8787, baseUrl: 'http://127.0.0.1:8787', keys: [], error: '', exchange: 'mt5', account: 'real' };
  const base = a.baseUrl || ('http://' + (a.host || '127.0.0.1') + ':' + (a.port || 8787));
  const running = a.running === true;
  const EYE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><line x1="4" y1="20" x2="20" y2="4"/></svg>';

  const stTxt = running
    ? ('Çalışıyor · ' + base + ' · borsa: ' + String(a.exchange || 'mt5').toUpperCase() + ' · ' + (a.account === 'demo' ? 'DENEME hesabı' : 'gerçek hesap'))
    : (a.enabled ? ('Başlatılamadı' + (a.error ? ': ' + a.error : ' — portu değiştirip tekrar dene')) : 'Kapalı — açmak için kutuyu işaretle');

  let keyRows = '';
  if (!a.keys || !a.keys.length) {
    keyRows = '<div class="sub" style="margin:6px 0 0">Henüz anahtar yok — yukarıdaki alana bir ad yazıp <b>Anahtar Oluştur</b>a bas.</div>';
  } else {
    for (const k of a.keys) {
      const used = k.lastUsedAt ? ('son kullanım ' + String(k.lastUsedAt).replace('T', ' ').slice(0, 16)) : 'hiç kullanılmadı';
      keyRows +=
        '<div class="api-key-row" data-id="' + escapeHtml(k.id) + '">' +
        '<div class="api-key-main"><div class="api-key-name">' + escapeHtml(k.name) + '</div>' +
        '<div class="api-key-meta">' + escapeHtml(String(k.calls || 0)) + ' çağrı · ' + escapeHtml(used) + '</div></div>' +
        '<span class="pw-wrap"><input class="inp api-key-inp" type="password" readonly value="' + escapeHtml(k.key) + '" spellcheck="false" /></span>' +
        '<button class="pw-eye api-eye" title="Göster">' + EYE + '</button>' +
        '<button class="btn ghost api-copy-key" title="Panoya kopyala">Kopyala</button>' +
        '<button class="btn ghost api-del-key" title="Anahtarı sil (iptal)">Sil</button>' +
        '</div>';
    }
  }

  pane.innerHTML =
    '<h2>API</h2>' +
    '<div class="sub">Uygulama içinde yerel HTTP API. Dışarıdan API anahtarı ile hesabı/pozisyonları sorgula, fiyat verisi çek, emir gönder. <b>Deneme hesapları dahil</b> — emirler uygulamadaki seçili borsaya ve hesap türüne gider.</div>' +
    '<div class="sub ' + (running ? 'ts-status-ok' : (a.enabled ? 'ts-status-warn' : '')) + '" id="apiStatus" style="text-align:left;margin-bottom:10px">' +
    '<span class="api-dot' + (running ? ' on' : '') + '"></span>' + escapeHtml(stTxt) + '</div>' +
    '<label class="mem-label" style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
    '<input type="checkbox" id="apiOn"' + (a.enabled ? ' checked' : '') + ' /> API sunucusunu çalıştır (uygulama açıkken dinler)</label>' +
    '<div class="form-grid" style="margin-top:10px">' +
    '<div><label class="mem-label">Adres</label><select id="apiHost" class="inp">' +
    '<option value="127.0.0.1"' + (a.host !== '0.0.0.0' ? ' selected' : '') + '>127.0.0.1 — yalnızca bu bilgisayar (güvenli)</option>' +
    '<option value="0.0.0.0"' + (a.host === '0.0.0.0' ? ' selected' : '') + '>0.0.0.0 — yerel ağdaki tüm cihazlar</option>' +
    '</select></div>' +
    '<div><label class="mem-label">Port</label><div style="display:flex;gap:8px">' +
    '<input id="apiPort" class="inp" type="number" min="1" max="65535" value="' + escapeHtml(String(a.port || 8787)) + '" />' +
    '<button id="apiPortApply" class="btn ghost">Uygula</button></div></div>' +
    '</div>' +
    '<div class="sub" style="margin-top:6px">Uygulama adresi: <b>' + escapeHtml(base) + '</b> · sürüm v' + escapeHtml(String(a.version || '—')) + ' build ' + escapeHtml(String(a.build || '—')) + '</div>' +
    '<div style="display:flex;gap:8px;margin-top:10px">' +
    '<button id="apiTest" class="btn ghost">Bağlantı testi (kendi API-ne istek at)</button>' +
    '</div>' +
    '<div class="divider"></div>' +
    '<div class="color-sec">API ANAHTARLARI</div>' +
    '<div style="display:flex;gap:8px;margin:10px 0 12px">' +
    '<input id="apiKeyName" class="inp" placeholder="Anahtar adı (ör. bot, telefon, yedek)" style="max-width:320px" />' +
    '<button id="apiKeyCreate" class="btn">Anahtar Oluştur</button>' +
    '</div>' +
    keyRows +
    '<div class="sub" style="margin-top:8px">Anahtarlar bu bilgisayarda (%APPDATA%\\jevtrader\\settings.json) saklanır. Her istekte <b>X-API-Key</b> başlığı gerekir. Sızdıysa Sil ile iptal et.</div>' +
    '<div class="divider"></div>' +
    '<div class="color-sec">API DOKÜMANI</div>' +
    '<div class="sub" style="margin:8px 0 12px">Doküman burada gösterilmez; sunucu açıkken tarayıcıda açılır: <b>' + escapeHtml(base) + '/</b>. PDF olarak kaydetmek için tarayıcıdaki yazdır penceresini kullan.</div>' +
    '<div style="display:flex;gap:8px">' +
    '<button id="apiOpenDocs" class="btn ghost">Dokümanı tarayıcıda aç</button>' +
    '<button id="apiPdfDocs" class="btn ghost">PDF olarak indir (yazdır)</button>' +
    '</div>';

  const rerender = () => renderApiPane();

  const on = $('#apiOn');
  if (on) on.addEventListener('change', async () => {
    const rr = await jev.apiSet({ enabled: on.checked }).catch(() => null);
    if (!rr || !rr.ok) { toast('API ayarı kaydedilemedi'); return; }
    toast(on.checked ? 'API açık · ' + (rr.baseUrl || '') : 'API kapatıldı');
    rerender();
  });

  const hostSel = $('#apiHost');
  if (hostSel) hostSel.addEventListener('change', async () => {
    if (hostSel.value === '0.0.0.0' && !confirm('Dikkat: 0.0.0.0 seçilirse aynı ağdaki tüm cihazlar API adresine erişebilir (anahtar yine zorunlu). Devam edilsin mi?')) {
      hostSel.value = a.host === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
      return;
    }
    const rr = await jev.apiSet({ host: hostSel.value }).catch(() => null);
    if (!rr || !rr.ok) { toast('Adres kaydedilemedi'); return; }
    toast('Adres güncellendi');
    rerender();
  });

  const portApply = $('#apiPortApply');
  if (portApply) portApply.addEventListener('click', async () => {
    const p = Math.round(Number($('#apiPort').value) || 0);
    if (!(p >= 1 && p <= 65535)) { toast('Geçerli bir port gir (1-65535)'); return; }
    const rr = await jev.apiSet({ port: p }).catch(() => null);
    if (!rr || !rr.ok) { toast('Port kaydedilemedi'); return; }
    toast('Port: ' + p + (rr.running ? ' · çalışıyor' : ' (API kapalı)'));
    rerender();
  });

  const testBtn = $('#apiTest');
  if (testBtn) testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    const old = testBtn.textContent;
    testBtn.textContent = 'Test ediliyor…';
    const rr = await jev.apiSelfTest().catch(() => null);
    testBtn.disabled = false;
    testBtn.textContent = old;
    toast(rr && rr.ok ? ('API bağlantısı OK · ' + (rr.summary || '')) : ('API testi başarısız: ' + ((rr && rr.error) || '?')));
  });

  const docsBtn = $('#apiOpenDocs');
  if (docsBtn) docsBtn.addEventListener('click', () => jev.openExternal(base + '/'));
  const pdfBtn = $('#apiPdfDocs');
  if (pdfBtn) pdfBtn.addEventListener('click', () => jev.openExternal(base + '/?print=1'));

  const createBtn = $('#apiKeyCreate');
  if (createBtn) createBtn.addEventListener('click', async () => {
    const name = String(($('#apiKeyName') || {}).value || '').trim();
    const rr = await jev.apiKeyCreate({ name }).catch(() => null);
    if (!rr || !rr.ok) { toast('Anahtar oluşturulamadı: ' + ((rr && rr.error) || 'hata')); return; }
    toast('Anahtar oluşturuldu — listeden Kopyala ile al' + (rr.api && rr.api.running ? '' : ' · API kapalı, kutuyu işaretle'));
    rerender();
  });

  const keyInputs = {};
  for (const row of $$('#tab-api .api-key-row')) {
    const id = row.dataset.id;
    const inp = row.querySelector('.api-key-inp');
    if (inp) keyInputs[id] = inp;
    const eye = row.querySelector('.api-eye');
    if (eye && inp) eye.addEventListener('click', () => {
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      eye.innerHTML = show ? EYE_OFF : EYE;
      eye.classList.toggle('on', show);
      eye.title = show ? 'Gizle' : 'Göster';
    });
    const cp = row.querySelector('.api-copy-key');
    if (cp && inp) cp.addEventListener('click', async () => {
      const ok = await copyText(inp.value);
      toast(ok ? 'Anahtar kopyalandı' : 'Kopyalanamadı — göz ikonuyla gösterip elle seç');
    });
    const del = row.querySelector('.api-del-key');
    if (del) del.addEventListener('click', async () => {
      if (!confirm('Bu API anahtarı silinsin mi? Bu anahtarı kullanan istemciler artık erişemez.')) return;
      const rr = await jev.apiKeyRevoke(id).catch(() => null);
      if (!rr || !rr.ok) { toast('Silinemedi: ' + ((rr && rr.error) || 'hata')); return; }
      toast('Anahtar silindi');
      rerender();
    });
  }

  for (const b of $$('#tab-api .api-copy')) {
    b.addEventListener('click', async () => {
      const src = $(b.dataset.copy);
      if (!src) return;
      const ok = await copyText(src.textContent);
      toast(ok ? 'Kopyalandı' : 'Kopyalanamadı');
    });
  }
}

/* ---------- ayarlar: entegrasyonlar (WhatsApp / Telegram / Discord — botsuz) ----------
   Beast Agent'ın Entegrasyonlar sekmesiyle aynı mantık; bot eşleme/perm/sahip
   kavramları yok. İzin listesindeki kişilerin mesajları Jev sohbetine düşer,
   cevap aynı kanaldan geri gönderilir. */
const intgUI = {
  wa: { status: 'disconnected', user: null, qr: '', available: true },
  tg: { status: 'disconnected', user: null },
  dc: { status: 'disconnected', user: null },
};
const INTG_STATUS_TEXT = {
  disconnected: 'Bağlı değil',
  connecting: 'Bağlanıyor…',
  reconnecting: 'Yeniden bağlanıyor…',
  connected: 'Bağlı',
  qr: 'QR bekleniyor — telefonla okut',
  'logged-out': 'Oturum kapatıldı — yeniden eşle',
  error: 'Hata — bağlantı kurulamadı',
};
const INTG_GET = { wa: () => jev.waAllowGet(), tg: () => jev.tgAllowGet(), dc: () => jev.dcAllowGet() };
const INTG_SET = { wa: (l) => jev.waAllowSet(l), tg: (l) => jev.tgAllowSet(l), dc: (l) => jev.dcAllowSet(l) };

function intgApplyEvent(ev) {
  if (!ev || !ev.channel) return;
  const st = intgUI[ev.channel];
  if (!st) return;
  if (ev.type === 'status') {
    st.status = ev.status || 'disconnected';
    if (ev.user) st.user = ev.user;
    if (ev.qr) st.qr = ev.qr;
    if (st.status !== 'qr') st.qr = '';
  } else if (ev.type === 'warn') {
    toast('Entegrasyon: ' + String(ev.text || ''));
  }
  intgUpdatePane();
}

function intgUpdatePane() {
  const pane = $('#tab-integrations');
  if (!pane || pane.hidden) return;
  const set = (id, st) => {
    const dot = pane.querySelector('#' + id + 'Dot');
    const txt = pane.querySelector('#' + id + 'StatText');
    if (!dot || !txt) return;
    dot.className = 'wa-dot' + (st.status === 'connected' ? ' on' : st.status === 'qr' ? ' qr' : '');
    const suffix = st.user && st.status === 'connected' ? ' · ' + st.user : '';
    txt.textContent = (INTG_STATUS_TEXT[st.status] || st.status) + suffix;
  };
  set('wa', intgUI.wa);
  set('tg', intgUI.tg);
  set('dc', intgUI.dc);
  const qrWrap = pane.querySelector('#waQr');
  const qrImg = pane.querySelector('#waQrImg');
  if (qrWrap && qrImg) {
    const show = intgUI.wa.status === 'qr' && intgUI.wa.qr;
    qrWrap.hidden = !show;
    if (show) qrImg.src = intgUI.wa.qr;
  }
}

function intgChipLabel(e, key) {
  if (e === '*') return '* herkes';
  if (typeof e === 'string') return (key === 'num' ? '+' : '') + e;
  const name = String((e && e.name) || '').trim();
  const v = String((e && e[key]) || '');
  return (name ? name + ' ' : '') + (key === 'num' && v ? '+' : '') + v;
}

async function intgRenderAllow(which) {
  const pane = $('#tab-integrations');
  if (!pane) return;
  const wrap = pane.querySelector('#' + which + 'AllowChips');
  if (!wrap) return;
  const key = which === 'wa' ? 'num' : 'id';
  const list = (await INTG_GET[which]().catch(() => [])) || [];
  wrap.innerHTML = '';
  if (!list.length) wrap.innerHTML = '<span class="sub">— boş —</span>';
  list.forEach((entry, idx) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.style.margin = '0 6px 6px 0';
    const txt = document.createElement('span');
    txt.className = 'chip-txt';
    txt.textContent = intgChipLabel(entry, key);
    txt.title = 'Düzenlemek için tıkla';
    txt.addEventListener('click', () => intgEditAllow(which, idx, c));
    c.appendChild(txt);
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Kaldır';
    x.addEventListener('click', async () => {
      const cur = (await INTG_GET[which]().catch(() => [])) || [];
      await INTG_SET[which](cur.filter((_v, i) => i !== idx));
      intgRenderAllow(which);
      toast('Kaldırıldı: ' + intgChipLabel(entry, key));
    });
    c.appendChild(x);
    wrap.appendChild(c);
  });
}

async function intgEditAllow(which, idx, chipEl) {
  const key = which === 'wa' ? 'num' : 'id';
  const list = (await INTG_GET[which]().catch(() => [])) || [];
  const cur = list[idx];
  if (cur === '*') return;
  const name0 = String((cur && cur.name) || '');
  const val0 = String((cur && cur[key]) || (typeof cur === 'string' ? cur : ''));
  chipEl.innerHTML = '';
  chipEl.style.margin = '0 6px 6px 0';
  const nInp = document.createElement('input');
  nInp.className = 'inp';
  nInp.value = name0;
  nInp.placeholder = 'İsim';
  nInp.style.cssText = 'width:100px;padding:2px 6px;font-size:12px';
  const vInp = document.createElement('input');
  vInp.className = 'inp';
  vInp.value = val0;
  vInp.placeholder = key === 'num' ? 'Numara' : (which === 'tg' ? 'Chat ID / @kullanıcı' : 'Kullanıcı ID / @kullanıcı');
  vInp.style.cssText = 'width:130px;padding:2px 6px;font-size:12px';
  const ok = document.createElement('span');
  ok.className = 'lk';
  ok.textContent = 'Kaydet';
  const cancel = document.createElement('span');
  cancel.className = 'x';
  cancel.textContent = '×';
  cancel.title = 'Vazgeç';
  chipEl.append(nInp, vInp, ok, cancel);
  const save = async () => {
    const next = ((await INTG_GET[which]().catch(() => [])) || []).map((e, i) =>
      i === idx ? { ...(typeof e === 'object' && e ? e : {}), [key]: vInp.value.trim(), name: nInp.value.trim().slice(0, 40) } : e
    );
    await INTG_SET[which](next);
    intgRenderAllow(which);
    toast('Güncellendi');
  };
  ok.addEventListener('click', save);
  vInp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } });
  nInp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } });
  cancel.addEventListener('click', () => intgRenderAllow(which));
  nInp.focus();
}

function intgBindAllowAdd(which) {
  const pane = $('#tab-integrations');
  const key = which === 'wa' ? 'num' : 'id';
  const nameInp = pane.querySelector('#' + which + 'AllowNameInp');
  const vInp = pane.querySelector('#' + which + 'AllowInp');
  const add = pane.querySelector('#' + which + 'AllowAdd');
  if (!add) return;
  const addFn = async () => {
    const v = String(vInp.value || '').trim();
    if (!v) { toast(key === 'num' ? 'Numara gir' : 'ID / kullanıcı adı gir'); vInp.focus(); return; }
    const name = String(nameInp.value || '').trim().slice(0, 40);
    if (!name) { toast('İsim zorunlu — kimin yazdığını bilmek için'); nameInp.focus(); return; }
    const cur = (await INTG_GET[which]().catch(() => [])) || [];
    await INTG_SET[which]([...cur, { [key]: v, name }]);
    vInp.value = '';
    nameInp.value = '';
    intgRenderAllow(which);
    toast('Eklendi: ' + name);
  };
  add.addEventListener('click', addFn);
  vInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFn(); } });
  nameInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFn(); } });
}

async function renderIntegrationsPane() {
  const pane = $('#tab-integrations');
  if (!pane) return;
  const st = (await jev.intgGet().catch(() => null)) || {};
  Object.assign(intgUI.wa, st.wa || {});
  Object.assign(intgUI.tg, st.tg || {});
  Object.assign(intgUI.dc, st.dc || {});
  const g = st.waGroups || { enabled: false, mentionOnly: true };

  pane.innerHTML =
    '<h2>Entegrasyonlar</h2>' +
    '<div class="sub">WhatsApp, Telegram ve Discord\'dan Jev\'e yaz — cevabı aynı kanaldan alırsın. Yalnız izin listesindeki kişiler yazabilir; her kişi kendi sohbet oturumunda konuşur. Bu uygulamada bot yok — mesajlar doğrudan Jev sohbetine düşer.</div>' +

    '<div class="wa-card">' +
      '<div class="wa-head">' +
        '<div class="wa-logo" style="background:linear-gradient(135deg,#7c5cff,#22c1c3)">⇄</div>' +
        '<div><div class="wa-title">Otomatik bildirimler</div><div class="wa-sub">Zamansal analiz, alarm, işlem açılış/kapanış, gelişim ve araç sonuçları entegrasyon sohbetlerine de gider</div></div>' +
      '</div>' +
      '<label class="lock-row"><input type="checkbox" id="intgPushAutoOn"' + (intgPushAutoOn() ? ' checked' : '') + '/><span>Otomatik analiz / alarm / işlem bildirimlerini sohbetlere gönder</span></label>' +
      '<label class="lock-row"><input type="checkbox" id="intgMirrorDeskOn"' + (intgMirrorDeskOn() ? ' checked' : '') + '/><span>Masaüstünde benim yazdığım sohbeti de yansıt</span></label>' +
      '<div class="divider"></div>' +
      '<label class="mem-label" style="margin-top:0">BİLDİRİM HEDEFLERİ</label>' +
      '<div id="intgTargetChips" class="chips-inline"></div>' +
      '<div class="wa-actions" style="margin-top:6px"><button id="intgPushTestBtn" class="btn ghost">Test gönder</button></div>' +
      '<div class="sub" style="margin-top:8px">Entegrasyondan Jev\'e bir kez yazan her sohbet (kişi / grup / Telegram konusu) hedef olur. İzin listesinden çıkarılan ya da bağlı olmayan kanala gönderilmez.</div>' +
    '</div>' +

    '<div class="wa-card" style="margin-top:14px">' +
      '<div class="wa-head">' +
        '<div class="wa-logo">W</div>' +
        '<div><div class="wa-title">WhatsApp</div><div class="wa-sub">QR ile bağla; izin listendeki kişiler Jev\'e yazabilir</div></div>' +
      '</div>' +
      '<div class="wa-status"><span id="waDot" class="wa-dot"></span><span id="waStatText">—</span></div>' +
      '<div id="waQr" hidden><img id="waQrImg" width="220" height="220" alt="QR"><div class="sub" style="margin-top:6px">WhatsApp → Bağlı Cihazlar → Cihaz Bağla ile okut</div></div>' +
      '<div class="wa-actions">' +
        '<button id="waStartBtn" class="btn">Bağlan</button>' +
        '<button id="waStopBtn" class="btn ghost">Kes</button>' +
        '<button id="waResetBtn" class="btn ghost">Eşlemeyi sıfırla</button>' +
      '</div>' +
      '<div style="height:14px"></div>' +
      '<label class="lock-row"><input type="checkbox" id="waGroupsOn"' + (g.enabled ? ' checked' : '') + '/><span>Gruplar açık</span></label>' +
      '<label class="lock-row" id="waGroupsMentionRow" style="' + (g.enabled ? '' : 'opacity:.45') + '"><input type="radio" name="waGroupMode" id="waGroupsMention"' + (g.mentionOnly !== false ? ' checked' : '') + '/><span>Yalnız @mention\'a cevap ver</span></label>' +
      '<label class="lock-row" id="waGroupsAllRow" style="' + (g.enabled ? '' : 'opacity:.45') + '"><input type="radio" name="waGroupMode" id="waGroupsAll"' + (g.mentionOnly === false ? ' checked' : '') + '/><span>Tüm mesajlara karış</span></label>' +
      '<div class="divider"></div>' +
      '<label class="mem-label" style="margin-top:0">İZİN LİSTESİ — WhatsApp</label>' +
      '<div id="waAllowChips" class="chips-inline"></div>' +
      '<div class="form-grid" style="grid-template-columns:1.2fr 1fr auto;align-items:center">' +
        '<input id="waAllowNameInp" class="inp" style="margin:6px 0 0" placeholder="İsim (zorunlu)" autocomplete="off" />' +
        '<input id="waAllowInp" class="inp" style="margin:6px 0 0" placeholder="Numara (ülke kodlu)" autocomplete="off" />' +
        '<button id="waAllowAdd" class="btn ghost" style="margin-top:6px">Ekle</button>' +
      '</div>' +
      '<div class="sub" style="margin-top:8px">Numarayı ülke koduyla gir (örn. 905551112233). İsimsiz kayda cevap verilmez; mesajlar 4,5 sn içinde birleştirilir.</div>' +
    '</div>' +

    '<div class="wa-card" style="margin-top:14px">' +
      '<div class="wa-head">' +
        '<div class="wa-logo tg">T</div>' +
        '<div><div class="wa-title">Telegram</div><div class="wa-sub">Bot tokenı ile bağla; izin listendeki kişiler Jev\'e yazabilir</div></div>' +
      '</div>' +
      '<div class="wa-status"><span id="tgDot" class="wa-dot"></span><span id="tgStatText">—</span></div>' +
      '<div class="form-grid" style="grid-template-columns:1fr auto;align-items:center">' +
        '<input id="tgTokenInp" class="inp" type="password" style="margin:6px 0 0" placeholder="Bot tokenı (123456:ABC…)" autocomplete="off" />' +
        '<button id="tgSaveBtn" class="btn" style="margin-top:6px">Kaydet ve bağlan</button>' +
      '</div>' +
      '<div class="wa-actions" style="margin-top:6px"><button id="tgStopBtn" class="btn ghost">Kes</button></div>' +
      '<div class="divider"></div>' +
      '<label class="mem-label" style="margin-top:0">İZİN LİSTESİ — Telegram</label>' +
      '<div id="tgAllowChips" class="chips-inline"></div>' +
      '<div class="form-grid" style="grid-template-columns:1.2fr 1fr auto;align-items:center">' +
        '<input id="tgAllowNameInp" class="inp" style="margin:6px 0 0" placeholder="İsim (zorunlu)" autocomplete="off" />' +
        '<input id="tgAllowInp" class="inp" style="margin:6px 0 0" placeholder="Chat ID ya da @kullanıcı" autocomplete="off" />' +
        '<button id="tgAllowAdd" class="btn ghost" style="margin-top:6px">Ekle</button>' +
      '</div>' +
      '<div class="sub" style="margin-top:8px">Token @BotFather\'dan alınır. Kişi ID\'si için kişi bota bir kez yazsın; ID\'yi @userinfobot gösterir.</div>' +
    '</div>' +

    '<div class="wa-card" style="margin-top:14px">' +
      '<div class="wa-head">' +
        '<div class="wa-logo dc">D</div>' +
        '<div><div class="wa-title">Discord</div><div class="wa-sub">Bot tokenı ile bağla; DM ve @mention\'lar Jev\'e düşer</div></div>' +
      '</div>' +
      '<div class="wa-status"><span id="dcDot" class="wa-dot"></span><span id="dcStatText">—</span></div>' +
      '<div class="form-grid" style="grid-template-columns:1fr auto;align-items:center">' +
        '<input id="dcTokenInp" class="inp" type="password" style="margin:6px 0 0" placeholder="Bot tokenı" autocomplete="off" />' +
        '<button id="dcSaveBtn" class="btn" style="margin-top:6px">Kaydet ve bağlan</button>' +
      '</div>' +
      '<div class="wa-actions" style="margin-top:6px"><button id="dcStopBtn" class="btn ghost">Kes</button></div>' +
      '<div class="sub" style="margin-top:6px">ⓘ Discord Türkiye\'de zaman zaman engellidir; bağlanamazsan VPN dene. Developer Portal\'da bot için MESSAGE CONTENT INTENT açılmalı.</div>' +
      '<div class="divider"></div>' +
      '<label class="mem-label" style="margin-top:0">İZİN LİSTESİ — Discord</label>' +
      '<div id="dcAllowChips" class="chips-inline"></div>' +
      '<div class="form-grid" style="grid-template-columns:1.2fr 1fr auto;align-items:center">' +
        '<input id="dcAllowNameInp" class="inp" style="margin:6px 0 0" placeholder="İsim (zorunlu)" autocomplete="off" />' +
        '<input id="dcAllowInp" class="inp" style="margin:6px 0 0" placeholder="Kullanıcı ID ya da @kullanıcı" autocomplete="off" />' +
        '<button id="dcAllowAdd" class="btn ghost" style="margin-top:6px">Ekle</button>' +
      '</div>' +
      '<div class="sub" style="margin-top:8px">Sunucu kanallarında yalnız bota @mention edilen mesajlar işlenir; DM\'de her mesaj. İzin listesindeki kişiler yazabilir.</div>' +
    '</div>';

  /* otomatik bildirimler */
  pane.querySelector('#intgPushAutoOn').addEventListener('change', (e) => {
    try { localStorage.setItem(INTG_PUSH_KEY, e.target.checked ? '1' : '0'); } catch {}
    toast(e.target.checked ? 'Otomatik bildirimler sohbetlere gidecek' : 'Otomatik bildirimler kapalı');
  });
  pane.querySelector('#intgMirrorDeskOn').addEventListener('change', (e) => {
    try { localStorage.setItem(INTG_MIRROR_KEY, e.target.checked ? '1' : '0'); } catch {}
    toast(e.target.checked ? 'Masaüstü sohbeti de yansıtılacak' : 'Masaüstü sohbeti yansıtılmayacak');
  });
  pane.querySelector('#intgPushTestBtn').addEventListener('click', async () => {
    const map = intgTargets();
    const keys = Object.keys(map);
    if (!keys.length) { toast('Henüz hedef yok — entegrasyondan Jev\'e bir kez yaz'); return; }
    let ok = 0;
    for (const k of keys) {
      if (await intgPushTo(k, map[k], '✅ JevTrader test — otomatik bildirimler bu sohbete gelecek.', { noHistory: true })) ok++;
    }
    toast('Test: ' + ok + '/' + keys.length + ' sohbete gönderildi');
  });
  intgRenderTargets();

  /* WhatsApp */
  const waGroupsOn = pane.querySelector('#waGroupsOn');
  const waGroupsMention = pane.querySelector('#waGroupsMention');
  const waGroupsAll = pane.querySelector('#waGroupsAll');
  const syncGroupMode = () => {
    const op = waGroupsOn.checked ? '' : '.45';
    pane.querySelector('#waGroupsMentionRow').style.opacity = op;
    pane.querySelector('#waGroupsAllRow').style.opacity = op;
  };
  const saveGroups = async () => {
    const r = await jev.waGroupsSet({ enabled: waGroupsOn.checked, mentionOnly: !waGroupsAll.checked }).catch(() => null);
    if (r) {
      toast(r.enabled
        ? (r.mentionOnly ? 'Gruplar açık — @mention bekler' : 'Gruplar açık — tüm mesajlara karışır')
        : 'Gruplar kapalı');
    }
  };
  waGroupsOn.addEventListener('change', () => { syncGroupMode(); saveGroups(); });
  waGroupsMention.addEventListener('change', () => { syncGroupMode(); saveGroups(); });
  waGroupsAll.addEventListener('change', () => { syncGroupMode(); saveGroups(); });
  syncGroupMode();

  pane.querySelector('#waStartBtn').addEventListener('click', async () => {
    if (intgUI.wa.available === false) { toast('WhatsApp paketi kurulu değil — npm install gerekli'); return; }
    toast('WhatsApp bağlanıyor…');
    const s = await jev.waStart().catch(() => null);
    if (s) { Object.assign(intgUI.wa, s.wa || {}); intgUpdatePane(); }
  });
  pane.querySelector('#waStopBtn').addEventListener('click', async () => {
    const s = await jev.waStop().catch(() => null);
    if (s) { Object.assign(intgUI.wa, s.wa || {}); intgUpdatePane(); }
    toast('WhatsApp kesildi');
  });
  pane.querySelector('#waResetBtn').addEventListener('click', async () => {
    const s = await jev.waReset().catch(() => null);
    if (s) { Object.assign(intgUI.wa, s.wa || {}); intgUpdatePane(); }
    toast('Eşleme sıfırlandı — Bağlan ile yeni QR al');
  });

  /* Telegram */
  pane.querySelector('#tgSaveBtn').addEventListener('click', async () => {
    const tok = pane.querySelector('#tgTokenInp').value.trim();
    if (!tok) { toast('Bot tokenı gir'); return; }
    toast('Telegram bağlanıyor…');
    const s = await jev.tgSet(tok).catch(() => null);
    pane.querySelector('#tgTokenInp').value = '';
    if (s) { Object.assign(intgUI.tg, s.tg || {}); intgUpdatePane(); }
  });
  pane.querySelector('#tgStopBtn').addEventListener('click', async () => {
    const s = await jev.tgStop().catch(() => null);
    if (s) { Object.assign(intgUI.tg, s.tg || {}); intgUpdatePane(); }
    toast('Telegram kesildi');
  });

  /* Discord */
  pane.querySelector('#dcSaveBtn').addEventListener('click', async () => {
    const tok = pane.querySelector('#dcTokenInp').value.trim();
    if (!tok) { toast('Bot tokenı gir'); return; }
    toast('Discord bağlanıyor…');
    const s = await jev.dcSet(tok).catch(() => null);
    pane.querySelector('#dcTokenInp').value = '';
    if (s) { Object.assign(intgUI.dc, s.dc || {}); intgUpdatePane(); }
  });
  pane.querySelector('#dcStopBtn').addEventListener('click', async () => {
    const s = await jev.dcStop().catch(() => null);
    if (s) { Object.assign(intgUI.dc, s.dc || {}); intgUpdatePane(); }
    toast('Discord kesildi');
  });

  intgUpdatePane();
  intgBindAllowAdd('wa');
  intgBindAllowAdd('tg');
  intgBindAllowAdd('dc');
  await intgRenderAllow('wa');
  await intgRenderAllow('tg');
  await intgRenderAllow('dc');
}

/* ---------- entegrasyon mesajı: Jev sohbetine bağla, cevabı geri gönder ----------
   Aynı kişiden gelen istekler sıraya alınır (oturum serileştirmesi). */
const intgBusy = new Map(); // intKey -> Promise

async function handleIntegrationMessage(msg) {
  if (!msg || !msg.reqId || !msg.channel) return;
  const intKey = msg.channel + ':' + String(msg.chatId || '');
  const prev = intgBusy.get(intKey) || Promise.resolve();
  const run = prev.then(() => intgProcess(msg), () => intgProcess(msg));
  const tracked = run.catch(() => {});
  intgBusy.set(intKey, tracked);
  tracked.finally(() => { if (intgBusy.get(intKey) === tracked) intgBusy.delete(intKey); });
  return run;
}

async function intgProcess(msg) {
  const chLabel = msg.channel === 'wa' ? 'WhatsApp' : msg.channel === 'tg' ? 'Telegram' : 'Discord';
  const intKey = msg.channel + ':' + String(msg.chatId || '');
  intgRememberTarget(msg);
  const reply = async (text) => {
    const t = String(text || '').trim() || '(boş yanıt)';
    await jev.intgReply({ reqId: msg.reqId, channel: msg.channel, chatId: msg.chatId, threadId: msg.threadId || null, text: t.slice(0, 3500) }).catch(() => null);
  };
  if (!state.activeModel) {
    jevLogAdd('ENTEGRASYON (' + chLabel + ') · model seçili değil — cevap gönderilemedi', 'err');
    await reply('JevTrader\'da model seçili değil — Ayarlar > Provider sekmesinden model seçilmeli.');
    return;
  }
  let s = sessions.find((x) => x && x.intKey === intKey);
  if (!s) {
    s = {
      id: newId(),
      title: chLabel + ' · ' + String(msg.senderName || msg.senderId || '?').slice(0, 34),
      messages: [],
      tabId: activeTabId,
      intKey,
    };
    sessions.unshift(s);
  }
  s.messages.push({ role: 'user', content: String(msg.text || ''), t: Date.now() });
  saveSessions();
  renderSessions();
  if (activeSession() === s) renderMsgs();
  jevLogAdd('ENTEGRASYON İSTEK (' + chLabel + ') · ' + String(msg.raw || msg.text || '').replace(/\s+/g, ' ').slice(0, 220), 'req');
  toast(chLabel + ': ' + (msg.senderName || msg.senderId || '?') + ' — Jev yanıtlıyor…');
  jev.notify({ title: chLabel + ' mesajı', body: String(msg.senderName || '') + ': ' + String(msg.raw || '').slice(0, 120) });

  const reqId = 'int-chat-' + msg.reqId;
  let res = null;
  try {
    const payload = await buildChatPayload(s);
    payload.requestId = reqId;
    res = await jev.chatSend(payload);
    if (res && !res.ok && !res.aborted && payload.usedShot) {
      res = await jev.chatSend({ requestId: reqId, sessionId: s.id, messages: payload.messagesNoShot });
    }
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }
  if (res && res.ok) {
    let outText = '';
    const prevKind = chainAutoKind;
    chainSessionOverride = s;
    chainAutoKind = '';
    try {
      outText = await applyJevCommands(res.text || '');
    } finally {
      chainSessionOverride = null;
      chainAutoKind = prevKind;
    }
    s.messages.push({ role: 'assistant', content: outText || '(boş yanıt)', t: Date.now() });
    saveSessions();
    if (activeSession() === s) renderMsgs();
    jevLogAdd('ENTEGRASYON YANIT (' + chLabel + ') · ' + (outText || '(boş yanıt)').replace(/\s+/g, ' ').slice(0, 300), 'res');
    await reply(outText);
  } else if (res && res.aborted) {
    await reply('İstek durduruldu.');
  } else {
    const err = (res && res.error) || 'bilinmeyen';
    s.messages.push({ role: 'assistant', content: 'HATA: ' + err, t: Date.now() });
    saveSessions();
    if (activeSession() === s) renderMsgs();
    jevLogAdd('ENTEGRASYON HATA (' + chLabel + ') · ' + err, 'err');
    await reply('HATA: ' + err);
  }
}

/* ---------- entegrasyon yayını: otomatik çıktılar entegrasyon sohbetlerine ----------
   Entegrasyondan Jev'e bir kez yazan her sohbet (kişi / grup / Telegram konusu) hedef
   olarak hatırlanır; zamansal analiz, alarm, işlem bildirimi, gelişim ve araç zinciri
   cevapları oraya da gider. İzin listesi + bağlantı kontrolü main tarafında yapılır. */
const INTG_TARGETS_KEY = 'jev.intgTargets';
const INTG_PUSH_KEY = 'jev.intgPushAuto';      // varsayılan açık
const INTG_MIRROR_KEY = 'jev.intgMirrorDesk';  // varsayılan kapalı
const INTG_PUSH_MAX = 3500;
/* chain (LOOK/WEB/FILE) çıktısının hangi otomatik akıştan doğduğu (sendMessage set eder) */
let chainAutoKind = '';

const INTG_KIND_HEAD = {
  'ZAMANSAL': '⏱ ZAMANSAL ANALİZ',
  'ALARM': '🔔 ALARM ANALİZİ',
  'İŞLEM': '📈 İŞLEM ANALİZİ',
  'GELİŞİM': '🧠 GELİŞİM DEĞERLENDİRMESİ',
  'ALARM_TETIK': '🔔 ALARM TETİKLENDİ',
  'ISLEM_ACILDI': '🟢 İŞLEME GİRİLDİ',
  'ISLEM_KAPANDI': '🔴 İŞLEM KAPANDI',
  'PLAN': '🎯 JEV PLAN',
  'MASAÜSTÜ': '💬 MASAÜSTÜ SOHBET',
};

function intgPushAutoOn() { return localStorage.getItem(INTG_PUSH_KEY) !== '0'; }
function intgMirrorDeskOn() { return localStorage.getItem(INTG_MIRROR_KEY) === '1'; }

function intgTargets() {
  try {
    const raw = JSON.parse(localStorage.getItem(INTG_TARGETS_KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function intgSaveTargets(map) {
  try { localStorage.setItem(INTG_TARGETS_KEY, JSON.stringify(map || {})); } catch {}
}

function intgRememberTarget(msg) {
  if (!msg || !msg.channel || !msg.chatId) return;
  const key = msg.channel + ':' + String(msg.chatId);
  const map = intgTargets();
  map[key] = {
    channel: msg.channel,
    chatId: String(msg.chatId),
    threadId: msg.threadId || null,
    senderId: String(msg.senderId || ''),
    username: String(msg.username || ''),
    name: String(msg.senderName || msg.senderId || '?').slice(0, 40),
    chatTitle: String(msg.chatTitle || '').slice(0, 60),
    isGroup: !!msg.isGroup,
    at: Date.now(),
  };
  intgSaveTargets(map);
  intgRenderTargets();
}

function intgTargetLabel(t) {
  const ch = t.channel === 'wa' ? 'WhatsApp' : t.channel === 'tg' ? 'Telegram' : 'Discord';
  return ch + ' · ' + (t.isGroup && t.chatTitle ? t.chatTitle + ' (' + t.name + ')' : t.name);
}

function intgRenderTargets() {
  const wrap = document.querySelector('#intgTargetChips');
  if (!wrap) return;
  const map = intgTargets();
  const keys = Object.keys(map);
  wrap.innerHTML = '';
  if (!keys.length) { wrap.innerHTML = '<span class="sub">— henüz yok —</span>'; return; }
  for (const k of keys) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.style.margin = '0 6px 6px 0';
    const txt = document.createElement('span');
    txt.className = 'chip-txt';
    txt.textContent = intgTargetLabel(map[k]);
    c.appendChild(txt);
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Hedeften çıkar (tekrar yazarsa yeniden eklenir)';
    x.addEventListener('click', () => {
      const cur = intgTargets();
      delete cur[k];
      intgSaveTargets(cur);
      intgRenderTargets();
    });
    c.appendChild(x);
    wrap.appendChild(c);
  }
}

function intgHead(kind) {
  const h = INTG_KIND_HEAD[kind] || String(kind || 'JEV');
  /* olay bildirimleri kendi sembolünü taşır; yalnız analiz başlıklarına aktif grafik eklenir */
  if (kind === 'ALARM_TETIK' || kind === 'ISLEM_ACILDI' || kind === 'ISLEM_KAPANDI' || kind === 'MASAÜSTÜ') return h;
  let sym = '';
  try {
    if (chartState && chartState.symbol) sym = ' · ' + chartState.symbol + (chartState.tf ? ' ' + chartState.tf : '');
  } catch {}
  return h + sym;
}

/* tek hedefe gönder; başarılıysa (noHistory değilse) o kişinin oturumuna da
   asistan mesajı olarak işlenir — böylece "neden?" diye sorunca Jev bağlamı bilir */
async function intgPushTo(key, t, text, opts) {
  const body = String(text || '').trim();
  if (!t || !body) return false;
  const r = await jev.intgPush({
    channel: t.channel,
    chatId: t.chatId,
    threadId: t.threadId || null,
    senderId: t.senderId || '',
    username: t.username || '',
    text: body.slice(0, INTG_PUSH_MAX),
  }).catch(() => null);
  const ok = !!(r && r.ok);
  if (ok && !(opts && opts.noHistory)) {
    const s = sessions.find((x) => x && x.intKey === key);
    if (s) {
      s.messages.push({ role: 'assistant', content: body, t: Date.now() });
      saveSessions();
      if (activeSession() === s) renderMsgs();
    }
  }
  return ok;
}

/* bilinen tüm entegrasyon sohbetlerine yayınla (except: zaten almış olan hedef) */
function intgBroadcast(kind, text, opts) {
  if (!intgPushAutoOn()) return;
  const o = opts || {};
  const body = String(text || '').trim();
  if (!body) return;
  const full = intgHead(kind) + '\n' + body;
  const map = intgTargets();
  const keys = Object.keys(map).filter((k) => k !== o.except);
  if (!keys.length) return;
  (async () => {
    let sent = 0;
    for (const k of keys) {
      if (await intgPushTo(k, map[k], full, o)) sent++;
    }
    if (sent) jevLogAdd('ENTEGRASYON YAYIN · ' + intgHead(kind) + ' → ' + sent + ' sohbet', 'info');
  })().catch(() => {});
}

/* bir oturumun ürettiği çıktıyı dağıt: oturum bir entegrasyon sohbetiyse ona doğrudan
   (geçmişe zaten yazıldı), kind varsa (otomatik akış) diğer tüm hedeflere yayınla */
function intgDeliverSessionOutput(s, kind, text) {
  const body = String(text || '').trim();
  if (!body) return;
  const own = s && s.intKey ? s.intKey : '';
  if (own && (!kind || intgPushAutoOn())) {
    const t = intgTargets()[own];
    if (t) intgPushTo(own, t, kind ? intgHead(kind) + '\n' + body : body, { noHistory: true }).catch(() => {});
  }
  if (kind) intgBroadcast(kind, body, { except: own });
}

/* ---------- ayarlar: sekmeler ---------- */
let setPaneInit = { provider: false, typesafe: false, logs: false };

async function openSettings() {
  $('#settingsOverlay').hidden = false;
  switchTab('provider');
}
function closeSettings() { $('#settingsOverlay').hidden = true; }

async function switchTab(name) {
  $$('.set-tabs-list .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#tab-provider').hidden = name !== 'provider';
  $('#tab-typesafe').hidden = name !== 'typesafe';
  const apiPane = $('#tab-api');
  if (apiPane) apiPane.hidden = name !== 'api';
  const bPane = $('#tab-binance');
  if (bPane) bPane.hidden = name !== 'binance';
  const oPane = $('#tab-okx');
  if (oPane) oPane.hidden = name !== 'okx';
  const tPane = $('#tab-transfer');
  if (tPane) tPane.hidden = name !== 'transfer';
  const logsPane = $('#tab-logs');
  if (logsPane) logsPane.hidden = name !== 'logs';
  const skPane = $('#tab-skills');
  if (skPane) skPane.hidden = name !== 'skills';
  const intPane = $('#tab-integrations');
  if (intPane) intPane.hidden = name !== 'integrations';
  const codePane = $('#tab-code');
  if (codePane) codePane.hidden = name !== 'code';
  const chatPane = $('#tab-chat');
  if (chatPane) chatPane.hidden = name !== 'chat';
  if (name === 'provider') await renderProviderPane();
  if (name === 'typesafe') await renderTypesafePane();
  if (name === 'api') await renderApiPane();
  if (name === 'skills') await renderSkillsPane();
  if (name === 'integrations') await renderIntegrationsPane();
  if (name === 'code') await renderCodePane();
  if (name === 'binance' || name === 'okx') await renderExchangePane(name);
  if (name === 'transfer') await renderTransferPane();
  if (name === 'logs') await renderLogsPane();
  if (name === 'chat') await renderChatPane();
  setPaneInit[name] = true;
}

/* ---------- ayarlar: borsa API anahtarları (gerçek hesap + yerel deneme hesabı) ---------- */
/* pane düzenleme durumu: hangi hesap türü düzenleniyor / hangisi kayıtlı-aktif */
const exPaneMode = { binance: 'real', okx: 'real' };
const exPaneActive = { binance: 'real', okx: 'real' };
const exPaneDraft = { binance: { real: null }, okx: { real: null } };
/* kayıtlı deneme başlangıç bakiyesi (USDT) */
const exPaneBal = { binance: 10000, okx: 10000 };

function exPaneCollect(name) {
  if (exPaneMode[name] === 'demo') {
    const e = $('#exBalance_' + name);
    return { balance: e ? Number(String(e.value).replace(',', '.')) || 0 : 0 };
  }
  const g = (id) => { const e = $('#' + id); return e ? String(e.value || '').trim() : ''; };
  return { key: g('exKey_' + name), secret: g('exSecret_' + name), pass: g('exPass_' + name) };
}

function exPaneFill(name) {
  if (exPaneMode[name] === 'demo') {
    const e = $('#exBalance_' + name);
    if (e) e.value = String(exPaneBal[name] > 0 ? exPaneBal[name] : 10000);
    return;
  }
  const d = (exPaneDraft[name] && exPaneDraft[name].real) || { key: '', secret: '', pass: '' };
  const set = (id, v) => { const e = $('#' + id); if (e) e.value = v; };
  set('exKey_' + name, d.key || '');
  set('exSecret_' + name, d.secret || '');
  set('exPass_' + name, d.pass || '');
}

function exPaneInfo(name) {
  const el = $('#exActive_' + name);
  if (!el) return;
  const demo = exPaneActive[name] === 'demo';
  el.classList.toggle('ex-demo-on', demo);
  if (demo) {
    const b = exPaneBal[name] > 0 ? exPaneBal[name] : 10000;
    el.textContent = 'Aktif hesap: YEREL DENEME · başlangıç ' + b.toLocaleString('tr-TR') + ' USDT · API anahtarı gerekmez';
  } else {
    el.textContent = 'Aktif hesap: Gerçek hesap';
  }
}

/* düzenlenen hesap türünü göster; yazılanlar o türün taslağına kaydedilir */
function exPaneRenderMode(name) {
  const mode = exPaneMode[name];
  const tabs = $('#exModeTabs_' + name);
  if (tabs) for (const b of tabs.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
  const keyRows = $('#exKeyRows_' + name);
  if (keyRows) keyRows.hidden = mode === 'demo';
  const demoRows = $('#exDemoRows_' + name);
  if (demoRows) demoRows.hidden = mode !== 'demo';
  const help = $('#exDemoHelp_' + name);
  if (help) help.hidden = mode !== 'demo';
  const reset = $('#exReset_' + name);
  if (reset) reset.hidden = mode !== 'demo';
  exPaneFill(name);
}

function exPaneSetMode(name, mode) {
  const next = mode === 'demo' ? 'demo' : 'real';
  if (next === exPaneMode[name]) return;
  if (exPaneMode[name] === 'real') exPaneDraft[name].real = exPaneCollect(name);
  exPaneMode[name] = next;
  exPaneRenderMode(name);
  const msg = $('#exMsg_' + name);
  if (msg) msg.textContent = '';
}

/* aktif borsada hesap/pozisyon/emir görünümünü hemen tazele */
function exPaneRefreshLive(name) {
  if (exName !== name) return;
  chartState.account = null;
  updateAccount(null);
  refreshPositions();
  refreshOrders();
  refreshClosed();
}

/* görünen alanları kaydet; kaydedilen hesap türü aktif hesap olur */
async function exPaneSave(name) {
  const mode = exPaneMode[name];
  const d = exPaneCollect(name);
  const msg = $('#exMsg_' + name);
  if (mode === 'demo') {
    /* yerel deneme: anahtar yok; başlangıç bakiyesi yeterli */
    const bal = Number(d.balance);
    if (!(bal > 0)) {
      if (msg) msg.textContent = 'Geçerli bir başlangıç bakiyesi gir (USDT)';
      return false;
    }
    const r = await jev.exKeysSet({ name, mode: 'demo', balance: bal, demo: true }).catch(() => null);
    if (!r || !r.ok) {
      if (msg) msg.textContent = 'Kaydedilemedi';
      return false;
    }
    const changed = Math.abs(bal - Number(exPaneBal[name])) > 1e-9;
    if (changed) await jev.exDemoReset({ name, balance: bal }).catch(() => null);
    exPaneBal[name] = bal;
    exPaneActive[name] = 'demo';
    exPaneInfo(name);
    await refreshExPicker();
    exPaneRefreshLive(name);
    if (msg) {
      msg.textContent = changed
        ? 'Kaydedildi ✓ · Deneme hesabı ' + bal.toLocaleString('tr-TR') + ' USDT ile sıfırlandı'
        : 'Kaydedildi ✓ · Aktif: yerel deneme hesabı';
    }
    return true;
  }
  exPaneDraft[name].real = d;
  const needPass = name === 'okx';
  if (!d.key || !d.secret || (needPass && !d.pass)) {
    if (msg) msg.textContent = 'API Key' + (needPass ? ', Secret ve Passphrase' : ' ve Secret') + ' gerekli';
    return false;
  }
  const r = await jev.exKeysSet({ name, mode: 'real', key: d.key, secret: d.secret, pass: d.pass, demo: false }).catch(() => null);
  if (!r || !r.ok) {
    if (msg) msg.textContent = 'Kaydedilemedi';
    return false;
  }
  exPaneActive[name] = 'real';
  exPaneInfo(name);
  await refreshExPicker();
  exPaneRefreshLive(name);
  return true;
}

async function renderExchangePane(name) {
  const el = $('#tab-' + name);
  if (!el) return;
  const title = name === 'binance' ? 'Binance API' : 'OKX API';
  const info = name === 'binance'
    ? 'Binance USDT-M Futures hesabı. API anahtarında "Futures" izni gerekir.'
    : 'OKX Swap hesabı. "Trade" izinli API anahtarı ve Passphrase gerekir.';
  const demoHelp = 'Yerel deneme hesabı: API anahtarı gerekmez — emirler bu bilgisayarda simüle edilir, fiyatlar gerçek piyasadan alınır. Başlangıç bakiyesini gir; bakiyeyi değiştirip Kaydet\'e basarsan hesap sıfırlanır.';
  if (!el.dataset.init) {
    const EYE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
    const EYE_OFF = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><line x1="4" y1="20" x2="20" y2="4"/></svg>';
    /* API alanları maskeli; göz ikonu ile göster/gizle */
    const pwRow = (label, id) =>
      '<div class="color-row"><span>' + label + '</span><span class="pw-wrap">' +
      '<input id="' + id + '" class="inp" type="password" style="width:340px" autocomplete="off" spellcheck="false" />' +
      '<button class="pw-eye" data-for="' + id + '" title="Göster">' + EYE + '</button>' +
      '</span></div>';
    el.innerHTML =
      '<h2>' + title + '</h2>' +
      '<div class="sub">' + info + ' Anahtarlar yerel ayar dosyanda saklanır.</div>' +
      '<div class="ex-mode" id="exModeTabs_' + name + '">' +
      '<button type="button" data-mode="real">Gerçek Hesap</button>' +
      '<button type="button" data-mode="demo">Deneme Hesabı<span class="ex-demo-tag">DEMO</span></button>' +
      '</div>' +
      '<div class="sub ex-active" id="exActive_' + name + '"></div>' +
      '<div id="exKeyRows_' + name + '">' +
      pwRow('API Key', 'exKey_' + name) +
      pwRow('API Secret', 'exSecret_' + name) +
      (name === 'okx' ? pwRow('Passphrase', 'exPass_' + name) : '') +
      '</div>' +
      '<div id="exDemoRows_' + name + '" hidden>' +
      '<div class="color-row"><span>İlk bakiye (USDT)</span>' +
      '<input id="exBalance_' + name + '" class="inp" type="number" min="1" step="100" style="width:200px" autocomplete="off" />' +
      '</div>' +
      '</div>' +
      '<div class="sub ex-demo-help" id="exDemoHelp_' + name + '" hidden>' + demoHelp + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:12px;justify-content:center">' +
      '<button id="exSave_' + name + '" class="btn">Kaydet</button>' +
      '<button id="exTest_' + name + '" class="btn ghost">Bağlantıyı test et</button>' +
      '<button id="exReset_' + name + '" class="btn ghost" hidden>Hesabı sıfırla</button>' +
      '<button id="exUse_' + name + '" class="btn ghost">Bu borsayı kullan</button>' +
      '</div>' +
      '<div id="exMsg_' + name + '" class="sub" style="margin-top:10px;text-align:center"></div>';
    el.dataset.init = '1';
    for (const b of el.querySelectorAll('.pw-eye')) {
      const inp = el.querySelector('#' + b.dataset.for);
      if (!inp) continue;
      b.addEventListener('click', () => {
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        b.innerHTML = show ? EYE_OFF : EYE;
        b.classList.toggle('on', show);
        b.title = show ? 'Gizle' : 'Göster';
      });
    }
    for (const b of el.querySelectorAll('#exModeTabs_' + name + ' button')) {
      b.addEventListener('click', () => exPaneSetMode(name, b.dataset.mode));
    }
    $('#exSave_' + name).addEventListener('click', async () => {
      const mode = exPaneMode[name];
      if (!(await exPaneSave(name))) return;
      if (mode === 'real') $('#exMsg_' + name).textContent = 'Kaydedildi ✓ · Aktif: Gerçek hesap';
    });
    $('#exTest_' + name).addEventListener('click', async () => {
      const msg = $('#exMsg_' + name);
      if (!(await exPaneSave(name))) return;
      msg.textContent = 'Test ediliyor…';
      const r = await jev.exTest(name).catch(() => null);
      msg.textContent = r && r.ok ? ('Bağlantı OK · ' + (r.summary || '')) : ('Hata: ' + ((r && r.error) || 'yanıt yok'));
    });
    $('#exReset_' + name).addEventListener('click', async () => {
      const d = exPaneCollect(name);
      const bal = Number(d.balance) > 0 ? Number(d.balance) : exPaneBal[name];
      const r = await jev.exDemoReset({ name, balance: bal }).catch(() => null);
      const msg = $('#exMsg_' + name);
      if (r && r.ok) {
        exPaneBal[name] = bal;
        exPaneInfo(name);
        exPaneRefreshLive(name);
        if (msg) msg.textContent = 'Deneme hesabı sıfırlandı · ' + bal.toLocaleString('tr-TR') + ' USDT';
      } else if (msg) msg.textContent = 'Sıfırlanamadı';
    });
    $('#exUse_' + name).addEventListener('click', async () => {
      if (!(await exPaneSave(name))) return;
      await applyExchangeSwitch(name);
      closeSettings();
    });
  }
  const k = await jev.exKeysGet(name).catch(() => null);
  if (k && k.ok) {
    exPaneDraft[name] = { real: { key: k.key || '', secret: k.secret || '', pass: k.pass || '' } };
    exPaneBal[name] = Number(k.demoBalance) > 0 ? Number(k.demoBalance) : 10000;
    exPaneActive[name] = k.demo === true ? 'demo' : 'real';
    exPaneMode[name] = exPaneActive[name];
    exPaneRenderMode(name);
    exPaneInfo(name);
  }
}

/* ---------- ayarlar: para transferi (OKX GERÇEK hesap) ----------
   Hesaplar arası transfer (Funding ↔ Trading) + çekim (on-chain / OKX içi).
   Ağ listesi, min çekim, ücret aralığı ve TAG gereksinimi OKX currencies
   ucundan gelir; yapılan işlemler settings.json'a kaydedilir. */
const tfState = { ccy: 'USDT', info: null, confirm: null, prefilled: false };

function tfAmt(v) {
  const n = Number(v) || 0;
  if (n === 0) return '0';
  return Math.abs(n) >= 1000
    ? n.toLocaleString('tr-TR', { maximumFractionDigits: 8 })
    : String(Number(n.toFixed(8)));
}

function tfShort(addr) {
  const s = String(addr || '');
  return s.length > 20 ? s.slice(0, 12) + '…' + s.slice(-6) : s;
}

const TF_WD_STATE = {
  '-3': 'İptal ediliyor', '-2': 'İptal', '-1': 'Başarısız', 0: 'Bekliyor',
  1: 'Gönderiliyor', 2: 'Gönderildi', 3: 'E-posta doğrulama', 4: 'Manuel doğrulama', 5: 'Kimlik doğrulama',
};
const TF_TR_STATE = { pending: 'Bekliyor', success: 'Başarılı', failed: 'Başarısız' };

function tfMsg(id, text, bad) {
  const el = $('#' + id);
  if (!el) return;
  el.textContent = text || '';
  el.style.color = bad ? '#ef4444' : '';
}

function tfBalanceLine(list, label) {
  const b = (list || [])[0];
  return '<span>' + label + ': <b>' + (b ? tfAmt(b.avail) : '0') + ' ' + tfState.ccy + '</b>' +
    (b && b.frozen > 0 ? ' <span class="tf-badge">kilitli ' + tfAmt(b.frozen) + '</span>' : '') + '</span>';
}

function tfFillLast(last) {
  if (!last) return;
  if (last.kind === 'withdraw') {
    if (last.toAddr && $('#tfAddr') && !$('#tfAddr').value) $('#tfAddr').value = last.toAddr;
    if (last.tag && $('#tfTag') && !$('#tfTag').value) $('#tfTag').value = last.tag;
    if (last.dest && $('#tfDest')) $('#tfDest').value = last.dest;
    if (last.chain && $('#tfChain')) {
      const has = Array.from($('#tfChain').options || []).some((o) => o.value === last.chain);
      if (has) $('#tfChain').value = last.chain;
    }
    tfChainChanged();
  } else if ($('#tfDir') && last.from && last.to) {
    $('#tfDir').value = (last.from === '6' && last.to === '18') ? '6>18'
      : (last.from === '18' && last.to === '6') ? '18>6' : '6>18';
  }
}

async function tfLoadInfo() {
  const inp = $('#tfCcy');
  const ccy = String(((inp && inp.value) || 'USDT')).trim().toUpperCase() || 'USDT';
  tfState.ccy = ccy;
  const info = await jev.exTransferInfo({ ccy }).catch(() => null);
  tfState.info = info || null;
  const warn = $('#tfWarn');
  const status = $('#tfStatus');
  if (warn) warn.hidden = true;
  if (status) status.textContent = '';
  if (!info) {
    tfMsg('tfTrMsg', 'Bağlantı hatası', true);
    return;
  }
  /* son kullanılan birimi bir kez öner */
  if (!tfState.prefilled && info.last && info.last.ccy && info.last.ccy !== ccy) {
    tfState.prefilled = true;
    if (inp) inp.value = info.last.ccy;
    return tfLoadInfo();
  }
  tfState.prefilled = true;
  if (!info.keysReady) {
    if (status) status.textContent = 'OKX gerçek hesap anahtarları kayıtlı değil.';
    if (warn) {
      warn.hidden = false;
      warn.textContent = 'Transfer yalnız OKX GERÇEK hesapta çalışır. Ayarlar > OKX API bölümünde "Trade + Withdraw" izinli API anahtarı, Secret ve Passphrase girip kaydet.';
    }
    if ($('#tfBal')) $('#tfBal').textContent = '—';
    tfFillChains([]);
    return;
  }
  if (info.demoMode && warn) {
    warn.hidden = false;
    warn.textContent = 'DİKKAT: Uygulamada OKX "Deneme Hesabı" seçili, ancak bu bölüm her zaman GERÇEK hesabın anahtarlarıyla çalışır. Gönderilen transfer/çekimler gerçek bakiyeye işler.';
  }
  if (status) {
    status.textContent = 'Gerçek hesap bağlı' + (info.currenciesError ? ' · ağ listesi hatası: ' + info.currenciesError : '');
  }
  if ($('#tfBal')) {
    $('#tfBal').innerHTML = tfBalanceLine(info.funding, 'Funding (çekilebilir)') +
      tfBalanceLine(info.trading, 'Trading') +
      (info.fundingError ? '<span style="color:#ef4444">' + info.fundingError + '</span>' : '') +
      (info.tradingError ? '<span style="color:#ef4444">' + info.tradingError + '</span>' : '');
  }
  tfFillChains(info.currencies || []);
  tfFillLast(info.last);
}

function tfFillChains(list) {
  const sel = $('#tfChain');
  if (!sel) return;
  const chains = (list || []).filter((c) => c.canWd !== false);
  const prev = sel.value;
  sel.innerHTML = chains.length
    ? chains.map((c) => {
        const bits = [];
        if (c.minWd > 0) bits.push('min ' + tfAmt(c.minWd));
        if (c.minFee > 0 || c.maxFee > 0) bits.push('ücret ' + tfAmt(c.minFee) + (c.maxFee > c.minFee ? '-' + tfAmt(c.maxFee) : ''));
        if (c.needTag) bits.push('TAG');
        return '<option value="' + String(c.chain).replace(/"/g, '') + '">' + (c.chainName || c.chain) + (bits.length ? ' — ' + bits.join(' · ') : '') + '</option>';
      }).join('')
    : '<option value="">(ağ listesi yok — birim doğru mu?)</option>';
  if (prev && chains.some((c) => c.chain === prev)) sel.value = prev;
  tfChainChanged();
}

function tfChainChanged() {
  const sel = $('#tfChain');
  const chain = sel ? sel.value : '';
  const c = ((tfState.info && tfState.info.currencies) || []).find((x) => x.chain === chain) || null;
  const fee = $('#tfFee');
  if (fee && c) fee.value = String(c.minFee > 0 ? c.minFee : 0);
  const tagRow = $('#tfTagRow');
  const internal = (($('#tfDest') || {}).value || '4') === '3';
  if (tagRow) tagRow.hidden = internal || !(c && c.needTag);
  const info = $('#tfChainInfo');
  if (info) {
    info.textContent = c
      ? 'min çekim ' + tfAmt(c.minWd) +
        ' · ücret ' + tfAmt(c.minFee) + (c.maxFee > c.minFee ? '-' + tfAmt(c.maxFee) : '') +
        ' · adım ' + (c.wdTickSz || '-') + (c.needTag ? ' · TAG/memo gerekli' : '')
      : '';
  }
  tfUpdateDest();
}

function tfUpdateDest() {
  const internal = (($('#tfDest') || {}).value || '4') === '3';
  const chainRow = $('#tfChainRow');
  if (chainRow) chainRow.style.display = internal ? 'none' : '';
  const feeRow = $('#tfFeeRow');
  if (feeRow) feeRow.style.display = internal ? 'none' : '';
  const tagRow = $('#tfTagRow');
  if (tagRow && internal) tagRow.hidden = true;
  const info = $('#tfChainInfo');
  if (info) info.style.display = internal ? 'none' : '';
  /* OKX içi transfer YALNIZ UID ile yapılır (e-posta/telefon yok) */
  const label = $('#tfAddrLabel');
  if (label) label.textContent = internal ? 'OKX UID' : 'Adres';
  const addr = $('#tfAddr');
  if (addr) {
    addr.placeholder = internal ? 'OKX UID (sadece rakam)' : 'Cüzdan adresi';
    addr.style.width = '100%';
    if (internal) addr.value = String(addr.value || '').replace(/\D+/g, '');
  }
}

/* iki adımlı onay: ilk tık özeti gösterir, ikinci tık (60 sn içinde) gönderir */
function tfConfirmArmed(kind) {
  return !!(tfState.confirm && tfState.confirm.kind === kind && Date.now() - tfState.confirm.at < 60000);
}
function tfArm(kind, msgId, summary) {
  tfState.confirm = { kind, at: Date.now() };
  tfMsg(msgId, summary + ' — ONAYLAMAK için butona TEKRAR bas (60 sn).');
}

/* sık görülen OKX çekim/transfer hataları için Türkçe yol gösterimi */
function tfFriendlyErr(text) {
  const s = String(text || '');
  const m = s.match(/\(kod\s+(\d+)\)/);
  const code = m ? m[1] : '';
  const guide = {
    58207: 'Adres/hesap OKX "doğrulanmış adres listesi"nde yok — API kuralı. OKX uygulaması/web: Assets > Withdraw > Address Book > Add address ile adresi ekle, kaydederken "doğrulanmış" kutusunu işaretle (Allowlist açıkken yalnız defterdeki adreslere çekim yapılır; yeni eklenen adres 24 saat kilitte olabilir).',
    58350: 'Bakiye yetersiz — Funding hesabındaki çekilebilir tutarı kontrol et.',
    58343: 'Bu birim/ağ için çekim şu an kapalı.',
    58349: 'Miktar ağın minimum çekiminin altında.',
    50014: 'Eksik parametre — OKX içi transferde yalnız UID gir (telefon/e-posta seçiliyken alan kodu gerekir).',
    58109: 'Ağ ücreti geçersiz — seçili ağın ücret aralığına bak.',
  };
  if (code && guide[code]) return guide[code] + ' (' + s + ')';
  return s;
}

async function tfDoTransfer() {
  const dir = ($('#tfDir') || {}).value || '6>18';
  const from = dir.split('>')[0];
  const to = dir.split('>')[1];
  const amt = Number(($('#tfTrAmt') || {}).value);
  const ccy = tfState.ccy;
  if (!(amt > 0)) return tfMsg('tfTrMsg', 'Geçerli bir miktar gir', true);
  if (!tfConfirmArmed('transfer')) {
    return tfArm('transfer', 'tfTrMsg', 'Transfer: ' + tfAmt(amt) + ' ' + ccy + ' · ' +
      (from === '6' ? 'Funding' : 'Trading') + ' → ' + (to === '18' ? 'Trading' : 'Funding'));
  }
  tfState.confirm = null;
  tfMsg('tfTrMsg', 'Gönderiliyor…');
  const r = await jev.exTransfer({ ccy, amt, from, to }).catch(() => null);
  if (r && r.ok) {
    const t = (r.data && r.data.transfer) || {};
    tfMsg('tfTrMsg', 'Transfer OK · ID ' + (t.transId || '?'));
    toast('Transfer tamam: ' + tfAmt(amt) + ' ' + ccy);
    await tfLoadInfo();
    await tfLoadHistory();
  } else {
    tfMsg('tfTrMsg', 'Hata: ' + tfFriendlyErr((r && r.error) || 'yanıt yok'), true);
  }
}

async function tfDoWithdraw() {
  const ccy = tfState.ccy;
  const dest = ($('#tfDest') || {}).value || '4';
  const internal = dest === '3';
  const chain = ($('#tfChain') || {}).value || '';
  const toAddrRaw = String(($('#tfAddr') || {}).value || '').trim();
  const tag = String(($('#tfTag') || {}).value || '').trim();
  const amt = Number(($('#tfWdAmt') || {}).value);
  const fee = internal ? 0 : Number(($('#tfFee') || {}).value);
  const c = ((tfState.info && tfState.info.currencies) || []).find((x) => x.chain === chain) || null;
  if (!(amt > 0)) return tfMsg('tfWdMsg', 'Geçerli bir miktar gir', true);
  if (!toAddrRaw) return tfMsg('tfWdMsg', internal ? 'OKX UID gir' : 'Adres gir', true);
  if (internal && !/^\d{4,20}$/.test(toAddrRaw)) {
    return tfMsg('tfWdMsg', 'OKX içi transfer yalnız UID ile: rakamlardan oluşan UID gir', true);
  }
  if (!internal) {
    if (!chain) return tfMsg('tfWdMsg', 'Ağ (chain) seç', true);
    if (!(fee >= 0)) return tfMsg('tfWdMsg', 'Ağ ücreti geçersiz', true);
    if (c && c.canWd === false) return tfMsg('tfWdMsg', 'Bu ağda çekim kapalı', true);
    if (c && c.minWd > 0 && amt < c.minWd) return tfMsg('tfWdMsg', 'Miktar ağın minimumunun altında: ' + tfAmt(c.minWd) + ' ' + ccy, true);
    if (c && c.needTag && !tag) return tfMsg('tfWdMsg', 'Bu ağ TAG/memo istiyor', true);
  }
  /* OKX dokümanı: tag gereken adresler "adres:tag" biçiminde gönderilir */
  const toAddr = (!internal && tag && !toAddrRaw.includes(':')) ? toAddrRaw + ':' + tag : toAddrRaw;
  if (!tfConfirmArmed('withdraw')) {
    const sum = 'ÇEKİM: ' + tfAmt(amt) + ' ' + ccy +
      (internal
        ? ' · OKX içi · UID ' + toAddrRaw
        : ' · ağ ' + ((c && (c.chainName || c.chain)) || chain) + ' · ücret ' + tfAmt(fee) + ' · adres ' + tfShort(toAddrRaw));
    return tfArm('withdraw', 'tfWdMsg', sum);
  }
  tfState.confirm = null;
  tfMsg('tfWdMsg', 'Çekim talebi gönderiliyor…');
  const r = await jev.exWithdraw({ ccy, amt, dest, toAddr, chain, fee, tag }).catch(() => null);
  if (r && r.ok) {
    const w = (r.data && r.data.withdrawal) || {};
    tfMsg('tfWdMsg', 'Çekim talebi alındı · wdId ' + (w.wdId || '?'));
    toast('Çekim talebi gönderildi');
    await tfLoadInfo();
    await tfLoadHistory();
  } else {
    tfMsg('tfWdMsg', 'Hata: ' + tfFriendlyErr((r && r.error) || 'yanıt yok'), true);
  }
}

function tfLogHtml(log) {
  if (!log || !log.length) {
    return '<div class="sub">Bu sayfadan yapılan transfer/çekimler burada saklanır — henüz kayıt yok.</div>';
  }
  return log.map((x) => {
    const when = x.at ? new Date(x.at).toLocaleString('tr-TR') : '';
    const dir = x.kind === 'withdraw'
      ? 'Çekim · ' + (x.dest === '3' ? 'OKX içi' : (x.chain || '')) + ' · ' + tfShort(x.toAddr)
      : 'Transfer · ' + (x.from === '6' ? 'Funding' : 'Trading') + ' → ' + (x.to === '18' ? 'Trading' : 'Funding');
    const st = x.kind === 'withdraw' ? TF_WD_STATE[x.state] : TF_TR_STATE[x.state];
    return '<div class="tf-log-row"><span class="tf-badge">' + (x.kind === 'withdraw' ? 'ÇEKİM' : 'TRANSFER') + '</span>' +
      '<b>' + tfAmt(x.amt) + ' ' + (x.ccy || '') + '</b><span>' + dir + '</span>' +
      (st ? '<span class="tf-badge">' + st + '</span>' : '') +
      '<span class="tf-log-id">' + (x.id || '') + '</span><span class="tf-log-at">' + when + '</span></div>';
  }).join('');
}

async function tfLoadHistory() {
  const list = $('#tfHistList');
  if (list) list.textContent = 'Yükleniyor…';
  const r = await jev.exTransferHistory({ ccy: tfState.ccy }).catch(() => null);
  if (!r) {
    if (list) list.innerHTML = '<div class="sub">Geçmiş alınamadı.</div>';
    return;
  }
  const parts = [];
  if (r.log && r.log.length) parts.push('<div class="tf-hist-title">Kayıtlı işlemler (bu uygulamadan)</div>' + tfLogHtml(r.log));
  if (r.ok) {
    const wd = (r.withdrawals || []).map((x) =>
      '<div class="tf-log-row"><span class="tf-badge">ÇEKİM</span><b>' + tfAmt(x.amt) + ' ' + x.ccy + '</b>' +
      '<span>' + (x.chain || '') + ' · ' + tfShort(x.toAddr) + '</span>' +
      '<span class="tf-badge">' + (TF_WD_STATE[x.state] || x.state || '') + '</span>' +
      '<span class="tf-log-at">' + (x.ts ? new Date(x.ts).toLocaleString('tr-TR') : '') + '</span></div>');
    const tr = (r.transfers || []).map((x) =>
      '<div class="tf-log-row"><span class="tf-badge">TRANSFER</span><b>' + tfAmt(x.amt) + ' ' + x.ccy + '</b>' +
      '<span>' + (x.from === '6' ? 'Funding' : 'Trading') + ' → ' + (x.to === '18' ? 'Trading' : 'Funding') + '</span>' +
      '<span class="tf-badge">' + (TF_TR_STATE[x.state] || x.state || '') + '</span>' +
      '<span class="tf-log-at">' + (x.ts ? new Date(x.ts).toLocaleString('tr-TR') : '') + '</span></div>');
    if (wd.length || tr.length) parts.push('<div class="tf-hist-title">OKX geçmişi (son 20)</div>' + wd.join('') + tr.join(''));
    else if (r.withdrawalsError || r.transfersError) {
      parts.push('<div class="sub" style="color:#ef4444">' + (r.withdrawalsError || r.transfersError) + '</div>');
    }
  } else if (r.error) {
    parts.push('<div class="sub" style="color:#ef4444">' + r.error + '</div>');
  }
  if (list) list.innerHTML = parts.length ? parts.join('') : '<div class="sub">İşlem geçmişi yok.</div>';
}

async function renderTransferPane() {
  const el = $('#tab-transfer');
  if (!el) return;
  if (!el.dataset.init) {
    el.innerHTML =
      '<h2>Para Transferi — OKX</h2>' +
      '<div class="sub">Gerçek hesapta çalışır; gönderimler geri alınamaz. Önce <b>Ayarlar &gt; OKX API</b> bölümünde <b>Trade</b> ve <b>Withdraw</b> izinli API anahtarı + Secret + Passphrase kaydet. OKX içi transferler yalnız <b>UID</b> ile yapılır.</div>' +
      '<div id="tfWarn" class="tf-warn" hidden></div>' +
      '<div id="tfStatus" class="sub ex-active"></div>' +

      '<div class="tf-card">' +
      '<div class="tf-card-title">Bakiye</div>' +
      '<div class="tf-cols">' +
      '<label>Birim<span class="tf-amt"><input id="tfCcy" class="inp tf-mono" value="USDT" spellcheck="false" /><button id="tfLoad" class="btn ghost">Yenile</button></span></label>' +
      '</div>' +
      '<div id="tfBal" class="tf-bal">—</div>' +
      '</div>' +

      '<div class="tf-card">' +
      '<div class="tf-card-title">1) Hesaplar Arası Transfer (Funding ↔ Trading)</div>' +
      '<div class="tf-cols">' +
      '<label>Yön<select id="tfDir" class="inp"><option value="6>18">Funding → Trading</option><option value="18>6">Trading → Funding</option></select></label>' +
      '<label>Miktar<span class="tf-amt"><input id="tfTrAmt" class="inp" type="number" min="0" step="any" /><button id="tfTrMax" class="btn ghost">Tümü</button></span></label>' +
      '</div>' +
      '<div class="tf-actions"><button id="tfTrGo" class="btn">Transfer Et</button><span id="tfTrMsg" class="sub"></span></div>' +
      '</div>' +

      '<div class="tf-card">' +
      '<div class="tf-card-title">2) Çekim</div>' +
      '<div class="sub" style="margin-bottom:8px">API kuralı: on-chain çekimde adres, OKX Adres Defteri\'nde <b>doğrulanmış</b> kayıtlı olmalı (Allowlist kapalı bile olsa). OKX içi transferde yalnız UID yazılır.</div>' +
      '<div class="tf-cols">' +
      '<label>Hedef<select id="tfDest" class="inp"><option value="4">On-chain (ağ + adres)</option><option value="3">OKX içi (UID)</option></select></label>' +
      '<label id="tfChainRow">Ağ (chain)<select id="tfChain" class="inp"></select></label>' +
      '<label>Miktar<span class="tf-amt"><input id="tfWdAmt" class="inp" type="number" min="0" step="any" /><button id="tfWdMax" class="btn ghost">Tümü</button></span></label>' +
      '<label id="tfFeeRow">Ağ ücreti<input id="tfFee" class="inp" type="number" min="0" step="any" /></label>' +
      '</div>' +
      '<div class="tf-field" id="tfAddrRow"><label id="tfAddrLabel" for="tfAddr">Adres</label><input id="tfAddr" class="inp tf-mono" autocomplete="off" spellcheck="false" /></div>' +
      '<div class="tf-field" id="tfTagRow" hidden><label for="tfTag">Tag / Memo</label><input id="tfTag" class="inp tf-mono" autocomplete="off" spellcheck="false" placeholder="gerekliyse — adres:tag olarak gönderilir" /></div>' +
      '<div class="tf-hint" id="tfChainInfo"></div>' +
      '<div class="tf-actions"><button id="tfWdGo" class="btn">Çekim Talebi Gönder</button><span id="tfWdMsg" class="sub"></span></div>' +
      '</div>' +

      '<div class="tf-card">' +
      '<div class="tf-card-title">3) Son İşlemler<button id="tfHist" class="btn ghost">Yenile</button></div>' +
      '<div id="tfHistList" class="tf-log"><div class="sub">Yükleniyor…</div></div>' +
      '</div>';
    $('#tfCcy').addEventListener('change', () => { tfState.confirm = null; tfLoadInfo(); });
    $('#tfLoad').addEventListener('click', () => { tfState.confirm = null; tfLoadInfo(); });
    $('#tfChain').addEventListener('change', tfChainChanged);
    $('#tfDest').addEventListener('change', tfUpdateDest);
    /* OKX içi seçiliyken adres alanı yalnız rakam (UID) kabul eder */
    $('#tfAddr').addEventListener('input', () => {
      if ((($('#tfDest') || {}).value || '4') !== '3') return;
      const el = $('#tfAddr');
      const v = String(el.value || '').replace(/\D+/g, '');
      if (v !== el.value) el.value = v;
    });
    $('#tfTrMax').addEventListener('click', () => {
      const dir = ($('#tfDir') || {}).value || '6>18';
      const from = dir.split('>')[0];
      const src = from === '6' ? ((tfState.info && tfState.info.funding) || [])[0] : ((tfState.info && tfState.info.trading) || [])[0];
      const av = src ? Number(src.avail) || 0 : 0;
      if ($('#tfTrAmt')) $('#tfTrAmt').value = av > 0 ? String(av) : '';
    });
    $('#tfWdMax').addEventListener('click', () => {
      const f = ((tfState.info && tfState.info.funding) || [])[0];
      const av = f ? Number(f.avail) || 0 : 0;
      const dest = ($('#tfDest') || {}).value || '4';
      const fee = dest === '3' ? 0 : (Number(($('#tfFee') || {}).value) || 0);
      const c = ((tfState.info && tfState.info.currencies) || []).find((x) => x.chain === (($('#tfChain') || {}).value || '')) || null;
      let max = av - fee;
      if (c && c.maxWd > 0) max = Math.min(max, c.maxWd);
      if (c && c.wdTickSz > 0 && max > 0) max = Math.floor(max / c.wdTickSz) * c.wdTickSz;
      if ($('#tfWdAmt')) $('#tfWdAmt').value = max > 0 ? String(Number(max.toFixed(8))) : '';
    });
    $('#tfTrGo').addEventListener('click', () => tfDoTransfer());
    $('#tfWdGo').addEventListener('click', () => tfDoWithdraw());
    $('#tfHist').addEventListener('click', () => tfLoadHistory());
    el.dataset.init = '1';
  }
  await tfLoadInfo();
  await tfLoadHistory();
}

/* ---------- borsa değiştir ---------- */
function updateExLabels() {
  const nm = exLabel();
  const lbl = $('#exBtnLabel');
  if (lbl) lbl.textContent = nm;
  const btn = $('#exBtn');
  if (btn) {
    const dm = exName !== 'mt5' && !!exDemoMode[exName];
    btn.classList.toggle('demo', dm);
    btn.title = dm
      ? 'YEREL DENEME hesabı aktif — emirler bu makinede simüle edilir · ' + nm
      : 'Borsa seç: MT5 / Binance / OKX — seçili borsaya entegre olur';
  }
  const clHead = $('#clHeadTitle');
  if (clHead) clHead.textContent = nm.toUpperCase() + ' LİSTESİ';
  $$('#exMenu .dd-item').forEach((b) => b.classList.toggle('active', b.dataset.ex === exName));
}

/* hangi borsalar kayıtlı: MT5 her zaman var; Binance/OKX'te aktif hesap türünün anahtarları girilmişse */
let exAvail = { mt5: true, binance: false, okx: false };

function exHasKeys(k, okx) {
  if (!k || !k.ok) return false;
  if (k.demo) return true;  /* yerel deneme hesabı: API anahtarı gerekmez */
  return !!(k.key && k.secret && (!okx || k.pass));
}

async function refreshExPicker() {
  const [b, o] = await Promise.all([
    jev.exKeysGet('binance').catch(() => null),
    jev.exKeysGet('okx').catch(() => null),
  ]);
  exDemoMode = { binance: !!(b && b.ok && b.demo), okx: !!(o && o.ok && o.demo) };
  exAvail = { mt5: true, binance: exHasKeys(b, false), okx: exHasKeys(o, true) };
  $$('#exMenu .dd-item').forEach((btn) => {
    btn.hidden = btn.dataset.ex !== 'mt5' && !exAvail[btn.dataset.ex];
  });
  /* seçili borsa artık kayıtlı değilse MT5'e dön */
  if (exName !== 'mt5' && !exAvail[exName]) {
    await applyExchangeSwitch('mt5');
  }
  updateExLabels();
}

/* borsa değişimi sırasında MT5 olayları (köprü kapanış uyarısı) yok sayılır */
let exSwitching = false;

async function applyExchangeSwitch(name) {
  if (!['mt5', 'binance', 'okx'].includes(name)) return;
  if (name !== 'mt5' && !exAvail[name]) {
    const base = name === 'binance' ? 'Binance' : 'OKX';
    toast(base + (exDemoMode[name] ? ' Deneme' : '') + ' anahtarları kayıtlı değil — Ayarlar > ' + base + ' API bölümünden kaydet');
    return;
  }
  if (name === exName) { updateExLabels(); return; }
  saveExModel(exName);  /* çıkılan borsanın sohbet LLM'i hatırlanır */
  exSwitching = true;
  try {
    await jev.exSet(name).catch(() => null);
  } finally {
    exSwitching = false;
  }
  /* mevcut grafiğin görünümünü kaydet (geri dönünce aynen açılsın) */
  saveViewState();
  exName = name;
  exSeq++;
  chartState.account = null;
  updateExLabels();
  await applyExModel(exName);  /* yeni borsanın kayıtlı sohbet LLM'i yüklenir */
  chartState.symLoaded = false;
  chartState.allSymbols = [];
  chartState.symInfo = {};
  chartState.rates = [];
  chartState.positions = [];
  chartState.orders = [];
  chartState.closed = [];
  chartState.tick = null;
  chartState.tickSpread = 0;
  /* pozisyon takibi sıfırlansın: borsa değişince eski pozisyonlar kapanmış sayılmasın */
  posWatchReady = false;
  posWatchMap = new Map();
  /* borsa bazlı sekmeler: yeni borsanın sekme seti yüklenir */
  loadTabs();
  renderChartTabs();
  const t = activeTab();
  if (t) {
    resetView();
    applyTabToChart(t);
    const list = tabSessions(activeTabId);
    activeSid = list.length ? list[list.length - 1].id : '';
    renderSessions();
    renderMsgs();
  }
  loadSymbolList();
  refreshPositions();
  refreshOrders();
  refreshClosed();
  updateAccount(null);
  if (pane2.on) {
    pane2.symbol = chartState.symbol;
    pane2.rates = [];
    pane2.viewCount = 0;
    pane2.follow = true;
    const inp2 = $('#chartSymbol2');
    if (inp2) inp2.value = chartState.symbol;
    loadRates2();
  }
  termLogAdd('Borsa değişti: ' + exLabel() + ' · ' + chartState.symbol, 'sys');
  toast(exLabel() + ' seçildi · ' + chartState.symbol);
}

/* ---------- ayarlar: log görüntüleyici ---------- */
async function renderLogsPane() {
  const el = $('#tab-logs');
  if (!el) return;
  if (!el.dataset.init) {
    el.innerHTML =
      '<h2>Loglar</h2>' +
      '<div class="sub" id="logPath">—</div>' +
      '<div style="display:flex;gap:8px;margin:10px 0 12px">' +
      '<button id="logRefresh" class="btn ghost">Yenile</button>' +
      '<button id="logOpenBtn" class="btn ghost">Dosyayı aç</button>' +
      '<button id="logClearBtn" class="btn ghost">Temizle</button>' +
      '</div>' +
      '<pre id="logPre" class="log-pre"></pre>';
    el.dataset.init = '1';
    $('#logRefresh').addEventListener('click', () => loadLogs());
    $('#logOpenBtn').addEventListener('click', () => jev.logOpen());
    $('#logClearBtn').addEventListener('click', async () => {
      await jev.logClear().catch(() => null);
      loadLogs();
    });
  }
  await loadLogs();
}

async function loadLogs() {
  const pre = $('#logPre');
  if (!pre) return;
  const r = await jev.logRead(500).catch(() => null);
  const lines = r && r.ok ? r.lines : [];
  pre.textContent = lines.length ? lines.join('\n') : '(log kaydı yok)';
  const p = $('#logPath');
  if (p && r && r.path) p.textContent = r.path;
  pre.scrollTop = pre.scrollHeight;
}

/* ---------- ayarlar: chat (sohbet LLM) ayarları ---------- */
/* zamansal analiz sıklığı: ondalık dakika (LLM piyasa temposuna göre değiştirebilir) */
const ANALYZE_MIN_FLOOR = 1;  /* en kısa aralık: 1 dk */
const ANALYZE_OPTIONS_HTML =
  '<option value="0">Kapalı</option>' +
  '<option value="1">her 1 dk</option>' +
  '<option value="2">her 2 dk</option>' +
  '<option value="5">her 5 dk</option>' +
  '<option value="10">her 10 dk</option>' +
  '<option value="15">her 15 dk</option>' +
  '<option value="30">her 30 dk</option>' +
  '<option value="60">her 60 dk</option>';

/* 0 = kapalı; 1 – 1440 dk aralığına oturt (2 ondalık) */
function normAnalyzeMin(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(ANALYZE_MIN_FLOOR, Math.min(1440, Math.round(n * 100) / 100));
}

function fmtAnalyzeMin(m) {
  const v = Number(m) || 0;
  if (!(v > 0)) return 'kapalı';
  if (v < 1) return Math.max(1, Math.round(v * 60)) + ' sn';
  return v + ' dk';
}

/* elle giriş: "2.5" / "2,5" dakika ("45sn" gibi saniye girişleri 1 dk'ya yuvarlanır) */
function parseAnalyzeInput(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(',', '.').toLowerCase();
  if (!s) return NaN;
  const n = Number(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return NaN;
  return /(sn|sec|s)$/.test(s) ? n / 60 : n;
}

/* select + özel alanı mevcut değere göre doldur (değer listede yoksa "özel" seçilir) */
function analyzeSelFill(sel, inp) {
  if (!sel) return;
  const cur = tabAnalyzeMin();
  const has = Array.from(sel.options).some((o) => Number(o.value) === cur);
  sel.value = has ? String(cur) : '-1';
  if (inp) inp.value = has ? '' : String(cur);
}

function analyzeSelRead(sel, inp) {
  const cust = parseAnalyzeInput(inp && inp.value);
  if (Number.isFinite(cust)) return normAnalyzeMin(cust);
  const v = Number(sel && sel.value);
  return Number.isFinite(v) && v > 0 ? normAnalyzeMin(v) : 0;
}

async function renderChatPane() {
  const el = $('#tab-chat');
  if (!el) return;
  state = await jev.getSettings().catch(() => state);
  const am = state && state.activeModel ? state.activeModel : null;
  const prov = am ? ((state.providers || []).find((p) => p.id === am.providerId) || null) : null;
  const modelTxt = am
    ? ((prov ? prov.name : am.providerId) + ' · ' + am.model)
    : 'seçili değil (Provider sekmesinden model seç)';
  if (!el.dataset.init) {
    el.innerHTML =
      '<h2>Chat Ayarları</h2>' +
      '<div class="sub">Sohbet LLM ayarları. Zamansal analiz, seçilen aralıkta sohbete otomatik istek gönderir: aktif model sağdaki grafiği ve açık pozisyonları analiz eder, gerekirse çizim/alarm komutlarını uygular, doğrudan gerçek emir açar ve SL/TP güncelleyebilir.</div>' +
      '<div class="color-row"><span>Aktif sohbet modeli</span><span id="chatModelTxt" class="range-val"></span></div>' +
      '<div class="color-row"><span>Zamansal analiz</span><span style="display:flex;gap:6px;align-items:center"><select id="chatAutoAnalyze">' +
      ANALYZE_OPTIONS_HTML +
      '<option value="-1">özel…</option>' +
      '</select><input id="chatAutoMin" class="inp" style="width:70px" inputmode="decimal" autocomplete="off" placeholder="özel" title="Elle dakika gir (örn. 2.5)" /></span></div>' +
      '<div class="range-val" style="text-align:left;margin:-4px 0 8px">Özel değer dakika olarak yazılır (2,5 = 2 dk 30 sn; 0,5 yazsan bile en kısa 1 dk uygulanır). LLM normalde 5–15 dk aralıkta çalışır; <<AUTO {"analyzeMin":N}>> ile yalnız gerçekten kritik anlarda (sert kırılım, haber, açık pozisyon riski) geçici olarak 1–2 dk\'ya inebilir, kritik an geçince en az 5 dk\'ya döner.</div>' +
      '<div class="color-row"><span>Her mesaja grafik görüntüsü ekle</span><input type="checkbox" id="chatShot" /></div>' +
      '<div class="color-row"><span>İşlem açılış/kapanışında LLM analiz etsin</span><input type="checkbox" id="chatTradeNotify" /></div>' +
      '<div style="display:flex;gap:8px;margin-top:12px;justify-content:center">' +
      '<button id="chatSave" class="btn">Kaydet</button>' +
      '<button id="chatSetOpen2" class="btn ghost">Sohbet ayarlarını aç…</button>' +
      '</div>' +
      '<div id="chatAnaInfo" class="sub" style="text-align:left;margin-top:10px;white-space:pre-wrap"></div>' +
      '<div id="chatMsg" class="sub" style="margin-top:10px;text-align:center"></div>';
    el.dataset.init = '1';
    $('#chatSetOpen2').addEventListener('click', () => openChatSet());
    $('#chatSave').addEventListener('click', () => {
      const av = analyzeSelRead($('#chatAutoAnalyze'), $('#chatAutoMin'));
      const shot = !!$('#chatShot').checked;
      const tradeN = !!$('#chatTradeNotify').checked;
      try {
        localStorage.setItem('jev.attachShot', shot ? '1' : '0');
        localStorage.setItem('jev.autoTradeNotify', tradeN ? '1' : '0');
      } catch {}
      setTabAnalyzeMin(av);
      if (typeof applyShotBtn === 'function') applyShotBtn();
      applyJevTimers();
      $('#chatMsg').textContent = 'Kaydedildi · zamansal analiz ' + fmtAnalyzeMin(av) + ' · grafik görüntüsü ' + (shot ? 'açık' : 'kapalı') + ' · işlem analizi ' + (tradeN ? 'açık' : 'kapalı');
      toast('Chat ayarları kaydedildi');
      jevLogAdd('AYAR · chat · zamansal analiz ' + fmtAnalyzeMin(av) + ' · grafik görüntüsü ' + (shot ? 'açık' : 'kapalı') + ' · işlem analizi ' + (tradeN ? 'açık' : 'kapalı'), 'info');
    });
  }
  const mEl = $('#chatModelTxt');
  if (mEl) mEl.textContent = modelTxt;
  analyzeSelFill($('#chatAutoAnalyze'), $('#chatAutoMin'));
  const sEl = $('#chatShot');
  if (sEl) sEl.checked = attachShotOn();
  const tnEl = $('#chatTradeNotify');
  if (tnEl) tnEl.checked = jevTradeAutoOn();
  await renderChatAnaInfo();
}

/* bu panelde zaman dilimi/koruma/hafıza özetini göster: ayar iki yerde de
   değişebildiği için tek doğruluk kaynağı hangisi olduğu görünmeli */
async function renderChatAnaInfo() {
  const el = $('#chatAnaInfo');
  if (!el) return;
  const cfg = tabAnaTf();
  const r = await resolveAnaTfs().catch(() => null);
  const pg = posGuardCfg();
  const dg = dayGuardCfg();
  const dgs = await dayGuardState().catch(() => null);
  let t = 'ANALİZ ZAMAN DİLİMİ: ' + (cfg.mode === 'auto' ? 'otomatik' : 'elle seçili') +
    ' → ' + (r ? r.htf + '→' + r.etf : cfg.htf + '→' + cfg.etf) +
    (r && r.why ? ' · ' + r.why : '') + '\n';
  t += 'POZİSYON KORUMA: ' + (pg.on
    ? (pg.allowLossClose ? 'zararda kapatma ' + pg.lossCloseR + 'R üzeri açık' : 'zararda kapatma YASAK') +
      ' · SL en yakın ' + pg.minTrailR + 'R · kısmi kâr alma ' + pg.minProfitR + 'R'
    : 'kapalı (yalnız isteme bağlı)') + '\n';
  t += 'GÜNLÜK KORUMA: ' + (dg.on
    ? (dgs && dgs.blocked ? 'DURDURULDU · ' + dgs.reason : 'aktif · -' + dg.maxLossR + 'R / -%' + dg.maxLossPct + ' / ' + dg.maxConsecLoss + ' kayıp')
    : 'kapalı');
  el.textContent = t;
}

/* ---------- otomatik yükseklik ---------- */
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}

/* ---------- tema ---------- */
function applyTheme() {
  document.body.classList.toggle('dark', theme === 'dark');
  localStorage.setItem('jev.theme', theme);
  if (typeof drawChart === 'function') drawChart();
}

/* ---------- zaman dilimi kayıt defteri (TEK doğruluk kaynağı) ----------
   Saniye, sıra (küçükten büyüğe), borsa karşılığı ve bağlam mum sayısı bir
   yerde durur; TF butonları, analiz bağlamı, geri sayım, eksen etiketleri ve
   otomatik seçim hep buradan beslenir. Böylece "hangi TF nerede geçerli"
   sorusu ortadan kalkar. */
const TF_DEFS = {
  M1:  { sec: 60,     rank: 1, binance: '1m',  okx: '1m',  bars: 40,  label: '1 dakika' },
  M5:  { sec: 300,    rank: 2, binance: '5m',  okx: '5m',  bars: 60,  label: '5 dakika' },
  M15: { sec: 900,    rank: 3, binance: '15m', okx: '15m', bars: 80,  label: '15 dakika' },
  M30: { sec: 1800,   rank: 4, binance: '30m', okx: '30m', bars: 60,  label: '30 dakika' },
  H1:  { sec: 3600,   rank: 5, binance: '1h',  okx: '1H',  bars: 90,  label: '1 saat' },
  H4:  { sec: 14400,  rank: 6, binance: '4h',  okx: '4H',  bars: 60,  label: '4 saat' },
  D1:  { sec: 86400,  rank: 7, binance: '1d',  okx: '1D',  bars: 60,  label: 'Günlük' },
  W1:  { sec: 604800, rank: 8, binance: '1w',  okx: '1W',  bars: 40,  label: 'Haftalık' },
};
const TFS = Object.keys(TF_DEFS);
/* TF_RANKED: küçükten büyüğe (M1 → W1) — üst/alt TF gezinmeği bunu kullanır */
const TF_RANKED = TFS.slice().sort((a, b) => TF_DEFS[a].rank - TF_DEFS[b].rank);
const TF_RANK = {};
const TF_SECONDS = {};
for (const tf of TFS) {
  TF_RANK[tf] = TF_DEFS[tf].rank;
  TF_SECONDS[tf] = TF_DEFS[tf].sec;
}

function tfIsValid(v) {
  return !!TF_DEFS[String(v == null ? '' : v).trim().toUpperCase()];
}

/* geçersiz/boş TF için varsayılana düşürür */
function tfNorm(v, def) {
  const s = String(v == null ? '' : v).trim().toUpperCase();
  if (TF_DEFS[s]) return s;
  return (def && TF_DEFS[def]) ? def : 'M15';
}

function tfByRank(r) {
  const i = Math.max(0, Math.min(TF_RANKED.length - 1, Math.round(Number(r) || 1) - 1));
  return TF_RANKED[i];
}

/* bir TF'in bir üstü (daha büyük) / bir altı (daha küçük) — sınırlarda en yakını verir */
function tfHigher(tf) { return tfByRank(TF_RANK[tfNorm(tf)] + 1); }
function tfLower(tf) { return tfByRank(TF_RANK[tfNorm(tf)] - 1); }
function tfLabel(tf) { return TF_DEFS[tfNorm(tf)].label; }
function tfSec(tf) { return TF_SECONDS[tfNorm(tf)]; }
function tfIsHigher(a, b) { return TF_RANK[tfNorm(a)] > TF_RANK[tfNorm(b)]; }

/* ---------- analiz zaman dilimi: elle seçim ya da otomatik seçim ----------
   Mod "auto": uygulama piyasa rejimini ölçüp (üst TF, giriş TF) çiftini kendi
   seçer. Mod "fixed": kullanıcı Sohbet Ayarları'ndan seçtiği çift kullanılır.
   Her iki modda da çizimler, alarmlar ve analiz bu TF'lerde yapılır. Grafik TF'i
   OTOMATİK DEĞİŞTİRİLMEZ; Jev diğer TF'leri arka plan görüntüleri + LOOK ile görür. */
const TF_MODE_KEY = 'jev.anaTfMode';
const TF_HTF_KEY = 'jev.anaTfHtf';
const TF_ETF_KEY = 'jev.anaTfEtf';
const TF_SYNC_KEY = 'jev.anaTfSync';
const TF_DUAL_KEY = 'jev.anaTfDual';

/* çifti geçerli hale getir: giriş TF üst TF'ten küçük olmalı */
function anaTfPair(mode, htf, etf) {
  const h = tfNorm(htf, 'H1');
  let e = tfNorm(etf, 'M5');
  if (TF_RANK[e] >= TF_RANK[h]) e = tfLower(h);
  return { mode: mode === 'fixed' ? 'fixed' : 'auto', htf: h, etf: e };
}

function anaTfDefaults() {
  const p = anaTfPair(
    localStorage.getItem(TF_MODE_KEY) === 'fixed' ? 'fixed' : 'auto',
    localStorage.getItem(TF_HTF_KEY),
    localStorage.getItem(TF_ETF_KEY)
  );
  return {
    mode: p.mode,
    htf: p.htf,
    etf: p.etf,
    /* grafik TF'ini analiz giriş TF'ine geçirme KALDIRILDI: grafik TF'i HER ZAMAN
       kullanıcının bıraktığı yerde kalır (otomatik değişmez) */
    sync: false,
    dual: localStorage.getItem(TF_DUAL_KEY) === '1',
  };
}

function saveAnaTfDefaults(v) {
  const p = anaTfPair(v && v.mode, v && v.htf, v && v.etf);
  const out = {
    mode: p.mode,
    htf: p.htf,
    etf: p.etf,
    sync: false,
    dual: !!(v && v.dual === true),
  };
  try {
    localStorage.setItem(TF_MODE_KEY, out.mode);
    localStorage.setItem(TF_HTF_KEY, out.htf);
    localStorage.setItem(TF_ETF_KEY, out.etf);
    localStorage.setItem(TF_SYNC_KEY, '0');
    localStorage.setItem(TF_DUAL_KEY, out.dual ? '1' : '0');
  } catch {}
  return out;
}

/* sekmeye özel analiz TF'si; kayıt yoksa global varsayılan */
function tabAnaTf(tab) {
  const t = tab || activeTab();
  const d = anaTfDefaults();
  const src = t && t.anaTf && typeof t.anaTf === 'object' ? t.anaTf : null;
  if (!src) return d;
  const p = anaTfPair(src.mode, src.htf, src.etf);
  return { mode: p.mode, htf: p.htf, etf: p.etf, sync: false, dual: src.dual === true };
}

function setTabAnaTf(v) {
  const t = activeTab();
  if (!t) return anaTfDefaults();
  const p = anaTfPair(v && v.mode, v && v.htf, v && v.etf);
  t.anaTf = { mode: p.mode, htf: p.htf, etf: p.etf, sync: false, dual: !!(v && v.dual === true) };
  saveTabs();
  return tabAnaTf(t);
}

/* --- piyasa rejimi ölçümü: deterministik, LLM tahmini değil --- */
function atrOf(rates, len, end) {
  const n = (rates || []).length;
  if (n < 3) return 0;
  const last = end == null ? n : Math.min(n, Math.max(3, Math.round(Number(end))));
  const k = Math.max(2, Math.min(len || 14, last - 1));
  let sum = 0;
  for (let i = last - k; i < last; i++) {
    const r = rates[i];
    const pc = Number(rates[i - 1].close) || Number(r.close);
    sum += Math.max(
      Math.abs(Number(r.high) - Number(r.low)),
      Math.abs(Number(r.high) - pc),
      Math.abs(Number(r.low) - pc)
    );
  }
  return sum / k;
}

function emaOf(rates, len) {
  const n = (rates || []).length;
  if (!n) return 0;
  const k = Math.max(1, Math.min(len || 20, n));
  const a = 2 / (k + 1);
  let e = Number(rates[0].close) || 0;
  for (let i = 1; i < n; i++) e = (Number(rates[i].close) || e) * a + e * (1 - a);
  return e;
}

function medOf(arr) {
  const a = (arr || []).filter((v) => Number.isFinite(v) && v > 0).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function tfRegime(rates) {
  const n = (rates || []).length;
  if (n < 60) return null;
  const atr = atrOf(rates, 14);
  const last = Number(rates[n - 1].close) || 0;
  if (!(atr > 0) || !(last > 0)) return null;
  const hist = [];
  for (let i = n - 90; i < n - 14; i += 5) {
    const a = atrOf(rates, 14, i);
    if (a > 0) hist.push(a);
  }
  const med = medOf(hist) || atr;
  const e20 = emaOf(rates, 20);
  const e20prev = emaOf(rates.slice(0, n - 8), 20);
  const e50 = emaOf(rates, 50);
  const trend = (last - e20) / atr;
  return {
    atr,
    atrPct: atr / last,
    volMult: atr / med,
    trend,
    strength: Math.abs(trend),
    slope: (e20 - e20prev) / atr,
    spread: Math.abs(e20 - e50) / atr,
    last,
    n,
  };
}

/* (üst TF, giriş TF) seçimi — SWING tarzı: yön/yapı daima H4-D1, giriş en fazla H1.
   Küçük TF'ler (M15 ve altı) swing kararında kullanılmaz; günler süren hareket
   hedeflenir, gürültüde stop olmayı önleyen geniş yapı aranır. */
function autoPickTfs(reg) {
  if (!reg) return { htf: 'H4', etf: 'H1', why: 'fiyat verisi yetersiz — güvenli swing varsayılanı H4→H1' };
  const v = reg.volMult;
  const s = reg.strength;
  if (v >= 1.5) {
    return { htf: 'D1', etf: 'H4', why: 'yüksek volatilite ' + v.toFixed(2) + '× → D1 yön, H4 giriş (swing)' };
  }
  if (v <= 0.75 && s >= 0.8) {
    return { htf: 'H4', etf: 'H1', why: 'sakin ' + v.toFixed(2) + '× ama trend var → H4 yön, H1 giriş (swing)' };
  }
  if (v <= 0.75) {
    return { htf: 'H4', etf: 'H1', why: 'sakin ve yatay ' + v.toFixed(2) + '× → H4 yön, H1 giriş (swing)' };
  }
  if (s >= 0.8) {
    return { htf: 'H4', etf: 'H1', why: 'normal volatilite ' + v.toFixed(2) + '× + belirgin trend ' + s.toFixed(2) + ' → H4 yön, H1 giriş (swing)' };
  }
  return { htf: 'H4', etf: 'H1', why: 'normal volatilite + yatay piyasa → H4 yön, H1 giriş (swing)' };
}

let anaTfCache = { at: 0, val: null };
let syncingTf = false;
let anaTfTimer = null;
const ANA_TF_SYNC_MS = 90 * 1000;
let anaTfCandKey = '';
let anaTfCandN = 0;

/* histerezis: otomatik seçim iki ölçüm üst üste aynı sonucu vermeden TF
   değiştirilmez; aksi halde grafik her 90 saniyede salınırdı */
function autoPickStable(htf, etf) {
  const key = htf + '→' + etf;
  if (key === anaTfCandKey) anaTfCandN++;
  else { anaTfCandKey = key; anaTfCandN = 1; }
  /* aday zaten aktif TF ise beklemeden kabul (gereksiz geçiş yok) */
  return anaTfCandN >= 2 || etf === tfNorm(chartState.tf);
}

/* analiz için kullanılacak TF çiftini çözer (otomatik modda 60 sn önbellek) */
async function resolveAnaTfs(force) {
  const cfg = tabAnaTf();
  if (cfg.mode === 'fixed') return { mode: 'fixed', htf: cfg.htf, etf: cfg.etf, sync: cfg.sync, dual: cfg.dual, why: 'senin seçimin', resolved: true, stable: true };
  if (!force && anaTfCache.val && Date.now() - anaTfCache.at < 60000) return anaTfCache.val;
  let reg = null;
  try { reg = tfRegime(await ctxRates(chartState.symbol, 'H1', 200)); } catch {}
  if (!reg) reg = tfRegime(chartState.rates);
  const pick = autoPickTfs(reg);
  const pair = anaTfPair('auto', pick.htf, pick.etf);
  const val = {
    mode: 'auto', htf: pair.htf, etf: pair.etf, sync: cfg.sync, dual: cfg.dual,
    why: pick.why, resolved: true, stable: autoPickStable(pair.htf, pair.etf),
  };
  anaTfCache = { at: Date.now(), val };
  return val;
}

/* seçilen TF çiftine göre top-down kuralı — sabit "D1→H1→M15" yerine
   gerçekten analiz yapılacak çift yazılır */
function anaTfPromptBlock(r) {
  if (!r || !r.htf || !r.etf) return '';
  const h = r.htf;
  const e = r.etf;
  const mode = r.mode === 'auto' ? 'OTOMATİK (uygulama rejimi ölçüp seçti)' : 'ELLE SEÇİLMİŞ';
  const why = r.why ? ' Gerekçe: ' + r.why + '.' : '';
  return '\n\n[ANALİZ ZAMAN DİLİMİ] ' + mode + ' → ' + h + ' → ' + e + why +
    '\nSADECE bu iki TF üzerinden karar ver; mum serileri yalnız bu ikisinden gelir.' +
    '\nGRAFİK TF\'İNİ DEĞİŞTİRME: kullanıcı hangi TF\'de bakıyorsa orada kalır (aktif TF farklı olabilir).' +
    '\nAktif grafik + arka plan TF görüntüleri etiketli eklenir; görsel inceleme için <<LOOK>> kullan.' +
    '\n· ' + h + ' (üst TF) = ana yön/trend + kilit seviyeler. Yapı kırıldı mı, trend bitti mi?' +
    '\n· ' + e + ' (giriş TF\'i) = giriş zamanlaması/tetik: retest, kırılım teyidi, order block/breaker/FVG.' +
    '\nÇizimleri (<<DRAW>>), alarmları ve planları da ' + e + ' mum ölçeğinde kur; seviyeleri ' + h + ' ile uyumlu seç.' +
    '\nYanıtının başında iki TF\'in yönünü yaz ("' + h + ' ↑ · ' + e + ' →"). İkisini de değerlendirmeden emir/karar verme.';
}

/* ikinci pane (isteğe bağlı) analiz üst TF'ine uydurulur.
   ANA GRAFİK TF'İ OTOMATİK DEĞİŞTİRİLMEZ: kullanıcı hangi TF'de bakıyorsa orada kalır;
   Jev diğer TF'leri arka plan çoklu TF görüntüleri ve <<LOOK>> ile görür. */
async function applyAnaTfSync(force) {
  if (syncingTf) return;
  const r = await resolveAnaTfs(force).catch(() => null);
  if (!r) return;
  /* otomatik seçim henüz kararlı değilse pane2'yi de değiştirme (sallanmayı önler) */
  const canSwitch = r.mode === 'fixed' || r.stable !== false;
  const before = chartState.tf + '/' + (pane2.on ? pane2.tf : '-');
  if (r.dual && canSwitch && pane2.on && pane2.tf !== r.htf) {
    syncingTf = true;
    try {
      pane2.tf = r.htf;
      localStorage.setItem('jev.pane2.tf', r.htf);
      buildTfRow2();
      await loadRates2();
    } catch {} finally { syncingTf = false; }
  } else if (r.dual && !pane2.on) {
    jevLogAdd('ZAMAN DİLİMİ · ikili grafik isteniyor ama ikili mod kapalı — Ayarlar\'dan aç', 'info');
  }
  const after = chartState.tf + '/' + (pane2.on ? pane2.tf : '-');
  if (before !== after) {
    ctxCache.clear();
    jevLogAdd('ZAMAN DİLİMİ · ' + r.htf + '→' + r.etf + ' · ' + r.why, 'info');
  }
  return r;
}

/* ---------- pozisyon risk durumu: tek noktadan R / gerçek başabaş ---------- */
function posRisk(p, realized) {
  const entry = Number(p && p.price_open) || 0;
  const cur = Number(p && p.price_current) || 0;
  const sl = Number(p && p.sl) || 0;
  const dir = Number(p && p.type) === 1 ? -1 : 1;
  const rd = sl > 0 && entry > 0 ? Math.abs(entry - sl) : 0;
  let be = null;
  try { be = bePriceFor(p, realized == null ? realizedForPosition(p.ticket, p.symbol, p.time) : realized); } catch {}
  const rNow = (entry > 0 && cur > 0 && rd > 0) ? ((cur - entry) * dir) / rd : null;
  const beR = (entry > 0 && be != null && rd > 0) ? ((be - entry) * dir) / rd : null;
  const profit = posProfit(p || {});
  return {
    entry, cur, sl, dir, rd, be, rNow, beR, profit,
    hasSl: sl > 0,
    inProfit: rNow != null ? rNow > 0 : profit > 0,
    rTxt: rNow == null ? (profit > 0 ? 'kârda' : 'zararda') : (rNow >= 0 ? '+' : '') + rNow.toFixed(2) + 'R',
  };
}

/* ---------- POZİSYON YÖNETİMİ KORUMA KATMANI ----------
   Prompt'taki "zararda panik yok" kuralı tek başına yetmez: model kuralı
   ihlal edip <<CLOSE>>/<<SLTP>> gönderdiğinde uygulama da DURDURMALIDIR.
   Böylece kural "isteme bağlı" değil, kodla zorlanan bir kural olur. */
const POS_GUARD_KEY = 'jev.posGuard';

function posGuardCfg() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem(POS_GUARD_KEY) || '{}') || {}; } catch {}
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    on: o.on !== false,
    /* kuruluşu bozduğunu gerekçelendiren AI kapatmaya izin verilsin mi */
    allowLossClose: o.allowLossClose === true,
    /* bu kayıptan sonrası "tanımlı sınır aşıldı" sayılır; altında otomatik kapanmaz */
    lossCloseR: n(o.lossCloseR, 1),
    /* SL'yi fiyata bu kadar yaklaştırma (düşükse stop olmayı garanti eder) — SWING: 0.5R */
    minTrailR: n(o.minTrailR, 0.5),
    /* kısmi kâr almak için asgari kâr (R) — SWING: 1R'den önce dokunulmaz */
    minProfitR: n(o.minProfitR, 1),
  };
}

function savePosGuardCfg(v) {
  const cur = posGuardCfg();
  const n = (k, d) => (Number.isFinite(Number(v && v[k])) && Number(v[k]) >= 0 ? Number(v[k]) : d);
  const out = {
    on: !(v && v.on === false),
    allowLossClose: !!(v && v.allowLossClose === true),
    lossCloseR: n('lossCloseR', cur.lossCloseR),
    minTrailR: n('minTrailR', cur.minTrailR),
    minProfitR: n('minProfitR', cur.minProfitR),
  };
  try { localStorage.setItem(POS_GUARD_KEY, JSON.stringify(out)); } catch {}
  return out;
}

/* karar denetimi: {ok:true} ya da {ok:false, why} */
function posGuardVerdict(kind, p, opt) {
  const o = opt && typeof opt === 'object' ? opt : {};
  const g = posGuardCfg();
  if (!g.on || o.bypass === true) return { ok: true };
  const src = o.src || 'ai';
  const byUser = src === 'user' || src === 'ui';
  const r = posRisk(p);

  /* zararda kısmi kapatma: yalnız kârda yapılır */
  if (kind === 'CLOSE_PARTIAL') {
    if (r.inProfit) return { ok: true, r };
    return { ok: false, r, why: 'zararda kısmi kapatma yasak (şu an ' + r.rTxt + ') — kısmi kapatma YALNIZ kâr almak içindir' };
  }

  /* zararda tam kapatma: yalnız kuruluş bozuldu gerekçesiyle (veya kullanıcı elle) */
  if (kind === 'CLOSE_FULL') {
    if (r.inProfit) return { ok: true, r };
    if (byUser) return { ok: true, r };
    if (o.invalidated === true) return { ok: true, r };
    if (!g.allowLossClose) {
      return { ok: false, r, why: 'zararda tam kapatma için kuruluşun GEÇERSİZLEŞTİĞİNİ gerekçelendirmen gerekir (şu an ' + r.rTxt + '). Tez geçerliyse SL zaten kaybı kesiyor — bekle' };
    }
    if (r.rNow != null && -r.rNow <= g.lossCloseR) {
      return { ok: false, r, why: 'zarar ' + r.rTxt + ' tanımlı sınırın içinde — SL zaten bu kaybı kesiyor, erken kapatmak paniktir' };
    }
    return { ok: true, r };
  }

  /* SL/TP güncellemesi: risk yalnız AZALTILABİLİR */
  if (kind === 'SLTP') {
    const newSl = Number(o.sl) || 0;
    const newTp = Number(o.tp) || 0;
    if (!(newSl > 0)) return { ok: true, r };
    if (!(r.sl > 0)) return { ok: true, r };   /* SL yoktu: eklemek riski tanımlar */
    const reduces = r.dir === 1 ? newSl > r.sl : newSl < r.sl;
    if (!reduces) {
      return { ok: false, r, why: 'SL ' + (r.inProfit ? 'kâr yönünden geriye' : 'daha da uzağa') + ' alınırsa risk BÜYÜR — riski büyüten SL değişikliği yasak (mevcut ' + r.sl + ' → istenen ' + newSl + ')' };
    }
    if (!r.inProfit && r.rd > 0) {
      const distR = Math.abs(newSl - r.cur) / r.rd;
      if (distR < g.minTrailR) {
        return { ok: false, r, why: 'zararda SL fiyata ' + distR.toFixed(2) + 'R yaklaştırılamaz (asgari ' + g.minTrailR + 'R) — normal dalgalanmada stop olmayı garanti eder' };
      }
    }
    return { ok: true, r };
  }

  /* BE daima risk azaltır; uygulama kendi kâr kontrolünü yapar */
  if (kind === 'BE') return { ok: true, r };
  return { ok: true, r };
}

/* koruma kurallarını modele duyur: böylece "kural yok" diye işlem atlamaz,
   ret gerekçesini de neden yapmadığını anlar */
function posGuardPromptBlock() {
  const g = posGuardCfg();
  if (!g.on) return '';
  return '\n\n[POZİSYON KORUMA — KOD ZORUNLU] Bu kurallar İSTEĞİN DEĞİL UYGULAMA TARAFINDAN KOD İLE ZORLANIR; ' +
    'ihlal edersen komutun sessizce reddedilir:\n' +
    '· Zararda KISMİ KAPATMA reddedilir (kısmi kapatma yalnız kâr almak içindir). ' +
    'Zararda yapman gereken tek şey BEKLEMEK; SL zaten kaybı kesiyor.\n' +
    '· Zararda TAM KAPATMA ' + (g.allowLossClose
      ? ('yalnız -' + g.lossCloseR + 'R\'yi aşan zararda ve kuruluş çöktüyse mümkün; gerekçe için {"invalidated":true} yaz.')
      : 'reddedilir; SL devretsin. Kuruluşun çöktüğünü düşünüyorsan gerekçeni tek cümleyle yaz, uygulama yine de reddedebilir.') +
    '\n· Riski BÜYÜTEN her SL değişikliği reddedilir: SL\'yi geri çekme/uzaklaştırma ve kârdayken gevşetme yasak.\n' +
    '· Zararda SL\'yi fiyata ' + g.minTrailR + 'R\'den yaklaştırmak reddedilir (stop olmayı garanti ederdi).\n' +
    '· Reddedileceğini bildiğin karar için komut GÖNDERME; kârda kademeli kâr al ve trailing ile koru.';
}

/* korumanın reddettiği karar: sebebi kaydet + kullanıcıya göster */
function posGuardBlock(kind, p, why, opt) {
  const o = opt && typeof opt === 'object' ? opt : {};
  const sym = String((p && p.symbol) || chartState.symbol || '');
  const tag = (kind === 'CLOSE_PARTIAL' ? 'KISMİ KAPATMA' : kind === 'CLOSE_FULL' ? 'KAPATMA' : 'SL/TP') + ' REDDEDİLDİ';
  jevLogAdd(tag + ' · ' + sym + (p && p.ticket ? ' #' + p.ticket : '') + ' · ' + why, 'err');
  termLogAdd('KORUMA · ' + tag + ' · ' + sym + ' #' + (p && p.ticket || '?') + ' · ' + why, 'close');
  journalAction({ kind: kind === 'CLOSE_PARTIAL' ? 'partial' : (kind === 'CLOSE_FULL' ? 'close' : 'sltp'), src: o.src || 'ai', sym, ticket: p && p.ticket, tf: chartState.tf, rAt: o.rAt, blocked: true, why });
  toast('Koruma: ' + why);
  pushToast(tag, sym + (p && p.ticket ? ' #' + p.ticket : '') + ' · ' + why, 'trade-close');
  return false;
}

/* ---------- İŞLEM TARZI: swing varsayılan, scalp isteğe bağlı ---------- */
const SCALP_KEY = 'jev.scalp';

function scalpMode() {
  try {
    const v = String(localStorage.getItem(SCALP_KEY) || 'some');
    return ['off', 'some', 'on'].includes(v) ? v : 'some';
  } catch { return 'some'; }
}

function scalpAllowed() {
  return scalpMode() !== 'off';
}

/* emir "scalp":true / "scalping":true ile işaretlenirse scalp kuralları uygulanır */
function isScalpOrder(d) {
  if (!d || typeof d !== 'object') return false;
  const v = d.scalp != null ? d.scalp : d.scalping;
  return v === true || Number(v) === 1 || /^(1|true|evet|açık|acik)$/i.test(String(v == null ? '' : v).trim());
}

/* ajanın işlem tarzı ayarını görmesi için dinamik blok */
function scalpPromptBlock() {
  const m = scalpMode();
  if (m === 'off') {
    return '\n\n[İŞLEM TARZI] SWING (scalp KAPALI): Yalnız swing işlemleri. Dar stoplu scalp yasak; "scalp":true işareti yok sayılır; uygulama SL/TP seviyelerini değiştirmez.';
  }
  if (m === 'some') {
    return '\n\n[İŞLEM TARZI] SWING + ARA SIRA SCALP: Varsayılan swing; ancak fırsat gerçekten netse ara sıra scalp yapabilirsin. ' +
      'Scalp kuralları: emri "scalp":true ile işaretle · günde en fazla 1-2 scalp · risk en fazla %0,5 (uygulama üst sınırı zorlar) · SL ~0,35×ATR14(H4) · TP 0,8–1,5R ve hızlı kapat. ' +
      'A/A+ swing fırsatı varsa scalp değil onu tercih et; scalp swing setup\'ını gölgelemesin.';
  }
  return '\n\n[İŞLEM TARZI] SWING + SCALP SERBEST: Fırsat buldukça scalp serbest. ' +
    'Scalp emirlerini "scalp":true ile işaretle · risk en fazla %0,5 (uygulama zorlar) · SL ~0,35×ATR14(H4) · TP 0,8–1,5R. ' +
    'Ana tarz yine swing\'dir: scalpler günlük toplam riski ve işlem sayısını şişirmesin.';
}

/* ---------- GÜNLÜK KORUMA: günlük zarar limiti + seri kayıp soğuması ---------- */
const DAY_GUARD_KEY = 'jev.dayGuard';

function dayGuardCfg() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem(DAY_GUARD_KEY) || '{}') || {}; } catch {}
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    on: o.on !== false,
    maxLossR: n(o.maxLossR, 3),        /* günde toplam -maxLossR aşılırsa dur */
    maxLossPct: n(o.maxLossPct, 6),    /* günlük zarar bakiye %'si */
    maxConsecLoss: n(o.maxConsecLoss, 4),
    cooldownMin: n(o.cooldownMin, 30),
  };
}

function saveDayGuardCfg(v) {
  const cur = dayGuardCfg();
  const n = (k, d) => (Number.isFinite(Number(v && v[k])) && Number(v[k]) >= 0 ? Number(v[k]) : d);
  const out = {
    on: !(v && v.on === false),
    maxLossR: n('maxLossR', cur.maxLossR),
    maxLossPct: n('maxLossPct', cur.maxLossPct),
    maxConsecLoss: n('maxConsecLoss', cur.maxConsecLoss),
    cooldownMin: n('cooldownMin', cur.cooldownMin),
  };
  try { localStorage.setItem(DAY_GUARD_KEY, JSON.stringify(out)); } catch {}
  return out;
}

let dayGuardCache = { at: 0, val: null };

/* günlük koruma durumu: kalıcı hafıza + bugünün açık pozisyonlarından hesaplanır */
async function dayGuardState(force) {
  const g = dayGuardCfg();
  const out = { on: g.on, cfg: g, blocked: false, reason: '', todayR: 0, todayNet: 0, consec: 0, n: 0 };
  if (!g.on) return out;
  if (!force && dayGuardCache.val && Date.now() - dayGuardCache.at < 20000) return dayGuardCache.val;
  const j = await jev.journalGet({ days: 30 }).catch(() => null);
  const s = j && j.ok ? j : null;
  if (s) {
    /* journal'daki R toplamı (sumR) doğrudan günlük R bütçesidir */
    out.todayR = (s.today && s.today.sumR != null) ? s.today.sumR : 0;
    out.todayNet = (s.today && s.today.sumNet != null) ? s.today.sumNet : 0;
    out.n = (s.today && s.today.n) || 0;
    out.consec = (s.streaks && s.streaks.currentLoss) || 0;
  }
  /* açık pozisyonların gerçekleşmemiş zararı da günlük sınıra dahildir */
  let unreal = 0;
  for (const p of chartState.positions || []) unreal += posProfit(p);
  const acc = chartState.account;
  const bal = Number(acc && acc.balance) || 0;
  const dayStartBal = bal - out.todayNet;
  const totalPct = dayStartBal > 0 ? (-(out.todayNet + unreal) / dayStartBal) * 100 : 0;

  if (g.maxLossR > 0 && out.todayR <= -g.maxLossR) {
    out.blocked = true;
    out.reason = 'günlük zarar limiti: ' + out.todayR.toFixed(2) + 'R (sınır -' + g.maxLossR + 'R)';
  } else if (g.maxLossPct > 0 && totalPct >= g.maxLossPct) {
    out.blocked = true;
    out.reason = 'günlük zarar %' + totalPct.toFixed(1) + ' (sınır %' + g.maxLossPct + ')';
  } else if (g.maxConsecLoss > 0 && out.consec >= g.maxConsecLoss) {
    out.blocked = true;
    out.reason = 'üst üste ' + out.consec + ' kayıp (sınır ' + g.maxConsecLoss + ')';
  }
  dayGuardCache = { at: Date.now(), val: out };
  return out;
}

/* günlük koruma yeni emirleri engelliyor mu? (pozisyon yönetimi serbest kalır) */
async function dayGuardBlocksNewOrders() {
  const s = await dayGuardState().catch(() => null);
  if (!s || !s.blocked) return null;
  return s.reason + ' — yeni işlem açma, önce koruma moduna geç (bekle/risk düşür)';
}

function dayGuardPromptBlock(s) {
  if (!s || !s.on) return '';
  const g = s.cfg || dayGuardCfg();
  let t = '\n\n[GÜNLÜK KORUMA] ';
  t += s.blocked
    ? 'DURDURULDU: ' + s.reason + '. Bu durumda YENİ EMİR GÖNDERME ("işlem yok" de). Açık pozisyonların SL/TP yönetimi, BE ve TRAIL serbesttir.'
    : 'aktif · bugün ' + (s.n || 0) + ' işlem, net ' + (s.todayNet >= 0 ? '+' : '') + Number(s.todayNet || 0).toFixed(2) +
      ', ' + Number(s.todayR || 0).toFixed(2) + 'R · sınırlar: günlük zarar -' + g.maxLossR + 'R veya -%' + g.maxLossPct +
      ', üst üste ' + g.maxConsecLoss + ' kayıp. Sınıra yaklaşırsan emri azalt ya da hiç açma.';
  return t;
}

/* ---------- işlem meta + kalıcı hafıza senkronu ---------- */
const TRADE_META_KEY = 'jev.tradeMeta';
const JOURNAL_SEEN_KEY = 'jev.journalSeen';
const EXIT_HINT_KEY = 'jev.exitHints';

function loadObj(key) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function saveObj(key, o) {
  try { localStorage.setItem(key, JSON.stringify(o)); } catch {}
}

function tradeMetaKeyOf(ticket, symbol) {
  return ticket ? String(ticket) : String(symbol || '').toUpperCase();
}

/* emir açıldığında TF/not/p/RR saklanır; kapanışta kalıcı hafızaya yazılır */
function setTradeMeta(p, meta) {
  const o = loadObj(TRADE_META_KEY);
  o[tradeMetaKeyOf(p && p.ticket, p && p.symbol)] = Object.assign({ at: Date.now() }, meta);
  const cutoff = Date.now() - 3 * 86400000;
  for (const k of Object.keys(o)) if (!(Number(o[k] && o[k].at) > cutoff)) delete o[k];
  saveObj(TRADE_META_KEY, o);
}

function takeTradeMeta(ticket, symbol) {
  const o = loadObj(TRADE_META_KEY);
  const k = tradeMetaKeyOf(ticket, symbol);
  const rec = o[k];
  if (rec) { delete o[k]; saveObj(TRADE_META_KEY, o); }
  return rec || {};
}

function setExitHint(ticket, symbol, how) {
  if (!ticket && !symbol) return;
  const o = loadObj(EXIT_HINT_KEY);
  o[tradeMetaKeyOf(ticket, symbol)] = { how, at: Date.now() };
  const cutoff = Date.now() - 2 * 86400000;
  for (const k of Object.keys(o)) if (!(Number(o[k] && o[k].at) > cutoff)) delete o[k];
  saveObj(EXIT_HINT_KEY, o);
}

function takeExitHint(ticket, symbol) {
  const o = loadObj(EXIT_HINT_KEY);
  const k = tradeMetaKeyOf(ticket, symbol);
  const rec = o[k];
  if (rec) { delete o[k]; saveObj(EXIT_HINT_KEY, o); }
  return rec ? String(rec.how || '') : '';
}

/* AI kararlarını kalıcı günlüğe yaz (etkinlik ölçümü için) */
function journalAction(a) {
  if (!a || !a.kind) return;
  jev.journalAction(Object.assign({ ts: Math.floor(Date.now() / 1000), src: 'ai', tf: chartState.tf }, a)).catch(() => {});
}

/* borsadan gelen kapananları kalıcı hafızaya TEK SEFER yazar (idempotent) */
function journalSyncClosed(rows) {
  const seen = loadObj(JOURNAL_SEEN_KEY);
  const now = Math.floor(Date.now() / 1000);
  let added = 0;
  for (const c of rows || []) {
    const ts = Number(c.close_time) || 0;
    if (!(ts > 0)) continue;
    const sym = String(c.symbol || '').toUpperCase();
    const tk = c.position_id != null && c.position_id !== '' ? c.position_id : (c.ticket != null ? c.ticket : '');
    const net = Number(c.profit || 0) + Number(c.swap || 0) + Number(c.commission || 0);
    const key = ts + '|' + sym + '|' + tk + '|' + net.toFixed(4);
    if (seen[key]) continue;
    seen[key] = now;
    const meta = takeTradeMeta(tk, sym);
    const hint = takeExitHint(tk, sym);
    let exit = hint;
    if (!exit) {
      const reason = Number(c.reason);
      const open = Number(c.open_price) || 0;
      const close = Number(c.close_price) || 0;
      const sl = Number(c.sl) || 0;
      const tp = Number(c.tp) || 0;
      if (reason === 4 || (sl > 0 && open > 0 && Math.abs(close - sl) < 1e-8)) exit = 'sl';
      else if (reason === 5 || (tp > 0 && open > 0 && Math.abs(close - tp) < 1e-8)) exit = 'tp';
      else if (reason === -1) exit = 'manual';
      else exit = 'sizing-out';
    }
    jev.journalTrade({
      ts, sym,
      side: Number(c.type) === 1 ? 'short' : 'long',
      net,
      r: closedR(c),
      tf: meta.tf || '',
      grade: meta.grade || '',
      p: meta.p || 0,
      rr: meta.rr || 0,
      exit,
      ticket: tk,
      mins: Math.max(0, (ts - (Number(c.open_time) || ts)) / 60),
    }).catch(() => {});
    added++;
  }
  if (added) {
    const cutoff = now - 5 * 86400000;
    for (const k of Object.keys(seen)) if (!(Number(seen[k]) > cutoff)) delete seen[k];
    saveObj(JOURNAL_SEEN_KEY, seen);
  }
  return added;
}

/* kalıcı hafıza özetini prompt'a ekle (öğrenme döngüsü) */
async function journalPromptBlock(days) {
  const r = await jev.journalSummary({ days: days || 30 }).catch(() => null);
  if (!r || !r.ok) return '';
  return '\n\n[PERFORMANS HAFIZASI]' + r.text;
}

const DEFAULT_COLORS = { up: '#22c55e', down: '#ef4444', bg: '#0d0d0f', bgOn: false, line: '#e5e7eb', lineAuto: true, lineAlpha: 100, cross: '#8a8a92', crossAlpha: 70, planSl: '#f43f5e', planTp: '#22c55e', planText: '#000000', planEntry: '#cbd5e1', planFill: 30, posSl: '#f43f5e', posTp: '#22c55e', volUp: '#22c55e', volDown: '#ef4444', lvlEntry: '#3b82f6', lvlPending: '#f59e0b', lvlSl: '#ef4444', lvlTp: '#22c55e', lvlAlpha: 85, lvlWidth: 1 };

function hexA(hex, a) {
  const h = String(hex || '').replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  if (!Number.isFinite(n) || v.length !== 6) return 'rgba(148, 163, 184, ' + a + ')';
  return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + a + ')';
}

function loadChartColors() {
  try {
    const raw = JSON.parse(localStorage.getItem('jev.colors') || '{}');
    if (raw && typeof raw === 'object') return { ...DEFAULT_COLORS, ...raw };
  } catch {}
  return { ...DEFAULT_COLORS };
}

function saveChartColors() {
  try { localStorage.setItem('jev.colors', JSON.stringify(chartState.colors)); } catch {}
}

const DEFAULT_DRAW_COLORS = { hline: '#f59e0b', hray: '#06b6d4', seg: '#000000', ray: '#3b82f6', fibo: '#a855f7', rect: '#3b82f6', rectAlpha: 30, free: '#22c55e', zigzag: '#eab308', channel: '#0ea5e9', range: '#ec4899', text: '#e5e7eb' };

function loadDrawColors() {
  try {
    const raw = JSON.parse(localStorage.getItem('jev.drawColors') || '{}');
    if (raw && typeof raw === 'object') return { ...DEFAULT_DRAW_COLORS, ...raw };
  } catch {}
  return { ...DEFAULT_DRAW_COLORS };
}

function saveDrawColors() {
  try { localStorage.setItem('jev.drawColors', JSON.stringify(chartState.drawColors)); } catch {}
}

const CHART_COUNT = 1000;
const chartState = {
  colors: loadChartColors(),
  symbol: localStorage.getItem('jev.symbol') || 'EURUSD',
  tf: localStorage.getItem('jev.tf') || 'M15',
  rates: [],
  digits: 5,
  busy: false,
  hover: null,
  hoverY: null,
  tick: null,
  tickSpread: 0,
  tickPoint: 0,
  account: null,
  acctBusy: false,
  symLoaded: false,
  positions: [],
  posBusy: false,
  orders: [],
  ordBusy: false,
  closed: [],
  histBusy: false,
  allSymbols: [],
  symFetching: false,
  symInfo: {},
  viewEnd: 0,
  viewCount: 0,
  /* takip açıkken sağda bırakılacak boşluk (görünür mum oranı) */
  rightGap: 0,
  yOffset: 0,
  yScale: 1,
  /* dikey ölçek kilidi: pan/tarih-şeridi sıkıştırmada dikey zoom sabit kalır */
  yLock: null,
  /* ters grafik (invert scale): fiyat ekseni aşağı-yukarı çevrilir */
  invert: localStorage.getItem('jev.invert') === '1',
  follow: true,
  dragging: false,
  dragMode: 'pan',
  dragX: 0,
  dragY: 0,
  tool: 'cursor',
  autoBusy: false,
  pending: [],
  drawings: [],
  drawColors: loadDrawColors(),
  alerts: [],
  plans: [],
  showLevels: localStorage.getItem('jev.showLevels') !== '0',
  showOrdLevels: localStorage.getItem('jev.showOrdLevels') !== '0',
  showAlertLevels: localStorage.getItem('jev.showAlertLevels') !== '0',
  showVolume: localStorage.getItem('jev.showVolume') === '1',
  /* AVG: açık işlemlerin hacim ağırlıklı ortalama giriş çizgisi (varsayılan açık) */
  showAvg: localStorage.getItem('jev.showAvg') !== '0',
  /* açık işlem yazıları: giriş/SL/TP etiketleri + plan kutusu metinleri (varsayılan açık) */
  showPosText: localStorage.getItem('jev.showPosText') !== '0',
  selected: null,
  free: null,
  /* kısa çizgi sürüklemesi: { a, b } */
  segDrag: null,
  dragDraw: null,
  mouse: null,
  textAnchor: null,
};

function fmtPrice(v) {
  return Number(v).toFixed(chartState.digits);
}

/* MT5 zamanları sunucu saatidir (PC saatiyle aynı taban): UTC getter'ları ile
   ham değer gösterilir; yerel saat dilimi eklenmez (MT5 terminaliyle birebir). */
function tfTimeLabel(sec, tf) {
  const d = new Date(sec * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  const rank = TF_RANK[tfNorm(tf)] || 3;
  const hm = p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  const dm = p2(d.getUTCDate()) + '.' + p2(d.getUTCMonth() + 1);
  if (rank >= TF_RANK.D1) return dm;
  if (rank >= TF_RANK.H1) return dm + ' ' + hm;
  /* dakikalı TF'lerde gün sınırı ekranda kaybolur; 00:00 bandında tarihi göster */
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return dm;
  return hm;
}

/* crosshair zaman etiketi: tarih + saat (mouse'un olduğu nokta) */
function crosshairTimeLabel(sec, tf) {
  const d = new Date(sec * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  const rank = TF_RANK[tfNorm(tf)] || 3;
  const hm = p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  const dm = p2(d.getUTCDate()) + '.' + p2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear();
  if (rank >= TF_RANK.D1) return dm;
  return dm + ' ' + hm;
}

function setChartMsg(text, isErr) {
  const el = $('#chartMsg');
  el.textContent = text || '';
  el.classList.toggle('show', !!text);
  el.classList.toggle('err', !!isErr);
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function computeDigits() {
  let dec = 2;
  for (let i = Math.max(0, chartState.rates.length - 10); i < chartState.rates.length; i++) {
    const s = String(chartState.rates[i].close);
    const dot = s.indexOf('.');
    if (dot >= 0) dec = Math.max(dec, s.length - dot - 1);
  }
  chartState.digits = Math.min(dec, 5);
}

/* dikey zoom: imlecin (clientY) altindaki fiyat sabit kalir (TradingView gibi) */
/* ---------- dikey ölçek kilidi (yLock) ----------
   Pan (sağa-sola kaydırma) ve tarih şeridinden mum sıkıştırma/ genişletme
   sırasında dikey zoom SABİT kalır: fiyat ekranda yerinde durur, yalnız
   mumlar kayar/sıkışır. Kilit şunlarla açılır: tekerlek (x-zoom), zoom
   butonları, "son mum" (#playBtn), çift tık reset, resetView, TF/sembol
   değişimi; canlı fiyat kilitli aralığın dışına çıkınca da kendiliğinden. */
function yLockCapture(st) {
  const g = st.range;
  if (g && (g.hi - g.lo) > 0) st.yLock = { lo: g.lo, hi: g.hi };
}
function yLockActive(st) {
  return !!(st.yLock && (st.yLock.hi - st.yLock.lo) > 0);
}

function zoomYAt(clientY, factor) {
  const geo = chartState.range;
  const canvas = $('#chart');
  if (!geo || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  const padT = 10, padB = 20;
  const plotH = rect.height - padT - padB;
  if (plotH <= 0) return;
  const y = Math.max(padT, Math.min(padT + plotH, clientY - rect.top));
  const span = geo.hi - geo.lo;
  if (!(span > 0)) return;
  const inv = !!chartState.invert;
  const t = (y - padT) / plotH;
  const p = inv ? geo.lo + t * span : geo.hi - t * span;
  const f = inv ? (p - geo.lo) / span : (geo.hi - p) / span;
  if (yLockActive(chartState)) {
    /* kilitli ölçek: imleç altındaki fiyat sabit, kilitli aralık ölçeklenir */
    const newSpan = span / factor;
    const newLo = inv ? p - f * newSpan : p - (1 - f) * newSpan;
    chartState.yLock = { lo: newLo, hi: newLo + newSpan };
    drawChart();
    return;
  }
  const newScale = Math.max(0.2, Math.min(20, chartState.yScale * factor));
  const newSpan = (geo.dataSpan / newScale) * 1.12;
  const newLo = inv ? p - f * newSpan : p - (1 - f) * newSpan;
  const yOff = (newLo - geo.mid + newSpan / 2) / newSpan;
  chartState.yScale = newScale;
  chartState.yOffset = Math.max(-5, Math.min(5, yOff));
  drawChart();
  /* elle dikey zoom sonrası ölçeği kilitle: sonraki pan/sıkıştırma bozmasın */
  yLockCapture(chartState);
}

/* ---------- çizim araçları (toolbox) ---------- */
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

/* çizimler sembol bazlı saklanır — TF değişince hiçbir çizim kaybolmaz */
function drawKey() {
  return 'jev.draw.' + chartState.symbol;
}

function loadDrawings() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(drawKey()) || 'null'); } catch {}
  if (!Array.isArray(raw)) {
    /* eski sürümde TF başına kaydediliyordu: tüm TF listelerini birleştirip taşı */
    raw = [];
    const seen = new Set();
    for (const tf of TFS) {
      const legacyKey = 'jev.draw.' + chartState.symbol + '.' + tf;
      try {
        const legacy = JSON.parse(localStorage.getItem(legacyKey) || '[]');
        if (Array.isArray(legacy)) {
          for (const d of legacy) {
            if (!d || typeof d !== 'object') continue;
            const k = JSON.stringify([d.type, d.points, d.label, d.text, d.color, d.alpha, d.labelSize, d.labelAlign, d.labelVAlign]);
            if (seen.has(k)) continue;
            seen.add(k);
            raw.push(d);
          }
        }
      } catch {}
      try { localStorage.removeItem(legacyKey); } catch {}
    }
    raw = raw.slice(-300);
    if (raw.length) {
      try { localStorage.setItem(drawKey(), JSON.stringify(raw)); } catch {}
    }
  }
  chartState.drawings = Array.isArray(raw) ? raw : [];
  chartState.pending = [];
  chartState.selected = null;
  chartState.free = null;
}

function saveDrawings() {
  pushUndoIfChanged();
  try { localStorage.setItem(drawKey(), JSON.stringify(chartState.drawings.slice(-300))); } catch {}
  /* 2. grafik açıksa çizimleri tazele (aynı sembolde ortak) */
  if (pane2.on && !pane2.session) {
    if (pane2.symbol === chartState.symbol) pane2.drawings = chartState.drawings;
    drawPane2();
  }
}

function idxFromTime(t) {
  const rates = chartState.rates;
  if (!rates.length) return 0;
  const n = rates.length;
  const lastT = rates[n - 1].time;
  /* mum aralığı: son iki mumun farkı (yoksa 60 sn) */
  const iv = Math.max(1, lastT - (n >= 2 ? rates[n - 2].time : lastT - 60));
  /* veri dışına taşan zamanlar (son mumun ötesi / ilk mumun gerisi) ekstrapole edilir */
  if (t > lastT) return (n - 1) + (t - lastT) / iv;
  if (t < rates[0].time) return (t - rates[0].time) / iv;
  let a = 0, b = n - 1, res = -1;
  while (a <= b) {
    const m = (a + b) >> 1;
    if (rates[m].time <= t) { res = m; a = m + 1; } else b = m - 1;
  }
  return res < 0 ? 0 : res;
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/* paralel kanal: A-B ana çizgi, C paralel çizginin geçtiği nokta (3 tık).
   Range gibi kısa çizgilerdir: uçlar noktaların en solundan en sağına kadar uzanır. */
function channelSegments(P, g) {
  if (!P || P.length < 3 || !g || !(g.step > 0)) return [];
  const iA = idxFromTime(P[0].t);
  const iB = idxFromTime(P[1].t);
  const iC = idxFromTime(P[2].t);
  const di = iB - iA;
  const slope = Math.abs(di) > 1e-9 ? (P[1].p - P[0].p) / di : 0;
  const i0 = Math.min(iA, iB, iC);
  const i1 = Math.max(iA, iB, iC);
  return [
    { x1: g.xOf(i0), y1: g.yOf(P[0].p + slope * (i0 - iA)), x2: g.xOf(i1), y2: g.yOf(P[0].p + slope * (i1 - iA)) },
    { x1: g.xOf(i0), y1: g.yOf(P[2].p + slope * (i0 - iC)), x2: g.xOf(i1), y2: g.yOf(P[2].p + slope * (i1 - iC)) },
  ];
}

function drawingSegments(d, g) {
  const segs = [];
  const P = d.points || [];
  if (d.type === 'hline' && P[0]) {
    const y = g.yOf(P[0].p);
    segs.push({ x1: g.padL, y1: y, x2: g.padL + g.plotW, y2: y });
    return segs;
  }
  if (d.type === 'ray' && P.length >= 2) {
    /* artık sonsuza uzamaz: yalnızca çizilen iki nokta arasında kalır (trend çizgisi) */
    const x1 = g.xOf(idxFromTime(P[0].t));
    const y1 = g.yOf(P[0].p);
    const x2 = g.xOf(idxFromTime(P[1].t));
    const y2 = g.yOf(P[1].p);
    segs.push({ x1, y1, x2, y2 });
    return segs;
  }
  if (d.type === 'fibo' && P.length >= 2) {
    const xa = g.xOf(idxFromTime(P[0].t));
    const xb = g.xOf(idxFromTime(P[1].t));
    const x1 = Math.min(xa, xb);
    const x2 = Math.max(xa, xb);
    for (const lv of FIB_LEVELS) {
      const p = P[1].p + (P[0].p - P[1].p) * lv;
      const y = g.yOf(p);
      segs.push({ x1, y1: y, x2, y2: y, level: lv, price: p });
    }
    segs.push({ x1: xa, y1: g.yOf(P[0].p), x2: xb, y2: g.yOf(P[1].p), trend: true });
    return segs;
  }
  if (d.type === 'seg' && P.length >= 2) {
    /* kısa çizgi: iki nokta arası, uzanmaz */
    segs.push({
      x1: g.xOf(idxFromTime(P[0].t)), y1: g.yOf(P[0].p),
      x2: g.xOf(idxFromTime(P[1].t)), y2: g.yOf(P[1].p),
    });
    return segs;
  }
  if (d.type === 'hray' && P.length >= 1) {
    const x = g.xOf(idxFromTime(P[0].t));
    const y = g.yOf(P[0].p);
    segs.push({ x1: x, y1: y, x2: g.padL + g.plotW, y2: y });
    return segs;
  }
  if (d.type === 'rect' && P.length >= 2) {
    const xa = g.xOf(idxFromTime(P[0].t));
    const ya = g.yOf(P[0].p);
    const xb = g.xOf(idxFromTime(P[1].t));
    const yb = g.yOf(P[1].p);
    segs.push({ x1: xa, y1: ya, x2: xb, y2: ya });
    segs.push({ x1: xb, y1: ya, x2: xb, y2: yb });
    segs.push({ x1: xb, y1: yb, x2: xa, y2: yb });
    segs.push({ x1: xa, y1: yb, x2: xa, y2: ya });
    return segs;
  }
  if (d.type === 'channel' && P.length >= 3) {
    /* paralel kanal: ana çizgi + paraleli */
    return channelSegments(P, g);
  }
  if (d.type === 'range' && P.length >= 2) {
    /* range: başlangıç-bitiş arası üst ve alt yatay çizgi (kısa/yatay bant) */
    const xa = g.xOf(idxFromTime(P[0].t));
    const xb = g.xOf(idxFromTime(P[1].t));
    const x0 = Math.min(xa, xb);
    const x1 = Math.max(xa, xb);
    const top = Math.max(P[0].p, P[1].p);
    const bot = Math.min(P[0].p, P[1].p);
    segs.push({ x1: x0, y1: g.yOf(top), x2: x1, y2: g.yOf(top) });
    segs.push({ x1: x0, y1: g.yOf(bot), x2: x1, y2: g.yOf(bot) });
    return segs;
  }
  if (d.type === 'zigzag' && P.length >= 2) {
    /* zigzag: kırılım noktalarını sırayla birleştir */
    for (let i = 1; i < P.length; i++) {
      segs.push({
        x1: g.xOf(idxFromTime(P[i - 1].t)), y1: g.yOf(P[i - 1].p),
        x2: g.xOf(idxFromTime(P[i].t)), y2: g.yOf(P[i].p),
      });
    }
    return segs;
  }
  if (d.type === 'free' && P.length >= 2) {
    for (let i = 1; i < P.length; i++) {
      segs.push({
        x1: g.xOf(idxFromTime(P[i - 1].t)), y1: g.yOf(P[i - 1].p),
        x2: g.xOf(idxFromTime(P[i].t)), y2: g.yOf(P[i].p),
      });
    }
    return segs;
  }
  return segs;
}

function hitDrawing(mx, my, g) {
  for (let i = chartState.drawings.length - 1; i >= 0; i--) {
    const d = chartState.drawings[i];
    if (d.type === 'emoji' && d.points && d.points[0]) {
      const x = g.xOf(idxFromTime(d.points[0].t));
      const y = g.yOf(d.points[0].p);
      const size = Math.max(10, Math.min(80, Math.round(Number(d.size) || 22)));
      const r = size / 2 + 4;
      if (Math.abs(mx - x) <= r && Math.abs(my - y) <= r) return i;
      continue;
    }
    if (d.type === 'text' && d.points && d.points[0]) {
      const x = g.xOf(idxFromTime(d.points[0].t));
      const y = g.yOf(d.points[0].p);
      const size = Math.max(9, Math.min(60, Math.round(Number(d.size) || 9)));
      const w = Math.max(20, String(d.text || '').length * size * 0.62 + 10);
      if (mx >= x - 4 && mx <= x + w && my >= y - size - 4 && my <= y + 8) return i;
      continue;
    }
    if (d.type === 'rect' && d.points && d.points.length >= 2) {
      const x0 = g.xOf(idxFromTime(d.points[0].t));
      const y0 = g.yOf(d.points[0].p);
      const x1 = g.xOf(idxFromTime(d.points[1].t));
      const y1 = g.yOf(d.points[1].p);
      if (mx >= Math.min(x0, x1) - 3 && mx <= Math.max(x0, x1) + 3 && my >= Math.min(y0, y1) - 3 && my <= Math.max(y0, y1) + 3) return i;
      continue;
    }
    for (const s of drawingSegments(d, g)) {
      if (distToSeg(mx, my, s.x1, s.y1, s.x2, s.y2) < 6) return i;
    }
  }
  return -1;
}

/* Shift ile: yeni kısa çizgi son çizilen kısa çizgiye PARALEL olsun */
function parallelSegPoint(a, pt) {
  const list = chartState.drawings || [];
  let last = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (d && d.type === 'seg' && d.points && d.points.length >= 2) { last = d; break; }
  }
  if (!last) return { t: pt.t, p: a.p };  /* önceki çizgi yok: yatay */
  const i0 = idxFromTime(last.points[0].t);
  const i1 = idxFromTime(last.points[1].t);
  const di = i1 - i0;
  if (Math.abs(di) < 1e-6) return { t: pt.t, p: a.p };
  const slope = (last.points[1].p - last.points[0].p) / di;
  const ia = idxFromTime(a.t);
  const ib = idxFromTime(pt.t);
  return { t: pt.t, p: a.p + slope * (ib - ia) };
}

/* zigzag: tıklanan noktayı o mumun fitiline yapıştırır — yalnızca imleç fitile
   çok yakınsa ve tık veri aralığındaysa; aksi halde tıklanan nokta aynen korunur
   (nokta asla yana kaymaz, imlecin altında kalır) */
function snapZigzagPoint(pt) {
  const rates = chartState.rates || [];
  const g = chartState.geo;
  if (!rates.length || !pt) return pt;
  const n = rates.length;
  /* veri aralığı dışında (sağ/sol boşluk) yapıştırma yok */
  if (pt.t < rates[0].time || pt.t > rates[n - 1].time) return pt;
  const c = Math.max(0, Math.min(n - 1, Math.round(idxFromTime(pt.t))));
  const r = rates[c];
  let best = null;
  let bd = Infinity;
  for (const v of [Number(r.high), Number(r.low)]) {
    if (!Number.isFinite(v)) continue;
    const d = Math.abs(v - pt.p);
    if (d < bd) { bd = d; best = { t: r.time, p: v }; }
  }
  if (!best) return pt;
  /* yalnızca fitile ekranda ~10px'den yakınsa yapıştır; değilse tıklanan yeri koru */
  const tolPx = 10;
  const tolPrice = g && g.plotH > 0 ? ((g.hi - g.lo) / g.plotH) * tolPx : 0;
  return bd <= Math.max(tolPrice, 1e-9) ? best : pt;
}

/* çizgi uç tutamacı isabet testi (trend / kısa çizgi / kanal / zigzag):
   uçlar tek tek sürüklenebilir; kanal ve zigzag'da tüm kurucu noktalar tutulabilir */
function hitEndpoint(mx, my, g) {
  const list = chartState.drawings || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (!d || !d.points || !d.points.length) continue;
    const twoPt = d.type === 'ray' || d.type === 'seg' || d.type === 'range';
    if (!twoPt && d.type !== 'channel' && d.type !== 'zigzag') continue;
    /* range: yer değiştirme/uzatma-kısaltma yalnız çizim seçiliyken */
    if (d.type === 'range' && chartState.selected !== i) continue;
    const kMax = twoPt ? Math.min(2, d.points.length) : d.points.length;
    for (let k = 0; k < kMax; k++) {
      const x = g.xOf(idxFromTime(d.points[k].t));
      const y = g.yOf(d.points[k].p);
      if (Math.abs(mx - x) <= 7 && Math.abs(my - y) <= 7) return { i, ptIdx: k };
    }
  }
  return null;
}

/* fibo sağ kenarı isabet testi: kenardan tutup genişlik değiştirilir */
function hitFiboEdge(mx, my, g) {
  const list = chartState.drawings || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i];
    if (!d || d.type !== 'fibo' || !d.points || d.points.length < 2) continue;
    const p0 = d.points[0], p1 = d.points[1];
    const x0 = g.xOf(idxFromTime(p0.t));
    const x1 = g.xOf(idxFromTime(p1.t));
    const xr = Math.max(x0, x1);
    const edgeIdx = x1 >= x0 ? 1 : 0;
    const y0 = g.yOf(p0.p), y1 = g.yOf(p1.p);
    const yTop = Math.min(y0, y1), yBot = Math.max(y0, y1);
    if (Math.abs(mx - xr) <= 6 && my >= yTop - 12 && my <= yBot + 12) return { d, i, edgeIdx };
  }
  return null;
}

function paintDrawings(ctx, g) {
  /* kırpma alanının dışına taşan eksen etiketleri (yatay ışın) */
  const axisTags = [];
  const tag = (p, y, color) => {
    if (y < g.padT - 1 || y > g.padT + g.plotH + 1) return;
    const lbl = fmtPrice(p);
    ctx.font = '600 10px Segoe UI, sans-serif';
    const tw = ctx.measureText(lbl).width + 10;
    ctx.fillStyle = color;
    roundRectPath(ctx, g.padL + 6, y - 8, tw, 16, 4);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(lbl, g.padL + 11, y);
  };
  const dot = (x, y, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  };
  /* çizim etiketi: sol / orta / sağ hizalı; kısa çizgilerde de görünür */
  const paintLabel = (d, color, xA, xB, yRef, box) => {
    if (!d.label) return;
    const txt = String(d.label).slice(0, 120);
    const size = Math.max(9, Math.min(60, Math.round(Number(d.labelSize) || 9)));
    const al = d.labelAlign || 'center';
    ctx.globalAlpha = 1;
    ctx.font = '700 ' + size + 'px Segoe UI, sans-serif';
    ctx.textAlign = al === 'left' ? 'left' : al === 'right' ? 'right' : 'center';
    /* kısa çizgilerde etiket çizgiden taşabildiği için konumu kırpma alanına sığdır */
    const tw = ctx.measureText(txt).width;
    let x = al === 'left' ? xA + 6 : al === 'right' ? xB - 6 : (xA + xB) / 2;
    const xMin = g.padL + 2;
    const xMax = g.padL + g.plotW - 2;
    if (al === 'center') x = Math.max(xMin + tw / 2, Math.min(xMax - tw / 2, x));
    else if (al === 'left') x = Math.max(xMin, Math.min(xMax - tw, x));
    else x = Math.min(xMax, Math.max(xMin + tw, x));
    let y = yRef - 6;
    if (box) {
      const va = d.labelVAlign || 'middle';
      y = va === 'middle' ? box.top + box.h / 2 + size * 0.35
        : va === 'bottom' ? box.top + box.h - 6
        : box.top + size + 4;
    }
    y = Math.max(g.padT + size, Math.min(g.padT + g.plotH - 2, y));
    ctx.fillStyle = d.labelColor || color || '#000000';
    ctx.fillText(txt, x, y);
    ctx.textAlign = 'left';
  };

  /* çizimler grafik alanına kırpılır (fiyat/zaman eksenine taşmasın) */
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.padL, g.padT, g.plotW, g.plotH);
  ctx.clip();

  for (let di = 0; di < chartState.drawings.length; di++) {
    const d = chartState.drawings[di];
    const sel = di === chartState.selected;
    const lw = sel ? 2.4 : 1.4;
    const color = d.color || chartState.drawColors[d.type] || '#3b82f6';
    if (d.type === 'hline' && d.points && d.points[0]) {
      const y = g.yOf(d.points[0].p);
      if (y < g.padT - 1 || y > g.padT + g.plotH + 1) { /* görünüm dışı */ }
      else {
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(g.padL, y);
        ctx.lineTo(g.padL + g.plotW, y);
        ctx.stroke();
        /* fiyat etiketi: en sağda, fiyat ekseni içinde (kırpma dışında çizilir) */
        axisTags.push({ p: d.points[0].p, y, color });
      }
      paintLabel(d, color, g.padL, g.padL + g.plotW, y);
    } else if (d.type === 'hray' && d.points && d.points[0]) {
      /* konulduğu yerden grafiğin sağ ucuna kadar uzanan yatay ışın */
      const x0h = g.xOf(idxFromTime(d.points[0].t));
      const yh = g.yOf(d.points[0].p);
      if (yh >= g.padT - 1 && yh <= g.padT + g.plotH + 1) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x0h, yh);
        ctx.lineTo(g.padL + g.plotW, yh);
        ctx.stroke();
        /* fiyat etiketi: en sağda, fiyat ekseni içinde (kırpma dışında çizilir) */
        axisTags.push({ p: d.points[0].p, y: yh, color });
      }
      paintLabel(d, color, x0h, g.padL + g.plotW, yh);
    } else if (d.type === 'seg' && d.points && d.points.length >= 2) {
      /* kısa çizgi: iki nokta arası (etiket ve uç noktalar çizilmez) */
      const s = drawingSegments(d, g)[0];
      if (s) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        paintLabel(d, color, Math.min(s.x1, s.x2), Math.max(s.x1, s.x2), Math.min(s.y1, s.y2));
      }
    } else if (d.type === 'ray') {
      const s = drawingSegments(d, g)[0];
      if (s) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        if (d.points && d.points[1]) {
          dot(s.x1, s.y1, color);
          dot(g.xOf(idxFromTime(d.points[1].t)), g.yOf(d.points[1].p), color);
        }
        paintLabel(d, color, Math.min(s.x1, s.x2), Math.max(s.x1, s.x2), (s.y1 + s.y2) / 2);
      }
    } else if (d.type === 'fibo') {
      ctx.font = '600 10px Segoe UI, sans-serif';
      ctx.textAlign = 'left';
      for (const s of drawingSegments(d, g)) {
        if (s.trend) {
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.7;
          ctx.lineWidth = lw;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2, s.y2);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          continue;
        }
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        const lvlTxt = (Math.round(s.level * 1000) / 10) + '%  ' + fmtPrice(s.price);
        const al2 = d.labelAlign || 'left';
        const sx1 = Math.min(s.x1, s.x2);
        const sx2 = Math.max(s.x1, s.x2);
        if (al2 === 'right') {
          ctx.textAlign = 'right';
          ctx.fillText(lvlTxt, sx2 - 6, s.y1 - 4);
        } else if (al2 === 'center') {
          ctx.textAlign = 'center';
          ctx.fillText(lvlTxt, (sx1 + sx2) / 2, s.y1 - 4);
        } else {
          ctx.textAlign = 'left';
          ctx.fillText(lvlTxt, sx1 + 6, s.y1 - 4);
        }
        ctx.textAlign = 'left';
      }
      if (d.points && d.points.length >= 2) {
        const xa = g.xOf(idxFromTime(d.points[0].t));
        const xb = g.xOf(idxFromTime(d.points[1].t));
        const yTop = Math.min(g.yOf(d.points[0].p), g.yOf(d.points[1].p));
        paintLabel(d, color, Math.min(xa, xb), Math.max(xa, xb), yTop);
      }
    } else if (d.type === 'rect' && d.points && d.points.length >= 2) {
      const xa = g.xOf(idxFromTime(d.points[0].t));
      const ya = g.yOf(d.points[0].p);
      const xb = g.xOf(idxFromTime(d.points[1].t));
      const yb = g.yOf(d.points[1].p);
      const rx = Math.min(xa, xb);
      const ry = Math.min(ya, yb);
      const rw = Math.abs(xb - xa);
      const rh = Math.abs(yb - ya);
      const aRaw = d.alpha == null ? chartState.drawColors.rectAlpha : Number(d.alpha);
      const a = Math.max(0, Math.min(1, (Number.isFinite(aRaw) ? aRaw : 30) / 100));
      ctx.globalAlpha = a;
      ctx.fillStyle = color;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.setLineDash([]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.globalAlpha = 1;
      paintLabel(d, color, rx, rx + rw, 0, { top: ry, h: rh });
    } else if (d.type === 'free' && d.points && d.points.length >= 2) {
      ctx.strokeStyle = color;
      ctx.lineWidth = sel ? 2.6 : 1.6;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      d.points.forEach((P, i) => {
        const x = g.xOf(idxFromTime(P.t));
        const y = g.yOf(P.p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      let mnX = Infinity, mxX = -Infinity, mnY = Infinity;
      for (const P of d.points) {
        const x = g.xOf(idxFromTime(P.t));
        const y = g.yOf(P.p);
        if (x < mnX) mnX = x;
        if (x > mxX) mxX = x;
        if (y < mnY) mnY = y;
      }
      paintLabel(d, color, mnX, mxX, mnY);
    } else if (d.type === 'zigzag' && d.points && d.points.length >= 2) {
      /* zigzag: kırılım noktaları düz çizgilerle birleşir, pivotlarda nokta */
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash([]);
      ctx.beginPath();
      d.points.forEach((P, i) => {
        const x = g.xOf(idxFromTime(P.t));
        const y = g.yOf(P.p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      let zmnX = Infinity, zmxX = -Infinity, zmnY = Infinity;
      for (const P of d.points) {
        const x = g.xOf(idxFromTime(P.t));
        const y = g.yOf(P.p);
        dot(x, y, color);
        if (x < zmnX) zmnX = x;
        if (x > zmxX) zmxX = x;
        if (y < zmnY) zmnY = y;
      }
      paintLabel(d, color, zmnX, zmxX, zmnY);
    } else if (d.type === 'channel' && d.points && d.points.length >= 3) {
      /* paralel kanal: iki paralel çizgi + araları hafif dolgu */
      const cseg = channelSegments(d.points, g);
      if (cseg.length >= 2) {
        const aRaw = d.alpha == null ? 12 : Number(d.alpha);
        const ca = Math.max(0, Math.min(1, (Number.isFinite(aRaw) ? aRaw : 12) / 100));
        if (ca > 0) {
          ctx.globalAlpha = ca;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(cseg[0].x1, cseg[0].y1);
          ctx.lineTo(cseg[0].x2, cseg[0].y2);
          ctx.lineTo(cseg[1].x2, cseg[1].y2);
          ctx.lineTo(cseg[1].x1, cseg[1].y1);
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.setLineDash([]);
        for (const s of cseg) {
          ctx.beginPath();
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2, s.y2);
          ctx.stroke();
        }
        for (const P of d.points) dot(g.xOf(idxFromTime(P.t)), g.yOf(P.p), color);
        paintLabel(d, color, g.padL, g.padL + g.plotW, g.yOf(d.points[0].p));
      }
    } else if (d.type === 'range' && d.points && d.points.length >= 2) {
      /* range: başlangıç-bitiş arası üst/alt yatay çizgi. Yazılar ve rakamlar
         ÇİZGİNİN İÇİNDE (dikey orta) yazılır; arkalarında boşluk bırakılır ki
         sadece yazılar görünsün, çizgi yazının üstünden geçmesin. */
      const rseg = drawingSegments(d, g);
      if (rseg.length >= 2) {
        const x0 = Math.min(rseg[0].x1, rseg[0].x2);
        const x1 = Math.max(rseg[0].x1, rseg[0].x2);
        const topY = rseg[0].y1;
        const botY = rseg[1].y1;
        const topP = Math.max(Number(d.points[0].p), Number(d.points[1].p));
        const botP = Math.min(Number(d.points[0].p), Number(d.points[1].p));
        const priceFont = '600 10px Segoe UI, sans-serif';
        /* çizgi üzerindeki yazı blokları: { line, text, anchor, align, font, fill } */
        const items = [];
        items.push({ line: 0, text: fmtPrice(topP), anchor: x1 - 6, align: 'right', font: priceFont, fill: color });
        items.push({ line: 1, text: fmtPrice(botP), anchor: x1 - 6, align: 'right', font: priceFont, fill: color });
        if (d.label || d.labelBottom) {
          const size = Math.max(9, Math.min(60, Math.round(Number(d.labelSize) || 9)));
          const lf = '700 ' + size + 'px Segoe UI, sans-serif';
          const al = d.labelAlign || 'center';
          ctx.font = priceFont;
          const wTop = ctx.measureText(fmtPrice(topP)).width;
          const wBot = ctx.measureText(fmtPrice(botP)).width;
          /* sağ hizalıysa fiyat rakamının soluna kaydır (üst üste binmesin) */
          if (d.label) {
            const lx = al === 'left' ? x0 + 6 : al === 'center' ? (x0 + x1) / 2 : x1 - 6 - wTop - 14;
            items.push({ line: 0, text: String(d.label).slice(0, 120), anchor: lx, align: al, font: lf, fill: d.labelColor || color });
          }
          /* alt yazı: alt çizgiye yazılır (üst yazıdan bağımsız) */
          if (d.labelBottom) {
            const lx2 = al === 'left' ? x0 + 6 : al === 'center' ? (x0 + x1) / 2 : x1 - 6 - wBot - 14;
            items.push({ line: 1, text: String(d.labelBottom).slice(0, 120), anchor: lx2, align: al, font: lf, fill: d.labelColor || color });
          }
        }
        /* çizgiyi yazıların arkasında boşluk bırakarak çiz */
        const drawRLine = (y, lineIdx, dash) => {
          const gaps = [];
          for (const it of items) {
            if (it.line !== lineIdx) continue;
            ctx.font = it.font;
            const w = ctx.measureText(it.text).width;
            const gx = it.align === 'right' ? it.anchor - w : it.align === 'center' ? it.anchor - w / 2 : it.anchor;
            gaps.push({ a: gx - 5, b: gx + w + 5 });
          }
          gaps.sort((p, q) => p.a - q.a);
          ctx.strokeStyle = color;
          ctx.lineWidth = lw;
          ctx.setLineDash(dash || []);
          let cur = x0;
          for (const gp of gaps) {
            const ga = Math.max(cur, gp.a);
            const gb = Math.min(x1, gp.b);
            if (gb <= ga) continue;
            if (ga > cur) { ctx.beginPath(); ctx.moveTo(cur, y); ctx.lineTo(ga, y); ctx.stroke(); }
            cur = Math.max(cur, gb);
          }
          if (cur < x1) { ctx.beginPath(); ctx.moveTo(cur, y); ctx.lineTo(x1, y); ctx.stroke(); }
          ctx.setLineDash([]);
        };
        drawRLine(topY, 0);
        drawRLine(botY, 1);
        /* yazılar çizgi hizasında yazılır */
        ctx.textBaseline = 'middle';
        for (const it of items) {
          ctx.font = it.font;
          ctx.fillStyle = it.fill;
          ctx.textAlign = it.align;
          ctx.fillText(it.text, it.anchor, it.line === 0 ? topY : botY);
        }
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        /* PD Array: tam ortada EQ (%50) çizgisi — yazı yine çizginin içinde, boşlukla */
        if (d.pd) {
          const midP = (topP + botP) / 2;
          const yMid = g.yOf(midP);
          const pdTxt = '50% EQ  ' + fmtPrice(midP);
          ctx.font = priceFont;
          const pw = ctx.measureText(pdTxt).width;
          const gapA = x1 - 6 - pw - 5;
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(1, lw - 0.4);
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(x0, yMid);
          ctx.lineTo(gapA, yMid);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.textBaseline = 'middle';
          ctx.fillStyle = color;
          ctx.textAlign = 'right';
          ctx.fillText(pdTxt, x1 - 6, yMid);
          ctx.textBaseline = 'alphabetic';
          ctx.textAlign = 'left';
        }
      }
    } else if (d.type === 'emoji' && d.points && d.points[0]) {
      const x = g.xOf(idxFromTime(d.points[0].t));
      const y = g.yOf(d.points[0].p);
      const size = Math.max(10, Math.min(80, Math.round(Number(d.size) || 22)));
      ctx.font = size + 'px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 1;
      ctx.fillText(String(d.text || '🙂'), x, y);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    } else if (d.type === 'text' && d.points && d.points[0]) {
      const x = g.xOf(idxFromTime(d.points[0].t));
      const y = g.yOf(d.points[0].p);
      const txt = String(d.text || '');
      const size = Math.max(9, Math.min(60, Math.round(Number(d.size) || 9)));
      ctx.font = '700 ' + size + 'px Segoe UI, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = color;
      ctx.fillText(txt, x + 2, y);
    }

    /* seçili çizimin tutamakları (kutuda 4 köşe) */
    if (sel && d.points && d.points.length) {
      let handles = [];
      if (d.type === 'rect' && d.points.length >= 2) {
        const x0 = g.xOf(idxFromTime(d.points[0].t));
        const y0 = g.yOf(d.points[0].p);
        const x1 = g.xOf(idxFromTime(d.points[1].t));
        const y1 = g.yOf(d.points[1].p);
        const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
        handles = [
          { x: x0, y: y0 }, { x: x1, y: y1 }, { x: x1, y: y0 }, { x: x0, y: y1 },
          { x: xm, y: y0 }, { x: xm, y: y1 }, { x: x0, y: ym }, { x: x1, y: ym },
        ];
      } else {
        const pts = d.type === 'free' ? [d.points[0], d.points[d.points.length - 1]] : d.points.slice(0, 20);
        handles = pts.map((P) => ({ x: g.xOf(idxFromTime(P.t)), y: g.yOf(P.p) }));
      }
      for (const H of handles) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(H.x - 2.5, H.y - 2.5, 5, 5);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(H.x - 2.5, H.y - 2.5, 5, 5);
      }
    }
  }

  /* kısa çizgi / range (canlı sürükleme) */
  if (chartState.segDrag) {
    const sd = chartState.segDrag;
    const isRange = sd.type === 'range';
    const sc = isRange ? (chartState.drawColors.range || '#ec4899') : (chartState.drawColors.seg || '#000000');
    const sx1 = g.xOf(idxFromTime(sd.a.t));
    const sy1 = g.yOf(sd.a.p);
    const sx2 = g.xOf(idxFromTime(sd.b.t));
    const sy2 = g.yOf(sd.b.p);
    ctx.strokeStyle = sc;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([]);
    if (isRange) {
      /* range: iki yatay çizgi (üst/alt) */
      const x0 = Math.min(sx1, sx2);
      const xr = Math.max(sx1, sx2);
      const yTop = Math.min(sy1, sy2);
      const yBot = Math.max(sy1, sy2);
      ctx.beginPath();
      ctx.moveTo(x0, yTop);
      ctx.lineTo(xr, yTop);
      ctx.moveTo(x0, yBot);
      ctx.lineTo(xr, yBot);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
    }
  }

  /* serbest çizim (canlı) */
  if (chartState.free && chartState.free.length >= 2) {
    ctx.strokeStyle = chartState.drawColors.free;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    chartState.free.forEach((P, i) => {
      const x = g.xOf(idxFromTime(P.t));
      const y = g.yOf(P.p);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  /* yarım kalan çizim önizlemesi */
  if (chartState.pending.length && chartState.mouse) {
    const a = chartState.pending[0];
    const x1 = g.xOf(idxFromTime(a.t));
    const y1 = g.yOf(a.p);
    const color = chartState.drawColors[chartState.tool] || '#f59e0b';
    if (chartState.tool === 'zigzag') {
      /* zigzag önizleme: mevcut pivotlar + imlece giden (muma yapışan) kol */
      const zc = chartState.drawColors.zigzag || '#eab308';
      const pts = chartState.pending.slice();
      const mp = pointFromXY(chartState.mouse.x, chartState.mouse.y, g);
      if (mp) pts.push(snapZigzagPoint(mp));
      ctx.strokeStyle = zc;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash([]);
      ctx.beginPath();
      pts.forEach((P, i) => {
        const x = g.xOf(idxFromTime(P.t));
        const y = g.yOf(P.p);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      for (const P of pts) dot(g.xOf(idxFromTime(P.t)), g.yOf(P.p), zc);
    } else if (chartState.tool === 'channel') {
      /* paralel kanal önizleme: 1. tık sonrası ana çizgi, 2. tık sonrası paraleli */
      const mp = pointFromXY(chartState.mouse.x, chartState.mouse.y, g);
      if (mp && chartState.pending.length === 1) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.8;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(g.xOf(idxFromTime(mp.t)), g.yOf(mp.p));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        dot(x1, y1, color);
      } else if (mp && chartState.pending.length >= 2) {
        const cseg = channelSegments([a, chartState.pending[1], mp], g);
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.8;
        ctx.setLineDash([4, 4]);
        for (const s of cseg) {
          ctx.beginPath();
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(s.x2, s.y2);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        dot(x1, y1, color);
        const b = chartState.pending[1];
        dot(g.xOf(idxFromTime(b.t)), g.yOf(b.p), color);
        dot(g.xOf(idxFromTime(mp.t)), g.yOf(mp.p), color);
      }
    } else if (chartState.tool === 'range') {
      /* range önizleme: a'dan imlece üst/alt yatay çizgiler */
      const rc = chartState.drawColors.range || '#ec4899';
      const yTop = Math.min(y1, chartState.mouse.y);
      const yBot = Math.max(y1, chartState.mouse.y);
      const xr = chartState.mouse.x;
      ctx.strokeStyle = rc;
      ctx.globalAlpha = 0.8;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x1, yTop);
      ctx.lineTo(xr, yTop);
      ctx.moveTo(x1, yBot);
      ctx.lineTo(xr, yBot);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      dot(x1, y1, rc);
    } else if (chartState.tool === 'rect') {
      const rx = Math.min(x1, chartState.mouse.x);
      const ry = Math.min(y1, chartState.mouse.y);
      const rw = Math.abs(chartState.mouse.x - x1);
      const rh = Math.abs(chartState.mouse.y - y1);
      ctx.globalAlpha = Math.max(0, Math.min(1, Number(chartState.drawColors.rectAlpha) / 100));
      ctx.fillStyle = color;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      dot(x1, y1, color);
    } else {
      /* kısa çizgi önizlemesi: Ctrl (yatay) / Shift (paralel) anında yansısın */
      let ex = chartState.mouse.x;
      let ey = chartState.mouse.y;
      if (chartState.tool === 'seg' && chartState.pending.length) {
        const ptRaw = pointFromXY(chartState.mouse.x, chartState.mouse.y, g);
        if (ptRaw) {
          const mods = chartState.segMods || {};
          const bPt = mods.ctrl ? { t: ptRaw.t, p: a.p } : (mods.shift ? parallelSegPoint(a, ptRaw) : ptRaw);
          ex = g.xOf(idxFromTime(bPt.t));
          ey = g.yOf(bPt.p);
        }
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      dot(x1, y1, color);
    }
  }

  ctx.restore();

  /* eksen etiketleri: kırpma kaldırıldıktan sonra, fiyat skalasının içine çizilir */
  for (const T of axisTags) {
    if (T.y < g.padT - 1 || T.y > g.padT + g.plotH + 1) continue;
    const lbl = fmtPrice(T.p);
    ctx.font = '600 10px Segoe UI, sans-serif';
    const tw = Math.min(ctx.measureText(lbl).width + 12, 62);
    ctx.globalAlpha = 1;
    ctx.fillStyle = T.color;
    roundRectPath(ctx, g.padL + g.plotW + 2, T.y - 8, tw, 16, 4);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(lbl, g.padL + g.plotW + 7, T.y);
    ctx.textBaseline = 'alphabetic';
  }
}

/* ---------- ikinci grafik (ikili mod): sağdaki bağımsız sembol/TF ---------- */
const pane2 = {
  on: false,
  symbol: (localStorage.getItem('jev.pane2.symbol') || '').toUpperCase(),
  tf: localStorage.getItem('jev.pane2.tf') || 'M15',
  rates: [],
  digits: 2,
  tick: null,
  tickSpread: 0,
  tickPoint: 0,
  busy: false,
  err: '',
  viewCount: 0,
  viewEnd: 0,
  follow: true,
  yScale: 1,
  yOffset: 0,
  yLock: null,
  invert: localStorage.getItem('jev.invert') === '1',
  range: null,
  hover: null,
  hoverY: null,
  mouse: null,
  dragging: false,
  dragMode: '',
  dragX: 0,
  dragY: 0,
  /* çizimler (sembol bazlı) — aynı sembolde 1. grafikle paylaşılır */
  drawings: [],
  plans: [],
  pending: [],
  free: null,
  textAnchor: null,
  selected: null,
  geo: null,
  session: null,
};

/* drawChart chartState'i doğrudan okur: 2. grafik için alanları geçici değiştirip geri koyarız */
const PANE2_SWAP_KEYS = [
  'symbol', 'tf', 'rates', 'digits', 'tick', 'tickSpread', 'tickPoint',
  'viewCount', 'viewEnd', 'follow', 'rightGap', 'yScale', 'yOffset', 'yLock', 'invert', 'range', 'geo',
  'hover', 'hoverY', 'mouse', 'pending', 'free', 'textAnchor', 'selected',
  'drawings', 'plans', 'dragging', 'dragMode',
];

function pane2ComputeDigits() {
  let dec = 2;
  for (let i = Math.max(0, pane2.rates.length - 10); i < pane2.rates.length; i++) {
    const s = String(pane2.rates[i].close);
    const dot = s.indexOf('.');
    if (dot >= 0) dec = Math.max(dec, s.length - dot - 1);
  }
  pane2.digits = Math.min(dec, 5);
}

/* 2. grafiğin sembolüne ait kayıtlı çizimleri yükle (1. grafikle aynı sembolse paylaşılır) */
function pane2LoadLocal() {
  if (pane2.symbol === chartState.symbol) {
    pane2.drawings = chartState.drawings;
    pane2.plans = chartState.plans;
    return;
  }
  try {
    const raw = JSON.parse(localStorage.getItem('jev.draw.' + pane2.symbol) || 'null');
    pane2.drawings = Array.isArray(raw) ? raw : [];
  } catch { pane2.drawings = []; }
  pane2.plans = chartState.plans;
}

function pane2SharedSync() {
  if (pane2.session) return;
  if (pane2.symbol === chartState.symbol) {
    pane2.drawings = chartState.drawings;
  }
  pane2.plans = chartState.plans;
}

/* 2. grafik çizim oturumu: chartState geçici olarak 2. grafiğe bağlanır,
   toolbox araçları ve sürükleme mevcut yardımcılarla çalışır */
let drawTarget = null;

function pane2BeginSession() {
  if (pane2.session) return;
  const saved = {};
  for (const k of PANE2_SWAP_KEYS) saved[k] = chartState[k];
  pane2.session = saved;
  chartState.symbol = pane2.symbol;
  chartState.tf = pane2.tf;
  chartState.rates = pane2.rates;
  chartState.digits = pane2.digits;
  chartState.geo = pane2.geo;
  chartState.drawings = pane2.drawings;
  chartState.plans = pane2.plans;
  chartState.pending = pane2.pending;
  chartState.free = pane2.free;
  chartState.textAnchor = pane2.textAnchor;
  chartState.selected = pane2.selected;
  chartState.mouse = pane2.mouse;
  chartState.hover = pane2.hover;
  chartState.hoverY = pane2.hoverY;
  drawTarget = { canvas: $('#chart2'), wrap: $('#chart2Body') };
}

function pane2EndSession() {
  if (!pane2.session) return;
  pane2.drawings = chartState.drawings;
  pane2.plans = chartState.plans;
  pane2.pending = chartState.pending;
  pane2.free = chartState.free;
  pane2.textAnchor = chartState.textAnchor;
  pane2.selected = chartState.selected;
  pane2.geo = chartState.geo;
  const saved = pane2.session;
  pane2.session = null;
  drawTarget = null;
  for (const k of PANE2_SWAP_KEYS) chartState[k] = saved[k];
}

function drawPane2() {
  if (!pane2.on || pane2.session) return;
  const canvas = $('#chart2');
  const body = $('#chart2Body');
  if (!canvas || !body) return;
  const w = body.clientWidth;
  const h = body.clientHeight;
  if (w < 20 || h < 20) return;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }
  if (!pane2.rates.length) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '12px Segoe UI, sans-serif';
    ctx.fillStyle = pane2.err
      ? '#ef4444'
      : (getComputedStyle(document.body).getPropertyValue('--muted').trim() || '#8a8a92');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const emptyMsg = pane2.err
      ? 'Veri alınamadı — ' + pane2.err
      : 'Veri yükleniyor… (' + pane2.symbol + ' · ' + pane2.tf + ')';
    ctx.fillText(emptyMsg, w / 2, h / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    return;
  }
  const saved = {};
  pane2SharedSync();
  for (const k of PANE2_SWAP_KEYS) saved[k] = chartState[k];
  chartState.symbol = pane2.symbol;
  chartState.tf = pane2.tf;
  chartState.rates = pane2.rates;
  chartState.digits = pane2.digits;
  chartState.tick = pane2.tick;
  chartState.tickSpread = pane2.tickSpread;
  chartState.tickPoint = pane2.tickPoint;
  chartState.viewCount = pane2.viewCount;
  chartState.viewEnd = pane2.viewEnd;
  chartState.follow = pane2.follow;
  /* 2. grafik ana grafiğin takip offset'ini (lag/gap) devralmaz */
  chartState.rightGap = 0;
  chartState.yScale = pane2.yScale;
  chartState.yOffset = pane2.yOffset;
  chartState.yLock = pane2.yLock;
  chartState.dragging = pane2.dragging;
  chartState.dragMode = pane2.dragMode;
  chartState.hover = pane2.hover;
  chartState.hoverY = pane2.hoverY;
  chartState.mouse = pane2.mouse;
  chartState.pending = pane2.pending;
  chartState.free = pane2.free;
  chartState.textAnchor = pane2.textAnchor;
  chartState.selected = pane2.selected;
  chartState.drawings = pane2.drawings;
  chartState.plans = pane2.plans;
  try {
    drawChart(canvas, body);
  } finally {
    pane2.viewCount = chartState.viewCount;
    pane2.viewEnd = chartState.viewEnd;
    pane2.follow = chartState.follow;
    pane2.yScale = chartState.yScale;
    pane2.yOffset = chartState.yOffset;
    pane2.yLock = chartState.yLock;
    pane2.dragging = chartState.dragging;
    pane2.dragMode = chartState.dragMode;
    pane2.range = chartState.range;
    pane2.geo = chartState.geo;
    pane2.drawings = chartState.drawings;
    pane2.plans = chartState.plans;
    pane2.pending = chartState.pending;
    pane2.free = chartState.free;
    pane2.textAnchor = chartState.textAnchor;
    pane2.selected = chartState.selected;
    for (const k of PANE2_SWAP_KEYS) chartState[k] = saved[k];
  }
}

async function loadRates2() {
  if (!pane2.on || pane2.busy || pane2.session) return;
  pane2.busy = true;
  const [r, tr] = await Promise.all([
    jev.mt5Rates({ symbol: pane2.symbol, timeframe: pane2.tf, count: CHART_COUNT }).catch(() => null),
    jev.mt5Ticks({ symbol: pane2.symbol }).catch(() => null),
  ]);
  pane2.busy = false;
  const tk = tr && tr.ok && tr.data ? tr.data.tick : null;
  if (tk) pane2.tick = tk;
  pane2.tickSpread = spreadFromTickResp(tr);
  pane2.tickPoint = tr && tr.ok && tr.data ? Number(tr.data.point) || 0 : 0;
  if (r && r.ok && r.data && Array.isArray(r.data.rates) && r.data.rates.length) {
    const rows = sanitizeRates(r.data.rates);
    if (rows.length) {
      pane2.rates = rows;
      pane2.err = '';
      pane2ComputeDigits();
    }
  } else if (r && r.error) {
    pane2.err = String(r.error);
  }
  drawPane2();
}

function buildTfRow2() {
  const row = $('#tfRow2');
  if (!row) return;
  row.innerHTML = '';
  for (const tf of TFS) {
    const b = document.createElement('button');
    b.textContent = tf;
    b.className = tf === pane2.tf ? 'active' : '';
    b.addEventListener('click', () => {
      pane2.tf = tf;
      try { localStorage.setItem('jev.pane2.tf', tf); } catch {}
      buildTfRow2();
      pane2.viewCount = 0;
      pane2.follow = true;
      pane2.yLock = null; /* yeni TF: dikey ölçek taze başlar */
      pane2.hover = null;
      pane2.hoverY = null;
      pane2.mouse = null;
      loadRates2();
    });
    row.appendChild(b);
  }
}

function setPane2Symbol(sym) {
  const v = String(sym || '').trim().toUpperCase();
  if (!v) return;
  pane2.symbol = v;
  pane2.tick = null;
  pane2.tickSpread = 0;
  pane2.tickPoint = 0;
  const inp = $('#chartSymbol2');
  if (inp) inp.value = v;
  try { localStorage.setItem('jev.pane2.symbol', v); } catch {}
  pane2.viewCount = 0;
  pane2.follow = true;
  pane2.hover = null;
  pane2.hoverY = null;
  pane2.mouse = null;
  pane2.pending = [];
  pane2.free = null;
  pane2.textAnchor = null;
  pane2.selected = null;
  pane2LoadLocal();
  loadRates2();
}

function applyDual(on) {
  pane2.on = !!on;
  const w2 = $('#chartWrap2');
  if (w2) w2.hidden = !pane2.on;
  const ctrls = $('#pane2Ctrls');
  if (ctrls) ctrls.hidden = !pane2.on;
  const btn = $('#dualBtn');
  if (btn) btn.classList.toggle('active', pane2.on);
  try { localStorage.setItem('jev.dual', pane2.on ? '1' : '0'); } catch {}
  if (pane2.on) {
    if (!pane2.symbol) pane2.symbol = chartState.symbol;
    pane2LoadLocal();
    buildTfRow2();
    const inp = $('#chartSymbol2');
    if (inp) inp.value = pane2.symbol;
    loadRates2();
  }
  setTimeout(() => { drawChart(); drawPane2(); }, 60);
}

/* 2. grafik dikey zoom: imlecin altındaki fiyat sabit kalır */
function zoomYAt2(clientY, factor) {
  const range = pane2.range;
  const canvas = $('#chart2');
  if (!range || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  const padT = 10, padB = 20;
  const plotH = rect.height - padT - padB;
  if (plotH <= 0) return;
  const y = Math.max(padT, Math.min(padT + plotH, clientY - rect.top));
  const span = range.hi - range.lo;
  if (!(span > 0)) return;
  const inv = !!pane2.invert;
  const t = (y - padT) / plotH;
  const p = inv ? range.lo + t * span : range.hi - t * span;
  const f = inv ? (p - range.lo) / span : (range.hi - p) / span;
  if (yLockActive(pane2)) {
    /* kilitli ölçek: imleç altındaki fiyat sabit, kilitli aralık ölçeklenir */
    const newSpan = span / factor;
    const newLo = inv ? p - f * newSpan : p - (1 - f) * newSpan;
    pane2.yLock = { lo: newLo, hi: newLo + newSpan };
    drawPane2();
    return;
  }
  const newScale = Math.max(0.2, Math.min(20, pane2.yScale * factor));
  const newSpan = (range.dataSpan / newScale) * 1.12;
  const newLo = inv ? p - f * newSpan : p - (1 - f) * newSpan;
  const yOff = (newLo - range.mid + newSpan / 2) / newSpan;
  pane2.yScale = newScale;
  pane2.yOffset = Math.max(-5, Math.min(5, yOff));
  drawPane2();
  /* elle dikey zoom sonrası ölçeği kilitle */
  yLockCapture(pane2);
}

/* 2. grafik: serbest gezinme (pan/zoom) + crosshair */
function chartInitCanvas2() {
  const canvas = $('#chart2');
  if (!canvas) return;
  const geom2 = () => {
    const rect = canvas.getBoundingClientRect();
    const padR = 64, padB = 20, padL = 4;
    const plotW = rect.width - padR - padL;
    return { rect, padL, padR, padB, plotW };
  };
  const zone2 = (e) => {
    const { rect, padL, padB, plotW } = geom2();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x >= padL + plotW) return 'price';
    if (y >= rect.height - padB) return 'time';
    return 'plot';
  };
  const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
  const clearHover2 = () => {
    pane2.hover = null;
    pane2.hoverY = null;
    pane2.mouse = null;
  };
  /* 2. grafik sürükleme durumları (plan / alarm / seviye) */
  let p2planDrag = null;
  let p2alertDrag = null;
  let p2lvlDrag = null;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !pane2.on) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { padL, plotW } = geom2();
    const padT = 10;
    const plotH = rect.height - padT - 20;
    const inPlot = mx >= padL && mx <= padL + plotW && my >= padT && my <= padT + plotH;
    const tool = chartState.tool;

    /* oturum açık: ray/fibo/rect ikinci tık bekliyor */
    if (pane2.session) {
      const busy = chartState.pending.length > 0 || !!chartState.free || !!chartState.dragDraw;
      if (!busy) {
        /* bekleyen iş yok: oturumu kapat, normal akışa devam et */
        pane2EndSession();
      } else if (inPlot && tool !== 'cursor' && tool !== 'free' && tool !== 'text') {
        handleToolClick(mx, my);
        if (!chartState.pending.length) {
          pane2EndSession();
          drawChart();
          drawPane2();
        }
        e.preventDefault();
        return;
      } else {
        return;
      }
    }

    /* araç seçili: çizim yap (toolbox 2. grafikte de çalışır) */
    if (tool === 'free') {
      if (!inPlot) return;
      pane2BeginSession();
      const pt = chartPointFromEvent(mx, my);
      if (!pt) { pane2EndSession(); return; }
      chartState.free = [pt];
      chartState.mouse = { x: mx, y: my };
      drawChart();
      e.preventDefault();
      return;
    }
    if (tool === 'seg') {
      if (!inPlot) return;
      pane2BeginSession();
      const pt = chartPointFromEvent(mx, my);
      if (!pt) { pane2EndSession(); return; }
      if (chartState.pending.length) {
        const a = chartState.pending[0];
        const b = e.ctrlKey ? { t: pt.t, p: a.p } : (e.shiftKey ? parallelSegPoint(a, pt) : pt);
        chartState.pending = [];
        chartState.drawings.push({ type: 'seg', points: [a, b], color: chartState.drawColors.seg });
        saveDrawings();
        setDrawTool('cursor');
        pane2EndSession();
        drawChart();
        drawPane2();
        return;
      }
      chartState.segDrag = { a: pt, b: pt };
      chartState.mouse = { x: mx, y: my };
      drawChart();
      e.preventDefault();
      return;  /* oturum açık: kısa çizgi sürükleme */
    }
    if (tool === 'range') {
      if (!inPlot) return;
      pane2BeginSession();
      const pt = chartPointFromEvent(mx, my);
      if (!pt) { pane2EndSession(); return; }
      if (chartState.pending.length) {
        const a = chartState.pending[0];
        chartState.pending = [];
        chartState.drawings.push({ type: 'range', points: [a, pt], color: chartState.drawColors.range || '#ec4899' });
        saveDrawings();
        setDrawTool('cursor');
        pane2EndSession();
        drawChart();
        drawPane2();
        return;
      }
      chartState.segDrag = { a: pt, b: pt, type: 'range' };
      chartState.mouse = { x: mx, y: my };
      drawChart();
      e.preventDefault();
      return;  /* oturum açık: range sürükleme */
    }
    if (tool !== 'cursor') {
      if (!inPlot) return;
      pane2BeginSession();
      handleToolClick(mx, my);
      if (!chartState.pending.length) {
        pane2EndSession();
        drawChart();
        drawPane2();
      } else {
        drawChart();
      }
      e.preventDefault();
      return;
    }

    /* fiyat/zaman ekseni bölgesi: 2. grafikte de hiçbir çizim/kutu isabet testi
       yapılmaz — yalnızca eksen kaydırma/zoom başlar */
    const zone = zone2(e);
    if (zone === 'price' || zone === 'time') {
      yLockCapture(pane2); /* dikey ölçek: eksen sürüklemesinde sabit */
      pane2.dragging = true;
      pane2.dragMode = zone === 'price' ? 'y' : 'x';
      pane2.dragX = e.clientX;
      pane2.dragY = e.clientY;
      canvas.style.cursor = zone === 'price' ? 'ns-resize' : 'ew-resize';
      e.preventDefault();
      return;
    }

    /* imleç: mıknatıs → plan → plan kutusu → alarm → çizim → seviyeler */
    pane2BeginSession();
    const geo = chartState.geo;
    let inPlanBox = false;
    if (geo) {
      const mh = hitPlanMagnet(mx, my, geo);
      if (mh) {
        mh.follow = !mh.follow;
        if (mh.follow && chartState.rates.length) {
          const price = Number(chartState.rates[chartState.rates.length - 1].close);
          const d = price - mh.entry;
          mh.entry = price;
          mh.sl += d;
          mh.tp += d;
        }
        selectedPlanId = mh.id;
        selectedAlertId = '';
        chartState.selected = null;
        savePlans();
        drawChart();
        toast('Giriş fiyatı ' + (mh.follow ? 'kilitlendi — fiyatı takip ediyor' : 'serbest bırakıldı'));
        pane2EndSession();
        drawChart();
        drawPane2();
        e.preventDefault();
        return;
      }
    }
    if (geo) {
      const eb = hitPlanEntryBtn(mx, my, geo);
      if (eb) {
        selectedPlanId = eb.id;
        drawChart();
        enterTradeNow(eb);
        pane2EndSession();
        drawChart();
        drawPane2();
        e.preventDefault();
        return;
      }
    }
    /* seçili kutu kenarından yatay boyutlandırma (seviye sürüklemesinden önce) */
    if (geo) {
      const pe = hitPlanBoxEdge(mx, my, geo);
      if (pe) {
        selectedPlanId = pe.plan.id;
        selectedAlertId = '';
        chartState.selected = null;
        p2planDrag = { id: pe.plan.id, part: pe.edge === 'l' ? 'ex0' : 'ex1' };
        renderAlertSide();
        drawChart();
        e.preventDefault();
        return;
      }
      const be = hitPosBoxEdge(mx, my, geo);
      if (be) {
        const sp = posBoxSpan(be.pos, barIvMs(), posBoxBaseT(be.pos));
        posBoxEdgeDrag = { ticket: be.ticket, edge: be.edge, d0: sp.d0, d1: sp.d1, pos: be.pos };
        selectedPosTicket = be.ticket;
        selectedAlertId = '';
        selectedPlanId = '';
        chartState.selected = null;
        drawChart();
        e.preventDefault();
        return;
      }
    }
    /* açık işlem kutuları en üstte çizilir: SL/TP çizgileri önce denenir */
    if (geo) {
      const lh = hitPositionLevel(mx, my, geo);
      if (lh) {
        p2lvlDrag = { kind: lh.kind, ref: lh.pos, part: lh.part };
        posDragActive = true;
        selectedAlertId = '';
        selectedPlanId = '';
        chartState.selected = null;
        renderAlertSide();
        drawChart();
        e.preventDefault();
        return;  /* oturum açık: seviye sürükleme */
      }
    }
    if (geo) {
      const gl = hitPositionGroupLevel(mx, my, geo);
      if (gl) {
        if (gl.mixed) {
          toast('Karışık yönlü grupta ortak SL/TP uygulanamaz');
          pane2EndSession();
          drawChart();
          drawPane2();
        } else {
          groupLevelDrag = { key: gl.key, part: gl.part, price: gl.price, tickets: gl.cluster.map((m) => String(m.p.ticket)) };
          drawChart();  /* oturum açık kalır: sürükleme */
        }
        e.preventDefault();
        return;
      }
    }
    if (geo) {
      const ph = hitPlan(mx, my, geo);
      if (ph) {
        selectedPlanId = ph.plan.id;
        selectedAlertId = '';
        chartState.selected = null;
        if (ph.part === 'entry') ph.plan.follow = false;
        p2planDrag = { id: ph.plan.id, part: ph.part };
        renderAlertSide();
        drawChart();
        e.preventDefault();
        return;  /* oturum açık: plan sürükleme */
      }
    }
    /* plan kutusunun kapladığı alanda arkadaki alarm/çizimler seçilmez */
    if (geo) {
      const pb = hitPlanBox(mx, my, geo);
      if (pb) {
        inPlanBox = true;
        selectedPlanId = pb.id;
        selectedAlertId = '';
        chartState.selected = null;
        renderAlertSide();
        drawChart();
        pane2EndSession();
        drawPane2();
        return;
      }
    }
    if (!inPlanBox && geo) {
      const ah = hitAlert(mx, my, geo);
      if (ah) {
        selectedAlertId = ah.id;
        chartState.selected = null;
        p2alertDrag = { id: ah.id, startPrice: ah.price, moved: false };
        renderAlertSide();
        drawChart();
        e.preventDefault();
        return;  /* oturum açık: alarm sürükleme */
      }
    }
    if (!inPlanBox) {
      if (selectedPlanId) { selectedPlanId = ''; drawChart(); }
      if (selectedAlertId) { selectedAlertId = ''; renderAlertSide(); }
      /* trend/kısa çizgi uç tutamacı */
      const hep2 = geo ? hitEndpoint(mx, my, geo) : null;
      if (hep2) {
        chartState.selected = hep2.i;
        chartState.dragDraw = {
          i: hep2.i, mode: 'endpoint', ptIdx: hep2.ptIdx, geo,
          orig: JSON.parse(JSON.stringify(chartState.drawings[hep2.i].points || [])),
        };
        drawChart();
        e.preventDefault();
        return;  /* oturum açık: uç sürükleme */
      }
      /* fibo sağ kenarı: genişlik sürükleme */
      const fe2 = geo ? hitFiboEdge(mx, my, geo) : null;
      if (fe2) {
        chartState.selected = fe2.i;
        chartState.dragDraw = {
          i: fe2.i, mode: 'fiboEdge', edgeIdx: fe2.edgeIdx, geo,
          orig: JSON.parse(JSON.stringify(fe2.d.points || [])),
        };
        drawChart();
        e.preventDefault();
        return;  /* oturum açık: genişlik sürükleme */
      }
      const hit = geo ? hitDrawing(mx, my, geo) : -1;
      if (hit >= 0) {
        /* range: taşıma/kısaltma-uzatma yalnız çizim SEÇİLİYKEN; ilk tık sadece seçer */
        const drHit = chartState.drawings[hit];
        if (drHit && drHit.type === 'range' && chartState.selected !== hit) {
          chartState.selected = hit;
          pane2EndSession();
          drawChart();
          drawPane2();
          e.preventDefault();
          return;  /* yalnız seçim */
        }
        chartState.selected = hit;
        chartState.dragDraw = {
          i: hit,
          x: mx,
          y: my,
          geo,
          orig: JSON.parse(JSON.stringify(chartState.drawings[hit].points || [])),
        };
        const drF = chartState.drawings[hit];
        if (drF.type === 'fibo' && drF.points && drF.points.length >= 2) {
          const y0 = geo.yOf(drF.points[0].p);
          const y1 = geo.yOf(drF.points[1].p);
          chartState.dragDraw.mode = 'fibo';
          chartState.dragDraw.fiboAnchor = Math.abs(my - y0) <= Math.abs(my - y1) ? 0 : 1;
        }
        drawChart();
        e.preventDefault();
        return;  /* oturum açık: çizim sürükleme */
      }
      if (chartState.selected != null) {
        chartState.selected = null;
        drawChart();
      }
    }
    /* bekleyen emir SL-TP seviyeleri (sürüklenebilir) */
    if (!inPlanBox && geo) {
      const oh = hitOrderLevel(mx, my, geo);
      if (oh) {
        p2lvlDrag = { kind: oh.kind, ref: oh.ord, part: oh.part };
        posDragActive = true;
        selectedAlertId = '';
        selectedPlanId = '';
        chartState.selected = null;
        renderAlertSide();
        drawChart();
        e.preventDefault();
        return;  /* oturum açık: seviye sürükleme */
      }
    }
    /* plan kutusu modu: gruba tıkladıkça üyeler sırayla (1. işlem, 2. işlem...) */
    if (!inPlanBox && geo && chartState.showPosBox) {
      const hc = hitPositionCluster(mx, my, geo);
      if (hc && hc.cluster.length > 1) {
        if (posGroupCycle.key !== hc.key) posGroupCycle = { key: hc.key, idx: 0 };
        else posGroupCycle.idx = (posGroupCycle.idx + 1) % hc.cluster.length;
        const mi = Math.max(0, Math.min(posGroupCycle.idx, hc.cluster.length - 1));
        selectedPosTicket = String(hc.cluster[mi].p.ticket);
        drawChart();
      } else if (hc && hc.ticket) {
        selectedPosTicket = hc.ticket;
        drawChart();
      } else if (!hc && (posGroupCycle.key || selectedPosTicket)) {
        posGroupCycle.key = '';
        posGroupCycle.idx = 0;
        selectedPosTicket = '';
        drawChart();
      }
    }
    pane2EndSession();

    /* boş alan: kaydır başlat (eksen bölgeleri yukarıda ele alındı) */
    yLockCapture(pane2); /* pan sırasında dikey zoom sabit */
    pane2.dragging = true;
    pane2.dragMode = 'pan';
    pane2.dragX = e.clientX;
    pane2.dragY = e.clientY;
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!pane2.on) return;
    /* oturum: çizim taşıma / serbest çizim / önizleme */
    if (pane2.session) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (groupLevelDrag) {
        const g = chartState.geo;
        if (!g) { groupLevelDrag = null; return; }
        const np = pointFromXY(mx, my, g);
        if (np && np.p > 0) { groupLevelDrag.price = np.p; drawChart(); }
        return;
      }
      if (p2lvlDrag) {
        const g = chartState.geo;
        if (!g) { p2lvlDrag = null; posDragActive = false; return; }
        const np = pointFromXY(mx, my, g);
        if (np && np.p > 0) {
          p2lvlDrag.ref[p2lvlDrag.part] = np.p;
          drawChart();
        }
        return;
      }
      if (posBoxEdgeDrag) {
        const g = chartState.geo;
        const p = (chartState.positions || []).find((x) => String(x.ticket) === posBoxEdgeDrag.ticket);
        if (!g || !p) { posBoxEdgeDrag = null; return; }
        const np = pointFromXY(mx, my, g);
        if (!np) return;
        const iv = barIvMs();
        const d = (np.t - posBoxBaseT(p)) / iv;
        if (posBoxEdgeDrag.edge === 'l') posBoxEdgeDrag.d0 = Math.min(d, posBoxEdgeDrag.d1 - POS_BOX_MIN_BARS);
        else posBoxEdgeDrag.d1 = Math.max(d, posBoxEdgeDrag.d0 + POS_BOX_MIN_BARS);
        drawChart();
        return;
      }
      if (p2planDrag) {
        const g = chartState.geo;
        const p = (chartState.plans || []).find((x) => x.id === p2planDrag.id);
        if (!g || !p) { p2planDrag = null; return; }
        const np = pointFromXY(mx, my, g);
        if (np && np.p > 0) {
          if (p2planDrag.part === 'ex0' || p2planDrag.part === 'ex1') {
            applyPlanEdgeDrag(p, p2planDrag.part === 'ex0' ? 'l' : 'r', np.t);
          } else if (p2planDrag.part === 'entry') {
            const d = np.p - p.entry;
            p.entry = np.p;
            p.sl += d;
            p.tp += d;
          } else if (p2planDrag.part === 'sl') {
            p.sl = np.p;
            applyPlanRR(p);
          } else {
            p.tp = np.p;
            if (Number(p.rr) > 0) {
              const risk = Math.abs(p.entry - p.sl);
              if (risk > 0) p.rr = Math.max(0.1, Math.min(100, Math.abs(p.tp - p.entry) / risk));
            }
          }
          drawChart();
        }
        return;
      }
      if (p2alertDrag) {
        const g = chartState.geo;
        const a = (chartState.alerts || []).find((x) => x.id === p2alertDrag.id);
        if (!g || !a) { p2alertDrag = null; return; }
        const np = pointFromXY(mx, my, g);
        if (np && np.p > 0) {
          a.price = np.p;
          a.last = null;
          p2alertDrag.moved = true;
          drawChart();
        }
        return;
      }
      if (chartState.dragDraw) {
        const dd = chartState.dragDraw;
        if (dd.mode === 'endpoint') {
          const np = pointFromXY(mx, my, dd.geo);
          const drE = chartState.drawings[dd.i];
          if (np && drE && drE.points && drE.points[dd.ptIdx]) {
            drE.points[dd.ptIdx] = e.shiftKey ? { t: np.t, p: dd.orig[dd.ptIdx].p } : np;
            drawChart();
          }
          return;
        }
        if (dd.mode === 'fiboEdge') {
          /* fibo genişlik: sağ kenarın zamanı değişir */
          const np = pointFromXY(mx, my, dd.geo);
          const drE = chartState.drawings[dd.i];
          if (np && drE && drE.points && drE.points[dd.edgeIdx]) {
            drE.points[dd.edgeIdx].t = np.t;
            drawChart();
          }
          return;
        }
        if (dd.mode === 'fibo') {
          const np = pointFromXY(mx, my, dd.geo);
          const drF = chartState.drawings[dd.i];
          if (np && drF && drF.points && drF.points[dd.fiboAnchor]) {
            drF.points[dd.fiboAnchor].p = np.p;
            drawChart();
          }
          return;
        }
        const dx = mx - dd.x;
        const dy = my - dd.y;
        const g = dd.geo;
        const next = [];
        for (const P of dd.orig) {
          const np = pointFromXY(g.xOf(idxFromTime(P.t)) + dx, g.yOf(P.p) + dy, g);
          next.push(np || P);
        }
        const dr = chartState.drawings[dd.i];
        if (dr) dr.points = next;
        drawChart();
        return;
      }
      if (chartState.segDrag) {
        const pt = chartPointFromEvent(mx, my);
        if (pt) {
          const a0 = chartState.segDrag.a;
          chartState.segDrag.b = chartState.segDrag.type === 'range'
            ? pt
            : (e.ctrlKey ? { t: pt.t, p: a0.p } : (e.shiftKey ? parallelSegPoint(a0, pt) : pt));
          chartState.mouse = { x: mx, y: my };
          drawChart();
        }
        return;
      }
      if (chartState.free) {
        const pt = chartPointFromEvent(mx, my);
        if (pt) {
          chartState.mouse = { x: mx, y: my };
          const last = chartState.free[chartState.free.length - 1];
          if ((!last || last.t !== pt.t || last.p !== pt.p) && chartState.free.length < 600) {
            chartState.free.push(pt);
          }
          drawChart();
        }
        return;
      }
      if (chartState.pending.length) {
        chartState.mouse = { x: mx, y: my };
        drawChart();
      }
      return;
    }
    if (!pane2.dragging) return;
    if (e.buttons === 0) { pane2.dragging = false; canvas.style.cursor = 'crosshair'; return; }
    const n = pane2.rates.length;
    if (!n) return;
    if (pane2.dragMode === 'y') {
      const dy = e.clientY - pane2.dragY;
      pane2.dragY = e.clientY;
      zoomYAt2(e.clientY, Math.exp(-dy / 150));
      return;
    }
    /* tarih şeridinden yatay zoom: imlecin altındaki mum sabit kalır */
    if (pane2.dragMode === 'x') {
      const { rect, padL, plotW } = geom2();
      if (plotW <= 0) return;
      const dx = e.clientX - pane2.dragX;
      pane2.dragX = e.clientX;
      const vc = pane2.viewCount || n;
      const step = plotW / vc;
      const start = pane2.viewEnd - vc + 1;
      const xIn = clampN(e.clientX - rect.left - padL, 0, plotW);
      const idxAt = start + xIn / step;
      const next = clampN(Math.round(vc * Math.exp(-dx / 150)), 20, n);
      if (next !== vc) {
        pane2.viewCount = next;
        pane2.follow = false;
        const startNew = idxAt - xIn / (plotW / next);
        pane2.viewEnd = clampN(Math.round(startNew + next - 1), next - 1, n - 1 + Math.round(next * 0.8));
      }
      drawPane2();
      return;
    }
    const { plotW } = geom2();
    if (plotW <= 0) return;
    const step = plotW / (pane2.viewCount || n);
    const dx = e.clientX - pane2.dragX;
    const dy = e.clientY - pane2.dragY;
    pane2.dragX = e.clientX;
    pane2.dragY = e.clientY;
    pane2.follow = false;
    pane2.viewEnd = Math.max(
      pane2.viewCount - 1,
      Math.min(n - 1 + Math.round((pane2.viewCount || n) * 0.8), pane2.viewEnd - dx / step)
    );
    if (yLockActive(pane2)) {
      /* kilitli: dikey kaydırma kilitli aralığı öteler */
      const gr = pane2.range || { lo: pane2.yLock.lo, hi: pane2.yLock.hi };
      const dyN = pane2.invert ? -dy : dy;
      const shift = dyN * (gr.hi - gr.lo) / Math.max(50, canvas.clientHeight - 30);
      pane2.yLock = { lo: pane2.yLock.lo + shift, hi: pane2.yLock.hi + shift };
    } else {
      pane2.yOffset += (pane2.invert ? -dy : dy) / Math.max(50, canvas.clientHeight - 30);
      pane2.yOffset = Math.max(-3, Math.min(3, pane2.yOffset));
    }
    drawPane2();
  });

  window.addEventListener('mouseup', () => {
    if (!pane2.on) return;
    /* oturum: çizimi bitir/kaydet */
    if (pane2.session) {
      if (groupLevelDrag) {
        const drag = groupLevelDrag;
        groupLevelDrag = null;
        applyGroupLevelDrag(drag);
        pane2EndSession();
        drawChart();
        drawPane2();
        return;
      }
      if (p2lvlDrag) {
        const { kind, ref, part } = p2lvlDrag;
        p2lvlDrag = null;
        posDragActive = false;
        const sl = Number(ref.sl) || 0;
        const tp = Number(ref.tp) || 0;
        const ticket = ref.ticket;
        mt5Begin();
        (async () => {
          try {
            let res;
            if (kind === 'pos') res = await jev.mt5Modify({ ticket, sl, tp }).catch(() => null);
            else res = await jev.mt5OrderModify({ ticket, sl, tp }).catch(() => null);
            if (res && res.ok) toast('Seviye güncellendi #' + ticket + ' · SL ' + (sl > 0 ? nf(sl, decOf(sl)) : '—') + ' · TP ' + (tp > 0 ? nf(tp, decOf(tp)) : '—'));
            else toast('Seviye güncellenemedi: ' + ((res && res.error) || '?'));
            if (kind === 'pos') refreshPositions();
            else refreshOrders();
            drawChart();
          } finally { mt5End(); }
        })();
        pane2EndSession();
        drawChart();
        drawPane2();
        return;
      }
      if (posBoxEdgeDrag) {
        const d = posBoxEdgeDrag;
        posBoxEdgeDrag = null;
        const p = (chartState.positions || []).find((x) => String(x.ticket) === d.ticket);
        if (p) {
          posBoxWSet(p, d.d0, d.d1);
          toast('Açık işlem kutusu genişliği ' + Math.round(d.d1 - d.d0) + ' mum');
        }
        drawChart();
        pane2EndSession();
        drawPane2();
        return;
      }
      if (p2planDrag) {
        const p = (chartState.plans || []).find((x) => x.id === p2planDrag.id);
        const wasEdge = p2planDrag.part === 'ex0' || p2planDrag.part === 'ex1';
        p2planDrag = null;
        if (p) {
          savePlans();
          drawChart();
          const bars = Math.max(0, Math.round((Number(p.t1) - Number(p.t0)) / barIvMs()));
          toast(wasEdge
            ? (p.side === 'long' ? 'LONG' : 'SHORT') + ' plan kutusu genişliği ' + bars + ' mum'
            : (p.side === 'long' ? 'LONG' : 'SHORT') + ' plan güncellendi · ' + planRR(p).toFixed(1) + 'R');
        }
        pane2EndSession();
        drawChart();
        drawPane2();
        return;
      }
      if (p2alertDrag) {
        const a = (chartState.alerts || []).find((x) => x.id === p2alertDrag.id);
        const moved = p2alertDrag.moved;
        p2alertDrag = null;
        if (a && moved) {
          if (a.drawingId) { a.drawingId = ''; a.edge = ''; }
          a.active = true;
          a.triggeredAt = 0;
          a.cooldownBar = 0;
          a.last = null;
          toast('Alarm taşındı: ' + a.symbol + ' ' + nf(a.price, decOf(a.price)));
        }
        saveAlerts();
        renderAlertSide();
        drawChart();
        pane2EndSession();
        drawPane2();
        return;
      }
      if (chartState.dragDraw) {
        const d = chartState.drawings[chartState.dragDraw.i];
        chartState.dragDraw = null;
        saveDrawings();
        if (d) syncAlertPriceForDrawing(d);
        pane2EndSession();
        drawChart();
        drawPane2();
        return;
      }
      if (chartState.segDrag) {
        const sd = chartState.segDrag;
        chartState.segDrag = null;
        let tiny2 = false;
        try {
          const gg2 = pane2.geo;
          if (sd && gg2) {
            tiny2 = Math.abs(gg2.xOf(idxFromTime(sd.a.t)) - gg2.xOf(idxFromTime(sd.b.t))) < 4 &&
              Math.abs(gg2.yOf(sd.a.p) - gg2.yOf(sd.b.p)) < 4;
          }
        } catch {}
        if (sd && !tiny2 && (sd.a.t !== sd.b.t || sd.a.p !== sd.b.p)) {
          const isRange = sd.type === 'range';
          chartState.drawings.push({
            type: isRange ? 'range' : 'seg',
            points: [sd.a, sd.b],
            color: isRange ? (chartState.drawColors.range || '#ec4899') : chartState.drawColors.seg,
          });
          saveDrawings();
          setDrawTool('cursor');
        } else if (sd) {
          chartState.pending = [sd.a];
          drawChart();
        }
        pane2EndSession();
        drawChart();
        drawPane2();
        return;
      }
      if (chartState.free) {
        const pts = chartState.free;
        chartState.free = null;
        if (pts && pts.length >= 2) {
          chartState.drawings.push({ type: 'free', points: pts, color: chartState.drawColors.free });
          saveDrawings();
        }
        setDrawTool('cursor');
        pane2EndSession();
        drawChart();
        drawPane2();
        return;
      }
      /* ray/fibo/rect ikinci tık bekliyor: oturum açık kalır */
      if (!chartState.pending.length) {
        pane2EndSession();
        drawChart();
        drawPane2();
      }
      return;
    }
    if (!pane2.dragging) return;
    pane2.dragging = false;
    canvas.style.cursor = 'crosshair';
  });

  canvas.addEventListener('wheel', (e) => {
    if (!pane2.on) return;
    e.preventDefault();
    const zone = zone2(e);
    if (e.shiftKey || zone === 'price') {
      zoomYAt2(e.clientY, e.deltaY < 0 ? 1.12 : 0.89);
      return;
    }
    const { rect, padL, plotW } = geom2();
    const n = pane2.rates.length;
    if (!n || plotW <= 0) return;
    const vc = pane2.viewCount || n;
    const step = plotW / vc;
    const start = pane2.viewEnd - vc + 1;
    const x = e.clientX - rect.left;
    const idxAt = start + (x - padL) / step;
    const next = clampN(Math.round(vc * (e.deltaY < 0 ? 0.85 : 1.18)), 20, n);
    if (next === vc) return;
    pane2.viewCount = next;
    pane2.yLock = null; /* tekerlek x-zoom: dikey ölçek yeniden otursun */
    pane2.follow = false;
    const startNew = idxAt - (x - padL) / (plotW / next);
    pane2.viewEnd = clampN(Math.round(startNew + next - 1), next - 1, n - 1 + Math.round(next * 0.8));
    drawPane2();
  }, { passive: false });

  /* çift tık: çizim üzerindeyse etiket/alarm düzenle, boş alanda görünümü sıfırla */
  canvas.addEventListener('dblclick', (e) => {
    if (!pane2.on) return;
    /* zigzag: çift tık = çizimi bitir */
    if (chartState.tool === 'zigzag' && chartState.pending.length >= 2) {
      finishZigzag();
      return;
    }
    const geo = pane2.geo;
    /* eksen bölgesinde çizim isabet testi yapılmaz (çizim düzenleme açılmaz) */
    if (geo && zone2(e) === 'plot') {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      pane2BeginSession();
      const hit = hitDrawing(mx, my, geo);
      if (hit >= 0) {
        chartState.selected = hit;
        labelEditorOpen(hit);
        pane2EndSession();
        drawPane2();
        return;
      }
      pane2EndSession();
    }
    pane2.follow = true;
    pane2.viewCount = 0;
    pane2.yScale = 1;
    pane2.yOffset = 0;
    pane2.yLock = null;
    drawPane2();
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!pane2.on || pane2.dragging || pane2.session) return;
    const zone = zone2(e);
    let cur = zone === 'price' ? 'ns-resize' : zone === 'time' ? 'ew-resize' : 'crosshair';
    if (zone === 'plot') {
      const g2 = pane2.geo;
      if (g2) {
        const rect = canvas.getBoundingClientRect();
        const mx2 = e.clientX - rect.left;
        const my2 = e.clientY - rect.top;
        /* isabet testleri geçerli sembole göre: sembolü geçici olarak 2. grafiğe al */
        const savedSym2 = chartState.symbol;
        chartState.symbol = pane2.symbol;
        const mz = hitPlanMagnet(mx2, my2, g2);
        const ebtn = hitPlanEntryBtn(mx2, my2, g2);
        const pz = hitPlan(mx2, my2, g2);
        const pbox = hitPlanBox(mx2, my2, g2);
        const az = hitAlert(mx2, my2, g2);
        const lz = hitPositionLevel(mx2, my2, g2) || hitOrderLevel(mx2, my2, g2);
        const gpx = hitPositionGroupLevel(mx2, my2, g2);
        const pbx = hitPositionCluster(mx2, my2, g2);
        const fedge = hitFiboEdge(mx2, my2, g2);
        const hend = hitEndpoint(mx2, my2, g2);
        const pex = hitPlanBoxEdge(mx2, my2, g2);
        const pex2 = hitPosBoxEdge(mx2, my2, g2);
        chartState.symbol = savedSym2;
        if (mz || ebtn) cur = 'pointer';
        else if (pex || pex2) cur = 'ew-resize';
        else if (pz || lz || gpx) cur = 'ns-resize';
        else if (fedge) cur = 'ew-resize';
        else if (hend) cur = 'move';
        else if (pbox) cur = 'pointer';
        else if (az) cur = 'ns-resize';
        else if (pbx) cur = 'pointer';
        else if (hitDrawing(mx2, my2, g2) >= 0) cur = 'pointer';
      }
    }
    canvas.style.cursor = cur;
    /* kısa çizgi: tıkla-tıkla akışında Ctrl/Shift durumu önizlemede kullanılır */
    if (chartState.tool === 'seg' && chartState.pending.length) {
      chartState.segMods = { ctrl: e.ctrlKey, shift: e.shiftKey };
    }
    if (zone !== 'plot') {
      if (pane2.hover != null || pane2.mouse) { clearHover2(); drawPane2(); }
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const { padL, plotW } = geom2();
    const n = pane2.rates.length;
    if (!n || plotW <= 0) return;
    const vc = pane2.viewCount || n;
    const step = plotW / vc;
    const start = pane2.viewEnd - vc + 1;
    const x = e.clientX - rect.left;
    const idx = Math.round(start + (x - padL) / step - 0.5);
    pane2.hover = Math.max(start, Math.min(n - 1, idx));
    pane2.hoverY = e.clientY - rect.top;
    pane2.mouse = { x, y: pane2.hoverY };
    drawPane2();
  });

  canvas.addEventListener('mouseleave', () => {
    if (pane2.hover == null && !pane2.mouse) return;
    clearHover2();
    drawPane2();
  });

  /* oturum takılı kalmasın: pencere odağı gidince temizle */
  window.addEventListener('blur', () => {
    if (!pane2.session) return;
    if (chartState.dragDraw) {
      const d = chartState.drawings[chartState.dragDraw.i];
      chartState.dragDraw = null;
      saveDrawings();
      if (d) syncAlertPriceForDrawing(d);
    }
    chartState.free = null;
    p2planDrag = null;
    p2alertDrag = null;
    if (p2lvlDrag) { p2lvlDrag = null; posDragActive = false; }
    groupLevelDrag = null;
    pane2EndSession();
    drawChart();
    drawPane2();
  });
}

/* geçmiş mumları parça parça yükle (sola kaydırınca otomatik, toplu çekim) */
let backfillBusy = false;
let backfillLastAt = 0;
const HISTORY_MAX = 20000;
async function backfillHistory() {
  if (backfillBusy || pane2.session) return;
  if (!chartState.rates.length || chartState.rates.length >= HISTORY_MAX) return;
  /* aynı seri için en fazla 20 sn'de bir denenir: boşa istek atılmaz */
  if (Date.now() - backfillLastAt < 20000) return;
  backfillLastAt = Date.now();
  backfillBusy = true;
  const seq = exSeq;
  const reqSym = chartState.symbol;
  const reqTf = chartState.tf;
  try {
    let added = 0;
    /* tek tetiklemede hedefe kadar parça parça çek: zoom-out beklemesin */
    const TARGET = 2000;
    for (let i = 0; i < 25 && added < TARGET; i++) {
      const rates = chartState.rates;
      if (!rates.length || rates.length >= HISTORY_MAX) break;
      const before = Number(rates[0].time) || 0;
      if (!(before > 0)) break;
      const r = await jev.mt5Rates({ symbol: reqSym, timeframe: reqTf, count: 1000, before_ts: before }).catch(() => null);
      if (seq !== exSeq) return;
      /* sembol/TF değişti: eski serinin parçaları yeni seriye eklenmesin */
      if (chartState.symbol !== reqSym || chartState.tf !== reqTf) return;
      if (!r || !r.ok || !r.data) break;
      const old = sanitizeRates(r.data.rates).filter((x) => Number(x.time) < before);
      if (!old.length) break;
      /* eski parça ile yeni seri arasında zaman boşluğu varsa birleştirme:
         araya eksik mum koyup grafikte boşluk oluşturmaktansa kes */
      const merged = old.concat(chartState.rates);
      const trimmed = merged.slice(-HISTORY_MAX);
      const droppedFront = merged.length - trimmed.length;
      chartState.rates = trimmed;
      /* görünüm aynı mumlarda kalsın: eklenen/atılan kadar kaydır */
      chartState.viewEnd = Number(chartState.viewEnd) + old.length - droppedFront;
      added += old.length;
      /* borsa limitlerine saygı: parçalar arası kısa bekleme */
      if (i < 24 && added < TARGET) await new Promise((res) => setTimeout(res, 80));
    }
    if (added > 0) {
      /* TF geçişi "aynı zaman aralığı" istediği seri kısa geldiği için karşılan-
        madıysa: geçmiş geldi, istenen mum sayısına bir kez yükselt */
      if (tfCarryWish > chartState.viewCount && chartState.rates.length > chartState.viewCount) {
        chartState.viewCount = Math.min(tfCarryWish, chartState.rates.length);
        if (chartState.viewCount >= tfCarryWish || chartState.rates.length >= HISTORY_MAX) tfCarryWish = 0;
      }
      termLogAdd('Geçmiş yüklendi · +' + added + ' mum (toplam ' + chartState.rates.length + ')', 'sys');
      ratesCachePut(reqSym, reqTf, exName, chartState.rates);
      drawChart();
    }
  } finally {
    backfillBusy = false;
  }
}

/* zaman ekseni zoom (butonlar): görünümün ortası sabit kalır */
function zoomTime(factor) {
  const n = chartState.rates.length;
  if (!n) return;
  const vc = Math.max(20, Math.min(Math.round(chartState.viewCount) || Math.min(140, n), n));
  const next = Math.max(20, Math.min(n, Math.round(vc * factor)));
  if (next === vc) return;
  const center = Number(chartState.viewEnd) - vc / 2;
  chartState.viewCount = next;
  chartState.yLock = null; /* zoom butonu: dikey ölçek yeniden otursun */
  tfCarryWish = 0;
  chartState.follow = false;
  chartState.viewEnd = Math.max(next - 1, Math.min(n - 1 + Math.round(next * 0.8), Math.round(center + next / 2)));
  drawChart();
}

function drawChart(targetCanvas, targetWrap, opts) {
  const canvas = targetCanvas || (drawTarget && drawTarget.canvas) || $('#chart');
  const wrap = targetWrap || (drawTarget && drawTarget.wrap) || $('#chartWrap');
  if (!canvas || !wrap) return;
  /* snapshot: arka plan TF görüntüsü — başlıktaki spread/OTO gizlenir */
  const snapShot = !!(opts && opts.snapshot);
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (w < 20 || h < 20) return;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cs = getComputedStyle(document.body);
  const colText = cs.getPropertyValue('--text').trim() || '#e8e8ea';
  const colMuted = cs.getPropertyValue('--muted').trim() || '#8a8a92';
  const colBorder = cs.getPropertyValue('--border').trim() || '#2c2c30';
  const colUp = chartState.colors.up || '#22c55e';
  const colDown = chartState.colors.down || '#ef4444';
  if (chartState.colors.bgOn && chartState.colors.bg) {
    ctx.fillStyle = chartState.colors.bg;
    ctx.fillRect(0, 0, w, h);
  } else if (snapShot) {
    /* arka plan görüntüsü: saydam kalmasın (PNG'de okunur olsun) */
    ctx.fillStyle = cs.getPropertyValue('--bg').trim() || '#0d0d0f';
    ctx.fillRect(0, 0, w, h);
  }

  const rates = chartState.rates;
  const padR = 64, padB = 20, padT = 10, padL = 4;
  if (!rates.length) return;

  const plotW = w - padR - padL;
  const plotH = h - padT - padB;
  if (plotW < 30 || plotH < 30) return;

  const n = rates.length;
  /* görünüm penceresi (serbest gezinme + sağda boş alan) */
  let vc = Math.max(20, Math.min(Math.round(chartState.viewCount) || Math.min(140, n), n));
  chartState.viewCount = vc;
  if (chartState.follow) chartState.viewEnd = n - 1 + Math.round(vc * (Number(chartState.rightGap) || 0));
  /* son mum sağ kenara yapışmasın: en fazla ekranın %80'i kadar sağa boşluk */
  const maxVe = n - 1 + Math.round(vc * 0.8);
  const ve = Math.max(vc - 1, Math.min(Math.round(chartState.viewEnd), maxVe));
  chartState.viewEnd = ve;
  const start = ve - vc + 1;
  const lastIdx = Math.min(ve, n - 1);
  const step = plotW / vc;

  let lo = Infinity, hi = -Infinity;
  for (let i = Math.max(start, 0); i <= lastIdx; i++) {
    const r = rates[i];
    if (r.low < lo) lo = r.low;
    if (r.high > hi) hi = r.high;
  }
  /* NOT: açık pozisyon/emir/plan seviyeleri ölçeğe DAHİL EDİLMEZ —
     aksi halde pozisyon kapanınca ya da SL/TP değişince grafik yerleşimi oynar */
  if (!isFinite(lo) || !isFinite(hi)) return;
  const dataSpan = (hi - lo) || Math.abs(hi) * 0.001 || 1;
  const dataMid = (hi + lo) / 2;
  /* dikey ölçek kilidi: pan/tarih-sıkıştırma sırasında zoom sabit.
     Canlı fiyat aralığın dışına çıktıysa kilit kendiliğinden açılır
     (sürüklemeler sırasında değil — o zaman lock zaten bilinçli). */
  if (yLockActive(chartState) && !chartState.dragging) {
    const L = chartState.yLock;
    const lastP = Number(rates[n - 1].close);
    if (lastP > 0 && (lastP > L.hi || lastP < L.lo)) chartState.yLock = null;
  }
  let visSpan, visMid;
  if (yLockActive(chartState)) {
    /* KİLİTLİ: mutlak aralık — yOffset devre dışı (kilit zaten çizilen
       aralığı tutar; dikey pan kilit aralığını doğrudan öteler) */
    visSpan = chartState.yLock.hi - chartState.yLock.lo;
    visMid = (chartState.yLock.lo + chartState.yLock.hi) / 2;
    lo = visMid - visSpan / 2;
    hi = lo + visSpan;
  } else {
    /* görünür aralık: veri aralığı / dikey zoom + %6 kenar payı (1.12) */
    visSpan = (dataSpan / chartState.yScale) * 1.12;
    visMid = dataMid;
    lo = visMid - visSpan / 2 + chartState.yOffset * visSpan;
    hi = lo + visSpan;
  }
  chartState.range = { lo, hi, mid: dataMid, dataSpan, invert: !!chartState.invert };
  /* ters grafik: fiyat ekseni çevrilir (düşüş yukarı, yükseliş aşağı) */
  const invChart = !!chartState.invert;
  const yOf = (p) => invChart
    ? padT + ((p - lo) / (hi - lo)) * plotH
    : padT + ((hi - p) / (hi - lo)) * plotH;
  const xOf = (i) => padL + (i - start) * step + step / 2;

  const bodyW = Math.max(1, Math.min(step * 0.72, 16));

  ctx.font = '11px Segoe UI, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  /* yatay izgara + fiyat ekseni */
  const gridRows = 5;
  for (let i = 0; i <= gridRows; i++) {
    const p = lo + ((hi - lo) * i) / gridRows;
    const y = yOf(p);
    ctx.strokeStyle = colBorder;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = colMuted;
    ctx.fillText(fmtPrice(p), padL + plotW + 8, y);
  }
  /* grafik ile sağdaki fiyat etiketleri arasında ince ayraç çizgisi */
  ctx.strokeStyle = colBorder;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(padL + plotW) + 0.5, padT);
  ctx.lineTo(Math.round(padL + plotW) + 0.5, padT + plotH);
  ctx.stroke();
  ctx.globalAlpha = 1;

  /* zaman ekseni: etiketler çakışmadan olabildiğince sık yerleştirilir */
  ctx.textAlign = 'center';
  const sampleLbl = tfTimeLabel(rates[lastIdx].time, chartState.tf);
  const lblW = ctx.measureText(sampleLbl).width + 16;
  const maxLabels = Math.max(2, Math.floor(plotW / lblW));
  const tEvery = Math.max(1, Math.ceil(vc / maxLabels));
  for (let i = lastIdx; i >= start; i -= tEvery) {
    const x = xOf(i);
    ctx.fillStyle = colMuted;
    ctx.fillText(tfTimeLabel(rates[i].time, chartState.tf), x, padT + plotH + 11);
  }

  /* mumlar */
  for (let i = Math.max(start, 0); i <= lastIdx; i++) {
    const r = rates[i];
    const x = xOf(i);
    const up = r.close >= r.open;
    const col = up ? colUp : colDown;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, yOf(r.high));
    ctx.lineTo(Math.round(x) + 0.5, yOf(r.low));
    ctx.stroke();
    const yo = yOf(r.open);
    const yc = yOf(r.close);
    const top = Math.min(yo, yc);
    const bh = Math.max(1, Math.abs(yc - yo));
    ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
  }

  /* hacim (grafiğin alt %18'i, mumlarla aynı hizada) */
  if (chartState.showVolume) {
    const volH = plotH * 0.18;
    const volBase = padT + plotH;
    let maxVol = 0;
    for (let i = Math.max(start, 0); i <= lastIdx; i++) {
      const v = Number(rates[i].volume || rates[i].tick_volume || 0);
      if (v > maxVol) maxVol = v;
    }
    if (maxVol > 0) {
      const cs2 = chartState.colors || {};
      const vUp = cs2.volUp || '#22c55e';
      const vDown = cs2.volDown || '#ef4444';
      for (let i = Math.max(start, 0); i <= lastIdx; i++) {
        const r = rates[i];
        const v = Number(r.volume || r.tick_volume || 0);
        if (!(v > 0)) continue;
        const x = xOf(i);
        const hh = Math.max(1, (v / maxVol) * volH);
        const up = r.close >= r.open;
        ctx.fillStyle = hexA(up ? vUp : vDown, 0.45);
        ctx.fillRect(x - bodyW / 2, volBase - hh, bodyW, hh);
      }
    }
  }

  /* açık pozisyon seviyeleri: giriş / SL / TP */
  const drawLevel = (price, color, label, noLabel) => {
    const num = Number(price);
    if (!(num > 0)) return;
    const y = yOf(num);
    if (y < padT - 1 || y > padT + plotH + 1) return;
    const csL = chartState.colors || {};
    const lvlA = Math.max(0.05, Math.min(1, (Number(csL.lvlAlpha) >= 10 ? Number(csL.lvlAlpha) : 85) / 100));
    const lvlW = Math.max(1, Math.min(5, Math.round(Number(csL.lvlWidth) || 1)));
    ctx.strokeStyle = color;
    ctx.globalAlpha = lvlA;
    ctx.lineWidth = lvlW;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    /* yazılar kapalıysa etiket çizilmez (çizgi kalır) */
    if (noLabel) return;
    ctx.font = '600 10px Segoe UI, sans-serif';
    const lw = ctx.measureText(label).width + 10;
    ctx.fillStyle = color;
    roundRectPath(ctx, padL + 6, y - 8, lw, 16, 4);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(label, padL + 11, y);
  };
  /* açık pozisyon seviyeleri (ölçeği etkilemez, yalnız çizilir) */
  const symPositions = (chartState.positions || []).filter(
    (p) => String(p.symbol || '').toUpperCase() === chartState.symbol
  );
  /* plan kutusu modu: açık işlemler plan kutusu görünümünde çizilir
     kutu modunda giriş/SL/TP seviye çizgileri gizlenir; kutu kapanınca geri gelir
     plan (long/short) açıkken işlem kutuları ve seviye çizgileri gizlenir — yalnız plan görünür */
  const hasActivePlan = (chartState.plans || []).some((pl) => pl.symbol === chartState.symbol);
  const boxesOn = chartState.showPosBox && !hasActivePlan && symPositions.length > 0;
  for (const p of symPositions) {
    if (!chartState.showLevels || boxesOn || hasActivePlan) break;
    const vol = Number(p.volume) || 0;
    const lc = chartState.colors || {};
    const noPosText = chartState.showPosText === false;
    drawLevel(p.price_open, lc.lvlEntry || '#3b82f6', fmtPrice(p.price_open) + (vol ? ' · ' + vol : ''), noPosText);
    drawLevel(p.sl, lc.lvlSl || '#ef4444', 'SL ' + fmtPrice(p.sl) + potentialTxt(p, p.sl, false) + trailTagFor(p), noPosText);
    drawLevel(p.tp, lc.lvlTp || '#22c55e', 'TP ' + fmtPrice(p.tp) + potentialTxt(p, p.tp, false) + posRrTxt(p), noPosText);
  }

  /* AVG: açık işlemlerin hacim ağırlıklı ortalama giriş çizgisi.
     Long+short karışık olsa da TÜM pozisyonların ortalaması alınır; kırmızı düz çizgi.
     Göster/gizle: grafik başlığındaki AVG düğmesi (varsayılan açık). */
  if (chartState.showAvg !== false && symPositions.length) {
    let aSum = 0, aW = 0, lCnt = 0, sCnt = 0;
    for (const p of symPositions) {
      const px = Number(p.price_open) || 0;
      if (px > 0) {
        const w = Number(p.volume) > 0 ? Number(p.volume) : 1;
        aSum += px * w;
        aW += w;
      }
      if (Number(p.type) === 1 || String(p.side || '').toLowerCase() === 'sell') sCnt++; else lCnt++;
    }
    const avgPrice = aW > 0 ? aSum / aW : 0;
    const yAvg = avgPrice > 0 ? yOf(avgPrice) : -1;
    if (yAvg >= padT - 1 && yAvg <= padT + plotH + 1) {
      ctx.strokeStyle = '#ef4444';
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(padL, yAvg);
      ctx.lineTo(padL + plotW, yAvg);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      const avgLbl = 'AVG ' + fmtPrice(avgPrice) + (symPositions.length > 1
        ? ' · ' + symPositions.length + ' işlem' + (lCnt && sCnt ? ' (' + lCnt + 'L/' + sCnt + 'S)' : '')
        : '');
      ctx.font = '700 10px Segoe UI, sans-serif';
      const aw2 = ctx.measureText(avgLbl).width + 10;
      ctx.fillStyle = '#ef4444';
      roundRectPath(ctx, padL + 6, yAvg - 8, aw2, 16, 4);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(avgLbl, padL + 11, yAvg);
      ctx.textBaseline = 'alphabetic';
    }
  }

  /* bekleyen emir seviyeleri: emir fiyatı / SL / TP */
  if (chartState.showOrdLevels) {
    const ordTypes = {
      2: 'BUY LIMIT', 3: 'SELL LIMIT', 4: 'BUY STOP', 5: 'SELL STOP',
    };
    const lc2 = chartState.colors || {};
    for (const o of (chartState.orders || [])) {
      if (String(o.symbol || '').toUpperCase() !== chartState.symbol) continue;
      const vol = Number(o.volume_current || o.volume_initial || 0);
      const tname = ordTypes[Number(o.type)] || 'EMİR';
      drawLevel(o.price_open, lc2.lvlPending || '#f59e0b', fmtPrice(o.price_open) + (vol ? ' · ' + vol : '') + ' · ' + tname);
      drawLevel(o.sl, lc2.lvlSl || '#ef4444', 'SL ' + fmtPrice(o.sl) + potentialTxt(o, o.sl, true));
      drawLevel(o.tp, lc2.lvlTp || '#22c55e', 'TP ' + fmtPrice(o.tp) + potentialTxt(o, o.tp, true) + posRrTxt(o));
    }
  }

  /* kullanıcı çizimleri (toolbox) */
  const drawGeo = {
    yOf, xOf, padL, padT, plotW, plotH,
    lo, hi, step, start, n,
    invert: invChart,
  };
  chartState.geo = drawGeo;
  paintDrawings(ctx, drawGeo);
  paintAlerts(ctx, drawGeo);
  paintPlans(ctx, drawGeo);
  /* açık işlem kutuları her zaman en üstte çizilir (plan/çizim/alarm seviyelerinin üzerinde) */
  if (boxesOn) paintPositionBoxes(ctx, drawGeo, symPositions);

  /* son fiyat çizgisi + etiketi (renk/opaklık: Grafik Renkleri) */
  const last = rates[n - 1];
  const lastUp = last.close >= last.open;
  const yLast = yOf(last.close);
  if (n - 1 >= start) {
    const cset = chartState.colors;
    const lineCol = cset.lineAuto !== false ? (lastUp ? colUp : colDown) : (cset.line || '#e5e7eb');
    const lineA = Math.max(0, Math.min(100, Number(cset.lineAlpha) >= 0 ? Number(cset.lineAlpha) : 100)) / 100;
    /* opaklık yalnızca kesikli çizgiye uygulanır; fiyat etiketi her zaman tam opak kalır */
    if (lineA > 0) {
      ctx.globalAlpha = lineA;
      ctx.strokeStyle = lineCol;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, yLast);
      ctx.lineTo(padL + plotW, yLast);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    const lbl = fmtPrice(last.close);
    ctx.font = '600 11px Segoe UI, sans-serif';
    const tw = Math.min(ctx.measureText(lbl).width + 12, padR - 4);
    ctx.fillStyle = lineCol;
    roundRectPath(ctx, padL + plotW + 2, yLast - 9, tw, 18, 4);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(lbl, padL + plotW + 8, yLast);
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = 1;
  }

  /* üst bilgi: sembol/tf + OHLC (hover varsa o mum) */
  const hovered = chartState.hover != null && rates[chartState.hover] ? rates[chartState.hover] : null;
  const src = hovered || last;
  ctx.font = '700 12px Segoe UI, sans-serif';
  ctx.fillStyle = colText;
  const head = chartState.symbol + ' · ' + chartState.tf;
  ctx.fillText(head, padL + 8, padT + 10);
  let xOff = padL + 8 + ctx.measureText(head).width + 12;
  ctx.font = '11px Segoe UI, sans-serif';
  const ohlc = 'O ' + fmtPrice(src.open) + '  H ' + fmtPrice(src.high) + '  L ' + fmtPrice(src.low) + '  ';
  ctx.fillStyle = colMuted;
  ctx.fillText(ohlc, xOff, padT + 10);
  xOff += ctx.measureText(ohlc).width;
  const cTxt = 'C ' + fmtPrice(src.close);
  ctx.fillStyle = src.close >= src.open ? colUp : colDown;
  ctx.fillText(cTxt, xOff, padT + 10);
  xOff += ctx.measureText(cTxt).width + 12;
  /* spread + OTO: arka plan snapshot'ta gösterilmez (farklı sembol/TF bağlamı) */
  if (!snapShot) {
    /* spread: doğrudan MT5'ten (puan) */
    const spreadPts = currentSpreadPts();
    const spTxt2 = 'Spread ' + spreadPts + ' puan';
    ctx.fillStyle = colMuted;
    ctx.fillText(spTxt2, xOff, padT + 10);
    xOff += ctx.measureText(spTxt2).width + 12;
    /* bu sekmede otomasyon açıksa uyarı niteliğinde "OTO" */
    if (autoCfg(activeTab()).on) {
      ctx.fillStyle = '#22c55e';
      ctx.fillText('OTO', xOff, padT + 10);
    }
  }

  /* crosshair */
  if (chartState.hover != null) {
    const i = chartState.hover;
    /* crosshair rengi/opaklığı: Grafik Renkleri > Crosshair */
    const crossCol = chartState.colors.cross || colMuted;
    const crossA = Math.max(0, Math.min(100, Number(chartState.colors.crossAlpha) >= 0 ? Number(chartState.colors.crossAlpha) : 70)) / 100;
    /* dikey çizgi imleci takip eder: son mumun ötesinde de grafiğin sonuna kadar gider */
    const x = chartState.mouse
      ? Math.max(padL, Math.min(padL + plotW, chartState.mouse.x))
      : xOf(i);
    ctx.strokeStyle = crossCol;
    ctx.globalAlpha = crossA;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    const yy = chartState.hoverY;
    if (yy != null && yy > padT && yy < padT + plotH) {
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(padL + plotW, yy);
      ctx.stroke();
      const price = invChart
        ? lo + ((yy - padT) / plotH) * (hi - lo)
        : hi - ((yy - padT) / plotH) * (hi - lo);
      const plbl = fmtPrice(price);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const pw2 = Math.min(ctx.measureText(plbl).width + 12, padR - 4);
      roundRectPath(ctx, padL + plotW + 2, yy - 9, pw2, 18, 4);
      ctx.fillStyle = '#000000';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(plbl, padL + plotW + 8, yy);
      ctx.textBaseline = 'alphabetic';
    }
    /* zaman ekseninde imlecin zamanı */
    const tlbl = crosshairTimeLabel(rates[i].time, chartState.tf);
    ctx.font = '600 11px Segoe UI, sans-serif';
    const tw2 = ctx.measureText(tlbl).width + 12;
    const tx = Math.max(padL, Math.min(padL + plotW - tw2, x - tw2 / 2));
    roundRectPath(ctx, tx, padT + plotH + 1, tw2, 18, 4);
    ctx.fillStyle = '#000000';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(tlbl, tx + 6, padT + plotH + 10);
    ctx.textBaseline = 'alphabetic';
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /* alarm aracı önizlemesi: imlecin olduğu fiyatta kesikli çizgi + fiyat etiketi */
  if (chartState.tool === 'alert' && chartState.mouse) {
    const myy = chartState.mouse.y;
    if (myy >= padT && myy <= padT + plotH) {
      const price = invChart
        ? lo + ((myy - padT) / plotH) * (hi - lo)
        : hi - ((myy - padT) / plotH) * (hi - lo);
      ctx.strokeStyle = '#f59e0b';
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.3;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, myy);
      ctx.lineTo(padL + plotW, myy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const lbl = 'ALARM ' + fmtPrice(price);
      ctx.font = '600 10px Segoe UI, sans-serif';
      const tw = Math.min(ctx.measureText(lbl).width + 12, padR - 4);
      ctx.fillStyle = '#f59e0b';
      roundRectPath(ctx, padL + plotW + 2, myy - 9, tw, 18, 4);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(lbl, padL + plotW + 8, myy);
    }
  }

  /* sola kaydırıldıysa / uzaklaşıldıysa eski mumları otomatik yükle (1. grafik) */
  if (!targetCanvas && start < Math.max(25, vc * 0.15) && chartState.rates.length < HISTORY_MAX && !backfillBusy) {
    backfillHistory();
  }

  /* 2. grafik çizimi görünüm kaydını (1. grafik) ezmesin */
  if (!targetCanvas && !drawTarget) scheduleViewSave();
}

function resetView() {
  chartState.follow = true;
  chartState.viewCount = Math.min(140, chartState.rates.length || 140);
  chartState.yOffset = 0;
  chartState.yScale = 1;
  chartState.yLock = null;
  tfCarryWish = 0;
}

/* TF/sembol değişiminde zoom kaymasın: yeni seri için kayıtlı görünüm yoksa
   önceki görünümün zoom'u (mum sayısı + dikey ölçek) aynen taşınır.
   Ayrıca görünümün SAĞ KENAR zamanı taşınır: geçmişe kaydırılmış görünümde
   son mum TF değişince sağa yapışmaz, aynı yerde kalır. */
let tfViewCarry = null;
/* TF geçişinde istenen görünür mum sayısı: ilk yüklemekte seri kısa geldiyse
   (clamp) backfill tamamlanınca bir kez yükseltilir */
let tfCarryWish = 0;

/* görünümün sağ kenarındaki zaman (ve = sağdaki indeks; son mumun ötesi ekstrapolasyon) */
function timeAtViewEnd() {
  const rates = chartState.rates;
  const n = rates.length;
  if (!n) return 0;
  const ve = Math.round(Number(chartState.viewEnd) || (n - 1));
  if (ve <= n - 1) return Number(rates[Math.max(0, ve)].time) || 0;
  return (Number(rates[n - 1].time) || 0) + (ve - (n - 1)) * barIvMs();
}

/* zamanın yeni serideki indeksi (yoksa en yakını; gelecekteyse ekstrapolasyon) */
function idxForTime(t) {
  const rates = chartState.rates;
  const n = rates.length;
  if (!n) return 0;
  if (!(t > 0)) return n - 1;
  let lo = 0, hi = n - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(rates[mid].time) <= t) { res = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (res < 0) return 0;
  if (res === n - 1) {
    const iv = barIvMs();
    const last = Number(rates[n - 1].time) || 0;
    if (iv > 0 && t > last) return n - 1 + Math.round((t - last) / iv);
  }
  return res;
}

function carryViewState() {
  tfViewCarry = {
    vc: Number(chartState.viewCount) || 140,
    ys: Number(chartState.yScale) || 1,
    yo: Number(chartState.yOffset) || 0,
    fol: chartState.follow !== false,
    rg: Number(chartState.rightGap) || 0,
    rightT: timeAtViewEnd(),
    /* görünür ZAMAN aralığı da taşınır: alt TF'e geçişte aynı dönem daha çok
       mumla açılır (M1'e alınca "zoom yakınlaştı, mum göremiyorum" olmasın) */
    spanMs: Math.max(0, Math.round((Number(chartState.viewCount) || 140) * barIvMs())),
  };
}
function applyCarriedView() {
  const c = tfViewCarry;
  tfViewCarry = null;
  if (!c) return false;
  const n = chartState.rates.length;
  if (!n) return false;
  /* TF geçişinde görünür ZAMAN aralığı korunur: yeni TF'te aynı dönem,
     o TF'in mum adediyle açılır (M15→M1 aynı dönemi ~15 kat mum gösterir) */
  const iv = barIvMs();
  let vc = (c.spanMs > 0 && iv > 1)
    ? Math.max(20, Math.round(c.spanMs / iv))
    : (Math.round(c.vc) || Math.min(140, n));
  tfCarryWish = vc;
  vc = Math.max(20, Math.min(n, vc));
  chartState.viewCount = vc;
  chartState.yScale = Math.max(0.2, Math.min(20, Number(c.ys) || 1));
  chartState.yOffset = Math.max(-5, Math.min(5, Number(c.yo) || 0));
  chartState.yLock = null; /* yeni TF: dikey ölçek taze başlar */
  /* offset negatif olabilir: son mum ekranın sağında N mum geride kalabilir (lag takibi) */
  chartState.rightGap = Math.max(-1, Math.min(0.8, Number(c.rg) || 0));
  chartState.follow = c.fol === true;
  if (chartState.follow) {
    chartState.viewEnd = n - 1 + Math.round(vc * chartState.rightGap);
  } else {
    /* sağ kenar aynı ZAMANA denk gelsin: son mum nerede görünüyorsa orada kalır */
    const idx = c.rightT > 0 ? idxForTime(c.rightT) : n - 1;
    chartState.viewEnd = Math.max(vc - 1, Math.min(n - 1 + Math.round(vc * 0.8), idx));
  }
  return true;
}

/* ---------- görünüm durumu kalıcı (zoom / mum sayısı / kaydırma / takip) ---------- */
const VIEW_KEY = 'jev.view';
let viewSaveTimer = null;

/* görünüm; borsa + sekme + sembol + zaman dilimi bazında saklanır */
function viewKey() {
  return VIEW_KEY + '.' + exName + '.' + (activeTabId || 'notab') + '.' + String(chartState.symbol || '') + '.' + String(chartState.tf || '');
}

function saveViewState() {
  try {
    if (!chartState.rates.length) return;
    localStorage.setItem(viewKey(), JSON.stringify({
      vc: chartState.viewCount,
      ve: chartState.viewEnd,
      ys: Number(chartState.yScale.toFixed(4)),
      yo: Number(chartState.yOffset.toFixed(4)),
      fol: !!chartState.follow,
      rg: Number(chartState.rightGap) || 0,
    }));
  } catch {}
}

function scheduleViewSave() {
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveViewState, 400);
}

function restoreViewState() {
  try {
    let raw = JSON.parse(localStorage.getItem(viewKey()) || 'null');
    /* eski anahtarlardan bir kez taşı: sembol+TF, sonra genel */
    if (!raw) raw = JSON.parse(localStorage.getItem(VIEW_KEY + '.' + String(chartState.symbol || '') + '.' + String(chartState.tf || '')) || 'null');
    /* genel (eski biçim) anahtar bilinçli olarak KULLANILMAZ: başka bir
       sembol/TF'in zoom'u buraya sıçramasın — onun yerine mevcut zoom taşınır */
    if (!raw || typeof raw !== 'object') return false;
    const n = chartState.rates.length;
    if (!n) return false;
    chartState.yLock = null; /* kayıtlı görünüm: dikey ölçek taze başlar */
    const vc = Math.max(20, Math.min(n, Math.round(Number(raw.vc)) || Math.min(140, n)));
    chartState.viewCount = vc;
    chartState.follow = raw.fol !== false;
    chartState.viewEnd = Math.max(vc - 1, Math.min(n - 1 + Math.round(vc * 0.8), Math.round(Number(raw.ve)) || n - 1));
    const ys = Number(raw.ys);
    const yo = Number(raw.yo);
    chartState.yScale = Number.isFinite(ys) ? Math.max(0.2, Math.min(20, ys)) : 1;
    chartState.yOffset = Number.isFinite(yo) ? Math.max(-5, Math.min(5, yo)) : 0;
    const rg = Number(raw.rg);
    chartState.rightGap = Number.isFinite(rg) ? Math.max(-1, Math.min(0.8, rg)) : 0;
    return true;
  } catch { return false; }
}

function setChartSymbol(sym) {
  const v = String(sym || '').trim().toUpperCase();
  if (!v) return;
  /* mevcut sembolün görünümünü kaydet (geri dönünce aynen açılsın) */
  saveViewState();
  carryViewState();
  chartState.symbol = v;
  chartState.tick = null;
  chartState.tickSpread = 0;
  chartState.tickPoint = 0;
  chartState.rates = [];
  tfSeq++;
  $('#chartSymbol').value = v;
  localStorage.setItem('jev.symbol', v);
  try { localStorage.setItem('jev.symbol.' + exName, v); } catch {}
  loadDrawings();
  /* önbellekte varsa anında göster */
  showCachedRates(v, chartState.tf);
  loadRates();
  selectedPlanId = '';
  applyPlanButtons();
  updateActiveTabChart();
  renderChartTabs();
}

/* kripto borsa bağlantı durumu: terminal/loglara bir kez yazılır */
const exConn = { binance: { on: null, err: '' }, okx: { on: null, err: '' } };
function logExStatus(name, okNow, errMsg) {
  if (name === 'mt5') return;
  const st = exConn[name] || (exConn[name] = { on: null, err: '' });
  if (okNow) {
    if (st.on !== true) {
      st.on = true;
      st.err = '';
      termLogAdd(exLabel(name) + ' bağlantısı kuruldu', 'sys');
    }
    return;
  }
  const msg = String(errMsg || 'bilinmeyen hata');
  if (st.on !== false || st.err !== msg) {
    st.on = false;
    st.err = msg;
    termLogAdd(exLabel(name) + ' bağlantı hatası: ' + msg, 'sl');
  }
}

/* borsadan gelen mumlar: o/h/l/c sonlu ve pozitif olmalı; zaman sıralı ve tekil
   olur. Bozuk satırlar (NaN/null) eskiden sessizce görünmez çiziliyor ve grafikte
   mum boşluğu bırakıyordu — burada temizlenir. */
function sanitizeRates(rows) {
  const src = Array.isArray(rows) ? rows : [];
  const out = [];
  const lastAt = new Map();
  for (const r of src) {
    if (!r || typeof r !== 'object') continue;
    const t = Math.floor(Number(r.time));
    const o = Number(r.open), h = Number(r.high), l = Number(r.low), c = Number(r.close);
    if (!(t > 0)) continue;
    if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
    if (!(o > 0) || !(h > 0) || !(l > 0) || !(c > 0)) continue;
    const row = Object.assign({}, r, {
      time: t, open: o, close: c,
      high: Math.max(h, o, c, l), low: Math.min(l, o, c, h),
    });
    if (lastAt.has(t)) out[lastAt.get(t)] = row;  /* aynı mum iki kez: sonuncusu */
    else { lastAt.set(t, out.length); out.push(row); }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/* ---------- mum önbelleği: TF/sembol geçişi ağ beklemeden ANINDA açılsın ----------
   Bellekte (oturum içi) + localStorage'da (uygulama yeniden açılışında) son seriler
   tutulur. Geçişte önce önbellek çizilir, taze veri arka planda gelince tazelenir. */
const RATES_CACHE_MEM = 40;    /* bellekte tutulan seri sayısı */
const RATES_CACHE_LS = 12;     /* localStorage'da tutulan seri sayısı */
const RATES_CACHE_BARS = 600;  /* her seride saklanan son mum sayısı */
const ratesCache = new Map();
const ratesCacheWriteAt = new Map();

function ratesCacheKey(sym, tf, ex) {
  return String(ex || exName) + '|' + String(sym || '').toUpperCase() + '|' + String(tf || '');
}

function ratesCacheGet(sym, tf, ex) {
  const key = ratesCacheKey(sym, tf, ex);
  const mem = ratesCache.get(key);
  if (mem && Array.isArray(mem.rates) && mem.rates.length) return mem.rates;
  try {
    const raw = JSON.parse(localStorage.getItem('jev.rcache.' + key) || 'null');
    const rows = sanitizeRates(raw && raw.rates);
    if (rows.length) {
      ratesCache.set(key, { at: Number(raw.at) || 0, rates: rows });
      return rows;
    }
  } catch {}
  return null;
}

function ratesCachePut(sym, tf, ex, rates) {
  if (!Array.isArray(rates) || !rates.length) return;
  const key = ratesCacheKey(sym, tf, ex);
  const rows = rates.slice(-RATES_CACHE_BARS);
  ratesCache.set(key, { at: Date.now(), rates: rows });
  while (ratesCache.size > RATES_CACHE_MEM) ratesCache.delete(ratesCache.keys().next().value);
  /* localStorage'a her saniye değil, en fazla 15 sn'de bir yazılır */
  const lastWrite = ratesCacheWriteAt.get(key) || 0;
  if (Date.now() - lastWrite < 15000) return;
  ratesCacheWriteAt.set(key, Date.now());
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('jev.rcache.')) keys.push(k);
    }
    const excess = keys.length - RATES_CACHE_LS + 1;
    for (let i = 0; i < excess; i++) localStorage.removeItem(keys[i]);
    localStorage.setItem('jev.rcache.' + key, JSON.stringify({ at: Date.now(), rates: rows }));
  } catch {}
}

/* önbellekteki seriyi ANINDA göster (yoksa false). Görünüm: mevcut zoom taşınır,
   yoksa kayıtlı görünüm, o da yoksa varsayılan. */
function showCachedRates(sym, tf) {
  const cached = ratesCacheGet(sym, tf);
  if (!cached || !cached.length) return false;
  chartState.rates = cached.slice();
  computeDigits();
  if (!applyCarriedView() && !restoreViewState()) resetView();
  setChartMsg('');
  updateLastPrice();
  drawChart();
  return true;
}

async function loadRates() {
  if (chartState.busy) return;
  /* 2. grafik çizim oturumu açıkken 1. grafik verisi karışmasın */
  if (pane2.session) return;
  chartState.busy = true;
  const seq = exSeq;
  const reqSym = chartState.symbol;
  const reqTf = chartState.tf;
  /* mumlar + canlı tick (spread = ask - bid için) */
  const [r, tr] = await Promise.all([
    jev.mt5Rates({ symbol: reqSym, timeframe: reqTf, count: CHART_COUNT }).catch(() => null),
    jev.mt5Ticks({ symbol: reqSym }).catch(() => null),
  ]);
  chartState.busy = false;
  if (seq !== exSeq) return;  /* borsa değişti: eski yanıtı yok say */
  /* sembol/TF değişti: uçuştaki eski yanıt yeni seriye karışmasın */
  if (chartState.symbol !== reqSym || chartState.tf !== reqTf) return;
  const tk = tr && tr.ok && tr.data ? tr.data.tick : null;
  if (tk) chartState.tick = tk;
  /* spread doğrudan MT5'ten (puan) — Market Watch ile aynı */
  chartState.tickSpread = spreadFromTickResp(tr);
  chartState.tickPoint = tr && tr.ok && tr.data ? Number(tr.data.point) || 0 : 0;
  const incoming = r && r.ok && r.data ? sanitizeRates(r.data.rates) : [];
  if (incoming.length) {
    if (exName !== 'mt5') { updateMt5Dot(true); logExStatus(exName, true); }
    const firstLoad = !chartState.rates.length;
    /* canlı veri: yeni mumlar alınır, geçmişte yüklenmiş eski mumlar korunur */
    const firstT = Number(incoming[0].time) || 0;
    const older = firstLoad ? [] : chartState.rates.filter((x) => Number(x.time) < firstT);
    chartState.rates = older.length ? older.concat(incoming) : incoming;
    /* TF geçişinde görünüm: önce mevcut zoom taşınır (kesintisiz), yoksa kayıtlı
       görünüm, o da yoksa varsayılan — eski kayıtlı zoom sıçraması olmaz */
    if (firstLoad && !applyCarriedView() && !restoreViewState()) resetView();
    computeDigits();
    setChartMsg('');
    updateLastPrice();
    /* seriyi önbelleğe al: aynı TF'e dönüş ağ beklemeden anında açılır */
    ratesCachePut(reqSym, reqTf, exName, chartState.rates);
    /* ilk yüklemede ya da önbellekten kısa seri geldiyse arka planda geçmiş çek */
    if (chartState.rates.length < 2000 && !backfillBusy) backfillHistory();
    const lastRate = incoming[incoming.length - 1];
    checkAlerts(lastRate.close, lastRate.time);
    applyPlanFollow(lastRate.close);
    drawChart();
  } else {
    const err = (r && r.error) || 'bilinmeyen hata';
    if (exName !== 'mt5') { updateMt5Dot(false); logExStatus(exName, false, err); }
    setChartMsg(exLabel() + ' verisi alınamadı — ' + err, true);
  }
}

/* ---------- fiyat alarmları ---------- */
const ALERTS_KEY = 'jev.alerts';

function loadAlerts() {
  try {
    const raw = JSON.parse(localStorage.getItem(ALERTS_KEY) || '[]');
    chartState.alerts = Array.isArray(raw) ? raw.filter((a) => a && Number(a.price) > 0).map((a) => ({
      id: String(a.id || newId()),
      symbol: String(a.symbol || ''),
      price: Number(a.price),
      cond: ['above', 'below', 'cross'].includes(a.cond) ? a.cond : 'cross',
      note: String(a.note || ''),
      active: a.active !== false,
      triggeredAt: Number(a.triggeredAt || 0),
      drawingId: a.drawingId ? String(a.drawingId) : '',
      edge: a.edge === 'bottom' ? 'bottom' : 'top',
      repeat: a.repeat === true,
      tf: tfIsValid(a.tf) ? tfNorm(a.tf) : chartState.tf,   /* eski kayıt: TF'i aktif grafikten al */
      sound: ALERT_SOUNDS.some((s) => s.id === a.sound) ? a.sound : 'klasik',
      ex: ['mt5', 'binance', 'okx'].includes(a.ex) ? a.ex : '',
      last: null,
      cooldownBar: 0,
      src: a.src === 'ai' ? 'ai' : '',
    })) : [];
  } catch { chartState.alerts = []; }
}

function saveAlerts() {
  try {
    const out = (chartState.alerts || []).map((a) => ({
      id: a.id, symbol: a.symbol, price: a.price, cond: a.cond, note: a.note,
      active: !!a.active, triggeredAt: Number(a.triggeredAt || 0), drawingId: a.drawingId || '',
      edge: a.edge || 'top', repeat: a.repeat === true, sound: a.sound || 'klasik',
      tf: a.tf || '',
      ex: a.ex || '',
      src: a.src === 'ai' ? 'ai' : '',
    }));
    localStorage.setItem(ALERTS_KEY, JSON.stringify(out));
  } catch {}
}

function alertCondText(cond) {
  return cond === 'above' ? 'üstüne çıkınca' : cond === 'below' ? 'altına inince' : 'kesişince';
}

function alertFiredText(cond) {
  return cond === 'above' ? 'üstüne çıktı' : cond === 'below' ? 'altına indi' : 'seviyeyi kesti';
}

/* ---------- alarm sesi + sağdan kayan bildirim ---------- */
let alertAudioCtx = null;

function alertSoundOn() {
  return localStorage.getItem('jev.alertSound') !== '0';
}

function applyAlertSoundBtn() {
  const on = alertSoundOn();
  const b = $('#alertSoundBtn');
  b.classList.toggle('active', on);
  b.title = on ? 'Alarm sesi açık — kapatmak için tıkla' : 'Alarm sesi kapalı — açmak için tıkla';
}

const ALERT_SOUNDS = [
  { id: 'klasik', name: 'Klasik (3 ton)' },
  { id: 'zil', name: 'Zil' },
  { id: 'cift', name: 'Çift bip' },
  { id: 'siren', name: 'Siren' },
  { id: 'dusuk', name: 'Düşük ton' },
  { id: 'yuksek', name: 'Yüksek ton' },
];

function alertSoundName(id) {
  const s = ALERT_SOUNDS.find((x) => x.id === id);
  return s ? s.name : ALERT_SOUNDS[0].name;
}

function alertDefaultSound() {
  const id = localStorage.getItem('jev.alertSoundId') || 'klasik';
  return ALERT_SOUNDS.some((s) => s.id === id) ? id : 'klasik';
}

function alertSoundRepeat() {
  const v = Math.round(Number(localStorage.getItem('jev.alertSoundRepeat')) || 1);
  return Math.max(1, Math.min(10, v));
}

function playAlertSound(id) {
  if (!alertSoundOn()) return;
  try {
    alertAudioCtx = alertAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const actx = alertAudioCtx;
    if (actx.state === 'suspended') actx.resume();
    const now = actx.currentTime;
    const beep = (t, f, dur, vol, type) => {
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type || 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(actx.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
    };
    const kind = id || 'klasik';
    /* desen bir kez çalınır, süresi (period) döner */
    const playOnce = (t) => {
      if (kind === 'zil') {
        beep(t, 1567.98, 1.1, 0.22);
        beep(t, 3135.96, 0.7, 0.08);
        beep(t + 0.02, 1046.5, 1.0, 0.1);
        return 1.25;
      }
      if (kind === 'cift') {
        beep(t, 1000, 0.12, 0.25);
        beep(t + 0.18, 1000, 0.12, 0.25);
        return 0.4;
      }
      if (kind === 'siren') {
        for (let i = 0; i < 3; i++) {
          beep(t + i * 0.34, 650, 0.16, 0.22, 'square');
          beep(t + i * 0.34 + 0.17, 950, 0.16, 0.2, 'square');
        }
        return 1.05;
      }
      if (kind === 'dusuk') {
        beep(t, 440, 0.3, 0.25);
        beep(t + 0.34, 440, 0.4, 0.22);
        return 0.85;
      }
      if (kind === 'yuksek') {
        beep(t, 1760, 0.14, 0.2);
        beep(t + 0.16, 1760, 0.14, 0.2);
        beep(t + 0.32, 2093, 0.2, 0.18);
        return 0.6;
      }
      /* klasik */
      beep(t, 880, 0.18, 0.25);
      beep(t + 0.22, 1174.7, 0.22, 0.25);
      beep(t + 0.5, 880, 0.3, 0.22);
      return 0.9;
    };
    const reps = alertSoundRepeat();
    let t = now;
    for (let i = 0; i < reps; i++) t += playOnce(t);
  } catch {}
}

function dismissAlertToast(el) {
  if (!el || el.classList.contains('hide')) return;
  el.classList.remove('show');
  el.classList.add('hide');
  setTimeout(() => { try { el.remove(); } catch {} }, 350);
}

function pushToast(title, body, cls) {
  const wrap = $('#alertToasts');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'alert-toast' + (cls ? ' ' + cls : '');
  el.innerHTML =
    '<div class="at-title"><span>' + escapeHtml(title) + '</span><button class="at-close" title="Kapat">✕</button></div>' +
    '<div class="at-body">' + escapeHtml(body) + '</div>';
  el.querySelector('.at-close').addEventListener('click', () => dismissAlertToast(el));
  wrap.appendChild(el);
  setTimeout(() => el.classList.add('show'), 30);
  setTimeout(() => dismissAlertToast(el), 10000);
  while (wrap.children.length > 4) wrap.removeChild(wrap.firstChild);
}

function showAlertToast(a) {
  pushToast('ALARM', a.symbol + ' ' + nf(a.price, decOf(a.price)) + ' ' + alertFiredText(a.cond) + (a.note ? ' · ' + a.note : ''));
}

/* ---------- long/short işlem planları (giriş + SL/TP, 2R varsayılan) ---------- */
const PLANS_KEY = 'jev.plans';
let selectedPlanId = '';
/* plan kutusu modunda grup döngüsü: tıkladıkça üyeler sırayla gösterilir */
let posGroupCycle = { key: '', idx: 0 };
/* seçili açık işlem kutusu: sağa uzar, SL/TP seviyeleri uzamayla görünür */
let selectedPosTicket = '';
/* grup SL/TP sürükleme: sürüklenen ortak seviye (tüm üyelere uygulanır) */
let groupLevelDrag = null;  /* { key, part: 'sl'|'tp', price, tickets: [] } */

function loadPlans() {
  try {
    const raw = JSON.parse(localStorage.getItem(PLANS_KEY) || '[]');
    chartState.plans = Array.isArray(raw) ? raw.filter((p) => p && p.symbol && Number(p.entry) > 0).map((p) => ({
      id: String(p.id || newId()),
      symbol: String(p.symbol || ''),
      side: p.side === 'short' ? 'short' : 'long',
      entry: Number(p.entry),
      sl: Number(p.sl),
      tp: Number(p.tp),
      t0: Number(p.t0) || 0,
      t1: Number(p.t1) || 0,
      follow: p.follow === true,
      rr: Number(p.rr) > 0 ? Number(p.rr) : 0,
      p: normProb(p.p),
      src: p.src === 'ai' ? 'ai' : '',
    })) : [];
  } catch { chartState.plans = []; }
}

function savePlans() {
  pushUndoIfChanged();
  try {
    const out = (chartState.plans || []).map((p) => ({
      id: p.id, symbol: p.symbol, side: p.side, entry: p.entry, sl: p.sl, tp: p.tp,
      t0: p.t0 || 0, t1: p.t1 || 0, follow: p.follow === true, rr: Number(p.rr) > 0 ? Number(p.rr) : 0,
      p: normProb(p.p),
      src: p.src === 'ai' ? 'ai' : '',
    }));
    localStorage.setItem(PLANS_KEY, JSON.stringify(out));
  } catch {}
}

function atrLike(rates, n) {
  let sum = 0, cnt = 0;
  const m = Math.min(n + 1, rates.length);
  for (let i = rates.length - m; i < rates.length; i++) {
    if (i <= 0) continue;
    const r = rates[i];
    const pc = rates[i - 1].close;
    sum += Math.max(r.high - r.low, Math.abs(r.high - pc), Math.abs(r.low - pc));
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

function planRR(p) {
  const risk = Math.abs(p.entry - p.sl);
  if (!(risk > 0)) return 0;
  return Math.abs(p.tp - p.entry) / risk;
}

/* ---------- beklenen değer (EV): EV(R) = p × RR − (1 − p) ----------
   p = kazanma olasılığı (0-1). LLM emirlerinde p komutla gelir; TypeSafe planlarında
   yön güveni; manuel planlarda sekmenin varsayılan olasılığı kullanılır.
   Otomatik emirler min EV altında açılmaz; manuel girişlerde uyarı gösterilir. */
function tabEvMin() {
  const t = activeTab();
  const v = t ? Number(t.evMin) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : 0.05;
}

function tabEvEnforce() {
  const t = activeTab();
  return t ? t.evEnforce !== false : true;
}

/* manuel planlar için varsayılan kazanma olasılığı (0-1) */
function tabEvProb() {
  const t = activeTab();
  const v = t ? Number(t.evProb) : NaN;
  return Number.isFinite(v) && v > 0 && v <= 100 ? v / 100 : 0.5;
}

/* p normalizasyonu: 0-1 arası; 1'den büyük 100'lük yüzde değerleri (65 → 0.65) kabul edilir */
function normProb(v) {
  let n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n > 1 && n <= 100) n = n / 100;
  return n > 0 && n < 1 ? n : 0;
}

function evOf(entry, sl, tp, p) {
  const risk = Math.abs(Number(entry) - Number(sl));
  const reward = Math.abs(Number(tp) - Number(entry));
  const rr = risk > 0 ? reward / risk : 0;
  const prob = normProb(p);
  const ok = prob > 0 && rr > 0;
  const evR = ok ? prob * rr - (1 - prob) : 0;
  return { rr, p: prob, evR, risk, reward, ok };
}

function fmtEv(evR) {
  return (Number(evR) >= 0 ? '+' : '') + Number(evR).toFixed(2) + 'R';
}

/* planın olasılığı: plan üstünde p varsa o, yoksa sekmenin varsayılanı */
function planProbability(plan) {
  const own = normProb(plan && plan.p);
  return own > 0 ? own : tabEvProb();
}

function planEV(plan) {
  return evOf(plan && plan.entry, plan && plan.sl, plan && plan.tp, planProbability(plan));
}

/* otomatik lot varsayımıyla EV'nin para karşılığı (bakiye × risk% × EV);
   riskPct verilirse (LLM emri) sekme riski yerine o kullanılır */
function evMoneyTxt(evR, riskPct) {
  const bal = Number((chartState.account && chartState.account.balance) || 0);
  if (!(bal > 0)) return '';
  const rp = Number(riskPct) > 0 ? Number(riskPct) : planRiskPct();
  const money = (bal * rp / 100) * Number(evR);
  const cur = (chartState.account && chartState.account.currency) || '';
  return ' (≈ ' + (money >= 0 ? '+' : '') + money.toFixed(2) + (cur ? ' ' + cur : '') + ')';
}

/* magnet açık planlar: giriş fiyatı canlı fiyatı takip eder (SL/TP mesafesi korunur) */
function applyPlanFollow(price) {
  const p = Number(price);
  if (!(p > 0) || !Array.isArray(chartState.plans)) return;
  let moved = false;
  for (const pl of chartState.plans) {
    if (pl.symbol !== chartState.symbol || !pl.follow) continue;
    const d = p - pl.entry;
    if (d) {
      pl.entry = p;
      pl.sl += d;
      pl.tp += d;
      moved = true;
    }
  }
  if (moved) savePlans();
}

/* sabit RR: TP = giriş ± |giriş - SL| × RR */
function applyPlanRR(p) {
  if (!p || !(Number(p.rr) > 0)) return;
  const risk = Math.abs(p.entry - p.sl);
  if (!(risk > 0)) return;
  const tpDist = risk * Number(p.rr);
  p.tp = p.side === 'long' ? p.entry + tpDist : p.entry - tpDist;
}

/* ayarlar: risk % (sekmeye özel, yoksa genel; taban varsayılan %2) */
function planRiskPct() {
  const t = activeTab();
  const tv = t ? Number(t.risk) : 0;
  if (tv > 0) return tv;
  const v = Number(String(localStorage.getItem('jev.risk') || '').replace(',', '.'));
  return v > 0 ? v : 2;
}

/* sekmenin varsayılan RR değeri (yoksa 2) */
function tabDefaultRR() {
  const t = activeTab();
  const v = t ? Number(t.rr) : 0;
  return v > 0 ? v : 2;
}

function applyPlanButtons() {
  const cur = (chartState.plans || []).find((p) => p.symbol === chartState.symbol) || null;
  const lb = $('#toolbox button[data-action="long"]');
  const sb = $('#toolbox button[data-action="short"]');
  const lb2 = $('#toolbox2 button[data-action="long"]');
  const sb2 = $('#toolbox2 button[data-action="short"]');
  if (lb && sb) {
    lb.classList.toggle('active', !!cur && cur.side === 'long');
    sb.classList.toggle('active', !!cur && cur.side === 'short');
    lb.title = (cur && cur.side === 'long') ? 'Long planı kapat' : 'Long planı aç (giriş + SL/TP · 2R) — çizgileri sürükleyerek ayarla';
    sb.title = (cur && cur.side === 'short') ? 'Short planı kapat' : 'Short planı aç (giriş + SL/TP · 2R) — çizgileri sürükleyerek ayarla';
  }
  if (lb2 && sb2) {
    lb2.classList.toggle('active', !!cur && cur.side === 'long');
    sb2.classList.toggle('active', !!cur && cur.side === 'short');
  }
}

function createTradePlan(side) {
  const sd = side === 'short' ? 'short' : 'long';
  const existing = (chartState.plans || []).find((p) => p.symbol === chartState.symbol) || null;
  /* aynı butona tekrar basıldı: planı kapat */
  if (existing && existing.side === sd) {
    chartState.plans = chartState.plans.filter((p) => p !== existing);
    if (selectedPlanId === existing.id) selectedPlanId = '';
    savePlans();
    applyPlanButtons();
    drawChart();
    toast((sd === 'long' ? 'LONG' : 'SHORT') + ' planı kapatıldı');
    return;
  }
  const rates = chartState.rates;
  if (!rates.length) { toast('Grafik verisi yok'); return; }
  /* farklı yön istendi: eskisini kaldır, yenisini kur */
  if (existing) {
    chartState.plans = chartState.plans.filter((p) => p !== existing);
    if (selectedPlanId === existing.id) selectedPlanId = '';
  }
  const n = rates.length;
  const entry = Number(rates[n - 1].close);
  const point = Math.pow(10, -chartState.digits);
  const dist = Math.max(atrLike(rates, 14) * 1.5, point * 10);
  /* kutu: son mumdan 10 mum sola, 30 mum sağa */
  const iv = Math.max(1, rates[n - 1].time - (n >= 2 ? rates[n - 2].time : rates[n - 1].time - 60));
  const plan = {
    id: newId(),
    symbol: chartState.symbol,
    side: sd,
    entry,
    sl: sd === 'short' ? entry + dist : entry - dist,
    tp: sd === 'short' ? entry - dist * 2 : entry + dist * 2,
    t0: rates[Math.max(0, n - 1 - 10)].time,
    t1: rates[n - 1].time + 30 * iv,
    follow: true,  /* plan açılınca magnet otomatik açık: giriş canlı fiyatı takip eder */
    rr: tabDefaultRR(),
  };
  chartState.plans.push(plan);
  selectedPlanId = plan.id;
  selectedAlertId = '';
  /* GÖRÜNÜM DEĞİŞMEZ: plan mevcut zoom ve mum yerleşiminde açılır; takip/offset
     korunur (eskiden follow kapatılıp görünüm 34 mum kaydırılıyordu). */
  savePlans();
  applyPlanButtons();
  drawChart();
  toast((sd === 'long' ? 'LONG' : 'SHORT') + ' planı açıldı · giriş ' + nf(entry, chartState.digits) +
    ' · SL ' + nf(plan.sl, chartState.digits) + ' · TP ' + nf(plan.tp, chartState.digits) +
    ' · ' + planRR(plan).toFixed(1) + 'R · magnet açık (fiyat takibi)');
}

function planBoxX(p, g) {
  const x0 = g.padL;
  const x1 = g.padL + g.plotW;
  if (!p.t0 || !p.t1) return { x0, x1 };
  const a = g.xOf(idxFromTime(p.t0));
  const b = g.xOf(idxFromTime(p.t1));
  const bx0 = Math.max(x0, Math.min(a, b));
  const bx1 = Math.min(x1, Math.max(a, b));
  return { x0: bx0, x1: bx1 };
}

/* ---------- kutu yatay boyutlandırma (sol/sağ kenar) ---------- */
const BOX_EDGE_GRAB = 6;   /* kenar tutamağı yakınlık toleransı (px) */
const BOX_EDGE_MIN_BARS = 5;   /* kutu en az bu kadar mum geniş olabilir */
const BOX_EDGE_MAX_BARS = 400; /* kutu en fazla bu kadar mum geniş olabilir */

/* görünür mum süresi (ms): kenar sürüklerken zamanı mum sayısına çevirmek için */
function barIvMs() {
  const r = chartState.rates;
  if (r.length >= 2) return Math.max(1, r[r.length - 1].time - r[r.length - 2].time);
  return 60;
}

/* kutu kenarı tutamağı: sol ('l') / sağ ('r'), dar kutuda iç içe binmesin */
function boxEdgeOf(mx, my, r) {
  if (!r) return '';
  if (my < r.yTop - 4 || my > r.yBot + 4) return '';
  if (r.x1 - r.x0 < 20) return '';
  if (Math.abs(mx - r.x0) <= BOX_EDGE_GRAB) return 'l';
  if (Math.abs(mx - r.x1) <= BOX_EDGE_GRAB) return 'r';
  return '';
}

/* seçili plan kutusunun sol/sağ kenarı (SL/TP çizgileri kenarı da çizer: önce bu denenir) */
function hitPlanBoxEdge(mx, my, g) {
  const p = (chartState.plans || []).find((x) => x.id === selectedPlanId && x.symbol === chartState.symbol);
  if (!p) return null;
  const bx = planBoxX(p, g);
  const yS = g.yOf(p.sl), yT = g.yOf(p.tp);
  const edge = boxEdgeOf(mx, my, { x0: bx.x0, x1: bx.x1, yTop: Math.min(yS, yT), yBot: Math.max(yS, yT) });
  return edge ? { plan: p, edge } : null;
}

/* plan kutusu kenar sürüklemesi: yalnız zaman ekseni (fiyat/SL/TP dokunulmaz) */
function applyPlanEdgeDrag(p, edge, t) {
  if (!p || !t) return;
  const iv = barIvMs();
  let lo = Math.min(Number(p.t0) || 0, Number(p.t1) || 0);
  let hi = Math.max(Number(p.t0) || 0, Number(p.t1) || 0);
  if (!(hi > lo)) { lo = Number(t) - iv; hi = Number(t); }
  const minGap = BOX_EDGE_MIN_BARS * iv;
  const maxGap = BOX_EDGE_MAX_BARS * iv;
  if (edge === 'l') lo = Math.min(Math.max(Number(t), hi - maxGap), hi - minGap);
  else hi = Math.max(Math.min(Number(t), lo + maxGap), lo + minGap);
  p.t0 = lo;
  p.t1 = hi;
}

/* seçili kutunun sol/sağ kenarında boyutlandırma tutamağı */
function paintBoxEdgeHandles(ctx, r) {
  if (!r || r.x1 - r.x0 < 20) return;
  const my = (r.yTop + r.yBot) / 2;
  for (const x of [r.x0, r.x1]) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - 3, my - 3, 6, 6);
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 3.5, my - 3.5, 7, 7);
  }
}

function hitPlan(mx, my, g) {
  const list = (chartState.plans || []).filter((p) => p.symbol === chartState.symbol);
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const bx = planBoxX(p, g);
    if (mx < bx.x0 - 6 || mx > bx.x1 + 6) continue;
    for (const part of ['entry', 'sl', 'tp']) {
      const y = g.yOf(p[part]);
      if (y < g.padT - 1 || y > g.padT + g.plotH + 1) continue;
      if (Math.abs(my - y) <= 9) return { plan: p, part };
    }
  }
  return null;
}

function hitPlanBox(mx, my, g) {
  const list = (chartState.plans || []).filter((p) => p.symbol === chartState.symbol);
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const bx = planBoxX(p, g);
    const yS = g.yOf(p.sl);
    const yT = g.yOf(p.tp);
    const top = Math.min(yS, yT);
    const bot = Math.max(yS, yT);
    if (mx >= bx.x0 - 2 && mx <= bx.x1 + 2 && my >= top - 2 && my <= bot + 2) return p;
  }
  return null;
}

/* giriş satırı düzeni: kutu genişliğine (zoom'a) göre ölçeklenir */
function planEntryLayout(p, g) {
  const bx = planBoxX(p, g);
  const bw = Math.max(1, bx.x1 - bx.x0);
  const fit = Math.max(0.5, Math.min(1.1, bw / 160));
  const cx = (bx.x0 + bx.x1) / 2;
  const y = g.yOf(p.entry);
  const r = Math.max(6.5, 10 * fit);
  const xMin = g.padL + r + 2;
  const xMax = g.padL + g.plotW - r - 2;
  const mx = Math.max(xMin, Math.min(xMax, cx + 34 * fit));
  const ex = Math.max(xMin, Math.min(xMax, cx + 62 * fit));
  return { cx, y, bw, fit, r, mx, ex, fontSize: Math.max(7, Math.round(9 * fit)) };
}

function planMagnetPos(p, g) {
  const L = planEntryLayout(p, g);
  return { x: L.mx, y: L.y, r: L.r };
}

function planEntryBtnPos(p, g) {
  const L = planEntryLayout(p, g);
  return { x: L.ex, y: L.y, r: L.r };
}

function hitPlanEntryBtn(mx, my, g) {
  const list = (chartState.plans || []).filter((p) => p.symbol === chartState.symbol);
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const m = planEntryBtnPos(p, g);
    if (Math.hypot(mx - m.x, my - m.y) <= (m.r || 10) + 3) return p;
  }
  return null;
}

let entryIconLong = null;
let entryIconShort = null;

function entryIconPath(side) {
  if (!entryIconLong) {
    /* SVG ikon yolları (toolbox oklarıyla aynı) */
    entryIconLong = new Path2D('M12 19V5 M5 12l7-7 7 7');
    entryIconShort = new Path2D('M12 5v14 M19 12l-7 7-7-7');
  }
  return side === 'short' ? entryIconShort : entryIconLong;
}

function drawEntryBtn(ctx, x, y, side, r) {
  const rr = r || 10;
  const k = rr / 10;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(x, y, rr, 0, Math.PI * 2);
  ctx.fillStyle = side === 'short' ? '#ef4444' : '#22c55e';
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
  ctx.stroke();
  /* siyah SVG ikon: yön oku */
  ctx.translate(x, y);
  ctx.scale(0.52 * k, 0.52 * k);
  ctx.translate(-12, -12);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(entryIconPath(side));
  ctx.restore();
}

function hitPlanMagnet(mx, my, g) {
  const list = (chartState.plans || []).filter((p) => p.symbol === chartState.symbol);
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    const m = planMagnetPos(p, g);
    if (Math.hypot(mx - m.x, my - m.y) <= (m.r || 10) + 3) return p;
  }
  return null;
}

function drawMagnetBtn(ctx, x, y, on, r) {
  const rr = r || 10;
  const k = rr / 10;
  ctx.save();
  ctx.translate(x, y);
  /* kilitliyken (fiyat takibi) 90° sağa, bırakınca 90° sola bakar */
  ctx.rotate(on ? -Math.PI / 2 : Math.PI / 2);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(0, 0, rr, 0, Math.PI * 2);
  ctx.fillStyle = on ? '#f59e0b' : 'rgba(15, 23, 42, 0.88)';
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = on ? '#fbbf24' : 'rgba(148, 163, 184, 0.75)';
  ctx.stroke();
  /* mıknatıs (U) ikonu */
  ctx.strokeStyle = on ? '#0f172a' : '#cbd5e1';
  ctx.lineWidth = 2 * k;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, -1 * k, 4 * k, Math.PI, 0, false);
  ctx.moveTo(-4 * k, -1 * k);
  ctx.lineTo(-4 * k, 3.5 * k);
  ctx.moveTo(4 * k, -1 * k);
  ctx.lineTo(4 * k, 3.5 * k);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.restore();
}

function paintPlans(ctx, g) {
  const list = (chartState.plans || []).filter((p) => p.symbol === chartState.symbol);
  if (!list.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.padL, g.padT, g.plotW, g.plotH);
  ctx.clip();
  const x0 = g.padL;
  const x1 = g.padL + g.plotW;
  const cs = chartState.colors || {};
  const slC = cs.planSl || '#f43f5e';
  const tpC = cs.planTp || '#22c55e';
  const txtC = cs.planText || '#e2e8f0';
  const entC = cs.planEntry || '#cbd5e1';
  const fillBase = Math.max(0.05, Math.min(0.7, (Number(cs.planFill) || 30) / 100));
  for (const p of list) {
    const sel = p.id === selectedPlanId;
    const bx = planBoxX(p, g);
    const bw = bx.x1 - bx.x0;
    if (bw < 4) continue;
    const yE = g.yOf(p.entry), yS = g.yOf(p.sl), yT = g.yOf(p.tp);
    const dirS = yS >= yE ? 1 : -1;
    const dirT = yT >= yE ? 1 : -1;
    /* bölgesel dolgular */
    ctx.fillStyle = hexA(slC, sel ? Math.min(0.7, fillBase + 0.08) : fillBase);
    ctx.fillRect(bx.x0, Math.min(yE, yS), bw, Math.abs(yS - yE));
    ctx.fillStyle = hexA(tpC, sel ? Math.min(0.7, fillBase + 0.08) : fillBase);
    ctx.fillRect(bx.x0, Math.min(yE, yT), bw, Math.abs(yT - yE));
    /* SL / TP kenar çizgileri (düz), giriş kesikli */
    const line = (y, color, dash, w) => {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = w;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      ctx.moveTo(bx.x0, y);
      ctx.lineTo(bx.x1, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    };
    line(yS, slC, [], sel ? 2 : 1.4);
    line(yT, tpC, [], sel ? 2 : 1.4);
    line(yE, entC, [6, 5], sel ? 1.8 : 1.5);
    /* kutu çerçevesi: dikey kenarlar */
    ctx.strokeStyle = 'rgba(148, 163, 184, ' + (sel ? 0.85 : 0.55) + ')';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(bx.x0, Math.min(yS, yT));
    ctx.lineTo(bx.x0, Math.max(yS, yT));
    ctx.moveTo(bx.x1, Math.min(yS, yT));
    ctx.lineTo(bx.x1, Math.max(yS, yT));
    ctx.stroke();
    /* seçili kutu: sol/sağ kenardan genişlik sürüklenebilir */
    if (sel) paintBoxEdgeHandles(ctx, { x0: bx.x0, x1: bx.x1, yTop: Math.min(yS, yT), yBot: Math.max(yS, yT) });
    /* etiketler: SL/TP kendi bölgesinin dış kenarında */
    const cx = (bx.x0 + bx.x1) / 2;
    const inside = (yOuter, dir) => (dir > 0 ? yOuter - 5 : yOuter + 13);
    ctx.textAlign = 'center';
    /* potansiyel kayıp/kâr: risk % × bakiye (otomatik lot ile) */
    const bal = Number((chartState.account && chartState.account.balance) || 0);
    const riskPct = planRiskPct();
    const riskMoney = bal > 0 ? (bal * riskPct) / 100 : 0;
    const curCode = (chartState.account && chartState.account.currency) || '';
    const lossTxt = riskMoney > 0 ? ' (≈ -' + riskMoney.toFixed(2) + (curCode ? ' ' + curCode : '') + ')' : '';
    const gainTxt = riskMoney > 0 ? ' (≈ +' + (riskMoney * planRR(p)).toFixed(2) + (curCode ? ' ' + curCode : '') + ')' : '';
    const slShort = 'SL: ' + Number(p.sl).toFixed(chartState.digits);
    const tpShort = planTpLabelText(p);
    /* etiketler kutu genişliğine göre küçülür/kısalır: hiçbir zoom'da taşmaz */
    const maxLblW = Math.max(24, bw - 10);
    const fitLabel = (full, short, bold) => {
      const setF = (s) => { ctx.font = '400 ' + s + 'px Segoe UI, sans-serif'; };
      let size = 9;
      setF(size);
      while (size > 7 && ctx.measureText(full).width > maxLblW) { size -= 0.5; setF(size); }
      if (ctx.measureText(full).width <= maxLblW) return { text: full, size };
      size = 9;
      setF(size);
      while (size > 7 && ctx.measureText(short).width > maxLblW) { size -= 0.5; setF(size); }
      if (ctx.measureText(short).width <= maxLblW) return { text: short, size };
      let t = short;
      setF(7);
      while (t.length > 4 && ctx.measureText(t + '…').width > maxLblW) t = t.slice(0, -1);
      return { text: t + '…', size: 7 };
    };
    const drawLbl = (full, short, y, bold) => {
      if (y < g.padT + 9 || y > g.padT + g.plotH - 2) return;
      const fit = fitLabel(full, short, bold);
      ctx.fillStyle = txtC;
      ctx.fillText(fit.text, cx, y);
    };
    drawLbl(slShort + lossTxt, slShort, inside(yS, dirS), sel);
    drawLbl(tpShort + gainTxt, tpShort, inside(yT, dirT), sel);
    /* giriş satırı: ortada fiyat, hemen yanında mıknatıs, onun yanında işleme girme butonu
       (zoom'a göre ölçeklenir, grafik alanı dışına taşmaz) */
    if (yE > g.padT + 12 && yE < g.padT + g.plotH - 2) {
      const L = planEntryLayout(p, g);
      ctx.textAlign = 'center';
      ctx.font = '400 ' + L.fontSize + 'px Segoe UI, sans-serif';
      ctx.fillStyle = txtC;
      ctx.fillText(Number(p.entry).toFixed(chartState.digits), L.cx, yE + 3.5);
      drawMagnetBtn(ctx, L.mx, yE, !!p.follow, L.r);
      drawEntryBtn(ctx, L.ex, yE, p.side, L.r);
    }
    ctx.textAlign = 'left';
  }
  ctx.restore();
}

/* ---------- açık işlem kutusu genişliği (sürüklenir, kalıcı) ---------- */
const POS_BOX_W_KEY = 'jev.posBoxW';
const POS_BOX_DEF_BARS = 40;
const POS_BOX_MIN_BARS = 5;
let posBoxWMap = null;
let posBoxEdgeDrag = null;  /* { ticket, edge, d0, d1 } canlı sürükleme önizlemesi */

function posBoxW() {
  if (!posBoxWMap) {
    try { posBoxWMap = JSON.parse(localStorage.getItem(POS_BOX_W_KEY) || '{}') || {}; } catch { posBoxWMap = {}; }
  }
  return posBoxWMap;
}
function posBoxWFlush() {
  try { localStorage.setItem(POS_BOX_W_KEY, JSON.stringify(posBoxWMap || {})); } catch {}
}
/* fiyat bilgisi olmayan işlemde kutu giriş mumuna sabitlenir */
function posBoxBaseT(p) {
  const r = chartState.rates;
  return Number(p.time) || (r.length ? r[r.length - 1].time : 0);
}
/* kutu açıklığı: girişe göre mum ofseti [sol, sağ]. Sürükleme önizlemesi,
   sonra fiş için kayıtlı değer, yoksa sembol için son ayar, yoksa varsayılan. */
function posBoxSpan(p, iv, baseT) {
  const tk = String(p.ticket);
  const w = posBoxW();
  const sk = '@' + String(p.symbol || '').toUpperCase();
  let d0 = 0, d1 = POS_BOX_DEF_BARS;
  const dg = posBoxEdgeDrag;
  if (dg && String(dg.ticket) === tk) { d0 = dg.d0; d1 = dg.d1; }
  else if (Array.isArray(w[tk])) { d0 = Number(w[tk][0]); d1 = Number(w[tk][1]); }
  else if (Array.isArray(w[sk])) { d0 = Number(w[sk][0]); d1 = Number(w[sk][1]); }
  if (!isFinite(d0)) d0 = 0;
  if (!isFinite(d1)) d1 = POS_BOX_DEF_BARS;
  if (d1 - d0 < POS_BOX_MIN_BARS) d1 = d0 + POS_BOX_MIN_BARS;
  const base = Number(baseT) || 0;
  return { t0: base + d0 * iv, t1: base + d1 * iv, d0, d1 };
}
/* genişliği kalıcı yaz: fişe + sembole (yeni açılan işlemler de aynı genişliği alsın) */
function posBoxWSet(p, d0, d1) {
  const w = posBoxW();
  const tk = String(p.ticket);
  const pair = [Math.round(d0), Math.round(d1)];
  w[tk] = pair;
  w['@' + String(p.symbol || '').toUpperCase()] = pair;
  /* kapalı işlemlerin kaydı birikmesin */
  const live = new Set((chartState.positions || []).map((x) => String(x.ticket)));
  for (const k of Object.keys(w)) if (k.charAt(0) !== '@' && !live.has(k)) delete w[k];
  posBoxWFlush();
}

/* açık işlem kutusu geometrisi: açılış vakti + sürüklenebilir genişlik */
function posBoxRect(p, g) {
  const entry = Number(p.price_open) || 0;
  if (!(entry > 0)) return null;
  const rates = chartState.rates;
  const iv = rates.length >= 2 ? Math.max(1, rates[rates.length - 1].time - rates[rates.length - 2].time) : 60;
  const sp = posBoxSpan(p, iv, posBoxBaseT(p));
  const bx = planBoxX({ t0: sp.t0, t1: sp.t1 }, g);
  /* yeni açılan işlemde kutu ince kalmasın: en az 60px görünür genişlik */
  if (bx.x1 - bx.x0 < 60) {
    if (bx.x0 + 60 <= g.padL + g.plotW) bx.x1 = bx.x0 + 60;
    else bx.x0 = Math.max(g.padL, bx.x1 - 60);
  }
  if (bx.x1 - bx.x0 < 4) return null;
  const sl = Number(p.sl) || 0;
  const tp = Number(p.tp) || 0;
  const yE = g.yOf(entry);
  const yS = sl > 0 ? g.yOf(sl) : null;
  const yT = tp > 0 ? g.yOf(tp) : null;
  const ys = [yE, yS, yT].filter((v) => v != null);
  return {
    x0: bx.x0, x1: bx.x1, bw: bx.x1 - bx.x0,
    yE, yS, yT,
    yTop: Math.min.apply(null, ys), yBot: Math.max.apply(null, ys),
    entry, sl, tp,
  };
}

/* iki kutu kesişiyor mu (hem zaman hem fiyat aralığı) */
function posBoxOverlap(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.yTop < b.yBot && b.yTop < a.yBot;
}

/* kesişen kutuları gruplara ayır */
function clusterPositionBoxes(list, g) {
  const items = [];
  for (const p of list) {
    const r = posBoxRect(p, g);
    if (r) items.push({ p, r });
  }
  const clusters = [];
  for (const it of items) {
    const hits = clusters.filter((c) => c.some((m) => posBoxOverlap(m.r, it.r)));
    if (!hits.length) {
      clusters.push([it]);
    } else {
      hits[0].push(it);
      for (let i = hits.length - 1; i >= 1; i--) {
        hits[0].push.apply(hits[0], hits[i]);
        clusters.splice(clusters.indexOf(hits[i]), 1);
      }
    }
  }
  return clusters;
}

function posClusterKey(c) {
  return c.map((m) => String(m.p.ticket)).sort().join('|');
}

/* grup kutusu: üyelerin kapsadığı alan + ortalama giriş/SL/TP */
function posGroupRect(c, g) {
  let x0 = Infinity, x1 = -Infinity, e = 0, sl = 0, tp = 0, vol = 0, nS = 0, nT = 0;
  for (const m of c) {
    x0 = Math.min(x0, m.r.x0);
    x1 = Math.max(x1, m.r.x1);
    e += m.r.entry;
    vol += Number(m.p.volume) || 0;
    if (m.r.sl > 0) { sl += m.r.sl; nS++; }
    if (m.r.tp > 0) { tp += m.r.tp; nT++; }
  }
  const entry = e / c.length;
  let avgSl = nS ? sl / nS : 0;
  let avgTp = nT ? tp / nT : 0;
  /* sürükleme önizlemesi: ortak seviye canlı takip eder */
  if (groupLevelDrag && groupLevelDrag.key === posClusterKey(c)) {
    if (groupLevelDrag.part === 'sl') avgSl = groupLevelDrag.price;
    else avgTp = groupLevelDrag.price;
  }
  const yE = g.yOf(entry);
  const yS = avgSl > 0 ? g.yOf(avgSl) : null;
  const yT = avgTp > 0 ? g.yOf(avgTp) : null;
  const ys = [yE, yS, yT].filter((v) => v != null);
  return {
    x0, x1, bw: x1 - x0, yE, yS, yT,
    yTop: Math.min.apply(null, ys), yBot: Math.max.apply(null, ys),
    entry, sl: avgSl, tp: avgTp, count: c.length, volume: vol, isGroup: true,
  };
}

/* plan kutusu modunda kutu/grup isabet testi */
function hitPositionCluster(mx, my, g) {
  if (!chartState.showPosBox) return null;
  if ((chartState.plans || []).some((pl) => pl.symbol === chartState.symbol)) return null;
  const list = (chartState.positions || []).filter(
    (p) => String(p.symbol || '').toUpperCase() === chartState.symbol
  );
  const inside = (r) => mx >= r.x0 - 3 && mx <= r.x1 + 3 && my >= r.yTop - 4 && my <= r.yBot + 4;
  const clusters = clusterPositionBoxes(list, g);
  for (let i = clusters.length - 1; i >= 0; i--) {
    const c = clusters[i];
    const key = posClusterKey(c);
    if (c.length > 1) {
      /* grup: isabet alanı grup kutusu */
      if (inside(posGroupRect(c, g))) return { key, cluster: c };
      if (posGroupCycle.key === key) {
        const mi = Math.max(0, Math.min(posGroupCycle.idx, c.length - 1));
        const m = c[mi];
        if (inside(m.r)) return { key, cluster: c };
      }
    } else {
      const m = c[0];
      if (inside(m.r)) return { key, cluster: c, ticket: String(m.p.ticket) };
    }
  }
  return null;
}

/* görünen açık işlem kutusunun sol/sağ kenarı (genişlik sürükleme).
   Kutu önce seçilir (tıklama), sonra kenar ortasından sağa/sola çekilir. */
function hitPosBoxEdge(mx, my, g) {
  if (!chartState.showPosBox) return null;
  if ((chartState.plans || []).some((pl) => pl.symbol === chartState.symbol)) return null;
  const list = (chartState.positions || []).filter(
    (p) => String(p.symbol || '').toUpperCase() === chartState.symbol
  );
  const clusters = clusterPositionBoxes(list, g);
  for (let ci = clusters.length - 1; ci >= 0; ci--) {
    const c = clusters[ci];
    let m;
    if (c.length > 1) {
      /* kapalı grupta üye kutusu görünmez: kenarı da sürüklenemez */
      if (posClusterKey(c) !== posGroupCycle.key) continue;
      m = c[Math.max(0, Math.min(posGroupCycle.idx, c.length - 1))];
    } else {
      m = c[0];
      if (String(m.p.ticket) !== selectedPosTicket) continue;
    }
    const edge = boxEdgeOf(mx, my, m.r);
    if (edge) return { pos: m.p, ticket: String(m.p.ticket), edge, rect: m.r };
  }
  return null;
}

/* grup kutusunun SL/TP çizgisi isabet testi (ortak seviye sürükleme) */
function hitPositionGroupLevel(mx, my, g) {
  if (!chartState.showPosBox) return null;
  if ((chartState.plans || []).some((pl) => pl.symbol === chartState.symbol)) return null;
  const list = (chartState.positions || []).filter(
    (p) => String(p.symbol || '').toUpperCase() === chartState.symbol
  );
  const clusters = clusterPositionBoxes(list, g);
  for (let ci = clusters.length - 1; ci >= 0; ci--) {
    const c = clusters[ci];
    if (c.length < 2) continue;
    const key = posClusterKey(c);
    if (posGroupCycle.key === key) continue;  /* döngüde üyeler tek tek sürüklenir */
    const gr = posGroupRect(c, g);
    if (mx < gr.x0 || mx > gr.x1) continue;
    const allLong = c.every((m) => Number(m.p.type) !== 1);
    const allShort = c.every((m) => Number(m.p.type) === 1);
    for (const part of ['sl', 'tp']) {
      const y = part === 'sl' ? gr.yS : gr.yT;
      if (y == null) continue;
      if (Math.abs(my - y) <= 6) {
        return {
          key, cluster: c, part,
          price: part === 'sl' ? gr.sl : gr.tp,
          mixed: !allLong && !allShort,
        };
      }
    }
  }
  return null;
}

/* tek kutu çizimi (grup ya da üye) */
function drawPosBox(ctx, g, r, meta) {
  const cs = chartState.colors || {};
  /* açık işlem kutusu kendi renklerini kullanır (işlem planından bağımsız) */
  const slC = cs.posSl || cs.planSl || '#f43f5e';
  const tpC = cs.posTp || cs.planTp || '#22c55e';
  const txtC = cs.planText || '#e2e8f0';
  const entC = cs.planEntry || '#cbd5e1';
  const fillBase = Math.max(0.05, Math.min(0.7, (Number(cs.planFill) || 30) / 100));
  const { x0, x1, bw, yE, yS, yT } = r;
  /* bölgesel dolgular */
  if (yS != null) {
    ctx.fillStyle = hexA(slC, fillBase);
    ctx.fillRect(x0, Math.min(yE, yS), bw, Math.abs(yS - yE));
  }
  if (yT != null) {
    ctx.fillStyle = hexA(tpC, fillBase);
    ctx.fillRect(x0, Math.min(yE, yT), bw, Math.abs(yT - yE));
  }
  /* SL / TP düz çizgiler, giriş kesikli */
  const line = (y, color, dash, w) => {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = w;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  };
  if (yS != null) line(yS, slC, [], 1.4);
  if (yT != null) line(yT, tpC, [], 1.4);
  line(yE, entC, [6, 5], 1.5);
  /* kutu çerçevesi: dikey kenarlar */
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, r.yTop);
  ctx.lineTo(x0, r.yBot);
  ctx.moveTo(x1, r.yTop);
  ctx.lineTo(x1, r.yBot);
  ctx.stroke();
  /* seçili kutu: sol/sağ kenardan genişlik sürüklenebilir */
  if (meta.sel) paintBoxEdgeHandles(ctx, r);
  /* yazılar kapalıysa kutu etiketleri çizilmez (SL/TP/giriş metinleri) */
  if (chartState.showPosText === false) {
    ctx.textAlign = 'left';
    return;
  }
  /* etiketler: SL/TP kendi bölgesinin içinde */
  const cx = (x0 + x1) / 2;
  ctx.textAlign = 'center';
  const maxLblW = Math.max(24, bw - 10);
  const fitLabel = (text, weight) => {
    const setF = (s) => { ctx.font = weight + ' ' + s + 'px Segoe UI, sans-serif'; };
    let size = 9;
    setF(size);
    while (size > 7 && ctx.measureText(text).width > maxLblW) { size -= 0.5; setF(size); }
  };
  const drawLbl = (text, y, weight) => {
    if (y < g.padT + 9 || y > g.padT + g.plotH - 2) return;
    fitLabel(text, weight || '700');
    ctx.fillStyle = txtC;
    ctx.fillText(text, cx, y);
  };
  const pot = meta.p ? (t) => potentialTxt(meta.p, t, false) : () => '';
  const grpSl = meta.grp && meta.grp.sl ? meta.grp.sl : '';
  const grpTp = meta.grp && meta.grp.tp ? meta.grp.tp : '';
  /* TP yanında potansiyel RR: tek işlemde kendi fiyatları, grupta ortalama seviyeler */
  const rrT = meta.p ? posRrTxt(meta.p) : rrRatioTxt(r.entry, r.sl, r.tp);
  if (yS != null) drawLbl('SL ' + fmtPrice(r.sl) + pot(r.sl) + grpSl + (meta.p ? trailTagFor(meta.p) : ''), yS >= yE ? yS - 5 : yS + 13, '400');
  if (yT != null) drawLbl('TP ' + fmtPrice(r.tp) + pot(r.tp) + grpTp + rrT, yT >= yE ? yT - 5 : yT + 13, '400');
  /* giriş satırı: ortada fiyat + parantez içinde işlem bilgisi (siyah) */
  if (yE > g.padT + 12 && yE < g.padT + g.plotH - 2) {
    ctx.textAlign = 'center';
    let entryTxt;
    if (meta.isGroup) {
      entryTxt = fmtPrice(r.entry) + ' (' + r.count + ' işlem' + (meta.side ? ' ' + meta.side : '') + ')';
    } else if (meta.idxNum) {
      const sell = Number(meta.p.type) === 1;
      entryTxt = fmtPrice(r.entry) + ' (' + meta.idxNum + '. işlem ' + nf(Number(meta.p.volume) || 0) + ' ' + (sell ? 'short' : 'long') + ')';
    } else {
      const sell = Number(meta.p.type) === 1;
      entryTxt = fmtPrice(r.entry) + ' (' + nf(Number(meta.p.volume) || 0) + ' ' + (sell ? 'short' : 'long') + ')';
    }
    fitLabel(entryTxt, '400');
    ctx.fillStyle = '#000000';
    ctx.fillText(entryTxt, cx, yE + 3.5);
  }
  ctx.textAlign = 'left';
}

/* açık işlemleri plan kutusu gibi çiz: kesişenler tek grup, tıklanınca ayrı ayrı */
function paintPositionBoxes(ctx, g, list) {
  if (!list.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.padL, g.padT, g.plotW, g.plotH);
  ctx.clip();
  const clusters = clusterPositionBoxes(list, g);
  for (const c of clusters) {
    const key = posClusterKey(c);
    if (c.length > 1 && posGroupCycle.key !== key) {
      const allLong = c.every((m) => Number(m.p.type) !== 1);
      const allShort = c.every((m) => Number(m.p.type) === 1);
      drawPosBox(ctx, g, posGroupRect(c, g), {
        isGroup: true,
        side: allLong ? 'long' : allShort ? 'short' : '',
        /* birleşik görünümde toplam potansiyel kâr (TP yanı) / zarar (SL yanı) */
        grp: { sl: clusterPotentialTxt(c, 'sl'), tp: clusterPotentialTxt(c, 'tp') },
      });
    } else if (c.length > 1) {
      /* döngü: yalnızca sıradaki üye gösterilir (1. işlem, 2. işlem, ...) */
      const i = Math.max(0, Math.min(posGroupCycle.idx, c.length - 1));
      const m = c[i];
      drawPosBox(ctx, g, m.r, { p: m.p, idxNum: i + 1, count: c.length, sel: true });
    } else {
      const m = c[0];
      drawPosBox(ctx, g, m.r, { p: m.p, sel: String(m.p.ticket) === selectedPosTicket });
    }
  }
  ctx.restore();
}

/* kutu görünümü aç/kapa (buton ve A kısayolu aynı işi yapar) */
function togglePosBoxView() {
  chartState.showPosBox = !chartState.showPosBox;
  const t = activeTab();
  if (t) { t.showPosBox = chartState.showPosBox; saveTabs(); }
  try { localStorage.setItem('jev.showPosBox', chartState.showPosBox ? '1' : '0'); } catch {}
  const b = $('#posBoxBtn');
  if (b) b.classList.toggle('active', chartState.showPosBox);
  drawChart();
}

/* grup SL/TP sürüklemesini uygula: gruptaki tüm işlemlere aynı seviye */
function applyGroupLevelDrag(drag) {
  const price = Number(drag && drag.price) || 0;
  if (!(price > 0) || !drag.tickets.length) return;
  mt5Begin();
  (async () => {
    try {
      let ok = 0, fail = 0;
      for (const tk of drag.tickets) {
        const p = (chartState.positions || []).find((x) => String(x.ticket) === tk);
        if (!p) continue;
        const info = symInfoOf(p.symbol);
        const dg = info && info.digits > 0 ? Number(info.digits) : decOf(p.price_open);
        const px = Number(Number(price).toFixed(Math.min(8, dg)));
        const sl = drag.part === 'sl' ? px : (Number(p.sl) || 0);
        const tp = drag.part === 'tp' ? px : (Number(p.tp) || 0);
        const r = await jev.mt5Modify({ ticket: p.ticket, sl, tp }).catch(() => null);
        if (r && r.ok) ok++; else fail++;
      }
      const label = drag.part === 'sl' ? 'Grup SL' : 'Grup TP';
      if (ok) {
        toast(label + ': ' + ok + ' işlem güncellendi' + (fail ? ' · ' + fail + ' başarısız' : ''));
        pushToast(label.toUpperCase() + ' GÜNCELLENDİ', ok + ' işlem · ' + nf(price, decOf(price)) + (fail ? ' · ' + fail + ' başarısız' : ''), 'trade-open');
        termLogAdd(label + ' · ' + ok + ' işlem → ' + nf(price, decOf(price)) + (fail ? ' · ' + fail + ' başarısız' : ''), 'trail');
      } else {
        toast(label + ' güncellenemedi' + (fail ? ' (' + fail + ' başarısız)' : ''));
      }
      refreshPositions();
    } finally { mt5End(); }
  })();
}

let jevAlertBusy = false;
let jevAlertLastAt = 0;
let jevAlertQueue = [];        /* Jev meşgulken bekleyen alarm bildirimleri */
let jevAlertFlushTimer = null;
const JEV_ALERT_MIN_GAP_MS = 10000;  /* üst üste alarmlarda iki istek arası en kısa süre */

function jevAlertAutoOn() {
  return localStorage.getItem('jev.jevAlert') !== '0';
}

/* herhangi bir alarm tetiklenince Jev'e otomatik bildirim: analiz + karar.
   Jev meşgulse alarm KUYRUĞA alınır; boşalınca mutlaka değerlendirilir (atlanmaz). */
function jevNotifyAlert(a, msg) {
  if (!a || !jevAlertAutoOn()) return;
  const line = a.symbol + ' · ' + msg + (a.src === 'ai' ? ' (AI alarmı)' : '');
  jevAlertQueue.push(line);
  if (jevAlertQueue.length > 30) jevAlertQueue = jevAlertQueue.slice(-30);
  if (pendingChatId || !$('#stopBtn').hidden) toast('Alarm alındı — Jev boşalınca değerlendirecek');
  jevAlertScheduleFlush(300);
}

function jevAlertScheduleFlush(delay) {
  if (jevAlertFlushTimer) return;
  jevAlertFlushTimer = setTimeout(() => {
    jevAlertFlushTimer = null;
    jevAlertFlush();
  }, Math.max(200, Number(delay) || 400));
}

function jevAlertFlush() {
  if (!jevAlertQueue.length) return;
  if (!state.activeModel) { jevAlertScheduleFlush(5000); return; }
  if (pendingChatId || !$('#stopBtn').hidden || jevAlertBusy) { jevAlertScheduleFlush(2500); return; }
  const wait = jevAlertLastAt + JEV_ALERT_MIN_GAP_MS - Date.now();
  if (wait > 0) { jevAlertScheduleFlush(wait + 200); return; }
  const msgs = jevAlertQueue.slice();
  jevAlertQueue = [];
  jevAlertBusy = true;
  jevAlertLastAt = Date.now();
  const msg = msgs.join(' || ');
  toast('Alarm analizi: Jev (TypeSafe) + sohbet LLM');
  termLogAdd('ALARM ANALİZİ · ' + msg, 'sys');
  jevLogAdd('ALARM ANALİZİ · ' + msg, 'alert');
  jevTsAnalyze('alarm').catch(() => {});
  /* sohbet LLM ajanı da alarmla otomatik tetiklenir */
  const text = '[OTOMATİK ALARM] ' + msg +
    '\nBu alarm(lar) otomatik bildirimdir (kullanıcı yazmadı). AMAÇ: grafiği, çizimleri ve pozisyonu SON DURUMA UYARLAMAK.' +
    ' Sistem promptundaki HER ANALİZ RUTİNİ\'ni (R1-R8) uygula: [ANALİZ ZAMAN DİLİMİ] bloğundaki iki TF\'yi (üst → giriş) sırayla analiz et; çizilecek seviye varsa çiz/güncelle, kritik seviyeye alarm bırak, gerekiyorsa toolbox aracı kullan, setup varsa emir aç, açık pozisyonu yönet.' +
    ' Grafiği analiz et ve kararını ver: geçerli setup varsa analize uygun emir türüyle (hemen giriş market · geri çekilme limit · kırılım stop · price = analizdeki seviye) <<ORDER>> göndererek işlem aç; kademeli giriş için çoklu <<ORDER>>, iki yönlü kırılım için <<OCO>> kullanabilirsin, yoksa "işlem yok" de.' +
    ' Açık pozisyon varsa SL/TP durumunu değerlendir; güncelleme gerekiyorsa <<SLTP>> ile UYGULA. Zararda panik yok (kısmi kapatma yalnız kârda); kârda BE/TRAIL/parçalı TP ile aktif yönet.' +
    ' Takip gereken kritik seviyeler için uygun türde (sürekli/tek seferlik) <<ALERT>> bırak; extrasız alarm kalmasın, eskimişleri temizle.' +
    ' AI çizimleri/seviyeleri eskimişse <<CLEAR {"what":"ai"}>> ile temizleyip güncel seviyeleri yeniden çiz; çizgi/kutuları son mumun ötesine (pozitif t ile) uzat.' +
    ' Soru sorma; yalnızca kararı ve varsa emir/çizim/alarm komutlarını tek satırda yaz.';
  sendMessage(text, 'alert').catch(() => {}).finally(() => {
    jevAlertBusy = false;
    jevAlertScheduleFlush(500);
  });
}

/* ---------- işlem saatleri: LLM yalnız bu aralıkta yeni emir açabilir ----------
   Varsayılan 08:00–22:00. Başlangıç = bitiş ise kısıt yok (24 saat); ters aralık gece yarısını sarar. */
const TRADE_HOURS_KEY = 'jev.tradeHours';

function normTradeTime(v, def) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return def;
  const h = Math.min(23, Math.max(0, Number(m[1]) || 0));
  const mi = Math.min(59, Math.max(0, Number(m[2]) || 0));
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

function tradeHours() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(TRADE_HOURS_KEY) || 'null'); } catch {}
  return {
    start: normTradeTime(raw && raw.start, '08:00'),
    end: normTradeTime(raw && raw.end, '22:00'),
  };
}

function setTradeHours(start, end) {
  const h = { start: normTradeTime(start, '08:00'), end: normTradeTime(end, '22:00') };
  try { localStorage.setItem(TRADE_HOURS_KEY, JSON.stringify(h)); } catch {}
  return h;
}

function tradeMinOfHHMM(s) {
  const [h, m] = String(s).split(':').map((x) => Number(x) || 0);
  return h * 60 + m;
}

/* şu an işlem penceresi içinde mi? (başlangıç = bitiş → 24 saat açık) */
function inTradeHours(now) {
  const { start, end } = tradeHours();
  const a = tradeMinOfHHMM(start);
  const b = tradeMinOfHHMM(end);
  if (a === b) return true;
  const d = now || new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  return a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

function fmtTradeHours() {
  const { start, end } = tradeHours();
  return start + '–' + end;
}

/* sistem promptuna eklenen işlem saati bloğu (her istekte güncel değer) */
function tradeHoursPromptBlock() {
  const { start, end } = tradeHours();
  if (start === end) return '';
  return '\n\n[İŞLEM SAATLERİ] Yeni emir yalnız ' + start + '–' + end + ' arasında açılabilir; bu aralık dışında uygulama <<ORDER>>/<<OCO>> emirlerini reddeder. Saat dışındaysan yeni işlem açma, "işlem yok" de; açık pozisyonların SL/TP yönetimi her zaman serbesttir.';
}

/* işlem açılış/kapanışında sohbet LLM'ini alarm gibi otomatik tetikler */
let jevTradeBusy = false;
let jevTradeLastAt = 0;
let jevTradePending = null;  /* sohbet meşgulse son olay kuyruğa alınır */

function jevTradeAutoOn() {
  return localStorage.getItem('jev.autoTradeNotify') !== '0';
}

function jevNotifyTrade(kind, lines) {
  if (!jevTradeAutoOn() || !Array.isArray(lines) || !lines.length) return;
  if (!state.activeModel) return;
  /* sohbet meşgulse ya da çok yeniyse kuyruğa al; sıradaki boşlukta gönderilir */
  if (jevTradeBusy || pendingChatId || !$('#stopBtn').hidden || Date.now() - jevTradeLastAt < 5000) {
    jevTradePending = { kind, lines };
    return;
  }
  jevTradeBusy = true;
  jevTradeLastAt = Date.now();
  const isOpen = kind === 'open';
  const tag = isOpen ? 'OTOMATİK İŞLEM AÇILDI' : 'OTOMATİK İŞLEM KAPANDI';
  const text = '[' + tag + '] ' + lines.join(' | ') +
    '\nBu olay otomatik bildirimdir (kullanıcı yazmadı). AMAÇ: durumu SON DURUMA UYARLAMAK. Sistem promptundaki HER ANALİZ RUTİNİ\'ni (R1-R8) uygula ([ANALİZ ZAMAN DİLİMİ] bloğundaki iki TF); gerekirse çizim/alarm/tool/emir komutlarını gönder.' +
    (isOpen
      ? ' Açılan pozisyonun giriş/SL/TP ve riskini değerlendir; gerekiyorsa <<SLTP>> ile seviyeleri güncelle, kârı korumak için <<BE>>/<<TRAIL>> kullan, uygun yeni setup varsa <<ORDER>>/<<OCO>> ile işlem aç ve takip için <<ALERT>> kur.'
      : ' Kapanan işlemin sonucunu değerlendir; piyasa hâlâ uygunsa <<ORDER>> ile yeni işlem aç, seviyeleri/çizimleri güncelle ve gerekiyorsa takip alarmı <<ALERT>> bırak, yoksa net biçimde "işlem yok" de.') +
    ' Soru sorma; kararı ve varsa komutları tek satırda yaz, uzun açıklama yapma.';
  jevLogAdd('İŞLEM ANALİZİ · ' + tag + ' · ' + lines.join(' | '), 'alert');
  termLogAdd('İŞLEM ANALİZİ TETİKLENDİ · ' + tag, 'sys');
  toast('İşlem analizi: sohbet LLM tetiklendi');
  sendMessage(text, 'trade').catch(() => {}).finally(() => {
    jevTradeBusy = false;
    const q = jevTradePending;
    jevTradePending = null;
    if (q) setTimeout(() => jevNotifyTrade(q.kind, q.lines), 6000);
  });
}

function fireAlert(a, oneShot) {
  const msg = a.symbol + ' ' + a.price + ' ' + alertFiredText(a.cond) + (a.note ? ' · ' + a.note : '') + (oneShot ? ' · tek seferlik, alarm silindi' : '');
  toast('ALARM: ' + msg);
  showAlertToast(a);
  playAlertSound(a.sound || 'klasik');
  try { jev.notify({ title: 'JevTrader Alarm', body: msg }); } catch {}
  intgBroadcast('ALARM_TETIK', msg, { noHistory: true });
  jevNotifyAlert(a, msg);
}

/* ---------- tekrarlı alarm: mum başına TEK ses ----------
   Bekleme anahtarı artık "hangi barTime'ı gönderdi" değil, TF'e göre hesaplanan
   mum kova numarasıdır: floor(saniye / TF). Böylece tetikleyen kaynak önemsizleşir —
   aktif grafik 1 sn'de bir kendi TF'sinin barTime'ını, arka plan motoru 3 sn'de
   bir M1 barTime'ını gönderir; ikisi de aynı kovaya düşer, biri diğerinin
   beklemesini sıfırlamaz. (Eskiden kova karşılaştırması ham barTime'a bakıyordu,
   "cross" alarmı fiyat her salınımda tetiklendiği için dakikada onlarca kez çalıyordu.) */
function alertBarBucket(a, barTime) {
  const sec = tfSec(a && a.tf ? a.tf : chartState.tf);
  /* barTime unix saniye (MT5 sunucu saati = PC saati); yoksa duvar saati */
  const t = Number(barTime) > 0 ? Number(barTime) : Date.now() / 1000;
  return Math.floor(t / sec);
}

/* alarm kontrolü: aktif grafik (hızlı tick) ya da arka plan motoru çağırır.
   sym/ex verilmezse aktif sembol + aktif borsa kullanılır; eski kayıtlar aktif borsaya sayılır. */
function checkAlerts(price, barTime, sym, ex) {
  const p = Number(price);
  if (!(p > 0) || !Array.isArray(chartState.alerts)) return;
  const useSym = String(sym || chartState.symbol || '').toUpperCase();
  const useEx = ex || exName;
  let changed = false;
  const removeIds = new Set();
  for (const a of chartState.alerts) {
    if (!a.active) continue;
    if (String(a.symbol || '').toUpperCase() !== useSym) continue;
    if ((a.ex || exName) !== useEx) continue;
    const prev = a.last == null ? p : a.last;
    a.last = p;
    /* tekrarlı alarm: içinde bulunulan mumda bir daha çalmaz (kova = TF'e göre mum) */
    const bucket = alertBarBucket(a, barTime);
    if (a.repeat && a.cooldownBar && a.cooldownBar === bucket) continue;
    let hit = false;
    if (a.cond === 'above') hit = prev < a.price && p >= a.price;
    else if (a.cond === 'below') hit = prev > a.price && p <= a.price;
    else hit = (prev < a.price && p >= a.price) || (prev > a.price && p <= a.price);
    if (hit) {
      changed = true;
      if (a.repeat) {
        a.cooldownBar = bucket;
        a.triggeredAt = Date.now();
        fireAlert(a, false);
      } else {
        fireAlert(a, true);
        removeIds.add(a.id);
      }
    }
  }
  if (removeIds.size) {
    chartState.alerts = chartState.alerts.filter((x) => !removeIds.has(x.id));
    if (removeIds.has(selectedAlertId)) selectedAlertId = '';
  }
  if (changed) {
    saveAlerts();
    renderAlertSide();
    drawChart();
  }
}

/* ---------- arka plan alarm motoru ----------
   Alarmlar yalnız aktif grafiğe bağlı kalmaz: farklı semboller ve farklı borsalar
   (MT5/Binance/OKX) için de fiyat çekilip kontrol edilir; pencere simge durumunda/
   arka planda olsa da çalışır (backgroundThrottling kapalı). */
let alertBgBusy = false;

async function alertBackgroundTick() {
  if (alertBgBusy) return;
  const active = (chartState.alerts || []).filter((a) => a.active && a.symbol);
  if (!active.length) return;
  /* borsa + sembol grupları */
  const groups = new Map();
  for (const a of active) {
    const ex = a.ex || exName;
    const sym = String(a.symbol || '').toUpperCase();
    const key = ex + '|' + sym;
    if (!groups.has(key)) groups.set(key, { ex, sym });
  }
  alertBgBusy = true;
  try {
    const list = Array.from(groups.values()).slice(0, 8);  /* tur başına en fazla 8 grup */
    await Promise.all(list.map(async (g) => {
      const r = await jev.exRatesAt({ exchange: g.ex, symbol: g.sym, timeframe: 'M1', count: 1 }).catch(() => null);
      const rates = r && r.ok && r.data && Array.isArray(r.data.rates) ? r.data.rates : [];
      if (!rates.length) return;
      const last = rates[rates.length - 1];
      checkAlerts(Number(last.close), last.time, g.sym, g.ex);
    }));
  } finally {
    alertBgBusy = false;
  }
}

function paintAlerts(ctx, g) {
  if (!chartState.showAlertLevels) return;
  const list = (chartState.alerts || []).filter((a) => a.symbol === chartState.symbol);
  if (!list.length) return;
  const d = chartState.digits;
  ctx.font = '600 10px Segoe UI, sans-serif';
  ctx.textAlign = 'left';
  for (const a of list) {
    const y = g.yOf(a.price);
    if (y < g.padT - 1 || y > g.padT + g.plotH + 1) continue;
    const selA = a.id === selectedAlertId;
    const col = a.active ? '#f59e0b' : '#6b7280';
    ctx.strokeStyle = col;
    ctx.globalAlpha = selA ? 1 : a.active ? 0.9 : 0.5;
    ctx.lineWidth = selA ? 2.2 : 1.2;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(g.padL, y);
    ctx.lineTo(g.padL + g.plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    let lbl = (a.active ? 'ALARM ' : '✓ ') + a.symbol + ' ' + Number(a.price).toFixed(d) + ' · ' + alertCondText(a.cond) + (a.repeat ? ' · ↻' : '') + (a.note ? ' · ' + a.note : '');
    const maxBadgeW = g.plotW - 8;
    /* yazı kutuya sığmıyorsa kısalt */
    while (lbl.length > 6 && ctx.measureText(lbl).width + 14 > maxBadgeW) lbl = lbl.slice(0, -1);
    if (ctx.measureText(lbl).width + 14 > maxBadgeW) lbl = lbl.slice(0, 5) + '…';
    const lblW = ctx.measureText(lbl).width;
    const tw = Math.min(lblW + 14, maxBadgeW);
    ctx.fillStyle = col;
    roundRectPath(ctx, g.padL + 4, y - 8, tw, 15, 3);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    /* yazı yatay ve dikey olarak sarı kutunun tam ortasında */
    ctx.textBaseline = 'middle';
    ctx.fillText(lbl, g.padL + 4 + Math.max(4, (tw - lblW) / 2), y - 0.5);
    ctx.textBaseline = 'alphabetic';
  }
}

/* alarm çizgisi isabet testi (seç + sürükle + Del) */
function hitAlert(mx, my, g) {
  const list = (chartState.alerts || []).filter((a) => a.symbol === chartState.symbol);
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    const y = g.yOf(a.price);
    if (y < g.padT - 1 || y > g.padT + g.plotH + 1) continue;
    if (Math.abs(my - y) <= 5 && mx >= g.padL && mx <= g.padL + g.plotW) return a;
  }
  return null;
}

/* ---------- geri alma (Ctrl+Z) + kopyala/yapıştır (Ctrl+C/Ctrl+V) ---------- */
let undoStack = [];
let undoBase = null;
let drawClipboard = null;

function snapshotState() {
  try {
    return JSON.stringify({ d: chartState.drawings || [], p: chartState.plans || [] });
  } catch { return '{}'; }
}

function initUndoBase() {
  undoBase = snapshotState();
  undoStack = [];
}

function pushUndoIfChanged() {
  const cur = snapshotState();
  if (undoBase == null) { undoBase = cur; return; }
  if (cur === undoBase) return;
  undoStack.push(undoBase);
  if (undoStack.length > 60) undoStack.shift();
  undoBase = cur;
}

function undoLast() {
  if (!undoStack.length) { toast('Geri alınacak işlem yok'); return false; }
  let prev;
  try { prev = JSON.parse(undoStack.pop()); } catch { return false; }
  chartState.drawings = Array.isArray(prev.d) ? prev.d : [];
  chartState.plans = Array.isArray(prev.p) ? prev.p : [];
  chartState.selected = null;
  selectedPlanId = '';
  undoBase = snapshotState();
  saveDrawings();
  savePlans();
  applyPlanButtons();
  renderAlertSide();
  drawChart();
  toast('Geri alındı');
  return true;
}

function copySelected() {
  const d = chartState.selected != null ? chartState.drawings[chartState.selected] : null;
  if (d) {
    drawClipboard = { kind: 'drawing', data: JSON.parse(JSON.stringify(d)) };
    toast('Çizim kopyalandı (' + d.type + ')');
    return true;
  }
  const p = (chartState.plans || []).find((x) => x.id === selectedPlanId);
  if (p) {
    drawClipboard = { kind: 'plan', data: JSON.parse(JSON.stringify(p)) };
    toast('Plan kopyalandı (' + (p.side === 'long' ? 'LONG' : 'SHORT') + ')');
    return true;
  }
  toast('Kopyalamak için önce bir çizim/plan seç');
  return false;
}

function pasteClipboard() {
  if (!drawClipboard || !drawClipboard.data) { toast('Panoda çizim yok'); return false; }
  const data = JSON.parse(JSON.stringify(drawClipboard.data));
  /* klon tam üstüne gelmesin: 3 mum sağa + görünür aralığın %3'ü kadar aşağı kaydır */
  const rates = chartState.rates || [];
  const n = rates.length;
  const iv = n >= 2 ? Math.max(1, rates[n - 1].time - rates[n - 2].time) : 60;
  const dt = 3 * iv;
  const span = chartState.range ? (chartState.range.hi - chartState.range.lo) : 0;
  const dp = span > 0 ? span * 0.03 : 0;
  if (drawClipboard.kind === 'plan') {
    data.id = newId();
    data.follow = false;
    data.entry = Number(data.entry) - dp;
    data.sl = Number(data.sl) - dp;
    data.tp = Number(data.tp) - dp;
    data.t0 = (Number(data.t0) || 0) + dt;
    data.t1 = (Number(data.t1) || 0) + dt;
    chartState.plans.push(data);
    selectedPlanId = data.id;
    savePlans();
    applyPlanButtons();
    drawChart();
    toast('Plan yapıştırıldı (' + (data.side === 'long' ? 'LONG' : 'SHORT') + ')');
    return true;
  }
  /* çizim klonu: kimliği ve alarm bağlantısı kopyalanmaz */
  delete data.id;
  for (const pt of (data.points || [])) {
    if (typeof pt.t === 'number') pt.t += dt;
    if (typeof pt.p === 'number') pt.p -= dp;
  }
  chartState.drawings.push(data);
  chartState.selected = chartState.drawings.length - 1;
  saveDrawings();
  drawChart();
  toast('Çizim yapıştırıldı (' + data.type + ')');
  return true;
}

/* seçili olanı sil (alarm → plan → çizim): Del tuşu ve toolbox X butonu */
function eraseSelected() {
  if (selectedAlertId) {
    deleteAlert(selectedAlertId);
    return true;
  }
  if (selectedPlanId) {
    chartState.plans = (chartState.plans || []).filter((x) => x.id !== selectedPlanId);
    selectedPlanId = '';
    savePlans();
    applyPlanButtons();
    drawChart();
    toast('İşlem planı silindi');
    return true;
  }
  if (chartState.selected != null && chartState.drawings[chartState.selected]) {
    const t = chartState.drawings[chartState.selected].type;
    chartState.drawings.splice(chartState.selected, 1);
    chartState.selected = null;
    saveDrawings();
    drawChart();
    toast('Çizim silindi (' + t + ')');
    return true;
  }
  return false;
}

/* ---------- plan ayarları diyalogu (RR kilidi + risk yüzdesi) ---------- */
let rrPlanId = '';
let levMaxCache = { sym: '', max: 0 };

/* kaldıraç: sembole özel saklanır (kripto); 0 = oto (gerektiği kadar) */
function levSymbolOf(plan) {
  return String((plan && plan.symbol) || chartState.symbol || '').toUpperCase();
}
function levStored(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return 0;
  const v = Number(String(localStorage.getItem('jev.lever.' + sym) || localStorage.getItem('jev.lever') || '').replace(',', '.'));
  return v > 0 ? v : 0;
}
function cryptoLevFor(symbol) {
  return exName === 'mt5' ? 0 : levStored(symbol);
}
function rrLevSymbol() {
  const p = (chartState.plans || []).find((x) => x.id === rrPlanId);
  return levSymbolOf(p);
}

function planTpLabelText(p) {
  const ev = planEV(p);
  return 'TP: ' + Number(p.tp).toFixed(chartState.digits) + ' · ' + planRR(p).toFixed(1) + 'R' + (ev.ok ? ' · EV ' + fmtEv(ev.evR) : '');
}

function openPlanSettings() {
  const cur = (chartState.plans || []).find((p) => p.symbol === chartState.symbol) || null;
  openRrDialog(cur);
}

/* sekmenin max spread ayarı (puan); 0 = sınırsız */
function tabMaxSpread() {
  const t = activeTab();
  const v = t ? Number(t.maxSpread) : 0;
  return v > 0 ? v : 0;
}

/* MT5 tick yanıtından spread (puan): önce MT5'in kendi spread alanı,
   yoksa (ask - bid) / point */
function spreadFromTickResp(resp) {
  const data = resp && resp.ok && resp.data ? resp.data : null;
  if (!data) return 0;
  const sp = Number(data.spread) || 0;
  if (sp > 0) return Math.round(sp);
  return tickSpreadPts(data.tick, data.point);
}

/* (ask - bid) / point — point verilmezse grafik hanesinden */
function tickSpreadPts(tk, pt) {
  if (!tk) return 0;
  const bid = Number(tk.bid) || 0;
  const ask = Number(tk.ask) || 0;
  const p = Number(pt) > 0 ? Number(pt) : Math.pow(10, -chartState.digits);
  if (!(bid > 0) || !(ask > 0) || !(p > 0)) return 0;
  return Math.round((ask - bid) / p);
}

/* canlı spread (puan): MT5 alanı → tick farkı → son mumun spread'i */
function currentSpreadPts() {
  if (chartState.tickSpread > 0) return chartState.tickSpread;
  const sp = tickSpreadPts(chartState.tick, chartState.tickPoint);
  if (sp > 0) return sp;
  const rates = chartState.rates;
  return rates.length ? Math.round(Number(rates[rates.length - 1].spread) || 0) : 0;
}

/* market emirde lot/EV için canlı orta fiyat: MT5 tick → grafik son kapanış */
async function liveMidPrice(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (exName === 'mt5' && sym) {
    const t = await jev.mt5Ticks({ symbol: sym }).catch(() => null);
    const tk = t && t.ok && t.data ? t.data.tick : null;
    const bid = tk ? Number(tk.bid) || 0 : 0;
    const ask = tk ? Number(tk.ask) || 0 : 0;
    if (bid > 0 && ask > 0) return (bid + ask) / 2;
  }
  const rates = chartState.rates || [];
  return rates.length ? Number(rates[rates.length - 1].close) || 0 : 0;
}

function openRrDialog(plan) {
  rrPlanId = plan ? plan.id : '';
  const free = !plan || !(Number(plan.rr) > 0);
  $('#rrFree').checked = free;
  /* plan varsa kilitli RR ya da hesaplanan serbest RR; plan yoksa sekme varsayılanı */
  $('#rrInput').value = plan ? String(free ? Number(planRR(plan).toFixed(2)) : Number(plan.rr)) : String(tabDefaultRR());
  $('#rrInput').disabled = false;   /* değer her zaman yazılabilir */
  $('#rrRisk').value = String(planRiskPct());
  /* kaldıraç (yalnız kripto): sembole özel */
  const levSym = levSymbolOf(plan);
  const lev = levStored(levSym);
  $('#rrLev').value = lev > 0 ? String(lev) : '';
  levMaxCache = { sym: '', max: 0 };
  const levSec = $('#rrLevSec'), levRow = $('#rrLevRow'), levHint = $('#rrLevHint');
  const cryptoMode = exName !== 'mt5';
  levSec.hidden = !cryptoMode;
  levRow.hidden = !cryptoMode;
  levHint.hidden = !cryptoMode;
  if (cryptoMode) {
    levHint.textContent = 'Sembole özel kaydedilir. Boş = otomatik: teminat yetmezse sembol maksimumuna kadar yükseltilir.';
    const planIdAtOpen = plan ? plan.id : '';
    jev.exLeverageInfo({ symbol: levSym }).then((r) => {
      if (!r || !r.ok || !r.data || rrPlanId !== planIdAtOpen) return;
      const mx = Number(r.data.max) || 0;
      levMaxCache = { sym: levSym, max: mx };
      levHint.textContent = (Number(r.data.leverage) > 0 ? 'mevcut ' + Number(r.data.leverage) + 'x · ' : '') +
        (mx > 0 ? 'maks ' + mx + 'x · ' : '') + 'boş = oto (gerektiği kadar)';
    }).catch(() => {});
  }
  const ms = tabMaxSpread();
  $('#rrMaxSpread').value = ms > 0 ? String(ms) : '';
  /* beklenen değer (sekmeye özel): min EV + varsayılan olasılık; plana özel olasılık */
  $('#rrEvMin').value = String(tabEvMin());
  $('#rrEvProb').value = String(Math.round(tabEvProb() * 100));
  $('#rrEvEnforce').checked = tabEvEnforce();
  const ownP = normProb(plan && plan.p);
  $('#rrPlanPRow').hidden = !plan;
  $('#rrPlanP').value = ownP > 0 ? String(Math.round(ownP * 100)) : '';
  $('#rrPlanP').placeholder = 'varsayılan ' + Math.round(tabEvProb() * 100) + '%';
  const au = autoCfg(activeTab());
  $('#autoOn').checked = au.on;
  $('#autoTrailDistR').value = au.trailDistR > 0 ? String(au.trailDistR) : '';
  $('#autoTrailStepR').value = au.trailStepR > 0 ? String(au.trailStepR) : '';
  $('#autoTrailStartR').value = au.trailStartR > 0 ? String(au.trailStartR) : '';
  $('#autoTrailLockR').value = au.trailLockR > 0 ? String(au.trailLockR) : '';
  $('#autoTp1R').value = au.tp1R > 0 ? String(au.tp1R) : '';
  $('#autoTp1Pct').value = au.tp1Pct > 0 ? String(au.tp1Pct) : '';
  $('#autoTp2R').value = au.tp2R > 0 ? String(au.tp2R) : '';
  $('#autoTp2Pct').value = au.tp2Pct > 0 ? String(au.tp2Pct) : '';
  $('#autoBeTp1').checked = au.beAfterTp1;
  $('#jevAlertOn').checked = jevAlertAutoOn();
  $('#rrInfo').textContent = 'Otomatik lot = bakiye × risk% / SL mesafesi. Bakiye: ' + (chartState.account ? Number(chartState.account.balance).toFixed(2) + ' ' + (chartState.account.currency || '') : '—');
  $('#rrOverlay').hidden = false;
  setTimeout(() => $('#rrInput').focus(), 30);
}

function closeRrDialog() {
  $('#rrOverlay').hidden = true;
  rrPlanId = '';
}

function applyRrDialog() {
  const plan = (chartState.plans || []).find((x) => x.id === rrPlanId);
  const risk = Number(String($('#rrRisk').value).trim().replace(',', '.'));
  if (risk > 0) {
    try { localStorage.setItem('jev.risk', String(risk)); } catch {}
    const t = activeTab();
    if (t) { t.risk = risk; saveTabs(); }
  }
  /* kaldıraç: sembole özel (kripto) */
  let levTxt = '';
  if (exName !== 'mt5') {
    const sym = rrLevSymbol();
    const lvRaw = Number(String($('#rrLev').value).trim().replace(',', '.'));
    const lv = Number.isFinite(lvRaw) && lvRaw > 0 ? Math.max(1, Math.floor(lvRaw)) : 0;
    try {
      if (lv > 0 && sym) {
        localStorage.setItem('jev.lever.' + sym, String(lv));
        localStorage.setItem('jev.lever', String(lv));
      } else if (sym) {
        localStorage.removeItem('jev.lever.' + sym);
      }
    } catch {}
    levTxt = lv > 0 ? ' · kaldıraç ' + lv + 'x' : ' · kaldıraç oto';
  }
  const msRaw = Number(String($('#rrMaxSpread').value).trim().replace(',', '.'));
  const maxSp = Number.isFinite(msRaw) && msRaw > 0 ? msRaw : 0;
  {
    const t = activeTab();
    if (t) { t.maxSpread = maxSp; saveTabs(); }
  }
  /* beklenen değer: min EV + varsayılan olasılık (sekmeye özel); plana özel olasılık */
  const evMinRaw = Number(String($('#rrEvMin').value).trim().replace(',', '.'));
  const evMin = Number.isFinite(evMinRaw) && evMinRaw >= 0 ? Math.min(100, evMinRaw) : 0.05;
  const evProbRaw = Number(String($('#rrEvProb').value).trim().replace(',', '.'));
  const evProb = Number.isFinite(evProbRaw) && evProbRaw > 0 && evProbRaw <= 100 ? Math.round(evProbRaw) : 50;
  const evEnforce = $('#rrEvEnforce').checked;
  {
    const t = activeTab();
    if (t) { t.evMin = evMin; t.evProb = evProb; t.evEnforce = evEnforce; saveTabs(); }
  }
  if (plan) {
    const ownRaw = Number(String($('#rrPlanP').value).trim().replace(',', '.'));
    if (Number.isFinite(ownRaw) && ownRaw > 0 && ownRaw <= 100) plan.p = Math.round(ownRaw) / 100;
    else delete plan.p;
    savePlans();
  }
  /* Jev otomasyonu (genel): AI alarmı tetiklenince otomatik analiz */
  try { localStorage.setItem('jev.jevAlert', $('#jevAlertOn').checked ? '1' : '0'); } catch {}
  /* otomasyon (sekmeye özel) */
  const numOf = (sel) => {
    const v = Number(String($(sel).value).trim().replace(',', '.'));
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const au = normAuto({
    on: $('#autoOn').checked,
    trailOn: false,
    trailDistR: numOf('#autoTrailDistR'),
    trailStepR: numOf('#autoTrailStepR'),
    trailStartR: numOf('#autoTrailStartR'),
    trailLockR: numOf('#autoTrailLockR'),
    tp1R: numOf('#autoTp1R'),
    tp1Pct: numOf('#autoTp1Pct'),
    tp2R: numOf('#autoTp2R'),
    tp2Pct: numOf('#autoTp2Pct'),
    beAfterTp1: $('#autoBeTp1').checked,
  });
  {
    const t = activeTab();
    if (t) { t.auto = au; saveTabs(); }
  }
  const spTxt = maxSp > 0 ? ' · max spread ' + maxSp + ' puan' : '';
  const auTxt = au.on ? ' · otomasyon AÇIK' : '';
  const jaTxt = $('#jevAlertOn').checked ? ' · Jev alarm analizi AÇIK' : '';
  const evTxt = ' · min EV ' + evMin + 'R' + (evEnforce ? '' : ' (filtre kapalı)') + ' · p %' + evProb;
  /* RR: değer her zaman sekme varsayılanı olarak saklanır (yeni planlar bununla
     açılır); kilitli bir plan varsa TP de bu değere göre güncellenir */
  const rrRaw = Number(String($('#rrInput').value).trim().replace(',', '.'));
  const rrVal = Number.isFinite(rrRaw) && rrRaw > 0 ? Math.max(0.1, Math.min(100, rrRaw)) : 0;
  {
    const t = activeTab();
    if (t && rrVal > 0) { t.rr = rrVal; saveTabs(); }
  }
  const rrTxt = rrVal > 0 ? ' · RR ' + rrVal : '';
  if (plan) {
    if ($('#rrFree').checked) {
      plan.rr = 0;
    } else if (rrVal > 0) {
      plan.rr = rrVal;
      applyPlanRR(plan);
    }
    savePlans();
    drawChart();
    const evNow = planEV(plan);
    const evNowTxt = evNow.ok ? ' · EV ' + fmtEv(evNow.evR) + ' (p %' + Math.round(evNow.p * 100) + ')' : '';
    toast((plan.rr > 0 ? (plan.rr + 'R sabit · TP ' + Number(plan.tp).toFixed(chartState.digits) + ' · risk %' + planRiskPct()) : ('RR serbest · risk %' + planRiskPct())) + evNowTxt + spTxt + auTxt + levTxt + jaTxt);
  } else {
    toast('Risk ayarı kaydedildi: %' + planRiskPct() + rrTxt + evTxt + spTxt + auTxt + levTxt + jaTxt);
  }
  closeRrDialog();
}

/* ---------- otomatik lot (risk % × bakiye / SL mesafesi) ----------
   plan.risk verilirse (LLM emri) o risk % kullanılır, yoksa sekme riski */
async function computePlanLot(plan) {
  const risk = Number(plan.risk) > 0 ? Math.min(100, Number(plan.risk)) : planRiskPct();
  const balance = Number((chartState.account && chartState.account.balance) || 0);
  const dist = Math.abs(plan.entry - plan.sl);
  if (!(balance > 0) || !(dist > 0)) return 0;
  const r = await jev.mt5Symbols({ symbols: [plan.symbol] }).catch(() => null);
  const row = r && r.ok && r.data && Array.isArray(r.data.symbols) ? r.data.symbols[0] : null;
  if (!row || row.missing) return 0;
  const tickValue = Number(row.trade_tick_value);
  const tickSize = Number(row.trade_tick_size);
  if (!(tickValue > 0) || !(tickSize > 0)) return 0;
  const ticks = dist / tickSize;
  const riskMoney = (balance * risk) / 100;
  let lot = riskMoney / (ticks * tickValue);
  const step = Number(row.volume_step) || 0.01;
  const vmin = Number(row.volume_min) || 0.01;
  const vmax = Number(row.volume_max) || 1000;
  lot = Math.floor(lot / step) * step;
  lot = Math.max(vmin, Math.min(vmax, lot));
  const stepDec = (() => {
    const s = String(step);
    const i = s.indexOf('.');
    return i < 0 ? 0 : Math.min(8, s.length - i - 1);
  })();
  return Number(lot.toFixed(stepDec));
}

/* ---------- gün kurtarma (recover) lotu ----------
   Hedef: TP'de "targetMoney" kadar kazanacak lot. Risk, maxRiskPct (%) ile sınırlanır;
   sınır aşılırsa lot otomatik kısılır. {lot, capped, recoverActual, riskPct} döner. */
async function computeRecoverLot(symbol, entry, sl, tp, targetMoney, maxRiskPct) {
  const balance = Number((chartState.account && chartState.account.balance) || 0);
  const slD = Math.abs(Number(entry) - Number(sl));
  const tpD = Math.abs(Number(tp) - Number(entry));
  if (!(targetMoney > 0) || !(slD > 0) || !(tpD > 0)) return null;
  const r = await jev.mt5Symbols({ symbols: [symbol] }).catch(() => null);
  const row = r && r.ok && r.data && Array.isArray(r.data.symbols) ? r.data.symbols[0] : null;
  if (!row || row.missing) return null;
  const tickValue = Number(row.trade_tick_value);
  const tickSize = Number(row.trade_tick_size);
  if (!(tickValue > 0) || !(tickSize > 0)) return null;
  const step = Number(row.volume_step) || 0.01;
  const vmin = Number(row.volume_min) || 0.01;
  const vmax = Number(row.volume_max) || 1000;
  const stepDec = (() => {
    const s = String(step);
    const i = s.indexOf('.');
    return i < 0 ? 0 : Math.min(8, s.length - i - 1);
  })();
  const moneyPerLotTp = (tpD / tickSize) * tickValue;
  const moneyPerLotSl = (slD / tickSize) * tickValue;
  if (!(moneyPerLotTp > 0) || !(moneyPerLotSl > 0)) return null;
  const riskCapPct = Number(maxRiskPct) > 0 ? Math.min(10, Number(maxRiskPct)) : 2;
  const riskMoneyCap = balance > 0 ? (balance * riskCapPct) / 100 : 0;
  const lotCap = riskMoneyCap > 0 ? riskMoneyCap / moneyPerLotSl : 0;
  let lot = targetMoney / moneyPerLotTp;
  let capped = false;
  if (lotCap > 0 && lot > lotCap + 1e-9) { lot = lotCap; capped = true; }
  lot = Math.floor(lot / step) * step;
  if (!(lot > 0)) lot = vmin;
  lot = Math.max(vmin, Math.min(vmax, lot));
  lot = Number(lot.toFixed(stepDec));
  const recoverActual = Math.min(1, (lot * moneyPerLotTp) / targetMoney);
  const riskPct = balance > 0 ? ((lot * moneyPerLotSl) / balance) * 100 : 0;
  return { lot, capped, recoverActual, riskPct, riskCapPct };
}

/* işlem açılınca plan kapanır: kullanıcı tekrar işlem için yeniden kurmalı */
function closePlanAfterOrder(plan) {
  if (!plan) return;
  chartState.plans = (chartState.plans || []).filter((x) => x.id !== plan.id);
  if (selectedPlanId === plan.id) selectedPlanId = '';
  savePlans();
  applyPlanButtons();
  drawChart();
}

/* giriş yerine göre emir türü: markete yakınsa market (''), değilse limit/stop */
function pendingTypeFor(plan, cur) {
  const c = Number(cur);
  if (!(c > 0)) return '';
  const eps = Math.pow(10, -chartState.digits) * 2;
  const dist = Number(plan.entry) - c;
  if (Math.abs(dist) <= eps) return '';
  if (plan.side === 'long') return dist < 0 ? 'buy_limit' : 'buy_stop';
  return dist > 0 ? 'sell_limit' : 'sell_stop';
}

/* işleme gir: modal yok.
   Magnet açıkken (giriş = canlı fiyat) market emri; kapalıyken ve kutu başka
   yerdeyse Buy Limit / Buy Stop / Sell Limit / Sell Stop bekleyen emri gönderilir. */
let enterBusy = false;

/* emir sonucundaki uyarılar (TP/SL kurulamadı, kaldıraç uygulanamadı) → toast sonuna eklenir */
function orderWarnSuffix(data) {
  if (!data) return '';
  const w = [];
  if (data.warning) { w.push(data.warning); termLogAdd('EMİR UYARISI · ' + data.warning, 'sl'); }
  if (data.leverage_warning) { w.push('kaldıraç: ' + data.leverage_warning); termLogAdd('KALDIRAÇ · ' + data.leverage_warning, 'sys'); }
  return w.length ? ' · UYARI: ' + w.join(' · ') : '';
}

async function enterTradeNow(plan) {
  if (!plan || enterBusy || mt5Busy > 0) return;
  if (!plan.symbol || !(plan.entry > 0)) return;
  enterBusy = true;
  mt5Begin();
  try {
    if (plan.follow && chartState.rates.length) {
      const price = Number(chartState.rates[chartState.rates.length - 1].close);
      const d = price - plan.entry;
      plan.entry = price;
      plan.sl += d;
      plan.tp += d;
      savePlans();
      drawChart();
    }
    /* Plan seviyeleri kullanıcının belirlediği gibi kalır; SL/TP mesafesine dokunulmaz. */
    const lot = await computePlanLot(plan);
    if (!(lot > 0)) {
      toast('Hacim hesaplanamadı — bakiye/sembol bilgisi yok');
      return;
    }
    /* beklenen değer: manuel girişte bilgilendirme (engel yok); filtre açıkken min altı uyarır */
    const ev = planEV(plan);
    if (ev.ok) {
      jevLogAdd('BEKLENEN DEĞER · manuel giriş ' + plan.side.toUpperCase() + ' ' + plan.symbol + ' · RR ' + ev.rr.toFixed(2) +
        ' · p %' + Math.round(ev.p * 100) + ' · EV ' + fmtEv(ev.evR) + evMoneyTxt(ev.evR), 'info');
      if (tabEvEnforce() && ev.evR < tabEvMin()) {
        toast('UYARI: beklenen değer düşük (EV ' + fmtEv(ev.evR) + ' < min ' + tabEvMin() + 'R) — yine de açılıyor');
      }
    }
    /* güncel fiyat (bid/ask) */
    let cur = 0;
    const t = await jev.mt5Ticks({ symbol: plan.symbol }).catch(() => null);
    const tk = t && t.ok && t.data ? t.data.tick : null;
    if (tk) {
      const bid = Number(tk.bid) || 0;
      const ask = Number(tk.ask) || 0;
      if (bid > 0 && ask > 0) cur = (bid + ask) / 2;
    }
    if (!(cur > 0) && chartState.rates.length) cur = Number(chartState.rates[chartState.rates.length - 1].close);
    const spreadPts = spreadFromTickResp(t) || currentSpreadPts();
    /* magnet açıksa (giriş = canlı fiyat) her zaman market; bekleyen emir yalnızca
       magnet kapalıyken ve kutu marketten uzaktayken (limit/stop) gönderilir */
    const pendingType = plan.follow ? '' : pendingTypeFor(plan, cur);

    if (!pendingType) {
      /* sekmenin max spread filtresi (0 = sınırsız) */
      const maxSp = tabMaxSpread();
      if (maxSp > 0 && spreadPts > maxSp) {
        toast('Spread çok yüksek (' + spreadPts + ' > ' + maxSp + ' puan) — işlem açılmadı');
        return;
      }
      const res = await jev.mt5Market({
        symbol: plan.symbol,
        side: plan.side === 'long' ? 'buy' : 'sell',
        volume: lot,
        sl: plan.sl,
        tp: plan.tp,
        comment: 'JevTrader plan',
        ...(exName !== 'mt5' ? { leverage: cryptoLevFor(plan.symbol) } : {}),
      }).catch(() => null);
      if (res && res.ok) {
        const price = res.data && res.data.price ? Number(res.data.price).toFixed(chartState.digits) : '';
        const lv = res.data && Number(res.data.leverage) > 0 ? Number(res.data.leverage) : 0;
        toast('İşlem açıldı (market): ' + (plan.side === 'long' ? 'BUY' : 'SELL') + ' ' + plan.symbol + ' ' + lot + ' lot · risk %' + planRiskPct() + (ev.ok ? ' · EV ' + fmtEv(ev.evR) + evMoneyTxt(ev.evR) : '') + (lv > 0 ? ' · ' + lv + 'x' : '') + (price ? ' @ ' + price : '') + orderWarnSuffix(res.data));
        closePlanAfterOrder(plan);
        posView = 'pos';
        refreshPositions();
        refreshOrders();
        drawChart();
      } else {
        toast('İşlem açılamadı: ' + ((res && res.error) || 'bilinmeyen hata'));
        termLogAdd('İŞLEM AÇILAMADI · ' + ((res && res.error) || 'bilinmeyen hata'), 'sl');
      }
      return;
    }

    const res = await jev.mt5Pending({
      symbol: plan.symbol,
      type: pendingType,
      volume: lot,
      price: plan.entry,
      sl: plan.sl,
      tp: plan.tp,
      comment: 'JevTrader plan',
      ...(exName !== 'mt5' ? { leverage: cryptoLevFor(plan.symbol) } : {}),
    }).catch(() => null);
    if (res && res.ok) {
      const label = pendingType.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      toast('Bekleyen emir: ' + label + ' ' + plan.symbol + ' ' + lot + ' lot @ ' + Number(plan.entry).toFixed(chartState.digits) + ' · risk %' + planRiskPct() + (ev.ok ? ' · EV ' + fmtEv(ev.evR) + evMoneyTxt(ev.evR) : '') + orderWarnSuffix(res.data));
      termLogAdd('BEKLEYEN EMİR · ' + label + ' ' + plan.symbol + ' ' + lot + ' lot @ ' + Number(plan.entry).toFixed(chartState.digits), 'open');
      closePlanAfterOrder(plan);
      posView = 'ord';
      refreshPositions();
      refreshOrders();
      drawChart();
    } else {
      toast('Emir gönderilemedi: ' + ((res && res.error) || 'bilinmeyen hata'));
      termLogAdd('EMİR GÖNDERİLEMEDİ · ' + ((res && res.error) || 'bilinmeyen hata'), 'sl');
    }
  } finally {
    mt5End();
    enterBusy = false;
  }
}

/* ---------- alarm ayarları (varsayılan ses + süre) ---------- */
function openAlertSet() {
  $('#asSound').value = alertDefaultSound();
  $('#asRepeat').value = String(alertSoundRepeat());
  $('#alertSetOverlay').hidden = false;
}

function closeAlertSet() {
  $('#alertSetOverlay').hidden = true;
}

function saveAlertSet() {
  try {
    localStorage.setItem('jev.alertSoundId', $('#asSound').value || 'klasik');
    localStorage.setItem('jev.alertSoundRepeat', String(Math.max(1, Math.min(10, Math.round(Number($('#asRepeat').value) || 1)))));
  } catch {}
  toast('Alarm ayarları: ' + alertSoundName($('#asSound').value) + ' · ' + alertSoundRepeat() + ' kez');
  closeAlertSet();
}

/* ---------- emoji seçici + emoji damgası ---------- */
const EMOJIS = [
  '😀','😄','😅','😂','🙂','😉','😍','😎','🤔','😐',
  '😴','🤯','😱','😭','😤','😡','🤢','🤒','🤠','🥳',
  '🚀','📈','📉','💹','💰','💵','🤑','💎','🪙','🏦',
  '🔥','⚡','✨','⭐','🌟','💥','❗','❓','⚠️','🚫',
  '✅','❌','✔️','➕','➖','⬆️','⬇️','➡️','⬅️','🔔',
  '🎯','🏆','🥇','📌','📍','🧲','🔒','🔓','⏰','⏳',
  '🐂','🐻','🦈','🐋','🦅','🐍','🌙','☀️','🌧️','❄️',
];

function renderEmojiPicker() {
  const grid = $('#emojiGrid');
  if (!grid || grid.dataset.built === '1') return;
  grid.innerHTML = '';
  for (const ch of EMOJIS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = ch;
    b.title = ch;
    b.addEventListener('click', () => {
      chartState.emojiChar = ch;
      closeEmojiPicker();
      setDrawTool('emoji');
      toast('Emoji seçildi ' + ch + ' — grafiğe tıkla');
    });
    grid.appendChild(b);
  }
  grid.dataset.built = '1';
}

function openEmojiPicker() {
  renderEmojiPicker();
  $('#emojiOverlay').hidden = false;
}

function closeEmojiPicker() {
  $('#emojiOverlay').hidden = true;
}

/* ---------- işlem açma diyalogu (plan kutusundaki giriş butonu) ---------- */
let orderPlanId = '';

function openOrderDialog(plan) {
  if (!plan) return;
  orderPlanId = plan.id;
  $('#orderTitle').textContent = 'İŞLEM AÇ — ' + (plan.side === 'long' ? 'LONG' : 'SHORT');
  $('#orderSym').textContent = plan.symbol;
  $('#orderSide').textContent = plan.side === 'long' ? 'Buy (Long)' : 'Sell (Short)';
  $('#orderEntry').textContent = Number(plan.entry).toFixed(chartState.digits) + ' · market';
  $('#orderSl').textContent = Number(plan.sl).toFixed(chartState.digits);
  $('#orderTp').textContent = Number(plan.tp).toFixed(chartState.digits);
  const lot = Number(localStorage.getItem('jev.lot') || 0) || 0.01;
  $('#orderVol').value = String(lot);
  $('#orderMsg').textContent = '';
  $('#orderOverlay').hidden = false;
  setTimeout(() => $('#orderVol').focus(), 30);
}

function closeOrderDialog() {
  $('#orderOverlay').hidden = true;
  orderPlanId = '';
}

async function submitOrder() {
  const plan = (chartState.plans || []).find((x) => x.id === orderPlanId);
  if (!plan) { closeOrderDialog(); return; }
  const vol = Number(String($('#orderVol').value).trim().replace(',', '.'));
  if (!(vol > 0)) { $('#orderMsg').textContent = 'Geçerli bir hacim gir'; return; }
  try { localStorage.setItem('jev.lot', String(vol)); } catch {}
  /* sekmenin max spread filtresi (0 = sınırsız) */
  const maxSp = tabMaxSpread();
  if (maxSp > 0) {
    const t = await jev.mt5Ticks({ symbol: plan.symbol }).catch(() => null);
    const sp = spreadFromTickResp(t) || currentSpreadPts();
    if (sp > maxSp) {
      $('#orderMsg').textContent = 'Spread çok yüksek (' + sp + ' > ' + maxSp + ' puan) — işlem açılmadı';
      return;
    }
  }
  $('#orderOk').disabled = true;
  mt5Begin();
  try {
    $('#orderMsg').textContent = 'Gönderiliyor…';
    /* Plan seviyeleri kullanıcının belirlediği gibi kalır; SL/TP mesafesine dokunulmaz. */
    const res = await jev.mt5Market({
      symbol: plan.symbol,
      side: plan.side === 'long' ? 'buy' : 'sell',
      volume: vol,
      sl: plan.sl,
      tp: plan.tp,
      comment: 'JevTrader plan',
      ...(exName !== 'mt5' ? { leverage: cryptoLevFor(plan.symbol) } : {}),
    }).catch(() => null);
    if (res && res.ok) {
      const price = res.data && res.data.price ? Number(res.data.price).toFixed(chartState.digits) : '';
      const lv = res.data && Number(res.data.leverage) > 0 ? Number(res.data.leverage) : 0;
      toast('İşlem açıldı: ' + (plan.side === 'long' ? 'BUY' : 'SELL') + ' ' + plan.symbol + ' ' + vol + ' lot' + (lv > 0 ? ' · ' + lv + 'x' : '') + (price ? ' @ ' + price : '') + orderWarnSuffix(res.data));
      $('#orderMsg').textContent = '';
      closeOrderDialog();
      refreshPositions();
      drawChart();
    } else {
      $('#orderMsg').textContent = 'Hata: ' + ((res && res.error) || 'bilinmeyen');
      termLogAdd('İŞLEM AÇILAMADI · ' + ((res && res.error) || 'bilinmeyen'), 'sl');
    }
  } finally {
    mt5End();
    $('#orderOk').disabled = false;
  }
}

/* ---------- alarmlar: kenar çubuğu listesi + diyalog ---------- */
let selectedAlertId = '';

function deleteAlert(id) {
  const a = (chartState.alerts || []).find((x) => x.id === id);
  if (!a) return;
  chartState.alerts = chartState.alerts.filter((x) => x.id !== id);
  if (selectedAlertId === id) selectedAlertId = '';
  if (alertEditId === id) closeAlertDialog();
  saveAlerts();
  renderAlertSide();
  drawChart();
  toast('Alarm silindi: ' + a.symbol + ' ' + nf(a.price, decOf(a.price)));
}

function renderAlertSide() {
  const list = $('#alertSideList');
  if (!list) return;
  const alerts = (chartState.alerts || []).slice().sort((x, y) =>
    x.symbol === y.symbol ? y.price - x.price : String(x.symbol).localeCompare(String(y.symbol)));
  $('#alertCount').textContent = alerts.length ? '(' + alerts.length + ')' : '';
  list.innerHTML = '';
  if (!alerts.length) {
    const e = document.createElement('div');
    e.className = 'alert-empty';
    e.textContent = 'Alarm yok — + ile ekle';
    list.appendChild(e);
    return;
  }
  if (selectedAlertId && !alerts.some((x) => x.id === selectedAlertId)) selectedAlertId = '';
  for (const a of alerts) {
    const row = document.createElement('div');
    row.className = 'alert-row' + (a.active ? '' : ' triggered') + (a.id === selectedAlertId ? ' selected' : '');
    row.title = (a.note ? a.note + ' · ' : '') + (a.repeat ? 'Tekrarlı · ' + (a.tf || chartState.tf) + ' mumunda 1 kez' : 'Tek seferlik') + ' · ' + (a.active ? 'aktif' : 'tetiklendi') + (a.ex && a.ex !== exName ? ' · ' + exLabel(a.ex) : '') + ' — seçip Del ile sil';
    row.innerHTML =
      '<span class="alert-dot"></span>' +
      '<span class="alert-sym">' + escapeHtml(a.symbol) + '</span>' +
      '<span class="alert-price">' + nf(a.price, decOf(a.price)) + '</span>' +
      (a.repeat ? '<span class="alert-rep" title="Tekrarlı: ' + escapeHtml(a.tf || chartState.tf) + ' mumunda 1 kez">&#x21BB;' + escapeHtml(a.tf || chartState.tf) + '</span>' : '') +
      '<span class="alert-cond">' + alertCondText(a.cond) + '</span>' +
      '<button class="alert-del" title="Alarmı sil">✕</button>';
    row.addEventListener('click', () => {
      selectedAlertId = a.id;
      renderAlertSide();
      openAlertDialog(a.id);
    });
    row.querySelector('.alert-del').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteAlert(a.id);
    });
    list.appendChild(row);
  }
}

let alertEditId = '';
/* diyalog açılırken sembol sabitlenir (2. grafikten kurulan alarm doğru sembole yazılsın) */
let alertDialogSym = '';

function openAlertDialog(id) {
  const a = id ? (chartState.alerts || []).find((x) => x.id === id) : null;
  alertEditId = a ? a.id : '';
  alertDialogSym = (a && a.symbol) || chartState.symbol;
  $('#alertsTitle').textContent = a ? 'ALARMI DÜZENLE' : 'ALARM KUR';
  $('#alertSym').textContent = alertDialogSym;
  $('#alertPrice').value = a ? String(a.price) : (chartState.rates.length ? String(chartState.rates[chartState.rates.length - 1].close) : '');
  $('#alertCond').value = a ? a.cond : 'cross';
  $('#alertRepeat').value = a && a.repeat ? '1' : '0';
  $('#alertSoundSel').value = a && a.sound ? a.sound : alertDefaultSound();
  $('#alertNote').value = a ? (a.note || '') : '';
  $('#alertSave').textContent = a ? 'Kaydet' : 'Alarm kur';
  $('#alertDelete').hidden = !a;
  $('#alertsOverlay').hidden = false;
  setTimeout(() => $('#alertPrice').focus(), 30);
}

function closeAlertDialog() {
  $('#alertsOverlay').hidden = true;
  alertEditId = '';
}

function saveAlertFromDialog() {
  const price = Number(String($('#alertPrice').value).trim().replace(',', '.'));
  if (!(price > 0)) { toast('Geçerli bir fiyat gir'); return; }
  const cond = $('#alertCond').value;
  const repeat = $('#alertRepeat').value === '1';
  const sound = $('#alertSoundSel').value || 'klasik';
  const note = $('#alertNote').value.trim().slice(0, 60);
  if (alertEditId) {
    const a = (chartState.alerts || []).find((x) => x.id === alertEditId);
    if (a) {
      a.price = price;
      a.cond = cond;
      a.repeat = repeat;
      a.sound = sound;
      a.note = note;
      a.active = true;
      a.triggeredAt = 0;
      a.last = null;
      a.cooldownBar = 0;
      if (!a.tf) a.tf = chartState.tf;   /* eski kayıt: TF yoksa aktif grafik TF'i */
      if (!a.ex) a.ex = exName;
      toast('Alarm güncellendi: ' + a.symbol + ' ' + nf(price, decOf(price)));
    }
  } else {
    chartState.alerts.push({
      id: newId(),
      symbol: alertDialogSym || chartState.symbol,
      price,
      cond,
      repeat,
      sound,
      note,
      active: true,
      triggeredAt: 0,
      drawingId: '',
      edge: 'top',
      ex: exName,
      tf: chartState.tf,   /* tekrarlıysa bu TF'in mumunda bir kez çalar */
      last: null,
      cooldownBar: 0,
    });
    toast('Alarm kuruldu: ' + (alertDialogSym || chartState.symbol) + ' ' + nf(price, decOf(price)) + ' · ' + alertCondText(cond) + (repeat ? ' · tekrarlı' : ' · tek'));
  }
  saveAlerts();
  renderAlertSide();
  drawChart();
  closeAlertDialog();
}

/* ---------- açık pozisyonlar ---------- */
function nf(v, d = 2) {
  return Number(v).toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function decOf(v) {
  const s = String(Number(v));
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(5, s.length - i - 1);
}

function posTime(sec) {
  const d = new Date(Number(sec) * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  /* MT5 sunucu saati = PC saati (TR): ham değer UTC getter'ları ile gösterilir */
  return p2(d.getUTCDate()) + '.' + p2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
}

/* ---------- sağdan açılan MT5 listesi (tüm liste + tüm semboller) ---------- */
let clSymFilter = '';

async function refreshAllSymbols(force) {
  if (chartState.symFetching) return;
  if (!force && (chartState.allSymbols || []).length) return;
  chartState.symFetching = true;
  /* MT5'teki TÜM semboller (yalnızca Market Watch değil) */
  const r = await jev.mt5AllSymbols({ visible_only: false }).catch(() => null);
  chartState.symFetching = false;
  if (r && r.ok && r.data && Array.isArray(r.data.symbols)) {
    const rows = r.data.symbols;
    const next = rows.map((s) => s.name).filter(Boolean).slice(0, 8000).sort();
    const prev = chartState.allSymbols || [];
    const changed = next.length !== prev.length || next.some((v, i) => v !== prev[i]);
    chartState.allSymbols = next;
    /* liste değişmediyse yeniden çizme: arama kutusu odağı kaybolmasın */
    if (changed) renderSymbolList();
  }
}

/* favori semboller (panelde ★) */
let clTab = 'sym';  // 'sym' | 'fav'
let favSymbols = new Set();
try {
  const raw = JSON.parse(localStorage.getItem('jev.favs') || '[]');
  if (Array.isArray(raw)) favSymbols = new Set(raw.map((x) => String(x).toUpperCase()));
} catch {}
function saveFavs() {
  try { localStorage.setItem('jev.favs', JSON.stringify([...favSymbols])); } catch {}
}
function toggleFav(sym) {
  const s = String(sym || '').toUpperCase();
  if (!s) return;
  if (favSymbols.has(s)) favSymbols.delete(s);
  else favSymbols.add(s);
  saveFavs();
  renderSymbolList();
}

function renderSymbolList() {
  const box = $('#clSymbols');
  if (!box) return;
  /* yeniden çizimde arama odağı/imleç korunur */
  const prevF = (document.activeElement && document.activeElement.id === 'clSymFilter') ? document.activeElement : null;
  const caret = prevF && typeof prevF.selectionStart === 'number' ? prevF.selectionStart : 0;
  const all = chartState.allSymbols || [];
  const favCount = all.filter((s) => favSymbols.has(String(s).toUpperCase())).length;
  const syms = clTab === 'fav' ? all.filter((s) => favSymbols.has(String(s).toUpperCase())) : all;
  const out = [];
  /* sekmeler + arama: liste kaydırılırken üstte sabit kalır */
  out.push('<div id="clSticky">');
  out.push('<div id="clTabs">' +
    '<span class="cl-tab' + (clTab === 'sym' ? ' active' : '') + '" data-tab="sym">SEMBOLLER (' + all.length + ')</span>' +
    '<span class="cl-tab' + (clTab === 'fav' ? ' active' : '') + '" data-tab="fav">FAVORİLER (' + favCount + ')</span>' +
    '</div>');
  out.push('<input id="clSymFilter" class="cl-filter" placeholder="' + (clTab === 'fav' ? 'Favoride ara…' : 'Sembol ara…') + '" autocomplete="off" value="' + escapeHtml(clSymFilter) + '" />');
  out.push('</div>');
  out.push('<div id="clSymRows">');
  if (!syms.length) {
    out.push('<div class="cl-empty">' + (clTab === 'fav' ? 'Favori sembol yok — listede ☆ simgesine basarak ekle' : 'Yükleniyor…') + '</div>');
  }
  for (const s of syms) {
    const on = favSymbols.has(String(s).toUpperCase());
    out.push('<div class="cl-row cl-symrow" data-sym="' + escapeHtml(s) + '" data-name="' + escapeHtml(String(s).toLowerCase()) + '">' +
      '<span class="cl-sym">' + escapeHtml(s) + '</span>' +
      '<button class="cl-star' + (on ? ' on' : '') + '" data-fav="' + escapeHtml(s) + '" title="Favorilere ekle / çıkar">' + (on ? '★' : '☆') + '</button>' +
      '</div>');
  }
  out.push('</div>');
  box.innerHTML = out.join('');
  for (const el of box.querySelectorAll('.cl-tab')) {
    el.addEventListener('click', () => { clTab = el.dataset.tab; renderSymbolList(); });
  }
  for (const el of box.querySelectorAll('.cl-symrow')) {
    el.addEventListener('click', () => setChartSymbol(el.dataset.sym));
  }
  for (const b of box.querySelectorAll('.cl-star')) {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFav(b.dataset.fav);
    });
  }
  const f = box.querySelector('#clSymFilter');
  if (f) {
    const apply = () => {
      clSymFilter = f.value;
      const q = clSymFilter.trim().toLowerCase();
      for (const el of box.querySelectorAll('.cl-symrow')) {
        el.style.display = (!q || el.dataset.name.includes(q)) ? '' : 'none';
      }
    };
    f.addEventListener('input', apply);
    apply();
    if (prevF) {
      f.focus();
      try { f.setSelectionRange(caret, caret); } catch {}
    }
  }
}

function renderChartList() {
  const body = $('#clData');
  if (!body) return;
  /* panelde de satırlar yer değiştirmesin: ticket'a göre sabit sıra */
  const byTicket = (a, b) => Number(a.ticket || 0) - Number(b.ticket || 0);
  const rows = (chartState.positions || []).slice().sort(byTicket);
  const orders = (chartState.orders || []).slice().sort(byTicket);
  const closed = chartState.closed || [];
  const ordTypes = { 2: 'buy limit', 3: 'sell limit', 4: 'buy stop', 5: 'sell stop' };
  const out = [];
  const pnlCls = (v) => (v >= 0 ? 'up' : 'down');
  out.push('<div class="cl-sec">AÇIK POZİSYONLAR (' + rows.length + ')</div>');
  if (!rows.length) out.push('<div class="cl-empty">Yok</div>');
  for (const p of rows) {
    const sell = Number(p.type) === 1;
    const pr = posProfit(p);
    out.push('<div class="cl-row" data-sym="' + escapeHtml(p.symbol) + '">' +
      '<span class="cl-sym">' + escapeHtml(p.symbol) + '</span>' +
      '<span class="cl-type ' + (sell ? 'pos-sell' : 'pos-buy') + '">' + (sell ? 'sell' : 'buy') + '</span>' +
      '<span class="cl-vol">' + nf(p.volume) + '</span>' +
      '<span class="cl-price">' + nf(p.price_open, decOf(p.price_open)) + '</span>' +
      '<span class="cl-pnl ' + pnlCls(pr) + '">' + nf(pr) + '</span>' +
      '</div>');
  }
  out.push('<div class="cl-sec">BEKLEYEN EMİRLER (' + orders.length + ')</div>');
  if (!orders.length) out.push('<div class="cl-empty">Yok</div>');
  for (const o of orders) {
    const vol = Number(o.volume_current || o.volume_initial || 0);
    const tn = ordTypes[Number(o.type)] || 'emir';
    const buy = Number(o.type) === 2 || Number(o.type) === 4;
    out.push('<div class="cl-row" data-sym="' + escapeHtml(o.symbol) + '">' +
      '<span class="cl-sym">' + escapeHtml(o.symbol) + '</span>' +
      '<span class="cl-type ' + (buy ? 'pos-buy' : 'pos-sell') + '">' + tn + '</span>' +
      '<span class="cl-vol">' + nf(vol) + '</span>' +
      '<span class="cl-price">' + nf(o.price_open, decOf(o.price_open)) + '</span>' +
      '</div>');
  }
  out.push('<div class="cl-sec">KAPANANLAR — bugün (' + closed.length + ')</div>');
  if (!closed.length) out.push('<div class="cl-empty">Yok</div>');
  for (const c of closed) {
    const buy = Number(c.type) === 0;
    const pr = Number(c.profit || 0) + Number(c.swap || 0) + Number(c.commission || 0);
    out.push('<div class="cl-row" data-sym="' + escapeHtml(c.symbol) + '">' +
      '<span class="cl-sym">' + escapeHtml(c.symbol) + '</span>' +
      '<span class="cl-type ' + (buy ? 'pos-buy' : 'pos-sell') + '">' + (buy ? 'buy' : 'sell') + '</span>' +
      '<span class="cl-vol">' + nf(c.volume) + '</span>' +
      '<span class="cl-price">' + nf(c.close_price, decOf(c.close_price)) + '</span>' +
      '<span class="cl-pnl ' + pnlCls(pr) + '">' + nf(pr) + '</span>' +
      '</div>');
  }
  body.innerHTML = out.join('');
  for (const el of body.querySelectorAll('.cl-row[data-sym]')) {
    el.addEventListener('click', () => setChartSymbol(el.dataset.sym));
  }
}

/* ---------- sembol bilgisi önbelleği (potansiyel kâr hesabı için) ---------- */
async function ensureSymInfo(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return;
  const cur = chartState.symInfo && chartState.symInfo[sym];
  if (cur && Date.now() - cur.at < 60000) return;
  const r = await jev.mt5Symbols({ symbols: [sym] }).catch(() => null);
  const row = r && r.ok && r.data && Array.isArray(r.data.symbols) ? r.data.symbols[0] : null;
  if (!row || row.missing) return;
  chartState.symInfo = chartState.symInfo || {};
  chartState.symInfo[sym] = {
    at: Date.now(),
    tickValue: Number(row.trade_tick_value) || 0,
    tickSize: Number(row.trade_tick_size) || 0,
    volumeMin: Number(row.volume_min) || 0,
    volumeStep: Number(row.volume_step) || 0,
    digits: Number(row.digits) || 0,
    stopsLevel: Number(row.trade_stops_level) || 0,
  };
}

/* pozisyon/emir için hedef fiyattaki potansiyel kâr (tick değerinden) */
function potentialTxt(pos, target, isOrder) {
  const info = chartState.symInfo && chartState.symInfo[chartState.symbol];
  if (!info || !(info.tickValue > 0) || !(info.tickSize > 0)) return '';
  const t = Number(target);
  const open = Number(pos.price_open);
  const vol = Number(pos.volume_current || pos.volume_initial || pos.volume || 0);
  if (!(t > 0) || !(open > 0) || !(vol > 0)) return '';
  let buy;
  if (isOrder) buy = Number(pos.type) === 2 || Number(pos.type) === 4;
  else buy = Number(pos.type) === 0;  /* 0 = buy pozisyon */
  const dir = buy ? 1 : -1;
  const v = (t - open) * dir * vol * (info.tickValue / info.tickSize);
  const curCode = (chartState.account && chartState.account.currency) || '';
  return ' (' + (v >= 0 ? '+' : '') + v.toFixed(2) + (curCode ? ' ' + curCode : '') + ')';
}

/* fiyatlardan potansiyel RR metni: |TP-giriş| / |giriş-SL| */
function rrRatioTxt(entry, sl, tp) {
  const e = Number(entry);
  const s = Number(sl);
  const t = Number(tp);
  if (!(e > 0) || !(s > 0) || !(t > 0)) return '';
  const risk = Math.abs(e - s);
  if (!(risk > 0)) return '';
  return ' · ' + (Math.abs(t - e) / risk).toFixed(1) + 'R';
}

/* pozisyon/emir için potansiyel RR */
function posRrTxt(pos) {
  return pos ? rrRatioTxt(pos.price_open, pos.sl, pos.tp) : '';
}

/* grup (birleşik) kutu toplam potansiyeli: her üyenin KENDİ SL/TP'sine göre toplam.
   TP yanında toplam potansiyel kâr, SL yanında toplam potansiyel zarar için kullanılır. */
function clusterPotentialTxt(c, part) {
  const info = chartState.symInfo && chartState.symInfo[chartState.symbol];
  if (!info || !(info.tickValue > 0) || !(info.tickSize > 0)) return '';
  const rate = info.tickValue / info.tickSize;
  let sum = 0;
  for (const m of c || []) {
    const p = m && m.p ? m.p : m;
    if (!p) continue;
    const open = Number(p.price_open) || 0;
    const t = Number(part === 'sl' ? p.sl : p.tp) || 0;
    const vol = Number(p.volume_current || p.volume_initial || p.volume || 0);
    if (!(open > 0) || !(t > 0) || !(vol > 0)) continue;
    const dir = Number(p.type) === 0 ? 1 : -1;
    sum += (t - open) * dir * vol * rate;
  }
  if (!(Math.abs(sum) > 0.004)) return '';
  const cur = (chartState.account && chartState.account.currency) || '';
  return ' (' + (sum >= 0 ? '+' : '') + sum.toFixed(2) + (cur ? ' ' + cur : '') + ')';
}

/* ---------- pozisyon hızlı işlemler: kısmi kapatma + BE/SE ---------- */
function stepDecimals(step) {
  const s = String(Number(step));
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(8, s.length - i - 1);
}

function symInfoOf(symbol) {
  return (chartState.symInfo && chartState.symInfo[String(symbol || '').toUpperCase()]) || null;
}

async function symTradeInfo(symbol) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym) return null;
  await ensureSymInfo(sym).catch(() => {});
  return symInfoOf(sym);
}

/* bu pozisyonun KENDİ realize kâr/zararı (aynı işlemdeki kısmi kapanışlar).
   Sembolle eşleşen kapanışlar (kripto net mod) yalnız bu pozisyonun açıldığı andan
   sonra kapananlardır; aynı semboldeki ÖNCEKİ pozisyonların kapanışları karışmaz. */
function realizedForPosition(pid, symbol, openTime) {
  const id = String(pid);
  const sym = String(symbol || '').toUpperCase();
  const t0 = Number(openTime) || 0;
  let sum = 0;
  for (const c of chartState.closed || []) {
    const matchId = String(c.position_id) === id;
    /* kripto net modda sembol başına tek pozisyon: fill kimliği tutmasa da sembolle eşleştir */
    const matchSym = !matchId && exName !== 'mt5' && sym && String(c.symbol || '').toUpperCase() === sym;
    if (!matchId && !matchSym) continue;
    if (matchSym && t0 > 0 && Number(c.close_time || 0) < t0) continue;
    sum += Number(c.profit || 0) + Number(c.swap || 0) + Number(c.commission || 0);
  }
  return sum;
}

/* BE fiyatı: işlem toplamı (kısmi kapanışlar + kalan pozisyon neti, komisyon/swap
   dahil) = 0 olan fiyat. Böylece stop "giriş" değil gerçek başabaş noktası olur. */
function bePriceFor(p, realized) {
  const info = symInfoOf(p.symbol);
  const rate = info && info.tickValue > 0 && info.tickSize > 0 ? info.tickValue / info.tickSize : 0;
  const open = Number(p.price_open) || 0;
  const vol = Number(p.volume) || 0;
  if (!(rate > 0) || !(open > 0) || !(vol > 0)) return null;
  const costs = Number(p.swap || 0) + Number(p.commission || 0);
  const dir = Number(p.type) === 1 ? -1 : 1;
  const digits = info.digits > 0 ? Number(info.digits) : decOf(open);
  return Number((open + (-realized - costs) / (dir * vol * rate)).toFixed(Math.min(8, digits)));
}

/* bugünün başlangıcı — MT5 zamanları sunucu saati tabanlı olduğundan
   yerel takvim günü Date.UTC ile aynı tabana çevrilir */
function serverDayStart() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 1000);
}

/* bugün kapanan işlemlerin net kâr/zararı (komisyon + swap dahil) */
async function todayRealizedPnl() {
  const r = await jev.mt5Closed({ from_ts: serverDayStart(), open_lookback_days: 7 }).catch(() => null);
  const fetched = !!(r && r.ok && r.data && Array.isArray(r.data.positions));
  if (fetched) chartState.closed = r.data.positions;
  let sum = 0;
  for (const c of chartState.closed || []) {
    sum += Number(c.profit || 0) + Number(c.swap || 0) + Number(c.commission || 0);
  }
  return { sum, ok: fetched || (chartState.closed || []).length > 0 };
}

/* kapatılacak hacmi hesapla: baseVol'un frac kadarı, lot adımı/min lota göre.
   Kalan hacim min lotun altında kalıyorsa tamamı kapatılır. */
function calcCloseVolume(info, baseVol, frac, curVol) {
  const step = info && info.volumeStep > 0 ? info.volumeStep : 0.01;
  const vmin = info && info.volumeMin > 0 ? info.volumeMin : step;
  const cur = Number(curVol) || 0;
  const base = Number(baseVol) || 0;
  if (!(cur > 0) || !(base > 0) || !(frac > 0)) return 0;
  const vd = stepDecimals(step);
  let vol = Math.floor((base * frac) / step + 1e-9) * step;
  vol = Number(vol.toFixed(vd));
  if (vol < vmin) vol = vmin;
  if (vol > cur || cur - vol < vmin - 1e-9) vol = cur;
  return vol;
}

async function closePartialPosition(p, pct, quiet) {
  mt5Begin();
  try {
    const info = await symTradeInfo(p.symbol);
    const cur = Number(p.volume) || 0;
    if (!(cur > 0)) { if (!quiet) toast('Hacim okunamadı'); return false; }
    const vol = calcCloseVolume(info, cur, pct, cur);
    if (!(vol > 0)) { if (!quiet) toast('Hacim hesaplanamadı'); return false; }
    const vd = stepDecimals(info && info.volumeStep > 0 ? info.volumeStep : 0.01);
    const label = '%' + Math.round(pct * 100);
    const res = await jev.mt5ClosePosition({ ticket: p.ticket, volume: vol }).catch(() => null);
    if (res && res.ok) {
      if (!quiet) {
        const kalan = vol < cur ? ' · kalan ' + nf(cur - vol, vd) : ' (tamamı)';
        toast(label + ' kapatıldı · #' + p.ticket + ' · ' + nf(vol, vd) + ' lot' + kalan);
        pushToast(label + ' KAPATILDI', p.symbol + ' · ' + nf(vol, vd) + ' lot' + kalan + ' · #' + p.ticket, 'trade-open');
      }
      termLogAdd(label + ' · ' + p.symbol + ' #' + p.ticket + ' · ' + nf(vol, vd) + ' lot kapatıldı' + (vol < cur ? ' (kalan ' + nf(cur - vol, vd) + ')' : ' (tamamı)'), 'close');
      return true;
    }
    if (!quiet) toast(label + ' kapatma başarısız: ' + ((res && res.error) || '?'));
    return false;
  } finally { mt5End(); }
}

/* SL güncelle: TP korunur (yoksa 0 gönderilirse TP silinirdi) */
/* hızlı kapat (kısayol): kilit korumalı */
async function quickClosePosition(p) {
  if (!p || mt5Busy > 0) return false;
  mt5Begin();
  try {
    const res = await jev.mt5ClosePosition({ ticket: p.ticket }).catch(() => null);
    if (res && res.ok) {
      toast('Pozisyon kapatıldı #' + p.ticket + ' (' + p.symbol + ')');
      pushToast('POZİSYON KAPATILDI', p.symbol + ' · #' + p.ticket, 'trade-open');
      termLogAdd('KAPATILDI (manuel) · ' + p.symbol + ' #' + p.ticket, 'close');
      refreshPositions();
      return true;
    }
    toast('Kapatma başarısız: ' + ((res && res.error) || '?'));
    return false;
  } finally { mt5End(); }
}

async function setPositionSl(p, sl, label, quiet) {
  mt5Begin();
  try {
    const info = await symTradeInfo(p.symbol);
    const digits = info && info.digits > 0 ? Number(info.digits) : decOf(p.price_open);
    const price = Number(Number(sl).toFixed(Math.min(8, digits)));
    const tp = Number(p.tp) || 0;
    const res = await jev.mt5Modify({ ticket: p.ticket, sl: price, tp }).catch(() => null);
    if (res && res.ok) {
      if (!quiet) {
        toast(label + ' · #' + p.ticket + ' ' + p.symbol + ' SL ' + nf(price, decOf(price)));
        pushToast(label + ' YAPILDI', p.symbol + ' · SL ' + nf(price, decOf(price)) + ' · #' + p.ticket, 'trade-open');
        termLogAdd(label + ' · ' + p.symbol + ' #' + p.ticket + ' SL ' + nf(price, decOf(price)), 'trail');
      }
      return true;
    }
    if (!quiet) toast(label + ' başarısız: ' + ((res && res.error) || '?'));
    return false;
  } finally { mt5End(); }
}

/* BE: SL'i başabaş fiyatına çek (kısmi kapanışlar taze çekilir) */
async function breakEvenPosition(p, quiet) {
  const rp = await todayRealizedPnl();
  if (!rp.ok && !quiet) toast('Kapanan işlemler alınamadı — kısmi kâr dahil edilemedi');
  const sl = bePriceFor(p, realizedForPosition(p.ticket, p.symbol, p.time));
  if (sl == null) {
    if (!quiet) toast('BE için sembol bilgisi alınamadı (' + p.symbol + ')');
    return false;
  }
  const cur = Number(p.price_current) || 0;
  if (cur > 0 && (Number(p.type) === 1 ? sl <= cur : sl >= cur)) {
    if (!quiet) toast('BE: başabaş fiyatı piyasanın gerisinde (işlem toplamı henüz 0 altında) — SL çekilemedi');
    return false;
  }
  return setPositionSl(p, sl, 'BE', quiet);
}

/* ---------- toplu hızlı işlemler ---------- */
async function closePartialMany(list, pct, label) {
  if (!list.length) { toast(label + ': kapatılacak pozisyon yok'); return; }
  mt5Begin();
  try {
    let ok = 0, fail = 0;
    for (const p of list) {
      const r = await closePartialPosition(p, pct, true);
      if (r) ok++; else fail++;
    }
    toast(label + ': ' + ok + ' pozisyon' + (fail ? ' · ' + fail + ' başarısız' : ''));
    pushToast(label, ok + ' pozisyon' + (fail ? ' · ' + fail + ' başarısız' : ''), 'trade-open');
  } finally { mt5End(); }
  refreshPositions();
  refreshClosed();
}

async function beMany(list, label) {
  if (!list.length) { toast(label + ': pozisyon yok'); return; }
  mt5Begin();
  try {
    const rp = await todayRealizedPnl();
    if (!rp.ok) toast('Kapanan işlemler alınamadı — kısmi kâr dahil edilemedi');
    let ok = 0, fail = 0;
    for (const p of list) {
      const sl = bePriceFor(p, realizedForPosition(p.ticket, p.symbol, p.time));
      if (sl == null) { fail++; continue; }
      const cur = Number(p.price_current) || 0;
      if (cur > 0 && (Number(p.type) === 1 ? sl <= cur : sl >= cur)) { fail++; continue; }
      const r = await setPositionSl(p, sl, 'BE', true);
      if (r) ok++; else fail++;
    }
    toast(label + ': ' + ok + ' pozisyon' + (fail ? ' · ' + fail + ' başarısız' : ''));
    pushToast(label, ok + ' pozisyon' + (fail ? ' · ' + fail + ' başarısız' : ''), 'trade-open');
  } finally { mt5End(); }
  refreshPositions();
}

async function seMany(list, label) {
  if (!list.length) { toast(label + ': pozisyon yok'); return; }
  mt5Begin();
  try {
    let ok = 0, fail = 0;
    for (const p of list) {
      const r = await setPositionSl(p, Number(p.price_open), 'SE', true);
      if (r) ok++; else fail++;
    }
    toast(label + ': ' + ok + ' pozisyon' + (fail ? ' · ' + fail + ' başarısız' : ''));
    pushToast(label, ok + ' pozisyon' + (fail ? ' · ' + fail + ' başarısız' : ''), 'trade-open');
  } finally { mt5End(); }
  refreshPositions();
}

/* ---------- otomasyon: trailing stop + R bazlı kısmi TP (sekmeye özel) ----------
   R = giriş ile pozisyonun ilk görüldüğü andaki SL mesafesi. Ticket başına meta
   localStorage'da tutulur; böylece TP1/TP2 bir kez uygulanır. */
const AUTO_META_KEY = 'jev.autoMeta';

function loadAutoMeta() {
  try {
    const raw = JSON.parse(localStorage.getItem(AUTO_META_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function saveAutoMeta(m) {
  try { localStorage.setItem(AUTO_META_KEY, JSON.stringify(m)); } catch {}
}

/* ---------- trailing göstergesi: aktif trailing varsa SL etiketine TRAIL eklenir ---------- */
let autoMetaCache = { at: 0, data: null };
function autoMetaCached() {
  if (!autoMetaCache.data || Date.now() - autoMetaCache.at > 5000) {
    autoMetaCache = { at: Date.now(), data: loadAutoMeta() };
  }
  return autoMetaCache.data;
}

function trailCfgFor(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const t = (chartTabs || []).find((x) => String(x.symbol || '').toUpperCase() === sym) || activeTab();
  if (!t) return null;
  const c = autoCfg(t);
  if (!(c.trailDistR > 0)) return null;
  return c;
}

/* trailing durumu: takipteyse ' · TRAIL', eşik bekleniyorsa ' · TRAIL 0,4R/1R' */
function trailTagFor(p) {
  const m = autoMetaCached()[String(p.ticket)];
  if (!m || m.trail !== true) return '';
  const c = trailCfgFor(p.symbol);
  if (!c) return '';
  const entry = Number(p.price_open) || 0;
  const cur = Number(p.price_current) || 0;
  const sl0 = Number(m && m.sl0) || 0;
  if (!(entry > 0) || !(cur > 0) || !(sl0 > 0)) return ' · TRAIL';
  const dir = Number(p.type) === 1 ? -1 : 1;
  const rd = Math.abs(entry - sl0);
  if (!(rd > 0)) return ' · TRAIL';
  const rNow = ((cur - entry) * dir) / rd;
  if (rNow >= c.trailStartR) return ' · TRAIL';
  return ' · TRAIL ' + rNow.toFixed(1) + 'R/' + c.trailStartR + 'R';
}

/* pozisyona özel trailing aç/kapa */
function togglePositionTrail(p, btn) {
  const cfgT = trailCfgFor(p.symbol);
  if (!cfgT) {
    toast('Önce plan ayarlarından trailing puanını gir');
    return;
  }
  const meta = loadAutoMeta();
  const tk = String(p.ticket);
  const m = meta[tk] || (meta[tk] = {
    entry: Number(p.price_open) || 0,
    sl0: Number(p.sl) || 0,
    vol0: Number(p.volume) || 0,
    tp1: false, tp2: false,
  });
  m.trail = !(m.trail === true);
  m.at = Date.now();
  saveAutoMeta(meta);
  autoMetaCache = { at: 0, data: null };
  if (btn) btn.classList.toggle('active', m.trail);
  /* durum bilgisi: başlangıç fiyatı ve şu anki R */
  const entry = Number(p.price_open) || 0;
  const cur = Number(p.price_current) || 0;
  const sl0 = Number(m.sl0) || 0;
  const dir = Number(p.type) === 1 ? -1 : 1;
  const rd = Math.abs(entry - sl0);
  const infoT = symInfoOf(p.symbol);
  const dgT = infoT && infoT.digits > 0 ? Number(infoT.digits) : decOf(entry);
  const startPx = rd > 0 ? (dir === 1 ? entry + cfgT.trailStartR * rd : entry - cfgT.trailStartR * rd) : 0;
  const rNow = (entry > 0 && cur > 0 && rd > 0) ? ((cur - entry) * dir) / rd : 0;
  const durum = !m.trail
    ? ''
    : (rd <= 0
      ? 'SL olmadığı için R tabanı yok — SL eklenince başlar'
      : (rNow >= cfgT.trailStartR
        ? 'şimdi takipte'
        : 'başlangıç ' + nf(startPx, dgT) + ' (' + cfgT.trailStartR + 'R) · şu an ' + rNow.toFixed(2) + 'R'));
  toast('Trailing ' + (m.trail ? 'AÇIK' : 'KAPALI') + ' · #' + p.ticket + ' ' + p.symbol + (m.trail ? ' · ' + cfgT.trailDistR + 'R mesafe · ' + cfgT.trailStepR + 'R adım · ' + durum : ''));
  if (m.trail) pushToast('TRAIL AÇILDI', p.symbol + ' · #' + p.ticket + ' · ' + cfgT.trailDistR + 'R mesafe · ' + durum, 'trade-trail');
  drawChart();
}

async function runAutomation() {
  if (chartState.autoBusy) return;
  const positions = chartState.positions || [];
  if (!positions.length) return;
  const tabs = (chartTabs || []).map((t) => ({ t, c: autoCfg(t) }));
  const meta0 = loadAutoMeta();
  /* çalışacak iş var mı: sekme otomasyonu açık ya da pozisyona özel trailing */
  const anyAuto = tabs.some((x) => x.c.on);
  const anyTrail = positions.some((p) => {
    const m = meta0[String(p.ticket)];
    return !!(m && m.trail === true);
  });
  if (!anyAuto && !anyTrail) return;
  chartState.autoBusy = true;
  try {
    const meta = meta0;
    let metaDirty = false;
    let acted = false;
    const openIds = new Set(positions.map((p) => String(p.ticket)));
    for (const p of positions) {
      const sym = String(p.symbol || '').toUpperCase();
      /* sembolün sekme ayarı (yoksa aktif sekme) */
      const cfg = tabs.find((x) => String(x.t.symbol || '').toUpperCase() === sym) || tabs.find((x) => x.t.id === activeTabId);
      if (!cfg) continue;
      const c = cfg.c;
      const tk = String(p.ticket);
      const entry = Number(p.price_open) || 0;
      const cur = Number(p.price_current) || 0;
      const dir = Number(p.type) === 1 ? -1 : 1;
      let m = meta[tk];
      if (!m || Number(m.entry) !== entry) {
        m = meta[tk] = {
          entry, sl0: Number(p.sl) || 0, vol0: Number(p.volume) || 0,
          tp1: false, tp2: false,
          trail: !!(m && m.trail === true),
        };
        metaDirty = true;
      }
      m.at = Date.now();
      /* SL sonradan eklendiyse R tabanını yakala */
      if (!(Number(m.sl0) > 0) && Number(p.sl) > 0) { m.sl0 = Number(p.sl); metaDirty = true; }
      const rd = Math.abs(entry - Number(m.sl0));
      if (!(rd > 0) || !(cur > 0) || !(entry > 0)) continue;
      const rNow = ((cur - entry) * dir) / rd;

      /* kısmi TP1 / TP2 (sekme otomasyonu açıksa) */
      if (c.on) {
        for (const lvl of [1, 2]) {
          const r = lvl === 1 ? c.tp1R : c.tp2R;
          const pct = lvl === 1 ? c.tp1Pct : c.tp2Pct;
          const doneKey = lvl === 1 ? 'tp1' : 'tp2';
          if (!(r > 0) || !(pct > 0) || m[doneKey] || !(rNow >= r)) continue;
          const info = await symTradeInfo(p.symbol);
          const curVol = Number(p.volume) || 0;
          const vol = calcCloseVolume(info, Number(m.vol0) || curVol, pct / 100, curVol);
          if (!(vol > 0)) { m[doneKey] = true; metaDirty = true; continue; }
          const res = await jev.mt5ClosePosition({ ticket: p.ticket, volume: vol }).catch(() => null);
          if (res && res.ok) {
            m[doneKey] = true;
            metaDirty = true;
            acted = true;
            toast('Otomasyon · TP' + lvl + ': #' + p.ticket + ' %' + pct + ' kapatıldı (' + rNow.toFixed(2) + 'R)');
            termLogAdd('OTOMASYON TP' + lvl + ' · ' + p.symbol + ' #' + p.ticket + ' %' + pct + ' kapatıldı (' + rNow.toFixed(2) + 'R)', 'tp');
            if (lvl === 1 && c.beAfterTp1) {
              await todayRealizedPnl();
              const slBe = bePriceFor(p, realizedForPosition(p.ticket, p.symbol, p.time));
              const cur2 = Number(p.price_current) || cur;
              if (slBe != null && !(Number(p.type) === 1 ? slBe <= cur2 : slBe >= cur2)) {
                await setPositionSl(p, slBe, 'Otomasyon BE', true);
                termLogAdd('OTOMASYON BE · ' + p.symbol + ' #' + p.ticket + ' SL → ' + nf(slBe, decOf(slBe)), 'trail');
              }
            }
          }
        }
      }

      /* trailing stop: YALNIZ KÂRDA başlar; ilk adımda SL kâra çekilir (kâr kilidi), sonra mesafe korunur.
         - başlangıç: rNow >= trailStartR (SWING varsayılanı 1R)
         - kilit: SL en az trailLockR kâra çekilir (varsayılan 0.5R)
         - mesafe: fiyatın gerisinde distR (varsayılan 1R); gürültüde stop olmasın diye geniş tutulur
         - adım: trailStepR (varsayılan 0.5R) altındaki oynamalar yok sayılır */
      if (m.trail === true) {
        const startR = c.trailStartR > 0 ? c.trailStartR : 1;
        if (rNow >= startR) {
          const info = await symTradeInfo(p.symbol);
          const pt = info && info.digits > 0 ? Math.pow(10, -Number(info.digits)) : Math.pow(10, -chartState.digits);
          const minD = Math.max(Number(info && info.stopsLevel) || 0, 1) * pt;
          const lockR = c.trailLockR > 0 ? c.trailLockR : Math.max(0.1, startR / 2);
          const distR = c.trailDistR > 0 ? c.trailDistR : Math.max(1, lockR);
          const dist = Math.max(distR * rd, minD, 0.25 * rd);
          const lockPx = dir === 1 ? entry + lockR * rd : entry - lockR * rd;
          const trailPx = dir === 1 ? cur - dist : cur + dist;
          let desired = dir === 1 ? Math.max(trailPx, lockPx) : Math.min(trailPx, lockPx);
          /* fiyata çok yakın olmasın: borsa stop mesafesi kadar geride kalsın */
          desired = dir === 1 ? Math.min(desired, cur - minD) : Math.max(desired, cur + minD);
          /* yalnız KÂRDA: SL girişin ilerisinde değilse hiç dokunma */
          const inProfit = dir === 1 ? desired > entry : desired < entry;
          const slNow = Number(p.sl) || 0;
          const step = Math.max(Number(c.trailStepR) * rd, 0.5 * rd, pt * 0.5);
          const better = slNow <= 0 || (dir === 1 ? desired > slNow : desired < slNow);
          if (inProfit && better && Math.abs(desired - slNow) >= step) {
            const ok = await setPositionSl(p, desired, 'Otomasyon trail', true);
            if (ok) {
              acted = true;
              const dg = info && info.digits > 0 ? Number(info.digits) : decOf(desired);
              const stepTxt = c.trailStepR > 0 ? c.trailStepR + 'R' : '0,5R';
              const lockTxt = (dir === 1 ? desired >= entry : desired <= entry) ? ' · kâr kilidi +' + lockR + 'R' : '';
              pushToast('TRAIL · SL TAŞINDI', p.symbol + ' · SL ' + nf(desired, dg) + ' · adım ' + stepTxt + lockTxt + ' · #' + p.ticket, 'trade-trail');
              termLogAdd('TRAIL · ' + p.symbol + ' #' + p.ticket + ' SL ' + nf(slNow, dg) + ' → ' + nf(desired, dg) + ' (' + rNow.toFixed(2) + 'R · adım ' + stepTxt + lockTxt + ')', 'trail');
            }
          }
        }
      }
    }
    /* kapanmış ticket'ların meta'sını temizle (3 günden eski) */
    const cutoff = Date.now() - 3 * 86400000;
    for (const k of Object.keys(meta)) {
      if (openIds.has(k)) continue;
      if (!(Number(meta[k] && meta[k].at) > cutoff)) { delete meta[k]; metaDirty = true; }
    }
    if (metaDirty) saveAutoMeta(meta);
    if (acted) { refreshPositions(); refreshClosed(); }
  } finally {
    chartState.autoBusy = false;
  }
}

/* ---------- işlem bildirimleri: giriş ve SL/TP kapanışları ---------- */
let posWatchReady = false;
let posWatchMap = new Map();

function tradePosLine(p) {
  const info = symInfoOf(p.symbol);
  const dec = info && info.digits > 0 ? Math.min(5, info.digits) : decOf(p.price_open);
  return (Number(p.type) === 1 ? 'SELL' : 'BUY') + ' ' + nf(p.volume) + ' ' + p.symbol + ' @ ' + nf(p.price_open, dec);
}

async function notifyClosedTrades(gone) {
  /* grafikte başka sembol açık olsa da kapanan pozisyonun detayı bulunsun: filtre yok */
  const r = await jev.mt5Closed({ from_ts: serverDayStart(), open_lookback_days: 7 }).catch(() => null);
  const closed = r && r.ok && r.data && Array.isArray(r.data.positions) ? r.data.positions : [];
  const notes = [];
  for (const p of gone) {
    const c = closed.find((x) => String(x.position_id) === String(p.ticket));
    if (!c) {
      termLogAdd('KAPANDI · ' + p.symbol + ' #' + p.ticket + ' (kapanış detayı bekleniyor)', 'close');
      notes.push(p.symbol + ' #' + p.ticket + ' kapandı');
      continue;  /* manuel kapanışların kendi bildirimi var */
    }
    const close = Number(c.close_price) || 0;
    const reason = Number(c.reason);
    const info = symInfoOf(p.symbol);
    const dec = info && info.digits > 0 ? Math.min(5, info.digits) : decOf(close || p.price_open);
    const pt = info && info.digits > 0 ? Math.pow(10, -info.digits) : Math.max(1e-9, Math.abs(close) * 1e-6);
    const tol = pt * 5;
    const sl = Number(p.sl) || 0;
    const tp = Number(p.tp) || 0;
    /* MT5 deal reason: 4 = SL, 5 = TP; yoksa fiyat eşleşmesine bak */
    const isTp = reason === 5 || (reason !== 4 && tp > 0 && Math.abs(close - tp) <= tol);
    const isSl = reason === 4 || (reason !== 5 && sl > 0 && Math.abs(close - sl) <= tol);
    const pr = Number(c.profit || 0) + Number(c.swap || 0) + Number(c.commission || 0);
    const body = p.symbol + ' ' + (pr >= 0 ? '+' : '') + nf(pr) + ' · ' + nf(close, dec);
    if (isTp) {
      pushToast('TP HEDEFİ', body, 'trade-tp');
      termLogAdd('TP · ' + body + ' · #' + p.ticket, 'tp');
      notes.push(body + ' · TP ile kapandı · #' + p.ticket);
    } else if (isSl) {
      pushToast('STOP', body, 'trade-sl');
      termLogAdd('STOP · ' + body + ' · #' + p.ticket, 'sl');
      notes.push(body + ' · SL ile kapandı · #' + p.ticket);
    } else {
      termLogAdd('KAPANDI · ' + body + ' · #' + p.ticket, 'close');
      notes.push(body + ' · kapandı · #' + p.ticket);
    }
  }
  if (notes.length) {
    intgBroadcast('ISLEM_KAPANDI', notes.join('\n'), { noHistory: true });
    jevNotifyTrade('close', notes);
  }
}

/* her yenilemede pozisyon listesini karşılaştır: yeni giriş / kapanış bildirimi */
function watchPositionChanges() {
  const cur = new Map((chartState.positions || []).map((p) => [String(p.ticket), p]));
  if (!posWatchReady) {
    posWatchReady = true;
    posWatchMap = cur;
    return;
  }
  const opened = [];
  for (const [t, p] of cur) {
    if (!posWatchMap.has(t)) {
      pushToast('İŞLEME GİRİLDİ', tradePosLine(p), 'trade-open');
      termLogAdd('İŞLEME GİRİLDİ · ' + tradePosLine(p) + ' · #' + p.ticket, 'open');
      opened.push(tradePosLine(p) + ' · #' + p.ticket);
    }
  }
  const gone = [];
  for (const [t, p] of posWatchMap) {
    if (!cur.has(t)) gone.push(p);
  }
  posWatchMap = cur;
  if (gone.length) notifyClosedTrades(gone);
  if (opened.length) {
    intgBroadcast('ISLEM_ACILDI', opened.join('\n'), { noHistory: true });
    jevNotifyTrade('open', opened);
  }
}

async function refreshPositions() {
  if (chartState.posBusy || posDragActive || pane2.session) return false;
  chartState.posBusy = true;
  const seq = exSeq;
  const r = await jev.mt5Positions().catch(() => null);
  chartState.posBusy = false;
  if (seq !== exSeq) return false;  /* borsa değişti */
  if (r && r.ok && r.data) {
    chartState.positions = Array.isArray(r.data.positions) ? r.data.positions : [];
    watchPositionChanges();
    /* BE sütunu için pozisyon sembollerinin tick/lot bilgisi gerekli */
    const syms = [...new Set(chartState.positions.map((p) => String(p.symbol || '').toUpperCase()).filter(Boolean))];
    if (syms.length) await Promise.all(syms.map((s) => ensureSymInfo(s).catch(() => {})));
    renderPositions();
    renderChartList();
    drawChart();
    /* otomasyon: trailing + kısmi TP (sekmeye özel ayarlarla) */
    runAutomation();
    return true;
  }
  return false;
}

async function refreshOrders() {
  if (chartState.ordBusy || posDragActive || pane2.session) return false;
  chartState.ordBusy = true;
  const seq = exSeq;
  const r = await jev.mt5Orders().catch(() => null);
  chartState.ordBusy = false;
  if (seq !== exSeq) return false;  /* borsa değişti */
  if (r && r.ok && r.data) {
    chartState.orders = Array.isArray(r.data.orders) ? r.data.orders : [];
    /* sabit ondalık için emir sembollerinin bilgisi önbelleğe */
    const syms = [...new Set(chartState.orders.map((o) => String(o.symbol || '').toUpperCase()).filter(Boolean))];
    if (syms.length) await Promise.all(syms.map((s) => ensureSymInfo(s).catch(() => {})));
    renderPositions();
    renderChartList();
    drawChart();
    /* OCO takibi: gruptan biri tetiklendiyse diğerini iptal et */
    checkOcoGroups().catch(() => {});
    return true;
  }
  return false;
}

async function refreshClosed() {
  if (chartState.histBusy || pane2.session) return false;
  chartState.histBusy = true;
  const seq = exSeq;
  /* bugünün tamamı: 00:00'dan şimdiye, TÜM semboller (grafikte seçili sembolle sınırlanmaz) */
  const r = await jev.mt5Closed({ from_ts: serverDayStart(), open_lookback_days: 7 }).catch(() => null);
  chartState.histBusy = false;
  if (seq !== exSeq) return false;  /* borsa değişti */
  if (r && r.ok && r.data) {
    chartState.closed = Array.isArray(r.data.positions) ? r.data.positions : [];
    /* kapananlar kalıcı performans hafızasına TEK SEFER yazılır (öğrenme katmanı) */
    try { journalSyncClosed(chartState.closed); } catch {}
    dayGuardCache = { at: 0, val: null };
    renderPositions();
    renderChartList();
    return true;
  }
  return false;
}

/* geçmiş borsa verisini kalıcı hafızaya bir kez taşı: uygulama yeni açıldığında
   istatistik (isabet/kâr faktörü/kalibrasyon) hemen dolu olsun */
const JOURNAL_BACKFILL_KEY = 'jev.journalBackfill';

async function journalBackfill(force) {
  /* hafıza boşken damga yazılmaz: aksi halde kullanıcı hafızayı sıfırlayıp 12 saat
     boyunca geçmişin geri gelmemesi durumu yaşanır */
  try {
    const stamp = Number(localStorage.getItem(JOURNAL_BACKFILL_KEY) || 0);
    const cur = await jev.journalGet({ days: 1 }).catch(() => null);
    if (cur && cur.ok && cur.total === 0) { try { localStorage.removeItem(JOURNAL_BACKFILL_KEY); } catch {} }
    else if (!force && stamp && Date.now() - stamp < 12 * 3600000) return 0;
    localStorage.setItem(JOURNAL_BACKFILL_KEY, String(Date.now()));
  } catch {}
  const from = Math.floor(Date.now() / 1000) - 30 * 86400;
  const r = await jev.mt5Closed({ from_ts: from, open_lookback_days: 30 }).catch(() => null);
  if (!(r && r.ok && r.data && Array.isArray(r.data.positions))) return 0;
  const rows = r.data.positions;
  /* yalnız tam kapanan işlemler (birden çok parça varsa son parça) */
  const byTk = new Map();
  for (const c of rows) {
    const k = String(c.position_id != null && c.position_id !== '' ? c.position_id : c.symbol || '');
    byTk.set(k, (byTk.get(k) || 0) + 1);
  }
  let n = 0;
  for (const c of rows) {
    const k = String(c.position_id != null && c.position_id !== '' ? c.position_id : c.symbol || '');
    if (byTk.get(k) > 1) continue;
    n += journalSyncClosed([c]);
  }
  if (n) {
    jevLogAdd('PERFORMANS HAFIZASI · ' + n + ' geçmiş işlem tarandı (30 gün)', 'info');
  }
  return n;
}

function posProfit(p) {
  return Number(p.profit || 0) + Number(p.swap || 0) + Number(p.commission || 0);
}

/* açık pozisyon / bekleyen emir SL-TP çizgisi isabet testi (sürüklenebilir) */
let posDragActive = false;

function hitPositionLevel(mx, my, g) {
  if (!chartState.showLevels && !chartState.showPosBox) return null;
  /* plan açıkken pozisyon seviyeleri gizli */
  if ((chartState.plans || []).some((pl) => pl.symbol === chartState.symbol)) return null;
  const list = (chartState.positions || []).filter((p) => String(p.symbol || '').toUpperCase() === chartState.symbol);
  const yHit = (p, part, x0, x1) => {
    const v = Number(p[part]);
    if (!(v > 0)) return false;
    const y = g.yOf(v);
    if (y < g.padT - 1 || y > g.padT + g.plotH + 1) return false;
    return Math.abs(my - y) <= 6 && mx >= x0 && mx <= x1;
  };
  if (chartState.showPosBox) {
    /* kutu modu: SL/TP yalnızca GÖRÜNÜR kutunun üzerinde sürüklenebilir */
    const clusters = clusterPositionBoxes(list, g);
    for (let ci = clusters.length - 1; ci >= 0; ci--) {
      const c = clusters[ci];
      if (c.length > 1) {
        /* grup kapalıyken üyeler görünmez: sürüklenemez */
        if (posClusterKey(c) !== posGroupCycle.key) continue;
        const i = Math.max(0, Math.min(posGroupCycle.idx, c.length - 1));
        const m = c[i];
        for (const part of ['sl', 'tp']) {
          if (yHit(m.p, part, m.r.x0, m.r.x1)) return { kind: 'pos', pos: m.p, part };
        }
      } else {
        const m = c[0];
        /* tek kutu: SL/TP ancak kutu SEÇİLİYKEN sürüklenebilir (önce tıkla, sonra çek) */
        if (String(m.p.ticket) !== selectedPosTicket) continue;
        for (const part of ['sl', 'tp']) {
          if (yHit(m.p, part, m.r.x0, m.r.x1)) return { kind: 'pos', pos: m.p, part };
        }
      }
    }
    return null;
  }
  /* kutu modu kapalı: kesikli seviye çizgileri (tam genişlik) */
  const x0 = g.padL, x1 = g.padL + g.plotW;
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    for (const part of ['sl', 'tp']) {
      if (yHit(p, part, x0, x1)) return { kind: 'pos', pos: p, part };
    }
  }
  return null;
}

function hitOrderLevel(mx, my, g) {
  if (!chartState.showOrdLevels) return null;
  const list = (chartState.orders || []).filter((o) => String(o.symbol || '').toUpperCase() === chartState.symbol);
  for (let i = list.length - 1; i >= 0; i--) {
    const o = list[i];
    for (const part of ['sl', 'tp']) {
      const v = Number(o[part]);
      if (!(v > 0)) continue;
      const y = g.yOf(v);
      if (y < g.padT - 1 || y > g.padT + g.plotH + 1) continue;
      if (Math.abs(my - y) <= 6 && mx >= g.padL && mx <= g.padL + g.plotW) return { kind: 'ord', ord: o, part };
    }
  }
  return null;
}

let posView = 'pos';  // 'pos' | 'ord' | 'hist' | 'term' | 'jev'

/* ---------- terminal: arka plan işlem günlüğü ---------- */
let termLog = [];
function termLogAdd(text, kind) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const t = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  const full = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + t;
  termLog.push({ t, text: String(text), kind: kind || 'sys' });
  if (termLog.length > 400) termLog.splice(0, termLog.length - 400);
  /* kalıcı log dosyasına da yaz (Ayarlar > Loglar) */
  try { jev.logAppend(full + ' ' + text); } catch {}
  if (posView === 'term') renderTerminal();
}

function renderTerminal() {
  const el = $('#termBody');
  if (!el) return;
  el.innerHTML = termLog
    .map((l) => '<div class="tl-line"><span class="tl-time">' + l.t + '</span><span class="tl-' + l.kind + '">' + escapeHtml(l.text) + '</span></div>')
    .join('');
  const sc = $('#posScroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
}

/* ---------- JEV: Jev'in yaptıkları günlüğü ---------- */
let jevLog = [];
let jevStatus = { posAt: '', histAt: '' };

function jevNow() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

function jevLogAdd(text, kind) {
  jevLog.push({ t: jevNow(), text: String(text), kind: kind || 'info' });
  if (jevLog.length > 500) jevLog.splice(0, jevLog.length - 500);
  if (posView === 'jev') renderJevLog();
}

/* kontrol turu: aynı kaynaktan art arda gelen turlar tek satırda birleşir (×N) */
function jevCycleLog(src, text) {
  const last = jevLog[jevLog.length - 1];
  if (last && last.kind === 'cycle' && last.src === src) {
    last.n = (last.n || 1) + 1;
    last.t = jevNow();
    last.text = String(text);
  } else {
    jevLog.push({ t: jevNow(), text: String(text), kind: 'cycle', src, n: 1 });
    if (jevLog.length > 500) jevLog.splice(0, jevLog.length - 500);
  }
  if (posView === 'jev') renderJevLog();
}

/* açık pozisyon/emir turu bitti: JEV sekmesinde görünür */
function jevCyclePos(ok) {
  jevStatus.posAt = jevNow();
  const body = ok
    ? 'KONTROL · açık pozisyon ' + (chartState.positions || []).length + ' · bekleyen emir ' + (chartState.orders || []).length
    : 'KONTROL ⚠ · borsa yanıtı yok';
  jevCycleLog('pos', body + ' · her ' + jevPosPollSec() + ' sn');
}

/* kapanan işlem turu bitti */
function jevCycleHist(ok) {
  jevStatus.histAt = jevNow();
  const body = ok ? 'KONTROL · kapanan ' + (chartState.closed || []).length + ' işlem' : 'KONTROL ⚠ · kapanan verisi yok';
  jevCycleLog('hist', body + ' · her ' + jevHistPollSec() + ' sn');
}

function renderJevLog() {
  const el = $('#jevBody');
  if (!el) return;
  const am = tabAnalyzeMin();
  const tm = jevTsMin();
  const chatOff = tabChatOff(activeTab());
  const ana = ' · LLM analiz ' + (chatOff
    ? 'BU SEKMEDE KAPALI (chat LLM kapalı)'
    : (am > 0 ? 'her ' + fmtAnalyzeMin(am) + (jevAnalyzeNextAt > Date.now() ? ' (sonraki ' + jevMmss(jevAnalyzeNextAt - Date.now()) + ')' : '') : 'kapalı'));
  const anaT = ' · JEV analiz ' + (tm > 0 ? 'her ' + tm + ' dk' + (jevTsNextAt > Date.now() ? ' (sonraki ' + jevMmss(jevTsNextAt - Date.now()) + ')' : '') : 'kapalı');
  const st = 'AYAR: açık/emir her ' + jevPosPollSec() + ' sn' + (jevStatus.posAt ? ' · son ' + jevStatus.posAt : '') +
    ' | kapanan 15 sn sabit' + ana + anaT;
  const rows = jevLog.length
    ? jevLog.map((l) => '<div class="jl-line"><span class="jl-time">' + l.t + '</span><span class="jl-' + l.kind + '">' + escapeHtml(l.text) + '</span>' + (l.n > 1 ? '<span class="jl-n">×' + l.n + '</span>' : '') + '</div>').join('')
    : '<div class="jl-line"><span class="jl-time">Henüz kayıt yok — Jev bir şey yaptığında burada görünür.</span></div>';
  el.innerHTML = '<div class="jl-status">' + escapeHtml(st) + '</div>' + rows;
  const sc = $('#posScroll');
  if (sc) sc.scrollTop = sc.scrollHeight;
}

/* ---------- JEV ayarları: kontrol sıklıkları + alarm analizi ---------- */
const JEV_POS_POLL_KEY = 'jev.posPollSec';
const JEV_HIST_POLL_KEY = 'jev.histPollSec';

function jevPosPollSec() {
  const v = Math.round(Number(localStorage.getItem(JEV_POS_POLL_KEY) || 1));
  return v >= 1 && v <= 60 ? v : 1;
}

function jevHistPollSec() {
  const v = Math.round(Number(localStorage.getItem(JEV_HIST_POLL_KEY) || 15));
  return v >= 5 && v <= 60 ? v : 15;
}

const JEV_ANALYZE_KEY = 'jev.autoAnalyzeMin';

function jevAnalyzeMin() {
  const raw = localStorage.getItem(JEV_ANALYZE_KEY);
  const v = raw == null ? 5 : Number(raw);  /* varsayılan: 5 dakikada bir zamansal analiz */
  if (!Number.isFinite(v) || v < 0 || v > 1440) return 5;
  return v > 0 ? normAnalyzeMin(v) : 0;
}

/* zamansal analiz her grafik sekmesi için ayrı (her sekmenin sohbeti ayrı) */
function tabAnalyzeMin() {
  const t = activeTab();
  if (tabChatOff(t)) return 0; /* bu sekmede chat LLM kapalı → zamansal analiz yok */
  const v = t && t.analyzeMin != null ? Number(t.analyzeMin) : NaN;
  if (!Number.isFinite(v) || v < 0 || v > 1440) return jevAnalyzeMin();
  return v > 0 ? normAnalyzeMin(v) : 0;
}

function setTabAnalyzeMin(v) {
  const t = activeTab();
  if (t) { t.analyzeMin = v; saveTabs(); }
  try { localStorage.setItem(JEV_ANALYZE_KEY, String(v)); } catch {}
}

function jevMmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/* ---------- Jev = TypeSafe (jev-latest) tipli analiz ---------- */
const JEV_TS_MIN_KEY = 'jev.jevAnalyzeMin';

function jevTsMin() {
  const raw = localStorage.getItem(JEV_TS_MIN_KEY);
  if (raw == null) return 5;
  const v = Math.round(Number(raw));
  return v >= 0 && v <= 1440 ? v : 5;
}

function jevTsState() {
  const rates = chartState.rates || [];
  const n = rates.length;
  const last = n ? rates[n - 1] : null;
  const tail = rates.slice(-30).map((r) => ({ o: r.open, h: r.high, l: r.low, c: r.close }));
  const pos = (chartState.positions || []).map((p) => ({
    sembol: p.symbol, yon: Number(p.type) === 1 ? 'short' : 'long', hacim: p.volume,
    giris: p.price_open, sl: Number(p.sl) || null, tp: Number(p.tp) || null,
    fiyat: p.price_current, kar: Number(posProfit(p).toFixed(2)),
  }));
  const plans = (chartState.plans || []).filter((p) => p.symbol === chartState.symbol)
    .map((p) => ({ yon: p.side, giris: p.entry, sl: p.sl, tp: p.tp }));
  return JSON.stringify({
    sembol: chartState.symbol,
    tf: chartState.tf,
    son_mum: last ? { o: last.open, h: last.high, l: last.low, c: last.close } : null,
    gorunum: chartState.range ? { lo: chartState.range.lo, hi: chartState.range.hi } : null,
    son_30_mum: tail,
    acik_pozisyonlar: pos,
    planlar: plans,
    zaman: new Date().toISOString(),
  });
}

/* SWING tarzı 2R plan: yapı H4'ten (yoksa grafikten), stop son swing high/low'un
   ÖTESİNDE + ATR tamponu → gürültüde süpürülmez. Grafikteki GİR ile açılır. */
async function jevTsBuildPlan(side, prob) {
  let rates = null;
  if (exName === 'mt5' && chartState.symbol) {
    const r = await jev.mt5Rates({ symbol: chartState.symbol, timeframe: 'H4', count: 120 }).catch(() => null);
    if (r && r.ok && r.data && Array.isArray(r.data.rates) && r.data.rates.length >= 25) rates = sanitizeRates(r.data.rates);
  }
  if ((!rates || rates.length < 25) && (chartState.rates || []).length >= 21) rates = chartState.rates;
  const n = (rates || []).length;
  if (n < 21) return null;
  const entry = Number(chartState.rates && chartState.rates.length
    ? chartState.rates[chartState.rates.length - 1].close
    : rates[n - 1].close);
  const look = Math.min(20, n - 1);
  let lo = Infinity, hi = -Infinity;
  for (let i = n - look; i < n; i++) {
    lo = Math.min(lo, Number(rates[i].low));
    hi = Math.max(hi, Number(rates[i].high));
  }
  if (!(entry > 0) || !(lo > 0) || !(hi > 0)) return null;
  const atr = atrLike(rates, 14);
  const buf = atr > 0 ? atr * 0.25 : 0;
  const sl = side === 'long' ? lo - buf : hi + buf;
  const risk = Math.abs(entry - sl);
  if (!(risk > 0)) return null;
  const tp = side === 'long' ? entry + 2 * risk : entry - 2 * risk;
  const p = normProb(prob);
  const ev = evOf(entry, sl, tp, p);
  if (tabEvEnforce() && ev.ok && ev.evR < tabEvMin()) {
    jevLogAdd('JEV PLAN KURULMADI · beklenen değer düşük (EV ' + fmtEv(ev.evR) + ' < min ' + tabEvMin() + 'R · p %' +
      Math.round(ev.p * 100) + ' · RR ' + ev.rr.toFixed(2) + ')', 'err');
    toast('Jev plan kurmadı: EV ' + fmtEv(ev.evR) + ' < min ' + tabEvMin() + 'R');
    return null;
  }
  if (!jevPlan({ side, entry, sl, tp, p })) return null;
  savePlans();
  applyPlanButtons();
  drawChart();
  if (ev.ok) jevLogAdd('BEKLENEN DEĞER · plan ' + side.toUpperCase() + ' · RR ' + ev.rr.toFixed(2) + ' · p %' + Math.round(ev.p * 100) + ' · EV ' + fmtEv(ev.evR), 'info');
  return { side, entry, sl, tp, p, ev };
}

let jevTsBusy = false;
let jevTsNextAt = 0;

async function jevTsAnalyze(trigger) {
  if (jevTsBusy) { jevLogAdd('JEV ANALİZ · atlandı (önceki analiz sürüyor)', 'info'); return; }
  jevTsBusy = true;
  try {
    const questions = {
      yon: {
        type: 'choice',
        instructions: 'Fiyat önümüzdeki birkaç GÜN (swing ufku: 1-5 gün) hangi yöne hareket etmesi beklenir?',
        criteria: { long: 'Yukarı yönlü', short: 'Aşağı yönlü', belirsiz: 'Belirsiz / yatay' },
      },
      uygunluk: {
        type: 'score',
        instructions: 'Mevcut yapıda günler sürecek SWING bir işlem açmak ne kadar uygun? (kısa vadeli gürültüyü değil, H4/D1 yapısını değerlendir)',
        criteria: ['Çok kötü', 'Kötü', 'Orta', 'İyi', 'Çok iyi'],
      },
      risk: {
        type: 'noul',
        instructions: 'Açık pozisyon için acil müdahale (SL/TP güncellemesi veya kapatma) gerekiyor mu?',
      },
    };
    const tag = trigger === 'alarm' ? 'ALARM' : 'PERİYOT';
    jevLogAdd('JEV ANALİZ İSTEĞİ · ' + tag + ' · ' + chartState.symbol + ' ' + chartState.tf, 'req');
    const r = await jev.typesafeAnalyze({ state: jevTsState(), questions }).catch(() => null);
    if (!r || !r.ok) {
      jevLogAdd('JEV ANALİZ · hata: ' + ((r && r.error) || 'yanıt yok'), 'err');
      return;
    }
    const a = r.answers || {};
    const yon = a.yon && a.yon.choice ? String(a.yon.choice) : 'belirsiz';
    const yonC = a.yon && Number(a.yon.confidence) ? Number(a.yon.confidence) : 0;
    const sk = a.uygunluk && Number(a.uygunluk.score) ? Number(a.uygunluk.score) : 0;
    const skC = a.uygunluk && Number(a.uygunluk.confidence) ? Number(a.uygunluk.confidence) : 0;
    const rk = a.risk && typeof a.risk.noul === 'number' ? a.risk.noul : null;
    jevLogAdd('JEV ANALİZ (' + tag + ') · yön ' + yon.toUpperCase() + ' %' + Math.round(yonC * 100) +
      ' · uygunluk ' + sk + '/5 %' + Math.round(skC * 100) + (rk != null ? ' · acil müdahale %' + Math.round(rk * 100) : ''), 'jev');
    const side = yon === 'long' ? 'long' : yon === 'short' ? 'short' : '';
    if (side && yonC >= 0.65 && sk >= 3 && skC >= 0.5) {
      const plan = await jevTsBuildPlan(side, yonC);
      if (plan) {
        const evTxt = plan.ev && plan.ev.ok ? ' · EV ' + fmtEv(plan.ev.evR) + ' (p %' + Math.round(plan.ev.p * 100) + ')' : '';
        jevLogAdd('JEV PLAN · ' + side.toUpperCase() + ' giriş ' + Number(plan.entry).toFixed(chartState.digits) +
          ' SL ' + Number(plan.sl).toFixed(chartState.digits) + ' TP ' + Number(plan.tp).toFixed(chartState.digits) +
          ' (yön güveni %' + Math.round(yonC * 100) + ')' + evTxt + ' · grafikteki GİR ile aç', 'jev');
        toast('Jev plan kurdu: ' + side.toUpperCase() + ' ' + chartState.symbol + ' · EV ' + (plan.ev && plan.ev.ok ? fmtEv(plan.ev.evR) : '—'));
        intgBroadcast('PLAN', side.toUpperCase() + ' giriş ' + Number(plan.entry).toFixed(chartState.digits) +
          ' · SL ' + Number(plan.sl).toFixed(chartState.digits) + ' · TP ' + Number(plan.tp).toFixed(chartState.digits) +
          '\nYön güveni %' + Math.round(yonC * 100) + ' · uygunluk ' + sk + '/5' + evTxt, { noHistory: true });
      }
    }
  } finally { jevTsBusy = false; }
}

/* her açık pozisyon turunda: TypeSafe'ten SL/TP güncelleme + anlık kapatma kararı (en fazla 60 sn'de bir) */
let jevTsPosBusy = false;
let jevTsPosLastAt = 0;

async function jevTsPositionCheck() {
  if (!(chartState.positions || []).length) return;
  if (jevTsPosBusy || jevTsBusy) return;
  if (Date.now() - jevTsPosLastAt < 60000) return;
  jevTsPosBusy = true;
  jevTsPosLastAt = Date.now();
  try {
    const questions = {
      kapat: { type: 'noul', instructions: 'Açık pozisyon(lar) şu an piyasa fiyatından kapatılmalı mı? Kapanış YALNIZ kuruluş geçersizleştiyse (yapı kırıldı, tez öldü) uygundur; fiyat kârdaysa kârı korumak için kademeli almak da uygundur. Zararda korkak kapatma uygun DEĞİLDİR — orada doğru cevap beklemektir.' },
      sl: { type: 'noul', instructions: 'Açık pozisyon(lar) için stop-loss KÂR YÖNÜNE taşınmalı mı? Yalnız kârdayken başabaşa ya da kilitle mantığıyla; zararda SL oynatmaz.' },
      tp: { type: 'noul', instructions: 'Açık pozisyon(lar) için take-profit seviyesi ayarlanmalı mı?' },
    };
    const r = await jev.typesafeAnalyze({ state: jevTsState(), questions }).catch(() => null);
    if (!r || !r.ok) { jevLogAdd('JEV POZİSYON ANALİZİ · hata: ' + ((r && r.error) || 'yanıt yok'), 'err'); return; }
    const a = r.answers || {};
    const pK = a.kapat && typeof a.kapat.noul === 'number' ? a.kapat.noul : 0;
    const pS = a.sl && typeof a.sl.noul === 'number' ? a.sl.noul : 0;
    const pT = a.tp && typeof a.tp.noul === 'number' ? a.tp.noul : 0;
    jevLogAdd('JEV POZİSYON ANALİZİ · kapat %' + Math.round(pK * 100) + ' · SL sıkılaştır %' + Math.round(pS * 100) + ' · TP ayarla %' + Math.round(pT * 100), 'jev');
    /* Kârda önce yönet: SL'yi kilitle ve kademeli kâr al. Zaradayken kapatma
       gerekçesizse koruma katmanı reddeder, bu yüzden kapatma en sona bırakılır. */
    if (pS >= 0.7) await jevTsTightenSl();
    if (pK >= 0.85) await jevTsCloseAll(pK);
    else if (pK >= 0.7) await jevTsHarvestProfit(pK);
    if (pT >= 0.7) await jevTsSetTp();
  } finally { jevTsPosBusy = false; }
}

/* Jev'in kâr yönetimi: kârdaki pozisyonlarda kademeli kâr al, kalanı trailinge bırak.
   Zarardakilere DOKUNMAZ — bu, "zararda azaltma" alışkanlığının yerini alır. */
async function jevTsHarvestProfit(conf) {
  const g = posGuardCfg();
  const list = (chartState.positions || []).slice();
  let ok = 0, skipped = 0;
  for (const p of list) {
    const rk = posRisk(p);
    if (!rk.inProfit) { skipped++; continue; }
    if (rk.rNow != null && rk.rNow < g.minProfitR) { skipped++; continue; }
    /* hedefe yaklaştıkça daha büyük parça alınır (kademeli kâr alma, swing) */
    const pct = rk.rNow >= 2 ? 0.5 : 0.34;
    const done = await closePartialPosition(p, pct, true).catch(() => false);
    if (done) {
      ok++;
      setExitHint(p.ticket, p.symbol, 'ai-partial');
      journalAction({ kind: 'partial', src: 'typesafe', sym: p.symbol, ticket: p.ticket, rAt: rk.rNow, netAt: rk.profit, why: 'kademeli kâr al %' + Math.round(pct * 100) });
      termLogAdd('JEV KÂR YÖNETİMİ · ' + p.symbol + ' #' + p.ticket + ' %' + Math.round(pct * 100) + ' kapatıldı (' + rk.rTxt + ')', 'close');
    }
  }
  if (ok) {
    jevLogAdd('JEV AKSİYON · kâr yönetimi: ' + ok + ' pozisyonda kademeli kâr alındı' +
      (skipped ? ' · ' + skipped + ' pozisyon zaten zarardaydı, dokunulmadı' : ''), 'jev');
    toast('Jev kâr yönetimi: ' + ok + ' pozisyonda kademeli kâr alındı');
    refreshPositions();
    refreshClosed();
  } else if (skipped) {
    jevLogAdd('JEV KÂR YÖNETİMİ · kârlı pozisyon yok (' + skipped + ' pozisyon zararda — dokunulmadı)', 'info');
  }
  return ok;
}

async function jevTsCloseAll(conf) {
  const list = (chartState.positions || []).slice();
  mt5Begin();
  try {
    let ok = 0, blocked = 0;
    for (const p of list) {
      /* KORUMA: kârdaysa kapatmak sorun değil; zaradayken kuruluş gerekçesi
         olmadan kapatılmaz (panik satışın en yaygın hâli buydu). */
      const v = posGuardVerdict('CLOSE_FULL', p, { src: 'typesafe', invalidated: false });
      if (!v.ok) { posGuardBlock('CLOSE_FULL', p, v.why, { src: 'typesafe', rAt: v.r && v.r.rNow }); blocked++; continue; }
      const r = await jev.mt5ClosePosition({ ticket: p.ticket }).catch(() => null);
      if (r && r.ok) {
        ok++;
        setExitHint(p.ticket, p.symbol, 'ai');
        journalAction({ kind: 'close', src: 'typesafe', sym: p.symbol, ticket: p.ticket, rAt: v.r && v.r.rNow, netAt: v.r && v.r.profit, why: 'anlık kapatma %' + Math.round(conf * 100) });
      }
    }
    if (ok) {
      termLogAdd('JEV ANALİZ KAPATTI · ' + ok + ' pozisyon (güven %' + Math.round(conf * 100) + ')', 'close');
      jevLogAdd('JEV AKSİYON · anlık kapatma: ' + ok + ' pozisyon (kapatma güveni %' + Math.round(conf * 100) + ')', 'jev');
      toast('Jev analizi pozisyonları kapattı (' + ok + ')');
      refreshPositions();
      refreshClosed();
    }
    if (blocked) {
      jevLogAdd('JEV · ' + blocked + ' pozisyon kapatılmadı: zararda ve kuruluş gerekçesi yok (koruma katmanı)', 'info');
    }
  } finally { mt5End(); }
}

async function jevTsTightenSl() {
  mt5Begin();
  try {
    for (const p of (chartState.positions || []).slice()) {
      const entry = Number(p.price_open) || 0;
      const cur = Number(p.price_current) || 0;
      const isShort = Number(p.type) === 1;
      const curSl = Number(p.sl) || 0;
      if (!(entry > 0) || !(cur > 0)) continue;
      /* başabaş: yalnız kârdaysa ve SL gevşemiyorsa */
      if (isShort) {
        if (!(cur < entry) || (curSl > 0 && curSl <= entry)) continue;
      } else {
        if (!(cur > entry) || (curSl > 0 && curSl >= entry)) continue;
      }
      /* SWING: BE yalnız en az 1R kârdan sonra taşınır (erken BE gürültüde sıfırlar) */
      const rNow = posRisk(p).rNow;
      if (rNow == null || rNow < 1) continue;
      /* GERÇEK başabaş: komisyon/swap/kısmi kapanışlar dahil. Girdi fiyatı
         kullanılırsa stop bir kârla değil zararla kapanır. */
      const slNew = bePriceFor(p, realizedForPosition(p.ticket, p.symbol, p.time));
      if (!(slNew > 0)) continue;
      /* piyasanın gerisinde kalmasın (stop anında tetiklenmesin) */
      if (isShort ? slNew >= cur : slNew <= cur) continue;
      const info = symInfoOf(p.symbol);
      const dg = info && info.digits > 0 ? Number(info.digits) : decOf(entry);
      const slRounded = Number(slNew.toFixed(Math.min(8, dg)));
      if (!(slRounded > 0)) continue;
      const tp = Number(p.tp) || 0;
      const v = posGuardVerdict('SLTP', p, { sl: slRounded, tp, src: 'typesafe' });
      if (!v.ok) continue;
      const r = await jev.mt5Modify({ ticket: p.ticket, sl: slRounded, tp }).catch(() => null);
      if (r && r.ok) {
        termLogAdd('JEV ANALİZ SL · ' + p.symbol + ' #' + p.ticket + ' SL → başabaş ' + slRounded, 'trail');
        jevLogAdd('JEV AKSİYON · SL başabaşa çekildi: ' + p.symbol + ' #' + p.ticket + ' → ' + slRounded, 'jev');
        journalAction({ kind: 'be', src: 'typesafe', sym: p.symbol, ticket: p.ticket, rAt: v.r && v.r.rNow, why: 'gerçek başabaş ' + slRounded });
      }
    }
    refreshPositions();
  } finally { mt5End(); }
}

async function jevTsSetTp() {
  const rates = chartState.rates || [];
  if (rates.length < 5) return;
  const last = Number(rates[rates.length - 1].close);
  mt5Begin();
  try {
    for (const p of (chartState.positions || []).slice()) {
      if (Number(p.tp) > 0) continue;  /* mevcut TP korunur */
      const entry = Number(p.price_open) || 0;
      const sl = Number(p.sl) || 0;
      if (!(entry > 0) || !(last > 0)) continue;
      const isShort = Number(p.type) === 1;
      const risk = sl > 0 ? Math.abs(entry - sl) : Math.abs(entry - last);
      if (!(risk > 0)) continue;
      const info = symInfoOf(p.symbol);
      const dg = info && info.digits > 0 ? Number(info.digits) : decOf(entry);
      const tp = Number((isShort ? entry - 2 * risk : entry + 2 * risk).toFixed(Math.min(8, dg)));
      const r = await jev.mt5Modify({ ticket: p.ticket, sl, tp }).catch(() => null);
      if (r && r.ok) {
        termLogAdd('JEV ANALİZ TP · ' + p.symbol + ' #' + p.ticket + ' TP → ' + tp, 'trail');
        jevLogAdd('JEV AKSİYON · TP ayarlandı: ' + p.symbol + ' #' + p.ticket + ' → ' + tp, 'jev');
      }
    }
    refreshPositions();
  } finally { mt5End(); }
}

let jevPosPollTimer = null;
let jevHistPollTimer = null;
let jevAnalyzeTimer = null;
let jevAnalyzeNextAt = 0;
let jevTsTimer = null;
let alertBgTimer = null;
const ALERT_BG_SEC = 3;  /* arka plan alarm kontrol aralığı (sn) */

/* zamanlanmış analiz: Jev'i alarm dışında periyodik olarak kendiliğinden tetikler */
function jevAutoAnalyze() {
  const t0 = activeTab();
  if (tabChatOff(t0)) return; /* çift emniyet: chat LLM kapalı sekmede zamansal analiz çalışmaz */
  const m = tabAnalyzeMin();
  if (!(m > 0)) return;
  jevAnalyzeNextAt = Date.now() + m * 60000;
  if (!state.activeModel) {
    jevLogAdd('ZAMANSAL ANALİZ · atlandı (sohbet modeli seçili değil — Ayarlar > Chat Ayarları)', 'info');
    return;
  }
  if (pendingChatId || !$('#stopBtn').hidden) {
    /* takılı kalan istek zamanlayıcıyı kalıcı bloklamasın: 10 dk sonra zorla sıfırla */
    if (pendingChatId && Date.now() - jevChatStartedAt > 600000) {
      try { jev.chatStop(pendingChatId); } catch {}
      pendingChatId = '';
      setBusy(false);
      jevLogAdd('ZAMANSAL ANALİZ · takılı istek sıfırlandı', 'info');
    } else {
      jevLogAdd('ZAMANSAL ANALİZ · atlandı (sohbet meşgul)', 'info');
      return;
    }
  }
  jevLogAdd('ZAMANSAL ANALİZ · ' + fmtAnalyzeMin(m) + ' periyot tetiklendi', 'alert');
  toast('Sohbet LLM periyodik analiz yapıyor…');
  const text = '[ZAMANSAL ANALİZ] ' + fmtAnalyzeMin(m) + ' periyodik kontrol zamanı geldi.' +
    ' AMAÇ: grafiği, çizimleri ve pozisyonları SON DURUMA UYARLAMAK; değişiklik yoksa mevcut seviyelerin hâlâ geçerli olduğunu doğrula, eskimişse güncelle.' +
    ' Sistem promptundaki HER ANALİZ RUTİNİ\'ni (R1-R8) uygula: sağdaki grafiğe bak, [ANALİZ ZAMAN DİLİMİ] bloğundaki üst→giriş TF zincirini sırayla analiz et; çizilecek seviye/bölge varsa çiz, kritik seviyelere alarm kur, gerekiyorsa toolbox aracı çalıştır, setup varsa emir aç, açık pozisyonu yönet.' +
    ' Sağdaki grafiği ve açık pozisyonları analiz et; geçerli bir setup görürsen analizine göre doğru emir türünü seçerek <<ORDER>> ile GERÇEK işlem aç: hemen giriş → market · geri çekilme/retest → limit (price = analizdeki giriş seviyesi) · kırılım teyidi → stop (price = tetik seviyesi). Giriş güncel fiyattan uzaksa market kovalama. Kademeli giriş için çoklu <<ORDER>>, iki yönlü kırılım için <<OCO>> kullanabilirsin. Yoksa "işlem yok" de.' +
    ' AÇIK POZİSYON VARSA ÖNCE KÂR DURUMUNA BAK: kârdaysa <<BE>> ya da <<TRAIL>> ile kârı kilitle, sonra <<CLOSE {"pct":33-50}>> ile kademeli kâr al, kalanı trailing ile koştur — kârdayken hiçbir şey yapmamak yasak ve koruma katmanı da zaten SL\'yi ilerletmeyi bekler.' +
    ' Zarardaysa: yarım kapatma, SL\'i fiyata yaklaştırma ve SL\'i geri alma YASAKTIR ve uygulama bunları REDDEDER; doğru eylem BEKLEMEKTİR, SL kaybı zaten kesiyor. Yalnız kuruluşun geçersizleştiğini düşünüyorsan önce gerekçeni yaz, sonra <<CLOSE {"invalidated":true}>> dene.' +
    ' Takip gereken kritik seviyeler (order block/breaker sınırı, destek/direnç, kırılım bölgesi) için uygun türde <<ALERT>> bırak; yoksa yeni alarm kurma.' +
    ' AI çizimleri/seviyeleri değişmiyorsa ya da eskimişse <<CLEAR {"what":"ai"}>> ile temizleyip güncel seviyeleri yeniden çiz; çizgi/kutuları son mumun ötesine (pozitif t ile) uzat ki güncel kalsın.' +
    ' GÜN ÖZETİ + [PERFORMANS HAFIZASI] + [GÜNLÜK KORUMA] bloklarına bak: gerçekleşen isabet/EV ve karar kalitesi ölçümüne göre riski <<AUTO {"risk":...}>> ile güncelle (<<ORDER {"risk":...,"grade":"A|A+|B+|B|C"}>>). Günlük koruma DURDURDU ise yeni emir açma. Gün neti negatifse ve dönüşü teyitli fırsat varsa <<ORDER {"recover":0.25-0.5,"grade":"A",...}>> ile zararın bir kısmını hedefleyebilirsin; seri kayıpta riski ASLA artırma.' +
    ' ANALİZ ARALIĞINI SEN AYARLA: normalde 5–15 dk aralıkta kal; yalnız gerçekten kritik anlarda (sert kırılım, güçlü haber, açık pozisyon riski) <<AUTO {"analyzeMin":1}>> veya 2 ile geçici olarak sıklaştır; kritik an geçer geçmez <<AUTO {"analyzeMin":5}>> ve üzerine dön. 1 dk sürekli kullanılmaz, yalnız çok önemli zamanlarda; değişiklik kararını her turda yeniden değerlendir.' +
    (inTradeHours() ? '' : ' ŞU AN İŞLEM SAATLERİ DIŞINDA (' + fmtTradeHours() + '): yeni işlem AÇMA; yalnız açık pozisyonların SL/TP\'sini ve çizimleri yönet.') +
    ' Soru sorma; kararı ve varsa komutları tek satırda yaz, uzun açıklama yapma.';
  sendMessage(text, 'timed').catch(() => {});
}

/* canlı akış zamanlayıcıları: ayarlardan değişince yeniden kurulur */
/* ---------- sürekli gelişim: her N kapanan işlemde LLM kendini değerlendirir ---------- */
const JEV_EVOLVE_KEY = 'jev.evolveEvery';
const JEV_EVOLVE_N_KEY = 'jev.evolveLastClosed';
const JEV_EVOLVE_AT_KEY = 'jev.evolveLastAt';
const JEV_EVOLVE_DAY_KEY = 'jev.evolveLastDay';

function jevEvolveEvery() {
  const raw = localStorage.getItem(JEV_EVOLVE_KEY);
  const v = raw == null ? 0 : Math.round(Number(raw));
  return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 0;
}

function jevEvolveLastAt() {
  const v = Number(localStorage.getItem(JEV_EVOLVE_AT_KEY) || 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function jevClosedTodayCount() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const ts = Math.floor(d.getTime() / 1000);
  return (chartState.closed || []).filter((c) => Number(c.close_time) >= ts).length;
}

function jevClosedTodayStats() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const ts = Math.floor(d.getTime() / 1000);
  const rows = (chartState.closed || []).filter((c) => Number(c.close_time) >= ts);
  let win = 0, loss = 0, net = 0;
  for (const c of rows) {
    const p = Number(c.profit || 0) + Number(c.swap || 0) + Number(c.commission || 0);
    net += p;
    if (p > 0) win++;
    else if (p < 0) loss++;
  }
  return { n: rows.length, win, loss, net };
}

/* kapanan işlemin SL mesafesine göre gerçekleşen R'si (SL bilinmiyorsa null) */
/* Kapanan işlemin gerçekleşen R'si.
   R birimi = giriş ile SL arası mesafe; SL bilinmiyorsa R hesaplanamaz.
   SL yoksa (bazı borsa kapanış kayıtlarında sl=0 gelir) risk "tüm fiyat" olur
   ve R anlamsız biçimde ~0'a çökerdi — bu yüzden makul aralık da şart. */
function closedR(c) {
  const open = Number(c && c.open_price) || 0;
  const close = Number(c && c.close_price) || 0;
  const sl = Number(c && c.sl) || 0;
  if (!(open > 0) || !(close > 0) || !(sl > 0)) return null;
  const risk = Math.abs(open - sl);
  if (!(risk > 0)) return null;
  /* SL gerçekçi mi: mesafe fiyatın %0,01–%50'si aralığında olmalı */
  const frac = risk / open;
  if (!(frac > 0.0001) || frac > 0.5) return null;
  const r = ((Number(c.type) === 1 ? -1 : 1) * (close - open)) / risk;
  return Number.isFinite(r) ? r : null;
}

/* gerçekleşen istatistikler: isabet, ortalama R, kâr faktörü, başabaş isabet (p_be = kayıp/(kazanç+kayıp)) */
function jevRealizedStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let win = 0, loss = 0, grossWin = 0, grossLoss = 0, sumR = 0, nR = 0;
  for (const c of list) {
    const p = Number(c.profit || 0) + Number(c.swap || 0) + Number(c.commission || 0);
    if (p > 0) { win++; grossWin += p; } else if (p < 0) { loss++; grossLoss += -p; }
    const r = closedR(c);
    if (r != null && Number.isFinite(r)) { sumR += r; nR++; }
  }
  const n = list.length;
  const avgWin = win > 0 ? grossWin / win : 0;
  const avgLoss = loss > 0 ? grossLoss / loss : 0;
  return {
    n, win, loss,
    wr: n > 0 ? win / n : 0,
    avgWin, avgLoss,
    pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    pBe: avgWin > 0 && avgLoss > 0 ? avgLoss / (avgWin + avgLoss) : 0,
    nR, sumR,
    avgR: nR > 0 ? sumR / nR : 0,
  };
}

/* kapanan işlem sayısı eşiği aşılınca otomatik gelişim turu başlatır */
async function jevEvolutionCheck() {
  const every = jevEvolveEvery();
  if (!(every > 0)) return;
  /* gün değişince sayaç sıfırlanır */
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem(JEV_EVOLVE_DAY_KEY) !== today) {
    try {
      localStorage.setItem(JEV_EVOLVE_DAY_KEY, today);
      localStorage.setItem(JEV_EVOLVE_N_KEY, '0');
    } catch {}
  }
  if (pendingChatId || !$('#stopBtn').hidden) return;
  const n = jevClosedTodayCount();
  if (!(n > 0)) return;
  const last = Math.max(0, Math.round(Number(localStorage.getItem(JEV_EVOLVE_N_KEY) || 0)));
  if (n - last < every) return;
  localStorage.setItem(JEV_EVOLVE_N_KEY, String(n));
  localStorage.setItem(JEV_EVOLVE_AT_KEY, String(Date.now()));
  const st = jevClosedTodayStats();
  jevLogAdd('GELİŞİM TURU · bugün ' + st.n + ' işlem (' + st.win + ' kazanç / ' + st.loss + ' kayıp · net ' + st.net.toFixed(2) + ') — LLM değerlendiriyor', 'alert');
  toast('Gelişim turu: LLM performansı değerlendirip stratejisini güncelliyor…');
  /* karar kalitesi ölçümü: AI'ın erken kapatmaları işe yarıyor mu, sıkıntı yaratıyor mu */
  const js = await jev.journalGet({ days: 30 }).catch(() => null);
  const dq = js && js.ok && js.decisions ? js.decisions : null;
  const dqTxt = dq && dq.aiCloseN > 0
    ? 'POZİSYON KARAR KALİTESİ: AI ' + dq.aiCloseN + ' pozisyonu erken kapattı; bu işlemlerin gerçekleşen ort sonucu ' +
      (dq.aiCloseAvgR == null ? '—' : (dq.aiCloseAvgR >= 0 ? '+' : '') + dq.aiCloseAvgR + 'R') +
      ', kendi halinde bırakılsaydı ' + (dq.refAvgR == null ? '—' : (dq.refAvgR >= 0 ? '+' : '') + dq.refAvgR + 'R') +
      ' (fark ' + (dq.earlyCloseEdge == null ? '—' : (dq.earlyCloseEdge >= 0 ? '+' : '') + dq.earlyCloseEdge + 'R') + ')' +
      (dq.aiCloseInLoss ? ' · bunların ' + dq.aiCloseInLoss + ' tanesi ZARARDAYDI kapatıldı' : '') + '.\n'
    : 'POZİSYON KARAR KALİTESİ: henüz yeterli erken kapatma örneği yok.\n';
  const text = '[GELİŞİM TURU] Bugün ' + st.n + ' işlem kapandı (' + st.win + ' kazanç / ' + st.loss + ' kayıp · net ' + st.net.toFixed(2) + '). Performansını dürüstçe değerlendir ve sistemi geliştir:\n' +
    '1) [PERFORMANS HAFIZASI] bloğu kalıcı gerçekleşen geçmişini özetler (30 gün): işlem sayısı, isabet, ortalama R, kâr faktörü, TF/not bazlı kalibrasyon. Buradan ÇIKAR: hangi TF ve hangi not (grade) gerçekten para kazandırıyor, hangileri negatif? O negatif olanı bırak.\n' +
    dqTxt +
    '2) KALİBRASYON: gerçekleşen isabeti başabaş isabetle kıyasla (p_be = 1/(1+RR)). Verdiğin p ile gerçekleşen sonuç tutarlı mı? Aşırı güven mi var? Gerçekleşen isabet sürekli başabaşın altındaysa küçük RR\'li modu bırak: ya RR\'i büyüt (düşük isabet + büyük R) ya da yalnız yüksek isabetli setup\'ları al. Küçük örneklemde varyansın yüksek olduğunu unutma.\n' +
    '3) ZARARDA PANİK KALIBINI ÖLÇ: [PERFORMANS HAFIZASI] karar kalitesinde "zararda erken kapatma" sayısını ve farkını raporlar. Sıfırdan büyükse bu davranış para yaratmıyor demektir; kârı bırakma eğilimini (trailing + kademeli kâr alma) güçlendir.\n' +
    '4) POZİTİF EV\'Lİ YAPILARI GÜÇLENDİR, negatif EV üreten davranışları bırak; tek işlem sonucuna göre değil örüntüye göre karar ver. Piyasada kesin öğrenme yoktur; hedef pozitif beklenen değerli, tekrarlanabilir yapıdır.\n' +
    '5) Gerekiyorsa: skill güncelle (<<SKILL>>), toolbox aracı yaz (<<TOOL>>), eşik/risk ayarla (<<AUTO>>), kodu iyileştir (<<FILE>> ile oku → <<CODE>> ile yaz), gerekirse <<WEB>> ile araştır.\n' +
    '6) Yaptığın değişiklikleri kısa listeyle açıkla; değişiklik yoksa gerekçesini söyle. Soru sorma.';
  sendMessage(text, 'evolve').catch(() => {});
}

function applyJevTimers() {
  if (jevPosPollTimer) clearInterval(jevPosPollTimer);
  if (jevHistPollTimer) clearInterval(jevHistPollTimer);
  if (jevAnalyzeTimer) clearInterval(jevAnalyzeTimer);
  if (alertBgTimer) clearInterval(alertBgTimer);
  if (anaTfTimer) clearInterval(anaTfTimer);
  /* arka planda da çalışır (pencere gizli/simge durumunda olsa bile) */
  jevPosPollTimer = setInterval(() => {
    Promise.all([refreshPositions(), refreshOrders()])
      .catch(() => [false, false])
      .then((rs) => {
        jevCyclePos(!!(rs && rs[0]) && !!(rs && rs[1]));
        jevTsPositionCheck();
      });
  }, jevPosPollSec() * 1000);
  jevHistPollTimer = setInterval(() => {
    refreshClosed().catch(() => false).then((ok) => { jevCycleHist(!!ok); jevEvolutionCheck().catch(() => {}); });
  }, 15000);
  /* alarmlar: aktif grafik dışındaki semboller ve farklı borsalar dahil */
  alertBgTimer = setInterval(() => { alertBackgroundTick(); }, ALERT_BG_SEC * 1000);
  const am = tabAnalyzeMin();
  jevAnalyzeNextAt = am > 0 ? Date.now() + am * 60000 : 0;
  if (am > 0) jevAnalyzeTimer = setInterval(jevAutoAnalyze, am * 60000);
  if (jevTsTimer) clearInterval(jevTsTimer);
  const tm = jevTsMin();
  jevTsNextAt = tm > 0 ? Date.now() + tm * 60000 : 0;
  if (tm > 0) {
    jevTsTimer = setInterval(() => {
      jevTsNextAt = Date.now() + tm * 60000;
      jevTsAnalyze('periyot');
    }, tm * 60000);
  }
  /* analiz zaman dilimi: otomatik modda yalnız ANALİZ çifti (htf→etf) periyodik
     tazelenir. Grafik TF'i HİÇBİR durumda otomatik değişmez — kullanıcı hangi
     TF'de bıraktıysa orada kalır; Jev görsellerle diğer TF'leri görür. */
  anaTfCache = { at: 0, val: null };
  anaTfTimer = setInterval(() => { resolveAnaTfs(false).catch(() => {}); }, ANA_TF_SYNC_MS);
  resolveAnaTfs(true).catch(() => {});
  setTimeout(() => { anaTfCandN = 2; resolveAnaTfs(true).catch(() => {}); }, 20000);
  /* performans hafızası: geçmiş borsa verisini bir kez tara (12 saatte bir) */
  journalBackfill(false).catch(() => 0);
}

function openJevSet() {
  const sel = $('#jsPosPoll');
  if (sel) sel.value = String(jevPosPollSec());
  const hs = $('#jsHistPoll');
  if (hs) hs.value = String(jevHistPollSec());
  const ta = $('#jsJevAnalyze');
  if (ta) ta.value = String(jevTsMin());
  const ca = $('#jsJevMin');
  if (ca) ca.value = '';
  const ja = $('#jsJevAlert');
  if (ja) ja.checked = jevAlertAutoOn();
  const ev = $('#jsEvolveEvery');
  if (ev) ev.value = String(jevEvolveEvery());
  $('#jevSetOverlay').hidden = false;
}

function closeJevSet() {
  $('#jevSetOverlay').hidden = true;
}

function saveJevSet() {
  const posEl = $('#jsPosPoll');
  const hisEl = $('#jsHistPoll');
  const tsEl = $('#jsJevAnalyze');
  const alertEl = $('#jsJevAlert');
  const pv = Math.max(1, Math.min(60, Math.round(Number(posEl && posEl.value) || 1)));
  const hv = Math.max(5, Math.min(60, Math.round(Number(hisEl && hisEl.value) || 15)));
  const tv0 = Math.max(0, Math.min(1440, Math.round(Number(tsEl && tsEl.value) || 0)));
  const custEl = $('#jsJevMin');
  const custV = Math.max(0, Math.min(1440, Math.round(Number(custEl && custEl.value) || 0)));
  const tv = custV > 0 ? custV : tv0;
  const ja = !!(alertEl && alertEl.checked);
  const evEl = $('#jsEvolveEvery');
  const ev = Math.max(0, Math.min(100, Math.round(Number(evEl && evEl.value) || 0)));
  try {
    localStorage.setItem(JEV_POS_POLL_KEY, String(pv));
    localStorage.setItem(JEV_HIST_POLL_KEY, String(hv));
    localStorage.setItem(JEV_TS_MIN_KEY, String(tv));
    localStorage.setItem('jev.jevAlert', ja ? '1' : '0');
    localStorage.setItem(JEV_EVOLVE_KEY, String(ev));
  } catch {}
  const planCb = $('#jevAlertOn');
  if (planCb) planCb.checked = ja;
  applyJevTimers();
  closeJevSet();
  const evTxt = ev > 0 ? 'her ' + ev + ' kapanan işlemde' : 'kapalı';
  toast('Jev ayarları: pozisyon/emir ' + pv + ' sn · kapanan ' + hv + ' sn · Jev analiz ' + (tv > 0 ? tv + ' dk' : 'kapalı') + ' · alarm analizi ' + (ja ? 'açık' : 'kapalı') + ' · gelişim turu ' + evTxt);
  jevLogAdd('AYAR · pozisyon/emir ' + pv + ' sn · kapanan ' + hv + ' sn · Jev(TypeSafe) analiz ' + (tv > 0 ? tv + ' dk' : 'kapalı') + ' · alarm analizi ' + (ja ? 'açık' : 'kapalı') + ' · gelişim turu ' + evTxt, 'info');
}

/* sohbet ayarları: bu grafik sekmesine özel zamansal analiz + görsel ayarı + skill bağlama */
function numInp(sel, def) {
  const el = $(sel);
  if (!el) return def;
  const v = Number(String(el.value || '').replace(',', '.'));
  return Number.isFinite(v) && v >= 0 ? v : def;
}

/* TF seçim kutularını doldur ve otomatik mod gerekçesini göster */
async function fillAnaTfFields() {
  const h = $('#csTfHtf');
  const e = $('#csTfEtf');
  const opts = TFS.map((tf) => '<option value="' + tf + '">' + tf + ' · ' + TF_DEFS[tf].label + '</option>').join('');
  if (h) h.innerHTML = opts;
  if (e) e.innerHTML = opts;
  const cfg = tabAnaTf();
  const mode = $('#csTfMode');
  if (mode) mode.value = cfg.mode;
  if (h) h.value = cfg.htf;
  if (e) e.value = cfg.etf;
  const du = $('#csTfDual');
  if (du) du.checked = cfg.dual;
  await refreshAnaTfWhy();
}

/* otomatik modda uygulamanın neden o TF'i seçtiğini kullanıcıya göster */
async function refreshAnaTfWhy() {
  const box = $('#csTfWhy');
  if (!box) return;
  const mode = $('#csTfMode') ? $('#csTfMode').value : 'auto';
  const h = $('#csTfHtf') ? $('#csTfHtf').value : '';
  const e = $('#csTfEtf') ? $('#csTfEtf').value : '';
  if (mode === 'fixed') {
    box.textContent = 'Elle seçili: ' + h + ' → ' + e +
      ' · analiz, çizim ve alarmlar bu TF\'lerde yapılır · grafik TF\'i sabit kalır';
    return;
  }
  const r = await resolveAnaTfs(true).catch(() => null);
  if (!r) { box.textContent = 'Rejim ölçülemiyor, H1 → M15 kullanılacak.'; return; }
  const extra = tfRegime(chartState.rates);
  const mTxt = extra ? 'Ölçüm: ATR %' + (extra.atrPct * 100).toFixed(2) + ' · oynaklık ' + extra.volMult.toFixed(2) + '× · trend ' + extra.strength.toFixed(2) + ' ATR' : '';
  box.textContent = 'Otomatik: ' + r.htf + ' → ' + r.etf + ' · ' + r.why +
    (mTxt ? '\n' + mTxt : '') +
    '\nAnaliz, çizim ve alarmlar bu TF\'lerde yapılır · grafik TF\'i SABİT kalır (otomatik değişmez); Jev diğer TF\'leri arka plan görüntüleriyle görür.';
}

function fillGuardFields() {
  const pg = posGuardCfg();
  const on = $('#csPgOn'); if (on) on.checked = pg.on;
  const lc = $('#csPgLossClose'); if (lc) lc.checked = pg.allowLossClose;
  const lr = $('#csPgLossR'); if (lr) lr.value = String(pg.lossCloseR);
  const tr = $('#csPgTrailR'); if (tr) tr.value = String(pg.minTrailR);
  const pr = $('#csPgProfitR'); if (pr) pr.value = String(pg.minProfitR);
  const sc = $('#csScalp'); if (sc) sc.value = scalpMode();
  const dg = dayGuardCfg();
  const don = $('#csDgOn'); if (don) don.checked = dg.on;
  const dr = $('#csDgMaxR'); if (dr) dr.value = String(dg.maxLossR);
  const dp = $('#csDgMaxPct'); if (dp) dp.value = String(dg.maxLossPct);
  const dc = $('#csDgConsec'); if (dc) dc.value = String(dg.maxConsecLoss);
}

async function renderMemoryBox() {
  const box = $('#csMemBox');
  if (!box) return;
  const s = await jev.journalSummary({ days: 30 }).catch(() => null);
  if (!s || !s.ok) { box.textContent = 'Hafıza okunamadı.'; return; }
  const st = s.stats || {};
  const pc = (v) => (v == null ? '—' : '%' + Math.round(v * 100));
  const rT = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + 'R');
  let t = s.text + '\n';
  t += '\nR dağılımı (' + (st.rDist ? st.rDist.n : 0) + ' işlem): medyan ' +
    rT(st.rDist && st.rDist.median) + ' · en iyi ' + rT(st.rDist && st.rDist.best) +
    ' · en kötü ' + rT(st.rDist && st.rDist.worst) + ' · toplam ' + rT(st.rDist && st.rDist.totalR);
  const d = st.decisions || {};
  t += '\nKarar: AI erken kapattı ' + d.aiCloseN + ' pozisyon';
  if (d.aiCloseAvgR != null) {
    t += ' → gerçekleşen ' + rT(d.aiCloseAvgR) + ', bırakılsaydı ' + rT(d.refAvgR) +
      ' (' + (d.earlyCloseEdge != null && d.earlyCloseEdge < 0 ? 'erken kapatma DEĞER YARATMIYOR' : 'erken kapatma faydalı') + ')';
  }
  if (d.aiCloseInLoss) t += '\n  ⚠ Zarada kapatılan: ' + d.aiCloseInLoss;
  t += '\nBE uygulaması ' + d.beApplied + ' · trailing açılışı ' + d.trailOn + ' · koruma reddi ' + d.blocked;
  box.textContent = t;
}

async function openChatSet() {
  const t = activeTab();
  const ti = $('#csTitle');
  if (ti) ti.textContent = (t ? t.symbol + ' · ' + t.tf + ' · ' : '') + 'SOHBET AYARLARI';
  const a = $('#csAutoAnalyze');
  const c = $('#csAutoMin');
  analyzeSelFill(a, c);
  const s = $('#csShot');
  if (s) s.checked = attachShotOn();
  const mt = $('#csMultiTf');
  if (mt) mt.checked = multiTfShotOn();
  const tr = $('#csTrade');
  if (tr) tr.checked = jevTradeAutoOn();
  const th = tradeHours();
  const tsEl = $('#csTradeStart');
  const teEl = $('#csTradeEnd');
  if (tsEl) tsEl.value = th.start;
  if (teEl) teEl.value = th.end;
  /* önce göster: skill/hafıza/TF verisi gecikse veya hata verse de kutu açılıp kullanılabilir kalmalı */
  $('#chatSetOverlay').hidden = false;
  const csBody = $('#chatSetBody');
  if (csBody) csBody.scrollTop = 0;
  try {
    await loadSkillsCache();
    renderChatSetSkills();
    await fillAnaTfFields();
    fillGuardFields();
    renderMemoryBox();
  } catch (err) {
    console.warn('chatSet açılış verisi', err);
    toast('Bazı ayar verileri yüklenemedi');
  }
}

/* bu sekmeye bağlı skill'ler: çoklu seçim checkbox listesi */
function renderChatSetSkills() {
  const box = $('#csSkills');
  if (!box) return;
  box.innerHTML = '';
  if (!skillsCache.length) {
    box.innerHTML = '<div class="sub" style="margin:0">Henüz skill tanımlı değil — aşağıdan "Skill\'leri yönet" ile oluştur.</div>';
    return;
  }
  const bound = new Set(activeSkillIds());
  for (const sk of skillsCache) {
    const lab = document.createElement('label');
    lab.className = 'skill-pick' + (sk.enabled === false ? ' off' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = sk.id;
    cb.checked = bound.has(sk.id);
    if (sk.enabled === false) cb.disabled = true;
    const nm = document.createElement('span');
    nm.className = 'skill-pick-name';
    nm.textContent = sk.name + (sk.enabled === false ? ' (kapalı)' : '');
    lab.appendChild(cb);
    lab.appendChild(nm);
    if (sk.desc) {
      const ds = document.createElement('span');
      ds.className = 'skill-pick-desc';
      ds.textContent = sk.desc;
      ds.title = sk.desc;
      lab.appendChild(ds);
    }
    box.appendChild(lab);
  }
}

function closeChatSet() {
  $('#chatSetOverlay').hidden = true;
}

async function saveChatSet() {
  const av = analyzeSelRead($('#csAutoAnalyze'), $('#csAutoMin'));
  const shot = !!$('#csShot').checked;
  const multiTf = $('#csMultiTf') ? !!$('#csMultiTf').checked : true;
  const tradeN = !!$('#csTrade').checked;
  const th = setTradeHours(
    $('#csTradeStart') ? $('#csTradeStart').value : '',
    $('#csTradeEnd') ? $('#csTradeEnd').value : ''
  );
  try {
    localStorage.setItem('jev.attachShot', shot ? '1' : '0');
    localStorage.setItem('jev.multiTfShot', multiTf ? '1' : '0');
    localStorage.setItem('jev.autoTradeNotify', tradeN ? '1' : '0');
  } catch {}
  if (typeof applyShotBtn === 'function') applyShotBtn();
  setTabAnalyzeMin(av);

  /* analiz zaman dilimi: sekmeye yaz + global varsayılanı güncelle.
     sync her zaman false: grafik TF'i otomatik değiştirilmez (kullanıcı neyde bakıyorsa orada kalır). */
  const ana = setTabAnaTf({
    mode: $('#csTfMode') ? $('#csTfMode').value : 'auto',
    htf: $('#csTfHtf') ? $('#csTfHtf').value : 'H1',
    etf: $('#csTfEtf') ? $('#csTfEtf').value : 'M5',
    sync: false,
    dual: !!($('#csTfDual') && $('#csTfDual').checked),
  });
  saveAnaTfDefaults(ana);

  /* işlem tarzı: swing varsayılan, scalp izni */
  const scalpSel = $('#csScalp');
  const scalpV = scalpSel && ['off', 'some', 'on'].includes(scalpSel.value) ? scalpSel.value : 'some';
  try { localStorage.setItem(SCALP_KEY, scalpV); } catch {}
  const scalpTxt = scalpV === 'off' ? 'scalp kapalı' : scalpV === 'some' ? 'scalp ara sıra' : 'scalp serbest';

  /* pozisyon koruma + günlük koruma (kod seviyesinde zorlanan kurallar) */
  const pg = savePosGuardCfg({
    on: !($('#csPgOn') && !$('#csPgOn').checked),
    allowLossClose: !!($('#csPgLossClose') && $('#csPgLossClose').checked),
    lossCloseR: numInp('#csPgLossR', 1),
    minTrailR: numInp('#csPgTrailR', 0.5),
    minProfitR: numInp('#csPgProfitR', 1),
  });
  const dg = saveDayGuardCfg({
    on: !($('#csDgOn') && !$('#csDgOn').checked),
    maxLossR: numInp('#csDgMaxR', 3),
    maxLossPct: numInp('#csDgMaxPct', 6),
    maxConsecLoss: numInp('#csDgConsec', 4),
  });
  dayGuardCache = { at: 0, val: null };

  applyJevTimers();
  /* sekmeye bağlı skill'ler (birden çok seçilebilir) */
  const t = activeTab();
  let skillIds = [];
  if (t) {
    skillIds = $$('#csSkills input[type=checkbox]').filter((c) => c.checked).map((c) => c.value);
    t.skills = skillIds;
    saveTabs();
  }
  /* grafik seçilen TF'e hemen geçsin (çizimler de doğru TF'de kalsın) */
  const applied = await applyAnaTfSync(true).catch(() => null);
  const tfTxt = (applied ? applied.htf + '→' + applied.etf : (ana.htf + '→' + ana.etf)) +
    (ana.mode === 'auto' ? ' (otomatik)' : '');
  closeChatSet();
  const tag = t ? t.symbol + ' ' + t.tf : 'sekme';
  const skillTxt = skillIds.length ? skillIds.length + ' skill' : 'skill yok';
  toast('Sohbet ayarı (' + tag + '): analiz ' + fmtAnalyzeMin(av) + ' · TF ' + tfTxt + ' · koruma ' + (pg.on ? (pg.allowLossClose ? 'zararda kapatma açık' : 'zararda kapatma kapalı') : 'kapalı') + ' · günlük ' + (dg.on ? '-' + dg.maxLossR + 'R' : 'kapalı') + ' · ' + scalpTxt);
  jevLogAdd('AYAR · sohbet (' + tag + ') · zamansal analiz ' + fmtAnalyzeMin(av) + ' · analiz TF ' + tfTxt + ' · koruma ' + (pg.on ? (pg.allowLossClose ? 'zararda kapatma AÇIK (-' + pg.lossCloseR + 'R üzeri)' : 'zararda kapatma YASAK') : 'KAPALI') + ' (SL mesafe ' + pg.minTrailR + 'R · kâr alma ' + pg.minProfitR + 'R) · günlük koruma ' + (dg.on ? '-' + dg.maxLossR + 'R / -%' + dg.maxLossPct + ' / ' + dg.maxConsecLoss + ' kayıp' : 'kapalı') + ' · ' + scalpTxt + ' · görsel ' + (shot ? 'açık' : 'kapalı') + ' · işlem saatleri ' + th.start + '–' + th.end + ' · ' + skillTxt, 'info');
}

function setPosHeader(view) {
  const labels = view === 'hist'
    ? { ticket: 'Fiş', time: 'Açılış', price: 'Giriş', last: 'Kapanış', cprice: 'Fiyat', be: '', act: '%' }
    : view === 'ord'
      ? { ticket: '', time: 'Zaman', price: 'Giriş', last: 'Fiyat', cprice: '', be: '', act: 'İşlem' }
      : { ticket: '', time: 'Zaman', price: 'Giriş', last: 'Fiyat', cprice: '', be: 'Başabaş', act: 'İşlem' };
  $$('#posTable thead th').forEach((th) => {
    const k = th.dataset.k;
    if (k && labels[k] !== undefined) th.textContent = labels[k];
  });
}

/* açık pozisyonda elle SL/TP girişi: hücreye yaz + Enter (boş bırak = değişiklik yok) */
function parseLvlTxt(raw) {
  let s = String(raw || '').trim().replace(/\s/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const v = Number(s);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

async function submitPositionLvl(tr, inp) {
  const p = tr && tr._pos;
  if (!p || inp._skip) { inp._skip = false; return; }
  const part = inp.dataset.part === 'tp' ? 'tp' : 'sl';
  const info = symInfoOf(p.symbol);
  const dec = info && info.digits > 0 ? Math.min(5, Number(info.digits)) : decOf(p.price_open);
  const prev = Number(p[part]) || 0;
  const show = (v) => (v > 0 ? nf(v, dec) : '');
  const raw = String(inp.value || '').trim();
  if (!raw) { inp.value = show(prev); return; }
  const val = parseLvlTxt(raw);
  if (!(val > 0)) { toast('Geçersiz fiyat: ' + raw); inp.value = show(prev); return; }
  const px = Number(val.toFixed(Math.min(8, dec)));
  const tol = Math.pow(10, -dec) / 2;
  if (prev > 0 && Math.abs(px - prev) < tol) { inp.value = show(prev); return; }
  const sl = part === 'sl' ? px : (Number(p.sl) || 0);
  const tp = part === 'tp' ? px : (Number(p.tp) || 0);
  if (sl > 0 && tp > 0 && Math.abs(sl - tp) < tol) {
    toast('SL ve TP aynı olamaz');
    inp.value = show(prev);
    return;
  }
  mt5Begin();
  try {
    const r = await jev.mt5Modify({ ticket: p.ticket, sl, tp }).catch(() => null);
    if (r && r.ok) {
      const txt = p.symbol + ' #' + p.ticket + ' · ' + (part === 'sl' ? 'SL ' + nf(px, dec) : 'TP ' + nf(px, dec));
      toast('SL/TP güncellendi · ' + txt);
      termLogAdd('SL/TP · ' + txt, 'trail');
      jevLogAdd('SL/TP · ' + txt, 'cmd');
    } else {
      toast('SL/TP güncellenemedi: ' + ((r && r.error) || '?'));
      inp.value = show(prev);
    }
    refreshPositions();
  } finally { mt5End(); }
}

function renderPositions() {
  const body = $('#posBody');
  /* MT5 her yenilemede farklı sırada dönebiliyor: satırlar yer değiştirmesin diye ticket'a göre sabit sırala */
  const byTicket = (a, b) => Number(a.ticket || 0) - Number(b.ticket || 0);
  /* sembolün sabit ondalık sayısı: 4203,60 -> 4203,6 gibi basamak düşünce kolon oynamasın */
  const priceFmt = (symbol) => {
    const info = symInfoOf(symbol);
    const d = info && info.digits > 0 ? Math.min(5, info.digits) : null;
    return (v) => nf(v, d != null ? d : decOf(v));
  };
  const rows = (chartState.positions || []).slice().sort(byTicket);
  const orders = (chartState.orders || []).slice().sort(byTicket);
  const closed = chartState.closed || [];
  const showPos = posView === 'pos';
  const showOrd = posView === 'ord';
  const showHist = posView === 'hist';
  const showTerm = posView === 'term';
  const showJev = posView === 'jev';
  $('#posCount').textContent = '(' + rows.length + ')';
  $('#ordCount').textContent = '(' + orders.length + ')';
  $('#histCount').textContent = '(' + closed.length + ')';
  $('#posTabPos').classList.toggle('active', showPos);
  $('#posTabOrd').classList.toggle('active', showOrd);
  $('#posTabHist').classList.toggle('active', showHist);
  const termTab = $('#posTabTerm');
  if (termTab) termTab.classList.toggle('active', showTerm);
  const jevTab = $('#posTabJev');
  if (jevTab) jevTab.classList.toggle('active', showJev);
  const tblEl = $('#posTable');
  if (tblEl) tblEl.hidden = showTerm || showJev;
  const termEl = $('#termBody');
  if (termEl) termEl.hidden = !showTerm;
  const jevEl = $('#jevBody');
  if (jevEl) jevEl.hidden = !showJev;
  setPosHeader(posView);
  /* kolon genişlikleri görünüme göre sabit kalsın (table-layout: fixed) */
  const tbl = $('#posTable');
  tbl.classList.toggle('v-pos', showPos);
  tbl.classList.toggle('v-ord', showOrd);
  tbl.classList.toggle('v-hist', showHist);
  /* Fiş ve kapanış fiyatı sütunları yalnız KAPANANLAR görünümünde */
  for (const k of ['ticket', 'cprice']) {
    const th = $('#posTable thead th[data-k="' + k + '"]');
    if (th) th.style.display = showHist ? '' : 'none';
  }
  /* toplu işlem butonları yalnız pozisyon sekmesinde */
  const closeBtns = [$('#posCloseAll'), $('#posPct25'), $('#posPct50'), $('#posBeAll'), $('#posSeAll'), $('#posCloseProfit'), $('#posCloseLoss')];
  for (const b of closeBtns) b.style.display = showPos ? '' : 'none';
  /* tümünü iptal yalnız bekleyen emirler sekmesinde */
  $('#ordCancelAll').style.display = showOrd ? '' : 'none';
  $('#ordCancelAll').disabled = !orders.length;
  $('#ordCancelAllVal').textContent = orders.length ? '(' + orders.length + ')' : '';
  $('#posSummary').hidden = !showHist;
  /* toplu kapatma butonları: anlık kâr/zarar */
  const fmtPnl = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
  let all = 0, gain = 0, loss = 0;
  for (const p of rows) {
    const pr = posProfit(p);
    all += pr;
    if (pr > 0) gain += pr;
    else if (pr < 0) loss += pr;
  }
  $('#posCloseAllVal').textContent = rows.length ? fmtPnl(all) : '';
  /* toplam kâr/zarar rakamı: artıda yeşil, ekside kırmızı */
  $('#posCloseAll').classList.toggle('gain', rows.length > 0 && all > 0);
  $('#posCloseAll').classList.toggle('loss', rows.length > 0 && all < 0);
  $('#posCloseProfitVal').textContent = gain > 0 ? fmtPnl(gain) : '';
  $('#posCloseLossVal').textContent = loss < 0 ? fmtPnl(loss) : '';
  $('#posCloseAll').disabled = !rows.length;
  $('#posCloseProfit').disabled = !(gain > 0);
  $('#posCloseLoss').disabled = !(loss < 0);
  const cntTxt = rows.length ? '(' + rows.length + ')' : '';
  for (const id of ['posPct25', 'posPct50', 'posBeAll', 'posSeAll']) {
    $('#' + id).disabled = !rows.length;
    $('#' + id + 'Val').textContent = cntTxt;
  }
  /* terminal görünümü: tablo yerine günlük */
  if (showTerm) {
    $('#posEmpty').hidden = true;
    renderTerminal();
    return;
  }
  /* JEV görünümü: Jev'in yaptıkları */
  if (showJev) {
    $('#posEmpty').hidden = true;
    renderJevLog();
    return;
  }
  const keep = new Set();
  /* DOM'u her seferinde sıfırdan kurmak yerine satırları yerinde güncelle: kayma/flicker olmaz */
  const dropStaleRows = () => {
    for (const tr of Array.from(body.children)) {
      if (!keep.has(tr.dataset.key)) tr.remove();
    }
  };
  if (showHist) {
    /* kapanan işlemler (bugün) */
    const today = new Date();
    const dayTxt = String(today.getDate()).padStart(2, '0') + '.' + String(today.getMonth() + 1).padStart(2, '0') + '.' + today.getFullYear();
    $('#posEmpty').textContent = 'Bugün kapanan işlem yok (' + dayTxt + ')';
    $('#posEmpty').hidden = closed.length > 0;
    const bal = Number((chartState.account && chartState.account.balance) || 0);
    /* kısmi kapanıp hâlâ açık olan işlemlerde canlı SL/TP gösterilir (MT5 gibi) */
    const liveById = new Map(rows.map((p) => [String(p.ticket), p]));
    let sum = 0, netSum = 0, commSum = 0, swapSum = 0;
    let anchor = null;
    for (const c of closed) {
      const buy = Number(c.type) === 0;
      const gross = Number(c.profit || 0);
      const pr = gross + Number(c.swap || 0) + Number(c.commission || 0);
      sum += gross;
      netSum += pr;
      commSum += Number(c.commission || 0);
      swapSum += Number(c.swap || 0);
      const pct = bal > 0 ? (pr / bal) * 100 : 0;
      const live = liveById.get(String(c.position_id));
      const sl = live ? Number(live.sl) || 0 : Number(c.sl) || 0;
      const tp = live ? Number(live.tp) || 0 : Number(c.tp) || 0;
      const cv = Number(c.closed_volume || 0);
      const tv = Number(c.volume || 0);
      const volTxt = cv > 0 && tv > 0 && cv < tv - 1e-6
        ? nf(cv, 2) + ' / ' + nf(tv, 2)
        : nf(tv || cv, 2);
      const key = 'h' + c.position_id + '_' + c.close_time;
      keep.add(key);
      let tr = body.querySelector('tr[data-key="' + key + '"]');
      if (!tr) {
        tr = document.createElement('tr');
        tr.dataset.key = key;
        tr.innerHTML =
          '<td class="pos-sym" title="Grafikte göster"></td>' +
          '<td></td>' +
          '<td></td>' +
          '<td></td>' +
          '<td></td>' +
          '<td></td>' +
          '<td class="pos-sl"></td>' +
          '<td class="pos-tp"></td>' +
          '<td></td>' +
          '<td></td>' +
          '<td></td>' +
          '<td>—</td>' +
          '<td></td>';
        tr.querySelector('.pos-sym').addEventListener('click', () => setChartSymbol(tr.dataset.sym || ''));
        body.appendChild(tr);
      }
      const pf = priceFmt(c.symbol);
      const td = tr.children;
      tr.dataset.sym = c.symbol;
      td[0].textContent = c.symbol;
      td[1].textContent = String(c.position_id);
      td[2].textContent = posTime(c.open_time);
      td[3].textContent = buy ? 'buy' : 'sell';
      td[3].className = buy ? 'pos-buy' : 'pos-sell';
      td[4].textContent = volTxt;
      td[5].textContent = pf(c.open_price);
      td[6].textContent = sl > 0 ? pf(sl) : '—';
      td[7].textContent = tp > 0 ? pf(tp) : '—';
      td[8].textContent = posTime(c.close_time);
      td[9].textContent = pf(c.close_price);
      td[10].textContent = nf(pr);
      td[10].className = pr >= 0 ? 'pos-profit-pos' : 'pos-profit-neg';
      td[10].title = 'Net (komisyon + swap dahil) · brüt ' + nf(gross) + ' · komisyon ' + nf(Number(c.commission || 0)) + ' · swap ' + nf(Number(c.swap || 0));
      td[12].textContent = nf(pct, 2) + ' %';
      td[12].className = pr >= 0 ? 'pos-profit-pos' : 'pos-profit-neg';
      if (anchor ? anchor.nextElementSibling !== tr : body.firstElementChild !== tr) {
        body.insertBefore(tr, anchor ? anchor.nextElementSibling : body.firstElementChild);
      }
      anchor = tr;
    }
    dropStaleRows();
    const sumEl = $('#posSummary');
    const curRaw = String((chartState.account && chartState.account.currency) || '');
    const cur = escapeHtml(curRaw);
    sumEl.innerHTML =
      'Kapanan: <b>' + closed.length + '</b>' +
      ' · Toplam Net Kâr: <b class="' + (netSum >= 0 ? 'sum-pos' : 'sum-neg') + '">' + (netSum >= 0 ? '+' : '') + nf(netSum) + '</b>' +
      (bal > 0 ? ' · Bakiye: <b>' + nf(bal) + ' ' + cur + '</b>' : '');
    sumEl.title = 'Net (komisyon + swap dahil) · brüt ' + nf(sum) + ' · komisyon ' + nf(commSum) + ' · swap ' + nf(swapSum) + (curRaw ? ' ' + curRaw : '');
    return;
  }
  if (showPos) {
    $('#posEmpty').textContent = 'Açık pozisyon yok';
    $('#posEmpty').hidden = rows.length > 0;
    let anchor = null;
    for (const p of rows) {
      const sell = Number(p.type) === 1;
      const profit = posProfit(p);
      const be = bePriceFor(p, realizedForPosition(p.ticket, p.symbol, p.time));
      const key = 'p' + p.ticket;
      keep.add(key);
      let tr = body.querySelector('tr[data-key="' + key + '"]');
      if (!tr) {
        tr = document.createElement('tr');
        tr.dataset.key = key;
        tr.innerHTML =
          '<td class="pos-sym" title="Grafikte göster"></td>' +
          '<td></td>' +
          '<td></td>' +
          '<td></td>' +
          '<td></td>' +
          '<td class="pos-sl"><input class="pos-lvl" data-part="sl" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="—" title="SL yaz + Enter (boş = değişiklik yok)" /></td>' +
          '<td class="pos-tp"><input class="pos-lvl" data-part="tp" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="—" title="TP yaz + Enter (boş = değişiklik yok)" /></td>' +
          '<td></td>' +
          '<td></td>' +
          '<td class="pos-be-price"></td>' +
          '<td class="pos-acts">' +
          '<button class="pos-trail mt5-act" title="Bu pozisyona trailing stop başlat/durdur">TR</button>' +
          '<button class="pos-pct mt5-act" data-pct="0.25" title="Pozisyonun %25\'ini kapat">%25</button>' +
          '<button class="pos-pct mt5-act" data-pct="0.5" title="Pozisyonun %50\'sini kapat">%50</button>' +
          '<button class="pos-be mt5-act" title="SL\'i toplam kâr/zarar sıfır olacak noktaya çek (komisyon + swap + bugünkü realize dahil)">BE</button>' +
          '<button class="pos-se mt5-act" title="SL\'i giriş fiyatına çek">SE</button>' +
          '<button class="pos-close mt5-act" title="Pozisyonu kapat">✕</button></td>';
        tr.querySelector('.pos-sym').addEventListener('click', () => setChartSymbol(tr.dataset.sym || ''));
        const lockRow = () => { tr._locked = true; for (const b of tr.querySelectorAll('button')) b.disabled = true; };
        const unlockRow = () => { tr._locked = false; for (const b of tr.querySelectorAll('button')) b.disabled = false; };
        const trBtn = tr.querySelector('.pos-trail');
        trBtn.addEventListener('click', () => {
          if (trBtn.disabled || !tr._pos) return;
          togglePositionTrail(tr._pos, trBtn);
        });
        for (const b of tr.querySelectorAll('.pos-pct')) {
          b.addEventListener('click', async () => {
            if (b.disabled || !tr._pos) return;
            lockRow();
            try {
              await closePartialPosition(tr._pos, Number(b.dataset.pct));
              refreshPositions();
              /* kısmi kapanış BE hesabına anında yansısın */
              refreshClosed();
            } finally { unlockRow(); }
          });
        }
        const beBtn = tr.querySelector('.pos-be');
        beBtn.addEventListener('click', async () => {
          if (beBtn.disabled || !tr._pos) return;
          lockRow();
          try {
            await breakEvenPosition(tr._pos);
            refreshPositions();
          } finally { unlockRow(); }
        });
        const seBtn = tr.querySelector('.pos-se');
        seBtn.addEventListener('click', async () => {
          if (seBtn.disabled || !tr._pos) return;
          lockRow();
          try {
            await setPositionSl(tr._pos, Number(tr._pos.price_open), 'SE');
            refreshPositions();
          } finally { unlockRow(); }
        });
        const btn = tr.querySelector('.pos-close');
        btn.addEventListener('click', async () => {
          if (btn.disabled || !tr._pos) return;
          lockRow();
          mt5Begin();
          try {
            const res = await jev.mt5ClosePosition({ ticket: tr._pos.ticket }).catch(() => null);
            if (res && res.ok) {
              toast('Pozisyon kapatıldı #' + tr._pos.ticket + ' (' + tr._pos.symbol + ')');
              pushToast('POZİSYON KAPATILDI', tr._pos.symbol + ' · #' + tr._pos.ticket, 'trade-open');
              termLogAdd('KAPATILDI (manuel) · ' + tr._pos.symbol + ' #' + tr._pos.ticket, 'close');
            } else {
              toast('Kapatma başarısız: ' + ((res && res.error) || '?'));
            }
            refreshPositions();
          } finally { mt5End(); unlockRow(); }
        });
        tr.querySelectorAll('.pos-lvl').forEach((inp) => {
          inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
            else if (e.key === 'Escape') { inp._skip = true; inp.blur(); }
          });
          inp.addEventListener('focus', () => { inp._skip = false; inp.select(); });
          inp.addEventListener('blur', () => { submitPositionLvl(tr, inp); });
        });
        body.appendChild(tr);
      }
      tr._pos = p;
      tr.dataset.sym = p.symbol;
      if (!tr._locked) for (const b of tr.querySelectorAll('button')) b.disabled = false;
      /* TRAIL butonu: pozisyona özel durum + ayar var mı */
      const trailBtn = tr.querySelector('.pos-trail');
      if (trailBtn) {
        const tm = autoMetaCached()[String(p.ticket)];
        const on = !!(tm && tm.trail === true);
        trailBtn.classList.toggle('active', on);
        const cfgT = trailCfgFor(p.symbol);
        trailBtn.disabled = !cfgT;
        if (!cfgT) {
          trailBtn.title = 'Önce plan ayarlarından trailing mesafesini (R) gir';
        } else {
          const entry = Number(p.price_open) || 0;
          const cur = Number(p.price_current) || 0;
          const sl0 = Number(tm && tm.sl0) || 0;
          const dir = Number(p.type) === 1 ? -1 : 1;
          const rd = Math.abs(entry - sl0);
          const infoT = symInfoOf(p.symbol);
          const dgT = infoT && infoT.digits > 0 ? Number(infoT.digits) : decOf(entry);
          const startPx = rd > 0 ? (dir === 1 ? entry + cfgT.trailStartR * rd : entry - cfgT.trailStartR * rd) : 0;
          const rNow = (entry > 0 && cur > 0 && rd > 0) ? ((cur - entry) * dir) / rd : 0;
          const durum = !on
            ? 'kapalı'
            : (rNow >= cfgT.trailStartR ? 'TAKİPTE' : 'bekliyor: ' + rNow.toFixed(2) + 'R / ' + cfgT.trailStartR + 'R');
          trailBtn.title = 'Trailing ' + (on ? 'AÇIK' : 'kapalı') + ' · ' + durum +
            (startPx > 0 ? ' · başlangıç fiyatı ' + nf(startPx, dgT) + ' (' + cfgT.trailStartR + 'R)' : '') +
            ' · mesafe ' + cfgT.trailDistR + 'R · adım ' + cfgT.trailStepR + 'R';
        }
      }
      const pf = priceFmt(p.symbol);
      const td = tr.children;
      const gNot = orderGradeFor(p);
      td[0].textContent = p.symbol;
      td[0].title = 'Grafikte göster' + (gNot ? ' · işlem notu: ' + gNot : '');
      td[1].textContent = posTime(p.time);
      td[2].textContent = sell ? 'sell' : 'buy';
      td[2].className = sell ? 'pos-sell' : 'pos-buy';
      td[3].textContent = nf(p.volume);
      td[4].textContent = pf(p.price_open);
      const slInp = td[5].querySelector('input');
      if (slInp && document.activeElement !== slInp) slInp.value = Number(p.sl) > 0 ? pf(p.sl) : '';
      const tpInp = td[6].querySelector('input');
      if (tpInp && document.activeElement !== tpInp) tpInp.value = Number(p.tp) > 0 ? pf(p.tp) : '';
      td[7].textContent = pf(p.price_current);
      td[8].textContent = nf(profit);
      td[8].className = profit >= 0 ? 'pos-profit-pos' : 'pos-profit-neg';
      td[9].textContent = be != null ? pf(be) : '—';
      if (anchor ? anchor.nextElementSibling !== tr : body.firstElementChild !== tr) {
        body.insertBefore(tr, anchor ? anchor.nextElementSibling : body.firstElementChild);
      }
      anchor = tr;
    }
    dropStaleRows();
    return;
  }
  /* bekleyen emirler sekmesi (limit/stop) */
  $('#posEmpty').textContent = 'Bekleyen emir yok';
  $('#posEmpty').hidden = orders.length > 0;
  const ordTypes = {
    2: ['buy limit', 'pos-buy'],
    3: ['sell limit', 'pos-sell'],
    4: ['buy stop', 'pos-buy'],
    5: ['sell stop', 'pos-sell'],
  };
  let anchor = null;
  for (const o of orders) {
    const ti = ordTypes[Number(o.type)] || ['order', 'pos-buy'];
    const vol = Number(o.volume_current || o.volume_initial || 0);
    const key = 'o' + o.ticket;
    keep.add(key);
    let tr = body.querySelector('tr[data-key="' + key + '"]');
    if (!tr) {
      tr = document.createElement('tr');
      tr.dataset.key = key;
      tr.className = 'ord-row';
      tr.innerHTML =
        '<td class="pos-sym" title="Grafikte göster"></td>' +
        '<td></td>' +
        '<td></td>' +
        '<td></td>' +
        '<td></td>' +
        '<td class="pos-sl"></td>' +
        '<td class="pos-tp"></td>' +
        '<td></td>' +
        '<td>—</td>' +
        '<td>—</td>' +
        '<td><button class="pos-close mt5-act" title="Bekleyen emri iptal et">✕</button></td>';
      tr.querySelector('.pos-sym').addEventListener('click', () => setChartSymbol(tr.dataset.sym || ''));
      const btn = tr.querySelector('.pos-close');
      btn.addEventListener('click', async () => {
        if (btn.disabled || !tr._ord) return;
        btn.disabled = true;
        tr._locked = true;
        mt5Begin();
        try {
          const res = await jev.mt5OrderDelete({ ticket: tr._ord.ticket }).catch(() => null);
          if (res && res.ok) {
            toast('Bekleyen emir iptal edildi #' + tr._ord.ticket + ' (' + tr._ord.symbol + ')');
            pushToast('EMİR İPTAL EDİLDİ', tr._ord.symbol + ' · #' + tr._ord.ticket, 'trade-open');
          } else {
            toast('İptal başarısız: ' + ((res && res.error) || '?'));
          }
          refreshOrders();
        } finally { mt5End(); tr._locked = false; btn.disabled = false; }
      });
      body.appendChild(tr);
    }
    tr._ord = o;
    tr.dataset.sym = o.symbol;
    if (!tr._locked) tr.querySelector('.pos-close').disabled = false;
    const pf = priceFmt(o.symbol);
    const td = tr.children;
    td[0].textContent = o.symbol;
    td[1].textContent = posTime(o.time_setup);
    td[2].textContent = ti[0];
    td[2].className = ti[1];
    td[3].textContent = nf(vol);
    td[4].textContent = pf(o.price_open);
    td[5].textContent = Number(o.sl) > 0 ? pf(o.sl) : '—';
    td[6].textContent = Number(o.tp) > 0 ? pf(o.tp) : '—';
    td[7].textContent = Number(o.price_current) > 0 ? pf(o.price_current) : '—';
    if (anchor ? anchor.nextElementSibling !== tr : body.firstElementChild !== tr) {
      body.insertBefore(tr, anchor ? anchor.nextElementSibling : body.firstElementChild);
    }
    anchor = tr;
  }
  dropStaleRows();
}

function updateLastPrice() {
  const el = $('#chartLast');
  const rates = chartState.rates;
  if (!rates.length) { el.textContent = '—'; return; }
  const last = rates[rates.length - 1];
  el.textContent = fmtPrice(last.close);
  el.className = 'chart-last ' + (last.close >= last.open ? 'up' : 'down');
}

/* mum kapanışına geri sayım (aktif zaman dilimine göre — TF_SECONDS kayıt defterinden gelir) */

function updateCountdown() {
  const el = $('#footCountdown');
  if (!el) return;
  const dur = TF_SECONDS[chartState.tf] || 900;
  const now = Date.now() / 1000;
  let remain;
  const rates = chartState.rates;
  if (rates.length) {
    const barT = Number(rates[rates.length - 1].time);
    remain = barT + dur - now;
    if (!(remain > 0) || remain > dur) remain = dur - (now % dur);
  } else {
    remain = dur - (now % dur);
  }
  remain = Math.max(0, Math.round(remain));
  const h = Math.floor(remain / 3600);
  const m = Math.floor((remain % 3600) / 60);
  const s = remain % 60;
  const txt = (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  el.textContent = chartState.tf + ' kapanış: ' + txt;
  el.classList.toggle('soon', remain <= 10);
}

function buildTfRow() {
  const row = $('#tfRow');
  row.innerHTML = '';
  for (const tf of TFS) {
    const b = document.createElement('button');
    b.textContent = tf;
    b.className = tf === chartState.tf ? 'active' : '';
    b.addEventListener('click', () => {
      /* eski TF'nin görünümünü kaydet, yeni TF kendi kaydından açılsın;
         kayıt yoksa mevcut zoom aynen taşınır (zoom kaymasın) */
      saveViewState();
      carryViewState();
      chartState.tf = tf;
      chartState.rates = [];
      tfSeq++;
      localStorage.setItem('jev.tf', tf);
      /* TF değişti: analiz önbelleği temizlenir, aksi halde 8 sn boyunca
         önceki TF'in kapanmış mumları bağlamda kalırdı */
      ctxCache.clear();
      anaTfCache = { at: 0, val: null };
      buildTfRow();
      loadDrawings();
      /* önbellekte varsa anında çiz, ağdan tazeleme arkada döner */
      showCachedRates(chartState.symbol, tf);
      loadRates();
      updateActiveTabChart();
      renderChartTabs();
    });
    row.appendChild(b);
  }
}

function updateMt5Dot(on) {
  const d = $('#mt5Dot');
  const nm = exLabel();
  d.className = 'mt5-dot ' + (on ? 'on' : 'off');
  d.title = on ? nm + ' bağlı' : nm + ' bağlı değil — bağlanmak için tıkla (MT5 kapalıysa terminali açar)';
  d.style.cursor = on ? 'default' : 'pointer';
}

function updateAccount(acc) {
  if (acc) chartState.account = acc;
  const a = chartState.account;
  const f = (v) => Number(v).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!a) {
    $('#footBalance').textContent = 'Bakiye: —';
    $('#footEquity').textContent = 'Varlık: —';
    $('#footMargin').textContent = 'Teminat: —';
    $('#footFree').textContent = 'Serbest: —';
    $('#footLevel').textContent = 'Seviye: —';
    return;
  }
  const cur = ' ' + (a.currency || '');
  $('#footBalance').textContent = 'Bakiye: ' + f(a.balance) + cur;
  $('#footEquity').textContent = 'Varlık: ' + f(a.equity) + cur;
  $('#footMargin').textContent = 'Teminat: ' + f(a.margin);
  $('#footFree').textContent = 'Serbest: ' + f(a.margin_free);
  $('#footLevel').textContent = 'Seviye: ' + (Number(a.margin_level) > 0 ? f(a.margin_level) + ' %' : '—');
}

/* ---------- Jev sohbeti: canlı grafik bağlamı + ekran görüntüsü ---------- */
const JEV_SYSTEM_PROMPT = [
  'Sen "JevTrader" adlı yerel trading uygulamasının SOHBET LLM asistanısın. Uygulamada "Jev" adı ayrıca TypeSafe (jev-latest) tabanlı tipli karar motoru için kullanılır; ikisini karıştırma, sen o motor değilsin.',
  'Her mesajda sana [GRAFİK BAĞLAMI] metin bloğu ve grafiğin anlık ekran görüntüsü iletilir.',
  'Bağlam iki bloktur: (1) KAPANMIŞ MUM SERİLERİ — YALNIZ analiz için seçilen zaman dilimlerinin kapanmış mumları (hangi TF\'lerin listelendiği [ANALİZ ZAMAN DİLİMİ] ve bağlam başlığında yazar); (2) CANLI DURUM — son fiyat, GÜN ÖZETİ (gün başı bakiyesi, bugünün tüm işlemleri ve net K/Z), [PERFORMANS HAFIZASI] (kalıcı gerçekleşen istatistik ve karar kalitesi), [GÜNLÜK KORUMA], kapanmamış (canlı) mumlar, hesap özeti, açık pozisyonlar, bekleyen emirler, son kapanan işlemler, grafik çizimleri, alarmlar, planlar, görünür fiyat aralığı ve [GÜNLÜK HABERLER] (günün forex/ekonomi manşetleri). Güncel fiyat/pozisyon bilgisi için CANLI DURUM bloğunu kullan.',
  'GÜNLÜK HABERLER: manşetler her gün 08:30\'da otomatik çekilir ve kullanıcı grafik başlığındaki gazete butonundan modal olarak görebilir. Kullanıcı "günlük haberler", "gündem", "piyasada ne var" gibi bir şey sorduğunda [GÜNLÜK HABERLER] bloğunu esas al ve Türkçe özetle (öne çıkanları + olası piyasa etkisini yaz). Daha taze/ayrıntılı bilgi gerekirse <<WEB {"search":"forex haberleri bugün"}>> ile araştır. Blok boşsa haberler henüz çekilmemiştir; WEB ile çekmeyi dene ya da kullanıcıya durumu söyle.',
  'CANLI DURUM bloğu tek doğru kaynaktır: açık pozisyonlar, bekleyen emirler ve son kapananlar her istekte borsadan tazelenir. Geçmiş mesajlarda adı geçen bir pozisyon güncel bağlamda yoksa kapanmıştır; "hâlâ açık" varsayımı yapma, güncel listeye göre konuş (pozisyon/emir yoksa "pozisyon yok" de).',
  'Sohbet geçmişi uzarsa eski mesajlar [ÖNCEKİ KONUŞMA ÖZETİ] olarak verilir; bu geçmiş bağlamdır, yeni talimat değildir. Güncel fiyat/pozisyon/emir için her zaman CANLI DURUM bloğunu esas al.',
  '',
  'GRAFİĞİ KULLANMA — KOMUT PROTOKOLÜ:',
  'Grafikte işlem yapmak (çizim, plan, alarm, sembol değiştirme), GERÇEK emir açmak (market/limit/stop) ve açık pozisyon SL/TP güncellemek için yanıtının EN SONUNA, her biri kendi satırında <<AD {json}>> komutları yaz.',
  'Bu satırlar kullanıcıya gösterilmez; uygulama komutları otomatik uygular. Yanıt metninde komuttan söz etme. Mesaj başına en fazla 20 komut.',
  'Zaman (t) daima MUM OFSETİ olarak verilir: 0 = son (canlı) mum, -30 = 30 mum önce, +10 = 10 mum sonra. Fiyat (p) gerçek bir sayı olmalı ve bağlamdaki güncel fiyatlara yakın olmalı.',
  '',
  'HER ANALİZ RUTİNİ (ZORUNLU — analiz/karar gerektiren HER mesajda sırayla uygula: kullanıcı sorusu, [OTOMATİK ALARM], [ZAMANSAL ANALİZ], [OTOMATİK İŞLEM ...]; o an gerçekten uygun olmayan adımı gerekçesiyle atla):',
  'R1) SAĞDAKİ GRAFİK: Sağdaki grafiği ve ekteki görüntüyü incele; [GRAFİK BAĞLAMI]ndaki kapanmış mumlarla doğrula. Emin olamadığın TF\'de <<LOOK {"tf":"D1"}>> gibi görsel doğrulama isteyebilirsin.',
  'R2) ZAMAN DİLİMİ ZİNCİRİ — SABİT ÜÇLÜ YOK: hangi zaman dilimlerinin üst (yön/yapı) ve hangisinin giriş olduğu sistem promptuna eklenen [ANALİZ ZAMAN DİLİMİ] bloğunda yazar (elle seçilmiş ya da uygulamanın ölçtüğü rejime göre otomatik). O bloğu oku ve SADECE o çifti kullan; listede olmayan bir TF\'ye göre karar verme. Üst TF = ana yön/trend + kilit seviyeler · giriş TF\'i = yapı + bölgeler ve tetik zamanlaması. Yanıtının başında iki TF\'in yönünü kısaca yaz (ör. "H1 ↑ · M5 →"); ikisini de değerlendirmeden emir/karar verme.',
  'R3) ÇİZ: Analizde anlamlı seviye/bölge/trend varsa çiz (<<DRAW>>: hline/hray/seg/rect/fibo/free/text/channel/zigzag/range; SMC bölgeleri: <<DRAW {"type":"zone","kind":"orderblock|breaker|fvg|buy_order|sell_order|liquidity",...}>>). Eskimiş [AI] çizimleri <<CLEAR {"what":"ai"}>> ile temizleyip güncel seviyeleri yeniden çiz; çizgi/kutuları son mumun ötesine (pozitif t) uzat. Çizilecek bir şey yoksa zorlama.',
  'R4) ALARM: Her analizde takip edilmesi gereken kritik seviyeye <<ALERT>> bırakmayı hedefle (mevcut [AI] alarmı aynı seviyedeyse yeniden kurma; seviye değiştiyse eskisini temizle). Olay/kırılım/hedef → tek seferlik · sürekli izlenecek destek/direnç ve açık pozisyonun SL/TP yakını → repeat:true.',
  'R5) TOOLBOX: İşini kolaylaştıracak mevcut aracı <<TOOL {"action":"run","name":"..."}>> ile çalıştır; tekrar eden bir ihtiyaç fark edersen <<TOOL {"action":"save",...}>> ile yeni araç yaz. Gerekmiyorsa kullanma.',
  'R6) EMİR: Geçerli setup varsa (pozitif EV; p ve SL/TP zorunlu — bkz. BEKLENEN DEĞER) <<ORDER>> ile ya da iki yönlü kırılımda <<OCO>> ile GERÇEK işlemi aç. Emir türünü analize göre seç: hemen giriş → market · retest/geri çekilme → limit · kırılım teyidi → stop. "grade" ver. Setup yoksa zorla emir açma, "işlem yok" de.',
  'R7) POZİSYON YÖNETİMİ: Açık pozisyon varsa değerlendir. ZARARDA PANİK YOK: orijinal SL ve lot girişte belirlendi; tez/setup hâlâ geçerliyse beklemeye devam et — zararda yarım kapatma, SL\'i fiyata yaklaştırma ya da SL\'i geriye genişletme YASAK. Yalnız kuruluş gerçekten geçersizleştiyse (yapı kırıldı, tez öldü) TAMAMEN kapat. KÂRDA AKSİYON ZORUNLU: kâr ~1R olunca <<BE>> ya da <<TRAIL>> ile SL\'i ilerlet, 1,5-2R civarında <<CLOSE {"pct":...}>> ile kademeli kâr al, kalanı geniş trailing ile koştur; "kârdayken hiçbir şey yapmamak" yasak. SL yalnız KÂR yönüne taşınır, riski büyüten değişiklik yasak. Kâr/R durumunu yanıtında belirt.',
  'R8) RİSK + RAPOR: GÜN ÖZETİ\'ne ve [PERFORMANS HAFIZASI] bloğuna göre riski <<AUTO {"risk":...}>> ile ayarla (seri kayıpta düşür, isabet başabaşın altındaysa RR\'i büyüt ya da o setup tipini bırak). Yanıtı 1-2 cümlede tut: seçili iki TF\'in yönü + kilit seviyeler + uyguladığın aksiyonlar (çizim/alarm/tool/emir/SLTP).',
  'R9) SWING TARZI (ZORUNLU — uygulamanın varsayılan işlem tarzıdır): Kısa vadeli/sıkı stoplu scalp işlemleri YASAK; hedef günler süren hareketlerdir.',
  '· YÖN/YAPI: H4 ve D1. Giriş: H1 (tercih) — M15 yalnız tetik teyidi, M5 ve altı karar için kullanılmaz.',
  '· SL: son belirgin swing high/low\'un ÖTESİNE + ATR tamponu. Tercihen mesafe ~1,25 × ATR14(H4) olsun; uygulama SL/TP seviyelerini değiştirmez — gönderdiğin stop aynen kullanılır.',
  '· TP: en az 2R, tercihen 2,5–4R (EV modu B: düşük isabet + büyük R); hedef H4/D1 yapı seviyesine oturmalı, yakın gürültü seviyesine değil.',
  '· SIKLIK: A/A+ swing setup yoksa hiç işlem açma; sembol başına günde en fazla 1 yeni işlem. M15/M5 gürültüsüne emir kovalamak yasak.',
  '· YÖNETİM: pozisyon saatler/günler taşınır. Kâr 1R\'ye ulaşana kadar kısmi kâr alma ve SL oynatma. İlk kısmi kâr ≥1,5–2R\'de; trailing startR ≥1, distR ≥0,75–1R ile geniş tut, kalanı trend bitene kadar koştur. Zararda tek müdahale H4/D1 yapısı gerçekten bozulursa tamamen kapatmak.',
  '· İSTİSNA — SCALP (yalnız dinamik [İŞLEM TARZI] bloğu izin veriyorsa): ara sıra kısa vadeli scalp yapabilirsin; emri "scalp":true ile işaretle. Scalp: risk ≤ %0,5 (uygulama üst sınırı zorlar) · SL ~0,35×ATR14(H4) · TP 0,8–1,5R ve hızlı kapat. Scalp, swing setup\'ını gölgelemesin; izin kapalıysa scalp yasak (işaret yok sayılır).',
  '',
  '1) Sembolü değiştir / grafiği kaydır-yakınlaştır:  <<CHART {"symbol":"XAUUSD"}>>   (yalnız değiştirmek istediğin alanı yaz)',
  '   GÖRÜNÜM KONTROLÜ (aynı komutta ya da tek başına): zoom ({"zoom":"in"} yakınlaştır · {"zoom":"out"} uzaklaştır · {"zoom":80} görünür mum sayısı), sağa-sola kaydırma ({"pan":-20} eskiye/geri · {"pan":20} yeniye/ileri), en sona dön ({"end":true}).',
  '   ⚠ GRAFİK TF\'İ SABİTTİR: <<CHART>> içinde {"tf":"..."} gönderilse bile uygulanmaz (kullanıcı TF\'ini kendisi seçer, otomatik değişmez). Başka TF\'i görsel incelemek için <<LOOK {"tf":"M5","zoom":"in","pan":-30}>> kullan (grafiği kalıcı değiştirmez); <<CHART {"end":true}>> (canlı kenara dön) gibi görünüm komutları serbesttir.',
  '',
  '2) Çizim yap:  <<DRAW {"type":"...", ...}>>',
  '   hline  yatay çizgi:      {"type":"hline","p":4200}',
  '   hray   yatay ışın:       {"type":"hray","p":4200}',
  '   seg    trend çizgisi:    {"type":"seg","from":{"t":-40,"p":4100},"to":{"t":0,"p":4200},"label":"trend"}',
  '   rect   kutu/bölge:       {"type":"rect","from":{"t":-30,"p":4180},"to":{"t":10,"p":4250}}',
  '   fibo   fibonacci:        {"type":"fibo","from":{"t":-60,"p":4050},"to":{"t":0,"p":4230}}',
  '   text   metin etiketi:    {"type":"text","t":-5,"p":4210,"text":"direnç"}',
  '   emoji  emoji işareti:    {"type":"emoji","t":-3,"p":4150,"text":"🚀"}',
  '   free   serbest çizim:    {"type":"free","points":[{"t":-10,"p":4100},{"t":-8,"p":4120},{"t":-6,"p":4110}]}',
  '   zigzag kırılım çizgisi:  {"type":"zigzag","points":[{"t":-30,"p":4200},{"t":-20,"p":4150},{"t":-10,"p":4190},{"t":0,"p":4160}]}',
  '   channel paralel kanal:   {"type":"channel","from":{"t":-40,"p":4100},"to":{"t":0,"p":4200},"third":{"t":-10,"p":4130}}',
  '   range  yatay bant:       {"type":"range","from":{"t":-25,"p":4150},"to":{"t":-5,"p":4180}}',
  '          range\'e "pd":true eklersen tam ortaya PD Array EQ (%50) çizgisi çizilir: {"type":"range","from":{"t":-25,"p":4150},"to":{"t":-5,"p":4180},"pd":true}. Üst/alt çizgiye ayrı yazı: "label":"üst yazı","labelBottom":"alt yazı".',
  '          zigzag: swing yüksek/düşüklerini sırayla birleştirir · channel: from-to ana çizgi + third noktasından geçen paralel (üçüncü yerine "width" fiyat farkı da olur) · range: from-to arasında üst/alt yatay bant.',
  '          İpucu: hareketli ortalama (SMA/EMA) gibi eğrileri mum serisinden kendin hesaplayıp free çizimle nokta nokta çizebilirsin (10-30 nokta yeterli); üzerine {"type":"text"} ile "SMA20" gibi etiket koy.',
  '   zone   SMC bölgesi:      {"type":"zone","kind":"buy_order","from":{"t":-30,"p":4180},"to":{"t":0,"p":4200}}',
  '          kind: buy_order | sell_order | orderblock | breaker | fvg | liquidity — renk ve etiket otomatik seçilir (BUY ORDER yeşil, SELL ORDER kırmızı, ORDERBLOCK mavi, BREAKER mor, FVG turuncu, LİKİDİTE camgöbeği). label ile kendi etiketini verebilirsin.',
  '          Kısa yol: type yerine doğrudan "ob" / "orderblock" / "breaker" yazsan da olur. rect de renk + etiket alır: {"type":"rect",...,"label":"BUY ORDER","color":"#22c55e"}.',
  '          SMC/ICT analizi: order block, breaker, FVG, likidite ve buy/sell order bölgelerini zone ile işaretle; bağlamdaki mevcut bölgeleri analizine dahil et, eskimiş/geçersiz kalanları <<CLEAR {"what":"ai"}>> ile temizle.',
  '',
  '3) İşlem planı çiz (YALNIZCA kullanıcı açıkça "plan kur/işaretle" derse):  <<PLAN {"side":"long","entry":4200,"sl":4170,"tp":4260,"p":0.6}>>',
  '   side "long" ya da "short". long için sl < entry < tp, short için sl > entry < tp olmalı.',
  '   "p" bu planın kazanma olasılığıdır (0-1 arası ondalık) ve ZORUNLUDUR — EV hesabı buna göre yapılır (bkz. BEKLENEN DEĞER kuralı).',
  '   Plan grafiğe kutu olarak çizilir; kullanıcı "GİR" düğmesine basınca emir gönderilir. Normal durumda plan kutusu çizmek yerine doğrudan <<ORDER>> ile GERÇEK emir aç (madde 8).',
  '',
  '4) Fiyat alarmı:  <<ALERT {"p":4200,"cond":"above","note":"direnç kırılımı"}>>  (tek seferlik)  |  <<ALERT {"p":4200,"cond":"above","note":"direnç kırılımı","repeat":true}>>  (tekrarlı)   cond: above | below | cross',
  '   TEK SEFERLİK (repeat yazılmaz ya da repeat:false): belirli bir olayı BİR KEZ beklerken kullan — "fiyat X\'e gelince haber ver", kırılım teyidi, hedefe ulaşma, tek seferlik uyarı. Tetiklenince alarm silinir; sana bir kez bildirim gelir.',
  '   TEKRARLI (repeat:true): yalnız sürekli izlenmesi gereken seviyelerde kullan — destek/direnç, açık pozisyonun SL/TP yakını, tekrar tekrar test edilecek bölge.',
  '   HER ALARMI TEKRARLI KURMA; ihtiyaç hangisiyse onu seç, ikisi gerekiyorsa aynı seviyeye ayrı ayrı kur ve yanıt metninde tek/tekrarlı olduğunu belirt.',
  '   BAŞKA SEMBOL/BORSA: {"symbol":"GER40","cond":"above","p":18500} ile aktif grafik dışındaki sembole, {"symbol":"BTCUSDT","exchange":"binance",...} ile başka borsaya alarm kurabilirsin. Alarmlar ARKA PLANDA tüm semboller ve borsalar için çalışır (pencere simge durumunda olsa bile tetiklenir); önemli gördüğün farklı sembollerin kilit seviyelerini de alarmla takip et.',
  '',
  '5) Temizle:  <<CLEAR {"what":"ai"}>>   what: ai (yalnız AI çizim/plan/alarmları) | drawings | plans | alerts',
  '',
  '6) Açık pozisyonun SL/TP güncelle:  <<SLTP {"ticket":"3951456138484387840","sl":92.1,"tp":95.8}>>',
  '   ticket, bağlamdaki "Açık pozisyonlar" listesindeki #numara ile aynıdır. Tek pozisyon varsa {"symbol":"BTC-USDT-SWAP"} de yeterlidir; ikisi birlikte verilirse ticket kazanır.',
  '   Yalnız SL ya da yalnız TP değişecekse diğerini yazma (verilmeyen seviye aynen korunur). SL ve TP aynı olamaz; fiyatlar güncel fiyata yakın olmalı.',
  '   Bu komut borsada GERÇEK emir güncellemesi yapar: kullanıcı açıkça isteyince ("SL\'i başabaşa çek", "TP\'yi 95.8 yap", "stopu 92.5\'e taşı" gibi) ya da alarm/zamansal analiz koruma gerektiriyorsa kullan ve yaptığın değişikliği yanıt metninde sayısal olarak belirt.',
  '',
  '6b) AÇIK POZİSYON YÖNETİMİ — TAM YETKİ SENDE (işlem açıkken yönet):',
  '   DİSİPLİN (korkaklık yok): SL/TP/lot girişte belirlenir; zarardayken panik müdahalesi yapılmaz. YASAKLAR: (a) zararda parçalı/yarım kapatma (kısmi kapatma YALNIZ kâr almak için yapılır), (b) SL\'i fiyata yaklaştırıp hemen stop olmasına yol açma, (c) SL\'i geri çekme/genişletme (riski büyütme), (d) normal dalgalanmada SL oynatma. Zarar tanımlıdır: SL belli, lot belli — zararda beklemekten korkma; bir işlemin kaybetmesi normaldir. Zararda TEK meşru müdahale: tez/yapı geçersizleştiyse pozisyonu TAMAMEN kapatmak (yarıya bölmek değil).',
  '   KÂRDA İSE AKTİF OL (asıl yönetim burada): kâr ~1R\'ye ulaşınca <<BE>> ya da <<TRAIL>> ile SL\'i kilitle; trend ilerledikçe <<TRAIL>> ile SL\'i adım adım KÂR yönüne taşı; hedefe/TP1\'e yaklaşınca <<CLOSE {"pct":33-50}>> ile kademeli kâr al, kalanı trailing ile koştur. "Kârdayken hiçbir şey yapmamak" yasak; her SL güncellemesi riski KÜÇÜLTÜR, asla büyütmez.',
  '   İstisna: sert haber/spread patlaması gibi olağan dışı durumda riski küçültmek serbesttir (nadir ve gerekçeli); önce BE/trailing tercih edilir.',
  '   Başabaş:  <<BE {"ticket":"3951456138484387840"}>>  ·  sembol: {"symbol":"XAUUSD"}  ·  hepsi: {"all":true}',
  '   Trailing stop (YALNIZ KÂRDA başlar; ilk adımda SL kâra çekilir):  <<TRAIL {"ticket":"...","on":true,"startR":1,"lockR":0.5,"distR":1,"stepR":0.5}>>  · kapat: {"on":false} · toplu: {"all":true}',
  '   Mantık (SWING varsayılanları): kâr startR\'ye (varsayılan 1R) ulaşınca SL en az lockR kadar KÂRA çekilir (varsayılan +0.5R kilit), sonra fiyatı distR (1R) geriden takip eder; stop fiyata 0.5R\'den yakın tutulmaz ki gürültüde stop olmasın. Parametre verilmezse bu güvenli swing varsayılanları uygulanır, kayıtlı ayar varsa o kullanılır.',
  '   Kısmi/tam kapat:  <<CLOSE {"ticket":"...","pct":50}>> (%50 kapat) · belirli lot: <<CLOSE {"symbol":"XAUUSD","volume":0.02}>> · tamamı: <<CLOSE {"ticket":"..."}>> · kârdakiler topluca: <<CLOSE {"side":"profit"}>> · zarardakiler: <<CLOSE {"side":"loss"}>>',
  '   Lotları sen ayarlarsın: yeni girişlerde "volume" (örn 0.01) ya da "risk" % ile; kademeli giriş/çıkış için çoklu <<ORDER>> ve parçalı <<CLOSE pct>> kullan. Kısmi kapatınca kalan lot takip edilir; kârı kilitlemek için BE/trailing ile SL\'i ilerlet.',
  '   Gerekçeni tek satırda söyle ama işlemi SEN yap: "sen yap" deme, <<SLTP>>/<<BE>>/<<TRAIL>>/<<CLOSE>> komutlarını kendin gönder.',
  '',
  '7) İstediğin zaman dilimini/zoom\'u GÖRSEL olarak incele:  <<LOOK {"tf":"M5","bars":80}>>   pane:2 verirsen ikili grafik modu açılır ve ikinci grafik kullanılır; symbol ile başka sembole de bakabilirsin.',
  '   LOOK zoom/kaydırma da kabul eder: <<LOOK {"tf":"M15","zoom":"in","pan":-40}>> (geçmiş bölgeyi yakınlaştırıp görsel al) · <<LOOK {"tf":"H1","end":true}>> (canlı kenarı gör). Farklı TF\'lerden FARKLI görseller almak için aynı yanıtta birden çok LOOK yaz (ör. M5 + H1 + D1); hepsi sana geri gelir, karşılaştırıp analiz edersin. Bir zincirde en fazla 2 LOOK kullan.',
  '   Çoklu zaman dilimi mum verisi bağlamda zaten var; AYRICA her mesaja etiketli [GRAFİK GÖRÜNTÜLERİ] eklenir: "ekran" = aktif grafik (çizimler dahil), "arka plan" = üst/giriş/alt TF mum grafikleri (görünür grafik değiştirilmeden arka planda hazırlanır). Karar vermeden önce bu görüntüleri birlikte oku (üst TF yön/trend, giriş TF tetik, alt TF ince ayar) ve seviyeleri mum verisiyle doğrula; yetersizse <<LOOK>> ile başka TF/zoom iste. Yanıtın bitince istediğin görüntü(ler) otomatik olarak sohbete eklenip SANA geri gönderilir; görüntüyü görünce analizine devam edip kararını verirsin.',
  '',
  '8) İŞLEM AÇ — GERÇEK EMİR (market/limit/stop):  <<ORDER {"type":"market","side":"buy","volume":0.01,"sl":92.1,"tp":95.8,"p":0.62}>>',
  '   Altı emir: buy market / sell market {"type":"market","side":"buy|sell"} · buy limit / sell limit {"type":"limit","side":"buy|sell","price":...} · buy stop / sell stop {"type":"stop","side":"buy|sell","price":...}.',
  '   "type" alanına doğrudan buy_limit | sell_limit | buy_stop | sell_stop | buy_market | sell_market da yazabilirsin; uygulama ikisini de kabul eder.',
  '   EMİR TÜRÜNÜ ANALİZE GÖRE SEÇ, illa market değil: hemen bu fiyattan giriş → market · fiyat geri çekilsin/retest edilsin → limit (price = analizdeki giriş seviyesi) · kırılım teyidi beklenecek → stop (price = tetik seviyesi). Giriş seviyesi güncel fiyattan uzaksa market kovalama; o seviyeye limit/stop bekleyen emir koy.',
  '   limit/stop için price zorunlu · symbol verilmezse grafikteki sembol kullanılır. volume verilmezse risk % ayarına ve SL mesafesine göre hacim otomatik hesaplanır (bu durumda sl ve giriş bilgisi şart).',
  '   SEN HESAPLARSIN — YETKİ SENDE: "risk" (yüzde, örn 1.5) alanı verirsen hacim o risk % ile hesaplanır (sekme ayarı yerine); "leverage" (örn 20) verirsen kaldıraç o olur. Risk yüzdesi, hacim, kaldıraç, SL/TP ve EV hesabı tamamen senin sorumluluğunda: GÜN ÖZETİ\'ndeki gün başı bakiyesi, bugünkü net K/Z ve bugünkü işlemleri dikkate alarak riski kendin belirle; seri kayıpta riski düşür ya da hiç işlem açma.',
  '   SENİN GERÇEK EMİR AÇMA YETKİN VAR: kullanıcı işlem açmanı istediğinde ya da alarm/zamansal analizde geçerli bir setup görürsen plan kutusu çizmekle kalma; yön + giriş/SL/TP ile <<ORDER>> göndererek işlemi AÇ. Açtığın işlemi yanıt metninde (yön, tür, hacim, SL/TP) sayısal olarak belirt. Emin değilsen "işlem yok" de.',
  '   İŞLEM NOTU (grade): her emirde "grade" ver — "A+" (mükemmel: HTF uyumu + likidite süpürme + OB/breaker retest + RR≥2), "A" (güçlü), "B+" (orta), "B" (zayıf ama pozitif EV), "C" (deneme). Risk nota göre OTOMATİK ölçeklenir: A+ ×1.5 · A ×1 · B+ ×0.6 · B ×0.35 · C ×0.2 (verdiğin risk% ya da sekme riski × çarpan). Anlık scalp/fırsat işlemlerinde de not ver; A+/A ise lot otomatik büyür, B/C küçülür. Toplam açık riski andırmayı unutma.',
  '   SCALP İŞARETİ: yalnız [İŞLEM TARZI] bloğu izin veriyorsa kısa vadeli scalp emirlerini "scalp":true ile gönder; risk %0,5 ile sınırlanır, SL ~0,35×ATR14(H4) olabilir, TP 0,8–1,5R hızlı olmalı. Normal (swing) emirlerde scalp işareti kullanma.',
  '   GÜN KURTARMA (recover): gün neti negatifken lotu hedefe göre hesaplat — <<ORDER {"type":"market","side":"buy","sl":92.1,"tp":95.8,"p":0.7,"grade":"A","recover":0.5}>> (0.5 = günün kalan net zararının %50\'sini TP\'de kapatacak lot; true = tamamı; "tp" zorunlu). Lot, TP kazancı hedefi karşılayacak şekilde hesaplanır; tek işlem riski "maxRisk" yüzdesiyle (varsayılan %2) sınırlanır, sınır aşılırsa lot otomatik kısılır ve logda gerçek kurtarma yüzdesi yazılır.',
  '   KURTARMA KURALLARI: yalnız A/A+ ve pozitif EV\'li, DÖNÜŞÜ TEYİTLİ setuplarda kullan (üst üste stoplar sonrası dönüş sinyali yoksa işlem açma); rövanş için değil yapı için gir; gün zararını tek işlemde tamamen kovalamak yerine %25–50 parçalarla kapat; üst üste 2 başarısız kurtarma turundan sonra riski düşür ve günü korumaya geç; maxRisk\'i asla yükseltme. Gün neti pozitifse recover kullanma.',
  '   Örnek: <<ORDER {"type":"market","side":"buy","sl":92.1,"tp":95.8,"p":0.7,"grade":"A+"}>>',
  '   ÇOKLU EMİR: aynı yanıtta birden çok <<ORDER>> satırı gönderebilirsin (kademeli giriş/DCA, ızgara, parçalı TP); toplam riski gözet. Tek komutta liste için <<ORDER {"orders":[{...},{...}]}>> de geçerlidir.',
  '',
  '9) OCO (iki bekleyen emirden biri tetiklenince diğeri otomatik iptal):  <<OCO {"orders":[{"type":"stop","side":"buy","price":94.55,"sl":93.8,"tp":95.5,"p":0.6},{"type":"stop","side":"sell","price":93.25,"sl":94.0,"tp":92.3,"p":0.6}]}>>',
  '   Yalnız limit/stop girişleri içindir (market anında dolduğu için OCO kurulamaz). Tipik kullanım: iki yönlü kırılım — üstte buy stop, altta sell stop; biri tetiklenince uygulama diğerini iptal eder. Her bacak ayrıca "scalp":true alabilir (izin varsa).',
  '',
  '10) AYARLAR — LLM YETKİSİ:  <<AUTO {"risk":1.5,"analyzeMin":5,"evMin":0.05,"evEnforce":true}>>',
  '   Aktif sekmenin işlem riskini (%), zamansal analiz sıklığını, min EV eşiğini ve EV kontrolünü sen belirlersin. Sıklık dakika olarak verilir (ondalık olabilir; alt sınır 1 dk, 0 = kapalı): <<AUTO {"analyzeMin":5}>>. NORMAL ARALIK 5–15 DK\'DIR; 1–2 dk YALNIZ gerçekten kritik anlarda (sert kırılım, güçlü momentum, haber etkisi, açık pozisyon riski) geçici olarak kullanılır ve kritik an biter bitmez 5 dk ya da üzerine dönülür; 1 dk sürekli kullanılmaz. Kullanıcı "kaç dakikada bir / ne sıklıkta analiz yapacaksın" gibi bir şey sorar/ister ya da sen gerekli görürsen bu komutu kullan; yalnız değiştirmek istediğin alanı yaz. Değişikliği yanıt metninde sayısal olarak belirt.',
  '',
  'BEKLENEN DEĞER (EV) — ZORUNLU KURAL:',
  'Her <<ORDER>>, <<PLAN>> ve <<OCO>> işleminde "p" (kazanma olasılığı, 0-1) alanı ZORUNLUDUR; p veya SL/TP eksikse uygulama emri REDDEDER.',
  'Uygulama EV\'yi R cinsinden hesaplar: EV = p × RR − (1 − p) · RR = |TP − giriş| / |giriş − SL|. Örnek: RR 2.0 ve p 0.60 → EV = 0.60×2.0 − 0.40 = +0.80R (yani işlem başına ortalama +0.80R beklenir; pozitif EV iyidir).',
  'Kullanıcının min EV eşiği vardır (Plan Ayarları > Beklenen Değer; varsayılan 0.05R). Eşiğin altındaki otomatik emirler açılmaz. Bu yüzden emir açmadan önce p ve RR\'i dürüstçe değerlendir: EV pozitif ve eşiğin üzerinde değilse işlem AÇMA, "işlem yok" de.',
  'Yanıt metninde her işlem için EV\'yi sayısal olarak belirt (örn. "EV +0.80R · p %60 · RR 2.0").',
  'İKİ GEÇERLİ MOD — birini seç, ortada kalma: (A) YÜKSEK İSABET + KÜÇÜK RR (p ≥ %65 · RR 0,5–1,5; sık kazan, az kazan) ya da (B) DÜŞÜK İSABET + BÜYÜK R (p ≤ %45 · RR ≥ 2,5; az kazan ama büyük). SWING tarzında esas mod B\'dir (geniş stop + büyük R); mod A yalnız çok güçlü ortalamada kullanılır. p ve RR ikisi de düşükse (ör. p %50 · RR 1) EV ≈ 0 ya da negatiftir; ASLA açma.',
  'BAŞABAŞ İSABET: p_be = 1/(1+RR) → RR 0,5 için %67 · RR 1 için %50 · RR 1,5 için %40 · RR 2 için %33 · RR 3 için %25. Verdiğin p bunun altındaysa işlem matematiksel olarak kaybettirir; yalnız üstündeyse (ve EV ≥ eşikse) aç.',
  'KALİBRASYON: GÜN ÖZETİ\'ndeki gerçekleşen isabet / ortalama R / kâr faktörünü kendi p tahminlerinle karşılaştır. Gerçekleşen isabet başabaşın altındaysa küçük RR denemeye devam etme — ya RR\'i büyüt (mod B) ya da o setup tipini tamamen bırak. Uzun kayıp serisinde işlem sıklığını ve riski düşür.',
  '',
  'KOD GÜNCELLEME (SELF-EDIT) — yalnızca kullanıcı uygulamanın kodunu değiştirmeni/iyileştirmeni isterse:',
  '<<CODE {"file":"src/renderer/renderer.js","ops":[{"find":"dosyada birebir geçen mevcut kod","replace":"yeni kod"}],"why":"kısa açıklama"}>>',
  '   "find" metni dosyada BİREBİR ve TEK kez geçmeli (girinti/boşluk dahil); aynı dosyada birden çok değişiklik için "ops" dizisine ekle; farklı dosyalar için ayrı <<CODE>> satırı yaz (en fazla 10).',
  '   Tüm dosyayı yeniden yazmak için {"file":"...","content":"...tam içerik..."} kullan (büyük dosyalarda önerilmez). Dosya src/ altında ve .js/.css/.html olmalı.',
  '   Uygulama: değişiklikleri yedekler → node --check + görünmez smoke test çalıştırır → başarılıysa uygulama OTOMATİK yeniden başlar; hata olursa değişiklikler geri alınır. Yeniden başlatma sohbeti silmez.',
  '   Küçük ve cerrahi farklar üret; mevcut yapıyı/stili koru; kullanıcı istemedikçe özellik kaldırma veya ayar değiştirme. Kod değişikliğini yanıt metninde kısaca özetle.',
  '',
  '11) SKILL YÖNETİMİ — kullanıcının stratejisini/kurallarını kalıcı yetenek olarak YAZ ve istediği sohbet sekmesine YÜKLE:',
  '   Yaz/güncelle:  <<SKILL {"action":"save","name":"Risk Kuralları","desc":"kısa açıklama","content":"1) İşlem başına risk %1\'i geçmesin\\n2) ..." }>>   (aynı ad varsa günceller, yoksa oluşturur)',
  '   Sekmeye bağla:  <<SKILL {"action":"bind","tab":"XAUUSD H1","skills":["Risk Kuralları","Scalping"]}>>   (tab: "aktif" | "SEMBOL TF" | sekme id; varsayılan EKLE, "replace":true ile mevcut bağlar değiştirilir; birden çok skill verilebilir)',
  '   Bağı çöz:  <<SKILL {"action":"unbind","tab":"aktif","skills":["Risk Kuralları"]}>>   (skills boş/verilmezse o sekmenin TÜM skill bağları çözülür)',
  '   Sil:  <<SKILL {"action":"delete","name":"..."}>>   (skill kütüphaneden silinir ve tüm sekmelerden çıkarılır)',
  '   Bağlı ve açık skill\'lerin içeriği o sekmenin sohbetinin sistem promptuna her istekte eklenir; skill yalnız bağlı olduğu sekmeyi etkiler. Bağlamdaki "Sekmeler" listesinde her sekmenin mevcut skill\'leri ve "Skill kütüphanesi" görünür.',
  '   Kullanıcı "bunu skill olarak kaydet", "şu sekmeye bağla", "bu kuralı hatırla" gibi şeyler derse bunu SKILL komutuna çevir; yanıt metninde hangi skill\'i nereye bağladığını belirt.',
  '',
  '12) İNTERNET — ARAŞTIR & ÖĞREN:  <<WEB {"search":"supply demand zone stratejisi kuralları"}>>   |   <<WEB {"url":"https://..."}>>',
  '   İnternetten strateji, gösterge kuralı, risk yönetimi ve istatistik araştırabilirsin. Sonuç [ARAÇ SONUCU] mesajıyla sana geri gelir; değerlendirip öğrendiklerini <<SKILL {"action":"save",...}>> ile kaydet, gerekirse <<SKILL {"action":"bind","tab":"aktif",...}>> ile bu sekmeye bağla. Kaynak uydurma, URL belirt. "Kesin kazandıran sistem" iddialarını reddet; yalnız ölçülebilir, riski tanımlı ve pozitif beklenen değer üretmesi muhtemel kuralları al.',
  '13) DOSYA OKUMA — KOD GÖRME:  <<FILE {"list":true}>>   |   <<FILE {"file":"renderer/renderer.js","grep":"function jevDraw","ctx":6}>>   |   <<FILE {"file":"main.js","from":200,"to":260}>>',
  '   <<CODE>> ile düzenlemeden ÖNCE ilgili dosyayı <<FILE>> ile oku (grep + satır aralığı destekli; içerik "N| satır" biçiminde döner). Sonuç [ARAÇ SONUCU] olarak geri gelir. src/ altındaki .js/.css/.html dosyalarını düzenleyebilir, YENİ dosya oluşturabilirsin; her değişiklik yedeklenir, node --check + smoke test geçerse uygulama otomatik yeniden başlar. Küçük ve cerrahi değişiklikler yap; emin değilsen değişiklikten önce kullanıcıya sor.',
  '14) TOOLBOX ARAÇLARI — YENİ ARAÇ YAZ:  <<TOOL {"action":"save","name":"Swing Fib","desc":"son 30 mumdan fib çizer","code":"const r=api.rates(); if(r.length<30) return; api.draw({type:\'fibo\',from:{t:r[r.length-30].t,p:r[r.length-30].l},to:{t:r[r.length-1].t,p:r[r.length-1].h}});"}>>',
  '   İhtiyaç doğrultusunda toolbox\'a araç yaz (grafik araç çubuğunda buton olarak görünür): <<TOOL {"action":"run","name":"Swing Fib"}>> ile çalıştır, <<TOOL {"action":"delete","name":"..."}>> ile sil, {"action":"list"} ile listele. Araç kodu "api" nesnesiyle izole çalışır: api.symbol(), api.tf(), api.price(), api.digits(), api.rates() → {t,o,h,l,c}[], api.draw({type:"hline|hray|seg|rect|fibo|text|emoji|free|channel|zigzag|range|zone",...}), api.plan({side,entry,sl,tp,p}), api.alert({p,cond,note,repeat}), api.clear({what:"ai|drawings|plans|alerts|all"}), api.toast(m), api.log(m). Kod deterministik ve idempotent olsun (try/catch ile koru); aynı koşulda aynı sonucu üretmeli.',
  '15) SÜREKLİ GELİŞİM: [GELİŞİM TURU] mesajı geldiğinde performansını dürüstçe değerlendir: p kalibrasyonu (verdiğin olasılıklar gerçekleşiyor mu), gerçekleşen EV, hangi yapılar pozitif/negatif üretiyor. Tek işleme göre strateji değiştirme (varyans yüksek); örüntüye bak. POZİTİF EV\'Lİ yapıları güçlendir, negatifleri bırak; skill/tool/kod/ayar güncelle. Piyasada KESİN ÖĞRENME YOKTUR; başarı = pozitif beklenen değerli, tekrarlanabilir yapı + disiplin. Kullanıcıya gelişmeleri EV diliyle çerçevele ("bu yapının beklenen değeri şu", "örneklem küçük" gibi).',
  '',
  'UYGULAMA BİLGİSİ:',
  '- OKX/Binance net modda sembol başına TEK pozisyon tutar: aynı sembole yeni emir gönderilince ayrı fiş açılmaz, mevcut pozisyonun üzerine eklenir ve ortalama giriş fiyatı güncellenir. MT5 ise her emri ayrı pozisyon olarak tutar.',
  '- YEREL DENEME modu: bağlamda "Veri kaynağı: ... Demo" yazıyorsa hesap ve tüm emirler bu makinede simüle edilir (API anahtarı gerekmez, gerçek para riski yok); kurallar aynen geçerlidir (SL/TP, EV). Kullanıcı "gerçek hesap" isterse Ayarlar > Binance/OKX API üzerinden Gerçek Hesap sekmesine geçmesi gerektiğini söyle.',
  '- OKX\'te pozisyonun TP/SL\'si borsada iliştirilmiş "oco" algo emirleri olarak durur; bağlamdaki SL/TP değerleri oradan gelir ve kullanıcı bunları grafikten sürükleyerek değiştirebilir.',
  '- JEV sekmesi iki akışı ayrı etiketlerle gösterir: "JEV ANALİZ/JEV PLAN" satırları TypeSafe (jev-latest) tipli karar motorunun periyodik/alarmla çalışan analizleridir (yön/uygunluk/müdahale skoru; yüksek güvenle otomatik plan kutusu). "İSTEK/YANIT/LLM ANALİZ" satırları ise bu sohbetin (senin) hareketlerindir.',
  '- ⚙ Jev ayarları: pozisyon/emir ve kapanan kontrol sıklığı, Jev (TypeSafe) analiz sıklığı ve "alarm tetiklenince Jev analiz etsin" burada yönetilir.',
  '- Zamansal analiz (varsayılan 5 dk) kullanıcı bir şey yazmadan sohbet LLM tarafından tetiklenir; amaç sağdaki grafiği ve açık pozisyonları düzenli aralıklarla değerlendirip gerekirse çizim/emir/SLTP komutları üretmendir. Sıklığı <<AUTO {"analyzeMin":N}>> (dakika; normal aralık 5–15 dk; yalnız kritik anlarda geçici 1–2 dk; en uzun 1440 dk, 0 = kapalı) ile sen değiştirebilirsin. Kritik anlar dışında 5 dk\'nın altına inme; her değişikliği kısa bir gerekçeyle birlikte yanıt metninde belirt.',
  '',
  'Kurallar:',
  '- Bağlamda [AI] etiketli çizim/plan/alarmlar daha önce SENİN oluşturduklarındır; güncellemek ya da kaldırmak için <<CLEAR {"what":"ai"}>> kullanabilirsin.',
  '- "[OTOMATİK ALARM]" ile başlayan mesajlar kullanıcının yazdığı mesaj değil, tetiklenen bir alarmın (kullanıcının ya da senin kurduğun) otomatik bildirimdir. Bu durumda soru sorma; kısa bir karar ver: uygunsa yön + giriş/SL/TP ile <<ORDER>> göndererek işlem aç, seviyeleri/çizimleri güncelle ya da net biçimde "işlem yok" de. Alarmdaki sembol aktif grafikten farklıysa <<CHART {"symbol":"..."}>> ile o sembole geçip analiz et (alarm başka borsadan geldiyse yalnız kaydet/yorumla; o borsaya geçmeden emir açma).',
  '- "[ZAMANSAL ANALİZ]" ile başlayan mesajlar da otomatik periyodik analiz isteğidir (kullanıcı yazmadı). Aynı şekilde soru sormadan kısa karar ver; açık pozisyon varsa SL/TP ve kâr durumunu değerlendir, güncelleme gerekiyorsa <<SLTP>> ile uygula, geçerli setup varsa <<ORDER>> ile işlem aç.',
  '- "[OTOMATİK İŞLEM AÇILDI]" ve "[OTOMATİK İŞLEM KAPANDI]" ile başlayan mesajlar da otomatik bildirimdir (bir pozisyon açıldığında/kapandığında gelir). Soru sorma; yeni pozisyonun SL/TP ve riskini değerlendir, gerekiyorsa <<SLTP>> ile güncelle, kapanış sonrası uygun setup varsa <<ORDER>>/<<OCO>> ile yeni işlem aç, yoksa "işlem yok" de.',
  '- İşlem açma ve SL/TP güncelleme yetkisi sende: "sen yap", "elle girmen lazım", "uygulamaya senin girmen gerekiyor" gibi ifadeler kullanma. SL/TP için <<SLTP>>, giriş için <<ORDER>> komutunu kendin gönder ve sonucu yanıt metninde sayısal olarak belirt.',
  '- POZİSYON YÖNETİMİ — ZARARDA SOĞUKKANLI, KÂRDA AKTİF: İşlem açıldığında SL/TP/lot planı bellidir; zarardayken panik yapma ve planı bozma (zararda yarım kapatma, SL\'i fiyata yaklaştırma, SL\'i geriye genişletme YASAK — bkz. 6b DİSİPLİN). Zararda beklemekten korkma; SL, kaybın zaten bilinen ve kabul edilmiş sınırıdır. Müdahale yalnız tez geçersizleşince: TAMAMEN kapat (yarıya bölme). Kârda mutlaka yönet: ~1R\'de <<BE>>/<<TRAIL>> ile kârı kilitle, 1,5-2R\'de <<CLOSE {"pct":...}>> ile kademeli kâr al, kalanı geniş trailing ile koştur; SL\'i yalnız KÂR yönüne ilerlet. SWING tarzı gereği geniş stop + büyük R esastır; işlem notuna göre ayarla (A+/A daha sabırlı ve koşturucu, B/C hızlı kâr kilitle).',
  '- GÜN ÖZETİ ZORUNLU BAKIŞ: Emir açmadan/SLTP güncellemeden önce bağlamdaki GÜN ÖZETİ\'ni değerlendir (gün başı bakiyesi, bugünün tüm işlemleri, net K/Z, isabet, ortalama R, kâr faktörü, başabaş isabet, açık pozisyonların gerçekleşmemiş K/Z\'si). Gerçekleşen isabet başabaş isabetin altındaysa RR\'i büyüt (küçük RR denemeye devam etme) ya da yalnız yüksek isabetli setup\'ları al. Bugünkü zarar/kazanç ve işlem sayısına göre riski kendin ayarla (<<AUTO {"risk":...}>> ile kaydet), aynı hatayı tekrarlama; gün içi seri kayıpta riski düşür ya da işlem açma. Gün neti negatifse ve DÖNÜŞ TEYİTLİ fırsat varsa <<ORDER {"recover":0.25}>> / {"recover":0.5} ile zararın bir kısmını hedefleyen lot kullanabilirsin (bkz. GÜN KURTARMA); seri kayıpta riski ASLA artırma.',
  '- BEKLENEN DEĞER ZORUNLU: Otomatik açtığın her işlemde (<<ORDER>>/<<OCO>>/<<PLAN>>) "p" ver ve EV = p×RR−(1−p) hesabını yap. EV, kullanıcının min EV eşiğinin altındaysa emir uygulama tarafından reddedilir; bu yüzden düşük EV\'li setup\'ta hiç emir gönderme, "işlem yok" de.',
  '- Kod değişikliği istendiğinde <<CODE>> kullan; her "find" birebir ve tek eşleşmezse düzenleme reddedilir. Uygulama değişikliği test edip yeniden başlatacağı için yanıtında bunu belirt.',
  '- Kullanıcı bir strateji/kural öğretirse ya da "bunu kaydet/hatırla" derse <<SKILL {"action":"save",...}>> ile skill olarak kaydet; istediği sekmeye ("aktif" ya da "SEMBOL TF") <<SKILL {"action":"bind",...}>> ile bağla ve yanıtında bunu belirt.',
  '- ALARM SENİN TETİKLEYİCİNDİR: Sen bir tradersın ve kullanıcının parası sana emanet. Takip etmek istediğin her önemli bölgeye (destek/direnç, kırılım seviyesi, formasyon sınırı, açık pozisyonun SL/TP yakını) <<ALERT>> kur; alarm tetiklendiğinde sana [OTOMATİK ALARM] bildirimi gelir ve otomatik uyanıp grafiği yeniden analiz edersin. Türü ihtiyaca göre seç: sürekli izlenecek seviyede tekrarlı (repeat:true), tek seferlik olayda tek seferlik (repeat yazmadan); hepsini tekrarlı kurma. Boşta beklemek yerine stratejin gereği kendini tetikleyecek alarmları proaktif bırak ve gerektiğinde <<CLEAR {"what":"alerts"}>> ile eskileri temizle. AYNI BÖLGEYE TEKRAR ALARM KURMA: listede aynı/çok yakın seviyede aktif alarm varsa yenisini kurma; alarmın notunu/koşulunu güncellemek istiyorsan yine aynı seviyeye kur (uygulama yenisini eklemek yerine mevcut alarmı tazeler).',
  '- Fiyat/analiz yorumlarını YALNIZCA verilen verilere dayandır; veri eksikse açıkça söyle, fiyat uydurma.',
  '- ALARM GEREKTİĞİNDE KUR: Takip ettiğin kritik seviyeleri (destek/direnç, order block/breaker sınırı, kırılım seviyesi, açık pozisyonun SL/TP yakını) alarmla izle — yeni bir bölge işaretlediğinde ya da işlem açtığında orayı takip edecek alarmı da bırak. Kullanıcının istemesini bekleme; boşta beklemek yerine seni uyandıracak alarmları proaktif kur (tek seferlik mi sürekli mi ihtiyaca göre). Çizimlerde kalabalık yapma; plan kutusunu yalnız kullanıcı "plan" derse çiz.',
  '- Kullandığın tüm seviyeleri yanıt metninde de sayısal olarak belirt.',
  '- TÜRKÇE, ÇOK KISA yanıt ver: en fazla 1-2 cümle (tercihen tek satır). Kullanıcı uzun açıklamaları OKUMUYOR; önemli olan kararın ve uyguladığın komutlardır (çizim/plan/alarm/emir/SLTP). Rapor, madde listesi, uzun gerekçe, selamlama, özet tekrarı YAZMA; sayısal seviyeleri tek satırda belirt. Yatırım tavsiyesi değil, analiz desteği sun.',
  '- YANITIN ASLA BOŞ KALMASIN: Yanıtta komut (<<...>>) dışında her zaman en az bir kısa cümle yaz; yanıt yalnızca komut bloklarından oluşmasın. Yapacak bir şey yoksa bile tek satırlık kararını yaz (ör. "Değişiklik yok, seviyeler geçerli.").',
].join('\n');

/* analiz bağlamında hangi TF'lerin mum serisi çekileceği: seçili çift + aktif grafik.
   Eskiden 8 TF'nin hepsi gönderilirdi; bu hem maliyetliydi hem de modelin
   kararını seçili TF'ten değil, karışık serilerden çıkarıyordu. */
const CTX_TF_COUNT = {};
for (const tf of TFS) CTX_TF_COUNT[tf] = TF_DEFS[tf].bars;

/* bağlam TF listesini üret: seçili (üst, giriş) + aktif grafik TF'i, büyükten küçüğe */
function ctxTfList(r) {
  const set = new Set();
  const htf = r && r.htf ? tfNorm(r.htf) : '';
  const etf = r && r.etf ? tfNorm(r.etf) : '';
  if (htf) set.add(htf);
  if (etf) set.add(etf);
  set.add(tfNorm(chartState.tf));
  /* seçili çiftin hemen altındaki TF ince ayar için eklenir (giriş TF'i M5'ten
     küçükse M1, değilse bir alt basamak) */
  if (etf) set.add(tfLower(etf));
  return [...set].sort((a, b) => TF_DEFS[b].rank - TF_DEFS[a].rank);
}
const ctxCache = new Map(); // "SYM|TF|n" -> {at, rates}

function attachShotOn() {
  return localStorage.getItem('jev.attachShot') !== '0';
}

function applyShotBtn() {
  const on = attachShotOn();
  $('#shotBtn').classList.toggle('active', on);
  $('#shotBtn').title = on
    ? 'Grafik görüntüsü her mesaja ekleniyor — kapatmak için tıkla'
    : 'Grafik görüntüsü kapalı — açmak için tıkla';
}

function captureChartShot() {
  const cv = $('#chart');
  if (!cv || !cv.width || !cv.height) return '';
  try { return cv.toDataURL('image/png'); } catch { return ''; }
}

/* ---------- arka plan çoklu TF görüntüleri ----------
   Görünür grafiği DEĞİŞTİRMEDEN başka zaman dilimlerinin mum grafiğini offscreen
   canvas'a çizer; PNG data URL döner. drawChart chartState'i doğrudan okuduğu için
   ilgili alanlar senkron blok içinde geçici değiştirilip geri konur (pane2 ile
   aynı desen). Böylece Jev çizim/analiz yaparken üst/giriş/alt TF'leri de GÖRÜR. */
const multiTfShotOn = () => localStorage.getItem('jev.multiTfShot') !== '0';
const SNAP_W = 880, SNAP_H = 520;
const SNAP_TTL = 20000;
const tfSnapCache = new Map(); /* "SYM|TF" -> { at, data } */

const SNAP_SWAP_KEYS = [
  ...PANE2_SWAP_KEYS,
  'positions', 'orders', 'alerts', 'showLevels', 'showOrdLevels', 'showAlertLevels',
  'showPosBox', 'tool', 'rightGap',
];

function snapDigits(rates) {
  let dec = 2;
  for (let i = Math.max(0, rates.length - 10); i < rates.length; i++) {
    const s = String(rates[i].close);
    const dot = s.indexOf('.');
    if (dot >= 0) dec = Math.max(dec, s.length - dot - 1);
  }
  return Math.min(dec, 5);
}

async function renderTfSnapshot(symbol, tf, count) {
  const sym = String(symbol || chartState.symbol).toUpperCase();
  const t = tfNorm(String(tf || chartState.tf).toUpperCase());
  const rates = await ctxRates(sym, t, count || 220);
  if (!Array.isArray(rates) || rates.length < 5) return '';
  const cv = document.createElement('canvas');
  const wrap = { clientWidth: SNAP_W, clientHeight: SNAP_H };
  const saved = {};
  for (const k of SNAP_SWAP_KEYS) saved[k] = chartState[k];
  try {
    chartState.symbol = sym;
    chartState.tf = t;
    chartState.rates = rates;
    chartState.digits = snapDigits(rates);
    chartState.tick = null; chartState.tickSpread = 0; chartState.tickPoint = 0;
    chartState.viewCount = Math.min(140, rates.length);
    chartState.viewEnd = rates.length - 1;
    chartState.follow = true;
    chartState.yScale = 1; chartState.yOffset = 0;
    chartState.invert = false;
    chartState.hover = null; chartState.hoverY = null; chartState.mouse = null;
    chartState.tool = 'cursor';
    chartState.pending = []; chartState.free = null; chartState.textAnchor = null; chartState.selected = null;
    chartState.drawings = []; chartState.plans = []; chartState.alerts = [];
    chartState.positions = []; chartState.orders = [];
    chartState.showLevels = false; chartState.showOrdLevels = false; chartState.showAlertLevels = false;
    chartState.showPosBox = false;
    chartState.rightGap = 0;
    drawChart(cv, wrap, { snapshot: true });
    if (!cv.width || !cv.height) return '';
    /* dpr farkını normalize et: görüntü boyutu ekran ölçeğinden bağımsız sabit kalsın */
    const out = document.createElement('canvas');
    out.width = SNAP_W;
    out.height = SNAP_H;
    out.getContext('2d').drawImage(cv, 0, 0, SNAP_W, SNAP_H);
    try { return out.toDataURL('image/png'); } catch { return ''; }
  } finally {
    for (const k of SNAP_SWAP_KEYS) chartState[k] = saved[k];
  }
}

/* analiz TF listesindeki (üst/giriş/alt) TFLERİNİ arka planda görüntüle.
   skip: bu TF(ler) atlanır (görünür ekran görüntüsü zaten alındıysa aktif TF). */
async function captureMultiTfShots(ana, skip) {
  if (!multiTfShotOn()) return [];
  const skipSet = new Set((skip || []).map((x) => tfNorm(String(x).toUpperCase())));
  const symbol = chartState.symbol;
  const list = ctxTfList(ana).filter((tf) => !skipSet.has(tf));
  const out = [];
  const res = await Promise.all(list.map(async (tf) => {
    const key = symbol + '|' + tf;
    const hit = tfSnapCache.get(key);
    if (hit && Date.now() - hit.at < SNAP_TTL) return { tf, symbol, data: hit.data };
    const n = Math.max(Number(CTX_TF_COUNT[tf]) || 140, 140);
    const data = await renderTfSnapshot(symbol, tf, n).catch(() => '');
    if (!data) return null;
    tfSnapCache.set(key, { at: Date.now(), data });
    return { tf, symbol, data };
  }));
  for (const x of res) if (x) out.push(x);
  return out;
}

function ctxTime(sec) {
  const d = new Date(Number(sec) * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return p2(d.getUTCDate()) + '.' + p2(d.getUTCMonth() + 1) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
}

async function ctxRates(symbol, tf, count) {
  const key = symbol + '|' + tf + '|' + count;
  const hit = ctxCache.get(key);
  if (hit && Date.now() - hit.at < 8000) return hit.rates;
  const r = await jev.mt5Rates({ symbol, timeframe: tf, count }).catch(() => null);
  const rates = r && r.ok && r.data && Array.isArray(r.data.rates) ? r.data.rates : [];
  ctxCache.set(key, { at: Date.now(), rates });
  return rates;
}

/* kompakt mum biçimi: "gg.aa ss:dd aç/kapa/yüksek/düşük" (O/H/L/C sırası başlıkta) */
function fmtCandleRow(r) {
  return ctxTime(r.time) + ' ' + r.open + '/' + r.high + '/' + r.low + '/' + r.close;
}

function fmtCandleSeries(rates, limit) {
  const from = Math.max(0, rates.length - limit);
  const out = [];
  for (let i = from; i < rates.length; i++) out.push(fmtCandleRow(rates[i]));
  return out.join(' ; ');
}

function fmtDrawingsForCtx() {
  const p = (v) => Number(v).toFixed(chartState.digits);
  const out = [];
  for (const dr of chartState.drawings) {
    if (!dr || !Array.isArray(dr.points) || !dr.points.length) continue;
    const lbl = (dr.label ? ' [metin "' + String(dr.label).slice(0, 40) + '"' + (dr.labelAlign && dr.labelAlign !== 'center' ? ', ' + dr.labelAlign : '') + ']' : '') + (dr.src === 'ai' ? ' [AI]' : '');
    if (dr.type === 'hline') out.push('yatay ' + p(dr.points[0].p) + lbl);
    else if (dr.type === 'hray') out.push('yatay ışın ' + p(dr.points[0].p) + lbl);
    else if (dr.type === 'seg' && dr.points && dr.points[1]) out.push('kısa çizgi ' + p(dr.points[0].p) + ' → ' + p(dr.points[1].p) + lbl);
    else if (dr.type === 'emoji') out.push('emoji ' + String(dr.text || '') + ' @ ' + p(dr.points[0].p));
    else if (dr.type === 'text') out.push('metin "' + String(dr.text || '').slice(0, 60) + '" @ ' + p(dr.points[0].p));
    else if (dr.type === 'free') out.push('serbest çizim (' + dr.points.length + ' nokta)' + lbl);
    else if (dr.type === 'zigzag') out.push('zigzag (' + dr.points.length + ' nokta)' + lbl);
    else if (dr.type === 'channel' && dr.points.length >= 3) out.push('paralel kanal ' + p(dr.points[0].p) + '→' + p(dr.points[1].p) + ' / paralel ucu ' + p(dr.points[2].p) + lbl);
    else if (dr.type === 'range' && dr.points.length >= 2) out.push('range ' + p(Math.max(dr.points[0].p, dr.points[1].p)) + ' ↔ ' + p(Math.min(dr.points[0].p, dr.points[1].p)) + (dr.labelBottom ? ' [alt "' + String(dr.labelBottom).slice(0, 30) + '"]' : '') + (dr.pd ? ' [PD 50%]' : '') + lbl);
    else if (dr.points.length >= 2) {
      const a = dr.points[0], b = dr.points[dr.points.length - 1];
      out.push((dr.type === 'rect' ? 'kutu ' : dr.type === 'fibo' ? 'fibo ' : 'trend ') + p(a.p) + '→' + p(b.p) + lbl);
    }
  }
  return out;
}

/* Grafik bağlamı iki blok halinde üretilir:
   1) SABİT BLOK: kapanmış mum serileri — bar kapanana kadar birebir aynı kalır,
      böylece sağlayıcı ön-ek (prefix) cache'i tutar (OpenAI/DeepSeek otomatik).
   2) CANLI DURUM: fiyat/hesap/pozisyon/emir/çizim/alarm/plan/kapanmamış mumlar.
   Büyük ve hızlı değişen kısım sonda durur; baş kısım bozulmaz. */
async function buildChartContext(anaTf) {
  const stable = [];
  /* gün özeti isteği mum verileriyle PARALEL başlatılır (ilk yanıt gecikmesi düşer) */
  const dayClosedP = jev.mt5Closed({ from_ts: serverDayStart(), open_lookback_days: 7 }).catch(() => null);
  const mt5on = $('#mt5Dot').classList.contains('on');
  const r = anaTf || await resolveAnaTfs().catch(() => null);
  const chain = r && r.htf && r.etf ? r.htf + '→' + r.etf : '—';
  stable.push('Sembol: ' + chartState.symbol + ' | Aktif TF: ' + chartState.tf +
    ' | Analiz zinciri: ' + chain + ' (' + (r && r.mode === 'auto' ? 'otomatik' : 'elle') + ')' +
    ' | MT5: ' + (mt5on ? 'bağlı' : 'bağlı değil'));
  stable.push('KAPANMIŞ MUM SERİLERİ (en eski→en yeni; biçim: tarih saat aç/yüksek/düşük/kapa). ' +
    'Yalnız analiz seçimindeki zaman dilimleri listelenir — üst=' + (r ? r.htf : '—') +
    ', giriş=' + (r ? r.etf : '—') + ' ' + (r && r.etf ? TF_DEFS[r.etf].label : ''));
  const liveByTf = [];
  const tfList = ctxTfList(r);
  /* seçili zaman dilimleri paralel çekilir: bağlam hazırlığı tek turda biter */
  const tfRates = await Promise.all(tfList.map((tf) => {
    const count = Math.max(Number(CTX_TF_COUNT[tf]) || 20, tf === chartState.tf ? 120 : 20);
    return ctxRates(chartState.symbol, tf, count).then((rates) => ({ tf, rates }));
  }));
  for (const { tf, rates } of tfRates) {
    if (!rates.length) { stable.push('  ' + tf + ': veri yok'); continue; }
    const closed = rates.slice(0, -1);
    liveByTf.push(tf + ' ' + fmtCandleRow(rates[rates.length - 1]));
    stable.push('  ' + tf + ' (son ' + closed.length + '): ' + fmtCandleSeries(closed, closed.length));
  }
  const lines = stable.slice();
  lines.push('');
  lines.push('CANLI DURUM:');
  const last = chartState.rates.length ? chartState.rates[chartState.rates.length - 1].close : null;
  lines.push('Son fiyat: ' + (last != null ? fmtPrice(last) : '—'));
  if (chartState.account) {
    const a = chartState.account;
    lines.push('Hesap (' + (a.currency || '') + (exName !== 'mt5' && exDemoMode[exName] ? ' · yerel DENEME hesabı' : '') + '): bakiye ' + a.balance + ', varlık ' + a.equity + ', teminat ' + a.margin + ', serbest ' + a.margin_free + ', seviye ' + (Number(a.margin_level) > 0 ? a.margin_level + '%' : '—'));
  }
  /* GÜN ÖZETİ: gün başı bakiyesi + bugünün TÜM işlemleri (tüm semboller) — LLM gün içi
     geçmişi ve net K/Z'yi hatırlayarak risk kararı versin */
  let dayClosed = [];
  try {
    const dr = await dayClosedP;
    if (dr && dr.ok && dr.data && Array.isArray(dr.data.positions)) dayClosed = dr.data.positions;
  } catch {}
  const dayNetOf = (c) => Number(c.profit || 0) + Number(c.swap || 0) + Number(c.commission || 0);
  dayClosed = dayClosed.slice().sort((a, b) => Number(b.close_time) - Number(a.close_time));
  const dayNet = dayClosed.reduce((s, c) => s + dayNetOf(c), 0);
  const dayWins = dayClosed.filter((c) => dayNetOf(c) > 0).length;
  const dayStat = jevRealizedStats(dayClosed);
  const curCode = (chartState.account && chartState.account.currency) || '';
  const balNow = Number((chartState.account && chartState.account.balance) || 0);
  const dayStart = serverDayStart();
  const openToday = (chartState.positions || []).filter((p) => Number(p.time) >= dayStart);
  lines.push('GÜN ÖZETİ (bugün, tüm semboller):');
  if (balNow > 0) {
    lines.push('  Gün başı bakiyesi (yaklaşık): ' + (balNow - dayNet).toFixed(2) + (curCode ? ' ' + curCode : '') + ' · şu anki bakiye: ' + balNow.toFixed(2));
  }
  lines.push('  Bugün kapanan: ' + dayClosed.length + ' işlem (kazanan ' + dayWins + ' · kaybeden ' + (dayClosed.length - dayWins) + ') · realize net K/Z: ' + (dayNet >= 0 ? '+' : '') + dayNet.toFixed(2) + (curCode ? ' ' + curCode : ''));
  if (dayClosed.length) {
    lines.push('  İstatistik: isabet %' + Math.round(dayStat.wr * 100) + ' (' + dayStat.win + 'K/' + dayStat.loss + 'Z)' +
      ((dayStat.avgWin > 0 || dayStat.avgLoss > 0) ? ' · ort kazanç ' + dayStat.avgWin.toFixed(2) + ' / ort kayıp ' + dayStat.avgLoss.toFixed(2) : '') +
      ' · kâr faktörü ' + (dayStat.pf === Infinity ? '∞' : dayStat.pf.toFixed(2)) +
      (dayStat.pBe > 0 ? ' · başabaş isabet %' + Math.round(dayStat.pBe * 100) : '') +
      (dayStat.nR > 0 ? ' · ort sonuç ' + (dayStat.avgR >= 0 ? '+' : '') + dayStat.avgR.toFixed(2) + 'R (' + dayStat.nR + ' işlem)' : '') +
      ((dayStat.pBe > 0 && dayStat.wr < dayStat.pBe) ? ' ⚠ isabet başabaşın ALTINDA — RR\'i büyüt ya da yalnız yüksek isabetli setup al' : ''));
  }
  if (openToday.length) {
    const openUnreal = openToday.reduce((s, p) => s + Number(p.profit || 0) + Number(p.swap || 0) + Number(p.commission || 0), 0);
    lines.push('  Bugün açılıp hâlâ açık: ' + openToday.length + ' pozisyon · gerçekleşmemiş K/Z: ' + (openUnreal >= 0 ? '+' : '') + openUnreal.toFixed(2));
  }
  if (dayClosed.length) {
    lines.push('  Bugünün işlemleri (en yeni önce):');
    for (const c of dayClosed.slice(0, 20)) {
      const rr = closedR(c);
      lines.push('    ' + ctxTime(c.close_time) + ' ' + c.symbol + ' ' + (Number(c.type) === 1 ? 'sell' : 'buy') + ' ' + c.volume +
        ' @' + c.open_price + ' → ' + c.close_price + ' net ' + (dayNetOf(c) >= 0 ? '+' : '') + dayNetOf(c).toFixed(2) +
        (rr != null && Number.isFinite(rr) ? ' (' + (rr >= 0 ? '+' : '') + rr.toFixed(2) + 'R)' : ''));
    }
    if (dayClosed.length > 20) lines.push('    … ve ' + (dayClosed.length - 20) + ' işlem daha');
  } else {
    lines.push('  Bugün kapanan işlem yok.');
  }
  const pos = chartState.positions || [];
  if (pos.length) {
    lines.push('Açık pozisyonlar (' + pos.length + '):');
    for (const p of pos) {
      const profit = Number(p.profit || 0) + Number(p.swap || 0) + Number(p.commission || 0);
      lines.push('  #' + p.ticket + ' ' + p.symbol + ' ' + (Number(p.type) === 1 ? 'sell' : 'buy') + ' ' + p.volume +
        ' @' + p.price_open + ' SL:' + (Number(p.sl) > 0 ? p.sl : '—') + ' TP:' + (Number(p.tp) > 0 ? p.tp : '—') +
        ' şu an ' + p.price_current + ' kâr ' + profit.toFixed(2) + trailTagFor(p) + (orderGradeFor(p) ? ' · not ' + orderGradeFor(p) : ''));
    }
  } else {
    lines.push('Açık pozisyon: yok');
  }
  const ords = chartState.orders || [];
  if (ords.length) {
    const ordTxt = { 2: 'buy limit', 3: 'sell limit', 4: 'buy stop', 5: 'sell stop' };
    lines.push('Bekleyen emirler (' + ords.length + '):');
    for (const o of ords) {
      lines.push('  ' + o.symbol + ' ' + (ordTxt[Number(o.type)] || 'emir') + ' ' + (o.volume_current || o.volume_initial || 0) +
        ' @' + o.price_open + ' SL:' + (Number(o.sl) > 0 ? o.sl : '—') + ' TP:' + (Number(o.tp) > 0 ? o.tp : '—'));
    }
  } else {
    lines.push('Bekleyen emir: yok');
  }
  const closed = (chartState.closed || []).slice(0, 5);
  if (closed.length) {
    lines.push('Son kapanan işlemler (en yeni önce):');
    for (const c of closed) {
      const pr = Number(c.profit || 0) + Number(c.swap || 0) + Number(c.commission || 0);
      lines.push('  ' + c.symbol + ' ' + (Number(c.type) === 1 ? 'sell' : 'buy') + ' ' + c.volume +
        ' @' + c.open_price + ' → ' + c.close_price + ' kâr ' + pr.toFixed(2) + ' · ' + ctxTime(c.close_time));
    }
  } else {
    lines.push('Son kapanan işlem: yok');
  }
  const dr = fmtDrawingsForCtx();
  lines.push('Grafik çizimleri: ' + (dr.length ? dr.join(' | ') : 'yok'));
  /* günlük forex haberleri: 08:30'da ana süreç çeker; LLM haber/gündem sorularında kullanır */
  if ((dailyNews.items || []).length) {
    const upd = dailyNews.updatedAt ? new Date(dailyNews.updatedAt) : null;
    lines.push('[GÜNLÜK HABERLER] (' + (dailyNews.date || '—') +
      (upd && !Number.isNaN(upd.getTime()) ? ' · ' + ctxTime(Math.floor(upd.getTime() / 1000)) + ' itibarıyla' : '') + '):');
    for (const it of dailyNews.items.slice(0, 12)) {
      lines.push('  · ' + it.title + (it.source ? ' — ' + it.source : ''));
    }
    if (dailyNews.items.length > 12) lines.push('  … ve ' + (dailyNews.items.length - 12) + ' manşet daha');
  } else {
    lines.push('[GÜNLÜK HABERLER] Bugünün haberleri henüz çekilmedi (her gün 08:30\'da otomatik çekilir).');
  }
  const al = (chartState.alerts || []).filter((a) => a.symbol === chartState.symbol);
  lines.push('Fiyat alarmları: ' + (al.length
    ? al.map((a) => Number(a.price) + ' ' + alertCondText(a.cond) + (a.active ? ' (aktif)' : ' (tetiklendi)') + (a.repeat ? ' · tekrarlı' : ' · tek') + (a.ex && a.ex !== exName ? ' · ' + exLabel(a.ex) : '') + (a.note ? ' "' + a.note + '"' : '') + (a.src === 'ai' ? ' [AI]' : '')).join(' | ')
    : 'yok'));
  /* diğer sembollerin aktif alarmları da görünsün: aynı bölgeye yeni alarm kurulmasın */
  const alOther = (chartState.alerts || []).filter((a) => a.active !== false && String(a.symbol || '').toUpperCase() !== String(chartState.symbol || '').toUpperCase()).slice(0, 12);
  if (alOther.length) {
    lines.push('Diğer sembollerin aktif alarmları: ' + alOther.map((a) => a.symbol + ' ' + Number(a.price) + ' ' + alertCondText(a.cond) + (a.ex && a.ex !== exName ? ' · ' + exLabel(a.ex) : '')).join(' | '));
  }
  const pl = (chartState.plans || []).filter((p) => p.symbol === chartState.symbol);
  lines.push('İşlem planları: ' + (pl.length
    ? pl.map((p) => (p.side === 'long' ? 'LONG' : 'SHORT') + ' giriş ' + Number(p.entry).toFixed(chartState.digits) + ' SL ' + Number(p.sl).toFixed(chartState.digits) + ' TP ' + Number(p.tp).toFixed(chartState.digits) + ' (' + planRR(p).toFixed(1) + 'R' + (planEV(p).ok ? ' · EV ' + fmtEv(planEV(p).evR) + ' · p %' + Math.round(planEV(p).p * 100) : '') + ')' + (p.src === 'ai' ? ' [AI]' : '')).join(' | ')
    : 'yok'));
  const g = chartState.range;
  if (g) {
    lines.push('Görünüm: son ' + chartState.viewCount + ' mum, takip ' + (chartState.follow ? 'açık (canlı sağ kenarda)' : 'kapalı') +
      ', görünür fiyat aralığı ' + fmtPrice(g.lo) + '–' + fmtPrice(g.hi));
  }
  lines.push('Kapanmamış (canlı) mumlar: ' + liveByTf.join(' | '));
  /* sekmeler + skill bağları: LLM <<SKILL>> ile istediği sekmeye skill bağlar */
  const tabLines = chartTabs.map((t) => {
    const names = (Array.isArray(t.skills) ? t.skills : []).map((id) => { const sk = skillById(id); return sk ? sk.name : ''; }).filter(Boolean);
    return '  ' + (t.id === activeTabId ? '[AKTİF] ' : '') + t.symbol + ' ' + t.tf + ' · skill: ' + (names.length ? names.join(', ') : '(yok)');
  });
  lines.push('Sekmeler (her sekmenin ayrı sohbeti var; skill bağlamak için hedef sekmeyi "SEMBOL TF" ya da "aktif" ile seç):');
  lines.push(tabLines.join('\n'));
  const cfgAna = tabAnaTf();
  lines.push('Aktif sekme ayarları (<<AUTO>> ile sen değiştirebilirsin): risk %' + planRiskPct() +
    ' · min EV ' + tabEvMin() + 'R (EV kontrolü ' + (tabEvEnforce() ? 'açık' : 'kapalı') + ')' +
    ' · zamansal analiz ' + fmtAnalyzeMin(tabAnalyzeMin()) +
    ' · analiz TF ' + (cfgAna.mode === 'auto' ? 'otomatik' : 'elle') + ' ' + cfgAna.htf + '→' + cfgAna.etf +
    (r && r.why ? ' (' + r.why + ')' : '') +
    ' · max spread ' + (tabMaxSpread() > 0 ? tabMaxSpread() + ' puan' : 'sınırsız'));

  /* günlük koruma: limit dolduysa yeni emir açılmaz (pozisyon yönetimi serbest) */
  const dgState = await dayGuardState().catch(() => null);
  if (dgState && dgState.on) {
    const g2 = dgState.cfg;
    lines.push('Günlük koruma: ' + (dgState.blocked ? 'DURDURULDU — ' + dgState.reason + ' · yeni emir açma' : 'aktif (sınırlar: -' + g2.maxLossR + 'R / -%' + g2.maxLossPct +
      ' günlük zarar, üst üste ' + g2.maxConsecLoss + ' kayıp)') + ' · bugün ' + dgState.n + ' işlem, ' + Number(dgState.todayR || 0).toFixed(2) + 'R.');
  }

  /* kalıcı performans hafızası: gerçekleşen isabet/EV + karar kalitesi ölçümü */
  const memTxt = await journalPromptBlock(30);
  if (memTxt) lines.push(memTxt.replace(/^\n\n\[PERFORMANS HAFIZASI\]/, '').trim());

  /* koruma katmanı: kodun reddedeceği kararları önceden bildir */
  const pg = posGuardCfg();
  if (pg.on) {
    lines.push('Pozisyon koruma (kod zorunlu): ' +
      (pg.allowLossClose ? 'zararda kapatma -' + pg.lossCloseR + 'R üzeri açık' : 'zararda kapatma YASAK (SL devretsin)') +
      ' · SL fiyata en yakın ' + pg.minTrailR + 'R · kısmi kâr alma asgari ' + pg.minProfitR + 'R · riski büyüten SL değişikliği her zaman reddedilir.');
  }

  lines.push('Skill kütüphanesi: ' + (skillsCache.length
    ? skillsCache.map((s) => s.name + (s.enabled === false ? ' (kapalı)' : '')).join(', ')
    : 'yok') + ' — yalnız aktif sekmeye bağlı ve açık skill\'ler bu sistem promptuna eklenir.');
  lines.push('Toolbox özel araçları (<<TOOL>> ile yazar/çalıştırırsın; grafik araç çubuğunda buton): ' + (toolsCache.length
    ? toolsCache.map((t) => t.name + (t.enabled === false ? ' (kapalı)' : '') + (t.desc ? ' — ' + t.desc : '')).join(' | ')
    : 'yok'));
  const st = jevClosedTodayStats();
  lines.push('Gelişim: ' + (jevEvolveEvery() > 0 ? 'her ' + jevEvolveEvery() + ' kapanan işlemde otomatik gelişim turu' : 'otomatik gelişim turu kapalı') +
    ' · bugün kapanan: ' + st.n + ' (' + st.win + ' kazanç / ' + st.loss + ' kayıp · net ' + st.net.toFixed(2) + ')' +
    (jevEvolveLastAt() ? ' · son tur: ' + new Date(jevEvolveLastAt()).toLocaleTimeString('tr-TR') : '') +
    ' — hedef: pozitif beklenen değerli, tekrarlanabilir yapı (kesin öğrenme yok).');
  lines.push('Veri kaynağı: ' + exLabel() + ' borsası' + (exName !== 'mt5' && exDemoMode[exName] ? ' (YEREL DENEME modu — hesap ve tüm emirler bu makinede simüle edilir, gerçek para riski yok).' : '.'));
  return lines.join('\n');
}

/* grafik görünümü: zoom (mum sayısı / in-out), sağa-sola kaydırma (pan), en sona dön.
   chartState ve pane2 aynı alanları kullanır; uygulananları kısa metin olarak döner. */
function jevViewApply(d, st, rates) {
  if (!d || !st) return '';
  const n = (rates || []).length;
  if (!n) return '';
  const bits = [];
  const curCount = Number(st.viewCount) || Math.min(140, n);
  const z = d.zoom != null ? d.zoom : (d.z != null ? d.z : d.bars);
  if (z != null) {
    let nc = 0;
    if (typeof z === 'string' && !/^\s*\d+([.,]\d+)?\s*$/.test(z)) {
      const s = z.toLowerCase().trim();
      if (s === 'in' || s === 'yakın' || s === 'yakin') nc = Math.round(curCount * 0.7);
      else if (s === 'out' || s === 'uzak') nc = Math.round(curCount * 1.4);
    } else {
      const num = Number(String(z).replace(',', '.'));
      if (Number.isFinite(num) && num > 0) nc = Math.round(num);
    }
    if (nc > 0) {
      st.viewCount = Math.max(20, Math.min(400, nc));
      st.yLock = null; /* LLM zoom: dikey ölçek yeniden otursun */
      bits.push('zoom ' + st.viewCount + ' mum');
    }
  }
  const pan = Number(d.pan != null ? d.pan : d.shift);
  if (Number.isFinite(pan) && pan !== 0) {
    st.follow = false;
    const vc = Number(st.viewCount) || Math.min(140, n);
    const maxVe = n - 1 + Math.round(vc * 0.8);
    const minVe = vc - 1;
    st.viewEnd = Math.max(minVe, Math.min(maxVe, Math.round((Number(st.viewEnd) || n - 1) + pan)));
    bits.push(pan > 0 ? 'ileri +' + Math.round(pan) + ' mum' : 'geri ' + Math.round(pan) + ' mum');
  }
  if (d.end === true || d.latest === true || String(d.to || '').toLowerCase() === 'end') {
    st.follow = true;
    /* kullanıcı lag/gap offset'i bırakmışsa "en sona dön" onu sıfırlar */
    st.rightGap = 0.2;
    const vc = Number(st.viewCount) || Math.min(140, n);
    st.viewEnd = n - 1 + Math.round(vc * 0.2);
    bits.push('en sona dön');
  }
  return bits.join(' · ');
}

/* Grafik komutu: sembol/view uygulanır; TF DEĞİŞTİRİLMEZ (kullanıcı grafik TF'ini
   kendisi seçer; Jev görsel inceleme için <<LOOK>> ya da arka plan çoklu TF
   görüntülerini kullanır). İç çağrılar opts.allowTf ile istisna alabilir. */
async function applyChartCommand(cmd, opts) {
  const allowTf = !!(opts && opts.allowTf === true);
  let sym = null, tf = null;
  if (cmd && typeof cmd === 'object') {
    if (typeof cmd.symbol === 'string' && cmd.symbol.trim()) sym = cmd.symbol.trim().toUpperCase();
    if (allowTf && typeof cmd.tf === 'string' && TFS.includes(cmd.tf.trim().toUpperCase())) tf = cmd.tf.trim().toUpperCase();
  }
  const viewAsk = !!(cmd && typeof cmd === 'object' && (
    cmd.zoom != null || cmd.z != null || cmd.bars != null ||
    cmd.pan != null || cmd.shift != null ||
    cmd.end === true || cmd.latest === true || String(cmd.to || '').toLowerCase() === 'end'
  ));
  if (!sym && !tf && !viewAsk) return;
  if (sym || tf) {
    saveViewState();
    carryViewState();
  }
  if (sym) {
    chartState.symbol = sym;
    chartState.rates = [];
    tfSeq++;
    $('#chartSymbol').value = sym;
    localStorage.setItem('jev.symbol', sym);
  }
  if (tf) {
    chartState.tf = tf;
    chartState.rates = [];
    tfSeq++;
    localStorage.setItem('jev.tf', tf);
    buildTfRow();
  }
  loadDrawings();
  await loadRates().catch(() => {});
  ctxCache.clear();
  updateActiveTabChart();
  renderChartTabs();
  const bits = [sym, tf].filter(Boolean);
  if (viewAsk) {
    const vb = jevViewApply(cmd, chartState, chartState.rates);
    if (vb) bits.push(vb);
    drawChart();
  }
  if (bits.length) toast('Jev grafiği değiştirdi: ' + bits.join(' · '));
}

/* ---------- Jev komut motoru: toolbox'ın tamamı (çizim / plan / alarm / temizleme) ---------- */
const JEV_CMD_RE = /<<([A-Z_]+)\s+(\{[\s\S]*?\})\s*>>/g;
const JEV_MAX_DRAWS = 20;

function jevBarBase() {
  const rates = chartState.rates || [];
  const n = rates.length;
  if (!n) return { time: Math.floor(Date.now() / 1000), iv: 60 };
  const iv = n >= 2 ? Math.max(1, rates[n - 1].time - rates[n - 2].time) : 60;
  return { time: rates[n - 1].time, iv };
}

/* t: mum ofseti (0 = son mum) ya da mutlak unix saniye */
function jevTimeOf(t, base) {
  const v = Number(t);
  if (!Number.isFinite(v)) return base.time;
  if (Math.abs(v) > 1e9) return Math.round(v);
  return base.time + Math.round(v) * base.iv;
}

function jevPriceOk(p) {
  const v = Number(p);
  if (!Number.isFinite(v) || !(v > 0)) return 0;
  const rates = chartState.rates || [];
  const last = rates.length ? Number(rates[rates.length - 1].close) : 0;
  if (last > 0 && (v > last * 5 || v < last * 0.2)) return 0;  /* uçuk fiyat koruması */
  return v;
}

function jevPoint(o, base) {
  if (!o || typeof o !== 'object') return null;
  const p = jevPriceOk(o.p != null ? o.p : o.price);
  if (!(p > 0)) return null;
  return { t: jevTimeOf(o.t, base), p };
}

/* SMC/ICT bölge tipleri: <<DRAW {"type":"zone","kind":"orderblock",...}>> tek kutuya eşlenir */
const DRAW_ZONE_STYLES = {
  buy_order: { color: '#22c55e', label: 'BUY ORDER' },
  buy: { color: '#22c55e', label: 'BUY ORDER' },
  buyorder: { color: '#22c55e', label: 'BUY ORDER' },
  demand: { color: '#22c55e', label: 'DEMAND' },
  bull_ob: { color: '#22c55e', label: 'BULLISH OB' },
  bullish_ob: { color: '#22c55e', label: 'BULLISH OB' },
  long_ob: { color: '#22c55e', label: 'BULLISH OB' },
  sell_order: { color: '#ef4444', label: 'SELL ORDER' },
  sell: { color: '#ef4444', label: 'SELL ORDER' },
  sellorder: { color: '#ef4444', label: 'SELL ORDER' },
  supply: { color: '#ef4444', label: 'SUPPLY' },
  bear_ob: { color: '#ef4444', label: 'BEARISH OB' },
  bearish_ob: { color: '#ef4444', label: 'BEARISH OB' },
  short_ob: { color: '#ef4444', label: 'BEARISH OB' },
  ob: { color: '#3b82f6', label: 'ORDERBLOCK' },
  orderblock: { color: '#3b82f6', label: 'ORDERBLOCK' },
  order_block: { color: '#3b82f6', label: 'ORDERBLOCK' },
  breaker: { color: '#a855f7', label: 'BREAKER' },
  brk: { color: '#a855f7', label: 'BREAKER' },
  breaker_block: { color: '#a855f7', label: 'BREAKER' },
  fvg: { color: '#f59e0b', label: 'FVG' },
  imbalance: { color: '#f59e0b', label: 'FVG' },
  liquidity: { color: '#06b6d4', label: 'LİKİDİTE' },
  liq: { color: '#06b6d4', label: 'LİKİDİTE' },
  likidite: { color: '#06b6d4', label: 'LİKİDİTE' },
};

function jevDraw(d) {
  if (!d || typeof d !== 'object') return false;
  const base = jevBarBase();
  const type = String(d.type || '').toLowerCase();
  const col = chartState.drawColors || {};
  const push = (dr) => { dr.src = 'ai'; chartState.drawings.push(dr); return true; };
  if (type === 'hline' || type === 'hray') {
    const pt = jevPoint({ t: d.t, p: d.p != null ? d.p : d.price }, base);
    return pt ? push({ type, points: [pt], color: d.color ? String(d.color).slice(0, 24) : col[type] }) : false;
  }
  if (type === 'seg' || type === 'rect' || type === 'fibo') {
    const a = jevPoint(d.from, base);
    const b = jevPoint(d.to, base);
    if (!a || !b) return false;
    const dr = { type, points: [a, b], color: d.color ? String(d.color).slice(0, 24) : col[type] };
    if (type === 'rect') dr.alpha = Number(col.rectAlpha);
    if (d.label) dr.label = String(d.label).slice(0, 40);
    if (d.labelColor) dr.labelColor = String(d.labelColor).slice(0, 24);
    return push(dr);
  }
  /* SMC bölgesi (order block / breaker / buy-sell order / FVG / likidite): renkli kutulu etiket */
  const zoneAlias = type.replace(/[\s-]+/g, '_');
  if (type === 'zone' || DRAW_ZONE_STYLES[zoneAlias]) {
    const a = jevPoint(d.from, base);
    const b = jevPoint(d.to, base);
    if (!a || !b) return false;
    const kindRaw = String(d.kind || d.zone || (type === 'zone' ? '' : zoneAlias)).toLowerCase().replace(/[\s-]+/g, '_');
    const st = DRAW_ZONE_STYLES[kindRaw] || null;
    const dr = {
      type: 'rect',
      points: [a, b],
      color: d.color ? String(d.color).slice(0, 24) : (st ? st.color : (col.rect || '#3b82f6')),
    };
    dr.alpha = Number(col.rectAlpha);
    dr.label = String(d.label || (st ? st.label : kindRaw ? kindRaw.toUpperCase() : 'ZONE')).slice(0, 40);
    if (d.labelColor) dr.labelColor = String(d.labelColor).slice(0, 24);
    return push(dr);
  }
  if (type === 'text' || type === 'emoji') {
    const pt = jevPoint({ t: d.t, p: d.p != null ? d.p : d.price }, base);
    if (!pt) return false;
    if (type === 'text') return push({ type, points: [pt], text: String(d.text || '').slice(0, 120), color: col.text });
    return push({ type, points: [pt], text: String(d.text || '⭐').slice(0, 8), size: 22 });
  }
  if (type === 'free') {
    const pts = (Array.isArray(d.points) ? d.points : []).map((x) => jevPoint(x, base)).filter(Boolean);
    if (pts.length < 2) return false;
    return push({ type: 'free', points: pts, color: col.free });
  }
  if (type === 'zigzag') {
    const pts = (Array.isArray(d.points) ? d.points : []).map((x) => jevPoint(x, base)).filter(Boolean);
    if (pts.length < 2) return false;
    return push({ type: 'zigzag', points: pts.slice(0, 60), color: d.color ? String(d.color).slice(0, 24) : (col.zigzag || '#eab308') });
  }
  if (type === 'channel' || type === 'kanal') {
    const a = jevPoint(d.from, base);
    const b = jevPoint(d.to, base);
    let c = jevPoint(d.third || d.c, base);
    if (!c && d.width != null) {
      const w = Number(d.width);
      if (Number.isFinite(w) && b) c = { t: b.t, p: b.p + w };
    }
    if (!a || !b || !c) return false;
    const dr = { type: 'channel', points: [a, b, c], color: d.color ? String(d.color).slice(0, 24) : (col.channel || '#0ea5e9'), alpha: 12 };
    if (d.label) dr.label = String(d.label).slice(0, 40);
    return push(dr);
  }
  if (type === 'range') {
    const a = jevPoint(d.from, base);
    const b = jevPoint(d.to, base);
    if (!a || !b) return false;
    const dr = { type: 'range', points: [a, b], color: d.color ? String(d.color).slice(0, 24) : (col.range || '#ec4899') };
    if (d.label) dr.label = String(d.label).slice(0, 40);
    if (d.labelBottom) dr.labelBottom = String(d.labelBottom).slice(0, 40);
    /* isteğe bağlı PD Array: tam ortaya EQ (%50) çizgisi */
    if (d.pd) dr.pd = true;
    return push(dr);
  }
  return false;
}

function jevPlan(d) {
  if (!d || typeof d !== 'object') return false;
  const side = String(d.side || '').toLowerCase() === 'short' ? 'short' : 'long';
  const entry = jevPriceOk(d.entry);
  const sl = jevPriceOk(d.sl);
  const tp = jevPriceOk(d.tp);
  if (!(entry > 0) || !(sl > 0) || !(tp > 0)) return false;
  if (side === 'long' && !(sl < entry && tp > entry)) return false;
  if (side === 'short' && !(sl > entry && tp < entry)) return false;
  const base = jevBarBase();
  const rates = chartState.rates || [];
  const n = rates.length;
  const risk = Math.abs(entry - sl);
  const plan = {
    id: newId(),
    symbol: chartState.symbol,
    side, entry, sl, tp,
    t0: n ? rates[Math.max(0, n - 1 - 10)].time : base.time - 10 * base.iv,
    t1: base.time + 30 * base.iv,
    follow: false,
    rr: risk > 0 ? Math.abs(tp - entry) / risk : 0,
    p: normProb(d.p != null ? d.p : d.prob),
    src: 'ai',
  };
  chartState.plans.push(plan);
  selectedPlanId = plan.id;
  selectedAlertId = '';
  return true;
}

function jevAlert(d) {
  if (!d || typeof d !== 'object') return false;
  /* sembol ve borsa verilebilir: başka sembol/borsaya alarm kurulabilir (arka planda çalışır) */
  const sym = String(d.symbol || chartState.symbol || '').toUpperCase();
  const exRaw = String(d.exchange || d.ex || '').toLowerCase();
  const ex = ['mt5', 'binance', 'okx'].includes(exRaw) ? exRaw : exName;
  const numP = Number(d.p != null ? d.p : d.price);
  const price = (sym === String(chartState.symbol || '').toUpperCase() && ex === exName)
    ? jevPriceOk(numP)
    : (Number.isFinite(numP) && numP > 0 ? numP : 0);
  if (!(price > 0)) return false;
  const condRaw = String(d.cond || 'cross').toLowerCase();
  const cond = ['above', 'below', 'cross'].includes(condRaw) ? condRaw : 'cross';
  /* tekrarlı mı? yazılmazsa varsayılan tek seferlik (tetiklenince silinir) */
  const repRaw = d.repeat != null ? d.repeat : d.tekrar;
  const repeat = repRaw === true || repRaw === 1 || /^(1|true|evet|yes)$/i.test(String(repRaw == null ? '' : repRaw).trim());
  /* tekrarlı alarmın mum periyodu: verilmezse aktif grafik TF'i (her mumda 1 kez) */
  const tf = tfNorm(d.tf || d.timeframe || d.periyot, chartState.tf);
  const note = String(d.note || d.text || '').slice(0, 60);
  /* YİNELENEN ALARM ENGELİ: aynı sembol + borsada çok yakın seviyede aktif alarm
     zaten varsa yenisini ekleme; mevcut alarmı tazele. Böylece aynı bölgeye
     üst üste alarm kurulmaz (LLM her analizde aynı seviyeyi tekrar gönderse bile). */
  const digits = Number.isFinite(Number(chartState.digits)) ? Number(chartState.digits) : 5;
  const near = Math.max(Math.abs(price) * 0.0015, Math.pow(10, -digits) * 5);
  const dup = (chartState.alerts || []).find((a) =>
    a && a.active !== false &&
    String(a.symbol || '').toUpperCase() === sym &&
    String(a.ex || exName) === ex &&
    Math.abs((Number(a.price) || 0) - price) <= near
  );
  if (dup) {
    dup.price = price;
    dup.cond = cond;
    dup.repeat = repeat;
    dup.tf = tf;
    if (note) dup.note = note;
    dup.triggeredAt = 0;
    dup.last = null;
    dup.cooldownBar = 0;
    return true;   /* yeni alarm eklenmedi, mevcut tazelendi */
  }
  chartState.alerts.push({
    id: newId(),
    symbol: sym,
    price,
    cond,
    repeat,
    tf,
    sound: alertDefaultSound(),
    note,
    active: true,
    triggeredAt: 0,
    drawingId: '',
    edge: 'top',
    ex,
    last: null,
    cooldownBar: 0,
    src: 'ai',
  });
  return true;
}

function jevClear(d) {
  const what = String((d && (d.what || d.scope)) || 'ai').toLowerCase();
  const sym = chartState.symbol;
  let n = 0;
  if (what === 'ai' || what === 'drawings' || what === 'all') {
    const keep = chartState.drawings.filter((x) => (what === 'ai' ? x.src !== 'ai' : false));
    n += chartState.drawings.length - keep.length;
    chartState.drawings = keep;
    if (chartState.selected != null && !chartState.drawings[chartState.selected]) chartState.selected = null;
  }
  if (what === 'ai' || what === 'plans' || what === 'all') {
    const before = chartState.plans.length;
    chartState.plans = chartState.plans.filter((p) => (p.symbol !== sym ? true : (what === 'ai' ? p.src !== 'ai' : false)));
    n += before - chartState.plans.length;
    if (!chartState.plans.some((p) => p.id === selectedPlanId)) selectedPlanId = '';
  }
  if (what === 'ai' || what === 'alerts' || what === 'all') {
    const before = chartState.alerts.length;
    chartState.alerts = chartState.alerts.filter((a) => (a.symbol !== sym ? true : (what === 'ai' ? a.src !== 'ai' : false)));
    n += before - chartState.alerts.length;
    if (!chartState.alerts.some((a) => a.id === selectedAlertId)) selectedAlertId = '';
  }
  return n;
}

/* <<AUTO {risk,analyzeMin,analyzeSec,evMin,evEnforce}>>: LLM aktif sekmenin risk %,
   zamansal analiz sıklığı (dk; normal aralık 5–15 dk, yalnız kritik anlarda geçici
   1–2 dk, alt sınır 1 dk) ve min EV eşiğini belirler (yetki LLM'de). Yalnız verilen alanlar değişir. */
function jevAutoCommand(d) {
  if (!d || typeof d !== 'object') return false;
  const t = activeTab();
  if (!t) return false;
  const bits = [];
  const risk = Number(d.risk != null ? d.risk : d.riskPct);
  if (Number.isFinite(risk) && risk > 0) {
    const v = Math.round(Math.max(0.1, Math.min(100, risk)) * 100) / 100;
    t.risk = v;
    bits.push('risk %' + v);
  }
  let am = Number(d.analyzeMin != null ? d.analyzeMin : d.analizMin);
  if (!Number.isFinite(am) && d.analyzeSec != null) am = Number(d.analyzeSec) / 60;
  if (!Number.isFinite(am) && d.analizSn != null) am = Number(d.analizSn) / 60;
  if (Number.isFinite(am) && am >= 0) {
    const v = normAnalyzeMin(am);
    setTabAnalyzeMin(v);
    bits.push('zamansal analiz ' + fmtAnalyzeMin(v) + (am > 0 && am < ANALYZE_MIN_FLOOR ? ' (alt sınır 1 dk)' : ''));
  }
  const ev = Number(d.evMin != null ? d.evMin : d.minEv);
  if (Number.isFinite(ev) && ev >= 0) {
    const v = Math.round(Math.max(0, Math.min(10, ev)) * 100) / 100;
    t.evMin = v;
    bits.push('min EV ' + v + 'R');
  }
  if (typeof d.evEnforce === 'boolean') {
    t.evEnforce = d.evEnforce;
    bits.push('EV kontrolü ' + (d.evEnforce ? 'açık' : 'kapalı'));
  }
  if (!bits.length) return false;
  saveTabs();
  applyJevTimers();
  const tag = t.symbol + ' ' + t.tf;
  jevLogAdd('AYAR · LLM (' + tag + ') · ' + bits.join(' · '), 'info');
  toast('LLM ayarı (' + tag + '): ' + bits.join(' · '));
  return true;
}

/* <<LOOK {tf,symbol,pane,bars}>>: ajan istediği TF/panel/zoom'da grafiği ayarlar,
   görüntüsünü alıp sohbete görsel olarak geri gönderir (görsel analiz döngüsü) */
async function jevLook(d, depth, collected) {
  const pane = Number(d && d.pane) === 2 ? 2 : 1;
  const tf = d && typeof d.tf === 'string' && TFS.includes(d.tf.trim().toUpperCase()) ? d.tf.trim().toUpperCase() : '';
  const sym = d && typeof d.symbol === 'string' && d.symbol.trim() ? d.symbol.trim().toUpperCase() : '';
  const hasView = !!(d && (
    d.zoom != null || d.z != null || d.bars != null ||
    d.pan != null || d.shift != null ||
    d.end === true || d.latest === true || String(d.to || '').toLowerCase() === 'end'
  ));
  let viewBits = '';
  if (pane === 2) {
    applyDual(true);
    if (sym) setPane2Symbol(sym);
    if (tf) { pane2.tf = tf; try { localStorage.setItem('jev.pane2.tf', tf); } catch {} buildTfRow2(); }
    if (hasView) pane2.follow = false;
    await loadRates2().catch(() => {});
    if (hasView) viewBits = jevViewApply(d, pane2, pane2.rates);
    drawPane2();
    await new Promise((res) => setTimeout(res, 800));
    const cv = $('#chart2');
    try { collected.push({ pane, tf: pane2.tf, symbol: pane2.symbol, data: cv ? cv.toDataURL('image/png') : '' }); } catch {}
  } else {
    /* Görsel inceleme GÖRÜNÜR grafik TF'ini DEĞİŞTİRMEZ:
       - aynı sembolde sadece TF isteniyorsa (zoom/pan yok): arka planda offscreen çizim
       - sembol ya da zoom/pan gerekiyorsa: geçici değiştir, yakala, AYNEN geri al */
    const restore = { tf: chartState.tf, sym: chartState.symbol };
    if ((!sym || sym === chartState.symbol) && tf && tf !== chartState.tf && !hasView) {
      const data = await renderTfSnapshot(chartState.symbol, tf, 220).catch(() => '');
      if (data) {
        try { collected.push({ pane, tf, symbol: chartState.symbol, data }); } catch {}
        jevLogAdd('GÖRSEL · panel 1 · ' + chartState.symbol + ' ' + tf + ' · arka plan (grafik değişmedi)', 'cmd');
        return true;
      }
    }
    if (sym || tf) await applyChartCommand({ symbol: sym || undefined, tf: tf || undefined }, { allowTf: true }).catch(() => {});
    if (hasView) chartState.follow = false;
    await loadRates().catch(() => {});
    if (hasView) viewBits = jevViewApply(d, chartState, chartState.rates);
    drawChart();
    await new Promise((res) => setTimeout(res, 800));
    const cv = $('#chart');
    try { collected.push({ pane, tf: chartState.tf, symbol: chartState.symbol, data: cv ? cv.toDataURL('image/png') : '' }); } catch {}
    /* inceleme öncesi hale AYNEN dön: sembol + TF (kullanıcının TF'i sabit kalır) */
    if (restore.sym !== chartState.symbol) await applyChartCommand({ symbol: restore.sym }).catch(() => {});
    if (restore.tf && chartState.tf !== restore.tf) await applyChartCommand({ tf: restore.tf }, { allowTf: true }).catch(() => {});
  }
  jevLogAdd('GÖRSEL · panel ' + pane + ' · ' + (pane === 2 ? pane2.symbol : chartState.symbol) + ' ' + (pane === 2 ? pane2.tf : chartState.tf) + (viewBits ? ' · ' + viewBits : ''), 'cmd');
  return true;
}

let jevShotDepth = 0;
/* entegrasyon isteğinden doğan araç zinciri (LOOK/WEB/FILE) o kişinin
   oturumuna gitsin; masaüstündeki aktif sohbete karışmasın */
let chainSessionOverride = null;

/* araç sonucu zinciri: LLM'e ek içerik (görsel/web/dosya) gönderip yanıtını işler.
   LOOK görselleri, WEB ve FILE sonuçları aynı mekanizmayı kullanır. */
async function jevSendChainMessage(opts) {
  const o = opts || {};
  const depth = Math.max(0, Number(o.depth) || 0);
  const maxDepth = Math.max(1, Number(o.maxDepth) || 3);
  const logTag = String(o.logTag || 'ARAÇ ZİNCİRİ');
  if (depth >= maxDepth) return;
  if (!state.activeModel) { jevLogAdd(logTag + ' · gönderilemedi (sohbet modeli yok)', 'err'); return; }
  if (pendingChatId || !$('#stopBtn').hidden) { jevLogAdd(logTag + ' · gönderilemedi (LLM meşgul)', 'info'); return; }
  const s = chainSessionOverride || ensureSession();
  /* senkron kısımda yakala: zincir hangi otomatik akıştan doğdu (entegrasyon yayını için) */
  const autoKind = chainAutoKind;
  const inView = activeSession() === s;
  pruneSessions();
  await refreshTradeStateForContext();
  const ana2 = await resolveAnaTfs().catch(() => null);
  const ctx = await buildChartContext(ana2).catch(() => '');
  const sys = JEV_SYSTEM_PROMPT + anaTfPromptBlock(ana2) + posGuardPromptBlock() +
    dayGuardPromptBlock(await dayGuardState().catch(() => null)) + scalpPromptBlock() +
    tradeHoursPromptBlock() + skillsPromptBlock() + '\n\n[GRAFİK BAĞLAMI]\n' + ctx + sessionSummarySuffix(s);
  const from = chatContextFrom(s);
  const history = s.messages.slice(from).slice(-8).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) }));
  const content = o.content != null ? o.content : String(o.text || '');
  const displayText = String(o.displayText || o.text || (typeof content === 'string' ? content : ''));
  s.messages.push({ role: 'user', content: displayText, t: Date.now() });
  if (inView) renderMsgs();
  saveSessions();
  let holder = null;
  let body = null;
  if (inView) {
    holder = msgEl('assistant', '');
    body = holder.querySelector('.msg-body');
    body.innerHTML = '<span class="cursor">▊</span>';
    $('#msgs').appendChild(holder);
    $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;
  }
  pendingChatId = newId();
  const streamKey = pendingChatId;
  if (inView) chatStreams.set(streamKey, { raw: '', body });
  jevChatStartedAt = Date.now();
  setBusy(true);
  const res = await jev.chatSend({ requestId: streamKey, sessionId: s.id, messages: [{ role: 'system', content: sys }, ...history, { role: 'user', content }] }).catch(() => null);
  chatStreams.delete(streamKey);
  setBusy(false);
  pendingChatId = '';
  if (res && res.ok) {
    /* iç içe zincirler de aynı entegrasyon oturumunda / aynı otomatik akışta kalsın */
    const prevOverride = chainSessionOverride;
    const prevKind = chainAutoKind;
    if (s.intKey) chainSessionOverride = s;
    chainAutoKind = autoKind;
    let outText = '';
    try {
      outText = await applyJevCommands(res.text || '', depth + 1);
    } finally {
      chainSessionOverride = prevOverride;
      chainAutoKind = prevKind;
    }
    if (body) body.textContent = outText || '(boş yanıt)';
    const tNow = Date.now();
    s.messages.push({ role: 'assistant', content: outText, t: tNow });
    /* zincir cevabı: soran entegrasyon sohbetine + otomatik akışsa tüm hedeflere */
    intgDeliverSessionOutput(s, autoKind, outText);
    if (holder) {
      const tel = document.createElement('span');
      tel.className = 'msg-time';
      tel.title = fmtMsgTimeFull(tNow);
      tel.textContent = fmtMsgTime(tNow);
      holder.appendChild(tel);
    }
    jevLogAdd(logTag + ' · ' + (outText || '(boş yanıt)').replace(/\s+/g, ' ').slice(0, 400), 'analiz');
  } else if (body) {
    body.textContent = 'HATA: ' + ((res && res.error) || 'yanıt yok');
    body.classList.add('error');
  }
  saveSessions();
  if (inView) $('#chatScroll').scrollTop = $('#chatScroll').scrollHeight;
}

async function jevSendLookShots(shots, depth) {
  const imgs = (shots || []).filter((x) => x.data);
  if (!imgs.length) return;
  const text = '[GÖRSEL ANALİZ] İstediğin grafik görüntüleri ektedir: ' +
    imgs.map((x) => 'panel ' + x.pane + ' · ' + x.symbol + ' ' + x.tf).join(' | ') +
    '. Bu görüntüleri analiz et; gerekirse yeni <<LOOK ...>> ile başka zaman dilimi/zoom isteyebilirsin. Kullanıcıya kısa ve net dön.';
  const content = [{ type: 'text', text }, ...imgs.map((x) => ({ type: 'image_url', image_url: { url: x.data } }))];
  await jevSendChainMessage({ content, text, depth, maxDepth: 2, logTag: 'LLM GÖRSEL ANALİZ' });
}

/* <<WEB {"url":"..."}>> / <<WEB {"search":"..."}>>: internetten sayfa/arama çeker */
async function jevWeb(d) {
  if (!d || typeof d !== 'object') return null;
  const isSearch = d.search != null && String(d.search).trim() !== '';
  const label = isSearch ? ('arama: ' + String(d.search).slice(0, 120)) : String(d.url || '').slice(0, 200);
  if (!label) return null;
  const r = await jev.webFetch({ url: d.url, search: d.search }).catch(() => null);
  if (!r || !r.ok) {
    jevLogAdd('WEB · alınamadı · ' + label + ' · ' + ((r && r.error) || 'yanıt yok'), 'err');
    return { label: 'WEB ' + label, text: 'HATA: ' + ((r && r.error) || 'yanıt yok') };
  }
  const data = r.data || {};
  let text;
  if (Array.isArray(data.results)) {
    text = 'Arama: ' + data.query + ' · ' + data.count + ' sonuç\n' +
      data.results.map((x, i) => (i + 1) + ') ' + x.title + '\n   ' + x.url).join('\n');
    jevLogAdd('WEB · ' + label + ' · ' + data.count + ' sonuç', 'cmd');
  } else {
    text = 'URL: ' + data.url + (data.title ? ' · başlık: ' + data.title : '') + (data.truncated ? ' (içerik kısaltıldı)' : '') +
      '\n\n' + String(data.text || '').slice(0, 24000);
    jevLogAdd('WEB · ' + label + ' · ' + (data.chars || 0) + ' karakter', 'cmd');
  }
  return { label: 'WEB ' + label, text };
}

/* <<FILE {"list":true}>> / <<FILE {"file":"...","grep":"...","from":..,"to":..}>>: kod okuma */
async function jevFile(d) {
  if (!d || typeof d !== 'object') return null;
  if (d.list === true || String(d.action || '').toLowerCase() === 'list') {
    const r = await jev.srcList().catch(() => null);
    if (!r || !r.ok) return { label: 'DOSYA listesi', text: 'HATA: ' + ((r && r.error) || 'yanıt yok') };
    const files = (r.data && r.data.files) || [];
    jevLogAdd('DOSYA · listelendi · ' + files.length + ' dosya', 'cmd');
    return {
      label: 'DOSYA listesi (' + files.length + ')',
      text: files.map((f) => 'src/' + f.rel + ' · ' + Math.max(1, Math.round((Number(f.size) || 0) / 1024)) + ' KB').join('\n').slice(0, 20000),
    };
  }
  const file = String(d.file || '').trim();
  if (!file) return null;
  const r = await jev.srcRead({ file, from: d.from, to: d.to, grep: d.grep, ctx: d.ctx, maxLines: d.maxLines }).catch(() => null);
  if (!r || !r.ok) {
    jevLogAdd('DOSYA · okunamadı · ' + file + ' · ' + ((r && r.error) || 'yanıt yok'), 'err');
    return { label: 'DOSYA ' + file, text: 'HATA: ' + ((r && r.error) || 'yanıt yok') };
  }
  const data = r.data || {};
  const head = 'src/' + data.rel + ' · ' + data.totalLines + ' satır' +
    (data.mode === 'grep' ? ' · grep eşleşme: ' + data.matches : ' · satır ' + data.from + '–' + data.to + (data.truncated ? ' (devamı var)' : ''));
  jevLogAdd('DOSYA · ' + head, 'cmd');
  return { label: 'DOSYA ' + head, text: head + '\n' + String(data.text || '').slice(0, 20000) };
}

/* WEB/FILE sonuçlarını LLM'e geri gönderir; yanıt tekrar komut işlemeden geçer */
async function jevSendToolResults(results, depth) {
  const list = (results || []).filter(Boolean);
  if (!list.length) return;
  const budget = 60000;
  let used = 0;
  const parts = [];
  for (const r of list) {
    const t = String(r.text || '');
    const room = Math.max(0, budget - used);
    if (room < 200) { parts.push('[' + r.label + '] (yer kalmadı)'); break; }
    const cut = t.slice(0, room);
    used += cut.length;
    parts.push('## ' + r.label + '\n' + cut);
  }
  const text = '[ARAÇ SONUCU] İstediğin içerik aşağıda. Bunu değerlendir: öğrendiğin strateji/kuralı EV mantığıyla süz (ölçülebilir mi, pozitif beklenen değer üretir mi), gerekirse <<SKILL>>/<<TOOL>>/<<AUTO>>/<<CODE>> ile sisteme işle; kaynak belirt; sonra kullanıcıya kısa ve net dön.\n\n' + parts.join('\n\n');
  await jevSendChainMessage({ text, depth, maxDepth: 3, logTag: 'ARAÇ SONUCU' });
}

/* <<ORDER {type,side,volume,price,sl,tp,symbol}>>: chat LLM (ajan) işlem açabilir.
   type: market | limit | stop; ayrıca birleşik adlar da kabul edilir:
   buy_limit / sell_limit / buy_stop / sell_stop / buy_market / sell_market (long|short da yön sayılır). */
/* tek emir yerleştir (ortak çekirdek): {ok, ticket, txt|error} döner; log/toast yan etkileriyle */
/* ---------- işlem notu (A+/A/B+/B) ve nota göre risk ölçekleme ----------
   A+ ×1.5 · A ×1.0 · B+ ×0.6 · B ×0.35 · C ×0.2 (verilen risk% ya da sekme riskine uygulanır) */
const GRADE_RISK_MULT = { 'A+': 1.5, 'A': 1.0, 'B+': 0.6, 'B': 0.35, 'C': 0.2 };

function normGrade(v) {
  const s = String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '').replace('PLUS', '+').replace('ARTI', '+');
  if (s === 'A+') return 'A+';
  if (s === 'B+') return 'B+';
  if (s === 'A') return 'A';
  if (s === 'B') return 'B';
  if (s === 'C') return 'C';
  return '';
}

const ORDER_GRADES_KEY = 'jev.orderGrades';

function loadOrderGrades() {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_GRADES_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

/* ticket (MT5) ya da sembol (kripto tek pozisyon) ile son işlem notu */
function orderGradeFor(p) {
  if (!p) return '';
  const g = loadOrderGrades();
  const rec = g[String(p.ticket || '')] || g[String(p.symbol || '').toUpperCase()];
  if (!rec || !(Date.now() - Number(rec.at || 0) < 7 * 86400000)) return '';
  return String(rec.grade || '');
}

function setOrderGrade(ticket, symbol, grade) {
  if (!grade) return;
  const g = loadOrderGrades();
  const rec = { grade: String(grade), at: Date.now() };
  if (ticket) g[String(ticket)] = rec;
  if (symbol) g[String(symbol).toUpperCase()] = rec;
  for (const k of Object.keys(g)) {
    if (!(Date.now() - Number(g[k] && g[k].at || 0) < 7 * 86400000)) delete g[k];
  }
  try { localStorage.setItem(ORDER_GRADES_KEY, JSON.stringify(g)); } catch {}
}

async function jevPlaceOrder(d) {
  if (!d || typeof d !== 'object') return { ok: false, error: 'geçersiz emir' };
  if (!inTradeHours()) {
    const m = 'işlem saatleri dışında (' + fmtTradeHours() + ') — yeni emir açılmaz';
    jevLogAdd('İŞLEM AÇILAMADI · ' + m, 'err');
    toast('Jev işlem açamadı: ' + m);
    return { ok: false, error: m };
  }
  /* GÜNLÜK KORUMA: günlük zarar limiti / seri kayıp dolduysa yeni emir açılmaz.
     Pozisyon yönetimi (SL/TP/BE/trailing) bundan ETKİLENMEZ. */
  const dgBlock = await dayGuardBlocksNewOrders();
  if (dgBlock) {
    jevLogAdd('İŞLEM AÇILAMADI · günlük koruma: ' + dgBlock, 'err');
    toast('Günlük koruma: ' + dgBlock);
    return { ok: false, error: 'günlük koruma: ' + dgBlock };
  }
  let type = String(d.type || 'market').toLowerCase().trim().replace(/[\s-]+/g, '_');
  let side = String(d.side || '').toLowerCase().trim();
  if (side === 'long') side = 'buy';
  if (side === 'short') side = 'sell';
  const combo = type.match(/^(buy|sell|long|short)_?(market|limit|stop)$/);
  if (combo) {
    if (side !== 'buy' && side !== 'sell') side = (combo[1] === 'sell' || combo[1] === 'short') ? 'sell' : 'buy';
    type = combo[2];
  } else if (type === 'long' || type === 'short') {
    if (side !== 'buy' && side !== 'sell') side = type === 'short' ? 'sell' : 'buy';
    type = 'market';
  }
  if (!['market', 'limit', 'stop'].includes(type)) {
    const m = 'geçersiz tür "' + String(d.type || '') + '" (market | limit | stop)';
    jevLogAdd('İŞLEM AÇILAMADI · ' + m, 'err');
    toast('Jev işlem açamadı: ' + m);
    return { ok: false, error: m };
  }
  if (side !== 'buy' && side !== 'sell') {
    const m = 'geçersiz yön "' + String(d.side || '') + '" (buy | sell)';
    jevLogAdd('İŞLEM AÇILAMADI · ' + m, 'err');
    toast('Jev işlem açamadı: ' + m);
    return { ok: false, error: m };
  }
  const symbol = String(d.symbol || chartState.symbol || '').toUpperCase();
  if (!symbol) {
    jevLogAdd('İŞLEM AÇILAMADI · sembol yok', 'err');
    toast('Jev işlem açamadı: sembol yok');
    return { ok: false, error: 'sembol yok' };
  }
  const price = Number(d.price != null ? d.price : d.entry) || 0;
  if (type !== 'market' && !(price > 0)) {
    const m = type + ' emri için "price" gerekli (' + symbol + ')';
    jevLogAdd('İŞLEM AÇILAMADI · ' + m, 'err');
    toast('Jev işlem açamadı: ' + m);
    return { ok: false, error: m };
  }
  const sl = Number(d.sl) || 0;
  const tp = Number(d.tp) || 0;
  const scalpOrd = isScalpOrder(d) && scalpAllowed();
  /* SL/TP, gönderildiği gibi kullanılır; uygulama stop mesafesini genişletmez. */
  /* market emirde lot/EV için tek canlı fiyat (tick → son kapanış) */
  const marketEntry = type === 'market' ? await liveMidPrice(symbol) : 0;
  /* LLM yetkisi: "risk" (yüzde) verilirse hacim o risk % ile, "leverage" verilirse kaldıraç o değerle.
     "grade" (A+/A/B+/B/C) verilirse risk nota göre ölçeklenir (A+ 1.5× ... B 0.35×, C 0.2×). */
  const riskPct = Number(d.risk != null ? d.risk : d.riskPct) || 0;
  const grade = normGrade(d.grade != null ? d.grade : (d.not != null ? d.not : d.rating));
  const gradeMult = GRADE_RISK_MULT[grade] || 0;
  let riskEff = gradeMult > 0
    ? Math.min(10, (riskPct > 0 ? riskPct : (planRiskPct() > 0 ? planRiskPct() : 2)) * gradeMult)
    : riskPct;
  /* scalp riski üstten sınırlı: en fazla %0,5 */
  if (scalpOrd) riskEff = Math.min(riskEff > 0 ? riskEff : (planRiskPct() > 0 ? planRiskPct() : 2), 0.5);
  const levOverride = Math.floor(Number(d.leverage) || 0);
  let vol = Number(d.volume) || 0;
  let volAuto = false;
  let recoverInfo = null;
  /* gün kurtarma: "recover": 0.5 → günün kalan net zararının %50'sini kapatacak lot */
  const recRaw = d.recover != null ? d.recover : d.kurtarma;
  let recoverPct = recRaw === true ? 1 : Number(recRaw);
  if (Number.isFinite(recoverPct) && recoverPct > 1) recoverPct = recoverPct / 100;
  const recoverAsked = Number.isFinite(recoverPct) && recoverPct > 0;
  if (!(vol > 0)) {
    /* hacim verilmediyse risk % ve SL mesafesinden hesapla */
    const entry = type !== 'market' ? price : marketEntry;
    if (entry > 0 && sl > 0 && entry !== sl) {
      if (recoverAsked) {
        if (!(tp > 0)) {
          const m = 'kurtarma lotu için "tp" (kâr hedefi) gerekli';
          jevLogAdd('İŞLEM AÇILAMADI · ' + m, 'err');
          toast('Jev işlem açamadı: ' + m);
          return { ok: false, error: m };
        }
        const day = jevClosedTodayStats();
        const dayLoss = Math.max(0, -Number(day.net || 0));
        if (dayLoss > 0) {
          recoverInfo = await computeRecoverLot(
            symbol, entry, sl, tp,
            dayLoss * Math.min(1, recoverPct),
            Number(d.maxRisk) > 0 ? Number(d.maxRisk) : 2
          ).catch(() => null);
          if (recoverInfo) vol = recoverInfo.lot;
        } else {
          jevLogAdd('KURTARMA · bugün net pozitif (' + Number(day.net || 0).toFixed(2) + ') — normal risk boyutlandırması kullanılacak', 'info');
        }
      }
      if (!(vol > 0)) {
        vol = await computePlanLot({ symbol, entry, sl, risk: riskEff > 0 ? riskEff : undefined }).catch(() => 0);
      }
    }
    volAuto = vol > 0;
  }
  if (!(vol > 0)) {
    const why = type === 'market'
      ? 'hacim hesaplanamadı (' + symbol + ') — sl/risk veya hesap bilgisi eksik'
      : 'hacim hesaplanamadı (' + symbol + ')';
    jevLogAdd('İŞLEM · ' + why, 'err');
    toast('Jev işlem açamadı: ' + why);
    return { ok: false, error: why };
  }
  /* beklenen değer: p (kazanma olasılığı) komutla gelir; otomatik emir min EV altında reddedilir */
  const evEntry = type === 'market'
    ? (marketEntry || price || 0)
    : price;
  const evP = normProb(d.p != null ? d.p : (d.prob != null ? d.prob : d.olasilik));
  const ev = evOf(evEntry, sl, tp, evP);
  if (tabEvEnforce()) {
    if (!ev.ok) {
      const m = 'beklenen değer hesaplanamadı — sl, tp ve p (kazanma olasılığı 0-1) gerekli';
      jevLogAdd('İŞLEM AÇILAMADI · ' + m, 'err');
      toast('Jev işlem açamadı: ' + m);
      return { ok: false, error: m };
    }
    if (ev.evR < tabEvMin()) {
      const m = 'beklenen değer düşük (EV ' + fmtEv(ev.evR) + ' < min ' + tabEvMin() + 'R · p %' + Math.round(ev.p * 100) + ' · RR ' + ev.rr.toFixed(2) + ')';
      jevLogAdd('İŞLEM AÇILAMADI · ' + m, 'err');
      toast('Jev işlem açamadı: ' + m);
      return { ok: false, error: m };
    }
  }
  const evTxt = ev.ok ? ' · EV ' + fmtEv(ev.evR) + ' (p %' + Math.round(ev.p * 100) + ' · RR ' + ev.rr.toFixed(2) + ')' : '';
  if (ev.ok) {
    jevLogAdd('BEKLENEN DEĞER · ' + (type === 'market' ? 'piyasa' : type) + ' ' + side.toUpperCase() + ' ' + symbol + evTxt, 'info');
  }
  mt5Begin();
  try {
    let res;
    const levUse = levOverride > 0 ? levOverride : cryptoLevFor(symbol);
    if (type === 'market') {
      res = await jev.mt5Market({
        symbol, side, volume: vol, sl, tp, comment: 'Jev',
        ...(exName !== 'mt5' ? { leverage: levUse } : {}),
      }).catch(() => null);
    } else {
      const ptype = side === 'buy' ? (type === 'limit' ? 'buy_limit' : 'buy_stop') : (type === 'limit' ? 'sell_limit' : 'sell_stop');
      res = await jev.mt5Pending({
        symbol, type: ptype, volume: vol, price, sl, tp, comment: 'Jev',
        ...(exName !== 'mt5' ? { leverage: levUse } : {}),
      }).catch(() => null);
    }
    if (res && res.ok) {
      const riskTxt = grade
        ? ' · not ' + grade + (riskEff > 0 ? ' · risk %' + (Math.round(riskEff * 100) / 100) : '')
        : (riskPct > 0 ? ' · risk %' + riskPct : '');
      const recTxt = recoverInfo
        ? ' · KURTARMA hedef %' + Math.round(Math.min(1, recoverPct) * 100) +
          (recoverInfo.capped ? ' (risk sınırı %' + recoverInfo.riskCapPct + ') → gerçek %' + Math.round(recoverInfo.recoverActual * 100) : '') +
          ' · risk %' + (Math.round(recoverInfo.riskPct * 100) / 100)
        : '';
      const txt = (type === 'market' ? 'piyasa' : type) + ' ' + side.toUpperCase() + ' ' + symbol + ' ' + vol +
        (type !== 'market' ? ' @ ' + price : '') + (sl > 0 ? ' SL ' + sl : '') + (tp > 0 ? ' TP ' + tp : '') +
        riskTxt + recTxt + (levOverride > 0 ? ' · ' + levOverride + 'x' : '') +
        evTxt + (volAuto && ev.ok ? evMoneyTxt(ev.evR, riskEff || riskPct) : '');
      toast('Jev işlem açtı: ' + txt + orderWarnSuffix(res.data));
      termLogAdd('JEV İŞLEM · ' + txt, 'open');
      jevLogAdd('İŞLEM AÇTI · ' + txt + orderWarnSuffix(res.data), 'jev');
      refreshPositions();
      refreshOrders();
      drawChart();
      const rr = res.data && res.data.result;
      const ticket = rr && rr.order != null
        ? (exName === 'mt5' ? String(rr.order) : symbol + '|' + rr.order)
        : '';
      if (grade) setOrderGrade(ticket, symbol, grade);
      /* kalıcı hafıza için işlem meta'sı: TF/not/p/RR kapanışta istatistiğe girer */
      setTradeMeta({ ticket: ticket, symbol: symbol }, {
        tf: chartState.tf,
        grade: grade || '',
        p: ev.ok ? ev.p : (normProb(d.p)),
        rr: ev.ok ? ev.rr : 0,
      });
      journalAction({ kind: 'open', src: 'ai', sym: symbol, ticket, tf: chartState.tf, why: txt });
      return { ok: true, ticket, txt };
    }
    const errTxt = (res && res.error) || 'bilinmeyen';
    jevLogAdd('İŞLEM AÇILAMADI · ' + (type === 'market' ? 'piyasa' : type) + ' ' + side.toUpperCase() + ' ' + symbol + ' · ' + errTxt, 'err');
    termLogAdd('İŞLEM AÇILAMADI · ' + symbol + ' ' + side + ' ' + type + ' · ' + errTxt, 'sl');
    toast('Jev işlem açamadı: ' + errTxt);
    return { ok: false, error: errTxt };
  } finally { mt5End(); }
}

/* tek emir komutu */
async function jevOrder(d) {
  const r = await jevPlaceOrder(d);
  return r.ok ? 1 : 0;
}

/* çoklu emir: <<ORDER {"orders":[{...},{...}]}>> ya da tek emir objesi */
async function jevOrders(d) {
  const list = d && Array.isArray(d.orders) ? d.orders : [d];
  let n = 0;
  for (const o of list) {
    const r = await jevPlaceOrder(o);
    if (r.ok) n++;
  }
  return n;
}

/* ---------- OCO: iki bekleyen emirden biri tetiklenince diğeri otomatik iptal edilir ---------- */
const OCO_KEY = 'jev.ocoGroups';
let ocoCheckBusy = false;

function loadOcoGroups() {
  try {
    const raw = JSON.parse(localStorage.getItem(OCO_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((g) => g && Array.isArray(g.tickets) && g.tickets.length >= 2) : [];
  } catch { return []; }
}

function saveOcoGroups(list) {
  try { localStorage.setItem(OCO_KEY, JSON.stringify(list)); } catch {}
}

function addOcoGroup(symbol, tickets) {
  const list = loadOcoGroups();
  list.push({ id: newId(), symbol: String(symbol || ''), tickets: tickets.map(String), created: Date.now() });
  saveOcoGroups(list);
}

/* emir listesi yenilendikçe çağrılır: gruptan biri düşmüşse kalanı iptal et */
async function checkOcoGroups() {
  if (ocoCheckBusy) return;
  const groups = loadOcoGroups();
  if (!groups.length) return;
  const open = new Set((chartState.orders || []).map((o) => String(o.ticket)));
  let changed = false;
  ocoCheckBusy = true;
  mt5Begin();
  try {
    for (const g of groups) {
      /* yeni kurulan grup: ilk emir listesi gecikmiş olabilir, hemen karar verme */
      if (Date.now() - Number(g.created || 0) < 20000) continue;
      const alive = g.tickets.filter((t) => open.has(String(t)));
      if (alive.length === g.tickets.length) continue;
      if (!alive.length) { g._drop = true; changed = true; continue; }
      const other = g.tickets.find((t) => String(t) !== String(alive[0]));
      const r = await jev.mt5OrderDelete({ ticket: other }).catch(() => null);
      if (r && r.ok) {
        const msg = 'OCO · ' + (g.symbol || '') + ' · biri tetiklendi, diğer bekleyen emir iptal edildi';
        toast(msg);
        termLogAdd(msg, 'sys');
        jevLogAdd(msg, 'cmd');
        g._drop = true;
        changed = true;
      }
    }
  } finally {
    mt5End();
    ocoCheckBusy = false;
  }
  if (changed) saveOcoGroups(groups.filter((g) => !g._drop));
}

/* OCO komutu: yalnız limit/stop girişleri, iki emir */
async function jevOco(d) {
  const list = d && Array.isArray(d.orders) ? d.orders.slice(0, 2) : [];
  if (list.length !== 2) {
    jevLogAdd('OCO KURULAMADI · "orders" dizisinde 2 emir gerekli', 'err');
    toast('OCO kurulamadı: 2 emir gerekli');
    return 0;
  }
  const pendingOk = (o) => {
    const t = String((o && o.type) || '').toLowerCase().replace(/[\s-]+/g, '_');
    return /(limit|stop)$/.test(t);
  };
  if (!pendingOk(list[0]) || !pendingOk(list[1])) {
    jevLogAdd('OCO KURULAMADI · yalnız limit/stop emirleri kullanılabilir (market dolduğu için OCO anlamsız)', 'err');
    toast('OCO kurulamadı: yalnız limit/stop');
    return 0;
  }
  const r1 = await jevPlaceOrder(list[0]);
  if (!r1.ok) { jevLogAdd('OCO KURULAMADI · ilk emir: ' + r1.error, 'err'); return 0; }
  const r2 = await jevPlaceOrder(list[1]);
  if (!r2.ok) {
    /* ikinci emir reddedildi: ilkini geri al */
    if (r1.ticket) {
      mt5Begin();
      try { await jev.mt5OrderDelete({ ticket: r1.ticket }).catch(() => null); } finally { mt5End(); }
      refreshOrders();
    }
    jevLogAdd('OCO KURULAMADI · ikinci emir: ' + r2.error + ' — ilk emir iptal edildi', 'err');
    toast('OCO kurulamadı: ' + r2.error);
    return 0;
  }
  const sym = String(list[0].symbol || chartState.symbol || '').toUpperCase();
  if (r1.ticket && r2.ticket) {
    addOcoGroup(sym, [r1.ticket, r2.ticket]);
    const msg = 'OCO kuruldu · ' + sym + ' · biri tetiklenince diğeri otomatik iptal edilecek';
    toast(msg);
    termLogAdd(msg, 'sys');
    jevLogAdd(msg, 'cmd');
  } else {
    jevLogAdd('OCO · emirler açıldı ama takip başlatılamadı (ticket alınamadı)', 'err');
  }
  refreshOrders();
  return 1;
}

/* açık pozisyonun SL/TP'sini güncelle (Jev komutu): ticket ya da symbol ile hedeflenir */
async function jevSltp(d) {
  if (!d || typeof d !== 'object') return 0;
  const list = chartState.positions || [];
  if (!list.length) return 0;
  const tk = d.ticket != null && String(d.ticket).trim() ? String(d.ticket).trim() : '';
  const sym = String(d.symbol || '').toUpperCase();
  const targets = tk
    ? list.filter((p) => String(p.ticket) === tk)
    : sym
      ? list.filter((p) => String(p.symbol || '').toUpperCase() === sym)
      : [];
  const sl = Number(d.sl) || 0;
  const tp = Number(d.tp) || 0;
  if (!targets.length || (!(sl > 0) && !(tp > 0))) {
    jevLogAdd('SL/TP GÜNCELLENEMEDİ · hedef yok (' + (tk || sym || 'ticket/symbol verilmedi') + ')', 'err');
    return 0;
  }
  if (sl > 0 && tp > 0 && Math.abs(sl - tp) < 1e-9) return 0;  /* SL ve TP aynı olamaz */
  mt5Begin();
  try {
    let ok = 0;
    const msgs = [];
    for (const p of targets) {
      const info = symInfoOf(p.symbol);
      const dg = info && info.digits > 0 ? Number(info.digits) : decOf(p.price_open);
      const newSl = sl > 0 ? Number(sl.toFixed(Math.min(8, dg))) : (Number(p.sl) || 0);
      const newTp = tp > 0 ? Number(tp.toFixed(Math.min(8, dg))) : (Number(p.tp) || 0);
      /* KORUMA: riski büyüten SL değişikliği ve zararda fiyata yaklaştırma engellenir */
      const v = posGuardVerdict('SLTP', p, { sl: newSl, tp: newTp, src: 'ai' });
      if (!v.ok) { posGuardBlock('SLTP', p, v.why, { src: 'ai', rAt: v.r && v.r.rNow }); continue; }
      const r = await jev.mt5Modify({ ticket: p.ticket, sl: newSl, tp: newTp }).catch(() => null);
      if (r && r.ok) {
        ok++;
        msgs.push(p.symbol + ' #' + p.ticket + ' · SL ' + (newSl > 0 ? newSl : '—') + ' · TP ' + (newTp > 0 ? newTp : '—'));
        journalAction({ kind: 'sltp', src: 'ai', sym: p.symbol, ticket: p.ticket, rAt: v.r && v.r.rNow, why: 'SL ' + (Number(p.sl) || 0) + '→' + newSl });
      }
    }
    if (ok) {
      refreshPositions();
      toast('Jev SL/TP güncelledi: ' + msgs.join(' | '));
      termLogAdd('JEV SL/TP · ' + msgs.join(' | '), 'trail');
      jevLogAdd('SL/TP GÜNCELLE · ' + msgs.join(' | '), 'cmd');
    } else if (targets.length && !ok) {
      jevLogAdd('SL/TP güncellenemedi · ' + (tk || sym || 'hedef yok') + ' (koruma katmanı reddetti)', 'err');
    }
    return ok;
  } finally { mt5End(); }
}

/* açık pozisyon hedefleri: ticket | symbol | all (hepsi) */
function jevPosTargets(d) {
  const list = chartState.positions || [];
  if (!d || typeof d !== 'object') return [];
  const tk = d.ticket != null && String(d.ticket).trim() ? String(d.ticket).trim() : '';
  const sym = String(d.symbol || '').toUpperCase();
  if (tk) return list.filter((p) => String(p.ticket) === tk);
  if (sym) return list.filter((p) => String(p.symbol || '').toUpperCase() === sym);
  if (d.all === true || d.hepsi === true) return list.slice();
  return [];
}

/* belirli LOT ile (kısmi) kapat: volumeStep'e yuvarlanır; tamamıysa tam kapatır */
async function closeExactVolume(p, vol) {
  const cur = Number(p.volume) || 0;
  if (!(cur > 0) || !(vol > 0)) return false;
  const info = await symTradeInfo(p.symbol).catch(() => null);
  const step = info && info.volumeStep > 0 ? Number(info.volumeStep) : 0.01;
  const vd = stepDecimals(step);
  let v = Math.floor((Number(vol) + 1e-9) / step) * step;
  v = Math.min(v, cur);
  v = Number(v.toFixed(Math.min(8, vd)));
  if (!(v > 0)) { toast('Lot geçersiz (' + p.symbol + ')'); return false; }
  if (v >= cur - step / 2) return quickClosePosition(p);
  mt5Begin();
  try {
    const res = await jev.mt5ClosePosition({ ticket: p.ticket, volume: v }).catch(() => null);
    if (res && res.ok) {
      toast('Kapatıldı #' + p.ticket + ' · ' + nf(v, vd) + ' lot · kalan ' + nf(cur - v, vd));
      pushToast('KISMİ KAPATILDI', p.symbol + ' · ' + nf(v, vd) + ' lot · kalan ' + nf(cur - v, vd), 'trade-open');
      termLogAdd('KAPATILDI (lot) · ' + p.symbol + ' #' + p.ticket + ' · ' + nf(v, vd) + ' lot', 'close');
      return true;
    }
    toast('Kapatma başarısız: ' + ((res && res.error) || '?'));
    return false;
  } finally { mt5End(); }
}

/* <<TRAIL {ticket|symbol|all, on, distR, stepR, startR}>>: pozisyonda trailing stop aç/kapat.
   distR/stepR/startR verilirse pozisyonun sembol sekmesinin otomasyon ayarına yazılır. */
async function jevTrail(d) {
  if (!d || typeof d !== 'object') return 0;
  if (!(chartState.positions || []).length) { jevLogAdd('TRAIL · açık pozisyon yok', 'err'); return 0; }
  const targets = jevPosTargets(d);
  if (!targets.length) { jevLogAdd('TRAIL · hedef yok (ticket/symbol/all ver)', 'err'); return 0; }
  const rawOn = d.on != null ? d.on : (d.trail != null ? d.trail : true);
  const on = !(rawOn === false || /^(0|false|off|kapat|kapalı|kapali|durdur)$/i.test(String(rawOn).trim()));
  const distR = Number(d.distR != null ? d.distR : (d.mesafeR != null ? d.mesafeR : d.dist));
  const stepR = Number(d.stepR != null ? d.stepR : d.adimR);
  const startR = Number(d.startR != null ? d.startR : d.baslangicR);
  const lockR = Number(d.lockR != null ? d.lockR : d.kilitR);
  const given = [distR, stepR, startR, lockR].some((v) => Number.isFinite(v) && v > 0);
  /* ayarları yaz: parametre verildiyse onlar; hiç ayar yokken açılıyorsa güvenli varsayılanlar
     (başlangıç 0.5R · kilit 0.25R · mesafe 0.5R · adım 0.25R) */
  const syms = Array.from(new Set(targets.map((p) => String(p.symbol || '').toUpperCase())));
  let cfgChanged = false;
  for (const s of syms) {
    const t = (chartTabs || []).find((x) => String(x.symbol || '').toUpperCase() === s) || activeTab();
    if (!t) continue;
    const cur = autoCfg(t);
    if (!given && !(on && !(cur.trailDistR > 0))) continue;
    t.auto = normAuto({
      ...cur,
      trailDistR: distR > 0 ? distR : (cur.trailDistR > 0 ? cur.trailDistR : 1),
      trailStepR: stepR > 0 ? stepR : (cur.trailStepR > 0 ? cur.trailStepR : 0.5),
      trailStartR: startR > 0 ? startR : (cur.trailStartR > 0 ? cur.trailStartR : 1),
      trailLockR: lockR > 0 ? lockR : (cur.trailLockR > 0 ? cur.trailLockR : 0.5),
    });
    cfgChanged = true;
  }
  if (cfgChanged) saveTabs();
  let n = 0;
  for (const p of targets) {
    const meta = loadAutoMeta();
    const tk2 = String(p.ticket);
    const m = meta[tk2] || (meta[tk2] = {
      entry: Number(p.price_open) || 0, sl0: Number(p.sl) || 0,
      vol0: Number(p.volume) || 0, tp1: false, tp2: false,
    });
    if (!(Number(m.sl0) > 0) && Number(p.sl) > 0) m.sl0 = Number(p.sl);
    m.trail = on;
    m.at = Date.now();
    saveAutoMeta(meta);
    n++;
  }
  autoMetaCache = { at: 0, data: null };
  if (n) {
    const c0 = trailCfgFor(targets[0].symbol);
    const cfgTxt = on && c0
      ? ' · başlangıç ' + (c0.trailStartR || 1) + 'R · kilit ' + (c0.trailLockR || 0.5) + 'R · mesafe ' + (c0.trailDistR || 1) + 'R'
      : '';
    const msg = 'TRAIL ' + (on ? 'AÇIK' : 'KAPALI') + ' · ' + n + ' pozisyon' + cfgTxt;
    toast('Jev trailing: ' + msg + (on ? ' · yalnız kârda başlar, ilk stop kâra çekilir' : ''));
    termLogAdd('JEV TRAIL · ' + msg, 'trail');
    jevLogAdd('TRAIL · ' + msg, 'cmd');
    refreshPositions();
    drawChart();
  }
  return n;
}

/* <<BE {ticket|symbol|all}>>: SL'i başabaş noktasına çek (komisyon+swap+bugünkü realize dahil) */
async function jevBe(d) {
  if (!d || typeof d !== 'object') return 0;
  const targets = jevPosTargets(d);
  if (!targets.length) { jevLogAdd('BE · hedef yok (ticket/symbol/all ver)', 'err'); return 0; }
  let ok = 0;
  for (const p of targets) {
    const r = await breakEvenPosition(p, targets.length > 1).catch(() => false);
    if (r) ok++;
  }
  if (ok) {
    refreshPositions();
    toast('Jev BE uyguladı: ' + ok + ' pozisyon · SL başabaş');
    termLogAdd('JEV BE · ' + ok + ' pozisyon SL başabaş', 'trail');
    jevLogAdd('BE UYGULA · ' + ok + ' pozisyon · SL başabaş', 'cmd');
  } else {
    jevLogAdd('BE uygulanamadı', 'err');
  }
  return ok;
}

/* <<CLOSE {ticket|symbol|all, pct, volume, side}>>: kısmi/tam kapatma.
   pct: 1-100 (ya da 0-1) · volume: lot · pct>=100/verilmezse tamamı ·
   side: "profit" | "loss" → kârda/zararda olanları topluca kapatır. */
async function jevClose(d) {
  if (!d || typeof d !== 'object') return 0;
  const list = chartState.positions || [];
  if (!list.length) { jevLogAdd('KAPAT · açık pozisyon yok', 'err'); return 0; }
  const side = String(d.side || d.yon || '').toLowerCase();
  let targets;
  if (side === 'profit' || side === 'kar' || side === 'kâr' || d.profit === true) {
    targets = list.filter((p) => posProfit(p) > 0);
  } else if (side === 'loss' || side === 'zarar' || d.loss === true) {
    targets = list.filter((p) => posProfit(p) < 0);
  } else {
    targets = jevPosTargets(d);
  }
  if (!targets.length) { jevLogAdd('KAPAT · hedef yok (ticket/symbol/all ya da side:profit|loss ver)', 'err'); return 0; }
  let pct = Number(d.pct != null ? d.pct : d.yuzde);
  if (!Number.isFinite(pct)) pct = 0;
  if (pct > 1) pct = pct / 100;
  const vol = Number(d.volume != null ? d.volume : d.lot) || 0;
  const partial = vol > 0 || (pct > 0 && pct < 0.999);
  const invalidated = d.invalidated === true || d.gecersiz === true || d.tez === false;
  let ok = 0, fail = 0, blocked = 0;
  for (const p of targets) {
    /* KORUMA: zararda kısmi kapatma ve gerekçesiz zararda tam kapatma engellenir.
       Yanlışlıkla panik satış yapılmaması için bu kural isteme değil KODA bağlıdır. */
    const kind = partial ? 'CLOSE_PARTIAL' : 'CLOSE_FULL';
    const v = posGuardVerdict(kind, p, { src: 'ai', invalidated });
    if (!v.ok) { posGuardBlock(kind, p, v.why, { src: 'ai', rAt: v.r && v.r.rNow }); blocked++; continue; }
    let r = false;
    if (vol > 0) r = await closeExactVolume(p, vol);
    else if (partial) r = await closePartialPosition(p, pct, targets.length > 1);
    else r = await quickClosePosition(p);
    if (r) {
      ok++;
      const rk = v.r || posRisk(p);
      setExitHint(p.ticket, p.symbol, partial ? 'ai-partial' : 'ai');
      journalAction({ kind: partial ? 'partial' : 'close', src: 'ai', sym: p.symbol, ticket: p.ticket, rAt: rk.rNow, netAt: rk.profit, why: partial ? 'pct ' + pct : 'tam' });
    } else fail++;
  }
  refreshPositions();
  refreshClosed();
  const how = vol > 0 ? ' (' + vol + ' lot)' : (partial ? ' (%' + Math.round(pct * 100) + ')' : ' (tamamı)');
  const msg = 'KAPAT · ' + ok + ' pozisyon' + how + (fail ? ' · ' + fail + ' başarısız' : '') +
    (blocked ? ' · ' + blocked + ' koruma tarafından reddedildi' : '');
  jevLogAdd(msg, blocked && !ok ? 'err' : 'cmd');
  return ok;
}

/* yanıttaki <<KOMUT {json}>> bloklarını uygular ve metinden temizler */
async function applyJevCommands(text, depth) {
  depth = Math.max(0, Number(depth) || 0);
  let out = String(text || '');
  const cmds = [];
  out = out.replace(JEV_CMD_RE, (m, name, json) => {
    try {
      const obj = JSON.parse(json);
      if (obj && typeof obj === 'object') cmds.push({ name: String(name).toUpperCase(), data: obj });
    } catch {}
    return '';
  });
  /* önce grafik komutları: sembol değişirse çizimler yeni sembole yazılsın */
  const chartChanges = [];
  for (const c of cmds) {
    if (c.name !== 'CHART') continue;
    const bits = [];
    if (c.data && typeof c.data.symbol === 'string' && c.data.symbol.trim()) bits.push('sembol ' + c.data.symbol.trim().toUpperCase());
    if (c.data && typeof c.data.tf === 'string' && c.data.tf.trim()) bits.push('TF sabit (değiştirilmedi)');
    try {
      await applyChartCommand(c.data);
      if (bits.length) chartChanges.push(bits.join(' · '));
    } catch {}
  }
  const stat = { draw: 0, plan: 0, alert: 0, clear: 0, sltp: 0, look: 0, order: 0, oco: 0, code: 0, skill: 0, auto: 0, web: 0, file: 0, tool: 0, trail: 0, be: 0, close: 0 };
  const lookShots = [];
  const codeEdits = [];
  const toolResults = [];
  let changedDraw = false, changedPlan = false, changedAlert = false;
  for (const c of cmds) {
    try {
      if (c.name === 'DRAW') {
        if (stat.draw < JEV_MAX_DRAWS && jevDraw(c.data)) { stat.draw++; changedDraw = true; }
      } else if (c.name === 'PLAN') {
        if (jevPlan(c.data)) { stat.plan++; changedPlan = true; }
      } else if (c.name === 'ALERT') {
        if (jevAlert(c.data)) { stat.alert++; changedAlert = true; }
      } else if (c.name === 'SLTP') {
        stat.sltp += await jevSltp(c.data);
      } else if (c.name === 'TRAIL') {
        stat.trail += await jevTrail(c.data);
      } else if (c.name === 'BE') {
        stat.be += await jevBe(c.data);
      } else if (c.name === 'CLOSE') {
        stat.close += await jevClose(c.data);
      } else if (c.name === 'ORDER') {
        stat.order += await jevOrders(c.data);
      } else if (c.name === 'OCO') {
        stat.oco += await jevOco(c.data);
      } else if (c.name === 'LOOK') {
        if (await jevLook(c.data, depth, lookShots)) stat.look++;
      } else if (c.name === 'WEB') {
        if (toolResults.length < 4) {
          const r = await jevWeb(c.data);
          if (r) { toolResults.push(r); stat.web++; }
        }
      } else if (c.name === 'FILE') {
        if (toolResults.length < 4) {
          const r = await jevFile(c.data);
          if (r) { toolResults.push(r); stat.file++; }
        }
      } else if (c.name === 'TOOL') {
        if (await jevToolCommand(c.data)) stat.tool++;
      } else if (c.name === 'SKILL') {
        if (await jevSkillCommand(c.data)) stat.skill++;
      } else if (c.name === 'AUTO') {
        if (jevAutoCommand(c.data)) stat.auto++;
      } else if (c.name === 'CODE') {
        const ed = jevCodeEdit(c.data);
        if (ed) { codeEdits.push(ed); stat.code++; }
      } else if (c.name === 'CLEAR') {
        const n = jevClear(c.data);
        if (n > 0) { stat.clear += n; changedDraw = changedPlan = changedAlert = true; }
      }
    } catch (e) {
      jevLogAdd('KOMUT HATASI · ' + c.name + ' · ' + String((e && e.message) || e), 'err');
    }
  }
  if (changedDraw) { saveDrawings(); drawChart(); }
  if (changedPlan) { savePlans(); applyPlanButtons(); drawChart(); }
  if (changedAlert) { saveAlerts(); renderAlertSide(); drawChart(); }
  const parts = [];
  for (const ch of chartChanges) parts.push('grafik ' + ch);
  if (stat.draw) parts.push(stat.draw + ' çizim');
  if (stat.plan) parts.push(stat.plan + ' plan (grafikteki GİR ile aç)');
  if (stat.alert) parts.push(stat.alert + ' alarm');
  if (stat.sltp) parts.push(stat.sltp + ' pozisyon SL/TP güncellendi');
  if (stat.trail) parts.push(stat.trail + ' pozisyonda trailing ayarlandı');
  if (stat.be) parts.push(stat.be + ' pozisyon BE');
  if (stat.close) parts.push(stat.close + ' pozisyon kapatıldı');
  if (stat.order) parts.push(stat.order + ' işlem açıldı');
  if (stat.oco) parts.push(stat.oco + ' OCO kuruldu (biri tetiklenince diğeri iptal)');
  if (stat.look) parts.push(stat.look + ' görsel isteği (sohbete gönderildi)');
  if (stat.web) parts.push(stat.web + ' web isteği (sonuç LLM\'e geri gönderiliyor)');
  if (stat.file) parts.push(stat.file + ' dosya okuma (sonuç LLM\'e geri gönderiliyor)');
  if (stat.tool) parts.push(stat.tool + ' toolbox aracı işlemi');
  if (stat.clear) parts.push(stat.clear + ' öğe temizlendi');
  if (stat.skill) parts.push(stat.skill + ' skill işlemi');
  if (stat.auto) parts.push('ayar güncellendi (risk/analiz sıklığı)');
  if (stat.code) parts.push(stat.code + ' kod düzenleme (test edilip uygulama yeniden başlatılacak)');
  if (parts.length) {
    toast((stat.order || stat.oco ? 'Jev işlem açtı: ' : (stat.sltp || stat.trail || stat.be || stat.close) ? 'Jev uyguladı: ' : (stat.code || stat.skill || stat.tool) && !stat.draw && !stat.plan && !stat.alert ? 'Jev: ' : 'Jev çizdi: ') + parts.join(' · '));
    termLogAdd('JEV UYGULADI · ' + parts.join(' · '), 'sys');
    jevLogAdd('UYGULADI · ' + parts.join(' · '), 'cmd');
  }
  if (lookShots.length) jevSendLookShots(lookShots, depth).catch(() => {});
  if (toolResults.length) jevSendToolResults(toolResults, depth).catch(() => {});
  if (codeEdits.length) applyCodeEdits(codeEdits).catch((e) => jevLogAdd('KOD · hata · ' + String((e && e.message) || e), 'err'));
  const clean = out.trim();
  /* yanıt yalnızca komut bloklarından oluşuyorsa boş görünmesin: uygulananları özetle */
  if (!clean && parts.length) return 'Uygulandı: ' + parts.join(' · ');
  return clean;
}

async function loadSymbolList() {
  if (chartState.symLoaded) return;
  const r = await jev.mt5AllSymbols({}).catch(() => null);
  if (!r || !r.ok) return;
  const rows = (r.data && r.data.symbols) || [];
  const visible = rows.filter((s) => s.visible).map((s) => s.name);
  const use = (visible.length ? visible : rows.map((s) => s.name)).slice(0, 4000);
  $('#symList').innerHTML = use.map((n) => '<option value="' + escapeHtml(n) + '"></option>').join('');
  chartState.symLoaded = true;
}

function chartInitResizer() {
  const rz = $('#chartResizer');
  const col = $('#chatCol');
  /* sohbet genişliği kalıcı */
  try {
    const w = Number(localStorage.getItem('jev.chatW') || 0);
    if (w >= 300 && w <= 640) col.style.width = w + 'px';
  } catch {}
  let dragging = false;
  rz.addEventListener('mousedown', (e) => {
    dragging = true;
    rz.classList.add('dragging');
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = $('#split').getBoundingClientRect();
    let px = e.clientX - rect.left;
    px = Math.max(300, Math.min(640, px));
    col.style.width = px + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    rz.classList.remove('dragging');
    document.body.style.userSelect = '';
    try { localStorage.setItem('jev.chatW', String(col.offsetWidth)); } catch {}
    drawChart();
  });
}

/* pozisyon panelini simge durumuna küçült / geri aç */
function applyPosMin() {
  const min = localStorage.getItem('jev.posMin') === '1';
  const panel = $('#posPanel');
  if (!panel) return;
  panel.classList.toggle('min', min);
  const b = $('#posMin');
  if (b) {
    b.title = min ? 'Pozisyonlar panelini aç' : 'Simge durumuna küçült';
    b.innerHTML = min
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  }
}

/* pozisyon paneli: tut-yukarı çek ile büyüt/küçült */
function chartInitPosResizer() {
  const panel = $('#posPanel');
  const rz = $('#posResizer');
  const head = $('#posHead');
  const minH = 48;
  const maxH = () => Math.max(minH + 24, $('#chartCol').getBoundingClientRect().height - 250);
  const apply = (h) => {
    const v = Math.max(minH, Math.min(maxH(), Math.round(h)));
    panel.style.height = v + 'px';
    panel.style.maxHeight = 'none';
    return v;
  };
  try {
    const saved = Number(localStorage.getItem('jev.posH') || 0);
    if (saved >= minH) apply(saved);
  } catch {}
  let dragging = false, startY = 0, startH = 0;
  const begin = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    rz.classList.add('dragging');
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };
  rz.addEventListener('mousedown', begin);
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    begin(e);
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    apply(startH - (e.clientY - startY));
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    rz.classList.remove('dragging');
    document.body.style.userSelect = '';
    try { localStorage.setItem('jev.posH', String(Math.round(panel.getBoundingClientRect().height))); } catch {}
  });
  rz.addEventListener('dblclick', () => {
    panel.style.height = '';
    panel.style.maxHeight = '';
    try { localStorage.removeItem('jev.posH'); } catch {}
    drawChart();
  });
  window.addEventListener('resize', () => {
    if (panel.style.height) apply(parseFloat(panel.style.height));
  });
}

function chartInitCanvas() {
  const wrap = $('#chartWrap');
  const canvas = $('#chart');
  if (window.ResizeObserver) new ResizeObserver(() => drawChart()).observe(wrap);
  window.addEventListener('resize', () => drawChart());

  const geom = () => {
    const rect = canvas.getBoundingClientRect();
    const padR = 64, padB = 20, padL = 4;
    const plotW = rect.width - padR - padL;
    return { rect, padL, padR, padB, plotW };
  };
  const zoneAt = (e) => {
    const { rect, padR, padB, padL, plotW } = geom();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x >= padL + plotW) return 'price';
    if (y >= rect.height - padB) return 'time';
    return 'plot';
  };
  const clampNum = (v, a, b) => Math.max(a, Math.min(b, v));

  /* kutu tutamakları: 4 köşe + 4 kenar ortası. Kenar ortasından çekince yalnız
     o kenar (tek eksen) uzar; köşeden çekince iki eksen birlikte değişir. */
  const rectHandlePoints = (d, g) => {
    const A = d.points[0], B = d.points[1];
    const xA = g.xOf(idxFromTime(A.t)), yA = g.yOf(A.p);
    const xB = g.xOf(idxFromTime(B.t)), yB = g.yOf(B.p);
    const aLeft = xA <= xB;
    const aTop = yA <= yB;
    const midX = (xA + xB) / 2, midY = (yA + yB) / 2;
    return [
      { k: 'AA', x: xA, y: yA },
      { k: 'BB', x: xB, y: yB },
      { k: 'AB', x: xB, y: yA },
      { k: 'BA', x: xA, y: yB },
      { k: 'L', x: aLeft ? xA : xB, y: midY, pt: aLeft ? 0 : 1 },
      { k: 'R', x: aLeft ? xB : xA, y: midY, pt: aLeft ? 1 : 0 },
      { k: 'T', x: midX, y: aTop ? yA : yB, pt: aTop ? 0 : 1 },
      { k: 'B', x: midX, y: aTop ? yB : yA, pt: aTop ? 1 : 0 },
    ];
  };
  const selectedRectHandleAt = (mx, my) => {
    if (chartState.selected == null || !chartState.geo) return null;
    const d = chartState.drawings[chartState.selected];
    if (!d || d.type !== 'rect' || !d.points || d.points.length < 2) return null;
    const list = rectHandlePoints(d, chartState.geo);
    /* önce köşeler, sonra kenar ortaları (üst üste binerse köşe kazanır) */
    for (const c of list.slice(0, 4)) if (Math.abs(mx - c.x) <= 8 && Math.abs(my - c.y) <= 8) return c;
    for (const c of list.slice(4)) if (Math.abs(mx - c.x) <= 8 && Math.abs(my - c.y) <= 8) return c;
    return null;
  };
  let resizeDraw = null;
  let alertDrag = null;
  let planDrag = null;
  let lvlDrag = null;

  /* sürükleme: gövde = kaydır · fiyat ekseni = dikey zoom · zaman ekseni = yatay zoom
     araç seçiliyken (imleç dışında) tıklama çizim yapar */
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (pane2.session) return;
    const { rect, padL, padB, plotW } = geom();
    const padT = 10;
    const plotH = rect.height - padT - padB;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const inPlot = mx >= padL && mx <= padL + plotW && my >= padT && my <= padT + plotH;
    if (chartState.tool === 'seg') {
      if (!inPlot) return;
      const pt = chartPointFromEvent(mx, my);
      if (!pt) return;
      /* ilk tık bekliyorsa ikinci tık bitirir (tutmak zorunlu değil) */
      if (chartState.pending.length) {
        const a = chartState.pending[0];
        const b = e.ctrlKey ? { t: pt.t, p: a.p } : (e.shiftKey ? parallelSegPoint(a, pt) : pt);
        chartState.pending = [];
        chartState.drawings.push({ type: 'seg', points: [a, b], color: chartState.drawColors.seg });
        saveDrawings();
        setDrawTool('cursor');
        return;
      }
      chartState.segDrag = { a: pt, b: pt };
      chartState.mouse = { x: mx, y: my };
      drawChart();
      return;
    }
    if (chartState.tool === 'range') {
      if (!inPlot) return;
      const pt = chartPointFromEvent(mx, my);
      if (!pt) return;
      /* ilk tık bekliyorsa ikinci tık bitirir */
      if (chartState.pending.length) {
        const a = chartState.pending[0];
        chartState.pending = [];
        chartState.drawings.push({ type: 'range', points: [a, pt], color: chartState.drawColors.range || '#ec4899' });
        saveDrawings();
        setDrawTool('cursor');
        return;
      }
      chartState.segDrag = { a: pt, b: pt, type: 'range' };
      chartState.mouse = { x: mx, y: my };
      drawChart();
      return;  /* oturum açık: range sürükleme */
    }
    if (chartState.tool === 'free') {
      if (!inPlot) return;
      const pt = chartPointFromEvent(mx, my);
      if (!pt) return;
      chartState.free = [pt];
      chartState.mouse = { x: mx, y: my };
      drawChart();
      return;
    }
    if (chartState.tool !== 'cursor') {
      if (inPlot) handleToolClick(mx, my);
      return;
    }
    /* fiyat/zaman ekseni bölgesi: hiçbir çizim/kutu/araç isabet testi yapılmaz —
       yalnızca eksen kaydırma (dikey fiyat / yatay zaman) başlar; çizimler ve
       plan kutuları bu bölgede yerinden oynamaz */
    const zone = zoneAt(e);
    if (zone === 'price' || zone === 'time') {
      yLockCapture(chartState); /* dikey ölçek: eksen sürüklemesinde sabit */
      chartState.dragging = true;
      chartState.dragMode = zone === 'price' ? 'y' : 'x';
      chartState.dragX = e.clientX;
      chartState.dragY = e.clientY;
      canvas.style.cursor = zone === 'price' ? 'ns-resize' : 'ew-resize';
      e.preventDefault();
      return;
    }
    /* imleç: mıknatıs → plan çizgileri → plan kutusu koruması → alarm → çizimler */
    const geo = chartState.geo;
    let inPlanBox = false;
    if (geo) {
      const mh = hitPlanMagnet(mx, my, geo);
      if (mh) {
        mh.follow = !mh.follow;
        if (mh.follow && chartState.rates.length) {
          const price = Number(chartState.rates[chartState.rates.length - 1].close);
          const d = price - mh.entry;
          mh.entry = price;
          mh.sl += d;
          mh.tp += d;
        }
        selectedPlanId = mh.id;
        selectedAlertId = '';
        chartState.selected = null;
        savePlans();
        drawChart();
        toast('Giriş fiyatı ' + (mh.follow ? 'kilitlendi — fiyatı takip ediyor' : 'serbest bırakıldı'));
        e.preventDefault();
        return;
      }
    }
    if (geo) {
      const eb = hitPlanEntryBtn(mx, my, geo);
      if (eb) {
        selectedPlanId = eb.id;
        drawChart();
        enterTradeNow(eb);
        e.preventDefault();
        return;
      }
    }
    /* seçili kutu kenarından yatay boyutlandırma: SL/TP/giriş çizgileri de kenarda
       çizildiği için bu, seviye sürüklemesinden ÖNCE denenir */
    if (geo) {
      const pe = hitPlanBoxEdge(mx, my, geo);
      if (pe) {
        selectedPlanId = pe.plan.id;
        selectedAlertId = '';
        chartState.selected = null;
        planDrag = { id: pe.plan.id, part: pe.edge === 'l' ? 'ex0' : 'ex1' };
        renderAlertSide();
        drawChart();
        e.preventDefault();
        return;
      }
      const be = hitPosBoxEdge(mx, my, geo);
      if (be) {
        const sp = posBoxSpan(be.pos, barIvMs(), posBoxBaseT(be.pos));
        posBoxEdgeDrag = { ticket: be.ticket, edge: be.edge, d0: sp.d0, d1: sp.d1, pos: be.pos };
        selectedPosTicket = be.ticket;
        selectedAlertId = '';
        selectedPlanId = '';
        chartState.selected = null;
        drawChart();
        e.preventDefault();
        return;
      }
    }
    /* açık işlem kutuları en üstte çizilir: SL/TP çizgileri önce denenir */
    if (geo) {
      const lh = hitPositionLevel(mx, my, geo);
      if (lh) {
        lvlDrag = { kind: lh.kind, ref: lh.pos, part: lh.part };
        posDragActive = true;
        selectedAlertId = '';
        selectedPlanId = '';
        chartState.selected = null;
        renderAlertSide();
        drawChart();
        e.preventDefault();
        return;
      }
    }
    if (geo) {
      const gl = hitPositionGroupLevel(mx, my, geo);
      if (gl) {
        if (gl.mixed) {
          toast('Karışık yönlü grupta ortak SL/TP uygulanamaz');
        } else {
          groupLevelDrag = { key: gl.key, part: gl.part, price: gl.price, tickets: gl.cluster.map((m) => String(m.p.ticket)) };
          drawChart();
        }
        e.preventDefault();
        return;
      }
    }
    if (geo) {
      const ph = hitPlan(mx, my, geo);
      if (ph) {
        selectedPlanId = ph.plan.id;
        selectedAlertId = '';
        chartState.selected = null;
        if (ph.part === 'entry') {
          ph.plan.follow = false;  /* giriş elle sürüklenince fiyat kilidi bırakılır */
        }
        planDrag = { id: ph.plan.id, part: ph.part };
        renderAlertSide();
        drawChart();
        e.preventDefault();
        return;
      }
    }
    /* plan kutusunun kapladığı alanda arkadaki alarm/çizimler seçilmez */
    if (geo) {
      const pb = hitPlanBox(mx, my, geo);
      if (pb) {
        inPlanBox = true;
        selectedPlanId = pb.id;
        selectedAlertId = '';
        chartState.selected = null;
        renderAlertSide();
        drawChart();
      }
    }
    if (!inPlanBox && geo) {
      const ah = hitAlert(mx, my, geo);
      if (ah) {
        selectedAlertId = ah.id;
        chartState.selected = null;
        alertDrag = { id: ah.id, startPrice: ah.price, moved: false };
        renderAlertSide();
        drawChart();
        e.preventDefault();
        return;
      }
    }
    if (!inPlanBox) {
      if (selectedPlanId) {
        selectedPlanId = '';
        drawChart();
      }
      if (selectedAlertId) {
        selectedAlertId = '';
        renderAlertSide();
      }
      /* trend/kısa çizgi uç tutamacı: ucu tek tek sürükle */
      const hep = geo ? hitEndpoint(mx, my, geo) : null;
      if (hep) {
        chartState.selected = hep.i;
        chartState.dragDraw = {
          i: hep.i, mode: 'endpoint', ptIdx: hep.ptIdx, geo,
          orig: JSON.parse(JSON.stringify(chartState.drawings[hep.i].points || [])),
        };
        drawChart();
        e.preventDefault();
        return;
      }
      /* fibo sağ kenarı: genişlik sürükleme */
      const fe = geo ? hitFiboEdge(mx, my, geo) : null;
      if (fe) {
        chartState.selected = fe.i;
        chartState.dragDraw = {
          i: fe.i, mode: 'fiboEdge', edgeIdx: fe.edgeIdx, geo,
          orig: JSON.parse(JSON.stringify(fe.d.points || [])),
        };
        drawChart();
        e.preventDefault();
        return;
      }
      const hit = geo ? hitDrawing(mx, my, geo) : -1;
      if (hit >= 0) {
        /* range: taşıma/kısaltma-uzatma yalnız çizim SEÇİLİYKEN; ilk tık sadece seçer */
        const drHit = chartState.drawings[hit];
        if (drHit && drHit.type === 'range' && chartState.selected !== hit) {
          chartState.selected = hit;
          drawChart();
          e.preventDefault();
          return;
        }
        chartState.selected = hit;
        /* seçili kutunun köşesinden/kenar ortasından tutulduysa boyutlandır */
        const handle = selectedRectHandleAt(mx, my);
        if (handle) {
          resizeDraw = { i: hit, handle, geo };
          drawChart();
          e.preventDefault();
          return;
        }
      chartState.dragDraw = {
        i: hit,
        x: mx,
        y: my,
        geo,
        orig: JSON.parse(JSON.stringify(chartState.drawings[hit].points || [])),
      };
      /* fibo: taşımak yerine tutulan ucun (üst/alt) fiyatı değiştirilir */
      const drF = chartState.drawings[hit];
      if (drF.type === 'fibo' && drF.points && drF.points.length >= 2) {
        const y0 = geo.yOf(drF.points[0].p);
        const y1 = geo.yOf(drF.points[1].p);
        chartState.dragDraw.fiboAnchor = Math.abs(my - y0) <= Math.abs(my - y1) ? 0 : 1;
        chartState.dragDraw.mode = 'fibo';
      }
      drawChart();
      return;
      }
      if (chartState.selected != null) {
        chartState.selected = null;
        drawChart();
      }
    }
    /* bekleyen emir SL-TP seviyeleri (sürüklenebilir) */
    if (!inPlanBox && geo) {
      const oh = hitOrderLevel(mx, my, geo);
      if (oh) {
        lvlDrag = { kind: oh.kind, ref: oh.ord, part: oh.part };
        posDragActive = true;
        selectedAlertId = '';
        selectedPlanId = '';
        chartState.selected = null;
        renderAlertSide();
        drawChart();
        e.preventDefault();
        return;
      }
    }
    /* plan kutusu modu: gruba tıkladıkça üyeler sırayla (1. işlem, 2. işlem...) ve seçili kutu sağa uzar */
    if (!inPlanBox && geo && chartState.showPosBox) {
      const hc = hitPositionCluster(mx, my, geo);
      if (hc && hc.cluster.length > 1) {
        if (posGroupCycle.key !== hc.key) posGroupCycle = { key: hc.key, idx: 0 };
        else posGroupCycle.idx = (posGroupCycle.idx + 1) % hc.cluster.length;
        const mi = Math.max(0, Math.min(posGroupCycle.idx, hc.cluster.length - 1));
        selectedPosTicket = String(hc.cluster[mi].p.ticket);
        drawChart();
      } else if (hc && hc.ticket) {
        selectedPosTicket = hc.ticket;
        drawChart();
      } else if (!hc && (posGroupCycle.key || selectedPosTicket)) {
        posGroupCycle.key = '';
        posGroupCycle.idx = 0;
        selectedPosTicket = '';
        drawChart();
      }
    }
    /* boş alan: kaydır / zoom başlat
       ALT TARİH ŞERİDİ (zone 'time') = yatay zoom (fiyat ekseni 'price' = dikey zoom
       gibi). İkisi de imlecin altında/üstünde sabitlenerek üstel ölçeklenir. */
    yLockCapture(chartState); /* pan sırasında dikey zoom sabit: fiyat yerinde durur */
    chartState.dragging = true;
    chartState.dragMode = 'pan';
    chartState.dragX = e.clientX;
    chartState.dragY = e.clientY;
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (pane2.session) return;
    if (groupLevelDrag) {
      const g = chartState.geo;
      if (!g) { groupLevelDrag = null; return; }
      const rect = canvas.getBoundingClientRect();
      const np = pointFromXY(e.clientX - rect.left, e.clientY - rect.top, g);
      if (np && np.p > 0) { groupLevelDrag.price = np.p; drawChart(); }
      return;
    }
    if (lvlDrag) {
      const g = chartState.geo;
      if (!g) { lvlDrag = null; posDragActive = false; return; }
      const rect = canvas.getBoundingClientRect();
      const np = pointFromXY(e.clientX - rect.left, e.clientY - rect.top, g);
      if (np && np.p > 0) {
        lvlDrag.ref[lvlDrag.part] = np.p;
        drawChart();
      }
      return;
    }
    if (posBoxEdgeDrag) {
      const g = chartState.geo;
      const p = (chartState.positions || []).find((x) => String(x.ticket) === posBoxEdgeDrag.ticket);
      if (!g || !p) { posBoxEdgeDrag = null; return; }
      const rect = canvas.getBoundingClientRect();
      const np = pointFromXY(e.clientX - rect.left, e.clientY - rect.top, g);
      if (!np) return;
      const iv = barIvMs();
      const d = (np.t - posBoxBaseT(p)) / iv;
      if (posBoxEdgeDrag.edge === 'l') posBoxEdgeDrag.d0 = Math.min(d, posBoxEdgeDrag.d1 - POS_BOX_MIN_BARS);
      else posBoxEdgeDrag.d1 = Math.max(d, posBoxEdgeDrag.d0 + POS_BOX_MIN_BARS);
      drawChart();
      return;
    }
    if (planDrag) {
      const g = chartState.geo;
      const p = (chartState.plans || []).find((x) => x.id === planDrag.id);
      if (!g || !p) { planDrag = null; return; }
      const rect = canvas.getBoundingClientRect();
      const np = pointFromXY(e.clientX - rect.left, e.clientY - rect.top, g);
      if (np && np.p > 0) {
        if (planDrag.part === 'ex0' || planDrag.part === 'ex1') {
          applyPlanEdgeDrag(p, planDrag.part === 'ex0' ? 'l' : 'r', np.t);
        } else if (planDrag.part === 'entry') {
          const d = np.p - p.entry;
          p.entry = np.p;
          p.sl += d;
          p.tp += d;
        } else if (planDrag.part === 'sl') {
          p.sl = np.p;
          applyPlanRR(p);  /* sabit RR varsa TP'yi otomatik ayarla */
        } else {
          p.tp = np.p;
          if (Number(p.rr) > 0) {
            /* TP elle değiştirildi: kilit değeri yeni orana göre güncellenir */
            const risk = Math.abs(p.entry - p.sl);
            if (risk > 0) p.rr = Math.max(0.1, Math.min(100, Math.abs(p.tp - p.entry) / risk));
          }
        }
        drawChart();
      }
      return;
    }
    if (alertDrag) {
      const g = chartState.geo;
      const a = (chartState.alerts || []).find((x) => x.id === alertDrag.id);
      if (!g || !a) { alertDrag = null; return; }
      const rect = canvas.getBoundingClientRect();
      const np = pointFromXY(e.clientX - rect.left, e.clientY - rect.top, g);
      if (np && np.p > 0) {
        a.price = np.p;
        a.last = null;
        alertDrag.moved = true;
        drawChart();
      }
      return;
    }
    if (resizeDraw) {
      const g = resizeDraw.geo;
      const d = chartState.drawings[resizeDraw.i];
      if (!d || !d.points || d.points.length < 2 || !g) return;
      const rect = canvas.getBoundingClientRect();
      const np = pointFromXY(e.clientX - rect.left, e.clientY - rect.top, g);
      if (!np) return;
      const h = resizeDraw.handle || {};
      const A = d.points[0], B = d.points[1];
      if (h.k === 'AA') { A.t = np.t; A.p = np.p; }
      else if (h.k === 'BB') { B.t = np.t; B.p = np.p; }
      else if (h.k === 'AB') { A.p = np.p; B.t = np.t; }
      else if (h.k === 'BA') { B.p = np.p; A.t = np.t; }
      /* kenar ortaları: yalnız o eksen (sol/sağ = zaman, üst/alt = fiyat) */
      else if (h.k === 'L' || h.k === 'R') { d.points[h.pt].t = np.t; }
      else if (h.k === 'T' || h.k === 'B') { d.points[h.pt].p = np.p; }
      drawChart();
      return;
    }
    if (chartState.dragDraw) {
      const dd = chartState.dragDraw;
      const rect = canvas.getBoundingClientRect();
      if (dd.mode === 'endpoint') {
        /* uç sürükleme: yalnız o uç hareket eder (Shift: yatay) */
        const np = pointFromXY(e.clientX - rect.left, e.clientY - rect.top, dd.geo);
        const drE = chartState.drawings[dd.i];
        if (np && drE && drE.points && drE.points[dd.ptIdx]) {
          drE.points[dd.ptIdx] = e.shiftKey ? { t: np.t, p: dd.orig[dd.ptIdx].p } : np;
          drawChart();
        }
        return;
      }
      if (dd.mode === 'fiboEdge') {
        /* fibo genişlik: sağ kenarın zamanı değişir, fiyatlar sabit kalır */
        const np = pointFromXY(e.clientX - rect.left, e.clientY - rect.top, dd.geo);
        const drE = chartState.drawings[dd.i];
        if (np && drE && drE.points && drE.points[dd.edgeIdx]) {
          drE.points[dd.edgeIdx].t = np.t;
          drawChart();
        }
        return;
      }
      if (dd.mode === 'fibo') {
        /* fibo: yalnız tutulan ucun fiyatı değişir (yatay konum sabit kalır) */
        const np = pointFromXY(e.clientX - rect.left, e.clientY - rect.top, dd.geo);
        const drF = chartState.drawings[dd.i];
        if (np && drF && drF.points && drF.points[dd.fiboAnchor]) {
          drF.points[dd.fiboAnchor].p = np.p;
          drawChart();
        }
        return;
      }
      const dx = e.clientX - rect.left - dd.x;
      const dy = e.clientY - rect.top - dd.y;
      const g = dd.geo;
      const next = [];
      for (const P of dd.orig) {
        const np = pointFromXY(g.xOf(idxFromTime(P.t)) + dx, g.yOf(P.p) + dy, g);
        next.push(np || P);
      }
      const dr = chartState.drawings[dd.i];
      if (dr) dr.points = next;
      drawChart();
      return;
    }
    if (chartState.segDrag) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const pt = chartPointFromEvent(mx, my);
      if (pt) {
        const a0 = chartState.segDrag.a;
        /* Ctrl: yatay (paralel) · Shift: son çizgiye paralel · range: serbest */
        chartState.segDrag.b = chartState.segDrag.type === 'range'
          ? pt
          : (e.ctrlKey ? { t: pt.t, p: a0.p } : (e.shiftKey ? parallelSegPoint(a0, pt) : pt));
        chartState.mouse = { x: mx, y: my };
        drawChart();
      }
      return;
    }
    if (chartState.free) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const pt = chartPointFromEvent(mx, my);
      if (pt) {
        chartState.mouse = { x: mx, y: my };
        const last = chartState.free[chartState.free.length - 1];
        if ((!last || last.t !== pt.t || last.p !== pt.p) && chartState.free.length < 600) {
          chartState.free.push(pt);
        }
        drawChart();
      }
      return;
    }
    if (!chartState.dragging) return;
    if (e.buttons === 0) { clearDanglingDrag(); return; }
    const n = chartState.rates.length;
    if (!n) return;

    if (chartState.dragMode === 'y') {
      const dy = e.clientY - chartState.dragY;
      chartState.dragY = e.clientY;
      zoomYAt(e.clientY, Math.exp(-dy / 150));
      return;
    }

    /* tarih şeridinden yatay zoom: imlecin altındaki mum sabit kalır */
    if (chartState.dragMode === 'x') {
      const { rect, padL, plotW } = geom();
      if (plotW <= 0) return;
      const dx = e.clientX - chartState.dragX;
      chartState.dragX = e.clientX;
      const vc = chartState.viewCount || n;
      const step = plotW / vc;
      const start = chartState.viewEnd - vc + 1;
      const xIn = clampNum(e.clientX - rect.left - padL, 0, plotW);
      const idxAt = start + xIn / step;
      const next = clampNum(Math.round(vc * Math.exp(-dx / 150)), 20, n);
      if (next !== vc) {
        chartState.viewCount = next;
        chartState.follow = false;
        const startNew = idxAt - xIn / (plotW / next);
        chartState.viewEnd = clampNum(Math.round(startNew + next - 1), next - 1, n - 1 + Math.round(next * 0.8));
      }
      drawChart();
      return;
    }

    const { plotW } = geom();
    if (plotW <= 0) return;
    const step = plotW / (chartState.viewCount || n);
    const dx = e.clientX - chartState.dragX;
    const dy = e.clientY - chartState.dragY;
    chartState.dragX = e.clientX;
    chartState.dragY = e.clientY;
    const vcPan = chartState.viewCount || n;
    chartState.viewEnd = Math.max(
      vcPan - 1,
      Math.min(n - 1 + Math.round(vcPan * 0.8), chartState.viewEnd - dx / step)
    );
    /* SON MUM MESAFESİ KORUNUR: pan sonrası canlı kenara göre offset (mum cinsinden)
       takip modunda saklanır. Son mum sağda N mum ileride (lag) ya da sağında N mum
       boşluk (gap) bırakıldıysa yeni mumlar geldikçe AYNI mesafe korunur. Bir ekrandan
       fazla geriye gidilirse (derin geçmiş incelemesi) takip kapanır. */
    const liveGap = chartState.viewEnd - (n - 1);
    if (liveGap >= -vcPan) {
      chartState.follow = true;
      chartState.rightGap = liveGap / vcPan;
    } else {
      chartState.follow = false;
    }
    if (yLockActive(chartState)) {
      /* kilitli: dikey kaydırma kilitli aralığı öteler (yOffset devre dışı) */
      const gr = chartState.range || { lo: chartState.yLock.lo, hi: chartState.yLock.hi };
      const dyN = chartState.invert ? -dy : dy;
      const shift = dyN * (gr.hi - gr.lo) / Math.max(50, wrap.clientHeight - 30);
      chartState.yLock = { lo: chartState.yLock.lo + shift, hi: chartState.yLock.hi + shift };
    } else {
      chartState.yOffset += (chartState.invert ? -dy : dy) / Math.max(50, wrap.clientHeight - 30);
      chartState.yOffset = Math.max(-3, Math.min(3, chartState.yOffset));
    }
    drawChart();
  });
  window.addEventListener('mouseup', () => {
    if (pane2.session) return;
    if (groupLevelDrag) {
      const drag = groupLevelDrag;
      groupLevelDrag = null;
      applyGroupLevelDrag(drag);
      drawChart();
      return;
    }
    if (posBoxEdgeDrag) {
      const d = posBoxEdgeDrag;
      posBoxEdgeDrag = null;
      const p = (chartState.positions || []).find((x) => String(x.ticket) === d.ticket);
      if (p) {
        posBoxWSet(p, d.d0, d.d1);
        drawChart();
        toast('Açık işlem kutusu genişliği ' + Math.round(d.d1 - d.d0) + ' mum');
      }
      return;
    }
    if (lvlDrag) {
      const { kind, ref, part } = lvlDrag;
      lvlDrag = null;
      posDragActive = false;
      const sl = Number(ref.sl) || 0;
      const tp = Number(ref.tp) || 0;
      const ticket = ref.ticket;
      const sym = ref.symbol;
      (async () => {
        mt5Begin();
        try {
          let res;
          if (kind === 'pos') {
            res = await jev.mt5Modify({ ticket, sl, tp }).catch(() => null);
          } else {
            res = await jev.mt5OrderModify({ ticket, sl, tp }).catch(() => null);
          }
          if (res && res.ok) {
            toast('Seviye güncellendi #' + ticket + ' · SL ' + (sl > 0 ? nf(sl, decOf(sl)) : '—') + ' · TP ' + (tp > 0 ? nf(tp, decOf(tp)) : '—'));
          } else {
            toast('Seviye güncellenemedi: ' + ((res && res.error) || '?'));
          }
          if (kind === 'pos') refreshPositions();
          else refreshOrders();
          drawChart();
        } finally { mt5End(); }
      })();
      return;
    }
    if (planDrag) {
      const p = (chartState.plans || []).find((x) => x.id === planDrag.id);
      const wasEdge = planDrag.part === 'ex0' || planDrag.part === 'ex1';
      planDrag = null;
      if (p) {
        savePlans();
        drawChart();
        const bars = Math.max(0, Math.round((Number(p.t1) - Number(p.t0)) / barIvMs()));
        toast(wasEdge
          ? (p.side === 'long' ? 'LONG' : 'SHORT') + ' plan kutusu genişliği ' + bars + ' mum'
          : (p.side === 'long' ? 'LONG' : 'SHORT') + ' plan güncellendi · ' + planRR(p).toFixed(1) + 'R');
      }
      return;
    }
    if (alertDrag) {
      const a = (chartState.alerts || []).find((x) => x.id === alertDrag.id);
      const moved = alertDrag.moved;
      alertDrag = null;
      if (a && moved) {
        /* elle taşınan alarm çizime bağlı kalmaz, yeniden kurulur */
        if (a.drawingId) { a.drawingId = ''; a.edge = ''; }
        a.active = true;
        a.triggeredAt = 0;
        a.cooldownBar = 0;
        a.last = null;
        toast('Alarm taşındı: ' + a.symbol + ' ' + nf(a.price, decOf(a.price)));
      }
      saveAlerts();
      renderAlertSide();
      drawChart();
      return;
    }
    if (resizeDraw) {
      const d = chartState.drawings[resizeDraw.i];
      resizeDraw = null;
      saveDrawings();
      if (d) syncAlertPriceForDrawing(d);
      return;
    }
    if (chartState.dragDraw) {
      const d = chartState.drawings[chartState.dragDraw.i];
      chartState.dragDraw = null;
      saveDrawings();
      if (d) syncAlertPriceForDrawing(d);
      return;
    }
    if (chartState.segDrag) {
      /* bırakma noktası: olayın kendi koordinatı (son mousemove gecikse bile doğru) */
      try {
        const rect = canvas.getBoundingClientRect();
        const pt = chartPointFromEvent(e.clientX - rect.left, e.clientY - rect.top);
        if (pt) {
          const a0 = chartState.segDrag.a;
          chartState.segDrag.b = chartState.segDrag.type === 'range'
            ? pt
            : (e.ctrlKey ? { t: pt.t, p: a0.p } : (e.shiftKey ? parallelSegPoint(a0, pt) : pt));
        }
      } catch {}
      const sd = chartState.segDrag;
      chartState.segDrag = null;
      /* ekranda 4px'ten küçük sürükleme = tıklama say (yanlışlıkla minik çizgi oluşmasın) */
      let tiny = false;
      try {
        const gg = chartState.geo;
        if (sd && gg) {
          tiny = Math.abs(gg.xOf(idxFromTime(sd.a.t)) - gg.xOf(idxFromTime(sd.b.t))) < 4 &&
            Math.abs(gg.yOf(sd.a.p) - gg.yOf(sd.b.p)) < 4;
        }
      } catch {}
      if (sd && !tiny && (sd.a.t !== sd.b.t || sd.a.p !== sd.b.p)) {
        const isRange = sd.type === 'range';
        chartState.drawings.push({
          type: isRange ? 'range' : 'seg',
          points: [sd.a, sd.b],
          color: isRange ? (chartState.drawColors.range || '#ec4899') : chartState.drawColors.seg,
        });
        saveDrawings();
        setDrawTool('cursor');
      } else if (sd) {
        /* sürükleme olmadı: ilk tık olarak sakla, ikinci tıkta tamamlanır */
        chartState.pending = [sd.a];
        drawChart();
      }
      return;
    }
    if (chartState.free) {
      const pts = chartState.free;
      chartState.free = null;
      if (pts && pts.length >= 2) {
        chartState.drawings.push({ type: 'free', points: pts, color: chartState.drawColors.free });
        saveDrawings();
      }
      setDrawTool('cursor');
      return;
    }
    if (!chartState.dragging) return;
    chartState.dragging = false;
    canvas.style.cursor = 'crosshair';
  });

  /* sürükleme durumu takılı kalmasın: pencere odağı/dışına çıkışta temizle */
  const clearDanglingDrag = () => {
    if (chartState.dragging) {
      chartState.dragging = false;
      canvas.style.cursor = 'crosshair';
    }
    if (alertDrag) {
      const a = (chartState.alerts || []).find((x) => x.id === alertDrag.id);
      alertDrag = null;
      if (a) { saveAlerts(); renderAlertSide(); drawChart(); }
    }
  };
  window.addEventListener('blur', clearDanglingDrag);

  /* tekerlek: yatay zoom · fiyat ekseninde dikey zoom · Shift dikey zoom */
  canvas.addEventListener('wheel', (e) => {
    if (pane2.session) return;
    e.preventDefault();
    const zone = zoneAt(e);
    if (e.shiftKey || zone === 'price') {
      zoomYAt(e.clientY, e.deltaY < 0 ? 1.12 : 0.89);
      return;
    }
    const { rect, padL, plotW } = geom();
    const n = chartState.rates.length;
    if (!n || plotW <= 0) return;
    const vc = chartState.viewCount || n;
    const step = plotW / vc;
    const start = chartState.viewEnd - vc + 1;
    const x = e.clientX - rect.left;
    const idxAt = start + (x - padL) / step;
    const next = clampNum(Math.round(vc * (e.deltaY < 0 ? 0.85 : 1.18)), 20, n);
    if (next === vc) return;
    chartState.viewCount = next;
    chartState.yLock = null; /* tekerlek x-zoom: dikey ölçek yeniden otursun */
    chartState.follow = false;
    const startNew = idxAt - (x - padL) / (plotW / next);
    chartState.viewEnd = clampNum(Math.round(startNew + next - 1), next - 1, n - 1 + Math.round(next * 0.8));
    drawChart();
  }, { passive: false });

  /* çift tık: çizgi/kutu/metin düzenle (etiket + alarm) — görünüm sıfırlanmaz */
  canvas.addEventListener('dblclick', (e) => {
    if (pane2.session) return;
    /* zigzag: çift tık = çizimi bitir */
    if (chartState.tool === 'zigzag' && chartState.pending.length >= 2) {
      finishZigzag();
      return;
    }
    if (!labelEditorOpen) return;
    /* eksen bölgesinde çizim düzenleme açılmaz */
    if (zoneAt(e) !== 'plot') return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const g = chartState.geo;
    if (!g) return;
    const i = hitDrawing(mx, my, g);
    if (i >= 0) {
      chartState.selected = i;
      labelEditorOpen(i);
    }
  });

  /* crosshair + eksen imleçleri */
  canvas.addEventListener('mousemove', (e) => {
    if (chartState.dragging) return;
    if (pane2.session) return;
    const zone = zoneAt(e);
    const tool = chartState.tool;
    const rect = canvas.getBoundingClientRect();
    chartState.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    let cur = 'crosshair';
    if (tool === 'text') cur = 'text';
    else if (tool === 'cursor') {
      if (zone === 'price') cur = 'ns-resize';
      else if (zone === 'time') cur = 'ew-resize';
      else {
        const g2 = chartState.geo;
        const mx2 = chartState.mouse.x;
        const my2 = chartState.mouse.y;
        const mz = g2 ? hitPlanMagnet(mx2, my2, g2) : null;
        const ebtn = g2 ? hitPlanEntryBtn(mx2, my2, g2) : null;
        const pz = g2 ? hitPlan(mx2, my2, g2) : null;
        const pbox = g2 ? hitPlanBox(mx2, my2, g2) : null;
        const az = g2 ? hitAlert(mx2, my2, g2) : null;
        const lz = g2 ? (hitPositionLevel(mx2, my2, g2) || hitOrderLevel(mx2, my2, g2)) : null;
        const gpx = g2 ? hitPositionGroupLevel(mx2, my2, g2) : null;
        const pbx = g2 ? hitPositionCluster(mx2, my2, g2) : null;
        const fedge = g2 ? hitFiboEdge(mx2, my2, g2) : null;
        const hend = g2 ? hitEndpoint(mx2, my2, g2) : null;
        const pex = g2 ? hitPlanBoxEdge(mx2, my2, g2) : null;
        const pex2 = g2 ? hitPosBoxEdge(mx2, my2, g2) : null;
        if (mz || ebtn) cur = 'pointer';
        else if (pex || pex2) cur = 'ew-resize';
        else if (pz || lz || gpx) cur = 'ns-resize';
        else if (fedge) cur = 'ew-resize';
        else if (hend) cur = 'move';
        else if (pbox) cur = 'pointer';
        else if (az) cur = 'ns-resize';
        else if (pbx) cur = 'pointer';
        else {
          const handle = selectedRectHandleAt(mx2, my2);
          if (handle) {
            const k = handle.k;
            cur = (k === 'L' || k === 'R') ? 'ew-resize'
              : (k === 'T' || k === 'B') ? 'ns-resize'
                : (k === 'AA' || k === 'BB') ? 'nwse-resize' : 'nesw-resize';
          } else if (g2 && hitDrawing(mx2, my2, g2) >= 0) cur = 'pointer';
        }
      }
    }
    canvas.style.cursor = cur;
    /* kısa çizgi: tıkla-tıkla akışında Ctrl/Shift durumu önizlemede kullanılır */
    if (chartState.tool === 'seg' && chartState.pending.length) {
      chartState.segMods = { ctrl: e.ctrlKey, shift: e.shiftKey };
    }
    if (tool !== 'cursor') {
      if (chartState.pending.length || tool === 'alert') drawChart();
      return;
    }
    if (zone !== 'plot') {
      if (chartState.hover != null) {
        chartState.hover = null;
        chartState.hoverY = null;
        drawChart();
      }
      return;
    }
    const { padL, plotW } = geom();
    const n = chartState.rates.length;
    if (!n || plotW <= 0) return;
    const vc = chartState.viewCount || n;
    const step = plotW / vc;
    const start = chartState.viewEnd - vc + 1;
    const x = e.clientX - rect.left;
    const idx = Math.round(start + (x - padL) / step - 0.5);
    chartState.hover = Math.max(start, Math.min(n - 1, idx));
    chartState.hoverY = e.clientY - rect.top;
    drawChart();
  });
  canvas.addEventListener('mouseleave', () => {
    chartState.mouse = null;
    if (chartState.pending.length || chartState.tool === 'alert') {
      chartState.hover = null;
      chartState.hoverY = null;
      drawChart();
      return;
    }
    if (chartState.hover == null) return;
    chartState.hover = null;
    chartState.hoverY = null;
    drawChart();
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    /* zigzag: sağ tık = çizimi bitir (iptal değil) */
    if (chartState.tool === 'zigzag' && chartState.pending.length) {
      finishZigzag();
      return;
    }
    if (chartState.pending.length) {
      chartState.pending = [];
      drawChart();
    }
  });
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName ? e.target.tagName : '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'Enter' && chartState.tool === 'zigzag' && chartState.pending.length) {
      e.preventDefault();
      finishZigzag();
      return;
    }
    if (e.key === 'Escape' && chartState.pending.length) {
      chartState.pending = [];
      drawChart();
    }
  });
}

/* ---------- toolbox: tıklama işleme + panel ---------- */
function setDrawTool(id) {
  /* alarm aracına tekrar basınca seçim iptal olur (imlece döner) */
  if (id === 'alert' && chartState.tool === 'alert') id = 'cursor';
  /* yarım kalan zigzag kaybolmasın: başka araca geçerken yeterli nokta varsa çizimi bitir */
  if (chartState.tool === 'zigzag' && id !== 'zigzag' && (chartState.pending || []).length >= 2) {
    chartState.drawings.push({ type: 'zigzag', points: chartState.pending.slice(), color: chartState.drawColors.zigzag || '#eab308' });
    saveDrawings();
  }
  chartState.tool = id;
  chartState.pending = [];
  $$('#toolbox button, #toolbox2 button').forEach((b) => b.classList.toggle('active', b.dataset.tool === id));
  drawChart();
}

/* zigzag oturumunu bitir: biriken noktaları zigzag çizimi olarak kaydet */
function finishZigzag() {
  const wasPane2 = !!pane2.session;
  setDrawTool('cursor');
  if (wasPane2) {
    pane2EndSession();
    drawChart();
    drawPane2();
  }
}

function chartPointFromEvent(mx, my) {
  if (!chartState.geo) return null;
  return pointFromXY(mx, my, chartState.geo);
}

function pointFromXY(x, y, geo) {
  const rates = chartState.rates;
  if (!geo || !rates.length || !(geo.step > 0) || !(geo.plotH > 0)) return null;
  const n = rates.length;
  /* son mumun ötesine/ilk mumun gerisine taşan konumlar için zaman ekstrapolasyonu:
     kutu vb. çizimler verinin bittiği yerin ötesine kadar uzatılabilir */
  const iv = Math.max(1, rates[n - 1].time - (n >= 2 ? rates[n - 2].time : rates[n - 1].time - 60));
  const idxRaw = geo.start + (x - geo.padL) / geo.step - 0.5;
  let t;
  if (idxRaw >= n - 1) t = rates[n - 1].time + Math.round((idxRaw - (n - 1)) * iv);
  else if (idxRaw <= 0) t = rates[0].time + Math.round(idxRaw * iv);
  else t = rates[Math.round(idxRaw)].time;
  /* eksen çevrilebilir: y→fiyat dönüşümü geo.invert'e uyar */
  const p = geo.invert
    ? geo.lo + ((y - geo.padT) / geo.plotH) * (geo.hi - geo.lo)
    : geo.hi - ((y - geo.padT) / geo.plotH) * (geo.hi - geo.lo);
  return { t, p };
}

function handleToolClick(mx, my) {
  const pt = chartPointFromEvent(mx, my);
  if (!pt) return;
  const tool = chartState.tool;
  if (tool === 'hline') {
    chartState.drawings.push({ type: 'hline', points: [pt], color: chartState.drawColors.hline });
    saveDrawings();
    setDrawTool('cursor');
    return;
  }
  if (tool === 'hray') {
    chartState.drawings.push({ type: 'hray', points: [pt], color: chartState.drawColors.hray });
    saveDrawings();
    setDrawTool('cursor');
    return;
  }
  if (tool === 'ray' || tool === 'fibo' || tool === 'rect') {
    if (!chartState.pending.length) {
      chartState.pending = [pt];
      chartState.mouse = { x: mx, y: my };
      drawChart();
      return;
    }
    const dr = { type: tool, points: [chartState.pending[0], pt], color: chartState.drawColors[tool] };
    if (tool === 'rect') dr.alpha = Number(chartState.drawColors.rectAlpha);
    chartState.drawings.push(dr);
    saveDrawings();
    setDrawTool('cursor');
    return;
  }
  if (tool === 'zigzag') {
    /* her tık yeni bir pivot ekler; nokta mum yüksek/düşüğüne yapışır */
    const snap = snapZigzagPoint(pt);
    const last = chartState.pending[chartState.pending.length - 1];
    if (!last || last.t !== snap.t || last.p !== snap.p) chartState.pending.push(snap);
    chartState.mouse = { x: mx, y: my };
    if (chartState.pending.length === 1) toast('Zigzag: nokta ekle · bitir: Enter / sağ tık / çift tık');
    drawChart();
    return;
  }
  if (tool === 'channel') {
    /* 3 tık: A-B ana çizgi, C paralel çizginin genişliği */
    if (!chartState.pending.length) {
      chartState.pending = [pt];
      chartState.mouse = { x: mx, y: my };
      toast('Paralel kanal: ana çizginin 2. noktasını seç');
      drawChart();
      return;
    }
    if (chartState.pending.length === 1) {
      chartState.pending.push(pt);
      chartState.mouse = { x: mx, y: my };
      toast('Paralel kanal: genişliği ayarlamak için 3. noktayı seç');
      drawChart();
      return;
    }
    chartState.drawings.push({
      type: 'channel',
      points: [chartState.pending[0], chartState.pending[1], pt],
      color: chartState.drawColors.channel || '#0ea5e9',
      alpha: 12,
    });
    saveDrawings();
    setDrawTool('cursor');
    return;
  }
  if (tool === 'range') {
    /* 2 tık: A-B arasında üst/alt yatay bant */
    if (!chartState.pending.length) {
      chartState.pending = [pt];
      chartState.mouse = { x: mx, y: my };
      drawChart();
      return;
    }
    chartState.drawings.push({ type: 'range', points: [chartState.pending[0], pt], color: chartState.drawColors.range || '#ec4899' });
    saveDrawings();
    setDrawTool('cursor');
    return;
  }
  if (tool === 'text') {
    chartState.textAnchor = pt;
    if (labelEditorTool) labelEditorTool();
    return;
  }
  if (tool === 'emoji') {
    if (!chartState.emojiChar) { toast('Önce toolbox\'tan emoji seç'); setDrawTool('cursor'); return; }
    chartState.drawings.push({ type: 'emoji', points: [pt], text: chartState.emojiChar, size: 22 });
    saveDrawings();
    setDrawTool('cursor');
    drawChart();
    return;
  }
  if (tool === 'alert') {
    const price = Number(Number(pt.p).toFixed(Math.max(chartState.digits, 2)));
    setDrawTool('cursor');
    openAlertDialogAt(price);
    return;
  }
}

function openAlertDialogAt(price) {
  openAlertDialog('');
  if (price > 0) $('#alertPrice').value = String(price);
}

function chartInitToolbox() {
  const tb = $('#toolbox');
  if (!tb) return;
  /* 2. grafik: toolbox'un birebir kopyası (aynı araçlar, ortak seçim) */
  let tb2 = $('#toolbox2');
  const wrap2 = $('#chartWrap2');
  if (!tb2 && wrap2) {
    tb2 = tb.cloneNode(true);
    tb2.id = 'toolbox2';
    const g = tb2.querySelector('#toolboxGrip');
    if (g) g.id = 'toolbox2Grip';
    wrap2.prepend(tb2);
  }
  const boxes = [
    { el: tb, wrap: $('#chartWrap'), key: 'jev.toolboxPos' },
    { el: tb2, wrap: wrap2, key: 'jev.toolbox2Pos' },
  ];
  for (const { el, wrap, key } of boxes) {
    if (!el || !wrap) continue;
    try {
      const pos = JSON.parse(localStorage.getItem(key) || 'null');
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        el.style.left = pos.left + 'px';
        el.style.top = pos.top + 'px';
      }
    } catch {}
    Array.from(el.querySelectorAll('button')).forEach((b) => {
      if (!b.dataset.tool) return;
      b.addEventListener('click', () => setDrawTool(b.dataset.tool));
    });
    /* long / short işlem planı butonları + plan ayarları + emoji + sil */
    Array.from(el.querySelectorAll('button[data-action]')).forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.dataset.action;
        if (act === 'settings') openPlanSettings();
        else if (act === 'emoji') openEmojiPicker();
        else if (act === 'erase') {
          /* çöp ikonu: Delete tuşuyla aynı işi yapar (seçili alarm → plan → çizim) */
          if (!eraseSelected()) toast('Silmek için önce bir çizim / plan / alarm seç');
        } else createTradePlan(act);
      });
    });
    let drag = null;
    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      drag = { x: e.clientX, y: e.clientY, left: el.offsetLeft, top: el.offsetTop };
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const maxL = Math.max(4, wrap.clientWidth - el.offsetWidth - 4);
      const maxT = Math.max(4, wrap.clientHeight - el.offsetHeight - 4);
      el.style.left = Math.max(4, Math.min(maxL, drag.left + (e.clientX - drag.x))) + 'px';
      el.style.top = Math.max(4, Math.min(maxT, drag.top + (e.clientY - drag.y))) + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = null;
      try { localStorage.setItem(key, JSON.stringify({ left: el.offsetLeft, top: el.offsetTop })); } catch {}
    });
  }
  /* LLM'in yazdığı özel araçlar araç çubuklarında buton olarak görünür */
  renderCustomToolButtons();
}

let labelEditorOpen = null;
let labelEditorTool = null;

function alarmPriceForDrawing(d, edge) {
  if (!d || !d.points || !d.points.length) return 0;
  if (d.type === 'hline' || d.type === 'hray') return Number(d.points[0].p);
  if (d.type === 'rect' && d.points.length >= 2) {
    const p0 = Number(d.points[0].p);
    const p1 = Number(d.points[1].p);
    return edge === 'bottom' ? Math.min(p0, p1) : Math.max(p0, p1);
  }
  return Number(d.points[0].p);
}

function alarmLinkedTo(d) {
  if (!d || !d.id) return null;
  return (chartState.alerts || []).find((x) => x.drawingId === d.id) || null;
}

function syncAlertPriceForDrawing(d) {
  if (!d || !d.id || !Array.isArray(chartState.alerts)) return;
  const a = alarmLinkedTo(d);
  if (!a) return;
  const p = alarmPriceForDrawing(d, a.edge || 'top');
  if (p > 0 && p !== a.price) {
    a.price = p;
    saveAlerts();
    renderAlertSide();
    drawChart();
  }
}

function chartInitTextModal() {
  const ov = $('#textOverlay');
  const inp = $('#textInp');
  const headEl = $('#textHead span');
  const alignRow = $('#textAlignRow');
  const alarmBox = $('#textAlarmBox');
  const okBtn = $('#textOk');
  const delBtn = $('#textDel');
  let mode = 'tool';
  let editIdx = -1;
  /* metin aracı: konum diyalog açılırken sabitlenir (2. grafikten eklenen metin doğru yere düşsün) */
  let toolAnchor = null;

  const curAlign = () => {
    const b = $$('#textAlignRow button').find((x) => x.classList.contains('active'));
    return b ? b.dataset.align : 'center';
  };
  const setAlign = (al) => {
    $$('#textAlignRow button').forEach((b) => b.classList.toggle('active', b.dataset.align === al));
  };
  const close = () => {
    ov.hidden = true;
    chartState.textAnchor = null;
    mode = 'tool';
    editIdx = -1;
  };
  const refreshAlarmPrice = () => {
    if (mode !== 'edit' || editIdx < 0) return;
    const d = chartState.drawings[editIdx];
    if (!d) return;
    const p = alarmPriceForDrawing(d, $('#textAlarmEdge').value);
    $('#textAlarmPrice').textContent = p > 0 ? String(p) : '—';
  };

  const openTool = () => {
    mode = 'tool';
    editIdx = -1;
    toolAnchor = chartState.textAnchor;
    headEl.textContent = 'METİN EKLE';
    okBtn.textContent = 'Ekle';
    delBtn.textContent = 'Metni sil';
    alignRow.hidden = true;
    alarmBox.hidden = true;
    delBtn.hidden = true;
    $('#textSizeRow').hidden = true;
    $('#textColorRow').hidden = true;
    $('#textDrawColorRow').hidden = true;
    $('#textLabelBottomRow').hidden = true;
    $('#textFiboRow').hidden = true;
    $('#textPdRow').hidden = true;
    $('#textVAlignRow').hidden = true;
    inp.value = '';
    ov.hidden = false;
    setTimeout(() => inp.focus(), 30);
  };

  const openEdit = (i) => {
    const d = chartState.drawings[i];
    if (!d) return;
    const isTextLike = d.type === 'text' || d.type === 'emoji';
    mode = isTextLike ? 'textedit' : 'edit';
    editIdx = i;
    headEl.textContent = d.type === 'emoji' ? 'EMOJİYİ DÜZENLE' : d.type === 'text' ? 'METNİ DÜZENLE' : 'ÇİZİME METİN / ALARM';
    okBtn.textContent = 'Kaydet';
    delBtn.textContent = d.type === 'emoji' ? 'Emojiyi sil' : d.type === 'text' ? 'Metni sil' : 'Etiketi sil';
    alignRow.hidden = isTextLike;
    if (!isTextLike) setAlign(d.labelAlign || 'center');
    inp.value = isTextLike ? String(d.text || '') : String(d.label || '');
    $('#textSizeRow').hidden = false;
    const size = isTextLike ? (Number(d.size) || (d.type === 'emoji' ? 22 : 9)) : (Number(d.labelSize) || 9);
    $('#textSize').value = String(Math.max(9, Math.min(48, Math.round(size))));
    $('#textSizeVal').textContent = $('#textSize').value + 'px';
    $('#textColorRow').hidden = isTextLike;
    if (!isTextLike) $('#textColor').value = d.labelColor || '#000000';
    /* çizim rengi: seçili çizime özel renk (metin/emoji hariç tüm çizimler/kutular) */
    $('#textDrawColorRow').hidden = isTextLike;
    if (!isTextLike) $('#textDrawColor').value = d.color || chartState.drawColors[d.type] || '#3b82f6';
    /* range: üst/alt yazı ayrı ayrı — alt yazı alanı yalnız range'de görünür */
    $('#textLabelBottomRow').hidden = d.type !== 'range';
    $('#textLabelBottom').value = d.type === 'range' ? String(d.labelBottom || '') : '';
    $('#textFiboRow').hidden = d.type !== 'fibo';
    /* range çiziminde isteğe bağlı PD Array (EQ %50) çizgisi */
    $('#textPdRow').hidden = d.type !== 'range';
    if (d.type === 'range') $('#textPdBtn').textContent = d.pd ? 'PD Array Kaldır' : 'PD Array Ekle';
    $('#textVAlignRow').hidden = d.type !== 'rect';
    if (d.type === 'rect') $('#textVAlign').value = d.labelVAlign || 'middle';
    const canAlarm = d.type === 'hline' || d.type === 'hray' || d.type === 'rect';
    alarmBox.hidden = !canAlarm;
    if (canAlarm) {
      const a = alarmLinkedTo(d);
      $('#textAlarmOn').checked = !!a;
      $('#textAlarmCond').value = a ? a.cond : 'cross';
      $('#textAlarmRepeat').value = a && a.repeat ? '1' : '0';
      $('#textAlarmSound').value = a && a.sound ? a.sound : alertDefaultSound();
      $('#textAlarmEdgeRow').hidden = d.type !== 'rect';
      $('#textAlarmEdge').value = (a && a.edge) || 'top';
      refreshAlarmPrice();
    }
    delBtn.hidden = !(isTextLike ? d.text : (d.label || d.labelBottom));
    ov.hidden = false;
    setTimeout(() => inp.focus(), 30);
  };
  labelEditorOpen = openEdit;
  labelEditorTool = openTool;

  $$('#textAlignRow button').forEach((b) => b.addEventListener('click', () => setAlign(b.dataset.align)));

  const sizeFromInput = () => Math.max(9, Math.min(60, Math.round(Number($('#textSize').value) || 9)));
  $('#textSize').addEventListener('input', () => {
    $('#textSizeVal').textContent = $('#textSize').value + 'px';
    if (editIdx < 0) return;
    const d = chartState.drawings[editIdx];
    if (!d) return;
    if (mode === 'textedit') d.size = sizeFromInput();
    else d.labelSize = sizeFromInput();
    saveDrawings();
    drawChart();
  });
  $('#textVAlign').addEventListener('change', () => {
    if (editIdx < 0) return;
    const d = chartState.drawings[editIdx];
    if (!d || d.type !== 'rect') return;
    d.labelVAlign = $('#textVAlign').value;
    saveDrawings();
    drawChart();
  });
  $('#textColor').addEventListener('input', () => {
    if (editIdx < 0) return;
    const d = chartState.drawings[editIdx];
    if (!d || d.type === 'text') return;
    d.labelColor = $('#textColor').value;
    saveDrawings();
    drawChart();
  });
  /* çizim rengi: seçili çizime özel, kalıcı renk (kutu, trend, kanal, zigzag, range...) */
  $('#textDrawColor').addEventListener('input', () => {
    if (editIdx < 0) return;
    const d = chartState.drawings[editIdx];
    if (!d || d.type === 'text' || d.type === 'emoji') return;
    d.color = $('#textDrawColor').value;
    saveDrawings();
    drawChart();
  });
  /* fibonacci 0 ↔ 100 yer değiştir */
  $('#textFiboSwap').addEventListener('click', () => {
    if (editIdx < 0) return;
    const d = chartState.drawings[editIdx];
    if (!d || d.type !== 'fibo' || !d.points || d.points.length < 2) return;
    const p0 = d.points[0].p;
    d.points[0].p = d.points[1].p;
    d.points[1].p = p0;
    saveDrawings();
    drawChart();
    toast('Fibonacci 0 ↔ 100 yer değiştirildi');
  });
  /* range: isteğe bağlı PD Array — tam ortaya EQ (%50) çizgisi */
  $('#textPdBtn').addEventListener('click', () => {
    if (editIdx < 0) return;
    const d = chartState.drawings[editIdx];
    if (!d || d.type !== 'range') return;
    d.pd = !d.pd;
    $('#textPdBtn').textContent = d.pd ? 'PD Array Kaldır' : 'PD Array Ekle';
    saveDrawings();
    drawChart();
    toast(d.pd ? 'PD Array eklendi (orta EQ %50)' : 'PD Array kaldırıldı');
  });

  const syncAlarm = (d) => {
    if (d.type !== 'hline' && d.type !== 'hray' && d.type !== 'rect') return;
    if (!d.id) d.id = newId();
    const linked = alarmLinkedTo(d);
    const on = !alarmBox.hidden && $('#textAlarmOn').checked;
    if (on) {
      const price = alarmPriceForDrawing(d, $('#textAlarmEdge').value);
      const cond = $('#textAlarmCond').value;
      const repeat = $('#textAlarmRepeat').value === '1';
      const sound = $('#textAlarmSound').value || 'klasik';
      if (linked) {
        linked.price = price;
        linked.cond = cond;
        linked.edge = $('#textAlarmEdge').value;
        linked.repeat = repeat;
        linked.sound = sound;
        linked.active = true;
        linked.triggeredAt = 0;
        linked.last = null;
        linked.cooldownBar = 0;
      } else {
        chartState.alerts.push({
          id: newId(),
          symbol: chartState.symbol,
          price,
          cond,
          note: '',
          active: true,
          triggeredAt: 0,
          drawingId: d.id,
          edge: $('#textAlarmEdge').value,
          repeat,
          sound,
          ex: exName,
          tf: chartState.tf,   /* tekrarlıysa bu TF'in mumunda bir kez çalar */
          last: null,
          cooldownBar: 0,
        });
      }
    } else if (linked) {
      chartState.alerts = chartState.alerts.filter((x) => x !== linked);
    }
    saveAlerts();
    renderAlertSide();
  };

  const commit = () => {
    const v = inp.value.trim();
    if (mode === 'tool') {
      if (v && toolAnchor) {
        chartState.drawings.push({ type: 'text', points: [toolAnchor], text: v.slice(0, 120), color: chartState.drawColors.text });
        saveDrawings();
        setDrawTool('cursor');
      }
    } else if (mode === 'textedit' && editIdx >= 0) {
      const d = chartState.drawings[editIdx];
      if (d) {
        d.text = v.slice(0, 120);
        d.size = sizeFromInput();
        if (!d.text) {
          chartState.drawings.splice(editIdx, 1);
          chartState.selected = null;
        }
        saveDrawings();
      }
    } else if (mode === 'edit' && editIdx >= 0) {
      const d = chartState.drawings[editIdx];
      if (d) {
        d.label = v.slice(0, 120);
        d.labelAlign = curAlign();
        d.labelSize = sizeFromInput();
        d.labelColor = $('#textColor').value || '#000000';
        if (d.type === 'rect') d.labelVAlign = $('#textVAlign').value;
        if (!d.label) delete d.label;
        /* range: alt çizgi yazısı ayrı tutulur */
        if (d.type === 'range') {
          const lb = $('#textLabelBottom').value.trim().slice(0, 120);
          if (lb) d.labelBottom = lb; else delete d.labelBottom;
        }
        syncAlarm(d);
        saveDrawings();
      }
    }
    inp.value = '';
    close();
    drawChart();
  };
  $('#textOk').addEventListener('click', commit);
  $('#textDel').addEventListener('click', () => {
    if (editIdx >= 0) {
      const d = chartState.drawings[editIdx];
      if (d) {
        if (mode === 'textedit') {
          chartState.drawings.splice(editIdx, 1);
          chartState.selected = null;
        } else {
          delete d.label;
          if (d.type === 'range') delete d.labelBottom;
          syncAlarm(d);
        }
        saveDrawings();
      }
    }
    close();
    drawChart();
  });
  $('#textClose').addEventListener('click', close);
  $('#textCancel').addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  $('#textAlarmEdge').addEventListener('change', refreshAlarmPrice);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') close();
  });
  $('#textLabelBottom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') close();
  });
}

function chartInitColors() {
  const overlay = $('#colorOverlay');
  const c = chartState.colors;
  const sync = () => {
    $('#colUp').value = c.up;
    $('#colDown').value = c.down;
    $('#colBg').value = c.bg;
    $('#colBgOn').checked = !!c.bgOn;
    const auto = c.lineAuto !== false;
    $('#colLineAuto').checked = auto;
    $('#colLine').value = c.line || '#e5e7eb';
    $('#colLine').disabled = auto;
    const alpha = Number.isFinite(Number(c.lineAlpha)) ? Number(c.lineAlpha) : 100;
    $('#colLineAlpha').value = String(alpha);
    $('#colLineAlphaVal').textContent = '%' + alpha;
    const crossA0 = Number.isFinite(Number(c.crossAlpha)) ? Number(c.crossAlpha) : 70;
    $('#colCross').value = c.cross || '#8a8a92';
    $('#colCrossAlpha').value = String(crossA0);
    $('#colCrossAlphaVal').textContent = '%' + crossA0;
    const dc = chartState.drawColors;
    $('#dcolHline').value = dc.hline;
    $('#dcolHray').value = dc.hray || '#06b6d4';
    $('#dcolSeg').value = dc.seg || '#000000';
    $('#dcolRay').value = dc.ray;
    $('#dcolFibo').value = dc.fibo;
    $('#dcolRect').value = dc.rect || '#3b82f6';
    const ra = Number.isFinite(Number(dc.rectAlpha)) ? Number(dc.rectAlpha) : 30;
    $('#dcolRectAlpha').value = String(ra);
    $('#dcolRectAlphaVal').textContent = '%' + ra;
    /* işlem planı (long/short kutusu) renkleri */
    $('#colPlanSl').value = c.planSl || '#f43f5e';
    $('#colPlanTp').value = c.planTp || '#22c55e';
    $('#colPlanText').value = c.planText || '#000000';
    $('#colPlanEntry').value = c.planEntry || '#cbd5e1';
    const pf = Number.isFinite(Number(c.planFill)) ? Number(c.planFill) : 30;
    $('#colPlanFill').value = String(pf);
    $('#colPlanFillVal').textContent = '%' + pf;
    /* açık işlem planı (pozisyon kutusu) renkleri */
    $('#colPosSl').value = c.posSl || c.planSl || '#f43f5e';
    $('#colPosTp').value = c.posTp || c.planTp || '#22c55e';
    $('#colVolUp').value = c.volUp || '#22c55e';
    $('#colVolDown').value = c.volDown || '#ef4444';
    $('#colLvlEntry').value = c.lvlEntry || '#3b82f6';
    $('#colLvlPending').value = c.lvlPending || '#f59e0b';
    $('#colLvlSl').value = c.lvlSl || '#ef4444';
    $('#colLvlTp').value = c.lvlTp || '#22c55e';
    const la = Number.isFinite(Number(c.lvlAlpha)) ? Number(c.lvlAlpha) : 85;
    $('#colLvlAlpha').value = String(la);
    $('#colLvlAlphaVal').textContent = '%' + la;
    const lwv = Number.isFinite(Number(c.lvlWidth)) ? Number(c.lvlWidth) : 1;
    $('#colLvlWidth').value = String(lwv);
    $('#colLvlWidthVal').textContent = lwv + 'px';
    $('#dcolFree').value = dc.free;
    $('#dcolZigzag').value = dc.zigzag || '#eab308';
    $('#dcolChannel').value = dc.channel || '#0ea5e9';
    $('#dcolRange').value = dc.range || '#ec4899';
    $('#dcolText').value = dc.text;
    const selDr = chartState.selected != null ? chartState.drawings[chartState.selected] : null;
    $('#dcolSelRow').hidden = !selDr;
    if (selDr) $('#dcolSel').value = selDr.color || dc[selDr.type] || '#3b82f6';
    $('#dcolSelAlphaRow').hidden = !selDr;
    if (selDr) {
      const sa = selDr.alpha == null ? (selDr.type === 'rect' ? ra : 100) : Number(selDr.alpha);
      $('#dcolSelAlpha').value = String(sa);
      $('#dcolSelAlphaVal').textContent = '%' + sa;
    }
  };
  sync();
  $('#chartColorBtn').addEventListener('click', () => {
    sync();
    overlay.hidden = false;
  });
  $('#colorClose').addEventListener('click', () => { overlay.hidden = true; });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
  $('#colUp').addEventListener('input', () => { c.up = $('#colUp').value; saveChartColors(); drawChart(); });
  $('#colDown').addEventListener('input', () => { c.down = $('#colDown').value; saveChartColors(); drawChart(); });
  $('#colBg').addEventListener('input', () => {
    c.bg = $('#colBg').value;
    c.bgOn = true;
    $('#colBgOn').checked = true;
    saveChartColors();
    drawChart();
  });
  $('#colBgOn').addEventListener('change', () => {
    c.bgOn = $('#colBgOn').checked;
    saveChartColors();
    drawChart();
  });
  /* fiyat çizgisi: renk + opaklık + mum yönüne göre renk */
  $('#colLine').addEventListener('input', () => {
    c.line = $('#colLine').value;
    saveChartColors();
    drawChart();
  });
  $('#colLineAuto').addEventListener('change', () => {
    c.lineAuto = $('#colLineAuto').checked;
    $('#colLine').disabled = c.lineAuto;
    saveChartColors();
    drawChart();
  });
  $('#colLineAlpha').addEventListener('input', () => {
    c.lineAlpha = Number($('#colLineAlpha').value);
    $('#colLineAlphaVal').textContent = '%' + $('#colLineAlpha').value;
    saveChartColors();
    drawChart();
  });
  /* crosshair (artı imleci) rengi + opaklığı */
  $('#colCross').addEventListener('input', () => { c.cross = $('#colCross').value; saveChartColors(); drawChart(); });
  $('#colCrossAlpha').addEventListener('input', () => {
    c.crossAlpha = Number($('#colCrossAlpha').value);
    $('#colCrossAlphaVal').textContent = '%' + $('#colCrossAlpha').value;
    saveChartColors();
    drawChart();
  });
  /* hacim renkleri */
  $('#colVolUp').addEventListener('input', () => { c.volUp = $('#colVolUp').value; saveChartColors(); drawChart(); });
  $('#colVolDown').addEventListener('input', () => { c.volDown = $('#colVolDown').value; saveChartColors(); drawChart(); });
  /* işlem planı (long/short kutusu) renkleri: SL/TP alanları ayrı ayarlanır */
  $('#colPlanSl').addEventListener('input', () => { c.planSl = $('#colPlanSl').value; saveChartColors(); drawChart(); });
  $('#colPlanTp').addEventListener('input', () => { c.planTp = $('#colPlanTp').value; saveChartColors(); drawChart(); });
  $('#colPlanText').addEventListener('input', () => { c.planText = $('#colPlanText').value; saveChartColors(); drawChart(); });
  $('#colPlanEntry').addEventListener('input', () => { c.planEntry = $('#colPlanEntry').value; saveChartColors(); drawChart(); });
  $('#colPlanFill').addEventListener('input', () => {
    c.planFill = Number($('#colPlanFill').value);
    $('#colPlanFillVal').textContent = '%' + $('#colPlanFill').value;
    saveChartColors();
    drawChart();
  });
  /* açık işlem planı (pozisyon kutusu) renkleri: işlem planından bağımsız */
  $('#colPosSl').addEventListener('input', () => { c.posSl = $('#colPosSl').value; saveChartColors(); drawChart(); });
  $('#colPosTp').addEventListener('input', () => { c.posTp = $('#colPosTp').value; saveChartColors(); drawChart(); });
  /* işlem seviyesi çizgi renkleri */
  $('#colLvlEntry').addEventListener('input', () => { c.lvlEntry = $('#colLvlEntry').value; saveChartColors(); drawChart(); });
  $('#colLvlPending').addEventListener('input', () => { c.lvlPending = $('#colLvlPending').value; saveChartColors(); drawChart(); });
  $('#colLvlSl').addEventListener('input', () => { c.lvlSl = $('#colLvlSl').value; saveChartColors(); drawChart(); });
  $('#colLvlTp').addEventListener('input', () => { c.lvlTp = $('#colLvlTp').value; saveChartColors(); drawChart(); });
  $('#colLvlAlpha').addEventListener('input', () => {
    c.lvlAlpha = Number($('#colLvlAlpha').value);
    $('#colLvlAlphaVal').textContent = '%' + $('#colLvlAlpha').value;
    saveChartColors();
    drawChart();
  });
  $('#colLvlWidth').addEventListener('input', () => {
    c.lvlWidth = Number($('#colLvlWidth').value);
    $('#colLvlWidthVal').textContent = $('#colLvlWidth').value + 'px';
    saveChartColors();
    drawChart();
  });
  /* çizim varsayılan renkleri (kalıcı) */
  const bindDrawColor = (id, type) => {
    $(id).addEventListener('input', () => {
      chartState.drawColors[type] = $(id).value;
      saveDrawColors();
      /* kısa çizgi rengi değişince mevcut kısa çizgiler de güncellenir */
      if (type === 'seg') {
        for (const d of (chartState.drawings || [])) {
          if (d && d.type === 'seg') d.color = $(id).value;
        }
        saveDrawings();
        drawChart();
      }
    });
  };
  bindDrawColor('#dcolHline', 'hline');
  bindDrawColor('#dcolHray', 'hray');
  bindDrawColor('#dcolSeg', 'seg');
  bindDrawColor('#dcolRay', 'ray');
  bindDrawColor('#dcolFibo', 'fibo');
  bindDrawColor('#dcolRect', 'rect');
  bindDrawColor('#dcolFree', 'free');
  bindDrawColor('#dcolZigzag', 'zigzag');
  bindDrawColor('#dcolChannel', 'channel');
  bindDrawColor('#dcolRange', 'range');
  bindDrawColor('#dcolText', 'text');
  /* kutu varsayılan opaklığı */
  $('#dcolRectAlpha').addEventListener('input', () => {
    chartState.drawColors.rectAlpha = Number($('#dcolRectAlpha').value);
    $('#dcolRectAlphaVal').textContent = '%' + $('#dcolRectAlpha').value;
    saveDrawColors();
    drawChart();
  });
  /* seçili çizimin rengi */
  $('#dcolSel').addEventListener('input', () => {
    const dr = chartState.selected != null ? chartState.drawings[chartState.selected] : null;
    if (!dr) return;
    dr.color = $('#dcolSel').value;
    saveDrawings();
    drawChart();
  });
  /* seçili çizimin opaklığı (kutu dolgusu/çizgisi) */
  $('#dcolSelAlpha').addEventListener('input', () => {
    const dr = chartState.selected != null ? chartState.drawings[chartState.selected] : null;
    if (!dr) return;
    dr.alpha = Number($('#dcolSelAlpha').value);
    $('#dcolSelAlphaVal').textContent = '%' + $('#dcolSelAlpha').value;
    saveDrawings();
    drawChart();
  });
  /* seviye göster/gizle (sekme bazlı) */
  const bindToggleBtn = (sel, stateKey, lsKey, redraw) => {
    const b = $(sel);
    if (!b) return;
    b.classList.toggle('active', !!chartState[stateKey]);
    b.addEventListener('click', () => {
      chartState[stateKey] = !chartState[stateKey];
      const t = activeTab();
      if (t) { t[stateKey] = chartState[stateKey]; saveTabs(); }
      try { localStorage.setItem(lsKey, chartState[stateKey] ? '1' : '0'); } catch {}
      b.classList.toggle('active', chartState[stateKey]);
      drawChart();
    });
  };
  bindToggleBtn('#levelsBtn', 'showLevels', 'jev.showLevels');
  bindToggleBtn('#posBoxBtn', 'showPosBox', 'jev.showPosBox');
  /* açık işlem yazıları: seviye etiketleri + kutu metinleri göster/gizle */
  bindToggleBtn('#posTextBtn', 'showPosText', 'jev.showPosText');
  bindToggleBtn('#ordLevelsBtn', 'showOrdLevels', 'jev.showOrdLevels');
  bindToggleBtn('#alertLevelsBtn', 'showAlertLevels', 'jev.showAlertLevels');
  bindToggleBtn('#volBtn', 'showVolume', 'jev.showVolume');
  /* AVG çizgisi aç/kapa (grafiği ters çevir düğmesinin yanında) */
  bindToggleBtn('#avgBtn', 'showAvg', 'jev.showAvg');
  /* bu semboldeki tüm çizimleri temizle (iki adımlı onay) */
  const clr = $('#chartClear');
  let clrArmed = false;
  let clrTimer = null;
  const clrReset = () => {
    clrArmed = false;
    clr.classList.remove('danger');
    clr.title = 'Bu semboldeki tüm çizimleri temizle';
  };
  clr.addEventListener('click', () => {
    if (!clrArmed) {
      clrArmed = true;
      clr.classList.add('danger');
      clr.title = 'Tekrar bas: bu semboldeki tüm çizimler silinecek';
      toast('Tüm çizimleri silmek için tekrar bas');
      clearTimeout(clrTimer);
      clrTimer = setTimeout(clrReset, 3000);
      return;
    }
    clearTimeout(clrTimer);
    const n = chartState.drawings.length;
    const nPlan = (chartState.plans || []).filter((p) => p.symbol === chartState.symbol).length;
    clrReset();
    if (!n && !nPlan) { toast('Temizlenecek çizim yok (' + chartState.symbol + ')'); return; }
    chartState.drawings = [];
    chartState.selected = null;
    chartState.pending = [];
    chartState.free = null;
    chartState.textAnchor = null;
    chartState.plans = (chartState.plans || []).filter((p) => p.symbol !== chartState.symbol);
    selectedPlanId = '';
    saveDrawings();
    savePlans();
    applyPlanButtons();
    drawChart();
    toast((n + nPlan) + ' öğe temizlendi (' + chartState.symbol + ')' + (nPlan ? ' · ' + nPlan + ' plan' : ''));
  });
  $('#colorReset').addEventListener('click', () => {
    chartState.colors = { ...DEFAULT_COLORS };
    chartState.drawColors = { ...DEFAULT_DRAW_COLORS };
    saveDrawColors();
    sync();
    saveChartColors();
    drawChart();
  });
}

/* ---------- günlük forex haberleri: 08:30'da ana süreç çeker, burada gösterilir ---------- */
let dailyNews = { date: '', updatedAt: '', items: [], errors: [] };
let newsBusy = false;

function fmtNewsTime(at) {
  const s = String(at || '').trim();
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 20);
  return d.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderNewsModal() {
  const list = $('#newsList');
  if (!list) return;
  const n = dailyNews.items || [];
  const when = dailyNews.updatedAt ? new Date(dailyNews.updatedAt) : null;
  const meta = 'Gün: ' + (dailyNews.date || '—') +
    (when && !Number.isNaN(when.getTime()) ? ' · son güncelleme ' + when.toLocaleTimeString('tr-TR') : '') +
    ' · ' + n.length + ' manşet · her gün 08:30\'da otomatik';
  $('#newsMeta').textContent = meta;
  if (!n.length) {
    list.innerHTML = '<div class="news-empty">Bugünün haberleri henüz çekilmedi. “⟳” ile şimdi çekebilirsin.' +
      ((dailyNews.errors && dailyNews.errors.length) ? '<br>Kaynak hataları: ' + escapeHtml(dailyNews.errors.join(' · ')) : '') +
      '</div>';
    return;
  }
  let html = '';
  for (const it of n) {
    html += '<div class="news-item" data-url="' + escapeHtml(it.link || '') + '">' +
      '<span class="news-top">' + escapeHtml(it.source || '') + (it.at ? ' · ' + escapeHtml(fmtNewsTime(it.at)) : '') + '</span>' +
      '<span class="news-title">' + escapeHtml(it.title || '') + '</span>' +
      '</div>';
  }
  if (dailyNews.errors && dailyNews.errors.length) {
    html += '<div class="news-empty">Bazı kaynaklara ulaşılamadı: ' + escapeHtml(dailyNews.errors.join(' · ')) + '</div>';
  }
  list.innerHTML = html;
  $$('#newsList .news-item').forEach((el) => {
    el.addEventListener('click', () => {
      const u = el.dataset.url;
      if (u) jev.openExternal(u).catch(() => {});
    });
  });
}

async function loadDailyNews(force) {
  if (newsBusy) return;
  newsBusy = true;
  const btn = $('#newsRefresh');
  if (btn) btn.classList.add('busy');
  try {
    const r = force ? await jev.newsRefresh().catch(() => null) : await jev.newsGet().catch(() => null);
    if (r && r.ok && r.news) {
      dailyNews = r.news;
      renderNewsModal();
      if (force) toast('Haberler güncellendi: ' + (dailyNews.items || []).length + ' manşet');
    }
  } finally {
    newsBusy = false;
    if (btn) btn.classList.remove('busy');
  }
}

function chartInitNews() {
  const ov = $('#newsOverlay');
  $('#newsBtn').addEventListener('click', () => {
    ov.hidden = false;
    renderNewsModal();
    loadDailyNews(false);
  });
  $('#newsClose').addEventListener('click', () => { ov.hidden = true; });
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.hidden = true; });
  $('#newsRefresh').addEventListener('click', () => loadDailyNews(true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ov.hidden) {
      ov.hidden = true;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);
  /* ana süreç 08:30'da çekince haberler canlı gelsin */
  jev.onNewsUpdated((n) => {
    if (!n) return;
    dailyNews = n;
    renderNewsModal();
    toast('Günlük haberler güncellendi (' + (n.items || []).length + ' manşet)');
  });
  /* açılışta eldeki haberleri yükle */
  loadDailyNews(false);
}

async function chartInit() {
  chartState.symbol = (localStorage.getItem('jev.symbol') || 'EURUSD').toUpperCase();
  $('#chartSymbol').value = chartState.symbol;
  buildTfRow();
  chartInitResizer();
  chartInitPosResizer();
  chartInitCanvas();
  chartInitCanvas2();
  chartInitColors();
  chartInitToolbox();
  chartInitTextModal();
  chartInitNews();
  loadDrawings();

  /* zaman zoom butonları + son muma git */
  $('#zoomInBtn').addEventListener('click', () => zoomTime(0.8));
  $('#zoomOutBtn').addEventListener('click', () => zoomTime(1.25));
  $('#playBtn').addEventListener('click', () => {
    const n = chartState.rates.length;
    if (!n) return;
    chartState.follow = true;
    chartState.yLock = null; /* son muma dön: dikey ölçek canlı price'a otursun */
    /* sağda ~%20 boşluk kalsın: son mum kenara yapışmasın */
    chartState.rightGap = 0.2;
    chartState.viewEnd = n - 1 + Math.round((chartState.viewCount || 140) * 0.2);
    drawChart();
    toast('Son mum · canlı takip açık (sağda %20 boşluk)');
  });

  /* ikili grafik modu */
  $('#dualBtn').addEventListener('click', () => applyDual(!pane2.on));

  /* ters grafik (invert scale): fiyat eksenini aşağı-yukarı çevirir.
     Çizimler, alarmlar, planlar ve otomatik seviyeler eksenle birlikte döner;
     panel 1 ve panel 2 aynı ayarı paylaşır. */
  const applyInvertBtn = () => {
    const b = $('#invertBtn');
    if (b) b.classList.toggle('active', !!chartState.invert);
  };
  pane2.invert = !!chartState.invert;
  const invertEl = $('#invertBtn');
  if (invertEl) {
    invertEl.addEventListener('click', () => {
      chartState.invert = !chartState.invert;
      pane2.invert = chartState.invert;
      try { localStorage.setItem('jev.invert', chartState.invert ? '1' : '0'); } catch {}
      applyInvertBtn();
      drawChart();
      drawPane2();
      toast(chartState.invert ? 'Ters grafik AÇIK — düşüş yukarı görünür' : 'Ters grafik kapalı — normal yön');
    });
    applyInvertBtn();
  }
  $('#chartSymbol2').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    setPane2Symbol($('#chartSymbol2').value);
  });
  if (window.ResizeObserver) new ResizeObserver(() => drawPane2()).observe($('#chart2Body'));
  applyDual(localStorage.getItem('jev.dual') === '1');

  $('#chartSymbol').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    setChartSymbol($('#chartSymbol').value);
  });
  $('#chartRefresh').addEventListener('click', () => {
    if (exName === 'mt5') jev.mt5Start();
    resetView();
    loadRates();
    refreshPositions();
    refreshOrders();
  });
  /* sağdan açılan MT5 listesi (yalnız semboller) */
  $('#chartListBtn').addEventListener('click', () => {
    const el = $('#chartList');
    const open = !el.classList.contains('open');
    el.classList.toggle('open', open);
    if (open) {
      refreshAllSymbols(true);
      renderSymbolList();
    }
    setTimeout(() => drawChart(), 300);
  });
  $('#clClose').addEventListener('click', () => $('#chartList').classList.remove('open'));
  $('#clRefresh').addEventListener('click', () => refreshAllSymbols(true));
  /* tüm liste çekildi: 2 sn'de bir yalnız liste boşsa yeniden dene */
  setInterval(() => {
    if (document.hidden) return;
    if (!$('#chartList').classList.contains('open')) return;
    refreshAllSymbols(false);
  }, 2000);
  $('#posRefresh').addEventListener('click', () => {
    refreshPositions();
    refreshOrders();
    if (posView === 'hist') refreshClosed();
  });
  /* simge durumuna küçült */
  applyPosMin();
  $('#posMin').addEventListener('click', () => {
    const min = localStorage.getItem('jev.posMin') === '1';
    try { localStorage.setItem('jev.posMin', min ? '0' : '1'); } catch {}
    applyPosMin();
    drawChart();
  });
  /* sekme geçişleri: pozisyonlar / bekleyen işlemler / kapananlar */
  $('#posTabPos').addEventListener('click', () => { posView = 'pos'; renderPositions(); });
  $('#posTabOrd').addEventListener('click', () => { posView = 'ord'; renderPositions(); });
  $('#posTabHist').addEventListener('click', () => { posView = 'hist'; refreshClosed(); renderPositions(); });
  $('#posTabTerm').addEventListener('click', () => { posView = 'term'; renderTerminal(); renderPositions(); });
  $('#posTabJev').addEventListener('click', () => { posView = 'jev'; renderJevLog(); renderPositions(); });
  $('#jevSetBtn').addEventListener('click', openJevSet);
  $('#jevSetClose').addEventListener('click', closeJevSet);
  $('#jevSetOverlay').addEventListener('click', (e) => { if (e.target === $('#jevSetOverlay')) closeJevSet(); });
  $('#jsSave').addEventListener('click', saveJevSet);

  /* pozisyonları toplu kapat */
  const closeMany = async (list, label) => {
    if (!list.length) { toast(label + ': kapatılacak pozisyon yok'); return; }
    mt5Begin();
    try {
      let ok = 0, fail = 0;
      for (const p of list) {
        const r = await jev.mt5ClosePosition({ ticket: p.ticket }).catch(() => null);
        if (r && r.ok) ok++;
        else fail++;
      }
      toast(label + ': ' + ok + ' kapatıldı' + (fail ? ' · ' + fail + ' başarısız' : ''));
      pushToast(label, ok + ' kapatıldı' + (fail ? ' · ' + fail + ' başarısız' : ''), 'trade-open');
      termLogAdd(label + ' · ' + ok + ' kapatıldı' + (fail ? ' · ' + fail + ' başarısız' : ''), 'close');
    } finally { mt5End(); }
    refreshPositions();
  };
  $('#posCloseAll').addEventListener('click', () => {
    closeMany((chartState.positions || []).slice(), 'Close All');
  });
  $('#posPct25').addEventListener('click', () => {
    closePartialMany((chartState.positions || []).slice(), 0.25, '%25 Close');
  });
  $('#posPct50').addEventListener('click', () => {
    closePartialMany((chartState.positions || []).slice(), 0.5, '%50 Close');
  });
  $('#posBeAll').addEventListener('click', () => {
    beMany((chartState.positions || []).slice(), 'All BE');
  });
  $('#posSeAll').addEventListener('click', () => {
    seMany((chartState.positions || []).slice(), 'All SE');
  });
  $('#posCloseProfit').addEventListener('click', () => {
    closeMany((chartState.positions || []).filter((p) => posProfit(p) > 0), 'Close Profit');
  });
  $('#posCloseLoss').addEventListener('click', () => {
    closeMany((chartState.positions || []).filter((p) => posProfit(p) < 0), 'Close Loss');
  });
  /* tüm bekleyen emirleri iptal et */
  $('#ordCancelAll').addEventListener('click', async () => {
    const list = (chartState.orders || []).slice();
    if (!list.length) { toast('İptal edilecek bekleyen emir yok'); return; }
    mt5Begin();
    try {
      let ok = 0, fail = 0;
      for (const o of list) {
        const r = await jev.mt5OrderDelete({ ticket: o.ticket }).catch(() => null);
        if (r && r.ok) ok++;
        else fail++;
      }
      toast('Tümünü İptal: ' + ok + ' emir iptal edildi' + (fail ? ' · ' + fail + ' başarısız' : ''));
      pushToast('TÜM EMİRLER İPTAL', ok + ' emir iptal edildi' + (fail ? ' · ' + fail + ' başarısız' : ''), 'trade-open');
      termLogAdd('TÜM EMİRLER İPTAL · ' + ok + ' emir' + (fail ? ' · ' + fail + ' başarısız' : ''), 'close');
    } finally { mt5End(); }
    refreshOrders();
  });

  jev.onMt5Event((ev) => {
    if (exSwitching) return;                 /* borsa değişimi sırasında kapatma olayı */
    if (exName !== 'mt5') return;  /* kripto modunda MT5 olayları yok sayılır */
    updateMt5Dot(!!(ev && ev.connected));
    if (ev && ev.connected) {
      termLogAdd('MT5 bağlandı' + (ev.account && ev.account.login ? ' · hesap ' + ev.account.login : ''), 'sys');
      loadSymbolList();
      updateAccount(ev.account);
      setChartMsg('');
      loadRates();
      if (pane2.on) loadRates2();
      refreshPositions();
      refreshOrders();
    } else {
      setChartMsg('MT5 bağlantısı yok — MetaTrader 5 açık mı?', true);
      termLogAdd('MT5 bağlantısı yok', 'sl');
      chartState.positions = [];
      chartState.orders = [];
      renderPositions();
    }
  });

  const st = await jev.mt5Status().catch(() => null);
  if (st && st.connected) {
    termLogAdd('JevTrader hazır · MT5 bağlı', 'sys');
    updateMt5Dot(true);
    updateAccount(st.account);
    loadSymbolList();
    loadRates();
    if (pane2.on) loadRates2();
    refreshPositions();
  } else if (exName === 'mt5') {
    setChartMsg('MT5 bağlanıyor…');
    jev.mt5Start();
  }

  /* canlı akış: mumlar + hesap 1 sn; pozisyon/emir ve kapanan aralıkları Jev ayarlarından */
  setInterval(() => { if (!document.hidden) { loadRates(); if (pane2.on) loadRates2(); } }, 1000);
  /* mum kapanışı geri sayımı (sol alt) */
  updateCountdown();
  setInterval(() => { if (!document.hidden) updateCountdown(); }, 1000);
  /* ayarlar > loglar sekmesi açıkken canlı yenile */
  setInterval(() => {
    if (document.hidden) return;
    const ov = $('#settingsOverlay');
    const pane = $('#tab-logs');
    if (ov && !ov.hidden && pane && !pane.hidden) loadLogs();
  }, 2500);
  /* pozisyon/emir ve kapanan kontrolü: aralıklar Jev ayarlarından (varsayılan 1 sn / 15 sn) */
  applyJevTimers();
  setInterval(async () => {
    if (chartState.acctBusy) return;
    chartState.acctBusy = true;
    try {
      const r = await jev.mt5Account().catch(() => null);
      if (r && r.ok && r.data) {
        updateAccount(r.data.account);
        if (exName !== 'mt5') logExStatus(exName, true);
      } else if (r && exName !== 'mt5') {
        logExStatus(exName, false, r.error);
      }
    } finally {
      chartState.acctBusy = false;
    }
  }, 1000);
}

/* ---------- başlat ---------- */
async function init() {
  applyTheme();
  termLogAdd('JevTrader başlatıldı', 'sys');
  loadSessions();
  pruneSessions();
  loadTabs();
  renderSessions();
  renderMsgs();
  applyState();
  /* 24 saatten eski sohbet mesajları düzenli olarak silinsin (her sekme/borsa) */
  setInterval(() => {
    if (pruneSessions()) {
      renderSessions();
      renderMsgs();
    }
  }, 5 * 60 * 1000);

  builtinProviders = (await jev.builtinProviders().catch(() => [])) || [];
  state = await jev.getSettings();
  applyState();
  await loadSkillsCache();
  await loadToolsCache();
  renderCustomToolButtons();

  const v = await jev.appVersion().catch(() => null);
  $('#setVersion').textContent = v && typeof v === 'object'
    ? 'JevTrader v' + (v.version || '—') + ' · build ' + (v.build || '—')
    : 'JevTrader v' + (v || '—');

  $('#netDot').className = navigator.onLine ? 'net-on' : 'net-off';
  window.addEventListener('online', () => { $('#netDot').className = 'net-on'; });
  window.addEventListener('offline', () => { $('#netDot').className = 'net-off'; });

  /* sohbet */
  $('#sendBtn').addEventListener('click', sendMessage);
  document.querySelectorAll('.quick-msg').forEach((b) => {
    b.addEventListener('click', () => sendMessage(b.dataset.msg));
  });
  $('#stopBtn').addEventListener('click', () => {
    if (pendingChatId) jev.chatStop(pendingChatId);
  });
  /* akışlı yanıt parçaları (main → renderer) */
  jev.onChatDelta(chatStreamDelta);
  /* grafik ekran görüntüsünü mesajlara ekle (aç/kapa) */
  applyShotBtn();
  $('#shotBtn').addEventListener('click', () => {
    const on = !attachShotOn();
    try { localStorage.setItem('jev.attachShot', on ? '1' : '0'); } catch {}
    applyShotBtn();
    toast(on ? 'Grafik görüntüsü mesajlara ekleniyor' : 'Grafik görüntüsü eklenmiyor');
  });
  $('#chatSetBtn').addEventListener('click', openChatSet);
  $('#chatSetClose').addEventListener('click', closeChatSet);
  $('#chatSetOverlay').addEventListener('click', (e) => { if (e.target === $('#chatSetOverlay')) closeChatSet(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const ov = $('#chatSetOverlay');
    if (ov && !ov.hidden) closeChatSet();
  });
  $('#csSave').addEventListener('click', () => { saveChatSet().catch(() => {}); });
  /* TF modu değişince gerekçe metni ve geçerli üst/alt eşleşmesini tazele */
  const tfMode = $('#csTfMode');
  if (tfMode) tfMode.addEventListener('change', () => { anaTfCache = { at: 0, val: null }; refreshAnaTfWhy(); });
  const tfH = $('#csTfHtf');
  if (tfH) tfH.addEventListener('change', () => { anaTfCache = { at: 0, val: null }; refreshAnaTfWhy(); });
  const tfE = $('#csTfEtf');
  if (tfE) tfE.addEventListener('change', () => {
    /* giriş TF'i üst TF'ten büyükse uyar ve bir altına çek */
    const h = tfH ? tfH.value : 'H1';
    const v = tfNorm(tfE.value, 'M5');
    if (TF_RANK[v] >= TF_RANK[tfNorm(h)]) { tfE.value = tfLower(h); toast('Giriş TF\'i üst TF\'ten küçük olmalı'); }
    refreshAnaTfWhy();
  });
  const memRefresh = $('#csMemRefresh');
  if (memRefresh) memRefresh.addEventListener('click', () => { renderMemoryBox(); });
  const memClear = $('#csMemClear');
  if (memClear) memClear.addEventListener('click', async () => {
    if (!confirm('Kalıcı performans hafızası silinsin mi? Tüm geçmiş istatistikleri ve karar kayıtları kaybolur (borsa verisi etkilenmez).')) return;
    const r = await jev.journalClear().catch(() => null);
    try { localStorage.removeItem('jev.journalSeen'); localStorage.removeItem('jev.journalBackfill'); } catch {}
    if (r && r.ok) {
      dayGuardCache = { at: 0, val: null };
      jevLogAdd('PERFORMANS HAFIZASI · sıfırlandı', 'info');
      toast('Performans hafızası sıfırlandı');
      renderMemoryBox();
    }
  });
  $('#csSkillsManage').addEventListener('click', () => {
    closeChatSet();
    openSettings();
    switchTab('skills');
  });
  const input = $('#input');
  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  /* entegrasyonlar: durum olayları + gelen mesajlar (WhatsApp/Telegram/Discord) */
  jev.onIntegrationEvent((ev) => intgApplyEvent(ev));
  jev.onIntegrationIncoming((msg) => { handleIntegrationMessage(msg).catch(() => {}); });

  /* sol panel daralt */
  applySidebarCollapsed();
  $('#sideCollapse').addEventListener('click', () => {
    const c = localStorage.getItem('jev.sideCollapsed') === '1';
    try { localStorage.setItem('jev.sideCollapsed', c ? '0' : '1'); } catch {}
    applySidebarCollapsed();
  });

  /* sohbet panelini gizle/göster (tam grafik) */
  applyChatCollapsed();
  applyTabChat(); /* aktif sekmenin chat LLM durumu (kapalıysa sütun gizli) */
  $('#chatCollapseBtn').addEventListener('click', () => {
    const c = localStorage.getItem('jev.chatHidden') === '1';
    try { localStorage.setItem('jev.chatHidden', c ? '0' : '1'); } catch {}
    applyChatCollapsed();
  });

  /* fiyat alarmları */
  loadAlerts();
  loadPlans();
  applyPlanButtons();
  /* alarm ses seçenekleri */
  for (const sel of ['#alertSoundSel', '#textAlarmSound', '#asSound']) {
    const el = $(sel);
    if (!el) continue;
    el.innerHTML = ALERT_SOUNDS.map((s) => '<option value="' + s.id + '">' + s.name + '</option>').join('');
  }
  $('#alertSoundTest').addEventListener('click', () => playAlertSound($('#alertSoundSel').value));
  /* alarm ayarları diyalogu */
  $('#alertSetBtn').addEventListener('click', openAlertSet);
  $('#alertSetClose').addEventListener('click', closeAlertSet);
  $('#asSave').addEventListener('click', saveAlertSet);
  $('#asTest').addEventListener('click', () => playAlertSound($('#asSound').value));
  $('#alertSetOverlay').addEventListener('click', (e) => { if (e.target === $('#alertSetOverlay')) closeAlertSet(); });
  renderAlertSide();
  applyAlertSoundBtn();
  $('#alertSoundBtn').addEventListener('click', () => {
    const on = !alertSoundOn();
    try { localStorage.setItem('jev.alertSound', on ? '1' : '0'); } catch {}
    applyAlertSoundBtn();
    if (on) playAlertSound('klasik');
    toast(on ? 'Alarm sesi açık' : 'Alarm sesi kapalı');
  });
  /* hoparlöre sağ tık: alarm ayarları (ses / süre) */
  $('#alertSoundBtn').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openAlertSet();
  });
  /* ilk tıklamada ses motorunu uyandır (autoplay kısıtı) */
  window.addEventListener('click', () => {
    try {
      alertAudioCtx = alertAudioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (alertAudioCtx.state === 'suspended') alertAudioCtx.resume();
    } catch {}
  }, { once: true });
  $('#alertAddBtn').addEventListener('click', () => openAlertDialog(''));
  $('#alertsClose').addEventListener('click', closeAlertDialog);
  $('#alertCancel').addEventListener('click', closeAlertDialog);
  $('#alertsOverlay').addEventListener('click', (e) => { if (e.target === $('#alertsOverlay')) closeAlertDialog(); });
  $('#alertSave').addEventListener('click', saveAlertFromDialog);
  $('#alertPrice').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveAlertFromDialog();
    if (e.key === 'Escape') closeAlertDialog();
  });
  $('#alertDelete').addEventListener('click', () => {
    if (alertEditId) deleteAlert(alertEditId);
  });

  /* emoji seçici */
  $('#emojiClose').addEventListener('click', closeEmojiPicker);
  $('#emojiOverlay').addEventListener('click', (e) => { if (e.target === $('#emojiOverlay')) closeEmojiPicker(); });

  /* plan ayarları: RR kilidi + risk yüzdesi */
  $('#rrClose').addEventListener('click', closeRrDialog);
  $('#rrCancel').addEventListener('click', closeRrDialog);
  $('#rrOverlay').addEventListener('click', (e) => { if (e.target === $('#rrOverlay')) closeRrDialog(); });
  $('#rrOk').addEventListener('click', applyRrDialog);
  $('#rrFree').addEventListener('change', () => {
    /* işaret kalkarsa RR kilitlenir; işaretlenirse serbest bırakılır */
    $('#rrInput').disabled = false;
  });
  $('#rrInput').addEventListener('input', () => {
    /* elle RR yazıldıysa "serbest" kendiliğinden kalkar: yazılan değer kilitlenir */
    if ($('#rrFree').checked) $('#rrFree').checked = false;
  });
  $('#rrInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyRrDialog(); });
  $('#rrRisk').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyRrDialog(); });
  $('#rrMaxSpread').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyRrDialog(); });
  $('#rrLev').addEventListener('keydown', (e) => { if (e.key === 'Enter') applyRrDialog(); });
  $('#rrLevMax').addEventListener('click', async () => {
    const sym = rrLevSymbol();
    let mx = levMaxCache.sym === sym ? levMaxCache.max : 0;
    if (!(mx > 0)) {
      const r = await jev.exLeverageInfo({ symbol: sym }).catch(() => null);
      mx = r && r.ok && r.data ? Number(r.data.max) || 0 : 0;
      levMaxCache = { sym, max: mx };
    }
    if (mx > 0) {
      $('#rrLev').value = String(mx);
      toast('Kaldıraç: ' + mx + 'x (sembol maksimumu)');
    } else {
      toast('Maks kaldıraç alınamadı');
    }
  });

  /* işlem açma diyalogu */
  $('#orderClose').addEventListener('click', closeOrderDialog);
  $('#orderCancel').addEventListener('click', closeOrderDialog);
  $('#orderOverlay').addEventListener('click', (e) => { if (e.target === $('#orderOverlay')) closeOrderDialog(); });
  $('#orderOk').addEventListener('click', submitOrder);
  $('#orderVol').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitOrder();
    if (e.key === 'Escape') closeOrderDialog();
  });

  /* borsa seçici (Jev yanında: MT5 / Binance / OKX) */
  const exr = await jev.exGet().catch(() => null);
  exName = exr && exr.exchange ? exr.exchange : 'mt5';
  /* tek seferlik geçiş: eski (borsasız) sohbet kayıtları aktif borsaya atanır */
  let sessionsTagged = false;
  for (const s of sessions) { if (s && !s.ex) { s.ex = exName; sessionsTagged = true; } }
  if (sessionsTagged) saveSessions();
  /* borsanın kayıtlı sohbet LLM'i varsa uygula */
  await applyExModel(exName);
  updateExLabels();
  /* kripto seçiliyse sekmeler o borsaya ait: sekme setini yükle */
  if (exName !== 'mt5') {
    loadTabs();
    renderChartTabs();
    const t0 = activeTab();
    if (t0) {
      chartState.symbol = t0.symbol;
      chartState.tf = t0.tf;
      try {
        localStorage.setItem('jev.symbol', t0.symbol);
        localStorage.setItem('jev.tf', t0.tf);
      } catch {}
      const inp0 = $('#chartSymbol');
      if (inp0) inp0.value = t0.symbol;
      const list0 = tabSessions(activeTabId);
      activeSid = list0.length ? list0[list0.length - 1].id : '';
      renderSessions();
      renderMsgs();
    }
  }
  await refreshExPicker();
  $('#exBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('#exMenu');
    m.hidden = !m.hidden;
    updateExLabels();
  });
  $$('#exMenu .dd-item').forEach((b) => {
    b.addEventListener('click', async () => {
      $('#exMenu').hidden = true;
      await applyExchangeSwitch(b.dataset.ex);
    });
  });
  /* MT5 durum noktası: bağlı değilse tıklayınca köprü açılır — terminal kapalıysa
     YALNIZCA bu bilinçli tıklamada MT5 başlatılır (kendiliğinden açılmaz) */
  const mt5Dot = $('#mt5Dot');
  if (mt5Dot) mt5Dot.addEventListener('click', async () => {
    if (mt5Dot.classList.contains('on')) return;
    mt5Dot.title = exLabel() + ' bağlanıyor…';
    try { await jev.mt5Start(); } catch {}
    setTimeout(() => {
      jev.mt5Status().then((s) => updateMt5Dot(!!(s && s.connected))).catch(() => {});
    }, 2500);
  });
  document.addEventListener('click', (e) => {
    const dd = $('#exDD');
    if (dd && !dd.contains(e.target)) $('#exMenu').hidden = true;
  });

  /* Ctrl+C kopyala · Ctrl+V yapıştır · Ctrl+Z geri al */
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const tag = String((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!$('#textOverlay').hidden || !$('#alertsOverlay').hidden || !$('#settingsOverlay').hidden || !$('#colorOverlay').hidden || !$('#orderOverlay').hidden || !$('#rrOverlay').hidden || !$('#emojiOverlay').hidden || !$('#alertSetOverlay').hidden || !$('#jevSetOverlay').hidden || !$('#newsOverlay').hidden) return;
    const k = String(e.key || '').toLowerCase();
    if (k === 'c') { if (copySelected()) e.preventDefault(); }
    else if (k === 'v') { if (pasteClipboard()) e.preventDefault(); }
    else if (k === 'z') { e.preventDefault(); undoLast(); }
  });

  /* Del: seçili alarmı/planı/çizimi sil */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete') return;
    const tag = String((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!$('#textOverlay').hidden || !$('#alertsOverlay').hidden || !$('#settingsOverlay').hidden || !$('#colorOverlay').hidden || !$('#orderOverlay').hidden || !$('#rrOverlay').hidden || !$('#emojiOverlay').hidden || !$('#alertSetOverlay').hidden || !$('#jevSetOverlay').hidden || !$('#newsOverlay').hidden) return;
    if (eraseSelected()) e.preventDefault();
  });

  /* kısayollar: B long plan · S short plan · C kapat · X %50 · V BE · Esc iptal */
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = String((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!$('#textOverlay').hidden || !$('#alertsOverlay').hidden || !$('#settingsOverlay').hidden || !$('#colorOverlay').hidden || !$('#orderOverlay').hidden || !$('#rrOverlay').hidden || !$('#emojiOverlay').hidden || !$('#alertSetOverlay').hidden || !$('#jevSetOverlay').hidden || !$('#newsOverlay').hidden) return;
    const k = String(e.key || '').toLowerCase();
    if (k === 'escape') {
      if (groupLevelDrag) { groupLevelDrag = null; drawChart(); e.preventDefault(); return; }
      if (pane2.session) { pane2EndSession(); drawChart(); drawPane2(); e.preventDefault(); return; }
      if (chartState.pending.length || chartState.free || chartState.segDrag) {
        chartState.pending = [];
        chartState.free = null;
        chartState.segDrag = null;
        setDrawTool('cursor');
        e.preventDefault();
        return;
      }
      if (chartState.selected != null) { chartState.selected = null; drawChart(); e.preventDefault(); return; }
      if (selectedPosTicket || posGroupCycle.key) {
        selectedPosTicket = '';
        posGroupCycle = { key: '', idx: 0 };
        drawChart();
        e.preventDefault();
      }
      return;
    }
    if (k === 'b') { createTradePlan('long'); e.preventDefault(); return; }
    if (k === 's') { createTradePlan('short'); e.preventDefault(); return; }
    if (k === 'a') { togglePosBoxView(); e.preventDefault(); return; }
    if (!selectedPosTicket) return;
    const p = (chartState.positions || []).find((x) => String(x.ticket) === String(selectedPosTicket));
    if (!p) return;
    if (k === 'c') { quickClosePosition(p); e.preventDefault(); return; }
    if (k === 'x') { closePartialPosition(p, 0.5); e.preventDefault(); return; }
    if (k === 'v') { breakEvenPosition(p); e.preventDefault(); return; }
  });

  /* yeni sohbet */
  $('#newChat').addEventListener('click', () => newChatSession());

  /* slash komut yardımı */
  $('#slashClose').addEventListener('click', closeSlashHelp);
  $('#slashOverlay').addEventListener('click', (e) => { if (e.target === $('#slashOverlay')) closeSlashHelp(); });

  /* model dropdown */
  $('#modelBtn').addEventListener('click', () => {
    const menu = $('#modelMenu');
    $('#thinkMenu').hidden = true;
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      $('#modelFilter').value = '';
      renderModelMenu('');
      $('#modelFilter').focus();
    }
  });
  $('#modelFilter').addEventListener('input', (e) => renderModelMenu(e.target.value));
  /* düşünme seviyesi dropdown */
  $('#thinkBtn').addEventListener('click', () => {
    const menu = $('#thinkMenu');
    const willOpen = menu.hidden;
    $('#modelMenu').hidden = true;
    if (willOpen) {
      renderThinkMenu();
      menu.hidden = false;
    } else {
      menu.hidden = true;
    }
  });
  $('#modelRefreshBtn').addEventListener('click', (e) => {
    e.stopPropagation(); /* menü açıksa kapanmasın */
    refreshModelList().catch(() => {});
  });
  document.addEventListener('click', (e) => {
    if (!$('#modelDD').contains(e.target)) $('#modelMenu').hidden = true;
    if (!$('#thinkDD').contains(e.target)) $('#thinkMenu').hidden = true;
  });

  /* ayarlar */
  $('#gearBtn').addEventListener('click', openSettings);
  $('#setClose').addEventListener('click', closeSettings);
  $('#settingsOverlay').addEventListener('click', (e) => {
    if (e.target === $('#settingsOverlay')) closeSettings();
  });
  $$('.set-tabs-list .tab').forEach((t) =>
    t.addEventListener('click', () => switchTab(t.dataset.tab))
  );

  /* tema + pencere */
  $('#themeBtn').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme();
  });
  $('#winMin').addEventListener('click', () => jev.winMin());
  $('#winMax').addEventListener('click', () => jev.winMax());
  $('#winClose').addEventListener('click', () => jev.winClose());

  /* MT5 grafik */
  const t0 = activeTab();
  if (t0) {
    try {
      localStorage.setItem('jev.symbol', t0.symbol);
      localStorage.setItem('jev.tf', t0.tf);
      localStorage.setItem('jev.showLevels', t0.showLevels !== false ? '1' : '0');
      localStorage.setItem('jev.showOrdLevels', t0.showOrdLevels !== false ? '1' : '0');
      localStorage.setItem('jev.showAlertLevels', t0.showAlertLevels !== false ? '1' : '0');
      localStorage.setItem('jev.showVolume', t0.showVolume === true ? '1' : '0');
    } catch {}
  }
  chartInit();
  initUndoBase();
}

init();
