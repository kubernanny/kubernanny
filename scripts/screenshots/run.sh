#!/usr/bin/env bash
# Takes every screenshot in docs/screenshots: three demo agents (red, yellow,
# green) on :8081-8083, the web UI paired with all three, then each page, tab,
# sheet and dialog on phone, tablet and desktop, dark and light, plus the real
# terminal output of an agent. Needs Playwright with Chromium and Python 3 with Pillow.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
OUT=$(pwd)/raw
mkdir -p "$OUT"
export OUT
source ./demo-agents.sh

sed 's/\x1b\[[0-9;]*m//g' "$OUT/agent-homelab.log" | sed -n '/Kubernanny for/,/cli.js pair/p' >"$OUT/term-pairing.txt"
curl -s localhost:9181/metrics | head -30 >"$OUT/term-metrics.txt"
# The same end-to-end call the app makes, from a throwaway device key (demo agents let any key in).
(cd "$ROOT/agent" && node -e '
const p = require("@kubernanny/protocol");
(async () => {
  const { publicKey } = await (await fetch("http://localhost:8081/api/identity")).json();
  const sealed = p.sealRequest(p.generateKeyPair(), p.parsePublicKey(publicKey), { method: "GET", path: "/status", time: Date.now() });
  const res = await fetch("http://localhost:8081/api/e2e", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: sealed.body });
  process.stdout.write(new TextDecoder().decode(sealed.open(new Uint8Array(await res.arrayBuffer())).body));
})();') | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(json.dumps({"cluster": d["cluster"], "light": d["light"], "score": d["score"], "kubernetes": d["kubernetes"],
  "overview": {k: d["overview"][k] for k in ["nodes", "pods", "components", "prometheus"]},
  "issues": [{k: i[k] for k in ["id", "severity", "title", "actions"]} for i in d["issues"][:2]],
  "modules": ["… %d more" % len(d["modules"])]}, indent=2, ensure_ascii=False))' >"$OUT/term-api.txt"

node capture.cjs
node terminal.cjs

# README-sized copies: phones 780 px wide, desktop 1600 px, 256 colours.
python3 - "$OUT" "$ROOT/docs/screenshots" <<'PY'
import os, sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
for f in sorted(os.listdir(src)):
    if not f.endswith('.png'):
        continue
    im = Image.open(os.path.join(src, f))
    maxw = 1600 if any(k in f for k in ('desktop', 'tablet', 'terminal')) else 780
    if im.width > maxw:
        im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
    im.convert('RGB').quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(os.path.join(dst, f), optimize=True)
PY
echo "done: $(ls "$ROOT/docs/screenshots" | wc -l) screenshots"
