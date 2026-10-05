[CmdletBinding()]
param([switch]$Recovery, [string]$OutputPath = '')
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path (Split-Path $PSScriptRoot) 'remote-desktop\bin\ClipRelay.Remote.Client.dll')
function Invoke-RemoteTestCommand([hashtable]$Request) {
    return ([ClipRelay.Remote.ControlClient]::Request(($Request | ConvertTo-Json -Compress)) | ConvertFrom-Json)
}
$status=Invoke-RemoteTestCommand @{action='status'}
if (!$status.ok -or !$status.data.running) { throw 'Enable the installed ClipRelay remote service before testing.' }
$clients=Invoke-RemoteTestCommand @{action='clients'}
if (!$clients.ok) { throw $clients.error }
$invalid=Invoke-RemoteTestCommand @{action='pair';id='bad';pin='1234';name='test'}
if ($invalid.ok) { throw 'Malformed pairing was accepted.' }
$unknown=Invoke-RemoteTestCommand @{action='execute';command='not-run'}
if ($unknown.ok) { throw 'Unrecognized service action was accepted.' }
$settingsPath=Join-Path $env:ProgramData 'ClipRelay\Remote\service.json'
$acl=Get-Acl -LiteralPath $settingsPath
$writeAllow=@($acl.Access | Where-Object {
    $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -and
    $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')
})
if ($writeAllow.Count) { throw 'A non-administrator can modify privileged service configuration.' }
$initialPid=$status.data.pid
$recoveredPid=$initialPid
if ($Recovery) {
    if (@($clients.data.named_certs).Count -gt 0) { throw 'Recovery test requires a fresh host with no paired users.' }
    $process=Get-CimInstance Win32_Process -Filter "ProcessId = $initialPid"
    $expected=Join-Path $env:ProgramFiles 'ClipRelay\Remote\engine\sunshine.exe'
    if ($process.ExecutablePath -ine $expected) { throw 'Unexpected process; refusing to stop it.' }
    Stop-Process -Id $initialPid -Force
    $deadline=[DateTime]::UtcNow.AddSeconds(40)
    do {
        Start-Sleep -Milliseconds 500
        $current=Invoke-RemoteTestCommand @{action='status'}
        if ($current.ok -and $current.data.running -and $current.data.pid -ne $initialPid) {
            $ready=Invoke-RemoteTestCommand @{action='clients'}
            if ($ready.ok) { $recoveredPid=$current.data.pid; break }
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($recoveredPid -eq $initialPid) { throw 'Engine did not recover after unexpected termination.' }
}
$evidence=[ordered]@{timeUtc=[DateTime]::UtcNow.ToString('o');service=(Get-Service ClipRelayRemote).Status.ToString();initialPid=$initialPid;recoveredPid=$recoveredPid;invalidPairRejected=$true;unknownActionRejected=$true;privilegedConfigProtected=$true;listeners=@(Get-NetTCPConnection -State Listen -LocalPort 47632,48789,48790 | Select-Object LocalAddress,LocalPort,OwningProcess)}
$json=$evidence | ConvertTo-Json -Depth 5
if ($OutputPath) {[IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputPath),$json,[Text.UTF8Encoding]::new($false))}
$json
