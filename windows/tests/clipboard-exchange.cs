using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Web.Script.Serialization;
using ClipRelay.Remote;

class ClipboardExchangeTests {
    sealed class Fake : IClipboardAccess {
        public bool Ready=true, LockOnRead;
        public int Writes, Reads;
        public ClipboardPayload Current;
        public bool Available { get { return Ready; } }
        public ClipboardPayload Read() { Reads++; if (LockOnRead) Ready=false; return Current; }
        public void Write(ClipboardPayload value) { Writes++; Current=value; }
    }
    static JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=ClipboardExchange.MessageLimit };
    static string Owner=new string('a',64), ID=new string('1',32);
    static void Check(bool value,string why) { if (!value) throw new Exception(why); }
    static Dictionary<string,object> Request(string op="read") {
        return new Dictionary<string,object> { {"op",op},{"owner",Owner} };
    }
    static Dictionary<string,object> Write(string text) {
        var result=Request("write"); result["id"]=ID; result["kind"]="text"; result["text"]=text; return result;
    }
    static Dictionary<string,object> Call(ClipboardExchange worker,Dictionary<string,object> request,string error=null) {
        var result=Json.Deserialize<Dictionary<string,object>>(Json.Serialize(worker.Handle(request)));
        Check((bool)result["ok"]==(error==null),Json.Serialize(result));
        if (error!=null) Check((string)result["code"]==error,Json.Serialize(result)); return result;
    }
    [STAThread] static int Main(string[] args) {
        var clipboard=new Fake(); var worker=new ClipboardExchange(clipboard);
        if (args.Length==1 && args[0]=="--clipboard-probe") return ClipboardExchange.Serve(worker);
        string text="Unicode 中文 👩‍💻\nquote \" & < >";
        Call(worker,Write(text)); Check(clipboard.Writes==1 && clipboard.Current.Text==text,"Unicode write changed");
        Check((string)Call(worker,Request())["text"]==text,"Unicode read changed");
        clipboard.Current=new ClipboardPayload { Kind="text",Text="later local copy" };
        Call(worker,Write(text)); Check(clipboard.Writes==1 && clipboard.Current.Text=="later local copy","duplicate overwrote clipboard");
        Call(worker,Write("changed"),"CLIPBOARD_ID_CONFLICT");
        var other=Write("other peer"); other["owner"]=new string('b',64); Call(worker,other); Check(clipboard.Writes==2,"owners conflated");
        foreach (string bad in new[]{"", "zero\0byte",new string('x',ClipboardExchange.TextLimit+1),"\ud800"})
            Call(worker,Write(bad),"CLIPBOARD_BAD_REQUEST");
        var badRequest=Request(); badRequest["path"]="C:\\private"; Call(worker,badRequest,"CLIPBOARD_BAD_REQUEST");
        badRequest=Request(); badRequest["owner"]="unknown"; Call(worker,badRequest,"CLIPBOARD_BAD_REQUEST");
        badRequest=Request(); badRequest["text"]=null; Call(worker,badRequest,"CLIPBOARD_BAD_REQUEST");
        clipboard.Ready=false; Call(worker,Request(),"CLIPBOARD_LOCKED");
        clipboard.Ready=true; clipboard.LockOnRead=true; Call(worker,Request(),"CLIPBOARD_LOCKED");
        clipboard.Ready=true; clipboard.LockOnRead=false; clipboard.Current=null; Call(worker,Request(),"CLIPBOARD_EMPTY");
        using (var image=new Bitmap(32,24)) using (var png=new MemoryStream()) {
            image.Save(png,ImageFormat.Png);
            var request=Request("write"); request["id"]=new string('2',32); request["kind"]="png"; request["data"]=Convert.ToBase64String(png.ToArray());
            Call(worker,request); Check((string)Call(worker,Request())["data"]==(string)request["data"],"PNG changed");
            request["data"]="bm90IGEgcG5n"; Call(worker,request,"CLIPBOARD_BAD_REQUEST");
        }
        using (var image=new Bitmap(5000,1)) using (var png=new MemoryStream()) {
            image.Save(png,ImageFormat.Png);
            Check(!ClipboardExchange.Valid(new ClipboardPayload { Kind="png",Data=Convert.ToBase64String(png.ToArray()) }),"oversize dimensions accepted");
        }
        Check(clipboard.Writes==3,"invalid request changed clipboard");
        Console.WriteLine("Clipboard exchange: Unicode, bidirectional PNG, duplicate writes, owner isolation, bounds and locked-desktop cases passed.");
        return 0;
    }
}
