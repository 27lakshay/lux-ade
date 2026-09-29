#!/usr/bin/env python3
"""Actual Codex CLI + lux-ade Rust adapter against a local Responses fixture only."""
from paths import PROJECT_ROOT
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import subprocess
from threading import Event
import time
import uuid
from fixtures.local_responses import Responses, ANSWER
from fixtures import local_responses
from runtime import rpc
from runtime_test_support import track_runtime, cleanup_runtimes, scratch_directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    if not parser.parse_args().run:
        parser.error('Pass --run to launch the installed Codex CLI against loopback')
    codex = os.environ.get('ADE_CODEX_BIN') or shutil.which('codex')
    assert codex, 'Install Codex CLI first'
    server = Responses()
    daemon = None
    gate = Event()
    with scratch_directory(prefix='ade-codex-loopback-', dir='/tmp') as temp:
        root = Path(temp)
        home = root/'home'; home.mkdir()
        config = home/'codex'; config.mkdir()
        project = root/'project'; project.mkdir()
        endpoint = root/'app.sock'
        (home/'.ade-secrets').mkdir()
        (home/'.gitconfig').write_text('[credential]\n\thelper =\n')
        # Official custom-provider configuration; no default OpenAI endpoint or
        # account credential enters this allowlisted child environment.
        (config/'config.toml').write_text(f'''model = "gpt-5.2"
model_provider = "ade_loopback"
cli_auth_credentials_store = "file"
web_search = "disabled"
[analytics]
enabled = false
[feedback]
enabled = false
[model_providers.ade_loopback]
name = "lux-ade local protocol fixture"
base_url = "{server.url}"
wire_api = "responses"
env_key = "LOOPBACK_KEY"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
''')
        env = {
            'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
            'HOME': str(home), 'CODEX_HOME': str(config),
            'XDG_CONFIG_HOME': str(home/'config'), 'XDG_DATA_HOME': str(home/'data'),
            'XDG_CACHE_HOME': str(home/'cache'), 'TMPDIR': temp,
            'SHELL': '/bin/sh', 'ENV': '/dev/null', 'TERM': 'dumb',
            'ADE_DATA_DIR': str(root/'ade'), 'ADE_ROOT': str(project),
            'ADE_SOCKET': str(endpoint), 'ADE_CODEX_BIN': codex, 'ADE_CODEX_TRANSPORT': 'stdio',
            'ADE_RUNTIME_SOCKET': str(root/'runtime.sock'), 'ADE_PROFILES_HOME': str(home/'profiles'),
            'ADE_SECRET_STORE': 'file', 'ADE_SECRET_FILE': str(home/'.ade-secrets/store.json'),
            'ADE_SECRET_KEY': hashlib.sha256(f'ade-e2e-secret-key\0{home}'.encode()).hexdigest(),
            'GIT_CONFIG_GLOBAL': str(home/'.gitconfig'), 'GIT_TERMINAL_PROMPT': '0',
            'LOOPBACK_KEY': 'local-placeholder-only',
        }
        def call(op, **fields):
            return rpc(endpoint, {'op': op, **fields})
        def wait(check):
            end = time.monotonic()+30
            while time.monotonic() < end:
                try:
                    value = check()
                    if value: return value
                except (FileNotFoundError, ConnectionRefusedError): pass
                if daemon.poll() is not None:
                    raise AssertionError('Isolated lux-ade daemon exited')
                time.sleep(.025)
            raise AssertionError('Timed out waiting for isolated Codex state')
        def snapshot(): return call('conversation.get', conversation_id=cid, limit=200)
        def ready():
            value = snapshot()
            assert value['conversation']['status'] != 'error', value['conversation'].get('error')
            return value if value['conversation']['status'] == 'ready' else None
        def calls(): return [body for route, body in server.calls if route.endswith('/responses')]
        with (root/'stderr.log').open('w') as log:
            try:
                daemon = subprocess.Popen([str(PROJECT_ROOT / 'target/debug/ade-daemon')], cwd=project,
                                          env=env, stdout=log, stderr=log, start_new_session=True)
                track_runtime(wait(lambda: call('hello')))
                wid = call('workspace.open', path=str(project))['workspace']['id']
                cid = call('conversation.create', operation_id=str(uuid.uuid4()), workspace_id=wid, provider='codex')['conversation']['id']
                keys = []
                for number in (1, 2):
                    key = str(uuid.uuid4()); keys.append(key)
                    prompt = f'lux-ade local protocol prompt {number}. Reply with text only; do not use tools.'
                    gate.clear(); server.pause_before_completion = gate
                    call('agent.send', conversation_id=cid, request_id=key, text=prompt)
                    # Holding the actual SSE completion proves Rust sees a
                    # streamed assistant item before the turn finishes.
                    wait(lambda: any(m['role']=='assistant' and m['text']==ANSWER and m['status']!='completed'
                                     for m in snapshot()['messages']))
                    assert snapshot()['conversation']['status'] == 'running'
                    gate.set()
                    wait(ready)
                    call('agent.send', conversation_id=cid, request_id=key, text=prompt)
                assert len(calls()) == 2, 'Duplicate prompt replayed to model'
                second = json.dumps(calls()[1]['input'])
                assert 'lux-ade local protocol prompt 1' in second and ANSWER in second
                before = snapshot(); session = before['conversation']['provider_thread_id']
                call('agent.disconnect', operation_id=str(uuid.uuid4()), conversation_id=cid)
                call('agent.resume', operation_id=str(uuid.uuid4()), conversation_id=cid)
                after = wait(ready)
                assert after['conversation']['provider_thread_id'] == session
                answers = [m for m in after['messages'] if m['role']=='assistant' and m['kind']=='text']
                assert [m['text'] for m in answers] == [ANSWER, ANSWER], answers
                assert len({m['id'] for m in answers}) == 2
                assert len([m for m in after['messages'] if m['role']=='user']) == 2
                assert len(calls()) == 2, 'Resume sent another model request'
                # Keep the opt-in probe compatible with the current daemon without
                # needing live credentials: use this same local endpoint and HOME.
                original_answer = local_responses.ANSWER
                try:
                    local_responses.ANSWER = 'ADE_LIVE_OK'
                    check = subprocess.run(
                        [sys.executable, '-c',
                         "import json; from live_provider_check import run; results=run(['codex'],30); "
                         "print(json.dumps(results)); raise SystemExit(0 if results and all(item['status']=='pass' for item in results) else 1)"],
                        cwd=PROJECT_ROOT, env={**env, 'PYTHONPATH': str(PROJECT_ROOT/'scripts')},
                        text=True, capture_output=True, timeout=45)
                    assert check.returncode == 0, check.stdout + check.stderr
                    assert len(calls()) == 3, 'The compatibility probe must send exactly one additional turn'
                finally:
                    local_responses.ANSWER = original_answer
                print(json.dumps({'provider':'codex','result':'PASS','model_calls':3,'live_probe_model_calls':1,
                                  'live_probe_compatibility':True,'streaming':True,
                                  'followup_context':True,'resume_history':True,'duplicate_send_replayed':False,
                                  'endpoint':'loopback fixture','hosted_auth_tested':False}))
            finally:
                gate.set()
                try:
                    if daemon and daemon.poll() is None:
                        daemon.terminate()
                        try:
                            daemon.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            daemon.kill(); daemon.wait(timeout=2)
                finally:
                    try:
                        cleanup_runtimes()
                    finally:
                        server.close()


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, signal.default_int_handler)
    main()
