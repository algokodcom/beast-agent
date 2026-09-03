---
name: executing-plans
description: Yazılı bir implementasyon planı bu oturumda uygulanacakken kullan — paralel ajan devri yapılmadan, plan adımları elle yürütülecekse.
---

# Plan Yürütme

## Genel Bakış

Planı yükle, eleştirel incele, tüm görevleri uygula, bitince raporla.

**Not:** CEO modu / paralel ajan mümkünse subagent-driven-development daha
iyi sonuç verir — bu skill ajan devrinin olmadığı düz yürütme içindir.

## Süreç

### Adım 1: Planı Yükle ve İncele
1. Plan dosyasını oku (ve varsa gösterdiği spec dosyasını)
2. Eleştirel incele — plan hakkında soru/tereddüt var mı?
3. Tereddüt varsa: BAŞLAMADAN kullanıcıya bildir
4. Yoksa: todo_write ile plan görevlerini aç ve başla

### Adım 2: Görevleri Uygula

Her görev için:
1. todo_write'ta in_progress yap
2. Her adımı plan yazdığı gibi uygula (plan ısırık adımlar taşır — atlamak yok)
3. Belirtilen doğrulamaları çalıştır (run_command — komut çıktısıyla)
4. done yap, sıradakine geç

### Adım 3: Bitiş

Tüm görevler tamam ve doğrulandığında:
- 1-3 satırlık özet rapor: ne yapıldı + doğrulama kanıtları (ör. "npm test ✓ 154/154")
- verification-before-completion: "bitti" demeden önce taze kanıt şart

## Ne Zaman Durup Sorulur

Hemen dur:
- Engel ile karşılaşırsan (eksik bağımlılık, test fail, belirsiz talimat)
- Plan başlamayı engelleyen kritik boşluk içeriyorsa
- Bir talimatı anlamıyorsan
- Doğrulama tekrar tekrar fail ediyorsa

**Tahmin etmek yerine sor.**

## Ne Zaman Önceki Adıma Dönülür

- Kullanıcı planı güncellerse → Adım 1'e dön
- Temel yaklaşımın yeniden düşünülmesi gerekiyorsa → Adım 1'e dön

Engellere zorla geçme — dur, sor.

## Hatırla

- Planı önce eleştirel incele
- Plan adımlarını birebir takip et
- Doğrulamaları atlama
- Kendi başına plan değiştirme — plan hatalıysa kullanıcıya bildirip karar al
- Hiçbir doğrulama "elle yaptım" ile geçmez
