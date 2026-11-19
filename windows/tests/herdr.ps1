param([switch]$Native, [string]$ArtifactDirectory = '')
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$artifact = if ($ArtifactDirectory) { [IO.Path]::GetFullPath($ArtifactDirectory) } else {
    Join-Path $repository ('.tools/artifacts/acceptance/herdr-check-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
New-Item -ItemType Directory -Force -Path $artifact | Out-Null
$binary = Join-Path $artifact 'herdr-tests.exe'
$sources = @('herdr.cs','herdr-rpc.cs','herdr-projects.cs','desktop-user.cs') | ForEach-Object { Join-Path "$repository/windows/remote-desktop" $_ }
& "$env:WINDIR/Microsoft.NET/Framework64/v4.0.30319/csc.exe" /nologo /codepage:65001 /target:exe /platform:x64 /main:HerdrTests "/out:$binary" /r:System.Web.Extensions.dll /r:System.Management.dll (Join-Path $PSScriptRoot 'herdr.cs') @sources
if ($LASTEXITCODE -ne 0) { throw 'Herdr worker compilation failed' }
& $binary --input-test
if ($LASTEXITCODE -ne 0) { throw 'Herdr input encoding checks failed' }
if ($Native) {
    & python (Join-Path $PSScriptRoot 'herdr_native.py') $binary $artifact
    if ($LASTEXITCODE -ne 0) { throw 'Herdr native integration failed' }
}
