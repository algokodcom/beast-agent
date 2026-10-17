'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const { WhatsAppBridge, statusLabel } = require('../src/agent/whatsapp');

function makeBridge() {
  const events = [];
  const wa = new WhatsAppBridge({ authDir: '/tmp/x', emit: (ev) => events.push(ev) });
  return { wa, events };
}

test('statusLabel bilinen durumları etiketler', () => {
  assert.equal(statusLabel(2), 'gönderildi ✓');
  assert.equal(statusLabel(3), 'teslim ✓✓');
  assert.equal(statusLabel(4), 'okundu ✓✓');
  assert.equal(statusLabel(0), 'hata');
});

test('statusLabel bilinmeyen durum', () => {
  assert.match(statusLabel(99), /bilinmeyen\(99\)/);
});

test('_trackOutgoing send eventi yayar ve takibe alır', () => {
  const { wa, events } = makeBridge();
  wa._trackOutgoing('90555@s.whatsapp.net', 'merhaba dunya', { key: { id: 'M1' } });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'send');
  assert.equal(events[0].id, 'M1');
  assert.ok(wa._tracked.has('M1'));
  assert.equal(wa._tracked.get('M1').preview, 'merhaba dunya');
});

test('_trackOutgoing key yoksa sessizce atlar', () => {
  const { wa, events } = makeBridge();
  wa._trackOutgoing('90555@s.whatsapp.net', 'x', null);
  assert.equal(events.length, 0);
});

test('tick: durum değişince event, aynı durumda tekrar yok', () => {
  const { wa, events } = makeBridge();
  wa._tracked.set('A', { jid: '90555@s.whatsapp.net', preview: 'selam', ts: 1, status: 1, receiptDetail: '' });
  wa._handleStatusUpdates([{ key: { id: 'A' }, update: { status: 3 } }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'tick');
  assert.equal(events[0].label, 'teslim ✓✓');
  events.length = 0;
  wa._handleStatusUpdates([{ key: { id: 'A' }, update: { status: 3 } }]);
  assert.equal(events.length, 0);
  // okundu'ya yükselir
  wa._handleStatusUpdates([{ key: { id: 'A' }, update: { status: 4 } }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].label, 'okundu ✓✓');
});

test('tick: izlenmeyen mesajlar yok sayılır', () => {
  const { wa, events } = makeBridge();
  wa._handleStatusUpdates([{ key: { id: 'BILINMEYEN' }, update: { status: 4 } }]);
  assert.equal(events.length, 0);
});

test('receipt: okundu zamanı detay olarak gelir, tekrarı bastırılır', () => {
  const { wa, events } = makeBridge();
  wa._tracked.set('C', { jid: '90555@s.whatsapp.net', preview: 's', ts: 1, status: 3, receiptDetail: '' });
  const readAt = 1700000000000;
  wa._handleReceipts([{ key: { id: 'C' }, receipt: { readAt } }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'receipt');
  assert.match(events[0].detail, /^okundu=/);
  events.length = 0;
  wa._handleReceipts([{ key: { id: 'C' }, receipt: { readAt } }]);
  assert.equal(events.length, 0);
});

test('takip haritası CAP ile sınırlı kalır', () => {
  const { wa } = makeBridge();
  for (let i = 0; i < 600; i++) wa._trackOutgoing(`j${i}@s.whatsapp.net`, `m${i}`, { key: { id: `ID${i}` } });
  assert.ok(wa._tracked.size <= 500);
  assert.ok(!wa._tracked.has('ID0'));
  assert.ok(wa._tracked.has('ID599'));
});

test('setWatchJids sock yokken güvenli', async () => {
  const { wa } = makeBridge();
  wa.setWatchJids(['90555@s.whatsapp.net']);
  assert.equal(wa._watchJids.size, 1);
  await wa._subscribePresence(); // patlamamalı
});

test('presence: composing etiketlenir, bilinmeyen durum yok sayılır', () => {
  const { wa, events } = makeBridge();
  wa._handlePresence({
    id: '90555@s.whatsapp.net',
    presences: { '90555:0@s.whatsapp.net': { lastKnownPresence: 'composing' } },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'presence');
  assert.equal(events[0].label, 'yazıyor');
  events.length = 0;
  wa._handlePresence({ id: 'x@s.whatsapp.net', presences: { p: { lastKnownPresence: 'uzaylı' } } });
  assert.equal(events.length, 0);
});

/* ---------- LID → gerçek telefon numarası (allow listesi PN ile eşleşsin) ---------- */

test('_pnOnly: PN jid, cihaz eki ve alt: sarmalayıcısı soyulur', () => {
  const { wa } = makeBridge();
  assert.equal(wa._pnOnly('905414178456@s.whatsapp.net'), '905414178456');
  assert.equal(wa._pnOnly('905414178456:12@s.whatsapp.net'), '905414178456');
  assert.equal(wa._pnOnly('alt:905414178456@s.whatsapp.net'), '905414178456');
});

test('_pnOnly: LID adresi PN sayılmaz (LID rakamı numara sanılmamalı)', () => {
  const { wa } = makeBridge();
  assert.equal(wa._pnOnly('83391152132258@lid'), '');
  assert.equal(wa._pnOnly('83391152132258:0@lid'), '');
  assert.equal(wa._pnOnly('120363428012942576@g.us'), '');
  assert.equal(wa._pnOnly(''), '');
  assert.equal(wa._pnOnly(undefined), '');
});

test('_lidToPn: Baileys eşleme deposundan gerçek numarayı çıkarır', async () => {
  const { wa } = makeBridge();
  let calls = 0;
  wa.sock = {
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid) => { calls++; assert.equal(lid, '83391152132258@lid'); return '905414178456:0@s.whatsapp.net'; },
      },
    },
  };
  assert.equal(await wa._lidToPn('83391152132258@lid'), '905414178456');
  assert.equal(calls, 1);
  // ikinci çağrı önbellekten — depoya tekrar gitmez
  assert.equal(await wa._lidToPn('83391152132258@lid'), '905414178456');
  assert.equal(calls, 1);
});

