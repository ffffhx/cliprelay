package com.cliprelay.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.content.res.Configuration
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.sp
import com.cliprelay.app.data.AppPreferences
import com.cliprelay.app.data.AppSettings
import com.cliprelay.app.data.ReceivedClip
import com.cliprelay.app.runtime.ReceiverPhase
import com.cliprelay.app.runtime.ReceiverStatus
import com.cliprelay.app.ui.theme.DeepRelay
import com.cliprelay.app.ui.theme.RelayBlue
import com.cliprelay.app.ui.theme.RelayViolet
import com.cliprelay.app.ui.theme.SignalCyan
import com.cliprelay.app.update.UpdatePhase
import com.cliprelay.app.update.UpdateState
import java.io.File
import java.text.DateFormat
import java.util.Date
import kotlin.math.max
import kotlin.math.min

@Composable
fun ClipRelayScreen(
    status: ReceiverStatus,
    settings: AppSettings,
    history: List<ReceivedClip>,
    updateState: UpdateState,
    onToggleReceiver: (Boolean) -> Unit,
    onSaveSettings: (AppSettings) -> Unit,
    onCopyClip: (ReceivedClip) -> Unit,
    onSetFullscreenLandscape: (Boolean) -> Unit,
    onSetImmersiveFullscreen: (Boolean) -> Unit,
    onCopyEndpoint: (String) -> Unit,
    onShareEndpoint: (String) -> Unit,
    onClearHistory: () -> Unit,
    onCheckUpdate: () -> Unit,
    onDownloadUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
) {
    val primaryAddress = status.addresses.firstOrNull()
    val endpoint = primaryAddress?.let { "$it:${status.port}" }
    val listState = rememberLazyListState()
    var fullscreenClipId by remember { mutableStateOf<Long?>(null) }

    fullscreenClipId?.let { selectedId ->
        if (history.isNotEmpty()) {
            key(selectedId) {
                HistoryFullscreenViewer(
                    history = history,
                    initialClipId = selectedId,
                    onDismiss = {
                        fullscreenClipId = null
                        onSetImmersiveFullscreen(false)
                        onSetFullscreenLandscape(false)
                    },
                    onCopy = onCopyClip,
                    onSetLandscape = onSetFullscreenLandscape,
                )
            }
            return
        }
    }

    LazyColumn(
        state = listState,
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .statusBarsPadding()
            .navigationBarsPadding(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(
            start = 20.dp,
            top = 24.dp,
            end = 20.dp,
            bottom = 36.dp,
        ),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item {
            AppHeader()
        }
        item {
            ReceiverPanel(
                status = status,
                primaryAddress = primaryAddress,
                endpoint = endpoint,
                onToggleReceiver = onToggleReceiver,
                onCopyEndpoint = onCopyEndpoint,
                onShareEndpoint = onShareEndpoint,
            )
        }
        item {
            SettingsPanel(
                settings = settings,
                receiverRunning = status.phase in setOf(
                    ReceiverPhase.RUNNING,
                    ReceiverPhase.STARTING,
                    ReceiverPhase.ERROR,
                ),
                onSave = onSaveSettings,
            )
        }
        item {
            UpdatePanel(
                state = updateState,
                onCheck = onCheckUpdate,
                onDownload = onDownloadUpdate,
                onInstall = onInstallUpdate,
            )
        }
        item {
            HistoryHeader(history.isNotEmpty(), onClearHistory)
        }
        if (history.isEmpty()) {
            item { EmptyHistory() }
        } else {
            items(history, key = { it.id }) { clip ->
                HistoryItem(
                    clip = clip,
                    onOpen = {
                        fullscreenClipId = clip.id
                        onSetImmersiveFullscreen(true)
                    },
                    onCopy = { onCopyClip(clip) },
                )
            }
        }
    }
}

@Composable
private fun UpdatePanel(
    state: UpdateState,
    onCheck: () -> Unit,
    onDownload: () -> Unit,
    onInstall: () -> Unit,
) {
    SectionSurface {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("软件更新", style = MaterialTheme.typography.headlineSmall)
                Text(
                    "当前 v${state.currentVersionName} (${state.currentVersionCode})",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                )
            }
            Text(
                text = when (state.phase) {
                    UpdatePhase.AVAILABLE, UpdatePhase.READY_TO_INSTALL -> "NEW"
                    UpdatePhase.DOWNLOADING -> "LOAD"
                    UpdatePhase.ERROR -> "CHECK"
                    else -> "AUTO"
                },
                color = when (state.phase) {
                    UpdatePhase.AVAILABLE, UpdatePhase.READY_TO_INSTALL -> RelayViolet
                    UpdatePhase.ERROR -> Color(0xFFCA544A)
                    else -> RelayBlue
                },
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                fontSize = 11.sp,
                letterSpacing = 1.2.sp,
            )
        }

        Spacer(Modifier.height(12.dp))
        Text(
            text = state.message ?: "每天自动检查一次，也可以立即检查。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.available?.releaseNotes?.takeIf(String::isNotBlank)?.let { notes ->
            Spacer(Modifier.height(8.dp))
            Text(
                text = notes,
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 5,
                overflow = TextOverflow.Ellipsis,
            )
        }

        if (state.phase == UpdatePhase.DOWNLOADING) {
            Spacer(Modifier.height(14.dp))
            val progress = state.progressPercent
            if (progress == null) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            } else {
                LinearProgressIndicator(
                    progress = { progress / 100f },
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(5.dp))
                Text(
                    "$progress%",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                )
            }
        }

        Spacer(Modifier.height(14.dp))
        val action = when (state.phase) {
            UpdatePhase.AVAILABLE -> "下载新版" to onDownload
            UpdatePhase.READY_TO_INSTALL -> "安装更新" to onInstall
            UpdatePhase.ERROR -> if (state.available != null) {
                "重新下载" to onDownload
            } else {
                "重新检查" to onCheck
            }
            UpdatePhase.CHECKING -> "正在检查…" to onCheck
            UpdatePhase.DOWNLOADING -> "正在下载…" to onDownload
            else -> "检查更新" to onCheck
        }
        Button(
            onClick = action.second,
            enabled = state.phase !in setOf(UpdatePhase.CHECKING, UpdatePhase.DOWNLOADING),
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(14.dp),
        ) {
            Text(action.first)
        }
    }
}

