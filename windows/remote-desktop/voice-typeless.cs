// Typeless uses its configured Dictate shortcut and its own accessible voice controls.
// Never change its files, inject into Electron, use account tokens, or change the system default mic.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace ClipRelay.Remote {
    public enum TypelessVoiceState { Unavailable, Idle, Recording, Busy }
    public interface ITypelessVoiceAccess : IDisposable {
        uint Prepare();
        void SelectMicrophone();
        void VerifyRecordingInput();
        TypelessVoiceState State { get; }
        void Begin();
        void Finish(bool commit);
    }

    public sealed class TypelessVoice : IDesktopVoice {
        readonly ITypelessVoiceAccess access;
        readonly Action wait;
        bool owned, confirmed, microphoneSelected;
        public uint OutputDevice { get; private set; }
        // The nonactivating voice bar does not need an exception to the target-focus guard.
        public uint ProcessId { get { return 0; } }
        public bool IsRecording {
            get {
                if (!owned || access.State != TypelessVoiceState.Recording) return false;
                try { access.VerifyRecordingInput(); return true; }
                catch { return false; }
            }
        }
        public TypelessVoice() : this(new TypelessWindowsAccess(), () => Thread.Sleep(50)) { }
        public TypelessVoice(ITypelessVoiceAccess access, Action wait) { this.access = access; this.wait = wait; }
        public void CheckAvailable() {
            OutputDevice = access.Prepare();
            var state = access.State;
            if (state == TypelessVoiceState.Unavailable) throw new InvalidOperationException("TYPELESS_VERSION_UNSUPPORTED");
            if (state != TypelessVoiceState.Idle) throw new InvalidOperationException("VOICE_BUSY");
        }
        public void SelectMicrophone() {
            CheckAvailable();
            access.SelectMicrophone();
            microphoneSelected = true;
        }
        public void Start(Func<bool> sameTarget) {
            uint selected = OutputDevice;
            CheckAvailable();
            if (microphoneSelected && OutputDevice != selected) throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED");
            if (!sameTarget()) throw new InvalidOperationException("VOICE_FOCUS_REQUIRED");
            owned = true; confirmed = false; // A partially completed start also needs cancellation.
            try {
                access.Begin();
                for (int i = 0; i < 60; i++) {
                    if (!sameTarget()) throw new InvalidOperationException("VOICE_FOCUS_REQUIRED");
                    if (access.State == TypelessVoiceState.Recording) { access.VerifyRecordingInput(); confirmed = true; return; }
                    wait();
                }
                throw new InvalidOperationException("VOICE_INPUT_FAILED");
            } catch { End(false); throw; }
        }
        public void End(bool commit) {
            if (!owned) return;
            owned = false; // Never replay an invocation whose result is unknown.
            try {
                // Startup is asynchronous. On focus loss or timeout, give a pending
                // start a bounded chance to expose its cancel control before releasing it.
                if (!commit && !confirmed)
                    for (int i = 0; i < 40 && access.State != TypelessVoiceState.Recording; i++) wait();
                if (access.State != TypelessVoiceState.Recording) {
                    if (commit) throw new InvalidOperationException("VOICE_ENDED");
                    return;
                }
                access.Finish(commit);
                for (int i = 0; i < 50 && access.State == TypelessVoiceState.Recording; i++) wait();
                if (access.State == TypelessVoiceState.Recording && commit)
                    throw new InvalidOperationException("VOICE_INPUT_FAILED");
            } catch { if (commit) throw; }
        }
        public void Dispose() { End(false); access.Dispose(); }

        // Only modifier-only shortcuts are supported. Unknown settings fail closed,
        // rather than sending text, opening the Start menu, or guessing a default.
        public static int[] ParseShortcut(string value) {
            if (String.IsNullOrEmpty(value)) throw new InvalidOperationException("TYPELESS_SHORTCUT_REQUIRED");
            var result = new List<int>();
            foreach (string key in value.Split('+')) {
                int code;
                switch (key) {
                    case "LeftCtrl": code = 0xA2; break;
                    case "RightCtrl": code = 0xA3; break;
                    case "LeftAlt": code = 0xA4; break;
                    case "RightAlt": code = 0xA5; break;
                    case "LeftShift": code = 0xA0; break;
                    case "RightShift": code = 0xA1; break;
                    default: throw new InvalidOperationException("TYPELESS_SHORTCUT_REQUIRED");
                }
                if (result.Contains(code) || result.Count == 4) throw new InvalidOperationException("TYPELESS_SHORTCUT_REQUIRED");
                result.Add(code);
            }
            return result.ToArray();
        }
        public static string VirtualOutput(string id, string label) {
            if (String.IsNullOrEmpty(id) || id == "default" || id == "communications" || label == null)
                throw new InvalidOperationException("TYPELESS_MIC_REQUIRED");
            if (label.IndexOf("Steam Streaming Microphone", StringComparison.OrdinalIgnoreCase) >= 0) return "Steam Streaming Micro";
            if (label.IndexOf("CABLE Output", StringComparison.OrdinalIgnoreCase) >= 0 &&
                label.IndexOf("VB-Audio", StringComparison.OrdinalIgnoreCase) >= 0) return "CABLE Input";
            throw new InvalidOperationException("TYPELESS_MIC_REQUIRED");
        }
        public static int[] ReadSettings(string text, out string output) {
            var json = new JavaScriptSerializer { MaxJsonLength = 262144, RecursionLimit = 16 };
            Dictionary<string, object> values;
            try { values = json.Deserialize<Dictionary<string, object>>(text); }
            catch { throw new InvalidOperationException("TYPELESS_VERSION_UNSUPPORTED"); }
            object selected, bindings;
            if (values == null || !values.TryGetValue("selectedMicrophoneDevice", out selected) ||
                !values.TryGetValue("featureShortcutBindings", out bindings)) throw new InvalidOperationException("TYPELESS_VERSION_UNSUPPORTED");
            var device = selected as Dictionary<string, object>;
            object id, label;
            if (device == null || !device.TryGetValue("deviceId", out id) || !device.TryGetValue("label", out label))
                throw new InvalidOperationException("TYPELESS_MIC_REQUIRED");
            // Default follows the per-application Windows preference, which we can
            // lease without changing either Typeless or the system default input.
            output = (id as string) == "default" || (id as string) == "communications"
                ? null : VirtualOutput(id as string, label as string);
            var features = bindings as Dictionary<string, object>;
            object shortcuts;
            if (features != null && features.TryGetValue("dictationMode", out shortcuts)) {
                var list = shortcuts as IList;
                if (list != null) foreach (object entry in list) {
                    string shortcut = entry as string;
                    if (shortcut == null) continue;
                    int[] keys;
                    try { keys = ParseShortcut(shortcut); }
                    catch (InvalidOperationException) { continue; }
                    bool shared = false;
                    foreach (var feature in features) {
                        if (feature.Key == "dictationMode") continue;
                        var others = feature.Value as IList;
                        if (others != null) foreach (object other in others) {
                            try {
                                int[] otherKeys = ParseShortcut(other as string);
                                if (otherKeys.Length == keys.Length && Array.TrueForAll(otherKeys, key => Array.IndexOf(keys, key) >= 0)) shared = true;
                            } catch (InvalidOperationException) { }
                        }
                    }
                    if (shared) continue;
                    return keys;
                }
            }
            throw new InvalidOperationException("TYPELESS_SHORTCUT_REQUIRED");
        }
    }

    sealed class TypelessWindowsAccess : ITypelessVoiceAccess {
        readonly int pid;
        readonly string settings;
        int[] shortcut;
        string endpoint;
        bool automaticMicrophone;
        bool finishRequested;
        readonly bool knownBarLayout;
        WindowsAppMicrophone audioPolicy;
        int audioPid;
        TypelessAudioRoute audioRoute;
        IntPtr bar;
        AutomationElement cancel, done;
        delegate bool WindowCallback(IntPtr window, IntPtr unused);
        [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr unused);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint MapVirtualKey(uint key, uint mode);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
        [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
        [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr window, ref Point point);
        [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr window, Point point, uint flags);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", SetLastError = true)] static extern bool PostMessage(IntPtr window, uint message, UIntPtr wp, IntPtr lp);
        [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputData data; }
        [StructLayout(LayoutKind.Explicit, Size = 32)] struct InputData { [FieldOffset(0)] public Keyboard key; }
        [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort key, scan; public uint flags, time; public UIntPtr extra; }

        public TypelessWindowsAccess() {
            string user = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string[] trusted = { Path.Combine(user, "Programs", "Typeless", "Typeless.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Typeless", "Typeless.exe") };
            var candidates = new HashSet<int>();
            foreach (var process in Process.GetProcessesByName("Typeless")) using (process) {
                try {
                    if (process.SessionId != Process.GetCurrentProcess().SessionId) continue;
                    string path = Path.GetFullPath(process.MainModule.FileName);
                    foreach (string expected in trusted) if (String.Equals(path, expected, StringComparison.OrdinalIgnoreCase)) candidates.Add(process.Id);
                } catch { }
            }
            int owner = 0;
            EnumWindows(delegate(IntPtr window, IntPtr unused) {
                uint process; GetWindowThreadProcessId(window, out process);
                if (!candidates.Contains((int)process)) return true;
                var title = new StringBuilder(128); GetWindowText(window, title, title.Capacity);
                // Installed Typeless 2.x creates this window without activating it.
                if (title.ToString() == "Status") { bar = window; owner = (int)process; return false; }
                return true;
            }, IntPtr.Zero);
            if (owner == 0) throw new InvalidOperationException("TYPELESS_REQUIRED");
            pid = owner;
            using (var process = Process.GetProcessById(pid))
                knownBarLayout = FileVersionInfo.GetVersionInfo(process.MainModule.FileName).FileVersion == "2.10.0.137";
            foreach (string name in new[] { "Typeless.exe", "Typeless" }) {
                string path = Path.Combine(VoiceInput.UserAppData(), name, "app-settings.json");
                if (File.Exists(path)) { settings = path; break; }
            }
            if (settings == null) throw new InvalidOperationException("TYPELESS_REQUIRED");
        }
        public uint Prepare() {
            if (!knownBarLayout) throw new InvalidOperationException("TYPELESS_VERSION_UNSUPPORTED");
            if (!File.Exists(settings) || new FileInfo(settings).Length > 262144)
                throw new InvalidOperationException("TYPELESS_VERSION_UNSUPPORTED");
            string output;
            shortcut = TypelessVoice.ReadSettings(File.ReadAllText(settings, Encoding.UTF8), out output);
            automaticMicrophone = output == null;
            if (audioRoute == null && TypelessAudioRoute.RecoveryPending) {
                if (State != TypelessVoiceState.Idle) throw new InvalidOperationException("VOICE_BUSY");
                EnsureAudioPolicy();
                using (var recovery = new TypelessAudioRoute(audioPolicy.Read, audioPolicy.Write, TypelessAudioRoute.JournalPath)) { }
            }
            if (!automaticMicrophone) {
                EnsureAudioPolicy();
                endpoint = WindowsAppMicrophone.CaptureEndpoint(output);
                return PcmPlayback.Find(output);
            }
            EnsureAudioPolicy();
            for (int role = 0; role < 3; role++) audioPolicy.Read(role);
            foreach (string candidate in new[] { "Steam Streaming Micro", "CABLE Input" }) {
                try {
                    string capture = WindowsAppMicrophone.CaptureEndpoint(candidate);
                    uint playback = PcmPlayback.Find(candidate);
                    if (audioRoute != null && endpoint != capture) throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED");
                    endpoint = capture;
                    return playback;
                } catch (InvalidOperationException error) {
                    if (error.Message != "VIRTUAL_MIC_REQUIRED") throw;
                }
            }
            throw new InvalidOperationException("VIRTUAL_MIC_REQUIRED");
        }
        void EnsureAudioPolicy() {
            // Chromium performs WASAPI capture in its audio utility process, not
            // the window owner. Windows rejects routing the unregistered main PID.
            int found = 0;
            using (var search = new ManagementObjectSearcher("SELECT ProcessId,ParentProcessId,CommandLine FROM Win32_Process WHERE Name='Typeless.exe'"))
            using (var processes = search.Get()) foreach (ManagementObject row in processes) using (row) {
                if (Convert.ToInt32(row["ParentProcessId"]) != pid) continue;
                string command = Convert.ToString(row["CommandLine"]);
                if (command.IndexOf("--utility-sub-type=audio.mojom.AudioService", StringComparison.Ordinal) < 0) continue;
                int candidate = Convert.ToInt32(row["ProcessId"]);
                using (var child = Process.GetProcessById(candidate)) using (var owner = Process.GetProcessById(pid)) {
                    if (child.SessionId != owner.SessionId || !String.Equals(child.MainModule.FileName, owner.MainModule.FileName, StringComparison.OrdinalIgnoreCase)) continue;
                }
                if (found != 0) throw new InvalidOperationException("TYPELESS_ROUTING_UNSUPPORTED");
                found = candidate;
            }
            if (found == 0) throw new InvalidOperationException("TYPELESS_ROUTING_UNSUPPORTED");
            if (audioPolicy != null && audioPid != found) {
                if (audioRoute != null) throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED");
                audioPolicy.Dispose(); audioPolicy = null;
            }
            if (audioPolicy == null) { audioPolicy = new WindowsAppMicrophone((uint)found); audioPid = found; }
        }
        public void SelectMicrophone() {
            if (State != TypelessVoiceState.Idle) throw new InvalidOperationException("VOICE_BUSY");
            if (!automaticMicrophone) return;
            if (audioRoute != null) throw new InvalidOperationException("VOICE_BUSY");
            EnsureAudioPolicy();
            audioRoute = new TypelessAudioRoute(audioPolicy.Read, audioPolicy.Write, TypelessAudioRoute.JournalPath);
            audioRoute.Select(endpoint);
        }
        public void VerifyRecordingInput() {
            if (audioPolicy == null || audioPolicy.ActiveCaptureEndpoint() != endpoint)
                throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED");
        }
        static AutomationElement ById(AutomationElement root, string id) {
            return root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, id));
        }
        static bool Visible(AutomationElement item) {
            if (item == null) return false;
            var current = item.Current;
            return !current.IsOffscreen && current.BoundingRectangle.Width > 1 && current.BoundingRectangle.Height > 1;
        }
        static AutomationElement Button(AutomationElement root, string id) {
            var container = ById(root, id);
            if (container == null || !Visible(container)) return null;
            var button = container.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button));
            object pattern;
            return button != null && Visible(button) && button.Current.IsEnabled && button.TryGetCurrentPattern(InvokePattern.Pattern, out pattern) ? button : null;
        }
        public TypelessVoiceState State {
            get {
                cancel = done = null;
                try {
                    uint owner; GetWindowThreadProcessId(bar, out owner);
                    if (owner != pid) return TypelessVoiceState.Unavailable;
                    var window = AutomationElement.FromHandle(bar);
                    // Chromium prunes the decorative floating-bar div from UIA
                    // while idle. Require the actual document and React root.
                    var document = ById(window, "RootWebArea");
                    var root = document == null ? null : ById(document, "root");
                    if (root == null || !IsWindowVisible(bar)) return TypelessVoiceState.Unavailable;
                    cancel = Button(root, "close"); done = Button(root, "done");
                    // Chromium also prunes the close/done spans. The verified voice
                    // bar exposes two unnamed, equal-size Invoke buttons on one row.
                    if ((cancel == null || done == null) && knownBarLayout) {
                        var buttons = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button));
                        if (buttons.Count == 2) {
                            var first = buttons[0]; var second = buttons[1]; object firstPattern, secondPattern;
                            var a = first.Current; var b = second.Current;
                            if (Visible(first) && Visible(second) && a.IsEnabled && b.IsEnabled &&
                                String.IsNullOrEmpty(a.Name) && String.IsNullOrEmpty(b.Name) &&
                                a.BoundingRectangle.Width >= 15 && a.BoundingRectangle.Width <= 64 &&
                                Math.Abs(a.BoundingRectangle.Width - b.BoundingRectangle.Width) <= 2 &&
                                Math.Abs(a.BoundingRectangle.Height - b.BoundingRectangle.Height) <= 2 &&
                                Math.Abs(a.BoundingRectangle.Top - b.BoundingRectangle.Top) <= 3 &&
                                a.BoundingRectangle.Right < b.BoundingRectangle.Left &&
                                first.TryGetCurrentPattern(InvokePattern.Pattern, out firstPattern) && second.TryGetCurrentPattern(InvokePattern.Pattern, out secondPattern)) {
                                cancel = first; done = second;
                            }
                        }
                    }
                    string capture = audioPolicy == null ? null : audioPolicy.ActiveCaptureEndpoint();
                    if (cancel != null && done != null)
                        return capture != null ? TypelessVoiceState.Recording : TypelessVoiceState.Busy;
                    var loading = ById(root, "loading");
                    var closeContainer = ById(root, "close");
                    var doneContainer = ById(root, "done");
                    if (Visible(loading) || Visible(closeContainer) || Visible(doneContainer)) return TypelessVoiceState.Busy;
                    // The verified idle UI is a small, empty pill. A missing subtree,
                    // full-sized bar, unreadable text or an unknown control is not idle.
                    var bounds = root.Current.BoundingRectangle;
                    object textPattern;
                    if (capture == null && bounds.Width > 1 && bounds.Width <= 64 && bounds.Height > 1 && bounds.Height <= 96 &&
                        document.TryGetCurrentPattern(TextPattern.Pattern, out textPattern) &&
                        String.IsNullOrWhiteSpace(((TextPattern)textPattern).DocumentRange.GetText(1024).Replace("\uFFFC", "")) &&
                        root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)) == null)
                        return TypelessVoiceState.Idle;
                    return TypelessVoiceState.Unavailable;
                } catch { return TypelessVoiceState.Unavailable; }
            }
        }
        static Input Key(int code, bool up) {
            uint scan = MapVirtualKey((uint)code, 4);
            if (scan == 0) throw new InvalidOperationException("TYPELESS_SHORTCUT_REQUIRED");
            return new Input { type = 1, data = new InputData { key = new Keyboard { scan = (ushort)(scan & 255),
                flags = (uint)(8 | (up ? 2 : 0) | ((scan & 0xFF00) == 0xE000 ? 1 : 0)) } } };
        }
        public void Begin() {
            finishRequested = false;
            // Respect physical keys; never release a modifier the user is holding.
            for (int code = 0xA0; code <= 0xA5; code++)
                if ((GetAsyncKeyState(code) & 0x8000) != 0) throw new InvalidOperationException("VOICE_BUSY");
            var inputs = new List<Input>();
            foreach (int code in shortcut) inputs.Add(Key(code, false));
            uint sent = SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(Input)));
            try {
                if (sent != inputs.Count) throw new InvalidOperationException("VOICE_INPUT_FAILED");
                // Typeless observes keyboard state in a child process. A down/up batch
                // can disappear between polls; keep the press shorter than hold-to-talk.
                Thread.Sleep(80);
            } finally {
                // Release only keys whose down event was actually inserted. Do not replay the shortcut.
                var release = new List<Input>();
                for (int i = Math.Min((int)sent, shortcut.Length) - 1; i >= 0; i--) release.Add(Key(shortcut[i], true));
                if (release.Count > 0 && SendInput((uint)release.Count, release.ToArray(), Marshal.SizeOf(typeof(Input))) != release.Count)
                    throw new InvalidOperationException("VOICE_INPUT_FAILED");
            }
        }
        public void Finish(bool commit) {
            // Chromium's UIA Invoke does not finish this bar reliably. Deliver one
            // mouse gesture to its observed button, without moving the real pointer
            // or activating a window. Never retry a partially delivered gesture.
            if (State != TypelessVoiceState.Recording) throw new InvalidOperationException("VOICE_ENDED");
            var button = commit ? done : cancel;
            var bounds = button.Current.BoundingRectangle;
            IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
            try {
                var screen = new Point { x = (int)(bounds.Left + bounds.Width / 2), y = (int)(bounds.Top + bounds.Height / 2) };
                var point = screen;
                if (!ScreenToClient(bar, ref point)) throw new InvalidOperationException("VOICE_INPUT_FAILED");
                IntPtr recipient = ChildWindowFromPointEx(bar, point, 3);
                if (recipient == IntPtr.Zero) recipient = bar;
                uint owner; GetWindowThreadProcessId(recipient, out owner);
                if (owner != pid) throw new InvalidOperationException("VOICE_INPUT_FAILED");
                point = screen;
                if (!ScreenToClient(recipient, ref point) || point.x < 0 || point.y < 0 || point.x > 32767 || point.y > 32767)
                    throw new InvalidOperationException("VOICE_INPUT_FAILED");
                var location = new IntPtr(point.x | (point.y << 16));
                if (!PostMessage(recipient, 0x0200, UIntPtr.Zero, location) ||
                    !PostMessage(recipient, 0x0201, new UIntPtr(1), location) ||
                    !PostMessage(recipient, 0x0202, UIntPtr.Zero, location)) throw new InvalidOperationException("VOICE_INPUT_FAILED");
                finishRequested = true;
                PostMessage(recipient, 0x02A3, UIntPtr.Zero, IntPtr.Zero);
            } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
        }
        public void Dispose() {
            cancel = done = null;
            try {
                if (audioRoute != null) {
                    // A completed transcript/cancel toast can keep the bar expanded.
                    // Once our finish request has closed capture, restoring the app
                    // input is safe even while that result is still visible.
                    bool canRestore = State == TypelessVoiceState.Idle;
                    try {
                        if (!canRestore && finishRequested && audioPolicy != null) {
                            for (int i = 0; i < 50 && audioPolicy.ActiveCaptureEndpoint() != null; i++) Thread.Sleep(50);
                            canRestore = audioPolicy.ActiveCaptureEndpoint() == null;
                        }
                    } catch { canRestore = false; }
                    if (canRestore) audioRoute.Dispose();
                    else audioRoute.LeaveForRecovery();
                    audioRoute = null;
                }
            }
            finally { if (audioPolicy != null) { audioPolicy.Dispose(); audioPolicy = null; } }
        }
    }
}
