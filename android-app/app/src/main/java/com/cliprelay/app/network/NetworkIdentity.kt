package com.cliprelay.app.network

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Each computer has a separate encrypted identity and stable local channel. */
internal class NetworkIdentity(context: Context) {
    private val prefs = context.getSharedPreferences("cliprelay_network", Context.MODE_PRIVATE)

    private fun catalog(): NetworkPairings {
        prefs.getString(CATALOG, null)?.let { return NetworkPairings.decode(it) }
        val migrated = NetworkPairings.migrate(prefs.getString("credential", null), prefs.getBoolean("enabled", false))
        check(prefs.edit().putString(CATALOG, migrated.encode()).remove("credential").remove("enabled").commit())
        return migrated
    }

    fun list(): List<SavedNetworkPairing> = synchronized(lock) { catalog().computers }

    private fun change(transform: (NetworkPairings) -> NetworkPairings) = synchronized(lock) {
        val previous = catalog()
        val updated = transform(previous)
        if (updated != previous) check(prefs.edit().putString(CATALOG, updated.encode()).commit())
    }

    fun setEnabled(id: String, enabled: Boolean) = change { it.update(id) { item -> item.copy(enabled = enabled) } }
    fun setAllEnabled(enabled: Boolean) = change { it.copy(computers = it.computers.map { item -> item.copy(enabled = enabled) }) }
    fun describe(id: String, name: String, hostId: String) = change {
        it.update(id) { item -> item.copy(computer = name.ifBlank { item.computer }, hostId = hostId.ifBlank { item.hostId }) }
    }
    fun forget(id: String) = change { it.remove(id) }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(false).build())
        }.generateKey()
    }

    fun read(id: String): String? = synchronized(lock) {
        val stored = catalog().computers.firstOrNull { it.id == id } ?: return@synchronized null
        val value = Base64.decode(stored.encryptedCredential, Base64.NO_WRAP)
        require(value.size > 28)
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, value.copyOfRange(0, 12)))
            doFinal(value.copyOfRange(12, value.size)).toString(Charsets.UTF_8)
        }
    }

    fun save(credential: String, computer: String, hostId: String): SavedNetworkPairing = synchronized(lock) {
        require(hostId.isNotBlank())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = cipher.doFinal(credential.toByteArray(Charsets.UTF_8))
        val updated = catalog().add(UUID.randomUUID().toString(), computer.ifBlank { "已配对电脑" },
            Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP), hostId)
        check(prefs.edit().putString(CATALOG, updated.encode()).commit())
        updated.computers.first { it.hostId == hostId }
    }

    private companion object {
        const val ALIAS = "cliprelay-network-device-v1"
        const val CATALOG = "pairings_v2"
        val lock = Any()
    }
}
