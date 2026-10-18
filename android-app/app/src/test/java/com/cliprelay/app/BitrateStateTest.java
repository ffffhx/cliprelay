package com.cliprelay.app;

import com.limelight.nvstream.AdaptiveBitrateController;
import com.limelight.nvstream.BitrateState;
import com.limelight.nvstream.DisplayState;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class BitrateStateTest {
    private static final String INSTANCE = "ABCDEF01-2345-ABCD-EF01-23456789ABCD";
    private JSONObject snapshot() throws Exception {
        return new JSONObject().put("protocol", 1).put("supported", true).put("instance", INSTANCE)
                .put("streams", new JSONArray().put(new JSONObject().put("id", 10).put("revision", 3)
                        .put("supported", true).put("requestId", 1).put("appliedFrame", 100)
                        .put("budgetKbps", 5000).put("videoKbps", 3500).put("requestedKbps", 5000)
                        .put("result", "applied").put("error", "")));
    }
    private JSONObject stream(JSONObject state) throws Exception { return state.getJSONArray("streams").getJSONObject(0); }
    private JSONObject changed() throws Exception {
        JSONObject state = snapshot();
        stream(state).put("requestId", 2).put("revision", 5).put("budgetKbps", 2000)
                .put("videoKbps", 1200).put("requestedKbps", 2000).put("appliedFrame", 200);
        return state;
    }
    private DisplayState display(long id) throws Exception {
        return new DisplayState(new JSONObject().put("protocol", 1).put("supported", true).put("instance", INSTANCE)
                .put("phase", "active").put("generation", 1).put("revision", 1)
                .put("streams", new JSONArray().put(new JSONObject().put("id", id))));
    }

    @Test public void confirmationRequiresNewRequestAndPresentedFrame() throws Exception {
        BitrateState before = new BitrateState(snapshot()), after = new BitrateState(changed());
        assertFalse(after.confirms(before, 2000, 199));
        assertTrue(after.confirms(before, 2000, 200));
        assertFalse(after.confirms(after, 2000, 250));
        assertFalse(after.confirms(before, 3000, 250));
        JSONObject pending = changed(); stream(pending).put("result", "pending");
        assertFalse(new BitrateState(pending).confirms(before, 2000, 250));
    }

    @Test public void cannotRetargetAfterEngineRestartOrStreamReuse() throws Exception {
        BitrateState before = new BitrateState(snapshot());
        assertTrue(before.matches(display(10)));
        assertFalse(before.matches(display(11)));
        JSONObject other = changed(); stream(other).put("id", 11);
        assertFalse(new BitrateState(other).confirms(before, 2000, 250));
        other = changed().put("instance", "aaaaaaaa-2222-3333-4444-555555555555");
        assertFalse(new BitrateState(other).confirms(before, 2000, 250));
        assertFalse(new BitrateState(other).matches(display(10)));
        JSONObject selection = before.selection(2000);
        assertEquals(4, selection.length());
        assertFalse(selection.has("owner"));
        assertEquals(10, selection.getLong("stream"));
    }

    @Test public void handlesLegacyUnsupportedAndAmbiguousStreams() throws Exception {
        assertFalse(new BitrateState(new JSONObject().put("supported", false)).supported);
        JSONObject ambiguous = snapshot(); ambiguous.getJSONArray("streams").put(stream(snapshot()).put("id", 11));
        BitrateState state = new BitrateState(ambiguous);
        assertFalse(state.matches(display(10)));
        try { state.selection(2000); fail("ambiguous request"); } catch (JSONException expected) { }
        JSONObject unsupported = snapshot(); stream(unsupported).put("supported", false);
        try { new BitrateState(unsupported).selection(2000); fail("unsupported encoder"); } catch (JSONException expected) { }
    }

    @Test public void boundsAndFailureRemainExplicit() throws Exception {
        BitrateState before = new BitrateState(snapshot());
        for (int budget : new int[]{499, 150001}) {
            try { before.selection(budget); fail("unbounded budget"); } catch (JSONException expected) { }
        }
        for (Object bad : new Object[]{-1, 1.5, "2000", JSONObject.NULL}) {
            JSONObject state = changed(); stream(state).put("budgetKbps", bad);
            try { new BitrateState(state); fail("invalid numeric rate"); } catch (JSONException expected) { }
        }
        JSONObject failed = snapshot(); stream(failed).put("requestId", 2).put("requestedKbps", 2000)
                .put("result", "failed").put("error", "encoder_rejected").put("appliedFrame", 0);
        BitrateState state = new BitrateState(failed);
        assertTrue(state.rejects(before, 2000));
        assertFalse(state.rejects(before, 3000));
        assertFalse(state.confirms(before, 2000, 200));
        assertEquals(5000, state.budgetKbps);
    }

    @Test public void rejectedProbeRestoresActualRateAndKeepsCooldown() {
        AdaptiveBitrateController policy = new AdaptiveBitrateController(5000, 10000);
        policy.onConnected(0);
        policy.onRateRejected(5000, 50000);
        for (int i = 1; i <= 3; i++) {
            long now = 50000 + i * 1000;
            assertEquals(0, policy.observe(new AdaptiveBitrateController.Sample(now, 1000, 30, 15, 30, 300000), now));
        }
        assertEquals(5000, policy.getBitrateKbps());
        policy.onRateRejected(150000, 55000);
        assertEquals(10000, policy.getBitrateKbps());
    }
}
