'use strict';

/* electron yer değiştirici:
   - `deps`   : electron'u devDependencies → dependencies taşır (npm publish öncesi;
                global kurulumda electron runtime'ı inmesi için)
   - `devdeps`: geri taşır (electron-builder yalnız devDependencies kabul eder;
                repo normal durumu budur)
   npm lifecycle: prepublishOnly → deps, postpublish → devdeps */

const fs = require('fs');
const path = require('path');

const mode = process.argv[2];
const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const VER = pkg.devDependencies && pkg.devDependencies.electron
  ? pkg.devDependencies.electron
  : (pkg.dependencies && pkg.dependencies.electron);

if (!VER) {
  console.error('electron sürümü package.json içinde bulunamadı');
  process.exit(1);
}

if (mode === 'deps') {
  delete pkg.devDependencies.electron;
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies.electron = VER;
  console.log('electron → dependencies (' + VER + ')');
} else if (mode === 'devdeps') {
  delete pkg.dependencies.electron;
  pkg.devDependencies = pkg.devDependencies || {};
  pkg.devDependencies.electron = VER;
  console.log('electron → devDependencies (' + VER + ')');
} else {
  console.error('kullanım: node scripts/swap-electron.js deps|devdeps');
  process.exit(1);
}

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n');
