$ErrorActionPreference='Stop'
$repository=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$directory=if ($env:CLIPRELAY_TEST_ARTIFACT_DIR) {$env:CLIPRELAY_TEST_ARTIFACT_DIR} else {Join-Path $repository '.tools\uu-parity'}
[IO.Directory]::CreateDirectory($directory) | Out-Null
$output=Join-Path $directory 'host-clients-tests.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /codepage:65001 /target:exe /platform:x64 /main:HostClientsTests "/out:$output" /r:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'host-clients.cs') (Join-Path $repository 'windows\remote-desktop\host-clients.cs')
if ($LASTEXITCODE -ne 0) {throw 'Host client tests failed to compile'}
& $output
if ($LASTEXITCODE -ne 0) {throw 'Host client tests failed'}
