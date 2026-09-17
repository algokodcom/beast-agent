---
name: typesafe-ai
description: TypeSafe System One (Jev) ile TİPLİ KARAR rehberi — semantik/olasılıklı yargıları (haber-makro etkisi, setup kalitesi, yön/aksiyon seçimi, tez doğrulama, sınıflandırma, yeniden sıralama) chat modeline metin yazdırıp JSON ayrıştırmak yerine typesafe_decision aracıyla kalibre olasılıklı yanıt olarak al. Olasılık eşikleri, soru tasarımı (noul/choice/score), tek çağrıda çoklu soru ve hata yönetimi burada. Bir karar "evet/hayır", "hangisi" ya da "ne kadar" sorusuna indirgenebiliyorsa ÖNCE bu skill'i oku.
version: 1.0.0
---

# TypeSafe (System One · Jev) — Tipli Karar Rehberi

## NE ZAMAN KULLANILIR

Karar zaten bir soruya indirgenebiliyorsa ve cevap SAYIYLA (olasılık/puan) işe yarayacaksa `typesafe_decision` kullan. Chat modeli cevap metni yazar; sen metni tekrar yorumlarsın. TypeSafe metin üretmez — doğrudan `noul` (0-1 evet), `choice` (seçenek + dağılım), `score` (ağırlıklı puan + dağılım) döner. Bu daha hızlı, daha ucuz ve kalibrelidir.

KULLANMA: yaratıcı metin, uzun analiz yazısı, kod yazma, çok adımlı akıl yürütme (bunlar chat modelinin işi). TypeSafe tek, dar, bağımsız yargılar içindir.

## ARAÇ ÇAĞRISI

```
typesafe_decision {
  state: <tüm somut bağlam — haber metni, fiyat/seviye, pozisyon, geçmiş, politika>,
  questions: {
    <id>: { type: "noul", instructions: "Bu haber X'i yukarı iter mi?", criteria: { true: "...", false: "..." } },
    <id>: { type: "choice", instructions: "Bu setup için doğru aksiyon?", criteria: { al: "...", bekle: "...", pas: "..." } },
    <id>: { type: "score", instructions: "Setup kalitesi?", criteria: ["Çöp", "Zayıf", "Orta", "İyi", "A sınıfı"] }
  }
}
```

- `state`: model YALNIZ bunu görür. Eksik bağlam = kötü karar. Sembol, fiyat, seviyeler, haber metninin kendisi, pozisyon ve risk bilgisini koy. Nesne/dizi de verebilirsin (ör. `{ sembol, fiyat, mtfYapi, haber, pozisyon }`).
- Soru id'leri kod içindir; modele gitmez — anlamı `instructions` içinde tam yaz.
- `criteria`: choice → `{seçenek: açıklama|null}` (en az 2), score → sıralı `["seviye1", ...]` (en az 2), noul → `{true, false}` açıklamaları (opsiyonel ama önerilir).
- BAĞIMSIZ soruları TEK çağrıda birlikte sor: her soru ayrı token/gecikme demektir; toplu soru aynı state'i bir kez okur.

## SORU TASARIMI

- Soru BAŞINA tek yargı: "hem yön hem zamanlama" sorma; iki soru yap. Bağımsız boyutları ayır, ilişkiyi bozma.
- Bir sonraki soru önceki cevaba bağlıysa ikinci çağrı yap (önce yön: noul → sonra giriş bölgesi: choice).
- "Yok/eşleşme yok" ihtimali gerçekse choice'a `yok` seçeneği ekle.
- Spekülatif soruları da sor: aynı state üzerinde "şu senaryo gerçekleşirse..." yargısı bedava gelir, kod yalnız gerekenini kullanır.

## OLASILIKLARI YORUMLAMA

- noul: 0.5 = bilgi yok denecek kadar belirsiz (yoğunluk değil). >0.65 güçlü kanaat, <0.35 karşı yön güçlü, 0.35-0.65 → temkinli davran / ek teyit ara / küçük risk.
- choice/score `confidence`: dağılımın yoğunluğu — workfloun doğruluğu DEĞİL, aksiyon izni DEĞİL. Düşük confidence'ta kesin konuşma, olasılıkları raporla.
- Eşikleri işlemin/kararın SONUCUNA göre seç: geri dönüşü kolay kararda 0.55 yeter; para/risk kararında 0.7+ ve teyit ara.
- Sayıları kararına YAZ: "javAX: noul=0.78, yön yukarı; kalite score=3.4/5" gibi. Gerekçesiz "TypeSafe öyle dedi" yasak — birincil veriyle (fiyat/yapı/haber) çapraz kontrol et.

## BEAST FINANCE ÖRNEKLERİ

- Haber etkisi: `noul` — "Bu haber X'i kısa vadede yukarı iter mi?" state: haber metni + sembol + mevcut yapı.
- Aksiyon seçimi: `choice` — `{gir, bekle_geri_cek, pas}` state: setup + risk limitleri + açık pozisyonlar.
- Setup kalitesi: `score` — levels: `["Çöp","Zayıf","Orta","İyi","A sınıfı"]`; >3.5 değilse riski düşür.
- Tez doğrulama: `noul` — "Fiyat yapısı bu LONG tezini destekliyor mu?" state: tez + son mumlar/OHLC özeti.
- Haber-tekrar filtresi: `noul` — "Bu haber son 24 saatte fiyatlanmış mı?" state: manşet + fiyat değişimi.

## HATA YÖNETİMİ

- "API anahtarı yok" → kullanıcıya Ayarlar → TypeSafe'ten anahtar girmesini söyle; o turda kendi analizinle devam et, aracı zorlama.
- 401/403 → anahtar geçersiz; 429/529 → bekle, kritik değilse atla (tekrar denemeyi turu kilitlemeden yap).
- 422 → questions/state biçimini düzelt (choice criteria nesne, score dizi olmalı).
- Anahtarını asla rapor/log/skill metnine YAZMA — Ayarlar → TypeSafe girer.
