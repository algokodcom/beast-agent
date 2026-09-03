---
name: test-driven-development
description: Herhangi bir özellik veya bug fix uygulanırken, implementasyon kodu yazılmadan ÖNCE kullan — yeni özellik, davranış değişikliği, refactoring işlerinde test-önce disiplini zorunludur.
---

# Test-Driven Development (TDD)

## Genel Bakış

Önce testi yaz. Başarısız olduğunu İZLE. Geçecek minimal kodu yaz.

**Çekirdek ilke:** Testin başarısız olduğunu izlemediysen, doğru şeyi
test ettiğini bilmezsin.

**Kuralın harfini ihlal etmek, ruhunu ihlal etmektir.**

## Demir Kanun

```
BAŞARISIZ TEST OLMADAN PRODUCTION KODU YOK
```

Testten önce kod yazdıysan: SİL. Baştan başla.

**İstisna yok:**
- "Referans olarak tutma"
- Testleri yazarken "uyarlama"
- Bakma bile
- Silmek silmektir. Testten taze implemente et.

## Ne Zaman

**Her zaman:** yeni özellik, bug fix, refactoring, davranış değişikliği.

**İstisnalar (kullanıcıya sorarak):** atılacak prototipler, üretilmiş kod,
config dosyaları.

"Bu seferlik TDD'yi atlayayım" düşüncesi = bahane. DUR.

## RED-GREEN-REFACTOR

### RED — Başarısız Test Yaz

Bir minimal test yaz: ne OLMASI gerektiğini gösterir.

**Gereksinimler:**
- Tek davranış
- Açık isim (`retry 3 kereden sonra vazgeçer`, "retry works" değil)
- Gerçek kod (kaçınılmaz değilse mock yok)

### RED'i Doğrula — Başarısızlığını İZLE

**ZORUNLU. Asla atlama.**

```
run_command: node --test tests/ornek.test.js
```

Doğrula:
- Test FAIL ediyor (error değil)
- Hata mesajı beklenen
- Eksik özellik yüzünden fail ediyor (typo değil)

**Test hemen geçti?** Mevcut davranışı test ediyorsun. Testi düzelt.

**Test error verdi?** Hatayı düzelt, doğru şekilde fail edene kadar tekrar.

### GREEN — Minimal Kod

Testi geçecek EN BASİT kodu yaz. Fazla özellik, gereksiz opsiyon,
"şimdiyken ekleyiver" YOK (YAGNI).

### GREEN'i Doğrula — Geçişini İZLE

**ZORUNLU.** Aynı komutu çalıştır:
- Test geçiyor
- Diğer testler hâlâ geçiyor
- Çıktı temiz (hata/uyarı yok)

**Test fail?** Testi değil KODU düzelt.
**Başka testler fail?** Şimdi düzelt.

### REFACTOR — Temizle

Sadece yeşilken: tekrar eden kodu kaldır, isimleri iyileştir, helper çıkar.
Testleri yeşil tut. Davranış EKLEME. Sonra sonraki failing test ile tekrarla.

## İyi Test

| Nitelik | İyi | Kötü |
|---|---|---|
| Minimal | Tek şey. İsmi "ve" içeriyorsa böl. | `email ve domain ve boşluğu doğrular` |
| Açık | İsim davranışı tarif eder | `test1` |
| Niyet gösterir | İstenen API'yi sergiler | Kodun ne yapacağını gizler |

- Gerçek davranışa assert et, mock davranışına asla
- Test yazmadan önce: bu testi FAIL eden production değişikliğini adlandırabilmeliyim

## Yaygın Bahaneler

| Bahane | Gerçek |
|---|---|
| "Test etmek için çok basit" | Basit kod da kırılır. Test 30 saniye. |
| "Sonra yazarım" | Sonradan yazılan test hemen geçer — bu bir şey KANITLAMAZ. Yanlış şeyi test edebilir, hatırladığın kenar durumları kapsar, unuttuğunları kaçırır. |
| "Testler sonra da aynı hedefe ulaşır" | Test-sonra "bu ne yapıyor?"u cevaplar; test-önce "bu ne YAPMALI?"ı cevaplar. Kod zaten yazılmışken test ondan biaslanır. |
| "Elle test ettim zaten" | Elle test kayıpsız tekrarlanamaz, kenar durumları kanıtlamaz. |
| "X saat kaybolacak, silmesem iyi olur" | Batık maliyet yanılgısı. Güvenemediğin kodu tutmak asıl kayıp. |
| "Keşif gerek önce" | Tamam — keşfi at, TDD ile baştan başla. |
| "Test yazması zor = tasarım kötü" | Teste dinle. Test etmek zor = kullanmak zor. |
| "TDD yavaşlatır" | TDD pragmatik yoldur: commit öncesi yakalar, regresyonu önler, korkusuz refactor sağlar. "Pragmatik" kısayol = prod'da debug. |

## Kırmızı Bayraklar — DUR, Baştan Başla

- Testten önce kod
- Implementasyondan sonra test
- Test anında geçti
- Testin neden fail ettiğini açıklayamıyorsun
- "Sonraya" eklenen testler
- "Sadece bu sefer" bahanesi
- "Elle test ettim zaten"
- "Ruha uygun, ritüele değil"
- "Referans olarak tutarım"
- "X saat boşa gideydi"

**Hepsi aynı anlama gelir: Kodu sil. TDD ile baştan başla.**

## Doğrulama Listesi

İşi tamamlanmış saymadan önce:

- [ ] Her yeni fonksiyonun testi var
- [ ] Her testi implementasyondan ÖNCE fail izledim
- [ ] Her test beklenen sebeple fail etti
- [ ] Her test için minimal kod yazdım
- [ ] Tüm testler geçiyor, çıktı temiz
- [ ] Kenar durumları ve hatalar kapsamlı

Tüm kutular dolmuyorsa TDD'yi atladın. Baştan başla.

## Takıldığında

| Sorun | Çözüm |
|---|---|
| Nasıl test edeceğimi bilmiyorum | İstediğin API'yi yaz, assertion'la başla, kullanıcıya sor |
| Test çok karmaşık | Tasarım karmaşık demektir. Arayüzü sadeleştir. |
| Her şeyi mock'lamam gerek | Kod fazla coupled. Bağımlılık enjeksiyonu kullan. |
| Test kurulumu devasa | Helper çıkar. Hâlâ karmaşıksa tasarımı sadeleştir. |

## Bug Bulunduğunda

Bug'ı yeniden üreten FAILING test yaz → TDD döngüsü → test hem fix'i
kanıtlar hem regresyonu önler. Testsiz bug fixi ASLA yapma.
