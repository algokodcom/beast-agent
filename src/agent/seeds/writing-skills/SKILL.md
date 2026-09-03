---
name: writing-skills
description: Yeni skill oluştururken, mevcut skill düzenlerken veya deploy öncesi doğrularken kullan — %APPDATA%\beast\skills altına SKILL.md yazılacak/herhangi bir edit olacaksa.
---

# Skill Yazma

## Genel Bakış

**Skill yazmak, süreç dokümantasyonuna uygulanan TDD'dir.**

Test senaryoları yaz (paralel ajanla baskı senaryosu), fail izle (baseline
davranış), skill'i yaz (doküman), geçiş izle (ajan artık uyuyor), refactor
(loophole kapat).

**Çekirdek ilke:** Skill'siz ajanın fail ettiğini izlemediysen, skill'in
doğru şeyi öğrettiğini bilmezsin.

**ZORUNLU TEMEL:** test-driven-development skill'ini anlıyor olmalısın —
o RED-GREEN-REFACTOR'ü tanımlar, bu skill onu dokümana uyarlar.

## Skill Nedir?

**Skill:** Kanıtlanmış teknik, desen veya araç için referans rehber.
**Skill'dir:** Yeniden kullanılabilir teknik/pattern/araç/rehber.
**Skill değildir:** Bir problemi bir kez nasıl çözdüğüne dair hikâye.

## Ne Zaman Skill Yaratılır

**Yarat:**
- Teknik sana sezgisel gelmediyse
- Projeler arası tekrar referans edeceksen
- Desen genelse (proje-özel değilse)

**Yaratma:**
- Tek seferlik çözümler için
- Başka yerde iyi dokümante edilmiş standart pratikler için
- Proje-özel konvansiyonlar (onlar AGENTS.md'ye/proje talimatına)
- Regex/validasyonla zorlanabilir mekanik kısıtlar (otomatikleştir —
  dokümanı yargı gerektiren kararlara sakla)

## Beast'te Skill Yapısı

Yer: `%APPDATA%\beast\skills\<slug>\SKILL.md` (write_file ile yaz; slug
küçük-harf-tire). Isim+açıklama HER SOHBETE system prompta girer — gövde
sadece ilgiliyken read_file ile okunur.

```markdown
---
name: skill-adi
description: [TETİKLEYİCİ — ne zaman okunmalı; aşağıya bak]
version: 1.0.0
---

# Skill Adı

## Genel Bakış
Bu ne? Çekirdek ilke 1-2 cümle.

## Ne Zaman
Belirtiler ve kullanım durumları; ne zaman KULLANILMAZ

## Çekirdek Desen
Önce/sonra karşılaştırması veya adımlar

## Hızlı Referans
Sık işlemler için tablo

## Yaygın Hatalar
Ne yanlış gider + fix
```

**Frontmatter kuralları:**
- `name`: harf, rakam, tire (özel karakter yok)
- `description`: üçüncü şahıs, SADECE ne zaman kullanılacağını anlatır

## Skill Keşif Optimizasyonu (SDO)

**description = NE ZAMAN, ne YAPDIĞI değil.**

Test şunu gösterdi: description workflow'u özetlerse ajan TÜM skill'i
okumadan description'daki kısayolu uygular. Gövde, ajanın atladığı
dokümana döner.

```yaml
# ❌ KÖTÜ: workflow özetler — ajan gövdeyi okumadan bunu takip eder
description: Plan yürütürken kullan — görev başına alt-ajan devreder, aralarında inceleme yapar

# ✅ İYİ: sadece tetikleyici koşullar
description: Bağımsız görevlere bölünmüş implementasyon planı yürütülürken kullan
```

- Somut tetikleyiciler, belirtiler ve durumlar yaz
- Sorunu tarif et (race condition, tutarsız davranış), dile özgü belirtiyi değil
- Arama kelimeleri kullan: hata mesajları, belirtiler ("flaky", "takılıyor"),
  araç adları
- Üçüncü şahıs yaz (system prompta enjekte edilir)

## Demir Kanun (TDD ile aynı)

```
FAILING TEST OLMADAN SKILL YOK
```

Bu YENİ skill'ler VE mevcut skill EDİTLERİ için geçerli. Test etmeden
skill yazdıysan: sil, baştan başla. "Basit ekleme" istisnası yok.

## RED-GREEN-REFACTOR (skill için)

### RED: Başarısız Test (Baseline)

Skill'siz ajanla baskı senaryosu çalıştır (run_background ile taze ajan —
sistem promptu skill'in yaşayacağı gerçek bağlam, kullanıcı mesajı hataya
çekecek görev olsun). Birebir belgele:
- Hangi seçimleri yaptı?
- Hangi bahaneleri kullandı (verbatim)?
- Hangi baskılar ihlale yol açtı?

### GREEN: Minimal Skill Yaz

Baseline'da belgelenen SPESİFİK bahaneleri karşılayan skill yaz. Hayali
durumlar için ekstra içerik EKLEME. Aynı senaryoyu skill ile tekrar koştur —
ajan artık uymalı.

### REFACTOR: Loophole Kapat

