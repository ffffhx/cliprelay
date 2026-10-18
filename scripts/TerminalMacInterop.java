import com.limelight.terminal.TerminalProtocol;
import com.limelight.terminal.TerminalSessionState;
import com.limelight.terminal.TerminalMouseState;
import org.json.JSONObject;
import javax.net.ssl.*;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.*;

/** CI-only TLS adapter exercising the shipped Android protocol/state classes.
 * Does not claim Android Activity, WebView or NvHTTP/device acceptance. */
public final class TerminalMacInterop {
    private final SSLSocketFactory tls;
    private final String mouseCommand;
    private TerminalSessionState state;
    private final ByteArrayOutputStream output = new ByteArrayOutputStream();

    private TerminalMacInterop(JSONObject config) throws Exception {
        Path directory = Path.of(config.getString("state"));
        X509Certificate cert;
        try (InputStream input = Files.newInputStream(directory.resolve("cacert.pem"))) {
            cert = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(input);
        }
        String pem = Files.readString(directory.resolve("cakey.pem"));
        byte[] der = Base64.getDecoder().decode(pem.replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "").replaceAll("\\s", ""));
        PrivateKey key = KeyFactory.getInstance("RSA").generatePrivate(new PKCS8EncodedKeySpec(der));
        KeyStore keys = KeyStore.getInstance("PKCS12"); keys.load(null, null);
        keys.setKeyEntry("client", key, new char[0], new java.security.cert.Certificate[]{cert});
        KeyManagerFactory km = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        km.init(keys, new char[0]);
        KeyStore trust = KeyStore.getInstance("PKCS12"); trust.load(null, null); trust.setCertificateEntry("host", cert);
        TrustManagerFactory tm = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()); tm.init(trust);
        SSLContext context = SSLContext.getInstance("TLS"); context.init(km.getKeyManagers(), tm.getTrustManagers(), null);
        tls = context.getSocketFactory(); mouseCommand = config.getString("mouseCommand");
    }

    private static void check(boolean condition, String reason) {
        if (!condition) throw new AssertionError(reason);
    }

    private static final class ReadBusy extends IOException {
        ReadBusy() { super("TERMINAL_BUSY"); }
    }

    private TerminalProtocol.Reply rpc(JSONObject command) throws Exception {
        // The host's authorization refresh shares the terminal controller lock.
        // Retry only an explicitly rejected read, with the same offset and a
        // bounded window. Mutations and all other errors retain their verdict.
        long deadline = System.nanoTime() + 2000000000L;
        while (true) {
            try { return rpcOnce(command); }
            catch (ReadBusy busy) {
                if (System.nanoTime() >= deadline) throw busy;
                Thread.sleep(50);
            }
        }
    }

    private TerminalProtocol.Reply rpcOnce(JSONObject command) throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) URI.create("https://127.0.0.1:48791/v1/terminal").toURL().openConnection();
        connection.setSSLSocketFactory(tls); // Standard certificate and IP SAN verification remain enabled.
        connection.setConnectTimeout(5000); connection.setReadTimeout(10000);
        connection.setRequestMethod("POST"); connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        byte[] body = command.toString().getBytes(StandardCharsets.UTF_8); connection.setFixedLengthStreamingMode(body.length);
        try {
            try (OutputStream stream = connection.getOutputStream()) { stream.write(body); }
            int status = connection.getResponseCode();
            byte[] raw;
            try (InputStream input = status == 200 ? connection.getInputStream() : connection.getErrorStream()) {
                raw = input.readNBytes(65537);
            }
            check(raw.length <= 65536, "unbounded terminal response");
            JSONObject value = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            if (command.optString("op").equals("read") && status == 429
                    && value.optString("code").equals("TERMINAL_BUSY")) throw new ReadBusy();
            TerminalProtocol.checkHttp(status, value);
            return new TerminalProtocol.Reply(command, value);
        } finally { connection.disconnect(); }
    }

    private String read() throws Exception {
        TerminalProtocol.Reply reply = rpc(state.read());
        state.consume(reply); output.write(reply.data);
        check(output.size() <= 2 * 1024 * 1024, "unbounded test output");
        return output.toString(StandardCharsets.UTF_8);
    }

    private interface Condition { boolean test() throws Exception; }
    private void until(Condition condition, long seconds) throws Exception {
        long deadline = System.nanoTime() + seconds * 1000000000L;
        while (System.nanoTime() < deadline) {
            if (condition.test()) return;
            Thread.sleep(30);
        }
        throw new AssertionError("Android protocol/native Mac condition timed out");
    }

    private void input(String text, boolean loseReply) throws Exception {
        check(state.enqueue(text.getBytes(StandardCharsets.UTF_8)), "input queue refused command");
        JSONObject command = state.write();
        TerminalProtocol.Reply first = rpc(command);
        if (loseReply) {
            check(state.uncertain(), "lost reply discarded pending input");
            JSONObject retry = state.write();
            check(command.similar(retry), "retry changed command bytes or sequence");
            first = rpc(retry);
        }
        state.acknowledge(first);
        check(!state.hasInput(), "confirmed command remained queued");
    }

    private void mouse(String action, int column, int row, boolean loseReply) throws Exception {
        TerminalMouseState queue = state.mouse;
        queue.enqueue(new TerminalMouseState.Event(action, queue.snapshot.epoch, queue.revision(), column, row, 0, 0));
        JSONObject command = queue.command(state.instance, state.id);
        check(command != null, "mouse command missing");
        TerminalProtocol.Reply reply = rpc(command);
        if (loseReply) {
            JSONObject retry = queue.command(state.instance, state.id);
            check(command.similar(retry), "mouse retry changed gesture or sequence");
            reply = rpc(retry);
        }
        queue.acknowledge(reply); state.refresh(reply.instance, reply.session);
        long sequence = command.getLong("sequence");
        until(() -> { read(); return state.snapshot.mouse.written >= sequence; }, 3);
    }

    private void run() throws Exception {
        TerminalProtocol.Reply inventory = rpc(TerminalProtocol.list());
        check(inventory.shells.equals(Arrays.asList("zsh", "bash")) && inventory.mouseProtocol == 1, "Mac inventory mismatch");
        for (String shell : Arrays.asList("bash", "zsh")) {
            inventory = rpc(TerminalProtocol.list());
            String id = UUID.randomUUID().toString().replace("-", "");
            JSONObject open = TerminalProtocol.request("open", inventory.instance, id).put("shell", shell)
                    .put("columns", 100).put("rows", 30).put("sequence", inventory.nextOpen);
            TerminalProtocol.Reply first = rpc(open), again = rpc(open);
            check(first.session.openSequence == again.session.openSequence, "duplicate open changed session");
            state = new TerminalSessionState(first.instance, first.session); output.reset();
            try {
                String marker = "android-" + shell + "-中文-👋", encoded = "";
                for (byte value : marker.getBytes(StandardCharsets.UTF_8)) encoded += String.format("\\%03o", value & 255);
                input("printf '\\n" + encoded + "\\n'\r", true);
                until(() -> read().contains(marker) && state.snapshot.written == 1, 8);
                String observed = output.toString(StandardCharsets.UTF_8);
                check(observed.indexOf(marker) == observed.lastIndexOf(marker), "retried input executed twice");
                // Reconstruct state as after a client reconnect, resume at the confirmed byte offset.
                TerminalSessionState previous = state;
                TerminalProtocol.Reply fresh = rpc(TerminalProtocol.list());
                state = new TerminalSessionState(fresh.instance, fresh.find(id)); state.offset = previous.offset;
                read(); check(state.offset >= previous.offset, "reconnect moved output backward");
                TerminalProtocol.Reply resized = rpc(TerminalProtocol.request("resize", state.instance, id).put("columns", 120).put("rows", 40));
                state.refresh(resized.instance, resized.session);
                input(mouseCommand, false);
                until(() -> { read(); return state.snapshot.mouse.mode == 1002; }, 8);
                mouse("press", 5, 7, true); mouse("move", 6, 8, false);
                state.mouse.stop(); // Client stops renewing; actual native lease must release.
                String captured = "HTTP_MOUSE_CAPTURE_" + Base64.getEncoder().encodeToString(
                        "\u001b[<0;5;7M\u001b[<32;6;8M\u001b[<0;6;8m".getBytes(StandardCharsets.UTF_8)) + "_END";
                until(() -> read().contains(captured) && state.snapshot.mouse.buttons == 0, 5);
                input("head -c 1200000 /dev/zero | tr '\\000' a\r", false);
                until(() -> rpc(TerminalProtocol.list()).find(id).end > state.offset + 1100000, 8);
                TerminalProtocol.Reply gap = rpc(state.read());
                check(gap.gap && gap.offset > state.offset, "lost output was not reported");
                state.consume(gap);
            } finally {
                TerminalProtocol.Reply closed = rpc(TerminalProtocol.request("close", state.instance, id));
                state.refresh(closed.instance, closed.session); check(!state.snapshot.running(), "native shell remained running");
            }
        }
        System.out.println(new JSONObject().put("passed", true).put("shells", Arrays.asList("bash", "zsh"))
                .put("lostReplies", true).put("mouseExpiry", true).put("reconnectAndGap", true));
    }

    public static void main(String[] args) throws Exception {
        check("true".equals(System.getenv("CI")) && System.getProperty("os.name").equals("Mac OS X"), "disposable Mac CI required");
        byte[] input = System.in.readNBytes(65537); check(input.length <= 65536, "unbounded configuration");
        new TerminalMacInterop(new JSONObject(new String(input, StandardCharsets.UTF_8))).run();
    }
}
