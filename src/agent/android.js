'use strict';

/* ---------- ANDROID EMÜLATÖR (İSTEĞE BAĞLI — Beast Code mobil önizleme) ----------
   Ayarlardan (Kurulum) görünür; KUR denince arka planda HAFİF set kurar:
     JDK 17 (winget, java yoksa) + Android cmdline-tools (~150MB) +
     platform-tools/emulator + 1 sistem imajı + 1 AVD ("Beast").
   SDK'yı standarda yerleştirir: %LOCALAPPDATA%\Android\Sdk (Android Studio ile
   paylaşımlı konum — kullanıcıda zaten varsa KURULUM YAPMAZ, onu kullanır).
   Beast Code preview akışı: AVD varsa ajan `npx expo start --android` ile
   uygulamayı emülatörde açar (expo AVD'yi adb üzerinden kendisi bulur). */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { emitInstallProgress } = require('./progressbus');

const SDK_DIR = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk');
const CMDTOOLS_URL = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip';
const SYS_IMAGE = 'system-images;android-34;google_apis;x86_64';
const AVD_NAME = 'Beast';

const state = {
  installing: false,
  installFailed: false,
  installError: '',
  stage: '',
  booting: false,
};

function sdkCandidates() {
  const list = [];
  for (const v of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (v && fs.existsSync(v)) list.push(path.resolve(String(v)));
  }
  list.push(SDK_DIR);
  return list.filter((p) => fs.existsSync(p));
}

function findSdk(rel, name) {
  for (const sdk of sdkCandidates()) {
    const p = path.join(sdk, ...rel.split('/'), name);
    if (fs.existsSync(p)) return p;
  }
  /* PATH'te ara (kullanıcı elle kurduysa) */
  try {
    const out = String(execSync(`where ${name}`, { timeout: 5000, stdio: 'pipe', encoding: 'utf8', windowsHide: true }));
    const first = out.split(/\r?\n/).find(Boolean);
    if (first) return String(first).trim();
  } catch {}
  return '';
}

function findAdb() { return findSdk('platform-tools', 'adb.exe'); }

function findEmulator() { return findSdk('emulator', 'emulator.exe'); }

function javaOk() {
  try {
    const out = String(execSync('java -version 2>&1', { timeout: 6000, stdio: 'pipe', encoding: 'utf8', windowsHide: true }));
    const m = /version "?(\d+)/.exec(out);
    return m ? Number(m[1]) >= 17 : false;
  } catch {
    return false;
  }
}

