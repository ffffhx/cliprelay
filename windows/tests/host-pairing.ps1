$ErrorActionPreference='Stop'
$repository=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$directory=if ($env:CLIPRELAY_TEST_ARTIFACT_DIR) {$env:CLIPRELAY_TEST_ARTIFACT_DIR} else {Join-Path $repository '.tools\uu-parity'}
[IO.Directory]::CreateDirectory($directory) | Out-Null
$output=Join-Path $directory 'host-pairing-tests.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /codepage:65001 /target:exe /platform:x64 /main:HostPairingTests "/out:$output" /r:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'host-pairing.cs') (Join-Path $repository 'windows\remote-desktop\relay-ipc.cs') (Join-Path $repository 'windows\remote-desktop\lan-pairing.cs')
if ($LASTEXITCODE -ne 0) {throw 'Host pairing tests failed to compile'}
& $output
if ($LASTEXITCODE -ne 0) {throw 'Host pairing tests failed'}
