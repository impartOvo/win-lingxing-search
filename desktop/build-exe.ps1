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
    $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#4B7CF0'))
    $drawing.FillEllipse($fill, 0, 0, $size-1, $size-1)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([single]($size/20))
    $drawing.DrawLines($pen, [System.Drawing.PointF[]]@([System.Drawing.PointF]::new($size*.27,$size*.27),[System.Drawing.PointF]::new($size*.27,$size*.73),[System.Drawing.PointF]::new($size*.75,$size*.73)))
    for ($index=0; $index -lt 3; $index++) { $x=$size*(.39+.14*$index); $drawing.DrawLine($pen,[single]$x,[single]($size*.64),[single]$x,[single]($size*(.52-.13*$index))) }
    $buffer = New-Object System.IO.MemoryStream
    $bitmap.Save($buffer,[System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += ,$buffer.ToArray()
    $buffer.Dispose(); $pen.Dispose(); $fill.Dispose(); $drawing.Dispose(); $bitmap.Dispose()
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
$arguments = @('/nologo','/target:winexe','/platform:x64','/optimize+','/codepage:65001',('/out:'+(Join-Path $appRoot '商品诊断.exe')),('/win32manifest:'+(Join-Path $PSScriptRoot 'app.manifest')),('/win32icon:'+$iconPath),('/resource:'+(Join-Path $appRoot 'launcher.xaml')+',ProductDiagnosis.launcher.xaml'),('/resource:'+$iconPath+',ProductDiagnosis.app.ico'))
foreach ($reference in $references) { $path=Join-Path $framework $reference; if(-not (Test-Path -LiteralPath $path)){throw ('缺少程序集：'+$path)}; $arguments += '/reference:'+$path }
$arguments += @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' -File | ForEach-Object {$_.FullName})
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'EXE 编译失败。' }

$config = '<?xml version="1.0" encoding="utf-8"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup><runtime><AppContextSwitchOverrides value="Switch.System.Windows.DoNotScaleForDpiChanges=false"/></runtime></configuration>'
[System.IO.File]::WriteAllText((Join-Path $appRoot '商品诊断.exe.config'),$config,[System.Text.UTF8Encoding]::new($false))
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $appRoot '商品诊断.lnk'))
$shortcut.TargetPath = Join-Path $appRoot '商品诊断.exe'
$shortcut.Arguments = ''
$shortcut.WorkingDirectory = $appRoot
$shortcut.IconLocation = (Join-Path $appRoot '商品诊断.exe')+',0'
$shortcut.Description = '商品诊断 · 领星数据工作台'
$shortcut.Save()
Write-Output ('Built: '+(Join-Path $appRoot '商品诊断.exe'))
