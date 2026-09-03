---
name: subagent-driven-development
description: Bağımsız görevlere bölünmüş bir implementasyon planı yürütülürken, görev başına taze paralel ajan devredilecekken kullan — CEO modunda planlı geliştirme işlerinde.
---

# Alt-Ajan Destekli Geliştirme

Planı, görev başına TAZE implementer alt-ajanı devrederek yürüt; her
görevden sonra görev incelemesi (spec uyumu + kalite), sonda tüm işin
genel incelemesi.

**Neden alt-ajan:** Bağlamı izole, uzman ajanlara devredersin. Onlar senin
oturum bağlamını asla görmez — ihtiyaçları olan her şeyi sen kurarsın. Bu
senin bağlamını koordinasyona saklar ve her görevde taze, kiralanmamış
bağlam garanti eder.

**Çekirdek ilke:** Görev başına taze ajan + görev incelemesi + sonda geniş
inceleme = yüksek kalite, hızlı iterasyon.

**Kesintisiz yürütme:** Görevler arasında kullanıcıya "devam edeyim mi?"
diye DURMA. Planı sorana kadar yürüt. Durmanın sadece 4 sebebi var:
(1) geri döndürülemez/yıkıcı işlem, (2) güvenlik hassasiyetli işlem,
(3) worktree dışına dokunan yan etki (merge, push, publish), (4) plan o
kadar bozuk ki her yol tahmine dayanıyor.

**Karar ver, bekleme:** Çelişki, belirsizlik, plan kusuru — sen karar ver.
Spec bağlayıcı otoritedir, plan onun savunmasıdır. Her kararı defterine
`Karar: <neyi> — <neden> — <yanlışsa maliyeti>` olarak yaz ve devam et.

## Ne Zaman

- Implementasyon planı var mı? → yoksa önce writing-plans
- Görevler çoğunlukla bağımsız mı? → sıkı bağlıysa satır içi (executing-plans)
- CEO modu / paralel ajan mümkün mü? → evetse bu skill

## Kurulum

1. Planı BİR KEZ oku (ve varsa spec'i — çelişkiler spec'e göre çözülür)
2. todo_write ile her göreve bir madde aç
3. Defteri kur: `<workspace>/.sdd/<plan-adı>-progress.md` — ilk satır
   `# SDD defteri — plan: <plan dosyası>` olsun. Bağlam sıkışırsa/kaybolursa
   defter VE git log senin hafızandan güvenilirdir; tamamlanan görevleri
   yeniden devretme.
4. Görev 1'den önce hızlı çelişki taraması: birbiriyle çelişen görevler,
   görevlerin tanımladığı arayüzler tutarlı mı? Bulgu varsa kararını deftere yaz.

## Model Seçimi (agent: parametresi)

Her devirde en az güçlü yeterli modeli kullan — run_background'da
`agent:` ile tanımlı ajan ver (%APPDATA%\beast\agents\*.md) ya da görevde
model beklentisini belirt:

- **Mekanik iş** (izole fonksiyon, net spec, 1-2 dosya, plan kodu tam içeriyor):
  hızlı/ucuz model
- **Entegrasyon/tyargı işi** (çok dosya, pattern eşleme, debug): standart model
- **Mimari/tasarım işi + FİNAL inceleme:** en güçlü model — final review
  asla oturum varsayılanına düşük kalmamalı
- **Fix turları 4-5:** takılan implementer'dan bir tier güçlü model

## Görev Döngüsü

**Küçük aynı-kalıp işleri TOPLA:** plan birkaç küçük bağımsız aynı-tip edit
listeliyorsa görev başına ajan AÇMA — tek brief'te tüm dosyaları listele,
tek ajana ver, diff'ini tek unit olarak incele.

### 1. Implementeri devret

