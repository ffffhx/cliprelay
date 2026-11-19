param([switch]$Live, [switch]$Installed, [string]$OutputDirectory)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$output=if($OutputDirectory){[IO.Path]::GetFullPath($OutputDirectory)}else{Join-Path $root ('.tools\artifacts\acceptance\typeless-live-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))}
[IO.Directory]::CreateDirectory($output) | Out-Null
$wpf=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\WPF'
$sources=@('windows\remote-desktop\input-focus.cs','windows\remote-desktop\voice-input.cs','windows\remote-desktop\voice-typeless.cs','windows\remote-desktop\voice-typeless-audio.cs','windows\tests\voice-typeless-live.cs') | ForEach-Object {Join-Path $root $_}
$references=@('/r:System.Management.dll','/r:System.Web.Extensions.dll','/r:System.Drawing.dll','/r:System.Windows.Forms.dll',"/r:$wpf\UIAutomationClient.dll","/r:$wpf\UIAutomationTypes.dll","/r:$wpf\WindowsBase.dll","/r:$wpf\System.Speech.dll")
$test=Join-Path $output 'ClipRelayVoiceAcceptance.exe'
& "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /codepage:65001 /platform:x64 "/out:$test" @references @sources
if($LASTEXITCODE -ne 0){throw 'Typeless live test compilation failed'}
if($Live){
    # Requires explicit permission for the dedicated foreground test window.
    $report=Join-Path $output 'typeless-live.txt'
    if ($Installed) { & $test $report --installed } else { & $test $report }
    $code=$LASTEXITCODE
    Get-Content -LiteralPath $report -Encoding UTF8
    if($code -ne 0){throw 'Typeless live test failed'}
}
