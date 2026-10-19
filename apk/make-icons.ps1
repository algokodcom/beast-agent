# Beast Mobile - ikon ve splash uretimi
#   powershell -ExecutionPolicy Bypass -File .\make-icons.ps1
# Kaynak: ../assets/logo.png  (512x512, siyaha kare + beyaz kurt)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$Root  = Split-Path -Parent $PSScriptRoot
$Logo  = Join-Path $Root 'assets\logo.png'
$Res   = Join-Path $PSScriptRoot 'android\app\src\main\res'

if (-not (Test-Path $Logo)) { throw "logo.png bulunamadi: $Logo" }

$src = [System.Drawing.Bitmap]::FromFile($Logo)
$W = $src.Width; $H = $src.Height
Write-Output ("kaynak logo: {0}x{1}" -f $W, $H)

# ---------------------------------------------------------------- piksel oku
$rect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
$lock = $src.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($lock.Stride * $H)
[System.Runtime.InteropServices.Marshal]::Copy($lock.Scan0, $bytes, 0, $bytes.Length)
$src.UnlockBits($lock)
$stride = $lock.Stride

# ------------------------------------- kurt maskesi (beyaz, siyah -> saydam)
$wolfBytes = New-Object byte[] ($stride * $H)
$minX = $W; $maxX = -1; $minY = $H; $maxY = -1
for ($y = 0; $y -lt $H; $y++) {
  $row = $y * $stride
  for ($x = 0; $x -lt $W; $x++) {
    $i = $row + $x * 4
    if ($bytes[$i + 3] -lt 128) { continue }
    $b = $bytes[$i]; $g = $bytes[$i + 1]; $r = $bytes[$i + 2]
    $lum = [int](0.299 * $r + 0.587 * $g + 0.114 * $b)
    if ($lum -le 6) { continue }
    $wolfBytes[$i] = 255; $wolfBytes[$i + 1] = 255; $wolfBytes[$i + 2] = 255
    $wolfBytes[$i + 3] = [byte]([Math]::Min(255, $lum))
    if ($x -lt $minX) { $minX = $x }
    if ($x -gt $maxX) { $maxX = $x }
    if ($y -lt $minY) { $minY = $y }
    if ($y -gt $maxY) { $maxY = $y }
  }
}
$wolf = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$lock2 = $wolf.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
[System.Runtime.InteropServices.Marshal]::Copy($wolfBytes, 0, $lock2.Scan0, $wolfBytes.Length)
$wolf.UnlockBits($lock2)
$bw = $maxX - $minX + 1; $bh = $maxY - $minY + 1
Write-Output ("kurt alani: {0}x{1} @ ({2},{3})" -f $bw, $bh, $minX, $minY)
$src.Dispose()

function New-Gfx($bmp) {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.CompositingQuality= [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  return $g
}

# ------------------------------------------------------ adaptive foreground
function New-Foreground([int]$S) {
  $bmp = New-Object System.Drawing.Bitmap $S, $S, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = New-Gfx $bmp
  $safe = [int]($S * 0.6111)          # 108dp tuvalde 66dp guvenli alan
  $scale = [Math]::Min($safe / $bw, $safe / $bh)
  $dw = [int]($bw * $scale); $dh = [int]($bh * $scale)
  $dx = [int](($S - $dw) / 2); $dy = [int](($S - $dh) / 2)
  $dest = New-Object System.Drawing.Rectangle $dx, $dy, $dw, $dh
  $srect = New-Object System.Drawing.Rectangle $minX, $minY, $bw, $bh
  $g.DrawImage($wolf, $dest, $srect, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  return $bmp
}

# ------------------------------------------------------ eski (legacy) ikon
function New-Legacy([int]$S, [bool]$round) {
  $bmp = New-Object System.Drawing.Bitmap $S, $S, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = New-Gfx $bmp
  if ($round) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse(0, 0, $S, $S)
    $g.SetClip($path)
  }
  $g.DrawImage($logoBmp, 0, 0, $S, $S)
  $g.ResetClip()
  $g.Dispose()
  return $bmp
}

$logoBmp = [System.Drawing.Bitmap]::FromFile($Logo)

# ------------------------------------------------------------------ yaz
$dpi = @(
  @{ n = 'mdpi';    f = 1.0 },
  @{ n = 'hdpi';    f = 1.5 },
  @{ n = 'xhdpi';   f = 2.0 },
  @{ n = 'xxhdpi';  f = 3.0 },
  @{ n = 'xxxhdpi'; f = 4.0 }
)
foreach ($d in $dpi) {
  $dir = Join-Path $Res ("mipmap-" + $d.n)
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $leg = [int](48 * $d.f)
  (New-Legacy $leg $false) | ForEach-Object { $_.Save((Join-Path $dir 'ic_launcher.png'), [System.Drawing.Imaging.ImageFormat]::Png); $_.Dispose() }
  (New-Legacy $leg $true)  | ForEach-Object { $_.Save((Join-Path $dir 'ic_launcher_round.png'), [System.Drawing.Imaging.ImageFormat]::Png); $_.Dispose() }
  $fg  = [int](108 * $d.f)
  (New-Foreground $fg) | ForEach-Object { $_.Save((Join-Path $dir 'ic_launcher_foreground.png'), [System.Drawing.Imaging.ImageFormat]::Png); $_.Dispose() }
  Write-Output ("mipmap-{0}: legacy {1}px, foreground {2}px" -f $d.n, $leg, $fg)
}

# ------------------------------------------- adaptive arka plan rengi siyah
$bgXml = Join-Path $Res 'values\ic_launcher_background.xml'
Set-Content -Path $bgXml -Encoding UTF8 -Value @'
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#000000</color>
</resources>
'@

# ------------------------------------------------- splash (logo + koyu zemin)
$splashSets = @(
  @{ p = 'drawable';                 w = 480;  h = 320 },
  @{ p = 'drawable-land-mdpi';       w = 480;  h = 320 },
  @{ p = 'drawable-land-hdpi';       w = 800;  h = 480 },
  @{ p = 'drawable-land-xhdpi';      w = 1280; h = 720 },
  @{ p = 'drawable-land-xxhdpi';     w = 1600; h = 960 },
  @{ p = 'drawable-land-xxxhdpi';    w = 1920; h = 1280 },
  @{ p = 'drawable-port-mdpi';       w = 320;  h = 480 },
  @{ p = 'drawable-port-hdpi';       w = 480;  h = 800 },
  @{ p = 'drawable-port-xhdpi';      w = 720;  h = 1280 },
  @{ p = 'drawable-port-xxhdpi';     w = 960;  h = 1600 },
  @{ p = 'drawable-port-xxxhdpi';    w = 1280; h = 1920 }
)
foreach ($s in $splashSets) {
  $dir = Join-Path $Res $s.p
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $bmp = New-Object System.Drawing.Bitmap $s.w, $s.h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(255, 11, 21, 32))
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $side = [int]([Math]::Min($s.w, $s.h) * 0.42)
  $lx = [int](($s.w - $side) / 2); $ly = [int](($s.h - $side) / 2)
  $g.DrawImage($logoBmp, $lx, $ly, $side, $side)
  $g.Dispose()
  $bmp.Save((Join-Path $dir 'splash.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
Write-Output ("splash: {0} dosya guncellendi" -f $splashSets.Count)

$logoBmp.Dispose()
$wolf.Dispose()
Write-Output 'IKONLAR TAMAM'
