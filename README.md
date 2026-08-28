# Beast Agent

> **hızlı, hafif ve becerikli** — Windows için yerel ajan kabuğu. Sohbet eder, komut çalıştırır, dosya yazar, web'de arar, WhatsApp'tan yönetilir.

![platform](https://img.shields.io/badge/platform-Windows-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![electron](https://img.shields.io/badge/electron-40-47848F)

Beast Agent; makinenizde çalışan, OpenAI-uyumlu **herhangi bir provider'a** bağlanabilen kişisel bir yapay zekâ ajanıdır. Tek bir `config.yaml` ile tüm modellerinizi tanımlarsınız; Beast gerisini halleder.

## ✨ Özellikler

- **Çoklu Provider** — config.yaml'dan sınırsız model; picker'dan anında geçiş, rol bazlı modeller (vision / terminal / coding / subagent)
- **FALLOUT Zinciri** ⚛ — model çökerse otomatik olarak sıradaki sağlayıcıya geçer; kaldığı yerden devam eder
- **CEO Modu** — konuşan ajan iş yapmaz, emirleri paralel ajanlara devreder; canlı izleme paneli
- **WhatsApp Entegrasyonu** — QR ile bağlanın; DM + grup (@mention), sesli mesajlar yerel Whisper ile otomatik transkript olur, cevaplar sesli not olarak da gidebilir
- **Slash Komutları** — `/new`, `/open`, `/change`, `/think`, `/rule`, `/allow`, `/block`, `/backup`, `/approve` ve dahası
- **Olay Merkezi** — IMAP IDLE e-posta takibi, dosya değişim izleme, fiyat feed'i (Binance), webhook girişleri
- **Cron + İzleyiciler** — zamanlanmış görevler, dosya/web/pil izleyiciler
- **Web Arama Zinciri** — TinyFish (ücretsiz, anahtar girilirse önce o) → dahili tarayıcı (direkt Google) → python çoklu-motor (DDG/Bing/Mojeek) → Exa
- **Güvenlik Kapısı** — riskli işlemler (komut/dosya silme-değiştirme) için onay sistemi: varsayılan kapalı (her şey serbest), açılırsa ajan sorar (`/approve`, `/approve always`, `/deny`)
- **Provider Bazlı Limit** — model başına max input token limiti + bağlam sıkıştırma
- **Şifreli Yedek** — tüm veri AES-256 ile şifrelenir, makinenizin benzersiz **Beast Kodu** ile imzalanır
- **Dashboard** — oturum geçmişi, mesaj istatistikleri, maliyet takibi
- **Tam TR/EN arayüz** — her şey anında dil değiştirir
- **/health** — açılıştan itibaren `http://127.0.0.1:8788/health` ile yaşam durumu

## 📦 Kurulum

### Hazır kurulum (önerilen)
[Releases](../../releases) sayfasından `BeastAgent-Setup-x.x.x.exe` indirin. Kurulumdan sonra Windows ile birlikte otomatik başlar (tepside yaşar).

### Kaynaktan
```bash
git clone https://github.com/algokodcom/beast-agent.git
cd beast-agent
npm install
npm start
```

> Gereksinimler: Node.js 18+, Windows 10/11. Python ve ffmpeg isteğe bağlıdır — eksikse Beast gerekli araçları kendisi kurar.

### npm
```bash
npm install -g beast-agent
```

## ⚙️ Yapılandırma

1. `config.example.yaml` → `config.yaml` olarak kopyalayın, provider'larınızı girin:
```yaml
defaultSelection: openrouter::anthropic/claude-3.5-sonnet
providers:
  - id: openrouter
    name: OpenRouter
    baseUrl: https://openrouter.ai/api/v1
    apiKey: sk-or-...
    models:
      - anthropic/claude-3.5-sonnet
      - gpt-4o
```
2. API anahtarlarını `.env` ile de verebilirsiniz: `.env.example` → `.env`
3. Uygulama ilk açılışta Ayarlar → Provider'dan modelleri otomatik çeker.

Tüm uygulama verisi `%APPDATA%\beast` altında tutulur (oturumlar, hafıza, WhatsApp eşlemesi, şifreli ayarlar).

## 🗣️ Kullanım

| Nerede | Ne yapar |
|---|---|
| Sohbet | Görev ver — araçlarıyla (dosya, komut, web, python, tarayıcı) kendi başına çalışır |
| WhatsApp | Numaranızı allow listesine ekleyin, telefondan aynen yönetin |
| Tepsi | Kapatınca ölmez — tepside yaşamaya devam eder |

Yardım için sohbete `/help` yazın.

## 🔒 Güvenlik & Gizlilik

- Her şey **lokal** çalışır: oturumlar, hafıza, loglar sizin diskinizde
- API anahtarları renderer'a düz metin gönderilmez, maskeleme uygulanır
- Yedekler AES-256 şifreli + Beast Kodu imzalı — yalnız sizin makineniz geri yükleyebilir
- Riskli işlem onayı varsayılan **kapalıdır**; Güvenlik sekmesinden açabilirsiniz

## 🧪 Geliştirme

```bash
npm test        # motor + araç testleri (node --test)
npm run dist    # NSIS + portable derleme
```

## 📄 Lisans

[MIT](LICENSE) © 2026 algokodcom (AlgoKod)
