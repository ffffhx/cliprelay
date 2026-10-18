using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using ClipRelay.Remote;

class ClipboardExchangeTests {
    sealed class Fake : IVersionedClipboardAccess {
        public bool Ready=true, LockOnRead;
        public int Writes, Reads;
        public ClipboardPayload Current;
        public int Generation;
        public Action BeforeConditional;
        public string Version { get { return Generation.ToString(); } }
        public bool WriteIfVersion(ClipboardPayload value,string version) {
            if (BeforeConditional!=null) BeforeConditional();
            if (Version!=version) return false;
            Write(value);return true;
        }
        public bool Available { get { return Ready; } }
        public ClipboardPayload Read() { Reads++; if (LockOnRead) Ready=false; return Current; }
        public void Write(ClipboardPayload value) { Writes++;Generation++; Current=value; }
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
        if (args.Length==1 && args[0]=="--native-clipboard-fixture") return NativeAcceptance();
        if (args.Length==1 && args[0]=="--native-clipboard-probe") {
            Check(Environment.GetEnvironmentVariable("CI")=="true" && Environment.GetEnvironmentVariable("GITHUB_ACTIONS")=="true" && Environment.GetEnvironmentVariable("CLIPRELAY_NATIVE_CLIPBOARD_FIXTURE")=="1","Native clipboard probe requires disposable CI");
            return ClipboardExchange.Serve(new ClipboardExchange(new DesktopClipboard()));
        }
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
        var sync=new Fake();var exchange=new ClipboardExchange(sync);
        var observe=Request("observe");var first=Call(exchange,observe);
        Check((string)first["kind"]=="empty" && (bool)first["changed"],"empty baseline failed");
        observe["revision"]=first["revision"];
        Check(!(bool)Call(exchange,observe)["changed"] && sync.Reads==1,"unchanged observation read content");
        var conditional=Write("conditional text");conditional["expect"]=first["revision"];
        Call(exchange,conditional);sync.Write(new ClipboardPayload { Kind="text",Text="new local copy" });
        Call(exchange,conditional);Check(sync.Writes==2 && sync.Current.Text=="new local copy","lost reply replayed mutation");
        conditional["id"]=new string('2',32);Call(exchange,conditional,"CLIPBOARD_CHANGED");
        var current=Call(exchange,Request("observe"));conditional["expect"]=current["revision"];
        sync.BeforeConditional=()=>{sync.Generation++;};Call(exchange,conditional,"CLIPBOARD_CHANGED");sync.BeforeConditional=null;
        Call(new ClipboardExchange(sync),conditional,"CLIPBOARD_CHANGED");
        Check(sync.Writes==2,"conditional refusal changed clipboard");
        Console.WriteLine("Clipboard exchange: Unicode, bidirectional PNG, duplicate writes, owner isolation, bounds and locked-desktop cases passed.");
        Console.WriteLine("Clipboard observation: unchanged content elision, conditional writes, late changes, lost replies and worker epoch changes passed.");
        return 0;
    }
    static int NativeAcceptance() {
        Check(Environment.GetEnvironmentVariable("CI")=="true" && Environment.GetEnvironmentVariable("GITHUB_ACTIONS")=="true","Native clipboard fixture requires disposable CI");
        var access=new DesktopClipboard();Check(access.Available,"Native CI desktop unavailable");
        var exchange=new ClipboardExchange(access);
        access.Write(new ClipboardPayload { Kind="text",Text="native baseline" });
        string revision=(string)Call(exchange,Request("observe"))["revision"];
        var conditional=Write("native conditional 中文 😀");conditional["expect"]=revision;
        Call(exchange,conditional);Check(Clipboard.GetText(TextDataFormat.UnicodeText)==(string)conditional["text"],"native text changed");
        access.Write(new ClipboardPayload { Kind="text",Text="later native copy" });
        conditional["id"]=new string('2',32);Call(exchange,conditional,"CLIPBOARD_CHANGED");
        Check(Clipboard.GetText(TextDataFormat.UnicodeText)=="later native copy","native stale write changed content");
        using (var image=new Bitmap(2,3)) using (var png=new MemoryStream()) {
            image.SetPixel(1,2,Color.FromArgb(128,255,0,0));image.Save(png,ImageFormat.Png);
            conditional=Request("write");conditional["id"]=new string('3',32);conditional["kind"]="png";conditional["data"]=Convert.ToBase64String(png.ToArray());
            conditional["expect"]=Call(exchange,Request("observe"))["revision"];Call(exchange,conditional);
            Check(Clipboard.ContainsImage() && Clipboard.ContainsData("PNG"),"native image formats missing");
            var read=access.Read();Check(read.Kind=="png","native PNG missing");
            using (var bytes=new MemoryStream(Convert.FromBase64String(read.Data))) using (var copy=new Bitmap(bytes)) {
                Check(copy.Width==2 && copy.Height==3 && copy.GetPixel(1,2).ToArgb()==image.GetPixel(1,2).ToArgb(),"native PNG pixels changed");
            }
        }
        Console.WriteLine("Native Windows clipboard: conditional Unicode/PNG, independent readback, pixel identity and stale-write refusal passed.");
        return 0;
    }
}
