package com.cliprelay.app

import android.app.ActivityManager
import android.content.Intent
import android.graphics.Bitmap
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.cliprelay.app.runtime.LegacyStreamTasks
import com.limelight.Game
import org.junit.Assert.*
import org.junit.Test

class LegacyStreamTasksTest {
    @Test fun upgradeRemovesOldStreamCardAndKeepsHome() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.getSystemService(ActivityManager::class.java)
        val size = manager.appTaskThumbnailSize
        val thumbnail = Bitmap.createBitmap(size.width, size.height, Bitmap.Config.ARGB_8888)
        var oldTaskId = -1
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { home ->
                    // Reproduce a persisted, inactive legacy stream card without
                    // connecting to a PC or injecting any remote input.
                    oldTaskId = manager.addAppTask(home,
                        Intent(context, Game::class.java)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK),
                        ActivityManager.TaskDescription("Legacy stream"), thumbnail)
                    assertTrue("Could not create a legacy recent task", oldTaskId >= 0)
                    assertTrue(manager.appTasks.any { it.taskInfo?.taskId == oldTaskId })

                    LegacyStreamTasks.remove(context)

                    assertFalse("Old stream card survived update", manager.appTasks.any { it.taskInfo?.taskId == oldTaskId })
                    assertTrue("Main card was removed", manager.appTasks.any { it.taskInfo?.taskId == home.taskId })
                    assertFalse(home.isFinishing)
                    // Repeated package broadcasts must be harmless.
                    LegacyStreamTasks.remove(context)
                    assertTrue(manager.appTasks.any { it.taskInfo?.taskId == home.taskId })
                }
            }
        } finally {
            manager.appTasks.firstOrNull { it.taskInfo?.taskId == oldTaskId }?.finishAndRemoveTask()
            thumbnail.recycle()
        }
    }
}
