'use strict';

/* Beast Mobile — device.js + mobile.js birim testleri
   - Cihaz kodu: biçim + kalıcılık + yenileme
   - WS köprüsü: auth doğru/yanlış + broadcast + send/open/new komut iletimi */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.BEAST_DATA = path.join(os.tmpdir(), 'beast-test-' + Date.now());
const device = require('../src/agent/device.js');

test('device: kod üretilir, biçimi doğru, diske yazılır', () => {
  const d1 = device.ensureDevice();
  assert.ok(device.isValidCode(d1.code), 'kod biçimi BEAST-XXXX-XXXX olmalı: ' + d1.code);
  assert.ok(fs.existsSync(device.deviceFile()), 'device.json yazılmış olmalı');
  const d2 = device.getDevice();
  assert.strictEqual(d2.code, d1.code, 'ikinci okuma AYNI kodu döndürmeli');
});

test('device: marka alfabe karışan karakteri içermiyor', () => {
  const code = device.getDevice().code.replace('BEAST-', '');
  assert.ok(!/[01ILO]/.test(code), '0/1/I/L/O karışan harfler kodda olmamalı');
});

test('device: regenCode YENİ kod üretir ve eski ile aynı değildir', () => {
  const before = device.getDevice().code;
  const after = device.regenCode();
  assert.ok(device.isValidCode(after.code));
  assert.notStrictEqual(after.code, before);
});

test('device: telefon eşleşmesi kaydı + kick', () => {
  device.resetCache();
  device.ensureDevice();
  device.upsertPhone({ id: 'ph1', name: 'Pixel 7', platform: 'android' });
  device.upsertPhone({ id: 'ph1', name: 'Pixel 7 Pro', platform: 'android' });
  device.upsertPhone({ id: 'ph2', name: 'S23', platform: 'android' });
  const list = device.listPhones();
  assert.strictEqual(list.length, 2);
  const ph1 = list.find((p) => p.id === 'ph1');
  assert.strictEqual(ph1.name, 'Pixel 7 Pro', 'ikinci upsert adı güncellemeli');
  device.kickPhone('ph2');
  assert.strictEqual(device.listPhones().length, 1);
});

let wsMod = null;

test('mobile: ws köprüsü başlar, iyi kod auth olur, kötü kod reddedilir', async () => {
  wsMod = require('../src/agent/mobile.js');
  const correct = device.getDevice().code;
  let sendHit = 0, newHit = 0;
  wsMod.setHandlers({
    onSend: (sid, p) => { if (sid === 's1' && p.text === 'merhaba') sendHit = 1; },
    onNew: () => { newHit++; },
    /* geçmiş snapshot: masaüstü onOpen(sid, sendS) — sendS o sokete {t:'session'} yollar */
    onOpen: (sid, sendS) => { try { sendS({ t: 'session', sid, messages: [{ role: 'user', content: 'geçmiş-örnek' }] }); } catch {} },
    onSessions: (sendS) => { try { sendS({ t: 'sessions', list: [{ id: 's1', title: 'test' }], activeSid: 's1' }); } catch {} },
  });
  const port = 47850 + (process.pid % 200);
  const r = wsMod.start({ port, getDeviceCode: () => correct });
  assert.ok(r.ok, 'sunucu başlamalı: ' + (r.error || ''));
  try {
    await new Promise((res) => setTimeout(res, 300));
    assert.ok(wsMod.isRunning(), 'WS running olmalı');

    const WebSocket = require('ws');
    const connect = (code) => new Promise((resolve) => {
      const ws = new WebSocket('ws://127.0.0.1:' + port);
      const msgs = [];
      ws.on('message', (b) => {
        const o = JSON.parse(b.toString());
        msgs.push(o);
        if (o.t === 'auth-bad') { ws.close(); resolve({ ws, msgs, bad: true }); }
        if (o.t === 'auth-ok') resolve({ ws, msgs, ok: true });
        if (o.t === 'sessions') resolve({ ws, msgs, ok: true });
      });
      ws.on('open', () => { try { ws.send(JSON.stringify({ t: 'auth', code, name: 'T', platform: 'android', did: 'd1' })); } catch {} });
      ws.on('error', () => resolve({ ws, msgs, err: true }));
      setTimeout(() => resolve({ ws, msgs, timeout: true }), 3000);
    });

    /* kötü kod → auth-bad yanıt */
    const bad = await connect('BEAST-9999-9999');
    assert.ok(bad.bad, 'yanlış kod auth-bad döndürmeli');
    try { bad.ws.close(); } catch {}

    /* doğru kod → auth-ok + sessions anında düşer */
    const good = await connect(correct);
    assert.ok(good.ok && good.msgs.some((m) => m.t === 'auth-ok'), 'doğru kod auth-ok almalı');
    assert.ok(good.msgs.some((m) => m.t === 'sessions'), 'auth sonrası sessions anında gelmeli');
    await new Promise((res) => setTimeout(res, 150));
    assert.strictEqual(wsMod.clientCount(), 1, 'tek istemci kayıtlı (bad soketi kapanmış)');

    /* broadcast her istemciye ulaşır */
    /* AGENT ETKİNLİKLERİ 'type' alanı ile taşınır (glass/desktop event şekli) */
    let got = null;
    good.ws.on('message', (b) => {
      try { const o = JSON.parse(b.toString()); if (o.type === 'status') got = o; } catch {}
    });
    wsMod.broadcast({ sessionId: 's1', type: 'status', status: 'selam mobile' });
    await new Promise((res) => setTimeout(res, 250));
    assert.ok(got && got.status === 'selam mobile', 'broadcast istemciye iletildi');

    /* komutlar handler'lara ulaşır */
    good.ws.send(JSON.stringify({ t: 'send', sid: 's1', text: 'merhaba' }));
    good.ws.send(JSON.stringify({ t: 'new' }));
    good.ws.send(JSON.stringify({ t: 'open', sid: 's1' }));
    await new Promise((res) => setTimeout(res, 250));
    assert.strictEqual(sendHit, 1, 'onSend handler metni aldı');
    assert.strictEqual(newHit, 1, 'onNew handler çağrıldı');
    /* open → telefona geçmiş snapshot'ı dönmeli (geçmiş yükleme zinciri) */
    assert.ok(
      good.msgs.some((m) => m.t === 'session' && m.sid === 's1' && Array.isArray(m.messages) && m.messages[0].content === 'geçmiş-örnek'),
      'open sonrası istemciye {t:session} snapshot dönmeli'
    );

    try { good.ws.close(); } catch {}
  } finally {
    /* assert düşse bile sunucu/soketler kapanır — süreç askıda kalmaz */
    try { wsMod.stop(); } catch {}
  }
  assert.ok(!wsMod.isRunning(), 'stop sonrası running=false');
});
