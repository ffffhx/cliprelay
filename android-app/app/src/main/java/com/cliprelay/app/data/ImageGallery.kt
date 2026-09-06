package com.cliprelay.app.data

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File
import java.io.FileNotFoundException

object ImageGallery {
    /** Copies the received JPEG unchanged; callers must run this off the main thread. */
    fun save(context: Context, imagePath: String) {
        val source = File(imagePath)
        if (!source.isFile) throw FileNotFoundException("图片文件已不存在")
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            saveLegacy(context, source)
            return
        }

        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "ClipRelay-${System.currentTimeMillis()}.jpg")
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            put(MediaStore.Images.Media.RELATIVE_PATH, "${Environment.DIRECTORY_PICTURES}/ClipRelay")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = checkNotNull(resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)) {
            "无法创建相册图片"
        }
        try {
            source.inputStream().use { input ->
                checkNotNull(resolver.openOutputStream(uri)) { "无法写入相册图片" }.use { output ->
                    input.copyTo(output)
                }
            }
            check(resolver.update(uri, ContentValues().apply {
                put(MediaStore.Images.Media.IS_PENDING, 0)
            }, null, null) == 1) { "无法完成相册图片保存" }
        } catch (error: Exception) {
            runCatching { resolver.delete(uri, null, null) }
            throw error
        }
    }

    @Suppress("DEPRECATION")
    private fun saveLegacy(context: Context, source: File) {
        val directory = File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
            "ClipRelay",
        )
        check(directory.isDirectory || directory.mkdirs()) { "无法创建相册目录" }
        val target = File.createTempFile("ClipRelay-", ".jpg", directory)
        try {
            source.inputStream().use { input -> target.outputStream().use { input.copyTo(it) } }
            MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), arrayOf("image/jpeg"), null)
        } catch (error: Exception) {
            runCatching { target.delete() }
            throw error
        }
    }
}
