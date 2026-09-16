'use strict';

/* Beast Finance — MT5 ajan araçları.
   Handler'lar main süreçteki mt5bridge singleton'ına bağlanır; işlem açan
   araçlar settings.finance.allowTrading / maxLot / maxPositions ile sınırlanır.
   main tarafı setConfig/setNotify ile ayar ve bildirim kancasını enjekte eder. */

const mt5 = require('../mt5bridge');
const finindicators = require('./finindicators');
const finstats = require('./finstats');
const finrisk = require('./finrisk');
const finwatch = require('./finwatch');

const NAMES = [
  'mt5_status',
  'mt5_account',
  'mt5_market',
  'mt5_rates',
  'mt5_indicators',
  'mt5_risksize',
  'mt5_positions',
  'mt5_orders',
  'mt5_history',
  'mt5_alerts',
  'mt5_note',
  'mt5_ogrenme',
  'mt5_limits',
  'mt5_ea',
  'mt5_trade',
  'mt5_close',
  'mt5_modify',
  'mt5_pending',
  'mt5_cancel',
];

let getCfg = () => ({ allowTrading: false, minLot: 0.01, maxLot: 0.1, maxPositions: 3, symbols: [] });
let notify = () => {};
/* DİSİPLİN KANCASI (main enjekte eder): kodla zorlanan kurallar — günlük işlem
   limiti, kayıp serisi molası, re-entry beklemesi, kur maruziyeti.
   (side, symbol, positions) → hata metni ya da null. */
let discipline = () => null;
/* alarm deposu main süreçte yaşar (dosyaya kalıcı) — buradan enjekte edilir */
let alertsApi = {
  list: () => [],
  set: () => null,
  remove: () => false,
};
/* LIMIT API (main enjekte eder): trader lot/pozisyon limitlerini okuyup yazar */
let limitsApi = {
  get: () => ({ minLot: 0.01, maxLot: 0.1, maxPositions: 3 }),
  set: () => ({ ok: false, error: 'limit güncelleme kullanılamıyor' }),
};
/* ÖĞRENME API (main enjekte eder): sembol bazlı öğrenme deposu */
let learningApi = {
  list: () => ({ ok: false, error: 'öğrenme deposu kullanılamıyor' }),
  add: () => ({ ok: false, error: 'öğrenme deposu kullanılamıyor' }),
  remove: () => ({ ok: false, error: 'öğrenme deposu kullanılamıyor' }),
  clear: () => ({ ok: false, error: 'öğrenme deposu kullanılamıyor' }),
  stats: () => ({ ok: false, error: 'öğrenme deposu kullanılamıyor' }),
};

function setConfig(fn) {
  if (typeof fn === 'function') getCfg = fn;
}

function setNotify(fn) {
  if (typeof fn === 'function') notify = fn;
}

function setAlerts(api) {
  if (api && typeof api === 'object') alertsApi = api;
}

function setDiscipline(fn) {
  if (typeof fn === 'function') discipline = fn;
}

function setLimits(api) {
  if (api && typeof api === 'object') limitsApi = { ...limitsApi, ...api };
}

function setLearning(api) {
  if (api && typeof api === 'object') learningApi = { ...learningApi, ...api };
}

async function bcall(method, params, timeoutMs) {
  const r = await mt5.call(method, params, timeoutMs);
  if (!r || r.ok !== true) throw new Error((r && r.error) || 'MT5 hatası');
  return r.data;
}

async function symInfoRow(symbol) {
  const data = await bcall('symbols', { symbols: [String(symbol || '').toUpperCase()] }, 10000);
  const row = data && data.symbols && data.symbols[0];
  return row && !row.missing ? row : null;
}

function tickPrice(row, side) {
  const p = side === 'buy' ? Number(row && row.ask) : Number(row && row.bid);
  if (isFinite(p) && p > 0) return p;
  return Number(row && row.bid) || Number(row && row.ask) || 0;
}

/* İşlem öncesi risk katmanı: stops_level + yoğunluk + marj kalkanı.
   Hata metni ya da null döner. positions çağıran tarafından verilir. */
async function preTradeCheck(cfg, side, symbol, info, price, volume, sl, tp, positions) {
  const closeErr = finrisk.stopsTooClose(info, price, sl, tp);
  if (closeErr) return closeErr;
  const expErr = finrisk.exposureCheck(positions || [], side, symbol, cfg.maxPerSymbol, cfg.maxSameSide);
  if (expErr) return expErr;
  /* KODLA DİSİPLİN: günlük limit / kayıp serisi molası / re-entry / kur maruziyeti */
  let discErr = null;
  try { discErr = discipline(side, symbol, positions || []); } catch {}
  if (discErr) return discErr;
  const minLevel = Number(cfg.minMarginLevel) || 0;
  let account = null;
  let estMargin = 0;
  try {
    const a = await bcall('account', {}, 8000);
    account = a && a.account;
  } catch {}
  try {
    const m = await bcall('margin', { symbol, side, volume, price }, 8000);
    estMargin = Number(m && m.margin) || 0;
  } catch {}
  const mErr = finrisk.marginCheck(account, estMargin, minLevel);
  if (mErr && mErr.error) return mErr.error;
  return null;
}

function noteTrade(kind, data, ctx) {
  try { notify({ kind, data, at: Date.now(), sid: ctx && ctx.sessionId ? String(ctx.sessionId) : '' }); } catch {}
}

function notConnected() {
  return { ok: false, error: 'MT5 köprüsü bağlı değil — terminal açık mı? (panelde ⟳ ile yeniden bağlan)' };
}

