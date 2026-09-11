'use strict';

/* BEAST FINANCE — MT5 İLK KURULUM (otomatik)
   Köprü ilk kez bağlandığında çalışır ve şu adımları idempotent uygular:
     1) BeastFinance.mq5 EA'sını <data_path>\MQL5\Experts\Beast\ altına yazar
     2) metaeditor64.exe ile derler (ex5 yok/bayat ise)
     3) config\common.ini [Experts] bölümünü açar:
        AllowLiveTrading=1, AllowDllImport=1, Enabled=1, Api=0
        (AutoTrading düğmesi + Python API işlem izni terminal başlangıcında etkin olur)
     4) Aktif profil grafiğine <expert> bloğu enjekte eder (terminal açılışta EA'yı yükler)
        + MQL5\Profiles\Templates\BeastFinance.tpl şablonu bırakır
   Not: MT5 çalışırken yazılan bu ayarlar BİR SONRAKİ terminal başlangıcında etkinleşir;
   Python API ile grafiğe EA iliştirmenin resmi yolu olmadığından profil enjeksiyonu kullanılır. */

const fs = require('fs');
const path = require('path');
const { spawnSync, execSync } = require('child_process');

const EA_NAME = 'BeastFinance';
const EA_REL = path.join('Beast', EA_NAME + '.mq5');

function bundledEaFile() {
  return path.join(__dirname, 'mt5', EA_NAME + '.mq5');
}

function eaSource() {
  try { return fs.readFileSync(bundledEaFile(), 'utf8'); } catch { return ''; }
}

/* ---------- metin/encoding yardımcıları ---------- */

/* .chr/.tpl dosyaları UTF-16 LE (BOM'lu) olabilir; güvenli çöz/kodla */
function decodeText(buf) {
  if (buf && buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.toString('utf16le').replace(/^\uFEFF/, ''), utf16: true };
  }
  return { text: buf.toString('utf8').replace(/^\uFEFF/, ''), utf16: false };
}

function encodeText(text, utf16) {
  return utf16 ? Buffer.from('\uFEFF' + text, 'utf16le') : Buffer.from(text, 'utf8');
}

/* ---------- common.ini [Experts] ---------- */

/* MT5 config ini'leri UTF-16 LE (BOM'lu/BOM'suz) olabilir; önceki sürüm
   dosyayı UTF-8 sanıp yazınca bozulabiliyordu. Güvenli çöz: NUL yoğunluğuna
   göre UTF-16 tespit et, baştaki/sondaki bozuk satırları temizle. */
function decodeIni(buf) {
  if (!buf || !buf.length) return { text: '', utf16: false };
  /* BİLİNEN BOZULMA ONARIMI: eski sürüm UTF-16 dosyayı UTF-8 sanıp yazınca her
     satır sonuna fazladan 0D baytı girmişti → 0D 00 0D 0A 00 : 0D 00 0A 00 */
  const corrupt = Buffer.from([0x0d, 0x00, 0x0d, 0x0a, 0x00]);
  if (buf.includes(corrupt)) {
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      if (
        i + 4 < buf.length &&
        buf[i] === 0x0d && buf[i + 1] === 0x00 && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a && buf[i + 4] === 0x00
      ) {
        out.push(0x0d, 0x00, 0x0a, 0x00);
        i += 4;
        continue;
      }
      out.push(buf[i]);
    }
    buf = Buffer.from(out);
  }
  let utf16 = false;
  let text = '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    utf16 = true;
    text = buf.toString('utf16le').replace(/^\uFEFF/, '');
  } else {
    let nul = 0;
    const n = Math.min(buf.length, 512);
    for (let i = 0; i < n; i++) if (buf[i] === 0) nul++;
    utf16 = nul > n / 4;
    text = utf16 ? buf.toString('utf16le') : buf.toString('utf8');
  }
  /* baştaki bozuk karakterleri at (ilk [ veya satır sonuna kadar) */
  const first = text.search(/\r|\n|\[/);
  if (first > 0) text = text.slice(first);
  /* satır temizliği: yalnız [Bölüm] ve key=value satırları kalsın
     (eski bozuk yazımdan kalan ASCII/CJK çöp satırları düşer) */
  const keep = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const t = line.replace(/\uFFFD/g, '').replace(/\u0000/g, '').trim();
    if (!t) { keep.push(''); continue; }
    if (/^\[[^\]]+\]$/.test(t) || /^[A-Za-z0-9_]+\s*=/.test(t)) keep.push(t);
  }
  return { text: keep.join('\r\n'), utf16 };
}