@Composable
private fun AppHeader() {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(
            text = "CLIP / RELAY",
            color = RelayBlue,
            fontSize = 12.sp,
            fontWeight = FontWeight.Black,
            letterSpacing = 2.4.sp,
        )
        Text(
            text = "让复制抵达手机",
            style = MaterialTheme.typography.displaySmall,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Text(
            text = "Windows 或 Mac 复制文本后，这里立即接收。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ReceiverPanel(
    status: ReceiverStatus,
    primaryAddress: String?,
    endpoint: String?,
    onToggleReceiver: (Boolean) -> Unit,
    onCopyEndpoint: (String) -> Unit,
    onShareEndpoint: (String) -> Unit,
) {
    val isActive = status.phase != ReceiverPhase.STOPPED
    val title = when (status.phase) {
        ReceiverPhase.STOPPED -> "接收已停止"
        ReceiverPhase.STARTING -> "正在建立接收站"
        ReceiverPhase.RUNNING -> "正在等待电脑复制"
        ReceiverPhase.ERROR -> "接收站需要处理"
    }
    val accent = when (status.phase) {
        ReceiverPhase.RUNNING -> SignalCyan
        ReceiverPhase.ERROR -> Color(0xFFFF9C8F)
        ReceiverPhase.STARTING -> Color(0xFF9FC8FF)
        ReceiverPhase.STOPPED -> Color(0xFF8195A8)
    }

    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = DeepRelay,
        contentColor = Color.White,
        shape = RoundedCornerShape(28.dp),
        shadowElevation = 2.dp,
    ) {
        Column(
            modifier = Modifier.padding(22.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(accent),
                )
                Spacer(Modifier.width(9.dp))
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = when (status.phase) {
                        ReceiverPhase.RUNNING -> "ONLINE"
                        ReceiverPhase.ERROR -> "CHECK"
                        ReceiverPhase.STARTING -> "STARTING"
                        ReceiverPhase.STOPPED -> "OFFLINE"
                    },
                    color = accent,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.4.sp,
                )
            }

            RelaySignalRail(active = status.phase == ReceiverPhase.RUNNING, accent = accent)

            Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(
                    text = "电脑端填写这个接收地址",
                    color = Color(0xFFAFC5D7),
                    fontSize = 12.sp,
                )
                Text(
                    text = endpoint ?: "等待 Wi-Fi 地址 · 端口 ${status.port}",
                    color = Color.White,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    fontSize = 18.sp,
                )
                if (status.addresses.size > 1) {
                    Text(
                        text = status.addresses.drop(1).joinToString("  ·  ") { "$it:${status.port}" },
                        color = Color(0xFF8FA9BC),
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                    )
                }
                status.detail?.let {
                    Text(
                        text = it,
                        color = accent,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = { onToggleReceiver(!isActive) },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (isActive) Color(0xFF203C54) else RelayBlue,
                        contentColor = Color.White,
                    ),
                    shape = RoundedCornerShape(14.dp),
                ) {
                    Text(if (isActive) "停止接收" else "开始接收")
                }
                primaryAddress?.let { address ->
                    TextButton(onClick = { onCopyEndpoint(address) }) { Text("复制 IP") }
                    TextButton(onClick = { onShareEndpoint("$address:${status.port}") }) { Text("分享") }
                }
            }
        }
    }
}

