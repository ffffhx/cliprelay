[CmdletBinding()]
param(
    [string]$Peer,

    [ValidateRange(0, 65535)]
    [int]$Port = 0
)

# ClipRelay Windows client. It implements the same protocol as the macOS and
# Android clients: POST /push with a UTF-8 JSON body such as {"text":"..."}.

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ("ClipRelay.NativeMethods" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;

namespace ClipRelay
{
    [StructLayout(LayoutKind.Sequential)]
    public struct NativePoint
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct NativeMessage
    {
        public IntPtr HWnd;
        public uint Message;
        public IntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public NativePoint Point;
        public uint Private;
    }

    public static class NativeMethods
    {
        public const uint PM_REMOVE = 0x0001;

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool PeekMessage(out NativeMessage message, IntPtr window, uint min, uint max, uint remove);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool TranslateMessage(ref NativeMessage message);

        [DllImport("user32.dll")]
        public static extern IntPtr DispatchMessage(ref NativeMessage message);

        [DllImport("user32.dll")]
        public static extern uint GetClipboardSequenceNumber();
    }

    public static class CopyHotkeyMonitor
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_KEYUP = 0x0101;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_SYSKEYUP = 0x0105;
        private const int WM_QUIT = 0x0012;
        private const int VK_CONTROL = 0x11;
        private const int VK_SHIFT = 0x10;
        private const int VK_MENU = 0x12;
        private const int VK_LWIN = 0x5B;
        private const int VK_RWIN = 0x5C;
        private const int VK_C = 0x43;

        private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr message, IntPtr data);

        private static readonly object SyncRoot = new object();
        private static readonly LowLevelKeyboardProc HookProcedure = HookCallback;
        private static Thread worker;
        private static ManualResetEventSlim ready;
        private static Exception startupError;
        private static IntPtr hookHandle;
        private static uint workerThreadId;
        private static int cIsDown;
        private static int copyPending;
        private static uint clipboardSequence;

        public static void Start()
        {
            ManualResetEventSlim startupSignal;
            lock (SyncRoot)
            {
                if (worker != null)
                    return;

                startupError = null;
                ready = new ManualResetEventSlim(false);
                startupSignal = ready;
                worker = new Thread(RunMessageLoop);
                worker.Name = "ClipRelay Ctrl+C monitor";
                worker.IsBackground = true;
                worker.SetApartmentState(ApartmentState.STA);
                worker.Start();
            }

            startupSignal.Wait();
            if (startupError != null)
            {
                lock (SyncRoot)
                    worker = null;
                throw new InvalidOperationException("Cannot install the Ctrl+C keyboard monitor.", startupError);
            }
        }

        public static void Stop()
        {
            Thread thread;
            uint threadId;
            lock (SyncRoot)
            {
                thread = worker;
                threadId = workerThreadId;
            }

            if (thread == null)
                return;

            if (threadId != 0)
                PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            if (Thread.CurrentThread != thread)
                thread.Join(2000);

            lock (SyncRoot)
            {
                worker = null;
                workerThreadId = 0;
                if (ready != null)
                {
                    ready.Dispose();
                    ready = null;
                }
            }
        }

        public static bool TryTakeCopy(out uint sequence)
        {
            if (Interlocked.Exchange(ref copyPending, 0) == 0)
            {
                sequence = 0;
                return false;
            }

            sequence = clipboardSequence;
            return true;
        }

        private static void RunMessageLoop()
        {
            workerThreadId = GetCurrentThreadId();
            hookHandle = SetWindowsHookEx(WH_KEYBOARD_LL, HookProcedure, GetModuleHandle(null), 0);
            if (hookHandle == IntPtr.Zero)
            {
                startupError = new Win32Exception(Marshal.GetLastWin32Error());
                ready.Set();
                return;
            }

            ready.Set();
            try
            {
                NativeMessage message;
                while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
                {
                    NativeMethods.TranslateMessage(ref message);
                    NativeMethods.DispatchMessage(ref message);
                }
            }
            finally
            {
                if (hookHandle != IntPtr.Zero)
                {
                    UnhookWindowsHookEx(hookHandle);
                    hookHandle = IntPtr.Zero;
                }
                workerThreadId = 0;
            }
        }

        private static IntPtr HookCallback(int code, IntPtr message, IntPtr data)
        {
            try
            {
                if (code >= 0)
                {
                    int virtualKey = Marshal.ReadInt32(data);
                    int keyboardMessage = message.ToInt32();
                    if (virtualKey == VK_C)
                    {
                        if (keyboardMessage == WM_KEYUP || keyboardMessage == WM_SYSKEYUP)
                        {
                            Interlocked.Exchange(ref cIsDown, 0);
                        }
                        else if ((keyboardMessage == WM_KEYDOWN || keyboardMessage == WM_SYSKEYDOWN) &&
                                 Interlocked.Exchange(ref cIsDown, 1) == 0 &&
                                 IsKeyDown(VK_CONTROL) && !IsKeyDown(VK_SHIFT) &&
                                 !IsKeyDown(VK_MENU) && !IsKeyDown(VK_LWIN) && !IsKeyDown(VK_RWIN))
                        {
                            clipboardSequence = NativeMethods.GetClipboardSequenceNumber();
                            Interlocked.Exchange(ref copyPending, 1);
                        }
                    }
                }
            }
            catch
            {
                // A low-level hook must always return promptly to Windows.
            }

            return CallNextHookEx(hookHandle, code, message, data);
        }

        private static bool IsKeyDown(int virtualKey)
        {
            return (GetAsyncKeyState(virtualKey) & 0x8000) != 0;
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int hookType, LowLevelKeyboardProc callback, IntPtr module, uint threadId);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hook);

        [DllImport("user32.dll")]
        private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int virtualKey);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PostThreadMessage(uint threadId, uint message, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetMessage(out NativeMessage message, IntPtr window, uint min, uint max);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string moduleName);
    }
}
"@
}

