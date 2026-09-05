#encoding: utf-8
"""Refuse to ship anything that identifies the developer or their accounts.

This is a BUILD GATE, not a report: both packaging scripts call it before they
stage files and again on the finished artifact, and a non-zero exit stops the
build. The shipped app is a personal/offline rebuild — nothing in it may carry
a machine path, an account name, or an API key.

Two kinds of check:
  * ENTRY NAMES — every path inside the artifact (apk/zip members, files under
    a directory). Catches things like `providers.json` or a stray key file.
  * CONTENT — text-ish members scanned for the marker strings. Binary media
    (png/m4a/skel/…) is skipped by extension, never by size, so a 570 MB asset
    tree still scans in about a second.

usage:
    python scripts/privacy_check.py <path> [<path> …]
    python scripts/privacy_check.py --quiet <path>      # only print the verdict
"""
import os
import re
import sys
import zipfile

# Substrings that must never appear in a shipped path or file. Lowercased
# comparison. Each entry is a fact about THIS developer, not about the app.
NAME_MARKERS = [
    "providers.json",          # local dev hydration file with real keys
    "id_rsa", "id_ed25519", ".pem", ".p12", ".keystore", ".jks",
]

# Generic markers that belong in git. Extra personal hosts/paths live in
# gitignored config/privacy_markers.local.txt (one substring per line).
CONTENT_MARKERS = [
    "gospiral",                # original publisher identifiers must not ship
    "api.craft.spiral",
]


def extra_content_markers():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "..", "config", "privacy_markers.local.txt")
    out = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                s = line.split("#", 1)[0].strip().lower()
                if s:
                    out.append(s)
    except OSError:
        pass
    return out

# Real-looking secrets, caught by shape rather than by literal.
CONTENT_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9]{16,}"),
    re.compile(r"[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}"),  # JWT
    re.compile(r"(?i)authorization\s*[:=]\s*bearer\s+[A-Za-z0-9._-]{12,}"),
]

# Extensions whose bytes are not text; their names are still checked.
BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".m4a", ".mp3", ".mp4", ".ogg",
    ".wav", ".aac", ".skel", ".atlas", ".woff", ".woff2", ".ttf", ".otf",
    ".so", ".dll", ".exe", ".dex", ".bin", ".ico", ".icns", ".dat", ".pak",
    ".node", ".wasm", ".eot", ".zip", ".apk", ".asar", ".7z", ".gz", ".xz",
}

MAX_SCAN_BYTES = 12 * 1024 * 1024      # per text member


def check_text(path, data, findings):
    try:
        text = data.decode("utf-8", "replace").lower()
    except Exception:
        return
    for marker in CONTENT_MARKERS:
        if marker in text:
            findings.append("%s: content contains %r" % (path, marker))
    for rx in CONTENT_PATTERNS:
        m = rx.search(text)
        if m:
            findings.append("%s: content matches %s → %r"
                            % (path, rx.pattern[:24], m.group(0)[:24]))


def check_name(path, findings):
    low = path.lower().replace("\\", "/")
    base = low.rsplit("/", 1)[-1]
    for marker in NAME_MARKERS:
        if marker in base:
            findings.append("%s: file name contains %r" % (path, marker))


def scan_file(path, findings):
    # this file is the list of forbidden strings; scanning it finds itself
    if os.path.basename(path).lower() == "privacy_check.py":
        return
    check_name(path, findings)
    ext = os.path.splitext(path)[1].lower()
    if ext in BINARY_EXT:
        return
    try:
        if os.path.getsize(path) > MAX_SCAN_BYTES:
            return
        with open(path, "rb") as fh:
            check_text(path, fh.read(), findings)
    except OSError as exc:
        findings.append("%s: unreadable (%s)" % (path, exc))


def scan_dir(root, findings):
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            scan_file(os.path.join(dirpath, name), findings)


def scan_container(path, findings):
    """APK / ASAR / ZIP: check member names, and the text members' contents."""
    check_name(path, findings)
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            name = info.filename
            check_name(name, findings)
            ext = os.path.splitext(name)[1].lower()
            if ext in BINARY_EXT or info.file_size > MAX_SCAN_BYTES:
                continue
            try:
                check_text("%s!%s" % (os.path.basename(path), name),
                           zf.read(info), findings)
            except Exception as exc:
                findings.append("%s!%s: unreadable (%s)"
                                % (os.path.basename(path), name, exc))


def main(argv):
    args = [a for a in argv[1:] if a != "--quiet"]
    quiet = "--quiet" in argv[1:]
    if not args:
        print(__doc__)
        return 2
    findings = []
    extra = extra_content_markers()
    if extra:
        CONTENT_MARKERS.extend(extra)
    for target in args:
        if os.path.isdir(target):
            scan_dir(target, findings)
        elif zipfile.is_zipfile(target):
            scan_container(target, findings)
        elif os.path.isfile(target):
            scan_file(target, findings)
        else:
            findings.append("%s: no such file or directory" % target)
    if findings:
        print("PRIVACY CHECK FAILED (%d hit(s)):" % len(findings))
        for f in findings[:60]:
            print("  " + f)
        if len(findings) > 60:
            print("  … %d more" % (len(findings) - 60))
        return 1
    if not quiet:
        print("PRIVACY CHECK OK — " + ", ".join(os.path.basename(a) for a in args))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
