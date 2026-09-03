---
name: dispatching-parallel-agents
description: Birbirinden bağımsız 2+ iş aynı anda yapılabilecekken kullan — farklı alt sistemlerdeki hatalar, farklı araştırmalar, farklı dosyalar; işler sıra gerektirmeden ve ortak durum paylaşmadan yürüyebiliyorsa.
---

# Paralel Ajan Devri

## Genel Bakış

İşleri, bağlamı İZOLE alt-ajanlara devredersin. Talimatlarını ve
bağlamını hassas kurarak odaklarını ve başarısını garanti edersin. Onlar
senin oturum bağlamını asla görmez — ihtiyaç duydukları her şeyi SEN
inşa edersin. Bu, kendi bağlamını koordinasyon işine saklar.

**Çekirdek ilke:** Bağımsız her problem alanı için bir ajan. Paralel koştur.

## Ne Zaman

**Kullan:**
- Farklı kök nedenli 3+ test hatası
- Birbirinden bağımsız kırılmış alt sistemler
- Her sorun diğerinin bağlamı olmadan anlaşılabilir
- Araştırmalar arasında ortak durum yok

**Kullanma:**
- Hatalar ilişkiliyse (biri düzelince diğerleri de düzelebilir) — birlikte incele
- Tam sistem durumunu görmek gerekiyorsa
- Ajanlar birbirine karışacaksa (aynı dosyaları düzenliyorlarsa)

## Desen

### 1. Bağımsız Alanları Belirle

Sorunları neyin kırıldığına göre grupla:
- test-a.test.js: onay akışı
- test-b.test.js: batch tamamlama
- test-c.test.js: iptal davranışı

Her alan bağımsız — onay fix'i iptal testlerini etkilemez.

### 2. Odaklı Ajan Görevleri Yaz

Her ajana:
- **Spesifik kapsam:** tek dosya/alt sistem
- **Net hedef:** bu testler geçsin
- **Kısıt:** başka koda dokunma
- **Beklenen çıktı:** ne buldun + ne düzelttin özeti

### 3. Paralel Devret

Tüm devirleri AYNI cevapta ver — paralel koşarlar:

```
run_background: "tests/a.test.js'deki 3 hatayı düzelt ..."
run_background: "tests/b.test.js'deki 2 hatayı düzelt ..."
run_background: "tests/c.test.js hatasını düzelt ..."
```

Birden çok çağrı aynı turda = paralel. Tur başına bir çağrı = sıralı.
Bağımsız adımlar için `run_background_many` TEK ÇAĞRIDA fan-out yapar ve
bitince TEK birleşik rapor düşürür.

### 4. İncele ve Entegre Et

Ajanlar dönünce:
- Her özeti oku
- Fix'ler çakışıyor mu kontrol et (aynı kod düzenlenmiş mi?)
- Tam test suite'ini çalıştır — hepsi birlikte çalışıyor mu doğrula
- Ara sıra elle kontrol — ajanlar sistematik hata yapabilir

## Ajan Görev Metni Yapısı

İyi görev metinleri:
1. **Odaklı** — tek net problem alanı
2. **Kendine yeterli** — problemi anlamak için gereken TÜM bağlam
   (dosya yolları, hata mesajları, test isimleri — ajan senin sohbetini göremez)
3. **Çıktıya spesifik** — ajan ne döndürmeli?

```markdown
src/agents/abort.test.js'deki 3 hatayı düzelt:

1. "partial output ile abort" — 'interrupted at' bekleniyor
2. "mixed completed/aborted" — hızlı araç abort edilmedi
3. "pendingToolCount" — 3 beklenirken 0

Bunlar zamanlama/race sorunları. Görevin:
1. Test dosyasını oku, her testin ne doğruladığını anla
2. Kök nedeni bul — zamanlama mı, gerçek bug mı?
3. Düzelt:
   - Keyfi timeout'ları event-beklemeliyle değiştir
   - Bulunan gerçek bug'ları düzelt
   - Davranış değiştiyse test beklentisini güncelle

SADECE timeout artırma — gerçek sorunu bul.

Dönüş: ne bulduğun ve ne düzelttiğin özeti.
```

## Yaygın Hatalar

**❌ Çok geniş:** "tüm testleri düzelt" — ajan kaybolur
**✅ Spesifik:** "abort.test.js'yi düzelt" — odaklı kapsam

**❌ Bağlamsız:** "race condition'ı düzelt" — ajan nerede bilmiyor
**✅ Bağlamlı:** hata mesajlarını ve test isimlerini yapıştır

**❌ Kısıtsız:** ajan her şeyi refactor edebilir
**✅ Kısıtlı:** "sadece testleri düzelt, production koduna dokunma"

**❌ Belirsiz çıktı:** "düzelt" — ne değiştiğini bilemezsin
**✅ Spesifik:** "kök neden ve değişiklik özeti dön"

## Doğrulama

Ajanlar döndükten sonra:
1. **Her özeti incele** — ne değiştiğini anla
2. **Çakışma kontrolü** — ajanlar aynı kodu düzenledi mi?
3. **Tam suite çalıştır** — tüm fix'ler birlikte çalışıyor mu
4. **Rastgele kontrol** — ajan raporları iddiadır, kanıt değil
   (verification-before-completion)
