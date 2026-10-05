package com.cliprelay.app

import android.app.Activity
import android.app.Instrumentation.ActivityResult
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.SystemClock
import android.provider.MediaStore
import android.widget.Button
import android.widget.TextView
import androidx.core.content.FileProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.limelight.Game
import com.limelight.ImageTransferActivity
import com.limelight.R
import com.limelight.computers.ComputerDatabaseManager
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Automatic picker/upload. Only the opt-in test writes the PC clipboard; no PC input. */
class RemoteImageUiTest {
    private val instrument = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrument.targetContext
    private fun ui(action: () -> Unit) = instrument.runOnMainSync(action)
    private fun pickerFilter() = IntentFilter(if (Build.VERSION.SDK_INT >= 33)
        MediaStore.ACTION_PICK_IMAGES else Intent.ACTION_OPEN_DOCUMENT).apply { addDataType("image/*") }
    private fun intent() = Intent(context, ImageTransferActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    private fun await(label: String, timeout: Long = 10000, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeout
        do {
            var ready = false
            ui { ready = condition() }
            if (ready) return
            SystemClock.sleep(100)
        } while (SystemClock.uptimeMillis() < deadline)
        fail(label)
    }
    private fun fixture(): File = File(context.cacheDir, "clipboard_images/qa-image-transfer.png").also { file ->
        file.parentFile!!.mkdirs()
        Bitmap.createBitmap(73, 41, Bitmap.Config.ARGB_8888).also { image ->
            image.eraseColor(Color.CYAN); image.setPixel(3, 4, Color.RED)
            file.outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
            image.recycle()
        }
    }

    @Test fun opensPickerImmediatelyAndCancelReturns() {
        val monitor = instrument.addMonitor(pickerFilter(), ActivityResult(Activity.RESULT_CANCELED, null), true)
        var activity: Activity? = null
        try {
            val screen = instrument.startActivitySync(intent()).also { activity = it }
            await("Picker did not launch automatically") { monitor.hits == 1 }
            await("Cancel did not return to the stream") { screen.isFinishing || screen.isDestroyed }
        } finally { instrument.removeMonitor(monitor); ui { activity?.finish() } }
    }

    @Test fun failedAutomaticUploadOffersRetryAndNeverReportsSuccess() {
        val file = fixture()
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val monitor = instrument.addMonitor(pickerFilter(), ActivityResult(Activity.RESULT_OK, Intent().setData(uri)), true)
        var activity: Activity? = null
        try {
            // Missing credentials: decode succeeds, upload fails before touching a computer.
            val screen = instrument.startActivitySync(intent()).also { activity = it }
            await("Automatic upload did not reach the failure state") {
                screen.findViewById<TextView>(R.id.remoteImageStatus).text == screen.getString(R.string.image_send_failed)
            }
            ui {
                assertEquals(1, monitor.hits)
                assertFalse(screen.isFinishing)
                assertTrue(screen.findViewById<Button>(R.id.remoteImageSend).isEnabled)
                screen.findViewById<Button>(R.id.remoteImageBack).performClick()
            }
            await("Back did not close the transfer") { screen.isFinishing }
        } finally { instrument.removeMonitor(monitor); ui { activity?.finish() }; file.delete() }
    }

    @Test fun selectedImageUploadsAndReturnsWithoutAnotherTap() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("imageUpload") == "true")
        val db = ComputerDatabaseManager(context)
        val computer = try { db.allComputers.first { it.serverCert != null } } finally { db.close() }
        val address = requireNotNull(computer.embeddedAddress ?: computer.manualAddress ?: computer.localAddress)
        val file = fixture()
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val monitor = instrument.addMonitor(pickerFilter(), ActivityResult(Activity.RESULT_OK, Intent().setData(uri)), true)
        var activity: Activity? = null
        try {
            val screen = instrument.startActivitySync(intent()
                .putExtra(Game.EXTRA_HOST, address.address).putExtra(Game.EXTRA_PORT, address.port)
                .putExtra(Game.EXTRA_SERVER_CERT, computer.serverCert.encoded).putExtra(Game.EXTRA_UNIQUEID, ""))
                .also { activity = it }
            await("Selection did not upload and return automatically", 55000) { screen.isFinishing || screen.isDestroyed }
            assertEquals(1, monitor.hits)
        } finally { instrument.removeMonitor(monitor); ui { activity?.finish() }; file.delete() }
    }
}
