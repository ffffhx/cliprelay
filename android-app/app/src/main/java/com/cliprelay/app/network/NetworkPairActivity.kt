package com.cliprelay.app.network

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cliprelay.app.ui.theme.ClipRelayTheme
import com.limelight.PcView

class NetworkPairActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        NetworkConnectionService.restore(this)
        setContent {
            ClipRelayTheme {
                val computers by NetworkConnectionService.connections.collectAsStateWithLifecycle()
                val pairing by NetworkConnectionService.pairing.collectAsStateWithLifecycle()
                NetworkPairScreen(computers, pairing,
                    onBack = { finish() },
                    onOpen = {
                        startActivity(Intent(this, PcView::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                        finish()
                    },
                    onPair = { NetworkConnectionService.start(this, it) },
                    onPause = { NetworkConnectionService.stop(this, it) },
                    onResume = { NetworkConnectionService.resume(this, it) },
                    onForget = { NetworkConnectionService.forget(this, it) },
                    onCancelPairing = { NetworkConnectionService.cancelPairing(this) })
            }
        }
    }
}

@Composable
internal fun NetworkPairScreen(
    computers: List<ExternalConnectionState>,
    pairing: ExternalConnectionState?,
    onBack: () -> Unit,
    onOpen: () -> Unit,
    onPair: (String) -> Unit,
    onPause: (String) -> Unit,
    onResume: (String) -> Unit,
    onForget: (String) -> Unit,
    onCancelPairing: () -> Unit,
) {
    var code by rememberSaveable { mutableStateOf("") }
    var removing by remember { mutableStateOf<ExternalConnectionState?>(null) }
    val busy = pairing?.phase in setOf("pending", "connecting")
    LaunchedEffect(pairing?.phase) { if (pairing?.phase == "saved") code = "" }
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(Modifier.safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp)) {
            TextButton(onClick = onBack) { Text("返回") }
            Text("外网电脑", style = MaterialTheme.typography.headlineLarge)
            Text("每台电脑只需授权一次。以后在电脑列表中直接选择，自动连接可用网络。")
            if (computers.isNotEmpty()) {
                Button(onClick = onOpen, modifier = Modifier.fillMaxWidth().testTag("external-open-computer")) {
                    Text("查看电脑列表")
                }
                computers.forEach { computer ->
                    key(computer.id) {
                        Card(Modifier.fillMaxWidth().testTag("external-computer-${computer.id}")) {
                            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text(computer.computer, style = MaterialTheme.typography.titleMedium)
                                Text(computer.message, modifier = Modifier.testTag("external-connection-status-${computer.id}"))
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                    TextButton(onClick = { if (computer.enabled) onPause(computer.id) else onResume(computer.id) },
                                        modifier = Modifier.testTag("external-toggle-${computer.id}")) {
                                        Text(if (computer.enabled) "暂停" else "恢复连接")
                                    }
                                    TextButton(onClick = { removing = computer }, modifier = Modifier.testTag("external-remove-${computer.id}")) {
                                        Text("移除")
                                    }
                                }
                            }
                        }
                    }
                }
            }
            HorizontalDivider()
            Text(if (computers.isEmpty()) "配对电脑" else "添加另一台电脑", style = MaterialTheme.typography.titleLarge)
            Text("在电脑 ClipRelay 的“手机远控 → 外网配对”中生成配对码。添加新电脑不影响已有连接。")
            // Saved computers have their own live status above; the pairing
            // completion message would become stale after pause or removal.
            pairing?.takeUnless { it.phase == "saved" }?.let { status ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        if (status.computer.isNotEmpty()) Text(status.computer, style = MaterialTheme.typography.titleMedium)
                        Text(status.message, modifier = Modifier.testTag("external-connection-status"))
                        if (status.verification.isNotEmpty()) {
                            Text(status.verification, style = MaterialTheme.typography.headlineMedium)
                            Text("请确认电脑显示的标识相同，再允许这台手机。")
                        }
                        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                    }
                }
            }
            if (busy) {
                TextButton(onClick = onCancelPairing, modifier = Modifier.testTag("external-cancel-pairing")) { Text("取消本次配对") }
            } else {
                OutlinedTextField(value = code, onValueChange = { code = it.filter { digit -> digit in '0'..'9' }.take(8) },
                    label = { Text("八位配对码") }, modifier = Modifier.fillMaxWidth().testTag("external-pair-code"),
                    singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                Button(onClick = { onPair(code) }, enabled = code.length == 8,
                    modifier = Modifier.fillMaxWidth().testTag("external-submit-code")) { Text("提交配对") }
            }
            Text("首次仅通过外网添加时，还需在电脑上确认手机显示的远控 PIN。暂停安全通道会保留授权，局域网连接仍可使用。",
                style = MaterialTheme.typography.bodySmall)
        }
    }
    removing?.let { computer ->
        AlertDialog(onDismissRequest = { removing = null }, title = { Text("移除 ${computer.computer}？") },
            text = { Text("删除这台电脑在本机保存的外网配对，其他电脑不受影响。再次从外网连接需要重新配对；电脑端可单独撤销远控授权。") },
            confirmButton = { TextButton(onClick = { onForget(computer.id); removing = null }, modifier = Modifier.testTag("external-confirm-remove")) { Text("移除") } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("取消") } })
    }
}
