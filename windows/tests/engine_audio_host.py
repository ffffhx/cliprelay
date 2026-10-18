"""Bounded fake host: engine and a synthetic voice worker share this parent.

Only the caller's unique fixture directory is used. No service installation,
physical audio changes, general command input, or raw audio recording.
"""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import time

FLAGS = subprocess.CREATE_NO_WINDOW


def owned_tone(fixture, helper, engine_pid):
    process = subprocess.Popen([str(helper), "--tone-steam", str(engine_pid)], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", creationflags=FLAGS)
    messages = queue.Queue(maxsize=1)
    reader = threading.Thread(target=lambda: messages.put(process.stdout.readline()), daemon=True)
    reader.start()
    original = None
    journal = fixture / "owned-tone-recovery.json"
    result = {"passed": False, "tonePid": process.pid}
    try:
        original = json.loads(messages.get(timeout=5))
        assert original.get("ready") and original["mute"] is False
        journal.write_text(json.dumps(original), encoding="utf-8")
        process.stdin.write("run\n")
        process.stdin.flush()
        (fixture / "owned-tone.started").write_text(str(process.pid), encoding="utf-8")
        stdout, stderr = process.communicate(timeout=15)
        records = [json.loads(line) for line in stdout.splitlines() if line]
        assert process.returncode == 0 and records[-1].get("restored"), stderr
        assert [row.get("stage") for row in records[:-1]] == [0, 1, 2]
        result.update(passed=True, restored=True)
    except Exception as error:
        result["error"] = f"{type(error).__name__}: {error}"
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=4)
        reader.join(timeout=1)
        if original and original.get("ready"):
            try:
                subprocess.run([str(helper), "--restore-mute", "1" if original["mute"] else "0", original["id"]],
                    check=True, timeout=8, creationflags=FLAGS, capture_output=True)
                journal.unlink(missing_ok=True)
            except Exception as error:
                result.update(passed=False, recoveryError=str(error))
        (fixture / "owned-tone.report.json").write_text(json.dumps(result), encoding="utf-8")


def run(executable, config, fixture, helper):
    executable, config, fixture, helper = map(Path, (executable, config, fixture, helper))
    with config.open("a", encoding="utf-8") as output:
        output.write(f"cliprelay_audio_exclude_pid = {os.getpid()}\n")
    (fixture / "host.pid").write_text(str(os.getpid()), encoding="utf-8")
    process = subprocess.Popen([str(executable), str(config)], cwd=executable.parent, creationflags=FLAGS)
    (fixture / "engine.pid").write_text(str(process.pid), encoding="utf-8")
    deadline = time.monotonic() + 180
    ran_tone = False
    try:
        while time.monotonic() < deadline and process.poll() is None and not (fixture / "host.stop").exists():
            if not ran_tone and (fixture / "owned-tone.start").exists():
                ran_tone = True
                owned_tone(fixture, helper, process.pid)
            time.sleep(.05)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=8)
        (fixture / "host.done").write_text("stopped", encoding="utf-8")


if __name__ == "__main__":
    run(*sys.argv[1:])
