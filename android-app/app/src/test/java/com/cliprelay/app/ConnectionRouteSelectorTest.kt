package com.cliprelay.app

import com.limelight.computers.ConnectionRouteSelector
import com.limelight.nvstream.http.ComputerDetails
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class ConnectionRouteSelectorTest {
    @Test fun prefersLanEvenWhenTunnelRespondsFirst() {
        val tunnelReplied = CountDownLatch(1)
        val selected = ConnectionRouteSelector.select(listOf(
            Callable { check(tunnelReplied.await(1, TimeUnit.SECONDS)); "lan" },
            Callable { tunnelReplied.countDown(); "tunnel" },
        ), 400)
        assertEquals("lan", selected)
    }

    @Test fun stalledLanDoesNotBlockTunnelAndGetsCancelled() {
        val cancelled = CountDownLatch(1)
        val started = CountDownLatch(1)
        val then = System.nanoTime()
        val selected = ConnectionRouteSelector.select(listOf(
            Callable<String?> {
                started.countDown()
                try { CountDownLatch(1).await(); null }
                finally { cancelled.countDown() }
            },
            Callable { check(started.await(1, TimeUnit.SECONDS)); "tunnel" },
        ), 80)
        assertEquals("tunnel", selected)
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - then) < 1500)
        assertTrue(cancelled.await(1, TimeUnit.SECONDS))
    }

    @Test fun unavailableTunnelDoesNotBlockLan() {
        assertEquals("lan", ConnectionRouteSelector.select(listOf(
            Callable { "lan" }, Callable { throw java.io.IOException("Tunnel paused") },
        ), 400))
    }

    @Test fun allFailedOrNoRoutesReturnsOffline() {
        assertNull(ConnectionRouteSelector.select<String>(emptyList(), 400))
        assertNull(ConnectionRouteSelector.select(listOf(
            Callable<String?> { null }, Callable { throw java.io.IOException() },
        ), 400))
    }

    @Test fun cancellationStopsOutstandingProbes() {
        val started = CountDownLatch(1)
        val cancelled = CountDownLatch(1)
        val interrupted = AtomicBoolean()
        val selection = Thread {
            try {
                ConnectionRouteSelector.select(listOf(Callable<String?> {
                    started.countDown()
                    try { CountDownLatch(1).await(); null }
                    finally { cancelled.countDown() }
                }), 400)
            } catch (_: InterruptedException) { interrupted.set(true) }
        }
        selection.start()
        try {
            assertTrue(started.await(2, TimeUnit.SECONDS))
            selection.interrupt()
            selection.join(2000)
            assertFalse(selection.isAlive)
            assertTrue(interrupted.get())
            assertTrue(cancelled.await(1, TimeUnit.SECONDS))
        } finally { selection.interrupt() }
    }

    @Test fun discoveryMergesRoutesWithoutLosingManualAddressOrAuthorization() {
        val original = ComputerDetails().apply {
            uuid = "same-computer"
            localAddress = ComputerDetails.AddressTuple("192.168.1.10", 48789)
            manualAddress = ComputerDetails.AddressTuple("my-computer.local", 48789)
        }
        val bridge = ComputerDetails().apply {
            uuid = original.uuid
            embeddedAddress = ComputerDetails.AddressTuple("127.120.0.1", 48789)
        }
        original.update(bridge)
        assertEquals("my-computer.local", original.manualAddress.address)
        assertEquals("192.168.1.10", original.localAddress.address)
        assertEquals("127.120.0.1", ComputerDetails(original).embeddedAddress.address)
        original.update(ComputerDetails().apply {
            uuid = original.uuid
            localAddress = ComputerDetails.AddressTuple("192.168.1.20", 48789)
        })
        assertEquals("127.120.0.1", original.embeddedAddress.address)
        assertEquals("192.168.1.20", original.localAddress.address)
    }
}
