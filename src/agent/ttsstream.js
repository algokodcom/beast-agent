'use strict';

/* TELEFON TTS AKIŞI — cümle parçalayıcı.
   Telefona cevabın TAMAMINI tek WAV/AAC olarak göndermek yerine, cevabı
   doğal duraklardan parçalara ayırırız: ilk parça kısa tutulur (ilk ses
   hemen gelsin), sonraki parçalar oynatma sürerken sentezlenir.

   - Cümle sonu: . ! ? … (ondalık nokta "3.14" cümle sonu sayılmaz)
   - Uzun cümle: virgül → noktalı virgül → boşluk sırasıyla bölünür
     (kelime ortasından bölünmez)
   - Çok kısa parçalar (kısaltma vb.) komşusuna yapıştırılır
   - Boş parça üretilmez; metin yoksa [] döner

   first: ilk parçanın hedef uzunluğu (kısa = hızlı ilk ses)
   rest:  sonraki parçaların hedef uzunluğu (sentez oynatmanın gerisinde kalsın)
*/
function sentenceParts(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const out = [];
  let start = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;
    /* ondalık sayı: 3.14 — cümle sonu değil */
    if (ch === '.' && i > 0 && i + 1 < t.length && /\d/.test(t[i - 1]) && /\d/.test(t[i + 1])) continue;
    let j = i + 1;
    while (j < t.length && /[.!?…"')\]]/.test(t[j])) j++;
    if (j < t.length && !/\s/.test(t[j])) continue;
    const seg = t.slice(start, j).trim();
    if (seg) out.push(seg);
    start = j;
    i = j - 1;
  }
  const tail = t.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/* kısa parçaları (kısaltmalar: "Dr.", "vb.") SONRAKİ parçayla birleştir;
   metnin sonunda kısa parça kalırsa ("Tamam.") öncekine yapıştır */
function mergeShort(parts, minLen = 16) {
  const out = [];
  let carry = '';
  for (const p of parts) {
    const s = (carry ? carry + ' ' : '') + p;
    carry = '';
    if (s.length < minLen) {
      carry = s;
      continue;
    }
    out.push(s);
  }
  if (carry) {
    if (out.length) out[out.length - 1] += ' ' + carry;
    else out.push(carry);
  }
  if (out.length > 1 && out[out.length - 1].length < 12) out[out.length - 2] += ' ' + out.pop();
  return out;
}

/* uzun parçayı doğal bir yerden ikiye böl: virgül → noktalı virgül → boşluk */
function cutLong(s, limit) {
  const lim = Math.max(24, limit);
  let cut = s.lastIndexOf(',', lim);
  if (cut < lim * 0.5) cut = s.lastIndexOf(';', lim);
  if (cut < lim * 0.5) cut = s.lastIndexOf(':', lim);
  if (cut < lim * 0.5) cut = s.lastIndexOf(' ', lim);
  if (cut < lim * 0.5) cut = Math.min(s.length - 1, lim - 1);
  return [s.slice(0, cut + 1).trim(), s.slice(cut + 1).trim()];
}

function chunks(text, opts = {}) {
  /* İlk parça 48 karakter: ~3 sn ses / ~1 sn sentez — telefon ilk sesi
     daha çabuk duysun. Sonrakiler 160: çalma sürerken sentez yetişir. */
  const first = Math.max(24, Number(opts.first) || 48);
  const rest = Math.max(first, Number(opts.rest) || 160);
  const sents = mergeShort(sentenceParts(text));
  const out = [];
  let cur = '';
  const limit = () => (out.length === 0 ? first : rest);
  const flush = () => {
    const s = cur.trim();
    if (s) out.push(s);
    cur = '';
  };
  for (const s0 of sents) {
    let s = s0;
    while (s.length > limit() * 1.25) {
      const [head, tail] = cutLong(s, limit());
      if (!head || !tail) break;
      if (cur) flush();
      out.push(head);
      s = tail;
    }
    if (!s) continue;
    if (cur && (cur.length + 1 + s.length) > limit()) flush();
    cur = cur ? cur + ' ' + s : s;
    if (cur.length >= limit()) flush();
  }
  flush();
  return out;
}

module.exports = { chunks, sentenceParts };
