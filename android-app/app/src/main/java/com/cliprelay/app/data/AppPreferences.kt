package com.cliprelay.app.data

import android.content.Context
import androidx.core.content.edit

data class AppSettings(
    val port: Int,
    val startOnBoot: Boolean,
    val showNotificationPreview: Boolean,
    val accessToken: String,
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

    fun load(context: Context): AppSettings {
        val preferences = context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
        return AppSettings(
            port = preferences.getInt(KEY_PORT, DEFAULT_PORT).coerceIn(MIN_PORT, MAX_PORT),
            startOnBoot = preferences.getBoolean(KEY_START_ON_BOOT, true),
            showNotificationPreview = preferences.getBoolean(KEY_NOTIFICATION_PREVIEW, true),
            accessToken = preferences.getString(KEY_ACCESS_TOKEN, "").orEmpty(),
        )
    }

    fun save(context: Context, settings: AppSettings) {
        context.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE).edit {
            putInt(KEY_PORT, settings.port.coerceIn(MIN_PORT, MAX_PORT))
            putBoolean(KEY_START_ON_BOOT, settings.startOnBoot)
            putBoolean(KEY_NOTIFICATION_PREVIEW, settings.showNotificationPreview)
            putString(KEY_ACCESS_TOKEN, settings.accessToken.trim())
        }
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
