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
        public const int SW_SHOW = 5;

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

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool ShowWindow(IntPtr window, int command);
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
        throw "对方主机名或 IP 地址不能为空。"
    }

    $normalized = $Value.Trim()
    if ($normalized.Contains("://") -or $normalized.Contains("/") -or $normalized.Contains("\")) {
        throw "设备地址只需填写主机名或 IP（无需包含 http://、端口或路径）。"
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

function Get-LocalShareableAddresses {
    $addresses = @()
    try {
        $hostName = [System.Net.Dns]::GetHostName()
        if (-not [string]::IsNullOrWhiteSpace($hostName)) {
            $addresses += "$hostName.local"
        }
    }
    catch {
    }

    $ipAddresses = Get-LocalLanIPv4Addresses
    if ($null -ne $ipAddresses) {
        $addresses += $ipAddresses
    }

    return @($addresses | Select-Object -Unique)
}

function Resolve-TargetAddress {
    param([string]$Address)

    try {
        $ip = $null
        if ([System.Net.IPAddress]::TryParse($Address, [ref]$ip)) {
            return $Address
        }

        $addresses = [System.Net.Dns]::GetHostAddresses($Address)
        $ipv4 = $addresses | Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } | Select-Object -First 1
        if ($null -ne $ipv4) {
            return $ipv4.ToString()
        }

        $first = $addresses | Select-Object -First 1
        if ($null -ne $first) {
            return $first.ToString()
        }
    }
    catch {
    }

    return $Address
}

function Test-PeerConnectivity {
    param(
        [string]$Address,
        [int]$Port = 47632,
        [int]$TimeoutMilliseconds = 2500
    )

    $normalized = Get-NormalizedPeerAddress -Value $Address
    $targetAddress = Resolve-TargetAddress -Address $normalized
    $tcpClient = New-Object System.Net.Sockets.TcpClient
    try {
        $asyncResult = $tcpClient.BeginConnect($targetAddress, $Port, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            throw "连接超时（$([math]::Round($TimeoutMilliseconds / 1000, 1))秒）。请确认对方设备已开机、在同一 Wi-Fi/局域网，且防火墙已放行端口 $Port。"
        }
        $tcpClient.EndConnect($asyncResult)
        return "连接成功：对端设备在线且端口 $Port 响应正常。"
    }
    catch {
        $msg = $_.Exception.Message
        if ($_.Exception.InnerException) {
            $msg = $_.Exception.InnerException.Message
        }
        if ($msg -like "*actively refused*" -or $msg -like "*拒绝*") {
            $msg = "连接被拒绝：对方设备在线，但未运行 ClipRelay 服务或端口 $Port 未开放。"
        }
        elseif ($msg -like "*No such host*" -or $msg -like "*not known*" -or $msg -like "*找不到*") {
            $msg = "找不到主机：无法解析设备名 '$normalized'。请检查拼写，或直接输入对方的局域网 IP。"
        }
        elseif ($msg -like "*unreachable*" -or $msg -like "*不可达*") {
            $msg = "网络不可达：请检查本机与对方设备是否连接在同一个 Wi-Fi 或路由器。"
        }
        throw $msg
    }
    finally {
        try {
            $tcpClient.Close()
        }
        catch {
        }
    }
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
$appIcon = $null
$trayMenu = $null
$peerMenuItem = $null
$copyMonitorStarted = $false
$stopRequested = $false
$configurationDialogOpen = $false

function Get-ClipRelayIcon {
    $candidatePaths = @()
    if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        $candidatePaths += (Join-Path $PSScriptRoot "cliprelay.ico")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $candidatePaths += (Join-Path (Join-Path $env:LOCALAPPDATA "ClipRelay") "cliprelay.ico")
    }

    foreach ($path in $candidatePaths) {
        if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path -LiteralPath $path)) {
            try {
                return New-Object System.Drawing.Icon($path)
            }
            catch {
            }
        }
    }

    try {
        $embeddedBase64 = @"
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
"@
        $bytes = [System.Convert]::FromBase64String($embeddedBase64.Trim())
        $stream = New-Object System.IO.MemoryStream(,$bytes)
        return New-Object System.Drawing.Icon($stream)
    }
    catch {
        return [System.Drawing.SystemIcons]::Application
    }
}

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
        [System.Windows.Forms.Application]::EnableVisualStyles()

        $form = New-Object System.Windows.Forms.Form
        $form.Text = "ClipRelay 设置"
        $baseFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.0, [System.Drawing.FontStyle]::Regular)
        $form.Font = $baseFont
        $form.BackColor = [System.Drawing.Color]::FromArgb(250, 251, 252)
        if ($null -ne $script:appIcon) {
            $form.Icon = $script:appIcon
        }
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $form.ShowInTaskbar = $true
        $form.TopMost = $true
        $form.ClientSize = New-Object System.Drawing.Size(460, 426)

        # Header Title & Subtitle
        $headerTitle = New-Object System.Windows.Forms.Label
        $headerTitle.Text = "ClipRelay 局域网剪贴板同步"
        $headerTitle.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 11.0, [System.Drawing.FontStyle]::Bold)
        $headerTitle.ForeColor = [System.Drawing.Color]::FromArgb(30, 41, 59)
        $headerTitle.Location = New-Object System.Drawing.Point(18, 14)
        $headerTitle.AutoSize = $true

        $headerSubtitle = New-Object System.Windows.Forms.Label
        $headerSubtitle.Text = "支持 Windows / Mac / Android 设备间实时同步剪贴板文本"
        $headerSubtitle.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 8.5, [System.Drawing.FontStyle]::Regular)
        $headerSubtitle.ForeColor = [System.Drawing.Color]::FromArgb(100, 116, 139)
        $headerSubtitle.Location = New-Object System.Drawing.Point(18, 38)
        $headerSubtitle.AutoSize = $true

        $headerDivider = New-Object System.Windows.Forms.Panel
        $headerDivider.Location = New-Object System.Drawing.Point(18, 62)
        $headerDivider.Size = New-Object System.Drawing.Size(424, 1)
        $headerDivider.BackColor = [System.Drawing.Color]::FromArgb(226, 232, 240)

        # Section 1: This PC Local Address
        $localAddressLabel = New-Object System.Windows.Forms.Label
        $localAddressLabel.Text = "本机设备地址（发给对方填入）："
        $localAddressLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.0, [System.Drawing.FontStyle]::Bold)
        $localAddressLabel.ForeColor = [System.Drawing.Color]::FromArgb(51, 65, 85)
        $localAddressLabel.AutoSize = $true
        $localAddressLabel.Location = New-Object System.Drawing.Point(18, 74)

        $localAddressBox = New-Object System.Windows.Forms.ComboBox
        $localAddressBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
        $localAddressBox.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.0, [System.Drawing.FontStyle]::Regular)
        $localAddressBox.Location = New-Object System.Drawing.Point(18, 98)
        $localAddressBox.Size = New-Object System.Drawing.Size(316, 26)

        $copyButton = New-Object System.Windows.Forms.Button
        $copyButton.Text = "复制"
        $copyButton.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.0, [System.Drawing.FontStyle]::Regular)
        $copyButton.Location = New-Object System.Drawing.Point(344, 97)
        $copyButton.Size = New-Object System.Drawing.Size(98, 28)
        $copyButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
        $copyButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
        $copyButton.BackColor = [System.Drawing.Color]::FromArgb(241, 245, 249)
        $copyButton.ForeColor = [System.Drawing.Color]::FromArgb(30, 41, 59)
        $copyButton.Cursor = [System.Windows.Forms.Cursors]::Hand

        $localAddresses = @(Get-LocalShareableAddresses)
        if ($localAddresses.Count -gt 0) {
            $localAddressBox.Items.AddRange([object[]]$localAddresses)
            $localAddressBox.SelectedIndex = 0
        }
        else {
            $null = $localAddressBox.Items.Add("未检测到局域网地址")
            $localAddressBox.SelectedIndex = 0
            $copyButton.Enabled = $false
        }

        # Section 2: Peer Address Input
        $peerLabel = New-Object System.Windows.Forms.Label
        $peerLabel.Text = "对方设备地址（主机名或 IP）："
        $peerLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.0, [System.Drawing.FontStyle]::Bold)
        $peerLabel.ForeColor = [System.Drawing.Color]::FromArgb(51, 65, 85)
        $peerLabel.AutoSize = $true
        $peerLabel.Location = New-Object System.Drawing.Point(18, 136)

        $peerTextBox = New-Object System.Windows.Forms.TextBox
        $peerTextBox.Text = $script:Peer
        $peerTextBox.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5, [System.Drawing.FontStyle]::Regular)
        $peerTextBox.Location = New-Object System.Drawing.Point(18, 158)
        $peerTextBox.Size = New-Object System.Drawing.Size(316, 26)

        $testButton = New-Object System.Windows.Forms.Button
        $testButton.Text = "检测连接"
        $testButton.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.0, [System.Drawing.FontStyle]::Regular)
        $testButton.Location = New-Object System.Drawing.Point(344, 157)
        $testButton.Size = New-Object System.Drawing.Size(98, 28)
        $testButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
        $testButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(199, 210, 254)
        $testButton.BackColor = [System.Drawing.Color]::FromArgb(238, 242, 255)
        $testButton.ForeColor = [System.Drawing.Color]::FromArgb(79, 70, 229)
        $testButton.Cursor = [System.Windows.Forms.Cursors]::Hand

        $hintLabel = New-Object System.Windows.Forms.Label
        $hintLabel.Text = "提示：支持输入电脑名 (如 Alice-Mac.local) 或局域网 IP (如 192.168.1.119)"
        $hintLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 8.5, [System.Drawing.FontStyle]::Regular)
        $hintLabel.ForeColor = [System.Drawing.Color]::FromArgb(100, 116, 139)
        $hintLabel.AutoSize = $true
        $hintLabel.Location = New-Object System.Drawing.Point(18, 189)

        # Section 3: Connection Status Card
        $statusPanel = New-Object System.Windows.Forms.Panel
        $statusPanel.Location = New-Object System.Drawing.Point(18, 216)
        $statusPanel.Size = New-Object System.Drawing.Size(424, 88)
        $statusPanel.BackColor = [System.Drawing.Color]::FromArgb(255, 251, 235)
        $statusPanel.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle

        $statusTitleLabel = New-Object System.Windows.Forms.Label
        $statusTitleLabel.Location = New-Object System.Drawing.Point(12, 10)
        $statusTitleLabel.Size = New-Object System.Drawing.Size(398, 20)
        $statusTitleLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.0, [System.Drawing.FontStyle]::Bold)
        $statusTitleLabel.ForeColor = [System.Drawing.Color]::FromArgb(217, 119, 6)
        $statusTitleLabel.Text = "⏳ 正在检测与对方设备的连接状态..."
        $statusPanel.Controls.Add($statusTitleLabel)

        $statusDetailLabel = New-Object System.Windows.Forms.Label
        $statusDetailLabel.Location = New-Object System.Drawing.Point(12, 34)
        $statusDetailLabel.Size = New-Object System.Drawing.Size(398, 46)
        $statusDetailLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 8.5, [System.Drawing.FontStyle]::Regular)
        $statusDetailLabel.ForeColor = [System.Drawing.Color]::FromArgb(120, 53, 15)
        $statusDetailLabel.Text = "正在尝试连接..."
        $statusPanel.Controls.Add($statusDetailLabel)

        # Section 4: Footer
        $footerDivider = New-Object System.Windows.Forms.Panel
        $footerDivider.Location = New-Object System.Drawing.Point(18, 316)
        $footerDivider.Size = New-Object System.Drawing.Size(424, 1)
        $footerDivider.BackColor = [System.Drawing.Color]::FromArgb(226, 232, 240)

        $portLabel = New-Object System.Windows.Forms.Label
        $portLabel.Text = "服务端口: $script:Port    修改后点击保存立即生效"
        $portLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 8.5, [System.Drawing.FontStyle]::Regular)
        $portLabel.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
        $portLabel.AutoSize = $true
        $portLabel.Location = New-Object System.Drawing.Point(18, 330)

        $saveButton = New-Object System.Windows.Forms.Button
        $saveButton.Text = "保 存"
        $saveButton.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5, [System.Drawing.FontStyle]::Bold)
        $saveButton.Size = New-Object System.Drawing.Size(96, 34)
        $saveButton.Location = New-Object System.Drawing.Point(242, 368)
        $saveButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
        $saveButton.FlatAppearance.BorderSize = 0
        $saveButton.BackColor = [System.Drawing.Color]::FromArgb(37, 99, 235)
        $saveButton.ForeColor = [System.Drawing.Color]::White
        $saveButton.Cursor = [System.Windows.Forms.Cursors]::Hand

        $cancelButton = New-Object System.Windows.Forms.Button
        $cancelButton.Text = "取 消"
        $cancelButton.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5, [System.Drawing.FontStyle]::Regular)
        $cancelButton.Size = New-Object System.Drawing.Size(94, 34)
        $cancelButton.Location = New-Object System.Drawing.Point(348, 368)
        $cancelButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
        $cancelButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
        $cancelButton.BackColor = [System.Drawing.Color]::FromArgb(241, 245, 249)
        $cancelButton.ForeColor = [System.Drawing.Color]::FromArgb(51, 65, 85)
        $cancelButton.Cursor = [System.Windows.Forms.Cursors]::Hand
        $cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

        $runCheck = {
            $currentPeer = $peerTextBox.Text.Trim()
            if ([string]::IsNullOrWhiteSpace($currentPeer)) {
                $statusPanel.BackColor = [System.Drawing.Color]::FromArgb(243, 244, 246)
                $statusTitleLabel.ForeColor = [System.Drawing.Color]::FromArgb(107, 114, 128)
                $statusTitleLabel.Text = "○ 待检测：请输入对方设备地址并点击检测"
                $statusDetailLabel.ForeColor = [System.Drawing.Color]::FromArgb(107, 114, 128)
                $statusDetailLabel.Text = "输入对方主机名或 IP 后点击右侧【检测连接】。"
                return
            }

            $testButton.Enabled = $false
            $testButton.Text = "检测中..."
            $statusPanel.BackColor = [System.Drawing.Color]::FromArgb(255, 251, 235)
            $statusTitleLabel.ForeColor = [System.Drawing.Color]::FromArgb(217, 119, 6)
            $statusTitleLabel.Text = "⏳ 正在检测与对方设备的连接状态..."
            $statusDetailLabel.ForeColor = [System.Drawing.Color]::FromArgb(120, 53, 15)
            $statusDetailLabel.Text = "正在连接 $currentPeer`:$script:Port..."
            $form.Update()

            try {
                $null = Test-PeerConnectivity -Address $currentPeer -Port $script:Port -TimeoutMilliseconds 2500
                $statusPanel.BackColor = [System.Drawing.Color]::FromArgb(236, 253, 245)
                $statusTitleLabel.ForeColor = [System.Drawing.Color]::FromArgb(5, 150, 105)
                $statusTitleLabel.Text = "● 连接正常：对方设备在线且服务响应正常"
                $statusDetailLabel.ForeColor = [System.Drawing.Color]::FromArgb(6, 95, 70)
                $statusDetailLabel.Text = "本机接收服务：正常运行 (:$script:Port)  |  对端设备：$currentPeer`:$script:Port"
            }
            catch {
                $statusPanel.BackColor = [System.Drawing.Color]::FromArgb(254, 242, 242)
                $statusTitleLabel.ForeColor = [System.Drawing.Color]::FromArgb(220, 38, 38)
                $statusTitleLabel.Text = "● 无法连接：未能与对方设备建立通信"
                $statusDetailLabel.ForeColor = [System.Drawing.Color]::FromArgb(153, 27, 27)
                $statusDetailLabel.Text = "$($_.Exception.Message)"
            }
            finally {
                $testButton.Text = "检测连接"
                $testButton.Enabled = $true
            }
        }

        $copyButton.Add_Click({
            if ($localAddresses.Count -gt 0 -and $localAddressBox.SelectedIndex -ge 0) {
                Set-ClipboardTextWithRetry -Text ([string]$localAddressBox.SelectedItem)
                $copyButton.Text = "✓ 已复制!"
                $copyButton.ForeColor = [System.Drawing.Color]::FromArgb(5, 150, 105)
            }
        })
        $localAddressBox.Add_SelectedIndexChanged({
            $copyButton.Text = "复制"
            $copyButton.ForeColor = [System.Drawing.Color]::FromArgb(30, 41, 59)
        })

        $testButton.Add_Click($runCheck)

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
                    $script:peerMenuItem.Text = "对方设备: $normalized`:$script:Port"
                }

                Show-ClipRelayNotification -Title "ClipRelay 设置已保存" -Message "已将对方地址更新为 $normalized`:$script:Port。"
                $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
                $form.Close()
            }
            catch {
                $null = [System.Windows.Forms.MessageBox]::Show(
                    $form,
                    $_.Exception.Message,
                    "无效的设备地址",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Warning
                )
            }
        })

        $form.AcceptButton = $saveButton
        $form.CancelButton = $cancelButton
        $form.Controls.AddRange(@(
            $headerTitle,
            $headerSubtitle,
            $headerDivider,
            $localAddressLabel,
            $localAddressBox,
            $copyButton,
            $peerLabel,
            $peerTextBox,
            $testButton,
            $hintLabel,
            $statusPanel,
            $footerDivider,
            $portLabel,
            $saveButton,
            $cancelButton
        ))
        $form.Add_Shown({
            # A process launched with `-WindowStyle Hidden` can also hide the
            # first top-level WinForms window. Explicitly show the dialog once
            # its handle exists so the tray-only startup remains invisible
            # without suppressing the settings window.
            $null = [ClipRelay.NativeMethods]::ShowWindow(
                $form.Handle,
                [ClipRelay.NativeMethods]::SW_SHOW
            )
            $null = $form.Activate()
            $peerTextBox.Focus()
            $peerTextBox.SelectAll()
            if (-not [string]::IsNullOrWhiteSpace($peerTextBox.Text)) {
                & $runCheck
            }
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

    $normalizedPeer = $script:Peer
    $targetAddress = Resolve-TargetAddress -Address $normalizedPeer
    $targetUri = "http://$targetAddress`:$($script:Port)/push"

    $json = @{ text = $Text } | ConvertTo-Json -Compress
    $body = [System.Text.Encoding]::UTF8.GetBytes($json)
    $request = [System.Net.HttpWebRequest]::Create($targetUri)
    $request.Method = "POST"
    if ($normalizedPeer -ne $targetAddress) {
        $request.Host = "$normalizedPeer`:$($script:Port)"
    }
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
        $msg = $_.Exception.Message
        if ($_.Exception.InnerException) {
            $msg = $_.Exception.InnerException.Message
        }
        if ($msg -like "*超时*" -or $msg -like "*timed out*") {
            $msg = "连接对端设备 $script:Peer`:$script:Port 超时，请确认对方设备在线且在同一局域网。"
        }
        elseif ($msg -like "*拒绝*" -or $msg -like "*refused*") {
            $msg = "对端设备 $script:Peer`:$script:Port 拒绝连接，对方可能未开启 ClipRelay 服务。"
        }
        elseif ($msg -like "*找不到*" -or $msg -like "*not known*" -or $msg -like "*No such host*") {
            $msg = "无法解析对端主机名 $script:Peer，请检查网络或在设置中改用局域网 IP。"
        }
        Show-ClipRelayNotification -Title "ClipRelay 发送失败" -Message $msg -Icon Warning
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

    $script:appIcon = Get-ClipRelayIcon
    $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
    $notifyIcon.Icon = $script:appIcon
    $notifyIcon.Text = "ClipRelay 局域网剪贴板同步"
    $trayMenu = New-Object System.Windows.Forms.ContextMenuStrip
    $trayMenu.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.0, [System.Drawing.FontStyle]::Regular)

    $configureMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("⚙️ 设置 / 配置对方设备...")
    $configureMenuItem.Add_Click({ Show-PeerConfiguration })

    $checkStatusMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("🔍 检测连接状态")
    $checkStatusMenuItem.Add_Click({
        try {
            $msg = Test-PeerConnectivity -Address $script:Peer -Port $script:Port -TimeoutMilliseconds 2500
            Show-ClipRelayNotification -Title "ClipRelay: 连接正常" -Message "对端设备 ($script:Peer`:$script:Port) 在线且服务响应正常。" -Icon Info
        }
        catch {
            Show-ClipRelayNotification -Title "ClipRelay: 无法连接" -Message "$($_.Exception.Message)" -Icon Warning
        }
    })

    $peerMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("📡 对方: $Peer`:$Port")
    $peerMenuItem.Enabled = $false

    $exitMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("❌ 退出 ClipRelay")
    $exitMenuItem.Add_Click({ $script:stopRequested = $true })

    $null = $trayMenu.Items.Add($configureMenuItem)
    $null = $trayMenu.Items.Add($checkStatusMenuItem)
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

    Write-Host "ClipRelay Windows 端已启动: 监听端口 $Port, 对方设备 $Peer"
    Show-ClipRelayNotification -Title "ClipRelay 已启动" -Message "按 Ctrl+C 复制时将自动同步给对方。本机监听端口: $Port。"

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
    if ($null -ne $script:appIcon) {
        $script:appIcon.Dispose()
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
