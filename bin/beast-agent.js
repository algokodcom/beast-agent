#!/usr/bin/env node
'use strict';

/* Beast Agent global npm başlatıcısı:
   `beast-agent`            → uygulamayı detached başlatır, terminali hemen serbest bırakır
   `beast-agent update`     → npm'den en son sürümü yükler (uygulama kapalıyken çalıştır) */

const { spawn, spawnSync } = require('child_process');
const path = require('path');

/* güncelleme modu: çalışan Beast'i kapat (dosya kilidi EBUSY vermesin) → npm güncelle → yeniden başlat */
if (process.argv[2] === 'update') {
  const isWin = process.platform === 'win32';
  console.log('\u27F3 beast-agent g\u00FCncelleniyor\u2026');
  if (isWin) {
    try {
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*beast-agent*' } | Stop-Process -Force"],
        { stdio: 'ignore' });
      console.log('\u2022 \u00E7al\u0131\u015Fan Beast kapat\u0131ld\u0131 (varsa)');
      spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 2'], { stdio: 'ignore' });
    } catch {}
  } else {
    try { spawnSync('pkill', ['-f', 'node_modules/beast-agent'], { stdio: 'ignore' }); } catch {}
  }
  const r = spawnSync('npm', ['install', '-g', 'beast-agent@latest'], { stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    console.log('\n\u2717 g\u00FCncelleme ba\u015Far\u0131s\u0131z \u2014 elle: npm install -g beast-agent@latest');
    process.exit(r.status || 1);
  }
  console.log('\n\u2713 beast-agent g\u00FCncellendi \u2014 uygulama ba\u015Flat\u0131l\u0131yor\u2026');
  try {
    const electron = require('electron');
    if (typeof electron === 'string') {
      spawn(electron, [path.resolve(__dirname, '..')], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {}
  process.exit(0);
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
  /* windowsHide KULLANMA: Chromium ilk pencereyi gizli başlatıyor (tray-only bug) */
});
child.unref();
process.exit(0);
