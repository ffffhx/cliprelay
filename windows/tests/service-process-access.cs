using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Web.Script.Serialization;

class ServiceProcessAccessTests {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static void Save(string path, object value) { File.WriteAllText(path, Json.Serialize(value)); }
    static int Main(string[] args) {
        try {
            if (args[0] == "--server") Server(args[1], args[2]);
            else if (args[0] == "--client") Client(UInt32.Parse(args[1]), args[2]);
            else throw new ArgumentException("Unknown fixture mode");
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
    static RawSecurityDescriptor ReadAcl() {
        uint size; GetKernelObjectSecurity(GetCurrentProcess(), 4, null, 0, out size);
        var bytes = new byte[size];
        Check(GetKernelObjectSecurity(GetCurrentProcess(), 4, bytes, size, out size), "Cannot read fixture DACL");
        return new RawSecurityDescriptor(bytes, 0);
    }
    static void Server(string sid, string folder) {
        Check(WindowsIdentity.GetCurrent().IsSystem, "Fixture must run as SYSTEM");
        try {
            // Reproduce a service process inaccessible to ordinary desktop tokens.
            var strict = new RawSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;BA)");
            var bytes = new byte[strict.BinaryLength]; strict.GetBinaryForm(bytes, 0);
            Check(SetKernelObjectSecurity(GetCurrentProcess(), 4, bytes), "Cannot set fixture DACL");
            var before = ReadAcl();
            Save(Path.Combine(folder, "ready.json"), new { pid = Process.GetCurrentProcess().Id, system = true });
            var clock = Stopwatch.StartNew();
            while (!File.Exists(Path.Combine(folder, "grant"))) {
                Check(clock.ElapsedMilliseconds < 45000, "Grant signal timed out"); Thread.Sleep(25);
            }
            ClipRelay.Remote.ServiceProcessAccess.AllowOperatorReadHandle(sid);
            var after = ReadAcl();
            Check(after.DiscretionaryAcl.Count == before.DiscretionaryAcl.Count + 1, "Unexpected ACE count");
            for (int i = 0; i < before.DiscretionaryAcl.Count; i++)
                Check(before.DiscretionaryAcl[i].Equals(after.DiscretionaryAcl[i]), "Existing process ACE changed");
            var added = (CommonAce)after.DiscretionaryAcl[after.DiscretionaryAcl.Count - 1];
            Check(added.SecurityIdentifier.Value == sid && added.AccessMask == 0x00101000 &&
                added.AceQualifier == AceQualifier.AccessAllowed && added.AceFlags == AceFlags.None,
                "Operator grant exceeded read-only process rights");
            Save(Path.Combine(folder, "granted.json"), new { ok = true, existingAcesPreserved = true, grantedMask = "0x00101000" });
            while (!File.Exists(Path.Combine(folder, "stop"))) {
                Check(clock.ElapsedMilliseconds < 60000, "Stop signal timed out"); Thread.Sleep(25);
            }
        } catch (Exception e) { Save(Path.Combine(folder, "server-error.json"), new { error = e.Message }); throw; }
    }
    static void Client(uint pid, string output) {
        var adminSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        byte[] sidBytes = new byte[adminSid.BinaryLength]; adminSid.GetBinaryForm(sidBytes, 0);
        IntPtr sid = Marshal.AllocHGlobal(sidBytes.Length), token = IntPtr.Zero, restricted = IntPtr.Zero;
        Marshal.Copy(sidBytes, 0, sid, sidBytes.Length);
        bool impersonating = false;
        try {
            Check(OpenProcessToken(GetCurrentProcess(), 10, out token), "Cannot query/duplicate fixture token");
            var disabled = new SidAndAttributes { Sid = sid, Attributes = 0 };
            Check(CreateRestrictedToken(token, 1, 1, ref disabled, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted), "Cannot create restricted fixture token");
            Check(ImpersonateLoggedOnUser(restricted), "Cannot use restricted fixture token"); impersonating = true;
            bool administrator;
            Check(CheckTokenMembership(IntPtr.Zero, sid, out administrator) && !administrator, "Administrator SID remains effective");
            var rows = new List<object>();
            foreach (uint access in new uint[] { 0x00101000, 0x00001000, 0x10, 0x20, 0x1, 0x40000 }) {
                IntPtr handle = OpenProcess(access, false, pid);
                int error = handle == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
                uint exit = 0, wait = UInt32.MaxValue; bool queried = false;
                if (handle != IntPtr.Zero) {
                    try { queried = GetExitCodeProcess(handle, out exit); if (access == 0x00101000) wait = WaitForSingleObject(handle, 0); }
                    finally { CloseHandle(handle); }
                }
                rows.Add(new { access = "0x" + access.ToString("X8"), opened = handle != IntPtr.Zero, error = error, exitCodeQueried = queried, exitCode = exit, wait = wait });
            }
            Check(RevertToSelf(), "Cannot finish token impersonation"); impersonating = false;
            Save(output, new { ok = true, administratorSidDisabled = true, privilegesDisabled = true, results = rows });
        } finally {
            if (impersonating) RevertToSelf();
            if (restricted != IntPtr.Zero) CloseHandle(restricted);
            if (token != IntPtr.Zero) CloseHandle(token);
            Marshal.FreeHGlobal(sid);
        }
    }
    [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr process, uint timeout);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetKernelObjectSecurity(IntPtr handle,uint info,byte[] bytes,uint length,out uint needed);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetKernelObjectSecurity(IntPtr handle,uint info,byte[] bytes);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token,uint flags,uint disableCount,ref SidAndAttributes disabled,uint deleteCount,IntPtr deleted,uint restrictCount,IntPtr restricted,out IntPtr result);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool RevertToSelf();
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool CheckTokenMembership(IntPtr token,IntPtr sid,out bool member);
}
