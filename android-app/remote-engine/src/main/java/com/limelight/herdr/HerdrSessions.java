package com.limelight.herdr;

import java.util.*;

/** Presentation order is based on current Agent facts, never a shell's old title. */
public final class HerdrSessions {
    private HerdrSessions() {}
    public static boolean isAgent(HerdrProtocol.Terminal terminal) {
        return !terminal.agent.isEmpty()&&!terminal.agent.matches("(?i)(powershell|pwsh|cmd|bash|zsh|sh|fish|nu|node|python|terminal)(\\.exe)?");
    }
    public static int priority(HerdrProtocol.Terminal terminal,Set<String> unread) {
        if(terminal.status.equals("blocked")||terminal.status.equals("error"))return 0;
        if(terminal.status.equals("working"))return 1;
        if(unread.contains(terminal.address))return 2;
        if(terminal.status.equals("done"))return 3;
        return terminal.state.equals("live")?4:5;
    }
    public static List<HerdrProtocol.Terminal> select(List<HerdrProtocol.Terminal> terminals,Set<String> unread,String filter,String query) {
        List<HerdrProtocol.Terminal> result=new ArrayList<>();String needle=query.trim().toLowerCase(Locale.ROOT);
        for(HerdrProtocol.Terminal t:terminals) {
            if(!isAgent(t))continue;
            if(!filter.equals("all")&&!(filter.equals("unread")?unread.contains(t.address):filter.equals(t.status)))continue;
            if(!needle.isEmpty()&&!(t.projectLabel()+" "+t.label()+" "+t.agentName+" "+t.address).toLowerCase(Locale.ROOT).contains(needle))continue;
            result.add(t);
        }
        result.sort(Comparator.comparingInt((HerdrProtocol.Terminal t)->priority(t,unread))
            .thenComparing(Comparator.comparingLong((HerdrProtocol.Terminal t)->t.updatedMs).reversed())
            .thenComparing(t->t.address));
        return result;
    }
}
