[CmdletBinding()]
param(
    [string]$ScreenshotPath = ""
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$clientPath = Join-Path (Split-Path -Parent $PSScriptRoot) "cliprelay.ps1"
$source = Get-Content -LiteralPath $clientPath -Raw -Encoding UTF8
$sourceMatch = [regex]::Match(
    $source,
    '\$clipRelaySource = @"\r?\n(?<code>.*?)\r?\n"@',
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)
if (-not $sourceMatch.Success) {
    throw "ClipRelay C# source block was not found."
}
Add-Type -TypeDefinition $sourceMatch.Groups["code"].Value -ReferencedAssemblies @(
    "System.dll",
    "System.Core.dll",
    "System.Drawing.dll",
    "System.Windows.Forms.dll"
)

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
        $node.Name -eq "Show-RelayControlCenter"
}, $true)
if ($null -eq $functionAst) {
    throw "Function not found: Show-RelayControlCenter"
}
Invoke-Expression $functionAst.Extent.Text

$script:configurationDialogOpen = $false
$script:Port = 47632
$script:Peer = "192.168.1.9"
$script:Notifications = $true
$script:AccessToken = ""
$script:appIcon = $null
$script:Peers = @(
    [PSCustomObject]@{
        id = "phone"
        name = "phone"
        address = "192.168.1.9"
        port = 47632
        accessToken = ""
        enabled = $true
    },
    [PSCustomObject]@{
        id = "computer"
        name = "office PC"
        address = "192.168.1.20"
        port = 47632
        accessToken = ""
        enabled = $true
    }
)

function Get-LocalShareableAddresses {
    return @(
        [PSCustomObject]@{ Address = "uckf.local"; Display = "uckf.local" },
        [PSCustomObject]@{ Address = "192.168.1.42"; Display = "192.168.1.42" }
    )
}

function Test-StartupRegistration { return $true }
function Set-ClipboardTextWithRetry { param([string]$Text) }
function Copy-RelayPeers { param([object[]]$Peers); return @($Peers) }
function Test-PeerConnectivity {
    param([string]$Address, [int]$Port, [int]$TimeoutMilliseconds, [string]$AccessToken)
    return "ok"
}
function Test-RelayPeersConnectivity {
    param([object[]]$Peers, [int]$TimeoutMilliseconds)
    return [PSCustomObject]@{
        State = "success"
        Detail = "probe delivered to 2/2 devices"
        SuccessCount = 2
        FailureCount = 0
        TotalCount = 2
        Results = @()
    }
}
function Show-RelayPeerManager {
    param($Owner, [object[]]$Peers, [int]$DefaultPort, [string]$DefaultAccessToken)
    return $null
}
function Save-PeerConfiguration {
    param(
        [string]$PeerAddress,
        [bool]$Notifications,
        [int]$ListenPort,
        [string]$AccessToken,
        [bool]$StartupEnabled,
        [object[]]$Peers
    )
    return $PeerAddress
}
function Get-RelayRuntimeSnapshot {
    return [PSCustomObject]@{
        State = "success"
        Kind = "TEXT"
        Detail = "文本已发送到 192.168.1.9"
        At = [DateTime]::Now
        Port = 47632
        Peer = "192.168.1.9"
        ScreenshotHotkeyAvailable = $true
    }
}
function Show-ClipRelayNotification {
    param([string]$Title, [string]$Message)
}

Show-RelayControlCenter
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 50
}

$openForms = [System.Windows.Forms.Application]::OpenForms
$form = if ($openForms.Count -gt 0) { $openForms[0] } else { $null }
if ($null -eq $form) {
    $openFormSummary = @([System.Windows.Forms.Application]::OpenForms | ForEach-Object {
        "$($_.GetType().FullName):$($_.Text)"
    }) -join ", "
    $errorSummary = @($Error | Select-Object -First 5 | ForEach-Object { $_.Exception.Message }) -join " | "
    throw "The relay control center did not open. Open forms: $openFormSummary. Errors: $errorSummary"
}
if ($form.ClientSize.Width -lt 600 -or $form.ClientSize.Height -lt 700) {
    throw "The relay control center is unexpectedly small."
}

$largeHeader = @($form.Controls | Where-Object {
    $_ -is [System.Windows.Forms.Label] -and $_.Font.Size -ge 16
}) | Select-Object -First 1
if ($null -eq $largeHeader -or -not $largeHeader.Visible) {
    throw "The primary device-link heading is not visible."
}

if (-not [string]::IsNullOrWhiteSpace($ScreenshotPath)) {
    $bitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    try {
        $form.DrawToBitmap($bitmap, (New-Object System.Drawing.Rectangle(0, 0, $bitmap.Width, $bitmap.Height)))
        $bitmap.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $bitmap.Dispose()
    }
}

$form.Close()
[System.Windows.Forms.Application]::DoEvents()
Write-Output "PASS: the branded relay control center opens and lays out at the expected size."
