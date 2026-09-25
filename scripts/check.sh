#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.ade/tools/bin:$PATH"
if ! command -v cargo-nextest >/dev/null; then
 printf 'Run python3 scripts/install_tools.py before checking the workspace.\n' >&2
 exit 1
fi
cargo fmt --all --check
python3 scripts/check_architecture.py
cargo nextest run --locked --workspace --features ade-runtime/native-terminal --profile ci
cargo test --locked --workspace --features ade-runtime/native-terminal --doc
cargo clippy --locked --workspace --features ade-runtime/native-terminal --all-targets -- -D warnings
python3 -m unittest discover -s scripts -p 'test_bootstrap.py'
python3 -m unittest discover -s scripts -p 'test_build_identity.py'
python3 -m unittest discover -s scripts -p 'test_first_launch.py'
python3 scripts/test_native_accessibility.py
