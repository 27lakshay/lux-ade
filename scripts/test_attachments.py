#!/usr/bin/env python3
"""Exercise immutable attachments through real adapters with fixture providers."""
from paths import PROJECT_ROOT, TARGET_DIR
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from runtime import rpc, PROJECT
from runtime_test_support import track_runtime, cleanup_runtimes

DAEMON=Path(os.environ.get('ADE_TEST_DAEMON',TARGET_DIR / 'debug/ade-daemon'))
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
with tempfile.TemporaryDirectory(prefix='ade-attachments-',dir='/tmp') as tmp:
    root=Path(tmp);endpoint=root/'app.sock';daemon=None
    env={**os.environ,'ADE_SOCKET':str(endpoint),'ADE_DATA_DIR':str(root/'data'),'ADE_ROOT':str(root),'SHELL':'/bin/sh',
         'ADE_CODEX_BIN':str(PROJECT/'scripts/fixtures/codex_mock.py'),'ADE_CODEX_TRANSPORT':'stdio','ADE_MOCK_DIR':str(root/'codex'),
         'ADE_CLAUDE_BRIDGE_BIN':str(PROJECT/'scripts/fixtures/claude_mock.mjs'),'ADE_MOCK_CLAUDE_DIR':str(root/'claude')}
    log=(root/'daemon.log').open('ab')
    def call(op,**fields):return rpc(endpoint,{'op':op,**fields})
    def wait(fn):
        end=time.monotonic()+15
        while time.monotonic()<end:
            try:
                value=fn()
                if value:return value
            except (FileNotFoundError,ConnectionRefusedError):pass
            time.sleep(.02)
        raise AssertionError('Timed out: '+(root/'daemon.log').read_text()[-4000:])
    def start():
        global daemon
        daemon=subprocess.Popen([str(DAEMON)],env=env,stdout=log,stderr=log,start_new_session=True)
        track_runtime(wait(lambda:call('hello')))
    def stop():
        if daemon and daemon.poll() is None:daemon.terminate();daemon.wait(timeout=5)
    def snapshot(cid):return call('conversation.get',conversation_id=cid,limit=100)
    def ready(cid):return wait(lambda: (v if (v:=snapshot(cid))['conversation']['status']=='ready' else None))
    def denied(op,**fields):
        try:call(op,**fields)
        except RuntimeError:return
        raise AssertionError(op+' accepted invalid attachment content')
    try:
        start();wid=call('catalog.get')['catalog']['workspaces'][0]['id'];cases=[]
        for provider in ['codex','claude']:
            cid=call('conversation.create',workspace_id=wid,provider=provider)['conversation']['id']
            textfile=root/(provider+'.txt');textfile.write_text('Original file contents')
            image=call('attachment.put',conversation_id=cid,request_id=provider+'-image',name='pixel.png',data=base64.b64encode(PNG).decode())['attachment']
            file=call('attachment.import',conversation_id=cid,request_id=provider+'-file',path=str(textfile))['attachment']
            attachments=[image,file]
            assert image['media_type']=='image/png' and file['media_type']=='text/plain'
            call('attachment.put',conversation_id=cid,request_id=provider+'-image',name='pixel.png',data=base64.b64encode(PNG).decode())
            denied('attachment.put',conversation_id=cid,request_id=provider+'-image',name='changed.png',data=base64.b64encode(PNG).decode())
            denied('attachment.put',conversation_id=cid,request_id=provider+'-invalid',name='binary',data='AAAA')
            denied('attachment.import',conversation_id=cid,request_id=provider+'-directory',path=str(root))
            call('draft.save',conversation_id=cid,window_id='attachments-window',text='Review this',attachments=attachments,revision=1)
            call('queue.pause',conversation_id=cid,paused=True)
            call('queue.enqueue',conversation_id=cid,request_id=provider+'-send',text='Review this',attachments=attachments)
            denied('queue.enqueue',conversation_id=cid,request_id=provider+'-send',text='Review this',attachments=[image])
            denied('queue.enqueue',conversation_id=cid,request_id=provider+'-forged',text='No',attachments=[{**image,'name':'forged'}])
            denied('queue.enqueue',conversation_id=cid,request_id=provider+'-duplicate',text='No',attachments=[image,image])
            textfile.write_text('Changed after attachment');textfile.unlink()
            cases.append((provider,cid,attachments))
        denied('queue.enqueue',conversation_id=cases[1][1],request_id='cross-conversation',text='No',attachments=cases[0][2])
        stop();start()
        for provider,cid,attachments in cases:
            assert call('draft.get',conversation_id=cid,window_id='attachments-window')['draft']['attachments']==attachments
            assert snapshot(cid)['queued'][0]['attachments']==attachments
            call('queue.pause',conversation_id=cid,paused=False)
            v=ready(cid);user=next(m for m in v['messages'] if m['role']=='user')
            assert user['text']=='Review this' and user['attachments']==attachments,user
            call('agent.send',conversation_id=cid,request_id=provider+'-send',text='Review this',attachments=attachments)
            denied('agent.send',conversation_id=cid,request_id=provider+'-send',text='Review this',attachments=[attachments[0]])
            calls=[json.loads(s) for s in (root/provider/'calls.jsonl').read_text().splitlines()]
            if provider=='codex':
                sends=[c for c in calls if c['method']=='turn/start'];assert len(sends)==1
                content=sends[0]['params']['input']
                assert content[1]['url']=='data:image/png;base64,'+base64.b64encode(PNG).decode()
                assert content[2]['text'].endswith('Original file contents')
            else:
                sends=[c for c in calls if c['method']=='send'];assert len(sends)==1
                content=sends[0]['text']
                assert content[1]['source']=={'type':'base64','media_type':'image/png','data':base64.b64encode(PNG).decode()}
                assert content[2]['text'].endswith('Original file contents')
            call('queue.enqueue',conversation_id=cid,request_id=provider+'-image-only',text='',attachments=[attachments[0]])
            wait(lambda:any(m['id']==provider+'-image-only' for m in snapshot(cid)['messages']))
            ready(cid)
            call('draft.save',conversation_id=cid,window_id='attachments-window',text='',revision=2,attachments=[])
            assert call('draft.get',conversation_id=cid,window_id='attachments-window')['draft']['text']==''
            call('agent.disconnect',conversation_id=cid)
        stop();start()
        for provider,cid,attachments in cases:
            call('agent.resume',conversation_id=cid);v=ready(cid)
            users=[m for m in v['messages'] if m['role']=='user']
            assert len(users)==2 and users[0]['text']=='Review this' and users[0]['attachments']==attachments,users
            assert users[1]['text']=='' and users[1]['attachments']==[attachments[0]],users
            assert not call('draft.get',conversation_id=cid,window_id='attachments-window')['draft'].get('attachments')
        print('PASS attachments: immutable bytes, restart-safe drafts/queue, full-payload idempotency, ownership/metadata checks, both provider wire formats, image-only prompts, clear and resume')
    finally:
        stop();cleanup_runtimes();log.close()