- **Görev brief'i:** görev metnini brief dosyasına yaz
  (`<workspace>/.sdd/gorev-N-brief.md`) — tam değerler, kod, testler brief'te.
  Devir metni şunu içersin: (1) görevin projedeki yeri tek cümle; (2) brief
  dosyasının yolu ("önce bunu oku — gereksinimlerin burada, değerleri birebir
  kullan"); (3) brief'in bilemeyeceği önceki görevlerin arayüz kararları;
  (4) belirsizliklerin çözümü; (5) rapor dosyası yolu
  (`gorev-N-rapor.md`).
- **Kritik kuralları GÖM:** alt-ajanlar skill OKUMAZ (skills taraması
  arka-ajanlara girmez) — TDD/verification gibi şartları görev metnine tek
  cümleyle göm: "Testten önce kod yok: RED→fail gör→GREEN→pass gör.
  Bitti demeden önce test çıktısıyla kanıtla."
- **Alt-ajan alt-ajan AÇAMAZ** — bu normaldir: implementer inceleme de
  devredemez; inceleme senden gelir.
- Aynı anda birden çok implementasyon ajanı devretme (çakışır) —
  BAĞIMSIZ görevler run_background_many ile fan-out edilebilir.
- Report contract: ajan kısa döner — status + commit + tek satır test özeti +
  endişeler; detay rapor dosyasına yazar (senin bağlamını şişirmez).

### 2. Raporu ele

- **DONE:** inceleme paketini hazırla, task reviewer devret (adım 3)
- **DONE_WITH_CONCERNS:** endişeleri oku; doğruluk/kapsam ise review'dan
  ÖNCE ele al; gözlemse not al ve geç
- **NEEDS_CONTEXT:** eksik bağlamı ver, yeniden devret
- **BLOCKED:** bağlam sorunuysa bağlamla; akıl sorunuysa güçlü modelle;
  iş büyükse böl; plan hatalıysa karar ver + deftere yaz + düzeltilmiş devir

Ajan takıldı dediysen aynı modelle aynı şartlarda TEKRAR deneme — bir şey
değişmeli.

### 3. Görevi incele

- **Task reviewer devret** (taze ajan): girdiler = brief dosyası + rapor
  dosyası + diff dosyası. Diff'i kendin ÖZETLEME — `git diff BASE..HEAD` çıktısını
  bir dosyaya yaz (BASE = devirden önceki commit) ve yolunu ver; reviewer tek
  okumada commit listesi + stat + tam diff görür, senin bağlamına diff girmez.
- Reviewer'a planın Global Kısıtlarını BİREBİR kopyala — bu onun dikkat
  merceğidir. Açık uçlu talimat ("tüm kullanımları kontrol et") EKLEME.
- Reviewer'a bulguyu ÖNCEDELEN yargılama — "şunu bayraklama" deme; bulgunu
  çıkarsın, inceleme döngüsünde sen kararlaştırırsın.
- İki karar gereklidir: spec uyumu ✓ VE kalite onayı. Ajanın öz-incelemesi
  task incelemesinin YERİNİ TUTMAZ.
- Reviewer "diff'ten doğrulanamıyor" işareti koyabilir — bunları kendin çöz:
  plan + görevler-arası bağlam sende.

### 4. Fix döngüsü

Review spec ❌ veya Critical/Important bulgu bildirirse döngü başlar.
Minor bulgular döngüye girmez — deftere `Task N: minor (ertelendi): <tek satır>` yaz.

Tur başına: bir fix devri + bir scoped re-review. Görev başına MAK 5 tur:

- **Tur 1-3 — aynı implementer'a devam:** açık bulguları birebir gönder;
  bağlamı duruyor. Aynı ajana mesaj atılamıyorsa taze implementer'a brief +
  rapor + bulguları ver — rapor dosyası kalıcı hafızadır.
- **Tur 4-5 — taze implementer + güçlü model:** "Önceki implementer N kez
  denedi; artık sen sahibin. Deneneni rapordan oku."
- Her turda: implementer kapsayan testleri yeniden çalıştırır, fix raporunu
  AYNI rapor dosyasına ekler. Re-review scoped: SADECE fix diff'inde bulgular
  ADDRESSED/NOT ADDRESSED + yeni kırılma var mı.
- Defteri her turda güncelle: `Task N: fix turu R/5 (X giderildi, Y açık)`.

**Kendin fix YAPMA** — bağlamın koordinasyon için temiz kalmalı ve senin
fix'in review'sız kalır.

**Sigorta (5. turda da açık bulgu):** devretmeyi durdur, her bulguyu kendin
kararla:
- Reviewer yanılıyorsa → park et: `Task N: park — <bulgu> — Karar: <kod neden duruyor>`
- Gerçek ama kimseye binmiyorsa → ertelendi olarak park et
- Gerçek ve yük taşıyorsa → en küçük açıcı değişikliğe karar ver, deftere yaz,
  sonraki görevin devrine taşı

### 5. Görevi tamamla

Review temiz gelince (veya bulgular park edildiğinde): deftere
`Task N: complete (commits <base>..<head>, review clean)` yaz, todo done yap,
sıradaki görev.

## Final Review

Tüm görevler bitince TÜM işin incelemesini devret — en güçlü modelle:
`git diff <plan-başlangıç>..HEAD` diff dosyası + defterdeki ertelenen minor/
park satırlarıyla (hangi merge'i bloklar triage etsin). Bulgu dönerse TEK fix
ajanı devret (bulgu başına ayrı ajan değil) + TEK scoped re-review.

Bitirince defterdeki tüm `Karar:` satırlarını final mesajında kullanıcıya
listele — senin onun adına aldığın kararlar buraya kadar görünür olur.

## Yaygın Bahaneler

| Bahane | Gerçek |
|---|---|
| "Spec uyumu kabaca tamam" | Reviewer spec boşluğu buldu = bitmedi. Fix veya cap+karar — başka çıkış yok. |
| "Kendim fixleyeyim, devir maliyetli" | Senin fix'in review'sız kalır ve bağlamını kirletir. Implementer'a devam ettir. |
| "Bir tur daha yakınsar" | Cap sonrası turlar yakınsamaz — sorun yapısal. Kararlaştır. |
| "Reviewer zaten yeni bulgu çıkaracak" | Scoped re-review sadece fix'i doğrular; yeni bulgu deftere gider, döngüye değil. |
| "Bu bulgu bariz yanlış, düşüreyim" | Karar SADECE cap'te ve her karar deftere. Sessiz düşürme yasak. |
| "Fix küçük, re-review'sız geç" | Review'sız fix = regresyon kapısı. Her tur re-review ile biter. |
| "İnceleme döngüyü yavaşlatıyor" | Reviewsuz döngü doğrulanmamış efor. İnceleme fren ve direksiyondur. |
| "Defter yazımı maliyetli" | Defter bağlam sıkışmasından kurtulan tek şeydir. |
