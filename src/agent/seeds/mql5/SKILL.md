---
name: mql5
description: MetaTrader 5 tarafında MQL5 (script / indicator / Expert Advisor) yazma-derleme rehberi — mt5_* araçlarının yapamadığı işleri (özel hesap, olay yakalama, EA ile otomatik yürütme, dosya köprüsü) MQL5 ile çözmek gerektiğinde ÖNCE bu skill'i oku. BeastFinance EA (varsayılan, otomatik kurulur) + dosya köprüsü, veri klasörünü bulma, MetaEditor ile derleme ve hazır kod iskeletleri burada.
version: 1.1.0
---

# MQL5 Tool Yazma (MetaTrader 5)

## NE ZAMAN KULLANILIR

- `mt5_*` araçları yetmiyorsa: tick/olay anında tepki, çok koşullu emir yönetimi, özel gösterge hesabı, hesap istatistiği, broker'a özel alanlar.
- Beast tarafında tekrarlı bir rutini MQL5 ile terminalin İÇİNDE çalıştırmak gerekiyorsa.
- Basit işi Python/Node ile yapabiliyorsan ÖNCE `python_run` / `run_command` / `mt5_*` dene — MQL5 son çare değil ama en ağır seçenektir.

## 1) VERİ KLASÖRÜNÜ BUL (ilk adım)

1. `mt5_status` çağır → dönen `terminal.data_path` = MT5 veri klasörü (en güvenilir yol).
2. Bulamazsan `%APPDATA%\MetaQuotes\Terminal\<hash>\` altındaki klasörlerde `MQL5` dizinini ara; hash'i `origin.txt` içeriğiyle (kurulum yolu) eşleştir.
3. Klasör düzeni:

| Klasör | Ne konur |
|---|---|
| `<data_path>\MQL5\Experts\` | Expert Advisor (EA) — chart'a iliştirilir |
| `<data_path>\MQL5\Indicators\` | Özel gösterge |
| `<data_path>\MQL5\Scripts\` | Tek seferlik script — elle bir kez çalıştırılır |
| `<data_path>\MQL5\Include\` | Paylaşılan `.mqh` başlıkları |
| `<data_path>\MQL5\Files\` | MQL5 program sandbox'ı — Beast buradan `read_file` ile okur |

## 2) YAZMA

- Kod `write_file` ile `.mq5` olarak yazılır (UTF-8). `edit_file`, `read_file`, `run_command`, `python_run` yetkilerin açık.
- MQL5 C++ benzeridir; Python paketi yoktur, yalnız MetaTrader standart kütüphanesi vardır.
- Hazır sınıflar: `#include <Trade\Trade.mqh>` (CTrade), `#include <Trade\PositionInfo.mqh>`, `#include <Trade\SymbolInfo.mqh>`.
- Türkçe karakteri yalnız string/yorum içinde kullan; değişken adlarında kullanma.

## 3) DERLEME (MetaEditor)

