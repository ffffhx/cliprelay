package com.cliprelay.app.update

import org.json.JSONObject
import java.net.URI

data class UpdateInfo(
    val versionCode: Long,
    val versionName: String,
    val apkUrl: String,
    val sha256: String,
    val releaseNotes: String,
)

object UpdateManifestParser {
    private val sha256Pattern = Regex("^[0-9a-fA-F]{64}$")

    fun parse(json: String): UpdateInfo {
        val source = JSONObject(json)
        val versionCode = source.getLong("versionCode")
        val versionName = source.getString("versionName").trim()
        val apkUrl = source.getString("apkUrl").trim()
        val sha256 = source.getString("sha256").trim().lowercase()
        val releaseNotes = source.optString("releaseNotes").trim()

        require(versionCode > 0) { "versionCode 必须大于 0" }
        require(versionName.isNotEmpty()) { "versionName 不能为空" }
        require(URI(apkUrl).scheme.equals("https", ignoreCase = true)) {
            "APK 下载地址必须使用 HTTPS"
        }
        require(sha256Pattern.matches(sha256)) { "sha256 必须是 64 位十六进制摘要" }

        return UpdateInfo(
            versionCode = versionCode,
            versionName = versionName,
            apkUrl = apkUrl,
            sha256 = sha256,
            releaseNotes = releaseNotes,
        )
    }
}
