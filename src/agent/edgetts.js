'use strict';

/* Beast Edge TTS: Microsoft Edge'in ÜCRETSİZ sinir ağı seslendirme servisi
   (edge-tts protokolünün Node portu — bağımlılık yok, ws yeterli).
   Türkçe sesler: tr-TR-AhmetNeural (erkek), tr-TR-EmelNeural (kadın).
   Çıktı: MP3 buffer (24kHz 48kbps mono) — WhatsApp sesli not ve chat TTS uyumlu.

   Protokol: wss speech.platform.bing.com → speech.config (text) → SSML (binary,
   2 bayt BE başlık uzunluğu) → binary mp3 parçaları → "Path:turn.end" bitiş.
   2024+ DRM: Sec-MS-GEC (5 dk'lık pencere SHA256) + Sec-MS-GEC-Version zorunlu. */

const crypto = require('crypto');
const WebSocket = require('ws');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
/* Eski uç (speech.platform.bing.com) 2025-08'de 403 vermeye başladı —
   Edge'in YENİ uç noktası: api.msedgeservices.com, param adı Ocp-Apim-Subscription-Key
   (değer aynı TrustedClientToken). Bakınız rany2/edge-tts #401 → 7.2.7 düzeltmesi. */
const WSS_URL = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
const GEC_VERSION = '1-139.0.3405.102';
const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const CHROMIUM_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const WIN_EPOCH = 11644473600;
const TICKS_DIVISOR = 10000000; // 100-ns ticks

/* Kullanılabilir popüler sesler (UI'da listelenir) */
const EDGE_VOICES = [
  { id: 'tr-TR-AhmetNeural', name: 'Ahmet (Türkçe, erkek)' },
  { id: 'tr-TR-EmelNeural', name: 'Emel (Türkçe, kadın)' },
  { id: 'en-US-GuyNeural', name: 'Guy (English, male)' },
  { id: 'en-US-AriaNeural', name: 'Aria (English, female)' },
  { id: 'de-DE-KatjaNeural', name: 'Katja (Deutsch, weiblich)' },
  { id: 'ar-SA-HamedNeural', name: 'Hamed (العربية)' },
];

function uuidNoDash() {
  return crypto.randomUUID().replace(/-/g, '');
}

/* Sec-MS-GEC — edge-tts drm.py birebir:
   ticks = unix_sn + WIN_EPOCH; ticks -= ticks % 300; ticks *= S_TO_NS/100 (1e7);
   hash( f"{ticks:.0f}" + token ).upper(). Float matematiği Python'la aynı →
   birebir aynı string çıkar. */
function secMsGec() {
  let ticks = Date.now() / 1000; // unix saniye
  ticks += WIN_EPOCH;            // Windows file-time epoch
  ticks -= ticks % 300;          // en yakın 5 dakikaya aşağı yuvarla
  ticks *= 1e7;                  // 100-nanoSN tick (S_TO_NS/100)
  return crypto
    .createHash('sha256')
    .update(Math.round(ticks).toString() + TRUSTED_CLIENT_TOKEN, 'ascii')
    .digest('hex')
    .toUpperCase();
}

/* TTS'e girmeden önce metni sadeleştir: markdown/kod/emoji/URL gürültüsü sesi bozar */
function sanitizeForSpeech(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' kod bloğu ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[*_#>|~]+/g, ' ')
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
}

function ssmlFor(text, voice, rate, pitch) {
  const lang = String(voice || '').split('-').slice(0, 2).join('-') || 'tr-TR';
  const body = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='" + lang + "'>" +
    "<voice name='" + (voice || 'tr-TR-AhmetNeural') + "'>" +
    "<prosody pitch='" + (pitch || '+0Hz') + "' rate='" + (rate || '+0%') + "' volume='+0%'>" +
    body +
    '</prosody></voice></speak>'
  );
}

function ts() {
  return new Date().toISOString();
}

/**
 * Metni Edge TTS ile seslendirir.
 * @returns {Promise<Buffer>} mp3 audio
 */
function synthesize(text, { voice, rate, pitch } = {}) {
  const clean = sanitizeForSpeech(text);
  if (!clean) return Promise.reject(new Error('boş metin'));
  const v = String(voice || 'tr-TR-AhmetNeural').trim();
  const connectionId = uuidNoDash();
  const url =
    WSS_URL +
    '?Ocp-Apim-Subscription-Key=' + TRUSTED_CLIENT_TOKEN +
    '&Sec-MS-GEC=' + secMsGec() +
    '&Sec-MS-GEC-Version=' + GEC_VERSION +
    '&ConnectionId=' + connectionId;

  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url, {
        headers: {
          Origin: CHROMIUM_ORIGIN,
          'User-Agent': EDGE_UA,
          'Accept-Encoding': 'gzip, deflate, br',
        },
        handshakeTimeout: 12000,
      });
    } catch (e) {
      return reject(e);
    }

    const chunks = [];
    let done = false;
    const finish = (err, buf) => {
      if (done) return;
      done = true;
      try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch {}
      try { if (ws) ws.terminate(); } catch {}
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(buf);
    };
    const timer = setTimeout(() => finish(new Error('edge tts zaman aşımı')), 30000);

    ws.on('open', () => {
      const config =
        'X-Timestamp:' + ts() + '\r\n' +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        JSON.stringify({
          context: {
            synthesis: {
              audio: {
                metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
              },
            },
          },
        });
      ws.send(config, (err) => { if (err) finish(err); });

      const ssmlHeader =
        'X-RequestId:' + uuidNoDash() + '\r\n' +
        'Content-Type:application/ssml+xml\r\n' +
        'X-Timestamp:' + ts() + 'Z\r\n' +
        'Path:ssml\r\n\r\n';
      const ssmlBody = ssmlFor(clean, v, rate, pitch);
      const header = Buffer.from(ssmlHeader, 'utf8');
      const body = Buffer.from(ssmlBody, 'utf8');
      const len = Buffer.alloc(2);
      len.writeUInt16BE(header.length, 0);
      ws.send(Buffer.concat([len, header, body]), (err) => { if (err) finish(err); });
    });

    ws.on('message', (data, isBinary) => {
      try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (!isBinary) {
          const msg = buf.toString('utf8');
          if (msg.includes('Path:turn.end')) {
            const audio = Buffer.concat(chunks);
            if (!audio.length) finish(new Error('edge tts boş ses döndü'));
            else finish(null, audio);
          }
          return;
        }
        if (buf.length < 2) return;
        const headerLen = buf.readUInt16BE(0);
        const header = buf.slice(2, 2 + headerLen).toString('utf8');
        if (header.includes('Path:audio.metadata')) return; // kelime sınırları — ses değil
        const audio = buf.slice(2 + headerLen);
        if (audio.length) chunks.push(audio);
      } catch {}
    });

    ws.on('error', (e) => finish(e));
    ws.on('close', () => {
      if (!done) {
        const audio = Buffer.concat(chunks);
        if (audio.length) finish(null, audio);
        else finish(new Error('edge tts bağlantı kapandı (ses yok)'));
      }
    });
  });
}

module.exports = { synthesize, sanitizeForSpeech, EDGE_VOICES };
