param(
    [Parameter(Mandatory=$true)][int]$Port,
    [Parameter(Mandatory=$true)][string]$Session,
    [ValidateSet('.app','.phone-frame','.mobile-stage','.modal')][string]$Selector = '.app',
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-z0-9-]+\.png$')][string]$Name
)
$ErrorActionPreference = 'Stop'
# Uses the same guarded ProfilePilot session. Capture only this prototype's frame;
# the browser control indicator is neither changed nor hidden.
$measure = 'JSON.stringify(document.querySelector(' + ('"' + $Selector + '"') + ').getBoundingClientRect().toJSON())'
$rect = (ppilot browser --session $Session --cdp $Port eval $measure) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $rect.width -le 0) { throw 'Could not measure design frame' }
$capture = @{
    format = 'png'
    captureBeyondViewport = $true
    clip = @{ x=$rect.x; y=$rect.y; width=$rect.width; height=$rect.height; scale=2 }
} | ConvertTo-Json -Compress
$response = ($capture | ppilot browser --session $Session --cdp $Port cdp call Page.captureScreenshot --params-stdin) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $response.ok -or -not $response.result.data) { throw 'Screenshot capture failed' }
$destination = Join-Path $PSScriptRoot $Name
[IO.File]::WriteAllBytes($destination, [Convert]::FromBase64String($response.result.data))
Get-Item -LiteralPath $destination | Select-Object Name,Length
