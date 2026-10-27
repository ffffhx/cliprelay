using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Windows.Forms;
using ClipRelay.Remote;

public static class AutomationNativeTest {
    static void Check(bool ok,string message){if(!ok)throw new Exception(message);}
    static Dictionary<string,object> Map(object value){return AutomationJson.Map(AutomationJson.Json.DeserializeObject(AutomationJson.Json.Serialize(value)));}
    static Dictionary<string,object> Result(AutomationReply reply){Check(reply.ok,reply.code);return Map(reply.result);}
    [STAThread] public static int Main(string[] args){
        if(args.Length==1 && args[0]=="--automation-probe")return ServeFixture();
        Application.EnableVisualStyles();Exception failure=null;int clicks=0;long time=0;
        using(var form=new Form{Text="ClipRelay AI isolated fixture",Width=560,Height=320}){
            var input=new TextBox{Left=30,Top=30,Width=300,AccessibleName="AI fixture input"};
            var button=new Button{Left=30,Top=80,Width=150,Text="AI fixture button",AccessibleName="AI fixture button"};
            var password=new TextBox{Left=30,Top=130,Width=300,UseSystemPasswordChar=true,Text="test-secret-must-not-leak",AccessibleName="password"};
            button.Click+=(s,e)=>clicks++;
            form.Controls.AddRange(new Control[]{input,button,password});
            form.Shown+=(s,e)=>{
                var thread=new Thread(()=>{
                    try{using(var manager=new AutomationManager(()=>time)){
                        string owner=new string('a',64),other=new string('b',64),session=Guid.NewGuid().ToString("N");
                        Check(manager.Handle(AutomationJson.Json.Serialize(new {op="sync",owners=new[]{owner,other}})).ok,"sync");
                        string instance=manager.Handle(AutomationJson.Json.Serialize(new {op="capabilities",owner})).instance;
                        Func<string,object,string> wire=(op,p)=>AutomationJson.Json.Serialize(new {op,owner,instance,session,requestId=Guid.NewGuid().ToString("N"),@params=p});
                        Func<string,object,AutomationReply> call=(op,p)=>manager.Handle(wire(op,p));
                        var windows=Result(call("windows",new {}));
                        var target=((object[])windows["windows"]).Select(AutomationJson.Map).Single(w=>(int)w["pid"]==Process.GetCurrentProcess().Id && (string)w["title"]==form.Text);
                        string windowId=(string)target["id"];
                        Func<Dictionary<string,object>> observe=()=>Result(call("window.observe",new {windowId}));
                        Func<Dictionary<string,object>,string,Dictionary<string,object>> find=(snapshot,name)=>((object[])snapshot["elements"]).Select(AutomationJson.Map).Single(n=>(string)n["name"]==name);
                        var state=observe();Check(!AutomationJson.Json.Serialize(state).Contains("test-secret-must-not-leak"),"password text leaked");
                        var edit=find(state,"AI fixture input");string value="你好 ClipRelay & $() ` quotes \"";
                        Result(call("window.action",new {version=state["version"],@ref=edit["reference"],kind="set_value",value}));
                        string actual=null;form.Invoke(new Action(()=>actual=input.Text));Check(actual==value,"UIA did not set actual control value");
                        state=observe();var buttonState=find(state,"AI fixture button");
                        string action=wire("window.action",new {version=state["version"],@ref=buttonState["reference"],kind="invoke"});
                        Result(manager.Handle(action));for(int i=0;i<30 && clicks==0;i++)Thread.Sleep(50);Check(clicks==1,"actual button did not run");
                        Result(manager.Handle(action));Thread.Sleep(80);Check(clicks==1,"duplicate request executed twice");
                        Check(call("window.action",new {version=state["version"],@ref=buttonState["reference"],kind="invoke"}).code=="AUTOMATION_OBSERVATION_STALE","consumed observation replayed");
                        state=observe();edit=find(state,"AI fixture input");form.Invoke(new Action(()=>input.AccessibleName="changed"));
                        Check(call("window.action",new {version=state["version"],@ref=edit["reference"],kind="set_value",value="wrong"}).code=="AUTOMATION_ELEMENT_CHANGED","changed element accepted");
                        manager.Stopped=true;Check(call("windows",new {}).code=="AUTOMATION_USER_STOPPED","local stop ignored");manager.Stopped=false;
                        Check(call("windows",new {}).code=="AUTOMATION_SESSION_ENDED","stopped session silently restarted");
                        session=Guid.NewGuid().ToString("N");Result(call("status",new {}));Result(call("close",new {}));
                        Check(call("status",new {}).code=="AUTOMATION_SESSION_ENDED","closed session silently restarted");
                        Check(manager.Handle(AutomationJson.Json.Serialize(new {op="sync",owners=new[]{other}})).ok,"revoke");
                        Check(call("windows",new {}).code=="AUTOMATION_UNPAIRED","revoked owner retained controls");
                        Check(manager.Handle(AutomationJson.Json.Serialize(new {op="sync",owners=new[]{owner}})).ok,"restore fixture");
                        time=60001;Check(call("windows",new {}).code=="AUTOMATION_UNPAIRED","authorization expiry ignored");
                    }}catch(Exception error){failure=error;}
                    finally{form.BeginInvoke(new Action(form.Close));}
                });thread.SetApartmentState(ApartmentState.MTA);thread.IsBackground=true;thread.Start();
            };
            Application.Run(form);
        }
        if(failure!=null){Console.Error.WriteLine(failure);return 1;}
        Console.WriteLine("PASS: real Windows controls, Unicode, password omission, button invocation, duplicate receipts, stale/changed targets, local stop, revocation and authorization expiry");return 0;
    }
    static int ServeFixture(){
        using(var identity=System.Security.Principal.WindowsIdentity.GetCurrent())if(identity.IsSystem || new System.Security.Principal.WindowsPrincipal(identity).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator))return DesktopUserProcess.RunWorker("--automation-probe");
        Console.InputEncoding=new System.Text.UTF8Encoding(false);Console.OutputEncoding=new System.Text.UTF8Encoding(false);
        using(var form=new Form{Text="ClipRelay AI TLS fixture "+Guid.NewGuid().ToString("N"),Width=500,Height=240}){
            var input=new TextBox{Left=20,Top=20,Width=300,AccessibleName="TLS fixture input"};
            var button=new Button{Left=20,Top=70,Width=150,Text="TLS fixture apply",AccessibleName="TLS fixture apply"};
            int clicks=0;button.Click+=(s,e)=>{Console.WriteLine(AutomationJson.Json.Serialize(new {applied=input.Text,clicks=++clicks}));Console.Out.Flush();};
            form.Controls.AddRange(new Control[]{input,button});
            form.Shown+=(s,e)=>{Console.WriteLine(AutomationJson.Json.Serialize(new {title=form.Text}));Console.Out.Flush();new Thread(()=>{while(Console.ReadLine()!=null){}form.BeginInvoke(new Action(form.Close));}){IsBackground=true}.Start();};
            Application.Run(form);
        }
        return 0;
    }
}
