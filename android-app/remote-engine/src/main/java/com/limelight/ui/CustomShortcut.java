package com.limelight.ui;

import org.json.*;
import java.util.*;

/** Versioned desktop chords; no scripts, delays, persistent held keys or text macros. */
public final class CustomShortcut {
    public static final int LIMIT=12;
    public final String id,name;
    public final int modifiers,key;
    public static final Map<Integer,String> KEYS;
    static {
        LinkedHashMap<Integer,String> keys=new LinkedHashMap<>();
        for(int k='A';k<='Z';k++)keys.put(k,Character.toString((char)k));
        for(int k='0';k<='9';k++)keys.put(k,Character.toString((char)k));
        for(int k=1;k<=24;k++)keys.put(0x6f+k,"F"+k);
        int[] codes={8,9,13,27,32,33,34,35,36,37,38,39,40,45,46,44,93,0xba,0xbb,0xbc,0xbd,0xbe,0xbf,0xc0,0xdb,0xdc,0xdd,0xde};
        String[] names={"Backspace","Tab","Enter","Esc","Space","Page Up","Page Down","End","Home","←","↑","→","↓","Insert","Delete","Print Screen","Menu",";","=",",","-",".","/","`","[","\\","]","'"};
        for(int i=0;i<codes.length;i++)keys.put(codes[i],names[i]);KEYS=Collections.unmodifiableMap(keys);
    }
    public CustomShortcut(String id,String name,int modifiers,int key) throws JSONException {
        if(id==null || !id.matches("[0-9a-f]{32}") || name==null || !name.equals(name.trim()) || name.isEmpty() || name.codePointCount(0,name.length())>18 || modifiers<0 || modifiers>15 || !KEYS.containsKey(key))throw new JSONException("Invalid shortcut");
        for(int cp:name.codePoints().toArray())if(Character.isISOControl(cp) || Character.getType(cp)==Character.FORMAT || cp>=0xd800 && cp<=0xdfff)throw new JSONException("Invalid name");
        this.id=id;this.name=name;this.modifiers=modifiers;this.key=key;
    }
    public int[] chord(){
        int[] result=new int[Integer.bitCount(modifiers)+1];int at=0;
        int[] codes={0x10,0x11,0x12,0x5b};for(int i=0;i<4;i++)if((modifiers&(1<<i))!=0)result[at++]=codes[i];result[at]=key;return result;
    }
    public String label(){String result="";if((modifiers&2)!=0)result+="Ctrl + ";if((modifiers&4)!=0)result+="Alt + ";if((modifiers&1)!=0)result+="Shift + ";if((modifiers&8)!=0)result+="Win + ";return result+KEYS.get(key);}
    public static List<CustomShortcut> decode(String raw) throws JSONException {
        if(raw==null || raw.length()>16384)throw new JSONException("Invalid shortcuts");
        JSONObject value=new JSONObject(raw);if(integer(value,"version")!=1)throw new JSONException("Invalid version");
        JSONArray items=value.getJSONArray("items");if(items.length()>LIMIT)throw new JSONException("Too many shortcuts");
        ArrayList<CustomShortcut> result=new ArrayList<>();Set<String> ids=new HashSet<>();
        for(int i=0;i<items.length();i++){
            JSONObject item=items.getJSONObject(i);Object id=item.get("id"),name=item.get("name");
            if(!(id instanceof String) || !(name instanceof String))throw new JSONException("Invalid shortcut");
            CustomShortcut shortcut=new CustomShortcut((String)id,(String)name,integer(item,"modifiers"),integer(item,"key"));
            if(!ids.add(shortcut.id))throw new JSONException("Duplicate shortcut");result.add(shortcut);
        }return result;
    }
    public static String encode(List<CustomShortcut> values) throws JSONException {
        JSONArray items=new JSONArray();for(CustomShortcut value:values)items.put(new JSONObject().put("id",value.id).put("name",value.name).put("modifiers",value.modifiers).put("key",value.key));
        String result=new JSONObject().put("version",1).put("items",items).toString();decode(result);return result;
    }
    private static int integer(JSONObject value,String name) throws JSONException {Object raw=value.get(name);if(!(raw instanceof Integer))throw new JSONException("Invalid number");return (Integer)raw;}
}
