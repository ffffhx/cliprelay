using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using System.Threading;
using ClipRelay.Remote;

public static class TerminalTests {
    const string A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const string Id="1234567890abcdef1234567890abcdef";
    sealed class Fake : ITerminalProcess {
        public bool Exited{get;set;}public int ExitCode{get{return 7;}}public long WrittenSequence{get;set;}public bool Failed{get;set;}
        public bool Busy,Stopped;public int Writes;public Action<byte[]> Output;
        public byte[] LastInput;public bool LastPaste;
        public TerminalInputQueue Inputs;
        public TerminalMouseState MouseState{get{return Inputs.State();}}
        public void Mouse(TerminalMouseCommand command){Inputs.Mouse(command);}
        public bool Queue(byte[] data,long sequence,bool paste=false){if(Busy)return false;Writes++;WrittenSequence=sequence;LastInput=(byte[])data.Clone();LastPaste=paste;return true;}
        public void Resize(int columns,int rows){Inputs.Resize(columns,rows);}
        public void Dispose(){Stopped=true;Inputs.Stop();}
    }
    sealed class Fixture : IDisposable {
        public long Now=100;public readonly List<Fake> Processes=new List<Fake>();public readonly TerminalManager Manager;public string Instance;
        public Fixture(){Manager=new TerminalManager(()=>Now,(s,c,r,o)=>{var process=new Fake{Inputs=new TerminalInputQueue(()=>Now,c,r)};process.Output=bytes=>process.Inputs.Observe(bytes,o);Processes.Add(process);return process;});Sync(A,B);Instance=List(A).instance;}
        public void Sync(params string[] owners){Ok(Manager.Handle(new TerminalRequest{op="sync",owners=owners}));}
        public TerminalReply List(string owner){return Manager.Handle(new TerminalRequest{op="list",owner=owner});}
        public TerminalRequest Request(string op,string owner=A,string id=Id){return new TerminalRequest{op=op,owner=owner,id=id,instance=Instance};}
        public TerminalReply Open(string owner=A,string id=Id,long seq=1){var request=Request("open",owner,id);request.shell="cmd";request.columns=80;request.rows=24;request.sequence=seq;return Manager.Handle(request);}
        public TerminalReply Write(string text,long seq){var request=Request("write");request.data=Convert.ToBase64String(Encoding.UTF8.GetBytes(text));request.sequence=seq;return Manager.Handle(request);}
        public void Dispose(){Manager.Dispose();}
    }
    static void Assert(bool value,string message){if(!value)throw new Exception(message);}
    static void Ok(TerminalReply reply){Assert(reply.ok,"Expected success: "+reply.code);}
    static void Error(TerminalReply reply,string code){Assert(!reply.ok && reply.code==code,"Expected "+code+", got "+reply.code);}
    static void Policies() {
        using(var f=new Fixture()) {
            Error(f.List(new string('c',64)),"TERMINAL_UNPAIRED");Ok(f.Open());Ok(f.Open());Assert(f.Processes.Count==1,"duplicate open created shell");
            Ok(f.Write("echo test\r",1));Ok(f.Write("echo test\r",1));Assert(f.Processes[0].Writes==1,"duplicate input replayed");
            Error(f.Write("different\r",1),"TERMINAL_INPUT_CONFLICT");Error(f.Write("out of order\r",3),"TERMINAL_SEQUENCE");
            f.Processes[0].Busy=true;Error(f.Write("next\r",2),"TERMINAL_BUSY");f.Processes[0].Busy=false;Ok(f.Write("next\r",2));
            Assert(f.List(A).sessions[0].writtenSequence==2,"written sequence");
            Error(f.Manager.Handle(f.Request("read",B)),"TERMINAL_NOT_FOUND");Ok(f.Open(B));Assert(f.List(B).sessions.Length==1,"owner isolation");
            var stale=f.Request("write");stale.instance=new string('0',32);Error(f.Manager.Handle(stale),"TERMINAL_STALE");
            byte[] data=Encoding.UTF8.GetBytes("中文\u001b[31mred\u001b[0m");f.Processes[0].Output(data);
            var read=f.Manager.Handle(f.Request("read"));Ok(read);Assert(read.data==Convert.ToBase64String(data) && read.next==data.Length,"output bytes changed");
            var resume=f.Request("read");resume.offset=read.next;Assert(f.Manager.Handle(resume).data=="","reconnect repeated output");
            Ok(f.Manager.Handle(f.Request("close")));Assert(f.Processes[0].Stopped,"close did not stop");Ok(f.Open());Assert(f.Processes.Count==2,"closed receipt reopened shell");
            f.Now+=300001;f.Sync(A,B);Error(f.Open(),"TERMINAL_SEQUENCE");
        }
        using(var f=new Fixture()) {
            Ok(f.Open());f.Now+=20000;f.Manager.Maintain();Assert(f.Processes[0].Stopped,"authorization expiry left process");Error(f.List(A),"TERMINAL_UNPAIRED");
            f.Sync(A,B);Error(f.Open(id:new string('2',32),seq:1),"TERMINAL_SEQUENCE");
        }
        using(var f=new Fixture()) {
            Ok(f.Open());Ok(f.Open(B));f.Sync(B);Assert(f.Processes[0].Stopped && !f.Processes[1].Stopped,"revocation scope");
        }
        using(var f=new Fixture()) {
            for(int i=1;i<=4;i++)Ok(f.Open(id:i.ToString("x32"),seq:i));
            Error(f.Open(id:new string('5',32),seq:5),"TERMINAL_CAPACITY");
            f.Now+=1800000;f.Sync(A,B);Assert(f.List(A).sessions[0].state=="expired","idle session not expired");
        }
        using(var f=new Fixture()) {
            Ok(f.Open());f.Processes[0].Exited=true;f.Manager.Maintain();var session=f.List(A).sessions[0];
            Assert(session.state=="exited" && session.exitCode==7 && f.Processes[0].Stopped,"exit not retained");
        }
        using(var f=new Fixture()) {
            Ok(f.Open());Assert(f.List(A).pasteLimit==16396,"paste capability missing");
            var request=f.Request("paste");request.sequence=1;request.data=Convert.ToBase64String(Encoding.UTF8.GetBytes("\u001b[200~"+new string('x',16384)+"\u001b[201~"));
            var json=new System.Web.Script.Serialization.JavaScriptSerializer();request=TerminalManager.Parse(json.Serialize(new {op=request.op,owner=A,instance=f.Instance,id=Id,sequence=1,data=request.data}));
            f.Processes[0].Busy=true;Error(f.Manager.Handle(request),"TERMINAL_BUSY");Assert(f.Processes[0].Writes==0 && f.List(A).sessions[0].acceptedSequence==0,"busy paste accepted a prefix");
            f.Processes[0].Busy=false;Ok(f.Manager.Handle(request));Ok(f.Manager.Handle(request));
            Assert(f.Processes[0].Writes==1 && f.Processes[0].LastPaste && f.Processes[0].LastInput.Length==16396,"paste split or replayed");
            Assert(Encoding.UTF8.GetString(f.Processes[0].LastInput).EndsWith("\u001b[201~"),"paste suffix lost");
            request.data=Convert.ToBase64String(new byte[16397]);request.sequence=2;Error(f.Manager.Handle(request),"TERMINAL_BAD_REQUEST");
            Ok(f.Write("same",2));request.data=Convert.ToBase64String(Encoding.UTF8.GetBytes("same"));Error(f.Manager.Handle(request),"TERMINAL_INPUT_CONFLICT");
            request.sequence=3;Ok(f.Manager.Handle(request));Error(f.Write("same",3),"TERMINAL_INPUT_CONFLICT");
            Error(f.Write(new string('x',4097),4),"TERMINAL_BAD_REQUEST");
        }
        using(var f=new Fixture()) {
            Ok(f.Open());Assert(f.List(A).mouseProtocol==1,"mouse capability missing");f.Processes[0].Output(Encoding.UTF8.GetBytes("\u001b[?1002;1006h"));
            var request=f.Request("mouse");request.action="press";request.sequence=1;request.epoch=f.List(A).sessions[0].mouse.epoch;request.gesture=1;request.column=5;request.row=7;
            Ok(f.Manager.Handle(request));Ok(f.Manager.Handle(request));Assert(f.List(A).sessions[0].mouse.acceptedSequence==1 && f.List(A).sessions[0].acceptedSequence==0,"mouse advanced keyboard sequence");
            request.owner=B;Error(f.Manager.Handle(request),"TERMINAL_NOT_FOUND");request.owner=A;request.button=2;Error(f.Manager.Handle(request),"TERMINAL_MOUSE_CONFLICT");
            Ok(f.Manager.Handle(f.Request("close")));Assert(f.List(A).sessions[0].mouse.phase=="closed" && f.List(A).sessions[0].mouse.buttons==0,"closed mouse state retained");
        }
        var ring=new TerminalBuffer(8);ring.Append(Encoding.UTF8.GetBytes("0123456789"));long offset;bool gap;
        Assert(Encoding.UTF8.GetString(ring.Read(0,out offset,out gap))=="23456789" && offset==2 && gap,"ring gap missing");
        try{ring.Read(11,out offset,out gap);throw new Exception("future offset accepted");}catch(TerminalFault){}
        foreach(string invalid in new[]{"{}","{\"op\":\"shell\"}","{\"op\":\"list\",\"owner\":\"x\",\"command\":\"whoami\"}",
            "{\"op\":\"open\",\"columns\":\"80\"}","{\"op\":\"open\",\"columns\":999999999999}","{\"op\":\"sync\",\"owners\":[1]}"}) {
            try{TerminalManager.Parse(invalid);throw new Exception("invalid protocol accepted");}catch(TerminalFault){}
        }
        Console.WriteLine("PASS terminal policies: owner isolation, retry sequences, reconnect, close, revocation, idle/authorization expiry, bounds and exact VT bytes");
    }
    static void Native() {
        var output=new StringBuilder();var gate=new object();int pid;
        using(var process=new NativeTerminalProcess("cmd",80,24,bytes=>{lock(gate)output.Append(Encoding.UTF8.GetString(bytes));})) {
            pid=process.ProcessId;
            Assert(!process.Queue(new byte[4097],1) && !process.Queue(new byte[16397],1,true),"native size limits bypassed");
            Assert(process.Queue(Encoding.UTF8.GetBytes("echo CLIPRELAY_CONPTY_TEST\r"),1),"native input rejected");
            var clock=Stopwatch.StartNew();bool observed=false;
            while(clock.ElapsedMilliseconds<8000){lock(gate)observed=output.ToString().Contains("CLIPRELAY_CONPTY_TEST");if(observed)break;Thread.Sleep(20);}
            Assert(observed,"native output missing");process.Resize(100,30);
            Assert(process.WrittenSequence==1,"native write unconfirmed");
            Console.WriteLine("PASS real ConPTY: interactive cmd input/output, resize and write confirmation; owned shell PID "+pid);
        }
        try{using(var process=Process.GetProcessById(pid))Assert(process.HasExited,"shell survived dispose");}catch(ArgumentException){}
        Console.WriteLine("PASS native terminal cleanup: owned shell exited");
    }
    public static int Main(string[] args){try{
        AppDomain.CurrentDomain.UnhandledException+=(sender,eventArgs)=>{try{Console.Error.WriteLine("TERMINAL_TEST_UNHANDLED "+eventArgs.ExceptionObject.GetType().FullName);}catch{}};
        if(args.Length==1 && args[0]=="--pid-wait"){Console.WriteLine("TERMINAL_CHILD_PID:"+Process.GetCurrentProcess().Id);Thread.Sleep(15000);return 0;}
        if(args.Length==1 && args[0]=="--terminal-probe")return TerminalWorker.Run();
        if(args.Length==1 && args[0]=="--mouse-echo")return TerminalMouseTests.NativeEcho();
        if(args.Length==1 && args[0]=="--native"){Native();return 0;}
        Policies();TerminalMouseTests.Run();return 0;
    }catch(Exception error){Console.Error.WriteLine(error);return 1;}}
}
