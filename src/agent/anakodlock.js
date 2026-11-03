'use strict';

/* ANA KOD KİLİDİ — founder parolası.

   Kilit süreç başında KAPALIDIR: agent kendi kaynak/kurulum klasörüne
   yazamaz, silemez, komut/betikle değiştiremez (okumak serbesttir).
   Kilidi yalnızca founder'ın parola cümlesini içeren GERÇEK kullanıcı
   mesajı açar (engine.send + userAction). Agent kendi kendine açamaz:
   parola yalnızca kullanıcı mesajlarında aranır, araç çıktılarında değil.
   Açılan kilit süreç ömrü boyunca açık kalır; uygulama yeniden başlayınca
   kilit kendiliğinden geri gelir.

   Parola kaynakta DÜZ METİN tutulmaz — normalize edilmiş cümlenin SHA-256
   özeti saklanır. Parolayı değiştirmek için yeni cümleyi normalize edip
   özetini PHRASE_HASH'e, kelime sayısını PHRASE_WORDS'e yaz:
     node -e "console.log(require('./src/agent/anakodlock').hash('yeni parola cümlesi'))" */

const crypto = require('crypto');

const PHRASE_HASH = '5153c5a0da53dc298c1435d24922ae46652c08eb12abd8f9cb97d34b9e797995';
const PHRASE_WORDS = 5;

let unlocked = false;

/* Karşılaştırma biçimi: küçük harf, Türkçe harfler ASCII'ye, noktalama ve
   fazla boşluk tek boşluğa iner. "  ÇOK  fazla   BOŞLUK! "
   → "cok fazla bosluk" */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\u0307/g, '')
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/â/g, 'a')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function hash(text) {
  return crypto.createHash('sha256').update(normalize(text), 'utf8').digest('hex');
}

function isUnlocked() {
  return unlocked;
}

function unlock() {
  unlocked = true;
  return true;
}

function lock() {
  unlocked = false;
  return false;
}

/* Metindeki kelimelerin ham konumları (maskeleme için) + normalize biçimi */
function wordSpans(text) {
  const spans = [];
  const re = /[0-9A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]+/g;
  let m;
  while ((m = re.exec(text))) {
    const norm = normalize(m[0]);
    if (norm) spans.push({ start: m.index, end: m.index + m[0].length, norm });
  }
  return spans;
}

/* Parola cümlesinin geçtiği aralıklar (kelime penceresi).
   Parola cümle içinde geçebilir: "lütfen <parola>, şunu düzelt" eşleşir;
   kelimeleri eksik/farklı sırada olan metin eşleşmez. */
function phraseSpans(text) {
  const spans = wordSpans(String(text || ''));
  const hits = [];
  for (let i = 0; i + PHRASE_WORDS <= spans.length; i++) {
    const win = spans.slice(i, i + PHRASE_WORDS);
    if (hash(win.map((s) => s.norm).join(' ')) === PHRASE_HASH) {
      hits.push({ start: win[0].start, end: win[win.length - 1].end });
      i += PHRASE_WORDS - 1;
    }
  }
  return hits;
}

function isFounderPhrase(text) {
  if (!normalize(text)) return false;
  return phraseSpans(text).length > 0;
}

/* Parolayı mesaj metninden maskeler (oturum geçmişine/loglara düz metin
   düşmesin). Yalnızca parola cümlesinin kapladığı aralık değişir. */
function redact(text) {
  const raw = String(text || '');
  if (!normalize(raw)) return raw;
  const hits = phraseSpans(raw);
  if (!hits.length) return raw;
  let out = raw;
  for (let i = hits.length - 1; i >= 0; i--) {
    out = out.slice(0, hits[i].start) + '[FOUNDER PAROLASI]' + out.slice(hits[i].end);
  }
  return out;
}

/* Gerçek kullanıcı mesajını denetler; parola geçerliyse kilidi açar.
   Dönüş: kilit BU çağrıda açıldı mı? (zaten açıksa false) */
function noteUserText(text) {
  if (unlocked) return false;
  if (!isFounderPhrase(text)) return false;
  return unlock();
}

module.exports = {
  normalize,
  hash,
  isFounderPhrase,
  redact,
  isUnlocked,
  unlock,
  lock,
  noteUserText,
};
