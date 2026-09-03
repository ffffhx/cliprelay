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
    "Copy-RelayPeers",
    "Merge-DiscoveredRelayDevices"
)) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $functionName
    }, $true)
    if ($null -eq $functionAst) { throw "Function not found: $functionName" }
    Invoke-Expression $functionAst.Extent.Text
}

$existingPeers = @([PSCustomObject]@{
    id = "phone-id"
    name = "Old phone"
    address = "192.168.1.18"
    port = 47632
    accessToken = "phone-secret"
    enabled = $false
    requiresAuth = $false
    platform = "android"
})
$discovered = @(
    [PSCustomObject]@{
        Id = "local-id"
        Name = "This PC"
        Address = "192.168.1.5"
        Port = 47632
        Platform = "windows"
        RequiresAuth = $false
    },
    [PSCustomObject]@{
        Id = "phone-id"
        Name = "Phone"
        Address = "192.168.1.28"
        Port = 47633
        Platform = "android"
        RequiresAuth = $true
    },
    [PSCustomObject]@{
        Id = "mac-id"
        Name = "Study Mac"
        Address = "192.168.1.30"
        Port = 47632
        Platform = "macos"
        RequiresAuth = $false
    }
)

$result = Merge-DiscoveredRelayDevices `
    -Peers $existingPeers `
    -DiscoveredDevices $discovered `
    -DefaultPort 47632 `
    -LocalDeviceId "local-id"

if ($result.Discovered -ne 3 -or $result.Added -ne 1 -or $result.Updated -ne 1) {
    throw "Discovery merge counts are incorrect."
}
if (@($result.Peers).Count -ne 2) {
    throw "Discovery did not exclude the local device or deduplicate an existing peer."
}
$phone = @($result.Peers | Where-Object { $_.id -eq "phone-id" })[0]
if ($phone.address -ne "192.168.1.28" -or $phone.port -ne 47633 -or $phone.name -ne "Phone") {
    throw "Discovery did not refresh the existing device endpoint."
}
if ($phone.accessToken -ne "phone-secret" -or [bool]$phone.enabled) {
    throw "Discovery overwrote the user's token or enabled preference."
}
if (-not [bool]$phone.requiresAuth -or $phone.platform -ne "android") {
    throw "Discovery metadata was not retained."
}

Write-Output "PASS: discovered devices are deduplicated by stable ID without overwriting user secrets or enablement."
