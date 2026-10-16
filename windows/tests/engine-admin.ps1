$ErrorActionPreference='Stop'
$repository=(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$directory=if ($env:CLIPRELAY_TEST_ARTIFACT_DIR) {$env:CLIPRELAY_TEST_ARTIFACT_DIR} else {Join-Path $repository '.tools\uu-parity'}
[IO.Directory]::CreateDirectory($directory) | Out-Null
$output=Join-Path $directory 'engine-admin-tests.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /codepage:65001 /target:exe /platform:x64 /main:EngineAdminTests "/out:$output" /r:System.Web.Extensions.dll (Join-Path $PSScriptRoot 'engine-admin.cs') (Join-Path $repository 'windows\remote-desktop\engine-admin.cs')
if ($LASTEXITCODE -ne 0) {throw 'Engine admin fixture failed to compile'}
$env:CLIPRELAY_TEST_ENGINE_ADMIN=$output
& node --test (Join-Path $PSScriptRoot 'engine-admin.test.cjs')
if ($LASTEXITCODE -ne 0) {throw 'Engine admin transport tests failed'}
