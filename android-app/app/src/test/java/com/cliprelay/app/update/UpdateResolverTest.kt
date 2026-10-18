package com.cliprelay.app.update

import java.io.IOException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class UpdateResolverTest {
    private fun release(code: Long, url: String = "https://mirror.test/$code.apk") =
        UpdateInfo(code, "0.10.${code - 30}", url, "a".repeat(64), "")
    private val offline = Result.failure<UpdateInfo>(IOException("offline"))

    @Test fun staleMirrorCannotHideNewRelease() {
        val next = release(59, "https://github.com/new.apk")
        val result = UpdateResolver.resolve(listOf(Result.success(release(57)), Result.success(next)), 58)
        assertEquals(next, result.info)
        assertTrue(result.allSourcesChecked)
    }

    @Test fun equalReleasePrefersMirrorDownload() {
        val mirror = release(59)
        assertEquals(mirror, UpdateResolver.resolve(listOf(Result.success(mirror),
            Result.success(mirror.copy(apkUrl = "https://github.com/new.apk"))), 58).info)
    }

    @Test fun mirrorMayBeNewerThanFallback() {
        assertEquals(60L, UpdateResolver.resolve(listOf(Result.success(release(60)), Result.success(release(59))), 58).info.versionCode)
    }

    @Test fun availableUpdateSurvivesOneOfflineSource() {
        for (results in listOf(listOf(offline, Result.success(release(59))), listOf(Result.success(release(59)), offline))) {
            val result = UpdateResolver.resolve(results, 58)
            assertEquals(59L, result.info.versionCode)
            assertFalse(result.allSourcesChecked)
        }
    }

    @Test fun offlineSourceCannotProduceLatestClaim() {
        for (code in listOf(57L, 58L)) {
            assertThrows(IllegalStateException::class.java) {
                UpdateResolver.resolve(listOf(Result.success(release(code)), offline), 58)
            }
        }
    }

    @Test fun unavailableServicesDoNotMeanLatest() {
        assertThrows(IllegalStateException::class.java) { UpdateResolver.resolve(listOf(offline, offline), 58) }
    }

    @Test fun inconsistentSameVersionIsRejected() {
        for (different in listOf(release(59).copy(sha256 = "b".repeat(64)), release(59).copy(versionName = "9.0.0"))) {
            assertThrows(IllegalStateException::class.java) {
                UpdateResolver.resolve(listOf(Result.success(release(59)), Result.success(different)), 58)
            }
        }
    }

    @Test fun staleSourcesAreNotLabeledLatest() {
        assertFalse(UpdateResolver.noUpdateMessage(57, 59).contains("已是最新版"))
        assertEquals("当前已是最新版", UpdateResolver.noUpdateMessage(59, 59))
    }

    @Test fun malformedPrimaryFallsBackToValidManifest() = runBlocking {
        val result = UpdateResolver.check(listOf("mirror", "fallback"), 58) { url ->
            if (url == "mirror") "not json" else """{"versionCode":59,"versionName":"0.10.29","apkUrl":"https://github.com/new.apk","sha256":"${"a".repeat(64)}"}"""
        }
        assertEquals(59L, result.info.versionCode)
        assertFalse(result.allSourcesChecked)
    }
}
