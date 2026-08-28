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
