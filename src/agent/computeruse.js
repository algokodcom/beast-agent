'use strict';

/* Beast Computer Use (#4): Windows GUI otomasyonu — ekran görüntüsü +
   fare/klavye kontrolü. Ek paket YOK: Electron nativeImage ekranı verir,
   mouse/klavye PowerShell üzerinden user32 API ile sürülür.

   Güvenlik: yalnızca engine araç çağrılarıyla çalışır; koordinat sınırlı,
   hız limiting'li (aksiyon arası min gecikme) ve yazma metni kırpılır.

   KOORDİNAT SÖZLEŞMESİ: computer_look görüntüsü 1280px genişliğe ölçeklenir;
   1280 tabanlı koordinatların GERÇEK ekrana çevrilmesi main.js'teki
   computerActScaled sarmalayıcısında yapılır. Bu modül gerçek koordinat alır. */

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

/** Sanal masaüstü çözünürlüğü (30 sn önbellek: her aksiyonda PS açma maliyeti olmasın) */
let sizeCache = { at: 0, w: 0, h: 0 };
async function screenSize(force) {
  if (!force && sizeCache.w && Date.now() - sizeCache.at < 30000) {
    return { w: sizeCache.w, h: sizeCache.h };
  }
  const out = await ps(
    'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width.ToString() + "x" + [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height'
  );
  const m = out.match(/(\d+)x(\d+)/);
  if (!m) throw new Error('çözünürlük alınamadı');
  sizeCache = { at: Date.now(), w: Number(m[1]), h: Number(m[2]) };
  return { w: sizeCache.w, h: sizeCache.h };
}

/* koordinat kelepçesi: sanal masaüstünde negatif değerler geçerli (sol/üst monitör) */
function clampCoord(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(-32000, Math.min(32000, n));
}

/* computer_look görüntüsü 1280px genişliğe ölçeklenir; modelden gelen 1280
   tabanlı koordinatları GERÇEK ekran koordinatına çevirir (çok monitörde
   ekran ofseti dahil). Saf fonksiyon — test edilebilir. cap:
   { x, y, w, h, imgW, imgH } (main.js captureScreenDataUrl doldurur). */
function scaleArgs(a, cap) {
  const out = { ...(a || {}) };
  if (!cap || !cap.imgW || !cap.imgH) return out;
  const kx = cap.w / cap.imgW;
  const ky = cap.h / cap.imgH;
  for (const key of ['x', 'x2']) {
    if (out[key] != null && out[key] !== '') out[key] = Math.round(cap.x + Number(out[key]) * kx);
  }
  for (const key of ['y', 'y2']) {
    if (out[key] != null && out[key] !== '') out[key] = Math.round(cap.y + Number(out[key]) * ky);
  }
  return out;
}

const MOUSE_CLASS = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
}
"@`;

const LMB_DOWN = 0x0002;
const LMB_UP = 0x0004;
const RMB_DOWN = 0x0008;
const RMB_UP = 0x0010;
const WHEEL = 0x0800;

/* Tek PS sürecinde: imleci taşı + (gerekiyorsa) tık(lar) — eski sürüm her
   adım için ayrı süreç açıyordu (tık başına 2-3 spawn → ~1 sn gecikme). */
function mouseScript({ x, y, down, up, dbl, settleMs = 35 }) {
  const ev = (flags) => `[BMouse]::mouse_event(${flags}, 0, 0, 0, [UIntPtr]::Zero)`;
  let body = '';
  if (x != null && y != null) {
    body += `[BMouse]::SetCursorPos(${x}, ${y}) | Out-Null\nStart-Sleep -Milliseconds ${settleMs}\n`;
  }
  if (down && up) {
    body += `${ev(down)}\nStart-Sleep -Milliseconds 45\n${ev(up)}\n`;
    if (dbl) body += `Start-Sleep -Milliseconds 70\n${ev(down)}\nStart-Sleep -Milliseconds 45\n${ev(up)}\n`;
  }
  return `${MOUSE_CLASS}\n${body}`;
}

