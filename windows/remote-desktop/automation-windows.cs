using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

namespace ClipRelay.Remote {
    public sealed class AutomationWindows : IDisposable {
        sealed class Target { public IntPtr Handle;public int Pid;public long Started; }
        sealed class Element { public AutomationElement Value;public string Fingerprint; }
        readonly Dictionary<string,Target> targets=new Dictionary<string,Target>();
        readonly Dictionary<string,Element> elements=new Dictionary<string,Element>();
        Target selected;
        string version="";
        long observed;
        bool imageReady;
        Rect imageBounds;
        public Func<bool> Allowed=()=>true;
        void CheckControl(){AutomationJson.Require(Allowed(),"AUTOMATION_USER_STOPPED");AutomationJson.Require(InputFocus.IsInteractiveDesktop(),"AUTOMATION_DESKTOP_LOCKED");}
        readonly Stopwatch clock=Stopwatch.StartNew();
        public bool HasObservation {get{return selected!=null && clock.ElapsedMilliseconds-observed<30000;}}
        delegate bool EnumProc(IntPtr handle,IntPtr data);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr data);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr handle);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle,out uint pid);
        [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle,StringBuilder text,int count);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle,out Rect rect);
        [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr handle,IntPtr dc,uint flags);
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr handle,uint flag);
        [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,Input[] inputs,int size);
        [StructLayout(LayoutKind.Sequential)] struct Rect {public int Left,Top,Right,Bottom;}
        [StructLayout(LayoutKind.Sequential)] struct Input {public uint Type;public InputUnion Data;}
        [StructLayout(LayoutKind.Explicit)] struct InputUnion {[FieldOffset(0)]public Mouse Mouse;[FieldOffset(0)]public Key Key;}
        [StructLayout(LayoutKind.Sequential)] struct Mouse {public int X,Y;public uint Data,Flags,Time;public UIntPtr Extra;}
        [StructLayout(LayoutKind.Sequential)] struct Key {public ushort Vk,Scan;public uint Flags,Time;public UIntPtr Extra;}
        static readonly AutomationPattern[] Patterns={InvokePattern.Pattern,ValuePattern.Pattern,TogglePattern.Pattern,SelectionItemPattern.Pattern,ExpandCollapsePattern.Pattern,ScrollPattern.Pattern,TextPattern.Pattern};
        static readonly string[] PatternNames={"invoke","set_value","toggle","select","expand","scroll","text"};
        static string Limit(string value,int max){return value==null?"":value.Length<=max?value:value.Substring(0,max);}
        static bool Valid(Target target){try{uint pid;return target!=null && IsWindow(target.Handle) && GetWindowThreadProcessId(target.Handle,out pid)!=0 && pid==target.Pid && Process.GetProcessById((int)pid).StartTime.ToUniversalTime().Ticks==target.Started;}catch{return false;}}
        static string Fingerprint(AutomationElement value){var s=value.Current;return String.Join(",",value.GetRuntimeId())+"|"+s.ProcessId+"|"+s.ControlType.Id+"|"+s.Name+"|"+s.BoundingRectangle.ToString(System.Globalization.CultureInfo.InvariantCulture)+"|"+s.IsEnabled+"|"+s.IsOffscreen+"|"+s.IsPassword;}
        object Windows(){
            targets.Clear();var list=new List<object>();
            EnumWindows((handle,unused)=>{
                if(list.Count>=256)return false;
                try{
                    if(!IsWindowVisible(handle))return true;var title=new StringBuilder(512);GetWindowText(handle,title,title.Capacity);if(title.Length==0)return true;
                    uint pid;GetWindowThreadProcessId(handle,out pid);
                    using(var process=Process.GetProcessById((int)pid)){
                        if(process.SessionId!=Process.GetCurrentProcess().SessionId)return true;
                        string id=Guid.NewGuid().ToString("N");targets[id]=new Target{Handle=handle,Pid=(int)pid,Started=process.StartTime.ToUniversalTime().Ticks};
                        list.Add(new {id,title=title.ToString(),process=process.ProcessName,pid});
                    }
                }catch{}return true;
            },IntPtr.Zero);return new {windows=list};
        }
        object Observe(Dictionary<string,object> p,bool screenshot){
            AutomationJson.Fields(p,"windowId,screenshot");string id=AutomationJson.Text(p,"windowId");Target target;
            AutomationJson.Require(targets.TryGetValue(id,out target) && Valid(target),"AUTOMATION_WINDOW_CHANGED");
            selected=null;elements.Clear();version=Guid.NewGuid().ToString("N");imageReady=false;
            var root=AutomationElement.FromHandle(target.Handle);var nodes=new List<object>();var queue=new Queue<Tuple<AutomationElement,int,int>>();queue.Enqueue(Tuple.Create(root,0,-1));
            var watch=Stopwatch.StartNew();int textBudget=32768;
            while(queue.Count>0 && nodes.Count<512 && watch.ElapsedMilliseconds<4000){
                var item=queue.Dequeue();var element=item.Item1;var s=element.Current;
                if(s.ProcessId!=target.Pid)continue;
                string reference="e"+nodes.Count;int index=nodes.Count;var supported=new List<string>();
                object pattern;for(int i=0;i<Patterns.Length;i++)if(element.TryGetCurrentPattern(Patterns[i],out pattern))supported.Add(PatternNames[i]);
                string text="";if(!s.IsPassword && textBudget>0){
                    if(element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))text=Limit(((ValuePattern)pattern).Current.Value,Math.Min(4096,textBudget));
                    else if(s.ControlType==ControlType.Document && element.TryGetCurrentPattern(TextPattern.Pattern,out pattern))text=((TextPattern)pattern).DocumentRange.GetText(Math.Min(4096,textBudget));
                    textBudget-=text.Length;
                }
                var bounds=s.BoundingRectangle;
                nodes.Add(new {reference,parent=item.Item3,role=s.ControlType.ProgrammaticName.Replace("ControlType.",""),name=s.IsPassword?"":Limit(s.Name,512),automationId=Limit(s.AutomationId,256),enabled=s.IsEnabled,offscreen=s.IsOffscreen,password=s.IsPassword,focused=s.HasKeyboardFocus,text,actions=supported,bounds=bounds.IsEmpty?null:new[]{bounds.X,bounds.Y,bounds.Width,bounds.Height}});
                elements[reference]=new Element{Value=element,Fingerprint=Fingerprint(element)};
                if(item.Item2<20 && !s.IsPassword){
                    var child=TreeWalker.ControlViewWalker.GetFirstChild(element);int count=0;
                    while(child!=null && count++<256 && queue.Count<1024){queue.Enqueue(Tuple.Create(child,item.Item2+1,index));child=TreeWalker.ControlViewWalker.GetNextSibling(child);}
                }
            }
            object image=null;if(screenshot || AutomationJson.Flag(p,"screenshot")){image=Capture(target,out imageBounds);imageReady=true;}
            AutomationJson.Require(Valid(target),"AUTOMATION_WINDOW_CHANGED");selected=target;observed=clock.ElapsedMilliseconds;
            return new {windowId=id,version,elements=nodes,truncated=queue.Count>0,image};
        }
        static object Capture(Target target,out Rect r){
            AutomationJson.Require(GetWindowRect(target.Handle,out r),"AUTOMATION_WINDOW_CHANGED");int width=r.Right-r.Left,height=r.Bottom-r.Top;
            AutomationJson.Require(width>0 && height>0 && width<=8192 && height<=8192 && (long)width*height<=24000000,"AUTOMATION_SCREENSHOT_UNAVAILABLE");
            using(var bitmap=new Bitmap(width,height)){
                using(var graphics=Graphics.FromImage(bitmap)){IntPtr dc=graphics.GetHdc();try{AutomationJson.Require(PrintWindow(target.Handle,dc,2),"AUTOMATION_SCREENSHOT_UNAVAILABLE");}finally{graphics.ReleaseHdc(dc);}}
                double scale=Math.Min(1,1600.0/Math.Max(width,height));
                using(var output=new Bitmap(bitmap,new Size(Math.Max(1,(int)(width*scale)),Math.Max(1,(int)(height*scale)))))
                using(var bytes=new MemoryStream()){
                    output.Save(bytes,ImageFormat.Jpeg);AutomationJson.Require(bytes.Length<=2200000,"AUTOMATION_SCREENSHOT_TOO_LARGE");
                    return new {mimeType="image/jpeg",data=Convert.ToBase64String(bytes.ToArray()),width=output.Width,height=output.Height,windowWidth=width,windowHeight=height};
                }
            }
        }
        static void Send(Input[] inputs){AutomationJson.Require(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)))==inputs.Length,"AUTOMATION_INPUT_FAILED");}
        static Input Keyboard(ushort code,bool up,bool unicode){return new Input{Type=1,Data=new InputUnion{Key=new Key{Vk=unicode?(ushort)0:code,Scan=unicode?code:(ushort)0,Flags=(up?2u:0u)|(unicode?4u:0u)}}};}
        static ushort KeyCode(string key){
            var names=new Dictionary<string,ushort>(StringComparer.OrdinalIgnoreCase){{"CTRL",17},{"CONTROL",17},{"ALT",18},{"SHIFT",16},{"ENTER",13},{"TAB",9},{"ESC",27},{"ESCAPE",27},{"BACKSPACE",8},{"DELETE",46},{"LEFT",37},{"UP",38},{"RIGHT",39},{"DOWN",40},{"HOME",36},{"END",35},{"PAGEUP",33},{"PAGEDOWN",34},{"SPACE",32}};
            ushort code;if(names.TryGetValue(key,out code))return code;if(key.Length==1 && Char.IsLetterOrDigit(key[0]) && key[0]<128)return (ushort)Char.ToUpperInvariant(key[0]);
            int f;if(key.StartsWith("F",StringComparison.OrdinalIgnoreCase) && Int32.TryParse(key.Substring(1),out f) && f>=1 && f<=12)return (ushort)(111+f);throw new AutomationFault("AUTOMATION_KEY_UNSUPPORTED");
        }
        object Action(Dictionary<string,object> p){
            CheckControl();
            AutomationJson.Fields(p,"version,ref,kind,value,keys,horizontal,vertical,x,y,button");
            AutomationJson.Require(HasObservation && Valid(selected) && AutomationJson.Text(p,"version")==version,"AUTOMATION_OBSERVATION_STALE");
            string kind=AutomationJson.Text(p,"kind"),reference=AutomationJson.Text(p,"ref");Element element=null;
            if(reference!=""){
                AutomationJson.Require(elements.TryGetValue(reference,out element) && Fingerprint(element.Value)==element.Fingerprint,"AUTOMATION_ELEMENT_CHANGED");
                AutomationJson.Require(element.Value.Current.IsEnabled && !element.Value.Current.IsOffscreen,"AUTOMATION_ELEMENT_UNAVAILABLE");
            }
            version=""; // Consume BEFORE input. An unknown result cannot replay this observation.
            object pattern;
            if(kind=="invoke" && element!=null && element.Value.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))((InvokePattern)pattern).Invoke();
            else if(kind=="set_value" && element!=null && element.Value.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)){
                string value=AutomationJson.Text(p,"value");AutomationJson.Require(value.Length<=16384 && !((ValuePattern)pattern).Current.IsReadOnly);((ValuePattern)pattern).SetValue(value);
            }else if(kind=="toggle" && element!=null && element.Value.TryGetCurrentPattern(TogglePattern.Pattern,out pattern))((TogglePattern)pattern).Toggle();
            else if(kind=="select" && element!=null && element.Value.TryGetCurrentPattern(SelectionItemPattern.Pattern,out pattern))((SelectionItemPattern)pattern).Select();
            else if((kind=="expand" || kind=="collapse") && element!=null && element.Value.TryGetCurrentPattern(ExpandCollapsePattern.Pattern,out pattern)){if(kind=="expand")((ExpandCollapsePattern)pattern).Expand();else ((ExpandCollapsePattern)pattern).Collapse();}
            else if(kind=="scroll" && element!=null && element.Value.TryGetCurrentPattern(ScrollPattern.Pattern,out pattern)){
                int h=AutomationJson.Number(p,"horizontal",2),v=AutomationJson.Number(p,"vertical",2);AutomationJson.Require(h>=0 && h<=4 && v>=0 && v<=4);((ScrollPattern)pattern).Scroll((ScrollAmount)h,(ScrollAmount)v);
            }else if(kind=="focus" && element!=null)element.Value.SetFocus();
            else if(kind=="click" || kind=="type_text" || kind=="press_key"){
                AutomationJson.Require(SetForegroundWindow(selected.Handle) && GetForegroundWindow()==selected.Handle,"AUTOMATION_FOCUS_REQUIRED");
                if(kind=="click"){
                    Point point;
                    if(element!=null){var r=element.Value.Current.BoundingRectangle;point=new Point((int)(r.X+r.Width/2),(int)(r.Y+r.Height/2));}
                    else{AutomationJson.Require(imageReady,"AUTOMATION_SCREENSHOT_REQUIRED");Rect r;AutomationJson.Require(GetWindowRect(selected.Handle,out r));AutomationJson.Require(r.Left==imageBounds.Left && r.Top==imageBounds.Top && r.Right==imageBounds.Right && r.Bottom==imageBounds.Bottom,"AUTOMATION_WINDOW_CHANGED");int x=AutomationJson.Number(p,"x",-1),y=AutomationJson.Number(p,"y",-1);AutomationJson.Require(x>=0 && y>=0 && x<r.Right-r.Left && y<r.Bottom-r.Top);point=new Point(r.Left+x,r.Top+y);}
                    AutomationJson.Require(GetAncestor(WindowFromPoint(point),2)==selected.Handle,"AUTOMATION_WINDOW_OCCLUDED");
                    string button=AutomationJson.Text(p,"button","left");AutomationJson.Require(button=="left" || button=="right");AutomationJson.Require(SetCursorPos(point.X,point.Y),"AUTOMATION_INPUT_FAILED");
                    uint down=button=="left"?2u:8u,up=button=="left"?4u:16u;
                    try{CheckControl();Send(new[]{new Input{Data=new InputUnion{Mouse=new Mouse{Flags=down}}}});}finally{Send(new[]{new Input{Data=new InputUnion{Mouse=new Mouse{Flags=up}}}});}
                }else{
                    var focused=AutomationElement.FocusedElement;AutomationJson.Require(focused!=null && focused.Current.ProcessId==selected.Pid,"AUTOMATION_FOCUS_REQUIRED");
                    if(element!=null)AutomationJson.Require(Automation.Compare(focused,element.Value),"AUTOMATION_FOCUS_REQUIRED");
                    if(kind=="type_text"){
                        string value=AutomationJson.Text(p,"value");AutomationJson.Require(value.Length>0 && value.Length<=16384 && value.All(c=>!Char.IsControl(c)),"AUTOMATION_BAD_REQUEST");
                        foreach(char c in value){CheckControl();AutomationJson.Require(GetForegroundWindow()==selected.Handle,"AUTOMATION_FOCUS_CHANGED");try{Send(new[]{Keyboard(c,false,true)});}finally{Send(new[]{Keyboard(c,true,true)});}}
                    }else{
                        object raw;AutomationJson.Require(p.TryGetValue("keys",out raw) && raw is object[]);var keys=(object[])raw;AutomationJson.Require(keys.Length>0 && keys.Length<=5 && keys.All(x=>x is string));var codes=keys.Cast<string>().Select(KeyCode).ToArray();
                        try{foreach(var code in codes){CheckControl();AutomationJson.Require(GetForegroundWindow()==selected.Handle,"AUTOMATION_FOCUS_CHANGED");Send(new[]{Keyboard(code,false,false)});}}finally{foreach(var code in codes.Reverse())Send(new[]{Keyboard(code,true,false)});}
                    }
                }
            }else throw new AutomationFault("AUTOMATION_ACTION_UNSUPPORTED");
            return new {executed=true,requiresObservation=true};
        }
        public object Handle(string op,Dictionary<string,object> p){
            IntPtr previous=IntPtr.Zero;try{
                try{previous=SetThreadDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){}
                if(op=="windows"){AutomationJson.Fields(p,"");return Windows();}
                if(op=="window.observe" || op=="window.screenshot")return Observe(p,op=="window.screenshot");
                if(op=="window.action")return Action(p);
                throw new AutomationFault("AUTOMATION_BAD_REQUEST");
            }finally{if(previous!=IntPtr.Zero)SetThreadDpiAwarenessContext(previous);}
        }
        public void Dispose(){selected=null;elements.Clear();targets.Clear();version="";}
    }
}
