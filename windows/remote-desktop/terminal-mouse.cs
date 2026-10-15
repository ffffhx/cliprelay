using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Threading;

namespace ClipRelay.Remote {
    // Observes output, never client input. ESC and C1 controls can terminate
    // OSC/DCS/APC/PM/SOS; ordinary payload text cannot become a CSI command.
    public sealed class TerminalMouseModes {
        enum Parser { Ground,Escape,EscapeIntermediate,Csi,CsiIgnore,String }
        Parser parser;bool osc,csiPrivate;int utf8Left,utf8Value,utf8Minimum;
        readonly StringBuilder csi=new StringBuilder();
        readonly Dictionary<int,bool> saved=new Dictionary<int,bool>();
        public int Mode{get;private set;}public int Format{get;private set;}
        public long Epoch{get;private set;}public long Offset{get;private set;}public long ChangedAt{get;private set;}
        public TerminalMouseModes(){Epoch=1;}
        public bool Enabled{get{return Mode==9 || Mode==1000 || Mode==1002 || Mode==1003;}}
        public void Feed(byte[] bytes){foreach(byte b in bytes){
            Offset++;
            if(utf8Left>0){
                if(b>=0x80 && b<=0xbf){utf8Value=(utf8Value<<6)|(b&63);if(--utf8Left==0)Character(utf8Value>=utf8Minimum && utf8Value<=0x10ffff && (utf8Value<0xd800 || utf8Value>0xdfff)?utf8Value:0xfffd);continue;}
                utf8Left=0;Character(0xfffd);
            }
            if(b<0x80)Character(b);
            else if(b>=0xc2 && b<=0xdf){utf8Left=1;utf8Value=b&31;utf8Minimum=0x80;}
            else if(b>=0xe0 && b<=0xef){utf8Left=2;utf8Value=b&15;utf8Minimum=0x800;}
            else if(b>=0xf0 && b<=0xf4){utf8Left=3;utf8Value=b&7;utf8Minimum=0x10000;}
            else Character(0xfffd);
        }}
        void Change(int mode,int format,bool force=false){if(!force && Mode==mode && Format==format)return;Mode=mode;Format=format;Epoch++;ChangedAt=Offset;}
        public void InvalidateGrid(){Change(Mode,Format,true);}
        static bool Tracking(int value){return value==9 || value==1000 || value==1001 || value==1002 || value==1003;}
        static bool Encoding(int value){return value==1005 || value==1006 || value==1015 || value==1016;}
        void Private(int value,bool enabled){if(Tracking(value))Change(enabled?value:0,Format);else if(Encoding(value))Change(Mode,enabled?value:0);}
        void Dispatch(char final){
            string parameters=csi.ToString();
            if(!parameters.StartsWith("?",StringComparison.Ordinal) || (final!='h' && final!='l' && final!='s' && final!='r'))return;
            string[] fields=parameters.Substring(1).Split(';');if(fields.Length>32){if(final!='s')Change(-1,-1,true);return;}
            var numbers=new List<int>();foreach(string field in fields){int value=0;if(field.Length>5 || field.Length>0 && !Int32.TryParse(field,NumberStyles.None,CultureInfo.InvariantCulture,out value)){if(final!='s')Change(-1,-1,true);return;}numbers.Add(value);}
            foreach(int value in numbers){
                if(!Tracking(value) && !Encoding(value))continue;
                if(final=='s')saved[value]=Tracking(value)?Mode==value:Format==value;
                else if(final=='r'){bool enabled;if(saved.TryGetValue(value,out enabled))Private(value,enabled);}
                else Private(value,final=='h');
            }
        }
        void Character(int value){
            if(value==0x18 || value==0x1a){parser=Parser.Ground;csi.Clear();return;}
            if(value==27){parser=Parser.Escape;csi.Clear();return;}
            if(value==0x9b){parser=Parser.Csi;csi.Clear();csiPrivate=false;return;}
            if(value==0x90 || value==0x98 || value==0x9d || value==0x9e || value==0x9f){osc=value==0x9d;parser=Parser.String;return;}
            if(value==0x9c){parser=Parser.Ground;csi.Clear();return;}
            if(parser==Parser.String){if(osc && value==7)parser=Parser.Ground;return;}
            if(value<32 || value==127)return;
            if(value>=128){parser=Parser.Ground;csi.Clear();return;}
            if(parser==Parser.Ground)return;
            if(parser==Parser.Escape){
                if(value=='['){parser=Parser.Csi;csiPrivate=false;return;}
                if(value==']' || value=='P' || value=='X' || value=='^' || value=='_'){osc=value==']';parser=Parser.String;return;}
                if(value>=0x20 && value<=0x2f){parser=Parser.EscapeIntermediate;return;}
                if(value=='c'){Change(0,0,true);saved.Clear();}parser=Parser.Ground;return;
            }
            if(parser==Parser.EscapeIntermediate){if(value>=0x30 && value<=0x7e)parser=Parser.Ground;return;}
            if(value>=0x40 && value<=0x7e){if(parser==Parser.Csi)Dispatch((char)value);else if(csiPrivate && (value=='h' || value=='l' || value=='r'))Change(-1,-1,true);csi.Clear();parser=Parser.Ground;return;}
            if(parser==Parser.Csi){if(csi.Length==0)csiPrivate=value=='?';if(csi.Length>=256){csi.Clear();parser=Parser.CsiIgnore;}else csi.Append((char)value);}
        }
    }

