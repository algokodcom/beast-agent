'use strict';

/* Dışa gönderim güvenlik kapısı: ajanın send_file aracı sır/anahtar
   dosyalarını asla WhatsApp/sohbete göndermesin. Saf fonksiyon —
   electron'a bağımlı değildir, test edilebilir. */

const path = require('path');
const os = require('os');

function norm(p) {
  return String(p || '').replace(/\//g, '\\').toLowerCase();
}

/* true → bu dosya hassas, dışa gönderilmez */
function isSensitiveSendPath(abs, opts = {}) {
  const appData = opts.appData || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const home = opts.home || os.homedir();
  let full;
  try {
    full = norm(path.resolve(String(abs || '')));
  } catch {
    return false;
  }
  if (!full) return false;

  /* Beast veri dizini: settings.json (API key'leri), wa-auth, mcp.json,
     sessions, botlar, tools — tek komutla sızamaz */
  const beastDir = norm(path.join(appData, 'beast'));
  if (full === beastDir || full.startsWith(beastDir + '\\')) return true;

  /* Kimlik/anahtar klasörleri */
  for (const d of ['.ssh', '.aws', '.gnupg', '.docker', '.kube', '.config']) {
    const p = norm(path.join(home, d));
    if (full === p || full.startsWith(p + '\\')) return true;
  }

  const base = path.basename(full);
  if (/^(id_rsa|id_ed25519|id_ecdsa|id_dsa|authorized_keys)(\.pub)?$/.test(base)) return true;
  if (/^\.env(\.|$)/.test(base)) return true;
  if (/\.(pem|key|pfx|p12|keystore|jks|ppk)$/.test(base)) return true;
  if (/^(credentials|creds|secrets?)\.(json|ya?ml|txt)$/.test(base)) return true;
  if (/^(\.npmrc|\.netrc|\.git-credentials|\.htpasswd)$/.test(base)) return true;
  return false;
}

module.exports = { isSensitiveSendPath };
