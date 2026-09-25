#!/usr/bin/env python3
"""Exercise durable service definitions through the public daemon API."""
from paths import PROJECT_ROOT, TARGET_DIR
import os
from pathlib import Path
import socket
import subprocess
import json
import sys
import tempfile
import time
from runtime import rpc as call, PROJECT
from runtime_test_support import track_runtime, cleanup_runtimes

DAEMON=TARGET_DIR / 'release/ade-daemon'
with tempfile.TemporaryDirectory(prefix='ade-services-',dir='/tmp') as temporary:
    root=Path(temporary).resolve(); endpoint=root/'app.sock'; daemon=None
    env={'PATH':os.environ['PATH'],'HOME':str(root),'SHELL':'/bin/sh','ADE_ROOT':str(root),
         'ADE_DATA_DIR':str(root/'data'),'ADE_SOCKET':str(endpoint)}
    log=(root/'daemon.log').open('ab')
    def rpc(op,**fields):return call(endpoint,{'op':op,**fields},timeout=15)
    def start():
        global daemon
        daemon=subprocess.Popen([str(DAEMON)],env=env,stdout=log,stderr=log,start_new_session=True)
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            if daemon.poll() is not None:raise AssertionError((root/'daemon.log').read_text())
            try:
                track_runtime(rpc('hello'));return
            except (FileNotFoundError,ConnectionRefusedError):time.sleep(.02)
        raise AssertionError('Daemon did not start')
    def stop():
        if daemon and daemon.poll() is None:daemon.terminate();daemon.wait(timeout=10)
    def denied(op,**fields):
        try:rpc(op,**fields)
        except RuntimeError:return
        raise AssertionError(f'{op} unexpectedly accepted')
    try:
        start();workspace=rpc('catalog.get')['catalog']['workspaces'][0]['id']
        config={'program':'pnpm','args':['dev'],'ports':['PORT']}
        first=rpc('service.configure',workspace_id=workspace,name='web',revision=0,config=config)['service']
        assert first['revision']==1 and first['hostname'].endswith('.localhost')
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1',first['ports']['PORT']));occupied.listen()
            stop();start()
            assert rpc('service.list',workspace_id=workspace)['services']==[first]
            assert rpc('service.configure',workspace_id=workspace,name='web',revision=0,config=config)['service']==first
            changed={**config,'args':['dev','--host']}
            denied('service.configure',workspace_id=workspace,name='web',revision=0,config=changed)
            updated=rpc('service.configure',workspace_id=workspace,name='web',revision=1,config=changed)['service']
            assert updated['ports']==first['ports'] and updated['hostname']==first['hostname']
            other=rpc('service.configure',workspace_id=workspace,name='api',revision=0,config=config)['service']
            assert other['ports']['PORT'] != first['ports']['PORT']
            denied('service.configure',workspace_id=workspace,name='escape',revision=0,config={**config,'cwd':'..'})
            denied('service.remove',workspace_id=workspace,name='web',revision=1)
            rpc('service.remove',workspace_id=workspace,name='web',revision=2)
            assert rpc('service.list',workspace_id=workspace)['services']==[other]
        stop();start()
        assert rpc('service.list',workspace_id=workspace)['services']==[other]
        # A real server plus a child process prove environment delivery, durable
        # PTY ownership and process-group cleanup without external services.
        directory=root/'web';directory.mkdir()
        fixture=root/'server.py'
        fixture.write_text("""import json,os,socket,subprocess,sys,time
from pathlib import Path
listener=socket.socket();listener.bind(('127.0.0.1',int(os.environ['PORT'])));listener.listen()
child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(120)'])
Path('started.json').write_text(json.dumps({'pid':os.getpid(),'child':child.pid,'cwd':os.getcwd(),'args':sys.argv[1:],'port':os.environ['PORT'],'custom':os.environ['CUSTOM'],'name':os.environ['ADE_SERVICE_NAME']}))
print('SERVICE OUTPUT READY',flush=True)
while True:time.sleep(.1)
""")
        config={'program':sys.executable,'args':[str(fixture),'literal $(no-shell)'],'cwd':'web','env':{'CUSTOM':'service-value'},'ports':['PORT']}
        service=rpc('service.configure',workspace_id=workspace,name='server',revision=0,config=config)['service']
        launched=rpc('service.start',workspace_id=workspace,name='server');terminal=launched['terminal_id']
        deadline=time.monotonic()+10
        while not (directory/'started.json').exists():
            assert time.monotonic()<deadline,'Service did not launch';time.sleep(.02)
        native=json.loads((directory/'started.json').read_text())
        assert native['pid']==launched['metrics']['shell_pid']
        assert rpc('service.list',workspace_id=workspace)['states']['server']['state']=='running'
        assert native['cwd']==str(directory) and native['args']==['literal $(no-shell)']
        assert native['custom']=='service-value' and native['name']=='server' and native['port']==str(service['ports']['PORT'])
        assert rpc('service.start',workspace_id=workspace,name='server')['metrics']['shell_pid']==native['pid']
        denied('service.configure',workspace_id=workspace,name='server',revision=1,config={**config,'args':[]})
        denied('service.remove',workspace_id=workspace,name='server',revision=1)
        denied('terminal.restart',workspace_id=workspace,terminal_id=terminal)
        denied('terminal.retire',workspace_id=workspace,terminal_id=terminal)
        stop();start()
        assert rpc('service.start',workspace_id=workspace,name='server')['metrics']['shell_pid']==native['pid']
        # Read the terminal snapshot through the same endpoint used by the client.
        with socket.socket(socket.AF_UNIX) as peer:
            peer.connect(str(endpoint));peer.sendall((json.dumps({'op':'snapshot','workspace_id':workspace,'terminal_id':terminal})+'\n').encode())
            view=json.loads(peer.makefile('rb').readline(8*1024*1024))
            assert 'SERVICE OUTPUT READY' in view['terminal']
        stopped=rpc('service.stop',workspace_id=workspace,name='server')['service']
        assert rpc('service.list',workspace_id=workspace)['states']['server']['state']=='stopped'
        assert stopped['terminal_owner'] is None and stopped['terminal_id']==terminal
        deadline=time.monotonic()+5
        for pid in [native['pid'],native['child']]:
            while True:
                try:os.kill(pid,0)
                except ProcessLookupError:break
                assert time.monotonic()<deadline,f'Service process {pid} survived stop';time.sleep(.02)
        assert rpc('service.stop',workspace_id=workspace,name='server')['service']==stopped
        again=rpc('service.start',workspace_id=workspace,name='server')
        assert again['terminal_id']==terminal and again['metrics']['shell_pid'] != native['pid']
        rpc('service.stop',workspace_id=workspace,name='server')
        with socket.socket() as conflict:
            conflict.bind(('127.0.0.1',service['ports']['PORT']));conflict.listen()
            denied('service.start',workspace_id=workspace,name='server')
        # Supervisor loss must never turn a service terminal into a login shell
        # or silently restart a lost service run.
        rpc('service.start',workspace_id=workspace,name='server')
        stop();cleanup_runtimes();start()
        assert rpc('service.list',workspace_id=workspace)['states']['server']['state']=='unavailable'
        denied('service.start',workspace_id=workspace,name='server')
        rpc('service.stop',workspace_id=workspace,name='server')
        recovered=rpc('service.start',workspace_id=workspace,name='server')
        assert recovered['terminal_id']==terminal
        rpc('service.stop',workspace_id=workspace,name='server')
        rpc('service.remove',workspace_id=workspace,name='server',revision=1)
        assert terminal not in rpc('catalog.get')['catalog']['workspaces'][0]['extra_terminals']
        broken=rpc('service.configure',workspace_id=workspace,name='broken',revision=0,config={'program':str(root/'missing-executable')})['service']
        denied('service.start',workspace_id=workspace,name='broken')
        reserved=next(s for s in rpc('service.list',workspace_id=workspace)['services'] if s['name']=='broken')
        assert reserved['terminal_owner'] is not None
        denied('service.remove',workspace_id=workspace,name='broken',revision=1)
        rpc('service.stop',workspace_id=workspace,name='broken')
        rpc('service.remove',workspace_id=workspace,name='broken',revision=1)
        print('PASS services: public configure/list/remove, restart persistence, stable occupied port, unique assignments, stale edit/remove fences, path validation, real service and child cleanup, same PTY across daemon restart, output and literal arguments, failed exec recovery, supervisor loss',flush=True)
    finally:
        stop();cleanup_runtimes();log.close()
