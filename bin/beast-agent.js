#!/usr/bin/env node
'use strict';

/* Beast Agent global npm launcher (`beast` short alias points to the same script):
   `beast` / `beast-agent`          → launches the app detached, frees the terminal immediately
   `beast update`                   → installs the latest version from npm (run while the app is closed) */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/* uninstall mode: removes the app but KEEPS YOUR PERSONAL DATA
   (%APPDATA%\beast: config.yaml, .env, sessions, memory, WhatsApp pairing, backups) */
if (process.argv[2] === 'uninstall') {
  const isWin = process.platform === 'win32';
  console.log('Uninstalling Beast Agent\u2026');
  if (isWin) {
    /* stop running instances */
    try {
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*beast-agent*' } | Stop-Process -Force"],
        { stdio: 'ignore' });
      console.log('\u2022 stopped running Beast instances (if any)');
    } catch {}
    /* remove the startup entry — only if it points to beast-agent */
    try {
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';" +
        "foreach($n in (Get-Item $k -ErrorAction SilentlyContinue).GetValueNames()){" +
        "$v=(Get-ItemProperty $k).$n; if($v -like '*node_modules*beast-agent*'){ Remove-ItemProperty -Path $k -Name $n; Write-Host '\u2022 startup entry removed' } }"],
        { stdio: 'inherit' });
    } catch {}
    /* remove the desktop shortcut (real Desktop path: may be under OneDrive) */
    try {
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "$d=[Environment]::GetFolderPath('Desktop'); if(Test-Path \"$d\\Beast Agent.lnk\"){ Remove-Item \"$d\\Beast Agent.lnk\" -Force; Write-Host '\u2022 desktop shortcut removed' }"],
        { stdio: 'inherit' });
    } catch {}
    /* remove the Start Menu shortcut (Windows AUMID registration) */
    try {
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "$s=Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Beast Agent.lnk'; if(Test-Path $s){ Remove-Item $s -Force; Write-Host '\u2022 Start Menu shortcut removed' }"],
        { stdio: 'inherit' });
    } catch {}
  } else {
    try { spawnSync('pkill', ['-f', 'node_modules/beast-agent'], { stdio: 'ignore' }); } catch {}
  }
  console.log('\u2022 removing the npm package\u2026');
  const ur = spawnSync('npm', ['uninstall', '-g', 'beast-agent'], { stdio: 'inherit', shell: isWin });
  console.log('\n\u2713 Beast Agent uninstalled.');
  console.log('\u2139 Your personal data is preserved \u2014 %APPDATA%\\beast');
  console.log('  (config.yaml, .env, sessions, memory, WhatsApp pairing, encrypted backups)');
  console.log('  To reinstall: npm install -g beast-agent');
  process.exit(ur.status || 0);
}

/* update mode: stop the running Beast (avoid file-lock EBUSY) → update npm (visible progress) → relaunch.
   This command is run by the update button inside a VISIBLE cmd window;
   it also works from a terminal — npm install output streams on screen. */
if (process.argv[2] === 'update') {
  const isWin = process.platform === 'win32';
  console.log('\u27F3 Updating beast-agent\u2026');
  if (isWin) {
    try {
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*beast-agent*' } | Stop-Process -Force"],
        { stdio: 'ignore' });
      console.log('\u2022 stopped running Beast instances (if any)');
    } catch {}
  } else {
    try { spawnSync('pkill', ['-f', 'node_modules/beast-agent'], { stdio: 'ignore' }); } catch {}
  }
  /* file locks (EBUSY) sometimes fail on the first attempt — 5 tries */
  let ok = false;
  for (let i = 1; i <= 5 && !ok; i++) {
    const r = spawnSync('npm', ['install', '-g', 'beast-agent@latest'], { stdio: 'inherit', shell: isWin });
    ok = r.status === 0;
    if (!ok && i < 5) {
      console.log(`  \u2022 attempt ${i}/5 failed (possible file lock) \u2014 retrying in 3s\u2026`);
      if (isWin) spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 3'], { stdio: 'ignore' });
      else spawnSync('sleep', ['3']);
    }
  }
  if (!ok) {
    console.log('\n\u2717 update failed \u2014 manually: npm install -g beast-agent@latest');
    if (isWin) spawnSync('cmd.exe', ['/c', 'pause'], { stdio: 'inherit', shell: false });
    process.exit(1);
  }
  console.log('\n\u2713 beast-agent updated \u2014 launching the app\u2026');
  launchDetached([]);
  if (isWin) spawnSync('cmd.exe', ['/c', 'timeout /t 3'], { stdio: 'ignore' });
  process.exit(0);
}

/* SearXNG: local search engine — install + start in the background (127.0.0.1:8888)
   beast searxng        → install if needed, then start
   beast searxng status → status
   beast searxng stop   → stop */
if (process.argv[2] === 'searxng') {
  require('../src/agent/searxng').cli(process.argv.slice(3)).catch((e) => {
    console.error('\u2717 ' + String((e && e.message) || e));
    process.exit(1);
  });
  return;
}

/* detached launcher + self-healing electron:
   on fresh machines the electron binary download during npm postinstall
   may have silently failed → it is repaired automatically here. */
function launchDetached(extraArgs) {
  let electron = null;
  try { electron = require('electron'); } catch {}
  if (typeof electron !== 'string') {
    let fix = null;
    try { fix = require('../scripts/fix-electron'); } catch {}
    if (fix) {
      console.log('\u27F3 electron runtime files are missing \u2014 repairing automatically\u2026');
      const r = fix.repair({ quiet: false });
      if (r.ok && !r.skipped) console.log('\u2713 electron repaired');
      if (r.ok) {
        try { electron = require('electron'); } catch {}
      }
    }
  }
  if (typeof electron !== 'string') {
    console.log('\n\u2717 Electron runtime could not be installed.');
    console.log('  Manual fix \u2014 run these 2 commands:');
    console.log('    npm config set ignore-scripts false');
    console.log('    npm install -g beast-agent');
    return false;
  }
  const child = spawn(electron, [path.resolve(__dirname, '..'), ...extraArgs], {
    stdio: 'ignore',
    detached: true,
    /* do NOT use windowsHide: Chromium starts the first window hidden (tray-only bug) */
  });
  child.unref();
  return true;
}

if (!launchDetached(process.argv.slice(2))) process.exit(1);
process.exit(0);
