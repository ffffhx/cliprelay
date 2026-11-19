package com.cliprelay.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.limelight.PcView.ComputerAction
import com.limelight.nvstream.http.ComputerDetails.State

private enum class ActionPage { MENU, DETAILS, REMOVE }

/** The selected device stays live while discovery updates its availability. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ComputerActionsSheet(
    computer: HomeComputer,
    onDismiss: () -> Unit,
    onAction: (ComputerAction) -> Unit,
) {
    var page by rememberSaveable(computer.uuid) { mutableStateOf(ActionPage.MENU) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        containerColor = MaterialTheme.colorScheme.surface,
        tonalElevation = 0.dp,
        dragHandle = {
            Box(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 20.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.size(32.dp, 4.dp).clip(CircleShape)
                    .background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = .28f)))
            }
        },
    ) {
        BackHandler(page != ActionPage.MENU) { page = ActionPage.MENU }
        key(page) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(start = 22.dp, end = 22.dp, bottom = 24.dp)
                .testTag("computer-actions-sheet")) {
                when (page) {
                    ActionPage.MENU -> {
                        DeviceActionHeader(computer, onDismiss)
                        Spacer(Modifier.height(24.dp))
                        ActionSectionLabel("快捷操作")
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            QuickDeviceAction("文件传输", DeviceActionIcons.Folder, computer.canOpenTools,
                                Modifier.weight(1f).testTag("device-action-files")) { onAction(ComputerAction.FILES) }
                            QuickDeviceAction("终端", DeviceActionIcons.Terminal, computer.canOpenTools,
                                Modifier.weight(1f).testTag("device-action-terminal")) { onAction(ComputerAction.TERMINAL) }
                            QuickDeviceAction("Herdr 会话", DeviceActionIcons.Sessions, computer.canOpenTools,
                                Modifier.weight(1f).testTag("device-action-herdr")) { onAction(ComputerAction.HERDR) }
                        }
                        if (!computer.canOpenTools) {
                            Spacer(Modifier.height(10.dp))
                            Text(if (computer.state == State.UNKNOWN) "正在检测设备状态…"
                                else "连接电脑后，即可使用以上功能",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodySmall)
                        }
                        Spacer(Modifier.height(24.dp))
                        ActionSectionLabel("连接与设备")
                        Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(16.dp)) {
                            Column {
                                DeviceActionRow("连接详情", DeviceActionIcons.Link, value = computer.connectionLabel,
                                    modifier = Modifier.testTag("device-action-details")) { page = ActionPage.DETAILS }
                                ActionDivider()
                                DeviceActionRow("唤醒电脑", DeviceActionIcons.Power,
                                    enabled = computer.state == State.OFFLINE,
                                    value = if (computer.online) "已在线" else if (computer.state == State.UNKNOWN) "检测中" else null,
                                    accent = computer.state == State.OFFLINE,
                                    modifier = Modifier.testTag("device-action-wake")) { onAction(ComputerAction.WAKE) }
                                ActionDivider()
                                DeviceActionRow("唤醒设置", DeviceActionIcons.Sliders,
                                    enabled = computer.canConfigureWake,
                                    value = if (computer.canConfigureWake) null else if (computer.online) "需连接" else "需在线",
                                    modifier = Modifier.testTag("device-action-wake-settings")) { onAction(ComputerAction.WAKE_SETTINGS) }
                            }
                        }
                        Spacer(Modifier.height(19.dp))
                        Surface(onClick = { page = ActionPage.REMOVE }, shape = RoundedCornerShape(14.dp),
                            color = MaterialTheme.colorScheme.error.copy(alpha = .07f),
                            contentColor = MaterialTheme.colorScheme.error,
                            modifier = Modifier.fillMaxWidth().testTag("device-action-remove")) {
                            Row(Modifier.heightIn(min = 52.dp).padding(horizontal = 15.dp, vertical = 12.dp),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Icon(DeviceActionIcons.Trash, null, Modifier.size(20.dp))
                                Text("移除设备", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                                Icon(DeviceActionIcons.Chevron, null, Modifier.size(14.dp).alpha(.65f))
                            }
                        }
                    }
                    ActionPage.DETAILS -> {
                        ActionSubheader("连接详情", { page = ActionPage.MENU }, onDismiss)
                        Spacer(Modifier.height(24.dp))
                        Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(16.dp)) {
                            Column(Modifier.padding(horizontal = 17.dp, vertical = 4.dp).testTag("device-connection-details")) {
                                DetailLine("设备名称", computer.displayName)
                                HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = .35f))
                                DetailLine("状态", computer.statusLabel)
                                HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = .35f))
                                DetailLine("连接方式", computer.connectionLabel)
                                HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = .35f))
                                DetailLine("当前地址", computer.address?.takeIf { computer.online } ?: "暂不可用", selectable = true)
                            }
                        }
                        Spacer(Modifier.height(12.dp))
                    }
                    ActionPage.REMOVE -> {
                        ActionSubheader("移除设备", { page = ActionPage.MENU }, onDismiss)
                        Spacer(Modifier.height(24.dp))
                        Surface(color = MaterialTheme.colorScheme.error.copy(alpha = .07f), shape = RoundedCornerShape(16.dp)) {
                            Icon(DeviceActionIcons.Trash, null, Modifier.padding(14.dp).size(24.dp),
                                tint = MaterialTheme.colorScheme.error)
                        }
                        Spacer(Modifier.height(20.dp))
                        Text("移除「${computer.displayName}」？", style = MaterialTheme.typography.titleLarge,
                            modifier = Modifier.testTag("device-remove-confirmation"))
                        Spacer(Modifier.height(12.dp))
                        Text("移除后，这台电脑将不再显示在「我的设备」中。需要时可以重新添加。",
                            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.height(24.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(11.dp)) {
                            FilledTonalButton(onClick = { page = ActionPage.MENU },
                                modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("device-keep"),
                                shape = RoundedCornerShape(13.dp),
                                colors = ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.surfaceVariant,
                                    contentColor = MaterialTheme.colorScheme.onSurface)) { Text("保留设备") }
                            Button(onClick = { onAction(ComputerAction.REMOVE) },
                                modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("device-remove-confirm"),
                                shape = RoundedCornerShape(13.dp),
                                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error,
                                    contentColor = MaterialTheme.colorScheme.onError)) { Text("移除设备") }
                        }
                    }
                }
            }
        }
    }
}

private val HomeComputer.statusLabel: String get() = when (state) {
    State.ONLINE -> "在线"
    State.OFFLINE -> "离线"
    else -> "检测中…"
}

@Composable
private fun DeviceActionHeader(computer: HomeComputer, onDismiss: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Surface(color = MaterialTheme.colorScheme.primary.copy(alpha = .09f), shape = RoundedCornerShape(14.dp)) {
            DeviceOutline(Modifier.padding(11.dp).size(26.dp), MaterialTheme.colorScheme.primary)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(computer.displayName, fontSize = 18.sp, fontWeight = FontWeight.SemiBold,
                maxLines = 2, overflow = TextOverflow.Ellipsis)
            val statusColor = if (computer.online) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(6.dp).clip(CircleShape).background(statusColor))
                Text(computer.statusLabel, fontSize = 12.sp, color = statusColor)
                Text("·", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(computer.connectionLabel, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        CloseActionsButton(onDismiss)
    }
}

@Composable
private fun CloseActionsButton(onDismiss: () -> Unit) {
    IconButton(onClick = onDismiss, modifier = Modifier.size(48.dp).testTag("device-actions-close")) {
        Icon(DeviceActionIcons.Close, "关闭设备操作", Modifier.size(20.dp), MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ActionSectionLabel(text: String) {
    Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelMedium)
    Spacer(Modifier.height(11.dp))
}

@Composable
private fun QuickDeviceAction(label: String, icon: ImageVector, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Surface(onClick = onClick, enabled = enabled, color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(15.dp), modifier = modifier) {
        Column(Modifier.heightIn(min = 91.dp).padding(horizontal = 5.dp, vertical = 17.dp).alpha(if (enabled) 1f else .42f),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(11.dp, Alignment.CenterVertically)) {
            Icon(icon, null, Modifier.size(25.dp), MaterialTheme.colorScheme.primary)
            Text(label, fontSize = 12.sp, lineHeight = 17.sp, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurface)
        }
    }
}

@Composable
private fun DeviceActionRow(label: String, icon: ImageVector, modifier: Modifier = Modifier,
    enabled: Boolean = true, value: String? = null, accent: Boolean = false, onClick: () -> Unit) {
    Surface(onClick = onClick, enabled = enabled, color = Color.Transparent, modifier = modifier.fillMaxWidth()) {
        Row(Modifier.heightIn(min = 57.dp).padding(horizontal = 15.dp, vertical = 12.dp).alpha(if (enabled) 1f else .55f),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(icon, null, Modifier.size(20.dp),
                if (accent) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
            Text(label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium,
                color = if (accent) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            if (value != null) Text(value, fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (enabled) Icon(DeviceActionIcons.Chevron, null, Modifier.size(14.dp), MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ActionDivider() {
    HorizontalDivider(Modifier.padding(start = 48.dp, end = 14.dp), color = MaterialTheme.colorScheme.outline.copy(alpha = .3f))
}

@Composable
private fun ActionSubheader(title: String, onBack: () -> Unit, onDismiss: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        FilledIconButton(onClick = onBack, modifier = Modifier.size(48.dp).testTag("device-actions-back"),
            shape = RoundedCornerShape(13.dp), colors = IconButtonDefaults.filledIconButtonColors(
                containerColor = MaterialTheme.colorScheme.surfaceVariant, contentColor = MaterialTheme.colorScheme.onSurface)) {
            Icon(DeviceActionIcons.Back, "返回设备操作", Modifier.size(20.dp))
        }
        Text(title, modifier = Modifier.weight(1f), fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
        CloseActionsButton(onDismiss)
    }
}

@Composable
private fun DetailLine(label: String, value: String, selectable: Boolean = false) {
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(15.dp)) {
        Text(label, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
            if (selectable) SelectionContainer { Text(value, fontSize = 13.sp, textAlign = TextAlign.End) }
            else Text(value, fontSize = 13.sp, textAlign = TextAlign.End)
        }
    }
}
