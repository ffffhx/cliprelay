$ErrorActionPreference='Stop'
$repository=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$output=Join-Path $repository '.tools\uu-parity\audio-mute-tests.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /codepage:65001 /target:exe /platform:x64 /main:AudioMuteTests "/out:$output" /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll (Join-Path $PSScriptRoot 'audio-mute.cs') (Join-Path $repository 'windows\remote-desktop\audio-mute.cs') (Join-Path $repository 'windows\remote-desktop\audio-endpoints.cs') (Join-Path $repository 'windows\remote-desktop\audio-control.cs') (Join-Path $repository 'windows\remote-desktop\desktop-user.cs')
if ($LASTEXITCODE -ne 0) {throw 'Audio mute test compilation failed'}
& $output
if ($LASTEXITCODE -ne 0) {throw 'Audio mute tests failed'}
