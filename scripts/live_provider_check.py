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
import signal
import sys
import time
import uuid

from paths import PROJECT_ROOT, TARGET_DIR
from live_profile import profile_environment, missing_prerequisites
from runtime import rpc
from runtime_test_support import track_runtime, cleanup_runtimes, scratch_directory


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


def intended_write(request, provider, target, marker, calls=None):
    """Never approve a native request beyond the disposable probe's exact write.

    Raw provider params stay private to the daemon, so the client-facing request (its summary
    and schema) must name both the unique disposable target and its unique marker."""
    metadata = request.get("metadata", {})
    visible = json.dumps(metadata) + (calls or {}).get(metadata.get("native_item_id"), "")
    return str(target) in visible and marker in visible


def typed_answer(request, decision):
    """A typed answer from the request's declared schema, as the SDK and desktop send it."""
    schema = request["metadata"]["schema"]
    if schema["kind"] == "choices":
        # Match plain choice names exactly, in preference order. Structured choices (such as an
        # accept that amends an execution policy) never match by text: their values carry paths.
        names = ("accept", "allow", "allow_once", "once") if decision == "accept" else ("decline", "deny", "reject", "cancel")
        def name(value):
            # A plain name, or a structured choice's own `decision` (Claude permissions).
            if isinstance(value, str):
                return value
            return value.get("decision") if isinstance(value, dict) and isinstance(value.get("decision"), str) else None
        offered = {name(choice["value"]): choice for choice in schema["choices"] if name(choice["value"])}
        for name in names:
            if name in offered:
                return {"kind": "choice", "value": offered[name]["value"]}
        raise RuntimeError(f"No native {decision} choice is offered")
    if schema["kind"] == "permissions" and decision == "accept":
        scope = "once" if "once" in schema["scopes"] else schema["scopes"][0]
        return {"kind": "permissions", "permissions": schema["requested"], "scope": scope, "strict_auto_review": None}
    raise RuntimeError(f"Answer {decision} does not fit native request schema {schema['kind']}")


def answer_request(socket, request, decision, operation_id):
    return rpc(socket, {"op": "agent.answer", "operation_id": operation_id,
                        "conversation_id": request["conversation_id"], "request_id": request["id"],
                        "source_attempt_id": request["source_attempt_id"],
                        "request_revision": request["revision"], "answer": typed_answer(request, decision)})


def steer(socket, workspace, provider, seconds):
    """Steer a running turn: the added input reaches the same turn, and no second prompt starts."""
    conversation_id = rpc(socket, {"op": "conversation.create", "operation_id": str(uuid.uuid4()), "workspace_id": workspace,
                                   "provider": provider, "title": f"Steer {provider}"})["conversation"]["id"]
    rpc(socket, {"op": "agent.send", "conversation_id": conversation_id, "request_id": str(uuid.uuid4()),
                 "text": "Use a shell tool to run `sleep 15`. When it finishes, reply with exactly ADE_FIRST_DONE "
                         "followed by any token you were asked to add."})
    def current():
        return rpc(socket, {"op": "conversation.get", "conversation_id": conversation_id, "limit": 32})
    running = wait_for(lambda: (lambda seen: seen if seen["conversation"]["status"] == "running"
                                and seen["conversation"].get("active_turn_id") else None)(current()), seconds)
    turn = running["conversation"]["active_turn_id"]
    controls = rpc(socket, {"op": "conversation.controls", "conversation_id": conversation_id})["controls"]
    offered = next((entry for entry in controls if entry["control"] == "steer"), None)
    if not offered or not offered["available"]:
        return {"steer_status": "not_applicable", "steer_reason": (offered or {}).get("reason")}
    rpc(socket, {"op": "conversation.steer", "operation_id": str(uuid.uuid4()), "conversation_id": conversation_id,
                 "turn_id": turn, "text": "Also add the token ADE_STEER_OK to your final reply."})
    done = wait_for(lambda: (lambda seen: seen if seen["conversation"]["status"] in
                             ("ready", "idle", "error", "interrupted", "disconnected") else None)(current()), seconds)
    answer = "\n".join(message["text"] for message in done["messages"] if message["role"] == "assistant")
    turns = {message.get("turn_id") for message in done["messages"] if message["role"] == "assistant"}
    users = [message for message in done["messages"] if message["role"] == "user"]
    passed = (done["conversation"]["status"] in ("ready", "idle") and "ADE_STEER_OK" in answer
              and turn in turns and len(turns) == 1)
    return {"steer_status": "pass" if passed else "fail", "steer_marker_seen": "ADE_STEER_OK" in answer,
            "steer_same_turn": turn in turns and len(turns) == 1, "steer_user_messages": len(users)}


