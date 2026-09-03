---
name: verification-before-completion
description: İşin bitti/düştü/geçti diye bildirmeden ÖNCE kullan — herhangi bir tamamlama iddiasından hemen önce; komutu çalıştırıp çıktısıyla kanıtlamadan başarı beyanı yasak.
---

# Tamamlamadan Önce Doğrulama

## Çekirdek ilke

**Kanıt önce gelir, iddia sonra. Her zaman.**

**Kuralın harfini ihlal etmek, kuralın ruhunu ihlal etmektir.**

## Demir Kanun

```
TAZE DOĞRULAMA KANITI OLMADAN TAMAMLAMA İDDİASI YOK
```

Bu tur içinde doğrulama komutunu çalıştırmadıysan, geçtiğini söyleyemezsin.

## Kapı Fonksiyonu

Herhangi bir durum beyan etmeden / memnuniyet göstermeden ÖNCE:

1. **BELİRLE:** Bu iddiayı kanıtlayan komut nedir?
2. **ÇALIŞTIR:** Komutu TAM ve TAZE çalıştır (run_command) — önceki turun çıktısı geçersiz
3. **OKU:** Çıktının tamamını oku, exit code'a bak, hata sayısını say
4. **DOĞRULA:** Çıktı iddiayı destekliyor mu?
   - Hayır → gerçek durumu kanıtıyla bildir
   - Evet → iddiayı KANITLA birlikte bildir
5. **ANCAK O ZAMAN:** iddiada bulun

Bir adımı atlarsan doğrulamış değilsin, yalan söylüyorsundur.

## Yaygın İddia → Gerekli Kanıt

| İddia | Gerekli kanıt | Yetmez |
|---|---|---|
| Testler geçti | Test çıktısı: 0 failure | Önceki tur, "geçer herhalde" |
| Linter temiz | Linter çıktısı: 0 hata | Kısmi kontrol, çıkarım |
| Build başarılı | run_command: exit 0 | Linter geçti, loglar iyi görünüyor |
| Bug düzeltildi | Orijinal belirtinin testi: geçti | Kod değişti, düzeldi varsayımı |
| Ajan işi bitirdi | diff / tasks_list raporu eşleşiyor | Ajan "başarılı" dedi |
| Gereksinimler karşılandı | Madde madde kontrol listesi | Testler geçti |

## Kırmızı Bayraklar — DUR

- "Zaten çalıştırdım" (bu turda DEĞİLSE sayılmaz)
- "Geçmesi lazım", "kesin çalışır"
- Kodu değiştirip testi TEKRAR çalıştırmadan "düzeldi" demek
- Kısmi çıktıyla ("testlerin çoğu geçti") tamamlama iddiası
- Ajanın kendi "başarılı" raporunu doğrulamadan kullanıcıya aktarmak
- Çıktıyı okumadan exit code'a güvenmek

**Hepsi aynı anlama gelir: komutu çalıştır, çıktıyı oku, öyle bildir.**

## Paralel Ajan Notu

run_background ile devrettiğin işin raporu geldiğinde bu skill ÇİFT GEÇERLİ:
ajanın raporu bir iddiadır, kanıt değil. İddia görevle eşleşiyor mu?
Dosyalar gerçekten oluşmuş mu (list_dir/glob), komut gerçekten geçmiş mi
(task_status çıktısı)? Doğrulamadan kullanıcıya "bitti" deme.