function Get-PropertyValue {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object) {
        return $null
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function Get-NormalizedPeerAddress {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Peer host or IP address cannot be empty."
    }

    $normalized = $Value.Trim()
    if ($normalized.Contains("://") -or $normalized.Contains("/") -or $normalized.Contains("\")) {
        throw "Peer must be a host name or IP address without a scheme, port, or path."
    }

    return $normalized
}

function Set-ActivePeerAddress {
    param([string]$Value)

    $normalized = Get-NormalizedPeerAddress -Value $Value
    $uriBuilder = New-Object System.UriBuilder("http", $normalized, $script:Port, "push")
    $script:Peer = $normalized
    $script:pushUri = $uriBuilder.Uri
}

function Get-LocalLanIPv4Addresses {
    $candidates = @()
    foreach ($networkInterface in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($networkInterface.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up -or
            $networkInterface.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback -or
            $networkInterface.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Tunnel) {
            continue
        }

        try {
            $properties = $networkInterface.GetIPProperties()
            $hasDefaultGateway = @($properties.GatewayAddresses | Where-Object {
                $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
                -not $_.Address.Equals([System.Net.IPAddress]::Any)
            }).Count -gt 0

            foreach ($unicastAddress in $properties.UnicastAddresses) {
                $address = $unicastAddress.Address
                if ($address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
                    continue
                }

                $text = $address.ToString()
                if ($text -eq "0.0.0.0" -or $text.StartsWith("127.") -or $text.StartsWith("169.254.")) {
                    continue
                }

                $candidates += [PSCustomObject]@{
                    Address           = $text
                    HasDefaultGateway = $hasDefaultGateway
                    InterfaceName     = $networkInterface.Name
                }
            }
        }
        catch {
            # Ignore adapters that disappear while the list is being read.
        }
    }

    return @($candidates |
        Sort-Object @{ Expression = { if ($_.HasDefaultGateway) { 0 } else { 1 } } }, InterfaceName, Address |
        Select-Object -ExpandProperty Address -Unique)
}

$configPath = Join-Path $PSScriptRoot "config.json"
$configuration = $null
if (Test-Path -LiteralPath $configPath) {
    try {
        $configuration = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Cannot read config file $configPath`: $($_.Exception.Message)"
    }
}

if ([string]::IsNullOrWhiteSpace($Peer)) {
    $Peer = [string](Get-PropertyValue -Object $configuration -Name "peer")
}
if ([string]::IsNullOrWhiteSpace($Peer)) {
    $Peer = "peer-device.local"
}
$Peer = Get-NormalizedPeerAddress -Value $Peer

if ($Port -eq 0) {
    $configuredPort = Get-PropertyValue -Object $configuration -Name "port"
    if ($null -ne $configuredPort) {
        $Port = [int]$configuredPort
    }
}
if ($Port -eq 0) {
    $Port = 47632
}
if ($Port -lt 1 -or $Port -gt 65535) {
    throw "Port must be between 1 and 65535."
}

if ([System.Threading.Thread]::CurrentThread.ApartmentState -ne [System.Threading.ApartmentState]::STA) {
    throw "ClipRelay requires an STA thread. Start it with powershell.exe -STA -File cliprelay.ps1."
}

$pushUri = $null
Set-ActivePeerAddress -Value $Peer
$mutex = $null
$ownsMutex = $false
$listener = $null
$notifyIcon = $null
$trayMenu = $null
$peerMenuItem = $null
$copyMonitorStarted = $false
$stopRequested = $false
$configurationDialogOpen = $false

function Show-ClipRelayNotification {
    param(
        [string]$Title,
        [string]$Message,
        [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info
    )

    if ($null -eq $script:notifyIcon) {
        return
    }

    if ($Message.Length -gt 240) {
        $Message = $Message.Substring(0, 240)
    }
    $script:notifyIcon.ShowBalloonTip(3000, $Title, $Message, $Icon)
}

function Show-PeerConfiguration {
    if ($script:configurationDialogOpen) {
        return
    }

    $script:configurationDialogOpen = $true
    $form = $null
    try {
        $form = New-Object System.Windows.Forms.Form
        $form.Text = "ClipRelay settings"
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $form.ShowInTaskbar = $true
        $form.TopMost = $true
        $form.ClientSize = New-Object System.Drawing.Size(430, 238)

        $localIpLabel = New-Object System.Windows.Forms.Label
        $localIpLabel.Text = "This PC LAN IP (share with the peer):"
        $localIpLabel.AutoSize = $true
        $localIpLabel.Location = New-Object System.Drawing.Point(16, 16)

        $localIpBox = New-Object System.Windows.Forms.ComboBox
        $localIpBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
        $localIpBox.Location = New-Object System.Drawing.Point(19, 39)
        $localIpBox.Size = New-Object System.Drawing.Size(292, 24)

        $copyIpButton = New-Object System.Windows.Forms.Button
        $copyIpButton.Text = "Copy IP"
        $copyIpButton.Location = New-Object System.Drawing.Point(319, 38)
        $copyIpButton.Size = New-Object System.Drawing.Size(92, 27)

        $localAddresses = @(Get-LocalLanIPv4Addresses)
        if ($localAddresses.Count -gt 0) {
            $localIpBox.Items.AddRange([object[]]$localAddresses)
            $localIpBox.SelectedIndex = 0
        }
        else {
            $null = $localIpBox.Items.Add("No LAN IPv4 detected")
            $localIpBox.SelectedIndex = 0
            $copyIpButton.Enabled = $false
        }

        $peerLabel = New-Object System.Windows.Forms.Label
        $peerLabel.Text = "Peer host or LAN IP:"
        $peerLabel.AutoSize = $true
        $peerLabel.Location = New-Object System.Drawing.Point(16, 82)

        $peerTextBox = New-Object System.Windows.Forms.TextBox
        $peerTextBox.Text = $script:Peer
        $peerTextBox.Location = New-Object System.Drawing.Point(19, 105)
        $peerTextBox.Size = New-Object System.Drawing.Size(392, 24)

        $portLabel = New-Object System.Windows.Forms.Label
        $portLabel.Text = "Port: $script:Port    Changes take effect immediately after Save."
        $portLabel.AutoSize = $true
        $portLabel.ForeColor = [System.Drawing.SystemColors]::GrayText
        $portLabel.Location = New-Object System.Drawing.Point(16, 139)

        $saveButton = New-Object System.Windows.Forms.Button
        $saveButton.Text = "Save"
        $saveButton.Size = New-Object System.Drawing.Size(88, 30)
        $saveButton.Location = New-Object System.Drawing.Point(227, 188)

        $cancelButton = New-Object System.Windows.Forms.Button
        $cancelButton.Text = "Cancel"
        $cancelButton.Size = New-Object System.Drawing.Size(88, 30)
        $cancelButton.Location = New-Object System.Drawing.Point(323, 188)
        $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

        $copyIpButton.Add_Click({
            if ($localAddresses.Count -gt 0 -and $localIpBox.SelectedIndex -ge 0) {
                Set-ClipboardTextWithRetry -Text ([string]$localIpBox.SelectedItem)
                $copyIpButton.Text = "Copied!"
            }
        })
        $localIpBox.Add_SelectedIndexChanged({ $copyIpButton.Text = "Copy IP" })

        $saveButton.Add_Click({
            try {
                $normalized = Get-NormalizedPeerAddress -Value $peerTextBox.Text
                $newUriBuilder = New-Object System.UriBuilder("http", $normalized, $script:Port, "push")
                $configuration = [ordered]@{
                    peer = $normalized
                    port = $script:Port
                }
                $configuration | ConvertTo-Json | Set-Content -LiteralPath $script:configPath -Encoding UTF8

                $script:Peer = $normalized
                $script:pushUri = $newUriBuilder.Uri
                if ($null -ne $script:peerMenuItem) {
                    $script:peerMenuItem.Text = "Peer: $normalized`:$script:Port"
                }

                Show-ClipRelayNotification -Title "ClipRelay settings saved" -Message "Peer changed to $normalized`:$script:Port."
                $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
                $form.Close()
            }
            catch {
                $null = [System.Windows.Forms.MessageBox]::Show(
                    $form,
                    $_.Exception.Message,
                    "Invalid peer address",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Warning
                )
            }
        })

        $form.AcceptButton = $saveButton
        $form.CancelButton = $cancelButton
        $form.Controls.AddRange(@(
            $localIpLabel,
            $localIpBox,
            $copyIpButton,
            $peerLabel,
            $peerTextBox,
            $portLabel,
            $saveButton,
            $cancelButton
        ))
        $form.Add_Shown({
            $peerTextBox.Focus()
            $peerTextBox.SelectAll()
        })

        $null = $form.ShowDialog()
    }
    finally {
        if ($null -ne $form) {
            $form.Dispose()
        }
        $script:configurationDialogOpen = $false
    }
}

