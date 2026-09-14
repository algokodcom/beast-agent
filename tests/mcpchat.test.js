'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Engine } = require('../src/agent/engine');

function makeEngine() {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-mcpchat-'));
  return new Engine({}, { sessionsDir, workspace: sessionsDir, customProviders: [], emit: () => {} });
}

/* oturumu başlıkla (bgTitle) oluştur: gerçek akış gibi meta2 + msg satırları yazılır */
function titledSession(eng, title, userText, assistantText) {
  const v = eng.createSession();
  const s = eng._load(v.id);
  s.bgTitle = title;
  const msgs = [{ role: 'user', content: userText }];
  if (assistantText) msgs.push({ role: 'assistant', content: assistantText });
  for (const m of msgs) {
    s.messages.push(m);
    eng._append(s, m);
  }
  fs.appendFileSync(
    eng._file(s.id),
    JSON.stringify({ t: 'meta2', bgOf: '', title, at: new Date().toISOString() }) + '\n'
  );
  eng.cache.set(s.id, s);
  return s.id;
}

test('mcpchat: listMcpSessions yalnız Beast MCP oturumlarını listeler, ana sohbetten gizler', () => {
  const eng = makeEngine();
  const a = titledSession(eng, 'Beast MCP', 'mcp sunucusunu kontrol et', 'tamam');
  const b = titledSession(eng, 'Beast MCP', 'ikinci MCP sohbeti');
  titledSession(eng, 'Beast Code', 'kod işi');
  const plain = eng.createSession();

  const items = eng.listMcpSessions();
  const ids = items.map((x) => x.id).sort();
  assert.deepStrictEqual(ids, [a, b].sort(), 'yalnız MCP oturumları döner');
  assert.ok(!ids.includes(plain.id), 'normal sohbet listeye düşmez');

  const first = items.find((x) => x.id === a);
  assert.strictEqual(first.title, 'mcp sunucusunu kontrol et', 'başlık ilk kullanıcı mesajından gelir');
  assert.strictEqual(first.count, 2, 'mesaj sayısı raporlanır');

  const mainIds = eng.listSessions().map((x) => x.id);
  assert.ok(!mainIds.includes(a) && !mainIds.includes(b), 'MCP oturumları ana sohbet listesinde YOK');
});

test('mcpchat: listBcSessions davranışı genelleştirmeden sonra da aynı', () => {
  const eng = makeEngine();
  const bc = titledSession(eng, 'Beast Code', 'bc işi');
  const mcp = titledSession(eng, 'Beast MCP', 'mcp işi');

  const bcItems = eng.listBcSessions();
  assert.deepStrictEqual(bcItems.map((x) => x.id), [bc], 'yalnız Beast Code oturumu');
  assert.ok(!bcItems.some((x) => x.id === mcp), 'MCP oturumu BC listesine karışmaz');
  assert.deepStrictEqual(eng.listMcpSessions().map((x) => x.id), [mcp]);
});

test('mcpchat: başlık yoksa varsayılan ad üretilir, boş liste dayanıklı', () => {
  const eng = makeEngine();
  const empty = eng.listMcpSessions();
  assert.deepStrictEqual(empty, [], 'MCP oturumu yokken boş dizi');

  const id = titledSession(eng, 'Beast MCP', '');
  const it = eng.listMcpSessions().find((x) => x.id === id);
  assert.ok(it, 'oturum listede');
  assert.strictEqual(it.title, 'Beast MCP oturumu', 'boş içerikte varsayılan başlık');
});
