"""Collect unmodified license notices for Go modules linked into each client."""
import json
from pathlib import Path
import subprocess


def json_stream(value):
    decoder = json.JSONDecoder()
    while value.strip():
        value = value.lstrip()
        item, end = decoder.raw_decode(value)
        yield item
        value = value[end:]


def write_notices(root, go, environment, target):
    env = environment.copy()
    env.update(GOOS="android" if target == "android" else "windows",
               GOARCH="arm64" if target == "android" else "amd64", CGO_ENABLED="1")
    raw = subprocess.check_output([go, "list", "-mod=readonly", "-deps", "-json", "./mobile", "./cmd/cliprelay-network"],
                                  cwd=root / "network", env=env, text=True, encoding="utf-8")
    modules = {}
    for package in json_stream(raw):
        module = package.get("Module")
        if module and not module.get("Main"):
            modules[module["Path"]] = module
    sections = ["ClipRelay embedded network component\n"
                "Uses Tailscale tsnet, WireGuard and the following Go modules.\n"
                "Source versions are pinned in network/go.mod and network/go.sum.\n"
                "Tailscale is a trademark of Tailscale Inc. This application is independently operated.\n"]
    for name, module in sorted(modules.items()):
        directory = Path(module["Dir"])
        files = sorted(p for p in directory.rglob("*") if p.is_file()
                       and p.name.upper().startswith(("LICENSE", "COPYING", "NOTICE")))
        if not files:
            raise RuntimeError(f"Missing license notice for linked module {name}")
        sections.append(f"\n{'=' * 72}\n{name} {module['Version']}\nhttps://pkg.go.dev/{name}@{module['Version']}\n")
        for file in files:
            sections.append(f"\n--- {file.relative_to(directory).as_posix()} ---\n" + file.read_text(encoding="utf-8", errors="replace"))
    goroot = Path(subprocess.check_output([go, "env", "GOROOT"], env=env, text=True).strip())
    sections.append("\nGo runtime — https://go.dev/\n" + (goroot / "LICENSE").read_text(encoding="utf-8"))
    output = root / ("android-app/app/src/main/assets/cliprelay-remote/NETWORK-LICENSES.txt" if target == "android"
                     else "windows/remote-desktop/NETWORK-LICENSES.txt")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(sections), encoding="utf-8")
    print(f"Collected notices for {len(modules)} linked modules: {output}")
