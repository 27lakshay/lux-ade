#!/usr/bin/env python3
"""The Codex mock behind a proxy that can flood a turn with output.

Every line passes through to scripts/fixtures/codex_mock.py unchanged, except
a `turn/start` whose text is `flood`: the mock receives it as `hold`, so it
starts a turn that stays active. Once `<ADE_MOCK_DIR>/flood-release` exists,
the proxy streams 640 completed agent messages of 64 KiB into that turn (about
40 MiB, more than the runtime's 32 MiB replay journal; each message stays below
the daemon's 1 MiB message limit), then writes
`flood-done`. It writes its own PID to `flood-proxy.pid`. It never calls a model.
"""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

root = Path(os.environ["ADE_MOCK_DIR"])
root.mkdir(parents=True, exist_ok=True)
(root / "flood-proxy.pid").write_text(str(os.getpid()))
mock = Path(__file__).resolve().parents[3] / "scripts" / "fixtures" / "codex_mock.py"
child = subprocess.Popen([sys.executable, str(mock), *sys.argv[1:]], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, text=True, bufsize=1)
write_lock = threading.Lock()
flood_keys = set()
CHUNKS = 640


def emit(line):
    with write_lock:
        sys.stdout.write(line if line.endswith("\n") else line + "\n")
        sys.stdout.flush()


def flood(base, key):
    while not (root / "flood-release").exists():
        time.sleep(0.02)
    chunk = "x" * 65536
    for index in range(CHUNKS):
        item = {"id": "flood-%s-%d" % (key, index), "type": "agentMessage", "text": chunk}
        emit(json.dumps({"method": "item/completed", "params": {**base, "item": item}}))
    (root / "flood-done").write_text("")


def pump():
    for line in child.stdout:
        emit(line)
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("method") == "turn/started":
            params = message["params"]
            turn = params["turn"]["id"]
            key = turn[len("turn-"):]
            if key in flood_keys:
                base = {"threadId": params["threadId"], "turnId": turn}
                threading.Thread(target=flood, args=(base, key), daemon=True).start()


threading.Thread(target=pump, daemon=True).start()
for line in sys.stdin:
    message = json.loads(line)
    if message.get("method") == "turn/start" and message["params"]["input"][0]["text"] == "flood":
        flood_keys.add(message["params"]["clientUserMessageId"])
        message["params"]["input"][0]["text"] = "hold"
        line = json.dumps(message) + "\n"
    child.stdin.write(line)
    child.stdin.flush()
child.stdin.close()
child.wait()
