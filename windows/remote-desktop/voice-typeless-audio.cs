using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

namespace ClipRelay.Remote {
    // Only Typeless's application preference is leased. The system default input,
    // its output preference and Typeless's settings file are never changed.
    public sealed class TypelessAudioRoute : IDisposable {
        readonly List<MicrophoneLease> leases = new List<MicrophoneLease>();
        public static string JournalPath(int role) {
            return Path.Combine(VoiceInput.UserAppData(), "ClipRelay", "voice-typeless-microphone-" + role + ".json");
        }
        public static bool RecoveryPending {
            get { for (int role = 0; role < 3; role++) if (File.Exists(JournalPath(role))) return true; return false; }
        }
        public TypelessAudioRoute(Func<int, string> read, Action<int, string> write, Func<int, string> path) {
            try {
                // Everyone acquires role 0 first, so a second worker cannot recover
                // or nest any role while the first worker owns this application.
                for (int role = 0; role < 3; role++) {
                    int selected = role;
                    leases.Add(new MicrophoneLease(path(role), () => read(selected), value => write(selected, value)));
                }
            } catch { Dispose(); throw; }
        }
        public void Select(string endpoint) {
            try { foreach (var lease in leases) lease.Select(endpoint); }
            catch { Dispose(); throw; }
        }
        public void Dispose() {
            // Keep role 0 locked until every other role has been restored.
            for (int i = leases.Count - 1; i >= 0; i--) leases[i].Dispose();
            leases.Clear();
        }
        public void LeaveForRecovery() {
            for (int i = leases.Count - 1; i >= 0; i--) leases[i].LeaveForRecovery();
            leases.Clear();
        }
    }

