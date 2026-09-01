package com.cliprelay.app.service

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.BitmapFactory
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.cliprelay.app.MainActivity
import com.cliprelay.app.R
import com.cliprelay.app.data.AppPreferences
import com.cliprelay.app.data.HistoryRepository
import com.cliprelay.app.runtime.ClipRelayRuntime
import com.cliprelay.app.runtime.ReceiverPhase
import com.cliprelay.app.runtime.ReceiverStatus
import com.cliprelay.app.server.ClipRelayHttpServer
import com.cliprelay.app.util.NetworkAddresses
import com.cliprelay.app.update.AppUpdater
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

class ClipRelayService : Service(), ClipRelayHttpServer.Listener {
    private var server: ClipRelayHttpServer? = null
    private lateinit var historyRepository: HistoryRepository
    private lateinit var connectivityManager: ConnectivityManager
    private val receivedNotificationId = AtomicInteger(RECEIVED_NOTIFICATION_START_ID)
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = refreshRunningEndpoint()
        override fun onLost(network: Network) = refreshRunningEndpoint()
        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) =
            refreshRunningEndpoint()
    }

    override fun onCreate() {
        super.onCreate()
        historyRepository = HistoryRepository(this)
        connectivityManager = getSystemService(ConnectivityManager::class.java)
        connectivityManager.registerDefaultNetworkCallback(networkCallback)
        createNotificationChannels()
        AppUpdater.startAutomaticChecks(this)
        startAsForeground(buildReceiverNotification("正在启动局域网接收服务"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                AppPreferences.setReceiverEnabled(this, false)
                stopSelf()
                return START_NOT_STICKY
            }

            ACTION_RESTART -> restartServer()
            else -> if (server == null) {
                startServer()
            } else {
                onListening(AppPreferences.load(this).port)
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        server?.stop()
        server = null
        runCatching { connectivityManager.unregisterNetworkCallback(networkCallback) }
        ClipRelayRuntime.receiverStatus.value = ReceiverStatus(
            phase = ReceiverPhase.STOPPED,
            port = AppPreferences.load(this).port,
        )
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onListening(port: Int) {
        val addresses = NetworkAddresses.localIpv4()
        ClipRelayRuntime.receiverStatus.value = ReceiverStatus(
            phase = ReceiverPhase.RUNNING,
            port = port,
            addresses = addresses,
            detail = if (addresses.isEmpty()) "等待网络连接" else null,
        )
        updateReceiverNotification(
            if (addresses.isEmpty()) {
                "正在监听 :$port，等待网络连接"
            } else {
                "${addresses.first()}:$port"
            },
        )
    }

    override fun onTextReceived(text: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("ClipRelay", text))
        clearCachedClipboardImages()

        historyRepository.add(text)
        ClipRelayRuntime.historyChanged()
        showReceivedNotification(text)
    }

    override fun onImageReceived(bytes: ByteArray, mediaType: String) {
        val dimensions = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, dimensions)
        val pixelCount = dimensions.outWidth.toLong() * dimensions.outHeight.toLong()
        require(
            dimensions.outWidth in 1..MAX_IMAGE_DIMENSION &&
                dimensions.outHeight in 1..MAX_IMAGE_DIMENSION &&
                pixelCount in 1..MAX_IMAGE_PIXELS
        ) { "Invalid or oversized JPEG dimensions" }

        val imageDirectory = File(cacheDir, IMAGE_CLIPBOARD_DIRECTORY).apply {
            check(isDirectory || mkdirs()) { "Cannot create the image clipboard cache" }
        }
        val imageFile = File.createTempFile("cliprelay-", ".jpg", imageDirectory)
        try {
            imageFile.outputStream().use { it.write(bytes) }
            val imageUri = FileProvider.getUriForFile(
                this,
                "$packageName.fileprovider",
                imageFile,
            )
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newUri(contentResolver, "ClipRelay screenshot", imageUri))

            clearCachedClipboardImages(keep = imageFile)
            showReceivedImageNotification(dimensions.outWidth, dimensions.outHeight)
        } catch (error: Exception) {
            runCatching { imageFile.delete() }
            throw error
        }
    }

    override fun onFailure(message: String) {
        val settings = AppPreferences.load(this)
        ClipRelayRuntime.receiverStatus.value = ReceiverStatus(
            phase = ReceiverPhase.ERROR,
            port = settings.port,
            addresses = NetworkAddresses.localIpv4(),
            detail = message,
        )
        updateReceiverNotification("无法监听 ${settings.port}：$message")
    }

    private fun startServer() {
        val settings = AppPreferences.load(this)
        AppPreferences.setReceiverEnabled(this, true)
        ClipRelayRuntime.receiverStatus.value = ReceiverStatus(
            phase = ReceiverPhase.STARTING,
            port = settings.port,
            detail = "正在打开局域网端口",
        )
        server = ClipRelayHttpServer(
            port = settings.port,
            accessToken = { AppPreferences.load(this).accessToken },
            listener = this,
        ).also { it.start() }
    }

    private fun refreshRunningEndpoint() {
        val current = ClipRelayRuntime.receiverStatus.value
        if (current.phase == ReceiverPhase.RUNNING) {
            onListening(current.port)
        }
    }

    private fun restartServer() {
        server?.stop()
        server = null
        startServer()
    }

    private fun createNotificationChannels() {
        val notificationManager = getSystemService(NotificationManager::class.java)
        notificationManager.createNotificationChannels(
            listOf(
                NotificationChannel(
                    RECEIVER_CHANNEL_ID,
                    getString(R.string.receiver_channel_name),
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = getString(R.string.receiver_channel_description)
                    setShowBadge(false)
                },
                NotificationChannel(
                    CLIPS_CHANNEL_ID,
                    getString(R.string.clips_channel_name),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    description = getString(R.string.clips_channel_description)
                },
            ),
        )
    }

    private fun startAsForeground(notification: Notification) {
        val foregroundServiceType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        } else {
            0
        }
        ServiceCompat.startForeground(
            this,
            RECEIVER_NOTIFICATION_ID,
            notification,
            foregroundServiceType,
        )
    }

    private fun updateReceiverNotification(detail: String) {
        startAsForeground(buildReceiverNotification(detail))
    }

    private fun buildReceiverNotification(detail: String): Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopService = PendingIntent.getService(
            this,
            1,
            Intent(this, ClipRelayService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, RECEIVER_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.notification_running_title))
            .setContentText(detail)
            .setContentIntent(openApp)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .addAction(0, getString(R.string.notification_stop), stopService)
            .build()
    }

    private fun showReceivedNotification(text: String) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val settings = AppPreferences.load(this)
        val content = if (settings.showNotificationPreview) {
            text.replace(Regex("\\s+"), " ").take(120)
        } else {
            getString(R.string.notification_received_hidden)
        }
        val openApp = PendingIntent.getActivity(
            this,
            2,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CLIPS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.notification_received_title))
            .setContentText(content)
            .setStyle(NotificationCompat.BigTextStyle().bigText(content))
            .setContentIntent(openApp)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()

        NotificationManagerCompat.from(this).notify(
            receivedNotificationId.updateAndGet {
                if (it >= RECEIVED_NOTIFICATION_END_ID) RECEIVED_NOTIFICATION_START_ID else it + 1
            },
            notification,
        )
    }

    private fun showReceivedImageNotification(width: Int, height: Int) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val openApp = PendingIntent.getActivity(
            this,
            3,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CLIPS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.notification_image_received_title))
            .setContentText(getString(R.string.notification_image_received_body, width, height))
            .setContentIntent(openApp)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build()

        NotificationManagerCompat.from(this).notify(
            receivedNotificationId.updateAndGet {
                if (it >= RECEIVED_NOTIFICATION_END_ID) RECEIVED_NOTIFICATION_START_ID else it + 1
            },
            notification,
        )
    }

    private fun clearCachedClipboardImages(keep: File? = null) {
        File(cacheDir, IMAGE_CLIPBOARD_DIRECTORY).listFiles()
            ?.filter { it != keep }
            ?.forEach { runCatching { it.delete() } }
    }

    companion object {
        const val ACTION_START = "com.cliprelay.app.action.START"
        const val ACTION_RESTART = "com.cliprelay.app.action.RESTART"
        const val ACTION_STOP = "com.cliprelay.app.action.STOP"

        private const val RECEIVER_CHANNEL_ID = "cliprelay_receiver"
        private const val CLIPS_CHANNEL_ID = "cliprelay_clips"
        private const val RECEIVER_NOTIFICATION_ID = 47632
        private const val RECEIVED_NOTIFICATION_START_ID = 47700
        private const val RECEIVED_NOTIFICATION_END_ID = 47799
        private const val IMAGE_CLIPBOARD_DIRECTORY = "clipboard_images"
        private const val MAX_IMAGE_DIMENSION = 32_768
        private const val MAX_IMAGE_PIXELS = 100_000_000L
    }
}
