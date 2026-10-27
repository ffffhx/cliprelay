# Short-lived MCP bridge. The ClipRelay tray app remains independently owned.
$ErrorActionPreference='Stop'
$runtime=Join-Path $PSScriptRoot 'desktop/ClipRelay.exe'
$entry=Join-Path $PSScriptRoot 'desktop/resources/app/ai-mcp.cjs'
if (!(Test-Path -LiteralPath $runtime) -or !(Test-Path -LiteralPath $entry)) { throw 'Install the ClipRelay Windows package containing AI tools first.' }
$previous=[Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE','Process')
try {
    $env:ELECTRON_RUN_AS_NODE='1'
    & $runtime $entry
    $code=$LASTEXITCODE
} finally { [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',$previous,'Process') }
exit $code
