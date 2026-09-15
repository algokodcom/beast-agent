'use strict';

/* KİŞİSEL TOOLLAR: %APPDATA%\beast\tools\<slug>\tool.json + run.js
   Kullanıcı (ya da ajan) Node ile koşan kendi araçlarını yazar; TÜM oturumlar
   — BEAST FINANCE dahil — bunları model'e açılan gerçek araç olarak çağırır
   (tool__<slug>). Sözleşme:
     - stdin  : JSON argümanlar
     - stdout : JSON sonuç (son satır JSON'a çevrilmeye çalışılır)
     - çalışma klasörü: tool'un kendi klasörü (%APPDATA%\beast\tools\<slug>)
   Sonuç model'e { ok, ... } olarak döner; çocuk proses izoledir (uygulama
   çökmez), 90 sn zaman aşımı vardır. */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { beastRoot } = require('./memory');

let notify = () => {};
function setNotify(fn) {
  notify = typeof fn === 'function' ? fn : () => {};
}

/* KİŞİSEL MT5 TOOLLARI köprüyü doğrudan çağırır (iç mt5_* handler'ı devreye
   girmez) — başarılı çağrıyı trade olayı olarak ana sürece bildir ki jurnal +
   panel/kanal bildirimi (işlem açıldı, SL/TP güncellendi…) kaçmasın. */
let tradeHook = null;
function setTradeHook(fn) {
  tradeHook = typeof fn === 'function' ? fn : null;
}

function dir() {
  return path.join(beastRoot(), 'tools');
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
}

let cache = null;
let dirty = true;

function invalidate() {
  dirty = true;
  cache = null;
}

/* klasör damgası: ajan/kullanıcı klasöre elle müdahale edince (write_file
   vb.) cache BAYATLAR — damga değişince otomatik yeniden taranır */
let lastStamp = 0;
function folderStamp() {
  try { return fs.statSync(dir()).mtimeMs; } catch { return 0; }
}

function ensureFresh() {
  const s = folderStamp();
  if (dirty || !cache || s !== lastStamp) {
    cache = scan();
    dirty = false;
    lastStamp = s;
  }
}

function readTool(d) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(d, 'tool.json'), 'utf8'));
    if (!json || typeof json !== 'object' || !json.name) return null;
    const runJs = path.join(d, 'run.js');
    if (!fs.existsSync(runJs)) return null;
    return {
      id: path.basename(d),
      name: String(json.name).slice(0, 40),
      description: String(json.description || '').slice(0, 300),
      parameters:
        json.parameters && typeof json.parameters === 'object'
          ? json.parameters
          : { type: 'object', properties: {} },
      script: runJs,
      code: fs.readFileSync(runJs, 'utf8').slice(0, 20000),
      updatedAt: json.updatedAt || null,
    };
  } catch {
    return null;
  }
}

