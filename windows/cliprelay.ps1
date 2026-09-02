[CmdletBinding()]
param(
    [string]$Peer,

    [ValidateRange(0, 65535)]
    [int]$Port = 0,

    [switch]$OpenSettings
)

# ClipRelay Windows client. It implements the same protocol as the macOS and
# Android clients: POST /push with a UTF-8 JSON body such as {"text":"..."}.

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ("ClipRelay.NativeMethods" -as [type])) {
    $clipRelaySource = @"
using System;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

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

        public static void EnableBestDpiAwareness()
        {
            try
            {
                // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
                if (SetProcessDpiAwarenessContext(new IntPtr(-4)))
                    return;
            }
            catch (EntryPointNotFoundException)
            {
            }

            try
            {
                SetProcessDPIAware();
            }
            catch (EntryPointNotFoundException)
            {
            }
        }

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetProcessDPIAware();
    }

    public static class CopyHotkeyMonitor
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_KEYUP = 0x0101;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_SYSKEYUP = 0x0105;
        private const int WM_QUIT = 0x0012;
        private const int WM_HOTKEY = 0x0312;
        private const int VK_CONTROL = 0x11;
        private const int VK_SHIFT = 0x10;
        private const int VK_MENU = 0x12;
        private const int VK_LWIN = 0x5B;
        private const int VK_RWIN = 0x5C;
        private const int VK_C = 0x43;
        private const int VK_F12 = 0x7B;
        private const uint MOD_ALT = 0x0001;
        private const uint MOD_CONTROL = 0x0002;
        private const uint MOD_NOREPEAT = 0x4000;
        private const int SCREENSHOT_HOTKEY_ID = 0x4763;

        private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr message, IntPtr data);

        private static readonly object SyncRoot = new object();
        private static readonly LowLevelKeyboardProc HookProcedure = HookCallback;
        private static Thread worker;
        private static ManualResetEventSlim ready;
        private static Exception startupError;
        private static IntPtr hookHandle;
        private static uint workerThreadId;
        private static int cIsDown;
        private static int screenshotPending;
        private static bool screenshotHotkeyRegistered;
        private static string screenshotHotkeyError;
        private static readonly ConcurrentQueue<uint> CopyQueue = new ConcurrentQueue<uint>();

        public static void Start()
        {
            ManualResetEventSlim startupSignal;
            lock (SyncRoot)
            {
                if (worker != null)
                    return;

                startupError = null;
                screenshotHotkeyError = null;
                screenshotPending = 0;
                screenshotHotkeyRegistered = false;
                ready = new ManualResetEventSlim(false);
                startupSignal = ready;
                worker = new Thread(RunMessageLoop);
                worker.Name = "ClipRelay hotkey monitor";
                worker.IsBackground = true;
                worker.SetApartmentState(ApartmentState.STA);
                worker.Start();
            }

            startupSignal.Wait();
            if (startupError != null)
            {
                lock (SyncRoot)
                    worker = null;
                throw new InvalidOperationException("Cannot install the ClipRelay keyboard monitor.", startupError);
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
            return CopyQueue.TryDequeue(out sequence);
        }

        public static bool TryTakeScreenshot()
        {
            return Interlocked.Exchange(ref screenshotPending, 0) != 0;
        }

        public static bool ScreenshotHotkeyAvailable
        {
            get { return screenshotHotkeyRegistered; }
        }

        public static string ScreenshotHotkeyError
        {
            get { return screenshotHotkeyError; }
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

            screenshotHotkeyRegistered = RegisterHotKey(
                IntPtr.Zero,
                SCREENSHOT_HOTKEY_ID,
                MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
                VK_F12);
            if (!screenshotHotkeyRegistered)
            {
                screenshotHotkeyError = new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "Cannot register the Ctrl+Alt+F12 screenshot hotkey.").Message;
            }

            ready.Set();
            try
            {
                NativeMessage message;
                while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0)
                {
                    if (message.Message == WM_HOTKEY &&
                        message.WParam.ToInt32() == SCREENSHOT_HOTKEY_ID)
                    {
                        Interlocked.Exchange(ref screenshotPending, 1);
                    }
                    NativeMethods.TranslateMessage(ref message);
                    NativeMethods.DispatchMessage(ref message);
                }
            }
            finally
            {
                if (screenshotHotkeyRegistered)
                {
                    UnregisterHotKey(IntPtr.Zero, SCREENSHOT_HOTKEY_ID);
                    screenshotHotkeyRegistered = false;
                }
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
                            CopyQueue.Enqueue(NativeMethods.GetClipboardSequenceNumber());
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
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, int virtualKey);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnregisterHotKey(IntPtr window, int id);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern int GetMessage(out NativeMessage message, IntPtr window, uint min, uint max);

        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string moduleName);
    }

    public sealed class ScreenshotFrame
    {
        public ScreenshotFrame(byte[] bytes, int width, int height)
        {
            Bytes = bytes;
            Width = width;
            Height = height;
        }

        public byte[] Bytes { get; private set; }
        public int Width { get; private set; }
        public int Height { get; private set; }
    }

    public static class ScreenshotCapture
    {
        public static ScreenshotFrame CaptureVirtualDesktopJpeg(long quality)
        {
            if (quality < 1 || quality > 100)
                throw new ArgumentOutOfRangeException("quality");

            Rectangle bounds = SystemInformation.VirtualScreen;
            if (bounds.Width <= 0 || bounds.Height <= 0)
                throw new InvalidOperationException("Windows reported an empty virtual desktop.");

            using (Bitmap bitmap = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb))
            {
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    graphics.CopyFromScreen(
                        bounds.Left,
                        bounds.Top,
                        0,
                        0,
                        bounds.Size,
                        CopyPixelOperation.SourceCopy);
                }

                ImageCodecInfo jpegCodec = null;
                ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
                for (int index = 0; index < codecs.Length; index++)
                {
                    if (codecs[index].FormatID == ImageFormat.Jpeg.Guid)
                    {
                        jpegCodec = codecs[index];
                        break;
                    }
                }
                if (jpegCodec == null)
                    throw new InvalidOperationException("The Windows JPEG encoder is unavailable.");

                using (MemoryStream output = new MemoryStream())
                using (EncoderParameters encoderParameters = new EncoderParameters(1))
                {
                    encoderParameters.Param[0] = new EncoderParameter(Encoder.Quality, quality);
                    bitmap.Save(output, jpegCodec, encoderParameters);
                    return new ScreenshotFrame(output.ToArray(), bounds.Width, bounds.Height);
                }
            }
        }
    }

    public sealed class RelayTarget
    {
        public string Name { get; set; }
        public string Address { get; set; }
        public string Uri { get; set; }
        public string HostHeader { get; set; }
        public string AccessToken { get; set; }
    }

    public sealed class RelayDeliveryResult
    {
        public string Name { get; set; }
        public string Address { get; set; }
        public bool Success { get; set; }
        public int StatusCode { get; set; }
        public string ErrorKind { get; set; }
        public string ErrorMessage { get; set; }
        public long ElapsedMilliseconds { get; set; }
    }

    public static class RelayBroadcaster
    {
        public static RelayDeliveryResult[] SendText(
            RelayTarget[] targets,
            string json,
            int timeoutMilliseconds)
        {
            if (json == null)
                throw new ArgumentNullException("json");
            return Send(targets, "/push", "application/json; charset=utf-8",
                System.Text.Encoding.UTF8.GetBytes(json), timeoutMilliseconds, 0, 0);
        }

        public static RelayDeliveryResult[] SendImage(
            RelayTarget[] targets,
            byte[] jpegBytes,
            int width,
            int height,
            int timeoutMilliseconds)
        {
            if (jpegBytes == null)
                throw new ArgumentNullException("jpegBytes");
            return Send(targets, "/push-image", "image/jpeg", jpegBytes,
                timeoutMilliseconds, width, height);
        }

        private static RelayDeliveryResult[] Send(
            RelayTarget[] targets,
            string path,
            string contentType,
            byte[] body,
            int timeoutMilliseconds,
            int width,
            int height)
        {
            if (targets == null)
                throw new ArgumentNullException("targets");
            if (targets.Length == 0)
                return new RelayDeliveryResult[0];

            Task<RelayDeliveryResult>[] tasks = new Task<RelayDeliveryResult>[targets.Length];
            for (int index = 0; index < targets.Length; index++)
            {
                RelayTarget target = targets[index];
                tasks[index] = Task.Factory.StartNew(
                    () => Deliver(target, path, contentType, body, timeoutMilliseconds, width, height),
                    CancellationToken.None,
                    TaskCreationOptions.DenyChildAttach,
                    TaskScheduler.Default);
            }
            Task.WaitAll(tasks);

            RelayDeliveryResult[] results = new RelayDeliveryResult[tasks.Length];
            for (int index = 0; index < tasks.Length; index++)
                results[index] = tasks[index].Result;
            return results;
        }

        private static RelayDeliveryResult Deliver(
            RelayTarget target,
            string path,
            string contentType,
            byte[] body,
            int timeoutMilliseconds,
            int width,
            int height)
        {
            Stopwatch stopwatch = Stopwatch.StartNew();
            RelayDeliveryResult result = new RelayDeliveryResult
            {
                Name = target.Name,
                Address = target.Address,
                Success = false,
                StatusCode = 0,
                ErrorKind = String.Empty,
                ErrorMessage = String.Empty
            };

            HttpWebRequest request = null;
            HttpWebResponse response = null;
            Stream requestStream = null;
            try
            {
                request = (HttpWebRequest)WebRequest.Create(target.Uri.TrimEnd('/') + path);
                request.Method = "POST";
                request.ContentType = contentType;
                request.ContentLength = body.Length;
                request.Timeout = timeoutMilliseconds;
                request.ReadWriteTimeout = timeoutMilliseconds;
                request.KeepAlive = false;
                request.Proxy = null;
                request.ServicePoint.Expect100Continue = false;
                if (!String.IsNullOrWhiteSpace(target.HostHeader))
                    request.Host = target.HostHeader;
                if (!String.IsNullOrWhiteSpace(target.AccessToken))
                    request.Headers["X-ClipRelay-Token"] = target.AccessToken;
                if (width > 0)
                    request.Headers["X-ClipRelay-Width"] = width.ToString();
                if (height > 0)
                    request.Headers["X-ClipRelay-Height"] = height.ToString();

                requestStream = request.GetRequestStream();
                requestStream.Write(body, 0, body.Length);
                requestStream.Close();
                requestStream = null;
                response = (HttpWebResponse)request.GetResponse();
                result.StatusCode = (int)response.StatusCode;
                result.Success = result.StatusCode == 200;
                if (!result.Success)
                {
                    result.ErrorKind = "ProtocolError";
                    result.ErrorMessage = "HTTP " + result.StatusCode;
                }
            }
            catch (WebException exception)
            {
                result.ErrorKind = exception.Status.ToString();
                result.ErrorMessage = exception.Message;
                HttpWebResponse errorResponse = exception.Response as HttpWebResponse;
                if (errorResponse != null)
                {
                    result.StatusCode = (int)errorResponse.StatusCode;
                    errorResponse.Close();
                }
            }
            catch (Exception exception)
            {
                result.ErrorKind = exception.GetType().Name;
                result.ErrorMessage = exception.Message;
            }
            finally
            {
                if (requestStream != null)
                    requestStream.Dispose();
                if (response != null)
                    response.Close();
                stopwatch.Stop();
                result.ElapsedMilliseconds = stopwatch.ElapsedMilliseconds;
            }
            return result;
        }
    }

    internal static class RelayGeometry
    {
        public static GraphicsPath RoundedRectangle(Rectangle bounds, int radius)
        {
            GraphicsPath path = new GraphicsPath();
            int diameter = Math.Max(2, Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height)));
            Rectangle arc = new Rectangle(bounds.Location, new Size(diameter, diameter));
            path.AddArc(arc, 180, 90);
            arc.X = bounds.Right - diameter;
            path.AddArc(arc, 270, 90);
            arc.Y = bounds.Bottom - diameter;
            path.AddArc(arc, 0, 90);
            arc.X = bounds.Left;
            path.AddArc(arc, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    public sealed class RelayForm : Form
    {
        private const int WM_NCHITTEST = 0x0084;
        private const int HTCLIENT = 1;
        private const int HTCAPTION = 2;

        public RelayForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            DoubleBuffered = true;
            CornerRadius = 20;
        }

        public int CornerRadius { get; set; }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams parameters = base.CreateParams;
                parameters.ClassStyle |= 0x00020000; // CS_DROPSHADOW
                return parameters;
            }
        }

        protected override void OnResize(EventArgs eventArgs)
        {
            base.OnResize(eventArgs);
            if (Width <= 0 || Height <= 0)
                return;
            using (GraphicsPath path = RelayGeometry.RoundedRectangle(
                new Rectangle(0, 0, Width, Height), CornerRadius))
            {
                Region oldRegion = Region;
                Region = new Region(path);
                if (oldRegion != null)
                    oldRegion.Dispose();
            }
        }

        protected override void WndProc(ref Message message)
        {
            base.WndProc(ref message);
            if (message.Msg == WM_NCHITTEST && message.Result.ToInt32() == HTCLIENT)
            {
                int x = unchecked((short)(long)message.LParam);
                int y = unchecked((short)((long)message.LParam >> 16));
                Point clientPoint = PointToClient(new Point(x, y));
                if (clientPoint.Y >= 0 && clientPoint.Y < 76)
                    message.Result = new IntPtr(HTCAPTION);
            }
        }
    }

    public sealed class RelayPanel : Panel
    {
        public RelayPanel()
        {
            SetStyle(
                ControlStyles.UserPaint |
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw,
                true);
            CornerRadius = 14;
            BorderWidth = 1;
            BorderColor = Color.FromArgb(38, 73, 96);
        }

        public int CornerRadius { get; set; }
        public int BorderWidth { get; set; }
        public Color BorderColor { get; set; }

        protected override void OnPaintBackground(PaintEventArgs eventArgs)
        {
            eventArgs.Graphics.Clear(Parent == null ? BackColor : Parent.BackColor);
        }

        protected override void OnPaint(PaintEventArgs eventArgs)
        {
            eventArgs.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath path = RelayGeometry.RoundedRectangle(bounds, CornerRadius))
            using (SolidBrush fill = new SolidBrush(BackColor))
            {
                eventArgs.Graphics.FillPath(fill, path);
                if (BorderWidth > 0)
                {
                    using (Pen border = new Pen(BorderColor, BorderWidth))
                        eventArgs.Graphics.DrawPath(border, path);
                }
            }
            base.OnPaint(eventArgs);
        }
    }

    public sealed class RelayButton : Button
    {
        private bool hovering;
        private bool pressing;

        public RelayButton()
        {
            SetStyle(
                ControlStyles.UserPaint |
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw,
                true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            CornerRadius = 10;
            FillColor = Color.FromArgb(47, 128, 237);
            HoverColor = Color.FromArgb(74, 148, 245);
            PressedColor = Color.FromArgb(38, 105, 196);
            BorderColor = Color.Transparent;
            TextColor = Color.White;
            Cursor = Cursors.Hand;
            TabStop = true;
        }

        public int CornerRadius { get; set; }
        public Color FillColor { get; set; }
        public Color HoverColor { get; set; }
        public Color PressedColor { get; set; }
        public Color BorderColor { get; set; }
        public Color TextColor { get; set; }

        protected override void OnMouseEnter(EventArgs eventArgs)
        {
            hovering = true;
            Invalidate();
            base.OnMouseEnter(eventArgs);
        }

        protected override void OnMouseLeave(EventArgs eventArgs)
        {
            hovering = false;
            pressing = false;
            Invalidate();
            base.OnMouseLeave(eventArgs);
        }

        protected override void OnMouseDown(MouseEventArgs eventArgs)
        {
            pressing = true;
            Invalidate();
            base.OnMouseDown(eventArgs);
        }

        protected override void OnMouseUp(MouseEventArgs eventArgs)
        {
            pressing = false;
            Invalidate();
            base.OnMouseUp(eventArgs);
        }

        protected override void OnEnabledChanged(EventArgs eventArgs)
        {
            Invalidate();
            base.OnEnabledChanged(eventArgs);
        }

        protected override void OnPaint(PaintEventArgs eventArgs)
        {
            eventArgs.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            eventArgs.Graphics.Clear(Parent == null ? BackColor : Parent.BackColor);
            Color fillColor = pressing ? PressedColor : (hovering ? HoverColor : FillColor);
            if (!Enabled)
                fillColor = Color.FromArgb(51, fillColor);
            Rectangle bounds = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath path = RelayGeometry.RoundedRectangle(bounds, CornerRadius))
            using (SolidBrush fill = new SolidBrush(fillColor))
            {
                eventArgs.Graphics.FillPath(fill, path);
                if (BorderColor.A > 0)
                {
                    using (Pen border = new Pen(BorderColor, 1))
                        eventArgs.Graphics.DrawPath(border, path);
                }
            }
            Color textColor = Enabled ? TextColor : Color.FromArgb(120, TextColor);
            TextRenderer.DrawText(
                eventArgs.Graphics,
                Text,
                Font,
                ClientRectangle,
                textColor,
                TextFormatFlags.HorizontalCenter |
                TextFormatFlags.VerticalCenter |
                TextFormatFlags.SingleLine |
                TextFormatFlags.EndEllipsis);
            if (Focused && ShowFocusCues)
            {
                Rectangle focusBounds = Rectangle.Inflate(ClientRectangle, -4, -4);
                ControlPaint.DrawFocusRectangle(eventArgs.Graphics, focusBounds, textColor, fillColor);
            }
        }
    }

    public sealed class RelayToggle : CheckBox
    {
        public RelayToggle()
        {
            SetStyle(
                ControlStyles.UserPaint |
                ControlStyles.AllPaintingInWmPaint |
                ControlStyles.OptimizedDoubleBuffer |
                ControlStyles.ResizeRedraw,
                true);
            Size = new Size(44, 24);
            OnColor = Color.FromArgb(61, 214, 208);
            OffColor = Color.FromArgb(58, 83, 104);
            KnobColor = Color.White;
            Cursor = Cursors.Hand;
            TabStop = true;
            Text = String.Empty;
        }

        public Color OnColor { get; set; }
        public Color OffColor { get; set; }
        public Color KnobColor { get; set; }

        protected override void OnCheckedChanged(EventArgs eventArgs)
        {
            Invalidate();
            base.OnCheckedChanged(eventArgs);
        }

        protected override void OnPaint(PaintEventArgs eventArgs)
        {
            eventArgs.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            eventArgs.Graphics.Clear(Parent == null ? BackColor : Parent.BackColor);
            Rectangle trackBounds = new Rectangle(0, 1, Width - 1, Height - 3);
            using (GraphicsPath track = RelayGeometry.RoundedRectangle(trackBounds, trackBounds.Height / 2))
            using (SolidBrush trackBrush = new SolidBrush(Checked ? OnColor : OffColor))
                eventArgs.Graphics.FillPath(trackBrush, track);

            int knobSize = Height - 8;
            int knobX = Checked ? Width - knobSize - 4 : 4;
            using (SolidBrush knobBrush = new SolidBrush(KnobColor))
                eventArgs.Graphics.FillEllipse(knobBrush, knobX, 4, knobSize, knobSize);

            if (Focused && ShowFocusCues)
                ControlPaint.DrawFocusRectangle(eventArgs.Graphics, ClientRectangle);
        }
    }
}
"@
    Add-Type -TypeDefinition $clipRelaySource -ReferencedAssemblies @(
        "System.dll",
        "System.Core.dll",
        "System.Drawing.dll",
        "System.Windows.Forms.dll"
    )
}

