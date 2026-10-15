using System;
using System.Web.Script.Serialization;
using ClipRelay.Remote;

public static class WakeTests {
    static void Assert(bool value,string reason){if(!value)throw new Exception(reason);}
    public static int Main(string[] args) {
        Console.OutputEncoding=new System.Text.UTF8Encoding(false);
        try {
            if(args.Length==1 && args[0]=="--wake-probe")return WakeProbe.Run();
            if(args.Length==1 && args[0]=="--native") {Console.WriteLine(new JavaScriptSerializer().Serialize(WakeDiscovery.Read()));return 0;}
            if(args.Length==1 && args[0]=="--power-ids") {Console.WriteLine(new JavaScriptSerializer().Serialize(WakeDiscovery.ArmedDevices()));return 0;}
            Assert(WakeDiscovery.Setting((uint)0)=="unsupported" && WakeDiscovery.Setting((uint)1)=="disabled" && WakeDiscovery.Setting((uint)2)=="enabled","CIM enum");
            Assert(WakeDiscovery.Setting(null)=="unknown" && WakeDiscovery.Setting((uint)3)=="unknown","unknown enum");
            Assert(WakeDiscovery.Configuration("enabled","enabled","enabled")=="configured","ready settings");
            Assert(WakeDiscovery.Configuration("unsupported","enabled","disabled")=="unknown","contradictory modern standby must not claim configured or unsupported");
            Assert(WakeDiscovery.Configuration("enabled","unsupported","disabled")=="unsupported","unsupported magic packet");
            Assert(WakeDiscovery.Configuration("enabled","enabled","disabled")=="disabled","OS wake disabled");
            Assert(WakeDiscovery.Configuration("enabled","enabled","unknown")=="unknown","missing OS evidence");
            Assert(WakeDiscovery.Prefix(new byte[]{255,255,255,0})==24 && WakeDiscovery.Prefix(new byte[]{255,0,255,0})==-1,"mask validation");
            Assert(WakeDiscovery.CanonicalMac(new byte[]{2,17,34,51,68,85})=="02:11:22:33:44:55","local unicast MAC");
            Assert(WakeDiscovery.CanonicalMac(new byte[6])=="" && WakeDiscovery.CanonicalMac(new byte[]{1,0,0,0,0,0})=="","zero or multicast MAC");
            string first="PCI\\ADAPTER\\A",second="PCI\\ADAPTER\\B";
            Assert(WakeDiscovery.ArmedState(first,new[]{first,second},new[]{first})=="enabled","exact identity");
            Assert(WakeDiscovery.ArmedState(second,new[]{first,second},new[]{first})=="disabled","unrelated identity");
            Assert(WakeDiscovery.ArmedState(first,new[]{first,second},new[]{"PCI\\ADAPTER"})=="unknown","ambiguous hardware identity");
            Assert(WakeDiscovery.ArmedState(first,new[]{first},new[]{"PCI\\ADAPTER"})=="enabled","unique hardware identity");
            Assert(WakeDiscovery.ArmedState(first,new[]{first},null)=="unknown","failed power query");
            Console.WriteLine("PASS wake discovery: 15 state, identity and address checks; no hardware settings changed");return 0;
        } catch(Exception error){Console.Error.WriteLine(error);return 1;}
    }
}
