'use strict';

/* Dahili tarayıcı preload — Google girişinin "bu tarayıcı veya uygulama
   güvenli olmayabilir" engelini aşar. Electron'da eksik olan gerçek Chrome
   imzaları (window.chrome, navigator.plugins/mimeTypes/languages, webdriver)
   ana dünyada (main world) tamamlanır. Her belge yüklemesinde tekrar koşar. */

const { webFrame } = require('electron');

const PATCH = `(function () {
  try {
    try { Object.defineProperty(navigator, 'webdriver', { get: function () { return false; } }); } catch (e) {}
    try { Object.defineProperty(navigator, 'languages', { get: function () { return ['tr-TR', 'tr', 'en-US', 'en']; } }); } catch (e) {}

    if (!window.chrome) { try { window.chrome = {}; } catch (e) {} }
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function () {},
        installState: function () { return 'not_installed'; },
      };
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
        PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
        PlatformNaclArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        connect: function () {},
        sendMessage: function () {},
      };
    }

    if (navigator.plugins && navigator.plugins.length === 0) {
      var pluginData = [
        { name: 'PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer', type: 'application/pdf', suffixes: 'pdf' },
        { name: 'Chrome PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer', type: 'application/pdf', suffixes: 'pdf' },
        { name: 'Chromium PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer', type: 'application/pdf', suffixes: 'pdf' },
        { name: 'Microsoft Edge PDF Viewer', description: 'Portable Document Format', filename: 'internal-pdf-viewer', type: 'application/pdf', suffixes: 'pdf' },
        { name: 'WebKit built-in PDF', description: 'Portable Document Format', filename: 'internal-pdf-viewer', type: 'application/pdf', suffixes: 'pdf' },
      ];
      var plugins = {
        length: pluginData.length,
        item: function (i) { return this[i] || null; },
        namedItem: function (n) { for (var k in this) { if (this[k] && this[k].name === n) return this[k]; } return null; },
        refresh: function () {},
      };
      pluginData.forEach(function (p, i) {
        var pl = { name: p.name, description: p.description, filename: p.filename, length: 1 };
        pl[0] = { type: p.type, suffixes: p.suffixes, description: p.description, enabledPlugin: pl };
        plugins[i] = pl;
      });
      try { Object.defineProperty(navigator, 'plugins', { get: function () { return plugins; } }); } catch (e) {}
      try {
        var mimes = {
          length: pluginData.length,
          item: function (i) { return (plugins[i] && plugins[i][0]) || null; },
          namedItem: function (n) { for (var k in this) { if (this[k] && this[k].type === n) return this[k]; } return null; },
        };
        pluginData.forEach(function (p, i) { mimes[p.type] = plugins[i] && plugins[i][0]; });
        Object.defineProperty(navigator, 'mimeTypes', { get: function () { return mimes; } });
      } catch (e) {}
    }
  } catch (e) {}
})();`;

try {
  webFrame.executeJavaScript(PATCH).catch(() => {});
} catch {}