test('_lidToPn: eşleme yoksa boş döner ve LID rakamına düşmez', async () => {
  const { wa } = makeBridge();
  let calls = 0;
  wa.sock = { signalRepository: { lidMapping: { getPNForLID: async () => { calls++; return null; } } } };
  assert.equal(await wa._lidToPn('111222333444@lid'), '');
  // negatif sonuç cache'lenmez — eşleme sonradan gelebilir
  assert.equal(await wa._lidToPn('111222333444@lid'), '');
  assert.equal(calls, 2);
  // @lid olmayan adres hiç sorulmaz
  assert.equal(await wa._lidToPn('905414178456@s.whatsapp.net'), '');
  assert.equal(calls, 2);
});

test('_cacheLidPn / _cacheLidPnList: olaylardan gelen eşlemeler önbelleğe alınır', async () => {
  const { wa } = makeBridge();
  wa.sock = { signalRepository: { lidMapping: { getPNForLID: async () => null } } };
  wa._cacheLidPn({ lid: '83391152132258@lid', pn: '905414178456@s.whatsapp.net' });
  wa._cacheLidPnList([{ id: '74110331809870@lid', phoneNumber: '905513558456:36@s.whatsapp.net' }]);
  assert.equal(await wa._lidToPn('83391152132258@lid'), '905414178456');
  assert.equal(await wa._lidToPn('74110331809870@lid'), '905513558456');
  // geçersiz kayıtlar sessizce atlanır
  wa._cacheLidPn({ lid: 'x@lid', pn: '' });
  wa._cacheLidPnList([{ id: '905414178456@s.whatsapp.net', phoneNumber: '' }]);
});

test('_processIncoming: LID DM (alt alanı yok) gerçek numaraya çözülür', async () => {
  const got = [];
  const wa = new WhatsAppBridge({
    authDir: '/tmp/x',
    emit: () => {},
    onIncoming: (jid, payload, senderNum) => got.push({ jid, payload, senderNum }),
  });
  wa.sock = {
    user: { id: '905513558456:36@s.whatsapp.net', lid: '74110331809870:36@lid' },
    signalRepository: { lidMapping: { getPNForLID: async () => '905414178456:0@s.whatsapp.net' } },
  };
  await wa._processIncoming({
    key: { remoteJid: '83391152132258@lid', id: 'M1', fromMe: false },
    message: { conversation: 'selam' },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].jid, '83391152132258@lid');
  assert.equal(got[0].senderNum, '905414178456'); // allow listesi bu numarayla eşleşir
  assert.equal(got[0].payload.text, 'selam');
});

test('_processIncoming: remoteJidAlt PN veriyorsa eşleme deposuna gitmez', async () => {
  const got = [];
  const wa = new WhatsAppBridge({
    authDir: '/tmp/x',
    emit: () => {},
    onIncoming: (jid, payload, senderNum) => got.push({ jid, payload, senderNum }),
  });
  let calls = 0;
  wa.sock = {
    user: { id: '905513558456:36@s.whatsapp.net', lid: '74110331809870:36@lid' },
    signalRepository: { lidMapping: { getPNForLID: async () => { calls++; return null; } } },
  };
  await wa._processIncoming({
    key: { remoteJid: '83391152132258@lid', remoteJidAlt: '905414178456:4@s.whatsapp.net', id: 'M2', fromMe: false },
    message: { extendedTextMessage: { text: 'merhaba' } },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
  assert.equal(got.length, 1);
  assert.equal(got[0].senderNum, '905414178456');
  assert.equal(calls, 0);
});
