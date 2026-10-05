[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$installDirectory = Join-Path $env:LOCALAPPDATA "ClipRelay"
$clientPath = Join-Path $installDirectory "cliprelay.ps1"
$startupDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$shortcutPath = Join-Path $startupDirectory "ClipRelay.lnk"
$firewallRuleName = "ClipRelay-TCP-In"
$windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$remoteRemove = Join-Path $installDirectory 'remote-desktop\remove.ps1'
if (Test-Path -LiteralPath $remoteRemove) {
    $isAdmin = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isAdmin) { & $remoteRemove }
    else {
        $removal = Start-Process -FilePath $windowsPowerShell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$remoteRemove`""
        if ($removal.ExitCode -ne 0) { throw 'Remote desktop service removal did not complete.' }
    }
}
$clientPattern = [Regex]::Escape($clientPath)
$processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        ($_.Name -ieq "powershell.exe" -or $_.Name -ieq "pwsh.exe") -and
        $null -ne $_.CommandLine -and $_.CommandLine -notmatch '-NonInteractive' -and $_.CommandLine -match $clientPattern
    }

foreach ($process in $processes) {
    if ($process.ProcessId -ne $PID) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
}

if ($null -ne (Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue)) {
    Write-Host "Windows will show one UAC prompt to remove the firewall rule."
    try {
        $firewallCommand = "Get-NetFirewallRule -DisplayName '$firewallRuleName' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue"
        $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($firewallCommand))
        $firewallProcess = Start-Process -FilePath $windowsPowerShell -Verb RunAs -Wait -PassThru -ArgumentList @(
            "-NoProfile",
            "-EncodedCommand",
            $encodedCommand
        )
        if ($firewallProcess.ExitCode -ne 0) {
            Write-Warning "Firewall rule $firewallRuleName could not be removed."
        }
    }
    catch {
        Write-Warning "The firewall rule was not removed: $($_.Exception.Message)"
    }
}

if (Test-Path -LiteralPath $installDirectory) {
    $resolvedInstall = (Resolve-Path -LiteralPath $installDirectory).Path
    $expectedInstall = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'ClipRelay'))
    if ($resolvedInstall -ine $expectedInstall) { throw 'Unexpected ClipRelay installation location.' }
    Remove-Item -LiteralPath $resolvedInstall -Recurse -Force
}

Write-Host "ClipRelay for Windows has been uninstalled."
