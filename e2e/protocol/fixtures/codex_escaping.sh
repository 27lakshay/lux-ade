#!/bin/sh
# The Codex mock with a watcher in its process group (escape_watcher.py). Once
# <mock dir>/escape-now exists, the watcher starts a descendant that leaves the
# group and is reparented to launchd within half a second, so the daemon's own
# 2-second observation usually misses it; only the runtime's tracking of the
# provider tree sees it. It writes <mock dir>/escaped.pid once it is orphaned.
here=$(dirname "$0")
python3 "$here/escape_watcher.py" "$ADE_MOCK_DIR" 0.5 &
exec python3 "$here/../../../scripts/fixtures/codex_mock.py" "$@"
