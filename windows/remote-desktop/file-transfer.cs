// Resumable file transfers under the desktop user's token. Never execute files.
// The authenticated Go front end derives Owner from the paired TLS certificate.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace ClipRelay.Remote {
    public static class FileTransfer {
        [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
        static string Downloads() {
            var id = new Guid("374DE290-123F-4565-9164-39C4925E467B");
            IntPtr path = IntPtr.Zero;
            try { return SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out path) == 0 ? Marshal.PtrToStringUni(path) : ""; }
            finally { if (path != IntPtr.Zero) Marshal.FreeCoTaskMem(path); }
        }
        public static int Run() {
            using (var identity = WindowsIdentity.GetCurrent())
                if (identity.IsSystem) return DesktopUserProcess.RunFileWorker();
            var roots = new Dictionary<string, string> {
                { "home", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) },
                { "desktop", Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory) },
                { "documents", Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments) }
            };
            string downloads = Downloads();
            if (Directory.Exists(downloads)) roots["downloads"] = downloads;
            roots = roots.Where(pair => !String.IsNullOrEmpty(pair.Value) && Directory.Exists(pair.Value)).ToDictionary(pair => pair.Key, pair => pair.Value);
            string state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClipRelay", "Transfers");
            using (var store = new TransferStore(roots, state)) return Serve(store);
        }
        public static int Serve(TransferStore store) {
            var json = new JavaScriptSerializer { MaxJsonLength = 400 * 1024, RecursionLimit = 12 };
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
                while (true) {
                    var line = new StringBuilder();
                    int value;
                    while ((value = Console.Read()) != -1 && value != '\n') {
                        if (line.Length >= 400 * 1024) return 2;
                        line.Append((char)value);
                    }
                    if (value == -1) return 0;
                    if (!line.ToString().StartsWith("files:", StringComparison.Ordinal)) return 2;
                    object result;
                    try { result = store.Handle(json.Deserialize<Dictionary<string, object>>(line.ToString().Substring(6))); }
                    catch (ArgumentException) { result = new { ok = false, code = "FILES_BAD_REQUEST" }; }
                    Console.WriteLine(json.Serialize(result));
                    Console.Out.Flush();
                }
        }
    }

    public sealed class TransferRecord {
        public string Id { get; set; }
        public string Owner { get; set; }
        public string Root { get; set; }
        public string Directory { get; set; }
        public string Name { get; set; }
        public string Direction { get; set; }
        public long Size { get; set; }
        public string Sha256 { get; set; }
        public long Offset { get; set; }
        public string State { get; set; }
        public string FinalName { get; set; }
        public long Modified { get; set; }
        public string Code { get; set; }
        public long Updated { get; set; }
        public long Verified { get; set; }
    }

    public sealed class TransferStore : IDisposable {
        public const int ChunkSize = 256 * 1024;
        public const long MaxFileSize = 1024L * 1024 * 1024 * 1024;
        const long ReserveBytes = 32L * 1024 * 1024;
        readonly object gate = new object();
        readonly Dictionary<string, string> roots;
        readonly string stateRoot;
        readonly Dictionary<string, TransferRecord> records = new Dictionary<string, TransferRecord>();
        readonly HashSet<string> hashing = new HashSet<string>();
        readonly Func<string, long> availableSpace;
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 400 * 1024, RecursionLimit = 12 };
        bool closed;
        sealed class Failure : Exception { public Failure(string code) : base(code) {} }
        static void Require(bool condition, string code) { if (!condition) throw new Failure(code); }
        static string Text(IDictionary<string, object> value, string key) {
            object found; return value.TryGetValue(key, out found) && found is string ? (string)found : "";
        }
        static long Number(IDictionary<string, object> value, string key) {
            object found;
            Require(value.TryGetValue(key, out found) && (found is int || found is long), "FILES_BAD_REQUEST");
            return Convert.ToInt64(found);
        }
        static string Hex(byte[] value) { return BitConverter.ToString(value).Replace("-", "").ToLowerInvariant(); }
        static string Digest(byte[] value) { using (var sha = SHA256.Create()) return Hex(sha.ComputeHash(value)); }
        static bool IsHex(string value, int count) { return value != null && Regex.IsMatch(value, "\\A[0-9a-f]{" + count + "}\\z"); }
        static string Key(string owner, string id) { return owner + "-" + id; }
        static long Now { get { return DateTime.UtcNow.Ticks; } }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetDiskFreeSpaceEx(string path, out ulong available, out ulong total, out ulong free);

        public TransferStore(Dictionary<string, string> directories, string stateDirectory, Func<string, long> freeSpace = null) {
            roots = directories.ToDictionary(pair => pair.Key, pair => Path.GetFullPath(pair.Value));
            Require(roots.Count > 0 && roots.All(pair => Regex.IsMatch(pair.Key, "\\A[a-z][a-z0-9-]{0,31}\\z") && Directory.Exists(pair.Value)), "FILES_UNAVAILABLE");
            stateRoot = Path.GetFullPath(stateDirectory);
            Directory.CreateDirectory(stateRoot);
            RejectLinks(stateRoot);
            availableSpace = freeSpace ?? (path => {
                ulong available, total, free;
                if (!GetDiskFreeSpaceEx(path, out available, out total, out free)) throw new IOException("space unavailable");
                return (long)Math.Min(available, (ulong)Int64.MaxValue);
            });
        }

        // Root-relative protocol paths never accept drive letters, UNC, ADS,
        // device names or dot traversal. Junctions cannot escape a granted root.
        static string SafeName(string name) {
            Require(!String.IsNullOrWhiteSpace(name) && name.Length <= 200 && name == name.Trim() && !name.EndsWith(".") &&
                name != "." && name != ".." && !name.StartsWith(".cliprelay-", StringComparison.OrdinalIgnoreCase) &&
                name.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && !name.Contains("/") && !name.Contains("\\"), "FILES_BAD_PATH");
            string stem = name.Split('.')[0];
            Require(!Regex.IsMatch(stem, "\\A(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\\z", RegexOptions.IgnoreCase), "FILES_BAD_PATH");
            return name;
        }
        static void RejectLinks(string path) {
            for (string current = path; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current)) {
                if (File.Exists(current) || Directory.Exists(current))
                    Require((File.GetAttributes(current) & FileAttributes.ReparsePoint) == 0, "FILES_LINK_NOT_ALLOWED");
                if (current == Path.GetPathRoot(current)) break;
            }
        }
        string Resolve(string rootId, string relative, bool directory) {
            string root;
            Require(roots.TryGetValue(rootId, out root), "FILES_BAD_PATH");
            Require(relative.Length <= 1000 && !relative.Contains("\\") && !relative.StartsWith("/"), "FILES_BAD_PATH");
            foreach (string part in relative.Split('/')) if (part.Length != 0) SafeName(part); else Require(relative.Length == 0, "FILES_BAD_PATH");
            string result = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
            Require(result.Equals(root, StringComparison.OrdinalIgnoreCase) || result.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "FILES_BAD_PATH");
            // Never make transfer journals browsable, including a deliberately
            // guessed path inside the otherwise granted user profile.
            Require(!result.Equals(stateRoot, StringComparison.OrdinalIgnoreCase) && !result.StartsWith(stateRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "FILES_BAD_PATH");
            RejectLinks(result);
            Require(directory ? Directory.Exists(result) : File.Exists(result), "FILES_NOT_FOUND");
            return result;
        }
        string Journal(string owner, string id) { return Path.Combine(stateRoot, Key(owner, id) + ".json"); }
        string Folder(TransferRecord value) { return Resolve(value.Root, value.Directory, true); }
        string Part(TransferRecord value) {
            return Path.Combine(Folder(value), ".cliprelay-" + Key(value.Owner, value.Id) + ".part");
        }
        void Save(TransferRecord value) {
            value.Updated = Now;
            string target = Journal(value.Owner, value.Id), temporary = target + ".tmp";
            RejectLinks(stateRoot);
            RejectLinks(target); RejectLinks(temporary);
            byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(value));
            using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None)) {
                stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
            }
            if (File.Exists(target)) File.Replace(temporary, target, null); else File.Move(temporary, target);
            records[Key(value.Owner, value.Id)] = value;
        }
        TransferRecord Load(string owner, string id) {
            string key = Key(owner, id);
            TransferRecord value;
            if (records.TryGetValue(key, out value)) return value;
            string journal = Journal(owner, id);
            Require(File.Exists(journal), "FILES_NOT_FOUND");
            RejectLinks(journal);
            Require(new FileInfo(journal).Length <= 16384, "FILES_INVALID_STATE");
            value = json.Deserialize<TransferRecord>(File.ReadAllText(journal, Encoding.UTF8));
            Require(value != null && value.Owner == owner && value.Id == id && value.Size >= 0 && value.Size <= MaxFileSize &&
                value.Offset >= 0 && value.Offset <= value.Size && (value.Direction == "upload" || value.Direction == "download"), "FILES_INVALID_STATE");
            SafeName(value.Name);
            if (value.State == "verifying") { value.State = "queued"; value.Verified = 0; }
            records[key] = value;
            if (value.State == "committing") RecoverCommit(value);
            return value;
        }
        object Snapshot(TransferRecord value) {
            return new { ok = true, id = value.Id, direction = value.Direction, root = value.Root, directory = value.Directory,
                name = value.Name, size = value.Size, sha256 = value.Sha256, offset = value.Offset, state = value.State,
                finalName = value.FinalName, verified = value.Verified, code = value.Code ?? "", chunkSize = ChunkSize };
        }
        public object Handle(Dictionary<string, object> request) {
            lock (gate) {
                try {
                    Require(!closed && request != null, "FILES_UNAVAILABLE");
                    string owner = Text(request, "owner"), id = Text(request, "id"), op = Text(request, "op");
                    Require(IsHex(owner, 64), "FILES_BAD_REQUEST");
                    if (op == "roots") return new { ok = true, roots = roots.Keys.Select(key => new { id = key, name = key, writable = true }).ToArray(), chunkSize = ChunkSize };
                    if (op == "list") return List(request);
                    if (op == "mkdir") {
                        string folder = Resolve(Text(request, "root"), Text(request, "path"), true);
                        string target = Path.Combine(folder, SafeName(Text(request, "name")));
                        Require(!Directory.Exists(target) && !File.Exists(target), "FILES_EXISTS");
                        Directory.CreateDirectory(target); return new { ok = true };
                    }
                    Require(IsHex(id, 32), "FILES_BAD_REQUEST");
                    if (op == "upload-start" || op == "download-start") return Start(request, owner, id, op == "upload-start");
                    var value = Load(owner, id);
                    if (op == "status") {
                        if (value.State == "queued" || (value.Direction == "download" && value.State == "preparing")) BeginHash(value);
                        if (value.State == "committing" && !hashing.Contains(Key(owner, id))) RecoverCommit(value);
                        return Snapshot(value);
                    }
                    if (op == "cancel") {
                        if (value.State == "complete") return Snapshot(value);
                        if (value.State == "committing" && !File.Exists(Part(value))) return Snapshot(value);
                        value.State = "cancelled"; Save(value);
                        if (value.Direction == "upload" && !hashing.Contains(Key(owner, id))) DeletePart(value);
                        return Snapshot(value);
                    }
                    if (op == "upload-chunk") return Upload(value, request);
                    if (op == "download-chunk") return Download(value, request);
                    if (op == "finish") {
                        if (value.Direction == "upload") {
                            Require(value.Offset == value.Size, "FILES_OFFSET");
                            if (value.State == "uploading") BeginHash(value);
                            Require(value.State == "verifying" || value.State == "queued" || value.State == "committing" || value.State == "complete", "FILES_NOT_READY");
                        } else {
                            Require(value.State == "ready" || value.State == "complete", "FILES_NOT_READY");
                            Require(Text(request, "sha256") == value.Sha256, "FILES_HASH_MISMATCH");
                            value.Offset = value.Size; value.State = "complete"; Save(value);
                        }
                        return Snapshot(value);
                    }
                    throw new Failure("FILES_BAD_REQUEST");
                } catch (Failure failure) { return new { ok = false, code = failure.Message }; }
                catch (UnauthorizedAccessException) { return new { ok = false, code = "FILES_ACCESS_DENIED" }; }
                catch (IOException error) { return new { ok = false, code = (error.HResult & 0xFFFF) == 112 ? "FILES_DISK_FULL" : "FILES_IO" }; }
                catch (ArgumentException) { return new { ok = false, code = "FILES_BAD_REQUEST" }; }
                catch (InvalidOperationException) { return new { ok = false, code = "FILES_INVALID_STATE" }; }
            }
        }

        object List(Dictionary<string, object> request) {
            string root = Text(request, "root"), path = Text(request, "path"), after = Text(request, "after");
            string folder = Resolve(root, path, true);
            var entries = new SortedDictionary<string, FileSystemInfo>(StringComparer.OrdinalIgnoreCase);
            bool more = false;
            foreach (var entry in new DirectoryInfo(folder).EnumerateFileSystemInfos()) {
                if (entry.Name.StartsWith(".cliprelay-", StringComparison.OrdinalIgnoreCase) || entry.FullName.Equals(stateRoot, StringComparison.OrdinalIgnoreCase)) continue;
                string key = (entry is DirectoryInfo ? "0:" : "1:") + entry.Name;
                if (StringComparer.OrdinalIgnoreCase.Compare(key, after) <= 0) continue;
                entries[key] = entry;
                if (entries.Count > 256) { entries.Remove(entries.Last().Key); more = true; }
            }
            return new { ok = true, root = root, path = path, next = more ? entries.Last().Key : "", entries = entries.Values.Select(entry => new {
                name = entry.Name, directory = entry is DirectoryInfo, size = entry is FileInfo ? ((FileInfo)entry).Length : 0,
                modified = new DateTimeOffset(entry.LastWriteTimeUtc).ToUnixTimeMilliseconds(),
                blocked = (entry.Attributes & FileAttributes.ReparsePoint) != 0, hidden = (entry.Attributes & FileAttributes.Hidden) != 0
            }).ToArray() };
        }
        object Start(Dictionary<string, object> request, string owner, string id, bool upload) {
            string root = Text(request, "root"), directory = Text(request, "path"), name = SafeName(Text(request, "name"));
            string folder = Resolve(root, directory, true);
            long size = upload ? Number(request, "size") : 0;
            string sha = upload ? Text(request, "sha256") : "";
            if (File.Exists(Journal(owner, id))) {
                var previous = Load(owner, id);
                Require(previous.Root == root && previous.Directory == directory && previous.Name == name &&
                    previous.Direction == (upload ? "upload" : "download") && (!upload || (previous.Size == size && previous.Sha256 == sha)), "FILES_ID_CONFLICT");
                if (previous.State == "queued" || (!upload && previous.State == "preparing")) BeginHash(previous);
                return Snapshot(previous);
            }
            // A bounded journal count prevents a paired device from exhausting
            // metadata. Completed/cancelled journals can be removed after 7 days.
            Cleanup();
            Require(Directory.EnumerateFiles(stateRoot, "*.json").Take(257).Count() < 256, "FILES_QUEUE_FULL");
            long modified = 0;
            if (upload) {
                Require(size >= 0 && size <= MaxFileSize && IsHex(sha, 64), "FILES_BAD_REQUEST");
                Require(availableSpace(folder) >= size + ReserveBytes, "FILES_DISK_FULL");
            } else {
                string source = Resolve(root, directory.Length == 0 ? name : directory + "/" + name, false);
                var info = new FileInfo(source); size = info.Length; modified = info.LastWriteTimeUtc.Ticks;
                Require(size <= MaxFileSize, "FILES_TOO_LARGE");
            }
            var value = new TransferRecord { Owner = owner, Id = id, Root = root, Directory = directory, Name = name,
                Size = size, Sha256 = sha, Direction = upload ? "upload" : "download", State = upload ? "uploading" : "preparing", Modified = modified };
            if (upload) {
                string part = Part(value);
                Require(!File.Exists(part), "FILES_ID_CONFLICT");
                using (var stream = new FileStream(part, FileMode.CreateNew, FileAccess.Write, FileShare.None)) stream.Flush(true);
                try { Save(value); } catch { File.Delete(part); throw; }
            } else { Save(value); BeginHash(value); }
            return Snapshot(value);
        }
        object Upload(TransferRecord value, Dictionary<string, object> request) {
            Require(value.Direction == "upload" && value.State == "uploading", "FILES_NOT_READY");
            long offset = Number(request, "offset");
            byte[] bytes;
            try { bytes = Convert.FromBase64String(Text(request, "data")); } catch (FormatException) { throw new Failure("FILES_BAD_REQUEST"); }
            Require(bytes.Length > 0 && bytes.Length <= ChunkSize && offset >= 0 && offset <= value.Size - bytes.Length, "FILES_BAD_REQUEST");
            Require(Text(request, "sha256") == Digest(bytes), "FILES_HASH_MISMATCH");
            string path = Part(value); RejectLinks(path);
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read)) {
                Require(stream.Length >= value.Offset, "FILES_INVALID_STATE");
                if (stream.Length > value.Offset) stream.SetLength(value.Offset); // Discard an unacknowledged crash tail.
                if (offset < value.Offset) {
                    Require(offset + bytes.Length <= value.Offset, "FILES_OFFSET");
                    stream.Position = offset;
                    byte[] old = new byte[bytes.Length]; int count = 0, read;
                    while (count < old.Length && (read = stream.Read(old, count, old.Length - count)) > 0) count += read;
                    Require(count == old.Length && old.SequenceEqual(bytes), "FILES_CHUNK_CONFLICT");
                    return Snapshot(value); // Safe retry after a lost acknowledgement.
                }
                Require(offset == value.Offset, "FILES_OFFSET");
                Require(availableSpace(Folder(value)) >= bytes.Length + ReserveBytes, "FILES_DISK_FULL");
                stream.Position = offset; stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
            }
            long previousOffset = value.Offset;
            try { value.Offset += bytes.Length; Save(value); }
            catch { value.Offset = previousOffset; throw; }
            return Snapshot(value);
        }
        string Source(TransferRecord value) {
            string source = Resolve(value.Root, value.Directory.Length == 0 ? value.Name : value.Directory + "/" + value.Name, false);
            var info = new FileInfo(source);
            Require(info.Length == value.Size && info.LastWriteTimeUtc.Ticks == value.Modified, "FILES_SOURCE_CHANGED");
            return source;
        }
        object Download(TransferRecord value, Dictionary<string, object> request) {
            Require(value.Direction == "download" && (value.State == "ready" || value.State == "complete"), "FILES_NOT_READY");
            long offset = Number(request, "offset");
            Require(offset >= 0 && offset <= value.Size, "FILES_OFFSET");
            byte[] bytes = new byte[(int)Math.Min(ChunkSize, value.Size - offset)];
            using (var stream = new FileStream(Source(value), FileMode.Open, FileAccess.Read, FileShare.Read)) {
                Require(stream.Length == value.Size, "FILES_SOURCE_CHANGED");
                stream.Position = offset; int count = 0, read;
                while (count < bytes.Length && (read = stream.Read(bytes, count, bytes.Length - count)) > 0) count += read;
                Require(count == bytes.Length, "FILES_SOURCE_CHANGED");
            }
            return new { ok = true, id = value.Id, offset = offset, size = value.Size, data = Convert.ToBase64String(bytes), sha256 = Digest(bytes) };
        }
        void BeginHash(TransferRecord value) {
            string key = Key(value.Owner, value.Id);
            if (hashing.Contains(key)) return;
            Require(value.State == "uploading" || value.State == "preparing" || value.State == "queued", "FILES_NOT_READY");
            if (hashing.Count >= 2) { if (value.State != "queued") { value.State = "queued"; Save(value); } return; }
            value.State = "verifying"; value.Verified = 0; value.Code = ""; Save(value); hashing.Add(key);
            var thread = new Thread(() => Verify(value)) { IsBackground = true, Name = "ClipRelay file verification" };
            thread.Start();
        }
        void Verify(TransferRecord value, bool recovery = false) {
            string hash = null, failure = null;
            try {
                string path;
                lock (gate) { path = recovery ? Path.Combine(Folder(value), SafeName(value.FinalName)) : value.Direction == "upload" ? Part(value) : Source(value); RejectLinks(path); }
                using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (var sha = SHA256.Create()) {
                    Require(stream.Length == value.Size, "FILES_INVALID_STATE");
                    byte[] buffer = new byte[1024 * 1024]; int count;
                    while ((count = stream.Read(buffer, 0, buffer.Length)) > 0) {
                        sha.TransformBlock(buffer, 0, count, buffer, 0);
                        lock (gate) {
                            if (closed || value.State == "cancelled") return;
                            value.Verified += count;
                        }
                    }
                    sha.TransformFinalBlock(new byte[0], 0, 0); hash = Hex(sha.Hash);
                }
                lock (gate) {
                    if (closed || value.State == "cancelled") return;
                    if (value.Direction == "upload") {
                        Require(hash == value.Sha256, "FILES_HASH_MISMATCH");
                        if (recovery) {
                            value.State = "complete";
                            try { Save(value); } catch { value.State = "committing"; throw; }
                        } else Commit(value);
                    } else {
                        Source(value); value.Sha256 = hash; value.State = "ready"; Save(value);
                    }
                }
            } catch (Failure error) { failure = error.Message; }
            catch (UnauthorizedAccessException) { failure = "FILES_ACCESS_DENIED"; }
            catch (IOException error) { failure = (error.HResult & 0xFFFF) == 112 ? "FILES_DISK_FULL" : "FILES_IO"; }
            catch (ArgumentException) { failure = "FILES_INVALID_STATE"; }
            finally {
                lock (gate) {
                    hashing.Remove(Key(value.Owner, value.Id));
                    if (!closed) {
                        if (failure != null && value.State != "cancelled" &&
                            (value.State != "committing" || failure == "FILES_HASH_MISMATCH" || failure == "FILES_INVALID_STATE")) {
                            value.State = "error"; value.Code = failure;
                            try { Save(value); } catch (IOException) { } catch (UnauthorizedAccessException) { } catch (Failure) { }
                        }
                        if (value.State == "cancelled" && value.Direction == "upload") {
                            try { DeletePart(value); } catch (IOException) { } catch (UnauthorizedAccessException) { } catch (Failure) { }
                        }
                    }
                }
            }
        }
        void Commit(TransferRecord value) {
            string folder = Folder(value), part = Part(value);
            for (int number = 0; number < 10000; number++) {
                string candidate = number == 0 ? value.Name : Path.GetFileNameWithoutExtension(value.Name) + " (" + number + ")" + Path.GetExtension(value.Name);
                string target = Path.Combine(folder, candidate);
                if (File.Exists(target) || Directory.Exists(target)) continue;
                value.FinalName = candidate; value.State = "committing"; Save(value);
                try { File.Move(part, target); }
                catch (IOException) { if (File.Exists(part) && (File.Exists(target) || Directory.Exists(target))) continue; throw; }
                value.State = "complete";
                try { Save(value); } catch { value.State = "committing"; throw; }
                return;
            }
            throw new Failure("FILES_EXISTS");
        }
        void RecoverCommit(TransferRecord value) {
            string part = Part(value);
            if (File.Exists(part)) { value.State = "uploading"; Save(value); return; }
            string target = Path.Combine(Folder(value), SafeName(value.FinalName)); RejectLinks(target);
            Require(File.Exists(target) && new FileInfo(target).Length == value.Size, "FILES_INVALID_STATE");
            string key = Key(value.Owner, value.Id);
            if (hashing.Contains(key) || hashing.Count >= 2) return;
            hashing.Add(key); value.Verified = 0;
            var thread = new Thread(() => Verify(value, true)) { IsBackground = true, Name = "ClipRelay file commit recovery" };
            thread.Start();
        }
        void DeletePart(TransferRecord value) {
            string part = Part(value); RejectLinks(part);
            if (File.Exists(part)) File.Delete(part);
        }
        void Cleanup() {
            foreach (string path in Directory.EnumerateFiles(stateRoot, "*.json")) {
                if (File.GetLastWriteTimeUtc(path) >= DateTime.UtcNow.AddDays(-7)) continue;
                RejectLinks(path);
                if (new FileInfo(path).Length > 16384) continue;
                TransferRecord value;
                try { value = json.Deserialize<TransferRecord>(File.ReadAllText(path, Encoding.UTF8)); } catch (ArgumentException) { continue; }
                if (value != null && (value.State == "complete" || value.State == "cancelled")) {
                    if (value.State == "cancelled" && value.Direction == "upload") {
                        try { DeletePart(value); } catch (IOException) { continue; }
                    }
                    File.Delete(path); records.Remove(Key(value.Owner, value.Id));
                }
            }
        }
        public void Dispose() { lock (gate) { closed = true; } }
    }
}
