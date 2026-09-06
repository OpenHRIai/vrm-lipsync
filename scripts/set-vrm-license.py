#!/usr/bin/env python3
"""Rewrite the embedded licence metadata of a VRM 0.x file.

VRM stores its terms of use inside the model itself, and VRM-aware tools read
those flags rather than any LICENSE file sitting next to it. Shipping a model
whose meta says Redistribution_Prohibited from a public repo is contradictory,
and some viewers refuse to load it. This rewrites the meta in place.

Usage: set-vrm-license.py <model.vrm> [--out OUT]
"""
import argparse
import json
import struct
import sys

# CC BY 4.0: use and redistribution permitted, including commercially, with
# attribution. Violent/sexual use stay disallowed.
LICENSE = {
    "allowedUserName": "Everyone",
    "violentUssageName": "Disallow",
    "sexualUssageName": "Disallow",
    "commercialUssageName": "Allow",
    "licenseName": "CC_BY",
    "otherLicenseUrl": "https://creativecommons.org/licenses/by/4.0/",
}


def chunks(data: bytes):
    """Yield (type, payload) for each GLB chunk."""
    if data[:4] != b"glTF":
        raise SystemExit("not a GLB/VRM file")
    offset = 12
    while offset < len(data):
        (length,) = struct.unpack("<I", data[offset : offset + 4])
        ctype = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + length]
        yield ctype, payload
        offset += 8 + length


def build(parts) -> bytes:
    body = b""
    for ctype, payload in parts:
        # JSON pads with spaces, binary with nulls; both to 4-byte alignment.
        pad = (-len(payload)) % 4
        payload += (b" " if ctype == b"JSON" else b"\0") * pad
        body += struct.pack("<I", len(payload)) + ctype + payload
    return b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("--out")
    args = ap.parse_args()

    data = open(args.model, "rb").read()
    parts = list(chunks(data))
    if not parts or parts[0][0] != b"JSON":
        raise SystemExit("first chunk is not JSON")

    gltf = json.loads(parts[0][1].decode("utf-8"))
    ext = gltf.get("extensions", {})
    if "VRM" not in ext:
        raise SystemExit("no VRM 0.x extension (VRMC_vrm / VRM 1.0 not handled)")

    meta = ext["VRM"].setdefault("meta", {})
    print("before:", json.dumps({k: meta.get(k) for k in LICENSE}, ensure_ascii=False))
    meta.update(LICENSE)
    print("after: ", json.dumps({k: meta.get(k) for k in LICENSE}, ensure_ascii=False))

    parts[0] = (b"JSON", json.dumps(gltf, separators=(",", ":")).encode("utf-8"))
    out = args.out or args.model
    open(out, "wb").write(build(parts))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
