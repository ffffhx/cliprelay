using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;
using ClipRelay.Remote;

class HostClientsTests {
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    const string Id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",Other="11111111-2222-3333-4444-555555555555";
    static readonly string View=new string('a',32);
    static void Check(bool value,string reason){if(!value)throw new Exception(reason);}
    static Dictionary<string,object> Parse(string value){return Json.Deserialize<Dictionary<string,object>>(value);}
    static Dictionary<string,object> Device(string id,bool enabled){return new Dictionary<string,object>{{"uuid",id},{"name","Fixture device"},{"enabled",enabled}};}
    static object Reply(params Dictionary<string,object>[] devices){return Parse(Json.Serialize(new {status=true,named_certs=devices}));}
    static Dictionary<string,object> Decision(){return new Dictionary<string,object>{{"action","unpair"},{"uuid",Id},{"viewId",View}};}
    static void Fails(Action action,string text){try{action();}catch(Exception error){Check(error.Message.Contains(text),error.Message);return;}throw new Exception("Expected refusal");}
    static void StrictList(){
        var device=Device(Id,true);Check(HostClientsControl.Read((m,p,b)=>Reply(device)).Count==1,"Valid list refused");
        foreach(string field in new[]{"uuid","name","enabled","extra"}){
            var invalid=Device(Id,true);invalid[field]=field=="name"?"bad\nname":"bad";
            Fails(()=>HostClientsControl.Read((m,p,b)=>Reply(invalid)),"无法确认");
        }
        Fails(()=>HostClientsControl.Read((m,p,b)=>Reply(device,Device(Id.ToUpperInvariant(),true))),"无法确认");
        Fails(()=>HostClientsControl.Read((m,p,b)=>Parse("{\"status\":\"true\",\"named_certs\":[]}")),"无法确认");
        Fails(()=>HostClientsControl.Read((m,p,b)=>Reply(Enumerable.Range(0,129).Select(i=>Device(Guid.NewGuid().ToString(),true)).ToArray())),"无法确认");
    }
    static void StaleAndInvalid(){
        int calls=0;Func<string,string,object,object> request=(m,p,b)=>{calls++;return Reply();};
        Fails(()=>HostClientsControl.Revoke(Decision(),new string('b',32),request),"重新启动");
        foreach(string field in new[]{"action","uuid","viewId","extra"}){var value=Decision();value[field]="invalid";Fails(()=>HostClientsControl.Revoke(value,View,request),"无法确认");}
        Check(calls==0,"Stale decision reached native API");
    }
    static void Revoke(string failure){
        var devices=new List<Dictionary<string,object>>{Device(Id,true),Device(Other,true)};var calls=new List<string>();
        bool failed=false;
        Func<string,string,object,object> request=(method,path,body)=>{
            calls.Add(path);
            if(path.EndsWith("/list")){Check(method=="GET" && body==null,"Wrong list request");return Reply(devices.ToArray());}
            var payload=body as Dictionary<string,object>;Check(method=="POST" && (string)payload["uuid"]==Id,"Wrong mutation target");
            if(path.EndsWith("/update")){
                Check(payload.Count==2 && payload["enabled"] is bool && !(bool)payload["enabled"],"Policy restored permission");
                if(failure!="refuse-disable")devices[0]["enabled"]=false;
                if(failure=="lost-disable")throw new IOException("lost response");
            }else if(path.EndsWith("/unpair")){
                Check(payload.Count==1 && !(bool)devices[0]["enabled"],"Unpaired before disabling");
                if(failure=="failed-unpair")throw new IOException("failed response");
                devices.RemoveAt(0);if(failure=="lost-unpair")throw new IOException("lost response");
            }else throw new Exception("Unknown operation");
            return Parse("{\"status\":true}");
        };
        var decision=Decision();decision["uuid"]=Id.ToUpperInvariant();
        try{HostClientsControl.Revoke(decision,View,request);}catch(InvalidOperationException){failed=true;}
        Check(failed==(failure=="refuse-disable" || failure=="lost-disable" || failure=="failed-unpair"),"Wrong final confirmation");
        Check(calls.Count(value=>value.EndsWith("/update"))==1 && calls.Count(value=>value.EndsWith("/unpair"))<=1,"Mutation replayed");
        Check(devices.Any(value=>(string)value["uuid"]==Other && (bool)value["enabled"]),"Other client affected");
        if(failed)Check(devices.Count==2 && (bool)devices[0]["enabled"]==(failure=="refuse-disable"),"Partial state hidden or reenabled");
        else Check(devices.Count==1,"Removal not confirmed");
    }
    static void MissingAndMalformed(){
        int calls=0;Fails(()=>HostClientsControl.Revoke(Decision(),View,(m,p,b)=>{calls++;Check(m=="GET","Absent client mutated");return Reply();}),"授权已改变");Check(calls==1,"Absent client reread");
        calls=0;Fails(()=>HostClientsControl.Revoke(Decision(),View,(m,p,b)=>{calls++;return Parse("{\"status\":true,\"named_certs\":null}");}),"无法确认");
        Check(calls==1,"Malformed initial list caused more operations");
    }
    static int Main(){try{StrictList();StaleAndInvalid();foreach(string value in new[]{"","refuse-disable","lost-disable","failed-unpair","lost-unpair"})Revoke(value);MissingAndMalformed();Console.WriteLine("PASS: 8 host client revocation policy scenarios");return 0;}catch(Exception error){Console.Error.WriteLine(error);return 1;}}
}
