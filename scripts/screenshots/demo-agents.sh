# Sourced by run.sh and ../store-screenshots/run.sh: builds protocol, agent
# and app (unless SKIP_BUILD=1, e.g. when dist/ is current), then starts three
# demo agents (red, yellow, green) on :8081-8083; the first serves the web UI.
# Needs ROOT and OUT set. Stops the agents on exit. DEMO_RELAY_URL gives the
# agents a relay address (nothing needs to listen there), so they offer push.
# Unix socket paths must stay short (about 100 bytes), so not under OUT.
SOCKETS=$(mktemp -d)

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  (cd "$ROOT/protocol" && npm run build >/dev/null)
  (cd "$ROOT/agent" && npm run build >/dev/null)
  (cd "$ROOT/app" && npx ng build >/dev/null)
fi

ORIGINS=http://localhost:8081
PIDS=()
start() { # port metrics-port scenario name [web]
  # A build tag and commit as CI bakes them into the image, so the screenshots show where they appear.
  (cd "$ROOT/agent" && exec env DEMO="$3" CLUSTER_NAME="$4" PORT="$1" METRICS_PORT="$2" PUBLIC_URL="http://localhost:$1" KUBERNANNY_BUILD=2026-11-25-16 KUBERNANNY_COMMIT=3d36a32c1f0e \
    CORS_ORIGINS="$ORIGINS" INTERNAL_SOCKET="$SOCKETS/$4.sock" ${DEMO_RELAY_URL:+RELAY_URL="$DEMO_RELAY_URL"} ${5:+WEB_ROOT="$ROOT/app/dist/app/browser"} node dist/main.js) >"$OUT/agent-$4.log" 2>&1 &
  PIDS+=($!)
}
start 8081 9181 broken homelab web
start 8082 9182 warning office
start 8083 9183 healthy staging
# Only the agents started here; a pattern kill would also hit unrelated processes.
trap 'kill "${PIDS[@]}" 2>/dev/null || true; rm -rf "$SOCKETS"' EXIT
sleep 4