[ClipRelay.NativeMethods]::EnableBestDpiAwareness()

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

function Get-NormalizedRelayPeers {
    param(
        [object[]]$Peers,
        [int]$DefaultPort = 47632,
        [string]$DefaultAccessToken = ""
    )

    $sourcePeers = @($Peers)
    if ($sourcePeers.Count -lt 1) {
        throw "至少需要添加一台接收设备。"
    }
    if ($sourcePeers.Count -gt 16) {
        throw "最多可以配置 16 台接收设备。"
    }

    $normalizedPeers = New-Object System.Collections.ArrayList
    $endpointKeys = @{}
    for ($index = 0; $index -lt $sourcePeers.Count; $index++) {
        $sourcePeer = $sourcePeers[$index]
        $address = Get-NormalizedPeerAddress -Value ([string](Get-PropertyValue -Object $sourcePeer -Name "address"))
        $name = [string](Get-PropertyValue -Object $sourcePeer -Name "name")
        if ([string]::IsNullOrWhiteSpace($name)) {
            $name = "设备 $($index + 1)"
        }
        else {
            $name = $name.Trim()
        }
        if ($name.Length -gt 32) {
            throw "设备名称不能超过 32 个字符。"
        }

        $peerPortValue = Get-PropertyValue -Object $sourcePeer -Name "port"
        $peerPort = if ($null -eq $peerPortValue -or [int]$peerPortValue -eq 0) { $DefaultPort } else { [int]$peerPortValue }
        if ($peerPort -lt 1 -or $peerPort -gt 65535) {
            throw "设备【${name}】的端口必须是 1 到 65535 之间的整数。"
        }

        $peerTokenValue = Get-PropertyValue -Object $sourcePeer -Name "accessToken"
        $peerToken = if ($null -eq $peerTokenValue) { $DefaultAccessToken } else { [string]$peerTokenValue }
        $peerToken = $peerToken.Trim()
        if ($peerToken.Length -gt 128) {
            throw "设备【${name}】的访问密钥不能超过 128 个字符。"
        }

        $enabledValue = Get-PropertyValue -Object $sourcePeer -Name "enabled"
        $enabled = if ($null -eq $enabledValue) { $true } else { [bool]$enabledValue }
        $id = [string](Get-PropertyValue -Object $sourcePeer -Name "id")
        if ([string]::IsNullOrWhiteSpace($id)) {
            $id = [Guid]::NewGuid().ToString("N")
        }

        $endpointKey = "$($address.ToLowerInvariant())`:$peerPort"
        if ($endpointKeys.ContainsKey($endpointKey)) {
            throw "接收设备地址重复：$address`:$peerPort。"
        }
        $endpointKeys[$endpointKey] = $true

        $null = $normalizedPeers.Add([PSCustomObject][ordered]@{
            id          = $id
            name        = $name
            address     = $address
            port        = $peerPort
            accessToken = $peerToken
            enabled     = $enabled
        })
    }

    return $normalizedPeers.ToArray()
}

function Copy-RelayPeers {
    param([object[]]$Peers)

    return @($Peers | ForEach-Object {
        [PSCustomObject][ordered]@{
            id          = [string](Get-PropertyValue -Object $_ -Name "id")
            name        = [string](Get-PropertyValue -Object $_ -Name "name")
            address     = [string](Get-PropertyValue -Object $_ -Name "address")
            port        = [int](Get-PropertyValue -Object $_ -Name "port")
            accessToken = [string](Get-PropertyValue -Object $_ -Name "accessToken")
            enabled     = [bool](Get-PropertyValue -Object $_ -Name "enabled")
        }
    })
}

function Get-EnabledRelayPeers {
    param([object[]]$Peers = $script:Peers)

    return @($Peers | Where-Object { [bool](Get-PropertyValue -Object $_ -Name "enabled") })
}

function Get-RelayPeerRouteSignature {
    param([object[]]$Peers = $script:Peers)

    $route = @($Peers | Where-Object { [bool](Get-PropertyValue -Object $_ -Name "enabled") } | ForEach-Object {
        [ordered]@{
            id = [string](Get-PropertyValue -Object $_ -Name "id")
            address = [string](Get-PropertyValue -Object $_ -Name "address")
            port = [int](Get-PropertyValue -Object $_ -Name "port")
            accessToken = [string](Get-PropertyValue -Object $_ -Name "accessToken")
        }
    })
    return ($route | ConvertTo-Json -Compress)
}

function Set-ActivePeerAddress {
    param([string]$Value)

    $normalized = Get-NormalizedPeerAddress -Value $Value
    $uriBuilder = New-Object System.UriBuilder("http", $normalized, $script:Port, "push")
    $script:Peer = $normalized
    $script:pushUri = $uriBuilder.Uri
}

function Get-StartupShortcutPath {
    $startupDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    return Join-Path $startupDirectory "ClipRelay.lnk"
}

function Test-StartupRegistration {
    return Test-Path -LiteralPath (Get-StartupShortcutPath)
}

function Set-StartupRegistration {
    param([bool]$Enabled)

    $shortcutPath = Get-StartupShortcutPath
    if (-not $Enabled) {
        if (Test-Path -LiteralPath $shortcutPath) {
            Remove-Item -LiteralPath $shortcutPath -Force
        }
        return
    }

    $windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $clientPath = Join-Path $PSScriptRoot "cliprelay.ps1"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $windowsPowerShell
    $shortcut.Arguments = "-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$clientPath`""
    $shortcut.WorkingDirectory = $PSScriptRoot
    $iconPath = Join-Path $PSScriptRoot "cliprelay.ico"
    $shortcut.IconLocation = if (Test-Path -LiteralPath $iconPath) { "$iconPath,0" } else { "$windowsPowerShell,0" }
    $shortcut.Description = "ClipRelay Windows client"
    $shortcut.Save()
}

function Set-ClipRelayFirewallPort {
    param([int]$ListenPort)

    $firewallRuleName = "ClipRelay-TCP-In"
    $windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $firewallCommand =
        "Get-NetFirewallRule -DisplayName '$firewallRuleName' -ErrorAction SilentlyContinue | " +
        "Remove-NetFirewallRule -ErrorAction SilentlyContinue; " +
        "New-NetFirewallRule -DisplayName '$firewallRuleName' -Direction Inbound -Action Allow " +
        "-Protocol TCP -LocalPort $ListenPort -Profile Private | Out-Null"
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($firewallCommand))
    try {
        $process = Start-Process -FilePath $windowsPowerShell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @(
            "-NoProfile",
            "-EncodedCommand",
            $encodedCommand
        )
        if ($process.ExitCode -ne 0) {
            throw "防火墙规则更新失败（退出码 $($process.ExitCode)）。"
        }
    }
    catch {
        throw "端口尚未保存：需要允许 Windows 更新专用网络防火墙规则。$($_.Exception.Message)"
    }
}

function Save-PeerConfiguration {
    param(
        [string]$PeerAddress,
        [bool]$Notifications,
        [int]$ListenPort = 0,
        [string]$AccessToken = $script:AccessToken,
        [bool]$StartupEnabled = (Test-StartupRegistration),
        [object[]]$Peers = $null
    )

    # This function deliberately owns all script-scoped state changes. The
    # modeless settings callbacks use GetNewClosure(), whose $script: scope is
    # a private dynamic module rather than this ClipRelay script.
    if ($ListenPort -eq 0) {
        $ListenPort = $script:Port
    }
    if ($ListenPort -lt 1 -or $ListenPort -gt 65535) {
        throw "服务端口必须是 1 到 65535 之间的整数。"
    }
    $normalizedAccessToken = if ($null -eq $AccessToken) { "" } else { $AccessToken.Trim() }
    if ($normalizedAccessToken.Length -gt 128) {
        throw "访问密钥不能超过 128 个字符。"
    }

    if ($null -eq $Peers) {
        $Peers = @([PSCustomObject]@{
            id          = "legacy-peer"
            name        = "接收设备"
            address     = $PeerAddress
            port        = $ListenPort
            accessToken = $normalizedAccessToken
            enabled     = $true
        })
    }
    $normalizedPeers = @(Get-NormalizedRelayPeers -Peers $Peers -DefaultPort $ListenPort -DefaultAccessToken $normalizedAccessToken)
    $enabledPeers = @(Get-EnabledRelayPeers -Peers $normalizedPeers)
    if ($enabledPeers.Count -lt 1) {
        throw "至少需要启用一台接收设备。"
    }
    $primaryPeer = $enabledPeers[0]
    $normalized = [string]$primaryPeer.address

    $portChanged = $ListenPort -ne $script:Port
    if ($portChanged) {
        Set-ClipRelayFirewallPort -ListenPort $ListenPort
    }
    Set-StartupRegistration -Enabled $StartupEnabled

    $configuration = [ordered]@{
        peer          = $normalized
        peers         = $normalizedPeers
        port          = $ListenPort
        notifications = $Notifications
        accessToken   = $normalizedAccessToken
    }
    $configuration | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $script:configPath -Encoding UTF8

    $script:Peer = $normalized
    $script:Peers = Copy-RelayPeers -Peers $normalizedPeers
    $script:Port = $ListenPort
    $script:pushUri = (New-Object System.UriBuilder("http", $normalized, ([int]$primaryPeer.port), "push")).Uri
    $script:Notifications = $Notifications
    $script:AccessToken = $normalizedAccessToken
    if ($null -ne $script:peerMenuItem) {
        $script:peerMenuItem.Text = "发送设备: $($enabledPeers.Count) 台"
    }
    if ($null -ne $script:notifyMenuItem) {
        $script:notifyMenuItem.Checked = $Notifications
    }
    if ($portChanged) {
        $script:restartRequested = $true
        $script:stopRequested = $true
    }

    return $normalized
}

function Get-LocalShareableAddresses {
    $items = @()
    try {
        $hostName = [System.Net.Dns]::GetHostName()
        if (-not [string]::IsNullOrWhiteSpace($hostName)) {
            $items += [PSCustomObject]@{
                Address = "$hostName.local"
                Display = "$hostName.local  (局域网主机名 - 推荐)"
            }
        }
    }
    catch {
    }

    $lanCandidates = @()
    foreach ($networkInterface in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($networkInterface.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up -or
            $networkInterface.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) {
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

                $label = $networkInterface.Name
                if ($hasDefaultGateway) {
                    $label = "$($networkInterface.Name) - 当前 Wi-Fi"
                }

                $lanCandidates += [PSCustomObject]@{
                    Address           = $text
                    Display           = "$text  ($label)"
                    HasDefaultGateway = $hasDefaultGateway
                    InterfaceName     = $networkInterface.Name
                }
            }
        }
        catch {
        }
    }

    $sortedLan = @($lanCandidates |
        Sort-Object @{ Expression = { if ($_.HasDefaultGateway) { 0 } else { 1 } } }, InterfaceName, Address)

    foreach ($candidate in $sortedLan) {
        $items += [PSCustomObject]@{
            Address = $candidate.Address
            Display = $candidate.Display
        }
    }

    return @($items)
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

