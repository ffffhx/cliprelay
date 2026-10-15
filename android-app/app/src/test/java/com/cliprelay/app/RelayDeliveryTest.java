package com.cliprelay.app;

import com.limelight.nvstream.RelayDelivery;
import org.json.JSONObject;
import org.junit.Test;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import static org.junit.Assert.*;

public class RelayDeliveryTest {
    private static final String ID = "1234567890abcdef1234567890abcdef";
    private static class Journal implements RelayDelivery.Receipts {
        final Map<String,String> values = new HashMap<>(); boolean failApplied, failPending;
        public String state(String id,String hash) { String value=values.get(id); return value==null?"":value.equals(hash+":applied")?"applied":"pending"; }
        public void save(String id,String hash,String state) throws Exception {
            if(failPending&&state.equals("pending"))throw new IOException("disk full");
            if(failApplied&&state.equals("applied"))throw new IOException("disk full");values.put(id,hash+":"+state);
        }
    }
    private static class Channel implements RelayDelivery.Transport {
        final byte[] bytes; final JSONObject meta; int reads,acks,rejects; boolean dropAck;
        Channel(String raw) throws Exception {
            bytes=raw.getBytes(StandardCharsets.UTF_8);
            meta=new JSONObject().put("ok",true).put("state","queued").put("id",ID).put("kind","json").put("size",bytes.length).put("sha256",RelayDelivery.sha256(bytes));
        }
        public JSONObject request(JSONObject request) throws Exception {
            assertEquals(ID,request.getString("id"));String op=request.getString("op");
            if(op.equals("read")) {
                int offset=request.getInt("offset"),end=Math.min(bytes.length,offset+262144);reads++;
                return new JSONObject().put("ok",true).put("id",ID).put("offset",offset).put("data",Base64.getEncoder().encodeToString(java.util.Arrays.copyOfRange(bytes,offset,end)));
            }
            if(op.equals("ack")) {acks++;assertEquals(meta.getString("sha256"),request.getString("sha256"));if(dropAck)throw new IOException("lost ack reply");}
            else if(op.equals("reject"))rejects++;else fail("Unexpected operation");
            return new JSONObject().put("ok",true).put("id",ID).put("state",op.equals("ack")?"delivered":"rejected");
        }
    }
    @Test public void lostReceiptDoesNotReplayClipboardAndHistory() throws Exception {
        String text="中文 👩‍💻\n".repeat(40000);Channel channel=new Channel(new JSONObject().put("text",text).toString());
        Journal journal=new Journal();int[] applied={0};channel.dropAck=true;
        try{RelayDelivery.receive(channel.meta,channel,journal,(kind,bytes,value)->{assertEquals(text,value);applied[0]++;},()->true);fail();}catch(IOException expected){}
        assertEquals(1,applied[0]);assertTrue(channel.reads>1);int reads=channel.reads;
        channel.dropAck=false;
        RelayDelivery.receive(channel.meta,channel,journal,(kind,bytes,value)->fail("old message overwrote newer clipboard"),()->true);
        assertEquals(2,channel.acks);assertEquals(reads,channel.reads);
    }
    @Test public void uncertainCommitIsRejectedWithoutSecondApplication() throws Exception {
        Channel channel=new Channel("{\"text\":\"fixture\"}");Journal journal=new Journal();journal.failApplied=true;int[] applied={0};
        try{RelayDelivery.receive(channel.meta,channel,journal,(kind,bytes,value)->applied[0]++,()->true);fail();}catch(IOException expected){}
        assertEquals(1,applied[0]);assertEquals(0,channel.acks);assertEquals(1,channel.rejects);
        journal.failApplied=false;
        RelayDelivery.receive(channel.meta,channel,journal,(kind,bytes,value)->fail(),()->true);
        assertEquals(2,channel.rejects);assertEquals(0,channel.acks);
    }
    @Test public void digestMismatchAndIdentityReuseNeverReachClipboard() throws Exception {
        Channel channel=new Channel("{\"text\":\"fixture\"}");Journal journal=new Journal();
        channel.meta.put("sha256","a".repeat(64));
        try{RelayDelivery.receive(channel.meta,channel,journal,(kind,bytes,value)->fail(),()->true);fail();}catch(IOException expected){}
        assertEquals(1,channel.rejects);assertEquals(0,channel.acks);assertTrue(journal.values.isEmpty());
        journal.values.put(ID,"different-hash:applied");
        RelayDelivery.receive(channel.meta,channel,journal,(kind,bytes,value)->fail(),()->true);
        assertEquals(2,channel.rejects);assertEquals(1,channel.reads);
    }
    @Test public void probesDoNotMutateClipboardOrReceiptStore() throws Exception {
        Channel channel=new Channel("{\"text\":\"connectivity test\",\"probe\":true}");Journal journal=new Journal();
        RelayDelivery.receive(channel.meta,channel,journal,(kind,bytes,value)->fail(),()->true);
        assertEquals(1,channel.acks);assertTrue(journal.values.isEmpty());
    }
    @Test public void journalWriteFailureCannotApplyOrAcknowledge() throws Exception {
        Channel channel=new Channel("{\"text\":\"fixture\"}");Journal journal=new Journal();journal.failPending=true;
        try{RelayDelivery.receive(channel.meta,channel,journal,(kind,bytes,value)->fail(),()->true);fail();}catch(IOException expected){}
        assertEquals(1,channel.rejects);assertEquals(0,channel.acks);assertTrue(journal.values.isEmpty());
    }
    @Test public void cancellationAndMalformedMessagesCannotBeAcknowledged() throws Exception {
        Channel channel=new Channel("{\"text\":\"fixture\"}");Journal journal=new Journal();
        try{RelayDelivery.receive(channel.meta,channel,journal,(kind,bytes,value)->fail(),()->false);fail();}catch(InterruptedException expected){}
        assertEquals(0,channel.reads);assertEquals(0,channel.acks);
        channel.meta.put("size",26*1024*1024);
        try{RelayDelivery.receive(channel.meta,channel,journal,(kind,bytes,value)->fail(),()->true);fail();}catch(IOException expected){}
        assertEquals(0,channel.reads);
        for(String invalid:new String[]{"{\"text\":\"\"}","{\"text\":\"x\\u0000\"}","{\"text\":\"x\",\"probe\":1}","{\"text\":\"x\",\"extra\":true}"}){
            Channel bad=new Channel(invalid);
            try{RelayDelivery.receive(bad.meta,bad,journal,(kind,bytes,value)->fail(),()->true);fail();}catch(Exception expected){}
            assertEquals(1,bad.rejects);assertEquals(0,bad.acks);
        }
    }
}
