#!/usr/bin/env python3
"""Real Git review through the daemon. All commits belong to disposable fixtures."""
from paths import PROJECT_ROOT, TARGET_DIR
import json, os, signal, socket, subprocess, tempfile, time, uuid
from pathlib import Path
from runtime_test_support import track_runtime, cleanup_runtimes
ROOT=PROJECT_ROOT
DAEMON=Path(os.environ.get('ADE_TEST_DAEMON',TARGET_DIR / 'release/ade-daemon'))
with tempfile.TemporaryDirectory(prefix='ade-review-') as tmp:
 root=Path(tmp).resolve();repo=root/'repository';repo.mkdir()
 env={k:v for k,v in os.environ.items() if not k.startswith(('GIT_','WORKTRUNK_'))}
 env.update(ADE_SOCKET=str(root/'daemon.sock'),ADE_DATA_DIR=str(root/'data'),ADE_ROOT=str(repo),SHELL='/bin/sh')
 daemon=None;workspace=None;log=(root/'daemon.log').open('a')
 def git(*args,check=True):
  p=subprocess.run(['git',*args],cwd=repo,env=env,capture_output=True,text=True)
  assert not check or p.returncode==0,(args,p.stderr)
  return p.stdout.strip()
 def rpc(op,allow_error=False,**fields):
  with socket.socket(socket.AF_UNIX) as peer:
   peer.settimeout(60);peer.connect(env['ADE_SOCKET']);peer.sendall((json.dumps({'op':op,'workspace_id':workspace,**fields})+'\n').encode());result=json.loads(peer.makefile('rb').readline())
  assert allow_error or result['type']!='error',result
  return result
 def wait(check,timeout=20):
  end=time.monotonic()+timeout
  while time.monotonic()<end:
   try:
    value=check()
    if value:return value
   except (ConnectionRefusedError,FileNotFoundError):pass
   time.sleep(.03)
  raise AssertionError('Timed out')
 def start():
  global daemon,workspace
  daemon=subprocess.Popen([str(DAEMON)],env=env,stdout=log,stderr=log,start_new_session=True)
  wait(lambda:rpc('catalog.get'))
  workspace=rpc('workspace.open',path=str(repo))['workspace']['id']
  track_runtime(rpc('hello'))
 def stop():
  global daemon
  if daemon and daemon.poll() is None:os.killpg(daemon.pid,signal.SIGTERM);daemon.wait(timeout=5)
  daemon=None
 def state():return rpc('review.status',force=True)
 def diff(path,staged=False):return rpc('review.diff',path=path,staged=staged)
 def operation(op,**fields):
  key=str(uuid.uuid4());request={'request_id':key,**fields};rpc(op,**request)
  job=wait(lambda: (v if (v:=rpc('review.operation',request_id=key)['operation'])['status']!='running' else None))
  return job,request
 def success(op,**fields):
  result,request=operation(op,**fields);assert result['status']=='succeeded',result;return result,request
 def file_action(path,staged=False):return success('review.unstage' if staged else 'review.stage',path=path,revision=state()['revision'])
 def hunk(path,staged=False,number=0):
  d=diff(path,staged);return success('review.hunk',path=path,staged=staged,token=d['token'],hunk=number)
 git('init','-b','main');git('config','user.name','Review Fixture');git('config','user.email','review@example.invalid');git('config','commit.gpgsign','false');git('config','core.hooksPath',str(repo/'.git/hooks'))
 try:
  start()
  # Unborn HEAD, literal pathspecs, untracked diff and unstage preserve work files.
  odd='[file]\nname.txt';(repo/odd).write_text('new file\n');(repo/'f.txt').write_text('not selected\n')
  assert '+new file' in diff(odd)['hunks'][0]
  hunk(odd);assert git('diff','--cached','--name-only','-z')==odd+'\0'
  file_action(odd,True);assert (repo/odd).read_text()=='new file\n' and not git('ls-files')
  file_action(odd);result,request=success('review.commit',message='Initial fixture',index_token=state()['index_token'])
  first=git('rev-parse','HEAD');assert result['result']['head']==first
  assert rpc('review.commit',**request)['operation']['status']=='succeeded' and git('rev-parse','HEAD')==first
  assert rpc('review.commit',allow_error=True,**{**request,'message':'changed'})['type']=='error'
  assert not git('ls-files','f.txt')
  # Two separate hunks; staging and reverse applying a hunk leave worktree intact.
  (repo/'multi.txt').write_text(''.join(f'line {i}\n' for i in range(40)));file_action('multi.txt')
  success('review.commit',message='Base lines',index_token=state()['index_token'])
  original=(repo/'multi.txt').read_text();changed=original.replace('line 2\n','first change\n').replace('line 35\n','second change\n');(repo/'multi.txt').write_text(changed)
  d=diff('multi.txt');assert len(d['hunks'])==2
  hunk('multi.txt');assert 'first change' in git('show',':multi.txt') and 'second change' not in git('show',':multi.txt')
  s=state();entry=next(f for f in s['files'] if f['path']=='multi.txt');assert entry['staged'] and entry['unstaged']
  hunk('multi.txt',True);assert git('show',':multi.txt')==original.strip() and (repo/'multi.txt').read_text()==changed
  # Stale hunk, file and commit requests refuse changing the current index.
  d=diff('multi.txt');old_state=state();(repo/'multi.txt').write_text(changed+'later\n')
  assert operation('review.hunk',path='multi.txt',staged=False,token=d['token'],hunk=0)[0]['status']=='failed'
  assert operation('review.stage',path='multi.txt',revision=old_state['revision'])[0]['status']=='failed'
  file_action('multi.txt');stale=state()['index_token'];file_action('f.txt')
  assert operation('review.commit',message='Must refuse stale index',index_token=stale)[0]['status']=='failed'
  # Ordinary Git hooks are respected, with errors and no accidental commit.
  hook=repo/'.git/hooks/pre-commit';hook.write_text('#!/bin/sh\necho fixture-hook-refused >&2\nexit 1\n');hook.chmod(0o755)
  before=git('rev-parse','HEAD');job,_=operation('review.commit',message='Must fail hook',index_token=state()['index_token'])
  assert job['status']=='failed' and 'fixture-hook-refused' not in job['error'] and git('rev-parse','HEAD')==before
  assert job['code']=='lifecycle_command_failed' and job['recovery']=='inspect_repository',job
  hook.unlink()
  success('review.commit',message='Explicit staged commit',index_token=state()['index_token'])
  # Binary, deletions, mode changes and newly staged files remain whole-file capable.
  (repo/'binary').write_bytes(b'\0\x01\x02');assert diff('binary')['binary'];file_action('binary');file_action('binary',True);assert (repo/'binary').exists()
  (repo/'f.txt').unlink();file_action('f.txt');file_action('f.txt',True);assert not (repo/'f.txt').exists()
  (repo/'multi.txt').chmod(0o755);assert not diff('multi.txt')['hunk_actions'];file_action('multi.txt');file_action('multi.txt',True)
  (repo/'multi.txt').chmod(0o644);(repo/'f.txt').write_text('not selected\n');(repo/'binary').unlink()
  # Selecting a nested workspace still resolves paths from the actual Git root.
  (repo/'nested').mkdir();nested=rpc('workspace.open',path=str(repo/'nested'))['workspace']['id']
  (repo/'outside.txt').write_text('root file\n')
  assert rpc('review.diff',workspace_id=nested,path='outside.txt',staged=False)['hunks']
  file_action('outside.txt');success('review.commit',message='Base conflict',index_token=state()['index_token'])
  # Conflict state blocks commit; resolving a whole file is explicit.
  git('checkout','-b','side');(repo/'outside.txt').write_text('side\n');git('add','outside.txt');git('commit','-m','Side')
  git('checkout','main');(repo/'outside.txt').write_text('main\n');git('add','outside.txt');git('commit','-m','Main');git('merge','side',check=False)
  assert state()['conflicts']==1 and diff('outside.txt')['conflict']
  assert operation('review.commit',message='Conflict must refuse',index_token=state()['index_token'])[0]['status']=='failed'
  (repo/'outside.txt').write_text('resolved\n');file_action('outside.txt');assert state()['conflicts']==0
  success('review.commit',message='Resolve fixture merge',index_token=state()['index_token'])
  # A slow hook locks out lux-ade lifecycle mutations but leaves catalogue reads responsive.
  (repo/'outside.txt').write_text('slow commit\n');file_action('outside.txt')
  marker=root/'hook-started';hook.write_text('#!/bin/sh\ntouch "'+str(marker)+'"\nsleep 2\n');hook.chmod(0o755)
  rid=rpc('worktree.repository',path=str(repo))['repository']['id']
  request={'request_id':str(uuid.uuid4()),'message':'Slow fixture','index_token':state()['index_token']};rpc('review.commit',**request);wait(marker.exists)
  assert rpc('worktree.refresh',allow_error=True,repository_id=rid,request_id=str(uuid.uuid4()))['type']=='error'
  durations=[]
  for _ in range(20):
   t=time.monotonic();rpc('catalog.get');durations.append((time.monotonic()-t)*1000)
  job=wait(lambda: (v if (v:=rpc('review.operation',request_id=request['request_id'])['operation'])['status']!='running' else None));assert job['status']=='succeeded',job
  hook.unlink();stop();start();assert rpc('review.commit',**request)['operation']['status']=='succeeded'
  # Daemon death does not unlock a surviving commit supervisor or replay a commit.
  (repo/'outside.txt').write_text('crash receipt test\n');file_action('outside.txt')
  marker.unlink();hook.write_text('#!/bin/sh\ntouch "'+str(marker)+'"\nsleep 3\n');hook.chmod(0o755)
  before=git('rev-parse','HEAD');count=git('rev-list','--count','HEAD')
  crash_request={'request_id':str(uuid.uuid4()),'message':'Commit across daemon crash','index_token':state()['index_token']}
  rpc('review.commit',**crash_request);wait(marker.exists);stop();start()
  assert rpc('review.commit',**crash_request)['operation']['status']=='interrupted'
  assert rpc('review.status',allow_error=True,force=True)['type']=='error'
  wait(lambda:git('rev-parse','HEAD')!=before,10)
  wait(lambda:rpc('review.status',allow_error=True,force=True).get('type')=='review_status',10)
  assert int(git('rev-list','--count','HEAD'))==int(count)+1
  assert rpc('review.commit',**crash_request)['operation']['status']=='interrupted'
  hook.unlink()
  # Large patches fail with a bounded, explicit error; file staging stays available.
  (repo/'large.txt').write_text('x'*5000000+'\n')
  oversized=rpc('review.diff',allow_error=True,path='large.txt',staged=False)
  assert oversized['code']=='lifecycle_invalid_output' and oversized['recovery']=='inspect_repository',oversized
  file_action('large.txt');file_action('large.txt',True);(repo/'large.txt').unlink()
  print(json.dumps({'result':'passed','catalog_max_ms_during_hook':round(max(durations),3),'cases':'unborn/literal paths/hunks/stale requests/commit idempotency/hooks/binary/deletion/mode/nested workspace/conflicts/lifecycle lock/restart/crash lock/no replay/large diff'}))
 finally:stop();cleanup_runtimes();log.close()
