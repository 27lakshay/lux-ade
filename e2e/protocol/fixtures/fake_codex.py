#!/usr/bin/env python3
"""A scripted Codex CLI app-server for readiness, account and quota specs; never calls a model.

The installed wrapper answers `--version` itself. As `app-server` this script
answers the account probe (`initialize`, `config/read` and `account/read`) from
the account home ($CODEX_HOME/auth.json) without starting anything else, so a
probe stays fast. The first other message starts scripts/fixtures/codex_mock.py;
from then on messages go to it and its replies pass through unchanged, except
that `account/rateLimits/updated` reports exhaustion while ADE_MOCK_DIR/exhaust
exists. Each app-server start is logged to ADE_MOCK_DIR/launches.jsonl with the
CODEX_HOME it saw, so a spec can tell which account home a launch used.
While ADE_MOCK_DIR/per-home exists, each account home gets its own turn-mock
state directory, so two accounts can hold native threads with the same ID.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading

MOCK = Path(__file__).resolve().parents[3] / "scripts/fixtures/codex_mock.py"
mock_dir = Path(os.environ["ADE_MOCK_DIR"])
mock_dir.mkdir(parents=True, exist_ok=True)
args = sys.argv[1:]

if args[:1] != ["app-server"]:
    os.execv(sys.executable, [sys.executable, str(MOCK), *args])

home = os.environ.get("CODEX_HOME")
with (mock_dir / "launches.jsonl").open("a") as log:
    log.write(json.dumps({"pid": os.getpid(), "codex_home": home, "args": args}) + "\n")

lock = threading.Lock()
child = None
initialize = None


def out(line):
    with lock:
        sys.stdout.write(line if line.endswith("\n") else line + "\n")
        sys.stdout.flush()


def pump(stream, skip):
    for line in iter(stream.readline, ""):
        if skip is not None and json.loads(line).get("id") == skip:
            # The mock's answer to the replayed initialize; the caller already has one.
            skip = None
            continue
        if '"account/rateLimits/updated"' in line and (mock_dir / "exhaust").exists():
            message = json.loads(line)
            message["params"]["rateLimits"]["primary"]["usedPercent"] = 100
            line = json.dumps(message)
        out(line)


def start_mock():
    """Start the turn mock on the first message the account probe never sends."""
    global child
    state = mock_dir
    if (mock_dir / "per-home").exists() and home:
        state = mock_dir / "homes" / hashlib.sha256(home.encode()).hexdigest()[:16]
        state.mkdir(parents=True, exist_ok=True)
        if (mock_dir / "fixed-thread-id").exists():
            (state / "fixed-thread-id").touch()
    child = subprocess.Popen([sys.executable, str(MOCK), *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             text=True, bufsize=1, env={**os.environ, "ADE_MOCK_DIR": str(state)})
    skip = None
    if initialize is not None:
        skip = initialize["id"]
        child.stdin.write(json.dumps(initialize) + "\n")
        child.stdin.write(json.dumps({"method": "initialized", "params": {}}) + "\n")
    threading.Thread(target=pump, args=(child.stdout, skip), daemon=True).start()


def identity():
    try:
        stored = json.loads((Path(home or "") / "auth.json").read_text())
    except (OSError, ValueError):
        return {"account": None, "requiresOpenaiAuth": True}
    if not stored.get("email") or not stored.get("account_id"):
        return {"account": None, "requiresOpenaiAuth": True}
    return {"account": {"type": "chatgpt", "email": stored["email"]}, "requiresOpenaiAuth": True,
            "workspaceRouting": {"chatgptAccountId": stored["account_id"]}}


for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if child is None and method == "initialize":
        initialize = message
        out(json.dumps({"id": message["id"], "result": {"userAgent": "ade-test-fixture"}}))
    elif child is None and method == "initialized":
        continue
    elif method == "config/read":
        out(json.dumps({"id": message["id"], "result": {"config": {"cli_auth_credentials_store": "file",
            "model_provider": None, "chatgpt_base_url": "https://chatgpt.com/backend-api/"}}}))
    elif method == "account/read":
        out(json.dumps({"id": message["id"], "result": identity()}))
    else:
        if child is None:
            start_mock()
        child.stdin.write(line)
        child.stdin.flush()
if child is not None:
    child.stdin.close()
    child.wait()
