[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ReportPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'This test is restricted to the disposable GitHub Actions runner.' }
$installed = Join-Path $env:LOCALAPPDATA 'ClipRelay'
$desktop = Join-Path $installed 'desktop/ClipRelay.exe'
$native = Join-Path $installed 'cliprelay.ps1'
$deadline = [DateTime]::UtcNow.AddSeconds(55)
do {
    $owners = @(Get-CimInstance Win32_Process -Filter "Name='ClipRelay.exe'" | Where-Object { $_.ExecutablePath -ieq $desktop -and $_.CommandLine -notmatch '--type=' })
    $backends = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -notmatch '-NonInteractive' -and $_.CommandLine -like ('*' + $native + '*') })
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 47632 -ErrorAction SilentlyContinue)
    if ($owners.Count -eq 1 -and $backends.Count -and $listeners.Count) { break }
    Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)
if ($owners.Count -ne 1 -or !$backends.Count -or !$listeners.Count) { throw 'Installed desktop/backend/listener did not survive the installer step.' }
if ((Get-Service ClipRelayRemote).Status -ne 'Running') { throw 'Installed host service is not running.' }
Add-Type -Path (Join-Path $installed 'remote-desktop/bin/ClipRelay.Remote.Client.dll')
$status = [ClipRelay.Remote.ControlClient]::Request('{"action":"status"}') | ConvertFrom-Json
if (!$status.ok) { throw 'Installed SYSTEM service pipe did not answer.' }
$serviceRoot = Join-Path $env:ProgramFiles 'ClipRelay/Remote'
. (Join-Path $installed 'install-support.ps1')
$engine = Get-Content -LiteralPath (Join-Path $serviceRoot 'engine-files.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-ClipRelayFiles -Directory (Join-Path $serviceRoot 'engine') -Files $engine.files
$config = Get-Content -LiteralPath (Join-Path $installed 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.legacyReceiverEnabled -ne $false) { throw 'Fresh installation enabled the legacy receiver.' }
# The application now defaults to certificate-paired traffic. Its legacy listener
# must answer with 403 without changing the runner clipboard.
$legacyStatus = 0
try { $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:47632/push' -Method Post -ContentType 'application/json' -Body '{"text":"package-probe"}' -TimeoutSec 5; $legacyStatus = [int]$response.StatusCode }
catch { if ($_.Exception.Response) { $legacyStatus = [int]$_.Exception.Response.StatusCode } else { throw } }
if ($legacyStatus -ne 403) { throw "Expected disabled legacy listener response, received $legacyStatus" }
$ownerPid = [int]$owners[0].ProcessId
$backendPids = @($backends | ForEach-Object { [int]$_.ProcessId })
# Terminate only this disposable installation's Electron owner; the native backend
# must exit on pipe EOF without being killed separately.
Stop-Process -Id $ownerPid -Force
$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
    $remaining = @($backendPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if (!$remaining.Count) { break }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
if ($remaining.Count) { throw 'Native backend survived loss of its owner pipe.' }
$report = [ordered]@{passed=$true;independentDesktop=$ownerPid;independentBackends=$backendPids;listenerPort=47632;legacyResponse=$legacyStatus;systemServicePipe=$true;pinnedEngineFiles=@($engine.files.PSObject.Properties).Count;backendExitedOnPipeClose=$true;hardwareStreamingTested=$false}
[IO.File]::WriteAllText([IO.Path]::GetFullPath($ReportPath), ($report | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$report | ConvertTo-Json -Depth 5
