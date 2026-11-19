// Opt-in acceptance: an owned foreground field and synthetic speech sent only
// through the virtual cable. Never records the physical microphone.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Speech.AudioFormat;
using System.Speech.Synthesis;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using ClipRelay.Remote;

public static class TypelessVoiceLiveTest {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static int result = 1;
    static Process installedWorker;
    static object Handle(string command) {
        if (installedWorker == null) return VoiceInput.Handle(command);
        installedWorker.StandardInput.WriteLine(command); installedWorker.StandardInput.Flush();
        var response = installedWorker.StandardOutput.ReadLineAsync();
        Check(response.Wait(15000) && response.Result != null, "Installed voice worker did not reply");
        return Json.DeserializeObject(response.Result);
    }
    static void CloseVoice() {
        if (installedWorker == null) { VoiceInput.Close(); return; }
        var worker = installedWorker; installedWorker = null;
        using (worker) {
            worker.StandardInput.Close();
            Check(worker.WaitForExit(10000) && worker.ExitCode == 0, "Installed voice worker did not exit normally");
        }
    }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint first, uint second, bool attach);
    static void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    static void Request(string command) {
        var reply = Json.Deserialize<Dictionary<string, object>>(Json.Serialize(Handle(command)));
        Check(Convert.ToBoolean(reply["ok"]), Convert.ToString(reply["code"]));
    }
    static void Ended() {
        var reply = Json.Deserialize<Dictionary<string, object>>(Json.Serialize(Handle("voice-audio:AAA=")));
        Check(!Convert.ToBoolean(reply["ok"]) && Convert.ToString(reply["code"]) == "VOICE_ENDED", "Session still accepts audio");
        bool ready = false;
        for (int i = 0; i < 50 && !ready; i++) {
            try { using (var voice = new TypelessVoice()) voice.CheckAvailable(); ready = true; }
            catch (InvalidOperationException e) {
                if (e.Message != "VOICE_BUSY" && e.Message != "TYPELESS_VERSION_UNSUPPORTED") throw;
                Thread.Sleep(200);
            }
        }
        Check(ready, "Typeless did not return to idle");
        Check(!TypelessAudioRoute.RecoveryPending, "Microphone recovery remains pending");
    }
    static void OwnFocus() {
        uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        Check(pid == Process.GetCurrentProcess().Id, "Owned test field lost focus; no further input sent");
    }
    [STAThread] public static int Main(string[] args) {
        if (args.Length < 1 || args.Length > 2) return 2;
        bool probe = args.Length == 2 && args[1] == "--probe";
        bool manual = args.Length == 2 && args[1] == "--manual";
        using (var output = new StreamWriter(args[0], false, new UTF8Encoding(false)) { AutoFlush = true }) {
            Console.SetOut(output);
            string settings = Path.Combine(VoiceInput.UserAppData(), "Typeless.exe", "app-settings.json");
            string before = File.ReadAllText(settings, Encoding.UTF8);
            Console.WriteLine("Started " + DateTimeOffset.Now.ToString("o"));
            try {
                if (args.Length == 2 && args[1] == "--installed") {
                    string executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "ClipRelay", "Remote", "ClipRelay.Remote.Service.exe");
                    installedWorker = Process.Start(new ProcessStartInfo(executable, "--voice-probe") {
                        UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true
                    });
                    Console.WriteLine("Installed worker PID: " + installedWorker.Id);
                    Request("voice-status:typeless");
                }
                using (var voice = new TypelessVoice()) voice.CheckAvailable();
                byte[] pcm;
                using (var synth = new SpeechSynthesizer()) using (var audio = new MemoryStream()) {
                    synth.SelectVoice("Microsoft Huihui Desktop");
                    synth.SetOutputToAudioStream(audio, new SpeechAudioFormatInfo(16000, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
                    synth.Speak("这是手机语音输入测试，今天的天气很好。");
                    pcm = audio.ToArray();
                }
                Console.WriteLine("Synthetic PCM bytes: " + pcm.Length);
                Application.EnableVisualStyles();
                using (var form = new Form { Text = "ClipRelay · 语音验收", Width = 720, Height = 220 })
                using (var edit = new TextBox { Multiline = true, Dock = DockStyle.Fill, Font = new System.Drawing.Font("Microsoft YaHei UI", 16) }) {
                    form.Controls.Add(edit);
                    form.Shown += (sender, evt) => {
                        uint previous; uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out previous);
                        uint ownThread = GetCurrentThreadId();
                        if (foregroundThread != ownThread) AttachThreadInput(ownThread, foregroundThread, true);
                        try { SetForegroundWindow(form.Handle); form.Activate(); edit.Focus(); }
                        finally { if (foregroundThread != ownThread) AttachThreadInput(ownThread, foregroundThread, false); }
                        var worker = new Thread(() => {
                            try {
                                Thread.Sleep(600); OwnFocus();
                                Request("voice-start:typeless");
                                Console.WriteLine("Recording confirmed.");
                                Thread.Sleep(300);
                                for (int offset = 0; offset < pcm.Length; offset += 6400) {
                                    OwnFocus();
                                    byte[] chunk = new byte[Math.Min(6400, pcm.Length - offset)];
                                    Array.Copy(pcm, offset, chunk, 0, chunk.Length);
                                    Request("voice-audio:" + Convert.ToBase64String(chunk));
                                    Thread.Sleep(chunk.Length * 1000 / 32000);
                                }
                                Thread.Sleep(1200);
                                if (probe) {
                                    Request("voice-cancel"); Thread.Sleep(500); Ended();
                                    Console.WriteLine("Audio probe complete; transcription was not validated.");
                                    result = 0; return;
                                }
                                if (!manual) { Request("voice-stop"); Console.WriteLine("Stop accepted."); }
                                else Console.WriteLine("Ready for observed stop.");
                                string recognized = "";
                                bool keepAlive = manual;
                                for (int poll = 0; poll < 100; poll++) {
                                    Thread.Sleep(200);
                                    if (keepAlive) {
                                        var reply = Json.Deserialize<Dictionary<string, object>>(Json.Serialize(Handle("voice-audio:AAA=")));
                                        keepAlive = Convert.ToBoolean(reply["ok"]);
                                    }
                                    recognized = (string)form.Invoke((Func<string>)(() => edit.Text));
                                    if (recognized.Contains("语音") && recognized.Contains("天气")) break;
                                }
                                Console.WriteLine("Recognized synthetic text: " + recognized);
                                Check(recognized.Contains("语音") && recognized.Contains("天气"), "Expected test sentence was not inserted");
                                if (manual) { Ended(); Console.WriteLine("Observed-stop diagnostic passed; native stop not validated."); result = 0; return; }
                                Ended(); OwnFocus(); Request("voice-start:typeless"); Request("voice-cancel");
                                Thread.Sleep(500); Ended();
                                Check((string)form.Invoke((Func<string>)(() => edit.Text)) == recognized, "Cancellation inserted unexpected text");
                                Console.WriteLine("Explicit cancellation passed.");
                                OwnFocus(); Request("voice-start:typeless"); Thread.Sleep(7200); Ended();
                                Console.WriteLine("Audio disconnect watchdog passed.");
                                result = 0;
                            } catch (Exception error) { Console.WriteLine("FAIL: " + error.Message); }
                            finally { try { CloseVoice(); } finally { if (!form.IsDisposed) form.BeginInvoke((Action)form.Close); } }
                        }) { IsBackground = true };
                        worker.SetApartmentState(ApartmentState.STA); worker.Start();
                    };
                    Application.Run(form);
                }
            } catch (Exception error) { Console.WriteLine("FAIL: " + error.Message); }
            finally {
                CloseVoice();
                // Typeless can update unrelated usage counters. Check microphone selection only.
                var first = Json.Deserialize<Dictionary<string, object>>(before);
                var after = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(settings, Encoding.UTF8));
                bool unchanged = Json.Serialize(first["selectedMicrophoneDevice"]) == Json.Serialize(after["selectedMicrophoneDevice"]);
                if (!unchanged || TypelessAudioRoute.RecoveryPending) { result = 1; Console.WriteLine("FAIL: Microphone not fully restored"); }
                else Console.WriteLine("Typeless microphone setting unchanged; application routing restored.");
                Console.WriteLine("Result: " + result);
            }
        }
        return result;
    }
}
