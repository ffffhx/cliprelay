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
if (-not $sourceMatch.Success) { throw "ClipRelay C# source block was not found." }
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
if ($parseErrors.Count -gt 0) { throw "cliprelay.ps1 has parse errors: $($parseErrors[0].Message)" }
foreach ($functionName in @("Show-RelayPeerEditor", "Show-RelayPeerManager")) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $functionName
    }, $true)
    if ($null -eq $functionAst) { throw "Function not found: $functionName" }
    Invoke-Expression $functionAst.Extent.Text
}

$script:appIcon = $null
function Get-PropertyValue {
    param([object]$Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}
function Copy-RelayPeers {
    param([object[]]$Peers)
    return @($Peers | ForEach-Object {
        [PSCustomObject]@{
            id = $_.id
            name = $_.name
            address = $_.address
            port = $_.port
            accessToken = $_.accessToken
            enabled = $_.enabled
        }
    })
}
function Get-NormalizedRelayPeers {
    param([object[]]$Peers, [int]$DefaultPort, [string]$DefaultAccessToken)
    return @($Peers)
}
function Test-PeerConnectivity {
    param([string]$Address, [int]$Port, [int]$TimeoutMilliseconds, [string]$AccessToken)
    return "ok"
}

$peers = @(
    [PSCustomObject]@{
        id = "phone"
        name = "Phone"
        address = "192.168.1.9"
        port = 47632
        accessToken = "phone-token"
        enabled = $true
    },
    [PSCustomObject]@{
        id = "computer"
        name = "Office PC"
        address = "192.168.1.20"
        port = 47632
        accessToken = ""
        enabled = $true
    }
)

$captured = $false
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 800
$timer.Add_Tick({
    $timer.Stop()
    $openForms = [System.Windows.Forms.Application]::OpenForms
    if ($openForms.Count -lt 1) { return }
    $manager = $openForms[$openForms.Count - 1]
    if ($manager.ClientSize.Width -lt 520 -or $manager.ClientSize.Height -lt 540) {
        $manager.Close()
        throw "The peer manager is unexpectedly small."
    }
    if (-not [string]::IsNullOrWhiteSpace($ScreenshotPath)) {
        $bitmap = New-Object System.Drawing.Bitmap($manager.Width, $manager.Height)
        try {
            $manager.DrawToBitmap($bitmap, (New-Object System.Drawing.Rectangle(0, 0, $bitmap.Width, $bitmap.Height)))
            $bitmap.Save($ScreenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
        }
        finally {
            $bitmap.Dispose()
        }
    }
    $script:captured = $true
    $manager.Close()
})
$timer.Start()
$null = Show-RelayPeerManager -Owner $null -Peers $peers -DefaultPort 47632 -DefaultAccessToken ""
$timer.Dispose()
if (-not $script:captured) { throw "The peer manager did not open for validation." }

$script:editorOpened = $false
$editorTimer = New-Object System.Windows.Forms.Timer
$editorTimer.Interval = 500
$editorTimer.Add_Tick({
    $editorTimer.Stop()
    $openForms = [System.Windows.Forms.Application]::OpenForms
    if ($openForms.Count -lt 1) { return }
    $editor = $openForms[$openForms.Count - 1]
    if ($editor.ClientSize.Width -lt 470 -or $editor.ClientSize.Height -lt 420) {
        $editor.Close()
        throw "The peer editor is unexpectedly small."
    }
    $script:editorOpened = $true
    $editor.Close()
})
$editorTimer.Start()
$null = Show-RelayPeerEditor -Owner $null -Peer $peers[0] -DefaultPort 47632 -DefaultAccessToken ""
$editorTimer.Dispose()
if (-not $script:editorOpened) { throw "The peer editor did not open for validation." }

Write-Output "PASS: the branded peer manager and per-device editor open at the expected sizes."