/* tek çağrıda tekerlek: eski sürüm |dy|*3 ayrı süreç açıyordu (dy=10 → 30 spawn) */
function wheelScript(x, y, dy) {
  const delta = Math.round(dy * 720); // eski davranış: tik başına ±240 × 3 × dy
  return (
    `${MOUSE_CLASS}\n` +
    `[BMouse]::SetCursorPos(${x}, ${y}) | Out-Null\n` +
    `[BMouse]::mouse_event(${WHEEL}, 0, 0, ${delta}, [UIntPtr]::Zero)\n`
  );
}

/* sürükle-bırak: basılı tut → ara noktalardan geç → bırak */
function dragScript(x1, y1, x2, y2) {
  const steps = 12;
  return (
    `${MOUSE_CLASS}\n` +
    `[BMouse]::SetCursorPos(${x1}, ${y1}) | Out-Null\n` +
    `Start-Sleep -Milliseconds 60\n` +
    `[BMouse]::mouse_event(${LMB_DOWN}, 0, 0, 0, [UIntPtr]::Zero)\n` +
    `for ($i = 1; $i -le ${steps}; $i++) {\n` +
    `  $nx = [int](${x1} + (${x2} - ${x1}) * $i / ${steps})\n` +
    `  $ny = [int](${y1} + (${y2} - ${y1}) * $i / ${steps})\n` +
    `  [BMouse]::SetCursorPos($nx, $ny) | Out-Null\n` +
    `  Start-Sleep -Milliseconds 18\n` +
    `}\n` +
    `Start-Sleep -Milliseconds 40\n` +
    `[BMouse]::mouse_event(${LMB_UP}, 0, 0, 0, [UIntPtr]::Zero)\n`
  );
}

/* pencere başlığına göre öne getir (menü/pencere odaklama için) */
function focusScript(titleB64) {
  return `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class BWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public static IntPtr Found = IntPtr.Zero;
  public static string Needle = "";
  public static bool Cb(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    var t = sb.ToString();
    if (t.Length > 0 && t.IndexOf(Needle, StringComparison.OrdinalIgnoreCase) >= 0) { Found = h; return false; }
    return true;
  }
}
"@
$n = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${titleB64}"))
[BWin]::Needle = $n
[BWin]::EnumWindows([BWin+EnumWindowsProc][BWin]::Cb, [IntPtr]::Zero) | Out-Null
if ([BWin]::Found -ne [IntPtr]::Zero) {
  [BWin]::ShowWindow([BWin]::Found, 9) | Out-Null
  $r = [BWin]::SetForegroundWindow([BWin]::Found)
  if ($r) { 'ok' } else { 'noforeground' }
} else { 'notfound' }
`;
}

/**
 * Aksiyon uygula. op:
 *  click x y            → sol tık
 *  dblclick x y         → çift tık
 *  rightclick x y       → sağ tık
 *  move x y             → imleci taşı
 *  hover x y            → taşı + menü açılsın diye bekle
 *  drag x y x2 y2       → sürükle-bırak
 *  focus title          → başlığı eşleşen pencereyi öne getir
 *  type text            → klavyeyle yaz (pano köprüsü; pano geri yüklenir)
 *  key combo            → "enter", "ctrl+s", "alt+tab", "win" ...
 *  scroll x y dy        → tekerlek (tek çağrı)
 */
