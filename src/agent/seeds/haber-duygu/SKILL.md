---
name: haber-duygu
description: Haber ve piyasa duyarlılığı rehberi — ekonomik takvim riskleri (NFP/CPI/FOMC/faiz), haber öncesi-sonrası pozisyon disiplini, DXY/faiz/VIX/Fear&Greed okuma, risk-on/risk-off ve emtia bağıntıları. Makro/haber ajanı veya trader haber etkisi değerlendirirken ÖNCE bu skill'i okur.
version: 1.0.0
---

# Haber & Piyasa Duyarlılığı

## TEMEL İLKE

Haber yön tahmini için değil, **risk zamanlaması** için kullanılır. Yüksek etkili veri saatinde piyasa spreadi genişler ve yön belirsizdir; çoğu zaman en iyi işlem beklemektir.

## 1) EKONOMİK TAKVİM

- Yüksek etkili: FOMC/faiz kararları, NFP (tarım dışı istihdam), CPI/PPI, GDP, işsizlik, ECB/BOE/BOJ kararları, jeopolitik başlıklar.
- Kural: yüksek etkili veriden **15–30 dk önce yeni pozisyon açma**; mevcut pozisyonu gözden geçir (SL sabit, panik kapatma yok).
- Veri sonrası: ilk 5–15 dk fitil/spike olur; kapanış teyidi gelmeden işlem açma.
- Takvimi `web_search`/`deep_search` ile teyit et; tarih/saati yerel saatle yaz (sunucu saati farkını belirt).

## 2) DUYGU GÖSTERGELERİ

- **DXY**: dolar gücü — yükselirse altın ve EURUSD genelde baskılanır (ters korelasyon).
- **ABD 10Y tahvil faizi**: faiz yükseliyorsa risk iştahı azalabilir, altın baskılanabilir.
- **VIX**: yükseliyorsa risk-off; düşüyorsa risk-on.
- **Kripto Fear & Greed**: yalnız BTC/ETH gibi kripto pozisyonlarında; hisse/emtia için ana referans değil.
- Aşırı iyimserlik (greed) ve aşırı korku (fear) uçlarda dönüş riskidir; trend takipçisi için tek başına sinyal değildir.

## 3) RİSK-ON / RİSK-OFF

- Risk-on: hisse ↑, emtia ↑, dolar/altın baskılı olabilir.
- Risk-off: DXY/altın/tahvil ↑, hisse/kripto ↓.
- Makro başlık bölgeyi tersine çevirdiyse mevcut teknik planı **güncelle**, körlemesine uygulama.

## 4) HABER DOĞRULAMA

- Tek kaynağa güvenme; 2+ bağımsız kaynak teyidi ara.
- Manşet ile içerik çelişirse içeriği esas al; tarih/saat eski haberi taze sanma.
- Söylenti (rumor) ve resmi açıklamayı ayır; söylentiye işlem açma.

## 5) BAĞINTI NOTLARI

- XAUUSD ile DXY ters korele; aynı yönde iki korelasyonlu pozisyon açma (bkz. risk-yonetimi).
- Petrol haberleri (OPEC, arz kesintisi) enerji sembollerini ve genel risk iştahını etkiler.
- Emtia sembollerinde broker sembol adını kullan (ör. "GOLD", "XAUUSD" değil) — `mt5_market` ile doğrula.

## 6) RAPOR FORMATI

`Takvim: <saat> <veri> (yüksek) | duygu: risk-on/off | DXY yön | sembol etkisi: <yön/temkin> | aksiyon: bekle/azalt/normal`
Veri saatine 30 dk'dan az varsa bunu raporda AÇIKÇA belirt.
