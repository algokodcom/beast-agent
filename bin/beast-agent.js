#!/usr/bin/env node
'use strict';

/* Beast Agent global npm başlatıcısı (`beast` kısa adı da aynı scripte bağlı):
   `beast` / `beast-agent`          → uygulamayı detached başlatır, terminali hemen serbest bırakır
   `beast update`                   → npm'den en son sürümü yükler (uygulama kapalıyken çalıştır) */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

/* güncelleme modu: çalışan Beast'i kapat (dosya kilidi EBUSY vermesin) → npm güncelle → yeniden başlat.
   npm install DETACHED çalışır: terminali/uygulamayı kapatmak update'i boğmaz. */
if (process.argv[2] === 'update') {
  const isWin = process.platform === 'win32';
  console.log('\u27F3 beast-agent g\u00FCncelleniyor\u2026 (arka planda s\u00FCrer — bu pencereyi kapabilirsin)');
  if (isWin) {
    try {
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*beast-agent*' } | Stop-Process -Force"],
        { stdio: 'ignore' });
      console.log('\u2022 \u00E7al\u0131\u015Fan Beast kapat\u0131ld\u0131 (varsa)');
    } catch {}
    /* detached PS helper: npm install (5 deneme) + electron.exe ile yeniden başlatma */
    const ps = [
      "$ErrorActionPreference = 'Continue'",
      "$Log = Join-Path $env:APPDATA 'beast\\update.log'",
      "function L([string]$m) { try { Add-Content -LiteralPath $Log -Value (\"[\" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + \"] \" + $m) } catch {} }",
      "L '=== beast update (terminal) basladi ==='",
      "$ok = $false",
      "for ($i = 1; $i -le 5 -and -not $ok; $i++) {",
      "  L \"npm install -g beast-agent@latest (deneme $i)\"",
      "  & npm.cmd install -g beast-agent@latest 2>&1 | ForEach-Object { L \"  npm: $_\" }",
      "  if ($LASTEXITCODE -eq 0) { $ok = $true } else { Start-Sleep -Seconds 3 }",
      "}",
      "if (-not $ok) { L 'HATA: npm install basarisiz'; exit 1 }",
      "L 'npm install tamam - yeniden baslatma'",
      "$prefix = Join-Path $env:APPDATA 'npm'",
      "$appDir = Join-Path $prefix 'node_modules\\beast-agent'",
      "$exe = Join-Path $appDir 'node_modules\\electron\\dist\\electron.exe'",
      "if (-not (Test-Path $exe)) { $exe = Join-Path $prefix 'node_modules\\electron\\dist\\electron.exe' }",
      "Start-Process -FilePath $exe -ArgumentList ('\"' + $appDir + '\"')",
      "L '=== beast update bitti ==='",
    ].join('\r\n');
    const os = require('os');
    const psFile = path.join(os.tmpdir(), 'beast-update-helper.ps1');
    fs.writeFileSync(psFile, ps, 'utf8');
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    console.log('\u2022 npm install arka planda s\u00FCr\u00FCyor (2-4 dk) \u2014 bitince uygulama kendili\u011Finden a\u00E7\u0131l\u0131r');
    console.log('  durum: %APPDATA%\\beast\\update.log');
    process.exit(0);
  }
  try { spawnSync('pkill', ['-f', 'node_modules/beast-agent'], { stdio: 'ignore' }); } catch {}
  const sh =
    'ok=0; for n in 1 2 3 4 5; do npm install -g beast-agent@latest && ok=1 && break; sleep 3; done; ' +
    'if [ $ok -eq 1 ]; then nohup beast-agent >/dev/null 2>&1 & fi';
  spawn('sh', ['-c', sh], { detached: true, stdio: 'ignore' }).unref();
  console.log('\u2022 arka planda s\u00FCr\u00FCyor \u2014 bitince uygulama a\u00E7\u0131l\u0131r');
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
