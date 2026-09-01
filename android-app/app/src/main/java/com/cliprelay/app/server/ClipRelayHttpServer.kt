package com.cliprelay.app.server

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class ClipRelayHttpServer(
    private val port: Int,
    private val accessToken: () -> String,
    private val listener: Listener,
) {
    interface Listener {
        fun onListening(port: Int)
        fun onTextReceived(text: String)
        fun onImageReceived(bytes: ByteArray, mediaType: String)
        fun onFailure(message: String)
    }

    private val running = AtomicBoolean(false)
    private val acceptExecutor = Executors.newSingleThreadExecutor()
    private val clientExecutor = Executors.newFixedThreadPool(4)

    @Volatile
    private var serverSocket: ServerSocket? = null

    fun start() {
        if (!running.compareAndSet(false, true)) return

        acceptExecutor.execute {
            try {
                val socket = ServerSocket().apply {
                    reuseAddress = true
                    bind(InetSocketAddress("0.0.0.0", port))
                }
                serverSocket = socket
                listener.onListening(socket.localPort)

                while (running.get()) {
                    val client = socket.accept()
                    clientExecutor.execute { handleClient(client) }
                }
            } catch (error: Exception) {
                if (running.get() && error !is SocketException) {
                    listener.onFailure(error.message ?: "无法监听端口 $port")
                } else if (running.get()) {
                    listener.onFailure(error.message ?: "接收服务意外停止")
                }
            } finally {
                running.set(false)
                runCatching { serverSocket?.close() }
            }
        }
    }

    fun stop() {
        running.set(false)
        runCatching { serverSocket?.close() }
        acceptExecutor.shutdownNow()
        clientExecutor.shutdownNow()
    }

    private fun handleClient(socket: Socket) {
        socket.use { client ->
            client.soTimeout = CLIENT_TIMEOUT_MS
            val output = BufferedOutputStream(client.getOutputStream())
            try {
                val request = HttpRequestParser.parse(
                    input = BufferedInputStream(client.getInputStream()),
                    maxBodyBytes = MAX_IMAGE_BODY_BYTES,
                )
                val requestPath = request.path.substringBefore('?')
                when {
                    request.method != "POST" -> respond(output, 405, "Method Not Allowed")
                    requestPath != "/push" && requestPath != "/push-image" ->
                        respond(output, 404, "Not Found")
                    !isAuthorized(request) -> respond(output, 401, "Unauthorized")
                    requestPath == "/push-image" -> handleImagePush(request, output)
                    else -> handleTextPush(request, output)
                }
            } catch (error: HttpProtocolException) {
                respond(output, error.statusCode, error.message)
            } catch (_: Exception) {
                respond(output, 400, "Bad Request")
            }
        }
    }

    private fun isAuthorized(request: HttpRequest): Boolean {
        val expected = accessToken().trim()
        if (expected.isEmpty()) return true

        val headerToken = request.headers["x-cliprelay-token"]
        val bearerToken = request.headers["authorization"]
            ?.takeIf { it.startsWith("Bearer ", ignoreCase = true) }
            ?.substringAfter(' ')
        return headerToken == expected || bearerToken == expected
    }

    private fun handleTextPush(request: HttpRequest, output: BufferedOutputStream) {
        if (request.body.size > MAX_TEXT_BODY_BYTES) {
            respond(output, 413, "Payload Too Large")
            return
        }
        val payload = try {
            JSONObject(request.body.toString(StandardCharsets.UTF_8))
        } catch (_: Exception) {
            respond(output, 400, "Invalid JSON")
            return
        }

        val text = payload.opt("text") as? String
        if (text.isNullOrEmpty()) {
            respond(output, 400, "Text is required")
            return
        }

        if (!payload.optBoolean("probe", false)) {
            listener.onTextReceived(text)
        }
        respond(output, 200, "ok", reason = "OK")
    }

    private fun handleImagePush(request: HttpRequest, output: BufferedOutputStream) {
        val mediaType = request.headers["content-type"]
            ?.substringBefore(';')
            ?.trim()
            ?.lowercase()
        if (mediaType != "image/jpeg") {
            respond(output, 415, "JPEG image required")
            return
        }
        if (
            request.body.size < 3 ||
            request.body[0] != JPEG_MARKER ||
            request.body[1] != JPEG_START_OF_IMAGE ||
            request.body[2] != JPEG_MARKER
        ) {
            respond(output, 400, "Invalid JPEG")
            return
        }

        listener.onImageReceived(request.body, mediaType)
        respond(output, 200, "ok", reason = "OK")
    }

    private fun respond(
        output: BufferedOutputStream,
        statusCode: Int,
        body: String,
        reason: String = defaultReason(statusCode),
    ) {
        val bodyBytes = body.toByteArray(StandardCharsets.UTF_8)
        val header = buildString {
            append("HTTP/1.1 $statusCode $reason\r\n")
            append("Content-Type: text/plain; charset=utf-8\r\n")
            append("Content-Length: ${bodyBytes.size}\r\n")
            append("Connection: close\r\n\r\n")
        }.toByteArray(StandardCharsets.ISO_8859_1)
        runCatching {
            output.write(header)
            output.write(bodyBytes)
            output.flush()
        }
    }

    private fun defaultReason(statusCode: Int): String = when (statusCode) {
        400 -> "Bad Request"
        401 -> "Unauthorized"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        411 -> "Length Required"
        413 -> "Payload Too Large"
        415 -> "Unsupported Media Type"
        431 -> "Request Header Fields Too Large"
        else -> "Error"
    }

    private companion object {
        const val CLIENT_TIMEOUT_MS = 5_000
        const val MAX_TEXT_BODY_BYTES = 1024 * 1024
        const val MAX_IMAGE_BODY_BYTES = 25 * 1024 * 1024
        const val JPEG_MARKER: Byte = 0xFF.toByte()
        const val JPEG_START_OF_IMAGE: Byte = 0xD8.toByte()
    }
}
