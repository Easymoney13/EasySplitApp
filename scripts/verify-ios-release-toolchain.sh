#!/usr/bin/env bash
set -euo pipefail

MIN_XCODE_MAJOR=26
MIN_IOS_SDK_MAJOR=26

if ! command -v xcodebuild >/dev/null 2>&1 || ! xcodebuild -version >/dev/null 2>&1; then
  echo "A full Xcode installation is required for an EasySplit App Store build." >&2
  exit 2
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "xcrun is required for an EasySplit App Store build." >&2
  exit 2
fi

XCODE_VERSION="$(xcodebuild -version | awk 'NR == 1 { print $2 }')"
IOS_SDK_VERSION="$(xcrun --sdk iphoneos --show-sdk-version)"
XCODE_MAJOR="${XCODE_VERSION%%.*}"
IOS_SDK_MAJOR="${IOS_SDK_VERSION%%.*}"

case "$XCODE_MAJOR:$IOS_SDK_MAJOR" in
  *[!0-9:]*|'')
    echo "Could not parse Xcode/iPhoneOS SDK versions: Xcode=$XCODE_VERSION SDK=$IOS_SDK_VERSION" >&2
    exit 2
    ;;
esac
if (( XCODE_MAJOR < MIN_XCODE_MAJOR )); then
  echo "EasySplit App Store builds require Xcode ${MIN_XCODE_MAJOR}+; found ${XCODE_VERSION}." >&2
  exit 2
fi

if (( IOS_SDK_MAJOR < MIN_IOS_SDK_MAJOR )); then
  echo "EasySplit App Store builds require the iPhoneOS ${MIN_IOS_SDK_MAJOR}+ SDK; found ${IOS_SDK_VERSION}." >&2
  exit 2
fi

printf 'EasySplit iOS release toolchain PASS (Xcode %s, iPhoneOS SDK %s)\n' \
  "$XCODE_VERSION" "$IOS_SDK_VERSION"
