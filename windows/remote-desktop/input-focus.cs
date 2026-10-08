// Runs in the active interactive session, separately from the streaming engine.
// Only editability, an opaque focus identifier and an allowlisted app ID leave this process.
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace ClipRelay.Remote {
    public static class InputFocus {
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);

        public static bool IsEditable(AutomationElement element) {
            if (element == null || !element.Current.IsEnabled || !element.Current.HasKeyboardFocus) return false;
            object pattern;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                return !((ValuePattern)pattern).Current.IsReadOnly;
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) {
                object readOnly = ((TextPattern)pattern).DocumentRange.GetAttributeValue(TextPattern.IsReadOnlyAttribute);
                return readOnly is bool && !(bool)readOnly;
            }
            // Standard password edits deliberately expose no ValuePattern.
            return element.Current.ControlType == ControlType.Edit && element.Current.IsPassword;
        }

        public static bool IsInteractiveDesktop() {
            IntPtr desktop = OpenInputDesktop(0, false, 0x0100);
            if (desktop == IntPtr.Zero) return false;
            var name = new StringBuilder(256); int needed;
            bool isDefault = GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out needed)
                && String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
            CloseDesktop(desktop);
            return isDefault;
        }

        public static string ClassifyApp(string processName) {
            switch ((processName ?? "").ToLowerInvariant()) {
                case "stardew valley": case "stardewmoddingapi": return "stardew";
                case "plateup": return "plateup";
                case "orca": return "orca";
                case "chatgpt": return "chatgpt";
                default: return "general";
            }
        }

        public static object ReadApplication() {
            // This fast path does not call accessibility providers or read window titles.
            if (!IsInteractiveDesktop()) return new { supported = false, appId = "" };
            IntPtr before = GetForegroundWindow();
            try {
                uint pid;
                if (before == IntPtr.Zero || GetWindowThreadProcessId(before, out pid) == 0)
                    return new { supported = false, appId = "" };
                string app;
                using (var process = Process.GetProcessById((int)pid)) app = ClassifyApp(process.ProcessName);
                if (before != GetForegroundWindow()) return new { supported = false, appId = "" };
                return new { supported = true, appId = app };
            } catch { return new { supported = false, appId = "" }; }
        }

        static object State(bool supported, bool editable, string id, bool targeted) {
            if (targeted) return new { supported = supported, editable = editable, focusId = id, targeted = true };
            return new { supported = supported, editable = editable, focusId = id };
        }

        public static bool TryMapTap(double x, double y, int width, int height, out System.Windows.Point point) {
            point = new System.Windows.Point();
            if (Double.IsNaN(x) || Double.IsNaN(y) || x < 0 || x > 1 || y < 0 || y > 1 || width <= 0 || height <= 0)
                return false;
            point = new System.Windows.Point(Math.Min(width - 1, Math.Floor(x * width)),
                Math.Min(height - 1, Math.Floor(y * height)));
            return true;
        }

        public static bool IsFocusedTarget(AutomationElement focused, System.Windows.Point point) {
            if (!IsEditable(focused) || focused.Current.IsOffscreen || !focused.Current.BoundingRectangle.Contains(point))
                return false;
            // Geometry alone would accept a button/menu covering an editor. Check
            // the actual topmost UIA element and its ancestry, without reading text.
            var hit = AutomationElement.FromPoint(point);
            for (int depth = 0; hit != null && depth < 32; depth++) {
                if (Automation.Compare(focused, hit)) return true;
                if (hit.Current.IsKeyboardFocusable) return false;
                hit = TreeWalker.RawViewWalker.GetParent(hit);
            }
            return false;
        }

        public static object Read() { return ReadAt(null); }

        public static object Read(double x, double y) {
            // UIA uses physical pixels. ClipRelay's default Sunshine output is
            // the primary display; use the same display, not the virtual desktop.
            IntPtr previous = IntPtr.Zero;
            try {
                try { previous = SetThreadDpiAwarenessContext(new IntPtr(-4)); }
                catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
                System.Windows.Point point;
                if (!TryMapTap(x, y, GetSystemMetrics(0), GetSystemMetrics(1), out point))
                    return State(false, false, "", true);
                return ReadAt(point);
            } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
        }

        static object ReadAt(System.Windows.Point? point) {
            bool targeted = point.HasValue;
            if (!IsInteractiveDesktop()) return State(true, false, "", targeted);
            IntPtr before = GetForegroundWindow();
            try {
                var element = AutomationElement.FocusedElement;
                bool editable = targeted ? IsFocusedTarget(element, point.Value) : IsEditable(element);
                if (before == IntPtr.Zero || before != GetForegroundWindow())
                    return State(false, false, "", targeted);
                string id = "";
                if (editable) {
                    var runtime = element.GetRuntimeId();
                    var identity = new StringBuilder(before.ToInt64().ToString());
                    foreach (int part in runtime) identity.Append(':').Append(part);
                    using (var sha = SHA256.Create())
                        id = Convert.ToBase64String(sha.ComputeHash(Encoding.UTF8.GetBytes(identity.ToString())));
                }
                return State(true, editable, id, targeted);
            } catch {
                // Provider failures are unknown, never a request to open/close an IME.
                return State(false, false, "", targeted);
            }
        }

        public static int Run() {
            var json = new JavaScriptSerializer();
            string line;
            while ((line = Console.ReadLine()) != null) {
                if (line.StartsWith("image:", StringComparison.Ordinal)) {
                    Console.WriteLine(json.Serialize(new { ok = PutImage(line.Substring(6)) }));
                } else if (line.StartsWith("focus:", StringComparison.Ordinal)) {
                    string[] parts = line.Split(':');
                    double x, y;
                    if (parts.Length != 3 || !Double.TryParse(parts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out x)
                        || !Double.TryParse(parts[2], NumberStyles.Float, CultureInfo.InvariantCulture, out y)) return 2;
                    Console.WriteLine(json.Serialize(Read(x, y)));
                } else {
                    if (line != "focus" && line != "app") return 2;
                    Console.WriteLine(json.Serialize(line == "app" ? ReadApplication() : Read()));
                }
                Console.Out.Flush();
            }
            return 0;
        }

        public static bool PutImage(string encoded) {
            if (!IsInteractiveDesktop() || encoded.Length > 11184812) return false;
            bool ok = false;
            var worker = new Thread(() => {
                try {
                    byte[] bytes = Convert.FromBase64String(encoded);
                    if (bytes.Length > 8 * 1024 * 1024) return;
                    using (var source = new MemoryStream(bytes, false))
                    using (var image = System.Drawing.Image.FromStream(source, true, true)) {
                        if (image.RawFormat.Guid != System.Drawing.Imaging.ImageFormat.Png.Guid ||
                            image.Width > 4096 || image.Height > 4096 || (long)image.Width * image.Height > 6000000) return;
                        using (var bitmap = new System.Drawing.Bitmap(image))
                        using (var png = new MemoryStream(bytes, false)) {
                            var data = new System.Windows.Forms.DataObject();
                            data.SetImage(bitmap);
                            data.SetData("PNG", false, png);
                            if (!IsInteractiveDesktop()) return;
                            System.Windows.Forms.Clipboard.SetDataObject(data, true, 5, 80);
                            ok = true;
                        }
                    }
                } catch { /* Busy clipboard, bad image, or locked desktop: no false success. */ }
            });
            worker.SetApartmentState(ApartmentState.STA);
            worker.IsBackground = true;
            worker.Start();
            // The supervising process bounds this operation and owns the worker lifetime.
            worker.Join();
            return ok;
        }
    }
}
