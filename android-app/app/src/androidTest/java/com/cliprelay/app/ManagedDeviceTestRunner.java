package com.cliprelay.app;

import android.app.UiAutomation;
import androidx.test.runner.AndroidJUnitRunner;

/** Keep the user's accessibility controls available, including on Espresso failures. */
public final class ManagedDeviceTestRunner extends AndroidJUnitRunner {
    @Override public UiAutomation getUiAutomation() {
        return getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    }

    @Override public UiAutomation getUiAutomation(int flags) {
        return super.getUiAutomation(flags | UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    }
}