async function listAvds() {
  const emu = findEmulator();
  if (!emu) return [];
  try {
    const out = String(execSync(`"${emu}" -list-avds`, { timeout: 10000, stdio: 'pipe', encoding: 'utf8', windowsHide: true }));
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function probe() {
  const adb = findAdb();
  const emu = findEmulator();
  return {
    sdk: !!(adb && emu),
    sdkPath: sdkCandidates()[0] || '',
    adb,
    emulator: emu,
    installing: state.installing,
    failed: state.installFailed,
    error: state.installError,
    booting: state.booting,
  };
}

/* ---------- ARKA PLAN KURULUM ----------
   Aşamalar (progress bus 'android'): 1 java → 2 cmdline-tools → 3 sdk paketleri
   (en ağır: ~1.4GB) → 4 AVD. Yarıda kalırsa idempotent: yeniden KUR kaldığından değil
   baştan ama varolan parçaları atlar (licenses/paket kontrolü). */
function autoInstall() {
  if (state.installing) return { ok: true, installing: true };
  if (probe().adb && probe().emu) return { ok: true, already: true };
  state.installing = true;
  state.installFailed = false;
  state.installError = '';
  runInstall().catch((e) => {
    state.installing = false;
    state.installFailed = true;
    state.installError = String((e && e.message) || e).slice(0, 160);
  });
  return { ok: true, installing: true };
}

/* .bat çağırıcı: Node güvenlik yaması (CVE-2024-27980) .bat/.cmd'yi shell'siz
   spawn etmeyi EINVAL'le reddeder — cmd.exe /c üzerinden güvenli çağrı */
function spawnBat(bat, args, opts = {}) {
  const cmdline = ['"' + bat + '"']
    .concat(args.map((a) => (/[\s;&|^<>(),!%]/.test(a) ? '"' + a + '"' : a)))
    .join(' ');
  return spawn('cmd.exe', ['/d', '/s', '/c', cmdline], { windowsHide: true, ...opts.spawnOpts });
}

/* .bat çağırıcı (GÜVENLİ PATİKA): Node .bat'i shell'siz spawn etmeyi EINVAL'le
   reddeder; cmd.exe'ye args dizisiyle geçmek de tırnak/redirect kaçışında kırılır.
   ÇÖZÜM: geçici wrapper .bat YAZ (redirect + tırnaklar cmd'nin içine kalır),
   wrapper'ı tek tırnaklı /c ile çalıştır. */
let _batSeq = 0;
function runBat(bat, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const inner = ['"' + bat + '"']
      .concat(args.map((a) => (/[\s;&|^<>(),!%]/.test(a) ? '"' + a + '"' : a)))
      .join(' ') + (opts.redirect ? ' < "' + opts.redirect + '"' : '');
    const wrapper = path.join(os.tmpdir(), 'beast-sdk-' + Date.now() + '-' + (++_batSeq) + '.bat');
    fs.writeFileSync(wrapper, '@echo off\r\n' + inner + '\r\nexit /b %ERRORLEVEL%\r\n', 'utf8');
    /* wrapper'a tüm tırnak/redirect işi bırakılır — .bat spawn için Node shell:true ister */
    const proc = spawn(wrapper, [], { windowsHide: true, shell: true, ...opts.spawnOpts });
    let out = '';
    proc.stdout.on('data', (c) => { out += String(c); opts.onData && opts.onData(String(c)); });
    proc.stderr.on('data', (c) => { out += String(c); });
    proc.on('close', (code) => {
      try { fs.unlinkSync(wrapper); } catch {}
      (code === 0 ? resolve : reject)(code === 0 ? out : new Error(opts.tag + ' exit ' + code + (out ? ' :: ' + out.slice(-300) : '')));
    });
    proc.on('error', (e) => {
      try { fs.unlinkSync(wrapper); } catch {}
      reject(e);
    });
  });
}

