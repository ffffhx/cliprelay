[CmdletBinding()]
param()

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

$deviceId = "cliprelay-mdns-test-$([Guid]::NewGuid().ToString('N'))"
try {
    [ClipRelay.MdnsDiscovery]::Start($deviceId, "ClipRelay mDNS test", 47631, $false)
    Start-Sleep -Milliseconds 1000
    $devices = @([ClipRelay.MdnsDiscovery]::Discover(2500))
    $self = @($devices | Where-Object { $_.Id -eq $deviceId })
    if ($self.Count -ne 1) {
        throw "The Windows DNS-SD browser did not resolve its own ClipRelay advertisement."
    }
    if ($self[0].Name -ne "ClipRelay mDNS test" -or $self[0].Port -ne 47631) {
        throw "The discovered ClipRelay service did not preserve its name and port."
    }
    if ($self[0].Platform -ne "windows" -or $self[0].Version -ne "1" -or $self[0].RequiresAuth) {
        throw "The discovered ClipRelay TXT metadata is invalid."
    }
}
finally {
    [ClipRelay.MdnsDiscovery]::Stop()
}

Write-Output "PASS: Windows publishes and resolves the ClipRelay DNS-SD service with safe metadata."
