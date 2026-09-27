#!/usr/bin/env python3
"""The Codex mock behind a proxy that delivers a cancelled turn's stream late.

Every line passes through to scripts/fixtures/codex_mock.py unchanged. While
`<ADE_MOCK_DIR>/stale-stream` exists, the proxy remembers the turn a
`turn/interrupt` names. When the provider then starts another turn, the proxy
first passes that turn's `turn/started` through, and then sends what a slow
provider could still send for the cancelled turn: a text delta and a
completed message, an error, a question request and a failed completion,
all naming the old turn. It writes `stale-sent` with the new turn's ID.

The request it injects is answered by the client; the proxy keeps that answer
from the mock and writes `stale-request-answered` with it.

It never calls a model.
"""
import json
import os
import subprocess
import sys
import threading
from pathlib import Path

root = Path(os.environ["ADE_MOCK_DIR"])
root.mkdir(parents=True, exist_ok=True)
mock = Path(__file__).resolve().parents[3] / "scripts" / "fixtures" / "codex_mock.py"
child = subprocess.Popen([sys.executable, str(mock), *sys.argv[1:]], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, text=True, bufsize=1)
write_lock = threading.Lock()
cancelled = {}
STALE_REQUEST = "stale-request"


def emit(value):
    line = value if isinstance(value, str) else json.dumps(value)
    with write_lock:
        sys.stdout.write(line if line.endswith("\n") else line + "\n")
        sys.stdout.flush()


def stale(thread, turn):
    base = {"threadId": thread, "turnId": turn}
    item = {"id": "stale-answer", "type": "agentMessage", "text": "Stale text from the cancelled turn"}
    emit({"method": "item/agentMessage/delta", "params": {**base, "itemId": item["id"], "delta": item["text"]}})
    emit({"method": "item/completed", "params": {**base, "item": item}})
    emit({"method": "error", "params": {**base, "willRetry": False,
                                        "error": {"message": "Stale failure of the cancelled turn"}}})
    emit({"id": STALE_REQUEST, "method": "item/tool/requestUserInput",
          "params": {**base, "itemId": "stale-question", "questions": [{"id": "stale", "question": "Stale?"}]}})
    emit({"method": "turn/completed", "params": {"threadId": thread, "turn": {
        "id": turn, "status": "failed", "items": [], "error": {"message": "Stale failure of the cancelled turn"}}}})


def pump():
    for line in child.stdout:
        emit(line)
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("method") == "turn/started" and cancelled:
            turn = message["params"]["turn"]["id"]
            if turn != cancelled["turn"]:
                stale(cancelled["thread"], cancelled["turn"])
                cancelled.clear()
                (root / "stale-sent").write_text(turn)


threading.Thread(target=pump, daemon=True).start()
for line in sys.stdin:
    message = json.loads(line)
    if message.get("id") == STALE_REQUEST and "method" not in message:
        (root / "stale-request-answered").write_text(json.dumps(message))
        continue
    if message.get("method") == "turn/interrupt" and (root / "stale-stream").exists():
        params = message.get("params", {})
        cancelled.update(thread=params.get("threadId"), turn=params.get("turnId"))
    child.stdin.write(line if line.endswith("\n") else line + "\n")
    child.stdin.flush()
child.stdin.close()
child.wait()
