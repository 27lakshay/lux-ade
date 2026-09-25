#!/usr/bin/env python3
"""Isolated, account-free lux-ade demo using the actual local provider protocol."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import uuid
from paths import PROJECT_ROOT, TARGET_DIR
from runtime import rpc
from runtime_test_support import track_runtime, cleanup_runtimes


def demo_layout(conversation_id):
    def tabs(panel_id, kind, content_id=None):
        return {'panel_name': 'TabPanel', 'children': [{'panel_name': 'ade.content',
            'children': [], 'info': {'panel': {'id': panel_id, 'kind': kind, 'content_id': content_id}}}],
            'info': {'tabs': {'active_index': 0}}}
    return {'dock': {'version': 1, 'center': {'panel_name': 'SplitPanel',
        'children': [tabs('demo-chat', 'chat', conversation_id), tabs('demo-empty', 'empty')],
        'info': {'stack': {'sizes': [760, 340], 'axis': 0}}}}, 'active_panel': 'demo-chat', 'closed': []}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', choices=['debug', 'release'], default='release')
    parser.add_argument('--target-dir', type=Path, default=TARGET_DIR)
    parser.add_argument('--app', type=Path, help='Use binaries and resources from a packaged .app')
    parser.add_argument('--no-client', action='store_true', help='Verify fixture workflow and exit without a GUI')
    args = parser.parse_args()
    binaries = args.app.resolve() / "Contents/MacOS" if args.app else args.target_dir.resolve() / args.profile
    for name in ['ade-daemon', 'ade-runtime'] + ([] if args.no_client else ['ade-client']):
        if not (binaries / name).is_file():
            parser.error(f'Missing {binaries / name}; build that profile first.')
    def interrupt(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupt)
    with tempfile.TemporaryDirectory(prefix='ade-demo-', dir='/tmp') as temporary:
        root = Path(temporary)
        endpoint = root / 'app.sock'
        env = {**os.environ, 'ADE_SOCKET': str(endpoint), 'ADE_DATA_DIR': str(root / 'data'),
            'ADE_ROOT': str(root), 'ADE_RUNTIME_SOCKET': str(root / 'runtime.sock'), 'ADE_RUNTIME_HOME': str(root / 'runtime'), 'SHELL': '/bin/sh',
            'ADE_CODEX_BIN': str(PROJECT_ROOT / 'scripts/fixtures/codex_mock.py'),
            'ADE_CODEX_TRANSPORT': 'stdio', 'ADE_MOCK_DIR': str(root / 'codex'),
            'ADE_CLAUDE_BRIDGE_BIN': str(PROJECT_ROOT / 'scripts/fixtures/claude_mock.mjs'),
            'ADE_MOCK_CLAUDE_DIR': str(root / 'claude'),
            'ADE_OMP_BIN': str(PROJECT_ROOT / 'providers/omp/mock-cli.mjs'),
            'ADE_OPENCODE_BIN': str(PROJECT_ROOT / 'providers/opencode/mock-server.mjs'),
            'ADE_MOCK_OPENCODE_DIR': str(root / 'opencode')}
        for key in list(env):
            if key.startswith('ADE_BENCH') or key in ('ADE_UI_SHOWCASE', 'ADE_GPU_BENCH_LOG'):
                env.pop(key)
        children = []
        with (root / 'demo.log').open('ab') as log:
            try:
                daemon = subprocess.Popen([str(binaries / 'ade-daemon')], env=env, stdout=log, stderr=log, start_new_session=True)
                children.append(daemon)
                def call(op, **fields):
                    value = rpc(endpoint, {'op': op, **fields})
                    if value.get('type') == 'error':
                        raise RuntimeError(value)
                    return value
                def wait(check):
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline:
                        if daemon.poll() is not None:
                            raise RuntimeError((root / 'demo.log').read_text())
                        try:
                            value = check()
                            if value:
                                return value
                        except (FileNotFoundError, ConnectionRefusedError):
                            pass
                        time.sleep(.05)
                    raise TimeoutError('Demo workflow timed out')
                track_runtime(wait(lambda: call('hello')))
                workspace = call('catalog.get')['catalog']['workspaces'][0]
                conversation = call('conversation.create', workspace_id=workspace['id'], provider='codex', title='Explore lux-ade · local demo')['conversation']
                cid = conversation['id']
                def state():
                    return call('conversation.get', conversation_id=cid)
                def send(text):
                    call('agent.send', conversation_id=cid, request_id=str(uuid.uuid4()), text=text)
                send('demo')
                wait(lambda: state()['conversation']['status'] == 'ready')
                messages = state()['messages']
                assert any('def greet' in message.get('text', '') for message in messages), 'Missing Markdown/code fixture'
                assert any(message.get('kind') == 'tool' or 'fixture failure' in message.get('text', '') for message in messages), 'Missing tool fixture'
                send('approval')
                wait(lambda: state()['conversation']['status'] == 'waiting')
                call('window.save', window={'id': 'demo-window', 'workspace_id': workspace['id'], 'conversation_id': cid,
                    'browser_url': '', 'x': 80, 'y': 80, 'width': 1280, 'height': 820, 'dock_layout': demo_layout(cid)})
                print(json.dumps({'mode': 'local-fixture', 'socket': str(endpoint), 'conversation_id': cid, 'profile': args.profile}), flush=True)
                if args.no_client:
                    pending = state()['requests'][0]
                    call('agent.answer', conversation_id=cid, request_id=pending['id'], decision='decline')
                    wait(lambda: state()['conversation']['status'] == 'ready')
                    send('Follow-up after approval')
                    wait(lambda: state()['conversation']['status'] == 'ready')
                    print('PASS: Markdown, code, tool result, approval, follow-up; no provider account used.', flush=True)
                else:
                    client = subprocess.Popen([str(binaries / 'ade-client')], env=env, stdout=log, stderr=log, start_new_session=True)
                    children.append(client)
                    print('Close the demo window or press Ctrl-C to stop this isolated demo.', flush=True)
                    client.wait()
            except KeyboardInterrupt:
                print('Stopping isolated demo.', flush=True)
            finally:
                for process in reversed(children):
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()
                cleanup_runtimes()


if __name__ == '__main__':
    main()
