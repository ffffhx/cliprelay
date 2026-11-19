package com.limelight.herdr;

import org.json.*;
import java.util.*;

/** Durable edge detection. Silence and a lost network connection are never completion. */
public final class HerdrEventLedger {
    private String coreId="";
    private JSONObject previous=new JSONObject();
    private JSONArray inbox=new JSONArray();
    public HerdrEventLedger(){}
    public HerdrEventLedger(JSONObject saved){coreId=saved.optString("coreId");previous=saved.optJSONObject("previous");if(previous==null)previous=new JSONObject();inbox=saved.optJSONArray("inbox");if(inbox==null)inbox=new JSONArray();}
    public JSONObject json() throws JSONException{return new JSONObject().put("coreId",coreId).put("previous",previous).put("inbox",inbox);}
    public List<JSONObject> observe(String identity,List<HerdrProtocol.Terminal> terminals,long now) throws JSONException {
        List<JSONObject> events=new ArrayList<>();
        boolean reset=!coreId.equals(identity)||identity.isEmpty();if(reset)previous=new JSONObject();coreId=identity;
        JSONObject next=new JSONObject();
        for(HerdrProtocol.Terminal t:terminals){
            JSONObject old=previous.optJSONObject(t.address);
            next.put(t.address,new JSONObject().put("turn",t.turn).put("state",t.status));
            if(old==null||t.agent.isEmpty()||t.turn<old.optLong("turn"))continue;
            String before=old.optString("state"),kind="";
            if((t.status.equals("done")||t.status.equals("idle"))&&(before.equals("working")||t.turn>old.optLong("turn")))kind="done";
            else if(t.status.equals("blocked")&&(!before.equals("blocked")||t.turn>old.optLong("turn")))kind="blocked";
            else if(t.status.equals("error")&&(!before.equals("error")||t.turn>old.optLong("turn")))kind="error";
            if(kind.isEmpty())continue;
            String id=coreId+":"+t.address+":"+t.turn+":"+kind;
            boolean exists=false;for(int i=0;i<inbox.length();i++)if(id.equals(inbox.getJSONObject(i).optString("id")))exists=true;
            if(exists)continue;
            JSONObject event=new JSONObject().put("id",id).put("coreId",coreId).put("terminal",t.address).put("project",t.projectLabel()).put("title",t.label())
                .put("agent",t.agentName).put("kind",kind).put("time",now).put("read",false);
            inbox.put(event);events.add(event);
        }
        previous=next;while(inbox.length()>100)inbox.remove(0);return events;
    }
    public List<JSONObject> events(){List<JSONObject> result=new ArrayList<>();for(int i=inbox.length()-1;i>=0;i--)result.add(inbox.optJSONObject(i));return result;}
    public int unread(){int n=0;for(JSONObject e:events())if(!e.optBoolean("read"))n++;return n;}
    public void read(String terminal) throws JSONException{for(JSONObject e:events())if(terminal==null||terminal.equals(e.optString("terminal")))e.put("read",true);}
    public static String label(String kind){return kind.equals("done")?"已完成":kind.equals("blocked")?"等待你处理":"出现错误";}
}
