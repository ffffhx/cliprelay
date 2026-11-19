using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace ClipRelay.Remote {
    // The phone selects IDs from this catalog. Paths and argv are resolved only
    // from the desktop user's existing Herdr projects and program settings.
    public sealed class HerdrProjects {
        public sealed class Project {
            public string id,name,folder,reason;
            public bool available;
            public Dictionary<string,string> Tabs=new Dictionary<string,string>();
            public object Display(){return new {id=id,name=name,folder=folder,available=available,reason=reason};}
        }
        public sealed class Agent {
            public string id,name,reason,source,command;
            public bool available;
            public string[] Argv;
            public object Display(){return new {id=id,name=name,available=available,reason=reason,source=source,command=command};}
        }
        public readonly List<Project> Projects=new List<Project>();
        public readonly Dictionary<string,Project> ByTerminal=new Dictionary<string,Project>();
        public readonly Dictionary<string,string> TabNames=new Dictionary<string,string>();
        static List<Agent> agents;
        static DateTime checkedAt;
        static readonly object agentGate=new object();
        public HerdrProjects(HerdrRpc rpc) {
            var document=rpc.Call("doc.get",new {name="herdr-app"});object value;
            if(!document.TryGetValue("value",out value)||value==null)return;
            foreach(var raw in HerdrJson.Array(HerdrJson.Map(value),"spaces")) {
                var space=HerdrJson.Map(raw);var p=new Project{id=HerdrJson.Text(space,"id"),name=HerdrJson.Text(space,"name"),folder=HerdrJson.Text(space,"folder"),reason=""};
                if(p.id.Length==0||p.id.Length>128)continue;
                if(p.name.Length==0)p.name=FolderName(p.folder);
                p.available=Path.IsPathRooted(p.folder)&&Directory.Exists(p.folder);if(!p.available)p.reason="项目目录不存在";
                Projects.Add(p);HerdrJson.Require(Projects.Count<=1024,"HERDR_CAPACITY");
                foreach(var rawTab in HerdrJson.Array(space,"tabs")) {
                    var tab=HerdrJson.Map(rawTab);string name=HerdrJson.Text(tab,"name");p.Tabs[HerdrJson.Text(tab,"id")]=name;
                    object root;if(tab.TryGetValue("root",out root))Walk(root,p,name);
                }
            }
        }
        void Walk(object value,Project project,string name) {
            var obj=value as Dictionary<string,object>;
            if(obj!=null){string address=HerdrJson.Text(obj,"terminal");if(address.Length>0){ByTerminal[address]=project;TabNames[address]=name;}foreach(var child in obj.Values)Walk(child,project,name);}
            var array=value as object[];if(array!=null)foreach(var child in array)Walk(child,project,name);
        }
        public static string FolderName(string path){if(String.IsNullOrEmpty(path))return "未归属项目";string clean=path.TrimEnd('/','\\');int at=clean.LastIndexOfAny(new[]{'/','\\'});return at<0?clean:clean.Substring(at+1);}
        static string Normalize(string path){try{return Path.GetFullPath(path).TrimEnd('\\','/');}catch{return path;}}
        static Dictionary<string,object> Child(Dictionary<string,object> value,string key){object item;return value.TryGetValue(key,out item)&&item is Dictionary<string,object>?(Dictionary<string,object>)item:new Dictionary<string,object>();}
        static string AgentName(string agent){return agent=="codex"?"Codex":agent=="claude"?"Claude Code":agent=="grok"?"Grok":agent=="gemini"?"Gemini":agent.Length>0?agent:"终端";}
        static bool Shell(string program){return Regex.IsMatch(program,@"(?i)^(?:powershell|pwsh|cmd|bash|zsh|sh|fish|nu|node|python|terminal)(?:\.exe)?$");}
        public static string CurrentAgent(Dictionary<string,object> t){
            string reported=HerdrJson.Text(Child(t,"status"),"app").ToLowerInvariant();
            if(reported=="claude-code")reported="claude";
            if(AgentId(reported)&&!Shell(reported))return reported;
            var fg=Child(t,"foreground");string program=CommandName(HerdrJson.Text(fg,"name"));
            // A shell's original argv can still mention Codex after it exited.
            // Only its live status identifies an Agent inside that shell.
            if(Regex.IsMatch(program,@"(?i)^(?:powershell|pwsh|cmd|bash|zsh|sh|fish|nu)$"))return "";
            string command=program+" "+String.Join(" ",HerdrJson.Array(fg,"argv").OfType<string>());
            foreach(string id in new[]{"codex","claude","grok","gemini","opencode","aider"})
                if(Regex.IsMatch(command,@"(?i)(?:^|[/\\\s'""@])"+id+@"(?:\.(?:exe|cmd|bat|js|mjs))?(?:[\s'""]|$)"))return id;
            string configured=HerdrJson.Text(Child(t,"labels"),"cliprelay.agent");
            return program.Length>0&&!Shell(program)&&AgentId(configured)?configured:"";
        }
        static string CleanTitle(string title){return Regex.Replace(title.Trim(),@"^[\u2800-\u28ff\u2022\u00b7\u25cf\u2713\u2714\u25cb\s]+","").Trim();}
        static bool GenericTitle(string title,string agentName){
            return title.Length==0||title.Equals(agentName,StringComparison.OrdinalIgnoreCase)||
                Regex.IsMatch(title,@"(?i)^(?:(?:codex|claude(?: code)?|grok|gemini|terminal|终端)(?:\s*[·#-]\s*\d+)?|\d+|(?:.*[/\\])?(?:powershell|pwsh|cmd)(?:\.exe)?)$");
        }
        public static string SessionTitle(Dictionary<string,object> t,string tabName,string agentName,string projectName){
            string current=CleanTitle(HerdrJson.Text(t,"title"));
            string suffix=" | "+projectName;if(projectName.Length>0&&current.EndsWith(suffix,StringComparison.OrdinalIgnoreCase))current=current.Substring(0,current.Length-suffix.Length).Trim();
            string name=HerdrJson.Text(t,"name");if(name.StartsWith("cr-",StringComparison.Ordinal)||name.StartsWith("hdr-recover-",StringComparison.Ordinal))name="";
            foreach(string candidate in new[]{current,HerdrJson.Text(Child(t,"labels"),"cliprelay.title"),tabName??"",name}){
                string title=CleanTitle(candidate);if(!GenericTitle(title,agentName))return title;
            }
            return agentName+" · "+HerdrJson.Text(t,"address");
        }
        public Dictionary<string,object> Display(Dictionary<string,object> t) {
            string address=HerdrJson.Text(t,"address"),cwd=HerdrJson.Text(t,"cwd");var labels=Child(t,"labels");var fg=Child(t,"foreground");
            Project p;ByTerminal.TryGetValue(address,out p);
            if(p==null)p=Projects.FirstOrDefault(x=>x.id==HerdrJson.Text(labels,"herdr.space"));
            if(p==null && cwd.Length>0 && !address.Contains("/"))p=Projects.FirstOrDefault(x=>String.Equals(Normalize(x.folder),Normalize(cwd),StringComparison.OrdinalIgnoreCase));
            string program=HerdrJson.Text(fg,"name"),agent=CurrentAgent(t),agentName=AgentName(agent);
            string tabName="";TabNames.TryGetValue(address,out tabName);
            if(String.IsNullOrEmpty(tabName)&&p!=null)p.Tabs.TryGetValue(HerdrJson.Text(labels,"herdr.tab"),out tabName);
            string title=SessionTitle(t,tabName,agentName,p==null?FolderName(cwd):p.name);
            long seen;bool unread=Int64.TryParse(HerdrJson.Text(labels,"herdr.seen"),out seen)&&HerdrJson.Number(t,"turn")>seen;
            object rawUpdated;long updated=t.TryGetValue("status_ms",out rawUpdated)&&(rawUpdated is long||rawUpdated is int)?Convert.ToInt64(rawUpdated):0;
            object status;t.TryGetValue("status",out status);
            return HerdrJson.Object("address",address,"title",title,"name",title,"cwd",cwd,"state",HerdrJson.Text(t,"state"),"status",status,"program",program,"agent",agent,"agentName",agentName,
                "projectId",p==null?"":p.id,"projectName",p==null?FolderName(cwd):p.name,"columns",HerdrJson.Number(t,"cols"),"rows",HerdrJson.Number(t,"rows"),"turn",HerdrJson.Number(t,"turn"),"createdMs",HerdrJson.Number(t,"created_ms"),
                "updatedMs",Math.Max(HerdrJson.Number(t,"created_ms"),updated),"unread",unread);
        }
        public static string Quote(string word){var b=new StringBuilder("'");foreach(char c in word){if("'‘’‚‛".IndexOf(c)>=0)b.Append(c);b.Append(c);}return b.Append("'").ToString();}
        public static string PowerShell {get{return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe");}}
        public static bool AgentId(string id){return id!=null&&Regex.IsMatch(id,"\\A[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\\z");}
        static string CommandName(string path){string name=Path.GetFileName(path);return Regex.Replace(name,@"(?i)\.(exe|cmd|bat|ps1|com)$","");}
        public static List<Agent> FeaturedAgents(){return Agents().Where(a=>a.source!="cli").Take(128).ToList();}
        public static object SearchAgents(string query){
            var all=Agents();var matches=(query.Length==0?all.Where(a=>a.source!="cli"):all.Where(a=>a.name.IndexOf(query,StringComparison.OrdinalIgnoreCase)>=0||a.command.IndexOf(query,StringComparison.OrdinalIgnoreCase)>=0))
                .OrderByDescending(a=>a.available).ThenBy(a=>a.source=="cli"?1:0).ThenBy(a=>a.name,StringComparer.OrdinalIgnoreCase).ToList();
            return new {agents=matches.Take(80).Select(a=>a.Display()).ToArray(),total=matches.Count};
        }
        public static List<Agent> Agents(bool fresh=false){lock(agentGate){
            if(!fresh&&agents!=null&&(DateTime.UtcNow-checkedAt).TotalSeconds<60)return agents;
            // Names improve discovery only; arbitrary installed CLIs remain searchable.
            string[] common={"codex|Codex","claude|Claude Code","gemini|Gemini","opencode|OpenCode","aider|Aider","cursor-agent|Cursor Agent","copilot|Copilot","amp|Amp","goose|Goose","qwen|Qwen Code","kimi|Kimi","kiro-cli|Kiro","crush|Crush","pi|Pi","qodercli|Qoder","auggie|Auggie","kilo|Kilo Code","grok|Grok","hermes|Hermes"};
            var found=common.Select(entry=>entry.Split('|')).Select(v=>new Agent{id=v[0],name=v[1],Argv=new[]{v[0]},source="detected",command=v[0]}).ToList();
            string appHome=Environment.GetEnvironmentVariable("HERDR_APP_HOME");if(String.IsNullOrEmpty(appHome))appHome=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".config","herdr-app");
            string config=Path.Combine(appHome,"programs.json");
            try {if(File.Exists(config)) {
                var programs=Child(HerdrJson.Map(HerdrJson.Serializer().DeserializeObject(File.ReadAllText(config))),"programs");
                foreach(var pair in programs){var entry=pair.Value as Dictionary<string,object>;if(entry==null||!entry.ContainsKey("run"))continue;
                    string id=AgentId(pair.Key)?pair.Key:"configured-"+Hash(pair.Key).Substring(0,24);var run=HerdrJson.Array(entry,"run");
                    var a=new Agent{id=id,name=HerdrJson.Text(entry,"name",pair.Key),source="configured",Argv=run.Length>0&&run.Length<=64&&run.All(x=>x is string&&((string)x).Length<4096&&!((string)x).Any(c=>c=='\0'||c=='\r'||c=='\n'))?run.Cast<string>().ToArray():new string[0]};
                    if(a.name.Length==0||a.name.Length>128)a.name=id;a.command=a.Argv.Length>0?CommandName(a.Argv[0]):id;if(a.command.Length>128)a.command=a.command.Substring(0,128);found.RemoveAll(x=>x.id==id);found.Add(a);
                }
            }}catch{throw new HerdrFault("HERDR_AGENT_CONFIG");}
            // Inspect commands; never launch them for discovery. Re-read the user's
            // PATH so an installation becomes visible without restarting the service.
            string script="$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); $env:Path=$env:Path+';'+[Environment]::GetEnvironmentVariable('Path','User'); $items=@(Get-Command -CommandType Application,ExternalScript | Select-Object Name,Source); [Console]::WriteLine((ConvertTo-Json -InputObject $items -Compress))";
            string output="";
            try {
                var start=new ProcessStartInfo(PowerShell,"-NoLogo -NoProfile -NonInteractive -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(script))){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
                using(var process=Process.Start(start)){var stdout=process.StandardOutput.ReadToEndAsync();var stderr=process.StandardError.ReadToEndAsync();if(process.WaitForExit(6000)){output=stdout.Result;}else process.Kill();}
            }catch{}
            var commands=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            try{foreach(var raw in (object[])HerdrJson.Serializer().DeserializeObject(output)){
                var item=HerdrJson.Map(raw);string path=HerdrJson.Text(item,"Source"),name=CommandName(HerdrJson.Text(item,"Name"));
                if(name.Length==0||name.Length>128||name.Any(Char.IsControl)||!Path.IsPathRooted(path)||!File.Exists(path))continue;
                if(!commands.ContainsKey(name))commands[name]=path;
            }}catch{throw new HerdrFault("HERDR_AGENT_DISCOVERY");}
            var used=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach(var a in found){string path="";
                if(a.Argv.Length>0){if(Path.IsPathRooted(a.Argv[0])&&File.Exists(a.Argv[0]))path=a.Argv[0];else if(a.Argv[0].IndexOfAny(new[]{'/','\\'})<0)commands.TryGetValue(CommandName(a.Argv[0]),out path);}
                a.available=!String.IsNullOrEmpty(path);a.reason=a.available?"":a.Argv.Length==0?"启动配置无效":"电脑尚未安装";
                if(a.available){used.Add(CommandName(a.Argv[0]));a.Argv[0]=path;}
            }
            found.RemoveAll(a=>a.source=="detected"&&!a.available);
            foreach(var command in commands)if(!used.Contains(command.Key))found.Add(new Agent{id="cli-"+Hash(command.Value.ToLowerInvariant()).Substring(0,32),name=command.Key,command=command.Key,source="cli",available=true,reason="",Argv=new[]{command.Value}});
            agents=found;checkedAt=DateTime.UtcNow;return agents;
        }}
        static string Hash(string text){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-","").ToLowerInvariant();}
        public object Create(HerdrRpc rpc,string owner,string core,string id,string projectId,string agentId,string name) {
            string key=Hash(owner+"\n"+core+"\n"+id),fingerprint=Hash(projectId+"\n"+agentId+"\n"+name);
            string directory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ClipRelay","herdr-launches");
            Directory.CreateDirectory(directory);string path=Path.Combine(directory,key+".json");
            // A durable reservation precedes dispatch. Across service restarts,
            // unknown requests are reconciled by a label, never launched again.
            bool reserved=File.Exists(path);
            if(reserved){var saved=HerdrJson.Map(HerdrJson.Serializer().DeserializeObject(File.ReadAllText(path)));HerdrJson.Require(HerdrJson.Text(saved,"fingerprint")==fingerprint,"HERDR_CONFLICT");}
            var matches=HerdrJson.Array(rpc.Call("terminal.list",new {all=true,labels=HerdrJson.Object("cliprelay.request",key)}),"terminals");
            if(matches.Length>0){var t=HerdrJson.Map(matches[0]);HerdrJson.Require(HerdrJson.Text(Child(t,"labels"),"cliprelay.fingerprint")==fingerprint,"HERDR_CONFLICT");return HerdrJson.Object("id",id,"terminal",Display(t));}
            HerdrJson.Require(!reserved,"HERDR_CREATE_UNCERTAIN");
            var project=Projects.FirstOrDefault(x=>x.id==projectId);HerdrJson.Require(project!=null,"HERDR_PROJECT_NOT_FOUND");HerdrJson.Require(project.available,"HERDR_PROJECT_UNAVAILABLE");
            var agent=Agents(true).FirstOrDefault(x=>x.id==agentId);HerdrJson.Require(agent!=null&&agent.available,"HERDR_AGENT_UNAVAILABLE");
            if(name.Length==0){var live=HerdrJson.Array(rpc.Call("terminal.list",new {all=true,labels=HerdrJson.Object("herdr.space",projectId,"cliprelay.agent",agentId)}),"terminals");name=agent.name+" · "+(live.Length+1);}
            var labels=HerdrJson.Object("herdr.space",projectId,"herdr.tab","tb"+id,"herdr.seen","0","cliprelay.request",key,"cliprelay.fingerprint",fingerprint,"cliprelay.agent",agentId,"cliprelay.agentName",agent.name,"cliprelay.title",name);
            using(var file=new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {byte[] bytes=Encoding.UTF8.GetBytes(HerdrJson.Serializer().Serialize(new {fingerprint=fingerprint}));file.Write(bytes,0,bytes.Length);file.Flush(true);}
            string line="& "+String.Join(" ",agent.Argv.Select(Quote));
            if(agent.id=="codex"&&agent.Argv.Length==1){
                // Inline mode retains real scrollback so phones can read without
                // sending Page Up/Down. Preserve configured launch arguments.
                string command=Quote(agent.Argv[0]);
                line="$cliprelayHelp=(& "+command+" --help 2>$null | Out-String); $cliprelayArgs=@(); foreach($cliprelayFlag in @('--no-alt-screen')){if($cliprelayHelp.Contains($cliprelayFlag)){$cliprelayArgs+=$cliprelayFlag}}; & "+command+" @cliprelayArgs";
            }
            var result=rpc.Call("terminal.run",new {argv=new[]{PowerShell,"-NoLogo","-NoExit","-Command",line},cwd=project.folder,labels=labels,name="cr-"+key.Substring(0,29),keep=true,no_parent=true,wait=false,size=new {cols=100,rows=30},env=new {TERM="xterm-256color",COLORTERM="truecolor",TERM_PROGRAM="herdr"}});
            var terminal=rpc.Call("terminal.get",new {terminal=HerdrJson.Text(result,"address")});
            var display=Display(terminal);
            // This receipt describes the launch just requested. Later catalog
            // reads use current foreground facts, so an exited Agent is hidden.
            display["agent"]=agent.id;display["agentName"]=agent.name;
            display["title"]=name;display["name"]=name;
            return HerdrJson.Object("id",id,"terminal",display);
        }
    }
}
