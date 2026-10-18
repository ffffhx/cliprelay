package com.cliprelay.app;

import com.limelight.nvstream.InputPause;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import static org.junit.Assert.*;

public class InputPauseTest {
    @Test public void releasesHeldInputOnceWithoutReplayingIt() {
        InputPause state = new InputPause();
        List<String> events = new ArrayList<>();
        InputPause.Releases releases = new InputPause.Releases() {
            public void key(short key) { events.add("key:" + key); }
            public void button(byte button) { events.add("button:" + button); }
            public void touches() { events.add("touch"); }
            public void pen() { events.add("pen"); }
            public void controller(short number, short mask) { events.add("pad:" + number + ":" + mask); }
            public void controllerTouch(byte number, int pointer, float x, float y) { events.add("contact:" + number + ":" + pointer + ":" + x + ":" + y); }
        };
        state.key((short)17, true); state.key((short)65, true); state.key((short)65, false);
        state.button((byte)1, true); state.button((byte)2, true); state.button((byte)2, false);
        state.touch(); state.pen(); state.controller((short)5);
        state.controllerTouch((byte)0, (byte)1, 8, .2f, .3f);
        state.controllerTouch((byte)0, (byte)3, 8, .4f, .5f);
        state.controllerTouch((byte)0, (byte)1, 9, .2f, .3f);
        state.controllerTouch((byte)0, (byte)2, 9, .2f, .3f);
        state.setPaused(true, releases);
        assertEquals(7, events.size());
        assertTrue(events.contains("contact:0:8:0.4:0.5"));
        assertTrue(events.contains("key:17")); assertFalse(events.contains("key:65"));
        assertTrue(events.contains("button:1")); assertFalse(events.contains("button:2"));
        assertTrue(events.contains("touch")); assertTrue(events.contains("pen"));
        assertTrue(events.contains("pad:0:5")); assertTrue(events.contains("pad:2:5"));
        assertFalse(state.allowed()); assertFalse(state.key((short)66, true));
        assertFalse(state.button((byte)3, true)); assertFalse(state.touch()); assertFalse(state.pen());
        assertFalse(state.controller((short)7));
        state.setPaused(true, releases);
        assertEquals(7, events.size());
        state.setPaused(false, releases);
        assertTrue(state.allowed()); assertEquals(7, events.size());
        state.setPaused(true, releases);
        assertEquals(7, events.size());
        state.setPaused(InputPause.NETWORK, true, releases);
        state.setPaused(InputPause.DISPLAY, false, releases);
        assertFalse(state.allowed());
        assertFalse(state.key((short)70, true));
        state.setPaused(InputPause.NETWORK, false, releases);
        assertTrue(state.allowed());
        assertEquals(7, events.size());
        state.key((short)70, true);
        state.setPaused(InputPause.NETWORK, true, releases);
        state.setPaused(InputPause.DISPLAY, true, releases);
        state.setPaused(InputPause.NETWORK, false, releases);
        assertFalse(state.allowed());
        state.setPaused(InputPause.DISPLAY, false, releases);
        assertTrue(state.allowed());
        assertEquals(8, events.size());
    }
}
