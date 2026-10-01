---
name: tool-yazma
description: Kişisel TOOL yazma/düzenleme rehberi — %APPDATA%\beast\tools\<ad>\ altına tool.json + run.js yazılacak veya mevcut bir tool editlenecekse ÖNCE bu skill'i oku. Tool'un sözleşmesi: stdin JSON argüman → stdout JSON sonuç; ajan tool__<ad> olarak çağırır (tüm oturumlarda çalışır).
version: 1.0.0
---

# Kişisel TOOL Yazma

## TOOL NEDİR / NE ZAMAN YAZILIR

Kişisel tool = modelin alet çantasına GİREN gerçek bir araçtır: %APPDATA%\beast\tools\<slug>\ klasöründe **tool.json** (tanım) + **run.js** (kod) bulunur. Tüm oturumlarda `tool__<slug>` adıyla çağrılır.

Yaz ZAMAN: mevcut araçlar işi görmüyorsa (örn. özel bir API'ye bağlanman), tekrarlı bir hesap/veri rutini gerekiyorsa. Basit işler için YAZMA — önce yerleşik araçları (web_search, python_run, run_command) dene.

## SÖZLEŞME (birebir uygula)

- **stdin**: JSON argümanlar (tek satırda, güvenli parse)
- **stdout**: SADECE JSON sonuç — son satır JSON'a çevrilmeye çalışılır; günlük/metin yazarsan JSON bozulur, `console.error` kullan
- **çalışma klasörü**: tool'un kendi klasörü (yanına dosya yazabilirsin)
- **zaman aşımı**: 90 sn — uzun işleri kendin parçalama, `run_background`'a devret
- **sonuç biçimi**: `{ "ok": true, ... }` ya da `{ "ok": false, "error": "sebep" }` — ok alanı ZORUNLU

## YENİ TOOL OLUŞTURMA (2 dosya, write_file ile)

`%APPDATA%\beast\tools\<slug>\tool.json`:
```json
{
  "name": "hava_durumu",
  "description": "Şehir için güncel hava durumunu döndürür — city alır; sonucu sıcaklık/durum ile döndürür.",
  "parameters": {
    "type": "object",
    "properties": {
      "city": { "type": "string", "description": "şehir adı" }
    },
    "required": ["city"]
  },
  "updatedAt": "2026-09-09T00:00:00.000Z"
}
```

`%APPDATA%\beast\tools\<slug>\run.js`:
```javascript
'use strict';
// stdin: JSON args · stdout: JSON sonuç (SADECE JSON yaz!)
const fs = require('fs');
let args = {};
try { args = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
(function main() {
  const { city } = args;
  if (!city) {
    console.log(JSON.stringify({ ok: false, error: 'city zorunlu' }));
    return;
  }
  // --- kendi işin burada: HTTP çağrısı, dosya, hesap... ---
  // Örn: https modülüyle özel endpoint'e istek at, sonucu ok alanıyla sar.
  console.log(JSON.stringify({ ok: true, city, sicaklik: 0 }));
})();
```

Slug kuralları: a-z, 0-9, alt çizgi, tire — 2-24 karakter (örn: hava_durumu, haber_ozet). Hazır taslak: %APPDATA%\beast\tools\ornek_echo klasörünü referans al; yeni tool'u o biçimle yaz.

## TEST DÖNGÜSÜ / YAYIN (zorunlu)

1. Mevcut toolu değiştirme: `edit_file` ile tool.json / run.js düzenle — ASLA tüm klasörü silip baştan yazma.
2. TEST: `run_command` ile `echo "{\"mesaj\":\"test\"}" | node "%APPDATA%\beast\tools\<slug>\run.js"` çalıştır (çalışma klasörü tool'un kendi klasörüdür) — çıktı SADECE JSON olmalı ve `ok` alanı içermeli.
3. DÖNGÜ: test `ok:true` DEĞİLSE stderr'i/hatayı oku → `edit_file` ile düzelt → YENİDEN test et. En fazla 5 deneme; her denemenin sonucunu not et.
4. YAYIN: yalnız test GEÇİNCE yayınla (dosyalar anında aktifleşir; `tool__<slug>` sonraki turda çağrılır) ve "YAYINDA" diye raporla. Test geçmeyen aracı yayınlama.
5. BAŞARISIZLIK: 5 denemede geçmezse yayınlama; rapora `ok:false + error` kök nedenini ve ne denediğini yaz — çıplak stack yasak.
6. ADIM RAPORU: final raporda adımları yaz (yazıldı → test → düzeltmeler → YAYINDA/BAŞARISIZ). `tool_request` ile gelen isteklerde bu rapor bağlı entegrasyonlara (WhatsApp/Telegram/Discord) otomatik bildirilir.

## GÜVENLİK + STİL

- Şifre/API anahtarını ASLA stdout'a, log'a, skill'e yazma.
- Ağ çağrılarında timeout kullan (`https` modülü + `req.setTimeout` veya fetch); sonsuz bekleyen script yazma.
- Tek sorumluluk: bir tool = bir iş. Çok işli dev tool yazma — parçala.
- Kullanıcıya tool'u nasıl yöneteceğini söyle: sol panelde TOOLLAR kutusunda test/düzenle/sil + 📂 klasör.
