'use strict';

/* Kanal (WhatsApp/Telegram/Discord) kişi-başına oturum yardımcıları.
   Eski "kanal tek oturumu" düzeninden güvenli göç + oturum anahtarı
   normalizasyonu. Saf fonksiyonlar — test edilebilir.

   ESKİ DÜZEN: tüm jid/chatId'ler AYNI oturuma bağlıydı → A'nın konuşması
   B'ye bağlam olarak sızıyordu. YENİ DÜZEN: her sohbet kendi oturumunda.
   Göç kuralı: paylaşılan oturum SAHİPTE kalır (sahip jid'i bulunamazsa ilk
   jid'de); diğerleri ayrılır ve o ortak oturuma erişemez — geçmiş
   kayıtlarından da düşürülür ki /open ile açamasınlar. */

/* jid içindeki rakamları çıkarır: "905xx:12@s.whatsapp.net" → "905xx" */
function jidDigits(jid) {
  return String(jid || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '');
}

/* DM oturum anahtarı: LID/cihaz eki yerine GERÇEK numara esas alınır —
   aynı kişi iki ayrı oturum açmasın. pn verilmezse jid'in kendisi döner.
   Gruplar kendi jid'iyle ayrılır. */
function dmSessionKey(jid, pn) {
  const j = String(jid || '');
  if (!j) return '';
  if (j.endsWith('@g.us')) return j;
  const p = jidDigits(pn);
  if (p) return p + '@s.whatsapp.net';
  const base = j.split('@')[0].split(':')[0];
  if (/^\d+$/.test(base) && j.endsWith('@s.whatsapp.net')) return base + '@s.whatsapp.net';
  return j;
}

/* Paylaşılan (birden çok sohbete bağlı) oturumları ayırır.
   chats: Map<jid, sid>, history: Map<jid, sid[]> (yerinde değiştirilir).
   döner: true → değişiklik oldu (diske yazılmalı). */
function migrateSharedSessions({ chats, history, ownerDigits, historyCap = 20 }) {
  const bySid = new Map();
  for (const [j, s] of chats) {
    const sid = String(s);
    if (!bySid.has(sid)) bySid.set(sid, []);
    bySid.get(sid).push(String(j));
  }
  const own = String(ownerDigits || '').replace(/\D/g, '');
  let dirty = false;
  for (const [sid, jids] of bySid) {
    if (jids.length < 2) continue;
    /* sahip jid'i ortak oturumda kalır; sahip yoksa kanonik numara jid'i
       (@s.whatsapp.net), o da yoksa ilk jid (mevcut bağlam korunur) */
    const keep =
      (own && jids.find((j) => jidDigits(j).endsWith(own))) ||
      jids.find((j) => j.endsWith('@s.whatsapp.net')) ||
      jids[0];
    for (const j of jids) {
      if (j === keep) continue;
      chats.delete(j);
      const h = (history.get(j) || []).filter((x) => String(x) !== sid);
      if (h.length) history.set(j, h.slice(-historyCap));
      else history.delete(j);
      dirty = true;
    }
  }
  return dirty;
}

/* Birden çok kanal oturumunun sid'lerini tek Set'te toplar: otomatik işler
   (cron/izleyici/fallout) bu oturumlara ASLA enjekte edilmez. */
function collectSessionIds(...maps) {
  const set = new Set();
  for (const m of maps) {
    if (!m) continue;
    for (const s of m.values()) if (s) set.add(String(s));
  }
  return set;
}

module.exports = { jidDigits, dmSessionKey, migrateSharedSessions, collectSessionIds };