const definitions = NAMES.map((name) => {
  const specs = {
    mt5_status: {
      description:
        'MT5 (MetaTrader 5) köprü durumunu döndürür: köprü çalışıyor mu, terminale bağlı mı, terminal/hesap özeti. Her finance turunda VEYA bağlantı sorunlarında ilk çağrı.',
      parameters: { type: 'object', properties: {} },
    },
    mt5_account: {
      description:
        'MT5 hesap özeti: bakiye, özkaynak (equity), yüzen kâr/zarar, marj, serbest marj, marj seviyesi, kaldıraç, para birimi, hesap no/sunucu.',
      parameters: { type: 'object', properties: {} },
    },
    mt5_market: {
      description:
        'Verilen semboller için canlı fiyat + TAM sembol sözleşme bilgisi: bid/ask, spread, digit, point, swap_long/short, komisyon, kontrat büyüklüğü, min/max/step lot, stops_level, işlem modu. symbols verilmezse izleme listesi (watchlist) kullanılır. Örn: ["EURUSD","XAUUSD"].',
      parameters: {
        type: 'object',
        properties: {
          symbols: { type: 'array', items: { type: 'string' }, description: 'Sembol listesi (boşsa watchlist)' },
        },
      },
    },
    mt5_rates: {
      description:
        'OHLC MUM VERİSİ: mt5_rates {symbol, timeframe:"M1|M5|M15|M30|H1|H4|D1|W1|MN1", count?}. Trend/yapı/destek-direnç analizinin HAM verisi. Varsayılan M15 × 200 mum. Formasyon/price-action için İDEAL: H1/H4 yapı + M15/M5 giriş zamanlaması.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Örn: XAUUSD' },
          timeframe: { type: 'string', description: 'M1|M5|M15|M30|H1|H4|D1|W1|MN1 (varsayılan M15)' },
          count: { type: 'number', description: 'Mum sayısı 1-1000 (varsayılan 200)' },
        },
        required: ['symbol'],
      },
    },
    mt5_indicators: {
      description:
        'TEKNİK GÖSTERGELER: mt5_indicators {symbol, timeframe, count?, indicators?}. indicators örn: ["EMA(50)","EMA(200)","RSI(14)","ATR(14)","MACD(12,26,9)","BB(20,2)","STOCH(14,3,3)","SMA(200)"]. Varsayılan: EMA20/EMA50/RSI14/ATR14/MACD. ATR ile SL mesafesi/lot, RSI ile aşırı alım-satım, EMA ile trend yönü oku.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          timeframe: { type: 'string', description: 'M1|M5|M15|M30|H1|H4|D1|W1|MN1 (varsayılan H1)' },
          count: { type: 'number', description: 'Hesaplamaya giren mum sayısı (varsayılan 300, en fazla 1000)' },
          indicators: {
            type: 'array',
            items: { type: 'string' },
            description: 'Gösterge listesi (boşsa varsayılan set)',
          },
        },
        required: ['symbol'],
      },
    },
    mt5_risksize: {
      description:
        'RİSK BAZLI LOT HESABI: mt5_risksize {symbol, sl?, entry?, side?, riskPct?, atrMult?, timeframe?}. Bakiyenin riskPct%’i kadar kayıp verecek lotu hesaplar (SL mesafesi × tick değeri). sl yoksa atrMult verilirse ATR(14) ile SL mesafesi önerir. riskPct boşsa ayardaki işlem riski (%) kullanılır. İŞLEM AÇMADAN ÖNCE çağır; çıkan lotu mt5_trade’e ver.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          sl: { type: 'number', description: 'Stop loss fiyatı' },
          entry: { type: 'number', description: 'Giriş fiyatı (boşsa güncel fiyat)' },
          side: { type: 'string', enum: ['buy', 'sell'], description: 'Yön (varsayılan buy)' },
          riskPct: { type: 'number', description: 'Hesap riski yüzdesi (boşsa ayar)' },
          atrMult: { type: 'number', description: 'SL yoksa: SL mesafesi = atrMult × ATR(14)' },
          timeframe: { type: 'string', description: 'ATR zaman dilimi (varsayılan H1)' },
        },
        required: ['symbol'],
      },
    },
    mt5_positions: {
      description: 'Açık pozisyonlar: ticket, sembol, yön, lot, açılış fiyatı, güncel fiyat, SL/TP, yüzen kâr/zarar, açılış zamanı.',
      parameters: { type: 'object', properties: {} },
    },
    mt5_orders: {
      description: 'Bekleyen emirler (pending orders): ticket, sembol, tip (limit/stop), lot, fiyat, SL/TP.',
      parameters: { type: 'object', properties: {} },
    },
    mt5_history: {
      description: 'Kapanmış işlemler (deals) özeti: son N günde kapanan pozisyonlar, kâr/zarar, komisyon, swap. days=1 → son 24 saat.',
      parameters: {
        type: 'object',
        properties: { days: { type: 'number', description: 'Kaç gün geriye bakılsın (varsayılan 1, en fazla 90)' } },
      },
    },
    mt5_alerts: {
      description:
        'FİYAT ALARMI: mt5_alerts {action:"list"|"set"|"remove"|"clear"}. set: {symbol, price, direction:"above"|"below", mode:"once"|"repeat", note?, cooldownMin?}. ALARM MODUNU KURAN AJAN (sen) SEÇERSİN — mode zorunlu: "once" tek seferlik (ilk tetiklemede kapanır) ya da "repeat" tekrarlı (alarm açık kalır, koşul sürdükçe cooldownMin dakikada bir tekrar bildirir + sahibi ajanı uyandırır; cooldownMin varsayılan 5). Örn kritik seviye: XAUUSD 3400 üstü → mode:"repeat", cooldownMin:15; tek kere haber: mode:"once". TEMİZLİK: alarm bir bekçidir, süs değil — gereksiz alarm biriktirme; her turda list ile KENDİ alarmlarını gör, işi bitenleri (tez geçersiz, pozisyon kapandı, seviye anlamsız) clear ile SİL. clear varsayılanı YALNIZ senin kurduğun alarmlar; symbol ile daralt; ids:[...] belirli alarmlar; all:true tüm finance alarmları.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'set', 'remove', 'clear'] },
          symbol: { type: 'string', description: 'set/clear için sembol (clear: yalnız bu sembole daralt)' },
          price: { type: 'number', description: 'set için tetik fiyatı' },
          direction: { type: 'string', enum: ['above', 'below'], description: 'above: fiyat ≥ price; below: fiyat ≤ price' },
          mode: {
            type: 'string',
            enum: ['once', 'repeat'],
            description: "set için ZORUNLU: 'once' tek seferlik | 'repeat' tekrarlı (kararı alarmı kuran ajan verir)",
          },
          note: { type: 'string', description: 'Alarm notu (bildirimde görünür)' },
          cooldownMin: { type: 'number', description: "mode:'repeat' için iki tetik arası en az dakika (varsayılan 5, 0 = her tetiklemede, max 10080)" },
          once: { type: 'boolean', description: "mode'a alternatif kısa yol (true = tek seferlik)" },
          id: { type: 'string', description: 'remove için alarm id' },
          ids: { type: 'array', items: { type: 'string' }, description: 'clear için: silinecek alarm id listesi (verilirse sahiplik aranmaz)' },
          all: { type: 'boolean', description: 'clear için: true → sahiplik filtresini kaldır, kalan TÜM finance alarmlarını sil (varsayılan: yalnız kendi kurdukların)' },
        },
        required: ['action'],
      },
    },
    mt5_note: {
      description:
        'İŞLEM GÜNLÜĞÜ NOTU: mt5_note {symbol, note, ticket?, side?}. Kararın GEREKÇESİNİ kalıcı günlüğe yaz (neden girdin/çıktın, tez, iptal koşulu). Haftalık performans raporu bu notları içerir — her önemli kararda kullan.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          note: { type: 'string', description: 'Gerekçe/tez (kısa, net)' },
          ticket: { type: 'number', description: 'İlgili pozisyon ticket no (varsa)' },
          side: { type: 'string', enum: ['buy', 'sell', 'wait'] },
        },
        required: ['symbol', 'note'],
      },
    },
    mt5_limits: {
      description:
        'LOT / POZİSYON LİMİTLERİNİ oku ve GÜNCELLE — trader karar mercii: mt5_limits {action:"get"|"set", minLot?, maxLot?, maxPositions?}. get: yürürlükteki min lot / max lot / max eşzamanlı pozisyon ve işlem riski %. set: yalnız ana trader (ve finance sohbet copilot\'ı) kullanabilir — rol/işçi ajanları değiştiremez. Volatilite rejimine göre limitleri sen ayarla (ör. sakin piyasada max lot artır, haber anında düşür); değişiklik ANINDA panelde ve sonraki turda geçerli olur. Kural: minLot maxLot\'u aşamaz.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'], description: 'get: mevcut limitler · set: güncelle' },
          minLot: { type: 'number', description: 'set: yeni alt sınır (0.01-100)' },
          maxLot: { type: 'number', description: 'set: yeni üst sınır (0.01-100)' },
          maxPositions: { type: 'number', description: 'set: eşzamanlı pozisyon tavanı (1-20)' },
        },
        required: ['action'],
      },
    },
    mt5_ogrenme: {
      description:
        'SEMBOL BAZLI ÖĞRENME HAFIZASI — Beast Finance sürekli öğrenir: mt5_ogrenme {action:"list"|"add"|"remove"|"clear"|"stats"|"compact"|"forget", symbol?, text?, kind?, tags?, id?, ids?, all?}. Her sembolün KENDİ istatistiği (işlem/kazanç/kayıp, net, kâr yakalama, kâr geri verme) OTOMATİK birikir; ayrıca işlemlerden çıkardığın DERSLERİ sen kaydedersin. KURALLAR: (1) Her kapanıştan sonra (özellikle stop/tp sonrası) sembol için tek cümle ders yaz: hangi setup işe yaradı/yaramadı, saat/seans, SL yeri, hata mı hata yok mu — kind:"pattern"|"mistake"|"rule"|"observation". (2) Yeni işlem kararından ÖNCE ilgili sembolün list/stats çıktısını oku; aynı hatayı tekrarlama, işleyen deseni kullan. (3) Yanlış çıkan/genel geçersiz dersi remove/clear ile sil. Aynı ders tekrar yazılamaz ve sembol başına 24 saatte en fazla 12 ders kaydedilir. HAFIZA KENDİNİ SADELEŞTİRİR (opencode tarzı compaction): ham dersler birikince (24+) ESKİ dersler OTOMATİK olarak modele özetlettirilir ve tek KALICI ÖZETE sıkıştırılır — ham yalnız son dersler kalır; 30 günden eski dersler, 90 günden eski işlem kayıtları ve 120 gün hareketsiz semboller otomatik unutulur. Gerekirse compact {symbol} ile hemen özetlet, forget ile süresi geçenleri temizle. action:"list" symbol verilmezse tüm sembollerin özetini döner (kalıcı özet dahil). Ör: {action:"add", symbol:"XAUUSD", text:"Londra açılışında M5 EMA50 üstü momentum girişleri iyi çalışıyor", kind:"pattern"}.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove', 'clear', 'stats', 'compact', 'forget'] },
          symbol: { type: 'string', description: 'Sembol (ör. XAUUSD) — öğrenme sembol bazlıdır' },
          text: { type: 'string', description: 'add: öğrenilen ders/desen (kısa, net, tek cümle)' },
          kind: { type: 'string', enum: ['pattern', 'mistake', 'rule', 'observation'], description: 'add: kayıt türü (varsayılan observation)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'add: etiketler (ör. ["scalp","london"])' },
          id: { type: 'string', description: 'remove: kayıt id' },
          ids: { type: 'array', items: { type: 'string' }, description: 'clear: silinecek kayıt id listesi' },
          all: { type: 'boolean', description: 'clear: true → tüm öğrenme kayıtları (dikkatli)' },
        },
        required: ['action'],
      },
    },
    mt5_ea: {
      description:
        'BEASTFINANCE EA KÖPRÜSÜ (grafikte çalışan uzman danışman): action:"status" → EA heartbeat (yüklü mü, AutoTrading/EA izni, equity, pozisyon, son ack); "ping" → EA canlı yanıt; "chart" → aktif grafiğin sembol/periyot/fiyat/spread bilgisi; "note" → {symbol?, text, levels:[{price,label}]} grafik panosuna not + yatay seviye çizgileri yazar. NOT: yazdığın pano ve çizgiler görsel ajanın screenshot\'ında GÖRÜNÜR — GERÇEK grafik PNG\'si için varsayılan kurulu tool__mt5_shot kullan (EA "shot" komutu; görsel ajanın gözüne gelir), seviyeleri çizdikten sonra tool__mt5_shot ile görsel doğrula; grafiği agent_dm image ile ekibe paylaş.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'ping', 'chart', 'note'] },
          symbol: { type: 'string', description: 'note: yalnız bu sembolün grafiğine uygulanır (boş = tüm grafikler)' },
          text: { type: 'string', description: 'note: grafik panosuna yazılacak kısa analiz/plan metni' },
          levels: {
            type: 'array',
            description: 'note: yatay seviye çizgileri (destek/direnç/SL/TP)',
            items: {
              type: 'object',
              properties: { price: { type: 'number' }, label: { type: 'string' } },
              required: ['price'],
            },
          },
          timeoutSec: { type: 'number', description: 'ping/chart: EA yanıt bekleme süresi sn (varsayılan 8)' },
        },
        required: ['action'],
      },
    },
    mt5_trade: {
      description:
        'ANLIK PİYASA EMRİ AÇAR — ⚡HIZLI AKSİYON; bekleyen emir vermek ZORUNLU DEĞİL: mt5_trade {symbol, side:"buy"|"sell", volume?|riskPct?, sl?, tp?, type?, comment?, reason?}. Fırsat anıksa / teyitli kırılım-momentum-haber anında market buy/sell ile HEMEN gir — side:"buy"|"sell" yeter (type gerekmez; type:"market"|"buy_market"|"sell_market" de anlıktır). BEKLEYEN emir yalnız fiyatın bir seviyeye gelmesini beklemek gerçekten mantıklıysa kurulur: type:"buy_limit"|"sell_limit"|"buy_stop"|"sell_stop" + price (bu tipler otomatik mt5_pending hattına gider). LOT: volume ver ya da volume yerine riskPct + sl ver — sistem SL mesafesinden lotu hesaplar (tek çağrıda giriş; ayardaki işlem riski % varsayılan). Lot limiti, max pozisyon, marj ve yoğunluk sistemce zorlanır. SL vermek ŞİDDETLİ önerilir. reason: kararın tek cümlelik tezi (günlüğe yazılır).',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Örn: EURUSD' },
          side: { type: 'string', enum: ['buy', 'sell'], description: 'Yön — piyasa emri için tek başına yeterli (type gerekmez)' },
          type: {
            type: 'string',
            enum: ['market', 'buy_market', 'sell_market', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop'],
            description: 'Emir tipi. Boş/side verilirse piyasa (anlık); limit/stop verilirse bekleyen emir (price zorunlu olur).',
          },
          volume: { type: 'number', description: 'Lot (min/max lot sınırına tabi) — boşsa riskPct + sl ile OTOMATİK hesaplanır' },
          riskPct: { type: 'number', description: 'İşlem riski % (ör. 0.5-2) — volume yerine ver: SL mesafesinden lot hesaplanır (sl zorunlu)' },
          price: { type: 'number', description: 'Limit/stop emirlerinde tetik fiyatı (piyasa emrinde gerekmez)' },
          sl: { type: 'number', description: 'Stop loss fiyatı (0 = yok) — şiddetle önerilir' },
          tp: { type: 'number', description: 'Take profit fiyatı (0 = yok)' },
          comment: { type: 'string', description: 'Kısa işlem notu' },
          reason: { type: 'string', description: 'Kararın tezi/gerekçesi (tek cümle)' },
        },
        required: ['symbol'],
      },
    },
    mt5_close: {
      description:
        'Pozisyonu kapatır — TAM ya da KISMİ: mt5_close {ticket, percent?|volume?, kind?:"partial_tp"|"partial_sl"|"close", reason?}. KISMİ KAPATMA (kâr al = kısmi TP, zarar kes = kısmi stop) tamamen SENİN KARARIN — otomatik yapılmaz; gerek gördüğünde kullan. percent: pozisyonun % kaçı kapatılsın (ör. 50), volume: lot; kalan pozisyon SL/TP ile devam eder. Kalan lot broker minimumunun altında kalırsa tamamı kapanır. Risk yönetiminin temel aracıdır.',
      parameters: {
        type: 'object',
        properties: {
          ticket: { type: 'number', description: 'Pozisyon ticket no' },
          percent: { type: 'number', description: 'Kapatılacak yüzde (ör. 50) — kısmi TP/kısmi stop için' },
          volume: { type: 'number', description: 'Kapatılacak lot (percent yerine; boşsa ve percent yoksa tamamı kapanır)' },
          kind: { type: 'string', enum: ['partial_tp', 'partial_sl', 'close'], description: 'Kısmi kapatmanın nedeni: kâr al / zarar kes (günlüğe etiket olur)' },
          reason: { type: 'string', description: 'Kararın tezi (tek cümle, günlüğe yazılır)' },
        },
        required: ['ticket'],
      },
    },
    mt5_modify: {
      description: 'Pozisyonun SL/TP seviyelerini günceller: mt5_modify {ticket, sl, tp}. SL’siz pozisyon bırakmamak için kullan.',
      parameters: {
        type: 'object',
        properties: {
          ticket: { type: 'number' },
          sl: { type: 'number', description: 'Yeni SL (0 = kaldır)' },
          tp: { type: 'number', description: 'Yeni TP (0 = kaldır)' },
        },
        required: ['ticket'],
      },
    },
    mt5_pending: {
      description:
        'BEKLEYEN EMİR (limit/stop) AÇAR: mt5_pending {symbol, type:"buy_limit"|"sell_limit"|"buy_stop"|"sell_stop", volume, price, sl?, tp?, reason?}. Fiyatın seviyeye gelmesini beklemek için kullanılır. ⚡ANLIK giriş (hızlı aksiyon) için bunu kullanma — mt5_trade {symbol, side} ile market gir (buy_market/sell_market tipleri burada da kabul edilir ve anlık emre yönlenir). Otomatik işlem anahtarına tabidir. reason: kararın tezi (günlüğe yazılır).',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          type: {
            type: 'string',
            enum: ['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_market', 'sell_market'],
            description: 'Limit/stop = bekleyen (price zorunlu); buy_market/sell_market = anlık piyasa emri',
          },
          volume: { type: 'number' },
          price: { type: 'number', description: 'Tetik fiyatı — limit/stop için zorunlu, market tiplerinde gerekmez' },
          sl: { type: 'number' },
          tp: { type: 'number' },
          reason: { type: 'string', description: 'Kararın tezi/gerekçesi (tek cümle)' },
        },
        required: ['symbol', 'type', 'volume'],
      },
    },
    mt5_cancel: {
      description: 'Bekleyen emri iptal eder: mt5_cancel {ticket}.',
      parameters: {
        type: 'object',
        properties: { ticket: { type: 'number' } },
        required: ['ticket'],
      },
    },
  };
  const s = specs[name];
  return { type: 'function', function: { name, ...s } };
});

