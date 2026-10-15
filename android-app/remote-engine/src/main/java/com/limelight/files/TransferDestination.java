package com.limelight.files;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.*;
import java.security.MessageDigest;

/** Publish only a verified staged file; preserve the source and any existing destination. */
final class TransferDestination {
    interface Check { void run() throws IOException; }
    static final class Entry { Uri uri;String name;int flags;Entry(Uri uri,String name,int flags){this.uri=uri;this.name=name;this.flags=flags;} }
    private static Entry info(ContentResolver resolver,Uri uri) {
        try(Cursor cursor=resolver.query(uri,new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_FLAGS},null,null,null)){
            return cursor!=null&&cursor.moveToFirst()?new Entry(uri,cursor.getString(0),cursor.getInt(1)):null;
        }catch(RuntimeException e){return null;}
    }
    private static Entry find(ContentResolver resolver,Uri tree,String name) throws IOException {
        Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));
        try(Cursor cursor=resolver.query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_FLAGS},null,null,null)){
            if(cursor==null)throw new IOException("FILES_DESTINATION");
            while(cursor.moveToNext())if(name.equalsIgnoreCase(cursor.getString(1)))return new Entry(DocumentsContract.buildDocumentUriUsingTree(tree,cursor.getString(0)),cursor.getString(1),cursor.getInt(2));
            return null;
        }
    }
    private static boolean matches(ContentResolver resolver,Uri uri,TransferStorage.Job job,Check check) throws IOException {
        try(InputStream input=resolver.openInputStream(uri)){
            if(input==null)return false;
            MessageDigest sha;try{sha=MessageDigest.getInstance("SHA-256");}catch(java.security.NoSuchAlgorithmException e){throw new AssertionError(e);}
            byte[] buffer=new byte[TransferRunner.CHUNK];int read;long total=0;
            while((read=input.read(buffer))!=-1){check.run();total+=read;if(total>job.task.size)return false;sha.update(buffer,0,read);}
            StringBuilder hash=new StringBuilder();for(byte b:sha.digest())hash.append(String.format(java.util.Locale.ROOT,"%02x",b&255));
            return total==job.task.size&&hash.toString().equals(job.task.sha256);
        }
    }
    static void publish(ContentResolver resolver,TransferStorage store,TransferStorage.Job job,Check check) throws IOException {
        Uri tree=Uri.parse(job.tree);String partialName=".cliprelay-"+job.task.id+".part";
        Entry existing=job.output.isEmpty()?null:info(resolver,Uri.parse(job.output));
        // Recover a crash between provider rename and journal commit, without creating another copy.
        if(!job.finalName.isEmpty()){
            Entry completed=find(resolver,tree,job.finalName);
            if(completed!=null&&matches(resolver,completed.uri,job,check)){
                job.output=completed.uri.toString();job.task.state="complete";store.save(job);store.part(job).delete();return;
            }
        }
        if(existing!=null&&!partialName.equals(existing.name))throw new IOException("FILES_DESTINATION_CHANGED");
        if(existing==null)existing=find(resolver,tree,partialName);
        if(existing==null){
            Uri parent=DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));
            Uri created=DocumentsContract.createDocument(resolver,parent,"application/octet-stream",partialName);
            if(created==null)throw new IOException("FILES_DESTINATION");
            job.output=created.toString();store.save(job);existing=info(resolver,created);
        }
        if(existing==null||(existing.flags&DocumentsContract.Document.FLAG_SUPPORTS_RENAME)==0)throw new IOException("FILES_RENAME_UNSUPPORTED");
        job.output=existing.uri.toString();job.task.state="saving";store.save(job);check.run();
        try(InputStream input=new FileInputStream(store.part(job));OutputStream output=resolver.openOutputStream(existing.uri,"rwt")){
            if(output==null)throw new IOException("FILES_DESTINATION");
            byte[] bytes=new byte[TransferRunner.CHUNK];int read;job.task.verified=0;
            while((read=input.read(bytes))!=-1){check.run();output.write(bytes,0,read);job.task.verified+=read;}
            output.flush();
        }
        if(!matches(resolver,existing.uri,job,check))throw new IOException("FILES_HASH_MISMATCH");
        String desired=job.task.name;int dot=desired.lastIndexOf('.');String stem=dot>0?desired.substring(0,dot):desired,extension=dot>0?desired.substring(dot):"";
        for(int suffix=0;suffix<10000;suffix++){
            String candidate=suffix==0?desired:stem+" ("+suffix+")"+extension;
            if(find(resolver,tree,candidate)!=null)continue;
            job.finalName=candidate;store.save(job);check.run();
            Uri renamed=DocumentsContract.renameDocument(resolver,existing.uri,candidate);
            if(renamed==null)throw new IOException("FILES_DESTINATION");
            job.output=renamed.toString();Entry result=info(resolver,renamed);job.finalName=result==null?candidate:result.name;
            job.task.state="complete";store.save(job);store.part(job).delete();return;
        }
        throw new IOException("FILES_EXISTS");
    }
    static void discardPartial(ContentResolver resolver,TransferStorage store,TransferStorage.Job job) throws IOException {
        if(!job.output.isEmpty()){
            Entry entry=info(resolver,Uri.parse(job.output));
            if(entry!=null&&entry.name.equals(".cliprelay-"+job.task.id+".part"))DocumentsContract.deleteDocument(resolver,entry.uri);
        }
        File part=store.part(job);if(part.exists()&&!part.delete())throw new IOException("FILES_IO");
    }
}
