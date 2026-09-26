#!/usr/bin/env python3
"""Opt-in end-to-end check of installed, authenticated primary providers.

Uses a disposable ADE profile/workspace and the real provider executable or
bundled bridge. Never runs in the default fixture test suite.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

from paths import TARGET_DIR
from runtime import rpc
from runtime_test_support import track_runtime, cleanup_runtimes


def wait_for(check, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (FileNotFoundError, ConnectionRefusedError):
            pass
        time.sleep(0.1)
    raise TimeoutError("Timed out waiting for provider result")


def intended_write(request, provider, target, marker):
    """Never approve a native request beyond the disposable probe's exact write."""
    params = request.get("params", {})
    command = f"printf '%s' '{marker}' > '{target}'"
    commands = {command, f"printf '%s' '{marker}' > {target}", f'/bin/zsh -lc "{command}"'}
    if provider == "codex":
        return (request.get("method") == "item/commandExecution/requestApproval" and
                params.get("command", "").strip() in commands)
    if provider == "claude" and request.get("method") == "claude/toolApproval":
        input_value = params.get("input", {})
        return ((params.get("tool") == "Bash" and input_value.get("command", "").strip() in commands) or
                (params.get("tool") == "Write" and input_value.get("file_path") == str(target) and
                 input_value.get("content", "").strip() == marker))
    return False


