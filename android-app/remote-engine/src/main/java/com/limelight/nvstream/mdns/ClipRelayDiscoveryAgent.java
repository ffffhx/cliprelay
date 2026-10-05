package com.limelight.nvstream.mdns;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Handler;
import android.os.Looper;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Resolves ClipRelay's own announcements alongside the engine's mDNS service. */
public final class ClipRelayDiscoveryAgent extends MdnsDiscoveryAgent {
    private final NsdManager nsd;
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final WifiManager.MulticastLock multicast;
    private final ExecutorService worker = new java.util.concurrent.ThreadPoolExecutor(2,2,0,java.util.concurrent.TimeUnit.SECONDS,
            new java.util.concurrent.ArrayBlockingQueue<>(16),new java.util.concurrent.ThreadPoolExecutor.DiscardPolicy());
    private final ArrayDeque<NsdServiceInfo> pending = new ArrayDeque<>();
    private NsdManager.DiscoveryListener discovery;
    private volatile boolean running;
    private boolean resolving;
    private volatile int generation;
    private final Runnable rescan = () -> { if (running) { stopBrowse(); browse(); } };

    public ClipRelayDiscoveryAgent(Context context, MdnsDiscoveryListener listener) {
        super(listener); this.context=context.getApplicationContext(); nsd = context.getSystemService(NsdManager.class);
        multicast = context.getSystemService(WifiManager.class).createMulticastLock("ClipRelay discovery");
        multicast.setReferenceCounted(false);
    }
    @Override public void startDiscovery(int interval) {
        main.post(() -> { if (running) return; running=true; multicast.acquire(); browse(); });
    }
    @Override public void stopDiscovery() {
        main.post(() -> { running=false; stopBrowse(); if (multicast.isHeld()) multicast.release(); });
    }
    public void close() { stopDiscovery(); worker.shutdownNow(); }
    private void stopBrowse() {
        generation++; main.removeCallbacks(rescan); pending.clear();
        if (discovery!=null) { try { nsd.stopServiceDiscovery(discovery); } catch (IllegalArgumentException ignored) { } discovery=null; }
    }
    private void browse() {
        final int epoch=++generation;
        worker.execute(() -> LanBroadcastDiscovery.scan(context,listener,() -> running && epoch==generation));
        discovery=new NsdManager.DiscoveryListener() {
            public void onDiscoveryStarted(String type) { }
            public void onDiscoveryStopped(String type) { }
            public void onStopDiscoveryFailed(String type,int error) { }
            public void onStartDiscoveryFailed(String type,int error) { }
            public void onServiceLost(NsdServiceInfo info) { }
            public void onServiceFound(NsdServiceInfo info) { main.post(() -> {
                if (running && epoch==generation && pending.size()<32) { pending.add(info); resolveNext(); }
            }); }
        };
        try { nsd.discoverServices("_cliprelay._tcp.",NsdManager.PROTOCOL_DNS_SD,discovery); }
        catch (RuntimeException ignored) { discovery=null; }
        // Periodic re-resolution handles PC address changes and engines that were
        // still starting during the first announcement, even on Android 8–13.
        main.postDelayed(rescan,15000);
    }
    @SuppressWarnings("deprecation") private void resolveNext() {
        if (!running || resolving || pending.isEmpty()) return;
        resolving=true; final int epoch=generation;
        NsdServiceInfo item=pending.remove();
        NsdManager.ResolveListener callback=new NsdManager.ResolveListener() {
            public void onResolveFailed(NsdServiceInfo info,int error) { main.post(() -> { resolving=false; resolveNext(); }); }
            public void onServiceResolved(NsdServiceInfo info) { main.post(() -> {
                resolving=false;
                if (running && epoch==generation) {
                    byte[] platform=info.getAttributes().get("platform"), portValue=info.getAttributes().get("remote_port");
                    int port=0;
                    try { if(platform!=null && "windows".equals(new String(platform,StandardCharsets.UTF_8)) && portValue!=null)
                        port=Integer.parseInt(new String(portValue,StandardCharsets.UTF_8)); } catch (NumberFormatException ignored) { }
                    InetAddress address=info.getHost();
                    if (port>0 && port<=65532 && address!=null && !address.isLoopbackAddress() && !address.isAnyLocalAddress()) {
                        final int remotePort=port;
                        if (!worker.isShutdown()) worker.execute(() -> {
                            // Do not deduplicate forever: the previous probe may have
                            // failed while the host was starting or temporarily offline.
                            if (!running || epoch!=generation) return;
                            MdnsComputer computer=new MdnsComputer(info.getServiceName(),
                                    address instanceof Inet4Address ? (Inet4Address)address : null,
                                    address instanceof Inet6Address ? (Inet6Address)address : null, remotePort);
                            listener.notifyComputerAdded(computer);
                        });
                    }
                }
                resolveNext();
            }); }
        };
        try { nsd.resolveService(item,callback); }
        catch (RuntimeException ignored) { resolving=false; main.post(this::resolveNext); }
    }
}