    public sealed class TerminalMouseCommand {
        public string action;public long sequence,epoch,gesture;public int column,row,button,modifiers;
        public string Fingerprint(){return String.Join(":",new[]{action,epoch.ToString(CultureInfo.InvariantCulture),gesture.ToString(CultureInfo.InvariantCulture),column.ToString(CultureInfo.InvariantCulture),row.ToString(CultureInfo.InvariantCulture),button.ToString(CultureInfo.InvariantCulture),modifiers.ToString(CultureInfo.InvariantCulture)});}
    }
    public static class TerminalMouseEncoding {
        public static byte[] Encode(int mode,int format,string action,int button,int modifiers,int column,int row){
            TerminalManager.Require((mode==9 || mode==1000 || mode==1002 || mode==1003) && modifiers>=0 && modifiers<=28 && modifiers%4==0,"TERMINAL_MOUSE_MODE");
            TerminalManager.Require(column>=1 && row>=1 && column<=65535 && row<=65535,"TERMINAL_BAD_REQUEST");
            int code=button+modifiers;bool release=action=="release";
            if(action=="press" || release)TerminalManager.Require(button>=0 && button<=2,"TERMINAL_BAD_REQUEST");
            else if(action=="move"){TerminalManager.Require(button>=0 && button<=3 && (mode==1003 || mode==1002 && button!=3),"TERMINAL_MOUSE_MODE");code+=32;}
            else if(action=="wheel"){TerminalManager.Require(button>=0 && button<=3 && mode!=9,"TERMINAL_MOUSE_MODE");code+=64;}
            else throw new TerminalFault("TERMINAL_BAD_REQUEST");
            if(mode==9){TerminalManager.Require(action=="press","TERMINAL_MOUSE_MODE");code=button;}
            if(format==1006 || format==1016)return System.Text.Encoding.ASCII.GetBytes("\u001b[<"+code.ToString(CultureInfo.InvariantCulture)+";"+column.ToString(CultureInfo.InvariantCulture)+";"+row.ToString(CultureInfo.InvariantCulture)+(release?"m":"M"));
            if(release)code=3+modifiers;
            if(format==1015)return System.Text.Encoding.ASCII.GetBytes("\u001b["+(code+32).ToString(CultureInfo.InvariantCulture)+";"+column.ToString(CultureInfo.InvariantCulture)+";"+row.ToString(CultureInfo.InvariantCulture)+"M");
            TerminalManager.Require(format==0 || format==1005,"TERMINAL_MOUSE_MODE");
            TerminalManager.Require(column<=(format==0?223:2015) && row<=(format==0?223:2015),"TERMINAL_BAD_REQUEST");
            if(format==1005)return System.Text.Encoding.UTF8.GetBytes("\u001b[M"+(char)(code+32)+(char)(column+32)+(char)(row+32));
            return new byte[]{27,91,77,(byte)(code+32),(byte)(column+32),(byte)(row+32)};
        }
    }

