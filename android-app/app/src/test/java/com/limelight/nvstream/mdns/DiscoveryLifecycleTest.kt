package com.limelight.nvstream.mdns

import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.jmdns.ServiceListener
import org.junit.Assert.*
import org.junit.Test

class DiscoveryLifecycleTest {
    private class Resolver : JmDNSDiscoveryAgent.Resolver {
        val closed = AtomicInteger()
        @Volatile var callback: ServiceListener? = null
        override fun listen(listener: ServiceListener) { callback = listener }
        override fun close() { closed.incrementAndGet() }
    }
    private class Environment : JmDNSDiscoveryAgent.Environment {
        @Volatile var addresses = setOf(InetAddress.getByName("192.0.2.1"))
        val opened = CopyOnWriteArrayList<Resolver>()
        val held = AtomicInteger()
        var createGate: CountDownLatch? = null
        val creating = CountDownLatch(1)
        override fun addresses() = addresses
        override fun acquire() { held.incrementAndGet() }
        override fun release() { held.decrementAndGet() }
        override fun open(address: InetAddress): JmDNSDiscoveryAgent.Resolver {
            creating.countDown()
            // Reproduce a library that consumes InterruptedException while opening a socket.
            createGate?.let { gate -> while (gate.count > 0) try { gate.await() } catch (_: InterruptedException) { } }
            return Resolver().also { opened += it }
        }
    }
    private fun agent(env: Environment) = JmDNSDiscoveryAgent(object : MdnsDiscoveryListener {
        override fun notifyComputerAdded(computer: MdnsComputer) = fail("Stopped resolver delivered a stale computer")
        override fun notifyDiscoveryFailure(error: Exception) = throw AssertionError(error)
    }, env)
    private fun await(condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(4)
        while (!condition() && System.nanoTime() < deadline) Thread.sleep(5)
        assertTrue("Discovery resources did not settle", condition())
    }
    @Test fun stoppedScanClosesLateCreatedResolverEvenWhenInterruptWasConsumed() {
        val env = Environment().apply { createGate = CountDownLatch(1) }
        val agent = agent(env)
        try {
            agent.startDiscovery(1000)
            assertTrue(env.creating.await(2, TimeUnit.SECONDS))
            agent.stopDiscovery()
            env.createGate!!.countDown()
            await { env.opened.size == 1 && env.opened[0].closed.get() == 1 && env.held.get() == 0 }
            assertNull(env.opened[0].callback)
        } finally { env.createGate!!.countDown(); agent.stopDiscovery() }
    }
    @Test fun repeatedStartsCloseEveryGenerationAndRejectLateCallbacks() {
        val env = Environment()
        val agent = agent(env)
        try {
            repeat(5) { count ->
                agent.startDiscovery(1000)
                await { env.opened.size == count + 1 && env.opened.last().callback != null }
            }
            agent.stopDiscovery()
            await { env.held.get() == 0 && env.opened.all { it.closed.get() == 1 } }
            env.opened.forEach { it.callback!!.serviceResolved(null) }
            agent.stopDiscovery()
            assertTrue(env.opened.all { it.closed.get() == 1 })
        } finally { agent.stopDiscovery() }
    }
    @Test fun interfaceRemovalClosesOldSocketsWhileNewInterfaceIsDiscovered() {
        val env = Environment()
        val agent = agent(env)
        try {
            agent.startDiscovery(1000)
            await { env.opened.size == 1 }
            env.addresses = setOf(InetAddress.getByName("192.0.2.2"))
            await { env.opened.size == 2 && env.opened[0].closed.get() == 1 }
            env.addresses = emptySet()
            await { env.opened[1].closed.get() == 1 }
        } finally { agent.stopDiscovery() }
        await { env.held.get() == 0 }
    }
    @Test fun stopDoesNotWaitForAnInFlightNetworkCallback() {
        val env = Environment()
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val stopped = CountDownLatch(1)
        val agent = object : JmDNSDiscoveryAgent(object : MdnsDiscoveryListener {
            override fun notifyComputerAdded(computer: MdnsComputer) = Unit
            override fun notifyDiscoveryFailure(error: Exception) = throw AssertionError(error)
        }, env) {
            override fun reportNewComputer(name: String, port: Int, v4: Array<java.net.Inet4Address>, v6: Array<java.net.Inet6Address>) {
                entered.countDown()
                release.await(5, TimeUnit.SECONDS)
            }
        }
        val event = object : javax.jmdns.ServiceEvent(Any()) {
            override fun getDNS(): javax.jmdns.JmDNS? = null
            override fun getType() = "_nvstream._tcp.local."
            override fun getName() = "fixture"
            override fun getInfo() = javax.jmdns.ServiceInfo.create(type, name, 47989, "")
        }
        var callback: Thread? = null
        var stop: Thread? = null
        try {
            agent.startDiscovery(1000)
            await { env.opened.singleOrNull()?.callback != null }
            callback = Thread { env.opened[0].callback!!.serviceResolved(event) }.also { it.start() }
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            stop = Thread { agent.stopDiscovery(); stopped.countDown() }.also { it.start() }
            assertTrue("Leaving the UI must not wait for a discovery listener's network I/O", stopped.await(500, TimeUnit.MILLISECONDS))
            env.opened[0].callback!!.serviceResolved(null) // A callback arriving after stop is discarded.
        } finally {
            release.countDown(); callback?.join(2000); stop?.join(2000); agent.stopDiscovery()
        }
        await { env.held.get() == 0 && env.opened.all { it.closed.get() == 1 } }
    }
}
