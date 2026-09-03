package com.cliprelay.app.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build

class ClipRelayNsdPublisher(context: Context) {
    private val nsdManager = context.applicationContext.getSystemService(NsdManager::class.java)

    @Volatile
    private var activeRegistration: NsdManager.RegistrationListener? = null

    @Synchronized
    fun start(
        deviceId: String,
        deviceName: String,
        port: Int,
        requiresAuth: Boolean,
    ) {
        if (activeRegistration != null) return

        val serviceInfo = NsdServiceInfo().apply {
            serviceName = ClipRelayDiscovery.normalizeDeviceName(deviceName)
            serviceType = ClipRelayDiscovery.SERVICE_TYPE
            setPort(port)
            ClipRelayDiscovery.txtRecords(
                deviceId = deviceId,
                requiresAuth = requiresAuth,
                brand = Build.BRAND,
                model = Build.MODEL,
            ).forEach { (key, value) ->
                setAttribute(key, value)
            }
        }
        val registration = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(service: NsdServiceInfo) = Unit

            override fun onRegistrationFailed(service: NsdServiceInfo, errorCode: Int) {
                synchronized(this@ClipRelayNsdPublisher) {
                    if (activeRegistration === this) activeRegistration = null
                }
            }

            override fun onServiceUnregistered(service: NsdServiceInfo) = Unit

            override fun onUnregistrationFailed(service: NsdServiceInfo, errorCode: Int) = Unit
        }
        activeRegistration = registration
        runCatching {
            nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, registration)
        }.onFailure {
            if (activeRegistration === registration) activeRegistration = null
            throw it
        }
    }

    @Synchronized
    fun stop() {
        val registration = activeRegistration ?: return
        activeRegistration = null
        runCatching { nsdManager.unregisterService(registration) }
    }
}
