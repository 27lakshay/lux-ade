#!/usr/bin/env python3
"""Isolated durable-session smoke test. Uses a fake Codex; no paid model calls."""
from paths import PROJECT_ROOT, TARGET_DIR
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from runtime_test_support import track_runtime, cleanup_runtimes

PROJECT = Path(__file__).resolve().parents[1]
DAEMON = Path(os.environ.get("ADE_TEST_DAEMON", TARGET_DIR / 'debug/ade-daemon'))
MOCK = PROJECT / "scripts/fixtures/codex_mock.py"

def wait_until(check, label, timeout=12):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = check()
        if last:
            return last
        time.sleep(0.03)
    raise AssertionError(f"Timed out: {label}; last={last!r}")

with tempfile.TemporaryDirectory(prefix="ade-session-test-") as directory:
    root = Path(directory)
    workspace_a, workspace_b = root / "a", root / "b"
    workspace_a.mkdir(); workspace_b.mkdir()
    endpoint = str(root / "daemon.sock")
    environment = {**os.environ, "ADE_SOCKET": endpoint, "ADE_ROOT": str(workspace_a),
                   "ADE_DATA_DIR": str(root / "data"), "ADE_CODEX_BIN": str(MOCK),
                   "ADE_CODEX_TRANSPORT": "stdio", "ADE_MOCK_DIR": str(root / "mock"), "SHELL": "/bin/sh"}
    daemon = None
    log = (root / "daemon.log").open("a")
    subscriptions = []

    def connect():
        peer = socket.socket(socket.AF_UNIX)
        peer.settimeout(5)
        peer.connect(endpoint)
        return peer

    def rpc(op, **fields):
        with connect() as peer:
            peer.sendall((json.dumps({"op": op, **fields}) + "\n").encode())
            if op == "input":
                peer.sendall(b'{"op":"ping"}\n')
            line = peer.makefile("rb").readline()
            assert line, f"No response to {op}"
            return json.loads(line)

    def ok(op, **fields):
        result = rpc(op, **fields)
        assert result["type"] != "error", (op, result)
        return result

    def calls(method):
        path = root / "mock/calls.jsonl"
        return [r for line in (path.read_text().splitlines() if path.exists() else [])
                if (r := json.loads(line))["method"] == method]

    def start():
        global daemon
        daemon = subprocess.Popen([str(DAEMON)], env=environment, stdout=log, stderr=log,
                                  start_new_session=True)
        def ready():
            if daemon.poll() is not None:
                raise AssertionError((root / "daemon.log").read_text())
            try:
                return rpc("hello")["session_protocol"] == "ade-sessions-v1"
            except (OSError, KeyError):
                return False
        wait_until(ready, "daemon readiness")
        track_runtime(rpc("hello"))

    def stop():
        global daemon
        if daemon and daemon.poll() is None:
            daemon.terminate()
            try:
                daemon.wait(timeout=5)
            except subprocess.TimeoutExpired:
                daemon.kill(); daemon.wait(timeout=5)
        daemon = None
        for peer, reader in subscriptions:
            reader.close(); peer.close()
        subscriptions.clear()

    def snapshot(cid):
        return ok("conversation.get", conversation_id=cid, limit=200)

    def status(cid, expected):
        return wait_until(lambda: (value if (value := snapshot(cid))["conversation"]["status"] == expected else None), expected)

    try:
        start()
        catalog = ok("catalog.get")["catalog"]
        wa = catalog["workspaces"][0]
        wb = ok("workspace.open", path=str(workspace_b))["workspace"]
        ca = ok("conversation.create", workspace_id=wa["id"], title="A")["conversation"]
        cb = ok("conversation.create", workspace_id=wb["id"], title="B")["conversation"]
        ok("draft.save",conversation_id=ca["id"],window_id="draft-window",text="A unsent",revision=2)
        ok("draft.save",conversation_id=ca["id"],window_id="draft-window",text="stale",revision=1)
        assert ok("draft.get",conversation_id=ca["id"],window_id="draft-window")["draft"]["text"]=="A unsent"
        assert ok("draft.get",conversation_id=cb["id"],window_id="draft-window")["draft"]["text"]==""
        assert ok("draft.get",conversation_id=ca["id"],window_id="second-window")["draft"]["text"]==""
        ok("draft.save",conversation_id=ca["id"],window_id="cleared-window",text="Already submitted",revision=1)
        cleared=ok("draft.save",conversation_id=ca["id"],window_id="cleared-window",text="",revision=2)
        assert cleared["draft"]=={"text":"","revision":2},cleared
        window = dict(id="test-window", workspace_id=wa["id"], conversation_id=ca["id"],
                      browser_url="https://example.com", x=25, y=30, width=1200, height=800,
                      panes=dict(sidebar_visible=False, terminal_visible=True, browser_visible=False,
                                 sidebar_width=250., browser_width=360., terminal_height=220.))
        ok("window.save", window=window)
        window = ok("catalog.get")["catalog"]["windows"][0]
        peer = connect(); reader = peer.makefile("rb")
        peer.sendall(b'{"op":"session.subscribe"}\n')
        assert json.loads(reader.readline())["type"] == "catalog"
        subscriptions.append((peer, reader))
        assert ok("ping")["metrics"]["clients"] == 1
        assert (root / "data").stat().st_mode & 0o777 == 0o700
        assert (root / "data/sessions.sqlite").stat().st_mode & 0o777 == 0o600

        ok("agent.send", conversation_id=ca["id"], request_id="early", text="early")
        ok("agent.send", conversation_id=ca["id"], request_id="early", text="early")
        done = status(ca["id"], "ready")
        time.sleep(0.18)
        assert snapshot(ca["id"])["conversation"]["status"] == "ready", "late RPC regressed completed turn"
        assert len(calls("turn/start")) == 1
        assert [m["role"] for m in done["messages"]] == ["user", "assistant"]
        assert done["messages"][-1]["text"] == "Hello world"
        assert rpc("agent.send", conversation_id=ca["id"], request_id="early", text="different")["type"] == "error"

        ok("agent.send", conversation_id=ca["id"], request_id="approve", text="approval")
        waiting = status(ca["id"], "waiting")
        request = waiting["requests"][0]
        assert rpc("agent.answer", conversation_id=cb["id"], request_id=request["id"], decision="accept")["type"] == "error"
        ok("agent.answer", conversation_id=ca["id"], request_id=request["id"], decision="decline")
        status(ca["id"], "ready")
        assert calls("approval/reply")[-1]["result"] == {"decision": "decline"}
        assert rpc("agent.answer", conversation_id=ca["id"], request_id=request["id"], decision="accept")["type"] == "error"

        ok("agent.send", conversation_id=ca["id"], request_id="cancel", text="hold")
        status(ca["id"], "running")
        rival = subprocess.run([str(DAEMON)], env={**environment, "ADE_SOCKET": str(root / "rival.sock")},
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        assert rival.returncode != 0 and b"writer.lock" in rival.stderr
        assert snapshot(ca["id"])["conversation"]["status"] == "running", "rival writer performed recovery"
        ok("agent.cancel", conversation_id=ca["id"])
        status(ca["id"], "interrupted")
        assert len(calls("turn/interrupt")) == 1


        for case in ("late-response", "late-error"):
            akey, bkey = case + "-a", case + "-b"
            ok("agent.send", conversation_id=ca["id"], request_id=akey, text=case)
            status(ca["id"], "ready")
            ok("agent.send", conversation_id=ca["id"], request_id=bkey, text="hold-late")
            wait_until(lambda: any(c["next_submission"] == bkey for c in calls("fixture/late-delivered")), "late A RPC delivered")
            time.sleep(0.07)
            between = snapshot(ca["id"])["conversation"]
            assert between["status"] == "starting" and between["active_turn_id"] is None, (case, between)
            running = status(ca["id"], "running")
            assert running["conversation"]["active_turn_id"] == "turn-" + bkey
            ok("agent.cancel", conversation_id=ca["id"])
            status(ca["id"], "interrupted")

        for scenario in ("questions", "permissions", "permissions-deny"):
            ok("agent.send", conversation_id=ca["id"], request_id=scenario, text=scenario)
            waiting = status(ca["id"], "waiting")
            request = waiting["requests"][0]
            if scenario == "questions":
                assert rpc("agent.answer", conversation_id=ca["id"], request_id=request["id"],
                           decision="answer", answers={"first": "one"})["type"] == "error"
                ok("agent.answer", conversation_id=ca["id"], request_id=request["id"],
                   decision="answer", answers={"first": "one", "second": "two"})
                expected = {"answers": {"first": {"answers": ["one"]}, "second": {"answers": ["two"]}}}
            else:
                decision = "decline" if scenario.endswith("deny") else "accept"
                ok("agent.answer", conversation_id=ca["id"], request_id=request["id"], decision=decision)
                expected = {"permissions": {} if decision == "decline" else request["params"]["permissions"], "scope": "turn"}
            status(ca["id"], "ready")
            assert calls("approval/reply")[-1]["result"] == expected

        # Different workspace terminals must have distinct processes and environments.
        ma = ok("ping", workspace_id=wa["id"])["metrics"]
        mb = ok("ping", workspace_id=wb["id"])["metrics"]
        assert ma["shell_pid"] != mb["shell_pid"] and ma["terminal_id"] != mb["terminal_id"]
        ok("input", workspace_id=wa["id"], data="ADE_ISOLATION=only_a\nprintf 'A_VALUE:%s\\n' \"$ADE_ISOLATION\"\n")
        ok("input", workspace_id=wb["id"], data="printf 'B_VALUE:%s\\n' \"${ADE_ISOLATION-unset}\"\n")
        def terminal_contains(wid, text):
            data = ok("snapshot", workspace_id=wid)["terminal_screen_bytes"]
            return text in bytes(data).decode(errors="replace")
        wait_until(lambda: terminal_contains(wa["id"], "A_VALUE:only_a"), "workspace A shell")
        wait_until(lambda: terminal_contains(wb["id"], "B_VALUE:unset"), "workspace B isolation")

        # Losing the supervisor still requires explicit history reconciliation.
        ok("agent.send", conversation_id=ca["id"], request_id="restart", text="approval")
        waiting = status(ca["id"], "waiting")
        stale = waiting["requests"][0]["id"]
        provider_id = waiting["conversation"]["provider_thread_id"]
        reader.close(); peer.close(); subscriptions.clear()
        wait_until(lambda: ok("ping")["metrics"]["clients"] == 0, "subscription EOF cleanup")
        runtime_socket = ok("hello")["runtime_socket"]
        stop(); cleanup_runtimes()
        wait_until(lambda: not Path(runtime_socket).exists(), "supervisor exit")
        start()
        restored = snapshot(ca["id"])
        assert restored["conversation"]["status"] == "interrupted"
        assert restored["conversation"]["provider_thread_id"] == provider_id
        assert restored["requests"] == []
        assert ok("catalog.get")["catalog"]["windows"] == [window]
        ma2 = ok("ping", workspace_id=wa["id"])["metrics"]
        assert ma2["terminal_id"] == ma["terminal_id"] and ma2["run_id"] != ma["run_id"] and ma2["shell_pid"] != ma["shell_pid"]
        assert rpc("agent.answer", conversation_id=ca["id"], request_id=stale, decision="accept")["type"] == "error"
        prior_invocations = len(calls("turn/start"))
        ok("agent.send", conversation_id=ca["id"], request_id="restart", text="approval")
        assert len(calls("turn/start")) == prior_invocations
        before_ids = [m["id"] for m in restored["messages"]]
        assert rpc("agent.send", conversation_id=ca["id"], request_id="must-resume", text="new prompt")["type"] == "error"
        assert [m["id"] for m in snapshot(ca["id"])["messages"]] == before_ids
        ok("agent.resume", conversation_id=ca["id"])
        replay = status(ca["id"], "ready")
        assert [m["id"] for m in replay["messages"]] == before_ids
        interrupted_answer = next(m for m in replay["messages"] if m["provider_item_id"] == "answer-cancel")
        assert interrupted_answer["status"] != "completed", interrupted_answer
        unfinished_answer = next(m for m in replay["messages"] if m["provider_item_id"] == "answer-restart")
        assert unfinished_answer["status"] != "completed", unfinished_answer
        assert len(calls("thread/start")) == 1
        ok("agent.disconnect", conversation_id=ca["id"])
        stop(); (root / "mock/fail_resume").touch(); start()
        assert ok("draft.get",conversation_id=ca["id"],window_id="draft-window")["draft"]["text"]=="A unsent"
        assert ok("draft.get",conversation_id=ca["id"],window_id="cleared-window")["draft"]=={"text":"","revision":2}
        ok("agent.resume", conversation_id=ca["id"])
        failed = status(ca["id"], "error")
        # Unstructured provider text is classified before it reaches the GUI.
        assert "Provider rejected the operation" in failed["conversation"]["error"], failed["conversation"]["error"]
        assert "Fixture resume refused" not in failed["conversation"]["error"]
        assert failed["conversation"]["provider_thread_id"] == provider_id
        assert len(calls("thread/start")) == 1, "failed resume created a replacement thread"
        (root / "mock/fail_resume").unlink()
        cq=ok("conversation.create",workspace_id=wa["id"],title="Queue")["conversation"]["id"]
        ok("queue.pause",conversation_id=cq,paused=True)
        for key,text in (("q-first","hold"),("q-second","Second queued"),("q-removed","Never deliver")):
            ok("queue.enqueue",conversation_id=cq,request_id=key,text=text)
        ok("queue.cancel",conversation_id=cq,request_id="q-removed")
        ok("queue.enqueue",conversation_id=cq,request_id="q-removed",text="Never deliver")
        assert [q['id'] for q in snapshot(cq)['queued']]==['q-first','q-second']
        assert not snapshot(cq)['messages']
        ok("queue.pause",conversation_id=cq,paused=False)
        status(cq,"running")
        assert [q['id'] for q in snapshot(cq)['queued']]==['q-second']
        ok("agent.cancel",conversation_id=cq);status(cq,"interrupted")
        assert snapshot(cq)['conversation']['queue_paused']
        stop();start()
        assert [q['id'] for q in snapshot(cq)['queued']]==['q-second']
        ok("agent.resume",conversation_id=cq);status(cq,"ready")
        assert [q['id'] for q in snapshot(cq)['queued']]==['q-second']
        ok("queue.pause",conversation_id=cq,paused=False)
        wait_until(lambda:any(m['id']=='q-second' for m in snapshot(cq)['messages']),"queued second dispatch")
        status(cq,"ready")
        assert [m['id'] for m in snapshot(cq)['messages'] if m['role']=='user']==['q-first','q-second']
        ok("queue.enqueue",conversation_id=cq,request_id="q-approval",text="approval")
        status(cq,"waiting")
        ok("queue.enqueue",conversation_id=cq,request_id="q-after-approval",text="After approval")
        ok("runtime.prepare_restart",boot_id=ok("hello")['boot_id']);daemon.wait(timeout=5);start()
        waiting=status(cq,"waiting")
        assert [q['id'] for q in waiting['queued']]==['q-after-approval']
        ok("agent.answer",conversation_id=cq,request_id=waiting['requests'][0]['id'],decision="accept")
        wait_until(lambda:any(m['id']=='q-after-approval' for m in snapshot(cq)['messages']),"approval-gated queue")
        status(cq,"ready")
        assert snapshot(cq)['queued']==[]
        ok("queue.pause",conversation_id=cq,paused=True)
        ok("queue.enqueue",conversation_id=cq,request_id="q-admission",text="queue-admission")
        ok("queue.enqueue",conversation_id=cq,request_id="q-after-admission",text="After admission")
        ok("queue.pause",conversation_id=cq,paused=False)
        wait_until(lambda:any(call['params'].get('clientUserMessageId')=='q-admission' for call in calls('turn/start')),"provider admission barrier")
        blocked=rpc("runtime.prepare_restart",boot_id=ok("hello")['boot_id'])
        assert blocked['type']=='error' and 'admitted' in blocked['message'],blocked
        (root/'mock/release-admission').touch()
        wait_until(lambda:any(m['id']=='q-after-admission' for m in snapshot(cq)['messages']),"queue after admission")
        status(cq,"ready")
        assert sum(call['params'].get('clientUserMessageId')=='q-admission' for call in calls('turn/start'))==1
        print("QUEUE_PASS: durable FIFO, pause/cancel, cancellation tombstones, daemon restart, approval gating and client-independent dispatch")
        print("PASS sessions: durable identity/layout, submission idempotency, early notifications, late-turn RPC fencing, stream order, command/question/permission approvals, cancel, interrupted replay, explicit resume gate, failed resume, workspace PTY isolation")
    except Exception:
        print((root / "daemon.log").read_text())
        raise
    finally:
        stop(); cleanup_runtimes(); log.close()
