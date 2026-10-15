namespace ClipRelay {
    using System;
    using System.Collections.Generic;
    using System.Diagnostics;
    using System.IO;
    using System.IO.Pipes;
    using System.Runtime.InteropServices;
    using System.Security.Cryptography;
    using System.Text;
    using System.Threading;
    using System.Web.Script.Serialization;
    using Microsoft.Win32.SafeHandles;

    public static class PairedRelayPublisher {
        public static System.Threading.Tasks.Task<Dictionary<string, object>> GetPeersAsync() {
            return System.Threading.Tasks.Task.Run(() => Request(new Dictionary<string, object> { { "op", "peers" } }, 5000));
        }
        public static string Send(string owner, string kind, byte[] body, int timeoutMs) {
            return Send(owner, kind, body, timeoutMs, Request);
        }

        // Shared by the real sender and protocol tests; fixtures never access a clipboard.
        internal static string Send(string owner, string kind, byte[] body, int timeoutMs,
            Func<Dictionary<string, object>, int, Dictionary<string, object>> transport) {
            if (!System.Text.RegularExpressions.Regex.IsMatch(owner ?? "", "\\A[0-9a-f]{64}\\z") ||
                (kind != "json" && kind != "jpeg") || body == null || body.Length == 0 ||
                body.Length > (kind == "json" ? 1024 * 1024 : 25 * 1024 * 1024))
                throw new InvalidDataException("RELAY_BAD_REQUEST");
            string id = Guid.NewGuid().ToString("N"), digest;
            using (var sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(body)).Replace("-", "").ToLowerInvariant();
            int budget = Math.Max(1000, Math.Min(timeoutMs, 60000));
            var watch = Stopwatch.StartNew();
            Func<string, Dictionary<string, object>> command = op => new Dictionary<string, object> { { "op", op }, { "owner", owner }, { "id", id } };
            Func<Dictionary<string, object>, Dictionary<string, object>> call = value => {
                for (int attempt = 0; ; attempt++) {
                    int remaining = budget - (int)watch.ElapsedMilliseconds;
                    if (remaining <= 0) throw new TimeoutException("RELAY_DELIVERY_UNCONFIRMED");
                    Dictionary<string, object> result;
                    try { result = transport(value, Math.Min(5000, remaining)); }
                    catch (IOException) { if (attempt == 0 && watch.ElapsedMilliseconds < budget) continue; throw; }
                    if (result == null || !(result.ContainsKey("ok") && result["ok"] is bool && (bool)result["ok"])) {
                        string code = Field(result, "code");
                        if (!System.Text.RegularExpressions.Regex.IsMatch(code, "\\ARELAY_[A-Z_]{1,40}\\z")) code = "RELAY_UNAVAILABLE";
                        throw new InvalidOperationException(code);
                    }
                    if (Field(result, "id") != id) throw new InvalidDataException("RELAY_BAD_REPLY");
                    return result;
                }
            };
            try {
                var begin = command("begin"); begin["kind"] = kind; begin["size"] = body.Length; begin["sha256"] = digest;
                var reply = call(begin);
                if (Field(reply, "state") != "uploading") throw new IOException("RELAY_BAD_REPLY");
                for (int offset = 0; offset < body.Length; offset += 8192) {
                    int count = Math.Min(8192, body.Length - offset);
                    var chunk = command("chunk"); chunk["offset"] = offset; chunk["data"] = Convert.ToBase64String(body, offset, count);
                    reply = call(chunk);
                    object confirmed;
                    if (Field(reply, "state") != "uploading" || !reply.TryGetValue("offset", out confirmed) || !(confirmed is int) || (int)confirmed != offset + count)
                        throw new InvalidDataException("RELAY_BAD_REPLY");
                }
                reply = call(command("commit"));
                for (;;) {
                    string state = Field(reply, "state");
                    if (state == "delivered") return state;
                    if (state != "queued") throw new IOException("RELAY_" + (state == "rejected" ? "REJECTED" : state == "expired" ? "EXPIRED" : state == "cancelled" ? "CANCELLED" : "BAD_REPLY"));
                    Thread.Sleep(Math.Min(150, Math.Max(0, budget - (int)watch.ElapsedMilliseconds)));
                    reply = call(command("status"));
                }
            } catch {
                // A final receipt may have arrived just as the local request timed out.
                // Cancellation otherwise removes pending data, without claiming it was delivered.
                try {
                    var cancelled = transport(command("cancel"), 1000);
                    if (cancelled != null && cancelled.ContainsKey("ok") && cancelled["ok"] is bool && (bool)cancelled["ok"] &&
                        Field(cancelled, "id") == id && Field(cancelled, "state") == "delivered") return "delivered";
                } catch { }
                throw;
            }
        }

        static string Field(Dictionary<string, object> value, string key) {
            object field;
            return value != null && value.TryGetValue(key, out field) && field is string ? (string)field : "";
        }

        static Dictionary<string, object> Request(Dictionary<string, object> command, int timeoutMs) {
            var json = new JavaScriptSerializer { MaxJsonLength = 512 * 1024, RecursionLimit = 16 };
            byte[] bytes = new UTF8Encoding(false, true).GetBytes(json.Serialize(new { action = "relay", command = command }) + "\n");
            if (bytes.Length > 16384) throw new InvalidDataException("RELAY_BAD_REQUEST");
            uint expected = ServiceProcessId();
            // Keep the process handle open so an exited service PID cannot be reused.
            using (var process = OpenProcess(0x00101000, false, expected)) {
                if (process.IsInvalid) throw new IOException("RELAY_UNAVAILABLE");
                using (var pipe = new NamedPipeClientStream(".", "ClipRelay.Remote.Control.v1", PipeDirection.InOut, PipeOptions.Asynchronous))
                using (var timeout = new Timer(delegate { try { pipe.Dispose(); } catch { } }, null, timeoutMs, Timeout.Infinite)) {
                    try {
                        pipe.Connect(Math.Min(timeoutMs, 2500));
                        uint actual;
                        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out actual) || actual != expected || WaitForSingleObject(process, 0) != 258 || ServiceProcessId() != expected)
                            throw new IOException("RELAY_SERVER_MISMATCH");
                        pipe.Write(bytes, 0, bytes.Length); pipe.Flush();
                        using (var input = new MemoryStream()) {
                            int ch;
                            while ((ch = pipe.ReadByte()) >= 0 && ch != 10) {
                                if (input.Length >= 512 * 1024) throw new InvalidDataException("RELAY_BAD_REPLY");
                                input.WriteByte((byte)ch);
                            }
                            if (ch != 10) throw new IOException("RELAY_UNAVAILABLE");
                            var reply = json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(input.ToArray()));
                            object ok, data;
                            if (reply == null || !reply.TryGetValue("ok", out ok) || !(ok is bool) || !(bool)ok ||
                                !reply.TryGetValue("data", out data) || !(data is Dictionary<string, object>)) throw new IOException("RELAY_UNAVAILABLE");
                            return (Dictionary<string, object>)data;
                        }
                    } catch (IOException) { throw; }
                    catch (Exception) { throw new IOException("RELAY_UNAVAILABLE"); }
                }
            }
        }

        static uint ServiceProcessId() {
            IntPtr manager = OpenSCManager(null, null, 1), service = IntPtr.Zero;
            if (manager == IntPtr.Zero) throw new IOException("RELAY_UNAVAILABLE");
            try {
                service = OpenService(manager, "ClipRelayRemote", 4);
                ServiceStatus status; int needed;
                if (service == IntPtr.Zero || !QueryServiceStatusEx(service, 0, out status, Marshal.SizeOf(typeof(ServiceStatus)), out needed) ||
                    status.State != 4 || status.ProcessId == 0) throw new IOException("RELAY_UNAVAILABLE");
                return status.ProcessId;
            } finally { if (service != IntPtr.Zero) CloseServiceHandle(service); CloseServiceHandle(manager); }
        }
        [StructLayout(LayoutKind.Sequential)] struct ServiceStatus { public uint Type, State, Accepted, ExitCode, ServiceExit, Checkpoint, WaitHint, ProcessId, Flags; }
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenSCManager(string machine, string database, uint access);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenService(IntPtr manager, string name, uint access);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool QueryServiceStatusEx(IntPtr service, int level, out ServiceStatus status, int size, out int needed);
        [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint id);
        [DllImport("kernel32.dll", SetLastError = true)] static extern SafeProcessHandle OpenProcess(uint access, bool inherit, uint id);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(SafeProcessHandle process, uint milliseconds);
    }
}
