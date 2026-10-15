// The mask belongs to this short-lived desktop-user process. Killing it removes
// every mask; no monitor power state, display mode or audio setting is changed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace ClipRelay.Remote {
    public interface IPrivacyScreen : IDisposable {
        bool Supported { get; }
        bool Available { get; }
        void Show();
        void Hide();
        void Check();
    }

    // All calls run on one STA. Expiry is monotonic and independent of stdin.
    public sealed class PrivacyScreenLease : IDisposable {
        public const long LifetimeMs = 15000;
        readonly IPrivacyScreen screen;
        readonly Func<long> now;
        string lease = "";
        long deadline;
        public PrivacyScreenLease(IPrivacyScreen screen, Func<long> now) { this.screen=screen; this.now=now; }
        public void Restore() { lease=""; deadline=0; screen.Hide(); }
        public void Tick() {
            if (lease == "") return;
            if (now() >= deadline || !screen.Available) { Restore(); return; }
            try { screen.Check(); } catch { Restore(); }
        }
        public object Handle(Dictionary<string, object> request) {
            Tick();
            object opValue, leaseValue;
            if (request == null || !request.TryGetValue("op",out opValue) || !(opValue is string) || request.Count > 2)
                return Error("PRIVACY_BAD_REQUEST");
            foreach (string key in request.Keys) if (key != "op" && key != "lease") return Error("PRIVACY_BAD_REQUEST");
            string op=(string)opValue, id=request.TryGetValue("lease",out leaseValue) ? leaseValue as string : "";
            if (op == "status" && id == "") return State(true);
            if (id == null || !Regex.IsMatch(id,"\\A[0-9a-f]{32}\\z")) return Error("PRIVACY_BAD_REQUEST");
            if (op != "start" && op != "renew" && op != "stop") return Error("PRIVACY_BAD_REQUEST");
            if (lease != "" && lease != id) return Error("PRIVACY_BUSY");
            if (op == "stop") { Restore(); return State(true); }
            if (op == "renew" && lease == "") return Error("PRIVACY_EXPIRED");
            if (!screen.Supported) return Error("PRIVACY_UNSUPPORTED");
            if (!screen.Available) return Error("PRIVACY_DESKTOP_UNAVAILABLE");
            try {
                if (lease == "") screen.Show();
                lease=id; deadline=now()+LifetimeMs;
                return State(true);
            } catch { Restore(); return Error("PRIVACY_UNAVAILABLE"); }
        }
        object State(bool ok) { return new { ok=ok, supported=screen.Supported, active=lease!="", lease=lease, expiresMs=lease=="" ? 0 : Math.Max(0,deadline-now()) }; }
        static object Error(string code) { return new { ok=false, code=code }; }
        public void Dispose() { Restore(); screen.Dispose(); }
    }

    internal sealed class DesktopPrivacyScreen : IPrivacyScreen {
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Version {
            public uint size, major, minor, build, platform;
            [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string servicePack;
        }
        [DllImport("ntdll.dll", CharSet=CharSet.Unicode)] static extern int RtlGetVersion(ref Version version);
        [DllImport("dwmapi.dll")] static extern int DwmIsCompositionEnabled(out bool enabled);
        [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowDisplayAffinity(IntPtr window,uint affinity);
        [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr window,out uint affinity);
        [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr window,uint key,byte alpha,uint flags);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int w,int h,uint flags);
        [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr window,int id,uint modifiers,uint key);
        [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr window,int id);
        readonly List<Mask> masks=new List<Mask>();
        readonly EscapeWindow escape;
        Rectangle[] layout;
        bool registered;
        public Action Escaped;
        public DesktopPrivacyScreen() { escape=new EscapeWindow(() => { if (Escaped!=null) Escaped(); }); }
        public bool Supported { get {
            try {
                var version=new Version { size=(uint)Marshal.SizeOf(typeof(Version)) };
                bool composed;
                return RtlGetVersion(ref version)==0 && version.major>=10 && version.build>=19041 &&
                    DwmIsCompositionEnabled(out composed)==0 && composed;
            } catch { return false; }
        } }
        public bool Available { get { return InputFocus.IsInteractiveDesktop(); } }
        public void Show() {
            if (!Supported || !Available) throw new InvalidOperationException();
            Hide();
            // Ctrl+Alt+Shift+P. If another app owns this escape key, refuse to hide.
            registered=RegisterHotKey(escape.Handle,1,0x4007,0x50);
            if (!registered) throw new InvalidOperationException();
            try {
                Screen[] displays=Screen.AllScreens;
                if (displays.Length==0 || displays.Length>32) throw new InvalidOperationException();
                layout=new Rectangle[displays.Length];
                for (int i=0;i<displays.Length;i++) {
                    layout[i]=displays[i].Bounds;
                    var mask=new Mask(layout[i]); masks.Add(mask);
                    // Set affinity BEFORE showing the window. Never expose a black
                    // frame to the capture while negotiating exclusion support.
                    IntPtr handle=mask.Handle;
                    Exclude(mask);
                    mask.Show();
                    if (!SetWindowPos(handle,new IntPtr(-1),0,0,0,0,0x13)) throw new InvalidOperationException();
                }
            } catch { Hide(); throw; }
        }
        public void Check() {
            Screen[] displays=Screen.AllScreens;
            // A topology change ends this lease. Re-enabling requires an explicit
            // action, so a newly attached display is never reported as protected.
            if (!Supported || !Available || layout==null || displays.Length!=layout.Length) throw new InvalidOperationException();
            for (int i=0;i<layout.Length;i++) {
                uint affinity;
                if (displays[i].Bounds!=layout[i] || masks[i].IsDisposed || !masks[i].Visible ||
                    !GetWindowDisplayAffinity(masks[i].Handle,out affinity) || affinity!=0x11 ||
                    !SetWindowPos(masks[i].Handle,new IntPtr(-1),0,0,0,0,0x13)) throw new InvalidOperationException();
            }
        }
        public void Hide() {
            foreach (var mask in masks) mask.Dispose();
            masks.Clear(); layout=null;
            if (registered) { UnregisterHotKey(escape.Handle,1); registered=false; }
        }
        public void Dispose() { Hide(); escape.Dispose(); }
        internal static void Exclude(Form mask) {
            uint affinity; IntPtr handle=mask.Handle;
            if (!SetLayeredWindowAttributes(handle,0,255,2) || !SetWindowDisplayAffinity(handle,0x11) ||
                !GetWindowDisplayAffinity(handle,out affinity) || affinity!=0x11) throw new InvalidOperationException();
        }
        sealed class EscapeWindow : NativeWindow, IDisposable {
            readonly Action action;
            public EscapeWindow(Action action) { this.action=action; CreateHandle(new CreateParams { Parent=new IntPtr(-3) }); }
            protected override void WndProc(ref Message message) { if (message.Msg==0x312 && message.WParam==new IntPtr(1)) action(); base.WndProc(ref message); }
            public void Dispose() { DestroyHandle(); }
        }
        internal sealed class Mask : Form {
            public Mask(Rectangle bounds) { FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false; StartPosition=FormStartPosition.Manual; Bounds=bounds; BackColor=Color.Black; TopMost=true; }
            protected override bool ShowWithoutActivation { get { return true; } }
            protected override CreateParams CreateParams { get { var p=base.CreateParams; p.ExStyle|=0x080800A0; return p; } }
            protected override void OnPaint(PaintEventArgs e) {
                base.OnPaint(e);
                TextRenderer.DrawText(e.Graphics,"ClipRelay 隐私屏\nCtrl + Alt + Shift + P 恢复显示",SystemFonts.MessageBoxFont,ClientRectangle,Color.Silver,
                    TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.WordBreak);
            }
        }
    }

    public static class PrivacyScreenWorker {
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        public static int Run() {
            using (var identity=WindowsIdentity.GetCurrent()) if (identity.IsSystem) return DesktopUserProcess.RunWorker("--privacy-probe");
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            int result=2;
            var sta=new Thread(() => {
                bool created;
                using (var gate=new Mutex(true,"Local\\ClipRelay.PrivacyScreen.v1",out created)) {
                    if (!created) return;
                    try { result=Serve(); } catch { result=2; } finally { gate.ReleaseMutex(); }
                }
            });
            sta.SetApartmentState(ApartmentState.STA); sta.Start(); sta.Join(); return result;
        }
        static int Serve() {
            Console.InputEncoding=new UTF8Encoding(false,true); Console.OutputEncoding=new UTF8Encoding(false);
            var json=new JavaScriptSerializer { MaxJsonLength=4096, RecursionLimit=4 };
            var clock=Stopwatch.StartNew();
            using (var dispatch=new Control())
            using (var screen=new DesktopPrivacyScreen())
            using (var lease=new PrivacyScreenLease(screen,() => clock.ElapsedMilliseconds))
            using (var sessionLock=new SessionLockLease(new DesktopWorkstationLock(),() => clock.ElapsedMilliseconds,lease.Restore))
            using (var timer=new System.Windows.Forms.Timer { Interval=250 }) {
                IntPtr handle=dispatch.Handle;
                screen.Escaped=lease.Restore;
                timer.Tick+=(s,e) => { lease.Tick(); sessionLock.Tick(); }; timer.Start();
                var reader=new Thread(() => {
                    try {
                        while (true) {
                            var line=new StringBuilder(); int c;
                            while ((c=Console.Read())!=-1 && c!='\n') { if (line.Length>=4096) throw new InvalidOperationException(); line.Append((char)c); }
                            if (c==-1) break;
                            string raw=line.ToString();
                            bool lockCommand=raw.StartsWith("session-lock:",StringComparison.Ordinal);
                            if (!lockCommand && !raw.StartsWith("privacy:",StringComparison.Ordinal)) break;
                            string command=raw.Substring(lockCommand ? 13 : 8);
                            // Invoke, not BeginInvoke: one pending request at most.
                            string reply=(string)dispatch.Invoke(new Func<string>(() => {
                                try { var request=json.Deserialize<Dictionary<string,object>>(command); return json.Serialize(lockCommand ? sessionLock.Handle(request) : lease.Handle(request)); }
                                catch { sessionLock.Cancel(); lease.Restore(); return "{\"ok\":false,\"code\":\"PRIVACY_BAD_REQUEST\"}"; }
                            }));
                            Console.WriteLine(reply); Console.Out.Flush();
                        }
                    } catch { }
                    finally { try { dispatch.BeginInvoke(new Action(() => { lease.Restore(); Application.ExitThread(); })); } catch { } }
                });
                reader.IsBackground=true; reader.Start();
                Application.Run();
                return 0;
            }
        }
    }
}
