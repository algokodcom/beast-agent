---
name: risk-yonetimi
description: Pozisyon boyutlandırma ve risk disiplini rehberi — hesap yüzdesiyle lot hesabı, marj/kaldıraç denetimi, max eşzamanlı pozisyon, korelasyon/tek yön birikme, günlük kayıp limiti, SL/BE/trailing kuralları. Risk ajanı veya trader her turda ve her işlemden önce bu skill'e göre kontrol yapar.
version: 1.0.0
---

# Risk Yönetimi

## TEMEL KURAL

Önce kaybı sınırla, kârı piyasa versin. İşlem başına risk sabittir; lot, SL mesafesine göre hesaplanır.

## 1) POZİSYON BOYUTU

- İşlem başına risk: hesabın **%0.5–1'i** (agresif değilse %0.25–0.5).
- Lot hesabı: `lot = (bakiye × risk%) / (SL_mesafesi × sembolün pip değeri)`.
- SL mesafesi ATR/yapıdan gelir; önce SL belirle, sonra lotu küçült — tersini yapma.
- Broker limitleri: panel `max lot` ve `max eşzamanlı pozisyon` ayarlarına uy; sistem reddederse zorlama.

## 2) MARJ / KALDIRAÇ

- Serbest marjın tamamını tek işleme bağlama; toplam açık risk serbest marjın küçük bir kısmı olsun.
- Kaldıraç yüksekse lotu düşür; kaldıraç = risk değil, imkândır.
- Marj seviyesi düşerken yeni pozisyon AÇMA; önce riski azalt.

## 3) PORTFÖY DENETİMİ (her turda)

- Açık pozisyonların toplam riskini hesapla (SL'lere göre kayıp potansiyeli).
- **Tek yön birikme**: aynı yönde üst üste pozisyon = tek işlem gibi davranır; toplam riski tek işlem limiti gibi say.
- **Korelasyon**: XAUUSD/EURUSD ile DXY ters koreledir; aynı yönde iki korelasyonlu pozisyon riski katlar.
- SL'siz pozisyon varsa ilk iş: SL tamamla veya kapat.
- Hedefine ulaşan/kâra geçen pozisyonda BE veya kısmi kâr; trailing ATR bazlı.

## 4) KAYIP LİMİTLERİ

- Günlük kayıp limiti belirle (ör. hesabın %2–3'ü). Limit dolduysa **o gün yeni işlem yok**; raporla.
- Üst üste 2-3 kayıptan sonra lotu artırma (revenge trade YASAK); aksine küçült veya dur.
- Drawdown artıyorsa tur sıklığını/agresifliği azalt, sadece A+ setuplara gir.

## 5) YASAKLAR

- Martingale / kademeli lot artışı.
- SL taşımayı kaybı büyütecek yönde yapmak (SL genişletme).
- Marjı zorlayan "son işlem" kumarı.
- Aynı anda korelasyonlu 3+ pozisyonla tek yön yığmak.

## 6) RAPOR FORMATI

`Risk: toplam açık R%X | marj kullanımı %Y | en riskli pozisyon: ... | öneri: SL/BE/küçült/kapat`
Sınır aşımı varsa öncelikli ve net yaz.
