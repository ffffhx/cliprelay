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

$functionAst = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $node.Name -eq "Send-ClipboardTextUnlessDuplicate"
}, $true)
if ($null -eq $functionAst) {
    throw "Function not found: Send-ClipboardTextUnlessDuplicate"
}
Invoke-Expression $functionAst.Extent.Text

$script:Peer = "phone.local"
$script:Port = 47632
$script:clipboardDuplicateWindowMilliseconds = 1000
$script:lastSentClipboardText = $null
$script:lastSentClipboardPeer = $null
$script:lastSentClipboardPort = 0
$script:lastSentClipboardAtUtc = [DateTime]::MinValue
$script:sentTexts = @()
$script:failNextSend = $false
$script:routeSignature = "phone.local:47632"

function Get-RelayPeerRouteSignature {
    return $script:routeSignature
}

function Send-TextToPeer {
    param([string]$Text)

    if ($script:failNextSend) {
        $script:failNextSend = $false
        throw "simulated send failure"
    }
    $script:sentTexts += $Text
    return [PSCustomObject]@{ Name = "phone"; Success = $true }
}

function Get-RelayDeliverySummary {
    param([object[]]$Results, [string]$Kind)
    return [PSCustomObject]@{
        State = "success"
        Detail = "delivered"
        SuccessCount = @($Results | Where-Object Success).Count
        Results = @($Results)
    }
}

function Set-LastTransferStatus {
    param([string]$State, [string]$Kind, [string]$Detail, [object[]]$Results)
}

$start = [DateTime]::SpecifyKind(
    [DateTime]::Parse("2026-09-02T00:00:00"),
    [DateTimeKind]::Utc
)

if (-not (Send-ClipboardTextUnlessDuplicate -Text "alpha" -NowUtc $start)) {
    throw "The first copy should be sent."
}
if (Send-ClipboardTextUnlessDuplicate -Text "alpha" -NowUtc $start.AddMilliseconds(250)) {
    throw "An identical copy inside the one-second window should be suppressed."
}
$script:routeSignature = "phone.local:47632|computer.local:47632"
if (-not (Send-ClipboardTextUnlessDuplicate -Text "alpha" -NowUtc $start.AddMilliseconds(300))) {
    throw "Changing the broadcast destinations should allow the same text immediately."
}
if (-not (Send-ClipboardTextUnlessDuplicate -Text "beta" -NowUtc $start.AddMilliseconds(500))) {
    throw "Different text should be sent immediately."
}
if (-not (Send-ClipboardTextUnlessDuplicate -Text "beta" -NowUtc $start.AddMilliseconds(1500))) {
    throw "Identical text at the one-second boundary should be sent again."
}

$script:failNextSend = $true
try {
    $null = Send-ClipboardTextUnlessDuplicate -Text "retry" -NowUtc $start.AddSeconds(2)
    throw "The simulated send failure was not surfaced."
}
catch {
    if ($_.Exception.Message -ne "simulated send failure") {
        throw
    }
}
if (-not (Send-ClipboardTextUnlessDuplicate -Text "retry" -NowUtc $start.AddMilliseconds(2100))) {
    throw "A failed first send must not suppress a retry."
}

$expected = @("alpha", "alpha", "beta", "beta", "retry")
if ($script:sentTexts.Count -ne $expected.Count) {
    throw "Unexpected send count: $($script:sentTexts.Count)"
}
for ($index = 0; $index -lt $expected.Count; $index++) {
    if ($script:sentTexts[$index] -cne $expected[$index]) {
        throw "Unexpected text at index $index."
    }
}

Write-Output "PASS: duplicate suppression is route-aware, different text is immediate, and failed sends remain retryable."
