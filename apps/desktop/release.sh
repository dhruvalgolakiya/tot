#!/bin/zsh
# Builds TOT.app signed with the Developer ID and notarized by Apple, so the .dmg in apps/desktop/release/ opens
# on any Mac without a Gatekeeper warning, plus the .zip, its .blockmap and latest-mac.yml the installed apps
# update from. Ends by listing what to upload; npm run app:publish (publish.sh) uploads it. Needs, on this
# Mac only (never in the repo):
#   ~/.private_keys/devid-application.p12   Developer ID Application certificate + key
#   keychain item "tot-devid-p12"            that .p12's password
#   ~/.private_keys/AuthKey_<id>.p8          App Store Connect API key used to notarize
set -euo pipefail
keys=$HOME/.private_keys
export CSC_LINK=$keys/devid-application.p12
export CSC_KEY_PASSWORD=$(security find-generic-password -s tot-devid-p12 -a tot -w)
export APPLE_API_KEY_ID=${APPLE_API_KEY_ID:-TT7M4F573V}
export APPLE_API_KEY=$keys/AuthKey_$APPLE_API_KEY_ID.p8
export APPLE_API_ISSUER=${APPLE_API_ISSUER:-6c24b6c2-bd17-4d52-abc6-e3cada287313}
cd "${0:A:h}"
version=$(node -p 'require("./package.json").version')
npm run app:build
# This version's only: release/ may still hold older builds. latest-mac.yml leaves the .dmg out, so stapling it
# here changes no checksum the apps check.
dmg=release/TOT-$version-arm64.dmg
xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$dmg"
spctl -a -vvv -t exec release/mac-arm64/TOT.app
./publish.sh --list
