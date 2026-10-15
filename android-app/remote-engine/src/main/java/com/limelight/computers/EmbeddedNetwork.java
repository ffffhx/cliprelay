package com.limelight.computers;

import android.content.Context;
import com.limelight.nvstream.http.ComputerDetails;

/** Optional application-owned connection channel; the engine does not own pairing credentials. */
public final class EmbeddedNetwork {
    public static final String ADDRESS = "127.120.0.1";
    public interface Provider {
        void restore(Context context);
        boolean ready();
        default String[] readyAddresses() { return ready() ? new String[] { ADDRESS } : new String[0]; }
        default boolean ready(String address) {
            for (String candidate : readyAddresses()) if (candidate.equals(address)) return true;
            return false;
        }
    }
    public static volatile Provider provider;
    private EmbeddedNetwork() {}
    public static boolean isAddress(ComputerDetails.AddressTuple address) {
        return address != null && isAddress(address.address) && address.port == 48789;
    }

    public static boolean isAddress(String address) {
        if (address == null || !address.matches("127\\.120\\.(0|[1-9][0-9]{0,2})\\.(0|[1-9][0-9]{0,2})")) return false;
        String[] octets = address.split("\\.");
        int third = Integer.parseInt(octets[2]);
        int fourth = Integer.parseInt(octets[3]);
        int slot = third * 256 + fourth;
        return fourth <= 255 && slot >= 1 && slot <= 16384;
    }
}
