"""Advance Android versions against the last published update manifest."""

import argparse
import json
import re
from pathlib import Path


def next_version(name, code, latest):
    def parse(value):
        if not re.fullmatch(r"\d+\.\d+\.\d+", value):
            raise ValueError(f"Expected major.minor.patch version: {value}")
        return tuple(map(int, value.split(".")))

    current = parse(name)
    if not latest:
        return name, code
    released = parse(latest["versionName"])
    if current <= released:
        name = f"{released[0]}.{released[1]}.{released[2] + 1}"
    return name, max(code, int(latest["versionCode"]) + 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("build_file", type=Path)
    parser.add_argument("--latest", type=Path)
    args = parser.parse_args()
    source = args.build_file.read_text(encoding="utf-8")
    name = re.search(r'^\s*versionName\s*=\s*"([^"]+)"', source, re.M)[1]
    code = int(re.search(r"^\s*versionCode\s*=\s*(\d+)", source, re.M)[1])
    latest = json.loads(args.latest.read_text()) if args.latest else None
    name, code = next_version(name, code, latest)
    source = re.sub(r'(versionName\s*=\s*)"[^"]+"', lambda m: f'{m[1]}"{name}"', source)
    source = re.sub(r"(versionCode\s*=\s*)\d+", lambda m: f"{m[1]}{code}", source)
    args.build_file.write_text(source, encoding="utf-8")


if __name__ == "__main__":
    main()
