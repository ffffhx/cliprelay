package com.cliprelay.app.service

import android.content.Context
import android.graphics.BitmapFactory
import com.limelight.binding.PlatformBinding
import com.limelight.computers.ComputerDatabaseManager
import com.limelight.computers.IdentityManager
import com.limelight.computers.StreamRouteRecovery
import com.limelight.nvstream.RelayDelivery
import com.limelight.nvstream.http.ComputerDetails
import com.limelight.nvstream.http.NvHTTP
import org.json.JSONObject
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Owned by the receiver foreground service; no extra listener or public phone port. */
internal class PairedRelayReceiver(
    context: Context,
    private val receiveText: (String) -> Unit,
    private val receiveImage: (ByteArray) -> Unit,
) : Closeable {
    private val app = context.applicationContext
    private val uniqueId = IdentityManager(app).uniqueId
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private val workers = mutableMapOf<String, Worker>()
    private val applyGate = Any()
    @Volatile private var closed = false

    init { scheduler.scheduleWithFixedDelay({ runCatching { reconcile() } }, 0, 5, TimeUnit.SECONDS) }

    private fun computers(): List<ComputerDetails> {
        val database = ComputerDatabaseManager(app)
        return try { database.allComputers } finally { database.close() }
    }

    @Synchronized private fun reconcile() {
        if (closed) return
        val paired = computers().filter { it.serverCert != null }.take(16).associateBy { it.uuid }
        workers.keys.toList().forEach { id ->
            val current = paired[id]
            if (current == null || current.serverCert != workers[id]?.computer?.serverCert) workers.remove(id)?.close()
        }
        paired.forEach { (id, computer) ->
            if (id !in workers) workers[id] = Worker(computer).also { it.start() }
        }
    }

    override fun close() {
        synchronized(applyGate) { closed = true }
        scheduler.shutdownNow()
        synchronized(this) { workers.values.forEach { it.close() }; workers.clear() }
    }

    private inner class Worker(val computer: ComputerDetails) : Thread("ClipRelay paired receiver"), Closeable {
        @Volatile private var stopped = false
        @Volatile private var http: NvHTTP? = null
        private val receipts = RelayReceipts(app, RelayDelivery.sha256(computer.serverCert.encoded))

        private fun authorized(): Boolean {
            if (closed || stopped || isInterrupted) return false
            val database = ComputerDatabaseManager(app)
            return try { database.getComputerByUUID(computer.uuid)?.serverCert == computer.serverCert }
            finally { database.close() }
        }

        override fun close() { stopped = true; http?.closeRelayRequests(); interrupt() }

        override fun run() {
            var retrySeconds = 2L
            while (!closed && !stopped && !isInterrupted) {
                var next: NvHTTP? = null
                try {
                    if (!authorized()) return
                    val route = StreamRouteRecovery.select(app, computer.uuid, uniqueId)
                        ?: throw IOException("RELAY_OFFLINE")
                    if (!authorized()) return
                    next = NvHTTP(route.activeAddress, 0, uniqueId, computer.serverCert, PlatformBinding.getCryptoProvider(app))
                    http = next
                    if (closed || stopped) return
                    val transport = RelayDelivery.Transport(next::relayRequest)
                    while (authorized()) {
                        val message = next.relayRequest(JSONObject().put("op", "poll"))
                        RelayDelivery.receive(message, transport, receipts, { kind, bytes, text ->
                            synchronized(applyGate) {
                                if (!authorized()) throw InterruptedException()
                                if (kind == "json") receiveText(requireNotNull(text))
                                else { validateJpeg(bytes); receiveImage(bytes) }
                            }
                        }, ::authorized)
                        retrySeconds = 2
                    }
                    return
                } catch (_: InterruptedException) { interrupt(); return }
                catch (error: Exception) {
                    // Older hosts and temporarily offline routes never trigger HTTP fallback.
                    if (error.message == "UPDATE_HOST" || error.message == "RELAY_UNPAIRED") retrySeconds = 60
                } finally { next?.closeRelayRequests(); http = null }
                try { sleep(retrySeconds * 1000) } catch (_: InterruptedException) { interrupt(); return }
                retrySeconds = (retrySeconds * 2).coerceAtMost(60)
            }
        }
    }

    private fun validateJpeg(bytes: ByteArray) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val pixels = bounds.outWidth.toLong() * bounds.outHeight.toLong()
        require(bounds.outWidth in 1..32768 && bounds.outHeight in 1..32768 && pixels in 1..100_000_000L && bounds.outMimeType == "image/jpeg")
        // Decode a bounded sample as well as the header, without allocating a full 100 MP bitmap.
        var sample = 1
        while (pixels / sample / sample > 4_000_000) sample *= 2
        val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw IOException("RELAY_BAD_IMAGE")
        decoded.recycle()
    }
}

/** Receipt data contains hashes and IDs only. Clipboard contents stay in the normal history. */
private class RelayReceipts(context: Context, private val host: String) : RelayDelivery.Receipts {
    private val preferences = context.getSharedPreferences("paired_relay_receipts", Context.MODE_PRIVATE)
    override fun state(id: String, hash: String): String = synchronized(gate) {
        val encoded = preferences.getString("$host:$id", null) ?: return@synchronized ""
        runCatching {
            val value = JSONObject(encoded)
            if (value.getString("hash") == hash && value.getString("state") == "applied") "applied" else "pending"
        }.getOrDefault("pending")
    }

    override fun save(id: String, hash: String, state: String) = synchronized(gate) {
        val key = "$host:$id"
        val now = System.currentTimeMillis()
        val editor = preferences.edit()
        val retained = preferences.all.filter { (entryKey, value) ->
            val created = runCatching { JSONObject(value as String).getLong("created") }.getOrDefault(now)
            // The host discards all payloads within five minutes. Retain receipts
            // for an hour to cover retries and ordinary clock adjustments.
            val expired = entryKey != key && now - created > TimeUnit.HOURS.toMillis(1)
            if (expired) editor.remove(entryKey)
            !expired
        }
        check(key in retained || retained.size < 4096) { "RELAY_RECEIPTS_FULL" }
        val created = preferences.getString(key, null)?.let { runCatching { JSONObject(it).getLong("created") }.getOrNull() } ?: now
        check(editor.putString(key, JSONObject().put("hash", hash).put("state", state).put("created", created).toString()).commit()) { "RELAY_RECEIPT_WRITE_FAILED" }
    }
    companion object { private val gate = Any() }
}
