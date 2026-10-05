package com.cliprelay.app.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.cliprelay.app.data.AppPreferences
import com.cliprelay.app.runtime.LegacyStreamTasks
import com.cliprelay.app.service.ServiceController

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)) {
            return
        }
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) LegacyStreamTasks.remove(context)
        val settings = AppPreferences.load(context)
        if (settings.startOnBoot) com.cliprelay.app.network.NetworkConnectionService.restore(context)
        if (settings.startOnBoot && AppPreferences.isReceiverEnabled(context)) {
            ServiceController.start(context)
        }
    }
}
