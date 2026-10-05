package com.cliprelay.app

import android.content.ContextWrapper
import androidx.test.platform.app.InstrumentationRegistry
import com.limelight.binding.crypto.AndroidCryptoProvider
import com.limelight.nvstream.http.ComputerDetails
import com.limelight.nvstream.http.LanPairing
import com.limelight.nvstream.http.NvHTTP
import com.limelight.nvstream.http.PairingManager
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Opt-in real handshake using an isolated test identity; never launches a stream. */
class LanPairingLiveTest {
    @Test fun changedHostCertificateIsRejectedInsteadOfFallingBackToHttp() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("liveLanPairing") == "true")
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(target.cacheDir, "lan-mismatch-test").apply { mkdirs() }
        val crypto = AndroidCryptoProvider(object : ContextWrapper(target) { override fun getFilesDir() = directory })
        val address = ComputerDetails.AddressTuple(requireNotNull(args.getString("host")),48789)
        assertTrue(NvHTTP(address,48784,"qa",null,crypto).getComputerDetails(false).uuid.isNotBlank())
        try {
            NvHTTP(address,48784,"qa",crypto.clientCertificate,crypto).getServerInfo(false)
            fail("A different host certificate was accepted through HTTP fallback")
        } catch (expected: java.io.IOException) { }
    }

    @Test fun cancellationPreventsStartingAnotherHandshakeStep() {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val crypto = AndroidCryptoProvider(target)
        val http = NvHTTP(ComputerDetails.AddressTuple("127.0.0.1",48789),48784,"qa",null,crypto)
        http.cancelPairing()
        try {
            http.pairingManager.pair("<root status_code=\"200\"><appversion>7.1.0.0</appversion></root>","1234")
            fail("Pairing continued after cancellation")
        } catch (expected: java.io.InterruptedIOException) { }
    }

    @Test fun pairOnceThenReconnectWithSavedCertificate() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("liveLanPairing") == "true")
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(target.cacheDir, "lan-pair-live-identity").apply { mkdirs() }
        val isolated = object : ContextWrapper(target) { override fun getFilesDir() = directory }
        val crypto = AndroidCryptoProvider(isolated)
        val host = requireNotNull(args.getString("host"))
        val address = ComputerDetails.AddressTuple(host, 48789)
        val pin = PairingManager.generatePinString()
        val bootstrap = requireNotNull(LanPairing.begin(address, crypto, null, "ClipRelay LAN QA", pin))
        try {
            val http = NvHTTP(address, 0, "lan-qa", null, crypto)
            http.setLanPairingSession(bootstrap)
            val pairer = http.pairingManager
            assertEquals(PairingManager.PairState.PAIRED, pairer.pair(http.getServerInfo(true), pin, bootstrap.hostCertificate()))
            assertEquals(bootstrap.hostCertificate(), pairer.pairedCert)
            // Fresh crypto provider and HTTP connection stand in for a process
            // restart, with neither another approval nor a new PIN request.
            val reloaded = AndroidCryptoProvider(isolated)
            val savedCert = File(directory, "host.der").apply { writeBytes(pairer.pairedCert.encoded) }
            val cert = savedCert.inputStream().use {
                java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(it)
            } as java.security.cert.X509Certificate
            val reconnected = NvHTTP(address, 0, "lan-qa-restart", cert, reloaded)
            assertEquals(PairingManager.PairState.PAIRED, reconnected.pairState)
            assertTrue(reconnected.appList.any { it.appName == "Desktop" })
        } finally { bootstrap.close() }
    }
}