function Get-PeerHttpErrorMessage {
    param(
        [string]$Address,
        [int]$Port,
        [int]$TimeoutMilliseconds,
        [string]$TargetAddress,
        [System.Exception]$Exception
    )

    $endpoint = "$Address`:$Port"
    if (-not [string]::IsNullOrWhiteSpace($TargetAddress) -and $TargetAddress -ne $Address) {
        $endpoint = "$Address ($TargetAddress):$Port"
    }

    $messages = New-Object System.Collections.Generic.List[string]
    $webStatus = $null
    $socketError = $null
    $httpStatusCode = $null
    $currentException = $Exception
    $depth = 0
    while ($null -ne $currentException -and $depth -lt 10) {
        $currentMessage = [string]$currentException.Message
        if (-not [string]::IsNullOrWhiteSpace($currentMessage) -and -not $messages.Contains($currentMessage)) {
            $messages.Add($currentMessage)
        }

        if ($currentException -is [System.Net.WebException]) {
            $webStatus = $currentException.Status
            if ($null -ne $currentException.Response -and $currentException.Response -is [System.Net.HttpWebResponse]) {
                $httpStatusCode = [int]$currentException.Response.StatusCode
            }
        }
        if ($currentException -is [System.Net.Sockets.SocketException]) {
            $socketError = $currentException.SocketErrorCode
        }

        $currentException = $currentException.InnerException
        $depth++
    }

    $raw = $messages -join " -> "
    $technicalParts = New-Object System.Collections.Generic.List[string]
    if ($null -ne $webStatus) {
        $technicalParts.Add("WebStatus=$webStatus")
    }
    if ($null -ne $socketError) {
        $technicalParts.Add("SocketError=$socketError")
    }
    if ($messages.Count -gt 0) {
        $technicalParts.Add($messages[$messages.Count - 1])
    }
    $technicalDetail = ""
    if ($technicalParts.Count -gt 0) {
        $technicalDetail = " 系统信息：$($technicalParts -join '；')。"
    }

    if ($socketError -eq [System.Net.Sockets.SocketError]::ConnectionRefused) {
        return "连接被拒绝：已找到 $endpoint，但 TCP 端口 $Port 未接受连接。请确认对方 ClipRelay 正在运行，并检查对方防火墙。$technicalDetail"
    }
    if ($socketError -eq [System.Net.Sockets.SocketError]::TimedOut -or $webStatus -eq [System.Net.WebExceptionStatus]::Timeout) {
        return "连接超时：$endpoint 在 $([math]::Round($TimeoutMilliseconds / 1000, 1)) 秒内未响应。请检查对方是否在线、两台设备是否在可互通的局域网，以及防火墙是否放行 TCP $Port。$technicalDetail"
    }
    if ($socketError -eq [System.Net.Sockets.SocketError]::HostNotFound -or
        $socketError -eq [System.Net.Sockets.SocketError]::NoData -or
        $webStatus -eq [System.Net.WebExceptionStatus]::NameResolutionFailure) {
        return "主机名解析失败：无法把 '$Address' 解析为 IP。请检查拼写，或直接输入对方的局域网 IP。$technicalDetail"
    }
    if ($socketError -eq [System.Net.Sockets.SocketError]::NetworkUnreachable -or
        $socketError -eq [System.Net.Sockets.SocketError]::HostUnreachable) {
        return "网络不可达：本机没有到 $endpoint 的可用网络路径。请检查 Wi-Fi、网段、访客网络/客户端隔离和 VPN。$technicalDetail"
    }
    if ($socketError -eq [System.Net.Sockets.SocketError]::AddressNotAvailable) {
        return "本机地址不可用：当前网卡无法访问 $endpoint。请确认填写的是对方当前局域网地址，而不是已断开的 Wi-Fi、热点或 USB 网络地址。$technicalDetail"
    }
    if ($socketError -eq [System.Net.Sockets.SocketError]::ConnectionReset -or
        $socketError -eq [System.Net.Sockets.SocketError]::ConnectionAborted) {
        return "连接被中断：已连接到 $endpoint，但连接随后被对方或网络设备关闭。请重启对方 ClipRelay，并检查代理/VPN。$technicalDetail"
    }

    if ($webStatus -eq [System.Net.WebExceptionStatus]::ConnectFailure) {
        return "TCP 连接失败：无法连接到 $endpoint。Windows 未提供更具体的 Socket 原因；通常是对方 ClipRelay 未运行、TCP $Port 被防火墙拦截，或设备不在可互通的局域网。$technicalDetail"
    }
    if ($webStatus -eq [System.Net.WebExceptionStatus]::ProtocolError) {
        if ($null -ne $httpStatusCode) {
            if ($httpStatusCode -eq 401) {
                return "访问密钥不匹配：请确认两台设备填写了完全相同的密钥。"
            }
            return "HTTP 响应异常：已连接到 $endpoint，但对方返回 HTTP $httpStatusCode。该端口可能不是 ClipRelay，或对方版本不兼容。$technicalDetail"
        }
        return "HTTP 响应异常：已连接到 $endpoint，但对方没有返回 ClipRelay 预期的 200 响应。$technicalDetail"
    }
    if ($webStatus -eq [System.Net.WebExceptionStatus]::SendFailure -or
        $webStatus -eq [System.Net.WebExceptionStatus]::ReceiveFailure -or
        $webStatus -eq [System.Net.WebExceptionStatus]::ConnectionClosed) {
        return "HTTP 通信被中断：TCP 已连接到 $endpoint，但发送或接收 POST /push 时连接关闭。请检查对方 ClipRelay、代理和 VPN。$technicalDetail"
    }

    if ($raw -like "*超时*" -or $raw -like "*timed out*") {
        return "连接超时：$endpoint 未在时限内响应 POST /push。请确认对方 ClipRelay 在运行，且没有代理拦截该地址。$technicalDetail"
    }
    if ($raw -like "*actively refused*" -or $raw -like "*拒绝*") {
        return "连接被拒绝：已找到 $endpoint，但对方未运行 ClipRelay 或 TCP $Port 未开放。$technicalDetail"
    }
    if ($raw -like "*No such host*" -or $raw -like "*not known*" -or $raw -like "*找不到*") {
        return "主机名解析失败：无法解析设备名 '$Address'。请检查拼写，或直接输入 IP。$technicalDetail"
    }
    if ($raw -like "*unreachable*" -or $raw -like "*不可达*") {
        return "网络不可达：本机到 $endpoint 没有可用路由。$technicalDetail"
    }
    if ($raw -like "*基础连接*" -or $raw -like "*underlying connection*" -or $raw -like "*接收时*" -or $raw -like "*closed*") {
        return "HTTP 通信被中断：TCP 已连接到 $endpoint，但 POST /push 响应中断。常见原因是代理/VPN 拦截，或对方 ClipRelay 没有正常回包。$technicalDetail"
    }
    if ($raw -like "*地址无效*" -or $raw -like "*not valid in this context*" -or $raw -like "*not valid in its context*") {
        return "本机地址不可用：当前网卡无法访问 $endpoint（例如 USB 共享网无法访问对方的 Wi-Fi 地址）。$technicalDetail"
    }
    if ($raw -match "对方返回 HTTP ([0-9]+)") {
        if ([int]$Matches[1] -eq 401) {
            return "访问密钥不匹配：请确认两台设备填写了完全相同的密钥。"
        }
        return "HTTP 响应异常：已连接到 $endpoint，但对方返回 HTTP $($Matches[1])，不是 ClipRelay 预期的 200 响应。$technicalDetail"
    }
    return "连接失败：无法完成到 $endpoint 的 POST /push。请检查对方 ClipRelay、局域网和 TCP $Port 防火墙规则。$technicalDetail"
}