@Composable
private fun RelaySignalRail(active: Boolean, accent: Color) {
    val inactive = Color(0xFF536C80)
    Canvas(
        modifier = Modifier
            .fillMaxWidth()
            .height(46.dp)
            .semantics {
                contentDescription = if (active) "电脑到手机的接收通道已连接" else "接收通道未连接"
            },
    ) {
        val centerY = size.height / 2
        val startX = 7.dp.toPx()
        val endX = size.width - 7.dp.toPx()
        val middleX = size.width * 0.54f
        val lineColor = if (active) accent else inactive

        drawLine(
            color = lineColor.copy(alpha = 0.42f),
            start = Offset(startX, centerY),
            end = Offset(endX, centerY),
            strokeWidth = 3.dp.toPx(),
            cap = StrokeCap.Round,
        )
        listOf(startX, middleX, endX).forEachIndexed { index, x ->
            drawCircle(
                color = if (active || index == 0) lineColor else inactive,
                radius = if (index == 1) 6.dp.toPx() else 4.dp.toPx(),
                center = Offset(x, centerY),
            )
            if (index == 1) {
                drawCircle(
                    color = DeepRelay,
                    radius = 2.dp.toPx(),
                    center = Offset(x, centerY),
                )
            }
        }
        val arrowX = endX - 17.dp.toPx()
        val arrow = Path().apply {
            moveTo(arrowX, centerY - 6.dp.toPx())
            lineTo(arrowX + 10.dp.toPx(), centerY)
            lineTo(arrowX, centerY + 6.dp.toPx())
            close()
        }
        drawPath(arrow, lineColor)
    }
}

