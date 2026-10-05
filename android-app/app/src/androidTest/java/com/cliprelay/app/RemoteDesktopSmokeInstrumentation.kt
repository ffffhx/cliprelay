package com.cliprelay.app

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.io.PrintWriter
import java.io.StringWriter
import java.util.regex.Pattern
import java.security.KeyPairGenerator
import java.security.Provider
import java.security.Signature
import java.security.cert.CertificateFactory

/** Platform-only runner: tests the actual minified APK without retaining AndroidX test-only APIs in it. */
class RemoteDesktopSmokeInstrumentation : Instrumentation() {
    private var connectionUi = false

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        connectionUi = arguments?.getString("connectionUi") == "true"
        start()
    }

    override fun onStart() {
        val result = Bundle()
        var screen: Activity? = null
        try {
            val provider = targetContext.classLoader
                .loadClass("org.bouncycastle.jce.provider.BouncyCastleProvider")
                .getDeclaredConstructor().newInstance() as Provider
            check(CertificateFactory.getInstance("X.509", provider).type == "X.509")
            val keys = KeyPairGenerator.getInstance("RSA", provider).apply { initialize(2048) }.generateKeyPair()
            val signer = Signature.getInstance("SHA256withRSA", provider)
            val message = "ClipRelay pairing provider smoke test".toByteArray()
            signer.initSign(keys.private)
            signer.update(message)
            val signature = signer.sign()
            signer.initVerify(keys.public)
            signer.update(message)
            check(signer.verify(signature))
            result.putBoolean("pairingCryptography", true)

            screen = startActivitySync(Intent().setClassName(targetContext.packageName, "com.limelight.PcView")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            SystemClock.sleep(3_000)
            waitForIdleSync()
            check(screen != null && !screen.isFinishing)
            result.putBoolean("embeddedComputerScreen", true)
            if (connectionUi) {
                checkConnectionForm()
                result.putBoolean("connectionValidationAndCancellation", true)
            }
            result.putString("stream", "PASS: release pairing cryptography and embedded computer screen" +
                (if (connectionUi) "; address validation, duplicate submit, cancellation and exit during a stalled connection" else "") + ".\n")
            finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) {
            val trace = StringWriter()
            error.printStackTrace(PrintWriter(trace))
            result.putString("stream", "FAIL: $trace\n")
            finish(Activity.RESULT_CANCELED, result)
        } finally {
            screen?.let { activity -> runOnMainSync { activity.finish() } }
        }
    }

    private fun checkConnectionForm() {
        // A local socket accepts connections but deliberately holds the response. This makes
        // cancellation deterministic without depending on the user's computer or public servers.
        val sockets = CopyOnWriteArrayList<Socket>()
        val accepted = AtomicInteger()
        val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        val acceptor = Thread({
            try {
                while (!server.isClosed) {
                    sockets += server.accept()
                    accepted.incrementAndGet()
                }
            } catch (_: java.io.IOException) { /* Closed by cleanup. */ }
        }, "ClipRelay stalled endpoint").apply { isDaemon = true; start() }
        var form: Activity? = null
        try {
            val activity = startActivitySync(Intent().setClassName(targetContext.packageName,
                "com.limelight.preferences.AddComputerManually").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            form = activity
            fun id(name: String) = targetContext.resources.getIdentifier(name, "id", targetContext.packageName)
            val input = activity.findViewById<EditText>(id("hostTextView"))
            val submit = activity.findViewById<Button>(id("addPcButton"))
            val cancel = activity.findViewById<View>(id("remoteCancelConnect"))
            val progress = activity.findViewById<View>(id("remoteConnectProgress"))
            val message = activity.findViewById<TextView>(id("remoteAddressMessage"))
            fun awaitUi(predicate: () -> Boolean) {
                val deadline = SystemClock.elapsedRealtime() + 4_000
                var ready = false
                while (!ready && SystemClock.elapsedRealtime() < deadline) {
                    runOnMainSync { ready = predicate() }
                    if (!ready) SystemClock.sleep(30)
                }
                check(ready) { "Timed out waiting for connection form" }
            }
            awaitUi { submit.isEnabled }
            runOnMainSync {
                input.setText("127.0.0.1:70000")
                submit.performClick()
                // Avoid Kotlin extension APIs which are stripped from the production APK.
                check(message.visibility == View.VISIBLE && Pattern.compile("65535").matcher(message.text).find())
                check(progress.visibility == View.GONE && accepted.get() == 0)
                input.setText("127.0.0.1:${server.localPort}")
                repeat(3) { submit.performClick() }
                check(!submit.isEnabled && progress.visibility == View.VISIBLE)
            }
            awaitUi { accepted.get() == 1 }
            SystemClock.sleep(200)
            check(accepted.get() == 1) { "Duplicate submissions opened multiple requests" }
            runOnMainSync {
                cancel.performClick()
                check(submit.isEnabled && input.isEnabled && progress.visibility == View.GONE)
            }
            // Let the cancelled request fail after the user has already returned to editing.
            sockets.forEach { it.close() }
            SystemClock.sleep(400)
            runOnMainSync {
                check(Pattern.compile("取消|cancelled").matcher(message.text).find())
                submit.performClick()
            }
            awaitUi { accepted.get() == 2 }
            val exitAt = SystemClock.elapsedRealtime()
            runOnMainSync { activity.finish() }
            waitForIdleSync()
            check(SystemClock.elapsedRealtime() - exitAt < 2_000) { "Leaving the form blocked on the network" }
        } finally {
            form?.let { activity -> runOnMainSync { if (!activity.isFinishing) activity.finish() } }
            server.close()
            acceptor.join(1_000)
            sockets.forEach { try { it.close() } catch (_: java.io.IOException) {} }
        }
    }
}
