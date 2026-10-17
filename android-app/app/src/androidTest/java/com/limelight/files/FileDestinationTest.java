package com.limelight.files;

import android.content.*;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.*;
import java.io.*;
import java.nio.file.Files;
import java.util.*;
import static org.junit.Assert.*;

public class FileDestinationTest {
    private Context context;private ContentResolver resolver;private TransferStorage store;private File fixture;
    private Uri tree,parent;private byte[] content;
    @Before public void setup()throws Exception{
        Context target=InstrumentationRegistry.getInstrumentation().getTargetContext();
        fixture=new File(target.getCacheDir(),"file-destination-test-"+UUID.randomUUID());assertTrue(fixture.mkdirs());
        context=new ContextWrapper(target){@Override public File getNoBackupFilesDir(){return fixture;}};store=new TransferStorage(context);resolver=target.getContentResolver();
        // Use a real, scoped URI grant. MANAGE_DOCUMENTS is not a shell permission,
        // and acquiring UiAutomation here would suppress the user's accessibility service.
        tree=Uri.parse(resolver.call(TestDocumentsAccessProvider.URI,"open",null,null).getString("tree"));
        parent=DocumentsContract.buildDocumentUriUsingTree(tree,"root");
        resolver.call(tree,"test-reset",null,null);
        content=new byte[TransferRunner.CHUNK+79];new Random(43).nextBytes(content);
    }
    @After public void cleanup()throws Exception{
        try {
        if(tree!=null)resolver.call(tree,"test-reset",null,null);
        } finally {
        try {
        if(fixture!=null&&fixture.exists()){
        String prefix=context.getCacheDir().getCanonicalPath()+File.separator;
        assertTrue(fixture.getCanonicalPath().startsWith(prefix)&&fixture.getName().startsWith("file-destination-test-"));
        try(java.util.stream.Stream<java.nio.file.Path> paths=Files.walk(fixture.toPath())){paths.sorted(Comparator.reverseOrder()).forEach(path->{try{Files.delete(path);}catch(IOException e){throw new RuntimeException(e);}});}
        }
        } finally { if(tree!=null)resolver.call(TestDocumentsAccessProvider.URI,"close",null,null); }
        }
    }
    private TransferStorage.Job job()throws Exception{
        TransferRunner.Task task=new TransferRunner.Task(TransferStorage.id(),"download","downloads","","report.bin");task.size=content.length;task.offset=content.length;task.sha256=TransferRunner.hash(content);task.state="ready-to-save";
        TransferStorage.Job job=new TransferStorage.Job(task,new JSONObject().put("uuid","isolated-test"));job.tree=tree.toString();store.add(job);Files.write(store.part(job).toPath(),content);return job;
    }
    private Uri create(String name,byte[] data)throws Exception{
        Uri uri=DocumentsContract.createDocument(resolver,parent,"application/octet-stream",name);try(OutputStream output=resolver.openOutputStream(uri,"wt")){output.write(data);}return uri;
    }
    private byte[] read(Uri uri)throws Exception{try(InputStream input=resolver.openInputStream(uri);ByteArrayOutputStream bytes=new ByteArrayOutputStream()){byte[] buffer=new byte[8192];int count;while((count=input.read(buffer))!=-1)bytes.write(buffer,0,count);return bytes.toByteArray();}}
    @Test public void verifiedDownloadPreservesExistingFilename()throws Exception{
        byte[] old={1,2,3};Uri original=create("report.bin",old);TransferStorage.Job job=job();TransferDestination.publish(resolver,store,job,()->{});
        assertEquals("complete",job.task.state);assertEquals("report (1).bin",job.finalName);assertArrayEquals(old,read(original));assertArrayEquals(content,read(Uri.parse(job.output)));assertFalse(store.part(job).exists());
    }
    @Test public void renameCrashRecoversWithoutDuplicateOutput()throws Exception{
        TransferStorage.Job job=job();resolver.call(tree,"test-fail-rename",null,null);
        assertThrows(IOException.class,()->TransferDestination.publish(resolver,store,job,()->{}));
        TransferStorage restarted=new TransferStorage(context);TransferStorage.Job restored=restarted.get(job.task.id);assertEquals("paused",restored.task.state);
        TransferDestination.publish(resolver,restarted,restored,()->{});assertEquals("report.bin",restored.finalName);assertEquals("complete",restored.task.state);assertArrayEquals(content,read(Uri.parse(restored.output)));
        try(android.database.Cursor cursor=resolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree,"root"),new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID},null,null,null)){assertEquals(1,cursor.getCount());}
    }
    @Test public void pausedExportKeepsStagingAndResumesSafely()throws Exception{
        TransferStorage.Job job=job();int[] checks={0};
        assertThrows(InterruptedIOException.class,()->TransferDestination.publish(resolver,store,job,()->{if(++checks[0]==3)throw new InterruptedIOException();}));
        assertTrue(store.part(job).exists());assertNotEquals("complete",job.task.state);
        TransferDestination.publish(resolver,store,job,()->{});assertArrayEquals(content,read(Uri.parse(job.output)));assertEquals("complete",job.task.state);
    }
    @Test public void cancellationDeletesOnlyItsOwnUnfinishedOutput()throws Exception{
        Uri original=create("keep.bin",new byte[]{8,9});TransferStorage.Job job=job();job.output=create(".cliprelay-"+job.task.id+".part",new byte[]{1}).toString();
        TransferDestination.discardPartial(resolver,store,job);assertFalse(store.part(job).exists());assertArrayEquals(new byte[]{8,9},read(original));
        job.output=original.toString();TransferDestination.discardPartial(resolver,store,job);assertArrayEquals(new byte[]{8,9},read(original));
    }
    @Test public void journalsRecoverOffsetsAndPauseInsteadOfAutoStarting()throws Exception{
        TransferStorage.Job job=job();job.source="content://selected/source";job.task.state="sending";job.task.offset=123;job.cancelRequested=true;store.save(job);
        TransferStorage.Job restored=new TransferStorage(context).get(job.task.id);assertEquals(123,restored.task.offset);assertEquals("paused",restored.task.state);assertEquals(job.source,restored.source);assertTrue(restored.cancelRequested);
    }
}
