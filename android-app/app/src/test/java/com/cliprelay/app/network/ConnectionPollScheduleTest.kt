package com.cliprelay.app.network

import org.junit.Assert.*
import org.junit.Test

class ConnectionPollScheduleTest {
    @Test fun backgroundSettlesWithoutStoppingHealthChecks() {
        val policy = ConnectionPollSchedule()
        assertEquals(listOf(3000L, 6000L, 12000L, 24000L, 30000L, 30000L),
            List(6) { policy.next("ready:host", false) })
    }
    @Test fun foregroundAndChangedRouteRecoverFastCadence() {
        val policy = ConnectionPollSchedule()
        repeat(8) { policy.next("ready:old", false) }
        assertEquals(3000L, policy.next("ready:new", false))
        repeat(8) { assertEquals(3000L, policy.next("ready:new", true)) }
        assertEquals(3000L, policy.next("ready:new", false))
    }
    @Test fun networkSignalAndFailureRecoveryResetBackoff() {
        val policy = ConnectionPollSchedule()
        repeat(8) { policy.next("unavailable", false) }
        policy.reset()
        assertEquals(3000L, policy.next("unavailable", false))
        assertEquals(3000L, policy.next("ready:host", false))
        assertEquals(3000L, policy.next("unavailable", false))
    }
    @Test fun computersDoNotShareRetryState() {
        val first = ConnectionPollSchedule()
        val second = ConnectionPollSchedule()
        repeat(6) { first.next("unavailable", false) }
        assertEquals(3000L, second.next("ready:other", false))
        assertEquals(30000L, first.next("unavailable", false))
    }
}
