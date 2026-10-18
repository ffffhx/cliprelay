using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class PairedRelayTests {
    static JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
    static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    static Dictionary<string, object> Result(string id, string state, int offset) {
        return new Dictionary<string, object> { { "ok", true }, { "id", id }, { "state", state }, { "offset", offset } };
    }
    static int Main(string[] args) {
        if (args.Length == 1 && args[0] == "--idle") { Console.ReadLine(); return 0; }
        if (args.Length == 1 && args[0] == "--publish") {
            var input = Json.Deserialize<Dictionary<string, object>>(Console.ReadLine());
            try {
                string state = ClipRelay.PairedRelayPublisher.Send((string)input["owner"], (string)input["kind"], Convert.FromBase64String((string)input["data"]), 5000,
                    (command, timeout) => { Console.WriteLine(Json.Serialize(command)); Console.Out.Flush(); return Json.Deserialize<Dictionary<string, object>>(Console.ReadLine()); });
                Console.WriteLine(Json.Serialize(new { final = state })); return 0;
            } catch (Exception e) { Console.WriteLine(Json.Serialize(new { final = "failed", error = e.Message })); return 1; }
        }
        try { SenderReceipts(); SenderFailures(); PipeIdentity(false); PipeIdentity(true); PipeTimeout(); Console.WriteLine("PASS: 5 paired relay sender/IPC scenarios"); return 0; }
        catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
    static void SenderReceipts() {
        byte[] body = Encoding.UTF8.GetBytes(new string('x', 18000));
        var uploaded = new MemoryStream(); bool dropped = false; int polls = 0, cancels = 0;
        string stableId = null;
        string state = ClipRelay.PairedRelayPublisher.Send(new string('a', 64), "json", body, 4000, (command, timeout) => {
            string id = (string)command["id"], op = (string)command["op"];
            if (stableId == null) stableId = id;
            Check(id == stableId, "ID changed during retry");
            if (op == "begin") return Result(id, "uploading", 0);
            if (op == "chunk") {
                int offset = (int)command["offset"]; byte[] chunk = Convert.FromBase64String((string)command["data"]);
                if (offset == uploaded.Length) uploaded.Write(chunk, 0, chunk.Length);
                else Check(offset + chunk.Length == uploaded.Length, "retry changed offset");
                if (!dropped) { dropped = true; throw new IOException("simulated lost reply"); }
                return Result(id, "uploading", (int)uploaded.Length);
            }
            if (op == "commit") return Result(id, "queued", body.Length);
            if (op == "status") return Result(id, ++polls < 2 ? "queued" : "delivered", 0);
            cancels++; throw new Exception("unexpected cancellation");
        });
        Check(state == "delivered" && polls == 2 && cancels == 0 && Convert.ToBase64String(uploaded.ToArray()) == Convert.ToBase64String(body), "receipt/retry changed delivery");
    }
    static void SenderFailures() {
        foreach (string failure in new[] { "rejected", "offline", "forged", "timeout", "late-receipt" }) {
            bool cancelled = false, succeeded = false;
            try {
                string state = ClipRelay.PairedRelayPublisher.Send(new string('b', 64), "json", Encoding.UTF8.GetBytes("fixture"), 1000, (command, timeout) => {
                    string id = (string)command["id"], op = (string)command["op"];
                    if (op == "cancel") { cancelled = true; return Result(id, failure == "late-receipt" ? "delivered" : "cancelled", 0); }
                    if (failure == "offline") return new Dictionary<string, object> { { "ok", false }, { "code", "RELAY_OFFLINE" } };
                    if (failure == "forged") return Result(new string('0', 32), "uploading", 0);
                    if (op == "begin") return Result(id, "uploading", 0);
                    if (op == "chunk") return Result(id, "uploading", 7);
                    return Result(id, failure == "rejected" ? "rejected" : "queued", 0);
                }); succeeded = state == "delivered";
            } catch (Exception) { }
            Check(cancelled && succeeded == (failure == "late-receipt"), "false delivery success: " + failure);
        }
    }
    static void PipeIdentity(bool wrongIdentity) {
        string name = "ClipRelay.Test.Relay." + Guid.NewGuid().ToString("N");
        int received = -1; Exception failure = null;
        using (var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
        using (var current = Process.GetCurrentProcess()) {
            Process other = null;
            if (wrongIdentity) {
                other = Process.Start(new ProcessStartInfo(typeof(PairedRelayTests).Assembly.Location, "--idle") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true });
            }
            var thread = new Thread(() => {
                try {
                    server.WaitForConnection();
                    using (var input = new MemoryStream()) {
                        int ch; while ((ch = server.ReadByte()) >= 0 && ch != 10) input.WriteByte((byte)ch);
                        received = (int)input.Length;
                        if (received > 0) {
                            byte[] reply = Encoding.UTF8.GetBytes("{\"ok\":true,\"peers\":[]}\n"); server.Write(reply, 0, reply.Length);
                        }
                    }
                } catch (Exception e) { failure = e; }
            }) { IsBackground = true }; thread.Start();
            bool accepted = false;
            try { ClipRelay.Remote.RelayIpc.Request(new Dictionary<string, object> { { "op", "peers" } }, other ?? current, name, 2000); accepted = true; }
            catch (IOException) { }
            finally { if (other != null) { other.StandardInput.WriteLine(); if (!other.WaitForExit(2000)) other.Kill(); other.Dispose(); } }
            Check(thread.Join(3000) && failure == null && accepted != wrongIdentity && (wrongIdentity ? received == 0 : received > 0), "pipe identity leaked request or rejected real server");
        }
    }
    static void PipeTimeout() {
        string name = "ClipRelay.Test.Relay." + Guid.NewGuid().ToString("N");
        using (var server = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
        using (var current = Process.GetCurrentProcess()) {
            var connected = server.WaitForConnectionAsync(); var watch = Stopwatch.StartNew(); bool failed = false;
            try { ClipRelay.Remote.RelayIpc.Request(new Dictionary<string, object> { { "op", "peers" } }, current, name, 200); }
            catch (IOException) { failed = true; }
            Check(failed && watch.ElapsedMilliseconds < 2000 && connected.IsCompleted, "blocked IPC outlived deadline");
        }
    }
}
