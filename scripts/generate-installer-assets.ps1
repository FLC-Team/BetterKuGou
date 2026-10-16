#Requires -Version 7.0
<#
Rebuild the committed installer artwork from the public Logo without external tools.
Run on Windows with PowerShell 7: pwsh -NoProfile -File scripts/generate-installer-assets.ps1
Packaging consumes the committed files; macOS and Linux do not run this script.
#>
[CmdletBinding()]
param([switch] $WindowsOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$assetRoot = Join-Path $projectRoot 'installer/assets'
[System.IO.Directory]::CreateDirectory($assetRoot) | Out-Null
$brandLogo = [System.Drawing.Image]::FromFile((Join-Path $projectRoot 'public/logo.png'))

function Get-BrandColor([string] $hex) {
  return [System.Drawing.ColorTranslator]::FromHtml($hex)
}

# Use pixel units and draw the same 640 x 420 composition at both resolutions.
function New-BrandCanvas([int] $width, [int] $height, [int] $scale, [string] $background) {
  $bitmap = [System.Drawing.Bitmap]::new($width * $scale, $height * $scale, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $bitmap.SetResolution(72 * $scale, 72 * $scale)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear((Get-BrandColor $background))
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $graphics.ScaleTransform($scale, $scale)
  return @{ Bitmap = $bitmap; Graphics = $graphics }
}

function Draw-BrandText($graphics, [string] $text, [float] $size, [string] $color, [float] $x, [float] $y, [bool] $bold = $false) {
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $font = [System.Drawing.Font]::new('Microsoft YaHei UI', $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
  $brush = [System.Drawing.SolidBrush]::new((Get-BrandColor $color))
  $format = [System.Drawing.StringFormat]::new([System.Drawing.StringFormat]::GenericTypographic)
  try {
    $graphics.DrawString($text, $font, $brush, [System.Drawing.PointF]::new($x, $y), $format)
  } finally {
    $format.Dispose()
    $brush.Dispose()
    $font.Dispose()
  }
}

function Draw-BrandRectangle($graphics, [string] $color, [float] $x, [float] $y, [float] $width, [float] $height) {
  $brush = [System.Drawing.SolidBrush]::new((Get-BrandColor $color))
  try { $graphics.FillRectangle($brush, $x, $y, $width, $height) } finally { $brush.Dispose() }
}

# BMP resources have opaque, theme-matched backgrounds for the native NSIS control.
function Save-WindowsLogo([string] $filename, [string] $background) {
  $canvas = New-BrandCanvas 128 128 1 $background
  try {
    $logoHeight = 112.0 * $brandLogo.Height / $brandLogo.Width
    $canvas.Graphics.DrawImage($brandLogo, [System.Drawing.RectangleF]::new(8, (128 - $logoHeight) / 2, 112, $logoHeight))
    $canvas.Bitmap.Save((Join-Path $assetRoot $filename), [System.Drawing.Imaging.ImageFormat]::Bmp)
  } finally {
    $canvas.Graphics.Dispose()
    $canvas.Bitmap.Dispose()
  }
}

# Finder renders the real application and Applications icons inside the reserved card.
# Keeping their backgrounds clear avoids duplicate icons or misleading click targets.
function Save-DmgBackground([int] $scale, [string] $filename) {
  $canvas = New-BrandCanvas 640 420 $scale '#F4F7FC'
  $graphics = $canvas.Graphics
  try {
    Draw-BrandRectangle $graphics '#3366FF' 44 28 28 3
    Draw-BrandText $graphics 'INSTALL / UPDATE' 10 '#3366FF' 83 23 $true
    Draw-BrandText $graphics 'BetterKuGou' 36 '#111C30' 42 52 $true
    Draw-BrandText $graphics '让音乐，回到你喜欢的样子。' 14 '#59677E' 44 107
    $graphics.DrawImage($brandLogo, [System.Drawing.RectangleF]::new(550, 49, 46, 46 * $brandLogo.Height / $brandLogo.Width))

    Draw-BrandRectangle $graphics '#FFFFFF' 32 148 576 152
    $pen = [System.Drawing.Pen]::new((Get-BrandColor '#3366FF'), 2.5)
    try {
      $graphics.DrawLine($pen, 298, 218, 342, 218)
      $graphics.DrawLine($pen, 333, 209, 342, 218)
      $graphics.DrawLine($pen, 333, 227, 342, 218)
    } finally { $pen.Dispose() }

    Draw-BrandText $graphics '首次安装' 14 '#111C30' 44 324 $true
    Draw-BrandText $graphics '将左侧应用拖入 Applications。' 12 '#59677E' 44 350
    Draw-BrandText $graphics '覆盖升级' 14 '#111C30' 338 324 $true
    Draw-BrandText $graphics '先退出 BetterKuGou，再拖入替换。' 12 '#59677E' 338 350
    Draw-BrandText $graphics '按 Finder 提示替换现有应用。' 12 '#59677E' 338 371

    $canvas.Bitmap.Save((Join-Path $assetRoot $filename), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $canvas.Bitmap.Dispose()
  }
}

try {
  Save-WindowsLogo 'logo-light.bmp' '#F1ECF4'
  Save-WindowsLogo 'logo-dark.bmp' '#29252E'
  if (-not $WindowsOnly) {
    Save-DmgBackground 1 'dmg-background.png'
    Save-DmgBackground 2 'dmg-background@2x.png'
  }
} finally {
  $brandLogo.Dispose()
}

if ($WindowsOnly) {
  Write-Output 'Installer artwork generated: two 128 x 128 Windows BMPs.'
} else {
  Write-Output 'Installer artwork generated: two 128 x 128 BMPs and 640 x 420 / 1280 x 840 DMG backgrounds.'
}
