[CmdletBinding()]
param(
    [string]$Peer = '',

    [ValidateRange(1, 65535)]
    [int]$Port = 47632,

    [switch]$NoStartup,

    [switch]$ValidateOnly,

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
        throw "Verified package file is no longer available: $Name"
    }
}

function Stop-InstalledClient {
    # Stop the Electron owner first; its pipe closes the native UI gracefully.
    $desktopExecutable = Join-Path $installDirectory 'desktop\ClipRelay.exe'
    Get-CimInstance Win32_Process -Filter "Name = 'ClipRelay.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -ieq $desktopExecutable -and $_.ProcessId -ne $PID } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
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
}

. (Join-Path $PSScriptRoot 'install-support.ps1')
# Complete validation precedes process termination, copying, elevation and settings writes.
Assert-ClipRelayPackage -Directory $PSScriptRoot
Write-Host "==> Installing ClipRelay to $installDirectory"
$existingConfig = $null
if (Test-Path -LiteralPath $configPath) {
    # Fail before stopping the app if settings cannot be read; never replace them.
    $existingConfig = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($existingConfig -isnot [pscustomobject]) { throw 'Existing configuration must be an object.' }
    if (-not $PSBoundParameters.ContainsKey('Peer') -and $null -ne $existingConfig.PSObject.Properties['peer']) {
        $Peer = [string]$existingConfig.peer
    }
    if (-not $PSBoundParameters.ContainsKey('Port') -and $null -ne $existingConfig.PSObject.Properties['port']) {
        $Port = [int]$existingConfig.port
        if ($Port -lt 1 -or $Port -gt 65535) { throw 'Existing port is invalid.' }
    }
    if (-not $PSBoundParameters.ContainsKey('NoStartup')) { $NoStartup = -not (Test-Path -LiteralPath $shortcutPath) }
}
$configuration = New-ClipRelayInstallConfiguration -Existing $existingConfig -Peer $Peer -Port $Port -PeerProvided $PSBoundParameters.ContainsKey('Peer') -PortProvided $PSBoundParameters.ContainsKey('Port')
if ($ValidateOnly) { Write-Host 'Complete Windows package and configuration verified; no installation changes made.'; return }
$null = New-Item -ItemType Directory -Path $installDirectory -Force
Stop-InstalledClient
$videoExecutable = Join-Path $installDirectory 'screen-share\engine\electron.exe'
Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -ieq $videoExecutable } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Install-ScriptFile -Name "cliprelay.ps1" -Destination $clientPath
Install-ScriptFile -Name "uninstall.ps1" -Destination $uninstallerPath
Install-ScriptFile -Name "cliprelay.ico" -Destination $iconPath
foreach ($file in @('updates.ps1', 'update-client.cs', 'paired-relay.cs', 'version.json', 'start.ps1', 'ai.ps1', 'install-support.ps1')) {
    Install-ScriptFile -Name $file -Destination (Join-Path $installDirectory $file)
}
$screenShareDirectory = Join-Path $installDirectory 'screen-share'
New-Item -ItemType Directory -Path $screenShareDirectory -Force | Out-Null
foreach ($file in @('main.js', 'preload.js', 'package.json', 'share.html', 'share.css', 'share.js', 'bridge.ps1', 'setup.ps1', 'RESEARCH.md')) {
    Install-ScriptFile -Name "screen-share/$file" -Destination (Join-Path $screenShareDirectory $file)
}
$bundledEngine = Join-Path $PSScriptRoot 'screen-share\engine'
if (Test-Path (Join-Path $bundledEngine 'electron.exe')) {
    if ([IO.Path]::GetFullPath($bundledEngine) -ine [IO.Path]::GetFullPath((Join-Path $screenShareDirectory 'engine'))) {
        Copy-Item -LiteralPath $bundledEngine -Destination $screenShareDirectory -Recurse -Force
    }
}
$desktopSource = Join-Path $PSScriptRoot 'desktop'
$desktopDirectory = Join-Path $installDirectory 'desktop'
$electronDirectory = Join-Path $installDirectory 'electron'
New-Item -ItemType Directory -Path $electronDirectory -Force | Out-Null
Install-ScriptFile -Name 'electron/windows-files.json' -Destination (Join-Path $electronDirectory 'windows-files.json')
$electronFiles = Get-Content -LiteralPath (Join-Path $electronDirectory 'windows-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($file in $electronFiles) {
    $destination = [IO.Path]::GetFullPath((Join-Path $electronDirectory $file))
    if (!$destination.StartsWith([IO.Path]::GetFullPath($electronDirectory) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid Electron manifest path.' }
    New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
    Install-ScriptFile -Name "electron/$file" -Destination (Join-Path $electronDirectory $file)
}
if (Test-Path -LiteralPath (Join-Path $desktopSource 'ClipRelay.exe')) {
    if ([IO.Path]::GetFullPath($desktopSource) -ine [IO.Path]::GetFullPath($desktopDirectory)) {
        Copy-Item -LiteralPath $desktopSource -Destination $installDirectory -Recurse -Force
    }
} else {
    & (Join-Path $electronDirectory 'setup.ps1') -Destination $desktopDirectory
}

if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'remote-viewer\manifest.json')) {
    if ([IO.Path]::GetFullPath($PSScriptRoot) -ine [IO.Path]::GetFullPath($installDirectory)) {
        & (Join-Path $electronDirectory 'stage-viewer.ps1') -Artifact (Join-Path $PSScriptRoot 'remote-viewer') -Destination (Join-Path $installDirectory 'remote-viewer')
    }
}
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'desktop-network\manifest.json')) {
    if ([IO.Path]::GetFullPath($PSScriptRoot) -ine [IO.Path]::GetFullPath($installDirectory)) {
        & (Join-Path $electronDirectory 'stage-viewer.ps1') -Kind network -Artifact (Join-Path $PSScriptRoot 'desktop-network') -Destination (Join-Path $installDirectory 'desktop-network')
    }
}
$remoteDirectory = Join-Path $installDirectory 'remote-desktop'
New-Item -ItemType Directory -Path $remoteDirectory -Force | Out-Null
$hostManifest = Get-ClipRelayHostManifest (Join-Path $PSScriptRoot 'remote-desktop')
foreach ($file in @('files.json') + $hostManifest.serviceSources + $hostManifest.supportFiles) {
    Install-ScriptFile -Name "remote-desktop/$file" -Destination (Join-Path $remoteDirectory $file)
}
$remoteBin = Join-Path $remoteDirectory 'bin'
New-Item -ItemType Directory -Path $remoteBin -Force | Out-Null
foreach ($name in @('ClipRelay.Remote.Service.exe','ClipRelay.Remote.Client.dll')) {
    Install-ScriptFile -Name "remote-desktop/bin/$name" -Destination (Join-Path $remoteBin $name)
}
$networkSource = Join-Path $PSScriptRoot 'remote-desktop\bin\cliprelay-network.exe'
if (!(Test-Path -LiteralPath $networkSource)) { throw 'Use the complete ClipRelay Windows package (embedded network component missing).' }
if ([IO.Path]::GetFullPath($networkSource) -ine [IO.Path]::GetFullPath((Join-Path $remoteBin 'cliprelay-network.exe'))) {
    Copy-Item -LiteralPath $networkSource -Destination $remoteBin -Force
}
$bundledRemote = Join-Path $PSScriptRoot 'remote-desktop\engine'
if (Test-Path -LiteralPath (Join-Path $bundledRemote 'sunshine.exe')) {
    if ([IO.Path]::GetFullPath($bundledRemote) -ine [IO.Path]::GetFullPath((Join-Path $remoteDirectory 'engine'))) {
        Copy-Item -LiteralPath $bundledRemote -Destination $remoteDirectory -Recurse -Force
    }
}
# Prepare the bundled engine before elevation. No separate Sunshine installer is used.
& (Join-Path $remoteDirectory 'setup.ps1') -Destination $remoteDirectory -UsePreparedBinaries
$remoteSetup = Join-Path $remoteDirectory 'setup.ps1'
$operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$isAdmin = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    & $remoteSetup -Install -UsePreparedBinaries -OperatorSid $operatorSid
} else {
    $remoteInstall = Start-Process -FilePath $windowsPowerShell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$remoteSetup`" -Install -UsePreparedBinaries -OperatorSid $operatorSid"
    if ($remoteInstall.ExitCode -ne 0) { throw 'ClipRelay remote desktop service installation did not complete.' }
}

Write-ClipRelayInstallConfiguration -Path $configPath -Configuration $configuration

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
    $shortcut.TargetPath = Join-Path $desktopDirectory 'ClipRelay.exe'
    $shortcut.Arguments = '--background'
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
        $firewallProcess = Start-Process -FilePath $windowsPowerShell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @(
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

Set-ClipRelayViewerPreferences

Write-Host "==> Starting ClipRelay"
Stop-InstalledClient
& (Join-Path $installDirectory 'start.ps1')

Write-Host ""
Write-Host "ClipRelay for Windows is installed."
Write-Host "  Initial peer: $Peer"
Write-Host "  Port: $Port"
Write-Host "  Send: Ctrl+C copies locally and broadcasts to enabled devices"
Write-Host "  Screenshot: Ctrl+Alt+F12 broadcasts all displays without changing the local clipboard"
Write-Host "  Config: $configPath"
Write-Host "  Uninstall: $uninstallerPath"
