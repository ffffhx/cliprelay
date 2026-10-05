package com.limelight.computers;

import android.content.Context;
import com.limelight.binding.PlatformBinding;
import com.limelight.nvstream.http.ComputerDetails;
import com.limelight.nvstream.http.NvHTTP;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.concurrent.Callable;

/** A one-shot, authenticated route selection after a stream's network changes. Worker thread only. */
public final class StreamRouteRecovery {
    private StreamRouteRecovery() {}

    public static ComputerDetails select(Context context, String uuid, String uniqueId) throws InterruptedException {
        ComputerDatabaseManager database = new ComputerDatabaseManager(context);
        ComputerDetails computer;
        try { computer = database.getComputerByUUID(uuid); }
        finally { database.close(); }
        if (computer == null || computer.serverCert == null) return null;

        ArrayList<Callable<ComputerDetails>> probes = new ArrayList<>();
        HashSet<ComputerDetails.AddressTuple> unique = new HashSet<>();
        for (ComputerDetails.AddressTuple address : new ComputerDetails.AddressTuple[] {
                computer.localAddress, computer.manualAddress, computer.ipv6Address,
                computer.remoteAddress, computer.embeddedAddress }) {
            if (address == null || !unique.add(address)) continue;
            probes.add(() -> {
                if (EmbeddedNetwork.isAddress(address) && EmbeddedNetwork.provider != null) {
                    long deadline = android.os.SystemClock.uptimeMillis() + 8_000;
                    while (!EmbeddedNetwork.provider.ready() && android.os.SystemClock.uptimeMillis() < deadline) {
                        Thread.sleep(100);
                    }
                }
                NvHTTP http = new NvHTTP(address, 0, uniqueId, computer.serverCert,
                        PlatformBinding.getCryptoProvider(context));
                ComputerDetails result = http.getComputerDetails(false);
                if (!uuid.equals(result.uuid)) return null;
                result.activeAddress = address;
                return result;
            });
        }
        // Let the built-in channel's first handshake settle, without indefinite retries.
        for (int attempt = 0; attempt < 3; attempt++) {
            ComputerDetails result = ConnectionRouteSelector.select(probes, 400);
            if (result != null) return result;
            if (attempt < 2) Thread.sleep(500);
        }
        return null;
    }
}
