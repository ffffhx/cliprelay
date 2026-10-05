package com.cliprelay.app

import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.SystemClock
import android.preference.PreferenceManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.limelight.Game
import com.limelight.binding.PlatformBinding
import com.limelight.binding.video.MediaCodecDecoderRenderer
import com.limelight.computers.ComputerDatabaseManager
import com.limelight.computers.IdentityManager
import com.limelight.nvstream.AdaptiveBitrateController
import com.limelight.nvstream.AdaptiveBitrateController.Sample
import com.limelight.nvstream.NvConnection
import com.limelight.nvstream.http.NvHTTP
import com.limelight.preferences.PreferenceConfiguration
import com.limelight.preferences.TouchMode
import com.limelight.ui.DesktopToolbar
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in test against an already paired host. Injects only network measurements;
 * real reconnects/decoding are exercised without sending mouse, key or touch input. */
@RunWith(AndroidJUnit4::class)
class AdaptiveBitrateLiveTest {
    private val instrument = InstrumentationRegistry.getInstrumentation()
    private fun field(target: Any, name: String): Any? =
        target.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(target)
    private fun set(target: Any, name: String, value: Any) =
        target.javaClass.getDeclaredField(name).apply { isAccessible = true }.set(target, value)
    private fun policy(game: Game) = field(game, "adaptiveBitrate") as AdaptiveBitrateController
    private fun toolbar(game: Game) = field(game, "desktopToolbar") as DesktopToolbar.Controller
    private fun monitor(game: Game, loss: Int) {
        val now = SystemClock.uptimeMillis()
        val decoder = field(game, "decoderRenderer") as MediaCodecDecoderRenderer
        set(decoder, "networkSample", Sample(now, 1_000, 100, loss, 20, policy(game).bitrateKbps * 100L))
        val runnable = field(game, "bitrateMonitor") as Runnable
        (field(game, "bitrateHandler") as Handler).removeCallbacks(runnable)
        runnable.run()
        // Do not interleave real healthy samples with this injected congestion trace.
        (field(game, "bitrateHandler") as Handler).removeCallbacks(runnable)
    }
    private fun resumedGames(): List<Game> {
        var result = emptyList<Game>()
        instrument.runOnMainSync {
            result = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                .filterIsInstance<Game>()
        }
        return result
    }
    private fun waitConnected(previous: Game? = null): Game {
        val deadline = SystemClock.uptimeMillis() + 35_000
        while (SystemClock.uptimeMillis() < deadline) {
            val game = resumedGames().firstOrNull { it !== previous }
            var ready = false
            if (game != null) instrument.runOnMainSync {
                val sample = (field(game, "decoderRenderer") as? MediaCodecDecoderRenderer)?.networkSample
                ready = field(game, "connected") == true && sample != null &&
                    SystemClock.uptimeMillis() - sample.atMs < 3_000
            }
            if (ready) return game!!
            SystemClock.sleep(200)
        }
        error("No reconnected stream with fresh decoded video within 35 seconds")
    }