function encodeIni(text, utf16) {
  return utf16 ? Buffer.from('\uFEFF' + String(text || ''), 'utf16le') : Buffer.from(String(text || ''), 'utf8');
}

const EXPERTS_WANT = { AllowLiveTrading: '1', AllowDllImport: '1', Enabled: '1', Api: '0' };

/* [Experts] bölümünü istenen değerlere çeker; bölüm yoksa ekler. */
function patchExpertsIni(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let inExperts = false;
  let found = false;
  const seen = new Set();
  const flushMissing = () => {
    for (const [k, v] of Object.entries(EXPERTS_WANT)) {
      if (!seen.has(k)) { out.push(k + '=' + v); seen.add(k); }
    }
  };
  for (const line of lines) {
    const sec = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) {
      if (inExperts) flushMissing();
      inExperts = sec[1].trim().toLowerCase() === 'experts';
      if (inExperts) found = true;
      out.push(line);
      continue;
    }
    if (inExperts) {
      const kv = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
      if (kv && Object.prototype.hasOwnProperty.call(EXPERTS_WANT, kv[1])) {
        out.push(kv[1] + '=' + EXPERTS_WANT[kv[1]]);
        seen.add(kv[1]);
        continue;
      }
    }
    out.push(line);
  }
  if (inExperts) flushMissing();
  if (!found) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push('[Experts]');
    for (const [k, v] of Object.entries(EXPERTS_WANT)) out.push(k + '=' + v);
  }
  const next = out.join('\r\n');
  return { text: next, changed: next !== String(text || '') };
}

function readIniValue(text, section, key) {
  const reSec = new RegExp('^\\s*\\[' + section + '\\]\\s*$', 'im');
  const m = reSec.exec(String(text || ''));
  if (!m) return '';
  const rest = String(text).slice(m.index + m[0].length).split(/\r?\n/);
  for (const line of rest) {
    if (/^\s*\[/.test(line)) break;
    const kv = line.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.*)$', 'i'));
    if (kv) return String(kv[1]).trim();
  }
  return '';
}

/* ---------- grafik .chr <expert> enjeksiyonu ----------
   GERÇEK MT5 formatı (terminalin kendi kaydettiği tpl/chr dosyalarından):
   blok <window>'dan ÖNCE gelir; name/path/expertmode + <inputs> kullanır.
     <expert>
     name=BeastFinance
     path=Experts\Beast\BeastFinance.ex5
     expertmode=5
     <inputs>...</inputs>
     </expert> */

function expertBlock(eaName) {
  const full = String(eaName || 'BeastFinance');
  const parts = full.split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1] || 'BeastFinance';
  const folder = parts.slice(0, -1).join('\\');
  const rel = 'Experts\\' + (folder ? folder + '\\' : '') + name + '.ex5';
  return (
    '<expert>\r\n' +
    'name=' + name + '\r\n' +
    'path=' + rel + '\r\n' +
    'expertmode=5\r\n' +
    '<inputs>\r\n' +
    'InpTag=' + name + '\r\n' +
    'InpHeartbeat=5\r\n' +
    'InpVerbose=true\r\n' +
    'InpMagic=20260910\r\n' +
    '</inputs>\r\n' +
    '</expert>\r\n'
  );
}

/* Grafiğe EA bloğunu ekler/günceller. Başka bir EA varsa DOKUNMAZ.
   Bizim eski yanlış format/konumdaki bloğumuz varsa düzeltir.
   Dönüş: { text, changed, existing, ours } */
function injectExpertBlock(chrText, eaName) {
  const original = String(chrText || '');
  const block = expertBlock(eaName);
  const norm = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  const m = original.match(/<expert>[\s\S]*?<\/expert>\r?\n?/i);
  const winIdx = original.search(/<window>/i);

  if (m) {
    const isOurs = /BeastFinance/i.test(m[0]);
    if (!isOurs) return { text: original, changed: false, existing: true, ours: false };
    const mIdx = original.indexOf(m[0]);
    const posOk = winIdx < 0 || mIdx < winIdx;
    if (posOk && norm(m[0]) === norm(block)) {
      return { text: original, changed: false, existing: false, ours: true };
    }
  }

  /* (varsa) eski bizim bloğu çıkar */
  let text = m && /BeastFinance/i.test(m[0]) ? original.replace(m[0], '') : original;
  const wi = text.search(/<window>/i);
  if (wi >= 0) {
    const head = text.slice(0, wi).replace(/(?:\r?\n)+$/, '\r\n');
    text = head + block + '\r\n' + text.slice(wi);
  } else {
    const ci = text.lastIndexOf('</chart>');
    if (ci < 0) return { text: original, changed: false, existing: false, ours: false };
    text = text.slice(0, ci).replace(/(?:\r?\n)+$/, '\r\n') + block + '\r\n' + text.slice(ci);
  }
  return { text, changed: true, existing: false, ours: true };
}

