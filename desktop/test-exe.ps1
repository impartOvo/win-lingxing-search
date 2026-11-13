param(
    [string]$AppRoot = (Join-Path $PSScriptRoot '..'),
    [ValidateSet('self-test','smoke-test')][string]$Mode = 'self-test',
    [string]$ReportPath
)
$ErrorActionPreference = 'Stop'
$AppRoot = [System.IO.Path]::GetFullPath($AppRoot)
if (-not $ReportPath) { $ReportPath = Join-Path $env:TEMP ('lingxing-' + [guid]::NewGuid().ToString('N') + '.json') }
$ReportPath = [System.IO.Path]::GetFullPath($ReportPath)
if (Test-Path -LiteralPath $ReportPath) { Remove-Item -LiteralPath $ReportPath }
$testArgs = @('--' + $Mode, '--test-report', ('"' + $ReportPath + '"'))
$testProcess = Start-Process -FilePath (Join-Path $AppRoot '商品诊断.exe') -ArgumentList $testArgs -WorkingDirectory $AppRoot -WindowStyle Hidden -PassThru
if (-not $testProcess.WaitForExit(60000)) { $testProcess.Kill(); throw 'EXE test timed out' }
$testProcess.Refresh()
if ($testProcess.ExitCode -ne 0) { throw ('EXE test failed: ' + $testProcess.ExitCode) }
if (-not (Test-Path -LiteralPath $ReportPath)) { throw 'EXE test did not write its report' }
$report = Get-Content -LiteralPath $ReportPath -Raw | ConvertFrom-Json
$expectedMode = if ($Mode -eq 'smoke-test') { 'ui-smoke-test' } else { $Mode }
if ($report.status -ne 'ok' -or $report.mode -ne $expectedMode) { throw ('EXE test report failed: ' + $report.error) }
Write-Output ($Mode + ': ok')
