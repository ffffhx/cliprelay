[CmdletBinding()]
param(
    [switch]$Apply,
    # One-time, manually reviewed list of repository-relative legacy artifacts.
    [string]$ReviewedPlan
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$toolsRoot = Join-Path $repository '.tools'
$reportRoot = Join-Path $toolsRoot 'cleanup-reports'
$now = [DateTime]::UtcNow
$minimumAge = $now.AddHours(-24)
$rows = New-Object 'System.Collections.Generic.List[object]'

function Assert-ArtifactPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if (!$full.StartsWith($toolsRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $full.Equals($reportRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $full.StartsWith($reportRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Outside the artifact boundary: $full"
    }
    # Check every ancestor before following it, including .tools itself.
    $cursor = $full
    while ($cursor.Length -ge $repository.Length) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Link/junction: $cursor" }
            if ($item.PSIsContainer -and (Test-Path -LiteralPath (Join-Path $cursor '.keep'))) { throw "Pinned: $cursor" }
            if ($cursor -ne $repository -and $item.PSIsContainer -and (Test-Path -LiteralPath (Join-Path $cursor '.git'))) { throw "Source checkout: $cursor" }
        }
        if ($cursor -eq $repository) { break }
        $cursor = Split-Path -Parent $cursor
    }
    return $full
}

function Get-ArtifactSnapshot([string]$Path) {
    $full = Assert-ArtifactPath $Path
    $stack = New-Object 'System.Collections.Generic.Stack[string]'
    $stack.Push($full)
    $bytes = [long]0
    $newest = [DateTime]::MinValue
    $count = 0
    while ($stack.Count) {
        $item = Get-Item -LiteralPath $stack.Pop() -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Link/junction: $($item.FullName)" }
        if ($item.Name -match '^(\.keep|\.git|config\.json|clients\.json|history\.json|sunshine_state\.json)$' -or
            $item.Name -match '\.(pem|key|jks|keystore)$' -or
            ($item.PSIsContainer -and $item.Name -match '^backup')) {
            throw "Configuration, key, backup, pin or checkout: $($item.FullName)"
        }
        if ($item.LastWriteTimeUtc -gt $newest) { $newest = $item.LastWriteTimeUtc }
        if ($item.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) { $stack.Push($child.FullName) }
        } else { $bytes += $item.Length; $count++ }
    }
    [pscustomobject]@{ Bytes=$bytes; Newest=$newest; Files=$count }
}

function Get-ArtifactProcesses {
    # Failure to inspect processes must stop cleanup, not disable the guard.
    @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID })
}

