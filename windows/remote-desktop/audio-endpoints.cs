using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

namespace ClipRelay.Remote {
    public sealed class AudioEndpointInfo {
        public string Id,Name;
        public bool Default,Muted;
        public float LevelDb;
        public uint HardwareSupport;
    }
    // Used on a desktop-user STA. Core Audio callbacks only queue endpoint IDs;
    // they do not call COM, mutate settings, or block on disk I/O.
    public sealed class WindowsAudioMuteAccess : IAudioMuteAccess {
        [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumeratorClass {}
        [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface DeviceEnumerator {
            [PreserveSig]int EnumAudioEndpoints(int flow,uint state,out DeviceCollection devices);
            [PreserveSig]int GetDefaultAudioEndpoint(int flow,int role,out Device device);
            [PreserveSig]int GetDevice([MarshalAs(UnmanagedType.LPWStr)]string id,out Device device);
            [PreserveSig]int RegisterEndpointNotificationCallback(IntPtr callback);
            [PreserveSig]int UnregisterEndpointNotificationCallback(IntPtr callback);
        }
        [ComImport,Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface DeviceCollection {
            [PreserveSig]int GetCount(out uint count);
            [PreserveSig]int Item(uint index,out Device device);
        }
        [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Device {
            [PreserveSig]int Activate(ref Guid iid,uint context,IntPtr parameters,[MarshalAs(UnmanagedType.IUnknown)]out object value);
            [PreserveSig]int OpenPropertyStore(uint mode,out PropertyStore store);
            [PreserveSig]int GetId(out IntPtr id);
            [PreserveSig]int GetState(out uint state);
        }
        [StructLayout(LayoutKind.Sequential)] struct PropertyKey {public Guid format;public uint id;}
        [StructLayout(LayoutKind.Explicit,Size=24)] struct Variant { [FieldOffset(0)]public ushort kind;[FieldOffset(8)]public IntPtr text; }
        [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface PropertyStore {
            [PreserveSig]int GetCount(out uint count);
            [PreserveSig]int GetAt(uint index,out PropertyKey key);
            [PreserveSig]int GetValue(ref PropertyKey key,out Variant value);
            [PreserveSig]int SetValue(ref PropertyKey key,ref Variant value);
            [PreserveSig]int Commit();
        }
        [DllImport("ole32.dll")] static extern int PropVariantClear(ref Variant value);
        [ComImport,Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface EndpointVolume {
            [PreserveSig]int RegisterControlChangeNotify(VolumeCallback callback);
            [PreserveSig]int UnregisterControlChangeNotify(VolumeCallback callback);
            [PreserveSig]int GetChannelCount(out uint count);
            [PreserveSig]int SetMasterVolumeLevel(float value,ref Guid context);
            [PreserveSig]int SetMasterVolumeLevelScalar(float value,ref Guid context);
            [PreserveSig]int GetMasterVolumeLevel(out float value);
            [PreserveSig]int GetMasterVolumeLevelScalar(out float value);
            [PreserveSig]int SetChannelVolumeLevel(uint channel,float value,ref Guid context);
            [PreserveSig]int SetChannelVolumeLevelScalar(uint channel,float value,ref Guid context);
            [PreserveSig]int GetChannelVolumeLevel(uint channel,out float value);
            [PreserveSig]int GetChannelVolumeLevelScalar(uint channel,out float value);
            [PreserveSig]int SetMute([MarshalAs(UnmanagedType.Bool)]bool value,ref Guid context);
            [PreserveSig]int GetMute([MarshalAs(UnmanagedType.Bool)]out bool value);
            [PreserveSig]int GetVolumeStepInfo(out uint step,out uint count);
            [PreserveSig]int VolumeStepUp(ref Guid context);
            [PreserveSig]int VolumeStepDown(ref Guid context);
            [PreserveSig]int QueryHardwareSupport(out uint value);
            [PreserveSig]int GetVolumeRange(out float minimum,out float maximum,out float step);
        }
        [Guid("657804FA-D6AD-4496-8A60-352752AF4F89"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown),ComVisible(true)] public interface VolumeCallback {
            [PreserveSig]int OnNotify(IntPtr data);
        }
        [ComVisible(true),ClassInterface(ClassInterfaceType.None)] public sealed class Callback : VolumeCallback {
            readonly WindowsAudioMuteAccess owner;
            readonly string endpoint;
            readonly long generation;
            bool lastMuted;
            internal Callback(WindowsAudioMuteAccess owner,string endpoint,bool muted) {this.owner=owner;this.endpoint=endpoint;this.generation=owner.generation;lastMuted=muted;}
            public int OnNotify(IntPtr data) {
                try {
                    if(data!=IntPtr.Zero)lock(owner.changed) {
                        if(owner.disposed || generation!=owner.generation)return 0;
                        bool muted=Marshal.ReadInt32(data,16)!=0;
                        // Endpoint callbacks also report volume-only changes.
                        // Those must not cancel a lease and leave its mute behind.
                        if(muted!=lastMuted && (Guid)Marshal.PtrToStructure(data,typeof(Guid))!=owner.context)owner.changed[endpoint]=muted;
                        lastMuted=muted;
                    }
                } catch { }
                return 0;
            }
        }
        sealed class Watcher {public EndpointVolume volume;public Callback callback;}
        readonly DeviceEnumerator enumerator=(DeviceEnumerator)new DeviceEnumeratorClass();
        readonly Dictionary<string,Watcher> watching=new Dictionary<string,Watcher>(StringComparer.Ordinal);
        readonly Dictionary<string,bool> changed=new Dictionary<string,bool>(StringComparer.Ordinal);
        Guid context=Guid.NewGuid();
        long generation;
        bool disposed;
        static void Check(int status) {if(status<0)Marshal.ThrowExceptionForHR(status);}
        static void Release(object value) {if(value!=null && Marshal.IsComObject(value))Marshal.ReleaseComObject(value);}
        static string Id(Device device) {IntPtr value;Check(device.GetId(out value));try{return Marshal.PtrToStringUni(value);}finally{Marshal.FreeCoTaskMem(value);}}
        static EndpointVolume Activate(Device device) {
            uint state;Check(device.GetState(out state));if(state!=1)throw new IOException("AUDIO_ENDPOINT_UNAVAILABLE");
            Guid iid=typeof(EndpointVolume).GUID;object value;Check(device.Activate(ref iid,23,IntPtr.Zero,out value));return (EndpointVolume)value;
        }
        EndpointVolume Open(string id) {
            if(disposed)throw new ObjectDisposedException("WindowsAudioMuteAccess");
            Device device=null;try{Check(enumerator.GetDevice(id,out device));return Activate(device);}finally{Release(device);}
        }
        public AudioEndpointInfo[] Endpoints() {
            if(disposed)throw new ObjectDisposedException("WindowsAudioMuteAccess");
            string current="";Device preferred=null;DeviceCollection collection=null;
            try {
                if(enumerator.GetDefaultAudioEndpoint(0,0,out preferred)>=0)current=Id(preferred);
                Check(enumerator.EnumAudioEndpoints(0,1,out collection));uint count;Check(collection.GetCount(out count));
                if(count>64)throw new IOException("AUDIO_TOO_MANY_ENDPOINTS");
                var list=new List<AudioEndpointInfo>();
                for(uint i=0;i<count;i++) {
                    Device device=null;PropertyStore store=null;EndpointVolume volume=null;
                    try {
                        Check(collection.Item(i,out device));string id=Id(device);
                        Check(device.OpenPropertyStore(0,out store));var key=new PropertyKey {format=new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),id=14};Variant value;
                        Check(store.GetValue(ref key,out value));string name;
                        try{name=value.kind==31?Marshal.PtrToStringUni(value.text):"";}finally{PropVariantClear(ref value);}
                        volume=Activate(device);bool muted;float db;uint hardware;
                        Check(volume.GetMute(out muted));Check(volume.GetMasterVolumeLevel(out db));Check(volume.QueryHardwareSupport(out hardware));
                        list.Add(new AudioEndpointInfo {Id=id,Name=name,Default=id==current,Muted=muted,LevelDb=db,HardwareSupport=hardware});
                    } finally {Release(volume);Release(store);Release(device);}
                }
                return list.ToArray();
            } finally {Release(collection);Release(preferred);}
        }
        public bool ReadMute(string endpoint) {var volume=Open(endpoint);try{bool muted;Check(volume.GetMute(out muted));return muted;}finally{Release(volume);}}
        public void SetMute(string endpoint,bool value) {var volume=Open(endpoint);try{Check(volume.SetMute(value,ref context));}finally{Release(volume);}}
        public void Watch(string endpoint) {
            if(watching.ContainsKey(endpoint))return;
            if(watching.Count>=32)throw new IOException("AUDIO_TOO_MANY_ENDPOINTS");
            var watcher=new Watcher {volume=Open(endpoint)};
            try {
                bool muted;Check(watcher.volume.GetMute(out muted));watcher.callback=new Callback(this,endpoint,muted);
                Check(watcher.volume.RegisterControlChangeNotify(watcher.callback));watching.Add(endpoint,watcher);
            }
            catch {Release(watcher.volume);throw;}
        }
        public AudioMuteChange[] ExternalChanges() {lock(changed){var result=new List<AudioMuteChange>();foreach(var pair in changed)result.Add(new AudioMuteChange {Endpoint=pair.Key,Muted=pair.Value});changed.Clear();return result.ToArray();}}
        public void StopWatching() {
            // In-flight callbacks from a previous lease cannot cancel a new one.
            lock(changed){generation++;changed.Clear();}
            foreach(var watcher in watching.Values) {try{watcher.volume.UnregisterControlChangeNotify(watcher.callback);}finally{Release(watcher.volume);}}
            watching.Clear();
        }
        public void Dispose() {if(disposed)return;lock(changed)disposed=true;try{StopWatching();}finally{Release(enumerator);}}
    }
}
