'use strict';

/* Beast skills: %APPDATA%\beast\skills\**\SKILL.md
   Only name+description go into the system prompt (few tokens).
   The model reads the full SKILL.md on demand via read_file. */

const fs = require('fs');
const path = require('path');
const { beastRoot } = require('./memory');

function dir() {
  return path.join(beastRoot(), 'skills');
}

function parseFrontmatter(text) {
  const m = String(text || '')
    .replace(/^\uFEFF/, '')
    .match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (mm && !(mm[1] in out)) out[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function walk(d, depth, out) {
  if (depth > 4) return;
  let entries;
  try {
    entries = fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      /* .drafts: yansıma taslakları — kurulu skill listesine karışmaz */
      if (e.name === '.drafts') continue;
      walk(p, depth + 1, out);
    } else if (e.name === 'SKILL.md') {
      try {
        const fm = parseFrontmatter(fs.readFileSync(p, 'utf8'));
        out.push({
          name: fm.name || path.basename(path.dirname(p)),
          description: fm.description || '',
          path: p,
        });
      } catch {}
    }
  }
}

function scan() {
  const out = [];
  walk(dir(), 0, out);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const SEEDS = [
  {
    folder: 'help',
    body: `---
name: help
description: Beast Agent genel yardım — tüm veri yolları (%APPDATA%\\beast), ayar/config dosyaları, memory, cron, watcher, WhatsApp, TTS, araç özeti.
version: 1.0.0
---

# Beast Agent Yardım

Tüm veri tek kökte: \`%APPDATA%\\beast\\\` (test/taşınabilir için \`BEAST_DATA\` env override).

## Dosya Haritası

| Yol | Ne İşe Yarar |
|---|---|
| \`config.yaml\` + \`.env\` | Model sağlayıcıları + API anahtarları. Provider tanımı: \`providers.<id>.base_url/key_env/models\`; aktif seçim: \`model.provider/default\`. \`.env\`'de \`<PROVIDER>_API_KEY\` veya \`key_env\` ile eşleşen anahtar |
| \`settings.json\` | App ayarları: theme, workspace, modelOverride, customProviders, roleModels, deletedModels, fallout, waTts (TTS), email (mail credential), waAllow, waLockdown |
| \`sessions\\\` | Sohbet oturumları (mesaj JSON'ları) |
| \`memories\\\` | SOUL.md (kişilik), MEMORY.md (uzun hafıza kayıtları), USER.md (kullanıcı bilgisi) |
| \`skills\\\` | \`**\\\\SKILL.md\` — isim+açıklama system prompt'a gider, gövde okunur |
| \`cron.json\` | Zamanlanmış görevler (5 alanlı cron) |
| \`watchers.json\` | Web/batarya izleyicileri |
| \`wa-auth\\\` | WhatsApp Baileys eşleme auth'u — SİLME |
| \`wa-chats.json\`, \`wa.log\` | WA sohbet eşlemesi ve log |
| \`bots.json\`, \`bots/<id>/\`, \`whitelist.json\` | Bot sistemi: bot kaydı (max 5, \`beast\` admin silinemez), her botun izole klasörü (config.json, memory.md, yetkiler.json, logs/), numara→bot eşlemesi. Bağlı olmayan numara beast'e düşer |
| \`logs\\\`, \`scripts\\\` | Çalışma logları / kullanıcı scriptleri |

## Sağlık Kontrolleri

- "Model yapılandırılmadı" hatası → \`config.yaml\`/\`.env\` dolu mu bak; yoksa kullanıcıdan Ayarlar → Provider'dan model seçmesini ya da dosyaları doldurmasını iste (\`config.example.yaml\` repo kökünde örnek var).
- Mail sorunları → \`email\` skill'ini oku.
- fallout zinciri → Ayarlar → Fallout; 401'de sıradaki slota otomatik düşer.

## Davranış Kuralları

- Şifre/API anahtarlarını asla düz metin loglama/tekrarlama.
- settings.json'a el ile yazarken app kapalı olsun (kapanışta ezme riski).
- Yeni yetenek gerekiyorsa \`%APPDATA%\\beast\\skills\\<ad>\\\\SKILL.md\` oluşturmayı önerebilirsin.`,
  },
  {
    folder: 'email',
    body: `---
name: email
description: E-posta entegrasyonu — credential nerede girilir, Gmail uygulama şifresi, email_list/email_read/email_send araçlarının kullanımı ve hata giderme.
version: 1.1.0
---

# E-posta Entegrasyonu (IMAP/SMTP)

## Credential NEREYE Girilir?

İki yol var:

1. **UI:** Ayarlar (⚙) → **E-posta** sekmesi → alanları doldur → "E-posta Kaydet". Kaydettiği yer: \`%APPDATA%\\beast\\settings.json\` içindeki \`"email"\` bloğu.
2. **Dosya:** aynı bloğu elle düzenle:

\`\`\`json
"email": {
  "host": "imap.gmail.com",
  "port": 993,
  "user": "adres@gmail.com",
  "pass": "uygulama sifresi (16 hane)",
  "smtpHost": "smtp.gmail.com",
  "smtpPort": 465
}
\`\`\`

ÖNEMLİ:
- \`pass\` normal Gmail şifresi DEĞİL — Google Hesabı → Güvenlik → "Uygulama Şifreleri"nden üretilen 16 haneli şifre (2FA açık olmalı).
- UI'da şifre alanı \`***\` maskeli gelir; alanı BOŞ bırakıp kaydetmek mevcut şifreyi KORUR. Yeni şifre girmek için alanı doldur.
- SMTP port: 465 (implicit TLS) veya 587 (STARTTLS) — ikisi de desteklenir, kod otomatik seçer.
- UI'dan kaydetme ANINDA geçerlidir. Dosyayı ELLE düzenlediysen uygulamayı yeniden başlatmak ŞARTTIR — app ayarları başlangıçta belleğe yükler, çalışan süreç eski değerleri kullanmaya devam eder.
- settings.json bozulursa app otomatik olarak \`settings.backup.json\`'dan kurtarır; veri kaybı olmaz.

## Araçlar

- \`email_list\` → \`{ "limit": 10, "unread": false }\` — son mailler: uid, from, subject, date döner.
- \`email_read\` → \`{ "uid": 123 }\` — uid'nin tam gövde metnini getirir (önce email_list çağır).
- \`email_send\` → \`{ "to": "a@b.com", "subject": "...", "body": "düz metin" }\`

## Hata Giderme

| Belirti | Sebep / Çözüm |
|---|---|
| \`e-posta ayarlanmamış\` | Credential girilmemiş YA DA settings.json elle düzenlendi ama restart yapılmadı → önce restart öner |
| \`Invalid credentials\` / auth hatası | Uygulama şifresi yanlış/silinmiş → yeni üret |
| \`imap modülü yok\` | node_modules bozuk → \`npm i imapflow\` (repo kökünde) |
| Timeout | Ağ/port sorunu; 993 (IMAP) ve 465 veya 587 (SMTP) erişilebilir mi bak |

Gönderim (nodemailer) takılırsa son çare PowerShell fallback:

\`\`\`powershell
$sec = ConvertTo-SecureString 'UYGULAMA_SIFRESI' -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential('adres@gmail.com', $sec)
Send-MailMessage -SmtpServer smtp.gmail.com -Port 587 -UseSsl -From 'adres@gmail.com' -To 'ALICI' -Subject 'Konu' -Body 'Metin' -Credential $cred
\`\`\`

Şifreyi asla log'a, sohbet çıktısına veya kullanıcıya düz metin olarak gösterme.`,
  },
  {
    folder: 'python-web-search',
    force: true,
    body: `---
name: python-web-search
description: VARSAYILAN web arama zinciri — 1) dahili tarayıcı DİREK GOOGLE (gerçek Chromium, bot koruması yok; Google AI cevabi 'ai' alanında hazır gelir) 2) python çoklu-motor (ddgs / DDG+Bing+Mojeek, anahtarsız) 3) Exa (son çare, anahtar varsa). Takılmama kuralları içerir.
version: 1.3.2
---

# Web Arama Zinciri (VARSAYILAN)

web_search aracı çağrıldığında zincir OTOMATİK çalışır — elle motor seçmen gerekmez:

## 1. Dahili tarayıcı (ilk tercih — Google AI)

Gerçek Chromium olduğu için Google'a bot koruması uygulamaz. Arama aep=1 ile açılır: Google'ın KENDİ AI cevabı yanıtın 'ai' alanında HAZIR gelir — "kimdir/nedir" sorularında önce onu kullan, kaynak linkleri de 'results' alanında gelir. Sağ panelde açılır, kullanıcı da görebilir.

## 2. Python çoklu-motor (tarayıcı sonuç vermezse)

ddgs kütüphanesi (github.com/deedy5/ddgs — anti-bot korumalı metasearch) veya DuckDuckGo + Bing + Mojeek PARALEL — anahtar gerekmez. Gömülü Python runtime otomatik yönetilir.

\`\`\`
web_search {"query": "sorgu", "max_results": 6}
\`\`\`

- Çoklu sorgu gerekiyorsa: aynı turda birden ÇOK web_search çağrısını PARALEL ver — toplam süre tek arama kadar olur.
- Sonuç listesinden 1-2 URL'nin içeriğini okumak için http_fetch kullan.

## 3. Exa (son çare)

Yukarıdakiler boş dönerse ve Ayarlar → Web Arama'ya Exa anahtarı girildiyse devreye girer.

## Toplu / derin işler (python_run)

- Haber başlıkları: python_run script=news.py args ["--limit","8","--json"]
- 3+ sorguyu tek betikte taramak için:

\`\`\`python
# python_run code: çoklu sorgu tek seferde
import subprocess, sys, os
script = os.path.join(os.environ.get('APPDATA', ''), 'beast', 'scripts', 'websearch.py')
for q in ["sorgu 1", "sorgu 2", "sorgu 3"]:
    subprocess.run([sys.executable, script, q, "--limit", "4", "--json"])
\`\`\`

## TAKILMAMA KURALLARI (ZORUNLU)

- Bir bilgi 2-3 farklı sorguyla bulunamıyorsa PEŞİNİ BIRAK: bulduğun kısmi bilgiyle devam et, neyi bulamadığını raporda açıkça yaz.
- Kapalı/gizli içerik (Instagram gizli hesap, private profil, login arkası veri) ARANMAZ — bulunamayacağı belliyse hemen alternatif kaynağa/geçişe geç.
- DDG boş/engelli dönerse "DuckDuckGo kapandı" DEME: bot koruması devrededir (~1 saatte kendiliğinden açılır) ve zincir otomatik olarak Bing/Mojeek/tarayıcıya geçer — bu normal çalışmadır.
- Araştırma hedefi: ~3 dakika, 3-5 kaynak. Derinleşme = zaman kaybı.
- Motor hata verirse bir kez farklı sorguyla dene, sonra elindekiyle raporu kapat.`,
  },
  {
    folder: 'gold-trading',
    body: `---
name: gold-trading
description: Kullanıcının GOLD (FxPro MT5) işlem tercihleri — market structure kontrol listesi.
version: 1.0.0
---

# GOLD İşlem Tercihleri (Batuhan)

Sembol: "GOLD" (XAUUSD değil), FxPro MT5 demo, M1.

Zorunlu kurallar:
- Market structure şart: swing/HH-LL analizi olmadan ve BOS teyidi olmadan İŞLEM YOK. MA kesişimi tek başına gürültüdür.
- Geniş SL: ~4xATR; BE: ~2xATR kârda.
- Yetki sende: açmadan önce sorma; SADECE sonucu (STOP/TP) raporla, giriş/trailing tiklerini anlatma.
- AI komite yaklaşımı: sinyal yakalanır → görsel/teknik/risk analizi → açılış.`,
  },
  {
    folder: 'pdf',
    body: `---
name: pdf
description: PDF işleme rehberi — metin çıkarma (pdf-parse), Türkçe karakterli PDF oluşturma/değiştirme (pdf-lib/pdfkit), sayfa→görsel (pdf-to-img) ve taranmış PDF için OCR (tesseract.js). Kullanıcı bir .pdf dosyasından bahsederse ÖNCE bu skill'i oku.
version: 1.0.0
---

# PDF İşleme Rehberi

Kurulu paketler ve rolleri:

| İstek | Paket |
|---|---|
| Metin çıkar / oku | \`pdf-parse\` |
| Yeni PDF üret / mevcut PDF'i değiştir | \`pdf-lib\` (+ \`@pdf-lib/fontkit\`) |
| Düzenli belge üretimi (rapor, özet) | \`pdfkit\` |
| Sayfa→PNG/JPG (taranmış/görsel PDF) | \`pdf-to-img\` |
| Taranmış PDF'den metin (OCR) | \`pdf-to-img\` + \`tesseract.js\` |

## KRİTİK KURAL — aynı process çakışması

\`pdf-parse\` ile \`pdf-to-img\` AYNI node process'inde yüklenirse şuna benzer hata alırsın:
\`\`\`
The API version "5.x.x" does not match the Worker version "5.y.y"
\`\`\`
Çözüm: her iş küçük BAĞIMSIZ bir script olsun; run_command ile ayrı ayrı çalıştır.
Tek process'te sadece BİR pdfjs tabanlı paket kullan (\`read_file\` aracı pdf-parse kullanır — senin render scriptlerin bunu yüklememeli).

## 1. Okuma

\`read_file\` aracı .pdf'i otomatik metne çevirir — önce onu dene. Elle script gerekirse:

\`\`\`js
// pdf-oku.js → node pdf-oku.js dosya.pdf
const fs = require('fs');
const { PDFParse } = require('pdf-parse');
(async () => {
  const parser = new PDFParse({ data: new Uint8Array(fs.readFileSync(process.argv[2])) });
  try {
    const r = await parser.getText();
    console.log('sayfa=' + r.total);
    console.log(r.text);
  } finally { await parser.destroy(); }
})();
\`\`\`

Metin boş geliyorsa TARANMIŞ görseldir → 4 ve 5. adımlara geç.

## 2. Oluşturma / Değiştirme (pdf-lib)

TÜRKÇE KARAKTER UYARISI: standard fontlar (Helvetica vb.) ğ ş ı İ karakterlerini BASAMAZ — betik sessizce bozuk çıktı üretir. Türkçe içerikte MUTLAKA Windows TTF embed et:

\`\`\`js
// pdf-yaz.js → node pdf-yaz.js cikti.pdf
const fs = require('fs');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
(async () => {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const trFont = await doc.embedFont(fs.readFileSync('C:/Windows/Fonts/arial.ttf'), { subset: true });
  const page = doc.addPage([595, 842]); // A4
  page.drawText('Ders Özeti\\n• Konu: Fonksiyonlar', { x: 50, y: 750, size: 14, font: trFont });
  fs.writeFileSync(process.argv[2], await doc.save());
})();
\`\`\`

Mevcut PDF'i değiştirme / birleştirme:

\`\`\`js
const hedef = await PDFDocument.load(fs.readFileSync('a.pdf'));
const kaynak = await PDFDocument.load(fs.readFileSync('b.pdf'));
const pages = await hedef.copyPages(kaynak, kaynak.getPageIndices());
pages.forEach((p) => hedef.addPage(p));
fs.writeFileSync('birlesik.pdf', await hedef.save());
\`\`\`

Form doldurma: \`doc.getForm()\`, \`form.getTextField('Ad').setText(...)\`.

## 3. Düzenli belge üretimi (pdfkit)

\`\`\`js
const PDFDocument = require('pdfkit');
const fs = require('fs');
const doc = new PDFDocument({ size: 'A4', margins: { top: 60, bottom: 60, left: 60, right: 60 } });
doc.pipe(fs.createWriteStream('rapor.pdf'));
doc.font('C:/Windows/Fonts/arial.ttf').fontSize(14).text('YARIYIL RAPORU');
doc.fontSize(11).text('Matematik: 90   Fizik: 78');
doc.end();
\`\`\`

## 4. Sayfa → Görsel (taranmış PDF / vision girişi)

\`\`\`js
// pdf-gorsel.js → node pdf-gorsel.js dosya.pdf [sayfaNo]
const fs = require('fs');
const { pdf } = require('pdf-to-img');
(async () => {
  const doc = await pdf(process.argv[2], { scale: 2 });
  const n = Number(process.argv[3]) || 1;
  const png = await doc.getPage(n);
  fs.writeFileSync('sayfa-' + n + '.png', png);
  console.log('sayfa-' + n + '.png yazıldı (' + doc.length + ' sayfa toplam)');
  doc.destroy();
})();
\`\`\`
@napi-rs/canvas hazır binary gelir — derleme gerektirmez.

## 5. OCR (taranmış PDF'den metin)

Önce 4. adımla PNG üret, sonra:

\`\`\`js
// ocr.js → node ocr.js sayfa-1.png [dil=tur]
const { createWorker } = require('tesseract.js');
(async () => {
  const worker = await createWorker(process.argv[3] || 'tur');
  try {
    const { data } = await worker.recognize(process.argv[2]);
    console.log(data.text.trim());
  } finally { await worker.terminate(); }
})();
\`\`\`
İlk çağrıda dil verisi (~15MB) internetten indirilir — sonra offline çalışır.

## Eğitim akışı (ders notu → özet/quiz)

1. Notu oku: \`read_file\`; boşsa taranmıştır → adım 4 + 5
2. Konuları/ayrım noktalarını çıkar, anahtar kavramları listele
3. Quiz/özeti 2. adım deseniniyle PDF olarak oluştur (Türkçe font ZORUNLU)
4. Çıktı yolunu kullanıcıya bildir. Büyük PDF'lerde \`read_file\` çıktısı kırpılır — bölüm bölüm oku.

## Hata giderme

| Belirti | Çözüm |
|---|---|
| API version ... does not match Worker version ... | pdfjs tabanlı iki paket aynı process'te — ayrı script/process kullan |
| ğ/ş/ı harfleri kayıp veya kutu kutu | standard font yerine C:/Windows/Fonts/arial.ttf embed et |
| read_file boş metin döndü | taranmış PDF → 4. adım (görselleştir) + 5. adım (OCR) |
| tesseract dil verisi hatası | ilk indirme internet ister; tekrar dene |`,
  },
];

function writeSeed(seed) {
  try {
    const p = path.join(dir(), seed.folder);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'SKILL.md'), seed.body);
  } catch {}
}

