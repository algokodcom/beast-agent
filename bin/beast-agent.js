#!/usr/bin/env node
'use strict';

/* Beast Agent global npm başlatıcısı:
   `beast-agent`            → uygulamayı detached başlatır, terminali hemen serbest bırakır
   `beast-agent update`     → npm'den en son sürümü yükler (uygulama kapalıyken çalıştır) */

const { spawn, spawnSync } = require('child_process');
const path = require('path');

/* güncelleme modu: uygulama kapalıyken dosyalar kilitli olmaz */
if (process.argv[2] === 'update') {
  const r = spawnSync('npm', ['install', '-g', 'beast-agent@latest'], { stdio: 'inherit', shell: true });
  console.log(r.status === 0
    ? '\n✓ beast-agent güncellendi — "beast-agent" ile başlatabilirsin.'
    : '\n✗ güncelleme başarısız — elle: npm install -g beast-agent@latest');
  process.exit(r.status || 0);
}

const electron = require('electron');
if (typeof electron !== 'string') {
  /* electron runtime içindeyiz — bu script için anlamsız */
  process.exit(1);
}

const appPath = path.resolve(__dirname, '..');
const child = spawn(electron, [appPath, ...process.argv.slice(2)], {
  stdio: 'ignore',
  detached: true,
  windowsHide: true,
});
child.unref();
process.exit(0);