@Composable
private fun SettingsPanel(
    settings: AppSettings,
    receiverRunning: Boolean,
    onSave: (AppSettings) -> Unit,
) {
    var draft by remember(settings) { mutableStateOf(settings) }
    var portText by remember(settings.port) { mutableStateOf(settings.port.toString()) }
    var revealToken by remember { mutableStateOf(false) }
    val parsedPort = portText.toIntOrNull()
    val portValid = parsedPort != null && parsedPort in AppPreferences.MIN_PORT..AppPreferences.MAX_PORT
    val normalizedDraft = draft.copy(port = parsedPort ?: settings.port)
    val hasChanges = normalizedDraft != settings

    SectionSurface {
        Text("接收设置", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(5.dp))
        Text(
            text = "端口或密钥修改后，正在运行的接收站会自动重启。",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(18.dp))

        OutlinedTextField(
            value = portText,
            onValueChange = { portText = it.filter(Char::isDigit).take(5) },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("接收端口") },
            supportingText = {
                Text(if (portValid) "电脑端也使用同一端口" else "请输入 1024–65535")
            },
            isError = !portValid,
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            shape = RoundedCornerShape(15.dp),
        )

        Spacer(Modifier.height(10.dp))
        OutlinedTextField(
            value = draft.accessToken,
            onValueChange = { draft = draft.copy(accessToken = it.take(128)) },
            modifier = Modifier.fillMaxWidth(),
            label = { Text("访问密钥（可选）") },
            supportingText = {
                Text("启用后发送方需携带 X-ClipRelay-Token；兼容旧客户端请留空")
            },
            singleLine = true,
            visualTransformation = if (revealToken) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = {
                TextButton(onClick = { revealToken = !revealToken }) {
                    Text(if (revealToken) "隐藏" else "显示")
                }
            },
            shape = RoundedCornerShape(15.dp),
        )

        Spacer(Modifier.height(8.dp))
        SettingSwitch(
            title = "开机恢复接收",
            description = "手机重启或 App 更新后继续等待电脑发送",
            checked = draft.startOnBoot,
            onCheckedChange = { draft = draft.copy(startOnBoot = it) },
        )
        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f))
        SettingSwitch(
            title = "通知显示文本预览",
            description = "关闭后仍会提醒，但不在通知里展示内容",
            checked = draft.showNotificationPreview,
            onCheckedChange = { draft = draft.copy(showNotificationPreview = it) },
        )

        if (hasChanges) {
            Spacer(Modifier.height(14.dp))
            Button(
                onClick = { onSave(normalizedDraft.copy(accessToken = draft.accessToken.trim())) },
                enabled = portValid,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text(if (receiverRunning) "保存并重启接收" else "保存设置")
            }
        }
    }
}

@Composable
private fun SettingSwitch(
    title: String,
    description: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(
                description,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
private fun SectionSurface(content: @Composable ColumnScope.() -> Unit) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .border(
                width = 1.dp,
                color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f),
                shape = RoundedCornerShape(22.dp),
            ),
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(22.dp),
    ) {
        Column(modifier = Modifier.padding(20.dp), content = content)
    }
}

@Composable
private fun HistoryHeader(hasHistory: Boolean, onClearHistory: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text("最近抵达", style = MaterialTheme.typography.headlineSmall)
            Text(
                "仅保存在这台手机上，最多 30 条",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (hasHistory) {
            TextButton(onClick = onClearHistory) { Text("清空") }
        }
    }
}

