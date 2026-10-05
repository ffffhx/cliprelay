package com.cliprelay.app.service

import android.content.Context
import android.content.SharedPreferences
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.annotation.MainThread
import com.cliprelay.app.data.AppPreferences

/** Keeps the screen on while debugging, including on battery and outside our activities. */
@Suppress("DEPRECATION")
@MainThread
internal class DebugStayAwake(
    context: Context,
    private val readDebugSetting: (String) -> Int = {
        Settings.Global.getInt(context.contentResolver, it, 0)
    },
) : AutoCloseable {
    private val resolver = context.applicationContext.contentResolver
    private val preferences = context.applicationContext.getSharedPreferences(
        AppPreferences.FILE_NAME, Context.MODE_PRIVATE,
    )
    // An activity's FLAG_KEEP_SCREEN_ON cannot keep other apps awake. The service owns
    // this screen lock instead. Deliberately omit ACQUIRE_CAUSES_WAKEUP: manually
    // pressing the power button must still turn the display off and lock the phone.
    private val screenLock = context.getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK, "ClipRelay:DebugStayAwake")
        .apply { setReferenceCounted(false) }
    private var started = false
    private val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) = refresh()
    }
    private val preferenceListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == null || key == AppPreferences.KEY_DEBUG_STAY_AWAKE) refresh()
    }

    internal val isHoldingScreen: Boolean get() = screenLock.isHeld

    fun start() {
        if (started) return
        started = true
        try {
            resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ADB_ENABLED), false, observer)
            resolver.registerContentObserver(Settings.Global.getUriFor(ADB_WIFI_ENABLED), false, observer)
            preferences.registerOnSharedPreferenceChangeListener(preferenceListener)
            refresh()
        } catch (error: SecurityException) {
            close()
            Log.w(TAG, "Cannot observe debugging settings", error)
        }
    }

    internal fun refresh() {
        if (!started) return
        val keepAwake = try {
            preferences.getBoolean(AppPreferences.KEY_DEBUG_STAY_AWAKE, false) &&
                (readDebugSetting(Settings.Global.ADB_ENABLED) == 1 || readDebugSetting(ADB_WIFI_ENABLED) == 1)
        } catch (error: SecurityException) {
            // Restricted settings must not result in an unconditional screen lock.
            Log.w(TAG, "Cannot read debugging settings", error)
            false
        }
        if (keepAwake) {
            // No timeout: this is explicitly opted in and lasts until debugging is
            // disabled, the option is disabled, or the foreground service stops.
            if (!screenLock.isHeld) screenLock.acquire()
        } else {
            release()
        }
    }

    override fun close() {
        started = false
        resolver.unregisterContentObserver(observer)
        preferences.unregisterOnSharedPreferenceChangeListener(preferenceListener)
        release()
    }

    private fun release() {
        if (screenLock.isHeld) screenLock.release()
    }

    companion object {
        private const val TAG = "ClipRelayDebugAwake"
        internal const val ADB_WIFI_ENABLED = "adb_wifi_enabled"
    }
}
