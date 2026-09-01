package com.cliprelay.app.util

import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections

object NetworkAddresses {
    fun localIpv4(): List<String> = runCatching {
            Collections.list(NetworkInterface.getNetworkInterfaces())
            .asSequence()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { networkInterface ->
                Collections.list(networkInterface.inetAddresses)
                    .asSequence()
                    .filterIsInstance<Inet4Address>()
                    .filter { !it.isLoopbackAddress && !it.isLinkLocalAddress }
                    .mapNotNull { address ->
                        address.hostAddress?.let {
                            AddressCandidate(
                                address = it,
                                interfacePriority = interfacePriority(networkInterface.name),
                            )
                        }
                    }
            }
            .sortedWith(
                compareBy<AddressCandidate>(
                    { !isPrivate(it.address) },
                    { it.interfacePriority },
                    { it.address },
                ),
            )
            .map { it.address }
            .distinct()
            .toList()
        }.getOrDefault(emptyList())

    private data class AddressCandidate(
        val address: String,
        val interfacePriority: Int,
    )

    private fun interfacePriority(name: String): Int = when {
        name.startsWith("wlan", ignoreCase = true) || name.startsWith("wifi", ignoreCase = true) -> 0
        name.startsWith("eth", ignoreCase = true) -> 1
        name.startsWith("ap", ignoreCase = true) -> 2
        name.startsWith("tun", ignoreCase = true) || name.startsWith("vpn", ignoreCase = true) -> 3
        else -> 4
    }

    private fun isPrivate(address: String): Boolean {
        if (address.startsWith("10.") || address.startsWith("192.168.")) return true
        if (!address.startsWith("172.")) return false
        val second = address.split('.').getOrNull(1)?.toIntOrNull() ?: return false
        return second in 16..31
    }
}
