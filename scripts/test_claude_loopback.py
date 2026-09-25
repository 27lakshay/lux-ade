#!/usr/bin/env python3
"""Real installed Claude SDK and CLI against a deterministic loopback model only."""
import argparse
import json
import os
from pathlib import Path
from queue import Queue, Empty
import shutil
import subprocess
import tempfile
from threading import Thread
import time
import uuid
from fixtures.local_responses import Responses, ANSWER


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='Run isolated local protocol test; no paid model calls')
    if not parser.parse_args().run:
        parser.error('Pass --run to launch the installed Claude CLI against loopback')
    node, claude = shutil.which('node'), shutil.which('claude')
    assert node and claude, 'Install Node and Claude CLI before running this test'
    bridge = Path(__file__).resolve().parents[1] / 'providers/claude/bridge.mjs'
    server = Responses()
    child = None
    with tempfile.TemporaryDirectory(prefix='ade-claude-loopback-') as temp:
        root = Path(temp)
        project = root / 'project'
        project.mkdir()
        # SDK inherits this allowlisted environment. No account or proxy variables
        # enter; explicit gateway credentials override macOS subscription lookup.
        env = {
            'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(root),
            'TMPDIR': tempfile.gettempdir(), 'TERM': 'dumb',
            'CLAUDE_CONFIG_DIR': str(root / 'claude'), 'ADE_DATA_DIR': str(root / 'ade'),
            'ADE_CLAUDE_BIN': claude, 'ANTHROPIC_BASE_URL': server.url.removesuffix('/v1'),
            'ANTHROPIC_API_KEY': 'ade-loopback-placeholder',
            'ANTHROPIC_AUTH_TOKEN': 'ade-loopback-placeholder',
            'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1',
            'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_DATA_HOME': str(root / 'data'),
            'XDG_CACHE_HOME': str(root / 'cache'),
        }
        events = []
        frames = Queue()
        def start():
            nonlocal child, frames
            frames = Queue()
            child = subprocess.Popen([node, str(bridge)], cwd=project, env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
            def read(process, queue):
                for line in process.stdout:
                    queue.put(json.loads(line))
                queue.put({'closed': True})
            Thread(target=read, args=(child, frames), daemon=True).start()
        def receive(predicate, timeout=30):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    frame = frames.get(timeout=max(.01, deadline-time.monotonic()))
                except Empty:
                    break
                if frame.get('closed'):
                    raise AssertionError('Bridge exited: ' + (root/'stderr.log').read_text()[-3000:])
                if frame.get('method') == 'event':
                    events.append(frame['params'])
                    assert frame['params']['type'] != 'request', 'Unexpected tool request in text-only fixture'
                if predicate(frame):
                    return frame
            raise AssertionError('Timed out waiting for bridge: ' + json.dumps(events[-5:]))
        def rpc(method, **params):
            request_id = str(uuid.uuid4())
            child.stdin.write(json.dumps({'id': request_id, 'method': method, 'params': params})+'\n')
            child.stdin.flush()
            frame = receive(lambda f: f.get('id') == request_id)
            assert 'error' not in frame, frame
            return frame['result']
        def stop():
            nonlocal child
            if child:
                child.stdin.close()
                try:
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    child.terminate()
                    child.wait(timeout=5)
                child.stdout.close()
                child = None
        with (root/'stderr.log').open('w') as log:
            try:
                start()
                opened = rpc('open', config={'model': 'claude-sonnet-4-6', 'permission_mode': 'dontAsk', 'setting_sources': []})
                assert opened['history'] == []
                for index in (1, 2):
                    turn = str(uuid.uuid4())
                    rpc('send', session=opened['session'], submission=str(uuid.uuid4()), message_id=turn,
                        text=f'Local protocol prompt {index}. Reply with text only. Do not use tools.')
                    if not any(e['type'] == 'finished' and e.get('turn') == turn for e in events):
                        receive(lambda f: f.get('params', {}).get('type') == 'finished' and f['params'].get('turn') == turn)
                    finished = next(e for e in events if e['type'] == 'finished' and e.get('turn') == turn)
                    assert finished['status'] == 'completed', finished
                model_calls = [body for route, body in server.calls if route.split('?')[0].endswith('/messages')]
                assert len(model_calls) == 2, len(model_calls)
                assert 'Local protocol prompt 1' in json.dumps(model_calls[1]['messages'])
                assert ANSWER in json.dumps(model_calls[1]['messages'])
                assert any(e['type'] == 'delta' for e in events), 'No structured streaming text'
                stop()
                start()
                resumed = rpc('open', resume=opened['session'], config={'model': 'claude-sonnet-4-6', 'permission_mode': 'dontAsk', 'setting_sources': []})
                assert resumed['session'] == opened['session']
                answers = [m for m in resumed['history'] if m['role'] == 'assistant' and m['kind'] == 'text']
                assert [m['text'] for m in answers] == [ANSWER, ANSWER], answers
                assert len({m['id'] for m in answers}) == 2
                assert len([m for m in resumed['history'] if m['role'] == 'user']) == 2
                assert len([body for route, body in server.calls if route.split('?')[0].endswith('/messages')]) == 2
                print(json.dumps({'provider': 'claude', 'result': 'PASS', 'model_calls': 2,
                                  'streaming': True, 'followup_context': True, 'resume_history': True,
                                  'endpoint': 'loopback fixture', 'hosted_auth_tested': False}))
            finally:
                stop()
                server.close()


if __name__ == '__main__':
    main()
