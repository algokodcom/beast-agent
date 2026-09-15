'use strict';

/* TELEGRAM KÖPRÜSÜ (FEATURE 3)
   WhatsApp köprüsünün Telegram hali — bağımlılık yok (saf Node https):
   - Bot API long polling (getUpdates) ile gelen mesajlar onIncoming'e düşer
   - send(chatId, text) cevap döner; 4096 karakter sınırında bölerek gönderir
   - Aynı allow list mantığı: main tarafındaki tgFind() listesindeki kişilere cevap verir */

const https = require('https');
const crypto = require('crypto');

const API_BASE = 'https://api.telegram.org/bot';
const SEND_CHUNK = 3800; // Telegram mesaj sınırı 4096 — güvenli pay

class TelegramBridge {
  constructor({ token, emit, onIncoming }) {
    this.token = String(token || '').trim();
    this.emit = emit || (() => {});
    this.onIncoming = onIncoming || null;
    this.connected = false;
    this.stopping = false;
    this.status = 'disconnected';
    this.offset = 0;
    this.me = null;
    this._req = null; // aktif long-poll isteği (iptal için)
  }

  _setStatus(status, user) {
    this.status = status;
    this.connected = status === 'connected';
    this.emit({ type: 'status', status, user: user || null });
  }

  /* Ham POST — JSON ve multipart (görsel) aynı iskeleti kullanır */
  _post(method, payload, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        `${API_BASE}${this.token}/${method}`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
          timeout: timeoutMs || 15000,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try {
              const j = JSON.parse(data || '{}');
              if (j.ok) resolve(j.result);
              else reject(new Error(`telegram ${method}: ${j.description || 'hata ' + res.statusCode}`));
            } catch (e) {
              reject(new Error(`telegram ${method}: bozuk yanıt`));
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('zaman aşımı')));
      req.on('error', reject);
      this._req = req;
      req.write(payload);
      req.end();
    });
  }

  /* Bot API çağrısı — JSON POST, promise sarmalı */
  api(method, body = {}, opts = {}) {
    return this._post(
      method,
      JSON.stringify(body),
      { 'Content-Type': 'application/json' },
      opts.timeout || 15000
    );
  }

  async start() {
    if (!this.token) {
      this._setStatus('error');
      return false;
    }
    this.stopping = false;
    this.offset = 0;
    this._setStatus('connecting');
    try {
      const me = await this.api('getMe', {});
      this.me = me;
      this._setStatus('connected', '@' + (me.username || me.first_name || 'bot'));
    } catch (e) {
      this._setStatus('error');
      throw e;
    }
    this._pollLoop().catch(() => {});
    return true;
  }

  /* long polling döngüsü — bağlantı koparsa 3 sn bekleyip devam */
  async _pollLoop() {
    while (!this.stopping) {
      try {
        const updates = await this.api(
          'getUpdates',
          { timeout: 25, offset: this.offset, allowed_updates: ['message'] },
          { timeout: 35000 }
        );
        if (this.stopping) break;
        for (const u of Array.isArray(updates) ? updates : []) {
          this.offset = Math.max(this.offset, (u.update_id || 0) + 1);
          const msg = u.message;
          if (!msg || !msg.text || !msg.from || msg.from.is_bot) continue;
          const chatId = msg.chat && msg.chat.id;
          if (chatId === undefined || chatId === null) continue;
          const payload = {
            text: String(msg.text).slice(0, 6000),
            senderId: String(msg.from.id || ''),
            username: String(msg.from.username || ''),
            senderName: String(msg.from.first_name || msg.from.username || ''),
            isGroup: !!(msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup')),
            chatTitle: String((msg.chat && (msg.chat.title || msg.chat.username)) || ''),
            chatType: String((msg.chat && msg.chat.type) || 'private'),
            isForum: !!(msg.chat && msg.chat.is_forum),
            messageThreadId: msg.message_thread_id || null,
          };
          try {
            if (this.onIncoming) this.onIncoming(String(chatId), payload);
          } catch {}
        }
      } catch (e) {
        if (this.stopping) break;
        this.emit({ type: 'poll-error', error: String((e && e.message) || e) });
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async stop() {
    this.stopping = true;
    try { if (this._req) this._req.destroy(new Error('stop')); } catch {}
    this._req = null;
    this.connected = false;
    this.status = 'disconnected';
  }

  snapshot() {
    return {
      status: this.status,
      user: this.me ? '@' + (this.me.username || this.me.first_name || 'bot') : null,
      connected: this.connected,
    };
  }

  /* Metin gönder — 4096 sınırı için parçalara böl; threadId verilirse forum
     konusuna (topic) gönderir (message_thread_id). */
  async send(chatId, text, threadId) {
    const t = String(text || '');
    if (!t.trim()) return false;
    const chunks = [];
    for (let i = 0; i < t.length; i += SEND_CHUNK) chunks.push(t.slice(i, i + SEND_CHUNK));
    for (const part of chunks) {
      await this.api('sendMessage', {
        chat_id: chatId,
        text: part,
        disable_web_page_preview: true,
        ...(threadId ? { message_thread_id: Number(threadId) } : {}),
      });
    }
    return true;
  }

  /* GÖRSEL gönder — data URL (base64) multipart ile yüklenir. PNG/JPG/WEBP
     sendPhoto, GIF sendDocument; caption 1024, dosya 9.5MB üstü atlanır.
     threadId verilirse forum konusuna gider. */
  async sendPhoto(chatId, dataUrl, caption, threadId) {
    try {
      const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || '').trim());
      if (!m) return false;
      const isJpg = /^jpe?g$/i.test(m[1]);
      const ext = isJpg ? 'jpg' : m[1].toLowerCase();
      const mime = isJpg ? 'image/jpeg' : 'image/' + ext;
      const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
      if (!buf.length || buf.length > 9.5 * 1024 * 1024) return false;
      const gif = ext === 'gif';
      const method = gif ? 'sendDocument' : 'sendPhoto';
      const field = gif ? 'document' : 'photo';
      const boundary = '----Beast' + crypto.randomBytes(10).toString('hex');
      const parts = [];
      const addField = (name, value) => {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`));
      };
      addField('chat_id', String(chatId));
      if (caption) addField('caption', String(caption).slice(0, 1024));
      if (threadId) addField('message_thread_id', String(Number(threadId)));
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="beast.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`
        )
      );
      parts.push(buf);
      parts.push(Buffer.from('\r\n'));
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      await this._post(method, Buffer.concat(parts), { 'Content-Type': 'multipart/form-data; boundary=' + boundary }, 60000);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { TelegramBridge };
