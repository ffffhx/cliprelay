package com.cliprelay.app

import com.limelight.binding.input.touch.NativeTouchState
import com.limelight.nvstream.jni.MoonBridge
import org.junit.Assert.*
import org.junit.Test

class NativeTouchStateTest {
    private data class Contact(val type: Byte, val id: Int, val x: Float, val y: Float)
    private val events = mutableListOf<Contact>()
    private var failType: Byte? = null
    private var error = -1
    private val state = NativeTouchState { type, id, x, y ->
        events += Contact(type, id, x, y)
        if (type == failType) error else 0
    }
    private val down = MoonBridge.LI_TOUCH_EVENT_DOWN
    private val move = MoonBridge.LI_TOUCH_EVENT_MOVE
    private val up = MoonBridge.LI_TOUCH_EVENT_UP
    private val cancel = MoonBridge.LI_TOUCH_EVENT_CANCEL_ALL

    @Test fun twoFingersKeepTheirIdsWhenFirstFingerLifts() {
        state.begin()
        state.down(7, .2f, .3f)
        state.down(19, .8f, .3f)
        state.move(7, .1f, .3f)
        state.move(19, .9f, .3f)
        state.up(7, .1f, .3f, false)
        state.move(19, .8f, .4f)
        state.up(19, .8f, .4f, false)
        state.cancel()
        assertEquals(listOf(down to 7, down to 19, move to 7, move to 19, up to 7, move to 19, up to 19),
            events.map { it.type to it.id })
    }

    @Test fun interruptionsCancelAllAndIgnoreRemainderOfGesture() {
        repeat(3) {
            state.begin()
            state.down(4, .5f, .5f)
            state.down(9, .7f, .5f)
            state.cancel()
            val count = events.size
            state.move(4, .4f, .5f)
            state.up(9, .7f, .5f, false)
            state.down(12, .6f, .5f)
            state.cancel()
            assertEquals(count, events.size)
            assertEquals(cancel, events.last().type)
        }
    }

    @Test fun blackBarsCannotActivateScreenEdgesButAnActiveDragCanReachThem() {
        state.begin()
        state.down(1, -.1f, .5f)
        state.move(1, .1f, .5f)
        state.up(1, .1f, .5f, false)
        assertTrue(events.isEmpty())
        state.down(3, .5f, .5f)
        state.move(3, 1.4f, -.3f)
        assertEquals(Contact(move, 3, 1f, 0f), events.last())
    }

    @Test fun cancelledPointerDoesNotCommitTapAndOtherFingerContinues() {
        state.begin()
        state.down(2, .2f, .5f)
        state.down(8, .8f, .5f)
        state.up(2, .2f, .5f, true)
        state.move(8, .7f, .5f)
        state.up(8, .7f, .5f, false)
        assertEquals(MoonBridge.LI_TOUCH_EVENT_CANCEL, events[2].type)
        assertEquals(Contact(up, 8, .7f, .5f), events.last())
    }

    @Test fun unsupportedHostNeverLeavesAContactOrProducesOrphanUp() {
        failType = down; error = MoonBridge.LI_ERR_UNSUPPORTED
        state.begin()
        assertEquals(error, state.down(3, .4f, .4f))
        state.move(3, .5f, .5f)
        state.up(3, .5f, .5f, false)
        assertEquals(1, events.size)
    }

    @Test fun transportFailureCancelsContactsAndRetriesCleanupBeforeNextGesture() {
        state.begin()
        state.down(1, .5f, .5f)
        failType = cancel
        state.cancel()
        state.begin()
        state.down(2, .5f, .5f)
        assertEquals(listOf(down, cancel, cancel), events.map { it.type })
        failType = null
        state.begin()
        state.down(3, .5f, .5f)
        assertEquals(listOf(down, cancel, cancel, cancel, down), events.map { it.type })
    }

    @Test fun droppedMoveCancelsGestureInsteadOfSendingTapOnLift() {
        state.begin()
        state.down(5, .2f, .2f)
        failType = move
        state.move(5, .3f, .3f)
        state.up(5, .3f, .3f, false)
        assertEquals(listOf(down, move, cancel), events.map { it.type })
    }

    @Test fun invalidCoordinatesAndDuplicateContactsAreRejected() {
        state.begin()
        state.down(1, Float.NaN, .4f)
        state.down(-1, .4f, .4f)
        assertTrue(events.isEmpty())
        state.down(1, .4f, .4f)
        state.down(1, .6f, .4f)
        assertEquals(1, events.size)
        state.move(1, Float.POSITIVE_INFINITY, .5f)
        assertEquals(cancel, events.last().type)
    }
}
