package com.cliprelay.app.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ClipRelayDiscoveryTest {
    @Test
    fun serviceContractMatchesDesktopDiscovery() {
        assertEquals("_cliprelay._tcp.", ClipRelayDiscovery.SERVICE_TYPE)
        val records = ClipRelayDiscovery.txtRecords(
            deviceId = "device-123",
            requiresAuth = true,
            brand = "OnePlus",
            model = "PHK110",
        )

        assertEquals("device-123", records["id"])
        assertEquals("1", records["version"])
        assertEquals("android", records["platform"])
        assertEquals("required", records["auth"])
        assertEquals("OnePlus", records["brand"])
        assertEquals("PHK110", records["model"])
        assertFalse(records.containsKey("token"))
        assertFalse(records.containsKey("accessToken"))
    }

    @Test
    fun deviceNameIsSafeAndBounded() {
        assertEquals("Android", ClipRelayDiscovery.normalizeDeviceName(" \n\r "))
        assertEquals(
            "a".repeat(ClipRelayDiscovery.MAX_DEVICE_NAME_LENGTH),
            ClipRelayDiscovery.normalizeDeviceName("a".repeat(80)),
        )
    }

    @Test
    fun automaticNameCombinesBrandAndModelWithoutDuplication() {
        assertEquals(
            "realme RMX5002",
            ClipRelayDiscovery.defaultDeviceName("realme", "realme", "RMX5002"),
        )
        assertEquals(
            "OnePlus PHK110",
            ClipRelayDiscovery.defaultDeviceName("OnePlus", "OnePlus", "PHK110"),
        )
        assertEquals(
            "Google Pixel 10",
            ClipRelayDiscovery.defaultDeviceName("Google", "Google", "Google Pixel 10"),
        )
        assertEquals(
            "Xiaomi 15",
            ClipRelayDiscovery.defaultDeviceName("generic", "Xiaomi", "15"),
        )
    }
}
