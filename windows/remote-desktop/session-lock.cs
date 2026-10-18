// A one-shot lock intent, renewed only by the service while the same stream is
// known. Expiry, shutdown and local session changes cancel; they never lock.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace ClipRelay.Remote {
    public interface IWorkstationLock : IDisposable {
        bool Supported { get; }
        bool Available { get; }
        long Generation { get; }
        long LastLockGeneration { get; }
        bool RequestLock();
    }
    public sealed class SessionLockLease : IDisposable {
        public const long LifetimeMs=15000, ConfirmationMs=5000;
        readonly IWorkstationLock workstation;
        readonly Func<long> now;
        readonly Action beforeLock;
        string lease="", state="off";
        long deadline, generation;
        public SessionLockLease(IWorkstationLock workstation, Func<long> now, Action beforeLock) {
            this.workstation=workstation; this.now=now; this.beforeLock=beforeLock;
        }
        public void Cancel() { lease=""; state="off"; deadline=0; }
        public void Tick() {
            if (state=="armed") {
                if (now()>=deadline || !workstation.Available || workstation.Generation!=generation) {
                    state="cancelled"; deadline=0;
                }
            } else if (state=="requested") {
                // LockWorkStation is asynchronous: its BOOL only acknowledges
                // initiation. Only a WTS_SESSION_LOCK event confirms completion.
                if (workstation.LastLockGeneration>generation) { state="locked"; deadline=0; }
                else if (now()>=deadline || workstation.Generation!=generation) { state="failed"; deadline=0; }
            }
        }
        public object Handle(Dictionary<string,object> request) {
            Tick(); object value;
            if (request==null || request.Count>2 || !request.TryGetValue("op",out value) || !(value is string)) return Error("LOCK_BAD_REQUEST");
            foreach (string key in request.Keys) if (key!="op" && key!="lease") return Error("LOCK_BAD_REQUEST");
            string op=(string)value, id=request.TryGetValue("lease",out value) ? value as string : "";
            if (op=="status" && id=="") return State();
            if (id==null || !Regex.IsMatch(id,"\\A[0-9a-f]{32}\\z")) return Error("LOCK_BAD_REQUEST");
            if (op!="arm" && op!="renew" && op!="cancel" && op!="commit") return Error("LOCK_BAD_REQUEST");
            if (op=="cancel") {
                if (lease!="" && lease!=id) return Error("LOCK_BUSY");
                if (state=="requested") return Error("LOCK_ALREADY_REQUESTED");
                Cancel(); return State();
            }
            if (op=="commit" && lease==id && (state=="requested" || state=="locked" || state=="failed")) return State();
            if ((state=="armed" || state=="requested") && lease!=id) return Error("LOCK_BUSY");
            if (op=="renew" || op=="commit") {
                if (state!="armed" || lease!=id) return Error("LOCK_EXPIRED");
            } else if (lease==id && state!="armed") return Error("LOCK_EXPIRED");
            if (!workstation.Supported) return Error("LOCK_UNSUPPORTED");
            if (!workstation.Available) return Error("LOCK_DESKTOP_UNAVAILABLE");
            if (op=="commit") {
                // Consume before any OS call. A lost response cannot cause a
                // retry to re-lock a workstation that the user has since unlocked.
                state="failed"; deadline=0;
                try {
                    beforeLock();
                    if (!workstation.Available || workstation.Generation!=generation) return State();
                    if (workstation.RequestLock()) { state="requested"; deadline=now()+ConfirmationMs; }
                } catch { }
                return State();
            }
            lease=id; state="armed"; generation=workstation.Generation; deadline=now()+LifetimeMs;
            return State();
        }
        object State() { return new { ok=true, supported=workstation.Supported, state=state, lease=lease,
            expiresMs=(state=="armed" || state=="requested") ? Math.Max(0,deadline-now()) : 0 }; }
        static object Error(string code) { return new { ok=false,code=code }; }
        public void Dispose() { Cancel(); workstation.Dispose(); }
    }

    internal sealed class DesktopWorkstationLock : NativeWindow, IWorkstationLock {
        [DllImport("wtsapi32.dll",SetLastError=true)] static extern bool WTSRegisterSessionNotification(IntPtr window,uint flags);
        [DllImport("wtsapi32.dll")] static extern bool WTSUnRegisterSessionNotification(IntPtr window);
        [DllImport("user32.dll",SetLastError=true)] static extern bool LockWorkStation();
        bool registered;
        readonly int sessionId;
        long registrationAttempt;
        long generation, lastLockGeneration;
        public DesktopWorkstationLock() {
            using (var process=Process.GetCurrentProcess()) sessionId=process.SessionId;
            CreateHandle(new CreateParams { Parent=new IntPtr(-3) });
            registrationAttempt=Stopwatch.GetTimestamp();
            registered=WTSRegisterSessionNotification(Handle,0);
        }
        public bool Supported { get {
            // Terminal Services can become ready after the user worker starts.
            // Retry a failed registration, never register an existing HWND twice.
            if (!registered && Handle!=IntPtr.Zero && Stopwatch.GetTimestamp()-registrationAttempt>=Stopwatch.Frequency) {
                registrationAttempt=Stopwatch.GetTimestamp();
                registered=WTSRegisterSessionNotification(Handle,0);
            }
            return registered;
        } }
        public bool Available { get { return registered && InputFocus.IsInteractiveDesktop(); } }
        public long Generation { get { return generation; } }
        public long LastLockGeneration { get { return lastLockGeneration; } }
        public bool RequestLock() { return Available && LockWorkStation(); }
        protected override void WndProc(ref Message message) {
            if (message.Msg==0x02B1 && message.LParam.ToInt64()==sessionId) {
                generation++;
                if (message.WParam.ToInt32()==7) lastLockGeneration=generation;
            }
            base.WndProc(ref message);
        }
        public void Dispose() { if (Handle!=IntPtr.Zero) { if (registered) WTSUnRegisterSessionNotification(Handle); DestroyHandle(); } }
    }
}
