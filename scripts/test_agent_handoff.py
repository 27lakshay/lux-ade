#!/usr/bin/env python3
"""Real adapters + Claude bridge; deterministic processes, no model/account calls."""
from paths import PROJECT_ROOT, TARGET_DIR
import json, os, signal, socket, sqlite3, subprocess, tempfile, time, uuid
from pathlib import Path
from runtime import rpc as call, PROJECT
from runtime_test_support import track_runtime, cleanup_runtimes
DAEMON=Path(os.environ.get('ADE_TEST_DAEMON',TARGET_DIR / 'release/ade-daemon'))
def wait(fn, timeout=20):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        try:
            value=fn()
            if value:return value
        except (FileNotFoundError,ConnectionRefusedError):pass
        time.sleep(.02)
    raise AssertionError('Timed out')
with tempfile.TemporaryDirectory(prefix='ade-agent-handoff-',dir='/tmp') as tmp:
    root=Path(tmp); endpoint=root/'app.sock'; daemon=None
    env={**os.environ,'ADE_SOCKET':str(endpoint),'ADE_DATA_DIR':str(root/'data'),'ADE_ROOT':str(root),'SHELL':'/bin/sh',
         'ADE_CODEX_BIN':str(PROJECT/'scripts/fixtures/codex_mock.py'),'ADE_CODEX_TRANSPORT':'stdio','ADE_MOCK_DIR':str(root/'codex'),
         'ADE_CLAUDE_BRIDGE_BIN':str(PROJECT/'scripts/fixtures/claude_mock.mjs'),'ADE_MOCK_CLAUDE_DIR':str(root/'claude')}
    log=(root/'daemon.log').open('ab')
    def rpc(op,**fields): return call(endpoint,{'op':op,**fields})
    def snapshot(cid):
        with socket.socket(socket.AF_UNIX) as peer:
            peer.settimeout(5);peer.connect(str(endpoint))
            peer.sendall((json.dumps({'op':'conversation.get','conversation_id':cid,'limit':200})+'\n').encode())
            return json.loads(peer.makefile('rb').readline(17*1024*1024))
    def state(cid,wanted):return wait(lambda:(v if (v:=snapshot(cid))['conversation']['status']==wanted else None))
    def start():
        global daemon
        daemon=subprocess.Popen([str(DAEMON)],env=env,stdout=log,stderr=log,start_new_session=True)
        def ready():
            if daemon.poll() is not None: raise AssertionError((root/'daemon.log').read_text())
            return rpc('hello')
        hello=wait(ready);track_runtime(hello);return hello
    def stop():
        if daemon and daemon.poll() is None:daemon.kill();daemon.wait(timeout=5)
    def replace(planned=True,offline=.15):
        before=rpc('runtime.status')
        if planned:rpc('runtime.prepare_restart',boot_id=before['boot_id']);daemon.wait(timeout=5)
        else:stop()
        time.sleep(offline);start()
        after=rpc('runtime.status')
        assert before['pid']!=after['pid'] and before['runtime_instance']==after['runtime_instance']
        assert before['terminals'][0]['metrics']['shell_pid']==after['terminals'][0]['metrics']['shell_pid']
        assert {a['spec']['run']:a['pid'] for a in before['agents']}=={a['spec']['run']:a['pid'] for a in after['agents']}
    def calls(provider):
        p=root/provider/'calls.jsonl'
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
    def denied(op,**fields):
        try:rpc(op,**fields)
        except RuntimeError:return
        raise AssertionError(f'{op} unexpectedly accepted')
    try:
        start();wid=rpc('catalog.get')['catalog']['workspaces'][0]['id']
        for provider in ('codex','claude'):
            cid=rpc('conversation.create',workspace_id=wid,provider=provider)['conversation']['id']
            def send(text):
                key=str(uuid.uuid4());rpc('agent.send',conversation_id=cid,request_id=key,text=text);return key
            # Partial transcript while the daemon disappears twice; provider keeps emitting.
            key=send('handoff-stream');state(cid,'running')
            wait(lambda:any(' [2]' in m['text'] for m in snapshot(cid)['messages']))
            replace();replace(False,.3)
            value=state(cid,'ready');expected=('Hello world' if provider=='codex' else 'Hello Claude')+''.join(f' [{i}]' for i in range(80))
            assert value['messages'][-1]['text']==expected,value
            cursor=value['conversation']['runtime_cursor'];assert cursor>80
            rpc('agent.send',conversation_id=cid,request_id=key,text='handoff-stream')
            assert len([c for c in calls(provider) if c['method']==('turn/start' if provider=='codex' else 'send')])==1
            # Independent tool child survives; no second tool execution.
            send('handoff-tool');state(cid,'running')
            tool=wait(lambda:next((c for c in calls(provider) if c['method'] in ('fixture/tool','tool')),None))
            tool_pid=tool['tool_pid'];os.kill(tool_pid,0)
            replace(False);os.kill(tool_pid,0)
            (root/provider/'release-tool').touch();state(cid,'ready')
            assert len([c for c in calls(provider) if c['method'] in ('fixture/tool','tool')])==1
            for prompt in ('approval','questions'):
                send(prompt);value=state(cid,'waiting');request=value['requests'][0]
                replace(prompt=='approval')
                restored=state(cid,'waiting');assert restored['requests'][0]['id']==request['id']
                assert restored['requests'][0]['run_id']==request['run_id']
                answers=({'first':'one','second':'two'} if provider=='codex' else {'0':'one','1':'two'})
                rpc('agent.answer',conversation_id=cid,request_id=request['id'],decision='answer' if prompt=='questions' else 'decline',**({'answers':answers} if prompt=='questions' else {}))
                state(cid,'ready');replace(False)
                denied('agent.answer',conversation_id=cid,request_id=request['id'],decision='accept')
            replies=[c for c in calls(provider) if c['method'] in ('approval/reply','answer')]
            assert len(replies)==2,replies
            if provider=='codex':
                send('large-approval');large=state(cid,'waiting')['requests'][0]
                assert len(large['params']['command'])>128*1024
                rpc('agent.answer',conversation_id=cid,request_id=large['id'],decision='decline');state(cid,'ready')
            send('hold');state(cid,'running');replace()
            if provider=='codex':
                before_abort=rpc('runtime.status')
                # An existing directory prevents atomic publication of the handoff file.
                blocked=root/'data/runtime-handoff.json';blocked.mkdir()
                try:denied('runtime.prepare_restart',boot_id=before_abort['boot_id'])
                finally:blocked.rmdir()
                assert rpc('runtime.status')['agents']==before_abort['agents']
                assert snapshot(cid)['conversation']['status']=='running'
                runtime_socket=Path(rpc('runtime.status')['runtime_socket']);moved=runtime_socket.with_suffix('.temporarily-hidden')
                runtime_socket.rename(moved)
                try:
                    wait(lambda:'Runtime connection unavailable' in (snapshot(cid)['conversation']['error'] or ''))
                    assert snapshot(cid)['conversation']['status']=='running'
                finally:moved.rename(runtime_socket)
                wait(lambda:snapshot(cid)['conversation']['error'] is None)
            rpc('agent.cancel',conversation_id=cid);state(cid,'interrupted')
            rpc('agent.disconnect',conversation_id=cid)
        # A dead supervisor must not leave the still-running daemon claiming an active Agent.
        cid=rpc('conversation.create',workspace_id=wid,provider='codex')['conversation']['id']
        rpc('agent.send',conversation_id=cid,request_id=str(uuid.uuid4()),text='hold');state(cid,'running')
        runtime_pid=rpc('runtime.status')['runtime_pid'];os.kill(runtime_pid,signal.SIGTERM)
        failed=state(cid,'error');assert 'Restart lux-ade' in failed['conversation']['error'],failed
        print('PASS Agent handoff: Codex/Claude process identity, stream replay without duplication, surviving tool child, stable permission/question identities, exactly one reply, cancel after replacement, planned and crash recovery, large approval payload, transient reconnect, explicit supervisor-loss failure')
    except Exception:
        print((root/'daemon.log').read_text());raise
    finally:stop();cleanup_runtimes();log.close()
