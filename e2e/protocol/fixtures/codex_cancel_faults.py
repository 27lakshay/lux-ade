#!/usr/bin/env python3
"""The Codex mock behind a proxy that makes a cancellation fail late.

Every line passes through to scripts/fixtures/codex_mock.py unchanged, except
while `<ADE_MOCK_DIR>/hold-interrupt-reply` exists: a `turn/interrupt` still
reaches the mock, which interrupts the turn and reports it, but the proxy
withholds the mock's reply. It writes `interrupt-held`, waits for
`release-interrupt`, and then answers the interrupt with an error. The caller
sees its cancellation fail only after the turn it named has ended and a
successor may be running.

It never calls a model.
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
mock = Path(__file__).resolve().parents[3] / "scripts" / "fixtures" / "codex_mock.py"
child = subprocess.Popen([sys.executable, str(mock), *sys.argv[1:]], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, text=True, bufsize=1)
write_lock = threading.Lock()
held = set()


def emit(value):
    line = value if isinstance(value, str) else json.dumps(value)
    with write_lock:
        sys.stdout.write(line if line.endswith("\n") else line + "\n")
        sys.stdout.flush()


def fail_late(request_id):
    (root / "interrupt-held").write_text("")
    while not (root / "release-interrupt").exists():
        time.sleep(0.02)
    emit({"id": request_id, "error": {"code": -32000, "message": "Fixture late interrupt failure"}})
    (root / "interrupt-failed").write_text("")


def pump():
    for line in child.stdout:
        try:
            message = json.loads(line)
        except ValueError:
            emit(line)
            continue
        if "method" not in message and str(message.get("id")) in held:
            held.discard(str(message.get("id")))
            threading.Thread(target=fail_late, args=(message["id"],), daemon=True).start()
            continue
        emit(line)


threading.Thread(target=pump, daemon=True).start()
for line in sys.stdin:
    message = json.loads(line)
    if message.get("method") == "turn/interrupt" and (root / "hold-interrupt-reply").exists():
        held.add(str(message.get("id")))
    child.stdin.write(line if line.endswith("\n") else line + "\n")
    child.stdin.flush()
child.stdin.close()
child.wait()
