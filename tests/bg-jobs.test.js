'use strict';

/* #14 paralel ajanlar + CEO modu testleri (ağ çağrısı yok) */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Engine = require('../src/agent/engine');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-bg-'));
  const events = [];
  const eng = new Engine({}, {
    sessionsDir: dir,
    emit: (ev) => events.push(ev),
  });
  return { eng, events, dir };
}

test('CEO modu varsayılan KAPALI; setCeoMode çalışır', () => {
  const { eng } = tmpEngine();
  assert.strictEqual(eng.ceoMode, false);
  eng.setCeoMode(true);
  assert.strictEqual(eng.ceoMode, true);
  eng.setCeoMode(false);
  assert.strictEqual(eng.ceoMode, false);
});

test('CEO yasaklı araç seti uygulayıcıları kapsar, yönetici araçlarını değil', () => {
  const E = Engine;
  for (const t of ['run_command', 'write_file', 'read_file', 'web_search', 'browser_click', 'computer_act', 'delegate_task']) {
    assert.ok(E.CEO_EXEC_TOOLS.has(t), t);
  }
  for (const t of ['memory_write', 'run_background', 'tasks_list', 'task_status', 'set_reminder']) {
    assert.ok(!E.CEO_EXEC_TOOLS.has(t), t);
  }
  /* arka plan ajanı yönetim araçlarını görmemeli — sonsuz alt dal zinciri olmasın */
  assert.ok(E.BG_HIDDEN_TOOLS.has('run_background'));
});

test('buildSystem CEO modunda CEO bloğu içerir; kapalıyken içermez', () => {
  const { eng } = tmpEngine();
  eng.setCeoMode(true);
  const onSys = eng.buildSystem('merhaba');
  assert.ok(onSys.includes('# CEO MODU'), 'ceo bloğu');
  assert.ok(onSys.includes('PARALEL ajana devret'));
  eng.setCeoMode(false);
  const offSys = eng.buildSystem('merhaba');
  assert.ok(!offSys.includes('# CEO MODU'));
  assert.ok(offSys.includes('delegate_task ile devret'));
});

test('runBackground kayıt açar ve iş hata durumunda error olarak kapanır', async () => {
  const { eng, events } = tmpEngine();
  const r = eng.runBackground('oturum-1', 'klasördeki pdfleri listele', 'PDF Taraması');
  assert.ok(r.ok);
  assert.ok(r.backgroundId);

  let jobs = eng.listBgJobs();
  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0].status, 'running');
  assert.strictEqual(jobs[0].title, 'PDF Taraması');
  assert.ok(jobs[0].task.includes('pdf'));
  assert.strictEqual(jobs[0].parentId, 'oturum-1');

  await sleep(200); // send tetiklenir → model yok → _run error yakalar

  jobs = eng.listBgJobs();
  assert.strictEqual(jobs[0].status, 'error');
  assert.ok(/Model yapılandırılmadı/.test(jobs[0].error || ''), 'hata metni yakalandı: ' + jobs[0].error);
  assert.ok(events.some((e) => e.type === 'agents' && Array.isArray(e.jobs)));
});

test('_execTool tasks_list + task_status + task_cancel yanıt verir', async () => {
  const { eng } = tmpEngine();
  eng.runBackground('p2', 'araştırma görevi', 'Araştırma');
  await sleep(150); // iş biter (error)

  const lst = JSON.parse(await eng._execTool('tasks_list', {}, {}));
  assert.ok(lst.ok && lst.jobs.length >= 1);
  const id = lst.jobs[0].id;

  const det = JSON.parse(await eng._execTool('task_status', { id }, {}));
  assert.ok(det.ok);
  assert.strictEqual(det.job.id, id);
  assert.ok(Array.isArray(det.messages));

  /* çalışan ajan olmadığından cancel false döner */
  const c = JSON.parse(await eng._execTool('task_cancel', { id }, {}));
  assert.strictEqual(c.ok, false);
});

test('bgDetail kod ile de bulunur; mesaj özeti GÖREV/AJAN etiketlidir', async () => {
  const { eng } = tmpEngine();
  const r = eng.runBackground('p3', 'görev metni', 'Kodlu İş');
  await sleep(150);
  const job = eng.listBgJobs()[0];
  const byId = eng.bgDetail(job.id);
  assert.ok(byId.ok);
  const byCode = eng.bgDetail(job.code);
  assert.ok(byCode.ok && byCode.job.id === job.id);
  const missing = eng.bgDetail('XXXXXX99');
  assert.strictEqual(missing.ok, false);
});

/* ---------- superyorizyon (#15) ---------- */

const MIN = 60000;

function fakeJob(over) {
  return {
    status: 'running',
    startedAt: new Date(Date.now() - 10 * MIN).toISOString(),
    lastActivityAt: new Date(Date.now() - 10 * MIN).toISOString(),
    lastNudgeAt: null,
    ...over,
  };
}

