"""Validate operator-owned DERP regions and probe TLS/DERP and STUN separately.

No credentials, enrollment or traffic contents are read. Health checks never
rewrite the advertised map: clients select a reachable region themselves.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import datetime
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import stat
import struct
import tempfile
import time
import zlib


PRIMARY = {
    "regionid": 901, "regioncode": "cliprelay", "regionname": "ClipRelay Tencent",
    "nodes": [{"name": "901a", "regionid": 901,
               "hostname": "124-221-36-36.anyip.dev", "ipv4": "124.221.36.36",
               "derpport": 8443, "stunport": 3478}],
}


def load_map(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate configuration key")
            result[key] = value
        return result
    if Path(path).stat().st_size > 65536:
        raise ValueError("Relay map exceeds 64 KiB")
    data = json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=unique)
    validate_map(data)
    return data


def validate_map(data):
    def require(value, message):
        if not value:
            raise ValueError(message)
    require(isinstance(data, dict) and set(data) == {"regions"}, "Expected a regions object")
    regions = data["regions"]
    require(isinstance(regions, dict) and len(regions) <= 16, "Expected at most 16 extra regions")
    names, codes, endpoints = set(), {"cliprelay"}, set()
    address_regions = {PRIMARY["nodes"][0]["ipv4"]: 901}
    for raw_id, region in regions.items():
        require(re.fullmatch(r"[1-9][0-9]{2,4}", raw_id) is not None, "Invalid region ID")
        region_id = int(raw_id)
        require(900 <= region_id <= 65535 and region_id != 901, "Region 901 is reserved for the embedded relay")
        require(isinstance(region, dict) and set(region) == {"regionid", "regioncode", "regionname", "nodes"}, "Unknown or missing region fields")
        require(type(region["regionid"]) is int and region["regionid"] == region_id, "Region ID mismatch")
        code = region["regioncode"]
        require(isinstance(code, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,31}", code) and code not in codes, "Invalid or duplicate region code")
        codes.add(code)
        require(isinstance(region["regionname"], str) and 1 <= len(region["regionname"]) <= 80, "Invalid region name")
        nodes = region["nodes"]
        require(isinstance(nodes, list) and 1 <= len(nodes) <= 4, "Expected 1 to 4 nodes per region")
        for node in nodes:
            require(isinstance(node, dict) and set(node) <= {"name", "regionid", "hostname", "ipv4", "ipv6", "derpport", "stunport"}, "Unknown node field; TLS bypasses are forbidden")
            require({"name", "regionid", "hostname"} <= set(node), "Missing node identity")
            require(type(node["regionid"]) is int and node["regionid"] == region_id, "Node region ID mismatch")
            name = node["name"]
            require(isinstance(name, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name) and name not in names, "Invalid or duplicate node name")
            names.add(name)
            host = node["hostname"]
            require(isinstance(host, str) and len(host) <= 253 and "." in host and all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split(".")), "Expected a lowercase TLS hostname without URL or port")
            for field, default in (("derpport", 443), ("stunport", 3478)):
                port = node.get(field, default)
                require(type(port) is int and 1 <= port <= 65535, "Invalid relay port")
            for field, version in (("ipv4", 4), ("ipv6", 6)):
                value = node.get(field, "")
                require(isinstance(value, str), "Relay IP fields must be strings")
                if value and value != "none":
                    address = ipaddress.ip_address(value)
                    require(address.version == version and address.is_global, "Relay IP must be a public address of the right family")
                    require(address_regions.get(str(address), region_id) == region_id, "A public IP cannot represent independent relay regions")
                    address_regions[str(address)] = region_id
            endpoint = (host, node.get("derpport", 443))
            require(endpoint not in endpoints and host != PRIMARY["nodes"][0]["hostname"], "Duplicate relay endpoint does not provide redundancy")
            endpoints.add(endpoint)
    return data


def read_exact(stream, length):
    data = bytearray()
    while len(data) < length:
        part = stream.read(length - len(data))
        if not part:
            raise OSError("Incomplete DERP greeting")
        data.extend(part)
    return bytes(data)


def check_derp_greeting(stream):
    # A generic HTTPS 200 is not evidence of a working DERP reverse proxy.
    first = stream.readline(4097)
    if len(first) > 4096 or first.split()[:2] != [b"HTTP/1.1", b"101"]:
        raise OSError("DERP upgrade rejected")
    total = len(first)
    while True:
        line = stream.readline(4097)
        total += len(line)
        if not line or len(line) > 4096 or total > 16384:
            raise OSError("Invalid DERP response headers")
        if line == b"\r\n":
            break
    kind, length = struct.unpack("!BI", read_exact(stream, 5))
    if kind != 1 or not 40 <= length <= 4096:
        raise OSError("Invalid DERP greeting")
    if read_exact(stream, length)[:8] != b"DERP\xf0\x9f\x94\x91":
        raise OSError("Missing DERP protocol marker")


def destination(node):
    return next((node[field] for field in ("ipv4", "ipv6") if node.get(field) not in (None, "", "none")), node["hostname"])


def probe_derp(node, timeout):
    context = ssl.create_default_context()
    port = node.get("derpport", 443)
    with socket.create_connection((destination(node), port), timeout=timeout) as raw:
        with context.wrap_socket(raw, server_hostname=node["hostname"]) as secure:
            secure.settimeout(timeout)
            request = f'GET /derp HTTP/1.1\r\nHost: {node["hostname"]}:{port}\r\nConnection: Upgrade\r\nUpgrade: DERP\r\n\r\n'
            secure.sendall(request.encode("ascii"))
            with secure.makefile("rb") as stream:
                check_derp_greeting(stream)


def probe_stun(node, timeout):
    transaction = secrets.token_bytes(12)
    # The DERP STUN server requires its protocol's SOFTWARE and FINGERPRINT
    # attributes; a bare RFC 5389 header is intentionally ignored upstream.
    # The eight-byte SOFTWARE value needs no padding.
    message = struct.pack("!HHI", 1, 20, 0x2112A442) + transaction + struct.pack("!HH", 0x8022, 8) + b"tailnode"
    fingerprint = zlib.crc32(message) ^ 0x5354554E
    message += struct.pack("!HHI", 0x8028, 4, fingerprint)
    addresses = socket.getaddrinfo(destination(node), node.get("stunport", 3478), type=socket.SOCK_DGRAM)
    family, kind, protocol, _, endpoint = addresses[0]
    with socket.socket(family, kind, protocol) as client:
        client.settimeout(timeout)
        client.connect(endpoint)
        client.send(message)
        response = client.recv(4096)
    if len(response) < 20 or response[:2] != b"\x01\x01" or response[4:20] != message[4:20]:
        raise OSError("Invalid STUN response")
    if struct.unpack("!H", response[2:4])[0] != len(response) - 20:
        raise OSError("Incomplete STUN response")


def probe_node(node, timeout):
    result = {"region": node["regionid"], "node": node["name"], "derp": False, "stun": False}
    for name, probe in (("derp", probe_derp), ("stun", probe_stun)):
        start = time.monotonic()
        try:
            probe(node, timeout)
            result[name] = True
        except (OSError, ValueError) as error:
            # Bounded category only; certificates and addresses are not log data.
            result[name + "Error"] = type(error).__name__
        result[name + "Ms"] = round((time.monotonic() - start) * 1000)
    return result


def probe_map(data, include_primary=False, timeout=3):
    regions = list(data["regions"].values()) + ([PRIMARY] if include_primary else [])
    nodes = [node for region in regions for node in region["nodes"]]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda node: probe_node(node, timeout), nodes))
    reachable = {node["region"] for node in results if node["derp"]}
    return {"time": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "healthy": bool(regions) and len(reachable) == len(regions),
            "redundant": len(reachable) >= 2, "reachableRegions": sorted(reachable), "nodes": results}


def render_map(data):
    validate_map(data)
    # Headscale 0.29.4 uses yaml.v3 for local files. JSON quotes numeric map
    # keys, which yaml.v3 cannot decode into map[int]*DERPRegion.
    if not data["regions"]:
        return "regions: {}\n"
    lines = ["regions:"]
    for region_id, region in sorted(data["regions"].items(), key=lambda item: int(item[0])):
        lines.append(f"  {int(region_id)}: " + json.dumps(region, ensure_ascii=False))
    return "\n".join(lines) + "\n"


def atomic_text(path, text):
    path = Path(path)
    previous = path.stat() if path.exists() else None
    fd, temporary = tempfile.mkstemp(prefix=".relay-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        # Preserve the service user's read access when an administrator renders
        # a replacement map. A fresh report retains mkstemp's private mode.
        if previous:
            if os.name == "posix":
                os.chown(temporary, previous.st_uid, previous.st_gid)
            os.chmod(temporary, stat.S_IMODE(previous.st_mode))
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def atomic_json(path, data):
    atomic_text(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("validate", "render", "probe"))
    parser.add_argument("--map", type=Path, default=Path("/etc/cliprelay-network/relays.json"))
    parser.add_argument("--include-primary", action="store_true")
    parser.add_argument("--require-redundancy", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--published-map", type=Path, help="Reject health results if published YAML differs from the source map")
    args = parser.parse_args()
    try:
        data = load_map(args.map)
        if args.output and args.output.resolve() in {args.map.resolve(), args.published_map.resolve() if args.published_map else None}:
            raise ValueError("Output must not overwrite a source or published configuration")
        if args.published_map and args.published_map.read_text(encoding="utf-8") != render_map(data):
            raise ValueError("Published relay map does not match configuration; render it before probing")
        if args.command == "render":
            if not args.output:
                raise ValueError("render requires --output for the Headscale YAML map")
            atomic_text(args.output, render_map(data))
            print(json.dumps({"rendered": True, "extraRegions": len(data["regions"])}))
            return 0
        if args.command == "validate":
            result = {"valid": True, "extraRegions": len(data["regions"])}
        else:
            result = probe_map(data, args.include_primary)
        if args.output:
            atomic_json(args.output, result)
        print(json.dumps(result, ensure_ascii=False))
        if args.command == "probe" and (not result["healthy"] or (args.require_redundancy and not result["redundant"])):
            return 2
        return 0
    except (OSError, ValueError, TypeError) as error:
        parser.exit(1, f"Relay configuration failed: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
