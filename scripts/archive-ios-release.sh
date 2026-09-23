#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

: "${EASYSPLIT_APPLE_TEAM_ID:?Set EASYSPLIT_APPLE_TEAM_ID to your Apple Developer Team ID}"

if [[ -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

bash scripts/verify-ios-release-toolchain.sh

# Store builds must pass the production-origin and clean-bundle checks before
# copying assets or invoking Apple's signing/provisioning tools. Do not rebuild
# between the audit and sync: that would package a different, unaudited bundle.
npm run verify:mobile-release
./node_modules/.bin/cap sync ios
node scripts/verify-mobile-release.mjs ios/App/App/public

ARCHIVE_PATH="${EASYSPLIT_IOS_ARCHIVE_PATH:-/tmp/EasySplit.xcarchive}"
rm -rf "$ARCHIVE_PATH"

xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  DEVELOPMENT_TEAM="$EASYSPLIT_APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
  archive

echo "EasySplit iOS archive created at: $ARCHIVE_PATH"