function Get-ProcessReference([string]$Path, $Processes) {
    $relative = $Path.Substring($repository.Length + 1).Replace('\','/').ToLowerInvariant()
    $absolute = $Path.Replace('\','/').ToLowerInvariant()
    foreach ($process in $Processes) {
        $command = ([string]$process.CommandLine).Replace('\','/').ToLowerInvariant()
        $executable = ([string]$process.ExecutablePath).Replace('\','/').ToLowerInvariant()
        if ($command.Contains($absolute) -or $command.Contains($relative) -or
            $executable -eq $absolute -or $executable.StartsWith($absolute + '/')) {
            return "Referenced by process $($process.ProcessId) ($($process.Name))"
        }
    }
    return $null
}

function Add-Candidate([string]$Path, [string]$Group) {
    $relative = $Path.Substring($repository.Length + 1).Replace('\','/')
    $row = [pscustomobject]@{ Path=$relative; Group=$Group; Action='keep'; Reason=''; Bytes=[long]0; Newest=$null; Files=0 }
    try {
        $snapshot = Get-ArtifactSnapshot $Path
        $row.Bytes=$snapshot.Bytes; $row.Newest=$snapshot.Newest; $row.Files=$snapshot.Files
        $reference = Get-ProcessReference $Path $processes
        if ($reference) { $row.Reason=$reference }
        elseif ($snapshot.Newest -gt $minimumAge) { $row.Reason='Modified within 24 hours' }
        else { $row.Reason='Eligible' }
    } catch { $row.Reason=$_.Exception.Message }
    $rows.Add($row)
}

$processes = Get-ArtifactProcesses
# Only these dedicated output directories are managed automatically. Toolchains,
# source worktrees, installed applications and other .tools content are excluded.
$groups = @(
    @{ Name='acceptance'; Path='.tools/artifacts/acceptance'; Keep=2; Days=7; Budget=2GB },
    @{ Name='windows'; Path='.tools/artifacts/packages/windows'; Keep=2; Days=0; Budget=2GB },
    @{ Name='android'; Path='.tools/artifacts/packages/android'; Keep=2; Days=0; Budget=1GB },
    @{ Name='macos'; Path='.tools/artifacts/packages/macos'; Keep=2; Days=0; Budget=2GB }
)
foreach ($group in $groups) {
    $directory = Join-Path $repository $group.Path
    if (!(Test-Path -LiteralPath $directory)) { continue }
    [void](Assert-ArtifactPath $directory)
    foreach ($child in Get-ChildItem -LiteralPath $directory -Force) {
        if ($child.Name -eq '.keep') { continue }
        Add-Candidate $child.FullName $group.Name
    }
    $members = @($rows | Where-Object { $_.Group -eq $group.Name } | Sort-Object Newest -Descending)
    $total = [long]0
    foreach ($member in $members) { $total += $member.Bytes }
    # Rank all runs, including recent/in-use ones, so older runs do not get extra slots.
    for ($i=0; $i -lt $members.Count; $i++) {
        $row=$members[$i]
        if ($row.Reason -ne 'Eligible') { continue }
        if ($i -ge $group.Keep -or ($group.Days -gt 0 -and $row.Newest -lt $now.AddDays(-$group.Days))) {
            $row.Action='delete'; $row.Reason='Retention count/age'; $total-=$row.Bytes
        }
    }
    foreach ($row in @($members | Sort-Object Newest)) {
        if ($total -le $group.Budget) { break }
        if ($row.Action -eq 'keep' -and $row.Reason -eq 'Eligible') {
            # Always keep the newest package for rollback/use, even above budget.
            if ($row -eq $members[0] -and $group.Name -ne 'acceptance') { continue }
            $row.Action='delete'; $row.Reason='Retention size budget'; $total-=$row.Bytes
        }
    }
    if ($total -gt $group.Budget) { Write-Warning "$($group.Name) remains over budget; protected/recent artifacts were retained." }
}

if ($ReviewedPlan) {
    $paths = Get-Content -LiteralPath $ReviewedPlan -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($paths -isnot [array]) { throw 'Reviewed plan must be a JSON array.' }
    foreach ($relative in $paths) {
        if ($relative -isnot [string] -or [IO.Path]::IsPathRooted($relative)) { throw 'Reviewed plan must contain repository-relative paths.' }
        $full = Assert-ArtifactPath (Join-Path $repository $relative)
        if (!(Test-Path -LiteralPath $full)) { continue }
        if ($rows.Count -gt 0 -and $rows.Path -contains $full.Substring($repository.Length+1).Replace('\','/')) { throw "Duplicate candidate: $relative" }
        Add-Candidate $full 'reviewed-legacy'
        $row=$rows[$rows.Count-1]
        if ($row.Reason -eq 'Eligible') { $row.Action='delete'; $row.Reason='Reviewed obsolete artifact' }
    }
}

# Refuse overlapping plans: a parent deletion must not silently absorb another entry.
$deleteRows = @($rows | Where-Object { $_.Action -eq 'delete' })
foreach ($row in $deleteRows) {
    foreach ($other in $deleteRows) {
        if ($row.Path.StartsWith($other.Path + '/', [StringComparison]::OrdinalIgnoreCase)) { throw "Overlapping plan: $($row.Path)" }
    }
}
$tracked = @(& git -C $repository ls-files -- .tools)
if ($LASTEXITCODE -ne 0) { throw 'Unable to check tracked files.' }
foreach ($row in $deleteRows) {
    if (@($tracked | Where-Object { $_ -eq $row.Path -or $_.StartsWith($row.Path + '/') }).Count) { throw "Tracked files: $($row.Path)" }
}

$freeBefore = ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($repository))).AvailableFreeSpace
$deletedBytes=[long]0
$failed=$false
if ($Apply) {
    # Validate the report directory before the first mutation as well.
    [void](Assert-ArtifactPath (Join-Path $toolsRoot 'artifacts'))
    if (Test-Path -LiteralPath $reportRoot) {
        if ((Get-Item -LiteralPath $reportRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Report directory is a link.' }
    }
    [void][IO.Directory]::CreateDirectory($reportRoot)
    $reportPath = Join-Path $reportRoot ($now.ToString('yyyyMMdd-HHmmss-fffffff') + '.json')
    # Save the plan before deletion, including when the process is interrupted.
    $rows | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
    foreach ($row in $deleteRows) {
        try {
            $full=Assert-ArtifactPath (Join-Path $repository $row.Path)
            $check=Get-ArtifactSnapshot $full
            if ($check.Bytes -ne $row.Bytes -or $check.Newest -ne $row.Newest -or $check.Files -ne $row.Files) { throw 'Artifact changed since inspection.' }
            $reference=Get-ProcessReference $full (Get-ArtifactProcesses)
            if ($reference) { throw $reference }
            Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
            $row.Action='deleted'; $deletedBytes+=$row.Bytes
        } catch { $row.Action='skipped'; $row.Reason=$_.Exception.Message; $failed=$true }
        $rows | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
    }
    Write-Host "Cleanup report: $reportPath"
}
$rows | Select-Object Action,@{Name='MiB';Expression={[Math]::Round($_.Bytes/1MB,1)}},Path,Reason | Format-Table -AutoSize
$planned=[long]0
foreach ($row in $deleteRows) { $planned += $row.Bytes }
$freeAfter=([IO.DriveInfo]::new([IO.Path]::GetPathRoot($repository))).AvailableFreeSpace
Write-Host ('Planned: {0:N2} GiB; deleted: {1:N2} GiB; drive free: {2:N2} -> {3:N2} GiB' -f ($planned/1GB),($deletedBytes/1GB),($freeBefore/1GB),($freeAfter/1GB))
if ($failed) { throw 'Some artifacts were skipped; see the cleanup report.' }
