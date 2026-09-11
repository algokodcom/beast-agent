'use strict';

/* BEAST Skills — statik mağaza arayüzü.
   Veri: builtins.json (yerleşikler) + store/skills.json (topluluk, GitHub raw).
   Tasarım: Beast Agent sitesi ile aynı monokrom tema; tüm ikonlar SVG sprite. */

const I18N = {
  tr: {
    nav_store: 'Mağaza', nav_how: 'Nasıl kurulur', kicker: 'Resmî Yetenek Mağazası',
    hero_sub: "Beast Agent'ın resmî yetenek mağazası. Yerleşik skill'ler ve topluluk paylaşımları — ara, içeriğini incele, Beast Agent içindeki Skills Store'dan tek tıkla kur.",
    copy: 'Kopyala', browse: 'Mağazaya göz at', copied: 'Kopyalandı', cmd_comment: '# Beast Agent kurulumu',
    stat_skills: 'yetenek', stat_builtin: 'yerleşik', stat_installs: 'kurulum', stat_authors: 'yayıncı',
    catalog_title: 'Yetenek Mağazası',
    catalog_sub: 'Her skill kendi SKILL.md rehberiyle gelir — ajan gerektiğinde okuyup uygular.',
    search_ph: 'Skill ara… (örn: pdf, finans, test)',
    src_all: 'Tümü', src_community: 'Topluluk', src_builtin: 'Yerleşik', src_saved: 'Kaydedilenler',
    sort: 'Sırala', sort_featured: 'Öne çıkanlar', sort_trending: 'Trending', sort_stars: 'Stars', sort_new: 'Yeni', sort_name: 'A → Z',
    res_skills: 'yetenek listeleniyor',
    empty_title: 'Eşleşen skill yok',
    empty_sub: 'Aramayı temizleyip tekrar dene ya da tüm listeye dön.',
    empty_saved: 'Henüz skill kaydetmedin — kartlardaki yıldız ile işaretle.',
    empty_community: 'Topluluk mağazası henüz boş — ilk skill\'i sen yükle!',
    empty_reset: 'Filtreleri temizle',
    how_title: 'Beast Agent\'a nasıl kurulur?',
    how_sub: 'Bu mağaza, uygulamanın içindeki Skills Store ile aynı indeksi kullanır — burada bulduğun skill\'i saniyeler içinde kur.',
    how_1_t: 'Beast Agent\'ı kur',
    how_1_b: 'Terminalde tek komut: npm install -g beast-agent. Windows için Node.js yeterli — ek kurulum yok.',
    how_2_t: 'Skills Store\'u aç',
    how_2_b: 'Uygulamada üst bardaki mağaza düğmesine bas — Trending / Stars / Upload sekmeleri seni bekliyor.',
    how_3_t: 'Bul ve “İste Kur”',
    how_3_b: 'Skill\'i ara, İste Kur\'a bas. Ajan o yeteneği anında kullanmaya başlar — restart gerekmez.',
    publish_t: 'Kendi skill\'ini yayınla',
    publish_b: 'Beast Agent → Skills Store → Upload sekmesinden klasörünü (SKILL.md zorunlu) yükle; JSON\'unu GitHub issue/PR ile <b>store/skills.json</b> dosyasına ekle. Topluluk burada ve uygulama içinde görür.',
    publish_cta: 'GitHub\'da paylaş',
    badge_builtin: 'Yerleşik', badge_community: 'Topluluk',
    installs: 'kurulum', likes: 'beğeni', lines: 'satır', builtin_note: 'Kurulum gerekmez, ajanla gelir',
    side_about: 'Açıklama', side_tags: 'Etiketler', side_files: 'Dosyalar', side_stats: 'İstatistik',
    side_install: 'Kurulum', install_1: 'Beast Agent\'ı aç', install_2: 'Skills Store → ara:',
    install_3: '“İste Kur”a bas — ajan anında kullanır.',
    install_builtin: 'Bu yetenek Beast Agent ile birlikte gelir; ayrıca kurulum gerekmez — ajan gerektiğinde otomatik okur.',
    copy_id: 'Adı kopyala', copy_link: 'Bağlantıyı kopyala', save: 'Kaydet', saved_btn: 'Kaydedildi',
    open_github: 'GitHub\'da aç', loading: 'Yükleniyor…', no_files: 'Dosya yok',
    offline: 'Topluluk indeksine ulaşılamadı — yerel kopya gösteriliyor.',
    offline_hard: 'Topluluk indeksine ulaşılamadı (offline) — yalnız yerleşik yetenekler gösteriliyor.',
    toast_saved: 'Kaydedildi', toast_unsaved: 'Kaydedilenlerden çıkarıldı', toast_link: 'Bağlantı kopyalandı',
  },
  en: {
    nav_store: 'Store', nav_how: 'How to install', kicker: 'Official Skill Store',
    hero_sub: "The official Beast Agent skill store. Built-in skills and community submissions — search, inspect, install with one click from the Skills Store inside Beast Agent.",
    copy: 'Copy', browse: 'Browse the store', copied: 'Copied', cmd_comment: '# Install Beast Agent',
    stat_skills: 'skills', stat_builtin: 'built-in', stat_installs: 'installs', stat_authors: 'publishers',
    catalog_title: 'Skill Store',
    catalog_sub: 'Every skill ships with its own SKILL.md guide — the agent reads and applies it on demand.',
    search_ph: 'Search skills… (e.g. pdf, finance, test)',
    src_all: 'All', src_community: 'Community', src_builtin: 'Built-in', src_saved: 'Saved',
    sort: 'Sort', sort_featured: 'Featured', sort_trending: 'Trending', sort_stars: 'Stars', sort_new: 'New', sort_name: 'A → Z',
    res_skills: 'skills listed',
    empty_title: 'No matching skills',
    empty_sub: 'Clear the search or return to the full list.',
    empty_saved: 'No saved skills yet — use the star on a card.',
    empty_community: 'The community store is empty — be the first to upload!',
    empty_reset: 'Clear filters',
    how_title: 'How to install into Beast Agent?',
    how_sub: 'This store uses the same index as the in-app Skills Store — install what you find here in seconds.',
    how_1_t: 'Install Beast Agent',
    how_1_b: 'One command in your terminal: npm install -g beast-agent. Node.js is all you need on Windows.',
    how_2_t: 'Open the Skills Store',
    how_2_b: 'Click the store button in the app header — Trending / Stars / Upload await.',
    how_3_t: 'Find it, hit “Install”',
    how_3_b: 'Search the skill and install — the agent can use it immediately, no restart.',
    publish_t: 'Publish your own skill',
    publish_b: 'Upload your folder (SKILL.md required) from Beast Agent → Skills Store → Upload; add its JSON to <b>store/skills.json</b> via a GitHub issue/PR. The community sees it here and in-app.',
    publish_cta: 'Share on GitHub',
    badge_builtin: 'Built-in', badge_community: 'Community',
    installs: 'installs', likes: 'likes', lines: 'lines', builtin_note: 'No install needed, ships with the agent',
    side_about: 'Description', side_tags: 'Tags', side_files: 'Files', side_stats: 'Stats',
    side_install: 'Install', install_1: 'Open Beast Agent', install_2: 'Skills Store → search:',
    install_3: 'Hit “Install” — the agent uses it immediately.',
    install_builtin: 'This skill ships with Beast Agent; no installation needed — the agent reads it automatically.',
    copy_id: 'Copy name', copy_link: 'Copy link', save: 'Save', saved_btn: 'Saved',
    open_github: 'Open on GitHub', loading: 'Loading…', no_files: 'No files',
    offline: 'Community index unreachable — showing local copy.',
    offline_hard: 'Community index unreachable (offline) — showing built-in skills only.',
    toast_saved: 'Saved', toast_unsaved: 'Removed from saved', toast_link: 'Link copied',
  },
};

