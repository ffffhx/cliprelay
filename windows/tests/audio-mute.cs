using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using ClipRelay.Remote;

public static class AudioMuteTests {
    sealed class Access : IAudioMuteAccess {
        public Dictionary<string,bool> values=new Dictionary<string,bool>{{"speakers",false},{"headphones",true}};
        public HashSet<string> missing=new HashSet<string>();
        public Dictionary<string,bool> changed=new Dictionary<string,bool>();
        public string failMute="",persist;
        public int writes;
        public bool ReadMute(string id) {if(missing.Contains(id))throw new IOException("unplugged");return values[id];}
        public void SetMute(string id,bool value) {writes++;values[id]=value;if(persist!=null)File.WriteAllText(persist,Json.Serialize(values));if(id==failMute && value)throw new IOException("after-write failure");}
        public void Watch(string id) {}
        public AudioMuteChange[] ExternalChanges() {var result=new List<AudioMuteChange>();foreach(var pair in changed)result.Add(new AudioMuteChange {Endpoint=pair.Key,Muted=pair.Value});changed.Clear();return result.ToArray();}
        public void StopWatching() {}
        public void Dispose() {}
    }
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    static readonly string A=new string('a',32),B=new string('b',32);
    static void Assert(bool good,string message) {if(!good)throw new Exception(message);}
    static void Reject(Action action) {try{action();}catch{return;}throw new Exception("expected rejection");}
    [STAThread] public static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);
        try {
            if(args.Length==1 && args[0]=="--audio-mute-recover")return AudioMuteRecovery.Run();
            if(args.Length==1 && args[0]=="--audio-mute-probe")return AudioMuteProbe.Run(()=>true);
            if(args.Length==1 && args[0]=="--native-readonly") {using(var access=new WindowsAudioMuteAccess())Console.WriteLine(Json.Serialize(access.Endpoints()));return 0;}
            if(args.Length==3 && args[0]=="--native-virtual")return Native(args[1],args[2]);
            if(args.Length==2 && args[0]=="--crash-writer") {
                var access=new Access {persist=Path.Combine(args[1],"state.json")};
                var lease=new AudioMuteLease(access,()=>0,Path.Combine(args[1],"recovery.json"));
                lease.Start(A,new[]{"speakers","headphones"});
                Environment.Exit(0);return 2; // Deliberately bypass Dispose, like process termination.
            }
            string root=Path.Combine(Path.GetTempPath(),"cliprelay-audio-mute-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
            long now=0;int tests=0;
            var fake=new Access();string path=Path.Combine(root,"lease.json");
            using(var lease=new AudioMuteLease(fake,()=>now,path)) {
                Assert(fake.writes==0,"construction changed sound");lease.Start(A,new[]{"speakers","headphones"});
                Assert(fake.values["speakers"] && File.Exists(path),"mute/journal missing");lease.Stop(A);
                Assert(!fake.values["speakers"] && fake.values["headphones"] && !File.Exists(path),"original state not restored");tests++;
                lease.Start(A,new[]{"speakers"});now=15000;lease.Tick();Assert(lease.Lease=="" && !fake.values["speakers"],"expiry");Reject(()=>lease.Renew(A));tests++;
                lease.Start(B,new[]{"speakers"});now+=10000;lease.Renew(B);now+=10000;lease.Tick();Assert(fake.values["speakers"],"renew failed");
                Reject(()=>lease.Stop(A));lease.Stop(B);tests++;
                lease.Start(A,new[]{"speakers","headphones"});fake.values["headphones"]=false;fake.changed["headphones"]=false;lease.Tick();
                Assert(!fake.values["speakers"] && !fake.values["headphones"] && lease.Lease=="","manual unmute overwritten");tests++;
                lease.Start(A,new[]{"speakers"});fake.values["speakers"]=true;fake.changed["speakers"]=true;lease.Tick();
                Assert(fake.values["speakers"] && !File.Exists(path),"observed manual mute overwritten");fake.values["speakers"]=false;tests++;
                lease.Start(A,new[]{"speakers"});fake.changed["speakers"]=false;lease.Tick();Assert(!fake.values["speakers"] && lease.Lease=="","late manual callback lost its value");tests++;
                lease.Start(A,new[]{"speakers"});fake.missing.Add("speakers");lease.Stop(A);Assert(lease.PendingRecovery && File.Exists(path),"unplugged recovery lost");
                Reject(()=>lease.Start(B,new[]{"headphones"}));fake.missing.Clear();lease.Tick();Assert(!fake.values["speakers"] && !lease.PendingRecovery && !File.Exists(path),"replug restore");tests++;
                fake.failMute="headphones";Reject(()=>lease.Start(A,new[]{"speakers","headphones"}));Assert(!fake.values["speakers"] && !fake.values["headphones"],"partial-write rollback");fake.failMute="";tests++;
                Reject(()=>lease.Start("bad",new[]{"speakers"}));Reject(()=>lease.Start(A,new[]{"speakers","speakers"}));Reject(()=>lease.Start(A,new string[0]));tests++;
                lease.Start(A,new[]{"speakers"});
                using(var busy=new FileStream(path,FileMode.Open,FileAccess.ReadWrite,FileShare.None)) {
                    lease.Stop(A);Assert(!fake.values["speakers"] && lease.PendingRecovery,"failed journal removal lost pending state");
                }
                lease.Tick();Assert(!lease.PendingRecovery && !File.Exists(path),"journal cleanup not retried");tests++;
                lease.Start(A,new[]{"speakers"});fake.changed["speakers"]=true;
                using(var busy=new FileStream(path,FileMode.Open,FileAccess.ReadWrite,FileShare.None)) {
                    lease.Tick();Assert(fake.values["speakers"] && lease.PendingRecovery,"busy journal lost manual override");
                }
                lease.Tick();Assert(fake.values["speakers"] && !lease.PendingRecovery && !File.Exists(path),"override retry restored obsolete state");fake.values["speakers"]=false;tests++;
                lease.Start(A,new[]{"speakers"});
            }
            Assert(!fake.values["speakers"],"Dispose left muted");tests++;
            string corrupt=Path.Combine(root,"corrupt.json");File.WriteAllText(corrupt,"{bad");int writes=fake.writes;
            Reject(()=>{using(var lease=new AudioMuteLease(fake,()=>0,corrupt)){} });Assert(fake.writes==writes,"corrupt journal changed audio");tests++;
            string crash=Path.Combine(root,"crash");Directory.CreateDirectory(crash);
            var start=new ProcessStartInfo {FileName=typeof(AudioMuteTests).Assembly.Location,Arguments="--crash-writer \""+crash+"\"",UseShellExecute=false,CreateNoWindow=true};
            using(var child=Process.Start(start)){if(!child.WaitForExit(5000)){child.Kill();throw new Exception("crash fixture timed out");}Assert(child.ExitCode==0,"crash fixture failed");}
            fake=new Access {values=Json.Deserialize<Dictionary<string,bool>>(File.ReadAllText(Path.Combine(crash,"state.json")))};
            Assert(fake.values["speakers"] && File.Exists(Path.Combine(crash,"recovery.json")),"crash fixture didn't persist");
            using(var lease=new AudioMuteLease(fake,()=>0,Path.Combine(crash,"recovery.json"))) {Assert(!fake.values["speakers"] && fake.values["headphones"] && !lease.PendingRecovery,"restart recovery");}tests++;
            string gatePath=Path.Combine(root,"gate.json");using(var first=new AudioMuteLease(fake,()=>0,gatePath)) {Reject(()=>{using(var second=new AudioMuteLease(fake,()=>0,gatePath)){} });}tests++;
            now=0;var schedule=new AudioMuteRecoverySchedule(()=>now);int attempts=0;
            Func<uint,bool> absent=session=>{attempts++;return false;};
            schedule.Observe(1);schedule.Tick(1,absent);schedule.Tick(1,absent);now=29999;schedule.Tick(1,absent);
            Assert(attempts==1,"recovery busy loop");now=30000;schedule.Tick(1,session=>{attempts++;return true;});now=89999;schedule.Tick(1,absent);
            Assert(attempts==2,"successful audit repeated too soon");now=90000;schedule.Tick(1,absent);
            Assert(attempts==3,"new crash journal not audited after earlier success");tests++;
            schedule.Observe(uint.MaxValue);schedule.Tick(uint.MaxValue,absent);schedule.Observe(0);schedule.Tick(0,absent);
            schedule.Observe(2);schedule.Tick(1,absent);schedule.Tick(2,session=>{Assert(session==2,"recovery crossed sessions");attempts++;throw new IOException("desktop not ready");});
            schedule.Tick(2,absent);Assert(attempts==4,"launch exception not throttled");now+=30000;schedule.Tick(2,session=>{attempts++;return true;});tests++;
            schedule.Request(1);schedule.Tick(1,session=>{attempts++;return true;});schedule.Request(1);schedule.Tick(1,session=>{attempts++;return true;});
            Assert(attempts==7,"focus exit or new login did not rearm recovery");tests++;
            tests+=Session(root);
            Console.WriteLine("PASS audio-mute: "+tests+" lifecycle/recovery scenarios including actual fixture process exit; fake endpoints");return 0;
        } catch(Exception e){Console.Error.WriteLine(e);return 1;}
    }
    static Dictionary<string,object> SessionCall(AudioMuteSession session,string op,string lease="") {
        var request=new Dictionary<string,object>{{"op",op}};if(lease!="")request["lease"]=lease;
        return Json.Deserialize<Dictionary<string,object>>(Json.Serialize(session.Handle(request)));
    }
    static int Session(string root) {
        var fake=new Access();fake.values["voice"]=false;fake.values["cable"]=false;
        long now=0;bool interactive=true;
        var devices=new[]{new AudioEndpointInfo {Id="speakers",Name="Real speakers",Default=true},new AudioEndpointInfo {Id="headphones",Name="Headphones"},
            new AudioEndpointInfo {Id="voice",Name="Speakers (Steam Streaming Microphone)"},new AudioEndpointInfo {Id="cable",Name="CABLE Input (VB-Audio Virtual Cable)"}};
        using(var lease=new AudioMuteLease(fake,()=>now,Path.Combine(root,"session.json"))) {
            var session=new AudioMuteSession(lease,()=>devices,()=>interactive);
            var status=SessionCall(session,"status");Assert((bool)status["supported"] && !(bool)status["active"] && (int)status["outputs"]==2 && fake.writes==0,"status or voice-feed classification");
            var start=SessionCall(session,"start",A);Assert((bool)start["active"] && fake.values["speakers"] && fake.values["headphones"] && !fake.values["voice"] && !fake.values["cable"],"session target policy");
            Assert(!Json.Serialize(start).Contains("speakers") && (int)start["expiresMs"]==15000,"worker exposes identifiers or wrong expiry");
            Assert(!(bool)SessionCall(session,"stop",B)["ok"] && lease.Lease==A,"foreign token stopped mute");
            now=10000;SessionCall(session,"start",A);now=20000;session.Tick();Assert(lease.Lease==A,"duplicate active start didn't renew");SessionCall(session,"stop",A);
            Assert(!fake.values["speakers"] && fake.values["headphones"],"session stop lost original values");
            SessionCall(session,"start",A);devices[0].Default=false;devices[1].Default=true;session.Tick();Assert(lease.Lease=="" && !fake.values["speakers"],"default-device change didn't restore");
            SessionCall(session,"start",B);var old=devices;devices=new[]{old[0],old[1],old[2],old[3],new AudioEndpointInfo {Id="usb",Name="USB speakers"}};fake.values["usb"]=false;
            session.Tick();Assert(lease.Lease=="" && !fake.values["speakers"] && !fake.values["usb"],"hotplug reacquired mute");
            SessionCall(session,"start",A);interactive=false;session.Tick();Assert(lease.Lease=="" && !(bool)SessionCall(session,"start",B)["ok"],"locked desktop kept or acquired mute");interactive=true;
            SessionCall(session,"start",A);now+=15000;session.Tick();Assert(lease.Lease=="" && !fake.values["speakers"],"session expiry needs client traffic");
            SessionCall(session,"start",A);fake.missing.Add("speakers");session.Tick();status=SessionCall(session,"status");Assert(!(bool)status["active"] && (bool)status["recovering"] && !(bool)status["supported"],"missing endpoint recovery state");
            fake.missing.Clear();session.Tick();Assert(!(bool)SessionCall(session,"status")["recovering"] && !fake.values["speakers"],"session device recovery not retried");
            var invalid=new Dictionary<string,object>{{"op","start"},{"lease",A},{"endpoints",new[]{"voice"}}};
            status=Json.Deserialize<Dictionary<string,object>>(Json.Serialize(session.Handle(invalid)));Assert(!(bool)status["ok"] && lease.Lease=="","caller selected arbitrary endpoint");
        }
        return 8;
    }
    static int Native(string endpoint,string journal) {
        using(var access=new WindowsAudioMuteAccess()) {
            AudioEndpointInfo selected=null;
            foreach(var device in access.Endpoints())if(device.Id==endpoint && !device.Default && device.Name.Contains("Steam Streaming Speakers"))selected=device;
            if(selected==null)throw new Exception("only the existing non-default Steam speaker is allowed");
            bool original=selected.Muted;
            try {
                long now=0;
                using(var lease=new AudioMuteLease(access,()=>now,journal)) {
                    lease.Start(A,new[]{endpoint});
                    System.Threading.Thread.Sleep(100);System.Windows.Forms.Application.DoEvents();lease.Tick();
                    Assert(lease.Lease==A && access.ReadMute(endpoint),"native mute or own-callback filtering failed");
                    var notification=new WindowsAudioMuteAccess.Callback(access,endpoint,true);
                    Notify(notification,true);lease.Tick();
                    Assert(lease.Lease==A,"volume-only notification cancelled native mute");
                    lease.Stop(A);Assert(access.ReadMute(endpoint)==original && !lease.PendingRecovery,"native restore failed");
                    lease.Start(B,new[]{endpoint});
                    Notify(notification,false);lease.Tick();
                    Assert(lease.Lease==B && access.ReadMute(endpoint),"old-lease callback affected new lease");
                    System.Threading.Thread.Sleep(100);System.Windows.Forms.Application.DoEvents();
                    using(var manual=new WindowsAudioMuteAccess())manual.SetMute(endpoint,false);
                    System.Threading.Thread.Sleep(100);System.Windows.Forms.Application.DoEvents();lease.Tick();
                    Assert(lease.Lease=="" && !access.ReadMute(endpoint) && !lease.PendingRecovery,"native external callback override failed");
                }
            } finally {using(var recovery=new WindowsAudioMuteAccess())recovery.SetMute(endpoint,original);}
        }
        Console.WriteLine("PASS native virtual endpoint lease/callback/restore; no default route or physical endpoint changes");return 0;
    }
    static void Notify(WindowsAudioMuteAccess.Callback callback,bool muted) {
        // Exercise callback classification without changing endpoint volume.
        IntPtr data=System.Runtime.InteropServices.Marshal.AllocHGlobal(32);
        try {
            var bytes=new byte[32];Guid.NewGuid().ToByteArray().CopyTo(bytes,0);bytes[16]=(byte)(muted?1:0);
            System.Runtime.InteropServices.Marshal.Copy(bytes,0,data,bytes.Length);callback.OnNotify(data);
        } finally {System.Runtime.InteropServices.Marshal.FreeHGlobal(data);}
    }
}
