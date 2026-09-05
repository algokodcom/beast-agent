'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const tools = require('../src/agent/tools');

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-git-'));
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'beast@test.local');
  git(dir, 'config', 'user.name', 'Beast Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'merhaba\n');
  return dir;
}

test('gittools: tanımlar TOOLS listesinde', () => {
  const names = tools.definitions.map((d) => d.function.name);
  for (const n of ['git_commit', 'git_diff_review', 'git_pr_create']) assert.ok(names.includes(n), n + ' olmalı');
});

test('gittools: commit paths ile + diff_review doğrulaması', async () => {
  const dir = makeRepo();
  const ctx = { cwd: dir };
  const commit = JSON.parse(await tools.exec('git_commit', { message: 'ilk: a.txt', paths: ['a.txt'] }, ctx));
  assert.strictEqual(commit.ok, true, JSON.stringify(commit));
  assert.match(commit.hash, /^[0-9a-f]{7,40}$/);
  assert.strictEqual(commit.branch, 'main');
  assert.match(commit.stat, /a\.txt/);
  const log = git(dir, 'log', '--oneline');
  assert.match(log, /ilk: a\.txt/);

  /* yeni değişiklik → unstaged diff */
  fs.writeFileSync(path.join(dir, 'a.txt'), 'merhaba dünya\n');
  const d1 = JSON.parse(await tools.exec('git_diff_review', {}, ctx));
  assert.strictEqual(d1.ok, true, JSON.stringify(d1));
  assert.match(d1.diff, /merhaba dünya/);
  assert.ok(d1.status.some((s) => /a\.txt/.test(s)));

  /* staged diff */
  git(dir, 'add', 'a.txt');
  const d2 = JSON.parse(await tools.exec('git_diff_review', { staged: true }, ctx));
  assert.strictEqual(d2.ok, true);
  assert.match(d2.diff, /merhaba dünya/);
  const d3 = JSON.parse(await tools.exec('git_diff_review', {}, ctx));
  assert.match(d3.diff, /fark yok/);

  /* ref karşılaştırma */
  fs.writeFileSync(path.join(dir, 'b.txt'), 'ikinci\n');
  git(dir, 'add', 'b.txt');
  await tools.exec('git_commit', { message: 'ikinci: b.txt' }, ctx);
  const d4 = JSON.parse(await tools.exec('git_diff_review', { ref: 'HEAD~1' }, ctx));
  assert.strictEqual(d4.ok, true, JSON.stringify(d4));
  assert.match(d4.diff, /b\.txt/);

  /* geçersiz ref reddi */
  const d5 = JSON.parse(await tools.exec('git_diff_review', { ref: 'main; rm -rf /' }, ctx));
  assert.strictEqual(d5.ok, false);
});

test('gittools: staged yokken commit reddedilir', async () => {
  const dir = makeRepo();
  const r = JSON.parse(await tools.exec('git_commit', { message: 'boş' }, { cwd: dir }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /commit'lenecek değişiklik yok/);
});

test('gittools: repo dışında hata döner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beast-nogit-'));
  const r = JSON.parse(await tools.exec('git_commit', { message: 'x' }, { cwd: dir }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /git deposu değil/);
});

test('gittools: main dalında PR reddi + mesaj doğrulaması', async () => {
  const dir = makeRepo();
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-m', 'init');
  const r1 = JSON.parse(await tools.exec('git_pr_create', { title: 'PR' }, { cwd: dir }));
  assert.strictEqual(r1.ok, false);
  assert.match(r1.error, /özellik dalı/);
  const r2 = JSON.parse(await tools.exec('git_commit', { message: '' }, { cwd: dir }));
  assert.strictEqual(r2.ok, false);
  const r3 = JSON.parse(await tools.exec('git_pr_create', { title: '' }, { cwd: dir }));
  assert.strictEqual(r3.ok, false);
});

test('gittools: commit\'siz depoda PR — dal okunamadı reddi', async () => {
  const dir = makeRepo();
  const r = JSON.parse(await tools.exec('git_pr_create', { title: 'PR' }, { cwd: dir }));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /dal okunamadı/);
});
