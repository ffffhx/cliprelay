package com.cliprelay.app.update

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.core.content.pm.PackageInfoCompat
import com.cliprelay.app.BuildConfig
import com.cliprelay.app.MainActivity
import com.cliprelay.app.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

object AppUpdater {
    val state = MutableStateFlow(UpdateState())

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var automaticChecksJob: Job? = null

    @Synchronized
    fun startAutomaticChecks(context: Context) {
        if (automaticChecksJob?.isActive == true) return
        val applicationContext = context.applicationContext
        automaticChecksJob = scope.launch {
            checkOnce(applicationContext, force = false)
            while (isActive) {
                delay(CHECK_INTERVAL_MILLIS)
                checkOnce(applicationContext, force = false)
            }
        }
    }

    @Synchronized
    fun checkNow(context: Context) {
        if (state.value.phase == UpdatePhase.CHECKING) return
        state.value = state.value.copy(
            phase = UpdatePhase.CHECKING,
            progressPercent = null,
            message = "正在连接更新服务器",
        )
        scope.launch { checkOnce(context.applicationContext, force = true, phaseAlreadySet = true) }
    }

    @Synchronized
    fun download(context: Context) {
        val info = state.value.available ?: return
        if (state.value.phase == UpdatePhase.DOWNLOADING) return
        state.value = state.value.copy(
            phase = UpdatePhase.DOWNLOADING,
            progressPercent = 0,
            message = "正在下载 v${info.versionName}",
        )
        scope.launch { downloadUpdate(context.applicationContext, info) }
    }

    fun apkReadyForInstall(context: Context): File? {
        val current = state.value
        val info = current.available ?: return null
        if (current.phase != UpdatePhase.READY_TO_INSTALL) return null
        return updateApkFile(context, info).takeIf(File::isFile)
    }

    fun reportInstallPermissionRequired() {
        state.value = state.value.copy(
            phase = UpdatePhase.READY_TO_INSTALL,
            message = "请允许 ClipRelay 安装更新，然后返回继续",
        )
    }

    fun reportError(message: String) {
        state.value = state.value.copy(phase = UpdatePhase.ERROR, message = message)
    }

