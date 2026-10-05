package com.cliprelay.app

import com.limelight.preferences.RemoteAddress
import org.junit.Assert.*
import org.junit.Test

class RemoteAddressTest {
    @Test fun supportsLanTailscaleAndIpv6Addresses() {
        for (host in listOf("192.168.0.100", "100.64.0.1", "desktop.tailnet.ts.net")) {
            val address = RemoteAddress.parse(" $host ")
            assertEquals(host, address.address)
            assertEquals(48789, address.port)
        }
        assertEquals(50000, RemoteAddress.parse("192.168.0.100:50000").port)
        assertEquals("fd7a:115c:a1e0::1", RemoteAddress.parse("fd7a:115c:a1e0::1").address)
        assertEquals(50000, RemoteAddress.parse("[fd7a:115c:a1e0::1]:50000").port)
    }

    @Test fun rejectsBadPortsAndAccidentallyPastedUrlComponents() {
        for (raw in listOf("", " ", "192.168.0.100:0", "192.168.0.100:70000",
            "192.168.0.100:-1", "192.168.0.100:", "192.168.0.100:abc", "999.1.1.1",
            "desktop/path", "user@desktop", "desktop?x=1", "desktop#fragment", "bad host")) {
            assertThrows(raw, IllegalArgumentException::class.java) { RemoteAddress.parse(raw) }
        }
    }
}
