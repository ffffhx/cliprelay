using System;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using ClipRelay.Remote;
public static class HerdrTests {
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]static extern IntPtr GetStdHandle(int n);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]static extern bool GetConsoleMode(IntPtr handle,out uint mode);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]static extern bool SetConsoleMode(IntPtr handle,uint mode);
    [System.Runtime.InteropServices.DllImport("kernel32.dll")]static extern bool ReadFile(IntPtr handle,byte[] bytes,uint count,out uint read,IntPtr overlapped);
    static int InputFixture(string output){
        IntPtr input=GetStdHandle(-10),screen=GetStdHandle(-11);uint inputMode,screenMode;
        if(!GetConsoleMode(input,out inputMode)||!GetConsoleMode(screen,out screenMode))return 3;
        try{
            SetConsoleMode(input,0x200);SetConsoleMode(screen,screenMode|4);
            Console.InputEncoding=new System.Text.UTF8Encoding(false);Console.OutputEncoding=new System.Text.UTF8Encoding(false);
            Console.Write("\x1b[?9001h\x1b[>9u\x1b[?2004hINPUT_FIXTURE_READY\r\n");Console.Out.Flush();
            File.WriteAllText(output+".ready","ready");
            using(var captured=new MemoryStream()){
                byte[] buffer=new byte[4096];uint count;
                while(captured.Length<32768&&ReadFile(input,buffer,(uint)buffer.Length,out count,IntPtr.Zero)&&count>0){
                    captured.Write(buffer,0,(int)count);File.WriteAllBytes(output,captured.ToArray());
                    if(System.Text.Encoding.UTF8.GetString(captured.ToArray()).EndsWith("\x1b[1;2D"))break;
                }
            }
            return 0;
        }finally{SetConsoleMode(input,inputMode);SetConsoleMode(screen,screenMode);}
    }
    static void Check(bool ok,string name){if(!ok)throw new Exception(name);Console.WriteLine("PASS "+name);}
    static string Key(HerdrInputEncoding input,string key){return System.Text.Encoding.UTF8.GetString(input.Key(key));}
    static void Observe(HerdrInputEncoding input,string output){input.Observe(System.Text.Encoding.UTF8.GetBytes(output));}
    public static int Main(string[] args) {
        if(args.Length==2&&args[0]=="--input-fixture")return InputFixture(args[1]);
        if(args.Length==1&&args[0]=="--input-test"){
            var input=new HerdrInputEncoding();Check(Key(input,"enter")=="\r","legacy Enter");
            Observe(input,"\x1b[?900");Observe(input,"1h");
            Check(Key(input,"enter")=="\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_","Windows Enter has press and release");
            Check(Key(input,"ctrl+v").Contains("[86;0;22;1;8;1_"),"Windows clipboard chord retains Ctrl");
            Check(Key(input,"down").Contains("[40;80;0;1;256;1_"),"Windows arrow is an extended key");
            Check(Key(input,"shift+left")=="\x1b[37;75;0;1;272;1_\x1b[37;75;0;0;272;1_","Windows Shift Left presses and releases the same chord");
            Observe(input,"\x1b[?9001l\x1b[>9u");Check(Key(input,"enter")=="\x1b[13u","Kitty all-keys mode encodes Enter");
            Observe(input,"\x1b[>0u");Check(Key(input,"enter")=="\r","nested keyboard mode");Observe(input,"\x1b[<u");Check(Key(input,"enter")=="\x1b[13u","keyboard mode pop restores previous flags");
            Observe(input,"\x1b[<u\x1b[?1h");Check(Key(input,"down")=="\x1bOB","application cursor mode");
            Observe(input,"\x1b[?2004h");Check(System.Text.Encoding.UTF8.GetString(input.Paste("hello\nworld"))=="\x1b[200~hello\nworld\x1b[201~","multiline paste kept separate from submit");
            Check(Key(input,"shift+left")=="\x1b[1;2D","modified arrow ignores application cursor mode");
            for(int flags=1;flags<=31;flags++)foreach(bool win32First in new[]{true,false}){
                var mixed=new HerdrInputEncoding();
                if(win32First)Observe(mixed,"\x1b[?9001h");
                Observe(mixed,"\x1b[>"+flags+"u");
                if(!win32First)Observe(mixed,"\x1b[?9001h");
                Check(Key(mixed,"enter")==((flags&8)!=0?"\x1b[13u":"\r")&&Key(mixed,"esc")=="\x1b[27u"&&Key(mixed,"ctrl+c")==((flags&9)!=0?"\x1b[99;5u":"\x03")&&Key(mixed,"shift+left")=="\x1b[1;2D","Kitty overrides outer ConPTY flags="+flags+" win32First="+win32First);
            }
            var screens=new HerdrInputEncoding();Observe(screens,"\x1b[?9001h\x1b[>1u\x1b[?1049h");
            Check(Key(screens,"enter").Contains(";1;0;1_"),"alternate screen starts with its own keyboard mode");
            Observe(screens,"\x1b[>9u\x1b[?1049l");Check(Key(screens,"a")=="a"&&Key(screens,"enter")=="\r","normal screen restores its keyboard mode");
            Observe(screens,"\x1b[?1049h");Check(Key(screens,"a")=="\x1b[97u","alternate keyboard mode retained");
            for(int n=0;n<40;n++)Observe(screens,"\x1b[>9u");Observe(screens,"\x1b[<99u");Check(Key(screens,"enter").Contains(";1;0;1_"),"overflowing mode stack still restores legacy input");
            var facts=HerdrJson.Object("address","t99","title","⠦ 修复手机发送 | cliprelay","status",HerdrJson.Object("app","codex","state","working"),"foreground",HerdrJson.Object("name","powershell.exe","argv",new object[]{"powershell.exe","-Command","& codex"}),"labels",HerdrJson.Object("cliprelay.agent","codex"));
            Check(HerdrProjects.CurrentAgent(facts)=="codex","status recognizes Codex inside PowerShell");
            Check(HerdrProjects.SessionTitle(facts,"Codex","Codex","cliprelay")=="修复手机发送","real session title wins over generic tab name");
            facts["status"]=null;facts["title"]="Windows PowerShell";
            Check(HerdrProjects.CurrentAgent(facts)=="","old labels and launch argv cannot turn an idle shell into an Agent");
            facts["status"]=HerdrJson.Object("app","grok","state","idle");Check(HerdrProjects.CurrentAgent(facts)=="grok","Grok session retained");
            facts["status"]=HerdrJson.Object("app","claude-code","state","done");Check(HerdrProjects.CurrentAgent(facts)=="claude","Claude Code status normalized");
            facts["title"]="Codex";Check(HerdrProjects.SessionTitle(facts,"手机连接排查","Codex","cliprelay")=="手机连接排查","custom name remains a useful fallback");
            return 0;
        }
        if(args.Length==1 && args[0]=="--herdr-probe") {
            using(var identity=WindowsIdentity.GetCurrent())if(identity.IsSystem || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))return DesktopUserProcess.RunWorker("--herdr-probe");
            string setup=Path.Combine(Path.GetDirectoryName(typeof(HerdrTests).Assembly.Location),"test-session.json");
            if(File.Exists(setup)) {
                var config=new JavaScriptSerializer().Deserialize<Dictionary<string,string>>(File.ReadAllText(setup));
                if(!config["session"].StartsWith("cliprelay-check-"))throw new Exception("Not an isolated test session");
                var start=new ProcessStartInfo(config["hc"],"server start"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
                start.EnvironmentVariables["HC_SESSION"]=config["session"];start.EnvironmentVariables["XDG_STATE_HOME"]=config["state"];
                foreach(var key in new[]{"HC_SOCKET","HC_TERMINAL_ID","HC_TERMINAL_SOCKET","HC_CALLER"})start.EnvironmentVariables.Remove(key);
                using(var process=Process.Start(start)){string output=process.StandardOutput.ReadToEnd(),error=process.StandardError.ReadToEnd();process.WaitForExit();if(process.ExitCode!=0)throw new Exception(error+output);}
            }
            string agentSetup=Path.Combine(Path.GetDirectoryName(typeof(HerdrTests).Assembly.Location),"test-agents.json");
            if(File.Exists(agentSetup)){
                var config=new JavaScriptSerializer().Deserialize<Dictionary<string,string>>(File.ReadAllText(agentSetup));
                Environment.SetEnvironmentVariable("HERDR_APP_HOME",config["home"]);
                Environment.SetEnvironmentVariable("PATH",config["bin"]+";"+Environment.GetEnvironmentVariable("PATH"));
            }
            return HerdrWorker.Run();
        }
        Console.Error.WriteLine("Expected --herdr-probe");return 2;
    }
}
