'use strict';

/* ---------- opencode v2.1.4 permission Service portu ----------
   Kaynak: packages/core/src/permission.ts

   Beast Code'da izin katmanı KAPALI: kural değerlendirmesi yapılmaz,
   hiçbir araç için onay istenmez. API opencode şeklini korur:
     ask(input)    → { id, effect: 'allow' }
     assert(input) → hemen çözülür
     reply(...)    → bekleyen istek yok
   Güvenlik ayarı (Beast) canlı değiştirilebilir; bu katman yine de sormaz. */

const Permission = require('./permission');

let seq = 0;
function newId() {
  return 'per_' + Date.now().toString(36) + (++seq).toString(36);
}

class AskService {
  constructor(emitFn) {
    this.emit = typeof emitFn === 'function' ? emitFn : () => {};
    this.pending = new Map(); // izin katmanı kapalı — daima boş
    this.approved = [];
    this.autoAllow = true;
  }

  /* opencode Permission.ask */
  ask(input) {
    return Promise.resolve({ id: (input && input.id) || newId(), effect: 'allow' });
  }

  /* opencode Permission.assert — deny/ask yok, her çağrı serbest */
  assert() {
    return Promise.resolve();
  }

  /* opencode Permission.reply — bekleyen istek olmadığı için no-op */
  reply(requestId) {
    return { ok: false, error: 'izin katmanı kapalı — bekleyen istek yok: ' + String(requestId || '') };
  }

  get(id) {
    return this.pending.get(String(id || '')) || undefined;
  }

  forSession() {
    return [];
  }

  list() {
    return [];
  }

  close() {
    this.pending.clear();
  }

  /* opencode hata metinleri (izin katmanı kapalıyken yalnız savunma amaçlı) */
  static errorText(err) {
    if (!err) return 'Permission denied';
    if (err.kind === 'blocked') return err.reason || Permission.MESSAGES.blocked(err.action || err.permission || '');
    if (err.kind === 'corrected') return Permission.MESSAGES.corrected(err.feedback);
    return Permission.MESSAGES.declined;
  }
}

module.exports = { AskService };
