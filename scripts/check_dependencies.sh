#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.ade/tools/bin:$PATH"
if ! command -v cargo-deny >/dev/null; then
 printf 'Run python3 scripts/install_tools.py first.\n' >&2
 exit 1
fi
# License approval is a separate project decision; do not silently apply defaults.
# Maintenance notices stay visible without being treated as known vulnerabilities.
# Vulnerability, unsoundness, yanked-package and unknown-source failures still block.
cargo deny --locked check --warn unmaintained --hide-inclusion-graph advisories bans sources