async function act(op, args = {}) {
  await pace();
  const x = clampCoord(args.x == null ? 0 : args.x);
  const y = clampCoord(args.y == null ? 0 : args.y);
  switch (op) {
    case 'move':
      await ps(mouseScript({ x, y }));
      return { ok: true };
    case 'hover':
      await ps(mouseScript({ x, y }));
      await sleep(280);
      return { ok: true, at: { x, y } };
    case 'click':
      await ps(mouseScript({ x, y, down: LMB_DOWN, up: LMB_UP }));
      return { ok: true, at: { x, y } };
    case 'dblclick':
      await ps(mouseScript({ x, y, down: LMB_DOWN, up: LMB_UP, dbl: true }));
      return { ok: true, at: { x, y } };
    case 'rightclick':
      await ps(mouseScript({ x, y, down: RMB_DOWN, up: RMB_UP }));
      return { ok: true, at: { x, y } };
    case 'drag': {
      const x2 = clampCoord(args.x2);
      const y2 = clampCoord(args.y2);
      if (x == null || y == null || x2 == null || y2 == null) {
        return { ok: false, error: 'drag için x,y,x2,y2 gerekli' };
      }
      await ps(dragScript(x, y, x2, y2));
      return { ok: true, from: { x, y }, to: { x2, y2 } };
    }
    case 'focus': {
      const title = String(args.title || args.text || '').trim().slice(0, 120);
      if (!title) return { ok: false, error: 'focus için title gerekli' };
      const out = await ps(focusScript(Buffer.from(title, 'utf8').toString('base64')));
      if (out.includes('ok')) return { ok: true, focused: true, title };
      if (out.includes('noforeground')) return { ok: true, focused: false, title, note: 'pencere bulundu ama öne getirilemedi' };
      return { ok: false, error: `pencere bulunamadı: ${title}` };
    }
    case 'type': {
      const text = String(args.text ?? '').slice(0, 2000);
      if (!text) return { ok: false, error: 'boş metin' };
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
      await ps(wheelScript(x || 640, y || 360, dy));
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

/* Unicode güvenli yazım: pano köprüsü. Panoyu ÖNCE kaydet, yapıştırdıktan
   SONRA geri koy — kullanıcının panosu kaybolmaz. */
function buildTyperScript(text) {
  const b64 = Buffer.from(text, 'utf16le').toString('base64');
  return `
$t = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String("${b64}"))
Add-Type -AssemblyName System.Windows.Forms
$prev = $null
try { $prev = [System.Windows.Forms.Clipboard]::GetText() } catch {}
[System.Windows.Forms.Clipboard]::SetText($t)
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 150
if ($prev -ne $null -and $prev -ne "") { try { [System.Windows.Forms.Clipboard]::SetText($prev) } catch {} }
`;
}

/* Tuş kombosu: enter/tab/esc/f1-12, ctrl/alt/shift+x, win vb. */
function buildKeyScript(combo) {
  const map = {
    enter: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
    backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}',
    insert: '{INSERT}', ins: '{INSERT}', capslock: '{CAPSLOCK}',
    home: '{HOME}', end: '{END}', pgup: '{PGUP}', pgdn: '{PGDN}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
    space: ' ',
  };
  let out = '';
  const parts = String(combo).toLowerCase().split('+').map((p) => p.trim());
  let mods = '';
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') mods += '^';
    else if (p === 'alt') mods += '%';
    else if (p === 'shift') mods += '+';
    else if (p === 'win') mods += '^{ESC}';
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
  await ps(mouseScript({ x: clampCoord(x), y: clampCoord(y) }));
}

/* down+up tek script'te */
async function clickSimple(button) {
  await ps(mouseScript({ down: button === 'right' ? RMB_DOWN : LMB_DOWN, up: button === 'right' ? RMB_UP : LMB_UP }));
}

/* ---------- GÖRSEL DOĞRULAMA (verify) ----------
   "Aksiyon işe yaradı mı?" sorusunu ucuz bir görsel parmak iziyle yanıtlar:
   kareyi 8x6 hücreye bölüp her hücrenin ortalama parlaklığını çıkarır.
   İki imza arasındaki fark > eşik olan hücre oranı = değişim oranı.
   Animasyon/anti-alias gürültüsüne toleranslıdır (eşik 8/255). */
function bitmapSignature(bmp, w, h) {
  try {
    if (!bmp || !w || !h) return null;
    const cells = [];
    const cw = Math.max(1, Math.floor(w / 8));
    const ch = Math.max(1, Math.floor(h / 6));
    for (let cy = 0; cy < 6; cy++) {
      for (let cx = 0; cx < 8; cx++) {
        let sum = 0;
        let n = 0;
        for (let y = cy * ch; y < Math.min(h, (cy + 1) * ch); y += 2) {
          for (let x = cx * cw; x < Math.min(w, (cx + 1) * cw); x += 2) {
            const o = (y * w + x) * 4;
            sum += 0.114 * bmp[o] + 0.587 * bmp[o + 1] + 0.299 * bmp[o + 2];
            n++;
          }
        }
        cells.push(n ? sum / n : 0);
      }
    }
    return cells;
  } catch {
    return null;
  }
}

function signatureDiff(a, b, thresh = 8) {
  if (!a || !b || a.length !== b.length || !a.length) return null;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > thresh) changed++;
  return changed / a.length;
}

module.exports = { act, screenSize, scaleArgs, bitmapSignature, signatureDiff, clickSimple, mouseMove };
