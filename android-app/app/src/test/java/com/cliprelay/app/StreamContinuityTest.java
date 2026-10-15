package com.cliprelay.app;

import com.limelight.nvstream.StreamContinuity;
import com.limelight.binding.video.RenderedFrameTracker;
import org.junit.Test;
import static org.junit.Assert.*;

public class StreamContinuityTest {
    @Test public void changingNetworksKeepsAHealthyConnection() {
        StreamContinuity state = new StreamContinuity();
        state.activate(1000, 100);
        assertEquals(StreamContinuity.Action.FLOWING, state.observe(1100, 103, 1080, true));
        state.networkChanged(1150, 103, true);
        assertTrue(state.routePending());
        assertEquals(StreamContinuity.Action.FLOWING, state.observe(1250, 106, 1230, true));
        assertFalse(state.routePending());
        assertFalse(state.inputPaused());
        // Same network type can still identify a different Wi-Fi/AP route.
        state.networkChanged(1500, 110, true);
        assertEquals(StreamContinuity.Action.FLOWING, state.observe(1600, 113, 1580, true));
        assertFalse(state.routePending());
    }

    @Test public void networkLossPausesImmediatelyAndNeedsFreshCaptureMetadata() {
        StreamContinuity state = new StreamContinuity();
        state.activate(1000, 100);
        state.observe(1100, 103, 1080, true);
        state.networkChanged(1200, 103, false);
        assertTrue(state.inputPaused());
        // A buffered frame received before the loss cannot re-enable input.
        assertEquals(StreamContinuity.Action.PAUSED, state.observe(1300, 104, 1190, true));
        state.networkChanged(1350, 104, true);
        assertEquals(StreamContinuity.Action.PAUSED, state.observe(1450, 108, 1430, false));
        assertEquals(StreamContinuity.Action.FLOWING, state.observe(1500, 109, 1480, true));
        assertFalse(state.inputPaused());
    }

    @Test public void freezesReleaseInputAndHaveABoundedReconnect() {
        StreamContinuity state = new StreamContinuity();
        state.activate(1000, 100);
        state.observe(1100, 103, 1080, true);
        assertEquals(StreamContinuity.Action.WAITING, state.observe(3079, 103, 1080, true));
        assertEquals(StreamContinuity.Action.PAUSED, state.observe(3080, 103, 1080, true));
        assertEquals(StreamContinuity.Action.PAUSED, state.observe(9079, 103, 1080, true));
        assertEquals(StreamContinuity.Action.RECONNECT, state.observe(9080, 103, 1080, true));
        assertEquals(StreamContinuity.Action.PAUSED, state.observe(9500, 103, 1080, true));
    }

    @Test public void invalidAndRepeatedFramesCannotHideAnOutage() {
        StreamContinuity state = new StreamContinuity();
        state.activate(1000, 100);
        state.observe(1100, 103, 1080, true);
        state.observe(2000, 103, 1980, true); // same picture, fabricated newer timestamp
        state.observe(2500, 104, 9000, true); // future receive timestamp
        state.observe(2700, 102, 2690, true); // out-of-order callback
        assertEquals(StreamContinuity.Action.PAUSED, state.observe(3080, 103, 1080, true));
    }

    @Test public void freshVideoCannotBypassUnconfirmedDisplayBinding() {
        StreamContinuity state = new StreamContinuity();
        state.activate(1000, 100);
        state.networkChanged(1200, 100, false);
        for (int i = 0; i < 5; ++i)
            assertEquals(StreamContinuity.Action.PAUSED, state.observe(2000 + i * 1000, 130 + i * 30, 1990 + i * 1000, false));
        assertEquals(StreamContinuity.Action.RECONNECT, state.observe(7200, 300, 7190, false));
    }

    @Test public void backgroundTimeDoesNotConsumeTheRecoveryWindow() {
        StreamContinuity state = new StreamContinuity();
        state.activate(1000, 100);
        state.networkChanged(1200, 100, false);
        state.suspend();
        assertEquals(StreamContinuity.Action.PAUSED, state.observe(30000, 100, 1080, true));
        state.activate(31000, 100);
        assertEquals(StreamContinuity.Action.PAUSED, state.observe(31100, 101, 30000, true));
        assertEquals(StreamContinuity.Action.FLOWING, state.observe(31200, 103, 31180, true));
    }

    @Test public void retryBudgetSurvivesActivityRecreationAndAllowsManualRetry() {
        StreamContinuity.RecoveryBudget retained = new StreamContinuity.RecoveryBudget();
        assertTrue(retained.take(1000));
        assertTrue(retained.take(10000));
        assertFalse(retained.take(20000));
        assertFalse(retained.take(60999));
        assertTrue(retained.take(61000));
        assertTrue(retained.take(62000));
        assertFalse(retained.take(63000));
        retained.reset();
        assertTrue(retained.take(64000));
    }

    @Test public void receiveTimeMustBelongToTheActuallyPresentedFrame() {
        RenderedFrameTracker tracker = new RenderedFrameTracker();
        tracker.queued(10000, 10, 1000);
        tracker.queued(20000, 11, 1200);
        assertEquals(0, tracker.presentation().receivedAtMs);
        tracker.rendered(10000);
        assertEquals(10, tracker.presentation().frame);
        assertEquals(1000, tracker.presentation().receivedAtMs);
        tracker.discarded(20000);
        tracker.rendered(20000);
        assertEquals(1000, tracker.presentation().receivedAtMs);
        tracker.queued(30000, 12, 2000);
        tracker.rendered(30000);
        assertEquals(2000, tracker.presentation().receivedAtMs);
        tracker.reset();
        assertEquals(0, tracker.presentation().frame);
        assertEquals(0, tracker.presentation().receivedAtMs);
    }
}
