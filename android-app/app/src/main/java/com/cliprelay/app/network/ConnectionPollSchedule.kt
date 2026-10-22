package com.cliprelay.app.network

/** Only coordinator metadata is throttled; transport, receive and authorization stay live. */
internal class ConnectionPollSchedule {
    private var previous: String? = null
    private var repeats = 0

    fun reset() { previous = null; repeats = 0 }

    fun next(state: String, foreground: Boolean): Long {
        if (foreground) { reset(); return 3_000 }
        repeats = if (previous == state) (repeats + 1).coerceAtMost(4) else 0
        previous = state
        return (3_000L shl repeats).coerceAtMost(30_000)
    }
}
