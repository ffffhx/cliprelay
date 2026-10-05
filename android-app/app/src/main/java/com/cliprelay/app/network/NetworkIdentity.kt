package com.cliprelay.app.network

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Device identity stays on this installation; it is not a Tailscale account. */
internal class NetworkIdentity(context: Context) {
    private val prefs = context.getSharedPreferences("cliprelay_network", Context.MODE_PRIVATE)
    var enabled: Boolean
        get() = prefs.getBoolean("enabled", false)
        set(value) { prefs.edit().putBoolean("enabled", value).apply() }
    val exists: Boolean get() = prefs.contains("credential")

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

    fun read(): String? {
        val stored = prefs.getString("credential", null) ?: return null
        val value = Base64.decode(stored, Base64.NO_WRAP)
        require(value.size > 28)
        return Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, value.copyOfRange(0, 12)))
            doFinal(value.copyOfRange(12, value.size)).toString(Charsets.UTF_8)
        }
    }

    fun save(credential: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = cipher.doFinal(credential.toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString("credential", Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)).commit())
    }

    fun forget() { prefs.edit().remove("credential").putBoolean("enabled", false).commit() }
    private companion object { const val ALIAS = "cliprelay-network-device-v1" }
}
