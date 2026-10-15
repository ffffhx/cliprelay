"""Apply the reviewed ClipRelay extension to exactly the pinned Sunshine source."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def prepare(source: Path, check: bool = False) -> None:
    extension = Path(__file__).resolve().parents[1] / "engine" / "sunshine"
    pinned = json.loads((extension / "upstream.json").read_text(encoding="utf-8"))
    source = source.resolve(strict=True)

    def git(*args: str) -> str:
        return subprocess.check_output(["git", "-C", str(source), *args], text=True).strip()

    if git("rev-parse", "HEAD") != pinned["commit"]:
        raise RuntimeError("Sunshine checkout does not match the pinned commit")
    if git("diff", "HEAD", "--", "src", "cmake", "tools", "tests"):
        raise RuntimeError("Refusing to patch an already modified Sunshine source tree")
    headers = ["cliprelay_control.h", "cliprelay_audio.h", "cliprelay_input.h"]
    if any((source / "src" / name).exists() for name in headers):
        raise RuntimeError("Refusing to replace an existing ClipRelay header")
    input_test = source / "tests/unit/test_cliprelay_input.cpp"
    if input_test.exists():
        raise RuntimeError("Refusing to replace an existing ClipRelay input test")
    patch = extension / "control.patch"
    # A Windows archive/checkout may carry CRLF even when the upstream tree is LF.
    # Normalize the patch syntax without changing the caller's source files.
    with tempfile.TemporaryDirectory(prefix="cliprelay-sunshine-") as temporary:
        normalized = Path(temporary) / "control.patch"
        normalized.write_bytes(patch.read_bytes().replace(b"\r\n", b"\n"))
        git("apply", "--check", str(normalized))
        if not check:
            git("apply", str(normalized))
            for name in headers:
                shutil.copyfile(extension / name, source / "src" / name)
            shutil.copyfile(extension / "input_integration_test.cpp", input_test)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    prepare(args.source, args.check)
    print("Pinned Sunshine patch verified" if args.check else "Pinned Sunshine patch applied")
