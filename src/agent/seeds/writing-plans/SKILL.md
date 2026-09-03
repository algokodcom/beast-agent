---
name: writing-plans
description: Çok adımlı bir iş için spec/gereksinim hazır olduğunda, KODA DOKUNMADAN ÖNCE kullan — implementasyon planı yazılacak her durumda.
---

# Plan Yazma

## Genel Bakış

Sıfır bağlama sahip, zevki şüpheli bir mühendisin takip edebileceği kapsamlı
implementasyon planı yaz. Her görevin hangi dosyalara dokunacağını, kodu,
testi, nasıl test edileceğini belgele. Planı ısırık büyüklüğünde adımlara böl.
DRY. YAGNI. TDD. Sık commit.

Yetenekli ama arac setini ve problem alanını neredeyse hiç bilmeyen biri
olduğunu varsay. Plan o kişinin eline tek başına geçmeli.

**Planları buraya kaydet:** `<workspace>/docs/plans/YYYY-MM-DD-<özellik-adı>.md`
(write_file ile; klasör yoksa oluşur)

## Kapsam Kontrolü

Spec birden fazla bağımsız alt sistemi kapsıyorsa ayrı planlara böl — her biri
tek başına çalışan, test edilebilir yazılım üretmeli.

## Dosya Yapısı

Görevleri tanımlamadan önce hangi dosyaların oluşacağı/değişeceğinin ve
her birinin sorumluluğunun haritasını çıkar. Kararlar burada kilitlenir:

- Net sınırlı, tek sorumlu dosyalar; birlikte değişenler yan yana
- Küçük odaklı dosyalar tercih et — bağlamında tutabildiğin ve edit'inin
  güvenilir olduğu yapı budur
- Mevcut kod tabanında yerleşik deseni takip et; tek taraflı yeniden yapılandırma

## Görev Ölçüsü

Görev = kendi test döngüsünü taşıyan, bağımsız doğrulanabilir en küçük birim.
Kurulum/scaffolding adımlarını, çıktısı onlara ihtiyaç duyan görevin içine kat.
İki görevi ayır: birinci reddedilirken ikincisi onaylanabilir mi?

## Isırık Büyüklüğünde Adımlar

Her adım TEK eylem (2-5 dakika):

- "Başarısız testi yaz" — adım
- "Çalıştır, fail olduğunu gör" — adım
- "Testi geçecek minimal kodu yaz" — adım
- "Testleri çalıştır, geçtiğini gör" — adım
- "Commit" — adım

## Plan Dosyası Başlığı

**Her plan bu başlıkla başlamalı:**

```markdown
# [Özellik Adı] Implementasyon Planı

> **Ajan işçiler için:** GÖREV BAŞINA taze alt-ajan: subagent-driven-development
> (önerilen, CEO modunda) veya executing-plans kullan. Adımlar checkbox (- [ ])
> sözdizimiyle takip edilir.

**Hedef:** [Bu planın ürettiği şey — tek cümle]

**Mimari:** [Yaklaşım — 2-3 cümle]

**Teknoloji:** [Önemli teknoloji/kütüphaneler]

**Spec:** [Varsa spec/design dosyasının yolu — plan spec'ten hareket eder]

## Global Kısıtlar

[Proje geneli şartlar — sürüm sınırları, bağımlılık sınırları, isim kuralları,
platform şartları — spec'ten BİREBİR kopyalanmış değerlerle, her biri tek satır.
Her görev bu bölümü örtük olarak içerir.]

---
```

## Görev Yapısı

````markdown
### Görev N: [Bileşen Adı]

**Dosyalar:**
- Oluştur: `tam/yol/dosya.js`
- Değiştir: `tam/yol/mevcut.js:123-145`
- Test: `tests/tam/yol/dosya.test.js`

**Arayüzler:**
- Tüketir: [önceki görevlerden kullandığı — tam imzalar]
- Üretir: [sonraki görevlerin dayandığı — tam fonksiyon adları, parametre ve
  dönüş tipleri. Bir görevin implementeri SADECE kendi görevini görür;
  komşu görevlerin adlarını/tiplerini buradan öğrenir.]

- [ ] **Adım 1: Başarısız testi yaz**

```js
test('boş e-postayı reddeder', () => {
  expect(submitForm({ email: '' }).error).toBe('Email gerekli');
});
```

- [ ] **Adım 2: Fail olduğunu doğrula**

Çalıştır: `node --test tests/dosya.test.js`
Beklenen: FAIL — "submitForm is not defined"

- [ ] **Adım 3: Minimal implementasyon**

```js
function submitForm(data) {
  if (!data.email?.trim()) return { error: 'Email gerekli' };
}
```

- [ ] **Adım 4: Geçtiğini doğrula**

Çalıştır: `node --test tests/dosya.test.js`
Beklenen: PASS

- [ ] **Adım 5: Commit**

```bash
git add tests/dosya.test.js src/dosya.js
git commit -m "feat: boş e-postayı reddet"
```
````

## Placeholder YASAK

Her adım mühendisin ihtiyacı olan GERÇEK içeriği taşır. Bunlar **plan
hatasıdır** — asla yazma:

- "TBD", "TODO", "sonra doldur", "detayları tamamla"
- "Uygun hata yönetimi ekle" / "kenar durumları handle et"
- "Yukarıdakine test yaz" (test kodu olmadan)
- "Görev N'ye benzer" (kodun kendisini yaz — mühendis görevleri sırasız okuyabilir)
- Ne yapılacağını söyleyip nasılını göstermeyen adımlar (kod adımı = kod bloğu)
- Hiçbir görevde tanımlanmamış tip/fonksiyon referansı

## Öz-Denetim

Planı bitirince spec'i taze gözle kontrol et (kendi checklist'in):

1. **Spec kapsamı:** Spec'in her bölümü için hangi görev implemente ediyor?
   Boşlukları listele, görev ekle.
2. **Placeholder taraması:** Yukarıdaki kırmızı desenleri kendi planında ara, düzelt.
3. **Tip tutarlılığı:** Görev 3'te `clearLayers()` diye çağırdığın şey Görev 7'de
   `clearFullLayers()` olmasın. İmzalar birebir eşleşmeli.

Sorun bulursan yerinde düzelt, tekrar tekrar dolaşma.

## Teslim

Plan kaydedildikten sonra yürütme seçeneği sun:

**"Plan `<yol>`'e kaydedildi. İki seçenek:**
**1. Alt-Ajan Destekli (önerilen)** — her görev için taze paralel ajan
(run_background), görevler arası inceleme; CEO modunda birebir
**2. Satır İçi** — bu oturumda executing-plans ile, checkpoint'li seri yürütme
**Hangisi?"**
