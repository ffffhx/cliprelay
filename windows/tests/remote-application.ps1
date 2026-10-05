param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web.Extensions
$wpf = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\WPF'
Add-Type -Path (Join-Path $PSScriptRoot '..\remote-desktop\input-focus.cs') -ReferencedAssemblies @(
    'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll',
    (Join-Path $wpf 'UIAutomationClient.dll'), (Join-Path $wpf 'UIAutomationTypes.dll'),
    (Join-Path $wpf 'WindowsBase.dll'))
$cases = @{
    'OrCa'='orca'; 'OrcaSlicer'='general'; 'not-orca'='general';
    'Stardew Valley'='stardew'; 'StardewModdingAPI'='stardew';
    'PlateUp'='plateup'; 'ChatGPT'='chatgpt'; 'chrome'='general'
}
foreach ($name in $cases.Keys) {
    if ([ClipRelay.Remote.InputFocus]::ClassifyApp($name) -ne $cases[$name]) {
        throw "Unexpected application classification: $name"
    }
}
$json = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$state = $json.Serialize([ClipRelay.Remote.InputFocus]::ReadApplication()) | ConvertFrom-Json
if (@($state.PSObject.Properties).Count -ne 2 -or $null -eq $state.supported -or $null -eq $state.appId) {
    throw 'Foreground state contains unexpected fields.'
}
Write-Output 'Application classification and minimal foreground response passed.'
