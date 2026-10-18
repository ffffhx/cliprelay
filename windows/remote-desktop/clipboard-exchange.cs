// Explicit paired clipboard requests, in the interactive user's process only.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace ClipRelay.Remote {
    public sealed class ClipboardPayload {
        public string Kind = "", Text = "", Data = "";
    }
    public interface IClipboardAccess {
        bool Available { get; }
        ClipboardPayload Read();
        void Write(ClipboardPayload value);
    }
    public interface IVersionedClipboardAccess : IClipboardAccess {
        string Version { get; }
        bool WriteIfVersion(ClipboardPayload value, string version);
    }
    public sealed class ClipboardExchange {
        public const int MessageLimit = 12 * 1024 * 1024, TextLimit = 1024 * 1024, ImageLimit = 8 * 1024 * 1024;
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        readonly IClipboardAccess access;
        readonly string epoch = Guid.NewGuid().ToString("N");
        readonly Dictionary<string, string> writes = new Dictionary<string, string>();
        readonly Queue<string> writeOrder = new Queue<string>();
        public ClipboardExchange(IClipboardAccess access) { this.access = access; }
        static object Error(string code) { return new { ok = false, code = code }; }
        string Revision(string version) {
            if (String.IsNullOrEmpty(version) || version.Length > 128) throw new InvalidDataException();
            using (var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Utf8.GetBytes(epoch+":"+version))).Replace("-","").ToLowerInvariant();
        }
        static string Field(Dictionary<string, object> request, string key) {
            object value; return request.TryGetValue(key, out value) ? value as string : "";
        }
        public static bool Valid(ClipboardPayload value) {
            if (value == null || value.Kind == null || value.Text == null || value.Data == null) return false;
            try {
                if (value.Kind == "text") return value.Data == "" && value.Text.Length > 0 &&
                    value.Text.Length <= TextLimit && Utf8.GetByteCount(value.Text) <= TextLimit && value.Text.IndexOf('\0') < 0;
                if (value.Kind != "png" || value.Text != "" || value.Data.Length > 11184812) return false;
                byte[] bytes = Convert.FromBase64String(value.Data);
                if (bytes.Length == 0 || bytes.Length > ImageLimit || Convert.ToBase64String(bytes) != value.Data) return false;
                using (var source = new MemoryStream(bytes, false))
                using (var image = Image.FromStream(source, true, true)) {
                    return image.RawFormat.Guid == ImageFormat.Png.Guid && image.Width > 0 && image.Height > 0 &&
                        image.Width <= 4096 && image.Height <= 4096 && (long)image.Width * image.Height <= 6000000;
                }
            } catch { return false; }
        }
        public object Handle(Dictionary<string, object> request) {
            try {
                if (request == null) return Error("CLIPBOARD_BAD_REQUEST");
                foreach (var pair in request) if (!(pair.Value is string) ||
                    (pair.Key != "op" && pair.Key != "owner" && pair.Key != "id" && pair.Key != "kind" && pair.Key != "text" && pair.Key != "data" && pair.Key != "revision" && pair.Key != "expect"))
                    return Error("CLIPBOARD_BAD_REQUEST");
                string owner = Field(request,"owner"), op = Field(request,"op"), id = Field(request,"id");
                string revision = Field(request,"revision"), expect = Field(request,"expect");
                if ((revision != "" && !Regex.IsMatch(revision,"\\A[0-9a-f]{64}\\z")) || (expect != "" && !Regex.IsMatch(expect,"\\A[0-9a-f]{64}\\z"))) return Error("CLIPBOARD_BAD_REQUEST");
                if (owner == null || !Regex.IsMatch(owner, "\\A[0-9a-f]{64}\\z")) return Error("CLIPBOARD_BAD_REQUEST");
                var value = new ClipboardPayload { Kind=Field(request,"kind"), Text=Field(request,"text"), Data=Field(request,"data") };
                if (op == "read" || op == "observe") {
                    if (id != "" || value.Kind != "" || value.Text != "" || value.Data != "" || expect != "" || (op == "read" && revision != "")) return Error("CLIPBOARD_BAD_REQUEST");
                    if (!access.Available) return Error("CLIPBOARD_LOCKED");
                    var observed=access as IVersionedClipboardAccess;
                    string version="", current="";
                    if (op == "observe") {
                        if (observed == null) return Error("CLIPBOARD_SYNC_UNSUPPORTED");
                        version=observed.Version;current=Revision(version);
                        if (current == revision) return new { ok=true,revision=current,changed=false };
                    }
                    value = access.Read();
                    if (!access.Available) return Error("CLIPBOARD_LOCKED");
                    if (op == "observe") {
                        if (observed.Version != version) return Error("CLIPBOARD_CHANGED");
                        if (value == null) return new { ok=true,revision=current,changed=true,kind="empty" };
                        if (!Valid(value)) return Error("CLIPBOARD_TOO_LARGE");
                        return new { ok=true,revision=current,changed=true,kind=value.Kind,text=value.Text,data=value.Data };
                    }
                    if (value == null) return Error("CLIPBOARD_EMPTY");
                    if (!Valid(value)) return Error("CLIPBOARD_TOO_LARGE");
                    return new { ok=true, kind=value.Kind, text=value.Text, data=value.Data };
                }
                if (op != "write" || id == null || !Regex.IsMatch(id,"\\A[0-9a-f]{32}\\z") || !Valid(value) || revision != "")
                    return Error("CLIPBOARD_BAD_REQUEST");
                string key = owner + ":" + id, digest;
                using (var sha=SHA256.Create()) digest=Convert.ToBase64String(sha.ComputeHash(Utf8.GetBytes(value.Kind+"\n"+value.Text+"\n"+value.Data+"\n"+expect)));
                string previous;
                if (writes.TryGetValue(key,out previous)) return previous == digest ? (object)new { ok=true } : Error("CLIPBOARD_ID_CONFLICT");
                if (!access.Available) return Error("CLIPBOARD_LOCKED");
                if (expect != "") {
                    var conditional=access as IVersionedClipboardAccess;
                    if (conditional == null) return Error("CLIPBOARD_SYNC_UNSUPPORTED");
                    string version=conditional.Version;
                    if (Revision(version) != expect || !conditional.WriteIfVersion(value,version)) return Error("CLIPBOARD_CHANGED");
                } else access.Write(value);
                writes[key]=digest; writeOrder.Enqueue(key);
                // Retain recent acknowledgments only, never clipboard contents.
                while (writeOrder.Count > 256) writes.Remove(writeOrder.Dequeue());
                return new { ok=true };
            } catch { return Error("CLIPBOARD_UNAVAILABLE"); }
        }
        public static int Run() {
            using (var identity=WindowsIdentity.GetCurrent())
                if (identity.IsSystem) return DesktopUserProcess.RunWorker("--clipboard-probe");
            int result=2;
            var thread=new Thread(() => {
                try { result=Serve(new ClipboardExchange(new DesktopClipboard())); }
                catch { result=2; }
            });
            thread.SetApartmentState(ApartmentState.STA); thread.Start(); thread.Join();
            return result;
        }
        public static int Serve(ClipboardExchange exchange) {
            var json=new JavaScriptSerializer { MaxJsonLength=MessageLimit, RecursionLimit=8 };
            Console.InputEncoding=Utf8; Console.OutputEncoding=new UTF8Encoding(false);
            while (true) {
                var line=new StringBuilder(); int c;
                while ((c=Console.Read()) != -1 && c != '\n') {
                    if (line.Length >= MessageLimit) return 2;
                    line.Append((char)c);
                }
                if (c == -1) return 0;
                if (!line.ToString().StartsWith("clipboard:",StringComparison.Ordinal)) return 2;
                object result;
                try { result=exchange.Handle(json.Deserialize<Dictionary<string,object>>(line.ToString().Substring(10))); }
                catch { result=Error("CLIPBOARD_BAD_REQUEST"); }
                Console.WriteLine(json.Serialize(result)); Console.Out.Flush();
            }
        }
    }
    internal sealed class DesktopClipboard : IVersionedClipboardAccess {
        public bool Available { get { return InputFocus.IsInteractiveDesktop(); } }
        public string Version { get { return ConditionalClipboard.Sequence().ToString(System.Globalization.CultureInfo.InvariantCulture); } }
        public bool WriteIfVersion(ClipboardPayload value,string version) {
            uint expected;
            if (!UInt32.TryParse(version,out expected) || !Available) throw new InvalidOperationException();
            return ConditionalClipboard.Write(value,expected);
        }
        public ClipboardPayload Read() {
            if (!Available) return null;
            if (Clipboard.ContainsData("PNG")) {
                using (var source=Clipboard.GetData("PNG") as MemoryStream) {
                    if (source == null || source.Length > ClipboardExchange.ImageLimit) throw new InvalidDataException();
                    var value=new ClipboardPayload { Kind="png",Data=Convert.ToBase64String(source.ToArray()) };
                    if (!ClipboardExchange.Valid(value)) throw new InvalidDataException();
                    return value;
                }
            }
            if (Clipboard.ContainsImage()) {
                using (var image=Clipboard.GetImage()) {
                    if (image == null) return null;
                    if (image.Width > 4096 || image.Height > 4096 || (long)image.Width*image.Height > 6000000)
                        throw new InvalidDataException();
                    using (var png=new MemoryStream()) {
                        image.Save(png,ImageFormat.Png);
                        if (png.Length > ClipboardExchange.ImageLimit) throw new InvalidDataException();
                        return new ClipboardPayload { Kind="png", Data=Convert.ToBase64String(png.ToArray()) };
                    }
                }
            }
            if (!Clipboard.ContainsText(TextDataFormat.UnicodeText)) return null;
            return new ClipboardPayload { Kind="text",Text=Clipboard.GetText(TextDataFormat.UnicodeText) };
        }
        public void Write(ClipboardPayload value) {
            if (!Available) throw new InvalidOperationException();
            var data=new DataObject();
            if (value.Kind == "text") {
                data.SetText(value.Text,TextDataFormat.UnicodeText);
                Clipboard.SetDataObject(data,true,5,80);
            } else {
                using (var source=new MemoryStream(Convert.FromBase64String(value.Data),false))
                using (var image=Image.FromStream(source,true,true))
                using (var bitmap=new Bitmap(image)) {
                    data.SetImage(bitmap); source.Position=0; data.SetData("PNG",false,source);
                    if (!Available) throw new InvalidOperationException();
                    Clipboard.SetDataObject(data,true,5,80);
                }
            }
        }
    }

    // Hold the Windows clipboard lock across the version comparison and write.
    // Prepare all data first, and transfer each native handle's ownership only
    // after SetClipboardData succeeds. No user clipboard is opened by tests
    // unless their separate disposable-CI native mode is explicitly selected.
    internal static class ConditionalClipboard {
        [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
        [DllImport("user32.dll",SetLastError=true)] static extern bool OpenClipboard(IntPtr owner);
        [DllImport("user32.dll")] static extern bool CloseClipboard();
        [DllImport("user32.dll",SetLastError=true)] static extern bool EmptyClipboard();
        [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetClipboardData(uint format,IntPtr memory);
        [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint RegisterClipboardFormat(string name);
        [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GlobalAlloc(uint flags,UIntPtr bytes);
        [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GlobalLock(IntPtr memory);
        [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr memory);
        [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr memory);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
        internal static uint Sequence() { return GetClipboardSequenceNumber(); }
        static IntPtr Buffer(byte[] bytes) {
            IntPtr handle=GlobalAlloc(2,(UIntPtr)bytes.Length);
            if (handle==IntPtr.Zero) throw new InvalidOperationException();
            IntPtr data=GlobalLock(handle);
            if (data==IntPtr.Zero) { GlobalFree(handle);throw new InvalidOperationException(); }
            try { Marshal.Copy(bytes,0,data,bytes.Length); } finally { GlobalUnlock(handle); }
            return handle;
        }
        internal static bool Write(ClipboardPayload value,uint expected) {
            IntPtr data=IntPtr.Zero,bitmap=IntPtr.Zero;uint format=13;bool opened=false;
            var window=new NativeWindow();
            try {
                if (!ClipboardExchange.Valid(value)) throw new InvalidDataException();
                if (value.Kind=="text") data=Buffer(Encoding.Unicode.GetBytes(value.Text+"\0"));
                else {
                    byte[] bytes=Convert.FromBase64String(value.Data);data=Buffer(bytes);
                    using (var source=new MemoryStream(bytes,false)) using (var image=Image.FromStream(source,true,true)) using (var copy=new Bitmap(image)) bitmap=copy.GetHbitmap(Color.Transparent);
                    format=RegisterClipboardFormat("PNG");if (format==0) throw new InvalidOperationException();
                }
                window.CreateHandle(new CreateParams { Caption="ClipRelay clipboard",Parent=new IntPtr(-3) });
                if (!OpenClipboard(window.Handle)) throw new InvalidOperationException();
                opened=true;
                if (!InputFocus.IsInteractiveDesktop()) throw new InvalidOperationException();
                if (Sequence()!=expected) return false;
                if (!EmptyClipboard() || SetClipboardData(format,data)==IntPtr.Zero) throw new InvalidOperationException();
                data=IntPtr.Zero;
                if (bitmap!=IntPtr.Zero) {
                    if (SetClipboardData(2,bitmap)==IntPtr.Zero) throw new InvalidOperationException();
                    bitmap=IntPtr.Zero;
                }
                return true;
            } finally {
                if (opened) CloseClipboard();
                window.DestroyHandle();
                if (data!=IntPtr.Zero) GlobalFree(data);
                if (bitmap!=IntPtr.Zero) DeleteObject(bitmap);
            }
        }
    }
}
