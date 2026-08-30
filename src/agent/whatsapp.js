'use strict';

/* WhatsApp bridge — Baileys tabanlı. QR ile eşleme, auth %APPDATA%\beast\wa-auth,
   gelen özel mesajlar onIncoming(jid, text)'e düşer, send(jid,text) cevap döner. */

const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

let baileys = null;
try {
  baileys = require('@whiskeysockets/baileys');
} catch (e) {
  baileys = null;
}

/* WAMessageStatus: 0=ERROR 1=PENDING 2=SERVER_ACK(gönderildi)
   3=DELIVERY_ACK(teslim) 4=READ(okundu) 5=PLAYED(ses çalındı) */
const STATUS_LABELS = {
  0: 'hata',
  1: 'bekliyor',
  2: 'gönderildi ✓',
  3: 'teslim ✓✓',
  4: 'okundu ✓✓',
  5: 'çalındı ✓✓',
};

function statusLabel(status) {
  return STATUS_LABELS[status] || `bilinmeyen(${status})`;
}

/* Baileys kendi debug çıktılarını bastırmak için main enjekte etmezse no-op */
function waLogSafe(line) {
  try { console.log(`[WA] ${line}`); } catch {}
}

const TRACK_CAP = 500;

/* lastKnownPresence etiketleri */
const PRESENCE_LABELS = {
  available: 'çevrimiçi',
  composing: 'yazıyor',
  recording: 'ses kaydediyor',
  paused: '',
  unavailable: 'çevrimdışı',
};

class WhatsAppBridge {
  constructor({ authDir, emit, onIncoming, onReaction }) {
    this.authDir = authDir;
    this.emit = emit || (() => {});
    this.onIncoming = onIncoming || null;
    this.onReaction = onReaction || null;
    this.sock = null;
    this.connected = false;
    this.user = null;
    this.stopping = false;
    this.reconnectTimer = null;
    this._tracked = new Map(); // msgId -> { jid, preview, ts, status, receiptDetail }
    this._watchJids = new Set(); // presence aboneliği tutulacak sohbetler
    this._seenIds = new Set(); // işlenen mesaj id'leri — offline replay + notify çift işlemeyi önler
  }

  /* main tarafı waChats anahtarlarını bildirir; bağlantı varsa anında abone olunur */
  setWatchJids(jids) {
    this._watchJids = new Set(jids || []);
    if (this.sock && this.connected) {
      this._subscribePresence().catch(() => {});
    }
  }

  async _subscribePresence() {
    if (!this.sock || typeof this.sock.presenceSubscribe !== 'function') return;
    for (const jid of this._watchJids) {
      try {
        await this.sock.presenceSubscribe(jid);
      } catch {}
    }
  }

