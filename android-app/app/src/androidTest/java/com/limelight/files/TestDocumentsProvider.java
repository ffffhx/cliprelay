package com.limelight.files;

import android.database.*;
import android.os.*;
import android.provider.DocumentsContract;
import android.provider.DocumentsProvider;
import java.io.*;
import java.util.*;

/** Installed only in the test APK. Serves a dedicated cache fixture, never user documents. */
public final class TestDocumentsProvider extends DocumentsProvider {
    public static final String AUTHORITY="com.cliprelay.app.test.transfer-documents";
    private File root;private boolean failAfterRename;
    @Override public boolean onCreate(){root=new File(getContext().getCacheDir(),"transfer-document-fixture");return root.isDirectory()||root.mkdirs();}
    private File file(String id)throws FileNotFoundException{
        if(id.equals("root"))return root;
        if(id.contains("/")||id.contains("\\")||id.equals(".")||id.equals(".."))throw new FileNotFoundException();return new File(root,id);
    }
    private String[] columns(String[] projection){return projection==null?new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_FLAGS,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_SIZE}:projection;}
    private void row(MatrixCursor cursor,File file){
        MatrixCursor.RowBuilder row=cursor.newRow();for(String column:cursor.getColumnNames()){
            Object value=null;
            if(column.equals(DocumentsContract.Document.COLUMN_DOCUMENT_ID))value=file.equals(root)?"root":file.getName();
            if(column.equals(DocumentsContract.Document.COLUMN_DISPLAY_NAME))value=file.getName();
            if(column.equals(DocumentsContract.Document.COLUMN_SIZE))value=file.length();
            if(column.equals(DocumentsContract.Document.COLUMN_MIME_TYPE))value=file.isDirectory()?DocumentsContract.Document.MIME_TYPE_DIR:"application/octet-stream";
            if(column.equals(DocumentsContract.Document.COLUMN_FLAGS))value=file.isDirectory()?DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE:DocumentsContract.Document.FLAG_SUPPORTS_WRITE|DocumentsContract.Document.FLAG_SUPPORTS_DELETE|DocumentsContract.Document.FLAG_SUPPORTS_RENAME;
            row.add(value);
        }
    }
    @Override public Cursor queryDocument(String id,String[] projection)throws FileNotFoundException{File file=file(id);if(!file.exists())throw new FileNotFoundException();MatrixCursor cursor=new MatrixCursor(columns(projection));row(cursor,file);return cursor;}
    @Override public Cursor queryChildDocuments(String parent,String[] projection,String sort)throws FileNotFoundException{if(!parent.equals("root"))throw new FileNotFoundException();MatrixCursor cursor=new MatrixCursor(columns(projection));File[] files=root.listFiles();if(files!=null)for(File file:files)row(cursor,file);return cursor;}
    @Override public Cursor queryRoots(String[] projection){return new MatrixCursor(projection==null?new String[]{DocumentsContract.Root.COLUMN_ROOT_ID}:projection);}
    @Override public ParcelFileDescriptor openDocument(String id,String mode,CancellationSignal signal)throws FileNotFoundException{return ParcelFileDescriptor.open(file(id),ParcelFileDescriptor.parseMode(mode));}
    @Override public String createDocument(String parent,String mime,String name)throws FileNotFoundException{
        if(!parent.equals("root"))throw new FileNotFoundException();File output=file(name);try{if(!output.createNewFile())throw new FileNotFoundException("exists");return name;}catch(IOException e){throw new FileNotFoundException(e.getMessage());}
    }
    @Override public String renameDocument(String id,String name)throws FileNotFoundException{
        File before=file(id),after=file(name);if(after.exists()||!before.renameTo(after))throw new FileNotFoundException();
        if(failAfterRename){failAfterRename=false;throw new FileNotFoundException("simulated crash after rename");}return name;
    }
    @Override public void deleteDocument(String id)throws FileNotFoundException{File target=file(id);if(target.equals(root)||target.isDirectory()||!target.delete())throw new FileNotFoundException();}
    @Override public boolean isChildDocument(String parent,String child){return parent.equals("root")&&!child.equals("root");}
    @Override public Bundle call(String method,String arg,Bundle extras){
        if(method.equals("test-reset")){
            failAfterRename=false;File[] files=root.listFiles();if(files!=null)for(File file:files)if(file.isFile())file.delete();return new Bundle();
        }
        if(method.equals("test-fail-rename")){failAfterRename=true;return new Bundle();}
        return super.call(method,arg,extras);
    }
}
