package com.cliprelay.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.limelight.nvstream.http.ComputerDetails
import kotlinx.coroutines.delay

@Composable
internal fun ComputerCard(
    computer: HomeComputer,
    connecting: Boolean,
    connectionBusy: Boolean,
    onConnect: () -> Unit,
    onCancel: () -> Unit,
    onRescan: () -> Unit,
    onActions: () -> Unit,
) {
    val online = computer.state == ComputerDetails.State.ONLINE
    val offline = computer.state == ComputerDetails.State.OFFLINE
    val stateColor = if (online) Color(0xFF338267) else MaterialTheme.colorScheme.onSurfaceVariant
    Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surface,
        modifier = Modifier.fillMaxWidth().testTag("computer-${computer.uuid}")) {
        Row(Modifier.padding(start = 16.dp, top = 16.dp, bottom = 16.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.primary.copy(alpha = .08f)) {
                DeviceOutline(Modifier.padding(10.dp).size(24.dp), MaterialTheme.colorScheme.primary)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(computer.displayName, style = MaterialTheme.typography.titleMedium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (connecting) CircularProgressIndicator(Modifier.size(10.dp), strokeWidth = 1.5.dp)
                    else Box(Modifier.size(6.dp).clip(CircleShape).background(stateColor))
                    Text(when {
                        connecting -> "正在连接…"
                        online -> "在线"
                        offline -> "离线"
                        else -> "检测中…"
                    }, color = stateColor, style = MaterialTheme.typography.bodySmall)
                }
            }
            TextButton(onClick = { when {
                connecting -> onCancel()
                offline -> onRescan()
                else -> onConnect()
            } }, enabled = connecting || (!connectionBusy && (online || offline)),
                modifier = Modifier.testTag("connect-${computer.uuid}"),
                contentPadding = PaddingValues(horizontal = 8.dp)) {
                Text(if (connecting) "取消" else if (offline) "重试" else "远程控制")
            }
            IconButton(onClick = onActions, enabled = !connectionBusy,
                modifier = Modifier.semantics { contentDescription = "${computer.displayName}的更多操作" }) {
                val tint = MaterialTheme.colorScheme.onSurfaceVariant
                Canvas(Modifier.size(18.dp)) {
                    for (x in listOf(.15f, .5f, .85f)) drawCircle(tint, 1.6.dp.toPx(), Offset(size.width * x, size.height / 2))
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AddComputerSheet(
    nearby: List<HomeComputer>,
    onDismiss: () -> Unit,
    onAdd: (String) -> Unit,
    onRescan: () -> Unit,
    onAddress: () -> Unit,
    onPairingCode: () -> Unit,
) {
    var scanning by remember { mutableStateOf(true) }
    var scanAttempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(scanAttempt) {
        scanning = true
        onRescan()
        delay(8000)
        scanning = false
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface) {
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp).testTag("add-computer-sheet"),
            contentPadding = PaddingValues(start = 24.dp, end = 24.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text("添加设备", style = MaterialTheme.typography.headlineSmall)
                Spacer(Modifier.height(8.dp))
                Text("发现附近的新电脑，添加后可从首页连接。", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("附近的电脑", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    TextButton(onClick = { scanAttempt++ }, enabled = !scanning) {
                        Text(if (scanning) "正在搜索…" else "重新扫描")
                    }
                }
            }
            if (nearby.isEmpty()) item {
                Column(Modifier.fillMaxWidth().padding(vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(if (scanning) "正在寻找新电脑…" else "暂无新设备", style = MaterialTheme.typography.titleSmall)
                    Text("已添加的电脑会显示在首页。请确认新电脑与手机在同一网络，并开启“允许被发现”。",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            items(nearby, key = { it.uuid }) { computer ->
                Row(Modifier.fillMaxWidth().testTag("nearby-${computer.uuid}"), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    DeviceOutline(Modifier.size(28.dp), MaterialTheme.colorScheme.primary)
                    Text(computer.displayName, modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleMedium,
                        maxLines = 2, overflow = TextOverflow.Ellipsis)
                    TextButton(onClick = { onAdd(computer.uuid); onDismiss() }) { Text("添加") }
                }
            }
            item { HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = .4f)) }
            item {
                TextButton(onClick = { onDismiss(); onAddress() }, modifier = Modifier.fillMaxWidth()) { Text("输入电脑地址") }
                TextButton(onClick = { onDismiss(); onPairingCode() }, modifier = Modifier.fillMaxWidth()) { Text("使用配对码") }
            }
        }
    }
}
