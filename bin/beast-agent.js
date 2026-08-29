#!/usr/bin/env node
'use strict';

/* Beast Agent global npm başlatıcısı (`beast` kısa adı da aynı scripte bağlı):
   `beast` / `beast-agent`          → uygulamayı detached başlatır, terminali hemen serbest bırakır
   `beast update`                   → npm'den en son sürümü yükler (uygulama kapalıyken çalıştır) */

const { spawn, spawnSync } = require('child_process');
const path = require('path');

/* kaldırma modu: uygulamayı kaldırır ama KİŞİSEL VERİLERİ korur
   (%APPDATA%\beast: config.yaml, .env, oturumlar, hafıza, WhatsApp eşlemesi, yedekler) */
if (process.argv[2] === 'uninstall') {
  const isWin = process.platform === 'win32';
  console.log('Beast Agent kald\u0131r\u0131l\u0131yor\u2026');
  if (isWin) {
    /* çalışan örnekleri kapat */
    try {
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*beast-agent*' } | Stop-Process -Force"],
        { stdio: 'ignore' });
      console.log('\u2022 \u00E7al\u0131\u015Fan Beast kapat\u0131ld\u0131 (varsa)');
    } catch {}
    /* startup kaydını sil — yalnız verisi beast-agent'a işaret ediyorsa */
    try {
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';" +
        "foreach($n in (Get-Item $k -ErrorAction SilentlyContinue).GetValueNames()){" +
        "$v=(Get-ItemProperty $k).$n; if($v -like '*node_modules*beast-agent*'){ Remove-ItemProperty -Path $k -Name $n; Write-Host '• startup kayd\u0131 silindi' } }"],
        { stdio: 'inherit' });
    } catch {}
    /* masaüstü kısayolunu sil (gerçek Masaüstü yolu: OneDrive olabilir) */
    try {
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "$d=[Environment]::GetFolderPath('Desktop'); if(Test-Path \"$d\\Beast Agent.lnk\"){ Remove-Item \"$d\\Beast Agent.lnk\" -Force; Write-Host '\u2022 masa\u00FCst\u00FC k\u0131sayolu silindi' }"],
        { stdio: 'inherit' });
    } catch {}
  } else {
    try { spawnSync('pkill', ['-f', 'node_modules/beast-agent'], { stdio: 'ignore' }); } catch {}
  }
  console.log('\u2022 npm paketi kald\u0131r\u0131l\u0131yor\u2026');
  const ur = spawnSync('npm', ['uninstall', '-g', 'beast-agent'], { stdio: 'inherit', shell: isWin });
  console.log('\n\u2713 Beast Agent kald\u0131r\u0131ld\u0131.');
  console.log('\u2139 Ki\u015Fisel verilerin korundu \u2014 %APPDATA%\\beast');
  console.log('  (config.yaml, .env, oturumlar, haf\u0131za, WhatsApp e\u015Flemesi, \u015Fifreli yedekler)');
  console.log('  Tekrar kurmak i\u00E7in: npm install -g beast-agent');
  process.exit(ur.status || 0);
}

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
  /* dosya kilidi (EBUSY) bazen ilk denemede patlar — 5 deneme hakkı */
  let ok = false;
  for (let i = 1; i <= 5 && !ok; i++) {
    const r = spawnSync('npm', ['install', '-g', 'beast-agent@latest'], { stdio: 'inherit', shell: isWin });
    ok = r.status === 0;
    if (!ok && i < 5) {
      console.log(`  \u2022 deneme ${i}/5 ba\u015Far\u0131s\u0131z (dosya kilidi olabilir) \u2014 3 sn sonra tekrar\u2026`);
      if (isWin) spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 3'], { stdio: 'ignore' });
      else spawnSync('sleep', ['3']);
    }
  }
  if (!ok) {
    console.log('\n\u2717 g\u00FCncelleme ba\u015Far\u0131s\u0131z \u2014 elle: npm install -g beast-agent@latest');
    process.exit(1);
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
