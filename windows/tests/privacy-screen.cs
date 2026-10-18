using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using ClipRelay.Remote;

public static class PrivacyScreenTests {
    sealed class Screen : IPrivacyScreen {
        public bool supported=true, available=true, shown, broken;
        public bool Supported { get { return supported; } }
        public bool Available { get { return available; } }
        public void Show() { shown=true; if(broken) throw new Exception(); }
        public void Hide() { shown=false; }
        public void Check() { if(broken) throw new Exception(); }
        public void Dispose() { Hide(); }
    }
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    static readonly string A=new string('a',32), B=new string('b',32);
    static Dictionary<string,object> Call(PrivacyScreenLease lease,string op,string id) {
        var q=new Dictionary<string,object>{{"op",op}}; if(id!=null)q["lease"]=id;
        return Json.Deserialize<Dictionary<string,object>>(Json.Serialize(lease.Handle(q)));
    }
    static void Assert(bool good,string message) { if(!good)throw new Exception(message); }
    static bool OK(Dictionary<string,object> value) { return (bool)value["ok"]; }
    [STAThread] public static int Main(string[] args) {
        if(args.Length==1 && args[0]=="--privacy-probe")return PrivacyScreenWorker.Run();
        if(args.Length==1 && args[0]=="--capture-fixture")return Fixture();
        try {
            int tests=0;long clock=0;
            var screen=new Screen();
            using(var lease=new PrivacyScreenLease(screen,()=>clock)) {
                Assert(OK(Call(lease,"status",null)) && !screen.shown,"status has no effect");
                Assert(OK(Call(lease,"start",A)) && screen.shown,"start");
                clock=14999;lease.Tick();Assert(screen.shown,"premature expiry");
                clock=15000;lease.Tick();Assert(!screen.shown && !OK(Call(lease,"renew",A)),"expiry or automatic reacquire");tests++;
                Assert(OK(Call(lease,"start",A)),"new start");clock=18000;
                Assert(OK(Call(lease,"renew",A)),"renew");clock=30001;lease.Tick();Assert(screen.shown,"renewal ignored");
                clock=33000;lease.Tick();Assert(!screen.shown,"renewed deadline");tests++;
                Call(lease,"start",A);Assert(!OK(Call(lease,"start",B)) && !OK(Call(lease,"stop",B)) && screen.shown,"foreign lease");
                Assert(OK(Call(lease,"stop",A)) && !screen.shown,"stop");tests++;
                Call(lease,"start",A);lease.Restore();Assert(!screen.shown && !OK(Call(lease,"renew",A)),"escape undone by heartbeat");tests++;
                Call(lease,"start",A);screen.available=false;lease.Tick();Assert(!screen.shown && !OK(Call(lease,"start",A)),"locked desktop");
                screen.available=true;screen.supported=false;Assert(!OK(Call(lease,"start",A)),"unsupported OS");screen.supported=true;tests++;
                screen.broken=true;Assert(!OK(Call(lease,"start",A)) && !screen.shown,"partial show rollback");screen.broken=false;
                Call(lease,"start",A);screen.broken=true;lease.Tick();Assert(!screen.shown,"hotplug/affinity failure");screen.broken=false;tests++;
                Assert(!OK(Call(lease,"start","wrong")) && !OK(Call(lease,"unknown",A)),"invalid commands");
                var bad=new Dictionary<string,object>{{"op","start"},{"lease",A},{"owner","spoof"}};
                Assert(!(bool)Json.Deserialize<Dictionary<string,object>>(Json.Serialize(lease.Handle(bad)))["ok"],"unknown fields");tests++;
                Call(lease,"start",A);
            }
            Assert(!screen.shown,"Dispose leaves screen masked");tests++;
            Console.WriteLine("PASS privacy-screen: "+tests+" lifecycle and recovery scenarios (fake display; no real screen changes)");return 0;
        } catch(Exception e) { Console.Error.WriteLine(e);return 1; }
    }
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr window,uint affinity);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window,IntPtr dc);
    [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc,int x,int y);
    sealed class Marker : Form {
        bool flip;
        public Marker(Rectangle bounds) { FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;StartPosition=FormStartPosition.Manual;Bounds=bounds;BackColor=Color.Red;TopMost=true; }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams { get { var p=base.CreateParams;p.ExStyle|=0x08000080;return p; } }
        protected override void OnPaint(PaintEventArgs e) { base.OnPaint(e);flip=!flip;e.Graphics.FillRectangle(flip ? Brushes.Blue : Brushes.Green,100,100,4,4); }
    }
    static int Fixture() {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        var area=System.Windows.Forms.Screen.PrimaryScreen.WorkingArea;
        var bounds=new Rectangle(area.Left+32,area.Top+32,320,160);
        using(var marker=new Marker(bounds))
        using(var mask=new DesktopPrivacyScreen.Mask(bounds))
        using(var frames=new System.Windows.Forms.Timer { Interval=100 })
        using(var timeout=new System.Windows.Forms.Timer { Interval=30000 }) {
            marker.Show();DesktopPrivacyScreen.Exclude(mask);
            // This fixture uses the production mask but covers only our own marker.
            // stdin EOF and a hard 30-second timer both close these two windows.
            timeout.Tick+=(s,e)=>Application.ExitThread();timeout.Start();
            frames.Tick+=(s,e)=>marker.Invalidate(new Rectangle(100,100,4,4));frames.Start();
            Console.WriteLine(Json.Serialize(new {pid=Process.GetCurrentProcess().Id,hwnd=marker.Handle.ToInt64(),mask=mask.Handle.ToInt64()}));Console.Out.Flush();
            var reader=new Thread(()=>{
                try {
                    string line;
                    while((line=Console.ReadLine())!=null) {
                        if(line=="quit")break;
                        string command=line;
                        uint pixel=0;
                        marker.Invoke(new Action(()=>{
                            if(command=="plain") {SetWindowDisplayAffinity(mask.Handle,0);mask.Show();mask.BringToFront();}
                            else if(command=="excluded") {DesktopPrivacyScreen.Exclude(mask);mask.Show();mask.BringToFront();}
                            else if(command=="hide")mask.Hide();
                            else throw new InvalidOperationException();
                            mask.Refresh();marker.Refresh();DwmFlush();
                            var dc=GetDC(marker.Handle);try{pixel=GetPixel(dc,20,20);}finally{ReleaseDC(marker.Handle,dc);}
                        }));
                        Console.Error.WriteLine("marker pixel "+pixel+" interactive "+InputFocus.IsInteractiveDesktop());
                        Console.WriteLine("ready");Console.Out.Flush();
                    }
                } catch { }
                finally {try{marker.BeginInvoke(new Action(Application.ExitThread));}catch{}}
            });reader.IsBackground=true;reader.Start();Application.Run();return 0;
        }
    }
}
