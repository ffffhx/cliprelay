using System;
using System.Collections.Generic;
using System.IO;
using System.Management;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

namespace ClipRelay.Remote {
    public sealed class WakeAddress { public string address; public int prefix; }
    public sealed class WakeAdapter {
        public string id,name,kind,mac,magicPacket,powerManagement,wakeArmed,configuration;
        public bool connected;
        public WakeAddress[] addresses;
    }
    public sealed class WakeInventory {
        public bool ok,supported;
        public string code="",platform="windows";
        public WakeAdapter[] adapters=new WakeAdapter[0];
        // Driver/OS settings are evidence, not a successful hardware wake test.
        public bool wakeVerified=false;
    }
    public static class WakeDiscovery {
        [DllImport("powrprof.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.U1)] static extern bool DevicePowerOpen(uint flags);
        [DllImport("powrprof.dll")] [return:MarshalAs(UnmanagedType.U1)] static extern bool DevicePowerClose();
        [DllImport("powrprof.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.U1)] static extern bool DevicePowerEnumDevices(uint index,uint interpretation,uint query,IntPtr output,ref uint size);
        const uint HardwareId=0x80000000,Present=0x20000000,WakeEnabled=0x08000000;

        public static string Setting(object raw) {
            if(raw==null)return "unknown";
            try {switch(Convert.ToUInt32(raw)){case 0:return "unsupported";case 1:return "disabled";case 2:return "enabled";}}catch{}
            return "unknown";
        }
        public static string Configuration(string power,string magic,string armed) {
            // The CIM provider defines the other settings only when adapter
            // power management is enabled. Modern-standby Wi-Fi can otherwise
            // report contradictory values; keep that case explicitly unknown.
            if(power!="enabled")return power=="disabled"?"disabled":"unknown";
            if(magic=="unsupported")return "unsupported";
            if(magic=="disabled" || armed=="disabled")return "disabled";
            return magic=="enabled" && armed=="enabled"?"configured":"unknown";
        }
        public static string CanonicalMac(byte[] bytes) {
            if(bytes==null || bytes.Length!=6 || (bytes[0]&1)!=0)return "";
            bool zero=true;foreach(byte b in bytes)if(b!=0)zero=false;
            return zero?"":BitConverter.ToString(bytes).Replace('-',':');
        }
        public static int Prefix(byte[] bytes) {
            if(bytes==null || bytes.Length!=4)return -1;
            int count=0;bool zero=false;
            foreach(byte b in bytes)for(int bit=7;bit>=0;bit--) {
                bool one=(b&(1<<bit))!=0;if(one && zero)return -1;if(one)count++;else zero=true;
            }
            return count;
        }
        static string GuidKey(object raw) {Guid id;return raw!=null && Guid.TryParse(Convert.ToString(raw),out id)?id.ToString("D"):"";}
        static string Text(ManagementBaseObject item,string name) {return Convert.ToString(item[name])??"";}
        static string Bounded(string value,int limit) {return value.Length<=limit?value:value.Substring(0,limit);}

        // Return native device identities rather than localized display text.
        public static string[] ArmedDevices() {
            if(!DevicePowerOpen(0))throw new IOException("WAKE_POWER_UNAVAILABLE");
            IntPtr buffer=Marshal.AllocHGlobal(16384);
            try {
                var values=new List<string>();
                for(uint index=0;index<1024;index++) {
                    uint length=16384;
                    if(!DevicePowerEnumDevices(index,HardwareId|Present|WakeEnabled,0,buffer,ref length)) {
                        if(length>16384)throw new IOException("WAKE_POWER_UNAVAILABLE");
                        return values.ToArray();
                    }
                    if(length<2 || length>16384 || (length&1)!=0)throw new IOException("WAKE_POWER_UNAVAILABLE");
                    byte[] bytes=new byte[length];Marshal.Copy(buffer,bytes,0,bytes.Length);
                    int end=0;while(end+1<bytes.Length && (bytes[end]!=0 || bytes[end+1]!=0))end+=2;
                    if(end==0 || end+1>=bytes.Length || end>8192)throw new IOException("WAKE_POWER_UNAVAILABLE");
                    // Successful calls may leave size at buffer capacity; only
                    // the bounded, terminated string belongs to this result.
                    string value=Encoding.Unicode.GetString(bytes,0,end);
                    values.Add(value);
                }
                throw new IOException("WAKE_POWER_UNAVAILABLE");
            } finally {Marshal.FreeHGlobal(buffer);DevicePowerClose();}
        }
        public static string ArmedState(string pnp,string[] knownPhysical,string[] armed) {
            if(armed==null || String.IsNullOrEmpty(pnp))return "unknown";
            foreach(string entry in armed) {
                if(String.Equals(entry,pnp,StringComparison.OrdinalIgnoreCase))return "enabled";
                // Some providers return a hardware ID shared by several device
                // instances. Never attribute one instance's setting to another.
                if(pnp.StartsWith(entry+"\\",StringComparison.OrdinalIgnoreCase)) {
                    int matches=0;foreach(var device in knownPhysical)if(device.StartsWith(entry+"\\",StringComparison.OrdinalIgnoreCase))matches++;
                    return matches==1?"enabled":"unknown";
                }
            }
            return "disabled";
        }
        public static WakeInventory Read() {
            var hardware=new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            var power=new Dictionary<string,string[]>(StringComparer.OrdinalIgnoreCase);
            var options=new EnumerationOptions {ReturnImmediately=false,Timeout=TimeSpan.FromSeconds(3)};
            // Win32_NetworkAdapter.PhysicalAdapter also marks some VPN drivers
            // physical. Use the modern hardware/virtual flags as the authority.
            using(var query=new ManagementObjectSearcher(new ManagementScope("root\\StandardCimv2"),
                new ObjectQuery("SELECT InterfaceGuid,PNPDeviceID,HardwareInterface,Virtual FROM MSFT_NetAdapter"),options))
            using(var values=query.Get())foreach(ManagementObject value in values)using(value) {
                if(!Object.Equals(value["HardwareInterface"],true) || !Object.Equals(value["Virtual"],false))continue;
                string id=GuidKey(value["InterfaceGuid"]);if(id=="" || hardware.ContainsKey(id) || hardware.Count>=32)throw new IOException("WAKE_INVALID_INVENTORY");
                hardware.Add(id,Text(value,"PNPDeviceID"));
            }
            try {
                using(var query=new ManagementObjectSearcher(new ManagementScope("root\\StandardCimv2"),
                    new ObjectQuery("SELECT InstanceID,AllowComputerToTurnOffDevice,WakeOnMagicPacket FROM MSFT_NetAdapterPowerManagementSettingData"),options))
                using(var values=query.Get())foreach(ManagementObject value in values)using(value) {
                    string id=GuidKey(value["InstanceID"]);if(id!="" && hardware.ContainsKey(id))power[id]=new[]{Setting(value["AllowComputerToTurnOffDevice"]),Setting(value["WakeOnMagicPacket"])};
                }
            } catch {power.Clear();}
            string[] armed=null;try{armed=ArmedDevices();}catch{}
            var known=new List<string>(hardware.Values).ToArray();
            var result=new List<WakeAdapter>();
            foreach(var network in NetworkInterface.GetAllNetworkInterfaces()) {
                string id=GuidKey(network.Id),pnp;
                if(!hardware.TryGetValue(id,out pnp))continue;
                int type=(int)network.NetworkInterfaceType;
                if(type!=6 && type!=71 && type!=62 && type!=69 && type!=117)continue;
                string mac=CanonicalMac(network.GetPhysicalAddress().GetAddressBytes());if(mac=="")continue;
                var addresses=new List<WakeAddress>();
                foreach(var unicast in network.GetIPProperties().UnicastAddresses) {
                    if(unicast.Address.AddressFamily!=AddressFamily.InterNetwork || unicast.IPv4Mask==null)continue;
                    int prefix=Prefix(unicast.IPv4Mask.GetAddressBytes());
                    if(prefix<1 || prefix>32 || addresses.Count>=8)continue;
                    addresses.Add(new WakeAddress {address=unicast.Address.ToString(),prefix=prefix});
                }
                string[] settings;if(!power.TryGetValue(id,out settings))settings=new[]{"unknown","unknown"};
                string wake=ArmedState(pnp,known,armed);
                result.Add(new WakeAdapter {id=id,name=Bounded(network.Name,128),kind=type==71?"wifi":"ethernet",mac=mac,
                    connected=network.OperationalStatus==OperationalStatus.Up,addresses=addresses.ToArray(),
                    powerManagement=settings[0],magicPacket=settings[1],wakeArmed=wake,configuration=Configuration(settings[0],settings[1],wake)});
            }
            return new WakeInventory {ok=true,supported=true,adapters=result.ToArray()};
        }
    }
    public static class WakeProbe {
        // Runs without a desktop-user token so an online helper can also work
        // at the lock screen. This path only reads settings; it never enables
        // hardware, restarts a network adapter, or sends a packet itself.
        public static int Run() {
            Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false);
            var json=new JavaScriptSerializer {MaxJsonLength=65536,RecursionLimit=8};
            while(true) {
                var line=new StringBuilder();int c;
                while((c=Console.Read())!=-1 && c!='\n') {if(line.Length>=128)return 2;line.Append((char)c);}
                if(c==-1)return 0;
                if(line.ToString()!="wake-status")return 2;
                WakeInventory result;
                try{result=WakeDiscovery.Read();}catch{result=new WakeInventory {code="WAKE_UNAVAILABLE"};}
                Console.WriteLine(json.Serialize(result));Console.Out.Flush();
            }
        }
    }
}
