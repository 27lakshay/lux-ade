#!/usr/bin/env python3
"""Real release UI, SQLite, stdio adapters and independent PTYs; synthetic Agents.
CPU100%=one logical core. RSS excludes GPU allocation. GPUI callbacks are not
input-to-photon. Emission timestamps and consumer counts reveal coalescing.
WebKit helpers use launch-delta attribution, so unrelated new WebKit processes
can contaminate that group. No model/network calls; fixtures run in temp folders.
"""
from paths import PROJECT_ROOT, TARGET_DIR
import argparse,hashlib,json,os,shlex,signal,socket,subprocess,tempfile,time
from pathlib import Path
from runtime_test_support import track_runtime,cleanup_runtimes
from benchmark import processes,request,load,wait_for as wait_until,stop
ROOT=PROJECT_ROOT;BINS=TARGET_DIR / 'release'
FIXTURE=Path(__file__).with_name('fixtures')/'codex_stream.py'
TERMINAL=Path(__file__).with_name('benchmark_fixture.py')

def wait_for(check,seconds=60):
 def ready():
  try:return check()
  except (ConnectionError,FileNotFoundError):return False
 return wait_until(ready,seconds)

def benchmark_dock_layout(conversation_id, terminal_id):
 """Exercise retained chat and PTY panels together; never activate a browser."""
 def tabs(panel_id,kind,content_id):
  return {'panel_name':'TabPanel','children':[{'panel_name':'ade.content','children':[],
   'info':{'panel':{'id':panel_id,'kind':kind,'content_id':content_id}}}],
   'info':{'tabs':{'active_index':0}}}
 return {'dock':{'version':1,'center':{'panel_name':'SplitPanel',
  'children':[tabs('bench-chat','chat',conversation_id),tabs('bench-terminal','terminal',terminal_id)],
  'info':{'stack':{'sizes':[500,240],'axis':1}}}},'active_panel':'bench-chat','closed':[]}

