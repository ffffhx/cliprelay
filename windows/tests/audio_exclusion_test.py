"""Read-only process-root validation using short-lived fixture processes."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

FLAGS = subprocess.CREATE_NO_WINDOW


def parent(executable, mode, result):
    child = subprocess.Popen([executable, mode, str(os.getpid()), result], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, creationflags=FLAGS)
    assert child.stdout.readline().strip() == "ready"
    print("ready", flush=True)
    assert sys.stdin.readline().strip() == "exit"
    # Exit without waiting: the child detects the exact held root's death.


def run(executable):
    executable = str(Path(executable).resolve(strict=True))
    subprocess.run([executable, "--self"], check=True, timeout=8, creationflags=FLAGS)
    subprocess.run([executable, "--check", str(os.getpid())], check=True, timeout=8, creationflags=FLAGS)
    with subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"], stdin=subprocess.PIPE, creationflags=FLAGS) as sibling:
        try:
            result = subprocess.run([executable, "--check", str(sibling.pid)], timeout=8, creationflags=FLAGS)
            assert result.returncode == 3, "Unrelated process accepted as exclusion root"
        finally:
            sibling.stdin.close()
            sibling.wait(timeout=5)
    with tempfile.TemporaryDirectory(prefix="cliprelay-audio-ancestry-") as directory:
        for mode in ("--watch", "--late"):
            result = str(Path(directory) / (mode[2:] + ".txt"))
            process = subprocess.Popen([sys.executable, __file__, "--parent", executable, mode, result],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, creationflags=FLAGS)
            try:
                assert process.stdout.readline().strip() == "ready"
                process.communicate("exit\n", timeout=5)
                assert process.returncode == 0
                until = time.monotonic() + 7
                while time.monotonic() < until:
                    if Path(result).exists() and Path(result).read_text() == "passed":
                        break
                    time.sleep(.05)
                else:
                    raise AssertionError("Parent death check failed: " + mode)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=3)
    print(json.dumps({"passed": True, "checks": ["self/default", "invalid PID", "duplicate initialization",
        "live ancestor", "unrelated sibling rejected", "held ancestor death", "already dead ancestor rejected"],
        "audioActivated": False}))


if __name__ == "__main__":
    if sys.argv[1] == "--parent":
        parent(*sys.argv[2:])
    else:
        run(sys.argv[1])
