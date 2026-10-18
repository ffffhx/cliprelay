$ErrorActionPreference='Stop'
$repository=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$output=Join-Path $repository '.tools\uu-parity\wake-tests.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /codepage:65001 /target:exe /platform:x64 /main:WakeTests "/out:$output" /r:System.Web.Extensions.dll /r:System.Management.dll (Join-Path $PSScriptRoot 'wake.cs') (Join-Path $repository 'windows\remote-desktop\wake.cs')
if($LASTEXITCODE -ne 0){throw 'Wake test build failed'}
& $output
if($LASTEXITCODE -ne 0){throw 'Wake discovery tests failed'}
