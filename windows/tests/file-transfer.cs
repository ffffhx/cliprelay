using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using ClipRelay.Remote;

class FileTransferTests {
    static readonly string Owner = new string('a', 64), Other = new string('b', 64);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 400 * 1024 };
    static int passed;
    static string Hex(byte[] value) { return BitConverter.ToString(value).Replace("-", "").ToLowerInvariant(); }
    static string Hash(byte[] value) { using (var sha = SHA256.Create()) return Hex(sha.ComputeHash(value)); }
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static Dictionary<string, object> Request(string op, string id = "", string owner = null) {
        return new Dictionary<string, object> { { "op", op }, { "id", id }, { "owner", owner ?? Owner } };
    }
    static Dictionary<string, object> Call(TransferStore store, Dictionary<string, object> request, string error = null) {
        var result = Json.Deserialize<Dictionary<string, object>>(Json.Serialize(store.Handle(request)));
        Check((bool)result["ok"] == (error == null), "Unexpected result " + Json.Serialize(result));
        if (error != null) Check((string)result["code"] == error, "Wrong error: " + Json.Serialize(result));
        return result;
    }
    static Dictionary<string, object> Start(string id, byte[] data, string name = "file.bin") {
        var request = Request("upload-start", id);
        request["root"] = "home"; request["path"] = ""; request["name"] = name;
        request["size"] = (long)data.Length; request["sha256"] = Hash(data); return request;
    }
    static Dictionary<string, object> Chunk(string id, byte[] data, long offset = 0) {
        var request = Request("upload-chunk", id); request["offset"] = offset;
        request["data"] = Convert.ToBase64String(data); request["sha256"] = Hash(data); return request;
    }
    static Dictionary<string, object> Wait(TransferStore store, string id, string state) {
        var limit = DateTime.UtcNow.AddSeconds(10);
        while (true) {
            var result = Call(store, Request("status", id));
            if ((string)result["state"] == state) return result;
            Check((string)result["state"] != "error", "Verification failed: " + Json.Serialize(result));
            Check(DateTime.UtcNow < limit, "Timed out: " + Json.Serialize(result)); Thread.Sleep(10);
        }
    }
    sealed class Fixture : IDisposable {
        public readonly string Base = Path.Combine(Path.GetTempPath(), "cliprelay-transfer-test-" + Guid.NewGuid().ToString("N"));
        public string Files { get { return Path.Combine(Base, "files"); } }
        public string Journal { get { return Path.Combine(Base, "state"); } }
        public Fixture() { Directory.CreateDirectory(Files); }
        public TransferStore Open(Func<string, long> space = null) { return new TransferStore(new Dictionary<string, string>{{"home",Files}},Journal,space); }
        public void Dispose() {
            string resolved = Path.GetFullPath(Base), parent = Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\') + "\\";
            Check(resolved.StartsWith(parent, StringComparison.OrdinalIgnoreCase) && Path.GetFileName(resolved).StartsWith("cliprelay-transfer-test-"), "Unsafe fixture cleanup");
            for(int n=0;n<50;n++) try { Directory.Delete(resolved,true); return; } catch(IOException) {Thread.Sleep(20);}
        }
    }
    static void Test(string name, Action action) { action(); passed++; Console.WriteLine("PASS " + name); }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateSymbolicLink(string link,string target,int flags);
    public static int Main(string[] args) {
        try {
            // This alternate entry exists only in the test executable. Production
            // workers never accept environment variables selecting filesystem roots.
            if(args.Length==1&&args[0]=="--file-probe") {
                string root=Environment.GetEnvironmentVariable("CLIPRELAY_TEST_FILE_ROOT");
                Check(!String.IsNullOrEmpty(root)&&Directory.Exists(root),"Missing test root");
                using(var store=new TransferStore(new Dictionary<string,string>{{"downloads",Path.Combine(root,"files")}},Path.Combine(root,"state")))return FileTransfer.Serve(store);
            }
            Test("interrupted upload resumes, duplicate chunks are idempotent, same-name output never overwrites", () => {
                using (var f = new Fixture()) {
                    byte[] data = Enumerable.Range(0, TransferStore.ChunkSize + 29).Select(i=>(byte)i).ToArray();
                    string id = Guid.NewGuid().ToString("N");
                    using(var s=f.Open()) {
                        Call(s,Start(id,data)); Call(s,Chunk(id,data.Take(TransferStore.ChunkSize).ToArray()));
                    }
                    // Emulate a crash after writing bytes but before committing the journal.
                    string part = Directory.GetFiles(f.Files,"*.part").Single();
                    using(var stream = new FileStream(part,FileMode.Append)) stream.Write(new byte[]{9,9,9},0,3);
                    File.WriteAllText(Path.Combine(f.Files,"file.bin"),"existing user file");
                    using(var s=f.Open()) {
                        Check(Convert.ToInt64(Call(s,Start(id,data))["offset"])==TransferStore.ChunkSize,"resume offset lost");
                        Call(s,Chunk(id,data.Take(TransferStore.ChunkSize).ToArray()));
                        Call(s,Chunk(id,new byte[]{9},0),"FILES_CHUNK_CONFLICT");
                        Call(s,Chunk(id,data.Skip(TransferStore.ChunkSize).ToArray(),TransferStore.ChunkSize));
                        Call(s,Request("finish",id)); var result=Wait(s,id,"complete");
                        Check(File.ReadAllBytes(Path.Combine(f.Files,(string)result["finalName"])).SequenceEqual(data),"bytes changed");
                        Check(File.ReadAllText(Path.Combine(f.Files,"file.bin"))=="existing user file","existing file overwritten");
                        Call(s,Request("cancel",id));
                        Check(File.Exists(Path.Combine(f.Files,(string)result["finalName"])),"cancel removed a committed file");
                    }
                }
            });
            Test("certificate owners cannot read or cancel another transfer", () => {
                using(var f=new Fixture()) using(var s=f.Open()) {
                    string id=Guid.NewGuid().ToString("N"); Call(s,Start(id,new byte[]{1}));
                    Call(s,Request("status",id,Other),"FILES_NOT_FOUND"); Call(s,Request("cancel",id,Other),"FILES_NOT_FOUND");
                    Check((string)Call(s,Request("status",id))["state"]=="uploading","owner transfer changed");
                }
            });
            Test("traversal, Windows alternate streams, reserved names and journals are rejected", () => {
                using(var f=new Fixture()) using(var s=f.Open()) {
                    foreach(var name in new[]{"../escape","C:\\escape","a:b","NUL.txt","..","bad.",".cliprelay-hidden"}) {
                        Call(s,Start(Guid.NewGuid().ToString("N"),new byte[0],name),"FILES_BAD_PATH");
                    }
                    foreach(var path in new[]{"../state","/outside","C:/Windows","a//b","a\\b"}) {
                        var request=Request("list");request["root"]="home";request["path"]=path;Call(s,request,"FILES_BAD_PATH");
                    }
                }
            });
            Test("directory links cannot redirect a transfer outside its root", () => {
                using(var f=new Fixture()) {
                    string outside=Path.Combine(f.Base,"outside"),link=Path.Combine(f.Files,"link");Directory.CreateDirectory(outside);
                    Check(CreateSymbolicLink(link,outside,3) || CreateSymbolicLink(link,outside,1),"Cannot create test symlink: "+Marshal.GetLastWin32Error());
                    try { using(var s=f.Open()) { var request=Start(Guid.NewGuid().ToString("N"),new byte[0]);request["path"]="link";Call(s,request,"FILES_LINK_NOT_ALLOWED"); } }
                    finally { Directory.Delete(link); }
                    Check(!Directory.EnumerateFileSystemEntries(outside).Any(),"link target modified");
                }
            });
            Test("space checks preserve partial transfers and cancellation removes only their parts", () => {
                using(var f=new Fixture()) {
                    long free=0;
                    using(var s=f.Open(path=>free)) {
                        string id=Guid.NewGuid().ToString("N");var request=Start(id,new byte[]{1,2});Call(s,request,"FILES_DISK_FULL");
                        free=1L<<30;Call(s,request);Call(s,Chunk(id,new byte[]{1}));
                        free=0;Call(s,Chunk(id,new byte[]{2},1),"FILES_DISK_FULL");
                        Check(Convert.ToInt64(Call(s,Request("status",id))["offset"])==1,"failed chunk acknowledged");
                        Call(s,Request("cancel",id));Check(!Directory.GetFiles(f.Files,"*.part").Any(),"cancel leaked part");
                    }
                }
            });
            Test("full-file hash mismatch never publishes output; zero-byte transfers work", () => {
                using(var f=new Fixture()) using(var s=f.Open()) {
                    string bad=Guid.NewGuid().ToString("N");Call(s,Start(bad,new byte[]{1}));Call(s,Chunk(bad,new byte[]{2}));Call(s,Request("finish",bad));
                    var deadline=DateTime.UtcNow.AddSeconds(5);Dictionary<string,object> result;
                    do{result=Call(s,Request("status",bad));Thread.Sleep(10);}while((string)result["state"]!="error"&&DateTime.UtcNow<deadline);
                    Check((string)result["code"]=="FILES_HASH_MISMATCH"&&!File.Exists(Path.Combine(f.Files,"file.bin")),"bad hash published");
                    string empty=Guid.NewGuid().ToString("N");Call(s,Start(empty,new byte[0],"empty.txt"));Call(s,Request("finish",empty));Wait(s,empty,"complete");
                    Check(new FileInfo(Path.Combine(f.Files,"empty.txt")).Length==0,"empty file failed");
                }
            });
            Test("downloads survive worker restart and reject a changed source", () => {
                using(var f=new Fixture()) {
                    byte[] content=Encoding.UTF8.GetBytes("download with resume");string source=Path.Combine(f.Files,"source.txt");File.WriteAllBytes(source,content);
                    string id=Guid.NewGuid().ToString("N");var start=Request("download-start",id);start["root"]="home";start["name"]="source.txt";start["path"]="";
                    using(var s=f.Open()) {Call(s,start);Check((string)Wait(s,id,"ready")["sha256"]==Hash(content),"download hash wrong");}
                    using(var s=f.Open()) {
                        var chunk=Request("download-chunk",id);chunk["offset"]=4L;
                        Check(Convert.FromBase64String((string)Call(s,chunk)["data"]).SequenceEqual(content.Skip(4)),"download resume changed bytes");
                        File.AppendAllText(source," changed");Call(s,chunk,"FILES_SOURCE_CHANGED");
                    }
                }
            });
            Test("crash after final rename recovers without a duplicate final file", () => {
                using(var f=new Fixture()) {
                    string id=Guid.NewGuid().ToString("N");byte[] data={4,5,6};
                    using(var s=f.Open()) {Call(s,Start(id,data));Call(s,Chunk(id,data));}
                    string journal=Path.Combine(f.Journal,Owner+"-"+id+".json");var record=Json.Deserialize<TransferRecord>(File.ReadAllText(journal));
                    record.State="committing";record.FinalName="file.bin";File.WriteAllText(journal,Json.Serialize(record));
                    File.Move(Directory.GetFiles(f.Files,"*.part").Single(),Path.Combine(f.Files,"file.bin"));
                    using(var s=f.Open()) {Wait(s,id,"complete");Call(s,Request("finish",id));}
                    Check(Directory.GetFiles(f.Files).Length==1,"duplicate final file created");
                }
            });
            Test("directory listings paginate without dropping names", () => {
                using(var f=new Fixture()) using(var s=f.Open()) {
                    for(int n=0;n<270;n++) File.WriteAllText(Path.Combine(f.Files,n.ToString("D4")+".txt"),"");
                    var request=Request("list");request["root"]="home";request["path"]="";
                    var first=Call(s,request);Check(((System.Collections.ICollection)first["entries"]).Count==256,"first page wrong");
                    request["after"]=first["next"];var second=Call(s,request);
                    Check(((System.Collections.ICollection)second["entries"]).Count==14 && (string)second["next"]=="","pagination wrong");
                }
            });
            Test("commit recovery reports changed output instead of verifying forever", () => {
                using(var f=new Fixture()) {
                    string id=Guid.NewGuid().ToString("N");byte[] data={4,5,6};
                    using(var s=f.Open()) {Call(s,Start(id,data));Call(s,Chunk(id,data));}
                    string journal=Path.Combine(f.Journal,Owner+"-"+id+".json");var record=Json.Deserialize<TransferRecord>(File.ReadAllText(journal));
                    record.State="committing";record.FinalName="file.bin";File.WriteAllText(journal,Json.Serialize(record));
                    File.Move(Directory.GetFiles(f.Files,"*.part").Single(),Path.Combine(f.Files,"file.bin"));
                    File.WriteAllBytes(Path.Combine(f.Files,"file.bin"),new byte[]{7,8,9});
                    using(var s=f.Open()) {
                        var result=Wait(s,id,"error");Check((string)result["code"]=="FILES_HASH_MISMATCH","changed output accepted");
                        Call(s,Request("cancel",id));Check(File.ReadAllBytes(Path.Combine(f.Files,"file.bin")).SequenceEqual(new byte[]{7,8,9}),"cancel deleted final output");
                    }
                }
            });
            Console.WriteLine("Passed "+passed+" file-transfer scenarios.");return 0;
        } catch(Exception error) {Console.Error.WriteLine(error);return 1;}
    }
}
