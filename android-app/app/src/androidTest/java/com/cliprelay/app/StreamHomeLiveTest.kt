package com.cliprelay.app

import android.app.Activity
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.performClick
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.limelight.Game
import com.limelight.R
import com.limelight.binding.PlatformBinding
import com.limelight.binding.video.MediaCodecDecoderRenderer
import com.limelight.computers.ComputerDatabaseManager
import com.limelight.computers.IdentityManager
import com.limelight.computers.EmbeddedNetwork
import com.cliprelay.app.network.NetworkConnectionService
import com.limelight.nvstream.http.NvHTTP
import com.limelight.ui.DesktopToolbar
import com.limelight.ui.LiveStreamSession
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Opt-in: retain the same real stream through home/PiP/fullscreen, without desktop input. */
class StreamHomeLiveTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrument = InstrumentationRegistry.getInstrumentation()
    private fun ui(action: () -> Unit) = instrument.runOnMainSync(action)
    private fun field(target: Any, name: String): Any? = target.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(target)
    private fun await(label: String, timeout: Long = 10000, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeout
        do {
            var ready = false
            ui { ready = condition() }
            if (ready) return
            SystemClock.sleep(150)
        } while (SystemClock.uptimeMillis() < deadline)
        fail(label)
    }

    @Test fun homeAndContinueKeepTheSameConnection() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveStreamHome") == "true")
        val context = instrument.targetContext
        val cellular = InstrumentationRegistry.getArguments().getString("streamRoute") == "cellular"
        instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        if (cellular) {
            val connectivity = context.getSystemService(ConnectivityManager::class.java)
            assertTrue("Cellular network required; this test never enables Wi-Fi",
                connectivity.getNetworkCapabilities(connectivity.activeNetwork)?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true)
            NetworkConnectionService.restore(context)
            await("Embedded channel not ready", 45000) { NetworkConnectionService.state.value.ready }
        }
        val db = ComputerDatabaseManager(context)
        val computer = try { db.allComputers.single { it.serverCert != null } } finally { db.close() }
        val address = requireNotNull(if (cellular) computer.embeddedAddress else computer.localAddress ?: computer.manualAddress ?: computer.embeddedAddress)
        if (cellular) assertTrue(EmbeddedNetwork.isAddress(address))
        val uid = IdentityManager(context).uniqueId
        val http = NvHTTP(address, 0, uid, computer.serverCert, PlatformBinding.getCryptoProvider(context))
        // Match PcView's authenticated polling before opening the app list.
        // Enrollment/listeners can be ready before a fresh node's first handshake.
        var warmupError: java.io.IOException? = null
        for (attempt in 0 until 4) {
            try { http.getServerInfo(true); warmupError = null; break }
            catch (error: java.io.IOException) { warmupError = error; SystemClock.sleep(250) }
        }
        warmupError?.let { throw it }
        val desktop = http.appList.single { it.appName == "Desktop" }
        val running = http.getCurrentGame(http.getServerInfo(true))
        check(running == 0 || running == desktop.appId) { "A different host app is active" }
        var game = instrument.startActivitySync(Intent(context, Game::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(Game.EXTRA_HOST, address.address).putExtra(Game.EXTRA_PORT, address.port)
            .putExtra(Game.EXTRA_APP_NAME, desktop.appName).putExtra(Game.EXTRA_APP_ID, desktop.appId)
            .putExtra(Game.EXTRA_UNIQUEID, uid).putExtra(Game.EXTRA_PC_UUID, computer.uuid)
            .putExtra(Game.EXTRA_PC_NAME, computer.name).putExtra(Game.EXTRA_SERVER_CERT, computer.serverCert.encoded)) as Game
        try {
            try {
                await("Stream did not connect", 35000) {
                    // Launching from the portrait home page can replace the first
                    // Activity during the initial display/orientation transition.
                    val latest = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                        .filterIsInstance<Game>().firstOrNull()
                    if (latest != null) game = latest
                    game.isStreamConnected && (field(game, "decoderRenderer") as MediaCodecDecoderRenderer).networkSample != null
                }
            } catch (error: AssertionError) {
                ui {
                    instrument.sendStatus(0, Bundle().apply {
                        putString("streamLaunch", "connected=${game.isStreamConnected}, finishing=${game.isFinishing}, destroyed=${game.isDestroyed}, focused=${game.hasWindowFocus()}, resumed=${field(game,"activityResumed")}, surface=${field(game,"surfaceCreated")}, failed=${field(game,"displayedFailureDialog")}, sample=${(field(game,"decoderRenderer") as? MediaCodecDecoderRenderer)?.networkSample?.atMs}")
                    })
                }
                throw error
            }
            val connection = field(game, "conn")
            val renderer = field(game, "decoderRenderer") as MediaCodecDecoderRenderer
            instrument.sendStatus(0, Bundle().apply { putString("streamRoute", if (cellular) "cellular -> embedded channel; fresh decoded video" else address.toString()) })
            val toolbar = field(game, "desktopToolbar") as DesktopToolbar.Controller
            repeat(3) { round ->
                val sampleAt = renderer.networkSample.atMs
                ui {
                    if (round == 0) {
                        toolbar.setGameMode(false); toolbar.setExpanded(true)
                        assertTrue(game.findViewById<View>(R.id.desktopHomeButton).performClick())
                    } else if (round == 1) game.onBackPressed()
                    else {
                        toolbar.setGameMode(true)
                        game.findViewById<View>(R.id.gameMenuButton).performClick()
                        assertTrue(game.findViewById<View>(R.id.gameHomeButton).performClick())
                    }
                }
                await("Home/PiP transition failed in round $round") {
                    game.isInPictureInPictureMode && game.isStreamConnected &&
                        ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).any { it is MainActivity }
                }
                await("Video stopped updating in PiP") { renderer.networkSample.atMs > sampleAt }
                ui {
                    assertSame(connection, field(game, "conn"))
                    assertEquals(false, field(game, "grabbedInput"))
                    assertTrue(LiveStreamSession.isActive())
                    instrument.sendStatus(0, Bundle().apply {
                        putString("homeRound", "$round: same stream in PiP, task=${game.taskId}, input released, video updated")
                    })
                }
                compose.onNodeWithTag("open-remote-desktop").assertTextContains("继续控制").performClick()
                try {
                    await("Continue did not restore the same stream") {
                        !game.isInPictureInPictureMode && game.isStreamConnected && game.hasWindowFocus() &&
                            ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).contains(game)
                    }
                } catch (error: AssertionError) {
                    ui {
                        instrument.sendStatus(0, Bundle().apply {
                            putString("resumeFailure", "round=$round, pip=${game.isInPictureInPictureMode}, connected=${game.isStreamConnected}, destroyed=${game.isDestroyed}, finishing=${game.isFinishing}, task=${game.taskId}, resumed=${ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).map { it.javaClass.simpleName }}")
                        })
                    }
                    throw error
                }
                val resumedSample = renderer.networkSample.atMs
                await("Fullscreen video stopped after Continue") { renderer.networkSample.atMs > resumedSample }
                ui { assertSame(connection, field(game, "conn")); toolbar.setGameMode(false) }
            }
            ui { game.finish() }
            await("Disconnected stream still offered Continue") { !LiveStreamSession.isActive() }
            instrument.sendStatus(0, Bundle().apply {
                putString("streamHome", "PASS: desktop button, Android Back, game menu -> home/PiP -> Continue; same Activity and connection, fresh video, input released, stale session cleared")
            })
        } finally { ui { if (!game.isFinishing) game.finish() } }
    }
}
