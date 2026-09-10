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

/* ---------- clearTodos (/deltodo) ---------- */

test('clearTodos: listeyi boşaltır, dosyaya boş t:todo yazar, restart sonrası da boş kalır', () => {
  const eng = makeEngine();
  const s = eng.createSession();
  const sid = s.id;
  const items = [
    { title: 'Planla', status: 'active' },
    { title: 'Uygula', status: 'pending' },
    { title: 'Bitir', status: 'done' },
  ];
  /* gerçek todo_write akışı gibi: bellek + dosya */
  eng.todos.set(sid, items);
  fs.appendFileSync(eng._file(sid), JSON.stringify({ t: 'todo', items }) + '\n');

  const r = eng.clearTodos(sid);
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.deepEqual(eng.todos.get(sid), []);

  /* restart benzeti: bellek dışı yeniden yükleme — son t:todo kaydı kazanır */
  eng.cache.delete(sid);
  const reloaded = eng._load(sid);
  assert.deepEqual(reloaded.todos, []);

  /* olmayan oturum reddedilir */
  assert.equal(eng.clearTodos('yok-oturum').ok, false);
});

/* ---------- Beast Finance: skills kataloğu + skill aracı ---------- */

test('finance: sistem promptu SKILLS kataloğunu içerir', () => {
  const eng = makeEngine();
  const s = eng._load(eng.createSession().id);
  s.finance = true;
  s.financeTrader = true;
  const sys = eng.buildFinanceSystem(s);
  assert.ok(sys.includes('# SKILLS'));
  assert.ok(sys.includes('SKILL.md'));
  /* tohumlar kurulu olmalı — katalogda en az bir isim görünür */
  const list = require('../src/agent/skills').scan();
  assert.ok(list.length > 0);
  assert.ok(sys.includes('- ' + list[0].name));
  /* tool yazma + MQL5 yetkileri promptta açıkça verilir */
  assert.ok(sys.includes('YETKİLERİN'));
  assert.ok(sys.includes('skill("tool-yazma")'));
  assert.ok(sys.includes('skill("mql5")'));
  const names = list.map((x) => x.name);
  assert.ok(names.includes('tool-yazma'), 'tool-yazma skill varsayılan tohum olmalı');
  assert.ok(names.includes('mql5'), 'mql5 skill varsayılan tohum olmalı');
  assert.ok(names.includes('price-action') && names.includes('risk-yonetimi') && names.includes('haber-duygu'), 'finans skill tohumları kurulu olmalı');
  /* rol → skill eşleştirmesi prompta gömülür (ayarlar modalından değiştirilebilir) */
  const s2 = eng._load(eng.createSession().id);
  s2.finance = true;
  s2.financeRole = 'technic';
  s2.financeRoleSkills = ['price-action', 'ozel-skill'];
  const sys2 = eng.buildFinanceSystem(s2);
  assert.ok(sys2.includes('skill("price-action")'));
  assert.ok(sys2.includes('skill("ozel-skill")'));
});

/* ---------- payload tool-çifti hizalama (HTTP 400 emniyeti) ---------- */