def run(providers, seconds, tool_probe=False, cancel_probe=False, approval_probe=False):
    results = []
    with tempfile.TemporaryDirectory(prefix="ade-live-provider-") as directory:
        root = Path(directory)
        socket = root / "daemon.sock"
        environment = dict(os.environ)
        for key in tuple(environment):
            if key.startswith("ADE_MOCK_") or key in ("ADE_CLAUDE_BRIDGE_BIN", "ADE_OMP_BIN", "ADE_OPENCODE_BIN"):
                environment.pop(key)
        environment.update({
            "ADE_SOCKET": str(socket), "ADE_DATA_DIR": str(root / "data"),
            "ADE_ROOT": str(root), "ADE_CODEX_TRANSPORT": "stdio", "SHELL": "/bin/sh",
        })
        daemon_binary = TARGET_DIR / "debug/ade-daemon"
        if not daemon_binary.is_file():
            raise RuntimeError("Build the daemon first with pnpm build:backend")
        with (root / "daemon.log").open("wb") as log:
            daemon = subprocess.Popen([str(daemon_binary)], env=environment,
                                      stdout=log, stderr=log, start_new_session=True)
            try:
                hello = wait_for(lambda: rpc(socket, {"op": "hello"}), 10)
                track_runtime(hello)
                catalog = rpc(socket, {"op": "catalog.get"})
                workspace = catalog["catalog"]["workspaces"][0]["id"]
                for provider in providers:
                    started = time.monotonic()
                    result = None
                    try:
                        marker = None
                        prompt = "Reply with exactly ADE_LIVE_OK. Do not use tools."
                        if tool_probe:
                            marker = f"ADE_TOOL_{uuid.uuid4().hex}"
                            target = root / "ade-live-tool-marker.txt"
                            target.write_text(marker + "\n")
                            prompt = (f"Read {target} with a file-reading tool. Reply with exactly "
                                      "the token in that file. Do not infer its contents or edit files.")
                        created = rpc(socket, {"op": "conversation.create", "workspace_id": workspace,
                                               "provider": provider, "title": f"Live {provider}"})["conversation"]
                        conversation_id = created["id"]
                        rpc(socket, {"op": "agent.send", "conversation_id": conversation_id,
                                     "request_id": str(uuid.uuid4()),
                                     "text": prompt})
                        def completed():
                            snapshot = rpc(socket, {"op": "conversation.get", "conversation_id": conversation_id,
                                                    "limit": 100})
                            status = snapshot["conversation"]["status"]
                            return snapshot if status in ("ready", "error", "interrupted", "disconnected") else None
                        snapshot = wait_for(completed, seconds)
                        answer = "\n".join(message["text"] for message in snapshot["messages"]
                                           if message["role"] == "assistant")
                        status = snapshot["conversation"]["status"]
                        expected = marker or "ADE_LIVE_OK"
                        tool_visible = any("tool" in str(message.get("kind", "")).lower() or
                                           "tool" in str(message.get("role", "")).lower()
                                           for message in snapshot["messages"])
                        passed = status == "ready" and expected in answer and (not tool_probe or tool_visible)
                        result = {"provider": provider, "status": "pass" if passed else "fail",
                                  "conversation_status": status, "tool_probe": tool_probe,
                                  "tool_visible": tool_visible if tool_probe else None,
                                  "message_kinds": sorted({str(message.get("kind", "")) for message in snapshot["messages"]}),
                                  "assistant_marker_seen": expected in answer,
                                  "error": snapshot["conversation"].get("error")}
                        if passed and cancel_probe:
                            rpc(socket, {"op": "agent.send", "conversation_id": conversation_id,
                                         "request_id": str(uuid.uuid4()),
                                         "text": "Use a shell tool to run `sleep 20` now. Wait for it to finish before replying."})
                            def current():
                                return rpc(socket, {"op": "conversation.get", "conversation_id": conversation_id,
                                                    "limit": 100})
                            def at_status(*states):
                                observed = current()
                                return observed if observed["conversation"]["status"] in states else None
                            wait_for(lambda: at_status("running", "waiting"), seconds)
                            rpc(socket, {"op": "agent.cancel", "conversation_id": conversation_id})
                            stopped = wait_for(lambda: at_status("interrupted", "error", "disconnected"), seconds)
                            result["cancel_status"] = stopped["conversation"]["status"]
                            rpc(socket, {"op": "agent.resume", "conversation_id": conversation_id})
                            wait_for(lambda: at_status("ready"), seconds)
                            rpc(socket, {"op": "agent.send", "conversation_id": conversation_id,
                                         "request_id": str(uuid.uuid4()),
                                         "text": "Reply with exactly ADE_RESUMED_OK. Do not use tools."})
                            def resumed_result():
                                observed = at_status("ready", "error", "interrupted", "disconnected")
                                if not observed:
                                    return None
                                answer = "\n".join(message["text"] for message in observed["messages"]
                                                   if message["role"] == "assistant")
                                return observed if "ADE_RESUMED_OK" in answer or observed["conversation"]["status"] != "ready" else None
                            resumed = wait_for(resumed_result, seconds)
                            resumed_answer = "\n".join(message["text"] for message in resumed["messages"]
                                                       if message["role"] == "assistant")
                            result["resumed_marker_seen"] = "ADE_RESUMED_OK" in resumed_answer
                            result["resume_status"] = resumed["conversation"]["status"]
                            if result["resume_status"] != "ready" or not result["resumed_marker_seen"]:
                                result["status"] = "fail"
                        if passed and approval_probe:
                            approval_target = root / f"ade-approval-{provider}.txt"
                            approval_marker = f"ADE_APPROVED_{uuid.uuid4().hex}"
                            approval_config = {"permission_mode": "read-only"} if provider == "codex" else {}
                            approval_conversation = rpc(socket, {"op": "conversation.create",
                                "workspace_id": workspace, "provider": provider,
                                "title": f"Approval {provider}", "provider_config": approval_config})["conversation"]["id"]
                            approval_command = f"printf '%s' '{approval_marker}' > '{approval_target}'"
                            rpc(socket, {"op": "agent.send", "conversation_id": approval_conversation,
                                "request_id": str(uuid.uuid4()),
                                "text": f"Use a shell tool to run exactly this command: {approval_command}. "
                                        "Ask for permission if needed; do not use another command or edit method."})
                            def approval_state():
                                observed = rpc(socket, {"op": "conversation.get",
                                               "conversation_id": approval_conversation, "limit": 100})
                                pending = [request for request in observed["requests"]
                                           if request["status"] == "pending"]
                                terminal = observed["conversation"]["status"] in (
                                    "ready", "error", "interrupted", "disconnected")
                                return (observed, pending) if pending or terminal else None
                            observed, pending = wait_for(approval_state, seconds)
                            result["native_approval_seen"] = bool(pending)
                            if pending:
                                if not intended_write(pending[0], provider, approval_target, approval_marker):
                                    result["unexpected_approval"] = {
                                        "method": pending[0].get("method"),
                                        "tool": pending[0].get("params", {}).get("tool"),
                                        "command": str(pending[0].get("params", {}).get("command", ""))[:500],
                                        "input": str(pending[0].get("params", {}).get("input", ""))[:500],
                                    }
                                    raise RuntimeError("Native approval did not match the intended disposable-file write")
                                request_id = pending[0]["id"]
                                answer = {"op": "agent.answer", "conversation_id": approval_conversation,
                                          "request_id": request_id, "decision": "accept"}
                                rpc(socket, answer)
                                rpc(socket, answer)
                                result["repeat_answer_acknowledged"] = True
                                try:
                                    rpc(socket, {**answer, "decision": "decline"})
                                    result["conflicting_answer_rejected"] = False
                                except RuntimeError as error:
                                    result["conflicting_answer_rejected"] = "conflict" in str(error).lower()
                                def approval_finished():
                                    snapshot = rpc(socket, {"op": "conversation.get",
                                                    "conversation_id": approval_conversation, "limit": 100})
                                    return snapshot if snapshot["conversation"]["status"] in (
                                        "ready", "error", "interrupted", "disconnected") else None
                                observed = wait_for(approval_finished, seconds)
                            result["approval_status"] = observed["conversation"]["status"]
                            result["approved_file_written"] = approval_target.is_file() and (
                                approval_target.read_text().strip() == approval_marker)
                            if not (result["native_approval_seen"] and result.get("repeat_answer_acknowledged")
                                    and result.get("conflicting_answer_rejected") and
                                    result["approval_status"] == "ready" and result["approved_file_written"]):
                                result["status"] = "fail"
                            decline_target = root / f"ade-declined-{provider}.txt"
                            decline_conversation = rpc(socket, {"op": "conversation.create",
                                "workspace_id": workspace, "provider": provider,
                                "title": f"Decline {provider}", "provider_config": approval_config})["conversation"]["id"]
                            decline_command = f"printf '%s' '{approval_marker}' > '{decline_target}'"
                            rpc(socket, {"op": "agent.send", "conversation_id": decline_conversation,
                                "request_id": str(uuid.uuid4()),
                                "text": f"Use a shell tool to run exactly this command: {decline_command}. "
                                        "Ask for permission if needed. Do not try another way if denied."})
                            def decline_state():
                                snapshot = rpc(socket, {"op": "conversation.get",
                                                "conversation_id": decline_conversation, "limit": 100})
                                pending_requests = [request for request in snapshot["requests"]
                                                    if request["status"] == "pending"]
                                terminal = snapshot["conversation"]["status"] in (
                                    "ready", "error", "interrupted", "disconnected")
                                return (snapshot, pending_requests) if pending_requests or terminal else None
                            declined, pending_decline = wait_for(decline_state, seconds)
                            result["native_decline_seen"] = bool(pending_decline)
                            if pending_decline:
                                if not intended_write(pending_decline[0], provider, decline_target, approval_marker):
                                    raise RuntimeError("Native negative-choice request did not match the intended disposable-file write")
                                result["decline_request_method"] = pending_decline[0]["method"]
                                offered = pending_decline[0]["params"].get("availableDecisions") or []
                                result["decline_available_decisions"] = [choice for choice in offered
                                                                         if isinstance(choice, str)]
                                negative = "decline" if "decline" in offered else "cancel" if "cancel" in offered else "decline"
                                result["negative_decision"] = negative
                                decline_answer = {"op": "agent.answer", "conversation_id": decline_conversation,
                                                  "request_id": pending_decline[0]["id"], "decision": negative}
                                try:
                                    rpc(socket, decline_answer)
                                    rpc(socket, decline_answer)
                                    result["repeat_decline_acknowledged"] = True
                                except RuntimeError as error:
                                    result["decline_error"] = str(error)
                                    result["repeat_decline_acknowledged"] = False
                                if result["repeat_decline_acknowledged"]:
                                    try:
                                        rpc(socket, {**decline_answer, "decision": "accept"})
                                        result["conflicting_decline_rejected"] = False
                                    except RuntimeError as error:
                                        result["conflicting_decline_rejected"] = "conflict" in str(error).lower()
                                    def decline_finished():
                                        state = decline_state()
                                        return state[0] if state and state[0]["conversation"]["status"] in (
                                            "ready", "error", "interrupted", "disconnected") else None
                                    declined = wait_for(decline_finished, seconds)
                            result["decline_status"] = declined["conversation"]["status"]
                            result["declined_file_absent"] = not decline_target.exists()
                            expected_decline_status = "interrupted" if result.get("negative_decision") == "cancel" else "ready"
                            if not (result["native_decline_seen"] and result.get("repeat_decline_acknowledged")
                                    and result.get("conflicting_decline_rejected") and
                                    result["decline_status"] == expected_decline_status and result["declined_file_absent"]):
                                result["status"] = "fail"
                        result["cancel_probe"] = cancel_probe
                        result["approval_probe"] = approval_probe
                        result["elapsed_seconds"] = round(time.monotonic() - started, 2)
                        results.append(result)
                    except Exception as error:
                        failure = result or {"provider": provider}
                        failure.update({"status": "fail", "elapsed_seconds": round(time.monotonic() - started, 2),
                                        "error": str(error)})
                        results.append(failure)
            finally:
                if daemon.poll() is None:
                    daemon.terminate()
                    try:
                        daemon.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        daemon.kill()
                        daemon.wait(timeout=5)
                cleanup_runtimes()
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("providers", nargs="+", choices=("codex", "claude", "omp"))
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--tool-probe", action="store_true",
                        help="Require a real file read and visible tool activity")
    parser.add_argument("--cancel-probe", action="store_true",
                        help="Cancel a real turn, resume the agent, and send another prompt")
    parser.add_argument("--approval-probe", action="store_true",
                        help="Accept and decline real native write approvals")
    args = parser.parse_args()
    results = run(args.providers, args.timeout, args.tool_probe, args.cancel_probe, args.approval_probe)
    print(json.dumps({"type": "live_provider_check", "results": results}, indent=2))
    if any(item["status"] != "pass" for item in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
