package com.cliprelay.app

import com.limelight.nvstream.CellularDataPolicy
import com.limelight.nvstream.CellularDataPolicy.NetworkType.*
import com.limelight.nvstream.AdaptiveBitrateController
import org.junit.Assert.*
import org.junit.Test

class CellularDataPolicyTest {
    @Test fun automaticModeIgnoresBothLowAndHighSavedManualValues() {
        for (saved in listOf(500, 1_500, 20_000, 150_000)) {
            val policy = CellularDataPolicy.forStream(saved, 20_000, true, true)
            policy.update(UNMETERED)
            assertEquals(20_000, policy.initialBitrateKbps)
            assertEquals(40_000, policy.ceilingKbps)
        }
    }

    @Test fun formatDefaultsSelectDifferentStartingBudgetsAndQualityBounds() {
        for (format in listOf(2_000, 5_000, 10_000, 20_000, 40_000, 80_000)) {
            val policy = CellularDataPolicy.forStream(1_500, format, true, false)
            assertEquals(format, policy.initialBitrateKbps)
            assertEquals(minOf(150_000, format * 2), policy.ceilingKbps)
        }
    }

    @Test fun automaticBudgetSurvivesMeteredUnknownWifiHandovers() {
        val policy = CellularDataPolicy.forStream(1_500, 20_000, true, true)
        assertEquals(6_000, policy.initialBitrateKbps)
        for (type in listOf(CELLULAR, METERED, UNKNOWN)) {
            policy.update(type)
            assertEquals(6_000, policy.initialBitrateKbps)
            assertEquals(6_000, policy.ceilingKbps)
        }
        policy.update(UNMETERED)
        assertEquals(20_000, policy.initialBitrateKbps)
        assertEquals(40_000, policy.ceilingKbps)
    }

    @Test fun smallFormatsDoNotUseTheEntireCellularAllowance() {
        val policy = CellularDataPolicy.forStream(20_000, 2_000, true, true)
        policy.update(CELLULAR)
        assertEquals(2_000, policy.initialBitrateKbps)
        assertEquals(4_000, policy.ceilingKbps)
    }

    @Test fun disablingAutomaticModeRestoresTheSavedManualRate() {
        val policy = CellularDataPolicy.forStream(1_500, 20_000, false, true)
        for (type in values()) {
            policy.update(type)
            assertEquals(1_500, policy.initialBitrateKbps)
            assertEquals(1_500, policy.ceilingKbps)
        }
    }

    @Test fun generatedRangesStayInsideProtocolLimitsWithoutOverflow() {
        for (rate in listOf(Int.MIN_VALUE, -1, 0, Int.MAX_VALUE)) {
            val policy = CellularDataPolicy.forStream(20_000, rate, true, false)
            assertTrue(policy.initialBitrateKbps in 500..150_000)
            assertTrue(policy.ceilingKbps in policy.initialBitrateKbps..150_000)
        }
    }

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
        val adaptive = AdaptiveBitrateController(budget.initialBitrateKbps, budget.ceilingKbps)
        adaptive.onConnected(0)
        for (time in 10_000L..12_000L step 1_000) {
            adaptive.observe(AdaptiveBitrateController.Sample(time, 1_000, 100, 5, 20, 500_000), time)
        }
        assertEquals(4_500, adaptive.bitrateKbps)
        for (time in 13_000L..1_000_000L step 1_000) {
            adaptive.observe(AdaptiveBitrateController.Sample(time, 1_000, 100, 0, 20, 500_000), time)
            assertTrue(adaptive.bitrateKbps <= 6_000)
        }
        assertEquals(6_000, adaptive.bitrateKbps)
    }
}
