'use strict';

/* WhatsApp köprüsü — Baileys tabanlı (Beast Agent mantığı, botsuz).
   QR ile eşleme, auth %APPDATA%\jevtrader\wa-auth altında tutulur; gelen
   metin mesajları onIncoming(jid, payload, senderNum)'a düşer, send(jid,text)
   cevabı gönderir. Grup mesajları yalnız @mention (ya da "tüm mesajlar" modu)
   ile işlenir; mention tespiti telefon + LID kimliklerinin ikisiyle yapılır. */

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

let baileys = null;
try {
  baileys = require('@whiskeysockets/baileys');
} catch {
  baileys = null;
}

function waLogSafe(line) {
  try { console.log(`[WA] ${line}`); } catch {}
}

class WhatsAppBridge {
  constructor({ authDir, emit, onIncoming }) {
    this.authDir = authDir;
    this.emit = emit || (() => {});
    this.onIncoming = onIncoming || null;
    this.sock = null;
    this.connected = false;
    this.user = null;
    this.stopping = false;
    this.reconnectTimer = null;
    this._seenIds = new Set(); // işlenen mesaj id'leri — offline replay + notify çift işlemeyi önler
    this._lidPn = new Map(); // LID jid -> gerçek telefon numarası (831...@lid → 905...)
  }

  /* Ham JID'den telefon numarası — YALNIZ PN (s.whatsapp.net) kökenliyse.
     'alt:' ön eki ve cihaz soneki (:12) soyulur; @lid adresler PN sayılmaz
     (aksi halde LID rakamı numara sanılıp izin listesi eşleşmiyordu). */
  _pnOnly(jid) {
    let s = String(jid || '');
    if (!s) return '';
    if (s.startsWith('alt:')) s = s.slice(4);
    const at = s.indexOf('@');
    if (at < 0) return '';
    const host = s.slice(at + 1);
    if (host !== 's.whatsapp.net' && host !== 'hosted') return '';
    s = s.slice(0, at).split(':')[0];
    return /^\d{6,}$/.test(s) ? s : '';
  }

  /* LID jid → gerçek telefon numarası (Baileys LID eşleme deposu, auth
     klasöründe kalıcı). İzin listesi TELEFON NUMARASIYLA eşleşir. */
  async _lidToPn(lidJid) {
    const lid = String(lidJid || '');
    if (!lid.endsWith('@lid')) return '';
    const cached = this._lidPn.get(lid);
    if (cached) return cached;
    let pn = '';
    try {
      const store = this.sock && this.sock.signalRepository && this.sock.signalRepository.lidMapping;
      if (store && typeof store.getPNForLID === 'function') {
        pn = this._pnOnly(await store.getPNForLID(lid));
      }
    } catch {}
    if (pn) this._lidPn.set(lid, pn); // negatif sonuç cache'lenmez
    return pn;
  }

  /* Tek LID↔PN eşlemesini önbelleğe al */
  _cacheLidPn(m) {
    try {
      const lid = String((m && m.lid) || '');
      const pn = this._pnOnly(m && m.pn);
      if (lid.endsWith('@lid') && pn) this._lidPn.set(lid, pn);
    } catch {}
  }

  /* Kişi listesinden LID↔PN eşlemelerini önbelleğe al */
  _cacheLidPnList(list) {
    for (const c of list || []) {
      this._cacheLidPn({ lid: c && (c.lid || c.id), pn: c && (c.phoneNumber || c.pn) });
    }
  }

  get available() {
    return !!baileys;
  }

  snapshot() {
    const status = this.connected ? 'connected' : this.qr ? 'qr' : this.sock ? 'connecting' : 'disconnected';
    return {
      status,
      user: this.user,
      qr: status === 'qr' ? this.qr : '',
      available: this.available,
    };
  }

  _emitStatus(s) {
    this.emit({ type: 'status', ...s });
  }