function Invoke-ClipRelayPush {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Address,
        [int]$Port = 47632,
        [int]$TimeoutMilliseconds = 5000,
        [Parameter(Mandatory = $true)]
        [string]$Text,
        [string]$AccessToken = "",
        [switch]$Probe
    )

    $normalized = Get-NormalizedPeerAddress -Value $Address
    $targetAddress = Resolve-TargetAddress -Address $normalized
    $targetUri = "http://$targetAddress`:$Port/push"

    $payload = [ordered]@{ text = $Text }
    if ($Probe) {
        $payload.probe = $true
    }
    $json = $payload | ConvertTo-Json -Compress
    $body = [System.Text.Encoding]::UTF8.GetBytes($json)

    $request = [System.Net.HttpWebRequest]::Create($targetUri)
    $request.Method = "POST"
    if ($normalized -ne $targetAddress) {
        $request.Host = "$normalized`:$Port"
    }
    $request.ContentType = "application/json; charset=utf-8"
    if (-not [string]::IsNullOrWhiteSpace($AccessToken)) {
        $request.Headers["X-ClipRelay-Token"] = $AccessToken
    }
    $request.ContentLength = $body.Length
    $request.Timeout = $TimeoutMilliseconds
    $request.ReadWriteTimeout = $TimeoutMilliseconds
    $request.KeepAlive = $false
    $request.Proxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()
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
            throw "对方返回 HTTP $([int]$response.StatusCode)，不是完整的 ClipRelay 成功响应。"
        }
    }
    catch {
        throw (Get-PeerHttpErrorMessage -Address $normalized -Port $Port -TimeoutMilliseconds $TimeoutMilliseconds -TargetAddress $targetAddress -Exception $_.Exception)
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

function Invoke-ClipRelayImagePush {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Address,
        [int]$Port = 47632,
        [int]$TimeoutMilliseconds = 10000,
        [Parameter(Mandatory = $true)]
        [ClipRelay.ScreenshotFrame]$Frame,
        [string]$AccessToken = ""
    )

    if ($Frame.Bytes.Length -lt 1 -or $Frame.Bytes.Length -gt 26214400) {
        throw "Screenshot payload is empty or exceeds 25 MiB."
    }

    $normalized = Get-NormalizedPeerAddress -Value $Address
    $targetAddress = Resolve-TargetAddress -Address $normalized
    $uriBuilder = New-Object System.UriBuilder("http", $targetAddress, $Port, "push-image")
    $request = [System.Net.HttpWebRequest]::Create($uriBuilder.Uri)
    $request.Method = "POST"
    if ($normalized -ne $targetAddress) {
        $request.Host = "$normalized`:$Port"
    }
    $request.ContentType = "image/jpeg"
    if (-not [string]::IsNullOrWhiteSpace($AccessToken)) {
        $request.Headers["X-ClipRelay-Token"] = $AccessToken
    }
    $request.Headers["X-ClipRelay-Width"] = [string]$Frame.Width
    $request.Headers["X-ClipRelay-Height"] = [string]$Frame.Height
    $request.ContentLength = $Frame.Bytes.Length
    $request.Timeout = $TimeoutMilliseconds
    $request.ReadWriteTimeout = $TimeoutMilliseconds
    $request.KeepAlive = $false
    $request.Proxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()
    $request.ServicePoint.Expect100Continue = $false

    $requestStream = $null
    $response = $null
    try {
        $requestStream = $request.GetRequestStream()
        $requestStream.Write($Frame.Bytes, 0, $Frame.Bytes.Length)
        $requestStream.Close()
        $requestStream = $null

        $response = [System.Net.HttpWebResponse]$request.GetResponse()
        if ([int]$response.StatusCode -ne 200) {
            throw "The peer returned HTTP $([int]$response.StatusCode)."
        }
    }
    catch {
        throw (Get-PeerHttpErrorMessage -Address $normalized -Port $Port -TimeoutMilliseconds $TimeoutMilliseconds -TargetAddress $targetAddress -Exception $_.Exception)
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

function Test-PeerConnectivity {
    param(
        [string]$Address,
        [int]$Port = 47632,
        [int]$TimeoutMilliseconds = 5000,
        [string]$AccessToken = ""
    )

    Invoke-ClipRelayPush -Address $Address -Port $Port -TimeoutMilliseconds $TimeoutMilliseconds -Text "cliprelay-probe" -AccessToken $AccessToken -Probe
    return "发送检测成功：对方完整响应了 POST /push。"
}

$configPath = Join-Path $PSScriptRoot "config.json"
$configuration = $null
$peerWasExplicitlyProvided = $PSBoundParameters.ContainsKey("Peer") -and -not [string]::IsNullOrWhiteSpace($Peer)
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

$configuredNotifications = Get-PropertyValue -Object $configuration -Name "notifications"
if ($null -ne $configuredNotifications) {
    $script:Notifications = [bool]$configuredNotifications
}
else {
    $script:Notifications = $true
}

$configuredAccessToken = Get-PropertyValue -Object $configuration -Name "accessToken"
$script:AccessToken = if ($null -eq $configuredAccessToken) { "" } else { [string]$configuredAccessToken }

$configuredPeers = Get-PropertyValue -Object $configuration -Name "peers"
if ($peerWasExplicitlyProvided -or $null -eq $configuredPeers -or @($configuredPeers).Count -eq 0) {
    $peerSeed = @([PSCustomObject]@{
        id          = if ($peerWasExplicitlyProvided) { "command-line-peer" } else { "legacy-peer" }
        name        = if ($peerWasExplicitlyProvided) { "命令行设备" } else { "原有设备" }
        address     = $Peer
        port        = $Port
        accessToken = $script:AccessToken
        enabled     = $true
    })
}
else {
    $peerSeed = @($configuredPeers)
}
$script:Peers = @(Get-NormalizedRelayPeers -Peers $peerSeed -DefaultPort $Port -DefaultAccessToken $script:AccessToken)
$enabledConfiguredPeers = @(Get-EnabledRelayPeers -Peers $script:Peers)
if ($enabledConfiguredPeers.Count -lt 1) {
    throw "ClipRelay 配置中没有启用的接收设备。"
}
$Peer = [string]$enabledConfiguredPeers[0].address

if ([System.Threading.Thread]::CurrentThread.ApartmentState -ne [System.Threading.ApartmentState]::STA) {
    throw "ClipRelay requires an STA thread. Start it with powershell.exe -STA -File cliprelay.ps1."
}

$pushUri = $null
Set-ActivePeerAddress -Value $Peer
$script:pushUri = (New-Object System.UriBuilder("http", $Peer, ([int]$enabledConfiguredPeers[0].port), "push")).Uri
$mutex = $null
$ownsMutex = $false
$listener = $null
$notifyIcon = $null
$appIcon = $null
$trayMenu = $null
$peerMenuItem = $null
$notifyMenuItem = $null
$screenshotHotkeyMenuItem = $null
$copyMonitorStarted = $false
$stopRequested = $false
$restartRequested = $false
$configurationDialogOpen = $false
$clipboardDuplicateWindowMilliseconds = 1000
$lastSentClipboardText = $null
$lastSentClipboardPeer = $null
$lastSentClipboardPort = 0
$lastSentClipboardAtUtc = [DateTime]::MinValue
$lastTransferState = "idle"
$lastTransferKind = ""
$lastTransferDetail = "等待首次发送"
$lastTransferAt = $null
$lastTransferResults = @()

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

function Set-LastTransferStatus {
    param(
        [ValidateSet("idle", "success", "partial", "error")]
        [string]$State,
        [string]$Kind,
        [string]$Detail,
        [object[]]$Results = @()
    )

    $script:lastTransferState = $State
    $script:lastTransferKind = $Kind
    $script:lastTransferDetail = $Detail
    $script:lastTransferAt = if ($State -eq "idle") { $null } else { Get-Date }
    $script:lastTransferResults = @($Results)
}

function Get-RelayRuntimeSnapshot {
    return [PSCustomObject]@{
        State                       = $script:lastTransferState
        Kind                        = $script:lastTransferKind
        Detail                      = $script:lastTransferDetail
        At                          = $script:lastTransferAt
        Port                        = $script:Port
        Peer                        = $script:Peer
        Peers                       = Copy-RelayPeers -Peers $script:Peers
        ActivePeerCount             = @(Get-EnabledRelayPeers -Peers $script:Peers).Count
        Results                     = @($script:lastTransferResults)
        ScreenshotHotkeyAvailable  = [ClipRelay.CopyHotkeyMonitor]::ScreenshotHotkeyAvailable
    }
}

function Show-PeerConfiguration {
    if ($script:configurationDialogOpen) {
        return
    }

    $script:configurationDialogOpen = $true
    $form = $null
    $settingsPort = $script:Port
    $savePeerConfigurationCommand = Get-Command Save-PeerConfiguration
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
        $form.ClientSize = New-Object System.Drawing.Size(460, 474)

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
            $localAddressBox.DisplayMember = "Display"
            $localAddressBox.ValueMember = "Address"
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
        $statusPanel.Location = New-Object System.Drawing.Point(18, 214)
        $statusPanel.Size = New-Object System.Drawing.Size(424, 120)
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
        $statusDetailLabel.Size = New-Object System.Drawing.Size(398, 78)
        $statusDetailLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 8.5, [System.Drawing.FontStyle]::Regular)
        $statusDetailLabel.ForeColor = [System.Drawing.Color]::FromArgb(120, 53, 15)
        $statusDetailLabel.Text = "正在尝试连接..."
        $statusPanel.Controls.Add($statusDetailLabel)

        # Section 4: Preferences (Notifications Toggle)
        $notifyCheckBox = New-Object System.Windows.Forms.CheckBox
        $notifyCheckBox.Text = "开启气泡通知（取消勾选即开启静默模式，彻底不弹窗）"
        $notifyCheckBox.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.0, [System.Drawing.FontStyle]::Regular)
        $notifyCheckBox.ForeColor = [System.Drawing.Color]::FromArgb(51, 65, 85)
        $notifyCheckBox.Checked = $script:Notifications
        $notifyCheckBox.AutoSize = $true
        $notifyCheckBox.Location = New-Object System.Drawing.Point(18, 346)
        $notifyCheckBox.Cursor = [System.Windows.Forms.Cursors]::Hand

        # Section 5: Footer
        $footerDivider = New-Object System.Windows.Forms.Panel
        $footerDivider.Location = New-Object System.Drawing.Point(18, 376)
        $footerDivider.Size = New-Object System.Drawing.Size(424, 1)
        $footerDivider.BackColor = [System.Drawing.Color]::FromArgb(226, 232, 240)

        $portLabel = New-Object System.Windows.Forms.Label
        $portLabel.Text = "服务端口: $script:Port    修改后点击保存立即生效"
        $portLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 8.5, [System.Drawing.FontStyle]::Regular)
        $portLabel.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
        $portLabel.AutoSize = $true
        $portLabel.Location = New-Object System.Drawing.Point(18, 388)

        $saveButton = New-Object System.Windows.Forms.Button
        $saveButton.Text = "保 存"
        $saveButton.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5, [System.Drawing.FontStyle]::Bold)
        $saveButton.Size = New-Object System.Drawing.Size(96, 34)
        $saveButton.Location = New-Object System.Drawing.Point(242, 420)
        $saveButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
        $saveButton.FlatAppearance.BorderSize = 0
        $saveButton.BackColor = [System.Drawing.Color]::FromArgb(37, 99, 235)
        $saveButton.ForeColor = [System.Drawing.Color]::White
        $saveButton.Cursor = [System.Windows.Forms.Cursors]::Hand

        $cancelButton = New-Object System.Windows.Forms.Button
        $cancelButton.Text = "取 消"
        $cancelButton.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5, [System.Drawing.FontStyle]::Regular)
        $cancelButton.Size = New-Object System.Drawing.Size(94, 34)
        $cancelButton.Location = New-Object System.Drawing.Point(348, 420)
        $cancelButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
        $cancelButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(203, 213, 225)
        $cancelButton.BackColor = [System.Drawing.Color]::FromArgb(241, 245, 249)
        $cancelButton.ForeColor = [System.Drawing.Color]::FromArgb(51, 65, 85)
        $cancelButton.Cursor = [System.Windows.Forms.Cursors]::Hand
        $cancelButton.Add_Click({ $form.Close() }.GetNewClosure())

        # GetNewClosure keeps these locals alive after Show-PeerConfiguration
        # returns. The settings form is modeless ($form.Show), so event
        # handlers fire after this function's locals would otherwise be gone;
        # StrictMode then throws "variable $copyButton is not set".
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
            $statusDetailLabel.Text = "正在向 $currentPeer`:$settingsPort 发送与复制相同的 POST /push..."
            $form.Update()

            try {
                $null = Test-PeerConnectivity -Address $currentPeer -Port $settingsPort -TimeoutMilliseconds 5000
                $statusPanel.BackColor = [System.Drawing.Color]::FromArgb(236, 253, 245)
                $statusTitleLabel.ForeColor = [System.Drawing.Color]::FromArgb(5, 150, 105)
                $statusTitleLabel.Text = "● 发送成功：对方已完整响应 POST /push"
                $statusDetailLabel.ForeColor = [System.Drawing.Color]::FromArgb(6, 95, 70)
                $statusDetailLabel.Text = "检测与复制发送使用同一条 HTTP 路径。对端：$currentPeer`:$settingsPort"
            }
            catch {
                $failureMessage = [string]$_.Exception.Message
                $failureTitle = "无法连接"
                if ($failureMessage -match "^([^：]+)：") {
                    $failureTitle = $Matches[1]
                }
                $statusPanel.BackColor = [System.Drawing.Color]::FromArgb(254, 242, 242)
                $statusTitleLabel.ForeColor = [System.Drawing.Color]::FromArgb(220, 38, 38)
                $statusTitleLabel.Text = "● $failureTitle"
                $statusDetailLabel.ForeColor = [System.Drawing.Color]::FromArgb(153, 27, 27)
                $statusDetailLabel.Text = $failureMessage
            }
            finally {
                $testButton.Text = "检测连接"
                $testButton.Enabled = $true
            }
        }.GetNewClosure()

        $copyButton.Add_Click({
            if ($localAddresses.Count -gt 0 -and $localAddressBox.SelectedIndex -ge 0) {
                $selectedItem = $localAddressBox.SelectedItem
                $textToCopy = if ($null -ne $selectedItem -and $selectedItem.PSObject.Properties["Address"]) { [string]$selectedItem.Address } else { [string]$selectedItem }
                Set-ClipboardTextWithRetry -Text $textToCopy
                $copyButton.Text = "✓ 已复制!"
                $copyButton.ForeColor = [System.Drawing.Color]::FromArgb(5, 150, 105)
            }
        }.GetNewClosure())
        $localAddressBox.Add_SelectedIndexChanged({
            $copyButton.Text = "复制"
            $copyButton.ForeColor = [System.Drawing.Color]::FromArgb(30, 41, 59)
        }.GetNewClosure())

        $testButton.Add_Click($runCheck)

        $saveButton.Add_Click({
            try {
                $notificationsEnabled = [bool]$notifyCheckBox.Checked
                $normalized = & $savePeerConfigurationCommand -PeerAddress $peerTextBox.Text -Notifications $notificationsEnabled
                if ($notificationsEnabled) {
                    Show-ClipRelayNotification -Title "ClipRelay 设置已保存" -Message "已将对方地址更新为 $normalized`:$settingsPort。"
                }
                $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
                $form.Close()
            }
            catch {
                $null = [System.Windows.Forms.MessageBox]::Show(
                    $form,
                    $_.Exception.Message,
                    "无法保存设置",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Warning
                )
            }
        }.GetNewClosure())

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
            $notifyCheckBox,
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
        }.GetNewClosure())

        # Modeless: ShowDialog() blocks the STA loop, so incoming POST /push
        # is never handled while settings are open. TCP detect still succeeds
        # (the OS backlog accepts the handshake) which looks like a false green.
        $form.Add_FormClosed({
            param($sender, $eventArgs)
            try {
                if ($null -ne $sender) {
                    $sender.Dispose()
                }
            }
            catch {
            }
            $script:configurationDialogOpen = $false
        })
        $null = $form.Show()
    }
    catch {
        $script:configurationDialogOpen = $false
        if ($null -ne $form) {
            try { $form.Dispose() } catch { }
        }
        throw
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

function Set-ClipboardImageWithRetry {
    param([System.Drawing.Image]$Image)

    $lastError = $null
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            [System.Windows.Forms.Clipboard]::SetImage($Image)
            return
        }
        catch {
            $lastError = $_
            Start-Sleep -Milliseconds 20
        }
    }

    throw "Cannot write the image to the clipboard: $($lastError.Exception.Message)"
}

function New-RelayBroadcastTargets {
    param([object[]]$Peers = $script:Peers)

    $enabledPeers = @(Get-EnabledRelayPeers -Peers $Peers)
    if ($enabledPeers.Count -lt 1) {
        throw "没有启用的接收设备。请先在设置中启用至少一台设备。"
    }

    $targets = New-Object "System.Collections.Generic.List[ClipRelay.RelayTarget]"
    foreach ($peer in $enabledPeers) {
        $address = [string]$peer.address
        $peerPort = [int]$peer.port
        $uriBuilder = New-Object System.UriBuilder("http", $address, $peerPort)
        $target = New-Object ClipRelay.RelayTarget
        $target.Name = [string]$peer.name
        $target.Address = "$address`:$peerPort"
        $target.Uri = $uriBuilder.Uri.AbsoluteUri.TrimEnd("/")
        $target.HostHeader = ""
        $target.AccessToken = [string]$peer.accessToken
        $targets.Add($target)
    }
    return $targets.ToArray()
}

function Invoke-RelayTextBroadcast {
    param(
        [string]$Text,
        [object[]]$Peers = $script:Peers,
        [int]$TimeoutMilliseconds = 5000,
        [switch]$Probe
    )

    $payload = [ordered]@{ text = $Text }
    if ($Probe) {
        $payload.probe = $true
    }
    $json = $payload | ConvertTo-Json -Compress
    $targets = New-RelayBroadcastTargets -Peers $Peers
    return ([ClipRelay.RelayBroadcaster]::SendText($targets, $json, $TimeoutMilliseconds))
}

function Invoke-RelayImageBroadcast {
    param(
        [ClipRelay.ScreenshotFrame]$Frame,
        [object[]]$Peers = $script:Peers,
        [int]$TimeoutMilliseconds = 10000
    )

    if ($Frame.Bytes.Length -lt 1 -or $Frame.Bytes.Length -gt 26214400) {
        throw "Screenshot payload is empty or exceeds 25 MiB."
    }
    $targets = New-RelayBroadcastTargets -Peers $Peers
    return ([ClipRelay.RelayBroadcaster]::SendImage(
        $targets,
        $Frame.Bytes,
        $Frame.Width,
        $Frame.Height,
        $TimeoutMilliseconds
    ))
}

function Get-RelayDeliveryFailureText {
    param([ClipRelay.RelayDeliveryResult]$Result)

    if ($Result.StatusCode -eq 401) {
        return "访问密钥不匹配"
    }
    if ($Result.StatusCode -gt 0) {
        return "HTTP $($Result.StatusCode)"
    }
    if ($Result.ErrorKind -eq "Timeout" -or $Result.ErrorMessage -like "*timed out*" -or $Result.ErrorMessage -like "*超时*") {
        return "连接超时"
    }
    if ($Result.ErrorKind -eq "NameResolutionFailure" -or $Result.ErrorMessage -like "*name*resolved*" -or $Result.ErrorMessage -like "*No such host*") {
        return "地址无法解析"
    }
    if ($Result.ErrorKind -eq "ConnectFailure" -or $Result.ErrorMessage -like "*refused*" -or $Result.ErrorMessage -like "*拒绝*") {
        return "无法连接"
    }
    return "发送失败"
}

function Get-RelayDeliverySummary {
    param(
        [ClipRelay.RelayDeliveryResult[]]$Results,
        [ValidateSet("文本", "截图", "检测")]
        [string]$Kind
    )

    $allResults = @($Results)
    $successResults = @($allResults | Where-Object { $_.Success })
    $failedResults = @($allResults | Where-Object { -not $_.Success })
    $resultParts = @($allResults | ForEach-Object {
        if ($_.Success) {
            "$($_.Name) ✓"
        }
        else {
            "$($_.Name) × $(Get-RelayDeliveryFailureText -Result $_)"
        }
    })

    if ($failedResults.Count -eq 0) {
        $state = "success"
        $detail = "$Kind 已送达 $($successResults.Count)/$($allResults.Count) 台 · $($resultParts -join ' · ')"
    }
    elseif ($successResults.Count -gt 0) {
        $state = "partial"
        $detail = "$Kind 部分送达 $($successResults.Count)/$($allResults.Count) 台 · $($resultParts -join ' · ')"
    }
    else {
        $state = "error"
        $detail = "$Kind 发送失败 0/$($allResults.Count) 台 · $($resultParts -join ' · ')"
    }

    return [PSCustomObject]@{
        State        = $state
        Detail       = $detail
        SuccessCount = $successResults.Count
        FailureCount = $failedResults.Count
        TotalCount   = $allResults.Count
        Results      = $allResults
    }
}

function Test-RelayPeersConnectivity {
    param(
        [object[]]$Peers = $script:Peers,
        [int]$TimeoutMilliseconds = 5000
    )

    $results = @(Invoke-RelayTextBroadcast -Text "cliprelay-probe" -Peers $Peers -TimeoutMilliseconds $TimeoutMilliseconds -Probe)
    return Get-RelayDeliverySummary -Results $results -Kind "检测"
}

function Send-TextToPeer {
    param([string]$Text)

    $results = @(Invoke-RelayTextBroadcast -Text $Text)
    $summary = Get-RelayDeliverySummary -Results $results -Kind "文本"
    if ($summary.SuccessCount -lt 1) {
        throw $summary.Detail
    }
    return $results
}

function Send-ClipboardTextUnlessDuplicate {
    param(
        [string]$Text,
        [DateTime]$NowUtc = [DateTime]::UtcNow
    )

    $elapsedMilliseconds = ($NowUtc - $script:lastSentClipboardAtUtc).TotalMilliseconds
    $routeSignature = Get-RelayPeerRouteSignature
    $isRecentDuplicate =
        $Text -ceq $script:lastSentClipboardText -and
        $routeSignature -ceq $script:lastSentClipboardPeer -and
        $elapsedMilliseconds -ge 0 -and
        $elapsedMilliseconds -lt $script:clipboardDuplicateWindowMilliseconds
    if ($isRecentDuplicate) {
        return $false
    }

    $results = @(Send-TextToPeer -Text $Text)
    $summary = Get-RelayDeliverySummary -Results $results -Kind "文本"
    $script:lastSentClipboardText = $Text
    $script:lastSentClipboardPeer = $routeSignature
    $script:lastSentClipboardPort = $script:Port
    $script:lastSentClipboardAtUtc = $NowUtc
    Set-LastTransferStatus -State $summary.State -Kind "TEXT" -Detail $summary.Detail -Results $results
    return $true
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

        $null = Send-ClipboardTextUnlessDuplicate -Text $copiedText
    }
    catch {
        $msg = $_.Exception.Message
        if ($_.Exception.InnerException) {
            $msg = $_.Exception.InnerException.Message
        }
        Set-LastTransferStatus -State "error" -Kind "TEXT" -Detail $msg
        if ($script:Notifications) {
            Show-ClipRelayNotification -Title "ClipRelay 发送失败" -Message $msg -Icon Warning
        }
    }
}

