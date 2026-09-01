'use strict';

/* ---------- opencode agent.ts port: özel ajan tanımları ----------
   Kullanıcı ajanları: %APPDATA%\beast\agents\<isim>.md
   Markdown frontmatter + prompt gövdesi:

     ---
     model: providerId::model          # opsiyonel — o ajanın modeli
     tools: [run_command, web_search]  # opsiyonel araç beyaz listesi
     steps: 12                         # opsiyonel tur limiti (2-60)
     mode: all                         # chat | bg | all (nerede kullanılabilir)
     ---

     Buradan itibaren ajanın sistem prompt eki gelir.

   Kullanım: sohbette /agent <isim> · paralel ajanda run_background(agent:"isim")
   Ana akış bunları engine.setSessionAgent / runBackground(opts.agent) ile tüketir. */

const fs = require('fs');
const path = require('path');
const { parseYaml, beastDir } = require('./config');

function dir() {
  return path.join(beastDir(), 'agents');
}

/* İlk açılışta klasörü + örnek tanımı tohumla (kullanıcı hemen görür) */
function seedIfEmpty() {
  try {
    const d = dir();
    if (fs.existsSync(d)) return;
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, 'ornek-arastirmaci.md'),
      [
        '---',
        '# Bu dosya bir ÖRNEK ajan tanımıdır — dilediğin gibi düzenle/kopyala.',
        '# model: providerId::model   → bu ajana özel model (boşsa aktif model)',
        '# tools: [web_search, http_fetch, deep_search] → araç beyaz listesi',
        '# steps: 10                   → tur limiti (2-60)',
        '# mode: all                   → chat | bg | all',
        'mode: all',
        'steps: 10',
        '---',
        '',
        'Sen odaklı bir ARAŞTIRMACI ajansın. Görevi baştan sona yürüt:',
        '1) Kaynakları paralel tara (3-5 yeterli), 2) çelişkileri işaretle,',
        '3) bulguları madde madde + kaynak linkleriyle raporla.',
        '2-3 denemede bulunamayan bilgiyi bırak — kısmi sonuçla gel, takılma.',
        '',
      ].join('\n')
    );
  } catch {}
}

function _parseFile(file) {
  const name = path.basename(file).replace(/\.md$/i, '');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return null;
  let meta = {};
  let body = t;
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t);
  if (m) {
    try {
      meta = parseYaml(m[1]) || {};
    } catch {
      meta = {};
    }
    body = m[2] || '';
  }
  let tools = null;
  if (Array.isArray(meta.tools)) tools = meta.tools.map(String).map((s) => s.trim()).filter(Boolean);
  else if (meta.tools) tools = String(meta.tools).split(',').map((s) => s.trim()).filter(Boolean);
  const steps = Math.round(Number(meta.steps) || 0);
  return {
    name,
    model: String(meta.model || '').trim() || null,
    tools: tools && tools.length ? tools : null,
    steps: steps ? Math.max(2, Math.min(60, steps)) : null,
    mode: ['chat', 'bg', 'all'].includes(String(meta.mode || '').toLowerCase())
      ? String(meta.mode).toLowerCase()
      : 'all',
    prompt: body.trim(),
  };
}

function list() {
  let files = [];
  try {
    files = fs.readdirSync(dir()).filter((f) => f.toLowerCase().endsWith('.md'));
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const f of files) {
    const def = _parseFile(path.join(dir(), f));
    if (def && def.prompt && !seen.has(def.name.toLowerCase())) {
      seen.add(def.name.toLowerCase());
      out.push(def);
    }
  }
  return out;
}

function get(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return (
    list().find((d) => d.name.toLowerCase() === n) ||
    list().find((d) => d.name.toLowerCase().startsWith(n)) ||
    null
  );
}

module.exports = { dir, list, get, seedIfEmpty };