test('payload hizalama: yetim tool sonucu / cevapsız tool_call temizlenir', () => {
  const msgs = [
    { role: 'user', content: 'soru' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: '1', type: 'function', function: { name: 'a', arguments: '{}' } },
        { id: '2', type: 'function', function: { name: 'b', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: '1', name: 'a', content: '{"ok":true}' },
    { role: 'user', content: '(tur ortası enjeksiyon)' },
    { role: 'tool', tool_call_id: '2', name: 'b', content: '{"ok":true}' }, // kullanıcı bölünce yetim
    { role: 'tool', tool_call_id: '999', name: 'x', content: '{"ok":true}' }, // tam yetim
    { role: 'assistant', content: 'cevap' },
  ];
  const out = Engine._alignToolPairs(msgs);
  const toolsLeft = out.filter((m) => m.role === 'tool');
  assert.equal(toolsLeft.length, 1);
  assert.equal(toolsLeft[0].tool_call_id, '1');
  const a = out.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.equal(a.tool_calls.length, 1);
  assert.equal(a.tool_calls[0].id, '1');
  /* hiç sonucu olmayan assistant → düz metin asistan */
  const plain = Engine._alignToolPairs([
    { role: 'user', content: 'x' },
    {
      role: 'assistant',
      content: 'süreç',
      tool_calls: [{ id: '9', type: 'function', function: { name: 'z', arguments: '{}' } }],
    },
  ]);
  assert.ok(!plain[1].tool_calls);
  assert.equal(plain[1].content, 'süreç');
  /* tool_calls'sız asistandan sonra gelen tool → yetim, düşer */
  const orphan = Engine._alignToolPairs([
    { role: 'assistant', content: 'selam' },
    { role: 'tool', tool_call_id: '5', name: 'q', content: '{"ok":true}' },
    { role: 'user', content: 'devam' },
  ]);
  assert.equal(orphan.length, 2);
  assert.equal(orphan[1].role, 'user');
});

test('skill aracı: katalogdaki SKILL.md gövdesini döndürür', async () => {
  const eng = makeEngine();
  const list = require('../src/agent/skills').scan();
  assert.ok(list.length > 0);
  const r = JSON.parse(await eng._execTool('skill', { name: list[0].name }, null, 's1'));
  assert.equal(r.ok, true);
  assert.equal(r.name, list[0].name);
  assert.ok(r.content.length > 0);
  /* olmayan skill zarif hata verir */
  const bad = JSON.parse(await eng._execTool('skill', { name: 'boyle-skill-yok' }, null, 's1'));
  assert.equal(bad.ok, false);
});

/* ---------- sürekli paralel ajanlar + AJAN DM ---------- */

test('superviseReason: sürekli (continuous) işler denetlenmez', () => {
  const now = Date.now();
  const job = {
    status: 'running',
    continuous: true,
    startedAt: new Date(now - 3600000).toISOString(),
    lastActivityAt: new Date(now - 3400000).toISOString(),
  };
  assert.equal(Engine.superviseReason(job, now), null);
  const normal = {
    status: 'running',
    startedAt: new Date(now - 3600000).toISOString(),
    lastActivityAt: new Date(now - 3400000).toISOString(),
  };
  assert.ok(Engine.superviseReason(normal, now)); // normal iş yine denetlenir
});

test('_bgFinish: sürekli iş done/error ile KAPANMAZ, aborted ile kapanır', () => {
  const eng = makeEngine();
  eng._bgJobs.set('c1', {
    id: 'c1', status: 'running', continuous: true, slot: false,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
  });
  eng._bgFinish('c1', 'done');
  assert.equal(eng._bgJobs.get('c1').status, 'running');
  eng._bgFinish('c1', 'error', 'bir hata');
  assert.equal(eng._bgJobs.get('c1').status, 'running');
  assert.equal(eng._bgJobs.get('c1').errors, 1);
  eng._bgFinish('c1', 'aborted', 'kullanıcı durdurdu');
  assert.equal(eng._bgJobs.get('c1').status, 'aborted');
});

test('DM teslimi: sürekli ajanı UYANDIRMAZ — inbox\'a yazılır (sonsuz DM ping-pong önlenir)', () => {
  const eng = makeEngine();
  const sent = [];
  eng.send = (sid) => { sent.push(String(sid)); return true; };
  eng._bgJobs.set('c1', {
    id: 'c1', status: 'running', continuous: true,
    startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
  });
  eng._bgJobs.set('n1', { id: 'n1', status: 'running', code: 'N1', title: 'Normal' });
  eng._pendingReports = [
    { parentId: 'c1', text: '[AJAN DM] sürekli ajana' },
    { parentId: 'n1', text: '[AJAN DM] normal ajana' },
  ];
  eng.flushPendingReports('c1');
  assert.deepEqual(sent, [], 'sürekli ajan DM ile yeni tur AÇMAMALI');
  assert.deepEqual(eng._bgJobs.get('c1').dmInbox, ['[AJAN DM] sürekli ajana']);
  assert.equal(eng._pendingReports.length, 1, 'normal ajanın raporu kuyrukta kalır');
  eng.flushPendingReports('n1');
  assert.deepEqual(sent, ['n1'], 'normal ajan DM ile uyanır');
});

test('send: sürekli ajan inbox DM\'lerini sıradaki planlı tura enjekte eder', async () => {
  const eng = makeEngine();
  eng._run = async () => {};
  const s = eng._load(eng.createSession().id);
  eng._bgJobs.set(s.id, {
    id: s.id, status: 'running', continuous: true,
    dmInbox: ['[AJAN DM] altın 2400 üstü — dikkat'],
  });
  const ok = eng.send(s.id, { text: 'FINANCE TUR #7: tarama yap.' });
  assert.equal(ok, true);
  assert.deepEqual(eng._bgJobs.get(s.id).dmInbox, [], 'inbox tüketilir');
  const msgs = eng.openSession(s.id).messages;
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(String(last.content).includes('BEKLEYEN AJAN DM'));
  assert.ok(String(last.content).includes('altın 2400 üstü'));
  assert.ok(String(last.content).includes('FINANCE TUR #7'));
});

test('execTool: mt5_* araçları dispatch edilir (unknown tool DEĞİL)', async () => {
  const eng = makeEngine();
  const s = eng._load(eng.createSession().id);
  s.finance = true;
  eng.cache.set(s.id, s);
  /* köprü yok → zarif hata döner ama "unknown tool" ASLA olmamalı
     (finance ajanının işlem açamama hatasının kök nedeni buydu) */
  const r = JSON.parse(await eng._execTool('mt5_status', {}, null, s.id));
  assert.doesNotMatch(String(r.error || ''), /unknown tool/i);
  const r2 = JSON.parse(await eng._execTool('mt5_positions', {}, null, s.id));
  assert.doesNotMatch(String(r2.error || ''), /unknown tool/i);
});

test('agent_dm: tüm koşan ajanlar birbiriyle iletişim kurabilir', async () => {
  const eng = makeEngine();
  eng.flushPendingReports = () => {};
  eng.cache.set('f1', { id: 'f1', finance: true }); // finance ajanı (GOLD işçisi)
  eng.cache.set('c1', { id: 'c1', bgJob: true }); // normal ajan (kod işçisi)
  eng._bgJobs.set('f1', { id: 'f1', code: 'F1', title: 'Finance · GOLD', status: 'running', continuous: true });
  eng._bgJobs.set('c1', { id: 'c1', code: 'C1', title: 'Kod İşçisi', status: 'running' });
  /* finance → finance dışı iş ajanı: SERBEST (sınırsız DM) */
  const out = JSON.parse(await eng._execTool('agent_dm', { to: 'Kod', message: 'merhaba' }, null, 'f1'));
  assert.equal(out.ok, true);
  /* dış ajan finance'e DM atabilir */
  const into = JSON.parse(await eng._execTool('agent_dm', { to: 'GOLD', message: 'durum ne?' }, null, 'c1'));
  assert.equal(into.ok, true);
  /* finance ajanı ANA SOHBETE rapor verebilir (kod ile eşleşme) */
  eng.cache.set('chat1', { id: 'chat1', code: '9KPH3U' });
  const reply = JSON.parse(await eng._execTool('agent_dm', { to: '9KPH3U', message: 'rapor: köprü down, bekliyorum' }, null, 'f1'));
  assert.equal(reply.ok, true);
  assert.equal(reply.to, 'chat1');
  /* TAM BAŞLIKLA eşleşme: ajan DM'den gelen "Beast · KOD" başlığıyla cevap verir */
  const reply2 = JSON.parse(await eng._execTool('agent_dm', { to: 'Beast · 9KPH3U', message: 'tamam, izdeyim' }, null, 'f1'));
  assert.equal(reply2.ok, true);
  assert.equal(reply2.to, 'chat1');
  /* kendine DM: RED */
  const self = JSON.parse(await eng._execTool('agent_dm', { to: 'f1', message: 'selam' }, null, 'f1'));
  assert.equal(self.ok, false);
  /* olmayan hedef zarif hata */
  const noHit = JSON.parse(await eng._execTool('agent_dm', { to: 'boyle-ajan-yok', message: 'x' }, null, 'f1'));
  assert.equal(noHit.ok, false);
});

test('agent_dm: koşan ajanlara DM gider, kayıt kalıcı listeye düşer', async () => {
  const eng = makeEngine();
  eng.flushPendingReports = () => {}; // teslim akışı testin dışında
  eng._bgJobs.set('a1', { id: 'a1', code: 'AAA', title: 'Finance · GOLD', status: 'running', continuous: true });
  eng._bgJobs.set('a2', { id: 'a2', code: 'BBB', title: 'Beast Finance · Trader', status: 'running', continuous: true });
  /* başlık anahtar kelimesiyle hedefleme */
  const r = JSON.parse(await eng._execTool('agent_dm', { to: 'GOLD', message: 'fiyat 2400 üstünde, dikkat' }, null, 'a2'));
  assert.equal(r.ok, true);
  assert.equal(r.to, 'a1');
  const list = eng.agentDmsList();
  assert.equal(list.dms.length, 1);
  assert.equal(list.dms[0].fromTitle, 'Beast Finance · Trader');
  assert.equal(list.dms[0].toTitle, 'Finance · GOLD');
  /* kendine DM reddedilir */
  const self = JSON.parse(await eng._execTool('agent_dm', { to: 'a2', message: 'selam' }, null, 'a2'));
  assert.equal(self.ok, false);
  /* olmayan hedef zarif hata */
  const noHit = JSON.parse(await eng._execTool('agent_dm', { to: 'boyle-ajan-yok', message: 'x' }, null, 'a2'));
  assert.equal(noHit.ok, false);
  /* temizleme */
  eng.agentDmsClear();
});

test('agent_dm: grup sohbeti kurulur, tüm üyelere düşer, iş bitince kapanır', async () => {
  const eng = makeEngine();
  eng.flushPendingReports = () => {};
  eng._bgJobs.set('a1', { id: 'a1', code: 'AAA', title: 'Finance · GOLD', status: 'running', continuous: true });
  eng._bgJobs.set('a2', { id: 'a2', code: 'BBB', title: 'Beast Finance · Trader', status: 'running', continuous: true });
  eng._bgJobs.set('a3', { id: 'a3', code: 'CCC', title: 'Kod İşçisi', status: 'running' });
  /* Trader grubu kurar: hedef GOLD — üye olur, mesaj a3'e düşmez */
  const g1 = JSON.parse(await eng._execTool('agent_dm', { to: 'GOLD', group: 'ALTIN EKİP', message: 'GOLD 2400 üstü — ortak karar: bekleyelim mi?' }, null, 'a2'));
  assert.equal(g1.ok, true);
  assert.equal(g1.group, 'ALTIN EKİP');
  assert.ok(Array.isArray(g1.members) && g1.members.length === 2);
  let list = eng.agentDmsList();
  assert.equal(list.dms.length, 1);
  assert.equal(list.dms[0].group, 'grp:altin ekip');
  assert.equal(list.groups.length, 1);
  assert.equal(list.groups[0].members.length, 2);
  /* GOLD aynı gruba cevap: grup yeniden kullanılır, üye sayısı sabit */
  const g2 = JSON.parse(await eng._execTool('agent_dm', { group: 'Altın Ekip', to: 'Trader', message: 'katılıyorum, 2400 support olsun' }, null, 'a1'));
  assert.equal(g2.ok, true);
  list = eng.agentDmsList();
  assert.equal(list.groups.length, 1);
  assert.equal(list.groups[0].members.length, 2);
  assert.equal(list.dms.length, 2);
  /* to'suz grup mesajı: mevcut gruba herkese düşer */
  const g3 = JSON.parse(await eng._execTool('agent_dm', { group: 'ALTIN EKİP', message: 'son durum: SL güncellendi' }, null, 'a2'));
  assert.equal(g3.ok, true);
  /* a2'nin işi bitti → 1:1 DM'leri kapanır ama grupta a1 hâlâ koşuyor → grup AÇIK kalır */
  eng._bgJobs.get('a2').status = 'done';
  eng._agentDmClose('a2');
  list = eng.agentDmsList();
  assert.equal(list.groups[0].closed, false);
  eng._bgJobs.get('a1').status = 'done';
  eng._agentDmClose('a1');
  list = eng.agentDmsList();
  assert.equal(list.groups[0].closed, true);
  /* temizleme */
  eng.agentDmsClear();
});

test('agent_dm: TEK oturum silinir (agentDmDeleteThread), diğer oturumlar korunur', async () => {
  const eng = makeEngine();
  eng.flushPendingReports = () => {};
  eng._bgJobs.set('a1', { id: 'a1', code: 'AAA', title: 'Finance · GOLD', status: 'running', continuous: true });
  eng._bgJobs.set('a2', { id: 'a2', code: 'BBB', title: 'Kod İşçisi', status: 'running' });
  /* üç ayrı oturum: genel 1:1, konulu 1:1, grup sohbeti */
  const r1 = JSON.parse(await eng._execTool('agent_dm', { to: 'a2', message: 'merhaba' }, null, 'a1'));
  assert.equal(r1.ok, true);
  const r2 = JSON.parse(await eng._execTool('agent_dm', { to: 'a2', message: 'naber', topic: 'Rapor' }, null, 'a1'));
  assert.equal(r2.ok, true);
  const g = JSON.parse(await eng._execTool('agent_dm', { group: 'ALTIN EKİP', to: 'a2', message: 'grup mesajı' }, null, 'a1'));
  assert.equal(g.ok, true);
  assert.equal(eng.agentDmsList().dms.length, 3);
  /* genel oturumu sil → konulu + grup kalır */
  assert.equal(eng.agentDmDeleteThread('a1|a2|(genel)').removed, 1);
  assert.equal(eng.agentDmsList().dms.length, 2);
  assert.equal(eng.agentDmsList().dms[0].topic, 'Rapor');
  /* konu anahtarı küçük harfe normalize edilir */
  assert.equal(eng.agentDmDeleteThread('a1|a2|rapor').removed, 1);
  /* grup oturumu: mesajlar gider, koşan ekip grubunun kaydı KORUNUR */
  assert.equal(eng.agentDmDeleteThread('G|grp:altin ekip').removed, 1);
  assert.ok(eng._agentGroups.get('grp:altin ekip'));
  /* olmayan anahtara dokunulmaz */
  assert.equal(eng.agentDmDeleteThread('x|y|(genel)').removed, 0);
  /* boş key zarif hata */
  assert.equal(eng.agentDmDeleteThread('').ok, false);
  /* temizleme */
  eng.agentDmsClear();
});

test('agent_dm: aynı gruptaki üyelerin 1:1 DM\u2019leri GRUP İÇİNE düşer (ayrı thread\u2019e dağılmaz)', async () => {
  const eng = makeEngine();
  eng.flushPendingReports = () => {};
  eng._bgJobs.set('a1', { id: 'a1', code: 'AAA', title: 'Trader', status: 'running', continuous: true });
  eng._bgJobs.set('a2', { id: 'a2', code: 'BBB', title: 'Risk Ajanı', status: 'running' });
  /* grup kur: a1 mesaj atar, a2 üye olur */
  const g = JSON.parse(await eng._execTool('agent_dm', { group: 'ALTIN EKİP', to: 'a2', message: 'grup kuruldu' }, null, 'a1'));
  assert.equal(g.ok, true);
  /* a2, group VERMEDEN a1'e yazar → mesaj GRUP İÇİNE düşmeli */
  const dm = JSON.parse(await eng._execTool('agent_dm', { to: 'a1', message: 'anlaştık, destek 2400' }, null, 'a2'));
  assert.equal(dm.ok, true);
  assert.equal(dm.group, 'ALTIN EKİP');
  const list = eng.agentDmsList();
  assert.equal(list.dms.length, 2);
  assert.equal(list.dms[1].group, 'grp:altin ekip');
  /* grupta olmayan çift 1:1 kalmaya devam eder */
  eng._bgJobs.set('a3', { id: 'a3', code: 'CCC', title: 'Serbest', status: 'running' });
  const solo = JSON.parse(await eng._execTool('agent_dm', { to: 'a3', message: 'bireysel' }, null, 'a1'));
  assert.equal(solo.ok, true);
  assert.equal(solo.group, undefined);
  const list2 = eng.agentDmsList();
  assert.equal(list2.dms[2].group, undefined);
  /* temizleme */
  eng.agentDmsClear();
});

test('finance ekibi: tüm finance ajanları TEK DM grubuna girer, mesajlar grup içinde toplanır', async () => {
  const eng = makeEngine();
  eng.flushPendingReports = () => {};
  const mk = (id, title) => ({
    id,
    code: id.toUpperCase(),
    title,
    status: 'running',
    continuous: true,
    parentId: '',
    groupId: null,
    dmGroupId: 'team:finance',
    dmGroupTitle: 'Beast Finance EKİP',
  });
  const j1 = mk('f1', 'Beast Finance · Trader');
  const j2 = mk('f2', 'Finance · Risk Ajanı');
  eng._bgJobs.set('f1', j1);
  eng._agentTeamJoin(j1);
  eng._bgJobs.set('f2', j2);
  eng._agentTeamJoin(j2);
  const list = eng.agentDmsList();
  const g = list.groups.find((x) => x.id === 'team:finance');
  assert.ok(g);
  assert.equal(g.title, 'Beast Finance EKİP');
  assert.ok(g.members.includes('f1') && g.members.includes('f2'));
  /* f2 group VERMEDEN f1'e yazar → mesaj GRUP thread'ine düşer */
  const dm = JSON.parse(await eng._execTool('agent_dm', { to: 'f1', message: 'risk raporu: SL eksik' }, null, 'f2'));
  assert.equal(dm.ok, true);
  assert.equal(dm.group, 'Beast Finance EKİP');
  const dms = eng.agentDmsList().dms;
  assert.equal(dms[dms.length - 1].group, 'team:finance');
  /* temizleme */
  eng.agentDmsClear();
});

test('agent_dm: grup adı ekip başlığıyla eşleşirse AYNI grup kullanılır — aynı iş için ikinci grup AÇILMAZ', async () => {
  const eng = makeEngine();
  eng.flushPendingReports = () => {};
  const mk = (id, title) => ({
    id,
    code: id.toUpperCase(),
    title,
    status: 'running',
    continuous: true,
    parentId: '',
    groupId: null,
    dmGroupId: 'team:finance',
    dmGroupTitle: 'Beast Finance EKİP',
  });
  const j1 = mk('f1', 'Beast Finance · Trader');
  const j2 = mk('f2', 'Finance · Risk Ajanı');
  eng._bgJobs.set('f1', j1);
  eng._agentTeamJoin(j1);
  eng._bgJobs.set('f2', j2);
  eng._agentTeamJoin(j2);
  /* f3 henüz gruba katılmadı; başlığı grup adı vererek yazar */
  eng._bgJobs.set('f3', mk('f3', 'Finance · Makro'));
  const r = JSON.parse(
    await eng._execTool('agent_dm', { to: 'Trader', group: 'Beast Finance EKİP', message: 'makro: faiz kararı bekleniyor' }, null, 'f3')
  );
  assert.equal(r.ok, true);
  assert.equal(r.group, 'Beast Finance EKİP');
  const list = eng.agentDmsList();
  assert.equal(list.groups.length, 1, 'aynı iş için ikinci grup açılmamalı');
  assert.equal(list.groups[0].id, 'team:finance');
  assert.ok(list.groups[0].members.includes('f3'), 'yeni ajan aynı gruba katılmalı');
  assert.equal(list.dms[list.dms.length - 1].group, 'team:finance');
  /* ekip dışı iki ajan kendi grubunu kurabilir */
  eng._bgJobs.set('a3', { id: 'a3', code: 'A3', title: 'Serbest A', status: 'running' });
  eng._bgJobs.set('a4', { id: 'a4', code: 'A4', title: 'Serbest B', status: 'running' });
  const r2 = JSON.parse(
    await eng._execTool('agent_dm', { to: 'Serbest B', group: 'ÖZEL GRUP', message: 'ayrı iş' }, null, 'a3')
  );
  assert.equal(r2.ok, true);
  assert.equal(eng.agentDmsList().groups.length, 2);
  /* temizleme */
  eng.agentDmsClear();
});

test('ekip grubu: durdurulmuş üye aktif kadrodan düşer, yeni ajan aynı gruba katılır', () => {
  const eng = makeEngine();
  eng.flushPendingReports = () => {};
  const mk = (id, title) => ({
    id,
    code: id.toUpperCase(),
    title,
    status: 'running',
    continuous: true,
    parentId: '',
    groupId: null,
    dmGroupId: 'team:finance',
    dmGroupTitle: 'Beast Finance EKİP',
  });
  const j1 = mk('f1', 'Beast Finance · Trader');
  const j2 = mk('f2', 'Finance · Risk Ajanı');
  eng._bgJobs.set('f1', j1);
  eng._agentTeamJoin(j1);
  eng._bgJobs.set('f2', j2);
  eng._agentTeamJoin(j2);
  /* f2 durduruldu: job aborted + DM kapanışı → f1 koştuğu için grup açık kalır */
  eng._bgJobs.get('f2').status = 'aborted';
  eng._agentDmClose('f2');
  let g = eng._agentGroups.get('team:finance');
  assert.equal(g.closed, false, 'koşan üye varken grup kapanmaz');
  /* yeni ajan aynı gruba girince durmuş eski üye aktif kadrodan düşer */
  const j3 = mk('f3', 'Finance · Makro');
  eng._bgJobs.set('f3', j3);
  eng._agentTeamJoin(j3);
  g = eng._agentGroups.get('team:finance');
  assert.ok(g.members.includes('f1') && g.members.includes('f3'));
  assert.ok(!g.members.includes('f2'), 'durdurulmuş üye üye listesinde kalmamalı');
  /* son üyeler de durunca grup GEÇMİŞE düşer */
  eng._bgJobs.get('f1').status = 'aborted';
  eng._agentDmClose('f1');
  eng._bgJobs.get('f3').status = 'aborted';
  eng._agentDmClose('f3');
  assert.equal(eng._agentGroups.get('team:finance').closed, true);
});

test('agent_dm: aynı görevdeki paralel ajanlar OTOMATİK ekip grubuna girer (zorunlu)', async () => {
  const eng = makeEngine();
  eng.flushPendingReports = () => {};
  eng._bgJobs.set('a1', { id: 'a1', code: 'AAA', title: 'Site Taşıma #1', task: 'site taşıma', parentId: 'p1', status: 'running' });
  eng._bgJobs.set('a2', { id: 'a2', code: 'BBB', title: 'Site Taşıma #2', task: 'site taşıma', parentId: 'p1', status: 'running' });
  /* a2 başlarken otomatik katılım: a1 + a2 tek grupta */
  eng._agentTeamJoin(eng._bgJobs.get('a2'));
  let list = eng.agentDmsList();
  assert.equal(list.groups.length, 1);
  assert.equal(list.groups[0].title, 'site taşıma EKİP');
  assert.ok(list.groups[0].members.includes('a1') && list.groups[0].members.includes('a2'));
  assert.equal(eng._bgJobs.get('a1').teamGid, 'team:p1');
  assert.equal(eng._bgJobs.get('a2').teamGid, 'team:p1');
  /* katılım postu panelde görünür */
  assert.ok(list.dms.length >= 1);
  assert.equal(list.dms[list.dms.length - 1].group, 'team:p1');
  /* ZORUNLU tartışma: sistem promptu satırı */
  const line = eng._agentTeamPromptLine('team:p1');
  assert.match(line, /ZORUNLU/);
  assert.match(line, /site taşıma EKİP/);
  /* a1 bitirir → kapanış postu; a2 hâlâ koşuyor → grup AÇIK kalır */
  eng._agentTeamPost('team:p1', 'a1', 'Site Taşıma #1', '[EKİP] Site Taşıma #1 görevini TAMAMLADI.');
  eng._bgJobs.get('a1').status = 'done';
  eng._agentDmClose('a1');
  list = eng.agentDmsList();
  assert.equal(list.groups[0].closed, false);
  eng._bgJobs.get('a2').status = 'done';
  eng._agentDmClose('a2');
  list = eng.agentDmsList();
  assert.equal(list.groups[0].closed, true);
  /* restart barışı: açılışta koşan üyesi olmayan gruplar kapatılır */
  eng._agentGroups.forEach((g) => { g.closed = false; delete g.closedAt; });
  eng._agentDmReconcile();
  list = eng.agentDmsList();
  assert.equal(list.groups[0].closed, true);
  eng.agentDmsClear();
});

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
