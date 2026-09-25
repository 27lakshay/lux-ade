#!/usr/bin/env python3
"""Real wt lifecycle through the daemon; only disposable repositories and hooks."""
from paths import PROJECT_ROOT, TARGET_DIR
import json, os, shutil, signal, socket, subprocess, tempfile, time, uuid
from pathlib import Path
from runtime_test_support import track_runtime, cleanup_runtimes
ROOT=PROJECT_ROOT
DAEMON=Path(os.environ.get('ADE_TEST_DAEMON',TARGET_DIR / 'debug/ade-daemon'))
WT=os.environ.get('ADE_WT_BIN',shutil.which('wt') or 'wt')
with tempfile.TemporaryDirectory(prefix='ade-worktrees-') as tmp:
 root=Path(tmp).resolve();repo=root/'project with spaces';repo.mkdir();empty=root/'empty.toml';empty.write_text('')
 env={k:v for k,v in os.environ.items() if not k.startswith(('WORKTRUNK_','GIT_'))}
 env.update(ADE_SOCKET=str(root/'daemon.sock'),ADE_DATA_DIR=str(root/'data'),ADE_ROOT=str(repo),ADE_WT_BIN=WT,SHELL='/bin/sh',ADE_CODEX_BIN=str(PROJECT_ROOT/'scripts/fixtures/codex_mock.py'),ADE_CODEX_TRANSPORT='stdio',ADE_MOCK_DIR=str(root/'provider'),GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL=str(empty))
 def git(*args):
  p=subprocess.run(['git',*args],cwd=repo,env=env,capture_output=True,text=True);assert p.returncode==0,p.stderr;return p.stdout.strip()
 git('init','-b','main');git('config','core.hooksPath',str(repo/'.git/hooks'));(repo/'file.txt').write_text('original\n');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Fixture')
 poison=root/'personal.toml';marker=root/'personal-ran';poison.write_text('[pre-start]\ncustom = '+json.dumps('touch '+str(marker))+'\n')
 # An ambient personal config and a repository Git hook must not leak into lux-ade.
 env['WORKTRUNK_CONFIG_PATH']=str(poison)
 hook=repo/'.git/hooks/post-checkout';hook.write_text('#!/bin/sh\ntouch "'+str(root/'git-hook-ran')+'"\n');hook.chmod(0o755)
 log=(root/'daemon.log').open('w');daemon=None;rid=None;owned=[]
 def start():
  global daemon
  daemon=subprocess.Popen([str(DAEMON)],env=env,stdout=log,stderr=log,start_new_session=True)
  wait(lambda:rpc('catalog.get',allow_error=True),10)
  track_runtime(rpc('hello'))
 def stop():
  global daemon
  if daemon and daemon.poll() is None:os.killpg(daemon.pid,signal.SIGTERM);daemon.wait(timeout=5)
  daemon=None
 def wait(fn,seconds=30):
  deadline=time.monotonic()+seconds
  while time.monotonic()<deadline:
   try:
    value=fn()
    if value:return value
   except (FileNotFoundError,ConnectionRefusedError):pass
   time.sleep(.03)
  raise AssertionError('Timed out')
 def rpc(op,allow_error=False,**kw):
  with socket.socket(socket.AF_UNIX) as s:
   s.settimeout(5);s.connect(env['ADE_SOCKET']);s.sendall((json.dumps({'op':op,**kw})+'\n').encode())
   if op=='input':return {}
   v=json.loads(s.makefile('rb').readline())
  assert allow_error or v['type']!='error',v
  return v
 def snapshot():return rpc('worktree.get',repository_id=rid)
 def operation(op,**kw):
  key=str(uuid.uuid4());request={'repository_id':rid,'request_id':key,**kw};rpc(op,**request)
  result=wait(lambda:next((j for j in snapshot()['operations'] if j['id']==key and j['status']!='running'),None))
  return result,request
 def create(branch,**kw):
  job,args=operation('worktree.switch',target=branch,create=True,**kw)
  assert job['status']=='succeeded',job
  item=next(x for x in snapshot()['worktrees'] if x['branch']==branch);owned.append(item['path']);assert item['ade_owned'];return item,job,args
 try:
  start();rid=rpc('worktree.repository',path=str(repo))['repository']['id']
  assert operation('worktree.refresh')[0]['status']=='succeeded'
  item,job,args=create('feature/demo',base='main');path=Path(item['path'])
  full=rpc('worktree.operation',repository_id=rid,request_id=job['id'])['operation'];assert 'stdout' in full['result'] and 'stdout' not in job['result']
  assert rpc('worktree.repository',path=str(path))['repository']['root']==str(repo)
  assert path.is_dir() and not marker.exists() and not (root/'git-hook-ran').exists()
  # Idempotency cannot create twice or reuse a key for another request.
  duplicate=rpc('worktree.switch',**args);assert next(j for j in duplicate['operations'] if j['id']==args['request_id'])['id']==job['id']
  assert rpc('worktree.switch',allow_error=True,**{**args,'target':'different'})['type']=='error'
  # Dirty removal fails, retains checkout, and records reconciled state.
  (path/'dirty.txt').write_text('keep me')
  failed,_=operation('worktree.remove',path=str(path));assert failed['status']=='failed' and path.exists(),failed
  assert next(i for i in snapshot()['worktrees'] if i['path']==str(path))['ade_owned']
  (path/'dirty.txt').unlink();done,_=operation('worktree.remove',path=str(path));assert done['status']=='succeeded' and not path.exists(),done
  assert git('rev-parse','--verify','feature/demo');owned.remove(str(path))
  # Existing branch checkout reuses its branch and creates a new owned worktree.
  job,_=operation('worktree.switch',target='feature/demo');assert job['status']=='succeeded',job
  path=Path(next(i['path'] for i in snapshot()['worktrees'] if i['branch']=='feature/demo'));owned.append(str(path))
  # A live daemon terminal protects its directory from removal.
  workspace=rpc('workspace.open',path=str(path))['workspace'];rpc('input',workspace_id=workspace['id'],data='echo lease\n');rpc('snapshot',workspace_id=workspace['id'])
  busy=rpc('worktree.remove',allow_error=True,repository_id=rid,request_id=str(uuid.uuid4()),path=str(path));assert busy['type']=='error' and 'active terminal' in busy['message'],busy
  # The replacement restores leases before exposing lifecycle commands.
  before=rpc('ping',workspace_id=workspace['id'])['metrics'];stop();start()
  after=rpc('ping',workspace_id=workspace['id'])['metrics'];assert before['shell_pid']==after['shell_pid']
  busy=rpc('worktree.remove',allow_error=True,repository_id=rid,request_id=str(uuid.uuid4()),path=str(path));assert busy['type']=='error' and 'active terminal' in busy['message'],busy
  rpc('input',workspace_id=workspace['id'],data='exit\n')
  def remove_after_exit():
   response=rpc('worktree.remove',allow_error=True,repository_id=rid,request_id='after-shell-exit',path=str(path))
   return response if response['type']!='error' else False
  wait(remove_after_exit);wait(lambda:any(j['id']=='after-shell-exit' and j['status']=='succeeded' for j in snapshot()['operations']));owned.remove(str(path))
  # Main/external checkout is never silently adopted for deletion.
  external=rpc('worktree.remove',allow_error=True,repository_id=rid,request_id=str(uuid.uuid4()),path=str(repo));assert external['type']=='error'
  # Agent ownership protects the directory independently of a terminal.
  item,_,_=create('agent-lease');workspace=rpc('workspace.open',path=item['path'])['workspace'];cid=rpc('conversation.create',workspace_id=workspace['id'])['conversation']['id']
  rpc('agent.send',conversation_id=cid,request_id='hold-agent',text='hold')
  wait(lambda:rpc('conversation.get',conversation_id=cid)['conversation']['status']=='running')
  assert rpc('agent.disconnect',allow_error=True,conversation_id=cid)['type']=='error'
  assert rpc('worktree.remove',allow_error=True,repository_id=rid,request_id='agent-busy',path=item['path'])['type']=='error'
  provider_pid=rpc('runtime.status')['agents'][0]['pid'];stop();start()
  assert rpc('runtime.status')['agents'][0]['pid']==provider_pid
  assert rpc('conversation.get',conversation_id=cid)['conversation']['status']=='running'
  assert rpc('worktree.remove',allow_error=True,repository_id=rid,request_id='agent-busy-after-restart',path=item['path'])['type']=='error'
  rpc('agent.cancel',conversation_id=cid);wait(lambda:rpc('conversation.get',conversation_id=cid)['conversation']['status'] not in ('running','waiting','starting','cancelling'))
  rpc('agent.disconnect',conversation_id=cid);done,_=operation('worktree.remove',path=item['path']);assert done['status']=='succeeded',done;owned.remove(item['path'])
  # Changing ownership evidence blocks removal even if the directory name matches.
  item,_,_=create('ownership');admin=subprocess.check_output(['git','rev-parse','--absolute-git-dir'],cwd=item['path'],env=env,text=True).strip();ownership=Path(admin)/'ade-owner';token=ownership.read_text();ownership.write_text('different-generation')
  assert rpc('worktree.remove',allow_error=True,repository_id=rid,request_id='wrong-owner',path=item['path'])['type']=='error'
  ownership.write_text(token);done,_=operation('worktree.remove',path=item['path'],delete_branch='merged');assert done['status']=='succeeded' and done['result']['branch_outcome']=='deleted',done;owned.remove(item['path'])
  # Path policy is repository-local; arbitrary personal commands stay opt-in.
  template=str(root/'custom checkouts'/'{{ branch | sanitize }}')
  rpc('worktree.configure',repository_id=rid,config={'path_template':template})
  item,_,_=create('custom');assert Path(item['path']).parent==root/'custom checkouts'
  stop();start();assert snapshot()['repository']['config']['path_template']==template
  assert next(i for i in snapshot()['worktrees'] if i['branch']=='custom')['ade_owned']
  done,_=operation('worktree.remove',path=item['path']);assert done['status']=='succeeded',done;owned.remove(item['path'])
  # An explicitly supplied user hook failing after checkout is not a rollback.
  cfg=root/'explicit.toml';cfg.write_text('[pre-start]\nfail = "exit 7"\n')
  rpc('worktree.configure',repository_id=rid,config={'user_config':str(cfg),'project_config':str(empty),'hooks':True})
  failed,_=operation('worktree.switch',target='setup-fails',create=True)
  assert failed['status']=='failed',failed
  partial=next(i for i in snapshot()['worktrees'] if i['branch']=='setup-fails');assert Path(partial['path']).exists() and partial['ade_owned'];owned.append(partial['path'])
  # A failed setup must remain an Agent admission barrier across daemon restart.
  workspace=rpc('workspace.open',path=partial['path'])['workspace']
  cid=rpc('conversation.create',workspace_id=workspace['id'])['conversation']['id']
  for restarted in (False,True):
   if restarted:stop();start()
   denied=rpc('agent.send',allow_error=True,conversation_id=cid,request_id='unprepared-agent',text='hold')
   assert denied['type']=='error' and 'setup' in denied['message'].lower(),denied
   denied=rpc('agent.resume',allow_error=True,conversation_id=cid)
   assert denied['type']=='error' and 'setup' in denied['message'].lower(),denied
  # Switching to the partial checkout must rerun the failed creation hook.
  retried,_=operation('worktree.switch',target='setup-fails')
  assert retried['status']=='failed',retried
  assert next(i for i in snapshot()['worktrees'] if i['branch']=='setup-fails')['setup_state']=='failed'
  # Renaming a branch must not erase the checkout's failed setup obligation.
  renamed=subprocess.run(['git','branch','-m','setup-renamed'],cwd=partial['path'],env=env,capture_output=True,text=True)
  assert renamed.returncode==0,renamed.stderr
  assert operation('worktree.refresh')[0]['status']=='succeeded'
  denied=rpc('agent.send',allow_error=True,conversation_id=cid,request_id='renamed-unprepared',text='hold')
  assert denied['type']=='error' and 'setup' in denied['message'].lower(),denied
  retried,_=operation('worktree.switch',target='setup-renamed')
  assert retried['status']=='failed',retried
  cfg.write_text('[pre-start]\nrepair = "true"\n')
  rpc('queue.enqueue',conversation_id=cid,request_id='unprepared-queued',text='hold')
  queued=wait(lambda: (value if (value:=rpc('conversation.get',conversation_id=cid))['conversation']['queue_paused'] else None))
  assert 'setup' in queued['conversation']['error'].lower() and len(queued['queued'])==1,queued
  rpc('queue.cancel',conversation_id=cid,request_id='unprepared-queued')
  repaired,_=operation('worktree.switch',target='setup-renamed')
  assert repaired['status']=='succeeded',repaired
  rpc('agent.send',conversation_id=cid,request_id='repaired-agent',text='hold')
  wait(lambda:rpc('conversation.get',conversation_id=cid)['conversation']['status']=='running')
  rpc('agent.cancel',conversation_id=cid)
  wait(lambda:rpc('conversation.get',conversation_id=cid)['conversation']['status'] not in ('running','waiting','starting','cancelling'))
  rpc('agent.disconnect',conversation_id=cid)
  rpc('worktree.configure',repository_id=rid,config={})
  done,_=operation('worktree.remove',path=partial['path']);assert done['status']=='succeeded',done;owned.remove(partial['path'])
  # Repository hooks retain Worktrunk's approval gate; no automatic --yes.
  untrusted=root/'untrusted.toml';not_run=root/'unapproved-hook-ran';untrusted.write_text('[pre-start]\ncustom = '+json.dumps('touch '+str(not_run))+'\n')
  rpc('worktree.configure',repository_id=rid,config={'project_config':str(untrusted),'hooks':True})
  blocked,_=operation('worktree.switch',target='needs-approval',create=True);assert blocked['status']=='failed' and 'approv' in blocked['error'].lower() and not not_run.exists(),blocked
  rpc('worktree.configure',repository_id=rid,config={})
  for item in snapshot()['worktrees']:
   if item.get('branch')=='needs-approval' and item.get('ade_owned'):assert operation('worktree.remove',path=item['path'])[0]['status']=='succeeded'
  # Timeouts kill the operation group, then reconcile the partial checkout.
  timeout_config=root/'timeout.toml';timeout_config.write_text('[pre-start]\nwait = "sleep 30"\n')
  rpc('worktree.configure',repository_id=rid,config={'user_config':str(timeout_config),'project_config':str(empty),'hooks':True,'timeout_seconds':5})
  begin=time.monotonic();timed,_=operation('worktree.switch',target='times-out',create=True);assert timed['status']=='failed' and time.monotonic()-begin<12,timed
  item=next(i for i in snapshot()['worktrees'] if i['branch']=='times-out');owned.append(item['path'])
  rpc('worktree.configure',repository_id=rid,config={});assert operation('worktree.remove',path=item['path'])[0]['status']=='succeeded';owned.remove(item['path'])
  # Slow setup stays off the Conversation/control path and serializes mutations.
  slow=root/'slow.toml';slow.write_text('[pre-start]\nwait = "sleep 2"\n')
  rpc('worktree.configure',repository_id=rid,config={'user_config':str(slow),'project_config':str(empty),'hooks':True})
  key='slow-operation';rpc('worktree.switch',repository_id=rid,request_id=key,target='slow',create=True)
  rejected=rpc('worktree.refresh',allow_error=True,repository_id=rid,request_id='conflict');assert rejected['type']=='error' and 'running' in rejected['message']
  timings=[]
  for _ in range(20):
   begin=time.monotonic();rpc('catalog.get');timings.append(time.monotonic()-begin);time.sleep(.02)
  assert max(timings)<.1,timings
  slow_job=wait(lambda:next((j for j in snapshot()['operations'] if j['id']==key and j['status']!='running'),None));assert slow_job['status']=='succeeded',slow_job
  item=next(i for i in snapshot()['worktrees'] if i['branch']=='slow');owned.append(item['path'])
  rpc('worktree.configure',repository_id=rid,config={});done,_=operation('worktree.remove',path=item['path']);assert done['status']=='succeeded';owned.remove(item['path'])
  # Daemon death preserves an interrupted receipt; surviving wt holds the lock.
  slow.write_text('[pre-start]\nwait = "sleep 3"\n')
  rpc('worktree.configure',repository_id=rid,config={'user_config':str(slow),'project_config':str(empty),'hooks':True})
  key='interrupted-operation';params={'repository_id':rid,'request_id':key,'target':'interrupted','create':True}
  rpc('worktree.switch',**params)
  expected=repo.parent/(repo.name+'.interrupted');wait(lambda:expected.is_dir());stop();start()
  interrupted=next(j for j in snapshot()['operations'] if j['id']==key);assert interrupted['status']=='interrupted',interrupted
  assert next(j for j in rpc('worktree.switch',**params)['operations'] if j['id']==key)['status']=='interrupted'
  locked=rpc('worktree.refresh',allow_error=True,repository_id=rid,request_id='locked-after-restart');assert locked['type']=='error' and 'lock' in locked['message'],locked
  def refresh_after_child():
   value=rpc('worktree.refresh',allow_error=True,repository_id=rid,request_id='reconcile-after-restart')
   return value if value['type']!='error' else False
  wait(refresh_after_child,10);wait(lambda:any(j['id']=='reconcile-after-restart' and j['status']=='succeeded' for j in snapshot()['operations']))
  interrupted_tree=next(i for i in snapshot()['worktrees'] if i['branch']=='interrupted');assert Path(interrupted_tree['path']).is_dir()
  # Ownership not yet recorded at the crash is not guessed. The original wt tool
  # cleans this disposable fixture explicitly during finally.
  owned.append(interrupted_tree['path'])
  print(f"Lifecycle setup concurrent catalog RPC max: {max(timings)*1000:.2f} ms")
  print('PASS worktrees: real wt schema 2, neutral defaults, create/existing branch, configurable paths, durable ownership/config, idempotency, dirty refusal, terminal/Agent leases, branch outcomes, ownership generation, approval refusal, timeout, partial hook failure, concurrency and crash reconciliation')
 finally:
  stop();cleanup_runtimes()
  stop();log.close()
  listed=subprocess.run(['git','worktree','list','--porcelain'],cwd=repo,env=env,capture_output=True,text=True)
  owned=[line.removeprefix('worktree ') for line in listed.stdout.splitlines() if line.startswith('worktree ') and Path(line.removeprefix('worktree '))!=repo]
  if owned:
   clean={k:v for k,v in env.items() if not k.startswith('WORKTRUNK_')};clean['WORKTRUNK_SYSTEM_CONFIG_PATH']=str(empty)
   for path in owned:
    subprocess.run([WT,'--config',str(empty),'-C',str(repo),'remove','--no-hooks','--no-delete-branch','--foreground','--',path],env=clean,capture_output=True,timeout=20)
