'use strict';

/* Beast SQUEEZE — kendi bağlam (token) sıkıştırıcımız. VARSAYILAN KAPALI.
   Her LLM isteğinden hemen önce mesaj dizisinin KOPYASINA uygulanır; oturum
   kaydı/geçmiş DEĞİŞMEZ. Harici kurulum/proxy yok.

   Kurallar:
   1) TEKRAR BLOK: Aynı büyük içerik (araç çıktısı / dosya eki / skill gövdesi)
      aynı bağlamda birden çok kez varsa YALNIZ İLK kopya tam gider; sonrakiler
      kısa işaretçiye iner. İlk kopya bağlamdan düşerse (compaction/bütçe) sonraki
      kopya kendiliğinden yeniden TAM gönderilir — "bağlam koptuysa yeniden" kuralı.
   2) ESKİ ARAÇ ÇIKTISI: Son N araç sonucu birebir; daha eskiler başlık + baş/son
      önizleme + "gerekirse tekrar çalıştır/oku" notu olarak sıkıştırılır.
      Her dosyanın EN SON read_file sonucu asla sıkıştırılmaz (dosya hafızası).
   3) SKILL: Aynı skill gövdesi tekrarlıysa eski kopyalar stub'a iner; tek kopya tam.
   4) DOKUNULMAZLAR: system, son tur birimleri, assistant mesajları, zaten
      sıkıştırılmış içerik (idempotans) ve minBlockChars'tan küçük bloklar. */

const crypto = require('crypto');
const { estMsgTokens } = require('./tokens');

const DEFAULTS = {
  minTotalTokens: 1500,
  minBlockChars: 700,
  minUserCompactChars: 12000,
  keepRecentTools: 0,
  keepRecentUnits: 4,
  protectReadsWindow: 8,
  previewHead: 700,
  previewTail: 250,
};

const MARK = '[squeeze:';

const state = {
  enabled: false,
  stats: {
    calls: 0,
    changedCalls: 0,
    savedTokens: 0,
    lastBeforeTokens: 0,
    lastAfterTokens: 0,
    lastSavedTokens: 0,
    deduped: 0,
    compactedTools: 0,
    compactedSkills: 0,
    compactedUsers: 0,
  },
};

function setEnabled(on) {
  state.enabled = !!on;
}

function isEnabled() {
  return state.enabled;
}

function resetStats() {
  for (const k of Object.keys(state.stats)) state.stats[k] = 0;
}

function getStats() {
  const s = { ...state.stats };
  s.lastPercent =
    s.lastBeforeTokens > 0 ? Math.round((s.lastSavedTokens / s.lastBeforeTokens) * 100) : 0;
  return s;
}

function _hash(s) {
  try {
    return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
  } catch {
    return String(s.length) + ':' + String(s.charCodeAt(0) || 0);
  }
}

function _isSqueezed(content) {
  return typeof content === 'string' && content.includes(MARK);
}

/* assistant(tool_calls) + ardışık tool sonuçlarını BÖLMEYEN birimler (indis) */
function _indexUnits(messages) {
  const units = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m && m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      const grp = [i];
      i++;
      while (i < messages.length && messages[i] && messages[i].role === 'tool') grp.push(i++);
      units.push(grp);
    } else {
      units.push([i]);
      i++;
    }
  }
  return units;
}

/* tool_call_id → {name, args} (assistant mesajlarındaki çağrılardan) */
function _toolCallMap(messages) {
  const map = new Map();
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (!tc || !tc.id) continue;
      let args = {};
      try {
        args = JSON.parse((tc.function && tc.function.arguments) || '{}');
      } catch {}
      map.set(String(tc.id), {
        name: String((tc.function && tc.function.name) || ''),
        args,
      });
    }
  }
  return map;
}

function _readTarget(args) {
  if (!args || typeof args !== 'object') return '';
  for (const k of ['file_path', 'path', 'file', 'filename', 'filePath', 'target']) {
    if (args[k]) return String(args[k]);
  }
  return '';
}

