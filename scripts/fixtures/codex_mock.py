#!/usr/bin/env python3
"""Deterministic stdio app-server fixture; never invokes a model or shell tool."""
import json
import os
from pathlib import Path
import sys
import subprocess
import threading
import time
import uuid

root = Path(os.environ["ADE_MOCK_DIR"])
root.mkdir(parents=True, exist_ok=True)
thread = None
active = None
pending = {}
deferred_reply = None
usage_totals = {}
send_lock = threading.Lock()

def send(value):
    with send_lock:
        print(json.dumps(value), flush=True)

def note(method, params):
    send({"method": method, "params": params})

def record(value):
    with (root / "calls.jsonl").open("a") as file:
        file.write(json.dumps({"pid": os.getpid(), **value}) + "\n")

def save():
    path = root / (thread["id"] + ".json")
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(thread))
    temporary.replace(path)

def finish(status="completed"):
    active["status"] = status
    save()
    note("turn/completed", {"threadId": thread["id"], "turn": active})

# Interactive fixture executes directly inside lux-ade's owned PTY.
if len(sys.argv) > 1 and sys.argv[1] == "resume":
    session = sys.argv[2]
    (root / "tui.json").write_text(json.dumps({"pid": os.getpid(), "args": sys.argv[1:], "session": session}))
    print("Fixture terminal ready", flush=True)
    deadline = time.monotonic() + 60
    while not (root / "exit-tui").exists() and time.monotonic() < deadline:
        time.sleep(.02)
    thread = json.loads((root / (session + ".json")).read_text())
    thread["turns"].append({"id":"native-tui-turn", "status":"completed", "items":[{"id":"native-tui-answer", "type":"agentMessage", "text":"Written in the terminal"}]})
    save()
    sys.exit(0)

