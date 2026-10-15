package com.limelight.files;

import org.json.JSONException;
import org.json.JSONObject;
import java.io.*;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;

/** Sequential, bounded transfer protocol. Checkpoints survive either endpoint restarting. */
public final class TransferRunner {
    public static final int CHUNK = 256 * 1024;
    public static final long LIMIT = 1L << 40;
    public interface Remote { JSONObject call(JSONObject request) throws IOException; }
    public interface Source { InputStream open() throws IOException; }
    public interface Progress {
        void save(Task task) throws IOException;
        boolean stopped();
    }
    public static final class Task {
        public String id, direction, root, path, name;
        public volatile String sha256 = "", state = "queued", finalName = "";
        public volatile long size = -1, offset, verified;
        public Task(String id, String direction, String root, String path, String name) {
            this.id=id; this.direction=direction; this.root=root; this.path=path; this.name=name;
        }
        public Task(JSONObject value) throws JSONException {
            this(value.getString("id"),value.getString("direction"),value.getString("root"),value.getString("path"),value.getString("name"));
            size=value.optLong("size",-1);offset=value.optLong("offset");verified=value.optLong("verified");
            sha256=value.optString("sha256");state=value.optString("state","paused");
            finalName=value.optString("finalName");
            if(!id.matches("[0-9a-f]{32}") || !(direction.equals("upload")||direction.equals("download")) || size < -1 || size > LIMIT || offset < 0 || offset > Math.max(size,0)) throw new JSONException("Invalid transfer");
        }
        public JSONObject json() throws JSONException {
            return new JSONObject().put("id",id).put("direction",direction).put("root",root).put("path",path).put("name",name)
                    .put("sha256",sha256).put("size",size).put("offset",offset).put("verified",verified).put("state",state).put("finalName",finalName);
        }
    }
    private final Remote remote;
    private final Progress progress;
    public TransferRunner(Remote remote, Progress progress) { this.remote=remote;this.progress=progress; }
    private void check() throws InterruptedIOException {
        if (progress.stopped() || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("FILES_PAUSED");
    }
    private void save(Task t,String state) throws IOException { t.state=state;progress.save(t); }
    public static String hash(byte[] data) { return hex(digest().digest(data)); }
    private static MessageDigest digest() {
        try { return MessageDigest.getInstance("SHA-256"); } catch(NoSuchAlgorithmException e) { throw new AssertionError(e); }
    }
    private static String hex(byte[] data) {
        StringBuilder result=new StringBuilder(data.length*2);
        for(byte value:data) result.append(Character.forDigit((value>>4)&15,16)).append(Character.forDigit(value&15,16));
        return result.toString();
    }
    private JSONObject command(Task task,String op) throws JSONException { return new JSONObject().put("op",op).put("id",task.id); }
    private JSONObject start(Task task) throws JSONException {
        return command(task,task.direction+"-start").put("root",task.root).put("path",task.path).put("name",task.name);
    }
    private JSONObject call(JSONObject request) throws IOException { check(); return remote.call(request); }
    private static void require(boolean valid,String code) throws IOException { if(!valid)throw new IOException(code); }
    private String digestStream(InputStream input,Task task, boolean measure) throws IOException {
        MessageDigest sha=digest();byte[] buffer=new byte[CHUNK];long count=0;int read;
        task.verified=0;
        while((read=input.read(buffer))!=-1) {
            check(); if(read==0)continue;
            count+=read;require(count<=LIMIT,"FILES_TOO_LARGE");sha.update(buffer,0,read);task.verified=count;
            // Progress is in memory between durable chunk checkpoints.
        }
        if(measure)task.size=count;else require(count==task.size,"FILES_SOURCE_CHANGED");
        return hex(sha.digest());
    }
    private void seek(InputStream input,long offset) throws IOException {
        while(offset>0) { check();long skipped=input.skip(Math.min(offset,CHUNK)); if(skipped>0)offset-=skipped; else {if(input.read()==-1)throw new IOException("FILES_SOURCE_CHANGED");offset--;} }
    }
    private JSONObject await(Task task,JSONObject result,String terminal) throws IOException,JSONException {
        while(!terminal.equals(result.optString("state"))) {
            String state=result.optString("state");
            if(state.equals("error"))throw new IOException(result.optString("code","FILES_IO"));
            require(state.equals("verifying")||state.equals("preparing")||state.equals("queued")||state.equals("committing"),"FILES_NOT_READY");
            task.verified=result.optLong("verified");save(task,"verifying");check();
            try {Thread.sleep(300);}catch(InterruptedException e){Thread.currentThread().interrupt();check();}
            result=call(command(task,"status"));
        }
        return result;
    }
    public void upload(Task task,Source source) throws IOException {
        try {
            if(task.sha256.isEmpty()) {
                save(task,"hashing");
                try(InputStream input=source.open()){task.sha256=digestStream(input,task,true);}
                task.verified=0;save(task,"sending");
            }
            JSONObject result=call(start(task).put("size",task.size).put("sha256",task.sha256));
            String state=result.optString("state");
            if(state.equals("complete")){task.finalName=result.optString("finalName",task.name);task.offset=task.size;save(task,"complete");return;}
            if(!state.equals("uploading")){result=await(task,result,"complete");task.finalName=result.optString("finalName",task.name);task.offset=task.size;save(task,"complete");return;}
            task.offset=result.getLong("offset");require(task.offset>=0&&task.offset<=task.size,"FILES_INVALID_RESPONSE");
            save(task,"sending");
            try(InputStream input=source.open()) {
                seek(input,task.offset);byte[] buffer=new byte[CHUNK];
                while(task.offset<task.size) {
                    check();int want=(int)Math.min(buffer.length,task.size-task.offset),count=0,read;
                    while(count<want && (read=input.read(buffer,count,want-count))!=-1){check();count+=read;}
                    require(count==want,"FILES_SOURCE_CHANGED");byte[] bytes=java.util.Arrays.copyOf(buffer,count);
                    result=call(command(task,"upload-chunk").put("offset",task.offset).put("data",Base64.getEncoder().encodeToString(bytes)).put("sha256",hash(bytes)));
                    require(result.getLong("offset")==task.offset+count,"FILES_INVALID_RESPONSE");task.offset+=count;save(task,"sending");
                }
                require(input.read()==-1,"FILES_SOURCE_CHANGED");
            }
            result=await(task,call(command(task,"finish")),"complete");task.finalName=result.optString("finalName",task.name);save(task,"complete");
        }catch(JSONException e){throw new IOException("FILES_INVALID_RESPONSE",e);}
    }
    public void download(Task task,File part) throws IOException {
        try {
            JSONObject result=call(start(task));
            if(!result.optString("state").equals("complete"))result=await(task,result,"ready");
            long size=result.getLong("size");String hash=result.getString("sha256");
            require(size>=0&&size<=LIMIT&&hash.matches("[0-9a-f]{64}"),"FILES_INVALID_RESPONSE");
            require(task.sha256.isEmpty()||task.sha256.equals(hash),"FILES_SOURCE_CHANGED");
            task.size=size;task.sha256=hash;save(task,"receiving");
            try(RandomAccessFile file=new RandomAccessFile(part,"rw")) {
                require(file.length()>=task.offset,"FILES_INVALID_STATE");file.setLength(task.offset);file.seek(task.offset);
                while(task.offset<task.size) {
                    check();require(part.getParentFile().getUsableSpace()>=CHUNK+32L*1024*1024,"FILES_DISK_FULL");
                    result=call(command(task,"download-chunk").put("offset",task.offset));
                    byte[] bytes;
                    try{bytes=Base64.getDecoder().decode(result.getString("data"));}catch(IllegalArgumentException e){throw new IOException("FILES_INVALID_RESPONSE",e);}
                    require(bytes.length==Math.min(CHUNK,task.size-task.offset)&&result.getLong("offset")==task.offset&&result.getLong("size")==task.size,"FILES_INVALID_RESPONSE");
                    require(hash(bytes).equals(result.getString("sha256")),"FILES_HASH_MISMATCH");
                    file.write(bytes);file.getFD().sync();task.offset+=bytes.length;save(task,"receiving");
                }
            }
            save(task,"verifying");
            try(InputStream input=new FileInputStream(part)){require(digestStream(input,task,false).equals(task.sha256),"FILES_HASH_MISMATCH");}
            call(command(task,"finish").put("sha256",task.sha256));save(task,"ready-to-save");
        }catch(JSONException e){throw new IOException("FILES_INVALID_RESPONSE",e);}
    }
    public void cancel(Task task) throws IOException {
        try {
            JSONObject response=remote.call(command(task,"cancel"));
            String state=response.optString("state");
            if(state.equals("complete")){task.finalName=response.optString("finalName",task.name);task.offset=task.size;save(task,task.direction.equals("upload")?"complete":"cancelled");return;}
            require(state.equals("cancelled"),"FILES_NOT_READY");save(task,"cancelled");
        }catch(JSONException e){throw new IOException("FILES_INVALID_RESPONSE",e);}
        catch(IOException e){if("FILES_NOT_FOUND".equals(e.getMessage()))save(task,"cancelled");else throw e;}
    }
}
