package com.cliprelay.app

import android.content.Intent
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.cliprelay.app.network.NetworkConnectionService
import com.limelight.binding.PlatformBinding
import com.limelight.computers.ComputerDatabaseManager
import com.limelight.nvstream.http.NvHTTP
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Opt-in, read-only check of an existing paired host. No desktop input. */
@RunWith(AndroidJUnit4::class)
class AutoKeyboardHostTest {
    @Test fun pairedFocusChannelOverEmbeddedNetwork() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("hostFocus") == "true")
        val instrument = InstrumentationRegistry.getInstrumentation()
        val context = instrument.targetContext
        val activity = instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            val deadline = SystemClock.uptimeMillis() + 25000
            while (!NetworkConnectionService.state.value.ready && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(250)
            assertTrue("Embedded network not ready", NetworkConnectionService.state.value.ready)
            val db = ComputerDatabaseManager(context)
            val computer = try { db.allComputers.first { it.embeddedAddress?.address == NetworkConnectionService.LOCAL_ADDRESS } } finally { db.close() }
            val http = NvHTTP(computer.embeddedAddress, 0, "", computer.serverCert, PlatformBinding.getCryptoProvider(context))
            // Production reaches this endpoint only after its stream is up.
            // Warm the peer path after instrumentation restarts the app process.
            http.getServerInfo(true)
            repeat(3) {
                val response = http.inputFocus
                // A custom foreground control or a window change may legitimately
                // make UI Automation unavailable. The authenticated response must
                // still be well formed; app detection is independent of UIA.
                response.getBoolean("supported")
                response.getBoolean("editable")
                response.getString("focusId")
                if (!response.getBoolean("supported")) {
                    assertTrue("Unavailable provider retained stale focus", !response.getBoolean("editable")
                        && response.getString("focusId").isEmpty())
                }
                assertTrue("Unexpected focus payload", response.length() == 3)
                assertTrue(response.has("editable") && response.has("focusId"))
                val app = http.foregroundApp
                assertTrue("Foreground detection unavailable", app.getBoolean("supported"))
                assertTrue("Unexpected application payload", app.length() == 2)
                assertTrue(app.getString("appId") in listOf("general", "orca", "chatgpt", "stardew", "plateup"))
            }
        } finally { instrument.runOnMainSync { activity.finish() } }
    }
}
