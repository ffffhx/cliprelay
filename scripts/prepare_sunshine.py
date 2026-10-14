"""Apply the reviewed ClipRelay extension to exactly the pinned Sunshine source."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess


def prepare(source: Path, check: bool = False) -> None:
    extension = Path(__file__).resolve().parents[1] / "engine" / "sunshine"
    pinned = json.loads((extension / "upstream.json").read_text(encoding="utf-8"))
    source = source.resolve(strict=True)

    def git(*args: str) -> str:
        return subprocess.check_output(["git", "-C", str(source), *args], text=True).strip()

    if git("rev-parse", "HEAD") != pinned["commit"]:
        raise RuntimeError("Sunshine checkout does not match the pinned commit")
    if git("diff", "HEAD", "--", "src", "cmake"):
        raise RuntimeError("Refusing to patch an already modified Sunshine source tree")
    header = source / "src" / "cliprelay_control.h"
    if header.exists():
        raise RuntimeError("Refusing to replace an existing control header")
    patch = extension / "control.patch"
    git("apply", "--check", str(patch))
    if not check:
        git("apply", str(patch))
        shutil.copyfile(extension / "cliprelay_control.h", header)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    prepare(args.source, args.check)
    print("Pinned Sunshine patch verified" if args.check else "Pinned Sunshine patch applied")