@Composable
private fun EmptyHistory() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .border(
                1.dp,
                MaterialTheme.colorScheme.outline.copy(alpha = 0.38f),
                RoundedCornerShape(20.dp),
            )
            .padding(horizontal = 22.dp, vertical = 30.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "第一段文本或截图抵达后会出现在这里。",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun HistoryItem(
    clip: ReceivedClip,
    onOpen: () -> Unit,
    onCopy: () -> Unit,
) {
    val time = remember(clip.receivedAt) {
        DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(clip.receivedAt))
    }
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .semantics {
                contentDescription = if (clip.isImage) {
                    "打开收到的截图"
                } else {
                    "打开收到的文本"
                }
            }
            .clickable(onClick = onOpen),
        color = MaterialTheme.colorScheme.surface,
        shape = RoundedCornerShape(18.dp),
        tonalElevation = 1.dp,
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 18.dp, vertical = 15.dp),
            verticalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(width = 26.dp, height = 4.dp)
                        .clip(CircleShape)
                        .background(if (clip.isImage) SignalCyan else RelayViolet),
                )
                Spacer(Modifier.width(9.dp))
                Text(
                    text = time,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = if (clip.isImage) "IMAGE" else "TEXT",
                    color = if (clip.isImage) SignalCyan else RelayViolet,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.Bold,
                    fontSize = 10.sp,
                    letterSpacing = 1.sp,
                )
                Spacer(Modifier.width(4.dp))
                TextButton(onClick = onCopy) { Text("复制") }
            }
            if (clip.isImage) {
                HistoryImageThumbnail(clip)
            } else {
                Text(
                    text = clip.text,
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 5,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun HistoryImageThumbnail(clip: ReceivedClip) {
    val bitmap = rememberDecodedBitmap(
        path = clip.imagePath,
        maxWidth = 1_200,
        maxHeight = 800,
    )
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 150.dp, max = 220.dp)
            .clip(RoundedCornerShape(13.dp))
            .background(DeepRelay),
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap == null) {
            Text(
                "图片文件不可用",
                color = Color(0xFFAFC5D7),
                style = MaterialTheme.typography.bodyMedium,
            )
        } else {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = "收到的截图缩略图",
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Fit,
            )
        }
    }
}

@Composable
private fun HistoryFullscreenViewer(
    history: List<ReceivedClip>,
    initialClipId: Long,
    onDismiss: () -> Unit,
    onCopy: (ReceivedClip) -> Unit,
    onSetLandscape: (Boolean) -> Unit,
) {
    BackHandler(onBack = onDismiss)
    val isLandscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    var controlsVisible by remember { mutableStateOf(false) }
    var zoomedClipId by remember { mutableStateOf<Long?>(null) }
    val initialPage = remember(history, initialClipId) {
        history.indexOfFirst { it.id == initialClipId }.coerceAtLeast(0)
    }
    val pagerState = rememberPagerState(initialPage = initialPage) { history.size }
    val currentPage = pagerState.currentPage.coerceIn(0, history.lastIndex)
    val currentClip = history[currentPage]
    val receivedTime = remember(currentClip.receivedAt) {
        DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
            .format(Date(currentClip.receivedAt))
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = DeepRelay,
        contentColor = Color.White,
    ) {
        Box(modifier = Modifier.fillMaxSize()) {
            HorizontalPager(
                state = pagerState,
                modifier = Modifier.fillMaxSize(),
                key = { history[it].id },
                userScrollEnabled = zoomedClipId == null,
            ) { page ->
                val pageClip = history[page]
                FullscreenHistoryPage(
                    clip = pageClip,
                    onToggleControls = { controlsVisible = !controlsVisible },
                    onImageZoomedChange = { zoomed ->
                        if (zoomed) {
                            zoomedClipId = pageClip.id
                        } else if (zoomedClipId == pageClip.id) {
                            zoomedClipId = null
                        }
                    },
                )
            }

            if (controlsVisible) {
                FullscreenControls(
                    currentClip = currentClip,
                    receivedTime = receivedTime,
                    currentPage = currentPage,
                    pageCount = history.size,
                    isLandscape = isLandscape,
                    onDismiss = onDismiss,
                    onCopy = { onCopy(currentClip) },
                    onSetLandscape = onSetLandscape,
                    onHide = { controlsVisible = false },
                )
            }
        }
    }
}

