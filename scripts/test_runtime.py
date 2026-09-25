#!/usr/bin/env python3
"""Real PTYs across planned replacement and SIGKILL; no model calls or user data."""
from paths import PROJECT_ROOT, TARGET_DIR
import fcntl
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import uuid
import runtime as controller
from runtime_test_support import track_runtime, cleanup_runtimes

DAEMON = Path(os.environ.get("ADE_TEST_DAEMON", TARGET_DIR / 'release/ade-daemon'))

def wait(fn, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            value = fn()
            if value:
                return value
        except (ConnectionRefusedError, FileNotFoundError):
            pass
        time.sleep(0.02)
    raise AssertionError("Timed out")

with tempfile.TemporaryDirectory(prefix="ade-handoff-", dir="/tmp") as temporary:
    root = Path(temporary)
    data, home = root / "original-data", root / "stable"
    data.mkdir(); home.mkdir()
    endpoint = root / "app.sock"
    env = {**os.environ, "ADE_DATA_DIR": str(data), "ADE_SOCKET": str(endpoint),
           "ADE_ROOT": str(root), "SHELL": "/bin/sh", "ADE_CODEX_BIN": str(controller.PROJECT / "scripts/fixtures/codex_mock.py"),
           "ADE_CODEX_TRANSPORT": "stdio", "ADE_MOCK_DIR": str(root / "mock")}
    daemon = None
    log = (root / "daemon.log").open("ab")

    def rpc(op, **fields):
        return controller.rpc(endpoint, {"op": op, **fields})

    def denied(op, text, **fields):
        try:
            rpc(op, **fields)
        except RuntimeError as error:
            assert text in str(error), error
        else:
            raise AssertionError(f"{op} unexpectedly succeeded")

    def start():
        global daemon
        daemon = subprocess.Popen([str(DAEMON)], env=env, stdout=log, stderr=log, start_new_session=True)
        def ready():
            if daemon.poll() is not None:
                raise AssertionError((root / "daemon.log").read_text())
            return rpc("hello")
        value = wait(ready)
        track_runtime(value)
        return value

    def input(text):
        with socket.socket(socket.AF_UNIX) as peer:
            peer.settimeout(5); peer.connect(str(endpoint))
            peer.sendall((json.dumps({"op": "input", "data": text}) + '\n{"op":"ping"}\n').encode())
            assert json.loads(peer.makefile("rb").readline())["type"] == "metrics"

    def stop():
        if daemon and daemon.poll() is None:
            daemon.kill(); daemon.wait(timeout=5)

    try:
        first = start()
        assert controller.start(home,data,endpoint,DAEMON)["boot_id"]==first["boot_id"]
        initial = rpc("ping")["metrics"]
        input("export ADE_HANDOFF_VALUE=preserved; printf 'BEFORE_HANDOFF\\n'\n")
        wait(lambda: "BEFORE_HANDOFF" in rpc("snapshot").get("terminal", ""))
        workspace = rpc("catalog.get")["catalog"]["workspaces"][0]
        conversation = rpc("conversation.create", workspace_id=workspace["id"], title="Durable")['conversation']
        window = dict(id="retained-window", workspace_id=workspace["id"], conversation_id=conversation['id'],
                      browser_url="https://example.com", x=1, y=2, width=1100, height=800)
        rpc("window.save", window=window)
        persisted_window = rpc("catalog.get")['catalog']['windows'][0]
        assert all(persisted_window[key] == value for key,value in window.items())
        assert persisted_window['focused_pane'] == 5
        assert persisted_window['tabs']['terminals'] == []
        denied("runtime.prepare_restart", "changed", boot_id="stale")
        denied("terminal.restart", "Exit the current shell", workspace_id=workspace['id'])
        idle = socket.socket(socket.AF_UNIX); idle.connect(str(endpoint))
        idle.sendall(b'{"op":"hello"}\n')
        idle_reader=idle.makefile('rb'); assert json.loads(idle_reader.readline())['type']=='hello'

        # Adoption while the writer is alive must neither bind nor copy the store.
        try:
            controller.save_binding(home, data)
        except RuntimeError:
            pass
        else:
            raise AssertionError("Adopted an active store")
        assert not (home / "runtime.json").exists()
        try:
            controller.rpc(first['runtime_socket'], {"op":"owner.claim", "runtime_protocol":controller.RUNTIME_PROTOCOL,
                            "instance_id":first['runtime_instance'], "token":str(uuid.uuid4())})
        except RuntimeError as error:
            assert "Another application" in str(error)
        else:
            raise AssertionError("Stole a live runtime")
        # Existing streams must close at handoff so stale clients cannot mutate it.
        viewer = socket.socket(socket.AF_UNIX); viewer.settimeout(5); viewer.connect(str(endpoint))
        viewer.sendall(b'{"op":"subscribe","terminal":false}\n')
        old_reader = viewer.makefile("rb"); assert json.loads(old_reader.readline())["type"] == "snapshot"
        rpc("runtime.prepare_restart", boot_id=first['boot_id'])
        daemon.wait(timeout=5)
        idle_reader.close();idle.close()
        ticket = json.loads((data / "runtime-handoff.json").read_text())
        assert (data / "runtime-handoff.json").stat().st_mode & 0o777 == 0o600
        assert ticket['instance_id'] == first['runtime_instance']
        wait(lambda: old_reader.readline() == b'')
        old_reader.close(); viewer.close()
        wait(lambda: controller.rpc(first['runtime_socket'], {"op":"hello"}))
        try:
            controller.rpc(first['runtime_socket'], {"op":"owner.claim", "runtime_protocol":controller.RUNTIME_PROTOCOL,
                            "instance_id":first['runtime_instance'], "token":str(uuid.uuid4()),"ticket":"wrong"})
        except RuntimeError as error:
            assert "ticket" in str(error)
        else:
            raise AssertionError("Wrong ticket accepted")
        controller.save_binding(home, data)
        assert controller.binding(home) == data.resolve()
        assert not (home / "data").exists()
        second = start()
        assert first['boot_id'] != second['boot_id']
        assert first['runtime_instance'] == second['runtime_instance']
        assert not (data / "runtime-handoff.json").exists()
        current = rpc("ping")["metrics"]
        assert (current['shell_pid'], current['run_id']) == (initial['shell_pid'], initial['run_id'])
        assert current['terminal_bytes'] >= initial['terminal_bytes']
        input("printf 'AFTER:%s\\n' \"$ADE_HANDOFF_VALUE\"\n")
        wait(lambda: "AFTER:preserved" in rpc("snapshot").get("terminal", ""))
        assert rpc("catalog.get")['catalog']['windows'] == [persisted_window]
        # A connected idle Agent now survives planned replacement.
        rpc("agent.send", conversation_id=conversation['id'], request_id="provider-request", text="hello")
        wait(lambda: rpc("conversation.get", conversation_id=conversation['id'])['conversation']['status'] == 'ready')
        agent_pid = rpc("runtime.status")['agents'][0]['pid']
        rpc("runtime.prepare_restart", boot_id=second['boot_id']); daemon.wait(timeout=5)
        second = start()
        assert rpc("runtime.status")['agents'][0]['pid'] == agent_pid
        rpc("agent.disconnect", conversation_id=conversation['id'])
        # SIGKILL has no ticket; socket EOF releases ownership while PTYs survive.
        stop(); third = start()
        assert third['runtime_instance'] == first['runtime_instance']
        assert rpc("ping")['metrics']['shell_pid'] == initial['shell_pid']
        input("printf 'CRASH:%s\\n' \"$ADE_HANDOFF_VALUE\"\n")
        wait(lambda: "CRASH:preserved" in rpc("snapshot").get("terminal", ""))
        rpc("runtime.prepare_restart", boot_id=third['boot_id']); daemon.wait(timeout=5)
        # Simulate a schema-v1 store. Migration preserves identity/layout in place.
        with sqlite3.connect(data / "sessions.sqlite") as db:
            db.execute("DROP TABLE service_ports")
            db.execute("DROP TABLE services")
            db.execute("DROP TABLE schema_migrations")
            db.execute("DROP TABLE attachments")
            db.execute("DROP TABLE drafts")
            db.execute("DROP TABLE queued_prompts")
            db.execute("PRAGMA user_version=1")
            for cid, encoded in db.execute("SELECT id,data FROM conversations").fetchall():
                value = json.loads(encoded); value.pop('provider_config', None)
                db.execute("UPDATE conversations SET data=? WHERE id=?", (json.dumps(value), cid))
        fourth = start()
        assert rpc("conversation.get", conversation_id=conversation['id'])['conversation']['provider_config']['permission_mode'] == 'default'
        with sqlite3.connect(data / "sessions.sqlite") as db:
            assert db.execute("PRAGMA user_version").fetchone()[0] == 7
            assert db.execute("SELECT count(*) FROM schema_migrations").fetchone()[0] == 6
        assert rpc("ping")['metrics']['run_id'] == initial['run_id']
        # Exiting a shell releases its lease; only an explicit New shell resets it.
        input("exit\n")
        wait(lambda: rpc("ping")['metrics']['shell_running'] is False)
        rpc("terminal.restart",workspace_id=workspace['id'])
        replacement=rpc("ping")['metrics']
        assert replacement['run_id']!=initial['run_id'] and replacement['shell_running']
        initial=replacement
        # Controller performs a real boot-fenced replacement, preserving runtime.
        old_env = {key: os.environ.get(key) for key in ('ADE_ROOT','SHELL','ADE_CODEX_BIN','ADE_CODEX_TRANSPORT','ADE_MOCK_DIR')}
        try:
            os.environ.update({key:env[key] for key in old_env})
            result = controller.restart(home, data, endpoint, DAEMON)
            track_runtime(result)
            assert result['runtime_instance'] == fourth['runtime_instance']
            assert rpc("ping")['metrics']['shell_pid'] == initial['shell_pid']
            rpc("runtime.prepare_restart", boot_id=result['boot_id'])
            def stopped():
                try:
                    with controller.locked(data, "writer.lock"):
                        return True
                except RuntimeError:
                    return False
            wait(stopped)
        finally:
            for key, value in old_env.items():
                if value is None: os.environ.pop(key, None)
                else: os.environ[key] = value
        print("PASS runtime: planned handoff, stale owner fencing, wrong ticket, same shell PID/environment/run ID, SIGKILL recovery, Agent handoff, adoption locks, schema migration, preserved layout, stable controller")
    except Exception:
        print((root / 'daemon.log').read_text())
        if (data / 'runtime.log').exists(): print((data / 'runtime.log').read_text())
        raise
    finally:
        stop(); cleanup_runtimes(); log.close()