Ajan YENİ bahane buldu? Açık karşı-argüman ekle. Bulletproof olana kadar
tekrar test et.

**Mikro-test:** tam senaryo pahalıysa önce kelimelik test — tek taze örnek +
rehberli vs kontrolsüz (rehbersiz) karşılaştırma, 5+ tekrar, her eşleşmeyi
elle oku. Kontrol grupta hata YOKSA yazılacak rehber de yok — dur.

## Uyum Sağlamayı Ezberle (Disiplin Skill'leri)

Kural bilen ajan baskı altında atlarsa:

**Her loophole'u açıkça kapat** — kuralı söylemek yetmez, workaround'ları
tek tek yasakla:

```markdown
Testten önce kod yazdıysan: SİL. Baştan başla.

**İstisna yok:**
- "Referans olarak" tutma
- Testleri yazarken uyarlama
- Silmek silmektir
```

**"Ruh vs harf" argümanını baştan kes:**

```markdown
**Kuralın harfini ihlal etmek, kuralın ruhunu ihlal etmektir.**
```

**Bahane tablosu kur** — baseline testten çıkan HER bahane:

```markdown
| Bahane | Gerçek |
|---|---|
| "Test etmek için çok basit" | Basit kod da kırılır. Test 30 saniye. |
```

**Kırmızı bayrak listesi** — ajanın kendini kontrolü kolay olsun:

```markdown
## Kırmızı Bayraklar — DUR
- "Sadece bu sefer" bahanesi
- "Elle test ettim zaten"

**Hepsi: kodu sil, TDD ile baştan başla.**
```

## Kalıbı Hatanın Türüne Eşle

| Baseline hatası | Doğru kalıp | Yanlış kalıp |
|---|---|---|
| Baskı altında kuralı atlıyor | Yasak + bahane tablosu + kırmızı bayraklar | Yumuşak yönlendirme ("tercih et", "düşün") |
| Uyuyor ama çıktı yanlış biçimde | Pozitif reçete: çıktı NE — parçaları ve sırasıyla | Yasak listesi |
| Zaten ürettiği şeyden eleman eksitiyor | Şablon REQUIRED alanı | Şablon yanına prose hatırlatma |
| Davranış koşula bağlı olmalı | Gözlenebilir koşullu ("brief varsa ona atıf yap") | Koşulsuz kural + istisna cümleleri |

Yasaklar, şekillendirme sorunlarında TERS TEPER — "X yapma" pazarlığa
açık kalır; reçete pazarlık bırakmaz: çıktı ya söylenen kalıptadır ya değil.

**Seçtiğin kalıp için:** nüans cümlesi YOK ("X yapma, önemliyse hariç"
pazarlığı yeniden açar).

## Token Verimliliği (Kritik)

Skill gövdesi okunduğunda bağlama girer:

- Sık yüklenen skill'ler: <200 kelime hedef
- Diğerleri: <500 kelime (yine de öz ol)
- Detayları araç yardımına bırak; cross-referans kullan ("ZORUNLU:
  test-driven-development skill'ini kullan" — içerik tekrarı yok)
- Tek mükemmel örnek, çok vasat örnekten iyi
- Yeniden kullanılabilir ağır referans (100+ satır) ayrı dosyaya
  (`SKILL.md` yanına `referans.md`), inline ilkeler/prensipler kalır

## Anti-Desenler

- ❌ **Hikâye anlatımı:** "2025-10-03 oturumunda empty projectDir yüzünden..."
  — çok spesifik, yeniden kullanılamaz
- ❌ **Çok-dil sulandırma:** example-js.js + example-py.py + example-go.go
- ❌ **Anlamsız etiketler:** helper1, step3, pattern4

## Test Türüne Göre

| Skill türü | Test yöntemi | Başarı kriteri |
|---|---|---|
| Disiplin (kural dayatır: TDD, verification) | Baskı senaryosu: zaman+sunk cost+baskı birleşik; bahaneleri yakala | Maksimum baskıda kurala uyar |
| Teknik (nasıl-yapılır) | Uygulama + varyasyon + eksik bilgi senaryoları | Tekniği yeni senaryoya doğru uygular |
| Desen (zihinsel model) | Tanıma + uygulama + karşı-örnek | Ne zaman uygulanacağını doğru bulur |
| Referans (API/komut dokümanı) | Erişim + uygulama + boşluk testi | Doğru bilgiyi bulur ve uygular |

## Deploy Etmeden ÖNCE

Her skill için (toplu üretimde her biri AYRI test edilmeden sonrakine geçme):

- [ ] Baseline (skill'siz) davranış birebir belgelendi
- [ ] description "ne zaman" tarzında, workflow özetlemiyor
- [ ] name kurallara uygun, dosya `%APPDATA%\beast\skills\<slug>\SKILL.md`
- [ ] Skill ile senaryo artık geçiyor
- [ ] Yeni bahaneler bulunduysa karşıları eklendi, tekrar test edildi
- [ ] Bahane tablosu + kırmızı bayraklar var (disiplin skill'i ise)
- [ ] `/skills` listesinde görünüyor, okunabilirlik kontrol edildi

Deploy edilmemiş skill = deploy edilmemiş kod. Test et, sonra konuşlandır.
