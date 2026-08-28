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
