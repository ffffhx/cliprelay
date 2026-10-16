using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using ClipRelay.Remote;

class HostPairingTests {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string Id = new string('a',32), Generation = new string('b',32), Code = "1234 ABCD 5678";
    static void Check(bool value, string reason) { if (!value) throw new Exception(reason); }
    static Dictionary<string, object> Parse(string text) { return Json.Deserialize<Dictionary<string, object>>(text); }
    static Dictionary<string, object> Entry() { return new Dictionary<string, object> { {"id",Id},{"generation",Generation},{"name","fixture phone"},{"verification",Code},{"expires",1120},{"state","waiting"} }; }
    static Dictionary<string, object> ListReply(params Dictionary<string, object>[] entries) { return Parse(Json.Serialize(new { protocol=1,ok=true,requests=entries })); }
    static Dictionary<string, object> Decision(bool approve) { return new Dictionary<string, object> { {"action",approve?"lanPairApprove":"lanPairReject"},{"id",Id},{"generation",Generation},{"verification",Code} }; }
    static void Fails(Action action, string contains) {
        try { action(); } catch (Exception error) { Check(error.Message.Contains(contains),"Unexpected failure: "+error.Message);return; }
        throw new Exception("Invalid operation succeeded");
    }
    static void Lists() {
        var entry=Entry();var list=LanPairingControl.List(command=>{Check(Json.Serialize(command)=="{\"op\":\"host-pair-list\"}","Unexpected list command");return ListReply(entry);},1000);
        Check(list.Count==1 && (string)list[0]["generation"]==Generation && (string)list[0]["address"]==Code && (bool)list[0]["automatic"],"List lost current identity");
        entry["state"]="approving";Check((string)LanPairingControl.List(command=>ListReply(entry),1000)[0]["state"]=="approving","Approval state lost");
        entry["expires"]=1000;Check(LanPairingControl.List(command=>ListReply(entry),1000).Count==0,"Expired request visible");
    }
    static void InvalidLists() {
        foreach(string field in new[]{"id","generation","name","verification","expires","state","extra"}) {
            var entry=Entry();entry[field]=field=="expires"?(object)"1120":field=="name"?"bad\nname":"bad";
            Fails(()=>LanPairingControl.List(command=>ListReply(entry),1000),"无法确认");
        }
        Fails(()=>LanPairingControl.List(command=>ListReply(Entry(),Entry()),1000),"无法确认");
        var future=Entry();future["expires"]=1126;Fails(()=>LanPairingControl.List(command=>ListReply(future),1000),"无法确认");
        foreach(string reply in new[]{"{\"protocol\":\"1\",\"ok\":true,\"requests\":[]}","{\"protocol\":1,\"ok\":\"true\",\"requests\":[]}","{\"protocol\":1,\"ok\":true,\"requests\":[],\"private\":1}"})
            Fails(()=>LanPairingControl.List(command=>Parse(reply),1000),"无法确认");
    }
    static void Decisions() {
        foreach(bool approve in new[]{true,false}) {
            int calls=0;
            LanPairingControl.Decide(Decision(approve),approve,command=>{
                calls++;Check(command.Count==4 && (string)command["op"]==(approve?"host-pair-approve":"host-pair-reject") &&
                    (string)command["id"]==Id && (string)command["generation"]==Generation && (string)command["verification"]==Code,"Decision lost generation/code");
                return Parse("{\"protocol\":1,\"ok\":true}");
            });Check(calls==1,"Decision replayed");
        }
        foreach(string field in new[]{"id","generation","verification","action","extra"}) {
            var decision=Decision(true);decision[field]="bad";int calls=0;
            Fails(()=>LanPairingControl.Decide(decision,true,command=>{calls++;return null;}),"无法确认");Check(calls==0,"Invalid decision reached pipe");
        }
        int attempts=0;
        Fails(()=>LanPairingControl.Decide(Decision(true),true,command=>{attempts++;throw new IOException("lost reply");}),"lost reply");
        Check(attempts==1,"Lost mutation replayed");
        Fails(()=>LanPairingControl.Decide(Decision(true),true,command=>Parse("{\"protocol\":1,\"ok\":false,\"code\":\"HOST_PAIR_STALE\"}")),"已改变");
        Fails(()=>LanPairingControl.Decide(Decision(false),false,command=>Parse("{\"protocol\":1,\"ok\":false,\"code\":\"untrusted private text\"}")),"无法确认");
        Fails(()=>LanPairingControl.Decide(Decision(true),true,command=>Parse("{\"protocol\":1,\"ok\":true,\"requests\":[]}")),"无法确认");
    }
    static void PipeIdentity(bool wrongIdentity) {
        string name="ClipRelay.Test.Pairing."+Guid.NewGuid().ToString("N");int received=-1;Exception failure=null;
        using(var server=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous))
        using(var current=Process.GetCurrentProcess()) {
            Process other=null;
            if(wrongIdentity) other=Process.Start(new ProcessStartInfo(typeof(HostPairingTests).Assembly.Location,"--idle") {UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true});
            var worker=new Thread(()=>{try {
                server.WaitForConnection();var buffer=new MemoryStream();int ch;
                while((ch=server.ReadByte())>=0 && ch!=10)buffer.WriteByte((byte)ch);received=(int)buffer.Length;
                if(received>0) {Check(Encoding.UTF8.GetString(buffer.ToArray())=="{\"op\":\"host-pair-list\"}","Unexpected pipe payload");var bytes=Encoding.UTF8.GetBytes("{\"protocol\":1,\"ok\":true,\"requests\":[]}\n");server.Write(bytes,0,bytes.Length);}
            }catch(Exception error){failure=error;}});worker.IsBackground=true;worker.Start();
            bool accepted=false;
            try {RelayIpc.RequestPairing(new Dictionary<string,object>{{"op","host-pair-list"}},other??current,name,2000);accepted=true;}
            catch(IOException){}
            finally {if(other!=null){other.StandardInput.WriteLine();if(!other.WaitForExit(2000))other.Kill();other.Dispose();}}
            Check(worker.Join(3000) && failure==null && accepted!=wrongIdentity && (wrongIdentity?received==0:received>0),"Pairing pipe accepted wrong process or leaked payload");
        }
    }
    static void SeparatedRoutesAndTimeout() {
        using(var current=Process.GetCurrentProcess()) {
            Fails(()=>RelayIpc.Request(new Dictionary<string,object>{{"op","host-pair-list"}},current),"RELAY_BAD_REQUEST");
            Fails(()=>RelayIpc.RequestPairing(new Dictionary<string,object>{{"op","peers"}},current),"无法确认");
            Fails(()=>RelayIpc.RequestPairing(new Dictionary<string,object>{{"op","host-pair-list"},{"private",true}},current),"无法确认");
            string name="ClipRelay.Test.Pairing."+Guid.NewGuid().ToString("N");
            using(var server=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous)) {
                var connection=server.WaitForConnectionAsync();var clock=Stopwatch.StartNew();
                Fails(()=>RelayIpc.RequestPairing(new Dictionary<string,object>{{"op","host-pair-list"}},current,name,200),"RELAY_");
                Check(clock.ElapsedMilliseconds<2000 && connection.IsCompleted,"Pairing pipe exceeded deadline");
            }
        }
    }
    static int Main(string[] args) {
        if(args.Length==1 && args[0]=="--idle"){Console.ReadLine();return 0;}
        try {Lists();InvalidLists();Decisions();PipeIdentity(false);PipeIdentity(true);SeparatedRoutesAndTimeout();Console.WriteLine("PASS: 6 managed host pairing/real pipe scenarios");return 0;}
        catch(Exception error){Console.Error.WriteLine(error);return 1;}
    }
}
