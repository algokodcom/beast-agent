'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { isSensitiveSendPath } = require('../src/agent/fsguard');

test('send_file: hassas yollar engellenir, normal dosyalar serbest', () => {
  const o = { home: 'C:\\Users\\test', appData: 'C:\\Users\\test\\AppData\\Roaming' };
  /* Beast veri dizini: settings.json, wa-auth, mcp.json, sessions... */
  assert.equal(isSensitiveSendPath(path.join(o.appData, 'beast', 'settings.json'), o), true);
  assert.equal(isSensitiveSendPath(path.join(o.appData, 'beast', 'wa-auth', 'creds.json'), o), true);
  assert.equal(isSensitiveSendPath(path.join(o.appData, 'beast', 'mcp.json'), o), true);
  /* kimlik klasörleri + desenler */
  assert.equal(isSensitiveSendPath(path.join(o.home, '.ssh', 'id_rsa'), o), true);
  assert.equal(isSensitiveSendPath(path.join(o.home, 'proje', '.env'), o), true);
  assert.equal(isSensitiveSendPath(path.join(o.home, 'proje', '.env.local'), o), true);
  assert.equal(isSensitiveSendPath(path.join(o.home, 'proje', 'server.pem'), o), true);
  assert.equal(isSensitiveSendPath(path.join(o.home, 'proje', 'cert.pfx'), o), true);
  assert.equal(isSensitiveSendPath(path.join(o.home, 'proje', 'credentials.json'), o), true);
  assert.equal(isSensitiveSendPath(path.join(o.home, '.aws', 'credentials'), o), true);
  /* normal dosyalar serbest */
  assert.equal(isSensitiveSendPath(path.join(o.home, 'Belgeler', 'rapor.pdf'), o), false);
  assert.equal(isSensitiveSendPath(path.join(o.home, 'proje', 'src', 'index.js'), o), false);
  assert.equal(isSensitiveSendPath(path.join(o.home, 'Desktop', 'resim.png'), o), false);
});
