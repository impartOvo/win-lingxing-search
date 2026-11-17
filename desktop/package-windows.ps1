$ErrorActionPreference = 'Stop'
$appRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (& node (Join-Path $appRoot 'scripts\release-version.cjs')).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Release version validation failed' }
$dist = Join-Path $appRoot 'dist'
$stage = Join-Path $dist ('stage-' + [guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $stage 'PulsarFetch'
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
$files = @('PulsarFetch.exe','PulsarFetch.exe.config','PulsarFetch.cmd','运行对比.cmd','collector.cjs','browser.js','crawler.js','shared.js','countries.json','package.json','package-lock.json','LICENSE','README.md','THIRD_PARTY_NOTICES.md')
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $appRoot $file) -Destination $packageRoot }
foreach ($directory in @('examples','docs','automation','mcp')) { Copy-Item -LiteralPath (Join-Path $appRoot $directory) -Destination $packageRoot -Recurse }
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'runtime'),(Join-Path $packageRoot 'node_modules') | Out-Null
foreach ($file in @('node.exe','Node-LICENSE.txt')) { Copy-Item -LiteralPath (Join-Path $appRoot ('runtime\' + $file)) -Destination (Join-Path $packageRoot 'runtime') }
$production = & node -e "const lock=require('./package-lock.json'); for(const [name,p] of Object.entries(lock.packages)) if(name.startsWith('node_modules/') && !p.dev) console.log(name)"
if ($LASTEXITCODE -ne 0) { throw 'Unable to read production dependencies' }
foreach ($dependency in $production) {
    $destination = Join-Path $packageRoot $dependency
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $appRoot $dependency) -Destination (Split-Path -Parent $destination) -Recurse -Force
}
Get-ChildItem -LiteralPath $packageRoot -Recurse | ForEach-Object {
    if ($_.Name -in @('.private','results','chrome-profile','.git') -or $_.Extension -in @('.lnk','.log','.pdb')) { throw ('Forbidden archive entry: ' + $_.Name) }
}
$archive = Join-Path $dist ('PulsarFetch-' + $version + '-windows-x64.zip')
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stage, $archive, [System.IO.Compression.CompressionLevel]::Optimal, $false)
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS-windows.txt'), ($hash + '  ' + [System.IO.Path]::GetFileName($archive) + "`n"), [System.Text.Encoding]::ASCII)
$verify = Join-Path $dist ('verify-' + [guid]::NewGuid().ToString('N'))
[System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $verify)
& (Join-Path $PSScriptRoot 'test-exe.ps1') -AppRoot (Join-Path $verify 'PulsarFetch') -Mode self-test
& (Join-Path $PSScriptRoot 'test-exe.ps1') -AppRoot (Join-Path $verify 'PulsarFetch') -Mode smoke-test -StartPage mcp
Write-Output ('Package verified: ' + $archive)
