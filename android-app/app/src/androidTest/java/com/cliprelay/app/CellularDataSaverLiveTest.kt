package com.cliprelay.app

import android.app.PictureInPictureParams
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Bundle
import android.os.SystemClock
import android.preference.PreferenceManager
import android.provider.Settings
import android.util.Rational
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.cliprelay.app.network.NetworkConnectionService
import com.limelight.Game
import com.limelight.binding.PlatformBinding
import com.limelight.binding.video.MediaCodecDecoderRenderer
import com.limelight.computers.ComputerDatabaseManager
import com.limelight.computers.IdentityManager
import com.limelight.nvstream.CellularDataPolicy
import com.limelight.nvstream.StreamNetworkMonitor
import com.limelight.nvstream.http.NvHTTP
import com.limelight.preferences.PreferenceConfiguration
import com.limelight.ui.LiveStreamSession
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in USB test. Real Wi-Fi/mobile handovers; receives video, never sends desktop input. */
class CellularDataSaverLiveTest {
    private val instrument = InstrumentationRegistry.getInstrumentation()
    private fun ui(action: () -> Unit) = instrument.runOnMainSync(action)
    private fun field(target: Any, name: String): Any? = target.javaClass.getDeclaredField(name)
        .apply { isAccessible = true }.get(target)
    private fun shell(command: String) {
        instrument.uiAutomation.executeShellCommand(command).use { descriptor ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
        }
    }
    private fun await(label: String, timeout: Long = 45000, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeout
        do {
            var ready = false
            ui { ready = condition() }
            if (ready) return
            SystemClock.sleep(150)
        } while (SystemClock.uptimeMillis() < deadline)
        fail(label)
    }