  async start() {
    if (!baileys) throw new Error('Baileys kurulu değil: npm i @whiskeysockets/baileys qrcode');
    if (this.sock) return;
    this.stopping = false;

    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;
    fs.mkdirSync(this.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined;
    }

    this.sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ['JevTrader', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      /* false OLMALI: bot "çevrimiçi" işaretlenirse kesintide gelen mesajların
         kuyruklanması aksar; false ile bağlantı dönünce 'append' ile gelirler */
      markOnlineOnConnect: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (u) => {
      try {
        if (u.qr) {
          const dataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 240 });
          this.connected = false;
          this.qr = dataUrl;
          this._emitStatus({ status: 'qr', qr: dataUrl });
        }
        if (u.connection === 'open') {
          this.connected = true;
          this.qr = '';
          const su = this.sock.user || {};
          this.user = [su.name || su.verifiedName || '', su.id ? String(su.id).split(':')[0] : '']
            .filter(Boolean)
            .join(' · ');
          this._userIdRaw = String(su.id || '');
          this._emitStatus({ status: 'connected', user: this.user });
          this.sock.sendPresenceUpdate('available').catch(() => {});
        }
        if (u.connection === 'close') {
          const code = u.lastDisconnect && u.lastDisconnect.error &&
            u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
          const loggedOut = code === DisconnectReason.loggedOut;
          this.sock = null;
          this.qr = '';
          if (this.stopping) {
            this.connected = false;
            this._emitStatus({ status: 'disconnected' });
            return;
          }
          if (loggedOut) {
            try { fs.rmSync(this.authDir, { recursive: true, force: true }); } catch {}
            this.connected = false;
            this.user = null;
            this._emitStatus({ status: 'logged-out' });
            return;
          }
          this._emitStatus({ status: 'reconnecting' });
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => this.start().catch(() => {}), 3000);
        }
      } catch (e) {
        this._emitStatus({ status: 'error', error: String((e && e.message) || e) });
      }
    });

    this.sock.ev.on('messages.upsert', (m) => this._handleMessages(m));

    /* LID → gerçek telefon eşlemeleri: izin listesi telefon numarasıyla
       eşleştiği için bu olaylardan gelen eşlemeler de önbelleğe alınır */
    this.sock.ev.on('lid-mapping.update', (m) => this._cacheLidPn(m));
    this.sock.ev.on('contacts.upsert', (list) => this._cacheLidPnList(list));
    this.sock.ev.on('messaging-history.set', (d) => this._cacheLidPnList(d && d.contacts));
  }

  _handleMessages(m) {
    /* 'notify' = canlı akış; 'append' = kesinti sırasında kaçırılanlar (15 dk
       tazelik filtresiyle alınır — eski history işlenmez) */
    if (m.type !== 'notify' && m.type !== 'append') return;
    const nowMs = Date.now();
    for (const msg of m.messages || []) {
      const mid = msg.key && msg.key.id;
      if (mid) {
        if (this._seenIds.has(mid)) continue;
        this._seenIds.add(mid);
        if (this._seenIds.size > 600) {
          for (const k of [...this._seenIds].slice(0, 300)) this._seenIds.delete(k);
        }
      }
      if (m.type === 'append') {
        const ts = Number(msg.messageTimestamp) || 0;
        const tsMs = ts > 1e12 ? ts : ts * 1000;
        if (!tsMs || nowMs - tsMs > 15 * 60 * 1000) continue;
      }
      this._processIncoming(msg).catch(() => {});
    }
  }

  /* Tek mesajı işle: yalnız METİN (görsel/ses/belge yok sayılır). */
  async _processIncoming(msg) {
    try {
      const jid = msg.key && msg.key.remoteJid;
      if (!jid) return;
      if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
      const meBase = String(this._userIdRaw || '').split('@')[0].split(':')[0];
      const lidBase = String((this.sock && this.sock.user && this.sock.user.lid) || '').split('@')[0].split(':')[0];
      /* KENDİ KENDİNE SOHBET (Saved Messages): izin listesindeki numara kendi
         sohbetinden yazabilir; botun kendi cevapları _sentIds ile ayıklanır */
      const selfChat = !!(meBase && (jid === meBase + '@s.whatsapp.net' || (lidBase && jid === lidBase + '@lid')));
      if (msg.key.fromMe) {
        if (this._sentIds && this._sentIds.has(String(msg.key.id))) return;
        if (!selfChat) return;
      }
      const isGroup = jid.endsWith('@g.us');
      const participantJid = isGroup && msg.key.participant ? String(msg.key.participant) : '';
      const mm = msg.message || {};
      const text =
        mm.conversation ||
        (mm.extendedTextMessage && mm.extendedTextMessage.text) ||
        (mm.imageMessage && mm.imageMessage.caption) ||
        (mm.documentMessage && mm.documentMessage.caption) ||
        '';
      const t = String(text || '').trim();

      /* gruplarda bot @mention edilmiş mi (telefon + LID tabanı + metin yedeği) */
      let mentioned = false;
      if (isGroup) {
        const ci =
          (mm.extendedTextMessage && mm.extendedTextMessage.contextInfo) ||
          (mm.imageMessage && mm.imageMessage.contextInfo) ||
          (mm.videoMessage && mm.videoMessage.contextInfo) ||
          (mm.documentMessage && mm.documentMessage.contextInfo) ||
          null;
        const men = (ci && ci.mentionedJid) || [];
        const baseOf = (j) => String(j || '').split('?')[0].split(':')[0].split('@')[0];
        for (const m of men) {
          const base = baseOf(m);
          if (base && ((meBase && base === meBase) || (lidBase && base === lidBase))) {
            mentioned = true;
            break;
          }
        }
        if (!mentioned && ci && ci.participant) {
          const pBase = baseOf(ci.participant);
          if ((meBase && pBase === meBase) || (lidBase && pBase === lidBase)) mentioned = true;
        }
        if (!mentioned && meBase && t.includes('@' + meBase)) mentioned = true;
      }

      if (!t) return; // metinsiz mesaj (medya) yok sayılır

      /* Yeni WA LID sistemi: gerçek numara önce remoteJidAlt / participantAlt
         içinde gelir; WhatsApp göndermezse (LID çağı) Baileys'in LID eşleme
         deposundan çözülür — izin listesi telefon numarasıyla eşleşir. */
      const alt =
        msg.key.remoteJidAlt ||
        (msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.remoteJidAlt) ||
        msg.key.participantAlt ||
        '';
      let senderNum = this._pnOnly(alt);
      let pnLabel = this._pnOnly(msg.key.participantAlt);
      if (!senderNum) {
        const lidJid = String(jid).endsWith('@lid')
          ? jid
          : String(participantJid).endsWith('@lid') ? participantJid : '';
        if (lidJid) senderNum = await this._lidToPn(lidJid);
        if (!pnLabel && senderNum) pnLabel = senderNum;
      }
      if (!senderNum) {
        senderNum = (participantJid || jid).split('@')[0].split(':')[0];
        if (!/^\d+$/.test(senderNum)) senderNum = '';
      }
      if (selfChat && meBase) senderNum = meBase;

      this.onIncoming(jid, {
        text: t,
        isGroup,
        participant: participantJid,
        participantPn: isGroup ? pnLabel : '',
        participantUsername: isGroup ? String(msg.key.participantUsername || '') : '',
        mentioned,
      }, senderNum);
    } catch {}
  }

  /* Metin cevabı: başarı → { id }, başarısızlık → false */
  async send(jid, text) {
    if (!this.sock || !this.connected) return false;
    const txt = String(text).slice(0, 3500);
    let ret;
    try {
      ret = await this.sock.sendMessage(jid, { text: txt });
    } catch (e) {
      this.emit({ type: 'send-error', jid, preview: txt.slice(0, 40), error: String((e && e.message) || e) });
      return false;
    }
    const id = ret && ret.key && ret.key.id ? String(ret.key.id) : '';
    if (id) {
      if (!this._sentIds) this._sentIds = new Set();
      this._sentIds.add(id);
      if (this._sentIds.size > 400) {
        for (const k of [...this._sentIds].slice(0, 200)) this._sentIds.delete(k);
      }
    }
    return id ? { id } : true;
  }

  /* Karşı chatta durum bildirimi: on=true → "yazıyor…", on=false → durdu */
  async setComposing(jid, on) {
    if (!this.sock || !this.connected) return;
    try {
      await this.sock.sendPresenceUpdate(on ? 'composing' : 'paused', jid);
    } catch {}
  }

  async stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    const s = this.sock;
    this.sock = null;
    this.connected = false;
    this.user = null;
    this.qr = '';
    if (s) {
      /* end(): bağlantıyı kapatır ama EŞLEMEYİ BOZMAZ — "Kes" sonrası yeniden
         QR okutmak gerekmez; eşlemeyi silmek için resetAuth kullanılır */
      try { s.end(); } catch {}
    }
    this._emitStatus({ status: 'disconnected' });
  }

  async resetAuth() {
    await this.stop();
    try { fs.rmSync(this.authDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { WhatsAppBridge };
