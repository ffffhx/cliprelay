$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$root = Split-Path $PSScriptRoot
. (Join-Path $root 'install-support.ps1')
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('cliprelay-package-test-' + [Guid]::NewGuid().ToString('N'))
$checks = New-Object 'System.Collections.Generic.List[string]'
function Check([bool]$Condition, [string]$Name) {
    if (!$Condition) { throw "Failed: $Name" }
    $checks.Add($Name)
}
function Reject([scriptblock]$Action, [string]$Name) {
    $rejected = $false
    try { & $Action } catch { $rejected = $true }
    Check $rejected $Name
}
try {
    [IO.Directory]::CreateDirectory($fixture) | Out-Null
    $paired = [pscustomobject]@{id='installed-peer';transport='paired';pairedOwner=('a'*64);enabled=$true}
    $existing = [pscustomobject]@{peer='';port=49765;peers=@($paired);legacyReceiverEnabled=$true;notifications=$false;deviceId='stable-fixture-id';accessToken='fixture-value';future=[pscustomobject]@{nested=@(1,2,3)}}
    $before = $existing | ConvertTo-Json -Depth 64 -Compress
    $merged = New-ClipRelayInstallConfiguration -Existing $existing -Peer '' -Port 47632 -PeerProvided $false -PortProvided $false
    Check ($merged.port -eq 49765 -and $merged.legacyReceiverEnabled -and !$merged.notifications) 'preserves-port-and-user-switches'
    Check ($merged.deviceId -eq 'stable-fixture-id' -and $merged.accessToken -eq 'fixture-value' -and $merged.future.nested.Count -eq 3) 'preserves-identity-credentials-and-unknown-settings'
    Check ($merged.peers.Count -eq 1 -and $merged.peers[0].pairedOwner -ceq ('a'*64) -and $merged.peer -ceq '') 'paired-target-never-becomes-legacy-peer'
    Check (($existing | ConvertTo-Json -Depth 64 -Compress) -ceq $before) 'does-not-mutate-existing-object'
    $override = New-ClipRelayInstallConfiguration -Existing $existing -Peer '192.0.2.15' -Port 49123 -PeerProvided $true -PortProvided $true
    Check ($override.port -eq 49123 -and $override.peers.Count -eq 2 -and $override.peers[0].pairedOwner -ceq ('a'*64) -and $override.peers[1].address -ceq '192.0.2.15') 'explicit-override-preserves-paired-target'
    Check ($override.peers[0].id -cne $override.peers[1].id) 'explicit-peer-avoids-paired-id-collision'
    $legacy = New-ClipRelayInstallConfiguration -Existing ([pscustomobject]@{peer='192.0.2.16';port=49766;accessToken='fixture-legacy'}) -Peer '' -Port 47632 -PeerProvided $false -PortProvided $false
    Check ($legacy.peers.Count -eq 1 -and $legacy.peers[0].address -ceq '192.0.2.16' -and $legacy.peers[0].port -eq 49766 -and !$legacy.legacyReceiverEnabled) 'legacy-migration-retains-target-without-enabling-receiver'
    $path = Join-Path $fixture 'config.json'
    Write-ClipRelayInstallConfiguration $path $merged
    Write-ClipRelayInstallConfiguration $path $override
    $loaded = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    Check ($loaded.peers.Count -eq 2 -and $loaded.future.nested.Count -eq 3 -and @(Get-ChildItem -LiteralPath $fixture -Filter '*.tmp').Count -eq 0) 'atomic-config-replacement-preserves-nested-data'
    Reject { New-ClipRelayInstallConfiguration -Existing @('invalid') } 'invalid-config-rejected'
    Reject { New-ClipRelayInstallConfiguration -Existing ([pscustomobject]@{port=0}) } 'invalid-port-rejected'
    [IO.File]::WriteAllText((Join-Path $fixture 'sample.bin'), 'synthetic package file')
    $files = [pscustomobject]@{'sample.bin'=(Get-FileHash (Join-Path $fixture 'sample.bin')).Hash.ToLowerInvariant()}
    Assert-ClipRelayFiles -Directory $fixture -Files $files
    $checks.Add('valid-file-checksum-accepted')
    [IO.File]::AppendAllText((Join-Path $fixture 'sample.bin'), 'changed')
    Reject { Assert-ClipRelayFiles -Directory $fixture -Files $files } 'tampered-file-rejected'
    Reject { Assert-ClipRelayFiles -Directory $fixture -Files ([pscustomobject]@{'../outside.bin'=('a'*64)}) } 'manifest-path-escape-rejected'
    Reject { Assert-ClipRelayFiles -Directory $fixture -Files ([pscustomobject]@{'absent.bin'=('a'*64)}) } 'missing-file-rejected'
    Reject { Assert-ClipRelayPackage -Directory $fixture } 'incomplete-install-source-rejected'
    $manifest = Get-ClipRelayHostManifest (Join-Path $root 'remote-desktop')
    Check ($manifest.serviceSources -contains 'privacy-screen.cs' -and $manifest.serviceSources -contains 'audio-control.cs' -and $manifest.serviceSources -contains 'wake.cs' -and $manifest.serviceSources -contains 'terminal-native.cs' -and $manifest.serviceSources -contains 'terminal-mouse.cs') 'host-manifest-includes-all-feature-workers'
    # Exercise the real installer in a child process: incomplete input must fail before
    # creating/changing a target, launching an app, elevation or service operations.
    $fakeLocal = Join-Path $fixture 'local'
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $psi.Arguments = '-NoProfile -STA -ExecutionPolicy Bypass -File "' + (Join-Path $root 'install.ps1') + '" -ValidateOnly'
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.EnvironmentVariables['LOCALAPPDATA'] = $fakeLocal
    $process = [Diagnostics.Process]::Start($psi)
    $stdout = $process.StandardOutput.ReadToEnd(); $stderr = $process.StandardError.ReadToEnd()
    if (!$process.WaitForExit(15000)) { $process.Kill(); throw 'Installer preflight timed out.' }
    Check ($process.ExitCode -ne 0 -and !(Test-Path -LiteralPath $fakeLocal) -and ($stdout+$stderr).Contains('package-files.json')) 'real-installer-fails-before-mutation'
    @{passed=$checks.Count;checks=@($checks)} | ConvertTo-Json -Depth 4
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $prefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolved.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or !(Split-Path $resolved -Leaf).StartsWith('cliprelay-package-test-')) { throw 'Invalid cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
