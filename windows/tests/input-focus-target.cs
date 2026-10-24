// Isolated UI Automation regression: does not send mouse/keyboard input.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using ClipRelay.Remote;

public static class InputFocusTargetTest {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static Dictionary<string, object> State(object value) {
        var json = new JavaScriptSerializer();
        return json.Deserialize<Dictionary<string, object>>(json.Serialize(value));
    }
    [STAThread] public static int Main(string[] args) {
        SetProcessDPIAware();
        System.Windows.Point point;
        Check(InputFocus.TryMapTap(.25, .75, 2560, 1440, out point) && point.X == 640 && point.Y == 1080, "Physical pixel mapping");
        Check(InputFocus.TryMapTap(1, 1, 1920, 1080, out point) && point.X == 1919 && point.Y == 1079, "Display edge mapping");
        foreach (double invalid in new[] { Double.NaN, Double.PositiveInfinity, Double.NegativeInfinity, -.1, 1.1 })
            Check(!InputFocus.TryMapTap(invalid, .5, 1920, 1080, out point), "Invalid coordinate accepted");
        Check(!InputFocus.TryMapTap(.5, .5, 0, 1080, out point), "Missing display accepted");
        Check(InputFocus.TryAbsolutePoint(-960, -100, -1920, -200, 3840, 1280, out point) && point.X == -960 && point.Y == -100,
            "Negative desktop coordinates were lost");
        Check(!InputFocus.TryAbsolutePoint(-1921, 0, -1920, -200, 3840, 1280, out point), "Outside desktop accepted");
        Check(!InputFocus.TryAbsolutePoint(1920, 0, -1920, -200, 3840, 1280, out point), "Exclusive desktop edge accepted");
        Check(!InputFocus.TryAbsolutePoint(0, 0, 0, 0, 0, 1080, out point), "Unavailable desktop accepted");
        if (args.Length == 1 && args[0] == "--geometry-only") {
            Console.WriteLine("PASS: physical pixel mapping, display edges and invalid coordinates");
            return 0;
        }
        Application.EnableVisualStyles();
        Exception failure = null;
        using (var form = new Form { Text = "ClipRelay input target regression", StartPosition = FormStartPosition.CenterScreen, ClientSize = new Size(600, 390) }) {
            var input = new TextBox { Bounds = new Rectangle(200, 30, 350, 40) };
            var session = new Label { Text = "Session switch", Bounds = new Rectangle(10, 30, 160, 60) };
            var readOnly = new TextBox { ReadOnly = true, Bounds = new Rectangle(200, 110, 350, 40) };
            var blank = new Panel { Bounds = new Rectangle(200, 180, 350, 40) };
            var files = new ListView { Bounds = new Rectangle(10, 250, 170, 120), LabelEdit = true, View = View.List };
            files.Items.Add("Renameable file");
            var slide = new SelectionObject { Bounds = new Rectangle(200, 250, 150, 40) };
            var rich = new RichTextBox { Bounds = new Rectangle(370, 250, 180, 100) };
            form.Controls.AddRange(new Control[] { input, session, readOnly, blank, files, slide, rich });
            bool lostFocus = false, finished = false;
            form.Deactivate += delegate { if (!finished) { lostFocus = true; form.Close(); } };
            Action<Action> ui = action => form.Invoke(action);
            form.Shown += delegate {
                SetForegroundWindow(form.Handle); input.Focus();
                ThreadPool.QueueUserWorkItem(delegate {
                    try {
                        Thread.Sleep(250);
                        Check(System.Windows.Automation.AutomationElement.FocusedElement.Current.ProcessId == System.Diagnostics.Process.GetCurrentProcess().Id,
                            "Test window could not acquire foreground focus");
                        Func<Control, Dictionary<string, object>> at = control => {
                            Point p = Point.Empty;
                            ui(() => p = control.PointToScreen(new Point(control.Width / 2, control.Height / 2)));
                            var screen = Screen.PrimaryScreen.Bounds;
                            var absolute = State(InputFocus.ReadAbsolute(p.X, p.Y));
                            if (screen.Contains(p)) {
                                var legacy = State(InputFocus.Read((double)p.X / screen.Width, (double)p.Y / screen.Height));
                                Check((bool)absolute["supported"] == (bool)legacy["supported"] &&
                                    (bool)absolute["editable"] == (bool)legacy["editable"], "Absolute/legacy primary probe disagree");
                            }
                            return absolute;
                        };
                        Action<Control, bool, string> expect = (control, editable, label) => {
                            var value = at(control);
                            Check((bool)value["targeted"] && (bool)value["supported"] && (bool)value["editable"] == editable,
                                label + ": " + new JavaScriptSerializer().Serialize(value));
                        };
                        Check((bool)State(InputFocus.Read())["editable"], "Test editor never focused");
                        expect(input, true, "Click in input should open keyboard");
                        expect(session, false, "Session sidebar plus sticky editor focus must not open keyboard");
                        expect(readOnly, false, "Read-only region plus sticky editor focus must not open keyboard");
                        expect(blank, false, "Blank area plus sticky editor focus must not open keyboard");
                        ui(() => { files.Focus(); files.Items[0].Selected = files.Items[0].Focused = true; });
                        Thread.Sleep(150);
                        var file = System.Windows.Automation.AutomationElement.FocusedElement;
                        Check(file.Current.ControlType == System.Windows.Automation.ControlType.ListItem, "File item fixture did not receive focus");
                        Check(!InputFocus.IsEditable(file), "Selecting a renameable file must not open keyboard");
                        ui(() => slide.Focus());
                        Thread.Sleep(150);
                        var selectedObject = System.Windows.Automation.AutomationElement.FocusedElement;
                        object writableValue;
                        Check(selectedObject.Current.ControlType != System.Windows.Automation.ControlType.Edit &&
                            selectedObject.TryGetCurrentPattern(System.Windows.Automation.ValuePattern.Pattern, out writableValue) &&
                            !((System.Windows.Automation.ValuePattern)writableValue).Current.IsReadOnly,
                            "Selection fixture must expose a writable value without being an editor: " + selectedObject.Current.ControlType.ProgrammaticName + " " + selectedObject.Current.ClassName);
                        expect(slide, false, "Selecting an object with a writable value must not open keyboard");
                        ui(() => rich.Focus());
                        Thread.Sleep(150);
                        expect(rich, true, "Rich text insertion must open keyboard");
                        ui(() => { rich.ReadOnly = true; });
                        expect(rich, false, "Readonly rich text must not open keyboard");
                        ui(() => { input.UseSystemPasswordChar = true; input.Focus(); });
                        Thread.Sleep(150);
                        expect(input, true, "Password input must open keyboard");
                        ui(() => { input.Dispose(); input = new TextBox { Bounds = new Rectangle(200, 30, 350, 40) }; form.Controls.Add(input); input.Focus(); });
                        Thread.Sleep(150);
                        expect(session, false, "New session autofocus must not open keyboard");
                        expect(input, true, "Explicit tap on newly focused input should open keyboard");
                        foreach (var display in Screen.AllScreens) {
                            ui(() => form.Location = new Point(display.WorkingArea.Left + 20, display.WorkingArea.Top + 20));
                            Thread.Sleep(150);
                            expect(input, true, "Absolute input on " + display.DeviceName);
                            expect(session, false, "Absolute sidebar on " + display.DeviceName);
                        }
                        // A non-focusable overlay leaves the editor focused but covers its pixels.
                        ui(() => { var cover = new Label { Bounds = input.Bounds, BackColor = Color.Gray }; form.Controls.Add(cover); cover.BringToFront(); });
                        expect(input, false, "Occluded input should not open keyboard");
                    } catch (Exception e) { failure = e; }
                    finally { finished = true; if (!form.IsDisposed) form.BeginInvoke(new Action(form.Close)); }
                });
            };
            Application.Run(form);
            if (lostFocus && failure == null) failure = new Exception("Test cancelled after losing foreground focus");
        }
        if (failure != null) { Console.Error.WriteLine(failure); return 1; }
        Console.WriteLine("PASS: absolute/legacy mapping, " + Screen.AllScreens.Length + " display(s), file/object selection, rich/password input, sticky focus, session autofocus, readonly and occluded input");
        return 0;
    }

    // MSAA/UIA exposes object labels as writable values too. Deliberately keep
    // that capability while reporting a selectable, non-text role.
    sealed class SelectionObject : Control {
        public SelectionObject() { SetStyle(ControlStyles.Selectable, true); TabStop = true; }
        protected override AccessibleObject CreateAccessibilityInstance() { return new SelectionAccessibility(this); }
        sealed class SelectionAccessibility : ControlAccessibleObject {
            public SelectionAccessibility(Control owner) : base(owner) {}
            public override AccessibleRole Role { get { return AccessibleRole.ListItem; } }
            public override string Value { get { return "Object label"; } set {} }
        }
    }
}
