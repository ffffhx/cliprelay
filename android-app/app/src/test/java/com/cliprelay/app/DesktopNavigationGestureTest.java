package com.cliprelay.app;

import com.limelight.binding.input.touch.DesktopNavigationGesture;
import org.junit.Test;
import static org.junit.Assert.*;
import static com.limelight.binding.input.touch.DesktopNavigationGesture.*;

public class DesktopNavigationGestureTest {
    private final DesktopNavigationGesture gesture = new DesktopNavigationGesture();
    private int[] ids(int n) { int[] a = new int[n]; for (int i=0;i<n;i++) a[i]=7+i*3; return a; }
    private float[] x(int n, float dx) { float[] a = new float[n]; for (int i=0;i<n;i++) a[i]=200+i*40+dx; return a; }
    private float[] y(int n, float dy) { float[] a = new float[n]; for (int i=0;i<n;i++) a[i]=200+dy; return a; }
    private void start(int n) {
        gesture.begin(200, 200, 1000);
        for (int i=2;i<=n;i++) gesture.add(ids(i), x(i,0), y(i,0), 1000+i*30);
    }
    private void move(int n, float dx, float dy) { gesture.move(ids(n), x(n,dx), y(n,dy), 1200); }
    private int finish(int n, float dx, float dy) {
        assertEquals(NONE, gesture.up(ids(n),x(n,dx),y(n,dy),1250,false));
        return gesture.up(ids(1),x(1,dx),y(1,dy),1280,true);
    }

    @Test public void leftAndRightUseDifferentDesktopAndDisplayActions() {
        start(3); move(3,-90,4); assertEquals(DESKTOP_NEXT,finish(3,-90,4));
        start(3); move(3,90,-4); assertEquals(DESKTOP_PREVIOUS,finish(3,90,-4));
        start(4); move(4,-90,4); assertEquals(DISPLAY_NEXT,finish(4,-90,4));
        start(4); move(4,90,-4); assertEquals(DISPLAY_PREVIOUS,finish(4,90,-4));
    }
    @Test public void oneAndTwoFingerScrollsAreNotClaimed() {
        start(2); move(2,-100,0); assertFalse(gesture.isClaimed()); assertEquals(NONE,finish(2,-100,0));
        gesture.begin(200,200,2000); assertEquals(NONE,gesture.up(ids(1),x(1,0),y(1,0),2100,true));
    }
    @Test public void onlyCommitsOnLastUpAndOnlyOnce() {
        start(3); move(3,-100,0);
        assertEquals(NONE,gesture.up(ids(3),x(3,-100),y(3,0),1250,false));
        assertTrue(gesture.isClaimed());
        assertEquals(NONE,gesture.up(ids(2),x(2,0),y(2,0),1260,false));
        assertEquals(DESKTOP_NEXT,gesture.up(ids(1),x(1,0),y(1,0),1270,true));
        assertEquals(NONE,gesture.up(ids(1),x(1,0),y(1,0),1280,true));
    }
    @Test public void fourthFingerOverridesPendingThreeFingerSwipe() {
        start(3); move(3,-80,0);
        gesture.add(ids(4),x(4,-80),y(4,0),1210);
        gesture.move(ids(4),x(4,-160),y(4,0),1230);
        assertEquals(DISPLAY_NEXT,finish(4,-160,0));
    }
    @Test public void addingFourthFingerWithoutMovingItDoesNotSwitchAnything() {
        start(3); move(3,-80,0); gesture.add(ids(4),x(4,-80),y(4,0),1210);
        assertEquals(NONE,finish(4,-80,0));
    }
    @Test public void shortVerticalDiagonalAndOpposingMotionDoNotNavigate() {
        start(3); move(3,35,0); assertEquals(NONE,finish(3,35,0));
        start(3); move(3,5,100); assertEquals(NONE,finish(3,5,100));
        start(3); move(3,70,55); assertEquals(NONE,finish(3,70,55));
        start(3);
        gesture.move(ids(3),new float[]{100,340,180},y(3,0),1200);
        assertEquals(NONE,gesture.up(ids(3),new float[]{100,340,180},y(3,0),1250,false));
        assertEquals(NONE,gesture.up(ids(1),x(1,0),y(1,0),1280,true));
    }
    @Test public void cancelledGestureStillOwnsRemainingContactsAndCannotFire() {
        start(3); move(3,-90,0); gesture.cancel(); assertTrue(gesture.isClaimed());
        assertEquals(NONE,finish(3,-90,0));
        start(3); move(3,90,0); assertEquals(DESKTOP_PREVIOUS,finish(3,90,0));
    }
    @Test public void existingDragLateJoinLongHoldAndFiveFingersAreRejected() {
        start(2); move(2,40,0); gesture.add(ids(3),x(3,40),y(3,0),1210);
        move(3,-90,0); assertTrue(gesture.isClaimed()); assertEquals(NONE,finish(3,-90,0));
        gesture.begin(200,200,500);gesture.add(ids(3),x(3,0),y(3,0),1000);
        move(3,-90,0);assertEquals(NONE,finish(3,-90,0));
        start(3);gesture.move(ids(3),x(3,-90),y(3,0),2600);
        assertEquals(NONE,gesture.up(ids(3),x(3,-90),y(3,0),2610,true));
        start(5); move(5,-90,0); assertEquals(NONE,finish(5,-90,0));
    }
    @Test public void pointerIndexReorderingKeepsEachFingerIdentity() {
        start(3);
        int[] reordered={13,7,10}; float[] translated={180,100,140};
        gesture.move(reordered,translated,y(3,0),1200);
        assertEquals(NONE,gesture.up(reordered,translated,y(3,0),1250,false));
        assertEquals(DESKTOP_NEXT,gesture.up(new int[]{10},new float[]{140},y(1,0),1280,true));
    }
    @Test public void replacementContactAfterLiftingCancelsTheGesture() {
        start(3);move(3,-90,0);gesture.up(ids(3),x(3,-90),y(3,0),1220,false);
        gesture.add(new int[]{7,10,19},x(3,-90),y(3,0),1230);
        assertEquals(NONE,finish(3,-90,0));
    }
    @Test public void stationaryThreeFingerTapIsAvailableButFourFingerTapIsNot() {
        start(3); assertEquals(KEYBOARD_TAP,finish(3,2,2));
        start(4); assertEquals(NONE,finish(4,2,2));
        start(3);move(3,80,0);move(3,0,0); assertEquals(NONE,finish(3,0,0));
    }
    @Test public void verticalDetourAndUnknownPointerCannotBecomeHorizontalSwipes() {
        start(3);move(3,0,80);move(3,-90,0);assertEquals(NONE,finish(3,-90,0));
        start(3);gesture.move(new int[]{7,10,99},x(3,-90),y(3,0),1200);
        assertEquals(NONE,finish(3,-90,0));
    }
}
