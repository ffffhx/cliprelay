// Phone PCM -> a virtual microphone -> the installed desktop Doubao Input Method.
// No audio files, default-speaker playback, simulated shortcuts, or cloud credentials.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using Microsoft.Win32;

namespace ClipRelay.Remote {
    public static class VoiceInput {
        static readonly object Gate = new object();
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        static readonly Timer Watchdog = new Timer(Check, null, 300, 300);
        static PcmPlayback playback;
        static DoubaoVoice doubao;
        static long started, lastAudio, lastRecovery;
        static IntPtr target;
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        static long Now { get { return Stopwatch.GetTimestamp() / (Stopwatch.Frequency / 1000); } }
        static object Reply(bool ok, string code) { return new { ok = ok, code = code }; }
        public static int Run(bool recoverOnly = false) {
            // Doubao's pipe verifies the caller's Windows account. The metadata server
            // is SYSTEM; its voice worker must instead use the signed-in shell token.
            using (var identity = WindowsIdentity.GetCurrent())
                if (identity.IsSystem) return RunAsDesktopUser(recoverOnly);
            if (recoverOnly) { RecoverMicrophone(); return 0; }
            RecoverMicrophone();
            try {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    if (line.Length > 21400 || !line.StartsWith("voice-", StringComparison.Ordinal)) return 2;
                    Console.WriteLine(Json.Serialize(Handle(line)));
                    Console.Out.Flush();
                }
                return 0;
            } finally { Close(); }
        }
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
            public int cb; public string reserved, desktop, title;
            public int x, y, width, height, xc, yc, fill, flags;
            public short show, reserved2; public IntPtr reservedPtr, stdin, stdout, stderr;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
        [DllImport("userenv.dll", SetLastError=true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
        [DllImport("userenv.dll")] static extern bool DestroyEnvironmentBlock(IntPtr env);
        [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
        [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
        static int RunAsDesktopUser(bool recoverOnly) {
            IntPtr original = IntPtr.Zero, token = IntPtr.Zero, environment = IntPtr.Zero;
            var processInfo = new ProcessInfo();
            try {
                uint pid; GetWindowThreadProcessId(GetShellWindow(), out pid);
                if (pid == 0) return 2;
                using (var shell = Process.GetProcessById((int)pid))
                    if (!OpenProcessToken(shell.Handle, 0x000A, out original)) return 2;
                if (!DuplicateTokenEx(original, 0xF01FF, IntPtr.Zero, 2, 1, out token) ||
                    !CreateEnvironmentBlock(out environment, token, false)) return 2;
                var startup = new Startup { cb = Marshal.SizeOf(typeof(Startup)), desktop = @"winsta0\default",
                    flags = 0x100, stdin = GetStdHandle(-10), stdout = GetStdHandle(-11), stderr = GetStdHandle(-12) };
                if (recoverOnly) startup.flags = 0;
                else {
                    if (!SetHandleInformation(startup.stdin, 1, 1) || !SetHandleInformation(startup.stdout, 1, 1)) return 2;
                    if (!SetHandleInformation(startup.stderr, 1, 1)) startup.stderr = startup.stdout;
                }
                string executable = typeof(VoiceInput).Assembly.Location;
                if (!CreateProcessAsUser(token, executable, new StringBuilder("\"" + executable + (recoverOnly ? "\" --voice-recover" : "\" --voice-probe")),
                    IntPtr.Zero, IntPtr.Zero, !recoverOnly, 0x08000400, environment, Path.GetDirectoryName(executable), ref startup, out processInfo)) return 2;
                // Inherits the service's job; EOF lets the user worker clean up first.
                WaitForSingleObject(processInfo.process, UInt32.MaxValue);
                uint code; return GetExitCodeProcess(processInfo.process, out code) ? (int)code : 2;
            } finally {
                if (processInfo.thread != IntPtr.Zero) CloseHandle(processInfo.thread);
                if (processInfo.process != IntPtr.Zero) CloseHandle(processInfo.process);
                if (environment != IntPtr.Zero) DestroyEnvironmentBlock(environment);
                if (token != IntPtr.Zero) CloseHandle(token);
                if (original != IntPtr.Zero) CloseHandle(original);
            }
        }
        public static string UserAppData() {
            using(var identity=WindowsIdentity.GetCurrent()) if(!identity.IsSystem)
                return Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            // The service probe runs as SYSTEM in the console session. Its APPDATA is
            // systemprofile, not the signed-in person's profile; resolve the shell owner.
            uint pid; GetWindowThreadProcessId(GetShellWindow(),out pid);
            if(pid==0) throw new InvalidOperationException("DOUBAO_REQUIRED");
            IntPtr token=IntPtr.Zero;
            try {
                using(var process=Process.GetProcessById((int)pid))
                    if(!OpenProcessToken(process.Handle,8,out token)) throw new InvalidOperationException("DOUBAO_REQUIRED");
                using(var identity=new WindowsIdentity(token)) {
                    string sid=identity.User.Value;
                    using(var profile=Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\"+sid)) {
                        string home=profile==null?"":Convert.ToString(profile.GetValue("ProfileImagePath",""));
                        if(home.Length==0) throw new InvalidOperationException("DOUBAO_REQUIRED");
                        using(var folders=Registry.Users.OpenSubKey(sid+@"\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders")) {
                            string path=folders==null?"":Convert.ToString(folders.GetValue("AppData","",RegistryValueOptions.DoNotExpandEnvironmentNames));
                            return path.Length==0?Path.Combine(home,"AppData","Roaming"):
                                Environment.ExpandEnvironmentVariables(path.Replace("%USERPROFILE%",home));
                        }
                    }
                }
            } finally { if(token!=IntPtr.Zero)CloseHandle(token); }
        }

        static bool SameTarget() {
            if (!InputFocus.IsInteractiveDesktop()) return false;
            IntPtr current = GetForegroundWindow();
            if (current == target) return true;
            uint pid; GetWindowThreadProcessId(current, out pid);
            return doubao != null && pid == doubao.ProcessId;
        }
        static bool IsPasswordFocus() {
            // UIA is advisory for an explicit IME command: custom editors may not
            // expose ValuePattern/TextPattern even though normal typing works.
            // Do not make those providers a prerequisite for starting Doubao.
            try {
                var focus = AutomationElement.FocusedElement;
                return focus != null && focus.Current.IsPassword;
            } catch { return false; }
        }
        static void Check(object unused) {
            lock (Gate) {
                if (playback != null && (Now - lastAudio > 6000 || Now - started > 180000 ||
                    !SameTarget() || !doubao.IsRecording)) End(false);
                if (playback == null && Now - lastRecovery > 5000) {
                    lastRecovery = Now;
                    RecoverMicrophone();
                }
            }
        }
        public static void RecoverMicrophone() {
            try {
                using (var identity = WindowsIdentity.GetCurrent()) if (identity.IsSystem) return;
                if (File.Exists(MicrophoneLease.JournalPath))
                    using (var provider = new DoubaoVoice()) provider.CheckAvailable();
            } catch { /* The journal remains for retry once Doubao is available and idle. */ }
        }
        static void End(bool commit) {
            try {
                if (playback != null && commit && SameTarget()) playback.Drain();
                else commit = false;
                if (doubao != null) doubao.End(commit && SameTarget());
            } finally {
                if (playback != null) { playback.Dispose(); playback = null; }
                if (doubao != null) { doubao.Dispose(); doubao = null; }
            }
        }
        public static void Close() { lock (Gate) { End(false); } }
        public static object Handle(string command) {
            lock (Gate) {
                try {
                    if (command == "voice-stop" || command == "voice-cancel") {
                        bool active = playback != null;
                        End(command == "voice-stop");
                        return Reply(active, active ? "" : "VOICE_ENDED");
                    }
                    if (command == "voice-status" || command == "voice-start") {
                        if (playback != null) return Reply(false, "VOICE_BUSY");
                        if (command == "voice-status") {
                            using (var provider = new DoubaoVoice()) provider.CheckAvailable();
                            return Reply(true, "");
                        }
                        if (!InputFocus.IsInteractiveDesktop()) return Reply(false, "VOICE_FOCUS_REQUIRED");
                        target = GetForegroundWindow();
                        // This request comes only from the user's voice button.
                        // Doubao owns insertion at the current caret, just like its
                        // native hotkey. UIA editability is used for auto-keyboard
                        // hints, not as an authority on whether an IME can type.
                        if (target == IntPtr.Zero || target == GetShellWindow() || IsPasswordFocus())
                            return Reply(false, "VOICE_FOCUS_REQUIRED");
                        doubao = new DoubaoVoice();
                        doubao.CheckAvailable();
                        doubao.SelectMicrophone();
                        playback = new PcmPlayback(doubao.OutputDevice);
                        if (!SameTarget()) throw new InvalidOperationException("VOICE_FOCUS_REQUIRED");
                        doubao.Start(SameTarget);
                        started = lastAudio = Now;
                        return Reply(true, "");
                    }
                    if (command.StartsWith("voice-audio:", StringComparison.Ordinal)) {
                        if (playback == null || !SameTarget() || !doubao.IsRecording) {
                            End(false); return Reply(false, "VOICE_ENDED");
                        }
                        string encoded = command.Substring(12);
                        if (encoded.Length > 21336) throw new InvalidOperationException("VOICE_INVALID_AUDIO");
                        byte[] data = Convert.FromBase64String(encoded);
                        if (data.Length == 0 || data.Length > 16000 || data.Length % 2 != 0)
                            throw new InvalidOperationException("VOICE_INVALID_AUDIO");
                        playback.Write(data); lastAudio = Now;
                        return Reply(true, "");
                    }
                    return Reply(false, "VOICE_INVALID_REQUEST");
                } catch (InvalidOperationException error) {
                    End(false);
                    return Reply(false, error.Message.StartsWith("VOICE_", StringComparison.Ordinal) ||
                        error.Message == "DOUBAO_REQUIRED" || error.Message == "DOUBAO_VERSION_UNSUPPORTED" ||
                        error.Message == "VIRTUAL_MIC_REQUIRED" ? error.Message : "VOICE_UNAVAILABLE");
                } catch { End(false); return Reply(false, "VOICE_UNAVAILABLE"); }
            }
        }
    }

    // Doubao 0.9.1.22 deliberately ignores injected keyboard shortcuts. Its installed
    // local RPC library exposes the same start/show/stop/cancel commands used by its UI.
    // This is NOT a public SDK: fail closed on other versions, never guess command IDs.
    // Load only the installed Program Files binaries; none are bundled with ClipRelay.
    public sealed class DoubaoVoice : IDisposable {
        const string Pipe = @"\\.\pipe\ObricIme\oime-server";
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly string directory, config;
        readonly int pid;
        IntPtr library;
        RpcMessage rpc;
        object settings;
        MethodInfo patch;
        string microphone;
        MicrophoneLease microphoneLease;
        bool recording;
        public uint OutputDevice { get; private set; }
        public uint ProcessId { get { return (uint)pid; } }
        [UnmanagedFunctionPointer(CallingConvention.Cdecl, CharSet=CharSet.Ansi)]
        delegate int RpcMessage([MarshalAs(UnmanagedType.LPStr)] string pipe, int message, int wp, int lp);
        delegate bool WindowCallback(IntPtr window, IntPtr unused);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
        [DllImport("kernel32.dll", CharSet=CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr library, string name);
        [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr library);
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int process);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int length);
        [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr unused);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int length);
        public static bool SupportedVersion(string value) { return value.Trim() == "0.9.1.22"; }
        public DoubaoVoice() {
            string trusted = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "DoubaoIME", "versions") + Path.DirectorySeparatorChar;
            foreach (var process in Process.GetProcessesByName("ImeService")) using (process) {
                if (process.SessionId != Process.GetCurrentProcess().SessionId) continue;
                IntPtr handle = OpenProcess(0x1000, false, process.Id);
                if (handle == IntPtr.Zero) continue;
                var path = new StringBuilder(32768); int length = path.Capacity;
                try { if (!QueryFullProcessImageName(handle, 0, path, ref length)) continue; }
                finally { CloseHandle(handle); }
                string executable = path.ToString();
                if (!Path.GetFullPath(executable).StartsWith(trusted, StringComparison.OrdinalIgnoreCase)) continue;
                directory = Path.GetDirectoryName(executable); pid = process.Id; break;
            }
            if (directory == null) throw new InvalidOperationException("DOUBAO_REQUIRED");
            if (!SupportedVersion(File.ReadAllText(Path.Combine(directory, "version.dat"))))
                throw new InvalidOperationException("DOUBAO_VERSION_UNSUPPORTED");
            config = Path.Combine(VoiceInput.UserAppData(), "DoubaoIme", "conf", "config.json");
            if (!File.Exists(config)) throw new InvalidOperationException("DOUBAO_REQUIRED");
            try {
                library = LoadLibraryEx(Path.Combine(directory, "doubaoime-rpc-new.dll"), IntPtr.Zero, 0x900);
                if (library == IntPtr.Zero) throw new InvalidOperationException("DOUBAO_REQUIRED");
                IntPtr entry = GetProcAddress(library, "RpcPipe_SimpleMessage");
                if (entry == IntPtr.Zero) throw new InvalidOperationException("DOUBAO_VERSION_UNSUPPORTED");
                rpc = (RpcMessage)Marshal.GetDelegateForFunctionPointer(entry, typeof(RpcMessage));
                var type = Assembly.LoadFrom(Path.Combine(directory, "DoubaoImeSettings.exe"))
                    .GetType("DoubaoIme.Settings.App.Ipc.SettingsRpcClient", true);
                settings = Activator.CreateInstance(type); patch = type.GetMethod("ApplyPatch");
                if (!IsRecording || File.Exists(MicrophoneLease.JournalPath))
                    microphoneLease = new MicrophoneLease(MicrophoneLease.JournalPath, ReadMicrophone, SetMicrophone,
                        delegate {
                            // Only reached for an orphaned lease whose selected input
                            // is still ours, never for a user's independent dictation.
                            if (IsRecording) {
                                Send(0x3f5, 0);
                                var wait = Stopwatch.StartNew();
                                while (IsRecording && wait.ElapsedMilliseconds < 1000) Thread.Sleep(50);
                            }
                        });
                object list = type.GetMethod("GetMicrophoneList").Invoke(settings, null);
                var devices = (System.Collections.IEnumerable)list.GetType().GetProperty("Devices").GetValue(list, null);
                foreach (object device in devices) {
                    string name = Convert.ToString(device.GetType().GetProperty("Name").GetValue(device, null));
                    string output = name.Contains("Steam Streaming Microphone") ? "Steam Streaming Micro" :
                        name.Contains("CABLE Output") && name.Contains("VB-Audio") ? "CABLE Input" : null;
                    if (output == null) continue;
                    OutputDevice = PcmPlayback.Find(output);
                    microphone = Convert.ToString(device.GetType().GetProperty("Id").GetValue(device, null));
                    break;
                }
                if (String.IsNullOrEmpty(microphone)) throw new InvalidOperationException("VIRTUAL_MIC_REQUIRED");
            } catch { Dispose(); throw; }
        }
        public bool IsRecording {
            get {
                bool visible = false;
                EnumWindows(delegate(IntPtr window, IntPtr unused) {
                    uint owner; GetWindowThreadProcessId(window, out owner);
                    if (owner != pid || !IsWindowVisible(window)) return true;
                    var name = new StringBuilder(128); GetClassName(window, name, name.Capacity);
                    if (name.ToString() == "OimeVoiceWaveWindow") visible = true;
                    return !visible;
                }, IntPtr.Zero);
                return visible;
            }
        }
        string ReadMicrophone() {
            var values = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(config));
            return Convert.ToString(((Dictionary<string, object>)values["voice"])["selectedMicrophoneId"]);
        }
        void SetMicrophone(string id) {
            patch.Invoke(settings, new object[] { new Dictionary<string, object> {
                { "voice", new Dictionary<string, object> { { "selectedMicrophoneId", id } } }
            } });
        }
        public void CheckAvailable() {
            if (IsRecording) throw new InvalidOperationException("VOICE_BUSY");
        }
        public void SelectMicrophone() {
            if (microphoneLease == null) throw new InvalidOperationException("VOICE_BUSY");
            microphoneLease.Select(microphone);
        }
        void Send(int message, int wp) {
            if (rpc(Pipe, message, wp, 0) != 0) throw new InvalidOperationException("VOICE_INPUT_FAILED");
        }
        public void Start(Func<bool> sameTarget) {
            recording = true; // A partially completed start must also be cancelled.
            Send(0x3ef, 2); // press start, long-press mode
            Thread.Sleep(700);
            Send(0x3f4, 0); // show recording wave
            var deadline = Stopwatch.StartNew();
            while (!IsRecording && deadline.ElapsedMilliseconds < 2500 && sameTarget()) Thread.Sleep(50);
            if (!IsRecording || !sameTarget()) throw new InvalidOperationException("VOICE_INPUT_FAILED");
        }
        public void End(bool commit) {
            if (!recording) return;
            try {
                Send(commit ? 0x3f0 : 0x3f5, 0);
                recording = false;
                if (commit) {
                    var deadline = Stopwatch.StartNew();
                    while (IsRecording && deadline.ElapsedMilliseconds < 2500) Thread.Sleep(50);
                }
            } catch {
                // Report a failed finish; Dispose then attempts cancellation before
                // restoring the microphone. Cancellation itself is best effort.
                if (commit) throw;
                recording = false;
            }
        }
        public void Dispose() {
            End(false);
            if (microphoneLease != null) { microphoneLease.Dispose(); microphoneLease = null; }
            var disposable = settings as IDisposable;
            if (disposable != null) disposable.Dispose();
            settings = null;
            if (library != IntPtr.Zero) { FreeLibrary(library); library = IntPtr.Zero; }
        }
    }

    // Persist the original selection BEFORE switching. A process crash must not make
    // the next session mistake our virtual microphone for the user's own selection.
    // The exclusive file handle also prevents two workers from nesting switches.
    public sealed class MicrophoneLease : IDisposable {
        public static string JournalPath { get {
            return Path.Combine(VoiceInput.UserAppData(), "ClipRelay", "voice-microphone.json");
        } }
        readonly string path;
        readonly Func<string> read;
        readonly Action<string> write;
        readonly Action beforeRecovery;
        FileStream gate;
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        public MicrophoneLease(string path, Func<string> read, Action<string> write, Action beforeRecovery = null) {
            this.path = path; this.read = read; this.write = write;
            this.beforeRecovery = beforeRecovery;
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            try { gate = new FileStream(path + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException) { throw new InvalidOperationException("VOICE_BUSY"); }
            try { Restore(true); }
            catch { gate.Dispose(); gate = null; throw; }
        }
        void SetVerified(string value) {
            for (int attempt = 0; attempt < 3; attempt++) {
                try {
                    write(value);
                    for (int poll = 0; poll < 10; poll++) {
                        if (read() == value) return;
                        Thread.Sleep(50);
                    }
                } catch { Thread.Sleep(100); }
            }
            throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED");
        }
        public void Select(string microphone) {
            string original = read();
            if (original == microphone) return;
            byte[] record = Encoding.UTF8.GetBytes(json.Serialize(new Dictionary<string, string> {
                { "original", original }, { "temporary", microphone }
            }));
            using (var file = new FileStream(path + ".new", FileMode.Create, FileAccess.Write, FileShare.None)) {
                file.Write(record, 0, record.Length); file.Flush(true);
            }
            File.Move(path + ".new", path);
            SetVerified(microphone);
        }
        public void Restore(bool recovering = false) {
            if (!File.Exists(path)) return;
            var record = json.Deserialize<Dictionary<string, string>>(File.ReadAllText(path));
            // A manual selection made during the session takes precedence.
            if (read() == record["temporary"]) {
                if (recovering && beforeRecovery != null) beforeRecovery();
                SetVerified(record["original"]);
            }
            File.Delete(path);
        }
        public void Dispose() {
            if (gate == null) return;
            try { Restore(); }
            catch { /* Keep the recovery journal; the idle worker and service exit retry. */ }
            finally { gate.Dispose(); gate = null; }
        }
    }

    // Bounded asynchronous WinMM buffers. Only an explicit, allowlisted virtual cable is opened.
    public sealed class PcmPlayback : IDisposable {
        [StructLayout(LayoutKind.Sequential, Pack=2)] public struct Format {
            public ushort tag, channels; public uint samples, bytes; public ushort align, bits, extra;
            public static Format Pcm { get { return new Format { tag=1, channels=1, samples=16000, bytes=32000, align=2, bits=16 }; } }
        }
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Caps {
            public ushort manufacturer, product; public uint version;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string name;
            public uint formats; public ushort channels, reserved; public uint support;
        }
        [StructLayout(LayoutKind.Sequential)] public struct Header {
            public IntPtr data; public uint length, recorded; public UIntPtr user; public uint flags, loops; public IntPtr next; public UIntPtr reserved;
        }
        [DllImport("winmm.dll")] static extern uint waveOutGetNumDevs();
        [DllImport("winmm.dll", CharSet=CharSet.Unicode)] static extern uint waveOutGetDevCaps(UIntPtr id, out Caps caps, uint size);
        [DllImport("winmm.dll")] static extern uint waveOutOpen(out IntPtr handle, uint id, ref Format format, IntPtr callback, IntPtr instance, uint flags);
        [DllImport("winmm.dll")] static extern uint waveOutPrepareHeader(IntPtr handle, IntPtr header, uint size);
        [DllImport("winmm.dll")] static extern uint waveOutWrite(IntPtr handle, IntPtr header, uint size);
        [DllImport("winmm.dll")] static extern uint waveOutUnprepareHeader(IntPtr handle, IntPtr header, uint size);
        [DllImport("winmm.dll")] static extern uint waveOutReset(IntPtr handle);
        [DllImport("winmm.dll")] static extern uint waveOutClose(IntPtr handle);
        readonly List<IntPtr> buffers = new List<IntPtr>();
        static readonly uint HeaderSize = (uint)Marshal.SizeOf(typeof(Header));
        IntPtr handle;
        int queued;
        readonly int maxQueued;
        public static uint Find(string name) {
            for (uint i = 0; i < waveOutGetNumDevs(); i++) {
                Caps caps;
                if (waveOutGetDevCaps(new UIntPtr(i), out caps, (uint)Marshal.SizeOf(typeof(Caps))) == 0 &&
                    caps.name.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0) return i;
            }
            throw new InvalidOperationException("VIRTUAL_MIC_REQUIRED");
        }
        public PcmPlayback(uint id) : this(id, Format.Pcm) { }
        internal PcmPlayback(uint id, Format format) {
            maxQueued = (int)format.bytes * 2;
            if (waveOutOpen(out handle, id, ref format, IntPtr.Zero, IntPtr.Zero, 0) != 0)
                throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED");
        }
        void Reap() {
            for (int i = buffers.Count - 1; i >= 0; i--) {
                Header header = (Header)Marshal.PtrToStructure(buffers[i], typeof(Header));
                if ((header.flags & 1) == 0) continue;
                if (waveOutUnprepareHeader(handle, buffers[i], HeaderSize) != 0) continue;
                queued -= (int)header.length;
                Marshal.FreeHGlobal(header.data); Marshal.FreeHGlobal(buffers[i]); buffers.RemoveAt(i);
            }
        }
        public void Write(byte[] pcm) {
            Reap();
            if (handle == IntPtr.Zero || queued + pcm.Length > maxQueued) throw new InvalidOperationException("VOICE_AUDIO_BACKLOG");
            IntPtr data = Marshal.AllocHGlobal(pcm.Length), headerPtr = Marshal.AllocHGlobal((int)HeaderSize);
            Marshal.Copy(pcm, 0, data, pcm.Length);
            Marshal.StructureToPtr(new Header { data=data, length=(uint)pcm.Length }, headerPtr, false);
            if (waveOutPrepareHeader(handle, headerPtr, HeaderSize) != 0) {
                Marshal.FreeHGlobal(data); Marshal.FreeHGlobal(headerPtr); throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED");
            }
            if (waveOutWrite(handle, headerPtr, HeaderSize) != 0) {
                waveOutUnprepareHeader(handle, headerPtr, HeaderSize); Marshal.FreeHGlobal(data); Marshal.FreeHGlobal(headerPtr);
                throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED");
            }
            buffers.Add(headerPtr); queued += pcm.Length;
        }
        public void Drain() {
            var timer = Stopwatch.StartNew();
            while (buffers.Count != 0 && timer.ElapsedMilliseconds < 2500) { Reap(); Thread.Sleep(10); }
            if (buffers.Count != 0) throw new InvalidOperationException("VOICE_AUDIO_BACKLOG");
            Thread.Sleep(250); // Let the capture side receive the final samples before ending dictation.
        }
        public void Dispose() {
            if (handle == IntPtr.Zero) return;
            waveOutReset(handle); Reap();
            waveOutClose(handle); handle = IntPtr.Zero;
        }
    }
}
