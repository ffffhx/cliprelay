package com.cliprelay.app

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cliprelay.app.data.AppPreferences
import com.cliprelay.app.data.AppSettings
import com.cliprelay.app.data.HistoryRepository
import com.cliprelay.app.data.ReceivedClip
import com.cliprelay.app.runtime.ClipRelayRuntime
import com.cliprelay.app.runtime.ReceiverPhase
import com.cliprelay.app.runtime.ReceiverStatus
import com.cliprelay.app.service.ServiceController
import com.cliprelay.app.ui.ClipRelayScreen
import com.cliprelay.app.ui.theme.ClipRelayTheme
import com.cliprelay.app.update.ApkInstaller
import com.cliprelay.app.update.AppUpdater
import java.io.File

class MainActivity : ComponentActivity() {
    private var startReceiverAfterPermission = false
    private var waitingForInstallPermission = false
    private var immersiveFullscreen = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        if (!startReceiverAfterPermission) return@registerForActivityResult
        startReceiverAfterPermission = false

        if (hasLocalNetworkPermission()) {
            ServiceController.start(this)
        } else {
            ClipRelayRuntime.receiverStatus.value = ReceiverStatus(
                phase = ReceiverPhase.ERROR,
                port = AppPreferences.load(this).port,
                detail = "需要允许“本地网络”权限才能接收电脑文本",
            )
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        AppUpdater.startAutomaticChecks(this)

        if (AppPreferences.isReceiverEnabled(this) && hasLocalNetworkPermission()) {
            ServiceController.start(this)
        }

        val historyRepository = HistoryRepository(this)
        setContent {
            ClipRelayTheme {
                val receiverStatus by ClipRelayRuntime.receiverStatus.collectAsStateWithLifecycle()
                val historyRevision by ClipRelayRuntime.historyRevision.collectAsStateWithLifecycle()
                val updateState by AppUpdater.state.collectAsStateWithLifecycle()
                var settings by remember { mutableStateOf(AppPreferences.load(this)) }
                var history by remember { mutableStateOf(historyRepository.all()) }

                LaunchedEffect(historyRevision) {
                    history = historyRepository.all()
                }

                ClipRelayScreen(
                    status = receiverStatus,
                    settings = settings,
                    history = history,
                    updateState = updateState,
                    onToggleReceiver = { enabled ->
                        if (enabled) requestReceiverStart() else ServiceController.stop(this)
                    },
                    onSaveSettings = { updated ->
                        AppPreferences.save(this, updated)
                        settings = updated
                        ServiceController.restart(this)
                    },
                    onCopyClip = ::copyClipToClipboard,
                    onSetFullscreenLandscape = ::setFullscreenLandscape,
                    onSetImmersiveFullscreen = ::setImmersiveFullscreen,
                    onCopyEndpoint = { endpoint -> copyToClipboard(endpoint) },
                    onShareEndpoint = { endpoint -> shareEndpoint(endpoint, settings) },
                    onClearHistory = {
                        historyRepository.clear()
                        ClipRelayRuntime.historyChanged()
                    },
                    onCheckUpdate = { AppUpdater.checkNow(this) },
                    onDownloadUpdate = { AppUpdater.download(this) },
                    onInstallUpdate = ::requestInstallUpdate,
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (waitingForInstallPermission && ApkInstaller.canInstallPackages(this)) {
            waitingForInstallPermission = false
            launchReadyUpdate()
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && immersiveFullscreen) {
            applyImmersiveFullscreen()
        }
    }

    private fun requestReceiverStart() {
        val missingPermissions = buildList {
            if (Build.VERSION.SDK_INT >= 37 && !hasLocalNetworkPermission()) {
                add(ACCESS_LOCAL_NETWORK_PERMISSION)
            }
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(
                    this@MainActivity,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        if (missingPermissions.isEmpty()) {
            ServiceController.start(this)
        } else {
            startReceiverAfterPermission = true
            permissionLauncher.launch(missingPermissions.toTypedArray())
        }
    }

    private fun hasLocalNetworkPermission(): Boolean =
        Build.VERSION.SDK_INT < 37 ||
            ContextCompat.checkSelfPermission(this, ACCESS_LOCAL_NETWORK_PERMISSION) ==
            PackageManager.PERMISSION_GRANTED

    private fun copyToClipboard(text: String) {
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("ClipRelay", text))
    }

    private fun copyClipToClipboard(clip: ReceivedClip) {
        if (!clip.isImage) {
            copyToClipboard(clip.text)
            return
        }

        val imageFile = clip.imagePath?.let(::File)?.takeIf(File::isFile) ?: return
        val imageUri = FileProvider.getUriForFile(
            this,
            "$packageName.fileprovider",
            imageFile,
        )
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newUri(contentResolver, "ClipRelay screenshot", imageUri))
    }

    private fun setFullscreenLandscape(landscape: Boolean) {
        requestedOrientation = if (landscape) {
            ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        } else {
            ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }

    private fun setImmersiveFullscreen(enabled: Boolean) {
        immersiveFullscreen = enabled
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (enabled) {
            applyImmersiveFullscreen()
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun applyImmersiveFullscreen() {
        window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun shareEndpoint(endpoint: String, settings: AppSettings) {
        val details = buildString {
            append("ClipRelay Android 接收地址：$endpoint")
            if (settings.accessToken.isNotEmpty()) {
                append("\n访问密钥：${settings.accessToken}")
            }
        }
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, details)
        }
        startActivity(Intent.createChooser(intent, "分享 ClipRelay 配置"))
    }

    private fun requestInstallUpdate() {
        if (AppUpdater.apkReadyForInstall(this) == null) {
            AppUpdater.reportError("更新安装包不存在，请重新下载")
            return
        }
        if (!ApkInstaller.canInstallPackages(this)) {
            waitingForInstallPermission = true
            AppUpdater.reportInstallPermissionRequired()
            ApkInstaller.openInstallPermissionSettings(this)
            return
        }
        launchReadyUpdate()
    }

    private fun launchReadyUpdate() {
        val apk = AppUpdater.apkReadyForInstall(this) ?: run {
            AppUpdater.reportError("更新安装包不存在，请重新下载")
            return
        }
        runCatching { ApkInstaller.launchInstaller(this, apk) }
            .onFailure { error ->
                AppUpdater.reportError("无法打开系统安装器：${error.message ?: error.javaClass.simpleName}")
            }
    }

    private companion object {
        const val ACCESS_LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
    }
}
