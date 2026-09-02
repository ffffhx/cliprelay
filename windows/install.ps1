[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Peer,

    [ValidateRange(1, 65535)]
    [int]$Port = 47632,

    [switch]$NoStartup,

    [string]$BaseUrl = "https://raw.githubusercontent.com/ffffhx/cliprelay/main/windows"
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

if ($Peer.Contains("://") -or $Peer.Contains("/") -or $Peer.Contains("\")) {
    throw "Peer must be a host name or IP address without a scheme, port, or path."
}

$installDirectory = Join-Path $env:LOCALAPPDATA "ClipRelay"
$clientPath = Join-Path $installDirectory "cliprelay.ps1"
$uninstallerPath = Join-Path $installDirectory "uninstall.ps1"
$configPath = Join-Path $installDirectory "config.json"
$iconPath = Join-Path $installDirectory "cliprelay.ico"
$startupDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$shortcutPath = Join-Path $startupDirectory "ClipRelay.lnk"
$windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$firewallRuleName = "ClipRelay-TCP-In"

function Install-ScriptFile {
    param(
        [string]$Name,
        [string]$Destination
    )

    $localSource = $null
    if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        $candidate = Join-Path $PSScriptRoot $Name
        if (Test-Path -LiteralPath $candidate) {
            $localSource = $candidate
        }
    }

    if ($null -ne $localSource) {
        $sourceFullPath = [IO.Path]::GetFullPath($localSource)
        $destinationFullPath = [IO.Path]::GetFullPath($Destination)
        if (-not $sourceFullPath.Equals($destinationFullPath, [StringComparison]::OrdinalIgnoreCase)) {
            Copy-Item -LiteralPath $localSource -Destination $Destination -Force
        }
    }
    else {
        $url = "$($BaseUrl.TrimEnd('/'))/$Name"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $Destination
    }
}

function Stop-InstalledClient {
    $clientPattern = [Regex]::Escape($clientPath)
    $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.Name -ieq "powershell.exe" -or $_.Name -ieq "pwsh.exe") -and
            $null -ne $_.CommandLine -and $_.CommandLine -match $clientPattern
        }

    foreach ($process in $processes) {
        if ($process.ProcessId -ne $PID) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Host "==> Installing ClipRelay to $installDirectory"
$null = New-Item -ItemType Directory -Path $installDirectory -Force
Install-ScriptFile -Name "cliprelay.ps1" -Destination $clientPath
Install-ScriptFile -Name "uninstall.ps1" -Destination $uninstallerPath
Install-ScriptFile -Name "cliprelay.ico" -Destination $iconPath

$existingConfig = $null
if (Test-Path -LiteralPath $configPath) {
    try {
        $existingConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    }
    catch {
    }
}
$notifications = $true
$accessToken = ""
$peers = $null
if ($null -ne $existingConfig) {
    $existingNotif = $existingConfig.PSObject.Properties["notifications"]
    if ($null -ne $existingNotif -and $null -ne $existingNotif.Value) {
        $notifications = [bool]$existingNotif.Value
    }
    $existingAccessToken = $existingConfig.PSObject.Properties["accessToken"]
    if ($null -ne $existingAccessToken -and $null -ne $existingAccessToken.Value) {
        $accessToken = [string]$existingAccessToken.Value
    }
    $existingPeers = $existingConfig.PSObject.Properties["peers"]
    if ($null -ne $existingPeers -and @($existingPeers.Value).Count -gt 0) {
        $peers = @($existingPeers.Value)
    }
}
if ($null -eq $peers) {
    $peers = @([ordered]@{
        id          = "installed-peer"
        name        = "接收设备"
        address     = $Peer.Trim()
        port        = $Port
        accessToken = $accessToken
        enabled     = $true
    })
}
$primaryPeer = @($peers | Where-Object {
    $enabledProperty = $_.PSObject.Properties["enabled"]
    $null -eq $enabledProperty -or [bool]$enabledProperty.Value
} | Select-Object -First 1)[0]
if ($null -eq $primaryPeer) {
    $primaryPeer = @($peers)[0]
}
$configuration = [ordered]@{
    peer          = [string]$primaryPeer.address
    peers         = $peers
    port          = $Port
    notifications = $notifications
    accessToken   = $accessToken
}
$configuration | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding UTF8

if ($NoStartup) {
    if (Test-Path -LiteralPath $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
    }
    Write-Host "==> Startup registration skipped"
}
else {
    Write-Host "==> Registering startup for the current user"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $windowsPowerShell
    $shortcut.Arguments = "-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$clientPath`""
    $shortcut.WorkingDirectory = $installDirectory
    if (Test-Path -LiteralPath $iconPath) {
        $shortcut.IconLocation = "$iconPath,0"
    }
    else {
        $shortcut.IconLocation = "$windowsPowerShell,0"
    }
    $shortcut.Description = "ClipRelay Windows client"
    $shortcut.Save()
}

$existingFirewallRule = Get-NetFirewallRule -DisplayName $firewallRuleName -ErrorAction SilentlyContinue
$firewallRuleNeedsUpdate = $null -eq $existingFirewallRule
if (-not $firewallRuleNeedsUpdate) {
    $portFilters = @($existingFirewallRule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue)
    $firewallRuleNeedsUpdate = $portFilters.Count -ne 1 -or
        [string]$portFilters[0].LocalPort -ne [string]$Port -or
        [string]$existingFirewallRule.Profile -ne "Private" -or
        [string]$existingFirewallRule.Enabled -ne "True" -or
        [string]$existingFirewallRule.Direction -ne "Inbound" -or
        [string]$existingFirewallRule.Action -ne "Allow"
}

if ($firewallRuleNeedsUpdate) {
    Write-Host "==> Adding a private-network inbound rule (Windows will show one UAC prompt)"
    try {
        $firewallCommand = "Get-NetFirewallRule -DisplayName '$firewallRuleName' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue; " +
            "New-NetFirewallRule -DisplayName '$firewallRuleName' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private | Out-Null"
        $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($firewallCommand))
        $firewallProcess = Start-Process -FilePath $windowsPowerShell -Verb RunAs -Wait -PassThru -ArgumentList @(
            "-NoProfile",
            "-EncodedCommand",
            $encodedCommand
        )
        if ($firewallProcess.ExitCode -ne 0) {
            Write-Warning "The firewall rule could not be added. Other devices may be unable to reach port $Port."
        }
    }
    catch {
        Write-Warning "The firewall rule was not added: $($_.Exception.Message)"
    }
}
else {
    Write-Host "==> The firewall rule already exists"
}

Write-Host "==> Starting ClipRelay"
Stop-InstalledClient
$arguments = "-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$clientPath`""
$clientProcess = Start-Process -FilePath $windowsPowerShell -ArgumentList $arguments -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 800
if ($clientProcess.HasExited) {
    throw "ClipRelay failed to start. Run this command in PowerShell to see the error:`n$windowsPowerShell -NoProfile -STA -ExecutionPolicy Bypass -File `"$clientPath`""
}

Write-Host ""
Write-Host "ClipRelay for Windows is installed."
Write-Host "  Initial peer: $Peer"
Write-Host "  Port: $Port"
Write-Host "  Send: Ctrl+C copies locally and broadcasts to enabled devices"
Write-Host "  Screenshot: Ctrl+Alt+F12 broadcasts all displays without changing the local clipboard"
Write-Host "  Config: $configPath"
Write-Host "  Uninstall: $uninstallerPath"
