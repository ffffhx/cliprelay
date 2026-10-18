# Disposable GitHub runner only: exercise the real worker as an ordinary user.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This account-isolated test launcher is only for disposable Windows GitHub runners.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The runner must create an isolated non-administrator test account.'
}
$repository = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$suffix = [Guid]::NewGuid().ToString('N').Substring(0,8)
$account = 'crterm_' + $suffix
$directory = Join-Path $repository ('.tools/terminal-ci-' + $suffix)
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$pairingFixture = Join-Path $directory 'pairing-fixture.exe'
# Compile before switching users. A fresh user's Go cache can spend the entire
# certificate-generation timeout compiling the standard library.
& go build -o $pairingFixture (Join-Path $PSScriptRoot 'mac-pairing-fixture/main.go')
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the pairing certificate fixture.' }
$hostTests = Join-Path $directory 'host-terminal-tests.exe'
Push-Location (Join-Path $repository 'network')
try {
    & go test -c -o $hostTests ./inputfocus
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the native terminal protocol tests.' }
} finally { Pop-Location }
$random = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($random)
$password = ConvertTo-SecureString ('Cr!9' + [Convert]::ToBase64String($random)) -AsPlainText -Force
$created = $false
try {
    $user = New-LocalUser -Name $account -Password $password -AccountNeverExpires -Description 'Disposable ClipRelay terminal acceptance'
    $created = $true
    Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545') -Member $user
    $sid = '*' + $user.SID.Value
    & icacls.exe $repository /grant "${sid}:(OI)(CI)RX" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant test source read access.' }
    & icacls.exe $directory /grant "${sid}:(OI)(CI)M" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant isolated test scratch access.' }
    $node = (Get-Command node.exe).Source
    function Quote-Literal([string]$value) { return "'" + $value.Replace("'", "''") + "'" }
    $script = Join-Path $directory 'run.ps1'
    $child = @(
        '$ErrorActionPreference = ''Stop''',
        '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
        'if ($identity.IsSystem -or ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw ''Terminal test must not be elevated.'' }',
        ('Set-Location -LiteralPath ' + (Quote-Literal $repository)),
        ('$env:TEMP = ' + (Quote-Literal $directory)),
        '$env:TMP = $env:TEMP',
        ('$env:GOCACHE = ' + (Quote-Literal (Join-Path $directory 'go-cache'))),
        ('$env:GOPATH = ' + (Quote-Literal (Join-Path $directory 'go-path'))),
        '$env:GOTELEMETRY = ''off''',
        ('$env:CLIPRELAY_PAIRING_TEST_FIXTURE = ' + (Quote-Literal $pairingFixture)),
        ('$env:CLIPRELAY_TERMINAL_TEST_WORKER = ' + (Quote-Literal (Join-Path $repository '.tools/uu-parity/terminal-tests.exe'))),
        '$env:CLIPRELAY_TERMINAL_MOUSE_FIXTURE = $env:CLIPRELAY_TERMINAL_TEST_WORKER',
        ('& ' + (Quote-Literal $node) + ' --test windows/tests/desktop-terminal.test.cjs windows/tests/desktop-terminal-ui.test.cjs windows/tests/desktop-terminal-window.test.cjs windows/tests/desktop-terminal-mouse.test.cjs windows/tests/desktop-terminal-mouse-ui.test.cjs'),
        '$testExit = $LASTEXITCODE',
        ('if ($testExit -eq 0) { & ' + (Quote-Literal $hostTests) + ' ''-test.run=^TestTerminal'' ''-test.timeout=90s'' ''-test.v''; $testExit = $LASTEXITCODE }'),
        '[IO.File]::WriteAllText((Join-Path $env:TEMP ''terminal-exit.txt''), [string]$testExit)',
        'exit $testExit'
    )
    [IO.File]::WriteAllLines($script, $child, (New-Object Text.UTF8Encoding($true)))
    $credential = New-Object Management.Automation.PSCredential("$env:COMPUTERNAME\$account", $password)
    $stdout = Join-Path $directory 'stdout.log'
    $stderr = Join-Path $directory 'stderr.log'
    $process = Start-Process -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -Credential $credential -LoadUserProfile -WindowStyle Hidden -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $script + '"') -WorkingDirectory $repository -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    if (-not $process.WaitForExit(300000)) {
        & taskkill.exe /PID $process.Id /T /F | Out-Null
        throw 'Isolated terminal tests exceeded five minutes.'
    }
    $process.WaitForExit()
    Get-Content -LiteralPath $stdout -Encoding UTF8
    Get-Content -LiteralPath $stderr -Encoding UTF8
    # PowerShell 5.1 can lose Process.ExitCode after a credentialed launch.
    # Require the child's combined Node/Go test result in this fresh private directory,
    # after the process has exited. Missing/partial receipts still fail closed.
    $receipt = Join-Path $directory 'terminal-exit.txt'
    if (-not (Test-Path -LiteralPath $receipt) -or [IO.File]::ReadAllText($receipt) -cne '0') {
        throw 'Isolated terminal tests did not report successful completion.'
    }
    Write-Output 'Real terminal tests passed under an isolated non-administrator account.'
} finally {
    if ($created) { Remove-LocalUser -Name $account }
}