    // This Windows interface is versioned and not a public API. Resolve only known
    // interface IDs and fail closed on incompatible systems. ABI reference:
    // github.com/File-New-Project/EarTrumpet/tree/master/EarTrumpet/Interop/MMDeviceAPI
    public sealed class WindowsAppMicrophone : IDisposable {
        [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string value, uint length, out IntPtr result);
        [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr value);
        [DllImport("combase.dll")] static extern IntPtr WindowsGetStringRawBuffer(IntPtr value, out uint length);
        [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr name, ref Guid iid, out IntPtr result);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetEndpoint(IntPtr self, uint process, int flow, int role, out IntPtr endpoint);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetEndpoint(IntPtr self, uint process, int flow, int role, IntPtr endpoint);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetPointer(IntPtr self, out IntPtr value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetNumber(IntPtr self, out int value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetItem(IntPtr self, int index, out IntPtr value);
        IntPtr factory;
        readonly uint process;
        readonly DateTime processStarted;
        readonly GetEndpoint read;
        readonly SetEndpoint write;
        static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
        public WindowsAppMicrophone(uint process) {
            this.process = process;
            using (var target = Process.GetProcessById((int)process)) processStarted = target.StartTime.ToUniversalTime();
            const string name = "Windows.Media.Internal.AudioPolicyConfig";
            IntPtr text; Check(WindowsCreateString(name, (uint)name.Length, out text));
            try {
                int status = unchecked((int)0x80004002);
                foreach (string known in new[] { "ab3d4648-e242-459f-b02f-541c70306324", "2a59116d-6c4f-45e0-a74f-707e3fef9258" }) {
                    var iid = new Guid(known);
                    status = RoGetActivationFactory(text, ref iid, out factory);
                    if (status >= 0) break;
                    if (factory != IntPtr.Zero) { Marshal.Release(factory); factory = IntPtr.Zero; }
                    if (status != unchecked((int)0x80004002)) break;
                }
                Check(status);
                IntPtr table = Marshal.ReadIntPtr(factory);
                // IInspectable's six slots plus nineteen methods precede Set/Get.
                write = (SetEndpoint)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, 25 * IntPtr.Size), typeof(SetEndpoint));
                read = (GetEndpoint)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(table, 26 * IntPtr.Size), typeof(GetEndpoint));
            } catch { Dispose(); throw new InvalidOperationException("TYPELESS_ROUTING_UNSUPPORTED"); }
            finally { WindowsDeleteString(text); }
        }
        public string Read(int role) {
            if (factory == IntPtr.Zero) throw new ObjectDisposedException("WindowsAppMicrophone");
            CheckProcess();
            IntPtr value = IntPtr.Zero;
            int status = read(factory, process, 1, role, out value);
            try {
                // Windows returns E_INVALIDARG for an application with no saved
                // preference yet. Empty is the explicit "follow system default".
                if (status == unchecked((int)0x80070057)) return "";
                Check(status);
                uint length; IntPtr data = WindowsGetStringRawBuffer(value, out length);
                if (length > 4096) throw new InvalidOperationException("TYPELESS_ROUTING_UNSUPPORTED");
                return data == IntPtr.Zero ? "" : Marshal.PtrToStringUni(data, (int)length);
            } finally { if (value != IntPtr.Zero) WindowsDeleteString(value); }
        }
        public void Write(int role, string endpoint) {
            if (factory == IntPtr.Zero) throw new ObjectDisposedException("WindowsAppMicrophone");
            CheckProcess();
            IntPtr value = IntPtr.Zero;
            if (!String.IsNullOrEmpty(endpoint)) Check(WindowsCreateString(endpoint, (uint)endpoint.Length, out value));
            try { Check(write(factory, process, 1, role, value)); }
            finally { if (value != IntPtr.Zero) WindowsDeleteString(value); }
        }
        public void Dispose() { if (factory != IntPtr.Zero) { Marshal.Release(factory); factory = IntPtr.Zero; } }
        void CheckProcess() {
            using (var target = Process.GetProcessById((int)process))
                if (target.StartTime.ToUniversalTime() != processStarted) throw new InvalidOperationException("TYPELESS_REQUIRED");
        }

        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class EnumeratorClass { }
        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Enumerator {
            [PreserveSig] int Enumerate(int flow, uint state, out Collection devices);
        }
        [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Collection {
            [PreserveSig] int Count(out uint count);
            [PreserveSig] int Item(uint index, out Device device);
        }
        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Device {
            [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, out IntPtr value);
            [PreserveSig] int Properties(uint mode, out Properties store);
            [PreserveSig] int Id(out IntPtr id);
        }
        [StructLayout(LayoutKind.Sequential)] struct Key { public Guid format; public uint id; }
        [StructLayout(LayoutKind.Explicit, Size = 24)] struct Value { [FieldOffset(0)] public ushort kind; [FieldOffset(8)] public IntPtr text; }
        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Properties {
            [PreserveSig] int Count(out uint count);
            [PreserveSig] int At(uint index, out Key key);
            [PreserveSig] int Get(ref Key key, out Value value);
        }
        [DllImport("ole32.dll")] static extern int PropVariantClear(ref Value value);
        static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
        static Delegate Method(IntPtr value, int slot, Type type) {
            return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(value), slot * IntPtr.Size), type);
        }
        static string EndpointId(Device device) {
            IntPtr id; Check(device.Id(out id));
            try { return @"\\?\SWD#MMDEVAPI#" + Marshal.PtrToStringUni(id) + "#{2eef81be-33fa-4800-9670-1cd474972c3f}"; }
            finally { Marshal.FreeCoTaskMem(id); }
        }
        public string ActiveCaptureEndpoint() {
            CheckProcess();
            var enumerator = (Enumerator)new EnumeratorClass(); Collection devices = null;
            try {
                Check(enumerator.Enumerate(1, 1, out devices)); uint count; Check(devices.Count(out count));
                if (count > 128) throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED");
                string active = null;
                for (uint i = 0; i < count; i++) {
                    Device device = null; IntPtr manager = IntPtr.Zero, sessions = IntPtr.Zero;
                    try {
                        Check(devices.Item(i, out device));
                        var iid = new Guid("77aa99a0-1bd6-484f-8bc7-2c654c9a9b6f");
                        Check(device.Activate(ref iid, 23, IntPtr.Zero, out manager));
                        Check(((GetPointer)Method(manager, 5, typeof(GetPointer)))(manager, out sessions));
                        int total; Check(((GetNumber)Method(sessions, 3, typeof(GetNumber)))(sessions, out total));
                        if (total > 128) throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED");
                        for (int n = 0; n < total; n++) {
                            IntPtr session = IntPtr.Zero, control = IntPtr.Zero;
                            try {
                                Check(((GetItem)Method(sessions, 4, typeof(GetItem)))(sessions, n, out session));
                                var controlId = new Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d");
                                Check(Marshal.QueryInterface(session, ref controlId, out control));
                                int state, owner;
                                Check(((GetNumber)Method(control, 3, typeof(GetNumber)))(control, out state));
                                Check(((GetNumber)Method(control, 14, typeof(GetNumber)))(control, out owner));
                                if (state != 1 || owner != process) continue;
                                string id = EndpointId(device);
                                if (active != null && active != id) throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED");
                                active = id;
                            } finally { if (control != IntPtr.Zero) Marshal.Release(control); if (session != IntPtr.Zero) Marshal.Release(session); }
                        }
                    } finally { if (sessions != IntPtr.Zero) Marshal.Release(sessions); if (manager != IntPtr.Zero) Marshal.Release(manager); Release(device); }
                }
                return active;
            } finally { Release(devices); Release(enumerator); }
        }
        public static string CaptureEndpoint(string output) {
            var enumerator = (Enumerator)new EnumeratorClass();
            Collection devices = null;
            try {
                Check(enumerator.Enumerate(1, 1, out devices)); uint count; Check(devices.Count(out count));
                if (count > 128) throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED");
                string found = null;
                for (uint i = 0; i < count; i++) {
                    Device device = null; Properties properties = null;
                    try {
                        Check(devices.Item(i, out device)); Check(device.Properties(0, out properties));
                        var key = new Key { format = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), id = 14 };
                        Value value; Check(properties.Get(ref key, out value)); string label;
                        try { label = value.kind == 31 ? Marshal.PtrToStringUni(value.text) : ""; }
                        finally { PropVariantClear(ref value); }
                        string paired;
                        try { paired = TypelessVoice.VirtualOutput("endpoint", label); }
                        catch (InvalidOperationException) { continue; }
                        if (paired != output) continue;
                        if (found != null) throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED");
                        found = EndpointId(device);
                    } finally { Release(properties); Release(device); }
                }
                if (found == null) throw new InvalidOperationException("VIRTUAL_MIC_REQUIRED");
                return found;
            } finally { Release(devices); Release(enumerator); }
        }
    }
}
