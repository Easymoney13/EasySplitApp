#!/usr/bin/env bash

set -uo pipefail

diagnostics_dir=${1:?diagnostics directory is required}
apk_path=${2:?APK path is required}
adb_bin=${ADB:-adb}
node_bin=${EASYSPLIT_NODE_BIN:-node}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
project_root=$(cd "$script_dir/../.." && pwd)

mkdir -p "$diagnostics_dir"

install_status=0
"$adb_bin" install -r "$apk_path" > "$diagnostics_dir/install.txt" 2>&1
install_status=$?

runtime_status=$install_status
if [[ $install_status -eq 0 ]]; then
  "$node_bin" "$project_root/.github/validation/native-android-runtime.mjs" \
    > "$diagnostics_dir/result.txt" 2>&1
  runtime_status=$?
else
  {
    printf 'ANDROID_RUNTIME_SETUP=FAIL\n'
    printf 'APK installation failed with exit code %s\n' "$install_status"
    sed -n '1,200p' "$diagnostics_dir/install.txt"
  } > "$diagnostics_dir/result.txt"
fi

printf '%s\n' "$runtime_status" > "$diagnostics_dir/exit-code.txt"
"$adb_bin" exec-out screencap -p > "$diagnostics_dir/final.png" 2> "$diagnostics_dir/screenshot-error.txt" || true
"$adb_bin" logcat -d -v threadtime > "$diagnostics_dir/logcat.txt" 2> "$diagnostics_dir/logcat-error.txt" || true

# The following workflow step is the sole pass/fail authority. Returning zero
# here guarantees it can inspect the captured validator status and diagnostics.
exit 0
