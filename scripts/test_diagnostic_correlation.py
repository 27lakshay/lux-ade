#!/usr/bin/env python3
"""Exercise safe client-facing trace keys through daemon, runtime, and provider."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import uuid

from paths import TARGET_DIR
from runtime import PROJECT, rpc
from runtime_test_support import cleanup_runtimes, track_runtime


def wait_for(check, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (FileNotFoundError, ConnectionRefusedError):
            pass
        time.sleep(0.03)
    raise AssertionError("Timed out waiting for diagnostic correlation")


def records(logs):
    return [json.loads(line)["fields"] for file in logs.glob("*.jsonl")
            for line in file.read_text().splitlines() if line]


daemon_binary = Path(os.environ.get("ADE_TEST_DAEMON", TARGET_DIR / "release/ade-daemon"))
with tempfile.TemporaryDirectory(prefix="ade-diagnostics-", dir="/tmp") as temporary:
    root = Path(temporary)
    data = root / "data"
    data.mkdir()
    endpoint = root / "app.sock"
    env = {**os.environ, "ADE_SOCKET": str(endpoint), "ADE_DATA_DIR": str(data),
           "ADE_ROOT": str(root), "SHELL": "/bin/sh",
           "ADE_CODEX_BIN": str(PROJECT / "scripts/fixtures/codex_mock.py"),
           "ADE_CODEX_TRANSPORT": "stdio", "ADE_MOCK_DIR": str(root / "mock")}
    with (root / "daemon.log").open("ab") as output:
        daemon = subprocess.Popen([str(daemon_binary)], env=env, stdout=output,
                                  stderr=output, start_new_session=True)
        try:
            def ready():
                if daemon.poll() is not None:
                    raise AssertionError((root / "daemon.log").read_text())
                return rpc(endpoint, {"op": "hello"})

            track_runtime(wait_for(ready))
            workspace = rpc(endpoint, {"op": "catalog.get"})["catalog"]["workspaces"][0]
            conversation = rpc(endpoint, {"op": "conversation.create",
                                          "workspace_id": workspace["id"],
                                          "provider": "codex"})["conversation"]
            diagnostic_id = "diag_" + str(uuid.uuid4())
            prompt = "diagnostic-private-prompt"
            rpc(endpoint, {"op": "agent.send", "conversation_id": conversation["id"],
                           "request_id": str(uuid.uuid4()), "text": prompt,
                           "diagnostic_id": diagnostic_id})
            wait_for(lambda: rpc(endpoint, {"op": "conversation.get",
                                           "conversation_id": conversation["id"]})
                     ["conversation"]["status"] == "ready")

            def correlated():
                events = records(data / "logs")
                run = next((e["run_id"] for e in events if e.get("event") == "rpc_run"
                            and e.get("diagnostic_id") == diagnostic_id), None)
                started = next((e for e in events if e.get("event") == "agent_run_started"
                                and e.get("run_id") == run), None)
                return (events, run, started) if started else None

            events, run, started = wait_for(correlated)
            assert any(e.get("event") == "rpc_started" and
                       e.get("diagnostic_id") == diagnostic_id for e in events)
            assert any(e.get("event") == "rpc_succeeded" and
                       e.get("diagnostic_id") == diagnostic_id for e in events)
            assert any(e.get("event") == "provider_started" and
                       e.get("pid") == started["pid"] for e in events)
            assert run.startswith("run_") and started["pid"] > 0

            with socket.socket(socket.AF_UNIX) as viewer:
                viewer.settimeout(5)
                viewer.connect(str(endpoint))
                viewer.sendall(b'{"op":"session.subscribe"}\n')
                assert json.loads(viewer.makefile("rb").readline())["type"] == "catalog"
            agents = rpc(endpoint, {"op": "runtime.status"})["agents"]
            assert any(agent["spec"]["run"] == run and agent["pid"] == started["pid"]
                       for agent in agents), "closing a viewer stopped its supervisor-owned Agent"

            report = root / "diagnostics.json"
            subprocess.run([str(daemon_binary), "--export-diagnostics", str(report)],
                           env=env, check=True, capture_output=True)
            exported = report.read_text()
            assert diagnostic_id in exported and run in exported
            assert prompt not in exported and str(root) not in exported
            assert any(e.get("event") == "agent_run_started" for e in json.loads(exported)["records"])
            print("PASS diagnostic correlation: request → run → provider PID; viewer close preserves Agent; export omits prompt and path")
        finally:
            if daemon.poll() is None:
                daemon.terminate()
                daemon.wait(timeout=5)
            cleanup_runtimes()
