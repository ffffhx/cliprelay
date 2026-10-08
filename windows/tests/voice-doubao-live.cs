// Optional local acceptance test. Temporarily configures Doubao through its installed
// settings client, dictates synthetic Chinese into ONLY this test form, then restores settings.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Speech.AudioFormat;
using System.Speech.Synthesis;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using ClipRelay.Remote;

public static class DoubaoVoiceLiveTest {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static int result=1;
    static void CheckReply(object response) {
        var reply=Json.Deserialize<Dictionary<string,object>>(Json.Serialize(response));
        if(!Convert.ToBoolean(reply["ok"])) throw new Exception(Convert.ToString(reply["code"]));
    }
    [STAThread] public static int Main(string[] args) {
        if(args.Length<1 || args.Length>3) return 2;
        using(var identity=WindowsIdentity.GetCurrent()) if(new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
            try { return LaunchAsShell(args); } catch(Exception error) {Console.WriteLine("Launch failed: "+error.Message);return 1;}
        if(args.Length==3) Console.SetOut(new StreamWriter(args[2],false,new System.Text.UTF8Encoding(false)){AutoFlush=true});
        Console.WriteLine("Test started "+DateTime.Now.ToString("o"));
        string config=Path.Combine(VoiceInput.UserAppData(),"DoubaoIme","conf","config.json");
        var before=(Dictionary<string,object>)Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(config))["voice"];
        string micBefore=Convert.ToString(before["selectedMicrophoneId"]);
        try {
            using(var provider=new DoubaoVoice())provider.CheckAvailable();
            byte[] pcm;
            using(var synth=new SpeechSynthesizer()) using(var audio=new MemoryStream()) {
                synth.SelectVoice("Microsoft Huihui Desktop");
                synth.SetOutputToAudioStream(audio,new SpeechAudioFormatInfo(16000,AudioBitsPerSample.Sixteen,AudioChannel.Mono));
                synth.Speak("这是手机语音输入测试，今天的天气很好。");
                pcm=audio.ToArray();
            }
            Application.EnableVisualStyles();
            using(var form=new Form()) using(var host=new System.Windows.Forms.Integration.ElementHost()) {
                var edit=args[0]=="--custom-editor" ? new CustomEditor() : new System.Windows.Controls.TextBox();host.Child=edit;host.Dock=DockStyle.Fill;
                form.Text="ClipRelay · 豆包语音链路验证";form.Width=640;form.Height=200;
                edit.AcceptsReturn=true;edit.FontSize=20;
                System.Windows.Input.InputMethod.SetIsInputMethodEnabled(edit,true);
                edit.KeyDown+=(sender,e)=>Console.WriteLine("Key down: "+e.Key);
                form.Controls.Add(host);
                form.Shown+=(sender,e)=>{
                    uint fgPid;uint fgThread=GetWindowThreadProcessId(GetForegroundWindow(),out fgPid);
                    uint thread=GetCurrentThreadId();
                    if(fgThread!=thread)AttachThreadInput(thread,fgThread,true);
                    try {SetForegroundWindow(form.Handle);form.Activate();edit.Focus();System.Windows.Input.Keyboard.Focus(edit);}
                    finally {if(fgThread!=thread)AttachThreadInput(thread,fgThread,false);}

                    var manager=(ThreadManager)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("529A9E6B-6587-4F23-AB9E-9C7D683E3C50")));
                    int tid;Console.WriteLine("Thread activate: "+manager.Activate(out tid));
                    var profiles=(ProfileManager)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("33C53A50-F456-4884-B049-85FD643ECFED")));
                    Guid ime=new Guid("9D2B2E2B-3C93-4D2F-9D35-6EEB85F0D2B0"), profile=new Guid("2B4D4B3A-4D4F-4C0A-8E66-7F771A2B9C10");
                    Console.WriteLine("Activate test IME: "+profiles.ActivateProfile(1,0x0804,ref ime,ref profile,IntPtr.Zero,0));
                    Marshal.ReleaseComObject(profiles);
                    new Thread(()=>{
                        try {
                            Thread.Sleep(800);
                            uint focusedPid;GetWindowThreadProcessId(GetForegroundWindow(),out focusedPid);
                            if(focusedPid!=Process.GetCurrentProcess().Id || System.Windows.Automation.AutomationElement.FocusedElement.Current.ProcessId!=Process.GetCurrentProcess().Id)throw new Exception("Owned test field did not get focus; no dictation started.");
                            if(args[0]=="--custom-editor") {
                                if(InputFocus.IsEditable(System.Windows.Automation.AutomationElement.FocusedElement))throw new Exception("Custom editor unexpectedly exposes UIA editability");
                                Console.WriteLine("Custom editor accepts typing without UIA editability patterns.");
                            }
                            CheckReply(VoiceInput.Handle("voice-start"));
                            Thread.Sleep(300);
                            if(args.Length>=2) {
                                var bounds=Screen.PrimaryScreen.Bounds;
                                using(var screenshot=new System.Drawing.Bitmap(bounds.Width,bounds.Height)) using(var graphics=System.Drawing.Graphics.FromImage(screenshot)) {
                                    graphics.CopyFromScreen(bounds.Location,System.Drawing.Point.Empty,bounds.Size);
                                    screenshot.Save(args[1],System.Drawing.Imaging.ImageFormat.Png);
                                }
                            }
                            for(int offset=0;offset<pcm.Length;offset+=6400){
                                byte[] chunk=new byte[Math.Min(6400,pcm.Length-offset)];Array.Copy(pcm,offset,chunk,0,chunk.Length);
                                CheckReply(VoiceInput.Handle("voice-audio:"+Convert.ToBase64String(chunk)));
                                Thread.Sleep(chunk.Length*1000/32000);
                            }
                            CheckReply(VoiceInput.Handle("voice-stop"));
                            Thread.Sleep(4000);
                            form.Invoke((Action)(()=>{
                                Console.WriteLine("Recognized test text: "+edit.Text);
                                if(edit.Text.Contains("语音") && edit.Text.Contains("天气")) result=0;
                                else Console.WriteLine("FAIL: Expected synthetic test sentence was not entered.");
                            }));
                            if(result==0) {
                                CheckReply(VoiceInput.Handle("voice-start"));
                                Thread.Sleep(7200);
                                var ended=Json.Deserialize<Dictionary<string,object>>(Json.Serialize(VoiceInput.Handle("voice-audio:AAA=")));
                                if(Convert.ToBoolean(ended["ok"]))throw new Exception("Idle watchdog left recording active");
                                Console.WriteLine("Idle watchdog cancelled recording.");
                            }
                        } catch(Exception error){result=1;Console.WriteLine("FAIL: "+error.GetBaseException().Message);}
                        finally{VoiceInput.Close();if(!form.IsDisposed)form.BeginInvoke((Action)form.Close);}
                    }){IsBackground=true}.Start();
                };
                Application.Run(form);
            }
        } catch(Exception error){result=1;Console.WriteLine("FAIL: "+error.GetBaseException().Message);}
        finally {
            VoiceInput.Close();
            var after=(Dictionary<string,object>)Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(config))["voice"];
            if(Convert.ToString(after["selectedMicrophoneId"])!=micBefore) {Console.WriteLine("FAIL: microphone selection was not restored.");result=1;}
            else Console.WriteLine("Microphone selection restored.");
            if(args.Length==3)Console.Out.Dispose();
        }
        return result;
    }
    // Reproduces an IME-capable editor whose accessibility provider does not
    // advertise editability. Never uses a real conversation or user document.
    sealed class CustomEditor : System.Windows.Controls.TextBox {
        protected override System.Windows.Automation.Peers.AutomationPeer OnCreateAutomationPeer() { return new CustomEditorPeer(this); }
    }
    sealed class CustomEditorPeer : System.Windows.Automation.Peers.TextBoxAutomationPeer {
        public CustomEditorPeer(CustomEditor owner) : base(owner) { }
        public override object GetPattern(System.Windows.Automation.Peers.PatternInterface pattern) {
            if(pattern==System.Windows.Automation.Peers.PatternInterface.Value || pattern==System.Windows.Automation.Peers.PatternInterface.Text) return null;
            return base.GetPattern(pattern);
        }
    }
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {
        public int cb;public string reserved,desktop,title;public int x,y,width,height,xc,yc,fill,flags;
        public short show,reserved2;public IntPtr reservedPtr,stdin,stdout,stderr;
    }
    [ComImport,Guid("AA80E801-2021-11D2-93E0-0060B067B86E"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ThreadManager { [PreserveSig]int Activate(out int id); }
    [ComImport,Guid("71C6E74C-0F28-11D8-A82A-00065B84435C"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ProfileManager {
        [PreserveSig]int ActivateProfile(uint type,ushort language,ref Guid clsid,ref Guid profile,IntPtr hkl,uint flags);
    }
    [StructLayout(LayoutKind.Sequential)] struct Info {public IntPtr process,thread;public int pid,tid;}
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern IntPtr FindWindow(string cls,string name);
    [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]static extern bool AttachThreadInput(uint a,uint b,bool attach);
    [DllImport("user32.dll")]static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("advapi32.dll",SetLastError=true)]static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",SetLastError=true)]static extern bool DuplicateTokenEx(IntPtr token,uint access,IntPtr attributes,int level,int type,out IntPtr duplicate);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcessWithTokenW(IntPtr token,uint logon,string app,StringBuilder command,uint flags,IntPtr env,string cwd,ref Startup startup,out Info info);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
    static int LaunchAsShell(string[] args) {
        uint pid;GetWindowThreadProcessId(GetShellWindow(),out pid);
        IntPtr original=IntPtr.Zero,token=IntPtr.Zero;Info info=new Info();
        try {
            using(var shell=Process.GetProcessById((int)pid))if(!OpenProcessToken(shell.Handle,0x000A,out original))throw new System.ComponentModel.Win32Exception();
            if(!DuplicateTokenEx(original,0xF01FF,IntPtr.Zero,2,1,out token))throw new System.ComponentModel.Win32Exception();
            string exe=typeof(DoubaoVoiceLiveTest).Assembly.Location;
            var command=new StringBuilder("\""+exe+"\"");foreach(string arg in args)command.Append(" \"").Append(arg.Replace("\"","" )).Append("\"");
            var startup=new Startup{cb=Marshal.SizeOf(typeof(Startup)),desktop="winsta0\\default"};
            if(!CreateProcessWithTokenW(token,0,exe,command,0x08000000,IntPtr.Zero,Environment.CurrentDirectory,ref startup,out info))throw new System.ComponentModel.Win32Exception();
            using(var child=Process.GetProcessById(info.pid)){if(!child.WaitForExit(45000))return 3;}
            uint exitCode;return GetExitCodeProcess(info.process,out exitCode)?(int)exitCode:3;
        } finally {if(info.thread!=IntPtr.Zero)CloseHandle(info.thread);if(info.process!=IntPtr.Zero)CloseHandle(info.process);if(token!=IntPtr.Zero)CloseHandle(token);if(original!=IntPtr.Zero)CloseHandle(original);}
    }
    [DllImport("kernel32.dll")]static extern bool GetExitCodeProcess(IntPtr process,out uint code);
}
