package com.limelight.herdr;

import java.util.ArrayList;
import java.util.List;

/** Bounded draft, with an acknowledged prefix that must never be pasted twice. */
public final class HerdrAttachments<T> {
    public static final int LIMIT=8,MAX_BYTES=32*1024*1024;
    private final List<T> items=new ArrayList<>();
    private final List<Integer> sizes=new ArrayList<>();
    private int bytes,pasted;
    public int size(){return items.size();}
    public int pasted(){return pasted;}
    public T get(int index){return items.get(index);}
    public boolean add(T item,int size){
        if(pasted!=0||items.size()>=LIMIT||size<=0||size>MAX_BYTES-bytes)return false;
        items.add(item);sizes.add(size);bytes+=size;return true;
    }
    public T remove(int index){
        if(pasted!=0)throw new IllegalStateException("Images already pasted");
        bytes-=sizes.remove(index);return items.remove(index);
    }
    public void acknowledgePaste(){if(pasted>=items.size())throw new IllegalStateException("No image pending");pasted++;}
    public boolean allPasted(){return !items.isEmpty()&&pasted==items.size();}
    public void clear(){items.clear();sizes.clear();bytes=0;pasted=0;}
}
