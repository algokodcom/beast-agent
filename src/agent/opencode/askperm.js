'use strict';

/* ---------- opencode permission Service portu (index.ts:67-167) ----------
   Ask akışı: her pattern için kural değerlendirilir (ruleset + approved) →
     deny  → PermissionDeniedError (asla sorulmaz, anında hata)
     allow → geç
     ask   → kullanıcıya sorulur
   Sorulacaklar: 'permission.asked' eventi yayınlanır (UI/WA dinler) ve
   promise bekletilir. Cevap (reply):
     'once'   → yalnız bu istek serbest
     'always' → pattern'ler oturum boyu approved listesine kural olarak eklenir;
                aynı oturumdaki diğer pending'lerden artık allow olanlar da serbest bırakılır
     'reject' → RejectedError (feedback'siz) veya CorrectedError (feedback'li);
                aynı oturumdaki DİĞER pending istekler de reddedilir (opencode birebir)

   Hata nesneleri araç çıktısına JSON hata olarak akıtılır; opencode
   core/v1/permission.ts mesajları kullanılır. */

const Permission = require('./permission');

let seq = 0;
function newId() {
  return 'prm_' + Date.now().toString(36) + (++seq).toString(36);
}

class AskService {
  constructor(emitFn) {
    this.emit = typeof emitFn === 'function' ? emitFn : () => {};
    this.pending = new Map(); // id -> { info, resolve, reject }
    this.approved = []; // oturumlar arası paylaşılan kural listesi (engine'e aşılanır)
  }

  /* opencode Permission.ask — throws: { kind:'denied'|'rejected'|'corrected', feedback? } */
  ask({ sessionId, ruleset, permission, patterns, metadata, always, tool }) {
    const pats = Array.isArray(patterns) && patterns.length ? patterns : ['*'];
    let needsAsk = false;
    for (const pattern of pats) {
      const rule = Permission.evaluate(permission, pattern, ruleset || [], this.approved);
      if (rule.action === 'deny') {
        throw { kind: 'denied', permission, pattern };
      }
      if (rule.action === 'allow') continue;
      needsAsk = true;
    }
    if (!needsAsk) return Promise.resolve();

    const id = newId();
    const info = {
      id,
      sessionID: String(sessionId || ''),
      permission,
      patterns: pats,
      metadata: metadata || {},
      always: Array.isArray(always) ? always : [],
      tool: tool || null,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { info, resolve, reject });
      try {
        this.emit({ type: 'permission.asked', sessionId: info.sessionID, request: info });
      } catch {}
      /* güvenlik: emit kanalı koptuysa pending asılı kalmasın */
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject({ kind: 'rejected' });
        }
      }, 5 * 60 * 1000);
    });
  }

  /* opencode Permission.reply — UI/WA tarafından çağrılır */
  reply(requestId, action, message) {
    const id = String(requestId || '');
    const existing = this.pending.get(id);
    if (!existing) return { ok: false, error: 'bekleyen izin isteği yok' };
    this.pending.delete(id);
    const { info } = existing;
    try {
      this.emit({ type: 'permission.replied', sessionId: info.sessionID, requestId: id, reply: action });
    } catch {}

    if (action === 'reject') {
      const err = message ? { kind: 'corrected', feedback: String(message) } : { kind: 'rejected' };
      existing.reject(err);
      /* aynı oturumdaki diğer pending'ler de reddedilir (opencode birebir) */
      for (const [pid, item] of [...this.pending.entries()]) {
        if (item.info.sessionID !== info.sessionID) continue;
        this.pending.delete(pid);
        try {
          this.emit({ type: 'permission.replied', sessionId: item.info.sessionID, requestId: pid, reply: 'reject' });
        } catch {}
        item.reject({ kind: 'rejected' });
      }
      return { ok: true };
    }

    existing.resolve();
    if (action === 'once') return { ok: true };

    /* 'always' — pattern bazlı kural yazılır (opencode birebir) */
    for (const pattern of info.always) {
      this.approved.push({ permission: info.permission, pattern, action: 'allow' });
    }
    for (const [pid, item] of [...this.pending.entries()]) {
      if (item.info.sessionID !== info.sessionID) continue;
      const ok = item.info.patterns.every(
        (pattern) => Permission.evaluate(item.info.permission, pattern, this.approved).action === 'allow'
      );
      if (!ok) continue;
      this.pending.delete(pid);
      try {
        this.emit({ type: 'permission.replied', sessionId: item.info.sessionID, requestId: pid, reply: 'always' });
      } catch {}
      item.resolve();
    }
    return { ok: true };
  }

  /* bekleyen istekler (UI listesi için) */
  list() {
    return [...this.pending.values()].map((x) => x.info);
  }

  /* hata nesnesini araç çıktısı metnine çevirir (opencode mesajları) */
  static errorText(err) {
    if (!err) return 'Permission denied';
    if (err.kind === 'denied') return 'Permission denied';
    if (err.kind === 'corrected')
      return 'The user rejected the permission request and gave feedback: ' + String(err.feedback || '');
    return Permission.MESSAGES.rejected;
  }
}

module.exports = { AskService };
