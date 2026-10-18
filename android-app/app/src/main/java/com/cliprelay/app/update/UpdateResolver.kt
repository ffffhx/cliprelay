package com.cliprelay.app.update

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

data class ResolvedUpdate(val info: UpdateInfo, val allSourcesChecked: Boolean)

object UpdateResolver {
    suspend fun check(
        urls: List<String>,
        installedCode: Long,
        fetch: (String) -> String,
    ): ResolvedUpdate = coroutineScope {
        val results = urls.distinct().map { url ->
            async(Dispatchers.IO) {
                try {
                    Result.success(UpdateManifestParser.parse(fetch(url)))
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    Result.failure(error)
                }
            }
        }.awaitAll()
        resolve(results, installedCode)
    }

    fun resolve(results: List<Result<UpdateInfo>>, installedCode: Long): ResolvedUpdate {
        val releases = results.mapNotNull { it.getOrNull() }
        check(releases.isNotEmpty()) { "更新服务暂时不可用，请稍后重新检查" }
        releases.groupBy { it.versionCode }.values.forEach { sameVersion ->
            check(sameVersion.map { it.versionName to it.sha256 }.distinct().size == 1) {
                "更新信息不一致，暂时无法确认版本，请稍后重试"
            }
        }
        // Stable ordering prefers the nearby mirror when both describe the same APK.
        val newest = releases.maxBy { it.versionCode }
        val complete = results.all { it.isSuccess }
        check(complete || newest.versionCode > installedCode) {
            "部分更新服务暂时不可用，无法确认是否有新版本，请稍后重试"
        }
        return ResolvedUpdate(newest, complete)
    }

    fun noUpdateMessage(releasedCode: Long, installedCode: Long): String =
        if (releasedCode < installedCode) "更新服务提供的版本较旧，暂未发现可用更新"
        else "当前已是最新版"
}
