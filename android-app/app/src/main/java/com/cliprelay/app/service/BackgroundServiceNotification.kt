package com.cliprelay.app.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.cliprelay.app.MainActivity
import com.cliprelay.app.R

/** Both persistent services share one notification, regardless of their start/stop order. */
object BackgroundServiceNotification {
    // Keep the receiver channel and ID so existing notification preferences are preserved.
    private const val CHANNEL_ID = "cliprelay_receiver"
    private const val NOTIFICATION_ID = 47632

    fun start(service: Service) {
        service.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                service.getString(R.string.background_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = service.getString(R.string.background_channel_description)
                setShowBadge(false)
            },
        )
        val openApp = PendingIntent.getActivity(
            service,
            0,
            Intent(service, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(service, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(service.getString(R.string.app_name))
            .setContentText(service.getString(R.string.notification_background_running))
            .setContentIntent(openApp)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        ServiceCompat.startForeground(
            service,
            NOTIFICATION_ID,
            notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            } else {
                0
            },
        )
    }

    fun stop(service: Service) {
        // Android retains a shared notification until the last foreground service stops.
        ServiceCompat.stopForeground(service, ServiceCompat.STOP_FOREGROUND_REMOVE)
    }
}