function Get-ClipboardTextWithRetry {
    $lastError = $null
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            if (-not [System.Windows.Forms.Clipboard]::ContainsText()) {
                return $null
            }
            return [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)
        }
        catch {
            $lastError = $_
            Start-Sleep -Milliseconds 20
        }
    }

    throw "Cannot read the selected text: $($lastError.Exception.Message)"
}

function Set-ClipboardTextWithRetry {
    param([string]$Text)

    $lastError = $null
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            [System.Windows.Forms.Clipboard]::SetText($Text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
            return
        }
        catch {
            $lastError = $_
            Start-Sleep -Milliseconds 20
        }
    }

    throw "Cannot write to the clipboard: $($lastError.Exception.Message)"
}

function Send-TextToPeer {
    param([string]$Text)

    $json = @{ text = $Text } | ConvertTo-Json -Compress
    $body = [System.Text.Encoding]::UTF8.GetBytes($json)
    $request = [System.Net.HttpWebRequest]::Create($script:pushUri)
    $request.Method = "POST"
    $request.ContentType = "application/json; charset=utf-8"
    $request.ContentLength = $body.Length
    $request.Timeout = 5000
    $request.ReadWriteTimeout = 5000
    $request.KeepAlive = $false
    $request.Proxy = $null
    $request.ServicePoint.Expect100Continue = $false

    $requestStream = $null
    $response = $null
    try {
        $requestStream = $request.GetRequestStream()
        $requestStream.Write($body, 0, $body.Length)
        $requestStream.Close()
        $requestStream = $null

        $response = [System.Net.HttpWebResponse]$request.GetResponse()
        if ([int]$response.StatusCode -ne 200) {
            throw "The peer returned HTTP $([int]$response.StatusCode)."
        }
    }
    finally {
        if ($null -ne $requestStream) {
            $requestStream.Dispose()
        }
        if ($null -ne $response) {
            $response.Dispose()
        }
    }
}

