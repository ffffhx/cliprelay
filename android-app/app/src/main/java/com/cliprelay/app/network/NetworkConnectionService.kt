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
import com.cliprelay.app.ClipRelayApplication
import com.cliprelay.app.data.AppPreferences
import com.cliprelay.network.mobile.Mobile
import com.cliprelay.network.mobile.Node
import go.Seq
import java.io.File
import java.net.NetworkInterface
import java.security.MessageDigest
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.channels.Channel
import org.json.JSONArray
import org.json.JSONObject

data class ExternalConnectionState(
    val phase: String = "idle",
    val message: String = "输入电脑上显示的配对码，授权后将自动选择连接路径。",
    val verification: String = "",
    val computer: String = "",
    val id: String = "",
    val address: String = "",
    val enabled: Boolean = true,
) { val ready: Boolean get() = enabled && phase == "ready" }

class NetworkConnectionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val publicationLock = Any()
    private val sessions = mutableMapOf<String, Connection>()
    private val statuses = mutableMapOf<String, ExternalConnectionState>()
    private var pairingJob: Job? = null
    private var pairingToken: Any? = null
    private var stopping = false
    private var lastNotificationText: String? = null
    private lateinit var identity: NetworkIdentity
    private lateinit var connectivity: ConnectivityManager
    private class Connection(val record: SavedNetworkPairing) {
        lateinit var job: Job
        @Volatile var node: Node? = null
        val pollSignal = Channel<Unit>(Channel.CONFLATED)
    }
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = networkChanged()
        override fun onLost(network: Network) = networkChanged()
        override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) = networkChanged()
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
        synchronized(publicationLock) { refresh() }
        updateInterfaces()
        scope.launch {
            ClipRelayApplication.foreground.collect { visible -> if (visible) wakePolls() }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        synchronized(publicationLock) {
            val id = intent?.getStringExtra("id")
            when (intent?.action) {
                STOP -> {
                    if (id == null) {
                        identity.setAllEnabled(false)
                        cancelPairing()
                        sessions.keys.toList().forEach(::stopConnection)
                        identity.list().forEach { statuses[it.id] = paused(it) }
                    } else {
                        identity.setEnabled(id, false)
                        stopConnection(id)
                        identity.list().find { it.id == id }?.let { statuses[id] = paused(it) }
                    }
                }
                REMOVE -> {
                    if (id != null) { identity.forget(id); stopConnection(id); statuses.remove(id) }
                }
                CANCEL_PAIRING -> cancelPairing()
                START -> {
                    val code = intent.getStringExtra("code")
                    if (code != null) startPairing(code)
                    else if (id != null) identity.setEnabled(id, true)
                    else identity.setAllEnabled(true)
                }
            }
            identity.list().filter { it.enabled }.forEach { startConnection(it) }
            refresh()
            stopIfIdle()
        }
        return START_STICKY
    }

    private fun paused(record: SavedNetworkPairing) = ExternalConnectionState("stopped",
        "安全通道已暂停，配对信息已保留；仍可局域网直连。", computer = record.computer, enabled = false)

    /** Failed/cancelled claims must never write over a saved computer. */
    private fun startPairing(code: String) {
        if (pairingJob?.isActive == true) return
        val token = Any()
        pairingToken = token
        pairing.value = ExternalConnectionState("connecting", "正在发送配对请求…")
        pairingJob = scope.launch(start = CoroutineStart.LAZY) {
            try {
                require(code.matches(Regex("[0-9]{8}")))
                val credential = Mobile.newCredential()
                val client = Mobile.newPairingClient(ENDPOINT, credential)
                val request = JSONObject().put("name", AppPreferences.load(this@NetworkConnectionService).deviceName).put("code", code)
                val claim = JSONObject(client.request("claim", request.toString()))
                coroutineContext.ensureActive()
                publishPairing(token, ExternalConnectionState("pending", "请在电脑允许这台手机，并核对两边显示的标识。",
                    claim.getString("id").take(6).uppercase(), claim.optString("computer")))
                val approved = withTimeout(5 * 60_000L) {
                    var result: JSONObject
                    while (true) {
                        result = JSONObject(client.request("status", "{}"))
                        coroutineContext.ensureActive()
                        if (result.getString("state") == "approved") break
                        delay(2500)
                    }
                    result
                }
                val host = approved.getJSONArray("peers").getJSONObject(0)
                synchronized(publicationLock) {
                    if (pairingToken !== token || !isActive || stopping) return@launch
                    val saved = identity.save(credential, host.optString("name"), host.getString("id"))
                    startConnection(saved, replace = true)
                    pairing.value = ExternalConnectionState("saved", "已添加电脑，正在建立安全通道。", computer = saved.computer)
                }
            } catch (_: TimeoutCancellationException) {
                publishPairing(token, ExternalConnectionState("error", "等待确认已超时，请生成新配对码后重试。"))
            } catch (_: CancellationException) {
            } catch (e: Exception) {
                publishPairing(token, ExternalConnectionState("error", friendly(e)))
            } finally {
                synchronized(publicationLock) {
                    if (pairingToken === token) pairingJob = null
                    refresh()
                    stopIfIdle()
                }
            }
        }.also { it.start() }
    }

    private fun cancelPairing() {
        pairingToken = null
        pairingJob?.cancel()
        pairingJob = null
        pairing.value = null
    }
    private fun publishPairing(token: Any, value: ExternalConnectionState) = synchronized(publicationLock) {
        if (pairingToken === token && !stopping) { pairing.value = value; refresh() }
    }

    private fun startConnection(record: SavedNetworkPairing, replace: Boolean = false) {
        val previous = sessions[record.id]
        if (previous?.job?.isActive == true && !replace) {
            previous.pollSignal.trySend(Unit)
            return
        }
        previous?.job?.cancel()
        previous?.node?.let(::closeNode)
        val session = Connection(record)
        statuses[record.id] = ExternalConnectionState("connecting", "正在连接电脑…", computer = record.computer)
        session.job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                // A quick resume waits for the old local listeners to close.
                previous?.job?.join()
                connect(session)
            } catch (_: CancellationException) {
            } catch (e: Exception) {
                synchronized(publicationLock) {
                    if (sessions[record.id] === session && !stopping) {
                        identity.setEnabled(record.id, false)
                        statuses[record.id] = ExternalConnectionState("error", friendly(e), computer = record.computer, enabled = false)
                    }
                }
            } finally {
                synchronized(publicationLock) {
                    if (sessions[record.id] === session) sessions.remove(record.id)
                    refresh()
                    stopIfIdle()
                }
            }
        }
        sessions[record.id] = session
        session.job.start()
    }

    private suspend fun connect(session: Connection) {
        val record = session.record
        val credential = checkNotNull(identity.read(record.id)) { "配对信息不可用，请重新配对。" }
        val client = Mobile.newPairingClient(ENDPOINT, credential)
        val stateName = MessageDigest.getInstance("SHA-256").digest(credential.toByteArray()).joinToString("") { "%02x".format(it) }.take(24)
        val directory = File(filesDir, "embedded-network/$stateName").apply { mkdirs() }
        val reconnectSchedule = ConnectionPollSchedule()
        while (coroutineContext.isActive) {
            var current: Node? = null
            try {
                publish(session, ExternalConnectionState("connecting", "正在建立与电脑的连接…"))
                val enrollment = JSONObject(client.request("enroll", "{}"))
                coroutineContext.ensureActive()
                updateInterfaces()
                current = Mobile.newWithPort(directory.absolutePath, enrollment.getString("hostname"),
                    enrollment.getString("controlUrl"), enrollment.optString("authKey"), record.preferredPort.toLong())
                session.node = current
                coroutineContext.ensureActive()
                current.start()
                reconnectSchedule.reset()
                coroutineContext.ensureActive()
                var forwarded = false
                var selectedIP = ""
                var lastBridgeDiagnostic = ""
                var lastDescription: Pair<String, String>? = null
                val pollSchedule = ConnectionPollSchedule()
                while (coroutineContext.isActive) {
                    val status = try { JSONObject(client.request("status", "{}")) }
                    catch (e: Exception) {
                        if (expired(e)) throw e
                        // Coordinator outages must not interrupt a working direct stream.
                        waitForPoll(session, pollSchedule, "status-unavailable")
                        continue
                    }
                    coroutineContext.ensureActive()
                    if (status.optBoolean("reauthorize")) throw IllegalStateException("正在续期设备连接")
                    val peers = status.getJSONArray("peers")
                    val peer = if (peers.length() > 0) peers.getJSONObject(0) else null
                    val addresses = peer?.optJSONArray("addresses") ?: JSONArray()
                    val ip = (0 until addresses.length()).map { addresses.getString(it) }.firstOrNull { !it.contains(':') }
                    if (peer != null) synchronized(publicationLock) {
                        val description = peer.optString("name") to peer.optString("id")
                        if (sessions[record.id] === session && !stopping && description != lastDescription) {
                            identity.describe(record.id, description.first, description.second)
                            lastDescription = description
                            refresh()
                        }
                    }
                    if (ip != null && !forwarded) {
                        current.setPeers(JSONArray().put(ip).toString())
                        current.forward(ip, record.address)
                        selectedIP = ip
                        forwarded = true
                    }
                    if (forwarded && ip != selectedIP) throw IllegalStateException("电脑连接信息已更新")
                    val online = peer?.optBoolean("online") == true
                    val diagnostic = current.bridgeDiagnostic()
                    if (diagnostic.isNotEmpty() && diagnostic != lastBridgeDiagnostic) {
                        android.util.Log.w("ClipRelayNetwork", diagnostic)
                        lastBridgeDiagnostic = diagnostic
                    }
                    val connectionState = when {
                        forwarded && online && current.bridgesReady() -> ExternalConnectionState("ready", "已连接，返回电脑列表即可远控。")
                        forwarded && online -> ExternalConnectionState("connecting", "正在恢复串流通道…")
                        else -> ExternalConnectionState("connecting", "等待电脑上线，将自动恢复连接。")
                    }
                    publish(session, connectionState)
                    waitForPoll(session, pollSchedule, "${connectionState.phase}:$ip")
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                coroutineContext.ensureActive()
                if (expired(e)) throw e
                publish(session, ExternalConnectionState("connecting", "网络暂时不可用，正在重连；其他电脑不受影响。"))
            } finally {
                session.node = null
                runCatching { current?.close() }
            }
            waitForPoll(session, reconnectSchedule, "reconnect")
        }
    }

    private fun stopConnection(id: String) {
        sessions[id]?.let { session -> session.job.cancel(); session.node?.let(::closeNode) }
        // Keep the cancelled job registered until cleanup, so resume can join it.
    }
    private suspend fun waitForPoll(session: Connection, schedule: ConnectionPollSchedule, state: String) {
        val delayMs = schedule.next(state, ClipRelayApplication.foreground.value)
        if (withTimeoutOrNull(delayMs) { session.pollSignal.receive(); true } == true) schedule.reset()
    }
    private fun wakePolls() = synchronized(publicationLock) {
        if (!stopping) sessions.values.forEach { it.pollSignal.trySend(Unit) }
    }
    private fun networkChanged() { updateInterfaces(); wakePolls() }
    private fun closeNode(node: Node) {
        Thread({ runCatching { node.close() } }, "ClipRelay channel cleanup").start()
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

    private fun publish(session: Connection, value: ExternalConnectionState) = synchronized(publicationLock) {
        if (stopping || sessions[session.record.id] !== session || !session.job.isActive) return@synchronized
        if (statuses[session.record.id] == value) return@synchronized
        statuses[session.record.id] = value
        refresh()
    }
    /** publicationLock also prevents a cancelled worker overwriting a replacement. */
    private fun refresh() {
        if (stopping) return
        val current = identity.list().map { record ->
            (statuses[record.id] ?: if (record.enabled) ExternalConnectionState("connecting", "正在恢复连接…") else paused(record))
                .copy(id = record.id, address = record.address, computer = record.computer, enabled = record.enabled)
        }
        connections.value = current
        state.value = current.firstOrNull { it.ready } ?: pairing.value ?: current.firstOrNull { it.enabled }
            ?: current.firstOrNull() ?: ExternalConnectionState()
        val readyCount = current.count { it.ready }
        val text = if (readyCount > 0) "已连接 $readyCount 台电脑" else state.value.message
        if (text != lastNotificationText) {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification(text))
            lastNotificationText = text
        }
    }
    private fun stopIfIdle() {
        if (!stopping && sessions.isEmpty() && pairingJob == null && identity.list().none { it.enabled }) stopSelf()
    }
    private fun notification(text: String) = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_notification).setContentTitle("ClipRelay 电脑连接").setContentText(text)
        .setOngoing(true).setSilent(true)
        .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, NetworkPairActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        .addAction(0, "全部暂停", PendingIntent.getService(this, 1, Intent(this, NetworkConnectionService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        .build()

    override fun onDestroy() {
        synchronized(publicationLock) {
            stopping = true
            sessions.values.forEach { it.node?.let(::closeNode) }
            connections.value = connections.value.map { if (it.ready) it.copy(phase = "connecting", message = "连接已停止，打开电脑列表后恢复。") else it }
            state.value = connections.value.firstOrNull() ?: pairing.value ?: ExternalConnectionState()
        }
        scope.cancel()
        runCatching { connectivity.unregisterNetworkCallback(callback) }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
    private fun expired(e: Exception) = e.message?.contains("401:") == true || e.message?.contains("410:") == true
    private fun friendly(e: Exception): String = when {
        e.message?.contains("401:") == true -> "电脑已撤销这台手机的授权，请重新配对。其他电脑不受影响。"
        e.message?.contains("404:") == true -> "配对码不正确或已过期，请在电脑上重新生成。"
        e.message?.contains("410:") == true -> "配对请求已过期，请重新输入配对码。"
        e.message?.contains("429:") == true -> "尝试次数较多，请稍后再试。"
        else -> "连接未完成，请检查网络后重试；已有配对已保留。"
    }
    companion object {
        const val LOCAL_ADDRESS = "127.120.0.1" // The migrated original pairing keeps this address.
        private const val ENDPOINT = "https://124-221-36-36.anyip.dev:8443/cliprelay-network"
        private const val CHANNEL = "cliprelay_external_connection"
        private const val NOTIFICATION = 47732
        private const val STOP = "com.cliprelay.app.network.STOP"
        private const val START = "com.cliprelay.app.network.START"
        private const val RESTORE = "com.cliprelay.app.network.RESTORE"
        private const val REMOVE = "com.cliprelay.app.network.REMOVE"
        private const val CANCEL_PAIRING = "com.cliprelay.app.network.CANCEL_PAIRING"
        val state = MutableStateFlow(ExternalConnectionState())
        val connections = MutableStateFlow<List<ExternalConnectionState>>(emptyList())
        val pairing = MutableStateFlow<ExternalConnectionState?>(null)
        private fun command(context: Context, action: String, id: String? = null, code: String? = null) {
            ContextCompat.startForegroundService(context, Intent(context, NetworkConnectionService::class.java)
                .setAction(action).apply { id?.let { putExtra("id", it) }; code?.let { putExtra("code", it) } })
        }
        fun start(context: Context, code: String? = null) = command(context, START, code = code)
        fun restore(context: Context) {
            val saved = NetworkIdentity(context).list()
            if (saved.any { it.enabled }) command(context, RESTORE)
            else {
                connections.value = saved.map { ExternalConnectionState("stopped", "安全通道已暂停，配对信息已保留。",
                    computer = it.computer, id = it.id, address = it.address, enabled = false) }
                state.value = connections.value.firstOrNull() ?: ExternalConnectionState()
            }
        }
        fun resume(context: Context, id: String) = command(context, START, id)
        fun stop(context: Context, id: String? = null) = command(context, STOP, id)
        fun forget(context: Context, id: String) = command(context, REMOVE, id)
        fun cancelPairing(context: Context) = command(context, CANCEL_PAIRING)
    }
}