    @Test fun realNetworkHandoverChangesOnlyTheSessionBudget() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveDataSaver") == "true")
        val context = instrument.targetContext
        val preferences = PreferenceManager.getDefaultSharedPreferences(context)
        val saved = preferences.all
        val keys = listOf("seekbar_bitrate_kbps", PreferenceConfiguration.ADAPTIVE_BITRATE_PREF_STRING,
            PreferenceConfiguration.CELLULAR_DATA_SAVER_PREF_STRING)
        val wifiWasOn = Settings.Global.getInt(context.contentResolver, "wifi_on", 0) != 0
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        var game: Game? = null
        fun setWifi(enabled: Boolean) {
            shell("svc wifi ${if (enabled) "enable" else "disable"}")
            await("Default network did not switch to ${if (enabled) "Wi-Fi" else "cellular"}") {
                val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork)
                caps?.hasTransport(if (enabled) NetworkCapabilities.TRANSPORT_WIFI else NetworkCapabilities.TRANSPORT_CELLULAR) == true &&
                    StreamNetworkMonitor.classify(caps) == if (enabled) CellularDataPolicy.NetworkType.UNMETERED else CellularDataPolicy.NetworkType.CELLULAR
            }
        }
        fun awaitStream(limit: Int, pip: Boolean = false) {
          try {
            await("Stream did not recover at $limit Kbps (PiP=$pip)") {
                val monitor = ActivityLifecycleMonitorRegistry.getInstance()
                val candidates = (monitor.getActivitiesInStage(Stage.RESUMED) + monitor.getActivitiesInStage(Stage.PAUSED))
                    .filterIsInstance<Game>().filter { !it.isDestroyed && !it.isFinishing }
                (candidates.firstOrNull { it.isStreamConnected } ?: candidates.firstOrNull())?.let { game = it }
                val current = game ?: return@await false
                val renderer = field(current, "decoderRenderer") as? MediaCodecDecoderRenderer
                current.isStreamConnected && current.isInPictureInPictureMode == pip &&
                    (field(current, "dataPolicy") as CellularDataPolicy).ceilingKbps == limit &&
                    field(current, "streamBitrateKbps") == limit && renderer != null &&
                    (field(renderer, "lastFrameNumber") as Int) > 0
            }
          } catch (error: AssertionError) {
            ui {
                game?.let { current ->
                    instrument.sendStatus(0, Bundle().apply {
                        putString("dataSaverFailure", "connected=${current.isStreamConnected}, destroyed=${current.isDestroyed}, " +
                            "finishing=${current.isFinishing}, PiP=${current.isInPictureInPictureMode}, " +
                            "surface=${field(current, "surfaceCreated")}, failed=${field(current, "displayedFailureDialog")}, " +
                            "restarting=${field(current, "bitrateRestarting")}, negotiated=${field(current, "streamBitrateKbps")}, " +
                            "budget=${(field(current, "dataPolicy") as? CellularDataPolicy)?.ceilingKbps}, " +
                            "sample=${(field(current, "decoderRenderer") as? MediaCodecDecoderRenderer)?.networkSample?.atMs}")
                    })
                }
            }
            throw error
          }
            val renderer = field(requireNotNull(game), "decoderRenderer") as MediaCodecDecoderRenderer
            val frame = field(renderer, "lastFrameNumber") as Int
            await("Video stopped after applying $limit Kbps", 5000) {
                (field(renderer, "lastFrameNumber") as Int) > frame
            }
            ui {
                val current = requireNotNull(game)
                val config = field(current, "prefConfig") as PreferenceConfiguration
                val actual = PreferenceConfiguration.readPreferences(context)
                assertEquals(20_000, actual.bitrate)
                assertEquals(actual.width, config.width)
                assertEquals(actual.height, config.height)
                assertEquals(actual.fps, config.fps)
                if (pip) assertFalse(field(current, "grabbedInput") as Boolean)
                instrument.sendStatus(0, Bundle().apply {
                    putString("dataSaver", "limit=$limit, negotiated=${field(current, "streamBitrateKbps")}, " +
                        "${config.width}x${config.height}@${config.fps}, savedLimit=${actual.bitrate}, PiP=$pip, " +
                        "route=${if (current.intent.getStringExtra(Game.EXTRA_HOST) == "127.120.0.1") "embedded" else "direct"}, fresh video")
                })
            }
        }
        try {
            preferences.edit().putInt("seekbar_bitrate_kbps", 20_000)
                .putBoolean(PreferenceConfiguration.ADAPTIVE_BITRATE_PREF_STRING, false)
                .putBoolean(PreferenceConfiguration.CELLULAR_DATA_SAVER_PREF_STRING, true).commit()
            setWifi(true)
            instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            NetworkConnectionService.restore(context)
            await("Embedded channel not ready") { NetworkConnectionService.state.value.ready }
            val db = ComputerDatabaseManager(context)
            val computer = try { db.allComputers.single { it.serverCert != null } } finally { db.close() }
            val address = requireNotNull(computer.localAddress ?: computer.manualAddress)
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
            game = instrument.startActivitySync(intent) as Game
            awaitStream(20_000)
            setWifi(false)
            awaitStream(6_000)
            setWifi(true)
            awaitStream(20_000)
            // Back now returns to the computer list; exercise PiP explicitly.
            ui {
                assertTrue(requireNotNull(game).enterPictureInPictureMode(PictureInPictureParams.Builder()
                    .setAspectRatio(Rational(16, 9)).build()))
            }
            await("PiP entry failed") { game?.isInPictureInPictureMode == true }
            setWifi(false)
            awaitStream(6_000, pip = true)
            ui {
                assertTrue(LiveStreamSession.resume(context))
            }
            awaitStream(6_000)
            ui { game?.finish() }
            await("Stream did not stop") { !LiveStreamSession.isActive() && game?.isDestroyed == true }

            // Fresh cellular startup must also be capped when congestion control is enabled.
            preferences.edit().putBoolean(PreferenceConfiguration.ADAPTIVE_BITRATE_PREF_STRING, true).commit()
            val embedded = requireNotNull(computer.embeddedAddress)
            game = instrument.startActivitySync(Intent(intent).putExtra(Game.EXTRA_HOST, embedded.address)
                .putExtra(Game.EXTRA_PORT, embedded.port).putExtra(Game.EXTRA_HTTPS_PORT, 0)) as Game
            awaitStream(6_000)
            setWifi(true)
            awaitStream(20_000)
        } finally {
            ui {
                for (stage in listOf(Stage.RESUMED, Stage.PAUSED, Stage.STARTED)) {
                    ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(stage)
                        .filterIsInstance<Game>().forEach { it.finish() }
                }
                game?.takeUnless { it.isDestroyed }?.finish()
            }
            val editor = preferences.edit()
            for (key in keys) {
                when (val value = saved[key]) {
                    null -> editor.remove(key)
                    is Boolean -> editor.putBoolean(key, value)
                    is Int -> editor.putInt(key, value)
                }
            }
            editor.commit()
            shell("svc wifi ${if (wifiWasOn) "enable" else "disable"}")
        }
    }
}
