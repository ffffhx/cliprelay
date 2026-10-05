package com.limelight.nvstream;

import com.limelight.nvstream.http.NvApp;
import java.util.List;

/** Select only the existing session or the desktop, never an arbitrary installed app. */
public final class DirectDesktopConnection {
    private DirectDesktopConnection() {}

    public static NvApp select(int runningAppId, List<NvApp> apps) {
        if (runningAppId > 0) return new NvApp("Desktop", runningAppId, false);
        for (NvApp app : apps) {
            if (app.getAppId() > 0 && "Desktop".equalsIgnoreCase(app.getAppName())) return app;
        }
        return null;
    }
}
