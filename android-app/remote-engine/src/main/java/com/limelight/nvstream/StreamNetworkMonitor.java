package com.limelight.nvstream;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import com.limelight.LimeLog;
import com.limelight.nvstream.CellularDataPolicy.NetworkType;

/** Watches the app's actual default network, never the stream's LAN/tunnel address. */
public final class StreamNetworkMonitor implements AutoCloseable {
    public interface Listener { void changed(NetworkType type); }
    private final ConnectivityManager connectivity;
    private final Listener listener;
    private Network current;
    private boolean registered, closed;
    private final ConnectivityManager.NetworkCallback callback = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) {
            current = network;
            // Capabilities follow onAvailable on API 26+. Querying here races Android.
        }
        @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities caps) {
            if (!closed && network.equals(current)) listener.changed(classify(caps));
        }
        @Override public void onLost(Network network) {
            if (!closed && network.equals(current)) {
                current = null;
                listener.changed(NetworkType.UNKNOWN);
            }
        }
    };

    public StreamNetworkMonitor(Context context, Listener listener) {
        connectivity = context.getSystemService(ConnectivityManager.class);
        this.listener = listener;
    }

    public NetworkType snapshot() {
        if (connectivity == null) return NetworkType.UNKNOWN;
        try {
            return classify(connectivity.getNetworkCapabilities(connectivity.getActiveNetwork()));
        } catch (SecurityException error) { return NetworkType.UNKNOWN; }
    }

    public static NetworkType classify(NetworkCapabilities caps) {
        if (caps == null) return NetworkType.UNKNOWN;
        return CellularDataPolicy.classify(caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR),
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI),
                caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
                caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN),
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED));
    }

    public void start(Handler handler) {
        if (closed || registered || connectivity == null) return;
        try {
            connectivity.registerDefaultNetworkCallback(callback, handler);
            registered = true;
        } catch (RuntimeException error) {
            LimeLog.warning("Unable to observe stream network; conservative initial data budget retained");
        }
    }

    @Override public void close() {
        closed = true;
        if (registered) {
            connectivity.unregisterNetworkCallback(callback);
            registered = false;
        }
    }
}
