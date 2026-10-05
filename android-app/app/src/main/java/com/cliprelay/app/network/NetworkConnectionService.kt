package com.cliprelay.app.network

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.cliprelay.app.R
import com.cliprelay.app.data.AppPreferences
import com.cliprelay.network.mobile.Mobile
import com.cliprelay.network.mobile.Node
import go.Seq
import java.io.File
import java.net.NetworkInterface
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

data class ExternalConnectionState(
    val phase: String = "idle",
    val message: String = "输入电脑上显示的配对码，授权后将自动选择连接路径。",
    val verification: String = "",
    val computer: String = "",
) { val ready: Boolean get() = phase == "ready" }

class NetworkConnectionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var worker: Job? = null
    @Volatile private var node: Node? = null
    private val publicationLock = Any()
    private var stopping = false
    private lateinit var identity: NetworkIdentity
    private lateinit var connectivity: ConnectivityManager
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = updateInterfaces()
        override fun onLost(network: Network) = updateInterfaces()
        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) = updateInterfaces()
    }

    override fun onCreate() {
        super.onCreate()
        Seq.setContext(applicationContext)
        identity = NetworkIdentity(this)
        connectivity = getSystemService(ConnectivityManager::class.java)
        connectivity.registerDefaultNetworkCallback(callback)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "电脑连接", NotificationManager.IMPORTANCE_LOW))
        ServiceCompat.startForeground(this, NOTIFICATION, notification("正在连接电脑"), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        updateInterfaces()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            synchronized(publicationLock) {
                stopping = true
                identity.enabled = false
                state.value = ExternalConnectionState(phase = "stopped", message = "安全通道已暂停，配对信息已保留；仍可尝试局域网直连。")
            }
            stopSelf()
            return START_NOT_STICKY
        }
        if (worker?.isActive == true) return START_STICKY
        val code = intent?.getStringExtra("code")
        if (intent?.action == START) identity.enabled = true
        if (code == null && (!identity.exists || !identity.enabled)) { stopSelf(); return START_NOT_STICKY }
        identity.enabled = true
        worker = scope.launch {
            while (isActive) {
                try { connect(code); break }
                catch (_: CancellationException) { break }
                catch (e: Exception) {
                    val expired = e.message?.contains("401:") == true || e.message?.contains("410:") == true ||
                        e.message?.contains("配对已失效") == true
                    if (expired) identity.forget()
                    if (code != null || expired) {
                        publish(ExternalConnectionState("error", friendly(e)))
                        identity.enabled = false
                        stopSelf()
                        break
                    }
                    // Opening ClipRelay while offline must not permanently disable
                    // an already paired channel. LAN remains independently usable.
                    publish(ExternalConnectionState("connecting", "网络暂时不可用，正在自动重连；局域网连接仍可使用。"))
                    delay(5000)
                }
            }
        }
        return START_STICKY
    }

    private suspend fun connect(pairCode: String?) {
        var credential = identity.read()
        if (pairCode != null) {
            require(pairCode.matches(Regex("[0-9]{8}"))) { "请输入八位配对码" }
            // Each new pairing has its own local node state. A previous host's
            // WireGuard identity must never accidentally join a different group.
            credential = Mobile.newCredential()
            identity.save(credential)
        }
        checkNotNull(credential) { "请先输入电脑上的配对码" }
        val client = Mobile.newPairingClient(ENDPOINT, credential)
        if (pairCode != null) {
            publish(ExternalConnectionState("connecting", "正在发送配对请求…"))
            val request = JSONObject().put("name", AppPreferences.load(this).deviceName).put("code", pairCode)
            val claim = JSONObject(client.request("claim", request.toString()))
            publish(ExternalConnectionState("pending", "请在电脑 ClipRelay 中允许这台手机，并核对下方标识。",
                claim.getString("id").take(6).uppercase(), claim.optString("computer")))
        }
        var status: JSONObject
        while (true) {
            status = JSONObject(client.request("status", "{}"))
            if (status.getString("state") == "approved") break
            publish(ExternalConnectionState("pending", "等待电脑确认，请核对两边显示的标识。", status.getString("id").take(6).uppercase()))
            delay(2500)
        }
        val stateName = MessageDigest.getInstance("SHA-256").digest(credential.toByteArray()).joinToString("") { "%02x".format(it) }.take(24)
        val directory = File(filesDir, "embedded-network/$stateName").apply { mkdirs() }
        while (scope.isActive) {
            var current: Node? = null
            try {
                publish(ExternalConnectionState("connecting", "正在建立与电脑的连接…"))
                val enrollment = JSONObject(client.request("enroll", "{}"))
                updateInterfaces()
                current = Mobile.new_(directory.absolutePath, enrollment.getString("hostname"),
                    enrollment.getString("controlUrl"), enrollment.optString("authKey"))
                node = current
                current.start()
                coroutineContext.ensureActive()
                var forwarded = false
                var selectedIP = ""
                var lastBridgeDiagnostic = ""
                while (scope.isActive) {
                    try {
                        status = JSONObject(client.request("status", "{}"))
                    } catch (e: Exception) {
                        if (e.message?.contains("401:") == true || e.message?.contains("410:") == true) throw e
                        // A transient coordinator outage must not interrupt a
                        // working direct stream. Revocation is also enforced by
                        // Headscale's node/ACL updates, independently of polling.
                        delay(3000)
                        continue
                    }
                    if (status.optBoolean("reauthorize")) throw IllegalStateException("正在续期设备连接")
                    val peers = status.getJSONArray("peers")
                    val peer = if (peers.length() > 0) peers.getJSONObject(0) else null
                    val addresses = peer?.optJSONArray("addresses") ?: JSONArray()
                    val ip = (0 until addresses.length()).map { addresses.getString(it) }.firstOrNull { !it.contains(':') }
                    if (ip != null && !forwarded) {
                        current.setPeers(JSONArray().put(ip).toString())
                        current.forward(ip, LOCAL_ADDRESS)
                        selectedIP = ip
                        forwarded = true
                    }
                    if (forwarded && ip != selectedIP) throw IllegalStateException("电脑连接信息已更新，正在重新连接")
                    val online = peer?.optBoolean("online") == true
                    val bridgeDiagnostic = current.bridgeDiagnostic()
                    if (bridgeDiagnostic.isNotEmpty() && bridgeDiagnostic != lastBridgeDiagnostic) {
                        android.util.Log.w("ClipRelayNetwork", bridgeDiagnostic)
                        lastBridgeDiagnostic = bridgeDiagnostic
                    }
                    publish(if (forwarded && online && current.bridgesReady()) ExternalConnectionState("ready", "已配对，将自动选择可用路径。返回电脑列表即可连接。", computer = peer?.optString("name").orEmpty())
                        else if (forwarded && online) ExternalConnectionState("connecting", "正在恢复串流通道，请稍候…")
                        else ExternalConnectionState("connecting", "等待电脑上线，连接将自动恢复。请保持电脑 ClipRelay 运行。"))
                    delay(3000)
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                coroutineContext.ensureActive()
                if (e.message?.contains("401:") == true || e.message?.contains("410:") == true) {
                    identity.forget()
                    throw IllegalStateException("配对已失效，请重新输入电脑上的配对码。")
                }
                publish(ExternalConnectionState("connecting", "网络暂时不可用，正在重连…"))
            } finally {
                node = null
                runCatching { current?.close() }
            }
            delay(5000)
        }
    }

    private fun updateInterfaces() {
        runCatching {
            val interfaces = JSONArray()
            val names = mutableSetOf<String>()
            for (network in connectivity.allNetworks) {
                val caps = connectivity.getNetworkCapabilities(network) ?: continue
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
                val properties = connectivity.getLinkProperties(network) ?: continue
                val name = properties.interfaceName ?: continue
                if (!names.add(name)) continue
                val iface = NetworkInterface.getByName(name) ?: continue
                val addresses = JSONArray()
                for (address in properties.linkAddresses) {
                    addresses.put(address.address.hostAddress!!.substringBefore('%') + "/" + address.prefixLength)
                }
                val mtu = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) properties.mtu
                    else runCatching { iface.mtu }.getOrDefault(1500)
                interfaces.put(JSONObject().put("index", iface.index).put("name", name).put("mtu", mtu.takeIf { it > 0 } ?: 1500)
                    .put("flags", 1 or 2 or 16).put("addresses", addresses))
            }
            Mobile.setInterfaces(interfaces.toString())
        }
    }

    private fun publish(value: ExternalConnectionState) {
        synchronized(publicationLock) {
            if (stopping || !scope.isActive) return
            state.value = value
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification(if (value.ready) "已连接 ${value.computer}" else value.message))
        }
    }
    private fun notification(text: String) = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_notification).setContentTitle("ClipRelay 电脑连接").setContentText(text)
        .setOngoing(true).setSilent(true)
        .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, NetworkPairActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        .addAction(0, "暂停", PendingIntent.getService(this, 1, Intent(this, NetworkConnectionService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        .build()

    override fun onDestroy() {
        synchronized(publicationLock) { stopping = true }
        scope.cancel()
        runCatching { connectivity.unregisterNetworkCallback(callback) }
        val closing = node; node = null
        Thread { runCatching { closing?.close() } }.start()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
    private fun friendly(e: Exception): String = when {
        e.message?.contains("401:") == true || e.message?.contains("配对已失效") == true -> "电脑已撤销这台手机的连接授权，请重新输入配对码。"
        e.message?.contains("404:") == true -> "配对码不正确或已过期，请在电脑上重新生成。"
        e.message?.contains("410:") == true -> "配对请求已过期，请重新输入配对码。"
        e.message?.contains("429:") == true -> "尝试次数较多，请稍后再试。"
        else -> "连接未完成，请检查网络后重试。"
    }

    companion object {
        const val LOCAL_ADDRESS = "127.120.0.1"
        private const val ENDPOINT = "https://124-221-36-36.anyip.dev:8443/cliprelay-network"
        private const val CHANNEL = "cliprelay_external_connection"
        private const val NOTIFICATION = 47732
        private const val STOP = "com.cliprelay.app.network.STOP"
        private const val START = "com.cliprelay.app.network.START"
        val state = MutableStateFlow(ExternalConnectionState())
        fun start(context: Context, code: String? = null) {
            ContextCompat.startForegroundService(context, Intent(context, NetworkConnectionService::class.java).setAction(START).apply { if (code != null) putExtra("code", code) })
        }
        fun restore(context: Context) { if (NetworkIdentity(context).enabled) start(context) }
        fun stop(context: Context) { context.startService(Intent(context, NetworkConnectionService::class.java).setAction(STOP)) }
    }
}
