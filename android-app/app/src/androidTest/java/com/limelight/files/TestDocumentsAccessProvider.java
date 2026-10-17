package com.limelight.files;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import android.provider.DocumentsContract;

/** Grants only this test APK's fixture tree to the equally signed instrumented app. */
public final class TestDocumentsAccessProvider extends ContentProvider {
    public static final Uri URI = Uri.parse("content://com.cliprelay.app.test.transfer-access");
    private static final String TARGET = "com.cliprelay.app";
    private static final int FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

    @Override public boolean onCreate() { return true; }

    @Override public Bundle call(String method, String arg, Bundle extras) {
        Context context = getContext();
        PackageManager packages = context.getPackageManager();
        int caller = Binder.getCallingUid();
        try {
            if (caller != packages.getApplicationInfo(TARGET, 0).uid
                    || packages.checkSignatures(caller, context.getApplicationInfo().uid)
                    != PackageManager.SIGNATURE_MATCH) {
                throw new SecurityException("Only the signed test target may access the fixture");
            }
        } catch (PackageManager.NameNotFoundException error) {
            throw new SecurityException("Test target is missing", error);
        }
        Uri tree = DocumentsContract.buildTreeDocumentUri(TestDocumentsProvider.AUTHORITY, "root");
        long identity = Binder.clearCallingIdentity();
        try {
            if ("open".equals(method)) {
                context.grantUriPermission(TARGET, tree, FLAGS | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            } else if ("close".equals(method)) {
                context.revokeUriPermission(TARGET, tree, FLAGS);
            } else {
                throw new IllegalArgumentException("Unknown fixture operation");
            }
            Bundle result = new Bundle();
            result.putString("tree", tree.toString());
            return result;
        } finally {
            Binder.restoreCallingIdentity(identity);
        }
    }

    @Override public Cursor query(Uri uri, String[] columns, String selection, String[] args, String order) { throw new UnsupportedOperationException(); }
    @Override public String getType(Uri uri) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