function Send-CopiedClipboard {
    param([uint32]$PreviousSequence)

    try {
        $clipboardChanged = $false
        for ($attempt = 0; $attempt -lt 75; $attempt++) {
            if ([ClipRelay.NativeMethods]::GetClipboardSequenceNumber() -ne $PreviousSequence) {
                $clipboardChanged = $true
                break
            }
            Start-Sleep -Milliseconds 20
        }

        if (-not $clipboardChanged) {
            return
        }

        $copiedText = Get-ClipboardTextWithRetry
        if ([string]::IsNullOrEmpty($copiedText)) {
            return
        }

        Send-TextToPeer -Text $copiedText
    }
    catch {
        Show-ClipRelayNotification -Title "ClipRelay send failed" -Message $_.Exception.Message -Icon Error
    }
}

function Read-HttpRequest {
    param([System.Net.Sockets.TcpClient]$Client)

    $Client.ReceiveTimeout = 5000
    $Client.SendTimeout = 5000
    $stream = $Client.GetStream()
    $headerBytes = New-Object "System.Collections.Generic.List[byte]"

    while ($headerBytes.Count -lt 16384) {
        $next = $stream.ReadByte()
        if ($next -lt 0) {
            throw "The connection closed before the request headers were complete."
        }
        $headerBytes.Add([byte]$next)

        $count = $headerBytes.Count
        if ($count -ge 4 -and
            $headerBytes[$count - 4] -eq 13 -and
            $headerBytes[$count - 3] -eq 10 -and
            $headerBytes[$count - 2] -eq 13 -and
            $headerBytes[$count - 1] -eq 10) {
            break
        }
    }

    if ($headerBytes.Count -ge 16384) {
        throw "The request headers are too large."
    }

    $headerText = [System.Text.Encoding]::ASCII.GetString($headerBytes.ToArray())
    $headerText = $headerText.Substring(0, $headerText.Length - 4)
    $lines = $headerText -split "`r`n"
    if ($lines.Count -lt 1) {
        throw "The request line is missing."
    }

    $requestLine = $lines[0] -split " "
    if ($requestLine.Count -lt 3) {
        throw "The request line is invalid."
    }

    $headers = @{}
    for ($index = 1; $index -lt $lines.Count; $index++) {
        $separator = $lines[$index].IndexOf(":")
        if ($separator -le 0) {
            continue
        }
        $name = $lines[$index].Substring(0, $separator).Trim()
        $value = $lines[$index].Substring($separator + 1).Trim()
        $headers[$name] = $value
    }

    if (-not $headers.ContainsKey("Content-Length")) {
        throw "Content-Length is missing."
    }

    $contentLength = 0
    if (-not [int]::TryParse([string]$headers["Content-Length"], [ref]$contentLength) -or
        $contentLength -lt 0 -or $contentLength -gt 1048576) {
        throw "Content-Length is invalid or the body exceeds 1 MiB."
    }

    $bodyBytes = New-Object byte[] $contentLength
    $offset = 0
    while ($offset -lt $contentLength) {
        $read = $stream.Read($bodyBytes, $offset, $contentLength - $offset)
        if ($read -le 0) {
            throw "The connection closed before the request body was complete."
        }
        $offset += $read
    }

    return [PSCustomObject]@{
        Method = $requestLine[0]
        Path   = $requestLine[1]
        Body   = [System.Text.Encoding]::UTF8.GetString($bodyBytes)
        Stream = $stream
    }
}

