#!/usr/bin/env python3
"""Rootless Arch sysroot resolver: parse core.db/extra.db, resolve deps, download+extract."""
import gzip
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import urllib.request

MIRROR = "https://geo.mirror.pkgbuild.com"
SYSROOT = os.path.expanduser("~/gtk-sysroot")
PKGDIR = "/tmp/pkgcache"
TARGETS = [
    t.strip()
    for t in os.environ.get(
        "SYSROOT_TARGETS",
        "gtk3,webkit2gtk-4.1,libappindicator-gtk3,librsvg,libsoup3,patchelf",
    ).split(",")
    if t.strip()
]
EXCLUDE = {"glibc", "gcc-libs", "libgcc", "libstdc++", "bash", "coreutils", "pacman", "systemd"}


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "md-reader-sysroot/1"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def load_db(repo):
    raw = fetch(f"{MIRROR}/{repo}/os/x86_64/{repo}.db")
    data = gzip.decompress(raw)
    tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:")
    pkgs = {}
    for member in tf.getmembers():
        if not member.name.endswith("/desc"):
            continue
        text = tf.extractfile(member).read().decode("utf-8", "replace")
        fields = {}
        key = None
        for line in text.splitlines():
            if line.startswith("%") and line.endswith("%"):
                key = line.strip("%")
                fields.setdefault(key, [])
            elif line and key:
                fields[key].append(line)
        name = (fields.get("NAME") or [""])[0]
        if not name:
            continue
        pkgs[name] = {
            "name": name,
            "repo": repo,
            "filename": (fields.get("FILENAME") or [""])[0],
            "depends": fields.get("DEPENDS", []),
            "provides": [p.split("=")[0] for p in fields.get("PROVIDES", [])],
        }
    return pkgs


def main():
    pkgs = {}
    providers = {}
    for repo in ("core", "extra"):
        db = load_db(repo)
        pkgs.update(db)
        for p in db.values():
            providers[p["name"]] = p
            for prov in p["provides"]:
                providers.setdefault(prov, p)

    resolved = {}
    queue = list(TARGETS)
    missing = []
    while queue:
        dep = queue.pop(0)
        dep = re.split(r"[<>=]", dep)[0].strip()
        if not dep or dep in resolved:
            continue
        pkg = pkgs.get(dep) or providers.get(dep)
        if not pkg:
            missing.append(dep)
            continue
        name = pkg["name"]
        if name in resolved:
            continue
        resolved[name] = pkg
        if name not in EXCLUDE:
            for d in pkg["depends"]:
                queue.append(d)

    print(f"packages={len(resolved)} missing={missing}")
    for name in sorted(resolved):
        print(f"  {name}  {resolved[name]['filename']}")
    if "--download" not in sys.argv:
        return

    os.makedirs(PKGDIR, exist_ok=True)
    os.makedirs(SYSROOT, exist_ok=True)
    for i, (name, pkg) in enumerate(sorted(resolved.items()), 1):
        if name in EXCLUDE:
            continue
        fn = pkg["filename"]
        path = os.path.join(PKGDIR, fn)
        if not os.path.exists(path):
            print(f"[{i}/{len(resolved)}] download {fn}")
            data = fetch(f"{MIRROR}/{pkg['repo']}/os/x86_64/{fn}", timeout=300)
            with open(path, "wb") as f:
                f.write(data)
        subprocess.run(["bsdtar", "-xf", path, "-C", SYSROOT], check=True)
    print("extracted to", SYSROOT)
    # 让 pkg-config 使用 sysroot 里的 .pc
    pcs = []
    for root, _dirs, files in os.walk(os.path.join(SYSROOT, "usr")):
        for f in files:
            if f.endswith(".pc"):
                pcs.append(os.path.join(root, f))
    print(f"pc files={len(pcs)}")


if __name__ == "__main__":
    main()