const COMMUNITY_URLS = [
  'https://raw.githubusercontent.com/algokodcom/beast-agent/main/store/skills.json',
  './community.json',
];
const REPO = 'https://github.com/algokodcom/beast-agent';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  entries: [],
  q: '',
  src: 'all',
  tag: '',
  sort: 'featured',
  lang: localStorage.getItem('ba-lang') || 'tr',
  saved: new Set(JSON.parse(localStorage.getItem('beast.skillbook') || '[]')),
  offline: false,
  offlineHard: false,
};

function t(key) {
  return (I18N[state.lang] && I18N[state.lang][key]) || I18N.tr[key] || key;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return (v / 1000000).toFixed(v >= 10000000 ? 0 : 1).replace('.', ',') + 'M';
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace('.', ',') + 'B';
  return String(v);
}

function ageDays(iso) {
  const ts = new Date(iso || 0).getTime();
  return Number.isFinite(ts) ? Math.max(0, (Date.now() - ts) / 86400000) : 0;
}

function trendingScore(e) {
  const heat = (e.installs || 0) + (e.likes || 0) * 2;
  return heat / Math.sqrt(1 + ageDays(e.updatedAt || e.createdAt));
}

function starsScore(e) {
  const total = (e.installs || 0) + (e.likes || 0) * 3;
  return ageDays(e.createdAt) >= 14 ? total : total * 0.2;
}