    @Test fun realReconnectsPreserveControlsAndExitDoesNotReconnect() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Explicit paired host required", args.getString("liveAdaptive") == "true")
        val hostName = requireNotNull(args.getString("hostName"))
        val context = instrument.targetContext
        val prefs = PreferenceManager.getDefaultSharedPreferences(context)
        val key = PreferenceConfiguration.ADAPTIVE_BITRATE_PREF_STRING
        val previousAuto = if (prefs.contains(key)) prefs.getBoolean(key, false) else null
        val configured = PreferenceConfiguration.readPreferences(context)
        assumeTrue(PreferenceConfiguration.getDefaultBitrate(context) >= 5_000)
        var game: Game? = null
        val db = ComputerDatabaseManager(context)
        try {
            val computer = db.allComputers.single { it.name == hostName }
            val address = requireNotNull(computer.localAddress ?: computer.manualAddress)
            val uid = IdentityManager(context).uniqueId
            val http = NvHTTP(address, 0, uid, computer.serverCert, PlatformBinding.getCryptoProvider(context))
            val desktop = http.appList.single { it.appName == "Desktop" }
            val activeApp = http.getCurrentGame(http.getServerInfo(true))
            check(activeApp == 0 || activeApp == desktop.appId) { "A different host app is active" }
            prefs.edit().putBoolean(key, true).commit()
            val intent = Intent(context, Game::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(Game.EXTRA_HOST, address.address).putExtra(Game.EXTRA_PORT, address.port)
                .putExtra(Game.EXTRA_APP_NAME, desktop.appName).putExtra(Game.EXTRA_APP_ID, desktop.appId)
                .putExtra(Game.EXTRA_UNIQUEID, uid).putExtra(Game.EXTRA_PC_UUID, computer.uuid)
                .putExtra(Game.EXTRA_PC_NAME, computer.name)
                .putExtra(Game.EXTRA_SERVER_CERT, computer.serverCert.encoded)
            instrument.startActivitySync(intent)
            game = waitConnected()
            val initial = game
            val initialRate = policy(initial).bitrateKbps
            val oldConnection = field(initial, "conn") as NvConnection
            val touchMode = field(initial, "touchMode") as TouchMode
            instrument.runOnMainSync {
                toolbar(initial).setGameMode(true)
                set(policy(initial), "connectedAt", SystemClock.uptimeMillis() - 20_000)
            }
            repeat(3) {
                SystemClock.sleep(1_100)
                instrument.runOnMainSync { monitor(initial, 10) }
            }
            game = waitConnected(initial)
            val lowered = game
            val lowerRate = policy(lowered).bitrateKbps
            assertTrue(lowerRate < initialRate)
            instrument.runOnMainSync {
                assertTrue(toolbar(lowered).isGameMode)
                assertEquals(touchMode, field(lowered, "touchMode"))
                val p = field(lowered, "prefConfig") as PreferenceConfiguration
                assertEquals(configured.width, p.width)
                assertEquals(configured.height, p.height)
                assertEquals(configured.fps, p.fps)
                assertEquals(configured.bitrate, p.bitrate)
            }
            // A delayed duplicate stop from the old Activity must not kill the new stream.
            oldConnection.stop()
            SystemClock.sleep(1_300)
            assertSame(lowered, waitConnected())
            instrument.runOnMainSync {
                toolbar(lowered).setGameMode(false)
                toolbar(lowered).setExpanded(true)
                val p = policy(lowered)
                val now = SystemClock.uptimeMillis()
                set(p, "connectedAt", now - 200_000)
                set(p, "lastChangeAt", now - 200_000)
                set(p, "healthyMs", 179_000L)
                monitor(lowered, 0)
            }
            game = waitConnected(lowered)
            val raised = game
            assertTrue(policy(raised).bitrateKbps in (lowerRate + 1)..initialRate)
            instrument.runOnMainSync {
                assertFalse(toolbar(raised).isGameMode)
                assertTrue(toolbar(raised).isExpanded)
                val p = policy(raised)
                set(p, "connectedAt", SystemClock.uptimeMillis() - 20_000)
                set(p, "lastChangeAt", SystemClock.uptimeMillis() - 40_000)
                set(p, "poorMs", 2_000L)
                monitor(raised, 10)
                raised.finish()
            }
            SystemClock.sleep(3_000)
            assertTrue("Exit must cancel the pending automatic reconnect", resumedGames().isEmpty())
            assertEquals(configured.bitrate, PreferenceConfiguration.readPreferences(context).bitrate)
        } finally {
            instrument.runOnMainSync { game?.finish() }
            for (remaining in resumedGames()) instrument.runOnMainSync { remaining.finish() }
            prefs.edit().apply {
                if (previousAuto == null) remove(key) else putBoolean(key, previousAuto)
            }.commit()
            db.close()
        }
    }
}