`metaeditor64.exe`, `terminal64.exe` ile aynı klasördedir (genelde `C:\Program Files\MetaTrader 5\` veya broker kurulum klasörü).

```powershell
& "C:\Program Files\MetaTrader 5\metaeditor64.exe" /compile:"<data_path>\MQL5\Scripts\beast_script.mq5" /log:"<data_path>\MQL5\Scripts\beast_script.log"
```

- Derleme logu **UTF-16**'dır:
  ```powershell
  Get-Content -Encoding Unicode "<log>" | Select-String "error|warning"
  ```
- "0 errors" görmeden işi bitti sayma. Hata varsa kodu düzelt, yeniden derle.
- Terminalin açık olması derleme için gerekmez; metaeditor yolunu bulamazsan `Get-Command metaeditor64.exe` veya `Get-ChildItem "C:\Program Files" -Recurse -Filter metaeditor64.exe` ile ara.

## 4) ÇALIŞTIRMA + BEAST KÖPRÜSÜ

### 4.0) BEASTFINANCE EA — VARSAYILAN, OTOMATİK KURULUR (ÖNCE BUNU KULLAN)

Beast Finance MT5'e bağlandığında sistem bunları otomatik yapar:
- `BeastFinance.mq5`'i `MQL5\Experts\Beast\` altına yazar ve MetaEditor ile derler,
- ilk grafiğe EA'yı ekler (gerçek MT5 formatı: `<expert>` bloğu `<window>` öncesi, `path=Experts\Beast\BeastFinance.ex5`, `expertmode=5`),
- `config\common.ini [Experts]` üzerinden AutoTrading iznini açar.

Yani MT5 entegrasyonu yazarken EA'yı SIFIRDAN YAZMA, elle iliştirme varsayma — köprü ZATEN kurulu:

| Dosya (MQL5\Files) | Yön | İçerik |
|---|---|---|
| `beast_ea.json` | EA → Beast | heartbeat: version, symbol, period, equity/balance, `terminal_trade_allowed`, `mql_trade_allowed`, positions, note |
| `beast_cmd.json` | Beast → EA | komut: `{id, cmd, params}` — desteklenen: ping / chart / status / note / shot |
| `beast_cmd_ack.json` | EA → Beast | komut sonucu: `{ok, id, cmd, result|error}` |
| `beast_note.json` | Beast → EA | grafik panosu: `{symbol?, text, levels:[{price,label}]}` — pano + yatay çizgiler; screenshot'ta görünür |

- GRAFİK GÖRÜNTÜSÜ: `shot` komutu `{file, width, height, symbol?, timeframe?, template?}` alır — ChartScreenShot ile GERÇEK PNG üretir. Aktif grafik istenen sembol/periyot ile aynıysa panoyu + seviye çizgilerini içerir; farklıysa EA `ChartOpen` + `BeastShot.tpl` (açık tema, EA bloğu yok) ile geçici grafik açıp kapatır. Bu komutu sarmalayan VARSAYILAN araç `tool__mt5_shot`'tır: PNG'yi çağıran ajana görsel olarak enjekte eder, `path` döndürür (send_file / agent_dm image ile paylaşılır). Seviyeleri grafikte göstermek için önce `mt5_ea note`, sonra `tool__mt5_shot` çağır — paralel ekipte teknik ajan seviyeleri çizer, görsel ajan screenshot ile teyit edip trader'a atar.

- Finance oturumlarındaki ajan aracı: `mt5_ea` (action: status|ping|chart|note); grafik PNG'si için varsayılan `tool__mt5_shot` (tüm oturumlarda açık).
- Yeni MT5 entegrasyonu gerekiyorsa ÖNCE bu köprüyü GENİŞLET: EA'da `ProcessCommands()` içine yeni komut + Beast tarafında `mt5_ea` / python `ea_cmd`. Sıfırdan EA yazma.
- EA kaynağı Beast uygulamasında `src/agent/mt5/BeastFinance.mq5`; güncelleme oradan yapılır, setup yeniden derler.
- Derleme hatalarında dosya kodlaması UTF-16 (`FILE_UNICODE`) kullanılır; MQL5'te `FILE_UTF8` yoktur.

### 4.1) Elle script/EA çalıştırma

- **Script**: MT5 → Navigator → Scripts → çift tık (kullanıcı) — Python API'den MQL5 tetiklenemez.
- **EA**: chart'a iliştirilir; AutoTrading düğmesi açık olmalıdır.
- **Dosya köprüsü (önerilen)**:
  - MQL5 → Beast: program `MQL5\Files\beast_signal.json` yazar; ajan `read_file` ile `<data_path>\MQL5\Files\beast_signal.json` okur.
  - Beast → MQL5: ajan `beast_cmd.json` yazar; EA `FileRead` ile komutu çeker (polling).
- Kullanıcıya EA/script'i nasıl iliştireceğini net söyle; "otomatik çalışıyor" varsayma.

## 5) KOD İSKELETLERİ

### Script → dosyaya veri yaz (Beast okur)

```mql5
#property version   "1.00"
#property script_show_inputs
input string OutFile = "beast_signal.json";

void OnStart()
{
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   int h = FileOpen(OutFile, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
   {
      Print("dosya acilamadi: ", GetLastError());
      return;
   }
   FileWriteString(h, StringFormat("{\"symbol\":\"%s\",\"bid\":%.5f,\"ask\":%.5f,\"time\":\"%s\"}",
      _Symbol, bid, ask, TimeToString(TimeCurrent(), TIME_DATE | TIME_SECONDS)));
   FileClose(h);
   Print("beast_signal yazildi: ", bid, " / ", ask);
}
```

### EA iskeleti (CTrade)

```mql5
#property version "1.00"
#include <Trade\Trade.mqh>
CTrade trade;

int OnInit()
{
   trade.SetExpertMagicNumber(20260910);
   return INIT_SUCCEEDED;
}

void OnTick()
{
   /* sinyal + risk: lot hesabı, SL/TP zorunlu; martingale YOK */
   /* trade.Buy(lot, _Symbol, 0.0, sl, tp, "beast"); */
}

void OnDeinit(const int reason) {}
```

### Ters yön: komut dosyası oku

```mql5
bool ReadCmd(string &out)
{
   if(!FileIsExist("beast_cmd.json")) return false;
   int h = FileOpen("beast_cmd.json", FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return false;
   out = FileReadString(h);
   FileClose(h);
   return true;
}
```

## 6) KURALLAR

- SL'siz işlem/EA yazma; martingale/kademeli lot artışı YASAK.
- Sembol adını `mt5_market` ile doğrula — broker'da neyse o (örn "GOLD", "XAUUSD" değil).
- `TimeCurrent()` broker sunucu saatidir; raporda saat dilimini belirt.
- Ağ/DLL kullanacaksan kullanıcıdan onay iste (`#import` varsayılan kapalıdır).
- Şifre/API anahtarını koda, loga, rapora YAZMA.
- Derlenmemiş/çalıştırılmamış kodu "bitti" diye raporlama; kullanıcıya çalıştırma adımını açıkça söyle.