function _pointerFor(role, name) {
  if (role === 'tool') {
    return (
      MARK + ' bu araç çıktısı yukarıdaki' + (name ? " '" + name + "'" : '') +
      ' sonucuyla BİREBİR AYNI — tekrar gönderilmedi]'
    );
  }
  return MARK + ' bu içerik yukarıda TAM gönderildi — tekrar gönderilmedi]';
}

function _skillStub(raw) {
  let name = '';
  try {
    const j = JSON.parse(raw);
    name = String(j.name || j.skill || '');
  } catch {}
  return (
    '{"ok":true,"name":"' + name.replace(/"/g, '') + '",' +
    '"content":"' + MARK + ' bu skill gövdesi yukarıda tam yüklendi — tekrar gönderilmedi]"}'
  );
}

function _compactPreview(content, cfg, label, hint) {
  const len = content.length;
  const headLen = Math.min(cfg.previewHead, Math.max(260, Math.floor(len * 0.4)));
  const tailLen = len - headLen > 400 ? Math.min(cfg.previewTail, Math.floor(len * 0.15)) : 0;
  const head = content.slice(0, headLen);
  const tail = tailLen > 0 ? content.slice(-tailLen) : '';
  const note = '\n' + MARK + ' ' + label + ' sıkıştırıldı: ' + len + ' karakter → önizleme. ' + hint + ']\n';
  return tail ? head + note + tail : head + note;
}

/* messages: OpenAI-uyumlu mesaj dizisi. Dönüş: (gerekirse) yeni dizi.
   Kapalıyken aynı referans döner; açıkken de değişiklik yoksa orijinal döner. */
function apply(messages, opts = {}) {
  if (!state.enabled || !Array.isArray(messages) || messages.length < 2) return messages;

  const cfg = { ...DEFAULTS, ...(opts.config || {}) };
  const beforeTokens = messages.reduce((a, m) => a + estMsgTokens(m), 0);
  state.stats.calls++;
  state.stats.lastBeforeTokens = beforeTokens;
  state.stats.lastAfterTokens = beforeTokens;
  state.stats.lastSavedTokens = 0;
  if (beforeTokens < cfg.minTotalTokens) return messages;

  const out = messages.slice();
  let touched = false;
  const replace = (i, msg) => {
    out[i] = msg;
    touched = true;
  };

  const units = _indexUnits(messages);
  const protectFrom = Math.max(1, units.length - cfg.keepRecentUnits);
  const protectedIdx = new Set([0]);
  for (let u = protectFrom; u < units.length; u++) {
    for (const i of units[u]) protectedIdx.add(i);
  }
  /* son N araç sonucu birebir kalır */
  const toolIdx = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i].role === 'tool') toolIdx.push(i);
  }
  if (cfg.keepRecentTools > 0) {
    for (const i of toolIdx.slice(-cfg.keepRecentTools)) protectedIdx.add(i);
  }

  const meta = _toolCallMap(messages);
  const toolName = (i) => {
    const m = messages[i];
    const fromCall = m && m.tool_call_id ? meta.get(String(m.tool_call_id)) : null;
    return String((m && m.name) || (fromCall && fromCall.name) || '');
  };

  /* her dosyanın EN SON okuması, yakın penceredeyse korunur */
  const protectReadsFrom =
    toolIdx.length > cfg.protectReadsWindow
      ? toolIdx[toolIdx.length - cfg.protectReadsWindow]
      : (toolIdx[0] ?? Infinity);
  const latestRead = new Map();
  for (const i of toolIdx) {
    const m = messages[i];
    if (!m || String(m.name || '') !== 'read_file') continue;
    const info = m.tool_call_id ? meta.get(String(m.tool_call_id)) : null;
    const target = _readTarget(info && info.args) || '__last__';
    latestRead.set(target, i);
  }

  let deduped = 0;
  let compactedTools = 0;
  let compactedSkills = 0;
  let compactedUsers = 0;

  /* 1) SKILL gövde tekrarı: aynı skill'in eski kopyaları stub'a iner */
  const skillSeen = new Set();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'tool' || toolName(i) !== 'skill') continue;
    if (typeof m.content !== 'string' || _isSqueezed(m.content)) continue;
    let key = '';
    try {
      const j = JSON.parse(m.content);
      key = String(j.name || j.skill || '');
    } catch {}
    if (!key) key = _hash(m.content);
    if (skillSeen.has(key)) {
      replace(i, { ...m, content: _skillStub(m.content) });
      compactedSkills++;
    } else {
      skillSeen.add(key);
    }
  }

  /* 2) GENEL tekrar bloğu: ilk kopya tam, sonrakiler işaretçi (korumalılar hariç) */
  const seen = new Map();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role === 'system' || m.role === 'assistant') continue;
    if (typeof m.content !== 'string') continue;
    if (m.content.length < cfg.minBlockChars || _isSqueezed(m.content)) continue;
    const role = m.role === 'tool' ? 'tool' : 'user';
    const key = role + ':' + _hash(m.content);
    if (seen.has(key)) {
      /* birebir aynı içerik: en son mesaj (güncel tur) hariç her yerde
         işaretçiye inebilir — içerik zaten aynı bağlamda tam duruyor */
      if (i === messages.length - 1) continue;
      replace(i, { ...out[i], content: _pointerFor(role, toolName(i)) });
      deduped++;
    } else {
      seen.set(key, i);
    }
  }

  /* 3) ESKİ ARAÇ ÇIKTISI: başlık + baş/son önizleme */
  for (const i of toolIdx) {
    if (protectedIdx.has(i)) continue;
    const m = out[i];
    if (!m || typeof m.content !== 'string' || _isSqueezed(m.content)) continue;
    if (m.content.length < cfg.minBlockChars) continue;
    const name = toolName(i);
    if (name === 'skill') continue;
    if (name === 'read_file') {
      const info = m.tool_call_id ? meta.get(String(m.tool_call_id)) : null;
      const target = _readTarget(info && info.args) || '__last__';
      if (latestRead.get(target) === i && i >= protectReadsFrom) continue;
    }
    const hint =
      name === 'read_file'
        ? 'Tam içerik diskte duruyor; gerekirse read_file ile tekrar oku'
        : 'Gerekirse ' + (name || 'araç') + ' ile tekrar çalıştır';
    replace(i, { ...m, content: _compactPreview(m.content, cfg, "'" + (name || 'araç') + "'", hint) });
    compactedTools++;
  }

  /* 4) ESKİ BÜYÜK KULLANICI İÇERİĞİ (dosya eki vb.): baş/son önizleme */
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'user' || protectedIdx.has(i) || i === 0) continue;
    if (typeof m.content !== 'string' || _isSqueezed(m.content)) continue;
    if (m.content.length < cfg.minUserCompactChars) continue;
    if (m.content.startsWith('[ÖNCEKİ KONUŞMANIN ÖZETİ')) continue;
    replace(i, {
      ...m,
      content: _compactPreview(m.content, cfg, 'kullanıcı içeriği', 'Tam içerik oturum kaydında duruyor'),
    });
    compactedUsers++;
  }

  if (!touched) return messages;

  const afterTokens = out.reduce((a, m) => a + estMsgTokens(m), 0);
  const saved = Math.max(0, beforeTokens - afterTokens);
  state.stats.lastAfterTokens = afterTokens;
  state.stats.lastSavedTokens = saved;
  state.stats.savedTokens += saved;
  state.stats.deduped += deduped;
  state.stats.compactedTools += compactedTools;
  state.stats.compactedSkills += compactedSkills;
  state.stats.compactedUsers += compactedUsers;
  if (saved > 0) state.stats.changedCalls++;
  return out;
}

module.exports = { apply, setEnabled, isEnabled, getStats, resetStats, MARK };
