#!/usr/bin/env python3
"""Native window/child-panel disposal against an isolated daemon."""
import os
from pathlib import Path
import subprocess
import tempfile
import time

from paths import TARGET_DIR
from runtime import rpc
from runtime_test_support import cleanup_runtimes, track_runtime


daemon_binary = Path(os.environ.get("ADE_TEST_DAEMON", TARGET_DIR / "debug/ade-daemon"))
client_binary = Path(os.environ.get("ADE_TEST_CLIENT", TARGET_DIR / "debug/ade-client"))
with tempfile.TemporaryDirectory(prefix="ade-view-lifetime-", dir="/tmp") as temporary:
    root = Path(temporary)
    data = root / "data"
    data.mkdir()
    endpoint = root / "app.sock"
    env = {**os.environ, "ADE_SOCKET": str(endpoint), "ADE_DATA_DIR": str(data),
           "ADE_ROOT": str(root), "ADE_RUNTIME_HOME": str(root / "runtime-home"),
           "SHELL": "/bin/sh"}
    with (root / "daemon.log").open("wb") as daemon_log:
        daemon = subprocess.Popen([str(daemon_binary)], env=env,
                                  stdout=daemon_log, stderr=daemon_log,
                                  start_new_session=True)
        try:
            deadline = time.monotonic() + 15
            while True:
                if daemon.poll() is not None:
                    raise AssertionError((root / "daemon.log").read_text())
                try:
                    track_runtime(rpc(endpoint, {"op": "hello"}))
                    break
                except (FileNotFoundError, ConnectionRefusedError):
                    assert time.monotonic() < deadline, "daemon did not start"
                    time.sleep(.03)
            result = subprocess.run([str(client_binary), "--ui-smoke"], env=env,
                                    capture_output=True, text=True, timeout=20)
            assert result.returncode == 0, result.stderr
            assert "UI_SMOKE_PASS: parent and child close; sibling survives" in result.stderr, result.stderr
            status = rpc(endpoint, {"op": "runtime.status"})
            assert status["connected_agents"] == 0
            print("PASS view lifetime: parent and native child dispose; sibling remains; final window quits")
        finally:
            if daemon.poll() is None:
                daemon.terminate()
                daemon.wait(timeout=5)
            cleanup_runtimes()
