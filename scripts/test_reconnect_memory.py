#!/usr/bin/env python3
"""Bound reconnect allocations using a real PTY and terminal history, no model calls."""
from paths import PROJECT_ROOT, TARGET_DIR
import argparse,base64,json,os,shlex,socket,subprocess,tempfile,threading,time
from pathlib import Path
from benchmark import request,stop
from runtime_test_support import track_runtime,cleanup_runtimes
ROOT=PROJECT_ROOT
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--cycles',type=int,default=4)
args=parser.parse_args()
daemon=None
with tempfile.TemporaryDirectory(prefix='ade-reconnect-memory-',dir='/tmp') as tmp:
 root=Path(tmp);endpoint=str(root/'app.sock');marker=root/'history.done'
 env={**os.environ,'ADE_SOCKET':endpoint,'ADE_DATA_DIR':str(root/'data'),'ADE_ROOT':str(root),'SHELL':'/bin/sh','ENV':'/dev/null'}
 def rpc(op,**kw):return request(endpoint,{'op':op,**kw})
 def wait(fn):
  deadline=time.monotonic()+15
  while time.monotonic()<deadline:
   try:
    value=fn()
    if value:return value
   except (FileNotFoundError,ConnectionRefusedError):pass
   time.sleep(.02)
  raise AssertionError('Readiness timeout')
 def rss(pid):return int(subprocess.check_output(['ps','-p',str(pid),'-o','rss='],text=True))/1024
 try:
  daemon=subprocess.Popen([str(TARGET_DIR / 'release/ade-daemon')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
  hello=wait(lambda:rpc('hello'));track_runtime(hello);pid=hello['runtime_pid']
  rpc('input',data=f'python3 {shlex.quote(str(Path(__file__).with_name("benchmark_fixture.py")))} history {shlex.quote(str(marker))}\n')
  wait(lambda:marker.exists());wait(lambda:rpc('ping')['metrics']['terminal_bytes']>=60000*113)
  baseline=rss(pid);peaks=[];retained=[];snapshot_size=0
  for cycle in range(args.cycles):
   samples=[];done=threading.Event()
   def sample():
    while not done.is_set():samples.append(rss(pid));done.wait(.01)
   monitor=threading.Thread(target=sample);monitor.start()
   try:
    with socket.socket(socket.AF_UNIX) as peer:
     peer.settimeout(15);peer.connect(endpoint);peer.sendall(b'{"op":"subscribe","snapshot_format":"binary","snapshot_encoding":"base64"}\n')
     value=json.loads(peer.makefile('rb').readline())
     assert value['type']=='snapshot',value
     snapshot_size=len(base64.b64decode(value['terminal_snapshot_base64'],validate=True)) if 'terminal_snapshot_base64' in value else len(value['terminal_snapshot_bytes'])
     assert snapshot_size>100000,f'Fixture history too small: {snapshot_size}'
   finally:done.set();monitor.join()
   time.sleep(.1);peaks.append(max(samples+[rss(pid)]));retained.append(rss(pid))
  # A binary snapshot should not require tens of boxed JSON values per byte.
  # Allow allocator/native overhead plus eight times the payload for serialization.
  budget=8+8*snapshot_size/1024**2
  result={'baseline_mib':baseline,'snapshot_bytes':snapshot_size,'peak_mib':peaks,'retained_mib':retained,'allowed_growth_mib':budget}
  print(json.dumps(result),flush=True)
  assert max(peaks)-baseline<=budget,'Reconnect allocation amplification exceeded bounded snapshot budget'
  print('RECONNECT_MEMORY_PASS')
 finally:stop(daemon);cleanup_runtimes()
