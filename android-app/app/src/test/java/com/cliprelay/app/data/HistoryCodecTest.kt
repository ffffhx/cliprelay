package com.cliprelay.app.data

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HistoryCodecTest {
    @Test
    fun `legacy text history remains readable`() = withImageDirectory { imageDirectory ->
        val encoded = """
            [
              {
                "id": 101,
                "text": "old format",
                "receivedAt": 1000
              }
            ]
        """.trimIndent()

        assertEquals(
            listOf(
                ReceivedClip(
                    id = 101,
                    text = "old format",
                    receivedAt = 1000,
                ),
            ),
            HistoryCodec.decode(encoded, imageDirectory),
        )
    }

    @Test
    fun `mixed history survives an encode decode round trip`() =
        withImageDirectory { imageDirectory ->
            val imageFile = File(imageDirectory, "clip-202.jpg").apply {
                writeBytes(byteArrayOf(1, 2, 3))
            }
            val expected = listOf(
                ReceivedClip(
                    id = 202,
                    receivedAt = 2000,
                    kind = ReceivedClipKind.IMAGE,
                    imagePath = imageFile.absolutePath,
                    imageWidth = 1920,
                    imageHeight = 1080,
                ),
                ReceivedClip(
                    id = 201,
                    text = "new format",
                    receivedAt = 1900,
                ),
            )

            val decoded = HistoryCodec.decode(HistoryCodec.encode(expected), imageDirectory)

            assertEquals(expected, decoded)
            assertTrue(decoded.first().isImage)
        }

    @Test
    fun `missing or unsafe image files are not restored`() =
        withImageDirectory { imageDirectory ->
            val encoded = """
                [
                  {
                    "id": 301,
                    "receivedAt": 3000,
                    "kind": "image",
                    "imageFile": "../outside.jpg"
                  },
                  {
                    "id": 302,
                    "receivedAt": 3001,
                    "kind": "image",
                    "imageFile": "missing.jpg"
                  }
                ]
            """.trimIndent()

            assertTrue(HistoryCodec.decode(encoded, imageDirectory).isEmpty())
        }

    private fun withImageDirectory(block: (File) -> Unit) {
        val directory = Files.createTempDirectory("cliprelay-history-test").toFile()
        try {
            block(directory)
        } finally {
            directory.deleteRecursively()
        }
    }
}
