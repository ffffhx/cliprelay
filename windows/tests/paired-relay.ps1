$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$output = Join-Path $repository '.tools\uu-parity\paired-relay-tests.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /platform:x64 /main:PairedRelayTests "/out:$output" /r:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'paired-relay.cs') (Join-Path $repository 'windows\paired-relay.cs') (Join-Path $repository 'windows\remote-desktop\relay-ipc.cs') (Join-Path $repository 'windows\remote-desktop\lan-pairing.cs')
if ($LASTEXITCODE -ne 0) { throw 'Paired relay test build failed' }
& $output
if ($LASTEXITCODE -ne 0) { throw 'Paired relay tests failed' }
