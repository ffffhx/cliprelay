"""Exercise a built Sunshine control extension in an isolated loopback fixture.

No service installation, real pairing, desktop input or changes to the user's
Sunshine configuration. The optional stream receiver uses a temporary client
certificate and records only counters, never video/audio content. The short-lived
test engine is detached through WMI and identified by its executable and config.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import ssl
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET

POWERSHELL = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def powershell(script: str) -> str:
    encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-STA", "-NonInteractive", "-WindowStyle", "Hidden",
                             "-EncodedCommand", encoded], capture_output=True, text=True,
                            creationflags=subprocess.CREATE_NO_WINDOW, timeout=25, check=True)
    return result.stdout.strip()


def choose_port() -> int:
    for _ in range(100):
        port = 30000 + secrets.randbelow(28000)
        held = []
        try:
            for kind, offsets in ((socket.SOCK_STREAM, (-5, 0, 1, 21)), (socket.SOCK_DGRAM, (9, 10, 11, 13))):
                for offset in offsets:
                    probe = socket.socket(socket.AF_INET, kind)
                    held.append(probe)
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                    probe.bind(("127.0.0.1", port + offset))
            return port
        except OSError:
            pass
        finally:
            for probe in held:
                probe.close()
    raise RuntimeError("No unused test port range available")


def prepare_client(fixture: Path) -> str:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ClipRelay isolated stream test")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=1))
            .not_valid_after(now + datetime.timedelta(days=1)).sign(key, hashes.SHA256()))
    pem = cert.public_bytes(serialization.Encoding.PEM)
    (fixture / "client.pem").write_bytes(pem)
    (fixture / "client-key.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
    (fixture / "clients.json").write_text(json.dumps({"root": {"uniqueid": str(uuid.uuid4()),
        "named_devices": [{"name": "Isolated stream fixture", "uuid": str(uuid.uuid4()),
                           "cert": pem.decode(), "enabled": True}]}}), encoding="utf-8")
    return cert.fingerprint(hashes.SHA256()).hex()


def verify_stream(client: Path, fixture: Path, port: int, call, owner: str, bitrate_test: bool = False) -> dict:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.load_verify_locations(cafile=str(fixture / "cacert.pem"))
    context.load_cert_chain(str(fixture / "client.pem"), str(fixture / "client-key.pem"))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))

    def nvhttp(path, parameters=None):
        query = urllib.parse.urlencode(dict(parameters or {}, uniqueid="cliprelay-isolated-test", uuid=str(uuid.uuid4())))
        with opener.open(f"https://127.0.0.1:{port-5}/{path}?{query}", timeout=30) as response:
            body = response.read(65537)
            assert len(body) <= 65536
            root = ET.fromstring(body)
            assert root.get("status_code") == "200", f"{path}: {root.get('status_message')}"
            return root

    info = nvhttp("serverinfo")
    apps = nvhttp("applist")
    app_id = apps.findtext("App/ID")
    assert app_id and int(app_id) > 0, "Isolated desktop app is missing"
    key, key_id = secrets.token_hex(16), 1060
    launch = nvhttp("launch", {"appid": app_id, "mode": "1280x720x30", "sops": 0, "rikey": key,
        "rikeyid": key_id, "localAudioPlayMode": 1, "surroundAudioInfo": 196610,
        "remoteControllersBitmap": 0, "gcmap": 0, "gcpersist": 0, "corever": 1})
    assert launch.findtext("gamesession") == "1"
    state_file, stop_file = fixture / "received.json", fixture / "stop-client"
    iv = key_id.to_bytes(4, "big").hex() + "00" * 12
    log = (fixture / "client.log").open("w", encoding="utf-8")
    process = subprocess.Popen([str(client), info.findtext("appversion"), info.findtext("GfeVersion") or "3.23.0.74",
        launch.findtext("sessionUrl0"), key, iv, str(state_file), str(stop_file)] + (["--pattern"] if bitrate_test else []),
        cwd=client.parent, stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    switches = []
    state_read_retries = 0
    try:
        def receive_state():
            nonlocal state_read_retries
            deadline = time.monotonic() + .5
            while True:
                assert process.poll() is None, "Native stream client exited; inspect client.log"
                try:
                    return json.loads(state_file.read_text())
                except (FileNotFoundError, PermissionError, json.JSONDecodeError) as error:
                    if time.monotonic() >= deadline:
                        if isinstance(error, FileNotFoundError): return {}  # handshake has not completed yet
                        raise AssertionError("Receiver state remained unreadable for 500ms") from error
                    state_read_retries += 1
                    time.sleep(.01)

        def await_capture(target=None, previous=None, previous_received=None):
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                status, state = call()
                received = receive_state()
                assert status == 200
                if state["phase"] == "active" and state["capture"] and len(state["streams"]) == 1:
                    stream = state["streams"][0]
                    assert stream["owner"] == owner
                    if (stream["generation"] == state["generation"] and stream["firstFrame"] > 0 and
                            received.get("connected") and received.get("frames", 0) >= 3 and
                            received.get("lastFrame", 0) >= stream["firstFrame"] and
                            received.get("lastKeyframe", 0) > (previous_received or {}).get("lastFrame", 0) and
                            (target is None or state["capture"]["id"] == target) and
                            (previous is None or state["generation"] > previous["generation"])):
                        return state, received
                time.sleep(.15)
            raise AssertionError(f"No received real frame for {target}; inspect engine/client logs")

        state, received = await_capture()
        stream_id, instance, initial = state["streams"][0]["id"], state["instance"], state["capture"]["id"]
        bitrate_results = []
        if bitrate_test:
            assert received.get("pattern"), "Synthetic motion window was not created"
            status, _ = call(auth=False, endpoint="bitrate")
            assert status == 401
            _, rates = call(endpoint="bitrate")
            assert rates["instance"] == instance and len(rates["streams"]) == 1
            rate = rates["streams"][0]
            assert rate["owner"] == owner and rate["id"] == stream_id and rate["supported"]
            request = dict(instance=instance, owner=owner, stream=stream_id, revision=rate["revision"], budgetKbps=12000)
            for body, outcome in ((dict(request, owner="f" * 64), "not_streaming"),
                                  (dict(request, instance=str(uuid.uuid4())), "stale_instance"),
                                  (dict(request, revision=0), "stale")):
                status, reply = call(body, endpoint="bitrate")
                assert status == 200 and not reply["accepted"] and reply["outcome"] == outcome
            for body in (dict(request, budgetKbps=0), dict(request, budgetKbps=150001), dict(request, unknown=1)):
                assert call(body, endpoint="bitrate")[0] == 400

            for budget in (12000, 2000, 6000):
                _, rates = call(endpoint="bitrate")
                rate = rates["streams"][0]
                before_frame = receive_state()["lastFrame"]
                started = time.monotonic()
                status, result = call(dict(request, revision=rate["revision"], budgetKbps=budget), endpoint="bitrate")
                assert status == 200 and result["accepted"], result
                request_id = result["streams"][0]["requestId"]
                deadline = time.monotonic() + 8
                while time.monotonic() < deadline:
                    _, rates = call(endpoint="bitrate")
                    rate = rates["streams"][0]
                    received = receive_state()
                    assert rate["result"] != "failed", rate
                    if (rate["requestId"] == request_id and rate["result"] == "applied" and
                            rate["budgetKbps"] == budget and rate["appliedFrame"] > before_frame and
                            received.get("lastFrame", 0) >= rate["appliedFrame"]):
                        break
                    time.sleep(.05)
                else:
                    raise AssertionError(f"Bitrate {budget} did not produce a confirmed frame: {rate}")
                confirmed_seconds = round(time.monotonic() - started, 3)
                _, current = call()
                assert current["instance"] == instance and current["streams"][0]["id"] == stream_id
                assert current["generation"] == state["generation"] and current["capture"] == state["capture"]
                assert current["streams"][0]["firstFrame"] == state["streams"][0]["firstFrame"]
                time.sleep(1)  # settle the encoder's rate-control buffer
                sample = receive_state()
                sample_at = time.monotonic()
                while time.monotonic() - sample_at < 6:
                    received = receive_state()
                    assert received.get("connected") and not received.get("termination"), received
                    time.sleep(.1)
                received = receive_state()
                seconds = time.monotonic() - sample_at
                bitrate_results.append({"budgetKbps": budget, "videoKbps": rate["videoKbps"],
                    "payloadKbps": round((received["bytes"] - sample["bytes"]) * 8 / seconds / 1000, 1),
                    "confirmedSeconds": confirmed_seconds, "appliedFrame": rate["appliedFrame"],
                    "receivedFrames": received["frames"] - sample["frames"], "maxGapMs": received["maxGapMs"]})
                (fixture / "bitrate.json").write_text(json.dumps(bitrate_results, indent=2), encoding="utf-8")
            high, low, recovery = bitrate_results
            assert low["payloadKbps"] < high["payloadKbps"] * .5, bitrate_results
            assert recovery["payloadKbps"] > low["payloadKbps"] * 1.5, bitrate_results
            assert all(s["receivedFrames"] >= 90 and s["maxGapMs"] < 1000 for s in bitrate_results), bitrate_results
        targets = list(dict.fromkeys(state["displays"]))[:4]
        if targets and targets[-1] != initial: targets.append(initial)
        assert targets, "Active capture did not publish its display catalog"
        for target in targets:
            before = state
            before_received = received
            started = time.monotonic()
            for _ in range(4):
                _, state = call()
                status, result = call({"instance": instance, "revision": state["revision"], "display": target})
                assert status == 200
                if result["accepted"]: break
                assert result["outcome"] == "stale", result["outcome"]
            else:
                raise AssertionError("Display state never stabilized for selection")
            state, received = await_capture(target, before, before_received)
            assert state["instance"] == instance and state["streams"][0]["id"] == stream_id
            assert state["streams"][0]["firstFrame"] > before["streams"][0]["firstFrame"]
            switches.append({"display": target, "seconds": round(time.monotonic() - started, 3),
                "generation": state["generation"], "firstFrame": state["streams"][0]["firstFrame"],
                "receivedFrame": received["lastFrame"], "keyframe": received["lastKeyframe"], "capture": state["capture"]})
        if bitrate_test:
            _, rates = call(endpoint="bitrate")
            assert rates["streams"][0]["budgetKbps"] == 6000 and rates["streams"][0]["videoKbps"] == bitrate_results[-1]["videoKbps"]
        return {"sameConnection": True, "switches": switches, "receivedFrames": received["frames"],
                "decodedOrPresented": False, "bitrate": bitrate_results, "stateReadRetries": state_read_retries}
    finally:
        stop_file.touch()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        log.close()
        # Let the engine finish per-stream cleanup before its fixture is stopped.
        nvhttp("cancel")
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            status, state = call()
            if status == 200 and state["phase"] == "idle" and not state["streams"]:
                break
            time.sleep(.15)
        else:
            raise AssertionError("Isolated stream did not finish cleanup")


def run(engine: Path, output: Path, stream_client: Path | None = None, bitrate_test: bool = False) -> None:
    engine = engine.resolve(strict=True)
    executable = engine / "sunshine.exe"
    if not executable.is_file() or not (engine / "assets/web/index.html").is_file():
        raise RuntimeError("A complete engine artifact with its runtime assets is required")
    fixture = output.resolve() / secrets.token_hex(12)
    fixture.mkdir(parents=True, exist_ok=False)
    owner = prepare_client(fixture) if stream_client else None
    config = fixture / "sunshine.conf"
    pidfile = fixture / "engine.pid"
    port = choose_port()
    password, salt = secrets.token_hex(32), secrets.token_hex(8)
    credentials = {"username": "cliprelay-test", "salt": salt,
                   "password": hashlib.sha256((password + salt).encode()).digest()[::-1].hex().upper()}
    (fixture / "credentials.json").write_text(json.dumps(credentials), encoding="utf-8")
    (fixture / "apps.json").write_text(json.dumps({"env": {}, "apps":
        [{"name": "Isolated desktop fixture", "image-path": "desktop.png"}] if stream_client else []}), encoding="utf-8")
    options = {
        "sunshine_name": "ClipRelay isolated engine test", "port": port, "bind_address": "127.0.0.1",
        "address_family": "ipv4", "origin_web_ui_allowed": "pc", "system_tray": "disabled",
        "upnp": "disabled", "controller": "disabled", "mouse": "disabled", "keyboard": "disabled",
        "stream_audio": "disabled", "min_log_level": 2,
        "dd_configuration_option": "disabled", "file_apps": (fixture / "apps.json").as_posix(),
        "file_state": (fixture / "clients.json").as_posix(), "credentials_file": (fixture / "credentials.json").as_posix(),
        "pkey": (fixture / "cakey.pem").as_posix(), "cert": (fixture / "cacert.pem").as_posix(),
        "log_path": (fixture / "engine.log").as_posix(),
    }
    config.write_text("".join(f"{key} = {value}\n" for key, value in options.items()), encoding="utf-8")
    helper = f"""
