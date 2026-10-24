package com.cliprelay.app;

import com.limelight.ui.DesktopShortcut;
import com.limelight.ui.GameInputState;
import org.junit.Test;
import java.util.ArrayList;
import java.util.List;
import static org.junit.Assert.*;

public class DesktopShortcutTest {
    @Test public void usesHostSpecificShortcutsAndRefusesUnknownHosts() {
        assertArrayEquals(new int[]{0x11,0x5B,0x27},DesktopShortcut.keys("windows",1));
        assertArrayEquals(new int[]{0x11,0x5B,0x25},DesktopShortcut.keys("windows",-1));
        assertArrayEquals(new int[]{0x11,0x27},DesktopShortcut.keys("macos",1));
        assertArrayEquals(new int[]{0x11,0x25},DesktopShortcut.keys("macos",-1));
        assertEquals(0,DesktopShortcut.keys("",1).length);
        assertEquals(0,DesktopShortcut.keys("linux",1).length);
        assertEquals(0,DesktopShortcut.keys("windows",0).length);
    }
    @Test public void keyboardPacketOrderPressesModifiersFirstAndReleasesEveryKey() {
        List<String> sent = new ArrayList<>();
        GameInputState keys = new GameInputState((key,down,mods)->sent.add(key+":"+down+":"+mods));
        keys.setEnabled(true);
        try { keys.update("desktop",DesktopShortcut.keys("windows",1)); }
        finally { keys.releaseAll(); }
        assertEquals(List.of("17:true:2","91:true:10","39:true:10","39:false:10","91:false:2","17:false:0"),sent);
        int size=sent.size();keys.releaseAll();assertEquals(size,sent.size());
    }
}
