#!/usr/bin/env bash

set -uo pipefail

output_dir=${1:?iOS smoke output directory is required}
udid=${2:?iOS simulator UDID is required}
xcrun_bin=${XCRUN:-xcrun}
mkdir -p "$output_dir"
result_file="$output_dir/result.txt"
exit_file="$output_dir/exit-code.txt"
status=0
: >"$result_file"

run_step() {
  local marker=$1
  shift
  if "$@"; then
    printf '%s=PASS\n' "$marker" >>"$result_file"
  else
    local step_status=$?
    printf '%s=FAIL (%s)\n' "$marker" "$step_status" >>"$result_file"
    status=1
  fi
}

run_step IOS_SIMULATOR_LAUNCH "$xcrun_bin" simctl launch "$udid" com.easysplit.app
sleep 3
run_step IOS_HOME_SCREENSHOT "$xcrun_bin" simctl io "$udid" screenshot "$output_dir/home.png"
run_step IOS_LIVE_DEEP_LINK_DISPATCH "$xcrun_bin" simctl openurl "$udid" 'easysplit://session/smoke-session?groupId=smoke-group#invite=smoke-token'
sleep 2
run_step IOS_LIVE_DEEP_LINK_SCREENSHOT "$xcrun_bin" simctl io "$udid" screenshot "$output_dir/live-deep-link.png"
"$xcrun_bin" simctl terminate "$udid" com.easysplit.app >/dev/null 2>&1 || true
run_step IOS_COLD_DEEP_LINK_DISPATCH "$xcrun_bin" simctl openurl "$udid" 'easysplit://group/smoke-group'
sleep 2
run_step IOS_COLD_DEEP_LINK_SCREENSHOT "$xcrun_bin" simctl io "$udid" screenshot "$output_dir/cold-deep-link.png"
"$xcrun_bin" simctl spawn "$udid" log show --style compact --last 3m --predicate 'process == "App"' >"$output_dir/app.log" 2>&1 || status=1

if grep -E 'Fatal error|SIGABRT|Terminating app due to uncaught exception' "$output_dir/app.log" >"$output_dir/crash-signatures.txt"; then
  printf 'IOS_CRASH_SCAN=FAIL\n' >>"$result_file"
  status=1
else
  printf 'IOS_CRASH_SCAN=PASS\n' >>"$result_file"
fi

printf '%s\n' "$status" >"$exit_file"
exit 0
