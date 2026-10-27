using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Text.RegularExpressions;

namespace ClipRelay.Remote {
    public sealed class AutomationBrowser : IDisposable {
        sealed class Binding {public string Id,Name,Profile,Route;public int Port;public bool Uncertain;}
        public sealed class CommandResult {public int exitCode;public object data;public string text;public bool requiresObservation;}
        readonly Dictionary<string,Binding> bindings=new Dictionary<string,Binding>();
        readonly string session;
        static string Entry {get{return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".profilepilot","cli-bin","ppilot.ps1");}}
        public static bool Available {get{return File.Exists(Entry);}}
        public AutomationBrowser(string sessionId){session=sessionId;}
        static string Tab(Dictionary<string,object> p,bool gateway){
            object raw;AutomationJson.Require(p.TryGetValue("tabId",out raw));
            string tab=raw is int?((int)raw).ToString():gateway && raw is string?(string)raw:"";
            AutomationJson.Require(Regex.IsMatch(tab,gateway?"\\A(?:t?[0-9]{1,10}|[A-Fa-f0-9]{32})\\z":"\\A[0-9]{1,10}\\z"));return tab;
        }
        static string ReadBounded(StreamReader reader){var result=new StringBuilder();var buffer=new char[4096];int count;while((count=reader.Read(buffer,0,buffer.Length))>0){AutomationJson.Require(result.Length+count<=4*1024*1024,"AUTOMATION_OUTPUT_LIMIT");result.Append(buffer,0,count);}return result.ToString();}
        public static CommandResult Run(IEnumerable<string> arguments,object parameters=null){
            AutomationJson.Require(Available,"AUTOMATION_PPILOT_MISSING");
            var args=arguments.ToList();string temporary=null;
            try{
                if(parameters!=null){temporary=Path.GetTempFileName();File.WriteAllText(temporary,AutomationJson.Json.Serialize(parameters),new UTF8Encoding(false));args.Add("--params-file");args.Add(temporary);}
                // Only fixed launcher code goes through PowerShell. All user data
                // is decoded as a JSON argument array, never parsed as shell code.
                string data=Convert.ToBase64String(Encoding.UTF8.GetBytes(AutomationJson.Json.Serialize(args)));
                string script="$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $a=[string[]](ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+data+"')))); & '"+Entry.Replace("'","''")+"' @a; exit $LASTEXITCODE";
                var start=new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe"),"-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(script))){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};
                foreach(var key in new[]{"PROFILEPILOT_SESSION","AGENT_BROWSER_SESSION","CLAUDE_CODE_SESSION_ID","CODEX_THREAD_ID","PROFILEPILOT_LAUNCHER_ARGV"})start.EnvironmentVariables.Remove(key);
                using(var process=Process.Start(start)){
                    var stdout=Task.Run(()=>ReadBounded(process.StandardOutput));var stderr=Task.Run(()=>ReadBounded(process.StandardError));
                    if(!process.WaitForExit(30000)){try{process.Kill();}catch{}throw new AutomationFault("AUTOMATION_OUTCOME_UNKNOWN");}
                    AutomationJson.Require(Task.WaitAll(new Task[]{stdout,stderr},2000),"AUTOMATION_OUTCOME_UNKNOWN");
                    string text=stdout.Result.Trim();if(text.Length==0)text=stderr.Result.Trim();object value=null;try{value=AutomationJson.Json.DeserializeObject(text);}catch{}
                    return new CommandResult{exitCode=process.ExitCode,data=value,text=value==null?text:null,requiresObservation=process.ExitCode!=0};
                }
            }finally{if(temporary!=null)try{File.Delete(temporary);}catch{}}
        }
        static List<Dictionary<string,object>> Registry(){
            string file=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".profilepilot","gateway","managed-profiles.json");
            if(!File.Exists(file))return new List<Dictionary<string,object>>();
            AutomationJson.Require(new FileInfo(file).Length<=1024*1024,"AUTOMATION_PROFILE_CATALOG_INVALID");
            var root=AutomationJson.Map(AutomationJson.Json.DeserializeObject(File.ReadAllText(file,Encoding.UTF8)));object raw;
            AutomationJson.Require(root.TryGetValue("profiles",out raw) && raw is object[],"AUTOMATION_PROFILE_CATALOG_INVALID");
            return ((object[])raw).Select(AutomationJson.Map).ToList();
        }
        static Dictionary<string,object> Target(string id){
            AutomationJson.Require(id.Length>0 && id.Length<=256);
            var entries=Registry().Where(p=>AutomationJson.Text(p,"profileId")==id).ToArray();
            AutomationJson.Require(entries.Length==1,"AUTOMATION_TARGET_NOT_REGISTERED");var target=entries[0];
            AutomationJson.Require(!AutomationJson.Flag(target,"agentAccessDisabled"),"AUTOMATION_TARGET_BLOCKED");
            int port=AutomationJson.Number(target,"publicPort");AutomationJson.Require(port>=1024 && port<=65535,"AUTOMATION_PROFILE_CATALOG_INVALID");return target;
        }
        List<string> Prefix(Binding binding){
            var args=new List<string>{"browser","--session",binding.Name};
            if(binding.Route=="gateway"){
                var target=Target(binding.Profile);AutomationJson.Require(AutomationJson.Number(target,"publicPort")==binding.Port,"AUTOMATION_TARGET_CHANGED");args.Add("--cdp");args.Add(binding.Port.ToString());
            }else{args.Add("--profile");args.Add(binding.Profile);}
            return args;
        }
        CommandResult Invoke(Binding binding,string command,object parameters=null,params string[] trailing){
            var args=Prefix(binding);args.Add(command);args.AddRange(trailing);
            try{var result=Run(args,parameters);binding.Uncertain=result.exitCode!=0;return result;}
            catch{binding.Uncertain=true;throw;}
        }
        public object Handle(string op,Dictionary<string,object> p){
            AutomationJson.Require(Available,"AUTOMATION_PPILOT_MISSING");
            if(op=="profiles"){
                AutomationJson.Fields(p,"");var result=Run(new[]{"profile","list","--json"});
                if(result.exitCode==0 && result.data is Dictionary<string,object>){
                    var envelope=AutomationJson.Map(result.data);object raw;
                    if(envelope.TryGetValue("data",out raw)){
                        var data=AutomationJson.Map(raw);if(data.TryGetValue("profiles",out raw) && raw is object[]){
                            var registry=Registry();foreach(var item in ((object[])raw).Select(AutomationJson.Map)){
                                string profile=AutomationJson.Text(item,"id");bool native=profile.StartsWith("native:",StringComparison.Ordinal);
                                bool ready=native?AutomationJson.Flag(item,"task_ready"):registry.Any(r=>AutomationJson.Text(r,"profileId")==profile && !AutomationJson.Flag(r,"agentAccessDisabled"));
                                item["automationRoute"]=native?"extension":"gateway";item["automationReady"]=ready;
                                if(!ready)item["automationReason"]=native?"Connect the ProfilePilot extension in this exact Profile.":"Enable this Profile's Agent connection in ProfilePilot; ordinary browser startup does not enable it.";
                            }
                        }
                    }
                }
                return result;
            }
            if(op=="apps"){
                AutomationJson.Fields(p,"");return new {apps=Registry().Where(r=>AutomationJson.Text(r,"profileId").StartsWith("local-app:",StringComparison.Ordinal)).Select(r=>new {id=AutomationJson.Text(r,"profileId"),name=AutomationJson.Text(r,"profileName"),available=!AutomationJson.Flag(r,"agentAccessDisabled")}).ToArray()};
            }
            if(op=="profile"){
                AutomationJson.Fields(p,"command,profileId,name,hideAutomation");string command=AutomationJson.Text(p,"command"),id=AutomationJson.Text(p,"profileId"),name=AutomationJson.Text(p,"name");
                AutomationJson.Require(new[]{"get","create","rename","start","stop","delete","configure"}.Contains(command));
                var args=new List<string>{"profile",command};
                if(command=="create"){AutomationJson.Require(name.Length>0 && name.Length<=128 && !name.StartsWith("-"));args.Add("--name");args.Add(name);}
                else{
                    AutomationJson.Require(id.Length>0 && id.Length<=256 && !id.StartsWith("-"));
                    // The ProfilePilot manager enforces manageable and occupancy.
                    if(command!="get")AutomationJson.Require(id.StartsWith("isolated:",StringComparison.Ordinal),"AUTOMATION_PROFILE_QUERY_ONLY");
                    args.Add(id);
                    if(command=="rename"){AutomationJson.Require(name.Length>0 && name.Length<=128 && !name.StartsWith("-"));args.Add(name);}
                    if(command=="delete")args.Add("--yes");
                    if(command=="configure"){args.Add("--hide-automation");args.Add(AutomationJson.Flag(p,"hideAutomation")?"on":"off");}
                }
                args.Add("--json");return Run(args);
            }
            if(op=="browser.tabs" && !p.ContainsKey("browserId")){
                AutomationJson.Fields(p,"profileId");string profile=AutomationJson.Text(p,"profileId");AutomationJson.Require(profile.StartsWith("native:",StringComparison.Ordinal) && profile.Length<=256);
                return Run(new[]{"browser","--profile",profile,"tabs"});
            }
            if(op=="browser.open"){
                AutomationJson.Fields(p,"profileId,tabId,newTab");AutomationJson.Require(bindings.Count<8,"AUTOMATION_CAPACITY");
                string profile=AutomationJson.Text(p,"profileId");AutomationJson.Require(profile.Length>0 && profile.Length<=256);
                var binding=new Binding{Id=Guid.NewGuid().ToString("N"),Profile=profile};binding.Name="cliprelay-"+session+"-"+binding.Id.Substring(0,8);
                if(profile.StartsWith("native:",StringComparison.Ordinal)){
                    binding.Route="extension";AutomationJson.Require(p.ContainsKey("tabId")!=AutomationJson.Flag(p,"newTab"));
                }else{binding.Route="gateway";binding.Port=AutomationJson.Number(Target(profile),"publicPort");AutomationJson.Require(!p.ContainsKey("tabId") && !p.ContainsKey("newTab"));}
                bindings.Add(binding.Id,binding);CommandResult result;
                if(binding.Route=="gateway")result=Invoke(binding,"observe");
                else if(AutomationJson.Flag(p,"newTab"))result=Invoke(binding,"claim",null,"--new-tab");
                else{int tab=AutomationJson.Number(p,"tabId",-1);AutomationJson.Require(tab>=0);result=Invoke(binding,"claim",null,"--tab",tab.ToString());}
                return new {browserId=binding.Id,route=binding.Route,result};
            }
            string browserId=AutomationJson.Text(p,"browserId");Binding current;
            AutomationJson.Require(bindings.TryGetValue(browserId,out current),"AUTOMATION_BROWSER_NOT_FOUND");
            if(op=="browser.close"){
                AutomationJson.Fields(p,"browserId");var result=Invoke(current,"complete");if(result.exitCode==0)bindings.Remove(browserId);return result;
            }
            if(op=="browser.handoff" || op=="browser.resume"){
                AutomationJson.Fields(p,"browserId");return Invoke(current,op=="browser.handoff"?"handoff":"resume");
            }
            if(op=="browser.observe" || op=="browser.tabs"){
                AutomationJson.Fields(p,"browserId");return op=="browser.observe"?Invoke(current,"observe"):current.Route=="gateway"?Invoke(current,"tab",null,"list"):Invoke(current,"tabs");
            }
            AutomationJson.Require(!current.Uncertain,"AUTOMATION_OBSERVATION_REQUIRED");
            if(op=="browser.action"){
                AutomationJson.Fields(p,"browserId,action");object raw;AutomationJson.Require(p.TryGetValue("action",out raw));var action=AutomationJson.Map(raw);
                string kind=AutomationJson.Text(action,"kind");AutomationJson.Require(new[]{"click","hover","fill","select","check","uncheck","press","scroll","upload"}.Contains(kind));
                return Invoke(current,"action",action);
            }
            if(op=="browser.navigate"){
                AutomationJson.Fields(p,"browserId,url,tabId,newTab");
                if(p.ContainsKey("tabId")){
                    AutomationJson.Require(!p.ContainsKey("url") && !p.ContainsKey("newTab"));string tab=Tab(p,current.Route=="gateway");
                    return current.Route=="gateway"?Invoke(current,"tab",null,tab):Invoke(current,"switch",new {tabId=AutomationJson.Number(p,"tabId",-1)});
                }
                string url=AutomationJson.Text(p,"url");Uri parsed;AutomationJson.Require(Uri.TryCreate(url,UriKind.Absolute,out parsed) && (parsed.Scheme=="http" || parsed.Scheme=="https" || url=="about:blank"));
                if(AutomationJson.Flag(p,"newTab"))return current.Route=="gateway"?Invoke(current,"tab",null,"new",url):Invoke(current,"newTab",new {url});
                return current.Route=="gateway"?Invoke(current,"open",null,url):Invoke(current,"open",new {url});
            }
            if(op=="browser.tab_close"){
                AutomationJson.Fields(p,"browserId,tabId");string tab=Tab(p,current.Route=="gateway");
                AutomationJson.Require(!current.Profile.StartsWith("local-app:",StringComparison.Ordinal),"AUTOMATION_ACTION_UNSUPPORTED");
                return current.Route=="gateway"?Invoke(current,"tab",null,"close",tab):Invoke(current,"closeTab",new {tabId=AutomationJson.Number(p,"tabId",-1)});
            }
            throw new AutomationFault("AUTOMATION_BAD_REQUEST");
        }
        public void Dispose(){foreach(var binding in bindings.Values)try{Invoke(binding,"release");}catch{}bindings.Clear();}
    }
}
