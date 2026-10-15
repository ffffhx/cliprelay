import copy
import io
import json
from pathlib import Path
import socket
import struct
import tempfile
import threading
import unittest
import zlib
from unittest.mock import patch

import relays
import relay_preflight


def fixture_map():
    return {"regions": {"902": {"regionid": 902, "regioncode": "backup", "regionname": "Backup relay",
        "nodes": [{"name": "backup-a", "regionid": 902, "hostname": "relay.example.net", "ipv4": "8.8.8.8"}]}}}


class RelayConfigTests(unittest.TestCase):
    def test_relay_cannot_start_without_tls_identity_and_admission(self):
        good = {"DERP_HOSTNAME": "relay.my-domain.net", "DERP_VERIFY_URL": "https://coord.my-domain.net/verify"}
        relay_preflight.validate(good)
        for changes in ({"DERP_HOSTNAME": "relay-backup.example.net"}, {"DERP_HOSTNAME": ""},
                        {"DERP_VERIFY_URL": ""}, {"DERP_VERIFY_URL": "http://coord.my-domain.net/verify"},
                        {"DERP_VERIFY_URL": "https://key:secret@coord.my-domain.net/verify"},
                        {"DERP_VERIFY_URL": "https://coord.my-domain.net/"}):
            with self.assertRaises(ValueError):
                relay_preflight.validate({**good, **changes})

    def test_empty_map_keeps_embedded_primary_and_valid_map_can_add_backup(self):
        self.assertEqual(relays.validate_map({"regions": {}}), {"regions": {}})
        data = fixture_map()
        self.assertIs(relays.validate_map(data), data)

    def test_rejects_identity_collisions_tls_bypasses_and_invalid_endpoints(self):
        original = fixture_map()
        invalid = []
        for key, value in (("hostname", "https://relay.example.net/"), ("hostname", "bad\r\nHeader: injected"),
                           ("derpport", 0), ("stunport", True), ("ipv4", "127.0.0.1"), ("ipv4", "124.221.36.36"),
                           ("ipv6", "8.8.8.8"), ("ipv4", []), ("ipv6", False), ("insecurefortests", True), ("regionid", 901)):
            data = copy.deepcopy(original)
            data["regions"]["902"]["nodes"][0][key] = value
            invalid.append(data)
        data = copy.deepcopy(original)
        data["regions"]["903"] = copy.deepcopy(data["regions"]["902"])
        invalid.append(data)
        data = copy.deepcopy(original)
        data["regions"]["901"] = data["regions"].pop("902")
        data["regions"]["901"]["regionid"] = 901
        invalid.append(data)
        for data in invalid:
            with self.subTest(data=data), self.assertRaises(ValueError):
                relays.validate_map(data)

    def test_duplicate_json_keys_are_rejected_instead_of_overwriting_a_region(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "relays.json"
            path.write_text('{"regions": {}, "regions": {}}', encoding="utf-8")
            with self.assertRaises(ValueError):
                relays.load_map(path)

    def test_headscale_map_uses_integer_yaml_keys_and_preserves_metadata(self):
        data = fixture_map()
        result = relays.render_map(data)
        self.assertTrue(result.startswith("regions:\n  902: {"))
        self.assertEqual(json.loads(result.split("  902: ", 1)[1]), data["regions"]["902"])
        self.assertEqual(relays.render_map({"regions": {}}), "regions: {}\n")

    def test_health_requires_derp_not_just_stun_and_reports_real_region_count(self):
        def probe(node, timeout):
            return {"region": node["regionid"], "node": node["name"], "derp": node["regionid"] == 901, "stun": True}
        with patch.object(relays, "probe_node", side_effect=probe):
            report = relays.probe_map(fixture_map(), include_primary=True)
        self.assertFalse(report["healthy"])
        self.assertFalse(report["redundant"])
        self.assertEqual(report["reachableRegions"], [901])
        with patch.object(relays, "probe_node", side_effect=lambda node, timeout: {"region": node["regionid"], "derp": True}):
            self.assertTrue(relays.probe_map(fixture_map(), include_primary=True)["redundant"])
            self.assertFalse(relays.probe_map({"regions": {}}, include_primary=True)["redundant"])

    def test_probe_uses_verified_tls_and_reports_failures_without_stopping_other_checks(self):
        with patch.object(relays, "probe_derp", side_effect=relays.ssl.SSLCertVerificationError("bad cert")), \
             patch.object(relays, "probe_stun") as stun:
            report = relays.probe_node(fixture_map()["regions"]["902"]["nodes"][0], 1)
        self.assertFalse(report["derp"])
        self.assertTrue(report["stun"])
        self.assertEqual(report["derpError"], "SSLCertVerificationError")
        stun.assert_called_once()

    def test_derp_handshake_rejects_ordinary_https_malformed_frames_and_truncation(self):
        greeting = b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: DERP\r\n\r\n" + struct.pack("!BI", 1, 40) + b"DERP\xf0\x9f\x94\x91" + bytes(32)
        relays.check_derp_greeting(io.BytesIO(greeting))
        for value in (b"HTTP/1.1 200 OK\r\n\r\n", greeting[:-1], greeting.replace(b"DERP\xf0", b"NOPE\xf0"),
                      greeting[:greeting.index(b"\r\n\r\n") + 4] + struct.pack("!BI", 1, 0xFFFFFFFF)):
            with self.assertRaises(OSError):
                relays.check_derp_greeting(io.BytesIO(value))

    def test_stun_probe_checks_a_real_udp_response_transaction(self):
        for valid in (True, False):
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server:
                server.bind(("127.0.0.1", 0))
                server.settimeout(2)
                def reply():
                    data, peer = server.recvfrom(4096)
                    # Match the actual upstream STUN admission rules.
                    if data[20:32] != struct.pack("!HH", 0x8022, 8) + b"tailnode":
                        return
                    if data[32:] != struct.pack("!HHI", 0x8028, 4, zlib.crc32(data[:32]) ^ 0x5354554E):
                        return
                    response = b"\x01\x01\x00\x00" + data[4:20]
                    server.sendto(response if valid else response[:-1] + bytes([response[-1] ^ 1]), peer)
                worker = threading.Thread(target=reply)
                worker.start()
                node = {"hostname": "127.0.0.1", "stunport": server.getsockname()[1]}
                if valid:
                    relays.probe_stun(node, 1)
                else:
                    with self.assertRaises(OSError):
                        relays.probe_stun(node, 1)
                worker.join(2)

    def test_atomic_report_replaces_previous_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "health.json"
            relays.atomic_json(path, {"healthy": True})
            relays.atomic_json(path, {"healthy": False})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"healthy": False})
            self.assertEqual(list(Path(directory).iterdir()), [path])


if __name__ == "__main__":
    unittest.main()
