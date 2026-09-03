package com.cliprelay.app.data

import android.content.Context
import android.os.Build
import androidx.core.content.edit
import com.cliprelay.app.discovery.ClipRelayDiscovery
import java.util.UUID

data class AppSettings(
    val port: Int,
    val startOnBoot: Boolean,
    val showNotificationPreview: Boolean,
    val accessToken: String,
    val fullscreenTextSizeSp: Int,
    val deviceName: String,
    val discoveryEnabled: Boolean,
)

object AppPreferences {
    const val DEFAULT_PORT = 47632
    const val MIN_PORT = 1024
    const val MAX_PORT = 65535

    private const val FILE_NAME = "cliprelay_settings"
    private const val KEY_PORT = "port"
    private const val KEY_RECEIVER_ENABLED = "receiver_enabled"
    private const val KEY_START_ON_BOOT = "start_on_boot"
    private const val KEY_NOTIFICATION_PREVIEW = "notification_preview"
    private const val KEY_ACCESS_TOKEN = "access_token"
    private const val KEY_FULLSCREEN_TEXT_SIZE_SP = "fullscreen_text_size_sp"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_DEVICE_NAME = "device_name"
    private const val KEY_DEVICE_NAME_VERSION = "device_name_version"
    private const val KEY_DISCOVERY_ENABLED = "discovery_enabled"
    private const val DEVICE_NAME_VERSION_BRAND_AND_MODEL = 2

    fun load(context: Context): AppSettings {
        val preferences = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
        return AppSettings(
            port = preferences.getInt(KEY_PORT, DEFAULT_PORT).coerceIn(MIN_PORT, MAX_PORT),
            startOnBoot = preferences.getBoolean(KEY_START_ON_BOOT, true),
            showNotificationPreview = preferences.getBoolean(KEY_NOTIFICATION_PREVIEW, true),
            accessToken = preferences.getString(KEY_ACCESS_TOKEN, "").orEmpty(),
            fullscreenTextSizeSp = FullscreenTextSize.normalize(
                preferences.getInt(KEY_FULLSCREEN_TEXT_SIZE_SP, FullscreenTextSize.DEFAULT_SP),
            ),
            deviceName = loadDeviceName(preferences),
            discoveryEnabled = preferences.getBoolean(KEY_DISCOVERY_ENABLED, true),
        )
    }

    fun save(context: Context, settings: AppSettings) {
        context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE).edit {
            putInt(KEY_PORT, settings.port.coerceIn(MIN_PORT, MAX_PORT))
            putBoolean(KEY_START_ON_BOOT, settings.startOnBoot)
            putBoolean(KEY_NOTIFICATION_PREVIEW, settings.showNotificationPreview)
            putString(KEY_ACCESS_TOKEN, settings.accessToken.trim())
            putInt(
                KEY_FULLSCREEN_TEXT_SIZE_SP,
                FullscreenTextSize.normalize(settings.fullscreenTextSizeSp),
            )
            putString(KEY_DEVICE_NAME, ClipRelayDiscovery.normalizeDeviceName(settings.deviceName))
            putInt(KEY_DEVICE_NAME_VERSION, DEVICE_NAME_VERSION_BRAND_AND_MODEL)
            putBoolean(KEY_DISCOVERY_ENABLED, settings.discoveryEnabled)
        }
    }

    private fun loadDeviceName(preferences: android.content.SharedPreferences): String {
        val automaticName = ClipRelayDiscovery.defaultDeviceName(
            brand = Build.BRAND,
            manufacturer = Build.MANUFACTURER,
            model = Build.MODEL,
        )
        val stored = preferences.getString(KEY_DEVICE_NAME, null).orEmpty()
        if (preferences.getInt(KEY_DEVICE_NAME_VERSION, 0) < DEVICE_NAME_VERSION_BRAND_AND_MODEL) {
            val oldAutomaticName = ClipRelayDiscovery.normalizeDeviceName(Build.MODEL)
            val migrated = if (stored.isBlank() || stored.equals(oldAutomaticName, ignoreCase = true)) {
                automaticName
            } else {
                ClipRelayDiscovery.normalizeDeviceName(stored)
            }
            preferences.edit {
                putString(KEY_DEVICE_NAME, migrated)
                putInt(KEY_DEVICE_NAME_VERSION, DEVICE_NAME_VERSION_BRAND_AND_MODEL)
            }
            return migrated
        }
        return if (stored.isBlank()) automaticName else ClipRelayDiscovery.normalizeDeviceName(stored)
    }

    @Synchronized
    fun deviceId(context: Context): String {
        val preferences = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
        preferences.getString(KEY_DEVICE_ID, null)
            ?.trim()
            ?.takeIf(String::isNotEmpty)
            ?.let { return it }

        val generated = UUID.randomUUID().toString().replace("-", "")
        preferences.edit().putString(KEY_DEVICE_ID, generated).commit()
        return generated
    }

    fun isReceiverEnabled(context: Context): Boolean =
        context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
            .getBoolean(KEY_RECEIVER_ENABLED, false)

    fun setReceiverEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE).edit {
            putBoolean(KEY_RECEIVER_ENABLED, enabled)
        }
    }
}
