'use strict';

/* Beast gece yansıması (night reflection): her gece otomatik hafıza+öğrenme bakımı.
   Kullanıcının istediği üç soru genişletildi:
     1) "Bugün ne öğrendim?"   → journal/YYYY-MM-DD.md (episodik günlük; detay buraya,
                                  MEMORY.md şişmez — uzun vadeli semantik hafıza sade kalır)
     2) "Memoryde gereksiz ne var?" → MEMORY.md satırları için LLM drop/merge kararları
                                  (satır numarası bazlı — mem0 tarzı anti-hallosinasyon),
                                  yedek alındıktan sonra uygulanır
     3) "Bağlamı nasıl sıkılaştırırım?" → önce/sonra token-char istatistiği + öneriler,
                                  reflections/YYYY-MM-DD.json raporu
   Zamanlama: engine 10 dk'da bir tick atar; hedef saat (varsayılan 03:30) geçildiyse ve
   bugün çalışılmadıysa tetiklenir. App gece kapalıysa açılışta yakalama (catch-up) yapar.
   LLM yoksa/olmazsa: LLM adımları atlanır, rapor yine de yazılır (degradasyon). */

const fs = require('fs');
const path = require('path');
const { estTokens } = require('./tokens');

const DEFAULT_AT = '03:30';
const MAX_DROP_RATIO = 0.4; // tek gecede kayıtların en fazla %40'ı düşer
const MERGE_MAX = 3; // bir birleştirmede en fazla 3 kaynak satır
const MERGE_TEXT_MAX = 240; // birleşik satır tavanı (append'in 500 cap'iyle uyumlu)
const CONSOLIDATE_MIN = 10; // kayıt bundan azsa sıkılaştırmaya değmez
const TRANSCRIPT_TAIL = 40; // oturum başına son N mesaj
const DAY_TRANSCRIPT_CAP = 16000; // günün toplam transkript tavanı (char)
const LEARNINGS_MAX = 8;
const FACTS_MAX = 2;
const LLM_TIMEOUT_MS = 120000;
const KEEP_REPORTS = 90;
const KEEP_JOURNALS = 120;
const KEEP_BACKUPS = 14;

/* ---------- zamanlama ---------- */

function resolveAt(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return { h: 3, m: 30 };
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return { h: 3, m: 30 };
  return { h, m: min };
}

function dayKey(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

function startOfDay(d) {
  const x = d instanceof Date ? new Date(d) : new Date(d || Date.now());
  x.setHours(0, 0, 0, 0);
  return x;
}

/* Hedef saat geçildiyse ve bugünün turu atlanmadıysa true.
   lastAt: son yansımanın ISO zamanı (hiç çalışılmadıysa null). */
function due({ now, lastAt, at } = {}) {
  const d = now ? new Date(now) : new Date();
  const { h, m } = resolveAt(at);
  if (d.getHours() * 60 + d.getMinutes() < h * 60 + m) return false;
  return dayKey(lastAt) !== dayKey(d);
}

/* ---------- state (reflections/last.json) ---------- */

function reflectionsDir(memDir_) {
  return path.join(memDir_, 'reflections');
}

function readLast(memDir_) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(reflectionsDir(memDir_), 'last.json'), 'utf8'));
    return r && typeof r === 'object' ? r : null;
  } catch {
    return null;
  }
}

function writeLast(memDir_, at) {
  try {
    fs.mkdirSync(reflectionsDir(memDir_), { recursive: true });
    fs.writeFileSync(
      path.join(reflectionsDir(memDir_), 'last.json'),
      JSON.stringify({ at: new Date(at || Date.now()).toISOString(), day: dayKey(at || Date.now()) }, null, 2)
    );
    return true;
  } catch {
    return false;
  }
}

/* ---------- karar ayrıştırma ---------- */

/* Yansıma cevabından JSON çıkarımı: düz / fence'li / gömülü. Bozuk girişte null. */
function extractJson(text, validator) {
  const t = String(text || '').replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  for (let end = t.lastIndexOf('}'); end > start; end = t.lastIndexOf('}', end - 1)) {
    try {
      const obj = JSON.parse(t.slice(start, end + 1));
      if (obj && typeof obj === 'object' && (!validator || validator(obj))) return obj;
    } catch {}
  }
  return null;
}

function parseDecision(raw) {
  return extractJson(raw, (o) => Array.isArray(o.drop) || Array.isArray(o.merge) || Array.isArray(o.keep));
}

function parseLearnings(raw) {
  const o = extractJson(raw, (x) => Array.isArray(x.learnings) || Array.isArray(x.facts));
  if (!o) return { learnings: [], facts: [] };
  const clean = (arr, cap, maxLen) =>
    (Array.isArray(arr) ? arr : [])
      .map((s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, maxLen))
      .filter(Boolean)
      .slice(0, cap);
  return {
    learnings: clean(o.learnings, LEARNINGS_MAX, 160),
    facts: clean(o.facts, FACTS_MAX, 120),
  };
}

