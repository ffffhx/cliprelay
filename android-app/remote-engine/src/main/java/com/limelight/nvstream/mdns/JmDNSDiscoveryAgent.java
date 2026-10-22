package com.limelight.nvstream.mdns;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;

import com.limelight.LimeLog;
import java.io.Closeable;
import java.io.IOException;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import javax.jmdns.JmDNS;
import javax.jmdns.ServiceEvent;
import javax.jmdns.ServiceListener;

/** Android 13 and earlier: each scan owns its LAN resolvers, including their timers. */
public class JmDNSDiscoveryAgent extends MdnsDiscoveryAgent {
    private static final String SERVICE_TYPE = "_nvstream._tcp.local.";
    interface Resolver extends Closeable { void listen(ServiceListener listener); }
    interface Environment {
        Set<InetAddress> addresses();
        Resolver open(InetAddress address) throws IOException;
        void acquire();
        void release();
    }
    private final Environment environment;
    private volatile Scan scan;

    public JmDNSDiscoveryAgent(Context context, MdnsDiscoveryListener listener) {
        this(listener, new Environment() {
            final ConnectivityManager networks = context.getSystemService(ConnectivityManager.class);
            final WifiManager.MulticastLock lock = context.getSystemService(WifiManager.class)
                    .createMulticastLock("ClipRelay LAN discovery");
            @Override public Set<InetAddress> addresses() {
                Set<InetAddress> result = new HashSet<>();
                for (Network network : networks.getAllNetworks()) {
                    NetworkCapabilities caps = networks.getNetworkCapabilities(network);
                    if (caps == null || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ||
                            !(caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
                              caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) continue;
                    LinkProperties links = networks.getLinkProperties(network);
                    if (links == null) continue;
                    for (android.net.LinkAddress link : links.getLinkAddresses()) {
                        InetAddress address = link.getAddress();
                        if (!address.isLoopbackAddress() && !address.isAnyLocalAddress() &&
                                !address.isMulticastAddress()) result.add(address);
                    }
                }
                return result;
            }
            @Override public Resolver open(InetAddress address) throws IOException {
                JmDNS dns = JmDNS.create(address);
                return new Resolver() {
                    @Override public void listen(ServiceListener callback) { dns.addServiceListener(SERVICE_TYPE, callback); }
                    @Override public void close() throws IOException { dns.close(); }
                };
            }
            // Reference counting covers a new scan starting while the previous one is closing.
            @Override public void acquire() { lock.acquire(); }
            @Override public void release() { lock.release(); }
        });
    }

    JmDNSDiscoveryAgent(MdnsDiscoveryListener listener, Environment environment) {
        super(listener);
        this.environment = environment;
    }

    @Override public synchronized void startDiscovery(int discoveryIntervalMs) {
        stopDiscovery();
        Scan next = new Scan(Math.max(1000, discoveryIntervalMs));
        scan = next;
        next.start();
    }

    @Override public synchronized void stopDiscovery() {
        Scan previous = scan;
        scan = null;
        if (previous != null) {
            previous.cancelled = true;
            previous.interrupt();
        }
    }

    private final class Scan extends Thread implements ServiceListener {
        private final Map<InetAddress, Resolver> resolvers = new HashMap<>();
        private final int interval;
        private volatile boolean cancelled;
        Scan(int interval) { super("ClipRelay LAN discovery"); this.interval = interval; }
        private boolean active() { return !cancelled && scan == this; }

        @Override public void run() {
            boolean locked = false;
            try {
                if (!active()) return;
                while (active()) {
                    Set<InetAddress> addresses = environment.addresses();
                    for (InetAddress address : new ArrayList<>(resolvers.keySet())) {
                        if (!addresses.contains(address)) close(resolvers.remove(address));
                    }
                    if (addresses.isEmpty() && locked) {
                        environment.release();
                        locked = false;
                    } else if (!addresses.isEmpty() && !locked) {
                        environment.acquire();
                        locked = true;
                    }
                    for (InetAddress address : addresses) {
                        if (!active()) break;
                        if (resolvers.containsKey(address)) continue;
                        try {
                            Resolver resolver = environment.open(address);
                            // Retain before checking cancellation: even a late create must be closed.
                            resolvers.put(address, resolver);
                            if (active()) resolver.listen(this);
                        } catch (IOException e) {
                            if (active()) listener.notifyDiscoveryFailure(e);
                        }
                    }
                    // JmDNS owns DNS retries and service announcements. This loop only
                    // reconciles LAN changes while the computer list is visible.
                    if (active()) Thread.sleep(interval);
                }
            } catch (InterruptedException ignored) {
            } catch (RuntimeException e) {
                if (active()) listener.notifyDiscoveryFailure(e);
            } finally {
                // Library waits may swallow interrupts. Cancellation remains authoritative.
                Thread.interrupted();
                for (Resolver resolver : resolvers.values()) close(resolver);
                resolvers.clear();
                if (locked) environment.release();
            }
        }

        private void close(Resolver resolver) {
            try { resolver.close(); }
            catch (Exception e) { LimeLog.warning("Could not close LAN discovery: " + e.getMessage()); }
        }
        @Override public void serviceAdded(ServiceEvent event) {
            // JmDNS resolves added services and emits serviceResolved automatically.
        }
        @Override public void serviceRemoved(ServiceEvent event) { }
        @Override public void serviceResolved(ServiceEvent event) {
            synchronized (JmDNSDiscoveryAgent.this) {
                if (!active()) return;
                reportNewComputer(event.getInfo().getName(), event.getInfo().getPort(),
                        event.getInfo().getInet4Addresses(), event.getInfo().getInet6Addresses());
            }
        }
    }
}
