[CmdletBinding()]
param()
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$service = Get-Service -Name ClipRelayRemote -ErrorAction SilentlyContinue
if ($null -ne $service) {
    Stop-Service -Name ClipRelayRemote
    & sc.exe delete ClipRelayRemote | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot remove ClipRelay remote service.' }
}
foreach ($name in @('ClipRelay-Remote-TCP','ClipRelay-Remote-UDP','ClipRelay-Network-UDP','ClipRelay-InputFocus-TCP','ClipRelay-LAN-Pairing-TCP','ClipRelay-LAN-Discovery-UDP')) {
    Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}
foreach ($root in @($env:ProgramFiles,$env:ProgramData)) {
    $expected = [IO.Path]::GetFullPath((Join-Path $root 'ClipRelay\Remote'))
    if (Test-Path -LiteralPath $expected) {
        $actual = (Resolve-Path -LiteralPath $expected).Path
        if ($actual -ine $expected -or $actual -notlike '*\ClipRelay\Remote') { throw 'Unexpected remote component location.' }
        Remove-Item -LiteralPath $actual -Recurse -Force
    }
}
