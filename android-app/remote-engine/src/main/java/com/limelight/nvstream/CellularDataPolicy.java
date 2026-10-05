package com.limelight.nvstream;

/** A session budget, separate from congestion control and the user's saved quality settings. */
public final class CellularDataPolicy {
    public enum NetworkType { UNKNOWN, CELLULAR, METERED, UNMETERED }
    public static final int CELLULAR_LIMIT_KBPS = 6_000;
    private final int initialKbps, maximumKbps;
    private final boolean enabled;
    // Start conservatively until Android reports the default network. During a
    // handover, UNKNOWN must never remove a previously established data limit.
    private boolean limited = true;

    public CellularDataPolicy(int userLimitKbps, boolean enabled) {
        this(userLimitKbps, userLimitKbps, enabled);
    }

    private CellularDataPolicy(int initialKbps, int maximumKbps, boolean enabled) {
        this.initialKbps = clamp(initialKbps);
        this.maximumKbps = Math.max(this.initialKbps, clamp(maximumKbps));
        this.enabled = enabled;
    }

    /** Auto mode ignores the saved manual bitrate. The format default comes
     * from the selected resolution/FPS; twice that allows cautious quality
     * probes without spending unlimited bandwidth on negligible improvements. */
    public static CellularDataPolicy forStream(int manualKbps, int formatDefaultKbps,
                                               boolean automatic, boolean dataSaver) {
        if (!automatic) return new CellularDataPolicy(manualKbps, dataSaver);
        int initial = clamp(formatDefaultKbps);
        return new CellularDataPolicy(initial, initial * 2, dataSaver);
    }

    private static int clamp(int rate) { return Math.max(500, Math.min(150_000, rate)); }

    public void update(NetworkType type) {
        if (type != NetworkType.UNKNOWN) limited = type != NetworkType.UNMETERED;
    }

    public static NetworkType classify(boolean cellular, boolean wifi, boolean ethernet, boolean vpn, boolean unmetered) {
        // Cellular may temporarily be marked unmetered by a carrier. VPNs may
        // report several underlying transports; any cellular path keeps the cap.
        if (cellular) return NetworkType.CELLULAR;
        if (!unmetered) return NetworkType.METERED;
        return wifi || ethernet || vpn ? NetworkType.UNMETERED : NetworkType.UNKNOWN;
    }

    public boolean isSavingData() { return enabled && limited; }
    public int getInitialBitrateKbps() {
        return Math.min(initialKbps, getCeilingKbps());
    }
    public int getCeilingKbps() {
        return isSavingData() ? Math.min(maximumKbps, CELLULAR_LIMIT_KBPS) : maximumKbps;
    }
}
