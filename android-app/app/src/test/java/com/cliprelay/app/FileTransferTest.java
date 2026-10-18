package com.cliprelay.app;

import com.limelight.files.TransferRunner;
import org.json.*;
import org.junit.*;
import org.junit.rules.TemporaryFolder;
import java.io.*;
import java.nio.file.Files;
import java.util.*;
import static org.junit.Assert.*;

public class FileTransferTest {
    @Rule public TemporaryFolder temporary=new TemporaryFolder();
    private static final byte[] CONTENT=new byte[TransferRunner.CHUNK*2+73];
    static{new Random(17).nextBytes(CONTENT);}
    private static TransferRunner.Task task(String direction){return new TransferRunner.Task("a".repeat(32),direction,"downloads","文件夹","测试.bin");}
    private static final class Progress implements TransferRunner.Progress {
        JSONObject saved;boolean stop,failCheckpoint,stopAfterChunk;
        public boolean stopped(){return stop;}
        public void save(TransferRunner.Task task)throws IOException{
            if(failCheckpoint&&task.offset>0){failCheckpoint=false;throw new IOException("simulated journal interruption");}
            try{saved=new JSONObject(task.json().toString());}catch(JSONException e){throw new IOException(e);}
            if(stopAfterChunk&&task.offset>0)stop=true;
        }
        TransferRunner.Task restore()throws JSONException{return new TransferRunner.Task(saved);}
    }
    private static final class Host implements TransferRunner.Remote {
        final ByteArrayOutputStream uploaded=new ByteArrayOutputStream();
        boolean lostAcknowledgement,corruptChunk,wrongOffset,completed,created;
        int starts,chunks,cancels;long size;String expected;
        public JSONObject call(JSONObject request)throws IOException{
            try{
                switch(request.getString("op")){
                    case "upload-start":
                        starts++;created=true;size=request.getLong("size");expected=request.getString("sha256");
                        return new JSONObject().put("state",completed?"complete":"uploading").put("offset",uploaded.size());
                    case "upload-chunk":
                        chunks++;long offset=request.getLong("offset");assertEquals(uploaded.size(),offset);
                        byte[] chunk=Base64.getDecoder().decode(request.getString("data"));assertEquals(TransferRunner.hash(chunk),request.getString("sha256"));uploaded.write(chunk);
                        if(lostAcknowledgement){lostAcknowledgement=false;throw new IOException("lost acknowledgement");}
                        return new JSONObject().put("offset",wrongOffset?uploaded.size()+1:uploaded.size());
                    case "download-start":
                        created=true;return new JSONObject().put("state",completed?"complete":"ready").put("size",CONTENT.length).put("sha256",TransferRunner.hash(CONTENT));
                    case "download-chunk":
                        chunks++;int from=request.getInt("offset");byte[] bytes=Arrays.copyOfRange(CONTENT,from,Math.min(CONTENT.length,from+TransferRunner.CHUNK));
                        String hash=TransferRunner.hash(bytes);if(corruptChunk)bytes[0]^=1;
                        return new JSONObject().put("offset",from).put("size",CONTENT.length).put("data",Base64.getEncoder().encodeToString(bytes)).put("sha256",hash);
                    case "finish":
                        if(!request.has("sha256")&&!expected.equals(TransferRunner.hash(uploaded.toByteArray())))return new JSONObject().put("state","error").put("code","FILES_HASH_MISMATCH");
                        completed=true;return new JSONObject().put("state","complete");
                    case "cancel":
                        cancels++;if(!created)throw new IOException("FILES_NOT_FOUND");return new JSONObject().put("state",completed?"complete":"cancelled");
                    default:throw new AssertionError(request);
                }
            }catch(JSONException e){throw new IOException(e);}
        }
    }
    @Test public void uploadResumesAfterLostAcknowledgementWithoutDuplicatingBytes()throws Exception{
        Host host=new Host();host.lostAcknowledgement=true;Progress progress=new Progress();TransferRunner.Task task=task("upload");
        assertThrows(IOException.class,()->new TransferRunner(host,progress).upload(task,()->new ByteArrayInputStream(CONTENT)));
        assertEquals(0,task.offset);assertEquals(TransferRunner.CHUNK,host.uploaded.size());
        TransferRunner.Task restored=progress.restore();new TransferRunner(host,new Progress()).upload(restored,()->new ByteArrayInputStream(CONTENT));
        assertArrayEquals(CONTENT,host.uploaded.toByteArray());assertEquals("complete",restored.state);assertEquals(3,host.chunks);
    }
    @Test public void uploadPauseAndReopenKeepsTheHostOffset()throws Exception{
        Host host=new Host();Progress progress=new Progress();progress.stopAfterChunk=true;TransferRunner.Task original=task("upload");
        assertThrows(InterruptedIOException.class,()->new TransferRunner(host,progress).upload(original,()->new ByteArrayInputStream(CONTENT)));
        TransferRunner.Task restored=progress.restore();assertEquals(TransferRunner.CHUNK,restored.offset);
        new TransferRunner(host,new Progress()).upload(restored,()->new ByteArrayInputStream(CONTENT));assertArrayEquals(CONTENT,host.uploaded.toByteArray());
    }
    @Test public void downloadDiscardsUnacknowledgedDiskTailAfterJournalFailure()throws Exception{
        Host host=new Host();Progress progress=new Progress();progress.failCheckpoint=true;TransferRunner.Task task=task("download");File part=temporary.newFile();
        assertThrows(IOException.class,()->new TransferRunner(host,progress).download(task,part));assertEquals(TransferRunner.CHUNK,part.length());
        TransferRunner.Task restored=progress.restore();assertEquals(0,restored.offset);
        new TransferRunner(host,new Progress()).download(restored,part);assertArrayEquals(CONTENT,Files.readAllBytes(part.toPath()));assertEquals("ready-to-save",restored.state);
    }
    @Test public void corruptedDownloadChunkIsNeverWritten()throws Exception{
        Host host=new Host();host.corruptChunk=true;File part=temporary.newFile();TransferRunner.Task task=task("download");
        IOException error=assertThrows(IOException.class,()->new TransferRunner(host,new Progress()).download(task,part));
        assertEquals("FILES_HASH_MISMATCH",error.getMessage());assertEquals(0,part.length());assertEquals(0,task.offset);
    }
    @Test public void corruptedExistingPartialFileFailsWholeFileVerification()throws Exception{
        Host host=new Host();Progress progress=new Progress();progress.stopAfterChunk=true;TransferRunner.Task task=task("download");File part=temporary.newFile();
        assertThrows(InterruptedIOException.class,()->new TransferRunner(host,progress).download(task,part));
        try(RandomAccessFile edit=new RandomAccessFile(part,"rw")){edit.write(123);}
        TransferRunner.Task restored=progress.restore();IOException error=assertThrows(IOException.class,()->new TransferRunner(host,new Progress()).download(restored,part));
        assertEquals("FILES_HASH_MISMATCH",error.getMessage());assertFalse(host.completed);
    }
    @Test public void changedUploadSourceCannotComplete()throws Exception{
        Host host=new Host();TransferRunner.Task task=task("upload");task.sha256=TransferRunner.hash(CONTENT);task.size=CONTENT.length;
        byte[] changed=CONTENT.clone();changed[0]^=1;
        IOException error=assertThrows(IOException.class,()->new TransferRunner(host,new Progress()).upload(task,()->new ByteArrayInputStream(changed)));
        assertEquals("FILES_HASH_MISMATCH",error.getMessage());assertNotEquals("complete",task.state);
    }
    @Test public void emptyUploadAndCompletionRetryDoNotCreateAnotherTransfer()throws Exception{
        Host host=new Host();TransferRunner.Task task=task("upload");TransferRunner runner=new TransferRunner(host,new Progress());
        runner.upload(task,()->new ByteArrayInputStream(new byte[0]));runner.upload(task,()->{throw new IOException("source no longer available");});
        assertEquals("complete",task.state);assertEquals(0,host.chunks);assertEquals(0,task.size);
    }
    @Test public void cancellingUnstartedJobAndAlreadyCommittedJobAreSafe()throws Exception{
        Host host=new Host();TransferRunner.Task first=task("upload");new TransferRunner(host,new Progress()).cancel(first);assertEquals("cancelled",first.state);
        host.created=true;host.completed=true;TransferRunner.Task committed=task("upload");committed.size=10;
        new TransferRunner(host,new Progress()).cancel(committed);assertEquals("complete",committed.state);assertEquals(10,committed.offset);
    }
    @Test public void incorrectAcknowledgementCannotAdvanceClientProgress()throws Exception{
        Host host=new Host();host.wrongOffset=true;TransferRunner.Task task=task("upload");
        IOException error=assertThrows(IOException.class,()->new TransferRunner(host,new Progress()).upload(task,()->new ByteArrayInputStream(CONTENT)));
        assertEquals("FILES_INVALID_RESPONSE",error.getMessage());assertEquals(0,task.offset);
    }
    @Test public void restoredJournalsRejectPathShapedIdsAndImpossibleOffsets()throws Exception{
        JSONObject data=task("upload").json();data.put("id","../outside");assertThrows(JSONException.class,()->new TransferRunner.Task(data));
        data.put("id","a".repeat(32)).put("size",1).put("offset",2);assertThrows(JSONException.class,()->new TransferRunner.Task(data));
    }
    private static final class WindowsWorker implements TransferRunner.Remote,AutoCloseable {
        final Process process;final BufferedReader reader;final BufferedWriter writer;
        WindowsWorker(String executable,File directory)throws IOException{
            ProcessBuilder builder=new ProcessBuilder(executable,"--file-probe");builder.environment().put("CLIPRELAY_TEST_FILE_ROOT",directory.getAbsolutePath());
            process=builder.start();reader=new BufferedReader(new InputStreamReader(process.getInputStream(),java.nio.charset.StandardCharsets.UTF_8));writer=new BufferedWriter(new OutputStreamWriter(process.getOutputStream(),java.nio.charset.StandardCharsets.UTF_8));
        }
        public JSONObject call(JSONObject request)throws IOException{
            try{
                request.put("owner","c".repeat(64));writer.write("files:"+request+"\n");writer.flush();String line=reader.readLine();
                if(line==null)throw new IOException("worker exited");JSONObject response=new JSONObject(line);
                if(!response.optBoolean("ok"))throw new IOException(response.optString("code"));return response;
            }catch(JSONException e){throw new IOException(e);}
        }
        public void close()throws Exception{writer.close();if(!process.waitFor(5,java.util.concurrent.TimeUnit.SECONDS))process.destroyForcibly();reader.close();}
    }
    @Test public void actualWindowsWorkerRoundTripSurvivesBothProcessesRestarting()throws Exception{
        String executable=System.getenv("CLIPRELAY_FILE_TEST_WORKER");Assume.assumeTrue(executable!=null&&!executable.isEmpty());
        File folder=temporary.newFolder("cross-language");File target=new File(folder,"files/文件夹");assertTrue(target.mkdirs());
        Progress uploadProgress=new Progress();TransferRunner.Task upload=task("upload");
        try(WindowsWorker host=new WindowsWorker(executable,folder)){
            TransferRunner.Remote loseReply=request->{JSONObject response=host.call(request);if(request.optString("op").equals("upload-chunk"))throw new IOException("connection lost after host acknowledged");return response;};
            assertThrows(IOException.class,()->new TransferRunner(loseReply,uploadProgress).upload(upload,()->new ByteArrayInputStream(CONTENT)));
        }
        try(WindowsWorker host=new WindowsWorker(executable,folder)){
            new TransferRunner(host,new Progress()).upload(uploadProgress.restore(),()->new ByteArrayInputStream(CONTENT));
        }
        assertArrayEquals(CONTENT,Files.readAllBytes(new File(target,upload.name).toPath()));
        TransferRunner.Task download=task("download");download.id="b".repeat(32);Progress downloadProgress=new Progress();downloadProgress.stopAfterChunk=true;File part=temporary.newFile();
        try(WindowsWorker host=new WindowsWorker(executable,folder)){
            assertThrows(InterruptedIOException.class,()->new TransferRunner(host,downloadProgress).download(download,part));
        }
        try(WindowsWorker host=new WindowsWorker(executable,folder)){
            TransferRunner.Task restored=downloadProgress.restore();new TransferRunner(host,new Progress()).download(restored,part);assertEquals("ready-to-save",restored.state);
        }
        assertArrayEquals(CONTENT,Files.readAllBytes(part.toPath()));assertEquals(1,Objects.requireNonNull(target.listFiles()).length);
    }
}
