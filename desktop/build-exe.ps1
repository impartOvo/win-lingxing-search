# Development build only. The generated application runs directly as an EXE.
$ErrorActionPreference = 'Stop'
$appRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '找不到 .NET Framework C# 编译器。' }

$runtime = Join-Path $appRoot 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$nodeSource = (Get-Command node.exe -ErrorAction Stop).Source
$nodeDestination = Join-Path $runtime 'node.exe'
if ([System.IO.Path]::GetFullPath($nodeSource) -ne $nodeDestination) { Copy-Item -LiteralPath $nodeSource -Destination $nodeDestination -Force }
$licensePath = Join-Path ([System.IO.Path]::GetDirectoryName($nodeSource)) 'LICENSE'
if (Test-Path -LiteralPath $licensePath) { Copy-Item -LiteralPath $licensePath -Destination (Join-Path $runtime 'Node-LICENSE.txt') -Force }

$version = (& node (Join-Path $appRoot 'scripts\release-version.cjs')).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Invalid release version' }
$versionSource = '[assembly: System.Reflection.AssemblyVersion("' + $version + '.0")][assembly: System.Reflection.AssemblyFileVersion("' + $version + '.0")][assembly: System.Reflection.AssemblyInformationalVersion("' + $version + '")]'
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'Version.g.cs'), $versionSource, [System.Text.UTF8Encoding]::new($false))
if (-not (Test-Path -LiteralPath (Join-Path $runtime 'Node-LICENSE.txt'))) {
    $nodeVersion = (& $nodeSource --version).Trim()
    Invoke-WebRequest -UseBasicParsing -Uri ("https://raw.githubusercontent.com/nodejs/node/" + $nodeVersion + "/LICENSE") -OutFile (Join-Path $runtime 'Node-LICENSE.txt')
}

# Create a small application icon from native drawing primitives.
Add-Type -AssemblyName System.Drawing
$iconPath = Join-Path $PSScriptRoot 'app.ico'
$sizes = @(256, 64, 32, 16)
$pngs = @()
foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap $size, $size
    $drawing = [System.Drawing.Graphics]::FromImage($bitmap)
    $drawing.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $drawing.Clear([System.Drawing.Color]::Transparent)
    $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#16181B'))
    $drawing.FillEllipse($fill, 0, 0, $size-1, $size-1)
    $pulse = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#63D8E6'))
    $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#63D8E6')), ([single]($size/32))
    $drawing.TranslateTransform($size/2, $size/2)
    $drawing.RotateTransform(-30)
    $drawing.DrawEllipse($pen, [single](-$size*.34), [single](-$size*.19), [single]($size*.68), [single]($size*.38))
    $drawing.ResetTransform()
    $points = @(@(.50,.12),@(.56,.44),@(.88,.50),@(.56,.56),@(.50,.88),@(.44,.56),@(.12,.50),@(.44,.44)) | ForEach-Object { [System.Drawing.PointF]::new($size*$_[0],$size*$_[1]) }
    $drawing.FillPolygon($pulse, [System.Drawing.PointF[]]$points)
    $buffer = New-Object System.IO.MemoryStream
    $bitmap.Save($buffer,[System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += ,$buffer.ToArray()
    $buffer.Dispose(); $pen.Dispose(); $pulse.Dispose(); $fill.Dispose(); $drawing.Dispose(); $bitmap.Dispose()
}
$stream = [System.IO.File]::Create($iconPath)
$writer = New-Object System.IO.BinaryWriter $stream
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6+16*$sizes.Count
    for ($index=0; $index -lt $sizes.Count; $index++) {
        $dimension = if($sizes[$index] -eq 256){0}else{$sizes[$index]}
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension); $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$pngs[$index].Length); $writer.Write([uint32]$offset)
        $offset += $pngs[$index].Length
    }
    foreach ($bytes in $pngs) { $writer.Write([byte[]]$bytes) }
} finally { $writer.Dispose(); $stream.Dispose() }

$references = @('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Xaml.dll','WPF\PresentationFramework.dll','WPF\PresentationCore.dll','WPF\WindowsBase.dll')
$arguments = @('/nologo','/target:winexe','/platform:x64','/optimize+','/codepage:65001',('/out:'+(Join-Path $appRoot 'PulsarFetch.exe')),('/win32manifest:'+(Join-Path $PSScriptRoot 'app.manifest')),('/win32icon:'+$iconPath),('/resource:'+(Join-Path $appRoot 'launcher.xaml')+',ProductDiagnosis.launcher.xaml'),('/resource:'+$iconPath+',ProductDiagnosis.app.ico'),('/resource:'+(Join-Path $appRoot 'countries.json')+',ProductDiagnosis.countries.json'))
foreach ($reference in $references) { $path=Join-Path $framework $reference; if(-not (Test-Path -LiteralPath $path)){throw ('缺少程序集：'+$path)}; $arguments += '/reference:'+$path }
$arguments += @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' -File | ForEach-Object {$_.FullName})
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'EXE 编译失败。' }

$config = '<?xml version="1.0" encoding="utf-8"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup><runtime><AppContextSwitchOverrides value="Switch.System.Windows.DoNotScaleForDpiChanges=false"/></runtime></configuration>'
[System.IO.File]::WriteAllText((Join-Path $appRoot 'PulsarFetch.exe.config'),$config,[System.Text.UTF8Encoding]::new($false))
if ($env:CI -ne 'true') {
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $appRoot 'PulsarFetch.lnk'))
$shortcut.TargetPath = Join-Path $appRoot 'PulsarFetch.exe'
$shortcut.Arguments = ''
$shortcut.WorkingDirectory = $appRoot
$shortcut.IconLocation = (Join-Path $appRoot 'PulsarFetch.exe')+',0'
$shortcut.Description = 'PulsarFetch · 商品数据采集'
$shortcut.Save()
}
Write-Output ('Built: '+(Join-Path $appRoot 'PulsarFetch.exe'))
