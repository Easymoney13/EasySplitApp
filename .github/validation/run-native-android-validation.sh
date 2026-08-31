#!/usr/bin/env bash

set -uo pipefail

output_root=${1:?Android diagnostics root is required}
gate4_apk_path=${2:?Gate 4 Android APK path is required}
gate3_apk_path=${3:?Gate 3 Android APK path is required}
run_id=${4:?Gate 4 runId is required}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
gate4_wrapper=${EASYSPLIT_GATE4_WRAPPER:-$script_dir/run-native-android-gate4.sh}
gate3_wrapper=${EASYSPLIT_GATE3_WRAPPER:-$script_dir/run-native-android-runtime.sh}
mkdir -p "$output_root"

bash "$gate4_wrapper" "$output_root/gate4" "$gate4_apk_path" "$run_id"
bash "$gate3_wrapper" "$output_root/gate3" "$gate3_apk_path"

# Each child records its own status. The workflow evidence step evaluates both.
exit 0
