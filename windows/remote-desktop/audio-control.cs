using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace ClipRelay.Remote {
    // Serialize operations on the desktop STA. Device identifiers never leave
    // the host: clients select a lease, not arbitrary audio endpoints.
    public sealed class AudioMuteSession {
        readonly AudioMuteLease lease;
        readonly Func<AudioEndpointInfo[]> inventory;
        readonly Func<bool> interactive;
        string topology="";
        public AudioMuteSession(AudioMuteLease lease,Func<AudioEndpointInfo[]> inventory,Func<bool> interactive) {
            this.lease=lease;this.inventory=inventory;this.interactive=interactive;
        }
        static bool VoiceFeed(string name) {
            // These render endpoints feed the existing Doubao virtual microphone
            // workflow. They do not represent the computer's physical speakers.
            name=name??"";
            return name.IndexOf("Steam Streaming Microphone",StringComparison.OrdinalIgnoreCase)>=0 ||
                (name.IndexOf("CABLE Input",StringComparison.OrdinalIgnoreCase)>=0 && name.IndexOf("VB-Audio",StringComparison.OrdinalIgnoreCase)>=0);
        }
        string[] Targets(out string signature) {
            var ids=new List<string>();var layout=new List<string>();
            foreach(var endpoint in inventory()) {
                if(VoiceFeed(endpoint.Name))continue;
                ids.Add(endpoint.Id);layout.Add(endpoint.Id+"\n"+(endpoint.Default?"1":"0"));
            }
            if(ids.Count>32)throw new IOException("AUDIO_TOO_MANY_ENDPOINTS");
            layout.Sort(StringComparer.Ordinal);signature=String.Join("\r",layout.ToArray());return ids.ToArray();
        }
        public void Restore() {topology="";lease.Restore();}
        public void Tick() {
            try {
                if(lease.Lease!="") {
                    string current;Targets(out current);
                    if(!interactive() || current!=topology) {Restore();return;}
                }
                lease.Tick();
            } catch {try{Restore();}catch{}}
        }
        object State(bool ok,string code) {
            int count=0;bool available=false;
            try{string ignored;count=Targets(out ignored).Length;available=interactive();}catch{ok=false;try{Restore();}catch{}if(code=="")code="AUDIO_UNAVAILABLE";}
            bool active=lease.Lease!="",recovering=!active && lease.PendingRecovery;
            return new {ok=ok,code=code,supported=available && count>0 && !recovering,active=active,lease=lease.Lease,
                expiresMs=lease.RemainingMs,recovering=recovering,outputs=count};
        }
        public object Handle(Dictionary<string,object> request) {
            Tick();object value;
            if(request==null || request.Count>2 || !request.TryGetValue("op",out value) || !(value is string))return State(false,"AUDIO_BAD_REQUEST");
            foreach(var key in request.Keys)if(key!="op" && key!="lease")return State(false,"AUDIO_BAD_REQUEST");
            string op=(string)value,id=request.TryGetValue("lease",out value)?value as string:"";
            if(op=="status" && id=="")return State(true,"");
            if(id==null || !Regex.IsMatch(id,"\\A[0-9a-f]{32}\\z") || (op!="start" && op!="renew" && op!="stop"))return State(false,"AUDIO_BAD_REQUEST");
            if(lease.Lease!="" && lease.Lease!=id)return State(false,"AUDIO_BUSY");
            if(op=="renew" && lease.Lease=="")return State(false,"AUDIO_EXPIRED");
            if(op!="stop" && !interactive())return State(false,"AUDIO_DESKTOP_UNAVAILABLE");
            try {
                if(op=="stop") {Restore();return State(true,"");}
                if(lease.Lease!="") {lease.Renew(id);return State(true,"");}
                string current;var endpoints=Targets(out current);
                if(endpoints.Length==0)return State(false,"AUDIO_UNSUPPORTED");
                lease.Start(id,endpoints);topology=current;
                // Recheck a device/default change while the initial writes ran.
                Tick();return State(lease.Lease==id,lease.Lease==id?"":"AUDIO_CHANGED_LOCALLY");
            } catch {
                try{Restore();}catch{}
                return State(false,lease.PendingRecovery?"AUDIO_RECOVERY_PENDING":"AUDIO_UNAVAILABLE");
            }
        }
    }

    public static class AudioMuteProbe {
        public static int Run(Func<bool> interactive) {
            using(var identity=WindowsIdentity.GetCurrent())if(identity.IsSystem)return DesktopUserProcess.RunWorker("--audio-mute-probe");
            int result=2;
            var thread=new Thread(()=>{try{result=RunDesktop(interactive);}catch{result=2;}});
            thread.SetApartmentState(ApartmentState.STA);thread.Start();thread.Join();return result;
        }
        static int RunDesktop(Func<bool> interactive) {
            Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false);
            var json=new JavaScriptSerializer {MaxJsonLength=4096,RecursionLimit=4};
            var clock=Stopwatch.StartNew();
            using(var dispatch=new Control())
            using(var access=new WindowsAudioMuteAccess())
            using(var lease=new AudioMuteLease(access,()=>clock.ElapsedMilliseconds,AudioMuteRecovery.JournalPath))
            using(var timer=new System.Windows.Forms.Timer {Interval=250}) {
                var session=new AudioMuteSession(lease,access.Endpoints,interactive);
                IntPtr handle=dispatch.Handle;
                timer.Tick+=(sender,args)=>session.Tick();timer.Start();
                var reader=new Thread(()=>{
                    try {
                        while(true) {
                            var line=new StringBuilder();int c;
                            while((c=Console.Read())!=-1 && c!='\n') {if(line.Length>=4096)throw new IOException();line.Append((char)c);}
                            if(c==-1)break;
                            string raw=line.ToString();if(!raw.StartsWith("audio-mute:",StringComparison.Ordinal))break;
                            string reply=(string)dispatch.Invoke(new Func<string>(()=>{
                                try{return json.Serialize(session.Handle(json.Deserialize<Dictionary<string,object>>(raw.Substring(11))));}
                                catch{try{session.Restore();}catch{}return "{\"ok\":false,\"code\":\"AUDIO_BAD_REQUEST\"}";}
                            }));
                            Console.WriteLine(reply);Console.Out.Flush();
                        }
                    } catch{}
                    finally {try{dispatch.BeginInvoke(new Action(()=>{try{session.Restore();}finally{Application.ExitThread();}}));}catch{}}
                });
                reader.IsBackground=true;reader.Start();Application.Run();return 0;
            }
        }
    }
}
