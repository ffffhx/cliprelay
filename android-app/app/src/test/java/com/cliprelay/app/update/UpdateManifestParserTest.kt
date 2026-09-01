package com.cliprelay.app.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class UpdateManifestParserTest {
    @Test
    fun parsesValidManifest() {
        val result = UpdateManifestParser.parse(
            """
            {
              "versionCode": 3,
              "versionName": "0.3.0",
              "apkUrl": "https://example.com/ClipRelay.apk",
              "sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              "releaseNotes": "修复连接问题"
            }
            """.trimIndent(),
        )

        assertEquals(3L, result.versionCode)
        assertEquals("0.3.0", result.versionName)
        assertEquals("a".repeat(64), result.sha256)
        assertEquals("修复连接问题", result.releaseNotes)
    }

    @Test
    fun rejectsNonHttpsApk() {
        assertThrows(IllegalArgumentException::class.java) {
            UpdateManifestParser.parse(
                """
                {
                  "versionCode": 3,
                  "versionName": "0.3.0",
                  "apkUrl": "http://example.com/ClipRelay.apk",
                  "sha256": "${"a".repeat(64)}"
                }
                """.trimIndent(),
            )
        }
    }

    @Test
    fun rejectsInvalidDigest() {
        assertThrows(IllegalArgumentException::class.java) {
            UpdateManifestParser.parse(
                """
                {
                  "versionCode": 3,
                  "versionName": "0.3.0",
                  "apkUrl": "https://example.com/ClipRelay.apk",
                  "sha256": "not-a-digest"
                }
                """.trimIndent(),
            )
        }
    }
}
