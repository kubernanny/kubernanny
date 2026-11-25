#!/usr/bin/env bash
# Store screenshots for the App Store and Google Play: the demo agents of
# scripts/screenshots (red, yellow, green), the web UI paired with all three,
# then eight screens per device size and language, written to
# fastlane/screenshots/ for `npm run store:screenshots`. Needs Playwright with
# Chromium and Python 3 with Pillow (docs/RELEASING.md, Screenshots).
#   SKIP_BUILD=1   use the existing dist/ of protocol, agent and app
#   CAPTIONS=0     the app full-screen, without the caption band
#   ONLY=iphone69,phone   only these sizes (iphone69, ipad13, phone, tablet)
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
OUT=$(pwd)/raw
mkdir -p "$OUT"
export OUT
# A relay address makes the agents offer push (the push screen); nothing listens there, nothing leaves the machine.
export DEMO_RELAY_URL=ws://localhost:9
source ../screenshots/demo-agents.sh

node capture.cjs

# Every file at its store size, 6 to 8 per folder, no transparency.
python3 - "$ROOT/fastlane/screenshots" <<'PY'
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
if bad:
    sys.exit('\n'.join(bad))
PY
