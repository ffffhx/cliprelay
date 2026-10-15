using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace ClipRelay.Remote {
    public interface ITerminalProcess : IDisposable {
        bool Exited { get; }
        int ExitCode { get; }
        bool Queue(byte[] data,long sequence,bool paste=false);
        long WrittenSequence { get; }
        bool Failed { get; }
        void Resize(int columns,int rows);
    }

    // UTF-8 VT bytes stay intact. Input and output use separate threads so a
    // stopped application cannot deadlock the control protocol or ConPTY close.
    public sealed class NativeTerminalProcess : ITerminalProcess {
        [StructLayout(LayoutKind.Sequential)] struct Coord {public short x,y;public Coord(int x,int y){this.x=(short)x;this.y=(short)y;}}
        [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
            public int cb;public string reserved,desktop,title;public int x,y,width,height,xc,yc,fill,flags;
            public short show,reserved2;public IntPtr reservedPtr,stdin,stdout,stderr;
        }
        [StructLayout(LayoutKind.Sequential)] struct StartupEx {public Startup start;public IntPtr attributes;}
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr process,thread;public uint pid,tid;}
        [StructLayout(LayoutKind.Sequential)] struct BasicLimit {public long processTime,jobTime;public uint flags;public UIntPtr minWs,maxWs;public uint active;public UIntPtr affinity;public uint priority,scheduling;}
        [StructLayout(LayoutKind.Sequential)] struct IoCounters {public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes;}
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {public BasicLimit basic;public IoCounters io;public UIntPtr processMemory,jobMemory,peakProcess,peakJob;}
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,IntPtr attributes,uint size);
        [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(Coord size,IntPtr input,IntPtr output,uint flags,out IntPtr console);
        [DllImport("kernel32.dll")] static extern int ResizePseudoConsole(IntPtr console,Coord size);
        [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string executable,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref StartupEx startup,out ProcessInfo process);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job,int kind,ref ExtendedLimit limit,uint size);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
        [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
        [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
        [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
        [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] static extern bool CancelIoEx(IntPtr handle,IntPtr overlapped);
        readonly object gate=new object();
        readonly Queue<Tuple<byte[],long>> pending=new Queue<Tuple<byte[],long>>();
        readonly Action<byte[]> output;
        FileStream input,reader;
        Thread writing,reading;
        IntPtr console,process,job;
        int queued,disposed;
        long written;
        volatile bool failed;
        public int ProcessId {get;private set;}
        public bool Exited {get{return process==IntPtr.Zero || WaitForSingleObject(process,0)==0;}}
        public int ExitCode {get{uint code;return process!=IntPtr.Zero && GetExitCodeProcess(process,out code)?unchecked((int)code):-1;}}
        public long WrittenSequence {get{return Interlocked.Read(ref written);}}
        public bool Failed {get{return failed;}}
        static void Check(bool result){if(!result)throw new Win32Exception(Marshal.GetLastWin32Error());}
        static void CheckResult(int result){if(result<0)Marshal.ThrowExceptionForHR(result);}
        public NativeTerminalProcess(string shell,int columns,int rows,Action<byte[]> output) {
            if(shell!="powershell" && shell!="cmd")throw new ArgumentException("TERMINAL_BAD_REQUEST");
            if(columns<20 || columns>240 || rows<5 || rows>120)throw new ArgumentException("TERMINAL_BAD_REQUEST");
            using(var identity=WindowsIdentity.GetCurrent()) {
                if(identity.IsSystem || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                    throw new InvalidOperationException("TERMINAL_USER_REQUIRED");
            }
            this.output=output;
            IntPtr inputRead=IntPtr.Zero,inputWrite=IntPtr.Zero,outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero,attributes=IntPtr.Zero;
            bool initialized=false;
            var info=new ProcessInfo();
            try {
                Check(CreatePipe(out inputRead,out inputWrite,IntPtr.Zero,65536));
                Check(CreatePipe(out outputRead,out outputWrite,IntPtr.Zero,65536));
                CheckResult(CreatePseudoConsole(new Coord(columns,rows),inputRead,outputWrite,0,out console));
                input=new FileStream(new SafeFileHandle(inputWrite,true),FileAccess.Write,4096,false);inputWrite=IntPtr.Zero;
                reader=new FileStream(new SafeFileHandle(outputRead,true),FileAccess.Read,4096,false);outputRead=IntPtr.Zero;
                reading=new Thread(Read){IsBackground=true,Name="ClipRelay terminal output"};reading.Start();
                IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
                if(size==IntPtr.Zero)throw new IOException("TERMINAL_UNAVAILABLE");
                attributes=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(attributes,1,0,ref size));initialized=true;
                Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x00020016),console,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
                var start=new StartupEx();start.start.cb=Marshal.SizeOf(typeof(StartupEx));start.attributes=attributes;
                // Explicit null standard handles prevent Windows duplicating
                // the worker's redirected protocol pipes into a ConPTY child.
                // https://github.com/microsoft/terminal/discussions/15814
                start.start.flags=0x100;
                string executable=Path.Combine(Environment.SystemDirectory,shell=="cmd"?"cmd.exe":@"WindowsPowerShell\v1.0\powershell.exe");
                string command="\""+executable+"\""+(shell=="cmd"?" /d":" -NoLogo -NoProfile -STA");
                job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
                var limit=new ExtendedLimit();limit.basic.flags=0x2000;
                Check(SetInformationJobObject(job,9,ref limit,(uint)Marshal.SizeOf(limit)));
                Check(CreateProcess(executable,new StringBuilder(command),IntPtr.Zero,IntPtr.Zero,false,0x00080004,IntPtr.Zero,
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),ref start,out info));
                process=info.process;info.process=IntPtr.Zero;ProcessId=(int)info.pid;
                Check(AssignProcessToJobObject(job,process));Check(ResumeThread(info.thread)!=UInt32.MaxValue);
                writing=new Thread(Write){IsBackground=true,Name="ClipRelay terminal input"};writing.Start();
            } catch {if(process!=IntPtr.Zero)TerminateProcess(process,1);Dispose();throw;}
            finally {
                foreach(IntPtr handle in new[]{inputRead,inputWrite,outputRead,outputWrite,info.process,info.thread})if(handle!=IntPtr.Zero)CloseHandle(handle);
                if(initialized)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);
            }
        }
        void Read() {
            FileStream stream=reader;
            try {byte[] bytes=new byte[8192];int count;while((count=stream.Read(bytes,0,bytes.Length))>0){byte[] chunk=new byte[count];Buffer.BlockCopy(bytes,0,chunk,0,count);output(chunk);}}
            catch(Exception){if(disposed==0 && !Exited)failed=true;}
        }
        void Write() {
            try {while(true){Tuple<byte[],long> item;lock(gate){while(pending.Count==0 && disposed==0)Monitor.Wait(gate);if(disposed!=0)return;item=pending.Dequeue();}
                input.Write(item.Item1,0,item.Item1.Length);input.Flush();Interlocked.Exchange(ref written,item.Item2);lock(gate)queued-=item.Item1.Length;}}
            catch(Exception){if(disposed==0)failed=true;}
        }
        public bool Queue(byte[] data,long sequence,bool paste=false) {
            // Complete paste framing belongs to one queue item, including when
            // the client disconnects after acceptance. Reject capacity as a whole.
            lock(gate){if(disposed!=0 || failed || Exited || data.Length==0 || data.Length>(paste?16396:4096) || queued+data.Length>32768)return false;
                pending.Enqueue(Tuple.Create((byte[])data.Clone(),sequence));queued+=data.Length;Monitor.PulseAll(gate);return true;}
        }
        public void Resize(int columns,int rows){if(disposed!=0)throw new IOException("TERMINAL_CLOSED");CheckResult(ResizePseudoConsole(console,new Coord(columns,rows)));}
        public void Dispose() {
            if(Interlocked.Exchange(ref disposed,1)!=0)return;
            lock(gate){pending.Clear();Monitor.PulseAll(gate);}
            if(job!=IntPtr.Zero)TerminateJobObject(job,0);
            if(console!=IntPtr.Zero){
                IntPtr handle=console;console=IntPtr.Zero;
                // Older Windows waits synchronously for ConPTY output to drain.
                // Keep the reader alive during close; if teardown stalls, close
                // its pipe as documented instead of hanging the control worker.
                var closing=new Thread(()=>{try{ClosePseudoConsole(handle);}catch{failed=true;}}){IsBackground=true};closing.Start();
                if(!closing.Join(1000)){
                    if(reader!=null){CancelIoEx(reader.SafeFileHandle.DangerousGetHandle(),IntPtr.Zero);reader.Dispose();reader=null;}
                    closing.Join(1000);
                }
            }
            if(input!=null){CancelIoEx(input.SafeFileHandle.DangerousGetHandle(),IntPtr.Zero);input.Dispose();}
            if(writing!=null)writing.Join(1000);
            if(reader!=null){if(reading!=null && !reading.Join(1000))CancelIoEx(reader.SafeFileHandle.DangerousGetHandle(),IntPtr.Zero);reader.Dispose();}
            if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}
            if(process!=IntPtr.Zero){CloseHandle(process);process=IntPtr.Zero;}
        }
    }
}
