#encoding: utf-8
"""Copy original-game media into web/assets/ from a Release APK or an unpacked web tree.

Git does not ship textures, audio, Spine binaries, or fonts. Playable builds on
GitHub Releases still contain them. This script only writes ignored media files;
it never copies JS/HTML/JSON over the source tree.

usage:
  python scripts/restore_media.py path/to/RyzaChat-<ver>.apk
  python scripts/restore_media.py path/to/win-unpacked/resources/web
"""
from __future__ import annotations

import os
import shutil
import sys
import zipfile

MEDIA_EXT = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif",
    ".m4a", ".mp3", ".wav", ".ogg", ".aac",
    ".skel", ".ttf", ".otf",
}

# APK packer stores web/<rel> as assets/<rel>, so web/assets/foo is assets/assets/foo.
APK_MEDIA_PREFIXES = ("assets/assets/",)
DIR_MARKERS = ("assets/audio", "assets/spine", "assets/images")


def is_media(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in MEDIA_EXT


def dest_for_apk_member(name: str) -> str | None:
    name = name.replace("\\", "/")
    for prefix in APK_MEDIA_PREFIXES:
        if name.startswith(prefix) and is_media(name):
            return "web/assets/" + name[len(prefix):]
    return None


def find_web_root(path: str) -> str | None:
    path = os.path.abspath(path)
    candidates = [path, os.path.join(path, "web"), os.path.join(path, "resources", "web")]
    for c in candidates:
        if all(os.path.isdir(os.path.join(c, m)) for m in DIR_MARKERS):
            return c
    if os.path.isdir(os.path.join(path, "audio")) and os.path.isdir(os.path.join(path, "spine")):
        return os.path.dirname(path)
    return None


def copy_media_tree(src_web: str, dest_root: str) -> int:
    src_assets = os.path.join(src_web, "assets")
    n = 0
    for root, _dirs, files in os.walk(src_assets):
        for name in files:
            full = os.path.join(root, name)
            if not is_media(full):
                continue
            rel = os.path.relpath(full, src_assets)
            dest = os.path.join(dest_root, "web", "assets", rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copy2(full, dest)
            n += 1
    return n


def extract_apk(apk: str, dest_root: str) -> int:
    n = 0
    with zipfile.ZipFile(apk) as zf:
        for info in zf.infolist():
            dest_rel = dest_for_apk_member(info.filename)
            if not dest_rel:
                continue
            dest = os.path.join(dest_root, dest_rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with zf.open(info, "r") as src, open(dest, "wb") as out:
                shutil.copyfileobj(src, out)
            n += 1
    return n


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__.strip())
        return 2
    src = sys.argv[1]
    dest_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    if not os.path.exists(src):
        print("not found:", src, file=sys.stderr)
        return 2
    if os.path.isfile(src) and src.lower().endswith((".apk", ".zip")):
        n = extract_apk(src, dest_root)
        print("restored %d media files from %s" % (n, src))
        return 0 if n else 1
    web = find_web_root(src)
    if not web:
        print("could not find a web/assets tree under", src, file=sys.stderr)
        return 2
    n = copy_media_tree(web, dest_root)
    print("restored %d media files from %s" % (n, web))
    return 0 if n else 1


if __name__ == "__main__":
    sys.exit(main())
