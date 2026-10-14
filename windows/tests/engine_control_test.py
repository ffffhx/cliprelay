"""Exercise a built Sunshine control extension in an isolated loopback fixture.

No service installation, real pairing, stream launch, desktop input or changes
to the user's Sunshine configuration. The short-lived test engine is detached
through WMI and is identified by both its executable and unique config path.
"""
import argparse
import base64
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
import urllib.request

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


def run(engine: Path, output: Path) -> None:
    engine = engine.resolve(strict=True)
    executable = engine / "sunshine.exe"
    if not executable.is_file() or not (engine / "assets/web/index.html").is_file():
        raise RuntimeError("A complete engine artifact with its runtime assets is required")
    fixture = output.resolve() / secrets.token_hex(12)
    fixture.mkdir(parents=True, exist_ok=False)
    config = fixture / "sunshine.conf"
    pidfile = fixture / "engine.pid"
    port = choose_port()
    password, salt = secrets.token_hex(32), secrets.token_hex(8)
    credentials = {"username": "cliprelay-test", "salt": salt,
                   "password": hashlib.sha256((password + salt).encode()).digest()[::-1].hex().upper()}
    (fixture / "credentials.json").write_text(json.dumps(credentials), encoding="utf-8")
    (fixture / "apps.json").write_text('{"env":{},"apps":[]}', encoding="utf-8")
    options = {
        "sunshine_name": "ClipRelay isolated engine test", "port": port, "bind_address": "127.0.0.1",
        "address_family": "ipv4", "origin_web_ui_allowed": "pc", "system_tray": "disabled",
        "upnp": "disabled", "controller": "disabled", "min_log_level": 2,
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

        def call(body=None, auth=True, refresh=False):
            request = urllib.request.Request(f"https://127.0.0.1:{port+1}/api/cliprelay/displays" + ("?refresh=1" if refresh else ""),
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
        for name in ("cakey.pem", "credentials.json"):
            (fixture / name).unlink(missing_ok=True)
        (fixture / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("engine", type=Path)
    parser.add_argument("--output", type=Path, default=Path(".tools/engine-control-tests"))
    args = parser.parse_args()
    if os.name != "nt":
        raise SystemExit("This test requires Windows")
    run(args.engine, args.output)
