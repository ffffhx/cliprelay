package com.cliprelay.app.runtime

import kotlinx.coroutines.channels.Channel

/** A fresh queue per visible preview; commands never survive leaving the viewer. */
object PreviewRemote {
    private var session: Channel<Int>? = null

    @Synchronized fun attach(): Channel<Int> = Channel<Int>(32).also {
        session?.close()
        session = it
    }

    @Synchronized fun detach(queue: Channel<Int>) {
        if (session === queue) session = null
        queue.close()
    }

    @Synchronized fun navigate(delta: Int): Boolean {
        require(delta == -1 || delta == 1)
        return session?.trySend(delta)?.isSuccess == true
    }
}
