# Derive application icons only from the supplied personal master bitmap.
Add-Type -AssemblyName System.Drawing
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$master = [System.Drawing.Image]::FromFile((Join-Path $root 'assets/personal/app-icon.png'))
try {
  function Save-ScaledPng([int]$size, [string]$target) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $scale = [Math]::Min($size / $master.Width, $size / $master.Height)
        $width = $master.Width * $scale
        $height = $master.Height * $scale
        $graphics.DrawImage($master, ($size - $width) / 2, ($size - $height) / 2, $width, $height)
      } finally { $graphics.Dispose() }
      $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bitmap.Dispose() }
  }
  $resources = Join-Path $root 'resources'
  $tray = Join-Path $resources 'tray'
  Save-ScaledPng 512 (Join-Path $resources 'icon.png')
  Copy-Item -LiteralPath (Join-Path $resources 'icon.png') -Destination (Join-Path $root 'public/icon.png') -Force
  Save-ScaledPng 20 (Join-Path $tray 'trayColor.png')
  Save-ScaledPng 40 (Join-Path $tray 'trayColor@2x.png')
  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $images = foreach ($size in $sizes) {
    $temp = Join-Path $env:TEMP ("lllllvlv-icon-$size-$PID.png")
    Save-ScaledPng $size $temp
    $bytes = [System.IO.File]::ReadAllBytes($temp)
    Remove-Item -LiteralPath $temp
    ,$bytes
  }
  $stream = [System.IO.File]::Create((Join-Path $resources 'icon.ico'))
  try {
    $writer = [System.IO.BinaryWriter]::new($stream)
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6 + 16 * $sizes.Count
    for ($i = 0; $i -lt $sizes.Count; $i++) {
      $size = $sizes[$i]; $bytes = $images[$i]
      $writer.Write([byte]($size % 256)); $writer.Write([byte]($size % 256))
      $writer.Write([byte]0); $writer.Write([byte]0)
      $writer.Write([uint16]1); $writer.Write([uint16]32)
      $writer.Write([uint32]$bytes.Length); $writer.Write([uint32]$offset)
      $offset += $bytes.Length
    }
    foreach ($bytes in $images) { $writer.Write([byte[]]$bytes) }
    $writer.Flush()
  } finally { $stream.Dispose() }
} finally { $master.Dispose() }
