---
name: price-action
description: Fiyat yapısı / price action analiz rehberi — market structure (HH/LL, BOS, CHoCH), destek-direnç bölgeleri, likidite süpürme, çoklu zaman dilimi teyidi, giriş/SL/TP yerleşimi. Teknik analiz ajanı veya trader bir sembolde yön/giriş kararı verirken ÖNCE bu skill'i okur.
version: 1.0.0
---

# Price Action / Fiyat Yapısı

## TEMEL İLKE

Yön kararı YAPIDAN gelir, göstergeden değil. MA kesişimi tek başına gürültüdür; teyit yoksa işlem yok.

## 1) MARKET STRUCTURE (önce bu)

- Swing high / swing low'ları işaretle (lookback: son 50-100 mum yeterli).
- Yükseliş yapısı: **HH + HL** (higher high, higher low). Düşüş: **LH + LL**.
- **BOS (Break of Structure)**: trend yönündeki son swing seviyesinin kapanışla kırılması = trend devam teyidi.
- **CHoCH (Change of Character)**: karşı yöndeki ilk yapı kırılması = olası dönüş sinyali; BOS ile karıştırma.
- Yapı belirsizse (range) → BEKLE; range'de sadece sınırlardan işlem düşünülür.

## 2) DESTEK / DİRENÇ + LİKİDİTE

- Bölgeyi çizgi değil **alan** olarak al (mum gövdeleri + fitiller).
- Önem sırası: HTF (H4/D1) > LTF (M15/M5). HTF seviyesi LTF'de daha güçlüdür.
- Eşit tepeler/dipler likidite havuzudur; fitil ile "süpürülme" (stop hunt) sık olur — kırılımda **kapanış teyidi** ara.
- Yuvarlak rakamlar (2400, 1.1000) ve önceki günün high/low'u doğal seviyedir.

## 3) ÇOKLU ZAMAN DİLİMİ (MTF)

1. HTF (H4/D1): yön ve ana bölge.
2. MTF (H1/M15): yapı + BOS/CHoCH.
3. LTF (M5/M1): giriş tetiği (retest, engulfing, iğne).
Kural: LTF sinyali HTF yönüne tersse işlem açma.

## 4) MOMENTUM / VOLATİLİTE

- ATR: SL mesafesi ve pozisyon boyutu için (sabit pip değil, ATR bazlı).
- RSI divergence sadece **teyit** olarak kullanılır; tek başına giriş sebebi değildir.
- Hacim/range daralması sıkışma (squeeze) → kırılım yaklaşıyor; yön teyidi bekle.

## 5) GİRİŞ / SL / TP

- Giriş: BOS sonrası geri çekilme (pullback) + retest teyidi; kovalama yok.
- SL: yapının arkasına (son swing low/high'ın ötesi) + spread/ATR payı. Yapının İÇİNE SL koyma.
- Geniş SL tercih ediliyorsa: ~4×ATR SL, ~2×ATR'de BE (break-even) taşıma.
- TP: bir sonraki HTF bölgesi; R:R en az 1.5–2. Kısmi kâr alımı serbest.
- BE'e çekmeden SL'siz/işlemsiz kalma; her pozisyonun SL'si olsun.

## 6) YASAKLAR

- Teyitsiz (BOS/CHoCH olmadan) giriş.
- Zarara ekleme (averaging down) ve martingale.
- Haber anında spread genişken piyasa emri (bkz. haber-duygu skill'i).
- Yapıya ters, sırf "ucuz/pahalı" diye işlem.

## 7) RAPOR FORMATI

Tek satır: `SEMBOL | yön | giriş | SL | TP | yapı gerekçesi (BOS/CHoCH/bölge) | R:R`
Belirsizse net yaz: `BEKLE: <sebep>`.
