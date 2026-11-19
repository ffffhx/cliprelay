param([ValidateSet('status','quit','restart')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot 'desktop/ClipRelay.exe'
$cli = Join-Path $PSScriptRoot 'electron/lifecycle.cjs'
$previous = $env:ELECTRON_RUN_AS_NODE
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    & $runtime $cli $Action
    $result = $LASTEXITCODE
} finally { $env:ELECTRON_RUN_AS_NODE = $previous }
exit $result
