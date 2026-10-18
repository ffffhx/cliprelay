package com.cliprelay.app;

import com.limelight.binding.video.RenderedFrameTracker;
import com.limelight.nvstream.DisplayState;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class DisplayStateTest {
    private JSONObject snapshot() throws Exception {
        return new JSONObject().put("protocol", 1).put("supported", true)
                .put("instance", "ABCDEF01-2345-ABCD-EF01-23456789ABCD")
                .put("revision", 12).put("generation", 2).put("phase", "active")
                .put("displays", new JSONArray().put("left").put("right"))
                .put("capture", new JSONObject().put("id", "left"))
                .put("streams", new JSONArray().put(new JSONObject().put("id", 10).put("generation", 2).put("firstFrame", 150)));
    }

    @Test public void waitsForPresentedFrameAndCurrentCapture() throws Exception {
        DisplayState state = new DisplayState(snapshot());
        assertFalse(state.ready(149));
        assertTrue(state.ready(150));
        assertFalse(new DisplayState(snapshot().put("phase", "switching")).ready(200));
        assertFalse(new DisplayState(snapshot().put("generation", 3)).ready(200));
        assertFalse(new DisplayState(snapshot().put("capture", JSONObject.NULL)).ready(200));
        JSONObject noFrame = snapshot();
        noFrame.getJSONArray("streams").getJSONObject(0).put("firstFrame", 0);
        assertFalse(new DisplayState(noFrame).ready(200));
    }

    @Test public void preservesRequestIdentityAndRejectsAmbiguousStreams() throws Exception {
        DisplayState state = new DisplayState(snapshot());
        JSONObject selection = state.selection("right");
        assertEquals("right", selection.getString("display"));
        assertEquals(10, selection.getLong("stream"));
        assertEquals(12, selection.getLong("revision"));
        assertEquals(state.instance, selection.getString("instance"));
        assertTrue(state.sameBinding(new DisplayState(snapshot().put("revision", 99))));
        assertFalse(state.sameBinding(new DisplayState(snapshot().put("instance", "aaaaaaaa-2222-3333-4444-555555555555"))));
        JSONObject duplicate = snapshot();
        duplicate.getJSONArray("streams").put(new JSONObject().put("id", 11).put("generation", 2).put("firstFrame", 1));
        DisplayState ambiguous = new DisplayState(duplicate);
        assertFalse(ambiguous.ready(200));
        try { ambiguous.selection("right"); fail("ambiguous stream selected"); } catch (org.json.JSONException expected) { }
        try { state.selection("missing"); fail("unknown display selected"); } catch (org.json.JSONException expected) { }
    }

    @Test public void handlesLegacyHostWithoutClaimingSupport() throws Exception {
        DisplayState legacy = new DisplayState(new JSONObject().put("supported", false).put("error", "DISPLAY_UNSUPPORTED"));
        assertFalse(legacy.supported);
        assertFalse(legacy.ready(1000));
        assertTrue(legacy.displays.isEmpty());
        try { new DisplayState(snapshot().put("instance", "invalid")); fail("invalid engine identity"); } catch (org.json.JSONException expected) { }
    }

    @Test public void switchResumesOnlyOnKnownResultAndRenderedCurrentSession() throws Exception {
        DisplayState start = new DisplayState(snapshot().put("requestId", 5));
        JSONObject right = snapshot().put("capture", new JSONObject().put("id", "right"));
        assertEquals(DisplayState.SWITCH_WAIT, start.switchOutcome(start, "right", false, 200));
        assertEquals(DisplayState.SWITCH_WAIT, new DisplayState(right).switchOutcome(start, "right", false, 149));
        assertEquals(DisplayState.SWITCH_DONE, new DisplayState(right).switchOutcome(start, "right", false, 150));
        assertEquals(DisplayState.SWITCH_DONE, new DisplayState(right).switchOutcome(start, null, false, 150));
        assertEquals(DisplayState.SWITCH_WAIT, new DisplayState(right).switchOutcome(start, null, false, 149));
        JSONObject restart = new JSONObject(right.toString()).put("instance", "aaaaaaaa-2222-3333-4444-555555555555");
        assertEquals(DisplayState.SWITCH_WAIT, new DisplayState(restart).switchOutcome(start, "right", false, 200));
        JSONObject failed = snapshot().put("result", "failed").put("requested", "right").put("requestId", 5);
        assertEquals(DisplayState.SWITCH_WAIT, new DisplayState(failed).switchOutcome(start, "right", false, 200));
        failed.put("requestId", 6);
        assertEquals(DisplayState.SWITCH_FAILED, new DisplayState(failed).switchOutcome(start, "right", false, 200));
        assertEquals(DisplayState.SWITCH_FAILED, start.switchOutcome(start, "right", true, 200));
        assertEquals(DisplayState.SWITCH_WAIT, new DisplayState(snapshot().put("phase", "switching"))
                .switchOutcome(start, "right", true, 200));
    }

    @Test public void arrivalAndDroppedFramesDoNotEstablishPresentation() {
        RenderedFrameTracker tracker = new RenderedFrameTracker();
        tracker.queued(1000, 9);
        tracker.queued(2000, 10);
        assertEquals(0, tracker.lastRendered());
        tracker.discarded(1000);
        tracker.rendered(1000);
        assertEquals(0, tracker.lastRendered());
        tracker.rendered(2000);
        assertEquals(10, tracker.lastRendered());
        tracker.queued(3000, 11);
        tracker.queued(4000, 12);
        tracker.rendered(4000);
        tracker.rendered(3000);
        assertEquals(12, tracker.lastRendered());
        tracker.reset();
        tracker.rendered(4000);
        assertEquals(0, tracker.lastRendered());
    }

    @Test public void missingCallbacksStayBoundedAndUnknownTimesAreIgnored() {
        RenderedFrameTracker tracker = new RenderedFrameTracker();
        for (int i = 1; i <= 600; i++) tracker.queued(i, i);
        tracker.rendered(1); // evicted, no evidence that it was displayed
        tracker.rendered(700); // no submitted frame with this timestamp
        assertEquals(0, tracker.lastRendered());
        tracker.rendered(600);
        assertEquals(600, tracker.lastRendered());
        tracker.queued(0, 601);
        tracker.rendered(0);
        assertEquals(600, tracker.lastRendered());
    }
}
