package com.cliprelay.app.server

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets

data class HttpRequest(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val body: ByteArray,
)

class HttpProtocolException(
    val statusCode: Int,
    override val message: String,
) : Exception(message)

object HttpRequestParser {
    const val DEFAULT_MAX_HEADER_BYTES = 16 * 1024
    const val DEFAULT_MAX_BODY_BYTES = 1024 * 1024

    fun parse(
        input: InputStream,
        maxHeaderBytes: Int = DEFAULT_MAX_HEADER_BYTES,
        maxBodyBytes: Int = DEFAULT_MAX_BODY_BYTES,
    ): HttpRequest {
        val headerBytes = readHeader(input, maxHeaderBytes)
        val headerText = headerBytes.toString(StandardCharsets.ISO_8859_1)
        val lines = headerText.split("\r\n")
        val requestParts = lines.firstOrNull()?.trim()?.split(Regex("\\s+"))
            ?: throw HttpProtocolException(400, "Missing request line")

        if (requestParts.size != 3 || !requestParts[2].startsWith("HTTP/1.")) {
            throw HttpProtocolException(400, "Invalid request line")
        }

        val headers = linkedMapOf<String, String>()
        lines.drop(1).filter { it.isNotEmpty() }.forEach { line ->
            val separator = line.indexOf(':')
            if (separator <= 0) {
                throw HttpProtocolException(400, "Invalid header")
            }
            val name = line.substring(0, separator).trim().lowercase()
            if (name in headers) {
                throw HttpProtocolException(400, "Duplicate header")
            }
            headers[name] = line.substring(separator + 1).trim()
        }

        val contentLength = headers["content-length"]?.toIntOrNull()
            ?: throw HttpProtocolException(411, "Content-Length is required")
        if (contentLength !in 0..maxBodyBytes) {
            throw HttpProtocolException(413, "Request body is too large")
        }

        val body = ByteArray(contentLength)
        var offset = 0
        while (offset < contentLength) {
            val count = input.read(body, offset, contentLength - offset)
            if (count < 0) {
                throw HttpProtocolException(400, "Request body ended early")
            }
            offset += count
        }

        return HttpRequest(
            method = requestParts[0],
            path = requestParts[1],
            headers = headers,
            body = body,
        )
    }

    private fun readHeader(input: InputStream, maxHeaderBytes: Int): ByteArray {
        val output = ByteArrayOutputStream()
        var matched = 0
        val delimiter = byteArrayOf(13, 10, 13, 10)

        while (output.size() < maxHeaderBytes) {
            val next = input.read()
            if (next < 0) {
                throw HttpProtocolException(400, "Request headers ended early")
            }
            output.write(next)

            if (next.toByte() == delimiter[matched]) {
                matched += 1
                if (matched == delimiter.size) {
                    val bytes = output.toByteArray()
                    return bytes.copyOf(bytes.size - delimiter.size)
                }
            } else {
                matched = if (next.toByte() == delimiter[0]) 1 else 0
            }
        }
        throw HttpProtocolException(431, "Request headers are too large")
    }
}
