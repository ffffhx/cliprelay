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
using System.Web.Script.Serialization;

namespace ClipRelay.Remote {
    public sealed class TerminalFault : Exception {public TerminalFault(string code):base(code){}}
    public sealed class TerminalRequest {
        public string op,owner,instance,id,shell,data;
        public long sequence,offset;
        public int columns,rows;
        public string[] owners;
    }
    public sealed class TerminalSessionState {
        public string id,shell,state;
        public int columns,rows,exitCode;
        public long openSequence,acceptedSequence,writtenSequence,start,end,remainingMs;
    }
    public sealed class TerminalReply {
        public bool ok;
        public string code="",instance="",data="";
        public long nextOpen,offset,next;
        public bool gap;
        public TerminalSessionState session;
        public TerminalSessionState[] sessions;
    }
    public sealed class TerminalBuffer {
        readonly byte[] data;
        readonly object gate=new object();
        long end;
        public TerminalBuffer(int capacity){data=new byte[capacity];}
        public void Append(byte[] bytes){lock(gate){foreach(byte b in bytes){data[(int)(end%data.Length)]=b;end++;}}}
        public long Start{get{lock(gate)return Math.Max(0,end-data.Length);}}
        public long End{get{lock(gate)return end;}}
        public byte[] Read(long requested,out long offset,out bool gap){lock(gate){
            long first=Math.Max(0,end-data.Length);if(requested<0 || requested>end)throw new TerminalFault("TERMINAL_OFFSET");
            offset=Math.Max(first,requested);gap=offset!=requested;int count=(int)Math.Min(32768,end-offset);byte[] result=new byte[count];
            for(int i=0;i<count;i++)result[i]=data[(int)((offset+i)%data.Length)];return result;
        }}
    }
    public sealed class TerminalManager : IDisposable {
        sealed class Session {
            public string owner,id,shell,state="running",digest="";
            public long openSequence,accepted,written,lastAccess,finished;
            public int columns,rows,exitCode;
            public TerminalBuffer output=new TerminalBuffer(1024*1024);
            public ITerminalProcess process;
        }
        readonly object gate=new object();
        readonly Dictionary<string,Session> sessions=new Dictionary<string,Session>();
        readonly Dictionary<string,long> nextOpen=new Dictionary<string,long>();
        HashSet<string> owners=new HashSet<string>();
        readonly Func<long> now;
        readonly Func<string,int,int,Action<byte[]>,ITerminalProcess> create;
        readonly string instance=Guid.NewGuid().ToString("N");
        long authorizedAt;
        bool disposed;
        public TerminalManager(Func<long> now,Func<string,int,int,Action<byte[]>,ITerminalProcess> create){this.now=now;this.create=create;}
        static readonly Regex Id=new Regex("^[0-9a-f]{32}$"),Owner=new Regex("^[0-9a-f]{64}$");
        static bool Match(Regex expression,string value){return value!=null && expression.IsMatch(value);}
        public static void Require(bool ok,string code){if(!ok)throw new TerminalFault(code);}
        public static TerminalRequest Parse(string text) {
            var json=new JavaScriptSerializer {MaxJsonLength=16384,RecursionLimit=4};
            var value=json.DeserializeObject(text) as Dictionary<string,object>;
            Require(value!=null,"TERMINAL_BAD_REQUEST");
            Func<string,string> str=key=>{object result;if(!value.TryGetValue(key,out result))return "";Require(result is string,"TERMINAL_BAD_REQUEST");return (string)result;};
            Func<string,long> number=key=>{object result;if(!value.TryGetValue(key,out result))return 0;Require(result is int || result is long,"TERMINAL_BAD_REQUEST");return Convert.ToInt64(result);};
            string op=str("op");
            string fields=op=="sync"?"op,owners":op=="list"?"op,owner":op=="open"?"op,owner,instance,id,shell,columns,rows,sequence":
                op=="read"?"op,owner,instance,id,offset":op=="write"?"op,owner,instance,id,sequence,data":
                op=="resize"?"op,owner,instance,id,columns,rows":op=="close"?"op,owner,instance,id":"";
            Require(fields.Length>0 && value.Keys.All(key=>fields.Split(',').Contains(key)),"TERMINAL_BAD_REQUEST");
            var request=new TerminalRequest {op=op,owner=str("owner"),instance=str("instance"),id=str("id"),shell=str("shell"),data=str("data"),sequence=number("sequence"),offset=number("offset")};
            long columns=number("columns"),rows=number("rows");Require(columns>=0 && columns<=240 && rows>=0 && rows<=120,"TERMINAL_BAD_REQUEST");
            request.columns=(int)columns;request.rows=(int)rows;
            if(op=="sync") {
                object raw;Require(value.TryGetValue("owners",out raw) && raw is object[],"TERMINAL_BAD_REQUEST");
                var array=(object[])raw;Require(array.Length<=256 && array.All(item=>item is string && Match(Owner,(string)item)),"TERMINAL_BAD_REQUEST");
                request.owners=array.Cast<string>().ToArray();Require(request.owners.Distinct().Count()==request.owners.Length,"TERMINAL_BAD_REQUEST");
            }
            return request;
        }
        public TerminalReply Handle(TerminalRequest request) {lock(gate){
            try {
                Require(!disposed,"TERMINAL_UNAVAILABLE");
                if(request.op=="sync") {
                    Require(request.owners!=null && request.owners.Length<=256 && request.owners.All(item=>Match(Owner,item)),"TERMINAL_BAD_REQUEST");
                    owners=new HashSet<string>(request.owners);authorizedAt=now();MaintainLocked();return Reply();
                }
                MaintainLocked();
                Require(Match(Owner,request.owner) && owners.Contains(request.owner),"TERMINAL_UNPAIRED");
                long next;if(!nextOpen.TryGetValue(request.owner,out next)) {
                    Require(nextOpen.Count<256,"TERMINAL_CAPACITY");next=1;nextOpen.Add(request.owner,next);
                }
                if(request.op=="list")return new TerminalReply {ok=true,instance=instance,nextOpen=next,sessions=sessions.Values.Where(s=>s.owner==request.owner).OrderBy(s=>s.openSequence).Select(State).ToArray()};
                Require(request.instance==instance,"TERMINAL_STALE");
                Require(Match(Id,request.id),"TERMINAL_BAD_REQUEST");string key=request.owner+":"+request.id;
                Session session;sessions.TryGetValue(key,out session);
                if(request.op=="open") {
                    Require((request.shell=="cmd" || request.shell=="powershell") && Dimensions(request),"TERMINAL_BAD_REQUEST");
                    if(session!=null) {
                        Require(session.openSequence==request.sequence && session.shell==request.shell,"TERMINAL_ID_CONFLICT");
                        return Reply(session);
                    }
                    Require(request.sequence==next && next<long.MaxValue,"TERMINAL_SEQUENCE");
                    Require(sessions.Values.Count(s=>s.state=="running")<8 && sessions.Values.Count(s=>s.owner==request.owner && s.state=="running")<4,"TERMINAL_CAPACITY");
                    if(sessions.Count>=32) {
                        var oldest=sessions.Values.Where(s=>s.state!="running").OrderBy(s=>s.finished).FirstOrDefault();
                        Require(oldest!=null,"TERMINAL_CAPACITY");sessions.Remove(oldest.owner+":"+oldest.id);
                    }
                    // Consume creation sequence before starting: even an uncertain
                    // startup or a pruned receipt must never create a second shell.
                    nextOpen[request.owner]=next+1;
                    session=new Session {owner=request.owner,id=request.id,shell=request.shell,openSequence=next,columns=request.columns,rows=request.rows,lastAccess=now()};
                    session.process=create(request.shell,request.columns,request.rows,session.output.Append);
                    sessions.Add(key,session);return Reply(session);
                }
                Require(session!=null,"TERMINAL_NOT_FOUND");session.lastAccess=now();
                if(request.op=="close"){Stop(session,"closed");return Reply(session);}
                if(request.op=="read") {
                    long offset;bool gap;byte[] bytes=session.output.Read(request.offset,out offset,out gap);
                    TerminalReply reply=Reply(session);reply.data=Convert.ToBase64String(bytes);reply.offset=offset;reply.next=offset+bytes.Length;reply.gap=gap;return reply;
                }
                Require(session.state=="running","TERMINAL_CLOSED");
                if(request.op=="resize") {Require(Dimensions(request),"TERMINAL_BAD_REQUEST");session.process.Resize(request.columns,request.rows);session.columns=request.columns;session.rows=request.rows;return Reply(session);}
                Require(request.op=="write","TERMINAL_BAD_REQUEST");
                byte[] input;try{input=Convert.FromBase64String(request.data??"");}catch{throw new TerminalFault("TERMINAL_BAD_REQUEST");}
                Require(input.Length>0 && input.Length<=4096 && Convert.ToBase64String(input)==request.data,"TERMINAL_BAD_REQUEST");
                string digest;using(var hash=SHA256.Create())digest=Convert.ToBase64String(hash.ComputeHash(input));
                if(request.sequence==session.accepted){Require(session.accepted>0 && session.digest==digest,"TERMINAL_INPUT_CONFLICT");return Reply(session);}
                Require(request.sequence==session.accepted+1 && request.sequence>0,"TERMINAL_SEQUENCE");
                Require(session.process.Queue(input,request.sequence),"TERMINAL_BUSY");
                session.accepted=request.sequence;session.digest=digest;return Reply(session);
            } catch(TerminalFault error){return new TerminalReply {code=error.Message,instance=instance};}
              catch(EntryPointNotFoundException){return new TerminalReply {code="TERMINAL_UNSUPPORTED",instance=instance};}
              catch(InvalidOperationException error){return new TerminalReply {code=error.Message=="TERMINAL_USER_REQUIRED"?error.Message:"TERMINAL_UNAVAILABLE",instance=instance};}
              catch(Exception){return new TerminalReply {code="TERMINAL_UNAVAILABLE",instance=instance};}
        }}
        static bool Dimensions(TerminalRequest request){return request.columns>=20 && request.columns<=240 && request.rows>=5 && request.rows<=120;}
        TerminalReply Reply(Session session=null){return new TerminalReply {ok=true,instance=instance,session=session==null?null:State(session)};}
        TerminalSessionState State(Session session){return new TerminalSessionState {id=session.id,shell=session.shell,state=session.state,columns=session.columns,rows=session.rows,exitCode=session.exitCode,
            openSequence=session.openSequence,acceptedSequence=session.accepted,writtenSequence=session.process==null?session.written:session.process.WrittenSequence,start=session.output.Start,end=session.output.End,
            remainingMs=session.state=="running"?Math.Max(0,1800000-(now()-session.lastAccess)):0};}
        void Stop(Session session,string state){if(session.state!="running")return;session.state=state;session.finished=now();
            ITerminalProcess process=session.process;session.process=null;if(process!=null){session.exitCode=process.Exited?process.ExitCode:-1;session.written=process.WrittenSequence;process.Dispose();}}
        void MaintainLocked() {
            if(now()-authorizedAt>=20000)owners.Clear();
            foreach(Session session in sessions.Values) {
                if(session.state!="running")continue;
                if(!owners.Contains(session.owner))Stop(session,"revoked");
                else if(now()-session.lastAccess>=1800000)Stop(session,"expired");
                else if(session.process.Failed)Stop(session,"failed");
                else if(session.process.Exited)Stop(session,"exited");
            }
            foreach(string key in sessions.Where(item=>item.Value.state!="running" && now()-item.Value.finished>=300000).Select(item=>item.Key).ToArray())sessions.Remove(key);
        }
        public void Maintain(){lock(gate){if(!disposed)MaintainLocked();}}
        public void Dispose(){lock(gate){if(disposed)return;disposed=true;foreach(Session session in sessions.Values)Stop(session,"closed");sessions.Clear();}}
    }
    public static class TerminalWorker {
        public static int Run() {
            using(var identity=WindowsIdentity.GetCurrent())if(identity.IsSystem || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                return DesktopUserProcess.RunWorker("--terminal-probe");
            Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false);
            var clock=Stopwatch.StartNew();var json=new JavaScriptSerializer {MaxJsonLength=65536,RecursionLimit=8};
            using(var manager=new TerminalManager(()=>clock.ElapsedMilliseconds,(shell,columns,rows,output)=>new NativeTerminalProcess(shell,columns,rows,output)))
            using(var timer=new Timer(state=>manager.Maintain(),null,1000,1000)) {
                while(true) {
                    var line=new StringBuilder();int c;while((c=Console.Read())!=-1 && c!='\n'){if(line.Length>=16384)return 2;line.Append((char)c);}
                    if(c==-1)return 0;
                    TerminalReply result;
                    try{result=manager.Handle(TerminalManager.Parse(line.ToString()));}catch{result=new TerminalReply {code="TERMINAL_BAD_REQUEST"};}
                    Console.WriteLine(json.Serialize(result));Console.Out.Flush();
                }
            }
        }
    }
}
