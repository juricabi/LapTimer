"""PlatformIO pre-script: stamps ?v=<content hash> on style.css / script.js / smoothie.js in the HTML pages.

Browsers cache style.css and script.js for a day; the version changes exactly when a file's
content changes, so a new build is always picked up and nothing needs bumping by hand.
Runs before every PlatformIO build (see [env] in platformio.ini). Also runnable directly:
  python tools/stamp_versions.py
"""
import hashlib
import os
import re

try:
    Import("env")  # noqa: F821 - provided by PlatformIO
    ROOT = env.subst("$PROJECT_DIR")  # noqa: F821
except NameError:
    ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

DATA = os.path.join(ROOT, "data")
ASSETS = ("script.js", "style.css", "smoothie.js")
PAGES = ("index.html", "update.html")


def content_hash(name):
    with open(os.path.join(DATA, name), "rb") as f:
        return hashlib.md5(f.read()).hexdigest()[:8]


def stamp():
    versions = {name: content_hash(name) for name in ASSETS}
    pattern = re.compile(r"(script\.js|style\.css|smoothie\.js)\?v=[0-9A-Za-z]+")
    for page in PAGES:
        path = os.path.join(DATA, page)
        with open(path, encoding="utf-8") as f:
            html = f.read()
        if not html.strip():
            raise SystemExit(f"{page} is empty - restore it from git before building")
        stamped = pattern.sub(lambda m: f"{m.group(1)}?v={versions[m.group(1)]}", html)
        if stamped != html:
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write(stamped)
            print(f"stamp_versions: {page} -> {versions}")


stamp()
