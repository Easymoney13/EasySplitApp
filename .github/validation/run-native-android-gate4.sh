#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR=${1:?Gate 4 output directory is required}
APK_PATH=${2:?Android APK path is required}
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR=$(cd "$OUTPUT_DIR" && pwd)
APK_PATH=$(cd "$(dirname "$APK_PATH")" && pwd)/$(basename "$APK_PATH")

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
  adb exec-out screencap -p >"$OUTPUT_DIR/gate4-final.png" 2>/dev/null || true
  adb logcat -d >"$OUTPUT_DIR/gate4-logcat.txt" 2>&1 || true
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

adb reverse tcp:3000 tcp:3000
adb reverse tcp:3904 tcp:3904
adb install -r "$APK_PATH" >/dev/null
adb shell pm clear com.easysplit.app >/dev/null
adb logcat -c
adb shell am start -W \
  -a android.intent.action.VIEW \
  -c android.intent.category.BROWSABLE \
  -d 'easysplit://gate4' \
  -p com.easysplit.app >/dev/null
node .github/validation/gate4-reporter.mjs wait "$OUTPUT_DIR/android-result.json" android 180000
diagnostics
trap - EXIT
cleanup

bash .github/validation/run-native-android-runtime.sh "$OUTPUT_DIR" "$APK_PATH"
