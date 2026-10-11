using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

namespace ClipRelay {
    // Lifecycle only: clipboard, protocol, UI and all application decisions
    // continue to execute in the existing STA engine.
    public sealed class DesktopHostBridge : IDisposable {
        private readonly NamedPipeClientStream pipe;
        private readonly StreamWriter writer;
        private readonly ConcurrentQueue<string> commands = new ConcurrentQueue<string>();
        private volatile bool disconnected;
        public bool Disconnected { get { return disconnected; } }
        public DesktopHostBridge(string name) {
            pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
            pipe.Connect(15000);
            writer = new StreamWriter(pipe, new UTF8Encoding(false), 1024, true);
            writer.AutoFlush = true;
            var thread = new Thread(Read);
            thread.IsBackground = true;
            thread.Name = "ClipRelay Electron lifetime";
            thread.Start();
        }
        private void Read() {
            try {
                using (var reader = new StreamReader(pipe, Encoding.UTF8, false, 1024, true)) {
                    string line;
                    while ((line = reader.ReadLine()) != null) {
                        if (line.Length > 262144) break;
                        if (line == "open" || line == "quit" || line.StartsWith("{")) commands.Enqueue(line);
                    }
                }
            } catch (IOException) {} catch (ObjectDisposedException) {}
            finally { disconnected = true; }
        }
        public string Take() { string command; return commands.TryDequeue(out command) ? command : null; }
        public void Send(string message) {
            try { lock (writer) { writer.WriteLine(message); } }
            catch (IOException) { disconnected = true; }
            catch (ObjectDisposedException) { disconnected = true; }
        }
        public void Dispose() { disconnected = true; pipe.Dispose(); }
    }
}
