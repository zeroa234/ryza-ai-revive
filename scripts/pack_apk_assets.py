#encoding: utf-8
"""Pack a directory into an APK as assets/<relpath> with FORWARD slashes.

aapt2 -A on Windows stores backslash entry names (assets\\js\\app.js), which
Android's AssetManager cannot open. This appends the entries properly instead:
media that is already compressed goes in STORED (fast), text as DEFLATED.

usage: python pack_apk_assets.py <apk> <dir>
"""
import os
import sys
import zipfile

STORED_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".m4a", ".mp3", ".mp4",
              ".skel", ".woff2", ".ttf", ".otf", ".ogg", ".aac"}


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    apk, src = sys.argv[1], sys.argv[2]
    if not os.path.isfile(apk) or not os.path.isdir(src):
        print("apk or dir missing", file=sys.stderr)
        return 2

    n = 0
    total = 0
    with zipfile.ZipFile(apk, "a", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        existing = set(zf.namelist())
        for root, _dirs, files in os.walk(src):
            for name in sorted(files):
                full = os.path.join(root, name)
                rel = os.path.relpath(full, src).replace(os.sep, "/")
                arc = "assets/" + rel
                if arc in existing:
                    continue
                ext = os.path.splitext(name)[1].lower()
                comp = zipfile.ZIP_STORED if ext in STORED_EXT else zipfile.ZIP_DEFLATED
                zf.write(full, arc, compress_type=comp)
                n += 1
                total += os.path.getsize(full)
    print("packed %d assets (%.1f MB raw) into %s" % (n, total / 1048576.0, apk))
    return 0


if __name__ == "__main__":
    sys.exit(main())