test('superviseReason: takılan stuck, uzun koşan iş CEO kontrolü (long), yeni uyarılan null', () => {
  assert.strictEqual(Engine.superviseReason(fakeJob(), Date.now()), 'stuck');

  // süre sınırı KALDIRILDI: aktivite süren uzun iş artık kesilmez → CEO ara kontrolü (long)
  assert.strictEqual(
    Engine.superviseReason(fakeJob({ lastActivityAt: new Date(Date.now() - 30 * 1000).toISOString() }), Date.now()),
    'long'
  );

  assert.strictEqual(
    Engine.superviseReason(fakeJob({ startedAt: new Date(Date.now() - 1 * MIN).toISOString() }), Date.now()),
    null
  ); // henüz çok yeni

  assert.strictEqual(
    Engine.superviseReason(fakeJob({ lastNudgeAt: new Date(Date.now() - 1 * MIN).toISOString() }), Date.now()),
    null
  ); // az önce uyarıldı — cooldown

  assert.strictEqual(Engine.superviseReason(fakeJob({ status: 'done' }), Date.now()), null);
});

test('emit sarmalayıcı ajan olayında lastActivityAt günceller', () => {
  const { eng } = tmpEngine();
  eng.runBackground('pX', 'izleme', 'İz İş');
  const job = eng.listBgJobs()[0];
  /* zaman damgasını yapay eskilt — ms çözünürlüğü eşitliğe düşmesin */
  eng._bgJobs.get(job.id).lastActivityAt = new Date(Date.now() - 5 * MIN).toISOString();
  const eski = eng._bgJobs.get(job.id).lastActivityAt;
  eng.emit({ type: 'tool-start', sessionId: job.id, name: 'run_command', args: {} });
  const sonra = eng._bgJobs.get(job.id).lastActivityAt;
  assert.ok(new Date(sonra) > new Date(eski), 'aktivite tazelendi');
  /* yabancı oturum etkilenmez */
  eng.emit({ type: 'token', sessionId: 'baskasi', delta: 'x' });
  assert.ok(true);
});

test('_supervise önce ajana ÖZ-KURTARMA verir, haklar bitince CEO\'ya uyarır', async () => {
  const { eng } = tmpEngine();
  const r = eng.runBackground('parentOk', 'uzun araştırma', 'Uzun İş');
  const job = eng._bgJobs.get(r.backgroundId);
  job.startedAt = new Date(Date.now() - 10 * MIN).toISOString();
  job.lastActivityAt = job.startedAt;
  eng._supervise();

  /* 1. aşama: kurtarma emri ajanın KENDİ oturumuna düşer — CEO meşgul edilmez */
  const bgS = eng._load(r.backgroundId);
  assert.ok(bgS.messages.some((m) => String(m.content || '').includes('[ÖZ-KURTARMA 1/')), 'ajana öz-kurtarma düştü');
  assert.strictEqual(job.checks, 1);
  assert.strictEqual(job.fixes, 1);
  const s0 = eng._load('parentOk');
  assert.ok(!s0.messages.some((m) => String(m.content || '').includes('[SUPERYORIZON]')), 'CEO daha devreye girmedi');

  /* cooldown: ikinci çağrı hemen tekrar müdahale etmez */
  eng._supervise();
  assert.strictEqual(job.checks, 1);

  /* 2. aşama: öz-kurtarma hakları bitmiş + iş hâlâ koşuyor (aktivite sürüyor,
     süre sınırı yok) → CEO uyarısı ('long') */
  job.status = 'running';
  job.endedAt = null;
  job.fixes = 2;
  job.lastActivityAt = new Date(Date.now() - 30 * 1000).toISOString();
  job.lastNudgeAt = new Date(Date.now() - 5 * MIN).toISOString();
  eng._supervise();
  await sleep(250);

  const s = eng._load('parentOk');
  const got = s.messages.some((m) => String(m.content || '').includes('[SUPERYORIZON] "Uzun İş"'));
  assert.ok(got, 'üst oturuma uyarı düştü');
  assert.strictEqual(job.checks, 2);
});

/* ---------- #17 kalıcı ajan geçmişi ---------- */

