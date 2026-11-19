package com.cliprelay.app;

import com.limelight.herdr.HerdrAttachments;
import org.junit.Test;
import static org.junit.Assert.*;

public class HerdrAttachmentsTest {
    @Test public void successiveSelectionsAppendAndRemoveOnlySelectedImage(){
        HerdrAttachments<String> draft=new HerdrAttachments<>();
        assertTrue(draft.add("first",100));assertTrue(draft.add("second",200));assertTrue(draft.add("third",300));
        assertEquals("second",draft.remove(1));assertEquals(2,draft.size());assertEquals("first",draft.get(0));assertEquals("third",draft.get(1));
    }
    @Test public void failedUploadResumesAfterAcknowledgedImagesWithoutRepasting(){
        HerdrAttachments<String> draft=new HerdrAttachments<>();draft.add("first",100);draft.add("second",100);
        draft.acknowledgePaste();assertFalse(draft.allPasted());assertEquals("second",draft.get(draft.pasted()));
        assertFalse(draft.add("third",100));assertThrows(IllegalStateException.class,()->draft.remove(0));
        assertEquals("second",draft.get(draft.pasted()));draft.acknowledgePaste();assertTrue(draft.allPasted());
        assertThrows(IllegalStateException.class,draft::acknowledgePaste);draft.clear();assertEquals(0,draft.pasted());assertTrue(draft.add("new",100));
    }
    @Test public void countAndByteBudgetsKeepExistingDraftIntact(){
        HerdrAttachments<String> draft=new HerdrAttachments<>();
        for(int i=0;i<8;i++)assertTrue(draft.add("image"+i,1));assertFalse(draft.add("overflow",1));assertEquals(8,draft.size());
        draft.clear();assertTrue(draft.add("large",HerdrAttachments.MAX_BYTES));assertFalse(draft.add("overflow",1));assertEquals("large",draft.get(0));
        draft.remove(0);assertTrue(draft.add("replacement",HerdrAttachments.MAX_BYTES));
    }
}
