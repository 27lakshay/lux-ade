#!/usr/bin/env python3
"""Opt-in end-to-end check of installed, authenticated primary providers.

Uses a disposable ADE profile/workspace and the real provider executable or
bundled bridge. Never runs in the default fixture test suite.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

from paths import TARGET_DIR
from runtime import rpc
from runtime_test_support import track_runtime, cleanup_runtimes


def wait_for(check, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (FileNotFoundError, ConnectionRefusedError):
            pass
        time.sleep(0.1)
    raise TimeoutError("Timed out waiting for provider result")


def run(providers, seconds):
    results = []
    with tempfile.TemporaryDirectory(prefix="ade-live-provider-") as directory:
        root = Path(directory)
        socket = root / "daemon.sock"
        environment = dict(os.environ)
        for key in tuple(environment):
            if key.startswith("ADE_MOCK_") or key in ("ADE_CLAUDE_BRIDGE_BIN", "ADE_OMP_BIN", "ADE_OPENCODE_BIN"):
                environment.pop(key)
        environment.update({
            "ADE_SOCKET": str(socket), "ADE_DATA_DIR": str(root / "data"),
            "ADE_ROOT": str(root), "ADE_CODEX_TRANSPORT": "stdio", "SHELL": "/bin/sh",
        })
        daemon_binary = TARGET_DIR / "debug/ade-daemon"
        if not daemon_binary.is_file():
            raise RuntimeError("Build the daemon first with pnpm build:backend")
        with (root / "daemon.log").open("wb") as log:
            daemon = subprocess.Popen([str(daemon_binary)], env=environment,
                                      stdout=log, stderr=log, start_new_session=True)
            try:
                hello = wait_for(lambda: rpc(socket, {"op": "hello"}), 10)
                track_runtime(hello)
                catalog = rpc(socket, {"op": "catalog.get"})
                workspace = catalog["catalog"]["workspaces"][0]["id"]
                for provider in providers:
                    started = time.monotonic()
                    try:
                        created = rpc(socket, {"op": "conversation.create", "workspace_id": workspace,
                                               "provider": provider, "title": f"Live {provider}"})["conversation"]
                        conversation_id = created["id"]
                        rpc(socket, {"op": "agent.send", "conversation_id": conversation_id,
                                     "request_id": str(uuid.uuid4()),
                                     "text": "Reply with exactly ADE_LIVE_OK. Do not use tools."})
                        def completed():
                            snapshot = rpc(socket, {"op": "conversation.get", "conversation_id": conversation_id,
                                                    "limit": 100})
                            status = snapshot["conversation"]["status"]
                            return snapshot if status in ("ready", "error", "interrupted", "disconnected") else None
                        snapshot = wait_for(completed, seconds)
                        answer = "\n".join(message["text"] for message in snapshot["messages"]
                                           if message["role"] == "assistant")
                        status = snapshot["conversation"]["status"]
                        results.append({"provider": provider, "status": "pass" if status == "ready" and
                                        "ADE_LIVE_OK" in answer else "fail", "conversation_status": status,
                                        "elapsed_seconds": round(time.monotonic() - started, 2),
                                        "assistant_marker_seen": "ADE_LIVE_OK" in answer,
                                        "error": snapshot["conversation"].get("error")})
                    except Exception as error:
                        results.append({"provider": provider, "status": "fail",
                                        "elapsed_seconds": round(time.monotonic() - started, 2),
                                        "error": str(error)})
            finally:
                if daemon.poll() is None:
                    daemon.terminate()
                    try:
                        daemon.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        daemon.kill()
                        daemon.wait(timeout=5)
                cleanup_runtimes()
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("providers", nargs="+", choices=("codex", "claude", "omp"))
    parser.add_argument("--timeout", type=int, default=120)
    args = parser.parse_args()
    results = run(args.providers, args.timeout)
    print(json.dumps({"type": "live_provider_check", "results": results}, indent=2))
    if any(item["status"] != "pass" for item in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
