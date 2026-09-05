#encoding: utf-8
"""Write a generic (non-character) PNG icon for the desktop and Android shells."""
from __future__ import annotations

import os
import struct
import zlib

W = H = 256


def _px(x: int, y: int) -> bytes:
    # Orange rounded square + white speech-dot. No character art.
    nx = (x + 0.5) / W
    ny = (y + 0.5) / H
    r = 0.18
    in_x = r <= nx <= 1 - r or (0.08 <= nx <= 0.92 and r <= ny <= 1 - r)
    in_y = r <= ny <= 1 - r or (0.08 <= ny <= 0.92 and r <= nx <= 1 - r)
    cx = min(abs(nx - r), abs(nx - (1 - r)), abs(ny - r), abs(ny - (1 - r)))
    corner = (
        (nx < r and ny < r and (nx - r) ** 2 + (ny - r) ** 2 <= r * r)
        or (nx > 1 - r and ny < r and (nx - (1 - r)) ** 2 + (ny - r) ** 2 <= r * r)
        or (nx < r and ny > 1 - r and (nx - r) ** 2 + (ny - (1 - r)) ** 2 <= r * r)
        or (nx > 1 - r and ny > 1 - r and (nx - (1 - r)) ** 2 + (ny - (1 - r)) ** 2 <= r * r)
    )
    inside = ((0.08 <= nx <= 0.92 and 0.08 <= ny <= 0.92) and (in_x and in_y)) or corner
    if not inside and not (
        (nx < r and r <= ny <= 1 - r and nx >= 0.08)
        or (nx > 1 - r and r <= ny <= 1 - r and nx <= 0.92)
        or (ny < r and r <= nx <= 1 - r and ny >= 0.08)
        or (ny > 1 - r and r <= nx <= 1 - r and ny <= 0.92)
    ):
        return b"\x00\x00\x00\x00"
    # body
    dx = nx - 0.5
    dy = ny - 0.42
    dot = dx * dx + dy * dy <= 0.035 * 0.035
    if dot:
        return b"\xff\xff\xff\xff"
    d2 = (nx - 0.38) ** 2 + (ny - 0.42) ** 2
    d3 = (nx - 0.62) ** 2 + (ny - 0.42) ** 2
    if d2 <= 0.028 * 0.028 or d3 <= 0.028 * 0.028:
        return b"\xff\xff\xff\xff"
    _ = cx
    return b"\xe8\x89\x3a\xff"


def write_png(path: str) -> None:
    raw = bytearray()
    for y in range(H):
        raw.append(0)
        for x in range(W):
            raw.extend(_px(x, y))
    comp = zlib.compress(bytes(raw), 9)
    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)
    ihdr = struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", comp) + chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)


def main() -> None:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    write_png(os.path.join(root, "desktop", "build", "icon.png"))
    write_png(os.path.join(root, "android", "app", "src", "main", "res", "drawable", "ic_launcher.png"))
    print("wrote generic desktop and android icons")


if __name__ == "__main__":
    main()
