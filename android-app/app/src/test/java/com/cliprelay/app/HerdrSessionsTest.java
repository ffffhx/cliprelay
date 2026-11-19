package com.cliprelay.app;

import com.limelight.herdr.HerdrProtocol;
import com.limelight.herdr.HerdrSessions;
import org.json.JSONObject;
import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;

public class HerdrSessionsTest {
    private HerdrProtocol.Terminal terminal(String id,String agent,String state,long updated) throws Exception {
        return new HerdrProtocol.Terminal(new JSONObject().put("address",id).put("state","live").put("agent",agent)
            .put("title","手机连接排查 "+id).put("projectName","ClipRelay").put("agentName",agent)
            .put("updatedMs",updated).put("status",new JSONObject().put("state",state)));
    }
    @Test public void activeUnreadAndCompletedSessionsPrecedeIdleShellsAreHidden() throws Exception {
        var shell=terminal("shell","","",1000);var waiting=terminal("wait","claude","blocked",1);
        var working=terminal("work","codex","working",2);var newer=terminal("new","grok","working",3);
        var unread=terminal("unread","claude","done",1);var done=terminal("done","grok","done",50);var idle=terminal("idle","codex","idle",100);
        var sorted=HerdrSessions.select(Arrays.asList(shell,idle,done,unread,working,newer,waiting),Set.of("unread"),"all","");
        assertEquals(Arrays.asList(waiting,newer,working,unread,done,idle),sorted);
        assertFalse(HerdrSessions.isAgent(terminal("ps","powershell.exe","idle",100)));
    }
    @Test public void filtersAndSearchUseTaskTitleAndDoNotInventCompletion() throws Exception {
        var work=terminal("t2","codex","working",2);var done=terminal("t3","grok","done",1);var idle=terminal("t4","claude","idle",3);
        var all=Arrays.asList(work,done,idle);
        assertEquals(List.of(done),HerdrSessions.select(all,Set.of("t3"),"unread","连接排查"));
        assertEquals(List.of(done),HerdrSessions.select(all,Set.of(),"done",""));
        assertEquals(List.of(work),HerdrSessions.select(all,Set.of(),"working","t2"));
        assertEquals(List.of(idle),HerdrSessions.select(all,Set.of(),"all","CLAUDE"));
    }
}
