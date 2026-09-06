package com.cliprelay.app.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel

/** Shared by the list and viewer, retained on rotation, discarded when the activity is closed. */
class ClipActionSession : ViewModel() {
    var copiedClipIds by mutableStateOf(emptySet<Long>())
        private set
    var savedImageIds by mutableStateOf(emptySet<Long>())
        private set
    var savingImageId by mutableStateOf<Long?>(null)

    fun copied(id: Long) {
        copiedClipIds = copiedClipIds + id
    }

    fun saved(id: Long) {
        savedImageIds = savedImageIds + id
    }
}