for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    params = message.get("params", {})
    rpc_id = message.get("id")
    if method is None:
        if str(rpc_id) in pending:
            record({"method": "approval/reply", "request_method": pending[str(rpc_id)], "result": message.get("result")})
            pending.pop(str(rpc_id))
            note("serverRequest/resolved", {"threadId": thread["id"], "requestId": rpc_id})
            finish()
        continue
    record({"method": method, "params": params})
    if method == "initialize":
        send({"id": rpc_id, "result": {"userAgent": "ade-test-fixture"}})
    elif method == "initialized":
        continue
    elif method == "thread/read":
        if params['threadId'] in ('fixture-child-running','fixture-child-completed'):
            child={'id':params['threadId'],'turns':[{'id':'child-turn','status':'completed','items':[{'id':'child-answer','type':'agentMessage','text':'Child Codex transcript'}]}]}
            send({'id':rpc_id,'result':{'thread':child}})
        else:
            send({'id':rpc_id,'error':{'code':-32000,'message':'Unknown child thread'}})
    elif method == "thread/start":
        thread = {"id": "mock-thread-" + str(uuid.uuid4()), "turns": []}
        save()
        send({"id": rpc_id, "result": {"thread": thread}})
    elif method == "thread/resume":
        if (root / "fail_resume").exists():
            send({"id": rpc_id, "error": {"code": -32000, "message": "Fixture resume refused"}})
        else:
            thread = json.loads((root / (params["threadId"] + ".json")).read_text())
            send({"id": rpc_id, "result": {"thread": thread}})
    elif method == "turn/start":
        text = params["input"][0]["text"]
        key = params["clientUserMessageId"]
        if text == "queue-admission":
            deadline=time.monotonic()+5
            while not (root/"release-admission").exists() and time.monotonic()<deadline:time.sleep(.01)
        if text == "hold-late" and deferred_reply is not None:
            send(deferred_reply)
            deferred_reply = None
            record({"method": "fixture/late-delivered", "next_submission": key})
            # B is accepted but has no provider turn ID yet. This exposes an A
            # response overwriting B, rather than a later B event masking the bug.
            time.sleep(0.4)
        user = {"id": "user-" + key, "type": "userMessage", "clientId": key,
                "content": [{"type": "text", "text": text}]}
        answer = {"id": "answer-" + key, "type": "agentMessage", "text": ""}
        active = {"id": "turn-" + key, "status": "inProgress", "items": [user, answer]}
        thread["turns"].append(active)
        note("turn/started", {"threadId": thread["id"], "turn": active})
        base = {"threadId": thread["id"], "turnId": active["id"]}
        if text == "typed-plan":
            note("turn/plan/updated", {**base, "explanation": "Verify structured persistence", "plan": [{"step": "Inspect", "status": "inProgress"}]})
            note("turn/plan/updated", {**base, "explanation": "Verify structured persistence", "plan": [{"step": "Inspect", "status": "completed"}]})
        if text in ("typed-tool", "typed-unknown", "demo"):
            command={"id":"command-"+key,"type":"commandExecution","command":"fixture command","cwd":"/fixture","aggregatedOutput":"","status":"inProgress"}
            note("item/started",{**base,"item":command})
            note("item/commandExecution/outputDelta",{**base,"itemId":command['id'],"delta":"fixture failure"})
            command.update(aggregatedOutput='fixture failure',exitCode=1,status='completed')
            active['items'].append(command)
            note("item/completed",{**base,"item":command})
        if text == "typed-unknown":
            private={"id":"reasoning-"+key,"type":"reasoning","text":"PRIVATE_REASONING"}
            active['items'].append(private)
            note("item/completed",{**base,"item":private})
            future={"id":"future-"+key,"type":"futurePreview","status":"completed",
                    "title":"Example preview","details":{"secret":"PRIVATE_NATIVE_PAYLOAD"}}
            active['items'].append(future)
            note("item/completed",{**base,"item":future})
        if text == "typed-subagents":
            children={"id":"children-"+key,"type":"collabAgentToolCall","tool":"spawnAgent","status":"completed","senderThreadId":thread['id'],"receiverThreadIds":["fixture-child-running","fixture-child-completed"],"agentsStates":{"fixture-child-running":{"status":"running"},"fixture-child-completed":{"status":"completed","message":"Child finished"}}}
            active['items'].append(children)
            note("item/completed",{**base,"item":children})
        note("item/completed", {**base, "item": user})
        note("item/started", {**base, "item": answer})
        response = ("## Welcome to lux-ade\n\nThis conversation uses a local fixture. No model account is needed.\n\n- Inspect the tool result above.\n- Review the pending approval below.\n- Open a terminal or browser from the empty split.\n\n```python\ndef greet(name):\n    return f\"Hello, {name}\"\n```\n\nYour draft and workspace belong to this isolated demo." if text == "demo" else "Hello world")
        for chunk in ([response[:len(response)//2], response[len(response)//2:]] if text == "demo" else ["Hello ", "world"]):
            note("item/agentMessage/delta", {**base, "itemId": answer["id"], "delta": chunk})
        answer["text"] = response
        if text.startswith("handoff-"):
            send({"id": rpc_id, "result": {"turn": active}})
            if text == "handoff-tool":
                tool = subprocess.Popen([sys.executable, "-c", """
import sys, time
from pathlib import Path
release, output = map(Path, sys.argv[1:3])
while not release.exists(): time.sleep(.02)
output.write_text('tool completed once')
""", str(root / "release-tool"), str(root / "tool-finished")])
                record({"method": "fixture/tool", "tool_pid": tool.pid})
                note("item/started", {**base, "item": {"id": "tool-"+key, "type": "commandExecution", "command": "fixture", "status": "inProgress"}})
                while not (root / "release-tool").exists(): time.sleep(.02)
                tool_exit = tool.wait(timeout=5)
                outcome = root / "tool-finished"
                if tool_exit != 0 or not outcome.exists():
                    note("item/completed", {**base, "item": {"id": "tool-"+key, "type": "commandExecution", "command": "fixture", "status": "failed", "aggregatedOutput": "tool did not survive"}})
                    finish("failed")
                    continue
                note("item/completed", {**base, "item": {"id": "tool-"+key, "type": "commandExecution", "command": "fixture", "status": "completed", "aggregatedOutput": outcome.read_text()}})
            else:
                for index in range(80):
                    chunk = f" [{index}]"
                    answer["text"] += chunk
                    note("item/agentMessage/delta", {**base, "itemId": answer["id"], "delta": chunk})
                    time.sleep(.04)
            note("item/completed", {**base, "item": answer}); finish()
            continue
        if text in ("approval", "approval-cancel", "approval-both", "approval-expire", "large-approval", "questions", "rich-questions", "permissions", "permissions-deny"):
            permission = "permission-" + key
            request_method = {"questions": "item/tool/requestUserInput",
                              "rich-questions": "item/tool/requestUserInput",
                              "permissions": "item/permissions/requestApproval",
                              "permissions-deny": "item/permissions/requestApproval"}.get(text, "item/commandExecution/requestApproval")
            pending[permission] = request_method
            request_params = {**base, "itemId": "command-" + key}
            if text == "rich-questions":
                request_params["questions"] = [
                    {"id": "choice", "question": "Choose a mode", "options": [
                        {"label": "Fast", "description": "A short response"},
                        {"label": "Thorough", "description": "A detailed response"}]},
                    {"id": "multiple", "question": "Choose features", "multiSelect": True, "options": [
                        {"label": "Read, write", "description": "One choice containing a comma"},
                        {"label": "Review", "description": "A second choice"}]},
                    {"id": "secret", "question": "Fixture secret", "isSecret": True},
                ]
            elif text == "questions":
                request_params["questions"] = [{"id": "first", "question": "First?"}, {"id": "second", "question": "Second?"}]
            elif text.startswith("permissions"):
                request_params["permissions"] = {"network": {"enabled": True}, "fileSystem": {"write": ["/fixture-only"]}}
            else:
                choices = (["accept", "cancel"] if text == "approval-cancel" else
                           ["accept", "decline", "cancel"] if text == "approval-both" else ["accept", "decline"])
                request_params.update(command=("x" * (256*1024) if text == "large-approval" else "echo fixture"),
                                      availableDecisions=choices)
            send({"id": permission, "method": request_method, "params": request_params})
            save()
            if text == "approval-expire":
                def expire():
                    while not (root / "expire-approval").exists(): time.sleep(.01)
                    if pending.pop(permission, None) is not None:
                        note("serverRequest/resolved", {"threadId": thread["id"], "requestId": permission})
                        finish()
                threading.Thread(target=expire, daemon=True).start()
        elif text in ("hold", "hold-late"):
            save()
        else:
            if text == "usage":
                # Thread running total plus the newest response, then a sparse account-wide limit update.
                last = {"totalTokens": 150, "inputTokens": 120, "cachedInputTokens": 20, "outputTokens": 30, "reasoningOutputTokens": 5}
                total = usage_totals.setdefault(thread["id"], {key: 0 for key in last})
                for key, value in last.items(): total[key] += value
                note("thread/tokenUsage/updated", {**base, "tokenUsage": {"total": dict(total), "last": last, "modelContextWindow": 200000}})
                note("account/rateLimits/updated", {"rateLimits": {"limitId": None, "planType": "pro", "primary": {"usedPercent": 42, "windowDurationMins": 300, "resetsAt": 4102444800}, "secondary": None}})
            note("item/completed", {**base, "item": answer})
            finish()
        if text in ("late-response", "late-error"):
            deferred_reply = ({"id": rpc_id, "error": {"code": -32000, "message": "Stale A error"}}
                              if text == "late-error" else {"id": rpc_id, "result": {"turn": json.loads(json.dumps(active))}})
            continue
        # Force events to commit before the turn/start response is delivered.
        time.sleep(0.12)
        send({"id": rpc_id, "result": {"turn": active}})
    elif method == "turn/interrupt":
        finish("interrupted")
        send({"id": rpc_id, "result": {}})
    elif method == "turn/steer":
        # Codex 0.157.0 accepts steering only for the active turn it names.
        if (root / "refuse-steer").exists():
            send({"id": rpc_id, "error": {"code": -32000, "message": "Fixture steer refused"}})
        elif active is None or active["status"] != "inProgress" or params.get("expectedTurnId") != active["id"]:
            send({"id": rpc_id, "error": {"code": -32000, "message": "Fixture has no matching active turn"}})
        else:
            key = params["clientUserMessageId"]
            steered = {"id": "user-" + key, "type": "userMessage", "clientId": key,
                       "content": [{"type": "text", "text": params["input"][0]["text"]}]}
            active["items"].append(steered)
            save()
            note("item/completed", {"threadId": thread["id"], "turnId": active["id"], "item": steered})
            send({"id": rpc_id, "result": {"turnId": active["id"]}})
    elif method == "thread/compact/start":
        if (root / "refuse-compact").exists():
            send({"id": rpc_id, "error": {"code": -32000, "message": "Fixture compaction refused"}})
        else:
            # The start is acknowledged at once; a contextCompaction item in
            # its own turn reports the result, as Codex does.
            send({"id": rpc_id, "result": {}})
            item = {"id": "compaction-" + str(uuid.uuid4()), "type": "contextCompaction"}
            active = {"id": "compact-turn-" + str(uuid.uuid4()), "status": "inProgress", "items": [item]}
            thread["turns"].append(active)
            base = {"threadId": thread["id"], "turnId": active["id"]}
            note("turn/started", {"threadId": thread["id"], "turn": active})
            note("item/started", {**base, "item": item})
            note("item/completed", {**base, "item": item})
            finish()
    else:
        send({"id": rpc_id, "error": {"code": -32601, "message": "Fixture unsupported method"}})
