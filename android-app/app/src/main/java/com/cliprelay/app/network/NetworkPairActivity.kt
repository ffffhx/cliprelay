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
                val status by NetworkConnectionService.state.collectAsStateWithLifecycle()
                var code by rememberSaveable { mutableStateOf("") }
                val busy = status.phase in setOf("pending", "connecting")
                Surface(modifier = Modifier.fillMaxSize()) {
                    Column(Modifier.safeDrawingPadding().imePadding().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                        TextButton(onClick = { finish() }) { Text("返回") }
                        Text("配对电脑", style = MaterialTheme.typography.headlineLarge)
                        Text("授权一次，以后直接点击电脑连接。ClipRelay 自动选择局域网或内置安全通道，无需选择网络模式。", style = MaterialTheme.typography.bodyLarge)
                        Card(Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(if (status.ready) status.computer else "连接状态", style = MaterialTheme.typography.titleMedium)
                                Text(status.message, modifier = Modifier.testTag("external-connection-status"))
                                if (status.verification.isNotEmpty()) {
                                    Text(status.verification, style = MaterialTheme.typography.headlineMedium)
                                    Text("请确认电脑显示的标识相同，再允许这台手机。", style = MaterialTheme.typography.bodySmall)
                                }
                                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                            }
                        }
                        if (status.ready) {
                            Button(onClick = {
                                startActivity(Intent(this@NetworkPairActivity, PcView::class.java)
                                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                                finish()
                            }, modifier = Modifier.fillMaxWidth().testTag("external-open-computer")) { Text("连接电脑") }
                            Text("首次连接时，仍需在电脑 ClipRelay 中确认手机显示的远控 PIN。")
                            Text("局域网不可达时会自动尝试安全通道；暂停后将只尝试已保存的直连地址。", style = MaterialTheme.typography.bodySmall)
                            TextButton(onClick = { NetworkConnectionService.stop(this@NetworkPairActivity) }, modifier = Modifier.fillMaxWidth()) { Text("暂停安全通道") }
                        } else {
                            if (!busy) {
                                Text("在电脑 ClipRelay 的“手机远控 → 外网配对”中生成配对码。这是首次授权，之后不需要手动选择内外网。")
                                OutlinedTextField(value = code, onValueChange = { code = it.filter(Char::isDigit).take(8) }, label = { Text("八位配对码") },
                                    modifier = Modifier.fillMaxWidth().testTag("external-pair-code"), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                                Button(onClick = { NetworkConnectionService.start(this@NetworkPairActivity, code) }, enabled = code.length == 8,
                                    modifier = Modifier.fillMaxWidth().testTag("external-submit-code")) { Text("提交配对") }
                                if (NetworkIdentity(this@NetworkPairActivity).exists) {
                                    OutlinedButton(onClick = { NetworkConnectionService.start(this@NetworkPairActivity) }, modifier = Modifier.fillMaxWidth()) { Text("恢复已有连接") }
                                }
                            } else {
                                TextButton(onClick = { NetworkConnectionService.stop(this@NetworkPairActivity) }) { Text("暂停连接") }
                            }
                        }
                    }
                }
            }
        }
    }
}
