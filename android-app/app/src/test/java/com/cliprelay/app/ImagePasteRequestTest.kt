package com.cliprelay.app

import com.limelight.ui.ImagePasteRequest
import com.limelight.ui.GameInputState
import org.junit.Assert.*
import org.junit.Test

class ImagePasteRequestTest {
    private val events = mutableListOf<String>()
    private val sink = GameInputState.KeySink { key, down, modifiers -> events += "$key:$down:$modifiers" }
    private val paste = listOf("17:true:2", "86:true:2", "86:false:2", "17:false:0")

    @Test fun cancelAndFailedUploadNeverPaste() {
        val request = ImagePasteRequest()
        assertFalse(request.dispatch(true, true, true, false, sink))
        assertTrue(events.isEmpty())
    }

    @Test fun successfulUploadWaitsForConnectedForegroundStream() {
        val request = ImagePasteRequest().apply { uploaded() }
        assertFalse(request.dispatch(false, true, true, false, sink))
        assertFalse(request.dispatch(true, false, true, false, sink))
        assertFalse(request.dispatch(true, true, false, false, sink))
        assertFalse(request.dispatch(true, true, true, true, sink))
        assertTrue(request.isPending)
        assertTrue(events.isEmpty())
        assertTrue(request.dispatch(true, true, true, false, sink))
        assertEquals(paste, events)
    }

    @Test fun resumeAndNetworkReconnectDoNotRepeatPasteOrSubmit() {
        val request = ImagePasteRequest().apply { uploaded() }
        assertTrue(request.dispatch(true, true, true, false, sink))
        repeat(3) {
            assertFalse(request.dispatch(false, false, false, false, sink))
            assertFalse(request.dispatch(true, true, true, false, sink))
        }
        assertEquals(paste, events)
        assertFalse(request.isPending)
        request.uploaded()
        assertTrue(request.dispatch(true, true, true, false, sink))
        assertEquals(paste + paste, events)
    }
}