/* ---------- bellek cerrahisi (doğrulanmış drop/merge) ----------

   LLM yalnızca SATIR NUMARASI verir; metinleri biz uygularız. Kurallar:
   - geçersiz/aralık dışı id yok sayılır (halüsinasyon filtresi)
   - bir satır tek karara bağlanır; karar verilmeyen satır KEEP (güvenli varsayılan)
   - merge metni kaynak satırların toplamından uzun olamaz (uydurma filtresi)
   - drop tavanı: kayıtların en fazla %40'ı (tek gecede felç olmaz)
   - merge sırası: birleşik satır, ilk kaynağın yerine yazılır (kronoloji korunur) */
function applyMemoryOps(lines, decision, { maxDropRatio = MAX_DROP_RATIO } = {}) {
  const n = (Array.isArray(lines) ? lines : []).length;
  const d = decision && typeof decision === 'object' ? decision : {};
  const validId = (x) => Number.isInteger(x) && x >= 0 && x < n;
  const action = new Array(n).fill('keep');
  const mergedText = new Map(); // ilk kaynak id -> birleşik metin

  /* 1) merge'ler önce bağlanır (drop'lar merge'lenmiş satırı çalamaz) */
  let mergedCount = 0;
  for (const mg of Array.isArray(d.merge) ? d.merge : []) {
    if (!mg || !Array.isArray(mg.ids)) continue;
    const ids = [...new Set(mg.ids)].filter(validId).sort((a, b) => a - b).slice(0, MERGE_MAX);
    if (ids.length < 2) continue;
    if (ids.some((i) => action[i] !== 'keep')) continue;
    const text = String(mg.text || '').replace(/\s+/g, ' ').trim().slice(0, MERGE_TEXT_MAX);
    if (!text) continue;
    const srcLen = ids.reduce((a, i) => a + String(lines[i]).length, 0);
    if (text.length > srcLen) continue; // kaynakların toplamından uzun = uydurma
    for (const i of ids) action[i] = 'merged';
    mergedText.set(ids[0], text);
    mergedCount++;
  }

  /* 2) drop'lar tavana göre uygulanır */
  const dropWanted = [...new Set(Array.isArray(d.drop) ? d.drop : [])].filter(validId)
    .filter((i) => action[i] === 'keep')
    .sort((a, b) => a - b); // eskiden yeniye — tavan aşılırsa yeniler kalır
  const maxDrop = Math.max(0, Math.floor(n * maxDropRatio));
  const dropSet = new Set(dropWanted.slice(0, maxDrop));
  for (const i of dropSet) action[i] = 'drop';

  /* 3) yeni listeyi kur */
  const out = [];
  let dropped = 0;
  for (let i = 0; i < n; i++) {
    if (action[i] === 'drop') { dropped++; continue; }
    if (action[i] === 'merged') {
      if (mergedText.has(i)) out.push(mergedText.get(i));
      continue;
    }
    out.push(lines[i]);
  }
  return { lines: out, dropped, merged: mergedCount, dropSkipped: dropWanted.length - dropSet.size };
}

/* ---------- promptlar ---------- */

function learningsPrompt(sinceLabel, transcript) {
  return (
    'Sen bir yapay zeka asistanının gece yansıma modülüsün. Aşağıda ' +
    (sinceLabel ? sinceLabel + ' aralığındaki' : 'bugünkü') +
    ' oturum transkriptleri var.\n' +
    'GÖREV: Bugün öğrenilenleri çıkar.\n' +
    'KURALLAR:\n' +
    '- learnings: bugün yapılan işlerden/keşiflerden/hatalardan çıkarımlar (en fazla ' + LEARNINGS_MAX + ' madde, her biri en fazla 160 karakter)\n' +
    '- facts: haftalar sonra bile işe yarayacak KALICI bilgiler — kullanıcı tercihi, proje, isim, rutin (en fazla ' + FACTS_MAX + ' madde, her biri en fazla 120 karakter)\n' +
    '- Uydurma yok; değerli şey yoksa boş dizi\n' +
    'SADECE JSON dön: {"learnings":["..."],"facts":["..."]}\n\n' +
    '# OTURUMLAR\n' + transcript
  );
}

