'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const cron = require('../src/cron');

test('geçersiz cron ifadeleri reddedilir', () => {
  assert.equal(cron.parseCron('* * * *'), null);
  assert.equal(cron.parseCron('61 * * * *'), null);
  assert.equal(cron.parseCron('* 25 * * *'), null);
  assert.equal(cron.parseCron('a b c d e'), null);
});

test('geçerli cron ifadeleri ayrışır', () => {
  assert.ok(cron.parseCron('* * * * *'));
  assert.ok(cron.parseCron('*/15 * * * *'));
  assert.ok(cron.parseCron('0 9 * * 1-5'));
  assert.ok(cron.parseCron('30 21 1,15 * *'));
});

/* Sabit tarih: 2026-08-25 Salı 10:00 */
function at(min, h, day, mon) {
  return new Date(2026, mon - 1, day, h, min, 0);
}

test('nextRunFrom sıradaki uyarın anını bulur', () => {
  // Her saat başı: 10:00'dan sonraki = 11:00
  const n = new Date(cron.nextRunFrom('0 * * * *', at(0, 10, 25, 8)));
  assert.equal(n.getHours(), 11);
  assert.equal(n.getMinutes(), 0);

  // Günlük 09:00: salı 10:00'dan sonra → çarşamba 09:00
  const d = new Date(cron.nextRunFrom('0 9 * * *', at(0, 10, 25, 8)));
  assert.equal(d.getDate(), 26);
  assert.equal(d.getHours(), 9);

  // Hafta içi (Pzt-Cum): salıdan sonraki aynı gün 21:00
  const w = new Date(cron.nextRunFrom('0 21 * * 1-5', at(30, 20, 25, 8)));
  assert.equal(w.getDay(), 2); // salı
  assert.equal(w.getHours(), 21);
});

test('add: bozuk schedule reddedilir, düzgün olan nextRun alır', () => {
  const bad = cron.add({ name: 'x', schedule: 'yok', prompt: 'p' });
  assert.equal(bad.ok, false);
  const good = cron.add({ name: 'deneme', schedule: '*/5 * * * *', prompt: 'saati söyle' });
  assert.equal(good.ok, true);
  assert.ok(good.job.nextRunAt > Date.now());
  assert.equal(cron.list().some((j) => j.id === good.job.id), true);
});

test('toggle + remove çalışır', () => {
  const r = cron.add({ name: 't2', schedule: '0 12 * * *', prompt: 'p' });
  const id = r.job.id;
  const t = cron.toggle(id);
  assert.equal(t.job.enabled, false);
  assert.equal(t.job.nextRunAt, null);
  assert.equal(cron.remove(id).ok, true);
});

/* ---------- reminderSchedule: tekrarlı hatırlatma ---------- */

test('reminderSchedule: presetler when\u0027den saat üretir', () => {
  // 2026-08-26 Çarşamba 09:00
  const w = '2026-08-26T09:00';

  const daily = cron.reminderSchedule(w, 'daily');
  assert.equal(daily.ok, true);
  assert.equal(daily.schedule, '0 9 * * *');

  const weekdays = cron.reminderSchedule(w, 'weekdays');
  assert.equal(weekdays.schedule, '0 9 * * 1-5');

  const weekly = cron.reminderSchedule(w, 'weekly');
  assert.equal(weekly.schedule, '0 9 * * 3'); // çarşamba

  const monthly = cron.reminderSchedule(w, 'monthly');
  assert.equal(monthly.schedule, '0 9 26 * *');

  // dakika korunmalı
  const dm = cron.reminderSchedule('2026-08-26T09:30', 'daily');
  assert.equal(dm.schedule, '30 9 * * *');
});

test('reminderSchedule: doğrudan cron kabul, bozuk ve bilinmeyen reddedilir', () => {
  const raw = cron.reminderSchedule(null, '*/30 * * * *');
  assert.equal(raw.ok, true);
  assert.equal(raw.schedule, '*/30 * * * *');

  assert.equal(cron.reminderSchedule('2026-08-26T09:00', '').ok, false);
  assert.equal(cron.reminderSchedule('2026-08-26T09:00', 'hergun').ok, false);
  assert.equal(cron.reminderSchedule('zaman değil', 'daily').ok, false);
  assert.equal(cron.reminderSchedule(null, '61 * * * *').ok, false);
});

/* ---------- reconcile: bayat tek-seferlik hatırlatma temizliği ---------- */

test('reconcile: bayat once job düşer (gelecek yıla kurulmaz), grace içindeki gecikmeli fire edilir', () => {
  const now = new Date(2026, 8, 9, 12, 0, 0).getTime(); // 2026-09-09 12:00
  const stale = { id: 's1', name: 'Hatırlatma: eski', schedule: '0 9 1 1 *', prompt: 'p', once: true, enabled: true, nextRunAt: new Date(2026, 0, 1, 9, 0).getTime() };
  const late = { id: 's2', name: 'Hatırlatma: yeni', schedule: '0 9 9 9 *', prompt: 'p', once: true, enabled: true, nextRunAt: new Date(2026, 8, 9, 11, 30).getTime() }; // 30 dk önce
  const future = { id: 's3', name: 'Hatırlatma: gelecek', schedule: '0 9 10 9 *', prompt: 'p', once: true, enabled: true, nextRunAt: now + 3600000 };
  const repeating = { id: 'r1', name: 'görev', schedule: '0 9 * * *', prompt: 'p', once: false, enabled: true, nextRunAt: new Date(2026, 8, 8, 9, 0).getTime() }; // dün
  const disabled = { id: 'd1', name: 'kapalı', schedule: '0 9 * * *', prompt: 'p', once: false, enabled: false, nextRunAt: null };

  const r = cron.reconcile([stale, late, future, repeating, disabled], now, cron.ONCE_GRACE_MS);
  const ids = r.jobs.map((j) => j.id);
  assert.equal(ids.includes('s1'), false); // bayat: sessizce silindi
  assert.equal(ids.includes('s2'), false); // grace içinde: fire listesinde
  assert.equal(ids.includes('s3'), true);  // gelecek: korundu
  assert.equal(ids.includes('d1'), true);  // kapalı: korundu
  assert.equal(ids.includes('r1'), true);  // tekrarlı: korundu
  const rep = r.jobs.find((j) => j.id === 'r1');
  assert.ok(rep.nextRunAt > now); // sonraki çalışma yeniden hesaplandı
  assert.deepEqual(r.fire.map((j) => j.id), ['s2']);
});

test('removeIf: koşula uyan görevleri toplu siler, kind alanı saklanır', () => {
  const a = cron.add({ name: 'Hatırlatma: çay', schedule: '0 9 * * *', prompt: '[HATIRLATMA ZAMANI] çay iç', kind: 'reminder' });
  assert.equal(a.ok, true);
  assert.equal(a.job.kind, 'reminder');
  cron.add({ name: 'rapor', schedule: '0 18 * * 1-5', prompt: 'rapor hazırla' });
  const r = cron.removeIf((j) => j.kind === 'reminder');
  assert.equal(r.count, 1);
  assert.equal(cron.list().some((j) => j.name === 'rapor'), true);
  assert.equal(cron.list().some((j) => j.kind === 'reminder'), false);
});
