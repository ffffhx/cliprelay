package com.cliprelay.app.update

import com.cliprelay.app.BuildConfig

enum class UpdatePhase {
    IDLE,
    CHECKING,
    UP_TO_DATE,
    AVAILABLE,
    DOWNLOADING,
    READY_TO_INSTALL,
    ERROR,
}

data class UpdateState(
    val phase: UpdatePhase = UpdatePhase.IDLE,
    val currentVersionName: String = BuildConfig.VERSION_NAME,
    val currentVersionCode: Long = BuildConfig.VERSION_CODE.toLong(),
    val available: UpdateInfo? = null,
    val progressPercent: Int? = null,
    val message: String? = null,
)
