#!/usr/bin/env bash
# Runs the proxy + backend as native processes (no docker, no Google token),
# runs test/security.mjs against them, measures RSS, checks the logs for leaked
# secrets and the process tree for orphans.
#
# Needs: npm ci, and the backend venv in .venv:
#   uv venv --python 3.12 .venv
#   uv pip install --python .venv/bin/python --require-hashes -r requirements.txt
#
#   LOG_DIR   where the (chmod 600) proxy logs go; default: a fresh mktemp dir
#   PORT, BACKEND_PORT   default 3000 / 8080
#
# MCP_SECRET is generated per run, exported only to the child processes and
# never printed. The proxy log holds the client_secret line by design: never
# cat it, grep it.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${LOG_DIR:-$(mktemp -d)}"
PORT="${PORT:-3000}"
BACKEND_PORT="${BACKEND_PORT:-8080}"
BASE_URL="http://localhost:${PORT}"
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"
LOG="$LOG_DIR/proxy-1.log"
STORE_DIR="$(mktemp -d)"
FAIL=0
PIDS=()

say() { printf '%s\n' "$*"; }
fail() { say "FAIL  $*"; FAIL=1; }
pass() { say "PASS  $*"; }

rss_kb() { awk '/^VmRSS:/ {print $2}' "/proc/$1/status" 2>/dev/null || echo "?"; }

cleanup() {
  for p in "${PIDS[@]:-}"; do
    [ -n "$p" ] && kill -TERM -- "-$p" 2>/dev/null
  done
  sleep 1
  for p in "${PIDS[@]:-}"; do
    [ -n "$p" ] && kill -KILL -- "-$p" 2>/dev/null
  done
  rm -rf "$STORE_DIR"
}
trap cleanup EXIT

# Something else already answering on PORT would make wait_healthy pass and the
# suite run against the wrong server.
if curl -s -o /dev/null --max-time 2 "$BASE_URL/"; then
  say "port $PORT is already in use; set PORT (and BACKEND_PORT) to free ports"
  exit 2
fi

MCP_SECRET="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
CLIENT_SECRET="$(MCP_SECRET="$MCP_SECRET" node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.env.MCP_SECRET+":client_secret").digest("hex"))')"

# Starts the proxy in its own process group (setsid) so cleanup can take the
# whole tree. GOOGLE_ADS_MCP_OAUTH_* are set to dummies on purpose: they must
# never reach the backend (if they did, /mcp would demand FastMCP's Google
# OAuth and the security checks would fail).
start_proxy() {
  : > "$LOG"
  chmod 600 "$LOG"
  (
    cd "$REPO" || exit 1
    env -u GOOGLE_APPLICATION_CREDENTIALS \
      MCP_SECRET="$MCP_SECRET" \
      SERVER_URL="$BASE_URL" \
      TOKEN_STORE_PATH="$STORE_DIR/oauth-tokens.json" \
      PORT="$PORT" BACKEND_PORT="$BACKEND_PORT" \
      GOOGLE_ADS_MCP_OAUTH_CLIENT_ID=dummy-not-a-client \
      GOOGLE_ADS_MCP_OAUTH_CLIENT_SECRET=dummy-not-a-secret \
      setsid node server.js >> "$LOG" 2>&1 &
    echo $!
  )
}

