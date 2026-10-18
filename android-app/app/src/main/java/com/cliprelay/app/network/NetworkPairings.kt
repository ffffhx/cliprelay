package com.cliprelay.app.network

import org.json.JSONArray
import org.json.JSONObject

/** Only encrypted credentials enter this catalog. Slots never move or get reused. */
internal data class SavedNetworkPairing(
    val id: String,
    val slot: Int,
    val computer: String,
    val encryptedCredential: String,
    val enabled: Boolean = true,
    val hostId: String = "",
) {
    val address: String get() = "127.120.${slot / 256}.${slot % 256}"
    val preferredPort: Int get() = 47632 + slot
}

internal data class NetworkPairings(
    val nextSlot: Int = 1,
    val computers: List<SavedNetworkPairing> = emptyList(),
) {
    init {
        require(nextSlot in 1..MAX_SLOT + 1)
        require(computers.map { it.id }.distinct().size == computers.size)
        require(computers.map { it.slot }.distinct().size == computers.size)
        require(computers.all { it.id.isNotBlank() && it.slot in 1 until nextSlot && it.encryptedCredential.isNotBlank() })
    }

    fun add(id: String, name: String, encrypted: String, hostId: String = ""): NetworkPairings {
        if (hostId.isNotBlank() && computers.any { it.hostId == hostId }) {
            return copy(computers = computers.map {
                if (it.hostId == hostId) it.copy(computer = name, encryptedCredential = encrypted, enabled = true) else it
            })
        }
        require(nextSlot <= MAX_SLOT) { "电脑连接地址已用完" }
        require(computers.none { it.id == id })
        return copy(nextSlot = nextSlot + 1, computers = computers + SavedNetworkPairing(id, nextSlot, name, encrypted, hostId = hostId))
    }

    fun update(id: String, transform: (SavedNetworkPairing) -> SavedNetworkPairing) =
        copy(computers = computers.map { if (it.id == id) transform(it) else it })

    fun remove(id: String) = copy(computers = computers.filterNot { it.id == id })

    fun encode(): String = JSONObject().put("version", 2).put("nextSlot", nextSlot).put("computers",
        JSONArray().apply { computers.forEach { item ->
            put(JSONObject().put("id", item.id).put("slot", item.slot).put("computer", item.computer)
                .put("credential", item.encryptedCredential).put("enabled", item.enabled).put("hostId", item.hostId))
        } }).toString()

    companion object {
        // Keep each userspace node's UDP port distinct and within the valid port range.
        const val MAX_SLOT = 16384

        fun decode(value: String): NetworkPairings {
            val json = JSONObject(value)
            require(json.getInt("version") == 2) { "Unsupported pairing catalog" }
            val entries = json.getJSONArray("computers")
            return NetworkPairings(json.getInt("nextSlot"), (0 until entries.length()).map { index ->
                val item = entries.getJSONObject(index)
                SavedNetworkPairing(item.getString("id"), item.getInt("slot"), item.getString("computer"),
                    item.getString("credential"), item.getBoolean("enabled"), item.optString("hostId"))
            })
        }

        fun migrate(legacyEncrypted: String?, enabled: Boolean): NetworkPairings =
            if (legacyEncrypted == null) NetworkPairings() else
                NetworkPairings(2, listOf(SavedNetworkPairing("legacy", 1, "已配对电脑", legacyEncrypted, enabled)))
    }
}
