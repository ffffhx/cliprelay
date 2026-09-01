package com.cliprelay.app.service

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.cliprelay.app.data.AppPreferences
import com.cliprelay.app.runtime.ClipRelayRuntime
import com.cliprelay.app.runtime.ReceiverPhase
import com.cliprelay.app.runtime.ReceiverStatus

object ServiceController {
    fun start(context: Context) {
        AppPreferences.setReceiverEnabled(context, true)
        val settings = AppPreferences.load(context)
        ClipRelayRuntime.receiverStatus.value = ReceiverStatus(
            phase = ReceiverPhase.STARTING,
            port = settings.port,
            detail = "正在打开局域网端口",
        )
        ContextCompat.startForegroundService(
            context,
            Intent(context, ClipRelayService::class.java)
                .setAction(ClipRelayService.ACTION_START),
        )
    }

    fun restart(context: Context) {
        if (!AppPreferences.isReceiverEnabled(context)) return
        ContextCompat.startForegroundService(
            context,
            Intent(context, ClipRelayService::class.java)
                .setAction(ClipRelayService.ACTION_RESTART),
        )
    }

    fun stop(context: Context) {
        AppPreferences.setReceiverEnabled(context, false)
        context.stopService(Intent(context, ClipRelayService::class.java))
        ClipRelayRuntime.receiverStatus.value = ReceiverStatus(
            phase = ReceiverPhase.STOPPED,
            port = AppPreferences.load(context).port,
        )
    }
}
