#!/bin/sh
# The Codex mock as a provider group that is hard to stop: the provider
# ignores SIGTERM and SIGHUP (SIG_IGN survives exec), and it holds an escaped
# descendant (escapee.py) that ignores them too and has left the group.
here=$(dirname "$0")
trap '' TERM HUP
python3 "$here/escapee.py" "$ADE_MOCK_DIR" 0 &
exec python3 "$here/../../../scripts/fixtures/codex_mock.py" "$@"
