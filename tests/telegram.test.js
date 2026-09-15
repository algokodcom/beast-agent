'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const { TelegramBridge } = require('../src/agent/telegram');

function makeBridge() {
  const calls = [];
  const tg = new TelegramBridge({ token: '123:ABC', emit: () => {} });
  tg._post = async (method, payload, headers, timeout) => {
    calls.push({ method, payload, headers, timeout });
    return { ok: true };
  };
  return { tg, calls };
}

test('send: 4096 sınırında böler ve topic (message_thread_id) taşır', async () => {
  const { tg, calls } = makeBridge();
  await tg.send(123, 'a'.repeat(8000), 77);
  assert.equal(calls.length, 3); // 3800 + 3800 + 400
  const first = JSON.parse(String(calls[0].payload));
  assert.equal(first.chat_id, 123);
  assert.equal(first.message_thread_id, 77);
  assert.equal(first.text.length, 3800);
  assert.equal(calls[0].method, 'sendMessage');
  /* thread yoksa alan hiç gönderilmez */
  calls.length = 0;
  await tg.send(123, 'kısa');
  assert.equal(calls.length, 1);
  const plain = JSON.parse(String(calls[0].payload));
  assert.ok(!('message_thread_id' in plain));
});

test('send: boş metin gönderilmez', async () => {
  const { tg, calls } = makeBridge();
  assert.equal(await tg.send(1, '   '), false);
  assert.equal(calls.length, 0);
});

test('sendPhoto: data URL multipart olarak yüklenir; caption + thread taşınır', async () => {
  const { tg, calls } = makeBridge();
  const png = 'data:image/png;base64,' + Buffer.from('PNGDATA').toString('base64');
  const ok = await tg.sendPhoto(-100123, png, 'Ajan: grafik', 42);
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendPhoto');
  assert.match(String(calls[0].headers['Content-Type']), /multipart\/form-data; boundary=----Beast/);
  const body = Buffer.from(calls[0].payload).toString('latin1');
  assert.match(body, /name="chat_id"\r\n\r\n-100123/);
  assert.match(body, /name="message_thread_id"\r\n\r\n42/);
  assert.match(body, /name="caption"\r\n\r\nAjan: grafik/);
  assert.match(body, /filename="beast\.png"/);
  assert.match(body, /PNGDATA/);
});

test('sendPhoto: gif sendDocument olur; bozuk/yabancı veri reddedilir', async () => {
  const { tg, calls } = makeBridge();
  const gif = 'data:image/gif;base64,' + Buffer.from('GIF89a').toString('base64');
  assert.equal(await tg.sendPhoto(1, gif, '', 0), true);
  assert.equal(calls[0].method, 'sendDocument');
  assert.match(Buffer.from(calls[0].payload).toString('latin1'), /filename="beast\.gif"/);
  calls.length = 0;
  assert.equal(await tg.sendPhoto(1, 'data:image/png;base64,%%%'), false);
  assert.equal(await tg.sendPhoto(1, 'https://ornek/a.png'), false);
  assert.equal(await tg.sendPhoto(1, ''), false);
  assert.equal(calls.length, 0);
});
