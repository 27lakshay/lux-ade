#!/usr/bin/env python3
"""Launch isolated native child-reader fixtures; Enter stops only these processes."""
from paths import PROJECT_ROOT, TARGET_DIR
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
import sys
from runtime import PROJECT, rpc
from runtime_test_support import track_runtime, cleanup_runtimes

transcript = '--transcript' in sys.argv
with tempfile.TemporaryDirectory(prefix='ade-child-ui-', dir='/tmp') as temporary:
    root=Path(temporary); endpoint=root/'app.sock'
    env={**os.environ,'ADE_SOCKET':str(endpoint),'ADE_DATA_DIR':str(root/'data'),'ADE_ROOT':str(root),'SHELL':'/bin/sh',
         'ADE_CODEX_BIN':str(PROJECT/'scripts/fixtures/codex_mock.py'),'ADE_CODEX_TRANSPORT':'stdio','ADE_MOCK_DIR':str(root/'codex'),
         'ADE_CLAUDE_BRIDGE_BIN':str(PROJECT/'scripts/fixtures/claude_mock.mjs'),'ADE_MOCK_CLAUDE_DIR':str(root/'claude'),
         'ADE_OMP_BIN':str(PROJECT/'providers/omp/mock-cli.mjs'),
         'ADE_OPENCODE_BIN':str(PROJECT/'providers/opencode/mock-server.mjs'),'ADE_MOCK_OPENCODE_DIR':str(root/'opencode')}
    if transcript:
        env['ADE_CODEX_BIN'] = str(PROJECT/'scripts/fixtures/codex_stream.py')
    daemon=client=None
    with (root/'runtime.log').open('ab') as log:
        try:
            daemon=subprocess.Popen([str(TARGET_DIR / 'release/ade-daemon')],env=env,stdout=log,stderr=log,start_new_session=True)
            def call(op,**fields): return rpc(endpoint,{'op':op,**fields})
            def wait(fn):
                deadline=time.monotonic()+20
                while time.monotonic()<deadline:
                    if daemon.poll() is not None: raise RuntimeError((root/'runtime.log').read_text())
                    try:
                        result=fn()
                        if result:return result
                    except (FileNotFoundError,ConnectionRefusedError):pass
                    time.sleep(.05)
                raise RuntimeError('Fixture timed out')
            track_runtime(wait(lambda:call('hello')))
            workspace=call('catalog.get')['catalog']['workspaces'][0]['id']
            for provider in (['codex'] if transcript else ['claude','opencode','codex','omp']):
                conversation=call('conversation.create',workspace_id=workspace,provider=provider,title=f'UI test {provider}')['conversation']
                cid=conversation['id']
                call('agent.send',conversation_id=cid,request_id=str(uuid.uuid4()),text='seed:400' if transcript else 'typed-subagents')
                wait(lambda:call('conversation.get',conversation_id=cid)['conversation']['status']=='ready')
                if provider == 'codex' and '--questions' in sys.argv:
                    call('agent.send', conversation_id=cid, request_id=str(uuid.uuid4()), text='rich-questions')
                    wait(lambda:call('conversation.get',conversation_id=cid)['conversation']['status']=='waiting')
                if transcript or (provider == 'codex' and '--questions' in sys.argv):
                    call('window.save', window={'id':'gui-controls', 'workspace_id':workspace,
                        'conversation_id':cid, 'browser_url':'', 'x':100, 'y':100,
                        'width':1000 if '--narrow' in sys.argv or '--min-window' in sys.argv else 1220,
                        'height':700 if '--min-window' in sys.argv else 750,
                        **({'panes':{'sidebar_width':360,'browser_width':600,'terminal_height':600}} if '--extreme-layout' in sys.argv else {})})
            client=subprocess.Popen([str(PROJECT/'lux-ade.app/Contents/MacOS/ade-client')],env=env,stdout=log,stderr=log)
            print(json.dumps({'client_pid':client.pid,'root':str(root),'socket':str(endpoint),'conversation_id':cid}),flush=True)
            input('Press Enter to close this isolated fixture.\n')
        finally:
            for process in (client,daemon):
                if process and process.poll() is None:
                    process.terminate(); process.wait(timeout=10)
            cleanup_runtimes()
