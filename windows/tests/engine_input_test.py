"""Verify real encrypted pause/resume acknowledgments without sending user input."""
import time


def verify_input_epochs(process, call, receive_state, instance, stream_id, owner, epochs, native_core=False):
    def state():
        status, value = call(endpoint="input")
        assert status == 200 and value["protocol"] == 1 and value["instance"] == instance
        assert len(value["streams"]) == 1
        current = value["streams"][0]
        assert current["id"] == stream_id and current["owner"] == owner and current["exclusive"]
        assert not current["closed"] and not current["failed"]
        return current

    def send(epoch, operation):
        assert process.poll() is None and process.stdin is not None
        process.stdin.write(epoch.to_bytes(4,"big") + operation.to_bytes(4,"big"))
        process.stdin.flush()

    if epochs[0] == 1:
        assert call(auth=False, endpoint="input")[0] == 401
        initial = state()
        assert not initial["enabled"] and initial["epoch"] == initial["acknowledged"] == 0
        send(1,2)  # Resume cannot activate the extension without a release boundary.
        time.sleep(.2)
        assert state() == initial
    results = []
    for epoch in epochs:
        before = receive_state()
        started = time.monotonic()
        send(epoch, 1 if epoch%2 else 2)
        deadline = started + 8
        while time.monotonic() < deadline:
            current = state()
            if current["epoch"] == current["acknowledged"] == epoch and not current["pending"]:
                assert current["enabled"] and current["paused"] == bool(epoch%2)
                break
            time.sleep(.03)
        else:
            raise AssertionError("Host input worker did not acknowledge the requested epoch")
        results.append({"epoch":epoch,"paused":current["paused"],"acknowledgmentMs":round((time.monotonic()-started)*1000)})
        if native_core:
            send(epoch,3)  # Only after exact authenticated host acknowledgment.
            local_deadline = time.monotonic()+4
            while time.monotonic()<local_deadline:
                if receive_state().get("inputLocalAcknowledged") == epoch:
                    break
                time.sleep(.03)
            else:
                raise AssertionError("Native input sender did not accept the verified host acknowledgment")
            results[-1]["localAcknowledgmentMs"] = round((time.monotonic()-started)*1000)
        if epoch == 3:
            send(2,2)  # Delayed resume from the previous cycle must not reopen input.
            time.sleep(.2)
            assert state() == current
        assert receive_state().get("connected") and before.get("connected")
    return results
