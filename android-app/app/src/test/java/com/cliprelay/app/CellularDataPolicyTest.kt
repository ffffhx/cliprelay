package com.cliprelay.app

import com.limelight.nvstream.CellularDataPolicy
import com.limelight.nvstream.CellularDataPolicy.NetworkType.*
import com.limelight.nvstream.AdaptiveBitrateController
import org.junit.Assert.*
import org.junit.Test

class CellularDataPolicyTest {
    @Test fun cellularIsCappedEvenWhenCarrierMarksItTemporarilyFree() {
        for (free in listOf(false, true)) assertEquals(CELLULAR,
            CellularDataPolicy.classify(true, false, false, false, free))
    }

    @Test fun wifiAndEthernetRestoreWhileMeteredHotspotsRemainCapped() {
        assertEquals(UNMETERED, CellularDataPolicy.classify(false, true, false, false, true))
        assertEquals(UNMETERED, CellularDataPolicy.classify(false, false, true, false, true))
        assertEquals(METERED, CellularDataPolicy.classify(false, true, false, false, false))
    }

    @Test fun vpnReportsBothUnderlyingTransportsOrFallsBackToMetering() {
        assertEquals(CELLULAR, CellularDataPolicy.classify(true, true, false, true, true))
        assertEquals(UNMETERED, CellularDataPolicy.classify(false, true, false, true, true))
        assertEquals(METERED, CellularDataPolicy.classify(false, false, false, true, false))
    }

    @Test fun initialUnknownNetworkStartsConservatively() {
        val policy = CellularDataPolicy(20_000, true)
        assertTrue(policy.isSavingData)
        assertEquals(6_000, policy.ceilingKbps)
    }

    @Test fun repeatedCellularWifiSwitchesRestoreTheOriginalLimit() {
        val policy = CellularDataPolicy(20_000, true)
        repeat(3) {
            policy.update(UNMETERED)
            assertFalse(policy.isSavingData)
            assertEquals(20_000, policy.ceilingKbps)
            policy.update(CELLULAR)
            assertTrue(policy.isSavingData)
            assertEquals(6_000, policy.ceilingKbps)
            policy.update(UNKNOWN)
            assertEquals(6_000, policy.ceilingKbps)
        }
    }

    @Test fun lowerUserLimitIsNeverRaised() {
        val policy = CellularDataPolicy(1_500, true)
        for (type in values()) {
            policy.update(type)
            assertEquals(1_500, policy.ceilingKbps)
        }
    }

    @Test fun optingOutPreservesManualLimitOnEveryNetwork() {
        val policy = CellularDataPolicy(20_000, false)
        for (type in values()) {
            policy.update(type)
            assertFalse(policy.isSavingData)
            assertEquals(20_000, policy.ceilingKbps)
        }
    }

    @Test fun meteredHotspotsAndVpnFallbackAlsoSaveData() {
        val policy = CellularDataPolicy(20_000, true)
        policy.update(UNMETERED)
        policy.update(METERED)
        assertEquals(6_000, policy.ceilingKbps)
    }

    @Test fun congestionControlCannotRecoverBeyondCellularCap() {
        val budget = CellularDataPolicy(20_000, true)
        budget.update(CELLULAR)
        val adaptive = AdaptiveBitrateController(budget.ceilingKbps)
        adaptive.onConnected(0)
        for (time in 10_000L..12_000L step 1_000) {
            adaptive.observe(AdaptiveBitrateController.Sample(time, 1_000, 100, 5, 20), time)
        }
        assertEquals(4_500, adaptive.bitrateKbps)
        for (time in 13_000L..1_000_000L step 1_000) {
            adaptive.observe(AdaptiveBitrateController.Sample(time, 1_000, 100, 0, 20), time)
            assertTrue(adaptive.bitrateKbps <= 6_000)
        }
        assertEquals(6_000, adaptive.bitrateKbps)
    }
}
