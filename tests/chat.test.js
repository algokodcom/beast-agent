'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const T0 = 1700000000;

function mkRates() {
  const out = [];
  for (let i = 0; i < 40; i++) {
    out.push({ time: T0 + i * 3600, open: 1.1000, high: 1.1015, low: 1.0995, close: 1.1010 });
  }
  return out;
}

globalThis.chartState = {
  symbol: 'EURUSD',
  tf: 'H1',
  digits: 5,
  rates: mkRates(),
  drawings: [],
  alerts: [],
  drawColors: {},
};
globalThis.saveDrawings = () => {};
globalThis.savePlans = () => {};
globalThis.saveAlerts = () => {};
globalThis.drawChart = () => {};
globalThis.applyPlanButtons = () => {};
globalThis.renderAlertSide = () => {};
globalThis.toast = () => {};
globalThis.termLogAdd = () => {};
globalThis.jevLogAdd = () => {};
globalThis.jevClear = () => {
  globalThis.chartState.drawings = [];
  return 1;
};
globalThis.jevPlan = () => true;
globalThis.jevAlert = () => true;

const C = require('../src/jev/renderer/chat.js');

test('chat.js yüklenir ve sürüm döner', () => {
  assert.ok(C && C.VERSION);
  assert.equal(typeof C.applyCommands, 'function');
});

test('sistem promptu ve çizim kataloğu taşınmış durumda', () => {
  const s = C.systemPrompt();
  assert.ok(s.length > 1000);
  assert.match(s, /JevTrader/);
  assert.match(s, /<<DRAW>>/);
  const blocks = C.promptBlocks();
  assert.match(blocks, /hline/);
  assert.match(blocks, /zone/);
  assert.match(blocks, /ÇİZİM VE ALARM BAKIMI/);
});

test('hline varsayılan olarak tam genişlik çizilir', () => {
  globalThis.chartState.drawings = [];
  assert.equal(C.draw({ type: 'hline', p: 1.1020, label: 'DİRENÇ' }), true);
  const d = globalThis.chartState.drawings[0];
  assert.equal(d.type, 'hline');
  assert.equal(d.src, 'ai');
  assert.equal(d.short, undefined);
  assert.equal(d.points[0].p, 1.1020);
  assert.equal(d.label, 'DİRENÇ');
});

test('hline short alanını yok sayar; çizim her zaman tam genişliktir', () => {
  globalThis.chartState.drawings = [];
  assert.equal(C.draw({ type: 'hline', p: 1.1015, short: true, len: 10 }), true);
  const d = globalThis.chartState.drawings[0];
  assert.equal(d.type, 'hline');
  assert.equal(d.short, undefined);
  assert.equal(d.len, undefined);
});

test('zone/orderblock doğru renk ve etiketle kutuya dönüşür', () => {
  globalThis.chartState.drawings = [];
  assert.equal(C.draw({
    type: 'zone', kind: 'orderblock',
    from: { t: -5, p: 1.1010 }, to: { t: 0, p: 1.1020 },
  }), true);
  const d = globalThis.chartState.drawings[0];
  assert.equal(d.type, 'rect');
  assert.equal(d.color, '#3b82f6');
  assert.equal(d.label, 'ORDERBLOCK');
});

test('seg, range, free ve text çizimleri desteklenir', () => {
  globalThis.chartState.drawings = [];
  assert.equal(C.draw({ type: 'seg', from: { t: -10, p: 1.1000 }, to: { t: 0, p: 1.1020 }, label: 'trend' }), true);
  assert.equal(C.draw({ type: 'range', from: { t: -10, p: 1.1010 }, to: { t: 0, p: 1.1030 }, pd: true }), true);
  assert.equal(C.draw({ type: 'free', points: [{ t: -10, p: 1.1000 }, { t: 0, p: 1.1020 }] }), true);
  assert.equal(C.draw({ type: 'text', t: -2, p: 1.1020, text: 'DİRENÇ' }), true);
  const types = globalThis.chartState.drawings.map((d) => d.type);
  assert.deepEqual(types, ['seg', 'range', 'free', 'text']);
  assert.equal(globalThis.chartState.drawings[1].pd, true);
});

test('geçersiz fiyat reddedilir', () => {
  globalThis.chartState.drawings = [];
  assert.equal(C.draw({ type: 'hline', p: 0 }), false);
  assert.equal(C.draw({ type: 'seg', from: { t: -1, p: 1.1 }, to: { t: 0, p: -5 } }), false);
  assert.equal(globalThis.chartState.drawings.length, 0);
});

test('parse komutları ayırır ve metni temizler', () => {
  const r = C.parse('Seviye çizildi.\n<<DRAW {"type":"hline","p":1.1020}>>');
  assert.equal(r.clean, 'Seviye çizildi.');
  assert.equal(r.cmds.length, 1);
  assert.equal(r.cmds[0].name, 'DRAW');
  assert.equal(r.cmds[0].data.p, 1.1020);
});

test('applyCommands CLEAR komutunu DRAW komutundan önce uygular', async () => {
  globalThis.chartState.drawings = [];
  const out = await C.applyCommands(
    '<<DRAW {"type":"hline","p":1.1020}>>\n<<CLEAR {"what":"ai"}>>'
  );
  assert.equal(globalThis.chartState.drawings.length, 1, 'yeni çizim silinmemeli');
  assert.equal(globalThis.chartState.drawings[0].points[0].p, 1.1020);
  assert.match(out, /Uygulandı|çizim/i);
});

test('envanter AI çizim/alarmlarını listeler, h1range çizimlerini dışlar', () => {
  globalThis.chartState.drawings = [
    { type: 'hline', points: [{ t: T0, p: 1.1020 }], label: 'DİRENÇ', src: 'ai' },
    { type: 'range', points: [{ t: T0, p: 1.1000 }, { t: T0 + 3600, p: 1.1010 }], label: 'H1 SIKIŞMA', src: 'ai', mark: 'h1range' },
  ];
  globalThis.chartState.alerts = [
    { price: 1.1030, cond: 'above', note: 'direnç', src: 'ai', active: true },
  ];
  const txt = C.inventoryBlock();
  assert.match(txt, /DİRENÇ/);
  assert.doesNotMatch(txt, /H1 SIKIŞMA/);
  assert.match(txt, /1\.103/);
  assert.match(txt, /AI çizimleri \(1\)/);
  assert.match(txt, /AI alarmları \(1\)/);
});