function icon(id, cls) {
  return `<svg class="ic ${cls || ''}" aria-hidden="true"><use href="#i-${esc(id)}"/></svg>`;
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 200);
  }, 1800);
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg || t('copied'));
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast(okMsg || t('copied'));
      return true;
    } catch {
      return false;
    }
  }
}

/* ---------------- veri ---------------- */

function normalizeBuiltin(e) {
  return {
    ...e,
    source: 'builtin',
    installs: 0,
    likes: 0,
    author: { username: 'beast', avatar: '' },
    tags: Array.isArray(e.tags) ? e.tags : [],
    files: e.files || {},
  };
}

function normalizeCommunity(e) {
  return {
    ...e,
    source: 'community',
    id: String(e.id || ''),
    name: String(e.name || e.id || ''),
    version: String(e.version || '1.0.0'),
    description: String(e.description || ''),
    tags: Array.isArray(e.tags) ? e.tags.map((x) => String(x).toLowerCase()) : [],
    author: e.author || {},
    files: e.files || {},
    installs: Number(e.installs) || 0,
    likes: Number(e.likes) || 0,
  };
}

function normalizeList(j) {
  return (j && Array.isArray(j.skills) ? j.skills : [])
    .map(normalizeCommunity)
    .filter((e) => e.id && e.files['SKILL.md']);
}

async function fetchJson(url, timeoutMs = 7000) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl && ctl.abort(); } catch {} }, timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl ? ctl.signal : undefined, cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadAll() {
  let builtins = [];
  try {
    const b = await fetchJson('./builtins.json');
    builtins = (b && Array.isArray(b.skills) ? b.skills : []).map(normalizeBuiltin);
  } catch {}

  let community = [];
  try {
    community = normalizeList(await fetchJson(COMMUNITY_URLS[0]));
  } catch {
    state.offline = true;
    try {
      community = normalizeList(await fetchJson(COMMUNITY_URLS[1]));
    } catch {
      state.offlineHard = true;
    }
  }

  const byId = new Map();
  for (const e of community) byId.set(e.id, e);
  for (const e of builtins) if (!byId.has(e.id)) byId.set(e.id, e);
  state.entries = [...byId.values()];
}

/* ---------------- dil / tema ---------------- */

function applyLang() {
  document.documentElement.lang = state.lang;
  const dict = I18N[state.lang] || I18N.tr;
  $$('[data-i18n]').forEach((el) => {
    const v = dict[el.dataset.i18n] || I18N.tr[el.dataset.i18n];
    if (v != null) el.innerHTML = v;
  });
  $$('[data-i18n-placeholder]').forEach((el) => {
    const v = dict[el.dataset.i18nPlaceholder] || I18N.tr[el.dataset.i18nPlaceholder];
    if (v != null) el.placeholder = v;
  });
  $$('[data-i18n-title]').forEach((el) => {
    const v = dict[el.dataset.i18nTitle] || I18N.tr[el.dataset.i18nTitle];
    if (v != null) el.title = v;
  });
  document.title = state.lang === 'tr'
    ? 'BEAST Skills — Beast Agent Yetenek Mağazası'
    : 'BEAST Skills — Beast Agent Skill Store';
}

function applyTheme() {
  const dark = (localStorage.getItem('ba-theme') || 'dark') !== 'light';
  document.body.classList.toggle('dark', dark);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#0d0d0f' : '#f7f7f8';
}

/* ---------------- kartlar ---------------- */

