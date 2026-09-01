package com.cliprelay.app.runtime

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

enum class ReceiverPhase {
    STOPPED,
    STARTING,
    RUNNING,
    ERROR,
}
data class ReceiverStatus(
    val phase: ReceiverPhase = ReceiverPhase.STOPPED,
    val port: Int = 47632,
    val addresses: List<String> = emptyList(),
    val detail: String? = null,
)

object ClipRelayRuntime {
    val receiverStatus = MutableStateFlow(ReceiverStatus())
    val historyRevision = MutableStateFlow(0L)

    fun historyChanged() {
        historyRevision.update { it + 1 }
    }
}
