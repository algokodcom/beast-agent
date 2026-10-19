'use strict';

/* Beast Agent — MOBILE TÜNEL (Faz B): farklı ağlardan Beast Mobile bağlantısı.
   Ev interneti CGNAT arkasındaysa port açma çalışmaz → masaüstünden DIŞARI
   dial-out yapan ngrok tüneli açarız. Telefon wss:// ile bu adrese bağlanır.

   Genel çerçeve:
   - BİRİNCİL YOL: node_modules/ngrok (resmî ngrok CLI agent wrapper, v5 beta).
     Güncel rust agent, Windows'ta numeric addr'ı 'app://...exe upstream'e
     çeviren SDK 1.7 hatalarını taşımaz → upstream mü be 'http://127.0.0.1:port'.
   - YEDEK YOL: @ngrok/ngrok SDK (yoksa/kurulamazsa) — tam URL formu ile.
   - authtoken + ücretsiz statik domain kullanıcıdan (dashboard.ngrok.com).
   - auth yine device.json'daki BEAST-XXXX-XXXX kodu: tünel açılsa da açık değil.
*/

let fwdKind = '';      /* 'cli' | 'sdk' */
let fwd = null;        /* aktif handle (wrapper modülü veya SDK forward objesi) */
let activeUrl = '';    /* aktif public url (cli modunda bizde tutulur) */
let lastError = '';
let desired = null;    /* son denenen { port, authtoken, domain } */

/* Telefona verilecek adres: https://x -> wss://x (ws üstünden gelir) */
function wssUrl(u) {
  const s = String(u || '');
  if (!s) return '';
  return s.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
}

/* dışarı giden gerçek adres (https) — tarayıcı testi için de aynen */
function publicUrl() {
  if (fwdKind === 'cli') return activeUrl;
  try { return (fwd && fwd.url) ? String(fwd.url()) : ''; } catch { return ''; }
}

function status() {
  const url = publicUrl();
  return {
    running: !!fwd && !!url,
    url,
    wss: wssUrl(url),
    error: lastError,
    port: (desired && desired.port) || 0,
    domain: (desired && desired.domain) || '',
    authtokenSet: !!(desired && desired.authtoken),
    mode: fwdKind,
  };
}

/* domain'e şema/yol yapışmışsa temizle — kullanıcı https://x.ngrok-free.dev bile yapıştırabilir */
function cleanDomain(d) {
  let v = String(d || '').trim();
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  v = v.replace(/\/.*$/, '');
  v = v.replace(/^www\./i, '');
  return v;
}

/* YOL 1: ngrok CLI wrapper (v5 agent). url formatında domain bekler. */
async function startViaCli(port, authtoken, domain) {
  const cli = require('ngrok');
  const conf = {
    proto: 'http',
    /* rust agent'a açıkça düz TCP upstream: sembolik app:// hoparlatmaz */
    addr: 'http://127.0.0.1:' + port,
    authtoken,
  };
  if (domain) conf.url = 'https://' + domain;
  const url = await cli.connect(conf);
  if (!url) throw new Error('wrapper url dönmedi');
  fwdKind = 'cli';
  fwd = cli;
  activeUrl = String(url);
  return activeUrl;
}

/* YOL 2 (yedek): @ngrok/ngrok SDK — tam URL addr ile */
async function startViaSdk(port, authtoken, domain) {
  const sdk = require('@ngrok/ngrok');
  const conf = {
    addr: 'http://127.0.0.1:' + port,
    authtoken,
    proto: 'http',
  };
  if (domain) conf.domain = domain;
  fwd = await sdk.forward(conf);
  const url = publicUrl();
  if (!url) throw new Error('SDK url dönmedi');
  fwdKind = 'sdk';
  return url;
}

async function startTunnel(opts) {
  await stopTunnel();
  const port = Number(opts && opts.port) || 8788;
  const authtoken = String((opts && opts.authtoken) || '').trim();
  const domain = cleanDomain(opts && opts.domain);
  desired = { port, authtoken, domain };
  lastError = '';

  if (!authtoken) {
    lastError = 'ngrok authtoken gerekli — dashboard.ngrok.com → Authtoken kopyala';
    return { ok: false, error: lastError };
  }

  let cliErr = null;
  try { /* 1) önce güncel CLI agent */
    const u = await startViaCli(port, authtoken, domain);
    return { ok: true, url: u, wss: wssUrl(u) };
  } catch (e) {
    cliErr = String((e && e.message) || e);
  }
  try { /* 2) SDK yedeği */
    const u = await startViaSdk(port, authtoken, domain);
    return { ok: true, url: u, wss: wssUrl(u) };
  } catch (e) {
    lastError = 'ngrok açılamadı — CLI: ' + cliErr.slice(0, 120) + ' | SDK: ' + String((e && e.message) || e).slice(0, 120);
    fwd = null; fwdKind = '';
    return { ok: false, error: lastError };
  }
}

async function stopTunnel() {
  lastError = '';
  const kind = fwdKind;
  const ref = fwd;
  fwd = null; fwdKind = ''; activeUrl = '';
  try {
    if (kind === 'cli' && ref) { if (ref.disconnect) await ref.disconnect(); if (ref.kill) await ref.kill(); }
    else if (kind === 'sdk' && ref && ref.close) await ref.close();
  } catch {}
}

module.exports = {
  startTunnel,
  stopTunnel,
  status,
  cleanDomain,
  wssUrl,
};
