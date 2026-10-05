using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading.Tasks;
namespace ClipRelay.Remote {
    public static class ControlClient {
        public static string Request(string json) {
            using (var pipe = new NamedPipeClientStream(".", "ClipRelay.Remote.Control.v1", PipeDirection.InOut, PipeOptions.Asynchronous)) {
                pipe.Connect(2500);
                byte[] bytes = Encoding.UTF8.GetBytes(json + "\n");
                pipe.Write(bytes, 0, bytes.Length); pipe.Flush();
                using (var reader = new StreamReader(pipe, Encoding.UTF8)) {
                    Task<string> read = reader.ReadLineAsync();
                    if (!read.Wait(25000)) throw new TimeoutException("Remote desktop service timed out");
                    return read.Result;
                }
            }
        }
        public static Task<string> RequestAsync(string json) { return Task.Run(() => Request(json)); }
    }
}
