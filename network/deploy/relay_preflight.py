"""Refuse to start an extra relay with missing admission or placeholder TLS names."""
import os
import re
from urllib.parse import urlsplit


def validate(environment):
    hostname = environment.get("DERP_HOSTNAME", "")
    raw_url = environment.get("DERP_VERIFY_URL", "")
    if any(character.isspace() for character in raw_url):
        raise ValueError("Admission URL must not contain whitespace")
    url = urlsplit(raw_url)
    if not hostname or len(hostname) > 253 or "." not in hostname or not all(
        re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in hostname.split(".")
    ) or any(hostname == name or hostname.endswith("." + name) for name in ("example.net", "example.com", "example.org", "invalid", "localhost")):
        raise ValueError("Set DERP_HOSTNAME to the backup relay's real TLS hostname")
    if url.scheme != "https" or not url.hostname or url.username is not None or url.password is not None or url.path != "/verify" or url.query or url.fragment:
        raise ValueError("Set DERP_VERIFY_URL to the coordinator's HTTPS /verify endpoint")
    if url.port is not None and not 1 <= url.port <= 65535:
        raise ValueError("Invalid admission HTTPS port")


if __name__ == "__main__":
    try:
        validate(os.environ)
    except ValueError as error:
        raise SystemExit(str(error)) from None
