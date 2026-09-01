package com.cliprelay.app.server

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.ByteArrayInputStream
import java.nio.charset.StandardCharsets

class HttpRequestParserTest {
    @Test
    fun parsesPushRequestWithUtf8Body() {
        val body = "{\"text\":\"你好 ClipRelay\"}".toByteArray(StandardCharsets.UTF_8)
        val raw = buildString {
            append("POST /push HTTP/1.1\r\n")
            append("Host: 192.168.1.5:47632\r\n")
            append("Content-Type: application/json\r\n")
            append("Content-Length: ${body.size}\r\n")
            append("X-ClipRelay-Token: secret\r\n\r\n")
        }.toByteArray(StandardCharsets.ISO_8859_1) + body

        val request = HttpRequestParser.parse(ByteArrayInputStream(raw))

        assertEquals("POST", request.method)
        assertEquals("/push", request.path)
        assertEquals("secret", request.headers["x-cliprelay-token"])
        assertArrayEquals(body, request.body)
    }

    @Test
    fun rejectsMissingContentLength() {
        val raw = "POST /push HTTP/1.1\r\nHost: phone\r\n\r\n"
            .toByteArray(StandardCharsets.ISO_8859_1)

        val error = assertThrows(HttpProtocolException::class.java) {
            HttpRequestParser.parse(ByteArrayInputStream(raw))
        }

        assertEquals(411, error.statusCode)
    }

    @Test
    fun rejectsOversizedBodyBeforeReadingIt() {
        val raw = "POST /push HTTP/1.1\r\nContent-Length: 1048577\r\n\r\n"
            .toByteArray(StandardCharsets.ISO_8859_1)

        val error = assertThrows(HttpProtocolException::class.java) {
            HttpRequestParser.parse(ByteArrayInputStream(raw))
        }

        assertEquals(413, error.statusCode)
    }

    @Test
    fun rejectsDuplicateContentLength() {
        val raw = buildString {
            append("POST /push HTTP/1.1\r\n")
            append("Content-Length: 0\r\n")
            append("Content-Length: 0\r\n\r\n")
        }.toByteArray(StandardCharsets.ISO_8859_1)

        val error = assertThrows(HttpProtocolException::class.java) {
            HttpRequestParser.parse(ByteArrayInputStream(raw))
        }

        assertEquals(400, error.statusCode)
    }
}
