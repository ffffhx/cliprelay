using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace ClipRelay.Remote {
    public sealed class HerdrReply {
        public bool ok;
        public string code="",instance;
        public object result;
    }
    public sealed class HerdrChunk {
        public long sequence;
        public string kind,data;
        public int columns,rows;
    }
    public sealed class HerdrWatch : IDisposable {
        public readonly string Owner,ID,CoreSession,Terminal;
        public readonly HerdrRpc Rpc;
        public long Access,Accepted;
        public string Digest="",InputCode="";
        public Dictionary<string,object> Facts;
        public HerdrInteractiveInput Input;
        readonly object gate=new object();
        readonly Queue<HerdrChunk> chunks=new Queue<HerdrChunk>();
        long next;
        int size;
        string state="live";
        public HerdrWatch(string owner,string id,string core,string terminal,HerdrRpc rpc) {
            Owner=owner;ID=id;CoreSession=core;Terminal=terminal;Rpc=rpc;
            rpc.Frame=OnFrame;rpc.Disconnected=()=>{lock(gate){if(state=="live")state="disconnected";}};
        }
        void Append(HerdrChunk chunk,int count) {
            chunk.sequence=++next;chunks.Enqueue(chunk);size+=count;
            while(size>1024*1024 || chunks.Count>2048){var old=chunks.Dequeue();size-=old.data==null?0:old.data.Length;}
        }
        void OnFrame(uint channel,byte kind,byte[] data) {lock(gate){
            if(kind==0)for(int offset=0;offset<data.Length;offset+=8192){string text=Convert.ToBase64String(data,offset,Math.Min(8192,data.Length-offset));Append(new HerdrChunk {kind="data",data=text},text.Length);}
            else if(kind==3 && data.Length==4) {
                int columns=BitConverter.ToUInt16(data,0),rows=BitConverter.ToUInt16(data,2);
                HerdrJson.Require(columns>=1 && columns<=1000 && rows>=1 && rows<=500,"HERDR_DIMENSIONS");
                Append(new HerdrChunk {kind="resize",columns=columns,rows=rows},0);
            } else if(kind==2){state="finished";Append(new HerdrChunk {kind="end"},0);}
        }}
        public object Read(long after) {lock(gate){
            HerdrJson.Require(after>=0 && after<=next,"HERDR_RESYNC");
            HerdrJson.Require(chunks.Count==0 || after>=chunks.Peek().sequence-1,"HERDR_RESYNC");
            var result=new List<HerdrChunk>();int bytes=0;
            foreach(var chunk in chunks)if(chunk.sequence>after){bytes+=chunk.data==null?128:chunk.data.Length;if(bytes>48000 && result.Count>0)break;result.Add(chunk);}
            return HerdrJson.Object("id",ID,"terminal",Terminal,"state",state,"accepted",Accepted,"inputCode",InputCode,"next",result.Count==0?after:result.Last().sequence,"chunks",result.ToArray());
        }}
        public void Dispose(){if(Input!=null)Input.Dispose();Rpc.Frame=null;Rpc.Disconnected=null;Rpc.Dispose();lock(gate){state="detached";chunks.Clear();}}
    }

    // The phone is a human terminal viewer. terminal.send/keys are automation
    // APIs: they wait for human inactivity, and send also waits for agent status.
    // Keep the observer for output and use a zero-size resumed viewer for input.
    // Zero dimensions preserve the desktop's geometry even when the phone types.
    public sealed class HerdrInteractiveInput : IDisposable {
        readonly HerdrRpc rpc;
        readonly uint channel;
        readonly HerdrInputEncoding encoding=new HerdrInputEncoding();
        readonly ManualResetEvent painted=new ManualResetEvent(false);
        readonly object gate=new object();
        bool disposed,ended;
        public HerdrInteractiveInput(HerdrRpc rpc,string terminal) {
            this.rpc=rpc;
            rpc.Frame=(c,k,data)=>{lock(gate){if(disposed)return;if(k==0){encoding.Observe(data);painted.Set();}else if(k==2){ended=true;painted.Set();}}};
            try {
                var result=rpc.Call("terminal.attach",new {terminal=terminal,cols=0,rows=0,history=0,observe=false,resumed=true});
                channel=checked((uint)HerdrJson.Number(result,"channel"));
                HerdrJson.Require(channel>0&&painted.WaitOne(3000),"HERDR_UNAVAILABLE");
            }catch{Dispose();throw;}
        }
        byte[] Key(string name){lock(gate){HerdrJson.Require(!ended,"HERDR_FINISHED");return encoding.Key(name);}}
        public void Send(string terminal,string text,object[] keys) {
            if(text!=null) {
                byte[] paste;lock(gate){HerdrJson.Require(!ended,"HERDR_FINISHED");paste=encoding.Paste(text);}
                rpc.Send(channel,0,paste);
                // Keep paste and submit as separate events, as desktop terminals do.
                Thread.Sleep(200);
                rpc.Send(channel,0,Key("enter"));
            } else foreach(string key in keys) {
                rpc.Send(channel,0,Key(key));
                // Clipboard consumers must read the current image before a later
                // upload replaces it. This also separates Escape from the next key.
                Thread.Sleep(key=="ctrl+v"?200:30);
            }
            // A server round trip after the stream writes confirms that the core
            // is still reachable. It does NOT claim the agent started a new turn.
            rpc.Call("terminal.get",new {terminal=terminal});
        }
        public void Dispose(){lock(gate){if(disposed)return;disposed=true;rpc.Frame=null;}rpc.Dispose();painted.Dispose();}
    }

    public sealed class HerdrInputEncoding {
        string pending="";
        bool win32,bracketed,applicationCursor,alternateScreen;
        readonly List<int> primaryKitty=new List<int>{0},alternateKitty=new List<int>{0};
        List<int> kitty {get{return alternateScreen?alternateKitty:primaryKitty;}}
        public void Observe(byte[] bytes) {
            // CSI modes may straddle output frames. Keep only an incomplete CSI,
            // never a transcript, so input state is bounded independently of output.
            string data=pending+Encoding.UTF8.GetString(bytes);pending="";
            for(int i=0;i<data.Length;i++) {
                if(data[i]!='\x1b')continue;
                if(i+1==data.Length){pending="\x1b";break;}
                if(data[i+1]!='[')continue;
                int end=i+2;while(end<data.Length&&end-i<64&&(data[end]<'@'||data[end]>'~'))end++;
                if(end==data.Length){if(end-i<64)pending=data.Substring(i);break;}
                if(end-i>=64)continue;
                string args=data.Substring(i+2,end-i-2);char finish=data[end];i=end;
                if(args.StartsWith("?")&&(finish=='h'||finish=='l'))foreach(string mode in args.Substring(1).Split(';')){
                    if(mode=="9001")win32=finish=='h';if(mode=="2004")bracketed=finish=='h';if(mode=="1")applicationCursor=finish=='h';
                    if(mode=="1049"||mode=="1047"||mode=="47")alternateScreen=finish=='h';
                }
                if(finish!='u'||args.Length==0)continue;
                int flags;string[] parts=args.Substring(1).Split(';');
                if(args[0]=='>'&&Int32.TryParse(parts[0],out flags)){if(kitty.Count==16)kitty.RemoveAt(1);kitty.Add(flags);}
                else if(args[0]=='<'){int count=1;if(parts[0].Length>0)Int32.TryParse(parts[0],out count);while(count-->0&&kitty.Count>1)kitty.RemoveAt(kitty.Count-1);}
                else if(args[0]=='='&&Int32.TryParse(parts[0],out flags)){
                    int mode=1;if(parts.Length>1)Int32.TryParse(parts[1],out mode);
                    int last=kitty.Count-1;kitty[last]=mode==2?kitty[last]|flags:mode==3?kitty[last]&~flags:flags;
                }
            }
        }
        public byte[] Paste(string text){return Encoding.UTF8.GetBytes(bracketed?"\x1b[200~"+text+"\x1b[201~":text);}
        public byte[] Key(string name) {
            bool control=name.StartsWith("ctrl+"),shift=name=="shift+left";
            string key=control?name.Substring(5):shift?"left":name;
            int vk=0,scan=0,character=0;string legacy="";bool enhanced=false;
            switch(key){
                case "enter":vk=13;scan=28;character=13;legacy="\r";break;
                case "esc":vk=27;scan=1;character=27;legacy="\x1b";break;
                case "tab":vk=9;scan=15;character=9;legacy="\t";break;
                case "backspace":vk=8;scan=14;character=8;legacy="\x7f";break;
                case "up":vk=38;scan=72;legacy="A";enhanced=true;break;
                case "down":vk=40;scan=80;legacy="B";enhanced=true;break;
                case "right":vk=39;scan=77;legacy="C";enhanced=true;break;
                case "left":vk=37;scan=75;legacy="D";enhanced=true;break;
                case "home":vk=36;scan=71;legacy="H";enhanced=true;break;
                case "end":vk=35;scan=79;legacy="F";enhanced=true;break;
                case "delete":vk=46;scan=83;legacy="\x1b[3~";enhanced=true;break;
                case "pageup":vk=33;scan=73;legacy="\x1b[5~";enhanced=true;break;
                case "pagedown":vk=34;scan=81;legacy="\x1b[6~";enhanced=true;break;
                default:HerdrJson.Require(key.Length==1&&Char.IsLetterOrDigit(key[0]));vk=Char.ToUpperInvariant(key[0]);character=control?key[0]-'a'+1:key[0];legacy=((char)character).ToString();break;
            }
            // Codex negotiates Kitty inside ConPTY. Its mode overrides the
            // outer console's Win32 request, irrespective of their arrival order.
            int flags=kitty[kitty.Count-1];
            if(win32&&flags==0){
                int modifiers=(control?8:0)|(shift?16:0)|(enhanced?256:0);
                return Encoding.ASCII.GetBytes(String.Format("\x1b[{0};{1};{2};1;{3};1_\x1b[{0};{1};{2};0;{3};1_",vk,scan,character,modifiers));
            }
            if(flags!=0&&(key=="esc"||control&&(flags&9)!=0||(flags&8)!=0&&(key=="enter"||key=="tab"||key=="backspace"||key.Length==1))){
                // Unmodified Enter/Tab/Backspace remain legacy bytes unless
                // Report-all-keys (8) is negotiated: kitty keyboard protocol.
                int code=control?key[0]:key=="backspace"?127:character;
                return Encoding.ASCII.GetBytes("\x1b["+code+(control?";5":"")+"u");
            }
            if(enhanced&&legacy.Length==1)legacy=shift?"\x1b[1;2"+legacy:"\x1b"+(applicationCursor?"O":"[")+legacy;
            return Encoding.UTF8.GetBytes(legacy);
        }
    }
    public sealed class HerdrManager : IDisposable {
        readonly object gate=new object();
        readonly string instance=Guid.NewGuid().ToString("N");
        readonly Dictionary<string,HerdrWatch> watches=new Dictionary<string,HerdrWatch>();
        readonly Func<long> now;
        readonly Func<string,HerdrRpc> connect;
        HashSet<string> owners=new HashSet<string>();
        long authorization;
        bool disposed;
        static bool Hex(string value,int length){return value!=null && value.Length==length && Regex.IsMatch(value,"\\A[0-9a-f]+\\z");}
        public HerdrManager(Func<long> now,Func<string,HerdrRpc> connect){this.now=now;this.connect=connect;}
        HerdrReply Reply(object result=null){return new HerdrReply{ok=true,instance=instance,result=result};}
        HerdrReply Failure(string code){return new HerdrReply{instance=instance,code=code};}
        static string Required(Dictionary<string,object> request,string name){string value=HerdrJson.Text(request,name);HerdrJson.Require(value.Length>0);return value;}
        static void Fields(Dictionary<string,object> request,string allowed){var names=new HashSet<string>(("op,owner,instance,"+allowed).Split(','));HerdrJson.Require(request.Keys.All(names.Contains));}
        public HerdrReply Handle(Dictionary<string,object> request) {lock(gate){try{
            HerdrJson.Require(!disposed,"HERDR_UNAVAILABLE");
            string op=Required(request,"op");
            if(op=="sync") {
                HerdrJson.Require(request.Count==2 && request.ContainsKey("owners"));var values=HerdrJson.Array(request,"owners");
                HerdrJson.Require(values.Length<=256 && values.All(x=>x is string && Hex((string)x,64)));
                owners=new HashSet<string>(values.Cast<string>());authorization=now();MaintainLocked();return Reply();
            }
            MaintainLocked();string owner=Required(request,"owner");HerdrJson.Require(Hex(owner,64) && owners.Contains(owner),"HERDR_UNPAIRED");
            if(op=="agents"){
                Fields(request,"query");HerdrJson.Require(!request.ContainsKey("instance"));string query=HerdrJson.Text(request,"query");
                HerdrJson.Require(query.Length<=80&&!query.Any(Char.IsControl));return Reply(HerdrProjects.SearchAgents(query.Trim()));
            }
            if(op=="list") {
                Fields(request,"coreSession");string core=HerdrJson.Text(request,"coreSession","default");HerdrJson.Require(HerdrRpc.SessionName(core));
                using(var rpc=connect(core)) {
                    var terminals=rpc.Call("terminal.list",new {all=false});
                    var list=HerdrJson.Array(terminals,"terminals");HerdrJson.Require(list.Length<=1024,"HERDR_CAPACITY");
                    // Send only display facts. Environment, arguments and the raw
                    // arbitrary core API are not part of the phone protocol.
                    var catalog=new HerdrProjects(rpc);
                    var safe=list.Select(raw=>catalog.Display(HerdrJson.Map(raw))).ToArray();
                    return Reply(HerdrJson.Object("coreSession",core,"coreId",HerdrJson.Text(HerdrJson.Map(rpc.Hello["core"]),"id"),"version",HerdrJson.Text(rpc.Hello,"version"),"terminals",safe,"projects",catalog.Projects.Select(p=>p.Display()).ToArray(),"agents",HerdrProjects.FeaturedAgents().Select(a=>a.Display()).ToArray()));
                }
            }
            if(op=="create") {
                Fields(request,"id,coreSession,project,agent,name");
                string createId=Required(request,"id"),core=Required(request,"coreSession"),project=Required(request,"project"),agent=Required(request,"agent"),name=HerdrJson.Text(request,"name");
                HerdrJson.Require(!request.ContainsKey("instance")&&Hex(createId,32)&&HerdrRpc.SessionName(core)&&project.Length<=128&&!project.Any(Char.IsControl)&&HerdrProjects.AgentId(agent)&&name.Length<=80&&!name.Any(Char.IsControl));
                using(var rpc=connect(core))return Reply(new HerdrProjects(rpc).Create(rpc,owner,core,createId,project,agent,name.Trim()));
            }
            HerdrJson.Require(Required(request,"instance")==instance,"HERDR_STALE");
            string id=Required(request,"id");HerdrJson.Require(Hex(id,32));string key=owner+":"+id;HerdrWatch watch;watches.TryGetValue(key,out watch);
            if(op=="close") {
                Fields(request,"id,coreSession,coreId,terminal,createdMs");
                string core=Required(request,"coreSession"),coreId=Required(request,"coreId"),terminal=Required(request,"terminal");
                long created=HerdrJson.Number(request,"createdMs");
                HerdrJson.Require(HerdrRpc.SessionName(core)&&coreId.Length<=128&&!coreId.Any(Char.IsControl)&&Regex.IsMatch(terminal,"\\At[0-9a-z]{1,63}\\z")&&created>0&&created<9007199254740991L);
                using(var rpc=connect(core)) {
                    HerdrJson.Require(HerdrJson.Text(HerdrJson.Map(rpc.Hello["core"]),"id")==coreId,"HERDR_STALE");
                    try {
                        var facts=rpc.Call("terminal.get",new {terminal=terminal});
                        HerdrJson.Require(HerdrJson.Text(facts,"address")==terminal&&HerdrJson.Number(facts,"created_ms")==created,"HERDR_STALE");
                        // Explicit kill closes kept terminals too; never send shell text or touch project files.
                        if(HerdrJson.Text(facts,"state")=="live")facts=rpc.Call("terminal.kill",new {terminal=terminal});
                        HerdrJson.Require(HerdrJson.Text(facts,"state")!="live","HERDR_CLOSE_FAILED");
                        rpc.Call("terminal.rm",new {terminal=terminal});
                    }catch(HerdrFault error){if(error.Message!="HERDR_NOT_FOUND")throw;}
                }
                foreach(var watchKey in watches.Where(p=>p.Value.CoreSession==core&&p.Value.Terminal==terminal).Select(p=>p.Key).ToArray()){
                    var closed=watches[watchKey];watches.Remove(watchKey);closed.Dispose();
                }
                return Reply(new {id=id,terminal=terminal,closed=true});
            }
            if(op=="watch") {
                Fields(request,"id,coreSession,terminal");string core=Required(request,"coreSession"),terminal=Required(request,"terminal");
                HerdrJson.Require(HerdrRpc.SessionName(core) && terminal.Length<=256 && !terminal.Any(Char.IsControl));
                if(watch!=null){HerdrJson.Require(watch.CoreSession==core && watch.Terminal==terminal,"HERDR_CONFLICT");watch.Access=now();return Reply(WatchInfo(watch));}
                HerdrJson.Require(watches.Count<8 && watches.Values.Count(w=>w.Owner==owner)<4,"HERDR_CAPACITY");
                HerdrRpc rpc=connect(core);watch=new HerdrWatch(owner,id,core,terminal,rpc);
                try {
                    HerdrJson.Require(HerdrJson.Array(rpc.Hello,"features").Contains("resize_notifications"),"HERDR_UPDATE_REQUIRED");
                    var facts=rpc.Call("terminal.get",new {terminal=terminal});
                    var result=rpc.Call("terminal.attach",new {terminal=terminal,cols=HerdrJson.Number(facts,"cols"),rows=HerdrJson.Number(facts,"rows"),history=300,observe=true,resize_notifications=true});
                    HerdrJson.Require(HerdrJson.Flag(result,"resize_notifications"),"HERDR_UPDATE_REQUIRED");
                    watch.Facts=HerdrJson.Map(result["terminal"]);watch.Access=now();watches.Add(key,watch);return Reply(WatchInfo(watch));
                }catch{watch.Dispose();throw;}
            }
            if(op=="detach") {Fields(request,"id");if(watch!=null){watches.Remove(key);watch.Dispose();}return Reply(new {id=id});}
            HerdrJson.Require(watch!=null,"HERDR_NOT_FOUND");watch.Access=now();
            if(op=="read"){Fields(request,"id,after");return Reply(watch.Read(HerdrJson.Number(request,"after")));}
            HerdrJson.Require(op=="send" || op=="keys");Fields(request,"id,sequence,text,keys");
            long sequence=HerdrJson.Number(request,"sequence");HerdrJson.Require(sequence>0 && sequence<9007199254740991L);
            string text=HerdrJson.Text(request,"text");object[] keys=HerdrJson.Array(request,"keys");
            if(op=="send")HerdrJson.Require(!request.ContainsKey("keys") && text.Length>0 && Encoding.UTF8.GetByteCount(text)<=16384 && !text.Any(c=>Char.IsControl(c) && c!='\n' && c!='\r' && c!='\t'));
            else HerdrJson.Require(!request.ContainsKey("text") && keys.Length>0 && keys.Length<=16 && keys.All(k=>k is string && Regex.IsMatch((string)k,"\\A(?:enter|esc|tab|backspace|delete|up|down|left|right|home|end|pageup|pagedown|shift\\+left|ctrl\\+[a-z]|[a-z0-9])\\z")));
            string digest;using(var hash=SHA256.Create())digest=Convert.ToBase64String(hash.ComputeHash(Encoding.UTF8.GetBytes(op+"\n"+(op=="send"?text:String.Join("\n",keys.Cast<string>())))));
            if(sequence==watch.Accepted){HerdrJson.Require(watch.Digest==digest,"HERDR_CONFLICT");return Reply(InputInfo(watch));}
            HerdrJson.Require(sequence==watch.Accepted+1,"HERDR_SEQUENCE");
            // Reserve before dispatch. A lost reply, disconnect or helper
            // restart can never cause this user instruction to be sent twice.
            watch.Accepted=sequence;watch.Digest=digest;watch.InputCode="HERDR_OUTCOME_UNKNOWN";
            try {
                if(watch.Input==null)watch.Input=new HerdrInteractiveInput(connect(watch.CoreSession),watch.Terminal);
                watch.Input.Send(watch.Terminal,op=="send"?text:null,keys);
                watch.InputCode="";
            }catch(HerdrFault error){watch.InputCode=error.Message;if(watch.Input!=null){watch.Input.Dispose();watch.Input=null;}}
            return Reply(InputInfo(watch));
        }catch(HerdrFault error){return Failure(error.Message);}catch{return Failure("HERDR_UNAVAILABLE");}}}
        static object InputInfo(HerdrWatch watch){return new {id=watch.ID,accepted=watch.Accepted,inputCode=watch.InputCode};}
        static object WatchInfo(HerdrWatch watch){return HerdrJson.Object("id",watch.ID,"terminal",watch.Terminal,"columns",HerdrJson.Number(watch.Facts,"cols"),"rows",HerdrJson.Number(watch.Facts,"rows"),"accepted",watch.Accepted,"inputCode",watch.InputCode);}
        void MaintainLocked(){if(now()-authorization>=20000)owners.Clear();foreach(var key in watches.Where(p=>!owners.Contains(p.Value.Owner) || now()-p.Value.Access>=60000).Select(p=>p.Key).ToArray()){var watch=watches[key];watches.Remove(key);watch.Dispose();}}
        public void Maintain(){lock(gate){if(!disposed)MaintainLocked();}}
        public void Dispose(){lock(gate){disposed=true;foreach(var watch in watches.Values)watch.Dispose();watches.Clear();}}
    }
    public static class HerdrWorker {
        public static int Run() {
            using(var identity=WindowsIdentity.GetCurrent())if(identity.IsSystem || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))return DesktopUserProcess.RunWorker("--herdr-probe");
            Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false);
            var clock=Stopwatch.StartNew();var json=HerdrJson.Serializer();
            using(var manager=new HerdrManager(()=>clock.ElapsedMilliseconds,HerdrRpc.Connect))
            using(var timer=new Timer(_=>manager.Maintain(),null,1000,1000))while(true) {
                var line=new StringBuilder();int c;while((c=Console.Read())!=-1 && c!='\n'){if(line.Length>=65536)return 2;line.Append((char)c);}if(c==-1)return 0;
                HerdrReply result;try{result=manager.Handle(HerdrJson.Map(json.DeserializeObject(line.ToString())));}catch{result=new HerdrReply{code="HERDR_BAD_REQUEST"};}
                Console.WriteLine(json.Serialize(result));Console.Out.Flush();
            }
        }
    }
}