$ErrorActionPreference = 'Stop'
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = {quote(str(executable))}
$start.Arguments = {quote(chr(34) + str(config) + chr(34))}
$start.WorkingDirectory = {quote(str(engine))}
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$child = [System.Diagnostics.Process]::Start($start)
[IO.File]::WriteAllText({quote(str(pidfile))}, [string]$child.Id)
"""
    helper_encoded = base64.b64encode(helper.encode("utf-16le")).decode("ascii")
    launch = f"""
$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
$startup.ShowWindow = 0
$command = {quote(POWERSHELL + ' -NoProfile -STA -WindowStyle Hidden -EncodedCommand ' + helper_encoded)}
$result = ([wmiclass]'Win32_Process').Create($command, {quote(str(engine))}, $startup)
if ($result.ReturnValue -ne 0) {{ throw 'Cannot launch isolated engine helper' }}
"""
    report = {"fixture": str(fixture), "engine": str(executable), "port": port, "passed": False}
    try:
        powershell(launch)
        deadline = time.monotonic() + 60
        cert = fixture / "cacert.pem"
        while time.monotonic() < deadline:
            if pidfile.exists() and cert.exists():
                try:
                    with socket.create_connection(("127.0.0.1", port + 1), timeout=.3):
                        break
                except OSError:
                    pass
            time.sleep(.15)
        else:
            raise RuntimeError(f"Engine did not start; inspect {fixture / 'engine.log'}")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False  # trust ONLY this fixture's generated certificate
        context.load_verify_locations(cafile=str(cert))
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))

        def call(body=None, auth=True, refresh=False, endpoint="displays"):
            assert endpoint in ("displays", "bitrate")
            request = urllib.request.Request(f"https://127.0.0.1:{port+1}/api/cliprelay/{endpoint}" + ("?refresh=1" if refresh else ""),
                                             data=None if body is None else json.dumps(body).encode())
            if auth:
                request.add_header("Authorization", "Basic " + base64.b64encode(("cliprelay-test:" + password).encode()).decode())
            if body is not None:
                request.add_header("Content-Type", "application/json")
            try:
                with opener.open(request, timeout=15) as response:
                    data = response.read(65537)
                    if len(data) > 65536: raise RuntimeError("Unbounded display response")
                    return response.status, json.loads(data)
            except urllib.error.HTTPError as error:
                error.close()
                return error.code, None

        status, _ = call(auth=False)
        assert status == 401, f"Anonymous display endpoint returned {status}"
        status, state = call()
        assert status == 200 and state["protocol"] == 1 and len(state["instance"]) == 36
        assert state["phase"] == "idle" and state["capture"] is None and state["streams"] == []
        status, state = call(refresh=True)
        assert status == 200 and len(state["displays"]) <= 64
        assert len(state["displays"]) == len(set(state["displays"]))
        selection = {"display": state["displays"][0] if state["displays"] else "missing",
                     "revision": state["revision"], "instance": state["instance"]}
        status, result = call(selection)
        assert status == 200 and result["accepted"] is False and result["outcome"] == "not_streaming"
        status, result = call(dict(selection, instance="00000000-0000-0000-0000-000000000000"))
        assert status == 200 and result["accepted"] is False and result["outcome"] == "stale_instance"
        status, _ = call(dict(selection, unrelated="rejected"))
        assert status == 400
        report.update(passed=True, scenarios=6, instance=state["instance"], displays=state["displays"])
        if stream_client:
            report["passed"] = False
            report["stream"] = verify_stream(stream_client.resolve(strict=True), fixture, port, call, owner, bitrate_test)
            report["passed"] = True
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        # Only terminate the uniquely identified test engine, never an installed service.
        stop = f"""
$engine = {quote(str(executable))}
$config = {quote(str(config))}
$matches = @(Get-CimInstance Win32_Process -Filter "Name = 'sunshine.exe'" | Where-Object {{
    $_.ExecutablePath -eq $engine -and $_.CommandLine -and $_.CommandLine.IndexOf($config, [StringComparison]::OrdinalIgnoreCase) -ge 0
}})
foreach ($process in $matches) {{ Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }}
"""
        powershell(stop)
        for name in ("cakey.pem", "credentials.json", "client-key.pem"):
            (fixture / name).unlink(missing_ok=True)
        (fixture / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("engine", type=Path)
    parser.add_argument("--output", type=Path, default=Path(".tools/engine-control-tests"))
    parser.add_argument("--stream-client", type=Path, help="Optional loopback-only native frame receiver")
    parser.add_argument("--bitrate-test", action="store_true", help="Show synthetic motion for a 25-second live bitrate test")
    args = parser.parse_args()
    if os.name != "nt":
        raise SystemExit("This test requires Windows")
    if args.bitrate_test and not args.stream_client:
        parser.error("--bitrate-test requires --stream-client")
    run(args.engine, args.output, args.stream_client, args.bitrate_test)
