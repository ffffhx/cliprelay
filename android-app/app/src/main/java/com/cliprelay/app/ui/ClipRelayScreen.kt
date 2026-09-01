package com.cliprelay.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
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
import java.text.DateFormat
import java.util.Date

@Composable
fun ClipRelayScreen(
    status: ReceiverStatus,
    settings: AppSettings,
    history: List<ReceivedClip>,
    updateState: UpdateState,
    onToggleReceiver: (Boolean) -> Unit,
    onSaveSettings: (AppSettings) -> Unit,
    onCopyText: (String) -> Unit,
    onCopyEndpoint: (String) -> Unit,
    onShareEndpoint: (String) -> Unit,
    onClearHistory: () -> Unit,
    onCheckUpdate: () -> Unit,
    onDownloadUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
) {
    val primaryAddress = status.addresses.firstOrNull()
    val endpoint = primaryAddress?.let { "$it:${status.port}" }

    LazyColumn(
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
                HistoryItem(clip = clip, onCopy = { onCopyText(clip.text) })
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
            text = "第一段文本抵达后会出现在这里。",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun HistoryItem(clip: ReceivedClip, onCopy: () -> Unit) {
    val time = remember(clip.receivedAt) {
        DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(clip.receivedAt))
    }
    Surface(
        modifier = Modifier.fillMaxWidth(),
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
                        .background(RelayViolet),
                )
                Spacer(Modifier.width(9.dp))
                Text(
                    text = time,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = onCopy) { Text("复制") }
            }
            Text(
                text = clip.text,
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 5,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