@Composable
private fun BoxScope.FullscreenControls(
    currentClip: ReceivedClip,
    receivedTime: String,
    currentPage: Int,
    pageCount: Int,
    isLandscape: Boolean,
    onDismiss: () -> Unit,
    onCopy: () -> Unit,
    onSetLandscape: (Boolean) -> Unit,
    onHide: () -> Unit,
) {
    val accent = if (currentClip.isImage) SignalCyan else RelayViolet

    Row(
        modifier = Modifier
            .align(Alignment.TopCenter)
            .fillMaxWidth()
            .background(DeepRelay.copy(alpha = 0.88f))
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(
            onClick = onDismiss,
            colors = ButtonDefaults.textButtonColors(contentColor = Color.White),
        ) {
            Text("关闭")
        }
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = if (currentClip.isImage) "IMAGE ARRIVAL" else "TEXT ARRIVAL",
                color = accent,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                fontSize = 11.sp,
                letterSpacing = 1.3.sp,
            )
            Text(
                text = receivedTime,
                color = Color(0xFFAFC5D7),
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
            )
        }
        TextButton(
            onClick = onCopy,
            colors = ButtonDefaults.textButtonColors(contentColor = accent),
        ) {
            Text("复制")
        }
    }

    Column(
        modifier = Modifier
            .align(Alignment.BottomCenter)
            .fillMaxWidth()
            .background(DeepRelay.copy(alpha = 0.88f))
            .padding(top = 5.dp, bottom = 8.dp),
    ) {
        ArrivalPagerRail(
            page = currentPage,
            pageCount = pageCount,
            accent = accent,
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 22.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "%02d / %02d".format(currentPage + 1, pageCount),
                color = Color.White,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Bold,
                fontSize = 13.sp,
                letterSpacing = 1.4.sp,
            )
            Spacer(Modifier.weight(1f))
            TextButton(
                onClick = onHide,
                colors = ButtonDefaults.textButtonColors(contentColor = Color(0xFFAFC5D7)),
            ) {
                Text(if (pageCount > 1) "左右滑动 · 隐藏" else "隐藏控制")
            }
            Spacer(Modifier.width(6.dp))
            OrientationSelector(
                isLandscape = isLandscape,
                accent = accent,
                onSetLandscape = onSetLandscape,
            )
        }
    }
}

@Composable
private fun OrientationSelector(
    isLandscape: Boolean,
    accent: Color,
    onSetLandscape: (Boolean) -> Unit,
) {
    Surface(
        color = Color(0xFF16354D),
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(modifier = Modifier.padding(3.dp)) {
            OrientationChoice(
                label = "竖屏",
                selected = !isLandscape,
                accent = accent,
                onClick = { onSetLandscape(false) },
            )
            OrientationChoice(
                label = "横屏",
                selected = isLandscape,
                accent = accent,
                onClick = { onSetLandscape(true) },
            )
        }
    }
}