test('ajan geçmişi restart sonrası durur; sol listede GİZLİ, kayıt diske yazar; elle silinir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-persist-'));
  const eng1 = new Engine({}, { sessionsDir: dir, emit: () => {} });
  const r = eng1.runBackground('p1', 'masaüstündeki dosyaları listele', 'Tarama İş');

  /* ajan oturumu sol sohbet listesine karışmaz */
  assert.ok(!eng1.listSessions().some((s) => s.id === r.backgroundId), 'sol liste ajan sohbetini göstermez');

  /* uygulama yeniden başlaması: yeni motor örneği aynı dizinden */
  const eng2 = new Engine({}, { sessionsDir: dir, emit: () => {} });
  const jobs = eng2.listBgJobs();
  assert.strictEqual(jobs.length, 1);
  assert.strictEqual(jobs[0].status, 'aborted', 'running → aborted migrasyonu');
  assert.ok(String(jobs[0].error || '').includes('kapatıldı'));

  /* hâlâ sol listede yok */
  assert.ok(!eng2.listSessions().some((s) => s.id === r.backgroundId), 'restart sonrası da gizli');

  /* elle silme: oturum dosyası + iş kaydı birlikte gider, hayalet yazılmaz */
  eng2.deleteSession(r.backgroundId);
  assert.strictEqual(eng2.listBgJobs().length, 0);
  assert.ok(!fs.existsSync(path.join(dir, r.backgroundId + '.jsonl')));
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'bg-jobs.json'), 'utf8'));
  assert.ok(!raw.jobs.some((j) => j.id === r.backgroundId), 'silinen iş diske geri yazılmaz');

  /* gerçek uygulamada tek motor olur; burada eski örneği de uyumlaştır */
  eng1._bgJobs.delete(r.backgroundId);

  /* eski motorun geç tetiklenen send'i kaydı diriltmesin */
  return new Promise((resolve) => setTimeout(resolve, 300)).then(() => {
    const raw2 = JSON.parse(fs.readFileSync(path.join(dir, 'bg-jobs.json'), 'utf8'));
    assert.ok(!raw2.jobs.some((j) => j.id === r.backgroundId), 'geç gelen _bgEmit hayır demedi');
  });
});

/* ---------- #18 fan-out + #5 eşzamanlılık kuyruğu ---------- */

test('fan-out: adımlar aynı grupta açılır, hepsi bitince TEK birleşik rapor düşer', async () => {
  const { eng } = tmpEngine();
  const r = eng.runBackgroundMany(
    'pg',
    [
      { title: 'TR', task: 'tr haberlerini topla' },
      { title: 'DÜNYA', task: 'dünya haberlerini topla' },
      { title: 'EKONOMİ', task: 'ekonomi haberlerini topla' },
    ],
    'Haber Taraması'
  );
  assert.ok(r.ok, 'fan-out başladı');
  assert.strictEqual(r.ids.length, 3);
  const groups = new Set([...eng._bgJobs.values()].map((j) => j.groupId));
  assert.strictEqual(groups.size, 1);
  for (const id of r.ids) await eng.reportBackgroundDone(id);

  const s = eng._load('pg');
  const got = s.messages.some((m) => String(m.content || '').includes('[ARKA PLAN GRUP BİTTİ: 3/3]'));
  assert.ok(got, 'birleşik rapor düştü');
});

test('#5 eşzamanlılık limiti: fazlası kuyrukta bekler, slot boşalınca FIFO başlar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-q-'));
  const eng = new Engine({}, { sessionsDir: dir, emit: () => {}, bgLimit: 2 });
  /* model yok → gerçek _run hata ile derhal bitmesin: gönderimi izlemeye al */
  const sent = [];
  eng.send = (sid, payload) => { sent.push(String(sid)); return true; };
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const r = eng.runBackground('pq', 'iş ' + i, 'İ' + i);
    ids.push(r.backgroundId);
  }
  await sleep(120); // admit zamanlayıcıları
  let st = [...eng._bgJobs.values()].map((j) => j.status).sort();
  assert.deepEqual(st, ['queued', 'queued', 'running', 'running']);
  assert.strictEqual(sent.length, 2);

  /* slot açılır → sıradaki queued iş running olur ve gönderilir */
  eng._bgFinish(ids[0], 'aborted');
  await sleep(30);
  const queued = [...eng._bgJobs.values()].filter((j) => j.status === 'queued').length;
  const running = [...eng._bgJobs.values()].filter((j) => j.status === 'running').length;
  assert.strictEqual(queued, 1);
  assert.strictEqual(running, 2);
  assert.strictEqual(sent.length, 3);
});

/* ---------- /stop anahtarı ---------- */test('stopAll: koşan turları keser, paralel ajanı aborted işaretler', async () => {
  const { eng } = tmpEngine();
  const r = eng.runBackground('pS', 'koşan iş', 'Koşu');
  const id = r.backgroundId;

  /* sahte koşan tur: ctrls'e AbortController koy */
  const c1 = new AbortController();
  const c2 = new AbortController();
  eng.ctrls.set(id, c1);          // paralel ajan
  eng.ctrls.set('main-sid', c2);  // masaüstü oturumu
  /* bekleyen rapor kuyruğu da dolu olsun */
  eng._pendingReports = [{ parentId: 'pS', text: 'eski rapor' }];

  const n = eng.stopAll();

  assert.strictEqual(n, 2);
  assert.ok(c1.signal.aborted && c2.signal.aborted);
  assert.strictEqual(eng._bgJobs.get(id).status, 'aborted');
  assert.ok(eng._bgJobs.get(id).endedAt);
  assert.strictEqual(eng._pendingReports.length, 0);
  /* events'te agents yayını var */
  assert.ok(eng.listBgJobs()[0].status === 'aborted');

  /* ikinci çağrı idempotent: gerçek akışta _run finally ctrl'i siler */
  eng.ctrls.delete(id);
  eng.ctrls.delete('main-sid');
  assert.strictEqual(eng.stopAll(), 0);
});
