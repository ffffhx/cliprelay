package com.cliprelay.app

import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.cliprelay.app.network.NetworkConnectionService
import com.cliprelay.app.service.ClipRelayService
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Uses the real Android services to verify shared-notification ownership on the device. */
@RunWith(AndroidJUnit4::class)
class BackgroundNotificationTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val manager = context.getSystemService(NotificationManager::class.java)

    @Test fun receiverStartsFirst() = checkLifecycle(ClipRelayService::class.java, NetworkConnectionService::class.java)

    @Test fun connectionStartsFirst() = checkLifecycle(NetworkConnectionService::class.java, ClipRelayService::class.java)

    private fun checkLifecycle(first: Class<out Service>, second: Class<out Service>) {
        assertTrue("Notification permission is required", manager.areNotificationsEnabled())
        val bindings = mutableListOf<ServiceConnection>()
        // Binding runs onCreate without changing saved receiver/connection preferences or pairing.
        context.stopService(Intent(context, first))
        context.stopService(Intent(context, second))
        awaitCount(0)
        try {
            val firstBinding = bind(first).also { bindings.add(it) }
            assertSingleNotification()
            val secondBinding = bind(second).also { bindings.add(it) }
            assertSingleNotification()

            context.unbindService(firstBinding)
            bindings.remove(firstBinding)
            SystemClock.sleep(500)
            assertSingleNotification()

            val restarted = bind(first).also { bindings.add(it) }
            assertSingleNotification()
            context.unbindService(secondBinding)
            bindings.remove(secondBinding)
            SystemClock.sleep(500)
            assertSingleNotification()

            context.unbindService(restarted)
            bindings.remove(restarted)
            awaitCount(0)
        } finally {
            bindings.forEach(context::unbindService)
        }
    }

    private fun bind(service: Class<out Service>): ServiceConnection {
        val ready = CountDownLatch(1)
        val binding = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) { ready.countDown() }
            override fun onNullBinding(name: ComponentName) { ready.countDown() }
            override fun onServiceDisconnected(name: ComponentName) = Unit
        }
        assertTrue(context.bindService(Intent(context, service), binding, Context.BIND_AUTO_CREATE))
        if (!ready.await(10, TimeUnit.SECONDS)) {
            context.unbindService(binding)
            fail("Service did not bind: ${service.simpleName}")
        }
        return binding
    }

    private fun backgroundNotifications() = manager.activeNotifications.filter {
        it.notification.channelId in setOf("cliprelay_receiver", "cliprelay_external_connection")
    }

    private fun awaitCount(count: Int) {
        val deadline = SystemClock.elapsedRealtime() + 10_000
        while (backgroundNotifications().size != count && SystemClock.elapsedRealtime() < deadline) {
            SystemClock.sleep(100)
        }
        assertEquals("Background notification count", count, backgroundNotifications().size)
    }

    private fun assertSingleNotification() {
        awaitCount(1)
        val notification = backgroundNotifications().single().notification
        assertEquals("ClipRelay", notification.extras.getString(Notification.EXTRA_TITLE))
        assertEquals("后台运行中", notification.extras.getString(Notification.EXTRA_TEXT))
        assertTrue(notification.flags and Notification.FLAG_FOREGROUND_SERVICE != 0)
        assertTrue(notification.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertNotNull(notification.contentIntent)
        assertTrue(notification.actions.isNullOrEmpty())
    }
}
