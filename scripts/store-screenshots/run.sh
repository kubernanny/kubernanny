#!/usr/bin/env bash
# Store screenshots for the App Store and Google Play: the demo agents of
# scripts/screenshots (red, yellow, green), the web UI paired with all three,
# then seven screens per device size and language plus the home-screen widgets
# from device/ (whole device screenshots, see docs/RELEASING.md), each framed
# in a drawn device under a headline (frame/), written to fastlane/screenshots/
# for `npm run store:screenshots`; and the store banners (App Store header and
# search result asset into fastlane/screenshots/banners/, Play's feature
# graphic). Needs Playwright with Chromium (the one of e2e/
# is used when none is installed elsewhere) and Python 3: Pillow comes from
# the first python3 on PATH, or else from a venv the script creates under raw/
# on first use (docs/RELEASING.md, Screenshots).
#   SKIP_BUILD=1   use the existing dist/ of protocol, agent and app
#   ONLY=iphone69,phone   only these sizes (iphone69, ipad13, phone, tablet)
# To change only the headlines or the frame: node frame/frame.cjs (from raw/).
# The frame (frame/template.html) is a generic device drawn in CSS on the
# brand background: no real device images or trademarks, the device at the
# same height on every shot of a size, the logo on the first.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
OUT=$(pwd)/raw
mkdir -p "$OUT"
export OUT
export NODE_PATH="$ROOT/e2e/node_modules${NODE_PATH:+:$NODE_PATH}"
# The size check below needs Pillow. The first python3 on PATH often lacks
# it (Homebrew's or pyenv's), so it then comes from a venv under raw/ (ignored
# by git), created once; checked before anything is rendered.
PY=python3
if ! python3 -c 'import PIL' 2>/dev/null; then
  VENV="$OUT/.venv"
  if ! "$VENV/bin/python" -c 'import PIL' 2>/dev/null; then
    echo "Pillow missing: installing it into $VENV" >&2
    python3 -m venv "$VENV"
    "$VENV/bin/python" -m pip install --quiet --disable-pip-version-check Pillow
  fi
  PY="$VENV/bin/python"
fi

source ../screenshots/demo-agents.sh

node capture.cjs

# Every file at its store size, 6 to 8 per folder, no transparency.
"$PY" - "$ROOT/fastlane/screenshots" <<'PY'
import os, sys
from PIL import Image
root = sys.argv[1]
sizes = {'iphone69': (1320, 2868), 'ipad13': (2064, 2752), 'phone': (1080, 1920), 'tablet': (1600, 2560)}
bad = []
for dirpath, _, files in os.walk(root):
    for target, size in sizes.items():
        mine = sorted(f for f in files if f.startswith(target + '-') and f.endswith('.png'))
        if not mine:
            continue
        if not 6 <= len(mine) <= 8:
            bad.append(f'{dirpath}: {len(mine)} {target} screenshots')
        for f in mine:
            im = Image.open(os.path.join(dirpath, f))
            if im.size != size:
                bad.append(f'{dirpath}/{f}: {im.size}, expected {size}')
            elif im.mode != 'RGB':
                # The App Store refuses screenshots with an alpha channel.
                im.convert('RGB').save(os.path.join(dirpath, f), optimize=True)
        print(f'{os.path.relpath(dirpath, root)}: {len(mine)} x {size[0]}x{size[1]}')
# The banners (frame/frame.cjs, BANNERS): their sizes, no transparency either.
banners = {'apple-header.png': (3840, 1646), 'apple-search.png': (3840, 2560), 'featureGraphic.png': (1024, 500)}
for dirpath, _, files in os.walk(root):
    for f in files:
        if f in banners:
            p = os.path.join(dirpath, f)
            im = Image.open(p)
            if im.size != banners[f]:
                bad.append(f'{p}: {im.size}, expected {banners[f]}')
            elif im.mode != 'RGB':
                im.convert('RGB').save(p, optimize=True)
if bad:
    sys.exit('\n'.join(bad))
PY
