package com.limelight.herdr;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import java.io.File;
import java.io.FileOutputStream;
import static org.junit.Assert.*;

/** Offline Android view tests: no host connection or terminal input. */
public class HerdrCommandSuggestionsTest {
    @Test public void typingAndChoosingPermissionsOnlyCompletesTheDraft() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            EditText composer = new EditText(context);
            HerdrCommandSuggestions picker = new HerdrCommandSuggestions(context, composer);
            picker.setContext("codex", true);
            composer.setText("/per");
            assertEquals(View.VISIBLE, picker.getVisibility());
            View command = find(picker, "/permissions");
            assertNotNull(command);
            assertEquals("/per", composer.getText().toString());
            ((View)command.getParent()).performClick();
            assertEquals("/permissions", composer.getText().toString());
            assertEquals(12, composer.getSelectionStart());
            assertEquals(View.GONE, picker.getVisibility());
            composer.append(" :workspace");
            assertEquals(View.GONE, picker.getVisibility());
        });
    }

    @Test public void sessionChangesAndStaleTapsCannotReplaceADraft() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            EditText composer = new EditText(context);
            HerdrCommandSuggestions picker = new HerdrCommandSuggestions(context, composer);
            picker.setContext("codex", true);
            composer.setText("/per");
            View oldRow = (View)find(picker, "/permissions").getParent();
            composer.setText("keep my changed draft");
            oldRow.performClick();
            assertEquals("keep my changed draft", composer.getText().toString());
            composer.setText("/per");
            picker.setContext("claude", true);
            oldRow.performClick();
            assertEquals("/per", composer.getText().toString());
            assertEquals(View.GONE, picker.getVisibility());
            picker.setContext("codex", true);
            assertEquals(View.VISIBLE, picker.getVisibility());
            picker.setContext("codex", false);
            oldRow.performClick();
            assertEquals("/per", composer.getText().toString());
            assertEquals(View.GONE, picker.getVisibility());
        });
    }

    @Test public void suggestionsFitNarrowScreensAndScrollInBothThemes() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> {
            Context base = InstrumentationRegistry.getInstrumentation().getTargetContext();
            for (boolean dark : new boolean[]{false, true}) {
                Configuration configuration = new Configuration(base.getResources().getConfiguration());
                configuration.uiMode = (configuration.uiMode & ~Configuration.UI_MODE_NIGHT_MASK)
                        | (dark ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO);
                configuration.fontScale = 1.3f;
                Context context = base.createConfigurationContext(configuration);
                float density = context.getResources().getDisplayMetrics().density;
                EditText composer = new EditText(context);
                HerdrCommandSuggestions picker = new HerdrCommandSuggestions(context, composer);
                LinearLayout root = new LinearLayout(context);
                root.setOrientation(LinearLayout.VERTICAL);
                root.setBackgroundColor(new HerdrPalette(context).background);
                root.addView(picker, new LinearLayout.LayoutParams(-1, -2));
                root.addView(composer, new LinearLayout.LayoutParams(-1, -2));
                picker.setContext("codex", true);
                composer.setText("/");
                root.measure(View.MeasureSpec.makeMeasureSpec(Math.round(320*density), View.MeasureSpec.EXACTLY),
                        View.MeasureSpec.makeMeasureSpec(Math.round(500*density), View.MeasureSpec.AT_MOST));
                root.layout(0, 0, root.getMeasuredWidth(), root.getMeasuredHeight());
                assertTrue(picker.getHeight() <= Math.round(180*density));
                assertTrue(picker.canScrollVertically(1));
                assertTrue(composer.getTop() >= picker.getBottom());
                assertTrue(composer.getHeight() > 0);
                capture(root, base, dark ? "dark" : "light");
                composer.setText("/per");
                assertNotNull(find(picker, "/permissions"));
                composer.setText("");
                assertEquals(View.GONE, picker.getVisibility());
            }
        });
    }

    private static View find(View view, String text) {
        if (view instanceof TextView && text.contentEquals(((TextView)view).getText())) return view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup)view;
            for (int i=0; i<group.getChildCount(); i++) {
                View match = find(group.getChildAt(i), text);
                if (match != null) return match;
            }
        }
        return null;
    }

    private static void capture(View view, Context context, String theme) {
        Bitmap image = Bitmap.createBitmap(view.getWidth(), view.getHeight(), Bitmap.Config.ARGB_8888);
        try {
            view.draw(new Canvas(image));
            try (FileOutputStream output = new FileOutputStream(new File(context.getExternalFilesDir(null), "herdr-slash-"+theme+".png"))) {
                assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output));
            }
        } catch (Exception error) { throw new AssertionError(error); }
        finally { image.recycle(); }
    }
}