    private suspend fun checkOnce(
        context: Context,
        force: Boolean,
        phaseAlreadySet: Boolean = false,
    ) {
        val preferences = context.getSharedPreferences(PREFERENCES_FILE, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val lastCheck = preferences.getLong(KEY_LAST_CHECK, 0L)
        if (!force && now - lastCheck < CHECK_INTERVAL_MILLIS) return

        if (!phaseAlreadySet) {
            state.value = state.value.copy(
                phase = UpdatePhase.CHECKING,
                progressPercent = null,
                message = "正在自动检查更新",
            )
        }

        try {
            val manifestJson = fetchText(BuildConfig.UPDATE_MANIFEST_URL)
            val info = UpdateManifestParser.parse(manifestJson)
            preferences.edit { putLong(KEY_LAST_CHECK, now) }

            if (info.versionCode <= BuildConfig.VERSION_CODE.toLong()) {
                state.value = UpdateState(
                    phase = UpdatePhase.UP_TO_DATE,
                    message = "当前已是最新版",
                )
                NotificationManagerCompat.from(context).cancel(UPDATE_NOTIFICATION_ID)
                return
            }

            val downloaded = updateApkFile(context, info)
            val ready = downloaded.isFile && runCatching {
                verifyDownloadedApk(context, downloaded, info)
            }.isSuccess
            state.value = UpdateState(
                phase = if (ready) UpdatePhase.READY_TO_INSTALL else UpdatePhase.AVAILABLE,
                available = info,
                message = if (ready) {
                    "新版已下载，可以安装"
                } else {
                    "发现 v${info.versionName}"
                },
            )
            showUpdateNotification(context, info)
        } catch (_: NoPublishedReleaseException) {
            preferences.edit { putLong(KEY_LAST_CHECK, now) }
            state.value = UpdateState(
                phase = UpdatePhase.UP_TO_DATE,
                message = "当前已是最新版，线上发布通道尚未启用",
            )
        } catch (error: Exception) {
            state.value = state.value.copy(
                phase = UpdatePhase.ERROR,
                progressPercent = null,
                message = "检查更新失败：${error.userMessage()}",
            )
        }
    }

    private fun downloadUpdate(context: Context, info: UpdateInfo) {
        val updateDirectory = File(context.filesDir, UPDATE_DIRECTORY).apply { mkdirs() }
        val target = updateApkFile(context, info)
        val partial = File(updateDirectory, "${target.name}.part")
        partial.delete()

        try {
            val digest = MessageDigest.getInstance("SHA-256")
            val connection = openConnectionFollowingRedirects(info.apkUrl, APK_MIME_TYPE)
            try {
                val contentLength = connection.contentLengthLong
                if (contentLength > MAX_APK_BYTES) {
                    error("安装包超过允许的大小")
                }
                var totalBytes = 0L
                connection.inputStream.use { input ->
                    FileOutputStream(partial).use { output ->
                        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            totalBytes += read
                            if (totalBytes > MAX_APK_BYTES) error("安装包超过允许的大小")
                            digest.update(buffer, 0, read)
                            output.write(buffer, 0, read)
                            val progress = if (contentLength > 0) {
                                ((totalBytes * 100) / contentLength).toInt().coerceIn(0, 100)
                            } else {
                                null
                            }
                            state.value = state.value.copy(progressPercent = progress)
                        }
                    }
                }
            } finally {
                connection.disconnect()
            }

            val actualDigest = digest.digest().joinToString("") { "%02x".format(it) }
            require(actualDigest == info.sha256) { "安装包校验失败" }
            if (target.exists()) {
                check(target.delete()) { "无法替换旧的更新安装包" }
            }
            check(partial.renameTo(target)) { "无法保存安装包" }
            verifyDownloadedApk(context, target, info)
            updateDirectory.listFiles()
                ?.filter { it != target && (it.extension == "apk" || it.extension == "part") }
                ?.forEach(File::delete)
            state.value = UpdateState(
                phase = UpdatePhase.READY_TO_INSTALL,
                available = info,
                progressPercent = 100,
                message = "下载完成，请安装更新",
            )
        } catch (error: Exception) {
            partial.delete()
            target.delete()
            state.value = UpdateState(
                phase = UpdatePhase.ERROR,
                available = info,
                message = "下载更新失败：${error.userMessage()}",
            )
        }
    }

