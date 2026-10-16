using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace ClipRelay.Remote {
    // The installed service carries these commands over its SYSTEM-only pipe.
    // Only the live helper can decide whether a request generation is current.
    internal static class LanPairingControl {
        static readonly Regex Token = new Regex("\\A[0-9a-f]{32}\\z");
        static readonly Regex Code = new Regex("\\A[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}\\z");
        static string Text(Dictionary<string, object> value, string key) {
            object raw; return value.TryGetValue(key, out raw) ? raw as string : null;
        }
        static bool Keys(Dictionary<string, object> value, params string[] keys) {
            if (value == null || value.Count != keys.Length) return false;
            foreach (string key in keys) if (!value.ContainsKey(key)) return false;
            return true;
        }
        static InvalidDataException Invalid() { return new InvalidDataException("无法确认当前配对请求，请刷新后重试。"); }
        internal static void ValidateCommand(Dictionary<string, object> command) {
            if (command == null) throw Invalid();
            string op = Text(command, "op");
            if ((op == "host-pair-list" || op == "host-pair-stop") && Keys(command, "op")) return;
            if ((op != "host-pair-approve" && op != "host-pair-reject") ||
                !Keys(command, "op", "id", "generation", "verification")) throw Invalid();
            foreach (string key in new[] { "id", "generation" }) {
                string token = Text(command, key);
                if (token == null || !Token.IsMatch(token)) throw Invalid();
            }
            string code = Text(command, "verification");
            if (code == null || !Code.IsMatch(code)) throw Invalid();
        }
        static Dictionary<string, object> Reply(object raw, bool list) {
            var value = raw as Dictionary<string, object>;
            object protocol, ok;
            if (value == null || !value.TryGetValue("protocol", out protocol) || !(protocol is int) || (int)protocol != 1 ||
                !value.TryGetValue("ok", out ok) || !(ok is bool)) throw Invalid();
            if (!(bool)ok) {
                if (!Keys(value, "protocol", "ok", "code")) throw Invalid();
                if (Text(value, "code") == "HOST_PAIR_STALE") throw new InvalidOperationException("配对请求已改变、取消或过期，请核对新的确认标识后重试。");
                if (Text(value, "code") == "HOST_PAIR_CLOSED") throw new InvalidOperationException("远控服务正在关闭，请稍后重试。");
                throw Invalid();
            }
            if (!(list ? Keys(value, "protocol", "ok", "requests") : Keys(value, "protocol", "ok"))) throw Invalid();
            return value;
        }
        internal static List<Dictionary<string, object>> List(Func<Dictionary<string, object>, object> request, long now) {
            var reply = Reply(request(new Dictionary<string, object> { { "op", "host-pair-list" } }), true);
            var entries = reply["requests"] as System.Collections.IList;
            if (entries == null || entries.Count > 8) throw Invalid();
            var result = new List<Dictionary<string, object>>(); var ids = new HashSet<string>();
            foreach (object raw in entries) {
                var entry = raw as Dictionary<string, object>;
                if (!Keys(entry, "id", "generation", "name", "verification", "expires", "state")) throw Invalid();
                string id = Text(entry, "id"), generation = Text(entry, "generation"), code = Text(entry, "verification");
                string name = Text(entry, "name"), state = Text(entry, "state");
                object expires = entry["expires"];
                if (id == null || !Token.IsMatch(id) || !ids.Add(id) || generation == null || !Token.IsMatch(generation) ||
                    code == null || !Code.IsMatch(code) || name == null || name.Length == 0 || Encoding.UTF8.GetByteCount(name) > 128 ||
                    name.IndexOfAny(new[] { '\r', '\n', '\0' }) >= 0 || (state != "waiting" && state != "approving") ||
                    (!(expires is int) && !(expires is long))) throw Invalid();
                long deadline = Convert.ToInt64(expires);
                if (deadline <= now) continue;
                if (deadline > now + 125) throw Invalid();
                result.Add(new Dictionary<string, object> { { "id", id }, { "generation", generation }, { "name", name },
                    { "verification", code }, { "address", code }, { "expires", deadline }, { "state", state }, { "automatic", true } });
            }
            return result;
        }
        internal static object Decide(Dictionary<string, object> input, bool approve, Func<Dictionary<string, object>, object> request) {
            if (!Keys(input, "action", "id", "generation", "verification") || Text(input, "action") != (approve ? "lanPairApprove" : "lanPairReject")) throw Invalid();
            var command = new Dictionary<string, object> { { "op", approve ? "host-pair-approve" : "host-pair-reject" },
                { "id", input["id"] }, { "generation", input["generation"] }, { "verification", input["verification"] } };
            ValidateCommand(command); Reply(request(command), false);
            return new { status = true };
        }
    }
}
