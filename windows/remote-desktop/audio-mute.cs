// Endpoint mute leases never change volume, device format, or default routing.
// This is the recovery layer; stream audio continuity must be verified by the
// caller before exposing host-only mute as a supported end-user operation.
using System;
using System.Collections.Generic;
using System.IO;
using System.Diagnostics;
using System.Security.Principal;
using System.Threading;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace ClipRelay.Remote {
    public sealed class AudioMuteChange { public string Endpoint;public bool Muted; }
    public interface IAudioMuteAccess : IDisposable {
        bool ReadMute(string endpoint);
        void SetMute(string endpoint,bool value);
        void Watch(string endpoint);
        AudioMuteChange[] ExternalChanges();
        void StopWatching();
    }
    public sealed class AudioMuteLease : IDisposable {
        public const long LifetimeMs=15000;
        readonly IAudioMuteAccess access;
        readonly Func<long> now;
        readonly string path;
        readonly JavaScriptSerializer json=new JavaScriptSerializer { MaxJsonLength=65536,RecursionLimit=4 };
        readonly Dictionary<string,bool> originals=new Dictionary<string,bool>(StringComparer.Ordinal);
        FileStream gate;
        string lease="";
        long deadline;
        public string Lease { get { return lease; } }
        public long RemainingMs {get{return lease==""?0:Math.Max(0,Math.Min(LifetimeMs,deadline-now()));}}
        public bool PendingRecovery { get { return originals.Count!=0; } }
        public AudioMuteLease(IAudioMuteAccess access,Func<long> now,string path) {
            this.access=access;this.now=now;this.path=Path.GetFullPath(path);
            string directory=Path.GetDirectoryName(this.path);
            try {
                Directory.CreateDirectory(directory);
                RejectLink(directory);RejectLink(this.path);RejectLink(this.path+".lock");
                gate=new FileStream(this.path+".lock",FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
                Load();Restore();
            } catch {access.Dispose();if(gate!=null)gate.Dispose();gate=null;throw;}
        }
        static void RejectLink(string name) {
            if((File.Exists(name)||Directory.Exists(name)) && (File.GetAttributes(name)&FileAttributes.ReparsePoint)!=0)
                throw new IOException("AUDIO_RECOVERY_PATH_INVALID");
        }
        static bool Endpoint(string value) {return value!=null && value.Length>0 && value.Length<=512 && value.IndexOfAny(new[]{'\0','\r','\n'})<0;}
        void Load() {
            if(!File.Exists(path))return;
            RejectLink(path);var info=new FileInfo(path);
            if(info.Length>65536)throw new IOException("AUDIO_RECOVERY_INVALID");
            var record=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(path,new UTF8Encoding(false,true)));
            if(record==null || record.Count!=2 || !record.ContainsKey("version") || !(record["version"] is int) || (int)record["version"]!=1 || !record.ContainsKey("endpoints"))throw new IOException("AUDIO_RECOVERY_INVALID");
            var entries=record["endpoints"] as Dictionary<string,object>;
            if(entries==null || entries.Count>32)throw new IOException("AUDIO_RECOVERY_INVALID");
            foreach(var pair in entries) {if(!Endpoint(pair.Key) || !(pair.Value is bool))throw new IOException("AUDIO_RECOVERY_INVALID");originals.Add(pair.Key,(bool)pair.Value);}
        }
        void Save() {
            RejectLink(path);string temporary=path+"."+Guid.NewGuid().ToString("N")+".new";
            if(originals.Count==0) {if(File.Exists(path))File.Delete(path);return;}
            byte[] bytes=Encoding.UTF8.GetBytes(json.Serialize(new {version=1,endpoints=originals}));
            if(bytes.Length>65536)throw new IOException("AUDIO_RECOVERY_TOO_LARGE");
            try {
                using(var output=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {output.Write(bytes,0,bytes.Length);output.Flush(true);}
                if(File.Exists(path))File.Replace(temporary,path,null);else File.Move(temporary,path);
            } finally {if(File.Exists(temporary))File.Delete(temporary);}
        }
        void Verified(string endpoint,bool muted) {
            access.SetMute(endpoint,muted);
            if(access.ReadMute(endpoint)!=muted)throw new IOException("AUDIO_MUTE_NOT_APPLIED");
        }
        void Forget(string endpoint) {
            bool original=originals[endpoint];originals.Remove(endpoint);
            try {Save();} catch {originals[endpoint]=original;throw;}
        }
        public void Start(string id,IEnumerable<string> endpoints) {
            if(endpoints==null || id==null || !Regex.IsMatch(id,"\\A[0-9a-f]{32}\\z"))throw new ArgumentException("AUDIO_BAD_REQUEST");
            if(lease!="")throw new InvalidOperationException("AUDIO_BUSY");
            Restore();if(originals.Count!=0)throw new IOException("AUDIO_RECOVERY_PENDING");
            var targets=new HashSet<string>(StringComparer.Ordinal);
            foreach(string endpoint in endpoints) {if(!Endpoint(endpoint)||!targets.Add(endpoint)||targets.Count>32)throw new ArgumentException("AUDIO_BAD_REQUEST");}
            if(targets.Count==0)throw new ArgumentException("AUDIO_BAD_REQUEST");
            try {
                // Capture and persist every original value BEFORE the first write.
                // Already-muted endpoints are retained so they cannot be unmuted.
                foreach(string endpoint in targets) {access.Watch(endpoint);originals.Add(endpoint,access.ReadMute(endpoint));}
                Save();
                // A user change during preparation cancels before mutation too.
                if(ApplyExternalChanges())throw new IOException("AUDIO_CHANGED_LOCALLY");
                foreach(string endpoint in targets)Verified(endpoint,true);
                lease=id;deadline=now()+LifetimeMs;
            } catch {
                Restore();throw;
            }
        }
        public void Renew(string id) {
            Tick();if(lease=="" || lease!=id)throw new InvalidOperationException("AUDIO_EXPIRED");
            deadline=now()+LifetimeMs;
        }
        public void Stop(string id) {
            if(lease!="" && lease!=id)throw new InvalidOperationException("AUDIO_BUSY");
            Restore();
        }
        bool ApplyExternalChanges() {
            var changes=new List<AudioMuteChange>();
            foreach(var change in access.ExternalChanges())if(originals.ContainsKey(change.Endpoint)) {
                // Keep the override in memory even if disk is temporarily busy.
                // A later retry must not restore the old pre-lease value.
                originals[change.Endpoint]=change.Muted;changes.Add(change);
            }
            // Persist observed overrides before restoring other leased endpoints.
            // Keep the notification's value, since a callback can arrive after
            // an in-flight mute write overwrote the user's earlier selection.
            if(changes.Count!=0) {
                Save();
                foreach(var change in changes) {
                    if(access.ReadMute(change.Endpoint)!=change.Muted)Verified(change.Endpoint,change.Muted);
                    Forget(change.Endpoint);
                }
            }
            return changes.Count!=0;
        }
        public void Tick() {
            if(lease=="") {if(originals.Count!=0)Restore();return;}
            try {
                if(ApplyExternalChanges() || now()>=deadline) {Restore();return;}
                foreach(string endpoint in new List<string>(originals.Keys))if(!access.ReadMute(endpoint)) {originals[endpoint]=false;Forget(endpoint);Restore();return;}
            } catch {Restore();}
        }
        public void Restore() {
            lease="";deadline=0;
            // Notification callbacks remain registered until restoration finishes.
            // Device disappearance keeps only that endpoint in the journal.
            ApplyExternalChanges();
            foreach(string endpoint in new List<string>(originals.Keys)) {
                try {
                    bool original=originals[endpoint],current=access.ReadMute(endpoint);
                    if(current && !original)Verified(endpoint,false);
                    Forget(endpoint);
                } catch { }
            }
            access.StopWatching();
        }
        public void Dispose() {
            if(gate==null)return;
            try {Restore();} finally {access.Dispose();gate.Dispose();gate=null;}
        }
    }
    // Called only by the service's serialized monitor. Retry absent devices or
    // a not-yet-ready desktop shell without spawning a helper every second.
    public sealed class AudioMuteRecoverySchedule {
        readonly Func<long> now;
        readonly Dictionary<uint,long> pending=new Dictionary<uint,long>();
        uint observed=uint.MaxValue;
        public AudioMuteRecoverySchedule(Func<long> now) {this.now=now;}
        public void Observe(uint session) {
            if(observed==session)return;
            observed=session;Request(session);
        }
        public void Request(uint session) {
            if(session!=uint.MaxValue && session!=0)pending[session]=0;
        }
        public void Tick(uint session,Func<uint,bool> recover) {
            long next;
            if(!pending.TryGetValue(session,out next) || now()<next)return;
            // Set before invoking the worker so even launch errors are bounded.
            pending[session]=now()+30000;
            // A worker may crash after an earlier successful audit while its
            // parent stays alive. Keep auditing the current session; the helper
            // exits without opening Core Audio when there is no journal.
            try {if(recover(session))pending[session]=now()+60000;} catch { }
        }
    }
    public static class AudioMuteRecovery {
        public static string JournalPath {get{return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ClipRelay","audio-mute.json");}}
        public static int Run() {
            using(var identity=WindowsIdentity.GetCurrent())if(identity.IsSystem)return DesktopUserProcess.RunWorker("--audio-mute-recover");
            // An ordinary startup with no outstanding journal does not initialize
            // Core Audio, enumerate devices, or create a recovery directory.
            if(!File.Exists(JournalPath))return 0;
            int result=2;
            var thread=new Thread(()=>{
                try {
                    var clock=Stopwatch.StartNew();
                    using(var access=new WindowsAudioMuteAccess())
                    using(var lease=new AudioMuteLease(access,()=>clock.ElapsedMilliseconds,JournalPath))result=lease.PendingRecovery?1:0;
                } catch {result=2;}
            });
            thread.SetApartmentState(ApartmentState.STA);thread.Start();thread.Join();return result;
        }
    }
}
