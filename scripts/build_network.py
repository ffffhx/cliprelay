"""Build the embedded network component from pinned Go sources (no device state)."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
from network_notices import write_notices

ROOT = Path(__file__).resolve().parents[1]
MOBILE_VERSION = "v0.0.0-20260908204917-8b95e45f8d3e"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=["windows", "android", "server"])
    parser.add_argument("--android-arch", default="android",
                        help="Default builds all four ABIs; android/arm64 is useful for a local device build")
    args = parser.parse_args()
    go = shutil.which("go")
    if not go:
        raise SystemExit("Install Go 1.26.7 or newer before building the network component.")
    env = os.environ.copy()
    module = ROOT / "network"

    def run(argv, **kwargs):
        subprocess.run([str(x) for x in argv], cwd=module, env=env, check=True, **kwargs)

    if args.target == "android":
        sdk = env.get("ANDROID_HOME") or env.get("ANDROID_SDK_ROOT")
        if not sdk:
            raise SystemExit("Set ANDROID_HOME to the Android SDK directory.")
        env.setdefault("ANDROID_NDK_HOME", str(Path(sdk) / "ndk" / "29.0.14206865"))
        if not Path(env["ANDROID_NDK_HOME"]).is_dir():
            raise SystemExit("Install Android NDK 29.0.14206865 first.")
        # Isolate build tools from the user's Go bin directory.
        tool_dir = ROOT / ".tools" / "network-build-bin"
        tool_dir.mkdir(parents=True, exist_ok=True)
        env["GOBIN"] = str(tool_dir)
        env["PATH"] = str(tool_dir) + os.pathsep + env["PATH"]
        run([go, "install", "golang.org/x/mobile/cmd/gomobile@" + MOBILE_VERSION])
        run([go, "install", "golang.org/x/mobile/cmd/gobind@" + MOBILE_VERSION])
        output = ROOT / "android-app/network-libs/cliprelay-network.aar"
        output.parent.mkdir(parents=True, exist_ok=True)
        executable = tool_dir / ("gomobile.exe" if os.name == "nt" else "gomobile")
        run([executable, "bind", "-target=" + args.android_arch, "-androidapi=26",
             "-javapkg=com.cliprelay.network", "-trimpath", "-ldflags=-s -w",
             "-o", output, "./mobile"])
    else:
        env.update(GOOS="windows" if args.target == "windows" else "linux", GOARCH="amd64", CGO_ENABLED="0")
        output = ROOT / ("windows/remote-desktop/bin/cliprelay-network.exe" if args.target == "windows"
                         else ".tools/network-build/cliprelay-pairing")
        output.parent.mkdir(parents=True, exist_ok=True)
        package = "./cmd/cliprelay-network" if args.target == "windows" else "./cmd/cliprelay-pairing"
        run([go, "build", "-mod=readonly", "-trimpath", "-ldflags=-s -w", "-o", output, package])
    print(f"Built {output}")
    if args.target != "server":
        write_notices(ROOT, go, env, args.target)


if __name__ == "__main__":
    main()
