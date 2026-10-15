using System;
using System.Text;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using ClipRelay.Remote;

public static class TerminalMouseTests {
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetConsoleMode(IntPtr handle,out uint mode);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetConsoleMode(IntPtr handle,uint mode);
    public static int NativeEcho(){
        IntPtr input=GetStdHandle(-10);uint original;Assert(GetConsoleMode(input,out original),"input console missing");
        Assert(SetConsoleMode(input,(original & ~7u)|0x210),"VT input mode failed");
        var bytes=new MemoryStream();var gate=new object();var clock=Stopwatch.StartNew();
        try{
            Console.OutputEncoding=new UTF8Encoding(false);Console.Write("\u001b[?1002;1006hMOUSE_READY\r\n");Console.Out.Flush();
            new Thread(()=>{try{var stream=Console.OpenStandardInput();byte[] buffer=new byte[256];int count;while((count=stream.Read(buffer,0,buffer.Length))>0)lock(gate)bytes.Write(buffer,0,count);}catch{}}){IsBackground=true}.Start();
            bool release=false;while(clock.ElapsedMilliseconds<8000){lock(gate)release=Encoding.UTF8.GetString(bytes.ToArray()).Contains("m");if(release)break;Thread.Sleep(10);}
            byte[] captured;lock(gate)captured=bytes.ToArray();Console.Write("\u001b[?1002;1006l\r\nMOUSE_CAPTURE:"+Convert.ToBase64String(captured)+"\r\n");Console.Out.Flush();return release?0:2;
        }finally{SetConsoleMode(input,original);}
    }
    static void Assert(bool value,string message){if(!value)throw new Exception(message);}
    static void Error(Action action,string code){try{action();throw new Exception("Expected "+code);}catch(TerminalFault e){Assert(e.Message==code,e.Message);}}
    static void Check(string name,Action action){action();Console.WriteLine("PASS terminal mouse: "+name);}
    sealed class Fixture {
        public long Now=100;public TerminalInputQueue Queue;
        public Fixture(){Queue=new TerminalInputQueue(()=>Now,100,30);Output("\u001b[?1002;1006h");}
        public void Output(string text){Queue.Observe(Encoding.UTF8.GetBytes(text),bytes=>{});}
        public TerminalMouseCommand Command(long sequence,string action,int button=0,int column=5,int row=7,long gesture=1,int modifiers=0){bool control=action=="renew" || action=="cancel";return new TerminalMouseCommand{sequence=sequence,action=action,epoch=Queue.State().epoch,gesture=gesture,column=control?0:column,row=control?0:row,button=control?0:button,modifiers=control?0:modifiers};}
        public void Send(long sequence,string action,int button=0,int column=5,int row=7,long gesture=1,int modifiers=0){Queue.Mouse(Command(sequence,action,button,column,row,gesture,modifiers));}
        public string Write(){var item=Queue.Begin();Assert(item!=null,"expected queued input");string result=Encoding.UTF8.GetString(item.Bytes);Queue.Complete(item);return result;}
    }
    public static void Run(){
        Check("VT strings and multibyte text cannot forge mouse modes,including split controls",()=>{
            var modes=new TerminalMouseModes();string hidden="\u001b]title\u001b[?1000h\a\u001bP1;2|\a\u001b[?1003h\u001b\\\u001b_\u001b[?1002h\u001b\\\u001b^\u001b[?1000h\u001b\\\u001bX\u001b[?1000h\u001b\\\u061b?1000h";
            foreach(byte b in Encoding.UTF8.GetBytes(hidden))modes.Feed(new[]{b});Assert(modes.Mode==0 && modes.Epoch==1,"string or UTF-8 content changed mode");
            foreach(byte b in Encoding.UTF8.GetBytes("\u009b?1002;1006h"))modes.Feed(new[]{b});Assert(modes.Mode==1002 && modes.Format==1006 && modes.ChangedAt==modes.Offset,"split C1 CSI not observed");
            modes.Feed(Encoding.UTF8.GetBytes("\u009d\u001b[?1000l\u009c"));Assert(modes.Mode==1002,"C1 OSC contents escaped");
        });
        Check("mode ordering,save restore,reset and parser overflow remain bounded",()=>{
            var modes=new TerminalMouseModes();Action<string> feed=s=>modes.Feed(Encoding.UTF8.GetBytes(s));feed("\u001b[?1002;1006h\u001b[!p");Assert(modes.Mode==1002 && modes.Format==1006,"DECSTR reset mouse tracking");
            feed("\u001b[?1002;1006s\u001b[?1000l\u001b[?1006l\u001b[?1002;1006r");Assert(modes.Mode==1002 && modes.Format==1006,"private save restore");
            feed("\u001b[?1000;h");Assert(modes.Mode==1000,"empty private parameter");feed("\u001b[?"+new string('1',300)+"h");Assert(modes.Mode==-1 && modes.Format==-1,"overflow retained stale mode");
            feed("\u001bc\u001b[?1003h\u001b[?1016h");Assert(modes.Mode==1003 && modes.Format==1016,"reset recovery");
            feed("\u001b[?1001h");Assert(!modes.Enabled,"unsupported highlight mode accepted as dragging");
        });
        Check("right middle modifiers,drag,hover,wheel and extended coordinates encode correctly",()=>{
            Func<int,int,string,int,int,int,int,byte[]> enc=TerminalMouseEncoding.Encode;
            Assert(Encoding.ASCII.GetString(enc(1002,1006,"press",2,28,5,7))=="\u001b[<30;5;7M","right modifiers");
            Assert(Encoding.ASCII.GetString(enc(1002,1006,"move",2,16,6,8))=="\u001b[<50;6;8M","drag");
            Assert(Encoding.ASCII.GetString(enc(1003,1016,"move",3,0,1234,567))=="\u001b[<35;1234;567M","pixel hover");
            Assert(Encoding.ASCII.GetString(enc(1000,1006,"release",1,8,5,7))=="\u001b[<9;5;7m","middle release");
            Assert(Encoding.ASCII.GetString(enc(1000,1015,"wheel",3,4,5,7))=="\u001b[103;5;7M","horizontal wheel");
            Assert(Convert.ToBase64String(enc(1000,1005,"press",0,0,240,7))==Convert.ToBase64String(new byte[]{27,91,77,32,196,144,39}),"UTF-8 coordinates");
            Assert(Convert.ToBase64String(enc(9,0,"press",2,28,5,7))==Convert.ToBase64String(new byte[]{27,91,77,34,37,39}),"X10 modifiers");
            Error(()=>enc(1000,0,"press",0,0,224,7),"TERMINAL_BAD_REQUEST");Error(()=>enc(1000,1006,"move",0,0,5,7),"TERMINAL_MOUSE_MODE");Error(()=>enc(9,0,"release",0,0,5,7),"TERMINAL_MOUSE_MODE");
        });
        Check("queued press expires before a blocked keyboard prefix and can never be sent later",()=>{
            var f=new Fixture();for(int n=1;n<=8;n++)Assert(f.Queue.Queue(new byte[4096],n,false),"raw capacity");Assert(!f.Queue.Queue(new byte[1],9,false),"raw queue unbounded");
            f.Send(1,"press");f.Now+=1500;Assert(f.Queue.State().outcome=="expired","queued press not expired");
            for(int n=1;n<=8;n++){var item=f.Queue.Begin();Assert(!item.Mouse,"late press escaped expiry");f.Queue.Complete(item);}Assert(f.Queue.Begin()==null && f.Queue.State().writtenSequence==0,"expired press written");
        });
        Check("written drag is released on expiry and exact retry cannot renew or reactivate it",()=>{
            var f=new Fixture();f.Send(1,"press");Assert(f.Write()=="\u001b[<0;5;7M","press bytes");var move=f.Command(2,"move",0,6,8);f.Queue.Mouse(move);Assert(f.Write()=="\u001b[<32;6;8M","move bytes");
            f.Now+=1500;Assert(f.Queue.State().phase=="expired","drag not expired");Assert(f.Write()=="\u001b[<0;6;8m","expiry release");Assert(f.Queue.State().buttons==0 && f.Queue.State().writtenSequence==2,"cleanup forged write receipt");
            f.Queue.Mouse(move);Assert(f.Queue.State().remainingMs==0,"replay renewed deadline");Error(()=>f.Send(3,"renew"),"TERMINAL_MOUSE_GESTURE");f.Send(3,"press",gesture:2);Assert(f.Queue.State().gesture==2,"new gesture refused");
        });
        Check("lost press receipt and renew replay do not extend the lease",()=>{
            var f=new Fixture();var press=f.Command(1,"press");f.Queue.Mouse(press);f.Write();f.Now+=1000;f.Queue.Mouse(press);Assert(f.Queue.State().remainingMs==500,"press replay extended lease");
            var renew=f.Command(2,"renew");f.Queue.Mouse(renew);f.Now+=1400;f.Queue.Mouse(renew);Assert(f.Queue.State().remainingMs==100,"renew replay extended lease");f.Now+=100;Assert(f.Queue.State().phase=="expired","renew never expired");
            Error(()=>f.Send(3,"press",gesture:1),"TERMINAL_BUSY");f.Write();Error(()=>f.Send(3,"press",gesture:1),"TERMINAL_MOUSE_GESTURE");
        });
        Check("cancellation has reserved capacity and releases before saturated ordinary input",()=>{
            var f=new Fixture();f.Send(1,"press");f.Write();for(int n=1;n<=8;n++)Assert(f.Queue.Queue(new byte[4096],n,false),"raw capacity");for(int n=2;n<=65;n++)f.Send(n,"move");
            Error(()=>f.Send(66,"move"),"TERMINAL_BUSY");Assert(f.Queue.State().acceptedSequence==65,"busy advanced sequence");f.Send(66,"cancel");Assert(f.Write()=="\u001b[<0;5;7m","cleanup did not precede keyboard");
            Assert(f.Queue.State().acceptedSequence==66 && f.Queue.State().writtenSequence==1 && f.Queue.State().buttons==0,"cancel receipt dishonest");Assert(!f.Queue.Begin().Mouse,"cancelled move survived");
        });
        Check("expiry during an in-flight press releases immediately after write completion",()=>{
            var f=new Fixture();f.Send(1,"press");var item=f.Queue.Begin();f.Now+=1600;Assert(f.Queue.State().phase=="expired" && f.Queue.State().buttons==0,"in-flight accepted confused with written");f.Queue.Complete(item);
            Assert(f.Queue.State().buttons==1,"late native press not tracked");Assert(f.Write()=="\u001b[<0;5;7m","in-flight expiry cleanup");Assert(f.Queue.State().buttons==0,"cleanup left held state");
        });
        Check("stalled uncertain writes require worker teardown instead of claiming release",()=>{
            var f=new Fixture();f.Send(1,"press");f.Queue.Begin();f.Now+=5001;Assert(f.Queue.AbortRequired,"stalled mouse write not bounded");Assert(f.Queue.State().writtenSequence==0 && f.Queue.Begin()==null,"failed queue continued");Error(()=>f.Send(2,"renew"),"TERMINAL_CLOSED");
        });
        Check("mode changes cancel old events without injecting an obsolete release into the shell",()=>{
            var f=new Fixture();var old=f.Command(2,"move");f.Send(1,"press");f.Write();f.Queue.Mouse(old);f.Output("\u001b[?1002l");Assert(f.Queue.Begin()==null && f.Queue.State().buttons==0,"release leaked after mouse mode disabled");
            Error(()=>f.Queue.Mouse(f.Command(3,"renew")),"TERMINAL_MOUSE_GESTURE");old.sequence=3;Error(()=>f.Queue.Mouse(old),"TERMINAL_MOUSE_MODE");
            f.Output("\u001b[?1003h");f.Send(3,"press",gesture:2);Assert(f.Write()=="\u001b[<0;5;7M","new mode gesture");
        });
        Check("resize invalidates stale coordinates and cleans an already-started press",()=>{
            var f=new Fixture();var old=f.Command(1,"press",0,90,25);f.Queue.Mouse(old);var item=f.Queue.Begin();f.Queue.Resize(20,10);f.Queue.Complete(item);Assert(f.Write()=="\u001b[<0;20;10m","resize cleanup coordinates");
            old.sequence=2;Error(()=>f.Queue.Mouse(old),"TERMINAL_MOUSE_MODE");Assert(f.Queue.State().buttons==0,"resized press held");
        });
        Check("simultaneous left/right buttons retain independent release modifiers",()=>{
            var f=new Fixture();f.Send(1,"press",modifiers:4);f.Write();f.Send(2,"press",button:2,modifiers:16);f.Write();f.Send(3,"move",button:2,column:6,row:8,modifiers:16);f.Write();f.Send(4,"cancel");
            Assert(f.Write()=="\u001b[<4;5;7m\u001b[<18;6;8m","multibutton release changed identity");Assert(f.Queue.State().buttons==0,"multibutton cleanup incomplete");
        });
        Check("resize after a mode change cannot reassign an old in-flight press to the new mode",()=>{
            var f=new Fixture();f.Send(1,"press");var item=f.Queue.Begin();f.Output("\u001b[?1003h");f.Queue.Resize(80,20);f.Queue.Complete(item);
            Assert(f.Queue.State().buttons==0 && f.Queue.Begin()==null,"resize resurrected an obsolete mouse press");
            f.Send(2,"press",gesture:2);Assert(f.Write()=="\u001b[<0;5;7M","new gesture after mode change and resize failed");
        });
        Check("release acknowledgment completes before a new gesture can reuse the queue",()=>{
            var f=new Fixture();f.Send(1,"press");f.Send(2,"release");Error(()=>f.Send(3,"press",gesture:2),"TERMINAL_BUSY");f.Write();f.Write();f.Send(3,"press",gesture:2);f.Write();Assert(f.Queue.State().gesture==2 && f.Queue.State().buttons==1,"new gesture failed");
        });
        Check("stop during a native write never resurrects held state",()=>{var f=new Fixture();f.Send(1,"press");var item=f.Queue.Begin();f.Queue.Stop();f.Queue.Complete(item);Assert(f.Queue.State().phase=="closed" && f.Queue.State().buttons==0,"closed process resurrected buttons");});
    }
}
