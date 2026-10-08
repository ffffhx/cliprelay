// ClipRelay remote desktop service. Windows API session launching follows the
// approach used by Sunshine's tools/sunshinesvc.cpp. SPDX-License-Identifier: GPL-3.0-only
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace ClipRelay.Remote {
    public sealed class HostService : ServiceBase {
        public const string Name = "ClipRelayRemote";
        public const string PipeName = "ClipRelay.Remote.Control.v1";
        static readonly string Root = Path.GetDirectoryName(typeof(HostService).Assembly.Location);
        static readonly string StateRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "ClipRelay", "Remote");
        static readonly string SettingsPath = Path.Combine(StateRoot, "service.json");
        readonly object gate = new object();
        readonly ManualResetEvent stopped = new ManualResetEvent(false);
        Dictionary<string, object> settings;
        Process child;
        Process networkChild;
        Process focusChild;
        IntPtr focusJob;
        readonly object networkGate = new object();
        IntPtr job;
        uint childSession;
        Thread monitor;
        NamedPipeServerStream listeningPipe;

        static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 }; }
        static string Text(Dictionary<string, object> value, string key) { object v; return value.TryGetValue(key, out v) ? Convert.ToString(v) : ""; }
        static string Quote(string s) { return "\"" + s.Replace("\"", "") + "\""; }
        static void Log(string message) {
            try { File.AppendAllText(Path.Combine(StateRoot, "service.log"), DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine); } catch { }
        }
        public HostService() { ServiceName = Name; CanHandleSessionChangeEvent = true; CanShutdown = true; }
        protected override void OnStart(string[] args) {
            settings = Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(SettingsPath));
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            EnsureEngineConfiguration();
            new Thread(Serve) { IsBackground = true, Name = "ClipRelay remote control" }.Start();
            monitor = new Thread(MonitorEngine) { IsBackground = true, Name = "ClipRelay remote session" };
            monitor.Start();
            Log("Service started");
        }
        protected override void OnStop() {
            stopped.Set();
            try { if (listeningPipe != null) listeningPipe.Dispose(); } catch { }
            if (monitor != null) monitor.Join(12000);
            lock (gate) { StopNetwork(); StopEngine(); }
            Log("Service stopped");
        }
        protected override void OnShutdown() { OnStop(); }
        void SaveSettings() {
            var temp = SettingsPath + ".new";
            File.WriteAllText(temp, Json().Serialize(settings), new UTF8Encoding(false));
            File.Replace(temp, SettingsPath, null);
        }
        void EnsureEngineConfiguration() {
            string password = Text(settings, "adminPassword");
            if (password.Length == 0) {
                byte[] bytes = new byte[32];
                using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
                password = Convert.ToBase64String(bytes);
                settings["adminPassword"] = password;
                SaveSettings();
            }
            string engineRoot = Path.Combine(Root, "engine");
            string slashState = StateRoot.Replace('\\', '/');
            string cfg = "sunshine_name = ClipRelay - " + Environment.MachineName + "\n" +
                "port = 48789\norigin_web_ui_allowed = pc\nsystem_tray = disabled\n" +
                "upnp = disabled\ncontroller = disabled\ngamepad_driver = vigembus\n" +
                "min_log_level = 2\nlan_encryption_mode = 2\nwan_encryption_mode = 2\n" +
                "file_apps = " + slashState + "/apps.json\n" +
                "file_state = " + slashState + "/clients.json\n" +
                "credentials_file = " + slashState + "/credentials.json\n" +
                "pkey = " + slashState + "/cakey.pem\ncert = " + slashState + "/cacert.pem\n" +
                "log_path = " + slashState + "/engine.log\n";
            File.WriteAllText(Path.Combine(StateRoot, "sunshine.conf"), cfg, new UTF8Encoding(false));
            File.WriteAllText(Path.Combine(StateRoot, "apps.json"), Json().Serialize(new {
                env = new Dictionary<string, string>(),
                apps = new[] { new Dictionary<string, object> { { "name", "Desktop" }, { "image-path", Path.Combine(engineRoot, "assets", "desktop.png").Replace('\\', '/') } } }
            }), new UTF8Encoding(false));
            // Same SHA-256(password + salt) credentials format as Sunshine httpcommon.cpp.
            string salt = Guid.NewGuid().ToString("N").Substring(0, 16);
            string hash;
            using (var sha = SHA256.Create()) {
                byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(password + salt));
                // Sunshine util::hex() emits the fixed-size hash in reverse byte order, uppercase.
                Array.Reverse(digest);
                hash = BitConverter.ToString(digest).Replace("-", "");
            }
            File.WriteAllText(Path.Combine(StateRoot, "credentials.json"), Json().Serialize(new { username = "cliprelay", salt = salt, password = hash }), new UTF8Encoding(false));
        }
        bool IsRunning { get { try { return child != null && !child.HasExited; } catch { return false; } } }
        bool IsReady {
            get {
                if (!IsRunning) return false;
                // Encoder probing can take several seconds after the process starts.
                using (var probe = new TcpClient()) {
                    try { return probe.ConnectAsync(IPAddress.Loopback, 48790).Wait(100) && probe.Connected; }
                    catch { return false; }
                }
            }
        }
        bool Enabled { get { object value; return settings.TryGetValue("enabled", out value) && Convert.ToBoolean(value); } }
        bool NetworkEnabled { get { object value; return settings.TryGetValue("networkEnabled", out value) && Convert.ToBoolean(value); } }
        void MonitorEngine() {
            while (!stopped.WaitOne(1000)) {
                lock (gate) {
                    try {
                        uint session = Native.WTSGetActiveConsoleSessionId();
                        if (!Enabled || (IsRunning && session != childSession)) StopEngine();
                        if (Enabled && !IsRunning && session != uint.MaxValue) {
                            StopEngine();
                            string executable = Path.Combine(Root, "engine", "sunshine.exe");
                            Native.StartInSession(executable, Quote(executable) + " " + Quote(Path.Combine(StateRoot, "sunshine.conf")), Path.GetDirectoryName(executable), session, out child, out job);
                            childSession = session;
                            Log("Remote engine started in session " + session + ", PID " + child.Id);
                        }
                        if (Enabled && NetworkEnabled) EnsureNetwork(); else StopNetwork();
                        if (Enabled && IsRunning) EnsureFocus(); else StopFocus();
                    } catch (Exception e) { Log("Engine: " + e.Message); }
                }
            }
        }
        void EnsureNetwork() {
            lock (networkGate) {
                if (networkChild != null && !networkChild.HasExited) return;
                if (networkChild != null) { networkChild.Dispose(); networkChild = null; }
                string executable = Path.Combine(Root, "cliprelay-network.exe");
                if (!File.Exists(executable)) throw new InvalidOperationException("外网组件尚未安装，请更新 ClipRelay。");
                var psi = new ProcessStartInfo(executable, "--state-dir " + Quote(Path.Combine(StateRoot, "network")));
                psi.WorkingDirectory = Root; psi.UseShellExecute = false; psi.CreateNoWindow = true;
                psi.RedirectStandardInput = true; psi.RedirectStandardOutput = true; psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8; psi.StandardErrorEncoding = Encoding.UTF8;
                networkChild = new Process { StartInfo = psi };
                // stdout is the private service/helper IPC. Never forward runtime
                // diagnostics or enrollment credentials into tray logs.
                networkChild.ErrorDataReceived += delegate { };
                networkChild.Start(); networkChild.BeginErrorReadLine();
                Log("Embedded network helper started");
            }
        }
        void StopNetwork() {
            lock (networkGate) {
                if (networkChild == null) return;
                try {
                    if (!networkChild.HasExited) {
                        networkChild.StandardInput.WriteLine("{\"action\":\"shutdown\"}");
                        networkChild.StandardInput.Flush();
                        if (!networkChild.WaitForExit(2000)) networkChild.Kill();
                    }
                } catch { try { if (!networkChild.HasExited) networkChild.Kill(); } catch { } }
                networkChild.Dispose(); networkChild = null;
            }
        }
        object NetworkRequest(string action, string id) {
            lock (networkGate) {
                if (networkChild == null || networkChild.HasExited) {
                    if (action != "status") throw new InvalidOperationException("外网连接尚未就绪，请稍后重试。");
                    return new { ready = false, state = "disabled", error = "外网连接未开启", peers = new object[0], pending = new object[0] };
                }
                networkChild.StandardInput.WriteLine(Json().Serialize(new { action = action, id = id }));
                networkChild.StandardInput.Flush();
                var read = networkChild.StandardOutput.ReadLineAsync();
                if (!read.Wait(15000) || read.Result == null) {
                    // Kill an out-of-sync helper so a late reply cannot be
                    // mistaken for the response to a later control request.
                    try { networkChild.Kill(); } catch { }
                    throw new System.TimeoutException("外网服务响应超时，正在恢复连接。");
                }
                var response = Json().Deserialize<Dictionary<string, object>>(read.Result);
                if (!Convert.ToBoolean(response["ok"])) throw new InvalidOperationException(Text(response, "error"));
                return response["data"];
            }
        }
        void StopEngine() {
            StopFocus();
            if (IsRunning) {
                try {
                    Process helper; IntPtr helperJob;
                    string self = typeof(HostService).Assembly.Location;
                    Native.StartInSession(self, Quote(self) + " --terminate " + child.Id, Root, childSession, out helper, out helperJob);
                    helper.WaitForExit(2000);
                    Native.CloseHandle(helperJob); helper.Dispose();
                    if (!child.WaitForExit(5000)) child.Kill();
                } catch { try { if (IsRunning) child.Kill(); } catch { } }
            }
            if (child != null) { child.Dispose(); child = null; }
            if (job != IntPtr.Zero) { Native.CloseHandle(job); job = IntPtr.Zero; }
        }
        void EnsureFocus() {
            if (focusChild != null && !focusChild.HasExited) return;
            StopFocus();
            string executable = Path.Combine(Root, "cliprelay-network.exe");
            Native.StartInSession(executable, Quote(executable) + " --state-dir " + Quote(StateRoot) +
                " --input-focus-probe " + Quote(typeof(HostService).Assembly.Location), Root, childSession, out focusChild, out focusJob);
        }
        void StopFocus() {
            bool hadFocus = focusJob != IntPtr.Zero || focusChild != null;
            if (focusJob != IntPtr.Zero) { Native.CloseHandle(focusJob); focusJob = IntPtr.Zero; }
            if (focusChild != null) {
                try { if (!focusChild.HasExited) focusChild.Kill(); } catch { }
                focusChild.Dispose(); focusChild = null;
            }
            if (hadFocus) {
                // The job teardown can interrupt Dispose in an active voice worker.
                // Recover in a fresh user worker after the old job releases its lease.
                Process recovery = null; IntPtr recoveryJob = IntPtr.Zero;
                try {
                    string self = typeof(HostService).Assembly.Location;
                    Native.StartInSession(self, Quote(self) + " --voice-recover", Root, childSession, out recovery, out recoveryJob);
                    recovery.WaitForExit(5000);
                } catch { /* Persistent journal will also be retried on the next startup. */ }
                finally {
                    if (recoveryJob != IntPtr.Zero) Native.CloseHandle(recoveryJob);
                    if (recovery != null) recovery.Dispose();
                }
            }
        }
        PipeSecurity PipeAcl() {
            var acl = new PipeSecurity();
            acl.SetAccessRuleProtection(true, false);
            acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
            foreach (string sid in new[] { "S-1-5-18", "S-1-5-32-544", Text(settings, "operatorSid") })
                acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid), sid == Text(settings, "operatorSid") ? PipeAccessRights.ReadWrite : PipeAccessRights.FullControl, AccessControlType.Allow));
            return acl;
        }
        void Serve() {
            while (!stopped.WaitOne(0)) {
                NamedPipeServerStream pipe = null;
                try {
                    pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 8, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 16384, 16384, PipeAcl());
                    listeningPipe = pipe;
                    pipe.WaitForConnection();
                    var connected = pipe; pipe = null;
                    ThreadPool.QueueUserWorkItem(delegate { HandleClient(connected); });
                } catch (Exception e) { if (!stopped.WaitOne(0)) { Log("Control pipe: " + e.Message); stopped.WaitOne(1000); } }
                finally { if (pipe != null) pipe.Dispose(); }
            }
        }
        void HandleClient(NamedPipeServerStream pipe) {
            using (pipe) {
                // A connected client cannot hold a service worker indefinitely.
                using (var timeout = new Timer(delegate { try { pipe.Dispose(); } catch { } }, null, 30000, Timeout.Infinite)) {
                    try {
                        var input = new MemoryStream();
                        int ch;
                        while ((ch = pipe.ReadByte()) != -1 && ch != 10) {
                            if (input.Length >= 16384) throw new InvalidDataException("Request too large");
                            input.WriteByte((byte)ch);
                        }
                        var request = Json().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(input.ToArray()));
                        object response;
                        try { response = new { ok = true, data = Dispatch(request) }; }
                        catch (Exception e) { response = new { ok = false, error = e.Message }; }
                        byte[] output = Encoding.UTF8.GetBytes(Json().Serialize(response) + "\n");
                        pipe.Write(output, 0, output.Length); pipe.Flush();
                    } catch (Exception e) { Log("Control request: " + e.Message); }
                }
            }
        }
        object Dispatch(Dictionary<string, object> request) {
            string action = Text(request, "action");
            if (action == "networkEnable" || action == "networkDisable") {
                lock (gate) {
                    settings["networkEnabled"] = action == "networkEnable";
                    if (NetworkEnabled) settings["enabled"] = true;
                    SaveSettings();
                    if (NetworkEnabled) EnsureNetwork(); else StopNetwork();
                }
                return new { enabled = action == "networkEnable" };
            }
            if (action == "networkStatus") return NetworkRequest("status", "");
            if (action == "networkCode") return NetworkRequest("code", "");
            if (action == "networkApprove" || action == "networkRevoke") {
                string id = Text(request, "id");
                if (!System.Text.RegularExpressions.Regex.IsMatch(id, "\\A[0-9a-f]{24}\\z")) throw new ArgumentException("Invalid device ID");
                return NetworkRequest(action == "networkApprove" ? "approve" : "revoke", id);
            }
            if (action == "status") {
                lock (gate) return new { enabled = Enabled, running = IsRunning, ready = IsReady, port = 48789, name = Environment.MachineName, pid = IsRunning ? child.Id : 0, version = "2026.914.233613" };
            }
            if (action == "enable" || action == "disable") {
                lock (gate) { settings["enabled"] = action == "enable"; SaveSettings(); if (!Enabled) StopEngine(); }
                return new { enabled = action == "enable" };
            }
            if (action == "lanPairings") return new { pairings = LanPairings() };
            if (action == "lanPairApprove") {
                string id = Text(request, "id");
                if (!System.Text.RegularExpressions.Regex.IsMatch(id, "\\A[0-9a-f]{32}\\z")) throw new ArgumentException("Invalid pairing ID");
                lock (gate) { if (!Enabled || !IsReady) throw new InvalidOperationException("Remote desktop is not ready"); }
                bool found = false;
                foreach (var pending in LanPairings()) if (Text(pending, "id") == id) found = true;
                if (!found) throw new InvalidOperationException("配对请求已取消或过期，请从手机重新发起。");
                File.WriteAllText(Path.Combine(StateRoot, "lan-pairing", id + ".approved"), "approved", new UTF8Encoding(false));
                return new { status = true };
            }
            if (action == "pairings") {
                var result = (Dictionary<string, object>)EngineRequest("GET", "/api/pin", null);
                var entries = new List<object>();
                foreach (var pending in LanPairings()) entries.Add(pending);
                object legacy;
                if (result.TryGetValue("pairings", out legacy) && legacy is object[]) {
                    foreach (var item in (object[])legacy) {
                        var entry = item as Dictionary<string, object>;
                        if (entry != null && !System.Text.RegularExpressions.Regex.IsMatch(Text(entry, "name"), "\\AClipRelay-[0-9a-f]{32}\\z")) entries.Add(entry);
                    }
                }
                return new { pairings = entries.ToArray() };
            }
            if (action == "clients") return EngineRequest("GET", "/api/clients/list", null);
            if (action == "pair") {
                string id = Text(request, "id"), pin = Text(request, "pin"), name = Text(request, "name");
                if (!System.Text.RegularExpressions.Regex.IsMatch(id, "\\A[0-9a-fA-F]{32}\\z") ||
                    !System.Text.RegularExpressions.Regex.IsMatch(pin, "\\A[0-9]{4}\\z") || name.Length < 1 || Encoding.UTF8.GetByteCount(name) > 128)
                    throw new ArgumentException("Invalid pairing request");
                return EngineRequest("POST", "/api/pin", new { pairing_id = id, pin = pin, name = name });
            }
            if (action == "unpair") {
                string uuid = Text(request, "uuid");
                if (uuid.Length < 1 || uuid.Length > 128) throw new ArgumentException("Invalid client identifier");
                return EngineRequest("POST", "/api/clients/unpair", new { uuid = uuid });
            }
            if (action == "disconnect") return EngineRequest("POST", "/api/apps/close", new { });
            throw new ArgumentException("Unknown action");
        }
        List<Dictionary<string, object>> LanPairings() {
            var entries = new List<Dictionary<string, object>>();
            lock (gate) { if (!Enabled || !IsRunning) return entries; }
            string directory = Path.Combine(StateRoot, "lan-pairing");
            if (!Directory.Exists(directory)) return entries;
            long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalSeconds;
            foreach (string path in Directory.GetFiles(directory, "*.json")) {
                if (entries.Count >= 8) break;
                string id = Path.GetFileNameWithoutExtension(path);
                if (!System.Text.RegularExpressions.Regex.IsMatch(id, "\\A[0-9a-f]{32}\\z")) continue;
                try {
                    if (new FileInfo(path).Length > 2048) continue;
                    var value = Json().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
                    if (Text(value, "id") != id || Convert.ToInt64(value["expires"]) <= now ||
                        File.Exists(Path.Combine(directory, id + ".approved"))) continue;
                    string verification = Text(value, "verification"), name = Text(value, "name");
                    if (!System.Text.RegularExpressions.Regex.IsMatch(verification, "\\A[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}\\z")) continue;
                    entries.Add(new Dictionary<string, object> { { "id", id }, { "name", name },
                        { "address", verification }, { "verification", verification }, { "automatic", true } });
                } catch (IOException) { } catch (ArgumentException) { } catch (KeyNotFoundException) { }
            }
            return entries;
        }

        object EngineRequest(string method, string path, object body) {
            string password;
            lock (gate) { if (!Enabled || !IsRunning) throw new InvalidOperationException("Remote desktop is not running"); password = Text(settings, "adminPassword"); }
            var request = (HttpWebRequest)WebRequest.Create("https://127.0.0.1:48790" + path);
            request.Proxy = null; request.Method = method; request.Timeout = 20000; request.ReadWriteTimeout = 20000;
            request.Headers["Authorization"] = "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("cliprelay:" + password));
            string pem = File.ReadAllText(Path.Combine(StateRoot, "cacert.pem"));
            string base64 = pem.Replace("-----BEGIN CERTIFICATE-----", "").Replace("-----END CERTIFICATE-----", "").Trim();
            using (var expected = new X509Certificate2(Convert.FromBase64String(base64))) {
                string thumb = expected.Thumbprint;
                request.ServerCertificateValidationCallback = delegate(object sender, X509Certificate cert, X509Chain chain, System.Net.Security.SslPolicyErrors errors) {
                    return cert != null && String.Equals(cert.GetCertHashString(), thumb, StringComparison.OrdinalIgnoreCase);
                };
                if (body != null) {
                    byte[] data = Encoding.UTF8.GetBytes(Json().Serialize(body));
                    request.ContentType = "application/json"; request.ContentLength = data.Length;
                    using (var stream = request.GetRequestStream()) stream.Write(data, 0, data.Length);
                }
                using (var response = request.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) return Json().DeserializeObject(reader.ReadToEnd());
            }
        }
        public static int Main(string[] args) {
            if (args.Length == 1 && args[0] == "--voice-probe") return VoiceInput.Run();
            if (args.Length == 1 && args[0] == "--voice-recover") return VoiceInput.Run(true);
            if (args.Length == 1 && args[0] == "--focus-probe") return InputFocus.Run();
            if (args.Length == 2 && args[0] == "--terminate") {
                uint pid;
                if (!UInt32.TryParse(args[1], out pid) || !Native.AttachConsole(pid)) return 1;
                Native.SetConsoleCtrlHandler(IntPtr.Zero, true);
                return Native.GenerateConsoleCtrlEvent(0, 0) ? 0 : 1;
            }
            ServiceBase.Run(new HostService()); return 0;
        }
    }

    internal static class Native {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
            public int cb; public string reserved, desktop, title; public int x, y, xs, ys, xc, yc, fill, flags;
            public short show, reserved2; public IntPtr reservedPtr, stdin, stdout, stderr;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime, jobTime; public uint flags; public UIntPtr minWs, maxWs; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
        [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, ref uint info, int length);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo startup, out ProcessInfo info);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtendedLimit info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
        [DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
        [DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint ctrl, uint group);
        static void Check(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
        public static void StartInSession(string app, string command, string cwd, uint session, out Process process, out IntPtr job) {
            IntPtr original = IntPtr.Zero, token = IntPtr.Zero; ProcessInfo pi = new ProcessInfo();
            process = null; job = IntPtr.Zero;
            try {
                Check(OpenProcessToken(GetCurrentProcess(), 2, out original));
                Check(DuplicateTokenEx(original, 0xF01FF, IntPtr.Zero, 2, 1, out token));
                Check(SetTokenInformation(token, 12, ref session, 4));
                job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
                var limits = new ExtendedLimit(); limits.basic.flags = 0x2000 | 0x800;
                Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
                var si = new StartupInfo(); si.cb = Marshal.SizeOf(si); si.desktop = "winsta0\\default";
                Check(CreateProcessAsUser(token, app, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false, 0x08000000 | 0x400 | 4, IntPtr.Zero, cwd, ref si, out pi));
                Check(AssignProcessToJobObject(job, pi.process));
                process = Process.GetProcessById(pi.pid);
                if (ResumeThread(pi.thread) == UInt32.MaxValue) throw new System.ComponentModel.Win32Exception();
            } catch {
                if (pi.process != IntPtr.Zero) TerminateProcess(pi.process, 1);
                if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
                throw;
            } finally {
                if (pi.thread != IntPtr.Zero) CloseHandle(pi.thread);
                if (pi.process != IntPtr.Zero) CloseHandle(pi.process);
                if (token != IntPtr.Zero) CloseHandle(token);
                if (original != IntPtr.Zero) CloseHandle(original);
            }
        }
    }
}