function consolidatePrompt(lines) {
  const numbered = lines.map((l, i) => i + ': ' + l).join('\n');
  return (
    'Sen bir uzun vadeli hafıza yöneticisisin. Bir agentın MEMORY.md kayıtlarını sıkılaştır.\n' +
    'KURALLAR:\n' +
    '- drop: geçici/çözülmüş/değersiz kayıtlar — tek seferlik detay, "yaptım bildirdim" gürültüsü, bayat bilgi, tekrar\n' +
    '- merge: 2-3 yakın/anlamdaş kaydı TEK daha kısa satırda birleştir; YENİ BİLGİ EKLEME, sadece kaynakların özünü yaz\n' +
    '- Değerli kalıcı bilgi asla düşülmez. Tarih içeren satırların tarihini koru.\n' +
    '- En fazla %40 kayıt düşebilirsin. Şüphede kalacaksan dokunma.\n' +
    'SADECE JSON dön (satır numaralarıyla): {"drop":[0,5],"merge":[{"ids":[2,7],"text":"birleşik öz"}]}\n' +
    'Birleşik metin, kaynak satırların TOPLAM uzunluğundan uzun OLAMAZ.\n\n' +
    '# KAYITLAR (no: metin)\n' + numbered
  );
}

/* ---------- dosya yazıcıları ---------- */

function writeJournalFile(memDir_, dateKey, md) {
  try {
    const dir = path.join(memDir_, 'journal');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, dateKey + '.md'), md, 'utf8');
    return path.join('journal', dateKey + '.md');
  } catch {
    return null;
  }
}

function writeReportFile(memDir_, dateKey, report) {
  try {
    const dir = reflectionsDir(memDir_);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, dateKey + '.json'), JSON.stringify(report, null, 2), 'utf8');
    return path.join('reflections', dateKey + '.json');
  } catch {
    return null;
  }
}

function backupMemoryFile(memDir_, dateKey) {
  try {
    const dir = path.join(memDir_, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMORY-' + dateKey + '.md'), fs.readFileSync(path.join(memDir_, 'MEMORY.md'), 'utf8'));
    return true;
  } catch {
    return false;
  }
}

function pruneDir(dir, keep) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.(json|md)$/.test(f) && f !== 'last.json').sort();
    const excess = files.length - keep;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(path.join(dir, files[i])); } catch {}
    }
  } catch {}
}

/* ---------- orkestratör ----------

   deps: {
     llm: async (prompt) => string          — engine chatOnce köprüsü
     memory: modül                          — entries/save/append
     mem0Enabled: bool                      — bilgi amaçlı (memory.save store'u yeniden kurar)
     sessions: [{ id, title, updatedAt, transcript }]
     sinceIso: string|null                  — kapsam başlangıcı
     manual: bool
     now: Date                              — test enjeksiyonu
     log: fn
   } */
