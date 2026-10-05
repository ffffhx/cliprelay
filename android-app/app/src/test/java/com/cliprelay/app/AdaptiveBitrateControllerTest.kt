package com.cliprelay.app

import com.limelight.nvstream.AdaptiveBitrateController
import com.limelight.nvstream.AdaptiveBitrateController.Sample
import org.junit.Assert.*
import org.junit.Test

class AdaptiveBitrateControllerTest {
    private var now = 0L
    private var policy = AdaptiveBitrateController(20_000).also { it.onConnected(now) }
    private fun tick(loss: Int = 0, rtt: Int = 20): Int {
        now += 1_000
        return policy.observe(Sample(now, 1_000, 100, loss, rtt), now)
    }
    private fun warmup() { repeat(10) { tick() } }
    private fun lower(): Int {
        warmup()
        assertEquals(0, tick(10))
        assertEquals(0, tick(10))
        return tick(10)
    }
    private fun recover(): Int {
        repeat(220) {
            val result = tick()
            if (result != 0) return result
        }
        fail("No recovery after sustained fresh, healthy samples")
        return 0
    }

    @Test fun healthyConnectionKeepsUserCeiling() {
        repeat(600) { assertEquals(0, tick()) }
        assertEquals(20_000, policy.bitrateKbps)
    }

    @Test fun transientAndIntermittentLossDoesNotReconnect() {
        warmup()
        repeat(40) {
            assertEquals(0, tick(35))
            assertEquals(0, tick())
        }
    }

    @Test fun startupLossIsIgnored() {
        repeat(9) { assertEquals(0, tick(50)) }
        assertEquals(20_000, policy.bitrateKbps)
    }

    @Test fun sustainedLossLowersRateWithoutChangingCeiling() {
        assertEquals(15_000, lower())
        assertEquals(20_000, policy.ceilingKbps)
    }

    @Test fun severeLossLowersFaster() {
        warmup()
        assertEquals(0, tick(30))
        assertEquals(12_000, tick(30))
    }

    @Test fun reconnectPreservesCooldown() {
        lower()
        policy.onConnected(now)
        repeat(29) { assertEquals(0, tick(10)) }
        assertEquals(11_000, tick(10))
    }

    @Test fun prolongedCongestionStopsAtFloor() {
        warmup()
        val changes = mutableListOf<Pair<Long, Int>>()
        repeat(350) {
            val rate = tick(40)
            if (rate > 0) {
                changes += now to rate
                policy.onConnected(now)
            }
        }
        assertEquals(4_000, policy.bitrateKbps)
        assertTrue(changes.zipWithNext().all { (a, b) -> b.first - a.first >= 30_000 })
        assertTrue(changes.all { it.second >= 4_000 })
    }

    @Test fun lowManualCeilingIsNeverRaisedToDefaultFloor() {
        policy = AdaptiveBitrateController(1_500).also { it.onConnected(now) }
        repeat(300) { assertEquals(0, tick(if (it < 100) 50 else 0)) }
        assertEquals(1_500, policy.bitrateKbps)
    }

    @Test fun recoveryIsSlowAndSmall() {
        lower()
        policy.onConnected(now)
        repeat(179) { assertEquals(0, tick()) }
        assertEquals(16_500, recover())
        assertEquals(20_000, policy.ceilingKbps)
    }

    @Test fun recoveryNeverExceedsUserCeiling() {
        policy = AdaptiveBitrateController(5_000).also { it.onConnected(now) }
        assertEquals(4_000, lower())
        policy.onConnected(now)
        assertEquals(4_500, recover())
        policy.onConnected(now)
        assertEquals(5_000, recover())
        repeat(300) { assertEquals(0, tick()) }
    }

    @Test fun failedRecoveryProbeBacksOffForTenMinutes() {
        lower()
        policy.onConnected(now)
        val rate = recover()
        assertEquals(16_500, rate)
        policy.onConnected(now)
        var fallback = 0
        repeat(30) { fallback = tick(10).takeIf { it != 0 } ?: fallback }
        assertTrue(fallback in 4_000..15_000)
        policy.onConnected(now)
        repeat(599) { assertEquals(0, tick()) }
        assertTrue(recover() > fallback)
    }

    @Test fun duplicateAndStaleSamplesCannotAccumulateEvidence() {
        warmup()
        val sample = Sample(now, 1_000, 100, 40, 20)
        repeat(20) { assertEquals(0, policy.observe(sample, now)) }
        now += 4_000
        assertEquals(0, policy.observe(sample, now))
        assertEquals(0, tick(40))
    }

    @Test fun silenceAndMissingRttDoNotCauseRecovery() {
        lower()
        policy.onConnected(now)
        repeat(300) {
            now += 1_000
            assertEquals(0, policy.observe(null, now))
        }
        repeat(300) { assertEquals(0, tick(rtt = -1)) }
        assertEquals(15_000, policy.bitrateKbps)
    }

    @Test fun highRttAloneDoesNotCutRateAndBlocksRecovery() {
        lower()
        policy.onConnected(now)
        repeat(300) { assertEquals(0, tick(rtt = 200)) }
        assertEquals(15_000, policy.bitrateKbps)
    }

    @Test fun subMillisecondLanRttAllowsRecovery() {
        lower()
        policy.onConnected(now)
        var recovered = 0
        repeat(220) { recovered = tick(rtt = 0).takeIf { it > 0 } ?: recovered }
        assertEquals(16_500, recovered)
    }

    @Test fun pauseBreaksConsecutiveLossEvidence() {
        warmup()
        tick(10)
        tick(10)
        policy.resetObservation()
        assertEquals(0, tick(10))
        assertEquals(0, tick(10))
        assertEquals(15_000, tick(10))
    }

    @Test fun invalidSamplesCannotTriggerAnAdjustment() {
        warmup()
        repeat(20) {
            now += 1_000
            for (sample in listOf(
                Sample(now, 1_000, 0, 0, 20), Sample(now, 1_000, 10, 20, 20),
                Sample(now, 1_000, 100, -1, 20), Sample(now, 5_000, 100, 40, 20),
                Sample(now + 1_000, 1_000, 100, 40, 20)
            )) assertEquals(0, policy.observe(sample, now))
        }
        assertEquals(20_000, policy.bitrateKbps)
    }
}
