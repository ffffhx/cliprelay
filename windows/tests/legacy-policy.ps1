$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../cliprelay.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Test-IsLegacyLanAddress','Get-PropertyValue','Get-NormalizedPeerAddress','Get-NormalizedRelayPeers','Copy-RelayPeers','Get-EnabledRelayPeers','New-RelayBroadcastTargets')) {
    $node=$ast.Find({param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name},$true)
    Invoke-Expression $node.Extent.Text
}
$source=($tokens | Where-Object {$_.Kind -eq 'HereStringExpandable'} | Select-Object -First 1).Value
Add-Type -TypeDefinition $source -ReferencedAssemblies System.dll,System.Core.dll,System.Drawing.dll,System.Windows.Forms.dll
foreach ($hostAddress in @('127.0.0.1','10.2.3.4','172.16.1.1','172.31.255.254','192.168.1.2','169.254.1.1','::1','fd12::1','fc00::1','fe80::1','::ffff:192.168.1.2')) {
    $ip=[Net.IPAddress]::Parse($hostAddress)
    if (!(Test-IsLegacyLanAddress $ip) -or ![ClipRelay.LegacyLanPolicy]::IsLocal($ip)) { throw "Local address rejected: $hostAddress" }
}
foreach ($hostAddress in @('0.0.0.0','8.8.8.8','192.0.2.1','100.64.1.1','172.15.1.1','172.32.1.1','224.0.0.1','::','2001:db8::1','ff02::1','::ffff:8.8.8.8')) {
    $ip=[Net.IPAddress]::Parse($hostAddress)
    if ((Test-IsLegacyLanAddress $ip) -or [ClipRelay.LegacyLanPolicy]::IsLocal($ip)) { throw "Non-local address accepted: $hostAddress" }
}
$listener=New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,0)
$listener.Start()
try {
    $port=([Net.IPEndPoint]$listener.LocalEndpoint).Port
    foreach ($value in @($null,$false,'true',1)) {
        $peer=@(Get-NormalizedRelayPeers -Peers @([pscustomobject]@{id='old';name='old';address='127.0.0.1';port=$port;enabled=$true;legacyAllowed=$value}))[0]
        $copy=@(Copy-RelayPeers @($peer))[0]
        $targets=@(New-RelayBroadcastTargets @($copy))
        $result=[ClipRelay.RelayBroadcaster]::SendText($targets,'{"text":"fixture"}',1000)
        if ($copy.legacyAllowed -or $targets[0].LegacyAllowed -or $result[0].Success -or $listener.Pending()) { throw 'Non-boolean consent allowed HTTP transmission' }
    }
    $peer=@(Get-NormalizedRelayPeers -Peers @([pscustomobject]@{id='old';name='old';address='192.0.2.1';port=47632;enabled=$true;legacyAllowed=$true}))[0]
    $targets=@(New-RelayBroadcastTargets @(Copy-RelayPeers @($peer)))
    if (!$targets[0].LegacyAllowed) { throw 'Explicit compatibility was lost' }
    $result=[ClipRelay.RelayBroadcaster]::SendText($targets,'{"text":"fixture"}',1000)
    if ($result[0].Success -or $result[0].ErrorKind -ne 'InvalidOperationException') { throw 'Public HTTP destination was not rejected by policy' }
} finally { $listener.Stop() }
'PASS: explicit legacy consent persists, disabled send emits no connection, public destinations are rejected, and IPv4/IPv6 policies agree.'
