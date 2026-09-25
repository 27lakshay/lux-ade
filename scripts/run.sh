#!/bin/bash
set -euo pipefail
build_only=false
profile=debug
for argument in "$@"; do
 case "$argument" in
  --build-only) build_only=true ;;
  --release) profile=release ;;
  *) printf 'Usage: %s [--release] [--build-only]\n' "$0" >&2; exit 2 ;;
 esac
done
script_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$project_dir/target}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}"
export ADE_ROOT="${ADE_ROOT:-$project_dir}"
pnpm --dir "$project_dir" install --frozen-lockfile --ignore-scripts
if [[ "$profile" == release ]]; then
 (cd "$project_dir" && cargo build --locked --release --workspace --bins --features ade-runtime/native-terminal)
else
 (cd "$project_dir" && cargo build --locked --workspace --bins --features ade-runtime/native-terminal)
fi
python3 "$script_dir/package.py" --profile "$profile"
[ "$build_only" != true ] || exit 0
exec python3 "$script_dir/runtime.py" start --daemon "$CARGO_TARGET_DIR/$profile/ade-daemon" --client "$project_dir/lux-ade.app/Contents/MacOS/ade-client"
