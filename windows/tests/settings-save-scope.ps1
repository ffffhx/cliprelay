[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$clientPath = Join-Path (Split-Path -Parent $PSScriptRoot) "cliprelay.ps1"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $clientPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
    throw "cliprelay.ps1 has parse errors: $($parseErrors[0].Message)"
}

foreach ($functionName in @(
    "Get-PropertyValue",
    "Get-NormalizedPeerAddress",
    "Get-NormalizedRelayPeers",
    "Copy-RelayPeers",
    "Get-EnabledRelayPeers",
    "Save-PeerConfiguration"
)) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $functionName
    }, $true)
    if ($null -eq $functionAst) {
        throw "Function not found: $functionName"
    }
    Invoke-Expression $functionAst.Extent.Text
}

$temporaryConfig = [System.IO.Path]::GetTempFileName()
try {
    $script:configPath = $temporaryConfig
    $script:Port = 47632
    $script:Peer = "old-peer.local"
    $script:Peers = @([PSCustomObject]@{
        id = "old"
        name = "old"
        address = "old-peer.local"
        port = 47632
        accessToken = ""
        enabled = $true
    })
    $script:pushUri = $null
    $script:Notifications = $true
    $script:AccessToken = ""
    $script:peerMenuItem = $null
    $script:notifyMenuItem = $null
    $script:restartRequested = $false
    $script:stopRequested = $false
    $script:startupEnabled = $true
    $script:firewallPort = 0
    $savePeerConfigurationCommand = Get-Command Save-PeerConfiguration

    function Set-StartupRegistration {
        param([bool]$Enabled)
        $script:startupEnabled = $Enabled
    }

    function Set-ClipRelayFirewallPort {
        param([int]$ListenPort)
        $script:firewallPort = $ListenPort
    }

    function New-ModelessSaveHandler {
        param([System.Management.Automation.CommandInfo]$SaveCommand)

        $peerAddress = "new-peer.local"
        $notificationsEnabled = $false
        return {
            & $SaveCommand `
                -PeerAddress $peerAddress `
                -Notifications $notificationsEnabled `
                -ListenPort 47888 `
                -AccessToken "shared-secret" `
                -StartupEnabled $false
        }.GetNewClosure()
    }

    $normalized = & (New-ModelessSaveHandler -SaveCommand $savePeerConfigurationCommand)
    $saved = Get-Content -LiteralPath $temporaryConfig -Raw | ConvertFrom-Json

    if ($normalized -ne "new-peer.local") { throw "The normalized peer was not returned." }
    if ($saved.peer -ne "new-peer.local") { throw "The peer was not persisted." }
    if ([int]$saved.port -ne 47888) { throw "The port was not persisted." }
    if ([bool]$saved.notifications) { throw "Unchecked notifications were not persisted as false." }
    if ([string]$saved.accessToken -ne "shared-secret") { throw "The access token was not persisted." }
    if (@($saved.peers).Count -ne 1) { throw "The migrated peer list was not persisted." }
    if ($saved.peers[0].address -ne "new-peer.local" -or [int]$saved.peers[0].port -ne 47888) {
        throw "The legacy peer was not migrated into the peer list."
    }
    if ($script:Peer -ne "new-peer.local") { throw "The active peer was not updated." }
    if ($script:Port -ne 47888) { throw "The active port was not updated." }
    if ($script:AccessToken -ne "shared-secret") { throw "The active access token was not updated." }
    if ($script:Notifications) { throw "The active notification setting was not updated." }
    if ($script:pushUri.AbsoluteUri -ne "http://new-peer.local:47888/push") {
        throw "The active push URI was not updated."
    }
    if ($script:startupEnabled) { throw "Startup was not disabled." }
    if ($script:firewallPort -ne 47888) { throw "The firewall port was not updated." }
    if (-not $script:restartRequested -or -not $script:stopRequested) {
        throw "A port change did not request a restart."
    }

    $script:restartRequested = $false
    $script:stopRequested = $false
    $multiPeers = @(
        [PSCustomObject]@{
            id = "phone"
            name = "phone"
            address = "192.168.1.9"
            port = 47632
            accessToken = "phone-secret"
            enabled = $true
        },
        [PSCustomObject]@{
            id = "computer"
            name = "computer"
            address = "office-pc.local"
            port = 47999
            accessToken = "computer-secret"
            enabled = $true
        }
    )
    $null = Save-PeerConfiguration `
        -PeerAddress "192.168.1.9" `
        -Notifications $true `
        -ListenPort 47888 `
        -AccessToken "local-receiver-secret" `
        -StartupEnabled $true `
        -Peers $multiPeers
    $savedMulti = Get-Content -LiteralPath $temporaryConfig -Raw | ConvertFrom-Json
    if (@($savedMulti.peers).Count -ne 2) { throw "The multi-peer list was not persisted." }
    if ($savedMulti.peers[0].accessToken -ne "phone-secret" -or $savedMulti.peers[1].accessToken -ne "computer-secret") {
        throw "Per-device access tokens were not persisted independently."
    }
    if ([int]$savedMulti.peers[1].port -ne 47999) { throw "The per-device port was not persisted." }
    if ($savedMulti.accessToken -ne "local-receiver-secret") { throw "The local receiver token was not kept separate." }
    if (@($script:Peers).Count -ne 2) { throw "The active peer list was not updated." }
    if ($script:restartRequested -or $script:stopRequested) {
        throw "Changing destinations without changing the local port requested a restart."
    }

    Write-Output "PASS: settings save migrates legacy config and persists independent multi-peer ports and tokens."
}
finally {
    Remove-Item -LiteralPath $temporaryConfig -Force -ErrorAction SilentlyContinue
}
