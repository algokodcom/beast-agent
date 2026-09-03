---
name: brainstorming
description: Yaratıcı işe KOD YAZMADAN ÖNCE kullan — yeni özellik, yeni proje, bileşen, davranış değişikliği istendiğinde; niyeti, gereksinimleri ve tasarımı kullanıcıyla netleştirmeden implementasyona geçmek yasaktır.
---

# Brainstorming: Fikirden Tasarıma

Fikirleri doğal diyalogla tam oluşmuş tasarımlara dönüştür.

Akış: bağlamı anla → fikri netleştir → tasarımı sun → kullanıcı onayı.

<ZOR KAPI>
Kullanıcıya ne yapacağını söyleyip onayı almadan HİÇBİR implementasyon
eylemi yok: kod yazma, proje scaffold'ı, dosya üretme. Bu kapı HER görev
için geçerlidir; törenin boyutu göreve göre ölçeklenir ama ONAY KAPISI
ölçeklenmez.
</ZOR KAPI>

## Üç Yol

İlk sorudan önce isteği SINIFLANDIR ve sınıfı sesli söyle — "bu sınırlı
kapsamlı görünüyor, spec dosyası yazmak yerine kısa tasarımı burada sunacağım"
— kullanıcı override edebilsin:

- **Spike** — fizibilite sorusu ("yapılabilir mi", "hızlı-çirkin olsun").
  Çıktısı tuttuğun kod değil, bir CEVAPTIR. Soru ve deneme planını 2-3
  cümleyle sun, onay al, en ucuz yolla araştır. Tasarım dosyası yok.
  Bulgu → öneri olarak raporla; bir şey inşa ettiysen "atılabilir" etiketiyle.
- **Sınırlı (Bounded)** — mevcut koda iyi tanımlı değişiklik: yeni flag,
  küçük endpoint, tek dosyalık fix. "Sınırlı" için DEĞİŞTİRECEĞİN AKIŞIN
  Bu projede zaten var olması şart. Önemli netleştirme sorularını sor,
  KISA tasarımı SOHBETTE sun (birkaç cümle - paragraf) ve DUR. Kullanıcı
  "evet" demeden implementasyon yok. Spec dosyası yok, plan dosyası yok.
- **Mimari** — yeni projeler, yeni alt sistemler, bileşen ilişkilerini
  değiştiren işler. Tam süreç: sorular → 2-3 yaklaşım → bölümlü tasarım →
  yazılı spec → writing-plans skill'i.

İki yol arasında tereddüt varsa AĞIRINI seç. Ortasında gizli karmaşıklık
çıkarsa yol YÜKSELTİLİR (dur, söyle, büyüt); asla aşağı inmez.

## Anti-Desen: "Onaya Gerek Yok Kadar Basit"

Her yol onayla biter. Todo listesi, tek fonksiyon, config değişikliği —
tasarım sohbette iki cümle olabilir ama SUN ve ONAY AL. "Basit" işler,
incelenmemiş varsayımların en çok iş boşa çıkardığı yerdir. Basitlikle
ölçeklenen şey artefaktır; onay asla değil.

## Kırmızı Bayraklar

| Düşünce | Gerçek |
|---|---|
| "Bu, tasarım gerektirmeyecek kadar basit" | Basitlik kısa tasarım demektir, tasarım yok demek değil. |
| "Sınırlı der spec'i atlarım" | Etiket arayışı şüphenin ta kendisi — ağır yolu seç. |
| "Tasarım bariz, onu okurken başlarım" | Kapı onaydır, tasarımın uzunluğu değil. Sun ve evet bekle. |
| "Bu tür app'leri biliyorum, sınırlıdır" | Sınırlı olma projeyi ölçer, bilgini değil. Akış yoksa mimaridir. |
| "Spike çalıştı, kodu tutayım" | Spike'ın çıktısı cevaptır. Kodu tutmak YENİ istektir — sınıflandır. |
| "Büyüdü ama az kaldı, yeniden sınıflandırmaya gerek yok" | Gizli karmaşıklık yolu ortada yükseltir. Dur ve söyle. |

## Kontrol Listesi

**Spike:** bağlamı gör → soru+plan sun (2-3 cümle) → onay → en ucuz yolla araştır → öneri raporla.

**Sınırlı:** bağlamı gör (dosyalar, dokümanlar, son commit'ler) → netleştirme
soruları TEK TEK → kısa tasarımı sohbette sun (yaklaşım, dokunulan dosyalar,
test stratejisi) → açık "evet" bekle (sunup hemen başlamak = kapıyı atlamak) →
normal iş akışıyla uygula (TDD geçerli).

**Mimari:**
1. Bağlamı gör: mevcut yapıyı list_dir/grep/read_file ile incele, deseni takip et
2. Netleştirme soruları — TEK SORU PER MESAJ; amaç/kısıt/başarı kriterini anla;
   çoklu seçmeli soru tercih et
3. Kapsam çok buysa parçala: bağımsız alt-projelere böl, sırayı belirle,
   ilk alt-projeyle normal akışa gir
4. 2-3 yaklaşım öner — artı/eksileriyle; önerini BAŞA koy ve nedenini söyle;
   her yaklaşımda YAGNI: gereksiz özelliği çıkar
5. Tasarımı bölümler halinde sun — mimari, bileşenler, veri akışı, hata
   yönetimi, test stratejisi; her bölümün ardından "şimdiye kadar doğru mu?" de
6. Onaylı tasarımı yaz: `<workspace>/docs/plans/specs/YYYY-MM-DD-<konu>-design.md`
7. Spec öz-denetim: "TBD/TODO" var mı, iç tutarlılık, kapsam tek plana sığıyor mu,
   iki şekilde yorumlanabilir gereksinim var mı → düzelt
8. Kullanıcıya spec dosyasını göster, incelemesini iste
9. Onay gelince writing-plans skill'iyle implementasyon planına geç — başka hiçbir
   implementasyon adımı bu kapıdan önce gelmez

## Mevcut Kodda Çalışırken

- Değişiklik önermeden önce mevcut yapıyı incele; var olan deseni takip et
- İşini etkileyen sorunlu noktalar varsa (şişmiş dosya, bulanık sınır) hedefli
  iyileştirmeyi tasarıma dahil et
- Alakasız refactoring önerme — mevcut hedefe hizmet eden kal
