package com.cliprelay.app.network

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/** Real Android Keystore with a separate preference file; no saved user identity is read. */
class NetworkIdentityTest {
    private val base = InstrumentationRegistry.getInstrumentation().targetContext
    private val preferenceName = "network-identity-test-${UUID.randomUUID()}"
    private val preferences = base.getSharedPreferences(preferenceName, Context.MODE_PRIVATE)
    private val context = object : ContextWrapper(base) {
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences = preferences
    }

    @After fun removeTestPreferences() {
        base.deleteSharedPreferences(preferenceName)
    }

    @Test fun encryptedLegacyIdentitySurvivesMigrationAndAddingASecondComputer() {
        val identity = NetworkIdentity(context)
        val oldSecret = "legacy-private-test-credential"
        val old = identity.save(oldSecret, "Home", "home-host")
        // The old release stores this exact IV + AES-GCM ciphertext format.
        assertTrue(preferences.edit().clear().putString("credential", old.encryptedCredential)
            .putBoolean("enabled", false).commit())

        val migrated = NetworkIdentity(context)
        val original = migrated.list().single()
        assertFalse(original.enabled)
        assertEquals("127.120.0.1", original.address)
        assertEquals(oldSecret, migrated.read(original.id))
        assertFalse(preferences.contains("credential"))
        assertFalse(preferences.contains("enabled"))
        val second = migrated.save("office-private-test-credential", "Office", "office-host")

        val reopened = NetworkIdentity(context)
        assertEquals(2, reopened.list().size)
        assertEquals(oldSecret, reopened.read(original.id))
        assertEquals("office-private-test-credential", reopened.read(second.id))
        assertFalse(reopened.list().first().enabled)
        assertFalse(preferences.all.toString().contains(oldSecret))
        reopened.forget(second.id)
        assertEquals(original, reopened.list().single())
        assertEquals(oldSecret, reopened.read(original.id))
    }

    @Test fun reauthorizationUpdatesOnlyItsOwnEncryptedIdentity() {
        val identity = NetworkIdentity(context)
        val home = identity.save("old-home-credential", "Home", "host-home")
        val office = identity.save("office-credential", "Office", "host-office")
        identity.setEnabled(home.id, false)
        val replacement = identity.save("new-home-credential", "Home renamed", "host-home")
        assertEquals(home.id, replacement.id)
        assertEquals(home.address, replacement.address)
        assertTrue(replacement.enabled)
        val reopened = NetworkIdentity(context)
        assertEquals("new-home-credential", reopened.read(home.id))
        assertEquals("office-credential", reopened.read(office.id))
        assertEquals(office, reopened.list().last())
        assertEquals(2, reopened.list().size)
    }
}
