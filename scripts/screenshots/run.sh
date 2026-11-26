#!/usr/bin/env bash
# Takes every screenshot in docs/screenshots: three demo agents (red, yellow,
# green) on :8081-8083, the web UI paired with all three, then one shot per
# distinct screen on phone, tablet and desktop, dark and light, plus the real
# terminal output of an agent. Needs Playwright with Chromium and Python 3 with Pillow.
# Shots named raw-* (QA views at large text and full HD, intermediate frames)
# stay in raw/ and are not copied to docs/screenshots.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
OUT=$(pwd)/raw
mkdir -p "$OUT"
export OUT
source ./demo-agents.sh

sed 's/\x1b\[[0-9;]*m//g' "$OUT/agent-homelab.log" | sed -n '/Kubernanny for/,/cli.js pair/p' >"$OUT/term-pairing.txt"
curl -s localhost:9181/metrics | head -30 >"$OUT/term-metrics.txt"

node capture.cjs
node terminal.cjs

# README-sized copies: phones 780 px wide, desktop 1600 px, 256 colours.
python3 - "$OUT" "$ROOT/docs/screenshots" <<'PY'
import os, sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
for f in sorted(os.listdir(src)):
    if not f.endswith('.png') or f.startswith('raw-'):
        continue
    im = Image.open(os.path.join(src, f))
    maxw = 1600 if any(k in f for k in ('desktop', 'tablet', 'terminal')) else 780
    if im.width > maxw:
        im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
    im.convert('RGB').quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(os.path.join(dst, f), optimize=True)
PY
echo "done: $(ls "$ROOT/docs/screenshots" | wc -l) screenshots"
