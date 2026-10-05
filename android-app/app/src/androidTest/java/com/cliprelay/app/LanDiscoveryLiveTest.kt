package com.cliprelay.app

import android.content.ContextWrapper
import android.database.sqlite.SQLiteDatabase
import androidx.test.platform.app.InstrumentationRegistry
import com.limelight.binding.crypto.AndroidCryptoProvider
import com.limelight.computers.ComputerDatabaseManager
import com.limelight.nvstream.http.ComputerDetails
import com.limelight.nvstream.http.NvHTTP
import com.limelight.nvstream.mdns.ClipRelayDiscoveryAgent
import com.limelight.nvstream.mdns.MdnsComputer
import com.limelight.nvstream.mdns.MdnsDiscoveryListener
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class LanDiscoveryLiveTest {
    @Test fun discoversTheComputerWithoutAnAddressOrSavedList() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("liveLanDiscovery") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val result = AtomicReference<ComputerDetails>()
        val done = CountDownLatch(1)
        val agent = ClipRelayDiscoveryAgent(context, object : MdnsDiscoveryListener {
            override fun notifyComputerAdded(computer: MdnsComputer) {
                try {
                    val host = computer.localAddress ?: computer.ipv6Address ?: return
                    val http = NvHTTP(ComputerDetails.AddressTuple(host.hostAddress!!, computer.port),0,"discovery-qa",null,AndroidCryptoProvider(context))
                    val details = http.getComputerDetails(false)
                    if (details.name.startsWith("ClipRelay - ")) { result.set(details); done.countDown() }
                } catch (_: Exception) { }
            }
            override fun notifyDiscoveryFailure(error: Exception) { }
        })
        try {
            agent.startDiscovery(1500)
            assertTrue("No computer discovered without a supplied address",done.await(40,TimeUnit.SECONDS))
            assertFalse(result.get().uuid.isBlank())
        } finally { agent.close() }
    }

    @Test fun addressChangesPreserveSavedPairingAndDoNotDuplicateComputer() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.cacheDir,"lan-db-qa").apply { mkdirs() }
        val isolated = object : ContextWrapper(context) {
            override fun getFilesDir() = directory
            override fun getDatabasePath(name: String) = File(directory,name)
            override fun openOrCreateDatabase(name:String, mode:Int, factory:SQLiteDatabase.CursorFactory?) = SQLiteDatabase.openOrCreateDatabase(getDatabasePath(name),factory)
            override fun deleteDatabase(name: String) = SQLiteDatabase.deleteDatabase(getDatabasePath(name))
        }
        val certificate = AndroidCryptoProvider(isolated).clientCertificate
        val original = ComputerDetails().apply {
            uuid="lan-database-test";name="Test computer"
            localAddress=ComputerDetails.AddressTuple("192.0.2.10",48789)
            embeddedAddress=ComputerDetails.AddressTuple("127.0.0.2",48789)
            serverCert=certificate
        }
        ComputerDatabaseManager(isolated).also { db -> db.updateComputer(original);db.close() }
        val moved = ComputerDetails().apply {
            uuid=original.uuid;name=original.name
            localAddress=ComputerDetails.AddressTuple("192.0.2.20",48789)
        }
        ComputerDatabaseManager(isolated).also { db ->
            val saved=db.getComputerByUUID(original.uuid);saved.update(moved);db.updateComputer(saved);db.close()
        }
        ComputerDatabaseManager(isolated).also { db ->
            try {
                val saved=db.allComputers.single()
                assertEquals("192.0.2.20",saved.localAddress.address)
                assertEquals("127.0.0.2",saved.embeddedAddress.address)
                assertEquals(certificate,saved.serverCert)
            } finally { db.close() }
        }
    }
}