function Send-VirtualDesktopScreenshot {
    # Capture and encode without invoking the Snipping Tool, touching the
    # local clipboard, or writing a temporary image file.
    try {
        $frame = [ClipRelay.ScreenshotCapture]::CaptureVirtualDesktopJpeg(88)
        $results = @(Invoke-RelayImageBroadcast -Frame $frame)
        $summary = Get-RelayDeliverySummary -Results $results -Kind "截图"
        Set-LastTransferStatus -State $summary.State -Kind "IMAGE" -Detail "$($frame.Width) × $($frame.Height) · $($summary.Detail)" -Results $results
    }
    catch {
        Set-LastTransferStatus -State "error" -Kind "IMAGE" -Detail "截图发送失败：$($_.Exception.Message)"
        # Screenshot transfer is deliberately silent. Receiving and text-copy
        # notifications retain their existing behavior.
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

    if ($headers.ContainsKey("Expect") -and ([string]$headers["Expect"] -match "100-continue")) {
        $continueBytes = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 100 Continue`r`n`r`n")
        $stream.Write($continueBytes, 0, $continueBytes.Length)
        $stream.Flush()
    }

    if (-not $headers.ContainsKey("Content-Length")) {
        throw "Content-Length is missing."
    }

    $contentLength = 0
    $requestPath = [string]$requestLine[1]
    $maximumBodyLength = 1048576
    if ($requestPath -eq "/push-image") {
        $maximumBodyLength = 26214400
    }
    if (-not [int]::TryParse([string]$headers["Content-Length"], [ref]$contentLength) -or
        $contentLength -lt 0 -or $contentLength -gt $maximumBodyLength) {
        throw "Content-Length is invalid or the request body is too large."
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
        Method    = $requestLine[0]
        Path      = $requestPath
        Headers   = $headers
        BodyBytes = $bodyBytes
        Stream    = $stream
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

    if ($request.Method -ne "POST" -or
        ($request.Path -ne "/push" -and $request.Path -ne "/push-image")) {
        Send-HttpResponse -Stream $request.Stream -StatusCode 404 -Reason "Not Found" -Body "not found"
        return
    }

    if (-not [string]::IsNullOrWhiteSpace($script:AccessToken)) {
        $providedAccessToken = [string]$request.Headers["X-ClipRelay-Token"]
        if ($providedAccessToken -cne $script:AccessToken) {
            Send-HttpResponse -Stream $request.Stream -StatusCode 401 -Reason "Unauthorized" -Body "unauthorized"
            return
        }
    }

    if ($request.Path -eq "/push-image") {
        $sourceImage = $null
        $clipboardImage = $null
        $memoryStream = $null
        try {
            $contentType = [string]$request.Headers["Content-Type"]
            $mediaType = $contentType.Split(";")[0].Trim()
            if (-not $mediaType.Equals("image/jpeg", [System.StringComparison]::OrdinalIgnoreCase)) {
                Send-HttpResponse -Stream $request.Stream -StatusCode 415 -Reason "Unsupported Media Type" -Body "JPEG image required"
                return
            }
            if ($request.BodyBytes.Length -lt 3 -or
                $request.BodyBytes[0] -ne 0xFF -or $request.BodyBytes[1] -ne 0xD8 -or
                $request.BodyBytes[2] -ne 0xFF) {
                throw "The request body is not a JPEG image."
            }

            $memoryStream = New-Object System.IO.MemoryStream
            $memoryStream.Write($request.BodyBytes, 0, $request.BodyBytes.Length)
            $memoryStream.Position = 0
            $sourceImage = [System.Drawing.Image]::FromStream($memoryStream, $true, $true)
            $pixelCount = [long]$sourceImage.Width * [long]$sourceImage.Height
            if ($sourceImage.Width -gt 32768 -or $sourceImage.Height -gt 32768 -or $pixelCount -gt 100000000) {
                throw "The image dimensions are too large."
            }

            $clipboardImage = [System.Drawing.Image]$sourceImage.Clone()
            Set-ClipboardImageWithRetry -Image $clipboardImage
            Send-HttpResponse -Stream $request.Stream -StatusCode 200 -Reason "OK" -Body "ok"
            if ($script:Notifications) {
                Show-ClipRelayNotification -Title "ClipRelay 收到截图" -Message "$($sourceImage.Width) × $($sourceImage.Height) 的截图已进入剪贴板。"
            }
        }
        catch {
            try {
                Send-HttpResponse -Stream $request.Stream -StatusCode 400 -Reason "Bad Request" -Body "invalid image"
            }
            catch {
            }
        }
        finally {
            if ($null -ne $clipboardImage) {
                $clipboardImage.Dispose()
            }
            if ($null -ne $sourceImage) {
                $sourceImage.Dispose()
            }
            if ($null -ne $memoryStream) {
                $memoryStream.Dispose()
            }
        }
        return
    }

    try {
        $bodyText = [System.Text.Encoding]::UTF8.GetString($request.BodyBytes)
        $data = $bodyText | ConvertFrom-Json
        $textProperty = $data.PSObject.Properties["text"]
        if ($null -eq $textProperty -or -not ($textProperty.Value -is [string]) -or
            [string]::IsNullOrEmpty([string]$textProperty.Value)) {
            throw "The text field is missing or invalid."
        }
        $text = [string]$textProperty.Value
        $probeProperty = $data.PSObject.Properties["probe"]
        $isProbe = $false
        if ($null -ne $probeProperty) {
            $isProbe = [bool]$probeProperty.Value
        }
    }
    catch {
        Send-HttpResponse -Stream $request.Stream -StatusCode 400 -Reason "Bad Request" -Body "bad request"
        return
    }

    if ($isProbe) {
        Send-HttpResponse -Stream $request.Stream -StatusCode 200 -Reason "OK" -Body "ok"
        return
    }

    try {
        Set-ClipboardTextWithRetry -Text $text
        Send-HttpResponse -Stream $request.Stream -StatusCode 200 -Reason "OK" -Body "ok"
        if ($script:Notifications) {
            Show-ClipRelayNotification -Title "ClipRelay 收到文本" -Message $text
        }
    }
    catch {
        try {
            Send-HttpResponse -Stream $request.Stream -StatusCode 500 -Reason "Internal Server Error" -Body "clipboard error"
        }
        catch {
        }
    }
}

function Show-RelayPeerEditor {
    param(
        [System.Windows.Forms.Form]$Owner,
        [object]$Peer,
        [int]$DefaultPort,
        [string]$DefaultAccessToken = ""
    )

    $colors = @{
        Background = [System.Drawing.Color]::FromArgb(7, 19, 30)
        Surface    = [System.Drawing.Color]::FromArgb(16, 33, 49)
        Raised     = [System.Drawing.Color]::FromArgb(19, 44, 63)
        Field      = [System.Drawing.Color]::FromArgb(10, 31, 48)
        Border     = [System.Drawing.Color]::FromArgb(37, 71, 94)
        Text       = [System.Drawing.Color]::FromArgb(232, 241, 250)
        Muted      = [System.Drawing.Color]::FromArgb(157, 176, 193)
        Cyan       = [System.Drawing.Color]::FromArgb(61, 214, 208)
        Violet     = [System.Drawing.Color]::FromArgb(139, 110, 246)
        Success    = [System.Drawing.Color]::FromArgb(71, 207, 155)
        Danger     = [System.Drawing.Color]::FromArgb(255, 122, 114)
    }
    $bodyFont = "Microsoft YaHei UI"
    $monoFont = "Cascadia Mono"

    $newLabel = {
        param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height, [single]$Size, $Style, $Color, [string]$FontName = $bodyFont)
        $label = New-Object System.Windows.Forms.Label
        $label.Text = $Text
        $label.Location = New-Object System.Drawing.Point($X, $Y)
        $label.Size = New-Object System.Drawing.Size($Width, $Height)
        $label.Font = New-Object System.Drawing.Font($FontName, $Size, $Style)
        $label.ForeColor = $Color
        $label.BackColor = [System.Drawing.Color]::Transparent
        $label.AutoEllipsis = $true
        $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
        $Parent.Controls.Add($label)
        return $label
    }
    $newCard = {
        param($Parent, [int]$X, [int]$Y, [int]$Width, [int]$Height, $BackColor, $BorderColor, [int]$Radius)
        $card = New-Object ClipRelay.RelayPanel
        $card.Location = New-Object System.Drawing.Point($X, $Y)
        $card.Size = New-Object System.Drawing.Size($Width, $Height)
        $card.BackColor = $BackColor
        $card.BorderColor = $BorderColor
        $card.CornerRadius = $Radius
        $Parent.Controls.Add($card)
        return $card
    }
    $newButton = {
        param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height, $Fill, $Hover, $TextColor, $Border = ([System.Drawing.Color]::Transparent))
        $button = New-Object ClipRelay.RelayButton
        $button.Text = $Text
        $button.Location = New-Object System.Drawing.Point($X, $Y)
        $button.Size = New-Object System.Drawing.Size($Width, $Height)
        $button.Font = New-Object System.Drawing.Font($bodyFont, 9.0, [System.Drawing.FontStyle]::Bold)
        $button.FillColor = $Fill
        $button.HoverColor = $Hover
        $button.PressedColor = [System.Windows.Forms.ControlPaint]::Dark($Fill)
        $button.TextColor = $TextColor
        $button.BorderColor = $Border
        $Parent.Controls.Add($button)
        return $button
    }
    $newInput = {
        param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height, [bool]$Password = $false)
        $container = & $newCard $Parent $X $Y $Width $Height $colors.Field $colors.Border 9
        $textBox = New-Object System.Windows.Forms.TextBox
        $textBox.Text = $Text
        $textBox.Location = New-Object System.Drawing.Point(11, 8)
        $textBox.Size = New-Object System.Drawing.Size(($Width - 22), ($Height - 12))
        $textBox.BorderStyle = [System.Windows.Forms.BorderStyle]::None
        $textBox.BackColor = $colors.Field
        $textBox.ForeColor = $colors.Text
        $textBox.Font = New-Object System.Drawing.Font($bodyFont, 9.5)
        $textBox.UseSystemPasswordChar = $Password
        $container.Controls.Add($textBox)
        return [PSCustomObject]@{ Container = $container; TextBox = $textBox }
    }

    $peerId = [string](Get-PropertyValue -Object $Peer -Name "id")
    if ([string]::IsNullOrWhiteSpace($peerId)) { $peerId = [Guid]::NewGuid().ToString("N") }
    $peerName = [string](Get-PropertyValue -Object $Peer -Name "name")
    $peerAddress = [string](Get-PropertyValue -Object $Peer -Name "address")
    $peerPortValue = Get-PropertyValue -Object $Peer -Name "port"
    $peerPort = if ($null -eq $peerPortValue -or [int]$peerPortValue -eq 0) { $DefaultPort } else { [int]$peerPortValue }
    $peerTokenValue = Get-PropertyValue -Object $Peer -Name "accessToken"
    $peerToken = if ($null -eq $peerTokenValue) { $DefaultAccessToken } else { [string]$peerTokenValue }
    $enabledValue = Get-PropertyValue -Object $Peer -Name "enabled"
    $peerEnabled = if ($null -eq $enabledValue) { $true } else { [bool]$enabledValue }

    $form = New-Object ClipRelay.RelayForm
    $form.Text = "ClipRelay 接收设备"
    $form.ClientSize = New-Object System.Drawing.Size(500, 454)
    $form.BackColor = $colors.Background
    $form.Font = New-Object System.Drawing.Font($bodyFont, 9.0)
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterParent
    $form.ShowInTaskbar = $false
    $form.TopMost = $true
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
    if ($null -ne $script:appIcon) { $form.Icon = $script:appIcon }

    $null = & $newLabel $form "RELAY DESTINATION" 26 14 220 20 8.5 ([System.Drawing.FontStyle]::Bold) $colors.Cyan $monoFont
    $null = & $newLabel $form "接收设备" 26 35 220 32 17.0 ([System.Drawing.FontStyle]::Bold) $colors.Text $bodyFont
    $closeButton = & $newButton $form "×" 450 18 28 28 $colors.Background $colors.Raised $colors.Muted
    $closeButton.Font = New-Object System.Drawing.Font("Segoe UI", 14.0)

    $editorCard = & $newCard $form 24 82 452 286 $colors.Surface $colors.Border 16
    $null = & $newLabel $editorCard "设备名称" 18 14 190 18 8.0 ([System.Drawing.FontStyle]::Bold) $colors.Muted $bodyFont
    $nameInput = & $newInput $editorCard $peerName 18 34 416 36 $false
    $null = & $newLabel $editorCard "局域网地址" 18 80 190 18 8.0 ([System.Drawing.FontStyle]::Bold) $colors.Muted $bodyFont
    $addressInput = & $newInput $editorCard $peerAddress 18 100 270 36 $false
    $null = & $newLabel $editorCard "端口" 306 80 70 18 8.0 ([System.Drawing.FontStyle]::Bold) $colors.Muted $bodyFont
    $peerPortInput = & $newInput $editorCard ([string]$peerPort) 306 100 128 36 $false
    $null = & $newLabel $editorCard "访问密钥（这台目标设备）" 18 146 260 18 8.0 ([System.Drawing.FontStyle]::Bold) $colors.Muted $bodyFont
    $peerTokenInput = & $newInput $editorCard $peerToken 18 166 318 36 $true
    $showTokenButton = & $newButton $editorCard "显示" 346 166 88 36 $colors.Raised $colors.Border $colors.Muted $colors.Border
    $null = & $newLabel $editorCard "加入广播" 18 218 110 22 9.0 ([System.Drawing.FontStyle]::Bold) $colors.Text $bodyFont
    $enabledToggle = New-Object ClipRelay.RelayToggle
    $enabledToggle.Location = New-Object System.Drawing.Point(125, 218)
    $enabledToggle.Checked = $peerEnabled
    $editorCard.Controls.Add($enabledToggle)
    $testState = & $newLabel $editorCard "保存前可先检测该设备" 18 250 266 22 8.0 ([System.Drawing.FontStyle]::Regular) $colors.Muted $bodyFont
    $testButton = & $newButton $editorCard "检测设备" 326 240 108 34 $colors.Raised $colors.Border $colors.Cyan $colors.Border

    $cancelButton = & $newButton $form "取消" 282 390 92 40 $colors.Surface $colors.Raised $colors.Muted $colors.Border
    $saveButton = & $newButton $form "保存设备" 384 390 92 40 $colors.Cyan ([System.Drawing.Color]::FromArgb(91, 230, 224)) $colors.Background

    $testPeerCommand = Get-Command Test-PeerConnectivity
    $normalizePeersCommand = Get-Command Get-NormalizedRelayPeers
    $closeButton.Add_Click({ $form.Close() }.GetNewClosure())
    $cancelButton.Add_Click({ $form.Close() }.GetNewClosure())
    $showTokenButton.Add_Click({
        $peerTokenInput.TextBox.UseSystemPasswordChar = -not $peerTokenInput.TextBox.UseSystemPasswordChar
        $showTokenButton.Text = if ($peerTokenInput.TextBox.UseSystemPasswordChar) { "显示" } else { "隐藏" }
    }.GetNewClosure())
    $testButton.Add_Click({
        $parsedPort = 0
        if (-not [int]::TryParse($peerPortInput.TextBox.Text.Trim(), [ref]$parsedPort)) {
            $testState.Text = "端口必须是整数"
            $testState.ForeColor = $colors.Danger
            return
        }
        $testButton.Enabled = $false
        $testButton.Text = "检测中"
        $form.Update()
        try {
            $null = & $testPeerCommand -Address $addressInput.TextBox.Text.Trim() -Port $parsedPort -TimeoutMilliseconds 5000 -AccessToken $peerTokenInput.TextBox.Text
            $testState.Text = "链路可用 · $(Get-Date -Format 'HH:mm:ss')"
            $testState.ForeColor = $colors.Success
        }
        catch {
            $testState.Text = [string]$_.Exception.Message
            $testState.ForeColor = $colors.Danger
        }
        finally {
            $testButton.Enabled = $true
            $testButton.Text = "检测设备"
        }
    }.GetNewClosure())
    $saveButton.Add_Click({
        try {
            $parsedPort = 0
            if (-not [int]::TryParse($peerPortInput.TextBox.Text.Trim(), [ref]$parsedPort)) {
                throw "设备端口必须是整数。"
            }
            $candidate = [PSCustomObject]@{
                id = $peerId
                name = $nameInput.TextBox.Text
                address = $addressInput.TextBox.Text
                port = $parsedPort
                accessToken = $peerTokenInput.TextBox.Text
                enabled = [bool]$enabledToggle.Checked
            }
            $normalized = @(& $normalizePeersCommand -Peers @($candidate) -DefaultPort $DefaultPort -DefaultAccessToken $DefaultAccessToken)[0]
            $form.Tag = $normalized
            $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
            $form.Close()
        }
        catch {
            $testState.Text = [string]$_.Exception.Message
            $testState.ForeColor = $colors.Danger
        }
    }.GetNewClosure())

    $form.AcceptButton = $saveButton
    $form.CancelButton = $cancelButton
    $dialogResult = if ($null -ne $Owner) { $form.ShowDialog($Owner) } else { $form.ShowDialog() }
    $result = if ($dialogResult -eq [System.Windows.Forms.DialogResult]::OK) { $form.Tag } else { $null }
    $form.Dispose()
    return $result
}

