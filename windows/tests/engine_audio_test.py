"""Measure the fixture's 1 kHz tone after encrypted transport and Opus decoding.

Only an existing non-default Steam virtual speaker is muted. No raw audio is
saved, no physical endpoint is changed, and recovery is independent of the child.
"""
import json
from pathlib import Path
import queue
import statistics
import subprocess
import threading
import time


def verify_audio(fixture: Path, helper: Path, call, receive_state):
    flags = subprocess.CREATE_NO_WINDOW

    def native(*args):
        return subprocess.check_output([str(helper), *args], text=True, encoding="utf-8", timeout=8, creationflags=flags)

    before = json.loads(native("--list"))
    status, initial = call()
    assert status == 200 and len(initial["streams"]) == 1
    stream_id, instance = initial["streams"][0]["id"], initial["instance"]
    engine_pid = int((fixture / "engine.pid").read_text().strip())
    process = subprocess.Popen([str(helper), "--tone-steam", str(engine_pid)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding="utf-8", creationflags=flags)
    messages = queue.Queue(maxsize=16)

    def read_lines():
        for line in iter(process.stdout.readline, ""):
            messages.put((time.monotonic(), json.loads(line)))
        messages.put((time.monotonic(), None))

    reader = threading.Thread(target=read_lines, daemon=True)
    reader.start()
    original = None
    report = {"passed": False, "stages": [], "physicalEndpointChanged": False, "rawAudioSaved": False,
        "fixtureCapturePid": engine_pid}
    journal = fixture / "tone-recovery.json"
    try:
        _, original = messages.get(timeout=5)
        assert original and original.get("ready") and original["mute"] is False
        journal.write_text(json.dumps(original) + "\n", encoding="utf-8")
        process.stdin.write("run\n")
        process.stdin.flush()
        generation = None
        for index, name in enumerate(("before", "muted", "restored")):
            started, message = messages.get(timeout=5)
            assert message and message.get("stage") == index, message
            tones, packets = [], []
            while time.monotonic() - started < 2.9:
                assert process.poll() is None, "Tone fixture exited early"
                status, state = call()
                received = receive_state()
                assert time.monotonic() - started < 3.3, "Audio measurements crossed a mute transition"
                assert status == 200 and state["instance"] == instance and len(state["streams"]) == 1
                stream = state["streams"][0]
                assert stream["id"] == stream_id
                audio = stream.get("audio", {})
                if time.monotonic() - started >= 1.25:
                    assert audio.get("capture") == "process" and audio.get("ready") and audio.get("generation", 0) > 0, audio
                    if generation is None:
                        generation = audio["generation"]
                    assert audio["generation"] == generation, "Mute restarted audio capture"
                    assert received.get("audioPackets", 0) > 0 and received.get("audioErrors") == 0, received
                    tones.append(received["audioTone"])
                    packets.append(received["audioPackets"])
                time.sleep(.15)
            assert len(tones) >= 4 and packets[-1] - packets[0] >= 50
            report["stages"].append({"stage": name, "tone": statistics.median(tones), "measurements": len(tones),
                "receivedPackets": packets[-1] - packets[0], "audioGeneration": generation})
        process.wait(timeout=5)
        _, final = messages.get(timeout=2)
        assert process.returncode == 0 and final and final.get("restored"), final
        amplitudes = [s["tone"] for s in report["stages"]]
        assert min(amplitudes) > .003 and max(amplitudes) < .008, amplitudes
        assert max(amplitudes) / min(amplitudes) < 1.1, amplitudes
        if (fixture / "host.pid").exists():
            report["hostExclusion"] = verify_host_exclusion(fixture, call, receive_state, instance, stream_id, generation, min(amplitudes))
        report.update(passed=True, sameStream=True, decodedAudio=True)
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=4)
        reader.join(timeout=1)
        report["toneExitCode"] = process.returncode
        report["toneError"] = process.stderr.read(4096).strip()
        if original and original.get("ready"):
            native("--restore-mute", "1" if original["mute"] else "0", original["id"])
            journal.unlink(missing_ok=True)
        after = json.loads(native("--list"))
        settings = lambda devices: [{k: v for k, v in d.items() if k != "activeSessions"} for d in devices]
        report.update(settingsRestored=settings(before) == settings(after), beforeDevices=before, afterDevices=after)
        report["passed"] = report["passed"] and report["settingsRestored"]
        (fixture / "audio-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    assert report["settingsRestored"]
    return report


def verify_host_exclusion(fixture, call, receive_state, instance, stream_id, generation, included_tone):
    # The fake host spawns this second tone as a sibling of the engine, matching
    # the production voice-worker ancestry. The first tone was outside its tree.
    def completed():
        try:
            return json.loads((fixture / "owned-tone.report.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    (fixture / "owned-tone.start").touch()
    deadline = time.monotonic() + 6
    while not (fixture / "owned-tone.started").exists():
        failed = completed()
        assert not failed, failed
        assert time.monotonic() < deadline, "Owned tone did not start"
        time.sleep(.05)
    started = time.monotonic()
    tones, packets = [], []
    try:
        while time.monotonic() - started < 8:
            status, state = call()
            received = receive_state()
            assert status == 200 and state["instance"] == instance and len(state["streams"]) == 1
            stream = state["streams"][0]
            assert stream["id"] == stream_id and stream["audio"]["generation"] == generation
            assert stream["audio"]["capture"] == "process" and stream["audio"]["ready"]
            assert received.get("audioErrors") == 0
            if time.monotonic() - started >= 2:
                tones.append(received["audioTone"])
                packets.append(received["audioPackets"])
            time.sleep(.2)
        assert len(tones) >= 10 and packets[-1] - packets[0] >= 300
        assert max(tones) < included_tone * .05, f"Host voice-worker tone leaked into stream: {max(tones)}"
    finally:
        # Let the bounded child restore its virtual endpoint before the outer
        # inventory check, even when an audio assertion fails.
        while completed() is None and time.monotonic() - started < 17:
            time.sleep(.1)
    tone_result = completed()
    assert tone_result and tone_result["passed"] and tone_result["restored"], tone_result
    return {"passed": True, "externalToneAmplitude": included_tone, "excludedToneMax": max(tones),
        "measurements": len(tones), "receivedPackets": packets[-1] - packets[0],
        "sameStream": True, "sameAudioGeneration": True, "ownedTone": tone_result}
