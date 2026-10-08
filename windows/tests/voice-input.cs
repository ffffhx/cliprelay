using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Diagnostics;
using System.Threading;
using ClipRelay.Remote;

// No microphone recording from a physical device. Optional loop test opens ONLY the Steam virtual cable.
public static class VoiceInputTest {
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
    public static int Main(string[] args) {
        if (args.Length == 2 && args[0] == "--microphone-crash") {
            string deviceFile = Path.Combine(args[1], "device");
            var lease = new MicrophoneLease(Path.Combine(args[1], "lease.json"),
                () => File.ReadAllText(deviceFile), value => File.WriteAllText(deviceFile, value));
            lease.Select("virtual");
            Environment.Exit(0); // Deliberately bypass Dispose, like a killed worker.
        }
        TestMicrophoneRecovery();
        Check(DoubaoVoice.SupportedVersion("0.9.1.22\r\n"),"Known provider version rejected");
        Check(!DoubaoVoice.SupportedVersion("0.9.2.0"),"Unknown provider version accepted");
        Console.WriteLine("Provider version gate passed.");
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
