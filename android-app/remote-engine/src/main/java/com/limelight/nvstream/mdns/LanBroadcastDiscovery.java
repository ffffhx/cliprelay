package com.limelight.nvstream.mdns;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import org.json.JSONObject;

/** Small LAN-only broadcast queries, bound to Wi-Fi even when a VPN is active. */
final class LanBroadcastDiscovery {
    static void scan(Context context, MdnsDiscoveryListener listener, BooleanSupplier active) {
        ConnectivityManager cm=context.getSystemService(ConnectivityManager.class);
        HashSet<String> found=new HashSet<>();
        for (Network network:cm.getAllNetworks()) {
            if (!active.getAsBoolean()) return;
            NetworkCapabilities caps=cm.getNetworkCapabilities(network);
            LinkProperties properties=cm.getLinkProperties(network);
            if(caps==null || properties==null || caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ||
                    (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) continue;
            for(LinkAddress local:properties.getLinkAddresses()) {
                if(!(local.getAddress() instanceof Inet4Address) || local.getPrefixLength()<8 || local.getPrefixLength()>30) continue;
                byte[] localBytes=local.getAddress().getAddress(), mask=new byte[4], broadcast=localBytes.clone();
                for(int i=0;i<4;i++) {int bits=Math.min(8,Math.max(0,local.getPrefixLength()-8*i));mask[i]=(byte)(0xff << (8-bits));broadcast[i]=(byte)(localBytes[i] | ~mask[i]);}
                try(DatagramSocket socket=new DatagramSocket(null)) {
                    socket.setBroadcast(true);socket.bind(new InetSocketAddress(local.getAddress(),0));network.bindSocket(socket);socket.setSoTimeout(600);
                    String nonce=UUID.randomUUID().toString().replace("-","");
                    byte[] query=("CLIPRELAY_DISCOVER_V1 "+nonce).getBytes(StandardCharsets.US_ASCII);
                    long deadline=android.os.SystemClock.elapsedRealtime()+2600;int seen=0;
                    while(active.getAsBoolean() && android.os.SystemClock.elapsedRealtime()<deadline && seen<32) {
                        socket.send(new DatagramPacket(query,query.length,InetAddress.getByAddress(broadcast),47634));
                        byte[] buffer=new byte[512];DatagramPacket packet=new DatagramPacket(buffer,buffer.length);
                        try {socket.receive(packet);} catch(SocketTimeoutException timeout) {continue;}
                        seen++;
                        if(packet.getPort()!=47634 || !(packet.getAddress() instanceof Inet4Address)) continue;
                        byte[] peer=packet.getAddress().getAddress();boolean sameSubnet=true;
                        for(int i=0;i<4;i++) if((peer[i]&mask[i])!=(localBytes[i]&mask[i])) sameSubnet=false;
                        if(!sameSubnet) continue;
                        JSONObject reply=new JSONObject(new String(packet.getData(),0,packet.getLength(),StandardCharsets.UTF_8));
                        if(!"cliprelay.discover.v1".equals(reply.optString("protocol")) || !nonce.equals(reply.optString("nonce"))) continue;
                        int port=reply.optInt("port");if(port<1 || port>65532) continue;
                        String key=packet.getAddress().getHostAddress()+":"+port;
                        if(found.add(key) && active.getAsBoolean()) listener.notifyComputerAdded(new MdnsComputer(reply.optString("name","ClipRelay"),packet.getAddress(),null,port));
                    }
                } catch(Exception ignored) { /* mDNS and stored addresses remain available. */ }
            }
        }
    }
}
