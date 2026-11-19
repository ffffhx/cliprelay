package com.cliprelay.app;

import com.limelight.herdr.*;
import org.json.*;
import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;

public class HerdrNotificationsTest {
    private HerdrProtocol.Terminal terminal(String state,long turn)throws Exception{
        return new HerdrProtocol.Terminal(new JSONObject().put("address","t1").put("state","live").put("agent","codex")
            .put("projectName","项目").put("name","任务").put("agentName","Codex").put("turn",turn).put("status",new JSONObject().put("state",state)));
    }
    @Test public void firstConnectionNeverAnnouncesHistoricalCompletion()throws Exception{
        HerdrEventLedger ledger=new HerdrEventLedger();assertTrue(ledger.observe("core",List.of(terminal("done",14)),1).isEmpty());assertEquals(0,ledger.unread());
    }
    @Test public void completionIsPersistedAndNeverReplayedOnReconnect()throws Exception{
        HerdrEventLedger ledger=new HerdrEventLedger();ledger.observe("core",List.of(terminal("working",14)),1);
        assertEquals("done",ledger.observe("core",List.of(terminal("idle",15)),2).get(0).getString("kind"));
        ledger=new HerdrEventLedger(new JSONObject(ledger.json().toString()));assertTrue(ledger.observe("core",List.of(terminal("idle",15)),3).isEmpty());
        assertEquals(1,ledger.unread());ledger.read("t1");assertEquals(0,ledger.unread());
    }
    @Test public void shortTurnBetweenPollsStillProducesOneCompletion()throws Exception{
        HerdrEventLedger ledger=new HerdrEventLedger();ledger.observe("core",List.of(terminal("idle",1)),1);
        assertEquals(1,ledger.observe("core",List.of(terminal("idle",2)),2).size());
    }
    @Test public void waitingAndErrorsAreDifferentFromCompletion()throws Exception{
        HerdrEventLedger ledger=new HerdrEventLedger();ledger.observe("core",List.of(terminal("working",1)),1);
        assertEquals("blocked",ledger.observe("core",List.of(terminal("blocked",2)),2).get(0).getString("kind"));
        assertTrue(ledger.observe("core",List.of(terminal("blocked",2)),3).isEmpty());
        assertEquals("error",ledger.observe("core",List.of(terminal("error",2)),4).get(0).getString("kind"));
    }
    @Test public void missingStatusAndCoreReplacementNeverInventCompletion()throws Exception{
        HerdrEventLedger ledger=new HerdrEventLedger();ledger.observe("core",List.of(terminal("working",1)),1);
        assertTrue(ledger.observe("core",List.of(terminal("",1)),2).isEmpty());
        assertTrue(ledger.observe("new-core",List.of(terminal("done",8)),3).isEmpty());
    }
}
