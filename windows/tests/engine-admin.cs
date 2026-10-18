using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Threading;
using System.Web.Script.Serialization;
using ClipRelay.Remote;

class EngineAdminTests {
    static int Main() {
        var json=new JavaScriptSerializer();var clock=Stopwatch.StartNew();
        var requests=new List<object>();
        ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
        try {
            var input=json.Deserialize<Dictionary<string,object>>(Console.ReadLine());
            object body;input.TryGetValue("body",out body);
            object result,operation;
            var certificate=Convert.FromBase64String((string)input["certificate"]);
            if(input.TryGetValue("operation",out operation) && (string)operation=="revoke") {
                var bounded=HostClientsControl.BoundedRequests(delegate(string method,string path,object payload,int timeout) {
                    requests.Add(new {method=method,path=path,timeoutMs=timeout,startedMs=clock.ElapsedMilliseconds});
                    object reply=EngineAdmin.Request("disposable-admin-password",certificate,method,path,payload,timeout,65536,(int)input["port"]);
                    object delayCall,delay;
                    // Test-only caller stall after a genuine TLS response. It
                    // models delay outside the single-request transport timer.
                    if(input.TryGetValue("delayAfterReplyCall",out delayCall) && (int)delayCall==requests.Count &&
                        input.TryGetValue("delayAfterReplyMs",out delay))Thread.Sleep((int)delay);
                    return reply;
                });
                result=HostClientsControl.Revoke(new Dictionary<string,object> {
                    {"action","unpair"},{"uuid","aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},{"viewId",new string('a',32)}
                },new string('a',32),bounded);
            }else {
                result=EngineAdmin.Request("disposable-admin-password",certificate,
                    (string)input["method"],(string)input["path"],body,(int)input["timeoutMs"],(int)input["replyLimit"],(int)input["port"]);
            }
            Console.WriteLine(json.Serialize(new {ok=true,result=result,elapsedMs=clock.ElapsedMilliseconds,requests=requests}));
        }catch(Exception error){Console.WriteLine(json.Serialize(new {ok=false,error=error.GetType().Name,elapsedMs=clock.ElapsedMilliseconds,requests=requests}));}
        return 0;
    }
}
