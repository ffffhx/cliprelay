package com.cliprelay.app

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import com.cliprelay.app.network.NetworkConnectionService
import com.limelight.PcView
import com.limelight.computers.ComputerDatabaseManager
import com.limelight.computers.ComputerManagerService
import com.limelight.computers.EmbeddedNetwork
import com.limelight.nvstream.http.ComputerDetails
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in route checks against an already authorized host; never starts a stream or sends input. */
class AutomaticConnectionHostTest {
    @Test fun computerListAutomaticallyMergesAndSelectsRoutes() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("hostRoutes") == "true")
        val instrument = InstrumentationRegistry.getInstrumentation()
        val context = instrument.targetContext
        val screen = instrument.startActivitySync(Intent(context, PcView::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        try {
            val deadline = SystemClock.uptimeMillis() + 45000
            var computer: ComputerDetails? = null
            while (SystemClock.uptimeMillis() < deadline) {
                val db = ComputerDatabaseManager(context)
                computer = try { db.allComputers.firstOrNull { EmbeddedNetwork.isAddress(it.embeddedAddress) && it.serverCert != null } }
                finally { db.close() }
                if (computer != null && NetworkConnectionService.state.value.ready) break
                SystemClock.sleep(500)
            }
            assertTrue("Previously authorized channel did not automatically resume", NetworkConnectionService.state.value.ready)
            val saved = checkNotNull(computer) { "Opening the computer list did not discover the paired channel" }
            assertFalse("Legacy channel was not migrated", EmbeddedNetwork.isAddress(saved.manualAddress))
            assertNotNull("No LAN address saved for live preference check", saved.localAddress)
            val field = PcView::class.java.getDeclaredField("managerBinder").apply { isAccessible = true }
            val binder = checkNotNull(field.get(screen))
            val outer = binder.javaClass.declaredFields.first { it.type == ComputerManagerService::class.java }.apply { isAccessible = true }.get(binder)
            val poll = ComputerManagerService::class.java.getDeclaredMethod("parallelPollPc", ComputerDetails::class.java).apply { isAccessible = true }
            fun route(value: ComputerDetails) = poll.invoke(outer, value) as ComputerDetails?
            val both = route(ComputerDetails(saved))
            assertNotNull("Host unreachable", both)
            assertEquals("Healthy LAN was not preferred", saved.localAddress, both!!.activeAddress)
            val fallback = route(ComputerDetails(saved).apply {
                localAddress = ComputerDetails.AddressTuple("127.0.0.1", 1)
                manualAddress = null; remoteAddress = null; ipv6Address = null
            })
            assertNotNull("Unavailable LAN did not fall back", fallback)
            assertTrue(EmbeddedNetwork.isAddress(fallback!!.activeAddress))
            val directOnly = route(ComputerDetails(saved).apply {
                embeddedAddress = null; manualAddress = null; remoteAddress = null; ipv6Address = null
            })
            assertEquals(saved.localAddress, directOnly?.activeAddress)
            val wrongHost = route(ComputerDetails(saved).apply {
                uuid = "cliprelay-route-test-wrong-host"
                manualAddress = null; remoteAddress = null; ipv6Address = null
            })
            assertNull("A different computer identity was accepted", wrongHost)
            val db = ComputerDatabaseManager(context)
            try {
                val matches = db.allComputers.filter { it.uuid == saved.uuid }
                assertEquals("Separate LAN and remote cards were created", 1, matches.size)
                assertArrayEquals("Existing authorization changed", saved.serverCert.encoded, matches.single().serverCert.encoded)
            } finally { db.close() }
            instrument.sendStatus(0, Bundle().apply {
                putString("automaticRoutes", "PASS: LAN preferred; LAN unavailable -> encrypted channel; direct-only available; wrong UUID rejected; one computer; authorization preserved")
            })
        } finally { instrument.runOnMainSync { screen.finish() } }
    }
}
