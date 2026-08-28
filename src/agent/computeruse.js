'use strict';

/* Beast Computer Use (#4): Windows GUI otomasyonu — ekran görüntüsü +
   fare/klavye kontrolü. Ek paket YOK: Electron nativeImage ekranı verir,
   mouse/klavye PowerShell üzerinden user32 API ile sürülür.

   Güvenlik: yalnızca engine araç çağrılarıyla çalışır; koordinat sınırlı,
   hız limiting'li (aksiyon arası min gecikme) ve yazma metni kırpılır. */

const { execFile } = require('child_process');

/* aksiyonlar arası minimum boşluk — wx'i art arda tıklarla donatmamak için */
let lastActionAt = 0;
function pace() {
  const wait = 120 - (Date.now() - lastActionAt);
  lastActionAt = Date.now();
  if (wait > 0) return new Promise((r) => setTimeout(r, wait));
  return Promise.resolve();
}

function ps(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 20000, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || '').trim()))
    );
  });
}

/** Sanal masaüstü çözünürlüğü */
async function screenSize() {
  const out = await ps(
    'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width.ToString() + "x" + [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height'
  );
  const m = out.match(/(\d+)x(\d+)/);
  if (!m) throw new Error('çözünürlük alınamadı');
  return { w: Number(m[1]), h: Number(m[2]) };
}

/**
 * Aksiyon uygula. op:
 *  click x y            → sol tık
 *  dblclick x y         → çift tık
 *  rightclick x y       → sağ tık
 *  move x y             → imleci taşı
 *  type text            → klavyeyle yaz (Unicode destekli, SendInput WM_CHAR benzeri)
 *  key combo            → "enter", "ctrl+s", "alt+tab", "win" ...
 *  scroll dx dy         → tekerlek
 */
async function act(op, args = {}) {
  await pace();
  const x = Math.max(0, Math.round(Number(args.x) || 0));
  const y = Math.max(0, Math.round(Number(args.y) || 0));
  switch (op) {
    case 'move':
      await mouseMove(x, y);
      return { ok: true };
    case 'click':
      await mouseMove(x, y);
      await clickSimple('left');
      return { ok: true, at: { x, y } };
    case 'dblclick':
      await mouseMove(x, y);
      await clickSimple('left');
      await sleep(70);
      await clickSimple('left');
      return { ok: true, at: { x, y } };
    case 'rightclick':
      await mouseMove(x, y);
      await clickSimple('right');
      return { ok: true, at: { x, y } };
    case 'type': {
      const text = String(args.text ?? '').slice(0, 2000);
      if (!text) return { ok: false, error: 'boş metin' };
      /* Add-Type SendInput tabanlı Unicode typer */
      await ps(buildTyperScript(text));
      return { ok: true, chars: text.length };
    }
    case 'key': {
      const combo = String(args.combo || args.key || '').trim().slice(0, 40);
      if (!combo) return { ok: false, error: 'tuş gerekli' };
      await ps(buildKeyScript(combo));
      return { ok: true, key: combo };
    }
    case 'scroll': {
      const dy = Math.max(-10, Math.min(10, Math.round(Number(args.dy) || 0)));
      if (!dy) return { ok: false, error: 'dy gerekli (-10..10)' };
      await mouseMove(x || 640, y || 360);
      const clicks = Math.abs(dy) * 3;
      for (let i = 0; i < clicks; i++) {
        await wheel(dy > 0 ? 1 : -1); // pozitif dy = aşağı
      }
      return { ok: true, dy };
    }
    default:
      return { ok: false, error: `bilinmeyen op: ${op}` };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------- PowerShell snippet üreticileri ---------- */

const MOUSE_MOVE_TPL = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BM {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
}
"@
[BM]::SetCursorPos(%%X%%, %%Y%%) | Out-Null
`;

const WHEEL_TPL = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BW {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
[BW]::mouse_event(0x0800, 0, 0, %%DELTA%%, [UIntPtr]::Zero)
`;

/* Unicode güvenli yazım: SendInput yerine pano + Ctrl+V fallback'u en sağlamı.
   Panoyu geri yüklemek yerine tek seferlik kullanıp bırakıyoruz (hız öncelik). */
function buildTyperScript(text) {
  const b64 = Buffer.from(text, 'utf16le').toString('base64');
  return `
$t = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("${b64}"))
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText($t)
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait("^v")
`;
}

/* Tuş kombosu: enter/tab/esc/f1-12, ctrl/alt/shift+x, win vb. */
function buildKeyScript(combo) {
  const map = {
    enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
    backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}',
    home: '{HOME}', end: '{END}', pgup: '{PGUP}', pgdn: '{PGDN}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    space: ' ', win: '^({ESC})',
  };
  let out = '';
  const parts = String(combo).toLowerCase().split('+').map((p) => p.trim());
  let mods = '';
  for (const p of parts) {
    if (p === 'ctrl') mods += '^';
    else if (p === 'alt') mods += '%';
    else if (p === 'shift') mods += '+';
    else if (p === 'win') out += ''; // win ayrı ele
    else if (/^f\d{1,2}$/.test(p)) out += '{' + p.toUpperCase() + '}';
    else if (map[p]) out += map[p];
    else out += p.slice(0, 1).toUpperCase(); // tek harf/tuş
  }
  const seq = mods && out ? mods + '(' + out + ')' : mods + out;
  const b64 = Buffer.from(seq, 'utf16le').toString('base64');
  return `
$s = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("${b64}"))
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait($s)
`;
}

async function mouseMove(x, y) {
  await ps(MOUSE_MOVE_TPL.replace(/%%X%%/g, String(x)).replace(/%%Y%%/g, String(y)));
}

/* down+up tek script'te — karışık replace zinciri yerine bu kullanılır */
async function clickSimple(button) {
  const down = button === 'right' ? 0x0008 : 0x0002;
  const up = button === 'right' ? 0x0010 : 0x0004;
  await ps(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BC2 {
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
[BC2]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 45
[BC2]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)
`);
}

async function wheel(dir) {
  const delta = dir < 0 ? -240 : 240; // WHEEL_DELTA=120 katları; negatif=yukarı görüntüde aşağı kayar bazı app'lerde
  await ps(WHEEL_TPL.replace(/%%DELTA%%/g, String(delta)));
}

module.exports = { act, screenSize, clickSimple, mouseMove };
