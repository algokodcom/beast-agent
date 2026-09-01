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

test('todo: boş/geçersiz girdiler elenir', () => {
  const out = sanitizeTodoItems([
    { title: 'Planla', status: 'active' },
    { title: '' },
    null,
    'Sadece string başlık',
    { title: 'Planla', status: 'done' }, // duplicate title
    { title: 'Bitir', status: 'saçma' },
  ]);
  assert.deepEqual(out, [
    { title: 'Planla', status: 'active' },
    { title: 'Sadece string başlık', status: 'pending' },
    { title: 'Bitir', status: 'pending' },
  ]);
});

test('todo: 20 ile sınırlı', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ title: 'görev ' + i }));
  assert.equal(sanitizeTodoItems(items).length, 20);
});

/* ---------- payload builder ---------- */

test('tool_call/tool mesajları birlikte tutulur', () => {
  const eng = makeEngine();
  const msgs = [
    { role: 'user', content: 'merhaba' },
    { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', name: 'list_dir', content: '{"ok":true}' },
    { role: 'assistant', content: 'sonuç şu' },
    { role: 'user', content: 'tekrar' },
  ];
  const payload = eng._buildPayload('sys', msgs);
  assert.equal(payload[0].role, 'system');
  const idxAssistant = payload.findIndex((m) => m.role === 'assistant');
  assert.ok(idxAssistant >= 0);
  assert.equal(payload[idxAssistant + 1].role, 'tool');
});

test('token bütçesine uyar: eski mesajlar düşer, son mesaj kalır', () => {
  const eng = makeEngine({ historyTokenBudget: 120 });
  const big = 'kelime '.repeat(400); // ~700 token
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: 'user', content: big + ' #' + i });
  const payload = eng._buildPayload('sys', msgs);
  // system + en az son kullanıcı mesajı
  assert.equal(payload[0].role, 'system');
  const last = payload[payload.length - 1];
  assert.ok(last.role === 'user' && last.content.includes('#9'));
  assert.ok(eng._payloadTokens(payload.slice(1)) <= 120 + estSlack(last));
  function estSlack(m) {
    return Math.ceil((m.content || '').length / 4) * 3; // tek mesaj taşabilir
  }
});

test('browser_open/browser_read kancaları çağrılır', async () => {
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

test('browser kancası yoksa zarif hata döner', async () => {
  const eng = makeEngine();
  const r = JSON.parse(await eng._execTool('browser_open', { url: 'https://x.com' }, null, 's1'));
  assert.equal(r.ok, false);
  assert.match(r.error, /tarayıcı/);
});

test('eski görseller metne indirilir, son mesajın görseli korunur', () => {
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
  assert.ok(firstUser.content.includes('bağlam dışı'));
  const lastUser = payload[payload.length - 1];
  assert.ok(Array.isArray(lastUser.content));
});

/* ---------- oturum notlar� (ge�ici haf�za) ---------- */

test('oturum notlar�: dosyadan y�klenir, mesaj listesine kar��maz', () => {
  const eng = makeEngine();
  const id = eng.createSession().id;
  for (let i = 0; i < 5; i++) {
    fs.appendFileSync(eng._file(id), JSON.stringify({ t: 'msg', role: 'user', content: 'mesaj ' + i }) + '\n');
  }
  fs.appendFileSync(eng._file(id), JSON.stringify({ t: 'notes', text: 'hedef: v7 �al�smas�', at: 3 }) + '\n');
  eng.cache.delete(id); // diskten taze y�kle
  const s = eng._load(id);
  assert.equal(s.notes, 'hedef: v7 �al�smas�');
  assert.equal(s.notesAt, 3);
  assert.equal(s.messages.length, 5);
});

test('oturum notlar� varken payload s�k�la��r', () => {
  const eng = makeEngine({ historyTokenBudget: 100000 });
  const msgs = [];
  for (let i = 0; i < 30; i++) msgs.push({ role: 'user', content: 'kisa mesaj #' + i });
  const withoutNotes = eng._buildPayload('sys', msgs, null);
  const withNotes = eng._buildPayload('sys', msgs, '�zet: test');
  assert.ok(withNotes.length < withoutNotes.length);
  assert.equal(withNotes[withNotes.length - 1].content, 'kisa mesaj #29'); // son mesaj hep kal�r
});

/* ---------- observe(): sessiz bağlam enjeksiyonu ---------- */

test('observe: mesaj geçmişe düşer ama run tetiklenmez', async () => {
  const events = [];
  const eng = makeEngine({ emit: (ev) => events.push(ev) });
  const id = eng.createSession().id;
  const ok = eng.observe(id, '[BAĞLAM — grup] ali: selam');
  assert.ok(ok);
  const s = eng._load(id);
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].role, 'user');
  assert.ok(s.messages[0].content.startsWith('[BAĞLAM'));
  // _run tetiklenmedi: LLM hatası/done olayı yok
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(!events.some((e) => e.type === 'error' || e.type === 'done'));
  // observe olayı yayıldı
  assert.ok(events.some((e) => e.type === 'observe' && e.sessionId === id));
  // boş metin false
  assert.equal(eng.observe(id, '   '), false);
});

test('observe: ardışık bağlam mesajları tek mesajda birleşir', () => {
  const eng = makeEngine();
  const id = eng.createSession().id;
  eng.observe(id, '[BAĞLAM — grup] ali: selam');
  eng.observe(id, '[BAĞLAM — grup] ayşe: nasılsın');
  const s = eng._load(id);
  assert.equal(s.messages.length, 1);
  assert.ok(s.messages[0].content.includes('ali: selam'));
  assert.ok(s.messages[0].content.includes('ayşe: nasılsın'));
  // dosyaya da tek satır yazıldı
  const lines = fs.readFileSync(eng._file(id), 'utf8').split('\n').filter((l) => l.trim());
  const msgLines = lines.filter((l) => { try { return JSON.parse(l).t === 'msg'; } catch { return false; } });
  assert.equal(msgLines.length, 1);
});

test('observe: normal user mesajıyla birleşmez', () => {
  const eng = makeEngine();
  const id = eng.createSession().id;
  const s = eng._load(id);
  s.messages.push({ role: 'user', content: 'gerçek soru' });
  fs.appendFileSync(eng._file(id), JSON.stringify({ t: 'msg', role: 'user', content: 'gerçek soru' }) + '\n');
  eng.observe(id, '[BAĞLAM — grup] ali: selam');
  assert.equal(s.messages.length, 2);
  assert.equal(s.messages[0].content, 'gerçek soru');
  assert.ok(s.messages[1].content.startsWith('[BAĞLAM'));
});

test('send: mention mesajı bekleyen bağlam mesajıyla birleşir ve run başlar', async () => {
  const events = [];
  const eng = makeEngine({ emit: (ev) => events.push(ev) });
  const id = eng.createSession().id;
  eng.observe(id, '[BAĞLAM — grup] ali: selam\nayşe: nasılsın');
  eng.send(id, { text: '@beast bana bugün hava nasıl?' });
  const s = eng._load(id);
  assert.equal(s.messages.length, 1);
  assert.ok(s.messages[0].content.includes('ayşe: nasılsın'));
  assert.ok(s.messages[0].content.includes('@beast bana bugün hava nasıl?'));
  // run başladı → sağlayıcı yoksa hata olayı düşer (tetiklenme kanıtı)
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(events.some((e) => e.type === 'error' || e.type === 'done'));
});
