#!/usr/bin/env python3
"""The Codex mock behind a proxy that adds two conversation faults.

Every line passes through to scripts/fixtures/codex_mock.py unchanged, except:

- A `turn/start` whose text is `large-message`: the mock receives it as
  `hold`. Once the mock has answered that `turn/start`, the proxy streams one
  agent message and one command output of LARGE_BYTES each (more than the
  daemon's 1 MiB message limit) in 64 KiB deltas, completes both items with
  their full text, and completes the turn. The agent text is `a` repeated,
  the command output `o` repeated.
- A `thread/compact/start` while `<ADE_MOCK_DIR>/hold-compact` exists: the
  proxy writes `compact-held` and forwards the call to the mock only once
  `release-compact` exists. The mock records the call only when it arrives.

It writes its own PID to `faults-proxy.pid`. It never calls a model.
"""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

LARGE_BYTES = 24 * 65536

root = Path(os.environ["ADE_MOCK_DIR"])
root.mkdir(parents=True, exist_ok=True)
(root / "faults-proxy.pid").write_text(str(os.getpid()))
mock = Path(__file__).resolve().parents[3] / "scripts" / "fixtures" / "codex_mock.py"
child = subprocess.Popen([sys.executable, str(mock), *sys.argv[1:]], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, text=True, bufsize=1)
write_lock = threading.Lock()
child_lock = threading.Lock()
# turn/start request ID -> the client key of a large-message turn.
large_requests = {}
# client key -> {"threadId", "turnId"} once the mock started the turn.
large_turns = {}


def emit(value):
    line = value if isinstance(value, str) else json.dumps(value)
    with write_lock:
        sys.stdout.write(line if line.endswith("\n") else line + "\n")
        sys.stdout.flush()


def to_child(line):
    with child_lock:
        child.stdin.write(line if line.endswith("\n") else line + "\n")
        child.stdin.flush()


def stream_large(base, key):
    chunk = 65536
    answer = {"id": "large-answer-" + key, "type": "agentMessage", "text": ""}
    emit({"method": "item/started", "params": {**base, "item": answer}})
    for _ in range(LARGE_BYTES // chunk):
        emit({"method": "item/agentMessage/delta", "params": {**base, "itemId": answer["id"], "delta": "a" * chunk}})
    answer["text"] = "a" * LARGE_BYTES
    emit({"method": "item/completed", "params": {**base, "item": answer}})
    command = {"id": "large-command-" + key, "type": "commandExecution", "command": "fixture large output",
               "cwd": "/fixture", "aggregatedOutput": "", "status": "inProgress"}
    emit({"method": "item/started", "params": {**base, "item": command}})
    for _ in range(LARGE_BYTES // chunk):
        emit({"method": "item/commandExecution/outputDelta",
              "params": {**base, "itemId": command["id"], "delta": "o" * chunk}})
    command.update(aggregatedOutput="o" * LARGE_BYTES, exitCode=0, status="completed")
    emit({"method": "item/completed", "params": {**base, "item": command}})
    emit({"method": "turn/completed", "params": {"threadId": base["threadId"],
          "turn": {"id": base["turnId"], "status": "completed", "items": []}}})
    (root / "large-done").write_text("")


def pump():
    for line in child.stdout:
        emit(line)
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("method") == "turn/started":
            turn = message["params"]["turn"]["id"]
            key = turn[len("turn-"):]
            if key in large_requests.values():
                large_turns[key] = {"threadId": message["params"]["threadId"], "turnId": turn}
        elif "method" not in message and str(message.get("id")) in large_requests:
            key = large_requests.pop(str(message.get("id")))
            stream_large(large_turns.pop(key), key)


def hold_compact(line):
    (root / "compact-held").write_text("")
    while not (root / "release-compact").exists():
        time.sleep(0.02)
    to_child(line)


threading.Thread(target=pump, daemon=True).start()
for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "turn/start" and message["params"]["input"][0]["text"] == "large-message":
        large_requests[str(message["id"])] = message["params"]["clientUserMessageId"]
        message["params"]["input"][0]["text"] = "hold"
        line = json.dumps(message) + "\n"
    elif method == "thread/compact/start" and (root / "hold-compact").exists():
        threading.Thread(target=hold_compact, args=(line,), daemon=True).start()
        continue
    to_child(line)
with child_lock:
    child.stdin.close()
child.wait()
