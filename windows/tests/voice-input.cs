using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Diagnostics;
using System.Threading;
using ClipRelay.Remote;

// No microphone recording from a physical device. Optional loop test opens ONLY the Steam virtual cable.
public static class VoiceInputTest {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class AudioEnumeratorClass { }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface AudioEnumerator {
        [PreserveSig] int Enumerate(int flow, uint state, out IntPtr devices);
        [PreserveSig] int Default(int flow, int role, out AudioDevice device);
    }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface AudioDevice {
        [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, out IntPtr value);
        [PreserveSig] int Properties(uint mode, out IntPtr store);
        [PreserveSig] int Id(out IntPtr id);
    }
    static string DefaultInput() {
        var enumerator = (AudioEnumerator)new AudioEnumeratorClass(); AudioDevice device = null;
        try {
            Marshal.ThrowExceptionForHR(enumerator.Default(1, 0, out device)); IntPtr id;
            Marshal.ThrowExceptionForHR(device.Id(out id));
            try { return Marshal.PtrToStringUni(id); } finally { Marshal.FreeCoTaskMem(id); }
        } finally { if (device != null) Marshal.ReleaseComObject(device); Marshal.ReleaseComObject(enumerator); }
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Caps {
        public ushort manufacturer, product; public uint version;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string name;
        public uint formats; public ushort channels, reserved;
    }
    [DllImport("winmm.dll")] static extern uint waveInGetNumDevs();
    [DllImport("winmm.dll",CharSet=CharSet.Unicode)] static extern uint waveInGetDevCaps(UIntPtr id,out Caps caps,uint size);
    [DllImport("winmm.dll")] static extern uint waveInOpen(out IntPtr handle,uint id,ref PcmPlayback.Format format,IntPtr callback,IntPtr instance,uint flags);
    [DllImport("winmm.dll")] static extern uint waveInPrepareHeader(IntPtr handle,IntPtr header,uint size);
    [DllImport("winmm.dll")] static extern uint waveInAddBuffer(IntPtr handle,IntPtr header,uint size);
    [DllImport("winmm.dll")] static extern uint waveInStart(IntPtr handle);
    [DllImport("winmm.dll")] static extern uint waveInReset(IntPtr handle);
    [DllImport("winmm.dll")] static extern uint waveInUnprepareHeader(IntPtr handle,IntPtr header,uint size);
    [DllImport("winmm.dll")] static extern uint waveInClose(IntPtr handle);
    static void Check(bool condition,string text) { if(!condition) throw new Exception(text); }
    static void Equal(int[] actual, params int[] expected) {
        Check(String.Join(",",actual)==String.Join(",",expected),"Incorrect shortcut");
    }
    [STAThread] public static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "--capture-only") return CaptureOnly();
        if (args.Length == 1 && args[0] == "--app-microphone-routing") {
            string root = Path.Combine(Path.GetDirectoryName(typeof(VoiceInputTest).Assembly.Location), "app-route-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(root);
            try {
                string defaultBefore = DefaultInput();
                using (var policy = new WindowsAppMicrophone((uint)Process.GetCurrentProcess().Id)) {
                    var original = new[] { policy.Read(0), policy.Read(1), policy.Read(2) };
                    string endpoint = WindowsAppMicrophone.CaptureEndpoint("Steam Streaming Micro");
                    using (var route = new TypelessAudioRoute(policy.Read, policy.Write, role => Path.Combine(root, "role" + role + ".json"))) {
                        route.Select(endpoint);
                        Check(endpoint.Contains(DefaultInput()), "Default input did not follow the application route");
                        for (int role = 0; role < 3; role++) Check(policy.Read(role) == endpoint, "Windows did not apply application input role " + role);
                    }
                    for (int role = 0; role < 3; role++) Check(policy.Read(role) == original[role], "Windows did not restore application input role " + role);
                    Check(DefaultInput() == defaultBefore, "Original default input was not restored");
                }
                Check(Directory.GetFiles(root, "*.json").Length == 0, "Windows recovery remains pending");
                Console.WriteLine("Windows application microphone: virtual endpoint discovery, all three roles, readback and restoration passed. No audio recorded.");
                return 0;
            } catch (Exception error) { Console.WriteLine(error.GetType().Name + ": " + error.Message + "\n" + error.StackTrace); return 1; }
            finally { if (Directory.GetFiles(root, "*.json").Length == 0) Directory.Delete(root, true); }
        }
        if (args.Length == 1 && args[0] == "--typeless-routing") {
            try {
                using (var voice = new TypelessVoice()) {
                    voice.CheckAvailable();
                    Console.WriteLine("Typeless idle and compatible; virtual output=" + voice.OutputDevice);
                    voice.SelectMicrophone();
                    Console.WriteLine("Application input switched and read back; no recording started.");
                }
                Check(!TypelessAudioRoute.RecoveryPending, "Application input restore remains pending");
                Console.WriteLine("Typeless application input restored.");
                return 0;
            } catch (Exception error) { Console.WriteLine(error.GetType().Name + ": " + error.Message); return 1; }
        }
        if (args.Length == 2 && args[0] == "--typeless-microphone-crash") {
            var lease = Route(args[1]);
            lease.Select("virtual");
            Environment.Exit(0);
        }
        if (args.Length == 2 && args[0] == "--microphone-crash") {
            string deviceFile = Path.Combine(args[1], "device");
            var lease = new MicrophoneLease(Path.Combine(args[1], "lease.json"),
                () => File.ReadAllText(deviceFile), value => File.WriteAllText(deviceFile, value));
            lease.Select("virtual");
            Environment.Exit(0); // Deliberately bypass Dispose, like a killed worker.
        }
        TestMicrophoneRecovery();
        TestTypelessRouting();
        try { TestTypeless(); }
        catch (Exception e) { Console.WriteLine("Typeless test failed: " + e.GetType().Name + ": " + e.Message); return 1; }
        DoubaoVoice.CheckSettingsContract(typeof(CompatibleSettings));
        foreach (var type in new[] { null, typeof(object), typeof(MissingPatch), typeof(WrongPatch), typeof(WrongList), typeof(StaticPatch) }) {
            bool rejected = false;
            try { DoubaoVoice.CheckSettingsContract(type); }
            catch (InvalidOperationException e) { rejected = e.Message == "DOUBAO_VERSION_UNSUPPORTED"; }
            Check(rejected, "Incompatible settings contract accepted: " + type);
        }
        Console.WriteLine("Provider capability checks passed (no version allowlist).");
        if (args.Length == 1 && args[0] == "--provider") {
            using (var provider = new DoubaoVoice()) provider.CheckAvailable();
            Console.WriteLine("Installed provider capability probe passed.");
            return 0;
        }
        if(args.Length==0) return 0;
        uint device=uint.MaxValue;
        for(uint i=0;i<waveInGetNumDevs();i++){Caps caps;if(waveInGetDevCaps(new UIntPtr(i),out caps,(uint)Marshal.SizeOf(typeof(Caps)))==0 && caps.name.Contains("Steam Streaming Micro")){device=i;break;}}
        Check(device!=uint.MaxValue,"Steam virtual capture device unavailable");
        {
        var format=PcmPlayback.Format.Pcm;IntPtr input;
        if(args.Length>1) { format.samples=UInt32.Parse(args[1]); format.bytes=format.samples*2; }
        Check(waveInOpen(out input,device,ref format,IntPtr.Zero,IntPtr.Zero,0)==0,"Cannot open virtual capture");
        uint size=(uint)Marshal.SizeOf(typeof(PcmPlayback.Header));
        IntPtr data=Marshal.AllocHGlobal((int)format.bytes*2),header=Marshal.AllocHGlobal((int)size);
        try {
            Marshal.StructureToPtr(new PcmPlayback.Header{data=data,length=format.bytes*2},header,false);
            Check(waveInPrepareHeader(input,header,size)==0 && waveInAddBuffer(input,header,size)==0 && waveInStart(input)==0,"Cannot capture virtual cable");
            using(var output=new PcmPlayback(PcmPlayback.Find("Steam Streaming Micro"),format)) {
                Thread.Sleep(150);
                for(int part=0;part<5;part++){
                    int samples=(int)format.samples/5;
                    byte[] tone=new byte[samples*2];
                    for(int i=0;i<samples;i++){short sample=(short)(Math.Sin((part*samples+i)*2*Math.PI*440/format.samples)*10000);tone[i*2]=(byte)sample;tone[i*2+1]=(byte)(sample>>8);}
                    output.Write(tone);Thread.Sleep(200);
                }
                output.Drain();
            }
            Thread.Sleep(300);waveInReset(input);
            var state=(PcmPlayback.Header)Marshal.PtrToStructure(header,typeof(PcmPlayback.Header));
            byte[] recorded=new byte[state.recorded];Marshal.Copy(data,recorded,0,recorded.Length);
            int peak=0,nonzero=0;
            for(int i=0;i+1<recorded.Length;i+=2){int sample=Math.Abs((int)(short)(recorded[i]|recorded[i+1]<<8));peak=Math.Max(peak,sample);if(sample>1000)nonzero++;}
            double toneEnergy=Energy(recorded,440,format.samples), otherEnergy=Math.Max(Energy(recorded,300,format.samples),Energy(recorded,700,format.samples));
            Console.WriteLine("Virtual cable: bytes="+recorded.Length+", peak="+peak+", active samples="+nonzero+", tone="+toneEnergy.ToString("F0")+", other="+otherEnergy.ToString("F0"));
            if(!(peak>5000 && nonzero>3000 && toneEnergy>otherEnergy*5)) { Console.WriteLine("FAIL: Virtual cable did not reproduce the 440 Hz test tone."); return 1; }
            Console.WriteLine("Virtual microphone loop passed: PCM bytes="+recorded.Length+", peak="+peak+", tone ratio="+(toneEnergy/Math.Max(1,otherEnergy)).ToString("F1")+".");
        } finally {waveInReset(input);waveInUnprepareHeader(input,header,size);waveInClose(input);Marshal.FreeHGlobal(data);Marshal.FreeHGlobal(header);}
        }
        return 0;
    }
    sealed class TypelessAccess : ITypelessVoiceAccess {
        public TypelessVoiceState Current = TypelessVoiceState.Idle;
        public int Starts, Stops, Cancels;
        public bool FailFinish, WrongInput, StartRecording = true;
        public uint Prepare() { return 3; }
        public void SelectMicrophone() { }
        public void VerifyRecordingInput() { if (WrongInput) throw new InvalidOperationException("VOICE_AUDIO_DEVICE_FAILED"); }
        public TypelessVoiceState State { get { return Current; } }
        public void Begin() { Starts++; if (StartRecording) Current = TypelessVoiceState.Recording; }
        public void Finish(bool commit) {
            if (commit) Stops++; else Cancels++;
            if (FailFinish) throw new IOException("Unknown invocation result");
            Current = TypelessVoiceState.Idle;
        }
        public void Dispose() { }
    }
    static int CaptureOnly() {
        uint device = UInt32.MaxValue;
        for (uint i = 0; i < waveInGetNumDevs(); i++) {
            Caps caps;
            if (waveInGetDevCaps(new UIntPtr(i), out caps, (uint)Marshal.SizeOf(typeof(Caps))) == 0 && caps.name.Contains("Steam Streaming Micro")) { device = i; break; }
        }
        Check(device != UInt32.MaxValue, "Virtual input missing");
        var format = PcmPlayback.Format.Pcm; format.samples = 48000; format.bytes = 96000;
        IntPtr input; Check(waveInOpen(out input, device, ref format, IntPtr.Zero, IntPtr.Zero, 0) == 0, "Virtual capture failed");
        uint size = (uint)Marshal.SizeOf(typeof(PcmPlayback.Header));
        IntPtr data = Marshal.AllocHGlobal((int)format.bytes * 12), header = Marshal.AllocHGlobal((int)size);
        try {
            Marshal.StructureToPtr(new PcmPlayback.Header { data = data, length = format.bytes * 12 }, header, false);
            Check(waveInPrepareHeader(input, header, size) == 0 && waveInAddBuffer(input, header, size) == 0 && waveInStart(input) == 0, "Virtual capture start failed");
            Thread.Sleep(10000); waveInReset(input);
            var state = (PcmPlayback.Header)Marshal.PtrToStructure(header, typeof(PcmPlayback.Header));
            byte[] bytes = new byte[state.recorded]; Marshal.Copy(data, bytes, 0, bytes.Length);
            int peak = 0, active = 0; double sum = 0;
            for (int i = 0; i + 1 < bytes.Length; i += 2) { int sample = (short)(bytes[i] | bytes[i + 1] << 8); peak = Math.Max(peak, Math.Abs(sample)); if (Math.Abs(sample) > 300) active++; sum += (double)sample * sample; }
            Console.WriteLine("Virtual capture probe: samples=" + bytes.Length / 2 + ", peak=" + peak + ", active=" + active + ", RMS=" + Math.Sqrt(sum / Math.Max(1, bytes.Length / 2)).ToString("F0"));
            return 0;
        } finally { waveInReset(input); waveInUnprepareHeader(input, header, size); waveInClose(input); Marshal.FreeHGlobal(data); Marshal.FreeHGlobal(header); }
    }
    static TypelessAudioRoute Route(string path, Action<int, string> write = null) {
        return new TypelessAudioRoute(role => File.ReadAllText(Path.Combine(path, "device" + role)),
            write ?? ((role, value) => File.WriteAllText(Path.Combine(path, "device" + role), value)),
            role => Path.Combine(path, "route" + role + ".json"));
    }
    static void TestTypelessRouting() {
        string root = Path.Combine(Path.GetDirectoryName(typeof(VoiceInputTest).Assembly.Location), "typeless-route-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            for (int role = 0; role < 3; role++) File.WriteAllText(Path.Combine(root, "device" + role), role == 0 ? "" : "physical" + role);
            using (var route = Route(root)) {
                route.Select("virtual");
                Reject(() => { using (var nested = Route(root)) { } }, "VOICE_BUSY");
                File.WriteAllText(Path.Combine(root, "device1"), "user-choice");
            }
            Check(File.ReadAllText(Path.Combine(root, "device0")) == "" && File.ReadAllText(Path.Combine(root, "device1")) == "user-choice" && File.ReadAllText(Path.Combine(root, "device2")) == "physical2", "Per-role restore or manual selection lost");
            using (var route = Route(root, (role, value) => {
                if (role == 1 && value == "virtual") throw new IOException("Write failed");
                File.WriteAllText(Path.Combine(root, "device" + role), value);
            })) Reject(() => route.Select("virtual"), "VOICE_AUDIO_DEVICE_FAILED");
            Check(File.ReadAllText(Path.Combine(root, "device0")) == "" && File.ReadAllText(Path.Combine(root, "device1")) == "user-choice", "Partial switch not rolled back");
            var start = new ProcessStartInfo(typeof(VoiceInputTest).Assembly.Location, "--typeless-microphone-crash \"" + root + "\"") { UseShellExecute = false, CreateNoWindow = true };
            using (var crashed = Process.Start(start)) { Check(crashed.WaitForExit(10000), "Crash test timed out"); Check(crashed.ExitCode == 0, "Crash fixture failed"); }
            Check(File.ReadAllText(Path.Combine(root, "device2")) == "virtual", "Crash fixture did not switch");
            using (var recovery = Route(root)) { }
            Check(File.ReadAllText(Path.Combine(root, "device0")) == "" && File.ReadAllText(Path.Combine(root, "device1")) == "user-choice" && File.ReadAllText(Path.Combine(root, "device2")) == "physical2", "Crash recovery lost original roles");
            Check(Directory.GetFiles(root, "*.json").Length == 0, "Recovery journals remain");
            using (var pending = Route(root)) { pending.Select("virtual"); pending.LeaveForRecovery(); }
            Check(File.ReadAllText(Path.Combine(root, "device0")) == "virtual" && Directory.GetFiles(root, "*.json").Length == 3,
                "Unconfirmed stop restored physical input or discarded recovery records");
            using (var recovery = Route(root)) { }
            Check(File.ReadAllText(Path.Combine(root, "device0")) == "" && File.ReadAllText(Path.Combine(root, "device1")) == "user-choice" &&
                File.ReadAllText(Path.Combine(root, "device2")) == "physical2" && Directory.GetFiles(root, "*.json").Length == 0,
                "Deferred microphone recovery failed");
            Console.WriteLine("Typeless routing: independent roles, user changes, exclusivity, partial failure and worker crash recovery passed.");
        } finally { Directory.Delete(root, true); }
    }
    static void Reject(Action action, string code) {
        try { action(); } catch (InvalidOperationException e) { Check(e.Message == code, "Wrong failure: " + e.Message); return; }
        throw new Exception("Expected " + code);
    }
    static void TestTypeless() {
        Equal(TypelessVoice.ParseShortcut("RightAlt"), 0xA5);
        Equal(TypelessVoice.ParseShortcut("RightAlt+RightCtrl"), 0xA5, 0xA3);
        foreach (string value in new[] { null, "", "Alt", "RightAlt+", "RightAlt+RightAlt", "LeftWin", "A", "RightAlt+Enter", "LeftCtrl+V" })
            Reject(() => TypelessVoice.ParseShortcut(value), "TYPELESS_SHORTCUT_REQUIRED");
        Check(TypelessVoice.VirtualOutput("virtual", "Microphone (Steam Streaming Microphone)") == "Steam Streaming Micro", "Steam mapping");
        Check(TypelessVoice.VirtualOutput("virtual", "CABLE Output (VB-Audio Virtual Cable)") == "CABLE Input", "Cable direction");
        foreach (string id in new[] { null, "", "default", "communications" })
            Reject(() => TypelessVoice.VirtualOutput(id, "Steam Streaming Microphone"), "TYPELESS_MIC_REQUIRED");
        Reject(() => TypelessVoice.VirtualOutput("physical", "Realtek Microphone"), "TYPELESS_MIC_REQUIRED");
        Reject(() => TypelessVoice.VirtualOutput("cable", "CABLE Input (VB-Audio Virtual Cable)"), "TYPELESS_MIC_REQUIRED");
        string output;
        string settings = "{\"selectedMicrophoneDevice\":{\"deviceId\":\"virtual\",\"label\":\"Steam Streaming Microphone\"},\"featureShortcutBindings\":{\"dictationMode\":[\"LeftCtrl+V\",\"RightAlt\",\"RightAlt+RightCtrl\"],\"askAnythingMode\":[\"RightAlt\"]}}";
        Equal(TypelessVoice.ReadSettings(settings, out output), 0xA5, 0xA3);
        Check(output == "Steam Streaming Micro", "Wrong output");
        Reject(() => TypelessVoice.ReadSettings("{}", out output), "TYPELESS_VERSION_UNSUPPORTED");
        Equal(TypelessVoice.ReadSettings(settings.Replace("virtual", "default"), out output), 0xA5, 0xA3);
        Check(output == null, "Default microphone should use a temporary application route");
        Reject(() => TypelessVoice.ReadSettings(settings.Replace("RightAlt+RightCtrl", "RightAlt"), out output), "TYPELESS_SHORTCUT_REQUIRED");
        Reject(() => TypelessVoice.ReadSettings(settings.Replace("\"askAnythingMode\":[\"RightAlt\"]", "\"askAnythingMode\":[\"RightAlt\",\"RightCtrl+RightAlt\"]"), out output), "TYPELESS_SHORTCUT_REQUIRED");
        var access = new TypelessAccess();
        using (var voice = new TypelessVoice(access, () => { })) {
            voice.CheckAvailable(); voice.SelectMicrophone();
            Check(access.Starts == 0, "Preparation started recording");
            voice.Start(() => true); Check(voice.IsRecording && voice.OutputDevice == 3, "Recording never confirmed");
            voice.End(true); voice.End(true);
            Check(access.Starts == 1 && access.Stops == 1 && access.Cancels == 0, "Duplicate finish");
        }
        access = new TypelessAccess();
        using (var voice = new TypelessVoice(access, () => { })) {
            Reject(() => voice.Start(() => false), "VOICE_FOCUS_REQUIRED");
            Check(access.Starts == 0, "Started without target focus");
            int checks = 0;
            Reject(() => voice.Start(() => ++checks == 1), "VOICE_FOCUS_REQUIRED");
            Check(access.Cancels == 1 && access.Stops == 0, "Focus change committed speech");
        }
        foreach (var state in new[] { TypelessVoiceState.Busy, TypelessVoiceState.Recording, TypelessVoiceState.Unavailable }) {
            access = new TypelessAccess { Current = state };
            using (var voice = new TypelessVoice(access, () => { }))
                Reject(() => voice.Start(() => true), state == TypelessVoiceState.Unavailable ? "TYPELESS_VERSION_UNSUPPORTED" : "VOICE_BUSY");
            Check(access.Starts == 0 && access.Stops == 0 && access.Cancels == 0, "Touched independent dictation");
        }
        access = new TypelessAccess { StartRecording = false };
        using (var voice = new TypelessVoice(access, () => { }))
            Reject(() => voice.Start(() => true), "VOICE_INPUT_FAILED");
        Check(access.Starts == 1 && access.Stops == 0, "Unconfirmed start was retried or committed");
        access = new TypelessAccess { StartRecording = false };
        int polls = 0, focusChecks = 0;
        using (var voice = new TypelessVoice(access, () => { if (++polls == 2) access.Current = TypelessVoiceState.Recording; }))
            Reject(() => voice.Start(() => ++focusChecks == 1), "VOICE_FOCUS_REQUIRED");
        Check(access.Cancels == 1 && access.Stops == 0, "Late startup was not cancelled after focus loss");
        access = new TypelessAccess { FailFinish = true };
        using (var voice = new TypelessVoice(access, () => { })) {
            voice.Start(() => true);
            try { voice.End(true); throw new Exception("Unknown finish reported success"); } catch (IOException) { }
        }
        Check(access.Stops == 1 && access.Cancels == 0, "Replayed unknown finish");
        access = new TypelessAccess { WrongInput = true };
        using (var voice = new TypelessVoice(access, () => { }))
            Reject(() => voice.Start(() => true), "VOICE_AUDIO_DEVICE_FAILED");
        Check(access.Cancels == 1 && access.Stops == 0, "Wrong physical input was not cancelled");
        access = new TypelessAccess();
        using (var voice = new TypelessVoice(access, () => { })) {
            voice.Start(() => true); access.WrongInput = true;
            Check(!voice.IsRecording, "Mid-recording input change was not detected");
        }
        Check(access.Cancels == 1 && access.Stops == 0, "Input change committed speech");
        Console.WriteLine("Typeless: settings, virtual microphone routing, shortcuts, ownership, cancellation and no-replay checks passed.");
    }
    public class Microphones { public object[] Devices { get; set; } }
    public class CompatibleSettings {
        public void ApplyPatch(System.Collections.Generic.IDictionary<string, object> patch) { throw new Exception("Probe must not invoke mutations"); }
        public Microphones GetMicrophoneList() { throw new Exception("Contract check must not invoke RPC"); }
    }
    public class MissingPatch { public Microphones GetMicrophoneList() { return null; } }
    public class WrongPatch {
        public void ApplyPatch(string patch) { }
        public Microphones GetMicrophoneList() { return null; }
    }
    public class WrongList {
        public void ApplyPatch(System.Collections.Generic.IDictionary<string, object> patch) { }
        public string GetMicrophoneList() { return null; }
    }
    public class StaticPatch {
        public static void ApplyPatch(System.Collections.Generic.IDictionary<string, object> patch) { }
        public Microphones GetMicrophoneList() { return null; }
    }
    static void TestMicrophoneRecovery() {
        string root = Path.Combine(Path.GetTempPath(), "ClipRelay-mic-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string path = Path.Combine(root, "lease.json"), device = Path.Combine(root, "device");
        try {
            string selected = "physical";
            using (var lease = new MicrophoneLease(path, () => selected, value => selected = value)) {
                lease.Select("virtual");
                Check(selected == "virtual" && File.Exists(path), "Switch missing durable recovery record");
                bool busy = false;
                try { using (var other = new MicrophoneLease(path, () => selected, value => selected = value)) {} }
                catch (InvalidOperationException e) { busy = e.Message == "VOICE_BUSY"; }
                Check(busy, "Concurrent worker took over microphone");
            }
            Check(selected == "physical" && !File.Exists(path), "Normal finish did not restore microphone");
            using (var lease = new MicrophoneLease(path, () => selected, value => selected = value)) {
                lease.Select("virtual"); selected = "user-chosen";
            }
            Check(selected == "user-chosen", "Manual microphone choice was overwritten");
            selected = "physical"; bool fail = false;
            using (var lease = new MicrophoneLease(path, () => selected, value => {
                if (fail) throw new IOException("RPC unavailable"); selected = value;
            })) { lease.Select("virtual"); fail = true; }
            Check(selected == "virtual" && File.Exists(path), "Failed restore lost its recovery record");
            using (var lease = new MicrophoneLease(path, () => selected, value => selected = value)) {}
            Check(selected == "physical" && !File.Exists(path), "Retry did not recover microphone");
            using (var lease = new MicrophoneLease(path, () => selected, value => {})) {
                bool failed = false;
                try { lease.Select("virtual"); }
                catch (InvalidOperationException e) { failed = e.Message == "VOICE_AUDIO_DEVICE_FAILED"; }
                Check(failed && selected == "physical", "Unapplied RPC patch was reported successful");
            }
            File.WriteAllText(device, "physical");
            using (var child = Process.Start(new ProcessStartInfo {
                FileName = typeof(VoiceInputTest).Assembly.Location,
                Arguments = "--microphone-crash \"" + root + "\"", UseShellExecute = false, CreateNoWindow = true
            })) { Check(child.WaitForExit(5000) && child.ExitCode == 0, "Crash fixture failed"); }
            Check(File.ReadAllText(device) == "virtual", "Crash fixture did not switch microphone");
            using (var lease = new MicrophoneLease(path, () => File.ReadAllText(device), value => File.WriteAllText(device, value))) {}
            Check(File.ReadAllText(device) == "physical" && !File.Exists(path), "Crashed worker was not recovered");
            Console.WriteLine("Microphone restore: finish, manual choice, exclusive ownership, RPC failure/retry, verification and process exit passed.");
        } finally { Directory.Delete(root, true); }
    }
    static double Energy(byte[] data,int frequency,uint rate) {
        double re=0,im=0;
        for(int i=0;i+1<data.Length;i+=2){short sample=(short)(data[i]|data[i+1]<<8);double phase=(i/2)*2*Math.PI*frequency/rate;re+=sample*Math.Cos(phase);im+=sample*Math.Sin(phase);}
        return Math.Sqrt(re*re+im*im);
    }
}
