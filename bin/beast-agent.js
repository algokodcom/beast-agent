#!/usr/bin/env node
'use strict';

/* Beast Agent global npm başlatıcısı:
   `beast-agent` komutu uygulamayı detached başlatır ve terminali hemen serbest bırakır. */

const { spawn } = require('child_process');
const path = require('path');

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
