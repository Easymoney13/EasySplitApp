#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR=${1:?Gate 4 output directory is required}
UDID=${2:?iOS simulator UDID is required}
mkdir -p "$OUTPUT_DIR"

SERVER_LOG="$OUTPUT_DIR/gate4-server.log"
REPORTER_LOG="$OUTPUT_DIR/gate4-reporter.log"
DB_PATH="$OUTPUT_DIR/gate4-db.json"

BILLSPLIT_DB_PATH="$DB_PATH" \
  NODE_ENV=test \
  PORT=3000 \
  WS_SUBSCRIPTION_TIMEOUT_MS=30000 \
  npm run dev >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
node .github/validation/gate4-reporter.mjs serve "$OUTPUT_DIR" 3904 >"$REPORTER_LOG" 2>&1 &
REPORTER_PID=$!

cleanup() {
  kill "$SERVER_PID" "$REPORTER_PID" 2>/dev/null || true
  wait "$SERVER_PID" "$REPORTER_PID" 2>/dev/null || true
}
diagnostics() {
  xcrun simctl io "$UDID" screenshot "$OUTPUT_DIR/gate4-final.png" >/dev/null 2>&1 || true
  xcrun simctl spawn "$UDID" log show --style compact --last 5m --predicate 'process == "App"' >"$OUTPUT_DIR/gate4-app.log" 2>&1 || true
}
trap 'diagnostics; cleanup' EXIT

for _ in $(seq 1 90); do
  if curl --silent --fail http://127.0.0.1:3000/api/network-ip >/dev/null \
    && curl --silent --fail http://127.0.0.1:3904/health >/dev/null; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null || ! kill -0 "$REPORTER_PID" 2>/dev/null; then
    echo 'Gate 4 local services stopped before becoming ready' >&2
    exit 1
  fi
  sleep 1
done
curl --silent --fail http://127.0.0.1:3000/api/network-ip >/dev/null
curl --silent --fail http://127.0.0.1:3904/health >/dev/null

xcrun simctl terminate "$UDID" com.easysplit.app >/dev/null 2>&1 || true
xcrun simctl launch "$UDID" com.easysplit.app | tee "$OUTPUT_DIR/gate4-launch.txt"
node .github/validation/gate4-reporter.mjs wait "$OUTPUT_DIR/ios-result.json" ios 180000
diagnostics
trap - EXIT
cleanup