function Show-RelayPeerManager {
    param(
        [System.Windows.Forms.Form]$Owner,
        [object[]]$Peers,
        [int]$DefaultPort,
        [string]$DefaultAccessToken = ""
    )

    $colors = @{
        Background = [System.Drawing.Color]::FromArgb(7, 19, 30)
        Surface    = [System.Drawing.Color]::FromArgb(16, 33, 49)
        Raised     = [System.Drawing.Color]::FromArgb(19, 44, 63)
        Border     = [System.Drawing.Color]::FromArgb(37, 71, 94)
        Text       = [System.Drawing.Color]::FromArgb(232, 241, 250)
        Muted      = [System.Drawing.Color]::FromArgb(157, 176, 193)
        Cyan       = [System.Drawing.Color]::FromArgb(61, 214, 208)
        Violet     = [System.Drawing.Color]::FromArgb(139, 110, 246)
        Danger     = [System.Drawing.Color]::FromArgb(255, 122, 114)
    }
    $bodyFont = "Microsoft YaHei UI"
    $monoFont = "Cascadia Mono"
    $peerList = New-Object System.Collections.ArrayList
    foreach ($peer in @(Copy-RelayPeers -Peers $Peers)) { $null = $peerList.Add($peer) }

    $newLabel = {
        param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height, [single]$Size, $Style, $Color, [string]$FontName = $bodyFont)
        $label = New-Object System.Windows.Forms.Label
        $label.Text = $Text
        $label.Location = New-Object System.Drawing.Point($X, $Y)
        $label.Size = New-Object System.Drawing.Size($Width, $Height)
        $label.Font = New-Object System.Drawing.Font($FontName, $Size, $Style)
        $label.ForeColor = $Color
        $label.BackColor = [System.Drawing.Color]::Transparent
        $label.AutoEllipsis = $true
        $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
        $Parent.Controls.Add($label)
        return $label
    }
    $newButton = {
        param($Parent, [string]$Text, [int]$X, [int]$Y, [int]$Width, [int]$Height, $Fill, $Hover, $TextColor, $Border = ([System.Drawing.Color]::Transparent))
        $button = New-Object ClipRelay.RelayButton
        $button.Text = $Text
        $button.Location = New-Object System.Drawing.Point($X, $Y)
        $button.Size = New-Object System.Drawing.Size($Width, $Height)
        $button.Font = New-Object System.Drawing.Font($bodyFont, 8.5, [System.Drawing.FontStyle]::Bold)
        $button.FillColor = $Fill
        $button.HoverColor = $Hover
        $button.PressedColor = [System.Windows.Forms.ControlPaint]::Dark($Fill)
        $button.TextColor = $TextColor
        $button.BorderColor = $Border
        $Parent.Controls.Add($button)
        return $button
    }

    $form = New-Object ClipRelay.RelayForm
    $form.Text = "ClipRelay 广播设备"
    $form.ClientSize = New-Object System.Drawing.Size(560, 592)
    $form.BackColor = $colors.Background
    $form.Font = New-Object System.Drawing.Font($bodyFont, 9.0)
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterParent
    $form.ShowInTaskbar = $false
    $form.TopMost = $true
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
    if ($null -ne $script:appIcon) { $form.Icon = $script:appIcon }

    $null = & $newLabel $form "FAN-OUT ROUTES" 26 14 220 20 8.5 ([System.Drawing.FontStyle]::Bold) $colors.Cyan $monoFont
    $null = & $newLabel $form "广播设备" 26 35 220 32 17.0 ([System.Drawing.FontStyle]::Bold) $colors.Text $bodyFont
    $countLabel = & $newLabel $form "" 300 35 188 32 8.5 ([System.Drawing.FontStyle]::Bold) $colors.Muted $bodyFont
    $countLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
    $closeButton = & $newButton $form "×" 510 18 28 28 $colors.Background $colors.Raised $colors.Muted
    $closeButton.Font = New-Object System.Drawing.Font("Segoe UI", 14.0)

    $listHost = New-Object System.Windows.Forms.Panel
    $listHost.Location = New-Object System.Drawing.Point(24, 86)
    $listHost.Size = New-Object System.Drawing.Size(512, 390)
    $listHost.BackColor = $colors.Background
    $listHost.AutoScroll = $true
    $form.Controls.Add($listHost)
    $emptyLabel = & $newLabel $listHost "尚未添加设备" 0 140 490 40 11.0 ([System.Drawing.FontStyle]::Bold) $colors.Muted $bodyFont
    $emptyLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter

    $addButton = & $newButton $form "+ 添加设备" 24 494 116 38 $colors.Surface $colors.Raised $colors.Cyan $colors.Border
    $hintLabel = & $newLabel $form "发送时会并行投递；单台离线不影响其他设备" 154 494 382 38 8.0 ([System.Drawing.FontStyle]::Regular) $colors.Muted $bodyFont
    $hintLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
    $cancelButton = & $newButton $form "取消" 340 542 92 36 $colors.Surface $colors.Raised $colors.Muted $colors.Border
    $saveButton = & $newButton $form "应用设备" 442 542 94 36 $colors.Cyan ([System.Drawing.Color]::FromArgb(91, 230, 224)) $colors.Background

    $editorCommand = Get-Command Show-RelayPeerEditor
    $normalizePeersCommand = Get-Command Get-NormalizedRelayPeers
    $refreshRows = $null
    $refreshRows = {
        $listHost.SuspendLayout()
        try {
            foreach ($control in @($listHost.Controls)) { $control.Dispose() }
            $listHost.Controls.Clear()
            if ($peerList.Count -eq 0) {
                $empty = & $newLabel $listHost "尚未添加设备" 0 140 490 40 11.0 ([System.Drawing.FontStyle]::Bold) $colors.Muted $bodyFont
                $empty.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
            }
            else {
                for ($index = 0; $index -lt $peerList.Count; $index++) {
                    $peer = $peerList[$index]
                    $peerId = [string]$peer.id
                    $row = New-Object ClipRelay.RelayPanel
                    $row.Location = New-Object System.Drawing.Point(0, ($index * 72))
                    $row.Size = New-Object System.Drawing.Size(492, 62)
                    $row.BackColor = $colors.Surface
                    $row.BorderColor = $colors.Border
                    $row.CornerRadius = 13
                    $listHost.Controls.Add($row)

                    $toggle = New-Object ClipRelay.RelayToggle
                    $toggle.Location = New-Object System.Drawing.Point(14, 19)
                    $toggle.Checked = [bool]$peer.enabled
                    $row.Controls.Add($toggle)
                    $name = & $newLabel $row ([string]$peer.name) 70 7 145 24 9.5 ([System.Drawing.FontStyle]::Bold) $colors.Text $bodyFont
                    $address = & $newLabel $row "$($peer.address):$($peer.port)" 70 31 244 20 8.0 ([System.Drawing.FontStyle]::Regular) $colors.Muted $monoFont
                    if (-not [string]::IsNullOrWhiteSpace([string]$peer.accessToken)) {
                        $auth = & $newLabel $row "已认证" 286 8 58 21 7.5 ([System.Drawing.FontStyle]::Bold) $colors.Violet $bodyFont
                        $auth.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
                    }
                    $editButton = & $newButton $row "编辑" 354 14 58 34 $colors.Raised $colors.Border $colors.Cyan $colors.Border
                    $removeButton = & $newButton $row "移除" 420 14 58 34 $colors.Surface $colors.Border $colors.Muted $colors.Border

                    $toggle.Add_CheckedChanged({
                        for ($peerIndex = 0; $peerIndex -lt $peerList.Count; $peerIndex++) {
                            if ([string]$peerList[$peerIndex].id -eq $peerId) {
                                $peerList[$peerIndex].enabled = [bool]$toggle.Checked
                                break
                            }
                        }
                        $countLabel.Text = "$(@($peerList | Where-Object { $_.enabled }).Count)/$($peerList.Count) 台已启用"
                    }.GetNewClosure())
                    $editButton.Add_Click({
                        for ($peerIndex = 0; $peerIndex -lt $peerList.Count; $peerIndex++) {
                            if ([string]$peerList[$peerIndex].id -eq $peerId) {
                                $edited = & $editorCommand -Owner $form -Peer $peerList[$peerIndex] -DefaultPort $DefaultPort -DefaultAccessToken $DefaultAccessToken
                                if ($null -ne $edited) {
                                    $peerList[$peerIndex] = $edited
                                    & $refreshRows
                                }
                                break
                            }
                        }
                    }.GetNewClosure())
                    $removeButton.Add_Click({
                        for ($peerIndex = 0; $peerIndex -lt $peerList.Count; $peerIndex++) {
                            if ([string]$peerList[$peerIndex].id -eq $peerId) {
                                $peerList.RemoveAt($peerIndex)
                                & $refreshRows
                                break
                            }
                        }
                    }.GetNewClosure())
                }
            }
            $countLabel.Text = "$(@($peerList | Where-Object { $_.enabled }).Count)/$($peerList.Count) 台已启用"
        }
        finally {
            $listHost.ResumeLayout()
        }
    }.GetNewClosure()

    $addButton.Add_Click({
        if ($peerList.Count -ge 16) {
            $hintLabel.Text = "最多可以配置 16 台设备"
            $hintLabel.ForeColor = $colors.Danger
            return
        }
        $seed = [PSCustomObject]@{
            id = [Guid]::NewGuid().ToString("N")
            name = "设备 $($peerList.Count + 1)"
            address = ""
            port = $DefaultPort
            accessToken = ""
            enabled = $true
        }
        $edited = & $editorCommand -Owner $form -Peer $seed -DefaultPort $DefaultPort -DefaultAccessToken $DefaultAccessToken
        if ($null -ne $edited) {
            $null = $peerList.Add($edited)
            & $refreshRows
        }
    }.GetNewClosure())
    $closeButton.Add_Click({ $form.Close() }.GetNewClosure())
    $cancelButton.Add_Click({ $form.Close() }.GetNewClosure())
    $saveButton.Add_Click({
        try {
            $normalized = @(& $normalizePeersCommand -Peers @($peerList) -DefaultPort $DefaultPort -DefaultAccessToken $DefaultAccessToken)
            if (@($normalized | Where-Object { $_.enabled }).Count -lt 1) {
                throw "至少需要启用一台接收设备。"
            }
            $form.Tag = $normalized
            $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
            $form.Close()
        }
        catch {
            $hintLabel.Text = [string]$_.Exception.Message
            $hintLabel.ForeColor = $colors.Danger
        }
    }.GetNewClosure())

    & $refreshRows
    $form.AcceptButton = $saveButton
    $form.CancelButton = $cancelButton
    $dialogResult = if ($null -ne $Owner) { $form.ShowDialog($Owner) } else { $form.ShowDialog() }
    $result = if ($dialogResult -eq [System.Windows.Forms.DialogResult]::OK) { @($form.Tag) } else { $null }
    $form.Dispose()
    return $result
}

