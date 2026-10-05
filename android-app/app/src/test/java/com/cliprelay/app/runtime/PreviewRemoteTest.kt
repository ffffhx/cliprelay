package com.cliprelay.app.runtime

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.*
import org.junit.Test

class PreviewRemoteTest {
    @Test fun interruptedScrollDoesNotEndTheSessionOrDropFollowingCommands() = runBlocking {
        val queue = PreviewRemote.attach()
        val reading = PreviewRemoteState(true, 2, 8, "text")
        PreviewRemote.update(queue, reading)
        val processed = Channel<Int>(Channel.UNLIMITED)
        var first = true
        val consumer = launch {
            try {
                PreviewRemote.consume(queue) { delta ->
                    if (first) {
                        first = false
                        throw CancellationException("Scroll replaced by a gesture or relayout")
                    }
                    processed.send(delta)
                }
            } finally { PreviewRemote.detach(queue) }
        }
        try {
            assertTrue(PreviewRemote.navigate(1))
            assertTrue(PreviewRemote.navigate(-1))
            assertTrue(PreviewRemote.navigate(1))
            withTimeout(2_000) {
                assertEquals(-1, processed.receive())
                assertEquals(1, processed.receive())
            }
            assertEquals(reading, PreviewRemote.snapshot())
            assertTrue(consumer.isActive)
        } finally { consumer.cancelAndJoin(); processed.close() }
        assertFalse(PreviewRemote.snapshot().active)
    }

    @Test fun leavingForegroundCancelsAnInFlightScrollAndDiscardsQueuedCommands() = runBlocking {
        val queue = PreviewRemote.attach()
        val started = CompletableDeferred<Unit>()
        val stopped = CompletableDeferred<Unit>()
        var calls = 0
        val consumer = launch {
            try {
                PreviewRemote.consume(queue) {
                    calls++
                    started.complete(Unit)
                    try { awaitCancellation() } finally { stopped.complete(Unit) }
                }
            } finally { PreviewRemote.detach(queue) }
        }
        try {
            assertTrue(PreviewRemote.navigate(1))
            withTimeout(2_000) { started.await() }
            assertTrue(PreviewRemote.navigate(1))
        } finally { consumer.cancelAndJoin() }
        assertTrue(stopped.isCompleted)
        assertEquals(1, calls)
        assertFalse(PreviewRemote.navigate(1))
        val replacement = PreviewRemote.attach()
        try { assertTrue(replacement.tryReceive().isFailure) } finally { PreviewRemote.detach(replacement) }
    }

    @Test fun stateBelongsOnlyToTheCurrentForegroundSession() {
        val first = PreviewRemote.attach()
        val textPage = PreviewRemoteState(true, 3, 8, "text")
        PreviewRemote.update(first, textPage)
        assertEquals(textPage, PreviewRemote.snapshot())
        val second = PreviewRemote.attach()
        try {
            assertFalse(PreviewRemote.snapshot().active)
            val imagePage = PreviewRemoteState(true, 2, 9, "image", moving = true)
            PreviewRemote.update(second, imagePage)
            PreviewRemote.update(first, textPage)
            PreviewRemote.detach(first)
            assertEquals(imagePage, PreviewRemote.snapshot())
            PreviewRemote.update(second, imagePage.copy(page = 3, moving = false))
            assertEquals(3, PreviewRemote.snapshot().page)
            assertFalse(PreviewRemote.snapshot().moving)
        } finally { PreviewRemote.detach(second) }
        assertEquals(PreviewRemoteState(), PreviewRemote.snapshot())
    }

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
