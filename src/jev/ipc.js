'use strict';

/* Beast gömülü JevTrader: IPC kanalları 'jev:' önekiyle kaydedilir.
   Böylece Beast'in kendi ipcMain.handle kanallarıyla çakışma olmaz.
   Olaylar (webContents.send) hedefli gönderilir; önek gerekmez. */

const { ipcMain } = require('electron');

const PREFIX = 'jev:';

module.exports = {
  PREFIX,
  handle: (channel, fn) => ipcMain.handle(PREFIX + channel, fn),
  on: (channel, fn) => ipcMain.on(PREFIX + channel, fn),
};
