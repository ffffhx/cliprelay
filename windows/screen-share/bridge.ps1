function script:Invoke-ScreenShareCommand {
    param([hashtable]$Command, [switch]$NoStart)
    $endpointFile = Join-Path $env:APPDATA 'ClipRelay\ScreenShare\control.json'
    $endpoint = $null
    if (Test-Path $endpointFile) {
        try {
            $candidate = Get-Content $endpointFile -Raw -Encoding UTF8 | ConvertFrom-Json
            $process = Get-Process -Id $candidate.pid -ErrorAction Stop
            if ($process.ProcessName -eq 'electron') { $endpoint = $candidate }
        } catch {}
    }
    if ($null -eq $endpoint) {
        if ($NoStart) { return $null }
        $engine = Join-Path $PSScriptRoot 'engine\electron.exe'
        if (-not (Test-Path $engine)) { throw '视频共享组件未安装，请重新运行 Windows 安装脚本。' }
        $psi = New-Object Diagnostics.ProcessStartInfo
        $psi.FileName = $engine
        $psi.Arguments = '"' + $PSScriptRoot + '" --tray-pid=' + $PID
        $psi.WorkingDirectory = $PSScriptRoot
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
        $psi.EnvironmentVariables.Remove('CHROME_CRASHPAD_PIPE_NAME')
        [void][Diagnostics.Process]::Start($psi)
        $deadline = [DateTime]::UtcNow.AddSeconds(6)
        do {
            Start-Sleep -Milliseconds 100
            if (Test-Path $endpointFile) {
                try {
                    $candidate = Get-Content $endpointFile -Raw -Encoding UTF8 | ConvertFrom-Json
                    if (Get-Process -Id $candidate.pid -ErrorAction SilentlyContinue) { $endpoint = $candidate }
                } catch {}
            }
        } while ($null -eq $endpoint -and [DateTime]::UtcNow -lt $deadline)
        if ($null -eq $endpoint) { throw '视频窗口启动失败，请重新启动 ClipRelay 后重试。' }
    }
    $uri = 'http://127.0.0.1:' + [int]$endpoint.port + '/command'
    $request = [Net.HttpWebRequest]::Create($uri)
    $request.Proxy = $null
    $request.Method = 'POST'
    $request.Timeout = 5000
    $request.ContentType = 'application/json; charset=utf-8'
    $request.Headers['X-ClipRelay-Control'] = $endpoint.secret
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Command | ConvertTo-Json -Depth 12 -Compress))
    $request.ContentLength = $bytes.Length
    $output = $request.GetRequestStream()
    try { $output.Write($bytes, 0, $bytes.Length) } finally { $output.Dispose() }
    $response = $request.GetResponse()
    try {
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
    } finally { $response.Dispose() }
}