function Show-RelayControlCenter {
    if ($script:configurationDialogOpen) {
        return
    }

    $script:configurationDialogOpen = $true
    $form = $null
    try {
        [System.Windows.Forms.Application]::EnableVisualStyles()

        $colors = @{
            Background = [System.Drawing.Color]::FromArgb(7, 19, 30)
            Surface    = [System.Drawing.Color]::FromArgb(16, 33, 49)
            Raised     = [System.Drawing.Color]::FromArgb(19, 44, 63)
            Field      = [System.Drawing.Color]::FromArgb(10, 31, 48)
            Border     = [System.Drawing.Color]::FromArgb(37, 71, 94)
            Text       = [System.Drawing.Color]::FromArgb(232, 241, 250)
            Muted      = [System.Drawing.Color]::FromArgb(157, 176, 193)
            Cyan       = [System.Drawing.Color]::FromArgb(61, 214, 208)
            Blue       = [System.Drawing.Color]::FromArgb(47, 128, 237)
            Violet     = [System.Drawing.Color]::FromArgb(139, 110, 246)
            Success    = [System.Drawing.Color]::FromArgb(71, 207, 155)
            Danger     = [System.Drawing.Color]::FromArgb(255, 122, 114)
        }
        $displayFont = "Segoe UI Variable Display"
        $bodyFont = "Microsoft YaHei UI"
        $monoFont = "Cascadia Mono"
        $draftPeers = New-Object System.Collections.ArrayList
        foreach ($configuredPeer in @(Copy-RelayPeers -Peers $script:Peers)) {
            $null = $draftPeers.Add($configuredPeer)
        }

        $newLabel = {
            param(
                [System.Windows.Forms.Control]$Parent,
                [string]$Text,
                [int]$X,
                [int]$Y,
                [int]$Width,
                [int]$Height,
                [single]$Size,
                [System.Drawing.FontStyle]$Style,
                [System.Drawing.Color]$Color,
                [string]$FontName = $bodyFont
            )
            $label = New-Object System.Windows.Forms.Label
            $label.Text = $Text
            $label.Location = New-Object System.Drawing.Point($X, $Y)
            $label.Size = New-Object System.Drawing.Size($Width, $Height)
            $label.Font = New-Object System.Drawing.Font($FontName, $Size, $Style)
            $label.ForeColor = $Color
            $label.BackColor = [System.Drawing.Color]::Transparent
            $label.AutoEllipsis = $true
            $label.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
            $Parent.Controls.Add($label)
            return $label
        }

        $newCard = {
            param(
                [System.Windows.Forms.Control]$Parent,
                [int]$X,
                [int]$Y,
                [int]$Width,
                [int]$Height,
                [System.Drawing.Color]$BackColor = $colors.Surface,
                [System.Drawing.Color]$BorderColor = $colors.Border,
                [int]$Radius = 14
            )
            $card = New-Object ClipRelay.RelayPanel
            $card.Location = New-Object System.Drawing.Point($X, $Y)
            $card.Size = New-Object System.Drawing.Size($Width, $Height)
            $card.BackColor = $BackColor
            $card.BorderColor = $BorderColor
            $card.CornerRadius = $Radius
            $Parent.Controls.Add($card)
            return $card
        }

        $newButton = {
            param(
                [System.Windows.Forms.Control]$Parent,
                [string]$Text,
                [int]$X,
                [int]$Y,
                [int]$Width,
                [int]$Height,
                [System.Drawing.Color]$FillColor,
                [System.Drawing.Color]$HoverColor,
                [System.Drawing.Color]$TextColor,
                [System.Drawing.Color]$BorderColor = ([System.Drawing.Color]::Transparent)
            )
            $button = New-Object ClipRelay.RelayButton
            $button.Text = $Text
            $button.Location = New-Object System.Drawing.Point($X, $Y)
            $button.Size = New-Object System.Drawing.Size($Width, $Height)
            $button.Font = New-Object System.Drawing.Font($bodyFont, 9.0, [System.Drawing.FontStyle]::Bold)
            $button.FillColor = $FillColor
            $button.HoverColor = $HoverColor
            $button.PressedColor = [System.Windows.Forms.ControlPaint]::Dark($FillColor)
            $button.TextColor = $TextColor
            $button.BorderColor = $BorderColor
            $Parent.Controls.Add($button)
            return $button
        }

        $newInput = {
            param(
                [System.Windows.Forms.Control]$Parent,
                [string]$Text,
                [int]$X,
                [int]$Y,
                [int]$Width,
                [int]$Height,
                [bool]$Password = $false
            )
            $container = & $newCard $Parent $X $Y $Width $Height $colors.Field $colors.Border 9
            $textBox = New-Object System.Windows.Forms.TextBox
            $textBox.Text = $Text
            $textBox.Location = New-Object System.Drawing.Point(11, 8)
            $textBox.Size = New-Object System.Drawing.Size(($Width - 22), ($Height - 12))
            $textBox.BorderStyle = [System.Windows.Forms.BorderStyle]::None
            $textBox.BackColor = $colors.Field
            $textBox.ForeColor = $colors.Text
            $textBox.Font = New-Object System.Drawing.Font($bodyFont, 9.5, [System.Drawing.FontStyle]::Regular)
            $textBox.UseSystemPasswordChar = $Password
            $container.Controls.Add($textBox)
            $textBox.Add_Enter({ $container.BorderColor = $colors.Cyan; $container.Invalidate() }.GetNewClosure())
            $textBox.Add_Leave({ $container.BorderColor = $colors.Border; $container.Invalidate() }.GetNewClosure())
            return [PSCustomObject]@{ Container = $container; TextBox = $textBox }
        }

        $form = New-Object ClipRelay.RelayForm
        $form.Text = "ClipRelay 设备链路"
        $form.ClientSize = New-Object System.Drawing.Size(640, 772)
        $form.BackColor = $colors.Background
        $form.Font = New-Object System.Drawing.Font($bodyFont, 9.0, [System.Drawing.FontStyle]::Regular)
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $form.ShowInTaskbar = $true
        $form.TopMost = $true
        $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
        if ($null -ne $script:appIcon) {
            $form.Icon = $script:appIcon
        }

        $null = & $newLabel $form "CLIP / RELAY" 28 11 220 20 9.0 ([System.Drawing.FontStyle]::Bold) $colors.Cyan $monoFont
        $null = & $newLabel $form "设备链路" 28 29 300 31 16.5 ([System.Drawing.FontStyle]::Bold) $colors.Text $bodyFont
        $null = & $newLabel $form "文本与全屏截图 · 仅用于可信局域网" 29 61 340 18 8.5 ([System.Drawing.FontStyle]::Regular) $colors.Muted $bodyFont

        $serviceChip = & $newCard $form 368 22 198 34 $colors.Surface $colors.Border 17
        $serviceDot = & $newLabel $serviceChip "●" 11 4 18 24 9.0 ([System.Drawing.FontStyle]::Bold) $colors.Cyan $bodyFont
        $serviceLabel = & $newLabel $serviceChip "本机接收中  :$script:Port" 28 4 160 24 8.5 ([System.Drawing.FontStyle]::Bold) $colors.Text $bodyFont
        $closeButton = & $newButton $form "×" 588 19 30 30 $colors.Background $colors.Raised $colors.Muted
        $closeButton.Font = New-Object System.Drawing.Font("Segoe UI", 14.0, [System.Drawing.FontStyle]::Regular)

        $routeCard = & $newCard $form 24 88 592 233 $colors.Surface $colors.Border 17
        $null = & $newLabel $routeCard "DEVICE ROUTE" 18 12 220 22 8.5 ([System.Drawing.FontStyle]::Bold) $colors.Cyan $monoFont
        $null = & $newLabel $routeCard "自动检测链路" 430 12 144 22 8.0 ([System.Drawing.FontStyle]::Regular) $colors.Muted $bodyFont

        $localCard = & $newCard $routeCard 18 42 236 106 $colors.Raised ([System.Drawing.Color]::Transparent) 13
        $null = & $newLabel $localCard "这台电脑" 12 8 128 22 9.0 ([System.Drawing.FontStyle]::Bold) $colors.Text $bodyFont
        $localAddressField = & $newCard $localCard 12 35 156 32 $colors.Field $colors.Border 9
        $localAddressValue = & $newLabel $localAddressField "" 9 2 115 27 8.5 ([System.Drawing.FontStyle]::Regular) $colors.Text $bodyFont
        $switchAddressButton = & $newButton $localAddressField "↕" 127 2 27 28 $colors.Field $colors.Border $colors.Muted
        $switchAddressButton.Font = New-Object System.Drawing.Font("Segoe UI Symbol", 9.0, [System.Drawing.FontStyle]::Bold)
        $copyButton = & $newButton $localCard "复制" 174 35 50 30 $colors.Field $colors.Border $colors.Cyan $colors.Border
        $localAddresses = @(Get-LocalShareableAddresses)
        if ($localAddresses.Count -gt 0) {
            $localAddressField.Tag = 0
            $localAddressValue.Text = [string]$localAddresses[0].Address
            $switchAddressButton.Enabled = $localAddresses.Count -gt 1
        }
        else {
            $localAddressField.Tag = -1
            $localAddressValue.Text = "未检测到地址"
            $switchAddressButton.Enabled = $false
            $copyButton.Enabled = $false
        }
        $null = & $newLabel $localCard "监听 0.0.0.0:$script:Port" 12 72 210 20 8.0 ([System.Drawing.FontStyle]::Regular) $colors.Muted $monoFont

        $routeLineLeft = New-Object System.Windows.Forms.Panel
        $routeLineLeft.Location = New-Object System.Drawing.Point(266, 94)
        $routeLineLeft.Size = New-Object System.Drawing.Size(24, 2)
        $routeLineLeft.BackColor = $colors.Cyan
        $routeCard.Controls.Add($routeLineLeft)
        $routePulse = & $newCard $routeCard 294 90 10 10 $colors.Cyan ([System.Drawing.Color]::Transparent) 5
        $routeTrunk = New-Object System.Windows.Forms.Panel
        $routeTrunk.Location = New-Object System.Drawing.Point(308, 94)
        $routeTrunk.Size = New-Object System.Drawing.Size(9, 2)
        $routeTrunk.BackColor = $colors.Cyan
        $routeCard.Controls.Add($routeTrunk)
        $routeBranch = New-Object System.Windows.Forms.Panel
        $routeBranch.Location = New-Object System.Drawing.Point(316, 72)
        $routeBranch.Size = New-Object System.Drawing.Size(2, 46)
        $routeBranch.BackColor = $colors.Cyan
        $routeCard.Controls.Add($routeBranch)
        foreach ($branchY in @(72, 94, 116)) {
            $branchLine = New-Object System.Windows.Forms.Panel
            $branchLine.Location = New-Object System.Drawing.Point(316, $branchY)
            $branchLine.Size = New-Object System.Drawing.Size(14, 2)
            $branchLine.BackColor = $colors.Cyan
            $routeCard.Controls.Add($branchLine)
        }

        $peerCard = & $newCard $routeCard 338 42 236 106 $colors.Raised ([System.Drawing.Color]::Transparent) 13
        $null = & $newLabel $peerCard "并行广播" 12 7 100 22 9.0 ([System.Drawing.FontStyle]::Bold) $colors.Text $bodyFont
        $peerCountLabel = & $newLabel $peerCard "" 112 7 112 22 8.0 ([System.Drawing.FontStyle]::Bold) $colors.Cyan $bodyFont
        $peerCountLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
        $peerSummaryOne = & $newLabel $peerCard "" 12 31 212 20 8.0 ([System.Drawing.FontStyle]::Regular) $colors.Muted $bodyFont
        $peerSummaryTwo = & $newLabel $peerCard "" 12 51 212 20 8.0 ([System.Drawing.FontStyle]::Regular) $colors.Muted $bodyFont
        $managePeersButton = & $newButton $peerCard "管理设备" 128 72 96 27 $colors.Field $colors.Border $colors.Cyan $colors.Border

        $connectionPanel = & $newCard $routeCard 18 160 556 55 $colors.Field $colors.Border 12
        $connectionDot = & $newLabel $connectionPanel "●" 12 6 18 20 8.5 ([System.Drawing.FontStyle]::Bold) $colors.Muted $bodyFont
        $connectionTitle = & $newLabel $connectionPanel "准备检测链路" 31 5 380 22 9.0 ([System.Drawing.FontStyle]::Bold) $colors.Text $bodyFont
        $connectionDetail = & $newLabel $connectionPanel "输入对方地址后检测" 13 27 415 20 8.0 ([System.Drawing.FontStyle]::Regular) $colors.Muted $bodyFont
        $testButton = & $newButton $connectionPanel "检测全部" 435 10 108 35 $colors.Raised $colors.Border $colors.Cyan $colors.Border

        $shortcutCard = & $newCard $form 24 333 592 118 $colors.Surface $colors.Border 17
        $null = & $newLabel $shortcutCard "SHORTCUTS" 18 10 220 22 8.5 ([System.Drawing.FontStyle]::Bold) $colors.Violet $monoFont
        $textShortcut = & $newCard $shortcutCard 18 39 270 61 $colors.Raised ([System.Drawing.Color]::Transparent) 12
        $textBadge = & $newCard $textShortcut 10 13 34 34 $colors.Violet ([System.Drawing.Color]::Transparent) 17
        $badgeText = & $newLabel $textBadge "T" 0 0 34 34 10.0 ([System.Drawing.FontStyle]::Bold) $colors.Text $monoFont
        $badgeText.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
        $null = & $newLabel $textShortcut "CTRL + C" 56 8 125 23 10.0 ([System.Drawing.FontStyle]::Bold) $colors.Text $monoFont
        $null = & $newLabel $textShortcut "发送文本 · 1 秒重复保护" 56 31 202 19 8.0 ([System.Drawing.FontStyle]::Regular) $colors.Muted $bodyFont

        $imageShortcut = & $newCard $shortcutCard 304 39 270 61 $colors.Raised ([System.Drawing.Color]::Transparent) 12
        $imageBadge = & $newCard $imageShortcut 10 13 34 34 $colors.Cyan ([System.Drawing.Color]::Transparent) 17
        $badgeImage = & $newLabel $imageBadge "S" 0 0 34 34 10.0 ([System.Drawing.FontStyle]::Bold) $colors.Background $monoFont
        $badgeImage.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
        $null = & $newLabel $imageShortcut "CTRL + ALT + F12" 56 8 166 23 9.5 ([System.Drawing.FontStyle]::Bold) $colors.Text $monoFont
        $screenshotHotkeyState = & $newLabel $imageShortcut "检测中" 205 8 54 23 8.0 ([System.Drawing.FontStyle]::Bold) $colors.Muted $bodyFont
        $screenshotHotkeyState.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
        $null = & $newLabel $imageShortcut "静默发送整个虚拟桌面" 56 31 202 19 8.0 ([System.Drawing.FontStyle]::Regular) $colors.Muted $bodyFont

        $activityCard = & $newCard $form 24 463 592 70 $colors.Surface $colors.Border 17
        $activityAccent = New-Object System.Windows.Forms.Panel
        $activityAccent.Location = New-Object System.Drawing.Point(0, 16)
        $activityAccent.Size = New-Object System.Drawing.Size(3, 38)
        $activityAccent.BackColor = $colors.Muted
        $activityCard.Controls.Add($activityAccent)
        $null = & $newLabel $activityCard "LAST RELAY" 18 8 120 18 8.0 ([System.Drawing.FontStyle]::Bold) $colors.Muted $monoFont
        $activityTitle = & $newLabel $activityCard "等待首次发送" 18 26 430 25 10.0 ([System.Drawing.FontStyle]::Bold) $colors.Text $bodyFont
        $activityTime = & $newLabel $activityCard "—" 450 24 124 26 8.5 ([System.Drawing.FontStyle]::Regular) $colors.Muted $monoFont
        $activityTime.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight

        $preferencesCard = & $newCard $form 24 545 592 154 $colors.Surface $colors.Border 17
        $null = & $newLabel $preferencesCard "PREFERENCES" 18 9 180 20 8.5 ([System.Drawing.FontStyle]::Bold) $colors.Blue $monoFont
        $null = & $newLabel $preferencesCard "通知提醒" 18 32 110 21 9.0 ([System.Drawing.FontStyle]::Bold) $colors.Text $bodyFont
        $null = & $newLabel $preferencesCard "接收内容和异常时显示" 18 52 210 18 7.8 ([System.Drawing.FontStyle]::Regular) $colors.Muted $bodyFont
        $notifyToggle = New-Object ClipRelay.RelayToggle
        $notifyToggle.Location = New-Object System.Drawing.Point(238, 39)
        $notifyToggle.Checked = $script:Notifications
        $preferencesCard.Controls.Add($notifyToggle)

        $null = & $newLabel $preferencesCard "开机自启" 310 32 110 21 9.0 ([System.Drawing.FontStyle]::Bold) $colors.Text $bodyFont
        $null = & $newLabel $preferencesCard "登录后自动保持接收" 310 52 205 18 7.8 ([System.Drawing.FontStyle]::Regular) $colors.Muted $bodyFont
        $startupToggle = New-Object ClipRelay.RelayToggle
        $startupToggle.Location = New-Object System.Drawing.Point(530, 39)
        $startupToggle.Checked = Test-StartupRegistration
        $preferencesCard.Controls.Add($startupToggle)

        $null = & $newLabel $preferencesCard "本机端口" 18 78 78 18 8.0 ([System.Drawing.FontStyle]::Bold) $colors.Muted $bodyFont
        $portInput = & $newInput $preferencesCard ([string]$script:Port) 18 97 86 34 $false
        $null = & $newLabel $preferencesCard "本机接收密钥" 122 78 110 18 8.0 ([System.Drawing.FontStyle]::Bold) $colors.Muted $bodyFont
        $tokenInput = & $newInput $preferencesCard $script:AccessToken 122 97 354 34 $true
        $showTokenButton = & $newButton $preferencesCard "显示" 486 97 88 34 $colors.Raised $colors.Border $colors.Muted $colors.Border
        $null = & $newLabel $preferencesCard "仅保护发往本机的请求；各目标密钥在【管理设备】中设置。" 122 132 452 16 7.5 ([System.Drawing.FontStyle]::Regular) $colors.Muted $bodyFont

        $footerHint = & $newLabel $form "保存端口变更时会更新防火墙并自动重启" 28 718 330 32 8.0 ([System.Drawing.FontStyle]::Regular) $colors.Muted $bodyFont
        $cancelButton = & $newButton $form "取消" 404 716 92 38 $colors.Surface $colors.Raised $colors.Muted $colors.Border
        $saveButton = & $newButton $form "保存设置" 506 716 110 38 $colors.Cyan ([System.Drawing.Color]::FromArgb(91, 230, 224)) $colors.Background

        $setClipboardCommand = Get-Command Set-ClipboardTextWithRetry
        $testPeersCommand = Get-Command Test-RelayPeersConnectivity
        $peerManagerCommand = Get-Command Show-RelayPeerManager
        $saveSettingsCommand = Get-Command Save-PeerConfiguration
        $snapshotCommand = Get-Command Get-RelayRuntimeSnapshot
        $notificationCommand = Get-Command Show-ClipRelayNotification

        $updatePeerSummary = {
            $enabledDraftPeers = @($draftPeers | Where-Object { [bool]$_.enabled })
            $peerCountLabel.Text = "$($enabledDraftPeers.Count)/$($draftPeers.Count) 台启用"
            $summaryLabels = @($peerSummaryOne, $peerSummaryTwo)
            foreach ($label in $summaryLabels) {
                $label.Text = ""
                $label.ForeColor = $colors.Muted
            }
            if ($enabledDraftPeers.Count -eq 0) {
                $peerSummaryOne.Text = "● 没有启用的设备"
                $peerSummaryOne.ForeColor = $colors.Danger
                return
            }
            $visibleCount = [Math]::Min(2, $enabledDraftPeers.Count)
            for ($index = 0; $index -lt $visibleCount; $index++) {
                $peer = $enabledDraftPeers[$index]
                $summaryLabels[$index].Text = "● $($peer.name) · $($peer.address)"
                $summaryLabels[$index].ForeColor = $colors.Muted
            }
            if ($enabledDraftPeers.Count -gt 2) {
                $peerSummaryTwo.Text = "+ 另有 $($enabledDraftPeers.Count - 1) 台设备"
            }
        }.GetNewClosure()

        $runCheck = {
            $enabledDraftPeers = @($draftPeers | Where-Object { [bool]$_.enabled })
            if ($enabledDraftPeers.Count -lt 1) {
                $connectionPanel.BorderColor = $colors.Danger
                $connectionDot.ForeColor = $colors.Danger
                $connectionTitle.Text = "没有启用的广播设备"
                $connectionDetail.Text = "点击管理设备，至少启用一台接收端"
                $connectionPanel.Invalidate()
                return
            }

            $testButton.Enabled = $false
            $testButton.Text = "检测中"
            $connectionPanel.BorderColor = $colors.Border
            $connectionDot.ForeColor = $colors.Muted
            $connectionTitle.Text = "正在并行检测 $($enabledDraftPeers.Count) 台设备"
            $connectionDetail.Text = "每台设备独立响应，不会修改剪贴板"
            $connectionPanel.Invalidate()
            $form.Update()
            try {
                $summary = & $testPeersCommand -Peers @($draftPeers) -TimeoutMilliseconds 5000
                if ($summary.State -eq "success") {
                    $connectionPanel.BorderColor = $colors.Success
                    $connectionDot.ForeColor = $colors.Success
                    $connectionTitle.Text = "全部可用 · $($summary.SuccessCount)/$($summary.TotalCount) 台设备"
                }
                elseif ($summary.State -eq "partial") {
                    $connectionPanel.BorderColor = $colors.Violet
                    $connectionDot.ForeColor = $colors.Violet
                    $connectionTitle.Text = "部分可用 · $($summary.SuccessCount)/$($summary.TotalCount) 台设备"
                }
                else {
                    $connectionPanel.BorderColor = $colors.Danger
                    $connectionDot.ForeColor = $colors.Danger
                    $connectionTitle.Text = "所有广播设备均不可达"
                }
                $connectionDetail.Text = "$($summary.Detail) · $(Get-Date -Format 'HH:mm:ss')"
            }
            catch {
                $connectionPanel.BorderColor = $colors.Danger
                $connectionDot.ForeColor = $colors.Danger
                $connectionTitle.Text = "无法检测广播设备"
                $connectionDetail.Text = [string]$_.Exception.Message
            }
            finally {
                $connectionPanel.Invalidate()
                $testButton.Enabled = $true
                $testButton.Text = "检测全部"
            }
        }.GetNewClosure()

        & $updatePeerSummary

        $copyButton.Add_Click({
            $selectedIndex = [int]$localAddressField.Tag
            if ($localAddresses.Count -gt 0 -and $selectedIndex -ge 0) {
                $address = [string]$localAddresses[$selectedIndex].Address
                & $setClipboardCommand -Text $address
                $copyButton.Text = "已复制"
                $copyButton.TextColor = $colors.Success
            }
        }.GetNewClosure())
        $switchAddressButton.Add_Click({
            if ($localAddresses.Count -gt 1) {
                $nextIndex = (([int]$localAddressField.Tag) + 1) % $localAddresses.Count
                $localAddressField.Tag = $nextIndex
                $localAddressValue.Text = [string]$localAddresses[$nextIndex].Address
            }
            $copyButton.Text = "复制"
            $copyButton.TextColor = $colors.Cyan
        }.GetNewClosure())
        $managePeersButton.Add_Click({
            $updatedPeers = @(& $peerManagerCommand -Owner $form -Peers @($draftPeers) -DefaultPort $script:Port -DefaultAccessToken "")
            if ($updatedPeers.Count -gt 0) {
                $draftPeers.Clear()
                foreach ($updatedPeer in $updatedPeers) {
                    $null = $draftPeers.Add($updatedPeer)
                }
                & $updatePeerSummary
                & $runCheck
            }
        }.GetNewClosure())
        $testButton.Add_Click($runCheck)
        $showTokenButton.Add_Click({
            $tokenInput.TextBox.UseSystemPasswordChar = -not $tokenInput.TextBox.UseSystemPasswordChar
            $showTokenButton.Text = if ($tokenInput.TextBox.UseSystemPasswordChar) { "显示" } else { "隐藏" }
        }.GetNewClosure())
        $closeButton.Add_Click({ $form.Close() }.GetNewClosure())
        $cancelButton.Add_Click({ $form.Close() }.GetNewClosure())
        $saveButton.Add_Click({
            try {
                $parsedPort = 0
                if (-not [int]::TryParse($portInput.TextBox.Text.Trim(), [ref]$parsedPort)) {
                    throw "服务端口必须是整数。"
                }
                $enabledDraftPeers = @($draftPeers | Where-Object { [bool]$_.enabled })
                if ($enabledDraftPeers.Count -lt 1) {
                    throw "至少需要启用一台接收设备。"
                }
                $normalized = & $saveSettingsCommand `
                    -PeerAddress ([string]$enabledDraftPeers[0].address) `
                    -Notifications ([bool]$notifyToggle.Checked) `
                    -ListenPort $parsedPort `
                    -AccessToken $tokenInput.TextBox.Text `
                    -StartupEnabled ([bool]$startupToggle.Checked) `
                    -Peers @($draftPeers)
                if ($notifyToggle.Checked) {
                    & $notificationCommand -Title "ClipRelay 设置已保存" -Message "并行广播：$($enabledDraftPeers.Count) 台设备；本机端口：$parsedPort。"
                }
                $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
                $form.Close()
            }
            catch {
                $null = [System.Windows.Forms.MessageBox]::Show(
                    $form,
                    $_.Exception.Message,
                    "无法保存设置",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Warning
                )
            }
        }.GetNewClosure())

        $runtimeTimer = New-Object System.Windows.Forms.Timer
        $runtimeTimer.Interval = 750
        $runtimeTimer.Add_Tick({
            try {
                $snapshot = & $snapshotCommand
                if ($snapshot.ScreenshotHotkeyAvailable) {
                    $screenshotHotkeyState.Text = "可用"
                    $screenshotHotkeyState.ForeColor = $colors.Cyan
                }
                else {
                    $screenshotHotkeyState.Text = "冲突"
                    $screenshotHotkeyState.ForeColor = $colors.Danger
                }
                if ($snapshot.State -eq "success") {
                    $activityAccent.BackColor = $colors.Cyan
                    $activityTitle.ForeColor = $colors.Text
                }
                elseif ($snapshot.State -eq "partial") {
                    $activityAccent.BackColor = $colors.Violet
                    $activityTitle.ForeColor = $colors.Violet
                }
                elseif ($snapshot.State -eq "error") {
                    $activityAccent.BackColor = $colors.Danger
                    $activityTitle.ForeColor = $colors.Danger
                }
                else {
                    $activityAccent.BackColor = $colors.Muted
                    $activityTitle.ForeColor = $colors.Text
                }
                $activityTitle.Text = $snapshot.Detail
                $activityTime.Text = if ($null -eq $snapshot.At) { "—" } else { $snapshot.At.ToString("HH:mm:ss") }
            }
            catch {
            }
        }.GetNewClosure())

        $form.AcceptButton = $saveButton
        $form.CancelButton = $cancelButton
        $form.Add_Shown({
            $null = [ClipRelay.NativeMethods]::ShowWindow($form.Handle, [ClipRelay.NativeMethods]::SW_SHOW)
            $null = $form.Activate()
            $runtimeTimer.Start()
            & $runCheck
        }.GetNewClosure())
        $form.Add_FormClosed({
            param($sender, $eventArgs)
            try {
                $runtimeTimer.Stop()
                $runtimeTimer.Dispose()
                if ($null -ne $sender) {
                    $sender.Dispose()
                }
            }
            catch {
            }
            $script:configurationDialogOpen = $false
        }.GetNewClosure())
        $null = $form.Show()
    }
    catch {
        $script:configurationDialogOpen = $false
        if ($null -ne $form) {
            try { $form.Dispose() } catch { }
        }
        throw
    }
}

