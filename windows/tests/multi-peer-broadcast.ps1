[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$clientPath = Join-Path (Split-Path -Parent $PSScriptRoot) "cliprelay.ps1"
$source = Get-Content -LiteralPath $clientPath -Raw -Encoding UTF8
$sourceMatch = [regex]::Match(
    $source,
    '\$clipRelaySource = @"\r?\n(?<code>.*?)\r?\n"@',
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)
if (-not $sourceMatch.Success) {
    throw "ClipRelay C# source block was not found."
}
Add-Type -TypeDefinition $sourceMatch.Groups["code"].Value -ReferencedAssemblies @(
    "System.dll",
    "System.Core.dll",
    "System.Drawing.dll",
    "System.Windows.Forms.dll"
)

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace ClipRelayTests
{
    public sealed class OneShotHttpServer : IDisposable
    {
        private readonly TcpListener listener;
        private readonly Thread worker;
        private readonly int statusCode;
        private readonly int delayMilliseconds;

        public OneShotHttpServer(int statusCode, int delayMilliseconds)
        {
            this.statusCode = statusCode;
            this.delayMilliseconds = delayMilliseconds;
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
            worker = new Thread(Run);
            worker.IsBackground = true;
            worker.Start();
        }

        public int Port { get; private set; }
        public string Path { get; private set; }
        public string Token { get; private set; }
        public string Width { get; private set; }
        public string Height { get; private set; }
        public byte[] Body { get; private set; }

        private void Run()
        {
            try
            {
                using (TcpClient client = listener.AcceptTcpClient())
                using (NetworkStream stream = client.GetStream())
                {
                    MemoryStream headerBuffer = new MemoryStream();
                    int matched = 0;
                    while (headerBuffer.Length < 16384)
                    {
                        int value = stream.ReadByte();
                        if (value < 0) throw new IOException("headers ended early");
                        headerBuffer.WriteByte((byte)value);
                        byte expected = matched == 0 || matched == 2 ? (byte)'\r' : (byte)'\n';
                        if ((byte)value == expected)
                        {
                            matched++;
                            if (matched == 4) break;
                        }
                        else
                        {
                            matched = (byte)value == (byte)'\r' ? 1 : 0;
                        }
                    }

                    string headerText = Encoding.ASCII.GetString(headerBuffer.ToArray());
                    string[] lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
                    Path = lines[0].Split(' ')[1];
                    int contentLength = 0;
                    foreach (string line in lines)
                    {
                        int separator = line.IndexOf(':');
                        if (separator <= 0) continue;
                        string name = line.Substring(0, separator).Trim();
                        string value = line.Substring(separator + 1).Trim();
                        if (name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
                            contentLength = Int32.Parse(value);
                        else if (name.Equals("X-ClipRelay-Token", StringComparison.OrdinalIgnoreCase))
                            Token = value;
                        else if (name.Equals("X-ClipRelay-Width", StringComparison.OrdinalIgnoreCase))
                            Width = value;
                        else if (name.Equals("X-ClipRelay-Height", StringComparison.OrdinalIgnoreCase))
                            Height = value;
                    }

                    Body = new byte[contentLength];
                    int offset = 0;
                    while (offset < Body.Length)
                    {
                        int read = stream.Read(Body, offset, Body.Length - offset);
                        if (read <= 0) throw new IOException("body ended early");
                        offset += read;
                    }

                    if (delayMilliseconds > 0)
                        Thread.Sleep(delayMilliseconds);
                    string reason = statusCode == 200 ? "OK" : "Service Unavailable";
                    byte[] response = Encoding.ASCII.GetBytes(
                        "HTTP/1.1 " + statusCode + " " + reason + "\r\n" +
                        "Content-Length: 2\r\nConnection: close\r\n\r\nok");
                    stream.Write(response, 0, response.Length);
                    stream.Flush();
                }
            }
            catch (SocketException)
            {
            }
            catch (ObjectDisposedException)
            {
            }
        }

        public void Dispose()
        {
            listener.Stop();
            if (worker.IsAlive)
                worker.Join(2000);
        }
    }
}
"@ -ReferencedAssemblies @("System.dll", "System.Core.dll")

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
foreach ($functionName in @("Get-RelayDeliveryFailureText", "Get-RelayDeliverySummary")) {
    $functionAst = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq $functionName
    }, $true)
    if ($null -eq $functionAst) { throw "Function not found: $functionName" }
    Invoke-Expression $functionAst.Extent.Text
}