function Send-HttpResponse {
    param(
        [System.IO.Stream]$Stream,
        [int]$StatusCode,
        [string]$Reason,
        [string]$Body
    )

    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $header = "HTTP/1.1 $StatusCode $Reason`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($bodyBytes.Length)`r`nConnection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    $Stream.Write($bodyBytes, 0, $bodyBytes.Length)
    $Stream.Flush()
}

function Handle-Client {
    param([System.Net.Sockets.TcpClient]$Client)

    $request = $null
    try {
        $request = Read-HttpRequest -Client $Client
    }
    catch {
        try {
            Send-HttpResponse -Stream $Client.GetStream() -StatusCode 400 -Reason "Bad Request" -Body "bad request"
        }
        catch {
        }
        return
    }

    if ($request.Method -ne "POST" -or $request.Path -ne "/push") {
        Send-HttpResponse -Stream $request.Stream -StatusCode 404 -Reason "Not Found" -Body "not found"
        return
    }

    try {
        $data = $request.Body | ConvertFrom-Json
        $textProperty = $data.PSObject.Properties["text"]
        if ($null -eq $textProperty -or -not ($textProperty.Value -is [string]) -or
            [string]::IsNullOrEmpty([string]$textProperty.Value)) {
            throw "The text field is missing or invalid."
        }
        $text = [string]$textProperty.Value
    }
    catch {
        Send-HttpResponse -Stream $request.Stream -StatusCode 400 -Reason "Bad Request" -Body "bad request"
        return
    }

    try {
        Set-ClipboardTextWithRetry -Text $text
        Send-HttpResponse -Stream $request.Stream -StatusCode 200 -Reason "OK" -Body "ok"
        Show-ClipRelayNotification -Title "ClipRelay received text" -Message $text
    }
    catch {
        try {
            Send-HttpResponse -Stream $request.Stream -StatusCode 500 -Reason "Internal Server Error" -Body "clipboard error"
        }
        catch {
        }
    }
}

