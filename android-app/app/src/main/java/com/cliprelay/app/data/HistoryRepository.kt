package com.cliprelay.app.data

import android.content.Context
import androidx.core.content.edit
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

enum class ReceivedClipKind {
    TEXT,
    IMAGE,
}

data class ReceivedClip(
    val id: Long,
    val text: String = "",
    val receivedAt: Long,
    val kind: ReceivedClipKind = ReceivedClipKind.TEXT,
    val imagePath: String? = null,
    val imageWidth: Int? = null,
    val imageHeight: Int? = null,
) {
    val isImage: Boolean
        get() = kind == ReceivedClipKind.IMAGE && imagePath != null
}

class HistoryRepository(context: Context) {
    private val applicationContext = context.applicationContext
    private val preferences = applicationContext.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
    private val imageDirectory = File(applicationContext.filesDir, IMAGE_DIRECTORY)

    @Synchronized
    fun all(): List<ReceivedClip> {
        val encoded = preferences.getString(KEY_HISTORY, null) ?: return emptyList()
        return HistoryCodec.decode(encoded, imageDirectory)
    }

    @Synchronized
    fun add(text: String): ReceivedClip {
        val clip = ReceivedClip(
            id = nextId(),
            text = text.take(MAX_STORED_CHARACTERS),
            receivedAt = System.currentTimeMillis(),
        )
        return prepend(clip)
    }

    @Synchronized
    fun addImage(bytes: ByteArray, width: Int, height: Int): ReceivedClip {
        check(imageDirectory.isDirectory || imageDirectory.mkdirs()) {
            "Cannot create the received image directory"
        }

        val id = nextId()
        val imageFile = File(imageDirectory, "clip-$id.jpg")
        val stagingFile = File.createTempFile("incoming-", ".tmp", imageDirectory)
        try {
            stagingFile.outputStream().use { it.write(bytes) }
            if (!stagingFile.renameTo(imageFile)) {
                stagingFile.copyTo(imageFile, overwrite = true)
                check(stagingFile.delete()) { "Cannot remove the staged image" }
            }

            return prepend(
                ReceivedClip(
                    id = id,
                    receivedAt = System.currentTimeMillis(),
                    kind = ReceivedClipKind.IMAGE,
                    imagePath = imageFile.absolutePath,
                    imageWidth = width,
                    imageHeight = height,
                ),
            )
        } catch (error: Exception) {
            runCatching { stagingFile.delete() }
            runCatching { imageFile.delete() }
            throw error
        }
    }

    @Synchronized
    fun clear() {
        preferences.edit { remove(KEY_HISTORY) }
        imageDirectory.listFiles()?.forEach { runCatching { it.delete() } }
    }

    private fun nextId(): Long {
        val now = System.currentTimeMillis()
        return maxOf(now, preferences.getLong(KEY_LAST_ID, 0L) + 1)
    }

    private fun prepend(clip: ReceivedClip): ReceivedClip {
        val updated = (listOf(clip) + all()).take(MAX_ITEMS)
        preferences.edit {
            putString(KEY_HISTORY, HistoryCodec.encode(updated))
            putLong(KEY_LAST_ID, clip.id)
        }
        removeUnreferencedImages(updated)
        return clip
    }

    private fun removeUnreferencedImages(retained: List<ReceivedClip>) {
        val retainedNames = retained.mapNotNull { it.imagePath?.let(::File)?.name }.toSet()
        imageDirectory.listFiles()
            ?.filter { it.name !in retainedNames }
            ?.forEach { runCatching { it.delete() } }
    }

    companion object {
        const val IMAGE_DIRECTORY = "received_images"
        private const val FILE_NAME = "cliprelay_history"
        private const val KEY_HISTORY = "received_clips"
        private const val KEY_LAST_ID = "last_id"
        private const val MAX_ITEMS = 30
        private const val MAX_STORED_CHARACTERS = 20_000
    }
}

internal object HistoryCodec {
    fun decode(encoded: String, imageDirectory: File): List<ReceivedClip> = runCatching {
        val array = JSONArray(encoded)
        buildList {
            for (index in 0 until array.length()) {
                decodeItem(array.getJSONObject(index), imageDirectory)?.let(::add)
            }
        }
    }.getOrDefault(emptyList())

    fun encode(items: List<ReceivedClip>): String {
        val array = JSONArray()
        items.forEach { clip ->
            val item = JSONObject()
                .put("id", clip.id)
                .put("receivedAt", clip.receivedAt)
                .put("kind", clip.kind.name.lowercase())

            if (clip.kind == ReceivedClipKind.TEXT) {
                item.put("text", clip.text)
            } else {
                item.put("imageFile", clip.imagePath?.let(::File)?.name)
                item.put("imageWidth", clip.imageWidth)
                item.put("imageHeight", clip.imageHeight)
            }
            array.put(item)
        }
        return array.toString()
    }

    private fun decodeItem(item: JSONObject, imageDirectory: File): ReceivedClip? = runCatching {
        val kind = when (item.optString("kind", "text").lowercase()) {
            "image" -> ReceivedClipKind.IMAGE
            else -> ReceivedClipKind.TEXT
        }
        if (kind == ReceivedClipKind.TEXT) {
            ReceivedClip(
                id = item.getLong("id"),
                text = item.optString("text", ""),
                receivedAt = item.getLong("receivedAt"),
            )
        } else {
            val fileName = item.optString("imageFile", "")
            if (fileName.isBlank() || fileName != File(fileName).name) return@runCatching null
            val imageFile = File(imageDirectory, fileName)
            if (!imageFile.isFile) return@runCatching null

            ReceivedClip(
                id = item.getLong("id"),
                receivedAt = item.getLong("receivedAt"),
                kind = ReceivedClipKind.IMAGE,
                imagePath = imageFile.absolutePath,
                imageWidth = item.optInt("imageWidth", 0).takeIf { it > 0 },
                imageHeight = item.optInt("imageHeight", 0).takeIf { it > 0 },
            )
        }
    }.getOrNull()
}
