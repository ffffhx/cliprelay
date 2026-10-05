package com.limelight.ui;

import android.content.ContentResolver;
import android.net.Uri;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

/** Decode only the selected URI, bound memory, preserve alpha, strip source metadata. */
public final class RemoteImageCodec {
    public static final int MAX_INPUT = 20 * 1024 * 1024, MAX_OUTPUT = 8 * 1024 * 1024;
    public static final class Image {
        public final Bitmap preview;
        public final byte[] png;
        Image(Bitmap preview, byte[] png) { this.preview = preview; this.png = png; }
    }
    public static Image read(ContentResolver resolver, Uri uri) throws IOException {
        if (uri == null || !"content".equals(uri.getScheme())) throw new IOException("IMAGE_INVALID");
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) throw new IOException("IMAGE_INVALID");
            return decode(readBounded(in));
        }
    }
    public static byte[] readBounded(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[16384];
        int n;
        while ((n = input.read(buffer)) != -1) {
            if (bytes.size() + n > MAX_INPUT) throw new IOException("IMAGE_TOO_LARGE");
            bytes.write(buffer, 0, n);
        }
        return bytes.toByteArray();
    }
    public static Image decode(byte[] source) throws IOException {
        if (source.length > MAX_INPUT) throw new IOException("IMAGE_TOO_LARGE");
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(source, 0, source.length, options);
        if (options.outWidth < 1 || options.outHeight < 1 || options.outWidth > 32768 || options.outHeight > 32768
                || (long)options.outWidth * options.outHeight > 100000000) throw new IOException("IMAGE_INVALID");
        options.inSampleSize = 1;
        while (options.outWidth / options.inSampleSize > 3072 || options.outHeight / options.inSampleSize > 3072
                || (long)(options.outWidth / options.inSampleSize) * (options.outHeight / options.inSampleSize) > 6000000)
            options.inSampleSize *= 2;
        options.inJustDecodeBounds = false;
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bitmap = BitmapFactory.decodeByteArray(source, 0, source.length, options);
        if (bitmap == null) throw new IOException("IMAGE_INVALID");
        try {
            int orientation = ExifInterface.ORIENTATION_NORMAL;
            try { orientation = new ExifInterface(new ByteArrayInputStream(source))
                    .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL); }
            catch (IOException ignored) {}
            Matrix matrix = new Matrix();
            switch (orientation) {
                case 2: matrix.setScale(-1, 1); break;
                case 3: matrix.setRotate(180); break;
                case 4: matrix.setScale(1, -1); break;
                case 5: matrix.setRotate(90); matrix.postScale(-1, 1); break;
                case 6: matrix.setRotate(90); break;
                case 7: matrix.setRotate(-90); matrix.postScale(-1, 1); break;
                case 8: matrix.setRotate(-90); break;
            }
            if (!matrix.isIdentity()) {
                Bitmap rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), matrix, true);
                if (rotated != bitmap) { bitmap.recycle(); bitmap = rotated; }
            }
            for (int attempt = 0; attempt < 6; attempt++) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) throw new IOException("IMAGE_INVALID");
                if (output.size() <= MAX_OUTPUT) return new Image(bitmap, output.toByteArray());
                Bitmap smaller = Bitmap.createScaledBitmap(bitmap, Math.max(1, bitmap.getWidth() * 3 / 4),
                        Math.max(1, bitmap.getHeight() * 3 / 4), true);
                bitmap.recycle(); bitmap = smaller;
            }
            throw new IOException("IMAGE_TOO_LARGE");
        } catch (IOException | RuntimeException | OutOfMemoryError error) { bitmap.recycle(); throw error; }
    }
}
