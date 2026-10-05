package com.cliprelay.app

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.app.Instrumentation.ActivityResult
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.MediaStore
import android.view.View
import androidx.core.content.FileProvider
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.cliprelay.app.network.NetworkConnectionService
import com.limelight.Game
import com.limelight.R
import com.limelight.binding.PlatformBinding
import com.limelight.binding.video.MediaCodecDecoderRenderer
import com.limelight.computers.IdentityManager
import com.limelight.computers.StreamRouteRecovery
import com.limelight.computers.ComputerDatabaseManager
import com.limelight.nvstream.http.NvHTTP
import com.limelight.ui.DesktopToolbar
import com.limelight.ui.ImagePasteRequest
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Real upload/stream recreation; Monkey input protection prevents all desktop input. */
class RemoteImageStreamLiveTest {
    private val instrument = InstrumentationRegistry.getInstrumentation()
    private fun ui(action: () -> Unit) = instrument.runOnMainSync(action)
    private fun field(value: Any, name: String): Any? = value.javaClass.getDeclaredField(name)
        .apply { isAccessible = true }.get(value)
    private fun await(label: String, timeout: Long = 35000, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeout
        do {
            var ready = false
            ui { ready = condition() }
            if (ready) return
            SystemClock.sleep(100)
        } while (SystemClock.uptimeMillis() < deadline)
        fail(label)
    }

    @Test fun pickerUploadReturnsToFreshStreamAndConsumesOnePasteRequest() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveImageStream") == "true")
        val context = instrument.targetContext
        val application = context.applicationContext as Application
        val requests = mutableSetOf<ImagePasteRequest>()
        var unprotectedConnection = false
        val callbacks = object : Application.ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) {
                if (activity is Game) {
                    val connection = field(activity, "conn")
                    if (connection == null || field(connection, "isMonkey") != true) unprotectedConnection = true
                    val request = field(activity, "imagePaste") as ImagePasteRequest
                    if (request.isPending) requests += request
                }
            }
            override fun onActivityCreated(activity: Activity, state: Bundle?) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        }
        val file = File(context.cacheDir, "clipboard_images/qa-image-stream.png")
        file.parentFile!!.mkdirs()
        Bitmap.createBitmap(73, 41, Bitmap.Config.ARGB_8888).also { bitmap ->
            bitmap.eraseColor(Color.CYAN); bitmap.setPixel(3, 4, Color.RED)
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val filter = IntentFilter(if (Build.VERSION.SDK_INT >= 33) MediaStore.ACTION_PICK_IMAGES else Intent.ACTION_OPEN_DOCUMENT)
            .apply { addDataType("image/*") }
        val picker = instrument.addMonitor(filter, ActivityResult(Activity.RESULT_OK, Intent().setData(uri)), true)
        var game: Game? = null
        try {
            instrument.uiAutomation.setRunAsMonkey(true)
            assertTrue("Desktop input must be blocked", ActivityManager.isUserAMonkey())
            application.registerActivityLifecycleCallbacks(callbacks)
            instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            NetworkConnectionService.restore(context)
            await("Embedded channel not ready", 45000) { NetworkConnectionService.state.value.ready }
            val db = ComputerDatabaseManager(context)
            val computer = try { db.allComputers.single { it.serverCert != null } } finally { db.close() }
            val uid = IdentityManager(context).uniqueId
            val route = requireNotNull(StreamRouteRecovery.select(context, computer.uuid, uid))
            val address = requireNotNull(route.activeAddress)
            val http = NvHTTP(address, route.httpsPort, uid, computer.serverCert, PlatformBinding.getCryptoProvider(context))
            val desktop = http.appList.single { it.appName == "Desktop" }
            val running = http.getCurrentGame(http.getServerInfo(true))
            check(running == 0 || running == desktop.appId) { "A different host app is active" }
            game = instrument.startActivitySync(Intent(context, Game::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(Game.EXTRA_HOST, address.address).putExtra(Game.EXTRA_PORT, address.port)
                .putExtra(Game.EXTRA_HTTPS_PORT, route.httpsPort)
                .putExtra(Game.EXTRA_APP_NAME, desktop.appName).putExtra(Game.EXTRA_APP_ID, desktop.appId)
                .putExtra(Game.EXTRA_UNIQUEID, uid).putExtra(Game.EXTRA_PC_UUID, computer.uuid)
                .putExtra(Game.EXTRA_PC_NAME, computer.name).putExtra(Game.EXTRA_SERVER_CERT, computer.serverCert.encoded)) as Game
            fun freshStream(): Boolean {
                val latest = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                    .filterIsInstance<Game>().firstOrNull()
                if (latest != null) game = latest
                val current = game ?: return false
                val renderer = field(current, "decoderRenderer") as? MediaCodecDecoderRenderer
                return current.isStreamConnected && current.hasWindowFocus() && renderer != null &&
                    (field(renderer, "lastFrameNumber") as Int) > 0
            }
            await("Initial stream not ready") { freshStream() }
            val original = requireNotNull(game)
            val request = field(original, "imagePaste") as ImagePasteRequest
            ui {
                assertFalse(unprotectedConnection)
                assertFalse(request.isPending)
                val toolbar = field(original, "desktopToolbar") as DesktopToolbar.Controller
                toolbar.setGameMode(false); toolbar.setExpanded(true)
                assertTrue(original.findViewById<View>(R.id.desktopImageButton).performClick())
            }
            await("Image picker did not open automatically") { picker.hits == 1 }
            await("Upload did not resume the stream with a consumed paste request", 60000) {
                freshStream() && game !== original && requests.contains(request) && !request.isPending
            }
            ui {
                assertFalse("A stream did not enable input protection", unprotectedConnection)
                assertSame(request, field(requireNotNull(game), "imagePaste"))
                assertEquals(1, requests.size)
            }
            val renderer = field(requireNotNull(game), "decoderRenderer") as MediaCodecDecoderRenderer
            val frame = field(renderer, "lastFrameNumber") as Int
            await("Resumed video stalled", 5000) { (field(renderer, "lastFrameNumber") as Int) > frame }
            instrument.sendStatus(0, Bundle().apply {
                putString("imageStream", "PASS: toolbar -> automatic picker -> generated image upload -> fresh resumed video; retained paste request consumed once; desktop keyboard/mouse transmission blocked")
            })
        } finally {
            ui {
                for (stage in listOf(Stage.RESUMED, Stage.PAUSED, Stage.STARTED)) {
                    ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(stage)
                        .filterIsInstance<Game>().forEach { it.finish() }
                }
                game?.takeUnless { it.isDestroyed }?.finish()
            }
            application.unregisterActivityLifecycleCallbacks(callbacks)
            instrument.removeMonitor(picker)
            instrument.uiAutomation.setRunAsMonkey(false)
            file.delete()
        }
    }
}
