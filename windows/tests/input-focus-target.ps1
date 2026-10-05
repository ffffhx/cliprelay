param([switch]$GeometryOnly)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$output = Join-Path $root '.tools\keyboard-tests'
[IO.Directory]::CreateDirectory($output) | Out-Null
$wpf = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\WPF'
$binary = Join-Path $output 'InputFocusTargetTest.exe'
& "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /platform:x64 /main:InputFocusTargetTest "/out:$binary" /r:System.Web.Extensions.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll "/r:$wpf\UIAutomationClient.dll" "/r:$wpf\UIAutomationTypes.dll" "/r:$wpf\WindowsBase.dll" (Join-Path $root 'windows\remote-desktop\input-focus.cs') (Join-Path $PSScriptRoot 'input-focus-target.cs')
if ($LASTEXITCODE -ne 0) { throw 'Input target test compilation failed.' }
# The UIA case needs foreground activation. It exits if another app gains focus;
# it never sends mouse/keyboard input or repeatedly takes focus back.
if ($GeometryOnly) { & $binary --geometry-only } else { & $binary }
if ($LASTEXITCODE -ne 0) { throw 'Input target regression failed.' }
