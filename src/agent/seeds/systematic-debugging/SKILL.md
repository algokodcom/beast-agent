---
name: systematic-debugging
description: Herhangi bir bug, test hatası, beklenmedik davranış, build/entegrasyon sorunuyla karşılaştığında — ÇÖZÜM ÖNERMEDEN ÖNCE kullan; kök neden araştırması yapılmadan düzeltme denemesi yasak.
---

# Sistematik Hata Ayıklama

## Çekirdek ilke

**Her zaman kök nedeni bul, sonra düzelt. Belirtiye yama = başarısızlık.**

**Bu sürecin harfini ihlal etmek, ruhunu ihlal etmektir.**

## Demir Kanun

```
KÖK NEDEN ARAŞTIRMASI OLMADAN DÜZELTME YOK
```

Faz 1 tamamlanmadıysa çözüm öneremezsin.

## Ne Zaman

Her teknik sorun: test hataları, prod bug'ları, beklenmedik davranış,
performans sorunları, build/entegrasyon hataları.

ÖZELLİKLE şunlarda kullan:
- Zaman baskısı varken (acele tahmini cezbeder)
- "Hızlı bir tek düzeltme" çok bariz görünüyorken
- Birden fazla düzeltme denedin ve olmadıysa

Basit görünen sorunlarda da atlama — basit bug'ların da kök nedeni var.

## Dört Faz

Her fazı bitirmeden sonrakine geçemezsin.

### Faz 1: Kök Neden Araştırması

HİÇBİR düzeltmeden ÖNCE:

1. **Hata mesajlarını DİKKATLE oku** — stack trace'i tamamen oku; satır
   numarası, dosya yolu, hata kodu not al. Çözüm genelde mesajın içindedir.
2. **Tutarlı şekilde yeniden üret** — güvenilir tetikleyebiliyor musun?
   Adımlar neler, her seferinde oluyor mu? Üretilemiyorsa veri topla, TAHMİN ETME.
3. **Son değişiklikleri kontrol et** — ne değişti? git diff, son commit'ler,
   yeni bağımlılık/config değişikliği.
4. **Çok bileşenli sistemlerde kanıt topla** — her bileşen sınırında ne
   girdiğini/ne çıktığını logla; HANGİ katmanın kırdığını gösteren tek bir
   kanıt çalıştırması yap, sonra o bileşeni incele.
5. **Veri akışını izle** — bozuk değer nereden kaynaklanıyor? Kim bu değeri
   gönderdi? Kaynağa kadar yukarı çıkar; kaynağında düzelt, belirtide değil.

### Faz 2: Desen Analizi

1. **Çalışan örnek bul** — aynı kod tabanında benzer ama ÇALIŞAN kod nerede?
2. **Referansla karşılaştır** — bir desen uyguluyorsan referans implementasyonu
   TAMAMEN oku (göz gezdirme yok).
3. **Farkları listele** — çalışanla bozuk arasındaki her farkı, ne kadar küçük
   olursa olsun yaz. "Bu fark önemli olamaz" deme.
4. **Bağımlılıkları anla** — hangi bileşen/ayar/ortam varsayımlarına dayanıyor?

### Faz 3: Hipotez ve Test

Bilimsel yöntem:

1. **Tek hipotez kur** — "X kök neden, çünkü Y" diye net yaz. Spesifik ol.
2. **Minimal test et** — hipotezi test eden EN KÜÇÜK değişikliği yap. Tek
   değişken. Birden fazla şeyi birden düzeltme.
3. **Devam etmeden doğrula** — oldu mu → Faz 4. Olmadı mı → YENİ hipotez;
   üstüne yama EKLEME.
4. **Bilmiyorsan söyle** — "X'i anlamıyorum" de; araştır, yardım iste.

### Faz 4: Uygulama

1. **Başarısız test üret** — en basit yeniden üretim; test framework varsa
   otomatik test, yoksa tek seferlik script (test-driven-development skill'i
   ilerler). Düzeltmeden ÖNCE şart.
2. **Tek düzeltme uygula** — belirlenen kök nedeni hedefle; "buradayken şu da"
   iyileştirmesi YOK, paket refactoring YOK.
3. **Düzeltmeyi doğrula** — test geçti mi? Başka testler kırıldı mı? Sorun
   gerçekten çözüldü mü? Başarı iddiasından önce verification-before-completion.
4. **Düzeltme işe yaramadıysa:** DUR. Kaç düzeltme denedin say. 3'ten azsa →
   Faz 1'e dön, yeni bilgiyle yeniden analiz et. 3 ve üzeriyse → mimariyi
   sorgula (aşağıda).

### 3+ Düzeltme Başarısızsa: Mimaride Hata Var

Desen: her düzeltme başka yerde yeni sorun çıkarıyor; düzeltmeler "büyük
refactoring" istiyor; her fix yeni belirti üretiyor.

DUR ve temel soruları sor: Bu desen sağlam mı? Devam etmek atalet mi?
Mimariyi refactor etmek mi, belirti düzeltmeye devam etmek mi? Kullanıcıya
danışmadan 4. düzeltmeyi deneme. Bu başarısız hipotez değil — yanlış mimaridir.

## Kırmızı Bayraklar — DUR ve Sürece Dön

Kendini şöyle düşünürken yakalarsan:

- "Şimdilik hızlı bir fix, sonra bakarız"
- "X'i değiştirip bakalım" (araştırma olmadan)
- "Birden fazla değişiklik yapayım, testleri çalıştırırım"
- "Testi atlayayım, elle doğrularım"
- "Muhtemelen X'tir, onu düzelteyim"
- "Tam anlamıyorum ama bu işe yarayabilir"
- Veri akışını izlemeden çözüm listesi sunmak
- 2+ başarısız denemeden sonra "bir fix daha"
- Her fix başka yerde yeni sorun açıyor

**Hepsi aynı anlama gelir: DUR. Faz 1'e dön.**

## Yaygın Bahaneler

| Bahane | Gerçek |
|---|---|
| "Sorun basit, sürece gerek yok" | Basit sorunların da kök nedeni var; süreç basitte hızlıdır. |
| "Acil, süreç için vakit yok" | Sistematik hata ayıklama, tahmin-check döngüsünden HIZLIDIR. |
| "Önce şunu deneyeyim, sonra araştırırım" | İlk fix deseni belirler; baştan doğru yap. |
| "Testi fix işe yaradıktan sonra yazarım" | Testsiz fix kalıcı değildir; test önce kanıtlar. |
| "Birden çok fixi birden yapsam zaman kazanırım" | Neyin işe yaradığını izole edemezsin; yeni bug üretir. |
| "Referans çok uzun, uyarlarım" | Kısmi anlayış bug garantidir. Tamamını oku. |
| "Sorunu görüyorum, düzelteyim" | Belirti görmek ≠ kök nedeni anlamak. |

## Hızlı Referans

| Faz | Anahtar işler | Başarı kriteri |
|---|---|---|
| 1. Kök neden | Hata oku, üret, değişiklikleri kontrol et, kanıt topla | NE ve NEDEN'i anladın |
| 2. Desen | Çalışan örnek bul, karşılaştır | Farkları belirledin |
| 3. Hipotez | Teori kur, minimal test et | Doğrulandı veya yeni hipotez |
| 4. Uygulama | Test üret, tek fix, doğrula | Bug çözüldü, testler geçti |
