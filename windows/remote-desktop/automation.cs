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
using System.Windows.Forms;

namespace ClipRelay.Remote {
    public sealed class AutomationFault : Exception { public AutomationFault(string code):base(code){} }
    public static class AutomationJson {
        public static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=4*1024*1024,RecursionLimit=48};
        public static void Require(bool value,string code="AUTOMATION_BAD_REQUEST"){if(!value)throw new AutomationFault(code);}
        public static Dictionary<string,object> Map(object value){var map=value as Dictionary<string,object>;Require(map!=null);return map;}
        public static string Text(Dictionary<string,object> map,string key,string fallback=""){object value;if(!map.TryGetValue(key,out value))return fallback;Require(value is string);return (string)value;}
        public static int Number(Dictionary<string,object> map,string key,int fallback=0){object value;if(!map.TryGetValue(key,out value))return fallback;Require(value is int);return (int)value;}
        public static bool Flag(Dictionary<string,object> map,string key,bool fallback=false){object value;if(!map.TryGetValue(key,out value))return fallback;Require(value is bool);return (bool)value;}
        public static void Fields(Dictionary<string,object> map,string keys){var allowed=new HashSet<string>(keys.Split(','));Require(map.Keys.All(allowed.Contains));}
        public static bool Id(string value){return value!=null && Regex.IsMatch(value,"\\A[0-9a-f]{32}\\z");}
        public static string Hash(string text){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-","").ToLowerInvariant();}
    }
    public sealed class AutomationReply {
        public bool ok;
        public string code="",instance;
        public object result;
    }
    public sealed class AutomationSession : IDisposable {
        public string Owner,Id;
        public long Access;
        public readonly AutomationBrowser Browser;
        public readonly AutomationWindows Windows=new AutomationWindows();
        public AutomationSession(string owner,string id){Owner=owner;Id=id;Browser=new AutomationBrowser(id);}
        public void Dispose(){Browser.Dispose();Windows.Dispose();}
    }
    public sealed class AutomationManager : IDisposable {
        sealed class Receipt {public string Hash;public AutomationReply Reply;public int Bytes;}
        readonly string instance=Guid.NewGuid().ToString("N");
        readonly Dictionary<string,AutomationSession> sessions=new Dictionary<string,AutomationSession>();
        readonly HashSet<string> endedSessions=new HashSet<string>();
        readonly Dictionary<string,Receipt> receipts=new Dictionary<string,Receipt>();
        readonly Func<long> now;
        HashSet<string> owners=new HashSet<string>();
        long authorizedAt;
        int receiptBytes;
        public volatile bool Stopped;
        public Action<bool> Activity=active=>{};
        public AutomationManager(Func<long> clock){now=clock;}
        AutomationReply Reply(object value){return new AutomationReply{ok=true,instance=instance,result=value};}
        AutomationReply Error(string code){return new AutomationReply{instance=instance,code=code};}
        public void Maintain(){
            foreach(var key in sessions.Where(p=>Stopped || now()-authorizedAt>60000 || !owners.Contains(p.Value.Owner) || now()-p.Value.Access>60000).Select(p=>p.Key).ToArray()){
                endedSessions.Add(key);sessions[key].Dispose();sessions.Remove(key);
            }
            Activity(sessions.Count>0);
        }
        public AutomationReply Handle(string line){
            try{
                AutomationJson.Require(line.Length<=65536);
                var r=AutomationJson.Map(AutomationJson.Json.DeserializeObject(line));
                string op=AutomationJson.Text(r,"op");
                if(op=="sync"){
                    AutomationJson.Fields(r,"op,owners");object raw;
                    AutomationJson.Require(r.TryGetValue("owners",out raw) && raw is object[]);
                    var list=(object[])raw;AutomationJson.Require(list.Length<=256 && list.All(x=>x is string && Regex.IsMatch((string)x,"\\A[0-9a-f]{64}\\z")));
                    owners=new HashSet<string>(list.Cast<string>());authorizedAt=now();Maintain();return Reply(null);
                }
                AutomationJson.Fields(r,"op,owner,instance,requestId,session,params");
                Maintain();string owner=AutomationJson.Text(r,"owner");
                AutomationJson.Require(now()-authorizedAt<=60000 && owners.Contains(owner),"AUTOMATION_UNPAIRED");
                if(op=="capabilities")return Reply(new {protocol=1,windows=true,profilepilot=AutomationBrowser.Available,stopped=Stopped});
                AutomationJson.Require(AutomationJson.Text(r,"instance")==instance,"AUTOMATION_STALE");
                string id=AutomationJson.Text(r,"requestId"),sessionId=AutomationJson.Text(r,"session");
                AutomationJson.Require(AutomationJson.Id(id) && AutomationJson.Id(sessionId));
                string key=owner+":"+id,hash=AutomationJson.Hash(line);Receipt old;
                if(receipts.TryGetValue(key,out old)){
                    AutomationJson.Require(old.Hash==hash,"AUTOMATION_ID_CONFLICT");
                    return old.Reply??Error("AUTOMATION_RECEIPT_EXPIRED");
                }
                AutomationJson.Require(receipts.Count<8192,"AUTOMATION_CAPACITY");
                var receipt=new Receipt{Hash=hash,Reply=Error("AUTOMATION_OUTCOME_UNKNOWN")};receipts.Add(key,receipt);
                try{
                    string sessionKey=owner+":"+sessionId;
                    if(op=="close"){
                        endedSessions.Add(sessionKey);
                        AutomationSession closed;if(sessions.TryGetValue(sessionKey,out closed)){closed.Dispose();sessions.Remove(sessionKey);}
                        receipt.Reply=Reply(new {closed=true});
                    }else{
                        AutomationJson.Require(!Stopped,"AUTOMATION_USER_STOPPED");
                        AutomationJson.Require(InputFocus.IsInteractiveDesktop(),"AUTOMATION_DESKTOP_LOCKED");
                        AutomationSession session;
                        if(!sessions.TryGetValue(sessionKey,out session)){
                            AutomationJson.Require(!endedSessions.Contains(sessionKey),"AUTOMATION_SESSION_ENDED");
                            AutomationJson.Require(sessions.Count<8,"AUTOMATION_CAPACITY");
                            session=new AutomationSession(owner,sessionId);sessions.Add(sessionKey,session);
                            session.Windows.Allowed=()=>!Stopped;
                        }
                        session.Access=now();Activity(true);
                        object raw;var p=r.TryGetValue("params",out raw)?AutomationJson.Map(raw):new Dictionary<string,object>();
                        object result;
                        if(op=="status")result=new {active=true};
                        else if(op=="profiles" || op=="profile" || op=="apps" || op.StartsWith("browser.",StringComparison.Ordinal))result=session.Browser.Handle(op,p);
                        else if(op=="windows" || op.StartsWith("window.",StringComparison.Ordinal)){
                            AutomationJson.Require(!sessions.Values.Any(s=>s!=session && s.Windows.HasObservation),"AUTOMATION_CONTROL_BUSY");
                            result=session.Windows.Handle(op,p);
                        }else throw new AutomationFault("AUTOMATION_BAD_REQUEST");
                        receipt.Reply=Reply(result);
                    }
                }catch(AutomationFault e){receipt.Reply=Error(e.Message);}
                catch(Exception){receipt.Reply=Error("AUTOMATION_OUTCOME_UNKNOWN");}
                receipt.Bytes=Encoding.UTF8.GetByteCount(AutomationJson.Json.Serialize(receipt.Reply));receiptBytes+=receipt.Bytes;
                // Keep replay tombstones even when large image receipts are dropped.
                if(receiptBytes>32*1024*1024)foreach(var item in receipts.Values.Where(x=>x!=receipt && x.Bytes>0).ToArray()){
                    receiptBytes-=item.Bytes;item.Bytes=0;item.Reply=null;if(receiptBytes<=16*1024*1024)break;
                }
                return receipt.Reply;
            }catch(AutomationFault e){return Error(e.Message);}catch(Exception){return Error("AUTOMATION_BAD_REQUEST");}
        }
        public void Dispose(){foreach(var session in sessions.Values)session.Dispose();sessions.Clear();Activity(false);}
    }
    public static class AutomationWorker {
        public static int Run(){
            using(var identity=WindowsIdentity.GetCurrent())if(identity.IsSystem || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
                return DesktopUserProcess.RunWorker("--automation-probe");
            int result=0;var thread=new Thread(()=>{result=RunUi();});thread.SetApartmentState(ApartmentState.STA);thread.Start();thread.Join();return result;
        }
        static int RunUi(){
            Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
            var clock=Stopwatch.StartNew();var manager=new AutomationManager(()=>clock.ElapsedMilliseconds);
            using(var tray=new NotifyIcon {Icon=System.Drawing.SystemIcons.Application,Text="ClipRelay AI",Visible=false})
            using(var context=new ApplicationContext()){
                var menu=new ContextMenuStrip();menu.Items.Add("停止 AI 控制",null,(s,e)=>{manager.Stopped=true;tray.Text="ClipRelay AI 已停止";});
                menu.Items.Add("允许新的 AI 控制",null,(s,e)=>{manager.Stopped=false;tray.Text="ClipRelay AI";});tray.ContextMenuStrip=menu;
                using(var dispatch=new Control()){
                    dispatch.CreateControl();var handle=dispatch.Handle;
                    manager.Activity=active=>{try{dispatch.BeginInvoke(new Action(()=>{tray.Visible=active || manager.Stopped;tray.Text=manager.Stopped?"ClipRelay AI 已停止":active?"ClipRelay AI 正在控制":"ClipRelay AI";}));}catch{}};
                    var thread=new Thread(()=>{
                        try{string line;while((line=Console.ReadLine())!=null){Console.WriteLine(AutomationJson.Json.Serialize(manager.Handle(line)));Console.Out.Flush();}}
                        finally{manager.Dispose();try{dispatch.BeginInvoke(new Action(context.ExitThread));}catch{}}
                    });thread.SetApartmentState(ApartmentState.MTA);thread.IsBackground=true;thread.Start();Application.Run(context);
                }
                tray.Visible=false;menu.Dispose();
            }
            return 0;
        }
    }
}
