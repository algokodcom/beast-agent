'use strict';

/* Beast Agent — Benzersiz CİHAZ KODU (Beast Mobile / cihaz eşleme)
   Her makinede BİR KEZ üretilir, %APPDATA%\beast\device.json'da saklanır;
   uygulama güncellense, kod DEĞİŞMEZ (kullanıcı verisi klasöründe durduğundan
   npm update/settings sıfırlama kokan dokunulmaz). Ayarlar → Beast Mobile
   panelinde görünür; telefon APK istemcisi bu kodla auth olur.
   Kod karışıklıksız alfabe kullanır: 0/O ve 1/I/L yok — telefona elle de
   yazabilir. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { beastDir } = require('./config');

/* Karışan karakterlerden kaçınan alfabe */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function deviceFile() {
  return path.join(beastDir(), 'device.json');
}

function genCode() {
  const pick = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) {
      s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    return s;
  };
  return 'BEAST-' + pick(4) + '-' + pick(4);
}

function isValidCode(code) {
  return /^BEAST-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(
    String(code || '').toUpperCase().trim()
  );
}

let cache = null;

/* Test köprüsü: modül içi önbelleği sıfırlar (BEAST_DATA değiştirilince) */
function resetCache() {
  cache = null;
}

function load() {
  if (cache) return cache;
  try {
    const d = JSON.parse(fs.readFileSync(deviceFile(), 'utf8'));
    if (d && typeof d === 'object') {
      d.code = String(d.code || '').toUpperCase().trim();
      if (!isValidCode(d.code)) d.code = '';
      d.name = String(d.name || 'Beast Agent').slice(0, 40);
      d.paired = Array.isArray(d.paired) ? d.paired : [];
      d.createdAt = String(d.createdAt || new Date().toISOString());
      cache = d;
      return cache;
    }
  } catch {}
  cache = { code: '', name: 'Beast Agent', createdAt: new Date().toISOString(), paired: [] };
  return cache;
}

function persist(d) {
  try {
    fs.mkdirSync(beastDir(), { recursive: true });
    fs.writeFileSync(deviceFile(), JSON.stringify(d, null, 2));
  } catch {}
  cache = d;
}

/* Ana giriş: cihaz kaydı — yazmaz, sadece okur */
function getDevice() {
  return load();
}

/* İLK KULLANIM: kod yoksa üret, diske yaz (boot'ta bir kez çağrılır) */
function ensureDevice() {
  const d = load();
  if (!isValidCode(d.code)) {
    d.code = genCode();
    persist(d);
  }
  return d;
}

/* Kodu yeniden üret — ESKİ İSTEMCİLER geçersiz kalır (ws sunucusu
   bunları atmalı; main güvenlik için aktif client'ları kapatır) */
function regenCode() {
  const d = load();
  d.code = genCode();
  d.regenAt = new Date().toISOString();
  persist(d);
  return d;
}

function deviceName() {
  return String(load().name || 'Beast Agent');
}

function setDeviceName(name) {
  const d = load();
  d.name = String(name || '').trim().slice(0, 40) || 'Beast Agent';
  persist(d);
  return d;
}

/* Telefon/istemci eşleşme kayıt listesi (son görülen üstte) */
function upsertPhone(info) {
  const d = load();
  const id = String((info && info.id) || '').slice(0, 64);
  let p = d.paired.find((x) => x.id === id);
  const now = new Date().toISOString();
  if (!p) {
    p = {
      id,
      name: String((info && info.name) || 'Telefon').slice(0, 40),
      platform: String((info && info.platform) || 'android').slice(0, 20),
      pairedAt: now,
      lastSeen: now,
    };
    d.paired.push(p);
    if (d.paired.length > 12) d.paired = d.paired.slice(-12);
  } else {
    p.name = String((info && info.name) || p.name || 'Telefon').slice(0, 40);
    p.platform = String((info && info.platform) || p.platform || 'android').slice(0, 20);
    p.lastSeen = now;
  }
  persist(d);
  return p;
}

function listPhones() {
  return (load().paired || [])
    .slice()
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
}

function kickPhone(id) {
  const d = load();
  d.paired = d.paired.filter((x) => x.id !== String(id || ''));
  persist(d);
}

module.exports = {
  genCode,
  isValidCode,
  deviceFile,
  getDevice,
  ensureDevice,
  regenCode,
  deviceName,
  setDeviceName,
  upsertPhone,
  listPhones,
  kickPhone,
  resetCache,
};
