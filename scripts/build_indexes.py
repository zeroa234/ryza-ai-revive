#encoding: utf-8
"""Scan web/assets and emit the JSON indexes the web app loads at startup.

Run from anywhere:  python scripts/build_indexes.py
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "web", "assets")
OUT = os.path.join(ROOT, "web", "assets", "_index")
os.makedirs(OUT, exist_ok=True)


def w(name, obj):
    p = os.path.join(OUT, name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print("  %-22s %s" % (name, p))


# ---------------------------------------------------------------- voice bank
# assets/audio/alarm/<locale>/<style>/<type>/<time>/<n>.m4a  (+ .env.json)
VOICE = {}
vroot = os.path.join(ASSETS, "audio", "alarm")
if os.path.isdir(vroot):
    for locale in sorted(os.listdir(vroot)):
        ldir = os.path.join(vroot, locale)
        if not os.path.isdir(ldir):
            continue
        for style in sorted(os.listdir(ldir)):
            sdir = os.path.join(ldir, style)
            if not os.path.isdir(sdir):
                continue
            for kind in sorted(os.listdir(sdir)):
                kdir = os.path.join(sdir, kind)
                if not os.path.isdir(kdir):
                    continue
                for tod in sorted(os.listdir(kdir)):
                    tdir = os.path.join(kdir, tod)
                    if not os.path.isdir(tdir):
                        continue
                    for fn in sorted(os.listdir(tdir)):
                        if not fn.endswith(".m4a"):
                            continue
                        VOICE.setdefault(locale, {}).setdefault(
                            style, {}).setdefault(kind, {}).setdefault(tod, []).append(
                            "assets/audio/alarm/%s/%s/%s/%s/%s" % (locale, style, kind, tod, fn))

n_voice = sum(len(v) for l in VOICE.values() for s in l.values()
              for k in s.values() for v in k.values())
w("voice_bank.json", VOICE)
print("     -> %d clips" % n_voice)

# ------------------------------------------------------------------- scenes
# assets/spine/scenes/<stageId>_<tod>/spine/<stageId>_<tod>.skel
# plus a sibling <stageId>_<tod>.json holding per-scene rig config.
SCENES = {}
sroot = os.path.join(ASSETS, "spine", "scenes")
if os.path.isdir(sroot):
    for d in sorted(os.listdir(sroot)):
        m = re.match(r"^(stage_\d{2}_\d{3}_\d{2})_(mor|aft|eve|ngt)$", d)
        if not m:
            continue
        stage, tod = m.group(1), m.group(2)
        base = "assets/spine/scenes/%s/spine/%s" % (d, d)
        cfg = "assets/spine/scenes/%s/%s.json" % (d, d)
        SCENES.setdefault(stage, {})[tod] = {
            "skel": base + ".skel",
            "atlas": base + ".atlas",
            "config": cfg if os.path.isfile(os.path.join(ASSETS, cfg[7:])) else None,
        }
w("scenes.json", SCENES)
print("     -> %d stages x %s" % (len(SCENES), sorted(
    {t for v in SCENES.values() for t in v})))

# -------------------------------------------------------------------- skins
def discover_variants(full, sid, chr_id):
    """Extra atlas pages next to a skin: `{sid}nsfw.png` → variants.nsfw.

    Any future costume drops `{id}{tag}.png` (optional `_`/`-` before tag)
    in its own folder and the runtime picks it up — no code change.
    """
    variants = {}
    try:
        names = os.listdir(full)
    except OSError:
        return variants
    for fn in names:
        if not fn.lower().endswith(".png"):
            continue
        stem = fn[:-4]
        if stem == sid or not stem.startswith(sid):
            continue
        tag = stem[len(sid):]
        if tag[:1] in "_-":
            tag = tag[1:]
        tag = tag.strip().lower()
        if not tag or not re.match(r"^[a-z0-9_]{1,32}$", tag):
            continue
        variants[tag] = "assets/spine/%s/%s/%s" % (chr_id, sid, fn)
    return variants


SKINS = []
spine_root = os.path.join(ASSETS, "spine")
if os.path.isdir(spine_root):
    for chr_id in sorted(os.listdir(spine_root)):
        if not chr_id.startswith("crf_chr_"):
            continue
        kroot = os.path.join(spine_root, chr_id)
        if not os.path.isdir(kroot):
            continue
        for d in sorted(os.listdir(kroot)):
            full = os.path.join(kroot, d)
            if not os.path.isdir(full):
                continue
            entry = {
                "id": d,
                "chr": chr_id,
                "hasSpine": os.path.isfile(os.path.join(full, d + ".skel")),
                "preview": "assets/images/skins/%s.png" % d
                if os.path.isfile(os.path.join(ASSETS, "images", "skins", d + ".png")) else None,
                "skel": "assets/spine/%s/%s/%s.skel" % (chr_id, d, d),
                "atlas": "assets/spine/%s/%s/%s.atlas" % (chr_id, d, d),
                "gesture": "assets/spine/%s/%s/%s_gesture.json" % (chr_id, d, d),
            }
            variants = discover_variants(full, d, chr_id)
            if variants:
                entry["variants"] = variants
            SKINS.append(entry)
# Preview-only outfits that ship as images without a skeleton in the APK.
seen = {s["id"] for s in SKINS}
skindir = os.path.join(ASSETS, "images", "skins")
if os.path.isdir(skindir):
    for fn in sorted(os.listdir(skindir)):
        if not fn.lower().endswith(".png"):
            continue
        sid = fn[:-4]
        if sid in seen:
            continue
        SKINS.append({
            "id": sid,
            "hasSpine": False,
            "preview": "assets/images/skins/%s.png" % sid,
            "skel": None, "atlas": None, "gesture": None,
        })
w("skins.json", SKINS)
print("     -> %d skins (%d with skeleton)" % (len(SKINS), sum(1 for s in SKINS if s["hasSpine"])))

# ------------------------------------------------------------- misc indexes
def listdir_rel(sub, exts=None):
    d = os.path.join(ASSETS, sub)
    if not os.path.isdir(d):
        return []
    out = []
    for root, _, files in os.walk(d):
        for fn in sorted(files):
            if exts and not fn.lower().endswith(tuple(exts)):
                continue
            rel = os.path.relpath(os.path.join(root, fn), ASSETS).replace("\\", "/")
            out.append("assets/" + rel)
    return sorted(out)

w("characters.json", {
    "chara_icons": listdir_rel("images/chara_icons", (".png",)),
    "objects": listdir_rel("spine/objects", (".skel",)),
})
w("ambient.json", listdir_rel("audio/ambient", (".m4a",)))
w("bgm.json", listdir_rel("audio/bgm", (".m4a",)))
w("prologue.json", listdir_rel("audio/prologue", (".m4a",)))
w("tap_voice.json", listdir_rel("audio/tap_voice", (".m4a",)))
w("se.json", listdir_rel("audio/se", (".m4a",)))
w("icons.json", listdir_rel("icons", (".svg",)))

# stage -> background mapping ships with the game; expose it as-is
for src, dst in (("data/stage_background_map.json", "stage_background_map.json"),
                 ("data/posture_camera.json", "posture_camera.json"),
                 ("world_map/world_hierarchy.json", "world_hierarchy.json"),
                 ("world_map/npc_placement.json", "npc_placement.json")):
    p = os.path.join(ASSETS, src)
    if os.path.isfile(p):
        w(dst, json.load(open(p, encoding="utf-8")))

print("\nindexes written to", OUT)
