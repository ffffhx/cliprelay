using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace ClipRelay.Remote {
    // Only fixed local administration operations. The owner supplies its private
    // certificate and password; redirects and ambient proxy credentials are off.
    internal static class EngineAdmin {
        static bool Allowed(string method,string path) {
            return (path=="/api/pin" && (method=="GET" || method=="POST" || method=="DELETE")) ||
                (path=="/api/clients/list" && method=="GET") ||
                (method=="POST" && (path=="/api/clients/update" || path=="/api/clients/unpair" || path=="/api/apps/close"));
        }
        static bool SameCertificate(X509Certificate certificate,byte[] expected) {
            if(certificate==null)return false;
            try {
                byte[] actual=certificate.GetRawCertData();if(actual.Length!=expected.Length)return false;
                for(int i=0;i<actual.Length;i++)if(actual[i]!=expected[i])return false;
                return true;
            }catch{return false;}
        }
        internal static object Request(string password,byte[] certificate,string method,string path,object body,
            int timeoutMs,int replyLimit,int port=48790) {
            if(String.IsNullOrEmpty(password) || password.Length>256 || certificate==null || certificate.Length<128 || certificate.Length>16384 ||
                !Allowed(method,path) || (method=="GET" && body!=null) || timeoutMs<1 || timeoutMs>20000 ||
                replyLimit<2 || replyLimit>1024*1024 || port<1 || port>65535)throw new ArgumentException("Invalid local engine request");
            var clock=Stopwatch.StartNew();
            var json=new JavaScriptSerializer {MaxJsonLength=1024*1024,RecursionLimit=16};
            byte[] payload=body==null?null:new UTF8Encoding(false,true).GetBytes(json.Serialize(body));
            if(payload!=null && payload.Length>16384)throw new InvalidDataException("Local engine request exceeded limit");
            var request=(HttpWebRequest)WebRequest.Create("https://127.0.0.1:"+port+path);
            request.Proxy=null;request.AllowAutoRedirect=false;request.KeepAlive=false;
            request.AllowWriteStreamBuffering=false;request.Pipelined=false;
            request.Method=method;request.Timeout=timeoutMs;request.ReadWriteTimeout=timeoutMs;
            request.Headers["Authorization"]="Basic "+Convert.ToBase64String(Encoding.UTF8.GetBytes("cliprelay:"+password));
            using(var expected=new X509Certificate2(certificate)) {
                byte[] pinned=expected.RawData;
                request.ServerCertificateValidationCallback=delegate(object sender,X509Certificate peer,X509Chain chain,System.Net.Security.SslPolicyErrors errors) {
                    return SameCertificate(peer,pinned);
                };
                int remaining=timeoutMs-(int)clock.ElapsedMilliseconds;
                if(remaining<=0)throw new System.TimeoutException("Local engine request timed out");
                using(var timeout=new Timer(delegate {try{request.Abort();}catch{}},null,remaining,Timeout.Infinite)) {
                    if(payload!=null) {
                        request.ContentType="application/json";request.ContentLength=payload.Length;
                        using(var stream=request.GetRequestStream())stream.Write(payload,0,payload.Length);
                    }
                    using(var response=(HttpWebResponse)request.GetResponse()) {
                        if(response.StatusCode!=HttpStatusCode.OK)throw new InvalidDataException("Unexpected local engine response");
                        using(var stream=response.GetResponseStream())
                        using(var bytes=new MemoryStream()) {
                            byte[] buffer=new byte[4096];int count;
                            while((count=stream.Read(buffer,0,buffer.Length))>0) {
                                if(bytes.Length+count>replyLimit)throw new InvalidDataException("Local engine reply exceeded limit");
                                bytes.Write(buffer,0,count);
                            }
                            object result=json.DeserializeObject(new UTF8Encoding(false,true).GetString(bytes.ToArray()));
                            if(clock.ElapsedMilliseconds>=timeoutMs)throw new System.TimeoutException("Local engine request timed out");
                            return result;
                        }
                    }
                }
            }
        }
    }
}
