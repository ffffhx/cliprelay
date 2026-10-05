using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace ClipRelayTests
{
    public sealed class PreviewStateServer : IDisposable
    {
        private readonly TcpListener listener;
        private readonly Thread worker;
        private volatile bool stopped;
        public volatile string StateBody = "{\"active\":true,\"page\":3,\"pageCount\":8,\"contentType\":\"text\",\"moving\":false}";
        public volatile int StateCode = 200;
        public volatile int NavigateCode = 200;
        public volatile int StateDelay;
        public volatile int StateRequests;
        public volatile int NavigateRequests;
        public volatile string LastToken;
        public volatile string LastBody;
        public int Port { get; private set; }
        public PreviewStateServer()
        {
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            Port = ((IPEndPoint)listener.LocalEndpoint).Port;
            worker = new Thread(Run) { IsBackground = true };
            worker.Start();
        }
        private void Run()
        {
            while (!stopped)
            {
                try
                {
                    using (TcpClient client = listener.AcceptTcpClient())
                    using (NetworkStream stream = client.GetStream())
                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, false, 1024, true))
                    {
                        client.ReceiveTimeout = 3000;
                        string path = reader.ReadLine().Split(' ')[1];
                        int length = 0;
                        string line;
                        while (!String.IsNullOrEmpty(line = reader.ReadLine()))
                        {
                            int split = line.IndexOf(':');
                            if (split < 0) continue;
                            string key = line.Substring(0, split), value = line.Substring(split + 1).Trim();
                            if (key.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) length = Int32.Parse(value);
                            if (key.Equals("X-ClipRelay-Token", StringComparison.OrdinalIgnoreCase)) LastToken = value;
                        }
                        char[] requestBody = new char[length];
                        reader.ReadBlock(requestBody, 0, length);
                        int code;
                        string body;
                        if (path == "/preview/state")
                        {
                            StateRequests++;
                            code = StateCode; body = StateBody;
                            if (StateDelay > 0) Thread.Sleep(StateDelay);
                        }
                        else if (path == "/preview/navigate")
                        {
                            LastBody = new string(requestBody); NavigateRequests++;
                            code = NavigateCode; body = "ok";
                        }
                        else { code = 404; body = "not found"; }
                        byte[] payload = Encoding.UTF8.GetBytes(body);
                        byte[] header = Encoding.ASCII.GetBytes("HTTP/1.1 " + code + " Response\r\nContent-Type: application/json\r\nContent-Length: " + payload.Length + "\r\nConnection: close\r\n\r\n");
                        stream.Write(header, 0, header.Length);
                        stream.Write(payload, 0, payload.Length);
                    }
                }
                catch (SocketException) { }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
            }
        }
        public void Dispose()
        {
            stopped = true;
            listener.Stop();
            worker.Join(3000);
        }
    }
}