function scan() {
  const out = [];
  try {
    for (const e of fs.readdirSync(dir(), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const t = readTool(path.join(dir(), e.name));
      if (t) out.push(t);
    }
  } catch {}
  return out;
}

function list() {
  return scan();
}

/* engine _chatTurn'e OpenAI function formatında şemalar */
function definitions() {
  ensureFresh();
  return cache.map((t) => ({
    type: 'function',
    function: {
      name: 'tool__' + t.id,
      description:
        (t.description || 'kişisel tool') + ` (kişisel tool — args stdin JSON, sonuç stdout JSON)`,
      parameters: t.parameters,
    },
  }));
}

function names() {
  ensureFresh();
  return cache.map((t) => 'tool__' + t.id);
}

const TOOL_TIMEOUT_MS = 90 * 1000;

/* Tool'u çocuk node prosesinde koşturur — uygulama asla çökmez */
function call(name, args, sid) {
  return new Promise((resolve) => {
    const id = String(name || '').replace(/^tool__/, '');
    if (!id) return resolve({ ok: false, error: 'tool adı gerekli' });
    const t = scan().find((x) => x.id === id);
    if (!t) return resolve({ ok: false, error: 'tool bulunamadı: ' + id });
    const t0 = Date.now();
    let child = null;
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      try {
        notify({
          at: new Date().toISOString(),
          tool: t.name,
          toolId: id,
          ok: !!r.ok,
          ms: Date.now() - t0,
          error: r && r.error ? String(r.error).slice(0, 200) : null,
        });
      } catch {}
      try {
        if (tradeHook) tradeHook(id, args || {}, r || {}, sid ? String(sid) : '');
      } catch {}
      resolve(r);
    };
    let killer = setTimeout(() => {
      try { child && child.kill(); } catch {}
      finish({ ok: false, error: 'tool zaman aşımı (' + Math.round(TOOL_TIMEOUT_MS / 1000) + ' sn)' });
    }, TOOL_TIMEOUT_MS);
    try {
      /* Araç ortamı: BEAST_* değişkenleri — tool'lar köprü/python yolunu ve
         argümanları buradan güvenle çözebilir (stdin yanı sıra yedek kanal). */
      const env = {
        ...process.env,
        BEAST_ROOT: beastRoot(),
        BEAST_APP_DIR: path.join(__dirname, '..', '..'), // tool'lar uygulama node_modules'ına (ör. @napi-rs/canvas) buradan erişir
        BEAST_TOOL_ID: id,
        BEAST_TOOL_ARGS: JSON.stringify(args || {}),
        BEAST_FINANCE_DIR: path.join(beastRoot(), 'finance'),
      };
      child = spawn(process.execPath, [t.script], { cwd: path.dirname(t.script), env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ ok: false, error: String((e && e.message) || e) });
    }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e) }));
    child.on('close', (code) => {
      const raw = String(out || '').trim();
      let data = null;
      try { data = raw ? JSON.parse(raw) : null; } catch {}
      if (data === null || typeof data !== 'object' || Array.isArray(data) || typeof data.ok !== 'boolean') {
        data = { ok: code === 0, result: data === null ? raw.slice(0, 4000) : data };
      }
      if (code !== 0) {
        if (data.ok !== false) data.ok = false;
        if (!data.error) data.error = String(err || '').slice(0, 400) || 'çıkış kodu ' + code;
      }
      finish(data);
    });
    try {
      child.stdin.write(JSON.stringify(args || {}));
      child.stdin.end();
    } catch {}
  });
}

