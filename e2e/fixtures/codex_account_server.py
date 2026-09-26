#!/usr/bin/env python3
"""External Codex app-server fixture for ADE account E2E; never uses a real token."""
import json
import os
from pathlib import Path
import sys
import time
import uuid

home = Path(os.environ["CODEX_HOME"])
if len(sys.argv) > 1 and sys.argv[1] == "--version":
    print((home / "version").read_text() if (home / "version").exists() else "codex-cli 0.157.0")
    sys.exit(0)

if sys.argv[1:] != ["app-server", "--listen", "stdio://"]:
    sys.exit(2)

def send(value):
    print(json.dumps(value), flush=True)

def record(method, params):
    with (home / "calls.jsonl").open("a") as output:
        output.write(json.dumps({"method": method, "params": params}) + "\n")

thread = None
for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    params = message.get("params", {})
    request_id = message.get("id")
    record(method, params)
    if method == "initialize":
        (home / "environment.json").write_text(json.dumps({
            "codex_home": os.environ.get("CODEX_HOME"),
            "openai_key": bool(os.environ.get("OPENAI_API_KEY")),
            "codex_key": bool(os.environ.get("CODEX_API_KEY")),
            "wif": bool(os.environ.get("CODEX_AWS_BEARER_TOKEN")),
        }))
        send({"id": request_id, "result": {"userAgent": "ade-fixture", "codexHome": str(home)}})
    elif method == "initialized":
        continue
    elif method == "config/read":
        mode = (home / "config-mode").read_text().strip() if (home / "config-mode").exists() else "file"
        gateway = (home / "gateway").read_text().strip() if (home / "gateway").exists() else "https://chatgpt.com/backend-api/"
        send({"id": request_id, "result": {"config": {
            "cli_auth_credentials_store": mode, "model_provider": None, "chatgpt_base_url": gateway}}})
    elif method == "account/read":
        if (home / "delay").exists():
            (home / "probe-started").write_text("yes")
            while not (home / "continue").exists():
                time.sleep(.01)
        if not (home / "auth.json").exists() or not (home / "identity.json").exists():
            send({"id": request_id, "result": {"account": None, "requiresOpenaiAuth": True, "workspaceRouting": None}})
            continue
        identity = json.loads((home / "identity.json").read_text())
        routing = None if (home / "no-routing").exists() else {"chatgptAccountId": identity["accountId"]}
        send({"id": request_id, "result": {"account": {"type": identity.get("type", "chatgpt"),
            "email": identity.get("email")}, "requiresOpenaiAuth": True, "workspaceRouting": routing}})
    elif method == "thread/start":
        thread = "fixture-thread-" + str(uuid.uuid4())
        send({"id": request_id, "result": {"thread": {"id": thread, "turns": []}}})
    elif method == "thread/resume":
        thread = params["threadId"]
        send({"id": request_id, "result": {"thread": {"id": thread, "turns": []}}})
    elif method == "turn/start":
        turn = "fixture-turn-" + str(uuid.uuid4())
        send({"method": "turn/started", "params": {"threadId": thread, "turn": {"id": turn}}})
        send({"id": request_id, "result": {"turn": {"id": turn}}})
        send({"method": "turn/completed", "params": {"threadId": thread,
            "turn": {"id": turn, "status": "completed"}}})
    elif method == "turn/interrupt":
        send({"id": request_id, "result": {}})
    elif request_id is not None:
        send({"id": request_id, "error": {"code": -32601, "message": "unsupported fixture method"}})
