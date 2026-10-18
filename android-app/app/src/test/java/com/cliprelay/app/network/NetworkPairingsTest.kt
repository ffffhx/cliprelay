package com.cliprelay.app.network

import com.limelight.computers.EmbeddedNetwork
import com.limelight.nvstream.http.ComputerDetails
import org.junit.Assert.*
import org.junit.Test

class NetworkPairingsTest {
    @Test fun migratesWithoutChangingTheOriginalAddressOrEncryptedCredential() {
        val catalog = NetworkPairings.migrate("encrypted-v1", true)
        val original = catalog.computers.single()
        assertEquals("127.120.0.1", original.address)
        assertEquals(47633, original.preferredPort)
        assertEquals("encrypted-v1", original.encryptedCredential)
        val updated = catalog.add("second", "Office", "encrypted-v2", "office-host")
        assertEquals(original, updated.computers.first())
        assertEquals("127.120.0.2", updated.computers.last().address)
        assertEquals(updated, NetworkPairings.decode(updated.encode()))
    }

    @Test fun preservesPausedLegacyPairingAndDoesNotEnableItWhenAddingAnother() {
        val catalog = NetworkPairings.migrate("encrypted-v1", false).add("second", "Office", "encrypted-v2")
        assertFalse(catalog.computers.first().enabled)
        assertTrue(catalog.computers.last().enabled)
    }

    @Test fun removingAndRevokingOneComputerPreservesOtherRoutesAndCredentials() {
        val original = NetworkPairings().add("a", "A", "secret-a").add("b", "B", "secret-b")
        val revoked = original.update("a") { it.copy(enabled = false) }
        assertEquals(original.computers[1], revoked.computers[1])
        val removed = revoked.remove("a").add("c", "C", "secret-c")
        assertEquals(original.computers[1], removed.computers[0])
        assertEquals("127.120.0.3", removed.computers[1].address)
        assertNotEquals(original.computers[0].address, removed.computers[1].address)
    }

    @Test fun reauthorizingSameHostKeepsItsAddressWithoutOverwritingAnotherHost() {
        val original = NetworkPairings().add("a", "A", "old-a", "host-a").add("b", "B", "old-b", "host-b")
        val updated = original.update("a") { it.copy(enabled = false) }.add("new-a", "Renamed A", "new-a", "host-a")
        assertEquals(2, updated.computers.size)
        assertEquals(original.nextSlot, updated.nextSlot)
        assertEquals(original.computers[0].id, updated.computers[0].id)
        assertEquals(original.computers[0].address, updated.computers[0].address)
        assertEquals("new-a", updated.computers[0].encryptedCredential)
        assertTrue(updated.computers[0].enabled)
        assertEquals(original.computers[1], updated.computers[1])
    }

    @Test fun oldWorkerCannotRecreateAnEntryAfterItWasRemoved() {
        val removed = NetworkPairings().add("a", "A", "secret-a").remove("a")
        assertEquals(removed, removed.update("a") { it.copy(computer = "late update") })
    }

    @Test fun everyAllocatedChannelHasAUniqueRecognizedAddressAndValidUdpPort() {
        val addresses = mutableSetOf<String>()
        val ports = mutableSetOf<Int>()
        for (slot in 1..NetworkPairings.MAX_SLOT) {
            val item = SavedNetworkPairing("$slot", slot, "PC", "encrypted")
            assertTrue(addresses.add(item.address))
            assertTrue(ports.add(item.preferredPort))
            assertTrue(item.preferredPort in 1024..65535)
            assertTrue(EmbeddedNetwork.isAddress(ComputerDetails.AddressTuple(item.address, 48789)))
        }
        for (address in listOf("127.0.0.1", "127.120.0.0", "127.120.0.256", "127.120.64.1", "127.120.00.1", "127.120.0.1.evil", "192.168.1.1")) {
            assertFalse(address, EmbeddedNetwork.isAddress(address))
        }
        assertFalse(EmbeddedNetwork.isAddress(ComputerDetails.AddressTuple("127.120.0.1", 47989)))
    }

    @Test fun malformedCatalogFailsWithoutSilentlyResettingSavedPairings() {
        for (value in listOf("{}", "{\"version\":3}",
            "{\"version\":2,\"nextSlot\":1,\"computers\":[{\"id\":\"a\",\"slot\":1,\"computer\":\"A\",\"credential\":\"x\",\"enabled\":true}]}")) {
            assertTrue(runCatching { NetworkPairings.decode(value) }.isFailure)
        }
        val duplicate = NetworkPairings().add("a", "A", "x").add("b", "B", "y").encode().replace("\"slot\":2", "\"slot\":1")
        assertTrue(runCatching { NetworkPairings.decode(duplicate) }.isFailure)
    }
}
