package com.cliprelay.app.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class ClipRelayHttpServerTest {
    @Test
    fun acceptsLegacyPushWhenAccessTokenIsEmpty() {
        val listening = CountDownLatch(1)
        val received = CountDownLatch(1)
        val actualPort = AtomicReference<Int>()
        val receivedText = AtomicReference<String>()
        val server = ClipRelayHttpServer(
            port = 0,
            accessToken = { "" },
            listener = object : ClipRelayHttpServer.Listener {
                override fun onListening(port: Int) {
                    actualPort.set(port)
                    listening.countDown()
                }

                override fun onTextReceived(text: String) {
                    receivedText.set(text)
                    received.countDown()
                }

                override fun onImageReceived(bytes: ByteArray, mediaType: String) = Unit

                override fun onFailure(message: String) {
                    listening.countDown()
                }
            },
        )

        try {
            server.start()
            assertTrue(listening.await(3, TimeUnit.SECONDS))
            val response = post(actualPort.get(), "{\"text\":\"legacy client\"}")
            assertTrue(response.startsWith("HTTP/1.1 200"))
            assertTrue(received.await(1, TimeUnit.SECONDS))
            assertEquals("legacy client", receivedText.get())
        } finally {
            server.stop()
        }
    }

    @Test
    fun servesAuthenticatedProbeAndPushRequests() {
        val listening = CountDownLatch(1)
        val received = CountDownLatch(1)
        val actualPort = AtomicReference<Int>()
        val receivedText = AtomicReference<String>()
        val failure = AtomicReference<String>()
        val server = ClipRelayHttpServer(
            port = 0,
            accessToken = { "secret" },
            listener = object : ClipRelayHttpServer.Listener {
                override fun onListening(port: Int) {
                    actualPort.set(port)
                    listening.countDown()
                }

                override fun onTextReceived(text: String) {
                    receivedText.set(text)
                    received.countDown()
                }

                override fun onImageReceived(bytes: ByteArray, mediaType: String) = Unit

                override fun onFailure(message: String) {
                    failure.set(message)
                    listening.countDown()
                }
            },
        )

        try {
            server.start()
            assertTrue("Server did not start: ${failure.get()}", listening.await(3, TimeUnit.SECONDS))
            val port = actualPort.get()

            val unauthorized = post(port, "{\"text\":\"blocked\"}")
            assertTrue(unauthorized.startsWith("HTTP/1.1 401"))

            val probe = post(
                port = port,
                body = "{\"text\":\"probe\",\"probe\":true}",
                token = "secret",
            )
            assertTrue(probe.startsWith("HTTP/1.1 200"))
            assertFalse(received.await(100, TimeUnit.MILLISECONDS))

            val response = post(
                port = port,
                body = "{\"text\":\"你好 ClipRelay\"}",
                token = "secret",
            )
            assertTrue(response.startsWith("HTTP/1.1 200"))
            assertTrue(received.await(1, TimeUnit.SECONDS))
            assertEquals("你好 ClipRelay", receivedText.get())
        } finally {
            server.stop()
        }
    }

    @Test
    fun acceptsAuthenticatedJpegPush() {
        val listening = CountDownLatch(1)
        val received = CountDownLatch(1)
        val actualPort = AtomicReference<Int>()
        val receivedBytes = AtomicReference<ByteArray>()
        val receivedMediaType = AtomicReference<String>()
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xD9.toByte())
        val server = ClipRelayHttpServer(
            port = 0,
            accessToken = { "secret" },
            listener = object : ClipRelayHttpServer.Listener {
                override fun onListening(port: Int) {
                    actualPort.set(port)
                    listening.countDown()
                }

                override fun onTextReceived(text: String) = Unit

                override fun onImageReceived(bytes: ByteArray, mediaType: String) {
                    receivedBytes.set(bytes)
                    receivedMediaType.set(mediaType)
                    received.countDown()
                }

                override fun onFailure(message: String) {
                    listening.countDown()
                }
            },
        )

        try {
            server.start()
            assertTrue(listening.await(3, TimeUnit.SECONDS))
            val response = postBytes(
                port = actualPort.get(),
                path = "/push-image",
                body = jpeg,
                contentType = "image/jpeg",
                token = "secret",
            )

            assertTrue(response.startsWith("HTTP/1.1 200"))
            assertTrue(received.await(1, TimeUnit.SECONDS))
            assertArrayEquals(jpeg, receivedBytes.get())
            assertEquals("image/jpeg", receivedMediaType.get())
        } finally {
            server.stop()
        }
    }

    @Test
    fun rejectsNonJpegImagePush() {
        val listening = CountDownLatch(1)
        val actualPort = AtomicReference<Int>()
        val server = ClipRelayHttpServer(
            port = 0,
            accessToken = { "" },
            listener = object : ClipRelayHttpServer.Listener {
                override fun onListening(port: Int) {
                    actualPort.set(port)
                    listening.countDown()
                }

                override fun onTextReceived(text: String) = Unit
                override fun onImageReceived(bytes: ByteArray, mediaType: String) = Unit
                override fun onFailure(message: String) = listening.countDown()
            },
        )

        try {
            server.start()
            assertTrue(listening.await(3, TimeUnit.SECONDS))
            val response = postBytes(
                port = actualPort.get(),
                path = "/push-image",
                body = byteArrayOf(1, 2, 3),
                contentType = "application/octet-stream",
            )
            assertTrue(response.startsWith("HTTP/1.1 415"))
        } finally {
            server.stop()
        }
    }

    private fun post(port: Int, body: String, token: String? = null): String {
        val bodyBytes = body.toByteArray(StandardCharsets.UTF_8)
        return postBytes(
            port = port,
            path = "/push",
            body = bodyBytes,
            contentType = "application/json",
            token = token,
        )
    }

    private fun postBytes(
        port: Int,
        path: String,
        body: ByteArray,
        contentType: String,
        token: String? = null,
    ): String {
        return Socket("127.0.0.1", port).use { socket ->
            val request = buildString {
                append("POST $path HTTP/1.1\r\n")
                append("Host: 127.0.0.1:$port\r\n")
                append("Content-Type: $contentType\r\n")
                append("Content-Length: ${body.size}\r\n")
                token?.let { append("X-ClipRelay-Token: $it\r\n") }
                append("\r\n")
            }.toByteArray(StandardCharsets.ISO_8859_1)

            socket.getOutputStream().apply {
                write(request)
                write(body)
                flush()
            }
            socket.shutdownOutput()
            socket.getInputStream().readBytes().toString(StandardCharsets.UTF_8)
        }
    }
}
