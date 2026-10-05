package com.cliprelay.app.runtime

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

data class PreviewRemoteState(
    val active: Boolean = false,
    val page: Int = 0,
    val pageCount: Int = 0,
    val contentType: String? = null,
    val moving: Boolean = false,
)

/** A fresh queue per visible preview; commands never survive leaving the viewer. */
object PreviewRemote {
    private var session: Channel<Int>? = null
    private var state = PreviewRemoteState()

    @Synchronized fun attach(): Channel<Int> = Channel<Int>(32).also {
        session?.close()
        session = it
        state = PreviewRemoteState()
    }

    @Synchronized fun detach(queue: Channel<Int>) {
        if (session === queue) {
            session = null
            state = PreviewRemoteState()
        }
        queue.close()
    }

    @Synchronized fun update(queue: Channel<Int>, value: PreviewRemoteState) {
        if (session !== queue) return
        require(!value.active || (value.page in 1..value.pageCount && value.contentType in setOf("text", "image")))
        state = value
    }

    @Synchronized fun snapshot(): PreviewRemoteState = state

    internal suspend fun consume(queue: Channel<Int>, navigate: suspend (Int) -> Unit) = coroutineScope {
        for (delta in queue) {
            // A touch gesture or pager relayout may cancel one scroll. Keep that
            // cancellation inside a child so the session and state publisher live
            // on. Cancelling the foreground session still cancels this child.
            launch { navigate(delta) }.join()
        }
    }

    @Synchronized fun navigate(delta: Int): Boolean {
        require(delta == -1 || delta == 1)
        return session?.trySend(delta)?.isSuccess == true
    }
}