/* ---------- terminal yardımcıları ---------- */

function findMetaEditor(terminalExe, dataPath) {
  const cands = [];
  const add = (p) => { if (p) cands.push(p); };
  /* 1) terminal64.exe ile aynı klasör (en güvenilir) */
  if (terminalExe) add(path.join(path.dirname(terminalExe), 'metaeditor64.exe'));
  /* 2) veri klasöründeki origin.txt → kurulum yolu (her broker için doğru) */
  if (dataPath) {
    try {
      const origin = decodeOrigin(fs.readFileSync(path.join(dataPath, 'origin.txt')));
      if (origin) add(path.join(origin, 'metaeditor64.exe'));
    } catch {}
  }
  /* 3) çalışan terminal sürecinin klasörü */
  try {
    const p = execSync(
      'powershell -NoProfile -Command "(Get-Process terminal64 -ErrorAction SilentlyContinue | Select-Object -First 1).Path"',
      { windowsHide: true, timeout: 8000 }
    ).toString().trim();
    if (p && /terminal64\.exe$/i.test(p)) add(path.join(path.dirname(p), 'metaeditor64.exe'));
  } catch {}
  /* 4) Program Files altındaki broker klasörleri (2 seviye — her kurulum yolu için) */
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    try {
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        add(path.join(base, e.name, 'metaeditor64.exe'));
        try {
          for (const e2 of fs.readdirSync(path.join(base, e.name), { withFileTypes: true })) {
            if (e2.isDirectory()) add(path.join(base, e.name, e2.name, 'metaeditor64.exe'));
          }
        } catch {}
      }
    } catch {}
  }
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return '';
}

function terminalRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq terminal64.exe" /NH', { windowsHide: true, timeout: 5000 }).toString();
    return /terminal64\.exe/i.test(out);
  } catch {
    return false;
  }
}

function decodeOrigin(buf) {
  try {
    const a = buf.toString('utf16le').replace(/\u0000/g, '').replace(/^\uFEFF/, '').trim();
    if (a && /[\\/]/.test(a)) return a;
    const b = buf.toString('utf8').replace(/\u0000/g, '').replace(/^\uFEFF/, '').trim();
    return b;
  } catch {
    return '';
  }
}

/* Terminal kurulum yolunu ve veri klasörünü köprü OLMADAN bulur:
   - çalışan terminal64.exe sürecinin yolu
   - %APPDATA%\MetaQuotes\Terminal\<hash>\origin.txt eşleşmesi (hash → kurulum yolu)
   En son kullanılan veri klasörünü döndürür; MT5 KAPALIYKEN de çalışır. */
function detectTerminal() {
  const out = { exe: '', dataPath: '', dirs: [] };
  try {
    const p = execSync(
      'powershell -NoProfile -Command "(Get-Process terminal64 -ErrorAction SilentlyContinue | Select-Object -First 1).Path"',
      { windowsHide: true, timeout: 8000 }
    ).toString().trim();
    if (p && /terminal64\.exe$/i.test(p)) out.exe = p;
  } catch {}
  const root = process.env.APPDATA ? path.join(process.env.APPDATA, 'MetaQuotes', 'Terminal') : '';
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      let origin = '';
      try { origin = decodeOrigin(fs.readFileSync(path.join(dir, 'origin.txt'))); } catch {}
      let at = 0;
      try { at = fs.statSync(path.join(dir, 'config', 'common.ini')).mtimeMs; } catch {}
      if (!origin && !at) continue;
      out.dirs.push({ dir, origin, at });
    }
  } catch {}
  out.dirs.sort((a, b) => (b.at || 0) - (a.at || 0));
  if (!out.exe && out.dirs.length && out.dirs[0].origin) {
    const guess = path.join(out.dirs[0].origin, 'terminal64.exe');
    try { if (fs.existsSync(guess)) out.exe = guess; } catch {}
  }
  if (out.exe) {
    const exeDir = path.dirname(out.exe).toLowerCase();
    const hit = out.dirs.find((d) => String(d.origin || '').toLowerCase().startsWith(exeDir));
    if (hit) out.dataPath = hit.dir;
  }
  if (!out.dataPath && out.dirs.length) out.dataPath = out.dirs[0].dir;
  return out;
}

