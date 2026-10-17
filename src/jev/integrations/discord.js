'use strict';

/* Discord köprüsü (Beast Agent mantığı) — bağımlılık: yalnızca `ws`.
   - Gateway WebSocket: Identify → READY → MESSAGE_CREATE dispatch
   - REST (api/v10): mesaj gönderme (2000 karakter sınırında bölerek)
   - Sunucu (guild) mesajlarında yalnız @mention'a cevap verilir (spam koruması);
     DM'de her izinli kullanıcıya cevap verilir.
   - Bağlantı koparsa backoff ile yeniden bağlanır.
   ÖNEMLİ: Discord Developer Portal'da bot için "MESSAGE CONTENT INTENT"
   açılmalıdır — yoksa mesaj içerikleri boş gelir. */

const WebSocket = require('ws');
const https = require('https');

const API_BASE = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const SEND_CHUNK = 1900; // Discord mesaj sınırı 2000 — güvenli pay
/* GUILDS(1) | GUILD_MESSAGES(512) | DIRECT_MESSAGES(4096) | MESSAGE_CONTENT(32768) */
const INTENTS = 1 | 512 | 4096 | 32768;

/* AĞ ARA YAZILIMI (antivirüs SSL taraması / proxy) Discord trafiğine self-signed
   sertifika sunarsa Node bağlantıyı reddeder. Çözüm: REST önce Chromium ağ
   yığınından (sistem CA + proxy), olmazsa Node https + esnek TLS. */
let tlsRelaxed = false;
const CERT_ERR_RE = /self[ -]?signed|unable to verify the first certificate|depth zero|err_tls|certificate has expired|cert_has_expired|unable_to_get_issuer|self signed certificate/i;

function isCertError(e) {
  return CERT_ERR_RE.test(String((e && (e.message || e.code)) || e || ''));
}

let _electronNet = null;
try {
  const el = require('electron');
  if (el && el.net && typeof el.net.fetch === 'function') _electronNet = el.net;
} catch {}

function bodySnippet(data) {
  const s = String(data || '').replace(/\s+/g, ' ').trim();
  return s ? ` — gövde: ${s.slice(0, 140)}` : '';
}

const VPN_HINT = 'Discord bu ağdan ERİŞİME ENGELLİ görünüyor — VPN açıp tekrar dene (engel sayfası döndü)';

function looksBlocked(ctype, data) {
  const ct = String(ctype || '');
  const body = String(data || '').slice(0, 4000);
  return ct.includes('text/html') || /erisime[_ ]?engelle|erişime engelle|blocked|block_page/i.test(body);
}

class DiscordBridge {
  constructor({ token, emit, onIncoming }) {
    this.token = String(token || '').trim();
    this.emit = emit || (() => {});
    this.onIncoming = onIncoming || null;
    this.connected = false;
    this.stopping = false;
    this.status = 'disconnected';
    this.user = null;
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

  api(method, path, body, attempt = 0) {
    return this._api(method, path, body).catch((e) => {
      if (isCertError(e) && !tlsRelaxed) {
        tlsRelaxed = true;
        this.emit({
          type: 'warn',
          text: 'ağ ara yazılımı (antivirüs/proxy) self-signed sertifikası tespit edildi — Discord bağlantısı esnek TLS ile devam ediyor',
        });
        if (attempt < 1) return this.api(method, path, body, attempt + 1);
      }
      throw e;
    });
  }

  async _api(method, path, body) {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bot ' + this.token };
    const url = API_BASE + path;

    /* YOL 1 — Chromium ağ yığını (varsa): sistem sertifikaları + sistem proxy */
    if (_electronNet) {
      try {
        const res = await _electronNet.fetch(url, {
          method,
          headers,
          ...(payload ? { body: payload } : {}),
        });
        const data = await res.text();
        let j = null;
        try { j = data ? JSON.parse(data) : null; } catch {}
        if (res.ok && j !== null) return j;
        if (j === null && looksBlocked(res.headers.get('content-type'), data)) {
          throw new Error(VPN_HINT + bodySnippet(data));
        }
        throw new Error(
          `discord ${path}: HTTP ${res.status}${j && j.message ? ' ' + j.message : ''}${bodySnippet(data)}`
        );
      } catch (e) {
        if (/^discord |Discord bu ağ/.test(String((e && e.message) || ''))) throw e;
      }
    }

    /* YOL 2 — Node https (+ gerektiğinde esnek TLS) */
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method,
          headers: {
            ...headers,
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
          timeout: 15000,
          rejectUnauthorized: !tlsRelaxed,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            const ctype = String(res.headers['content-type'] || '');
            let j = null;
            try { j = data ? JSON.parse(data) : null; } catch {}
            if (res.statusCode >= 200 && res.statusCode < 300 && j !== null) return resolve(j);
            if (looksBlocked(ctype, data)) {
              return reject(new Error(VPN_HINT + bodySnippet(data)));
            }
            if (res.statusCode >= 200 && res.statusCode < 300) {
              return reject(new Error(`discord ${path}: bozuk yanıt (HTTP ${res.statusCode}${ctype ? ', ' + ctype : ''})${bodySnippet(data)}`));
            }
            reject(new Error(`discord ${path}: HTTP ${res.statusCode} ${(j && j.message) || ''}`.trim() + bodySnippet(data)));
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
      this.user = me;
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
    const ws = new WebSocket(GATEWAY_URL, { rejectUnauthorized: !tlsRelaxed });
    this._ws = ws;

    ws.on('message', (raw) => {
      let p = null;
      try { p = JSON.parse(String(raw)); } catch { return; }
      const op = p.op;
      const d = p.d;
      const t = p.t;
      if (typeof p.s === 'number') this._seq = p.s;

      if (op === 10) {
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
                  properties: { os: 'windows', browser: 'jevtrader', device: 'jevtrader' },
                },
              })
            );
          } catch {}
        }
        return;
      }
      if (op === 1) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: this._seq }));
        } catch {}
        return;
      }
      if (op === 9 || op === 7) {
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
            chatTitle: '',
          };
          if (!payload.channelId) return;
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

    ws.on('error', (e) => {
      if (isCertError(e) && !tlsRelaxed) {
        tlsRelaxed = true;
        this.emit({
          type: 'warn',
          text: 'ağ ara yazılımı (antivirüs/proxy) self-signed sertifikası tespit edildi — Discord bağlantısı esnek TLS ile devam ediyor',
        });
      }
    });
  }

  async stop() {
    this.stopping = true;
    clearInterval(this._hbTimer);
    this._hbTimer = null;
    try { if (this._ws) this._ws.close(); } catch {}
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
