[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$clientPath = Join-Path (Split-Path -Parent $PSScriptRoot) "cliprelay.ps1"
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $clientPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) {
    throw "cliprelay.ps1 has parse errors: $($parseErrors[0].Message)"
}

foreach ($functionName in @("Read-HttpRequest", "Send-HttpResponse", "Handle-Client")) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $functionName
    }, $true)
    if ($null -eq $functionAst) {
        throw "Function not found: $functionName"
    }
    Invoke-Expression $functionAst.Extent.Text
}

function Set-ClipboardTextWithRetry {
    param([string]$Text)
    $script:receivedText = $Text
}

function Invoke-TestPush {
    param(
        [string]$Text,
        [string]$Token = "",
        [switch]$Probe
    )

    $listener = $null
    $sender = $null
    $receiver = $null
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
        $acceptTask = $listener.AcceptTcpClientAsync()

        $sender = New-Object System.Net.Sockets.TcpClient
        $sender.Connect([System.Net.IPAddress]::Loopback, $port)
        $receiver = $acceptTask.GetAwaiter().GetResult()

        $payload = [ordered]@{ text = $Text }
        if ($Probe) {
            $payload.probe = $true
        }
        $body = [System.Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Compress))
        $tokenHeader = if ([string]::IsNullOrEmpty($Token)) { "" } else { "X-ClipRelay-Token: $Token`r`n" }
        $header = "POST /push HTTP/1.1`r`n" +
            "Host: 127.0.0.1:$port`r`n" +
            "Content-Type: application/json; charset=utf-8`r`n" +
            $tokenHeader +
            "Content-Length: $($body.Length)`r`n" +
            "Connection: close`r`n`r`n"
        $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
        $stream = $sender.GetStream()
        $stream.Write($headerBytes, 0, $headerBytes.Length)
        $stream.Write($body, 0, $body.Length)
        $stream.Flush()

        Handle-Client -Client $receiver

        $buffer = New-Object byte[] 1024
        $sender.ReceiveTimeout = 2000
        $length = $stream.Read($buffer, 0, $buffer.Length)
        return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $length)
    }
    finally {
        if ($null -ne $receiver) { $receiver.Dispose() }
        if ($null -ne $sender) { $sender.Dispose() }
        if ($null -ne $listener) { $listener.Stop() }
    }
}

$script:Notifications = $false
$script:AccessToken = "relay-secret"
$script:receivedText = $null

$unauthorizedResponse = Invoke-TestPush -Text "must not arrive"
if (-not $unauthorizedResponse.StartsWith("HTTP/1.1 401")) {
    throw "A request without the configured token was not rejected: $unauthorizedResponse"
}
if ($null -ne $script:receivedText) {
    throw "An unauthorized request reached the clipboard writer."
}

$wrongTokenResponse = Invoke-TestPush -Text "must not arrive" -Token "wrong-secret"
if (-not $wrongTokenResponse.StartsWith("HTTP/1.1 401")) {
    throw "A request with the wrong token was not rejected: $wrongTokenResponse"
}
if ($null -ne $script:receivedText) {
    throw "A request with the wrong token reached the clipboard writer."
}

$authorizedResponse = Invoke-TestPush -Text "authorized relay" -Token "relay-secret"
if (-not $authorizedResponse.StartsWith("HTTP/1.1 200")) {
    throw "A request with the matching token was not accepted: $authorizedResponse"
}
if ($script:receivedText -cne "authorized relay") {
    throw "The authorized text was not passed to the clipboard writer."
}

$script:receivedText = $null
$probeResponse = Invoke-TestPush -Text "probe" -Token "relay-secret" -Probe
if (-not $probeResponse.StartsWith("HTTP/1.1 200")) {
    throw "An authorized probe was not accepted: $probeResponse"
}
if ($null -ne $script:receivedText) {
    throw "A connectivity probe unexpectedly changed the clipboard."
}

Write-Output "PASS: access-token authentication rejects missing/wrong tokens and accepts authorized push/probe requests."
