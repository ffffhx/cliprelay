param([switch]$Live, [switch]$VirtualLoop, [switch]$CustomEditor)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$output = Join-Path $root '.tools\voice-tests'
[IO.Directory]::CreateDirectory($output) | Out-Null
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$wpf = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\WPF'
$sources = @((Join-Path $root 'windows\remote-desktop\input-focus.cs'), (Join-Path $root 'windows\remote-desktop\voice-input.cs'))
$references = @('/r:System.Web.Extensions.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', "/r:$wpf\UIAutomationClient.dll", "/r:$wpf\UIAutomationTypes.dll", "/r:$wpf\WindowsBase.dll")
$test = Join-Path $output 'VoiceInputTest.exe'
& $compiler /nologo /target:exe /platform:x64 "/out:$test" @references @sources (Join-Path $PSScriptRoot 'voice-input.cs')
if ($LASTEXITCODE -ne 0) { throw 'Voice test compilation failed.' }
if ($VirtualLoop) { & $test --virtual-loop } else { & $test }
if ($LASTEXITCODE -ne 0) { throw 'Voice component test failed.' }
if ($Live -or $CustomEditor) {
    $test = Join-Path $output 'DoubaoVoiceLiveTest.exe'
    & $compiler /nologo /target:exe /platform:x64 "/out:$test" @references "/r:$wpf\UIAutomationProvider.dll" "/r:$wpf\System.Speech.dll" "/r:$wpf\PresentationFramework.dll" "/r:$wpf\PresentationCore.dll" "/r:$wpf\WindowsFormsIntegration.dll" /r:System.Xaml.dll @sources (Join-Path $PSScriptRoot 'voice-doubao-live.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Live voice test compilation failed.' }
    # Opens an owned test field and dictates synthetic audio, never a physical microphone.
    # The test checks its foreground ownership before sending audio and restores Doubao's microphone.
    $mode = if ($CustomEditor) { '--custom-editor' } else { '--live' }
    $name = if ($CustomEditor) { 'custom-editor' } else { 'doubao-live' }
    & $test $mode (Join-Path $output ($name + '.png')) (Join-Path $output ($name + '.txt'))
    $result = $LASTEXITCODE
    Get-Content -LiteralPath (Join-Path $output ($name + '.txt')) -Encoding UTF8
    if ($result -ne 0) { throw 'Live dictation test failed.' }
}
