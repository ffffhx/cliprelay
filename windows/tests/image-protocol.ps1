[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

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

function Set-ClipboardImageWithRetry {
    param([System.Drawing.Image]$Image)

    $script:receivedImageSize = New-Object System.Drawing.Size($Image.Width, $Image.Height)
}

$jpegStream = New-Object System.IO.MemoryStream
$bitmap = New-Object System.Drawing.Bitmap(2, 3)
$listener = $null
$sender = $null
$receiver = $null
try {
    $bitmap.Save($jpegStream, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    $jpegBytes = $jpegStream.ToArray()

    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
    $acceptTask = $listener.AcceptTcpClientAsync()

    $sender = New-Object System.Net.Sockets.TcpClient
    $sender.Connect([System.Net.IPAddress]::Loopback, $port)
    $receiver = $acceptTask.GetAwaiter().GetResult()

    $requestHeader = "POST /push-image HTTP/1.1`r`n" +
        "Host: 127.0.0.1:$port`r`n" +
        "Content-Type: image/jpeg`r`n" +
        "Content-Length: $($jpegBytes.Length)`r`n" +
        "Connection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($requestHeader)
    $senderStream = $sender.GetStream()
    $senderStream.Write($headerBytes, 0, $headerBytes.Length)
    $senderStream.Write($jpegBytes, 0, $jpegBytes.Length)
    $senderStream.Flush()

    $script:Notifications = $false
    $script:AccessToken = ""
    $script:receivedImageSize = $null
    Handle-Client -Client $receiver

    $responseBuffer = New-Object byte[] 1024
    $sender.ReceiveTimeout = 2000
    $responseLength = $senderStream.Read($responseBuffer, 0, $responseBuffer.Length)
    $response = [System.Text.Encoding]::UTF8.GetString($responseBuffer, 0, $responseLength)

    if (-not $response.StartsWith("HTTP/1.1 200")) {
        throw "Image push did not return HTTP 200: $response"
    }
    if ($null -eq $script:receivedImageSize -or
        $script:receivedImageSize.Width -ne 2 -or $script:receivedImageSize.Height -ne 3) {
        throw "The decoded image was not passed to the clipboard writer."
    }

    Write-Output "PASS: /push-image decodes JPEG and hands a 2x3 image to the clipboard writer."
}
finally {
    if ($null -ne $receiver) {
        $receiver.Dispose()
    }
    if ($null -ne $sender) {
        $sender.Dispose()
    }
    if ($null -ne $listener) {
        $listener.Stop()
    }
    $bitmap.Dispose()
    $jpegStream.Dispose()
}
