package com.cliprelay.app.runtime

import org.junit.Assert.*
import org.junit.Test

class PreviewRemoteTest {
    @Test fun commandsAreOrderedAndNeverReplayAcrossSessions() {
        assertFalse(PreviewRemote.navigate(1))
        val first = PreviewRemote.attach()
        try {
            assertTrue(PreviewRemote.navigate(1))
            assertTrue(PreviewRemote.navigate(-1))
            assertEquals(1, first.tryReceive().getOrNull())
            assertEquals(-1, first.tryReceive().getOrNull())
            assertTrue(PreviewRemote.navigate(1))
        } finally { PreviewRemote.detach(first) }
        assertFalse(PreviewRemote.navigate(-1))
        val second = PreviewRemote.attach()
        try {
            PreviewRemote.detach(first)
            assertTrue(second.tryReceive().isFailure)
            repeat(32) { assertTrue(PreviewRemote.navigate(1)) }
            assertFalse(PreviewRemote.navigate(1))
        } finally { PreviewRemote.detach(second) }
    }
}
