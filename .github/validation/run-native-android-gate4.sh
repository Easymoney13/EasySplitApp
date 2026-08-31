#!/usr/bin/env bash

set -uo pipefail

output_dir=${1:?Gate 4 output directory is required}
apk_path=${2:?Android APK path is required}
run_id=${3:?Gate 4 runId is required}
adb_bin=${ADB:-adb}
curl_bin=${CURL:-curl}
npm_bin=${NPM:-npm}
node_bin=${EASYSPLIT_NODE_BIN:-node}
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)
apk_path=$(cd "$(dirname "$apk_path")" && pwd)/$(basename "$apk_path")

server_log="$output_dir/gate4-server.log"
reporter_log="$output_dir/gate4-reporter.log"
db_path="$output_dir/gate4-db.json"
result_file="$output_dir/gate4-result.txt"
exit_file="$output_dir/gate4-exit-code.txt"

BILLSPLIT_DB_PATH="$db_path" \
  NODE_ENV=test \
  PORT=3000 \
  WS_SUBSCRIPTION_TIMEOUT_MS=30000 \
  "$npm_bin" run dev >"$server_log" 2>&1 &
server_pid=$!
"$node_bin" .github/validation/gate4-reporter.mjs serve "$output_dir" 3904 "$run_id" >"$reporter_log" 2>&1 &
reporter_pid=$!

cleanup() {
  kill "$server_pid" "$reporter_pid" 2>/dev/null || true
  wait "$server_pid" "$reporter_pid" 2>/dev/null || true
}

diagnostics() {
  "$adb_bin" exec-out screencap -p >"$output_dir/gate4-final.png" 2>"$output_dir/gate4-screenshot-error.txt" || true
  "$adb_bin" logcat -d -v threadtime >"$output_dir/gate4-logcat.txt" 2>"$output_dir/gate4-logcat-error.txt" || true
}

trap 'diagnostics; cleanup' EXIT
status=0

ready=false
for _ in $(seq 1 90); do
  if "$curl_bin" --silent --fail http://127.0.0.1:3000/api/network-ip >/dev/null \
    && "$curl_bin" --silent --fail http://127.0.0.1:3904/health >/dev/null; then
    ready=true
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null || ! kill -0 "$reporter_pid" 2>/dev/null; then
    status=70
    printf 'Gate 4 local services stopped before becoming ready\n' >"$result_file"
    break
  fi
  sleep 1
done

if [[ "$ready" != true && $status -eq 0 ]]; then
  status=71
  printf 'Gate 4 local services timed out before becoming ready\n' >"$result_file"
fi

if [[ $status -eq 0 ]]; then
  "$adb_bin" reverse tcp:3000 tcp:3000 >/dev/null 2>&1
  status=$?
fi
if [[ $status -eq 0 ]]; then
  "$adb_bin" reverse tcp:3904 tcp:3904 >/dev/null 2>&1
  status=$?
fi
if [[ $status -eq 0 ]]; then
  "$adb_bin" install -r "$apk_path" >"$output_dir/gate4-install.txt" 2>&1
  status=$?
fi
if [[ $status -eq 0 ]]; then
  "$adb_bin" shell pm clear com.easysplit.app >"$output_dir/gate4-clear.txt" 2>&1
  status=$?
fi
if [[ $status -eq 0 ]]; then
  "$adb_bin" logcat -c >/dev/null 2>&1
  "$adb_bin" shell am start -W \
    -a android.intent.action.VIEW \
    -c android.intent.category.BROWSABLE \
    -d 'easysplit://gate4' \
    -p com.easysplit.app >"$output_dir/gate4-launch.txt" 2>&1
  status=$?
fi

if [[ $status -ne 0 && ! -s "$result_file" ]]; then
  printf 'Gate 4 Android setup failed with exit code %s\n' "$status" >"$result_file"
fi

if [[ $status -eq 0 ]]; then
  "$node_bin" .github/validation/gate4-reporter.mjs wait \
    "$output_dir/android-result.json" android "$run_id" 180000 >"$result_file" 2>&1
  status=$?
fi

printf '%s\n' "$status" >"$exit_file"
diagnostics
trap - EXIT
cleanup

# The workflow evidence step is the sole pass/fail authority.
exit 0
