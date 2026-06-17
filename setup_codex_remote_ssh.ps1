$ErrorActionPreference = "Stop"

$sshDir = Join-Path $env:USERPROFILE ".ssh"
$privateKeyPath = Join-Path $sshDir "codex_192_168_0_131_ed25519"
$publicKeyPath = "$privateKeyPath.pub"
$configPath = Join-Path $sshDir "config"
$hostAlias = "codex-remote"
$hostBlock = @"
Host codex-remote
    HostName 192.168.0.131
    User autogoldscalpers
    IdentityFile ~/.ssh/codex_192_168_0_131_ed25519
    IdentitiesOnly yes
"@

if (-not (Test-Path -LiteralPath $sshDir)) {
    New-Item -ItemType Directory -Path $sshDir | Out-Null
}

if (-not (Test-Path -LiteralPath $privateKeyPath)) {
    ssh-keygen -t ed25519 -a 100 -f $privateKeyPath -C "codex-remote-192.168.0.131-autogoldscalpers"
}

if (-not (Test-Path -LiteralPath $configPath)) {
    New-Item -ItemType File -Path $configPath | Out-Null
}

$configContent = Get-Content -LiteralPath $configPath -Raw
$escapedHostAlias = [regex]::Escape($hostAlias)
$hostExists = $configContent -match "(?m)^[ \t]*Host[ \t]+$escapedHostAlias(?:[ \t]+.*)?$"

if (-not $hostExists) {
    if ($configContent.Length -gt 0 -and -not $configContent.EndsWith("`r`n") -and -not $configContent.EndsWith("`n")) {
        Add-Content -LiteralPath $configPath -Value ""
    }

    Add-Content -LiteralPath $configPath -Value ""
    Add-Content -LiteralPath $configPath -Value $hostBlock
}

$publicKey = Get-Content -LiteralPath $publicKeyPath -Raw
$publicKeyTrimmed = $publicKey.Trim()

Set-Clipboard -Value $publicKeyTrimmed

Write-Output "PUBLIC_KEY_START"
Write-Output $publicKeyTrimmed
Write-Output "PUBLIC_KEY_END"
Write-Output ""
Write-Output "ssh codex-remote"
