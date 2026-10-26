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
    "Get-NormalizedRelayPeers"
)) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $functionName
    }, $true)
    if ($null -eq $functionAst) { throw "Function not found: $functionName" }
    Invoke-Expression $functionAst.Extent.Text
}

function New-TestPeer {
    param(
        [string]$Name,
        [string]$Address,
        [bool]$Enabled,
        [string]$Transport = "legacy",
        [string]$PairedOwner = ""
    )

    return [PSCustomObject]@{
        id            = ($Name.ToLowerInvariant() -replace '[^a-z0-9]+', '-')
        name          = $Name
        address       = $Address
        port          = 47632
        accessToken   = ""
        enabled       = $Enabled
        requiresAuth  = $false
        platform      = "android"
        transport     = $Transport
        pairedOwner   = $PairedOwner
        legacyAllowed = $true
    }
}

# Two enabled devices still need distinct endpoints, and the message has to
# name both entries so the conflict can be resolved from the control center.
$conflict = $null
try {
    $null = @(Get-NormalizedRelayPeers -Peers @(
        (New-TestPeer -Name "realme RMX3700" -Address "192.168.0.108" -Enabled $true),
        (New-TestPeer -Name "OnePlus PHK110" -Address "192.168.0.108" -Enabled $true)
    ))
}
catch {
    $conflict = $_.Exception.Message
}
if ($conflict -notmatch "接收设备地址重复：192\.168\.0\.108:47632") {
    throw "Enabled devices sharing an address were accepted: $conflict"
}
if ($conflict -notmatch "realme RMX3700" -or $conflict -notmatch "OnePlus PHK110") {
    throw "Duplicate error does not name both devices: $conflict"
}

# A disabled leftover keeps the address DHCP now hands to a live device; it
# must not block that device from being saved.
$mixed = @(Get-NormalizedRelayPeers -Peers @(
    (New-TestPeer -Name "realme RMX3700" -Address "192.168.0.108" -Enabled $true),
    (New-TestPeer -Name "OnePlus PHK110" -Address "192.168.0.108" -Enabled $false)
))
if ($mixed.Count -ne 2) { throw "Disabled device was dropped while sharing an address." }
if ($mixed[0].address -ne "192.168.0.108" -or $mixed[1].address -ne "192.168.0.108") { throw "Shared address was rewritten." }
if ($mixed[0].enabled -ne $true -or $mixed[1].enabled -ne $false) { throw "Enabled state was rewritten." }

# Two disabled entries never broadcast, so a shared endpoint stays allowed.
$disabled = @(Get-NormalizedRelayPeers -Peers @(
    (New-TestPeer -Name "Old Phone A" -Address "192.168.0.104" -Enabled $false),
    (New-TestPeer -Name "Old Phone B" -Address "192.168.0.104" -Enabled $false)
))
if ($disabled.Count -ne 2) { throw "Disabled devices sharing an address were rejected." }

# Paired identities keep the same rule: only enabled entries must differ.
$owner = "a" * 64
$pairedConflict = $null
try {
    $null = @(Get-NormalizedRelayPeers -Peers @(
        (New-TestPeer -Name "Tablet A" -Address "" -Enabled $true -Transport "paired" -PairedOwner $owner),
        (New-TestPeer -Name "Tablet B" -Address "" -Enabled $true -Transport "paired" -PairedOwner $owner)
    ))
}
catch {
    $pairedConflict = $_.Exception.Message
}
if ($pairedConflict -notmatch "同一台配对设备") {
    throw "Enabled paired devices sharing an identity were accepted: $pairedConflict"
}
$pairedMixed = @(Get-NormalizedRelayPeers -Peers @(
    (New-TestPeer -Name "Tablet A" -Address "" -Enabled $true -Transport "paired" -PairedOwner $owner),
    (New-TestPeer -Name "Tablet B" -Address "" -Enabled $false -Transport "paired" -PairedOwner $owner)
))
if ($pairedMixed.Count -ne 2) { throw "Disabled paired duplicate was rejected." }

Write-Output "PASS: endpoint uniqueness applies to enabled devices only and names both conflicting devices."
