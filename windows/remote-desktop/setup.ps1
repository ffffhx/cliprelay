[CmdletBinding()]
param(
    [string]$Destination = '',
    [string]$EngineArtifact = $env:CLIPRELAY_HOST_ENGINE_ARTIFACT,
    [switch]$UsePreparedBinaries,
    [switch]$Install,
    [string]$OperatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Destination)) { $Destination = $PSScriptRoot }
$Destination = [IO.Path]::GetFullPath($Destination)
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'engine.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$enginePath = Join-Path $Destination 'engine'
$binPath = Join-Path $Destination 'bin'
[IO.Directory]::CreateDirectory($Destination) | Out-Null
[IO.Directory]::CreateDirectory($binPath) | Out-Null
. (Join-Path (Split-Path $PSScriptRoot) 'install-support.ps1')
$hostManifest = Get-ClipRelayHostManifest $PSScriptRoot
$engineFiles = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'engine-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($EngineArtifact) {
    Assert-ClipRelayFiles -Directory $EngineArtifact -Files $engineFiles.files
    foreach ($file in $engineFiles.files.PSObject.Properties) {
        $target = Join-Path $enginePath $file.Name
        [IO.Directory]::CreateDirectory((Split-Path $target)) | Out-Null
        if ([IO.Path]::GetFullPath((Join-Path $EngineArtifact $file.Name)) -ine [IO.Path]::GetFullPath($target)) {
            Copy-Item -LiteralPath (Join-Path $EngineArtifact $file.Name) -Destination $target -Force
        }
    }
}
# Always verify actual runtime bytes; a version stamp alone is insufficient.
Assert-ClipRelayFiles -Directory $enginePath -Files $engineFiles.files
$serviceSources = @($hostManifest.serviceSources | ForEach-Object { Join-Path $PSScriptRoot $_ })
if (!$UsePreparedBinaries) {
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$wpf = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\WPF'
& $compiler /nologo /codepage:65001 /target:exe /platform:x64 /optimize+ "/out:$binPath\ClipRelay.Remote.Service.exe" /r:System.ServiceProcess.dll /r:System.Management.dll /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "/r:$wpf\UIAutomationClient.dll" "/r:$wpf\UIAutomationTypes.dll" "/r:$wpf\WindowsBase.dll" @serviceSources
if ($LASTEXITCODE -ne 0) { throw 'Remote service compilation failed.' }
& $compiler /nologo /target:library /optimize+ "/out:$binPath\ClipRelay.Remote.Client.dll" (Join-Path $PSScriptRoot 'remote-client.cs')
if ($LASTEXITCODE -ne 0) { throw 'Remote control compilation failed.' }
} else {
    foreach ($name in @('ClipRelay.Remote.Service.exe','ClipRelay.Remote.Client.dll')) {
        if (!(Test-Path -LiteralPath (Join-Path $binPath $name) -PathType Leaf)) { throw "Prepared host binary missing: $name" }
    }
}
if (!$Install) { Write-Host 'ClipRelay remote engine and service prepared.'; return }
if (!(Test-Path -LiteralPath (Join-Path $binPath 'cliprelay-network.exe'))) {
    throw 'Embedded network helper is missing. Build the network component before installing.'
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Installing the ClipRelay remote desktop service requires administrator rights.'
}
$serviceRoot = Join-Path $env:ProgramFiles 'ClipRelay\Remote'
$stateRoot = Join-Path $env:ProgramData 'ClipRelay\Remote'
$existing = Get-Service -Name ClipRelayRemote -ErrorAction SilentlyContinue
if ($null -ne $existing) { Stop-Service -Name ClipRelayRemote -ErrorAction Stop }
[IO.Directory]::CreateDirectory($serviceRoot) | Out-Null
[IO.Directory]::CreateDirectory($stateRoot) | Out-Null
# Only SYSTEM and administrators may modify executable/configuration files used by SYSTEM.
foreach ($directory in @($serviceRoot, $stateRoot)) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    if ($directory -eq $serviceRoot) {
        # The voice worker runs as the desktop user to access Doubao's per-user pipe.
        # Executables are readable/executable; only administrators/SYSTEM can modify
        # them. State and pairing credentials retain the stricter ACL below.
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'), 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
}
Copy-Item -LiteralPath (Join-Path $binPath 'ClipRelay.Remote.Service.exe') -Destination $serviceRoot -Force
Copy-Item -LiteralPath (Join-Path $binPath 'cliprelay-network.exe') -Destination $serviceRoot -Force
$installedEngine = Join-Path $serviceRoot 'engine'
foreach ($file in $engineFiles.files.PSObject.Properties) {
    $target = Join-Path $installedEngine $file.Name
    [IO.Directory]::CreateDirectory((Split-Path $target)) | Out-Null
    Copy-Item -LiteralPath (Join-Path $enginePath $file.Name) -Destination $target -Force
}
Assert-ClipRelayFiles -Directory $installedEngine -Files $engineFiles.files
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'engine-files.json') -Destination $serviceRoot -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'engine.json') -Destination $serviceRoot -Force
$settingsPath = Join-Path $stateRoot 'service.json'
if (!(Test-Path -LiteralPath $settingsPath)) {
    [IO.File]::WriteAllText($settingsPath, (@{operatorSid=$OperatorSid; enabled=$true} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
$binary = '"' + (Join-Path $serviceRoot 'ClipRelay.Remote.Service.exe') + '"'
if ($null -eq $existing) {
    New-Service -Name ClipRelayRemote -DisplayName 'ClipRelay Remote Desktop' -BinaryPathName $binary -StartupType Automatic -Description 'ClipRelay 内置远程桌面引擎与配对管理。' | Out-Null
} else {
    & sc.exe config ClipRelayRemote binPath= $binary start= auto | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot update remote service.' }
}
& sc.exe failure ClipRelayRemote reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
$program = Join-Path $serviceRoot 'engine\sunshine.exe'
foreach ($protocol in @('TCP','UDP')) {
    $ruleName = 'ClipRelay-Remote-' + $protocol
    Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    $ports = if ($protocol -eq 'TCP') { @('48784','48789','48810') } else { @('48798-48802') }
    New-NetFirewallRule -Name $ruleName -DisplayName $ruleName -Direction Inbound -Action Allow -Program $program -Protocol $protocol -LocalPort $ports -RemoteAddress @('LocalSubnet','100.64.0.0/10','fd7a:115c:a1e0::/48') -Profile Any | Out-Null
}
# Only the embedded WireGuard helper accepts Internet UDP. Its encrypted peer
# authentication and application allowlist run before any desktop forwarding.
# Prefer 47633, with an upstream ephemeral fallback if occupied. Scope the rule
# to the ACL-protected executable so the fallback can also receive peer traffic.
Get-NetFirewallRule -Name 'ClipRelay-Network-UDP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Name 'ClipRelay-Network-UDP' -DisplayName 'ClipRelay encrypted direct connection' -Direction Inbound -Action Allow -Program (Join-Path $serviceRoot 'cliprelay-network.exe') -Protocol UDP -Profile Any | Out-Null
Get-NetFirewallRule -Name 'ClipRelay-InputFocus-TCP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Name 'ClipRelay-InputFocus-TCP' -DisplayName 'ClipRelay input focus' -Direction Inbound -Action Allow -Program (Join-Path $serviceRoot 'cliprelay-network.exe') -Protocol TCP -LocalPort 48791 -RemoteAddress @('LocalSubnet','100.64.0.0/10','fd7a:115c:a1e0::/48') -Profile Any | Out-Null
Get-NetFirewallRule -Name 'ClipRelay-LAN-Pairing-TCP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Name 'ClipRelay-LAN-Pairing-TCP' -DisplayName 'ClipRelay local pairing' -Direction Inbound -Action Allow -Program (Join-Path $serviceRoot 'cliprelay-network.exe') -Protocol TCP -LocalPort 48792 -RemoteAddress LocalSubnet -Profile Any | Out-Null
Get-NetFirewallRule -Name 'ClipRelay-LAN-Discovery-UDP' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Name 'ClipRelay-LAN-Discovery-UDP' -DisplayName 'ClipRelay local discovery' -Direction Inbound -Action Allow -Program (Join-Path $serviceRoot 'cliprelay-network.exe') -Protocol UDP -LocalPort 47634 -RemoteAddress LocalSubnet -Profile Any | Out-Null
Start-Service ClipRelayRemote
Write-Host 'ClipRelay remote desktop service installed. Enable it from ClipRelay 手机远控.'
