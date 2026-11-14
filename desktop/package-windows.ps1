$ErrorActionPreference = 'Stop'
$appRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (& node (Join-Path $appRoot 'scripts\release-version.cjs')).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Release version validation failed' }
$dist = Join-Path $appRoot 'dist'
$stage = Join-Path $dist ('stage-' + [guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $stage 'win-lingxing-search'
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
$files = @('商品诊断.exe','商品诊断.exe.config','商品诊断.cmd','运行对比.cmd','browser.js','crawler.js','shared.js','countries.json','package.json','package-lock.json','LICENSE','README.md','THIRD_PARTY_NOTICES.md')
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $appRoot $file) -Destination $packageRoot }
foreach ($directory in @('examples','docs','automation')) { Copy-Item -LiteralPath (Join-Path $appRoot $directory) -Destination $packageRoot -Recurse }
New-Item -ItemType Directory -Path (Join-Path $packageRoot 'runtime'),(Join-Path $packageRoot 'node_modules') | Out-Null
foreach ($file in @('node.exe','Node-LICENSE.txt')) { Copy-Item -LiteralPath (Join-Path $appRoot ('runtime\' + $file)) -Destination (Join-Path $packageRoot 'runtime') }
foreach ($dependency in @('playwright','playwright-core')) { Copy-Item -LiteralPath (Join-Path $appRoot ('node_modules\' + $dependency)) -Destination (Join-Path $packageRoot 'node_modules') -Recurse }
Get-ChildItem -LiteralPath $packageRoot -Recurse | ForEach-Object {
    if ($_.Name -in @('.private','results','chrome-profile','.git') -or $_.Extension -in @('.lnk','.log','.pdb')) { throw ('Forbidden archive entry: ' + $_.Name) }
}
$archive = Join-Path $dist ('lingxing-search-' + $version + '-windows-x64.zip')
Compress-Archive -LiteralPath $packageRoot -DestinationPath $archive -Force
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS-windows.txt'), ($hash + '  ' + [System.IO.Path]::GetFileName($archive) + "`n"), [System.Text.Encoding]::ASCII)
$verify = Join-Path $dist ('verify-' + [guid]::NewGuid().ToString('N'))
Expand-Archive -LiteralPath $archive -DestinationPath $verify
foreach ($mode in @('self-test','smoke-test')) { & (Join-Path $PSScriptRoot 'test-exe.ps1') -AppRoot (Join-Path $verify 'win-lingxing-search') -Mode $mode }
Write-Output ('Package verified: ' + $archive)
