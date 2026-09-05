'use strict';

/* Beast App webview köprüsü: app UI'ları (file://) contextBridge üzerinden
   window.beastApp API'sini görür. App kimliği webview src'sindeki ?appid=
   parametresinden okunur; main tarafı id'yi yeniden doğrular. */

const { contextBridge, ipcRenderer } = require('electron');

let appId = '';
try {
  appId = String(new URLSearchParams(window.location.search).get('appid') || '');
} catch {}

contextBridge.exposeInMainWorld('beastApp', {
  id: appId,
  storageGet: (key, dflt) => ipcRenderer.invoke('appui:storage:get', { appId, key, dflt }),
  storageSet: (key, value) => ipcRenderer.invoke('appui:storage:set', { appId, key, value }),
  notify: (text) => ipcRenderer.invoke('appui:notify', { appId, text }),
  info: () => ipcRenderer.invoke('appui:info', appId),
});
