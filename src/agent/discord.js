'use strict';

/* DISCORD KÖPRÜSÜ — Telegram köprüsünün Discord hali.
   Bağımlılık: yalnızca `ws` (paket zaten kurulu — baileys ile geliyor).
   - Gateway WebSocket: Identify → READY → MESSAGE_CREATE dispatch
   - REST (api/v10): mesaj gönderme (2000 karakter sınırında bölerek)
   - Sunucu (guild) mesajlarında yalnız @mention'a cevap verilir (spam koruması);
     DM'de her izinli kullanıcıya cevap verilir.
   - Bağlantı koparsa backoff ile yeniden bağlanır (yeniden Identify;
     çevrimdışıyken gelen mesajlar backfill edilmez — Telegram long-poll'un aksine).
   ÖNEMLİ: Discord Developer Portal'da bot için "MESSAGE CONTENT INTENT"
   açılmalıdır — yoksa mesaj içerikleri boş gelir. */

const WebSocket = require('ws');
const https = require('https');

const API_BASE = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const SEND_CHUNK = 1900; // Discord mesaj sınırı 2000 — güvenli pay
/* GUILDS(1) | GUILD_MESSAGES(512) | DIRECT_MESSAGES(4096) | MESSAGE_CONTENT(32768) */
const INTENTS = 1 | 512 | 4096 | 32768;

class DiscordBridge {
  constructor({ token, emit, onIncoming }) {
    this.token = String(token || '').trim();
    this.emit = emit || (() => {});
    this.onIncoming = onIncoming || null;
    this.connected = false;
    this.stopping = false;
    this.status = 'disconnected';
    this.user = null; // { id, username, ... }
    this._ws = null;
    this._hbTimer = null;
    this._seq = null;
    this._backoff = 2000;
  }

  _setStatus(status, user) {
    this.status = status;
    this.connected = status === 'connected';
    this.emit({ type: 'status', status, user: user || null });
  }

  /* REST çağrısı — JSON (token: "Bot <token>") */
  api(method, path, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = https.request(
        `${API_BASE}${path}`,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bot ' + this.token,
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
          timeout: 15000,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const j = data ? JSON.parse(data) : null;
              if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
              else reject(new Error(`discord ${path}: HTTP ${res.statusCode} ${(j && j.message) || ''}`.trim()));
            } catch {
              reject(new Error(`discord ${path}: bozuk yanıt`));
            }
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error('zaman aşımı')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async start() {
    if (!this.token) {
      this._setStatus('error');
      return false;
    }
    this.stopping = false;
    this._setStatus('connecting');
    try {
      const me = await this.api('GET', '/users/@me');
      this.user = me; // { id, username, ... }
      this._setStatus('connected', '@' + (me.username || 'bot'));
    } catch (e) {
      this._setStatus('error');
      throw e;
    }
    this._connect();
    return true;
  }

  _connect() {
    if (this.stopping) return;
    clearInterval(this._hbTimer);
    this._hbTimer = null;
    let identified = false;
    const ws = new WebSocket(GATEWAY_URL);
    this._ws = ws;

    ws.on('message', (raw) => {
      let p = null;
      try { p = JSON.parse(String(raw)); } catch { return; }
      const op = p.op;
      const d = p.d;
      const t = p.t;
      if (typeof p.s === 'number') this._seq = p.s;

      if (op === 10) {
        /* Hello: heartbeat aralığı gelıyor → hafif erken at (güvenli pay) */
        const iv = (d && d.heartbeat_interval) || 41250;
        clearInterval(this._hbTimer);
        this._hbTimer = setInterval(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: this._seq }));
          } catch {}
        }, Math.max(5000, Math.floor(iv * 0.8)));
        if (!identified) {
          identified = true;
          try {
            ws.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: this.token,
                  intents: INTENTS,
                  properties: { os: 'windows', browser: 'beast-agent', device: 'beast-agent' },
                },
              })
            );
          } catch {}
        }
        return;
      }
      if (op === 1) {
        /* sunucu heartbeat istedi — hemen at */
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: this._seq }));
        } catch {}
        return;
      }
      if (op === 9 || op === 7) {
        /* invalid session / reconnect isteği — kapat, close handler yeniden bağlanır */
        try { ws.close(); } catch {}
        return;
      }
      if (op === 0 && t === 'READY') {
        this._backoff = 2000;
        this._setStatus('connected', '@' + ((d && d.user && d.user.username) || 'bot'));
        return;
      }
      if (op === 0 && t === 'MESSAGE_CREATE' && this.onIncoming) {
        try {
          const m = d || {};
          if (!m.author || m.author.bot || m.webhook_id) return;
          let text = String(m.content || '').trim();
          if (!text) return;
          const botId = this.user && this.user.id;
          const mentioned = !!(botId && text.includes('<@' + botId + '>'));
          if (botId) text = text.split('<@' + botId + '>').join(' ').replace(/\s+/g, ' ').trim();
          const payload = {
            text: text.slice(0, 6000),
            senderId: String((m.author && m.author.id) || ''),
            username: String((m.author && m.author.username) || ''),
            senderName: String((m.author && (m.author.global_name || m.author.username)) || ''),
            isGroup: !!m.guild_id,
            mentioned,
            channelId: String(m.channel_id || ''),
          };
          if (!payload.channelId) return;
          /* Sunucu mesajlarında yalnız @mention (spam koruması); DM'de hepsi */
          if (payload.isGroup && !mentioned) return;
          this.onIncoming(payload.channelId, payload);
        } catch {}
        return;
      }
    });

    ws.on('close', () => {
      clearInterval(this._hbTimer);
      this._hbTimer = null;
      if (this.stopping) return;
      this._setStatus('connecting');
      const wait = this._backoff;
      this._backoff = Math.min(30000, this._backoff * 2);
      setTimeout(() => this._connect(), wait);
    });

    ws.on('error', () => {
      /* close tetiklenir — yeniden bağlanma orada */
    });
  }

  async stop() {
    this.stopping = true;
    clearInterval(this._hbTimer);
    this._hbTimer = null;
    try {
      if (this._ws) this._ws.close();
    } catch {}
    this._ws = null;
    this.connected = false;
    this.status = 'disconnected';
  }

  snapshot() {
    return {
      status: this.status,
      user: this.user ? '@' + (this.user.username || 'bot') : null,
      connected: this.connected,
    };
  }

  /* Metin gönder — 2000 karakter sınırı için parçalara böl */
  async send(channelId, text) {
    const t = String(text || '');
    if (!t.trim() || !channelId) return false;
    const chunks = [];
    for (let i = 0; i < t.length; i += SEND_CHUNK) chunks.push(t.slice(i, i + SEND_CHUNK));
    for (const part of chunks) {
      await this.api('POST', `/channels/${channelId}/messages`, { content: part });
    }
    return true;
  }
}

module.exports = { DiscordBridge };
