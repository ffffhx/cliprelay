package com.cliprelay.app

import android.app.Application
import android.content.Context
import com.cliprelay.app.network.NetworkConnectionService
import com.limelight.computers.EmbeddedNetwork

class ClipRelayApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        EmbeddedNetwork.provider = object : EmbeddedNetwork.Provider {
            override fun restore(context: Context) = NetworkConnectionService.restore(context)
            override fun ready() = NetworkConnectionService.state.value.ready
        }
    }
}
