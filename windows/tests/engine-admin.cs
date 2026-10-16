using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Web.Script.Serialization;
using ClipRelay.Remote;

class EngineAdminTests {
    static int Main() {
        var json=new JavaScriptSerializer();var clock=Stopwatch.StartNew();
        ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
        try {
            var input=json.Deserialize<Dictionary<string,object>>(Console.ReadLine());
            object body;input.TryGetValue("body",out body);
            var result=EngineAdmin.Request("disposable-admin-password",Convert.FromBase64String((string)input["certificate"]),
                (string)input["method"],(string)input["path"],body,(int)input["timeoutMs"],(int)input["replyLimit"],(int)input["port"]);
            Console.WriteLine(json.Serialize(new {ok=true,result=result,elapsedMs=clock.ElapsedMilliseconds}));
        }catch(Exception error){Console.WriteLine(json.Serialize(new {ok=false,error=error.GetType().Name,elapsedMs=clock.ElapsedMilliseconds}));}
        return 0;
    }
}
