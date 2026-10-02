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
burst_after = None
usage_totals = {}
send_lock = threading.Lock()

def send(value):
    with send_lock:
        encoded = json.dumps(value)
        with (root / "frames.jsonl").open("a") as file:
            file.write(json.dumps({"pid": os.getpid(), "frame": value}) + "\n")
        print(encoded, flush=True)

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

if (root / "immediate-startup").exists():
    note("account/rateLimits/updated", {"rateLimits": {"limitId": None, "planType": "pro", "primary": {"usedPercent": 13, "windowDurationMins": 300, "resetsAt": 4102444800}, "secondary": None}})

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
            if burst_after is not None:
                # After the approval: more burst text, the tool's terminal state, an error, then the end.
                base, key, answer = burst_after
                burst_after = None
                for index in range(200):
                    chunk = f"After approval line {index}\n"
                    answer["text"] += chunk
                    note("item/agentMessage/delta", {**base, "itemId": answer["id"], "delta": chunk})
                command = {"id": "command-" + key, "type": "commandExecution", "command": "echo fixture", "cwd": "/fixture",
                           "aggregatedOutput": "BURST_TOOL_OUTPUT", "exitCode": 2, "status": "failed"}
                active["items"].append(command)
                note("item/completed", {**base, "item": command})
                note("item/completed", {**base, "item": answer})
                note("error", {**base, "error": {"message": "BURST_FIXTURE_ERROR"}, "willRetry": False})
                active["error"] = {"message": "BURST_FIXTURE_ERROR"}
                finish("failed")
                continue
            finish()
        continue
    record({"method": method, "params": params, "id": rpc_id})
    if method == "initialize":
        send({"id": rpc_id, "result": {"userAgent": "ade-test-fixture"}})
    elif method == "initialized":
        continue
    elif method == "thread/read":
        if params['threadId'] in ('fixture-child-running','fixture-child-completed'):
            child={'id':params['threadId'],'turns':[{'id':'child-turn','status':'completed','items':[{'id':'child-answer','type':'agentMessage','text':'Child Codex transcript'}]}]}
            send({'id':rpc_id,'result':{'thread':child}})
        elif thread is not None and params['threadId'] == thread['id']:
            source = json.loads((root / (thread['id'] + '.json')).read_text())
            read = dict(source) if params.get('includeTurns') else {**source, 'turns': []}
            mode = root / 'history-mode.json'
            if mode.exists(): read.update(json.loads(mode.read_text()))
            failure = root / 'history-failure.json'
            if failure.exists():
                send({'id': rpc_id, 'error': json.loads(failure.read_text())})
            elif not params.get('includeTurns') and (root / 'history-hold').exists():
                (root / 'history-held').write_text(str(rpc_id))
                def held_history(reply=read, request_id=rpc_id):
                    deadline = time.monotonic() + 15
                    while not (root / 'history-release').exists() and time.monotonic() < deadline: time.sleep(.01)
                    send({'id': request_id, 'result': {'thread': reply}})
                threading.Thread(target=held_history).start()
            else:
                send({'id':rpc_id,'result':{'thread':read}})
        else:
            send({'id':rpc_id,'error':{'code':-32000,'message':'Unknown child thread'}})
    elif method == "thread/items/list":
        source = json.loads((root / (params["threadId"] + ".json")).read_text())
        entries = [{"turnId": turn["id"], "item": item, "startedAtMs": 1700000000123,
                    "completedAtMs": 1700000000456 if turn.get("status") == "completed" else None}
                   for turn in source["turns"] for item in turn["items"]]
        cursor = params.get("cursor")
        offset = int(cursor.removeprefix("fixture-native:")) if cursor else 0
        limit = params.get("limit", 1)
        end = min(offset + limit, len(entries))
        send({"id": rpc_id, "result": {"data": entries[offset:end], "nextCursor": "fixture-native:" + str(end) if end < len(entries) else None, "backwardsCursor": None}})
    elif method == "thread/fork":
        # Codex 0.157.0 v2 ThreadForkParams: `lastTurnId` keeps the turns
        # through that turn, inclusive; it must name a persisted turn that is
        # not in progress. The fork is a new thread and the source stays
        # unchanged. Nothing else of thread/fork is emulated.
        path = root / (params["threadId"] + ".json")
        source = thread if thread is not None and thread["id"] == params["threadId"] else (
            json.loads(path.read_text()) if path.exists() else None)
        last = params.get("lastTurnId")
        ids = [turn["id"] for turn in source["turns"]] if source else []
        if source is None:
            send({"id": rpc_id, "error": {"code": -32600, "message": "no rollout found for thread id " + params["threadId"]}})
        elif last is not None and last not in ids:
            send({"id": rpc_id, "error": {"code": -32600, "message": f"lastTurnId '{last}' was not found in the source thread"}})
        elif last is not None and source["turns"][ids.index(last)]["status"] == "inProgress":
            send({"id": rpc_id, "error": {"code": -32600, "message": f"lastTurnId '{last}' identifies an in-progress turn"}})
        else:
            kept = source["turns"] if last is None else source["turns"][:ids.index(last) + 1]
            thread = {"id": "mock-thread-" + str(uuid.uuid4()), "turns": json.loads(json.dumps(kept))}
            save()
            send({"id": rpc_id, "result": {"thread": thread}})
            note("thread/started", {"thread": {**thread, "forkedFromId": source["id"]}})
    elif method == "model/list":
        # codex-cli 0.159 `Model` rows: reasoning levels differ by model. Two pages, as
        # `nextCursor` paginates natively. `refuse-model-list` leaves discovery unavailable.
        if (root / "refuse-model-list").exists():
            send({"id": rpc_id, "error": {"code": -32601, "message": "Fixture unsupported method"}})
            continue
        def model(name, efforts, default=False):
            return {"id": name, "model": name, "displayName": name.replace("-", " ").title(), "description": "Fixture model",
                    "hidden": False, "isDefault": default, "defaultReasoningEffort": "medium",
                    "supportedReasoningEfforts": [{"reasoningEffort": e, "description": e} for e in efforts]}
        if params.get("cursor") is None:
            send({"id": rpc_id, "result": {"data": [model("fixture-default-model", ["minimal", "low", "medium", "high"], True),
                                                    model("fixture-model-b", ["low", "medium", "high", "xhigh"])],
                                           "nextCursor": "page-2"}})
        else:
            send({"id": rpc_id, "result": {"data": [model("fixture-model-small", ["low", "medium"])], "nextCursor": None}})
    elif method == "thread/start":
        # A fixed ID lets two native stores (two accounts) hold threads with the same ID.
        fixed = (root / "fixed-thread-id").exists()
        thread = {"id": "mock-thread-shared" if fixed else "mock-thread-" + str(uuid.uuid4()), "turns": []}
        save()
        # Native Codex names the model in effect for the thread.
        send({"id": rpc_id, "result": {"thread": thread, "model": params.get("model") or "fixture-default-model"}})
    elif method == "thread/resume":
        if (root / "fail_resume").exists():
            send({"id": rpc_id, "error": {"code": -32000, "message": "Fixture resume refused"}})
        else:
            thread = json.loads((root / (params["threadId"] + ".json")).read_text())
            send({"id": rpc_id, "result": {"thread": thread, "model": params.get("model") or "fixture-default-model"}})
    elif method == "turn/start":
        text = params["input"][0]["text"]
        key = params["clientUserMessageId"]
        if text == "receipt-reject":
            send({"id": rpc_id, "error": {"code": -32000, "message": "Fixture definite turn refusal"}})
            continue
        if text == "receipt-malformed":
            send({"id": rpc_id, "result": {"turn": {"status": "inProgress"}}})
            continue
        if text == "receipt-disconnect":
            sys.exit(3)
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
        if text in ("typed-tool", "typed-unknown", "typed-summary-large-tool", "demo"):
            command={"id":"command-"+key,"type":"commandExecution","command":"fixture command","cwd":"/fixture","aggregatedOutput":"","status":"inProgress"}
            note("item/started",{**base,"item":command})
            output = "fixture failure\n" + "x" * 8000 + "\nTOOL_OUTPUT_TAIL_SENTINEL" if text == "typed-summary-large-tool" else "fixture failure"
            note("item/commandExecution/outputDelta",{**base,"itemId":command['id'],"delta":output})
            command.update(aggregatedOutput=output,exitCode=1,status='completed')
            active['items'].append(command)
            note("item/completed",{**base,"item":command})
        if text in ("typed-unknown", "typed-summary-large-tool"):
            private={"id":"reasoning-"+key,"type":"reasoning","text":"PRIVATE_REASONING"}
            active['items'].append(private)
            note("item/completed",{**base,"item":private})
            future={"id":"future-"+key,"type":"futurePreview","status":"completed",
                    "title":"Example preview","details":{"secret":"PRIVATE_NATIVE_PAYLOAD"}}
            active['items'].append(future)
            note("item/completed",{**base,"item":future})
        if text == "typed-summary-large-tool":
            reasoning = {"id": "public-reasoning-" + key, "type": "reasoning", "summary": [], "content": ["PRIVATE_REASONING"]}
            note("item/started", {**base, "item": reasoning})
            summary = "Checking the fixture command before answering."
            note("item/reasoning/summaryTextDelta", {**base, "itemId": reasoning["id"], "delta": summary, "summaryIndex": 0})
            note("item/reasoning/textDelta", {**base, "itemId": reasoning["id"], "delta": "PRIVATE_DELTA_REASONING", "contentIndex": 0})
            reasoning["summary"] = [summary]
            active["items"].append(reasoning)
            note("item/completed", {**base, "item": reasoning})
        if text == "typed-subagents":
            children={"id":"children-"+key,"type":"collabAgentToolCall","tool":"spawnAgent","status":"completed","senderThreadId":thread['id'],"receiverThreadIds":["fixture-child-running","fixture-child-completed"],"agentsStates":{"fixture-child-running":{"status":"running"},"fixture-child-completed":{"status":"completed","message":"Child finished"}}}
            active['items'].append(children)
            note("item/completed",{**base,"item":children})
        note("item/completed", {**base, "item": user})
        note("item/started", {**base, "item": answer})
        response = ("## Welcome to lux-ade\n\nThis conversation uses a local fixture. No model account is needed.\n\n- Inspect the tool result above.\n- Review the pending approval below.\n- Open a terminal or browser from the empty split.\n\n```python\ndef greet(name):\n    return f\"Hello, {name}\"\n```\n\nYour draft and workspace belong to this isolated demo." if text == "demo" else "Hello world")
        if text == "slow-stream":
            # Forty lines over about four seconds, so a reader can act while output arrives.
            response = "".join(f"Streaming line {index}\n" for index in range(40))
            chunks = [f"Streaming line {index}\n" for index in range(40)]
        else:
            chunks = [response[:len(response)//2], response[len(response)//2:]] if text == "demo" else ["Hello ", "world"]
        for chunk in chunks:
            note("item/agentMessage/delta", {**base, "itemId": answer["id"], "delta": chunk})
            if text == "slow-stream":
                time.sleep(0.1)
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
        if text == "burst-ordering":
            # A burst of text with no pause, then an approval request (see the reply handler).
            for index in range(400):
                chunk = f"Burst line {index}\n"
                answer["text"] += chunk
                note("item/agentMessage/delta", {**base, "itemId": answer["id"], "delta": chunk})
            burst_after = (base, key, answer)
        if text in ("approval", "burst-ordering", "approval-cancel", "approval-both", "approval-expire", "large-approval", "questions", "rich-questions", "permissions", "permissions-deny", "unsupported-request"):
            permission = "permission-" + key
            request_method = {"questions": "item/tool/requestUserInput",
                              "rich-questions": "item/tool/requestUserInput",
                              "permissions": "item/permissions/requestApproval",
                              "permissions-deny": "item/permissions/requestApproval",
                              "unsupported-request": "item/unknown/requestUnsupported"}.get(text, "item/commandExecution/requestApproval")
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
                request_params["questions"] = [
                    {"id": "first", "question": "First?", "isOther": True},
                    {"id": "second", "question": "Second?", "isOther": True},
                ]
            elif text.startswith("permissions"):
                request_params["permissions"] = {"network": {"enabled": True}, "fileSystem": {"write": ["/fixture-only"]}}
            else:
                choices = (["accept", "cancel"] if text == "approval-cancel" else
                           ["accept", "decline", "cancel"] if text == "approval-both" else ["accept", "decline"])
                request_params.update(command=("x" * (256*1024) if text == "large-approval" else "echo fixture"),
                                      availableDecisions=choices)
            send({"id": permission, "method": request_method, "params": request_params})
            save()
            if text in ("approval-expire", "unsupported-request"):
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
        # Notifications are flushed in protocol order before the submit reply.
        if (root / "hang-turn-reply").exists():
            # The provider never answers turn/start: whether it accepted the prompt is unknown.
            while True:
                time.sleep(1)
        if (root / "delay-turn-reply").exists():
            # Native Codex may finish the turn well before answering turn/start.
            time.sleep(0.5)
        send({"id": rpc_id, "result": {"turn": active}})
    elif method == "turn/interrupt":
        if (root / "refuse-interrupt").exists():
            # The provider refuses and the turn keeps running.
            send({"id": rpc_id, "error": {"code": -32000, "message": "Fixture interrupt refused"}})
            continue
        if (root / "defer-interrupt").exists():
            # Acknowledge now; the native turn ends only when the test releases it.
            def interrupt_later():
                while not (root / "finish-interrupt").exists(): time.sleep(.01)
                finish("interrupted")
            threading.Thread(target=interrupt_later, daemon=True).start()
        else:
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
            if (root / "compact-replay-tools").exists():
                # Some providers repeat earlier tool material while compacting: the same item
                # IDs and output, under the compaction turn. It is not a new execution.
                for earlier in thread["turns"][:-1]:
                    for tool in earlier["items"]:
                        if tool.get("type") == "commandExecution":
                            note("item/commandExecution/outputDelta", {**base, "itemId": tool["id"], "delta": tool.get("aggregatedOutput", "")})
                            note("item/completed", {**base, "item": tool})
            note("item/completed", {**base, "item": item})
            finish()
    else:
        send({"id": rpc_id, "error": {"code": -32601, "message": "Fixture unsupported method"}})
