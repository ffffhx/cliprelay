package com.limelight.computers;

import android.content.Context;
import com.limelight.nvstream.http.ComputerDetails;

/** Optional application-owned connection channel; the engine does not own pairing credentials. */
public final class EmbeddedNetwork {
    public static final String ADDRESS = "127.120.0.1";
    public interface Provider {
        void restore(Context context);
        boolean ready();
    }
    public static volatile Provider provider;
    private EmbeddedNetwork() {}
    public static boolean isAddress(ComputerDetails.AddressTuple address) {
        return address != null && ADDRESS.equals(address.address) && address.port == 48789;
    }
}