async function run(deps) {
  const memDir_ = deps.memDir || (deps.memory && typeof deps.memory.memDir === 'function' ? deps.memory.memDir() : null);
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const now = deps.now ? new Date(deps.now) : new Date();
  const dateKey = dayKey(now);
  const before = deps.memory.entries();
  const charsBefore = before.reduce((a, l) => a + l.length + 2, 0);
  const report = {
    date: dateKey,
    at: now.toISOString(),
    manual: !!deps.manual,
    since: deps.sinceIso || null,
    sessions: Array.isArray(deps.sessions) ? deps.sessions.length : 0,
    learnings: [],
    factsAdded: 0,
    journal: null,
    reportFile: null,
    memory: { before: before.length, after: before.length, dropped: 0, merged: 0, dropSkipped: 0, charsBefore, charsAfter: charsBefore, tokensSaved: 0 },
    notes: [],
    errors: [],
    ok: true,
  };

  /* 1) günün transkripti */
  const transcript = (Array.isArray(deps.sessions) ? deps.sessions : [])
    .map((s) => `[${String(s.title || s.id || 'oturum').slice(0, 60)}]\n${String(s.transcript || '')}`)
    .join('\n\n')
    .slice(0, DAY_TRANSCRIPT_CAP);
  const noLlm = typeof deps.llm !== 'function';
  if (noLlm) report.errors.push('llm yok — öğrenme/sıkılaştırma atlandı');

  /* 2) bugün ne öğrendim → journal */
  if (!noLlm && transcript.trim().length >= 200) {
    try {
      const sinceLabel = deps.sinceIso ? dayKey(deps.sinceIso) + ' ' + String(deps.sinceIso).slice(11, 16) + ' sonrası' : '';
      const raw = await deps.llm(learningsPrompt(sinceLabel, transcript));
      const parsed = parseLearnings(raw);
      report.learnings = parsed.learnings;
      /* kalıcı factler MEMORY.md'ye — append'in dedup'ı tekrarı engeller */
      for (const f of parsed.facts) {
        const r = deps.memory.append(f);
        if (r && r.ok && !r.duplicate) report.factsAdded++;
      }
    } catch (e) {
      report.errors.push('öğrenme: ' + String((e && e.message) || e).slice(0, 120));
    }
  } else if (transcript.trim().length < 200) {
    report.notes.push('bugün değerli transkript yok — öğrenme adımı atlandı');
  }

  /* 3) memory sıkılaştırma: drop/merge kararları → yedek → uygula */
  const entriesNow = deps.memory.entries();
  if (!noLlm && entriesNow.length >= CONSOLIDATE_MIN) {
    try {
      const raw = await deps.llm(consolidatePrompt(entriesNow));
      const decision = parseDecision(raw);
      if (!decision) {
        report.errors.push('sıkılaştırma: karar JSON\u2019i ayrıştırılamadı');
      } else {
        const applied = applyMemoryOps(entriesNow, decision, {});
        if (applied.dropped + applied.merged > 0) {
          backupMemoryFile(memDir_, dateKey);
          /* memory.save → mem0 store'u satırlardan yeniden kurar (store=doğruluk kaynağı) */
          const w = deps.memory.save('MEMORY.md', applied.lines.map((l) => '- ' + l).join('\n') + (applied.lines.length ? '\n' : ''));
          if (w && w.ok) {
            const charsAfter = applied.lines.reduce((a, l) => a + l.length + 2, 0);
            report.memory.after = applied.lines.length;
            report.memory.dropped = applied.dropped;
            report.memory.merged = applied.merged;
            report.memory.dropSkipped = applied.dropSkipped;
            report.memory.charsAfter = charsAfter;
            report.memory.tokensSaved = Math.max(0, estTokens(charsBefore) - estTokens(charsAfter));
          } else {
            report.errors.push('sıkılaştırma: MEMORY.md yazılamadı');
          }
        } else {
          report.notes.push('hafıza zaten sıkı — değişiklik gerekmedi');
        }
      }
    } catch (e) {
      report.errors.push('sıkılaştırma: ' + String((e && e.message) || e).slice(0, 120));
    }
  } else if (entriesNow.length < CONSOLIDATE_MIN) {
    report.notes.push('kayıt sayısı az (' + entriesNow.length + ') — sıkılaştırma atlandı');
  }

  /* 4) bağlam raporu + journal dosyası */
  const scopeLabel = deps.sinceIso
    ? dayKey(deps.sinceIso) + ' ' + String(deps.sinceIso).slice(11, 16) + ' → ' + dayKey(now) + ' ' + String(now.toTimeString ? now.toTimeString().slice(0, 5) : '')
    : 'bugün';
  const m = report.memory;
  const journalMd =
    '# Günlük Yansıma — ' + dateKey + (deps.manual ? ' (elle tetiklendi)' : '') + '\n' +
    'Kapsam: ' + scopeLabel + ' · ' + report.sessions + ' oturum\n\n' +
    '## Bugün öğrendiklerim\n' +
    (report.learnings.length ? report.learnings.map((l) => '- ' + l).join('\n') + '\n' : '- (kayıt yok)\n') +
    (report.factsAdded ? '\nHafızaya eklenen kalıcı bilgi: ' + report.factsAdded + ' madde\n' : '') +
    '\n## Bellek bakımı\n' +
    '- Kayıt: ' + m.before + ' → ' + m.after + ' (düşülen ' + m.dropped + ', ' + m.merged + ' kayıt birleşti)\n' +
    '- Boyut: ' + m.charsBefore + ' → ' + m.charsAfter + ' char (~' + m.tokensSaved + ' token tasarruf)\n' +
    (report.notes.length ? '- Not: ' + report.notes.join('; ') + '\n' : '') +
    (report.errors.length ? '- Hata: ' + report.errors.join('; ') + '\n' : '');
  report.journal = writeJournalFile(memDir_, dateKey, journalMd);
  report.reportFile = writeReportFile(memDir_, dateKey, report);
  writeLast(memDir_, now);
  pruneDir(path.join(memDir_, 'journal'), KEEP_JOURNALS);
  pruneDir(reflectionsDir(memDir_), KEEP_REPORTS);
  pruneDir(path.join(memDir_, 'backups'), KEEP_BACKUPS);
  log('yansıma tamam: ' + m.before + '→' + m.after + ' kayıt, +' + report.factsAdded + ' fact, ' + report.errors.length + ' hata');
  return report;
}

module.exports = {
  DEFAULT_AT,
  MAX_DROP_RATIO,
  MERGE_MAX,
  MERGE_TEXT_MAX,
  CONSOLIDATE_MIN,
  TRANSCRIPT_TAIL,
  DAY_TRANSCRIPT_CAP,
  LLM_TIMEOUT_MS,
  resolveAt,
  dayKey,
  startOfDay,
  due,
  readLast,
  writeLast,
  parseDecision,
  parseLearnings,
  applyMemoryOps,
  learningsPrompt,
  consolidatePrompt,
  run,
};