@Composable
private fun OrientationChoice(
    label: String,
    selected: Boolean,
    accent: Color,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .width(58.dp)
            .height(38.dp)
            .clip(RoundedCornerShape(9.dp))
            .background(if (selected) accent else Color.Transparent)
            .selectable(
                selected = selected,
                role = Role.RadioButton,
                onClick = onClick,
            )
            .semantics {
                contentDescription = "切换为$label"
                stateDescription = if (selected) "已选择" else "未选择"
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            color = if (selected) DeepRelay else Color(0xFFAFC5D7),
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun ArrivalPagerRail(page: Int, pageCount: Int, accent: Color) {
    Canvas(
        modifier = Modifier
            .fillMaxWidth()
            .height(16.dp)
            .padding(horizontal = 22.dp),
    ) {
        val start = 4.dp.toPx()
        val end = size.width - start
        val fraction = if (pageCount <= 1) 0f else page.toFloat() / (pageCount - 1)
        val x = start + (end - start) * fraction
        drawLine(
            color = Color(0xFF38536A),
            start = Offset(start, size.height / 2),
            end = Offset(end, size.height / 2),
            strokeWidth = 2.dp.toPx(),
            cap = StrokeCap.Round,
        )
        drawLine(
            color = accent,
            start = Offset(start, size.height / 2),
            end = Offset(x, size.height / 2),
            strokeWidth = 3.dp.toPx(),
            cap = StrokeCap.Round,
        )
        drawCircle(
            color = accent,
            radius = 5.dp.toPx(),
            center = Offset(x, size.height / 2),
        )
    }
}

@Composable
private fun FullscreenHistoryPage(
    clip: ReceivedClip,
    onToggleControls: () -> Unit,
    onImageZoomedChange: (Boolean) -> Unit,
) {
    val interactionSource = remember { MutableInteractionSource() }
    Box(
        modifier = Modifier
            .fillMaxSize()
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClickLabel = "显示或隐藏全屏控制",
                onClick = onToggleControls,
            ),
        contentAlignment = Alignment.TopCenter,
    ) {
        if (clip.isImage) {
            FullscreenHistoryImage(
                clip = clip,
                onZoomedChange = onImageZoomedChange,
            )
        } else {
            SelectionContainer {
                Column(
                    modifier = Modifier
                        .widthIn(max = 720.dp)
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 28.dp, vertical = 30.dp),
                ) {
                    Text(
                        text = clip.text,
                        color = Color(0xFFF2F7FC),
                        fontSize = 21.sp,
                        lineHeight = 32.sp,
                    )
                }
            }
        }
    }
}

@Composable
private fun FullscreenHistoryImage(
    clip: ReceivedClip,
    onZoomedChange: (Boolean) -> Unit,
) {
    val bitmap = rememberDecodedBitmap(
        path = clip.imagePath,
        maxWidth = 4_096,
        maxHeight = 4_096,
    )
    var scale by remember(clip.id) { mutableStateOf(MIN_IMAGE_SCALE) }
    var offset by remember(clip.id) { mutableStateOf(Offset.Zero) }
    var viewportSize by remember(clip.id) { mutableStateOf(IntSize.Zero) }
    val isZoomed = scale > MIN_IMAGE_SCALE + IMAGE_ZOOM_EPSILON

    LaunchedEffect(isZoomed) {
        onZoomedChange(isZoomed)
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .onSizeChanged { size ->
                viewportSize = size
                offset = clampImageOffset(
                    offset = offset,
                    scale = scale,
                    viewportSize = size,
                    imageWidth = bitmap?.width ?: 0,
                    imageHeight = bitmap?.height ?: 0,
                )
            }
            .then(
                if (bitmap == null) {
                    Modifier
                } else {
                    Modifier.pointerInput(clip.id, bitmap, viewportSize) {
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false)
                            var imageOwnsGesture = scale > MIN_IMAGE_SCALE + IMAGE_ZOOM_EPSILON

                            do {
                                val event = awaitPointerEvent()
                                val pressedPointers = event.changes.count { it.pressed }
                                if (pressedPointers >= 2) {
                                    imageOwnsGesture = true
                                }

                                if (imageOwnsGesture) {
                                    val oldScale = scale
                                    val zoomChange = event.calculateZoom()
                                    val panChange = event.calculatePan()
                                    val hasTransform =
                                        zoomChange != 1f || panChange != Offset.Zero
                                    if (!hasTransform) continue

                                    val newScale = (oldScale * zoomChange)
                                        .coerceIn(MIN_IMAGE_SCALE, MAX_IMAGE_SCALE)
                                    val scaleRatio = newScale / oldScale
                                    val proposedOffset = if (
                                        newScale <= MIN_IMAGE_SCALE + IMAGE_ZOOM_EPSILON
                                    ) {
                                        Offset.Zero
                                    } else {
                                        transformImageOffset(
                                            offset = offset,
                                            scaleRatio = scaleRatio,
                                            previousCentroid = event.calculateCentroid(
                                                useCurrent = false,
                                            ),
                                            panChange = panChange,
                                            viewportSize = viewportSize,
                                        )
                                    }

                                    scale = newScale
                                    offset = clampImageOffset(
                                        offset = proposedOffset,
                                        scale = newScale,
                                        viewportSize = viewportSize,
                                        imageWidth = bitmap.width,
                                        imageHeight = bitmap.height,
                                    )
                                    event.changes.forEach { it.consume() }
                                }
                            } while (event.changes.any { it.pressed })
                        }
                    }
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap == null) {
            Text(
                "图片文件不可用",
                color = Color(0xFFAFC5D7),
                style = MaterialTheme.typography.bodyLarge,
            )
        } else {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = buildString {
                    append("收到的截图")
                    if (clip.imageWidth != null && clip.imageHeight != null) {
                        append("，${clip.imageWidth} × ${clip.imageHeight}")
                    }
                    append("，支持双指缩放")
                },
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        scaleX = scale
                        scaleY = scale
                        translationX = offset.x
                        translationY = offset.y
                    },
                contentScale = ContentScale.Fit,
            )
        }
    }
}