def run(count,out,seconds,history,reconnect_cycles=1,terminal_output=True,profile_memory=False):
 with tempfile.TemporaryDirectory(prefix='ade-runtime-') as directory:
  root=Path(directory);endpoint=str(root/'daemon.sock');log=(out/'process.log').open('w')
  env={**os.environ,'ADE_SOCKET':endpoint,'ADE_DATA_DIR':str(root/'data'),'ADE_ROOT':directory,'ADE_CODEX_BIN':str(FIXTURE),'ADE_CODEX_TRANSPORT':'stdio','ADE_MOCK_DIR':str(root/'provider'),'SHELL':'/bin/sh'}
  env.pop('ADE_BENCH_CONTROL',None);env.pop('ADE_GPU_BENCH_LOG',None)
  dmetrics=out/'daemon.json';cmetrics=out/'client.json';daemon=None;client=None
  def rpc(op,**kw):
   value=request(endpoint,{'op':op,**kw});assert value['type']!='error',value;return value
  def launch_daemon():return subprocess.Popen([str(BINS/'ade-daemon')],env={**env,'ADE_BENCH_LOG':str(dmetrics)},stdout=log,stderr=log,start_new_session=True)
  def launch_client():
   cmetrics.unlink(missing_ok=True)
   return subprocess.Popen([str(BINS/'ade-client')],env={**env,'ADE_BENCH_LOG':str(cmetrics),'ADE_BENCH_START_US':str(time.time_ns()//1000),'ADE_BENCH_RESTORE_WINDOWS':'1','ADE_BENCH_RESTORE_TERMINALS':'1'},stdout=log,stderr=log,start_new_session=True)
  try:
   daemon=launch_daemon();wait_for(lambda:Path(endpoint).exists(),10)
   hello=rpc("hello");track_runtime(hello);runtime_pid=hello["runtime_pid"]
   workspaces=[];conversations=[]
   for i in range(count):
    folder=root/f'workspace-{i}';folder.mkdir();w=rpc('workspace.open',path=str(folder))['workspace'];workspaces.append(w)
    c=rpc('conversation.create',workspace_id=w['id'],title=f'Benchmark {i}')['conversation'];conversations.append(c['id'])
    rpc('window.save',window={'id':f'window-{i}','workspace_id':w['id'],'conversation_id':c['id'],'dock_layout':benchmark_dock_layout(c['id'],w['terminal_id']),'browser_url':'','x':60+i*20,'y':60+i*20,'width':1220,'height':800})
    if history:rpc('agent.send',conversation_id=c['id'],request_id=f'seed-{i}',text=f'seed:{history}')
   if history:wait_for(lambda:all(rpc('conversation.get',conversation_id=c)['conversation']['status']=='ready' for c in conversations),30)
   baseline={pid for pid,p in processes().items() if 'com.apple.WebKit.' in p['command']}
   client=launch_client();wait_for(lambda:load(cmetrics).get('restore_us',{}).get('count',0)>=count,45)
   cold=load(cmetrics)
   def category(pid,table):
    if pid==client.pid:return 'client'
    if pid==daemon.pid:return 'daemon'
    if pid==runtime_pid:return 'runtime'
    if 'com.apple.WebKit.' in table[pid]['command'] and pid not in baseline:return 'webkit_launch_delta'
    cur=pid;seen=set()
    while cur in table and cur not in seen:
     seen.add(cur);parent=table[cur]['parent']
     if parent==client.pid:return 'attach'
     if parent in (daemon.pid,runtime_pid):return 'provider_or_shell'
     cur=parent
   def measure(label,duration):
    first=previous=processes();start=time.monotonic();cpu={};peak={};rtts=[];next_ping=start
    while time.monotonic()-start<duration:
     if time.monotonic()>=next_ping:
      ts=time.monotonic();rpc('catalog.get');rtts.append((time.monotonic()-ts)*1000);next_ping=time.monotonic()+.25
      if terminal_output and label in ('agents_and_terminals','reconnected_while_streaming'):
       for w in workspaces:rpc('input',workspace_id=w['id'],data=f'ADE_PING:{time.time_ns()//1000};\n')
     time.sleep(.2);current=processes();rss={}
     for pid,p in current.items():
      group=category(pid,current)
      if not group:continue
      rss[group]=rss.get(group,0)+p['rss'];prior=previous.get(pid,first.get(pid,{'cpu':0}))['cpu'];cpu[group]=cpu.get(group,0)+max(0,p['cpu']-prior)
     for group,value in rss.items():peak[group]=max(peak.get(group,0),value)
     previous=current;assert client.poll()is None and daemon.poll()is None,'runtime exited'
    elapsed=time.monotonic()-start;rtts.sort()
    result={'phase':label,'duration_s':elapsed,'cpu_percent_one_core':{k:round(v/elapsed*100,2)for k,v in cpu.items()},'peak_rss_mib':peak,'control_rtt_ms':{'p95':rtts[int((len(rtts)-1)*.95)],'max':max(rtts)},'client_cumulative':load(cmetrics),'daemon_cumulative':load(dmetrics)}
    print(json.dumps({'windows':count,'history':history,**result}),flush=True)
    if profile_memory:
     # Capture before lifecycle advances to avoid profiling an exited client.
     # This pauses the workload and is diagnostic, not a latency benchmark.
     with (out/f'{label}-{time.time_ns()}-vmmap.txt').open('w') as memory_log:
      subprocess.run(['vmmap','-summary',str(client.pid)],stdout=memory_log,stderr=memory_log,timeout=15)
    return result
   phases=[measure('idle',3)]
   duration=seconds+12+max(0,reconnect_cycles-1)*10
   for i,(w,c) in enumerate(zip(workspaces,conversations)):
    rpc('agent.send',conversation_id=c,request_id=f'stream-{i}',text=f'stream:{duration}:20:96')
    if terminal_output:rpc('input',workspace_id=w['id'],data=f'python3 {shlex.quote(str(TERMINAL))} stream {duration+3}\n')
   terminal_deadline=time.monotonic()+duration+3.5
   phases.append(measure('agents_and_terminals',seconds))
   reconnect_times=[]
   for cycle in range(reconnect_cycles):
    stop(client);time.sleep(2)
    reconnect_start=time.monotonic();client=launch_client();wait_for(lambda:load(cmetrics).get('restore_us',{}).get('count',0)>=count and load(cmetrics).get('provider_to_ui_render_us',{}).get('count',0)>=count,45)
    reconnect_s=time.monotonic()-reconnect_start
    phases.append(measure('reconnected_while_streaming',4))
    reconnect_times.append(reconnect_s)
   wait_for(lambda:all(rpc('conversation.get',conversation_id=c)['conversation']['status']=='ready' for c in conversations),duration+30)
   for c in conversations:
    snapshot=rpc('conversation.get',conversation_id=c,limit=200)
    thread=load(root/'provider'/f"{snapshot['conversation']['provider_thread_id']}.json")
    expected=thread['turns'][-1]['items'][-1]['text'];actual=snapshot['messages'][-1]['text'];assert actual==expected,'durable stream lost or duplicated data'
   # The same live providers reconnect after an application crash; no prompt replay.
   for i,c in enumerate(conversations):rpc('agent.send',conversation_id=c,request_id=f'interrupt-{i}',text='stream:60:20:96')
   time.sleep(.5);before=rpc('runtime.status');stop(daemon);dmetrics.unlink(missing_ok=True);restart=time.monotonic();daemon=launch_daemon()
   wait_for(lambda:rpc('runtime.status')['boot_id']!=before['boot_id'],10)
   after=rpc('runtime.status')
   assert {a['spec']['run']:a['pid'] for a in before['agents']}=={a['spec']['run']:a['pid'] for a in after['agents']}
   wait_for(lambda:all(rpc('conversation.get',conversation_id=c)['conversation']['status']=='running'for c in conversations),10)
   resume_s=time.monotonic()-restart
   for c in conversations:rpc('agent.cancel',conversation_id=c)
   wait_for(lambda:all(rpc('conversation.get',conversation_id=c)['conversation']['status']=='interrupted'for c in conversations),10)
   time.sleep(max(2,terminal_deadline-time.monotonic()));phases.append(measure('recovered_idle',3))
   assert load(cmetrics).get('terminal_errors',{}).get('count',0)<=count*3,'unexpected terminal reconnect failures'
   return {'ui_layout':'dock-chat-terminal-vertical','memory_profiling':profile_memory,'windows_and_agents':count,'history_messages_seeded':history,'rate_per_agent_hz':20,'terminal_rate_per_workspace_kib_s':260 if terminal_output else 0,'cold_client':cold,'client_reconnect_seconds':reconnect_s,'client_reconnect_cycles_seconds':reconnect_times,'daemon_restart_resume_seconds':resume_s,'stream_integrity':'exact match','phases':phases}
  finally:
   stop(client);stop(daemon);cleanup_runtimes();log.close()

def main():
 p=argparse.ArgumentParser();p.add_argument('--windows',type=int,nargs='+',default=[1,4,10]);p.add_argument('--seconds',type=float,default=15);p.add_argument('--history',type=int,default=0);p.add_argument('--reconnect-cycles',type=int,default=1);p.add_argument('--profile-memory',action='store_true');p.add_argument('--no-terminal-output',action='store_true');p.add_argument('--output',type=Path,required=True);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
 result={'method':__doc__,'results':[]}
 for count in a.windows:
  out=a.output/str(count);out.mkdir(exist_ok=True);result['results'].append(run(count,out,a.seconds,a.history,a.reconnect_cycles,not a.no_terminal_output,a.profile_memory));(a.output/'results.json').write_text(json.dumps(result,indent=2))
if __name__=='__main__':main()
