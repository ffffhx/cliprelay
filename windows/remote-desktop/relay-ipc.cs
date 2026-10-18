using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace ClipRelay.Remote {
    // Only the service calls this SYSTEM-only helper pipe. Authenticate the live
    // process before sending even one payload byte: pipe names alone are not identities.
    internal static class RelayIpc {
        internal const string PipeName = "ClipRelay.Remote.Relay.v1";
        const int RequestLimit = 16384, ReplyLimit = 512 * 1024;
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint processId);

        internal static object Request(Dictionary<string, object> command, Process expected) {
            return Request(command, expected, PipeName, 5000);
        }
        internal static object Request(Dictionary<string, object> command, Process expected, string pipeName, int timeoutMs) {
            if (command == null || expected == null) throw new InvalidDataException("RELAY_BAD_REQUEST");
            object op;
            if (!command.TryGetValue("op", out op) || !(op is string) ||
                Array.IndexOf(new[] { "peers", "begin", "chunk", "commit", "status", "cancel" }, (string)op) < 0)
                throw new InvalidDataException("RELAY_BAD_REQUEST");
            foreach (string key in command.Keys)
                if (Array.IndexOf(new[] { "op", "owner", "id", "kind", "size", "offset", "sha256", "data" }, key) < 0)
                    throw new InvalidDataException("RELAY_BAD_REQUEST");
            return Exchange(command, expected, pipeName, timeoutMs);
        }
        internal static object RequestPairing(Dictionary<string, object> command, Process expected) {
            return RequestPairing(command, expected, PipeName, 5000);
        }
        internal static object RequestPairing(Dictionary<string, object> command, Process expected, string pipeName, int timeoutMs) {
            LanPairingControl.ValidateCommand(command);
            return Exchange(command, expected, pipeName, timeoutMs);
        }
        static object Exchange(Dictionary<string, object> command, Process expected, string pipeName, int timeoutMs) {
            if (expected == null) throw new InvalidDataException("RELAY_BAD_REQUEST");
            var json = new JavaScriptSerializer { MaxJsonLength = ReplyLimit, RecursionLimit = 16 };
            byte[] bytes = new UTF8Encoding(false, true).GetBytes(json.Serialize(command) + "\n");
            if (bytes.Length > RequestLimit) throw new InvalidDataException("RELAY_BAD_REQUEST");
            // The caller has opened this process handle under the service gate.
            // Holding it prevents the expected PID from being reused during IPC.
            IntPtr heldHandle = expected.Handle;
            if (expected.HasExited) throw new IOException("RELAY_UNAVAILABLE");
            using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
            using (var timeout = new Timer(delegate { try { pipe.Dispose(); } catch { } }, null, timeoutMs, Timeout.Infinite)) {
                try {
                    pipe.Connect(Math.Min(2500, timeoutMs));
                    uint serverId;
                    if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out serverId) ||
                        serverId != (uint)expected.Id || expected.HasExited)
                        throw new IOException("RELAY_SERVER_MISMATCH");
                    pipe.Write(bytes, 0, bytes.Length); pipe.Flush();
                    using (var input = new MemoryStream()) {
                        int ch;
                        while ((ch = pipe.ReadByte()) >= 0 && ch != 10) {
                            if (input.Length >= ReplyLimit) throw new InvalidDataException("RELAY_BAD_REPLY");
                            input.WriteByte((byte)ch);
                        }
                        if (ch != 10) throw new IOException("RELAY_BAD_REPLY");
                        var result = json.Deserialize<Dictionary<string, object>>(new UTF8Encoding(false, true).GetString(input.ToArray()));
                        object ok;
                        if (result == null || !result.TryGetValue("ok", out ok) || !(ok is bool))
                            throw new InvalidDataException("RELAY_BAD_REPLY");
                        return result;
                    }
                } catch (IOException) { throw; }
                catch (Exception) { throw new IOException("RELAY_UNAVAILABLE"); }
            }
        }
    }
}
