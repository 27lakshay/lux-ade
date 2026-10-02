#!/usr/bin/env python3
"""Mixed adapters through the daemon and the real Claude bridge, using fake SDK/CLI."""
from paths import PROJECT_ROOT, TARGET_DIR
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
from runtime import rpc as call, PROJECT
from runtime_test_support import track_runtime, cleanup_runtimes

DAEMON=Path(os.environ.get('ADE_TEST_DAEMON',TARGET_DIR / 'release/ade-daemon'))
def wait(fn):
    until=time.monotonic()+15
    while time.monotonic()<until:
        try:
            value=fn()
            if value:return value
        except (FileNotFoundError,ConnectionRefusedError):pass
        time.sleep(.02)
    raise AssertionError('Timed out')

with tempfile.TemporaryDirectory(prefix='ade-providers-',dir='/tmp') as temporary:
    root=Path(temporary);endpoint=root/'app.sock';daemon=None
    env={**os.environ,'ADE_SOCKET':str(endpoint),'ADE_DATA_DIR':str(root/'data'),'ADE_ROOT':str(root),'SHELL':'/bin/sh',
         'ADE_CODEX_BIN':str(PROJECT/'scripts/fixtures/codex_mock.py'),'ADE_CODEX_TRANSPORT':'stdio','ADE_MOCK_DIR':str(root/'codex'),
         'ADE_E2E_CLAUDE_SDK':str(PROJECT/'providers/claude/worker-test-sdk.mjs'),'ADE_CLAUDE_WORKER_TEST_DIR':str(root/'claude'),
         'ADE_OMP_BIN':str(PROJECT/'providers/omp/mock-cli.mjs'),
         'ADE_OPENCODE_BIN':str(PROJECT/'providers/opencode/mock-server.mjs'),'ADE_MOCK_OPENCODE_DIR':str(root/'opencode')}
    log=(root/'daemon.log').open('ab')
    def rpc(op,**fields):return call(endpoint,{'op':op,**fields})
    def snapshot(cid):return rpc('conversation.get',conversation_id=cid,limit=200)
    def state(cid,name):
        try:return wait(lambda:(v if (v:=snapshot(cid))['conversation']['status']==name else None))
        except AssertionError as error:raise AssertionError(f'Expected {name}: {snapshot(cid)}') from error
    def start():
        global daemon
        daemon=subprocess.Popen([str(DAEMON)],env=env,stdout=log,stderr=log,start_new_session=True)
        def ready():
            if daemon.poll() is not None:raise AssertionError((root/'daemon.log').read_text())
            return rpc('hello')
        track_runtime(wait(ready))
    def stop():
        if daemon and daemon.poll() is None:daemon.terminate();daemon.wait(timeout=5)
    def denied(op,**fields):
        try:rpc(op,**fields)
        except RuntimeError:return
        raise AssertionError(f'{op} unexpectedly accepted')
    try:
        start();workspace=rpc('catalog.get')['catalog']['workspaces'][0]['id']
        providers=rpc('provider.list')['providers']
        assert {p['id'] for p in providers}=={'codex','claude','opencode','omp'}
        assert rpc('catalog.get')['providers']==providers
        for p in providers:
            for mode in p['permission_modes']:
                rpc('conversation.create',workspace_id=workspace,provider=p['id'],provider_config={'permission_mode':mode,'setting_sources':p['setting_sources']})
        denied('conversation.create',workspace_id=workspace,provider='codex',provider_config={'permission_mode':'plan'})
        denied('conversation.create',workspace_id=workspace,provider='codex',provider_config={'setting_sources':['project']})
        denied('conversation.create',workspace_id=workspace,provider='unknown')
        denied('conversation.create',workspace_id=workspace,provider='claude',provider_config={'permission_mode':'bypassPermissions'})
        conversations=[]
        for provider in ['codex','claude','opencode','omp']*2:
            config={'model':'fixture/model' if provider=='opencode' else 'fixture','permission_mode':'default','setting_sources':['project'] if provider=='claude' else []}
            c=rpc('conversation.create',workspace_id=workspace,provider=provider,provider_config=config)['conversation']
            assert c['provider_config']==config
            conversations.append(c)
        def send(c):
            key=str(uuid.uuid4());rpc('agent.send',conversation_id=c['id'],request_id=key,text='hello');return key
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:keys=list(pool.map(send,conversations))
        saved={}
        for c,key in zip(conversations,keys):
            value=state(c['id'],'ready');messages=value['messages'];saved[c['id']]=value
            assert len(messages)==2,(c,messages)
            assert messages[0]['id']==key and messages[0]['provider_item_id']
            assert messages[-1]['text']=={'claude':'Hello Claude','codex':'Hello world','opencode':'Hello OpenCode','omp':'Hello Oh My Pi'}[c['provider']]
            rpc('agent.send',conversation_id=c['id'],request_id=key,text='hello')
            assert len(snapshot(c['id'])['messages'])==2
        claude=conversations[1]['id'];codex=conversations[0]['id']
        opencode=conversations[2]['id']
        rpc('agent.send',conversation_id=codex,request_id=str(uuid.uuid4()),text='typed-plan')
        plan_snapshot=state(codex,'ready')
        plans=[m for m in plan_snapshot['messages'] if m.get('content',{}).get('type')=='plan']
        assert len(plans)==1 and plans[0]['content']['steps']==[{'step':'Inspect','status':'completed'}]
        rpc('agent.send',conversation_id=codex,request_id=str(uuid.uuid4()),text='typed-tool')
        tools=[m for m in state(codex,'ready')['messages'] if m.get('content',{}).get('type')=='tool']
        assert len(tools)==1 and tools[0]['content']['is_error'] and tools[0]['status']=='failed'
        assert tools[0]['content']['output']=='fixture failure'
        rpc('agent.send',conversation_id=codex,request_id=str(uuid.uuid4()),text='typed-subagents')
        child_messages=[m for m in state(codex,'ready')['messages'] if m.get('content',{}).get('type')=='subagents']
        assert len(child_messages)==1 and child_messages[0]['status']=='completed'
        assert {a['state'] for a in child_messages[0]['content']['agents']}=={'running','completed'}
        codex_child_selector={'conversation_id':codex,'message_id':child_messages[0]['id'],'child_id':'fixture-child-completed','offset':0}
        assert rpc('agent.child_transcript',**codex_child_selector)['items'][0]['text']=='Child Codex transcript'
        codex_calls=[json.loads(line) for line in (root/'codex/calls.jsonl').read_text().splitlines()]
        assert any(c['method']=='thread/read' and c['params']['threadId']=='fixture-child-completed' for c in codex_calls)
        assert not any(c['method']=='thread/resume' and c['params']['threadId']=='fixture-child-completed' for c in codex_calls)
        rpc('agent.send',conversation_id=opencode,request_id=str(uuid.uuid4()),text='typed-subagents')
        opencode_children=[m for m in state(opencode,'ready')['messages'] if m.get('content',{}).get('type')=='subagents']
        assert len(opencode_children)==1 and opencode_children[0]['status']=='completed'
        assert opencode_children[0]['content']['agents'][0]['state']=='running'
        assert opencode_children[0]['content']['agents'][0]['session_id']=='ses_fixture_child'
        opencode_child_selector={'conversation_id':opencode,'message_id':opencode_children[0]['id'],'child_id':'ses_fixture_child','offset':0}
        assert rpc('agent.child_transcript',**opencode_child_selector)['items'][0]['text']=='Child OpenCode transcript'
        child_page=rpc('agent.child_transcript',**opencode_child_selector)
        next_page=rpc('agent.child_transcript',**opencode_child_selector,cursor=child_page['next_cursor'])
        assert len(child_page['items'])==50 and len(next_page['items'])==5 and next_page['next_cursor'] is None
        for prompt in ['approval','questions']:
            rpc('agent.send',conversation_id=opencode,request_id=str(uuid.uuid4()),text=prompt)
            request=state(opencode,'waiting')['requests'][0]
            if prompt=='questions':
                denied('agent.answer',conversation_id=opencode,request_id=request['id'],decision='answer',answers={})
                rpc('agent.answer',conversation_id=opencode,request_id=request['id'],decision='answer',answers={'choice':'selected'})
            else:rpc('agent.answer',conversation_id=opencode,request_id=request['id'],decision='decline')
            state(opencode,'ready')
        rpc('agent.send',conversation_id=opencode,request_id=str(uuid.uuid4()),text='hold');state(opencode,'running')
        held_provider=snapshot(opencode)['conversation']['provider_thread_id']
        stop();start()
        assert state(opencode,'running')['conversation']['provider_thread_id']==held_provider
        rpc('agent.cancel',conversation_id=opencode);state(opencode,'interrupted')
        opencode_before=snapshot(opencode)
        rpc('agent.disconnect',conversation_id=opencode)
        rpc('agent.resume',conversation_id=opencode);opencode_after=state(opencode,'ready')
        assert [m['id'] for m in opencode_after['messages']]==[m['id'] for m in opencode_before['messages']]
        assert opencode_after['conversation']['provider_thread_id']==opencode_before['conversation']['provider_thread_id']
        assert [m for m in opencode_after['messages'] if m.get('content',{}).get('type')=='subagents']==opencode_children
        assert rpc('agent.child_transcript',**opencode_child_selector)['items'][0]['text']=='Child OpenCode transcript'
        omp=conversations[3]['id']
        rpc('agent.send',conversation_id=omp,request_id=str(uuid.uuid4()),text='typed-subagents')
        state(omp,'ready')
        def completed_omp_children():
            children=[m for m in snapshot(omp)['messages'] if m.get('content',{}).get('type')=='subagents']
            return children if len(children)==1 and children[0]['content']['agents'][0]['state']=='completed' else None
        omp_children=wait(completed_omp_children)
        omp_child_selector={'conversation_id':omp,'message_id':omp_children[0]['id'],'child_id':'fixture-child','offset':0}
        assert rpc('agent.child_transcript',**omp_child_selector)['items'][0]['text']=='Child Oh My Pi transcript'
        rpc('agent.send',conversation_id=claude,request_id=str(uuid.uuid4()),text='typed-subagents')
        state(claude,'ready')
        def completed_claude_children():
            messages=snapshot(claude)['messages']
            assert not any(m['text']=='Private child transcript' for m in messages)
            children=[m for m in messages if m.get('content',{}).get('type')=='subagents']
            return children if len(children)==1 and children[0]['content']['agents'][0]['state']=='completed' else None
        claude_children=wait(completed_claude_children)
        child_selector={'conversation_id':claude,'message_id':claude_children[0]['id'],'child_id':'fixture-child','offset':0}
        child_page=rpc('agent.child_transcript',**child_selector)
        assert child_page['items'][0]['text']=='Private child transcript' and child_page['next_offset'] is None
        denied('agent.child_transcript',**{**child_selector,'conversation_id':codex})
        denied('agent.child_transcript',**{**child_selector,'child_id':'unrelated-child'})
        denied('agent.child_transcript',**{**child_selector,'offset':100001})
        rpc('agent.send',conversation_id=claude,request_id=str(uuid.uuid4()),text='typed-tasks')
        task_plans=[m for m in state(claude,'ready')['messages'] if m.get('content',{}).get('type')=='plan']
        assert len(task_plans)==1 and task_plans[0]['content']['steps']==[{'step':'#task-1 Build','status':'completed'}]
        rpc('agent.disconnect',conversation_id=claude)
        rpc('agent.resume',conversation_id=claude)
        assert [m for m in state(claude,'ready')['messages'] if m.get('content',{}).get('type')=='plan']==task_plans
        for plan_cid,expected_status in [(claude,'completed'),(omp,'blocked')]:
            rpc('agent.send',conversation_id=plan_cid,request_id=str(uuid.uuid4()),text='typed-plan')
            plan_messages=[m for m in state(plan_cid,'ready')['messages'] if m.get('content',{}).get('type')=='plan']
            assert len(plan_messages)==(2 if plan_cid==claude else 1) and plan_messages[-1]['content']['steps'][0]['status']==expected_status
            rpc('agent.disconnect',conversation_id=plan_cid)
            rpc('agent.resume',conversation_id=plan_cid)
            restored_plans=[m for m in state(plan_cid,'ready')['messages'] if m.get('content',{}).get('type')=='plan']
            assert restored_plans==plan_messages
        for prompt in ['approval','questions']:
            rpc('agent.send',conversation_id=omp,request_id=str(uuid.uuid4()),text=prompt)
            request=state(omp,'waiting')['requests'][0]
            if prompt=='questions':
                denied('agent.answer',conversation_id=omp,request_id=request['id'],decision='answer',answers={})
                rpc('agent.answer',conversation_id=omp,request_id=request['id'],decision='answer',answers={'value':'selected'})
            else:rpc('agent.answer',conversation_id=omp,request_id=request['id'],decision='decline')
            state(omp,'ready')
        rpc('agent.send',conversation_id=omp,request_id=str(uuid.uuid4()),text='hold');state(omp,'running')
        stop();start();state(omp,'running')
        rpc('agent.cancel',conversation_id=omp);state(omp,'interrupted')
        omp_before=snapshot(omp)
        rpc('agent.disconnect',conversation_id=omp)
        rpc('agent.resume',conversation_id=omp);omp_after=state(omp,'ready')
        assert [m['id'] for m in omp_after['messages']]==[m['id'] for m in omp_before['messages']]
        assert omp_after['conversation']['provider_thread_id']==omp_before['conversation']['provider_thread_id']
        assert [m for m in omp_after['messages'] if m.get('content',{}).get('type')=='subagents']==omp_children
        assert rpc('agent.child_transcript',**omp_child_selector)['items'][0]['text']=='Child Oh My Pi transcript'
        for prompt in ['approval','questions']:
            rpc('agent.send',conversation_id=claude,request_id=str(uuid.uuid4()),text=prompt)
            value=state(claude,'waiting');request=value['requests'][0]
            denied('agent.answer',conversation_id=codex,request_id=request['id'],decision='decline')
            if prompt=='questions':
                denied('agent.answer',conversation_id=claude,request_id=request['id'],decision='answer',answers={'0':'one'})
                assert state(claude,'waiting')['requests'][0]['status']=='pending'
                rpc('agent.answer',conversation_id=claude,request_id=request['id'],decision='answer',answers={'0':'one','1':'two'})
            else:rpc('agent.answer',conversation_id=claude,request_id=request['id'],decision='decline')
            state(claude,'ready')
            denied('agent.answer',conversation_id=claude,request_id=request['id'],decision='accept')
        rpc('agent.send',conversation_id=claude,request_id=str(uuid.uuid4()),text='hold');state(claude,'running')
        rpc('agent.cancel',conversation_id=claude);state(claude,'interrupted')
        original=snapshot(claude);original_ids=[m['id'] for m in original['messages']]
        rpc('agent.disconnect',conversation_id=claude)
        rpc('agent.resume',conversation_id=claude);resumed=state(claude,'ready')
        assert [m['id'] for m in resumed['messages']]==original_ids
        assert resumed['conversation']['provider_thread_id']==original['conversation']['provider_thread_id']
        assert [m for m in resumed['messages'] if m.get('content',{}).get('type')=='subagents']==claude_children
        assert not any(m['text']=='Private child transcript' for m in resumed['messages'])
        # A crash preserves each adapter's identity and configuration independently.
        stop();start()
        assert [m for m in snapshot(codex)['messages'] if m.get('content',{}).get('type')=='plan']==plans
        assert [m for m in snapshot(codex)['messages'] if m.get('content',{}).get('type')=='tool']==tools
        assert [m for m in snapshot(codex)['messages'] if m.get('content',{}).get('type')=='subagents']==child_messages
        for c in conversations:
            rpc('agent.resume',conversation_id=c['id']);value=state(c['id'],'ready')
            assert value['conversation']['provider']==c['provider']
            assert value['conversation']['provider_config']==c['provider_config']
            assert value['conversation']['provider_thread_id']==saved[c['id']]['conversation']['provider_thread_id']
        rpc('agent.disconnect',conversation_id=claude)
        provider_id=snapshot(claude)['conversation']['provider_thread_id'];(root/'claude'/f'{provider_id}.json').unlink()
        rpc('agent.resume',conversation_id=claude);failed=state(claude,'error')
        assert failed['conversation']['provider_thread_id']==provider_id
        assert 'unavailable' in failed['conversation']['error']
        print('PASS providers: eight mixed Codex/Claude/OpenCode/Oh My Pi Agents, real OpenCode HTTP bridge, streaming, durable submission deduplication, config persistence, tool denial, questions, stale/cross-provider answers, cancel, crash/resume, no fresh-session fallback')
    except Exception:
        print((root/'daemon.log').read_text());raise
    finally:stop();cleanup_runtimes();log.close()