function Show-PeerConfiguration {
    Show-RelayControlCenter
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
            $summary = Test-RelayPeersConnectivity -Peers $script:Peers -TimeoutMilliseconds 5000
            $title = if ($summary.State -eq "success") { "ClipRelay: 全部设备可用" } elseif ($summary.State -eq "partial") { "ClipRelay: 部分设备可用" } else { "ClipRelay: 设备均不可达" }
            $icon = if ($summary.State -eq "success") { [System.Windows.Forms.ToolTipIcon]::Info } else { [System.Windows.Forms.ToolTipIcon]::Warning }
            Show-ClipRelayNotification -Title $title -Message $summary.Detail -Icon $icon
        }
        catch {
            Show-ClipRelayNotification -Title "ClipRelay: 无法连接" -Message "$($_.Exception.Message)" -Icon Warning
        }
    })

    $script:notifyMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("🔔 开启气泡通知")
    $script:notifyMenuItem.CheckOnClick = $true
    $script:notifyMenuItem.Checked = $script:Notifications
    $script:notifyMenuItem.Add_Click({
        $script:Notifications = [bool]$script:notifyMenuItem.Checked
        try {
            $cfg = [ordered]@{
                peer          = $script:Peer
                peers         = $script:Peers
                port          = $script:Port
                notifications = $script:Notifications
                accessToken   = $script:AccessToken
            }
            $cfg | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $script:configPath -Encoding UTF8
        }
        catch {
        }
    })

    $script:screenshotHotkeyMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("📷 截图热键: Ctrl+Alt+F12（正在检测）")
    $script:screenshotHotkeyMenuItem.Enabled = $false

    $activePeerCount = @(Get-EnabledRelayPeers -Peers $script:Peers).Count
    $peerMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("📡 发送设备: $activePeerCount 台")
    $peerMenuItem.Enabled = $false

    $exitMenuItem = New-Object System.Windows.Forms.ToolStripMenuItem("❌ 退出 ClipRelay")
    $exitMenuItem.Add_Click({ $script:stopRequested = $true })

    $null = $trayMenu.Items.Add($configureMenuItem)
    $null = $trayMenu.Items.Add($checkStatusMenuItem)
    $null = $trayMenu.Items.Add($script:notifyMenuItem)
    $null = $trayMenu.Items.Add($script:screenshotHotkeyMenuItem)
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

    if ([ClipRelay.CopyHotkeyMonitor]::ScreenshotHotkeyAvailable) {
        $script:screenshotHotkeyMenuItem.Text = "📷 截图热键: Ctrl+Alt+F12（可用）"
    }
    else {
        $script:screenshotHotkeyMenuItem.Text = "⚠️ 截图热键: Ctrl+Alt+F12（已被占用）"
    }

    $startupPeerCount = @(Get-EnabledRelayPeers -Peers $script:Peers).Count
    Write-Host "ClipRelay Windows 端已启动: 监听端口 $Port, 广播设备 $startupPeerCount 台"
    if (-not [ClipRelay.CopyHotkeyMonitor]::ScreenshotHotkeyAvailable) {
        Show-ClipRelayNotification -Title "ClipRelay 截图热键冲突" -Message "Ctrl+Alt+F12 已被其他程序注册，截图功能暂不可用；Ctrl+C 文本同步仍正常。关闭占用程序并重启 ClipRelay 后可重试。" -Icon Warning
    }
    elseif ($script:Notifications) {
        Show-ClipRelayNotification -Title "ClipRelay 已启动" -Message "Ctrl+C 广播文本；Ctrl+Alt+F12 广播所有显示器截图。已启用 $startupPeerCount 台设备，本机端口: $Port。"
    }

    if ($OpenSettings) {
        Show-PeerConfiguration
    }

    while (-not $stopRequested) {
        Process-WindowsMessages

        $copySequence = [uint32]0
        if ([ClipRelay.CopyHotkeyMonitor]::TryTakeCopy([ref]$copySequence)) {
            Send-CopiedClipboard -PreviousSequence $copySequence
        }

        if ([ClipRelay.CopyHotkeyMonitor]::TryTakeScreenshot()) {
            Send-VirtualDesktopScreenshot
        }

        if ($acceptTask.IsCompleted) {
            $client = $null
            try {
                $client = $acceptTask.GetAwaiter().GetResult()
                Handle-Client -Client $client
            }
            catch {
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

if ($restartRequested) {
    $processInfo = New-Object System.Diagnostics.ProcessStartInfo
    $processInfo.FileName = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $processInfo.Arguments = "-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    $processInfo.WorkingDirectory = $PSScriptRoot
    $processInfo.UseShellExecute = $false
    $processInfo.CreateNoWindow = $true
    $null = [System.Diagnostics.Process]::Start($processInfo)
}
