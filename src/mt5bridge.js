'use strict';

/* Beast Finance — MT5 köprü yöneticisi (main süreç).
   Python stdio köprüsünü (mt5_bridge.py) spawn eder; JSON satır istek/yanıt
   ve event akışını yönetir. Python bulunamazsa aday listesinde sıradakini
   dener; süreç düşerse backoff ile yeniden başlatır. */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const BUNDLED_SCRIPT = path.join(__dirname, 'agent', 'scripts', 'mt5_bridge.py');

/* Paketli uygulamada köprü scripti app.asar İÇİNDE kalır — harici Python
   onu OKUYAMAZ. Her başlatmada %APPDATA%\beast\finance altına güncel haliyle
   yazılır (Node asar içini okuyabilir) ve oradan çalıştırılır. */
function scriptPath() {
  try {
    const dest = path.join(process.env.APPDATA || process.env.TMP || process.cwd(), 'beast', 'finance', 'mt5_bridge.py');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(BUNDLED_SCRIPT, dest);
    return dest;
  } catch {
    return BUNDLED_SCRIPT;
  }
}

class MT5Bridge extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this._buf = '';
    this._reqId = 1;
    this._pending = new Map();
    this._stopped = true;
    this._backoff = 1500;
    this._lastError = '';
    this._terminal = null;
    this._account = null;
    this._candidates = ['python', 'py -3'];
    this._candIdx = 0;
    this._terminalPath = '';
    this._everConnected = false;
  }

  get running() {
    return !!this.proc;
  }

  status() {
    return {
      running: this.running,
      connected: !!this._terminal,
      terminal: this._terminal,
      account: this._account,
      error: this._lastError,
      python: this._candidates[this._candIdx] || '',
    };
  }

  /* opts: { candidates: ['python','py -3'], terminal: 'C:\\...\\terminal64.exe' } */
  start(opts = {}) {
    if (Array.isArray(opts.candidates) && opts.candidates.length) {
      const next = opts.candidates.map((c) => String(c).trim()).filter(Boolean);
      if (next.join('|') !== this._candidates.join('|')) {
        this._candidates = next;
        this._candIdx = 0;
      }
    }
    this._terminalPath = String(opts.terminal || '').trim();
    this._stopped = false;
    if (this.running) return;
    this._spawn();
  }

  _spawn() {
    if (this._stopped) return;
    const cand = this._candidates[this._candIdx] || 'python';
    /* 'py -3' gibi çok kelimeli kısa komutlar bölünür; tam yol tek exe'dir */
    const parts = /[\\/]/.test(cand) ? [cand] : cand.split(/\s+/);
    const exe = parts[0];
    const preArgs = parts.slice(1);
    let proc;
    try {
      proc = spawn(exe, [...preArgs, scriptPath(), ...(this._terminalPath ? ['--terminal', this._terminalPath] : [])], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      this._lastError = 'Python başlatılamadı: ' + String((e && e.message) || e);
      this.emit('log', { level: 'error', line: this._lastError });
      this._nextCandidateOrRetry();
      return;
    }
    this.proc = proc;
    this._buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      this._buf += chunk;
      let i;
      while ((i = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, i).trim();
        this._buf = this._buf.slice(i + 1);
        if (line) this._onLine(line);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => {
      const t = String(c).trim();
      if (t) this.emit('log', { level: 'error', line: t.slice(0, 400) });
    });
    proc.on('error', (e) => {
      this._lastError = `Python (${exe}) bulunamadı/başlatılamadı: ` + String((e && e.message) || e);
      this.emit('log', { level: 'error', line: this._lastError });
      try { this._failAll(this._lastError); } catch {}
      if (this.proc === proc) this.proc = null;
      this._nextCandidateOrRetry();
    });
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      this._terminal = null;
      this._account = null;
      try { this._failAll('MT5 köprüsü kapandı (kod ' + code + ')'); } catch {}
      this.emit('bridge', { connected: false, error: this._lastError || ('süreç kapandı (kod ' + code + ')') });
      this._nextCandidateOrRetry();
    });
  }

  /* aday python'ları sırayla dener; hepsi tükendiyse backoff ile yeniden dener */
  _nextCandidateOrRetry() {
    if (this._stopped) return;
    if (this._candIdx < this._candidates.length - 1) {
      this._candIdx += 1;
      this.emit('log', { level: 'info', line: 'python adayı deneniyor: ' + this._candidates[this._candIdx] });
      setTimeout(() => { try { this._spawn(); } catch {} }, 300);
      return;
    }
    this._candIdx = 0;
    setTimeout(() => { try { if (!this._stopped && !this.running) this._spawn(); } catch {} }, this._backoff);
    this._backoff = Math.min(this._backoff * 2, 15000);
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch {
      this.emit('log', { level: 'info', line: line.slice(0, 240) });
      return;
    }
    if (msg.event) {
      if (msg.event === 'bridge') {
        this._terminal = msg.terminal || null;
        this._account = msg.account || null;
        this._lastError = String(msg.error || '');
        if (msg.connected) {
          this._everConnected = true;
          this._backoff = 1500;
        }
        this.emit('bridge', msg);
      } else if (msg.event === 'log') {
        this.emit('log', msg);
      } else {
        this.emit('event', msg);
      }
      return;
    }
    if (msg.id != null && this._pending.has(msg.id)) {
      const en = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(en.timer);
      en.resolve(msg);
    }
  }

  call(method, params, timeoutMs = 12000) {
    if (!this.running) return Promise.resolve({ ok: false, error: 'MT5 köprüsü çalışmıyor' });
    const id = this._reqId++;
    let resolveFn = null;
    const p = new Promise((resolve) => { resolveFn = resolve; });
    const timer = setTimeout(() => {
      this._pending.delete(id);
      resolveFn({ ok: false, error: 'MT5 zaman aşımı: ' + method });
    }, Math.max(2000, Number(timeoutMs) || 12000));
    this._pending.set(id, { timer, resolve: resolveFn });
    try {
      this.proc.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      this._pending.delete(id);
      resolveFn({ ok: false, error: 'köprü yazma hatası: ' + String((e && e.message) || e) });
    }
    return p;
  }

  stop() {
    this._stopped = true;
    try { this._failAll('köprü kapatıldı'); } catch {}
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
    this._terminal = null;
    this._account = null;
  }

  _failAll(err) {
    for (const [, en] of this._pending) {
      clearTimeout(en.timer);
      en.resolve({ ok: false, error: err });
    }
    this._pending.clear();
  }
}

module.exports = new MT5Bridge();
