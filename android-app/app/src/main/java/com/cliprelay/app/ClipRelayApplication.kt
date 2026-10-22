package com.cliprelay.app

import android.app.Application
import android.app.Activity
import android.os.Bundle
import android.content.Context
import com.cliprelay.app.network.NetworkConnectionService
import com.limelight.computers.EmbeddedNetwork
import kotlinx.coroutines.flow.MutableStateFlow

class ClipRelayApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            private var started = 0
            override fun onActivityStarted(activity: Activity) { foreground.value = ++started > 0 }
            override fun onActivityStopped(activity: Activity) { started = (started - 1).coerceAtLeast(0); foreground.value = started > 0 }
            override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
        EmbeddedNetwork.provider = object : EmbeddedNetwork.Provider {
            override fun restore(context: Context) = NetworkConnectionService.restore(context)
            override fun ready() = NetworkConnectionService.state.value.ready
            override fun readyAddresses() = NetworkConnectionService.connections.value
                .filter { it.ready }.map { it.address }.toTypedArray()
        }
    }
    companion object { val foreground = MutableStateFlow(false) }
}