function save({ id, name, description, parameters, code }) {
  const slug = id && /^[a-z0-9_-]{2,24}$/.test(String(id)) ? String(id) : slugify(name);
  if (!slug) return { ok: false, error: 'tool adı gerekli (a-z 0-9 _ -)' };
  const d = path.join(dir(), slug);
  try {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, 'tool.json'),
      JSON.stringify(
        {
          name: String(name || slug).slice(0, 40),
          description: String(description || '').slice(0, 300),
          parameters:
            parameters && typeof parameters === 'object' && !Array.isArray(parameters)
              ? parameters
              : { type: 'object', properties: {} },
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
    const js = String(code || '').trim();
    if (!js) return { ok: false, error: 'run.js kodu boş olamaz' };
    fs.writeFileSync(path.join(d, 'run.js'), js.slice(0, 20000));
    invalidate();
    return { ok: true, id: slug };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function remove(id) {
  const slug = String(id || '');
  if (!/^[a-z0-9_-]{2,24}$/.test(slug)) return { ok: false, error: 'geçersiz tool kimliği' };
  try {
    fs.rmSync(path.join(dir(), slug), { recursive: true, force: true });
    invalidate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* VARSAYILAN TOOLLAR: uygulamayla gelen hazır araçlar (src/agent/defaulttools) —
   MT5 köprúsü + grafik screenshot'ı. Kullanıcı klasöründe YOKSA kurulur;
   var olanın üzerine YAZILMAZ (kullanıcı düzenlemesi korunur).

   NOT: fs.cpSync Windows'ta bazı klasörlerde süreci düşürebildiği için
   kopyalama mkdir+copyFile ile elle yapılır (güvenli, doğrulamalı). */
function copyTree(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, e.name);
    const to = path.join(dstDir, e.name);
    if (e.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

function readJsonSafe(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

/* güncelleme öncesi: kullanıcının düzenlediği dosyaları .user-bak olarak sakla */
function backupEditedFiles(fromDir, toDir) {
  try {
    for (const e of fs.readdirSync(fromDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      backupEditedFiles(path.join(fromDir, e.name), path.join(toDir, e.name));
    }
  } catch {}
  try {
    for (const e of fs.readdirSync(fromDir, { withFileTypes: true })) {
      if (e.isDirectory()) continue;
      if (e.name === 'tool.json') continue; /* sürüm damgası her güncellemede değişir */
      const from = path.join(fromDir, e.name);
      const to = path.join(toDir, e.name);
      try {
        if (!fs.existsSync(to)) continue;
        if (fs.readFileSync(from).equals(fs.readFileSync(to))) continue;
        const bak = to + '.user-bak';
        if (!fs.existsSync(bak)) fs.copyFileSync(to, bak);
      } catch {}
    }
  } catch {}
}

/* SÜRÜM GÜNCELLEMESİ: shipped tool.json'da "defaultsVersion" varsa ve kurulu
   sürümden büyükse araç güncellenir (ör. mt5_shot çoklu periyot); düzenlenmiş
   dosyalar .user-bak olarak yedeklenir. Alan yoksa eski davranış: yalnız eksikse kur. */
function seedDefaults() {
  const src = path.join(__dirname, 'defaulttools');
  try {
    if (!fs.existsSync(src)) return 0;
    fs.mkdirSync(dir(), { recursive: true });
    let n = 0;
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const from = path.join(src, e.name);
      const to = path.join(dir(), e.name);
      const shipped = readJsonSafe(path.join(from, 'tool.json'));
      const shippedV = Number(shipped && shipped.defaultsVersion) || 0;
      /* tam kurulu mu? tool.json + run.js yoksa yarım demektir → yeniden kur */
      const complete = fs.existsSync(path.join(to, 'tool.json')) && fs.existsSync(path.join(to, 'run.js'));
      let need = !complete;
      if (complete && shippedV > 0) {
        const installed = readJsonSafe(path.join(to, 'tool.json'));
        const installedV = Number(installed && installed.defaultsVersion) || 0;
        if (shippedV > installedV) need = true;
      }
      if (!need) continue;
      try {
        if (complete) {
          backupEditedFiles(from, to); /* kullanıcı düzenlemesi kaybolmasın */
          copyTree(from, to);          /* güncelle: shots/ ve ek dosyalar korunur */
        } else {
          if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
          copyTree(from, to);
        }
        n++;
      } catch {}
    }
    if (n) invalidate();
    return n;
  } catch {
    return 0;
  }
}

/* Örnek tool: klasör boşsa biçimi göstermek için bir adet kur */
function seedIfEmpty() {
  try {
    if (scan().length) return;
    save({
      name: 'ornek_echo',
      description:
        'Örnek kişisel tool — gelen argümanları geri döndürür. Bu klasörü kopyalayarak kendi toollarını yaz; agent finance dahil tüm oturumlarda tool__<ad> olarak çağırır.',
      parameters: {
        type: 'object',
        properties: {
          mesaj: { type: 'string', description: 'geri döndürülecek deneme mesajı' },
        },
        required: ['mesaj'],
      },
      code:
        "'use strict';\n" +
        "// KİŞİSEL TOOL — stdin: JSON args · stdout: JSON sonuç\n" +
        "// Bu klasörü kopyalayıp kendi araçlarını yaz (örn. MT5 emir köprüsü, özel API çağrısı…)\n" +
        "const fs = require('fs');\n" +
        "let raw = '';\n" +
        "try { raw = fs.readFileSync(0, 'utf8'); } catch {}\n" +
        "let args = {};\n" +
        "try { args = JSON.parse(raw || '{}'); } catch {}\n" +
        "console.log(JSON.stringify({ ok: true, echo: args, not: 'run.js ve tool.json düzenlenebilir' }));\n",
    });
  } catch {}
}

module.exports = { setNotify, setTradeHook, list, scan, definitions, names, call, save, remove, seedIfEmpty, seedDefaults, invalidate, dir, slugify };