function Process-WindowsMessages {
    $message = New-Object ClipRelay.NativeMessage
    while ([ClipRelay.NativeMethods]::PeekMessage([ref]$message, [IntPtr]::Zero, 0, 0, [ClipRelay.NativeMethods]::PM_REMOVE)) {
        $null = [ClipRelay.NativeMethods]::TranslateMessage([ref]$message)
        $null = [ClipRelay.NativeMethods]::DispatchMessage([ref]$message)
    }
}

try {
    $createdNew = $false
    $mutexName = "Local\ClipRelay-$Port"
    $mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
    if (-not $createdNew) {
        throw "ClipRelay is already running on port $Port."
    }
    $ownsMutex = $true

    $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
    $notifyIcon.Icon = [System.Drawing.SystemIcons]::Information
    $notifyIcon.Text = "ClipRelay - Ctrl+C copies and sends"
    $trayMenu = New-Object System.Windows.Forms.ContextMenuStrip
    $configureMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("Configure peer...")
    $configureMenuItem.Add_Click({ Show-PeerConfiguration })
    $peerMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("Peer: $Peer`:$Port")
    $peerMenuItem.Enabled = $false
    $exitMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("Exit ClipRelay")
    $exitMenuItem.Add_Click({ $script:stopRequested = $true })
    $null = $trayMenu.Items.Add($configureMenuItem)
    $null = $trayMenu.Items.Add($peerMenuItem)
    $null = $trayMenu.Items.Add($exitMenuItem)
    $notifyIcon.ContextMenuStrip = $trayMenu
    $notifyIcon.Add_MouseClick({
        param($sender, $eventArgs)
        if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            Show-PeerConfiguration
        }
    })
    $notifyIcon.Visible = $true

    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $Port)
    $listener.Start()
    $acceptTask = $listener.AcceptTcpClientAsync()
    [ClipRelay.CopyHotkeyMonitor]::Start()
    $copyMonitorStarted = $true

    Write-Host "ClipRelay for Windows started: listening on port $Port, peer $Peer"
    Show-ClipRelayNotification -Title "ClipRelay started" -Message "Ctrl+C now copies locally and sends to the peer. Listening on port $Port."

    while (-not $stopRequested) {
        Process-WindowsMessages

        $copySequence = [uint32]0
        if ([ClipRelay.CopyHotkeyMonitor]::TryTakeCopy([ref]$copySequence)) {
            Send-CopiedClipboard -PreviousSequence $copySequence
        }

        if ($acceptTask.IsCompleted) {
            $client = $null
            try {
                $client = $acceptTask.GetAwaiter().GetResult()
                Handle-Client -Client $client
            }
            finally {
                if ($null -ne $client) {
                    $client.Dispose()
                }
            }
            $acceptTask = $listener.AcceptTcpClientAsync()
        }

        Start-Sleep -Milliseconds 25
    }
}
finally {
    if ($copyMonitorStarted) {
        [ClipRelay.CopyHotkeyMonitor]::Stop()
    }
    if ($null -ne $listener) {
        $listener.Stop()
    }
    if ($null -ne $notifyIcon) {
        $notifyIcon.Visible = $false
        $notifyIcon.Dispose()
    }
    if ($null -ne $trayMenu) {
        $trayMenu.Dispose()
    }
    if ($ownsMutex -and $null -ne $mutex) {
        $mutex.ReleaseMutex()
    }
    if ($null -ne $mutex) {
        $mutex.Dispose()
    }
}
