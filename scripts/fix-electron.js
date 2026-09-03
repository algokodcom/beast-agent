'use strict';

/* BEAST — electron binary onarıcı.
   SORUN: `electron` npm paketi binary'yi (dist/electron.exe) postinstall'da
   GitHub'dan indirir. Taze makinalarda bu indirme SESSİZCE başarısız olabilir
   (proxy/GitHub engeli, npm ignore-scripts=true, ağ kesintisi) — paket kurulmuş
   görünür ama `require('electron')` "Electron failed to install correctly" fırlatır.
   ÇÖZÜM: install.js'i elle çalıştır; olmazsa yedek aynadan (npmmirror) dene.
   Kullanım yerleri:
     - package.json postinstall  → kurulumda otomatik (npm i -g beast-agent)
     - bin/beast-agent.js        → her başlatmada bozuksa otomatik onar */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/* electron paket dizini (index.js'in yeri); paket hiç yoksa null */
function electronDir() {
  try {
    return path.dirname(require.resolve('electron'));
  } catch {
    return null;
  }
}

/* binary sağlam mı? electron/index.js'in beklentisiyle aynı kontrol:
   path.txt + dist/<exe> varlığı */
function status() {
  const dir = electronDir();
  if (!dir) return { ok: false, missing: true };
  const exe = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const distOk = fs.existsSync(path.join(dir, 'dist', exe));
  const txtOk = fs.existsSync(path.join(dir, 'path.txt'));
  return distOk && txtOk ? { ok: true, dir } : { ok: false, dir };
}

/* platforma göre dist içindeki çalıştırılabilirin göreli yolu (electron/index.js ile aynı) */
function platformPath() {
  switch (process.platform) {
    case 'win32':
      return 'electron.exe';
    case 'darwin':
    case 'mas':
      return 'Electron.app/Contents/MacOS/Electron';
    default:
      return 'electron';
  }
}

/* onarım — 3 katman:
   0) binary sağlam, yalnız path.txt eksik/bozuk → indirimsiz anında yazar
      (install.js bu durumu "zaten kurulu" sanıp atlayabiliyor)
   1) dist bozuk/eksik → dist'i sil + install.js (GitHub) ile taze indir
   2) GitHub engelli → ELECTRON_MIRROR=npmmirror ile tekrar */
function repair({ quiet } = {}) {
  let st = status();
  if (st.ok) return { ok: true, dir: st.dir, skipped: true };
  if (st.missing) return { ok: false, error: 'electron paketi hi\u00e7 yok — npm install -g beast-agent' };
  const dir = st.dir;
  const exeRel = platformPath();
  const exeAbs = path.join(dir, 'dist', ...exeRel.split('/'));
  const verFile = path.join(dir, 'dist', 'version');
  let wantVer = null;
  try { wantVer = String(require(path.join(dir, 'package.json')).version || ''); } catch {}
  const distIntact =
    fs.existsSync(exeAbs) &&
    (!wantVer ||
      (fs.existsSync(verFile) &&
        fs.readFileSync(verFile, 'utf8').replace(/^v/, '').trim() === wantVer));

  if (distIntact) {
    /* KATMAN 0: hızlı onarım — path.txt'yi kendimiz yazıyoruz (indirim yok) */
    try { fs.writeFileSync(path.join(dir, 'path.txt'), exeRel, 'utf8'); } catch {}
    if (status().ok) return { ok: true, dir, fast: true };
  }

  /* KATMAN 1-2: tam indirim */
  try { fs.rmSync(path.join(dir, 'dist'), { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(path.join(dir, 'path.txt')); } catch {}
  const installJs = path.join(dir, 'install.js');
  if (!fs.existsSync(installJs)) {
    return { ok: false, error: 'install.js yok — yeniden kur: npm install -g beast-agent' };
  }

  const sources = [null, 'https://npmmirror.com/mirrors/electron/'];
  for (let i = 0; i < sources.length; i++) {
    const env = { ...process.env };
    if (sources[i]) {
      env.ELECTRON_MIRROR = sources[i];
      if (!quiet) console.log('  \u2022 varsay\u0131lan kaynak ba\u015Far\u0131s\u0131z \u2014 yedek ayna deneniyor (npmmirror)\u2026');
    } else if (!quiet) {
      console.log('  \u2022 electron binary indiriliyor (ilk sefer ~110 MB, 1-2 dk)\u2026');
    }
    const r = spawnSync(process.execPath, [installJs], {
      cwd: dir,
      env,
      stdio: quiet ? 'ignore' : 'inherit',
      timeout: 600000,
    });
    if (!r.error && r.status === 0 && status().ok) {
      return { ok: true, dir, mirror: sources[i] || 'github' };
    }
    if (!quiet && r.error) {
      console.log('  ! deneme ba\u015far\u0131s\u0131z: ' + String(r.error.message || r.error).slice(0, 160));
    }
  }
  return { ok: false, error: 'electron binary indirilemedi (a\u011f/proxy engeli olabilir)' };
}

module.exports = { electronDir, status, repair };

/* CLI: package.json postinstall → `node scripts/fix-electron.js --soft`
   (her durumda exit 0 — npm install bozulmasın, başlatma anında tekrar denenir)
   elle çağrı → hata durumunda exit 1 */
if (require.main === module) {
  const soft = process.argv.includes('--soft');
  /* npm sitesindeki Install kutusu hep `npm i <isim>` yazar — lokal kurulumda
     `beast-agent` komutu PATH'e girmez ve kullanıcı uygulama başlamadı sanır.
     npm_config_global yalnız `npm i -g` kurulumlarında 'true' gelir → lokalse uyar. */
  const isGlobal =
    String(process.env.npm_config_global || process.env.NPM_CONFIG_GLOBAL || '').trim() === 'true';
  if (soft && !isGlobal) {
    console.log('');
    console.log('\u26A0\uFE0F  Beast Agent bu klas\u00F6re LOKAL kuruldu \u2014 `beast-agent` komutu \u00E7al\u0131\u015Fmaz (PATH\u2019te de\u011Fil).');
    console.log('   Do\u011Fru kurulum (\u00F6nerilen):  npm install -g beast-agent');
    console.log('   Bu klas\u00F6rde denemek:       npx beast-agent');
    console.log('');
  }
  const r = repair({ quiet: false });
  if (r.ok) {
    console.log(r.skipped ? '\u2713 electron binary tamam' : '\u2713 electron binary onar\u0131ld\u0131');
    process.exit(0);
  }
  console.error('\u2717 electron onar\u0131lamad\u0131: ' + (r.error || '?'));
  console.error('  elle \u00e7\u00f6z\u00fcm: npm config set ignore-scripts false');
  console.error('           npm install -g beast-agent');
  process.exit(soft ? 0 : 1);
}
