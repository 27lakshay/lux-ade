#!/usr/bin/env python3
"""Real recovery with crash-boundary state injection; no model/account calls."""
from paths import PROJECT_ROOT, TARGET_DIR
import json, os, socket, sqlite3, subprocess, tempfile, time
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
with tempfile.TemporaryDirectory(prefix='ade-recovery-admission-',dir='/tmp') as tmp:
    root=Path(tmp); endpoint=root/'app.sock'; daemon=None
    env={**os.environ,'ADE_SOCKET':str(endpoint),'ADE_DATA_DIR':str(root/'data'),'ADE_ROOT':str(root),'SHELL':'/bin/sh',
         'ADE_CODEX_BIN':str(PROJECT/'scripts/fixtures/codex_mock.py'),'ADE_CODEX_TRANSPORT':'stdio','ADE_MOCK_DIR':str(root/'codex')}
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
    def calls(provider):
        p=root/provider/'calls.jsonl'
        return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []
    try:
        for supervisor_lost in ((True,) if os.environ.get("ADE_TEST_SUPERVISOR_LOSS") else (False, True)):
            start();wid=rpc('catalog.get')['catalog']['workspaces'][0]['id']
            cid=rpc('conversation.create',workspace_id=wid,provider='codex')['conversation']['id']
            rpc('agent.resume',conversation_id=cid);state(cid,'ready')
            rpc('queue.pause',conversation_id=cid,paused=True)
            queue_id='later-prompt-'+str(supervisor_lost)
            rpc('queue.enqueue',conversation_id=cid,request_id=queue_id,text='Must wait for user review')
            runtime_socket=Path(rpc('hello')['runtime_socket'])
            stop()
            # Inject the exact durable boundary: intent committed, supervisor
            # has not admitted send. Restore uses the actual saved state.
            with sqlite3.connect(root/'data/sessions.sqlite') as db:
                saved=json.loads(db.execute('SELECT data FROM conversations WHERE id=?',(cid,)).fetchone()[0])
                saved.update(status='starting',runtime_submission='unconfirmed-prompt',active_turn_id=None,queue_paused=False)
                db.execute('UPDATE conversations SET data=? WHERE id=?',(json.dumps(saved),cid))
            if supervisor_lost:
                cleanup_runtimes()
                wait(lambda:not runtime_socket.exists())
            before=len([c for c in calls('codex') if c['method']=='turn/start'])
            start()
            recovered=state(cid,'interrupted')
            if not supervisor_lost:
                assert 'not resent' in recovered['conversation']['error'],recovered
            rpc('agent.resume',conversation_id=cid);state(cid,'ready')
            # Queue worker observes resume; recovery must not grant permission
            # to skip the unconfirmed prompt and execute later instructions.
            time.sleep(.2)
            recovered=snapshot(cid)
            assert [q['id'] for q in recovered['queued']]==[queue_id], ('Recovery silently submitted a later prompt after an unconfirmed earlier send',supervisor_lost)
            assert recovered['conversation']['queue_paused'], 'Recovery must require explicit queue continuation'
            assert len([c for c in calls('codex') if c['method']=='turn/start'])==before,calls('codex')
            rpc('queue.pause',conversation_id=cid,paused=False)
            wait(lambda:len([c for c in calls('codex') if c['method']=='turn/start'])==before+1)
            state(cid,'ready')
            stop()
        print('PASS Recovery admission gap: daemon-only and supervisor loss; unconfirmed prompt not resent; later queue retained through resume until explicit continuation')
    except Exception:
        print((root/'daemon.log').read_text());raise
    finally:stop();cleanup_runtimes();log.close()