function skillIcon(e) {
  if (e.image && /^data:image\//.test(e.image)) return `<img src="${e.image}" alt=""/>`;
  return icon(e.icon || 'grid');
}

function authorAvatar(a, builtin) {
  if (builtin) return icon('paw');
  const av = a && a.avatar ? String(a.avatar) : '';
  if (av && av.length <= 3 && /[^\x00-\x7F]/.test(av)) return `<span aria-hidden="true">${esc(av)}</span>`;
  return icon('user');
}

function cardHtml(e) {
  const saved = state.saved.has(e.id);
  const builtin = e.source === 'builtin';
  const author = e.author || {};
  const lines = (e.lines || String((e.files && e.files['SKILL.md']) || e.body || '').split(/\r?\n/).length);
  const stats = builtin
    ? `<span>${icon('box')} ${t('builtin_note')}</span>`
    : `<span>${icon('download')} ${fmt(e.installs)} ${t('installs')}</span><span>${icon('heart')} ${fmt(e.likes)} ${t('likes')}</span>`;
  return `
  <article class="skill-card" data-id="${esc(e.id)}" tabindex="0" role="button" aria-label="${esc(e.name)}">
    <div class="skill-top">
      <span class="skill-icon">${skillIcon(e)}</span>
      <div class="skill-id">
        <div class="skill-name"><span class="nm">${esc(e.name)}</span> <span class="ver">v${esc(e.version)}</span></div>
        <div class="skill-author">${authorAvatar(author, builtin)}<b>${esc(builtin ? 'beast' : (author.username || '—'))}</b>${!builtin && author.beastId ? `<span>· ${esc(String(author.beastId).slice(0, 13))}</span>` : ''}</div>
      </div>
      <button class="save-btn ${saved ? 'on' : ''}" data-save="${esc(e.id)}" title="${saved ? t('saved_btn') : t('save')}" aria-label="${t('save')}">${icon(saved ? 'star-fill' : 'star')}</button>
    </div>
    <div class="skill-desc">${esc(e.description)}</div>
    ${e.tags.length ? `<div class="skill-tags">${e.tags.slice(0, 4).map((tg) => `<span class="t">#${esc(tg)}</span>`).join('')}</div>` : ''}
    <div class="skill-foot">
      ${stats}
      <span class="go">${icon('arrow-right')}</span>
    </div>
  </article>`;
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  const list = state.entries.filter((e) => {
    if (state.src === 'community' && e.source !== 'community') return false;
    if (state.src === 'builtin' && e.source !== 'builtin') return false;
    if (state.src === 'saved' && !state.saved.has(e.id)) return false;
    if (state.tag && !e.tags.includes(state.tag)) return false;
    if (q) {
      const hay = (e.name + ' ' + e.description + ' ' + e.tags.join(' ') + ' ' + ((e.author && e.author.username) || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const sorters = {
    featured: (a, b) => {
      if ((a.source === 'community') !== (b.source === 'community')) return a.source === 'community' ? -1 : 1;
      return trendingScore(b) - trendingScore(a);
    },
    trending: (a, b) => trendingScore(b) - trendingScore(a),
    stars: (a, b) => starsScore(b) - starsScore(a),
    new: (a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')),
    name: (a, b) => a.name.localeCompare(b.name, 'tr'),
  };
  return list.sort(sorters[state.sort] || sorters.featured);
}

function renderStats() {
  const installs = state.entries.reduce((a, e) => a + (e.installs || 0), 0);
  const authors = new Set(state.entries.filter((e) => e.source === 'community').map((e) => (e.author || {}).username).filter(Boolean));
  const builtins = state.entries.filter((e) => e.source === 'builtin').length;
  $('#statSkills').textContent = fmt(state.entries.length);
  $('#statBuiltin').textContent = fmt(builtins);
  $('#statInstalls').textContent = fmt(installs);
  $('#statAuthors').textContent = fmt(authors.size);
}

function renderTags() {
  const bar = $('#tagbar');
  const counts = new Map();
  for (const e of state.entries) for (const tg of e.tags) counts.set(tg, (counts.get(tg) || 0) + 1);
  const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'tr')).slice(0, 14);
  if (!tags.length) { bar.innerHTML = ''; return; }
  bar.innerHTML = tags.map(([tg, n]) =>
    `<button class="tag ${state.tag === tg ? 'active' : ''}" data-tag="${esc(tg)}">#${esc(tg)} <span style="opacity:.55">${n}</span></button>`
  ).join('');
  $$('#tagbar .tag').forEach((b) => b.addEventListener('click', () => {
    state.tag = state.tag === b.dataset.tag ? '' : b.dataset.tag;
    renderTags(); renderGrid();
  }));
}

function renderGrid() {
  const grid = $('#grid');
  const list = filtered();
  $('#resultLine').textContent = `${list.length} ${t('res_skills')}`;
  if (!list.length) {
    grid.innerHTML = '';
    const empty = $('#empty');
    empty.hidden = false;
    if (state.src === 'saved') {
      $('#emptyTitle').textContent = t('empty_saved');
      $('#emptySub').textContent = t('empty_sub');
    } else if (state.src === 'community' && !state.entries.some((e) => e.source === 'community')) {
      $('#emptyTitle').textContent = t('empty_community');
      $('#emptySub').textContent = t('catalog_sub');
    } else {
      $('#emptyTitle').textContent = t('empty_title');
      $('#emptySub').textContent = t('empty_sub');
    }
    return;
  }
  $('#empty').hidden = true;
  grid.innerHTML = list.map(cardHtml).join('');
  $$('#grid .skill-card').forEach((card) => {
    card.addEventListener('click', () => openModal(card.dataset.id));
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openModal(card.dataset.id); } });
  });
  $$('#grid [data-save]').forEach((btn) => btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleSave(btn.dataset.save);
  }));
}