const handlers = {
  async mt5_status() {
    const st = mt5.status();
    return { ok: true, ...st };
  },
  async mt5_account() {
    if (!mt5.running) return notConnected();
    const data = await bcall('account', {}, 8000);
    return { ok: true, ...data };
  },
  async mt5_market(args) {
    if (!mt5.running) return notConnected();
    const cfg = getCfg();
    let syms = Array.isArray(args.symbols) ? args.symbols.map((s) => String(s).trim()).filter(Boolean) : [];
    if (!syms.length) syms = Array.isArray(cfg.symbols) ? cfg.symbols : [];
    const data = await bcall('symbols', { symbols: syms }, 10000);
    return { ok: true, symbols: data && data.symbols ? data.symbols : [] };
  },
  async mt5_rates(args) {
    if (!mt5.running) return notConnected();
    const symbol = String(args.symbol || '').trim().toUpperCase();
    if (!symbol) return { ok: false, error: 'symbol gerekli' };
    const timeframe = String(args.timeframe || 'M15').trim().toUpperCase();
    let count = Math.round(Number(args.count) || 200);
    count = Math.max(1, Math.min(1000, count));
    const data = await bcall('rates', { symbol, timeframe, count }, 15000);
    const rates = (data && data.rates) || [];
    return { ok: true, symbol, timeframe, count: rates.length, rates };
  },
  async mt5_indicators(args) {
    if (!mt5.running) return notConnected();
    const symbol = String(args.symbol || '').trim().toUpperCase();
    if (!symbol) return { ok: false, error: 'symbol gerekli' };
    const timeframe = String(args.timeframe || 'H1').trim().toUpperCase();
    let count = Math.round(Number(args.count) || 300);
    count = Math.max(30, Math.min(1000, count));
    const specs = Array.isArray(args.indicators) ? args.indicators.map((s) => String(s || '').trim()).filter(Boolean) : [];
    const data = await bcall('rates', { symbol, timeframe, count }, 15000);
    const rates = (data && data.rates) || [];
    if (!rates.length) return { ok: false, error: 'mum verisi yok: ' + symbol + ' ' + timeframe };
    const summary = finindicators.compute(rates, specs);
    return { ok: true, symbol, timeframe, ...summary };
  },
  async mt5_positions() {
    if (!mt5.running) return notConnected();
    const data = await bcall('positions', {}, 8000);
    const list = (data && data.positions) || [];
    return { ok: true, count: list.length, positions: list };
  },
  async mt5_orders() {
    if (!mt5.running) return notConnected();
    const data = await bcall('orders', {}, 8000);
    const list = (data && data.orders) || [];
    return { ok: true, count: list.length, orders: list };
  },
  async mt5_history(args) {
    if (!mt5.running) return notConnected();
    let days = Number(args.days);
    if (!isFinite(days) || days <= 0) days = 1;
    days = Math.min(days, 90);
    const data = await bcall('deals', { days }, 12000);
    const deals = (data && data.deals) || [];
    const stats = finstats.summarizeDeals(deals);
    return {
      ok: true,
      days,
      count: deals.length,
      netProfit: stats.netProfit,
      wins: stats.wins,
      losses: stats.losses,
      winRate: stats.winRate,
      profitFactor: stats.profitFactor,
      bySymbol: stats.bySymbol,
      deals: deals.slice(-60),
    };
  },
  async mt5_alerts(args, ctx) {
    const action = String(args.action || 'list').toLowerCase();
    if (action === 'list') {
      /* mine:true → bu oturumun (senin) kurduğu alarm — temizlik kararı için */
      const sid = ctx && ctx.sessionId ? String(ctx.sessionId) : '';
      const list = alertsApi.list().map((a) => ({ ...a, mine: sid ? String(a.sid || '') === sid : !a.sid }));
      return { ok: true, count: list.length, alerts: list };
    }
    if (action === 'remove') {
      const id = String(args.id || '').trim();
      if (!id) return { ok: false, error: 'id gerekli' };
      const removed = alertsApi.remove(id);
      return { ok: !!removed, removed: !!removed, id };
    }
    if (action === 'clear') {
      /* ALARM TEMİZLİĞİ: alarmı kuran ajan kendi gereksiz alarmlarını siler.
         Varsayılan kapsam: bu oturumun kurdukları (ctx.sessionId); symbol ile
         daralt; ids açıkça verilirse sahiplik aranmaz; all:true → tümü. */
      if (typeof alertsApi.clear !== 'function') return { ok: false, error: 'toplu alarm temizliği desteklenmiyor' };
      const ids = Array.isArray(args.ids) ? args.ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
      const all = args.all === true || String(args.all || '').toLowerCase() === 'true' || String(args.scope || '').toLowerCase() === 'all';
      const symbol = String(args.symbol || '').trim().toUpperCase();
      const sid = ctx && ctx.sessionId ? String(ctx.sessionId) : '';
      const res = alertsApi.clear({ ids, sid, all, symbol }) || {};
      const removed = Number(res.removed) || 0;
      if (removed > 0) noteTrade('alert-clear', { removed, ids: res.ids || [], symbol, all }, ctx || {});
      return { ok: true, removed, ids: res.ids || [] };
    }
    if (action === 'set') {
      const symbol = String(args.symbol || '').trim().toUpperCase();
      const price = Number(args.price);
      const direction = String(args.direction || 'above').toLowerCase();
      if (!symbol) return { ok: false, error: 'symbol gerekli' };
      if (!isFinite(price) || price <= 0) return { ok: false, error: 'price gerekli (pozitif sayı)' };
      if (direction !== 'above' && direction !== 'below') return { ok: false, error: "direction 'above' veya 'below' olmalı" };
      /* ALARM MODUNU KURAN AJAN SEÇER: 'once' (tek seferlik) ya da
         'repeat' (tekrarlı; koşul sürdükçe cooldownMin'de bir). Seçim
         yapılmadan alarm kurulamaz — sistem varsayılanına bırakılmaz. */
      const mRaw = String(args.mode || '').toLowerCase().trim();
      let once;
      if (mRaw === 'once' || mRaw === 'tek' || mRaw === 'tek_seferlik' || mRaw === 'tek-seferlik') once = true;
      else if (mRaw === 'repeat' || mRaw === 'recurring' || mRaw === 'tekrarli' || mRaw === 'surekli' || mRaw === 'always') once = false;
      else if (args.once !== undefined) once = args.once === true || String(args.once).toLowerCase() === 'true';
      else {
        return {
          ok: false,
          error:
            "mode gerekli — alarmı kuran ajan karar verir: mode:'once' (tek seferlik, ilk tetiklemede kapanır) ya da mode:'repeat' (tekrarlı; koşul sürdükçe cooldownMin'de bir uyarır, varsayılan 5 dk)",
        };
      }
      const cdRaw = Number(args.cooldownMin);
      const cooldownMin = Number.isFinite(cdRaw) ? Math.min(Math.max(Math.round(cdRaw), 0), 10080) : undefined;
      const alarm = alertsApi.set({
        symbol,
        price,
        direction,
        note: String(args.note || '').slice(0, 200),
        sid: ctx && ctx.sessionId ? String(ctx.sessionId) : '',
        ...(cooldownMin === undefined ? {} : { cooldownMin }),
        once,
      });
      if (!alarm) return { ok: false, error: 'alarm kurulamadı' };
      noteTrade('alert-set', { symbol, price, direction, id: alarm.id, note: alarm.note, cooldownMin: alarm.cooldownMin, once: alarm.once }, ctx || {});
      return { ok: true, alert: alarm };
    }
    return { ok: false, error: "action: list|set|remove|clear" };
  },
  async mt5_note(args, ctx) {
    const symbol = String(args.symbol || '').trim().toUpperCase();
    const note = String(args.note || '').trim();
    if (!symbol || !note) return { ok: false, error: 'symbol ve note gerekli' };
    noteTrade('note', {
      symbol,
      note: note.slice(0, 2000),
      ticket: Number(args.ticket) || 0,
      side: String(args.side || '').toLowerCase(),
    }, ctx || {});
    return { ok: true, saved: true };
  },
  async mt5_limits(args, ctx) {
    const action = String(args.action || 'get').toLowerCase();
    if (action === 'get') {
      return { ok: true, ...limitsApi.get() };
    }
    if (action === 'set') {
      const patch = {};
      for (const k of ['minLot', 'maxLot', 'maxPositions']) {
        if (args[k] !== undefined && args[k] !== null && args[k] !== '') patch[k] = Number(args[k]);
      }
      if (!Object.keys(patch).length) {
        return { ok: false, error: 'set için en az bir alan ver: minLot / maxLot / maxPositions' };
      }
      return await limitsApi.set(patch, ctx || {});
    }
    return { ok: false, error: 'action: get|set' };
  },
  async mt5_ogrenme(args, ctx) {
    const action = String(args.action || 'list').toLowerCase();
    const symbol = String(args.symbol || '').trim().toUpperCase();
    if (action === 'list') return learningApi.list({ symbol });
    if (action === 'stats') return learningApi.stats({ symbol });
    if (action === 'add') {
      const text = String(args.text || '').replace(/\s+/g, ' ').trim();
      if (!symbol) return { ok: false, error: 'symbol gerekli — öğrenme sembol bazlıdır' };
      if (!text) return { ok: false, error: 'text gerekli (öğrenilen ders)' };
      const kindRaw = String(args.kind || 'observation').toLowerCase();
      const kind = ['pattern', 'mistake', 'rule', 'observation'].includes(kindRaw) ? kindRaw : 'observation';
      const tags = Array.isArray(args.tags) ? args.tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 6) : [];
      const res = learningApi.add({ symbol, text: text.slice(0, 600), kind, tags, sid: (ctx && ctx.sessionId) || '' });
      if (res && res.ok) {
        noteTrade('learn', { symbol, text: text.slice(0, 300), kind }, ctx || {});
      }
      return res;
    }
    if (action === 'remove') {
      const id = String(args.id || '').trim();
      if (!id) return { ok: false, error: 'remove için id gerekli' };
      return learningApi.remove({ id, symbol });
    }
    if (action === 'clear') {
      const ids = Array.isArray(args.ids) ? args.ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
      const all = args.all === true || String(args.all || '').toLowerCase() === 'true';
      return learningApi.clear({ ids, symbol, all });
    }
    if (action === 'compact') {
      /* OPENCODE TARZI ÖZETLEME: eski dersler modele özetlettirilir, ham yalnız
         son dersler kalır — bellek sadeleşir (normalde otomatik de çalışır) */
      if (!symbol) return { ok: false, error: 'compact için symbol gerekli' };
      if (typeof learningApi.compact !== 'function') return { ok: false, error: 'özetleme kullanılamıyor' };
      return await learningApi.compact({ symbol });
    }
    if (action === 'forget') {
      if (typeof learningApi.forget !== 'function') return { ok: false, error: 'temizleme kullanılamıyor' };
      return learningApi.forget();
    }
    return { ok: false, error: 'action: list|add|remove|clear|stats|compact|forget' };
  },
  async mt5_ea(args) {
    if (!mt5.running) return notConnected();
    const action = String(args.action || 'status').toLowerCase();
    if (action === 'status') {
      const data = await bcall('ea_status', {}, 10000);
      return { ok: true, ...data };
    }
    if (action === 'note') {
      const levels = Array.isArray(args.levels)
        ? args.levels
            .slice(0, 20)
            .map((x) => ({ price: Number(x && x.price) || 0, label: String((x && x.label) || '').slice(0, 40) }))
            .filter((x) => x.price > 0)
        : [];
      const data = await bcall('ea_note', {
        symbol: String(args.symbol || '').trim().toUpperCase(),
        text: String(args.text || '').slice(0, 4000),
        levels,
      }, 10000);
      return { ok: true, ...data, note: 'Grafik panosu güncellendi — computer_look screenshot\'ında görünür' };
    }
    if (action === 'ping' || action === 'chart') {
      const timeoutSec = Math.max(2, Math.min(20, Number(args.timeoutSec) || 8));
      const data = await bcall('ea_cmd', { cmd: action, timeoutSec }, (timeoutSec + 6) * 1000);
      return { ok: true, ...data };
    }
    return { ok: false, error: 'action: status|ping|chart|note' };
  },
  async mt5_risksize(args) {
    if (!mt5.running) return notConnected();
    const cfg = getCfg();
    const symbol = String(args.symbol || '').trim().toUpperCase();
    if (!symbol) return { ok: false, error: 'symbol gerekli' };
    const info = await symInfoRow(symbol);
    if (!info) return { ok: false, error: 'sembol bulunamadı: ' + symbol + ' (MT5 Market Watch?)' };
    const side = String(args.side || 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy';
    const entry = Number(args.entry) || tickPrice(info, side);
    let sl = Number(args.sl) || 0;
    let atr = null;
    let timeframe = '';
    if (!(sl > 0) && Number(args.atrMult) > 0) {
      timeframe = String(args.timeframe || 'H1').trim().toUpperCase();
      const rd = await bcall('rates', { symbol, timeframe, count: 100 }, 15000);
      const rates = (rd && rd.rates) || [];
      if (rates.length >= 20) {
        const series = finindicators.atrSeries(
          rates.map((r) => r.high),
          rates.map((r) => r.low),
          rates.map((r) => r.close),
          14
        );
        atr = series[series.length - 1];
        if (atr > 0) {
          const d = atr * Number(args.atrMult);
          sl = side === 'buy' ? entry - d : entry + d;
        }
      }
    }
    if (!(sl > 0)) return { ok: false, error: 'sl ya da atrMult gerekli' };
    const riskPct = Number(args.riskPct) > 0 ? Number(args.riskPct) : Number(cfg.riskPerTradePct) || 0;
    if (!(riskPct > 0)) return { ok: false, error: 'riskPct gerekli (ayarlarda işlem riski %0)' };
    const acct = await bcall('account', {}, 8000);
    const balance = Number(acct && acct.account && acct.account.balance) || 0;
    if (!(balance > 0)) return { ok: false, error: 'bakiye okunamadı' };
    const riskAmount = (balance * riskPct) / 100;
    const res = finrisk.calcRiskLot(info, entry, sl, riskAmount, cfg.maxLot, cfg.minLot);
    if (res.error) return { ok: false, error: res.error, raw: res.raw, lossPerLot: res.lossPerLot, riskAmount: Math.round(riskAmount * 100) / 100 };
    const digits = Number(info.digits) || 5;
    const dist = Math.abs(entry - sl);
    const closeErr = finrisk.stopsTooClose(info, entry, sl, 0);
    return {
      ok: true,
      symbol,
      side,
      entry: Number(entry.toFixed(digits)),
      sl: Number(sl.toFixed(digits)),
      volume: res.volume,
      riskPct,
      riskAmount: Math.round(riskAmount * 100) / 100,
      lossPerLot: res.lossPerLot,
      distance: Number(dist.toFixed(digits)),
      atr: atr != null ? Math.round(atr * 1e6) / 1e6 : null,
      timeframe: timeframe || null,
      capped: !!res.capped,
      raised: !!res.raised,
      warning: closeErr || undefined,
      minLot: Number(cfg.minLot) || 0.01,
      maxLot: Number(cfg.maxLot) || 0.1,
    };
  },
  async mt5_trade(args, ctx) {
    /* TÜM EMİR TİPLERİ: piyasa (buy/sell, buy_market/sell_market) ve
       bekleyen (buy_limit/sell_limit/buy_stop/sell_stop) — bekleyen tip
       verilirse mt5_pending'e devredilir (tek tutarlı risk hattı). */
    const t = finwatch.parseOrderType(args.type || args.orderType || args.side, args.side);
    if (!t.ok) {
      return { ok: false, error: "side 'buy'|'sell' ya da type: buy_market|sell_market|buy_limit|sell_limit|buy_stop|sell_stop" };
    }
    if (t.kind === 'pending') return handlers.mt5_pending({ ...args, type: t.type }, ctx);
    const cfg = getCfg();
    if (!cfg.allowTrading) {
      return { ok: false, error: 'Otomatik işlem KAPALI — analiz/öneri modundasın. İşlem önerisini yaz, açma.' };
    }
    if (!mt5.running) return notConnected();
    const side = t.side;
    const symbol = String(args.symbol || '').trim().toUpperCase();
    if (!symbol) return { ok: false, error: 'symbol gerekli' };
    const maxLot = Number(cfg.maxLot) || 0.1;
    const sl = Number(args.sl) || 0;
    const tp = Number(args.tp) || 0;
    const info = await symInfoRow(symbol);
    if (!info) return { ok: false, error: 'sembol bulunamadı: ' + symbol + ' (MT5 Market Watch?)' };
    const price = tickPrice(info, side);
    /* LOT: riskPct verilirse (ya da volume yokken ayar riski açıksa) SL
       mesafesinden hesaplanır; aksi halde volume broker kuralına normalize edilir */
    const explicitRisk = Number(args.riskPct) > 0 ? Number(args.riskPct) : 0;
    const wantVolume = Number(args.volume);
    let vol = 0;
    let riskInfo = null;
    if (explicitRisk > 0 || (!(wantVolume > 0) && Number(cfg.riskPerTradePct) > 0)) {
      if (!(sl > 0)) return { ok: false, error: '%risk ile lot için sl zorunlu — sl ver ya da volume kullan' };
      const riskPct = explicitRisk > 0 ? explicitRisk : Number(cfg.riskPerTradePct);
      const acct = await bcall('account', {}, 8000);
      const balance = Number(acct && acct.account && acct.account.balance) || 0;
      const riskAmount = (balance * riskPct) / 100;
      const rr = finrisk.calcRiskLot(info, price, sl, riskAmount, maxLot, cfg.minLot);
      if (rr.error) return { ok: false, error: rr.error };
      vol = rr.volume;
      riskInfo = { riskPct, riskAmount: Math.round(riskAmount * 100) / 100, lossPerLot: rr.lossPerLot, raised: !!rr.raised };
    } else {
      const norm = finrisk.normalizeVolume(info, wantVolume, maxLot, cfg.minLot);
      if (norm.error) return { ok: false, error: norm.error };
      vol = norm.volume;
    }
    const pos = await bcall('positions', {}, 8000);
    const list = (pos && pos.positions) || [];
    const maxPos = Number(cfg.maxPositions) || 3;
    if (list.length >= maxPos) {
      return { ok: false, error: `max eşzamanlı pozisyon dolu (${list.length}/${maxPos}) — önce bir pozisyon kapat` };
    }
    /* risk katmanı: stops_level + yoğunluk/net yön + marj kalkanı + disiplin */
    const riskErr = await preTradeCheck(cfg, side, symbol, info, price, vol, sl, tp, list);
    if (riskErr) return { ok: false, error: riskErr };
    /* SHADOW MOD: gerçek emir GÖNDERİLMEZ — karar teziyle günlüğe yazılır */
    if (cfg.shadowMode) {
      noteTrade('shadow', {
        symbol,
        side,
        volume: vol,
        sl,
        tp,
        reason: String(args.reason || '').slice(0, 500),
        risk: riskInfo,
      }, ctx);
      return {
        ok: true,
        shadow: true,
        planned: { symbol, side, volume: vol, sl, tp },
        risk: riskInfo,
        note: 'SHADOW MOD: emir GÖNDERİLMEDİ, karar günlüğe yazıldı. Gerçek işlem için TRADE AJANI ayarlarından shadow modu kapat.',
      };
    }
    const data = await bcall('market', {
      symbol,
      side,
      volume: vol,
      sl,
      tp,
      deviation: 20,
      comment: String(args.comment || 'Beast').slice(0, 26),
    }, 20000);
    noteTrade('trade', { symbol, side, volume: vol, sl, tp, risk: riskInfo, comment: String(args.comment || ''), reason: String(args.reason || '').slice(0, 500), result: data && data.result }, ctx);
    return { ok: true, opened: { symbol, side, volume: vol, sl, tp }, risk: riskInfo, result: data && data.result };
  },
  async mt5_close(args, ctx) {
    if (!mt5.running) return notConnected();
    const ticket = Number(args.ticket);
    if (!ticket) return { ok: false, error: 'ticket gerekli' };
    /* KISMİ KAPATMA (kısmi TP / kısmi stop): kararı AJAN verir — otomatik
       değildir. percent: pozisyonun % kaçı; volume: lot. Kalan pozisyon
       SL/TP ile devam eder. */
    const percent = Math.max(0, Math.min(100, Number(args.percent) || 0));
    let vol = Number(args.volume) || 0;
    let pos = null;
    try {
      const posRes = await bcall('positions', {}, 8000);
      pos = ((posRes && posRes.positions) || []).find((x) => Number(x.ticket) === ticket) || null;
    } catch {}
    if (!pos) return { ok: false, error: 'pozisyon bulunamadı: ' + ticket };
    const pvol = Number(pos.volume) || 0;
    if (!(pvol > 0)) return { ok: false, error: 'pozisyon hacmi okunamadı: ' + ticket };
    let info = null;
    try { info = await symInfoRow(String(pos.symbol || '')); } catch {}
    if (percent > 0 && !(vol > 0)) {
      const norm = finrisk.normalizeVolume(info || {}, (pvol * percent) / 100);
      if (norm.error) return { ok: false, error: norm.error };
      vol = norm.volume;
    }
    if (!(vol > 0)) vol = pvol; /* hacim yok → tamamı */
    if (vol > pvol + 1e-9) return { ok: false, error: `kapatılacak lot pozisyondan büyük (${vol} > ${pvol})` };
    /* kalan pozisyon broker minimumunun altında kalacaksa TAMAMINI kapat */
    const vmin = Number(info && info.volume_min) || 0.01;
    const remain = pvol - vol;
    if (remain > 0 && remain < vmin - 1e-9) vol = pvol;
    const isPartial = vol < pvol - 1e-9;
    const kind = String(args.kind || args.closeKind || '').toLowerCase();
    const data = await bcall('close', { ticket, volume: vol }, 20000);
    noteTrade('close', {
      ticket,
      volume: vol,
      percent: percent || 0,
      partial: isPartial,
      closeKind: /partial_sl|kismi_stop|partial_stop/.test(kind) ? 'partial_sl' : /partial_tp|kismi_tp|partial_take/.test(kind) ? 'partial_tp' : kind,
      reason: String(args.reason || '').slice(0, 300),
      result: data && data.result,
    }, ctx);
    return { ok: true, closed: { ticket, volume: vol, partial: isPartial }, remaining: Math.round(remain * 1e8) / 1e8, result: data && data.result };
  },
  async mt5_modify(args, ctx) {
    if (!mt5.running) return notConnected();
    const ticket = Number(args.ticket);
    if (!ticket) return { ok: false, error: 'ticket gerekli' };
    const data = await bcall('modify', {
      ticket,
      sl: Number(args.sl) || 0,
      tp: Number(args.tp) || 0,
    }, 20000);
    noteTrade('modify', { ticket, sl: Number(args.sl) || 0, tp: Number(args.tp) || 0 }, ctx);
    return { ok: true, result: data && data.result };
  },
  async mt5_pending(args, ctx) {
    /* 6 TİP: buy_limit/sell_limit/buy_stop/sell_stop BEKLEYEN emir;
       buy_market/sell_market ANLIK piyasa emri — mt5_trade'e devredilir. */
    const t = finwatch.parseOrderType(args.type || args.orderType, args.side);
    if (!t.ok) {
      return { ok: false, error: 'type: buy_limit|sell_limit|buy_stop|sell_stop|buy_market|sell_market' };
    }
    if (t.kind === 'market') return handlers.mt5_trade({ ...args, type: 'market', orderType: '', side: t.side }, ctx);
    const cfg = getCfg();
    if (!cfg.allowTrading) {
      return { ok: false, error: 'Otomatik işlem KAPALI — bekleyen emir de açılamaz. Öneriyi yaz.' };
    }
    if (!mt5.running) return notConnected();
    const symbol = String(args.symbol || '').trim().toUpperCase();
    if (!symbol) return { ok: false, error: 'symbol gerekli' };
    const info = await symInfoRow(symbol);
    if (!info) return { ok: false, error: 'sembol bulunamadı: ' + symbol + ' (MT5 Market Watch?)' };
    const norm = finrisk.normalizeVolume(info, args.volume, Number(cfg.maxLot) || 0.1, cfg.minLot);
    if (norm.error) return { ok: false, error: norm.error };
    const vol = norm.volume;
    const ptype = t.type;
    const pside = t.side;
    if (!(Number(args.price) > 0)) {
      return { ok: false, error: 'price gerekli — limit/stop bekleyen emirleri için tetik fiyatı ver (market tipleri anlıktır, price istemez)' };
    }
    /* KODLA DİSİPLİN: bekleyen emir de işlem sayılır */
    let discErr = null;
    try { discErr = discipline(pside, symbol, []); } catch {}
    if (discErr) return { ok: false, error: discErr };
    /* SHADOW MOD: bekleyen emir de GÖNDERİLMEZ — tez günlüğe düşer */
    if (cfg.shadowMode) {
      noteTrade('shadow', { symbol, type: ptype, side: pside, volume: vol, price: Number(args.price) || 0, sl: Number(args.sl) || 0, tp: Number(args.tp) || 0, reason: String(args.reason || '').slice(0, 500) }, ctx);
      return { ok: true, shadow: true, note: 'SHADOW MOD: bekleyen emir GÖNDERİLMEDİ, karar günlüğe yazıldı.' };
    }
    const data = await bcall('pending', {
      symbol,
      type: ptype,
      volume: vol,
      price: Number(args.price) || 0,
      sl: Number(args.sl) || 0,
      tp: Number(args.tp) || 0,
      comment: String(args.comment || 'Beast').slice(0, 26),
    }, 20000);
    noteTrade('pending', { symbol, type: ptype, volume: vol, reason: String(args.reason || '').slice(0, 500) }, ctx);
    return { ok: true, result: data && data.result };
  },
  async mt5_cancel(args, ctx) {
    if (!mt5.running) return notConnected();
    const ticket = Number(args.ticket);
    if (!ticket) return { ok: false, error: 'ticket gerekli' };
    const data = await bcall('cancel', { ticket }, 20000);
    noteTrade('cancel', { ticket }, ctx);
    return { ok: true, result: data && data.result };
  },
};

module.exports = { definitions, handlers, NAMES, setConfig, setNotify, setAlerts, setDiscipline, setLimits, setLearning };
