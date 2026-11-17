param([ValidateSet('protect','unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $inputText = [Console]::In.ReadToEnd()
    $entropy = [System.Text.Encoding]::UTF8.GetBytes('LingxingSearch.Mcp.v1')
    if ($Mode -eq 'protect') {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($inputText)
        [Console]::Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,'CurrentUser')))
    } else {
        $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputText),$entropy,'CurrentUser')
        [Console]::Write([System.Text.Encoding]::UTF8.GetString($bytes))
    }
} catch { [Console]::Error.Write('Local credential protection failed'); exit 1 }