wait_healthy() {
  for _ in $(seq 1 180); do
    curl -sf "$BASE_URL/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

backend_pid_of() { pgrep -P "$1" -f backend.py | head -1; }

# --- 1. fail-closed: the bundled default config (with write tools) must not start ---
say "== backend refuses a config with write tools"
BUNDLED="$("$REPO/.venv/bin/python" -I -c 'import importlib.resources as r; print(r.files("ads_mcp").joinpath("tools_config.yaml"))')"
if (cd "$REPO" && GOOGLE_ADS_MCP_TOOLS_CONFIG="$BUNDLED" BACKEND_PORT=$((BACKEND_PORT + 1)) \
      timeout 60 "$REPO/.venv/bin/python" -I backend.py > "$LOG_DIR/backend-default-config.log" 2>&1); then
  fail "backend started with the default (read-write) tools config"
else
  grep -q "refusing to start" "$LOG_DIR/backend-default-config.log" \
    && pass "backend exits on the default config (write tools present)" \
    || fail "backend exited, but not on the allowlist check"
fi

# --- 2. main run ---
say "== starting proxy + backend"
PROXY_PID="$(start_proxy)"
PIDS+=("$PROXY_PID")
if ! wait_healthy; then
  fail "proxy not healthy"; grep -v -i "client_secret" "$LOG" | tail -20; exit 1
fi
BACKEND_PID="$(backend_pid_of "$PROXY_PID")"
pass "healthy (proxy pid $PROXY_PID, backend pid ${BACKEND_PID:-?})"
grep -E "^Discovered|^Tools:" "$LOG"

ENV_LEAK="$(tr '\0' '\n' < "/proc/$BACKEND_PID/environ" | cut -d= -f1 \
  | grep -E '^(MCP_SECRET|GOOGLE_ADS_MCP_OAUTH_CLIENT_ID|GOOGLE_ADS_MCP_OAUTH_CLIENT_SECRET)$' || true)"
[ -z "$ENV_LEAK" ] && pass "backend env has no MCP_SECRET / GOOGLE_ADS_MCP_OAUTH_*" \
  || fail "backend env leaks: $ENV_LEAK"

sleep 3
say "RSS at rest: proxy $(rss_kb "$PROXY_PID") kB, backend $(rss_kb "$BACKEND_PID") kB"

say "== security checks"
BASE_URL="$BASE_URL" MCP_SECRET="$MCP_SECRET" EXPECT_ADC=missing node "$REPO/test/security.mjs" || FAIL=1

say "== load: 4 more passes of the suite"
for _ in 1 2 3 4; do
  BASE_URL="$BASE_URL" MCP_SECRET="$MCP_SECRET" EXPECT_ADC=missing node "$REPO/test/security.mjs" >/dev/null || FAIL=1
done
sleep 2
say "RSS after calls: proxy $(rss_kb "$PROXY_PID") kB, backend $(rss_kb "$BACKEND_PID") kB"
grep -E "^VmHWM" "/proc/$PROXY_PID/status" | sed 's/^/proxy  /'
grep -E "^VmHWM" "/proc/$BACKEND_PID/status" | sed 's/^/backend /'

say "== secrets in logs"
n_secret=$(grep -cF "$MCP_SECRET" "$LOG" || true)
n_client=$(grep -cF "$CLIENT_SECRET" "$LOG" || true)
n_uuid=$(grep -cE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$LOG" || true)
n_dummy=$(grep -cF "dummy-not-a-" "$LOG" || true)
[ "$n_secret" = 0 ] && pass "MCP_SECRET never logged" || fail "MCP_SECRET logged $n_secret time(s)"
[ "$n_client" = 1 ] && pass "client_secret only on the startup line" || fail "client_secret logged $n_client time(s)"
[ "$n_uuid" = 0 ] && pass "no full access/refresh token or auth code logged" || fail "$n_uuid full UUID(s) in the log"
[ "$n_dummy" = 0 ] && pass "GOOGLE_ADS_MCP_OAUTH_* values never logged" || fail "OAuth dummies logged"
# A tool that fails (no ADC) is logged by FastMCP as a handled error; what must
# not appear is a process dying or an unhandled exception in the proxy.
grep -qiE "exited with code|uncaught|unhandled|\[mcp\] POST error" "$LOG" \
  && fail "crash lines in the log" || pass "no crash in the log (proxy and backend alive)"
say "handled tool-error log lines: $(grep -ciE 'Traceback|Error calling tool' "$LOG" || true)"

# --- 3. lifecycle: SIGTERM to the proxy takes the backend down ---
say "== lifecycle"
kill -TERM "$PROXY_PID"
sleep 3
if kill -0 "$PROXY_PID" 2>/dev/null || kill -0 "$BACKEND_PID" 2>/dev/null; then
  fail "SIGTERM left a process behind"
else
  pass "SIGTERM on the proxy stops proxy and backend"
fi

# --- 4. lifecycle: backend dying takes the proxy down (container exits) ---
LOG="$LOG_DIR/proxy-2.log"
PROXY_PID="$(start_proxy)"
PIDS+=("$PROXY_PID")
wait_healthy || fail "second start not healthy"
BACKEND_PID="$(backend_pid_of "$PROXY_PID")"
kill -KILL "$BACKEND_PID"
sleep 2
if kill -0 "$PROXY_PID" 2>/dev/null; then
  fail "proxy survived the backend's death"
else
  pass "backend SIGKILL -> proxy exits"
fi

# --- 5. orphans ---
sleep 1
LEFT="$(pgrep -af "google-ads-mcp/(server\.js|backend\.py)|$REPO/(server\.js|backend\.py)|node server\.js|backend\.py" | grep -v pgrep || true)"
[ -z "$LEFT" ] && pass "no process left from this run" || { fail "processes left:"; say "$LEFT"; }

say ""
[ "$FAIL" = 0 ] && say "run-local: all passed" || say "run-local: FAILURES"
exit "$FAIL"
