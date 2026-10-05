package com.cliprelay.app

import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.widget.AbsListView
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.limelight.Game
import com.limelight.PcView
import com.limelight.R
import com.limelight.binding.PlatformBinding
import com.limelight.binding.video.MediaCodecDecoderRenderer
import com.limelight.computers.ComputerDatabaseManager
import com.limelight.computers.IdentityManager
import com.limelight.computers.EmbeddedNetwork
import com.cliprelay.app.network.NetworkConnectionService
import com.limelight.nvstream.http.NvHTTP
import com.limelight.nvstream.http.ComputerDetails
import com.limelight.nvstream.http.PairingManager
import com.limelight.ui.DesktopToolbar
import com.limelight.ui.LiveStreamSession
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in: return without PiP and resume the host session, without desktop input. */
class StreamHomeLiveTest {
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

    @Test fun returnToComputerListWithoutPipAndResumeHostSession() {
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
            instrument.sendStatus(0, Bundle().apply { putString("streamRoute", if (cellular) "cellular -> embedded channel; fresh decoded video" else address.toString()) })
            repeat(3) { round ->
                val previousGame = game
                val toolbar = field(game, "desktopToolbar") as DesktopToolbar.Controller
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
                var computers: PcView? = null
                await("Computer list did not appear in round $round") {
                    computers = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                        .filterIsInstance<PcView>().firstOrNull()
                    previousGame.isFinishing && !previousGame.isStreamConnected &&
                        computers?.findViewById<View>(R.id.networkPairPc)?.isShown == true &&
                        computers?.findViewById<View>(R.id.manuallyAddPc)?.isShown == true
                }
                ui {
                    assertFalse("Return unexpectedly opened PiP", previousGame.isInPictureInPictureMode)
                    assertEquals(false, field(previousGame, "grabbedInput"))
                    assertFalse(LiveStreamSession.isActive())
                }
                assertEquals("Return quit the host session", desktop.appId, http.getCurrentGame(http.getServerInfo(true)))

                // Select the actual computer card, exercising direct reconnect
                // rather than constructing a second stream intent in the test.
                var position = -1
                await("Paired computer did not become available", 30000) {
                    val list = requireNotNull(computers).findViewById<AbsListView>(R.id.fragmentView)
                    val adapter = list.adapter ?: return@await false
                    position = (0 until adapter.count).firstOrNull { index ->
                        val details = (adapter.getItem(index) as PcView.ComputerObject).details
                        details.uuid == computer.uuid && details.state == ComputerDetails.State.ONLINE &&
                            details.pairState == PairingManager.PairState.PAIRED && details.activeAddress != null
                    } ?: -1
                    position >= 0
                }
                ui {
                    val list = requireNotNull(computers).findViewById<AbsListView>(R.id.fragmentView)
                    assertTrue(list.performItemClick(list.adapter.getView(position, null, list), position,
                        list.adapter.getItemId(position)))
                }
                await("Computer card did not resume video in round $round", 35000) {
                    val latest = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                        .filterIsInstance<Game>().firstOrNull() ?: return@await false
                    game = latest
                    game !== previousGame && game.isStreamConnected && !game.isInPictureInPictureMode &&
                        (field(game, "decoderRenderer") as? MediaCodecDecoderRenderer)?.networkSample != null
                }
                val renderer = field(game, "decoderRenderer") as MediaCodecDecoderRenderer
                val resumedSample = renderer.networkSample.atMs
                await("Resumed video stopped updating") { renderer.networkSample.atMs > resumedSample }
                ui { (field(game, "desktopToolbar") as DesktopToolbar.Controller).setGameMode(false) }
                instrument.sendStatus(0, Bundle().apply {
                    putString("homeRound", "$round: computer list visible, no PiP, input released; host session preserved and resumed from computer card")
                })
            }
            ui { game.finish() }
            await("Disconnected stream still offered Continue") { !LiveStreamSession.isActive() }
            instrument.sendStatus(0, Bundle().apply {
                putString("streamHome", "PASS: desktop button, Android Back, game menu -> computer list without PiP -> computer card; host session preserved, fresh video, input released")
            })
        } finally { ui { if (!game.isFinishing) game.finish() } }
    }
}