function newestChart(dir) {
  let best = '';
  let bestAt = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.chr$/i.test(f)) continue;
      const p = path.join(dir, f);
      const at = fs.statSync(p).mtimeMs;
      if (at > bestAt) { bestAt = at; best = p; }
    }
  } catch {}
  return best;
}

/* ---------- ana akış ---------- */

function runSetup({ dataPath, terminalExe = '', force = false } = {}) {
  const steps = [];
  const result = { ok: false, changed: false, restartRequired: false, chartAttached: false, autoTrading: false, compiled: false, eaPath: '', error: '' };
  try {
    const data = String(dataPath || '').trim();
    if (!data || !fs.existsSync(data)) {
      result.error = 'MT5 veri klasörü bulunamadı: ' + (data || '(boş)');
      return result;
    }
    const mql5 = path.join(data, 'MQL5');
    if (!fs.existsSync(mql5)) {
      result.error = 'MT5 MQL5 klasörü yok: ' + mql5;
      return result;
    }

    /* 1) EA kaynağı */
    const eaDir = path.join(mql5, 'Experts', 'Beast');
    const eaFile = path.join(eaDir, EA_NAME + '.mq5');
    const ex5File = path.join(eaDir, EA_NAME + '.ex5');
    result.eaPath = eaFile;
    const src = eaSource();
    if (!src) {
      result.error = 'Gömülü EA kaynağı okunamadı: ' + bundledEaFile();
      return result;
    }
    let srcChanged = force;
    try {
      const cur = fs.existsSync(eaFile) ? fs.readFileSync(eaFile, 'utf8') : '';
      if (cur.trim() !== src.trim()) srcChanged = true;
    } catch { srcChanged = true; }
    if (srcChanged) {
      fs.mkdirSync(eaDir, { recursive: true });
      fs.writeFileSync(eaFile, src, 'utf8');
      steps.push('EA kaynağı yazıldı: ' + eaFile);
      result.changed = true;
    } else {
      steps.push('EA kaynağı güncel: ' + eaFile);
    }

    /* 2) Derleme */
    const needsCompile = force || srcChanged || !fs.existsSync(ex5File);
    if (needsCompile) {
      const me = findMetaEditor(String(terminalExe || ''), data);
      if (!me) {
        steps.push('MetaEditor bulunamadı — EA derlenmedi (MT5 içinden derleyin: ' + eaFile + ')');
      } else {
        let log = path.join(eaDir, EA_NAME + '.compile.log');
        try { fs.rmSync(log, { force: true }); } catch {}
        const q = (s) => '"' + String(s) + '"';
        let r = spawnSync(me, ['/compile:' + q(eaFile), '/log:' + q(log)], { windowsHide: true, timeout: 90000 });
        let ex5Ok = fs.existsSync(ex5File);
        /* BOŞLUKLU YOL GÜVENLİĞİ: MetaEditor /compile yolunda boşlukta sorun
           çıkarabiliyor → boşluksuz sahne klasöründe derleyip ex5'i geri kopyala */
        if (!ex5Ok && /\s/.test(eaFile)) {
          const stage = path.join(process.env.ProgramData || 'C:\\ProgramData', 'beast', 'mt5build');
          try {
            fs.mkdirSync(stage, { recursive: true });
            const staged = path.join(stage, EA_NAME + '.mq5');
            fs.copyFileSync(eaFile, staged);
            const slog = path.join(stage, EA_NAME + '.compile.log');
            try { fs.rmSync(slog, { force: true }); } catch {}
            r = spawnSync(me, ['/compile:' + q(staged), '/log:' + q(slog)], { windowsHide: true, timeout: 90000 });
            const sex5 = path.join(stage, EA_NAME + '.ex5');
            if (fs.existsSync(sex5)) {
              fs.copyFileSync(sex5, ex5File);
              ex5Ok = true;
            }
            log = slog;
            steps.push('EA boşluksuz klasörde derlendi (yol boşluk fallback)');
          } catch (e) {
            steps.push('Sahne derleme hatası: ' + String((e && e.message) || e));
          }
        }
        let logText = '';
        try { logText = decodeText(fs.readFileSync(log)).text; } catch {}
        const errMatch = logText.match(/(\d+)\s+error/i);
        const errCount = errMatch ? Number(errMatch[1]) : ex5Ok ? 0 : 1;
        if (ex5Ok && errCount === 0) {
          steps.push('EA derlendi: ' + ex5File);
          result.compiled = true;
          result.changed = true;
        } else {
          steps.push('EA derleme HATASI (' + errCount + ') — ' + me + ' · log: ' + log);
          if (r && r.error) steps.push('MetaEditor hata: ' + String(r.error.message || r.error));
        }
      }
    } else {
      steps.push('EA derlenmiş halde: ' + ex5File);
      result.compiled = true;
    }

    /* 3) AutoTrading izni (common.ini) — MT5 ini'leri UTF-16 olabilir */
    const cfgFile = path.join(data, 'config', 'common.ini');
    let cfgText = '';
    let cfgUtf16 = false;
    try {
      const dec = decodeIni(fs.readFileSync(cfgFile));
      cfgText = dec.text;
      cfgUtf16 = dec.utf16;
    } catch {}
    const patched = patchExpertsIni(cfgText);
    if (patched.changed) {
      fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
      fs.writeFileSync(cfgFile, encodeIni(patched.text, cfgUtf16));
      steps.push('AutoTrading izni yazıldı (config\\common.ini [Experts] Enabled/AllowLiveTrading/Api)');
      result.changed = true;
    } else {
      steps.push('AutoTrading izni zaten açık (common.ini)');
    }
    result.autoTrading = true;

    /* 4) Grafiğe EA iliştirme (aktif profil .chr) */
    const profileLast = readIniValue(patched.text, 'Charts', 'ProfileLast') || 'Default';
    const chartsRoot = path.join(mql5, 'Profiles', 'Charts');
    let chartFile = path.join(chartsRoot, profileLast, 'chart01.chr');
    if (!fs.existsSync(chartFile)) chartFile = newestChart(path.join(chartsRoot, profileLast));
    if (!chartFile) chartFile = '';
    if (chartFile && fs.existsSync(chartFile)) {
      try {
        const raw = fs.readFileSync(chartFile);
        const dec = decodeText(raw);
        const inj = injectExpertBlock(dec.text, 'Beast\\' + EA_NAME);
        if (inj.changed) {
          fs.copyFileSync(chartFile, chartFile + '.beast-bak');
          fs.writeFileSync(chartFile, encodeText(inj.text, dec.utf16));
          steps.push('Grafik profiline EA eklendi: ' + chartFile + ' (terminal açılışında yüklenir)');
          result.chartAttached = true;
          result.changed = true;
        } else if (inj.ours) {
          steps.push('Grafik profilinde EA zaten kayıtlı: ' + chartFile);
          result.chartAttached = true;
        } else if (inj.existing) {
          steps.push('Grafikte başka bir EA var — dokunulmadı: ' + chartFile);
        } else {
          steps.push('Grafik profili işlendi (EA enjeksiyonu uygulanamadı): ' + chartFile);
        }
        /* 4b) şablon: kullanıcı elle de uygulayabilsin */
        try {
          const tplDir = path.join(mql5, 'Profiles', 'Templates');
          fs.mkdirSync(tplDir, { recursive: true });
          const tplText = inj.changed ? inj.text : (() => {
            const raw2 = fs.readFileSync(chartFile);
            const dec2 = decodeText(raw2);
            return injectExpertBlock(dec2.text, 'Beast\\' + EA_NAME).text;
          })();
          fs.writeFileSync(path.join(tplDir, EA_NAME + '.tpl'), encodeText(tplText, dec.utf16));
          steps.push('Şablon hazır: ' + path.join(tplDir, EA_NAME + '.tpl'));
        } catch (e) {
          steps.push('Şablon yazılamadı: ' + String((e && e.message) || e));
        }
      } catch (e) {
        steps.push('Grafik enjeksiyonu hatası: ' + String((e && e.message) || e));
      }
    } else {
      steps.push('Aktif profil grafiği bulunamadı — EA Navigator\'dan elle sürüklenebilir');
    }

    const running = terminalRunning();
    result.restartRequired = running && result.changed;
    if (result.restartRequired) steps.push('Değişiklikler MT5 yeniden başlatılınca etkinleşir');
    result.ok = true;
    return result;
  } catch (e) {
    result.error = String((e && e.message) || e);
    return result;
  }
}

module.exports = {
  runSetup,
  eaSource,
  patchExpertsIni,
  injectExpertBlock,
  decodeText,
  encodeText,
  decodeIni,
  encodeIni,
  readIniValue,
  findMetaEditor,
  terminalRunning,
  detectTerminal,
};
