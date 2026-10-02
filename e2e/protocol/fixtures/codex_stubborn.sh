#!/bin/sh
# The Codex mock as a provider group that is hard to stop: the provider
# ignores SIGTERM and SIGHUP (SIG_IGN survives exec), and it holds an escaped
# descendant (escapee.py) that ignores them too and has left the group. Only
# the first provider in a mock directory escapes, so a provider started after a
# recovery does not leave a second escapee nothing tracks.
here=$(dirname "$0")
trap '' TERM HUP
[ -e "$ADE_MOCK_DIR/escaped.pid" ] || python3 "$here/escapee.py" "$ADE_MOCK_DIR" 0 &
exec python3 "$here/../../../scripts/fixtures/codex_mock.py" "$@"