internal fun clampImageOffset(
    offset: Offset,
    scale: Float,
    viewportSize: IntSize,
    imageWidth: Int,
    imageHeight: Int,
): Offset {
    if (
        scale <= MIN_IMAGE_SCALE + IMAGE_ZOOM_EPSILON ||
        viewportSize.width <= 0 ||
        viewportSize.height <= 0 ||
        imageWidth <= 0 ||
        imageHeight <= 0
    ) {
        return Offset.Zero
    }

    val fittedScale = min(
        viewportSize.width.toFloat() / imageWidth,
        viewportSize.height.toFloat() / imageHeight,
    )
    val maxOffsetX = max(
        0f,
        (imageWidth * fittedScale * scale - viewportSize.width) / 2f,
    )
    val maxOffsetY = max(
        0f,
        (imageHeight * fittedScale * scale - viewportSize.height) / 2f,
    )
    return Offset(
        x = offset.x.coerceIn(-maxOffsetX, maxOffsetX),
        y = offset.y.coerceIn(-maxOffsetY, maxOffsetY),
    )
}

private const val MIN_IMAGE_SCALE = 1f
private const val MAX_IMAGE_SCALE = 5f
private const val IMAGE_ZOOM_EPSILON = 0.001f

internal fun transformImageOffset(
    offset: Offset,
    scaleRatio: Float,
    previousCentroid: Offset,
    panChange: Offset,
    viewportSize: IntSize,
): Offset {
    val focusFromCenter = Offset(
        x = previousCentroid.x - viewportSize.width / 2f,
        y = previousCentroid.y - viewportSize.height / 2f,
    )
    return Offset(
        x = offset.x * scaleRatio +
            focusFromCenter.x * (1f - scaleRatio) +
            panChange.x,
        y = offset.y * scaleRatio +
            focusFromCenter.y * (1f - scaleRatio) +
            panChange.y,
    )
}

@Composable
private fun rememberDecodedBitmap(
    path: String?,
    maxWidth: Int,
    maxHeight: Int,
): Bitmap? {
    val bitmap = remember(path, maxWidth, maxHeight) {
        path?.let { decodeSampledBitmap(it, maxWidth, maxHeight) }
    }
    DisposableEffect(bitmap) {
        onDispose { bitmap?.recycle() }
    }
    return bitmap
}

private fun decodeSampledBitmap(path: String, maxWidth: Int, maxHeight: Int): Bitmap? {
    if (!File(path).isFile) return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    var sampleSize = 1
    while (
        bounds.outWidth / sampleSize > maxWidth * 2 ||
        bounds.outHeight / sampleSize > maxHeight * 2
    ) {
        sampleSize *= 2
    }
    return BitmapFactory.decodeFile(
        path,
        BitmapFactory.Options().apply { inSampleSize = sampleSize },
    )
}
