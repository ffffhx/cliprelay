package com.cliprelay.app

import android.graphics.Bitmap
import android.graphics.Color
import com.limelight.ui.RemoteImageCodec
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException

class RemoteImageTest {
    @Test fun pngRoundTripPreservesTransparencyAndPixels() {
        val original = Bitmap.createBitmap(64, 40, Bitmap.Config.ARGB_8888)
        original.eraseColor(Color.TRANSPARENT)
        original.setPixel(3, 4, Color.RED)
        val output = ByteArrayOutputStream()
        original.compress(Bitmap.CompressFormat.PNG, 100, output)
        original.recycle()
        val image = RemoteImageCodec.decode(output.toByteArray())
        try {
            assertEquals(64, image.preview.width)
            assertEquals(Color.TRANSPARENT, image.preview.getPixel(0,0))
            assertEquals(Color.RED, image.preview.getPixel(3,4))
            assertTrue(image.png.size <= RemoteImageCodec.MAX_OUTPUT)
        } finally { image.preview.recycle() }
    }
    @Test fun invalidAndOversizedSourcesAreRejected() {
        try { RemoteImageCodec.decode(byteArrayOf(1,2,3)); fail("invalid source accepted") }
        catch (expected: IOException) {}
        try { RemoteImageCodec.readBounded(ByteArrayInputStream(ByteArray(RemoteImageCodec.MAX_INPUT+1))); fail("oversize source accepted") }
        catch (expected: IOException) {}
    }
    @Test fun largeImagesAreReducedBeforeUpload() {
        val original = Bitmap.createBitmap(4000, 2000, Bitmap.Config.ARGB_8888)
        original.eraseColor(Color.CYAN)
        val output = ByteArrayOutputStream()
        original.compress(Bitmap.CompressFormat.PNG, 100, output)
        original.recycle()
        val image = RemoteImageCodec.decode(output.toByteArray())
        try {
            assertTrue(image.preview.width <= 3072)
            assertTrue(image.preview.width.toLong() * image.preview.height <= 6000000)
            assertEquals(Color.CYAN, image.preview.getPixel(2,2))
        } finally { image.preview.recycle() }
    }
}
