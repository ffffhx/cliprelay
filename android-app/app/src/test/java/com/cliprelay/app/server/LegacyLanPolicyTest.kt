package com.cliprelay.app.server

import java.net.InetAddress
import org.junit.Assert.*
import org.junit.Test

class LegacyLanPolicyTest {
    @Test fun onlyExplicitCompatibilityAndLocalAddressesAreAllowed() {
        for (host in listOf("127.0.0.1", "10.2.3.4", "172.16.1.1", "172.31.255.254", "192.168.1.2", "169.254.1.1", "::1", "fd12::1", "fc00::1", "fe80::1", "::ffff:192.168.1.2")) {
            val address = InetAddress.getByName(host)
            assertTrue(host, LegacyLanPolicy.allows(true, address))
            assertFalse(host, LegacyLanPolicy.allows(false, address))
        }
        for (host in listOf("0.0.0.0", "8.8.8.8", "192.0.2.1", "100.64.1.1", "172.15.1.1", "172.32.1.1", "224.0.0.1", "::", "2001:db8::1", "ff02::1", "::ffff:8.8.8.8")) {
            assertFalse(host, LegacyLanPolicy.allows(true, InetAddress.getByName(host)))
        }
    }
}
