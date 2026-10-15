package com.cliprelay.app.server

import java.net.InetAddress

/** Compatibility HTTP is local-only; paired cross-network transport is independent. */
internal object LegacyLanPolicy {
    fun allows(enabled: Boolean, address: InetAddress): Boolean {
        if (!enabled || address.isAnyLocalAddress || address.isMulticastAddress) return false
        if (address.isLoopbackAddress || address.isLinkLocalAddress) return true
        val bytes = address.address
        if (bytes.size == 4 && address.isSiteLocalAddress) return true
        return bytes.size == 16 && (bytes[0].toInt() and 0xfe) == 0xfc
    }
}
