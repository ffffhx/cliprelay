using System;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using ClipRelay.Remote;

public static class SessionLockTests {
    sealed class Workstation : IWorkstationLock {
        public bool supported=true, available=true, accept=true;
        public long generation, locked;
        public int requests;
        public bool Supported { get { return supported; } }
        public bool Available { get { return available; } }
        public long Generation { get { return generation; } }
        public long LastLockGeneration { get { return locked; } }
        public bool RequestLock() { requests++;return accept; }
        public void Dispose() {}
    }
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    static readonly string A=new string('a',32), B=new string('b',32);
    static Dictionary<string,object> Call(SessionLockLease lease,string op,string id) {
        var q=new Dictionary<string,object>{{"op",op}};if(id!=null)q["lease"]=id;
        return Json.Deserialize<Dictionary<string,object>>(Json.Serialize(lease.Handle(q)));
    }
    static bool OK(Dictionary<string,object> value) {return (bool)value["ok"];}
    static string State(Dictionary<string,object> value) {return OK(value) ? (string)value["state"] : "error";}
    static void Assert(bool value,string text) {if(!value)throw new Exception(text);}
    public static int Main(string[] args) {
        if(args.Length==1 && args[0]=="--privacy-probe")return PrivacyScreenWorker.Run();
        try {
            int tests=0;long clock=0;var desktop=new Workstation();bool restored=false;
            using(var lease=new SessionLockLease(desktop,()=>clock,()=>{Assert(desktop.requests==0,"restore must precede locking");restored=true;})) {
                Assert(State(Call(lease,"arm",A))=="armed" && desktop.requests==0,"arming locked immediately");
                clock=15000;lease.Tick();Assert(State(Call(lease,"status",null))=="cancelled" && desktop.requests==0,"timeout locks");
                Assert(!OK(Call(lease,"commit",A)) && !OK(Call(lease,"renew",A)),"expired intent resurrected");tests++;
                Assert(State(Call(lease,"arm",B))=="armed","new arm");clock+=10000;Call(lease,"renew",B);clock+=10000;lease.Tick();
                Assert(State(Call(lease,"status",null))=="armed","renewal lost");Assert(!OK(Call(lease,"commit",A)),"foreign commit");
                Call(lease,"cancel",B);Assert(desktop.requests==0 && State(Call(lease,"status",null))=="off","cancel locks");tests++;
                Call(lease,"arm",A);desktop.generation++;lease.Tick();Assert(!OK(Call(lease,"commit",A)) && desktop.requests==0,"local session change ignored");tests++;
                Call(lease,"arm",B);desktop.available=false;lease.Tick();Assert(!OK(Call(lease,"commit",B)),"noninteractive lock");desktop.available=true;tests++;
                Call(lease,"arm",A);Assert(State(Call(lease,"commit",A))=="requested" && restored && desktop.requests==1,"lock request/order");
                Assert(State(Call(lease,"status",null))=="requested","BOOL incorrectly confirms lock");
                Assert(!OK(Call(lease,"cancel",A)),"cannot retract an accepted OS request");
                Call(lease,"commit",A);Assert(desktop.requests==1,"duplicate commit relocks");tests++;
                desktop.generation++;desktop.locked=desktop.generation;lease.Tick();Assert(State(Call(lease,"status",null))=="locked","WTS notification ignored");
                desktop.generation++;Call(lease,"commit",A);Assert(desktop.requests==1,"unlock followed by replay relocks");tests++;
            }
            Assert(desktop.requests==1,"dispose locks");
            desktop=new Workstation();
            using(var lease=new SessionLockLease(desktop,()=>clock,()=>{})) {
                Call(lease,"arm",A);Call(lease,"commit",A);clock+=5000;lease.Tick();
                Assert(State(Call(lease,"status",null))=="failed","no notification treated as success");Call(lease,"commit",A);Assert(desktop.requests==1,"timed-out commit retried");tests++;
                desktop.accept=false;Call(lease,"arm",B);Assert(State(Call(lease,"commit",B))=="failed","OS failure treated as success");tests++;
            }
            desktop=new Workstation();
            using(var lease=new SessionLockLease(desktop,()=>clock,()=>{throw new Exception("restoration failed");})) {
                Call(lease,"arm",A);Assert(State(Call(lease,"commit",A))=="failed" && desktop.requests==0,"lock despite restoration failure");tests++;
                desktop.supported=false;Assert(!OK(Call(lease,"arm",B)),"unsupported accepted");
                Assert(!OK(Call(lease,"arm","bad")) && !OK(Call(lease,"unknown",B)),"invalid input accepted");tests++;
            }
            Console.WriteLine("PASS session-lock: "+tests+" policy and notification scenarios (fake workstation; no real lock requested)");return 0;
        } catch(Exception e) {Console.Error.WriteLine(e);return 1;}
    }
}
