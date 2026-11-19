using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace ClipRelay.Remote {
    public sealed class HerdrFault : Exception { public HerdrFault(string code):base(code){} }
    public static class HerdrJson {
        public static JavaScriptSerializer Serializer(){return new JavaScriptSerializer {MaxJsonLength=4*1024*1024,RecursionLimit=48};}
        public static void Require(bool condition,string code="HERDR_BAD_REQUEST"){if(!condition)throw new HerdrFault(code);}
        public static Dictionary<string,object> Map(object value){var result=value as Dictionary<string,object>;Require(result!=null,"HERDR_INVALID_RESPONSE");return result;}
        public static string Text(Dictionary<string,object> value,string key,string fallback=""){object item;return value.TryGetValue(key,out item) && item is string?(string)item:fallback;}
        public static long Number(Dictionary<string,object> value,string key,long fallback=0){object item;if(!value.TryGetValue(key,out item))return fallback;Require(item is int || item is long,"HERDR_INVALID_RESPONSE");return Convert.ToInt64(item);}
        public static bool Flag(Dictionary<string,object> value,string key){object item;return value.TryGetValue(key,out item) && item is bool && (bool)item;}
        public static object[] Array(Dictionary<string,object> value,string key){object item;return value.TryGetValue(key,out item) && item is object[]?(object[])item:new object[0];}
        public static Dictionary<string,object> Object(params object[] entries){var result=new Dictionary<string,object>();for(int i=0;i<entries.Length;i+=2)result.Add((string)entries[i],entries[i+1]);return result;}
    }

    // Connects only to an already running core. Never starts, updates or stops
    // Herdr, and never owns the core or its agent processes.
    public sealed class HerdrRpc : IDisposable {
        sealed class Pending {public readonly ManualResetEvent Done=new ManualResetEvent(false);public Dictionary<string,object> Value;}
        readonly Stream stream;
        readonly object writeGate=new object(),gate=new object();
        readonly Dictionary<long,Pending> pending=new Dictionary<long,Pending>();
        long next=1;
        bool closed;
        public readonly Dictionary<string,object> Hello;
        public Action<uint,byte,byte[]> Frame;
        public Action Disconnected;
        public bool Connected {get{lock(gate)return !closed;}}

        public static bool SessionName(string name){return !String.IsNullOrWhiteSpace(name) && name.Length<=80 && name==name.Trim() && name!="." && name!=".." && !name.Any(c=>Char.IsControl(c) || "/\\:*?\"<>|".Contains(c));}
        public static HerdrRpc Connect(string session) {
            HerdrJson.Require(SessionName(session));
            string user=new string(Environment.UserName.Where(c=>c>='a'&&c<='z'||c>='A'&&c<='Z'||c>='0'&&c<='9').ToArray());
            HerdrJson.Require(user.Length>0,"HERDR_USER_REQUIRED");
            var pipe=new NamedPipeClientStream(".","herdr-core-"+user+"-"+session+".sock",PipeDirection.InOut,PipeOptions.Asynchronous);
            try {pipe.Connect(1200);return new HerdrRpc(pipe);}
            catch(UnauthorizedAccessException){pipe.Dispose();throw new HerdrFault("HERDR_USER_REQUIRED");}
            catch(HerdrFault){pipe.Dispose();throw;}
            catch {pipe.Dispose();throw new HerdrFault("HERDR_NOT_RUNNING");}
        }
        public HerdrRpc(Stream stream) {
            this.stream=stream;
            // Bound the initial handshake as well as normal RPCs. Disposing the
            // overlapped pipe unblocks a stalled read without leaving a worker.
            using(var timeout=new Timer(_=>{try{stream.Dispose();}catch{}},null,3000,Timeout.Infinite)) {
                byte[] request=Encoding.UTF8.GetBytes("{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"hello\",\"params\":{\"generation\":1,\"framed\":true}}\n");
                stream.Write(request,0,request.Length);stream.Flush();
                var bytes=new List<byte>();int b;
                while((b=stream.ReadByte())!=10){if(b<0 || bytes.Count>=65536)throw new HerdrFault("HERDR_PROTOCOL");bytes.Add((byte)b);}
                var response=HerdrJson.Map(HerdrJson.Serializer().DeserializeObject(new UTF8Encoding(false,true).GetString(bytes.ToArray())));
                HerdrJson.Require(HerdrJson.Number(response,"id",-1)==0 && response.ContainsKey("result"),"HERDR_PROTOCOL");
                Hello=HerdrJson.Map(response["result"]);
                HerdrJson.Require(HerdrJson.Number(Hello,"generation")==1 && HerdrJson.Flag(Hello,"framed"),"HERDR_UPDATE_REQUIRED");
            }
            new Thread(ReadLoop){IsBackground=true,Name="ClipRelay Herdr events"}.Start();
        }
        public Dictionary<string,object> Call(string method,object parameters,int timeout=15000) {
            var wait=new Pending();long id;
            lock(gate){HerdrJson.Require(!closed,"HERDR_DISCONNECTED");id=next++;pending.Add(id,wait);}
            try {
                byte[] payload=Encoding.UTF8.GetBytes(HerdrJson.Serializer().Serialize(HerdrJson.Object("jsonrpc","2.0","id",id,"method",method,"params",parameters)));
                Send(0,0,payload);
                if(!wait.Done.WaitOne(timeout)){Dispose();throw new HerdrFault("HERDR_OUTCOME_UNKNOWN");}
                var value=wait.Value;
                HerdrJson.Require(value!=null,"HERDR_OUTCOME_UNKNOWN");
                if(value.ContainsKey("error")) {
                    var error=HerdrJson.Map(value["error"]);string kind=error.ContainsKey("data")?HerdrJson.Text(HerdrJson.Map(error["data"]),"kind"):"";
                    string code=kind=="not_found"?"HERDR_NOT_FOUND":kind=="finished"?"HERDR_FINISHED":kind=="blocked"?"HERDR_BLOCKED":kind=="unavailable"?"HERDR_DISCONNECTED":kind=="needs_update"||kind=="unsupported_generation"?"HERDR_UPDATE_REQUIRED":"HERDR_COMMAND_FAILED";
                    throw new HerdrFault(code);
                }
                HerdrJson.Require(value.ContainsKey("result"),"HERDR_INVALID_RESPONSE");
                return HerdrJson.Map(value["result"]);
            } finally {lock(gate)pending.Remove(id);wait.Done.Dispose();}
        }
        public void Send(uint channel,byte kind,byte[] payload) {
            HerdrJson.Require(payload.Length<=16*1024*1024,"HERDR_PROTOCOL");
            var header=new byte[9];Buffer.BlockCopy(BitConverter.GetBytes(channel),0,header,0,4);header[4]=kind;Buffer.BlockCopy(BitConverter.GetBytes(payload.Length),0,header,5,4);
            lock(writeGate){lock(gate)HerdrJson.Require(!closed,"HERDR_DISCONNECTED");try{stream.Write(header,0,9);stream.Write(payload,0,payload.Length);stream.Flush();}catch{Dispose();throw new HerdrFault("HERDR_OUTCOME_UNKNOWN");}}
        }
        byte[] Read(int length){var result=new byte[length];int used=0;while(used<length){int n=stream.Read(result,used,length-used);if(n==0)throw new EndOfStreamException();used+=n;}return result;}
        void ReadLoop() {
            try {
                while(true) {
                    byte[] h=Read(9);uint channel=BitConverter.ToUInt32(h,0);byte kind=h[4];uint size=BitConverter.ToUInt32(h,5);
                    HerdrJson.Require(size<=16*1024*1024,"HERDR_PROTOCOL");byte[] payload=Read((int)size);
                    if(channel==0 && kind==0) {
                        var value=HerdrJson.Map(HerdrJson.Serializer().DeserializeObject(new UTF8Encoding(false,true).GetString(payload)));
                        long id=HerdrJson.Number(value,"id",-1);lock(gate){Pending wait;if(pending.TryGetValue(id,out wait)){wait.Value=value;wait.Done.Set();}}
                    } else {
                        var handler=Frame;if(handler!=null)handler(channel,kind,payload);
                        if(kind==0)Send(channel,1,BitConverter.GetBytes((uint)payload.Length));
                    }
                }
            } catch {} finally {Dispose();}
        }
        public void Dispose() {
            lock(gate){if(closed)return;closed=true;try{stream.Dispose();}catch{}foreach(var wait in pending.Values)wait.Done.Set();}
            var handler=Disconnected;if(handler!=null)handler();
        }
    }
}
