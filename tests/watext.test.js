'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const { waCleanText, waToolLine } = require('../src/agent/watext');

/* #16: TÜM markdown işaretleri temizlenir — WhatsApp'ta bold/başlık yok */
test('markdown işaretleri tamamen temizlenir (#16)', () => {
  assert.equal(waCleanText('**selam** dünya'), 'selam dünya');
  assert.equal(waCleanText('*vurgu* bitti'), 'vurgu bitti');
  assert.equal(waCleanText('***üç***'), 'üç');
  assert.equal(waCleanText('## Başlık\nmetin'), 'Başlık\nmetin');
  assert.ok(!waCleanText('a *b* c #d').includes('*'));
  assert.ok(!waCleanText('a *b* c #d').includes('#'));
  assert.ok(waCleanText('fiyat #kolon başlığı').length > 0); // kareli metin bozulmadan gelir, işaret gider
});

test('başlık kareleri ve alıntı işaretleri gider', () => {
  assert.equal(waCleanText('> alıntı satırı'), 'alıntı satırı');
  assert.match(waToolLine('run_command', { command: 'npm test' }), /Terminal: npm test/);
});

test('liste tireleri madde imine döner', () => {
  assert.equal(waCleanText('- bir\n- iki'), '\u2022 bir\n\u2022 iki');
  assert.equal(waCleanText('* elma\n+ armut'), '\u2022 elma\n\u2022 armut');
});

test('snake_case alt çizgisi korunur, _italik_ temizlenir', () => {
  assert.equal(waCleanText('file_name değişmedi'), 'file_name değişmedi');
  assert.equal(waCleanText('bu _önemli_ bir konu'), 'bu önemli bir konu');
});

test('linkler düz metne döner', () => {
  assert.equal(waCleanText('[site](https://x.com) bak'), 'site (https://x.com) bak');
});

test('kod bloğu fence gider, içerik kalır', () => {
  const out = waCleanText('```js\nconsole.log(1)\n```');
  assert.equal(out, 'console.log(1)');
});

test('yatay çizgiler ve fazla boşluklar silinir', () => {
  assert.equal(waCleanText('üst\n---\nalt'), 'üst\nalt');
  assert.equal(waCleanText('a\n\n\n\nb'), 'a\n\nb');
});

test('araç satırları düz metin ve kırpılır', () => {
  assert.equal(waToolLine('read_file', { path: 'C:\\a.txt' }), '\u203A Dosya oku: C:\\a.txt');
  assert.equal(waToolLine('web_search', { query: 'btc fiyat' }), '\u203A Web arama: btc fiyat');
  assert.match(waToolLine('bilinmeyen_arac', {}), /\u203A bilinmeyen_arac/);
  assert.ok(waToolLine('run_command', { command: 'x'.repeat(500) }).length < 180);
});
