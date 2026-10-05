package com.cliprelay.app.runtime

import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import com.limelight.Game
import com.limelight.LimeLog

/** Remove the separate stream cards retained by Android across an APK update. */
object LegacyStreamTasks {
    fun remove(context: Context) {
        val manager = context.getSystemService(ActivityManager::class.java) ?: return
        val oldRoot = ComponentName(context, Game::class.java)
        try {
            for (task in manager.appTasks) {
                try {
                    // The former .stream task has Game as its base component.
                    // Keep the shared MainActivity/PcView task and any activity
                    // already relaunched before this update broadcast arrived.
                    val info = task.taskInfo ?: continue
                    if (info.numActivities == 0 && info.baseIntent.component == oldRoot) {
                        task.finishAndRemoveTask()
                    }
                } catch (_: IllegalArgumentException) {
                    // A task can disappear while Android is processing the update.
                }
            }
        } catch (_: RuntimeException) {
            LimeLog.warning("Unable to remove a legacy stream task after update")
        }
    }
}
