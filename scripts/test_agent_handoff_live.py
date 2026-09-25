#!/usr/bin/env python3
"""Opt-in real provider smoke; consumes model usage, never approves tool requests."""
from paths import PROJECT_ROOT, TARGET_DIR
import argparse, json, os, subprocess, tempfile, time, uuid
from pathlib import Path
from runtime import rpc as call, PROJECT
from runtime_test_support import track_runtime, cleanup_runtimes
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run',action='store_true',help='Authorize two real text-only model turns')
args=parser.parse_args()
if not args.run:parser.error('Pass --run to use your authenticated Codex and Claude accounts')
DAEMON=Path(os.environ.get('ADE_TEST_DAEMON',TARGET_DIR / 'release/ade-daemon'))
with tempfile.TemporaryDirectory(prefix='ade-live-handoff-',dir='/tmp') as tmp:
    root=Path(tmp); endpoint=root/'app.sock'; daemon=None
    env={k:v for k,v in os.environ.items() if not k.startswith('ADE_')}
    env.update(ADE_SOCKET=str(endpoint),ADE_DATA_DIR=str(root/'data'),ADE_ROOT=str(root),SHELL='/bin/sh')
    log=(root/'daemon.log').open('ab')
    def rpc(op,**kw):return call(endpoint,{'op':op,**kw})
    def wait(fn,timeout=120):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            try:
                value=fn()
                if value:return value
            except (FileNotFoundError,ConnectionRefusedError):pass
            time.sleep(.03)
        raise AssertionError('Timed out')
    def start():
        global daemon
        daemon=subprocess.Popen([str(DAEMON)],env=env,stdout=log,stderr=log,start_new_session=True)
        def ready():
            if daemon.poll() is not None:raise AssertionError((root/'daemon.log').read_text())
            return rpc('hello')
        hello=wait(ready,15);track_runtime(hello)
    failures=[]
    try:
        start();wid=rpc('catalog.get')['catalog']['workspaces'][0]['id']
        for provider in ('codex','claude'):
            cid=rpc('conversation.create',workspace_id=wid,provider=provider,provider_config={'permission_mode':'read-only' if provider=='codex' else 'dontAsk'})['conversation']['id']
            key=str(uuid.uuid4());marker='ADE_HANDOFF_'+provider.upper()
            rpc('agent.send',conversation_id=cid,request_id=key,text=f'Do not use tools, read files, or change anything. This is a streaming transport test. Output exactly 120 numbered lines, each containing the number followed by {marker}. Do not shorten the list or add commentary.')
            def active():
                value=rpc('conversation.get',conversation_id=cid,limit=200)
                c=value['conversation']
                if c['status'] in ('error','interrupted'):raise RuntimeError(c['error'])
                if c['status']=='ready':raise RuntimeError('Model finished before an active restart could be tested')
                return value if c['status']=='running' else None
            try:
                before=wait(active);runtime=rpc('runtime.status');agent=next(a for a in runtime['agents'] if a['spec']['conversation']==cid)
                rpc('runtime.prepare_restart',boot_id=runtime['boot_id']);daemon.wait(timeout=5);start()
                after=rpc('runtime.status');new_agent=next(a for a in after['agents'] if a['spec']['conversation']==cid)
                assert agent==new_agent and runtime['runtime_instance']==after['runtime_instance']
                def done():
                    value=rpc('conversation.get',conversation_id=cid,limit=200)
                    if value['conversation']['status']=='error':raise RuntimeError(value['conversation']['error'])
                    return value if value['conversation']['status']=='ready' else None
                result=wait(done)
                assert result['conversation']['provider_thread_id']==before['conversation']['provider_thread_id']
                assert len([m for m in result['messages'] if m['role']=='user'])==1
                assert any(marker in m['text'] for m in result['messages'] if m['role']=='assistant')
                assert not result['requests']
                print(json.dumps({'provider':provider,'result':'PASS','provider_pid':agent['pid'],'same_run':agent['spec']['run'],'event_cursor':result['conversation']['runtime_cursor']}),flush=True)
            except Exception as error:
                failures.append(provider);print(json.dumps({'provider':provider,'result':'FAIL','error':str(error)}),flush=True)
            # Do not leave paid work running after the smoke check.
            value=rpc('conversation.get',conversation_id=cid)
            if value['conversation']['status'] in ('starting','running','waiting','cancelling'):
                rpc('agent.cancel',conversation_id=cid)
                wait(lambda:rpc('conversation.get',conversation_id=cid)['conversation']['status'] not in ('starting','running','waiting','cancelling'),15)
            rpc('agent.disconnect',conversation_id=cid)
    finally:
        if daemon and daemon.poll() is None:daemon.terminate();daemon.wait(timeout=5)
        cleanup_runtimes();log.close()
    if failures:raise SystemExit('Live validation failed: '+', '.join(failures))
