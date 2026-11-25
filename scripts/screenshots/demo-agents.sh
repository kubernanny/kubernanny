# Sourced by run.sh and ../store-screenshots/run.sh: builds protocol, agent
# and app (unless SKIP_BUILD=1, e.g. when dist/ is current), then starts three
# demo agents (red, yellow, green) on :8081-8083; the first serves the web UI.
# Needs ROOT and OUT set. Stops the agents on exit.
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
  (cd "$ROOT/agent" && exec env DEMO="$3" CLUSTER_NAME="$4" PORT="$1" METRICS_PORT="$2" PUBLIC_URL="http://localhost:$1" \
    CORS_ORIGINS="$ORIGINS" INTERNAL_SOCKET="$SOCKETS/$4.sock" ${5:+WEB_ROOT="$ROOT/app/dist/app/browser"} node dist/main.js) >"$OUT/agent-$4.log" 2>&1 &
  PIDS+=($!)
}
start 8081 9181 broken homelab web
start 8082 9182 warning office
start 8083 9183 healthy staging
# Only the agents started here; a pattern kill would also hit unrelated processes.
trap 'kill "${PIDS[@]}" 2>/dev/null || true; rm -rf "$SOCKETS"' EXIT
sleep 4
