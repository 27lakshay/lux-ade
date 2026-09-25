#!/bin/bash
# Build locally; signing and notarization are opt-in and never publish an artifact.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
mode="${1:---unsigned}"
case "$mode" in --unsigned|--signed) ;; *) printf 'Usage: %s [--unsigned|--signed]\n' "$0" >&2; exit 2 ;; esac
if [[ "$mode" == --signed ]]; then
 : "${ADE_SIGNING_IDENTITY:?Set the Developer ID Application signing identity}"
 : "${ADE_NOTARY_PROFILE:?Set an existing notarytool keychain profile}"
fi
bash "$script_dir/run.sh" --release --build-only
app="$project_dir/lux-ade.app"
mkdir -p "$project_dir/dist"
archive="$project_dir/dist/lux-ade-macos-arm64.zip"
build_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["build_id"])' "$app/Contents/Resources/build-manifest.json")"
symbols="$project_dir/dist/lux-ade-symbols-$build_id.zip"
ditto -c -k --sequesterRsrc --keepParent "$project_dir/dist/symbols/$build_id" "$symbols"
shasum -a 256 "$symbols" > "$symbols.sha256"
if [[ "$mode" == --signed ]]; then
 # Sign nested Mach-O files before signing the containing app, including SDK helpers.
 while IFS= read -r -d '' candidate; do
  if file -b "$candidate" | grep -q 'Mach-O'; then
   codesign --force --options runtime --timestamp --sign "$ADE_SIGNING_IDENTITY" "$candidate"
  fi
 done < <(find "$app" -type f -print0)
 codesign --force --options runtime --timestamp --sign "$ADE_SIGNING_IDENTITY" "$app"
 codesign --verify --deep --strict --verbose=2 "$app"
fi
ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
if [[ "$mode" == --signed ]]; then
 xcrun notarytool submit "$archive" --keychain-profile "$ADE_NOTARY_PROFILE" --wait
 xcrun stapler staple "$app"
 xcrun stapler validate "$app"
 ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
fi
shasum -a 256 "$archive" > "$archive.sha256"
printf 'Created %s\n' "$archive"