    private fun fetchText(url: String): String {
        val connection = try {
            openConnectionFollowingRedirects(url, JSON_MIME_TYPE)
        } catch (error: HttpStatusException) {
            if (error.statusCode == HttpURLConnection.HTTP_NOT_FOUND) {
                throw NoPublishedReleaseException()
            }
            throw error
        }
        return try {
            val bytes = connection.inputStream.use { input ->
                ByteArrayOutputStream().use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var totalBytes = 0
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        totalBytes += read
                        require(totalBytes <= MAX_MANIFEST_BYTES) { "更新信息过大" }
                        output.write(buffer, 0, read)
                    }
                    output.toByteArray()
                }
            }
            bytes.toString(Charsets.UTF_8)
        } finally {
            connection.disconnect()
        }
    }

    private fun openConnectionFollowingRedirects(url: String, accept: String): HttpURLConnection {
        var current = URL(url)
        repeat(MAX_REDIRECTS + 1) { redirectCount ->
            require(current.protocol.equals("https", ignoreCase = true)) {
                "更新连接必须使用 HTTPS"
            }
            val connection = (current.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = CONNECT_TIMEOUT_MILLIS
                readTimeout = READ_TIMEOUT_MILLIS
                requestMethod = "GET"
                setRequestProperty("Accept", accept)
                setRequestProperty("User-Agent", "ClipRelay-Android/${BuildConfig.VERSION_NAME}")
            }
            val responseCode = connection.responseCode
            if (responseCode in REDIRECT_STATUS_CODES) {
                val location = connection.getHeaderField("Location")
                    ?: throw IllegalStateException("更新服务器返回了无地址的跳转")
                connection.disconnect()
                if (redirectCount == MAX_REDIRECTS) error("更新服务器跳转次数过多")
                current = URL(current, location)
            } else {
                if (responseCode !in 200..299) {
                    connection.disconnect()
                    throw HttpStatusException(responseCode)
                }
                return connection
            }
        }
        error("更新服务器跳转次数过多")
    }

    private fun verifyDownloadedApk(context: Context, apk: File, info: UpdateInfo) {
        val packageManager = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            @Suppress("DEPRECATION")
            PackageManager.GET_SIGNATURES
        }
        val archive = packageManager.getPackageArchiveInfo(apk.absolutePath, flags)
            ?: error("安装包无法读取")
        require(archive.packageName == context.packageName) { "安装包不是 ClipRelay" }
        val archiveVersionCode = PackageInfoCompat.getLongVersionCode(archive)
        require(archiveVersionCode == info.versionCode) { "安装包版本与更新信息不一致" }
        require(archiveVersionCode > BuildConfig.VERSION_CODE.toLong()) { "安装包不是更高版本" }

        val installed = packageManager.getPackageInfo(context.packageName, flags)
        require(signatures(installed) == signatures(archive)) { "安装包签名不匹配" }
    }

    @Suppress("DEPRECATION")
    private fun signatures(info: PackageInfo): Set<String> {
        val values = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners.orEmpty()
        } else {
            info.signatures.orEmpty()
        }
        return values.map { signature ->
            MessageDigest.getInstance("SHA-256")
                .digest(signature.toByteArray())
                .joinToString("") { "%02x".format(it) }
        }.toSet()
    }

    private fun showUpdateNotification(context: Context, info: UpdateInfo) {
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val notificationManager = context.getSystemService(NotificationManager::class.java)
        notificationManager.createNotificationChannel(
            NotificationChannel(
                UPDATE_CHANNEL_ID,
                context.getString(R.string.updates_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = context.getString(R.string.updates_channel_description)
            },
        )
        val openApp = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, UPDATE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.notification_update_title))
            .setContentText("v${info.versionName} 已可下载")
            .setContentIntent(openApp)
            .setAutoCancel(true)
            .build()
        runCatching {
            NotificationManagerCompat.from(context).notify(UPDATE_NOTIFICATION_ID, notification)
        }
    }

    private fun updateApkFile(context: Context, info: UpdateInfo): File =
        File(File(context.filesDir, UPDATE_DIRECTORY), "ClipRelay-${info.versionCode}.apk")

    private fun Throwable.userMessage(): String =
        message?.trim()?.takeIf(String::isNotEmpty) ?: javaClass.simpleName

    private class NoPublishedReleaseException : Exception()

    private class HttpStatusException(val statusCode: Int) :
        Exception("更新服务器返回 HTTP $statusCode")

    private const val PREFERENCES_FILE = "cliprelay_updater"
    private const val KEY_LAST_CHECK = "last_check"
    private const val UPDATE_DIRECTORY = "updates"
    private const val UPDATE_CHANNEL_ID = "cliprelay_updates"
    private const val UPDATE_NOTIFICATION_ID = 21001
    private const val JSON_MIME_TYPE = "application/json"
    private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
    private const val CHECK_INTERVAL_MILLIS = 24L * 60L * 60L * 1000L
    private const val CONNECT_TIMEOUT_MILLIS = 15_000
    private const val READ_TIMEOUT_MILLIS = 60_000
    private const val MAX_REDIRECTS = 5
    private const val MAX_MANIFEST_BYTES = 128 * 1024
    private const val MAX_APK_BYTES = 200L * 1024L * 1024L
    private val REDIRECT_STATUS_CODES = setOf(301, 302, 303, 307, 308)
}
