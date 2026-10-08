[CmdletBinding()]
param(
    [string]$Destination = '',
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
$stampPath = Join-Path $enginePath 'cliprelay-engine.json'
$stamp = $null
if (Test-Path -LiteralPath $stampPath) { $stamp = Get-Content -LiteralPath $stampPath -Raw | ConvertFrom-Json }
if ($null -eq $stamp -or $stamp.sha256 -ne $manifest.sha256 -or !(Test-Path -LiteralPath (Join-Path $enginePath 'sunshine.exe'))) {
    $work = Join-Path ([IO.Path]::GetTempPath()) ('cliprelay-remote-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($work) | Out-Null
    try {
        $archive = Join-Path $work 'engine.zip'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -UseBasicParsing -Uri $manifest.archiveUrl -OutFile $archive
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $manifest.sha256) { throw 'Remote engine checksum mismatch.' }
        Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $work 'unpacked')
        $unpacked = Join-Path $work 'unpacked\Sunshine'
        [IO.Directory]::CreateDirectory($enginePath) | Out-Null
        # Use our own service and configuration. Upstream setup scripts are never executed.
        foreach ($item in @('sunshine.exe', 'zlib1.dll', 'assets')) {
            Copy-Item -LiteralPath (Join-Path $unpacked $item) -Destination $enginePath -Recurse -Force
        }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'engine.json') -Destination $stampPath -Force
    } finally {
        $resolved = [IO.Path]::GetFullPath($work)
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf).StartsWith('cliprelay-remote-')) {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$wpf = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\WPF'
& $compiler /nologo /target:exe /platform:x64 /optimize+ "/out:$binPath\ClipRelay.Remote.Service.exe" /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "/r:$wpf\UIAutomationClient.dll" "/r:$wpf\UIAutomationTypes.dll" "/r:$wpf\WindowsBase.dll" (Join-Path $PSScriptRoot 'remote-service.cs') (Join-Path $PSScriptRoot 'input-focus.cs') (Join-Path $PSScriptRoot 'voice-input.cs')
if ($LASTEXITCODE -ne 0) { throw 'Remote service compilation failed.' }
& $compiler /nologo /target:library /optimize+ "/out:$binPath\ClipRelay.Remote.Client.dll" (Join-Path $PSScriptRoot 'remote-client.cs')
if ($LASTEXITCODE -ne 0) { throw 'Remote control compilation failed.' }
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
Copy-Item -LiteralPath $enginePath -Destination $serviceRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'engine.json') -Destination $serviceRoot -Force
$settingsPath = Join-Path $stateRoot 'service.json'
if (!(Test-Path -LiteralPath $settingsPath)) {
    [IO.File]::WriteAllText($settingsPath, (@{operatorSid=$OperatorSid; enabled=$false} | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
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