function toggleSave(id) {
  if (state.saved.has(id)) state.saved.delete(id);
  else state.saved.add(id);
  localStorage.setItem('beast.skillbook', JSON.stringify([...state.saved]));
  toast(state.saved.has(id) ? t('toast_saved') : t('toast_unsaved'));
  renderGrid();
}

/* ---------------- modal ---------------- */

function findEntry(id) {
  return state.entries.find((e) => e.id === id) || null;
}

function skillBody(e) {
  const raw = (e.files && e.files['SKILL.md']) || e.body || '';
  return String(raw).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}

function renderMd(src) {
  const lines = esc(src).split(/\r?\n/);
  const out = [];
  let i = 0;
  const isTableSep = (s) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(s);
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const code = buf.join('\n');
      out.push(`<pre><span class="lang">${esc(lang)}</span><button class="copy-code chip-btn" data-code="${encodeURIComponent(code)}">${icon('copy')}</button><code>${code}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr/>'); i++; continue; }
    if (/^\s*&gt;\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
      out.push(`<blockquote>${buf.map(inlineMd).join('<br/>')}</blockquote>`);
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const cells = (s) => s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        '<table><thead><tr>' + head.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>'
      );
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      out.push('<ul>' + items.map((x) => `<li>${inlineMd(x)}</li>`).join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      out.push('<ol>' + items.map((x) => `<li>${inlineMd(x)}</li>`).join('') + '</ol>');
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,4}\s|```|[-*+]\s|\d+[.)]\s|&gt;\s?|-\s*$|\|)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inlineMd(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

function outboundGithub(e) {
  if (e.source === 'community') return `${REPO}/blob/main/store/skills.json`;
  return `${REPO}/blob/main/${e.repoPath || 'src/agent/skills.js'}`;
}

function openModal(id) {
  const e = findEntry(id);
  if (!e) return;
  const builtin = e.source === 'builtin';
  const author = e.author || {};
  const files = Object.keys(e.files || {});
  const saved = state.saved.has(e.id);
  const bodyText = skillBody(e);

  $('#mHead').innerHTML = `
    <div class="m-icon">${skillIcon(e)}</div>
    <div style="min-width:0">
      <h2 id="mTitle"><span>${esc(e.name)}</span> <span class="ver">v${esc(e.version)}</span></h2>
      <div class="m-sub">
        <span>${authorAvatar(author, builtin)} ${esc(builtin ? 'beast' : (author.username || '—'))}${!builtin && author.beastId ? ' · ' + esc(author.beastId) : ''}</span>
        <span>· ${builtin ? t('badge_builtin') : t('badge_community')}</span>
      </div>
    </div>`;

  $('#mSide').innerHTML = `
    <div class="side-box">
      <h4>${t('side_about')}</h4>
      <p>${esc(e.description)}</p>
    </div>
    ${e.tags.length ? `<div class="side-box"><h4>${t('side_tags')}</h4><div class="side-tags">${e.tags.map((tg) => `<span class="t">#${esc(tg)}</span>`).join('')}</div></div>` : ''}
    <div class="side-box">
      <h4>${t('side_files')}</h4>
      <div class="side-files">${files.length ? files.map((f) => `<span>${icon('file')} ${esc(f)}</span>`).join('') : `<span>${t('no_files')}</span>`}</div>
    </div>
    <div class="side-box">
      <h4>${t('side_stats')}</h4>
      <div class="side-stats">
        ${builtin
          ? `<span>${icon('box')} <b>${t('badge_builtin')}</b></span>`
          : `<span>${icon('download')} <b>${fmt(e.installs)}</b> ${t('installs')}</span><span>${icon('heart')} <b>${fmt(e.likes)}</b> ${t('likes')}</span>`}
        <span>${icon('file-text')} <b>${bodyText.split(/\r?\n/).length}</b> ${t('lines')}</span>
      </div>
    </div>
    <div class="side-box">
      <h4>${t('side_install')}</h4>
      <div class="install-box">
        ${builtin ? `<p>${t('install_builtin')}</p>` : `
        <ol>
          <li>${t('install_1')}</li>
          <li>${t('install_2')} <b>${esc(e.name)}</b></li>
          <li>${t('install_3')}</li>
        </ol>`}
      </div>
    </div>
    <div class="side-actions">
      <button class="btn ghost" id="mCopyName">${icon('copy')} ${t('copy_id')}</button>
      <button class="btn ghost" id="mCopyLink">${icon('link')} ${t('copy_link')}</button>
      <button class="btn ${saved ? 'solid' : 'ghost'}" id="mSave">${icon(saved ? 'star-fill' : 'star')} ${saved ? t('saved_btn') : t('save')}</button>
      <a class="btn ghost" href="${outboundGithub(e)}" target="_blank" rel="noopener">${icon('external')} ${t('open_github')}</a>
    </div>`;

  $('#mBody').innerHTML = renderMd(bodyText) || `<p>${t('no_files')}</p>`;
  $('#modal').hidden = false;
  document.body.style.overflow = 'hidden';
  if (location.hash !== '#skill-' + e.id) history.replaceState(null, '', '#skill-' + e.id);

  $('#mCopyName').addEventListener('click', () => copyText(e.name, t('toast_link')));
  $('#mCopyLink').addEventListener('click', () => copyText(location.href, t('toast_link')));
  $('#mSave').addEventListener('click', () => { toggleSave(e.id); openModal(e.id); });
  $$('#mBody .copy-code').forEach((b) => b.addEventListener('click', () => copyText(decodeURIComponent(b.dataset.code || ''))));
  $('#modal').querySelector('.modal-main').scrollTop = 0;
}

function closeModal() {
  $('#modal').hidden = true;
  document.body.style.overflow = '';
  if (location.hash.startsWith('#skill-')) history.replaceState(null, '', location.pathname + location.search);
}

/* ---------------- olaylar ---------------- */

function bind() {
  $('#themeBtn').addEventListener('click', () => {
    const dark = document.body.classList.toggle('dark');
    localStorage.setItem('ba-theme', dark ? 'dark' : 'light');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#0d0d0f' : '#f7f7f8';
  });
  $('#langBtn').addEventListener('click', () => {
    state.lang = state.lang === 'tr' ? 'en' : 'tr';
    localStorage.setItem('ba-lang', state.lang);
    applyLang(); renderGrid(); renderTags();
  });
  $('#copyCmd').addEventListener('click', (ev) => {
    copyText('npm install -g beast-agent', t('copied'));
    const b = ev.currentTarget;
    b.classList.add('ok');
    setTimeout(() => b.classList.remove('ok'), 1200);
  });
  $('#q').addEventListener('input', (ev) => { state.q = ev.target.value; renderGrid(); });
  $('#sort').addEventListener('change', (ev) => { state.sort = ev.target.value; renderGrid(); });
  $$('#sourceChips .chip-btn').forEach((chip) => chip.addEventListener('click', () => {
    state.src = chip.dataset.src;
    $$('#sourceChips .chip-btn').forEach((c) => c.classList.toggle('active', c === chip));
    renderGrid();
  }));
  $('#emptyReset').addEventListener('click', () => {
    state.q = ''; state.tag = ''; state.src = 'all';
    $('#q').value = '';
    $$('#sourceChips .chip-btn').forEach((c) => c.classList.toggle('active', c.dataset.src === 'all'));
    renderTags(); renderGrid();
  });
  $('#topBtn').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  $$('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeModal();
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') { ev.preventDefault(); $('#q').focus(); }
  });
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#skill-')) openModal(location.hash.slice(7));
    else closeModal();
  });
  $$('a[href^="#"]').forEach((a) => a.addEventListener('click', (ev) => {
    const id = a.getAttribute('href').slice(1);
    if (!id) return;
    const el = document.getElementById(id);
    if (el) { ev.preventDefault(); el.scrollIntoView({ behavior: 'smooth' }); }
  }));
}

async function boot() {
  applyTheme();
  applyLang();
  $('#grid').innerHTML = `<div class="loading">${t('loading')}</div>`;
  bind();
  await loadAll();
  renderStats();
  renderTags();
  renderGrid();
  if (location.hash.startsWith('#skill-')) openModal(location.hash.slice(7));
  if (state.offlineHard) toast(t('offline_hard'));
  else if (state.offline) toast(t('offline'));
}

boot();