    public sealed class TerminalMouseState {
        public int mode,format,buttons,remainingMs;
        public long epoch,offset,gesture,nextGesture,acceptedSequence,writtenSequence;
        public string phase,outcome;
    }
    public sealed class TerminalInputItem {
        public byte[] Bytes;public long Sequence,Epoch,Gesture,Expires;public bool Mouse,Cleanup;
        public string Action;public int Button,Modifiers,Column,Row;
    }
    // The native writer is the only consumer. Both cleanup and queued input are
    // ordered here; a client cannot extend a lease by replaying a receipt.
    public sealed class TerminalInputQueue {
        public const int LeaseMs=1500,StallMs=5000;
        public readonly object Gate=new object();
        readonly Func<long> now;readonly TerminalMouseModes modes=new TerminalMouseModes();
        readonly LinkedList<TerminalInputItem> pending=new LinkedList<TerminalInputItem>();
        int columns,rows,rawBytes,mouseCount,desiredButtons,writtenButtons;
        readonly int[] lastColumns=new int[3],lastRows=new int[3],lastModifiers=new int[3];
        long accepted,written,nextGesture=1,gesture,leaseEpoch,deadline,cleanupAt,inFlightAt;
        string fingerprint="",phase="idle",outcome="none";
        bool stopped,closedLease,cleanup,abort;TerminalInputItem inFlight;
        public long KeyboardWritten{get;private set;}
        public TerminalInputQueue(Func<long> now,int columns,int rows){this.now=now;this.columns=columns;this.rows=rows;}
        public void Observe(byte[] bytes,Action<byte[]> output){lock(Gate){if(!stopped){long epoch=modes.Epoch;modes.Feed(bytes);if(epoch!=modes.Epoch){Cancel("mode-changed",true);writtenButtons=0;cleanup=false;}}output(bytes);Monitor.PulseAll(Gate);}}
        public bool Queue(byte[] bytes,long sequence,bool paste){lock(Gate){
            if(stopped || abort || bytes.Length==0 || bytes.Length>(paste?16396:4096) || rawBytes+bytes.Length>32768)return false;
            pending.AddLast(new TerminalInputItem{Bytes=(byte[])bytes.Clone(),Sequence=sequence});rawBytes+=bytes.Length;Monitor.PulseAll(Gate);return true;
        }}
        void Reject(bool value,string code){TerminalManager.Require(value,code);}
        public void Mouse(TerminalMouseCommand command){lock(Gate){
            Tick();Reject(!stopped && !abort,"TERMINAL_CLOSED");Reject(command.sequence>0 && command.sequence<9007199254740992L,"TERMINAL_BAD_REQUEST");
            string digest=command.Fingerprint();
            if(command.sequence==accepted){Reject(fingerprint==digest,"TERMINAL_MOUSE_CONFLICT");return;}
            Reject(command.sequence==accepted+1,"TERMINAL_MOUSE_SEQUENCE");Reject(command.epoch==modes.Epoch,"TERMINAL_MOUSE_MODE");
            bool control=command.action=="renew" || command.action=="cancel";
            if(control){
                Reject(command.column==0 && command.row==0 && command.button==0 && command.modifiers==0,"TERMINAL_BAD_REQUEST");
                Reject(command.gesture>0 && command.gesture==gesture && !closedLease,"TERMINAL_MOUSE_GESTURE");
                if(command.action=="renew"){Reject(desiredButtons!=0,"TERMINAL_MOUSE_GESTURE");deadline=now()+LeaseMs;outcome="renewed";}
                else {Cancel("cancelled",false);outcome="cancelled";}
                accepted=command.sequence;fingerprint=digest;Monitor.PulseAll(Gate);return;
            }
            Reject(modes.Enabled,"TERMINAL_MOUSE_MODE");Reject(!cleanup,"TERMINAL_BUSY");
            Reject(command.column>=1 && command.row>=1 && (modes.Format==1016?command.column<=65535 && command.row<=65535:command.column<=columns && command.row<=rows),"TERMINAL_BAD_REQUEST");
            byte[] bytes=TerminalMouseEncoding.Encode(modes.Mode,modes.Format,command.action,command.button,command.modifiers,command.column,command.row);
            Reject(mouseCount<64,"TERMINAL_BUSY");
            bool noLease=modes.Mode==9 || command.action=="wheel" || command.action=="move" && command.button==3;
            if(noLease){Reject(command.gesture==0,"TERMINAL_MOUSE_GESTURE");if(command.action=="move")Reject(desiredButtons==0 && writtenButtons==0,"TERMINAL_MOUSE_GESTURE");}
            else if(command.action=="press"){
                Reject((desiredButtons & (1<<command.button))==0,"TERMINAL_MOUSE_GESTURE");
                if(closedLease || desiredButtons==0){
                    Reject(gesture==0 || closedLease,"TERMINAL_BUSY");
                    Reject(writtenButtons==0 && !(inFlight!=null && inFlight.Mouse && inFlight.Gesture!=0),"TERMINAL_BUSY");
                    Reject(command.gesture==nextGesture && nextGesture<9007199254740991L,"TERMINAL_MOUSE_GESTURE");gesture=nextGesture++;leaseEpoch=modes.Epoch;closedLease=false;phase="pending";
                } else Reject(command.gesture==gesture,"TERMINAL_MOUSE_GESTURE");
                desiredButtons|=1<<command.button;deadline=now()+LeaseMs;
            } else {
                Reject(!closedLease && command.gesture==gesture && (desiredButtons & (1<<command.button))!=0,"TERMINAL_MOUSE_GESTURE");
                if(command.action=="release")desiredButtons&=~(1<<command.button);deadline=now()+LeaseMs;
            }
            accepted=command.sequence;fingerprint=digest;outcome="queued";
            pending.AddLast(new TerminalInputItem{Bytes=bytes,Sequence=accepted,Mouse=true,Epoch=modes.Epoch,Gesture=noLease?0:gesture,Expires=now()+LeaseMs,Action=command.action,Button=command.button,Column=command.column,Row=command.row,Modifiers=command.modifiers});mouseCount++;Monitor.PulseAll(Gate);
        }}
        void Cancel(string reason,bool all){
            bool hadLease=!closedLease && gesture!=0 || writtenButtons!=0 || inFlight!=null && inFlight.Mouse && inFlight.Gesture!=0;
            for(var node=pending.First;node!=null;){var next=node.Next;var item=node.Value;if(item.Mouse && (all || item.Gesture==gesture && item.Gesture!=0)){if(item.Sequence==accepted)outcome=reason;pending.Remove(node);mouseCount--;}node=next;}
            desiredButtons=0;closedLease=true;
            if(hadLease){phase=reason;if(!all && (writtenButtons!=0 || inFlight!=null && inFlight.Mouse && inFlight.Gesture==gesture)){if(!cleanup)cleanupAt=now();cleanup=true;}}
            if(all){cleanup=false;writtenButtons=0;}
        }
        void Tick(){
            long time=now();if(!closedLease && gesture!=0 && time>=deadline)Cancel("expired",false);
            for(var node=pending.First;node!=null;){var next=node.Next;var item=node.Value;if(item.Mouse && item.Gesture==0 && time>=item.Expires){if(item.Sequence==accepted)outcome="expired";pending.Remove(node);mouseCount--;}node=next;}
            if(cleanup && time-cleanupAt>=StallMs || inFlight!=null && time-inFlightAt>=StallMs && (writtenButtons!=0 || inFlight.Mouse && inFlight.Gesture!=0))abort=true;
        }
        public bool AbortRequired{get{lock(Gate){Tick();return abort;}}}
        public TerminalMouseState State(){lock(Gate){Tick();return new TerminalMouseState{mode=modes.Mode,format=modes.Format,epoch=modes.Epoch,offset=modes.ChangedAt,gesture=gesture,nextGesture=nextGesture,buttons=writtenButtons,remainingMs=closedLease || gesture==0?0:(int)Math.Max(0,deadline-now()),acceptedSequence=accepted,writtenSequence=written,phase=phase,outcome=outcome};}}
        public TerminalInputItem Begin(){lock(Gate){
            Tick();if(stopped || abort || inFlight!=null)return null;
            TerminalInputItem item=null;
            if(cleanup){
                if(writtenButtons!=0 && leaseEpoch==modes.Epoch && modes.Enabled){
                    var bytes=new List<byte>();for(int button=0;button<3;button++)if((writtenButtons & (1<<button))!=0){int column=modes.Format==1016?lastColumns[button]:Math.Min(columns,lastColumns[button]),row=modes.Format==1016?lastRows[button]:Math.Min(rows,lastRows[button]);bytes.AddRange(TerminalMouseEncoding.Encode(modes.Mode,modes.Format,"release",button,lastModifiers[button],column,row));if(modes.Format!=1006 && modes.Format!=1016)break;}
                    item=new TerminalInputItem{Bytes=bytes.ToArray(),Mouse=true,Cleanup=true,Gesture=gesture,Epoch=modes.Epoch};
                }else cleanup=false;
            }
            if(item==null && pending.First!=null){item=pending.First.Value;pending.RemoveFirst();}
            if(item==null)return null;inFlight=item;inFlightAt=now();return item;
        }}
        public void Complete(TerminalInputItem item){lock(Gate){
            Reject(Object.ReferenceEquals(inFlight,item),"TERMINAL_UNAVAILABLE");inFlight=null;
            if(stopped){if(!item.Mouse)KeyboardWritten=item.Sequence;else if(!item.Cleanup)written=item.Sequence;Monitor.PulseAll(Gate);return;}
            if(!item.Mouse){rawBytes-=item.Bytes.Length;KeyboardWritten=item.Sequence;}
            else if(item.Cleanup){writtenButtons=0;cleanup=false;}
            else{
                mouseCount--;written=item.Sequence;if(item.Sequence==accepted)outcome="written";
                if(item.Gesture!=0 && item.Epoch==modes.Epoch){
                    if(item.Action=="press")writtenButtons|=1<<item.Button;else if(item.Action=="release")writtenButtons&=~(1<<item.Button);
                    lastColumns[item.Button]=item.Column;lastRows[item.Button]=item.Row;lastModifiers[item.Button]=item.Modifiers;
                    if(closedLease && writtenButtons!=0){if(!cleanup)cleanupAt=now();cleanup=true;}
                    else if(writtenButtons!=0)phase="held";
                    else if(desiredButtons==0){closedLease=true;phase="idle";}
                }
            }
            Tick();Monitor.PulseAll(Gate);
        }}
        public void Resize(int columns,int rows){lock(Gate){
            long previousEpoch=modes.Epoch;
            this.columns=columns;this.rows=rows;Cancel("cancelled",false);
            for(var node=pending.First;node!=null;){var next=node.Next;if(node.Value.Mouse){if(node.Value.Sequence==accepted)outcome="cancelled";pending.Remove(node);mouseCount--;}node=next;}
            modes.InvalidateGrid();leaseEpoch=modes.Epoch;
            // An already-started native write cannot be recalled. If it finishes
            // after resize, record its pressed buttons and clean them up first.
            if(inFlight!=null && inFlight.Mouse && inFlight.Gesture!=0 && inFlight.Epoch==previousEpoch)inFlight.Epoch=modes.Epoch;
            Monitor.PulseAll(Gate);
        }}
        public void Stop(){lock(Gate){stopped=true;pending.Clear();closedLease=true;desiredButtons=writtenButtons=0;cleanup=false;phase="closed";Monitor.PulseAll(Gate);}}
    }
}
