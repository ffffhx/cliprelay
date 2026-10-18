$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'cliprelay.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Get-PropertyValue','Get-NormalizedPeerAddress','Get-NormalizedRelayPeers','Copy-RelayPeers','Get-EnabledRelayPeers','New-RelayBroadcastTargets','Get-RelayFailedIndexes','Get-RelayPeerRouteSignature','Test-IsLocalRelayPeer','Remove-LocalRelayPeers','Merge-DiscoveredRelayDevices')) {
    $node=$ast.Find({param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name},$true)
    if ($null -eq $node) { throw "Missing function $name" }
    Invoke-Expression $node.Extent.Text
}
$source=($tokens | Where-Object {$_.Kind -eq 'HereStringExpandable'} | Select-Object -First 1).Value
Add-Type -TypeDefinition $source -ReferencedAssemblies System.dll,System.Core.dll,System.Drawing.dll,System.Windows.Forms.dll
Add-Type -TypeDefinition @'
public static class PairedTargetFixture {
    public static string Fail(string owner,string kind,byte[] body,int timeout) { throw new System.IO.IOException("RELAY_OFFLINE"); }
    public static string Delivered(string owner,string kind,byte[] body,int timeout) { return "delivered"; }
    public static string NetworkFailure(string owner,string kind,byte[] body,int timeout) { throw new System.Net.WebException("failure",System.Net.WebExceptionStatus.ConnectFailure); }
}
'@
$owner='a' * 64
$peer=@(Get-NormalizedRelayPeers -Peers @([pscustomobject]@{id='phone';name='Phone';transport='paired';pairedOwner=$owner;enabled=$true}))[0]
$copy=@(Copy-RelayPeers @($peer))[0]
if ($copy.pairedOwner -cne $owner -or $copy.transport -ne 'paired' -or $copy.address -ne '') { throw 'Paired identity was lost' }
$targets=@(New-RelayBroadcastTargets @($copy))
if ($targets[0].PairedOwner -cne $owner -or $targets[0].Uri) { throw 'Secure target got an HTTP route' }
$failed=$false
try { Get-NormalizedRelayPeers -Peers @($peer,$copy) | Out-Null } catch { $failed=$true }
if (!$failed) { throw 'Duplicate certificate owner accepted' }
$downgraded=$peer | Select-Object *
$downgraded.transport='legacy'; $downgraded.address='127.0.0.1'
$failed=$false
try { Get-NormalizedRelayPeers -Peers @($downgraded) | Out-Null } catch { $failed=$true }
if (!$failed) { throw 'Implicit downgrade accepted' }
$changed=$peer | Select-Object *; $changed.pairedOwner='b' * 64
if ((Get-RelayPeerRouteSignature @($peer)) -ceq (Get-RelayPeerRouteSignature @($changed))) { throw 'Route cache omitted identity' }
$merged=Merge-DiscoveredRelayDevices -Peers @($peer) -DiscoveredDevices @([pscustomobject]@{id='phone';name='forged';address='192.0.2.12';port=47632}) -LocalAddresses @('127.0.0.1') -ExistingOnly
if ($merged.Peers[0].address -ne '' -or $merged.Peers[0].name -ne 'Phone' -or $merged.Updated -ne 0) { throw 'Discovery retargeted a paired device' }
[ClipRelay.RelayBroadcaster]::PairedSend=[Delegate]::CreateDelegate([ClipRelay.RelayBroadcaster].GetField('PairedSend').FieldType,[PairedTargetFixture].GetMethod('Fail'))
$targets[0].Uri='http://127.0.0.1:1'
$result=[ClipRelay.RelayBroadcaster]::SendText($targets,'{"text":"fixture"}',1000)
if ($result[0].Success -or $result[0].ErrorKind -ne 'SecureDelivery' -or @(Get-RelayFailedIndexes $result).Count -ne 0) { throw 'Secure failure entered HTTP recovery' }
[ClipRelay.RelayBroadcaster]::PairedSend=[Delegate]::CreateDelegate([ClipRelay.RelayBroadcaster].GetField('PairedSend').FieldType,[PairedTargetFixture].GetMethod('NetworkFailure'))
$result=[ClipRelay.RelayBroadcaster]::SendText($targets,'{"text":"fixture"}',1000)
if ($result[0].Success -or $result[0].ErrorKind -ne 'SecureDelivery' -or @(Get-RelayFailedIndexes $result).Count -ne 0) { throw 'Secure network exception entered HTTP recovery' }
[ClipRelay.RelayBroadcaster]::PairedSend=[Delegate]::CreateDelegate([ClipRelay.RelayBroadcaster].GetField('PairedSend').FieldType,[PairedTargetFixture].GetMethod('Delivered'))
$result=[ClipRelay.RelayBroadcaster]::SendText($targets,'{"text":"fixture"}',1000)
if (!$result[0].Success) { throw 'Confirmed delivery rejected' }
'PASS: paired identity persistence, no discovery retargeting, no downgrade and no HTTP recovery.'
