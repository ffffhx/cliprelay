package com.cliprelay.app.ui

import com.limelight.nvstream.http.ComputerDetails.State
import org.junit.Assert.*
import org.junit.Test

class DeviceDirectoryTest {
    @Test fun migratedComputersStayOnHomeWhileOfflineAndNeverAppearAsNew() {
        val directory = DeviceDirectory(setOf("home"))
        directory.update(HomeComputer("home", "ClipRelay - UCKF", State.UNKNOWN))
        directory.update(HomeComputer("new", "ClipRelay - YIFAN", State.ONLINE))
        directory.update(HomeComputer("home", "ClipRelay - UCKF", State.OFFLINE))
        assertEquals(listOf("home"), directory.saved().map { it.uuid })
        assertEquals(State.OFFLINE, directory.saved().single().state)
        assertEquals(listOf("new"), directory.nearby().map { it.uuid })
    }

    @Test fun addingAndRediscoveryUseStableIdentityEvenAfterNameChanges() {
        val directory = DeviceDirectory(emptySet())
        directory.update(HomeComputer("id", "ClipRelay - UCKF", State.ONLINE))
        directory.add("id")
        directory.update(HomeComputer("id", "ClipRelay - Office", State.ONLINE))
        assertTrue(directory.nearby().isEmpty())
        assertEquals("Office", directory.saved().single().displayName)
        assertEquals(setOf("id"), directory.savedIds)
    }

    @Test fun manualAndPairedComputersAreSavedButRemovalSurvivesLateUpdates() {
        val directory = DeviceDirectory(emptySet())
        val computer = HomeComputer("id", "Office", State.ONLINE)
        directory.update(computer, explicitlyAdded = true)
        assertEquals(listOf(computer), directory.saved())
        directory.remove("id")
        directory.update(computer, explicitlyAdded = true)
        assertTrue(directory.saved().isEmpty())
        assertEquals(listOf(computer), directory.nearby())
        directory.add("id")
        assertEquals(listOf(computer), directory.saved())
    }

    @Test fun unavailableDiscoveriesAreHiddenAndOnlyBrandPrefixIsRemoved() {
        val directory = DeviceDirectory(emptySet())
        directory.update(HomeComputer("id", "Office - ClipRelay", State.OFFLINE))
        assertTrue(directory.nearby().isEmpty())
        directory.update(HomeComputer("id", "Office - ClipRelay", State.ONLINE))
        assertEquals("Office - ClipRelay", directory.nearby().single().displayName)
    }
}
