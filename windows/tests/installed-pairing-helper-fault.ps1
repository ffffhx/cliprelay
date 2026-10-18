param([ValidateSet('Inspect','Kill')][string]$Action = 'Inspect')
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or -not $env:RUNNER_TEMP) { throw 'Disposable CI runner required' }
$fixtureRoot = Join-Path $env:ProgramFiles 'ClipRelay\Remote'
$fixtureState = Join-Path $env:ProgramData 'ClipRelay\Remote'
$service = Get-CimInstance Win32_Service -Filter "Name='ClipRelayRemote'"
if (-not $service -or $service.State -ne 'Running') { throw 'Installed fixture service is not running' }
$expectedService = Join-Path $fixtureRoot 'ClipRelay.Remote.Service.exe'
$serviceProcess = Get-Process -Id $service.ProcessId
if ($serviceProcess.Path -ine $expectedService) { throw 'Unexpected installed service path' }
$expectedHelper = Join-Path $fixtureRoot 'cliprelay-network.exe'
$candidates = @(Get-CimInstance Win32_Process -Filter "Name='cliprelay-network.exe'" | Where-Object {
    $_.ExecutablePath -ieq $expectedHelper -and $_.ParentProcessId -eq $service.ProcessId -and
    $_.CommandLine.Contains('--local-pairing') -and $_.CommandLine.Contains('--state-dir "' + $fixtureState + '"')
})
if ($candidates.Count -ne 1) { throw 'Expected exactly one installed local pairing helper' }
$target = $candidates[0]
$process = Get-Process -Id $target.ProcessId
if ($process.Path -ine $expectedHelper -or [Math]::Abs(($process.StartTime.ToUniversalTime() - $target.CreationDate.ToUniversalTime()).TotalSeconds) -gt 1) {
    throw 'Fixture helper identity changed'
}
if ($Action -eq 'Kill') {
    # Hard termination intentionally bypasses Go defer/DELETE; the SYSTEM
    # watchdog must replace only this helper while the native engine survives.
    Stop-Process -InputObject $process -Force
    if (-not $process.WaitForExit(5000)) { throw 'Fixture helper did not exit' }
}
@{ pid = [int]$target.ProcessId; killed = ($Action -eq 'Kill') } | ConvertTo-Json -Compress
