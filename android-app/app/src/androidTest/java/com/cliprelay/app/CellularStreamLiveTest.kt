package com.cliprelay.app

import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.cliprelay.app.network.NetworkConnectionService
import com.limelight.Game
import com.limelight.binding.PlatformBinding
import com.limelight.binding.video.MediaCodecDecoderRenderer
import com.limelight.computers.ComputerDatabaseManager
import com.limelight.computers.EmbeddedNetwork
import com.limelight.computers.IdentityManager
import com.limelight.nvstream.http.NvHTTP
import com.limelight.ui.LiveStreamSession
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in real cellular reconnects. Keeps the same network service; sends no PC input. */
class CellularStreamLiveTest {
    private val instrument = InstrumentationRegistry.getInstrumentation()
    private fun ui(action: () -> Unit) = instrument.runOnMainSync(action)
    private fun renderer(game: Game) = Game::class.java.getDeclaredField("decoderRenderer")
        .apply { isAccessible = true }.get(game) as MediaCodecDecoderRenderer
    private fun await(label: String, timeout: Long = 15000, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeout
        do {
            var ready = false
            ui { ready = condition() }
            if (ready) return
            SystemClock.sleep(150)
        } while (SystemClock.uptimeMillis() < deadline)
        fail(label)
    }

    @Test fun threeCellularConnectionsReceiveFreshVideo() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveCellular") == "true")
        val context = instrument.targetContext
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        fun checkCellular() = assertTrue("Cellular required; Wi-Fi must remain disabled",
            connectivity.getNetworkCapabilities(connectivity.activeNetwork)?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true)
        checkCellular()
        instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        NetworkConnectionService.restore(context)
        await("Embedded channel did not start", 45000) { NetworkConnectionService.state.value.ready }
        val db = ComputerDatabaseManager(context)
        val computer = try { db.allComputers.single { it.serverCert != null } } finally { db.close() }
        val address = requireNotNull(computer.embeddedAddress)
        assertTrue(EmbeddedNetwork.isAddress(address))
        val uid = IdentityManager(context).uniqueId
        val http = NvHTTP(address, 0, uid, computer.serverCert, PlatformBinding.getCryptoProvider(context))
        val desktop = http.appList.single { it.appName == "Desktop" }
        val running = http.getCurrentGame(http.getServerInfo(true))
        check(running == 0 || running == desktop.appId) { "A different host app is active" }
        val intent = Intent(context, Game::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(Game.EXTRA_HOST, address.address).putExtra(Game.EXTRA_PORT, address.port)
            .putExtra(Game.EXTRA_APP_NAME, desktop.appName).putExtra(Game.EXTRA_APP_ID, desktop.appId)
            .putExtra(Game.EXTRA_UNIQUEID, uid).putExtra(Game.EXTRA_PC_UUID, computer.uuid)
            .putExtra(Game.EXTRA_PC_NAME, computer.name).putExtra(Game.EXTRA_SERVER_CERT, computer.serverCert.encoded)
        repeat(3) { round ->
            checkCellular()
            var game = instrument.startActivitySync(Intent(intent)) as Game
            try {
                await("Cellular stream failed in round $round", 30000) {
                    val latest = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                        .filterIsInstance<Game>().firstOrNull()
                    if (latest != null) game = latest
                    val sample = renderer(game).networkSample
                    game.isStreamConnected && sample != null && SystemClock.uptimeMillis() - sample.atMs < 2500
                }
                val startSample = renderer(game).networkSample.atMs
                await("Video stalled in round $round") { renderer(game).networkSample.atMs >= startSample + 3000 }
                val sample = renderer(game).networkSample
                assertTrue(NetworkConnectionService.state.value.ready)
                instrument.sendStatus(0, Bundle().apply {
                    putString("cellularRound", "$round: connected via embedded channel; fresh video, receivedFps=${(sample.totalFrames - sample.lostFrames) * 1000.0 / sample.durationMs}, lost=${sample.lostFrames}/${sample.totalFrames}, rttMs=${sample.rttMs}")
                })
            } finally {
                ui { game.finish() }
                await("Previous stream did not close") { !LiveStreamSession.isActive() && game.isDestroyed }
            }
        }
        checkCellular()
    }
}