def run(providers, seconds, tool_probe=False, cancel_probe=False, approval_probe=False, steer_probe=False):
    results = []
    with scratch_directory(prefix="ade-live-provider-") as directory:
        root = Path(directory)
        socket = root / "daemon.sock"
        environment = profile_environment(root)
        daemon_binary = TARGET_DIR / "debug/ade-daemon"
        if not daemon_binary.is_file():
            raise RuntimeError("Build the daemon first with pnpm build:backend")
        with (root / "daemon.log").open("wb") as log:
            daemon = subprocess.Popen([str(daemon_binary)], env=environment,
                                      stdout=log, stderr=log, start_new_session=True)
            try:
                hello = wait_for(lambda: rpc(socket, {"op": "hello"}), 10)
                track_runtime(hello)
                workspace = rpc(socket, {"op": "workspace.open", "path": environment["ADE_ROOT"]})["workspace"]["id"]
                for provider in providers:
                    started = time.monotonic()
                    result = None
                    try:
                        if steer_probe:
                            # Steering runs on its own: one prompt and one steered input.
                            result = {"provider": provider, **steer(socket, workspace, provider, seconds)}
                            result["status"] = "pass" if result["steer_status"] == "pass" else "fail"
                            result["elapsed_seconds"] = round(time.monotonic() - started, 2)
                            results.append(result)
                            continue
                        marker = None
                        target = None
                        result_notes = {}
                        prompt = "Reply with exactly ADE_LIVE_OK. Do not use tools."
                        if tool_probe:
                            marker = f"ADE_TOOL_{uuid.uuid4().hex}"
                            target = root / "ade-live-tool-marker.txt"
                            target.write_text(marker + "\n")
                            prompt = (f"Read {target} with a file-reading tool. Reply with exactly "
                                      "the token in that file. Do not infer its contents or edit files.")
                        created = rpc(socket, {"op": "conversation.create", "operation_id": str(uuid.uuid4()), "workspace_id": workspace,
                                               "provider": provider, "title": f"Live {provider}"})["conversation"]
                        conversation_id = created["id"]
                        rpc(socket, {"op": "agent.send", "conversation_id": conversation_id,
                                     "request_id": str(uuid.uuid4()),
                                     "text": prompt})
                        answered = set()
                        def completed():
                            snapshot = rpc(socket, {"op": "conversation.get", "conversation_id": conversation_id,
                                                    "limit": 32})
                            # A provider may ask before reading the probe's file; approve only a
                            # request that names that exact disposable file, once.
                            calls = {message.get("provider_item_id"): message.get("text", "")
                                     for message in snapshot["messages"] if message["role"] == "tool"}
                            for request in snapshot.get("requests", []):
                                metadata = request.get("metadata", {})
                                # The request names the native tool call; that call's input names the file.
                                visible = json.dumps(metadata) + calls.get(metadata.get("native_item_id"), "")
                                if (tool_probe and request["id"] not in answered and
                                        request.get("resolution", "outstanding") == "outstanding" and str(target) in visible):
                                    answered.add(request["id"])
                                    answer_request(socket, request, "accept", str(uuid.uuid4()))
                                    result_notes["read_approved"] = True
                            status = snapshot["conversation"]["status"]
                            last["snapshot"] = snapshot
                            return snapshot if status in ("ready", "idle", "error", "interrupted", "disconnected") else None
                        last = {}
                        try:
                            snapshot = wait_for(completed, seconds)
                        except TimeoutError:
                            if os.environ.get("ADE_LIVE_DEBUG") == "1" and last.get("snapshot"):
                                seen = last["snapshot"]
                                print(json.dumps({"status": seen["conversation"]["status"],
                                                  "error": seen["conversation"].get("error"),
                                                  "requests": [request.get("metadata", {}).get("summary") for request in seen["requests"]],
                                                  "messages": [[m["role"], m["kind"], m["status"], m["text"][:160]] for m in seen["messages"]]},
                                                 indent=1), file=sys.stderr)
                            raise
                        answer = "\n".join(message["text"] for message in snapshot["messages"]
                                           if message["role"] == "assistant")
                        status = snapshot["conversation"]["status"]
                        expected = marker or "ADE_LIVE_OK"
                        tool_visible = any("tool" in str(message.get("kind", "")).lower() or
                                           "tool" in str(message.get("role", "")).lower()
                                           for message in snapshot["messages"])
                        passed = status in ("ready", "idle") and expected in answer and (not tool_probe or tool_visible)
                        result = {"provider": provider, "status": "pass" if passed else "fail",
                                  "conversation_status": status, "tool_probe": tool_probe,
                                  "tool_visible": tool_visible if tool_probe else None,
                                  "message_kinds": sorted({str(message.get("kind", "")) for message in snapshot["messages"]}),
                                  "assistant_marker_seen": expected in answer,
                                  "provider_error": bool(snapshot["conversation"].get("error")), **result_notes}
                        if passed and cancel_probe:
                            rpc(socket, {"op": "agent.send", "conversation_id": conversation_id,
                                         "request_id": str(uuid.uuid4()),
                                         "text": "Use a shell tool to run `sleep 20` now. Wait for it to finish before replying."})
                            def current():
                                return rpc(socket, {"op": "conversation.get", "conversation_id": conversation_id,
                                                    "limit": 32})
                            def at_status(*states):
                                observed = current()
                                return observed if observed["conversation"]["status"] in states else None
                            wait_for(lambda: at_status("running", "waiting"), seconds)
                            running = current()["conversation"]
                            rpc(socket, {"op": "agent.cancel", "operation_id": str(uuid.uuid4()), "conversation_id": conversation_id,
                                         "source_attempt_id": running["runtime_run"],
                                         "submission_id": running["runtime_submission"]})
                            try:
                                stopped = wait_for(lambda: at_status("interrupted", "error", "disconnected"), seconds)
                            except TimeoutError:
                                if os.environ.get("ADE_LIVE_DEBUG") == "1":
                                    seen = current()
                                    print(json.dumps({"status": seen["conversation"]["status"],
                                                      "stop": seen["conversation"].get("stop"),
                                                      "messages": [[m["role"], m["kind"], m["status"]] for m in seen["messages"]]},
                                                     indent=1), file=sys.stderr)
                                raise
                            result["cancel_status"] = stopped["conversation"]["status"]
                            rpc(socket, {"op": "agent.resume", "operation_id": str(uuid.uuid4()), "conversation_id": conversation_id})
                            wait_for(lambda: at_status("ready", "idle"), seconds)
                            rpc(socket, {"op": "agent.send", "conversation_id": conversation_id,
                                         "request_id": str(uuid.uuid4()),
                                         "text": "Reply with exactly ADE_RESUMED_OK. Do not use tools."})
                            def resumed_result():
                                observed = at_status("ready", "idle", "error", "interrupted", "disconnected")
                                if not observed:
                                    return None
                                answer = "\n".join(message["text"] for message in observed["messages"]
                                                   if message["role"] == "assistant")
                                return observed if "ADE_RESUMED_OK" in answer or observed["conversation"]["status"] not in ("ready", "idle") else None
                            resumed = wait_for(resumed_result, seconds)
                            resumed_answer = "\n".join(message["text"] for message in resumed["messages"]
                                                       if message["role"] == "assistant")
                            result["resumed_marker_seen"] = "ADE_RESUMED_OK" in resumed_answer
                            result["resume_status"] = resumed["conversation"]["status"]
                            if result["resume_status"] not in ("ready", "idle") or not result["resumed_marker_seen"]:
                                result["status"] = "fail"
                        declared = next((entry.get("capabilities", []) for entry in
                                         rpc(socket, {"op": "catalog.get"}).get("providers", [])
                                         if entry.get("id") == provider), [])
                        if passed and approval_probe and "tool_approval" not in declared:
                            # The provider declares no native tool approval; nothing to answer.
                            result["approval_probe_applicable"] = False
                        if passed and approval_probe and "tool_approval" in declared:
                            approval_target = root / f"ade-approval-{provider}.txt"
                            approval_marker = f"ADE_APPROVED_{uuid.uuid4().hex}"
                            approval_config = {"permission_mode": "read-only"} if provider == "codex" else {}
                            approval_conversation = rpc(socket, {"op": "conversation.create", "operation_id": str(uuid.uuid4()),
                                "workspace_id": workspace, "provider": provider,
                                "title": f"Approval {provider}", "provider_config": approval_config})["conversation"]["id"]
                            approval_command = f"printf '%s' '{approval_marker}' > '{approval_target}'"
                            rpc(socket, {"op": "agent.send", "conversation_id": approval_conversation,
                                "request_id": str(uuid.uuid4()),
                                "text": f"Use a shell tool to run exactly this command: {approval_command}. "
                                        "Ask for permission if needed; do not use another command or edit method."})
                            def approval_state():
                                observed = rpc(socket, {"op": "conversation.get",
                                               "conversation_id": approval_conversation, "limit": 32})
                                pending = [request for request in observed["requests"]
                                           if request.get("resolution", "outstanding") == "outstanding"]
                                terminal = observed["conversation"]["status"] in (
                                    "ready", "idle", "error", "interrupted", "disconnected")
                                return (observed, pending) if pending or terminal else None
                            observed, pending = wait_for(approval_state, seconds)
                            result["native_approval_seen"] = bool(pending)
                            if pending:
                                calls = {m.get("provider_item_id"): m.get("text", "") for m in observed["messages"] if m["role"] == "tool"}
                                if not intended_write(pending[0], provider, approval_target, approval_marker, calls):
                                    result["unexpected_approval"] = {
                                        "summary": str(pending[0].get("metadata", {}).get("summary", ""))[:500],
                                    }
                                    raise RuntimeError("Native approval did not match the intended disposable-file write")
                                operation = str(uuid.uuid4())
                                answer_request(socket, pending[0], "accept", operation)
                                # A retry under the same operation ID returns the recorded reply.
                                answer_request(socket, pending[0], "accept", operation)
                                result["repeat_answer_acknowledged"] = True
                                try:
                                    answer_request(socket, pending[0], "decline", str(uuid.uuid4()))
                                    result["conflicting_answer_rejected"] = False
                                except RuntimeError:
                                    result["conflicting_answer_rejected"] = True
                                def approval_finished():
                                    snapshot = rpc(socket, {"op": "conversation.get",
                                                    "conversation_id": approval_conversation, "limit": 32})
                                    return snapshot if snapshot["conversation"]["status"] in (
                                        "ready", "idle", "error", "interrupted", "disconnected") else None
                                observed = wait_for(approval_finished, seconds)
                            result["approval_status"] = observed["conversation"]["status"]
                            result["approved_file_written"] = approval_target.is_file() and (
                                approval_target.read_text().strip() == approval_marker)
                            if not (result["native_approval_seen"] and result.get("repeat_answer_acknowledged")
                                    and result.get("conflicting_answer_rejected") and
                                    result["approval_status"] in ("ready", "idle") and result["approved_file_written"]):
                                result["status"] = "fail"
                            decline_target = root / f"ade-declined-{provider}.txt"
                            decline_conversation = rpc(socket, {"op": "conversation.create", "operation_id": str(uuid.uuid4()),
                                "workspace_id": workspace, "provider": provider,
                                "title": f"Decline {provider}", "provider_config": approval_config})["conversation"]["id"]
                            decline_command = f"printf '%s' '{approval_marker}' > '{decline_target}'"
                            rpc(socket, {"op": "agent.send", "conversation_id": decline_conversation,
                                "request_id": str(uuid.uuid4()),
                                "text": f"Use a shell tool to run exactly this command: {decline_command}. "
                                        "Ask for permission if needed. Do not try another way if denied."})
                            def decline_state():
                                snapshot = rpc(socket, {"op": "conversation.get",
                                                "conversation_id": decline_conversation, "limit": 32})
                                pending_requests = [request for request in snapshot["requests"]
                                                    if request.get("resolution", "outstanding") == "outstanding"]
                                terminal = snapshot["conversation"]["status"] in (
                                    "ready", "idle", "error", "interrupted", "disconnected")
                                return (snapshot, pending_requests) if pending_requests or terminal else None
                            declined, pending_decline = wait_for(decline_state, seconds)
                            result["native_decline_seen"] = bool(pending_decline)
                            if pending_decline:
                                calls = {m.get("provider_item_id"): m.get("text", "") for m in declined["messages"] if m["role"] == "tool"}
                                if not intended_write(pending_decline[0], provider, decline_target, approval_marker, calls):
                                    raise RuntimeError("Native negative-choice request did not match the intended disposable-file write")
                                schema = pending_decline[0]["metadata"]["schema"]
                                result["decline_schema"] = schema["kind"]
                                operation = str(uuid.uuid4())
                                try:
                                    result["decline_choice"] = typed_answer(pending_decline[0], "decline")
                                    result["decline_offered"] = [choice["value"] for choice in schema.get("choices", [])]
                                    answer_request(socket, pending_decline[0], "decline", operation)
                                    answer_request(socket, pending_decline[0], "decline", operation)
                                    result["repeat_decline_acknowledged"] = True
                                    result["negative_decision"] = "decline"
                                except RuntimeError as error:
                                    result["decline_error_kind"] = type(error).__name__
                                    result["repeat_decline_acknowledged"] = False
                                if result["repeat_decline_acknowledged"]:
                                    try:
                                        answer_request(socket, pending_decline[0], "accept", str(uuid.uuid4()))
                                        result["conflicting_decline_rejected"] = False
                                    except RuntimeError:
                                        result["conflicting_decline_rejected"] = True
                                    def decline_finished():
                                        state = decline_state()
                                        return state[0] if state and state[0]["conversation"]["status"] in (
                                            "ready", "idle", "error", "interrupted", "disconnected") else None
                                    declined = wait_for(decline_finished, seconds)
                            result["decline_status"] = declined["conversation"]["status"]
                            # Kinds and statuses only; no provider text.
                            result["decline_items"] = [[message.get("role"), message.get("kind"), message.get("status")]
                                                       for message in declined["messages"]]
                            result["decline_requests_seen"] = len(declined["requests"])
                            result["declined_file_absent"] = not decline_target.exists()
                            if not (result["native_decline_seen"] and result.get("repeat_decline_acknowledged")
                                    and result.get("conflicting_decline_rejected") and
                                    result["decline_status"] in ("ready", "idle", "interrupted") and result["declined_file_absent"]):
                                result["status"] = "fail"
                        result["cancel_probe"] = cancel_probe
                        result["approval_probe"] = approval_probe
                        result["elapsed_seconds"] = round(time.monotonic() - started, 2)
                        results.append(result)
                    except Exception as error:
                        if os.environ.get("ADE_LIVE_DEBUG") == "1":
                            # The probe's own stack; provider error text stays out of the report.
                            import traceback
                            traceback.print_exc(file=sys.stderr)
                        failure = result or {"provider": provider}
                        failure.update({"status": "fail", "elapsed_seconds": round(time.monotonic() - started, 2),
                                        "error_kind": type(error).__name__})
                        results.append(failure)
            finally:
                try:
                    if daemon.poll() is None:
                        daemon.terminate()
                        try:
                            daemon.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            daemon.kill()
                            daemon.wait(timeout=2)
                finally:
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
    parser.add_argument("--steer-probe", action="store_true",
                        help="Steer a running turn with added input where the provider offers steering")
    parser.add_argument("--approval-probe", action="store_true",
                        help="Accept and decline real native write approvals")
    args = parser.parse_args()
    missing = missing_prerequisites(args.providers, os.environ.get("ADE_RUN_LIVE_PROVIDERS") == "1")
    report = {"type": "live_provider_check", "providers": args.providers,
              "authentication_preflight": "unverified", "results": [],
              "acceptanceScope": {"requirementIds": ["F021"] + (["F038"] if args.approval_probe else []),
                                  "coverage": "selected native provider probes",
                                  "fullRequirementAcceptance": "unverified"}}
    if missing:
        report.update(status="failed", failureCategory="prerequisite-unavailable",
                      missing=missing, unexecutedProviders=args.providers)
    else:
        try:
            report["results"] = run(args.providers, args.timeout, args.tool_probe, args.cancel_probe, args.approval_probe,
                                    args.steer_probe)
            report["status"] = "passed" if all(item["status"] == "pass" for item in report["results"]) else "failed"
        except KeyboardInterrupt:
            report.update(status="interrupted")
        except Exception as error:
            # Native provider errors may contain account or credential details.
            report.update(status="failed", failureCategory="execution-error", error_kind=type(error).__name__)
    directory = PROJECT_ROOT / "test-results" / "runs" / f"live-provider-{uuid.uuid4()}"
    directory.mkdir(parents=True)
    payload = json.dumps(report, indent=2) + "\n"
    (directory / "summary.json").write_text(payload)
    print(payload, end="")
    print(f"Test report: {directory}", file=sys.stderr)
    if report["status"] != "passed":
        raise SystemExit(130 if report["status"] == "interrupted" else 1)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    main()
