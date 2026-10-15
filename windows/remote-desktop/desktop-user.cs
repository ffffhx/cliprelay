using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace ClipRelay.Remote {
    // Called by a SYSTEM helper already running in the interactive session.
    // Interactive probes inherit anonymous standard-I/O handles; standalone
    // audio recovery inherits none. No filesystem work occurs before the child
    // has inherited the desktop user's restricted token.
    internal static class DesktopUserProcess {
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
            public int cb; public string reserved, desktop, title;
            public int x, y, width, height, xc, yc, fill, flags;
            public short show, reserved2; public IntPtr reservedPtr, stdin, stdout, stderr;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
        [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime, jobTime; public uint flags; public UIntPtr minWs, maxWs; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
        [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
        [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessWithTokenW(IntPtr token,uint logonFlags,string app,StringBuilder command,uint flags,IntPtr env,string cwd,ref Startup startup,out ProcessInfo info);
        [DllImport("userenv.dll", SetLastError=true)] static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
        [DllImport("userenv.dll")] static extern bool DestroyEnvironmentBlock(IntPtr env);
        [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
        [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit limits, uint size);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);

        public static int RunFileWorker() {
            return RunWorker("--file-probe");
        }

        static int WorkerFailure(string argument,string stage) {
            if(argument=="--terminal-probe")Console.Error.WriteLine("TERMINAL_USER_WORKER "+stage+" "+Marshal.GetLastWin32Error());
            return 2;
        }

        public static int RunWorker(string argument) {
            if (argument != "--file-probe" && argument != "--clipboard-probe" && argument != "--privacy-probe" && argument != "--audio-mute-probe" && argument != "--audio-mute-recover" && argument != "--terminal-probe") throw new ArgumentException("Unknown desktop worker");
            IntPtr original = IntPtr.Zero, token = IntPtr.Zero, environment = IntPtr.Zero, job = IntPtr.Zero;
            var info = new ProcessInfo();
            try {
                uint pid; GetWindowThreadProcessId(GetShellWindow(), out pid);
                if (pid == 0) return WorkerFailure(argument,"shell");
                using (var shell = Process.GetProcessById((int)pid))
                    if (!OpenProcessToken(shell.Handle, 0x000A, out original)) return WorkerFailure(argument,"token");
                // Terminal shells must not inherit an elevated Explorer token,
                // even on installations with UAC disabled.
                if (argument == "--terminal-probe") using (var identity = new System.Security.Principal.WindowsIdentity(original))
                    if (new System.Security.Principal.WindowsPrincipal(identity).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator)) return WorkerFailure(argument,"elevated-shell");
                if (!DuplicateTokenEx(original, 0xF01FF, IntPtr.Zero, 2, 1, out token) ||
                    !CreateEnvironmentBlock(out environment, token, false)) return WorkerFailure(argument,"environment");
                bool stdio = argument != "--audio-mute-recover";
                var startup = new Startup { cb = Marshal.SizeOf(typeof(Startup)), desktop = @"winsta0\default",
                    flags = stdio ? 0x100 : 0, stdin = stdio ? GetStdHandle(-10) : IntPtr.Zero,
                    stdout = stdio ? GetStdHandle(-11) : IntPtr.Zero, stderr = stdio ? GetStdHandle(-12) : IntPtr.Zero };
                if (stdio) {
                    if (!SetHandleInformation(startup.stdin, 1, 1) || !SetHandleInformation(startup.stdout, 1, 1)) return WorkerFailure(argument,"stdio");
                    if (!SetHandleInformation(startup.stderr, 1, 1)) startup.stderr = startup.stdout;
                }
                // A timed-out probe must not leave an orphan holding stdout open.
                // The non-inherited job handle also kills the child if this wrapper dies.
                job = CreateJobObject(IntPtr.Zero, null);
                var limits = new ExtendedLimit(); limits.basic.flags = 0x2000;
                if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) return WorkerFailure(argument,"job");
                string executable = typeof(DesktopUserProcess).Assembly.Location;
                bool created=CreateProcessAsUser(token, executable, new StringBuilder("\"" + executable + "\" " + argument),
                    IntPtr.Zero, IntPtr.Zero, stdio, 0x08000404, environment, Path.GetDirectoryName(executable), ref startup, out info);
                if(!created && argument=="--terminal-probe" && Marshal.GetLastWin32Error()==1314) {
                    // An elevated user test/development host lacks the SYSTEM
                    // primary-token assignment privilege. Use the same limited
                    // shell token, still suspended and in a kill-on-close job.
                    using(var identity=System.Security.Principal.WindowsIdentity.GetCurrent())
                    using(var shell=Process.GetProcessById((int)pid))
                        if(!identity.IsSystem && shell.SessionId==Process.GetCurrentProcess().SessionId)
                            created=CreateProcessWithTokenW(token,0,executable,new StringBuilder("\""+executable+"\" "+argument),
                                0x08000404,environment,Path.GetDirectoryName(executable),ref startup,out info);
                }
                if(!created)return WorkerFailure(argument,"create");
                if (!AssignProcessToJobObject(job, info.process) || ResumeThread(info.thread) == UInt32.MaxValue) {
                    int result=WorkerFailure(argument,"assign-resume");TerminateProcess(info.process,2);return result;
                }
                WaitForSingleObject(info.process, UInt32.MaxValue);
                uint code; return GetExitCodeProcess(info.process, out code) ? (int)code : 2;
            } finally {
                if (job != IntPtr.Zero) CloseHandle(job);
                if (info.thread != IntPtr.Zero) CloseHandle(info.thread);
                if (info.process != IntPtr.Zero) CloseHandle(info.process);
                if (environment != IntPtr.Zero) DestroyEnvironmentBlock(environment);
                if (token != IntPtr.Zero) CloseHandle(token);
                if (original != IntPtr.Zero) CloseHandle(original);
            }
        }
    }
}
