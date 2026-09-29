#!/usr/bin/env python3
"""Opt-in real provider smoke; consumes model usage, never approves tool requests."""
from paths import TARGET_DIR, PROJECT_ROOT
from live_profile import profile_environment, missing_prerequisites
import argparse, json, os, signal, subprocess, sys, time, uuid
from pathlib import Path
from runtime import rpc as call
from runtime_test_support import track_runtime, cleanup_runtimes, scratch_directory


def main(report):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run',action='store_true',help='Authorize two real text-only model turns')
    args=parser.parse_args()
    missing=missing_prerequisites(['codex','claude'],args.run)
    if missing:
        report.update(status='failed',failureCategory='prerequisite-unavailable',missing=missing)
        print(json.dumps(report))
        raise SystemExit(1)
    signal.signal(signal.SIGTERM,signal.default_int_handler)
    DAEMON=TARGET_DIR / 'debug/ade-daemon'
    with scratch_directory(prefix='ade-live-handoff-',dir='/tmp') as tmp:
        root=Path(tmp); endpoint=root/'daemon.sock'; daemon=None
        env=profile_environment(root)
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
            nonlocal daemon
            daemon=subprocess.Popen([str(DAEMON)],env=env,stdout=log,stderr=log,start_new_session=True)
            def ready():
                if daemon.poll() is not None:raise AssertionError('Scratch daemon exited before startup')
                return rpc('hello')
            hello=wait(ready,15);track_runtime(hello)
        failures=[]
        try:
            start();wid=rpc('workspace.open',path=env['ADE_ROOT'])['workspace']['id']
            for provider in ('codex','claude'):
                report['unexecutedProviders'].remove(provider)
                cid=rpc('conversation.create',operation_id=str(uuid.uuid4()),workspace_id=wid,provider=provider,provider_config={'permission_mode':'read-only' if provider=='codex' else 'dontAsk'})['conversation']['id']
                key=str(uuid.uuid4());marker='ADE_HANDOFF_'+provider.upper()
                rpc('agent.send',conversation_id=cid,request_id=key,text=f'Do not use tools, read files, or change anything. This is a streaming transport test. Output exactly 120 numbered lines, each containing the number followed by {marker}. Do not shorten the list or add commentary.')
                def active():
                    value=rpc('conversation.get',conversation_id=cid,limit=200)
                    c=value['conversation']
                    if c['status'] in ('error','interrupted'):raise RuntimeError(c['error'])
                    if c['status']=='ready':raise RuntimeError('Model finished before an active restart could be tested')
                    if c['status']!='running' or not c['provider_thread_id']:return None
                    runtime=rpc('runtime.status')
                    agent=next(a for a in runtime['agents'] if a['spec']['conversation']==cid)
                    # Both adapters own a CLI below their bridge. The runtime publishes
                    # that process inventory periodically, after connected may arrive.
                    if not agent.get('descendants'):return None
                    return value,runtime,agent
                try:
                    before,runtime,agent=wait(active)
                    rpc('runtime.prepare_restart',operation_id=str(uuid.uuid4()),boot_id=runtime['boot_id']);daemon.wait(timeout=5);start()
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
                    outcome={'provider':provider,'result':'PASS','provider_pid':agent['pid'],'same_run':agent['spec']['run'],'event_cursor':result['conversation']['runtime_cursor']}
                    report['results'].append(outcome)
                    print(json.dumps(outcome),flush=True)
                except Exception as error:
                    failures.append(provider)
                    outcome={'provider':provider,'result':'FAIL','error_kind':type(error).__name__}
                    report['results'].append(outcome)
                    print(json.dumps(outcome),flush=True)
                # Do not leave paid work running after the smoke check.
                value=rpc('conversation.get',conversation_id=cid)
                if value['conversation']['status'] in ('starting','running','waiting','cancelling'):
                    rpc('agent.cancel',operation_id=str(uuid.uuid4()),conversation_id=cid)
                    wait(lambda:rpc('conversation.get',conversation_id=cid)['conversation']['status'] not in ('starting','running','waiting','cancelling'),15)
                rpc('agent.disconnect',operation_id=str(uuid.uuid4()),conversation_id=cid)
        finally:
            try:
                if daemon and daemon.poll() is None:
                    daemon.terminate()
                    try:daemon.wait(timeout=2)
                    except subprocess.TimeoutExpired:daemon.kill();daemon.wait(timeout=2)
            finally:
                try:cleanup_runtimes()
                finally:log.close()
        if failures:raise SystemExit('Live validation failed: '+', '.join(failures))
        report['status']='passed'


if __name__ == '__main__':
    report={'type':'live_provider_handoff','status':'failed','providers':['codex','claude'],
            'authentication_preflight':'unverified','unexecutedProviders':['codex','claude'],'results':[],
            'acceptanceScope':{'requirementIds':['R005'],'coverage':'active provider daemon handoff',
                               'fullRequirementAcceptance':'unverified'}}
    try:
        main(report)
    except KeyboardInterrupt:
        report.update(status='interrupted')
        print(json.dumps({'status':'interrupted'}))
        raise SystemExit(130)
    except Exception as error:
        # Keep native credential/provider error text out of shared artifacts.
        report.update(status='failed',failureCategory='execution-error',error_kind=type(error).__name__)
        print(json.dumps({'status':'failed','failureCategory':'execution-error','error_kind':type(error).__name__}))
        raise SystemExit(1)
    finally:
        # --help does not request acceptance and should not create a failed report.
        if not any(arg in ('--help','-h') for arg in sys.argv[1:]):
            directory=PROJECT_ROOT/'test-results'/'runs'/f'live-handoff-{uuid.uuid4()}'
            directory.mkdir(parents=True)
            (directory/'summary.json').write_text(json.dumps(report,indent=2)+'\n')
            print(f'Test report: {directory}',file=sys.stderr)