/* Kaldırılan eski tohumlar: kullanıcı makinesinden de silinir */
const RETIRED_SEEDS = ['free-web-search'];

function seedIfEmpty() {
  if (!scan().length) {
    for (const seed of SEEDS) writeSeed(seed);
  } else {
    /* force tohumlar her açılışta güncellenir: varsayılan web arama skill'inin
       içeriği hep güncel kalır (mevcut kurulum dahil) */
    for (const seed of SEEDS) {
      if (seed.force) writeSeed(seed);
    }
  }
  for (const name of RETIRED_SEEDS) {
    try { fs.rmSync(path.join(dir(), name), { recursive: true, force: true }); } catch {}
  }
}

/* ---------- taslaklar (deneyimden doğan skill adayları) ---------- */

function draftsDir() {
  return path.join(dir(), '.drafts');
}

function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[çğıöşü]/g, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' }[c] || c))
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'taslak'
  );
}

/* Yansımadan doğan taslağı kaydet; aynı isim varsa üzerine yazar (revize). */
function addDraft({ name, description, body }) {
  try {
    const nm = String(name || '').trim() || 'yetenek';
    const folder = slugify(nm);
    const d = draftsDir();
    fs.mkdirSync(d, { recursive: true });
    const file = path.join(d, folder + '.draft.md');
    const text =
      `---\nname: ${nm}\ndescription: ${String(description || '').trim().slice(0, 160)}\nstatus: draft\ngeneratedAt: ${new Date().toISOString()}\n---\n\n` +
      String(body || '').trim() +
      '\n';
    fs.writeFileSync(file, text);
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function listDrafts() {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(draftsDir(), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.draft.md')) continue;
    const p = path.join(draftsDir(), e.name);
    try {
      const text = fs.readFileSync(p, 'utf8');
      const fm = parseFrontmatter(text);
      out.push({
        id: e.name.replace(/\.draft\.md$/, ''),
        name: fm.name || e.name,
        description: fm.description || '',
        generatedAt: fm.generatedAt || '',
        body: text,
      });
    } catch {}
  }
  return out;
}

function acceptDraft(id) {
  try {
    const src = path.join(draftsDir(), String(id) + '.draft.md');
    const destDir = path.join(dir(), slugify(String(id)));
    fs.mkdirSync(destDir, { recursive: true });
    let text = fs.readFileSync(src, 'utf8');
    /* status: draft satırını kaldır — artık kurulu skill */
    text = text.replace(/^status:\s*draft\r?\n/mi, '');
    fs.writeFileSync(path.join(destDir, 'SKILL.md'), text);
    fs.unlinkSync(src);
    return { ok: true, folder: path.basename(destDir), path: path.join(destDir, 'SKILL.md') };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function dropDraft(id) {
  try {
    fs.unlinkSync(path.join(draftsDir(), String(id) + '.draft.md'));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* OTOMATIK SKILL SİSTEMİ: yansımadan doğan prosedürü DOĞRUDAN kurulu skill olarak
   yazar (taslak onayı beklemeden). Aynı isimde skill varsa GÜNCELLENİR:
   eski içerik .bak'a alınır, created korunur, updated damgası vurulur. */
function upsertSkill({ name, description, body }) {
  try {
    const nm = String(name || '').trim() || 'yetenek';
    const folder = slugify(nm);
    const d = path.join(dir(), folder);
    const file = path.join(d, 'SKILL.md');
    fs.mkdirSync(d, { recursive: true });
    let fm = `---\nname: ${nm}\ndescription: ${String(description || '').trim().slice(0, 160)}\n`;
    let updated = false;
    if (fs.existsSync(file)) {
      const old = fs.readFileSync(file, 'utf8');
      const oldFm = parseFrontmatter(old);
      fm += `created: ${oldFm.created || oldFm.generatedAt || new Date().toISOString()}\n`;
      fs.writeFileSync(file + '.bak', old);
      updated = true;
    }
    fm += `updated: ${new Date().toISOString()}\n---\n\n`;
    fs.writeFileSync(file, fm + String(body || '').trim() + '\n');
    return { ok: true, folder, file, updated };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* Kurulu bir skill'e madde ekler (#3 kural hattı): "## Kurallar" altına yazılır. */
function appendRuleToSkill(nameOrFolder, ruleText) {
  try {
    const all = scan();
    const needle = String(nameOrFolder || '').trim().toLowerCase();
    const hit = all.find((s) => s.name.toLowerCase() === needle) ||
      all.find((s) => s.path.toLowerCase().includes(needle)) ||
      null;
    if (!hit) return { ok: false, error: `skill bulunamadı: ${nameOrFolder}` };
    let text = fs.readFileSync(hit.path, 'utf8');
    const line = `- ${String(ruleText || '').trim()}\n`;
    if (/^##\s*Kurallar/im.test(text)) {
      text = text.replace(/^(##\s*Kurallar\s*)$/im, `$1\n${line}`);
    } else {
      text = text.trimEnd() + `\n\n## Kurallar\n${line}`;
    }
    fs.writeFileSync(hit.path, text);
    return { ok: true, skill: hit.name, path: hit.path };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  dir,
  scan,
  seedIfEmpty,
  parseFrontmatter,
  addDraft,
  listDrafts,
  acceptDraft,
  dropDraft,
  appendRuleToSkill,
  upsertSkill,
};
