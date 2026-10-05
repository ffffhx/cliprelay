[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$StatePath, [int]$DurationSeconds=20, [switch]$CompileOnly)
# A bounded, normal-sized touch target. Stops on focus loss; never moves the cursor.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Xaml,System.Web.Extensions
$source=@'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

public static class PhoneTouchTarget {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    public static void Run(string path, int seconds) {
        SetProcessDPIAware();
        var state = new Dictionary<string, object>();
        state["clicks"] = 0;
        state["touchDowns"] = 0;
        state["rightClicks"] = 0;
        state["scrollOffset"] = 0.0;
        state["closed"] = false;
        var window = new Window { Title="ClipRelay touch test - closes on focus loss", Width=700, Height=450,
            Left=40, Top=100, ResizeMode=ResizeMode.NoResize, WindowState=WindowState.Normal,
            Topmost=false, Background=new SolidColorBrush(Color.FromRgb(24,34,50)) };
        var grid = new Grid { Margin=new Thickness(16) };
        grid.RowDefinitions.Add(new RowDefinition { Height=new GridLength(60) });
        grid.RowDefinitions.Add(new RowDefinition { Height=new GridLength(1,GridUnitType.Star) });
        var click = new Button { Content="TAP / LONG PRESS HERE", FontSize=20, Margin=new Thickness(0,0,0,12) };
        var menu = new ContextMenu();
        menu.Items.Add(new MenuItem { Header="Touch menu verified" });
        click.ContextMenu = menu;
        grid.Children.Add(click);
        var content = new StackPanel();
        for(int i=0;i<24;i++) content.Children.Add(new TextBlock { Text="Swipe to scroll - row "+(i+1),
            FontSize=22, Height=60, Foreground=Brushes.White, Padding=new Thickness(20,12,0,0) });
        var scroll = new ScrollViewer { Content=content, PanningMode=PanningMode.VerticalOnly,
            VerticalScrollBarVisibility=ScrollBarVisibility.Visible, Background=new SolidColorBrush(Color.FromRgb(37,52,73)) };
        Grid.SetRow(scroll,1); grid.Children.Add(scroll); window.Content=grid;
        var serializer=new JavaScriptSerializer();
        Action save=()=> {
            try { File.WriteAllText(path,serializer.Serialize(state),new UTF8Encoding(false)); } catch(IOException) {}
        };
        click.Click+=(s,e)=> { state["clicks"]=(int)state["clicks"]+1; save(); };
        click.ContextMenuOpening+=(s,e)=> { state["rightClicks"]=(int)state["rightClicks"]+1; save(); };
        window.AddHandler(UIElement.PreviewTouchDownEvent,new EventHandler<TouchEventArgs>((s,e)=> {
            state["touchDowns"]=(int)state["touchDowns"]+1; save();
        }),true);
        scroll.ScrollChanged+=(s,e)=> { state["scrollOffset"]=scroll.VerticalOffset; save(); };
        Func<FrameworkElement,double[]> bounds=(element)=> {
            var p=element.PointToScreen(new Point(0,0));
            var q=element.PointToScreen(new Point(element.ActualWidth,element.ActualHeight));
            return new double[] {p.X,p.Y,q.X,q.Y};
        };
        var deadline=DateTime.UtcNow.AddSeconds(Math.Min(30,Math.Max(5,seconds)));
        var timer=new DispatcherTimer { Interval=TimeSpan.FromMilliseconds(100) };
        bool activated=false;
        window.ContentRendered+=(s,e)=> {
            state["buttonBounds"]=bounds(click); state["scrollBounds"]=bounds(scroll);
            state["deadlineUtc"]=deadline.ToString("o"); save();
            window.Activate(); timer.Start();
        };
        timer.Tick+=(s,e)=> {
            bool foreground=GetForegroundWindow()==new WindowInteropHelper(window).Handle;
            if(foreground) activated=true;
            state["foreground"]=foreground; save();
            if((activated && !foreground) || DateTime.UtcNow>=deadline) window.Close();
        };
        window.Closed+=(s,e)=> { timer.Stop(); state["foreground"]=false; state["closed"]=true; save(); };
        window.ShowDialog();
    }
}
'@
$references=@('System.dll','System.Core.dll','System.Web.Extensions.dll','System.Xaml.dll',
    [Windows.Window].Assembly.Location,[Windows.Media.Brushes].Assembly.Location,[Windows.Threading.Dispatcher].Assembly.Location)
Add-Type -TypeDefinition $source -ReferencedAssemblies $references
if (!$CompileOnly) { [PhoneTouchTarget]::Run([IO.Path]::GetFullPath($StatePath),$DurationSeconds) }
