using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace ClipRelay.Remote {
    // Caller serializes this policy with engine stop/start and supplies a bounded
    // pinned loopback transport. Decisions belong to the currently running engine.
    internal static class HostClientsControl {
        static readonly Regex View = new Regex("\\A[0-9a-f]{32}\\z");
        static readonly Regex Uuid = new Regex("\\A[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\\z");
        static string Text(Dictionary<string,object> value,string key) {
            object raw;return value.TryGetValue(key,out raw)?raw as string:null;
        }
        static bool Keys(Dictionary<string,object> value,params string[] keys) {
            if(value==null || value.Count!=keys.Length)return false;
            foreach(string key in keys)if(!value.ContainsKey(key))return false;return true;
        }
        static Exception Invalid() { return new InvalidDataException("无法确认设备授权状态，请刷新后重试。"); }
        static Dictionary<string,object> Reply(object raw,bool list) {
            var value=raw as Dictionary<string,object>;object status;
            if(!Keys(value,list?new[]{"status","named_certs"}:new[]{"status"}) ||
                !value.TryGetValue("status",out status) || !(status is bool))throw Invalid();
            if(!(bool)status)throw Invalid();return value;
        }
        internal static List<Dictionary<string,object>> Read(Func<string,string,object,object> request) {
            var reply=Reply(request("GET","/api/clients/list",null),true);
            var entries=reply["named_certs"] as IList;
            if(entries==null || entries.Count>128)throw Invalid();
            var result=new List<Dictionary<string,object>>();var ids=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach(object raw in entries) {
                var entry=raw as Dictionary<string,object>;
                if(!Keys(entry,"uuid","name","enabled"))throw Invalid();
                string uuid=Text(entry,"uuid"),name=Text(entry,"name");
                if(uuid==null || !Uuid.IsMatch(uuid) || !ids.Add(uuid) || name==null || Encoding.UTF8.GetByteCount(name)>128 ||
                    name.IndexOfAny(new[]{'\r','\n','\0'})>=0 || !(entry["enabled"] is bool))throw Invalid();
                result.Add(new Dictionary<string,object>{{"uuid",uuid},{"name",name},{"enabled",entry["enabled"]}});
            }
            return result;
        }
        internal static object Snapshot(string viewId,Func<string,string,object,object> request) {
            if(viewId==null || !View.IsMatch(viewId))throw Invalid();
            return new {status=true,viewId=viewId,named_certs=Read(request)};
        }
        static Dictionary<string,object> Find(List<Dictionary<string,object>> devices,string uuid) {
            return devices.Find(value=>String.Equals((string)value["uuid"],uuid,StringComparison.OrdinalIgnoreCase));
        }
        internal static object Revoke(Dictionary<string,object> input,string currentView,Func<string,string,object,object> request) {
            if(!Keys(input,"action","uuid","viewId") || Text(input,"action")!="unpair")throw Invalid();
            string uuid=Text(input,"uuid"),view=Text(input,"viewId");
            if(uuid==null || !Uuid.IsMatch(uuid) || view==null || !View.IsMatch(view))throw Invalid();
            if(view!=currentView)throw new InvalidOperationException("远控服务已重新启动，请刷新设备列表后重试。");
            var device=Find(Read(request),uuid);
            if(device==null)throw new InvalidOperationException("设备授权已改变，请刷新设备列表后重试。");
            try {
                if(device!=null) {
                    // Use the native list's exact UUID representation. Disabling
                    // also terminates streams; unpair alone does not guarantee it.
                    uuid=(string)device["uuid"];
                    Reply(request("POST","/api/clients/update",new Dictionary<string,object>{{"uuid",uuid},{"enabled",false}}),false);
                    device=Find(Read(request),uuid);
                    if(device!=null && (bool)device["enabled"])throw Invalid();
                    if(device!=null) {
                        Reply(request("POST","/api/clients/unpair",new Dictionary<string,object>{{"uuid",uuid}}),false);
                        if(Find(Read(request),uuid)!=null)throw Invalid();
                    }
                }
            } catch {
                // A read may confirm a lost removal reply. Never repeat either
                // mutation or restore a partially disabled client's permission.
                try {if(Find(Read(request),uuid)==null)return new {status=true};}catch { }
                throw new InvalidOperationException("撤销结果尚未确认，请刷新设备列表后重试；已停用的设备不会自动恢复授权。");
            }
            return new {status=true};
        }
    }
}
