# Generates icon16/32/48/128 PNGs by rendering icon.svg at 512px via Edge headless,
# then downsampling via System.Drawing for crisp output at small sizes.
Add-Type -AssemblyName System.Drawing

$svg = Join-Path $PSScriptRoot 'icon.svg'
if (-not (Test-Path $svg)) { throw "icon.svg not found at $svg" }

$edge = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge not found.' }

# Wrap the SVG in an HTML page that fills the viewport.
$html = Join-Path $env:TEMP ("2ndnumber-icon-{0}.html" -f ([guid]::NewGuid().ToString('N')))
$svgContent = Get-Content -Raw $svg
@"
<!doctype html><html><head><meta charset='utf-8'><style>
  html,body{margin:0;padding:0;background:transparent}
  svg{display:block;width:100vw;height:100vh}
</style></head><body>$svgContent</body></html>
"@ | Set-Content -Encoding UTF8 $html
$htmlUrl = ([System.Uri]::new($html)).AbsoluteUri

$master = Join-Path $PSScriptRoot 'icon-master.png'
if (Test-Path $master) { Remove-Item $master -Force }
& $edge --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 `
  ("--screenshot=$master") '--window-size=512,512' $htmlUrl | Out-Null
if (-not (Test-Path $master)) { throw 'Master render failed.' }

$src = [System.Drawing.Image]::FromFile($master)
try {
  foreach ($size in 16, 32, 48, 128) {
    $out = Join-Path $PSScriptRoot ("icon{0}.png" -f $size)
    if (Test-Path $out) { Remove-Item $out -Force }
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $size, $size))
    $g.Dispose()
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Saved $out"
  }
} finally {
  $src.Dispose()
  Remove-Item $master -Force -ErrorAction SilentlyContinue
  Remove-Item $html -Force -ErrorAction SilentlyContinue
}
Write-Host 'Done.'