function New-TestTarget {
    param([string]$Name, [int]$Port, [string]$Token)
    $target = New-Object ClipRelay.RelayTarget
    $target.Name = $Name
    $target.Address = "127.0.0.1:$Port"
    $target.Uri = "http://127.0.0.1:$Port"
    $target.HostHeader = ""
    $target.AccessToken = $Token
    return $target
}

$serverOne = New-Object ClipRelayTests.OneShotHttpServer(200, 700)
$serverTwo = New-Object ClipRelayTests.OneShotHttpServer(200, 700)
try {
    $targets = @(
        (New-TestTarget -Name "phone" -Port $serverOne.Port -Token "phone-token"),
        (New-TestTarget -Name "computer" -Port $serverTwo.Port -Token "computer-token")
    )
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $results = @([ClipRelay.RelayBroadcaster]::SendText($targets, '{"text":"fanout"}', 3000))
    $stopwatch.Stop()

    if (@($results | Where-Object Success).Count -ne 2) {
        throw "Both parallel text deliveries did not succeed."
    }
    if ($stopwatch.ElapsedMilliseconds -ge 1250) {
        throw "Two delayed receivers were contacted sequentially ($($stopwatch.ElapsedMilliseconds) ms)."
    }
    if ($serverOne.Token -ne "phone-token" -or $serverTwo.Token -ne "computer-token") {
        throw "Per-device access tokens were not sent independently."
    }
    $bodyOne = [Text.Encoding]::UTF8.GetString($serverOne.Body)
    $bodyTwo = [Text.Encoding]::UTF8.GetString($serverTwo.Body)
    if ($bodyOne -cne $bodyTwo -or $bodyOne -cne '{"text":"fanout"}') {
        throw "The same text payload was not delivered to both receivers."
    }
}
finally {
    $serverOne.Dispose()
    $serverTwo.Dispose()
}

$successServer = New-Object ClipRelayTests.OneShotHttpServer(200, 0)
$failedServer = New-Object ClipRelayTests.OneShotHttpServer(503, 0)
try {
    $targets = @(
        (New-TestTarget -Name "online" -Port $successServer.Port -Token ""),
        (New-TestTarget -Name "offline" -Port $failedServer.Port -Token "")
    )
    $results = @([ClipRelay.RelayBroadcaster]::SendText($targets, '{"text":"partial"}', 3000))
    $textKind = ([char]0x6587).ToString() + [char]0x672C
    $summary = Get-RelayDeliverySummary -Results $results -Kind $textKind
    if ($summary.State -ne "partial" -or $summary.SuccessCount -ne 1 -or $summary.FailureCount -ne 1) {
        throw "A mixed broadcast was not reported as partial success."
    }
    if (@($results | Where-Object { $_.StatusCode -eq 503 }).Count -ne 1) {
        throw "The failed destination HTTP status was not preserved."
    }
}
finally {
    $successServer.Dispose()
    $failedServer.Dispose()
}

$imageOne = New-Object ClipRelayTests.OneShotHttpServer(200, 0)
$imageTwo = New-Object ClipRelayTests.OneShotHttpServer(200, 0)
try {
    $targets = @(
        (New-TestTarget -Name "image-one" -Port $imageOne.Port -Token "a"),
        (New-TestTarget -Name "image-two" -Port $imageTwo.Port -Token "b")
    )
    $jpegBytes = [byte[]](0xFF, 0xD8, 0xFF, 0xD9)
    $results = @([ClipRelay.RelayBroadcaster]::SendImage($targets, $jpegBytes, 1920, 1080, 3000))
    if (@($results | Where-Object Success).Count -ne 2) {
        throw "Both image deliveries did not succeed."
    }
    if ($imageOne.Path -ne "/push-image" -or $imageTwo.Path -ne "/push-image") {
        throw "The image path was not used for every receiver."
    }
    if ($imageOne.Width -ne "1920" -or $imageTwo.Height -ne "1080") {
        throw "Image dimensions were not copied to every request."
    }
    if ([Convert]::ToBase64String($imageOne.Body) -cne [Convert]::ToBase64String($imageTwo.Body)) {
        throw "The same encoded image bytes were not reused for all receivers."
    }
}
finally {
    $imageOne.Dispose()
    $imageTwo.Dispose()
}

Write-Output "PASS: text and image fan-out runs in parallel, preserves per-device auth, and reports partial delivery."