async function runInstall() {
  const stage = (pct) => { try { emitInstallProgress('android', { pct }); } catch {} };

  /* 1) JDK 17 (sdkmanager şartı) — java yoksa winget ile */
  stage(3);
  if (!javaOk()) {
    state.stage = 'JDK 17 kuruluyor (winget)';
    await new Promise((resolve, reject) => {
      const proc = spawn('winget', ['install', '--id', 'Microsoft.OpenJDK.17', '--accept-source-agreements', '--accept-package-agreements', '--silent'], { windowsHide: true, shell: true });
      proc.on('close', (code) => (code === 0 || javaOk() ? resolve() : reject(new Error('JDK kurulumu başarısız (winget)'))));
      proc.on('error', () => reject(new Error('winget bulunamadı — JDK 17 elle kur')));
    });
  }
  stage(15);

  /* 2) cmdline-tools indir + aç */
  const toolsBin = path.join(SDK_DIR, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat');
  if (!fs.existsSync(toolsBin)) {
    state.stage = 'cmdline-tools indiriliyor (~150MB)';
    const zipPath = path.join(os.tmpdir(), 'commandlinetools.zip');
    const res = await fetch(CMDTOOLS_URL);
    if (!res.ok) throw new Error('cmdline-tools indirilemedi: HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(SDK_DIR, { recursive: true });
    fs.writeFileSync(zipPath, buf);
    stage(35);
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${SDK_DIR}' -Force"`,
      { timeout: 300000, windowsHide: true, stdio: 'pipe' }
    );
    /* zip içi: cmdline-tools/ → cmdline-tools/latest/ olmalı */
    const inner = path.join(SDK_DIR, 'cmdline-tools');
    if (fs.existsSync(inner) && !fs.existsSync(toolsBin)) {
      fs.renameSync(inner, inner + '_tmp');
      fs.mkdirSync(path.join(SDK_DIR, 'cmdline-tools'), { recursive: true });
      fs.renameSync(inner + '_tmp', path.join(SDK_DIR, 'cmdline-tools', 'latest'));
    }
    try { fs.unlinkSync(zipPath); } catch {}
  }
  stage(45);

  /* 3) lisanslar + paketler (platform-tools + emulator + sistem imajı ~1.3GB)
     Cevaplar stdin spam'iyle DEĞİL dosya redirect'iyle verilir — sdkmanager
     interaktif stdin'i cmd borularında düzgün okumuyor */
  state.stage = 'SDK paketleri iniyor (platform-tools · emulator · sistem imajı)';
  const sysEnv = { ...process.env };
  const yesFile = path.join(os.tmpdir(), 'beast-sdk-yes.txt');
  fs.writeFileSync(yesFile, 'y\n'.repeat(80), 'utf8');
  await runBat(toolsBin, ['--licenses'], {
    tag: 'lisans adımı',
    spawnOpts: { env: sysEnv },
    redirect: yesFile,
  });
  stage(50);
  {
    const pkgs = ['platform-tools', 'emulator', SYS_IMAGE];
    /* GERÇEK PROGRESS: sdkmanager çıktısı "[====    ] 17% Downloading x" biçiminde
       GLOBAL yüzde basar (monotonik artar) — %50-95 aralığına doğrudan eşle */
    let last = 50;
    const lastPercent = /(\d{1,3})%[^%]*$/;
    /* sdkmanager ağ ortasında patlarsa: yarım .temp'i temizle + 3 kere yeniden
       dene (indirilenler korunur — kaldığı yeri hızla atlar) */
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        try { fs.rmSync(path.join(SDK_DIR, '.temp'), { recursive: true, force: true }); } catch {}
        await runBat(toolsBin, pkgs, {
          tag: 'sdkmanager',
          spawnOpts: { env: sysEnv },
          redirect: yesFile,
          onData: (s) => {
            const m = lastPercent.exec(s);
            if (m) {
              const sdkPct = Math.max(0, Math.min(100, Number(m[1])));
              const pct = 50 + sdkPct * 0.45; /* %0→50, %100→95 */
              if (pct > last + 0.4) { last = pct; stage(pct); }
            }
          },
        });
        break;
      } catch (e) {
        if (attempt < 3 && !findAdb()) continue;
        throw e;
      }
    }
  }

  /* 4) AVD yarat */
  stage(96);
  state.stage = 'AVD (emülatör cihazı) oluşturuluyor';
  if (!(await listAvds()).includes(AVD_NAME)) {
    const avdm = path.join(SDK_DIR, 'cmdline-tools', 'latest', 'bin', 'avdmanager.bat');
    const noFile = path.join(os.tmpdir(), 'beast-sdk-no.txt');
    fs.writeFileSync(noFile, 'no\n', 'utf8');
    await runBat(avdm, ['create', 'avd', '-n', AVD_NAME, '-k', SYS_IMAGE, '-d', 'pixel'], {
      tag: 'avdmanager',
      spawnOpts: { env: sysEnv },
      redirect: noFile,
    });
  }
  emitInstallProgress('android', { pct: 100 });
  state.installing = false;
}

/* ---------- EMÜLATÖR BAŞLATMA (uzun ömürlü — kendi penceresi açılır) ---------- */
async function startAvd(name) {
  const emu = findEmulator();
  if (!emu) return { ok: false, error: 'emulator.exe yok — önce Kurulum sekmesinden kur' };
  const target = name || (await listAvds())[0];
  if (!target) return { ok: false, error: 'AVD yok — önce kur' };
  state.booting = true;
  const proc = spawn(emu, ['-avd', target, '-no-snapshot'], { windowsHide: false, detached: false });
  proc.on('exit', () => { state.booting = false; });
  /* boot tamamlanmasını bekleme — arka planda; expo/adb kendisi bekler */
  return { ok: true, avd: target, note: 'emülatör başlatıldı — ilk açılış 30-90 sn sürer' };
}

module.exports = { probe, autoInstall, listAvds, startAvd };
