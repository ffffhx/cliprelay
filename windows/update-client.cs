using System;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace ClipRelay
{
    // No PowerShell callbacks on worker threads. The UI only polls completed work.
    public sealed class UpdateTransfer : IDisposable
    {
        private volatile HttpWebRequest request;
        private volatile bool cancelled;
        private long received;
        public volatile bool Done;
        public string Error = "";
        public string Content = "";
        public string FilePath = "";
        public long Received { get { return Interlocked.Read(ref received); } }

        public static UpdateTransfer Check(string url)
        {
            var transfer = new UpdateTransfer();
            Task.Run(() => transfer.Run(url, null, 128 * 1024, null));
            return transfer;
        }

        public static UpdateTransfer Download(string url, string path, long size, string sha256)
        {
            var transfer = new UpdateTransfer();
            Task.Run(() => transfer.Run(url, path, size, sha256));
            return transfer;
        }

        private static string Digest(string path)
        {
            using (var file = File.OpenRead(path))
            using (var sha = SHA256.Create())
                return BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
        }

        private void Run(string url, string destination, long limit, string expectedHash)
        {
            string partial = null;
            try
            {
                var uri = new Uri(url);
                if (uri.Scheme != "https" || !String.IsNullOrEmpty(uri.UserInfo))
                    throw new InvalidDataException("更新地址必须使用 HTTPS。");
                if (destination != null)
                {
                    if (limit <= 0 || limit > 512L * 1024 * 1024)
                        throw new InvalidDataException("安装包大小无效。");
                    Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    if (File.Exists(destination) && new FileInfo(destination).Length == limit &&
                        String.Equals(Digest(destination), expectedHash, StringComparison.OrdinalIgnoreCase))
                    { FilePath = destination; return; }
                    partial = destination + "." + Guid.NewGuid().ToString("N") + ".partial";
                }
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
                request = (HttpWebRequest)WebRequest.Create(uri);
                request.UserAgent = "ClipRelay-Windows-Updater";
                request.AllowAutoRedirect = false;
                request.Timeout = 15000;
                request.ReadWriteTimeout = 30000;
                request.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
                if (cancelled) throw new OperationCanceledException();
                using (var response = (HttpWebResponse)request.GetResponse())
                {
                    if (response.StatusCode != HttpStatusCode.OK)
                        throw new InvalidDataException("更新服务返回异常，请稍后重试。");
                    if (response.ContentLength > limit || (destination != null && response.ContentLength >= 0 && response.ContentLength != limit))
                        throw new InvalidDataException("安装包大小与发布信息不一致。");
                    using (var input = response.GetResponseStream())
                    using (Stream output = destination == null ? (Stream)new MemoryStream() : new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        var buffer = new byte[65536];
                        var deadline = DateTime.UtcNow.AddMinutes(destination == null ? 1 : 30);
                        int count;
                        while ((count = input.Read(buffer, 0, buffer.Length)) != 0)
                        {
                            if (cancelled) throw new OperationCanceledException();
                            if (DateTime.UtcNow > deadline) throw new TimeoutException("更新下载超时，请重试。");
                            if (Interlocked.Add(ref received, count) > limit)
                                throw new InvalidDataException("下载内容超过允许的大小。");
                            output.Write(buffer, 0, count);
                        }
                        if (destination == null)
                            Content = new UTF8Encoding(false, true).GetString(((MemoryStream)output).ToArray());
                    }
                }
                if (destination != null)
                {
                    if (Received != limit || !String.Equals(Digest(partial), expectedHash, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("安装包校验失败，请重新下载。");
                    if (cancelled) throw new OperationCanceledException();
                    if (File.Exists(destination)) File.Delete(destination);
                    File.Move(partial, destination);
                    FilePath = destination;
                }
            }
            catch (WebException ex)
            {
                var response = ex.Response as HttpWebResponse;
                Error = response != null && response.StatusCode == HttpStatusCode.NotFound
                    ? "暂未发布 Windows 版本，请稍后检查。"
                    : "连接更新服务失败，请检查网络后重试。";
                if (response != null) response.Dispose();
            }
            catch (Exception ex) { Error = cancelled ? "下载已取消。" : ex.Message; }
            finally
            {
                if (partial != null) { try { File.Delete(partial); } catch { } }
                Done = true;
            }
        }

        public void Dispose()
        {
            cancelled = true;
            var active = request;
            if (active != null) active.Abort();
        }
    }
}
