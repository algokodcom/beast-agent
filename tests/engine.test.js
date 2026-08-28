'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Engine, sanitizeTodoItems } = require('../src/agent/engine');

function makeEngine(extra = {}) {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-sess-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-ws-'));
  return new Engine(
    {},
    { sessionsDir, workspace, customProviders: [], emit: () => {}, ...extra }
  );
}

/* ---------- sanitizeTodoItems ---------- */

test('todo: boÅŸ/geÃ§ersiz girdiler elenir', () => {
  const out = sanitizeTodoItems([
    { title: 'Planla', status: 'active' },
    { title: '' },
    null,
    'Sadece string baÅŸlÄ±k',
    { title: 'Planla', status: 'done' }, // duplicate title
    { title: 'Bitir', status: 'saÃ§ma' },
  ]);
  assert.deepEqual(out, [
    { title: 'Planla', status: 'active' },
    { title: 'Sadece string baÅŸlÄ±k', status: 'pending' },
    { title: 'Bitir', status: 'pending' },
  ]);
});

test('todo: 20 ile sÄ±nÄ±rlÄ±', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ title: 'gÃ¶rev ' + i }));
  assert.equal(sanitizeTodoItems(items).length, 20);
});

/* ---------- payload builder ---------- */

test('tool_call/tool mesajlarÄ± birlikte tutulur', () => {
  const eng = makeEngine();
  const msgs = [
    { role: 'user', content: 'merhaba' },
    { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', name: 'list_dir', content: '{"ok":true}' },
    { role: 'assistant', content: 'sonuÃ§ ÅŸu' },
    { role: 'user', content: 'tekrar' },
  ];
  const payload = eng._buildPayload('sys', msgs);
  assert.equal(payload[0].role, 'system');
  const idxAssistant = payload.findIndex((m) => m.role === 'assistant');
  assert.ok(idxAssistant >= 0);
  assert.equal(payload[idxAssistant + 1].role, 'tool');
});

test('token bÃ¼tÃ§esine uyar: eski mesajlar dÃ¼ÅŸer, son mesaj kalÄ±r', () => {
  const eng = makeEngine({ historyTokenBudget: 120 });
  const big = 'kelime '.repeat(400); // ~700 token
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'user', content: big + ' #' + i });
  const payload = eng._buildPayload('sys', msgs);
  // system + en az son kullanÄ±cÄ± mesajÄ±
  assert.equal(payload[0].role, 'system');
  const last = payload[payload.length - 1];
  assert.ok(last.role === 'user' && last.content.includes('#9'));
  assert.ok(eng._payloadTokens(payload.slice(1)) <= 120 + estSlack(last));
  function estSlack(m) {
    return Math.ceil((m.content || '').length / 4) * 3; // tek mesaj taÅŸabilir
  }
});

test('browser_open/browser_read kancalarÄ± Ã§aÄŸrÄ±lÄ±r', async () => {
  const calls = [];
  const eng = makeEngine({
    browser: {
      openUrl: async (u) => { calls.push(['open', u]); return { ok: true, url: u, title: 'T' }; },
      readText: async () => { calls.push(['read']); return { ok: true, content: 'sayfa metni' }; },
    },
  });
  const r1 = JSON.parse(await eng._execTool('browser_open', { url: 'https://example.com' }, null, 's1'));
  const r2 = JSON.parse(await eng._execTool('browser_read', {}, null, 's1'));
  assert.ok(r1.ok && r1.title === 'T');
  assert.ok(r2.ok && r2.content.includes('metni'));
  assert.deepEqual(calls, [['open', 'https://example.com'], ['read']]);
});

test('browser kancasÄ± yoksa zarif hata dÃ¶ner', async () => {
  const eng = makeEngine();
  const r = JSON.parse(await eng._execTool('browser_open', { url: 'https://x.com' }, null, 's1'));
  assert.equal(r.ok, false);
  assert.match(r.error, /tarayÄ±cÄ±/);
});

test('eski gÃ¶rseller metne indirilir, son mesajÄ±n gÃ¶rseli korunur', () => {
  const eng = makeEngine();
  const img = (u) => [{ type: 'text', text: 'bak' }, { type: 'image_url', image_url: { url: u } }];
  const msgs = [
    { role: 'user', content: img('data:image/png;base64,AAAA') },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: img('data:image/png;base64,BBBB') },
  ];
  const payload = eng._buildPayload('sys', msgs);
  const firstUser = payload.find((m) => m.role === 'user');
  assert.equal(typeof firstUser.content, 'string');
  assert.ok(firstUser.content.includes('baÄŸlam dÄ±ÅŸÄ±'));
  const lastUser = payload[payload.length - 1];
  assert.ok(Array.isArray(lastUser.content));
});

/* ---------- oturum notlarý (geçici hafýza) ---------- */

test('oturum notlarý: dosyadan yüklenir, mesaj listesine karýþmaz', () => {
  const eng = makeEngine();
  const id = eng.createSession().id;
  for (let i = 0; i < 5; i++) {
    fs.appendFileSync(eng._file(id), JSON.stringify({ t: 'msg', role: 'user', content: 'mesaj ' + i }) + '\n');
  }
  fs.appendFileSync(eng._file(id), JSON.stringify({ t: 'notes', text: 'hedef: v7 çalýsmasý', at: 3 }) + '\n');
  eng.cache.delete(id); // diskten taze yükle
  const s = eng._load(id);
  assert.equal(s.notes, 'hedef: v7 çalýsmasý');
  assert.equal(s.notesAt, 3);
  assert.equal(s.messages.length, 5);
});

test('oturum notlarý varken payload sýkýlaþýr', () => {
  const eng = makeEngine({ historyTokenBudget: 100000 });
  const msgs = [];
  for (let i = 0; i < 30; i++) msgs.push({ role: 'user', content: 'kisa mesaj #' + i });
  const withoutNotes = eng._buildPayload('sys', msgs, null);
  const withNotes = eng._buildPayload('sys', msgs, 'özet: test');
  assert.ok(withNotes.length < withoutNotes.length);
  assert.equal(withNotes[withNotes.length - 1].content, 'kisa mesaj #29'); // son mesaj hep kalýr
});