  /* Baileys medya akışını buffer'a dök */
  async _mediaBuffer(desc, type) {
    if (!baileys || typeof baileys.downloadContentFromMessage !== 'function') {
      throw new Error('medya indirme desteklenmiyor');
    }
    const stream = await baileys.downloadContentFromMessage(desc, type);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  get available() {
    return !!baileys;
  }

  snapshot() {
    return {
      status: this.connected ? 'connected' : this.sock ? 'connecting' : 'disconnected',
      user: this.user,
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
      browser: ['Beast Agent', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      /* false OLMALI: bot "çevrimiçi" işaretlenirse WhatsApp sunucusu kesintide
         gelen mesajları bu cihaz için kuyruklamayı aksatıyor. false ile kesintideki
         mesajlar sunucuda bekler, bağlantı dönünce 'append' upsert'iyle iletilir. */
      markOnlineOnConnect: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (u) => {
      try {
        if (u.qr) {
          const dataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 240 });
          this.connected = false;
          this._emitStatus({ status: 'qr', qr: dataUrl });
        }
        if (u.connection === 'open') {
          this.connected = true;
          const su = this.sock.user || {};
          this.user = [su.name || su.verifiedName || '', su.id ? String(su.id).split(':')[0] : '']
            .filter(Boolean)
            .join(' · ');
          /* mention/reply kontrolü için ham id (örn 1234:56@s.whatsapp.net) */
          this._userIdRaw = String(su.id || '');
          this._emitStatus({ status: 'connected', user: this.user });
          this.sock.sendPresenceUpdate('available').catch(() => {});
          this._subscribePresence().catch(() => {});
        }
        if (u.connection === 'close') {
          const code = u.lastDisconnect && u.lastDisconnect.error &&
            u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
          const loggedOut = code === DisconnectReason.loggedOut;
          this.sock = null;
          if (this.stopping) {
            this.connected = false;
            this._emitStatus({ status: 'disconnected' });
            return;
          }
          if (loggedOut) {
            try {
              fs.rmSync(this.authDir, { recursive: true, force: true });
            } catch {}
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

    /* Teslim/okundu takibi — sadece kendi gönderdiklerimiz izlenir */
    this.sock.ev.on('messages.update', (ups) => this._handleStatusUpdates(ups));
    this.sock.ev.on('message-receipt.update', (rs) => this._handleReceipts(rs));

    /* Karşı tarafın çevrimiçi/yazıyor durumu — izlenen sohbetler için */
    this.sock.ev.on('presence.update', (u) => this._handlePresence(u));
  }

  _handlePresence(u) {
    try {
      if (!u || !u.id) return;
      const presences = u.presences || {};
      for (const [pid, p] of Object.entries(presences)) {
        const st = p && p.lastKnownPresence;
        if (!st || !(st in PRESENCE_LABELS)) continue;
        this.emit({
          type: 'presence',
          jid: u.id,
          participant: pid,
          presence: st,
          label: PRESENCE_LABELS[st],
        });
      }
    } catch {}
  }

  _trackOutgoing(jid, preview, ret) {
    try {
      const id = ret && ret.key && ret.key.id;
      if (!id) return;
      if (this._tracked.size >= TRACK_CAP) {
        const first = this._tracked.keys().next().value;
        this._tracked.delete(first);
      }
      this._tracked.set(id, { jid: String(jid || ''), preview: String(preview || '').slice(0, 40), ts: Date.now(), status: 1, receiptDetail: '' });
      this.emit({ type: 'send', id, jid, preview: this._tracked.get(id).preview });
    } catch {}
  }

  _handleStatusUpdates(ups) {
    for (const up of ups || []) {
      try {
        /* bazı Baileys sürümleri tepkiyi update içinde taşır */
        const rmUp = (up && up.update && (up.update.reactionMessage ||
          (up.update.message && up.update.message.reactionMessage))) || null;
        if (rmUp) {
          this._handleReaction({ key: up.key }, rmUp);
          continue;
        }
        const st = up && up.update && up.update.status;
        const id = up && up.key && up.key.id;
        if (typeof st !== 'number' || !id) continue;
        const t = this._tracked.get(id);
        if (!t || st === t.status) continue; // yalnızca bizim mesajlarımız + değişim varsa
        t.status = st;
        this.emit({ type: 'tick', id, jid: t.jid, status: st, label: statusLabel(st), preview: t.preview });
      } catch {}
    }
  }

  _handleReceipts(rs) {
    for (const r of rs || []) {
      try {
        const rc = r && r.receipt;
        const id = r && r.key && r.key.id;
        const t = id && this._tracked.get(id);
        if (!t || !rc) continue;
        const bits = [];
        if (rc.deliveryTimestamp) bits.push(`teslim=${new Date(rc.deliveryTimestamp * 1000).toISOString()}`);
        else if (rc.deliveredAt) bits.push(`teslim=${new Date(rc.deliveredAt).toISOString()}`);
        if (rc.readTimestamp) bits.push(`okundu=${new Date(rc.readTimestamp * 1000).toISOString()}`);
        else if (rc.readAt) bits.push(`okundu=${new Date(rc.readAt).toISOString()}`);
        if (rc.playedTimestamp) bits.push(`çalındı=${new Date(rc.playedTimestamp * 1000).toISOString()}`);
        else if (rc.playedAt) bits.push(`çalındı=${new Date(rc.playedAt).toISOString()}`);
        const detail = bits.join(' ');
        if (!detail || detail === t.receiptDetail) continue;
        t.receiptDetail = detail;
        this.emit({ type: 'receipt', id, jid: t.jid, preview: t.preview, detail });
      } catch {}
    }
  }

  _handleMessages(m) {
    /* 'notify'  = canlı mesaj akışı
       'append' = bağlantı kesintisinde KAÇIRILMIŞ mesajlar — bağlantı dönünce
                  sunucu bunları oynatır; FALLOUT sorunu tam olarak burasıydı:
                  yalnızca 'notify' işlendiği için kesintideki mesajlar sessizce
                  düşüyor ve cevapsız kalıyordu. 'append' içindeki eski history
                  kayıtlarını elemek için son 15 dk tazelik filtresi kullanılır. */
    if (m.type !== 'notify' && m.type !== 'append') return;
    const nowMs = Date.now();
    for (const msg of m.messages || []) {
      /* aynı mesaj hem 'append' hem 'notify' ile gelebilir — ID dedup */
      const mid = msg.key && msg.key.id;
      if (mid) {
        if (this._seenIds.has(mid)) continue;
        this._seenIds.add(mid);
        if (this._seenIds.size > 600) {
          for (const k of [...this._seenIds].slice(0, 300)) this._seenIds.delete(k);
        }
      }
      /* tepkiler ayrı kanal: onay kapısı bunları dinler */
      const rm = msg.message && msg.message.reactionMessage;
      if (rm) {
        this._handleReaction(msg, rm);
        continue;
      }
      if (m.type === 'append') {
        const ts = Number(msg.messageTimestamp) || 0;
        const tsMs = ts > 1e12 ? ts : ts * 1000; // saniye/ms normalizasyonu
        if (!tsMs || nowMs - tsMs > 15 * 60 * 1000) continue; // eski history — işleme
        try {
          waLogSafe(`offline/append mesaj işleniyor (kesintiden kalan, ${new Date(tsMs).toISOString()})`);
        } catch {}
      }
      this._processIncoming(msg).catch(() => {});
    }
  }

  _handleReaction(msg, rm) {
    try {
      if (!rm || !rm.key || !rm.key.id) return;
      if (!this.onReaction) {
        this.emit({ type: 'reaction-unhandled', targetId: String(rm.key.id), reason: 'onReaction kanca yok' });
        return;
      }
      /* Baileys bazı sürümlerde tepkiyi kendi mesajı gibi işaretleyebiliyor;
         bizim onay kartımıza gelen tepkilerden kendi attıklarımız zaten yoktur */
      const jid = String(rm.key.remoteJid || msg.key.remoteJid || '');
      if (!jid) return;
      let senderNum = '';
      const raw = msg.key.participant || msg.key.remoteJidAlt || jid;
      const num = String(raw).split('@')[0].split(':')[0];
      if (/^\d+$/.test(num)) senderNum = num;
      const emoji = String(rm.text || '');
      waLogSafe(`reaction event ← target=${String(rm.key.id)} emoji=${JSON.stringify(emoji)} chat=${jid} sender=+${senderNum}`);
      this.emit({
        type: 'reaction',
        jid,
        targetId: String(rm.key.id),
        emoji,
        sender: senderNum,
      });
      this.onReaction(jid, String(rm.key.id), emoji, senderNum);
    } catch {}
  }

  /* Tek mesajı işle: metin + medya (resim/ses/belge) çıkarımı.
     Grup sohbetleri (@g.us) de kabul edilir; payload.isGroup ile işaretlenir,
     bot @mention edilmişse payload.mentioned=true gelir. */
  async _processIncoming(msg) {
    try {
      const jid = msg.key && msg.key.remoteJid;
      if (!jid || msg.key.fromMe) return;
      if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
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

      // gruplarda bot'un kendisi @mention edilmiş mi
      let mentioned = false;
      if (isGroup) {
        const ci = mm.extendedTextMessage && mm.extendedTextMessage.contextInfo;
        const men = (ci && ci.mentionedJid) || [];
        const meBase = String(this._userIdRaw || '').split('@')[0].split(':')[0];
        for (const m of men) {
          if (meBase && String(m).split('?')[0].split(':')[0].includes(meBase)) {
            mentioned = true;
            break;
          }
        }
        if (!mentioned && ci && ci.participant && meBase && String(ci.participant).includes(meBase)) {
          mentioned = true; // mesajımıza reply verilmiş
        }
      }

      // medya çıkarımı (varsa)
      let media = null;
      const MAX_MEDIA = 20 * 1024 * 1024;
      try {
        if (mm.imageMessage) {
          const buf = await this._mediaBuffer(mm.imageMessage, 'image');
          if (buf && buf.length && buf.length <= MAX_MEDIA) {
            media = { kind: 'image', buf, mimetype: mm.imageMessage.mimetype || 'image/jpeg', name: 'gorsel.jpg' };
          }
        } else if (mm.audioMessage) {
          const buf = await this._mediaBuffer(mm.audioMessage, 'audio');
          if (buf && buf.length && buf.length <= MAX_MEDIA) {
            media = { kind: 'audio', buf, mimetype: mm.audioMessage.mimetype || 'audio/ogg; codecs=opus' };
          }
        } else if (mm.documentMessage) {
          const buf = await this._mediaBuffer(mm.documentMessage, 'document');
          if (buf && buf.length && buf.length <= MAX_MEDIA) {
            media = { kind: 'document', buf, mimetype: mm.documentMessage.mimetype || 'application/octet-stream', name: mm.documentMessage.fileName || 'dosya' };
          }
        }
      } catch {}

      if (!t && !media) return;
      // Yeni WA LID sistemi: gerçek numara remoteJidAlt'ta geliyor
      const alt =
        msg.key.remoteJidAlt ||
        (msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.remoteJidAlt) ||
        '';
      let senderNum = '';
      const pnSrc = String(alt || '').startsWith('alt:') ? String(alt).slice(4) : String(alt || '');
      if (/^\d+@s\.whatsapp\.net$/.test(pnSrc)) {
        senderNum = pnSrc.split('@')[0];
      } else if (/^\d+@(s\.whatsapp\.net)?$/.test(jid)) {
        senderNum = jid.split('@')[0].split(':')[0];
      }
      if (!senderNum) {
        senderNum = (participantJid || jid).split('@')[0].split(':')[0];
        if (!/^\d+$/.test(senderNum)) senderNum = '';
      }
      this.onIncoming(jid, {
        text: t,
        media,
        isGroup,
        participant: participantJid,
        mentioned,
      }, senderNum);
    } catch {}
  }

  /* Cevap: başarı → { id }, başarısızlık → false (hata emit edilir, yutulmaz) */
  async send(jid, text) {
    if (!this.sock || !this.connected) return false;
    const txt = String(text).slice(0, 3500);
    let ret;
    try {
      ret = await this.sock.sendMessage(jid, { text: txt });
    } catch (e) {
      this.emit({
        type: 'send-error',
        jid,
        preview: txt.slice(0, 40),
        error: String((e && e.message) || e),
      });
      return false;
    }
    this._trackOutgoing(jid, txt, ret);
    const id = ret && ret.key && ret.key.id ? String(ret.key.id) : '';
    return id ? { id } : true;
  }

  /* Sesli not olarak yanıtla (TTS çıktısı mp3 buffer) */
  async sendAudio(jid, audioBuf) {
    if (!this.sock || !this.connected || !audioBuf) return false;
    try {
      const ret = await this.sock.sendMessage(jid, { audio: audioBuf, ptt: true, mimetype: 'audio/mpeg' });
      this._trackOutgoing(jid, '[sesli yanıt]', ret);
      return true;
    } catch (e) {
      this.emit({ type: 'send-error', jid, preview: '[ses]', error: String((e && e.message) || e) });
      return false;
    }
  }

  /* Görsel gönder (jpeg/png buffer) — /screenshot vb. için */
  async sendImage(jid, imgBuf, caption) {
    if (!this.sock || !this.connected || !imgBuf) return false;
    try {
      const ret = await this.sock.sendMessage(jid, {
        image: imgBuf,
        caption: String(caption || '').slice(0, 800),
      });
      this._trackOutgoing(jid, '[görsel]', ret);
      return true;
    } catch (e) {
      this.emit({ type: 'send-error', jid, preview: '[görsel]', error: String((e && e.message) || e) });
      return false;
    }
  }

  /* Belge gönder (pdf/doc/xxx buffer) — ajanın send_file aracı için */
  async sendFile(jid, buf, fileName, caption, mimetype) {
    if (!this.sock || !this.connected || !buf) return false;
    try {
      const ret = await this.sock.sendMessage(jid, {
        document: buf,
        fileName: String(fileName || 'dosya'),
        mimetype: mimetype || 'application/octet-stream',
        caption: String(caption || '').slice(0, 800),
      });
      this._trackOutgoing(jid, '[dosya] ' + fileName, ret);
      return true;
    } catch (e) {
      this.emit({ type: 'send-error', jid, preview: '[dosya]', error: String((e && e.message) || e) });
      return false;
    }
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
    if (s) {
      try {
        await s.logout();
      } catch {
        try {
          s.end();
        } catch {}
      }
    }
    this._emitStatus({ status: 'disconnected' });
  }

  async resetAuth() {
    await this.stop();
    try {
      fs.rmSync(this.authDir, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = { WhatsAppBridge, statusLabel };
