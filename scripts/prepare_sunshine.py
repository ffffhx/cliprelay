"""Apply the reviewed ClipRelay extension to exactly the pinned Sunshine source."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def prepare(source: Path, check: bool = False, macos_host: bool = False) -> None:
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
    if macos_host:
        headers.extend(["cliprelay_macos.h", "cliprelay_capture.h"])
    if any((source / "src" / name).exists() for name in headers):
        raise RuntimeError("Refusing to replace an existing ClipRelay header")
    input_test = source / "tests/unit/test_cliprelay_input.cpp"
    if input_test.exists():
        raise RuntimeError("Refusing to replace an existing ClipRelay input test")
    macos_test = source / "tests/unit/test_cliprelay_macos_mouse.cpp"
    if macos_host and macos_test.exists():
        raise RuntimeError("Refusing to replace an existing ClipRelay macOS mouse test")
    capture_test = source / "tests/unit/test_cliprelay_macos_capture.mm"
    if macos_host and capture_test.exists():
        raise RuntimeError("Refusing to replace an existing ClipRelay macOS capture test")
    patches = [(source, "control.patch")]
    if macos_host:
        hid = source / "third-party/libvirtualhid"
        # The exact pinned parent commit owns the libvirtualhid gitlink too.
        pinned_hid = git("ls-tree", "HEAD", "third-party/libvirtualhid").split()[2]
        actual_hid = subprocess.check_output(["git", "-C", str(hid), "rev-parse", "HEAD"], text=True).strip()
        if actual_hid != pinned_hid:
            raise RuntimeError("libvirtualhid checkout does not match the pinned gitlink")
        if subprocess.check_output(["git", "-C", str(hid), "diff", "HEAD"], text=True):
            raise RuntimeError("Refusing to patch an already modified libvirtualhid source tree")
        patches += [(source, "macos-control.patch"), (hid, "libvirtualhid-macos.patch")]
    # A Windows archive/checkout may carry CRLF even when the upstream tree is LF.
    # Normalize the patch syntax without changing the caller's source files.
    with tempfile.TemporaryDirectory(prefix="cliprelay-sunshine-") as temporary:
        indexes = {}
        normalized_patches = []
        for checkout, name in patches:
            normalized = Path(temporary) / name
            normalized.write_bytes((extension / name).read_bytes().replace(b"\r\n", b"\n"))
            if checkout not in indexes:
                indexes[checkout] = dict(os.environ, GIT_INDEX_FILE=str(Path(temporary) / f"index-{len(indexes)}"))
                subprocess.run(["git", "-C", str(checkout), "read-tree", "HEAD"], env=indexes[checkout], check=True)
            # Check the ordered overlay against a temporary index. --check must
            # not mutate either checkout or its real index, even with two patches.
            subprocess.run(["git", "-C", str(checkout), "apply", "--cached", str(normalized)],
                           env=indexes[checkout], check=True)
            normalized_patches.append((checkout, normalized))
        if not check:
            for checkout, normalized in normalized_patches:
                subprocess.run(["git", "-C", str(checkout), "apply", str(normalized)], check=True)
            for name in headers:
                shutil.copyfile(extension / name, source / "src" / name)
            shutil.copyfile(extension / "input_integration_test.cpp", input_test)
            if macos_host:
                shutil.copyfile(extension / "macos_mouse_test.cpp", macos_test)
                shutil.copyfile(extension / "macos_capture_test.mm", capture_test)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--macos-host", action="store_true", help="Apply the pinned macOS capture and pointer overlay")
    args = parser.parse_args()
    prepare(args.source, args.check, args.macos_host)
    print("Pinned Sunshine patch verified" if args.check else "Pinned Sunshine patch applied")
