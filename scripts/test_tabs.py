#!/usr/bin/env python3
"""Real isolated shells: terminal identity, routing, persistence and handoff."""
from paths import PROJECT_ROOT, TARGET_DIR
import os, subprocess, tempfile, time, socket, json
from pathlib import Path
import runtime
from runtime_test_support import track_runtime,cleanup_runtimes
BINS=Path(os.environ.get('ADE_TEST_BIN_DIR',TARGET_DIR / 'release'))
with tempfile.TemporaryDirectory(prefix='ade-tabs-',dir='/tmp') as directory:
    root=Path(directory);endpoint=root/'app.sock';data=root/'data';log=(root/'test.log').open('w');daemon=None
    env={**os.environ,'ADE_SOCKET':str(endpoint),'ADE_DATA_DIR':str(data),'ADE_ROOT':directory,'SHELL':'/bin/sh'}
    def wait(fn):
        for _ in range(200):
            try:
                value=fn()
                if value:return value
            except (FileNotFoundError,ConnectionRefusedError):pass
            time.sleep(.03)
        raise AssertionError('timed out')
    def rpc(op,**kw):return runtime.rpc(endpoint,{'op':op,**kw})
    def start():
        process=subprocess.Popen([str(BINS/'ade-daemon')],env=env,stdout=log,stderr=log)
        wait(lambda:rpc('hello'));return process
    try:
        daemon=start();track_runtime(rpc('hello'))
        workspace=rpc('catalog.get')['catalog']['workspaces'][0];wid=workspace['id']
        ids=[workspace['terminal_id']]+[rpc('terminal.create',workspace_id=wid)['terminal_id']for _ in range(2)]
        other=root/'other';other.mkdir();second=rpc('workspace.open',path=str(other))['workspace']
        for index,tid in enumerate(ids):
            rpc('ping',workspace_id=wid,terminal_id=tid)
            with socket.socket(socket.AF_UNIX) as stream:
                stream.settimeout(5);stream.connect(str(endpoint))
                stream.sendall((json.dumps(dict(op='input',workspace_id=wid,terminal_id=tid,data=f"printf 'TAB_MARKER_{index}\\n'\n"))+'\n'+json.dumps({'op':'ping'})+'\n').encode())
                json.loads(stream.makefile('rb').readline())
        def screens_ready():
            screens=[bytes(rpc('snapshot',workspace_id=wid,terminal_id=tid)['terminal_screen_bytes']).decode(errors='replace')for tid in ids]
            return screens if all(f'TAB_MARKER_{i}'in screen for i,screen in enumerate(screens))else None
        screens=wait(screens_ready)
        for i,screen in enumerate(screens):
            for j in range(3):assert (f'TAB_MARKER_{j}'in screen)==(i==j),screens
        before=rpc('runtime.status');pids={t['workspace']['terminal_id']:t['metrics']['shell_pid']for t in before['terminals']};assert len(set(pids.values()))==3
        try:rpc('ping',workspace_id=second['id'],terminal_id=ids[1]);raise AssertionError('cross-workspace terminal accepted')
        except RuntimeError as error:assert 'Unknown workspace terminal'in str(error)
        tabs={'initialized':True,'terminals':[{'id':tid,'workspace_id':wid,'title':f'Terminal {i}'}for i,tid in enumerate(ids)],'browsers':[{'id':'browser-one','url':'http://localhost:3000','title':'Local'}],'active_terminal':ids[2],'active_browser':'browser-one','closed_terminals':[],'closed_browsers':[]}
        window=dict(id='tabs-window',workspace_id=wid,conversation_id=None,browser_url='http://localhost:3000',x=20,y=20,width=1200,height=800,tabs=tabs)
        rpc('window.save',window=window)
        # Closing/reordering views changes only the window record, never shell ownership.
        tabs['closed_terminals'].append(tabs['terminals'].pop(1));tabs['terminals'].reverse();rpc('window.save',window=window)
        assert {t['workspace']['terminal_id']:t['metrics']['shell_pid']for t in rpc('runtime.status')['terminals']}==pids
        rpc('runtime.prepare_restart',boot_id=before['boot_id']);daemon.wait(timeout=10);daemon=start()
        after=rpc('runtime.status');assert after['runtime_instance']==before['runtime_instance']
        assert {t['workspace']['terminal_id']:t['metrics']['shell_pid']for t in after['terminals']}==pids
        assert rpc('catalog.get')['catalog']['windows'][0]['tabs']==tabs
        tabs['terminals'].append(tabs['closed_terminals'].pop());tabs['active_terminal']=ids[1];rpc('window.save',window=window)
        assert rpc('ping',workspace_id=wid,terminal_id=ids[1])['metrics']['shell_pid']==pids[ids[1]]
        # Explicit retirement frees both durable capacity and supervisor entries.
        # Closing a view above deliberately did neither.
        for _ in range(80):
            tid=rpc('terminal.create',workspace_id=wid)['terminal_id']
            rpc('ping',workspace_id=wid,terminal_id=tid)
            try:rpc('terminal.retire',workspace_id=wid,terminal_id=tid);raise AssertionError('retired a live shell')
            except RuntimeError as error:assert 'Stop the shell' in str(error)
            rpc('terminal.stop',workspace_id=wid,terminal_id=tid)
            wait(lambda:any(t['workspace']['terminal_id']==tid and not t['metrics']['shell_running'] for t in rpc('runtime.status')['terminals']))
            rpc('terminal.retire',workspace_id=wid,terminal_id=tid)
            rpc('terminal.retire',workspace_id=wid,terminal_id=tid)
            assert all(t['workspace']['terminal_id']!=tid for t in rpc('runtime.status')['terminals'])
            assert len(next(w for w in rpc('catalog.get')['catalog']['workspaces'] if w['id']==wid)['extra_terminals'])==2
            try:rpc('ping',workspace_id=wid,terminal_id=tid);raise AssertionError('retired terminal resurrected')
            except RuntimeError as error:assert 'Unknown workspace terminal' in str(error)
        # Retirement removes saved open/closed views in every window.
        rpc('terminal.stop',workspace_id=wid,terminal_id=ids[1])
        wait(lambda:any(t['workspace']['terminal_id']==ids[1] and not t['metrics']['shell_running'] for t in rpc('runtime.status')['terminals']))
        rpc('terminal.retire',workspace_id=wid,terminal_id=ids[1])
        saved=rpc('catalog.get')['catalog']['windows'][0]['tabs']
        assert all(t['id']!=ids[1] for t in saved['terminals']+saved['closed_terminals'])
        print('RETIRE_PASS: 80 stop/retire cycles, live-shell protection, durable capacity reclamation, idempotent retirement and no resurrection')
        # Stop must also interrupt the foreground job holding the PTY open.
        tid=rpc('terminal.create',workspace_id=wid)['terminal_id'];rpc('ping',workspace_id=wid,terminal_id=tid)
        with socket.socket(socket.AF_UNIX) as stream:
            stream.connect(str(endpoint))
            stream.sendall((json.dumps({'op':'input','workspace_id':wid,'terminal_id':tid,'data':"printf '\\102USY_STARTED\\n'; sleep 5\n"})+'\n').encode())
        wait(lambda:'BUSY_STARTED' in bytes(rpc('snapshot',workspace_id=wid,terminal_id=tid)['terminal_screen_bytes']).decode(errors='replace'))
        stopped_at=time.monotonic();rpc('terminal.stop',workspace_id=wid,terminal_id=tid)
        wait(lambda:any(t['workspace']['terminal_id']==tid and not t['metrics']['shell_running'] for t in rpc('runtime.status')['terminals']))
        assert time.monotonic()-stopped_at<2,'Stop left the foreground job running'
        rpc('terminal.retire',workspace_id=wid,terminal_id=tid)
        print('TABS_PASS: three independent shells, cross-workspace rejection, close/reorder/reopen, durable tabs and daemon handoff preserve PIDs')
    finally:
        if daemon and daemon.poll()is None:
            daemon.terminate();daemon.wait(timeout=10)
        cleanup_runtimes();log.close()
